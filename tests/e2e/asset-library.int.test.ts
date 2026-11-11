import { randomUUID } from 'node:crypto';
import type { FastifyInstance, InjectOptions } from 'fastify';
import sharp from 'sharp';
import { InMemoryObjectStore } from '@eventhub/kernel';
import {
  addFixtureMembership,
  createFixtureEvent,
  createFixtureOrganization,
  createFixtureUser,
  createTestPools,
  type FixtureUser,
} from '@eventhub/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Argon2idPasswordHasher } from '../../apps/api/src/adapters/argon2id-password-hasher.ts';
import { buildApp } from '../../apps/api/src/app.ts';
import { MAX_ASSETS_PER_ORGANIZATION } from '../../apps/api/src/modules/asset/routes.ts';
import { DatabaseSessionAuthenticator } from '../../apps/api/src/modules/identity/authenticator.ts';
import { deleteAssetObjectsConsumer } from '../../apps/worker/src/consumers/delete-asset-objects.ts';
import { OutboxDispatchPublisher } from '../../apps/worker/src/outbox-dispatch-publisher.ts';
import { relayOnce } from '../../apps/worker/src/outbox-relay.ts';

/** Asset library (ADR-0042): uploads, page photos, public serving and deletion. */
describe('asset library', () => {
  const pools = createTestPools();
  const store = new InMemoryObjectStore();
  const publisher = new OutboxDispatchPublisher(pools.worker, [deleteAssetObjectsConsumer(store)]);
  let app: FastifyInstance;
  let bare: FastifyInstance;
  let ip = 0;
  const call = (opts: InjectOptions, on = () => app) =>
    on().inject({ ...opts, remoteAddress: `10.73.${Math.floor(++ip / 250)}.${ip % 250}` });
  const auth = (u: FixtureUser) => ({ authorization: `Bearer ${u.token}` });
  const idem = (key = `k-${randomUUID()}`) => ({ 'idempotency-key': key });

  const deps = () => ({
    pool: pools.app,
    authenticator: new DatabaseSessionAuthenticator(pools.app),
    passwordHasher: new Argon2idPasswordHasher(),
    identity: { sessionTtlSeconds: 3600, loginMaxFailures: 5, loginLockSeconds: 900 },
    logger: false as const,
    validateResponses: true,
    rateLimitPerMinute: 10_000,
  });

  beforeAll(async () => {
    app = await buildApp({ ...deps(), objectStore: store });
    bare = await buildApp(deps());
  });
  afterAll(async () => {
    await app.close();
    await bare.close();
    await pools.end();
  });

  async function drain() {
    for (let i = 0; i < 10; i++) {
      const s = await relayOnce(pools.worker, publisher, { batchSize: 100, maxAttempts: 5 });
      if (s.published + s.retried === 0) return;
    }
  }

  /** A photo with metadata that must not survive: GPS, a copyright owner, an orientation. */
  async function photo(width = 640, height = 480): Promise<string> {
    const buf = await sharp({ create: { width, height, channels: 3, background: '#1f3a5f' } })
      .jpeg()
      .withMetadata({
        orientation: 1,
        exif: { IFD0: { Copyright: 'private-owner' }, IFD3: { GPSLatitudeRef: 'S' } },
      })
      .toBuffer();
    return buf.toString('base64');
  }

  async function org(roles: string[] = []) {
    const owner = await createFixtureUser(pools.migrator);
    const orgId = await createFixtureOrganization(pools.migrator, owner.id);
    const eventId = await createFixtureEvent(pools.migrator, orgId, owner.id);
    const handle = `a-${randomUUID().slice(0, 8)}`;
    await pools.migrator.query(
      'UPDATE eventhub.organization SET public_handle = $2 WHERE id = $1',
      [orgId, handle],
    );
    const members: Record<string, FixtureUser> = {};
    for (const role of roles) {
      const u = await createFixtureUser(pools.migrator);
      await addFixtureMembership(pools.migrator, orgId, u.id, role);
      members[role] = u;
    }
    const base = `/v1/organizations/${orgId}/assets`;
    const upload = async (
      payload: Record<string, unknown> = {},
      as = owner,
      headers: Record<string, string> = idem(),
      on = () => app,
    ) =>
      call(
        {
          method: 'POST',
          url: base,
          headers: { ...auth(as), ...headers },
          payload: {
            name: 'Ade on stage.jpg',
            altText: 'Ade speaking',
            data: await photo(),
            ...payload,
          },
        },
        on,
      );
    const list = (as = owner, on = () => app) =>
      call({ method: 'GET', url: base, headers: auth(as) }, on);
    const content = (id: string, variant = 'large', as = owner) =>
      call({ method: 'GET', url: `${base}/${id}/${variant}`, headers: auth(as) });
    const update = (id: string, payload: object, as = owner) =>
      call({ method: 'PATCH', url: `${base}/${id}`, headers: { ...auth(as), ...idem() }, payload });
    const remove = (id: string, as = owner) =>
      call({ method: 'POST', url: `${base}/${id}/delete`, headers: { ...auth(as), ...idem() } });
    const pageUrl = `/v1/organizations/${orgId}/events/${eventId}/page`;
    const page = async () =>
      (await call({ method: 'GET', url: pageUrl, headers: auth(owner) })).json<{
        draft: { version: number };
      }>();
    const saveDraft = async (photoAssetId: string | null) =>
      call({
        method: 'POST',
        url: `${pageUrl}/draft`,
        headers: { ...auth(owner), ...idem() },
        payload: {
          expectedVersion: (await page()).draft.version,
          sections: [HERO, speakers(photoAssetId)],
        },
      });
    const publishPage = async () =>
      call({
        method: 'POST',
        url: `${pageUrl}/publish`,
        headers: { ...auth(owner), ...idem() },
        payload: { expectedVersion: (await page()).draft.version },
      });
    const makePublic = (settings: Record<string, unknown> = { visibility: 'public' }) =>
      pools.migrator.query(
        `UPDATE eventhub.event SET lifecycle = 'published', settings = settings || $2::jsonb
          WHERE id = $1`,
        [eventId, JSON.stringify(settings)],
      );
    const publicImage = (id: string, variant = 'small', h = handle) =>
      call({ method: 'GET', url: `/v1/public/sites/${h}/assets/${id}/${variant}` });
    return {
      owner,
      orgId,
      eventId,
      handle,
      members,
      upload,
      list,
      content,
      update,
      remove,
      saveDraft,
      publishPage,
      makePublic,
      publicImage,
    };
  }

  const HERO = {
    id: 'hero',
    type: 'hero',
    version: 1,
    visible: true,
    heading: 'Jakarta Summit 2027',
    body: 'Two days of operations and branding.',
    ctaLabel: 'Register now',
  };
  const speakers = (photoAssetId: string | null) => ({
    id: 'speakers',
    type: 'speakers',
    version: 3,
    visible: true,
    heading: 'Speakers',
    items: [{ id: 'ade', name: 'Ade Wisnu', role: 'Host', bio: '', photoAssetId }],
  });

  it('re-encodes an upload as WebP in two sizes, without metadata', async () => {
    const t = await org();
    const res = await t.upload();
    expect(res.statusCode, res.body).toBe(201);
    const asset = res.json();
    expect(asset).toMatchObject({
      name: 'Ade on stage.jpg',
      altText: 'Ade speaking',
      contentType: 'image/webp',
      width: 640,
      height: 480,
    });
    expect(store.keys()).toEqual(
      expect.arrayContaining([
        `organizations/${t.orgId}/assets/${asset.id}/large.webp`,
        `organizations/${t.orgId}/assets/${asset.id}/small.webp`,
      ]),
    );

    const large = await t.content(asset.id);
    expect(large.statusCode).toBe(200);
    expect(large.headers['content-type']).toBe('image/webp');
    expect(large.headers['cache-control']).toBe('private, max-age=300');
    expect(large.headers['x-content-type-options']).toBe('nosniff');
    expect(large.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
    const meta = await sharp(large.rawPayload).metadata();
    expect([meta.format, meta.width, meta.exif]).toEqual(['webp', 640, undefined]);
    expect(large.rawPayload.includes(Buffer.from('private-owner'))).toBe(false);
    const small = await sharp((await t.content(asset.id, 'small')).rawPayload).metadata();
    expect([small.width, small.height]).toEqual([480, 360]);

    const listed = (await t.list()).json();
    expect(listed).toMatchObject({ limit: MAX_ASSETS_PER_ORGANIZATION, uploadsAvailable: true });
    expect(listed.data.map((a: { id: string }) => a.id)).toEqual([asset.id]);

    // The audit trail records the upload without its name or text.
    const audit = await pools.migrator.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM eventhub.audit_event WHERE organization_id = $1 AND action = 'asset.uploaded'`,
      [t.orgId],
    );
    expect(audit.rows).toHaveLength(1);
    expect(JSON.stringify(audit.rows[0]!.metadata)).not.toContain('Ade');
  });

  it('refuses SVG, broken files and malformed input, storing nothing', async () => {
    const t = await org();
    const before = store.keys().length;
    const svg = await t.upload({
      data: Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg"><script>x()</script></svg>',
      ).toString('base64'),
    });
    expect(svg.statusCode).toBe(400);
    expect(svg.json().error.details.reason).toBe('unsupported_type');
    const truncated = await t.upload({ data: (await photo()).slice(0, 200) });
    expect(truncated.statusCode).toBe(400);
    expect(truncated.json().error.details.reason).toBe('unreadable');
    expect((await t.upload({ data: 'not base64!' })).statusCode).toBe(400);
    expect((await t.upload({ name: '' })).statusCode).toBe(400);
    expect((await t.upload({ altText: 'line\nbreak' })).statusCode).toBe(400);
    expect((await t.upload({ storageKey: '../x' })).statusCode).toBe(400);
    expect((await t.upload({}, t.owner, {})).json().error.code).toBe('idempotency_key_required');
    expect(store.keys().length).toBe(before);
    expect((await t.list()).json().data).toEqual([]);
  });

  it('replays a retried upload instead of storing it twice', async () => {
    const t = await org();
    const key = idem();
    const data = await photo();
    const first = await t.upload({ data }, t.owner, key);
    const again = await t.upload({ data }, t.owner, key);
    expect(again.statusCode).toBe(201);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(again.json().id).toBe(first.json().id);
    expect((await t.list()).json().data).toHaveLength(1);
    expect(store.keys().filter((k) => k.includes(t.orgId))).toHaveLength(2);
  });

  it('lets page editors upload and everyone who can see events view; denies the rest', async () => {
    const t = await org(['content_editor', 'viewer', 'billing_admin']);
    const editor = await t.upload({}, t.members.content_editor);
    expect(editor.statusCode).toBe(201);
    const id = editor.json().id as string;
    expect((await t.list(t.members.viewer)).statusCode).toBe(200);
    expect((await t.content(id, 'small', t.members.viewer)).statusCode).toBe(200);
    const viewerUpload = await t.upload({}, t.members.viewer);
    expect(viewerUpload.statusCode).toBe(403);
    expect(viewerUpload.json().error.details.reason).toBe('missing_permission:asset.manage');
    expect((await t.remove(id, t.members.viewer)).statusCode).toBe(403);
    expect((await t.update(id, { name: 'x' }, t.members.viewer)).statusCode).toBe(403);
    expect((await t.list(t.members.billing_admin)).statusCode).toBe(403);
    const stranger = await createFixtureUser(pools.migrator);
    expect((await t.list(stranger)).statusCode).toBe(404);
    expect((await t.content(id, 'large', stranger)).statusCode).toBe(404);
  });

  it('keeps each organization to its own images', async () => {
    const a = await org();
    const b = await org();
    const id = (await a.upload()).json().id as string;
    // Through B's own URL the image does not exist; through A's URL B is not a member.
    const viaB = await call({
      method: 'GET',
      url: `/v1/organizations/${b.orgId}/assets/${id}/large`,
      headers: auth(b.owner),
    });
    expect(viaB.statusCode).toBe(404);
    expect((await a.content(id, 'large', b.owner)).statusCode).toBe(404);
    expect((await b.update(id, { name: 'Mine now' })).statusCode).toBe(404);
    expect((await b.remove(id)).statusCode).toBe(404);
    expect((await b.list()).json().data).toEqual([]);
    // Nor can B put A's image on its page, or serve it from its public site.
    const save = await b.saveDraft(id);
    expect(save.statusCode).toBe(400);
    expect(save.json().error.details.fields).toEqual([
      {
        path: 'body.sections.1.items.0.photoAssetId',
        message: 'This image is not in the library.',
      },
    ]);
    expect((await b.publicImage(id)).statusCode).toBe(404);
  });

  it('serves an image publicly only while a published public page uses it', async () => {
    const t = await org();
    const id = (await t.upload()).json().id as string;
    expect((await t.saveDraft(id)).statusCode).toBe(200);
    await t.makePublic();
    // A draft never makes an image public.
    expect((await t.publicImage(id)).statusCode).toBe(404);

    expect((await t.publishPage()).statusCode).toBe(200);
    const res = await t.publicImage(id);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['content-type']).toBe('image/webp');
    expect(res.headers['cache-control']).toBe('public, max-age=300');
    expect((await t.publicImage(id, 'large')).statusCode).toBe(200);
    expect((await t.publicImage(id, 'small', 'some-other-org')).statusCode).toBe(404);
    expect((await t.publicImage(id, 'original')).statusCode).toBe(400);

    await t.makePublic({ visibility: 'unlisted' });
    expect((await t.publicImage(id)).statusCode).toBe(200);
    await t.makePublic({ visibility: 'private' });
    expect((await t.publicImage(id)).statusCode).toBe(404);
    await t.makePublic({ visibility: 'public' });
    await pools.migrator.query(`UPDATE eventhub.event SET lifecycle = 'draft' WHERE id = $1`, [
      t.eventId,
    ]);
    expect((await t.publicImage(id)).statusCode).toBe(404);
    await t.makePublic();
    await pools.migrator.query(
      `UPDATE eventhub.organization SET status = 'suspended' WHERE id = $1`,
      [t.orgId],
    );
    expect((await t.publicImage(id)).statusCode).toBe(404);
    await pools.migrator.query(`UPDATE eventhub.organization SET status = 'active' WHERE id = $1`, [
      t.orgId,
    ]);
    expect((await t.publicImage(id)).statusCode).toBe(200);

    // A newer revision without the photo takes it off the public site, though the draft history
    // still has it.
    expect((await t.saveDraft(null)).statusCode).toBe(200);
    expect((await t.publicImage(id)).statusCode).toBe(200);
    expect((await t.publishPage()).statusCode).toBe(200);
    expect((await t.publicImage(id)).statusCode).toBe(404);

    // An image in the library that no page uses is not public either.
    const unused = (await t.upload()).json().id as string;
    expect((await t.publicImage(unused)).statusCode).toBe(404);
  });

  it('refuses to delete an image a draft or published page uses; then deletes it and its files', async () => {
    const t = await org();
    const id = (await t.upload()).json().id as string;
    const keys = [
      `organizations/${t.orgId}/assets/${id}/large.webp`,
      `organizations/${t.orgId}/assets/${id}/small.webp`,
    ];
    await t.saveDraft(id);
    await t.publishPage();
    const inDraft = await t.remove(id);
    expect(inDraft.statusCode).toBe(409);
    expect(inDraft.json().error.details.reason).toBe('asset_in_use');
    expect(inDraft.json().error.message).toContain('Fixture event');
    // Off the draft but still on the published page.
    await t.saveDraft(null);
    expect((await t.remove(id)).json().error.details.reason).toBe('asset_in_use');
    await t.publishPage();

    const res = await t.remove(id);
    expect(res.statusCode, res.body).toBe(204);
    expect((await t.list()).json().data).toEqual([]);
    expect((await t.content(id)).statusCode).toBe(404);
    expect((await t.remove(id)).statusCode).toBe(404);
    // A deleted image cannot go back on a page.
    expect((await t.saveDraft(id)).statusCode).toBe(400);
    // The worker removes the files.
    expect(store.keys()).toEqual(expect.arrayContaining(keys));
    await drain();
    expect(store.keys().filter((k) => keys.includes(k))).toEqual([]);
    const row = await pools.migrator.query<{ deleted_by: string }>(
      'SELECT deleted_by FROM eventhub.asset WHERE id = $1',
      [id],
    );
    expect(row.rows[0]!.deleted_by).toBe(t.owner.id);
  });

  it('never lets a delete and a page save that uses the image both succeed', async () => {
    const t = await org();
    for (let round = 0; round < 6; round++) {
      const id = (await t.upload()).json().id as string;
      const [save, del] = await Promise.all([t.saveDraft(id), t.remove(id)]);
      // Either the page got the photo and the delete was refused, or the delete won and the
      // save was refused; a conflict on the page version is also fine.
      expect(save.statusCode === 200 && del.statusCode === 204, `round ${round}`).toBe(false);
      expect([save.statusCode, del.statusCode]).not.toContain(500);
      await t.saveDraft(null);
    }
  });

  it("the worker deletes only inside the asset's own prefix", async () => {
    const consumer = deleteAssetObjectsConsumer(store);
    const orgId = randomUUID();
    const assetId = randomUUID();
    const event = (storageKey: string) =>
      ({ organizationId: orgId, payload: { assetId, storageKey } }) as never;
    const victim = `organizations/${randomUUID()}/assets/${assetId}/large.webp`;
    await store.put(victim, { data: Buffer.from('x'), contentType: 'image/webp' });
    await expect(
      consumer.handle(event(victim.replace('/large.webp', '')), null as never),
    ).rejects.toThrow(/does not match/);
    await expect(consumer.handle(event('../../etc'), null as never)).rejects.toThrow();
    expect(store.keys()).toContain(victim);
  });

  it('renames and re-describes an image', async () => {
    const t = await org();
    const id = (await t.upload()).json().id as string;
    const res = await t.update(id, { name: 'Keynote', altText: '' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ name: 'Keynote', altText: '' });
    expect((await t.update(id, {})).statusCode).toBe(400);
    expect((await t.update(id, { name: 'a\u0007b' })).statusCode).toBe(400);
    expect((await t.update(id, { width: 1 })).statusCode).toBe(400);
  });

  it(`holds an organization to ${MAX_ASSETS_PER_ORGANIZATION} images`, async () => {
    const t = await org();
    await pools.migrator.query(
      `INSERT INTO eventhub.asset (organization_id, name, content_type, width, height, byte_size,
                                   storage_key, sha256, created_by)
       SELECT $1::uuid, 'filler', 'image/webp', 1, 1, 1, 'organizations/' || $1::text || '/assets/f' || g,
              sha256(g::text::bytea), $2
         FROM generate_series(1, $3) g`,
      [t.orgId, t.owner.id, MAX_ASSETS_PER_ORGANIZATION],
    );
    const full = await t.upload();
    expect(full.statusCode).toBe(409);
    expect(full.json().error.details.reason).toBe('asset_limit_reached');
  });

  it('keeps the limit when uploads race for the last place', async () => {
    const t = await org();
    await pools.migrator.query(
      `INSERT INTO eventhub.asset (organization_id, name, content_type, width, height, byte_size,
                                   storage_key, sha256, created_by)
       SELECT $1::uuid, 'filler', 'image/webp', 1, 1, 1, 'organizations/' || $1::text || '/assets/f' || g,
              sha256(g::text::bytea), $2
         FROM generate_series(1, $3) g`,
      [t.orgId, t.owner.id, MAX_ASSETS_PER_ORGANIZATION - 1],
    );
    const results = await Promise.all([t.upload(), t.upload(), t.upload()]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 409, 409]);
  });

  it('answers 503 for uploads and bytes when the server has no image storage', async () => {
    const t = await org();
    const res = await t.upload({}, t.owner, idem(), () => bare);
    expect(res.statusCode).toBe(503);
    expect(res.json().error.details.reason).toBe('storage_unavailable');
    expect((await t.list(t.owner, () => bare)).json().uploadsAvailable).toBe(false);
  });
});
