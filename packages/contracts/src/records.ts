/**
 * D-221 fixed Records substrate contract.
 *
 * This module is deliberately an installed/runtime contract. Pack authors keep
 * using the existing composition/entity/operation rows and the opaque `bind`
 * cell; no Records-specific pack-content discriminator or entity vocabulary is
 * exported from here.
 */

import type { EntityFieldPrivacy } from './pii-alias.js';

export const RECORDS_DECIMAL_SCALE = 4;
export const RECORDS_DEFAULT_PAGE_SIZE = 50;
export const RECORDS_MAX_PAGE_SIZE = 200;
export const RECORDS_MAX_GET_MANY_IDS = 100;
export const RECORDS_MAX_PREDICATES = 16;
export const RECORDS_MAX_IN_ITEMS = 100;
/** Writes in one batch. ⚠ A batch that needs more than this must chunk — and a
 *  chunked batch is no longer atomic, which is the whole point of it, so the cap
 *  is a design constraint on the caller rather than a knob to raise. */
export const RECORDS_MAX_BATCH_OPS = 100;
export const RECORDS_MAX_QUERY_ROWS = 100_000;
export const RECORDS_MAX_ID_BYTES = 512;
export const RECORDS_MAX_INDEXED_STRING_BYTES = 4 * 1024;
export const RECORDS_MAX_TEXT_BYTES = 1024 * 1024;
export const RECORDS_MAX_ROW_BYTES = 2 * 1024 * 1024;
/** Per-namespace defaults for a NEW Records namespace.
 *
 *  ⛔ SERVER SCALE, NOT EXTENSION SCALE. These were 100_000 rows / 100 MB,
 *  budgets sized when the product lived in a browser extension against
 *  IndexedDB. Records is now where a pack keeps the owner's actual business
 *  data — a ledger, a rental book, a job board — on a self-hosted server with a
 *  real disk, and a 100 MB ceiling stopped that data long before the disk did.
 *  The mirror collections were already re-scaled for the server
 *  (`collection.file` 5 GB, `collection.mail` 2 GB); the owner's OWN authored
 *  data had been left behind, which is backwards: a collection can be
 *  re-synced from its source, and these rows cannot.
 *
 *  ⚠ Records REJECTS at the limit (`records_quota_exceeded`) rather than
 *  evicting, so the old ceiling cost the owner writes, never silent loss.
 *
 *  ⚠ DEFAULTS FOR NEW NAMESPACES ONLY. `store.ts` reads these as the fallback
 *  when a namespace has no stored limit, so an existing install keeps whatever
 *  it was created with until the owner raises it via `records.quota.set`. */
export const RECORDS_DEFAULT_ROW_QUOTA = 5_000_000;
export const RECORDS_DEFAULT_BYTE_QUOTA = 5 * 1024 * 1024 * 1024;
/** Outbox is BACKPRESSURE, not storage — it drains. Raised in step so a bulk
 *  import cannot wedge on the queue while well inside the row/byte budget. */
export const RECORDS_DEFAULT_OUTBOX_QUOTA = 1_000_000;
export const RECORDS_MAX_CAUSAL_DEPTH = 16;
export const RECORDS_MAX_CAUSAL_FANOUT = 1_000;

/** The unregistered token every installable Records pack ships as its lone
 *  compatibility-canary step. It exists to FAIL recipe lowering on a pre-D-221
 *  runtime, before `installBulkPack` mutates anything, so an older server
 *  refuses the pack instead of installing half of it. The install coordinator
 *  intercepts the canary; it is never executed and never persisted.
 *
 *  It lives here because four sites need to agree on it — the coordinator that
 *  intercepts it, the install handler that locates it, the pack-update review,
 *  and the corpus gate that must EXEMPT it (the coordinator's exact-shape
 *  classifier forbids the `tags` / `budget_ms` metadata that gate otherwise
 *  requires, so no valid canary could ever satisfy both). */
export const RECORDS_RUNTIME_CANARY_OP = 'core.records.require-runtime';

