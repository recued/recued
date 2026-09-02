import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const LEASE = resolve(__dirname, '..', '..', 'scripts', 'release-publish-lease.mjs');
const roots: string[] = [];

const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), 'recued-release-lease-'));
  roots.push(root);
  return {
    root,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      RECUED_TEST_R2_STORE: root,
    },
  };
};

const acquireArgs = (token: string, ...extra: string[]) => [
  LEASE,
  'acquire',
  '--bucket', 'test-bucket',
  '--key', '.release-publish.lock',
  '--token', token,
  '--version', '26.9.1.1',
  '--sequence', '42',
  ...extra,
];

const runAsync = (args: string[], env: NodeJS.ProcessEnv) => new Promise<{
  status: number | null;
  stdout: string;
  stderr: string;
}>((resolveResult) => {
  const child = spawn(process.execPath, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
  child.on('close', (status) => resolveResult({ status, stdout, stderr }));
});

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('distributed R2 release publication lease', () => {
  it('grants exactly one publisher when two acquire the missing key concurrently', async () => {
    const { env } = fixture();
    const results = await Promise.all([
      runAsync(acquireArgs('publisher-a'), env),
      runAsync(acquireArgs('publisher-b'), env),
    ]);

    const winners = results.filter((result) => result.status === 0);
    const losers = results.filter((result) => result.status !== 0);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(losers[0].stderr).toMatch(/another release publisher owns/);

    const receipt = JSON.parse(winners[0].stdout) as { token: string; etag: string };
    const released = spawnSync(process.execPath, [
      LEASE,
      'release',
      '--bucket', 'test-bucket',
      '--key', '.release-publish.lock',
      '--token', receipt.token,
      '--etag', receipt.etag,
    ], { env, encoding: 'utf8' });
    expect(released.status).toBe(0);
  });

  it('requires explicit conditional takeover and rejects the displaced owner', () => {
    const { env } = fixture();
    const first = spawnSync(process.execPath, acquireArgs('publisher-a'), { env, encoding: 'utf8' });
    expect(first.status).toBe(0);
    const firstReceipt = JSON.parse(first.stdout) as { etag: string };

    const takeover = spawnSync(
      process.execPath,
      acquireArgs('publisher-b', '--break-token', 'publisher-a'),
      { env, encoding: 'utf8' },
    );
    expect(takeover.status).toBe(0);
    const takeoverReceipt = JSON.parse(takeover.stdout) as { etag: string };

    const staleRelease = spawnSync(process.execPath, [
      LEASE,
      'release',
      '--bucket', 'test-bucket',
      '--key', '.release-publish.lock',
      '--token', 'publisher-a',
      '--etag', firstReceipt.etag,
    ], { env, encoding: 'utf8' });
    expect(staleRelease.status).not.toBe(0);
    expect(staleRelease.stderr).toMatch(/ownership changed/);

    const currentRelease = spawnSync(process.execPath, [
      LEASE,
      'release',
      '--bucket', 'test-bucket',
      '--key', '.release-publish.lock',
      '--token', 'publisher-b',
      '--etag', takeoverReceipt.etag,
    ], { env, encoding: 'utf8' });
    expect(currentRelease.status).toBe(0);

    const next = spawnSync(process.execPath, acquireArgs('publisher-c'), { env, encoding: 'utf8' });
    expect(next.status).toBe(0);
  });

  it('lets only one concurrent recovery take over the exact stale ETag', async () => {
    const { env } = fixture();
    const stale = spawnSync(process.execPath, acquireArgs('stale-publisher'), { env, encoding: 'utf8' });
    expect(stale.status).toBe(0);

    const recoveries = await Promise.all([
      runAsync(acquireArgs('recovery-a', '--break-token', 'stale-publisher'), env),
      runAsync(acquireArgs('recovery-b', '--break-token', 'stale-publisher'), env),
    ]);
    const winners = recoveries.filter((result) => result.status === 0);
    const losers = recoveries.filter((result) => result.status !== 0);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(losers[0].stderr).toMatch(/changed during takeover|another release publisher owns/);

    const receipt = JSON.parse(winners[0].stdout) as { token: string; etag: string };
    const released = spawnSync(process.execPath, [
      LEASE,
      'release',
      '--bucket', 'test-bucket',
      '--key', '.release-publish.lock',
      '--token', receipt.token,
      '--etag', receipt.etag,
    ], { env, encoding: 'utf8' });
    expect(released.status).toBe(0);
  });

  it('never lets a stale recovery token steal a replacement publisher', () => {
    const { env } = fixture();
    const stale = spawnSync(process.execPath, acquireArgs('stale-publisher'), { env, encoding: 'utf8' });
    expect(stale.status).toBe(0);

    const winner = spawnSync(
      process.execPath,
      acquireArgs('recovery-a', '--break-token', 'stale-publisher'),
      { env, encoding: 'utf8' },
    );
    expect(winner.status).toBe(0);

    const late = spawnSync(
      process.execPath,
      acquireArgs('recovery-b', '--break-token', 'stale-publisher'),
      { env, encoding: 'utf8' },
    );
    expect(late.status).not.toBe(0);
    expect(late.stderr).toMatch(/another release publisher owns/);

    const lock = JSON.parse(readFileSync(
      join(env.RECUED_TEST_R2_STORE!, 'test-bucket', '.release-publish.lock'),
      'utf8',
    )) as { token: string };
    expect(lock.token).toBe('recovery-a');
  });

  it('refuses malformed lock metadata without overwriting the evidence', () => {
    const { root, env } = fixture();
    const lock = join(root, 'test-bucket', '.release-publish.lock');
    mkdirSync(join(root, 'test-bucket'), { recursive: true });
    const malformed = '{"schema":1,"state":"released"}\n';
    writeFileSync(lock, malformed);

    const result = spawnSync(process.execPath, acquireArgs('publisher-a'), { env, encoding: 'utf8' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/malformed.*refusing to overwrite/);
    expect(readFileSync(lock, 'utf8')).toBe(malformed);
  });
});
