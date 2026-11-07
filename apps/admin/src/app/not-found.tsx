import { ButtonLink } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';

export default function NotFound() {
  return (
    <main id="main" className="auth" tabIndex={-1}>
      <div className="card auth__main">
        <EmptyState
          icon="search"
          headingLevel={2}
          title="Not found"
          description="This page doesn’t exist, or you don’t have access to it."
          action={<ButtonLink href="/">Back to your organizations</ButtonLink>}
        />
      </div>
    </main>
  );
}
