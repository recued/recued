/** The rules for every agreement — the `contract.override.*` editor.
 *
 *  An override is a tightening keyed on WHO (you, or any app with an
 *  agreement) × an ingredient × optionally one operation: never allow it,
 *  always ask, or ask once it gets riskier than a level. It is not a contract's
 *  grant: an override names no agreement, so one rule applies across every
 *  agreement (and, for `user_self`, to the owner's own actions). That is why it
 *  lives on the Contracts list page and not inside one agreement (D-327).
 *
 *  ── Two halves, gated independently ──────────────────────────────────
 *  The read+delete INVENTORY renders with `runListOverrides` +
 *  `runDeleteOverride`. The CREATE form (actor → ingredient → operation →
 *  policy) renders ONLY when `runUpsertOverride` + `runListCatalogOperations`
 *  are wired too; a create surface with no catalog/writer is dead, so the panel
 *  degrades to read+delete when either is absent.
 *
 *  ── Create form: controlled draft, hand-built, enforced facets only ──
 *  Only the DISPATCH-ENFORCED policy facets are authorable (`denied` /
 *  `approval` / `max_risk_without_approval`); `timeout_ms` / `cache_ttl_ms` are
 *  deliberately absent (the gateway ignores them today, so a control would
 *  author a restriction that does nothing). The form is state-driven
 *  (`state.draft`): `change` listeners (production) + the `setCreateField`
 *  handle seam (tests — the fake DOM can't fire `change`) funnel through
 *  `updateDraft` → re-render. A `contract_write_loosens` rejection names the
 *  loosened fields; `bad_request` surfaces the server message.
 *
 *  ── Deleting loosens policy — so it is deliberate + truthful ─────────
 *  Removing a tightening override reverts that key to the (looser) grant
 *  floor, so Delete is a two-stage inline confirm (single row armed at a time).
 *  Because `deleteOverride` returns just `{ deleted }`, a successful delete
 *  OPTIMISTICALLY drops the row before the reconciling re-list — so if that
 *  re-list fails, the row still reads as gone (it IS gone server-side).
 *
 *  ── Freshness ────────────────────────────────────────────────────────
 *  Override writes ride the pair rpc, not the D-121 bus, so the panel re-lists
 *  after its own writes and on the host's `refresh()`. The `loadGeneration`
 *  guard drops a stale in-flight list when a newer one overtakes it.
 *
 *  ⛔ This file used to also hold the D-171 "door for AI apps" — one
 *  server-wide key with its own tool checklist, chat switch and limits — shown
 *  on every agreement's Connect tab. D-327 retired it: an agreement's key is
 *  created on that agreement (`contracts/contract-key-panel.ts`) and takes its
 *  permissions from the agreement alone.
 *
 *  Spec: D-166; the override rpc shapes + row value live in
 *  `packages/contracts/src/contract-override.ts`. */

import type {
  Actor,
  CatalogIngredientView,
  ContractDefinitionView,
  MintContractRequest,
  OverridePolicyInput,
  OverrideView,
} from '@recued/contracts';
import { isEmptyOverridePolicy } from '@recued/contracts';
import { humanizeRpcError } from '../shell/rpc-error-copy.js';

// ════════════════════════════════════════════════════════════════
// Caller seams + handle
// ════════════════════════════════════════════════════════════════

/** `collection.contract.listOverrides` caller seam. B1 lists every authored
 *  override (no `ingredient_id` filter) and groups client-side. Read-only
 *  (`ReadonlyArray`, like `ConnectionsListCaller`) — the panel never mutates
 *  the list, and the rpc's mutable `OverrideView[]` is assignable to it. */
export type PermissionsListOverridesCaller = () => Promise<{
  overrides: ReadonlyArray<OverrideView>;
}>;

/** `collection.contract.deleteOverride` caller seam. Returns `{ deleted }`
 *  only — no fresh row — so the handler re-lists after a successful delete. */
export type PermissionsDeleteOverrideCaller = (args: {
  actor: Actor;
  ingredient_id: string;
  operation_id?: string;
}) => Promise<{ deleted: boolean }>;

/** `collection.contract.upsertOverride` caller seam. Wired through the
 *  section gate in B1; consumed by the Slice B2 create form. */
export type PermissionsUpsertOverrideCaller = (args: {
  actor: Actor;
  ingredient_id: string;
  operation_id?: string;
  policy: OverridePolicyInput;
}) => Promise<OverrideView>;

/** `collection.contract.listCatalogOperations` caller seam — the B2 picker's
 *  catalog source. Wired through the section gate in B1; consumed in B2. */
export type PermissionsListCatalogOperationsCaller = () => Promise<{
  ingredients: CatalogIngredientView[];
}>;

/** `collection.contract.mintContract` caller seam — the Contracts page's
 *  "+ New contract" form. Returns the minted view (with the resolved
 *  `lifecycle_state`). */
export type PermissionsMintContractCaller = (
  args: MintContractRequest,
) => Promise<ContractDefinitionView>;

/** `collection.contract.listContracts` caller seam — read-only; the
 *  suggestion panels name a door by the same row the inventory shows. */
export type PermissionsListContractsCaller = () => Promise<{
  contracts: ReadonlyArray<ContractDefinitionView>;
}>;

export type PermissionsPanelState = 'loading' | 'ready' | 'error';

