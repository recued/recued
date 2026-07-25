/** D-182 §7.1 — the install-time cli grant dialog.
 *
 *  Installing a pack is the single explicit consent moment (spec §7.1). When a
 *  pack adds a local-binary (`cli`) tool — whisper / ffmpeg / magick / docling —
 *  this dialog is the install-time projection of the §7.2 Local tools surface: it
 *  lets the owner choose, per tool, which OPS a recipe they run may reach the
 *  binary at. Scope is fixed to **You only** (the owner): §8 makes `cli`
 *  `external_exposable: false`, so a cli tool can never be granted to a door
 *  actor — only the Access axis is live for cli (the per-contract scope lives in
 *  the §7.2 surface). The vertical slice writes the same per-(principal ×
 *  cli-ingredient × operation) reachability allowlist the surface does, at the
 *  owner principal, via `cli.reachability.set`.
 *
 *  ── install → dialog → confirm ───────────────────────────────────────
 *  cli reachability is fail-closed (absent ⇒ denied), so a freshly-installed cli
 *  tool grants NOTHING until the owner confirms here (spec §7.1 "Default off,
 *  everywhere"). The flow runs AFTER the install commits — by then
 *  `cli.reachability.universe` reflects the just-installed catalog (it reads the
 *  live manifest registry), so the dialog derives the new ops from a
 *  before/after universe diff, no tool→pack mapping needed:
 *    1. `snapshot()` BEFORE the install records the current (slug × op) key set.
 *    2. `openForNewTools(before)` AFTER a successful install re-reads the universe
 *       and opens the dialog for any tool that GAINED an op. Nothing new ⇒ no
 *       dialog (the common non-cli install is silent).
 *
 *  ── Access = ops, Read pre-selected ──────────────────────────────────
 *  The dialog shows only the NEW ops each tool gained, as opt-in toggles. A
 *  `read`-tier op (idempotent, the AI-reading-your-world core value) is
 *  pre-selected per spec; `write` / `admin` / `destructive` ops start OFF — a
 *  write to a local binary requires an explicit choice (§8 "writes require
 *  explicit opt-in"). A write op "on" is still *granted-to-request*: the
 *  per-action `ask` approval gates the dispatch, so no toggle hands silent
 *  unattended execution.
 *
 *  ── Skip is fail-closed, not an error ────────────────────────────────
 *  "Skip for now" grants nothing and closes; the owner completes scope later in
 *  Settings → Local tools (the §7.2 surface). Confirm with everything left at the
 *  default grants only the pre-selected read ops (nothing, for a write-only tool
 *  like whisper) — the safe posture, with the Local tools surface as the
 *  adjustment lens.
 *
 *  ── Render model: DOM nodes, not innerHTML ───────────────────────────
 *  Checkboxes + buttons carry real listeners, so the dialog builds via
 *  `createElement` (the same shape as `local-tools-panel.ts`), not an HTML string.
 *
 *  Spec: docs/d-182-spec.md §7.1 (the install grant dialog); the rpc shapes live
 *  in `packages/contracts/src/cli-reachability-rpc.ts`; the post-install
 *  adjustment lens is `local-tools-panel.ts` (§7.2). */

import {
  CLI_REACHABILITY_OWNER_PRINCIPAL,
  RISK_TIER_RANK,
  RISK_TIERS,
  riskTierLabel,
  type CliReachabilitySetRequest,
  type CliReachabilitySetResponse,
  type CliReachabilityUniverseResponse,
  type CliToolOpEntry,
} from '@recued/contracts';
import { humanizeRpcError } from '../shell/rpc-error-copy.js';

// ════════════════════════════════════════════════════════════════
// Caller seams
// ════════════════════════════════════════════════════════════════

/** `cli.reachability.universe` caller seam — the installed cli-tool universe
 *  (tool rows + per-op toggles). Read once for the before-snapshot and once after
 *  install for the diff. Same caller the §7.2 surface uses. */
