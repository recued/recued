/** D-182 §7.2 — the "Local tools" reachability surface.
 *
 *  A `cli` op (whisper / ffmpeg / magick / docling) is connection-LESS and §8
 *  forbids exposing it as a RAW door tool, but a recipe TRIGGERED by a contract
 *  may internally shell out to the binary. The owner controls THAT per-contract:
 *  "this door may trigger recipes, but none of its recipes may run `whisper`'s
 *  `transcribe` op." This panel is the surface for that control — the (contract ×
 *  pack-op) reachability allowlist (absent ⇒ denied, fail-closed), the SAME grant
 *  shape every other pack-op uses.
 *
 *  ── R22.4: a contract-first NESTED LIST of ops, not a 2-D grid ────────
 *  Ops AND contracts are both unbounded, so neither is a column. The surface is a
 *  contract-first list: Owner (you) FIRST + expanded, then each active door/agent
 *  contract (collapsible, with an "N of M granted" summary; a new contract starts
 *  fail-closed off). Under each contract, the installed cli tools, and under each
 *  tool its callable ops — one per-op toggle each. Risk tier is NOT an axis: it
 *  demotes to a per-op badge + an "asks" mark (write/destructive → the per-action
 *  approval still gates the dispatch, so no toggle hands silent unattended
 *  execution).
 *
 *  ── One op = one reachability row ────────────────────────────────────
 *  An op toggle is exactly ONE allowlist row `(principal, catalog_slug,
 *  operation_id)` — no fan-out, no mixed/indeterminate state. Granting writes
 *  `cli.reachability.set` with `allowed: true`; revoking with `allowed: false`
 *  (back to the fail-closed default). A reconciling re-list follows every write.
 *
 *  ── The three reads it joins ──────────────────────────────────────────
 *  The panel is STATELESS (spec §7.2): it realtime-enumerates the inputs and
 *  derives every op state, holding no aggregate "settings" of its own.
 *    1. `cli.reachability.universe` — the installed cli TOOLS, each with its
 *       callable ops (`operations`: `{ operation_id, catalog_slug, risk_tier }`).
 *    2. `cli.reachability.list` — every granted row (the allowlist).
 *    3. `collection.contract.listContracts` — the contract rows: Owner
 *       (`user_self`) + each active door/agent contract. **No baseline row** — a
 *       new contract appears only once minted, fail-closed (off).
 *
 *  ── Per-contract "Disable all" kill-switch ───────────────────────────
 *  A two-stage emergency off per contract clears every granted op for that
 *  principal across all tools (the contract-first analogue of the old per-tool
 *  kill-switch). Bulk GRANT is deliberately absent — only the fail-closed
 *  direction (revoke) is a bulk affordance; a grant is always an explicit per-op
 *  choice.
 *
 *  ── Render model: DOM nodes, not innerHTML ───────────────────────────
 *  Checkboxes + buttons carry real listeners, so the panel rebuilds via
 *  `createElement` + `clearChildren` on every render (the same shape as
 *  `contracts-panel.ts`), not via an HTML string with `data-action` delegation.
 *
 *  Spec: D-182 §7.2; the rpc shapes live in
 *  `packages/contracts/src/cli-reachability-rpc.ts`. */

import {
  CLI_REACHABILITY_OWNER_PRINCIPAL,
  isStandingContractDefinition,
  riskTierLabel,
  type CliReachabilityListResponse,
  type CliReachabilitySetRequest,
  type CliReachabilitySetResponse,
  type CliReachabilityUniverseResponse,
  type CliToolGridEntry,
  type CliToolOpEntry,
  type ContractDefinitionView,
} from '@recued/contracts';

import type { BroadcastSubscriber } from '../realtime/subscriber.js';
import { humanizeRpcError } from '../shell/rpc-error-copy.js';

// ════════════════════════════════════════════════════════════════
// Caller seams
// ════════════════════════════════════════════════════════════════

/** `cli.reachability.universe` caller seam — the installed cli-tool universe
 *  (tool rows + per-op toggles). */
export type LocalToolsUniverseCaller = () => Promise<CliReachabilityUniverseResponse>;

/** `cli.reachability.list` caller seam — every granted reachability row. */
export type LocalToolsListCaller = () => Promise<CliReachabilityListResponse>;

/** `cli.reachability.set` caller seam — grant/revoke one (principal × ingredient
 *  × operation) allowlist row. The surface writes exactly one per op toggle. */
export type LocalToolsSetCaller = (
  args: CliReachabilitySetRequest,
) => Promise<CliReachabilitySetResponse>;

/** `collection.contract.listContracts` caller seam — the surface's contract
 *  rows. */