export const RECORDS_ACTIONS = [
  'create',
  'get',
  'get_many',
  'search',
  'count',
  // D-226 — a declared, closed-vocabulary rollup over the rows a filter admits.
  // Read-effect, like `count`: it returns an answer, never a row.
  'aggregate',
  'update',
  'upsert',
  'delete',
  // D-226 — N declared writes, ONE transaction, all or none. The only action
  // whose unit of work is more than one row.
  'batch',
  // ⛔⛔ THE ONE ACTION WHOSE ROWS ARRIVE AS TEXT. Every other write takes rows
  // the caller built in recipe step state; here the CSV crosses as one string
  // and the rows are planned, deduped and written inside the store — they never
  // enter step state. Writes `create` only, to the bound entity only; that is
  // why it needs no allow-list where `batch` does.
  //
  // ⛔⛔ THE SIZE ARGUMENT THIS COMMENT USED TO MAKE IS FALSE — corrected
  // 2026-09-18. It read: "a real 1000-row bank export carried through a dozen
  // `map` steps is an 11.9 MB step context against a 10 MB cap, so the recipe
  // could not import a real statement AT ALL." The enforced ceiling is
  // `MAX_CONTEXT_BYTES = 50MB` (`packages/engine/src/step-runner.ts`), raised
  // from 10MB on 2026-08-24 — so 11.9 MB passes with 4x to spare and the
  // "could not AT ALL" was never true after that raise. The claim survived
  // because `trackContextSize`'s thrown message still formatted a hardcoded
  // `(max 10MB)`, which this comment and three others quoted as evidence.
  // ⇒ The size lens is a SHAPE argument, not a limit one: a recipe retaining
  // the text plus the parsed rows plus derived copies is doing something the
  // `core.storage.csv.*` / `file-persist` / `file-put-ref` route exists to
  // replace, and headroom does not make that pattern correct.
  //
  // 🔑 WHAT ACTUALLY JUSTIFIES THE ACTION is the approval argument below —
  // one intent, one gate. That reason is independent of any cap and is the one
  // to cite.
  //
  // ⛔⛔ AND WHY IT IS AN ACTION RATHER THAN A KERNEL OP — the owner's reason,
  // recorded 2026-08-12 because it was nowhere in the tree. ONE USER INTENT
  // SHOULD NOT COST TWO APPROVALS. Getting the CSV in front of the recipe is
  // already an ask; a kernel op would raise its own gate immediately after, for
  // the same intent the owner just granted. The action route inherits the
  // binding, grants, risk floor, audit and principal check the read already
  // established (D-221, `76d461f77`) instead of re-asking.
  //
  // ⚠ So "promote `import` to `core.records.import` for consistency with the
  // other kernel ops" is the tempting change that must not be made: it reads as
  // tidying and lands as a second prompt. The commit body records the MECHANISM
  // ("inherits … what the kernel-op route would have had to rebuild"); this is
  // the reason the mechanism was chosen. ⚠ Recorded as stated intent — the
  // no-second-ask consequence follows from the action route reusing the read's
  // grant, not from anything asserted here about a specific risk tier.
  //
  // ⛔⛔ AND THE APPROVAL FRAME ABOVE AIMS AT THE WRONG HAZARD FOR A *REF* ARG
  // — which is why `csv_ref` looked unanswerable until it was measured. Today's
  // flow costs ONE prompt, not two: the pack's `import` op is `approval: 'ask'`
  // and `core.storage.data-file-read` is `risk_tier: 'read'` with no ask. So a
  // ref-taking variant cannot ADD a prompt; it can only REMOVE the
  // `core.storage.data-file-read` op-grant check (`grant-entry.ts`, keyed per
  // `operation_id`). Asking "will it re-gate?" returns a reassuring no while the
  // real risk is silent DE-gating.
  //
  // 🔑 THE BOUNDARY IS EGRESS, NOT DEREFERENCE. `cli-invocation-executor.ts`
  // states the invariant the cli lane was built to hold: "the op's ONLY readable
  // output is its own `output_capture` file_ref — whose read by a later ai-* /
  // data-file-read step IS P5-gated. An actor lacking `data-file-read` can run
  // docling on a ref but can never SEE the content through any stream." That is
  // why `xlsx2csv`'s `spreadsheet.to_csv` already takes a durable `file_ref` at
  // `approval: 'never'` — its sink is CONFINED (stdout/stderr suppressed, output
  // is another opaque ref), so no content reaches the actor.
  //
  // ⛔⛔ `import`'S SINK IS NOT CONFINED, and that is the whole ruling. Imported
  // rows are readable straight back through the pack's own `search` / `get`. So a
  // DURABLE csv_ref (a `data.file.received` record id) would be a new ungated
  // egress path for arbitrary file content, laundered through the records store —
  // exactly what `value-hint.ts` forbids: "Enforcement still belongs at the
  // file-read operation; this field is discovery UX, never an authority
  // boundary." A `{slug, path}` pair is worse still: ambient authority over any
  // enrolled instance, with no gated read anywhere in the picture.
  //
  // 🔑 SO `csv_ref` IS ADMITTED FOR ONE BACKING ONLY: a run-scoped `TempFileRef`
  // (D-185 §3.2). That ref "carries no separate Gateway `file.read` gate (the
  // producing op was already gated as its own write-tier step)" and its read is
  // confined to the producing run's scratch root by `assertPathUnderRunScratch`.
  // There is no second gate because there is no gate on that backing at all, and
  // no new reach: the only nameable files are outputs of ops THIS run already
  // dispatched under their own grants. Confinement is on the INPUT side rather
  // than the output side, which is what makes the unconfined sink survivable.
  //
  // ⚠ A DURABLE REF MUST KEEP THE THREE-STEP PATH — `data-file-read` →
  // `decode_base64` → `import`. It is one prompt, it is correct, and per the size
  // correction above it has ample headroom. Do not "finish the symmetry" by
  // admitting a CAS id here; the kernel csv ops take one because they ARE
  // `entity: 'file'` ops (`kernel-op-registry.ts`) whose grant is a file grant,
  // and a records-entity pack op taking a file address is not symmetry but the
  // mis-grouping that same file warns about: "a mis-grouped op is a permission an
  // owner revokes believing it covered something else."
  'import',
] as const;

