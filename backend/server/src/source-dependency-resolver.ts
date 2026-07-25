/** D-192 Slice 3 — source-dependency resolution.
 *
 *  Two halves of `create_if_not_picked` (D-192):
 *   - `decideDependencyResolution` — the PURE pick / create / ask / unresolved
 *     decision over the fetched options + a stored selection + an optional named
 *     target (chat "project abc"), capability-gated on whether a create is
 *     possible + authorized;
 *   - `fetchDependencyEntities` — invoke the dependency's `list_op` through the
 *     SAME gated gateway the sync runner uses (read-tier, audited), project each
 *     row to `{entity_pk, label}` via the declared `id_field`/`label_field`, and
 *     refresh the cache.
 *
 *  Recursion up the `arg_from` parent chain + the gated create branch land in
 *  Slice 5; this slice resolves ONE dependency given its (already-resolved) args. */

import type {
  ExecutionSource,
  IngredientManifest,
  PlannedDependencyCreate,
  RecipeDefinition,
  WorkEntitySourceDependency,
} from '@recued/contracts';

export type { PlannedDependencyCreate };

import {
  getByDotPath,
  runGatedCatalogOperation,
  type RunGatedCatalogOperationFn,
  type SourceMirrorFetchDeps,
} from './source-mirror/fetch.js';
import { composeWireArgs, wireTransportOf } from './work-entity-wire-body.js';
import type { SourceDependencyEntityStore } from './storage/source-dependency-entity-store.js';

// ────────────────────────────────────────────────────────────────
// Pure decision
// ────────────────────────────────────────────────────────────────

export interface DependencyOption {
  entity_pk: string;
  label: string;
}

export type DependencyResolution =
  | { kind: 'picked'; entity_pk: string; label: string }
  | { kind: 'create'; name: string }
  | { kind: 'ask'; options: DependencyOption[]; can_create: boolean }
  | { kind: 'unresolved'; reason: string };

const normalizeLabel = (s: string): string => s.trim().toLowerCase();

/** The `create_if_not_picked` decision. `createCapable` folds BOTH "a create op
 *  exists" AND (for the create branch) "the write is authorized" — the caller
 *  passes `false` when either is absent, so a create-op-less dependency is pure
 *  pick (and a lone option auto-selects). Priority: an explicit name THIS turn >
 *  a stored/default selection > the list. Label match is trimmed + case-folded
 *  EXACT (never fuzzy — no wrong auto-pick). */
export const decideDependencyResolution = (input: {
  options: readonly DependencyOption[];
  storedSelection?: DependencyOption | null;
  named?: string | null;
  createCapable: boolean;
}): DependencyResolution => {
  const { options, storedSelection, named, createCapable } = input;

  if (named !== undefined && named !== null && named.trim().length > 0) {
    const match = options.find((o) => normalizeLabel(o.label) === normalizeLabel(named));
    if (match !== undefined) return { kind: 'picked', entity_pk: match.entity_pk, label: match.label };
    if (createCapable) return { kind: 'create', name: named.trim() };
    // The named thing doesn't exist and can't be created → the user must pick.
    return { kind: 'ask', options: [...options], can_create: false };
  }

  if (storedSelection != null) {
    return { kind: 'picked', entity_pk: storedSelection.entity_pk, label: storedSelection.label };
  }

  if (options.length === 0) {
    return createCapable
      ? { kind: 'ask', options: [], can_create: true } // "no X yet — name a new one?"
      : { kind: 'unresolved', reason: 'no options and no create op' };
  }
  // Auto-select a lone option ONLY when creating isn't an alternative (the
  // "no create op & 1 option → no need to choose" rule). WITH a create op, one
  // existing option is still a genuine choice (that one, or a new one).
  if (options.length === 1 && !createCapable) {
    return { kind: 'picked', entity_pk: options[0].entity_pk, label: options[0].label };
  }
  return { kind: 'ask', options: [...options], can_create: createCapable };
};

// ────────────────────────────────────────────────────────────────
// List fetch
// ────────────────────────────────────────────────────────────────

/** Synthetic recipe identity for dependency list fetches — audited as a READ
 *  (`source-dependency-list`), never installed/executed. Mirrors the sync
 *  runner's `SOURCE_SYNC_RECIPE`. */
