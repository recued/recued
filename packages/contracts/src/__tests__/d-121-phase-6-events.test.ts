/** D-121 Phase 6 — realtime broadcast contracts tests.
 *
 *  Covers the constants + wire shapes that webclient / bridge / server
 *  all share (`ServerEvent` discriminator coverage, `SubscribeRequest`
 *  / `SubscribeAck` shape, default-subscription list, ring-size
 *  default, kind enumeration drift). */

import { describe, expect, it } from 'vitest';
import {
  ALL_BROADCAST_EVENT_KINDS,
  BROADCAST_EVENT_KIND_SET,
  DEFAULT_EVENT_RING_SIZE,
  DEFAULT_SUBSCRIPTIONS,
} from '../index.js';
import type {
  BroadcastEventKind,
  ServerEvent,
  SubscribeAck,
  SubscribeRequest,
} from '../events.js';

describe('D-121 Phase 6 — broadcast event constants', () => {
  it('ALL_BROADCAST_EVENT_KINDS enumerates every variant of ServerEvent', () => {
    // The enumeration must include exactly every `kind` discriminator
    // used in `ServerEvent`. Drift here is the kind of bug that lets
    // a new variant ship without filter coverage in subscribers.
    const expected: BroadcastEventKind[] = [
      'approval',
      // Reactive-substrate slice 1 — automation rule mutated (trigger
      // CRUD / auto-run toggle / dispatcher auto-disable).
      'automation_rule_changed',
      // D-148 § A.6.5 — TLS cert rotation pre-notice + revert.
      // Server emits the pre-notice at T-rotation_lead_time (default
      // 7d) after staging a fresh cert; clients verify the Ed25519
      // signature against their pinned `server_public_key` and persist
      // `next_fingerprint` alongside `current_fingerprint`. The revert
      // event fires when a rotation is rolled back. Both ride the
      // pair-scoped broadcast bus alongside the existing rotation +
      // exposure events.
      'cert.rotation_notice',
      'cert.rotation_reverted',
      // D-137 P1 — seven `chat.*` kinds added to the broadcast bus
      // (Wire A). Sorted alphabetically; lockstep with the closed
      // `CHAT_BROADCAST_EVENT_KINDS` list in `chat.ts`.
      // D-137 W2.2 — eighth kind `chat.tool_catalog_scope_changed`
      // added when Mary's per-kind catalog scope toggles.
      // D-137 W2.3 — ninth kind `chat.connection_mcp_annotation_changed`
      // added when Mary saves a per-connection MCP tool annotation.
      // D-137 P3 — tenth `chat.disambiguation_proposed` (§ A.5
      // Pattern 3 chips / open-question surface) + eleventh
      // `chat.plan_resolved` (§ A.11 write-plan approve/cancel
      // resolution).
      // D-137 P4 — twelfth chat kind `chat.picker_entries_changed`
      // (§ A.7.1 picker visibility shift — fires on annotation writes
      // + `chat.picker.refresh` rpcs).
      // D-137 P5 follow-on — thirteenth chat kind
      // `chat.inbound_token_changed` (§ A.9 inbound-token registry
      // mutated — fires on issue / update_grants / revoke / delete
      // so paired clients re-render Settings → MCP Tokens table).
      // D-167 chat provider-threading — `chat.default_model_pref_changed`
      // (per-pair global chat-model default changed; non-session-scoped,
      // re-renders every non-overridden session's badge + Settings).
      'chat.connection_mcp_annotation_changed',
      'chat.data_diagnosis_resolved',
      'chat.default_model_pref_changed',
      'chat.disambiguation_proposed',
      'chat.inbound_token_changed',
      'chat.message_complete',
      'chat.plan_proposed',
      'chat.plan_resolved',
      'chat.session_changed',
      'chat.token_streamed',
      'chat.tool_call_completed',
      'chat.tool_call_started',
      'chat.tool_catalog_scope_changed',
      'chat.transparency',
      // D-165 enroll-host #1 — vendor OAuth completion signal ({ flow_id }
      // only; the dialog claims the credential point-to-point).
      'connection.vendor_oauth_completed',
      // D-171 — `contract_definition` lifecycle (mint / revoke) fan-out;
      // the authoritative signal the Contracts inspector + MCP door
      // Advanced summary re-list off (replaces the token proxy).
      'contract.contract_definition_changed',
      // D-177 N.13 (P6b) — staged-trust learner surfaced a new open
      // delegation-rule suggestion (key-hash-only payload; the P6c
      // `#contracts` panel re-lists).
      'contract.delegation_rule_suggested',
      // D-177 N.13 (P6c) — the owner resolved a suggestion (accept/dismiss);
      // paired clients' "Suggested rules" panels drop/refresh the card.
      'contract.delegation_rule_suggestion_resolved',
      // D-177 N.11 rule 5 (slice C) — scoped-grant proposal lifecycle.
      'contract.scoped_grant_suggested',
      'contract.scoped_grant_suggestion_resolved',
      'enrichment_drift_detected',
      'enrichment_promotion_suggested',
      'entitlement',
      'execution',
      // D-148 § A.7 — exposure transition broadcast (M-XSURF-1 wiring).
      'exposure_changed',
      'housekeeping_cycle',
      // D-315 §6 — the owner's mail facts moved (facts / templates).
      'mail_fact',
      'memory',
      'merge_candidate',
      'merge_scan_progress',
      'notification',
      // D-157 server-wiring — `notification.*` events back the `ui`
      // channel of the D-158 notification block (notify / ask /
      // close-broadcast). Subscribed by default so a webclient that
      // comes online during an outstanding ask re-renders it from the
      // bus replay.
      'notification.ask',
      'notification.ask_closed',
      // D-169 P2 Slice 4 — per-bridge notification-mode change fan-out.
      'notification.bridge_mode_changed',
      'notification.notify',
      // D-145 PA10 follow-on Slice D — bulk-pack install / uninstall
      // completion events. Fired by the pack rpc handlers on a
      // successful transaction; drives live refresh of the Settings →
      // Packs panel across paired clients.
      'pack_installed',
      'pack_uninstalled',
      // D-156 follow-on — paired-device roster changed (pair add / revoke);
      // drives the Settings → Devices live refresh across paired clients.
      'pair.list_changed',
      'reactive_fire',
      // D-149 P3 § A.3 — reception broadcast kinds. `endpoint_changed`
      // fires on every registry mutation (create / enable / disable /
      // revoke / extend / rotate_token) so paired clients re-render
      // Reception AND the listener's in-memory
      // registry cache invalidates within 60s per Must Hold I-5.
      // `emergency_disabled` is the fan-out roll-up for the bulk
      // emergency-disable rpc.
      'reception.emergency_disabled',
      'reception.endpoint_changed',
      // D-173 N.2 — Reception Inbox item resolved (approve / reject);
      // paired clients drop the resolved held item off the bus.
      'reception_inbox',
      // R2 build step 4c.4 — derived recipe runnability snapshot fan.
      'recipe_runnability_changed',
      // D-282 B4 — a row in a PACK'S OWN Records store changed. Distinct from
      // `warehouse`, which carries the personal collections; no broadcast reached
      // pack data at all before this, so an open pack view went stale until its
      // tab was re-selected.
      'records',
      'remerge_prompt',
      'schedule',
      'service',
      // D-153 P7 — session lifecycle transition; paired clients
      // refresh their session UI from the bus without polling.
      'session_lifecycle',
      // supervision live-state broadcast (`31cb7ec3`) — (ingredient_slug, op)-keyed
      // daemon state pushed so server-resolved state stays authoritative.
      'supervision',
      // D-148 § A.4.4 — webclient/bridge bearer rotation push;
      // targeted client wraps + persists + applies. Sibling
      // subscribers ignore on `target_token_id` mismatch.
      'token.rotated',
      'update.progress',
      'upstream_merge_failed',
      'warehouse',
    ];
    expect([...ALL_BROADCAST_EVENT_KINDS].sort()).toEqual(expected);
  });

  it('BROADCAST_EVENT_KIND_SET matches the array form for O(1) checks', () => {
    expect(BROADCAST_EVENT_KIND_SET.size).toBe(ALL_BROADCAST_EVENT_KINDS.length);
    for (const kind of ALL_BROADCAST_EVENT_KINDS) {
      expect(BROADCAST_EVENT_KIND_SET.has(kind)).toBe(true);
    }
    expect(BROADCAST_EVENT_KIND_SET.has('not-a-kind' as BroadcastEventKind)).toBe(false);
  });

  it('DEFAULT_EVENT_RING_SIZE is 10K (per spec)', () => {
    expect(DEFAULT_EVENT_RING_SIZE).toBe(10_000);
  });

  it('DEFAULT_SUBSCRIPTIONS covers every broadcast kind', () => {
    const all = new Set(ALL_BROADCAST_EVENT_KINDS);
    for (const k of DEFAULT_SUBSCRIPTIONS) expect(all.has(k)).toBe(true);
    for (const k of ALL_BROADCAST_EVENT_KINDS) expect(DEFAULT_SUBSCRIPTIONS).toContain(k);
  });
});

