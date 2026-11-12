/**
 * The audit log as CSV (ADR-0047; pure, unit-tested). Same plain-language summaries as the page,
 * plus the raw action and data for anyone filtering in a spreadsheet. Every cell goes through
 * the shared CSV writer, which neutralizes formulas (the log holds names people typed).
 */
import type { components } from './api-types';
import { actorLabel, describeAuditEvent, type AuditNames } from './audit';
import { toCsv } from './csv';
import { isoToZonedLocal } from './time';

type AuditExport = components['schemas']['AuditExport'];

export function auditCsv(e: AuditExport, names: AuditNames): string {
  const tz = e.timezone;
  return toCsv(
    [
      `When (${tz})`,
      'Who',
      'What',
      'Details',
      'Action',
      'Object type',
      'Object ID',
      'Data',
      'Reference',
    ],
    e.data.map((r) => {
      const { summary, details } = describeAuditEvent(r, names);
      return [
        isoToZonedLocal(r.occurredAt, tz).replace('T', ' '),
        actorLabel(r.actor),
        summary,
        details.join(' / '),
        r.action,
        r.targetType,
        r.targetId ?? '',
        Object.keys(r.metadata).length > 0 ? JSON.stringify(r.metadata) : '',
        r.correlationId,
      ];
    }),
  );
}

/** e.g. audit-log-2027-03-01.csv, the day in the organization's time zone. */
export function auditFilename(e: Pick<AuditExport, 'generatedAt' | 'timezone'>): string {
  return `audit-log-${isoToZonedLocal(e.generatedAt, e.timezone).slice(0, 10)}.csv`;
}
