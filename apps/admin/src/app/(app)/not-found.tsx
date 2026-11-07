import { ButtonLink } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';

export default function NotFound() {
  return (
    <Card>
      <EmptyState
        icon="search"
        headingLevel={2}
        title="Not found"
        description="This page doesn’t exist, or you don’t have access to it."
        action={<ButtonLink href="/">Back to your organizations</ButtonLink>}
      />
    </Card>
  );
}
