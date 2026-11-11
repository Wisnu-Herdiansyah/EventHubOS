/**
 * Event report shaping (ADR-0030; pure, unit-tested). Dates arrive as calendar days and local
 * hours in the event's time zone, so nothing here converts time zones.
 */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const dayLabel = (iso: string) => {
  const [, m, d] = iso.split('-').map(Number);
  return `${d} ${MONTHS[(m ?? 1) - 1]}`;
};

/** Daily rows up to a month; weekly sums beyond, so the list stays short enough to read. */
function dailyRows(
  days: Array<{ date: string; value: number }>,
): Array<{ label: string; value: number }> {
  if (days.length <= 31) return days.map((d) => ({ label: dayLabel(d.date), value: d.value }));
  const rows: Array<{ label: string; value: number }> = [];
  for (let i = 0; i < days.length; i += 7) {
    const week = days.slice(i, i + 7);
    rows.push({
      label: `${dayLabel(week[0]!.date)} – ${dayLabel(week.at(-1)!.date)}`,
      value: week.reduce((n, d) => n + d.value, 0),
    });
  }
  return rows;
}

export function signUpRows(
  days: Array<{ date: string; registered: number }>,
): Array<{ label: string; value: number }> {
  return dailyRows(days.map((d) => ({ date: d.date, value: d.registered })));
}

/** Page views per day, or per week beyond a month (ADR-0044). */
export function viewRows(
  days: Array<{ date: string; views: number }>,
): Array<{ label: string; value: number }> {
  return dailyRows(days.map((d) => ({ date: d.date, value: d.views })));
}

/** "09:00", or "1 Mar 09:00" when check-ins span more than one day. */
export function checkInRows(
  hours: Array<{ hour: string; checkedIn: number }>,
): Array<{ label: string; value: number }> {
  const oneDay = new Set(hours.map((h) => h.hour.slice(0, 10))).size <= 1;
  return hours.map((h) => ({
    label: oneDay ? h.hour.slice(11) : `${dayLabel(h.hour.slice(0, 10))} ${h.hour.slice(11)}`,
    value: h.checkedIn,
  }));
}

/** "Mar 2027" for a YYYY-MM month. */
export function monthLabel(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return `${MONTHS[(m ?? 1) - 1]} ${y}`;
}

/** Share of registered people who came, as a whole percentage; null when nobody registered. */
export function attendanceRate(registered: number, checkedIn: number): number | null {
  return registered > 0 ? Math.round((checkedIn / registered) * 100) : null;
}
