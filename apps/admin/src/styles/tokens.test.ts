import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { contrastRatio } from '../lib/contrast.ts';

const dir = import.meta.dirname;
const tokensCss = readFileSync(join(dir, 'tokens.css'), 'utf8');

/** Reads `--name: light-dark(#light, #dark)` declarations, resolving `var(--other)` aliases. */
function palette(scheme: 'light' | 'dark'): Map<string, string> {
  const raw = new Map<string, string>();
  for (const m of tokensCss.matchAll(/(--color-[a-z0-9-]+):\s*([^;]+);/g)) raw.set(m[1]!, m[2]!);
  const resolve = (value: string, depth = 0): string | undefined => {
    const pair = /^light-dark\((#[0-9a-f]{6}),\s*(#[0-9a-f]{6})\)$/i.exec(value);
    if (pair) return scheme === 'light' ? pair[1] : pair[2];
    const alias = /^var\((--color-[a-z0-9-]+)\)$/.exec(value);
    if (alias && depth < 5) {
      const next = raw.get(alias[1]!);
      return next ? resolve(next, depth + 1) : undefined;
    }
    return undefined; // rgb() overlays and the like are not checked here
  };
  const out = new Map<string, string>();
  for (const [name, value] of raw) {
    const hex = resolve(value);
    if (hex) out.set(name, hex);
  }
  return out;
}

const TEXT = 4.5; // WCAG 1.4.3, normal text
const NON_TEXT = 3; // WCAG 1.4.11, UI components and graphics

/** Every pairing the components actually use: [foreground, background, minimum]. */
const PAIRS: Array<[string, string, number]> = [
  ...['--color-bg', '--color-surface', '--color-surface-raised', '--color-surface-muted'].flatMap(
    (bg): Array<[string, string, number]> => [
      ['--color-text', bg, TEXT],
      ['--color-text-secondary', bg, TEXT],
      ['--color-accent-text', bg, TEXT],
      ['--color-border-control', bg, NON_TEXT],
      ['--color-focus', bg, NON_TEXT],
    ],
  ),
  ['--color-danger-text', '--color-surface', TEXT],
  ['--color-danger-text', '--color-surface-raised', TEXT],
  ['--color-on-accent', '--color-accent-fill', TEXT],
  ['--color-on-accent', '--color-accent-fill-hover', TEXT],
  ['--color-on-accent', '--color-danger-fill', TEXT],
  ['--color-on-accent', '--color-danger-fill-hover', TEXT],
  ['--color-accent-text', '--color-accent-bg', TEXT],
  ['--color-text', '--color-accent-bg', TEXT],
  ['--color-success-text', '--color-success-bg', TEXT],
  ['--color-warning-text', '--color-warning-bg', TEXT],
  ['--color-danger-text', '--color-danger-bg', TEXT],
  ['--color-danger-text', '--color-surface-muted', TEXT],
  ['--color-text-secondary', '--color-neutral-bg', TEXT],
  ['--color-text', '--color-success-bg', TEXT],
  ['--color-text', '--color-warning-bg', TEXT],
  ['--color-text', '--color-danger-bg', TEXT],
  ['--color-surface', '--color-text', TEXT], // tooltips
  ['--color-success-text', '--color-surface', TEXT],
  ...[1, 2, 3, 4].map((n): [string, string, number] => [
    `--color-chart-${n}`,
    '--color-surface',
    NON_TEXT,
  ]),
];

describe.each(['light', 'dark'] as const)('%s palette', (scheme) => {
  const colors = palette(scheme);
  it.each(PAIRS)('%s on %s meets %s:1', (fg, bg, min) => {
    const a = colors.get(fg);
    const b = colors.get(bg);
    expect(a, fg).toBeDefined();
    expect(b, bg).toBeDefined();
    expect(contrastRatio(a!, b!)).toBeGreaterThanOrEqual(min);
  });
});

describe('token discipline', () => {
  const files = readdirSync(dir).filter((f) => f.endsWith('.css') && !f.endsWith('tokens.css'));
  it.each(files)('%s uses tokens, not literal colours', (file) => {
    const css = readFileSync(join(dir, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(css.match(/#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(/gi) ?? []).toEqual([]);
  });

  it('defines the base palette from the specification', () => {
    const light = palette('light');
    expect(light.get('--color-bg')).toBe('#f5f5f7');
    expect(light.get('--color-surface')).toBe('#ffffff');
    expect(light.get('--color-text')).toBe('#1d1d1f');
    expect(light.get('--color-text-secondary')).toBe('#6e6e73');
    expect(light.get('--color-accent')).toBe('#007aff');
    expect(light.get('--color-success')).toBe('#34c759');
    expect(light.get('--color-warning')).toBe('#ff9f0a');
    expect(light.get('--color-danger')).toBe('#ff3b30');
    expect(light.get('--color-divider')).toBe('#e5e5ea');
  });
});

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
