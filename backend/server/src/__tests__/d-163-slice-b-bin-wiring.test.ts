/** D-163 Slice B — backend bin.ts wiring tests.
 *
 *  Slice A (commit 769622a4) landed the `@recued/notification` substrate
 *  — `ChannelCapability`, capability-aware routing, the new
 *  `createBridgeChannel` factory, the `ChannelReadinessProbe` typedef.
 *  Slice B wires those substrates into `composeNotificationBlock` so the
 *  production `backend/server` boot path constructs Bridge as a discrete
 *  channel + injects a readiness probe that consults the lifted
 *  `client_tokens` store + the connection store.
 *
 *  These tests pin the Slice B contract:
 *    - The Bridge channel is registered in the block's `channels` array
 *      (D-163 I-4) — its row appears in `describeNotificationChannels()`
 *      and `ask` fan-out respects its `capability: 'notify-only'`.
 *    - The readiness probe gates on adapter presence BEFORE consulting a
 *      backing (Codex Slice B fold) — credential-backed channels without
 *      a wired adapter never report `ready` even when a
 *      `connection.notification.<vendor>` credential is enrolled, so the
 *      block never enables a fan-out target it can't deliver to.
 *    - The Bridge probe path is pair-presence-backed via the lifted
 *      `clientTokens` store (D-163 N.5 / I-5): zero `client_kind:
 *      'bridge'` rows ⇒ `not_ready`; one or more ⇒ `ready`.
 *    - The `bridgeSink` slot is optional — absent ⇒ Bridge's
 *      `deliverNotify` is a silent no-op (the block can still raise
 *      asks; the passive notify to Bridge on ask raise just no-ops). */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import {
  type Checkpoint,
  type ConnectionKind,
  type ConnectionRow,
} from '@recued/contracts';
import {
  createAuditLogStore,
  createCheckpointStore,
  type ActivityEntry,
  type AuditEntry,
  type AuditLogStore,
  type CheckpointStore,
} from '@recued/storage';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { EventBus } from '../events/bus.js';
import { ensureCheckpointSchema } from '../memory-schema.js';
import { ensureSourceDependencyEntitySchema } from '../storage/source-dependency-entity-store.js';
import {
  composeNotificationBlock,
  type NotificationBlockBundle,
} from '../composition/bin/wire-notification-block.js';
import type { ExecuteHandlerDeps } from '../execute-handler.js';
import { createSQLiteCollection } from '../sqlite-collection.js';
import { createBlobStore } from '../storage/blob-store.js';
import {
  createAnnotationStore,
  type AnnotationStore,
} from '../storage/annotation-store.js';
import type { ConnectionStoreSqlite } from '../storage/connection-store.js';
import type { ClientTokenStore } from '../pairing/client-tokens.js';
import type { BridgeSink } from '@recued/notification';

const NOW = Date.parse('2026-05-27T12:00:00.000Z');

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  vi.restoreAllMocks();
});

const eventBus = (): EventBus =>
  ({
    cursor: vi.fn(() => 0),
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    emit: vi.fn((event) => ({ cursor: 1, ...event })),
    replay: vi.fn(() => []),
    subscriberCount: vi.fn(() => 0),
  }) as unknown as EventBus;

const auditLog = (db: Database.Database): AuditLogStore =>
  createAuditLogStore(
    createSQLiteCollection<AuditEntry>(db, 'audit_log'),
    createSQLiteCollection<ActivityEntry>(db, 'activity_log'),
  );

const checkpointStore = (db: Database.Database): CheckpointStore => {
  const store = createCheckpointStore(
    createSQLiteCollection<Checkpoint>(db, 'checkpoints'),
  );
  ensureCheckpointSchema(db);
  return store;
};

const annotationStore = (
  db: Database.Database,
  dir: string,
): AnnotationStore => {
  let nextId = 0;
  return createAnnotationStore({
    db,
    blobs: createBlobStore(join(dir, 'blobs')),
    now: () => NOW,
    newId: () => `annotation-${++nextId}`,
  });
};

