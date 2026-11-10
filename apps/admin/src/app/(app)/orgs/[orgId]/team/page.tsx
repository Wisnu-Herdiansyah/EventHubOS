import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  InviteMemberForm,
  MemberRoleForm,
  RemoveMemberForm,
  RevokeInvitationForm,
} from '@/components/team-forms';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { DataTable } from '@/components/ui/data-table';
import { Dialog } from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { Notice } from '@/components/ui/notice';
import { PageHeader } from '@/components/ui/page-header';
import { Toast } from '@/components/ui/toast';
import type { components } from '@/lib/api-types';
import { api, newIdempotencyKey, signInOn401, unwrap } from '@/lib/api';
import { ApiError } from '@/lib/errors';
import { ROLE_LABELS } from '@/lib/options';
import { canManageMember, teamAbilities } from '@/lib/permissions';
import { adminsWithoutTwoStep, invitationStatus, twoStepStatus } from '@/lib/status';
import { formatInZone } from '@/lib/time';

export const metadata: Metadata = { title: 'Team' };

const UUID = /^[0-9a-f-]{36}$/i;

/** Confirmations after actions whose row disappears. Unknown codes are ignored. */
const NOTICES: Record<string, string> = {
  member_removed: 'Member removed. Their access has ended.',
  invitation_revoked: 'Invitation revoked. Its link no longer works.',
};

