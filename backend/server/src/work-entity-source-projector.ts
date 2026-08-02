/** D-192 P3b — the declaration-driven work-entity projector.
 *
 *  Pure function: one Source declaration × one RAW vendor row → the
 *  exact `WorkEntitySourceMirrorStore.upsertBySourceIdentity` input,
 *  or a row failure. Three lanes (spec § Contract shape):
 *
 *  - **canonical** — declared dot-paths into the kind's closed column
 *    allowlist, normalized through a CLOSED deterministic derivation
 *    set (string/date/boolean/progress coercions, the task-priority
 *    and project-state vocabulary tables; an ordered path COALESCE on
 *    the closed coalescable fields, D-192 CORE #8d). Never long-body
 *    columns, never FK columns.
 *  - **preview** — bounded text clamped to the declared `max_chars`
 *    (default 800, hard cap 2,000). Lands in `source_extension_blob`
 *    under `preview.<field>` with a `detail_fidelity` marker — NEVER
 *    in a canonical long-body column, so nothing downstream can
 *    mistake it for complete content (spec § Sync depth).
 *  - **extension** — declared bounded vendor hints. Caps enforced per
 *    spec: scalar ≤ 500 chars, arrays ≤ 50 items, object depth ≤ 3,
 *    ≤ 50 blob entries, serialized blob ≤ 8 KiB. **Over-cap FAILS the
 *    row** (the runner degrades the Source for the cycle) — silent
 *    truncation into stored fields is forbidden.
 *
 *  Relationship declarations project as EXTENSION HINTS ONLY
 *  (`rel_<local_field>` keys) — Codex H3: the edge substrate is P5,
 *  and a raw vendor id must NEVER reach an in-row canonical FK column
 *  where automation would treat it as a real local id.
 *
 *  `source_record_hash` = `hashCanonical` over the full projected
 *  payload (canonical lane + extension blob) — anything we STORE
 *  participates, so any stored-field change re-syncs; identity fields
 *  and `source_updated_at` are excluded (a version bump that changes
 *  nothing projected must not churn the mirror — the CRM reconciler's
 *  `modified_at`-outside-`hashOf` precedent).
 *
 *  Canonical-cap philosophy: a value that exceeds a canonical column
 *  cap (title > 200) FAILS the row rather than clamping — a clamped
 *  canonical value would silently become the read-before-write base
 *  for a P4 write-back, pushing the truncation to the vendor. */

import {
  NOTE_TITLE_MAX,
  PROJECT_STATE_SET,
  PROJECT_TITLE_MAX,
  TASK_PRIORITY_SET,
  TASK_STATE_MAX,
  TASK_TITLE_MAX,
  WORK_ENTITY_EXTENSION_ARRAY_MAX_ITEMS,
  WORK_ENTITY_EXTENSION_BLOB_MAX_BYTES,
  WORK_ENTITY_EXTENSION_MAX_DEPTH,
  WORK_ENTITY_EXTENSION_MAX_ENTRIES,
  WORK_ENTITY_EXTENSION_SCALAR_MAX_CHARS,
  WORK_ENTITY_PREVIEW_DEFAULT_MAX_CHARS,
  WORK_ENTITY_PREVIEW_HARD_MAX_CHARS,
  WORK_ENTITY_SOURCE_COALESCABLE_CANONICAL,
  WORK_ENTITY_SOURCE_DERIVABLE_CANONICAL,
  WORK_ENTITY_SOURCE_TRANSFORMABLE_CANONICAL,
  type ProjectState,
  type TaskPriority,
  type WorkEntityCanonicalNumberEquals,
  type WorkEntityCanonicalTransformDerivation,
  type WorkEntityCanonicalTransformFn,
  type WorkEntitySourceDeclarableKind,
  type WorkEntitySourceDeclaration,
  type WorkEntitySourceRelationship,
  type WorkEntitySourceSync,
} from '@recued/contracts';
import { stripHtmlText, STRIP_HTML_MAX_INPUT } from '@recued/transforms';

import { getByDotPath } from './source-mirror/fetch.js';
import { hashCanonical } from './source-mirror/hash.js';
import {
  workEntitySourceRuntimeAdapter,
  type ProjectedWorkEntityUpsert as RuntimeProjectedWorkEntityUpsert,
  type WorkEntitySourceProjectedIdentity,
} from './work-entity-source-runtime-adapters.js';

// ────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────

/** The declaration slice the projector consumes — kernel constants
 *  (whose `contract_source` is optional) satisfy this structurally. */
