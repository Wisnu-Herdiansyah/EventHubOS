import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const dir = import.meta.dirname;
const TEXT = 4.5;

/** WCAG 2.x contrast ratio for #rrggbb colours. */
function contrastRatio(a: string, b: string): number {
  const lum = (hex: string) => {
    const [r, g, b2] = [1, 3, 5].map((i) => {
      const c = parseInt(hex.slice(i, i + 2), 16) / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * b2!;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

describe('microsite brand presets', () => {
  const css = readFileSync(join(dir, 'site-tokens.css'), 'utf8');
  const blocks = [...css.matchAll(/(\.site(?:\[data-brand='([a-z-]+)'\])?)\s*\{([^}]*)\}/g)];
  const base = new Map<string, string>();
  const presets = blocks.map((b) => {
    const vars = new Map<string, string>();
    for (const m of b[3]!.matchAll(/(--site-[a-z-]+):\s*(#[0-9a-f]{6});/gi)) vars.set(m[1]!, m[2]!);
    if (!b[2]) for (const [k, v] of vars) base.set(k, v);
    return { name: b[2] ?? 'default', vars };
  });
  const get = (p: { vars: Map<string, string> }, k: string) => p.vars.get(k) ?? base.get(k)!;
  const SITE_PAIRS: Array<[string, string]> = [
    ['--site-text', '--site-bg'],
    ['--site-text-secondary', '--site-bg'],
    ['--site-text', '--site-surface'],
    ['--site-text-secondary', '--site-surface'],
    ['--site-on-brand', '--site-brand'],
    ['--site-brand', '--site-bg'],
    ['--site-brand', '--site-brand-soft'],
    ['--site-text', '--site-brand-soft'],
    ['--site-on-hero', '--site-hero-from'],
    ['--site-on-hero', '--site-hero-to'],
    ['--site-hero-from', '--site-on-hero'],
  ];

  it('defines several presets', () => {
    expect(presets.map((p) => p.name)).toEqual(['default', 'navy-gold', 'forest', 'ember']);
  });

  it.each(presets.flatMap((p) => SITE_PAIRS.map(([fg, bg]) => [p.name, fg, bg, p] as const)))(
    '%s: %s on %s meets 4.5:1',
    (_name, fg, bg, preset) => {
      expect(contrastRatio(get(preset, fg), get(preset, bg))).toBeGreaterThanOrEqual(TEXT);
    },
  );
});

describe('microsite styles', () => {
  it('read only --site-* tokens (no literal colours, no admin tokens)', () => {
    const css = readFileSync(join(dir, 'microsite.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(css.match(/#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(/gi) ?? []).toEqual([]);
    expect(css.match(/var\(--(?!site-)[a-z-]+\)/g) ?? []).toEqual([]);
  });
});

describe('themes (ADR-0046)', () => {
  it('has a CSS preset for every theme organizers can choose, and no others', async () => {
    const { EVENT_THEMES } = await import('@eventhub/kernel');
    const css = readFileSync(join(dir, 'site-tokens.css'), 'utf8');
    const presets = [...css.matchAll(/\.site\[data-brand='([a-z-]+)'\]/g)].map((m) => m[1]);
    expect(['default', ...presets].sort()).toEqual([...EVENT_THEMES].sort());
  });
});

describe('admin theme swatches (ADR-0046)', () => {
  it('show the same brand and soft colours as the presets', () => {
    const site = readFileSync(join(dir, 'site-tokens.css'), 'utf8');
    const admin = readFileSync(join(dir, '../../../apps/admin/src/styles/tokens.css'), 'utf8');
    const colours = (block: string) => [
      block.match(/--site-brand:\s*(#[0-9a-f]{6})/i)?.[1],
      block.match(/--site-brand-soft:\s*(#[0-9a-f]{6})/i)?.[1],
    ];
    const presets: Record<string, Array<string | undefined>> = {
      default: colours(site.match(/\.site\s*\{([^}]*)\}/)![1]!),
    };
    for (const m of site.matchAll(/\.site\[data-brand='([a-z-]+)'\]\s*\{([^}]*)\}/g)) {
      presets[m[1]!] = colours(m[2]!);
    }
    for (const [name, [brand, soft]] of Object.entries(presets)) {
      const token = (part: string) =>
        admin
          .match(new RegExp(`--swatch-${name}-${part}:\\s*(#[0-9a-f]{6})`, 'i'))?.[1]
          ?.toLowerCase();
      expect(token('brand'), name).toBe(brand!.toLowerCase());
      expect(token('soft'), name).toBe(soft!.toLowerCase());
    }
  });
});
