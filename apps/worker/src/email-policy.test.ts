import { InMemoryEmailSender } from '@eventhub/kernel';
import { describe, expect, it } from 'vitest';
import { SuppressingEmailSender } from './adapters/suppressing-email-sender.ts';
import { emailClass, maySend } from './email-policy.ts';

describe('email suppression policy (ADR-0043)', () => {
  it('sends everything to addresses with no problems', () => {
    for (const t of ['verify_email', 'event_announcement', 'mfa_enabled', 'anything_new']) {
      expect(maySend(t, null)).toBe(true);
    }
  });

  it('always sends what the person just asked for', () => {
    for (const t of [
      'verify_email',
      'password_reset',
      'registration_confirmed',
      'registration_reminder',
    ]) {
      expect(maySend(t, 'bounce'), t).toBe(true);
      expect(maySend(t, 'complaint'), t).toBe(true);
    }
  });

  it('sends account and booking news after a complaint, not to a bouncing address', () => {
    for (const t of [
      'password_changed',
      'mfa_disabled',
      'registration_promoted',
      'registration_cancelled',
    ]) {
      expect(maySend(t, 'complaint'), t).toBe(true);
      expect(maySend(t, 'bounce'), t).toBe(false);
    }
  });

  it('sends organizer mail to neither, and treats unknown templates the same way', () => {
    for (const t of [
      'event_announcement',
      'organization_invitation',
      'two_step_reminder',
      'new_thing',
    ]) {
      expect(emailClass(t), t).toBe('organizer');
      expect(maySend(t, 'complaint'), t).toBe(false);
      expect(maySend(t, 'bounce'), t).toBe(false);
    }
    // Only well-formed mfa_ templates count as account news.
    expect(emailClass('mfa_')).toBe('organizer');
    expect(emailClass('mfa_enabled')).toBe('transactional');
  });
});

describe('SuppressingEmailSender', () => {
  const message = (to: string, template: string) => ({
    messageId: `m-${to}-${template}`,
    to,
    template,
    subject: 's',
    text: 't',
  });

  it('skips by policy, sends the rest, and never logs the address', async () => {
    const inner = new InMemoryEmailSender();
    const logs: Array<Record<string, unknown>> = [];
    const reasons: Record<string, 'bounce' | 'complaint'> = {
      'gone@example.test': 'bounce',
      'angry@example.test': 'complaint',
    };
    const sender = new SuppressingEmailSender(inner, (a) => Promise.resolve(reasons[a] ?? null), {
      info: (fields) => logs.push(fields),
    });
    await sender.send(message('gone@example.test', 'event_announcement'));
    await sender.send(message('gone@example.test', 'password_reset'));
    await sender.send(message('angry@example.test', 'password_changed'));
    await sender.send(message('angry@example.test', 'two_step_reminder'));
    await sender.send(message('fine@example.test', 'two_step_reminder'));
    expect(inner.sent.map((m) => `${m.to} ${m.template}`)).toEqual([
      'gone@example.test password_reset',
      'angry@example.test password_changed',
      'fine@example.test two_step_reminder',
    ]);
    expect(logs).toEqual([
      { template: 'event_announcement', reason: 'bounce' },
      { template: 'two_step_reminder', reason: 'complaint' },
    ]);
    expect(sender.name).toBe(inner.name);
  });

  it('fails (so the outbox retries) when the lookup fails, rather than sending blind', async () => {
    const inner = new InMemoryEmailSender();
    const sender = new SuppressingEmailSender(inner, () => Promise.reject(new Error('db down')));
    await expect(sender.send(message('a@example.test', 'verify_email'))).rejects.toThrow('db down');
    expect(inner.sent).toEqual([]);
  });
});