export type WorkEntityProjectionDeclaration = Pick<
  WorkEntitySourceDeclaration,
  'kind' | 'remote' | 'sync' | 'projection' | 'relationships'
>;

export interface ProjectWorkEntitySourceRowInput {
  declaration: WorkEntityProjectionDeclaration;
  source_id: string;
  /** The connection's identity key IS its name in this substrate —
   *  stored as the row's `connection_id`. */
  connection_name: string;
  source_record_id: string;
  /** The raw vendor row (the fetch's raw-mode record). */
  raw: Record<string, unknown>;
}

export type ProjectedWorkEntityUpsert = RuntimeProjectedWorkEntityUpsert;

export type ProjectWorkEntitySourceRowResult =
  | { ok: true; upsert: ProjectedWorkEntityUpsert }
  | { ok: false; reason: string };

// ────────────────────────────────────────────────────────────────
// Closed coercion / derivation set (spec: "field paths plus a closed
// set of deterministic derivations" — no expressions, no AI).
// ────────────────────────────────────────────────────────────────

type Coerced<T> = { ok: true; value: T | undefined } | { ok: false; reason: string };

const absent = (v: unknown): boolean => v === undefined || v === null || v === '';

const coerceText = (v: unknown, field: string, max: number): Coerced<string> => {
  if (absent(v)) return { ok: true, value: undefined };
  const s = typeof v === 'string' ? v : typeof v === 'number' ? String(v) : null;
  if (s === null) return { ok: false, reason: `${field}: expected text, got ${typeof v}` };
  if (s.length > max) {
    return { ok: false, reason: `${field}: ${s.length} chars exceeds the canonical cap ${max}` };
  }
  return { ok: true, value: s };
};

/** Unix-ms coercion: finite numbers pass through, digit strings are
 *  epoch numbers (HubSpot ms-epoch property strings), anything else
 *  goes through `Date.parse` (ISO 8601 and RFC dates). */
const coerceDateMs = (v: unknown, field: string): Coerced<number> => {
  if (absent(v)) return { ok: true, value: undefined };
  if (typeof v === 'number') {
    return Number.isFinite(v)
      ? { ok: true, value: v }
      : { ok: false, reason: `${field}: non-finite number` };
  }
  if (typeof v === 'string') {
    const ms = /^\d+$/.test(v) ? Number(v) : Date.parse(v);
    return Number.isNaN(ms)
      ? { ok: false, reason: `${field}: unparseable date '${v}'` }
      : { ok: true, value: ms };
  }
  return { ok: false, reason: `${field}: expected a date, got ${typeof v}` };
};

const coerceBoolean = (v: unknown, field: string): Coerced<boolean> => {
  if (absent(v)) return { ok: true, value: undefined };
  if (typeof v === 'boolean') return { ok: true, value: v };
  if (v === 'true' || v === 'TRUE' || v === 1) return { ok: true, value: true };
  if (v === 'false' || v === 'FALSE' || v === 0) return { ok: true, value: false };
  return { ok: false, reason: `${field}: expected a boolean, got '${String(v)}'` };
};

const coerceProgress = (v: unknown, field: string): Coerced<number> => {
  if (absent(v)) return { ok: true, value: undefined };
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d+(\.\d+)?$/.test(v) ? Number(v) : NaN;
  if (Number.isNaN(n)) return { ok: false, reason: `${field}: expected a number, got '${String(v)}'` };
  const rounded = Math.round(n);
  if (rounded < 0 || rounded > 100) {
    return { ok: false, reason: `${field}: ${rounded} outside 0–100` };
  }
  return { ok: true, value: rounded };
};

/** D-192 CORE #8c — the `number_equals` derivation: remote numeric →
 *  canonical boolean by STRICT equality against the declared comparand
 *  (Planner `done` = `percentComplete == 100`; the doc's own
 *  convention: "When set to 100, the task is considered completed").
 *  Numeric parse mirrors `coerceProgress` (numbers + digit strings);
 *  absent stays absent (the row-level required-signal checks still
 *  apply); non-numeric FAILS the row — an unparseable completion
 *  signal must never default to incomplete. No rounding: the
 *  derivation states the vendor's convention verbatim, and an
 *  incomplete task projects a REAL `done: false`, never undefined. */
