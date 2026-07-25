/** D-166 contract_id lifecycle — top-level #contracts inventory.
 *
 *  The PWA surface that makes the `contract.contract_definition.*` lifecycle
 *  user-legible: it LISTS every minted contract (with its server-resolved
 *  `lifecycle_state` pill — active / revoked / expired / exhausted) and REVOKES
 *  one (the user's kill-switch over a scoped authorization).
 *
 *  ── D-171 slice 3b demotion (decision 7) ─────────────────────────────
 *  The standalone MINT form this panel used to host is REMOVED. Post-D-171 the
 *  only path that mints a `contract_definition` is the #contracts MCP door
 *  **Advanced** sub-panel (lazy cap/expiry — `permissions-panel.ts`), which mints
 *  + binds + revokes a single per-door limit contract. This panel is demoted to
 *  a read-only **inventory + kill-switch inspector**: list every minted contract
 *  and revoke any one. (Pre-launch, no migration — the mint UI is deleted
 *  outright rather than left dead.)
 *
 *  ── Revoking is the kill-switch — so it is deliberate + truthful ─────
 *  Revoke is a two-stage inline confirm (single row armed at a time, mirroring
 *  the Permissions / Devices panels): the first click arms "Confirm" / "Cancel";
 *  only the second commits. `revokeContract` RETURNS the revoked view, so a
 *  successful revoke OPTIMISTICALLY replaces the row with that view BEFORE the
 *  reconciling re-list — so even if that re-list fails or is superseded the panel
 *  shows the contract as revoked (it IS revoked server-side), never as still
 *  active. A revoke failure surfaces on the row's error chip and leaves the row
 *  intact. A revoked contract shows no Revoke control (nothing left to revoke).
 *
 *  ── Live broadcast subscription (D-171 `contract.contract_definition_changed`) ─
 *  `contract.contract_definition.*` writes are local-only (D-090/D-097/D-168) and
 *  don't ride pair-sync to the webclient; D-171 adds a dedicated D-121 broadcast
 *  kind `contract.contract_definition_changed`, emitted server-side on every
 *  `collection.contract.{mintContract, revokeContract}`. The `subscribe` seam keys
 *  a live re-list off it: when a limit is minted / revoked — here OR on another
 *  paired client — the inspector re-lists without a manual refresh. This is the
 *  authoritative signal; it REPLACES the slice-2c follow-on #2 token proxy
 *  (`chat.inbound_token_changed`), which fired off the door's paired
 *  `update_contract` op and so MISSED the trailing bare `revokeContract` of a
 *  prior limit (that revoke carries no token op). The stale-window residual
 *  logged there is now closed: every revoke — including the trailing one — fires
 *  this kind. When `subscribe` is unwired (test / no-bus harness) the panel still
 *  stays current via the post-revoke re-list + `refresh()`. The `loadGeneration`
 *  guard (shared discipline with the permissions / grant / packs panels) drops a
 *  stale in-flight list when a newer one overtakes it.
 *
 *  ── Render model: DOM nodes, not innerHTML ───────────────────────────
 *  The Revoke buttons carry real click listeners, so the panel rebuilds its
 *  content via `createElement` + `clearChildren` on every render (the same shape
 *  as `permissions-panel.ts`), not via an HTML string with `data-action`
 *  delegation.
 *
 *  Spec: D-166 §"contract_definition lifecycle"; the rpc shapes live
 *  in `packages/contracts/src/contract-definition.ts`. */

import {
  isCustomerContractGrantKind,
  type ContractDefinitionView,
  type ContractListRequest,
  type ContractLifecycleState,
  type ContractScope,
} from '@recued/contracts';

import type { BroadcastSubscriber } from '../realtime/subscriber.js';
import { humanizeRpcError } from '../shell/rpc-error-copy.js';

// ════════════════════════════════════════════════════════════════
// Caller seams + handle
// ════════════════════════════════════════════════════════════════