export interface MountPermissionsPanelOptions {
  /** Host element the panel renders into. The panel appends a single wrapper
   *  div + rebuilds its inner contents across state changes. `dispose()`
   *  drops the wrapper. */
  host: HTMLElement;
  /** DOM document seam. Defaults to `globalThis.document`. */
  document?: Document;
  /** `collection.contract.listOverrides` caller seam. */
  runListOverrides?: PermissionsListOverridesCaller;
  /** `collection.contract.deleteOverride` caller seam. */
  runDeleteOverride?: PermissionsDeleteOverrideCaller;
  /** `collection.contract.upsertOverride` caller seam (the create form). The
   *  create form mounts ONLY when BOTH this and `runListCatalogOperations` are
   *  supplied — a create surface with no catalog (or no writer) is dead, so the
   *  panel degrades to the read+delete inventory when either is absent. */
  runUpsertOverride?: PermissionsUpsertOverrideCaller;
  /** `collection.contract.listCatalogOperations` caller seam (the picker's
   *  ingredient/operation source). Required alongside `runUpsertOverride` for
   *  the create form. */
  runListCatalogOperations?: PermissionsListCatalogOperationsCaller;
}

export interface PermissionsPanelMount {
  /** Current panel state — primary surface for tests + host introspection. */
  getState(): PermissionsPanelState;
  /** The authored override rows in display order (sorted by ingredient, then
   *  actor, then operation). On a refresh failure the prior rows are RETAINED
   *  beneath the error chip, so this is empty only before the first
   *  successful load or after one that found zero overrides. */
  getOverrides(): ReadonlyArray<OverrideView>;
  /** Top-level list-error message. Null when the last list succeeded (a
   *  per-row delete failure lives on its row's chip, not here). */
  getListError(): string | null;
  /** Host-driven refresh — re-lists overrides. Returns the load promise. */
  refresh(): Promise<void>;
  /** Initial load promise — resolves after the most recent list settles
   *  (success → `'ready'`, failure → `'error'`). */
  whenLoaded(): Promise<void>;
  /** True while an override mutation owns this panel. */
  hasInFlightWork(): boolean;
  /** Delete one override — commits directly (the programmatic equivalent of the
   *  UI's arm-then-Confirm two-stage click). A no-op for an unknown row or a row
   *  with a delete already in flight. Test seam + host convenience; awaits the
   *  rpc + the resulting re-render. */
  deleteOverride(
    actor: Actor,
    ingredientId: string,
    operationId?: string,
  ): Promise<void>;
  /** The loaded catalog (catalog-form ingredients + their ops) backing the
   *  create form's ingredient/operation pickers. Empty before the catalog
   *  resolves, on a catalog-load failure, or when the create form is disabled
   *  (no create callers wired). */
  getCatalog(): ReadonlyArray<CatalogIngredientView>;
  /** Resolves after the on-mount catalog load settles (or immediately when
   *  the create form is disabled). Test seam for the picker. */
  whenCatalogLoaded(): Promise<void>;
  /** Set one create-form draft field, the same path a control change drives
   *  (re-renders; setting `ingredient_id` resets `operation_id` to
   *  ingredient-wide). No-op when the create form is disabled. Test seam +
   *  host convenience (the fake DOM can't fire `change`). */
  setCreateField<K extends keyof CreateDraft>(
    field: K,
    value: CreateDraft[K],
  ): void;
  /** Submit the current create draft (validate → `upsertOverride` → refresh
   *  the inventory). A no-op when the create form is disabled or a submit is
   *  already in flight. Surfaces validation / `contract_write_loosens` /
   *  `bad_request` messages via `getCreateError()`. */
  submitCreate(): Promise<void>;
  /** The current create-form error (validation, loosen-rejection, or
   *  `bad_request`), or null. */
  getCreateError(): string | null;
  /** Tear down the panel DOM. Idempotent. */
  dispose(): void;
}

// ════════════════════════════════════════════════════════════════
// Attribute constants — stable hooks for tests + the host route
// ════════════════════════════════════════════════════════════════

/** Wrapper the panel owns inside the caller's host. */

export const PERMISSIONS_PANEL_HOST_ATTR = 'data-recued-permissions-panel';
/** The loading line (first list in flight). */
export const PERMISSIONS_PANEL_LOADING_ATTR = 'data-recued-permissions-loading';
/** The empty-state line (ready, zero overrides). */
export const PERMISSIONS_PANEL_EMPTY_ATTR = 'data-recued-permissions-empty';
/** The top-level list-error chip (a `runListOverrides` failure). */
export const PERMISSIONS_PANEL_ERROR_ATTR = 'data-recued-permissions-error';
/** One ingredient's card (groups that ingredient's override rows). Carries
 *  `data-ingredient-id`. */
export const PERMISSIONS_OVERRIDE_CARD_ATTR = 'data-recued-permissions-card';
/** One override row inside a card. Carries `data-actor`, `data-ingredient-id`,
 *  and `data-operation-id` (`''` for an ingredient-wide override). */
export const PERMISSIONS_OVERRIDE_ROW_ATTR = 'data-recued-permissions-row';
/** A row's Delete button — the first stage (arms the confirm) and the in-flight
 *  "Removing…" disabled state. Carries the same three `data-*` markers as its
 *  row. */
export const PERMISSIONS_DELETE_BUTTON_ATTR = 'data-recued-permissions-delete';
/** The armed "Confirm" button (second stage — commits the delete). Carries the
 *  same three `data-*` markers as its row. */
export const PERMISSIONS_DELETE_CONFIRM_ATTR =
  'data-recued-permissions-delete-confirm';
/** The armed "Cancel" button (disarms the confirm without deleting). */
export const PERMISSIONS_DELETE_CANCEL_ATTR =
  'data-recued-permissions-delete-cancel';
/** A per-row delete-error chip (a `deleteOverride` failure scoped to one row). */
export const PERMISSIONS_ROW_ERROR_ATTR = 'data-recued-permissions-row-error';

