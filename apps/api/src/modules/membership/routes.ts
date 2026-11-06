import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  AppError,
  canAssignRole,
  createDomainEvent,
  maskEmail,
  notFound,
  ROLES,
  type Actor,
  type Role,
} from '@eventhub/kernel';
import {
  enqueueEvent,
  pgConstraint,
  pgErrorCode,
  PG_UNIQUE_VIOLATION,
  withTransaction,
  writeAudit,
  type Pool,
  type PoolClient,
} from '@eventhub/db';
import { runIdempotentCommand } from '../../http/idempotent-command.ts';
import { defineRoute, type AnyRoute } from '../../http/route.ts';
import { uuid } from '../../http/schemas.ts';
import { emailSchema } from '../identity/password.ts';
import { withOrganization, type OrganizationAccess } from '../tenancy/access.ts';

export const MEMBERSHIP_INVITED = 'membership.invited';
export const DEFAULT_INVITATION_TTL_SECONDS = 7 * 24 * 3600;

const INVITE_RATE_LIMIT = { max: 30, timeWindow: '1 minute' };
const ACCEPT_RATE_LIMIT = { max: 20, timeWindow: '1 minute' };
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

const roleSchema = z.enum(ROLES);
const orgParams = z.object({ organizationId: uuid }).strict();
const invitationParams = z.object({ organizationId: uuid, invitationId: uuid }).strict();
const memberParams = z.object({ organizationId: uuid, membershipId: uuid }).strict();

const createInvitationBody = z
  .object({ email: emailSchema, role: roleSchema })
  .strict()
  .meta({ id: 'CreateInvitationRequest' });

const acceptBody = z
  .object({ token: z.string().regex(TOKEN_RE, 'Malformed token.') })
  .strict()
  .meta({ id: 'AcceptInvitationRequest' });

const invitationSchema = z
  .object({
    id: uuid,
    organizationId: uuid,
    email: z.string(),
    role: roleSchema,
    status: z.enum(['pending', 'accepted', 'revoked', 'expired']),
    invitedBy: uuid,
    createdAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
  })
  .meta({ id: 'Invitation' });

const memberSchema = z
  .object({
    membershipId: uuid,
    userId: uuid,
    email: z.string(),
    role: roleSchema,
    status: z.enum(['active', 'suspended', 'removed']),
    joinedAt: z.iso.datetime().nullable(),
  })
  .meta({ id: 'Member' });

const acceptedSchema = z
  .object({ organizationId: uuid, membershipId: uuid, role: roleSchema })
  .meta({ id: 'InvitationAccepted' });

interface InvitationRow {
  id: string;
  organization_id: string;
  email: string;
  role: Role;
  status: 'pending' | 'accepted' | 'revoked' | 'expired';
  invited_by: string;
  created_at: Date;
  expires_at: Date;
}

const INVITATION_COLUMNS =
  'id, organization_id, email, role, status, invited_by, created_at, expires_at';

function toInvitationDto(r: InvitationRow) {
  // A pending invitation past its expiry is reported as expired without needing a sweeper.
  const status =
    r.status === 'pending' && r.expires_at.getTime() <= Date.now() ? 'expired' : r.status;
  return {
    id: r.id,
    organizationId: r.organization_id,
    email: r.email,
    role: r.role,
    status,
    invitedBy: r.invited_by,
    createdAt: r.created_at.toISOString(),
    expiresAt: r.expires_at.toISOString(),
  };
}

function forbidden(reason: string, message: string): AppError {
  return new AppError('forbidden', message, { details: { reason } });
}

function conflict(reason: string, message: string): AppError {
  return new AppError('conflict', message, { details: { reason } });
}

async function recordMembershipChange(
  client: PoolClient,
  access: Pick<OrganizationAccess, 'organizationId'>,
  actor: Actor,
  action: string,
  targetType: 'invitation' | 'membership',
  targetId: string,
  correlationId: string,
  metadata: Record<string, unknown>,
  payload: Record<string, unknown>,
): Promise<void> {
  await writeAudit(client, {
    organizationId: access.organizationId,
    actor,
    action,
    targetType,
    targetId,
    correlationId,
    metadata,
  });
  await enqueueEvent(
    client,
    createDomainEvent({
      eventType: action,
      schemaVersion: 1,
      actor,
      organizationId: access.organizationId,
      aggregateType: targetType,
      aggregateId: targetId,
      correlationId,
      payload,
    }),
  );
}

