/** Packs R22 R3 — the by-PACK Access panel (`#packs/<slug>` detail → ACCESS).
 *
 *  The SECOND axis of the one grant matrix (treemap §PACKS ACCESS, locked
 *  R22.4/R22.6/R22.7): where `#contracts` shows ONE contract × every entry,
 *  this shows ONE pack's ops × every contract, as a CONTRACT-FIRST NESTED
 *  LIST (not a 2D grid):
 *
 *      ▾ Self (you)                 3 of 5     ← first, expanded
 *          ☑ <op>  <set/default>
 *      ▸ <door contract>            0 of 5     ← collapsed; N-of-M summary
 *
 *  Self IS a contract row (`user_self` — the REAL principal the webclient /
 *  messenger owner authorizes as, R22.6), loaded through the same
 *  `contract.grant.read` as every door; cli ops fail-closed (the owner
 *  enables per-tool), connection ops resolve the same author default the gate
 *  runs. This panel owns only Access: risk and approval are global operation
 *  defaults rendered separately on the pack detail. "Granted" = may-request;
 *  the admission flow still applies after this reachability check.
 *
 *  ── The #4 (GAP-C) shape: client-side join, no new server reader ─────────
 *  Stored grants are pack-BLIND (an op entry_key is the bare qualified
 *  `operation_id`; cli rows are `(principal, ingredientId, operationKey)`)
 *  and so is the catalog. The pack → op membership lives ONLY in the pack
 *  manifest: one catalog ingredient per COMPOSITION (the decomposer sets
 *  `slug: composition.slug`), so {@link packCompositionSlugs} extracts the
 *  catalog ingredient_ids belonging to a pack and the panel filters the
 *  shared catalog-op universe to them. Reads iterate `contract.grant.read`
 *  per contract (few: self + doors) + ONE global `cli.reachability.list`;
 *  a batched server reader can slot behind this seam later if contract
 *  count grows.
 *
 *  ── Reuse boundary (#3) ──────────────────────────────────────────────────
 *  The cell derivation (`effectiveGrantState` / `hasExplicitGrant` /
 *  `catalogOpUniverseEntries` / cli routing) is the SHARED
 *  `contracts/grant-op-universe.ts` — extracted from the by-CONTRACT panel
 *  so the two axes cannot drift from each other or the gate. The write flow
 *  mirrors that panel's write-then-reconcile (explicit boolean write, re-read
 *  the touched store, write-epoch generation bumps).
 *
 *  ── R3b — the treemap-locked bulk conveniences ───────────────────────────
 *  Three affordances over the SAME cells (no new grant semantics — every
 *  bulk write is exactly the per-cell toggle, fanned out; the per-action
 *  `ask` for write-risk ops is untouched at the gate):
 *   - the "Grant scope: You only / Selected / All contracts" radio — its
 *     checked state is DERIVED from the cells (doors all off → You only;
 *     everything on → All contracts; else Selected, the descriptive resting
 *     state a click on which writes nothing); picking You-only revokes every
 *     door cell, All grants every cell (self included — self is a contract);
 *   - the per-contract "[all ops ▾]" select on EXPANDED rows (Grant all /
 *     Revoke all for that contract; the collapsed N-of-M summary stays);
 *   - "+ grant this pack to a contract" — a picker over the ACTIVE doors
 *     not yet fully granted (every door already renders as a row; picking
 *     one grant-alls it and expands its row).
 *  All three fan out through ONE bulk runner that mirrors the single-cell
 *  write path: only cells whose EFFECTIVE state differs are written (explicit
 *  boolean / cli set), touched cells go pending, the write-epoch generation
 *  bumps guard in-flight loads, and the touched stores reconcile by re-read.
 *  Bulk affordances render only when every op kind the pack ships has its
 *  writer wired (a partial "grant all" would lie). */

import {
  isStandingContractDefinition,
  OWNER_CONTRACT_ID,
  type PackListEntry,
} from '@recued/contracts';
import type { BulkPackManifest } from '@recued/contracts';

import {
  catalogOpUniverseEntries,
  cliRowKey,
  effectiveGrantState,
  hasExplicitGrant,
  type GrantUniverseEntry,
} from '../contracts/grant-op-universe.js';
import type {
  GrantCatalogOperationsCaller,
  GrantCliReachabilityListCaller,
  GrantCliReachabilitySetCaller,
  GrantContractsCaller,
  GrantReadCaller,
  GrantWriteCaller,
} from '../contracts/contract-grants-panel.js';
import type { BroadcastSubscriber } from '../realtime/subscriber.js';
import { humanizeRpcError } from '../shell/rpc-error-copy.js';

// ════════════════════════════════════════════════════════════════
// The pack → catalog-ingredient membership helper (#4's bubble-up link)
// ════════════════════════════════════════════════════════════════

/** The catalog `ingredient_id`s a pack's install produced — its composition
 *  slugs (`contents[].composition.slug`; the decomposer writes ONE catalog
 *  ingredient per composition with exactly that slug). Empty for a v1
 *  recipe-only pack. Exported for tests; graduates to `@recued/contracts`
 *  when a second consumer appears (kept here for now — the contracts barrel
 *  is peer-churned). */
export const packCompositionSlugs = (manifest: BulkPackManifest): string[] => {
  const slugs: string[] = [];
  for (const content of manifest.contents ?? []) {
    if (content.type !== 'composition') continue;
    const slug = content.composition.slug;
    if (typeof slug === 'string' && slug.trim() !== '') slugs.push(slug.trim());
  }
  return slugs;
};