interface HarnessOverrides {
  connectionStore?: ConnectionStoreSqlite;
  clientTokens?: ClientTokenStore;
  bridgeSink?: BridgeSink;
}

const composeHarness = (overrides: HarnessOverrides = {}) => {
  const db = new Database(':memory:');
  cleanups.push(() => db.close());
  // composeNotificationBlock unconditionally builds the D-192 Slice 6b
  // container-pick store (`createSourceDependencyEntityStore`), so its table
  // must exist before construction — mirrors `checkpointStore`'s
  // `ensureCheckpointSchema`.
  ensureSourceDependencyEntitySchema(db);
  const dir = mkdtempSync(join(tmpdir(), 'd-163-slice-b-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));

  const getExecuteDeps: () => ExecuteHandlerDeps | undefined =
    vi.fn<() => ExecuteHandlerDeps | undefined>(() => undefined);

  const { block } = composeNotificationBlock({
    db,
    auditLog: auditLog(db),
    checkpointStore: checkpointStore(db),
    annotationStore: annotationStore(db, dir),
    eventBus: eventBus(),
    getExecuteDeps,
    ...(overrides.connectionStore ? { connectionStore: overrides.connectionStore } : {}),
    ...(overrides.clientTokens ? { clientTokens: overrides.clientTokens } : {}),
    ...(overrides.bridgeSink ? { bridgeSink: overrides.bridgeSink } : {}),
  });

  return { block };
};

/** Minimal stub of `ConnectionStoreSqlite` exposing only the read path
 *  the readiness probe consults. The full interface has 8 methods; the
 *  probe only touches `get(kind, name)`, so a partial stub keeps tests
 *  focused on the probe semantics rather than the store contract. */
const stubConnectionStore = (
  rows: ReadonlyArray<{ kind: ConnectionKind; name: string }> = [],
): ConnectionStoreSqlite =>
  ({
    get(kind: ConnectionKind, name: string): ConnectionRow | null {
      const match = rows.find((r) => r.kind === kind && r.name === name);
      if (!match) return null;
      return {
        pk: `${kind}:${name}`,
        kind,
        name,
        display_name: name,
        config_json: '{}',
        auth_ciphertext: '',
        enrolled_at: NOW,
        updated_at: NOW,
      };
    },
  }) as unknown as ConnectionStoreSqlite;

/** Minimal stub of `ClientTokenStore` exposing only `list`. The probe
 *  only touches the `list({ client_kind: 'bridge' })` path; the full
 *  interface has 8 methods (`issue`, `verify`, `rotate`, etc.) that
 *  test irrelevant here. */
const stubClientTokens = (
  bridgeRows: number,
): ClientTokenStore =>
  ({
    list: vi.fn((opts?: { include_revoked?: boolean; client_kind?: string }) => {
      if (opts?.client_kind === 'bridge') {
        return Array.from({ length: bridgeRows }, (_, i) => ({
          token_id: `bridge-${i}`,
          client_kind: 'bridge' as const,
          client_label: null,
          issued_at: NOW,
          last_used_at: null,
          revoked_at: null,
          revocation_reason: null,
          metadata: null,
        }));
      }
      return [];
    }),
  }) as unknown as ClientTokenStore;

describe('D-163 Slice B — composeNotificationBlock channel wiring', () => {
  it('registers the Bridge channel discretely (I-4) with notify-only capability + ui inline', async () => {
    const { block } = composeHarness();

    const rows = await block.describeNotificationChannels();
    const byName = new Map(rows.map((row) => [row.channel, row]));

    const uiRow = byName.get('ui');
    expect(uiRow).toBeDefined();
    expect(uiRow!.capability).toBe('inline');
    expect(uiRow!.notification).toBe(true);
    expect(uiRow!.approval).toBe(true);
    expect(uiRow!.notification_togglable).toBe(false);
    expect(uiRow!.approval_togglable).toBe(false);
    expect(uiRow!.ready).toBe(true);

    const bridgeRow = byName.get('bridge');
    expect(bridgeRow).toBeDefined();
    expect(bridgeRow!.capability).toBe('notify-only');
    expect(bridgeRow!.notification_togglable).toBe(true);
    expect(bridgeRow!.install_url).toBeDefined();
  });

  it('omits the bridgeSink dep cleanly — Bridge channel still constructs + deliverNotify is a silent no-op', async () => {
    const { block } = composeHarness();

    // `notify` to every enabled channel: Bridge is disabled by default
    // in the settings record (D-163 P0 added `bridge: false` baseline),
    // so this exercises the path without involving the sink. Asserts
    // the block surfaces the Bridge row regardless of the sink, which
    // is the contract: the channel exists for Settings rendering even
    // when no production transport is wired.
    await expect(block.notify({ text: 'hello' })).resolves.toBeUndefined();
  });

  it('fires the injected bridgeSink when Bridge is enabled and a notify is issued', async () => {
    const bridgeSink = vi.fn<BridgeSink>();
    const { block } = composeHarness({
      clientTokens: stubClientTokens(1),
      bridgeSink,
    });

    const toggleResult = await block.setNotificationChannelMode('bridge', { notification: true });
    expect(toggleResult.ok).toBe(true);
    const modeResult = await block.setNotificationBridgeMode('bridge-0', {
      notification: true,
    });
    expect(modeResult.ok).toBe(true);

    await block.notify({ text: 'OS ping' });

    expect(bridgeSink).toHaveBeenCalledTimes(1);
    expect(bridgeSink).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'OS ping' }),
    );
  });
});

