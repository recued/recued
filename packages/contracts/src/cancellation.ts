/** D-153 P3 — Cancellation grace window + compensating-commit
 *  substrate.
 *
 *  External actions are irreversible by default — most outward tool
 *  calls (mail send, calendar create, vendor API write) cannot be
 *  unwound by Recued. The substrate doesn't classify reversibility; it
 *  provides two narrow primitives for the cases where some form of
 *  undo IS possible:
 *
 *    1. **Grace-window cancel.** When an ingredient manifest declares a
 *       `cancellation_partner`, the Gateway admits the dispatch into a
 *       brief mutable hold (`grace_window_ms`, default 5s). A cancel
 *       arriving inside the window aborts the dispatch before any
 *       external side effect; the original commit row transitions
 *       `pending → cancelled`. No compensating commit is needed —
 *       nothing happened externally.
 *    2. **Compensating commit (post-window).** After the grace window
 *       closes — or for actions whose partner only acts after the
 *       fact — cognition dispatches a *fresh* commit invoking the
 *       partner slug with `predecessor_commit_id` pointing at the row
 *       being undone. Two observable commits; audit + save-as-Recipe
 *       filter the compensated pair via the predecessor link.
 *
 *  P3 ships substrate-only. The fields, primitives, and validator land
 *  here; the per-channel Gateway wiring that admits dispatches to the
 *  grace store + emits the status transitions is engine work, deferred
 *  to D-145 (Engine substrate). Today's synchronous recipe-runner
 *  leaves the grace store empty; the in-memory implementation here is
 *  the kit Gateway will plug into when the dispatch outbox lands.
 *
 *  Spec: D-153 § Cancellation grace window +
 *  compensating commits (lines 467-485). */

import type { IngredientManifest } from './ingredient.js';

// ────────────────────────────────────────────────────────────────
// Grace-window constants
// ────────────────────────────────────────────────────────────────

/** Default milliseconds the Gateway holds a dispatch in the mutable
 *  grace window when the manifest declares `cancellation_partner` but
 *  omits an explicit `grace_window_ms`. Per spec line 476: "default:
 *  5s". Five seconds is the empirical "did I mean that" recovery
 *  window for chat-channel corrections without delaying dispatch
 *  noticeably. */
export const DEFAULT_GRACE_WINDOW_MS = 5000;

/** Upper sanity bound on `grace_window_ms`. Past one minute, the grace
 *  window stops being a "did I mean that" buffer and starts being
 *  scheduling — that's a different substrate (`schedule.create`).
 *  Validator-rejects with `grace_window_ms_out_of_range` above this. */
export const MAX_GRACE_WINDOW_MS = 60_000;

// ────────────────────────────────────────────────────────────────
// Manifest-derived helpers
// ────────────────────────────────────────────────────────────────

/** True when the manifest declares a non-empty `cancellation_partner`
 *  slug. Used by the Gateway to decide whether a tool admits the
 *  grace-window code path at dispatch time. */
export const manifestSupportsGraceCancel = (
  manifest: Pick<IngredientManifest, 'cancellation_partner'>,
): boolean =>
  typeof manifest.cancellation_partner === 'string'
  && manifest.cancellation_partner.length > 0;

/** Resolves the effective grace-window milliseconds for a manifest.
 *  Returns `null` when the manifest declares no `cancellation_partner`
 *  (the grace window only has meaning when an undo path exists); the
 *  Gateway short-circuits to direct dispatch. Returns the declared
 *  `grace_window_ms` when present; otherwise `DEFAULT_GRACE_WINDOW_MS`.
 *
 *  The validator (`validateCancellationManifest`) rejects manifests
 *  with `grace_window_ms` outside `[0, MAX_GRACE_WINDOW_MS]` so this
 *  resolver never returns an unbounded value at runtime. */