// ════════════════════════════════════════════════════════════════
// Attribute constants — stable hooks for DOM tests + host introspection
// ════════════════════════════════════════════════════════════════

export const PACK_ACCESS_ATTR = 'data-recued-pack-access';
export const PACK_ACCESS_LOADING_ATTR = 'data-recued-pack-access-loading';
export const PACK_ACCESS_ERROR_ATTR = 'data-recued-pack-access-error';
/** One contract row group. Carries `data-contract-id` + `data-expanded`. */
export const PACK_ACCESS_CONTRACT_ATTR = 'data-recued-pack-access-contract';
/** The contract row's expand/collapse header button. `data-contract-id`. */
export const PACK_ACCESS_CONTRACT_TOGGLE_ATTR =
  'data-recued-pack-access-contract-toggle';
/** The contract row's "N of M" summary. */
export const PACK_ACCESS_SUMMARY_ATTR = 'data-recued-pack-access-summary';
/** One toggle-able op cell. Carries `data-contract-id` / `data-entry` /
 *  `data-effective` / `data-source`. */
export const PACK_ACCESS_CELL_ATTR = 'data-recued-pack-access-cell';
/** The cell's checkbox. Same `data-*` as its cell. */
export const PACK_ACCESS_CELL_TOGGLE_ATTR = 'data-recued-pack-access-cell-toggle';
/** R3b — the "Grant scope" radio row. Carries `data-scope` (the DERIVED
 *  `you_only` / `selected` / `all` value). */
export const PACK_ACCESS_SCOPE_ATTR = 'data-recued-pack-access-scope';
/** One scope radio input. Carries `data-scope-value`. */
export const PACK_ACCESS_SCOPE_RADIO_ATTR = 'data-recued-pack-access-scope-radio';
/** R3b — the per-contract "[all ops ▾]" bulk select (expanded rows only).
 *  Carries `data-contract-id`. */
export const PACK_ACCESS_ALL_OPS_ATTR = 'data-recued-pack-access-all-ops';
/** R3b — the "+ grant this pack to a contract" disclosure button. */
export const PACK_ACCESS_ADD_ATTR = 'data-recued-pack-access-add';
/** The add-picker select (one option per grantable door). */
export const PACK_ACCESS_ADD_PICKER_ATTR = 'data-recued-pack-access-add-picker';
/** The add-picker empty-state line (no doors / everything granted). */
export const PACK_ACCESS_ADD_EMPTY_ATTR = 'data-recued-pack-access-add-empty';

const COPY = {
  heading: 'Contract Access Control',
  self_label: 'Self (you)',
  loading: 'Loading access…',
  source_set: 'set',
  source_default: 'default',
  scope_label: 'Grant scope:',
  scope_you_only: 'You only',
  scope_selected: 'Selected',
  scope_all: 'All contracts',
  scope_selected_title:
    'Set per-op grants on the contract rows below — mixed grants land here.',
  all_ops_placeholder: 'all ops',
  all_ops_grant: 'Grant all',
  all_ops_revoke: 'Revoke all',
  add_label: '+ grant this pack to a contract',
  add_placeholder: 'Choose a contract…',
  add_empty_no_doors: 'No other contracts yet — doors are created in',
  add_empty_no_doors_link: 'Contracts',
  add_empty_all_granted: 'Every contract already has full access to this pack.',
} as const;

/** The DERIVED "Grant scope" value — a read of the cells, never stored. */
type GrantScopeValue = 'you_only' | 'selected' | 'all';

// ════════════════════════════════════════════════════════════════
// Options + controller handle
// ════════════════════════════════════════════════════════════════

export interface PackAccessControllerOptions {
  /** DOM document seam (mirrors the packs panel's). */
  document: Document;
  /** `collection.contract.listContracts` — the door rows (self is synthesized). */
  runListContracts?: GrantContractsCaller;
  /** `contract.grant.read` — one contract's explicit rows (iterated per contract). */
  runGrantRead?: GrantReadCaller;
  /** `contract.grant.write` — optional; absent ⇒ connection-op toggles inert. */
  runGrantWrite?: GrantWriteCaller;
  /** `collection.contract.listCatalogOperations` — the shared op universe. */
  runCatalogOperations?: GrantCatalogOperationsCaller;
  /** `cli.reachability.list` — ONE global read; rows filtered per contract.
   *  Optional: absent ⇒ cli ops render fail-closed off + inert. */
  runCliReachabilityList?: GrantCliReachabilityListCaller;
  /** `cli.reachability.set` — optional; absent ⇒ cli-op toggles inert. */
  runCliReachabilitySet?: GrantCliReachabilitySetCaller;
  /** D-121 bus — re-loads on `contract.contract_definition_changed`. */
  subscribe?: BroadcastSubscriber['on'];
  /** Host re-render hook — fired after every state change so the packs panel
   *  repaints the detail (same shape as the supervision controller's). */
  onChange: () => void;
}

export interface PackAccessController {
  /** True when the read trio (contracts + grant read + catalog) is wired —
   *  the detail renders the panel; otherwise it keeps the R3-placeholder. */
  readonly enabled: boolean;
  /** Load contracts + catalog + cli rows + per-contract grants. Called
   *  alongside the host's `packs.list` load; generation-guarded. */
  refresh(): Promise<void>;
  /** The ACCESS panel for one pack, or null when the pack ships no catalog
   *  ops (recipe-only) / the controller is disabled. */
  renderForPack(pack: PackListEntry): HTMLElement | null;
  /** Resolves after the most recent load settles. */
  whenLoaded(): Promise<void>;
  /** Test seam — effective state of one (contract × entry) cell. */
  effectiveFor(contractId: string, entryKey: string): 'on' | 'off';
  /** Test seam — the loaded contract ids in display order (self first). */
  contractIds(): string[];
  dispose(): void;
}