/** `collection.contract.listContracts` caller seam. Read-only — the panel never
 *  mutates the list, and the rpc's mutable `ContractDefinitionView[]` is
 *  assignable to the `ReadonlyArray`. */
export type ContractsListCaller = (
  args?: ContractListRequest,
) => Promise<{
  contracts: ReadonlyArray<ContractDefinitionView>;
  next_cursor?: string | null;
  total?: number;
}>;

/** `collection.contract.revokeContract` caller seam. Returns the revoked view,
 *  so the panel optimistically replaces the row before the reconciling re-list. */
export type ContractsRevokeCaller = (args: {
  contract_id: string;
  reason?: string;
}) => Promise<ContractDefinitionView>;

export type ContractsPanelState = 'loading' | 'ready' | 'error';

export interface MountContractsPanelOptions {
  /** Host element the panel renders into. The panel appends a single wrapper div
   *  + rebuilds its inner contents across state changes. `dispose()` drops it. */
  host: HTMLElement;
  /** DOM document seam. Defaults to `globalThis.document`. */
  document?: Document;
  /** `collection.contract.listContracts` caller seam. */
  runListContracts: ContractsListCaller;
  /** `collection.contract.revokeContract` caller seam. */
  runRevokeContract: ContractsRevokeCaller;
  /** D-171 slice-2c follow-on #2 — the D-121 broadcast subscribe seam
   *  (`subscriber.on`). When wired, the inspector re-lists its contracts on every
   *  `chat.inbound_token_changed` frame. There is no contract-specific bus event,
   *  but every MCP-door cap/expiry mint/revoke pairs a token `update_contract` op
   *  with the contract change (the door is post-D-171 the only minter), so that
   *  one kind is the proxy signal — keeping this inspector in sync with the
   *  #contracts MCP door Advanced sub-panel across paired clients. Optional —
   *  a no-bus harness leaves the panel on its re-list-after-revoke + `refresh()`
   *  path. */
  subscribe?: BroadcastSubscriber['on'];
}

export interface ContractsPanelMount {
  /** Current panel state — primary surface for tests + host introspection. */
  getState(): ContractsPanelState;
  /** The minted contracts in display order (server order: newest first). On a
   *  refresh failure the prior rows are RETAINED beneath the error chip, so this
   *  is empty only before the first successful load or after one that found
   *  zero contracts. */
  getContracts(): ReadonlyArray<ContractDefinitionView>;
  /** Top-level list-error message. Null when the last list succeeded (a per-row
   *  revoke failure lives on its row's chip, not here). */
  getListError(): string | null;
  /** Host-driven refresh — re-lists contracts. Returns the load promise. */
  refresh(): Promise<void>;
  /** Initial load promise — resolves after the most recent list settles. */
  whenLoaded(): Promise<void>;
  /** Revoke one contract — commits directly (the programmatic equivalent of the
   *  UI's arm-then-Confirm two-stage click). A no-op for an unknown row or a row
   *  with a revoke already in flight. Test seam + host convenience. */
  revokeContract(contractId: string, reason?: string): Promise<void>;
  /** Tear down the panel DOM. Idempotent. */
  dispose(): void;
}

// ════════════════════════════════════════════════════════════════
// Attribute constants — stable hooks for tests + the Settings shell
// ════════════════════════════════════════════════════════════════

/** Wrapper the panel owns inside the caller's host. */
export const CONTRACTS_PANEL_HOST_ATTR = 'data-recued-contracts-panel';
/** The loading line (first list in flight). */
export const CONTRACTS_PANEL_LOADING_ATTR = 'data-recued-contracts-loading';
/** The empty-state line (ready, zero contracts). */
export const CONTRACTS_PANEL_EMPTY_ATTR = 'data-recued-contracts-empty';
/** The top-level list-error chip (a `runListContracts` failure). */
export const CONTRACTS_PANEL_ERROR_ATTR = 'data-recued-contracts-error';
/** One contract row. Carries `data-contract-id` + `data-state`. */
export const CONTRACTS_ROW_ATTR = 'data-recued-contracts-row';
/** A row's lifecycle pill. Carries `data-state` (active/revoked/expired/exhausted). */
export const CONTRACTS_PILL_ATTR = 'data-recued-contracts-pill';
/** A row's Revoke button — first stage (arms the confirm) + the in-flight
 *  "Revoking…" disabled state. Carries `data-contract-id`. */
