/** D-192 read resolution (spec § "P3b - read resolution") — the PURE
 *  decision core over "when can a read trust the local projection and
 *  when must it reach the vendor".
 *
 *  Three decisions, no IO:
 *
 *  1. **Freshness** — `classifyWorkEntitySourceFreshness`: one Source's
 *     `work_entity_source_sync_state` row → a
 *     `WorkEntitySourceFreshness` verdict. POLL is the baseline (owner
 *     refinement 2026-07-01): webhook-fresh is the exception, so
 *     freshness is explicit per Source (`last_success_at` vs the
 *     declared `stale_after_ms`) and a `degraded` Source is stale
 *     regardless of its last success. The verdict rides read-result
 *     metadata VERBATIM (the D-190 `truncated`/`pages_fetched` honesty
 *     precedent — substrate support so a weaker model never answers
 *     confidently from stale rows).
 *
 *  2. **Read plan** — `resolveWorkEntityReadPlan`: requested fidelity ×
 *     the declaration's `read_resolution` × freshness → local vs
 *     remote. Deterministic per the spec: `write_preflight` is ALWAYS
 *     remote for an external Source; `current_remote` ("latest",
 *     "right now") ALWAYS escalates — a warm mirror can be a full poll
 *     cycle stale; `remote_detail` escalates per the declared
 *     `remote_when` reasons; `rich_meta` stays local with freshness
 *     surfaced, never silently escalated (a recipe read must not change
 *     behavior with wall-clock). A Source without a declared `read` op
 *     cannot escalate — the plan stays local and says so
 *     (`no_remote_read_op`), never pretends.
 *
 *  3. **Wild-query plan** — `planWorkEntityWildQueryReads`: LLM/open
 *     queries use local rich meta as the discovery layer and escalate
 *     to TARGETED remote reads only where needed, bounded by the
 *     declared `wild_query` caps (`max_sources` /
 *     `max_remote_records`); over a cap the plan is `ask_to_narrow`
 *     (with the local-answer limitations attached so a caller may
 *     degrade honestly instead). Never unbounded remote fanout.
 *
 *  Plus the fidelity-honoring accessor `workEntityLongText`: preview
 *  text lives in `source_extension_blob.preview.<field>` under a
 *  `detail_fidelity` marker and canonical long-body columns are never
 *  populated by sync — every surface that wants "the body" goes
 *  through here so a bounded preview is never mistaken for complete
 *  content.
 *
 *  The remote-read EXECUTION (a single-record fetch through the
 *  declared `read` op) is deliberately NOT here — it lands with P4,
 *  which owns the same primitive for read-before-write and the declared
 *  id-arg mapping it needs. This module decides; executors act. */

import type {
  SourceRegistration,
  WorkEntity,
  WorkEntityRemoteWhenReason,
  WorkEntitySourceFreshness,
  WorkEntitySourceReadResolution,
} from '@recued/contracts';

import type { WorkEntitySourceSyncState } from './storage/work-entity-source-mirror.js';

// ────────────────────────────────────────────────────────────────
// 1 — freshness
// ────────────────────────────────────────────────────────────────

/** Classify one Source's read-time freshness from its sync-state row.
 *
 *  - non-`connection` Source (Recued built-in) → `local` (the rows ARE
 *    the source of truth — no staleness axis);
 *  - `degraded` row → `degraded` (the last cycle failed a row or the
 *    fetch itself; stale regardless of `last_success_at`);
 *  - no row / no successful cycle → `never_synced` (just enrolled, a
 *    stable config failure, or a registry row predating the sync
 *    substrate — all fail-honest);
 *  - last success older than `stale_after_ms` → `stale`;
 *  - otherwise `fresh`. */
export const classifyWorkEntitySourceFreshness = (
  source: Pick<SourceRegistration, 'id' | 'source_kind' | 'sync_posture'>,
  sync: WorkEntitySourceSyncState | null,
  now: number,
): WorkEntitySourceFreshness => {
  if (source.source_kind !== 'connection') {
    return { source_id: source.id, state: 'local' };
  }
  if (source.sync_posture === 'read_through') {
    return { source_id: source.id, state: 'read_through' };
  }
  if (sync === null) {
    return { source_id: source.id, state: 'never_synced', last_success_at: null };
  }
  const detail: Omit<WorkEntitySourceFreshness, 'state'> = {
    source_id: source.id,
    last_success_at: sync.last_success_at,
    stale_after_ms: sync.stale_after_ms,
    // D-192 CORE #8f — completeness honesty, orthogonal to `state`: a fresh
    // mirror can still be a partial list (a Source list op with no pagination,
    // or a truncated walk). Surfaced ONLY when partial — the notable case,
    // mirroring the conditional `last_error_code` below; an absent flag reads
    // as complete (the common case, which keeps read-result metadata quiet).
    ...(sync.list_complete === false ? { list_complete: false } : {}),
    ...(sync.last_error_code !== null ? { last_error_code: sync.last_error_code } : {}),
  };
  if (sync.degraded) return { ...detail, state: 'degraded' };
  if (sync.last_success_at === null) return { ...detail, state: 'never_synced' };
  if (now - sync.last_success_at > sync.stale_after_ms) return { ...detail, state: 'stale' };
  return { ...detail, state: 'fresh' };
};

