/** D-177 P5a — batched approval (N.10): one ask, one reviewable payload,
 *  per (origin unit × ingredient × operation × connection).
 *
 *  "Per turn" exists only on chat, so the universal aggregation key is a
 *  CHANNEL-RESOLVED ORIGIN UNIT (the `deriveChannelSessionId` precedent —
 *  same machinery, channel-specific unit): chat groups by `turn_id`
 *  (`correlation_id` stand-in until the turn is plumbed), mcp by the ~1-min
 *  `correlation_id` burst, the event channels by their fire's `run_id`, and
 *  everything else degenerates to the run itself (one hold per run ⇒ no
 *  aggregation, today's per-hold ask).
 *
 *  A hold whose key matches an OPEN batch ask JOINs it as a new member
 *  instead of minting a second ask; the payload re-renders and
 *  `payload_version` bumps (each version is one `PendingAsk` — the
 *  superseded ask is cancelled, so answering a stale version is detected by
 *  the version guard and rejected; the live ask is the re-ask). The batch
 *  ask is a durable row with state `open | closing | answered`: approve
 *  atomically transitions `open → closing` guarded by the answered
 *  version, snapshots the member set, and mints a `grant_mode: 'batch'`
 *  session grant from the snapshot — `max_uses` = member count, one
 *  stable `member_id` per item (duplicate payload hashes stay distinct
 *  members). EACH MEMBER'S RESUME CLAIMS ITS OWN MEMBER at the commit
 *  Gateway's proceed point (the `preflight_batch_claim` marker — the
 *  member-id sibling of the P3 mint marker), and an agent replay claims an
 *  unconsumed member by payload-hash equality (the N.4 `'batch'` arm), so
 *  TOTAL EXECUTIONS NEVER EXCEED THE APPROVED MEMBER COUNT — the grant is
 *  the approval materialized, not an extra repeat budget.
 *
 *  This module is the PURE vocabulary: the payload + row shapes, the
 *  aggregation key, the origin-unit derivation, and the rendering helpers.
 *  The durable store lives in `@recued/storage` (`batch-asks.ts`); the
 *  join/answer flow in `backend/server/src/batch-approval.ts`.
 *
 *  Spec: D-177 § N.10 / N.3 / N.4; landing order P5a. */

import { canonicalJSONStringify } from '@recued/crypto/canonical-json';
import type { Actor, Channel, ExecutionSource } from './commits.js';
import type { RiskTier } from './ingredient.js';

// ────────────────────────────────────────────────────────────────
// Origin unit — the channel-resolved aggregation boundary
// ────────────────────────────────────────────────────────────────

/** The four origin-unit kinds (N.10 table). Closed list. */
export type OriginUnitKind = 'turn' | 'run' | 'burst' | 'fire';

/** The channel-resolved origin unit a hold aggregates under. */
export interface OriginUnit {
  readonly kind: OriginUnitKind;
  readonly id: string;
}

/** Project an `ExecutionSource` + the run's engine-assigned identifiers
 *  onto its origin unit (N.10):
 *
 *   - `chat`  → `turn` — the chat `turn_id` when the source carries one
 *     (P5a plumbs it onto the chat `ExecutionSource`, and therefore onto
 *     every commit input); `correlation_id` is the spec'd stand-in for a
 *     chat dispatch that pre-dates the plumbing. Ids are prefixed so the
 *     two sources can never collide.
 *   - `mcp`   → `burst` — the ~1-min `correlation_id` intent burst
 *     (`commit-identity.ts`): one JSON-RPC call is one dispatch today;
 *     bursts group sequential calls.
 *   - `schedule` / `reactive` / `webhook` / `housekeeping` → `fire` — the
 *     fire's `run_id`.
 *   - everything else (`user` / `messenger` / `reception`) → `run` — the
 *     run's own id. A run pauses at its first gated call and ends, so a
 *     run-unit batch is the degenerate single-member case (today's ask);
 *     the gated-step `foreach` coverage rides one member by construction.
 *
 *  Pure + total over the 9-channel closed list. */
export const deriveOriginUnit = (
  source: ExecutionSource,
  ids: { readonly run_id: string; readonly correlation_id: string },
): OriginUnit => {
  switch (source.channel) {
    case 'chat':
      return source.turn_id !== undefined && source.turn_id.length > 0
        ? { kind: 'turn', id: `turn:${source.turn_id}` }
        : { kind: 'turn', id: `corr:${ids.correlation_id}` };
    case 'mcp':
      return { kind: 'burst', id: ids.correlation_id };
    case 'schedule':
    case 'reactive':
    case 'webhook':
    case 'housekeeping':
      return { kind: 'fire', id: ids.run_id };
    default:
      return { kind: 'run', id: ids.run_id };
  }
};