export const CONTRACTS_REVOKE_BUTTON_ATTR = 'data-recued-contracts-revoke';
/** The armed "Confirm" button (second stage — commits the revoke). */
export const CONTRACTS_REVOKE_CONFIRM_ATTR = 'data-recued-contracts-revoke-confirm';
/** The armed "Cancel" button (disarms without revoking). */
export const CONTRACTS_REVOKE_CANCEL_ATTR = 'data-recued-contracts-revoke-cancel';
/** A per-row revoke-error chip (a `revokeContract` failure scoped to one row). */
export const CONTRACTS_ROW_ERROR_ATTR = 'data-recued-contracts-row-error';
/** D-177 N.13 (P6c) — a grouped-inventory sub-header. Carries `data-group`
 *  (`standing` / `delegation` / `session` / `other`). Rendered only when the
 *  inventory holds more than one group — an all-standing inventory renders
 *  flat, byte-identical to pre-P6c. */
export const CONTRACTS_GROUP_HEADER_ATTR = 'data-recued-contracts-group-header';

// ════════════════════════════════════════════════════════════════
// Helpers
// ════════════════════════════════════════════════════════════════

interface InternalState {
  phase: ContractsPanelState;
  contracts: ReadonlyArray<ContractDefinitionView>;
  listError: string | null;
  /** Per-row revoke-error messages, keyed by `contract_id`. Reset on each
   *  successful list (a fresh inventory clears stale per-row errors). */
  rowErrors: ReadonlyMap<string, string>;
  /** The `contract_id` of the single row currently armed for revoke. Null when
   *  none is armed; arming one disarms any other. */
  confirmingId: string | null;
}

const errMessage = (err: unknown): string =>
  humanizeRpcError(err);

/** Format an epoch-ms timestamp as a short local date+time. Pure given the
 *  ambient locale (no clock read). */
const formatTimestamp = (ms: number): string => {
  const d = new Date(ms);
  // `toLocaleString` is locale/TZ-dependent; the panel only needs a legible
  // stamp, not a canonical one. A non-finite ms (shouldn't happen) → '—'.
  return Number.isFinite(ms) ? d.toLocaleString() : '—';
};

/** Format an epoch-ms expiry as a short local date (no time — expiry is authored
 *  at day granularity via the date input). */
const formatDate = (ms: number): string =>
  Number.isFinite(ms) ? new Date(ms).toLocaleDateString() : '—';

/** Human label for the non-wildcard scope axes — each as `axis: a, b`. A fully
 *  wildcard scope (every axis empty/absent) returns a single "Unrestricted" tag. */
const scopeFacets = (scope: ContractScope): string[] => {
  const parts: string[] = [];
  const axis = (
    label: string,
    values: ReadonlyArray<string> | undefined,
  ): void => {
    if (values !== undefined && values.length > 0) {
      parts.push(`${label}: ${values.join(', ')}`);
    }
  };
  axis('channels', scope.channels);
  axis('actors', scope.actors);
  axis('ingredients', scope.ingredient_ids);
  axis('operations', scope.operation_ids);
  axis('connections', scope.connection_names);
  return parts.length > 0 ? parts : ['Unrestricted scope (any channel / actor / ingredient)'];
};

