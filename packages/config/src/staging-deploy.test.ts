import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { databaseTransport, loadApiConfig, loadMigratorConfig, loadWorkerConfig } from './index.ts';

/**
 * The staging deployment scripts (scripts/staging, ADR-0059), run against a stand-in `gcloud`
 * that records every call and keeps "Secret Manager" in a directory. This proves what can be
 * proven without a Google project: no secret reaches a command line or the screen, the settings
 * the services are given are ones the services accept in staging mode, and each service account
 * may read exactly the secrets it is given. It cannot prove that Google accepts the commands.
 */
const ROOT = join(import.meta.dirname, '../../..');
const SCRIPTS = join(ROOT, 'scripts/staging');
const ADMIN_PASSWORD = `p@ss/w:rd %x?#&=+ ${'m'.repeat(12)}`;
const RESEND_KEY = `marker-${'r'.repeat(32)}`;
const SEP = '\u001f';

const FAKE_GCLOUD = `#!/usr/bin/env bash
set -euo pipefail
{ printf '%s${SEP}' "$@"; printf '\\n'; } >> "$FAKE_DIR/calls.log"
shift 3 # --project <id> --quiet
store="$FAKE_DIR/secrets"
flag() { local f; for f in "$@"; do case "$f" in --secret=*) echo "\${f#--secret=}";; esac; done; }
case "$1 $2 \${3:-}" in
  "secrets describe "*) [[ -f "$store/$3" ]] ;;
  "secrets create "*) cat > "$store/$3" ;;
  "secrets versions add") cat > "$store/$4" ;;
  "secrets versions access") cat "$store/$(flag "$@")" ;;
  "iam service-accounts describe") exit 1 ;;
  "run services describe") echo "https://eventhub-api-abc123-as.a.run.app" ;;
  *) : ;;
esac
`;

interface Run {
  status: number;
  output: string;
}
let dir: string;
const calls = () =>
  readFileSync(join(dir, 'calls.log'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split(SEP).slice(0, -1));
const secret = (name: string) => readFileSync(join(dir, 'secrets', name), 'utf8');
const secretNames = () => readdirSync(join(dir, 'secrets')).sort();

function run(script: string, env: Record<string, string> = {}, input = ''): Run {
  const result = spawnSync('bash', [join(SCRIPTS, script)], {
    cwd: ROOT,
    input,
    encoding: 'utf8',
    env: {
      PATH: `${join(dir, 'bin')}:${process.env.PATH}`,
      FAKE_DIR: dir,
      EVENTHUB_IMAGE_TAG: 'staging-test-tag',
      ...env,
    },
  });
  return { status: result.status ?? -1, output: `${result.stdout}${result.stderr}` };
}

/** The settings one deploy call gives a service: plain values, and secrets resolved. */
function settings(call: string[]): { env: Record<string, string>; secrets: string[] } {
  const value = (flag: string) =>
    call.find((a) => a.startsWith(`${flag}=`))?.slice(flag.length + 1);
  const env: Record<string, string> = {};
  const plain = value('--set-env-vars') ?? '';
  const pairs = plain.startsWith('^|^') ? plain.slice(3).split('|') : plain.split(',');
  for (const pair of pairs.filter(Boolean)) {
    env[pair.slice(0, pair.indexOf('='))] = pair.slice(pair.indexOf('=') + 1);
  }
  const secrets: string[] = [];
  for (const pair of (value('--set-secrets') ?? '').split(',').filter(Boolean)) {
    const [name, ref] = pair.split('=') as [string, string];
    expect(ref.endsWith(':latest'), pair).toBe(true);
    const secretName = ref.slice(0, -':latest'.length);
    env[name] = secret(secretName);
    secrets.push(secretName);
  }
  return { env, secrets: secrets.sort() };
}
const deploy = (...words: string[]) => {
  const found = calls().filter((c) => words.every((w, i) => c[3 + i] === w));
  expect(found.length, words.join(' ')).toBeGreaterThan(0);
  return found.at(-1)!;
};
/** Which secrets each service account was allowed to read. */
function grants(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const c of calls().filter((x) => x[3] === 'secrets' && x[4] === 'add-iam-policy-binding')) {
    const who = /eventhub-(\w+)@/.exec(c.find((a) => a.startsWith('--member='))!)![1]!;
    expect(c).toContain('--role=roles/secretmanager.secretAccessor');
    (out[who] ??= []).push(c[5]!);
  }
  for (const who of Object.keys(out)) out[who] = [...new Set(out[who])].sort();
  return out;
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'eventhub-staging-'));
  mkdirSync(join(dir, 'bin'));
  mkdirSync(join(dir, 'secrets'));
  writeFileSync(join(dir, 'bin/gcloud'), FAKE_GCLOUD);
  chmodSync(join(dir, 'bin/gcloud'), 0o755);
  writeFileSync(join(dir, 'calls.log'), '');
});

