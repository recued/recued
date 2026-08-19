/** D-174 delta 3 — the SMALL single-contract grant view (Ops + Entities).
 *
 *  The contracts route's detail page renders ONE contract at a time, so this is
 *  the per-contract slice of the former global grant-matrix panel (retired in
 *  delta 4): the same entry universe + `effective()` derivation + risk-badge +
 *  write-then-
 *  reconcile toggle, but for a SINGLE contract and with NO by-entry pivot, NO
 *  all-contracts loop, NO expand/collapse, NO door-type axis (the header owns
 *  the L1 door control). The global panel's bulk was the bundled multi-surface
 *  chrome, not the row loop — so a few hundred lines suffice (R-decision 1).
 *
 *  ── Two kept-alive roots, one load ───────────────────────────────────────
 *  The route mounts Ops and Entities as SEPARATE tabs, but both read the SAME
 *  loaded state. So this mount owns TWO root elements — {@link opsRoot}
 *  (op-kind entries) + {@link entitiesRoot} (collection + topic entries) — and
 *  renders into both on every state change. The route attaches whichever tab is
 *  active (mirroring the Connect tab's `ensureConnectHost` keep-alive), so a
 *  switch never reloads and a just-toggled cell stays correct across tabs.
 *
 *  ── The salvaged derivation (DO NOT drift from the gate) ──────────────────
 *  Reads return EXPLICIT stored rows only; an entry with no row resolves to its
 *  AUTHOR DEFAULT at the gate. So the effective on/off is a JOIN: enumerate
 *  every entry from the registry universe, then overlay the explicit rows, and
 *  resolve the per-(entry × contract) default through `ownerOnlyAdjustedAuthor
 *  Default` (the slice-3b owner-only sensitive surfaces read ON for the owner /
 *  `user_self` and OFF for a door). Self is JUST ANOTHER CONTRACT: it loads
 *  through the same `contract.grant.read` (its `user_self` rows are reconcile-
 *  seeded `granted:true` — D-187 `owner-grant-reconcile.ts`), no special chrome.
 *
 *  ── Type home ─────────────────────────────────────────────────────────────
 *  This module OWNS the grant-rpc caller type family (the route + bootstrap
 *  import them from here). Delta 4 retired the former global grant-matrix panel
 *  (which had held structurally-identical copies) and repointed the imports here.
 *
 *  Spec: D-187 AMENDMENT §6; handover
 *  `handover_contracts_list_detail_NEXT.md` (delta 3). */

import {
  KERNEL_OP_REGISTRY,
  OWNER_CONTRACT_ID,
  PEER_ASK_LABEL_MAX,
  READABLE_COLLECTIONS,
  TIER1_TOOL_DESCRIPTORS,
  TIER1_TOOL_NAMES,
  collectionGrantEntry,
  recipeGrantEntry,
  opGrantEntry,
  parseGrantEntry,
  peerLabelGrantEntry,
  primitiveGrantEntry,
  topicGrantEntry,
  type CatalogIngredientView,
  type CliReachabilityListResponse,
  type CliReachabilitySetRequest,
  type CliReachabilitySetResponse,
  type ContractDefinitionView,
  type EnrichmentTopic,
  type GrantEntryKind,
  type RegistryDescribeRpcOutput,
  type SetContractDoorTypesRequest,
} from '@recued/contracts';

// R3 — the cell derivation + the catalog-op universe slice are SHARED with
// the by-PACK access view (`settings/pack-access-controls.ts`) via
// `grant-op-universe.ts`, so the two axes of the one grant matrix resolve a
// cell identically. This panel keeps the kernel / collection / topic universe
// slices (the by-PACK view doesn't range over them).
import {
  catalogOpUniverseEntries,
  cliRowKey,
  cliRowsForPrincipal,
  effectiveGrantState,
  hasExplicitGrant,
  type GrantUniverseEntry,
} from './grant-op-universe.js';
import type { BroadcastSubscriber } from '../realtime/subscriber.js';
import { humanizeRpcError } from '../shell/rpc-error-copy.js';

export type { GrantUniverseEntry } from './grant-op-universe.js';

// ════════════════════════════════════════════════════════════════
// Caller seams — the frozen grant rpc + the two registry universes
// ════════════════════════════════════════════════════════════════

/** One explicit grant row in a contract's set (`contract.grant.read`). */
export interface GrantEntryRow {
  entry_key: string;
  granted: boolean;
  set_at: number;
}

/** One explicit grant row in an entry's column (`contract.grant.read_by_entry`).
 *  Unused by this single-contract view; declared here as the family's home so
 *  the route's options interface keeps a stable import after delta 4. */
export interface GrantContractRow {
  contract_id: string;
  granted: boolean;
  set_at: number;
}

/** `contract.grant.read` — a contract's explicit grant rows. */
export type GrantReadCaller = (args: {
  contract_id: string;
}) => Promise<{ grants: ReadonlyArray<GrantEntryRow> }>;

/** `contract.grant.read_by_entry` — the transpose column. Unused here (kept on
 *  the route's options interface; the by-entry pivot retired with the global
 *  panel). */
export type GrantReadByEntryCaller = (args: {
  entry_key: string;
}) => Promise<{ contracts: ReadonlyArray<GrantContractRow> }>;

/** `contract.grant.write` — grant (`true`) / revoke (`false`) / clear (`null`)
 *  one entry for one contract. */
export type GrantWriteCaller = (args: {
  contract_id: string;
  entry_key: string;
  granted: boolean | null;
}) => Promise<{ ok: true; granted: boolean | null }>;

/** `collection.contract.listContracts` — the contract rows. Unused here (single
 *  contract); kept on the route's options interface. */
export type GrantContractsCaller = () => Promise<{
  contracts: ReadonlyArray<ContractDefinitionView>;
}>;

/** `collection.contract.listCatalogOperations` — the pack-op universe. */
export type GrantCatalogOperationsCaller = () => Promise<{
  ingredients: ReadonlyArray<CatalogIngredientView>;
}>;

/** D-247 D8/D11 — `recipe.list`, the recipe half of the grant UNIVERSE.
 *
 *  ⛔⛔ WITHOUT THIS THE `recipe` KIND IS A PERMISSION WITH NO WAY TO REACH IT.
 *  The seed writes a `recipe.*` row per installed recipe and the gate reads it,
 *  but nothing put those keys on the page — so the owner could not see, let alone
 *  toggle, the axis D-247 exists to give them. `buildUniverse`'s own doc states
 *  the rule this violated: *"A registry seeded there but missing here is a
 *  permission that exists in the store with no way to reach it. Add to both, or
 *  to neither."* */
export type GrantRecipeListCaller = () => Promise<{
  recipes: ReadonlyArray<{
    recipe_id: string;
    publisher_id: string;
    source: 'bundled' | 'pair-sync' | 'inline';
    recipe: { metadata?: { name?: string; description?: string } | undefined };
  }>;
}>;

/** D-247 D11 — `contract.recipeOpUsage`. BOTH halves of the op row in one round
 *  trip: the STATIC "which recipes could reach this op" and the ACTUAL "which runs
 *  did, and under whose coverage".
 *
 *  ⛔ ONE call, not two. The row puts them side by side, so two fetches could
 *  describe two different moments and the row would contradict itself on screen.
 *
 *  ⛔ `window_days` COMES BACK AND THE COPY MUST USE IT. `data.audit` is quota'd
 *  and evicts oldest-first, so `count: 0` means NOT IN THE RETAINED WINDOW, never
 *  "never used". `underivable` names recipes whose closure could not be derived,
 *  so their absence from `could` is UNKNOWN rather than "does not use it". */
export type GrantRecipeOpUsageCaller = (args: {
  window_days?: number;
}) => Promise<{
  operations: ReadonlyArray<{
    operation_id: string;
    could: readonly string[];
    count: number;
    recipes: readonly string[];
  }>;
  window_days: number;
  oldest_scanned_at: number | null;
  underivable: readonly string[];
}>;

