import type { ReactNode } from 'react';

export interface ChartDatum {
  label: string;
  value: number;
  /** Series colour 1–4 (tokens --color-chart-n). */
  series?: 1 | 2 | 3 | 4;
}

/** Bar width as a share of the largest value, 0–100. Exported for tests. */
export function barPercent(value: number, max: number): number {
  if (!(max > 0) || !(value > 0)) return 0;
  return Math.max(2, Math.min(100, (value / max) * 100));
}

/**
 * Horizontal bar chart. It is a real table (label, value) with the bars drawn alongside and
 * hidden from assistive tech, so the exact numbers are read out and nothing depends on colour.
 * Bars are SVG attributes, which the nonce-based CSP allows (inline styles are blocked).
 */
export function BarChart({
  caption,
  data,
  valueHeader = 'Count',
  footnote,
}: {
  caption: string;
  data: ChartDatum[];
  valueHeader?: string;
  footnote?: ReactNode;
}) {
  const max = Math.max(0, ...data.map((d) => d.value));
  return (
    <figure className="chart">
      <table className="bar-chart">
        <caption className="visually-hidden">{caption}</caption>
        <thead className="visually-hidden">
          <tr>
            <th scope="col">Category</th>
            <th scope="col">{valueHeader}</th>
          </tr>
        </thead>
        <tbody>
          {data.map((d, i) => (
            <tr key={d.label}>
              <th scope="row" className="bar-chart__label">
                {d.label}
              </th>
              <td className="bar-chart__bar" aria-hidden="true">
                <svg viewBox="0 0 100 10" preserveAspectRatio="none" className="bar-chart__svg">
                  <rect className="bar-chart__track" x="0" y="0" width="100" height="10" rx="2" />
                  <rect
                    className={`chart__bar chart__bar--${d.series ?? (i % 4) + 1}`}
                    x="0"
                    y="0"
                    width={barPercent(d.value, max)}
                    height="10"
                    rx="2"
                  />
                </svg>
              </td>
              <td className="bar-chart__value">{d.value}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {footnote ? <figcaption className="field__hint">{footnote}</figcaption> : null}
    </figure>
  );
}

/** Progress toward a goal, e.g. checklist items done. Text states the numbers. */
export function Meter({ value, max, label }: { value: number; max: number; label: string }) {
  return (
    <div className="meter">
      <div className="meter__text">
        <span>{label}</span>
        <span className="meter__value">
          {value} of {max}
        </span>
      </div>
      <svg viewBox="0 0 100 6" preserveAspectRatio="none" className="meter__svg" aria-hidden="true">
        <rect className="bar-chart__track" x="0" y="0" width="100" height="6" rx="3" />
        <rect
          className={value >= max ? 'chart__bar chart__bar--2' : 'chart__bar chart__bar--1'}
          x="0"
          y="0"
          width={max > 0 ? (value / max) * 100 : 0}
          height="6"
          rx="3"
        />
      </svg>
    </div>
  );
}
