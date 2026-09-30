/** D-121 Phase 6 — emit-site bridges + helpers.
 *
 *  Wires the realtime broadcast bus to the existing domain emit
 *  paths. Two patterns:
 *
 *    1. **Bridge** — a one-time subscription set up at server boot
 *       that translates an existing emit (e.g. warehouse-events bus)
 *       into a `ServerEvent` on the new bus. The original consumers
 *       continue to fire normally — this is purely additive.
 *    2. **Helper** — a small `emit*()` function callers invoke
 *       directly when their domain doesn't have a pre-existing
 *       broadcast channel (execution lifecycle, schedule fired,
 *       service lifecycle).
 *
 *  All bus emits are best-effort: throws are swallowed so an emit
 *  never aborts the underlying domain operation. Recovery on the
 *  client is via cursor-since replay; falling off the ring triggers
 *  a full re-sync.
 *
 *  Bridges return their unsubscribe handle so tests + shutdown
 *  paths can detach cleanly. */

import type {
  EnrichmentScope,
  ExposureChangedEvent,
  ServerEvent,
} from '@recued/contracts';
import type { NotificationSubtype } from '@recued/contracts';
import { isPlatformReferenceScope } from '@recued/contracts';
import type {
  WarehouseEvent,
  WarehouseEventBus,
  WarehouseEventKind,
} from '@recued/warehouse-events';
import type { EventBus, ServerEventInput } from './bus.js';

/** Translate a warehouse `event_kind` to the `ServerEvent.warehouse.op`
 *  field. `synced` + the D-145 PA4 derived kinds are batch-tick /
 *  reactive-only signals with no UI-layer meaning at the warehouse-
 *  explorer surface — the bridge skips them (subscribers that care
 *  wire in via the `warehouse-events` bus directly). */
const opForKind = (kind: WarehouseEventKind): 'insert' | 'update' | 'delete' | null => {
  switch (kind) {
    case 'created': return 'insert';
    case 'updated': return 'update';
    case 'deleted': return 'delete';
    case 'synced':  return null;
    // D-145 PA4 — work-entity-derived kinds (`completed` / `due_soon`
    // / `overdue` / `state_changed`) ride the recipe-trigger path
    // only; the warehouse-explorer surface doesn't render them
    // discrete from the underlying `updated` / `deleted` they
    // accompany.
    case 'completed':
    case 'due_soon':
    case 'overdue':
    case 'state_changed':
      return null;
    // D-179 P4 — run-outcome events (`platform: 'run'`) are a
    // trigger-source family, not warehouse rows; nothing to render
    // at the explorer surface.
    case 'failed':
      return null;
  }
};

/** Subscribe the realtime broadcast bus to the warehouse-events bus.
 *  Every record-level mail / calendar / file / contact / webhook
 *  change becomes a `kind: 'warehouse'` ServerEvent fanned out to
 *  every subscribed client. `synced` ticks are intentionally skipped
 *  — they're a server-internal batch signal, not a UI-relevant
 *  record change. */
export const bridgeWarehouseEvents = (
  bus: EventBus,
  warehouseBus: WarehouseEventBus,
): (() => void) => {
  return warehouseBus.subscribe('**', (ev: WarehouseEvent) => {
    const op = opForKind(ev.event_kind);
    if (op === null) return;
    if (!ev.record_id) return;
    try {
      bus.emit({
        kind: 'warehouse',
        // Use the platform as the canonical collection slug — that's
        // what matches the warehouse explorer routes (`mail`,
        // `calendar`, `file`, `webhook`, `contact`). The instance
        // `slug` (e.g. `work` / `personal`) lives a level below
        // and isn't part of the surface that listeners filter on.
        collection: ev.platform,
        op,
        id: ev.record_id,
      });
    } catch {
      /* never abort the original emit chain on bus failure */
    }
  });
};

