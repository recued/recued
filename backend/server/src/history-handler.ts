/** D-169 P2 — historical-view rpc handlers.
 *
 *  The bridge side panel's three list sections (N.5 #2/#3/#4) source
 *  their "what happened recently" slice from these rpcs on mount + on
 *  every (re)connect (cursorless re-fetch — spec § A.5 / DL-6). Live bus
 *  events merge on top of this slice in the client (the rpc-fetched slice
 *  is the authoritative base; live events resume from reconnect onward).
 *
 *  All three are thin reads over EXISTING stores — no bridge-specific
 *  retention substrate (I-7):
 *    - `execution.recent`        → D-120 audit log `listRecent`
 *    - `notification.recent`     → `notification_fired` activity rows
 *                                  (`listActivitiesByAction`); D-169 P2
 *                                  makes the block's `notify` durable
 *    - `notification.pending_asks` → D-158 ask store (`listOpenAsks`)
 *
 *  D-169 P2 Slice 3 adds one write alongside these reads, sourced from the
 *  same notification-block dep:
 *    - `notification.submitAnswer` → D-158 block `submitAnswer` — the
 *                                  bridge approval card's first-answer-wins
 *                                  submit funnel (I-6). Not a retention
 *                                  substrate; it mutates the existing ask
 *                                  store the block already owns.
 *
 *  Composition shape mirrors `system-status-handler.ts` (the P1 rpc
 *  template): a deps object with optional sources; an absent source
 *  resolves the corresponding read to `[]` so a partially-composed boot
 *  (dbless harness / notification block not wired) still serves an empty
 *  slice rather than throwing. Local-UI / local-bridge only — these
 *  methods are omitted from `MCP_TOOL_CATALOG`, the same posture as
 *  `system.status` (host-activity reads don't cross to MCP-channel
 *  agents). */

import type {
  Actor,
  HandlerSlice,
  ServerPendingAsk,
  ServerRecentExecution,
  ServerRecentNotification,
  ServerRpcRegistry,
  ServerPendingAskDetail,
} from '@recued/contracts';
// D-161 P3 — actor-lane default + wire-input sanitizer for the aggregate
// "Recent activity" feed (`execution.recent`).
import {
  PREAPPROVAL_NOTIFICATION_HANDLER,
  TIMELINE_DEFAULT_ORIGIN_ACTORS,
  provenanceAttributionFromSource,
  sanitizeTimelineOriginFilter,
} from '@recued/contracts';
import type { AuditLogStore } from '@recued/storage';
import type { PendingAsk } from '@recued/notification';

import type { WsClient } from './ws-server.js';

/** Default + ceiling for the `limit` param. The ceiling matches the
 *  bridge bus-buffer cap (`BRIDGE_BUS_BUFFER_CAP = 50`) loosely — a
 *  client asking for more than `MAX_LIMIT` is clamped rather than
 *  refused, so a future surface wanting a deeper history degrades
 *  gracefully without a contract change. */
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/** Clamp a caller-supplied `limit` to `[1, MAX_LIMIT]`. An absent,
 *  non-finite, or non-positive value is treated as unset → `DEFAULT_LIMIT`
 *  (a `limit` of 0 / negative is an invalid request, not "zero rows"). */
const clampLimit = (limit: number | undefined): number => {
  if (typeof limit !== 'number' || !Number.isFinite(limit) || limit < 1) {
    return DEFAULT_LIMIT;
  }
  return Math.min(MAX_LIMIT, Math.floor(limit));
};

/** Injected read sources. Every field optional so a partially-composed
 *  boot still serves (absent → the read returns `[]`). */
export interface HistoryDeps {
  /** D-120 audit log — backs `execution.recent` (`listRecent`) +
   *  `notification.recent` (`listActivitiesByAction('notification_fired')`).
   *  Absent → both return `[]`. */
  auditLog?: AuditLogStore;
  /** D-270 — resolve one ask's "what will happen" rows. Absent ⇒ no ask carries
   *  `details` and every card renders exactly as it did before, which is the
   *  pre-D-270 behaviour and the deliberate fallback.
   *
   *  ⚠ Returns null per ask for everything it cannot honestly resolve; the
   *  handler never distinguishes those nulls, because the owner ruling is that
   *  an unresolvable case is just an ordinary card. */
  resolveAskDetails?: (ask: PendingAsk) => Promise<readonly ServerPendingAskDetail[] | null>;
  /** D-158 ask-store read — backs `notification.pending_asks`. Injected
   *  as a thunk over `NotificationBlock.listOpenAsks` so the handler
   *  never holds the ask store directly. Absent → returns `[]`. */
  listOpenAsks?: () => Promise<PendingAsk[]>;
  /** D-169 P2 Slice 3 — submit-answer funnel backing
   *  `notification.submitAnswer`. Injected as a thunk over
   *  `NotificationBlock.submitAnswer`; the wire layer closes over the
   *  `via: 'ui'` channel (the interactive inbound path) so the handler
   *  never names a channel or holds the block. Absent (partially-composed
   *  boot) → the rpc is a no-op that still resolves `{ ok: true }`. */
  submitAnswer?: (ask_id: string, option_id: string, note?: string) => Promise<void>;
}