export type RecordsAction = (typeof RECORDS_ACTIONS)[number];

export const RECORDS_PREDICATES = [
  'eq',
  'ne',
  'lt',
  'lte',
  'gt',
  'gte',
  'in',
  'prefix',
  'is_null',
] as const;

export type RecordsPredicate = (typeof RECORDS_PREDICATES)[number];

/** ⛔ WRITES ONLY, and `batch` is not among them.
 *
 *  No reads: a read inside a write transaction is the first half of a
 *  read-modify-write loop, and CAS exists precisely so that loop cannot be
 *  written. Read before the batch, pass the revisions in, let the batch refuse
 *  on a stale one — which is the same discipline every single-row write already
 *  follows, and the reason a batch needs no new conflict story.
 *
 *  No nesting: a batch inside a batch has no meaning the outer transaction does
 *  not already provide, and it would make the declared allow-list unbounded. */
export const RECORDS_BATCH_ACTIONS = ['create', 'update', 'upsert', 'delete'] as const;

export type RecordsBatchAction = (typeof RECORDS_BATCH_ACTIONS)[number];

/** One entity/action pair a batch op is DECLARED to be allowed to contain.
 *  The caller supplies the rows; it can never supply the pairs. */
export interface RecordsBatchAllow {
  entity: string;
  action: RecordsBatchAction;
}

export const isRecordsBatchAction = (value: unknown): value is RecordsBatchAction =>
  typeof value === 'string' && (RECORDS_BATCH_ACTIONS as readonly string[]).includes(value);

/** Static validation of a batch's allow-list against the entities that exist.
 *  Returns every problem rather than the first. Empty array = admissible. */
export const validateRecordsBatchAllow = (
  allow: unknown,
  entityNames: readonly string[],
): string[] => {
  if (!Array.isArray(allow) || allow.length === 0) {
    return ['allow must be a non-empty array of { entity, action }'];
  }
  const problems: string[] = [];
  const seen = new Set<string>();
  allow.forEach((raw, index) => {
    const at = `allow[${index}]`;
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      problems.push(`${at}: must be an object { entity, action }`);
      return;
    }
    const entry = raw as Record<string, unknown>;
    for (const key of Object.keys(entry)) {
      if (!['entity', 'action'].includes(key)) problems.push(`${at}: unknown key '${key}'`);
    }
    if (typeof entry.entity !== 'string' || !entityNames.includes(entry.entity)) {
      problems.push(`${at}: unknown entity '${String(entry.entity)}'`);
    }
    if (!isRecordsBatchAction(entry.action)) {
      problems.push(
        `${at}: '${String(entry.action)}' is not a batchable action` +
        ` — a batch admits ${RECORDS_BATCH_ACTIONS.join(', ')} and no reads`,
      );
    }
    const key = `${String(entry.entity)}:${String(entry.action)}`;
    if (seen.has(key)) problems.push(`${at}: duplicate pair '${key}'`);
    seen.add(key);
  });
  return problems;
};

/** ⛔⛔ THE BYTE CEILING FOR A `csv_ref` IMPORT — AND IT EXISTS BECAUSE THE REF
 *  PATH HAS NO OTHER ONE. Text passed as `csv` is bounded on the way in by the
 *  engine's `MAX_CONTEXT_BYTES` (50 MB), because it transits step state. A ref's
 *  bytes never enter step state, so nothing upstream bounds them and the
 *  dereference site is the last place able to refuse before a file is decoded
 *  into memory.
 *
 *  32 MiB, matching `CSV_FILTER_MAX_BYTES` — the same number the one other op
 *  that reads a stored CSV outside step state already chose, for the same
 *  reason. Deliberately NOT the 50 MB context cap: that is a limit on a
 *  DIFFERENT resource (retained step values), and reusing it here would make a
 *  future change to either one silently move the other. */
export const RECORDS_IMPORT_MAX_CSV_BYTES = 32 * 1024 * 1024;

/** How many per-row diagnostics an `import` returns alongside its counts.
 *
 *  ⛔ A CAP, NOT A PREFERENCE. The entire reason `import` exists is that rows
 *  must not transit recipe step state; an uncapped failure list on a file where
 *  every row is bad puts all of them straight back into it, and the 10 MB
 *  ceiling that motivated the action reappears in its RESULT. The COUNTS are
 *  always exact — only the examples are trimmed. */