/** D-122 follow-on — bridge warehouse change events into the
 *  enrichment-substrate cascade engine. Mirrors `bridgeWarehouseEvents`
 *  for the broadcast bus, but routes into the cascade engine instead.
 *
 *  Scope: mail / calendar / file / contact only — the enrichment
 *  registry's `valid_scopes` field constrains which scopes carry
 *  registered topics; webhook + service have no enrichment topics
 *  today, so emitting on those would spend a registry walk for zero
 *  hits. The narrow keeps the steady-state cost down.
 *
 *  Two events fire here:
 *
 *    - **`updated`** for all four scopes — purely additive (no other
 *      source-update fire site exists), so subscribing here is safe.
 *      `dependent`-policy enrichment rows mark stale + drop sidecars;
 *      reactive producers repopulate on next fire.
 *
 *    - **`deleted`** for calendar only — calendar deletes flow only
 *      through this bus (the `collection.deleteRecord` rpc's PLATFORMS
 *      allowlist excludes calendar; calendar uses its own
 *      `calendar.deleteEvent` dispatcher path which calls
 *      `applyVerifiedDelete` → `emitter.deleted`). Mail / file deletes
 *      are covered by the synchronous `collection.deleteRecord`
 *      cascade hook; contact deletes by `ContactStore.delete`'s
 *      `onDelete` callback. Subscribing to `**.deleted` for those
 *      three platforms here would double-fire — the bridge filters
 *      to calendar so each delete path runs the cascade exactly once.
 *
 *  Best-effort — exceptions inside the cascade are swallowed so a
 *  cascade failure never aborts the warehouse event chain. */
export const bridgeEnrichmentCascade = (
  warehouseBus: WarehouseEventBus,
  cascade: {
    cascadeForSourceUpdate: (scope: EnrichmentScope, source_id: string) => unknown;
    cascadeForSourceDelete: (scope: EnrichmentScope, source_id: string) => unknown;
  },
): (() => void) => {
  return warehouseBus.subscribe('**', (ev: WarehouseEvent) => {
    if (!ev.record_id) return;
    // D-128 — `connection.api.<vendor>.<entity>` platform-reference
    // scopes flow through the same bridge. The reconciliation harness
    // (`buildVendorReconciliationTask`) emits warehouse events with
    // `platform: 'connection.api.<vendor>.<entity>'`; the cascade engine
    // narrows on `valid_scopes` so only topics opted-in to that scope
    // react. Update + delete are both supported (CRMs, unlike calendar,
    // surface deletes via the reconciler's `listDeletedSince` hook).
    const isPlatformRef = isPlatformReferenceScope(ev.platform);
    const supported =
      ev.platform === 'mail'
      || ev.platform === 'calendar'
      || ev.platform === 'file'
      || ev.platform === 'contact'
      || isPlatformRef;
    if (!supported) return;
    try {
      if (ev.event_kind === 'updated' || (isPlatformRef && ev.event_kind === 'created')) {
        // D-128 — `created` events from the reconciliation harness
        // also enter the cascade so producers reading `valid_scopes`
        // for the platform-reference scope can react on first sighting.
        // Closed-list scopes' `created` events stay no-op here because
        // their original emit-paths route through the producer harness
        // directly; bridging would double-fire.
        cascade.cascadeForSourceUpdate(ev.platform as EnrichmentScope, ev.record_id);
      } else if (
        ev.event_kind === 'deleted'
        && (ev.platform === 'calendar' || isPlatformRef)
      ) {
        cascade.cascadeForSourceDelete(ev.platform as EnrichmentScope, ev.record_id);
      }
    } catch {
      /* never abort the original emit chain on cascade failure */
    }
  });
};

// ────────────────────────────────────────────────────────────────
// Domain helpers — direct emit
// ────────────────────────────────────────────────────────────────

/** Memory: audit-log row landed. */
export const emitMemoryAudit = (bus: EventBus | undefined, id: string): void => {
  if (!bus || !id) return;
  try { bus.emit({ kind: 'memory', subkind: 'audit', id }); }
  catch { /* swallow */ }
};

/** Memory: recipe-insights row landed. */
export const emitMemoryInsight = (bus: EventBus | undefined, id: string): void => {
  if (!bus || !id) return;
  try { bus.emit({ kind: 'memory', subkind: 'insight', id }); }
  catch { /* swallow */ }
};

