/** D-126 Phase 2.3 — `AdapterRegistry` runtime wiring.
 *
 *  Closed-set per-kind adapter dispatch table. Replaces D-126 P2.2's
 *  `IngredientAdapters` partial map (`packages/ingredients/src/dispatch.ts`)
 *  as the single source of truth for routing decisions. Boot sites
 *  (the server-executor) construct a `AdapterRegistry`
 *  via `createAdapterRegistry` and hand it to `createIngredientExecutor`,
 *  which performs the kind-keyed dispatch.
 *
 *  Why closed-set: P2.2's partial map allowed a manifest's kind to silently
 *  miss an adapter slot at runtime, which surfaced as
 *  `INGREDIENT_ADAPTER_ALL_FAILED` from the dispatcher. The closed-set
 *  registry forces every kind to have an entry — boot sites that don't
 *  support a kind on their device class (the server has no DOM / chat
 *  context) install an explicit `unsupported` placeholder
 *  that throws with a kind-named diagnostic, instead of leaving the
 *  slot undefined.
 *
 *  Why ResolvedCall (not the spec's `(manifest, input, ctx)` shape):
 *  the existing per-kind executors (`executeHTTP` / `executeMCP` /
 *  `executeDOM` / `executeLLM` / kernel / chat) all consume a
 *  `ResolvedCall` envelope built by the dispatcher. Switching their
 *  signatures is a separate refactor (P2.x or D-127). For P2.3 we keep
 *  the existing `Adapter` shape and treat the spec's
 *  `(manifest, input, ctx)` form as conceptual; `ResolvedCall` already
 *  flattens manifest + input + per-call context into a single envelope.
 *
 *  `connection` slot stays a `KIND_NOT_YET_IMPLEMENTED` placeholder
 *  until D-125 P3 swaps in the outbound-endpoint adapter.
 *
 *  Spec: `docs/d-126-spec.md` § 2.1, § A.3. */

import type { IngredientKind } from '@recued/contracts';
import type { Adapter } from '@recued/ingredients';
import { IngredientError } from '@recued/ingredients';

/** Per-kind adapter dispatch table. Every kind is populated — kinds the
 *  current device doesn't support carry a placeholder that throws
 *  `INGREDIENT_ADAPTER_ALL_FAILED` with the kind name on the error
 *  details, surfacing routing problems at call time with a legible
 *  message instead of an undefined-slot crash. */
export type AdapterRegistry = Record<IngredientKind, Adapter>;

/** Build a placeholder `Adapter` that throws `INGREDIENT_ADAPTER_ALL_FAILED`.
 *  Carries the kind on the error so boot-site mis-wiring (server tries
 *  to run a `kind: 'dom'` ingredient) surfaces with a precise diagnostic.
 *  Used for kinds the runtime does not support on the current device
 *  class (mirrors `kindToScope` from D-126 P1.2). */
const unsupported = (kind: IngredientKind, reason: string): Adapter =>
  async (resolved) => {
    throw new IngredientError(
      'INGREDIENT_ADAPTER_ALL_FAILED',
      `Ingredient '${resolved.slug}' requires the '${kind}' adapter, but ${reason}`,
      { slug: resolved.slug, kind, reason },
    );
  };

/** `connection` adapter placeholder. D-125 P3 swaps in the real
 *  outbound-endpoint adapter (api / mcp / notification subtypes).
 *  Surfaces as `KIND_NOT_YET_IMPLEMENTED` so callers can render a
 *  "connection adapter not yet shipped" message; D-126 P4.3 promotes
 *  this to a structured RecipeError envelope. */
export const connectionPlaceholder: Adapter = async (resolved) => {
  throw Object.assign(
    new IngredientError(
      'KIND_NOT_YET_IMPLEMENTED' as 'INGREDIENT_ADAPTER_ALL_FAILED',
      `connection adapter ships in D-125 P3 (slug '${resolved.slug}')`,
      { slug: resolved.slug, kind: 'connection' },
    ),
    { code: 'KIND_NOT_YET_IMPLEMENTED' as const, kind: 'connection' as const },
  );
};

/** Construction-time deps for `createAdapterRegistry`. Each kind is
 *  optional — boot sites provide adapters for the kinds they support;
 *  unsupported kinds get the `unsupported(...)` placeholder. The
 *  factory always returns a fully-populated closed-set registry, so
 *  the dispatcher's lookup is a single index access with no `?.` /
 *  fallback path. */
export interface AdapterRegistryDeps {
  http?: Adapter;
  dom?: Adapter;
  ai?: Adapter;
  chat?: Adapter;
  mcp?: Adapter;
  service?: Adapter;
  storage?: Adapter;
  /** D-125 P3 will replace this default placeholder. Override here only
   *  for tests that exercise a custom connection-kind harness. */
  connection?: Adapter;
  /** D-182 — cli toolkit ops execute via the per-kind preflight/execute
   *  handler registry (§7 cli handler), addressed as Tier-P pack ops, NOT
   *  through this legacy `ingredient:`-step adapter table. No boot site wires
   *  a cli adapter here; the slot defaults to the kind-named placeholder so a
   *  stray legacy `ingredient: <cli-slug>` step fails with a legible error. */
  cli?: Adapter;
}

/** Construct a closed-set `AdapterRegistry` from per-kind adapters.
 *  Kinds the caller doesn't supply are stamped with a placeholder
 *  that throws `INGREDIENT_ADAPTER_ALL_FAILED` at call time — surfacing
 *  the missing-adapter problem with a kind-named diagnostic instead of
 *  a silent undefined-slot crash.
 *
 *  Per-device defaults are NOT applied here (no "server implies
 *  service" assumption); boot sites pass exactly the set of adapters
 *  they wired. The registry is purely a transport layer. */
export const createAdapterRegistry = (
  deps: AdapterRegistryDeps,
): AdapterRegistry => ({
  http: deps.http ?? unsupported('http', 'no HTTP adapter is registered on this device'),
  dom: deps.dom ?? unsupported('dom', 'this device does not have a browser DOM context'),
  ai: deps.ai ?? unsupported('ai', 'no AI adapter is configured (BYOK slot or free pool)'),
  chat: deps.chat ?? unsupported('chat', 'this device does not have a web-chat tab adapter'),
  mcp: deps.mcp ?? unsupported('mcp', 'no MCP adapter is registered on this device'),
  service: deps.service ?? unsupported('service', 'this device does not host long-running services'),
  storage: deps.storage ?? unsupported('storage', 'no storage adapter is registered on this device'),
  connection: deps.connection ?? connectionPlaceholder,
  cli: deps.cli ?? unsupported('cli', 'cli ops execute via the per-kind handler registry, not the legacy adapter table'),
});