/** `housekeeping.registry.describe` — the topic universe (+ `mcp_exposed`). */
export type GrantRegistryDescribeCaller = () => Promise<RegistryDescribeRpcOutput>;

/** `collection.contract.setDoorTypes` — REPLACE a door's level-1 `door_types`
 *  in place. Returns the updated contract row. Consumed by the route HEADER (the
 *  L1 door control), not this panel; declared here as the family's home. */
export type GrantSetDoorTypesCaller = (
  args: SetContractDoorTypesRequest,
) => Promise<ContractDefinitionView>;

/** `cli.reachability.list` — every cli reachability row across all principals;
 *  the panel filters to its own contract. CLI ops' admission is the SEPARATE
 *  `cli_reachability` allowlist (fail-closed), NOT the `contract_grant` op axis
 *  (D-182 §7.2) — so a cli op reads its effective state here, never from
 *  `contract.grant.read`. Optional: absent ⇒ cli ops render off + inert. */
export type GrantCliReachabilityListCaller = () => Promise<CliReachabilityListResponse>;
/** `cli.reachability.set` — grant/revoke ONE (principal × cli-ingredient × op)
 *  reachability row. The panel writes `principal = contractId` (the self
 *  contract's id IS `user_self` = the owner cli principal, so no mapping). */
export type GrantCliReachabilitySetCaller = (
  args: CliReachabilitySetRequest,
) => Promise<CliReachabilitySetResponse>;

// ════════════════════════════════════════════════════════════════
// The entry universe
// ════════════════════════════════════════════════════════════════

/** Build the entry universe for the two tabs. Ops span the compiled-in kernel
 *  registry (`core.*`), the Tier-1 chat primitives (`primitive.*` — D-228 slice
 *  5), and the installed pack catalog; entities span the static readable
 *  collections + the topic registry. Each dynamic source is optional — a
 *  missing/failed one drops its slice; kernel ops, primitives and collections are
 *  compiled in and always present. (Salvaged from the former global grant-matrix
 *  panel's `buildUniverse`.)
 *
 *  ⚠ THE UNIVERSE IS THE UI HALF OF "DB = UI". `owner-grant-reconcile.ts` seeds
 *  one `granted:true` row per compiled-in id, and this function decides what a
 *  human can see and toggle. A registry seeded there but missing here is a
 *  permission that exists in the store with no way to reach it — which is what
 *  the primitives were until this slice. Add to both, or to neither. */
const buildUniverse = (
  catalog: { ingredients: ReadonlyArray<CatalogIngredientView> } | undefined,
  registry: RegistryDescribeRpcOutput | undefined,
  /** D-247 — installed recipes. Absent/failed ⇒ the recipe slice is empty, like
   *  every other dynamic source here. */
  recipes: Awaited<ReturnType<GrantRecipeListCaller>> | undefined,
): GrantUniverseEntry[] => {
  const entries: GrantUniverseEntry[] = [];

  for (const k of KERNEL_OP_REGISTRY) {
    let entry_key: string;
    try {
      entry_key = opGrantEntry(k.op);
    } catch {
      continue;
    }
    entries.push({
      entry_key,
      kind: 'op',
      label: k.op,
      group: ['Kernel', k.domain].join(' · '),
      risk_tier: k.risk,
      authorDefault: k.risk === 'read',
    });
  }

  // ⛔⛔ D-228 slice 5 — the Tier-1 chat primitives (`primitive.<tool>`).
  //
  // These were MISSING from every universe: the catalog slice below is derived
  // from installed ingredient catalogs, and a primitive is an engine handler,
  // not an ingredient op — so `mail.search` / `contact.search` / `recipe.run`
  // could never appear here at all. Two consequences, both now fixed:
  //
  //   1. DB = UI was BROKEN in one direction. `reconcileOwnerGrants` seeds a
  //      `granted:true` row per primitive, and this panel is what the reconcile
  //      means by "the owner's grant rows mirror the UI 1:1". Rows the UI cannot
  //      render are rows the owner cannot revoke — a permission that exists in
  //      the store and nowhere a human can reach it.
  //   2. A contract could not be MINTED with them. `collection.contract.mint`
  //      folds `scope.operation_ids` into explicit grant rows via `opGrantEntry`,
  //      which accepts a `primitive.` id fine — the mint was never the blocker.
  //      Nothing simply told the minter these ids existed.
  //
  // ⚠ `authorDefault` comes from `TIER1_TOOL_DESCRIPTORS`, never from the name.
  // `memory.write` and `recipe.run` are classified `unknown` (not `write`)
  // deliberately — see the descriptor doc — so the read-vs-not test is the
  // honest one here, and reading a classification is not the same as guessing
  // from a `.write` suffix.
  for (const name of TIER1_TOOL_NAMES) {
    const descriptor = TIER1_TOOL_DESCRIPTORS[name];
    entries.push({
      entry_key: primitiveGrantEntry(name),
      kind: 'op',
      label: name,
      group: 'Assistant · always-on tools',
      risk_tier: descriptor.classification === 'read' ? 'read' : 'write',
      authorDefault: descriptor.classification === 'read',
    });
  }

  // The installed-pack-catalog op slice — shared with the by-PACK view.
  entries.push(...catalogOpUniverseEntries(catalog?.ingredients ?? []));

  // ── D-247 — THE RECIPE SLICE ────────────────────────────────────────────
  //
  // ⛔ `authorDefault: false` FOR EVERY RECIPE, and that is the one inverted
  // default in the whole grant model (D7). Every other kind here is
  // owner-permissive; `recipe` is not, because what it gates is CATALOG
  // MEMBERSHIP and the corpus is thousands of recipes at ~160 tok/entry. The
  // seed writes an explicit row per recipe at install, so in practice a cell
  // reads its stored value — this default governs only a recipe that reached the
  // store without one, and closed is the honest answer there.
  //
  // ⚠ KERNEL recipes are excluded: `metadata.author === 'recued'` is
  // runtime-bundled implementation detail, invisible in the marketplace and
  // filtered out of the Tier-2 catalog, so a switch for one would toggle
  // something the owner can never see the effect of.
  for (const r of recipes?.recipes ?? []) {
    if (r.publisher_id === 'recued') continue;
    entries.push({
      entry_key: recipeGrantEntry(r.publisher_id, r.recipe_id),
      kind: 'recipe',
      label: r.recipe.metadata?.name?.trim() || r.recipe_id,
      group: `${r.publisher_id} · recipes`,
      authorDefault: false,
      ...(r.recipe.metadata?.description
        ? { description: r.recipe.metadata.description }
        : {}),
    });
  }

  for (const collection of READABLE_COLLECTIONS) {
    entries.push({
      entry_key: collectionGrantEntry(collection),
      kind: 'collection',
      label: collection,
      group: '',
      // D-187 slice 5 (codex HIGH) — match the BACKEND collection read-fence default:
      // `read-grant-checker.ts isCollectionReadGranted` resolves a no-row collection to
      // `isCollectionReadAdmissible(c, ALL)` = TRUE (the documented D-177 admit-all-then-
      // narrow posture, fail-closed-backstopped by the per-tool read-tool grant; the
      // per-collection revoke is the opt-in narrowing). `effective()` runs the SAME
      // `ownerOnlyAdjustedAuthorDefault` the gate does, so raw webhook and free-form
      // response collections still show OFF for a non-owner door
      // (owner-default-only). A hardcoded `false` here made the UI
      // report mail/calendar/etc as un-granted while the gate admitted them.
      authorDefault: true,
    });
  }

  for (const t of registry?.topics ?? []) {
    entries.push({
      entry_key: topicGrantEntry(t.topic as EnrichmentTopic),
      kind: 'topic',
      label: t.topic,
      group: '',
      description: t.description,
      authorDefault: t.mcp_exposed === 'public',
    });
  }

  return entries;
};

