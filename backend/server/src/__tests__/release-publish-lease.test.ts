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

const releaseArgs = (token: string, etag: string) => [
  LEASE,
  'release',
  '--bucket', 'test-bucket',
  '--key', '.release-publish.lock',
  '--token', token,
  '--etag', etag,
];

/** The lock as it sits on disk, so an arm can assert the STATE transition
 *  rather than only the exit code. */
/** The store root a fixture's env points at, so an arm can read the lock back. */
const root = (env: NodeJS.ProcessEnv): string => env.RECUED_TEST_R2_STORE as string;

const lockState = (root: string): string => JSON.parse(
  readFileSync(join(root, 'test-bucket', '.release-publish.lock'), 'utf8'),
).state;

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
    // ⚠ NAME THE CONJUNCT. This used to assert `ownership changed`, which every
    // release refusal printed. The displaced owner is rejected because somebody
    // ELSE holds the lock — not because its etag moved — and only the specific
    // message distinguishes those two, which is the whole reason for the split.
    expect(staleRelease.stderr).toMatch(/held by a DIFFERENT owner/);

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
    // ⚠ A GENUINE RACE HAS TWO LOSING SHAPES, and after the message split each
    // says which: the loser either GETs before the winner's write and has its
    // own conditional write refused, or GETs after and finds a different owner.
    // The alternation is the race, not a vague assertion — but it must no longer
    // accept the ABSENT or ALREADY-RELEASED wordings, which mean something else.
    expect(losers[0].stderr).toMatch(/REFUSED the conditional write|held by a DIFFERENT owner|another release publisher owns/);
    expect(losers[0].stderr).not.toMatch(/is ABSENT|already RELEASED/);

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


  // ⛔⛔ THE ARM THAT WAS MISSING WHEN 26.9.2 SHIPPED. The release path had no
  // end-to-end coverage at all, and the double could not have expressed the
  // defect anyway: `testRead` and `testConditionalPut` both derive their tag
  // from `etagOf`, so one spelling answered both sides. Production met two.
  //
  // 🔑 The skew is the whole point. `RECUED_TEST_R2_ETAG_SKEW` makes the READ
  // answer a different — equally valid — spelling of the SAME tag than the
  // WRITE did, which is exactly what left 26.9.2's lock stuck `active` after a
  // successful publish: object untouched, state active, token correct, and the
  // verbatim etag comparison reading it as somebody else's lock.
  it.each([
    ['no skew — the baseline', ''],
    ['a WEAK validator on read', 'weak'],
    ['a BARE unquoted tag on read', 'unquoted'],
  ])('releases a lease it owns when the store answers %s', (_label, skew) => {
    const { root, env } = fixture();
    const acquired = spawnSync(process.execPath, acquireArgs('publisher-a'), { env, encoding: 'utf8' });
    expect(acquired.status, acquired.stderr).toBe(0);
    const { etag } = JSON.parse(acquired.stdout) as { etag: string };
    expect(lockState(root)).toBe('active');

    const released = spawnSync(
      process.execPath,
      releaseArgs('publisher-a', etag),
      { env: { ...env, RECUED_TEST_R2_ETAG_SKEW: skew }, encoding: 'utf8' },
    );
    expect(released.status, released.stderr).toBe(0);
    expect(lockState(root)).toBe('released');
  });

  // ⚠ AND THE NORMALISATION MUST NOT FAIL OPEN. Comparing tags by their opaque
  // value rather than their spelling is not the same as comparing them loosely:
  // a DIFFERENT representation must still refuse, or the lock stops being one.
  it.each([
    // ⚠ EACH CASE CARRIES THE MESSAGE IT SHOULD PRODUCE. A shared alternation
    // would pass on any refusal and so could not tell a moved generation from a
    // missing argument — the ambiguity this split exists to remove.
    ['a different etag entirely', '"0000000000000000000000000000beef"', /object generation moved/],
    ['the same shape, one hex digit apart', null, /object generation moved/],
    // ⚠ `'""'` IS PRESENT BUT UNUSABLE, NOT MISSING. It is a two-character
    // string, so the required-argument check passes; normalising strips the
    // quotes to empty, and an empty validator never matches — fail-closed. So it
    // reaches the generation conjunct rather than the usage error, which is the
    // correct refusal for an argument that identifies no object.
    ['a present but unusable empty etag', '""', /object generation moved/],
  ])('still refuses to release against %s', (_label, override, expected) => {
    const { root, env } = fixture();
    const acquired = spawnSync(process.execPath, acquireArgs('publisher-a'), { env, encoding: 'utf8' });
    expect(acquired.status, acquired.stderr).toBe(0);
    const { etag } = JSON.parse(acquired.stdout) as { etag: string };
    // One hex digit apart proves the comparison reads the VALUE, not the length
    // or the quoting — the failure mode a sloppy normaliser would introduce.
    const wrong = override ?? `"${etag.replace(/"/g, '').replace(/.$/, (c) => (c === 'a' ? 'b' : 'a'))}"`;

    const released = spawnSync(
      process.execPath,
      releaseArgs('publisher-a', wrong),
      { env, encoding: 'utf8' },
    );
    expect(released.status).not.toBe(0);
    expect(released.stderr).toMatch(expected);
    // ⛔ THE EVIDENCE SURVIVES A REFUSED RELEASE — a lock that refused to
    // release is still held, not silently dropped.
    expect(lockState(root)).toBe('active');
  });


  // ⛔⛔ THE THREE SITUATIONS THAT USED TO SHARE ONE SENTENCE. A takeover can be
  // refused because the lock is gone, because it is already released, or because
  // the store declined the conditional write — three different actions, and for
  // one release they were indistinguishable. The third is what actually blocked
  // 26.9.3 while the message pointed at a stale inspection.
  it('a takeover against an ABSENT lock says so, and says to drop the flag', () => {
    const { env } = fixture();
    const result = spawnSync(
      process.execPath,
      acquireArgs('publisher-a', '--break-token', 'a-token-nobody-holds'),
      { env, encoding: 'utf8' },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/is ABSENT/);
    expect(result.stderr).toMatch(/WITHOUT --break-release-lease/);
    // ⚠ It must not read as a stale-token or changed-object problem: those call
    // for inspecting another operator, this calls for dropping a flag.
    expect(result.stderr).not.toMatch(/REFUSED the conditional write/);
    expect(result.stderr).not.toMatch(/already RELEASED/);
  });

  it('a takeover against an ALREADY-RELEASED lock says so, and names its token', () => {
    const { env } = fixture();
    const acquired = spawnSync(process.execPath, acquireArgs('publisher-a'), { env, encoding: 'utf8' });
    expect(acquired.status, acquired.stderr).toBe(0);
    const { etag } = JSON.parse(acquired.stdout) as { etag: string };
    const released = spawnSync(process.execPath, releaseArgs('publisher-a', etag), { env, encoding: 'utf8' });
    expect(released.status, released.stderr).toBe(0);

    const takeover = spawnSync(
      process.execPath,
      acquireArgs('publisher-b', '--break-token', 'publisher-a'),
      { env, encoding: 'utf8' },
    );
    expect(takeover.status).not.toBe(0);
    expect(takeover.stderr).toMatch(/already RELEASED/);
    expect(takeover.stderr).toMatch(/publisher-a/);
    expect(takeover.stderr).not.toMatch(/is ABSENT/);
  });

  it('a plain acquire DOES claim a released lock — which is why the flag is wrong there', () => {
    // The refusals above are only helpful if the advice they give works.
    const { env } = fixture();
    const first = spawnSync(process.execPath, acquireArgs('publisher-a'), { env, encoding: 'utf8' });
    const { etag } = JSON.parse(first.stdout) as { etag: string };
    spawnSync(process.execPath, releaseArgs('publisher-a', etag), { env, encoding: 'utf8' });

    const second = spawnSync(process.execPath, acquireArgs('publisher-b'), { env, encoding: 'utf8' });
    expect(second.status, second.stderr).toBe(0);
    expect(lockState(root(env))).toBe('active');
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