export const SOURCE_DEPENDENCY_RECIPE: RecipeDefinition = {
  recipe_id: 'source-dependency-list',
  version: 1,
  ttl: 0,
  metadata: {
    name: 'Source dependency list',
    description:
      'Synthetic identity for work-entity source-dependency list fetches (D-192). Not an installable recipe.',
    author: 'recued',
    supported_platforms: [],
  },
  variables: {},
  prefetch_steps: [],
  steps: [],
  output: { render: [] },
};

export interface FetchDependencyEntitiesDeps {
  fetchDeps: SourceMirrorFetchDeps;
  store: Pick<SourceDependencyEntityStore, 'replaceEntities'>;
  /** Test seam — script the gated invoke; production omits it. */
  runOperation?: RunGatedCatalogOperationFn;
}

/** D-153/D-182 caller-identity pass-through for a caller-triggered (chat)
 *  dependency invoke — threads onto the gated invoke's scoped ctx verbatim so
 *  the list read + container create audit under the user action, not the
 *  background posture. Absent (a persist sync-scope fetch) → the background
 *  `system`/`reactive` posture stands. */
export interface DependencyInvokeIdentity {
  execution_source?: ExecutionSource;
  trigger_source?: string;
  correlation_id?: string;
}

const identityFields = (
  identity: DependencyInvokeIdentity | undefined,
): DependencyInvokeIdentity =>
  identity === undefined
    ? {}
    : {
        ...(identity.execution_source !== undefined ? { execution_source: identity.execution_source } : {}),
        ...(identity.trigger_source !== undefined ? { trigger_source: identity.trigger_source } : {}),
        ...(identity.correlation_id !== undefined ? { correlation_id: identity.correlation_id } : {}),
      };

export type FetchDependencyEntitiesOutcome =
  | { ok: true; options: DependencyOption[] }
  | { ok: false; kind: 'config' | 'policy' | 'error' | 'unavailable'; reason: string };

const coerceKey = (v: unknown): string =>
  typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '';

/** Invoke one dependency's `list_op` (args already resolved — `arg_from` parent
 *  ids are supplied by the caller in Slice 5) and refresh the cache. Read-tier,
 *  gated, audited. Skips rows missing an id (honest partial — a keyless option
 *  can't be bound). */
export const fetchDependencyEntities = async (
  deps: FetchDependencyEntitiesDeps,
  input: {
    source_id: string;
    dependency: WorkEntitySourceDependency;
    connection_name: string;
    manifest: IngredientManifest;
    catalogSlug: string;
    args?: Record<string, unknown>;
    pack_slug?: string | null;
    now: number;
    /** Caller identity for a chat-triggered fetch; absent = background posture. */
    identity?: DependencyInvokeIdentity;
  },
): Promise<FetchDependencyEntitiesOutcome> => {
  const run = deps.runOperation ?? runGatedCatalogOperation;
  const { dependency, manifest } = input;

  const opRow = manifest.operations?.[dependency.list_op];
  if (opRow === undefined) {
    return { ok: false, kind: 'config', reason: `catalog declares no '${dependency.list_op}' operation for dependency '${dependency.ref}'` };
  }
  const resultPath = opRow.result_path ?? manifest.surfaces?.api?.result_path;
  if (resultPath === undefined || resultPath.length === 0) {
    return { ok: false, kind: 'config', reason: `dependency '${dependency.ref}' list op '${dependency.list_op}' declares no result_path` };
  }

  const invoked = await run(deps.fetchDeps, {
    connection_name: input.connection_name,
    manifest,
    catalogSlug: input.catalogSlug,
    operationKey: dependency.list_op,
    args: input.args ?? {},
    auditRecipe: SOURCE_DEPENDENCY_RECIPE,
    stepId: 'dependency_list',
    ...identityFields(input.identity),
  });
  if (!invoked.ok) return { ok: false, kind: invoked.kind, reason: invoked.reason };

  const arr = getByDotPath(invoked.raw, `result.${resultPath}`);
  if (!Array.isArray(arr)) {
    return { ok: false, kind: 'error', reason: `dependency '${dependency.ref}' list returned no array at 'result.${resultPath}'` };
  }

  const options: DependencyOption[] = [];
  for (const rec of arr) {
    const entity_pk = coerceKey(getByDotPath(rec, dependency.id_field));
    if (entity_pk.length === 0) continue; // unkeyable row — cannot be bound
    const labelRaw = getByDotPath(rec, dependency.label_field);
    const label = coerceKey(labelRaw).length > 0 ? coerceKey(labelRaw) : entity_pk;
    options.push({ entity_pk, label });
  }
  deps.store.replaceEntities(input.source_id, dependency.ref, options, {
    pack_slug: input.pack_slug ?? null,
    now: input.now,
  });
  return { ok: true, options };
};