/** Memory: links row(s) landed. Pass the audit `run_id` (= `memory_id`)
 *  as the entity id since links share the audit's row identity. */
export const emitMemoryLink = (bus: EventBus | undefined, id: string): void => {
  if (!bus || !id) return;
  try { bus.emit({ kind: 'memory', subkind: 'link', id }); }
  catch { /* swallow */ }
};

/** Memory: D-198 owner-authored `user_memory` row written / updated / deleted.
 *  Rides the same `memory` broadcast the audit emitter uses, so the webclient
 *  Memory lens silently refreshes after an owner create/edit/delete. */
export const emitMemoryUser = (bus: EventBus | undefined, id: string): void => {
  if (!bus || !id) return;
  try { bus.emit({ kind: 'memory', subkind: 'user', id }); }
  catch { /* swallow */ }
};

/** Approval: a new pending approval entered the queue. */
export const emitApprovalPending = (bus: EventBus | undefined, approval_id: string): void => {
  if (!bus || !approval_id) return;
  try { bus.emit({ kind: 'approval', subkind: 'pending', id: approval_id }); }
  catch { /* swallow */ }
};

/** Approval: first-write-wins resolution recorded. */
export const emitApprovalResolved = (bus: EventBus | undefined, approval_id: string): void => {
  if (!bus || !approval_id) return;
  try { bus.emit({ kind: 'approval', subkind: 'resolved', id: approval_id }); }
  catch { /* swallow */ }
};

/** Execution lifecycle. Callers stamp recipe + run identity; bus
 *  stamps the cursor. */
export const emitExecution = (
  bus: EventBus | undefined,
  args: {
    recipe_id: string; run_id: string;
    op: 'start' | 'progress' | 'complete' | 'error';
    /** Terminal emits only — see the field's note on `ServerEvent`. */
    audit_exempt?: boolean;
  },
): void => {
  if (!bus || !args.recipe_id || !args.run_id) return;
  try { bus.emit({ kind: 'execution', ...args }); }
  catch { /* swallow */ }
};

/** Service lifecycle: enroll / start / stop / crash. */
export const emitService = (
  bus: EventBus | undefined,
  args: { service_id: string; op: 'enrolled' | 'lifecycle' | 'error' },
): void => {
  if (!bus || !args.service_id) return;
  try { bus.emit({ kind: 'service', ...args }); }
  catch { /* swallow */ }
};

/** Schedule CRUD or fire signal. The fire signal lands AFTER the
 *  recipe execution starts — viewers see schedule-fired plus the
 *  matching execution-start in cursor order. */
export const emitSchedule = (
  bus: EventBus | undefined,
  op: 'updated' | 'fired',
): void => {
  if (!bus) return;
  try { bus.emit({ kind: 'schedule', op }); }
  catch { /* swallow */ }
};

/** Reactive watcher fire — paired clients subscribe by default
 *  (per `DEFAULT_SUBSCRIPTIONS`). */
export const emitReactiveFire = (bus: EventBus | undefined, recipe_id: string): void => {
  if (!bus || !recipe_id) return;
  try { bus.emit({ kind: 'reactive_fire', recipe_id }); }
  catch { /* swallow */ }
};

/** Reactive-substrate slice 1 — automation rule mutated (event-trigger
 *  CRUD / dispatcher auto-disable / auto-run toggle). Subscribers
 *  re-list via `triggers.list` / `auto_run.list`; schedules keep their
 *  own `kind: 'schedule'` emit above. Poll-manager / G6 adds
 *  `'watch'` (pause/resume, error-cap auto-disable, armed-set change —
 *  re-list via `watch.list`). */
export const emitAutomationRule = (
  bus: EventBus | undefined,
  mechanism: 'event_trigger' | 'auto_run' | 'watch' | 'dish',
): void => {
  if (!bus) return;
  try { bus.emit({ kind: 'automation_rule_changed', mechanism }); }
  catch { /* swallow */ }
};