export const getEffectiveGraceWindowMs = (
  manifest: Pick<IngredientManifest, 'cancellation_partner' | 'grace_window_ms'>,
): number | null => {
  if (!manifestSupportsGraceCancel(manifest)) return null;
  if (typeof manifest.grace_window_ms === 'number') return manifest.grace_window_ms;
  return DEFAULT_GRACE_WINDOW_MS;
};

// ────────────────────────────────────────────────────────────────
// Manifest validator — pure, runs at publish time + in Kitchen
// ────────────────────────────────────────────────────────────────

/** Closed enumeration of `validateCancellationManifest` issue codes. */
export const CANCELLATION_ISSUE_CODES = [
  'cancellation_partner_invalid_type',
  'cancellation_partner_self_reference',
  'grace_window_ms_invalid_type',
  'grace_window_ms_out_of_range',
  'grace_window_ms_without_partner',
] as const;

/** String-literal union derived from `CANCELLATION_ISSUE_CODES`. */
export type CancellationIssueCode = (typeof CANCELLATION_ISSUE_CODES)[number];

/** Predicate — true when `value` is a known `CancellationIssueCode`. */
export const isCancellationIssueCode = (
  value: unknown,
): value is CancellationIssueCode =>
  typeof value === 'string'
  && (CANCELLATION_ISSUE_CODES as readonly string[]).includes(value);

/** One issue surfaced by `validateCancellationManifest`. Shape mirrors
 *  `ProbeIssue` from `validate-probe.ts` so consumers can render both
 *  validators' output uniformly. */
export interface CancellationIssue {
  code: CancellationIssueCode;
  field: 'cancellation_partner' | 'grace_window_ms';
  message: string;
}

/** Pure validator for the `cancellation_partner` + `grace_window_ms`
 *  pair on a manifest. Runs at publish time (marketplace gate) and
 *  client-side in Kitchen for instant author feedback. Returns the
 *  empty array when the manifest is valid.
 *
 *  Rules (all hard errors — pre-launch zero installs posture):
 *    - `cancellation_partner` when present must be a non-empty string.
 *    - `cancellation_partner` may NOT equal the manifest's own `slug`
 *      (a tool cannot undo itself; the partner must be a separate
 *      ingredient).
 *    - `grace_window_ms` when present must be a finite, non-negative
 *      number in `[0, MAX_GRACE_WINDOW_MS]`.
 *    - `grace_window_ms` is rejected when `cancellation_partner` is
 *      absent (the field is meaningless without an undo path; per spec
 *      line 476 "ignored if cancellation_partner absent"). */
export const validateCancellationManifest = (
  manifest: Pick<IngredientManifest, 'slug' | 'cancellation_partner' | 'grace_window_ms'>,
): CancellationIssue[] => {
  const issues: CancellationIssue[] = [];

  const partner = manifest.cancellation_partner;
  const hasPartnerField = partner !== undefined;

  if (hasPartnerField) {
    if (typeof partner !== 'string' || partner.length === 0) {
      issues.push({
        code: 'cancellation_partner_invalid_type',
        field: 'cancellation_partner',
        message: 'cancellation_partner must be a non-empty string slug',
      });
    } else if (partner === manifest.slug) {
      issues.push({
        code: 'cancellation_partner_self_reference',
        field: 'cancellation_partner',
        message: `cancellation_partner "${partner}" cannot equal the manifest's own slug`,
      });
    }
  }

  const graceMs = manifest.grace_window_ms;
  if (graceMs !== undefined) {
    if (
      typeof graceMs !== 'number'
      || !Number.isFinite(graceMs)
    ) {
      issues.push({
        code: 'grace_window_ms_invalid_type',
        field: 'grace_window_ms',
        message: 'grace_window_ms must be a finite number',
      });
    } else if (graceMs < 0 || graceMs > MAX_GRACE_WINDOW_MS) {
      issues.push({
        code: 'grace_window_ms_out_of_range',
        field: 'grace_window_ms',
        message:
          `grace_window_ms ${graceMs} is outside [0, ${MAX_GRACE_WINDOW_MS}]`,
      });
    }
    // Fires only when the partner field is genuinely absent — a
    // present-but-malformed partner is already actionable via
    // `cancellation_partner_invalid_type`, and "requires
    // cancellation_partner to also be declared" would misdescribe it.
    if (!hasPartnerField) {
      issues.push({
        code: 'grace_window_ms_without_partner',
        field: 'grace_window_ms',
        message:
          'grace_window_ms requires cancellation_partner to also be declared',
      });
    }
  }

  return issues;
};

