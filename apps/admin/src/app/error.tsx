'use client';

/** Generic error boundary: never shows internal error details to the user. */
export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="narrow card accent" role="alert">
      <h1>Something went wrong</h1>
      <p>Please try again. If it keeps happening, contact support.</p>
      {error.digest ? <p className="reference">Reference: {error.digest}</p> : null}
      <button type="button" onClick={reset}>
        Try again
      </button>
    </div>
  );
}
