import { describe, expect, it } from 'vitest';
import {
  adminImageUrl,
  formatBytes,
  imageNameFromFile,
  MAX_IMAGE_BYTES,
  uploadProblem,
} from './images';

describe('image library helpers (ADR-0042)', () => {
  it('builds the admin proxy URL', () => {
    expect(adminImageUrl('o', 'a', 'small')).toBe('/orgs/o/images/a/small');
  });

  it('formats sizes', () => {
    expect(formatBytes(120)).toBe('120 bytes');
    expect(formatBytes(850_000)).toBe('830 KB');
    expect(formatBytes(2_500_000)).toBe('2.4 MB');
  });

  it('names an image after its file', () => {
    expect(imageNameFromFile('Ade on stage.JPG')).toBe('Ade on stage');
    expect(imageNameFromFile('  multi\u0007line\nname.webp ')).toBe('multi line name');
    expect(imageNameFromFile('.png')).toBe('Image');
    expect(imageNameFromFile(`${'x'.repeat(300)}.png`)).toHaveLength(200);
  });

  it('catches empty, oversized and non-image files before upload', () => {
    expect(uploadProblem({ size: 0, type: '' })).toBe('Choose an image to upload.');
    expect(uploadProblem({ size: MAX_IMAGE_BYTES + 1, type: 'image/png' })).toMatch(/8 MB/);
    expect(uploadProblem({ size: 10, type: 'image/svg+xml' })).toMatch(/JPEG, PNG or WebP/);
    expect(uploadProblem({ size: 10, type: 'image/jpeg' })).toBeNull();
    // Unknown types (some browsers send none) are left to the API.
    expect(uploadProblem({ size: 10, type: '' })).toBeNull();
  });
});