/** The bound chips for a row — expiry + uses, each only when present.
 *
 *  D-177 P3 — a `grant_kind: 'session'` row (an approval-layer-minted
 *  session grant, N.3) leads with a `session grant` chip and renders its
 *  expiry at TIME precision: session TTLs are hours, so the day-granular
 *  date the standing-contract rows use would read as "expires today" for
 *  the grant's whole life. D-177 N.13 (P6c) — a `grant_kind: 'delegation'`
 *  row (a suggestion-accept-minted standing rule) leads with a
 *  `delegation rule` chip; its 30-day TTL reads fine at day precision.
 *  Standing rows render byte-identically to before. */
const boundFacets = (view: ContractDefinitionView): string[] => {
  const session = view.grant_kind === 'session';
  const parts: string[] = [];
  if (session) parts.push('session grant');
  if (view.grant_kind === 'delegation') parts.push('delegation rule');
  if (view.expiry_at !== undefined && view.expiry_at !== null) {
    parts.push(
      `expires ${session ? formatTimestamp(view.expiry_at) : formatDate(view.expiry_at)}`,
    );
  }
  if (view.max_uses !== undefined && view.max_uses !== null) {
    const remaining = view.uses_remaining ?? view.max_uses;
    parts.push(`uses ${remaining}/${view.max_uses}`);
  }
  return parts;
};

/** D-177 N.13 (P6c — the P6a codex LOW's panel half) — the inventory group a
 *  row files under. Standing = no gate-grant kind (or the explicit
 *  `'standing'` policy literal); unknown future `grant_kind` vocabulary on a
 *  JSON row deliberately files under `other`, never under standing (fail
 *  closed — same posture as the rpc filter). */
type InventoryGroup = 'standing' | 'delegation' | 'session' | 'other';

const inventoryGroupOf = (view: ContractDefinitionView): InventoryGroup => {
  const kind = view.grant_kind;
  if (kind === undefined || kind === null || kind === 'standing') return 'standing';
  if (kind === 'delegation') return 'delegation';
  if (kind === 'session') return 'session';
  return 'other';
};

const visibleInGenericContractsPanel = (view: ContractDefinitionView): boolean =>
  !isCustomerContractGrantKind(view.grant_kind);

/** Display order + headers for the grouped inventory. Standing contracts
 *  lead (the surface's namesake), then the gate-grant families. */
const INVENTORY_GROUPS: ReadonlyArray<{ group: InventoryGroup; header: string }> = [
  { group: 'standing', header: 'Standing contracts' },
  { group: 'delegation', header: 'Delegation rules' },
  { group: 'session', header: 'Session grants' },
  { group: 'other', header: 'Other grants' },
];

const PILL_LABEL: Record<ContractLifecycleState, string> = {
  active: 'Active',
  revoked: 'Revoked',
  expired: 'Expired',
  exhausted: 'Exhausted',
};

// ════════════════════════════════════════════════════════════════
// Mount
// ════════════════════════════════════════════════════════════════

