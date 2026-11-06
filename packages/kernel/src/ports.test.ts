import { describe, expect, it } from 'vitest';
import { createDomainEvent } from './domain-event.ts';
import { InMemoryEmailSender, InMemoryEventPublisher } from './ports.ts';
import { maskEmail } from './redaction.ts';
import { emailSenderContract, eventPublisherContract } from './testing/index.ts';

eventPublisherContract('in_memory', () => {
  const publisher = new InMemoryEventPublisher();
  return Promise.resolve({
    publisher,
    delivered: () => Promise.resolve(publisher.published.map((e) => e.eventId)),
  });
});

describe('InMemoryEventPublisher', () => {
  it('can simulate an outage', async () => {
    const p = new InMemoryEventPublisher();
    p.failNext(1);
    const e = createDomainEvent({
      eventType: 't',
      schemaVersion: 1,
      actor: { type: 'system', id: null },
      organizationId: null,
      aggregateType: 'a',
      aggregateId: '00000000-0000-4000-8000-000000000000',
      correlationId: 'c',
      payload: {},
    });
    await expect(p.publish(e)).rejects.toThrow('simulated outage');
    await p.publish(e);
    expect(p.published).toHaveLength(1);
  });
});

describe('maskEmail', () => {
  it('masks the local part', () => {
    expect(maskEmail('alice@example.com')).toBe('a***@example.com');
    expect(maskEmail('invalid')).toBe('***');
  });
});

emailSenderContract('in_memory', () => {
  const sender = new InMemoryEmailSender();
  return Promise.resolve({ sender, delivered: () => Promise.resolve(sender.sent) });
});

describe('InMemoryEmailSender', () => {
  it('can simulate an outage', async () => {
    const s = new InMemoryEmailSender();
    s.failNext(1);
    const m = { messageId: 'm', to: 'a@example.test', template: 't', subject: 's', text: 'x' };
    await expect(s.send(m)).rejects.toThrow('simulated outage');
    await s.send(m);
    expect(s.sent).toHaveLength(1);
  });
});
