import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import type { EmailMessage } from '@eventhub/kernel';
import { emailSenderContract } from '@eventhub/kernel/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { EmailDeliveryError, ResendEmailSender } from './resend-email-sender.ts';

const API_KEY = 're_fake_key_for_tests_0123456789'; // pragma: allowlist secret
const FROM = 'EventHub OS <no-reply@mail.example.test>';

interface Recorded {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: Record<string, unknown>;
}

/**
 * Minimal fake of Resend's POST /emails, modelled on the official SDK's contract: Bearer auth,
 * JSON body, Idempotency-Key replay returning the original id, JSON errors {statusCode,name,message}.
 */
class FakeResend {
  server!: Server;
  baseUrl = '';
  requests: Recorded[] = [];
  delivered = new Map<string, { id: string; body: Record<string, unknown> }>();
  next: ((res: ServerResponse) => void) | null = null;

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c: Buffer) => (raw += c.toString()));
      req.on('end', () => {
        const body = JSON.parse(raw || '{}') as Record<string, unknown>;
        this.requests.push({ method: req.method!, url: req.url!, headers: req.headers, body });
        if (this.next) {
          const handler = this.next;
          this.next = null;
          handler(res);
          return;
        }
        if (req.headers.authorization !== `Bearer ${API_KEY}`)
          return json(res, 401, {
            statusCode: 401,
            name: 'invalid_api_key',
            message: 'API key is invalid',
          });
        const key = String(req.headers['idempotency-key'] ?? '');
        const prior = this.delivered.get(key);
        if (prior) {
          if (JSON.stringify(prior.body) !== JSON.stringify(body)) {
            return json(res, 409, {
              statusCode: 409,
              name: 'invalid_idempotent_request',
              message: 'payload differs',
            });
          }
          return json(res, 200, { id: prior.id });
        }
        const id = randomUUID();
        if (key) this.delivered.set(key, { id, body });
        json(res, 200, { id });
      });
    });
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.baseUrl = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  stop(): Promise<void> {
    return new Promise((r) => this.server.close(() => r()));
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

const fake = new FakeResend();
beforeAll(() => fake.start());
afterAll(() => fake.stop());
beforeEach(() => {
  fake.requests = [];
  fake.next = null;
});

const sender = (overrides: Partial<ConstructorParameters<typeof ResendEmailSender>[0]> = {}) =>
  new ResendEmailSender({
    apiKey: API_KEY,
    from: FROM,
    baseUrl: fake.baseUrl,
    timeoutMs: 2000,
    ...overrides,
  });

const message = (): EmailMessage => ({
  messageId: randomUUID(),
  to: `person-${randomUUID()}@example.test`,
  template: 'verify_email',
  subject: 'Verify your email address for EventHub OS',
  text: 'Open https://app.example.test/verify-email#token=SECRET_TOKEN_VALUE',
});

emailSenderContract('resend (fake server)', () => {
  const s = sender();
  return Promise.resolve({
    sender: s,
    delivered: () =>
      Promise.resolve(
        fake.requests.map((r) => ({
          messageId: String(r.headers['idempotency-key']),
          to: (r.body.to as string[])[0]!,
          template: String((r.body.tags as Array<{ value: string }>)[0]!.value),
          subject: String(r.body.subject),
          text: String(r.body.text),
        })),
      ),
  });
});

async function failure(promise: Promise<unknown>): Promise<EmailDeliveryError> {
  try {
    await promise;
  } catch (e) {
    if (e instanceof EmailDeliveryError) return e;
    throw e;
  }
  throw new Error('expected EmailDeliveryError');
}

describe('ResendEmailSender request', () => {
  it('posts the documented payload with auth, idempotency key and template tag', async () => {
    const m = message();
    await sender().send(m);
    const r = fake.requests[0]!;
    expect(r.method).toBe('POST');
    expect(r.url).toBe('/emails');
    expect(r.headers.authorization).toBe(`Bearer ${API_KEY}`);
    expect(r.headers['content-type']).toBe('application/json');
    expect(r.headers['idempotency-key']).toBe(m.messageId);
    expect(r.headers['user-agent']).toBe('eventhub-os-worker');
    expect(r.body).toEqual({
      from: FROM,
      to: [m.to],
      subject: m.subject,
      text: m.text,
      tags: [{ name: 'template', value: 'verify_email' }],
    });
  });

  it('a retried identical message is deduplicated by the provider', async () => {
    const m = message();
    await sender().send(m);
    await sender().send(m);
    expect(fake.requests).toHaveLength(2);
    expect(fake.delivered.get(m.messageId)).toBeDefined();
  });

  it('tolerates a trailing slash in the base URL', async () => {
    await sender({ baseUrl: `${fake.baseUrl}/` }).send(message());
    expect(fake.requests[0]!.url).toBe('/emails');
  });
});

describe('ResendEmailSender error classification', () => {
  const cases: Array<[string, number, unknown, string, boolean]> = [
    [
      'rate limit',
      429,
      { statusCode: 429, name: 'rate_limit_exceeded', message: 'Too many requests' },
      'rate_limit_exceeded',
      true,
    ],
    [
      'daily quota',
      429,
      { statusCode: 429, name: 'daily_quota_exceeded', message: 'quota' },
      'daily_quota_exceeded',
      true,
    ],
    [
      'concurrent idempotent requests',
      409,
      { statusCode: 409, name: 'concurrent_idempotent_requests', message: 'x' },
      'concurrent_idempotent_requests',
      true,
    ],
    [
      'server error',
      500,
      { statusCode: 500, name: 'internal_server_error', message: 'oops' },
      'internal_server_error',
      true,
    ],
    [
      'validation error',
      422,
      {
        statusCode: 422,
        name: 'validation_error',
        message: 'Invalid `to` field: person@example.test',
      },
      'validation_error',
      false,
    ],
    [
      'bad sender domain',
      403,
      { statusCode: 403, name: 'invalid_from_address', message: 'domain not verified' },
      'invalid_from_address',
      false,
    ],
    [
      'reused key, different payload',
      409,
      { statusCode: 409, name: 'invalid_idempotent_request', message: 'x' },
      'invalid_idempotent_request',
      false,
    ],
  ];

  it.each(cases)('%s', async (_label, status, body, code, retryable) => {
    fake.next = (res) => json(res, status, body);
    const e = await failure(sender().send(message()));
    expect(e).toMatchObject({ code, status, retryable });
  });

  it('treats a non-JSON 5xx as retryable', async () => {
    fake.next = (res) => {
      res.writeHead(502, { 'content-type': 'text/html' });
      res.end('<html>bad gateway</html>');
    };
    expect(await failure(sender().send(message()))).toMatchObject({
      code: 'http_502',
      retryable: true,
    });
  });

  it('never trusts an unexpected provider error name as a code', async () => {
    fake.next = (res) => json(res, 400, { name: 'Bad <script> name with spaces', message: 'x' });
    expect(await failure(sender().send(message()))).toMatchObject({
      code: 'http_400',
      retryable: false,
    });
  });

  it('times out and reports a retryable timeout', async () => {
    fake.next = () => undefined; // never respond
    const e = await failure(sender({ timeoutMs: 1000 }).send(message()));
    expect(e).toMatchObject({ code: 'timeout', status: null, retryable: true });
  });

  it('reports network failures as retryable', async () => {
    const e = await failure(sender({ baseUrl: 'http://127.0.0.1:1' }).send(message()));
    expect(e).toMatchObject({ code: 'network_error', retryable: true });
  });

  it('rejects a success response without an id', async () => {
    fake.next = (res) => json(res, 200, {});
    expect(await failure(sender().send(message()))).toMatchObject({
      code: 'malformed_success_response',
    });
  });

  it('error messages never contain the API key, recipient, provider text, or email body', async () => {
    const m = message();
    fake.next = (res) =>
      json(res, 422, { statusCode: 422, name: 'validation_error', message: `Invalid to: ${m.to}` });
    const e = await failure(sender().send(m));
    for (const secret of [API_KEY, m.to, 'SECRET_TOKEN_VALUE', 'Invalid to']) {
      expect(e.message).not.toContain(secret);
      expect(JSON.stringify(e)).not.toContain(secret);
    }
  });
});