export const RECORDS_IMPORT_SAMPLE_LIMIT = 20;

/** A cell that arrived non-empty and did not parse. ⚠ The row STILL LANDED with
 *  the field null — this is a signal for the owner, never a verdict on the row.
 *  `line` is 1-based including the header, so it is the line an owner opening
 *  the file in a spreadsheet actually sees. */
export interface RecordsImportUnparsedCell {
  line: number;
  column: string;
  value: string;
}

/** One row the STORE refused, with its own error code so the owner can tell a
 *  fact about their data (`records_conflict` — you edited this row since the
 *  last import) from a fact about the namespace (`records_quota_exceeded`). */
export interface RecordsImportFailure {
  line: number;
  /** ⚠ EMPTY on a natural-key entity, and deliberately so: the store derives the id from
   *  the key's own fields and a refused row never got one. Reporting the planner's
   *  internal handle here would name a row that does not exist under that id. `line` is
   *  the handle that always works — it is where the owner opens the file. */
  id: string;
  code: RecordsErrorCode;
  reason: string;
}

/** What an import does with a row whose identity already exists but whose
 *  VALUES differ. A byte-identical row is never this question — it is
 *  `replayed`, in every mode.
 *
 *  ⛔ A CLOSED VOCABULARY WITH A WRITE-TIME DOOR, not a safe default: an
 *  unrecognised value is REFUSED by `validateCsvImportSpec` rather than quietly
 *  read as `'fail'`. A typo'd `'overwrite '` that fell back to the default would
 *  leave an owner believing they had replaced rows they had not touched.
 *
 *  `'fail'` is the default because it is what the action did before this existed,
 *  and because it is the only mode that cannot lose data without saying so. */
export const RECORDS_IMPORT_CONFLICT_MODES = ['fail', 'skip', 'overwrite'] as const;
export type RecordsImportConflictMode = typeof RECORDS_IMPORT_CONFLICT_MODES[number];

/** ⛔⛔ THE SHAPE IS THE POINT — never a bare boolean, never `written` alone.
 *
 *  A `foreach` write reports SUCCESS when every single item was rejected: 1000
 *  rows refused, `success: true`, nothing on screen. That is the defect this
 *  action was built to remove, and a result carrying only a count would
 *  reintroduce it one layer up. Here the only way to learn what landed is to
 *  also receive what did not.
 *
 *  🔑 THE ARITHMETIC IS AN INVARIANT, and it is stated rather than implied:
 *      rows_read === written + replayed + updated + skipped + failed + not_attempted
 *  A caller can therefore prove it was told about every row, which is the one
 *  thing a partial import must never be able to hide.
 *
 *  ⚠ `updated` and `skipped` JOINED THE INVARIANT with `on_conflict`. They are
 *  mode-exclusive — `'overwrite'` can only produce `updated`, `'skip'` only
 *  `skipped`, `'fail'` (the default) neither — so on any given import at most
 *  one of them is non-zero. They are separate counters rather than folded into
 *  `written` because they are different facts about the owner's data: `written`
 *  means a row that was not there, `updated` means one that was and no longer
 *  says what it said. An owner who overwrote 200 rows by accident needs to read
 *  that number, not have it hidden inside a total. */