// ── B2 create form ──────────────────────────────────────────────────
/** The create-form wrapper (present only when both create callers are wired). */
export const PERMISSIONS_CREATE_FORM_ATTR = 'data-recued-permissions-create';
/** The actor `<select>`. */
export const PERMISSIONS_CREATE_ACTOR_ATTR = 'data-recued-permissions-create-actor';
/** The ingredient `<select>` (populated from the catalog). */
export const PERMISSIONS_CREATE_INGREDIENT_ATTR =
  'data-recued-permissions-create-ingredient';
/** The operation `<select>` (the selected ingredient's ops + an
 *  ingredient-wide option). */
export const PERMISSIONS_CREATE_OPERATION_ATTR =
  'data-recued-permissions-create-operation';
/** The `denied` policy checkbox. */
export const PERMISSIONS_CREATE_DENIED_ATTR =
  'data-recued-permissions-create-denied';
/** The `approval` policy `<select>`. */
export const PERMISSIONS_CREATE_APPROVAL_ATTR =
  'data-recued-permissions-create-approval';
/** The `max_risk_without_approval` policy `<select>`. */
export const PERMISSIONS_CREATE_MAXRISK_ATTR =
  'data-recued-permissions-create-maxrisk';
// NOTE: `timeout_ms` / `cache_ttl_ms` are deliberately NOT authorable here — the
// gateway's `projectToResolution` does not yet consume them (OverridePolicyInput
// marks them forward-compat), so a control for them would author a restriction
// that silently does nothing (false posture on a permissions surface). They stay
// in the type + the read inventory's facet display; a control lands when dispatch
// consumes them.
/** The Save button. */
export const PERMISSIONS_CREATE_SAVE_ATTR = 'data-recued-permissions-create-save';
/** The create-form error chip (validation / loosen-rejection / bad_request). */
export const PERMISSIONS_CREATE_ERROR_ATTR =
  'data-recued-permissions-create-error';

// ════════════════════════════════════════════════════════════════
// Helpers
// ════════════════════════════════════════════════════════════════

/** The create-form draft (B2). Selects hold `''` when unselected; `operation_id`
 *  is null for an ingredient-wide override. Only the dispatch-enforced facets
 *  are authorable (`denied` / `approval` / `max_risk_without_approval`) —
 *  `timeout_ms` / `cache_ttl_ms` are omitted (the gateway ignores them today). */
export interface CreateDraft {
  actor: Actor | '';
  ingredient_id: string;
  operation_id: string | null;
  denied: boolean;
  approval: '' | OverridePolicyInput['approval'];
  max_risk_without_approval: '' | OverridePolicyInput['max_risk_without_approval'];
}

const EMPTY_DRAFT: CreateDraft = {
  actor: '',
  ingredient_id: '',
  operation_id: null,
  denied: false,
  approval: '',
  max_risk_without_approval: '',
};

const errMessage = (err: unknown): string =>
  humanizeRpcError(err);

/** Stable key for one override row — the `(actor, ingredient, operation?)`
 *  triple the delete rpc is keyed on. `\u0000` separates segments so it cannot
 *  collide with any value. */
const rowKey = (v: {
  actor: string;
  ingredient_id: string;
  operation_id: string | null;
}): string => `${v.actor}\u0000${v.ingredient_id}\u0000${v.operation_id ?? ''}`;

/** Deterministic display order: by ingredient, then actor, then operation
 *  (ingredient-wide rows — `operation_id === null` — sort first within an
 *  actor). Pure; does not mutate the input. */
const sortOverrides = (
  rows: ReadonlyArray<OverrideView>,
): OverrideView[] =>
  [...rows].sort(
    (a, b) =>
      a.ingredient_id.localeCompare(b.ingredient_id)
      || a.actor.localeCompare(b.actor)
      || (a.operation_id ?? '').localeCompare(b.operation_id ?? ''),
  );

/** Drop the `<ingredient_id>.` prefix from a fully-qualified `operation_id`
 *  (the card / picker is already per-ingredient). Pure. */
const bareOperation = (ingredientId: string, operationId: string): string => {
  const prefix = `${ingredientId}.`;
  return operationId.startsWith(prefix)
    ? operationId.slice(prefix.length)
    : operationId;
};

/** The operation label for a row — `All operations` for an ingredient-wide
 *  override, else the bare op. */
const operationLabel = (v: OverrideView): string =>
  v.operation_id === null
    ? 'All operations'
    : bareOperation(v.ingredient_id, v.operation_id);

/** The non-empty policy facets, each as a short human label. Mirrors the
 *  `OverridePolicyInput` field set; an absent facet is omitted. */
const policyFacets = (p: OverridePolicyInput): string[] => {
  const parts: string[] = [];
  if (p.denied === true) parts.push('denied');
  if (p.approval !== undefined) parts.push(`approval: ${p.approval}`);
  if (p.max_risk_without_approval !== undefined) {
    parts.push(`how risky it may get before asking you: ${p.max_risk_without_approval}`);
  }
  if (p.timeout_ms !== undefined) parts.push(`timeout: ${p.timeout_ms} ms`);
  if (p.cache_ttl_ms !== undefined) parts.push(`cache TTL: ${p.cache_ttl_ms} ms`);
  return parts;
};

// ── B2 create-form option lists + projection ────────────────────────

/** The actors a user can scope an override to. The non-human kinds (`system` /
 *  `anonymous`) are deliberately omitted — a user restricts AI agents and their
 *  own actions, not the engine's internal cron/webhook identity. Scoping an
 *  override to `user_self` is the self-restriction path (D-161 N.3 — the former
 *  `contracted_self` actor collapsed into a `user_self` carrying a contract). */
const ACTOR_OPTIONS: ReadonlyArray<{ value: Actor; label: string }> = [
  { value: 'user_self', label: 'You (user_self)' },
  { value: 'contracted_user', label: 'An app you have a contract with' },
];

const APPROVAL_OPTIONS = ['never', 'ask', 'always'] as const;
const MAX_RISK_OPTIONS = ['read', 'write', 'admin', 'none'] as const;