const deriveNumberEquals = (
  spec: WorkEntityCanonicalNumberEquals,
  raw: Record<string, unknown>,
  field: string,
): Coerced<boolean> => {
  const v = getByDotPath(raw, spec.field);
  if (absent(v)) return { ok: true, value: undefined };
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d+(\.\d+)?$/.test(v) ? Number(v) : NaN;
  if (Number.isNaN(n)) {
    return { ok: false, reason: `${field}: derivation expected a number at '${spec.field}', got '${String(v)}'` };
  }
  return { ok: true, value: n === spec.value };
};

/** Closed priority vocabulary (contracts: "real vendors model
 *  completion/priority as enums" — HubSpot LOW/MEDIUM/HIGH, Salesforce
 *  High/Normal/Low, Jira Highest…Lowest). Unmapped values OMIT the
 *  optional canonical field (the raw value stays reachable via a
 *  declared extension entry) — never a guess, never a row failure. */
const TASK_PRIORITY_VOCAB: Record<string, TaskPriority> = {
  low: 'low', lowest: 'low', minor: 'low',
  medium: 'medium', normal: 'medium', default: 'medium',
  high: 'high', highest: 'high', urgent: 'high', critical: 'high', important: 'high',
};

const coercePriority = (v: unknown): Coerced<TaskPriority> => {
  if (absent(v)) return { ok: true, value: undefined };
  if (typeof v !== 'string') return { ok: true, value: undefined };
  const direct = v.toLowerCase();
  if (TASK_PRIORITY_SET.has(direct as TaskPriority)) return { ok: true, value: direct as TaskPriority };
  return { ok: true, value: TASK_PRIORITY_VOCAB[direct] };
};

/** Closed project-state vocabulary. Project `state` is a REQUIRED
 *  canonical enum, so an unmapped vendor status FAILS the row (loud
 *  beats a silently-'active' completed project). */
const PROJECT_STATE_VOCAB: Record<string, ProjectState> = {
  active: 'active', open: 'active', in_progress: 'active', started: 'active',
  paused: 'paused', on_hold: 'paused', onhold: 'paused', blocked: 'paused',
  completed: 'completed', done: 'completed', closed: 'completed', finished: 'completed',
  archived: 'archived', cancelled: 'archived', canceled: 'archived',
};

const coerceProjectState = (v: unknown, field: string): Coerced<ProjectState> => {
  if (absent(v)) return { ok: true, value: undefined };
  if (typeof v !== 'string') return { ok: false, reason: `${field}: expected text, got ${typeof v}` };
  const key = v.toLowerCase().replaceAll(' ', '_').replaceAll('-', '_');
  if (PROJECT_STATE_SET.has(key as ProjectState)) return { ok: true, value: key as ProjectState };
  const mapped = PROJECT_STATE_VOCAB[key];
  if (mapped === undefined) {
    return { ok: false, reason: `${field}: vendor state '${v}' maps to no canonical project state` };
  }
  return { ok: true, value: mapped };
};

/** The kind-appropriate closed coercion for ONE canonical field —
 *  shared by the plain-path lane and the #8d coalesce lane so a
 *  coalesce candidate coerces EXACTLY like a plain path would. `null`
 *  means the field is not projectable for any kind (the P1 validator
 *  closes canonical keys; a null at runtime is declaration/validator
 *  drift the caller fails loud on). */
const coerceCanonicalField = (
  kind: WorkEntitySourceDeclarableKind,
  field: string,
  value: unknown,
): Coerced<unknown> | null => {
  switch (field) {
    case 'title':
      return coerceText(
        value, field,
        kind === 'task' ? TASK_TITLE_MAX : kind === 'note' ? NOTE_TITLE_MAX : PROJECT_TITLE_MAX,
      );
    case 'state':
      return kind === 'project'
        ? coerceProjectState(value, field)
        : coerceText(value, field, TASK_STATE_MAX);
    case 'done':
      return coerceBoolean(value, field);
    case 'progress':
      return coerceProgress(value, field);
    case 'due_at':
    case 'completed_at':
    case 'target_completion_at':
      return coerceDateMs(value, field);
    case 'priority':
      return coercePriority(value);
    default:
      return null;
  }
};

/** D-192 CORE #8d — ordered coalesce over remote field paths: the
 *  first USABLE candidate wins. Absent values skip; a candidate the
 *  field's own coercion rejects skips too — the fallback exists
 *  precisely for the rows where the primary is unusable (Outreach: a
 *  > 200-char `note` falls back to the bounded `action` type slug
 *  instead of failing the row closed; the full note still rides the
 *  preview lane). No survivor: if any present candidate failed
 *  coercion the row FAILS with the FIRST candidate's reason (data
 *  existed and none of it projected — honest beats defaulted, the
 *  plain-path posture); all-absent stays absent (the row-level
 *  required-field checks still apply). */