describe('D-121 Phase 6 — wire shapes', () => {
  it('warehouse event carries collection / op / id / cursor', () => {
    const ev: ServerEvent = {
      kind: 'warehouse',
      collection: 'mail',
      op: 'insert',
      id: 'msg-1',
      cursor: 1,
    };
    expect(ev.kind).toBe('warehouse');
    if (ev.kind === 'warehouse') {
      expect(ev.collection).toBe('mail');
      expect(ev.op).toBe('insert');
      expect(ev.id).toBe('msg-1');
    }
  });

  it('pair.list_changed carries op + cursor (D-156 follow-on)', () => {
    const added: ServerEvent = {
      kind: 'pair.list_changed',
      op: 'added',
      cursor: 9,
    };
    const revoked: ServerEvent = {
      kind: 'pair.list_changed',
      op: 'revoked',
      cursor: 10,
    };
    expect(added.kind).toBe('pair.list_changed');
    if (added.kind === 'pair.list_changed') {
      expect(added.op).toBe('added');
      expect(added.cursor).toBe(9);
    }
    if (revoked.kind === 'pair.list_changed') {
      expect(revoked.op).toBe('revoked');
    }
  });

  it('notification.bridge_mode_changed carries client_token_id + modes + cursor (D-169 P2 Slice 4)', () => {
    const ev: ServerEvent = {
      kind: 'notification.bridge_mode_changed',
      client_token_id: 'tok-abc',
      modes: { notification: true, approval: false },
      cursor: 7,
    };
    expect(ev.kind).toBe('notification.bridge_mode_changed');
    if (ev.kind === 'notification.bridge_mode_changed') {
      expect(ev.client_token_id).toBe('tok-abc');
      expect(ev.modes).toEqual({ notification: true, approval: false });
      expect(ev.cursor).toBe(7);
    }
  });

  it('memory event carries subkind + id', () => {
    const ev: ServerEvent = {
      kind: 'memory',
      subkind: 'audit',
      id: 'run-1',
      cursor: 2,
    };
    if (ev.kind === 'memory') {
      expect(['audit', 'insight', 'link']).toContain(ev.subkind);
    }
  });

  it('execution event carries recipe_id + run_id + op', () => {
    const ev: ServerEvent = {
      kind: 'execution',
      recipe_id: 'r1',
      run_id: 'run-1',
      op: 'start',
      cursor: 3,
    };
    if (ev.kind === 'execution') {
      expect(['start', 'progress', 'complete', 'error']).toContain(ev.op);
    }
  });

  it('entitlement event carries isPro + since', () => {
    const ev: ServerEvent = {
      kind: 'entitlement',
      isPro: true,
      since: 1700000000000,
      cursor: 4,
    };
    if (ev.kind === 'entitlement') expect(ev.isPro).toBe(true);
  });

  it('SubscribeRequest accepts kinds + optional cursor_since', () => {
    const r1: SubscribeRequest = { kinds: ['warehouse'] };
    const r2: SubscribeRequest = { kinds: ['warehouse', 'memory'], cursor_since: 42 };
    expect(r1.kinds).toEqual(['warehouse']);
    expect(r2.cursor_since).toBe(42);
  });

  it('SubscribeAck carries cursor + replay_count + fell_off_ring', () => {
    const ack: SubscribeAck = { cursor: 100, replay_count: 5, fell_off_ring: false };
    expect(ack.cursor).toBe(100);
    expect(ack.replay_count).toBe(5);
    expect(ack.fell_off_ring).toBe(false);
  });
});
