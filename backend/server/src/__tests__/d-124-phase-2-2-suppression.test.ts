/** D-124 Phase 2.2 — suppression at dispatcher.
 *
 *  Phase 2.1 landed the substrate (`backfill_complete` column +
 *  `markBackfillComplete` writer + `BackfillStateLookup` helper).
 *  Phase 2.2 wires the gate into `EventTriggerDispatcher.onEvent`:
 *  events emitted while the source adapter is mid-drain go through
 *  the bus normally (FTS / heartbeat / realtime broadcast still see
 *  them) but the trigger fan-out short-circuits silently.
 *
 *  Coverage:
 *    1. Suppressed during drain — runRecipe NOT called, `last_fired_at`
 *       NOT updated, error counter NOT touched.
 *    2. Fires after `markBackfillComplete` — at once, with no restart.
 *    3. Fires immediately for vacuous platforms (webhook / service).
 *    4. Fires for unknown rows (suppression is opt-in by row presence).
 *    5. Fires for `data.contact.*` only when both mail + calendar
 *       feeders have completed.
 *    6. Bus subscribers other than the dispatcher (the realtime
 *       broadcast bridge proxy) keep seeing every event regardless.
 *    7. Optional dep — when `backfillState` is omitted, the dispatcher
 *       behaves as if every adapter is fully drained.
 *    8. Pattern matching defense-in-depth still applies on top of
 *       the gate.
 */

import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createWarehouseEventBus,
  type WarehouseEvent,
} from '@recued/warehouse-events';
import type { FileCollectionCaps } from '@recued/contracts';
import { createEventTriggersStore } from '../triggers/store.js';
import {
  createEventTriggerDispatcher,
  type TriggerDispatchRuntime,
} from '../triggers/dispatcher.js';
import { createBackfillStateLookup } from '../triggers/backfill-state.js';
import { createInstanceStore } from '../collections/instance-store.js';

type RunRecipe = TriggerDispatchRuntime['runRecipe'];

const fileCaps = (): FileCollectionCaps => ({
  read: 'yes',
  write: 'yes',
  delete: 'yes',
  watch: 'realtime',
  mirror: 'optional',
  auth: 'none',
  path_style: 'posix',
});

interface Harness {
  db: Database.Database;
  bus: ReturnType<typeof createWarehouseEventBus>;
  store: ReturnType<typeof createEventTriggersStore>;
  instances: ReturnType<typeof createInstanceStore>;
  lookup: ReturnType<typeof createBackfillStateLookup>;
  runRecipe: ReturnType<typeof vi.fn> & RunRecipe;
}

const newHarness = (): Harness => {
  const db = new Database(':memory:');
  const bus = createWarehouseEventBus();
  const store = createEventTriggersStore(db);
  const instances = createInstanceStore({ db });
  const lookup = createBackfillStateLookup({ instances });
  const runRecipe = vi.fn<RunRecipe>().mockResolvedValue(undefined);
  return { db, bus, store, instances, lookup, runRecipe };
};

const emit = (
  bus: ReturnType<typeof createWarehouseEventBus>,
  partial: Partial<WarehouseEvent> & Pick<WarehouseEvent, 'platform' | 'slug' | 'entity_type' | 'event_kind'>,
): void => {
  bus.emit({
    record_id: 'rec-1',
    at: 9_000,
    ...partial,
  });
};

const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

// ────────────────────────────────────────────────────────────────
// Suppression while draining
// ────────────────────────────────────────────────────────────────

