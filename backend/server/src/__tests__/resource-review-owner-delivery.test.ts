import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import type { Checkpoint, ResourceReview } from '@recued/contracts';
import { buildPreflightAsk, raisePreflightAsk } from '@recued/gateway';
import {
  createAskStore, createNotificationBlock, createNotificationSettingsStore, createUiChannel,
  type Channel, type NotificationSettings, type PendingAsk, type UiNotificationEvent,
} from '@recued/notification';
import { createSQLiteCollection } from '../sqlite-collection.js';
import { handlePendingAsks } from '../history-handler.js';

const review = (): ResourceReview => ({
  schema_version: 1, operation: 'fixture.note.upsert', input_hash: 'a'.repeat(64), captured_at: 1000,
  resources: [{ kind: 'records', key: 'note-1', label: 'Private row label', binding: 'binding', version: 'absence',
    precondition: { kind: 'records_absent' }, before: {}, after: { id: 'note-1', title: 'private-value-marker' } }],
});
const checkpoint = (): Checkpoint => ({ checkpoint_id: 'cp', run_id: 'run', recipe_id: 'recipe',
  gated_step_id: 'write', step_state: {}, created_at: 1000, resource_review: review() });

describe('owner-only resource review delivery', () => {
  it('persists and recovers the same structured review in owner UI and history without including it in external delivery', async () => {
    const db = new Database(':memory:');
    try {
      const externalDelivery = vi.fn();
      const external: Channel = { name: 'slack', capability: 'inline', owns_llm_egress: false,
        deliverNotify: async () => {}, deliverAsk: externalDelivery, closeAsk: async () => {} };
      const boot = async () => {
        const events: UiNotificationEvent[] = [];
        const settings = createNotificationSettingsStore(createSQLiteCollection<NotificationSettings>(db, 'settings'));
        await settings.setChannelMode('slack', { notification: true, approval: true });
        const block = createNotificationBlock({ askStore: createAskStore(createSQLiteCollection<PendingAsk>(db, 'asks')),
          settingsStore: settings, channels: [createUiChannel({ busSink: e => events.push(e) }), external],
          now: () => 1000, askAnswerLink: id => 'https://example.test/ask/' + id });
        return { block, events };
      };
      const first = await boot();
      const cp = checkpoint(); const context = { recipe_id: 'recipe', gated_step_id: 'write' };
      const built = buildPreflightAsk({ checkpoint: cp, context });
      expect(built.extras?.resource_review).toEqual(cp.resource_review);
      const { ask_id } = await raisePreflightAsk(first.block, { checkpoint: cp, context });
      expect(first.events).toMatchObject([{ kind: 'notification.ask', resource_review: cp.resource_review }]);
      const stored = await first.block.getAsk(ask_id);
      expect(stored?.resource_review).toEqual(cp.resource_review);
      expect(JSON.stringify(stored?.message)).not.toContain('private-value-marker');
      expect(JSON.stringify(externalDelivery.mock.calls)).not.toContain('private-value-marker');
      expect(externalDelivery).toHaveBeenCalledTimes(1);
      const second = await boot();
      await second.block.recoverPendingAsks();
      expect(second.events).toMatchObject([{ kind: 'notification.ask', resource_review: cp.resource_review }]);
      expect(JSON.stringify(externalDelivery.mock.calls)).not.toContain('private-value-marker');
      expect(externalDelivery).toHaveBeenCalledTimes(2);
      expect(await handlePendingAsks({ listOpenAsks: () => second.block.listOpenAsks() }))
        .toMatchObject({ asks: [{ ask_id, resource_review: cp.resource_review }] });
    } finally { db.close(); }
  });

  it('clones review evidence before awaiting persistence and rejects a reserved-ID replay with different evidence', async () => {
    const db = new Database(':memory:');
    try {
      const events: UiNotificationEvent[] = [];
      const block = createNotificationBlock({ askStore: createAskStore(createSQLiteCollection<PendingAsk>(db, 'asks')),
        settingsStore: createNotificationSettingsStore(createSQLiteCollection<NotificationSettings>(db, 'settings')),
        channels: [createUiChannel({ busSink: e => events.push(e) })], now: () => 1000 });
      const payload = review(); const original = structuredClone(payload);
      const message = { text: 'Review in Recued' }; const options = [{ id: 'approve', label: 'Approve' }];
      const handler = { kind: 'gateway.preflight', payload: { checkpoint_id: 'cp' } };
      const extras = { reserved_ask_id: 'reserved', resource_review: payload, on_persisted: () => {
        payload.resources[0]!.after!.title = 'Changed by the caller';
      } };
      await block.ask(message, options, handler, undefined, extras);
      expect((await block.getAsk('reserved'))?.resource_review).toEqual(original);
      expect(events).toMatchObject([{ resource_review: original }]);
      await expect(block.ask(message, options, handler, undefined, { reserved_ask_id: 'reserved', resource_review: payload }))
        .rejects.toThrow(/different ask/);
    } finally { db.close(); }
  });
});