export function membershipRoutes(pool: Pool, invitationTtlSeconds: number): AnyRoute[] {
  return [
    defineRoute({
      method: 'POST',
      path: '/v1/organizations/:organizationId/invitations',
      operationId: 'createInvitation',
      summary: 'Invite someone by email with a role at or below your own (ORG-02).',
      tags: ['members'],
      requires: 'membership.manage',
      idempotent: true,
      rateLimit: INVITE_RATE_LIMIT,
      schemas: {
        params: orgParams,
        body: createInvitationBody,
        response: { status: 201, schema: invitationSchema },
      },
      async handler({ principal, params, body, correlationId, idempotencyKey, idempotencyScope }) {
        return withOrganization(
          pool,
          principal,
          params.organizationId,
          'membership.manage',
          (client, access) =>
            runIdempotentCommand(
              client,
              { actorId: principal.userId, scope: idempotencyScope, key: idempotencyKey!, body },
              async () => {
                if (!canAssignRole(access.role, body.role)) {
                  throw forbidden(
                    'role_above_actor',
                    'You cannot invite someone to a role above your own.',
                  );
                }
                const member = await client.query<{ exists: boolean }>(
                  'SELECT eventhub.organization_has_member_email($1, $2) AS exists',
                  [access.organizationId, body.email],
                );
                if (member.rows[0]!.exists) {
                  throw conflict(
                    'already_member',
                    'This person is already a member of the organization.',
                  );
                }
                // Lapsed invitations must not block a fresh one for the same address.
                await client.query(
                  `UPDATE eventhub.invitation SET status = 'expired'
                  WHERE organization_id = $1 AND email = $2 AND status = 'pending' AND expires_at <= now()`,
                  [access.organizationId, body.email],
                );
                let row: InvitationRow;
                try {
                  const r = await client.query<InvitationRow>(
                    `INSERT INTO eventhub.invitation (organization_id, email, role, invited_by, expires_at)
                   VALUES ($1, $2, $3, $4, now() + make_interval(secs => $5))
                   RETURNING ${INVITATION_COLUMNS}`,
                    [
                      access.organizationId,
                      body.email,
                      body.role,
                      principal.userId,
                      invitationTtlSeconds,
                    ],
                  );
                  row = r.rows[0]!;
                } catch (error) {
                  if (
                    pgErrorCode(error) === PG_UNIQUE_VIOLATION &&
                    pgConstraint(error) === 'invitation_pending_email_key'
                  ) {
                    throw conflict(
                      'invitation_pending',
                      'An invitation to this address is already pending.',
                    );
                  }
                  throw error;
                }
                // Only identifiers travel through the outbox; the worker loads the rest when sending.
                await recordMembershipChange(
                  client,
                  access,
                  { type: 'user', id: principal.userId },
                  MEMBERSHIP_INVITED,
                  'invitation',
                  row.id,
                  correlationId,
                  { role: row.role, email: maskEmail(row.email) },
                  { invitationId: row.id, organizationId: access.organizationId },
                );
                return { status: 201, body: toInvitationDto(row) };
              },
            ),
        );
      },
    }),

    defineRoute({
      method: 'GET',
      path: '/v1/organizations/:organizationId/invitations',
      operationId: 'listInvitations',
      summary: 'List the most recent invitations (pending, accepted, revoked, expired).',
      tags: ['members'],
      requires: 'membership.read',
      idempotent: false,
      schemas: {
        params: orgParams,
        response: {
          status: 200,
          schema: z.object({ data: z.array(invitationSchema) }).meta({ id: 'InvitationList' }),
        },
      },
      async handler({ principal, params }) {
        return withOrganization(
          pool,
          principal,
          params.organizationId,
          'membership.read',
          async (client, access) => {
            const { rows } = await client.query<InvitationRow>(
              `SELECT ${INVITATION_COLUMNS} FROM eventhub.invitation
              WHERE organization_id = $1 ORDER BY created_at DESC, id DESC LIMIT 100`,
              [access.organizationId],
            );
            return { status: 200, body: { data: rows.map(toInvitationDto) } };
          },
        );
      },
    }),

    defineRoute({
      method: 'POST',
      path: '/v1/organizations/:organizationId/invitations/:invitationId/revoke',
      operationId: 'revokeInvitation',
      summary: 'Revoke a pending invitation; its link stops working immediately.',
      tags: ['members'],
      requires: 'membership.manage',
      idempotent: true,
      schemas: { params: invitationParams, response: { status: 200, schema: invitationSchema } },
      async handler({ principal, params, correlationId, idempotencyKey, idempotencyScope }) {
        return withOrganization(
          pool,
          principal,
          params.organizationId,
          'membership.manage',
          (client, access) =>
            runIdempotentCommand(
              client,
              {
                actorId: principal.userId,
                scope: idempotencyScope,
                key: idempotencyKey!,
                body: {},
              },
              async () => {
                const { rows } = await client.query<InvitationRow>(
                  `SELECT ${INVITATION_COLUMNS} FROM eventhub.invitation
                  WHERE organization_id = $1 AND id = $2 FOR UPDATE`,
                  [access.organizationId, params.invitationId],
                );
                const inv = rows[0];
                if (!inv) throw notFound('Invitation');
                if (!canAssignRole(access.role, inv.role)) {
                  throw forbidden(
                    'role_above_actor',
                    'You cannot revoke an invitation to a role above your own.',
                  );
                }
                if (inv.status !== 'pending') {
                  throw conflict(
                    'invitation_not_pending',
                    `This invitation is already ${inv.status}.`,
                  );
                }
                const updated = await client.query<InvitationRow>(
                  `UPDATE eventhub.invitation SET status = 'revoked', revoked_at = now(), revoked_by = $3
                  WHERE organization_id = $1 AND id = $2
                  RETURNING ${INVITATION_COLUMNS}`,
                  [access.organizationId, inv.id, principal.userId],
                );
                await recordMembershipChange(
                  client,
                  access,
                  { type: 'user', id: principal.userId },
                  'membership.invitation_revoked',
                  'invitation',
                  inv.id,
                  correlationId,
                  { role: inv.role },
                  { invitationId: inv.id, organizationId: access.organizationId },
                );
                return { status: 200, body: toInvitationDto(updated.rows[0]!) };
              },
            ),
        );
      },
    }),

    defineRoute({
      method: 'GET',
      path: '/v1/organizations/:organizationId/members',
      operationId: 'listMembers',
      summary: 'List organization members with their roles.',
      tags: ['members'],
      requires: 'membership.read',
      idempotent: false,
      schemas: {
        params: orgParams,
        response: {
          status: 200,
          schema: z.object({ data: z.array(memberSchema) }).meta({ id: 'MemberList' }),
        },
      },
      async handler({ principal, params }) {
        return withOrganization(
          pool,
          principal,
          params.organizationId,
          'membership.read',
          async (client, access) => {
            const { rows } = await client.query<{
              out_membership_id: string;
              out_user_id: string;
              out_email: string;
              out_role: Role;
              out_status: 'active' | 'suspended' | 'removed';
              out_accepted_at: Date | null;
            }>(
              `SELECT out_membership_id, out_user_id, out_email, out_role, out_status, out_accepted_at
               FROM eventhub.organization_members($1) WHERE out_status <> 'removed'`,
              [access.organizationId],
            );
            return {
              status: 200,
              body: {
                data: rows.map((r) => ({
                  membershipId: r.out_membership_id,
                  userId: r.out_user_id,
                  email: r.out_email,
                  role: r.out_role,
                  status: r.out_status,
                  joinedAt: r.out_accepted_at?.toISOString() ?? null,
                })),
              },
            };
          },
        );
      },
    }),

    defineRoute({
      method: 'POST',
      path: '/v1/organizations/:organizationId/members/:membershipId/remove',
      operationId: 'removeMember',
      summary:
        'Remove a member. Access ends on their next request; the last Owner cannot be removed.',
      tags: ['members'],
      requires: 'membership.manage',
      idempotent: true,
      schemas: { params: memberParams, response: { status: 204 } },
      async handler({ principal, params, correlationId, idempotencyKey, idempotencyScope }) {
        return withOrganization(
          pool,
          principal,
          params.organizationId,
          'membership.manage',
          (client, access) =>
            runIdempotentCommand(
              client,
              {
                actorId: principal.userId,
                scope: idempotencyScope,
                key: idempotencyKey!,
                body: {},
              },
              async () => {
                // Lock every active Owner row first so two Owners cannot remove each other concurrently.
                const owners = await client.query<{ id: string }>(
                  `SELECT id FROM eventhub.membership
                  WHERE organization_id = $1 AND role = 'owner' AND status = 'active' FOR UPDATE`,
                  [access.organizationId],
                );
                const { rows } = await client.query<{
                  id: string;
                  user_id: string;
                  role: Role;
                  status: string;
                }>(
                  `SELECT id, user_id, role, status FROM eventhub.membership
                  WHERE organization_id = $1 AND id = $2 FOR UPDATE`,
                  [access.organizationId, params.membershipId],
                );
                const target = rows[0];
                if (!target || target.status === 'removed') throw notFound('Member');
                if (!canAssignRole(access.role, target.role)) {
                  throw forbidden(
                    'role_above_actor',
                    'You cannot remove a member whose role is above your own.',
                  );
                }
                if (target.role === 'owner' && owners.rows.length <= 1) {
                  throw conflict(
                    'last_owner',
                    'The last Owner cannot be removed. Make someone else an Owner first.',
                  );
                }
                await client.query(
                  `UPDATE eventhub.membership SET status = 'removed' WHERE organization_id = $1 AND id = $2`,
                  [access.organizationId, target.id],
                );
                await recordMembershipChange(
                  client,
                  access,
                  { type: 'user', id: principal.userId },
                  'membership.removed',
                  'membership',
                  target.id,
                  correlationId,
                  { role: target.role, self: target.user_id === principal.userId },
                  {
                    membershipId: target.id,
                    userId: target.user_id,
                    organizationId: access.organizationId,
                  },
                );
                return { status: 204, body: null };
              },
            ),
        );
      },
    }),

    defineRoute({
      method: 'POST',
      path: '/v1/invitations/accept',
      operationId: 'acceptInvitation',
      summary:
        'Accept an invitation. The organization comes from the token; the signed-in, verified user must own the invited address.',
      tags: ['members'],
      requires: 'authenticated',
      idempotent: false,
      idempotencyExempt:
        'Single-use token: a repeat after success reports the token as used and changes nothing.',
      rateLimit: ACCEPT_RATE_LIMIT,
      schemas: { body: acceptBody, response: { status: 200, schema: acceptedSchema } },
      async handler({ principal, body, correlationId }) {
        const invalid = () =>
          new AppError(
            'validation_failed',
            'This invitation link is invalid, used, revoked, or expired.',
            {
              details: { reason: 'invalid_or_expired_invitation' },
            },
          );
        const tokenHash = createHash('sha256').update(body.token).digest();
        const resolved = await pool.query<{
          out_invitation_id: string;
          out_organization_id: string;
          out_email: string;
          out_role: Role;
        }>(
          'SELECT out_invitation_id, out_organization_id, out_email, out_role FROM eventhub.invitation_resolve($1)',
          [tokenHash],
        );
        const inv = resolved.rows[0];
        if (!inv) throw invalid();
        if (!principal.emailVerified) {
          throw new AppError(
            'email_not_verified',
            'Verify your email address before accepting an invitation.',
          );
        }

        // Tenant context comes from the server-side token lookup, never from client input.
        return withTransaction(
          pool,
          { userId: principal.userId, organizationId: inv.out_organization_id },
          async (client) => {
            const me = await client.query<{ email: string }>(
              'SELECT email FROM eventhub.app_user WHERE id = $1',
              [principal.userId],
            );
            if (me.rows[0]?.email !== inv.out_email) {
              throw forbidden(
                'invitation_email_mismatch',
                'This invitation was sent to a different email address. Sign in with that address to accept it.',
              );
            }
            const locked = await client.query<InvitationRow>(
              `SELECT ${INVITATION_COLUMNS} FROM eventhub.invitation
              WHERE organization_id = $1 AND id = $2 AND status = 'pending' AND expires_at > now()
              FOR UPDATE`,
              [inv.out_organization_id, inv.out_invitation_id],
            );
            const invitation = locked.rows[0];
            if (!invitation) throw invalid();

            const existing = await client.query<{ id: string; status: string }>(
              'SELECT id, status FROM eventhub.membership WHERE organization_id = $1 AND user_id = $2 FOR UPDATE',
              [inv.out_organization_id, principal.userId],
            );
            const current = existing.rows[0];
            if (current?.status === 'active')
              throw conflict('already_member', 'You are already a member of this organization.');
            if (current?.status === 'suspended') {
              throw conflict(
                'membership_suspended',
                'Your membership in this organization is suspended.',
              );
            }
            let membershipId: string;
            if (current) {
              // Previously removed: rejoin with the invited role.
              await client.query(
                `UPDATE eventhub.membership SET role = $3, status = 'active', accepted_at = now()
                WHERE organization_id = $1 AND id = $2`,
                [inv.out_organization_id, current.id, invitation.role],
              );
              membershipId = current.id;
            } else {
              const created = await client.query<{ id: string }>(
                `INSERT INTO eventhub.membership (organization_id, user_id, role, status, invited_by, accepted_at)
               VALUES ($1, $2, $3, 'active', $4, now()) RETURNING id`,
                [inv.out_organization_id, principal.userId, invitation.role, invitation.invited_by],
              );
              membershipId = created.rows[0]!.id;
            }
            await client.query(
              `UPDATE eventhub.invitation SET status = 'accepted', accepted_at = now(), accepted_by = $3
              WHERE organization_id = $1 AND id = $2`,
              [inv.out_organization_id, invitation.id, principal.userId],
            );
            await recordMembershipChange(
              client,
              { organizationId: inv.out_organization_id },
              { type: 'user', id: principal.userId },
              'membership.accepted',
              'membership',
              membershipId,
              correlationId,
              { role: invitation.role, invitationId: invitation.id, rejoined: Boolean(current) },
              {
                membershipId,
                invitationId: invitation.id,
                organizationId: inv.out_organization_id,
              },
            );
            return {
              status: 200,
              body: {
                organizationId: inv.out_organization_id,
                membershipId,
                role: invitation.role,
              },
            };
          },
        );
      },
    }),
  ];
}
