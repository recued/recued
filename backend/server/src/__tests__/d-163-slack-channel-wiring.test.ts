/** D-163 Slack-adapter slice — composeNotificationBlock wiring tests.
 *
 *  Slice B pinned the probe's fail-closed posture: slack stays
 *  `not_ready` even when a `connection.notification.slack` credential
 *  is enrolled, because no adapter was wired. This file pins the
 *  positive companion: with the slack `RemoteChannel` plumbed through
 *  the new `slackChannel` slot, the probe flips `ready` whenever a
 *  credential row exists, and the channel rides the standard ask /
 *  notify fan-out. */

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
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RemoteChannel } from '@recued/notification';
import type { EventBus } from '../events/bus.js';
import { ensureCheckpointSchema } from '../memory-schema.js';
import { ensureSourceDependencyEntitySchema } from '../storage/source-dependency-entity-store.js';
import {
  composeNotificationBlock,
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

const stubClientTokens = (bridgeRows: number): ClientTokenStore =>
  ({
    list: vi.fn((opts?: { client_kind?: string }) => {
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

/** Minimal RemoteChannel stub — the wiring tests care about the
 *  channel's identity + the fact that it's in `allChannels`, not its
 *  delivery wire-shape (covered by `d-163-slack-channel-composer.test.ts`). */
const stubSlackChannel = (): RemoteChannel => ({
  name: 'slack',
  capability: 'inline',
  owns_llm_egress: false,
  deliverNotify: vi.fn(async () => undefined),
  deliverAsk: vi.fn(async () => undefined),
  closeAsk: vi.fn(async () => undefined),
  parseInboundMessage: vi.fn(() => null),
  parseInboundReply: vi.fn(() => null),
});

interface HarnessOverrides {
  connectionStore?: ConnectionStoreSqlite;
  clientTokens?: ClientTokenStore;
  slackChannel?: RemoteChannel;
}

const composeHarness = (overrides: HarnessOverrides = {}) => {
  const db = new Database(':memory:');
  cleanups.push(() => db.close());
  // composeNotificationBlock unconditionally builds the D-192 Slice 6b
  // container-pick store (`createSourceDependencyEntityStore`), so its table
  // must exist before construction — mirrors `checkpointStore`'s
  // `ensureCheckpointSchema`.
  ensureSourceDependencyEntitySchema(db);
  const dir = mkdtempSync(join(tmpdir(), 'd-163-slack-wiring-'));
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
    ...(overrides.slackChannel ? { messengerChannels: { slack: overrides.slackChannel } } : {}),
  });

  return { block };
};

describe('D-163 Slack — probe + Settings rendering', () => {
  it('reports slack ready=true when the credential row exists AND the slackChannel is wired', async () => {
    const { block } = composeHarness({
      connectionStore: stubConnectionStore([{ kind: 'notification', name: 'slack' }]),
      slackChannel: stubSlackChannel(),
    });

    const rows = await block.describeNotificationChannels();
    const slackRow = rows.find((r) => r.channel === 'slack');
    expect(slackRow, 'slack row should exist').toBeDefined();
    expect(slackRow!.ready).toBe(true);
    expect(slackRow!.capability).toBe('inline');
    expect(slackRow!.notification_togglable).toBe(true);
  });

  it('reports slack ready=false when adapter is wired but no credential row exists (fail-closed on row)', async () => {
    const { block } = composeHarness({
      // connectionStore omitted entirely
      slackChannel: stubSlackChannel(),
    });

    const rows = await block.describeNotificationChannels();
    const slackRow = rows.find((r) => r.channel === 'slack');
    expect(slackRow!.ready).toBe(false);
  });

  it('reports slack ready=false when credential row exists but adapter is NOT wired (Slice B fail-closed preserved)', async () => {
    const { block } = composeHarness({
      connectionStore: stubConnectionStore([{ kind: 'notification', name: 'slack' }]),
      // slackChannel omitted
    });

    const rows = await block.describeNotificationChannels();
    const slackRow = rows.find((r) => r.channel === 'slack');
    expect(slackRow!.ready).toBe(false);
  });

  it('accepts setChannel(slack, true) once both adapter + credential are present', async () => {
    const { block } = composeHarness({
      connectionStore: stubConnectionStore([{ kind: 'notification', name: 'slack' }]),
      slackChannel: stubSlackChannel(),
    });

    const result = await block.setNotificationChannelMode('slack', { notification: true, approval: true });
    expect(result.ok).toBe(true);
  });

  it('rejects setChannel(slack, true) with not_ready when adapter is wired but no credential exists', async () => {
    const { block } = composeHarness({
      slackChannel: stubSlackChannel(),
    });

    const result = await block.setNotificationChannelMode('slack', { notification: true, approval: true });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('not_ready');
    }
  });
});

describe('D-163 Slack — fan-out routing through the wired channel (I-2 inline path)', () => {
  it('routes deliverNotify to the slack channel when enabled', async () => {
    const slack = stubSlackChannel();
    const { block } = composeHarness({
      connectionStore: stubConnectionStore([{ kind: 'notification', name: 'slack' }]),
      slackChannel: slack,
    });

    await block.setNotificationChannelMode('slack', { notification: true, approval: true });
    await block.notify({ text: 'hello slack' });

    expect(slack.deliverNotify).toHaveBeenCalledTimes(1);
    expect(slack.deliverNotify).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'hello slack' }),
    );
  });

  it('routes deliverAsk to the slack channel (inline capability — no filter)', async () => {
    const slack = stubSlackChannel();
    const { block } = composeHarness({
      connectionStore: stubConnectionStore([{ kind: 'notification', name: 'slack' }]),
      slackChannel: slack,
    });

    await block.setNotificationChannelMode('slack', { notification: true, approval: true });
    block.registerAskHandler('test.kind' as never, async () => undefined);

    const { ask_id } = await block.ask(
      { text: 'Approve?' },
      [{ id: 'yes', label: 'Yes' }, { id: 'no', label: 'No' }],
      { kind: 'test.kind' as never, payload: {} },
    );

    expect(ask_id).toBeDefined();
    expect(slack.deliverAsk).toHaveBeenCalledTimes(1);
    expect(slack.deliverNotify).not.toHaveBeenCalled();
  });

  it('does NOT fan out to slack when slackChannel is omitted from deps', async () => {
    const { block } = composeHarness({
      connectionStore: stubConnectionStore([{ kind: 'notification', name: 'slack' }]),
      // slackChannel omitted — adapter-presence gate keeps slack out
    });

    const result = await block.setNotificationChannelMode('slack', { notification: true, approval: true });
    // Probe says not_ready (no adapter), so toggle rejects — no channel
    // to fan out to in the first place.
    expect(result.ok).toBe(false);
  });
});
