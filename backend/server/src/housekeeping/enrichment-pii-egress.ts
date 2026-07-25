/** D-167 — non-chat (enrichment-producer) AI-egress PII aliasing.
 *
 *  The chat path (D-167 P1/S4) aliases known PII in LLM-bound packets via the
 *  gateway `piiEgress` substrate; the enrichment housekeeping producers are the
 *  one OTHER surface where Recued owns the LLM↔user boundary and ships
 *  warehouse entity content to a cloud / free-pool model — an AI producer
 *  flattens a source record (a mail body, a contact note) into `llm.data` and
 *  calls `ctx.llm` / `ctx.llmWithMeta`. Before D-167 those packets egressed
 *  raw. This module closes that gap with the SAME comfort-layer guarantee as
 *  chat: alias known PII before egress, restore the model output locally so the
 *  warehouse row + audit see real values, and only the model ever sees aliases.
 *
 *  Mechanism (spec §"Runtime flow"). A producer's `llm.data` is a flattened
 *  text BLOB, so field-path tagging doesn't apply directly — instead we seed a
 *  run-local alias ledger from the source record's `MetaField.privacy`-tagged
 *  STRUCTURED fields (the `from` / `to` / `subject` the producer also reads),
 *  then content-scan the blob against that ledger. Both passes ride the
 *  existing gateway `aliasPacketForEgress` via a synthetic packet: the
 *  identifier pass over the structured seed values populates the ledger; the
 *  content pass over the blob replaces any occurrence. The model output is
 *  restored with `restoreArgsForApproval` before the producer parses it, so the
 *  enrichment value + every downstream read carry real values (the §Hard
 *  invariant — aliasing may miss, restore may not).
 *
 *  Tag source is INJECTED on `HousekeepingContext.enrichmentPiiTagSource`
 *  (`EnrichmentPiiTagSource`), defaulting to absent — when unwired (or no tags
 *  resolve, or the record carries no tagged value) the wrap is skipped and
 *  producer LLM calls are byte-identical to pre-D-167. This is the comfort
 *  default's no-op path (spec §P5 "no UI opt-in needed") and the
 *  behavior-preservation invariant for the activation slice that wires the
 *  real schema-driven tag source.
 *
 *  Scope: producers calling `ctx.llm` / `ctx.llmWithMeta` with STRING content
 *  fields (`llm.data` / `llm.context` / `llm.prompt` / `llm.data_block`), in two
 *  shapes — `wrapHousekeepingCtxForRecord` seeds the ledger from ONE source
 *  record (the per-record harness + own-walk single-record producers), and
 *  `wrapHousekeepingCtxForFanIn` seeds it from MANY (fan-in producers whose
 *  corpus blob folds subjects / body previews across N rows — topic_cluster, the
 *  engagement aggregates). Both share one core: the identifier pass runs over
 *  every seed record BEFORE the content scan, so cross-record PII can't leak by
 *  iteration order. Non-string (D-162 batch / structured) `llm.data` passes
 *  through raw (a comfort miss, not a break); `ctx.embed` (vectorisation) is
 *  intentionally NOT aliased — aliasing would corrupt the embedding's semantic
 *  value. Both are documented follow-ons.
 *
 *  Spec: D-167 §"Runtime flow", §"Scope", §Integration/D-165
 *  (amended — enrichment egress is a comfort-layer surface).
 */

import { piiEgress } from '@recued/gateway';
import type {
  EntityFieldPrivacy,
  EnrichmentScope,
  IngredientManifest,
  PiiAliasableData,
  PiiFieldTag,
} from '@recued/contracts';

import type { HousekeepingContext } from './registry.js';

/** The producer-input keys whose STRING values carry source content the model
 *  reasons over. Control fields (`llm.fields`, `llm.model_hint`,
 *  `llm.force_layer`, …) are left untouched. */
const CONTENT_INPUT_KEYS = [
  'llm.data',
  'llm.context',
  'llm.prompt',
  'llm.data_block',
] as const;

const PROTOTYPE_UNSAFE_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);

/** Read the string value(s) at a dot-path into the source record. A final
 *  string yields one value; a final array yields its string elements (the
 *  canonical `to: ['a@x', 'b@y']` shape). Anything else (nested object,
 *  number, missing) yields nothing — Slice-1 seeds from string-leaf structured
 *  fields only. Prototype-unsafe segments abort the read. */
