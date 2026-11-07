import type { ReactNode } from 'react';

export interface Column<T> {
  key: string;
  header: string;
  cell: (row: T) => ReactNode;
  /** 'num' right-aligns with tabular figures; 'end' right-aligns actions. */
  align?: 'start' | 'end' | 'num';
  /** The row's identifying cell; on small screens it heads the stacked card. */
  lead?: boolean;
  /** Visually hide the header (e.g. an actions column). It stays available to screen readers. */
  hideHeader?: boolean;
}

/**
 * A semantic table. On screens under 40rem every row becomes a stacked card with header labels,
 * so nothing scrolls sideways.
 */
export function DataTable<T>({
  caption,
  columns,
  rows,
  rowKey,
}: {
  caption: string;
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
}) {
  const cls = (c: Column<T>) =>
    [c.align === 'num' ? 'num' : c.align === 'end' ? 'end' : null, c.lead ? 'table__lead' : null]
      .filter(Boolean)
      .join(' ') || undefined;
  return (
    <div className="table-wrap">
      <table className="table table--responsive">
        <caption className="visually-hidden">{caption}</caption>
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} scope="col" className={cls(c)}>
                {c.hideHeader ? <span className="visually-hidden">{c.header}</span> : c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={rowKey(row)}>
              {columns.map((c) => (
                <td key={c.key} className={cls(c)} data-label={c.hideHeader ? '' : c.header}>
                  {c.cell(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
