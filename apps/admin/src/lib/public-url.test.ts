import { describe, expect, it } from 'vitest';
import { publicSiteExample, publicSiteUrl } from './public-url';

describe('public site URLs', () => {
  it('builds the address from the configured template', () => {
    expect(publicSiteUrl('https://{handle}.eventhub.example', 'awh', 'summit')).toBe(
      'https://awh.eventhub.example/summit',
    );
    expect(publicSiteUrl('http://{handle}.localhost:3002', 'awh')).toBe(
      'http://awh.localhost:3002',
    );
  });

  it('gives no link without a template or a handle', () => {
    expect(publicSiteUrl(null, 'awh', 'summit')).toBeNull();
    expect(publicSiteUrl('https://{handle}.eventhub.example', null, 'summit')).toBeNull();
  });

  it('shows the shape of the address in hints', () => {
    expect(publicSiteExample(null, null)).toBe(
      'https://your-handle.your-platform-domain/event-slug',
    );
    expect(publicSiteExample('https://{handle}.eventhub.example', 'awh')).toBe(
      'https://awh.eventhub.example/event-slug',
    );
  });
});