// ────────────────────────────────────────────────────────────────
// Persist-mode resolution (sync-scope) — the dispatch integration
// ────────────────────────────────────────────────────────────────

/** Declaration subset the persist resolvers read. */
interface DependencyCarrier {
  source_dependencies?: readonly WorkEntitySourceDependency[];
}

export interface ResolvePersistDependenciesDeps {
  fetchDeps: SourceMirrorFetchDeps;
  store: SourceDependencyEntityStore;
  runOperation?: RunGatedCatalogOperationFn;
}

/** Resolve every `resolve: 'persist'` dependency to a selection and collect the
 *  args it binds to the LIST op — the sync runner's dispatch integration.
 *
 *  On a missing selection the list is fetched (read, gated) and — since persist
 *  deps are pick-only for the headless walk (`createCapable: false`) — a LONE
 *  option auto-selects (the common single-workspace / single-tasklist case Just
 *  Works, no user config). N options / none → a config failure the caller
 *  records on the sync-state row (the picker / chat resolves it). `arg_from`
 *  parents resolve first (declaration order), feeding their selected id into the
 *  child's list fetch. */
export const resolvePersistDependencies = async (
  deps: ResolvePersistDependenciesDeps,
  input: {
    source_id: string;
    declaration: DependencyCarrier;
    connection_name: string;
    manifest: IngredientManifest;
    catalogSlug: string;
    pack_slug?: string | null;
    now: number;
  },
): Promise<{ ok: true; listArgs: Record<string, unknown> } | { ok: false; reason: string }> => {
  const listArgs: Record<string, unknown> = {};
  const resolvedIds = new Map<string, string>(); // ref → selected id, for arg_from
  for (const dep of input.declaration.source_dependencies ?? []) {
    if (dep.resolve !== 'persist') continue;
    let sel = deps.store.getSelected(input.source_id, dep.ref);
    if (sel === null) {
      const fetchArgs: Record<string, unknown> = {};
      for (const af of dep.arg_from ?? []) {
        const parentId = resolvedIds.get(af.dependency);
        if (parentId === undefined) {
          return { ok: false, reason: `dependency '${dep.ref}' needs parent '${af.dependency}' resolved first` };
        }
        fetchArgs[af.arg] = parentId;
      }
      const fetched = await fetchDependencyEntities(deps, {
        source_id: input.source_id, dependency: dep, connection_name: input.connection_name,
        manifest: input.manifest, catalogSlug: input.catalogSlug, args: fetchArgs,
        pack_slug: input.pack_slug ?? null, now: input.now,
      });
      if (!fetched.ok) return { ok: false, reason: `dependency '${dep.ref}': ${fetched.reason}` };
      const decision = decideDependencyResolution({ options: fetched.options, createCapable: false });
      if (decision.kind !== 'picked') {
        const detail = decision.kind === 'ask'
          ? `${decision.options.length} options — pick one in Settings → Work Entities`
          : 'none available on this connection';
        return { ok: false, reason: `dependency '${dep.ref}' needs a selection (${detail})` };
      }
      deps.store.select(input.source_id, dep.ref, decision.entity_pk);
      sel = deps.store.getSelected(input.source_id, dep.ref);
      if (sel === null) return { ok: false, reason: `dependency '${dep.ref}' selection did not persist` };
    }
    resolvedIds.set(dep.ref, sel.entity_pk);
    for (const bind of dep.binds) {
      if (bind.op === 'list') listArgs[bind.arg] = sel.entity_pk;
    }
  }
  return { ok: true, listArgs };
};

/** Collect the args persist dependencies bind to the READ op, from the ALREADY-
 *  persisted selection (synchronous — the read path can't fetch/prompt; the sync
 *  cycle established the selection). A read-bound dependency with no selection
 *  config-fails the read (honest — the record can't be scoped). */