// ════════════════════════════════════════════════════════════════
// Attribute constants — stable hooks for tests + the route
// ════════════════════════════════════════════════════════════════

/** Each kept-alive root. Carries `data-grant-view` (`ops` / `entities`). */
export const CONTRACT_GRANTS_HOST_ATTR = 'data-recued-contract-grants';
export const CONTRACT_GRANTS_LOADING_ATTR = 'data-recued-contract-grants-loading';
export const CONTRACT_GRANTS_EMPTY_ATTR = 'data-recued-contract-grants-empty';
export const CONTRACT_GRANTS_ERROR_ATTR = 'data-recued-contract-grants-error';
/** The "N of M granted" summary for a tab. */
export const CONTRACT_GRANTS_SUMMARY_ATTR = 'data-recued-contract-grants-summary';
/** Debounced type-along filter for the operation universe. */
export const CONTRACT_GRANTS_OP_FILTER_ATTR = 'data-recued-contract-grants-op-filter';
/** Visible match count / debounce status beside the operation filter. */
export const CONTRACT_GRANTS_OP_FILTER_STATUS_ATTR =
  'data-recued-contract-grants-op-filter-status';
export const CONTRACT_GRANTS_PEER_LABEL_INPUT_ATTR =
  'data-recued-contract-grants-peer-label-input';
export const CONTRACT_GRANTS_PEER_LABEL_ADD_ATTR =
  'data-recued-contract-grants-peer-label-add';
export const CONTRACT_GRANTS_PEER_LABEL_ERROR_ATTR =
  'data-recued-contract-grants-peer-label-error';
/** One kind sub-group (Operations / Collections / Topics). Carries `data-kind`. */
export const CONTRACT_GRANTS_KIND_GROUP_ATTR = 'data-recued-contract-grants-kind';
/** One toggle-able grant cell. Carries `data-entry` / `data-kind` /
 *  `data-effective` (`on`/`off`) / `data-source` (`explicit`/`default`). */
export const CONTRACT_GRANTS_CELL_ATTR = 'data-recued-contract-grants-cell';
/** The cell's checkbox. Carries the same `data-*` as its cell row. */
export const CONTRACT_GRANTS_CELL_TOGGLE_ATTR = 'data-recued-contract-grants-cell-toggle';
/** Retired compatibility hook. Contract rows render Access only. */
export const CONTRACT_GRANTS_RISK_ATTR = 'data-recued-contract-grants-risk';
/** Retired compatibility hook. Contract rows render Access only. */
export const CONTRACT_GRANTS_ASKS_ATTR = 'data-recued-contract-grants-asks';
/** The "also reads: <container>" transitive-admission disclosure on an op that
 *  binds a `source_dependency` (D-192 Slice 7). Carries `data-reads` = the
 *  comma-joined container refs. */
/** Access note above the OPS list (never the entities list). */
export const CONTRACT_GRANTS_AXIS_NOTE_ATTR = 'data-recued-contract-grants-axis-note';

/** ⛔ Say REACH, never "visibility". An ungranted op is a HARD DENY, not a hidden
 *  one — calling the toggle "visibility" would undersell it in the opposite
 *  direction from the error it exists to correct. */
export const CONTRACT_GRANTS_AXIS_NOTE =
  'Access decides which operations this contract can reach. Risk and approval '
  + 'defaults are global pack settings and do not vary by contract.';

export const CONTRACT_GRANTS_ALSO_READS_ATTR = 'data-recued-contract-grants-also-reads';
/** The explicit-vs-default source marker on a cell. Carries `data-source`. */
export const CONTRACT_GRANTS_SOURCE_ATTR = 'data-recued-contract-grants-source';
/** D-247 D11 — the "Direct calls off — still used by … · ran N×" line on an op
 *  row whose grant is off. Carries `data-could` (the static list) and `data-ran`
 *  (the count), so a test can assert BOTH halves rather than a rendered string. */
export const CONTRACT_GRANTS_STILL_USED_ATTR = 'data-recued-contract-grants-still-used';

// ════════════════════════════════════════════════════════════════
// Helpers
// ════════════════════════════════════════════════════════════════

const KIND_TITLE: Record<GrantEntryKind, string> = {
  op: 'Operations',
  collection: 'Collections',
  topic: 'Topics',
  // D-234 § 234.4h — what this peer may ASK the owner about. Titled for the
  // person reading it, not for the key: "questions they may ask you" is the
  // fact, `peer.label.<label>` is the storage.
  peer_label: 'Questions they may ask you',
  // D-247 — what the AI may REACH. Titled for the act, not the key: a grant
  // here makes the recipe findable and callable, and says nothing about
  // approval (every write inside it still asks). `recipe.<publisher>/<id>` is
  // the storage; "Recipes the AI can run" is the fact the owner is deciding.
  recipe: 'Recipes the AI can run',
};

/** Render order WITHIN each tab. Ops tab shows `op` and the peer labels — both
 *  are things this contract may DO, as opposed to data it may read; Entities tab
 *  shows the two read kinds (collections then topics).
 *
 *  ⚠ THE COMPILER PUT THIS LINE HERE. `KIND_TITLE` is a `Record` over the kind
 *  union, so adding `peer_label` failed the build until it was titled AND
 *  placed — which is the whole reason the union is closed. A kind that compiled
 *  without being grouped would render nowhere, and § 234.4's "a findable surface,
 *  or standing means forgotten" would be unmet in the one place it is now met. */
const OPS_KINDS: readonly GrantEntryKind[] = ['op', 'peer_label'];
const ENTITIES_KINDS: readonly GrantEntryKind[] = ['collection', 'topic'];
/** D-247 — the recipe axis gets its OWN root, not a corner of Entities. It is a
 *  different question ("what may the AI reach") from a different vocabulary,
 *  and burying it under Entities is how it stays unfound. */
const RECIPE_KINDS: readonly GrantEntryKind[] = ['recipe'];

const errMessage = (err: unknown): string =>
  humanizeRpcError(err);

// ════════════════════════════════════════════════════════════════
// Options + the mount handle
// ════════════════════════════════════════════════════════════════

export type ContractGrantsPanelState = 'loading' | 'ready' | 'error';

export interface MountContractGrantsPanelOptions {
  /** DOM document seam. Defaults to `globalThis.document`. */
  document?: Document;
  /** The contract whose grants this view edits (`user_self` for the owner). */
  contractId: string;
  /** `contract.grant.read`. */
  runGrantRead: GrantReadCaller;
  /** `contract.grant.write`. */
  runGrantWrite: GrantWriteCaller;
  /** D-196 R3 — customer templates stamp only their explicit contract_grant
   * rows into an instance. When true, absent rows render OFF (no ordinary-door
   * author defaults), and CLI entries are omitted because their separate
   * cli_reachability rows are not part of that stamped grant list. */
  explicitGrantRowsOnly?: boolean;
  /** D-247 D11 — recipe→op usage for the op row. Absent ⇒ the row renders without
   *  the "still used by / ran N×" line, which is the honest degradation: no line
   *  at all rather than a line claiming zero. */
  runRecipeOpUsage?: GrantRecipeOpUsageCaller;
  /** D-247 — `recipe.list`, the recipe half of the grant universe. Absent ⇒ the
   *  Recipes tab is empty, which is honest: no source, no switches. */
  runRecipeList?: GrantRecipeListCaller;
  /** `collection.contract.listCatalogOperations` — the pack-op universe.
   *  Optional: absent ⇒ kernel ops only. */
  runCatalogOperations?: GrantCatalogOperationsCaller;
  /** `housekeeping.registry.describe` — the topic universe. Optional: absent ⇒
   *  no topics (collections still render). */
  runRegistryDescribe?: GrantRegistryDescribeCaller;
  /** `cli.reachability.list` — the effective state for CLI ops (whose admission is
   *  the cli_reachability allowlist, not contract_grant). Optional: absent ⇒ cli
   *  ops render off + their toggle is inert (they still SHOW, just uneditable). */
  runCliReachabilityList?: GrantCliReachabilityListCaller;
  /** `cli.reachability.set` — writes a CLI op's toggle (`principal = contractId`).
   *  Optional: absent ⇒ cli op toggles are inert. */
  runCliReachabilitySet?: GrantCliReachabilitySetCaller;
  /** D-121 broadcast subscribe seam — re-loads on
   *  `contract.contract_definition_changed`. */
  subscribe?: BroadcastSubscriber['on'];
  /** Trailing debounce for the Ops type-along filter. Defaults to 250 ms;
   *  tests may pass 0 for deterministic immediate filtering. */
  operationFilterDebounceMs?: number;
}