const coalesceCanonical = (
  kind: WorkEntitySourceDeclarableKind,
  field: string,
  paths: string[],
  raw: Record<string, unknown>,
): Coerced<unknown> => {
  let firstFailure: { ok: false; reason: string } | null = null;
  for (const path of paths) {
    const value = getByDotPath(raw, path);
    if (absent(value)) continue;
    const coerced = coerceCanonicalField(kind, field, value);
    if (coerced === null) {
      return { ok: false, reason: `canonical field '${field}' is not projectable` };
    }
    if (coerced.ok && coerced.value !== undefined) return coerced;
    if (!coerced.ok && firstFailure === null) firstFailure = coerced;
  }
  return firstFailure ?? { ok: true, value: undefined };
};

/** D-192 CORE #8e — the closed whitelist of pure transforms a `transform`
 *  derivation may run, mapped to their `string → string` core PLUS the
 *  `maxInput` bound past which that core silently clips (drops the tail
 *  best-effort). Mirrors `WORK_ENTITY_CANONICAL_TRANSFORM_FNS` (the
 *  contract's declarable set); a name reaching here that this map lacks is
 *  declaration/validator drift the caller fails loud on. `strip_html`
 *  reuses the recipe transform's pure core verbatim — no divergent
 *  HTML-stripping implementation — and carries its own `STRIP_HTML_MAX_INPUT`
 *  clip bound so `deriveTransform` can refuse over-length input rather than
 *  store a truncated result (codex #8e adversarial fold). */
const CANONICAL_TRANSFORM_FNS: Record<
  WorkEntityCanonicalTransformFn,
  { fn: (input: string) => string; maxInput: number }
> = {
  strip_html: { fn: stripHtmlText, maxInput: STRIP_HTML_MAX_INPUT },
};

/** D-192 CORE #8e — the `transform` derivation: run one whitelisted pure
 *  transform over a remote text path, deriving a canonical string
 *  (Confluence `title ← strip_html(body.storage.value)`). Absent source →
 *  absent (the row-level required checks still apply). A present NON-string
 *  source FAILS the row — an HTML transform over a number/object would
 *  fabricate a garbage title (`[object Object]`); honest beats defaulted,
 *  the deriveNumberEquals posture. Input beyond the transform's `maxInput`
 *  clip bound also FAILS the row (codex #8e adversarial fold) — the core
 *  clips SILENTLY, so an over-length body could strip to a within-cap but
 *  TRUNCATED title and store as healthy vendor truth; a derived title must
 *  be complete or fail loud, never a silent partial. The transform OUTPUT
 *  coerces through the field's OWN closed coercion (`coerceCanonicalField`)
 *  — the same seam a plain path or #8d coalesce candidate uses — so a
 *  transform can never widen what the field admits (the title cap still
 *  applies; an empty stripped result is absent → a required title fails
 *  the row loud). */
const deriveTransform = (
  spec: WorkEntityCanonicalTransformDerivation,
  raw: Record<string, unknown>,
  field: string,
  kind: WorkEntitySourceDeclarableKind,
): Coerced<unknown> => {
  const entry = CANONICAL_TRANSFORM_FNS[spec.transform];
  if (entry === undefined) {
    return { ok: false, reason: `${field}: unknown canonical transform '${String(spec.transform)}'` };
  }
  const v = getByDotPath(raw, spec.field);
  if (absent(v)) return { ok: true, value: undefined };
  if (typeof v !== 'string') {
    return { ok: false, reason: `${field}: transform '${spec.transform}' expected text at '${spec.field}', got ${typeof v}` };
  }
  if (v.length > entry.maxInput) {
    return {
      ok: false,
      reason: `${field}: transform '${spec.transform}' input at '${spec.field}' is ${v.length} chars, over the ${entry.maxInput}-char limit — would clip to a truncated result`,
    };
  }
  const coerced = coerceCanonicalField(kind, field, entry.fn(v));
  if (coerced === null) {
    return { ok: false, reason: `canonical field '${field}' is not projectable` };
  }
  return coerced;
};

// ────────────────────────────────────────────────────────────────
// Extension-lane bounds (spec § Sync depth "Hard v1 projection caps")
// ────────────────────────────────────────────────────────────────