// ────────────────────────────────────────────────────────────────
// Compensating-commit helpers
// ────────────────────────────────────────────────────────────────

/** True when a commit row represents a compensating commit — i.e.,
 *  carries a non-empty `predecessor_commit_id` pointing at the row
 *  being undone. The predecessor link is the substrate's only
 *  primitive for marking compensation; there is no separate flag.
 *
 *  Consumers (save-as-Recipe serialization, audit-filter UI) call this
 *  to filter compensated pairs out of the "what happened" feed —
 *  presenting the cleaned sequence rather than the original-plus-undo
 *  double row. */
export const isCompensatingCommit = (
  row: { predecessor_commit_id?: string | null },
): boolean =>
  typeof row.predecessor_commit_id === 'string'
  && row.predecessor_commit_id.length > 0;

// ────────────────────────────────────────────────────────────────
// Grace-window primitive — substrate-only in-memory implementation
// ────────────────────────────────────────────────────────────────

/** Terminal outcome of a grace-window entry. The store reports one of
 *  these every time an entry leaves the held state.
 *
 *  - `'released'`            — grace window expired without a cancel;
 *                              Gateway proceeds with the external dispatch.
 *  - `'cancelled_in_grace'`  — explicit cancel arrived within the
 *                              window; Gateway drops the dispatch and
 *                              transitions the commit row
 *                              `pending → cancelled`. */
export const GRACE_WINDOW_OUTCOMES = [
  'released',
  'cancelled_in_grace',
] as const;

/** String-literal union derived from `GRACE_WINDOW_OUTCOMES`. */
export type GraceWindowOutcome = (typeof GRACE_WINDOW_OUTCOMES)[number];

/** Predicate — true when `value` is a known `GraceWindowOutcome`. */
export const isGraceWindowOutcome = (
  value: unknown,
): value is GraceWindowOutcome =>
  typeof value === 'string'
  && (GRACE_WINDOW_OUTCOMES as readonly string[]).includes(value);

/** A single in-flight dispatch held in the grace window. The Gateway
 *  populates this from the manifest + the dispatch's commit metadata;
 *  the substrate carries no opinion on what `payload` contains beyond
 *  it being an opaque handle the Gateway re-presents on release. */
export interface GraceWindowEntry {
  /** Stable handle the Gateway uses to release / cancel this entry.
   *  Typically equals the commit's `idempotency_key` so the audit-row
   *  pre-write + grace entry share a single ID. */
  readonly grace_id: string;
  /** Ingredient slug being dispatched — the tool that fires when the
   *  window expires unreleased. */
  readonly tool_slug: string;
  /** Slug of the partner tool declared on the manifest; the audit row
   *  carries this as informational metadata when the entry is
   *  cancelled, but the substrate does not auto-invoke it (cognition
   *  decides when to dispatch the partner; see spec § post-window
   *  compensating commits). */
  readonly cancellation_partner: string;
  /** Effective milliseconds the entry is held — equals
   *  `getEffectiveGraceWindowMs(manifest)` at admission time. */
  readonly window_ms: number;
  /** Unix-ms admission timestamp from the store's `now()`. The entry's
   *  expiry is `admitted_at + window_ms`. */
  readonly admitted_at: number;
  /** Opaque handle the Gateway re-presents on release — the actual
   *  dispatch payload (ingredient input + resolved vault refs). The
   *  substrate never inspects this field. */
  readonly payload: unknown;
}

