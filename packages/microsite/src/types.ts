/**
 * Section shapes as published by the API (PageSection). The admin passes its generated API types
 * into these components, so a mismatch fails its typecheck. Published revisions are immutable,
 * so older section versions stay here and keep rendering (ADR-0020, ADR-0040).
 */
interface Base {
  id: string;
  visible: boolean;
  heading: string;
}

export interface AgendaItemV2 {
  id: string;
  /** YYYY-MM-DD, or empty for a one-day event. */
  day: string;
  start: string;
  /** Empty when open-ended. */
  end: string;
  title: string;
  room: string;
  description: string;
  speakerIds: string[];
}

export interface SpeakerV2 {
  id: string;
  name: string;
  role: string;
  bio: string;
}

export type Section =
  | (Base & { version: 1; type: 'hero'; body: string; ctaLabel: string })
  | (Base & { version: 1; type: 'text'; body: string })
  | (Base & { version: 1; type: 'agenda'; items: Array<{ time: string; title: string }> })
  | (Base & { version: 2; type: 'agenda'; items: AgendaItemV2[] })
  | (Base & { version: 1; type: 'speakers'; items: Array<{ name: string; role: string }> })
  | (Base & { version: 2; type: 'speakers'; items: SpeakerV2[] })
  | (Base & { version: 1; type: 'register'; body: string; ctaLabel: string });