/** Project a create draft into the `OverridePolicyInput` the rpc expects: only
 *  set facets the user actually chose (an unchecked `denied` / a blank select is
 *  omitted, leaving that facet at the grant floor). All three projected facets
 *  are dispatch-enforced — `submitCreate`'s empty-policy guard then requires at
 *  least one, so a create can never author a wholly-inert override. */
const buildPolicy = (d: CreateDraft): OverridePolicyInput => {
  const p: OverridePolicyInput = {};
  if (d.denied) p.denied = true;
  if (d.approval !== '' && d.approval !== undefined) p.approval = d.approval;
  if (
    d.max_risk_without_approval !== ''
    && d.max_risk_without_approval !== undefined
  ) {
    p.max_risk_without_approval = d.max_risk_without_approval;
  }
  return p;
};

/** Loosely-typed view of a rejected rpc — `RpcError` carries `code` + optional
 *  `details`, but read structurally so this survives any transport-layer
 *  re-wrap (no `instanceof` across the bundle boundary). */
interface RpcErrorish {
  code?: unknown;
  message?: unknown;
  details?: { loosened_fields?: unknown } | undefined;
}

/** Human copy for an `upsertOverride` rejection. `contract_write_loosens` names
 *  the offending fields (overrides may only tighten); `bad_request` surfaces the
 *  server message; anything else falls back to the raw error text. */
const upsertErrorMessage = (err: unknown): string => {
  const e: RpcErrorish =
    typeof err === 'object' && err !== null ? (err as RpcErrorish) : {};
  if (e.code === 'contract_write_loosens') {
    const raw = e.details?.loosened_fields;
    const fields = Array.isArray(raw)
      ? raw.filter((f): f is string => typeof f === 'string')
      : [];
    return fields.length > 0
      ? `You can only make rules stricter. This makes them looser: ${fields.join(', ')}`
      : 'You can only make rules stricter. This change would make them looser.';
  }
  if (e.code === 'bad_request' && typeof e.message === 'string') return e.message;
  return errMessage(err);
};

// ════════════════════════════════════════════════════════════════
// Mount
// ════════════════════════════════════════════════════════════════

// ════════════════════════════════════════════════════════════════
// Mount
// ════════════════════════════════════════════════════════════════

interface InternalState {
  phase: PermissionsPanelState;
  overrides: ReadonlyArray<OverrideView>;
  listError: string | null;
  /** Per-row delete-error messages, keyed by `rowKey`. Reset on each
   *  successful list (a fresh inventory clears stale per-row errors). */
  rowErrors: ReadonlyMap<string, string>;
  /** The `rowKey` of the single row currently armed for delete (two-stage
   *  confirm). Null when no row is armed; arming one disarms any other. */
  confirmingKey: string | null;
  /** Catalog ingredients for the picker; null until the on-mount load settles
   *  (or when the create form is disabled). */
  catalog: ReadonlyArray<CatalogIngredientView> | null;
  /** Catalog-load error message, or null. The inventory is unaffected — only
   *  the create form's ingredient picker degrades. */
  catalogError: string | null;
  /** The in-progress create-form draft. */
  draft: CreateDraft;
  /** Create-form error (validation / loosen-rejection / bad_request), or null. */
  createError: string | null;
  /** True while an `upsertOverride` is in flight (disables Save). */
  creating: boolean;
}

