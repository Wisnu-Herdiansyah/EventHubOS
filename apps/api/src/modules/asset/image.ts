import { createHash } from 'node:crypto';
import sharp from 'sharp';

/**
 * Upload processing (ADR-0042; unit-tested). Nothing an organizer uploads is stored or served as
 * it arrived:
 *
 * - The format is recognised from the bytes themselves (JPEG, PNG or WebP), never from a file
 *   name or a client-declared type. SVG (which can carry script), GIF, HEIC, TIFF and anything
 *   else is refused before a decoder sees it.
 * - The decoder must agree with that format, refuses truncated or corrupt data, and refuses
 *   images over 50 megapixels (a small file can decompress to gigabytes).
 * - The image is re-encoded as WebP: camera orientation is applied, and all metadata (EXIF,
 *   including GPS location, XMP, comments) is left behind. Animated images keep their first
 *   frame. Two renditions are stored: large (fits 2400 px) and small (fits 480 px).
 */
export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
export const MAX_INPUT_PIXELS = 50_000_000;
const LARGE_PX = 2400;
const SMALL_PX = 480;
const WEBP_QUALITY = 82;

// libvips keeps decoded images in a cache by default; uploads are one-off, so keep memory flat.
sharp.cache(false);

export type UploadFormat = 'jpeg' | 'png' | 'webp';

export class ImageRejected extends Error {
  readonly reason: 'unsupported_type' | 'too_large' | 'too_many_pixels' | 'unreadable';
  constructor(reason: ImageRejected['reason'], message: string) {
    super(message);
    this.name = 'ImageRejected';
    this.reason = reason;
  }
}

/** The format the bytes say they are, from their signature; null for anything else. */
export function sniffFormat(bytes: Buffer): UploadFormat | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'jpeg';
  }
  if (
    bytes.length >= 8 &&
    bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return 'png';
  }
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString('latin1') === 'RIFF' &&
    bytes.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return 'webp';
  }
  return null;
}

export interface Rendition {
  data: Buffer;
  width: number;
  height: number;
}

export interface ProcessedImage {
  large: Rendition;
  small: Rendition;
  /** SHA-256 of the large rendition. */
  sha256: Buffer;
}

async function render(input: Buffer, px: number): Promise<Rendition> {
  const { data, info } = await sharp(input, {
    failOn: 'error',
    limitInputPixels: MAX_INPUT_PIXELS,
    pages: 1,
    animated: false,
  })
    .rotate()
    .resize({ width: px, height: px, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: WEBP_QUALITY })
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

export async function processImage(bytes: Buffer): Promise<ProcessedImage> {
  if (bytes.length > MAX_UPLOAD_BYTES) {
    throw new ImageRejected('too_large', 'Images can be up to 8 MB.');
  }
  const format = sniffFormat(bytes);
  if (!format) {
    throw new ImageRejected('unsupported_type', 'Upload a JPEG, PNG or WebP image.');
  }
  let declared: string | undefined;
  try {
    // limitInputPixels makes the decoder refuse oversized images from their header alone.
    const meta = await sharp(bytes, {
      failOn: 'error',
      limitInputPixels: MAX_INPUT_PIXELS,
      pages: 1,
    }).metadata();
    declared = meta.format;
  } catch (error) {
    throw pixelLimit(error) ?? unreadable();
  }
  // Defence in depth: the decoder must read the same format the signature claims. (libvips also
  // detects formats by signature, so today the two always agree.)
  if (declared !== format) throw unreadable();
  try {
    const large = await render(bytes, LARGE_PX);
    const small = await render(bytes, SMALL_PX);
    return { large, small, sha256: createHash('sha256').update(large.data).digest() };
  } catch (error) {
    throw pixelLimit(error) ?? unreadable();
  }
}

function tooManyPixels(): ImageRejected {
  return new ImageRejected(
    'too_many_pixels',
    'This image has too many pixels (50 megapixels at most).',
  );
}

function pixelLimit(error: unknown): ImageRejected | null {
  return error instanceof Error && /pixel limit/i.test(error.message) ? tooManyPixels() : null;
}

function unreadable(): ImageRejected {
  return new ImageRejected('unreadable', 'This image could not be read. Try exporting it again.');
}
