'use client';

import { ErrorView } from '@/components/error-view';

/** Errors outside the signed-in shell (or in the shell itself). */
export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main id="main" className="auth" tabIndex={-1}>
      <div className="auth__main">
        <ErrorView digest={error.digest} reset={reset} />
      </div>
    </main>
  );
}