export const mountPermissionsPanel = (
  opts: MountPermissionsPanelOptions,
): PermissionsPanelMount => {
  const doc =
    opts.document ?? (globalThis as { document?: Document }).document;
  if (doc === undefined) {
    throw new Error(
      'mountPermissionsPanel: no document available — pass `opts.document` for non-browser environments',
    );
  }

  const canManageOverrides =
    opts.runListOverrides !== undefined && opts.runDeleteOverride !== undefined;

  let state: InternalState = {
    phase: canManageOverrides ? 'loading' : 'ready',
    overrides: [],
    listError: null,
    rowErrors: new Map(),
    confirmingKey: null,
    catalog: null,
    catalogError: null,
    draft: EMPTY_DRAFT,
    createError: null,
    creating: false,
  };
  let disposed = false;
  // The create form mounts only when BOTH create callers are wired (the route
  // gate guarantees this in production; a mount that omits them → no form, no
  // catalog load — the read+delete inventory is unchanged).
  const canCreate =
    canManageOverrides
    && opts.runUpsertOverride !== undefined
    && opts.runListCatalogOperations !== undefined;
  // Bumped before every `runListOverrides` await; the post-await write only
  // lands when its captured generation is still current. A delete ALSO bumps
  // it so a slow list started before the delete drops its now-stale write
  // instead of clobbering the post-delete re-list.
  let loadGeneration = 0;
  let pendingLoad: Promise<void> = Promise.resolve();
  // The on-mount catalog load. Resolves once the picker source settles.
  let pendingCatalog: Promise<void> = Promise.resolve();
  // Rows with a delete rpc in flight (keyed by `rowKey`). One delete at a time
  // per row: while a row mutates, its Delete button renders disabled.
  const pendingByRow = new Set<string>();

  const root = doc.createElement('div');
  root.setAttribute(PERMISSIONS_PANEL_HOST_ATTR, '');
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

  const renderRow = (card: HTMLElement, view: OverrideView): void => {
    const key = rowKey(view);
    const opId = view.operation_id ?? '';

    const row = doc.createElement('div');
    row.setAttribute(PERMISSIONS_OVERRIDE_ROW_ATTR, '');
    row.setAttribute('data-actor', view.actor);
    row.setAttribute('data-ingredient-id', view.ingredient_id);
    row.setAttribute('data-operation-id', opId);
    row.className = 'perm-row';

    const info = doc.createElement('div');
    info.className = 'perm-row-info';

    const heading = doc.createElement('div');
    heading.className = 'perm-row-heading';
    const actor = doc.createElement('span');
    actor.className = 'perm-actor';
    actor.textContent = view.actor;
    heading.appendChild(actor);
    const op = doc.createElement('span');
    op.className = 'perm-op';
    op.textContent = operationLabel(view);
    heading.appendChild(op);
    info.appendChild(heading);

    const facets = policyFacets(view.policy);
    if (facets.length > 0) {
      const facetsRow = doc.createElement('div');
      facetsRow.className = 'perm-facets';
      for (const facet of facets) {
        const chip = doc.createElement('span');
        chip.className = 'perm-facet';
        chip.textContent = facet;
        facetsRow.appendChild(chip);
      }
      info.appendChild(facetsRow);
    }
    row.appendChild(info);

    // Two-stage delete: idle "Delete" arms the confirm (deleting loosens
    // policy, so it is never a single click); armed shows "Confirm" / "Cancel";
    // an in-flight delete shows a disabled "Removing…".
    const makeButton = (
      attr: string,
      className: string,
      text: string,
    ): HTMLElement => {
      const btn = doc.createElement('button');
      btn.setAttribute(attr, '');
      btn.setAttribute('type', 'button');
      btn.setAttribute('data-actor', view.actor);
      btn.setAttribute('data-ingredient-id', view.ingredient_id);
      btn.setAttribute('data-operation-id', opId);
      btn.className = className;
      btn.textContent = text;
      return btn;
    };

    if (pendingByRow.has(key)) {
      const del = makeButton(PERMISSIONS_DELETE_BUTTON_ATTR, 'perm-delete', 'Removing…');
      del.setAttribute('disabled', '');
      row.appendChild(del);
    } else if (state.confirmingKey === key) {
      const controls = doc.createElement('div');
      controls.className = 'perm-confirm';
      const prompt = doc.createElement('span');
      prompt.className = 'perm-confirm-prompt';
      prompt.textContent = 'Remove this rule?';
      controls.appendChild(prompt);
      const confirm = makeButton(
        PERMISSIONS_DELETE_CONFIRM_ATTR,
        'perm-delete perm-confirm-yes',
        'Confirm',
      );
      confirm.addEventListener('click', () => {
        void runDelete(view);
      });
      controls.appendChild(confirm);
      const cancel = makeButton(
        PERMISSIONS_DELETE_CANCEL_ATTR,
        'perm-cancel',
        'Cancel',
      );
      cancel.addEventListener('click', () => {
        state = { ...state, confirmingKey: null };
        render();
      });
      controls.appendChild(cancel);
      row.appendChild(controls);
    } else {
      const del = makeButton(PERMISSIONS_DELETE_BUTTON_ATTR, 'perm-delete', 'Delete');
      del.addEventListener('click', () => {
        // Arm THIS row (single-row confirm — replacing any other armed row).
        state = { ...state, confirmingKey: key };
        render();
      });
      row.appendChild(del);
    }

    const rowError = state.rowErrors.get(key);
    if (rowError !== undefined) {
      appendLine(
        row,
        PERMISSIONS_ROW_ERROR_ATTR,
        'perm-row-error',
        `Recued could not delete it: ${rowError}`,
      );
    }

    card.appendChild(row);
  };

  const renderCard = (
    ingredientId: string,
    rows: ReadonlyArray<OverrideView>,
  ): void => {
    const card = doc.createElement('div');
    card.setAttribute(PERMISSIONS_OVERRIDE_CARD_ATTR, '');
    card.setAttribute('data-ingredient-id', ingredientId);

    const header = doc.createElement('div');
    header.className = 'perm-card-header';
    const title = doc.createElement('strong');
    title.textContent = ingredientId;
    header.appendChild(title);
    card.appendChild(header);

    for (const view of rows) renderRow(card, view);
    root.appendChild(card);
  };

  const render = (): void => {
    if (disposed) return;
    clearChildren(root);

    // The create form (when enabled) sits above the inventory.
    renderCreateForm();

    if (!canManageOverrides) return;

    // A list error surfaces as a chip ABOVE any still-visible cards — a
    // transient re-list failure shows the chip without wiping the inventory
    // the user can still act on.
    if (state.listError !== null) {
      appendLine(
        root,
        PERMISSIONS_PANEL_ERROR_ATTR,
        'perm-error',
        `Recued could not load your permissions: ${state.listError}`,
      );
    }

    if (state.overrides.length > 0) {
      // Group consecutive same-ingredient rows (the list is pre-sorted by
      // ingredient) into one card.
      let current: OverrideView[] = [];
      let currentId: string | null = null;
      for (const view of state.overrides) {
        if (view.ingredient_id !== currentId) {
          if (currentId !== null) renderCard(currentId, current);
          currentId = view.ingredient_id;
          current = [];
        }
        current.push(view);
      }
      if (currentId !== null) renderCard(currentId, current);
      return;
    }

    if (state.phase === 'loading') {
      appendLine(
        root,
        PERMISSIONS_PANEL_LOADING_ATTR,
        'perm-loading',
        'Loading permissions…',
      );
      return;
    }
    if (state.phase === 'ready') {
      appendLine(
        root,
        PERMISSIONS_PANEL_EMPTY_ATTR,
        'perm-empty',
        'No rules yet. Anything you stop apps from doing shows up here.',
      );
    }
    // phase === 'error' with zero rows → the error chip above is the whole
    // surface; no empty / loading line.
  };


  const doRefresh = (): Promise<void> => {
    const list = opts.runListOverrides;
    if (!canManageOverrides || list === undefined) {
      pendingLoad = Promise.resolve();
      return pendingLoad;
    }
    const gen = ++loadGeneration;
    pendingLoad = (async () => {
      try {
        const { overrides } = await list();
        if (disposed || gen !== loadGeneration) return; // stale / torn down
        // Spread `...state` so a re-list preserves the create-form draft +
        // loaded catalog (only the inventory-related facets reset here).
        state = {
          ...state,
          phase: 'ready',
          overrides: sortOverrides(overrides),
          listError: null,
          rowErrors: new Map(),
          confirmingKey: null,
        };
        render();
      } catch (err) {
        if (disposed || gen !== loadGeneration) return;
        // Keep any currently-visible cards; surface the error as a chip.
        state = { ...state, phase: 'error', listError: errMessage(err) };
        render();
      }
    })();
    return pendingLoad;
  };

  /** Delete one override row. On success re-lists (the rpc returns only
   *  `{ deleted }`); on failure surfaces the message on the row's error chip.
   *  The Delete button re-enables either way. */
  const runDelete = async (view: OverrideView): Promise<void> => {
    const deleteOverride = opts.runDeleteOverride;
    if (!canManageOverrides || deleteOverride === undefined) return;
    const key = rowKey(view);
    // One delete in flight per row. Defense-in-depth: the button also renders
    // disabled while pending.
    if (pendingByRow.has(key)) return;
    pendingByRow.add(key);
    // Invalidate any in-flight list so its (pre-delete) write can't clobber
    // this delete's post-delete re-list when it lands after us. A refresh
    // started AFTER this delete keeps the latest gen + still wins.
    loadGeneration += 1;
    // Consume the armed confirm + clear any stale error on this row.
    const startErrors = new Map(state.rowErrors);
    startErrors.delete(key);
    state = {
      ...state,
      rowErrors: startErrors,
      confirmingKey: state.confirmingKey === key ? null : state.confirmingKey,
    };
    render();
    try {
      await deleteOverride({
        actor: view.actor,
        ingredient_id: view.ingredient_id,
        ...(view.operation_id !== null
          ? { operation_id: view.operation_id }
          : {}),
      });
      if (disposed) return;
      pendingByRow.delete(key);
      // Finding 1: optimistically drop the row — the rpc succeeded, so this key
      // is now absent server-side (deleted, or already absent). Keeps the
      // inventory truthful even if the reconciling re-list below fails or is
      // superseded; a deleted override must never render as a still-active,
      // clickable row on this security surface.
      state = {
        ...state,
        overrides: state.overrides.filter((v) => rowKey(v) !== key),
      };
      await doRefresh();
    } catch (err) {
      if (disposed) return;
      const next = new Map(state.rowErrors);
      next.set(key, errMessage(err));
      state = { ...state, rowErrors: next };
    } finally {
      pendingByRow.delete(key);
      if (!disposed) render();
    }
  };

  // ── B2 create form: catalog load + draft + submit + render ────────

  const loadCatalog = (): Promise<void> => {
    const list = opts.runListCatalogOperations;
    if (list === undefined) return Promise.resolve();
    pendingCatalog = (async () => {
      try {
        const { ingredients } = await list();
        if (disposed) return;
        state = { ...state, catalog: ingredients, catalogError: null };
        render();
      } catch (err) {
        if (disposed) return;
        // A catalog-load failure degrades only the create form (the ingredient
        // picker shows "unavailable"); the inventory is untouched.
        state = { ...state, catalog: [], catalogError: errMessage(err) };
        render();
      }
    })();
    return pendingCatalog;
  };

  const updateDraft = <K extends keyof CreateDraft>(
    field: K,
    value: CreateDraft[K],
  ): void => {
    if (!canCreate || disposed) return;
    const draft: CreateDraft = { ...state.draft, [field]: value };
    // Changing the ingredient invalidates any operation chosen under the old
    // one — reset to ingredient-wide.
    if (field === 'ingredient_id') draft.operation_id = null;
    state = { ...state, draft };
    render();
  };

  const setCreateError = (message: string): void => {
    state = { ...state, createError: message };
    render();
  };

  const submitCreate = async (): Promise<void> => {
    const upsert = opts.runUpsertOverride;
    if (!canCreate || disposed || state.creating || upsert === undefined) return;
    const d = state.draft;
    if (d.actor === '') {
      setCreateError('Choose who to put a rule on.');
      return;
    }
    if (d.ingredient_id === '') {
      setCreateError('Choose an Ingredient.');
      return;
    }
    const policy = buildPolicy(d);
    if (isEmptyOverridePolicy(policy as Readonly<Record<string, unknown>>)) {
      setCreateError(
        'Set at least one rule: block it, ask you first, or cap how risky it may get.',
      );
      return;
    }
    const actor = d.actor; // narrowed to Actor by the guard above
    // Bump the generation (mirrors runDelete) so a list started before this
    // create can't clobber the post-create state, AND capture it: if a
    // concurrent same-key delete (or any mutation / refresh) bumps it before the
    // upsert resolves, the optimistic merge below is DROPPED so a just-deleted
    // row can't be resurrected — the highest-generation re-list then wins.
    loadGeneration += 1;
    const submitGen = loadGeneration;
    state = { ...state, creating: true, createError: null };
    render();
    try {
      const created = await upsert({
        actor,
        ingredient_id: d.ingredient_id,
        ...(d.operation_id !== null ? { operation_id: d.operation_id } : {}),
        policy,
      });
      if (disposed) return;
      // Clear the form. Optimistically show the returned row (the upsert is the
      // authority for THIS key) ONLY if no concurrent mutation intervened —
      // else a same-key delete that landed meanwhile must win, so we keep the
      // current list + let the reconciling re-list settle it. Replace any
      // existing same-key row (idempotent upsert).
      const createdKey = rowKey(created);
      const overrides =
        loadGeneration === submitGen
          ? sortOverrides([
              ...state.overrides.filter((v) => rowKey(v) !== createdKey),
              created,
            ])
          : state.overrides;
      state = {
        ...state,
        creating: false,
        createError: null,
        draft: EMPTY_DRAFT,
        overrides,
      };
      await doRefresh();
    } catch (err) {
      if (disposed) return;
      state = { ...state, creating: false, createError: upsertErrorMessage(err) };
    } finally {
      if (!disposed) render();
    }
  };

  const renderCreateForm = (): void => {
    if (!canCreate) return;
    const form = doc.createElement('div');
    form.setAttribute(PERMISSIONS_CREATE_FORM_ATTR, '');
    form.className = 'perm-create';

    const heading = doc.createElement('div');
    heading.className = 'perm-create-heading';
    heading.textContent = 'Add a rule';
    form.appendChild(heading);

    const addSelect = (
      attr: string,
      labelText: string,
      options: ReadonlyArray<{ value: string; label: string }>,
      current: string,
      disabled: boolean,
      onChange: (value: string) => void,
    ): void => {
      const field = doc.createElement('label');
      field.className = 'perm-create-field';
      const span = doc.createElement('span');
      span.className = 'perm-create-label';
      span.textContent = labelText;
      field.appendChild(span);
      const select = doc.createElement('select');
      select.setAttribute(attr, '');
      if (disabled) select.setAttribute('disabled', '');
      for (const opt of options) {
        const o = doc.createElement('option');
        o.setAttribute('value', opt.value);
        o.textContent = opt.label;
        if (opt.value === current) o.setAttribute('selected', '');
        select.appendChild(o);
      }
      select.value = current; // reflect the selection in the real DOM
      if (!disabled) {
        select.addEventListener('change', () => {
          onChange(select.value);
        });
      }
      field.appendChild(select);
      form.appendChild(field);
    };

    // Actor.
    addSelect(
      PERMISSIONS_CREATE_ACTOR_ATTR,
      'Actor',
      [{ value: '', label: 'Choose who…' }, ...ACTOR_OPTIONS],
      state.draft.actor,
      false,
      (v) => updateDraft('actor', v as CreateDraft['actor']),
    );

    // Ingredient (from the catalog).
    const catalog = state.catalog ?? [];
    const ingredientDisabled =
      state.catalog === null || state.catalogError !== null || catalog.length === 0;
    const ingredientPlaceholder =
      state.catalogError !== null
        ? `Recued cannot list them: ${state.catalogError}`
        : state.catalog === null
          ? 'Loading Ingredients…'
          : catalog.length === 0
            ? 'No Ingredients installed'
            : 'Choose an Ingredient…';
    addSelect(
      PERMISSIONS_CREATE_INGREDIENT_ATTR,
      'Ingredient',
      [
        { value: '', label: ingredientPlaceholder },
        ...catalog.map((c) => ({ value: c.ingredient_id, label: c.name })),
      ],
      state.draft.ingredient_id,
      ingredientDisabled,
      (v) => updateDraft('ingredient_id', v),
    );

    // Operation (the selected ingredient's ops + an ingredient-wide option).
    const selected = catalog.find(
      (c) => c.ingredient_id === state.draft.ingredient_id,
    );
    addSelect(
      PERMISSIONS_CREATE_OPERATION_ATTR,
      'Operation',
      [
        { value: '', label: 'Everything this Ingredient does' },
        ...(selected?.operations ?? []).map((op) => ({
          value: op.operation_id,
          label: `${bareOperation(state.draft.ingredient_id, op.operation_id)} (${op.risk_tier})`,
        })),
      ],
      state.draft.operation_id ?? '',
      state.draft.ingredient_id === '',
      (v) => updateDraft('operation_id', v === '' ? null : v),
    );

    // Policy — denied checkbox.
    const deniedField = doc.createElement('label');
    deniedField.className = 'perm-create-field perm-create-check';
    const deniedBox = doc.createElement('input');
    deniedBox.setAttribute('type', 'checkbox');
    deniedBox.setAttribute(PERMISSIONS_CREATE_DENIED_ATTR, '');
    if (state.draft.denied) deniedBox.setAttribute('checked', '');
    deniedBox.checked = state.draft.denied;
    deniedBox.addEventListener('change', () => {
      updateDraft('denied', deniedBox.checked);
    });
    deniedField.appendChild(deniedBox);
    const deniedSpan = doc.createElement('span');
    deniedSpan.className = 'perm-create-label';
    deniedSpan.textContent = 'Never allow it';
    deniedField.appendChild(deniedSpan);
    form.appendChild(deniedField);

    // Policy — approval + max-risk selects.
    addSelect(
      PERMISSIONS_CREATE_APPROVAL_ATTR,
      'Approval',
      [
        { value: '', label: 'No change' },
        ...APPROVAL_OPTIONS.map((a) => ({ value: a, label: a })),
      ],
      state.draft.approval ?? '',
      false,
      (v) => updateDraft('approval', v as CreateDraft['approval']),
    );
    addSelect(
      PERMISSIONS_CREATE_MAXRISK_ATTR,
      'How risky it may get before asking you',
      [
        { value: '', label: 'No change' },
        ...MAX_RISK_OPTIONS.map((r) => ({ value: r, label: r })),
      ],
      state.draft.max_risk_without_approval ?? '',
      false,
      (v) =>
        updateDraft(
          'max_risk_without_approval',
          v as CreateDraft['max_risk_without_approval'],
        ),
    );

    // Save.
    const save = doc.createElement('button');
    save.setAttribute(PERMISSIONS_CREATE_SAVE_ATTR, '');
    save.setAttribute('type', 'button');
    save.className = 'perm-create-save';
    if (state.creating) {
      save.setAttribute('disabled', '');
      save.textContent = 'Saving…';
    } else {
      save.textContent = 'Add the rule';
      save.addEventListener('click', () => {
        void submitCreate();
      });
    }
    form.appendChild(save);

    if (state.createError !== null) {
      appendLine(
        form,
        PERMISSIONS_CREATE_ERROR_ATTR,
        'perm-create-error',
        state.createError,
      );
    }

    root.appendChild(form);
  };

  // ── Initial paint + seed load ────────────────────────────────────
  render();
  void doRefresh();
  if (canCreate) void loadCatalog();

  return {
    getState: () => state.phase,
    getOverrides: () => state.overrides,
    getListError: () => state.listError,
    refresh: () => doRefresh(),
    whenLoaded: () => pendingLoad,
    hasInFlightWork: () => state.creating || pendingByRow.size > 0,
    deleteOverride: async (actor, ingredientId, operationId) => {
      const target = operationId ?? null;
      const view = state.overrides.find(
        (v) =>
          v.actor === actor
          && v.ingredient_id === ingredientId
          && v.operation_id === target,
      );
      // No-op for an unknown row (a row already deleting is guarded inside
      // runDelete).
      if (view === undefined) return;
      await runDelete(view);
    },
    getCatalog: () => state.catalog ?? [],
    whenCatalogLoaded: () => pendingCatalog,
    setCreateField: (field, value) => updateDraft(field, value),
    submitCreate: () => submitCreate(),
    getCreateError: () => state.createError,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      try {
        opts.host.removeChild(root);
      } catch {
        // Some fake DOMs / a detached host throw on removeChild; ignore — the
        // host is the caller's to retain or discard.
      }
    },
  };
};