/** True when the verdict means the mirror may trail the vendor —
 *  everything except `fresh` and `local`. */
export const isWorkEntitySourceStale = (
  freshness: Pick<WorkEntitySourceFreshness, 'state'>,
): boolean =>
  freshness.state === 'stale'
  || freshness.state === 'degraded'
  || freshness.state === 'never_synced';

/** The ids of every registered Source that materializes NO canonical rows.
 *
 *  A `read_through` declaration is a hard no-materialization boundary: it
 *  schedules no poller and persists no `data_<kind>` row, so ANY local row
 *  carrying its id is residue from an interrupted posture migration (the boot
 *  migration purges it — `work-entity-source-boot`). Every surface that reads
 *  the local store directly must subtract this set, or an interrupted
 *  migration serves rows the declaration says do not exist. `work.search`
 *  established the posture; the recipe-callable ops and the CRUD rpc share it
 *  through this helper so a fourth reader cannot silently diverge. */
export const readThroughSourceIds = (
  sources: readonly Pick<SourceRegistration, 'id' | 'sync_posture'>[],
): ReadonlySet<string> =>
  new Set(
    sources
      .filter((source) => source.sync_posture === 'read_through')
      .map((source) => source.id),
  );

// ────────────────────────────────────────────────────────────────
// 2 — per-read plan
// ────────────────────────────────────────────────────────────────

/** The spec's four read-fidelity classes (§ Read resolution policy). */
export type WorkEntityReadFidelity =
  | 'rich_meta'
  | 'remote_detail'
  | 'current_remote'
  | 'write_preflight';

/** Why a local plan is less than the caller asked for — surfaced, never
 *  hidden (spec: "return a local-rich-meta answer with explicit
 *  freshness/detail limitations"). */
export type WorkEntityReadLimitation =
  /** The Source has no declared `read` op — remote detail is
   *  structurally unavailable on this Source. */
  | 'no_remote_read_op'
  /** The answer may include bounded preview text where complete detail
   *  was requested. */
  | 'preview_only'
  /** The Source's mirror is stale / degraded / never synced. */
  | 'source_stale'
  /** Currentness was requested but the answer is served from the
   *  mirror — it may trail the vendor even when the mirror is within
   *  its staleness horizon. */
  | 'not_current';

export type WorkEntityReadPlan =
  | {
      action: 'local';
      /** False when the Source may trail the vendor. */
      fresh: boolean;
      limitations: WorkEntityReadLimitation[];
    }
  | {
      action: 'remote';
      /** The declared escalation reasons that fired. */
      reasons: WorkEntityRemoteWhenReason[];
    };

export interface ResolveWorkEntityReadPlanInput {
  fidelity: WorkEntityReadFidelity;
  freshness: WorkEntitySourceFreshness;
  /** The Source declaration's `read_resolution` — null for Sources
   *  without a declaration (built-in / pre-declaration registrations). */
  policy: WorkEntitySourceReadResolution | null;
  /** Whether the declaration binds a `read` op (`ops.read`) — without
   *  one there is nothing to escalate TO. */
  has_read_op: boolean;
}

/** The detail-class reasons `remote_detail` consults on the declared
 *  `remote_when` list. `field_missing` is included: a caller asking for
 *  remote detail is asking for fields beyond the projection. */
const REMOTE_DETAIL_REASONS: readonly WorkEntityRemoteWhenReason[] = [
  'complete_body_required',
  'comments_required',
  'attachments_required',
  'field_missing',
];

/** Decide local vs remote for ONE read against ONE Source. Pure and
 *  deterministic — same inputs, same plan. */
