/** The update lease, proven across REAL PROCESSES.
 *
 *  ⛔⛔ WHY THIS EXISTS SEPARATELY FROM `update-lease.test.ts`. That file drives
 *  the module with `currentPid: () => 100` and `() => 200` — two "processes"
 *  inside one. It proves the DECISION LOGIC and cannot prove the thing the lease
 *  is for: that when two operating-system processes reach the claim at the same
 *  instant, exactly one wins. A mutex tested only through injected identities is
 *  a mutex tested only through its own assumptions, and the bug being fixed
 *  (`instance-lock`'s read-then-write `claim`) passes every such test.
 *
 *  So: N children, released together on a barrier, all racing the same file.
 *  The assertion is EXACTLY ONE WINNER — a deterministic property, not a
 *  sampled one, so it is checked on every round rather than as a rate.
 *
 *  🔑 The children import the REAL module (Node type-strips the `.ts`), which is
 *  why `UpdateLeaseHeldError` assigns its field in the constructor body rather
 *  than as a parameter property — that syntax is not erasable and would make the
 *  module unloadable here. */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const LEASE_MODULE = resolve(import.meta.dirname, '../update/update-lease.ts');

describe('update lease — real cross-process exclusion', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'lease-race-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  /** One racer: wait on the barrier, then attempt the claim once. */
  const childSource = (leasePath: string, gate: string, release: string): string => `
import { existsSync } from 'node:fs';
import { acquireUpdateLease, UpdateLeaseHeldError } from ${JSON.stringify(LEASE_MODULE)};
const waitFor = async (path) => {
  while (!existsSync(path)) await new Promise((done) => setTimeout(done, 5));
};
console.log('READY ' + process.pid);
await waitFor(${JSON.stringify(gate)});
try {
  acquireUpdateLease({ leasePath: ${JSON.stringify(leasePath)}, operation: 'apply' });
  console.log('WON ' + process.pid);
} catch (err) {
  console.log((err instanceof UpdateLeaseHeldError ? 'LOST ' : 'ERR ') + process.pid);
}
// Keep the winner alive until EVERY contender has attempted its claim. A
// fixed hold duration can expire before a slower child runs on a busy host.
await waitFor(${JSON.stringify(release)});
`;

  /** Seed a lease held by a pid that cannot be alive, so every racer arrives at
   *  the STALE-RECLAIM path rather than at an empty directory. */
  const seedStaleLease = (leasePath: string): void => {
    // A pid that is not running. 2^22 is above every default pid_max.
    writeFileSync(leasePath, JSON.stringify({
      pid: 4_194_303, operation: 'apply', at: 1, token: 'stale-token',
    }));
  };

  const race = async (n: number, opts: { stale?: boolean } = {}): Promise<string[]> => {
    const leasePath = join(dir, 'recued-update.lock');
    if (opts.stale) seedStaleLease(leasePath);
    const gate = join(dir, 'go');
    const release = join(dir, 'release');
    rmSync(gate, { force: true }); rmSync(release, { force: true });
    const kids = Array.from({ length: n }, (_, i) => {
      const f = join(dir, `racer-${i}.mjs`);
      writeFileSync(f, childSource(leasePath, gate, release));
      const p = spawn(process.execPath, [f], { stdio: ['ignore', 'pipe', 'pipe'] });
      const child = { p, out: '', closed: false, done: Promise.resolve('') };
      p.stdout.on('data', (b) => { child.out += String(b); });
      p.stderr.on('data', (b) => { child.out += String(b); });
      p.on('error', error => { child.out += `ERR ${error.message}`; });
      child.done = new Promise<string>(res => p.once('close', () => {
        child.closed = true;
        res(child.out.split('\n').filter(line => !line.startsWith('READY ')).join('\n').trim());
      }));
      return child;
    });
    const deadline = Date.now() + 40_000;
    const waitFor = async (marker: RegExp) => {
      while (!kids.every(child => marker.test(child.out))) {
        if (kids.some(child => child.closed) || Date.now() >= deadline) {
          throw new Error(`Lease racers did not reach ${marker}: ${kids.map(child => child.out).join(' | ')}`);
        }
        await new Promise(done => setTimeout(done, 10));
      }
    };
    try {
      await waitFor(/^READY /m);
      writeFileSync(gate, '');
      await waitFor(/^(WON|LOST|ERR) /m);
      writeFileSync(release, '');
      return await Promise.all(kids.map(child => child.done));
    } finally {
      for (const child of kids) if (!child.closed) child.p.kill('SIGTERM');
      await Promise.all(kids.map(child => child.done));
    }
  };

  it('⛔⛔ EXACTLY ONE takes it when they all race a STALE lease', async () => {
    // Every other race here starts from an ABSENT lock, so they only exercise the
    // `link`. This one starts from a stale lease, so the racers reach the RECLAIM
    // path — which is where two holders came from.
    //
    // ⚠ AND IT DOES NOT PROVE THE FIX. Measured: this arm passes with and without
    // the guard, because the interleave is far too narrow to hit by scheduling on
    // this machine. It is kept for coverage of the path under real concurrency,
    // NOT as evidence. The proof is the constructed interleave in
    // `update-lease.test.ts` ("does NOT erase a holder that appeared since the
    // staleness was observed"), which fails the moment the guard is removed.
    const results = await race(8, { stale: true });
    const won = results.filter((r) => r.startsWith('WON'));
    expect(results.some((r) => r.startsWith('ERR')), `unexpected: ${results.join(' | ')}`)
      .toBe(false);
    expect(won.length, `winners: ${won.length} of ${results.length}`).toBe(1);
  }, 60_000);

  it('⛔ EXACTLY ONE of eight racing processes takes the lease', async () => {
    const results = await race(8);
    const won = results.filter((r) => r.startsWith('WON'));
    const lost = results.filter((r) => r.startsWith('LOST'));
    expect(results.some((r) => r.startsWith('ERR')), `unexpected error: ${results.join(' | ')}`)
      .toBe(false);
    expect(won.length, `winners: ${won.length}, losers: ${lost.length}`).toBe(1);
    expect(lost.length).toBe(7);
  }, 60_000);

  it('and again — the property holds per round, it is not a coin flip', async () => {
    // Deterministic, so it is asserted on every round rather than as a rate.
    for (let round = 0; round < 2; round += 1) {
      rmSync(join(dir, 'go'), { force: true });
      rmSync(join(dir, 'recued-update.lock'), { force: true });
      const results = await race(4);
      expect(results.filter((r) => r.startsWith('WON')).length, `round ${round}`).toBe(1);
    }
  }, 90_000);

  it('the file is gone once the winner releases, so the next caller can take it', async () => {
    const leasePath = join(dir, 'recued-update.lock');
    const { acquireUpdateLease } = await import('../update/update-lease.js');
    const lease = acquireUpdateLease({ leasePath, operation: 'apply' });
    expect(existsSync(leasePath)).toBe(true);
    lease.release();
    expect(existsSync(leasePath)).toBe(false);
  });
});