export interface ContractGrantsPanelMount {
  /** The Ops tab content (op-kind entries). Kept alive across tab switches. */
  readonly opsRoot: HTMLElement;
  /** The Entities tab content (collection + topic entries). */
  readonly entitiesRoot: HTMLElement;
  /** D-247 — the Recipes tab content: `recipe.*` entries, one per installed
   *  non-kernel recipe. ⛔ OWNER-ONLY at the host: a door's recipe authority is
   *  its inbound token, so a switch here would write a row nothing reads. */
  readonly recipesRoot: HTMLElement;
  /** Current load phase. */
  getState(): ContractGrantsPanelState;
  /** Top-level load-error message. Null when the last load succeeded. */
  getError(): string | null;
  /** The entry universe in display order. */
  getEntries(): ReadonlyArray<GrantUniverseEntry>;
  /** Effective state of one entry — `'on'` / `'off'`. */
  getEffective(entryKey: string): 'on' | 'off';
  /** True iff the contract carries an EXPLICIT row for the entry. */
  isExplicit(entryKey: string): boolean;
  /** The normalized operation query currently applied to the rendered list. */
  getOperationFilter(): string;
  /** Toggle one entry (grant when off, revoke when on). One `contract.grant.write`
   *  + a reconciling re-read. No-op while that entry's write is in flight. */
  toggleEntry(entryKey: string): Promise<void>;
  /** Create and grant one default-closed per-peer question label. */
  addPeerLabel(label: string): Promise<void>;
  /** Host-driven refresh — re-loads the universe + the contract's grants. */
  refresh(): Promise<void>;
  /** Resolves after the most recent load settles. */
  whenLoaded(): Promise<void>;
  /** True while a grant cell write or its authoritative reconcile is pending. */
  hasInFlightWork(): boolean;
  /** Tear down both roots. Idempotent. */
  dispose(): void;
}

// ════════════════════════════════════════════════════════════════
// Internal state
// ════════════════════════════════════════════════════════════════

interface InternalState {
  phase: ContractGrantsPanelState;
  universe: GrantUniverseEntry[];
  /** entry_key → granted — EXPLICIT rows only for this one contract. */
  grants: ReadonlyMap<string, boolean>;
  /** {@link cliRowKey} → allowed — the cli_reachability rows for THIS contract
   *  (principal === contractId). CLI ops resolve their effective state here
   *  (fail-closed: absent ⇒ off), NOT from `grants`. */
  cliRows: ReadonlyMap<string, boolean>;
  error: string | null;
}

// ════════════════════════════════════════════════════════════════
// Mount
// ════════════════════════════════════════════════════════════════