export const resolveWorkEntityReadPlan = (
  input: ResolveWorkEntityReadPlanInput,
): WorkEntityReadPlan => {
  const { fidelity, freshness, policy } = input;
  const stale = isWorkEntitySourceStale(freshness);

  // A local Source is authoritative for every fidelity — there is no
  // "more current" copy anywhere else (write preflight against the
  // local store IS the local read).
  if (freshness.state === 'local') {
    return { action: 'local', fresh: true, limitations: [] };
  }
  // A read-through Source has no local record to choose. Every fidelity class
  // reaches the declared source; `source_freshness` carries the more precise
  // materialization reason while the existing plan vocabulary records that a
  // current remote value is required.
  if (freshness.state === 'read_through') {
    return { action: 'remote', reasons: ['current_remote_required'] };
  }

  const localWith = (limitations: WorkEntityReadLimitation[]): WorkEntityReadPlan => ({
    action: 'local',
    fresh: !stale,
    limitations: stale ? [...limitations, 'source_stale'] : limitations,
  });

  // Escalation needs a declared read op to escalate TO. Without one the
  // plan is honest local — the limitation names the structural gap.
  const canEscalate = input.has_read_op;

  switch (fidelity) {
    case 'write_preflight':
      // Mandatory remote read-before-write for an external Source —
      // spec § Write policy, unconditional (not gated on `remote_when`).
      // The old `read_before_write: true` declaration flag was RETIRED
      // (2026-07-14): it had no runtime consumer and the validator could
      // only ever force it to `true`, so the guarantee lives HERE, in the
      // engine, rather than in a boolean a pack could have lied about.
      // P4 owns what happens when the Source cannot serve it.
      return { action: 'remote', reasons: ['write_preflight'] };

    case 'current_remote': {
      // "current"/"latest" ALWAYS escalates (owner refinement — a warm
      // mirror can be a full poll cycle stale), independent of the
      // declared `remote_when`.
      if (!canEscalate) return localWith(['no_remote_read_op', 'not_current']);
      const reasons: WorkEntityRemoteWhenReason[] = ['current_remote_required'];
      if (stale) reasons.push('source_stale');
      return { action: 'remote', reasons };
    }

    case 'remote_detail': {
      // Escalate per the DECLARED escalation contract: the author
      // names which detail classes this Source serves remotely. No
      // declared detail reason ⇒ the projection is the whole record
      // (nothing more exists remotely) ⇒ local is complete — UNLESS
      // the Source is stale with `source_stale` declared: an explicit
      // fidelity request against a declared-stale-escalating Source
      // honors that contract (codex fold — `source_stale` was
      // otherwise inert in the per-read planner).
      const declared = REMOTE_DETAIL_REASONS.filter((r) =>
        policy?.remote_when?.includes(r) ?? false,
      );
      const staleEscalate =
        stale && (policy?.remote_when?.includes('source_stale') ?? false);
      if (declared.length === 0 && !staleEscalate) return localWith([]);
      if (!canEscalate) {
        return localWith(
          declared.length > 0
            ? ['no_remote_read_op', 'preview_only']
            : ['no_remote_read_op'],
        );
      }
      const reasons = [...declared];
      if (staleEscalate) reasons.push('source_stale');
      return { action: 'remote', reasons };
    }

    case 'rich_meta':
      // The deterministic default: local rich meta, freshness surfaced
      // in metadata — NEVER silently escalated (a recipe read must not
      // change behavior with wall-clock; wild queries escalate through
      // the wild-query planner instead).
      return localWith([]);
  }
};

// ────────────────────────────────────────────────────────────────
// 3 — wild-query plan (LLM / open queries)
// ────────────────────────────────────────────────────────────────

export interface WildQuerySourceInput {
  freshness: WorkEntitySourceFreshness;
  policy: WorkEntitySourceReadResolution | null;
  has_read_op: boolean;
  /** The local-discovery candidates on this Source the answer would
   *  need remote detail/currentness for (record ids are the Source's
   *  LOCAL row ids — the executor resolves `source_record_id`). */
  candidate_record_ids: readonly string[];
}

export interface WildQueryNeeds {
  /** The answer needs complete detail (body/comments/attachments or
   *  fields beyond projection). */
  detail: boolean;
  /** The prompt asked for "current"/"latest"/"right now". */
  current: boolean;
}