interface ContractRow {
  contract_id: string;
  display_name: string;
  is_self: boolean;
}

// ════════════════════════════════════════════════════════════════
// Controller
// ════════════════════════════════════════════════════════════════

export const createPackAccessController = (
  opts: PackAccessControllerOptions,
): PackAccessController => {
  const doc = opts.document;
  const enabled =
    opts.runListContracts !== undefined
    && opts.runGrantRead !== undefined
    && opts.runCatalogOperations !== undefined;

  let disposed = false;
  let loading = false;
  let error: string | null = null;
  let contracts: ContractRow[] = [];
  let universe: GrantUniverseEntry[] = [];
  /** contract_id → its explicit grant rows (entry_key → granted). */
  let grantsByContract = new Map<string, ReadonlyMap<string, boolean>>();
  /** contract_id → its cli_reachability rows ({@link cliRowKey} → allowed). */
  let cliRowsByContract = new Map<string, ReadonlyMap<string, boolean>>();
  /** Expanded contract rows — the self row starts open (R22.7). */
  const expanded = new Set<string>([OWNER_CONTRACT_ID]);
  /** `(contract_id, entry_key)` cells with a write in flight. */
  const pendingCells = new Set<string>();
  /** R3b — ONE bulk fan-out at a time; bulk controls disable while set. */
  let bulkPending = false;
  /** R3b — the "+ grant this pack to a contract" picker disclosure, keyed by
   *  pack slug so an open picker can't leak into another pack's detail
   *  (codex R3b LOW — the controller outlives pack selection). */
  let addPickerOpenFor: string | null = null;
  let loadGeneration = 0;
  let pendingLoad: Promise<void> = Promise.resolve();

  const cellKey = (contractId: string, entryKey: string): string =>
    [contractId, entryKey].join('::');
  const emptyRows: ReadonlyMap<string, boolean> = new Map();
  const grantsFor = (contractId: string): ReadonlyMap<string, boolean> =>
    grantsByContract.get(contractId) ?? emptyRows;
  const cliRowsFor = (contractId: string): ReadonlyMap<string, boolean> =>
    cliRowsByContract.get(contractId) ?? emptyRows;
  const effectiveOf = (entry: GrantUniverseEntry, contractId: string): 'on' | 'off' =>
    effectiveGrantState(entry, contractId, grantsFor(contractId), cliRowsFor(contractId));

  /** The pack's slice of the op universe (recomputed at click time so a bulk
   *  runner never acts on a stale render snapshot). */
  const entriesForManifest = (manifest: BulkPackManifest): GrantUniverseEntry[] => {
    const slugs = new Set(packCompositionSlugs(manifest));
    return universe.filter(
      (e) => e.ingredientId !== undefined && slugs.has(e.ingredientId),
    );
  };

  const entryWritable = (entry: GrantUniverseEntry): boolean =>
    entry.cli !== undefined
      ? opts.runCliReachabilitySet !== undefined
      : opts.runGrantWrite !== undefined;
  /** Bulk affordances render only when EVERY op kind the pack ships is
   *  writable — a partial "grant all" (conn written, cli skipped) would lie. */
  const bulkWritable = (entries: ReadonlyArray<GrantUniverseEntry>): boolean =>
    entries.length > 0 && entries.every(entryWritable);

  /** Derive the "Grant scope" radio from the cells: no doors / doors all off →
   *  You only; every cell on (self included — self is a contract) → All
   *  contracts; anything mixed → Selected. */
  const deriveScope = (entries: ReadonlyArray<GrantUniverseEntry>): GrantScopeValue => {
    const doors = contracts.filter((c) => !c.is_self);
    if (doors.length === 0 || entries.length === 0) return 'you_only';
    let doorsAllOff = true;
    let allOn = true;
    for (const contract of contracts) {
      for (const entry of entries) {
        const on = effectiveOf(entry, contract.contract_id) === 'on';
        if (on && !contract.is_self) doorsAllOff = false;
        if (!on) allOn = false;
      }
    }
    if (allOn) return 'all';
    if (doorsAllOff) return 'you_only';
    return 'selected';
  };

  /** Split a `cli.reachability.list` response per principal in one pass (the
   *  read is global; each contract row resolves against its own slice). */
  const splitCliRows = (
    rows: ReadonlyArray<{ principal: string; ingredient_id: string; operation_id: string; allowed: boolean }>,
  ): Map<string, ReadonlyMap<string, boolean>> => {
    const byPrincipal = new Map<string, Map<string, boolean>>();
    for (const row of rows) {
      const m = byPrincipal.get(row.principal) ?? new Map<string, boolean>();
      m.set(cliRowKey(row.ingredient_id, row.operation_id), row.allowed);
      byPrincipal.set(row.principal, m);
    }
    return byPrincipal;
  };

  // ── load (generation-guarded; per-contract grant reads iterated) ──
  const doRefresh = (): Promise<void> => {
    if (disposed || !enabled) return Promise.resolve();
    const gen = ++loadGeneration;
    loading = true;
    pendingLoad = (async () => {
      const [contractsR, catalogR, cliR] = await Promise.allSettled([
        (opts.runListContracts as GrantContractsCaller)(),
        (opts.runCatalogOperations as GrantCatalogOperationsCaller)(),
        opts.runCliReachabilityList
          ? opts.runCliReachabilityList()
          : Promise.resolve(undefined),
      ]);
      if (disposed || gen !== loadGeneration) return;

      const errors: string[] = [];
      // Self first, then ACTIVE ordinary standing doors in list order. Revoked /
      // expired doors are inert at the gate, and D-196 customer/template rows are
      // not generic pack-access principals unless a seller surface opts in later.
      const rows: ContractRow[] = [
        { contract_id: OWNER_CONTRACT_ID, display_name: COPY.self_label, is_self: true },
      ];
      if (contractsR.status === 'fulfilled') {
        for (const c of contractsR.value.contracts) {
          if (c.lifecycle_state !== 'active') continue;
          if (!isStandingContractDefinition(c)) continue;
          rows.push({
            contract_id: c.contract_id,
            display_name: c.display_name,
            is_self: false,
          });
        }
      } else {
        errors.push(humanizeRpcError(contractsR.reason));
      }

      if (catalogR.status === 'fulfilled') {
        universe = catalogOpUniverseEntries(catalogR.value.ingredients);
      } else {
        errors.push(humanizeRpcError(catalogR.reason));
      }

      if (cliR.status === 'fulfilled' && cliR.value !== undefined) {
        if (pendingCells.size === 0) {
          cliRowsByContract = splitCliRows(cliR.value.rows);
        }
      }
      // A failed/absent cli read is SOFT — cli ops fall back to fail-closed off.

      // The per-contract grant reads — #4's iterate-reads resolution. Settled
      // in parallel; a contract whose read failed keeps its PRIOR rows (or
      // empty) and contributes an error line. A write reconciling concurrently
      // is authoritative — carry the live maps forward (the grants panel's
      // pending-cell carry-forward, per-controller form).
      const reads = await Promise.allSettled(
        rows.map((r) =>
          (opts.runGrantRead as GrantReadCaller)({ contract_id: r.contract_id }),
        ),
      );
      if (disposed || gen !== loadGeneration) return;
      if (pendingCells.size === 0) {
        const next = new Map<string, ReadonlyMap<string, boolean>>();
        rows.forEach((r, i) => {
          const read = reads[i];
          if (read !== undefined && read.status === 'fulfilled') {
            const m = new Map<string, boolean>();
            for (const g of read.value.grants) m.set(g.entry_key, g.granted);
            next.set(r.contract_id, m);
          } else {
            next.set(r.contract_id, grantsFor(r.contract_id));
            if (read !== undefined) errors.push(humanizeRpcError(read.reason));
          }
        });
        grantsByContract = next;
      }

      contracts = rows;
      loading = false;
      error = errors.length > 0 ? errors.join('; ') : null;
      opts.onChange();
    })();
    return pendingLoad;
  };

  // ── write-then-reconcile (mirrors the by-CONTRACT panel's runToggle) ──
  const reloadContractGrants = async (contractId: string): Promise<void> => {
    const res = await (opts.runGrantRead as GrantReadCaller)({ contract_id: contractId });
    if (disposed) return;
    const m = new Map<string, boolean>();
    for (const g of res.grants) m.set(g.entry_key, g.granted);
    const next = new Map(grantsByContract);
    next.set(contractId, m);
    grantsByContract = next;
  };

  const reloadCliRows = async (): Promise<void> => {
    if (opts.runCliReachabilityList === undefined) return;
    const res = await opts.runCliReachabilityList();
    if (disposed) return;
    cliRowsByContract = splitCliRows(res.rows);
  };

  const runToggle = async (contractId: string, entryKey: string): Promise<void> => {
    const key = cellKey(contractId, entryKey);
    if (pendingCells.has(key)) return;
    const entry = universe.find((e) => e.entry_key === entryKey);
    if (entry === undefined) return;
    const cli = entry.cli;
    if (cli !== undefined && opts.runCliReachabilitySet === undefined) return;
    if (cli === undefined && opts.runGrantWrite === undefined) return;

    // Toggle relative to the current EFFECTIVE state (the same shared resolver
    // the cell renders), writing the explicit boolean — unambiguous +
    // idempotent; the gate reads `explicit ?? default` either way.
    const target =
      effectiveGrantState(entry, contractId, grantsFor(contractId), cliRowsFor(contractId))
      !== 'on';

    pendingCells.add(key);
    // Invalidate any in-flight full load so its snapshot can't clobber the
    // reconciling re-read below (the write-epoch idiom).
    loadGeneration += 1;
    if (error !== null) error = null;
    opts.onChange();
    try {
      if (cli !== undefined) {
        // CLI op — the cli_reachability allowlist (principal = contractId),
        // NOT contract_grant. `operation_id` is the manifest MAP KEY.
        await (opts.runCliReachabilitySet as GrantCliReachabilitySetCaller)({
          principal: contractId,
          ingredient_id: cli.ingredientId,
          operation_id: cli.operationKey,
          allowed: target,
        });
        if (disposed) return;
        await reloadCliRows();
      } else {
        await (opts.runGrantWrite as GrantWriteCaller)({
          contract_id: contractId,
          entry_key: entryKey,
          granted: target,
        });
        if (disposed) return;
        await reloadContractGrants(contractId);
      }
    } catch (err) {
      if (disposed) return;
      error = humanizeRpcError(err);
    } finally {
      pendingCells.delete(key);
      // Write-epoch backstop: a refresh that STARTED during this write is
      // invalidated and can't apply a pre-reconcile snapshot.
      loadGeneration += 1;
      if (!disposed) opts.onChange();
    }
  };

  // ── R3b bulk runner — the single-cell write path, fanned out ──────
  // Each cell writes exactly what its own toggle would (explicit boolean /
  // cli set); cells already at the target EFFECTIVE state are skipped, so a
  // redundant bulk is zero writes. Same pending / write-epoch / reconcile
  // idioms as `runToggle`, held across the whole fan-out.
  const runBulk = async (
    cells: ReadonlyArray<{ contractId: string; entry: GrantUniverseEntry }>,
    grant: boolean,
  ): Promise<void> => {
    if (disposed || bulkPending) return;
    const work = cells.filter(
      ({ contractId, entry }) =>
        entryWritable(entry)
        && !pendingCells.has(cellKey(contractId, entry.entry_key))
        && (effectiveOf(entry, contractId) === 'on') !== grant,
    );
    if (work.length === 0) {
      // Nothing to write — repaint anyway so a derived-noop radio click
      // snaps the DOM back to the derived state.
      opts.onChange();
      return;
    }

    bulkPending = true;
    for (const w of work) pendingCells.add(cellKey(w.contractId, w.entry.entry_key));
    // Invalidate any in-flight full load so its snapshot can't clobber the
    // reconciling re-reads below (the write-epoch idiom).
    loadGeneration += 1;
    if (error !== null) error = null;
    opts.onChange();

    const failures: string[] = [];
    try {
      const writes = await Promise.allSettled(
        work.map(async ({ contractId, entry }) => {
          const cli = entry.cli;
          if (cli !== undefined) {
            await (opts.runCliReachabilitySet as GrantCliReachabilitySetCaller)({
              principal: contractId,
              ingredient_id: cli.ingredientId,
              operation_id: cli.operationKey,
              allowed: grant,
            });
          } else {
            await (opts.runGrantWrite as GrantWriteCaller)({
              contract_id: contractId,
              entry_key: entry.entry_key,
              granted: grant,
            });
          }
        }),
      );
      if (disposed) return;
      for (const r of writes) {
        if (r.status === 'rejected') failures.push(humanizeRpcError(r.reason));
      }

      // Reconcile every touched store — server truth wins even after a
      // partial failure (the succeeded writes are live at the gate).
      const touchedContracts = [
        ...new Set(
          work.filter((w) => w.entry.cli === undefined).map((w) => w.contractId),
        ),
      ];
      const touchedCli = work.some((w) => w.entry.cli !== undefined);
      const reconciles = await Promise.allSettled([
        ...touchedContracts.map((id) => reloadContractGrants(id)),
        ...(touchedCli ? [reloadCliRows()] : []),
      ]);
      if (disposed) return;
      for (const r of reconciles) {
        if (r.status === 'rejected') failures.push(humanizeRpcError(r.reason));
      }
    } finally {
      for (const w of work) pendingCells.delete(cellKey(w.contractId, w.entry.entry_key));
      bulkPending = false;
      if (failures.length > 0) error = failures.join('; ');
      if (!disposed) {
        loadGeneration += 1;
        opts.onChange();
      }
    }
  };

  /** The scope radio's write action: You-only revokes every DOOR cell (self
   *  untouched — the label describes the doors, not you); All grants every
   *  cell including self; Selected is descriptive-only (writes nothing). */
  const runScopeChange = (manifest: BulkPackManifest, value: GrantScopeValue): void => {
    const entries = entriesForManifest(manifest);
    if (value === 'selected') {
      opts.onChange();
      return;
    }
    const cells: Array<{ contractId: string; entry: GrantUniverseEntry }> = [];
    for (const contract of contracts) {
      if (value === 'you_only' && contract.is_self) continue;
      for (const entry of entries) {
        cells.push({ contractId: contract.contract_id, entry });
      }
    }
    void runBulk(cells, value === 'all');
  };

  /** One contract's "[all ops ▾]" action. */
  const runContractBulk = (
    manifest: BulkPackManifest,
    contractId: string,
    grant: boolean,
  ): void => {
    const cells = entriesForManifest(manifest).map((entry) => ({
      contractId,
      entry,
    }));
    void runBulk(cells, grant);
  };

  // ── render ─────────────────────────────────────────────────────────
  const renderCell = (
    parent: HTMLElement,
    contractId: string,
    entry: GrantUniverseEntry,
  ): void => {
    const grants = grantsFor(contractId);
    const cliRows = cliRowsFor(contractId);
    const eff = effectiveGrantState(entry, contractId, grants, cliRows);
    const explicit = hasExplicitGrant(entry, grants, cliRows);
    const inFlight = pendingCells.has(cellKey(contractId, entry.entry_key));
    const inert =
      entry.cli !== undefined
        ? opts.runCliReachabilitySet === undefined
        : opts.runGrantWrite === undefined;

    const row = doc.createElement('label');
    row.setAttribute(PACK_ACCESS_CELL_ATTR, '');
    row.setAttribute('data-contract-id', contractId);
    row.setAttribute('data-entry', entry.entry_key);
    row.setAttribute('data-effective', eff);
    row.setAttribute('data-source', explicit ? 'explicit' : 'default');
    row.className = 'pa-cell';

    const box = doc.createElement('input');
    box.setAttribute('type', 'checkbox');
    box.setAttribute(PACK_ACCESS_CELL_TOGGLE_ATTR, '');
    box.setAttribute('data-contract-id', contractId);
    box.setAttribute('data-entry', entry.entry_key);
    box.setAttribute('data-effective', eff);
    box.className = 'pa-cell-box';
    box.checked = eff === 'on';
    if (inFlight || inert) box.setAttribute('disabled', '');
    else
      box.addEventListener('change', () => {
        void runToggle(contractId, entry.entry_key);
      });
    row.appendChild(box);

    const name = doc.createElement('span');
    name.className = 'pa-cell-name';
    name.textContent = entry.label;
    row.appendChild(name);

    const source = doc.createElement('span');
    source.className = 'pa-source';
    source.setAttribute('data-source', explicit ? 'explicit' : 'default');
    source.textContent = explicit ? COPY.source_set : COPY.source_default;
    row.appendChild(source);

    parent.appendChild(row);
  };

  // ── R3b render pieces ─────────────────────────────────────────────
  const renderScopeRow = (
    pack: PackListEntry,
    entries: ReadonlyArray<GrantUniverseEntry>,
  ): HTMLElement => {
    const scope = deriveScope(entries);
    const row = doc.createElement('div');
    row.setAttribute(PACK_ACCESS_SCOPE_ATTR, '');
    row.setAttribute('data-scope', scope);
    row.className = 'pa-scope';
    const label = doc.createElement('span');
    label.className = 'pa-scope-label';
    label.textContent = COPY.scope_label;
    row.appendChild(label);

    const options: Array<{ value: GrantScopeValue; label: string; title?: string }> = [
      { value: 'you_only', label: COPY.scope_you_only },
      { value: 'selected', label: COPY.scope_selected, title: COPY.scope_selected_title },
      { value: 'all', label: COPY.scope_all },
    ];
    for (const opt of options) {
      const wrap = doc.createElement('label');
      wrap.className = 'pa-scope-option';
      if (opt.title !== undefined) wrap.title = opt.title;
      const radio = doc.createElement('input');
      radio.setAttribute('type', 'radio');
      radio.setAttribute('name', `pa-scope-${pack.slug}`);
      radio.setAttribute(PACK_ACCESS_SCOPE_RADIO_ATTR, '');
      radio.setAttribute('data-scope-value', opt.value);
      radio.className = 'pa-scope-radio';
      radio.checked = scope === opt.value;
      // "Selected" stays enabled as the descriptive resting state; its click
      // writes nothing and just repaints back to the derived value.
      if (bulkPending) {
        radio.setAttribute('disabled', '');
      } else {
        radio.addEventListener('change', () => {
          runScopeChange(pack.manifest, opt.value);
        });
      }
      wrap.appendChild(radio);
      const text = doc.createElement('span');
      text.textContent = opt.label;
      wrap.appendChild(text);
      row.appendChild(wrap);
    }
    return row;
  };

  const renderAllOpsSelect = (
    pack: PackListEntry,
    contractId: string,
  ): HTMLElement => {
    const select = doc.createElement('select') as HTMLSelectElement;
    select.setAttribute(PACK_ACCESS_ALL_OPS_ATTR, '');
    select.setAttribute('data-contract-id', contractId);
    select.className = 'pa-all-ops';
    const placeholder = doc.createElement('option') as HTMLOptionElement;
    placeholder.setAttribute('value', '');
    placeholder.textContent = COPY.all_ops_placeholder;
    select.appendChild(placeholder);
    const grantAll = doc.createElement('option') as HTMLOptionElement;
    grantAll.setAttribute('value', 'grant_all');
    grantAll.textContent = COPY.all_ops_grant;
    select.appendChild(grantAll);
    const revokeAll = doc.createElement('option') as HTMLOptionElement;
    revokeAll.setAttribute('value', 'revoke_all');
    revokeAll.textContent = COPY.all_ops_revoke;
    select.appendChild(revokeAll);
    select.value = '';
    if (bulkPending) select.setAttribute('disabled', '');
    else
      select.addEventListener('change', () => {
        const value = select.value;
        if (value !== 'grant_all' && value !== 'revoke_all') return;
        runContractBulk(pack.manifest, contractId, value === 'grant_all');
      });
    return select;
  };

  const renderAddAffordance = (
    pack: PackListEntry,
    entries: ReadonlyArray<GrantUniverseEntry>,
  ): HTMLElement => {
    const wrap = doc.createElement('div');
    wrap.className = 'pa-add';
    const isOpen = addPickerOpenFor === pack.slug;
    const button = doc.createElement('button');
    button.setAttribute('type', 'button');
    button.setAttribute(PACK_ACCESS_ADD_ATTR, '');
    button.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    button.className = 'pa-add-button';
    button.textContent = COPY.add_label;
    if (bulkPending) button.setAttribute('disabled', '');
    else
      button.addEventListener('click', () => {
        addPickerOpenFor = isOpen ? null : pack.slug;
        opts.onChange();
      });
    wrap.appendChild(button);
    if (!isOpen) return wrap;

    const doors = contracts.filter((c) => !c.is_self);
    // A door with every cell already on has nothing left to grant.
    const candidates = doors.filter((c) =>
      entries.some((e) => effectiveOf(e, c.contract_id) === 'off'),
    );
    if (candidates.length === 0) {
      const empty = doc.createElement('p');
      empty.setAttribute(PACK_ACCESS_ADD_EMPTY_ATTR, '');
      empty.className = 'pa-add-empty';
      if (doors.length === 0) {
        empty.textContent = `${COPY.add_empty_no_doors} `;
        const link = doc.createElement('a');
        link.className = 'rx-link';
        link.setAttribute('href', '#contracts');
        link.textContent = COPY.add_empty_no_doors_link;
        empty.appendChild(link);
      } else {
        empty.textContent = COPY.add_empty_all_granted;
      }
      wrap.appendChild(empty);
      return wrap;
    }

    const picker = doc.createElement('select') as HTMLSelectElement;
    picker.setAttribute(PACK_ACCESS_ADD_PICKER_ATTR, '');
    picker.className = 'pa-add-picker';
    const placeholder = doc.createElement('option') as HTMLOptionElement;
    placeholder.setAttribute('value', '');
    placeholder.textContent = COPY.add_placeholder;
    picker.appendChild(placeholder);
    for (const c of candidates) {
      const option = doc.createElement('option') as HTMLOptionElement;
      option.setAttribute('value', c.contract_id);
      option.textContent = c.display_name;
      picker.appendChild(option);
    }
    picker.value = '';
    // An already-open picker must ALSO go inert during a bulk fan-out (codex
    // R3b MEDIUM) — a live listener here would close/expand as if accepted
    // while runBulk early-returns on bulkPending, silently writing nothing.
    if (bulkPending) picker.setAttribute('disabled', '');
    else
      picker.addEventListener('change', () => {
        const contractId = picker.value;
        if (contractId === '' || !candidates.some((c) => c.contract_id === contractId)) {
          return;
        }
        addPickerOpenFor = null;
        expanded.add(contractId);
        runContractBulk(pack.manifest, contractId, true);
      });
    wrap.appendChild(picker);
    return wrap;
  };

  const renderForPack = (pack: PackListEntry): HTMLElement | null => {
    if (!enabled) return null;
    const entries = entriesForManifest(pack.manifest);
    // Recipe-only / cli-less pack with no catalog ops — nothing to grant; the
    // detail keeps its placeholder copy. (While the first load is still in
    // flight the universe is empty too — same fallback, repainted onChange.)
    // A load ERROR is the exception (codex R3 LOW): a failed catalog read
    // leaves the universe empty too, and silently showing the placeholder
    // would hide the access-load failure — surface the error panel instead.
    if (entries.length === 0 && error === null) return null;

    const section = doc.createElement('div');
    section.setAttribute(PACK_ACCESS_ATTR, pack.slug);
    section.className = 'pa-panel';

    if (error !== null) {
      const err = doc.createElement('p');
      err.setAttribute(PACK_ACCESS_ERROR_ATTR, '');
      err.setAttribute('role', 'alert');
      err.className = 'pa-error';
      err.textContent = error;
      section.appendChild(err);
    }
    if (loading && contracts.length === 0) {
      const line = doc.createElement('p');
      line.setAttribute(PACK_ACCESS_LOADING_ATTR, '');
      line.className = 'pa-loading';
      line.textContent = COPY.loading;
      section.appendChild(line);
      return section;
    }
    // Error-only render (empty universe after a failed catalog read) — the
    // contract groups would all be hollow "0 of 0" rows; the error line is
    // the whole message.
    if (entries.length === 0) return section;

    // R3b — bulk affordances (scope radio included) only when every op kind
    // the pack ships has its writer wired; otherwise the panel keeps the
    // plain R3 per-cell look (codex R3b LOW — a disabled radio row would
    // contradict the render-only-when-writable invariant).
    const bulkOk = bulkWritable(entries);
    if (bulkOk) section.appendChild(renderScopeRow(pack, entries));

    for (const contract of contracts) {
      const isExpanded = expanded.has(contract.contract_id);
      const group = doc.createElement('div');
      group.setAttribute(PACK_ACCESS_CONTRACT_ATTR, '');
      group.setAttribute('data-contract-id', contract.contract_id);
      group.setAttribute('data-expanded', isExpanded ? 'true' : 'false');
      group.className = 'pa-contract';

      // Header — expand/collapse + name + "N of M" summary.
      let on = 0;
      for (const e of entries) {
        if (
          effectiveGrantState(
            e,
            contract.contract_id,
            grantsFor(contract.contract_id),
            cliRowsFor(contract.contract_id),
          ) === 'on'
        ) {
          on += 1;
        }
      }
      // The head row: the expand/collapse button, plus (expanded + writable)
      // the "[all ops]" bulk select as a SIBLING — a select nested inside the
      // toggle button would be invalid and its clicks would collapse the row.
      const head = doc.createElement('div');
      head.className = 'pa-contract-head';
      const header = doc.createElement('button');
      header.setAttribute('type', 'button');
      header.setAttribute(PACK_ACCESS_CONTRACT_TOGGLE_ATTR, '');
      header.setAttribute('data-contract-id', contract.contract_id);
      header.setAttribute('aria-expanded', isExpanded ? 'true' : 'false');
      header.className = 'pa-contract-header';
      const chevron = doc.createElement('span');
      chevron.className = 'pa-chevron';
      chevron.textContent = isExpanded ? '▾' : '▸';
      header.appendChild(chevron);
      const name = doc.createElement('span');
      name.className = contract.is_self ? 'pa-contract-name pa-self' : 'pa-contract-name';
      name.textContent = contract.display_name;
      header.appendChild(name);
      const summary = doc.createElement('span');
      summary.setAttribute(PACK_ACCESS_SUMMARY_ATTR, '');
      summary.className = 'pa-summary';
      summary.textContent = `${on} of ${entries.length}`;
      header.appendChild(summary);
      header.addEventListener('click', () => {
        if (expanded.has(contract.contract_id)) expanded.delete(contract.contract_id);
        else expanded.add(contract.contract_id);
        opts.onChange();
      });
      head.appendChild(header);
      if (isExpanded && bulkOk) {
        head.appendChild(renderAllOpsSelect(pack, contract.contract_id));
      }
      group.appendChild(head);

      if (isExpanded) {
        const body = doc.createElement('div');
        body.className = 'pa-contract-body';
        for (const entry of entries) renderCell(body, contract.contract_id, entry);
        group.appendChild(body);
      }
      section.appendChild(group);
    }
    if (bulkOk) section.appendChild(renderAddAffordance(pack, entries));
    return section;
  };

  // ── live coherence ──────────────────────────────────────────────
  const broadcastUnsubscribers: Array<() => void> = [];
  if (opts.subscribe && enabled) {
    broadcastUnsubscribers.push(
      opts.subscribe('contract.contract_definition_changed', () => {
        if (disposed) return;
        void doRefresh();
      }),
    );
  }

  return {
    get enabled() {
      return enabled;
    },
    refresh: () => doRefresh(),
    renderForPack,
    whenLoaded: () => pendingLoad,
    effectiveFor: (contractId, entryKey) => {
      const entry = universe.find((e) => e.entry_key === entryKey);
      if (entry === undefined) return 'off';
      return effectiveGrantState(entry, contractId, grantsFor(contractId), cliRowsFor(contractId));
    },
    contractIds: () => contracts.map((c) => c.contract_id),
    dispose: () => {
      if (disposed) return;
      disposed = true;
      for (const unsub of broadcastUnsubscribers) {
        try {
          unsub();
        } catch {
          /* never throw out of dispose */
        }
      }
      broadcastUnsubscribers.length = 0;
    },
  };
};