export interface RecordsImportResult {
  /** Data lines the file yielded — the denominator for everything else. */
  rows_read: number;
  /** Rows newly seated. */
  written: number;
  /** Rows already present, byte-identical: a re-import no-op, NOT a failure.
   *  Bank exports overlap by design (the last 90 days, every time), so this is
   *  the normal second-run outcome and the number an owner reads as
   *  "already had". */
  replayed: number;
  /** Rows that already existed with DIFFERENT values and were overwritten from
   *  the file. Only ever non-zero under `on_conflict: 'overwrite'`. */
  updated: number;
  /** Rows that already existed with DIFFERENT values and were left exactly as
   *  they were. Only ever non-zero under `on_conflict: 'skip'`.
   *  ⚠ NOT a failure and NOT a `replayed`: the file disagreed with the store and
   *  the store won. An owner reads this as "rows I already had, kept as mine". */
  skipped: number;
  failed: number;
  /** Rows never attempted because the import halted — see `halted_reason`. */
  not_attempted: number;
  /** Cells that arrived non-empty and did not parse. ⚠ NOT a row count and NOT
   *  a partial-import signal: every one of those rows is in `written` or
   *  `replayed`, with the field null rather than a fabricated zero. */
  unparsed: number;
  failures_sample: RecordsImportFailure[];
  unparsed_sample: RecordsImportUnparsedCell[];
  /** Set when the import stopped early because a refusal was a fact about the
   *  NAMESPACE (quota, fence, coherence) rather than about one row — retrying
   *  the remaining rows could only reproduce it, and reporting 195,000 identical
   *  failures would bury the one thing that actually happened. */
  halted_reason?: string;
  /** ⛔⛔ PRESENT ⇒ NOTHING WAS WRITTEN, and every count above is what WOULD
   *  have happened. The rows were planned and put through the real write path —
   *  same validation, same conflict checks, same quota accounting — inside a
   *  transaction that is then rolled back, so the numbers are measured rather
   *  than predicted.
   *
   *  🔑 IT EXISTS FOR THE ONE FAILURE NEITHER THE RESULT SHAPE NOR ATOMICITY
   *  CATCHES: a mapping that is VALID but points at the wrong column. That
   *  imports a thousand successful, wrong rows — `failed: 0`, nothing to
   *  re-run, and the cleanup is manual because the ids were derived from the
   *  wrong values. Seeing the first rows before committing is the only thing
   *  that stops it.
   *
   *  ⚠ A reader must never take `written` from a dry run as rows that exist.
   *  Anything rendering this result has to say "would" when this is set. */
  dry_run?: true;
  /** SHA-256 of the exact bytes imported — present ONLY when the rows came from
   *  a `csv_ref`, absent for `csv` text.
   *
   *  🔑 IT EXISTS BECAUSE THE AUDIT ROW CANNOT NAME THE CONTENT ON THE REF PATH.
   *  The gateway hashes `effectiveArgs` BEFORE dispatch, so a `csv` call commits
   *  the text itself to the arg hash while a `csv_ref` call commits only
   *  `{backing, path, mime_type, filename}` — and that `path` is a run-scoped
   *  scratch location reclaimed at run end, so it names nothing afterwards.
   *  Without this field the provenance question "which bytes produced these
   *  rows" has no answer once the run is over.
   *
   *  ⚠ Set on a dry run too, and correctly so: the rehearsal read the same
   *  bytes, and a caller comparing a dry run against the real one needs to know
   *  they were the same file. */
  source_sha256?: string;
}

export const RECORDS_SLOT_FAMILIES = {
  number: Array.from({ length: 10 }, (_, idx) => `n${idx + 1}`),
  decimal: Array.from({ length: 5 }, (_, idx) => `dec${idx + 1}`),
  string: Array.from({ length: 10 }, (_, idx) => `s${idx + 1}`),
  text: Array.from({ length: 2 }, (_, idx) => `t${idx + 1}`),
  date: Array.from({ length: 3 }, (_, idx) => `d${idx + 1}`),
  datetime: Array.from({ length: 3 }, (_, idx) => `dt${idx + 1}`),
  boolean: Array.from({ length: 5 }, (_, idx) => `b${idx + 1}`),
  ref: Array.from({ length: 5 }, (_, idx) => `r${idx + 1}`),
} as const;

export type RecordsFieldKind = keyof typeof RECORDS_SLOT_FAMILIES;
export type RecordsSlot =
  | `n${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10}`
  | `dec${1 | 2 | 3 | 4 | 5}`
  | `s${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10}`
  | `t${1 | 2}`
  | `d${1 | 2 | 3}`
  | `dt${1 | 2 | 3}`
  | `b${1 | 2 | 3 | 4 | 5}`
  | `r${1 | 2 | 3 | 4 | 5}`;

export interface RecordsPackRef {
  publisher: string;
  pack_slug: string;
}

/** D-221 §3.3.2 principal derivation for Records. Contract authority wins;
 * otherwise only the local owner and the three host-owned automation channels
 * inherit owner authority. In particular, an anonymous reception/webhook run
 * with no contract remains unauthorised rather than becoming `user_self`. */
export const recordsPrincipalFromExecutionSource = (source: {
  channel?: string;
  actor?: string;
  contract_id?: string;
}): string | null => {
  if (typeof source.contract_id === 'string' && source.contract_id.length > 0) {
    return source.contract_id;
  }
  if (source.actor === 'user_self') return 'user_self';
  if (source.actor === 'system'
    && ['schedule', 'reactive', 'housekeeping'].includes(source.channel ?? '')) {
    return 'user_self';
  }
  return null;
};

import type { RecordsRootProjection } from './records-root-projection.js';

export interface RecordsFieldSnapshot {
  /** Friendly dotted leaf exposed to recipes and #data. */
  key: string;
  slot: 'pk' | RecordsSlot;
  kind: 'id' | RecordsFieldKind;
  required: boolean;
  /** Authored display name. Absent → a surface title-cases `key`. ⚠ Outside
   *  `canonicalStorageProjection` by design, exactly like `roots`: a display
   *  declaration moves `declaration_hash` and leaves `storage_schema_hash`
   *  alone, so adding one is a re-declaration and never a migration. */
  label?: string;
  /** For a `ref` slot: the entity kind this reference targets. Absent on a
   *  non-ref field, and on a ref that predates the declaration. */
  references?: string;
  description?: string;
  privacy?: EntityFieldPrivacy;
  source_operation?: string;
}