export type WorkEntityWildQueryPlan =
  | {
      mode: 'local';
      /** Per-source limitations for the honest local answer. */
      limitations: Array<{ source_id: string; limitations: WorkEntityReadLimitation[] }>;
    }
  | {
      mode: 'escalate';
      /** Targeted remote reads, bounded by the declared caps. */
      reads: Array<{
        source_id: string;
        record_ids: string[];
        reasons: WorkEntityRemoteWhenReason[];
      }>;
      /** Sources that stay local (fresh, or structurally unable to
       *  escalate) with their limitations. */
      limitations: Array<{ source_id: string; limitations: WorkEntityReadLimitation[] }>;
    }
  | {
      mode: 'ask_to_narrow';
      cap: 'max_sources' | 'max_remote_records';
      /** Human/model-facing explanation of which cap tripped. */
      detail: string;
      /** What an honest local-only answer would have to disclose —
       *  callers may degrade to it instead of asking. */
      limitations: Array<{ source_id: string; limitations: WorkEntityReadLimitation[] }>;
    };

/** Fallback caps for an escalation candidate WITHOUT a declared
 *  `read_resolution` policy (a Source registered outside the
 *  declaration path). The spec's fanout bound is unconditional —
 *  "Never perform unbounded remote fanout" — so a missing declaration
 *  gets the kernel defaults, never a bypass. */
export const WILD_QUERY_DEFAULT_MAX_SOURCES = 3;
export const WILD_QUERY_DEFAULT_MAX_REMOTE_RECORDS = 10;

/** Plan the remote-escalation half of an LLM/wild query over the
 *  Sources its local discovery touched. Escalation triggers per Source:
 *  the answer needs currentness, the answer needs detail the Source
 *  serves remotely (declared `remote_when`), or the Source is stale
 *  with `source_stale` declared. Caps (spec: "Never perform unbounded
 *  remote fanout"): escalating-source count against the MINIMUM
 *  declared `wild_query.max_sources` across involved Sources, and each
 *  Source's record count against its own `max_remote_records` — with
 *  the kernel defaults standing in wherever a policy is missing. */
export const planWorkEntityWildQueryReads = (
  sources: readonly WildQuerySourceInput[],
  needs: WildQueryNeeds,
): WorkEntityWildQueryPlan => {
  const reads: Array<{
    source_id: string;
    record_ids: string[];
    reasons: WorkEntityRemoteWhenReason[];
  }> = [];
  const limitations: Array<{
    source_id: string;
    limitations: WorkEntityReadLimitation[];
  }> = [];
  const declaredWhen = (s: WildQuerySourceInput): readonly WorkEntityRemoteWhenReason[] =>
    s.policy?.remote_when ?? [];

  for (const s of sources) {
    const source_id = s.freshness.source_id;
    if (s.freshness.state === 'local') continue; // authoritative — nothing to escalate

    const stale = isWorkEntitySourceStale(s.freshness);
    const reasons: WorkEntityRemoteWhenReason[] = [];
    if (needs.current) reasons.push('current_remote_required');
    if (needs.detail) {
      reasons.push(...REMOTE_DETAIL_REASONS.filter((r) => declaredWhen(s).includes(r)));
    }
    if (stale && declaredWhen(s).includes('source_stale')) reasons.push('source_stale');

    if (reasons.length === 0) {
      // Fresh enough and covered by rich meta — answer locally, but a
      // stale Source without declared escalation still gets disclosed.
      if (stale) limitations.push({ source_id, limitations: ['source_stale'] });
      continue;
    }
    if (!s.has_read_op) {
      const lim: WorkEntityReadLimitation[] = ['no_remote_read_op'];
      if (needs.detail) lim.push('preview_only');
      if (stale) lim.push('source_stale');
      limitations.push({ source_id, limitations: lim });
      continue;
    }
    reads.push({ source_id, record_ids: [...s.candidate_record_ids], reasons });
  }

  if (reads.length === 0) return { mode: 'local', limitations };

  // Caps — fail toward asking, with the honest-local fallback attached.
  // Each escalation candidate's limitation names WHY local under-serves
  // it (detail → preview_only, currentness → not_current, staleness →
  // source_stale) — a read is only in `reads` because at least one
  // holds, so nothing is fabricated (codex fold: a fresh current-only
  // query must not be labeled `source_stale`).
  const askLimitations = (): Array<{
    source_id: string;
    limitations: WorkEntityReadLimitation[];
  }> => {
    const out = [...limitations];
    for (const r of reads) {
      const src = sources.find((s) => s.freshness.source_id === r.source_id);
      const lim: WorkEntityReadLimitation[] = [];
      if (needs.detail) lim.push('preview_only');
      if (needs.current) lim.push('not_current');
      if (src !== undefined && isWorkEntitySourceStale(src.freshness)) lim.push('source_stale');
      out.push({ source_id: r.source_id, limitations: lim });
    }
    return out;
  };

  const maxSources = Math.min(
    ...sources.map(
      (s) => s.policy?.wild_query.max_sources ?? WILD_QUERY_DEFAULT_MAX_SOURCES,
    ),
  );
  if (reads.length > maxSources) {
    return {
      mode: 'ask_to_narrow',
      cap: 'max_sources',
      detail:
        `the query needs remote reads on ${reads.length} sources; ` +
        `the cap is ${maxSources} — narrow the query to fewer sources`,
      limitations: askLimitations(),
    };
  }
  for (const r of reads) {
    const src = sources.find((s) => s.freshness.source_id === r.source_id);
    const cap =
      src?.policy?.wild_query.max_remote_records
      ?? WILD_QUERY_DEFAULT_MAX_REMOTE_RECORDS;
    if (r.record_ids.length > cap) {
      return {
        mode: 'ask_to_narrow',
        cap: 'max_remote_records',
        detail:
          `the query needs ${r.record_ids.length} remote reads on source ` +
          `'${r.source_id}'; the cap is ${cap} — narrow the query to fewer records`,
        limitations: askLimitations(),
      };
    }
  }

  return { mode: 'escalate', reads, limitations };
};