describe('the mid-claim window — deterministic, not timing-dependent', () => {
  /** ⛔⛔ THIS IS THE ARM THAT ACTUALLY CATCHES IT, and the racing one is not.
   *
   *  The lease shipped with `open('wx')` then a separate write, so it was briefly
   *  visible EMPTY. A second process arriving in that window read it as corrupt,
   *  took the reclaim-an-illegible-lease path, unlinked the WINNER'S file and
   *  claimed its own — two holders.
   *
   *  The racing test above did not find it here: 12 consecutive local runs, 0
   *  failures. It was reported from a machine whose timing differed, as 3 winners
   *  out of 8. A race whose outcome depends on the host is evidence when it
   *  FAILS and nothing at all when it passes, so the window is pinned directly
   *  instead: one process is simply held between the create and the write, with
   *  no scheduling involved. */
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'lease-window-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('a second caller cannot claim while another is mid-claim', async () => {
    const { acquireUpdateLease, UpdateLeaseHeldError } =
      await import('../update/update-lease.js');
    const leasePath = join(dir, 'recued-update.lock');

    // Stand in for "process A has created the path but not finished writing":
    // the only way that state can exist now is a foreign/partial file, and the
    // rule is the same — never delete it on a guess.
    writeFileSync(leasePath, '');

    expect(
      () => acquireUpdateLease({
        leasePath, operation: 'apply', currentPid: () => 999_999, isAlive: () => true,
      }),
      'an incomplete lease must refuse, not reclaim',
    ).toThrow(UpdateLeaseHeldError);
    expect(existsSync(leasePath), 'and must not be deleted').toBe(true);
  });

  it('whatever exists at the lease path always parses', async () => {
    const { acquireUpdateLease } = await import('../update/update-lease.js');
    const leasePath = join(dir, 'recued-update.lock');
    const lease = acquireUpdateLease({ leasePath, operation: 'apply' });
    expect(() => JSON.parse(readFileSync(leasePath, 'utf-8'))).not.toThrow();
    lease.release();
  });
});