export const mountContractGrantsPanel = (
  opts: MountContractGrantsPanelOptions,
): ContractGrantsPanelMount => {
  const doc = opts.document ?? (globalThis as { document?: Document }).document;
  if (doc === undefined) {
    throw new Error(
      'mountContractGrantsPanel: no document available — pass `opts.document` for non-browser environments',
    );
  }
  const { contractId } = opts;

  let state: InternalState = {
    phase: 'loading',
    universe: [],
    grants: new Map(),
    cliRows: new Map(),
    error: null,
  };
  let disposed = false;
  // Bumped before every load await; a post-await write lands only when its
  // captured generation is still current (the local-tools / grant-matrix idiom).
  let loadGeneration = 0;
  let pendingLoad: Promise<void> = Promise.resolve();
  /** D-247 D11 — op id → the row's two halves. EMPTY means "not computed", which
   *  the renderer must not confuse with "no usage": an absence the owner reads as
   *  proof is the failure mode this substrate names repeatedly. */
  let recipeOpUsage = new Map<string, {
    could: readonly string[];
    count: number;
    recipes: readonly string[];
  }>();
  /** The window the counts describe, or null when nothing was read. */
  let recipeOpUsageWindowDays: number | null = null;
  // entry_keys with a write in flight — the cell renders disabled while running.
  const pendingCells = new Set<string>();
  const operationFilterDebounceMs = opts.operationFilterDebounceMs ?? 250;
  let operationFilterDraft = '';
  let operationFilter = '';
  let operationFilterTimer: ReturnType<typeof setTimeout> | null = null;
  let peerLabelDraft = '';
  let peerLabelError: string | null = null;
  let peerLabelAdding = false;
  const renderedCellToggles = new Map<string, HTMLInputElement>();

  const opsRoot = doc.createElement('div');
  opsRoot.setAttribute(CONTRACT_GRANTS_HOST_ATTR, '');
  opsRoot.setAttribute('data-grant-view', 'ops');
  const opsToolbar = doc.createElement('div');
  opsToolbar.className = 'cg-filter-bar';
  const operationFilterInput = doc.createElement('input');
  operationFilterInput.setAttribute('type', 'search');
  operationFilterInput.setAttribute('placeholder', 'Filter operations…');
  operationFilterInput.setAttribute('aria-label', 'Filter operations');
  operationFilterInput.setAttribute(CONTRACT_GRANTS_OP_FILTER_ATTR, '');
  operationFilterInput.className = 'cg-filter-input';
  opsToolbar.appendChild(operationFilterInput);
  const operationFilterStatus = doc.createElement('span');
  operationFilterStatus.setAttribute(CONTRACT_GRANTS_OP_FILTER_STATUS_ATTR, '');
  operationFilterStatus.setAttribute('aria-live', 'polite');
  operationFilterStatus.className = 'cg-filter-status';
  opsToolbar.appendChild(operationFilterStatus);
  opsRoot.appendChild(opsToolbar);
  const opsResults = doc.createElement('div');
  opsResults.className = 'cg-filter-results';
  opsRoot.appendChild(opsResults);
  const entitiesRoot = doc.createElement('div');
  entitiesRoot.setAttribute(CONTRACT_GRANTS_HOST_ATTR, '');
  entitiesRoot.setAttribute('data-grant-view', 'entities');
  const recipesRoot = doc.createElement('div');
  recipesRoot.setAttribute(CONTRACT_GRANTS_HOST_ATTR, '');
  recipesRoot.setAttribute('data-grant-view', 'recipes');

  const clearChildren = (node: HTMLElement): void => {
    while (node.firstChild) node.removeChild(node.firstChild);
  };
  const appendLine = (
    parent: HTMLElement,
    attr: string,
    className: string,
    text: string,
  ): void => {
    const line = doc.createElement('div');
    line.setAttribute(attr, '');
    line.className = className;
    line.textContent = text;
    parent.appendChild(line);
  };

  // ── derivation (the ONE resolver — matches the gate; shared with the
  //    by-PACK view via grant-op-universe.ts) ──────────────────────────
  const effective = (entry: GrantUniverseEntry): 'on' | 'off' => {
    if (opts.explicitGrantRowsOnly === true) {
      return state.grants.get(entry.entry_key) === true ? 'on' : 'off';
    }
    return effectiveGrantState(entry, contractId, state.grants, state.cliRows);
  };
  const hasExplicit = (entryKey: string): boolean => {
    const entry = state.universe.find((e) => e.entry_key === entryKey);
    if (entry === undefined) return state.grants.has(entryKey);
    return hasExplicitGrant(entry, state.grants, state.cliRows);
  };
  const entriesOfKind = (kind: GrantEntryKind): GrantUniverseEntry[] =>
    state.universe.filter((e) => e.kind === kind);
  const entriesOfKinds = (kinds: readonly GrantEntryKind[]): GrantUniverseEntry[] =>
    state.universe.filter((e) => kinds.includes(e.kind));
  const operationMatchesFilter = (entry: GrantUniverseEntry): boolean => {
    if (operationFilter.length === 0) return true;
    const haystack = [
      entry.label,
      entry.entry_key,
      entry.group,
      entry.ingredientId ?? '',
      entry.risk_tier ?? '',
      entry.cli?.ingredientId ?? '',
      entry.cli?.operationKey ?? '',
    ].join('\n').toLowerCase();
    return haystack.includes(operationFilter);
  };
  const visibleEntriesOfKinds = (
    kinds: readonly GrantEntryKind[],
  ): GrantUniverseEntry[] =>
    state.universe.filter(
      (entry) =>
        kinds.includes(entry.kind)
        && (entry.kind !== 'op' || operationMatchesFilter(entry)),
    );
  const peerLabelEntry = (entry_key: string): GrantUniverseEntry | undefined => {
    const parsed = parseGrantEntry(entry_key);
    if (parsed.kind !== 'peer_label' || parsed.value === '') return undefined;
    return {
      entry_key,
      kind: 'peer_label',
      label: parsed.value,
      group: '',
      authorDefault: false,
    };
  };
  const grantedCount = (kinds: readonly GrantEntryKind[]): { on: number; total: number } => {
    const scoped = entriesOfKinds(kinds);
    let on = 0;
    for (const e of scoped) if (effective(e) === 'on') on += 1;
    return { on, total: scoped.length };
  };

  // ── render: one toggle-able grant cell ──────────────────────────────
  const renderCell = (parent: HTMLElement, entry: GrantUniverseEntry): void => {
    const eff = effective(entry);
    const explicit = hasExplicit(entry.entry_key);
    const inFlight = pendingCells.has(entry.entry_key);
    // A cli op with no cli.reachability.set caller is read-only (its toggle would
    // no-op); render it disabled so the affordance matches the behaviour.
    const cliInert = entry.cli !== undefined && opts.runCliReachabilitySet === undefined;

    const rowLabel = doc.createElement('label');
    rowLabel.setAttribute(CONTRACT_GRANTS_CELL_ATTR, '');
    rowLabel.setAttribute('data-entry', entry.entry_key);
    rowLabel.setAttribute('data-kind', entry.kind);
    rowLabel.setAttribute('data-effective', eff);
    rowLabel.setAttribute('data-source', explicit ? 'explicit' : 'default');
    rowLabel.className = 'cg-cell';

    const box = doc.createElement('input');
    box.setAttribute('type', 'checkbox');
    box.setAttribute(CONTRACT_GRANTS_CELL_TOGGLE_ATTR, '');
    box.setAttribute('data-entry', entry.entry_key);
    box.setAttribute('data-effective', eff);
    box.className = 'cg-cell-box';
    box.checked = eff === 'on';
    if (inFlight) {
      // Keep the owner in the tab order while the write reconciles. A native
      // disabled checkbox drops focus as soon as this render replaces the
      // initiating node; aria-disabled communicates the lock without severing
      // keyboard ownership. Defensive change handling prevents a second Space
      // press from visually drifting away from the authoritative state.
      box.setAttribute('aria-disabled', 'true');
      box.setAttribute('aria-busy', 'true');
      box.addEventListener('change', () => {
        box.checked = eff === 'on';
      });
    } else if (cliInert) box.setAttribute('disabled', '');
    else
      box.addEventListener('change', () => {
        void runToggle(entry.entry_key);
      });
    rowLabel.appendChild(box);

    const name = doc.createElement('span');
    name.className = 'cg-cell-name';
    name.textContent = entry.label;
    rowLabel.appendChild(name);

    // D-192 Slice 7 — disclose the container reads granting this op TRANSITIVELY
    // admits (e.g. Linear "Create issues" also reads `team.search` to resolve the
    // container). The gateway auto-admits these WITHOUT a separate read grant, so
    // without this the grant is silent. `title` names the exact list ops.
    if (entry.kind === 'op' && entry.also_reads !== undefined && entry.also_reads.length > 0) {
      const refs = [...new Set(entry.also_reads.map((r) => r.ref))];
      const alsoReads = doc.createElement('span');
      alsoReads.setAttribute(CONTRACT_GRANTS_ALSO_READS_ATTR, '');
      alsoReads.setAttribute('data-reads', refs.join(','));
      alsoReads.className = 'cg-also-reads';
      alsoReads.textContent = `also reads: ${refs.join(', ')}`;
      alsoReads.title =
        `Granting this also lets it read ${entry.also_reads.map((r) => r.list_op).join(', ')} ` +
        `to resolve the target — no separate grant needed.`;
      rowLabel.appendChild(alsoReads);
    }

    // ── D-247 D11 — THE OP TOGGLE STOPS LYING ────────────────────────────
    //
    // Under D2 an op can be OFF and still run inside a granted recipe. A row
    // rendering a bare "off" is then a FALSE STATEMENT, and the owner deciding
    // whether to revoke is the person it misleads.
    //
    // ⛔ BOTH HALVES OR NEITHER. The static list answers "which recipes COULD
    // reach this"; the count answers "which runs DID". A row with only the first
    // cannot tell a recipe that ran this morning from one that has not run since
    // it was installed — which is most of what the decision needs.
    //
    // ⛔ RETENTION IS NOT HISTORY. `data.audit` evicts oldest-first, so the copy
    // says "in the last N days" and never "never used". And when the evidence was
    // not read at all, this renders NOTHING rather than a zero.
    if (entry.kind === 'op' && eff === 'off') {
      const usage = recipeOpUsage.get(entry.entry_key);
      if (usage !== undefined && (usage.could.length > 0 || usage.count > 0)) {
        const used = doc.createElement('span');
        used.setAttribute(CONTRACT_GRANTS_STILL_USED_ATTR, '');
        used.setAttribute('data-could', usage.could.join(','));
        used.setAttribute('data-ran', String(usage.count));
        used.className = 'cg-still-used';
        const parts: string[] = [];
        if (usage.could.length > 0) parts.push(`still used by: ${usage.could.join(', ')}`);
        parts.push(
          usage.count > 0
            ? `ran ${usage.count}× in the last ${recipeOpUsageWindowDays ?? 30} days`
              + (usage.recipes.length > 0 ? `, via ${usage.recipes.join(', ')}` : '')
            : `no runs in the last ${recipeOpUsageWindowDays ?? 30} days`,
        );
        used.textContent = `Direct calls off — ${parts.join(' · ')}`;
        used.title =
          'Turning an operation off stops the AI calling it DIRECTLY. Recipes you '
          + 'granted may still use it, and each of those calls still asks. '
          + `Run counts cover the last ${recipeOpUsageWindowDays ?? 30} days only — `
          + 'older activity is evicted, so "no runs" is not "never used".';
        rowLabel.appendChild(used);
      }
    }

    const source = doc.createElement('span');
    source.setAttribute(CONTRACT_GRANTS_SOURCE_ATTR, '');
    source.setAttribute('data-source', explicit ? 'explicit' : 'default');
    source.className = 'cg-source';
    source.textContent = explicit ? 'set' : 'default';
    rowLabel.appendChild(source);

    renderedCellToggles.set(entry.entry_key, box);
    parent.appendChild(rowLabel);
  };

  // ── render: a kind sub-group ────────────────────────────────────────
  const renderKindGroup = (
    parent: HTMLElement,
    kind: GrantEntryKind,
    visibleEntries?: ReadonlyArray<GrantUniverseEntry>,
  ): void => {
    const entries = visibleEntries === undefined
      ? entriesOfKind(kind)
      : visibleEntries.filter((entry) => entry.kind === kind);
    if (entries.length === 0) return;
    const group = doc.createElement('div');
    group.setAttribute(CONTRACT_GRANTS_KIND_GROUP_ATTR, '');
    group.setAttribute('data-kind', kind);
    group.className = 'cg-kind';
    const heading = doc.createElement('div');
    heading.className = 'cg-kind-name';
    heading.textContent = KIND_TITLE[kind];
    group.appendChild(heading);

    if (kind === 'op') {
      // Ops nest under their ingredient/domain group.
      let currentGroup: string | null = null;
      let groupBody: HTMLElement = group;
      for (const entry of entries) {
        if (entry.group !== currentGroup) {
          currentGroup = entry.group;
          const sub = doc.createElement('div');
          sub.className = 'cg-op-ingredient';
          const subName = doc.createElement('div');
          subName.className = 'cg-op-ingredient-name';
          subName.textContent = entry.group;
          sub.appendChild(subName);
          group.appendChild(sub);
          groupBody = sub;
        }
        renderCell(groupBody, entry);
      }
    } else {
      for (const entry of entries) renderCell(group, entry);
    }
    parent.appendChild(group);
  };

  // ── render: one tab root ────────────────────────────────────────────
  const renderInto = (
    root: HTMLElement,
    kinds: readonly GrantEntryKind[],
    emptyNote: string,
    /** Ops only — the two-axis note. Absent for the entities root. */
    axisNote?: string,
    filterOperations = false,
  ): void => {
    clearChildren(root);

    if (state.error !== null) {
      appendLine(
        root,
        CONTRACT_GRANTS_ERROR_ATTR,
        'cg-error',
        `Could not load grants: ${state.error}`,
      );
    }

    if (state.phase === 'loading' && state.universe.length === 0) {
      appendLine(root, CONTRACT_GRANTS_LOADING_ATTR, 'cg-loading', 'Loading grants…');
      return;
    }

    const allScoped = entriesOfKinds(kinds);
    if (allScoped.length === 0) {
      if (state.error === null) {
        appendLine(root, CONTRACT_GRANTS_EMPTY_ATTR, 'cg-empty', emptyNote);
      }
      return;
    }
    const scoped = filterOperations ? visibleEntriesOfKinds(kinds) : allScoped;

    const { on, total } = grantedCount(kinds);
    const summary = doc.createElement('div');
    summary.setAttribute(CONTRACT_GRANTS_SUMMARY_ATTR, '');
    summary.className = 'cg-summary';
    summary.textContent = filterOperations && operationFilter.length > 0
      ? `${on} of ${total} granted · ${scoped.length} matching`
      : `${on} of ${total} granted`;
    root.appendChild(summary);

    if (axisNote !== undefined) {
      appendLine(root, CONTRACT_GRANTS_AXIS_NOTE_ATTR, 'cg-axis-note', axisNote);
    }

    if (scoped.length === 0) {
      appendLine(
        root,
        CONTRACT_GRANTS_EMPTY_ATTR,
        'cg-empty',
        `No operations match “${operationFilterDraft.trim()}”.`,
      );
      return;
    }

    for (const kind of kinds) renderKindGroup(root, kind, scoped);
  };

  const render = (): void => {
    if (disposed) return;
    const activeElement = (
      doc as unknown as { activeElement?: HTMLElement | null }
    ).activeElement ?? null;
    const focusedEntry = activeElement?.hasAttribute?.(
      CONTRACT_GRANTS_CELL_TOGGLE_ATTR,
    ) === true
      ? activeElement.getAttribute('data-entry')
      : null;
    const totalOps = entriesOfKinds(OPS_KINDS).length;
    const matchingOps = visibleEntriesOfKinds(OPS_KINDS).length;
    operationFilterStatus.textContent = operationFilterDraft.trim().toLowerCase()
      !== operationFilter
      ? 'Filtering…'
      : operationFilter.length > 0
        ? `${matchingOps} of ${totalOps} operations`
        : `${totalOps} operations`;
    renderedCellToggles.clear();
    renderInto(
      opsResults,
      OPS_KINDS,
      'No operations are available on this server yet.',
      CONTRACT_GRANTS_AXIS_NOTE,
      true,
    );
    if (contractId !== OWNER_CONTRACT_ID) {
      const labelForm = doc.createElement('div');
      labelForm.className = 'cg-peer-label-form';
      const labelInput = doc.createElement('input');
      labelInput.setAttribute('type', 'text');
      labelInput.setAttribute(CONTRACT_GRANTS_PEER_LABEL_INPUT_ATTR, '');
      labelInput.setAttribute('maxlength', String(PEER_ASK_LABEL_MAX));
      labelInput.setAttribute('placeholder', 'Question label');
      labelInput.setAttribute('aria-label', 'Question label this peer may use');
      labelInput.value = peerLabelDraft;
      labelInput.addEventListener('input', () => {
        peerLabelDraft = labelInput.value;
        peerLabelError = null;
      });
      labelForm.appendChild(labelInput);
      const addLabel = doc.createElement('button');
      addLabel.setAttribute('type', 'button');
      addLabel.setAttribute(CONTRACT_GRANTS_PEER_LABEL_ADD_ATTR, '');
      addLabel.textContent = peerLabelAdding ? 'Adding…' : 'Grant label';
      if (peerLabelAdding) addLabel.setAttribute('disabled', '');
      addLabel.addEventListener('click', () => { void runAddPeerLabel(peerLabelDraft); });
      labelForm.appendChild(addLabel);
      if (peerLabelError !== null) {
        appendLine(
          labelForm,
          CONTRACT_GRANTS_PEER_LABEL_ERROR_ATTR,
          'cg-peer-label-error',
          peerLabelError,
        );
      }
      opsResults.appendChild(labelForm);
    }
    renderInto(
      entitiesRoot,
      ENTITIES_KINDS,
      'No collections or topics are available on this server yet.',
    );
    renderInto(
      recipesRoot,
      RECIPE_KINDS,
      'No recipes are installed yet. Install a pack, or write one in Kitchen.',
      // ⚠ The two-axis note, because the row is otherwise read as approval.
      // A recipe grant makes the recipe REACHABLE; every write inside it still
      // asks, and turning one off does not turn its operations off (D3/D4).
      'Turning a recipe on lets the AI find and call it. Each write inside it '
      + 'still asks. Turning it off does not turn its operations off — those are '
      + 'the Ops tab.',
    );
    if (focusedEntry !== null) {
      const replacement = renderedCellToggles.get(focusedEntry);
      if (replacement !== undefined && !replacement.disabled) {
        try {
          replacement.focus({ preventScroll: true });
        } catch {
          // Reduced/fake DOMs keep focus restoration best-effort.
        }
      }
    }
  };

  const applyOperationFilter = (): void => {
    operationFilterTimer = null;
    operationFilter = operationFilterDraft.trim().toLowerCase();
    render();
  };
  operationFilterInput.addEventListener('input', () => {
    operationFilterDraft = operationFilterInput.value;
    if (operationFilterTimer !== null) clearTimeout(operationFilterTimer);
    if (operationFilterDebounceMs <= 0) {
      applyOperationFilter();
      return;
    }
    operationFilterStatus.textContent = 'Filtering…';
    operationFilterTimer = setTimeout(
      applyOperationFilter,
      operationFilterDebounceMs,
    );
  });

  // ── load ────────────────────────────────────────────────────────────
  const doRefresh = (): Promise<void> => {
    const gen = ++loadGeneration;
    pendingLoad = (async () => {
      const [catalogR, registryR, grantsR, cliR, usageR, recipesR] = await Promise.allSettled([
        opts.runCatalogOperations
          ? opts.runCatalogOperations()
          : Promise.resolve(undefined),
        opts.runRegistryDescribe
          ? opts.runRegistryDescribe()
          : Promise.resolve(undefined),
        opts.runGrantRead({ contract_id: contractId }),
        opts.explicitGrantRowsOnly !== true && opts.runCliReachabilityList
          ? opts.runCliReachabilityList()
          : Promise.resolve(undefined),
        // D-247 D11 — evidence for the op row. ⚠ NOT part of the load's spine: a
        // failure here must not blank the grant matrix, so it is read
        // best-effort and its absence renders as no line rather than a zero.
        opts.runRecipeOpUsage ? opts.runRecipeOpUsage({}) : Promise.resolve(undefined),
        // D-247 — the recipe half of the UNIVERSE. Same optionality as the
        // catalog/registry slices above: a failure drops the slice rather than
        // failing the load, and the Recipes tab then renders its empty note.
        opts.runRecipeList ? opts.runRecipeList() : Promise.resolve(undefined),
      ]);
      if (disposed || gen !== loadGeneration) return;

      // D-247 D11 — index the evidence by op. A rejected read leaves the map
      // EMPTY, which the renderer treats as "not computed" (no line) rather than
      // "no usage" (a zero the owner would read as proof).
      recipeOpUsage = new Map();
      recipeOpUsageWindowDays = null;
      if (usageR.status === 'fulfilled' && usageR.value !== undefined) {
        recipeOpUsageWindowDays = usageR.value.window_days;
        for (const row of usageR.value.operations) recipeOpUsage.set(row.operation_id, row);
      }

      const errors: string[] = [];
      const catalog = catalogR.status === 'fulfilled' ? catalogR.value : undefined;
      if (catalogR.status === 'rejected') errors.push(errMessage(catalogR.reason));
      const registry = registryR.status === 'fulfilled' ? registryR.value : undefined;
      if (registryR.status === 'rejected') errors.push(errMessage(registryR.reason));

      const recipeList = recipesR.status === 'fulfilled' ? recipesR.value : undefined;
      if (recipesR.status === 'rejected') errors.push(errMessage(recipesR.reason));
      const universe = buildUniverse(catalog, registry, recipeList).filter(
        (entry) => opts.explicitGrantRowsOnly !== true || entry.cli === undefined,
      );
      if (grantsR.status === 'fulfilled') {
        const known = new Set(universe.map((entry) => entry.entry_key));
        for (const row of grantsR.value.grants) {
          if (known.has(row.entry_key)) continue;
          const entry = peerLabelEntry(row.entry_key);
          if (entry === undefined) continue;
          universe.push(entry);
          known.add(row.entry_key);
        }
      }

      // The contract's own grant rows are the load's spine — a failure here is a
      // top-level error (the cells would be unanchored author-defaults only).
      // BUT a cell write reconciling concurrently is AUTHORITATIVE for this
      // contract: if any write is in flight, carry the live (reconciling) grants
      // forward instead of this possibly-pre-write snapshot, so an interleaved
      // refresh can never clobber a write's result in the microtask tail before
      // the write's finally-bump lands (the global grant-matrix panel's
      // `contractHasPendingCell` carry-forward, single-contract form).
      let grants: ReadonlyMap<string, boolean> = state.grants;
      if (pendingCells.size > 0) {
        grants = state.grants;
      } else if (grantsR.status === 'fulfilled') {
        const m = new Map<string, boolean>();
        for (const g of grantsR.value.grants) m.set(g.entry_key, g.granted);
        grants = m;
      } else {
        errors.push(errMessage(grantsR.reason));
      }

      // CLI ops resolve against cli_reachability (same pending-write carry-forward
      // as `grants`). A failed/absent cli read is SOFT — cli ops fall back to the
      // fail-closed off state; it does not error the whole panel (unlike the grant
      // spine), so a server without the cli caller still renders the op axis.
      let cliRows: ReadonlyMap<string, boolean> = state.cliRows;
      if (pendingCells.size === 0 && cliR.status === 'fulfilled' && cliR.value !== undefined) {
        cliRows = cliRowsForPrincipal(cliR.value.rows, contractId);
      }

      state = {
        ...state,
        phase: errors.length > 0 ? 'error' : 'ready',
        universe,
        grants,
        cliRows,
        error: errors.length > 0 ? errors.join('; ') : null,
      };
      render();
    })();
    return pendingLoad;
  };

  /** Re-read this contract's explicit grant rows into `state.grants` — the
   *  reconciling read after a write, so a partial/failed write can't leave a
   *  stale on-screen state. */
  const reloadGrants = async (): Promise<void> => {
    const res = await opts.runGrantRead({ contract_id: contractId });
    if (disposed) return;
    const m = new Map<string, boolean>();
    for (const g of res.grants) m.set(g.entry_key, g.granted);
    state = { ...state, grants: m };
  };

  const runAddPeerLabel = async (rawLabel: string): Promise<void> => {
    if (peerLabelAdding) return;
    const label = rawLabel.trim();
    if (label === '' || label.length > PEER_ASK_LABEL_MAX) {
      peerLabelError = `Enter a label between 1 and ${PEER_ASK_LABEL_MAX} characters.`;
      render();
      return;
    }
    const entryKey = peerLabelGrantEntry(label);
    peerLabelAdding = true;
    peerLabelError = null;
    render();
    try {
      await opts.runGrantWrite({ contract_id: contractId, entry_key: entryKey, granted: true });
      if (disposed) return;
      await reloadGrants();
      if (disposed) return;
      if (!state.universe.some((entry) => entry.entry_key === entryKey)) {
        const entry = peerLabelEntry(entryKey);
        if (entry !== undefined) state = { ...state, universe: [...state.universe, entry] };
      }
      peerLabelDraft = '';
    } catch (err) {
      if (!disposed) peerLabelError = errMessage(err);
    } finally {
      peerLabelAdding = false;
      if (!disposed) render();
    }
  };

  /** Re-read this contract's cli_reachability rows into `state.cliRows` — the
   *  reconciling read after a CLI op toggle (the cli analog of reloadGrants). */
  const reloadCliRows = async (): Promise<void> => {
    if (opts.runCliReachabilityList === undefined) return;
    const res = await opts.runCliReachabilityList();
    if (disposed) return;
    state = { ...state, cliRows: cliRowsForPrincipal(res.rows, contractId) };
  };

  const runToggle = async (entryKey: string): Promise<void> => {
    if (pendingCells.has(entryKey)) return;
    const entry = state.universe.find((e) => e.entry_key === entryKey);
    if (entry === undefined) return;
    const cli = entry.cli;
    // A CLI op routes to cli_reachability; with no set caller its toggle is inert
    // (the cell also renders disabled), so bail before touching pending state.
    if (cli !== undefined && opts.runCliReachabilitySet === undefined) return;

    // Toggle relative to the current EFFECTIVE state (the same resolver the cell
    // renders), so the write target is correct whether the prior value came from
    // an explicit row or the per-(entry × contract) author default. Always write
    // the explicit boolean (unambiguous + idempotent); the gate reads
    // `explicit ?? default` either way.
    const target = effective(entry) !== 'on';

    pendingCells.add(entryKey);
    // Invalidate any in-flight full load so its snapshot can't clobber the
    // reconciling re-read below.
    loadGeneration += 1;
    if (state.error !== null) state = { ...state, error: null };
    render();
    try {
      if (cli !== undefined) {
        // CLI op — write the cli_reachability allowlist (principal = contractId),
        // NOT contract_grant (which the cli gate never reads). `operation_id` is
        // the manifest MAP KEY (cli.operationKey), NOT the qualified entry label,
        // so it matches the rows the gateway + cli-tool-universe key on. The
        // no-caller case returned above.
        await opts.runCliReachabilitySet!({
          principal: contractId,
          ingredient_id: cli.ingredientId,
          operation_id: cli.operationKey,
          allowed: target,
        });
        if (disposed) return;
        await reloadCliRows();
      } else {
        await opts.runGrantWrite({ contract_id: contractId, entry_key: entryKey, granted: target });
        if (disposed) return;
        await reloadGrants();
      }
      if (disposed) return;
    } catch (err) {
      if (disposed) return;
      state = { ...state, error: errMessage(err) };
    } finally {
      pendingCells.delete(entryKey);
      // The "write epoch" backstop: bump again so a refresh that STARTED during
      // this write is invalidated and can't apply a pre-reconcile snapshot.
      loadGeneration += 1;
      if (!disposed) render();
    }
  };

  // ── live coherence ──────────────────────────────────────────────────
  const broadcastUnsubscribers: Array<() => void> = [];
  if (opts.subscribe) {
    broadcastUnsubscribers.push(
      opts.subscribe('contract.contract_definition_changed', () => {
        if (disposed) return;
        void doRefresh();
      }),
    );
  }

  // ── initial paint + seed load ───────────────────────────────────────
  render();
  void doRefresh();

  return {
    opsRoot,
    entitiesRoot,
    recipesRoot,
    getState: () => state.phase,
    getError: () => state.error,
    getEntries: () => state.universe,
    getEffective: (entryKey) => {
      const entry = state.universe.find((e) => e.entry_key === entryKey);
      return entry === undefined ? 'off' : effective(entry);
    },
    isExplicit: (entryKey) => hasExplicit(entryKey),
    getOperationFilter: () => operationFilter,
    toggleEntry: (entryKey) => runToggle(entryKey),
    addPeerLabel: (label) => runAddPeerLabel(label),
    refresh: () => doRefresh(),
    whenLoaded: () => pendingLoad,
    hasInFlightWork: () => pendingCells.size > 0 || peerLabelAdding,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      if (operationFilterTimer !== null) {
        clearTimeout(operationFilterTimer);
        operationFilterTimer = null;
      }
      for (const unsub of broadcastUnsubscribers) {
        try {
          unsub();
        } catch {
          /* swallow per-handle teardown failures */
        }
      }
      broadcastUnsubscribers.length = 0;
      for (const root of [opsRoot, entitiesRoot, recipesRoot]) {
        const parent = root.parentNode as { removeChild?: (c: unknown) => void } | null;
        try {
          parent?.removeChild?.(root);
        } catch {
          /* a detached / fake-DOM root may throw — ignore */
        }
      }
    },
  };
};

