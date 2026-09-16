/** D-182 §8 / D-225 § 9.5.1 — the RAW CATALOG-OP tool projection.
 *
 *  Installed pack operations, projected as `recued_op_<opId>` tools with their
 *  classification derived from the pack's AUTHORED `risk_tier`. No annotation
 *  store is involved anywhere: the tier comes from the pack, and the human
 *  decision is the contract GRANT.
 *
 *  🔑 Extracted from `mcp-server.ts` so a SECOND catalog can consume it. It was
 *  bound to the inbound door alone, which is the only reason chat could not see
 *  declared pack ops (D-225 § 9.5.1) — chat has its own catalog and simply never
 *  received this source. Nothing about the projection was door-specific.
 *
 *  ⚠ Behaviour is unchanged by the move. The door imports from here; its
 *  existing suites (`d-182-raw-op-catalog` / `-dispatch` / `-grant-store`,
 *  `mcp-server`) are the proof. */

import {
  derivePerOpDependencyReads,
  isExternallyExposableIngredient,
  isClosedRequestSchema,
  projectClosedRequestSchemaForJsonSchema,
  type DependencyReadAdmission,
  type IngredientManifest,
  type RiskTier,
} from '@recued/contracts';

import { buildPackOpResolution, type InstalledPackScan } from './pack-inventory.js';
import type { RecipeStore } from './recipe-store.js';

/** The wire-name prefix a raw catalog-op tool carries. */
export const OP_TOOL_PREFIX = 'recued_op_';

const RAW_OP_CONNECTION_PROPERTY = {
  type: 'string',
  description:
    'Name of the enrolled connection to run this operation against (omit for ops that need none).',
} as const;

export const RAW_OP_TOOL_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    connection: RAW_OP_CONNECTION_PROPERTY,
  },
  additionalProperties: true,
} as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** A closed operation request schema is both runtime-enforced and the best
 * available AI contract for a raw op. Merge the framework-owned connection
 * selector into that schema instead of advertising only `connection` and
 * hiding every real operation argument behind `additionalProperties: true`.
 *
 * The raw-op dispatcher reserves and strips `connection` before the catalog
 * gateway validates the operation args. A curated schema that itself declares
 * `connection` cannot coexist with that reservation, so retain the legacy
 * permissive descriptor for that malformed/unrepresentable edge rather than
 * silently overwriting the operation's declaration. */
const rawOpInputSchema = (
  manifest: IngredientManifest,
  requestSchema: unknown,
): unknown => {
  if (!isClosedRequestSchema(requestSchema)
    || !isRecord(requestSchema)
    || !isRecord(requestSchema.properties)
    || Object.prototype.hasOwnProperty.call(requestSchema.properties, 'connection')) {
    return RAW_OP_TOOL_INPUT_SCHEMA;
  }
  const declaredRequired = Array.isArray(requestSchema.required)
    ? requestSchema.required.filter((value): value is string => typeof value === 'string')
    : [];
  const required = [
    ...(manifest.kind === 'connection' ? ['connection'] : []),
    ...declaredRequired,
  ].filter((value, index, all) => all.indexOf(value) === index);
  // ⛔ PROJECT BEFORE SPREADING. The closed subset's `file_ref` / `file_ref[]`
  // types are NOT JSON Schema, and this object becomes a tool's `inputSchema`
  // verbatim — an unprojected one reaches a model as a type no validator knows.
  // Cli ops are fenced off this door, but `tool_function` packs carry file_ref
  // args too, so this is load-bearing rather than defensive.
  const projected = projectClosedRequestSchemaForJsonSchema(requestSchema) as Record<string, unknown>;
  return {
    ...projected,
    properties: {
      connection: RAW_OP_CONNECTION_PROPERTY,
      ...(projected.properties as Record<string, unknown>),
    },
    ...(required.length > 0 ? { required } : {}),
  };
};

/** A raw catalog-op tool descriptor — the shape BOTH door surfaces (the grant
 *  catalog + `tools/list`) map into their own entry shape. */
export interface RawOpToolDescriptor {
  /** wire name `recued_op_<publisher>.<pack>.<operation>`. */
  wireName: string;
  /** the Tier-P op id `<publisher>.<pack>.<operation>`. */
  opId: string;
  description: string;
  inputSchema: unknown;
  classification: 'read' | 'write' | 'unknown';
  /** D-192 Slice 7 — the container reads granting THIS op transitively admits. */
  also_reads?: ReadonlyArray<DependencyReadAdmission>;
}

export const ingredientRiskToGrantClassification = (
  risk: RiskTier,
): 'read' | 'write' | 'unknown' => {
  if (risk === 'read') return 'read';
  return 'write';
};

