'use client';

import { ErrorView } from '@/components/error-view';

/** Errors in a signed-in page: shown inside the shell, so navigation stays available. */
export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <ErrorView digest={error.digest} reset={reset} />;
}