// ────────────────────────────────────────────────────────────────
// The reviewable payload (N.10 — the one shape, every surface)
// ────────────────────────────────────────────────────────────────

/** One enumerated member of a batched approval — a held boundary-crossing
 *  call the user is reviewing. `member_id` is the stable identity the
 *  approval mints into `batch_members` (duplicate payload hashes stay
 *  distinct members); `summary` is the one-line human rendering of the
 *  resolved args; `args_preview` is the redaction-respecting resolved-args
 *  object (vault refs stay `{{vault.*}}` placeholders — the hash basis
 *  resolves with `deferVault`, so no secret ever enters the preview). */
export interface BatchedApprovalItem {
  readonly member_id: string;
  readonly canonical_payload_hash: string;
  readonly summary: string;
  readonly args_preview?: Record<string, unknown>;
}

/** The one reviewable payload shape — uniform across every gated surface
 *  (recipe step, chat tool call, MCP native call). Spec-pinned (N.10). */
export interface BatchedApprovalPayload {
  readonly ingredient_slug: string;
  /** Catalog op path (D-165). Absent on simple-form dispatches — and on
   *  every P5a batch row in practice (the batch path is scoped to
   *  commit-gateway holds, where the op axis is absent by construction;
   *  the catalog-gate loop is the named follow-on). */
  readonly operation_id?: string;
  readonly connection_name?: string;
  readonly risk_tier: RiskTier;
  /** `(channel × actor × contract_id)` verbatim (D-153). */
  readonly source: ExecutionSource;
  readonly unit: OriginUnit;
  readonly items: ReadonlyArray<BatchedApprovalItem>;
  /** Bumps on every JOIN; the approve pins it (stale approve → rejected
   *  and re-asked). */
  readonly payload_version: number;
}

// ────────────────────────────────────────────────────────────────
// The durable batch-ask row (`open | closing | answered`)
// ────────────────────────────────────────────────────────────────

/** Lifecycle of a batch-ask row (N.10). `open` accumulates members;
 *  `closing` is the answered-version-guarded transition (member set
 *  frozen, answer work — mint / resume / deny — in flight, possibly
 *  across a crash-retry); `answered` is terminal. */
export type BatchAskState = 'open' | 'closing' | 'answered';

/** One member of a batch-ask row — the durable record of a held run that
 *  joined the ask. Carries the resume anchors (`checkpoint_id` +
 *  `run_id`) alongside the reviewable item fields. */
export interface BatchAskMember extends BatchedApprovalItem {
  readonly checkpoint_id: string;
  readonly run_id: string;
  /** Stable operation receipt. Optional for rows written before receipt
   * support; never used as approval or dispatch authority. */
  readonly action_ref?: string;
}

/** The durable batch-ask row. One row per
 *  `(unit × ingredient × operation × connection)` aggregation while open;
 *  the pinned facets (`recipe_id` / `recipe_hash` / `arg_shape_hash` /
 *  `risk_tier` / channel / actor / session) are the N.4 common-predicate
 *  bindings the eventual `grant_mode: 'batch'` mint carries — a same-key
 *  hold whose facets differ does NOT join (it falls back to a per-hold
 *  ask; strictly conservative). `current_ask_id` tracks the live
 *  `PendingAsk` for the current `payload_version` (each version is one
 *  ask; the superseded ask is cancelled on JOIN). */
export interface BatchAskRecord {
  readonly batch_id: string;
  state: BatchAskState;
  payload_version: number;
  /** Monotonic member-id seed — `member_id`s are `m<seq>` within the row,
   *  stable across payload re-renders by construction. */
  member_seq: number;
  readonly unit_kind: OriginUnitKind;
  readonly unit_id: string;
  readonly ingredient_slug: string;
  readonly operation_id?: string;
  readonly connection_name?: string;
  readonly channel: Channel;
  readonly actor: Actor;
  readonly channel_session_id: string;
  readonly risk_tier: RiskTier;
  readonly recipe_id: string;
  readonly recipe_hash: string;
  readonly arg_shape_hash: string;
  /** The run's `(channel × actor × contract_id)` source, verbatim — the
   *  payload's `source` field (first member's run pins it). */
  readonly source: ExecutionSource;
  members: BatchAskMember[];
  /** The live `PendingAsk` for `payload_version`. Updated after each
   *  JOIN re-raise; a crash between bump and re-raise leaves it pointing
   *  at the cancelled ask — self-healing (the next join, or the block's
   *  boot re-delivery of whichever ask is still open, converges). */
  current_ask_id: string;
  created_at: number;
  updated_at: number;
  /** Recorded at close — the winning option (`approve` / `deny`) and the
   *  version it answered, so an at-least-once answer re-dispatch can
   *  prove it is the SAME answer and idempotently finish the work. */
  answer_option?: string;
  answered_version?: number;
  answered_at?: number;
}