export interface RecordsEntitySnapshot {
  kind: string;
  fields: RecordsFieldSnapshot[];
  /** D-226 — declared reverse reads. ⚠ Deliberately OUTSIDE
   *  `canonicalStorageProjection`, which picks only `{key, slot, kind,
   *  required}` per field: a projection is a READ declaration, so adding one
   *  moves `declaration_hash` and leaves `storage_schema_hash` alone — no
   *  migration, which is the whole reason it can live on the snapshot. */
  roots?: RecordsRootProjection[];
}

export interface RecordsSchemaSnapshot {
  decimal_scale: number;
  entities: Record<string, RecordsEntitySnapshot>;
}

/** Closed Records bind expressed through the existing opaque authoring cell. */
export interface RecordsAuthorBinding {
  kind: 'core.records';
  action: RecordsAction;
  entity: string;
  natural_key?: string[];
  filter_fields?: string[];
  sort_fields?: string[];
  /** D-226 — `aggregate` only. The rollup is DECLARED here, not passed by the
   *  caller: that is what makes it validated at install against the entity's
   *  field kinds, documented in the op catalog, and usable as an index hint.
   *  The caller chooses the OCCASION and the filters, never the shape. */
  select?: Readonly<Record<string, { fn: string; field?: string; by?: string }>>;
  /** D-226 — `aggregate` only, OPTIONAL. Present, the op returns one row PER
   *  DISTINCT VALUE of this field instead of one row overall: a declared list.
   *  It lives on the bind for the same reason `select` does — it changes what
   *  the op returns, so it is validated at install, hashed into the digest, and
   *  never supplied by the caller. Admissible key kinds are narrower than
   *  aggregatable ones (`RECORDS_GROUP_BY_KINDS`). */
  group_by?: string;
  /** D-226 — `batch` only. The entity/action pairs this op may contain. It is
   *  on the bind for the same reason `select` is: it decides what the op can
   *  DO, so it is validated at install, hashed into the digest, and never
   *  supplied by the caller. */
  allow?: readonly RecordsBatchAllow[];
}

/** Closed author bind after install-time validation and owner stamping. */
export interface RecordsExecutionBinding extends RecordsAuthorBinding {
  /** Verified installer-owned fields. Never read from the authored bind. */
  owner: RecordsPackRef;
  pack_version: number;
  storage_schema_hash: string;
  declaration_hash: string;
  operation_digest: string;
}

/** Local execution surface carried only by an installed catalog manifest. */
export interface ProviderRecordsSurface {
  /** Preview/decomposition artifacts may still be unstamped. Runtime rejects
   * anything that does not satisfy `isRecordsExecutionBinding`. */
  executes: Record<string, RecordsAuthorBinding | RecordsExecutionBinding>;
  schema: RecordsSchemaSnapshot;
}

export type RecordsNamespaceState =
  | {
      state: 'ready';
      version: number;
      storage_schema_hash: string;
      declaration_hash: string;
    }
  | {
      state: 'migrating';
      from_version: number;
      target_version: number;
      target_storage_schema_hash: string;
      migration_id: string;
    }
  | {
      state: 'orphaned';
      last_version: number;
      storage_schema_hash: string;
      declaration_hash: string;
    }
  | {
      state: 'incoherent';
      last_known_state: string;
      detected_at: number;
      reason: string;
      evidence_ref?: string;
    };

export interface RecordsRecordMetadata {
  entity: string;
  version: number;
  revision: number;
  created_at: number;
  updated_at: number;
}

export type RecordsFriendlyRecord = Record<string, unknown> & {
  id: string;
  _record: RecordsRecordMetadata;
};

export interface RecordsFilter {
  field: string;
  op: RecordsPredicate;
  value?: unknown;
}

export interface RecordsSearchResult {
  records: RecordsFriendlyRecord[];
  next_cursor?: string;
  prev_cursor?: string;
}

export type RecordsMutationCause =
  | 'recipe'
  | 'owner_delete'
  | 'migration'
  | 'retention'
  | 'uninstall_purge'
  | 'owner_bulk_delete';

export interface RecordsEventPointer {
  event_id: string;
  type: 'record.created' | 'record.updated' | 'record.deleted';
  owner: RecordsPackRef;
  entity: string;
  id: string;
  revision: number;
  changed_fields: string[];
  activation_generation: number;
  subscriber_digest: string;
  cause: RecordsMutationCause;
  created_at: number;
}

export interface RecordsExecutionCall {
  binding: RecordsExecutionBinding;
  args: Record<string, unknown>;
  principal: string;
  recipe_digest?: string;
  /** Host-minted run lease. The Records store validates this against its
   * process-local namespace admission registry when an update/uninstall fence
   * is active; recipe/config/context data can never mint a useful value. */
  execution_lease_id?: string;
  cause?: RecordsMutationCause;
  root_event_id?: string;
  causal_depth?: number;
  watcher_digest?: string;
}