// ════════════════════════════════════════════════════════════════
// Styles
// ════════════════════════════════════════════════════════════════

/** Self-scoped CSS for the rules editor, scoped under
 *  `[data-recued-permissions-panel]` so the rules are inert when the panel
 *  isn't mounted. The Contracts route joins this into its `<style>` bundle. */
export const PERMISSIONS_PANEL_STYLES = `

[data-recued-permissions-panel] .perm-loading,
[data-recued-permissions-panel] .perm-empty {
  font-size: 13px;
  color: var(--muted);
  padding: 6px 2px;
}
[data-recued-permissions-panel] .perm-error,
[data-recued-permissions-panel] .perm-row-error {
  font-size: 13px;
  color: var(--fail);
  padding: 6px 2px;
}
[data-recued-permissions-panel] [${PERMISSIONS_OVERRIDE_CARD_ATTR}] {
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 12px;
  margin: 8px 0;
}
[data-recued-permissions-panel] .perm-card-header {
  margin-bottom: 6px;
  font-family: var(--mono, ui-monospace, monospace);
  font-size: 13px;
}
[data-recued-permissions-panel] .perm-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 6px 0;
  border-top: 1px solid var(--border-subtle);
  flex-wrap: wrap;
}
[data-recued-permissions-panel] .perm-row-info {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
[data-recued-permissions-panel] .perm-row-heading {
  display: flex;
  align-items: baseline;
  gap: 8px;
}
[data-recued-permissions-panel] .perm-actor {
  font-size: 13px;
  font-weight: 600;
}
[data-recued-permissions-panel] .perm-op {
  font-size: 12px;
  color: var(--muted);
  font-family: var(--mono, ui-monospace, monospace);
}
[data-recued-permissions-panel] .perm-facets {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
[data-recued-permissions-panel] .perm-facet {
  font-size: 11px;
  padding: 1px 8px;
  border-radius: 999px;
  background: var(--surface-subtle);
  color: var(--muted);
  white-space: nowrap;
}
[data-recued-permissions-panel] .perm-delete {
  font-size: 13px;
  padding: 4px 12px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface);
  color: var(--fail);
  cursor: pointer;
  white-space: nowrap;
}
[data-recued-permissions-panel] .perm-delete[disabled] {
  opacity: 0.6;
  cursor: default;
}
[data-recued-permissions-panel] .perm-confirm {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
[data-recued-permissions-panel] .perm-confirm-prompt {
  font-size: 12px;
  color: var(--fail);
  white-space: nowrap;
}
[data-recued-permissions-panel] .perm-confirm-yes {
  border-color: var(--fail);
}
[data-recued-permissions-panel] .perm-cancel {
  font-size: 13px;
  padding: 4px 12px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface);
  cursor: pointer;
  white-space: nowrap;
}
[data-recued-permissions-panel] [${PERMISSIONS_CREATE_FORM_ATTR}] {
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px;
  margin: 8px 0 16px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  background: var(--surface-subtle);
}
[data-recued-permissions-panel] .perm-create-heading {
  font-size: 13px;
  font-weight: 600;
}
[data-recued-permissions-panel] .perm-create-field {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 12px;
}
[data-recued-permissions-panel] .perm-create-check {
  box-sizing: border-box;
  min-height: 36px;
  flex-direction: row;
  align-items: center;
  gap: 6px;
  padding: 4px 2px;
  cursor: pointer;
}
[data-recued-permissions-panel] .perm-create-check input {
  width: 16px;
  height: 16px;
  margin: 0;
  accent-color: var(--accent);
  cursor: inherit;
}
[data-recued-permissions-panel] .perm-create-label {
  color: var(--muted);
}
[data-recued-permissions-panel] .perm-create-save {
  box-sizing: border-box;
  min-height: 36px;
  align-self: flex-start;
  font-size: 13px;
  padding: 6px 14px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface);
  cursor: pointer;
}
[data-recued-permissions-panel] .perm-create-save[disabled] {
  opacity: 0.6;
  cursor: default;
}
[data-recued-permissions-panel] .perm-create-error {
  font-size: 13px;
  color: var(--fail);
}
`;