/** The aggregation-key facets of a hold — everything `findOpen` matches.
 *  The 4-tuple `(unit × ingredient × operation × connection)` is the
 *  spec key; the remaining facets are the grant bindings that must also
 *  agree for a JOIN to be mintable (a mismatch falls back to a per-hold
 *  ask rather than splitting the row). */
export interface BatchAskKey {
  readonly unit: OriginUnit;
  readonly ingredient_slug: string;
  readonly operation_id?: string;
  readonly connection_name?: string;
  readonly channel: Channel;
  readonly actor: Actor;
  readonly channel_session_id: string;
  readonly risk_tier: RiskTier;
  readonly recipe_id: string;
  readonly recipe_hash: string;
  readonly arg_shape_hash: string;
}

/** True when an open row matches every facet of `key` — the JOIN
 *  predicate. The 4-tuple selects; the pinned facets verify. */
export const batchAskKeyMatches = (
  row: BatchAskRecord,
  key: BatchAskKey,
): boolean =>
  row.unit_kind === key.unit.kind
  && row.unit_id === key.unit.id
  && row.ingredient_slug === key.ingredient_slug
  && (row.operation_id ?? undefined) === (key.operation_id ?? undefined)
  && (row.connection_name ?? undefined) === (key.connection_name ?? undefined)
  && row.channel === key.channel
  && row.actor === key.actor
  && row.channel_session_id === key.channel_session_id
  && row.risk_tier === key.risk_tier
  && row.recipe_id === key.recipe_id
  && row.recipe_hash === key.recipe_hash
  && row.arg_shape_hash === key.arg_shape_hash;

// ────────────────────────────────────────────────────────────────
// Bounds
// ────────────────────────────────────────────────────────────────

/** Member cap per batch ask — a runaway agent looping holds must not grow
 *  one ask without bound (each member is a checkpointed run; the ask body
 *  enumerates them for human review). At the cap a further same-key hold
 *  falls back to a per-hold ask (conservative — more asks, never fewer
 *  reviews). */
export const BATCH_ASK_MAX_MEMBERS = 50;

/** Per-member `args_preview` byte cap (canonical JSON length). An
 *  over-sized preview is OMITTED — the one-line `summary` still renders,
 *  and the member is otherwise unaffected. Keeps the durable row + the
 *  rendered ask bounded. */
export const BATCH_ARGS_PREVIEW_MAX_BYTES = 4096;

/** Display cap for the enumerated items block in the ask body — beyond
 *  this the rendering appends "+K more". Every member is still in the
 *  payload (`items`) for surfaces that render the full set. */
export const BATCH_ASK_RENDER_MAX_ITEMS = 12;

/** TTL for the `grant_mode: 'batch'` grant the approve mints. The batch
 *  grant is the APPROVAL MATERIALIZED (claim-once per member), not an N.6
 *  session loosening, so its lifetime is deliberately NOT the owner
 *  cell's `session_grant_defaults.ttl_ms`: it only needs to cover the
 *  member resumes (seconds) plus the agent-replay absorption window
 *  within the same origin unit. 15 minutes — conservative; an unclaimed
 *  member past expiry simply re-asks. */
export const BATCH_GRANT_TTL_MS = 900_000;

// ────────────────────────────────────────────────────────────────
// Rendering (pure)
// ────────────────────────────────────────────────────────────────
//
//  This block renders the ONE surface where the owner exercises the
//  judgment the gate exists to collect. Everything here is therefore
//  written to a single rule: SHOW WHAT WAS ASKED FOR, IN WORDS, WITHOUT
//  HIDING ANY OF IT. Three consequences worth stating, because each is a
//  place the "obvious" tidier rendering would quietly lie:
//
//   - NO FIELD IS EVER DROPPED. An empty value is not a missing one:
//     `filter: (empty)` on a delete is the difference between removing
//     one row and removing the table. Empties render compactly as
//     `(empty)` / `(null)` — the reader still sees the field, and the
//     noise the k=v dump created was its SYNTAX, not its coverage.
//   - CLIPPING NEVER HIDES A SIZE. Any collection the clip would cut
//     keeps its element count in front of the ellipsis, so a reader can
//     always tell how much they are approving. `to: [500 addresses]`
//     must never render as four addresses and an ellipsis.
//   - A VALUE NEVER AUTHORS THE DOCUMENT IT APPEARS IN. Args are
//     agent-authored verbatim, so both delimiters of this grammar — the
//     line break and the field separator — are stripped out of every
//     rendered value AND key (`neutralize`). A `subject` cannot
//     manufacture a `to:` that isn't an argument.
//   - HOISTING PROVES SAMENESS BEFORE IT CLAIMS IT. "All N share …" is
//     decided on RAW values (never the clipped rendering) and on
//     STRUCTURAL field ids (never the display label) — both shortcuts
//     silently drop a member's real value out of the ask while asserting
//     the calls were identical. See `PreviewField.id` + `commonFieldIds`.