const checkBoundedValue = (v: unknown, depth: number, field: string): string | null => {
  if (v === null || typeof v === 'number' || typeof v === 'boolean') return null;
  if (typeof v === 'string') {
    return v.length > WORK_ENTITY_EXTENSION_SCALAR_MAX_CHARS
      ? `${field}: string of ${v.length} chars exceeds the ${WORK_ENTITY_EXTENSION_SCALAR_MAX_CHARS}-char extension cap`
      : null;
  }
  if (depth <= 0) {
    return `${field}: nesting exceeds the depth-${WORK_ENTITY_EXTENSION_MAX_DEPTH} extension cap`;
  }
  if (Array.isArray(v)) {
    if (v.length > WORK_ENTITY_EXTENSION_ARRAY_MAX_ITEMS) {
      return `${field}: array of ${v.length} items exceeds the ${WORK_ENTITY_EXTENSION_ARRAY_MAX_ITEMS}-item extension cap`;
    }
    for (const item of v) {
      const err = checkBoundedValue(item, depth - 1, field);
      if (err !== null) return err;
    }
    return null;
  }
  if (typeof v === 'object') {
    const entries = Object.entries(v as Record<string, unknown>);
    if (entries.length > WORK_ENTITY_EXTENSION_MAX_ENTRIES) {
      return `${field}: object of ${entries.length} entries exceeds the ${WORK_ENTITY_EXTENSION_MAX_ENTRIES}-entry extension cap`;
    }
    for (const [, item] of entries) {
      const err = checkBoundedValue(item, depth - 1, field);
      if (err !== null) return err;
    }
    return null;
  }
  return `${field}: unsupported extension value type ${typeof v}`;
};

// ────────────────────────────────────────────────────────────────
// Tombstone reading (runner-facing, but pure + declaration-driven)
// ────────────────────────────────────────────────────────────────

/** True when the raw row carries the declaration's NATIVE tombstone
 *  marker (`sync.tombstone_field` — Google Tasks `deleted`, HubSpot
 *  `archived`). Deliberately NOT JS truthiness: a status string like
 *  `'active'` must never read as deleted. */
export const isSourceRowTombstoned = (
  sync: WorkEntitySourceSync,
  raw: Record<string, unknown>,
): boolean => {
  if (sync.tombstones !== 'native' || sync.tombstone_field === undefined) return false;
  const v = getByDotPath(raw, sync.tombstone_field);
  return v === true || v === 'true' || v === 'TRUE' || v === 1;
};

// ────────────────────────────────────────────────────────────────
// Projector
// ────────────────────────────────────────────────────────────────

interface LaneOutcome {
  canonical: Record<string, unknown>;
  blob: Record<string, unknown>;
}