export type LocalToolsContractsCaller = () => Promise<{
  contracts: ReadonlyArray<ContractDefinitionView>;
}>;

export type LocalToolsPanelState = 'loading' | 'ready' | 'error';

export interface MountLocalToolsPanelOptions {
  /** Host element the panel renders into. */
  host: HTMLElement;
  /** DOM document seam. Defaults to `globalThis.document`. */
  document?: Document;
  /** `cli.reachability.universe` caller. */
  runUniverse: LocalToolsUniverseCaller;
  /** `cli.reachability.list` caller. */
  runList: LocalToolsListCaller;
  /** `cli.reachability.set` caller. */
  runSet: LocalToolsSetCaller;
  /** `collection.contract.listContracts` caller — supplies the door/agent rows
   *  beneath the Owner row. Optional: absent ⇒ the surface renders the Owner row
   *  only (still fully functional for the owner's own reachability). */
  runListContracts?: LocalToolsContractsCaller;
  /** D-121 broadcast subscribe seam. When wired, the panel re-lists its contract
   *  rows on `contract.contract_definition_changed` (a door minted/revoked here
   *  or on another paired client appears/disappears without a manual refresh).
   *  No bus event exists for reachability row writes — those are local writes
   *  from THIS panel, reconciled by the post-toggle re-list. Optional. */
  subscribe?: BroadcastSubscriber['on'];
}

export interface LocalToolsPanelMount {
  /** Current panel phase. */
  getState(): LocalToolsPanelState;
  /** The installed tools in display order (universe order). */
  getTools(): ReadonlyArray<CliToolGridEntry>;
  /** The surface's principal rows (Owner first, then active door/agent
   *  contracts), each `{ principal, label }`. */
  getRows(): ReadonlyArray<{ principal: string; label: string }>;
  /** Effective state of one op for a principal — `'on'` (a present allowed row)
   *  or `'off'`. Test + host introspection. */
  getOpState(principal: string, slug: string, operationId: string): 'on' | 'off';
  /** Top-level load-error message. Null when the last load succeeded. */
  getError(): string | null;
  /** Host-driven refresh — re-loads all three reads. */
  refresh(): Promise<void>;
  /** Initial load promise — resolves after the most recent load settles. */
  whenLoaded(): Promise<void>;
  /** Toggle one op for a principal — grants when off, revokes when on. One
   *  reachability row. Programmatic equivalent of clicking the checkbox. No-op
   *  while the op is already in flight. */
  toggleOp(principal: string, slug: string, operationId: string): Promise<void>;
  /** Clear every granted op for one principal (the per-contract "Disable all"
   *  kill-switch, committed directly — the programmatic equivalent of
   *  arm-then-Confirm). */
  disablePrincipal(principal: string): Promise<void>;
  /** Whether a principal's op list is expanded (Owner defaults expanded; a
   *  door/agent contract defaults collapsed). */
  isExpanded(principal: string): boolean;
  /** Expand/collapse a principal's op list (re-renders). */
  toggleExpanded(principal: string): void;
  /** Tear down the panel DOM. Idempotent. */
  dispose(): void;
}

// ════════════════════════════════════════════════════════════════
// Attribute constants — stable hooks for tests + the Settings shell
// ════════════════════════════════════════════════════════════════

export const LOCAL_TOOLS_PANEL_HOST_ATTR = 'data-recued-local-tools-panel';
export const LOCAL_TOOLS_LOADING_ATTR = 'data-recued-local-tools-loading';
export const LOCAL_TOOLS_EMPTY_ATTR = 'data-recued-local-tools-empty';
export const LOCAL_TOOLS_ERROR_ATTR = 'data-recued-local-tools-error';
/** One contract/Owner block. Carries `data-principal`. */
export const LOCAL_TOOLS_PRINCIPAL_ATTR = 'data-recued-local-tools-principal';
/** The expand/collapse header button of a contract block. Carries
 *  `data-principal` + `data-expanded` (`true` / `false`). */
export const LOCAL_TOOLS_PRINCIPAL_HEADER_ATTR = 'data-recued-local-tools-principal-header';
/** The "N of M granted" summary inside a header. Carries `data-principal`. */
export const LOCAL_TOOLS_SUMMARY_ATTR = 'data-recued-local-tools-summary';
/** One tool group inside a contract block. Carries `data-principal` +
 *  `data-tool`. */
export const LOCAL_TOOLS_TOOL_ATTR = 'data-recued-local-tools-tool';
// D-182 — proactive readiness badge: the tool's binary is not on the server PATH.
export const LOCAL_TOOLS_NOT_READY_ATTR = 'data-recued-local-tools-not-ready';
/** One op row inside a tool group. Carries `data-principal` / `data-tool` /
 *  `data-slug` / `data-operation` + `data-op-state` (`on` / `off`). */