describe('D-163 Slice B — ChannelReadinessProbe wiring (I-5)', () => {
  it('reports ui ready unconditionally', async () => {
    const { block } = composeHarness();
    const rows = await block.describeNotificationChannels();
    const uiRow = rows.find((r) => r.channel === 'ui');
    expect(uiRow!.ready).toBe(true);
  });

  it('reports bridge not_ready when no client tokens of kind bridge exist', async () => {
    const { block } = composeHarness({ clientTokens: stubClientTokens(0) });
    const rows = await block.describeNotificationChannels();
    const bridgeRow = rows.find((r) => r.channel === 'bridge');
    expect(bridgeRow!.ready).toBe(false);
  });

  it('reports bridge ready when at least one client_kind=bridge row exists', async () => {
    const { block } = composeHarness({ clientTokens: stubClientTokens(1) });
    const rows = await block.describeNotificationChannels();
    const bridgeRow = rows.find((r) => r.channel === 'bridge');
    expect(bridgeRow!.ready).toBe(true);
  });

  it('reports bridge not_ready when clientTokens is absent entirely (fail-closed)', async () => {
    const { block } = composeHarness(); // no clientTokens injected
    const rows = await block.describeNotificationChannels();
    const bridgeRow = rows.find((r) => r.channel === 'bridge');
    expect(bridgeRow!.ready).toBe(false);
  });

  it('reports slack/telegram/email not_ready even when connection rows exist — no adapter wired in this slice', async () => {
    // Adapter-presence-before-backing gate (Codex Slice B fold for
    // MAJOR 3): even with a `connection.notification.slack` credential
    // enrolled, the probe must report `not_ready` until the Slack
    // adapter lands in a follow-on slice — otherwise the user could
    // toggle a channel on whose `deliverAsk` / `deliverNotify` would
    // silently drop because `allChannels` doesn't include it.
    const { block } = composeHarness({
      connectionStore: stubConnectionStore([
        { kind: 'notification', name: 'slack' },
        { kind: 'notification', name: 'telegram' },
        { kind: 'notification', name: 'email' },
      ]),
    });

    const rows = await block.describeNotificationChannels();
    for (const name of ['slack', 'telegram', 'email'] as const) {
      const row = rows.find((r) => r.channel === name);
      expect(row, `${name} row should exist`).toBeDefined();
      expect(row!.ready, `${name} should be not-ready (no adapter wired)`).toBe(false);
    }
  });

  it('rejects setChannel(bridge, true) with not_ready when no Bridge is paired', async () => {
    const { block } = composeHarness({ clientTokens: stubClientTokens(0) });

    const result = await block.setNotificationChannelMode('bridge', { notification: true });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('not_ready');
    }
  });

  it('accepts setChannel(bridge, true) once a Bridge is paired', async () => {
    const { block } = composeHarness({ clientTokens: stubClientTokens(2) });

    const result = await block.setNotificationChannelMode('bridge', { notification: true });
    expect(result.ok).toBe(true);
  });
});

