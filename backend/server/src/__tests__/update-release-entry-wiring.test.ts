/** D-178 — who gets a periodic release task at all.
 *
 *  This file exists because the answer was wrong and nothing could see it. The
 *  registry entry used to be published only when `applyDeps` existed, and
 *  `buildApplyOrchestratorDeps` returns undefined for `docker-baked` and
 *  `source`. Those are exactly the two channels whose DEFAULT update mode is
 *  `notify` — so the installs that opted into being told about releases were
 *  the installs with nothing that ever looked. The decision lived inline in
 *  `composeListeners`, unreachable, and every test in the suite stayed green.
 *
 *  The claim under test is a shape, not a fetch: an entry exists, and its apply
 *  half is present exactly when the channel has one.
 */

import { describe, expect, it, vi } from 'vitest';
import type { UpdateApplyDeps } from '../update-handler.js';
import type { ReleaseCheckDeps } from '../update/release-check.js';
import type { ReleaseCheckState } from '../update/release-state-store.js';
import type { DistributionChannel, UpdateModeStore } from '../update/update-mode-store.js';
import { channelDefaultMode } from '../update/update-mode-store.js';
import { buildUpdateReleaseEntry } from '../update/auto-apply-registry.js';

const modeStore: UpdateModeStore = { readUserMode: () => null, setUserMode: vi.fn() };

/** A release-deps stub with a real in-memory state cell — enough to drive the
 *  reported-version accessors without a database. */
const makeCheckDeps = (
  seed: ReleaseCheckState = { salt: 'ab', highest_accepted_sequence: 3 },
): { deps: ReleaseCheckDeps; read: () => ReleaseCheckState } => {
  let state: ReleaseCheckState = { ...seed };
  return {
    read: () => state,
    deps: {
      // Empty pubkey — every call short-circuits to `not-configured` before any
      // fetch, so nothing here can reach the network by accident.
      trustedPubkey: '',
      manifestUrl: 'https://releases.example/manifest.json',
      fetchText: async () => {
        throw new Error('no network in this test');
      },
      channel: 'stable',
      currentVersion: '1.3.0',
      platform: 'x86_64-unknown-linux-gnu' as ReleaseCheckDeps['platform'],
      loadState: () => state,
      saveState: (next) => {
        state = next;
      },
      now: () => 1000,
    },
  };
};

const applyDeps = { ports: {}, resolveForApply: async () => ({ status: 'up-to-date' }) } as unknown as UpdateApplyDeps;

const build = (channel: DistributionChannel, apply: UpdateApplyDeps | undefined, checkDeps?: ReleaseCheckDeps) =>
  buildUpdateReleaseEntry({
    releaseCheckDeps: checkDeps ?? makeCheckDeps().deps,
    applyDeps: apply,
    modeStore,
    channel,
    bindBusySignal: vi.fn(),
  });

describe('buildUpdateReleaseEntry', () => {
  it('publishes an entry on a DELEGATED channel that has no apply path', () => {
    // The regression. Both of these default to `notify`.
    for (const channel of ['docker-baked', 'source'] as const) {
      const entry = build(channel, undefined);
      expect(entry, `${channel} must still get a periodic check`).toBeDefined();
      expect(entry?.applyDeps).toBeUndefined();
      expect(typeof entry?.runCheck).toBe('function');
      // The half that makes the regression matter: these are the channels whose
      // default mode is the one that needs a scheduled check to mean anything.
      expect(channelDefaultMode(channel)).toBe('notify');
    }
  });

  it('carries the apply half on a self-applying channel', () => {
    // ⚠ The apply half is wired per CHANNEL CAPABILITY, not per default mode.
    // `binary` now defaults to `notify` and STILL needs applyDeps — the owner
    // applies explicitly via `update.apply`. Asserting one mode for both here
    // would conflate "can apply" with "applies unasked", which is exactly the
    // distinction the notify default draws.
    for (const channel of ['binary', 'docker-thin'] as const) {
      const entry = build(channel, applyDeps);
      expect(entry?.applyDeps).toBe(applyDeps);
    }
    expect(channelDefaultMode('docker-thin')).toBe('auto');
    expect(channelDefaultMode('binary')).toBe('notify');
  });

  it('publishes NOTHING when the platform has no release deps at all', () => {
    // The one honest reason to register no task: nothing to check with.
    expect(
      buildUpdateReleaseEntry({
        releaseCheckDeps: undefined,
        applyDeps: undefined,
        modeStore,
        channel: 'binary',
        bindBusySignal: vi.fn(),
      }),
    ).toBeUndefined();
  });

  it('wires notifyOwner THROUGH to the block when a boot composed one', async () => {
    // The failure this pins: a composed block that nothing ever calls. The
    // entry carrying a `notifyOwner` is what makes `notify` mode reach a person
    // rather than only the audit log.
    const notify = vi.fn(async () => {});
    const entry = buildUpdateReleaseEntry({
      releaseCheckDeps: makeCheckDeps().deps,
      applyDeps: undefined,
      modeStore,
      channel: 'docker-baked',
      bindBusySignal: vi.fn(),
      notificationBlock: { notify },
    });
    expect(entry?.notifyOwner).toBeDefined();
    await entry?.notifyOwner?.({ title: 'T', text: 'B' });
    expect(notify).toHaveBeenCalledWith({ title: 'T', text: 'B' });
  });

  it('omits notifyOwner when the boot composed no block, rather than faking one', () => {
    // Absent, not a no-op stub: an unbacked seam reads as wired.
    expect(build('docker-baked', undefined)?.notifyOwner).toBeUndefined();
  });

  it('round-trips the reported version through the release state row', () => {
    const { deps, read } = makeCheckDeps();
    const entry = build('docker-baked', undefined, deps);
    expect(entry?.readLastReported()).toBeNull();
    entry?.writeLastReported('1.4.2');
    expect(entry?.readLastReported()).toBe('1.4.2');
    // and it does NOT clobber the anti-replay floor it shares a row with
    expect(read().highest_accepted_sequence).toBe(3);
    expect(read().salt).toBe('ab');
  });

  it('preserves a concurrently-advanced sequence when recording a version', () => {
    // The check advances the floor inside `runReleaseCheck`; the marker write
    // is a read-modify-write over the SAME row afterwards. If it captured state
    // up front instead of re-reading, it would roll the floor back.
    const { deps, read } = makeCheckDeps();
    const entry = build('docker-baked', undefined, deps);
    deps.saveState({ ...deps.loadState(), highest_accepted_sequence: 9 });
    entry?.writeLastReported('1.4.2');
    expect(read().highest_accepted_sequence).toBe(9);
    expect(read().last_reported_version).toBe('1.4.2');
  });
});
