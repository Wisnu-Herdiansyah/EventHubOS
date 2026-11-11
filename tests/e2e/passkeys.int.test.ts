import { randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { InMemoryEmailSender } from '@eventhub/kernel';
import { createTestPools } from '@eventhub/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { simpleWebAuthnRelyingParty } from '../../apps/api/src/adapters/simplewebauthn-passkeys.ts';
import { Argon2idPasswordHasher } from '../../apps/api/src/adapters/argon2id-password-hasher.ts';
import { buildApp } from '../../apps/api/src/app.ts';
import { DatabaseSessionAuthenticator } from '../../apps/api/src/modules/identity/authenticator.ts';
import { base32Decode, hotp, totpStep } from '../../apps/api/src/modules/identity/totp.ts';
import { sendMfaChangedEmailConsumer } from '../../apps/worker/src/consumers/send-mfa-email.ts';
import { sendVerificationEmailConsumer } from '../../apps/worker/src/consumers/send-verification-email.ts';
import { OutboxDispatchPublisher } from '../../apps/worker/src/outbox-dispatch-publisher.ts';
import { relayOnce } from '../../apps/worker/src/outbox-relay.ts';
import { otherKey, SoftAuthenticator } from '../support/soft-authenticator.ts';

const SECRET = 'test-token-secret-0123456789abcdef'; // pragma: allowlist secret
const PASSWORD = 'Systematic Elegance 2027'; // pragma: allowlist secret (synthetic)
const MFA_KEY = randomBytes(32);
const ORIGIN = 'https://admin.eventhub.test';
const RP_ID = 'admin.eventhub.test';

/** Passkeys as the second step of sign-in (ADR-0033), verified by the real library. */
describe('passkeys', () => {
  const pools = createTestPools();
  const inbox = new InMemoryEmailSender();
  const publisher = new OutboxDispatchPublisher(pools.worker, [
    sendVerificationEmailConsumer(inbox, {
      appBaseUrl: 'https://app.example.test',
      ttlSeconds: 86_400,
      tokenSecret: SECRET,
    }),
    sendMfaChangedEmailConsumer(inbox, { appBaseUrl: 'https://app.example.test' }),
  ]);
  let app: FastifyInstance;
  let noPasskeysApp: FastifyInstance;
  let ip = 0;
  const call = (opts: InjectOptions, target = () => app) =>
    target().inject({ ...opts, remoteAddress: `10.61.${Math.floor(++ip / 250)}.${ip % 250}` });
  const mails = (to: string, template: string) =>
    inbox.sent.filter((m) => m.to === to && m.template === template);
  const drain = async (until: () => boolean) => {
    for (let i = 0; i < 30 && !until(); i++) {
      await relayOnce(pools.worker, publisher, { batchSize: 100, maxAttempts: 5 });
    }
  };
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });
  const post = (url: string, token: string | null, payload: object, target = () => app) =>
    call({ method: 'POST', url, headers: token ? auth(token) : {}, payload }, target);
  const login = (email: string) =>
    call({ method: 'POST', url: '/v1/auth/login', payload: { email, password: PASSWORD } });

  async function account() {
    const email = `pk-${randomUUID()}@example.test`;
    await call({ method: 'POST', url: '/v1/auth/signup', payload: { email, password: PASSWORD } });
    await drain(() => mails(email, 'verify_email').length > 0);
    const verify = /#token=([A-Za-z0-9_-]{43})$/m.exec(mails(email, 'verify_email')[0]!.text)![1]!;
    await call({ method: 'POST', url: '/v1/auth/verify-email', payload: { token: verify } });
    const token = (await login(email)).json().token as string;
    const me = await call({ method: 'GET', url: '/v1/me', headers: auth(token) });
    return { email, token, userId: me.json().userId as string };
  }

  /** Turns on app-based two-step verification; other sessions are signed out, this one stays. */
  async function enableMfa(a: { token: string; userId: string }) {
    const setup = await post('/v1/auth/mfa/setup', a.token, { currentPassword: PASSWORD });
    const secret = base32Decode(setup.json().secret);
    await post('/v1/auth/mfa/confirm', a.token, { code: hotp(secret, totpStep(Date.now())) });
    await pools.migrator.query(
      'UPDATE eventhub.auth_mfa_factor SET last_used_step = 0 WHERE user_id = $1',
      [a.userId],
    );
    return secret;
  }

  async function addPasskey(a: { token: string }, name = 'Work laptop') {
    const key = new SoftAuthenticator(RP_ID, ORIGIN);
    const opts = await post('/v1/auth/passkeys/options', a.token, { currentPassword: PASSWORD });
    expect(opts.statusCode, opts.body).toBe(200);
    const res = await post('/v1/auth/passkeys', a.token, {
      name,
      response: key.register(opts.json().options),
    });
    expect(res.statusCode, res.body).toBe(201);
    return { key, id: res.json().id as string };
  }

  /** Password step, then passkey options for that sign-in. */
  async function passkeyChallenge(email: string) {
    const challengeToken = (await login(email)).json().challengeToken as string;
    const opts = await post('/v1/auth/login/mfa/passkey-options', null, { challengeToken });
    return { challengeToken, opts };
  }

  beforeAll(async () => {
    const base = {
      pool: pools.app,
      authenticator: new DatabaseSessionAuthenticator(pools.app),
      passwordHasher: new Argon2idPasswordHasher(),
      logger: false as const,
      validateResponses: true,
    };
    const identity = {
      sessionTtlSeconds: 3600,
      loginMaxFailures: 5,
      loginLockSeconds: 900,
      mfaEncryptionKey: MFA_KEY,
    };
    app = await buildApp({
      ...base,
      identity: {
        ...identity,
        passkeys: simpleWebAuthnRelyingParty({ origin: ORIGIN, rpId: RP_ID }),
      },
    });
    noPasskeysApp = await buildApp({ ...base, identity });
  });
  afterAll(async () => {
    await app.close();
    await noPasskeysApp.close();
    await pools.end();
  });

  it('can be added only with two-step verification on, the password, and a valid response', async () => {
    const a = await account();
    const early = await post('/v1/auth/passkeys/options', a.token, { currentPassword: PASSWORD });
    expect(early.statusCode).toBe(409);
    expect(early.json().error.details.reason).toBe('mfa_not_enabled');

    await enableMfa(a);
    const wrong = await post('/v1/auth/passkeys/options', a.token, { currentPassword: 'nope' });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().error.details.reason).toBe('bad_current_password');

    // Bound to this site: options name the relying party and exclude nothing yet.
    const opts = await post('/v1/auth/passkeys/options', a.token, { currentPassword: PASSWORD });
    expect(opts.json().options).toMatchObject({ rp: { id: RP_ID }, attestation: 'none' });
    const key = new SoftAuthenticator(RP_ID, ORIGIN);
    const response = key.register(opts.json().options);
    const added = await post('/v1/auth/passkeys', a.token, { name: 'Work laptop', response });
    expect(added.statusCode, added.body).toBe(201);
    expect(added.json()).toMatchObject({ name: 'Work laptop', lastUsedAt: null });

    // The challenge is single-use: the same response again adds nothing.
    const replay = await post('/v1/auth/passkeys', a.token, { name: 'Again', response });
    expect(replay.statusCode).toBe(400);
    expect(replay.json().error.details.reason).toBe('passkey_setup_not_started');

    // A response for another site is refused.
    const opts2 = await post('/v1/auth/passkeys/options', a.token, { currentPassword: PASSWORD });
    const foreign = new SoftAuthenticator('evil.example', 'https://evil.example');
    const bad = await post('/v1/auth/passkeys', a.token, {
      name: 'Phish',
      response: foreign.register(opts2.json().options),
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.details.reason).toBe('passkey_invalid');

    const list = await call({ method: 'GET', url: '/v1/auth/passkeys', headers: auth(a.token) });
    expect(list.json()).toMatchObject({ available: true });
    expect(list.json().passkeys.map((p: { name: string }) => p.name)).toEqual(['Work laptop']);

    await drain(() => mails(a.email, 'mfa_passkey_added').length > 0);
    expect(mails(a.email, 'mfa_passkey_added')).toHaveLength(1);
    const audit = await pools.migrator.query(
      `SELECT action FROM eventhub.audit_event WHERE actor_id = $1 AND action LIKE 'identity.passkey%'`,
      [a.userId],
    );
    // The wrong password was recorded too; the passkey was added once.
    expect(audit.rows.map((r) => r.action).sort()).toEqual([
      'identity.passkey_added',
      'identity.passkey_setup_failed',
    ]);
  });

  it('completes sign-in instead of an app code', async () => {
    const a = await account();
    await enableMfa(a);
    const { key, id } = await addPasskey(a);

    // The password step says a passkey can finish this sign-in.
    expect((await login(a.email)).json()).toMatchObject({ mfaRequired: true, passkey: true });
    const { challengeToken, opts } = await passkeyChallenge(a.email);
    expect(opts.statusCode, opts.body).toBe(200);
    expect(opts.json().options).toMatchObject({ rpId: RP_ID, allowCredentials: [{ id: key.id }] });
    const res = await post('/v1/auth/login/mfa', null, {
      challengeToken,
      passkey: key.authenticate(opts.json().options),
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().token).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const list = await call({ method: 'GET', url: '/v1/auth/passkeys', headers: auth(a.token) });
    expect(list.json().passkeys.find((p: { id: string }) => p.id === id).lastUsedAt).not.toBeNull();
    const audit = await pools.migrator.query(
      `SELECT metadata FROM eventhub.audit_event
        WHERE actor_id = $1 AND action = 'identity.logged_in' ORDER BY occurred_at DESC LIMIT 1`,
      [a.userId],
    );
    expect(audit.rows[0].metadata).toMatchObject({ mfa: 'passkey' });
  });

  it('refuses replays, other sites, cloned keys, forged signatures and other people’s passkeys', async () => {
    const a = await account();
    await enableMfa(a);
    const { key } = await addPasskey(a);
    const b = await account();
    await enableMfa(b);
    const { key: bKey } = await addPasskey(b);

    const attempt = async (make: (options: { challenge: string }) => object) => {
      const { challengeToken, opts } = await passkeyChallenge(a.email);
      return post('/v1/auth/login/mfa', null, {
        challengeToken,
        passkey: make(opts.json().options),
      });
    };
    const refused = (res: {
      statusCode: number;
      json: () => { error: { details: { reason: string } } };
    }) => {
      expect(res.statusCode).toBe(401);
      expect(res.json().error.details.reason).toBe('bad_code');
    };

    // A good assertion works once; replaying it on a new sign-in fails (new challenge).
    const first = await passkeyChallenge(a.email);
    const good = key.authenticate(first.opts.json().options);
    expect(
      (
        await post('/v1/auth/login/mfa', null, {
          challengeToken: first.challengeToken,
          passkey: good,
        })
      ).statusCode,
    ).toBe(200);
    refused(await attempt(() => good));

    refused(await attempt((o) => key.authenticate(o, { origin: 'https://evil.example' })));
    // A clone presents a counter no higher than the one last stored (1, after the good sign-in).
    refused(
      await attempt((o) => {
        key.counter = 1;
        return key.authenticate(o, { keepCounter: true });
      }),
    );
    refused(await attempt((o) => key.authenticate(o, { signWith: otherKey() })));
    // B's passkey is not on A's account. This is the fifth failure, which locks the account.
    const fifth = await attempt((o) => bKey.authenticate(o));
    expect(fifth.statusCode).toBe(401);
    expect(fifth.json().error.details.reason).toBe('locked');

    // Failures count toward the lockout like wrong codes: now even the password step is refused.
    const locked = await login(a.email);
    expect(locked.statusCode).toBe(401);
    expect(locked.json().token).toBeUndefined();
    expect(locked.json().challengeToken).toBeUndefined();
  });

  it('lets one of two simultaneous sign-ins with the same assertion counter through', async () => {
    const a = await account();
    await enableMfa(a);
    const { key, id } = await addPasskey(a);
    // Two sign-ins in flight, each with a valid assertion carrying the same counter (as a cloned
    // authenticator would). Both pass the library's check against the stored counter; only the
    // database update, made under the row lock, can let exactly one through.
    const one = await passkeyChallenge(a.email);
    const two = await passkeyChallenge(a.email);
    key.counter = 4;
    const first = key.authenticate(one.opts.json().options);
    key.counter = 4;
    const second = key.authenticate(two.opts.json().options);
    const holder = await pools.migrator.connect();
    let results;
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT 1 FROM eventhub.auth_passkey WHERE id = $1 FOR UPDATE', [id]);
      const pending = Promise.all([
        post('/v1/auth/login/mfa', null, { challengeToken: one.challengeToken, passkey: first }),
        post('/v1/auth/login/mfa', null, { challengeToken: two.challengeToken, passkey: second }),
      ]);
      await new Promise((r) => setTimeout(r, 300));
      await holder.query('COMMIT');
      results = await pending;
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      holder.release();
    }
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 401]);
  });

  it('needs a sign-in challenge, and an account with passkeys', async () => {
    const bad = await post('/v1/auth/login/mfa/passkey-options', null, {
      challengeToken: 'x'.repeat(43),
    });
    expect(bad.statusCode).toBe(401);
    const a = await account();
    await enableMfa(a);
    expect((await login(a.email)).json()).toMatchObject({ mfaRequired: true, passkey: false });
    const { opts } = await passkeyChallenge(a.email);
    expect(opts.statusCode).toBe(409);
    expect(opts.json().error.details.reason).toBe('no_passkeys');
  });

  it('can be removed with the password; turning two-step off removes them all', async () => {
    const a = await account();
    await enableMfa(a);
    const one = await addPasskey(a, 'Phone');
    await addPasskey(a, 'Security key');

    const wrong = await post(`/v1/auth/passkeys/${one.id}/remove`, a.token, {
      currentPassword: 'nope',
    });
    expect(wrong.statusCode).toBe(400);
    const removed = await post(`/v1/auth/passkeys/${one.id}/remove`, a.token, {
      currentPassword: PASSWORD,
    });
    expect(removed.statusCode).toBe(204);
    expect(
      (await post(`/v1/auth/passkeys/${one.id}/remove`, a.token, { currentPassword: PASSWORD }))
        .statusCode,
    ).toBe(404);

    // The removed passkey no longer signs in.
    const { challengeToken, opts } = await passkeyChallenge(a.email);
    const res = await post('/v1/auth/login/mfa', null, {
      challengeToken,
      passkey: one.key.authenticate(opts.json().options),
    });
    expect(res.statusCode).toBe(401);
    await drain(() => mails(a.email, 'mfa_passkey_removed').length > 0);
    expect(mails(a.email, 'mfa_passkey_removed')).toHaveLength(1);

    // Another person cannot remove someone else's passkey.
    const b = await account();
    const list = await call({ method: 'GET', url: '/v1/auth/passkeys', headers: auth(a.token) });
    const remaining = list.json().passkeys[0].id as string;
    expect(
      (await post(`/v1/auth/passkeys/${remaining}/remove`, b.token, { currentPassword: PASSWORD }))
        .statusCode,
    ).toBe(404);

    // Turning off two-step verification removes the rest.
    const codes = await post('/v1/auth/mfa/recovery-codes', a.token, { currentPassword: PASSWORD });
    const off = await post('/v1/auth/mfa/disable', a.token, {
      currentPassword: PASSWORD,
      recoveryCode: codes.json().recoveryCodes[0],
    });
    expect(off.statusCode, off.body).toBe(200);
    const after = await call({ method: 'GET', url: '/v1/auth/passkeys', headers: auth(a.token) });
    expect(after.json().passkeys).toEqual([]);
  });

  it('reports itself unavailable without a configured origin', async () => {
    const a = await account();
    const list = await call(
      { method: 'GET', url: '/v1/auth/passkeys', headers: auth(a.token) },
      () => noPasskeysApp,
    );
    expect(list.json()).toEqual({ available: false, passkeys: [] });
    const opts = await post(
      '/v1/auth/passkeys/options',
      a.token,
      { currentPassword: PASSWORD },
      () => noPasskeysApp,
    );
    expect(opts.statusCode).toBe(503);
  });

  it('keeps the tables out of reach of the app role (functions only)', async () => {
    for (const table of ['auth_passkey', 'auth_webauthn_challenge']) {
      await expect(pools.app.query(`SELECT * FROM eventhub.${table}`)).rejects.toThrow(
        /permission denied/,
      );
    }
  });
});