export const resolvePersistDependencyReadArgs = (
  store: Pick<SourceDependencyEntityStore, 'getSelected'>,
  source_id: string,
  declaration: DependencyCarrier,
): { ok: true; readArgs: Record<string, unknown> } | { ok: false; reason: string } => {
  const readArgs: Record<string, unknown> = {};
  for (const dep of declaration.source_dependencies ?? []) {
    if (dep.resolve !== 'persist') continue;
    const readBinds = dep.binds.filter((b) => b.op === 'read');
    if (readBinds.length === 0) continue;
    const sel = store.getSelected(source_id, dep.ref);
    if (sel === null) {
      return { ok: false, reason: `dependency '${dep.ref}' has no selection for the read op — run a sync first` };
    }
    for (const b of readBinds) readArgs[b.arg] = sel.entity_pk;
  }
  return { ok: true, readArgs };
};

/** Collect the args persist dependencies bind to a WRITE op — `create` (attribute
 *  a new record) OR a TARGETED write `update`/`delete`/`complete` (scope an
 *  existing one). The SAME stored container that scopes the sync walk also scopes
 *  a targeted write: MS To Do's task lives under a `todoTaskListId`, so its update
 *  PATCHes `/lists/{list}/tasks/{task}` — the list id must ride the write op the
 *  way it rides the list/read. Synchronous, read-only from the selection the sync
 *  cycle established; a write-bound persist dep with no selection config-fails the
 *  write BEFORE any side effect (the vendor record can't be addressed — run a sync
 *  first). One authority per arg (a second dep binding the same arg fails here,
 *  never a silent last-write-wins mis-scope — Codex MED). The prompt-mode container
 *  ids (a chat-named project) ride the separate `resolvePromptDependencies` path. */
export const resolvePersistDependencyWriteArgs = (
  store: Pick<SourceDependencyEntityStore, 'getSelected'>,
  source_id: string,
  declaration: DependencyCarrier,
  op: 'create' | 'update' | 'delete' | 'complete',
): { ok: true; args: Record<string, unknown> } | { ok: false; reason: string } => {
  const args: Record<string, unknown> = {};
  for (const dep of declaration.source_dependencies ?? []) {
    if (dep.resolve !== 'persist') continue;
    const opBinds = dep.binds.filter((b) => b.op === op);
    if (opBinds.length === 0) continue;
    const sel = store.getSelected(source_id, dep.ref);
    if (sel === null) {
      return { ok: false, reason: `dependency '${dep.ref}' has no selection for the ${op} op — run a sync first` };
    }
    for (const b of opBinds) {
      if (Object.prototype.hasOwnProperty.call(args, b.arg)) {
        return { ok: false, reason: `${op} op arg '${b.arg}' is bound by more than one persist dependency — one authority per arg` };
      }
      // `wrap_array` binds an array-typed vendor arg — the resolved id flows as a
      // single-element array (the write executor's composer nests it verbatim).
      args[b.arg] = b.wrap_array === true ? [sel.entity_pk] : sel.entity_pk;
    }
  }
  return { ok: true, args };
};

/** CREATE-slot persist args — the `resolvePersistDependencyWriteArgs('create')`
 *  case under its historical name + `{ createArgs }` return, so the create dispatch
 *  site stays byte-identical. */
export const resolvePersistDependencyCreateArgs = (
  store: Pick<SourceDependencyEntityStore, 'getSelected'>,
  source_id: string,
  declaration: DependencyCarrier,
): { ok: true; createArgs: Record<string, unknown> } | { ok: false; reason: string } => {
  const resolved = resolvePersistDependencyWriteArgs(store, source_id, declaration, 'create');
  return resolved.ok ? { ok: true, createArgs: resolved.args } : resolved;
};

// ────────────────────────────────────────────────────────────────
// Prompt-mode resolution (create-assist) — the `create_if_not_picked`
// recursive create branch (Slice 5)
// ────────────────────────────────────────────────────────────────

/** `PlannedDependencyCreate` — the decided-but-unexecuted container create — is a
 *  contract type (`@recued/contracts`, re-exported above) so it rides the create-
 *  plan `notification.ask` payload across the engine seam. */

/** The outcome of resolving ONE prompt dependency (and its `arg_from` parents). */
export type PromptDependencyResolution =
  | { kind: 'resolved'; ref: string; entity_pk: string; label: string }
  /** DECIDE-then-execute (Slice 6c): the named container doesn't exist and a
   *  create is authorized → a PLANNED create, NOT yet executed. The caller
   *  confirms the plan (one create-plan ask) then executes it. No side effect. */
  | { kind: 'plan'; ref: string; plan: PlannedDependencyCreate }
  /** An ambiguous pick (or a required name still missing) — bubbles to the chat
   *  surface as a `notification.ask` (Slice 6). Carries the choice set + (S4) the
   *  container's resolved create op id, so the surface can grant-check it. */
  | { kind: 'ask'; ref: string; options: DependencyOption[]; can_create: boolean; create_op?: string }
  | { kind: 'unresolved'; ref: string; reason: string };

