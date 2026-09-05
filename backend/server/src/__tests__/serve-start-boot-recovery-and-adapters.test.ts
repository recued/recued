import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { stripSourceComments } from './helpers/source-guards.js';

const bootRecoveryMocks = vi.hoisted(() => ({
  recoverNotificationBlockAtBoot: vi.fn(),
  raiseInDoubtForSweptCommits: vi.fn(),
  commitRestoreProvenanceAtBoot: vi.fn(),
  replayKeyfileEventsIntoAudit: vi.fn(),
  sweepAtomicWriteTemps: vi.fn(),
}));

vi.mock('../composition/bin/wire-notification-block.js', () => ({
  recoverNotificationBlockAtBoot: bootRecoveryMocks.recoverNotificationBlockAtBoot,
  raiseInDoubtForSweptCommits: bootRecoveryMocks.raiseInDoubtForSweptCommits,
}));

// M5 S1 — mock the provenance commit so the boot hook's WIRING (call shape +
// the dbPath/getSigningIdentity/auditLog guard) is asserted here; the commit's
// own behavior is unit-tested in archive-restore-provenance.test.ts.
vi.mock('../archive/restore-provenance.js', () => ({
  commitRestoreProvenanceAtBoot: bootRecoveryMocks.commitRestoreProvenanceAtBoot,
}));

// D-212 follow-on — same reasoning as the provenance mock above: the keyfile
// event replay's own behavior is unit-tested in d-212-keyfile-event-ledger, and
// what belongs HERE is that boot actually calls it. A `rotate-passphrase` that
// records perfectly and a boot that never reads the ledger is the half-built
// shape this follow-on was deliberately not shipped as.
vi.mock('../keys/keyfile-event-replay.js', () => ({
  replayKeyfileEventsIntoAudit: bootRecoveryMocks.replayKeyfileEventsIntoAudit,
}));

vi.mock('../durable-fs.js', () => ({
  sweepAtomicWriteTemps: bootRecoveryMocks.sweepAtomicWriteTemps,
}));

import {
  startBootRecoveryAndAdapters,
  type StartBootRecoveryAndAdaptersOptions,
} from '../serve/start-boot-recovery-and-adapters.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..', '..', '..', '..');
const helperPath = join(
  repoRoot,
  'backend/server/src/serve/start-boot-recovery-and-adapters.ts',
);
const lifecycleRecoveryBridgePath = join(
  repoRoot,
  'backend/server/src/serve/start-lifecycle-recovery-pre-listener-runtime.ts',
);

const makeOptions = (
  overrides: Partial<StartBootRecoveryAndAdaptersOptions> = {},
): StartBootRecoveryAndAdaptersOptions =>
  ({
    lifecycle: { tag: 'lifecycle' },
    bootSigningIdentity: vi.fn(async () => undefined),
    notificationBlock: { tag: 'notification-block' },
    checkpointStore: { tag: 'checkpoint-store' },
    auditLog: { tag: 'audit-log' },
    commitStore: { sweepPendingToInDoubt: vi.fn(async () => []) },
    gatedActionStore: { tag: 'gated-action-store' },
    fileStack: { startAll: vi.fn(async () => undefined) },
    collection: { startCollectionAdapters: vi.fn(async () => undefined) },
    warn: vi.fn(),
    ...overrides,
  }) as unknown as StartBootRecoveryAndAdaptersOptions;

beforeEach(() => {
  bootRecoveryMocks.recoverNotificationBlockAtBoot.mockReset();
  bootRecoveryMocks.raiseInDoubtForSweptCommits.mockReset();
  bootRecoveryMocks.commitRestoreProvenanceAtBoot.mockReset();
  bootRecoveryMocks.replayKeyfileEventsIntoAudit.mockReset();
  bootRecoveryMocks.sweepAtomicWriteTemps.mockReset();
});