/** Result of `cancelInGrace` / `releaseExpired`. The hit-or-miss flag
 *  lets callers distinguish "we cancelled an actual entry" from
 *  "nothing was held under that id" without throwing. */
export type GraceCancelResult =
  | { readonly outcome: 'cancelled_in_grace'; readonly entry: GraceWindowEntry }
  | { readonly outcome: 'not_found' };

/** Substrate interface for the Gateway's grace-window store. The
 *  Engine wiring (D-145) admits dispatches via `admit()`, polls
 *  `releaseExpired()` on a tick, and routes explicit cancels through
 *  `cancelInGrace(grace_id)`. The store itself is policy-agnostic — it
 *  does not invoke partners, does not write audit rows, does not block
 *  on time; callers drive lifecycle. */
export interface GraceWindowStore {
  /** Admit a dispatch into the grace window. The Gateway has already
   *  resolved `entry.window_ms` via `getEffectiveGraceWindowMs`. */
  admit(entry: GraceWindowEntry): void;
  /** Snapshot of the currently-held entry under `grace_id`, or
   *  undefined when nothing is held under that key. */
  get(grace_id: string): GraceWindowEntry | undefined;
  /** Cancel a held entry. Returns the cancelled entry so the caller
   *  can transition the audit row `pending → cancelled`. No-op
   *  (returns `'not_found'`) when nothing is held under `grace_id`. */
  cancelInGrace(grace_id: string): GraceCancelResult;
  /** Sweep expired entries — those whose `admitted_at + window_ms`
   *  precedes the store's `now()`. Returns the released entries in
   *  admission order so the Gateway can dispatch them downstream and
   *  transition each `pending → succeeded|failed`. */
  releaseExpired(): GraceWindowEntry[];
  /** Snapshot of every entry currently held, in admission order. */
  list(): GraceWindowEntry[];
  /** Count of held entries — `list().length` without the allocation. */
  size(): number;
}

/** In-memory `GraceWindowStore` implementation. Substrate-only — the
 *  real Gateway wiring (D-145) drives admit / release / cancel from
 *  the dispatch outbox. The store accepts an injectable `now()` so
 *  tests + future virtual-time harnesses can drive expiry
 *  deterministically; production callers pass `Date.now`.
 *
 *  Insertion order is preserved (JavaScript `Map` insertion-order
 *  iteration) so `list()` + `releaseExpired()` return entries in the
 *  order they were admitted. Re-admitting an existing `grace_id` is
 *  rejected with a throw — the Gateway must cancel-then-admit if it
 *  wants to replace a held entry. */
export const createInMemoryGraceWindowStore = (
  now: () => number = Date.now,
): GraceWindowStore => {
  const entries = new Map<string, GraceWindowEntry>();

  return {
    admit: (entry: GraceWindowEntry): void => {
      if (entries.has(entry.grace_id)) {
        throw new Error(
          `grace-window: grace_id "${entry.grace_id}" already held`,
        );
      }
      entries.set(entry.grace_id, entry);
    },
    get: (grace_id: string): GraceWindowEntry | undefined =>
      entries.get(grace_id),
    cancelInGrace: (grace_id: string): GraceCancelResult => {
      const entry = entries.get(grace_id);
      if (!entry) return { outcome: 'not_found' };
      entries.delete(grace_id);
      return { outcome: 'cancelled_in_grace', entry };
    },
    releaseExpired: (): GraceWindowEntry[] => {
      const t = now();
      const released: GraceWindowEntry[] = [];
      for (const entry of entries.values()) {
        if (entry.admitted_at + entry.window_ms <= t) {
          released.push(entry);
        }
      }
      for (const entry of released) entries.delete(entry.grace_id);
      return released;
    },
    list: (): GraceWindowEntry[] => Array.from(entries.values()),
    size: (): number => entries.size,
  };
};
