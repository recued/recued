import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { stripSourceComments } from './helpers/source-guards.js';

const retentionMocks = vi.hoisted(() => ({
  composeRetentionPruners: vi.fn(),
}));

vi.mock('../composition/bin/wire-retention-pruners.js', () => ({
  composeRetentionPruners: retentionMocks.composeRetentionPruners,
}));

import type { RuntimeConfigStore } from '@recued/config';
import type { AuditRetention } from '../audit-retention.js';
import type { BackgroundServiceRegistry } from '../composition/bin/wire-background-services.js';
import type { S2SPreviewStore } from '../s2s-preview/store.js';
import type { CorrectionEventsStore } from '../storage/correction-events-store.js';
import {
  startRetentionPruners,
  type StartRetentionPrunersOptions,
} from '../serve/start-retention-pruners.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..', '..', '..', '..');
const startRetentionPrunersPath = join(
  repoRoot,
  'backend/server/src/serve/start-retention-pruners.ts',
);
const startPostHousekeepingTailPath = join(
  repoRoot,
  'backend/server/src/serve/start-post-housekeeping-tail.ts',
);
const startPostListenerRuntimePath = join(
  repoRoot,
  'backend/server/src/serve/start-post-listener-runtime.ts',
);
const startListenerExposureRuntimePath = join(
  repoRoot,
  'backend/server/src/serve/start-listener-exposure-runtime.ts',
);

const makeOptions = (): StartRetentionPrunersOptions =>
  ({
    backgroundServices: { registerInterval: vi.fn() } as unknown as BackgroundServiceRegistry,
    runtimeConfig: { get: vi.fn() } as unknown as RuntimeConfigStore,
    auditRetention: { run: vi.fn(), runSafe: vi.fn() } as unknown as AuditRetention,
    s2sPreviewStore: { pruneExpired: vi.fn() } as unknown as S2SPreviewStore,
    correctionEventsStore: {
      pruneOlderThan: vi.fn(),
    } as unknown as CorrectionEventsStore,
    // D-157 N.8 — the stale-checkpoint sweep's deps; the composer owns
    // the missing-store gate, so the delegation tests pass undefined.
    checkpointStore: undefined,
    auditLog: undefined,
    executionCaseLifecycle: undefined,
    notificationBlock: undefined,
  });

beforeEach(() => {
  retentionMocks.composeRetentionPruners.mockReset();
});

describe('startRetentionPruners', () => {
  it('delegates the existing pruner inputs without changing gate behavior', () => {
    const options = makeOptions();

    startRetentionPruners(options);

    expect(retentionMocks.composeRetentionPruners).toHaveBeenCalledTimes(1);
    expect(retentionMocks.composeRetentionPruners).toHaveBeenCalledWith(options);
  });

  it('passes undefined stores through so the composer owns independent gating', () => {
    const options = {
      ...makeOptions(),
      auditRetention: undefined,
      s2sPreviewStore: undefined,
      correctionEventsStore: undefined,
    };

    startRetentionPruners(options);

    expect(retentionMocks.composeRetentionPruners).toHaveBeenCalledWith(options);
  });
});

describe('start-retention-pruners source boundary', () => {
  it('keeps retention startup wiring behind the post-housekeeping tail', () => {
    const bridgeSource = readFileSync(startListenerExposureRuntimePath, 'utf8');
    const runtimeSource = readFileSync(startPostListenerRuntimePath, 'utf8');
    const tailSource = readFileSync(startPostHousekeepingTailPath, 'utf8');

    expect(bridgeSource).toMatch(/start-post-listener-runtime\.js/);
    expect(runtimeSource).toMatch(/start-post-housekeeping-tail\.js/);
    expect(tailSource).toMatch(/start-retention-pruners\.js/);
    expect(tailSource).toMatch(/startRetentionPruners\(\{/);
  });

  it('preserves retention, DDNS, banner, and shutdown ordering in the tail helper', () => {
    const source = readFileSync(startPostHousekeepingTailPath, 'utf8');
    const retentionIndex = source.indexOf('startRetentionPruners({');
    const ddnsIndex = source.indexOf('startDdnsUpdatePoller({');
    const bannerIndex = source.indexOf('logBootBanner({');
    // D-178 slice 4b (63d229697) — no longer a `return` expression; the
    // ORDERING this asserts (retention → ddns → banner → shutdown) is intact.
    const shutdownIndex = source.indexOf('installShutdown({');

    expect(retentionIndex).toBeGreaterThanOrEqual(0);
    expect(ddnsIndex).toBeGreaterThan(retentionIndex);
    expect(bannerIndex).toBeGreaterThan(ddnsIndex);
    expect(shutdownIndex).toBeGreaterThan(bannerIndex);
  });

  it('keeps the retention helper focused on pruner startup only', () => {
    const source = readFileSync(startRetentionPrunersPath, 'utf8');

    expect(source).toMatch(/composeRetentionPruners/);
    expect(source).toMatch(/auditRetention/);
    expect(source).toMatch(/s2sPreviewStore/);
    expect(source).toMatch(/correctionEventsStore/);
    expect(stripSourceComments(source)).not.toMatch(/startDdnsUpdatePoller|composeDdnsUpdatePoller/);
    expect(stripSourceComments(source)).not.toMatch(/logBootBanner|installShutdown/);
    expect(stripSourceComments(source)).not.toMatch(/composeSchedulers|composeHousekeepingScheduler/);
    expect(stripSourceComments(source)).not.toMatch(/createServerHandlerSet|createProductionPathListenerCoordinator/);
  });
});