const readStringsAtPath = (data: unknown, path: string): string[] => {
  const segments = path.split('.');
  let cursor: unknown = data;
  for (const segment of segments) {
    if (segment.length === 0 || PROTOTYPE_UNSAFE_SEGMENTS.has(segment)) return [];
    if (cursor === null || typeof cursor !== 'object' || Array.isArray(cursor)) {
      return [];
    }
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  if (typeof cursor === 'string') return cursor.length > 0 ? [cursor] : [];
  if (Array.isArray(cursor)) {
    return cursor.filter((v): v is string => typeof v === 'string' && v.length > 0);
  }
  return [];
};

interface SeedValue {
  readonly kind: EntityFieldPrivacy;
  readonly value: string;
}

/** Collect the structured PII seed values from the source record per the
 *  resolved tags. `'content'`-kind tags don't seed (they describe text to
 *  scan, not a whole-value identifier); only identifier kinds produce a seed. */
const collectSeedValues = (
  recordData: unknown,
  tags: readonly PiiFieldTag[],
): SeedValue[] => {
  const seeds: SeedValue[] = [];
  for (const tag of tags) {
    if (tag.kind === 'content') continue;
    // Probe the tag path against the record's `data`. Flat records (contact /
    // work entities / platform-reference vendor snapshots) carry canonical /
    // vendor fields at the top level, so the bare path hits directly. But the
    // canonical-collection scopes (mail / calendar / file) store their records
    // as `CollectionRecord`, which nests the canonical fields under a
    // `hot_fields` envelope (`hot_fields.from`, `hot_fields.subject`) — so when
    // the bare path misses, retry under `hot_fields.` to resolve the tag
    // (whose path comes from the canonical `key` / vendor `source_path`)
    // against the stored shape. Non-matching attempts yield nothing (safe).
    let values = readStringsAtPath(recordData, tag.path);
    if (values.length === 0) {
      values = readStringsAtPath(recordData, `hot_fields.${tag.path}`);
    }
    for (const value of values) {
      seeds.push({ kind: tag.kind, value });
    }
  }
  return seeds;
};

type LlmExecute = NonNullable<HousekeepingContext['llm']>;
type LlmExecuteWithMeta = NonNullable<HousekeepingContext['llmWithMeta']>;

/** Collect the DISTINCT PII seed values across many source records per the
 *  resolved tags, preserving first-seen order. The shared ledger already
 *  dedupes by `(kind, real_value)` (its `getOrAllocate` is idempotent), so this
 *  is purely a bound: collapsing here sizes the seed packet by the distinct
 *  identifier count rather than the record count, so the fan-in pass can seed
 *  from a whole scanned corpus without building an N-record-sized packet.
 *  First-seen order is preserved (insertion-ordered Map) so the allocated alias
 *  numbers (`m1`, `pii.Person1`, …) come out identical to the single-record path. */
const collectDistinctSeedValues = (
  records: readonly unknown[],
  tags: readonly PiiFieldTag[],
): SeedValue[] => {
  const byKindValue = new Map<string, SeedValue>();
  for (const record of records) {
    for (const seed of collectSeedValues(record, tags)) {
      const key = `${seed.kind}::${seed.value}`;
      if (!byKindValue.has(key)) byKindValue.set(key, seed);
    }
  }
  return Array.from(byKindValue.values());
};

/** Seed a fresh run-local alias ledger from EVERY record in `records` (per the
 *  scope's resolved privacy tags) and return a `HousekeepingContext` whose LLM
 *  calls alias known PII on egress and restore it on the model output. This is
 *  the shared core behind both the single-record seam
 *  (`wrapHousekeepingCtxForRecord`, N = 1) and the fan-in seam
 *  (`wrapHousekeepingCtxForFanIn`, N source rows) — the ONLY difference between
 *  them is how many records seed the one ledger.
 *
 *  The identifier pass runs over ALL records' structured fields BEFORE any
 *  content scan, so a value structured in record A is aliased even where it
 *  surfaces in a blob built from record B — the same order-independence
 *  `aliasFieldsBatch` documents for the recipe-mode batch path. (A naive
 *  per-record wrap would scan the corpus against a ledger seeded from one row
 *  and leak every other row's PII based purely on iteration order.)
 *
 *  Returns the context UNCHANGED (byte-identical producer behaviour, the comfort
 *  default no-op) when:
 *    - no tag source is wired (`enrichmentPiiTagSource` absent);
 *    - the scope resolves no tags;
 *    - no record carries a tagged string value to seed (incl. an empty
 *      `records` list);
 *    - seeding throws (fail-open: a comfort miss, never a producer break).
 *
 *  Caller gates on `is_ai_surface` so deterministic producers skip the work. */
const wrapHousekeepingCtxWithSeedRecords = (
  ctx: HousekeepingContext,
  scope: EnrichmentScope,
  records: readonly unknown[],
): HousekeepingContext => {
  const tagSource = ctx.enrichmentPiiTagSource;
  if (tagSource === undefined) return ctx;
  if (ctx.llm === undefined && ctx.llmWithMeta === undefined) return ctx;

  let ledger: ReturnType<piiEgress.SessionLedgerStore['getOrCreate']>;
  try {
    const tags = tagSource(scope);
    if (tags.length === 0) return ctx;
    const seeds = collectDistinctSeedValues(records, tags);
    if (seeds.length === 0) return ctx;

    // Per-call RAM ledger — created fresh, never persisted, GC'd when the
    // produce() / cycle call returns (the recipe-mode pure-RAM posture; a
    // durable cross-call ledger would defeat the privacy stance).
    ledger = piiEgress.createSessionLedgerStore().getOrCreate('enrichment-record');
    // Identifier pass over the structured seed values populates the ledger
    // (alias + domain side-effects) so the per-call content pass can replace
    // them in the blob. The aliased seed packet itself is discarded.
    const seedPacket: Record<string, string> = {};
    seeds.forEach((seed, i) => {
      seedPacket[`s${i}`] = seed.value;
    });
    const seedResolver: piiEgress.FieldPrivacyResolver = () =>
      seeds.map((seed, i): PiiFieldTag => ({ path: `s${i}`, kind: seed.kind }));
    piiEgress.aliasPacketForEgress({
      ledger,
      packet: seedPacket as PiiAliasableData,
      resolver: seedResolver,
      mode: 'alias',
    });
  } catch {
    // Seeding failure → fall open to the raw producer path. The substrate is
    // allowed to MISS (comfort tradeoff); it must never break the producer.
    return ctx;
  }

  /** Content-scan the input's string content fields against the seeded ledger.
   *  Control fields and non-string values pass through untouched. Fail-open:
   *  any error returns the raw input (a comfort miss, never a throw). */
  const aliasInput = (input: Record<string, unknown>): Record<string, unknown> => {
    try {
      const contentKeys = CONTENT_INPUT_KEYS.filter(
        (key) => typeof input[key] === 'string' && (input[key] as string).length > 0,
      );
      if (contentKeys.length === 0) return input;
      const packet: Record<string, string> = {};
      contentKeys.forEach((key, i) => {
        packet[`c${i}`] = input[key] as string;
      });
      const resolver: piiEgress.FieldPrivacyResolver = () =>
        contentKeys.map((_, i): PiiFieldTag => ({ path: `c${i}`, kind: 'content' }));
      const { aliased } = piiEgress.aliasPacketForEgress({
        ledger,
        packet: packet as PiiAliasableData,
        resolver,
        mode: 'alias',
      });
      const aliasedRecord = aliased as Record<string, unknown>;
      const out: Record<string, unknown> = { ...input };
      contentKeys.forEach((key, i) => {
        out[key] = aliasedRecord[`c${i}`];
      });
      return out;
    } catch {
      return input;
    }
  };

  /** Restore aliases in the model result before the producer parses it, so the
   *  enrichment value + downstream reads see real values. `restoreArgs` never
   *  throws (unknown aliases pass through) — the §Hard invariant restore. */
  const restoreModelResult = <T>(result: T): T =>
    piiEgress.restoreArgsForApproval(ledger, result);

  const wrapped: HousekeepingContext = { ...ctx };
  if (ctx.llm !== undefined) {
    const realLlm: LlmExecute = ctx.llm;
    wrapped.llm = async (manifest: IngredientManifest, input: Record<string, unknown>) =>
      restoreModelResult(await realLlm(manifest, aliasInput(input)));
  }
  if (ctx.llmWithMeta !== undefined) {
    const realLlmWithMeta: LlmExecuteWithMeta = ctx.llmWithMeta;
    wrapped.llmWithMeta = async (
      manifest: IngredientManifest,
      input: Record<string, unknown>,
    ) => {
      const out = await realLlmWithMeta(manifest, aliasInput(input));
      return { ...out, result: restoreModelResult(out.result) };
    };
  }
  return wrapped;
};

/** Single-record alias seam — seeds the ledger from ONE source record's
 *  `MetaField.privacy`-tagged structured fields. The per-record enrichment
 *  harness (`runProduce`) and the own-walk `runAIProducer` cache-miss path call
 *  this for producers that flatten one structured record into `llm.data`. A thin
 *  delegation to the shared core (`records = [recordData]`) — the single-record
 *  behaviour + every no-op / fail-open invariant is preserved exactly. */
export const wrapHousekeepingCtxForRecord = (
  ctx: HousekeepingContext,
  scope: EnrichmentScope,
  recordData: unknown,
): HousekeepingContext => wrapHousekeepingCtxWithSeedRecords(ctx, scope, [recordData]);

/** Multi-record fan-in alias seam — seeds ONE ledger from MANY evidence records
 *  before wrapping egress. Fan-in producers fold their `llm.data` corpus across
 *  many source rows (topic_cluster: clustered mail subjects; the engagement
 *  aggregates: per-row body previews across a deal's evidence rows), so the PII
 *  that egresses lives across N records, not in one structured record — the
 *  single-record seam can't seed it (it would alias one row's PII and leak the
 *  rest).
 *
 *  `scope` is the scope whose privacy tags describe the SEED records (for the
 *  engagement aggregates that is the engagement-entity evidence scope, which
 *  differs from the producer's deal output scope). `records` are the structured
 *  source rows whose tagged fields seed the ledger; the caller then passes its
 *  corpus blob through the returned ctx's `llm` / `llmWithMeta` as usual, and
 *  the wrap content-scans the blob against the fully-seeded ledger on egress +
 *  restores the model output. Same no-op + fail-open invariants as the
 *  single-record seam (incl. an empty `records` list → returns the raw ctx). */
export const wrapHousekeepingCtxForFanIn = (
  ctx: HousekeepingContext,
  scope: EnrichmentScope,
  records: readonly unknown[],
): HousekeepingContext => wrapHousekeepingCtxWithSeedRecords(ctx, scope, records);