export interface ResolvePromptDependencyDeps {
  fetchDeps: SourceMirrorFetchDeps;
  store: SourceDependencyEntityStore;
  runOperation?: RunGatedCatalogOperationFn;
}

/** The shared context one prompt-resolution pass runs over. */
export interface PromptResolveContext {
  source_id: string;
  declaration: DependencyCarrier;
  connection_name: string;
  manifest: IngredientManifest;
  catalogSlug: string;
  /** Per-dependency-ref caller-named target ("project Roadmap") — drives the
   *  label-match / create decision. */
  named?: Record<string, string>;
  /** Per-create-op authorization gate for the create branch (Slice 6c Part 3-A) —
   *  the predicate answers "is this container's `create_op` granted?" (the op ∈ the
   *  connection's `allowed_operations`). Per-op (not a global bool) so a turn
   *  resolving several prompt deps authorizes each container's create
   *  independently. Absent (the default) makes every container pick-only. The
   *  gateway stays the actual enforcer — this is the ergonomic pre-check that
   *  degrades an ungranted create to pick-only rather than planning a create the
   *  gate would refuse. */
  isCreateAuthorized?: (createOp: string) => boolean;
  pack_slug?: string | null;
  now: number;
  /** Caller identity threaded onto every gated invoke (list read + container
   *  create) so the create-assist reads/writes audit under the user action. */
  identity?: DependencyInvokeIdentity;
}

const findDependency = (
  declaration: DependencyCarrier,
  ref: string,
): WorkEntitySourceDependency | undefined =>
  (declaration.source_dependencies ?? []).find((d) => d.ref === ref);

/** PLAN a dependency's create (the PURE half of `create_if_not_picked` — Slice 6c
 *  decide-then-execute). Composes the create-op wire args (the resolved parent-
 *  attribute args + the new name) through the SHARED composer — a REST container
 *  create nests its body 2-level (Asana `project.create` takes `body.data.workspace`
 *  + `body.data.name`) exactly the way the write executor composes the task create,
 *  so the two paths can never drift. A `create_name_arg` that collides with an
 *  `arg_from.create_arg` is an authoring error (name vs parent id under one wire
 *  key) the composer refuses BEFORE any plan — dropping the parent attribution
 *  would orphan the new container. NO side effect: the gated WRITE is deferred to
 *  `executePlannedCreate` (after the user confirms the plan). */
const planDependencyCreate = (
  ctx: PromptResolveContext,
  dep: WorkEntitySourceDependency,
  parentCreateArgs: Record<string, unknown>,
  name: string,
): { ok: true; plan: PlannedDependencyCreate } | { ok: false; reason: string } => {
  if (dep.create_op === undefined || dep.create_name_arg === undefined) {
    return { ok: false, reason: `dependency '${dep.ref}' has no create op` };
  }
  const opRow = ctx.manifest.operations?.[dep.create_op];
  if (opRow === undefined) {
    return { ok: false, reason: `catalog declares no '${dep.create_op}' operation for dependency '${dep.ref}'` };
  }
  // The create response envelope must be EXPLICIT on the create op — no fallback
  // to the manifest-level `surfaces.api.result_path` (the LIST envelope). A create
  // response can be a different shape than a list row; reading the list path from a
  // create response would find no id, report a failure, and invite a duplicate
  // container on retry even though the first create SUCCEEDED (Codex MED).
  const resultPath = opRow.result_path;
  if (resultPath === undefined || resultPath.length === 0) {
    return { ok: false, reason: `dependency '${dep.ref}' create op '${dep.create_op}' declares no result_path — a create response envelope must be explicit` };
  }
  const transport = wireTransportOf(ctx.manifest, dep.create_op);
  const composed = composeWireArgs(
    [...Object.entries(parentCreateArgs), [dep.create_name_arg, name] as const],
    transport,
  );
  if (!composed.ok) {
    return { ok: false, reason: `dependency '${dep.ref}' create args: ${composed.reason}` };
  }
  return {
    ok: true,
    plan: {
      ref: dep.ref,
      create_op: dep.create_op,
      name,
      args: composed.args,
      result_path: resultPath,
      id_field: dep.id_field,
    },
  };
};

