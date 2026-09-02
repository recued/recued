/** ⛔⛔ WHO HAS TO RUN THE APPLY'S COMMIT CALLBACK — the ratchet for the
 *  snapshot-timing finding, and the sibling of `update-restore-callers.test.ts`.
 *
 *  `runApply` no longer performs the snapshot + swap itself. It hands them to
 *  `requestRestart(onDrained)`, because the only moment a live server has stopped
 *  accepting writes is after its restart drain's `close_db` step — a snapshot
 *  taken before that excluded every write the old release accepted in between,
 *  and a rollback then discarded them while telling the owner it was only losing
 *  post-update writes.
 *
 *  🔑 THE FAILURE MODE OF THIS DESIGN IS SILENCE, WHICH IS WHY IT NEEDS A
 *  RATCHET. A `requestRestart` that ignores its callback compiles, type-checks,
 *  and returns `restarting` — and stages nothing at all. That is WORSE than the
 *  bug it replaced, and it is invisible: the rpc answered, the ledger holds an
 *  `apply_started`, and the server comes back on the release it was already
 *  running. The two production wirings are pinned here so dropping the argument
 *  is a red test rather than an update that quietly never happens.
 *
 *  ⚠ A GREP IS THE WRONG PROOF FOR BEHAVIOUR, and this is deliberately not the
 *  only proof: `apply-orchestrator.test.ts` drives the commit and the incomplete
 *  drain, and `update-cli-profile.test.ts` proves the REAL CLI port invokes it.
 *  This file guards the one thing those cannot see — a wiring nobody drives. */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = resolve(import.meta.dirname, '..');

/** Production wirings of the `requestRestart` port, and how each one satisfies
 *  the callback contract. A new entry needs a real answer in this column. */
const WIRINGS = new Map<string, { must: RegExp; why: string }>([
  ['serve/compose-listeners.ts', {
    must: /requestRestart:\s*\(onDrained\)\s*=>\s*\n?\s*bootstrapDeps\?\.onRestartRequested\?\.\([^)]*onDrained\)/,
    why: 'forwards it to the lifecycle drain, which awaits it after `close_db`',
  }],
  ['cli-context/update.ts', {
    // ⚠ PIN THE PROPERTY, NOT THE ARGUMENT. This matched `onDrained?.(true)`
    // literally and went red the moment that wiring learned to answer `false`
    // when a server appeared mid-download — a CORRECT change reported as a
    // missing callback. What must not lapse is that the callback is passed on at
    // all; what it decides is that caller's business and has its own test.
    must: /requestRestart:\s*\(onDrained\)\s*=>\s*\{[\s\S]*?onDrained\?\.\(/,
    why: 'runs it inline — the CLI is its own quiescence and has no drain to wait for',
  }],
  ['update/release-config.ts', {
    must: /requestRestart:\s*opts\.requestRestart/,
    why: 'passes the caller\'s port straight through, unchanged',
  }],
]);

describe('the apply commit runs inside the restart drain', () => {
  it('finds the wirings at all (the sweep itself works)', () => {
    // ⛔ A POSITIVE CONTROL. A moved file would make every assertion below pass
    // over an empty set.
    for (const file of WIRINGS.keys()) {
      expect(readFileSync(join(SRC, file), 'utf-8')).toContain('requestRestart');
    }
  });

  it('every wiring passes the callback on, so the commit actually happens', () => {
    for (const [file, { must, why }] of WIRINGS) {
      const src = readFileSync(join(SRC, file), 'utf-8');
      expect(
        must.test(src),
        `${file} wires \`requestRestart\` without passing its \`onDrained\` callback on. `
        + `runApply hands the snapshot + binary swap to that callback; a wiring that drops it `
        + `stages NOTHING and reports \`restarting\` anyway. This one is supposed to: ${why}.`,
      ).toBe(true);
    }
  });

  it('the orchestrator still hands the commit to the restart, not to itself', () => {
    // The narrow behaviour the wiring sweep cannot see: that `runApply` is still
    // the one deferring. If the snapshot moved back above `requestRestart`, every
    // wiring above would keep passing while the data loss returned.
    const src = readFileSync(join(SRC, 'update/apply-orchestrator.ts'), 'utf-8');
    const commitAt = src.indexOf('const commitStagedRelease');
    const snapshotAt = src.indexOf('await ports.takeSnapshot()');
    const swapAt = src.indexOf('ports.preserveAndSwap(swapSidecar)');
    expect(commitAt).toBeGreaterThan(-1);
    expect(snapshotAt).toBeGreaterThan(commitAt);
    expect(swapAt).toBeGreaterThan(commitAt);
  });
});