describe('startBootRecoveryAndAdapters', () => {
  it('sweeps atomic-write residue in both data and external config directories', async () => {
    await startBootRecoveryAndAdapters(makeOptions({
      dbPath: '/srv/recued/data/realm.db',
      configPath: '/etc/recued/config.toml',
      getSigningIdentity: () => undefined,
    }));

    expect(bootRecoveryMocks.sweepAtomicWriteTemps.mock.calls).toEqual([
      ['/srv/recued/data'],
      ['/etc/recued'],
    ]);
  });

  it('runs locked identity boot, notification recovery, commit sweep, and adapter starts in order', async () => {
    const order: string[] = [];
    const sweptCommits = [{ commit_id: 'commit-1' }];
    bootRecoveryMocks.recoverNotificationBlockAtBoot.mockImplementation(async () => {
      order.push('recover');
    });
    bootRecoveryMocks.raiseInDoubtForSweptCommits.mockImplementation(async () => {
      order.push('raise');
    });
    const warn = vi.fn(() => {
      order.push('warn');
    });
    const options = makeOptions({
      getBatch: vi.fn(async () => null),
      reconcileOpenBatch: vi.fn(async () => ({ kind: 'not_open' as const })),
      recoverPeerDeliveries: vi.fn(async () => undefined),
      preserveInterruptedDispatch: vi.fn(async () => true),
      bootSigningIdentity: vi.fn(async () => {
        order.push('identity');
      }),
      commitStore: {
        sweepPendingToInDoubt: vi.fn(async () => {
          order.push('sweep');
          return sweptCommits;
        }),
      } as unknown as StartBootRecoveryAndAdaptersOptions['commitStore'],
      fileStack: {
        startAll: vi.fn(async () => {
          order.push('file');
        }),
      } as unknown as StartBootRecoveryAndAdaptersOptions['fileStack'],
      collection: {
        startCollectionAdapters: vi.fn(async () => {
          order.push('collection');
        }),
      },
      warn,
    });

    await startBootRecoveryAndAdapters(options);

    expect(order).toEqual([
      'identity',
      'recover',
      'sweep',
      'warn',
      'raise',
      'file',
      'collection',
    ]);
    expect(bootRecoveryMocks.recoverNotificationBlockAtBoot).toHaveBeenCalledWith({
      block: options.notificationBlock,
      checkpointStore: options.checkpointStore,
      auditLog: options.auditLog,
      gatedActionStore: options.gatedActionStore,
      getBatch: options.getBatch,
      reconcileOpenBatch: options.reconcileOpenBatch,
      recoverPeerDeliveries: options.recoverPeerDeliveries,
      preserveInterruptedDispatch: options.preserveInterruptedDispatch,
    });
    expect(warn).toHaveBeenCalledWith(
      '[commits] crash recovery — 1 non-terminal commit(s) from a prior run marked in_doubt',
    );
    expect(bootRecoveryMocks.raiseInDoubtForSweptCommits).toHaveBeenCalledWith({
      block: options.notificationBlock,
      sweptCommits,
    });
  });

  it('keeps identity and recovery writes behind the lifecycle gate while still starting adapters', async () => {
    const order: string[] = [];
    const bootSigningIdentity = vi.fn(async () => {
      order.push('identity');
    });
    const commitStore = {
      sweepPendingToInDoubt: vi.fn(async () => {
        order.push('sweep');
        return [];
      }),
    } as unknown as StartBootRecoveryAndAdaptersOptions['commitStore'];

    await startBootRecoveryAndAdapters(
      makeOptions({
        lifecycle: undefined,
        bootSigningIdentity,
        commitStore,
        fileStack: {
          startAll: vi.fn(async () => {
            order.push('file');
          }),
        } as unknown as StartBootRecoveryAndAdaptersOptions['fileStack'],
        collection: {
          startCollectionAdapters: vi.fn(async () => {
            order.push('collection');
          }),
        },
      }),
    );

    expect(order).toEqual(['file', 'collection']);
    expect(bootSigningIdentity).not.toHaveBeenCalled();
    expect(commitStore?.sweepPendingToInDoubt).not.toHaveBeenCalled();
    expect(bootRecoveryMocks.recoverNotificationBlockAtBoot).not.toHaveBeenCalled();
    expect(bootRecoveryMocks.raiseInDoubtForSweptCommits).not.toHaveBeenCalled();
  });

  it('preserves recovery and in-doubt re-raise gates independently', async () => {
    const sweptCommits = [{ commit_id: 'commit-2' }];
    const options = makeOptions({
      checkpointStore: undefined,
      commitStore: {
        sweepPendingToInDoubt: vi.fn(async () => sweptCommits),
      } as unknown as StartBootRecoveryAndAdaptersOptions['commitStore'],
    });

    await startBootRecoveryAndAdapters(options);

    expect(bootRecoveryMocks.recoverNotificationBlockAtBoot).not.toHaveBeenCalled();
    expect(bootRecoveryMocks.raiseInDoubtForSweptCommits).toHaveBeenCalledWith({
      block: options.notificationBlock,
      sweptCommits,
    });

    bootRecoveryMocks.raiseInDoubtForSweptCommits.mockReset();
    await startBootRecoveryAndAdapters(
      makeOptions({
        notificationBlock: undefined,
        commitStore: {
          sweepPendingToInDoubt: vi.fn(async () => sweptCommits),
        } as unknown as StartBootRecoveryAndAdaptersOptions['commitStore'],
      }),
    );

    expect(bootRecoveryMocks.raiseInDoubtForSweptCommits).not.toHaveBeenCalled();
  });
});