/** Parse a `notification_fired` activity row's JSON `detail` into the
 *  renderable body. Defensive — a malformed / absent `detail` degrades
 *  to an empty-text row rather than throwing, so one bad row never fails
 *  the whole historical fetch. */
const parseNotificationDetail = (
  detail: string | undefined,
): { title?: string; text: string; link_url?: string } => {
  if (!detail) return { text: '' };
  try {
    const parsed = JSON.parse(detail) as Record<string, unknown>;
    return {
      ...(typeof parsed.title === 'string' ? { title: parsed.title } : {}),
      text: typeof parsed.text === 'string' ? parsed.text : '',
      ...(typeof parsed.link_url === 'string'
        ? { link_url: parsed.link_url }
        : {}),
    };
  } catch {
    return { text: '' };
  }
};

/** D-169 P2 — recent recipe executions (N.5 #2). A trimmed projection of
 *  the D-120 `AuditEntry`. `error_category` carries the first error's
 *  code when the run produced errors. */
export const handleExecutionRecent = async (
  deps: HistoryDeps,
  req: { limit?: number; origin_actors?: ReadonlyArray<Actor> },
): Promise<{ executions: ServerRecentExecution[] }> => {
  if (!deps.auditLog) return { executions: [] };
  // D-161 P3 — the aggregate feed foregrounds the gold-path lane
  // (`user_self`+`system`) by default; an explicit `origin_actors` reaches
  // the agents (`contracted_user`) / reception (`anonymous`) lanes. A `[]` /
  // malformed filter sanitizes to undefined → the default foreground set,
  // never an empty feed (I-7: outside-actor rows are filtered from the
  // default view, never dropped — re-querying the lane returns them).
  const origin_actors =
    sanitizeTimelineOriginFilter(req.origin_actors) ?? TIMELINE_DEFAULT_ORIGIN_ACTORS;
  const rows = await deps.auditLog.listRecent(clampLimit(req.limit), { origin_actors });
  return {
    executions: rows.map((e) => {
      // D-161 P4 — provenance-honesty attribution, DERIVED from the SAME
      // audit row that feeds `origin_actor` below: the agent identity from
      // `execution_source`, the contract version from the `contract_snapshot`
      // the commit already carries (O-3 — render, not store). Defined ONLY
      // for an outside actor; a first-person row → `undefined` → field
      // omitted, so the foregrounded gold path stays unchanged (I-9) and an
      // agent's run never surfaces unattributed (I-10).
      const attribution = provenanceAttributionFromSource(
        e.execution_source,
        e.contract_snapshot,
      );
      return {
        run_id: e.run_id,
        recipe_id: e.recipe_id,
        status: e.commit_status,
        started_at: e.started_at,
        duration_ms: e.duration_ms,
        ...((e.errors ?? []).length > 0
          ? { error_category: (e.errors ?? [])[0]!.code }
          : {}),
        // D-161 P3 — the run's lane, derived from the audit row's write-actor
        // (`execution_source.actor`; absent → `'system'`). Lets the client
        // badge / group lanes it reached via an explicit `origin_actors`.
        origin_actor: e.execution_source?.actor ?? 'system',
        ...(attribution ? { attribution } : {}),
      };
    }),
  };
};

/** D-169 P2 — recent fired notifications (N.5 #3). Reads the activity log
 *  (already newest-first), filters to the `notification_fired` rows, and
 *  projects each row's JSON `detail` to the renderable body.
 *
 *  `listActivities()` is called without a limit because the store lists
 *  the whole activity table then slices in JS — so a pre-slice `limit`
 *  would cut the mixed-action stream BEFORE the `notification_fired`
 *  filter and under-return notifications under heavy non-notify activity.
 *  Filtering the full set then slicing to `limit` is correct and costs
 *  the same list-all work. The activity table is bounded by the D-120
 *  retention pruner; a dedicated indexed `listActivitiesByAction` read is
 *  a clean follow-on if notification volume ever makes this hot. */