/** Per-value clip. Generous enough to read a subject line or a short body
 *  in full; the exact bytes are pinned by `canonical_payload_hash`, so
 *  this bounds the RENDERING, never the approval. */
const VALUE_CLIP = 96;

/** Whole one-line `summary` clip — the durable per-member fallback line. */
const SUMMARY_CLIP = 240;

/** Depth at which a nested object stops being flattened into dotted
 *  labels and renders inline instead. Two levels covers the shapes real
 *  ops use (`properties.dealstage`); deeper nesting reads better inline
 *  than as a `a.b.c.d` label. */
const MAX_FLATTEN_DEPTH = 2;

/** Depth cap for inline value rendering. Also the totality guard: a
 *  cyclic structure (which `projectResolvedArgs` upstream already makes
 *  impossible, but this helper is exported and pure) terminates at the
 *  cap instead of overflowing the stack. */
const MAX_INLINE_DEPTH = 3;

const EMPTY_MARK = '(empty)';
const NULL_MARK = '(null)';

/** Field separator for the one-line renderings. A middot rather than a
 *  comma because arg VALUES routinely contain commas (a subject, an
 *  address) — but choosing a rarer character is NOT what makes the
 *  grammar safe. A middot is as typeable as a comma, and `args_preview`
 *  is agent-authored content verbatim, so the separator is removed from
 *  every rendered value (`neutralize`) rather than merely made unusual.
 *  Rarity is ergonomics; the strip is the guarantee. */
const FIELD_SEP = ' · ';
const FIELD_SEP_CHAR = '·';

/** What a value's own middot becomes. The separator must be UNFORGEABLE
 *  by construction, so no rendered value may contain it — a value that
 *  did could fabricate whole fields inside the line the reader trusts
 *  most (see `neutralize`). A middot inside a real arg is vanishingly
 *  rare, and the exact bytes are pinned by `canonical_payload_hash`
 *  regardless: the rendering owes the reader a trustworthy STRUCTURE,
 *  and that is worth one substituted character in a value. */
const FIELD_SEP_REPLACEMENT = '-';

/** Truncate a rendered value. */
const clip = (s: string, max: number): string =>
  s.length <= max ? s : `${s.slice(0, max - 1)}…`;

// ────────────────────────────────────────────────────────────────
// Shortening + folding — a cut to the SYNTAX, never to the coverage
// ────────────────────────────────────────────────────────────────
//
//  The owner ruling on approval surfaces is that the READER decides which
//  fields matter, not this module (decisions-log 2026-07-21: *"there's no
//  way for sure, so the best is laying it out"*). So nothing below removes
//  a field. What it removes is the space a field costs when it carries
//  nothing a person can act on:
//
//   - A UUID is never verified by eye. It renders as the prefix that still
//     correlates it with a log line or a vendor console, and no further —
//     36 characters of hex buy the reader exactly the same decision that 8
//     do, while pushing the fields that DO decide it off the screen.
//   - Seven consecutive `(null)` lines are seven lines that say "absent".
//     The field NAMES are the whole of that information, so they fold onto
//     one labelled line and every name survives it.
//   - Identifier bookkeeping folds the same way — but only when it is
//     actually crowding out something else to read (see `foldIds`), so an
//     op whose args ARE an id never hides its only argument.
//
//  ⚠ Every fold is LABELLED and enumerates its members, because the one
//  distinction this surface cannot afford to lose is "folded" vs "never in
//  the payload". `not set: cc, filter` still tells the reader `filter` is
//  unset on a delete; a field silently omitted does not.

/** A full UUID anywhere inside a value, in any case. */
const UUID_RE =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** How much of an opaque identifier survives: enough to match it against a
 *  log line, never enough to suggest it was read. The exact bytes stay
 *  pinned by `canonical_payload_hash` — this bounds the RENDERING. */
const ID_KEEP = 8;

/** Beyond this an id-ish value is clipped even when it is not a UUID. */
const ID_VALUE_CLIP = 12;

/** A leaf key whose value is a handle rather than a decision input.
 *  Matched on the LAST dotted segment, so `metadata.form_definition_id`
 *  qualifies and a field merely nested under one does not. */
const ID_KEY_RE = /(?:^|[._-])(id|ids|uuid|guid|hash|etag|token|ref)$/i;

const isIdKey = (label: string): boolean => ID_KEY_RE.test(label);

/** Does this token read as machine entropy rather than as words? Three
 *  independent tells, any one of which is enough: it is hex, it mixes case
 *  inside a single unbroken token (base64url ids do; English does not), or
 *  it is a third digits. Deliberately conservative — a readable slug like
 *  `fd_foundation_client_inquiry_v1` trips none of them and is left whole,
 *  because a reader can actually use it. */