export type CliGrantUniverseCaller = () => Promise<CliReachabilityUniverseResponse>;

/** `cli.reachability.set` caller seam — grant one (principal × ingredient ×
 *  operation) allowlist row. The dialog writes one per selected op, always at the
 *  owner principal (You only, §8). */
export type CliGrantSetCaller = (
  args: CliReachabilitySetRequest,
) => Promise<CliReachabilitySetResponse>;

export interface MountCliGrantDialogOptions {
  /** Host element the overlay attaches to (e.g. the settings route root). The
   *  dialog is `position: fixed`, so the host only anchors lifecycle, not
   *  layout. */
  host: HTMLElement;
  /** DOM document seam. Defaults to `globalThis.document`. */
  document?: Document;
  /** `cli.reachability.universe` caller. */
  runUniverse: CliGrantUniverseCaller;
  /** `cli.reachability.set` caller. */
  runSet: CliGrantSetCaller;
}

export interface CliGrantDialogMount {
  /** Capture the current cli-universe (slug × op) key set for a later diff.
   *  Call BEFORE an install. Resolves to `null` when the universe read fails —
   *  the caller then skips the post-install dialog rather than guess a diff. */
  snapshot(): Promise<ReadonlySet<string> | null>;
  /** After a successful install, re-read the universe, diff against `before`, and
   *  open the dialog for any tool that gained an op. Resolves once the dialog
   *  closes (Confirm success or Skip), or immediately when nothing new appeared /
   *  the read failed. Safe to call without awaiting (fire-and-forget overlay). */
  openForNewTools(before: ReadonlySet<string>): Promise<void>;
  /** True while the dialog overlay is open. */
  isOpen(): boolean;
  /** The tools the open dialog is offering grants for (empty when closed), each
   *  with the new op ids it added. */
  getDialogTools(): ReadonlyArray<{ tool: string; new_ops: ReadonlyArray<string> }>;
  /** Whether one (slug × op) toggle is currently selected. */
  isOpSelected(slug: string, operationId: string): boolean;
  /** Toggle one (slug × op). No-op while a confirm is in flight or the op isn't
   *  offered. */
  toggleOp(slug: string, operationId: string): void;
  /** Active error message (a confirm write failed). Null when clean. */
  getError(): string | null;
  /** True while the Confirm write batch is in flight. */
  isSubmitting(): boolean;
  /** Grant the selected ops, then close on full success (keeps the dialog open
   *  with an error chip on a partial failure). Programmatic equivalent of the
   *  "Grant access" button. */
  confirm(): Promise<void>;
  /** Close granting nothing (the fail-closed "Skip for now"). */
  skip(): void;
  /** Tear down the overlay. Idempotent. */
  dispose(): void;
}

// ════════════════════════════════════════════════════════════════
// Attribute constants — stable hooks for tests + host introspection
// ════════════════════════════════════════════════════════════════

export const CLI_GRANT_DIALOG_HOST_ATTR = 'data-recued-cli-grant-dialog';
export const CLI_GRANT_DIALOG_BACKDROP_ATTR = 'data-recued-cli-grant-backdrop';
/** One tool block. Carries `data-tool`. */
export const CLI_GRANT_DIALOG_TOOL_ATTR = 'data-recued-cli-grant-tool';
/** One op toggle. Carries `data-tool` / `data-slug` / `data-operation` +
 *  `data-risk`. */
export const CLI_GRANT_DIALOG_OP_ATTR = 'data-recued-cli-grant-op';
export const CLI_GRANT_DIALOG_CONFIRM_BTN_ATTR = 'data-recued-cli-grant-confirm';
export const CLI_GRANT_DIALOG_SKIP_BTN_ATTR = 'data-recued-cli-grant-skip';
export const CLI_GRANT_DIALOG_ERROR_ATTR = 'data-recued-cli-grant-error';

// ════════════════════════════════════════════════════════════════
// Helpers
// ════════════════════════════════════════════════════════════════

