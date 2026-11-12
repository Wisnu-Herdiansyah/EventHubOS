import { randomUUID } from 'node:crypto';
import type { FastifyInstance, InjectOptions } from 'fastify';
import sharp from 'sharp';
import { InMemoryObjectStore } from '@eventhub/kernel';
import {
  createFixtureEvent,
  createFixtureOrganization,
  createFixtureUser,
  createTestPools,
  type FixtureUser,
} from '@eventhub/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Argon2idPasswordHasher } from '../../apps/api/src/adapters/argon2id-password-hasher.ts';
import { buildApp } from '../../apps/api/src/app.ts';
import { DatabaseSessionAuthenticator } from '../../apps/api/src/modules/identity/authenticator.ts';

/** Sharing image and page theme (ADR-0046). */
describe('sharing image and theme', () => {
  const pools = createTestPools();
  const store = new InMemoryObjectStore();
  let app: FastifyInstance;
  let ip = 0;
  const call = (opts: InjectOptions) =>
    app.inject({ ...opts, remoteAddress: `10.77.${Math.floor(++ip / 250)}.${ip % 250}` });
  const auth = (u: FixtureUser) => ({ authorization: `Bearer ${u.token}` });
  const idem = () => ({ 'idempotency-key': `k-${randomUUID()}` });

  beforeAll(async () => {
    app = await buildApp({
      pool: pools.app,
      authenticator: new DatabaseSessionAuthenticator(pools.app),
      passwordHasher: new Argon2idPasswordHasher(),
      identity: { sessionTtlSeconds: 3600, loginMaxFailures: 5, loginLockSeconds: 900 },
      logger: false,
      validateResponses: true,
      rateLimitPerMinute: 10_000,
      objectStore: store,
    });
  });
  afterAll(async () => {
    await app.close();
    await pools.end();
  });

  async function setup() {
    const owner = await createFixtureUser(pools.migrator);
    const orgId = await createFixtureOrganization(pools.migrator, owner.id);
    const eventId = await createFixtureEvent(pools.migrator, orgId, owner.id);
    const handle = `t-${randomUUID().slice(0, 8)}`;
    await pools.migrator.query(
      'UPDATE eventhub.organization SET public_handle = $2 WHERE id = $1',
      [orgId, handle],
    );
    const evtUrl = `/v1/organizations/${orgId}/events/${eventId}`;
    const upload = async () => {
      const data = (
        await sharp({ create: { width: 1200, height: 630, channels: 3, background: '#1f6b4a' } })
          .png()
          .toBuffer()
      ).toString('base64');
      const res = await call({
        method: 'POST',
        url: `/v1/organizations/${orgId}/assets`,
        headers: { ...auth(owner), ...idem() },
        payload: { name: 'Share card', data },
      });
      expect(res.statusCode, res.body).toBe(201);
      return res.json().id as string;
    };
    const version = async () =>
      (await call({ method: 'GET', url: evtUrl, headers: auth(owner) })).json().version as number;
    const patch = async (settings: Record<string, unknown>) =>
      call({
        method: 'PATCH',
        url: evtUrl,
        headers: { ...auth(owner), ...idem() },
        payload: { expectedVersion: await version(), settings },
      });
    /** Publishes the event with a published (empty) page, directly: publishing has its tests. */
    const goPublic = async () => {
      const page = await pools.migrator.query<{ id: string }>(
        `INSERT INTO eventhub.event_page (organization_id, event_id, draft_sections, draft_schema_version,
                                         draft_updated_by, published_revision, published_draft_version)
         VALUES ($1, $2, '[]', 1, $3, 1, 1) RETURNING id`,
        [orgId, eventId, owner.id],
      );
      await pools.migrator.query(
        `INSERT INTO eventhub.page_revision (organization_id, page_id, revision, sections, schema_version,
                                            draft_version, published_by)
         VALUES ($1, $2, 1, '[]', 1, 1, $3)`,
        [orgId, page.rows[0]!.id, owner.id],
      );
      await pools.migrator.query(
        `UPDATE eventhub.event SET lifecycle = 'published' WHERE id = $1`,
        [eventId],
      );
    };
    const slug = (
      await pools.migrator.query<{ slug: string }>(
        'SELECT slug FROM eventhub.event WHERE id = $1',
        [eventId],
      )
    ).rows[0]!.slug;
    const publicPage = () =>
      call({ method: 'GET', url: `/v1/public/sites/${handle}/events/${slug}` });
    const publicImage = (id: string) =>
      call({ method: 'GET', url: `/v1/public/sites/${handle}/assets/${id}/large` });
    return { owner, orgId, eventId, handle, upload, patch, goPublic, publicPage, publicImage };
  }

  it('stores a theme and a sharing image from the library', async () => {
    const t = await setup();
    const image = await t.upload();
    const res = await t.patch({
      visibility: 'public',
      theme: 'forest',
      sharing: { title: 'Summit', imageAssetId: image },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().settings).toMatchObject({
      theme: 'forest',
      sharing: { title: 'Summit', imageAssetId: image },
    });
    // null clears the theme: the standard colours.
    expect((await t.patch({ theme: null })).json().settings.theme).toBeUndefined();
  });

  it('refuses unknown themes and images that are not in this library', async () => {
    const t = await setup();
    const other = await setup();
    const theirs = await other.upload();
    expect((await t.patch({ theme: 'neon' })).statusCode).toBe(400);
    for (const id of [theirs, randomUUID()]) {
      const res = await t.patch({ sharing: { imageAssetId: id } });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.details.fields).toEqual([
        {
          path: 'body.settings.sharing.imageAssetId',
          message: 'This image is not in the library.',
        },
      ]);
    }
  });

  it('serves the sharing image and theme on the public page, only while it is public', async () => {
    const t = await setup();
    const image = await t.upload();
    const unused = await t.upload();
    await t.patch({ visibility: 'public', theme: 'ember', sharing: { imageAssetId: image } });
    // Not public yet: nothing is served.
    expect((await t.publicImage(image)).statusCode).toBe(404);
    await t.goPublic();
    const page = await t.publicPage();
    expect(page.statusCode, page.body).toBe(200);
    expect(page.json()).toMatchObject({ theme: 'ember', sharing: { imageAssetId: image } });
    const served = await t.publicImage(image);
    expect(served.statusCode).toBe(200);
    expect(served.headers['content-type']).toBe('image/webp');
    // Other library images stay private.
    expect((await t.publicImage(unused)).statusCode).toBe(404);
    // A private event no longer exposes it.
    await pools.migrator.query(
      `UPDATE eventhub.event SET settings = settings || '{"visibility":"private"}' WHERE id = $1`,
      [t.eventId],
    );
    expect((await t.publicImage(image)).statusCode).toBe(404);
  });

  it('pages without a theme or image show the standard colours and no image', async () => {
    const t = await setup();
    await t.patch({ visibility: 'public' });
    await t.goPublic();
    expect((await t.publicPage()).json()).toMatchObject({
      theme: 'default',
      sharing: { imageAssetId: null },
    });
  });

  it('will not delete an image an event shares; it will once the event stops using it', async () => {
    const t = await setup();
    const image = await t.upload();
    await t.patch({ sharing: { imageAssetId: image } });
    const remove = () =>
      call({
        method: 'POST',
        url: `/v1/organizations/${t.orgId}/assets/${image}/delete`,
        headers: { ...auth(t.owner), ...idem() },
      });
    const refused = await remove();
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.details.reason).toBe('asset_in_use');
    await t.patch({ sharing: null });
    expect((await remove()).statusCode).toBe(204);
  });
});