export const mountContractsPanel = (
  opts: MountContractsPanelOptions,
): ContractsPanelMount => {
  const doc = opts.document ?? (globalThis as { document?: Document }).document;
  if (doc === undefined) {
    throw new Error(
      'mountContractsPanel: no document available — pass `opts.document` for non-browser environments',
    );
  }

  let state: InternalState = {
    phase: 'loading',
    contracts: [],
    listError: null,
    rowErrors: new Map(),
    confirmingId: null,
  };
  let disposed = false;
  // Bumped before every `runListContracts` await; the post-await write only lands
  // when its captured generation is still current. A revoke ALSO bumps it so a
  // slow list started before the revoke drops its now-stale write.
  let loadGeneration = 0;
  let pendingLoad: Promise<void> = Promise.resolve();
  // Rows with a revoke rpc in flight (keyed by `contract_id`). One revoke at a
  // time per row; while a row mutates its Revoke button renders disabled.
  const pendingById = new Set<string>();

  const root = doc.createElement('div');
  root.setAttribute(CONTRACTS_PANEL_HOST_ATTR, '');
  opts.host.appendChild(root);

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

  const appendChips = (
    parent: HTMLElement,
    className: string,
    chipClassName: string,
    labels: ReadonlyArray<string>,
  ): void => {
    if (labels.length === 0) return;
    const wrap = doc.createElement('div');
    wrap.className = className;
    for (const label of labels) {
      const chip = doc.createElement('span');
      chip.className = chipClassName;
      chip.textContent = label;
      wrap.appendChild(chip);
    }
    parent.appendChild(wrap);
  };

  const renderRow = (view: ContractDefinitionView): void => {
    const id = view.contract_id;

    const row = doc.createElement('div');
    row.setAttribute(CONTRACTS_ROW_ATTR, '');
    row.setAttribute('data-contract-id', id);
    row.setAttribute('data-state', view.lifecycle_state);
    row.className = 'ct-row';

    const info = doc.createElement('div');
    info.className = 'ct-row-info';

    // Heading: display name + lifecycle pill.
    const heading = doc.createElement('div');
    heading.className = 'ct-row-heading';
    const name = doc.createElement('span');
    name.className = 'ct-name';
    name.textContent = view.display_name;
    heading.appendChild(name);
    const pill = doc.createElement('span');
    pill.setAttribute(CONTRACTS_PILL_ATTR, '');
    pill.setAttribute('data-state', view.lifecycle_state);
    pill.className = `ct-pill ct-pill-${view.lifecycle_state}`;
    pill.textContent = PILL_LABEL[view.lifecycle_state];
    heading.appendChild(pill);
    info.appendChild(heading);

    // Provenance line: id + minted_by + minted_at.
    const meta = doc.createElement('div');
    meta.className = 'ct-meta';
    meta.textContent = `${id} · minted by ${view.minted_by} · ${formatTimestamp(view.minted_at)}`;
    info.appendChild(meta);

    // Scope + bound facets.
    appendChips(info, 'ct-facets', 'ct-facet', scopeFacets(view.scope));
    appendChips(info, 'ct-facets', 'ct-facet ct-facet-bound', boundFacets(view));

    // Revocation provenance (when revoked).
    if (view.revoked_at !== undefined && view.revoked_at !== null) {
      const revLine = doc.createElement('div');
      revLine.className = 'ct-revoked-line';
      const reason = view.revocation_reason ? ` — ${view.revocation_reason}` : '';
      revLine.textContent = `Revoked ${formatTimestamp(view.revoked_at)}${reason}`;
      info.appendChild(revLine);
    }

    row.appendChild(info);

    // Revoke control — only for a still-revocable contract (a revoked one has
    // nothing left to revoke). Two-stage: idle "Revoke" arms the confirm;
    // armed shows "Confirm"/"Cancel"; in-flight shows a disabled "Revoking…".
    if (view.lifecycle_state !== 'revoked') {
      const makeButton = (
        attr: string,
        className: string,
        text: string,
      ): HTMLElement => {
        const btn = doc.createElement('button');
        btn.setAttribute(attr, '');
        btn.setAttribute('type', 'button');
        btn.setAttribute('data-contract-id', id);
        btn.className = className;
        btn.textContent = text;
        return btn;
      };

      if (pendingById.has(id)) {
        const rev = makeButton(CONTRACTS_REVOKE_BUTTON_ATTR, 'ct-revoke', 'Revoking…');
        rev.setAttribute('disabled', '');
        row.appendChild(rev);
      } else if (state.confirmingId === id) {
        const controls = doc.createElement('div');
        controls.className = 'ct-confirm';
        const prompt = doc.createElement('span');
        prompt.className = 'ct-confirm-prompt';
        prompt.textContent = 'Revoke contract?';
        controls.appendChild(prompt);
        const confirm = makeButton(
          CONTRACTS_REVOKE_CONFIRM_ATTR,
          'ct-revoke ct-confirm-yes',
          'Confirm',
        );
        confirm.addEventListener('click', () => {
          void runRevoke(view);
        });
        controls.appendChild(confirm);
        const cancel = makeButton(
          CONTRACTS_REVOKE_CANCEL_ATTR,
          'ct-cancel',
          'Cancel',
        );
        cancel.addEventListener('click', () => {
          state = { ...state, confirmingId: null };
          render();
        });
        controls.appendChild(cancel);
        row.appendChild(controls);
      } else {
        const rev = makeButton(CONTRACTS_REVOKE_BUTTON_ATTR, 'ct-revoke', 'Revoke');
        rev.addEventListener('click', () => {
          state = { ...state, confirmingId: id };
          render();
        });
        row.appendChild(rev);
      }
    }

    const rowError = state.rowErrors.get(id);
    if (rowError !== undefined) {
      appendLine(
        row,
        CONTRACTS_ROW_ERROR_ATTR,
        'ct-row-error',
        `Could not revoke: ${rowError}`,
      );
    }

    root.appendChild(row);
  };

  const render = (): void => {
    if (disposed) return;
    clearChildren(root);

    // A list error surfaces as a chip ABOVE any still-visible rows.
    if (state.listError !== null) {
      appendLine(
        root,
        CONTRACTS_PANEL_ERROR_ATTR,
        'ct-error',
        `Could not load contracts: ${state.listError}`,
      );
    }

    if (state.contracts.length > 0) {
      // D-177 N.13 (P6c) — grouped inventory: standing contracts lead, then
      // delegation rules / session grants (the P6a codex LOW: grant rows out
      // of the standing listing, into their own sections — server order
      // preserved within each group). Headers render only when more than one
      // group is present, so an all-standing inventory stays flat.
      const groups = new Map<InventoryGroup, ContractDefinitionView[]>();
      for (const view of state.contracts) {
        const group = inventoryGroupOf(view);
        const bucket = groups.get(group);
        if (bucket === undefined) groups.set(group, [view]);
        else bucket.push(view);
      }
      const showHeaders = groups.size > 1;
      for (const { group, header } of INVENTORY_GROUPS) {
        const bucket = groups.get(group);
        if (bucket === undefined) continue;
        if (showHeaders) {
          const head = doc.createElement('div');
          head.setAttribute(CONTRACTS_GROUP_HEADER_ATTR, '');
          head.setAttribute('data-group', group);
          head.className = 'ct-group-header';
          head.textContent = header;
          root.appendChild(head);
        }
        for (const view of bucket) renderRow(view);
      }
      return;
    }

    if (state.phase === 'loading') {
      appendLine(root, CONTRACTS_PANEL_LOADING_ATTR, 'ct-loading', 'Loading contracts…');
      return;
    }
    if (state.phase === 'ready') {
      appendLine(
        root,
        CONTRACTS_PANEL_EMPTY_ATTR,
        'ct-empty',
        'No contracts. A contract is a scoped, revocable authorization you grant an AI agent or session; minted contracts appear here.',
      );
    }
    // phase === 'error' with zero rows → the error chip above is the whole surface.
  };

  const doRefresh = (): Promise<void> => {
    const gen = ++loadGeneration;
    pendingLoad = (async () => {
      try {
        const { contracts } = await opts.runListContracts();
        if (disposed || gen !== loadGeneration) return; // stale / torn down
        // Spread `...state` so a re-list preserves the mint-form draft (only the
        // inventory-related facets reset here).
        state = {
          ...state,
          phase: 'ready',
          contracts: contracts.filter(visibleInGenericContractsPanel),
          listError: null,
          rowErrors: new Map(),
          confirmingId: null,
        };
        render();
      } catch (err) {
        if (disposed || gen !== loadGeneration) return;
        // Keep any currently-visible rows; surface the error as a chip.
        state = { ...state, phase: 'error', listError: errMessage(err) };
        render();
      }
    })();
    return pendingLoad;
  };

  /** Revoke one contract. On success replaces the row with the returned (revoked)
   *  view + re-lists; on failure surfaces the message on the row's error chip.
   *  `reason` is optional — the UI's Confirm button passes none (the server stamps
   *  a default); the programmatic handle threads a caller-supplied reason. */
  const runRevoke = async (
    view: ContractDefinitionView,
    reason?: string,
  ): Promise<void> => {
    const id = view.contract_id;
    if (pendingById.has(id)) return;
    pendingById.add(id);
    // Invalidate any in-flight list so its (pre-revoke) write can't clobber this
    // revoke's post-revoke re-list.
    loadGeneration += 1;
    const startErrors = new Map(state.rowErrors);
    startErrors.delete(id);
    state = {
      ...state,
      rowErrors: startErrors,
      confirmingId: state.confirmingId === id ? null : state.confirmingId,
    };
    render();
    try {
      const revoked = await opts.runRevokeContract({
        contract_id: id,
        ...(reason !== undefined ? { reason } : {}),
      });
      if (disposed) return;
      pendingById.delete(id);
      // Optimistically replace the row with the revoked view — the rpc is the
      // authority for this contract's state now. Keeps the inventory truthful
      // even if the reconciling re-list below fails or is superseded; a revoked
      // contract must never render as still-active on this security surface.
      state = {
        ...state,
        contracts: state.contracts.map((c) =>
          c.contract_id === id ? revoked : c,
        ),
      };
      await doRefresh();
    } catch (err) {
      if (disposed) return;
      const next = new Map(state.rowErrors);
      next.set(id, errMessage(err));
      state = { ...state, rowErrors: next };
    } finally {
      pendingById.delete(id);
      if (!disposed) render();
    }
  };

  // ── D-171 — live cross-panel coherence off the authoritative contract event ─
  // Re-list whenever a `contract_definition` is minted / revoked (here or on
  // another paired client). The kind fires ONLY on the lifecycle mutators, so
  // every frame is a contract-touching signal — re-list unconditionally (no
  // op-filtering needed; the kind itself is the filter, unlike the prior token
  // proxy that had to skip pure grant/chat edits). Crucially this fires on the
  // trailing bare `revokeContract` too, closing the slice-2c follow-on #2 stale
  // window. The re-list is `loadGeneration`-guarded, so a broadcast landing
  // mid-revoke can't clobber the optimistic revoked-row write. Mirrors the packs
  // panel's subscribe/dispose discipline (unsubscribe first).
  const broadcastUnsubscribers: Array<() => void> = [];
  if (opts.subscribe) {
    broadcastUnsubscribers.push(
      opts.subscribe('contract.contract_definition_changed', () => {
        if (disposed) return;
        void doRefresh();
      }),
    );
  }

  // ── Initial paint + seed load ────────────────────────────────────
  render();
  void doRefresh();

  return {
    getState: () => state.phase,
    getContracts: () => state.contracts,
    getListError: () => state.listError,
    refresh: () => doRefresh(),
    whenLoaded: () => pendingLoad,
    revokeContract: async (contractId, reason) => {
      const view = state.contracts.find((c) => c.contract_id === contractId);
      // No-op for an unknown row (a row already revoking is guarded inside
      // runRevoke). The programmatic path threads `reason` through verbatim.
      if (view === undefined) return;
      await runRevoke(view, reason);
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      // Drop broadcast subscriptions BEFORE detaching so an in-flight listener
      // can't render into a removed tree; swallow per-handle teardown failures
      // (the subscriber owns its teardown — a throw must not abort our dispose).
      for (const unsub of broadcastUnsubscribers) {
        try {
          unsub();
        } catch {
          /* swallow per-handle teardown failures */
        }
      }
      broadcastUnsubscribers.length = 0;
      try {
        opts.host.removeChild(root);
      } catch {
        // Some fake DOMs / a detached host throw on removeChild; ignore.
      }
    },
  };
};