export interface RecordsQuotaSnapshot {
  row_count: number;
  payload_bytes: number;
  row_limit: number;
  byte_limit: number;
  outbox_count: number;
  outbox_limit: number;
  data_generation: number;
}

/** Exact core-wide usage/caps, derived from the same row/outbox tables. */
export interface RecordsGlobalQuotaSnapshot {
  row_count: number;
  payload_bytes: number;
  outbox_count: number;
  reserved_payload_bytes: number;
  row_limit: number;
  byte_limit: number;
  outbox_limit: number;
}

/** Owner-control-plane projection for one full-ref Records namespace. */
export interface RecordsNamespaceView {
  owner: RecordsPackRef;
  state: RecordsNamespaceState;
  activation_generation: number;
  state_generation: number;
  quota: RecordsQuotaSnapshot;
  schema: RecordsSchemaSnapshot;
  artifact_digest: string;
  /** Exact installed watcher binding-set stamp; pointer delivery refuses drift. */
  subscriber_digest: string;
  updated_at: number;
}

export interface RecordsKindSummary {
  kind: string;
  rows: number;
  payload_bytes: number;
}

export interface RecordsRetentionPolicy {
  mode: 'keep' | 'expire_after_days';
  days?: number;
  legal_hold?: boolean;
}

/** One friendly schema delta rendered before a Records pack update. */
export interface RecordsSchemaReviewChange {
  entity: string;
  field?: string;
  change:
    | 'entity_added'
    | 'entity_removed'
    | 'field_added'
    | 'field_removed'
    | 'slot_changed'
    | 'type_changed'
    | 'nullability_changed'
    | 'privacy_changed';
  current?: string;
  target?: string;
  destructive: boolean;
}

/** A literal migration mapping that can discard or relocate owner data. */
export interface RecordsDestructiveReviewItem {
  edge: string;
  kind: string;
  step_id: string;
  operation: 'clear' | 'change_kind' | 'safe_cast' | 'move';
  from: string;
  to?: string;
}

/** D-221 owner-facing Records section on the existing pack-update review. */
export interface RecordsPackUpdateReview {
  owner: RecordsPackRef;
  current_state: RecordsNamespaceState['state'];
  current_version: number;
  target_version: number;
  current_storage_schema_hash: string;
  target_storage_schema_hash: string;
  row_counts: RecordsKindSummary[];
  estimated_rows: number;
  schema_changes: RecordsSchemaReviewChange[];
  destructive_changes: RecordsDestructiveReviewItem[];
  quota: RecordsQuotaSnapshot;
  global_quota: RecordsGlobalQuotaSnapshot;
  retention: Record<string, RecordsRetentionPolicy>;
  export_checkpoint_available: boolean;
  export_recommended: boolean;
  active_executions: number;
  unacknowledged_events: number;
  pending_event_disposition: 'drain_or_explicit_retire';
  temporary_unavailability: boolean;
  resumable: boolean;
  reverse_route_exists: boolean;
}

/** Server-private approval binding echoed through the install coordinator.
 * The client receives only its enclosing SHA-256 review token. */
export interface RecordsUpdateReviewFence {
  owner: RecordsPackRef;
  current_snapshot_digest: string;
  owner_policy_digest: string;
  target_version: number;
  target_artifact_digest: string;
  route_plan_digest: string;
  pending_event_disposition: 'drain_or_explicit_retire';
}

/** Generation-pinned owner export. The digest covers every preceding field. */
export interface RecordsExportEnvelope {
  format: 'recued.records.v1';
  owner: RecordsPackRef;
  version: number;
  activation_generation: number;
  data_generation: number;
  storage_schema_hash: string;
  declaration_hash: string;
  schema: RecordsSchemaSnapshot;
  records: Record<string, RecordsFriendlyRecord[]>;
  exported_at: number;
  digest: string;
}

/** CSV is generated by the owner control plane from the same point-in-time
 * snapshot as JSON. The CSV repeats the pack/schema metadata on every row so
 * the artifact remains self-describing when opened outside Recued. */
export interface RecordsCsvExportEnvelope {
  format: 'recued.records.csv.v1';
  owner: RecordsPackRef;
  version: number;
  activation_generation: number;
  data_generation: number;
  storage_schema_hash: string;
  declaration_hash: string;
  schema: RecordsSchemaSnapshot;
  csv: string;
  exported_at: number;
  digest: string;
}

export type RecordsExportResponse = RecordsExportEnvelope | RecordsCsvExportEnvelope;

/** One same-namespace relationship edge used for reference navigation and
 * delete-impact review. Values remain friendly kind/id paths; physical refs
 * never escape the advanced diagnostic disclosure. */
export interface RecordsRelationshipImpact {
  source_entity: string;
  source_id: string;
  source_field: string;
  source_slot: RecordsSlot;
  target_entity: string;
  target_id: string;
}

