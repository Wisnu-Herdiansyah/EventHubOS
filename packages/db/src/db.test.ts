import { describe, expect, it } from 'vitest';
import { canonicalJson, requestHash } from './idempotency.ts';
import { lintMigration, loadMigrations } from './migrate.ts';
import { retryDelayMs } from './outbox.ts';
import { isUuid } from './transaction.ts';

describe('canonicalJson / requestHash', () => {
  it('is insensitive to key order and undefined values', () => {
    expect(canonicalJson({ b: 1, a: { d: [1, 2], c: null }, u: undefined })).toBe(
      '{"a":{"c":null,"d":[1,2]},"b":1}',
    );
    expect(requestHash('s', { a: 1, b: 2 })).toBe(requestHash('s', { b: 2, a: 1 }));
  });

  it('differs by scope and payload', () => {
    expect(requestHash('s1', { a: 1 })).not.toBe(requestHash('s2', { a: 1 }));
    expect(requestHash('s', { a: 1 })).not.toBe(requestHash('s', { a: 2 }));
  });
});

describe('lintMigration', () => {
  it('flags destructive and isolation-weakening statements', () => {
    expect(lintMigration('DROP TABLE eventhub.x;')).toEqual(['DROP']);
    expect(lintMigration('ALTER TABLE t DISABLE ROW LEVEL SECURITY;')).toContain(
      'DISABLE ROW LEVEL SECURITY',
    );
    expect(lintMigration('ALTER TABLE t ALTER COLUMN c TYPE bigint;')).toEqual([
      'column type change',
    ]);
  });

  it('flags TRUNCATE statements but not BEFORE TRUNCATE trigger clauses', () => {
    expect(lintMigration('TRUNCATE eventhub.x;')).toEqual(['TRUNCATE']);
    expect(lintMigration('SELECT 1; TRUNCATE eventhub.x;')).toEqual(['TRUNCATE']);
    expect(
      lintMigration(
        'CREATE TRIGGER t BEFORE TRUNCATE ON x FOR EACH STATEMENT EXECUTE FUNCTION f();',
      ),
    ).toEqual([]);
  });

  it('ignores commented-out statements', () => {
    expect(lintMigration('-- DROP TABLE x\nCREATE TABLE y (id int);')).toEqual([]);
  });

  it('accepts an explicit, justified allow marker', () => {
    expect(
      lintMigration(
        '-- eventhub:allow-destructive contract step after ADR-0099 backfill\nDROP TABLE x;',
      ),
    ).toEqual([]);
  });

  it('passes for all committed migrations', async () => {
    for (const m of await loadMigrations()) expect(lintMigration(m.sql)).toEqual([]);
  });
});

describe('loadMigrations', () => {
  it('loads contiguous, checksummed migrations', async () => {
    const ms = await loadMigrations();
    expect(ms[0]?.version).toBe('0001');
    for (const m of ms) expect(m.checksum).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('retryDelayMs', () => {
  it('grows exponentially and is capped', () => {
    const max = () => 0.999999;
    expect(retryDelayMs(1, max)).toBeLessThan(1000);
    expect(retryDelayMs(5, max)).toBeLessThan(16_000);
    expect(retryDelayMs(50, max)).toBeLessThanOrEqual(15 * 60_000);
  });
});

describe('isUuid', () => {
  it('rejects injection-shaped input', () => {
    expect(isUuid("'; DROP TABLE x; --")).toBe(false);
    expect(isUuid('3f1c1f0e-2a7b-4c3d-8e9f-0a1b2c3d4e5f')).toBe(true);
  });
});