const countPeople = (n: number) => (n === 1 ? '1 Owner or Admin' : `${n} Owners and Admins`);

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
  // ADR-0025: present only for roles that manage membership.
  const showTwoStep = (members ?? []).some((m) => m.twoStepEnabled !== undefined);
  const withoutTwoStep = adminsWithoutTwoStep((members ?? []).filter((m) => m.status === 'active'));
  const history = (invitations ?? []).filter((i) => i.status !== 'pending');

  return (
    <div className="stack">
      <PageHeader
        breadcrumbs={[
          { label: 'Organizations', href: '/' },
          { label: org.displayName, href: `/orgs/${orgId}` },
          { label: 'Team' },
        ]}
        eyebrow={org.displayName}
        title="Team"
        description={`Your role: ${ROLE_LABELS[org.role] ?? org.role}`}
        actions={
          members && abilities.canManage ? (
            <Dialog
              kind="sheet"
              trigger={{ label: 'Invite teammate', icon: 'plus' }}
              title="Invite a teammate"
              description="They receive an email with a link to join."
            >
              <InviteMemberForm
                organizationId={orgId}
                idempotencyKey={newIdempotencyKey()}
                roles={roleOptions}
              />
            </Dialog>
          ) : null
        }
      />

      <Toast message={notice} />

      {!members ? (
        <Notice>Only Owners and Admins can see and manage the team.</Notice>
      ) : (
        <>
          {showTwoStep && withoutTwoStep.length > 0 ? (
            <Notice tone={org.requireMfaForAdmins ? 'warning' : 'info'} role={null}>
              {org.requireMfaForAdmins ? (
                <>
                  {countPeople(withoutTwoStep.length)} can’t open this organization until they set
                  up two-step verification: {withoutTwoStep.map((m) => m.email).join(', ')}.
                </>
              ) : (
                <>
                  {countPeople(withoutTwoStep.length)}{' '}
                  {withoutTwoStep.length === 1 ? 'doesn’t' : 'don’t'} use two-step verification yet:{' '}
                  {withoutTwoStep.map((m) => m.email).join(', ')}. If you{' '}
                  <Link href={`/orgs/${orgId}/settings#security-heading`}>require it</Link>, they
                  can’t open this organization until they set it up.
                </>
              )}
            </Notice>
          ) : null}
          <Card flush title={`Members (${members.length})`} titleId="members-heading">
            <DataTable
              caption="Members"
              rows={members}
              rowKey={(m) => m.membershipId}
              columns={[
                {
                  key: 'member',
                  header: 'Member',
                  lead: true,
                  cell: (m) => (
                    <span>
                      <span className="table__primary wrap-anywhere">{m.email}</span>
                      {m.userId === me.userId ? (
                        <span className="text-secondary"> (you)</span>
                      ) : null}
                      {m.joinedAt ? (
                        <span className="table__secondary">
                          Joined {formatInZone(m.joinedAt, org.timezone)}
                        </span>
                      ) : null}
                    </span>
                  ),
                },
                {
                  key: 'role',
                  header: 'Role',
                  cell: (m) =>
                    abilities.canManage && canManageMember(org.role, m.role) ? (
                      <MemberRoleForm
                        organizationId={orgId}
                        membershipId={m.membershipId}
                        email={m.email}
                        role={m.role}
                        roles={roleOptions}
                        idempotencyKey={newIdempotencyKey()}
                      />
                    ) : (
                      <Badge>{ROLE_LABELS[m.role] ?? m.role}</Badge>
                    ),
                },
                ...(showTwoStep
                  ? [
                      {
                        key: 'twoStep',
                        header: 'Two-step',
                        cell: (m: components['schemas']['Member']) => {
                          const st = twoStepStatus(
                            m.twoStepEnabled === true,
                            m.role,
                            org.requireMfaForAdmins,
                          );
                          return <Badge tone={st.tone}>{st.label}</Badge>;
                        },
                      },
                    ]
                  : []),
                {
                  key: 'actions',
                  header: 'Actions',
                  hideHeader: true,
                  align: 'end',
                  cell: (m) =>
                    abilities.canManage && canManageMember(org.role, m.role) ? (
                      <RemoveMemberForm
                        organizationId={orgId}
                        membershipId={m.membershipId}
                        email={m.email}
                        isSelf={m.userId === me.userId}
                        idempotencyKey={newIdempotencyKey()}
                      />
                    ) : null,
                },
              ]}
            />
          </Card>

          <Card flush title={`Pending invitations (${pending.length})`} titleId="pending-heading">
            {pending.length === 0 ? (
              <EmptyState
                icon="users"
                title="No invitations are waiting"
                description="Invitations you send appear here until they are accepted."
              />
            ) : (
              <DataTable
                caption="Pending invitations"
                rows={pending}
                rowKey={(i) => i.id}
                columns={[
                  {
                    key: 'email',
                    header: 'Invitee',
                    lead: true,
                    cell: (i) => (
                      <span>
                        <span className="table__primary wrap-anywhere">{i.email}</span>
                        <span className="table__secondary">
                          Expires {formatInZone(i.expiresAt, org.timezone)}
                        </span>
                      </span>
                    ),
                  },
                  {
                    key: 'role',
                    header: 'Role',
                    cell: (i) => <Badge>{ROLE_LABELS[i.role] ?? i.role}</Badge>,
                  },
                  {
                    key: 'actions',
                    header: 'Actions',
                    hideHeader: true,
                    align: 'end',
                    cell: (i) =>
                      abilities.canManage && canManageMember(org.role, i.role) ? (
                        <RevokeInvitationForm
                          organizationId={orgId}
                          invitationId={i.id}
                          email={i.email}
                          idempotencyKey={newIdempotencyKey()}
                        />
                      ) : null,
                  },
                ]}
              />
            )}
          </Card>

          {history.length > 0 ? (
            <Card flush title="Recent invitations" titleId="history-heading">
              <DataTable
                caption="Recent invitations"
                rows={history}
                rowKey={(i) => i.id}
                columns={[
                  {
                    key: 'email',
                    header: 'Invitee',
                    lead: true,
                    cell: (i) => (
                      <span>
                        <span className="table__primary wrap-anywhere">{i.email}</span>
                        <span className="table__secondary">
                          {ROLE_LABELS[i.role] ?? i.role} · sent{' '}
                          {formatInZone(i.createdAt, org.timezone)}
                        </span>
                      </span>
                    ),
                  },
                  {
                    key: 'status',
                    header: 'Status',
                    align: 'end',
                    cell: (i) => {
                      const st = invitationStatus(i.status);
                      return <Badge tone={st.tone}>{st.label}</Badge>;
                    },
                  },
                ]}
              />
            </Card>
          ) : null}
        </>
      )}
    </div>
  );
}