/** EXECUTE a planned dependency create (the SIDE-EFFECTING half) — the gated WRITE
 *  + id extraction. The created id sits at the create op's `result_path` under
 *  `id_field` (a container's create response and read rows share their native id
 *  field; Asana `project.create` returns `{ data: { gid, name } }`). Run ONCE, on
 *  approval, after the user confirmed the plan; the caller persists the id as the
 *  Source's stored selection so the re-run auto-resolves it. */
export const executePlannedCreate = async (
  deps: ResolvePromptDependencyDeps,
  ctx: Pick<PromptResolveContext, 'connection_name' | 'manifest' | 'catalogSlug' | 'identity'>,
  plan: PlannedDependencyCreate,
): Promise<{ ok: true; entity_pk: string } | { ok: false; reason: string }> => {
  const run = deps.runOperation ?? runGatedCatalogOperation;
  const invoked = await run(deps.fetchDeps, {
    connection_name: ctx.connection_name,
    manifest: ctx.manifest,
    catalogSlug: ctx.catalogSlug,
    operationKey: plan.create_op,
    args: plan.args,
    auditRecipe: SOURCE_DEPENDENCY_RECIPE,
    stepId: 'dependency_create',
    // The create-plan confirm the user just answered WAS this create's human
    // approval — admit past the create op's `ask` gate (it would otherwise degrade
    // to a policy-fail on this run-less spine and the approved plan would do
    // nothing). `executePlannedCreate` runs ONLY post-confirm, so this is always
    // authorized; a policy `deny` still blocks (admission never bypasses deny).
    preflight_admitted: true,
    ...identityFields(ctx.identity),
  });
  if (!invoked.ok) return { ok: false, reason: invoked.reason };
  const record = getByDotPath(invoked.raw, `result.${plan.result_path}`);
  const entity_pk = coerceKey(getByDotPath(record, plan.id_field));
  if (entity_pk.length === 0) {
    return { ok: false, reason: `create '${plan.create_op}' response carried no id at 'result.${plan.result_path}.${plan.id_field}'` };
  }
  return { ok: true, entity_pk };
};

/** Resolve ONE prompt dependency (`create_if_not_picked`), recursive up
 *  `arg_from`. Resolves each parent FIRST (a stored selection, else — for a
 *  `prompt` parent — recursively), threading the resolved id into BOTH the leaf's
 *  list fetch (`arg_from.arg`) and its create call (`arg_from.create_arg ?? arg`
 *  — a vendor's list + create name the parent under different wire keys). Then
 *  fetches the choice list, DECIDES (`decideDependencyResolution`), and on a
 *  `create` verdict invokes the gated `create_op`. `ask` / `unresolved` bubble
 *  up (an ambiguous parent stops the child before it runs). `resolvedIds`
 *  memoizes across the pass; `resolving` guards a cyclic chain (defense — the
 *  validator already rejects cycles). */