const projectLanes = (
  input: ProjectWorkEntitySourceRowInput,
): { ok: true; lanes: LaneOutcome } | { ok: false; reason: string } => {
  const { declaration, raw } = input;
  const { projection } = declaration;
  const canonical: Record<string, unknown> = {};

  // ── canonical lane — closed per-kind coercions ────────────────
  for (const [field, path] of Object.entries(projection.canonical)) {
    // D-192 CORE #8d — the array form is an ordered coalesce of remote
    // field paths. The validator gates it to the kind's coalescable
    // fields (v1: title) and to ≥ 2 non-empty paths; the runtime guard
    // matches the validator EXACTLY (codex #8d fold — a singleton
    // array is validator-rejected shape, and admitting it at runtime
    // would let kernel constants drift into a lane the write executor
    // treats as non-string). An array reaching any other field, or one
    // whose entries would misdrive the path walk, is the same
    // declaration/validator drift — fail loud, never guess.
    if (Array.isArray(path)) {
      if (
        !WORK_ENTITY_SOURCE_COALESCABLE_CANONICAL[declaration.kind].includes(field)
        || path.length < 2
        || !path.every((p) => typeof p === 'string' && p.length > 0)
      ) {
        return { ok: false, reason: `canonical field '${field}' carries an inadmissible coalesce` };
      }
      const coalesced = coalesceCanonical(declaration.kind, field, path, raw);
      if (!coalesced.ok) return coalesced;
      if (coalesced.value !== undefined) canonical[field] = coalesced.value;
      continue;
    }
    // D-192 CORE #8c/#8e — the object form is a closed derivation (a
    // discriminated union on `kind`). The runtime guard mirrors the
    // validator EXACTLY and routes PER KIND: `number_equals` (boolean,
    // CORE #8c) on the derivable set, `transform` (string, CORE #8e) on
    // the transformable set. An object on a field the kind cannot
    // target, or carrying an unknown kind, is declaration/validator
    // drift (kernel constants bypass the publish gate) — fail loud,
    // never guess.
    if (typeof path !== 'string') {
      // `typeof null === 'object'`, so a null canonical value reaches this branch
      // and would throw on `path.kind` below — rejecting the WHOLE sync cycle
      // instead of failing just this row. A null / non-object here is
      // validator-rejected shape (kernel constants bypass the publish gate) —
      // fail the row loud, never crash the cycle.
      if (path === null || typeof path !== 'object') {
        return { ok: false, reason: `canonical field '${field}' carries an inadmissible derivation` };
      }
      let derived: Coerced<unknown>;
      if (path.kind === 'number_equals'
          && WORK_ENTITY_SOURCE_DERIVABLE_CANONICAL[declaration.kind].includes(field)) {
        derived = deriveNumberEquals(path, raw, field);
      } else if (path.kind === 'transform'
          && WORK_ENTITY_SOURCE_TRANSFORMABLE_CANONICAL[declaration.kind].includes(field)) {
        derived = deriveTransform(path, raw, field, declaration.kind);
      } else {
        return { ok: false, reason: `canonical field '${field}' carries an inadmissible derivation` };
      }
      if (!derived.ok) return derived;
      if (derived.value !== undefined) canonical[field] = derived.value;
      continue;
    }
    const value = getByDotPath(raw, path);
    const coerced = coerceCanonicalField(declaration.kind, field, value);
    if (coerced === null) {
      // The P1 validator closes canonical keys per kind; an unknown
      // key reaching runtime is a declaration/validator drift — fail
      // loud rather than write an unvetted column.
      return { ok: false, reason: `canonical field '${field}' is not projectable` };
    }
    if (!coerced.ok) return coerced;
    if (coerced.value !== undefined) canonical[field] = coerced.value;
  }

  // A note has no required canonical column (`title` is optional on the
  // canonical shape; the P1 validator instead requires ≥ 1 preview
  // field on the DECLARATION) — the title requirement is task/project.
  if (
    declaration.kind !== 'note'
    && (typeof canonical.title !== 'string' || canonical.title.length === 0)
  ) {
    return { ok: false, reason: 'title: required canonical field is absent on the vendor row' };
  }
  // Row-level required-signal enforcement (codex P3b fold): the P1
  // validator closes the DECLARATION shape, but a declared path whose
  // value is absent on this row would otherwise store the column
  // default — silently turning an unknown/completed remote row into an
  // active/incomplete local one. Fail the row instead (degrades the
  // Source for the cycle; honest beats defaulted).
  if (
    declaration.kind === 'task'
    && canonical.done === undefined && canonical.state === undefined
  ) {
    return {
      ok: false,
      reason: 'task completion signal (done or state) is absent on the vendor row',
    };
  }
  if (declaration.kind === 'project' && canonical.state === undefined) {
    return {
      ok: false,
      reason: 'state: required canonical field is absent on the vendor row',
    };
  }

  // ── preview lane — clamped text under `preview.*` + fidelity ──
  const blob: Record<string, unknown> = {};
  const preview: Record<string, string> = {};
  for (const [field, spec] of Object.entries(projection.preview ?? {})) {
    const value = getByDotPath(raw, spec.field);
    if (absent(value)) continue;
    const s = typeof value === 'string' ? value : typeof value === 'number' ? String(value) : null;
    if (s === null) {
      return { ok: false, reason: `preview.${field}: expected text, got ${typeof value}` };
    }
    const cap = Math.min(spec.max_chars ?? WORK_ENTITY_PREVIEW_DEFAULT_MAX_CHARS, WORK_ENTITY_PREVIEW_HARD_MAX_CHARS);
    preview[field] = s.length > cap ? s.slice(0, cap) : s;
  }
  if (Object.keys(preview).length > 0) {
    blob.preview = preview;
    // Field-level fidelity metadata (spec § Sync depth) — the map form,
    // covering exactly the preview fields present on this row, so no
    // consumer can mistake clamped text for complete content.
    blob.detail_fidelity = Object.fromEntries(Object.keys(preview).map((k) => [k, 'preview']));
  }

  // ── extension lane — declared bounded hints ───────────────────
  for (const [key, pathOrMarker] of Object.entries(projection.extension ?? {})) {
    if (key === 'detail_fidelity') continue; // marker handled with the preview lane
    if (typeof pathOrMarker !== 'string') {
      return { ok: false, reason: `extension.${key}: expected a remote field path` };
    }
    const value = getByDotPath(raw, pathOrMarker);
    if (absent(value)) continue;
    const err = checkBoundedValue(value, WORK_ENTITY_EXTENSION_MAX_DEPTH, `extension.${key}`);
    if (err !== null) return { ok: false, reason: err };
    blob[key] = value;
  }

  // ── relationship hints — extension-confined (Codex H3) ────────
  for (const rel of declaration.relationships ?? []) {
    const hint = projectRelationshipHint(rel, raw);
    if (hint === undefined) continue;
    if (!hint.ok) return hint;
    blob[`rel_${rel.local_field}`] = hint.value;
  }

  // ── blob-level caps ───────────────────────────────────────────
  const entryCount = Object.keys(blob).length;
  if (entryCount > WORK_ENTITY_EXTENSION_MAX_ENTRIES) {
    return {
      ok: false,
      reason: `extension blob carries ${entryCount} entries, exceeding the ${WORK_ENTITY_EXTENSION_MAX_ENTRIES}-entry cap`,
    };
  }
  if (entryCount > 0) {
    const bytes = Buffer.byteLength(JSON.stringify(blob), 'utf8');
    if (bytes > WORK_ENTITY_EXTENSION_BLOB_MAX_BYTES) {
      return {
        ok: false,
        reason: `extension blob serializes to ${bytes} bytes, exceeding the ${WORK_ENTITY_EXTENSION_BLOB_MAX_BYTES}-byte cap`,
      };
    }
  }

  return { ok: true, lanes: { canonical, blob } };
};