// ════════════════════════════════════════════════════════════════
// Styles — joined into the packs route's style bundle (mirrors the
// connections-readiness styles pipe).
// ════════════════════════════════════════════════════════════════

export const PACK_ACCESS_STYLES = `
[${PACK_ACCESS_ATTR}] {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
[${PACK_ACCESS_ATTR}] .pa-loading {
  margin: 0;
  font-size: 13px;
  color: var(--fg-muted);
}
[${PACK_ACCESS_ATTR}] .pa-error {
  margin: 0;
  padding: 6px 8px;
  background: var(--danger-bg);
  color: var(--danger);
  border-radius: 4px;
  font-size: 12px;
  word-break: break-word;
}
[${PACK_ACCESS_ATTR}] .pa-scope {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  font-size: 12px;
  color: var(--fg);
  padding: 2px 0 4px;
}
[${PACK_ACCESS_ATTR}] .pa-scope-label {
  color: var(--fg-muted);
}
[${PACK_ACCESS_ATTR}] .pa-scope-option {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  cursor: pointer;
}
[${PACK_ACCESS_ATTR}] .pa-scope-radio[disabled] {
  opacity: 0.6;
  cursor: default;
}
[${PACK_ACCESS_ATTR}] .pa-contract {
  border: 1px solid var(--border);
  border-radius: 4px;
}
[${PACK_ACCESS_ATTR}] .pa-contract-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-right: 10px;
}
[${PACK_ACCESS_ATTR}] .pa-contract-header {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1;
  min-width: 0;
  padding: 6px 10px;
  background: none;
  border: none;
  cursor: pointer;
  font-size: 13px;
  color: var(--fg);
  text-align: left;
}
[${PACK_ACCESS_ATTR}] .pa-all-ops {
  font-size: 11px;
  color: var(--fg-muted);
  background: none;
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 1px 4px;
}
[${PACK_ACCESS_ATTR}] .pa-all-ops[disabled] {
  opacity: 0.6;
}
[${PACK_ACCESS_ATTR}] .pa-add {
  display: flex;
  flex-direction: column;
  gap: 4px;
  align-items: flex-start;
}
[${PACK_ACCESS_ATTR}] .pa-add-button {
  background: none;
  border: none;
  padding: 2px 0;
  cursor: pointer;
  font-size: 12px;
  color: var(--accent, var(--fg));
  text-align: left;
}
[${PACK_ACCESS_ATTR}] .pa-add-button[disabled] {
  opacity: 0.6;
  cursor: default;
}
[${PACK_ACCESS_ATTR}] .pa-add-empty {
  margin: 0;
  font-size: 12px;
  color: var(--fg-muted);
}
[${PACK_ACCESS_ATTR}] .pa-add-picker {
  font-size: 12px;
  color: var(--fg);
  background: none;
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 2px 6px;
}
[${PACK_ACCESS_ATTR}] .pa-chevron {
  color: var(--fg-muted);
  font-size: 11px;
}
[${PACK_ACCESS_ATTR}] .pa-contract-name {
  font-weight: 600;
}
[${PACK_ACCESS_ATTR}] .pa-summary {
  margin-left: auto;
  font-size: 11px;
  color: var(--fg-muted);
  font-variant-numeric: tabular-nums;
}
[${PACK_ACCESS_ATTR}] .pa-contract-body {
  padding: 2px 10px 8px 24px;
}
[${PACK_ACCESS_ATTR}] .pa-cell {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 3px 0;
  cursor: pointer;
}
[${PACK_ACCESS_ATTR}] .pa-cell-box[disabled] {
  opacity: 0.6;
  cursor: default;
}
[${PACK_ACCESS_ATTR}] .pa-cell-name {
  font-size: 13px;
  font-family: var(--mono, ui-monospace, monospace);
}
[${PACK_ACCESS_ATTR}] .pa-source {
  margin-left: auto;
  font-size: 10px;
  color: var(--fg-muted);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
[${PACK_ACCESS_ATTR}] .pa-source[data-source='explicit'] {
  color: var(--accent, var(--fg));
}
`;