/** D-182 §8 — the set of Tier-P op ids any installed recipe already covers. The
 *  recipe-preferred catalog filter uses it to suppress a raw WRITE op a recipe
 *  provides (the recipe is the guardrailed headline tool; the raw primitive would
 *  let the AI sidestep its preview/normalization/confidence gates).
 *
 *  A recipe covers a write via EITHER authored form, and BOTH are detected:
 *    - an `op:` step names the Tier-P / Tier-K op id directly (op-authored,
 *      post-D-182-step-4);
 *    - an `ingredient:` step (legacy / third-party / a lowered op-step persisted
 *      in that form) names a catalog slug + `input.operation`, which
 *      `packResolution` maps back to the op id `<publisher>.<pack>.<operation>` —
 *      the SAME id `buildRawOpToolDescriptors` checks, so the suppression matches.
 *  When `packResolution` is omitted (dbless / pre-wire harness, or no inventory)
 *  the walk is op-step-only: an `ingredient:`-covered write simply stays visible
 *  (the safe direction — over-exposure, never hiding a write; the owner can still
 *  narrow it). Pass the SAME `(scanInstalledPacks, getManifest)`-derived
 *  resolution the descriptor builder uses so the op ids align. Pure; never throws. */
export const buildRecipeOpCoverage = (
  recipeStore: Pick<RecipeStore, 'ids' | 'get'>,
  packResolution?: ReturnType<typeof buildPackOpResolution>,
): Set<string> => {
  const covered = new Set<string>();
  // Reverse the resolution (pack_ref → { catalog_slug, operations }) into
  // catalog_slug → [{ packRef, operations }] so an ingredient-step's catalog slug
  // maps to its covering op id(s). One entry per installed op-declaring pack; a
  // slug shared by >1 pack contributes each match (the descriptor builder emits
  // all of them too).
  const byCatalog = new Map<string, { packRef: string; operations: ReadonlySet<string> }[]>();
  if (packResolution) {
    for (const [packRef, binding] of packResolution) {
      const entry = { packRef, operations: binding.operations };
      const list = byCatalog.get(binding.catalog_slug);
      if (list) list.push(entry);
      else byCatalog.set(binding.catalog_slug, [entry]);
    }
  }
  for (const id of recipeStore.ids()) {
    const recipe = recipeStore.get(id);
    for (const step of recipe?.steps ?? []) {
      const s = step as { op?: unknown; ingredient?: unknown; input?: unknown };
      // op-step — names the op id directly.
      if (typeof s.op === 'string' && s.op.length > 0) {
        covered.add(s.op);
        continue;
      }
      // ingredient-step — `ingredient` is the catalog slug, `input.operation` the
      // op; map the pair back to the op id(s) it covers via the resolution.
      if (typeof s.ingredient === 'string' && s.ingredient.length > 0 && byCatalog.size > 0) {
        const input = s.input;
        const operation =
          input !== null && typeof input === 'object'
            ? (input as { operation?: unknown }).operation
            : undefined;
        if (typeof operation !== 'string' || operation.length === 0) continue;
        for (const { packRef, operations } of byCatalog.get(s.ingredient) ?? []) {
          if (operations.has(operation)) covered.add(`${packRef}.${operation}`);
        }
      }
    }
  }
  return covered;
};

export const buildRawOpToolDescriptors = (
  scanInstalledPacks: InstalledPackScan,
  getManifest: (slug: string) => IngredientManifest | null,
  recipeOpCoverage?: ReadonlySet<string>,
): RawOpToolDescriptor[] => {
  const out: RawOpToolDescriptor[] = [];
  const resolution = buildPackOpResolution(scanInstalledPacks, getManifest);
  for (const [packRef, binding] of resolution) {
    const manifest = getManifest(binding.catalog_slug);
    // §8 KIND fence — cli/service catalogs never expose raw ops (combined fence).
    if (!manifest || !isExternallyExposableIngredient(manifest)) continue;
    // D-192 Slice 7 — op_key → the container reads granting it admits, computed
    // ONCE per manifest (the SAME admission the gate + #contracts grid apply).
    const operations = manifest.operations ?? {};
    const perOpReads = derivePerOpDependencyReads({
      sources: manifest.work_entity_sources,
      riskOfOp: (op) =>
        Object.prototype.hasOwnProperty.call(operations, op) ? operations[op]?.risk_tier : undefined,
    });
    for (const operation of binding.operations) {
      const opSpec = manifest.operations?.[operation];
      if (!opSpec) continue; // defensive — `operations` came from the same table
      const classification = ingredientRiskToGrantClassification(opSpec.risk_tier);
      const opId = `${packRef}.${operation}`;
      // §8 recipe-preferred suppression — a WRITE op a recipe already provides
      // is the recipe's to expose (guardrailed); drop the raw primitive. Reads
      // are unaffected (AI-open).
      if (classification === 'write' && recipeOpCoverage?.has(opId)) continue;
      const also_reads = perOpReads.get(operation);
      out.push({
        wireName: `${OP_TOOL_PREFIX}${opId}`,
        opId,
        description:
          `[${opSpec.risk_tier}] ${opSpec.description ?? operation} (pack ${packRef}) `
          + '— raw catalog operation; pass "connection" to bind an enrolled connection.',
        inputSchema: rawOpInputSchema(manifest, opSpec.request_schema),
        classification,
        ...(also_reads !== undefined ? { also_reads } : {}),
      });
    }
  }
  return out;
};