type RelationshipHintOutcome =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; reason: string }
  | undefined;

/** Validated relationship references on one raw row — `undefined` when
 *  the declared remote field is absent/empty. Exported since P5: the
 *  edge resolver (`work-entity-edge-resolution.ts`) re-derives a folded
 *  row's references through this SAME extractor, so the edge set and
 *  the `rel_*` extension hints can never disagree on what the vendor
 *  asserted (one extraction seam, two projections). */
export type RelationshipRefsOutcome =
  | { ok: true; refs: string[] }
  | { ok: false; reason: string }
  | undefined;

export const extractRelationshipRefs = (
  rel: WorkEntitySourceRelationship,
  raw: Record<string, unknown>,
): RelationshipRefsOutcome => {
  const field = `relationships.${rel.local_field}`;
  const value = getByDotPath(raw, rel.remote_field);
  if (absent(value)) return undefined;

  const asRef = (v: unknown): string | null =>
    typeof v === 'string' ? v : typeof v === 'number' ? String(v) : null;

  let refs: string[];
  if (Array.isArray(value)) {
    if (rel.cardinality !== 'many') {
      return { ok: false, reason: `${field}: vendor returned an array for a cardinality-one relationship` };
    }
    if (value.length > WORK_ENTITY_EXTENSION_ARRAY_MAX_ITEMS) {
      return {
        ok: false,
        reason: `${field}: ${value.length} references exceed the ${WORK_ENTITY_EXTENSION_ARRAY_MAX_ITEMS}-item cap`,
      };
    }
    const mapped: string[] = [];
    for (const item of value) {
      if (absent(item)) continue;
      const ref = asRef(item);
      if (ref === null) return { ok: false, reason: `${field}: non-scalar relationship reference` };
      mapped.push(ref);
    }
    if (mapped.length === 0) return undefined;
    refs = mapped;
  } else {
    const ref = asRef(value);
    if (ref === null) return { ok: false, reason: `${field}: non-scalar relationship reference` };
    refs = [ref];
  }
  for (const ref of refs) {
    if (ref.length > WORK_ENTITY_EXTENSION_SCALAR_MAX_CHARS) {
      return { ok: false, reason: `${field}: reference of ${ref.length} chars exceeds the scalar cap` };
    }
  }
  return { ok: true, refs };
};

const projectRelationshipHint = (
  rel: WorkEntitySourceRelationship,
  raw: Record<string, unknown>,
): RelationshipHintOutcome => {
  const extracted = extractRelationshipRefs(rel, raw);
  if (extracted === undefined || !extracted.ok) return extracted;
  const { refs } = extracted;

  // The scoped-hint shape P5's edge resolver consumes — enough to
  // resolve later (target family + pairing + the raw reference),
  // never a canonical local id.
  return {
    ok: true,
    value: {
      target: rel.target,
      pairing: rel.pairing,
      ...(rel.remote_entity !== undefined ? { remote_entity: rel.remote_entity } : {}),
      ...(rel.lookup_key !== undefined ? { lookup_key: rel.lookup_key } : {}),
      ...(rel.cardinality === 'many' ? { values: refs } : { value: refs[0] }),
    },
  };
};