// ════════════════════════════════════════════════════════════════
// Styles
// ════════════════════════════════════════════════════════════════

/** Self-scoped CSS for the Contracts section, scoped under
 *  `[data-recued-contracts-panel]` so the rules are inert when the section
 *  isn't mounted. The settings route joins this into its one `<style>` bundle
 *  (mirrors `PERMISSIONS_PANEL_STYLES`). */
export const CONTRACTS_PANEL_STYLES = `
[data-recued-contracts-panel] .ct-loading,
[data-recued-contracts-panel] .ct-empty {
  font-size: 13px;
  color: var(--muted);
  padding: 6px 2px;
}
[data-recued-contracts-panel] .ct-error,
[data-recued-contracts-panel] .ct-row-error {
  font-size: 13px;
  color: var(--fail);
  padding: 6px 2px;
}
[data-recued-contracts-panel] [${CONTRACTS_ROW_ATTR}] {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 12px;
  margin: 8px 0;
  flex-wrap: wrap;
}
[data-recued-contracts-panel] [${CONTRACTS_ROW_ATTR}][data-state="revoked"],
[data-recued-contracts-panel] [${CONTRACTS_ROW_ATTR}][data-state="expired"],
[data-recued-contracts-panel] [${CONTRACTS_ROW_ATTR}][data-state="exhausted"] {
  opacity: 0.7;
}
[data-recued-contracts-panel] .ct-row-info {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
[data-recued-contracts-panel] .ct-row-heading {
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex-wrap: wrap;
}
[data-recued-contracts-panel] .ct-name {
  font-size: 14px;
  font-weight: 600;
}
[data-recued-contracts-panel] .ct-pill {
  font-size: 11px;
  font-weight: 600;
  padding: 1px 8px;
  border-radius: 999px;
  text-transform: uppercase;
  letter-spacing: 0.03em;
}
[data-recued-contracts-panel] .ct-pill-active {
  background: var(--ok-subtle);
  color: var(--ok);
}
[data-recued-contracts-panel] .ct-pill-revoked {
  background: var(--fail-subtle);
  color: var(--fail);
}
[data-recued-contracts-panel] .ct-pill-expired,
[data-recued-contracts-panel] .ct-pill-exhausted {
  background: var(--surface-subtle);
  color: var(--muted);
}
[data-recued-contracts-panel] .ct-meta {
  font-size: 11px;
  color: var(--muted);
  font-family: var(--mono, ui-monospace, monospace);
}
[data-recued-contracts-panel] .ct-group-header {
  font-size: 12px;
  font-weight: 650;
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  margin: 14px 0 2px;
}
[data-recued-contracts-panel] .ct-facets {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
[data-recued-contracts-panel] .ct-facet {
  font-size: 11px;
  padding: 1px 8px;
  border-radius: 999px;
  background: var(--surface-subtle);
  color: var(--muted);
}
[data-recued-contracts-panel] .ct-facet-bound {
  background: var(--accent-subtle);
  color: var(--accent);
}
[data-recued-contracts-panel] .ct-revoked-line {
  font-size: 12px;
  color: var(--fail);
}
[data-recued-contracts-panel] .ct-revoke {
  font-size: 13px;
  padding: 4px 12px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface);
  color: var(--fail);
  cursor: pointer;
  white-space: nowrap;
}
[data-recued-contracts-panel] .ct-revoke[disabled] {
  opacity: 0.6;
  cursor: default;
}
[data-recued-contracts-panel] .ct-confirm {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
[data-recued-contracts-panel] .ct-confirm-prompt {
  font-size: 12px;
  color: var(--fail);
  white-space: nowrap;
}
[data-recued-contracts-panel] .ct-confirm-yes {
  border-color: var(--fail);
}
[data-recued-contracts-panel] .ct-cancel {
  font-size: 13px;
  padding: 4px 12px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface);
  cursor: pointer;
  white-space: nowrap;
}
`;
