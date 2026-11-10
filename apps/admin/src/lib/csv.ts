/**
 * CSV for spreadsheets (RFC 4180, pure; unit-tested). Attendee names come from the public, so a
 * cell must never run as a formula when the file is opened (CSV/formula injection): values that
 * start with = + - @ or a tab/carriage return are prefixed with an apostrophe, which spreadsheet
 * apps show as text. A UTF-8 byte order mark lets Excel read non-ASCII names correctly.
 */
const FORMULA_START = /^[=+\-@\t\r]/;

export function neutralizeFormula(value: string): string {
  return FORMULA_START.test(value) ? `'${value}` : value;
}

function cell(value: string): string {
  const safe = neutralizeFormula(value);
  return /[",\r\n]/.test(safe) || safe !== safe.trim() ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function toCsv(header: string[], rows: string[][]): string {
  return '﻿' + [header, ...rows].map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}