// ────────────────────────────────────────────────────────────────
// Fidelity-honoring long-text accessor
// ────────────────────────────────────────────────────────────────

export interface WorkEntityLongText {
  /** The logical field the text came from (`body` / `description` /
   *  a declared preview key). */
  field: string;
  text: string;
  /** `complete` — a canonical long-body column (Recued-authored; sync
   *  never populates these). `preview` — bounded text from
   *  `source_extension_blob.preview.*` (never complete content). */
  fidelity: 'complete' | 'preview';
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/** The entity's preview lane — `source_extension_blob.preview.*` string
 *  fields, in declaration order. Defensive over the open blob shape. */
const previewFields = (entity: WorkEntity): Array<{ field: string; text: string }> => {
  const blob = entity.source_extension_blob;
  if (!isRecord(blob) || !isRecord(blob.preview)) return [];
  const out: Array<{ field: string; text: string }> = [];
  for (const [field, value] of Object.entries(blob.preview)) {
    if (typeof value === 'string') out.push({ field, text: value });
  }
  return out;
};

/** Resolve "the long text" of a work entity WITH its fidelity — the one
 *  accessor every surface (resolver detail, FTS, producers, AI
 *  describe) must use before treating text as complete body content
 *  (spec § Sync depth: "a bounded preview must never be presented as
 *  the complete body").
 *
 *  Canonical long-body columns win when present — sync NEVER populates
 *  them (the projector confines remote text to the preview lane), so a
 *  non-empty canonical column is Recued-authored complete content.
 *  Otherwise the first preview-lane field serves, marked `preview`.
 *  Null when the entity carries no long text at all. */
export const workEntityLongText = (entity: WorkEntity): WorkEntityLongText | null => {
  const canonical: { field: string; text: unknown } | null =
    entity._kind === 'task'
      ? { field: 'body', text: entity.body }
      : entity._kind === 'note'
        ? { field: 'body', text: entity.body }
        : entity._kind === 'project'
          ? { field: 'description', text: entity.description }
          : entity._kind === 'commitment'
            ? { field: 'statement', text: entity.statement }
            // `booking` lands here DELIBERATELY, not by omission: it carries no
            // long-text column at all (`title` is a short label), so there is
            // nothing to serve at 'complete' fidelity and nothing to clamp.
            : null;
  if (canonical !== null && typeof canonical.text === 'string' && canonical.text.length > 0) {
    return { field: canonical.field, text: canonical.text, fidelity: 'complete' };
  }
  const preview = previewFields(entity);
  if (preview.length > 0) {
    const first = preview[0]!;
    return { field: first.field, text: first.text, fidelity: 'preview' };
  }
  return null;
};

/** The entity's `detail_fidelity` marker map (empty when none) —
 *  which fields of this row are bounded previews. */
export const workEntityDetailFidelity = (
  entity: Pick<WorkEntity, 'source_extension_blob'>,
): Record<string, 'preview'> => {
  const blob = entity.source_extension_blob;
  if (!isRecord(blob) || !isRecord(blob.detail_fidelity)) return {};
  const out: Record<string, 'preview'> = {};
  for (const [field, value] of Object.entries(blob.detail_fidelity)) {
    if (value === 'preview') out[field] = 'preview';
  }
  return out;
};