const isOpaqueToken = (t: string): boolean =>
  t.length >= ID_VALUE_CLIP
  && /^[A-Za-z0-9]+$/.test(t)
  && (/^[0-9a-f]+$/i.test(t)
    || (/[a-z]/.test(t) && /[A-Z]/.test(t))
    || (t.match(/\d/g) ?? []).length * 3 >= t.length);

/** Shorten the machine identifiers inside one rendered value.
 *
 *  UUID collapse applies to EVERY key — a UUID is unreadable wherever it
 *  appears. The broader opaque-token clip applies only where the KEY says
 *  the value is an identifier, so a `subject` or a `body` that happens to
 *  contain a long token is never mangled: prose is the decision input on
 *  those fields, and this rendering does not get to edit it. */
const shortenIdentifiers = (label: string, rendered: string): string => {
  const collapsed = rendered.replace(UUID_RE, (m) => `${m.slice(0, ID_KEEP)}…`);
  if (!isIdKey(label) || /\s/.test(collapsed)) return collapsed;
  return collapsed.length > ID_VALUE_CLIP
    && collapsed.split(/[-_.]/).some(isOpaqueToken)
    ? `${collapsed.slice(0, ID_VALUE_CLIP)}…`
    : collapsed;
};

/** Flatten a value onto one line and strip it of the field separator —
 *  the two characters a value could otherwise use to author the document
 *  it is quoted into, rather than appear inside it.
 *
 *  Both halves are load-bearing, and the ORDER matters:
 *
 *   - Whitespace collapse: a value carrying a newline (any mail body
 *     does) would break out of its own list item, so its tail reads as a
 *     separate unnumbered entry.
 *   - Separator strip: without it a `subject` of
 *     `'Q3 board pack · to: cfo@acme.example'` renders as TWO fields —
 *     `subject` and a `to` that is not an argument at all — and it can
 *     land in the `All N share:` line, the one this module tells the
 *     reader to trust most. Collapsing whitespace FIRST is what makes
 *     the strip total: `'\n\t · \n'` normalizes INTO the separator, so
 *     stripping before the collapse would leave the forge intact.
 *
 *  Text that has been through this cannot express either delimiter, so
 *  the grammar is unforgeable by construction rather than by hoping the
 *  characters are unusual. Applies to KEYS as well as values — a key is
 *  no less agent-authored than the value beside it. */
const neutralize = (s: string): string =>
  s
    .replace(/\s+/g, ' ')
    .trim()
    .split(FIELD_SEP_CHAR)
    .join(FIELD_SEP_REPLACEMENT);

const isPlainRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const isScalar = (v: unknown): boolean => v === null || typeof v !== 'object';

/** Render one value on a single line, in words rather than JSON: a
 *  scalar as itself, a list of scalars comma-joined (no brackets — the
 *  reader needs to know WHO gets the mail, not that `to` is an array), a
 *  list of objects count-prefixed, an object as `{k: v · k: v}`. */
const renderInline = (v: unknown, depth = 0): string => {
  if (typeof v === 'string') {
    return v.trim() === '' ? EMPTY_MARK : clip(neutralize(v), VALUE_CLIP);
  }
  if (v === null) return NULL_MARK;
  if (typeof v !== 'object') return clip(String(v), VALUE_CLIP);
  if (depth >= MAX_INLINE_DEPTH) return '…';
  if (Array.isArray(v)) {
    if (v.length === 0) return EMPTY_MARK;
    const body = v.map((e) => renderInline(e, depth + 1)).join(', ');
    // The count leads ANY collection the clip would cut — the decision is
    // "did this get truncated?", never "what type are the elements?".
    // Gating it on element type left the highest-stakes field in the
    // system size-less: `to: [500 addresses]` rendered as four addresses
    // and an ellipsis, and the owner approved believing it was four. The
    // brackets are gone (a reader needs to know WHO gets the mail, not
    // that `to` is an array), so the count is the ONLY cardinality signal
    // left — it cannot be optional.
    return v.every(isScalar) && body.length <= VALUE_CLIP
      ? body
      : clip(`${v.length}: ${body}`, VALUE_CLIP);
  }
  const entries = Object.entries(v as Record<string, unknown>);
  if (entries.length === 0) return EMPTY_MARK;
  return clip(
    `{${entries
      .map(([k, val]) => `${neutralize(k)}: ${renderInline(val, depth + 1)}`)
      .join(FIELD_SEP)}}`,
    VALUE_CLIP,
  );
};