/** Project the raw-op descriptors into `ToolEntry` rows — the shape BOTH
 *  catalogs consume.
 *
 *  🔑 D-225 § 9.5.1 — factored out of `buildMcpGrantCatalogLegacyEntries` so the
 *  CHAT catalog gets byte-identical entries rather than a second mapping that
 *  can drift. A raw op that described itself differently to chat than to the
 *  door would be the same op wearing two faces, and the owner's grant covers
 *  both.
 *
 *  `tier: 2` matches what the door stamps: a raw op is a pack operation, and
 *  `buildDefaultMcpInboundTokenGrants` keys its read-on / write-off default off
 *  the `recued_op_` prefix rather than the tier, so the two agree.
 *
 *  ⚠ Emitting an entry is VISIBILITY, not authority. The gate stays the
 *  contract's per-op grant (§ 9.7: grant is per-contract, risk/approval is
 *  global) — this only decides what a caller can SEE to ask for. */
/** Map already-resolved descriptors into entries — the half of
 *  `rawOpToolEntries` that runs AFTER a caller-facing filter (§ 9.8). */
export const rawOpToolEntriesFrom = (
  descriptors: readonly RawOpToolDescriptor[],
): RawOpToolEntry[] =>
  descriptors.map((d) => ({
    name: d.wireName,
    tier: 2 as const,
    description: d.description,
    arg_schema: d.inputSchema,
    topic_tags: [],
    classification: d.classification,
    concurrency_safe: false,
    ...(d.also_reads !== undefined ? { also_reads: d.also_reads } : {}),
  }));

export const rawOpToolEntries = (
  scanInstalledPacks: InstalledPackScan,
  getManifest: (slug: string) => IngredientManifest | null,
  recipeOpCoverage?: ReadonlySet<string>,
): RawOpToolEntry[] =>
  rawOpToolEntriesFrom(
    buildRawOpToolDescriptors(scanInstalledPacks, getManifest, recipeOpCoverage),
  );

/** The `ToolEntry`-compatible row `rawOpToolEntries` emits. Structural rather
 *  than an import of `ToolEntry` so this module stays free of the chat
 *  vocabulary it feeds. */
export interface RawOpToolEntry {
  name: string;
  tier: 2;
  description: string;
  arg_schema: unknown;
  topic_tags: readonly string[];
  classification: 'read' | 'write' | 'unknown';
  concurrency_safe: boolean;
  also_reads?: ReadonlyArray<DependencyReadAdmission>;
}

/** D-225 § 9.8 — the facilitated function: derive a CALLER-FACING catalog from
 *  the contract.
 *
 *  🔑 The principle: every door/consumer should get its ops from the contract,
 *  or from one shared function that reads the contract — so the contract is
 *  genuinely the heart of grant, and no surface has to grow its own visibility
 *  source. A surface without a universal one to reach for grows its own; that is
 *  how Tier 3 ended up deriving visibility from an annotation store (§ 2) and why
 *  declared pack ops had no chat presence until § 9.5.1.
 *
 *  ⚠ **`(universe, isGranted)`, not `(contract)`.** The author-default is
 *  PERMISSIVE for the owner and for a wildcard door, so for those callers the
 *  granted set is not enumerable from grant rows — it is *the universe minus
 *  explicit revokes minus the § 9.6 tightening*. Only explicit-only contracts
 *  (customer / reception / PUBLIC) carry a finite self-contained list. So the
 *  universe is an input, and `isGranted` is the caller's already-bound
 *  resolution (`gate.isOpGranted(source, opId)`) — this composes what exists
 *  rather than re-deciding anything.
 *
 *  ⛔ **CALLER-FACING catalogs only. NOT the grant chooser.**
 *  `buildMcpGrantCatalogLegacyEntries` feeds the owner's per-tool grant
 *  checklist, and filtering THAT by grant is the chicken-and-egg: the owner
 *  could never grant an op because an ungranted op would not be shown. The two
 *  are different questions — *what may this caller invoke* vs *what may the
 *  owner grant* — and only the first is derived from the contract. */
export const visibleRawOps = (
  universe: readonly RawOpToolDescriptor[],
  isGranted: (opId: string) => boolean,
): RawOpToolDescriptor[] => universe.filter((d) => isGranted(d.opId));
