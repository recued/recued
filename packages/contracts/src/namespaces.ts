/** Namespace prefixes used by the value resolver.
 *
 *  D-023/D-028 eliminated prefetch, scratchpad, polling.
 *  D-100 added `account` (account-scoped service credentials + identity,
 *  default-syncs across paired instances; contrast with device-local `vault`).
 *  `prefs` holds pair-scoped instance preferences (see `./prefs`) — infra
 *  only, never referenced from recipe JSON. Listed here so the sync
 *  machinery reuses the same namespace vocabulary as everything else.
 *
 *  D-103 (Phase A) added `shared` + `data.shared.*` (the latter reached
 *  as the composite `data` namespace below). `shared.*` is the L2 cache
 *  renamed with user-facing keys (LRU-evicted, TTL-bounded, pair-
 *  broadcast via `cache.sync_l2`). `data.shared.*` is durable SQLite +
 *  CAS-backed storage, reachable via the same `data` ref root as the
 *  existing warehouse namespaces (`data.mail.*`, `data.file.*`, etc.
 *  added in later phases). Both are written via the kernel `shared-write`
 *  ingredient and read as refs.
 *
 *  D-115 (Phase 5) added `trigger` — outputs of `trigger_steps` ingredients
 *  (minus `should_run`, which the gate consumes) surface to prefetch +
 *  sequential steps as `{{trigger.<step_id>.<field>}}`. Populated only
 *  during reactive ticks that pass the gate; manual / cron runs leave
 *  the store empty and `{{trigger.*}}` refs resolve to undefined.
 *
 *  D-120 (Phase 4) added `data.memory.*` as a first-class read-only
 *  warehouse surface. Recipes that reference `data.memory.*` must
 *  declare `requires: ['read_memory']` in their metadata (staged-trust
 *  permission gated at install). D-231 split the surfaces for good:
 *  `data.memory.*` is the owner's curated knowledge (`user_memory`,
 *  written via `memory.*` rpc + the chat `memory.write` tool) and
 *  `data.audit.*` is the run-provenance trail (`audit_entries` /
 *  `audit_activities`, gated on `read_audit`). Neither aliases the
 *  other; the validator gates each namespace on its own permission.
 *  Both are read-only at the recipe layer.
 *
 *  D-125 (Phase 1.1) added `connection` — synced outbound endpoint
 *  records (mcp / api / notification). Read-only at the recipe layer;
 *  the kernel `connection` adapter (D-125 P3, plugged into D-126's
 *  `AdapterRegistry` at `kind: 'connection'`) is the only code path
 *  that constructs calls and injects credentials. Records ref via
 *  `{{connection.<kind>.<name>.<field>}}`; auth fields are excluded
 *  from the resolver view projection.
 *
 *  D-125 (Phase 5.2) retired the `account.*` runtime + sync atomic
 *  with the ingredient migration. The `'account'` literal is preserved
 *  here as `// reserved` per spec load-bearing decision 8 — it has no
 *  runtime store, no sync transport, no resolver path; ingredients can
 *  no longer interpolate `{{account.*}}`, and the validator rejects
 *  fresh references at install. The slot may be reused for a future
 *  namespace category that doesn't fit `connection.*`.
 *
 *  D-165/D-166 added `contract` — the gateway-internal contract substrate
 *  (schema-driven storage of installed-pack/ingredient inventory, pack-owned
 *  grants, user overrides, merge-card resolutions; D-166 extends it with
 *  connection records, the channel×actor×contract_id policy matrix, preflight
 *  gate state, and contract_id lifecycle). Stored sparse-row / prefix-scan like
 *  `data.*` but **gateway-read-only**: recipes are GATED BY contract policy and
 *  never READ it, so `contract` is intentionally absent from `NS` below — the
 *  resolver does not hydrate it and the validator's NS walk rejects fresh
 *  `{{contract.*}}` references. Listed on the type as a reserved top-level
 *  prefix so the storage / inventory machinery shares the namespace vocabulary.
 *  See D-165 §"Contract namespace" +
 *  `packages/contracts/src/contract-schema.ts`. */
export type Namespace =
  | 'vault'
  | 'config'
  | 'context'
  | 'meta'
  | 'step'
  /** reserved — runtime retired in D-125 P5.2; do not re-add to NS without
   *  a new decision-log entry. */
  | 'account'
  | 'prefs'
  | 'shared'
  | 'data'
  | 'connection'
  | 'item'
  | 'trigger'
  /** reserved — gateway-internal contract substrate (D-165/D-166). Sparse-row
   *  storage like `data.*` but NOT hydrated by the resolver: deliberately absent
   *  from `NS`, so the validator rejects `{{contract.*}}` recipe refs. See the
   *  type doc comment + `contract-schema.ts`. */
  | 'contract';

/** Live namespaces the resolver hydrates. `'account'` is intentionally
 *  absent here — see the `Namespace` type comment. The validator's NS
 *  walk (`recipe_namespace_ref`) reads from this set, so dropping the
 *  membership is what gates fresh `{{account.*}}` references at install. */
export const NS = new Set<Namespace>([
  'vault', 'config', 'context', 'meta', 'step', 'prefs', 'shared', 'data', 'connection', 'item', 'trigger',
] as const);