describe('startBootRecoveryAndAdapters — M5 S1 restore-provenance hook', () => {
  const bootedIdentity = {
    identity: { serverIdentityKey: vi.fn() },
  } as unknown as NonNullable<
    ReturnType<NonNullable<StartBootRecoveryAndAdaptersOptions['getSigningIdentity']>>
  >;

  it('commits restore provenance AFTER identity boot when dbPath + signing identity + auditLog are present', async () => {
    const order: string[] = [];
    const options = makeOptions({
      dbPath: '/tmp/recued.db',
      getSigningIdentity: vi.fn(() => bootedIdentity),
      bootSigningIdentity: vi.fn(async () => { order.push('identity'); }),
    });
    bootRecoveryMocks.commitRestoreProvenanceAtBoot.mockImplementation(async () => {
      order.push('provenance');
    });

    await startBootRecoveryAndAdapters(options);

    expect(bootRecoveryMocks.commitRestoreProvenanceAtBoot).toHaveBeenCalledTimes(1);
    expect(bootRecoveryMocks.commitRestoreProvenanceAtBoot).toHaveBeenCalledWith({
      dataPath: '/tmp', // dirname('/tmp/recued.db')
      serverIdentity: expect.any(Function),
      audit: expect.objectContaining({ log: expect.any(Function) }),
      warn: options.warn,
    });
    // The new publisher_id is the live identity, so the commit must follow boot.
    expect(order).toEqual(['identity', 'provenance']);
  });

  it('replays the keyfile event ledger into the audit log, after the signing identity', async () => {
    // The row is high-assurance, so it can only be signed once
    // `bootSigningIdentity` has run — a replay ordered before it would write an
    // unsigned row of a kind the verifier rejects.
    const order: string[] = [];
    const options = makeOptions({
      dbPath: '/tmp/recued.db',
      getSigningIdentity: vi.fn(() => bootedIdentity),
      bootSigningIdentity: vi.fn(async () => { order.push('identity'); }),
    });
    bootRecoveryMocks.replayKeyfileEventsIntoAudit.mockImplementation(async () => {
      order.push('keyfile-replay');
      return 0;
    });

    await startBootRecoveryAndAdapters(options);

    expect(bootRecoveryMocks.replayKeyfileEventsIntoAudit).toHaveBeenCalledTimes(1);
    expect(bootRecoveryMocks.replayKeyfileEventsIntoAudit).toHaveBeenCalledWith({
      dataPath: '/tmp', // dirname('/tmp/recued.db') — beside the keyfile itself
      auditLog: options.auditLog,
      warn: options.warn,
    });
    expect(order).toEqual(['identity', 'keyfile-replay']);
  });

  it('skips the keyfile replay on a db-less / identity-less / audit-less boot', async () => {
    await startBootRecoveryAndAdapters(
      makeOptions({ getSigningIdentity: vi.fn(() => bootedIdentity) }),
    );
    await startBootRecoveryAndAdapters(
      makeOptions({ dbPath: '/tmp/recued.db', getSigningIdentity: vi.fn(() => undefined) }),
    );
    await startBootRecoveryAndAdapters(
      makeOptions({
        dbPath: '/tmp/recued.db',
        getSigningIdentity: vi.fn(() => bootedIdentity),
        auditLog: undefined,
      }),
    );
    expect(bootRecoveryMocks.replayKeyfileEventsIntoAudit).not.toHaveBeenCalled();
  });

  it('skips the provenance commit when no db path is wired (db-less harness)', async () => {
    await startBootRecoveryAndAdapters(
      makeOptions({ getSigningIdentity: vi.fn(() => bootedIdentity) }),
    );
    expect(bootRecoveryMocks.commitRestoreProvenanceAtBoot).not.toHaveBeenCalled();
  });

  it('skips the provenance commit when no signing identity is booted', async () => {
    await startBootRecoveryAndAdapters(
      makeOptions({ dbPath: '/tmp/recued.db', getSigningIdentity: vi.fn(() => undefined) }),
    );
    expect(bootRecoveryMocks.commitRestoreProvenanceAtBoot).not.toHaveBeenCalled();
  });

  it('skips the provenance commit when no auditLog is available (no-audit boot)', async () => {
    await startBootRecoveryAndAdapters(
      makeOptions({
        dbPath: '/tmp/recued.db',
        getSigningIdentity: vi.fn(() => bootedIdentity),
        auditLog: undefined,
      }),
    );
    expect(bootRecoveryMocks.commitRestoreProvenanceAtBoot).not.toHaveBeenCalled();
  });

  it('skips the provenance commit when lifecycle is absent (gated boot)', async () => {
    await startBootRecoveryAndAdapters(
      makeOptions({
        lifecycle: undefined,
        dbPath: '/tmp/recued.db',
        getSigningIdentity: vi.fn(() => bootedIdentity),
      }),
    );
    expect(bootRecoveryMocks.commitRestoreProvenanceAtBoot).not.toHaveBeenCalled();
  });
});