/** One labeled leaf of a resolved-args object.
 *
 *  `value` is the RAW value — retained because commonality across batch
 *  members must be decided on it, never on `rendered` (which is clipped).
 *
 *  `id` is the leaf's STRUCTURAL identity, and it is deliberately not
 *  `label`. Flattening is lossy in one specific way: a nested `{a:{b:1}}`
 *  and a literal key `{'a.b':2}` both render the label `a.b`. Deciding
 *  commonality by label would then match the wrong leaf and hoist one
 *  member's value over another's — the second member's real value would
 *  disappear from the ask entirely, and the block would claim the calls
 *  were identical. `id` is the encoded key PATH, which is unique within
 *  an object by construction, so a label collision stays cosmetic (two
 *  lines that read alike) instead of semantic (a value nobody sees). */
interface PreviewField {
  readonly id: string;
  readonly label: string;
  readonly value: unknown;
  readonly rendered: string;
}

/** Flatten resolved args into labeled leaves, nested plain objects
 *  becoming dotted labels (`properties.dealstage`) down to
 *  {@link MAX_FLATTEN_DEPTH}. Key order follows the object — the
 *  projected wire form, i.e. the order the op's author declared. */
const toFields = (
  args: Record<string, unknown>,
  path: readonly string[] = [],
  depth = 0,
): PreviewField[] => {
  const out: PreviewField[] = [];
  for (const [k, v] of Object.entries(args)) {
    const next = [...path, k];
    if (
      depth < MAX_FLATTEN_DEPTH
      && isPlainRecord(v)
      && Object.keys(v).length > 0
    ) {
      out.push(...toFields(v, next, depth + 1));
      continue;
    }
    const label = next.map(neutralize).join('.');
    out.push({
      // `id` is the RAW path — identity must not be neutralized (two keys
      // differing only by a middot are different keys). `label` is the
      // rendering, so it is.
      id: JSON.stringify(next),
      label,
      value: v,
      // ⚠ `rendered` is shortened; `value` is NOT. Commonality across batch
      // members is decided on `value`, so two different uuids can never
      // hoist into "All N share" on the strength of a shared 8-char prefix.
      rendered: shortenIdentifiers(label, renderInline(v)),
    });
  }
  return out;
};

/** One-line human rendering of a resolved-args object — the member
 *  `summary` (N.10 items), and the fallback line for any surface without
 *  the structured preview. An empty / absent args object renders the
 *  placeholder so a summary is never the empty string. */
export const summarizeArgsPreview = (
  args: Record<string, unknown> | undefined,
): string => {
  if (args === undefined) return '(args unavailable)';
  const fields = toFields(args);
  if (fields.length === 0) return '(no args)';
  return clip(
    fields.map((f) => `${f.label}: ${f.rendered}`).join(FIELD_SEP),
    SUMMARY_CLIP,
  );
};

/** Fold identifier fields onto one line only once there are at least this
 *  many of them. One id beside four real fields is not what makes a block
 *  unreadable, and moving it would cost the reader more than it saves. */
const ID_FOLD_MIN = 2;

/** Members a shared path needs before it earns a header line of its own.
 *  One `metadata.timeline` reads perfectly well flat, and hoisting it would
 *  spend a line to save nine characters on the only line under it. */
const GROUP_MIN = 2;

const parentPath = (label: string): string => {
  const cut = label.lastIndexOf('.');
  return cut === -1 ? '' : label.slice(0, cut);
};

const leafName = (label: string): string =>
  label.slice(label.lastIndexOf('.') + 1);

/** The label a FOLDED field carries on its one-line row. Dotted paths are
 *  reduced to the leaf, but ONLY when that leaf names exactly one field in
 *  the whole payload — otherwise `metadata.contact_id` and `contact_id`
 *  would both read `contact_id` on the same line, and the reader could no
 *  longer tell which of the two the operation carries. Ambiguity keeps the
 *  full path; that is the case worth spending characters on. */
const foldLabel = (
  field: PreviewField,
  all: readonly PreviewField[],
): string => {
  const leaf = leafName(field.label);
  return all.filter((other) => leafName(other.label) === leaf).length === 1
    ? leaf
    : field.label;
};

/** Render `args` as one labeled line per field — the single-member view,
 *  where the reader is judging ONE action and can afford to read it.
 *
 *  Fields nested under a shared path are GROUPED under a header rather than
 *  each restating that path: `metadata.timeline` / `metadata.budget_range`
 *  become a `metadata:` line with its leaves indented under it. The prefix
 *  is the same on every row it appears on, so repeating it is exactly the
 *  redundancy that pushes the values — the part being approved — rightward
 *  off a narrow surface. Grouping is by ADJACENT run: `toFields` emits a
 *  nested object's leaves contiguously, so runs never reorder the payload.
 *
 *  Three kinds of line never earn their own row, and each folds onto one
 *  labelled line that still names every member (see the shortening block
 *  above for why folding is not dropping):
 *
 *   - `ids:` — identifier bookkeeping, folded ONLY when at least
 *     {@link ID_FOLD_MIN} of them are competing with a field that actually
 *     decides something. An op whose only argument is an id keeps it on its
 *     own line, where it belongs.
 *   - `not set:` — the absent ones. Wording matches the `/ask` landing
 *     page's `(not set)`, so the two surfaces the owner reaches from a
 *     phone say the same word for the same fact.
 *   - `empty:` — present-and-blank, kept SEPARATE from absent: "the pack
 *     declared this and nothing filled it" and "this is deliberately
 *     blank" are different facts about what approve will commit, and on a
 *     delete `filter` being one or the other is the whole decision. */