/** Canonical risk ordering (shared with the §7.2 surface): low → high. A tool's
 *  new ops render in this order; an unrecognized tier sorts last (defensive). */
// D-203 — rank + label are the canonical RISK_TIER_RANK / riskTierLabel
// (contracts). Unknown tier ranks last (RISK_TIERS.length), matching the prior
// `indexOf === -1 → RISK_ORDER.length`.
const riskRank = (risk: string): number => RISK_TIER_RANK[risk] ?? RISK_TIERS.length;
const riskLabel = riskTierLabel;

const errMessage = (err: unknown): string =>
  humanizeRpcError(err);

/** A grant-op key — `(catalog_slug, operation_id)`. This IS the reachability row
 *  identity (one op = one row); a slug maps to exactly one tool, so the key is
 *  tool-independent. The US (unit separator) can never appear in a slug or an op
 *  id, so it's a collision-free join. */
const US = '\u001f';
const opKey = (slug: string, op: string): string => `${slug}${US}${op}`;

/** Build the (slug × op) key set from a universe response. */
const universeKeySet = (universe: CliReachabilityUniverseResponse): Set<string> => {
  const keys = new Set<string>();
  for (const entry of universe.tools) {
    for (const op of entry.operations) keys.add(opKey(op.catalog_slug, op.operation_id));
  }
  return keys;
};

interface DialogTool {
  tool: string;
  /** The ops this install ADDED for the tool, in canonical (risk-rank) order. */
  newOps: CliToolOpEntry[];
}

// ════════════════════════════════════════════════════════════════
// Copy
// ════════════════════════════════════════════════════════════════

const COPY = {
  heading: 'Grant access to local tools',
  intro:
    'This pack added local tools that run on your server. Choose which operations each may run when a recipe you run uses it. Nothing is granted until you confirm — you can change this anytime in Settings → Local tools.',
  read_hint: 'Reading is safe and idempotent — pre-selected.',
  write_hint: 'Each run still asks for approval before the binary runs.',
  confirm_label: 'Grant access',
  confirming_label: 'Granting…',
  skip_label: 'Skip for now',
} as const;

// ════════════════════════════════════════════════════════════════
// Mount
// ════════════════════════════════════════════════════════════════