export const LOCAL_TOOLS_OP_ATTR = 'data-recued-local-tools-op';
/** The op-toggle checkbox. Carries the same `data-*` as its op row. */
export const LOCAL_TOOLS_OP_TOGGLE_ATTR = 'data-recued-local-tools-op-toggle';
/** An op's risk-tier badge. Carries `data-risk`. */
export const LOCAL_TOOLS_RISK_BADGE_ATTR = 'data-recued-local-tools-risk';
/** The "asks" mark on a write/destructive op (the per-action approval fires). */
export const LOCAL_TOOLS_ASKS_ATTR = 'data-recued-local-tools-asks';
/** The per-contract "Disable all" kill-switch — first stage (arms the confirm).
 *  Carries `data-principal`. */
export const LOCAL_TOOLS_KILL_ATTR = 'data-recued-local-tools-kill';
/** The armed "Confirm" of the kill-switch. Carries `data-principal`. */
export const LOCAL_TOOLS_KILL_CONFIRM_ATTR = 'data-recued-local-tools-kill-confirm';
/** The armed "Cancel" of the kill-switch. */
export const LOCAL_TOOLS_KILL_CANCEL_ATTR = 'data-recued-local-tools-kill-cancel';
/** A per-contract error chip (an op / bulk write failure). Carries
 *  `data-principal`. */
export const LOCAL_TOOLS_PRINCIPAL_ERROR_ATTR = 'data-recued-local-tools-principal-error';

// ════════════════════════════════════════════════════════════════
// Helpers
// ════════════════════════════════════════════════════════════════

/** Title-case a risk tier for the badge. */
// D-203 — the tier display label is the canonical riskTierLabel (contracts).
const riskLabel = riskTierLabel;

/** True iff an op of this risk fires the per-action `ask` approval (anything
 *  past read writes / mutates the world, so it asks). Drives the "asks" mark. */
const riskAsks = (risk: string): boolean => risk !== 'read';

const errMessage = (err: unknown): string =>
  humanizeRpcError(err);

/** A reachability / in-flight key — `(principal, ingredient slug, operation_id)`.
 *  This IS the allowlist row identity now: one op = one row. The US (unit
 *  separator) can never appear in any segment. */
const US = '\u001f';
const reachKey = (principal: string, slug: string, op: string): string =>
  `${principal}${US}${slug}${US}${op}`;

interface PrincipalRow {
  principal: string;
  label: string;
}

interface InternalState {
  phase: LocalToolsPanelState;
  tools: ReadonlyArray<CliToolGridEntry>;
  rows: ReadonlyArray<PrincipalRow>;
  /** `reachKey` → allowed. Only present rows are in the map (absent ⇒ off). */
  cells: ReadonlyMap<string, boolean>;
  error: string | null;
  /** Per-contract error messages, keyed by principal. */
  principalErrors: ReadonlyMap<string, string>;
  /** The principal whose kill-switch is armed (one at a time). */
  armingKillPrincipal: string | null;
}

/** Derive the surface's principal rows from the contract list. Owner leads; then
 *  every ACTIVE door/agent (standing) contract. Gate-grant rows and D-196
 *  customer rows are excluded — they are not generic local-tool principals; a
 *  revoked/expired contract can no longer trigger a recipe, so its cli
 *  reachability is moot and would only clutter the surface. */
const rowsFromContracts = (
  contracts: ReadonlyArray<ContractDefinitionView>,
): PrincipalRow[] => {
  const rows: PrincipalRow[] = [
    { principal: CLI_REACHABILITY_OWNER_PRINCIPAL, label: 'Owner (you)' },
  ];
  for (const c of contracts) {
    if (c.lifecycle_state !== 'active') continue;
    if (!isStandingContractDefinition(c)) continue;
    rows.push({ principal: c.contract_id, label: c.display_name });
  }
  return rows;
};

// ════════════════════════════════════════════════════════════════
// Mount
// ════════════════════════════════════════════════════════════════