const renderFieldLines = (fields: readonly PreviewField[]): string => {
  const isBlank = (f: PreviewField): boolean =>
    f.rendered === NULL_MARK || f.rendered === EMPTY_MARK;
  const idFields = fields.filter((f) => !isBlank(f) && isIdKey(f.label));
  // Fold only when something else survives to read. Otherwise the fold
  // would hide the entire payload behind the word "ids".
  const foldIds =
    idFields.length >= ID_FOLD_MIN
    && fields.some((f) => !isBlank(f) && !isIdKey(f.label));
  const folded = new Set(foldIds ? idFields.map((f) => f.id) : []);

  const visible = fields.filter((f) => !isBlank(f) && !folded.has(f.id));

  const lines: string[] = [];
  for (let i = 0; i < visible.length; ) {
    const parent = parentPath((visible[i] as PreviewField).label);
    let end = i;
    while (
      end < visible.length
      && parentPath((visible[end] as PreviewField).label) === parent
    ) {
      end += 1;
    }
    const run = visible.slice(i, end);
    if (parent !== '' && run.length >= GROUP_MIN) {
      // ⚠ The header carries NO value, and that is what makes it parseable
      // as a header rather than as a field: `renderInline` never yields the
      // empty string (an empty object renders `(empty)` and an empty
      // string folds onto the `empty:` line), so `<path>:` with nothing
      // after it can only be a group.
      lines.push(`  ${parent}:`);
      for (const f of run) lines.push(`    ${leafName(f.label)}: ${f.rendered}`);
    } else {
      for (const f of run) lines.push(`  ${f.label}: ${f.rendered}`);
    }
    i = end;
  }

  if (foldIds) {
    lines.push(
      `  ids: `
        + idFields
          .map((f) => `${foldLabel(f, fields)}: ${f.rendered}`)
          .join(FIELD_SEP),
    );
  }
  const absent = fields.filter((f) => f.rendered === NULL_MARK);
  const empty = fields.filter((f) => f.rendered === EMPTY_MARK);
  if (absent.length > 0) {
    lines.push(
      `  not set: ${absent.map((f) => foldLabel(f, fields)).join(', ')}`,
    );
  }
  if (empty.length > 0) {
    lines.push(`  empty: ${empty.map((f) => foldLabel(f, fields)).join(', ')}`);
  }
  return lines.join('\n');
};

/** The field ids whose RAW value is identical across every member — the
 *  facts that describe the batch rather than any one item.
 *
 *  Compares canonical JSON of the raw values, NEVER the rendered strings:
 *  `rendered` is clipped at {@link VALUE_CLIP}, so three different long
 *  mail bodies sharing their first 95 characters render identically and
 *  would hoist to "all 3 share this body" over three different bodies.
 *  Keyed on `PreviewField.id` (the structural path), never on the display
 *  label — see the note there. A field absent from any member is not
 *  common (absence is not a value). Computed across ALL members,
 *  including those past the display cap — the shared block describes the
 *  whole set the approval covers. */
const commonFieldIds = (
  perItem: ReadonlyArray<readonly PreviewField[]>,
): ReadonlySet<string> => {
  const [first, ...rest] = perItem;
  if (first === undefined) return new Set();
  const common = new Set<string>();
  for (const field of first) {
    const key = canonicalKey(field.value);
    // A value we cannot canonicalize is a value whose equality we cannot
    // prove — so it is not common, and it stays on every item line.
    // Hoisting fails toward showing MORE, never toward asserting a
    // sameness nobody checked.
    if (key === undefined) continue;
    const inAll = rest.every((fields) => {
      const match = fields.find((f) => f.id === field.id);
      return match !== undefined && canonicalKey(match.value) === key;
    });
    if (inAll) common.add(field.id);
  }
  return common;
};

/** Canonical JSON of a value, or `undefined` when it has none.
 *  `canonicalJSONStringify` is the lenient serializer and has NO cycle
 *  guard — it recurses until the stack goes. `projectResolvedArgs` makes
 *  a cyclic preview unreachable upstream (and a stored row round-trips
 *  through JSON, which cannot express one), but these helpers are
 *  exported and pure, and the rendering they feed must not be the thing
 *  that takes an approval down. */
