import { describe, expect, it } from 'vitest';
import { MAX_SECTIONS, sectionsSchema, starterSections } from './modules/page/sections.ts';

const hero = {
  id: 'hero',
  type: 'hero',
  version: 1,
  visible: true,
  heading: 'Jakarta Summit',
  body: 'Two days.\nOne city.',
  ctaLabel: 'Register',
};

describe('page sections schema (ADR-0020)', () => {
  it('accepts the starter sections', () => {
    expect(sectionsSchema.safeParse(starterSections('Jakarta Summit')).success).toBe(true);
  });

  it('accepts every section type with items', () => {
    const res = sectionsSchema.safeParse([
      hero,
      { id: 'a', type: 'text', version: 1, visible: false, heading: 'About', body: '' },
      {
        id: 'b',
        type: 'agenda',
        version: 1,
        visible: true,
        heading: 'Agenda',
        items: [{ time: '09:30', title: 'Keynote' }],
      },
      {
        id: 'c',
        type: 'speakers',
        version: 1,
        visible: true,
        heading: 'Speakers',
        items: [{ name: 'Ade', role: '' }],
      },
      {
        id: 'd',
        type: 'register',
        version: 1,
        visible: true,
        heading: 'Join',
        body: '',
        ctaLabel: 'Go',
      },
    ]);
    expect(res.success).toBe(true);
  });

  it('rejects unknown types, versions and fields (no arbitrary content)', () => {
    for (const bad of [
      { ...hero, type: 'html', html: '<script>alert(1)</script>' },
      { ...hero, version: 2 },
      { ...hero, script: 'x' },
      { ...hero, id: 'Not Valid' },
    ]) {
      expect(sectionsSchema.safeParse([bad]).success).toBe(false);
    }
  });

  it('keeps text plain: control characters and over-long text are rejected', () => {
    expect(sectionsSchema.safeParse([{ ...hero, heading: 'a\u0000b' }]).success).toBe(false);
    expect(sectionsSchema.safeParse([{ ...hero, heading: 'line\nbreak' }]).success).toBe(false);
    expect(sectionsSchema.safeParse([{ ...hero, heading: 'x'.repeat(121) }]).success).toBe(false);
    expect(sectionsSchema.safeParse([{ ...hero, heading: '   ' }]).success).toBe(false);
    // Markup is allowed as text: it is stored and rendered literally, never interpreted.
    const parsed = sectionsSchema.parse([{ ...hero, heading: '<b>Bold</b>' }]);
    expect(parsed[0]!.heading).toBe('<b>Bold</b>');
  });

  it('validates agenda times and limits list sizes', () => {
    const agenda = (time: string) => ({
      id: 'g',
      type: 'agenda',
      version: 1,
      visible: true,
      heading: 'Agenda',
      items: [{ time, title: 'Talk' }],
    });
    expect(sectionsSchema.safeParse([agenda('24:00')]).success).toBe(false);
    expect(sectionsSchema.safeParse([agenda('9:30')]).success).toBe(false);
    expect(sectionsSchema.safeParse([agenda('23:59')]).success).toBe(true);
    const many = Array.from({ length: MAX_SECTIONS + 1 }, (_, i) => ({ ...hero, id: `s${i}` }));
    expect(sectionsSchema.safeParse(many).success).toBe(false);
  });

  it('requires unique section IDs', () => {
    const res = sectionsSchema.safeParse([hero, { ...hero }]);
    expect(res.success).toBe(false);
    expect(res.error?.issues[0]?.path).toEqual([1, 'id']);
  });
});