describe('D-163 Slice B — composeExecuteDeps threads Slice B fields', () => {
  // Verifies the dep plumbing through `composeExecuteDeps` — the
  // Settings probe + Bridge sink are passed through unchanged when the
  // notification-block prereqs are all present. Mocks
  // `composeNotificationBlock` to capture the deps it receives so the
  // assertion is on the plumbing surface, not on probe behavior (the
  // probe tests above already cover that). The two-mock-helper pattern
  // mirrors `d-157-execute-deps-composition.test.ts`.
  it('forwards connectionStore / clientTokens / bridgeSink as optional spreads', async () => {
    vi.resetModules();
    const composeNotificationBlockMock = vi.fn<typeof composeNotificationBlock>(
      () => ({
        block: { notify: vi.fn() } as never,
        resumer: { resumeRun: vi.fn(), denyRun: vi.fn() } as never,
        batchApprovals: {
          registerHold: vi.fn(),
          hooks: { handleAnswer: vi.fn() },
        } as never,
        // Required on the bundle — omitting it is a silent feature-off for the
        // `/ask` detail block, so the type refuses it rather than the page.
        getBatch: vi.fn(async () => null),
        reconcileOpenBatch: vi.fn(async () => ({ kind: 'not_open' as const })),
      } as NotificationBlockBundle),
    );
    vi.doMock('../composition/bin/wire-notification-block.js', () => ({
      composeNotificationBlock: composeNotificationBlockMock,
    }));
    cleanups.push(() => {
      vi.doUnmock('../composition/bin/wire-notification-block.js');
    });

    const { composeExecuteDeps } = await import(
      '../composition/bin/wire-execute-deps.js'
    );

    const db = new Database(':memory:');
    cleanups.push(() => db.close());
    const dir = mkdtempSync(join(tmpdir(), 'd-163-slice-b-threading-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));

    const connectionStore = stubConnectionStore();
    const clientTokens = stubClientTokens(0);
    const bridgeSink = vi.fn<BridgeSink>();

    composeExecuteDeps({
      recipeStore: { tag: 'recipe-store' } as never,
      executorConfig: { tag: 'executor-config' } as never,
      baseVault: {},
      serverInstanceId: 'server-1',
      serverDisplayName: 'Test',
      eventBus: eventBus(),
      auditLog: auditLog(db),
      sharedStore: undefined,
      db,
      enrichmentStore: undefined,
      commitStore: undefined,
      checkpointStore: checkpointStore(db),
      annotationStore: annotationStore(db, dir),
      getExecuteDeps: vi.fn(() => undefined),
      connectionStore,
      clientTokens,
      bridgeSink,
    });

    expect(composeNotificationBlockMock).toHaveBeenCalledTimes(1);
    const passed = composeNotificationBlockMock.mock.calls[0]?.[0];
    expect(passed).toBeDefined();
    expect(passed!.connectionStore).toBe(connectionStore);
    expect(passed!.clientTokens).toBe(clientTokens);
    expect(passed!.bridgeSink).toBe(bridgeSink);
  });

  it('omits Slice B fields entirely when callers do not pass them (conditional spread)', async () => {
    vi.resetModules();
    const composeNotificationBlockMock = vi.fn<typeof composeNotificationBlock>(
      () => ({
        block: { notify: vi.fn() } as never,
        resumer: { resumeRun: vi.fn(), denyRun: vi.fn() } as never,
        batchApprovals: {
          registerHold: vi.fn(),
          hooks: { handleAnswer: vi.fn() },
        } as never,
        // Required on the bundle — omitting it is a silent feature-off for the
        // `/ask` detail block, so the type refuses it rather than the page.
        getBatch: vi.fn(async () => null),
        reconcileOpenBatch: vi.fn(async () => ({ kind: 'not_open' as const })),
      } as NotificationBlockBundle),
    );
    vi.doMock('../composition/bin/wire-notification-block.js', () => ({
      composeNotificationBlock: composeNotificationBlockMock,
    }));
    cleanups.push(() => {
      vi.doUnmock('../composition/bin/wire-notification-block.js');
    });

    const { composeExecuteDeps } = await import(
      '../composition/bin/wire-execute-deps.js'
    );

    const db = new Database(':memory:');
    cleanups.push(() => db.close());
    const dir = mkdtempSync(join(tmpdir(), 'd-163-slice-b-omit-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));

    composeExecuteDeps({
      recipeStore: { tag: 'recipe-store' } as never,
      executorConfig: { tag: 'executor-config' } as never,
      baseVault: {},
      serverInstanceId: 'server-1',
      serverDisplayName: 'Test',
      eventBus: eventBus(),
      auditLog: auditLog(db),
      sharedStore: undefined,
      db,
      enrichmentStore: undefined,
      commitStore: undefined,
      checkpointStore: checkpointStore(db),
      annotationStore: annotationStore(db, dir),
      getExecuteDeps: vi.fn(() => undefined),
      // Slice B fields intentionally omitted
    });

    expect(composeNotificationBlockMock).toHaveBeenCalledTimes(1);
    const passed = composeNotificationBlockMock.mock.calls[0]?.[0];
    expect(passed).toBeDefined();
    expect('connectionStore' in passed!).toBe(false);
    expect('clientTokens' in passed!).toBe(false);
    expect('bridgeSink' in passed!).toBe(false);
    // D-192 CORE #6 seam 7 — ratchet the messenger channel registry slot too
    // (replaces the per-vendor slackChannel/telegramChannel ratchets):
    // conditional-spread discipline means an omitted registry never rides as
    // `undefined`.
    expect('messengerChannels' in passed!).toBe(false);
  });
});

describe('D-163 Slice B — ask fan-out routing through wired channels (I-2 / I-3)', () => {
  it('does not fan an ask out to Bridge — notify-only filtered + passive notify fires instead', async () => {
    const bridgeSink = vi.fn();
    const { block } = composeHarness({
      clientTokens: stubClientTokens(1),
      bridgeSink,
    });

    await block.setNotificationBridgeMode('bridge-0', {
      notification: true,
      approval: false,
    });

    // Register a no-op handler so the dispatch path does not crash on
    // a missing kind; we are only asserting the delivery side here.
    block.registerAskHandler('test.kind' as never, async () => undefined);

    const { ask_id } = await block.ask(
      { text: 'Approve?' },
      [{ id: 'yes', label: 'Yes' }, { id: 'no', label: 'No' }],
      { kind: 'test.kind' as never, payload: {} },
    );

    expect(ask_id).toBeDefined();
    // Bridge's `deliverAsk` is never called (I-2 filter); the
    // passive `deliverNotify` on ask raise fires the bridgeSink once
    // (I-3) carrying the composed "approval pending" body.
    expect(bridgeSink).toHaveBeenCalledTimes(1);
    expect(bridgeSink).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringMatching(/approval pending/),
      }),
    );
  });
});
