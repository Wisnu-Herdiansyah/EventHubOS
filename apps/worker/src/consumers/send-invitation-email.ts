import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { EmailSender } from '@eventhub/kernel';
import type { EventConsumer } from './consumer.ts';
import { deriveEmailToken } from './verification-token.ts';

export const MEMBERSHIP_INVITED = 'membership.invited';

const payloadSchema = z.object({ invitationId: z.uuid(), organizationId: z.uuid() });

const ROLE_LABELS: Record<string, string> = {
  owner: 'Owner',
  admin: 'Admin',
  billing_admin: 'Billing admin',
  event_manager: 'Event manager',
  content_editor: 'Content editor',
  registration_manager: 'Registration manager',
  analyst: 'Analyst',
  viewer: 'Viewer',
};

export interface InvitationEmailOptions {
  appBaseUrl: string;
  tokenSecret: string;
}

/** Strips characters that could break the subject line or forge links in plain-text mail. */
function plain(text: string): string {
  return text
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[<>]/g, '')
    .trim()
    .slice(0, 200);
}

/**
 * Sends an organization invitation. The token is derived per event (retry-stable, ADR-0008) and
 * bound to the invitation by hash; re-sending replaces the hash, so only the newest link works.
 * The organization ID from the event must match the stored invitation (ownership revalidation).
 */
export function sendInvitationEmailConsumer(
  sender: EmailSender,
  options: InvitationEmailOptions,
): EventConsumer {
  return {
    name: 'membership.send_invitation_email',
    eventTypes: [MEMBERSHIP_INVITED],
    async handle(event, client) {
      const payload = payloadSchema.parse(event.payload);
      if (event.organizationId !== payload.organizationId) return; // envelope/payload mismatch: ignore
      const token = deriveEmailToken(options.tokenSecret, 'invitation', event.eventId);
      const tokenHash = createHash('sha256').update(token).digest();
      const { rows } = await client.query<{
        out_email: string;
        out_organization_name: string;
        out_role: string;
        out_expires_at: Date;
      }>(
        'SELECT out_email, out_organization_name, out_role, out_expires_at FROM eventhub.invitation_issue_token($1, $2, $3)',
        [payload.invitationId, payload.organizationId, tokenHash],
      );
      const inv = rows[0];
      // Revoked, accepted, expired, or not this organization's: nothing to send.
      if (!inv) return;
      const org = plain(inv.out_organization_name);
      const role = ROLE_LABELS[inv.out_role] ?? inv.out_role;
      await sender.send({
        messageId: event.eventId,
        to: inv.out_email,
        template: 'organization_invitation',
        subject: `You're invited to join ${org} on EventHub OS`,
        text: [
          `You have been invited to join ${org} on EventHub OS as ${role}.`,
          '',
          'Accept the invitation by opening this link:',
          `${options.appBaseUrl}/accept-invitation#token=${token}`,
          '',
          `The link can be used once and expires on ${inv.out_expires_at.toISOString().slice(0, 10)} (UTC).`,
          'Sign in with this email address to accept. If you were not expecting this, ignore this email.',
        ].join('\n'),
      });
    },
  };
}
