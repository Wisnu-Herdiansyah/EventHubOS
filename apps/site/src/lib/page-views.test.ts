import { describe, expect, it } from 'vitest';
import { countsAsView, isLikelyBot } from './page-views';

const CHROME =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const SAFARI_IOS =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const headers = (h: Record<string, string>) => new Headers(h);

describe('page view counting (ADR-0044)', () => {
  it('counts a person loading the page', () => {
    expect(countsAsView(headers({ 'user-agent': CHROME, 'sec-fetch-dest': 'document' }))).toBe(
      true,
    );
    // Older browsers send no Sec-Fetch-Dest.
    expect(countsAsView(headers({ 'user-agent': SAFARI_IOS }))).toBe(true);
  });

  it('skips prefetches, prerenders, form submissions and in-page refreshes', () => {
    const cases: Array<Record<string, string>> = [
      { purpose: 'prefetch' },
      { 'sec-purpose': 'prefetch;prerender' },
      { 'next-router-prefetch': '1' },
      { 'next-action': 'abc123' },
      { rsc: '1' },
      { 'sec-fetch-dest': 'empty' },
      { 'sec-fetch-dest': 'image' },
    ];
    for (const extra of cases) {
      expect(countsAsView(headers({ 'user-agent': CHROME, ...extra })), JSON.stringify(extra)).toBe(
        false,
      );
    }
  });

  it('skips crawlers, link previews, headless browsers and scripts', () => {
    for (const ua of [
      'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
      'facebookexternalhit/1.1',
      'WhatsApp/2.23.20.0',
      'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)',
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/140.0.0.0 Safari/537.36',
      'curl/8.5.0',
      'python-requests/2.32.0',
      'Chrome-Lighthouse',
    ]) {
      expect(isLikelyBot(ua), ua).toBe(true);
    }
    // And they are not counted, even when they ask for a document.
    expect(
      countsAsView(
        headers({ 'user-agent': 'facebookexternalhit/1.1', 'sec-fetch-dest': 'document' }),
      ),
    ).toBe(false);
    expect(countsAsView(headers({}))).toBe(false);
    expect(isLikelyBot(null)).toBe(true);
    expect(isLikelyBot('x')).toBe(true);
    expect(isLikelyBot(CHROME)).toBe(false);
    expect(isLikelyBot(SAFARI_IOS)).toBe(false);
  });
});
