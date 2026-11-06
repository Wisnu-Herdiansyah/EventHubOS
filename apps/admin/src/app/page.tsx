import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { CreateOrganizationForm } from '@/components/org-forms';
import { api, newIdempotencyKey, signInOn401, unwrap } from '@/lib/api';
import { LOCALES, ROLE_LABELS, timeZones } from '@/lib/options';
import { readSessionToken } from '@/lib/session';

// The layout's title template applies to child routes only, not to this root page.
export const metadata: Metadata = { title: { absolute: 'Organizations · EventHub OS' } };

export default async function HomePage() {
  if (!(await readSessionToken())) redirect('/login');
  let me, orgs;
  try {
    const client = await api();
    me = unwrap(await client.GET('/v1/me'));
    orgs = unwrap(await client.GET('/v1/me/organizations')).data;
  } catch (error) {
    signInOn401(error, '/');
  }

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <p className="eyebrow">Your workspace</p>
          <h1>Organizations</h1>
        </div>
      </div>
      <div className="grid">
        <section className="card accent" aria-labelledby="orgs-heading">
          <h2 id="orgs-heading">Your organizations</h2>
          {orgs.length === 0 ? (
            <p className="muted">You are not a member of any organization yet.</p>
          ) : (
            <ul className="list">
              {orgs.map((o) => (
                <li key={o.organizationId}>
                  <Link href={`/orgs/${o.organizationId}`}>{o.displayName}</Link>
                  <span className="badge">{ROLE_LABELS[o.role] ?? o.role}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className="card" aria-labelledby="new-org-heading">
          <h2 id="new-org-heading">Create an organization</h2>
          {me.emailVerified ? (
            <CreateOrganizationForm
              idempotencyKey={newIdempotencyKey()}
              timeZones={timeZones()}
              locales={LOCALES}
            />
          ) : (
            <div className="message info" role="status">
              Verify your email address before creating an organization. Check your inbox for the
              link.
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