const canonicalKey = (value: unknown): string | undefined => {
  try {
    return canonicalJSONStringify(value);
  } catch {
    return undefined;
  }
};

/** Render the batched-approval ask body (the N.10 items rendering).
 *  Returns the block appended to the base ask sentence; the caller owns
 *  the surrounding message. Three shapes, by what the reader is doing:
 *
 *   - ONE member — they are reading a single action: one labeled line
 *     per field.
 *   - MANY members — they are scanning for the odd one out: the fields
 *     shared by every member hoist into one `All N share:` line, and each
 *     numbered line carries only what VARIES. Nothing is hidden — the
 *     shared line holds exactly what the item lines no longer repeat.
 *   - MANY IDENTICAL members — nothing varies, so there is no list to
 *     scan. Say so plainly and render the call once. (This is what a
 *     looping agent looks like: 12 identical sends. The old rendering
 *     showed it as 12 lines of indistinguishable text.)
 *
 *  Falls back to the durable `summary` lines whenever any member lacks a
 *  structured preview (an over-sized preview is dropped upstream) — a
 *  partial hoist across a partly-known set could assert a shared value
 *  over a member nobody can see. */
export const renderBatchItemsBlock = (
  items: ReadonlyArray<Pick<BatchedApprovalItem, 'summary' | 'args_preview'>>,
): string => {
  // A batch row always carries at least one member, so this is
  // unreachable — but every branch below indexes `items[0]`, and an
  // exported pure helper should not throw on the empty case.
  if (items.length === 0) return '';

  const perItem = items.every((i) => i.args_preview !== undefined)
    ? items.map((i) => toFields(i.args_preview as Record<string, unknown>))
    : undefined;

  if (items.length === 1) {
    const only = items[0] as Pick<BatchedApprovalItem, 'summary' | 'args_preview'>;
    const fields = perItem?.[0];
    return fields === undefined || fields.length === 0
      ? `  ${only.summary}`
      : renderFieldLines(fields);
  }

  const shown = items.slice(0, BATCH_ASK_RENDER_MAX_ITEMS);
  const overflow = items.length - shown.length;
  // Honest tail: the count alone reads as "and some more you can ignore".
  // The approval covers every member, shown or not — say which number.
  const overflowLine =
    overflow > 0
      ? `  …and ${overflow} more (approving covers all ${items.length})`
      : undefined;

  if (perItem === undefined) {
    const lines = shown.map((item, i) => `  ${i + 1}. ${item.summary}`);
    if (overflowLine !== undefined) lines.push(overflowLine);
    return lines.join('\n');
  }

  const common = commonFieldIds(perItem);
  const varying = perItem.map((fields) =>
    fields.filter((f) => !common.has(f.id)),
  );

  if (varying.every((fields) => fields.length === 0)) {
    const first = perItem[0] as readonly PreviewField[];
    return [
      `  All ${items.length} are the same call:`,
      renderFieldLines(first),
    ].join('\n');
  }

  const sharedFields = (perItem[0] as readonly PreviewField[]).filter((f) =>
    common.has(f.id),
  );
  const lines: string[] = [];
  if (sharedFields.length > 0) {
    lines.push(
      `  All ${items.length} share: `
        + sharedFields.map((f) => `${f.label}: ${f.rendered}`).join(FIELD_SEP),
    );
  }
  shown.forEach((item, i) => {
    const fields = varying[i] as readonly PreviewField[];
    lines.push(
      `  ${i + 1}. `
        + (fields.length === 0
          // NOT "same as above": this line sits directly under item i-1,
          // so "above" reads as that item, and an owner concludes this
          // member carries item 1's recipient. It means the opposite —
          // the member has nothing beyond the shared line.
          ? '(only the shared fields)'
          : fields.map((f) => `${f.label}: ${f.rendered}`).join(FIELD_SEP)),
    );
  });
  if (overflowLine !== undefined) lines.push(overflowLine);
  return lines.join('\n');
};

/** Project a batch row onto the spec-pinned {@link BatchedApprovalPayload}
 *  (the row carries resume anchors the payload deliberately omits). */
export const projectBatchedApprovalPayload = (
  row: BatchAskRecord,
): BatchedApprovalPayload => ({
  ingredient_slug: row.ingredient_slug,
  ...(row.operation_id !== undefined ? { operation_id: row.operation_id } : {}),
  ...(row.connection_name !== undefined
    ? { connection_name: row.connection_name }
    : {}),
  risk_tier: row.risk_tier,
  source: row.source,
  unit: { kind: row.unit_kind, id: row.unit_id },
  items: row.members.map((m) => ({
    member_id: m.member_id,
    canonical_payload_hash: m.canonical_payload_hash,
    summary: m.summary,
    ...(m.args_preview !== undefined ? { args_preview: m.args_preview } : {}),
  })),
  payload_version: row.payload_version,
});
