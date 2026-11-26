import { describe, expect, it } from 'vitest';
import { InMemoryWhatsAppSender, normalizeIndonesianPhone } from './messaging.ts';
import { whatsAppSenderContract } from './testing/index.ts';

whatsAppSenderContract('in_memory', () => {
  const sender = new InMemoryWhatsAppSender();
  return Promise.resolve({
    sender,
    testRecipient: '+6281234567890',
    delivered: () => Promise.resolve(sender.sent),
  });
});

describe('normalizeIndonesianPhone', () => {
  it('turns the ways people type a mobile number into E.164', () => {
    for (const input of [
      '081234567890',
      '0812-3456-7890',
      '0812 3456 7890',
      '+62 812 3456 7890',
      '+62-812-3456-7890',
      '6281234567890',
      '81234567890',
      '(0812) 3456 7890',
    ]) {
      expect(normalizeIndonesianPhone(input), input).toBe('+6281234567890');
    }
  });

  it('accepts 9 to 12 digits after the 8', () => {
    expect(normalizeIndonesianPhone('08123456789')).toBe('+628123456789');
    expect(normalizeIndonesianPhone('0812345678901')).toBe('+62812345678901');
  });

  it('refuses what is not an Indonesian mobile number', () => {
    for (const input of [
      '',
      '0212345678', // a Jakarta landline
      '0812345', // too short
      '08123456789012', // too long
      '+6591234567', // Singapore
      '+812345678901', // a plus without the country code
      '0812xyz4567',
      'not a number',
    ]) {
      expect(normalizeIndonesianPhone(input), input).toBeNull();
    }
  });
});

describe('InMemoryWhatsAppSender', () => {
  it('can simulate an outage, then sends', async () => {
    const s = new InMemoryWhatsAppSender();
    s.failNext(1);
    const m = {
      messageId: 'm-1',
      to: '+6281234567890',
      template: 'ticket_confirmed',
      language: 'id' as const,
      parameters: ['Ade'],
    };
    await expect(s.sendTemplate(m)).rejects.toThrow('simulated outage');
    await expect(s.sendTemplate(m)).resolves.toEqual({ providerMessageId: 'wamid.test-1' });
    expect(s.sent).toHaveLength(1);
  });
});
