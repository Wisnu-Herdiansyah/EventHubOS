/** Shared option lists for forms (server-safe, no secrets). */

export function timeZones(): string[] {
  const zones = Intl.supportedValuesOf('timeZone');
  return zones.includes('UTC') ? zones : ['UTC', ...zones];
}

export const LOCALES = [
  'en',
  'en-US',
  'en-GB',
  'id-ID',
  'ms-MY',
  'en-SG',
  'zh-CN',
  'ja-JP',
  'ko-KR',
  'th-TH',
  'vi-VN',
  'fr-FR',
  'de-DE',
  'es-ES',
  'pt-BR',
  'ar',
];

export const VENUE_MODES = [
  { value: 'in_person', label: 'In person' },
  { value: 'virtual', label: 'Virtual' },
  { value: 'hybrid', label: 'Hybrid' },
];

export const VISIBILITY = [
  { value: 'public', label: 'Public: listed and shareable' },
  { value: 'unlisted', label: 'Unlisted: only people with the link' },
  { value: 'private', label: 'Private: not shared publicly' },
];

export const LIFECYCLE_LABELS: Record<string, string> = {
  draft: 'Draft',
  scheduled: 'Scheduled',
  published: 'Published',
  live: 'Live',
  ended: 'Ended',
  archived: 'Archived',
};

export const ROLE_LABELS: Record<string, string> = {
  owner: 'Owner',
  admin: 'Admin',
  billing_admin: 'Billing admin',
  event_manager: 'Event manager',
  content_editor: 'Content editor',
  registration_manager: 'Registration manager',
  analyst: 'Analyst',
  viewer: 'Viewer',
};
