/**
 * Image library helpers (ADR-0042; pure, unit-tested). The API decides what is a valid image;
 * these only shape what the admin shows and sends.
 */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
/** What the file picker offers. The API checks the bytes themselves. */
export const IMAGE_ACCEPT = 'image/jpeg,image/png,image/webp';
const ACCEPTED_TYPES = new Set(IMAGE_ACCEPT.split(','));

/** The admin's own proxy for library images (previews and the library itself). */
export function adminImageUrl(orgId: string, assetId: string, variant: 'small' | 'large') {
  return `/orgs/${orgId}/images/${assetId}/${variant}`;
}

/** "2.4 MB", "830 KB", "120 bytes". */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} bytes`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** A starting name from the file name: no extension, one line, at most 200 characters. */
export function imageNameFromFile(fileName: string): string {
  const name = fileName
    .trim()
    .replace(/\.[A-Za-z0-9]{1,5}$/, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200)
    .trim();
  return name || 'Image';
}

/** A quick check before uploading, so an obviously wrong file fails without a round trip. */
export function uploadProblem(file: { size: number; type: string }): string | null {
  if (file.size === 0) return 'Choose an image to upload.';
  if (file.size > MAX_IMAGE_BYTES) return 'Images can be up to 8 MB.';
  if (file.type && !ACCEPTED_TYPES.has(file.type)) return 'Upload a JPEG, PNG or WebP image.';
  return null;
}