export const handleNotificationRecent = async (
  deps: HistoryDeps,
  req: { limit?: number },
): Promise<{ notifications: ServerRecentNotification[] }> => {
  if (!deps.auditLog) return { notifications: [] };
  const all = await deps.auditLog.listActivities();
  const rows = all
    .filter((a) => a.action === 'notification_fired')
    .slice(0, clampLimit(req.limit));
  return {
    notifications: rows.map((a) => {
      const body = parseNotificationDetail(a.detail);
      return {
        id: a.activity_id,
        ...(body.title !== undefined ? { title: body.title } : {}),
        text: body.text,
        ...(body.link_url !== undefined ? { link_url: body.link_url } : {}),
        fired_at: a.timestamp,
      };
    }),
  };
};

/** D-270 — above this many open asks, the list omits detail rows entirely.
 *
 *  🔑 A CEILING ON A LIST THE LANDING PAGE NEVER HAD. `/ask` resolves one hold
 *  per page load; this endpoint returns every open ask and the card re-fetches,
 *  so resolution is a store round-trip per preflight ask per fetch. At an
 *  owner's real ask volume the cap is never reached; it exists so a pathological
 *  backlog degrades to the pre-D-270 card instead of to a slow one.
 *
 *  ⚠ Omission is SILENT and that is the ruling, not an oversight: an
 *  unresolvable case is just an ordinary card. */
export const PENDING_ASK_DETAIL_RESOLVE_MAX = 50;

/** D-169 P2 — currently-open asks (N.5 #4). The ask store returns
 *  oldest-first; this re-sorts newest-first to match the bridge bus
 *  buffer's prepend ordering so the seeded base + live `notification.ask`
 *  frames render in one consistent order. */
export const handlePendingAsks = async (
  deps: HistoryDeps,
): Promise<{ asks: ServerPendingAsk[] }> => {
  if (!deps.listOpenAsks) return { asks: [] };
  const open = await deps.listOpenAsks();
  const sorted = [...open].sort((a, b) => b.created_at - a.created_at);
  // D-270 — resolve the detail rows alongside the list.
  //
  // ⛔ BOUNDED, BECAUSE THIS IS A LIST AND THE LANDING PAGE WAS NOT. `/ask`
  // resolves ONE ask on one page load; this returns EVERY open ask and the card
  // re-fetches, so an unbounded resolve is one store round-trip per open ask per
  // fetch. Above the cap the rows are simply omitted — the cards stay correct
  // and fall back to prose, which is the same graceful shape as any other
  // unresolvable case.
  //
  // ⚠ The resolver itself returns null for a non-preflight ask BEFORE any read,
  // so the common case costs nothing even under the cap.
  const details = deps.resolveAskDetails !== undefined
    && sorted.length <= PENDING_ASK_DETAIL_RESOLVE_MAX
    ? await Promise.all(sorted.map(async (p) => {
      try {
        return await deps.resolveAskDetails!(p);
      } catch {
        // One unresolvable ask must never cost the owner the whole list.
        return null;
      }
    }))
    : undefined;
  return {
    asks: sorted.map((p, i) => ({
      ask_id: p.ask_id,
      ...(p.message.title !== undefined ? { title: p.message.title } : {}),
      text: p.message.text,
      options: p.handler_kind === PREAPPROVAL_NOTIFICATION_HANDLER ? [] : p.options.map((o) => ({ id: o.id, label: o.label })),
      ...(p.handler_kind === PREAPPROVAL_NOTIFICATION_HANDLER
        && typeof p.handler_payload.proposal_id === 'string' && p.handler_payload.proposal_id.startsWith('pap_')
        ? { owner_review: { kind: 'preapproval' as const, proposal_id: p.handler_payload.proposal_id } } : {}),
      created_at: p.created_at,
      // D-234 § 234.3 — forwarded because THIS LITERAL IS THE FILTER. Every
      // other channel gets `link_url` off the message itself; the in-app card
      // only ever sees what is named here.
      ...(p.message.link_url !== undefined ? { link_url: p.message.link_url } : {}),
      // D-234 § 234.4e — and the note prompt, for the same reason as `link_url`:
      // this literal is the enumerating copier, so a field it does not NAME is
      // dropped. Without it the in-app card cannot know to collect a reason, and
      // a `'required'` ask would no-op every answer it sent.
      ...(p.note_prompt !== undefined ? { note_prompt: p.note_prompt } : {}),
      ...(p.body !== undefined ? { body: p.body } : {}),
      // D-270 — and the detail rows, named here for the same reason as the two
      // fields above: THIS LITERAL IS THE FILTER, so a field it does not name is
      // dropped however well the server resolved it.
      // ⛔ `length > 0`, NOT TRUTHINESS. An empty array is truthy in JS, so a
      // resolver returning `[]` would ship `details: []` — an empty block where
      // the contract says ABSENT means "render the ordinary card". The current
      // resolver returns null for that case; this guard is at the boundary that
      // states the rule, so a future resolver cannot break it quietly.
      ...(details?.[i]?.length ? { details: details[i] } : {}),
    })),
  };
};

