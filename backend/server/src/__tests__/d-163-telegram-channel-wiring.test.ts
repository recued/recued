/** D-163 Telegram-adapter slice — composeNotificationBlock wiring tests.
 *
 *  Parallel to `d-163-slack-channel-wiring.test.ts`. Slice B's probe
 *  reports `not_ready` for telegram because no adapter is wired; this
 *  slice flips that: with the Telegram `RemoteChannel` plumbed through
 *  the new `telegramChannel` slot, the probe flips `ready` whenever a
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
 *  delivery wire-shape (covered by
 *  `d-163-telegram-channel-composer.test.ts`). */
const stubTelegramChannel = (): RemoteChannel => ({
  name: 'telegram',
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
  telegramChannel?: RemoteChannel;
}

const composeHarness = (overrides: HarnessOverrides = {}) => {
  const db = new Database(':memory:');
  cleanups.push(() => db.close());
  // composeNotificationBlock unconditionally builds the D-192 Slice 6b
  // container-pick store (`createSourceDependencyEntityStore`), so its table
  // must exist before construction — mirrors `checkpointStore`'s
  // `ensureCheckpointSchema`.
  ensureSourceDependencyEntitySchema(db);
  const dir = mkdtempSync(join(tmpdir(), 'd-163-telegram-wiring-'));
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
    ...(overrides.telegramChannel ? { messengerChannels: { telegram: overrides.telegramChannel } } : {}),
  });

  return { block };
};

describe('D-163 Telegram — probe + Settings rendering', () => {
  it('reports telegram ready=true when the credential row exists AND the telegramChannel is wired', async () => {
    const { block } = composeHarness({
      connectionStore: stubConnectionStore([{ kind: 'notification', name: 'telegram' }]),
      telegramChannel: stubTelegramChannel(),
    });

    const rows = await block.describeNotificationChannels();
    const telegramRow = rows.find((r) => r.channel === 'telegram');
    expect(telegramRow, 'telegram row should exist').toBeDefined();
    expect(telegramRow!.ready).toBe(true);
    expect(telegramRow!.capability).toBe('inline');
    expect(telegramRow!.notification_togglable).toBe(true);
  });

  it('reports telegram ready=false when adapter is wired but no credential row exists (fail-closed on row)', async () => {
    const { block } = composeHarness({
      // connectionStore omitted entirely
      telegramChannel: stubTelegramChannel(),
    });

    const rows = await block.describeNotificationChannels();
    const telegramRow = rows.find((r) => r.channel === 'telegram');
    expect(telegramRow!.ready).toBe(false);
  });

  it('reports telegram ready=false when credential row exists but adapter is NOT wired (Slice B fail-closed preserved)', async () => {
    const { block } = composeHarness({
      connectionStore: stubConnectionStore([{ kind: 'notification', name: 'telegram' }]),
      // telegramChannel omitted
    });

    const rows = await block.describeNotificationChannels();
    const telegramRow = rows.find((r) => r.channel === 'telegram');
    expect(telegramRow!.ready).toBe(false);
  });

  it('accepts setChannel(telegram, true) once both adapter + credential are present', async () => {
    const { block } = composeHarness({
      connectionStore: stubConnectionStore([{ kind: 'notification', name: 'telegram' }]),
      telegramChannel: stubTelegramChannel(),
    });

    const result = await block.setNotificationChannelMode('telegram', { notification: true, approval: true });
    expect(result.ok).toBe(true);
  });

  it('rejects setChannel(telegram, true) with not_ready when adapter is wired but no credential exists', async () => {
    const { block } = composeHarness({
      telegramChannel: stubTelegramChannel(),
    });

    const result = await block.setNotificationChannelMode('telegram', { notification: true, approval: true });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('not_ready');
    }
  });
});

describe('D-163 Telegram — fan-out routing through the wired channel (I-2 inline path)', () => {
  it('routes deliverNotify to the telegram channel when enabled', async () => {
    const telegram = stubTelegramChannel();
    const { block } = composeHarness({
      connectionStore: stubConnectionStore([{ kind: 'notification', name: 'telegram' }]),
      telegramChannel: telegram,
    });

    await block.setNotificationChannelMode('telegram', { notification: true, approval: true });
    await block.notify({ text: 'hello telegram' });

    expect(telegram.deliverNotify).toHaveBeenCalledTimes(1);
    expect(telegram.deliverNotify).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'hello telegram' }),
    );
  });

  it('routes deliverAsk to the telegram channel (inline capability — no filter)', async () => {
    const telegram = stubTelegramChannel();
    const { block } = composeHarness({
      connectionStore: stubConnectionStore([{ kind: 'notification', name: 'telegram' }]),
      telegramChannel: telegram,
    });

    await block.setNotificationChannelMode('telegram', { notification: true, approval: true });
    block.registerAskHandler('test.kind' as never, async () => undefined);

    const { ask_id } = await block.ask(
      { text: 'Approve?' },
      [{ id: 'yes', label: 'Yes' }, { id: 'no', label: 'No' }],
      { kind: 'test.kind' as never, payload: {} },
    );

    expect(ask_id).toBeDefined();
    expect(telegram.deliverAsk).toHaveBeenCalledTimes(1);
    expect(telegram.deliverNotify).not.toHaveBeenCalled();
  });

  it('does NOT fan out to telegram when telegramChannel is omitted from deps', async () => {
    const { block } = composeHarness({
      connectionStore: stubConnectionStore([{ kind: 'notification', name: 'telegram' }]),
      // telegramChannel omitted — adapter-presence gate keeps telegram out
    });

    const result = await block.setNotificationChannelMode('telegram', { notification: true, approval: true });
    // Probe says not_ready (no adapter), so toggle rejects — no channel
    // to fan out to in the first place.
    expect(result.ok).toBe(false);
  });
});

describe('D-163 Telegram — coexists with Slack without cross-contamination', () => {
  it('routes deliverNotify only to telegram when slack is not wired', async () => {
    const telegram = stubTelegramChannel();
    const { block } = composeHarness({
      connectionStore: stubConnectionStore([
        { kind: 'notification', name: 'telegram' },
        // slack row present but no adapter wired → slack stays not_ready
        { kind: 'notification', name: 'slack' },
      ]),
      telegramChannel: telegram,
    });

    await block.setNotificationChannelMode('telegram', { notification: true, approval: true });
    // Attempt to enable slack — should reject (no adapter).
    const slackResult = await block.setNotificationChannelMode('slack', {
      notification: true,
      approval: true,
    });
    expect(slackResult.ok).toBe(false);

    await block.notify({ text: 'hello' });
    // Only telegram receives the notify; slack stays out of allChannels.
    expect(telegram.deliverNotify).toHaveBeenCalledTimes(1);
  });
});