/** Extract the vendor's version value VERBATIM as a string — the
 *  conditional-write precondition token (D-192 P4). Populated for EVERY
 *  version kind whose declared `version.field` is present on the row
 *  (an `updated_at` vendor echoing its own timestamp format, a
 *  `revision` counter, a content `hash`). Undefined for a header-borne
 *  etag (no declared field), for the declared tokenless `'none'` kind
 *  (D-192 CORE #8c — never a token, whatever the declaration carries),
 *  or an absent/unusable value — such rows sync token-less and the P4b
 *  write executor falls back to the read-before-write hash compare.
 *  Shared with the write executor so the token compared at write time
 *  is byte-identical to the token the sync cycle stored. */
export const workEntitySourceVersionToken = (
  version: WorkEntitySourceDeclaration['remote']['version'],
  raw: Record<string, unknown>,
): string | undefined => {
  // D-192 CORE #8c — 'none' is the declared tokenless posture. The
  // validator forbids a field on it at publish; this guard keeps the
  // RUNTIME honest against drift (kernel constants never pass the
  // publish gate), so a 'none' Source can never quietly mint tokens.
  if (version.kind === 'none') return undefined;
  if (version.field === undefined) return undefined;
  const rawVersion = getByDotPath(raw, version.field);
  if (typeof rawVersion === 'string' && rawVersion.length > 0) return rawVersion;
  if (typeof rawVersion === 'number' && Number.isFinite(rawVersion)) return String(rawVersion);
  return undefined;
};

/** Project one raw vendor row into the mirror upsert for its Source.
 *  Pure — no IO, no clock (the mirror upsert stamps time). */
export const projectWorkEntitySourceRow = (
  input: ProjectWorkEntitySourceRowInput,
): ProjectWorkEntitySourceRowResult => {
  const { declaration } = input;
  const lanes = projectLanes(input);
  if (!lanes.ok) return lanes;
  const { canonical, blob } = lanes.lanes;

  // Version fields — BOTH outside the record hash (a version bump with
  // no projected change must not churn the mirror):
  //  - `source_updated_at` — the COERCED ms timestamp, freshness
  //    ordering only; populated for `updated_at` version kinds.
  //  - `source_version_token` (D-192 P4) — the vendor's version value
  //    VERBATIM as a string, the conditional-write precondition token;
  //    populated for EVERY kind whose declared `version.field` is
  //    present on the row (an `updated_at` vendor echoing its own
  //    timestamp format, a `revision` counter, a content `hash`). An
  //    `etag` without a declared field lives in a response HEADER the
  //    list fetch does not expose — such a Source syncs token-less and
  //    the P4 write executor falls back to read-before-write compare.
  let source_updated_at: number | undefined;
  const version = declaration.remote.version;
  const source_version_token = workEntitySourceVersionToken(version, input.raw);
  if (version.kind === 'updated_at' && version.field !== undefined) {
    const coerced = coerceDateMs(getByDotPath(input.raw, version.field), 'remote.version');
    if (!coerced.ok) return coerced;
    source_updated_at = coerced.value;
  }

  // Hash over everything we STORE (canonical + extension blob), in a
  // two-bucket wrapper so a canonical field and an extension key can
  // never collide. `hashCanonical` drops a top-level `id`; neither
  // bucket carries one.
  const source_record_hash = hashCanonical({ canonical, extension: blob });

  const identity: WorkEntitySourceProjectedIdentity = {
    source_id: input.source_id,
    source_record_id: input.source_record_id,
    connection_id: input.connection_name,
    ...(source_updated_at !== undefined ? { source_updated_at } : {}),
    ...(source_version_token !== undefined ? { source_version_token } : {}),
    source_record_hash,
    ...(Object.keys(blob).length > 0 ? { source_extension_blob: blob } : {}),
  };

  // Final canonical construction is owned by the executable landing adapter.
  // A new pack-declarable kind cannot fall through as an existing shape: the
  // exact runtime registry must first supply its projection + storage behavior.
  return {
    ok: true,
    upsert: workEntitySourceRuntimeAdapter(declaration.kind).project(identity, canonical),
  };
};
