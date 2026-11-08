import { notFound } from 'next/navigation';

/** An organization's root address has no page yet; event pages live at /{event-slug}. */
export default function OrganizationRoot() {
  notFound();
}