export const mountLocalToolsPanel = (
  opts: MountLocalToolsPanelOptions,
): LocalToolsPanelMount => {
  const doc = opts.document ?? (globalThis as { document?: Document }).document;
  if (doc === undefined) {
    throw new Error(
      'mountLocalToolsPanel: no document available — pass `opts.document` for non-browser environments',
    );
  }

  let state: InternalState = {
    phase: 'loading',
    tools: [],
    rows: [{ principal: CLI_REACHABILITY_OWNER_PRINCIPAL, label: 'Owner (you)' }],
    cells: new Map(),
    error: null,
    principalErrors: new Map(),
    armingKillPrincipal: null,
  };
  let disposed = false;
  // Bumped before every load await; a post-await write lands only when its
  // captured generation is still current (shared discipline with contracts-panel).
  let loadGeneration = 0;
  let pendingLoad: Promise<void> = Promise.resolve();
  // Op keys (principal|slug|op) with a write in flight — their checkbox + the
  // principal's kill-switch render disabled while a write runs.
  const pendingOps = new Set<string>();
  // Principals with a bulk op (Disable-all) in flight.
  const pendingBulkPrincipals = new Set<string>();
  // Expanded principals (pure UI state, persists across reloads). Owner starts
  // expanded; a door/agent contract starts collapsed (fail-closed-quiet).
  const expandedPrincipals = new Set<string>([CLI_REACHABILITY_OWNER_PRINCIPAL]);

  const root = doc.createElement('div');
  root.setAttribute(LOCAL_TOOLS_PANEL_HOST_ATTR, '');
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

  // ── op-state derivation ────────────────────────────────────────────
  const opState = (
    cells: ReadonlyMap<string, boolean>,
    principal: string,
    slug: string,
    op: string,
  ): 'on' | 'off' =>
    cells.get(reachKey(principal, slug, op)) === true ? 'on' : 'off';

  /** Total grantable ops across every installed tool (the "M" of "N of M"). */
  const totalOpCount = (): number =>
    state.tools.reduce((sum, t) => sum + t.operations.length, 0);

  /** Granted-op count for a principal across every tool (the "N"). */
  const grantedCount = (principal: string): number => {
    let n = 0;
    for (const t of state.tools) {
      for (const op of t.operations) {
        if (opState(state.cells, principal, op.catalog_slug, op.operation_id) === 'on') n += 1;
      }
    }
    return n;
  };

  /** True iff any single-op write for `principal` is in flight. The kill-switch
   *  computes its writes from the CURRENT `state.cells` snapshot, so it must not
   *  run — nor be clickable — while an op write is outstanding, else it reads a
   *  stale snapshot and could miss the pending change. `reachKey` =
   *  `principal US slug US op`. */
  const principalHasPendingOp = (principal: string): boolean => {
    for (const key of pendingOps) {
      if (key.slice(0, key.indexOf(US)) === principal) return true;
    }
    return false;
  };

  // ── render ──────────────────────────────────────────────────────────
  const makeButton = (
    attr: string,
    className: string,
    text: string,
    principal: string,
  ): HTMLButtonElement => {
    const btn = doc.createElement('button');
    btn.setAttribute(attr, '');
    btn.setAttribute('type', 'button');
    btn.setAttribute('data-principal', principal);
    btn.className = className;
    btn.textContent = text;
    return btn;
  };

  const renderOpRow = (
    parent: HTMLElement,
    principal: string,
    tool: CliToolGridEntry,
    op: CliToolOpEntry,
    bulkBusy: boolean,
  ): void => {
    const st = opState(state.cells, principal, op.catalog_slug, op.operation_id);
    const rowLabel = doc.createElement('label');
    rowLabel.setAttribute(LOCAL_TOOLS_OP_ATTR, '');
    rowLabel.setAttribute('data-principal', principal);
    rowLabel.setAttribute('data-tool', tool.tool);
    rowLabel.setAttribute('data-slug', op.catalog_slug);
    rowLabel.setAttribute('data-operation', op.operation_id);
    rowLabel.setAttribute('data-op-state', st);
    rowLabel.className = 'lt-op';

    const box = doc.createElement('input');
    box.setAttribute('type', 'checkbox');
    box.setAttribute(LOCAL_TOOLS_OP_TOGGLE_ATTR, '');
    box.setAttribute('data-principal', principal);
    box.setAttribute('data-tool', tool.tool);
    box.setAttribute('data-slug', op.catalog_slug);
    box.setAttribute('data-operation', op.operation_id);
    box.setAttribute('data-op-state', st);
    box.className = 'lt-op-box';
    box.checked = st === 'on';
    const inFlight = pendingOps.has(reachKey(principal, op.catalog_slug, op.operation_id));
    if (inFlight || bulkBusy) box.setAttribute('disabled', '');
    else
      box.addEventListener('change', () => {
        void runToggleOp(principal, op.catalog_slug, op.operation_id);
      });
    rowLabel.appendChild(box);

    const opName = doc.createElement('span');
    opName.className = 'lt-op-name';
    opName.textContent = op.operation_id;
    rowLabel.appendChild(opName);

    const badge = doc.createElement('span');
    badge.setAttribute(LOCAL_TOOLS_RISK_BADGE_ATTR, '');
    badge.setAttribute('data-risk', op.risk_tier);
    badge.className = `lt-risk lt-risk-${op.risk_tier}`;
    badge.textContent = riskLabel(op.risk_tier);
    rowLabel.appendChild(badge);

    if (riskAsks(op.risk_tier)) {
      const asks = doc.createElement('span');
      asks.setAttribute(LOCAL_TOOLS_ASKS_ATTR, '');
      asks.className = 'lt-asks';
      asks.textContent = 'asks';
      asks.title = 'Each run still asks for approval before the binary runs.';
      rowLabel.appendChild(asks);
    }

    parent.appendChild(rowLabel);
  };

  const renderPrincipalBlock = (row: PrincipalRow): void => {
    const principal = row.principal;
    const bulkBusy = pendingBulkPrincipals.has(principal);
    // The kill-switch is additionally frozen while ANY single-op write for this
    // principal is in flight — it reads `state.cells` and must not race a pending
    // op.
    const killBusy = bulkBusy || principalHasPendingOp(principal);
    const expanded = expandedPrincipals.has(principal);
    const granted = grantedCount(principal);
    const total = totalOpCount();

    const block = doc.createElement('div');
    block.setAttribute(LOCAL_TOOLS_PRINCIPAL_ATTR, '');
    block.setAttribute('data-principal', principal);
    block.className = 'lt-principal';

    // Header: expand/collapse toggle (chevron + label + "N of M granted") and the
    // kill-switch.
    const header = doc.createElement('div');
    header.className = 'lt-principal-heading';

    const toggle = makeButton(
      LOCAL_TOOLS_PRINCIPAL_HEADER_ATTR,
      'lt-principal-toggle',
      '',
      principal,
    );
    toggle.setAttribute('data-expanded', expanded ? 'true' : 'false');
    toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    const chevron = doc.createElement('span');
    chevron.className = 'lt-chevron';
    chevron.textContent = expanded ? '▾' : '▸';
    toggle.appendChild(chevron);
    const labelEl = doc.createElement('span');
    labelEl.className = 'lt-principal-label';
    labelEl.textContent = row.label;
    toggle.appendChild(labelEl);
    const summary = doc.createElement('span');
    summary.setAttribute(LOCAL_TOOLS_SUMMARY_ATTR, '');
    summary.setAttribute('data-principal', principal);
    summary.className = 'lt-summary';
    summary.textContent = `${granted} of ${total} granted`;
    toggle.appendChild(summary);
    toggle.addEventListener('click', () => toggleExpandedInternal(principal));
    header.appendChild(toggle);

    // Kill-switch (two-stage) — only meaningful when something is granted.
    if (state.armingKillPrincipal === principal) {
      const confirmWrap = doc.createElement('div');
      confirmWrap.className = 'lt-kill-confirm';
      const prompt = doc.createElement('span');
      prompt.className = 'lt-kill-prompt';
      prompt.textContent = `Disable every local tool for ${row.label}?`;
      confirmWrap.appendChild(prompt);
      const yes = makeButton(LOCAL_TOOLS_KILL_CONFIRM_ATTR, 'lt-kill lt-kill-yes', 'Confirm', principal);
      if (killBusy) yes.setAttribute('disabled', '');
      else yes.addEventListener('click', () => void runDisablePrincipal(principal));
      confirmWrap.appendChild(yes);
      const cancel = makeButton(LOCAL_TOOLS_KILL_CANCEL_ATTR, 'lt-kill-cancel', 'Cancel', principal);
      cancel.addEventListener('click', () => {
        state = { ...state, armingKillPrincipal: null };
        render();
      });
      confirmWrap.appendChild(cancel);
      header.appendChild(confirmWrap);
    } else if (granted > 0) {
      const kill = makeButton(LOCAL_TOOLS_KILL_ATTR, 'lt-kill', 'Disable all', principal);
      if (killBusy) kill.setAttribute('disabled', '');
      else
        kill.addEventListener('click', () => {
          state = { ...state, armingKillPrincipal: principal };
          render();
        });
      header.appendChild(kill);
    }
    block.appendChild(header);

    if (expanded) {
      const body = doc.createElement('div');
      body.className = 'lt-principal-body';
      for (const tool of state.tools) {
        const group = doc.createElement('div');
        group.setAttribute(LOCAL_TOOLS_TOOL_ATTR, '');
        group.setAttribute('data-principal', principal);
        group.setAttribute('data-tool', tool.tool);
        group.className = 'lt-tool';
        const toolName = doc.createElement('div');
        toolName.className = 'lt-tool-name';
        toolName.textContent = tool.tool;
        // D-182 — proactive readiness: a binary not on the server's PATH reads as
        // "not installed" here, matching the run-time CLI_TOOL_NOT_FOUND. Shown
        // only on a definitive `false` (undefined = not probed → no badge).
        if (tool.reachable === false) {
          const badge = doc.createElement('span');
          badge.setAttribute(LOCAL_TOOLS_NOT_READY_ATTR, '');
          badge.className = 'lt-not-ready';
          badge.textContent = 'not installed';
          badge.title =
            `${tool.tool} was not found on the server's PATH — install it to run these operations`;
          toolName.appendChild(badge);
        }
        group.appendChild(toolName);
        for (const op of tool.operations) {
          renderOpRow(group, principal, tool, op, bulkBusy);
        }
        body.appendChild(group);
      }
      const principalError = state.principalErrors.get(principal);
      if (principalError !== undefined) {
        appendLine(
          body,
          LOCAL_TOOLS_PRINCIPAL_ERROR_ATTR,
          'lt-principal-error',
          `Could not update: ${principalError}`,
        );
      }
      block.appendChild(body);
    }

    root.appendChild(block);
  };

  const render = (): void => {
    if (disposed) return;
    clearChildren(root);

    if (state.error !== null) {
      appendLine(root, LOCAL_TOOLS_ERROR_ATTR, 'lt-error', `Could not load local tools: ${state.error}`);
    }

    if (state.tools.length > 0) {
      for (const row of state.rows) renderPrincipalBlock(row);
      return;
    }

    if (state.phase === 'loading') {
      appendLine(root, LOCAL_TOOLS_LOADING_ATTR, 'lt-loading', 'Loading local tools…');
      return;
    }
    if (state.phase === 'ready') {
      appendLine(
        root,
        LOCAL_TOOLS_EMPTY_ATTR,
        'lt-empty',
        'No local tools installed. Install a pack that uses a local binary (whisper / ffmpeg / magick / docling) to control which contracts may reach it.',
      );
    }
    // phase === 'error' with no tools → the error chip above is the whole surface.
  };

  // ── load ──────────────────────────────────────────────────────────
  const doRefresh = (): Promise<void> => {
    const gen = ++loadGeneration;
    pendingLoad = (async () => {
      // The three reads are independent — gather each so a contracts failure
      // still renders the universe (Owner-only rows) rather than blanking the
      // whole surface. The universe is the structural read; a failure there is
      // the top-level error.
      const [universeR, listR, contractsR] = await Promise.allSettled([
        opts.runUniverse(),
        opts.runList(),
        opts.runListContracts ? opts.runListContracts() : Promise.resolve(undefined),
      ]);
      if (disposed || gen !== loadGeneration) return;

      const errors: string[] = [];
      const tools =
        universeR.status === 'fulfilled' ? universeR.value.tools : state.tools;
      if (universeR.status === 'rejected') errors.push(errMessage(universeR.reason));

      const cells = new Map<string, boolean>();
      if (listR.status === 'fulfilled') {
        for (const r of listR.value.rows) {
          cells.set(reachKey(r.principal, r.ingredient_id, r.operation_id), r.allowed);
        }
      } else {
        errors.push(errMessage(listR.reason));
      }

      let rows = state.rows;
      if (contractsR.status === 'fulfilled') {
        rows =
          contractsR.value === undefined
            ? [{ principal: CLI_REACHABILITY_OWNER_PRINCIPAL, label: 'Owner (you)' }]
            : rowsFromContracts(contractsR.value.contracts);
      } else if (contractsR.status === 'rejected') {
        errors.push(errMessage(contractsR.reason));
      }

      state = {
        ...state,
        phase: errors.length > 0 ? 'error' : 'ready',
        tools,
        rows,
        cells,
        error: errors.length > 0 ? errors.join('; ') : null,
        principalErrors: new Map(),
        armingKillPrincipal: null,
      };
      render();
    })();
    return pendingLoad;
  };

  // ── writes ────────────────────────────────────────────────────────
  /** Set one allowlist row. The owner principal is passed verbatim (it equals
   *  the rpc's default, but being explicit keeps the write self-describing). */
  const setRow = (
    principal: string,
    slug: string,
    op: string,
    allowed: boolean,
  ): Promise<CliReachabilitySetResponse> =>
    opts.runSet({ principal, ingredient_id: slug, operation_id: op, allowed });

  const setPrincipalError = (principal: string, message: string | null): void => {
    const next = new Map(state.principalErrors);
    if (message === null) next.delete(principal);
    else next.set(principal, message);
    state = { ...state, principalErrors: next };
  };

  /** Settle a batch of set-row writes, ALWAYS reconcile to the true server state,
   *  then surface the first failure (if any) on the principal's error chip.
   *  Shared by the op toggle + the kill-switch. `Promise.allSettled` (not `.all`)
   *  never abandons sibling writes on the first rejection, and the post-write
   *  `doRefresh()` re-reads the allowlist — so a PARTIAL failure can never leave a
   *  hidden half-applied state on screen. The error is set AFTER the refresh
   *  because `doRefresh` clears `principalErrors` on its fresh load. */
  const settleWritesThenReconcile = async (
    principal: string,
    writes: ReadonlyArray<{ slug: string; op: string; allowed: boolean }>,
  ): Promise<void> => {
    const results = await Promise.allSettled(
      writes.map((w) => setRow(principal, w.slug, w.op, w.allowed)),
    );
    if (disposed) return;
    await doRefresh();
    if (disposed) return;
    const failure = results.find(
      (r): r is PromiseRejectedResult => r.status === 'rejected',
    );
    if (failure !== undefined) {
      setPrincipalError(principal, errMessage(failure.reason));
      render();
    }
  };

  const runToggleOp = async (
    principal: string,
    slug: string,
    op: string,
  ): Promise<void> => {
    const ok = reachKey(principal, slug, op);
    if (pendingOps.has(ok) || pendingBulkPrincipals.has(principal)) return;
    // off → grant; on → revoke.
    const target = opState(state.cells, principal, slug, op) !== 'on';
    pendingOps.add(ok);
    // A toggle invalidates any in-flight list so its pre-write snapshot can't
    // clobber the reconciling re-list inside `settleWritesThenReconcile`.
    loadGeneration += 1;
    setPrincipalError(principal, null);
    render();
    try {
      await settleWritesThenReconcile(principal, [{ slug, op, allowed: target }]);
    } finally {
      pendingOps.delete(ok);
      if (!disposed) render();
    }
  };

  const runDisablePrincipal = async (principal: string): Promise<void> => {
    if (pendingBulkPrincipals.has(principal) || principalHasPendingOp(principal)) return;
    // Collect every currently-granted op for this principal (computed against the
    // CURRENT cells snapshot — the entry guard + disabled buttons keep a pending
    // op from racing this read).
    const writes: { slug: string; op: string; allowed: boolean }[] = [];
    for (const tool of state.tools) {
      for (const op of tool.operations) {
        if (opState(state.cells, principal, op.catalog_slug, op.operation_id) === 'on') {
          writes.push({ slug: op.catalog_slug, op: op.operation_id, allowed: false });
        }
      }
    }
    if (writes.length === 0) {
      // Nothing granted — just disarm the confirm.
      state = { ...state, armingKillPrincipal: null };
      render();
      return;
    }
    pendingBulkPrincipals.add(principal);
    loadGeneration += 1;
    setPrincipalError(principal, null);
    state = { ...state, armingKillPrincipal: null };
    render();
    try {
      await settleWritesThenReconcile(principal, writes);
    } finally {
      pendingBulkPrincipals.delete(principal);
      if (!disposed) render();
    }
  };

  const toggleExpandedInternal = (principal: string): void => {
    if (expandedPrincipals.has(principal)) expandedPrincipals.delete(principal);
    else expandedPrincipals.add(principal);
    render();
  };

  // ── live contract-row coherence ───────────────────────────────────
  const broadcastUnsubscribers: Array<() => void> = [];
  if (opts.subscribe && opts.runListContracts) {
    broadcastUnsubscribers.push(
      opts.subscribe('contract.contract_definition_changed', () => {
        if (disposed) return;
        void doRefresh();
      }),
    );
  }

  // ── initial paint + seed load ─────────────────────────────────────
  render();
  void doRefresh();

  return {
    getState: () => state.phase,
    getTools: () => state.tools,
    getRows: () => state.rows.map((r) => ({ principal: r.principal, label: r.label })),
    getOpState: (principal, slug, op) => opState(state.cells, principal, slug, op),
    getError: () => state.error,
    refresh: () => doRefresh(),
    whenLoaded: () => pendingLoad,
    toggleOp: (principal, slug, op) => runToggleOp(principal, slug, op),
    disablePrincipal: (principal) => runDisablePrincipal(principal),
    isExpanded: (principal) => expandedPrincipals.has(principal),
    toggleExpanded: (principal) => toggleExpandedInternal(principal),
    dispose: () => {
      if (disposed) return;
      disposed = true;
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

/** Self-scoped CSS for the Local tools section, scoped under
 *  `[data-recued-local-tools-panel]`. The settings route joins this into its one
 *  style bundle (mirrors `CONTRACTS_PANEL_STYLES`). */
export const LOCAL_TOOLS_PANEL_STYLES = `
[data-recued-local-tools-panel],
[data-recued-local-tools-panel] .lt-principal,
[data-recued-local-tools-panel] .lt-principal-heading,
[data-recued-local-tools-panel] .lt-principal-body,
[data-recued-local-tools-panel] .lt-tool,
[data-recued-local-tools-panel] .lt-op {
  min-width: 0;
}
[data-recued-local-tools-panel] .lt-loading,
[data-recued-local-tools-panel] .lt-empty {
  font-size: 13px;
  color: var(--muted);
  padding: 6px 2px;
}
[data-recued-local-tools-panel] .lt-error,
[data-recued-local-tools-panel] .lt-principal-error {
  font-size: 13px;
  color: var(--fail);
  padding: 6px 2px;
}
[data-recued-local-tools-panel] .lt-principal {
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 8px 12px;
  margin: 10px 0;
}
[data-recued-local-tools-panel] .lt-principal-heading {
  display: flex;
  align-items: center;
  gap: 10px;
}
[data-recued-local-tools-panel] .lt-principal-toggle {
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex: 1;
  min-width: 0;
  background: none;
  border: none;
  padding: 4px 0;
  cursor: pointer;
  text-align: left;
  font: inherit;
  color: inherit;
}
[data-recued-local-tools-panel] .lt-chevron {
  font-size: 11px;
  color: var(--muted);
}
[data-recued-local-tools-panel] .lt-principal-label {
  font-size: 14px;
  font-weight: 650;
  overflow-wrap: anywhere;
}
[data-recued-local-tools-panel] .lt-summary {
  font-size: 11px;
  color: var(--muted);
}
[data-recued-local-tools-panel] .lt-principal-body {
  padding: 4px 0 2px 14px;
}
[data-recued-local-tools-panel] .lt-tool {
  margin: 8px 0;
}
[data-recued-local-tools-panel] .lt-tool-name {
  font-size: 12px;
  font-weight: 600;
  font-family: var(--mono, ui-monospace, monospace);
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.03em;
  margin-bottom: 2px;
}
[data-recued-local-tools-panel] .lt-not-ready {
  margin-left: 8px;
  padding: 0 6px;
  border: 1px solid var(--danger);
  border-radius: 4px;
  color: var(--danger);
  font-size: 10px;
  font-weight: 650;
  text-transform: none;
  letter-spacing: 0;
}
[data-recued-local-tools-panel] .lt-op {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 3px 0 3px 8px;
  cursor: pointer;
}
[data-recued-local-tools-panel] .lt-op-box {
  cursor: pointer;
}
[data-recued-local-tools-panel] .lt-op-box[disabled] {
  opacity: 0.6;
  cursor: default;
}
[data-recued-local-tools-panel] .lt-op-name {
  font-size: 13px;
  font-family: var(--mono, ui-monospace, monospace);
  min-width: 0;
  overflow-wrap: anywhere;
}
[data-recued-local-tools-panel] .lt-risk {
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  padding: 1px 6px;
  border-radius: 6px;
  border: 1px solid var(--border);
  color: var(--muted);
}
[data-recued-local-tools-panel] .lt-risk-write,
[data-recued-local-tools-panel] .lt-risk-admin,
[data-recued-local-tools-panel] .lt-risk-destructive {
  color: var(--fail);
  border-color: var(--fail);
}
[data-recued-local-tools-panel] .lt-asks {
  font-size: 10px;
  color: var(--muted);
  font-style: italic;
}
[data-recued-local-tools-panel] .lt-kill {
  font-size: 12px;
  padding: 3px 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface);
  color: var(--fail);
  cursor: pointer;
  white-space: nowrap;
}
[data-recued-local-tools-panel] .lt-kill[disabled] {
  opacity: 0.6;
  cursor: default;
}
[data-recued-local-tools-panel] .lt-kill-confirm {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
[data-recued-local-tools-panel] .lt-kill-prompt {
  font-size: 12px;
  color: var(--fail);
  white-space: nowrap;
}
[data-recued-local-tools-panel] .lt-kill-yes {
  border-color: var(--fail);
}
[data-recued-local-tools-panel] .lt-kill-cancel {
  font-size: 12px;
  padding: 3px 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface);
  cursor: pointer;
}
@media (max-width: 560px) {
  [data-recued-local-tools-panel] .lt-principal { padding: 8px; }
  [data-recued-local-tools-panel] .lt-principal-body { padding-left: 0; }
  [data-recued-local-tools-panel] .lt-op { align-items: flex-start; }
}
`;