export const resolvePromptDependency = async (
  deps: ResolvePromptDependencyDeps,
  ctx: PromptResolveContext,
  ref: string,
  resolvedIds: Map<string, string> = new Map(),
  resolving: Set<string> = new Set(),
): Promise<PromptDependencyResolution> => {
  if (resolving.has(ref)) {
    return { kind: 'unresolved', ref, reason: `cyclic arg_from chain through '${ref}'` };
  }
  const dep = findDependency(ctx.declaration, ref);
  if (dep === undefined) {
    return { kind: 'unresolved', ref, reason: `no dependency declared with ref '${ref}'` };
  }
  resolving.add(ref);

  // Resolve arg_from parents → the list-scope + create-scope arg maps.
  const listArgs: Record<string, unknown> = {};
  const createArgs: Record<string, unknown> = {};
  for (const af of dep.arg_from ?? []) {
    let parentId = resolvedIds.get(af.dependency);
    if (parentId === undefined) {
      const parentDep = findDependency(ctx.declaration, af.dependency);
      if (parentDep === undefined) {
        resolving.delete(ref);
        return { kind: 'unresolved', ref, reason: `parent '${af.dependency}' is not a declared dependency` };
      }
      const stored = deps.store.getSelected(ctx.source_id, af.dependency);
      if (stored !== null) {
        parentId = stored.entity_pk;
      } else if (parentDep.resolve === 'prompt') {
        const parentRes = await resolvePromptDependency(deps, ctx, af.dependency, resolvedIds, resolving);
        if (parentRes.kind === 'plan') {
          // The parent itself needs creating — a nested container-create chain.
          // One plan can't thread a not-yet-created parent id into this child's
          // create args; decide-then-execute is single-level for now (Asana's
          // project parent is a stored persist workspace, never a plan).
          resolving.delete(ref);
          return { kind: 'unresolved', ref, reason: `parent '${af.dependency}' needs creating first — nested container creation is not supported in one plan` };
        }
        if (parentRes.kind !== 'resolved') {
          resolving.delete(ref);
          return parentRes; // bubble the ask/unresolved verbatim
        }
        parentId = parentRes.entity_pk;
      } else {
        resolving.delete(ref);
        return { kind: 'unresolved', ref, reason: `parent '${af.dependency}' has no selection — run a sync first` };
      }
      resolvedIds.set(af.dependency, parentId);
    }
    listArgs[af.arg] = parentId;
    createArgs[af.create_arg ?? af.arg] = parentId;
  }
  resolving.delete(ref);

  const fetched = await fetchDependencyEntities(
    { fetchDeps: deps.fetchDeps, store: deps.store, ...(deps.runOperation ? { runOperation: deps.runOperation } : {}) },
    {
      source_id: ctx.source_id, dependency: dep, connection_name: ctx.connection_name,
      manifest: ctx.manifest, catalogSlug: ctx.catalogSlug, args: listArgs,
      pack_slug: ctx.pack_slug ?? null, now: ctx.now,
      ...(ctx.identity ? { identity: ctx.identity } : {}),
    },
  );
  if (!fetched.ok) return { kind: 'unresolved', ref, reason: fetched.reason };

  // A create is only reachable for a NAMED container that doesn't match — you
  // can't create a container you haven't named. So `createCapable` requires BOTH a
  // granted `create_op` AND a name for this dep; without a name the flow stays
  // pick-only (a lone option auto-picks — zero-config — an ambiguous set asks).
  // This also keeps an UNNAMED create preflight pick-only until the create-plan
  // confirmation path is wired: grant-driving createCapable alone would suppress
  // the lone-option auto-pick and stop a zero-config create at an avoidable picker
  // (Codex P2).
  const namedTarget = ctx.named?.[ref];
  const hasName = namedTarget !== undefined && namedTarget.trim().length > 0;
  const createCapable =
    dep.create_op !== undefined
    && ctx.isCreateAuthorized?.(dep.create_op) === true
    && hasName;
  const stored = deps.store.getSelected(ctx.source_id, ref);
  const decision = decideDependencyResolution({
    options: fetched.options,
    storedSelection: stored !== null ? { entity_pk: stored.entity_pk, label: stored.label } : null,
    named: ctx.named?.[ref] ?? null,
    createCapable,
  });

  if (decision.kind === 'picked') {
    return { kind: 'resolved', ref, entity_pk: decision.entity_pk, label: decision.label };
  }
  if (decision.kind === 'ask') {
    // S4 — carry the container's RESOLVED create op id (if the dependency declares
    // one) so the chat catch site can grant-check it against the acting contract
    // and tell the agent whether it may create a NEW container vs. pick-only. Same
    // short-key → operation_id resolution `tryFastTrackCreatePlan` uses.
    const createOpId =
      dep.create_op !== undefined
        ? ctx.manifest.operations?.[dep.create_op]?.operation_id ?? dep.create_op
        : undefined;
    return {
      kind: 'ask',
      ref,
      options: decision.options,
      can_create: decision.can_create,
      ...(createOpId !== undefined ? { create_op: createOpId } : {}),
    };
  }
  if (decision.kind === 'unresolved') {
    return { kind: 'unresolved', ref, reason: decision.reason };
  }
  // create — DECIDE only (Slice 6c): plan the container create; the caller confirms
  // one create-plan ask, then `executePlannedCreate` runs the gated WRITE. No side
  // effect here (safe to re-run — the plan recomputes idempotently on resume).
  const planned = planDependencyCreate(ctx, dep, createArgs, decision.name);
  if (!planned.ok) return { kind: 'unresolved', ref, reason: planned.reason };
  return { kind: 'plan', ref, plan: planned.plan };
};

/** One ambiguous prompt dependency needing a choice (the chat `notification.ask`
 *  payload). */