describe('D-124 Phase 2.2 — dispatcher backfill gate', () => {
  let h: Harness;
  beforeEach(() => { h = newHarness(); });

  it('suppresses runRecipe while the source adapter is mid-drain', async () => {
    h.instances.upsert({
      platform: 'mail',
      slug: 'work',
      adapter_type: 'imap',
      config: {},
      caps: fileCaps(),
      auth_state: 'healthy',
      last_synced_at: null,
    });
    h.store.create({
      trigger_id: 't-mail',
      recipe_id: 'r-mail',
      publisher_id: 'local',
      pattern: 'data.mail.**.created',
      enabled: true,
      created_at: 1_000,
    });
    const dispatcher = createEventTriggerDispatcher({
      bus: h.bus,
      store: h.store,
      runtime: { runRecipe: h.runRecipe },
      backfillState: h.lookup,
      now: () => 10_000,
    });
    dispatcher.rebuild();

    emit(h.bus, {
      platform: 'mail',
      slug: 'work',
      entity_type: 'message',
      event_kind: 'created',
    });
    await flush();

    expect(h.runRecipe).not.toHaveBeenCalled();
    // last_fired_at NOT updated — the dispatcher never reached the
    // try block. Phase 2.2's gate is a hard short-circuit.
    expect(h.store.get('t-mail')?.last_fired_at).toBeNull();
  });

  it('suppresses what a draining collection published on another’s behalf: a mailbox’s first scan and its attachments', async () => {
    h.store.create({
      trigger_id: 't-file',
      recipe_id: 'r-file',
      publisher_id: 'local',
      pattern: 'data.file.received.*.created',
      enabled: true,
      created_at: 1_000,
    });
    const dispatcher = createEventTriggerDispatcher({
      bus: h.bus,
      store: h.store,
      runtime: { runRecipe: h.runRecipe },
      backfillState: h.lookup,
      now: () => 10_000,
    });
    dispatcher.rebuild();
    // The received files never drain: their own state says complete. The
    // event says whose drain it came from.
    emit(h.bus, { platform: 'file', slug: 'received', entity_type: 'file', event_kind: 'created', in_drain: true });
    await flush();
    expect(h.runRecipe).not.toHaveBeenCalled();
    emit(h.bus, { platform: 'file', slug: 'received', entity_type: 'file', event_kind: 'created', record_id: 'rec-2' });
    await flush();
    expect(h.runRecipe).toHaveBeenCalledTimes(1);
  });

  it('never captures a drained event as a pre-approval candidate', async () => {
    h.store.create({
      trigger_id: 't-file',
      recipe_id: 'r-file',
      publisher_id: 'local',
      pattern: 'data.file.received.*.created',
      enabled: true,
      created_at: 1_000,
    });
    const captureTrigger = vi.fn(() => null);
    const dispatcher = createEventTriggerDispatcher({
      bus: h.bus,
      store: h.store,
      runtime: { runRecipe: h.runRecipe },
      backfillState: h.lookup,
      getPreapprovalDriver: () => ({ captureTrigger }) as never,
      now: () => 10_000,
    });
    dispatcher.rebuild();
    emit(h.bus, { platform: 'file', slug: 'received', entity_type: 'file', event_kind: 'created', in_drain: true });
    await flush();
    expect(captureTrigger).not.toHaveBeenCalled();
    emit(h.bus, { platform: 'file', slug: 'received', entity_type: 'file', event_kind: 'created', record_id: 'rec-2' });
    await flush();
    expect(captureTrigger).toHaveBeenCalledTimes(1);
  });

  it('⛔ fires after markBackfillComplete — at once, with no restart and no invalidation', async () => {
    h.instances.upsert({
      platform: 'mail',
      slug: 'work',
      adapter_type: 'imap',
      config: {},
      caps: fileCaps(),
      auth_state: 'healthy',
      last_synced_at: null,
    });
    h.store.create({
      trigger_id: 't-mail',
      recipe_id: 'r-mail',
      publisher_id: 'local',
      pattern: 'data.mail.**.created',
      enabled: true,
      created_at: 1_000,
    });
    const dispatcher = createEventTriggerDispatcher({
      bus: h.bus,
      store: h.store,
      runtime: { runRecipe: h.runRecipe },
      backfillState: h.lookup,
      now: () => 10_000,
    });
    dispatcher.rebuild();

    // Pre-flip event suppressed.
    emit(h.bus, {
      platform: 'mail',
      slug: 'work',
      entity_type: 'message',
      event_kind: 'created',
      record_id: 'pre',
    });
    await flush();
    expect(h.runRecipe).not.toHaveBeenCalled();

    // Adapter signals drain done — and that is ALL production does. This
    // test used to call `h.lookup.invalidate(...)` here, "standing in" for
    // compose-root wiring that never shipped; the lookup cached `false`, so
    // in production a new mailbox's triggers stayed silent until a restart.
    h.instances.markBackfillComplete('mail', 'work');

    emit(h.bus, {
      platform: 'mail',
      slug: 'work',
      entity_type: 'message',
      event_kind: 'created',
      record_id: 'post',
    });
    await flush();
    expect(h.runRecipe).toHaveBeenCalledOnce();
    expect(h.store.get('t-mail')?.last_fired_at).toBe(10_000);
  });

  it('fires immediately for webhook (vacuous-true platform)', async () => {
    h.instances.upsert({
      platform: 'webhook',
      slug: 'github',
      adapter_type: 'webhook',
      config: {},
      caps: fileCaps(),
      auth_state: 'healthy',
      last_synced_at: null,
    });
    h.store.create({
      trigger_id: 't-wh',
      recipe_id: 'r-wh',
      publisher_id: 'local',
      pattern: 'data.webhook.**.created',
      enabled: true,
      created_at: 1_000,
    });
    const dispatcher = createEventTriggerDispatcher({
      bus: h.bus,
      store: h.store,
      runtime: { runRecipe: h.runRecipe },
      backfillState: h.lookup,
      now: () => 10_000,
    });
    dispatcher.rebuild();

    emit(h.bus, {
      platform: 'webhook',
      slug: 'github',
      entity_type: 'delivery',
      event_kind: 'created',
    });
    await flush();
    // Webhook collections are append-only — no drain window — so
    // the gate returns true even though the bool defaults false.
    expect(h.runRecipe).toHaveBeenCalledOnce();
  });

  it('fires for unknown rows (suppression is row-presence-opt-in)', async () => {
    // No instance row enrolled. Helper returns true for unknown
    // (platform, slug) so events still flow.
    h.store.create({
      trigger_id: 't-unknown',
      recipe_id: 'r-unknown',
      publisher_id: 'local',
      pattern: 'data.shared.**.created',
      enabled: true,
      created_at: 1_000,
    });
    const dispatcher = createEventTriggerDispatcher({
      bus: h.bus,
      store: h.store,
      runtime: { runRecipe: h.runRecipe },
      backfillState: h.lookup,
      now: () => 10_000,
    });
    dispatcher.rebuild();

    emit(h.bus, {
      platform: 'shared',
      slug: 'note',
      entity_type: 'record',
      event_kind: 'created',
    });
    await flush();
    expect(h.runRecipe).toHaveBeenCalledOnce();
  });

  it('contact triggers fire only after both mail + calendar feeders complete', async () => {
    h.instances.upsert({
      platform: 'mail',
      slug: 'inbox',
      adapter_type: 'imap',
      config: {},
      caps: fileCaps(),
      auth_state: 'healthy',
      last_synced_at: null,
    });
    h.instances.upsert({
      platform: 'calendar',
      slug: 'personal',
      adapter_type: 'gcal',
      config: {},
      caps: fileCaps(),
      auth_state: 'healthy',
      last_synced_at: null,
    });
    h.store.create({
      trigger_id: 't-contact',
      recipe_id: 'r-contact',
      publisher_id: 'local',
      pattern: 'data.contact.**.created',
      enabled: true,
      created_at: 1_000,
    });
    const dispatcher = createEventTriggerDispatcher({
      bus: h.bus,
      store: h.store,
      runtime: { runRecipe: h.runRecipe },
      backfillState: h.lookup,
      now: () => 10_000,
    });
    dispatcher.rebuild();

    // Both feeders mid-drain — contact suppressed.
    emit(h.bus, {
      platform: 'contact',
      slug: 'derived',
      entity_type: 'contact',
      event_kind: 'created',
      record_id: 'c-1',
    });
    await flush();
    expect(h.runRecipe).not.toHaveBeenCalled();

    // Only mail done — still suppressed.
    h.instances.markBackfillComplete('mail', 'inbox');
    emit(h.bus, {
      platform: 'contact',
      slug: 'derived',
      entity_type: 'contact',
      event_kind: 'created',
      record_id: 'c-2',
    });
    await flush();
    expect(h.runRecipe).not.toHaveBeenCalled();

    // Both done — fires.
    h.instances.markBackfillComplete('calendar', 'personal');
    emit(h.bus, {
      platform: 'contact',
      slug: 'derived',
      entity_type: 'contact',
      event_kind: 'created',
      record_id: 'c-3',
    });
    await flush();
    expect(h.runRecipe).toHaveBeenCalledOnce();
  });

  it('bus.emit is unchanged — other subscribers see suppressed events', async () => {
    h.instances.upsert({
      platform: 'mail',
      slug: 'work',
      adapter_type: 'imap',
      config: {},
      caps: fileCaps(),
      auth_state: 'healthy',
      last_synced_at: null,
    });
    h.store.create({
      trigger_id: 't-mail',
      recipe_id: 'r-mail',
      publisher_id: 'local',
      pattern: 'data.mail.**.created',
      enabled: true,
      created_at: 1_000,
    });

    // Stand-in for the realtime broadcast bridge / FTS index /
    // heartbeat consumers — anything that wires to the bus directly.
    const observed: WarehouseEvent[] = [];
    h.bus.subscribe('**', (event) => { observed.push(event); });

    const dispatcher = createEventTriggerDispatcher({
      bus: h.bus,
      store: h.store,
      runtime: { runRecipe: h.runRecipe },
      backfillState: h.lookup,
      now: () => 10_000,
    });
    dispatcher.rebuild();

    emit(h.bus, {
      platform: 'mail',
      slug: 'work',
      entity_type: 'message',
      event_kind: 'created',
      record_id: 'msg-suppressed',
    });
    await flush();

    expect(h.runRecipe).not.toHaveBeenCalled();
    // The other subscriber DID see the event. Bus emit is a fan-out
    // concern; only the trigger pipeline short-circuits.
    expect(observed).toHaveLength(1);
    expect(observed[0].record_id).toBe('msg-suppressed');
  });

  it('omitting backfillState passes every event through (legacy compatibility)', async () => {
    h.instances.upsert({
      platform: 'mail',
      slug: 'work',
      adapter_type: 'imap',
      config: {},
      caps: fileCaps(),
      auth_state: 'healthy',
      last_synced_at: null,
    });
    h.store.create({
      trigger_id: 't-mail',
      recipe_id: 'r-mail',
      publisher_id: 'local',
      pattern: 'data.mail.**.created',
      enabled: true,
      created_at: 1_000,
    });
    // No backfillState dep — gate noop, every event flows.
    const dispatcher = createEventTriggerDispatcher({
      bus: h.bus,
      store: h.store,
      runtime: { runRecipe: h.runRecipe },
      now: () => 10_000,
    });
    dispatcher.rebuild();

    emit(h.bus, {
      platform: 'mail',
      slug: 'work',
      entity_type: 'message',
      event_kind: 'created',
    });
    await flush();
    expect(h.runRecipe).toHaveBeenCalledOnce();
  });

  it('suppression does NOT count toward the auto-disable error cap', async () => {
    h.instances.upsert({
      platform: 'mail',
      slug: 'work',
      adapter_type: 'imap',
      config: {},
      caps: fileCaps(),
      auth_state: 'healthy',
      last_synced_at: null,
    });
    h.store.create({
      trigger_id: 't-mail',
      recipe_id: 'r-mail',
      publisher_id: 'local',
      pattern: 'data.mail.**.created',
      enabled: true,
      created_at: 1_000,
    });
    const dispatcher = createEventTriggerDispatcher({
      bus: h.bus,
      store: h.store,
      runtime: { runRecipe: h.runRecipe },
      backfillState: h.lookup,
      autoDisableAfterErrors24h: 2,
      now: () => 10_000,
    });
    dispatcher.rebuild();

    // 5 backfill events fire while the bool is false. None reach
    // runRecipe (so no errors), and the trigger stays enabled.
    for (let i = 0; i < 5; i++) {
      emit(h.bus, {
        platform: 'mail',
        slug: 'work',
        entity_type: 'message',
        event_kind: 'created',
        record_id: `m-${i}`,
      });
    }
    await flush();
    const row = h.store.get('t-mail')!;
    expect(row.enabled).toBe(true);
    expect(row.last_error).toBeNull();
  });
});
