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
 *  Scope: producers calling `ctx.llm` / `ctx.llmWithMeta` with content fields
 *  (`llm.data` / `llm.context` / `llm.prompt` / `llm.data_block`), in two
 *  shapes — `wrapHousekeepingCtxForRecord` seeds the ledger from ONE source
 *  record (the per-record harness + own-walk single-record producers), and
 *  `wrapHousekeepingCtxForFanIn` seeds it from MANY (fan-in producers whose
 *  corpus blob folds subjects / body previews across N rows — topic_cluster, the
 *  engagement aggregates). Both share one core: the identifier pass runs over
 *  every seed record BEFORE the content scan, so cross-record PII can't leak by
 *  iteration order. `ctx.embed` (vectorisation) is intentionally NOT aliased —
 *  aliasing would corrupt the embedding's semantic value.
 *
 *  ⛔ D-316 (2026-09-26) — THE CHAT'S STANDARD, NOT A COMFORT LAYER. Until then
 *  this seam differed from the chat's (`chat-pii-egress.ts`) in two ways that
 *  each sent raw PII to a model: a structured `llm.data` (a D-162 batch array, a
 *  nested object) passed through unaliased, and every aliasing error fell open to
 *  the raw input. Now, as the chat does:
 *    - the WHOLE content is aliased — structured values walked leaf by leaf,
 *      keys included (`aliasArgsForEgress`, what the chat runs on tool args) —
 *      after ONE collision pre-scan per call (`preScanPacketForEgress`), so an
 *      alias-shaped literal already in the text round-trips as written;
 *    - an aliasing ERROR means NO call: the wrapped `llm` / `llmWithMeta` throws
 *      `EnrichmentPiiAliasingError` before the real call. The per-record harness
 *      records it as a per-row producer failure (backoff, retry); a fan-in
 *      producer's cycle fails, visibly;
 *    - the model output is restored keys included, since keys were aliased.
 *  Nothing to alias is NOT a failure: a record with no tagged value, or text
 *  with no known value in it, is sent as it is. Out of scope, on purpose:
 *  recipe AI steps (aliased by the recipe) and document bytes
 *  (`llm.content_parts`; `extracted_text` runs only when the owner starts it).
 *
 *  Spec: D-167 §"Runtime flow", §"Scope", §Integration/D-165;
 *  D-316.
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

/** D-316 — the privacy layer could not alias a model-bound input, so the call
 *  was NOT made. Thrown by the wrapped `ctx.llm` / `ctx.llmWithMeta` before the
 *  real call; its message is the reason the harness records. */
export class EnrichmentPiiAliasingError extends Error {
  constructor(cause: unknown) {
    super(
      `the privacy layer could not alias this model input, so no call was made: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      { cause },
    );
    this.name = 'EnrichmentPiiAliasingError';
  }
}

/** D-316 — a ctx whose model calls refuse without calling, for a record whose
 *  input cannot be aliased at all (the ledger could not be seeded). Every other
 *  field — including `embed`, which is never aliased — is the caller's own. */
const refuseModelCalls = (ctx: HousekeepingContext, cause: unknown): HousekeepingContext => {
  const refused: HousekeepingContext = { ...ctx };
  if (ctx.llm !== undefined) {
    refused.llm = async () => {
      throw new EnrichmentPiiAliasingError(cause);
    };
  }
  if (ctx.llmWithMeta !== undefined) {
    refused.llmWithMeta = async () => {
      throw new EnrichmentPiiAliasingError(cause);
    };
  }
  return refused;
};

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
 *  Returns the context UNCHANGED (byte-identical producer behaviour) when there
 *  is nothing to alias:
 *    - no tag source is wired (`enrichmentPiiTagSource` absent);
 *    - the scope resolves no tags;
 *    - no record carries a tagged string value to seed (incl. an empty
 *      `records` list).
 *
 *  ⛔ When seeding THROWS, returns a context whose model calls refuse
 *  (`EnrichmentPiiAliasingError`) — D-316: an input that cannot be aliased is
 *  not sent. It never throws itself: the harness calls it outside its per-row
 *  `try`, so a throw here would fail the whole step instead of one row.
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
  } catch (error) {
    // D-316 — seeding failed, so this input cannot be aliased: refuse the
    // model calls rather than fall open to the raw producer path (the chat's
    // standard; until D-316 this returned `ctx` and the input went out raw).
    return refuseModelCalls(ctx, error);
  }

  /** D-316 — alias the whole content of one model call, the chat's way:
   *   1. collision-proof it ONCE against alias-shaped literals already in it
   *      (`preScanPacketForEgress`, D-167 Slice 3 — once per packet, never per
   *      field), so a literal `pii.Person1` round-trips instead of restoring to
   *      a real name;
   *   2. alias every content value against the seeded ledger — strings, and
   *      structured values (a D-162 batch array, a nested object) walked leaf by
   *      leaf, keys included (`aliasArgsForEgress`, what the chat runs on tool
   *      args).
   *  Control fields pass through untouched; the caller's value is never mutated.
   *  ANY error throws `EnrichmentPiiAliasingError`, so no call is made. */
  const aliasInput = (input: Record<string, unknown>): Record<string, unknown> => {
    try {
      const content: Record<string, unknown> = {};
      for (const key of CONTENT_INPUT_KEYS) {
        const value = input[key];
        if (value !== undefined && value !== null) content[key] = value;
      }
      if (Object.keys(content).length === 0) return input;
      const { value: collisionProof } = piiEgress.preScanPacketForEgress(ledger, content);
      const { aliased } = piiEgress.aliasArgsForEgress(ledger, collisionProof);
      return { ...input, ...aliased };
    } catch (error) {
      throw new EnrichmentPiiAliasingError(error);
    }
  };

  /** Restore aliases in the model result before the producer parses it, so the
   *  enrichment value + downstream reads see real values. Keys too: the content
   *  pass aliases keys, so a model that keys its answer by one is restored.
   *  Restore never throws (unknown aliases pass through) — the §Hard invariant. */
  const restoreModelResult = <T>(result: T): T =>
    piiEgress.restoreArgsAndKeysForApproval(ledger, result);

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
 *  restores the model output. Same invariants as the single-record seam: nothing
 *  to alias (incl. an empty `records` list) returns the raw ctx, and an aliasing
 *  error refuses the call (D-316). */
export const wrapHousekeepingCtxForFanIn = (
  ctx: HousekeepingContext,
  scope: EnrichmentScope,
  records: readonly unknown[],
): HousekeepingContext => wrapHousekeepingCtxWithSeedRecords(ctx, scope, records);
