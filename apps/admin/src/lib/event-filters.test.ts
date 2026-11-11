import { describe, expect, it } from 'vitest';
import { eventsHref, isFiltered, parseEventFilters } from './event-filters';

describe('event list filters', () => {
  it('reads valid filters', () => {
    expect(
      parseEventFilters({
        q: '  Jakarta  ',
        status: 'published',
        when: 'upcoming',
        cursor: 'abc_-1',
      }),
    ).toEqual({
      filters: { q: 'Jakarta', lifecycle: 'published', when: 'upcoming', cursor: 'abc_-1' },
      ignored: false,
    });
    expect(parseEventFilters({})).toEqual({ filters: {}, ignored: false });
    expect(parseEventFilters({ q: '   ' })).toEqual({ filters: {}, ignored: false });
    expect(parseEventFilters({ q: ['first', 'second'] }).filters.q).toBe('first');
  });

  it('drops what the API would refuse, and says so', () => {
    for (const search of [
      { status: 'deleted' },
      { when: 'soon' },
      { q: 'x'.repeat(101) },
      { q: 'tab\there' },
      { cursor: 'not a cursor!' },
    ]) {
      const r = parseEventFilters(search);
      expect(r.ignored, JSON.stringify(search)).toBe(true);
      expect(r.filters, JSON.stringify(search)).toEqual({});
    }
  });

  it('builds links that keep the filters', () => {
    const org = '00000000-0000-4000-8000-000000000001';
    expect(eventsHref(org, {})).toBe(`/orgs/${org}#events-heading`);
    expect(eventsHref(org, { q: '100% fun', lifecycle: 'draft', when: 'past' }, 'c1')).toBe(
      `/orgs/${org}?q=100%25+fun&status=draft&when=past&cursor=c1#events-heading`,
    );
    expect(isFiltered({ cursor: 'c1' })).toBe(false);
    expect(isFiltered({ when: 'past' })).toBe(true);
  });
});