/** Entitlement state change — driven by Stripe / Paddle webhook
 *  → cloud → server propagation. The cloud side flips the
 *  `user_entitlements` row; the server picks up the new state on its
 *  next refresh tick (or on push) and calls this once per transition.
 *  Clients invalidate the entitlements cache + refresh feature gates. */
export const emitEntitlement = (
  bus: EventBus | undefined,
  args: { isPro: boolean; since: number },
): void => {
  if (!bus) return;
  try { bus.emit({ kind: 'entitlement', ...args }); }
  catch { /* swallow */ }
};

/** D-125 P4.3 — `connection.notification` in-app delivery.
 *
 *  ⛔⛔⛔ THIS EMITTED A KIND NOBODY SUBSCRIBES TO, AND SAID SO IN ITS OWN DOC.
 *  It read "fans out to every paired client subscribed to `notification`" — and
 *  no client is. The bus fans out ONLY the kinds a client NAMES
 *  (`events/bus.ts`: `if (!sub.kinds.has(stamped.kind)) continue`), the webclient
 *  names 53 of the 55 kinds and omits this one, and the Bridge names four
 *  `notification.*` kinds but not the bare one. So every in-app send was emitted
 *  and dropped, while `notification-send` counted it in `delivered_to[]` — the
 *  "green-but-mute" class this file's sibling `default:` arm fails closed to
 *  prevent, arrived at one layer further out.
 *
 *  ⚠ THE FIX IS THE KIND, NOT THE FAN-OUT. `notification.notify` is named AND
 *  handled by both surfaces — the webclient renders a toast (`notify-toasts.ts`),
 *  the Bridge an OS notification — which is exactly what "in-app" should mean.
 *
 *  ⛔ AND NOT `NotificationBlock.notify`, WHICH WOULD HAVE BEEN WORSE THAN MUTE.
 *  Its `ChannelSelector` is `{ intent }`, not a channel list, so it fans out to
 *  whatever the owner configured for informational messages — turning a recipe
 *  that asked for `in_app` into a post to Slack or Telegram. Silence is a bug;
 *  sending someone's alert to an external service they did not choose is worse.
 *
 *  ⚠ `subtype` NO LONGER REACHES THE WIRE and is gone from the signature. It was
 *  part of the dead kind's payload; keeping a parameter that nothing reads is how
 *  the next reader concludes the channel is selectable here. */
export const emitNotification = (
  bus: EventBus | undefined,
  args: { body: { text: string; title?: string; link_url?: string } },
): void => {
  if (!bus) return;
  try {
    bus.emit({
      kind: 'notification.notify',
      ...(args.body.title !== undefined ? { title: args.body.title } : {}),
      text: args.body.text,
      ...(args.body.link_url !== undefined ? { link_url: args.body.link_url } : {}),
    });
  } catch { /* swallow */ }
};

/** D-148 § A.7 — exposure transition (M-XSURF-1). The exposure state
 *  machine's `broadcast` side effect closes over this so a path-resolution
 *  flip / public-MCP toggle fans out to every paired client subscribed to
 *  `exposure_changed` (the webclient refreshes its Settings → Server →
 *  Exposure grid + preset badge). Maps the `ExposureChangedEvent` rotation-
 *  surface shape onto the bus envelope (`type` → `kind`; the bus stamps
 *  `cursor`). Best-effort: a missing bus (db-less harness) or a wedged push
 *  is a no-op, so it can never abort the underlying transition. */
export const emitExposureChanged = (
  bus: EventBus | undefined,
  event: ExposureChangedEvent,
): void => {
  if (!bus) return;
  try {
    bus.emit({
      kind: 'exposure_changed',
      resolution: event.resolution,
      derived_preset_label: event.derived_preset_label,
      public_mcp_acknowledgement: event.public_mcp_acknowledgement,
      changed_at: event.changed_at,
      changed_by_client_id: event.changed_by_client_id,
    });
  } catch {
    /* swallow */
  }
};

// ────────────────────────────────────────────────────────────────
// Re-exports — keep the import surface for emit sites narrow
// ────────────────────────────────────────────────────────────────

export type { ServerEvent };
