/**
 * Section shapes as published by the API (PageSection, schema version 1). The admin passes its
 * generated API types into these components, so a mismatch fails its typecheck.
 */
interface Base {
  id: string;
  version: 1;
  visible: boolean;
  heading: string;
}

export type Section =
  | (Base & { type: 'hero'; body: string; ctaLabel: string })
  | (Base & { type: 'text'; body: string })
  | (Base & { type: 'agenda'; items: Array<{ time: string; title: string }> })
  | (Base & { type: 'speakers'; items: Array<{ name: string; role: string }> })
  | (Base & { type: 'register'; body: string; ctaLabel: string });