export const mountCliGrantDialog = (
  opts: MountCliGrantDialogOptions,
): CliGrantDialogMount => {
  const doc = opts.document ?? (globalThis as { document?: Document }).document;
  if (doc === undefined) {
    throw new Error(
      'mountCliGrantDialog: no document available — pass `opts.document` for non-browser environments',
    );
  }

  let disposed = false;
  let open = false;
  let submitting = false;
  let error: string | null = null;
  let tools: DialogTool[] = [];
  // Monotonic id of the CURRENT dialog session, bumped on every `openDialog`. A
  // confirm captures it before its (async) write batch and re-checks it after —
  // so a second install that closed THIS dialog and opened a fresh one (a higher
  // session) can't have the stale confirm stamp its error chip or close it
  // (Codex F1).
  let dialogSession = 0;
  /** `(slug US op)` → selected. Only offered ops are keyed. */
  const selected = new Map<string, boolean>();
  /** Resolver for the in-flight `openForNewTools` promise — fired on close. */
  let closeResolve: (() => void) | null = null;

  // The overlay node lives detached until `open`; it's appended to the host on
  // open and removed on close so the host DOM stays clean between installs.
  let overlay: HTMLElement | null = null;

  const clearChildren = (node: HTMLElement): void => {
    while (node.firstChild) node.removeChild(node.firstChild);
  };

  const toolByName = (name: string): DialogTool | undefined =>
    tools.find((t) => t.tool === name);

  const opByKey = (slug: string, op: string): CliToolOpEntry | undefined => {
    for (const t of tools) {
      const found = t.newOps.find(
        (o) => o.catalog_slug === slug && o.operation_id === op,
      );
      if (found) return found;
    }
    return undefined;
  };

  // ── render ──────────────────────────────────────────────────────────
  const renderToolBlock = (parent: HTMLElement, t: DialogTool): void => {
    const block = doc.createElement('div');
    block.setAttribute(CLI_GRANT_DIALOG_TOOL_ATTR, '');
    block.setAttribute('data-tool', t.tool);
    block.className = 'cg-tool';

    const heading = doc.createElement('div');
    heading.className = 'cg-tool-heading';
    const name = doc.createElement('span');
    name.className = 'cg-tool-name';
    name.textContent = t.tool;
    heading.appendChild(name);
    block.appendChild(heading);

    for (const op of t.newOps) {
      const labelEl = doc.createElement('label');
      labelEl.className = 'cg-op';
      const box = doc.createElement('input');
      box.setAttribute('type', 'checkbox');
      box.setAttribute(CLI_GRANT_DIALOG_OP_ATTR, '');
      box.setAttribute('data-tool', t.tool);
      box.setAttribute('data-slug', op.catalog_slug);
      box.setAttribute('data-operation', op.operation_id);
      box.setAttribute('data-risk', op.risk_tier);
      box.className = 'cg-op-box';
      box.checked = selected.get(opKey(op.catalog_slug, op.operation_id)) === true;
      if (submitting) box.setAttribute('disabled', '');
      else
        box.addEventListener('change', () => {
          toggleOpInternal(op.catalog_slug, op.operation_id);
        });
      labelEl.appendChild(box);

      const opName = doc.createElement('span');
      opName.className = 'cg-op-name';
      opName.textContent = op.operation_id;
      labelEl.appendChild(opName);

      const badge = doc.createElement('span');
      badge.className = `cg-risk cg-risk-${op.risk_tier}`;
      badge.textContent = riskLabel(op.risk_tier);
      labelEl.appendChild(badge);

      const hint = doc.createElement('span');
      hint.className = 'cg-op-hint';
      hint.textContent = op.risk_tier === 'read' ? COPY.read_hint : COPY.write_hint;
      labelEl.appendChild(hint);

      block.appendChild(labelEl);
    }

    parent.appendChild(block);
  };

  const render = (): void => {
    if (disposed || overlay === null) return;
    clearChildren(overlay);

    const panel = doc.createElement('div');
    panel.className = 'cg-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');

    const h = doc.createElement('h2');
    h.className = 'cg-heading';
    h.textContent = COPY.heading;
    panel.appendChild(h);

    const intro = doc.createElement('p');
    intro.className = 'cg-intro';
    intro.textContent = COPY.intro;
    panel.appendChild(intro);

    for (const t of tools) renderToolBlock(panel, t);

    if (error !== null) {
      const err = doc.createElement('div');
      err.setAttribute(CLI_GRANT_DIALOG_ERROR_ATTR, '');
      err.className = 'cg-error';
      err.textContent = `Could not grant access: ${error}`;
      panel.appendChild(err);
    }

    const footer = doc.createElement('div');
    footer.className = 'cg-footer';

    const skip = doc.createElement('button');
    skip.setAttribute(CLI_GRANT_DIALOG_SKIP_BTN_ATTR, '');
    skip.setAttribute('type', 'button');
    skip.className = 'cg-skip';
    skip.textContent = COPY.skip_label;
    if (submitting) skip.setAttribute('disabled', '');
    else skip.addEventListener('click', () => skipInternal());
    footer.appendChild(skip);

    const confirm = doc.createElement('button');
    confirm.setAttribute(CLI_GRANT_DIALOG_CONFIRM_BTN_ATTR, '');
    confirm.setAttribute('type', 'button');
    confirm.className = 'cg-confirm';
    confirm.textContent = submitting ? COPY.confirming_label : COPY.confirm_label;
    if (submitting) confirm.setAttribute('disabled', '');
    else confirm.addEventListener('click', () => void confirmInternal());
    footer.appendChild(confirm);

    panel.appendChild(footer);
    overlay.appendChild(panel);
  };

  // ── open / close ──────────────────────────────────────────────────
  const closeDialog = (): void => {
    open = false;
    submitting = false;
    error = null;
    tools = [];
    selected.clear();
    if (overlay !== null) {
      try {
        opts.host.removeChild(overlay);
      } catch {
        // detached host / fake DOM — ignore
      }
      overlay = null;
    }
    const resolve = closeResolve;
    closeResolve = null;
    if (resolve) resolve();
  };

  const openDialog = (dialogTools: DialogTool[]): void => {
    tools = dialogTools;
    selected.clear();
    for (const t of dialogTools) {
      for (const op of t.newOps) {
        // Pre-select `read` (safe, idempotent); write/admin/destructive opt-in.
        selected.set(opKey(op.catalog_slug, op.operation_id), op.risk_tier === 'read');
      }
    }
    error = null;
    submitting = false;
    open = true;
    dialogSession += 1;
    overlay = doc.createElement('div');
    overlay.setAttribute(CLI_GRANT_DIALOG_HOST_ATTR, '');
    const backdrop = doc.createElement('div');
    backdrop.setAttribute(CLI_GRANT_DIALOG_BACKDROP_ATTR, '');
    backdrop.className = 'cg-backdrop';
    overlay.appendChild(backdrop);
    opts.host.appendChild(overlay);
    render();
  };

  const toggleOpInternal = (slug: string, op: string): void => {
    if (submitting) return;
    const key = opKey(slug, op);
    if (!selected.has(key)) return; // not an offered op
    selected.set(key, !(selected.get(key) === true));
    render();
  };

  const skipInternal = (): void => {
    if (submitting) return;
    closeDialog();
  };

  const confirmInternal = async (): Promise<void> => {
    if (!open || submitting) return;
    // Pin the session so a concurrent reopen (a second install) can't let this
    // confirm's post-await block touch the NEW dialog's state (Codex F1).
    const mySession = dialogSession;
    // Fan out one `set` per selected op, always at the owner principal (You only,
    // §8).
    const writes: Array<{ slug: string; op: string }> = [];
    for (const t of tools) {
      for (const op of t.newOps) {
        if (selected.get(opKey(op.catalog_slug, op.operation_id)) !== true) continue;
        writes.push({ slug: op.catalog_slug, op: op.operation_id });
      }
    }
    // Confirm with nothing selected is a fail-closed close.
    if (writes.length === 0) {
      closeDialog();
      return;
    }
    submitting = true;
    error = null;
    render();
    const results = await Promise.allSettled(
      writes.map((w) =>
        opts.runSet({
          principal: CLI_REACHABILITY_OWNER_PRINCIPAL,
          ingredient_id: w.slug,
          operation_id: w.op,
          allowed: true,
        }),
      ),
    );
    // Stale if disposed, or if a reopen advanced the session past this confirm
    // (the successful grants still landed — idempotent, recoverable in the §7.2
    // surface — but this confirm must not paint over the fresh dialog).
    if (disposed || dialogSession !== mySession) return;
    const failure = results.find(
      (r): r is PromiseRejectedResult => r.status === 'rejected',
    );
    if (failure !== undefined) {
      // Partial failure — the successful grants stick (idempotent; recoverable in
      // the §7.2 surface); surface the first error and keep the dialog open so the
      // owner can retry the remaining ops or skip.
      submitting = false;
      error = errMessage(failure.reason);
      render();
      return;
    }
    closeDialog();
  };

  // ── public: snapshot + open-for-new ────────────────────────────────
  const snapshot = async (): Promise<ReadonlySet<string> | null> => {
    try {
      const universe = await opts.runUniverse();
      return universeKeySet(universe);
    } catch {
      // A failed pre-install read means we can't compute a trustworthy diff —
      // skip the dialog rather than open it over a wrong (every-op-is-new) set.
      return null;
    }
  };

  const openForNewTools = async (before: ReadonlySet<string>): Promise<void> => {
    if (disposed) return;
    let universe: CliReachabilityUniverseResponse;
    try {
      universe = await opts.runUniverse();
    } catch {
      return; // can't read post-install universe — no dialog
    }
    if (disposed) return;
    const dialogTools: DialogTool[] = [];
    for (const entry of universe.tools) {
      const newOps = entry.operations
        .filter((op) => !before.has(opKey(op.catalog_slug, op.operation_id)))
        .sort((a, b) => riskRank(a.risk_tier) - riskRank(b.risk_tier));
      if (newOps.length > 0) dialogTools.push({ tool: entry.tool, newOps });
    }
    if (dialogTools.length === 0) return; // nothing new — silent (non-cli install)
    // Single dialog at a time — a second install while one is open replaces it
    // (the owner sees the freshest set; the prior promise resolves on close).
    if (open) closeDialog();
    return new Promise<void>((resolve) => {
      closeResolve = resolve;
      openDialog(dialogTools);
    });
  };

  return {
    snapshot,
    openForNewTools,
    isOpen: () => open,
    getDialogTools: () =>
      tools.map((t) => ({
        tool: t.tool,
        new_ops: t.newOps.map((o) => o.operation_id),
      })),
    isOpSelected: (slug, op) => selected.get(opKey(slug, op)) === true,
    toggleOp: (slug, op) => toggleOpInternal(slug, op),
    getError: () => error,
    isSubmitting: () => submitting,
    confirm: () => confirmInternal(),
    skip: () => skipInternal(),
    dispose: () => {
      if (disposed) return;
      disposed = true;
      // Resolve any in-flight openForNewTools promise so a caller awaiting it
      // isn't left hanging across a route teardown.
      const resolve = closeResolve;
      closeResolve = null;
      if (overlay !== null) {
        try {
          opts.host.removeChild(overlay);
        } catch {
          // detached host / fake DOM — ignore
        }
        overlay = null;
      }
      open = false;
      if (resolve) resolve();
    },
  };
};

