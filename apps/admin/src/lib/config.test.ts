import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
const { galleryEnabled } = await import('./config');

describe('design gallery switch', () => {
  it('is on in development and off in production by default', () => {
    expect(galleryEnabled(undefined, 'development')).toBe(true);
    expect(galleryEnabled(undefined, undefined)).toBe(true);
    expect(galleryEnabled(undefined, 'production')).toBe(false);
  });

  it('follows an explicit setting either way', () => {
    expect(galleryEnabled('1', 'production')).toBe(true);
    expect(galleryEnabled('0', 'development')).toBe(false);
  });
});
