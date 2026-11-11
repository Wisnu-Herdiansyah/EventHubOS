import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import {
  ImageRejected,
  MAX_UPLOAD_BYTES,
  processImage,
  sniffFormat,
} from './modules/asset/image.ts';

const solid = (width: number, height: number) =>
  sharp({ create: { width, height, channels: 3, background: '#1f3a5f' } });

async function rejection(bytes: Buffer): Promise<ImageRejected['reason']> {
  try {
    await processImage(bytes);
  } catch (error) {
    if (error instanceof ImageRejected) return error.reason;
    throw error;
  }
  throw new Error('expected a rejection');
}

describe('sniffFormat', () => {
  it('recognises JPEG, PNG and WebP by their bytes only', async () => {
    expect(sniffFormat(await solid(4, 4).jpeg().toBuffer())).toBe('jpeg');
    expect(sniffFormat(await solid(4, 4).png().toBuffer())).toBe('png');
    expect(sniffFormat(await solid(4, 4).webp().toBuffer())).toBe('webp');
    expect(sniffFormat(await solid(4, 4).gif().toBuffer())).toBeNull();
    expect(sniffFormat(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
    expect(sniffFormat(Buffer.alloc(0))).toBeNull();
  });
});

describe('processImage', () => {
  it('re-encodes as WebP in two sizes, never enlarging', async () => {
    const out = await processImage(await solid(3000, 1500).jpeg().toBuffer());
    expect(sniffFormat(out.large.data)).toBe('webp');
    expect([out.large.width, out.large.height]).toEqual([2400, 1200]);
    expect([out.small.width, out.small.height]).toEqual([480, 240]);
    expect(out.sha256).toHaveLength(32);

    const tiny = await processImage(await solid(100, 50).png().toBuffer());
    expect([tiny.large.width, tiny.small.width]).toEqual([100, 100]);
  });

  it('strips metadata such as GPS location, and applies the camera orientation', async () => {
    const photo = await solid(40, 20)
      .jpeg()
      .withMetadata({
        orientation: 6,
        exif: { IFD0: { Copyright: 'secret-owner' }, IFD3: { GPSLatitudeRef: 'S' } },
      })
      .toBuffer();
    expect((await sharp(photo).metadata()).exif).toBeDefined();
    const out = await processImage(photo);
    const meta = await sharp(out.large.data).metadata();
    expect(meta.exif).toBeUndefined();
    expect(meta.xmp).toBeUndefined();
    expect(out.large.data.includes(Buffer.from('secret-owner'))).toBe(false);
    // Orientation 6 means "rotate 90°": the stored image is upright and has no orientation tag.
    expect([out.large.width, out.large.height]).toEqual([20, 40]);
    expect(meta.orientation).toBeUndefined();
  });

  it('refuses SVG, GIF and anything that is not an image', async () => {
    expect(await rejection(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBe(
      'unsupported_type',
    );
    expect(await rejection(await solid(4, 4).gif().toBuffer())).toBe('unsupported_type');
    expect(await rejection(Buffer.from('%PDF-1.7'))).toBe('unsupported_type');
  });

  it('refuses truncated data and a signature that lies about the content', async () => {
    const png = await solid(64, 64).png().toBuffer();
    expect(await rejection(png.subarray(0, 40))).toBe('unreadable');
    // A JPEG signature in front of PNG data.
    expect(await rejection(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), png]))).toBe(
      'unreadable',
    );
  });

  it('refuses decompression bombs: a small file with too many pixels', async () => {
    const bomb = await solid(8000, 8000).png({ compressionLevel: 9 }).toBuffer();
    expect(bomb.length).toBeLessThan(MAX_UPLOAD_BYTES);
    expect(await rejection(bomb)).toBe('too_many_pixels');
  });

  it('refuses files over 8 MB before decoding', async () => {
    const big = Buffer.concat([await solid(4, 4).png().toBuffer(), Buffer.alloc(MAX_UPLOAD_BYTES)]);
    expect(await rejection(big)).toBe('too_large');
  });

  it('keeps only the first frame of an animated WebP', async () => {
    const frame = (background: string) =>
      sharp({ create: { width: 8, height: 8, channels: 3, background } })
        .png()
        .toBuffer();
    const animated = await sharp([await frame('#d4af37'), await frame('#1f3a5f')], {
      join: { animated: true },
    })
      .webp({ loop: 0, delay: [100, 100] })
      .toBuffer();
    expect((await sharp(animated).metadata()).pages).toBe(2);
    const out = await processImage(animated);
    const meta = await sharp(out.large.data).metadata();
    expect(meta.pages ?? 1).toBe(1);
    expect([meta.width, meta.height]).toEqual([8, 8]);
  });
});