export interface RecordsOwnerRecordDiagnostics {
  raw_slots: Record<RecordsSlot, string | number | null>;
  outgoing: RecordsRelationshipImpact[];
  incoming: RecordsRelationshipImpact[];
}

export interface RecordsOwnerGetResponse {
  record: RecordsFriendlyRecord | null;
  diagnostics: RecordsOwnerRecordDiagnostics | null;
}

export type RecordsOutboxStatus = 'pending' | 'delivered' | 'dead_letter';

export interface RecordsOutboxDeliveryDiagnostic {
  binding_digest: string;
  recipe_id: string;
  status: RecordsOutboxStatus;
  retry_count: number;
  error?: string;
}

export interface RecordsOutboxEventDiagnostic {
  event: RecordsEventPointer;
  status: RecordsOutboxStatus;
  retry_count: number;
  error?: string;
  deliveries: RecordsOutboxDeliveryDiagnostic[];
}

export interface RecordsOutboxOverview {
  pending: number;
  delivered: number;
  dead_letter: number;
  total_retries: number;
  oldest_pending_at?: number;
  oldest_pending_age_ms?: number;
  events: RecordsOutboxEventDiagnostic[];
}

export interface RecordsOutboxListRequest {
  owner: RecordsPackRef;
  status?: RecordsOutboxStatus;
  limit?: number;
}

export interface RecordsOutboxRetireRequest {
  owner: RecordsPackRef;
  event_id: string;
  /** Exact event id; prevents a stale or accidental bulk-looking click. */
  confirmation: string;
}

export interface RecordsPurgeRequest {
  owner: RecordsPackRef;
  /** Exact `publisher/pack_slug`; purge is admitted only after orphaning. */
  confirmation: string;
}

export interface RecordsOwnerSearchRequest {
  owner: RecordsPackRef;
  entity: string;
  filters?: Record<string, unknown>;
  sort?: string;
  cursor?: string;
  limit?: number;
  include_orphaned?: boolean;
}

export interface RecordsOwnerGetRequest {
  owner: RecordsPackRef;
  entity: string;
  id: string;
}

export interface RecordsOwnerDeleteRequest extends RecordsOwnerGetRequest {
  expected_version: number;
  expected_revision: number;
}

export interface RecordsQuotaSetRequest {
  owner: RecordsPackRef;
  row_limit?: number;
  byte_limit?: number;
  outbox_limit?: number;
}

/** Owner-only policy update for the core-wide Records capacity envelope. */
export interface RecordsGlobalQuotaSetRequest {
  row_limit?: number;
  byte_limit?: number;
  outbox_limit?: number;
}

export interface RecordsRetentionSetRequest {
  owner: RecordsPackRef;
  entity: string;
  policy: RecordsRetentionPolicy;
}

export interface RecordsRetentionRunRequest {
  owner: RecordsPackRef;
  batch_size?: number;
}

export interface RecordsExportRequest {
  owner: RecordsPackRef;
  entity?: string;
  format?: 'json' | 'csv';
}

export type RecordsErrorCode =
  | 'records_invalid'
  | 'records_not_found'
  | 'records_conflict'
  | 'records_noop'
  | 'records_not_ready'
  | 'records_stale_operation'
  | 'records_incoherent'
  | 'records_quota_exceeded'
  | 'records_backpressure'
  | 'records_relationship_restrict'
  | 'records_query_budget'
  | 'records_cursor_invalid'
  | 'records_unauthorized';

export class RecordsContractError extends Error {
  readonly code: RecordsErrorCode;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;

  constructor(
    code: RecordsErrorCode,
    message: string,
    options: { retryable?: boolean; details?: Record<string, unknown> } = {},
  ) {
    super(message);
    this.name = 'RecordsContractError';
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }
}

export const isRecordsAction = (value: unknown): value is RecordsAction =>
  typeof value === 'string' && (RECORDS_ACTIONS as readonly string[]).includes(value);

export const isRecordsExecutionBinding = (
  value: RecordsAuthorBinding | RecordsExecutionBinding | undefined,
): value is RecordsExecutionBinding =>
  value !== undefined
  && typeof (value as RecordsExecutionBinding).owner?.publisher === 'string'
  && typeof (value as RecordsExecutionBinding).owner?.pack_slug === 'string'
  && Number.isSafeInteger((value as RecordsExecutionBinding).pack_version)
  && (value as RecordsExecutionBinding).pack_version > 0
  && typeof (value as RecordsExecutionBinding).storage_schema_hash === 'string'
  && typeof (value as RecordsExecutionBinding).declaration_hash === 'string'
  && typeof (value as RecordsExecutionBinding).operation_digest === 'string';

export const recordsSlotKind = (slot: string): RecordsFieldKind | undefined => {
  for (const [kind, slots] of Object.entries(RECORDS_SLOT_FAMILIES)) {
    if ((slots as readonly string[]).includes(slot)) return kind as RecordsFieldKind;
  }
  return undefined;
};
