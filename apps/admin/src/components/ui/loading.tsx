/** Indeterminate progress with a text label, announced politely. */
export function Spinner({ label = 'Loading…', size }: { label?: string; size?: 'sm' }) {
  return (
    <span className="loading" role="status">
      <span className={size === 'sm' ? 'spinner spinner--sm' : 'spinner'} aria-hidden="true" />
      <span>{label}</span>
    </span>
  );
}

/** Placeholder shapes while a page streams in. Hidden from assistive tech; pair with a Spinner. */
export function Skeleton({ variant }: { variant?: 'title' | 'block' | 'w-60' | 'w-80' }) {
  return (
    <span className={variant ? `skeleton skeleton--${variant}` : 'skeleton'} aria-hidden="true" />
  );
}
