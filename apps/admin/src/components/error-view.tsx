'use client';

import { Button } from './ui/button';
import { EmptyState } from './ui/empty-state';

/** Shown by error boundaries: never internal details, only a reference for support. */
export function ErrorView({ digest, reset }: { digest?: string; reset: () => void }) {
  return (
    <div className="card" role="alert">
      <EmptyState
        icon="warning"
        headingLevel={2}
        title="Something went wrong"
        description="Please try again. If it keeps happening, contact support."
        action={
          <div className="stack-sm">
            <Button onClick={reset}>Try again</Button>
            {digest ? <span className="reference">Reference: {digest}</span> : null}
          </div>
        }
      />
    </div>
  );
}