describe('staging deployment scripts (ADR-0059)', () => {
  let first: Run;
  let generated: Record<string, string>;

  it('01-secrets creates every secret without printing or passing a value', () => {
    first = run('01-secrets.sh', {}, `${ADMIN_PASSWORD}\n${RESEND_KEY}\n`);
    expect(first.status, first.output).toBe(0);
    expect(secretNames()).toEqual([
      'database-admin-url',
      'database-app-url',
      'database-migrator-url',
      'database-worker-url',
      'db-app-password',
      'db-migrator-password',
      'db-worker-password',
      'email-token-secret',
      'mfa-encryption-key',
      'resend-api-key',
      'visitor-address-key',
    ]);
    generated = Object.fromEntries(secretNames().map((n) => [n, secret(n)]));
    const everywhere = `${first.output}\n${readFileSync(join(dir, 'calls.log'), 'utf8')}`;
    for (const [name, value] of Object.entries(generated)) {
      expect(value.length, name).toBeGreaterThanOrEqual(32);
      expect(everywhere.includes(value), `${name} leaked`).toBe(false);
    }
    for (const role of ['app', 'migrator', 'worker']) {
      expect(everywhere).not.toContain(generated[`db-${role}-password`]);
    }
    expect(everywhere).not.toContain(ADMIN_PASSWORD);
    expect(everywhere).not.toContain(encodeURIComponent(ADMIN_PASSWORD));
    expect(everywhere).not.toContain(RESEND_KEY);
  });

  it('every database URL is the accepted Cloud SQL socket form, with its own password', () => {
    for (const role of ['app', 'migrator', 'worker']) {
      const url = generated[`database-${role}-url`]!;
      expect(databaseTransport(url), role).toBe('cloud_sql_socket');
      const parsed = new URL(url);
      expect(parsed.username).toBe(`eventhub_${role}`);
      expect(decodeURIComponent(parsed.password)).toBe(generated[`db-${role}-password`]);
      expect(parsed.searchParams.get('host')).toBe(
        '/cloudsql/event-hub-2b58e:asia-southeast1:eventhub-staging',
      );
      expect(parsed.pathname).toBe('/eventhub');
    }
    const passwords = ['app', 'migrator', 'worker'].map((r) => generated[`db-${r}-password`]);
    expect(new Set(passwords).size).toBe(3);
    // The bootstrap refuses role passwords shorter than 24 characters.
    for (const p of passwords) expect(p).toMatch(/^[0-9a-f]{48}$/);
  });

  it('a typed password with special characters survives into the admin URL', () => {
    const url = generated['database-admin-url']!;
    expect(databaseTransport(url)).toBe('cloud_sql_socket');
    expect(decodeURIComponent(new URL(url).password)).toBe(ADMIN_PASSWORD);
    expect(new URL(url).username).toBe('postgres');
    expect(generated['resend-api-key']).toBe(RESEND_KEY);
    expect(Buffer.from(generated['mfa-encryption-key']!, 'base64')).toHaveLength(32);
  });

  it('running 01-secrets again keeps every secret and asks for nothing', () => {
    const again = run('01-secrets.sh');
    expect(again.status, again.output).toBe(0);
    expect(again.output).not.toContain('typing is hidden');
    for (const name of secretNames()) expect(secret(name), name).toBe(generated[name]);
  });

  it('the database jobs get exactly what the bootstrap and migration need', () => {
    const result = run('03-database.sh');
    expect(result.status, result.output).toBe(0);

    const bootstrap = deploy('run', 'jobs', 'deploy', 'eventhub-bootstrap');
    expect(bootstrap).toContain('--args=packages/db/src/cli/bootstrap.ts');
    expect(Object.keys(settings(bootstrap).env).sort()).toEqual([
      'DATABASE_ADMIN_URL',
      'EVENTHUB_APP_PASSWORD',
      'EVENTHUB_MIGRATOR_PASSWORD',
      'EVENTHUB_WORKER_PASSWORD',
    ]);
    expect(settings(bootstrap).env.EVENTHUB_APP_PASSWORD).toBe(generated['db-app-password']);

    const migrate = deploy('run', 'jobs', 'deploy', 'eventhub-migrate');
    expect(migrate).toContain('--args=packages/db/src/cli/migrate.ts');
    const config = loadMigratorConfig(settings(migrate).env);
    expect(config.environment).toBe('staging');
    expect(config.database.migratorUrl).toBe(generated['database-migrator-url']);

    for (const job of [bootstrap, migrate]) {
      expect(job).toContain(
        '--set-cloudsql-instances=event-hub-2b58e:asia-southeast1:eventhub-staging',
      );
      expect(job).toContain(
        '--service-account=eventhub-jobs@event-hub-2b58e.iam.gserviceaccount.com',
      );
      expect(job.find((a) => a.startsWith('--image='))).toBe(
        '--image=asia-southeast1-docker.pkg.dev/event-hub-2b58e/eventhub/api:staging-test-tag',
      );
    }
    // The roles exist before the migrations run.
    const executed = calls()
      .filter((c) => c[3] === 'run' && c[4] === 'jobs' && c[5] === 'execute')
      .map((c) => c[6]);
    expect(executed).toEqual(['eventhub-bootstrap', 'eventhub-migrate']);
    expect(result.output).not.toContain(generated['db-app-password']);
  });

  const SERVICE_ENV = {
    ADMIN_ORIGIN: 'https://admin.example.com',
    SITE_DOMAIN: 'events.example.com',
    EMAIL_FROM: 'EventHub, Staging <no-reply@mail.example.com>',
  };

  it('the API and worker are given settings they accept in staging mode', () => {
    const result = run('04-services.sh', SERVICE_ENV);
    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain('https://eventhub-api-abc123-as.a.run.app');

    const api = deploy('run', 'deploy', 'eventhub-api');
    const apiConfig = loadApiConfig(settings(api).env);
    expect(apiConfig.environment).toBe('staging');
    expect(apiConfig.visitorAddressKey).toBe(generated['visitor-address-key']);
    expect(apiConfig.http.trustProxy).toBe(false);
    expect(settings(api).env.PASSKEY_ORIGIN).toBe('https://admin.example.com');
    expect(settings(api).env.GCS_BUCKET).toBe('event-hub-2b58e-images-staging');
    expect(api).toContain('--allow-unauthenticated');
    expect(api).toContain(
      '--add-cloudsql-instances=event-hub-2b58e:asia-southeast1:eventhub-staging',
    );

    const worker = deploy('run', 'worker-pools', 'deploy', 'eventhub-worker');
    const workerEnv = settings(worker).env;
    const workerConfig = loadWorkerConfig(workerEnv);
    expect(workerConfig.environment).toBe('staging');
    // A sender name with a comma and spaces arrives whole.
    expect(workerEnv.EMAIL_FROM).toBe(SERVICE_ENV.EMAIL_FROM);
    expect(workerEnv.APP_BASE_URL).toBe('https://admin.example.com');
    expect(workerEnv.PUBLIC_SITE_URL).toBe('https://{handle}.events.example.com');
    expect(worker.find((a) => a.startsWith('--image='))).toContain('/worker:staging-test-tag');

    const everywhere = `${result.output}\n${readFileSync(join(dir, 'calls.log'), 'utf8')}`;
    for (const [name, value] of Object.entries(generated)) {
      expect(everywhere.includes(value), `${name} leaked`).toBe(false);
    }
  });

  it('each service account may read exactly the secrets it is given', () => {
    const api = settings(deploy('run', 'deploy', 'eventhub-api')).secrets;
    const worker = settings(deploy('run', 'worker-pools', 'deploy', 'eventhub-worker')).secrets;
    const jobs = [
      ...settings(deploy('run', 'jobs', 'deploy', 'eventhub-bootstrap')).secrets,
      ...settings(deploy('run', 'jobs', 'deploy', 'eventhub-migrate')).secrets,
    ].sort();
    expect(grants()).toEqual({ api, worker, jobs });
    // No service holds another's database credentials.
    expect(api).not.toContain('database-admin-url');
    expect(worker.filter((s) => s.startsWith('database-'))).toEqual(['database-worker-url']);
    expect(api.filter((s) => s.startsWith('database-'))).toEqual(['database-app-url']);
  });

  it('04-services refuses a non-https admin address, and a missing email key', () => {
    const before = calls().length;
    const http = run('04-services.sh', {
      ...SERVICE_ENV,
      ADMIN_ORIGIN: 'http://admin.example.com',
    });
    expect(http.status).not.toBe(0);
    expect(http.output).toContain('ADMIN_ORIGIN');
    const missing = run('04-services.sh', { ...SERVICE_ENV, SITE_DOMAIN: '' });
    expect(missing.status).not.toBe(0);
    expect(missing.output).toContain('SITE_DOMAIN');
    expect(calls().filter((c) => c[4] === 'deploy' || c[5] === 'deploy')).toHaveLength(
      calls()
        .slice(0, before)
        .filter((c) => c[4] === 'deploy' || c[5] === 'deploy').length,
    );

    const empty = mkdtempSync(join(tmpdir(), 'eventhub-staging-empty-'));
    mkdirSync(join(empty, 'secrets'));
    writeFileSync(join(empty, 'calls.log'), '');
    const noKey = run('04-services.sh', { ...SERVICE_ENV, FAKE_DIR: empty });
    expect(noKey.status).not.toBe(0);
    expect(noKey.output).toContain('01-secrets.sh');
    expect(readFileSync(join(empty, 'calls.log'), 'utf8')).not.toContain('deploy');
  });

  it('skipping the email key leaves it unset and says what that blocks', () => {
    const fresh = mkdtempSync(join(tmpdir(), 'eventhub-staging-skip-'));
    mkdirSync(join(fresh, 'secrets'));
    writeFileSync(join(fresh, 'calls.log'), '');
    const result = run('01-secrets.sh', { FAKE_DIR: fresh }, `${ADMIN_PASSWORD}\n\n`);
    expect(result.status, result.output).toBe(0);
    expect(existsSync(join(fresh, 'secrets/resend-api-key'))).toBe(false);
    expect(result.output).toContain('worker cannot be deployed');
    const blank = mkdtempSync(join(tmpdir(), 'eventhub-staging-blank-'));
    mkdirSync(join(blank, 'secrets'));
    writeFileSync(join(blank, 'calls.log'), '');
    const noPassword = run('01-secrets.sh', { FAKE_DIR: blank }, '\n');
    expect(noPassword.status).not.toBe(0);
    expect(noPassword.output).toContain('no password entered');
    expect(existsSync(join(blank, 'secrets/database-admin-url'))).toBe(false);
  });

  it('the Cloud Build file builds and pushes the same four Dockerfile targets', () => {
    const build = readFileSync(join(ROOT, 'cloudbuild.yaml'), 'utf8');
    const dockerfile = readFileSync(join(ROOT, 'Dockerfile'), 'utf8');
    for (const target of ['api', 'worker', 'admin', 'site']) {
      expect(dockerfile).toMatch(new RegExp(`^FROM runtime AS ${target}$`, 'm'));
      expect(build).toContain(
        `args: [build, --target, ${target}, -t, '\${_REGISTRY}/${target}:\${_TAG}', .]`,
      );
      expect(build).toContain(`  - '\${_REGISTRY}/${target}:\${_TAG}'`);
    }
    expect(build).toContain('DOCKER_BUILDKIT=1');
  });

  it('the scripts are valid bash', () => {
    for (const file of readdirSync(SCRIPTS).filter((f) => f.endsWith('.sh'))) {
      execFileSync('bash', ['-n', join(SCRIPTS, file)]);
    }
  });
});