/** D-169 P2 Slice 3 — submit an answer to an open ask (N.5 #4 interactive
 *  approval card). Funnels into the notification block's `submitAnswer`
 *  (first-answer-wins dedup across surfaces, D-158 I-6). The block is a
 *  silent no-op on an unknown / already-answered ask or an option the ask
 *  never offered, so this always resolves `{ ok: true }`: the rpc
 *  acknowledges receipt, and the card converges via the
 *  `notification.ask_closed` bus frame + the next history re-fetch. An
 *  absent `submitAnswer` dep (partially-composed boot) is a no-op that
 *  still resolves `{ ok: true }`, matching the read handlers' `[]`
 *  graceful-absent posture. */
export const handleSubmitAnswer = async (
  deps: HistoryDeps,
  req: { ask_id: string; option_id: string; note?: string },
): Promise<{ ok: true }> => {
  // Defensive shape guard (Codex Slice-3 LOW ×2): only forward well-formed,
  // non-empty string ids into the block. A malformed wire payload becomes a
  // no-op `{ ok: true }` rather than reaching the ask store with a bad key —
  // including a non-object `req` itself (`null` / `undefined` / a primitive),
  // which would otherwise throw on the `.ask_id` read instead of no-op'ing.
  // Typed callers are unaffected; the block separately no-ops an unknown /
  // already-answered ask or an option it never offered.
  const args = req as {
    ask_id?: unknown; option_id?: unknown; note?: unknown;
  } | null | undefined;
  if (
    deps.submitAnswer &&
    args != null &&
    typeof args.ask_id === 'string' &&
    args.ask_id !== '' &&
    typeof args.option_id === 'string' &&
    args.option_id !== ''
  ) {
    // D-234 § 234.4e — the note rides through UNVALIDATED beyond its type: the
    // BLOCK owns whether this ask invited one, the cap, and the required-ness.
    // Re-deciding any of that here would put the rule in two places, and the wire
    // layer cannot see `note_prompt` anyway.
    //
    // ⛔ OMITTED WHEN ABSENT, NEVER PASSED AS AN EXPLICIT `undefined`. Third time
    // this exact regression has been caught in this arc (ui-shared's `onAnswer`,
    // the Bridge's, now here): a call with a trailing `undefined` has arity 3, so
    // every `toHaveBeenCalledWith(a, b)` in the codebase goes red — and the
    // reason it MATTERS beyond tests is that a dep typed `(a, b) => …` may still
    // read `arguments.length`.
    const note = typeof args.note === 'string' && args.note !== '' ? args.note : undefined;
    await (note === undefined
      ? deps.submitAnswer(args.ask_id, args.option_id)
      : deps.submitAnswer(args.ask_id, args.option_id, note));
  }
  return { ok: true };
};

type HistoryMethods =
  | 'execution.recent'
  | 'notification.recent'
  | 'notification.pending_asks'
  | 'notification.submitAnswer';

/** Compose the historical-view handler slice. Returns `undefined` when no
 *  deps are wired (the caller drops the slice); each handler self-gates
 *  per-source via the `[]` fallback so a partial `deps` still serves. */
export const makeHistoryHandlers = (
  deps: HistoryDeps | undefined,
): HandlerSlice<ServerRpcRegistry, HistoryMethods, WsClient> | undefined => {
  if (!deps) return undefined;
  return {
    methods: [
      'execution.recent',
      'notification.recent',
      'notification.pending_asks',
      'notification.submitAnswer',
    ],
    handlers: {
      'execution.recent': async (req) => handleExecutionRecent(deps, req),
      'notification.recent': async (req) => handleNotificationRecent(deps, req),
      'notification.pending_asks': async () => handlePendingAsks(deps),
      'notification.submitAnswer': async (req) => handleSubmitAnswer(deps, req),
    },
  };
};