// ════════════════════════════════════════════════════════════════
// Styles — scoped under [data-recued-contract-grants]; the route joins
// this into its one style bundle.
// ════════════════════════════════════════════════════════════════

export const CONTRACT_GRANTS_PANEL_STYLES = `
[${CONTRACT_GRANTS_HOST_ATTR}],
[${CONTRACT_GRANTS_HOST_ATTR}] .cg-filter-results,
[${CONTRACT_GRANTS_HOST_ATTR}] .cg-kind {
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  max-width: 100%;
}
[${CONTRACT_GRANTS_HOST_ATTR}] .cg-op-ingredient {
  box-sizing: border-box;
  min-width: 0;
  max-width: calc(100% - 6px);
}
[${CONTRACT_GRANTS_HOST_ATTR}] .cg-filter-bar {
  box-sizing: border-box;
  position: sticky;
  top: 0;
  z-index: 1;
  display: flex;
  width: 100%;
  min-width: 0;
  max-width: 100%;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  padding: 2px 0 10px;
  background: var(--surface, Canvas);
}
[${CONTRACT_GRANTS_HOST_ATTR}] .cg-filter-input {
  box-sizing: border-box;
  flex: 1 1 150px;
  width: min(100%, 440px);
  min-width: 0;
  max-width: 100%;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
  color: var(--fg);
  padding: 8px 10px;
  font: inherit;
  font-size: 13px;
}
[${CONTRACT_GRANTS_HOST_ATTR}] .cg-filter-input:focus {
  outline: 2px solid color-mix(in srgb, var(--accent) 35%, transparent);
  outline-offset: 1px;
  border-color: var(--accent);
}
[${CONTRACT_GRANTS_HOST_ATTR}] .cg-filter-status {
  min-width: 0;
  max-width: 100%;
  flex: 0 0 auto;
  margin-left: auto;
  white-space: normal;
  font-size: 11px;
  color: var(--muted);
  overflow-wrap: anywhere;
}
[${CONTRACT_GRANTS_HOST_ATTR}] .cg-peer-label-form {
  display: flex;
  width: 100%;
  gap: 8px;
  margin-top: 12px;
  flex-wrap: wrap;
}
[${CONTRACT_GRANTS_HOST_ATTR}] .cg-peer-label-form input {
  box-sizing: border-box;
  flex: 1 1 180px;
  min-width: 0;
}
[${CONTRACT_GRANTS_HOST_ATTR}] .cg-peer-label-error {
  flex-basis: 100%;
  color: var(--danger, #b3261e);
}
[${CONTRACT_GRANTS_HOST_ATTR}] .cg-loading,
[${CONTRACT_GRANTS_HOST_ATTR}] .cg-empty {
  font-size: 13px;
  color: var(--muted);
  padding: 6px 2px;
}
[${CONTRACT_GRANTS_HOST_ATTR}] .cg-error {
  font-size: 13px;
  color: var(--danger, #b3261e);
  padding: 6px 2px;
}
[${CONTRACT_GRANTS_HOST_ATTR}] .cg-summary {
  font-size: 11px;
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  margin: 2px 0 8px;
}
[${CONTRACT_GRANTS_HOST_ATTR}] .cg-axis-note {
  font-size: 11px;
  color: var(--muted);
  line-height: 1.45;
  margin: 0 0 10px;
  max-width: 62ch;
}
[${CONTRACT_GRANTS_HOST_ATTR}] .cg-kind {
  margin: 12px 0;
}
[${CONTRACT_GRANTS_HOST_ATTR}] .cg-kind-name,
[${CONTRACT_GRANTS_HOST_ATTR}] .cg-op-ingredient-name {
  font-size: 12px;
  font-weight: 600;
  font-family: var(--mono, ui-monospace, monospace);
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.03em;
  margin-bottom: 2px;
  overflow-wrap: anywhere;
}
[${CONTRACT_GRANTS_HOST_ATTR}] .cg-op-ingredient {
  margin: 6px 0 6px 6px;
}
[${CONTRACT_GRANTS_HOST_ATTR}] .cg-cell {
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  max-width: 100%;
  min-height: 36px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 3px 0 3px 8px;
  cursor: pointer;
}
[${CONTRACT_GRANTS_HOST_ATTR}] .cg-cell-box {
  flex: 0 0 auto;
  cursor: pointer;
}
[${CONTRACT_GRANTS_HOST_ATTR}] .cg-cell-box[disabled],
[${CONTRACT_GRANTS_HOST_ATTR}] .cg-cell-box[aria-disabled='true'] {
  opacity: 0.6;
  cursor: default;
}
[${CONTRACT_GRANTS_HOST_ATTR}] .cg-cell-name {
  min-width: 0;
  max-width: 100%;
  flex: 1 1 140px;
  font-size: 13px;
  font-family: var(--mono, ui-monospace, monospace);
  overflow-wrap: anywhere;
}
[${CONTRACT_GRANTS_HOST_ATTR}] .cg-also-reads {
  box-sizing: border-box;
  min-width: 0;
  max-width: 100%;
  flex: 1 1 auto;
  font-size: 10px;
  color: var(--muted);
  padding: 1px 6px;
  border: 1px solid var(--border, #ddd);
  border-radius: 999px;
  white-space: normal;
  overflow-wrap: anywhere;
}
[${CONTRACT_GRANTS_HOST_ATTR}] .cg-source {
  min-width: 0;
  max-width: 100%;
  flex: 0 0 auto;
  font-size: 10px;
  color: var(--muted);
  margin-left: auto;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
[${CONTRACT_GRANTS_HOST_ATTR}] .cg-source[data-source='explicit'] {
  color: var(--accent, var(--fg));
}
`;