export interface PromptDependencyAsk {
  ref: string;
  options: DependencyOption[];
  can_create: boolean;
  /** S4 — the RESOLVED `operation_id` of the container's create op, if the
   *  dependency declares one. Threaded onto the `ContainerPickDetail` carrier so
   *  the chat catch site can grant-check "may this contract create a new one?". */
  create_op?: string;
  /** S4 fold — the RESOLVED `operation_id` of the TARGET write (the task/note/
   *  project create the agent is doing). Set by the EXECUTOR (which resolves the
   *  write context), not the resolver. The chat catch site requires BOTH this AND
   *  `create_op` granted before promising the one-step create — the fast-track
   *  admits the whole plan (target write + each container create), so an accurate
   *  "you may create a new container" copy must check both. */
  target_write_op?: string;
}

export type ResolvePromptDependenciesOutcome =
  | {
      ok: true;
      /** Args each RESOLVED (picked) container binds to the write op. Populated
       *  only for containers that already exist; a PLANNED container contributes
       *  nothing here (its id is unknown until executed). */
      createArgs: Record<string, unknown>;
      /** Containers the resolver DECIDED to create but has NOT executed (Slice 6c).
       *  Non-empty ⇒ the write cannot dispatch yet: the caller surfaces ONE create-
       *  plan confirm, executes the plan, then re-runs (the created containers now
       *  resolve as picks). */
      plannedCreates: PlannedDependencyCreate[];
    }
  /** The FIRST ambiguous dependency — the caller resolves it (a `notification.ask`
   *  choice, re-run with a `named` entry) then calls again. One ask per turn. */
  | { ok: false; kind: 'ask'; ask: PromptDependencyAsk }
  | { ok: false; kind: 'unresolved'; reason: string };

/** Resolve every `resolve: 'prompt'` dependency that binds the given write
 *  `operation` (default `create`) and collect the args each binds to it — the
 *  create-assist dispatch integration. DECIDE-only (Slice 6c): a container that
 *  needs creating is returned as a PLAN (never executed here). On the first
 *  ambiguous dependency it returns the ask (never fetches further); on an
 *  unresolvable one, the reason. A prompt dep that binds only OTHER write ops is
 *  skipped for this operation (its container is resolved when THAT op runs). */
export const resolvePromptDependencies = async (
  deps: ResolvePromptDependencyDeps,
  ctx: PromptResolveContext,
  operation: 'create' | 'update' | 'delete' | 'complete' = 'create',
): Promise<ResolvePromptDependenciesOutcome> => {
  const createArgs: Record<string, unknown> = {};
  const plannedCreates: PlannedDependencyCreate[] = [];
  const resolvedIds = new Map<string, string>();
  for (const dep of ctx.declaration.source_dependencies ?? []) {
    if (dep.resolve !== 'prompt') continue;
    const opBinds = dep.binds.filter((b) => b.op === operation);
    if (opBinds.length === 0) continue; // not for this operation
    const res = await resolvePromptDependency(deps, ctx, dep.ref, resolvedIds);
    if (res.kind === 'ask') {
      return {
        ok: false,
        kind: 'ask',
        ask: {
          ref: res.ref,
          options: res.options,
          can_create: res.can_create,
          ...(res.create_op !== undefined ? { create_op: res.create_op } : {}),
        },
      };
    }
    if (res.kind === 'unresolved') {
      return { ok: false, kind: 'unresolved', reason: `dependency '${res.ref}': ${res.reason}` };
    }
    if (res.kind === 'plan') {
      // Decided-but-not-executed: collect the plan, bind no arg (the id is unknown
      // until `executePlannedCreate` runs on approval). The caller surfaces the
      // create-plan confirm; the re-run resolves this container as a pick.
      plannedCreates.push(res.plan);
      continue;
    }
    resolvedIds.set(dep.ref, res.entity_pk);
    for (const bind of opBinds) {
      // One authority per create arg — a second prompt dep binding the same arg
      // would silently overwrite (Codex MED); fail before the executor merge.
      if (Object.prototype.hasOwnProperty.call(createArgs, bind.arg)) {
        return { ok: false, kind: 'unresolved', reason: `create op arg '${bind.arg}' is bound by more than one prompt dependency — one authority per arg` };
      }
      // `wrap_array` binds an array-typed vendor arg (Asana `body.data.projects`)
      // — one resolved id flows as a single-element array.
      createArgs[bind.arg] = bind.wrap_array === true ? [res.entity_pk] : res.entity_pk;
    }
  }
  return { ok: true, createArgs, plannedCreates };
};