// ════════════════════════════════════════════════════════════════
// Styles
// ════════════════════════════════════════════════════════════════

/** Self-scoped CSS for the install-time cli grant dialog, scoped under
 *  `[data-recued-cli-grant-dialog]`. The settings route joins this into its one
 *  style bundle (mirrors `LOCAL_TOOLS_PANEL_STYLES`). */
export const CLI_GRANT_DIALOG_STYLES = `
[data-recued-cli-grant-dialog] {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  overflow-y: auto;
  padding: clamp(16px, 4vw, 36px);
}
[data-recued-cli-grant-dialog] .cg-backdrop {
  position: absolute;
  inset: 0;
  background: rgba(9, 9, 11, 0.56);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
}
[data-recued-cli-grant-dialog] .cg-panel {
  position: relative;
  z-index: 1;
  max-width: 640px;
  width: 100%;
  max-height: calc(100vh - 48px);
  overflow-y: auto;
  background: var(--surface, #fff);
  border: 1px solid var(--border, #ddd);
  border-radius: 16px;
  padding: clamp(20px, 3vw, 28px);
  box-shadow: 0 28px 80px rgba(0, 0, 0, 0.34), 0 3px 10px rgba(0, 0, 0, 0.16);
}
[data-recued-cli-grant-dialog] .cg-heading {
  font-size: 22px;
  font-weight: 720;
  line-height: 1.2;
  letter-spacing: -0.02em;
  margin: 0 0 9px;
}
[data-recued-cli-grant-dialog] .cg-intro {
  font-size: 13px;
  line-height: 1.55;
  color: var(--fg-muted);
  margin: 0 0 18px;
}
[data-recued-cli-grant-dialog] .cg-tool {
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 14px;
  margin: 10px 0;
  background: var(--surface-sunk);
}
[data-recued-cli-grant-dialog] .cg-tool-heading {
  display: flex;
  align-items: baseline;
  gap: 10px;
  flex-wrap: wrap;
  margin-bottom: 8px;
}
[data-recued-cli-grant-dialog] .cg-tool-name {
  font-size: 15px;
  font-weight: 700;
  font-family: var(--mono, ui-monospace, monospace);
}
[data-recued-cli-grant-dialog] .cg-op {
  display: grid;
  grid-template-columns: 18px minmax(100px, auto) auto minmax(0, 1fr);
  align-items: start;
  gap: 7px 9px;
  margin-top: 7px;
  padding: 10px;
  border: 1px solid var(--border);
  border-radius: 9px;
  background: var(--surface);
  cursor: pointer;
  transition: border-color 120ms ease, background-color 120ms ease;
}
[data-recued-cli-grant-dialog] .cg-op:hover { border-color: var(--border-strong); }
[data-recued-cli-grant-dialog] .cg-op:has(.cg-op-box:checked) {
  border-color: var(--accent);
  background: var(--accent-weak);
}
[data-recued-cli-grant-dialog] .cg-op-box {
  width: 17px;
  height: 17px;
  margin: 1px 0 0;
  accent-color: var(--accent);
}
[data-recued-cli-grant-dialog] .cg-op-box[disabled] {
  opacity: 0.6;
  cursor: default;
}
[data-recued-cli-grant-dialog] .cg-op-name {
  font-size: 13px;
  font-weight: 650;
  font-family: var(--mono, ui-monospace, monospace);
  min-width: 120px;
}
[data-recued-cli-grant-dialog] .cg-risk {
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  padding: 1px 6px;
  border-radius: 6px;
  border: 1px solid var(--border, #ddd);
  color: var(--muted, #666);
}
[data-recued-cli-grant-dialog] .cg-risk-write,
[data-recued-cli-grant-dialog] .cg-risk-admin,
[data-recued-cli-grant-dialog] .cg-risk-destructive {
  color: var(--fail, #c00);
  border-color: var(--fail, #c00);
}
[data-recued-cli-grant-dialog] .cg-op-hint {
  font-size: 11px;
  line-height: 1.45;
  color: var(--fg-muted);
}
[data-recued-cli-grant-dialog] .cg-error {
  font-size: 13px;
  color: var(--danger);
  padding: 10px 12px;
  border: 1px solid var(--danger);
  border-radius: 9px;
  background: var(--danger-weak);
}
[data-recued-cli-grant-dialog] .cg-footer {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 18px;
  padding-top: 16px;
  border-top: 1px solid var(--border);
}
[data-recued-cli-grant-dialog] .cg-skip,
[data-recued-cli-grant-dialog] .cg-confirm {
  font-size: 13px;
  min-height: 40px;
  padding: 8px 16px;
  border-radius: 9px;
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--fg);
  font-weight: 650;
  cursor: pointer;
}
[data-recued-cli-grant-dialog] .cg-confirm {
  border-color: var(--accent, #2563eb);
  background: var(--accent, #2563eb);
  color: var(--on-accent, #fff);
}
[data-recued-cli-grant-dialog] .cg-skip[disabled],
[data-recued-cli-grant-dialog] .cg-confirm[disabled] {
  opacity: 0.6;
  cursor: default;
}
@media (max-width: 600px) {
  [data-recued-cli-grant-dialog] { padding: 10px; }
  [data-recued-cli-grant-dialog] .cg-panel {
    max-height: calc(100vh - 20px); padding: 18px 14px; border-radius: 13px;
  }
  [data-recued-cli-grant-dialog] .cg-heading { font-size: 20px; }
  [data-recued-cli-grant-dialog] .cg-op {
    grid-template-columns: 18px minmax(0, 1fr) auto;
  }
  [data-recued-cli-grant-dialog] .cg-op-hint { grid-column: 2 / -1; }
  [data-recued-cli-grant-dialog] .cg-footer > button { flex: 1 1 auto; }
}
`;
