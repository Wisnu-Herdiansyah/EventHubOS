/**
 * Program helpers (ADR-0040; pure, unit-tested): agenda grouping and the v1 → v2 upgrade the
 * editor applies to drafts. Times are wall-clock times in the event's time zone, so nothing here
 * converts time zones.
 */
import type { AgendaItemV2, Section, SpeakerV2 } from './types.ts';

type AgendaV1 = Extract<Section, { type: 'agenda'; version: 1 }>;
type AgendaV2 = Extract<Section, { type: 'agenda'; version: 2 }>;
type SpeakersV1 = Extract<Section, { type: 'speakers'; version: 1 }>;
type SpeakersV2 = Extract<Section, { type: 'speakers'; version: 2 }>;

/** Sessions by day (days in order, an undated day first), each day sorted by start time. */
export function agendaDays(items: AgendaItemV2[]): Array<{ day: string; items: AgendaItemV2[] }> {
  const byDay = new Map<string, AgendaItemV2[]>();
  for (const item of items) {
    const list = byDay.get(item.day) ?? [];
    list.push(item);
    byDay.set(item.day, list);
  }
  return [...byDay.entries()]
    .sort(([a], [b]) => (a === b ? 0 : a < b ? -1 : 1))
    .map(([day, list]) => ({
      day,
      // A stable sort keeps the organizer's order for sessions at the same time.
      items: [...list].sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0)),
    }));
}

/** "Mon 1 Mar 2027" for a YYYY-MM-DD day, in English, whatever the server's zone. */
export function dayLabel(day: string): string {
  const d = new Date(`${day}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return day;
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(d);
}

/** "09:30–10:15", or "09:30" when open-ended. */
export function timeRange(item: Pick<AgendaItemV2, 'start' | 'end'>): string {
  return item.end ? `${item.start}–${item.end}` : item.start;
}

/** Item IDs for upgraded content: stable, unique, and valid for the schema. */
function ids(prefix: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => `${prefix}-${i + 1}`);
}

export function upgradeAgenda(s: AgendaV1): AgendaV2 {
  const itemIds = ids('session', s.items.length);
  return {
    id: s.id,
    type: 'agenda',
    version: 2,
    visible: s.visible,
    heading: s.heading,
    items: s.items.map((item, i) => ({
      id: itemIds[i]!,
      day: '',
      start: item.time,
      end: '',
      title: item.title,
      room: '',
      description: '',
      speakerIds: [],
    })),
  };
}

export function upgradeSpeakers(s: SpeakersV1): SpeakersV2 {
  const itemIds = ids('speaker', s.items.length);
  return {
    id: s.id,
    type: 'speakers',
    version: 2,
    visible: s.visible,
    heading: s.heading,
    items: s.items.map((p, i): SpeakerV2 => ({
      id: itemIds[i]!,
      name: p.name,
      role: p.role,
      bio: '',
    })),
  };
}

/** Brings a draft's sections to the newest versions; other sections are returned as they are. */
export function upgradeSections(sections: Section[]): Section[] {
  return sections.map((s) => {
    if (s.type === 'agenda' && s.version === 1) return upgradeAgenda(s);
    if (s.type === 'speakers' && s.version === 1) return upgradeSpeakers(s);
    return s;
  });
}

/**
 * Speakers by ID across the page's v2 speakers sections, for agenda sessions. `linked` is true
 * when their section is shown, so the session can link to the bio; a hidden section still
 * supplies the name.
 */
export function speakerIndex(sections: Section[]): Map<string, SpeakerV2 & { linked: boolean }> {
  const index = new Map<string, SpeakerV2 & { linked: boolean }>();
  for (const s of sections) {
    if (s.type === 'speakers' && s.version === 2) {
      for (const p of s.items) index.set(p.id, { ...p, linked: s.visible });
    }
  }
  return index;
}
