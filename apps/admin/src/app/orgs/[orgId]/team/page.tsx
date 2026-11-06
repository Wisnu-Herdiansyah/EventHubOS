import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  InviteMemberForm,
  MemberRoleForm,
  RemoveMemberForm,
  RevokeInvitationForm,
} from '@/components/team-forms';
import { api, newIdempotencyKey, signInOn401, unwrap } from '@/lib/api';
import { ApiError } from '@/lib/errors';
import { ROLE_LABELS } from '@/lib/options';
import { canManageMember, teamAbilities } from '@/lib/permissions';
import { formatInZone } from '@/lib/time';

export const metadata: Metadata = { title: 'Team' };

const UUID = /^[0-9a-f-]{36}$/i;

/** Confirmations after actions whose row disappears. Unknown codes are ignored. */
const NOTICES: Record<string, string> = {
  member_removed: 'Member removed. Their access has ended.',
  invitation_revoked: 'Invitation revoked. Its link no longer works.',
};

const INVITATION_LABELS: Record<string, string> = {
  pending: 'Pending',
  accepted: 'Accepted',
  revoked: 'Revoked',
  expired: 'Expired',
};

export default async function TeamPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { orgId } = await params;
  const noticeCode = (await searchParams).notice;
  const notice = typeof noticeCode === 'string' ? NOTICES[noticeCode] : undefined;
  if (!UUID.test(orgId)) notFound();
  const path = { organizationId: orgId };
  let org, me, members, invitations;
  try {
    const client = await api();
    org = unwrap(await client.GET('/v1/organizations/{organizationId}', { params: { path } }));
    me = unwrap(await client.GET('/v1/me'));
    if (teamAbilities(org.role).canRead) {
      members = unwrap(
        await client.GET('/v1/organizations/{organizationId}/members', { params: { path } }),
      ).data;
      invitations = unwrap(
        await client.GET('/v1/organizations/{organizationId}/invitations', { params: { path } }),
      ).data;
    }
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) notFound();
    signInOn401(error, `/orgs/${orgId}/team`);
  }

  const abilities = teamAbilities(org.role);
  const roleOptions = abilities.assignableRoles.map((r) => ({
    value: r,
    label: ROLE_LABELS[r] ?? r,
  }));
  const pending = (invitations ?? []).filter((i) => i.status === 'pending');
  const history = (invitations ?? []).filter((i) => i.status !== 'pending');

  return (
    <div className="stack">
      <nav className="breadcrumbs" aria-label="Breadcrumb">
        <ol>
          <li>
            <Link href="/">Organizations</Link>
          </li>
          <li>
            <Link href={`/orgs/${orgId}`}>{org.displayName}</Link>
          </li>
          <li aria-current="page">Team</li>
        </ol>
      </nav>
      <div className="page-head">
        <div>
          <p className="eyebrow">{org.displayName}</p>
          <h1>Team</h1>
          <p className="muted">Your role: {ROLE_LABELS[org.role] ?? org.role}</p>
        </div>
      </div>

      {notice ? (
        <div className="message success" role="status">
          {notice}
        </div>
      ) : null}

      {!members ? (
        <div className="message info" role="status">
          Only Owners and Admins can see and manage the team.
        </div>
      ) : (
        <>
          <div className="grid">
            <section className="card accent" aria-labelledby="members-heading">
              <h2 id="members-heading">Members ({members.length})</h2>
              <ul className="member-list">
                {members.map((m) => {
                  const isSelf = m.userId === me.userId;
                  const manageable = abilities.canManage && canManageMember(org.role, m.role);
                  return (
                    <li key={m.membershipId}>
                      <div className="member-head">
                        <span>
                          <span className="member-email">{m.email}</span>
                          {isSelf ? <span className="muted"> (you)</span> : null}
                          {m.joinedAt ? (
                            <span className="hint">
                              Joined {formatInZone(m.joinedAt, org.timezone)}
                            </span>
                          ) : null}
                        </span>
                        <span className="badge">{ROLE_LABELS[m.role] ?? m.role}</span>
                      </div>
                      {manageable ? (
                        <div className="member-actions">
                          <MemberRoleForm
                            organizationId={orgId}
                            membershipId={m.membershipId}
                            email={m.email}
                            role={m.role}
                            roles={roleOptions}
                            idempotencyKey={newIdempotencyKey()}
                          />
                          <RemoveMemberForm
                            organizationId={orgId}
                            membershipId={m.membershipId}
                            email={m.email}
                            isSelf={isSelf}
                            idempotencyKey={newIdempotencyKey()}
                          />
                        </div>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </section>

            {abilities.canManage ? (
              <section className="card" aria-labelledby="invite-heading">
                <h2 id="invite-heading">Invite a teammate</h2>
                <InviteMemberForm
                  organizationId={orgId}
                  idempotencyKey={newIdempotencyKey()}
                  roles={roleOptions}
                />
              </section>
            ) : null}
          </div>

          <section className="card" aria-labelledby="pending-heading">
            <h2 id="pending-heading">Pending invitations ({pending.length})</h2>
            {pending.length === 0 ? (
              <p className="muted">No invitations are waiting.</p>
            ) : (
              <ul className="member-list">
                {pending.map((i) => (
                  <li key={i.id}>
                    <div className="member-head">
                      <span>
                        <span className="member-email">{i.email}</span>
                        <span className="hint">
                          Expires {formatInZone(i.expiresAt, org.timezone)}
                        </span>
                      </span>
                      <span className="badge">{ROLE_LABELS[i.role] ?? i.role}</span>
                    </div>
                    {abilities.canManage && canManageMember(org.role, i.role) ? (
                      <RevokeInvitationForm
                        organizationId={orgId}
                        invitationId={i.id}
                        email={i.email}
                        idempotencyKey={newIdempotencyKey()}
                      />
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </section>

          {history.length > 0 ? (
            <section className="card" aria-labelledby="history-heading">
              <h2 id="history-heading">Recent invitations</h2>
              <ul className="list">
                {history.map((i) => (
                  <li key={i.id}>
                    <span>
                      <span className="member-email">{i.email}</span>
                      <span className="hint">
                        {ROLE_LABELS[i.role] ?? i.role} · sent{' '}
                        {formatInZone(i.createdAt, org.timezone)}
                      </span>
                    </span>
                    <span className={`badge ${i.status}`}>
                      {INVITATION_LABELS[i.status] ?? i.status}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </>
      )}
    </div>
  );
}