describe('start-boot-recovery-and-adapters source boundary', () => {
  it('keeps post-lifecycle recovery and adapter starts behind the lifecycle bridge', () => {
    const bridgeSource = readFileSync(lifecycleRecoveryBridgePath, 'utf8');
    const helperSource = readFileSync(helperPath, 'utf8');

    expect(bridgeSource).toMatch(/start-boot-recovery-and-adapters\.js/);
    expect(bridgeSource).toMatch(/await startBootRecoveryAndAdapters\(\{/);

    expect(helperSource).toMatch(/recoverNotificationBlockAtBoot/);
    expect(helperSource).toMatch(/raiseInDoubtForSweptCommits/);
    expect(helperSource).toMatch(/sweepPendingToInDoubt/);
    expect(helperSource).toMatch(/fileStack\.startAll/);
    expect(helperSource).toMatch(/startCollectionAdapters/);
    // M5 S1 — the post-restart provenance hook is wired behind the lifecycle gate.
    expect(helperSource).toMatch(/commitRestoreProvenanceAtBoot/);
  });

  it('preserves lifecycle, recovery, adapter, ingress, and listener ordering', () => {
    const bridgeSource = readFileSync(lifecycleRecoveryBridgePath, 'utf8');
    const helperSource = readFileSync(helperPath, 'utf8');

    const lifecycleIndex = bridgeSource.indexOf('await composeServeLifecycle({');
    const recoveryStartIndex = bridgeSource.indexOf(
      'await startBootRecoveryAndAdapters({',
    );
    const preListenerIndex = bridgeSource.indexOf('await startPreListenerRuntime({');

    expect(lifecycleIndex).toBeGreaterThanOrEqual(0);
    expect(recoveryStartIndex).toBeGreaterThan(lifecycleIndex);
    expect(preListenerIndex).toBeGreaterThan(recoveryStartIndex);

    const identityIndex = helperSource.indexOf('await bootSigningIdentity();');
    const notificationRecoveryIndex = helperSource.indexOf(
      'await recoverNotificationBlockAtBoot({',
    );
    const commitSweepIndex = helperSource.indexOf(
      'await commitStore.sweepPendingToInDoubt()',
    );
    const inDoubtIndex = helperSource.indexOf('await raiseInDoubtForSweptCommits({');
    const fileStartIndex = helperSource.indexOf('await fileStack.startAll();');
    const collectionStartIndex = helperSource.indexOf(
      'await collection.startCollectionAdapters();',
    );

    expect(identityIndex).toBeGreaterThanOrEqual(0);
    expect(notificationRecoveryIndex).toBeGreaterThan(identityIndex);
    expect(commitSweepIndex).toBeGreaterThan(notificationRecoveryIndex);
    expect(inDoubtIndex).toBeGreaterThan(commitSweepIndex);
    expect(fileStartIndex).toBeGreaterThan(inDoubtIndex);
    expect(collectionStartIndex).toBeGreaterThan(fileStartIndex);
  });

  it('keeps the helper focused on post-lifecycle recovery and adapter start', () => {
    const helperSource = readFileSync(helperPath, 'utf8');

    expect(stripSourceComments(helperSource)).not.toMatch(/composeIngressRpcContext/);
    expect(stripSourceComments(helperSource)).not.toMatch(/composeClientSecurityContext/);
    expect(stripSourceComments(helperSource)).not.toMatch(/composeRpcContext|composeListeners/);
    expect(stripSourceComments(helperSource)).not.toMatch(/composeServeExposure|wrapServePeerCache/);
    expect(stripSourceComments(helperSource)).not.toMatch(/startSchedulers|startServeHousekeepingScheduler/);
    expect(stripSourceComments(helperSource)).not.toMatch(/startRetentionPruners|startDdnsUpdatePoller/);
    expect(stripSourceComments(helperSource)).not.toMatch(/logBootBanner|installShutdown/);
  });
});
