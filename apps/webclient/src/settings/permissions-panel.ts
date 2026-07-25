/** D-166 Slice B1+B2 — Settings → Permissions override panel.
 *
 *  The PWA surface that makes the `contract.override.*` tightening layer
 *  user-legible + editable: it CREATES override rows (B2 form), LISTS the rows
 *  a user has authored, and DELETES one to revert that `(actor, ingredient,
 *  operation?)` key back to the connection-keyed grant floor. The gateway
 *  already honours overrides live (Slice 4d.4 + A1's write path); before this
 *  panel there was no way for a human (only a test) to author / see / remove
 *  one.
 *
 *  ── Two halves, gated independently ──────────────────────────────────
 *  The read+delete INVENTORY always renders (needs only `runListOverrides` +
 *  `runDeleteOverride`). The CREATE form (B2 — actor → ingredient → operation
 *  → policy, via `runUpsertOverride` + `runListCatalogOperations`) renders ONLY
 *  when BOTH create callers are wired (`canCreate`); a create surface with no
 *  catalog/writer is dead, so the panel degrades to read+delete when either is
 *  absent. The Settings section gates on all four callers, so in production both
 *  halves are present.
 *
 *  ── Create form: controlled draft, hand-built, enforced facets only ──
 *  Three picker selects (actor / ingredient / operation) + three policy controls
 *  (a `denied` checkbox, `approval` + `max_risk_without_approval` selects), all
 *  hand-built (no `@recued/ui-shared` form-renderer — its `FormDefinition` shape
 *  doesn't fit). Only the DISPATCH-ENFORCED policy facets are authorable;
 *  `timeout_ms` / `cache_ttl_ms` are deliberately absent (the gateway ignores
 *  them today, so a control would author a restriction that does nothing). The
 *  form is state-driven (`state.draft`): `change` listeners (production) + the
 *  `setCreateField` handle seam (tests — the fake DOM can't fire `change`)
 *  funnel through `updateDraft` → re-render. `change` (not `input`) means a
 *  re-render lands after the field is committed, so no mid-type focus loss.
 *  `submitCreate` validates (actor/ingredient chosen, policy non-empty via
 *  `isEmptyOverridePolicy`) → `upsertOverride` → clears the draft → reconciles
 *  the inventory. A `contract_write_loosens` rejection names the loosened
 *  fields; `bad_request` surfaces the server message.
 *
 *  ── Deleting loosens policy — so it is deliberate + truthful ─────────
 *  Removing a tightening override reverts that key to the (looser) grant
 *  floor, so Delete is a two-stage inline confirm (single row armed at a time,
 *  mirroring the Devices panel's `pair.revoke` flow): the first click arms
 *  "Confirm" / "Cancel"; only the second commits. And because
 *  `deleteOverride` returns just `{ deleted }` (no fresh row), a successful
 *  delete OPTIMISTICALLY drops the row from local state BEFORE the reconciling
 *  re-list — so if that re-list fails or is superseded, the panel still shows
 *  the override as gone (it IS gone server-side), never as a still-active,
 *  clickable row. A delete failure surfaces on the row's error chip and leaves
 *  the row intact.
 *
 *  ── Broadcast subscription: the mcp door only ────────────────────────
 *  The `contract.override.*` editor takes no `subscribe` seam — override writes
 *  ride the pair-sync wire, not the D-121 realtime bus (like the Connections
 *  grant panel) — so it stays current two ways: (1) a create / delete reconciles
 *  via a re-list (a create after the upsert; a delete after the optimistic drop
 *  above); (2) `refresh()` on the handle re-lists for host-driven reloads. The
 *  D-171 **mcp door** below DOES take a `subscribe` seam (slice-2c follow-on #2):
 *  the inbound token has a real D-121 broadcast (`chat.inbound_token_changed`),
 *  so the door live-syncs across paired clients — see the D-171 block. The
 *  `loadGeneration` guard (shared discipline with the grant / packs / asks
 *  panels) drops a stale in-flight list when a newer one overtakes it.
 *
 *  ── Concurrency ──────────────────────────────────────────────────────
 *  A delete is allowed one-at-a-time per row (`pendingByRow`, keyed on the
 *  `(actor, ingredient, operation)` triple): while it is in flight that row's
 *  button renders disabled with a busy label. A delete also bumps
 *  `loadGeneration` at start so a list started before it cannot land its
 *  (pre-delete) write over the post-delete re-list.
 *
 *  ── Render model: DOM nodes, not innerHTML ───────────────────────────
 *  The Delete buttons carry real click listeners, so the panel rebuilds its
 *  content via `createElement` + `clearChildren` on every render (the same
 *  shape as `connections-grant-panel.ts` / `asks-panel.ts`), not via an HTML
 *  string with `data-action` delegation.
 *
 *  ── D-171 doors reframe (slices 1-2c) ───────────────────────────────
 *  D-171 reorganises this panel into a **doors view**: the externally-
 *  reachable channels (`mcp` / `reception` / `messenger`) render as the
 *  top-level frame, and the override editor above becomes the per-tool
 *  tightening layer *within* a door ("Per-tool restrictions"). Slice 1
 *  shipped the informational doors frame; **slice 2 makes the `mcp` door
 *  interactive** — the load-bearing D-171 idea that the MCP token is
 *  *derived from the door, not authored* (decision 2). Enabling the door
 *  issues an inbound MCP token (`chat.inbound_token.issue`) and reveals its
 *  one-time bearer for copy; disabling revokes it (`chat.inbound_token.revoke`)
 *  behind a guarded two-stage confirm whose copy makes the client-breakage
 *  consequence unmistakable (decision 6 — revoke is the kill-switch). The
 *  door owns ONE derived token, keyed on the reserved `MCP_DOOR_TOKEN_LABEL`
 *  (decisions 2/3 — Recued is agnostic to agent↔token fan-out). The token
 *  value is shown exactly once (the rpc surfaces the plaintext only at
 *  issuance), so the reveal/copy panel holds it in memory for this session
 *  and otherwise references the active token by its non-secret `token_id`.
 *  **Slice 2b** adds the highlighted Chat row (the token's `chat_mode`,
 *  decision 4) and **slice 2c** the per-tool grant checklist — the
 *  functional gate the inbound MCP dispatch enforces. Both edit the LIVE
 *  token in place via `chat.inbound_token.update_grants` (the value is
 *  unchanged, so clients keep working): the Chat row sends `chat_mode` only,
 *  the checklist sends `grants` only, and the rpc preserves the absent field
 *  so they never clobber each other. The checklist's catalog comes from
 *  `chat.inbound_token.tool_catalog` (the live self `ToolEntry[]`), grouped
 *  by ingredient kind via `chat-inbound-tokens.ts`. The door opens with a
 *  least-privilege, never-expiring token (default-deny — nothing granted
 *  until the user toggles a tool / Chat on).
 *
 *  **Slice 3b** adds the **Advanced** sub-panel (two default-off limits — a
 *  usage cap + an expiry — decisions 5/6). Turning a limit on lazily mints a
 *  scoped `contract_definition` (`{ channels: ['mcp'] }` + `max_uses` /
 *  `expiry_at`) and rebinds the LIVE token to it in place via
 *  `chat.inbound_token.update_contract` — the token value is unchanged, so
 *  clients keep working; the bound contract's revoke / expiry / exhaustion is
 *  the D-166 live kill-switch. Turning every limit off unbinds + revokes the
 *  contract. The common path (open door + grant tools) stays free of any
 *  `ct_*` — a contract exists ONLY while a limit is on. The standalone
 *  Contracts mint form (`df143185`) is folded in here + removed (decision 7).
 *
 *  **Slice-2c follow-on #2** wires the `subscribe` seam: the open mcp door
 *  re-lists its tokens on every `chat.inbound_token_changed` broadcast, so a
 *  grant / chat / open / disable edit on ANY paired client reflects here live
 *  (no manual refresh). **D-171** adds a dedicated `contract.contract_definition_changed`
 *  bus event (emitted by `mintContract` / `revokeContract`); the open door's
 *  Advanced sub-panel re-lists its contracts off THAT kind directly — dropping
 *  the earlier token proxy, which fired off the paired `update_contract` op and
 *  so missed the trailing bare `revokeContract` of a prior limit. The Privacy →
 *  Contracts inspector keys its own live re-list off the same contract kind.
 *
 *  Spec: docs/d-166-spec.md + docs/d-171-spec.md; the override rpc shapes +
 *  row value live in `packages/contracts/src/contract-override.ts`; the
 *  inbound-token shapes in `packages/contracts/src/chat.ts`. */

import type {
  Actor,
  CatalogIngredientView,
  Channel,
  ContractDefinitionView,
  ContractScope,
  IssuedMcpInboundToken,
  McpInboundConcurrencyTier,
  McpInboundTokenChatMode,
  McpInboundTokenRecord,
  MintContractRequest,
  OverridePolicyInput,
  OverrideView,
  ToolEntry,
} from '@recued/contracts';
import {
  isEmptyOverridePolicy,
  isMcpInboundTokenActive,
  getMessengerVendorDeclaration,
  listMessengerVendors,
} from '@recued/contracts';
import {
  buildChatInboundTokenDetailModel,
  CHAT_INBOUND_TOKEN_KIND_COPY,
  projectToggledChatInboundTokenKind,
  projectToggledChatInboundTokenTool,
  type ChatInboundTokenGroupKind,
  type ChatInboundTokenKindGroup,
} from '../contracts/chat-inbound-tokens.js';
import type { BroadcastSubscriber } from '../realtime/subscriber.js';
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

// ── D-171 slice 2 — mcp door inbound-token caller seams ─────────────

/** `chat.inbound_token.list` caller seam. Lists every persisted inbound
 *  MCP token; the panel derives the mcp door's open/closed state from it
 *  (an active token labelled `MCP_DOOR_TOKEN_LABEL` ⇒ the door is open). */
export type PermissionsListInboundTokensCaller = () => Promise<{
  tokens: ReadonlyArray<McpInboundTokenRecord>;
}>;

/** The issue payload the mcp door sends — the required subset of
 *  `chat.inbound_token.issue`. The door never sets `peer_handle` /
 *  `contract_id` (Recued is agnostic to agent↔token fan-out; caps +
 *  contract binding are a later Advanced slice). */
export interface PermissionsIssueInboundTokenArgs {
  label: string;
  grants: Readonly<Record<string, boolean>>;
  concurrency_tier: McpInboundConcurrencyTier;
  expires_at: number;
  chat_mode: McpInboundTokenChatMode;
}

/** `chat.inbound_token.issue` caller seam. Returns the issued envelope
 *  WITH the one-time bearer plaintext (surfaced exactly once — the panel
 *  holds it in memory for reveal/copy and never persists it). */
export type PermissionsIssueInboundTokenCaller = (
  args: PermissionsIssueInboundTokenArgs,
) => Promise<IssuedMcpInboundToken>;

/** `chat.inbound_token.revoke` caller seam. The door's kill-switch
 *  (D-171 decision 6 — revoke is audit-preserving, not a hard-delete). */
export type PermissionsRevokeInboundTokenCaller = (args: {
  token_id: string;
}) => Promise<{ revoked: boolean; token: McpInboundTokenRecord }>;

/** The `chat.inbound_token.update_grants` payload the door sends. Both `grants`
 *  and `chat_mode` are OPTIONAL (preserve-on-absent), so the two edits never
 *  clobber each other: the Chat row (slice 2b) sends `chat_mode` only — it does
 *  NOT echo a (possibly stale) grants snapshot — and the per-tool grant
 *  checklist (slice 2c) sends `grants` only. The token value stays stable
 *  across either edit (decision 6). At least one field must be present. */
export interface PermissionsUpdateInboundTokenArgs {
  token_id: string;
  grants?: Readonly<Record<string, boolean>>;
  chat_mode?: McpInboundTokenChatMode;
}

/** D-171 slice 2b — `chat.inbound_token.update_grants` caller seam. Edits the
 *  live token's grants / `chat_mode` IN PLACE (no re-issue). The Chat row
 *  (slice 2b) toggles `chat_mode`; the per-tool grant checklist (slice 2c)
 *  toggles `grants`. */
export type PermissionsUpdateInboundTokenCaller = (
  args: PermissionsUpdateInboundTokenArgs,
) => Promise<{ token: McpInboundTokenRecord }>;

/** D-171 slice 2c — `chat.inbound_token.tool_catalog` caller seam. Returns
 *  the live self tool catalog (`ToolEntry[]` — Tier 1 + 2 + 3 self tools)
 *  the mcp door's per-tool grant checklist renders. Read-only; the panel
 *  groups it by ingredient kind + diffs it against the open token's grants.
 *  Loaded once on mount (alongside the inbound-token list); the catalog the
 *  grant keys lower onto is the same surface the inbound MCP dispatch gate
 *  authorises against. */
export type PermissionsToolCatalogCaller = () => Promise<{
  catalog: ReadonlyArray<ToolEntry>;
}>;

// ── D-171 slice 3b — mcp door Advanced (lazy cap/expiry contract) seams ──

/** `collection.contract.mintContract` caller seam. The Advanced sub-panel mints
 *  a `contract_definition` (scope `{ channels: ['mcp'] }` + `max_uses` / `expiry_at`)
 *  lazily — only when the user turns on a usage cap or an expiry — and binds the
 *  LIVE door token to it (decision 5). Returns the minted view (with the resolved
 *  `lifecycle_state`) so the panel can render the new limit before the re-list. */
export type PermissionsMintContractCaller = (
  args: MintContractRequest,
) => Promise<ContractDefinitionView>;

/** `collection.contract.revokeContract` caller seam. Retires the door's prior
 *  limit contract when the user clears a limit or re-mints with new values
 *  (the token is rebound first, so it is never bound to a revoked contract). */
export type PermissionsRevokeContractCaller = (args: {
  contract_id: string;
  reason?: string;
}) => Promise<ContractDefinitionView>;

/** `collection.contract.listContracts` caller seam. The token carries only the
 *  opaque `contract_id`; the cap/expiry VALUES live on the `contract_definition`,
 *  so the Advanced sub-panel lists contracts to resolve the bound one's
 *  `max_uses` / `expiry_at` / `uses_remaining` / `lifecycle_state` for display +
 *  to seed the draft. Read-only. */
export type PermissionsListContractsCaller = () => Promise<{
  contracts: ReadonlyArray<ContractDefinitionView>;
}>;

/** `chat.inbound_token.update_contract` caller seam (D-171 slice 3a backend).
 *  Rebinds the LIVE door token's bound `contract_id` IN PLACE — `string` binds
 *  to a minted contract, `null` unbinds. The token value is unchanged, so
 *  connected clients keep working across a cap/expiry edit (decision 6). */
export type PermissionsUpdateInboundContractCaller = (args: {
  token_id: string;
  contract_id: string | null;
}) => Promise<{ token: McpInboundTokenRecord }>;

export type PermissionsPanelState = 'loading' | 'ready' | 'error';

export type PermissionsPanelSurface = 'settings-permissions' | 'contracts-detail';

export interface MountPermissionsPanelOptions {
  /** Host element the panel renders into. The panel appends a single wrapper
   *  div + rebuilds its inner contents across state changes. `dispose()`
   *  drops the wrapper. */
  host: HTMLElement;
  /** DOM document seam. Defaults to `globalThis.document`. */
  document?: Document;
  /** Presentation mode. The default keeps the historical Settings Permissions
   *  frame; `contracts-detail` renders only the MCP-door credential surface and
   *  treats the override editor as optional non-door content. */
  surface?: PermissionsPanelSurface;
  /** `collection.contract.listOverrides` caller seam. */
  runListOverrides?: PermissionsListOverridesCaller;
  /** `collection.contract.deleteOverride` caller seam. */
  runDeleteOverride?: PermissionsDeleteOverrideCaller;
  /** `collection.contract.upsertOverride` caller seam (B2 create form). The
   *  create form mounts ONLY when BOTH this and `runListCatalogOperations` are
   *  supplied — a create surface with no catalog (or no writer) is dead, so the
   *  panel degrades to the read+delete inventory when either is absent. */
  runUpsertOverride?: PermissionsUpsertOverrideCaller;
  /** `collection.contract.listCatalogOperations` caller seam (B2 picker's
   *  ingredient/operation source). Required alongside `runUpsertOverride` for
   *  the create form. */
  runListCatalogOperations?: PermissionsListCatalogOperationsCaller;
  /** D-171 slice 2 — `chat.inbound_token.list` caller (the mcp door's
   *  derived state). The mcp door becomes interactive ONLY when all three
   *  inbound-token callers (list / issue / revoke) are wired; otherwise it
   *  stays the slice-1 informational row. */
  runListInboundTokens?: PermissionsListInboundTokensCaller;
  /** D-171 slice 2 — `chat.inbound_token.issue` caller (open the door). */
  runIssueInboundToken?: PermissionsIssueInboundTokenCaller;
  /** D-171 slice 2 — `chat.inbound_token.revoke` caller (disable the door). */
  runRevokeInboundToken?: PermissionsRevokeInboundTokenCaller;
  /** D-171 slice 2b — `chat.inbound_token.update_grants` caller (edit the live
   *  token's grants / chat_mode in place). Gates the Chat row INDEPENDENTLY of
   *  the door's open/disable lifecycle: when absent, the open door still works
   *  but renders no Chat row (graceful degrade). Requires the door's three
   *  callers too (the Chat row only shows on an open door). */
  runUpdateInboundToken?: PermissionsUpdateInboundTokenCaller;
  /** D-171 slice 2c — `chat.inbound_token.tool_catalog` caller (the per-tool
   *  grant checklist's catalog source). Gates the checklist INDEPENDENTLY:
   *  it renders only when this AND `runUpdateInboundToken` are wired (on top
   *  of the door's lifecycle trio) — listing tools is useless without a way
   *  to grant them. When absent the open door still works (token reveal +
   *  Chat row) but renders no grant checklist (graceful degrade). */
  runListToolCatalog?: PermissionsToolCatalogCaller;
  /** D-171 slice 3b — `collection.contract.mintContract` caller (the Advanced
   *  sub-panel's lazy cap/expiry contract). Gates the Advanced sub-panel
   *  alongside the other three contract callers below: all four are needed to
   *  mint a limit, rebind the token, resolve the bound contract's values, and
   *  retire it. When any is absent the open door drops the Advanced sub-panel
   *  but keeps the rest (graceful degrade). */
  runMintContract?: PermissionsMintContractCaller;
  /** D-171 slice 3b — `collection.contract.revokeContract` caller (retire the
   *  door's prior limit contract on clear / re-mint). */
  runRevokeContract?: PermissionsRevokeContractCaller;
  /** D-171 slice 3b — `collection.contract.listContracts` caller (resolve the
   *  bound contract's cap/expiry values; the token carries only the id). */
  runListContracts?: PermissionsListContractsCaller;
  /** D-171 slice 3b — `chat.inbound_token.update_contract` caller (rebind the
   *  live token to a minted contract in place; `null` unbinds). */
  runUpdateInboundContract?: PermissionsUpdateInboundContractCaller;
  /** Clock seam (defaults to `Date.now`). Evaluates token expiry when
   *  deriving the mcp door's open/closed state. */
  now?: () => number;
  /** D-171 slice-2c follow-on #2 — the D-121 broadcast subscribe seam
   *  (`subscriber.on`). When wired, the open mcp door live-syncs across paired
   *  clients: a `chat.inbound_token_changed` frame — issued by THIS or ANOTHER
   *  client's door open / disable / grant / chat / cap / expiry edit — re-lists
   *  the inbound tokens (and the Advanced sub-panel's contracts when
   *  `canEditMcpAdvanced`) so the grant checklist + Chat row + cap/expiry reflect
   *  the latest server state without a manual refresh. Optional — a no-bus
   *  harness / test leaves the panel on its reconcile-after-write + host
   *  `refresh()` path. Only the `mcp` door subscribes; the `contract.override.*`
   *  editor rides pair-sync (no bus event) and re-lists after its own writes. */
  subscribe?: BroadcastSubscriber['on'];
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
  /** Delete one override — commits directly (the programmatic equivalent of the
   *  UI's arm-then-Confirm two-stage click). A no-op for an unknown row or a row
   *  with a delete already in flight. Test seam + host convenience; awaits the
   *  rpc + the resulting re-render. */
  deleteOverride(
    actor: Actor,
    ingredientId: string,
    operationId?: string,
  ): Promise<void>;
  /** B2 — the loaded catalog (catalog-form ingredients + their ops) backing the
   *  create form's ingredient/operation pickers. Empty before the catalog
   *  resolves, on a catalog-load failure, or when the create form is disabled
   *  (no create callers wired). */
  getCatalog(): ReadonlyArray<CatalogIngredientView>;
  /** B2 — resolves after the on-mount catalog load settles (or immediately when
   *  the create form is disabled). Test seam for the picker. */
  whenCatalogLoaded(): Promise<void>;
  /** B2 — set one create-form draft field, the same path a control change
   *  drives (re-renders; setting `ingredient_id` resets `operation_id` to
   *  ingredient-wide). No-op when the create form is disabled. Test seam +
   *  host convenience (the fake DOM can't fire `change`). */
  setCreateField<K extends keyof CreateDraft>(
    field: K,
    value: CreateDraft[K],
  ): void;
  /** B2 — submit the current create draft (validate → `upsertOverride` →
   *  refresh the inventory). A no-op when the create form is disabled or a
   *  submit is already in flight. Surfaces validation / `contract_write_loosens`
   *  / `bad_request` messages via `getCreateError()`. */
  submitCreate(): Promise<void>;
  /** B2 — the current create-form error (validation, loosen-rejection, or
   *  `bad_request`), or null. */
  getCreateError(): string | null;
  /** D-171 slice 2 — resolves after the on-mount inbound-token list settles
   *  (or immediately when the mcp-door callers aren't wired). Test seam. */
  whenTokensLoaded(): Promise<void>;
  /** D-171 slice 2 — true when the mcp door is open (an active token
   *  labelled `MCP_DOOR_TOKEN_LABEL` exists). */
  getMcpDoorOpen(): boolean;
  /** D-171 slice 2 — the one-time bearer plaintext held in memory after THIS
   *  session opened the door, or null (the rpc surfaces it once; it is never
   *  re-fetched). Test seam + host introspection. */
  getMcpDoorTokenPlaintext(): string | null;
  /** D-171 slice 2 — open the mcp door (issue a token). Commits directly (the
   *  programmatic equivalent of the Enable click). A no-op when the door
   *  callers aren't wired or an action is already in flight. */
  enableMcpDoor(): Promise<void>;
  /** D-171 slice 2 — disable the mcp door (revoke the token). Commits directly
   *  (the programmatic equivalent of the armed Confirm). A no-op when the
   *  callers aren't wired or an action is already in flight. */
  disableMcpDoor(): Promise<void>;
  /** D-171 slice 2b — true when the open door's token offers Chat (its
   *  `chat_mode.offered`). False when the door is closed or chat-mode is off. */
  getMcpDoorChatOffered(): boolean;
  /** D-171 slice 2b — toggle the Chat row (the token's `chat_mode`) on the open
   *  door's live token, echoing its current grants (the rpc replaces the whole
   *  map). The token value is unchanged (decision 6). Commits directly (the
   *  programmatic equivalent of the Chat toggle click). A no-op when the door
   *  is closed, the update caller isn't wired, or an action is already in
   *  flight. */
  setMcpDoorChat(offered: boolean): Promise<void>;
  /** D-171 slice 2c — resolves after the on-mount tool-catalog load settles
   *  (or immediately when the grant checklist isn't wired). Test seam. */
  whenToolCatalogLoaded(): Promise<void>;
  /** D-171 slice 2c — the open door token's grant checklist, grouped by
   *  ingredient kind (each group's per-tool rows carry the live grant state).
   *  Empty when the door is closed, the catalog hasn't loaded, or the
   *  checklist isn't wired. Test seam + host introspection. */
  getMcpDoorGrantGroups(): ReadonlyArray<ChatInboundTokenKindGroup>;
  /** D-171 slice 2c — grant / revoke ONE tool on the open door's live token.
   *  Edits the token's `grants` in place via `update_grants` sending `grants`
   *  ONLY (chat-mode preserved server-side, so it never clobbers the Chat
   *  toggle). The token value is unchanged (decision 6). Idempotent — a no-op
   *  when the tool is already in the requested state. A no-op when the door is
   *  closed, the checklist isn't wired, or an action is already in flight. */
  setMcpDoorToolGrant(toolName: string, granted: boolean): Promise<void>;
  /** D-171 slice 2c — grant / revoke EVERY catalog tool of one ingredient
   *  kind at once (the per-kind master toggle). Same in-place `grants`-only
   *  edit as `setMcpDoorToolGrant`; tools outside the live catalog (stale
   *  grants) are left untouched. A no-op when the door is closed, the catalog
   *  hasn't loaded, the checklist isn't wired, or an action is in flight. */
  setMcpDoorKindGrant(
    kind: ChatInboundTokenGroupKind,
    granted: boolean,
  ): Promise<void>;
  /** D-171 slice 3b — resolves after the on-mount contracts load settles (or
   *  immediately when the Advanced sub-panel isn't wired). Test seam. */
  whenAdvancedLoaded(): Promise<void>;
  /** D-171 slice 3b — the `contract_definition` the open door's token is bound
   *  to (the active limit), or null when the door is closed / unbound / the
   *  Advanced sub-panel isn't wired / the bound contract isn't in the listed
   *  set. Carries the `max_uses` / `expiry_at` / `uses_remaining` /
   *  `lifecycle_state` the sub-panel renders. Test seam + host introspection. */
  getMcpDoorBoundContract(): ContractDefinitionView | null;
  /** D-171 slice 3b — set one Advanced-draft field, the same path a control
   *  change drives (re-renders). No-op when the Advanced sub-panel is disabled.
   *  Test seam + host convenience (the fake DOM can't fire `change`). */
  setAdvancedField<K extends keyof AdvancedDraft>(
    field: K,
    value: AdvancedDraft[K],
  ): void;
  /** D-171 slice 3b — apply the current Advanced draft (cap + expiry) to the
   *  open door's token via the lazy mint → rebind → revoke-prior orchestration
   *  (decision 5). Clearing every limit unbinds + revokes the bound contract;
   *  the token value is unchanged either way (decision 6). A no-op when the
   *  door is closed, the sub-panel isn't wired, the draft equals the live
   *  limit, or an action is already in flight. Surfaces validation /
   *  rpc errors via `getAdvancedError()`. */
  submitMcpDoorLimits(): Promise<void>;
  /** D-171 slice 3b — the current Advanced-sub-panel error (validation or rpc),
   *  or null. */
  getAdvancedError(): string | null;
  /** Tear down the panel DOM. Idempotent. */
  dispose(): void;
}

// ════════════════════════════════════════════════════════════════
// Attribute constants — stable hooks for tests + the Settings shell
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

// ── D-171 doors frame (slice 1) ──────────────────────────────────────
/** The doors section wrapper — the panel's top-level organizing frame
 *  (D-171: contract / token / permission reframed as doors + per-tool grants). */
export const PERMISSIONS_DOORS_SECTION_ATTR = 'data-recued-permissions-doors';
/** One door row. Carries `data-channel` (the externally-reachable `Channel`). */
export const PERMISSIONS_DOOR_ROW_ATTR = 'data-recued-permissions-door';
/** The heading framing the override editor as the per-tool layer beneath the doors. */
export const PERMISSIONS_OVERRIDES_HEADING_ATTR =
  'data-recued-permissions-overrides-heading';

// ── D-171 slice 4: reception / messenger door info ──────────────────
/** D-171 slice 4 — the informational control region for a non-mcp door
 *  (`reception` / `messenger`). Unlike the `mcp` door these doors derive
 *  **no token** (decision 8) and have no per-tool grant model of their own,
 *  so the block is purely explanatory: what the door admits, where it is
 *  actually configured, and that the Per-tool restrictions below apply.
 *  Carries `data-channel` (the door's `Channel`). Always rendered (needs no
 *  callers). */
export const PERMISSIONS_DOOR_INFO_ATTR = 'data-recued-permissions-door-info';
/** D-171 slice 4 — one messenger vendor sub-row inside the `messenger` door's
 *  info block (decision 8: "one door, per-vendor underneath"). Carries
 *  `data-vendor` (the declared messenger vendor slug). */
export const PERMISSIONS_DOOR_VENDOR_ATTR =
  'data-recued-permissions-door-vendor';

// ── D-171 slice 2: mcp door controls ────────────────────────────────
/** The mcp door's control region (status + enable/disable + token panel),
 *  appended inside the `mcp` door row when the inbound-token callers are wired. */
export const PERMISSIONS_MCP_DOOR_CONTROLS_ATTR =
  'data-recued-permissions-mcp-controls';
/** The mcp door's Open / Closed status line. */
export const PERMISSIONS_MCP_DOOR_STATUS_ATTR =
  'data-recued-permissions-mcp-status';
/** The "Open the MCP door" button (closed state → issue). */
export const PERMISSIONS_MCP_DOOR_ENABLE_ATTR =
  'data-recued-permissions-mcp-enable';
/** The "Disable the MCP door" button (open state → arms the guarded confirm). */
export const PERMISSIONS_MCP_DOOR_DISABLE_ATTR =
  'data-recued-permissions-mcp-disable';
/** The armed "Revoke token" confirm (second stage → revoke). */
export const PERMISSIONS_MCP_DOOR_DISABLE_CONFIRM_ATTR =
  'data-recued-permissions-mcp-disable-confirm';
/** The armed "Cancel" (disarms the disable without revoking). */
export const PERMISSIONS_MCP_DOOR_DISABLE_CANCEL_ATTR =
  'data-recued-permissions-mcp-disable-cancel';
/** The token reveal/copy sub-panel (open state). */
export const PERMISSIONS_MCP_DOOR_TOKEN_ATTR = 'data-recued-permissions-mcp-token';
/** The element bearing the one-time plaintext (just-issued) OR the
 *  "value shown once" note (loaded without the plaintext). */
export const PERMISSIONS_MCP_DOOR_TOKEN_VALUE_ATTR =
  'data-recued-permissions-mcp-token-value';
/** The Copy button (present only when the one-time plaintext is in memory). */
export const PERMISSIONS_MCP_DOOR_TOKEN_COPY_ATTR =
  'data-recued-permissions-mcp-token-copy';
/** The mcp door's error chip (list / issue / revoke / update failure). */
export const PERMISSIONS_MCP_DOOR_ERROR_ATTR = 'data-recued-permissions-mcp-error';
/** D-171 slice 2b — the "Chat" tool row inside an open mcp door (decision 4:
 *  Chat is a tool in the door, backed by the token's `chat_mode`). */
export const PERMISSIONS_MCP_DOOR_CHAT_ROW_ATTR =
  'data-recued-permissions-mcp-chat';
/** The Chat row's toggle button (on ↔ off → `update_grants` chat_mode). */
export const PERMISSIONS_MCP_DOOR_CHAT_TOGGLE_ATTR =
  'data-recued-permissions-mcp-chat-toggle';

// ── D-171 slice 2c: mcp door per-tool grant checklist ───────────────
/** The grant checklist section inside an open mcp door (decision: the
 *  per-tool allow-list that lowers to the token's `grants`). */
export const PERMISSIONS_MCP_DOOR_GRANTS_ATTR =
  'data-recued-permissions-mcp-grants';
/** The checklist's loading / error / empty line (no kind groups to show). */
export const PERMISSIONS_MCP_DOOR_GRANTS_EMPTY_ATTR =
  'data-recued-permissions-mcp-grants-empty';
/** One grant group. Carries `data-kind` (the `ChatInboundTokenGroupKind` —
 *  an `IngredientKind` or a D-171 legacy bucket `recued_native` /
 *  `recued_ingredient`) + `data-master` (`all` / `none` / `mixed`). */
export const PERMISSIONS_MCP_DOOR_GRANT_KIND_ATTR =
  'data-recued-permissions-mcp-grant-kind';
/** The per-kind master toggle (grants / revokes every tool in the kind). */
export const PERMISSIONS_MCP_DOOR_GRANT_KIND_TOGGLE_ATTR =
  'data-recued-permissions-mcp-grant-kind-toggle';
/** One per-tool row. Carries `data-tool` (the `ToolEntry.name`). */
export const PERMISSIONS_MCP_DOOR_GRANT_TOOL_ATTR =
  'data-recued-permissions-mcp-grant-tool';
/** The per-tool toggle button. `data-granted` is the stable state hook. */
export const PERMISSIONS_MCP_DOOR_GRANT_TOOL_TOGGLE_ATTR =
  'data-recued-permissions-mcp-grant-tool-toggle';
/** The per-tool "also reads: <container>" transitive-admission disclosure
 *  (D-192 Slice 7). Carries `data-reads` = the comma-joined container refs. */
export const PERMISSIONS_MCP_DOOR_GRANT_TOOL_ALSO_READS_ATTR =
  'data-recued-permissions-mcp-grant-tool-also-reads';

// ── D-171 slice 3b: mcp door Advanced (lazy cap/expiry) ─────────────
/** The Advanced sub-panel inside an open mcp door (usage cap + expiry limits,
 *  default off — decisions 5/6). */
export const PERMISSIONS_MCP_DOOR_ADVANCED_ATTR =
  'data-recued-permissions-mcp-advanced';
/** The Advanced sub-panel's load / error line (a `listContracts` failure) +
 *  the read-only "current limit" summary (a bound contract's lifecycle +
 *  values). Carries `data-state` (the bound contract's `lifecycle_state`) when
 *  a limit is active. */
export const PERMISSIONS_MCP_DOOR_ADVANCED_SUMMARY_ATTR =
  'data-recued-permissions-mcp-advanced-summary';
/** The usage-cap enable toggle. `data-enabled` is the stable state hook. */
export const PERMISSIONS_MCP_DOOR_ADVANCED_CAP_TOGGLE_ATTR =
  'data-recued-permissions-mcp-advanced-cap-toggle';
/** The usage-cap value input (`max_uses`, shown when the cap is enabled). */
export const PERMISSIONS_MCP_DOOR_ADVANCED_CAP_INPUT_ATTR =
  'data-recued-permissions-mcp-advanced-cap-input';
/** The expiry enable toggle. `data-enabled` is the stable state hook. */
export const PERMISSIONS_MCP_DOOR_ADVANCED_EXPIRY_TOGGLE_ATTR =
  'data-recued-permissions-mcp-advanced-expiry-toggle';
/** The expiry date input (`expiry_at`, shown when expiry is enabled). */
export const PERMISSIONS_MCP_DOOR_ADVANCED_EXPIRY_INPUT_ATTR =
  'data-recued-permissions-mcp-advanced-expiry-input';
/** The "Save limits" button (applies the draft via the mint/rebind/revoke
 *  orchestration). */
export const PERMISSIONS_MCP_DOOR_ADVANCED_SAVE_ATTR =
  'data-recued-permissions-mcp-advanced-save';
/** The "saving resets the usage count" note (shown when a cap is enabled — a
 *  re-mint reseeds `uses_remaining`, so any save refreshes a consumed cap). */
export const PERMISSIONS_MCP_DOOR_ADVANCED_NOTE_ATTR =
  'data-recued-permissions-mcp-advanced-note';
/** The Advanced sub-panel's error chip (validation / mint / rebind / revoke). */
export const PERMISSIONS_MCP_DOOR_ADVANCED_ERROR_ATTR =
  'data-recued-permissions-mcp-advanced-error';

/** A user-facing "door" — an externally-reachable `Channel` (D-153) an outside
 *  party comes through. D-171 decision 8: the doors are `mcp` / `reception` /
 *  `messenger`; `webhook` is infra (not a door), and the owner-driven
 *  `user`/`chat` + the system channels admit no external party. */
export interface PermissionDoor {
  channel: 'mcp' | 'reception' | 'messenger';
  label: string;
  description: string;
}

/** The doors the panel surfaces, in display order. Slice 1 renders them as the
 *  organizing frame (informational rows); per-door behaviour — the mcp token
 *  reveal/copy + grants (slice 2), advanced caps/expiry (slice 3), and the
 *  reception/messenger per-door wiring (slice 4) — lands in later slices. */
export const PERMISSION_DOORS: readonly PermissionDoor[] = [
  {
    channel: 'mcp',
    label: 'MCP',
    description:
      'Let AI agents (Claude Desktop, ChatGPT, your own scripts) connect to '
      + 'Recued over MCP — call the tools you grant, and, if you allow it, talk '
      + 'to your assistant.',
  },
  {
    channel: 'reception',
    label: 'Reception',
    description:
      'Public links other people can use without an account — intake forms, '
      + 'drop links, scheduling, and approval links you publish.',
  },
  {
    channel: 'messenger',
    label: 'Messaging',
    description:
      'Inbound messages from a connected messenger that can trigger your '
      + 'recipes.',
  },
];

/** D-171 slice 2 — the reserved label identifying the mcp door's single
 *  derived token. The door owns ONE credential (decisions 2/3 — the token
 *  is derived from the door, and Recued is agnostic to agent↔token fan-out:
 *  one credential, reused across N agents or 1). Keying the open/closed
 *  state on a stable label lets it re-derive purely from the listed tokens.
 *  This panel is the only issuer of door-labelled tokens, so the label is
 *  unambiguous (pre-launch, no legacy rows). */
export const MCP_DOOR_TOKEN_LABEL = 'MCP door';

/** D-171 slice 2 — the active token backing the mcp door, or null. Picks
 *  the first active match (enabling is hidden while one exists, so there is
 *  normally exactly one). Pure. */
const activeDoorToken = (
  tokens: ReadonlyArray<McpInboundTokenRecord>,
  now: number,
): McpInboundTokenRecord | null => {
  for (const t of tokens) {
    if (t.label === MCP_DOOR_TOKEN_LABEL && isMcpInboundTokenActive(t, now)) {
      return t;
    }
  }
  return null;
};

/** D-171 slice 2 — the issue payload for the mcp door's derived token.
 *  - **Default-deny grants:** per-tool grants are authored in a later slice;
 *    the door opens with a least-privilege token (the safe posture for a
 *    security surface). The Chat row + per-tool checklist later add grants
 *    WITHOUT re-issuing — the token value stays stable (decision 6).
 *  - **Never expires (`expires_at: 0`):** D-171 makes expiry an opt-in
 *    Advanced limit; the value is destroyed only on door-disable (decision
 *    6), so the door uses the "never" sentinel rather than D-137's 1-year
 *    default (which would silently break clients after a year).
 *  - **`concurrency_tier: 5`** — the documented "Balanced" middle default.
 *  - **`chat_mode: null`** — the Chat row (decision 4) lands in a later slice. */
const buildMcpDoorIssueArgs = (): PermissionsIssueInboundTokenArgs => ({
  label: MCP_DOOR_TOKEN_LABEL,
  grants: {},
  concurrency_tier: 5,
  expires_at: 0,
  chat_mode: null,
});

/** D-171 slice 3b — the display name stamped on the mcp door's lazy limit
 *  contract. The door binds AT MOST ONE limit contract (a single envelope
 *  carrying `max_uses` and/or `expiry_at`); a fixed name keeps it legible in
 *  the Contracts inspector without per-edit churn. */
export const MCP_DOOR_CONTRACT_NAME = 'MCP door limits';

/** D-171 slice 3b — the scope minted onto the mcp door's limit contract:
 *  `{ channels: ['mcp'] }`, the wildcard-on-every-other-axis scope that admits
 *  every MCP dispatch. This is LOAD-BEARING for the usage cap: `recordUse`
 *  decrements `uses_remaining` only when the bound contract's overlay resolves
 *  `.active` for the dispatch, which requires `contractScopeMatches(scope,
 *  { channel: 'mcp', actor, ingredient_id })`. An empty axis is a wildcard, so
 *  `{ channels: ['mcp'] }` matches (channel = mcp; actor / ingredient wildcard)
 *  → the cap counts. A scope naming a narrower actor / ingredient would silently
 *  never decrement (the cap would never bite) — so the door always mints this
 *  exact scope. Revoke / expiry are the scope-INDEPENDENT kill-switch (resolved
 *  per request via `isContractActive`), so they bite regardless. */
export const MCP_DOOR_CONTRACT_SCOPE: ContractScope = { channels: ['mcp'] };

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

/** D-171 slice 3b — the mcp door Advanced sub-panel draft. Each limit is a
 *  toggle + a value: `capEnabled` gates `maxUses` (a positive-integer string,
 *  parsed at submit); `expiryEnabled` gates `expiry` (a `YYYY-MM-DD` date
 *  string, `Date.parse`d at submit). A limit OFF is the default (unlimited /
 *  never) and lowers to a `null` axis on the contract. The draft is seeded from
 *  the bound contract on load + after each save (keyed on the bound id, so a
 *  re-list never clobbers a mid-edit draft). */
export interface AdvancedDraft {
  capEnabled: boolean;
  maxUses: string;
  expiryEnabled: boolean;
  expiry: string;
}

const EMPTY_ADVANCED_DRAFT: AdvancedDraft = {
  capEnabled: false,
  maxUses: '',
  expiryEnabled: false,
  expiry: '',
};

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
  // ── B2 create form ──────────────────────────────────────────────
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
  // ── D-171 slice 2: mcp door (inbound-token lifecycle) ────────────
  /** Listed inbound tokens; null until the first list settles (or when the
   *  mcp-door callers aren't wired). Derives the door's open/closed state. */
  inboundTokens: ReadonlyArray<McpInboundTokenRecord> | null;
  /** The just-issued bearer plaintext — held in memory for reveal/copy. Only
   *  ever populated by THIS session's issue (the rpc surfaces the plaintext
   *  exactly once); cleared on revoke / dispose. Never persisted. */
  doorTokenPlaintext: string | null;
  /** The `token_id` the held `doorTokenPlaintext` belongs to. The reveal panel
   *  shows the plaintext ONLY when this matches the active door token — so a
   *  remote revoke + re-open (a NEW token_id this session never saw the secret of,
   *  surfaced live via the D-171 slice-2c follow-on #2 broadcast) renders the
   *  "shown once" note, never the stale prior bearer. Null whenever no plaintext
   *  is held. */
  doorTokenPlaintextTokenId: string | null;
  /** True while an inbound-token issue / revoke rpc is in flight (disables the
   *  door buttons). */
  doorBusy: boolean;
  /** True when Disable is armed (two-stage guarded confirm, decision 6). */
  confirmingDisableMcp: boolean;
  /** The mcp door's error (list / issue / revoke / grant edit), or null. */
  doorError: string | null;
  // ── D-171 slice 2c: per-tool grant checklist ─────────────────────
  /** The live self tool catalog backing the grant checklist; null until the
   *  on-mount load settles (or when the checklist isn't wired). The grant
   *  checklist renders a "Loading tools…" line while null. */
  toolCatalog: ReadonlyArray<ToolEntry> | null;
  /** Tool-catalog load error, or null. Degrades only the grant checklist —
   *  the door lifecycle + token reveal + Chat row are unaffected. */
  toolCatalogError: string | null;
  // ── D-171 slice 3b: Advanced (lazy cap/expiry contract) ───────────
  /** The minted `contract_definition`s; null until the on-mount load settles
   *  (or when the Advanced sub-panel isn't wired). The Advanced sub-panel
   *  resolves the open token's bound contract (by `contract_id`) out of this set
   *  to render its cap/expiry values + seed the draft. */
  contractDefs: ReadonlyArray<ContractDefinitionView> | null;
  /** Contracts-load error, or null. Degrades only the Advanced sub-panel — the
   *  door lifecycle + token reveal + Chat row + grant checklist are unaffected. */
  contractDefsError: string | null;
  /** The in-progress Advanced-sub-panel draft (cap + expiry toggles/values). */
  advancedDraft: AdvancedDraft;
  /** Advanced-sub-panel error (validation / mint / rebind / revoke), or null. */
  advancedError: string | null;
}

const errMessage = (err: unknown): string =>
  humanizeRpcError(err);

/** D-171 slice 3b — epoch-ms → `YYYY-MM-DD` for the expiry `<input type="date">`
 *  value. UTC so it round-trips with `Date.parse('YYYY-MM-DD')` (also UTC).
 *  Non-finite → `''` (the input clears). Pure. */
const toDateInputValue = (ms: number): string => {
  if (!Number.isFinite(ms)) return '';
  return new Date(ms).toISOString().slice(0, 10);
};

/** D-171 slice 3b — human label for a bound limit contract's lifecycle. An
 *  inert state (the kill-switch having fired) is named so the summary reads as
 *  "blocked", not silently. */
const CONTRACT_LIFECYCLE_LABEL: Record<ContractDefinitionView['lifecycle_state'], string> = {
  active: 'Active',
  revoked: 'Revoked',
  expired: 'Expired — door blocked',
  exhausted: 'Cap reached — door blocked',
};

/** D-171 slice 3b — one-line read-only summary of a bound limit contract:
 *  its cap (with uses-remaining) + expiry + lifecycle. Pure given the ambient
 *  locale (the date stamp is locale-formatted; no clock read). */
const boundContractSummary = (view: ContractDefinitionView): string => {
  const parts: string[] = [];
  if (view.max_uses !== undefined && view.max_uses !== null) {
    const remaining = view.uses_remaining ?? view.max_uses;
    parts.push(`usage cap ${remaining}/${view.max_uses} left`);
  }
  if (view.expiry_at !== undefined && view.expiry_at !== null) {
    parts.push(`expires ${new Date(view.expiry_at).toLocaleDateString()}`);
  }
  const limits = parts.length > 0 ? parts.join(' · ') : 'no limits';
  return `${CONTRACT_LIFECYCLE_LABEL[view.lifecycle_state]} — ${limits}`;
};

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
    parts.push(`max risk without approval: ${p.max_risk_without_approval}`);
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
  { value: 'contracted_user', label: 'A contracted agent (contracted_user)' },
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
      ? `Overrides can only tighten — this loosens: ${fields.join(', ')}`
      : 'Overrides can only tighten — this change would loosen the current policy.';
  }
  if (e.code === 'bad_request' && typeof e.message === 'string') return e.message;
  return errMessage(err);
};

// ════════════════════════════════════════════════════════════════
// Mount
// ════════════════════════════════════════════════════════════════

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

  const surface = opts.surface ?? 'settings-permissions';
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
    inboundTokens: null,
    doorTokenPlaintext: null,
    doorTokenPlaintextTokenId: null,
    doorBusy: false,
    confirmingDisableMcp: false,
    doorError: null,
    toolCatalog: null,
    toolCatalogError: null,
    contractDefs: null,
    contractDefsError: null,
    advancedDraft: EMPTY_ADVANCED_DRAFT,
    advancedError: null,
  };
  let disposed = false;
  // The create form mounts only when BOTH create callers are wired (the route
  // gate guarantees this in production; a B1-style mount omits them → no form,
  // no catalog load — the read+delete inventory is unchanged).
  const canCreate =
    canManageOverrides
    && opts.runUpsertOverride !== undefined
    && opts.runListCatalogOperations !== undefined;
  // D-171 slice 2 — the mcp door is interactive only when all three
  // inbound-token callers are wired (list derives state; issue opens; revoke
  // disables). Otherwise the mcp door stays the slice-1 informational row.
  const canManageMcpDoor =
    opts.runListInboundTokens !== undefined
    && opts.runIssueInboundToken !== undefined
    && opts.runRevokeInboundToken !== undefined;
  // D-171 slice 2b — the Chat row gates INDEPENDENTLY (on the update caller) so
  // a mount with the door's lifecycle trio but no update caller still renders
  // an interactive door — just without the Chat toggle (graceful degrade). The
  // Chat row only appears on an open door, so it also implies `canManageMcpDoor`.
  const canEditMcpChat =
    canManageMcpDoor && opts.runUpdateInboundToken !== undefined;
  // D-171 slice 2c — the per-tool grant checklist needs BOTH the catalog
  // caller (to list grantable tools) AND the update caller (to write the
  // grants). Gates independently of the Chat row; when either is absent the
  // open door drops the checklist but keeps the rest (graceful degrade).
  const canEditMcpGrants =
    canManageMcpDoor
    && opts.runListToolCatalog !== undefined
    && opts.runUpdateInboundToken !== undefined;
  // D-171 slice 3b — the Advanced sub-panel (lazy cap/expiry) needs all FOUR
  // contract callers: mint (create the limit envelope), update_contract (rebind
  // the live token to it / unbind), list (resolve the bound contract's values —
  // the token carries only the opaque id), and revoke (retire a prior limit).
  // Gates independently of the grant checklist; when any is absent the open door
  // drops the Advanced sub-panel but keeps the rest (graceful degrade).
  const canEditMcpAdvanced =
    canManageMcpDoor
    && opts.runMintContract !== undefined
    && opts.runRevokeContract !== undefined
    && opts.runListContracts !== undefined
    && opts.runUpdateInboundContract !== undefined;
  const nowFn = opts.now ?? Date.now;
  // Bumped before every `runListOverrides` await; the post-await write only
  // lands when its captured generation is still current. A delete ALSO bumps
  // it so a slow list started before the delete drops its now-stale write
  // instead of clobbering the post-delete re-list.
  let loadGeneration = 0;
  let pendingLoad: Promise<void> = Promise.resolve();
  // The on-mount catalog load (B2). Resolves once the picker source settles.
  let pendingCatalog: Promise<void> = Promise.resolve();
  // D-171 slice 2 — bumped before every inbound-token list / mutation; a
  // post-await write only lands when its captured generation is still current
  // (mirrors `loadGeneration` for overrides). The on-mount token load resolves
  // `pendingTokenLoad` for the `whenTokensLoaded` test seam.
  let tokenGeneration = 0;
  let pendingTokenLoad: Promise<void> = Promise.resolve();
  // D-171 slice 2c — the on-mount tool-catalog load (the grant checklist's
  // source). Loaded once (the catalog is re-read per-render against the live
  // token snapshot); `whenToolCatalogLoaded` resolves it for the test seam.
  let pendingToolCatalogLoad: Promise<void> = Promise.resolve();
  // D-171 slice 3b — the contracts load (the Advanced sub-panel's bound-contract
  // source). Re-listed on mount + after each cap/expiry mutation; the generation
  // guard drops a stale in-flight list when a mutation's re-list overtakes it.
  // `whenAdvancedLoaded` resolves `pendingContractLoad` for the test seam.
  let contractGeneration = 0;
  let pendingContractLoad: Promise<void> = Promise.resolve();
  // D-171 slice 3b — the bound-contract key the Advanced draft was last seeded
  // from (`<<unbound>>` when no limit is bound). Re-seeding fires only when the
  // server's bound contract IDENTITY changes (first load, or a new id after a
  // save) — so a re-list never clobbers a mid-edit draft, and a save's new
  // contract re-seeds the draft to reflect it. Reset on door-disable.
  let seededAdvancedKey: string | null = null;
  // D-171 slice-2c follow-on #2 — true while the LATEST `doRefreshContracts` is in
  // flight. Distinguishes a TRANSIENT bound-but-unresolved contract (a peer just
  // bound a limit; its re-list hasn't landed) from a GENUINE one (hard delete /
  // sync gap, list already settled without it). The Advanced editor locks during
  // the transient window (a save then would act on the pre-bind draft + could
  // clobber the peer's limit), and re-enables once settled so a genuine orphan
  // stays clearable ("turn the limits off").
  let contractsLoading = false;
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
      prompt.textContent = 'Remove override?';
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
        `Could not delete: ${rowError}`,
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

  /** D-171 slice 1 — the doors frame: the panel's top-level organizing
   *  structure. Each externally-reachable channel renders as a labelled,
   *  described row, followed by a heading that frames the existing override
   *  editor as the per-tool layer applying WITHIN a door. Slice 1 is
   *  informational (no per-door controls yet — the mcp token sub-panel +
   *  enable toggles land in later slices); it establishes "doors → per-tool
   *  grants" as the panel's shape. Rebuilt on each `render()` — static + cheap. */
  const renderDoors = (): void => {
    const section = doc.createElement('div');
    section.setAttribute(PERMISSIONS_DOORS_SECTION_ATTR, '');
    section.className = 'perm-doors';

    const heading = doc.createElement('div');
    heading.className = 'perm-doors-heading';
    heading.textContent =
      surface === 'contracts-detail' ? 'Contract credential' : 'Doors';
    section.appendChild(heading);

    const intro = doc.createElement('div');
    intro.className = 'perm-doors-intro';
    intro.textContent =
      surface === 'contracts-detail'
        ? 'URL, one-time token, tool grants, chat access, and optional limits for the MCP door.'
        : 'The ways other people and agents reach Recued. Open a door and grant '
          + 'only the tools you want available through it.';
    section.appendChild(intro);

    const doors =
      surface === 'contracts-detail'
        ? PERMISSION_DOORS.filter((door) => door.channel === 'mcp')
        : PERMISSION_DOORS;
    for (const door of doors) {
      const row = doc.createElement('div');
      row.setAttribute(PERMISSIONS_DOOR_ROW_ATTR, '');
      row.setAttribute('data-channel', door.channel);
      row.className = 'perm-door';

      const label = doc.createElement('div');
      label.className = 'perm-door-label';
      label.textContent = door.label;
      row.appendChild(label);

      const desc = doc.createElement('div');
      desc.className = 'perm-door-desc';
      desc.textContent = door.description;
      row.appendChild(desc);

      // D-171 slice 2 — the mcp door is the only door that derives a token:
      // enable → issue (reveal/copy), disable → revoke. When its callers are
      // unwired it falls through to the slice-1 bare row (the `&& canManageMcpDoor`
      // guard). D-171 slice 4 — `reception` / `messenger` get a static
      // informational block (no token; decision 8) explaining where they are
      // actually configured. It needs no callers, so it always renders.
      if (door.channel === 'mcp' && canManageMcpDoor) {
        renderMcpDoorControls(row);
      } else if (door.channel === 'reception' || door.channel === 'messenger') {
        renderDoorInfo(row, door.channel);
      }

      section.appendChild(row);
    }
    root.appendChild(section);

    if (canManageOverrides) {
      // The override editor below is the per-tool layer that applies WITHIN a
      // door — frame it as such beneath the doors.
      const overridesHeading = doc.createElement('div');
      overridesHeading.setAttribute(PERMISSIONS_OVERRIDES_HEADING_ATTR, '');
      overridesHeading.className = 'perm-overrides-heading';
      overridesHeading.textContent =
        surface === 'contracts-detail'
          ? 'Additional restrictions'
          : 'Per-tool restrictions';
      root.appendChild(overridesHeading);
    }
  };

  // ── D-171 slice 2: mcp door (inbound-token lifecycle) ──────────────

  /** List the inbound tokens so the mcp door can derive its open/closed
   *  state. A list failure surfaces on the door's error chip + keeps any
   *  prior token snapshot (so a transient re-list error doesn't flip the
   *  door's rendered state). Generation-guarded like `doRefresh`. */
  const doRefreshTokens = (): Promise<void> => {
    const list = opts.runListInboundTokens;
    if (list === undefined) return Promise.resolve();
    const gen = ++tokenGeneration;
    pendingTokenLoad = (async () => {
      try {
        const { tokens } = await list();
        if (disposed || gen !== tokenGeneration) return; // stale / torn down
        // D-171 slice-2c follow-on #2 — detect a change of the ACTIVE door token's
        // IDENTITY. A remote revoke + re-open swaps in a fresh `token_id`; a remote
        // open / close adds / drops the active token. Token-scoped transient UI
        // state must not ride across that swap onto the new token. Same-token
        // re-lists — every local mutation's optimistic-fold + reconcile keeps the
        // identity — leave it untouched, so a mid-edit draft / armed confirm on the
        // user's OWN token is never clobbered.
        const priorActiveId =
          state.inboundTokens === null
            ? null
            : (activeDoorToken(state.inboundTokens, nowFn())?.token_id ?? null);
        const nextActiveId = activeDoorToken(tokens, nowFn())?.token_id ?? null;
        state = { ...state, inboundTokens: tokens, doorError: null };
        if (priorActiveId !== nextActiveId) {
          // Drop state scoped to the prior token: an armed disable-confirm (would
          // revoke the FRESH token without re-arming), a stale advanced error, and
          // the one-time bearer when it isn't the new token's (the reveal render
          // already gates on a token_id match — this is memory hygiene). Force the
          // Advanced draft to re-seed for the new token (`seededAdvancedKey = null`)
          // so a prior mid-edit draft can't be saved onto the fresh token.
          seededAdvancedKey = null;
          state = {
            ...state,
            confirmingDisableMcp: false,
            advancedError: null,
            ...(state.doorTokenPlaintextTokenId !== nextActiveId
              ? { doorTokenPlaintext: null, doorTokenPlaintextTokenId: null }
              : {}),
          };
        }
        // D-171 slice 3b — seed the Advanced draft once both the token list AND
        // the contracts have loaded. The two loads race on mount; seeding from
        // BOTH settle paths (here + `doRefreshContracts`) means whichever lands
        // last fires the (idempotent) seed — without this a contracts-first load
        // would leave a bound door's draft at "both off", so "Save limits" would
        // misread as a clear + revoke the live limit.
        if (canEditMcpAdvanced) seedAdvancedDraftIfNeeded();
        render();
      } catch (err) {
        if (disposed || gen !== tokenGeneration) return;
        state = { ...state, doorError: errMessage(err) };
        render();
      }
    })();
    return pendingTokenLoad;
  };

  /** D-171 slice 2c — load the live self tool catalog backing the grant
   *  checklist. Loaded once on mount; a failure degrades only the checklist
   *  (the door lifecycle + token reveal + Chat row stay live) by surfacing an
   *  inline "Tools unavailable" line. Guarded on `disposed` like the override
   *  `loadCatalog` (the catalog isn't re-fetched per mutation, so no
   *  generation race to track). */
  const doRefreshToolCatalog = (): Promise<void> => {
    const list = opts.runListToolCatalog;
    if (list === undefined) return Promise.resolve();
    pendingToolCatalogLoad = (async () => {
      try {
        const { catalog } = await list();
        if (disposed) return;
        state = { ...state, toolCatalog: catalog, toolCatalogError: null };
        render();
      } catch (err) {
        if (disposed) return;
        state = { ...state, toolCatalog: [], toolCatalogError: errMessage(err) };
        render();
      }
    })();
    return pendingToolCatalogLoad;
  };

  /** D-171 slice 3b — list the minted contracts so the Advanced sub-panel can
   *  resolve the open token's bound contract (the token carries only the opaque
   *  `contract_id`). Re-listed on mount + after each cap/expiry mutation. A
   *  failure degrades only the Advanced sub-panel (an inline "Limits unavailable"
   *  line). Generation-guarded like `doRefreshTokens`; on settle it re-seeds the
   *  draft (idempotent unless the bound contract's identity changed). */
  const doRefreshContracts = (): Promise<void> => {
    const list = opts.runListContracts;
    if (list === undefined) return Promise.resolve();
    const gen = ++contractGeneration;
    contractsLoading = true;
    pendingContractLoad = (async () => {
      try {
        const { contracts } = await list();
        if (disposed || gen !== contractGeneration) return; // stale / torn down
        contractsLoading = false;
        state = { ...state, contractDefs: contracts, contractDefsError: null };
        seedAdvancedDraftIfNeeded();
        render();
      } catch (err) {
        if (disposed || gen !== contractGeneration) return;
        contractsLoading = false;
        state = { ...state, contractDefs: [], contractDefsError: errMessage(err) };
        render();
      }
    })();
    return pendingContractLoad;
  };

  /** D-171 slice 3b — the `contract_definition` the open door's token is bound
   *  to, resolved out of the listed set by the token's `contract_id`. Null when
   *  the door is closed, the token is unbound, the contracts haven't loaded, or
   *  the bound id isn't in the listed set. Pure over current state. */
  const boundContract = (): ContractDefinitionView | null => {
    if (state.inboundTokens === null || state.contractDefs === null) return null;
    const token = activeDoorToken(state.inboundTokens, nowFn());
    const id = token?.contract_id;
    if (id === undefined) return null;
    return state.contractDefs.find((c) => c.contract_id === id) ?? null;
  };

  /** D-171 slice 3b — project a bound contract's values into an Advanced draft.
   *  A null view (unbound) → both limits off. The lifecycle state is NOT
   *  consulted here — a dead (expired / exhausted) bound contract still seeds its
   *  values so the user sees them; the summary renders the lifecycle pill. */
  const draftFromContract = (view: ContractDefinitionView | null): AdvancedDraft => {
    if (view === null) return EMPTY_ADVANCED_DRAFT;
    const hasCap = view.max_uses !== undefined && view.max_uses !== null;
    const hasExpiry = view.expiry_at !== undefined && view.expiry_at !== null;
    return {
      capEnabled: hasCap,
      maxUses: hasCap ? String(view.max_uses) : '',
      expiryEnabled: hasExpiry,
      expiry: hasExpiry ? toDateInputValue(view.expiry_at as number) : '',
    };
  };

  /** D-171 slice 3b — seed the Advanced draft from the bound contract, but only
   *  when the server's bound contract IDENTITY has changed since the last seed
   *  (first load, or a new id after a save). This keeps a mid-edit draft from
   *  being clobbered by a reconciling re-list while still reflecting a saved
   *  limit. No-op until both the token list + contracts have loaded. */
  const seedAdvancedDraftIfNeeded = (): void => {
    if (state.inboundTokens === null || state.contractDefs === null) return;
    const token = activeDoorToken(state.inboundTokens, nowFn());
    if (token === null) return; // Advanced only seeds on an open door.
    const key = token.contract_id ?? '<<unbound>>';
    if (key === seededAdvancedKey) return;
    const bound = boundContract();
    // D-171 slice-2c follow-on #2 — defer when the token is bound to a contract
    // NOT in the currently-loaded list: the contract list is stale relative to the
    // token (e.g. a remote bind whose contract re-list hasn't landed yet — the
    // token + contract lists refresh independently off the broadcast and can land
    // in either order). Seeding now would project an empty draft AND latch
    // `seededAdvancedKey` to this id, so the seed from the later contract re-list
    // would no-op — leaving the Advanced controls reading "limits off" even though
    // a cap/expiry exists (a save from there could clear the remote limit). The
    // seed re-fires from whichever settle path runs once the bound contract
    // resolves, so refresh order no longer matters. (A GENUINELY unresolvable bound
    // contract — a hard delete — simply never seeds; the summary still renders its
    // "blocked / unresolved" state independently of the draft.)
    if (token.contract_id !== undefined && bound === null) return;
    seededAdvancedKey = key;
    state = { ...state, advancedDraft: draftFromContract(bound) };
  };

  /** Open the mcp door — issue the derived token. Holds the one-time bearer
   *  plaintext in memory for reveal/copy + optimistically flips the door to
   *  open, then reconciles via a re-list. A failure surfaces on the door's
   *  error chip. */
  const enableMcpDoor = async (): Promise<void> => {
    const issue = opts.runIssueInboundToken;
    // Gate on the FULL three-caller set (matches the render gate), not just
    // `issue` — a partial mount must never mint a door token it can't then
    // list or revoke. The `issue === undefined` check also narrows the type.
    if (!canManageMcpDoor || issue === undefined || disposed || state.doorBusy) {
      return;
    }
    // Idempotent open: the door owns exactly ONE token (decisions 2/3). If it
    // already reads open (an active door-labelled token exists), don't mint a
    // second — the render path hides Enable while open, and this guards the
    // programmatic handle too.
    if (
      state.inboundTokens !== null
      && activeDoorToken(state.inboundTokens, nowFn()) !== null
    ) {
      return;
    }
    // Invalidate any in-flight list so its (pre-issue) snapshot can't clobber
    // the post-issue state when it lands after us.
    tokenGeneration += 1;
    state = {
      ...state,
      doorBusy: true,
      doorError: null,
      confirmingDisableMcp: false,
    };
    render();
    try {
      const issued = await issue(buildMcpDoorIssueArgs());
      if (disposed) return;
      state = {
        ...state,
        doorBusy: false,
        doorTokenPlaintext: issued.bearer_plaintext,
        doorTokenPlaintextTokenId: issued.record.token_id,
        // Optimistically include the new record so the door reads open even
        // before the reconciling re-list lands.
        inboundTokens: [issued.record, ...(state.inboundTokens ?? [])],
      };
      // Paint the one-time bearer immediately — the reconciling re-list below
      // may be slow, and the plaintext is surfaced only once (never re-fetched);
      // it must not wait on the list to become visible / copyable.
      render();
      await doRefreshTokens();
    } catch (err) {
      if (disposed) return;
      state = { ...state, doorBusy: false, doorError: errMessage(err) };
    } finally {
      if (!disposed) render();
    }
  };

  /** Disable the mcp door — revoke its token(s). Revokes EVERY active
   *  door-labelled token (normally one) so the door is a true kill-switch,
   *  clears the held plaintext, and reconciles via a re-list. A failure
   *  surfaces on the door's error chip. */
  const disableMcpDoor = async (): Promise<void> => {
    const revoke = opts.runRevokeInboundToken;
    // Gate on the full three-caller set (matches the render gate); the
    // `revoke === undefined` check also narrows the type.
    if (!canManageMcpDoor || revoke === undefined || disposed || state.doorBusy) {
      return;
    }
    const now = nowFn();
    const targets = (state.inboundTokens ?? []).filter(
      (t) => t.label === MCP_DOOR_TOKEN_LABEL && isMcpInboundTokenActive(t, now),
    );
    if (targets.length === 0) {
      // Nothing to revoke — just disarm the confirm.
      state = { ...state, confirmingDisableMcp: false };
      render();
      return;
    }
    // D-171 slice 3b — capture the bound limit contracts BEFORE revoking the
    // tokens. The spec's disable path is "revoke the token + any bound contract"
    // (the full kill-switch), so a door with a cap/expiry must not leave an
    // orphaned active "MCP door limits" contract behind in the inspector.
    const boundContractIds = targets
      .map((t) => t.contract_id)
      .filter((id): id is string => id !== undefined);
    tokenGeneration += 1;
    state = {
      ...state,
      doorBusy: true,
      doorError: null,
      confirmingDisableMcp: false,
    };
    render();
    try {
      const revokedRecords: McpInboundTokenRecord[] = [];
      for (const t of targets) {
        if (disposed) return; // stop firing revokes once torn down (per-await)
        const { token } = await revoke({ token_id: t.token_id });
        revokedRecords.push(token);
      }
      // D-171 slice 3b — complete the kill-switch: revoke each bound limit
      // contract too (best-effort, only when the contract caller is wired). The
      // token is already dead, so a contract-revoke failure must NOT abort the
      // door-disable success — swallow it (the re-list reconciles the inspector).
      const revokeContract = opts.runRevokeContract;
      if (revokeContract !== undefined) {
        for (const contractId of boundContractIds) {
          if (disposed) return;
          try {
            await revokeContract({ contract_id: contractId });
          } catch {
            // best-effort; the bound token is already revoked (kill-switch done)
          }
        }
      }
      if (disposed) return;
      // Optimistically fold the server's post-revoke records into the snapshot
      // so a successful kill-switch reads CLOSED even if the reconciling
      // re-list below fails or is superseded — a revoked door must never render
      // as still-open on this security surface. The plaintext belonged to the
      // now-revoked token; drop it.
      const revokedById = new Map(
        revokedRecords.map((r) => [r.token_id, r] as const),
      );
      // A disabled door re-derives from a fresh token on re-open, so drop any
      // seeded Advanced draft + error; the next open seeds empty (no bound
      // contract). `seededAdvancedKey` reset so the re-open re-seeds.
      seededAdvancedKey = null;
      state = {
        ...state,
        doorBusy: false,
        doorTokenPlaintext: null,
        doorTokenPlaintextTokenId: null,
        advancedDraft: EMPTY_ADVANCED_DRAFT,
        advancedError: null,
        inboundTokens: (state.inboundTokens ?? []).map(
          (t) => revokedById.get(t.token_id) ?? t,
        ),
      };
      await doRefreshTokens();
      // Reconcile this panel's contract view after revoking the bound limit(s).
      if (canEditMcpAdvanced) await doRefreshContracts();
    } catch (err) {
      if (disposed) return;
      state = { ...state, doorBusy: false, doorError: errMessage(err) };
    } finally {
      if (!disposed) render();
    }
  };

  /** D-171 slice 2b — toggle the Chat row (the open door's `chat_mode`). Edits
   *  the LIVE token in place via `update_grants` — the token value is unchanged,
   *  so connected clients keep working (decision 6). Sends `chat_mode` ONLY (NOT
   *  grants), so a stale grants snapshot can't silently roll back a concurrent
   *  per-tool edit — the server preserves grants on absence. `offered: true` →
   *  `{ offered: true }` (preserving any existing session_cap); `offered: false`
   *  → `null` (clears chat-mode). Optimistically folds the returned record then
   *  reconciles via a re-list, mirroring enable/disable. */
  const setMcpDoorChat = async (offered: boolean): Promise<void> => {
    const update = opts.runUpdateInboundToken;
    if (!canEditMcpChat || update === undefined || disposed || state.doorBusy) {
      return;
    }
    if (state.inboundTokens === null) return;
    const token = activeDoorToken(state.inboundTokens, nowFn());
    if (token === null) return; // The Chat row only acts on an open door.
    // Idempotent: no rpc when the token is already in the requested state.
    const current = token.chat_mode !== null && token.chat_mode.offered;
    if (current === offered) return;
    // OFF → clear chat-mode (`null`). ON → `{ offered: true }`, preserving any
    // existing session_cap (a slice-3 Advanced concern the Chat row leaves be).
    let nextChatMode: McpInboundTokenChatMode = null;
    if (offered) {
      const cap = token.chat_mode?.session_cap;
      nextChatMode =
        cap !== undefined ? { offered: true, session_cap: cap } : { offered: true };
    }
    tokenGeneration += 1;
    state = { ...state, doorBusy: true, doorError: null };
    render();
    try {
      const { token: updated } = await update({
        token_id: token.token_id,
        chat_mode: nextChatMode,
      });
      if (disposed) return;
      // Optimistically fold the server's post-update record so the Chat state
      // reads correct even before the reconciling re-list lands. The plaintext
      // (if held) belongs to the SAME token — the value is unchanged, keep it.
      state = {
        ...state,
        doorBusy: false,
        inboundTokens: (state.inboundTokens ?? []).map(
          (t) => (t.token_id === updated.token_id ? updated : t),
        ),
      };
      render();
      await doRefreshTokens();
    } catch (err) {
      if (disposed) return;
      state = { ...state, doorBusy: false, doorError: errMessage(err) };
    } finally {
      if (!disposed) render();
    }
  };

  /** D-171 slice 2c — commit a new per-tool grants map onto the open door's
   *  live token via `update_grants`, sending `grants` ONLY (NOT chat_mode) so
   *  the server preserves chat-mode on absence — a grant edit can never roll
   *  back the Chat toggle. The token value is unchanged (decision 6), so
   *  connected clients keep working. Optimistically folds the returned record
   *  then reconciles via a re-list, mirroring `setMcpDoorChat`. The callers
   *  (`setMcpDoorToolGrant` / `setMcpDoorKindGrant`) project the next map.
   *
   *  Concurrency: WITHIN this panel every door mutation serializes through
   *  `doorBusy` (a grant edit in flight disables every toggle), and each edit
   *  optimistically folds the server record + re-lists — so single-client edits
   *  are race-free + always reflect the latest grants. ACROSS clients (a second
   *  tab / device editing the SAME door concurrently) the whole-map replace is
   *  last-writer-wins: a stale snapshot could drop or resurrect another client's
   *  grant in the ~1s edit window. That multi-client staleness is narrowed by the
   *  slice-2c follow-on #2 `subscribe` seam: when `opts.subscribe` is wired the
   *  panel re-lists on the `chat.inbound_token_changed` broadcast, so a peer's
   *  grant edit reconciles here within a broadcast round-trip — not only on the
   *  next reload. The window is not zero (a CAS on `updated_at` in `update_grants`
   *  would close the last sliver), but it is no longer reload-bound. */
  const commitMcpDoorGrants = async (
    nextGrants: Record<string, boolean>,
  ): Promise<void> => {
    const update = opts.runUpdateInboundToken;
    if (!canEditMcpGrants || update === undefined || disposed || state.doorBusy) {
      return;
    }
    if (state.inboundTokens === null) return;
    const token = activeDoorToken(state.inboundTokens, nowFn());
    if (token === null) return; // grants only act on an open door
    tokenGeneration += 1;
    state = { ...state, doorBusy: true, doorError: null };
    render();
    try {
      const { token: updated } = await update({
        token_id: token.token_id,
        grants: nextGrants,
      });
      if (disposed) return;
      // Optimistically fold the server's post-update record so the checklist
      // reads correct before the reconciling re-list lands. The plaintext (if
      // held) belongs to the SAME token — the value is unchanged, keep it.
      state = {
        ...state,
        doorBusy: false,
        inboundTokens: (state.inboundTokens ?? []).map(
          (t) => (t.token_id === updated.token_id ? updated : t),
        ),
      };
      render();
      await doRefreshTokens();
    } catch (err) {
      if (disposed) return;
      state = { ...state, doorBusy: false, doorError: errMessage(err) };
    } finally {
      if (!disposed) render();
    }
  };

  /** D-171 slice 2c — grant / revoke ONE tool. Idempotent (no rpc when the
   *  tool is already in the requested state); projects the next grants map
   *  from the live token + commits it. */
  const setMcpDoorToolGrant = async (
    toolName: string,
    granted: boolean,
  ): Promise<void> => {
    if (!canEditMcpGrants || disposed || state.doorBusy) return;
    if (state.inboundTokens === null) return;
    const token = activeDoorToken(state.inboundTokens, nowFn());
    if (token === null) return;
    // Idempotent: a missing grant key resolves to false (spec default-off).
    if ((token.grants[toolName] === true) === granted) return;
    await commitMcpDoorGrants(
      projectToggledChatInboundTokenTool({
        current: token.grants,
        tool_name: toolName,
        next_granted: granted,
      }),
    );
  };

  /** D-171 slice 2c — grant / revoke every catalog tool of one kind (the
   *  per-kind master toggle). Tools outside the live catalog (stale grants on
   *  uninstalled recipes) are left untouched by the projection. */
  const setMcpDoorKindGrant = async (
    kind: ChatInboundTokenGroupKind,
    granted: boolean,
  ): Promise<void> => {
    if (!canEditMcpGrants || disposed || state.doorBusy) return;
    if (state.inboundTokens === null || state.toolCatalog === null) return;
    const token = activeDoorToken(state.inboundTokens, nowFn());
    if (token === null) return;
    await commitMcpDoorGrants(
      projectToggledChatInboundTokenKind({
        current: token.grants,
        catalog: state.toolCatalog,
        kind,
        next_granted: granted,
      }),
    );
  };

  /** D-171 slice 2c — the open door token's grant checklist groups, grouped
   *  by ingredient kind + diffed against the live grants. Empty when the door
   *  is closed, the catalog hasn't loaded, or the projection is pending. */
  const mcpGrantGroups = (): ReadonlyArray<ChatInboundTokenKindGroup> => {
    if (state.inboundTokens === null || state.toolCatalog === null) return [];
    const token = activeDoorToken(state.inboundTokens, nowFn());
    if (token === null) return [];
    const model = buildChatInboundTokenDetailModel({
      token,
      catalog: state.toolCatalog,
      now: nowFn(),
    });
    return model.kind === 'resolved' ? model.groups : [];
  };

  // ── D-171 slice 3b: Advanced (lazy cap/expiry contract) ────────────

  /** D-171 slice 3b — set one Advanced-draft field + re-render. Marks the draft
   *  dirty implicitly: `seededAdvancedKey` stays at the current bound id, so a
   *  re-list won't re-seed over the edit (re-seed fires only when the bound id
   *  changes — i.e. after a save). No-op when the Advanced sub-panel is disabled. */
  const updateAdvancedDraft = <K extends keyof AdvancedDraft>(
    field: K,
    value: AdvancedDraft[K],
  ): void => {
    if (!canEditMcpAdvanced || disposed) return;
    state = {
      ...state,
      advancedDraft: { ...state.advancedDraft, [field]: value },
      // A fresh edit clears a prior validation/rpc error.
      advancedError: null,
    };
    render();
  };

  /** D-171 slice 3b — the live (cap, expiry) tuple of the bound contract, but
   *  only when it is ACTIVE. A dead (revoked / expired / exhausted) bound
   *  contract reports `null` limits so re-saving the same values still re-mints
   *  (restores a live limit) rather than short-circuiting as "no change". */
  const liveLimitTuple = (): { maxUses: number | null; expiryAt: number | null } => {
    const view = boundContract();
    if (view === null || view.lifecycle_state !== 'active') {
      return { maxUses: null, expiryAt: null };
    }
    return {
      maxUses: view.max_uses ?? null,
      expiryAt: view.expiry_at ?? null,
    };
  };

  /** D-171 slice 3b — fold a post-rebind token record into the snapshot (the
   *  value is unchanged; only `contract_id` / `updated_at` move). Shared by the
   *  bind + unbind paths of `reconcileMcpDoorLimits`. */
  const foldUpdatedToken = (updated: McpInboundTokenRecord): void => {
    state = {
      ...state,
      inboundTokens: (state.inboundTokens ?? []).map(
        (t) => (t.token_id === updated.token_id ? updated : t),
      ),
    };
  };

  /** D-171 slice 3b — reconcile the door token's bound limit contract to the
   *  desired (cap, expiry) tuple — the crux lazy-mint orchestration (decision 5):
   *
   *  - **No desired limit + nothing bound** → no-op (the common path stays free
   *    of `ct_*` machinery).
   *  - **No desired limit + a bound contract** → unbind the live token
   *    (`update_contract(null)`) then revoke the prior contract.
   *  - **A desired limit** → mint a fresh `contract_definition` (scope
   *    `{ channels: ['mcp'] }` + the cap/expiry), rebind the LIVE token to it
   *    (`update_contract(newId)`), then revoke any prior contract.
   *
   *  The token value is unchanged throughout (rebind-in-place, decision 6), so
   *  connected clients keep working. Serialized through `doorBusy`; reconciles
   *  the token list + the contracts list afterwards (the re-list re-seeds the
   *  draft to the new bound id). A failure surfaces on the Advanced error chip. */
  const reconcileMcpDoorLimits = async (
    nextMaxUses: number | null,
    nextExpiryAt: number | null,
  ): Promise<void> => {
    const mint = opts.runMintContract;
    const rebind = opts.runUpdateInboundContract;
    const revoke = opts.runRevokeContract;
    if (
      !canEditMcpAdvanced
      || mint === undefined
      || rebind === undefined
      || revoke === undefined
      || disposed
      || state.doorBusy
    ) {
      return;
    }
    if (state.inboundTokens === null) return;
    const token = activeDoorToken(state.inboundTokens, nowFn());
    if (token === null) return; // Advanced only acts on an open door.
    const priorId = token.contract_id ?? null;
    // D-171 slice-2c follow-on #2 — refuse to reconcile against a TRANSIENTLY
    // unresolved binding (the token is bound to a contract whose re-list is still
    // in flight). The draft here is the PRE-bind one; saving it could clobber a
    // peer's just-set limit. The render locks the editor in this window too — this
    // is the belt-and-suspenders guard for the programmatic/handle path. A GENUINE
    // orphan (settled, not loading) still reconciles so the user can clear it.
    if (priorId !== null && boundContract() === null && contractsLoading) return;
    const wantLimit = nextMaxUses !== null || nextExpiryAt !== null;

    // Short-circuits: nothing bound + nothing wanted; or caps unchanged (a
    // dead bound contract reports null live limits, so clearing / re-saving
    // over it still proceeds).
    const live = liveLimitTuple();
    const capsUnchanged =
      nextMaxUses === live.maxUses && nextExpiryAt === live.expiryAt;
    if (!wantLimit && priorId === null) return;
    if (priorId !== null && capsUnchanged) {
      return;
    }

    contractGeneration += 1;
    tokenGeneration += 1;
    state = { ...state, doorBusy: true, advancedError: null, doorError: null };
    render();
    try {
      if (!wantLimit) {
        // Clear: unbind the live token first (so it is never bound to a
        // revoked contract), then revoke the prior envelope.
        const { token: updated } = await rebind({
          token_id: token.token_id,
          contract_id: null,
        });
        if (disposed) return;
        foldUpdatedToken(updated);
        if (priorId !== null) {
          await revoke({ contract_id: priorId });
        }
      } else {
        // Set / change: mint the new envelope, rebind the live token to it,
        // then retire any prior envelope.
        const minted = await mint({
          display_name: MCP_DOOR_CONTRACT_NAME,
          scope: MCP_DOOR_CONTRACT_SCOPE,
          ...(nextMaxUses !== null ? { max_uses: nextMaxUses } : {}),
          ...(nextExpiryAt !== null ? { expiry_at: nextExpiryAt } : {}),
        });
        if (disposed) return;
        try {
          const { token: updated } = await rebind({
            token_id: token.token_id,
            contract_id: minted.contract_id,
          });
          if (disposed) return;
          foldUpdatedToken(updated);
          // Optimistically fold the freshly-minted contract so the bound-contract
          // resolves before the reconciling re-list lands.
          state = {
            ...state,
            contractDefs: [
              minted,
              ...(state.contractDefs ?? []).filter(
                (c) => c.contract_id !== minted.contract_id,
              ),
            ],
          };
        } catch (bindErr) {
          // The mint succeeded but the REBIND failed (e.g. a server with D-166
          // `mintContract` but not the slice-3a `update_contract`). The token was
          // never limited, so best-effort revoke the just-minted orphan — else a
          // retry piles up active, unbound "MCP door limits" contracts. Swallow a
          // revoke failure (nothing references the orphan); surface the bind error.
          // NOTE: this wraps ONLY the rebind — a failure of the *prior*-revoke
          // below must NOT revoke the new (correctly-bound) contract.
          try {
            await revoke({ contract_id: minted.contract_id });
          } catch {
            // best-effort cleanup; the reconciling re-list reflects the truth
          }
          throw bindErr;
        }
        // Rebind succeeded; retire the prior envelope. A failure here leaves the
        // NEW limit live + the old one lingering (surfaced, reconciled by re-list).
        if (priorId !== null && priorId !== minted.contract_id) {
          await revoke({ contract_id: priorId });
        }
      }
      if (disposed) return;
      state = { ...state, doorBusy: false };
      render();
      await doRefreshTokens();
      await doRefreshContracts();
      // Cross-panel coherence (D-171): this re-lists THIS panel's contract view
      // optimistically; the Privacy → Contracts inspector is a separate mount with
      // its own list. Both now re-list off the authoritative
      // `contract.contract_definition_changed` bus event, emitted by every
      // `mintContract` / `revokeContract` — INCLUDING the trailing bare
      // `revoke(priorId)` below. So a SET / CHANGE / CLEAR reflects live and
      // consistent across panels with no stale window: this closes the slice-2c
      // follow-on #2 residual, where the old `chat.inbound_token_changed` proxy
      // fired at the `update_contract` rebind ABOVE but missed the trailing bare
      // contract revoke (which carries no token op).
    } catch (err) {
      if (disposed) return;
      state = { ...state, doorBusy: false, advancedError: errMessage(err) };
    } finally {
      if (!disposed) render();
    }
  };

  /** D-171 slice 3b — apply the current Advanced draft: parse the toggled
   *  cap/expiry into a desired tuple (validating each enabled field) then drive
   *  `reconcileMcpDoorLimits`. A validation failure surfaces on the Advanced
   *  error chip without an rpc. */
  const submitMcpDoorLimits = async (): Promise<void> => {
    if (!canEditMcpAdvanced || disposed || state.doorBusy) return;
    if (state.inboundTokens === null) return;
    if (activeDoorToken(state.inboundTokens, nowFn()) === null) return;
    // Don't reconcile before the contracts have loaded — the draft isn't seeded
    // from the bound contract yet, so a "clear" misread could revoke a live
    // limit. The UI hides Save while loading; this guards the programmatic path.
    if (state.contractDefs === null) return;
    const d = state.advancedDraft;
    let nextMaxUses: number | null = null;
    if (d.capEnabled) {
      const n = Number(d.maxUses);
      if (d.maxUses.trim() === '' || !Number.isInteger(n) || n < 1) {
        state = {
          ...state,
          advancedError:
            'Usage cap must be a whole number of 1 or more (or turn the cap off).',
        };
        render();
        return;
      }
      nextMaxUses = n;
    }
    let nextExpiryAt: number | null = null;
    if (d.expiryEnabled) {
      const ms = d.expiry.trim() === '' ? Number.NaN : Date.parse(d.expiry);
      if (Number.isNaN(ms)) {
        state = {
          ...state,
          advancedError: `Could not read the expiry date "${d.expiry}" (or turn expiry off).`,
        };
        render();
        return;
      }
      nextExpiryAt = ms;
    }
    await reconcileMcpDoorLimits(nextMaxUses, nextExpiryAt);
  };

  /** Best-effort clipboard copy of the one-time token. No-op when the
   *  clipboard API is unavailable (non-browser / fake DOM); the value stays
   *  visible for manual copy regardless. */
  const copyToClipboard = (text: string): void => {
    if (text === '') return;
    const nav = (
      globalThis as {
        navigator?: { clipboard?: { writeText?: (t: string) => Promise<void> } };
      }
    ).navigator;
    const clipboard = nav?.clipboard;
    if (typeof clipboard?.writeText !== 'function') return;
    try {
      // `writeText` rejects asynchronously (e.g. permission denied); swallow
      // that too so a clipboard failure never escapes as an unhandled
      // rejection. The value stays visible for manual copy regardless.
      void clipboard.writeText(text).catch(() => {});
    } catch {
      // best-effort; the value is shown for manual copy regardless
    }
  };

  /** Render the token reveal/copy sub-panel for an open door. When THIS
   *  session just issued the token, the one-time plaintext is shown with a
   *  Copy button; otherwise (loaded from a prior session / another device)
   *  the value was already surfaced once and is never re-fetched, so the
   *  panel references it by its non-secret `token_id` only. */
  const renderMcpTokenPanel = (
    parent: HTMLElement,
    token: McpInboundTokenRecord,
  ): void => {
    const panel = doc.createElement('div');
    panel.setAttribute(PERMISSIONS_MCP_DOOR_TOKEN_ATTR, '');
    panel.className = 'perm-door-token';

    // Reveal the one-time plaintext ONLY when it belongs to the active token. A
    // remote revoke + re-open swaps in a new token_id this session never saw the
    // secret of (surfaced live by the follow-on #2 broadcast); the bare-presence
    // check would otherwise paint the stale prior bearer over the new token.
    if (
      state.doorTokenPlaintext !== null
      && state.doorTokenPlaintextTokenId === token.token_id
    ) {
      const intro = doc.createElement('div');
      intro.className = 'perm-door-token-intro';
      intro.textContent =
        'Copy this token into your AI client now — it is shown only once.';
      panel.appendChild(intro);

      const value = doc.createElement('code');
      value.setAttribute(PERMISSIONS_MCP_DOOR_TOKEN_VALUE_ATTR, '');
      value.className = 'perm-door-token-value';
      value.textContent = state.doorTokenPlaintext;
      panel.appendChild(value);

      const copy = doc.createElement('button');
      copy.setAttribute(PERMISSIONS_MCP_DOOR_TOKEN_COPY_ATTR, '');
      copy.setAttribute('type', 'button');
      copy.className = 'perm-door-token-copy';
      copy.textContent = 'Copy';
      copy.addEventListener('click', () => {
        copyToClipboard(state.doorTokenPlaintext ?? '');
      });
      panel.appendChild(copy);
    } else {
      const note = doc.createElement('div');
      note.setAttribute(PERMISSIONS_MCP_DOOR_TOKEN_VALUE_ATTR, '');
      note.className = 'perm-door-token-note';
      note.textContent =
        `Active. The token value was shown once when the door was opened `
        + `(id ${token.token_id}). Re-open the door to issue a fresh one.`;
      panel.appendChild(note);
    }
    parent.appendChild(panel);
  };

  /** D-171 slice 2b — render the highlighted "Chat" tool row inside an open
   *  mcp door (decision 4: Chat is a tool in the door, backed by the token's
   *  `chat_mode`). A plain-language description + an on/off toggle that edits
   *  the live token's chat_mode in place (the token value is unchanged, so
   *  clients keep working). Only rendered when the update caller is wired
   *  (`canEditMcpChat`); the door's lifecycle is unaffected when it isn't. */
  const renderMcpChatRow = (
    parent: HTMLElement,
    token: McpInboundTokenRecord,
  ): void => {
    const offered = token.chat_mode !== null && token.chat_mode.offered;
    const chatRow = doc.createElement('div');
    chatRow.setAttribute(PERMISSIONS_MCP_DOOR_CHAT_ROW_ATTR, '');
    chatRow.className = 'perm-door-chat';

    const info = doc.createElement('div');
    info.className = 'perm-door-chat-info';
    const label = doc.createElement('div');
    label.className = 'perm-door-chat-label';
    label.textContent = 'Chat';
    info.appendChild(label);
    const desc = doc.createElement('div');
    desc.className = 'perm-door-chat-desc';
    desc.textContent =
      'Let this connection talk to your assistant, not just call individual '
      + 'tools.';
    info.appendChild(desc);
    chatRow.appendChild(info);

    const toggle = doc.createElement('button');
    toggle.setAttribute(PERMISSIONS_MCP_DOOR_CHAT_TOGGLE_ATTR, '');
    toggle.setAttribute('type', 'button');
    // Stable state hook for tests (independent of the On/Off label text).
    toggle.setAttribute('data-offered', offered ? 'true' : 'false');
    toggle.className = offered
      ? 'perm-door-chat-toggle perm-door-chat-toggle-on'
      : 'perm-door-chat-toggle';
    if (state.doorBusy) {
      toggle.setAttribute('disabled', '');
      toggle.textContent = 'Saving…';
    } else {
      toggle.textContent = offered ? 'On' : 'Off';
      toggle.addEventListener('click', () => {
        void setMcpDoorChat(!offered);
      });
    }
    chatRow.appendChild(toggle);

    parent.appendChild(chatRow);
  };

  /** D-171 slice 2c — render the per-tool grant checklist inside an open mcp
   *  door: the allow-list that lowers to the token's `grants` (the functional
   *  gate the inbound MCP dispatch enforces). Tools are grouped by ingredient
   *  kind; each group has a master toggle (grant / revoke the whole kind) and
   *  per-tool toggles. Every edit sends `grants` ONLY (chat-mode preserved).
   *  Rendered only when the catalog + update callers are wired
   *  (`canEditMcpGrants`); loading / error / empty states degrade inline
   *  without touching the rest of the door. */
  const renderMcpGrantChecklist = (
    parent: HTMLElement,
    token: McpInboundTokenRecord,
  ): void => {
    const section = doc.createElement('div');
    section.setAttribute(PERMISSIONS_MCP_DOOR_GRANTS_ATTR, '');
    section.className = 'perm-door-grants';

    const heading = doc.createElement('div');
    heading.className = 'perm-door-grants-heading';
    heading.textContent = 'Tools';
    section.appendChild(heading);

    const intro = doc.createElement('div');
    intro.className = 'perm-door-grants-intro';
    intro.textContent =
      'Choose which tools agents using this token may call. Nothing is '
      + 'allowed until you grant it.';
    section.appendChild(intro);

    if (state.toolCatalogError !== null) {
      appendLine(
        section,
        PERMISSIONS_MCP_DOOR_GRANTS_EMPTY_ATTR,
        'perm-door-grants-empty',
        `Tools unavailable: ${state.toolCatalogError}`,
      );
      parent.appendChild(section);
      return;
    }
    if (state.toolCatalog === null) {
      appendLine(
        section,
        PERMISSIONS_MCP_DOOR_GRANTS_EMPTY_ATTR,
        'perm-door-grants-empty',
        'Loading tools…',
      );
      parent.appendChild(section);
      return;
    }

    const model = buildChatInboundTokenDetailModel({
      token,
      catalog: state.toolCatalog,
      now: nowFn(),
    });
    const groups = model.kind === 'resolved' ? model.groups : [];
    if (groups.length === 0) {
      appendLine(
        section,
        PERMISSIONS_MCP_DOOR_GRANTS_EMPTY_ATTR,
        'perm-door-grants-empty',
        'No tools available to grant yet.',
      );
      parent.appendChild(section);
      return;
    }

    for (const group of groups) {
      section.appendChild(renderMcpGrantKindGroup(group));
    }
    parent.appendChild(section);
  };

  /** D-171 slice 2c — render one ingredient-kind group: a kind header with a
   *  master toggle (all / none / mixed) + the per-tool rows. */
  const renderMcpGrantKindGroup = (
    group: ChatInboundTokenKindGroup,
  ): HTMLElement => {
    const kindEl = doc.createElement('div');
    kindEl.setAttribute(PERMISSIONS_MCP_DOOR_GRANT_KIND_ATTR, '');
    kindEl.setAttribute('data-kind', group.kind);
    kindEl.setAttribute('data-master', group.master);
    kindEl.className = 'perm-door-grant-kind';

    const header = doc.createElement('div');
    header.className = 'perm-door-grant-kind-header';
    const label = doc.createElement('div');
    label.className = 'perm-door-grant-kind-label';
    label.textContent = CHAT_INBOUND_TOKEN_KIND_COPY[group.kind].label;
    header.appendChild(label);

    // Master toggle: when the kind is fully granted, the action turns it OFF;
    // otherwise (none / mixed) it turns the whole kind ON.
    const allOn = group.master === 'all';
    const master = doc.createElement('button');
    master.setAttribute(PERMISSIONS_MCP_DOOR_GRANT_KIND_TOGGLE_ATTR, '');
    master.setAttribute('type', 'button');
    master.setAttribute('data-kind', group.kind);
    master.setAttribute('data-master', group.master);
    master.className = 'perm-door-grant-kind-toggle';
    if (state.doorBusy) {
      master.setAttribute('disabled', '');
      master.textContent = 'Saving…';
    } else {
      master.textContent = allOn ? 'Turn all off' : 'Turn all on';
      master.addEventListener('click', () => {
        void setMcpDoorKindGrant(group.kind, !allOn);
      });
    }
    header.appendChild(master);
    kindEl.appendChild(header);

    for (const row of group.rows) {
      const rowEl = doc.createElement('div');
      rowEl.setAttribute(PERMISSIONS_MCP_DOOR_GRANT_TOOL_ATTR, '');
      rowEl.setAttribute('data-tool', row.tool_name);
      rowEl.className = 'perm-door-grant-tool';

      const info = doc.createElement('div');
      info.className = 'perm-door-grant-tool-info';
      const nameLine = doc.createElement('div');
      nameLine.className = 'perm-door-grant-tool-name';
      const name = doc.createElement('span');
      name.className = 'perm-door-grant-tool-id';
      name.textContent = row.tool_name;
      nameLine.appendChild(name);
      // Risk chip — `write` / `unknown` are the ones worth flagging; a `read`
      // chip is rendered too so the row's class is always legible.
      const chip = doc.createElement('span');
      chip.className = `perm-door-grant-tool-class perm-door-grant-tool-class-${row.classification}`;
      chip.textContent = row.classification;
      nameLine.appendChild(chip);
      info.appendChild(nameLine);
      if (row.description !== '') {
        const desc = doc.createElement('div');
        desc.className = 'perm-door-grant-tool-desc';
        desc.textContent = row.description;
        info.appendChild(desc);
      }
      // D-192 Slice 7 — disclose the container reads granting this raw op
      // transitively admits (the gateway auto-admits them with no separate grant).
      if (row.also_reads !== undefined && row.also_reads.length > 0) {
        const refs = [...new Set(row.also_reads.map((r) => r.ref))];
        const alsoReads = doc.createElement('div');
        alsoReads.setAttribute(PERMISSIONS_MCP_DOOR_GRANT_TOOL_ALSO_READS_ATTR, '');
        alsoReads.setAttribute('data-reads', refs.join(','));
        alsoReads.className = 'perm-door-grant-tool-also-reads';
        alsoReads.textContent = `also reads: ${refs.join(', ')}`;
        alsoReads.title =
          `Granting this also lets it read ${row.also_reads.map((r) => r.list_op).join(', ')} `
          + 'to resolve the target — no separate grant needed.';
        info.appendChild(alsoReads);
      }
      rowEl.appendChild(info);

      const toggle = doc.createElement('button');
      toggle.setAttribute(PERMISSIONS_MCP_DOOR_GRANT_TOOL_TOGGLE_ATTR, '');
      toggle.setAttribute('type', 'button');
      toggle.setAttribute('data-tool', row.tool_name);
      // Stable state hook for tests (independent of the On/Off label text).
      toggle.setAttribute('data-granted', row.granted ? 'true' : 'false');
      toggle.className = row.granted
        ? 'perm-door-grant-tool-toggle perm-door-grant-tool-toggle-on'
        : 'perm-door-grant-tool-toggle';
      if (state.doorBusy) {
        toggle.setAttribute('disabled', '');
        toggle.textContent = 'Saving…';
      } else {
        toggle.textContent = row.granted ? 'On' : 'Off';
        toggle.addEventListener('click', () => {
          void setMcpDoorToolGrant(row.tool_name, !row.granted);
        });
      }
      rowEl.appendChild(toggle);
      kindEl.appendChild(rowEl);
    }
    return kindEl;
  };

  /** D-171 slice 3b — render the Advanced sub-panel (lazy cap/expiry) inside an
   *  open mcp door: two default-off limits (a usage cap + an expiry) the user
   *  turns on to bind a scoped `contract_definition` to the live token without
   *  re-issuing it (decisions 5/6). Rendered only when all four contract callers
   *  are wired (`canEditMcpAdvanced`); a contracts-load failure degrades only
   *  this sub-panel. The current bound limit (if any) shows as a read-only
   *  summary with its lifecycle pill; the cap/expiry controls author the desired
   *  state, applied together via "Save limits". */
  const renderMcpAdvanced = (parent: HTMLElement): void => {
    const section = doc.createElement('div');
    section.setAttribute(PERMISSIONS_MCP_DOOR_ADVANCED_ATTR, '');
    section.className = 'perm-door-advanced';

    const heading = doc.createElement('div');
    heading.className = 'perm-door-advanced-heading';
    heading.textContent = 'Advanced';
    section.appendChild(heading);

    const intro = doc.createElement('div');
    intro.className = 'perm-door-advanced-intro';
    intro.textContent =
      'Optional limits. A usage cap auto-blocks the token after a number of '
      + 'tool calls; an expiry auto-closes the door at a date. Off means '
      + 'unlimited and never. Connected clients keep working when you change '
      + 'these — the token value is unchanged.';
    section.appendChild(intro);

    if (state.contractDefsError !== null) {
      appendLine(
        section,
        PERMISSIONS_MCP_DOOR_ADVANCED_SUMMARY_ATTR,
        'perm-door-advanced-summary',
        `Limits unavailable: ${state.contractDefsError}`,
      );
      parent.appendChild(section);
      return;
    }
    if (state.contractDefs === null) {
      appendLine(
        section,
        PERMISSIONS_MCP_DOOR_ADVANCED_SUMMARY_ATTR,
        'perm-door-advanced-summary',
        'Loading limits…',
      );
      parent.appendChild(section);
      return;
    }

    // Read-only summary of the currently bound limit (if any), with its
    // server-resolved lifecycle pill (an expired / exhausted limit reads as the
    // kill-switch having fired — the door is blocked until the user clears or
    // re-sets it).
    const bound = boundContract();
    // A token can carry a `contract_id` that `listContracts` does NOT return
    // (a hard-deleted contract / a list-sync gap). The backend fails CLOSED on
    // an unresolvable bound contract (the kill-switch denies every dispatch), so
    // such a door is BLOCKED — never render it as "unlimited". Distinguish a
    // truly-unbound token (no `contract_id`) from a bound-but-missing one.
    const activeToken =
      state.inboundTokens !== null
        ? activeDoorToken(state.inboundTokens, nowFn())
        : null;
    const boundButMissing = bound === null && activeToken?.contract_id !== undefined;
    const summary = doc.createElement('div');
    summary.setAttribute(PERMISSIONS_MCP_DOOR_ADVANCED_SUMMARY_ATTR, '');
    summary.className = 'perm-door-advanced-summary';
    // D-171 slice-2c follow-on #2 — a bound-but-missing contract WHILE a contract
    // re-list is in flight is TRANSIENT (a peer just bound a limit; its values
    // haven't landed). Lock the editor until it resolves: the rendered draft is the
    // PRE-bind one, so a save now could clobber the peer's fresh limit. Once the
    // re-list settles the editor re-renders — with the contract's values, or (a
    // genuine hard delete) the clearable "turn the limits off" affordance below.
    const transientUnresolved = boundButMissing && contractsLoading;
    if (bound !== null) {
      summary.setAttribute('data-state', bound.lifecycle_state);
      summary.textContent = boundContractSummary(bound);
    } else if (transientUnresolved) {
      summary.setAttribute('data-state', 'unresolved');
      summary.textContent =
        `A usage limit is bound (id ${activeToken!.contract_id}) — resolving its `
        + `details… The editor is locked until it loads.`;
    } else if (boundButMissing) {
      summary.setAttribute('data-state', 'unresolved');
      summary.textContent =
        `A usage limit is bound (id ${activeToken!.contract_id}) but its details `
        + `could not be loaded — the door may be blocked until it reloads. `
        + `Turn the limits off to clear it, or reload.`;
    } else {
      summary.textContent = 'No limits — unlimited use, never expires.';
    }
    section.appendChild(summary);

    if (transientUnresolved) {
      // Locked: render only the summary (no toggles / Save) until the contract
      // re-list lands and re-renders this panel.
      parent.appendChild(section);
      return;
    }

    const busy = state.doorBusy;

    // ── Usage cap ──
    section.appendChild(
      renderAdvancedLimitRow({
        label: 'Usage cap',
        description: 'Auto-block after a number of tool calls.',
        enabled: state.advancedDraft.capEnabled,
        toggleAttr: PERMISSIONS_MCP_DOOR_ADVANCED_CAP_TOGGLE_ATTR,
        onToggle: () =>
          updateAdvancedDraft('capEnabled', !state.advancedDraft.capEnabled),
        inputAttr: PERMISSIONS_MCP_DOOR_ADVANCED_CAP_INPUT_ATTR,
        inputType: 'number',
        inputPlaceholder: 'e.g. 100',
        inputValue: state.advancedDraft.maxUses,
        onInput: (v) => updateAdvancedDraft('maxUses', v),
        busy,
      }),
    );

    // ── Expiry ──
    section.appendChild(
      renderAdvancedLimitRow({
        label: 'Expiry',
        description: 'Auto-close the door at a date.',
        enabled: state.advancedDraft.expiryEnabled,
        toggleAttr: PERMISSIONS_MCP_DOOR_ADVANCED_EXPIRY_TOGGLE_ATTR,
        onToggle: () =>
          updateAdvancedDraft(
            'expiryEnabled',
            !state.advancedDraft.expiryEnabled,
          ),
        inputAttr: PERMISSIONS_MCP_DOOR_ADVANCED_EXPIRY_INPUT_ATTR,
        inputType: 'date',
        inputPlaceholder: '',
        inputValue: state.advancedDraft.expiry,
        onInput: (v) => updateAdvancedDraft('expiry', v),
        busy,
      }),
    );

    // Saving ANY limit change re-mints the bound contract, and a fresh mint
    // seeds `uses_remaining = max_uses` — so an edit (even an expiry-only one)
    // resets a partially-consumed cap back to full. The substrate has no
    // partial-uses mint / update-in-place, so the reset is unavoidable; surface
    // it honestly rather than silently refunding the budget. Shown only when a
    // cap is in play (it's the only limit a re-mint resets).
    if (state.advancedDraft.capEnabled) {
      appendLine(
        section,
        PERMISSIONS_MCP_DOOR_ADVANCED_NOTE_ATTR,
        'perm-door-advanced-note',
        'Saving any limit change starts a fresh usage count.',
      );
    }

    const save = doc.createElement('button');
    save.setAttribute(PERMISSIONS_MCP_DOOR_ADVANCED_SAVE_ATTR, '');
    save.setAttribute('type', 'button');
    save.className = 'perm-door-advanced-save';
    if (busy) {
      save.setAttribute('disabled', '');
      save.textContent = 'Saving…';
    } else {
      save.textContent = 'Save limits';
      save.addEventListener('click', () => {
        void submitMcpDoorLimits();
      });
    }
    section.appendChild(save);

    if (state.advancedError !== null) {
      appendLine(
        section,
        PERMISSIONS_MCP_DOOR_ADVANCED_ERROR_ATTR,
        'perm-door-advanced-error',
        state.advancedError,
      );
    }

    parent.appendChild(section);
  };

  /** D-171 slice 3b — render one Advanced limit row: a label + description, an
   *  on/off toggle, and (when on) its value input. Shared by the cap + expiry
   *  rows. All controls disable while a door mutation is in flight. */
  const renderAdvancedLimitRow = (args: {
    label: string;
    description: string;
    enabled: boolean;
    toggleAttr: string;
    onToggle: () => void;
    inputAttr: string;
    inputType: string;
    inputPlaceholder: string;
    inputValue: string;
    onInput: (value: string) => void;
    busy: boolean;
  }): HTMLElement => {
    const rowEl = doc.createElement('div');
    rowEl.className = 'perm-door-advanced-row';

    const head = doc.createElement('div');
    head.className = 'perm-door-advanced-row-head';
    const info = doc.createElement('div');
    info.className = 'perm-door-advanced-row-info';
    const label = doc.createElement('div');
    label.className = 'perm-door-advanced-row-label';
    label.textContent = args.label;
    info.appendChild(label);
    const desc = doc.createElement('div');
    desc.className = 'perm-door-advanced-row-desc';
    desc.textContent = args.description;
    info.appendChild(desc);
    head.appendChild(info);

    const toggle = doc.createElement('button');
    toggle.setAttribute(args.toggleAttr, '');
    toggle.setAttribute('type', 'button');
    // Stable state hook for tests (independent of the On/Off label text).
    toggle.setAttribute('data-enabled', args.enabled ? 'true' : 'false');
    toggle.className = args.enabled
      ? 'perm-door-advanced-toggle perm-door-advanced-toggle-on'
      : 'perm-door-advanced-toggle';
    if (args.busy) {
      toggle.setAttribute('disabled', '');
      toggle.textContent = args.enabled ? 'On' : 'Off';
    } else {
      toggle.textContent = args.enabled ? 'On' : 'Off';
      toggle.addEventListener('click', () => {
        args.onToggle();
      });
    }
    head.appendChild(toggle);
    rowEl.appendChild(head);

    // The value input only shows when the limit is enabled (off = no value).
    if (args.enabled) {
      const input = doc.createElement('input');
      input.setAttribute(args.inputAttr, '');
      input.setAttribute('type', args.inputType);
      if (args.inputPlaceholder !== '') {
        input.setAttribute('placeholder', args.inputPlaceholder);
      }
      input.className = 'perm-door-advanced-input';
      (input as unknown as { value: string }).value = args.inputValue;
      if (args.busy) {
        input.setAttribute('disabled', '');
      } else {
        // `change` (not `input`) so the re-render lands after the value is
        // COMMITTED (blur / Enter), not on every keystroke — typing a
        // multi-character cap like `100` would otherwise re-render + drop focus
        // after the first key (the same reason the override create-form uses
        // `change`). Tests drive the same path via `setAdvancedField`.
        input.addEventListener('change', () => {
          args.onInput((input as unknown as { value: string }).value);
        });
      }
      rowEl.appendChild(input);
    }

    return rowEl;
  };

  /** Render the mcp door's interactive control region (status + enable /
   *  disable + the token sub-panel) inside the `mcp` door row. Rebuilt on
   *  each render — derived purely from `state.inboundTokens`. */
  const renderMcpDoorControls = (row: HTMLElement): void => {
    const controls = doc.createElement('div');
    controls.setAttribute(PERMISSIONS_MCP_DOOR_CONTROLS_ATTR, '');
    controls.className = 'perm-door-controls';

    if (state.doorError !== null) {
      appendLine(
        controls,
        PERMISSIONS_MCP_DOOR_ERROR_ATTR,
        'perm-door-error',
        `MCP door: ${state.doorError}`,
      );
    }

    if (state.inboundTokens === null) {
      // First token list still in flight (no snapshot to derive state from).
      appendLine(
        controls,
        PERMISSIONS_MCP_DOOR_STATUS_ATTR,
        'perm-door-status',
        'Checking…',
      );
      row.appendChild(controls);
      return;
    }

    const open = activeDoorToken(state.inboundTokens, nowFn());

    const status = doc.createElement('div');
    status.setAttribute(PERMISSIONS_MCP_DOOR_STATUS_ATTR, '');
    status.className = 'perm-door-status';
    status.textContent = open !== null ? 'Open' : 'Closed';
    controls.appendChild(status);

    if (open === null) {
      const enable = doc.createElement('button');
      enable.setAttribute(PERMISSIONS_MCP_DOOR_ENABLE_ATTR, '');
      enable.setAttribute('type', 'button');
      enable.className = 'perm-door-enable';
      if (state.doorBusy) {
        enable.setAttribute('disabled', '');
        enable.textContent = 'Opening…';
      } else {
        enable.textContent = 'Open the MCP door';
        enable.addEventListener('click', () => {
          void enableMcpDoor();
        });
      }
      controls.appendChild(enable);
      row.appendChild(controls);
      return;
    }

    // Open → token reveal/copy + the Chat tool row + the guarded disable.
    renderMcpTokenPanel(controls, open);
    // D-171 slice 2b — the Chat row (a tool in the door). Rendered only when
    // the update caller is wired. A freshly-opened door grants nothing + chat
    // off until toggled (default-deny is the safe posture).
    if (canEditMcpChat) renderMcpChatRow(controls, open);
    // D-171 slice 2c — the per-tool grant checklist (the functional gate the
    // inbound MCP dispatch enforces). Rendered only when the catalog + update
    // callers are wired; sits beneath the Chat row.
    if (canEditMcpGrants) renderMcpGrantChecklist(controls, open);
    // D-171 slice 3b — the Advanced sub-panel (lazy cap/expiry). Rendered only
    // when all four contract callers are wired; sits beneath the grant checklist.
    if (canEditMcpAdvanced) renderMcpAdvanced(controls);

    if (state.confirmingDisableMcp) {
      // Two-stage guarded confirm (decision 6) — mirror the Devices
      // `pair.revoke` flow. The warning makes the consequence unmistakable.
      const confirmBox = doc.createElement('div');
      confirmBox.className = 'perm-door-confirm';
      const warn = doc.createElement('div');
      warn.className = 'perm-door-warn';
      warn.textContent =
        'This revokes the MCP token. Every client you gave it to will stop '
        + 'working immediately and will need a new token if you re-open the door.';
      confirmBox.appendChild(warn);
      const yes = doc.createElement('button');
      yes.setAttribute(PERMISSIONS_MCP_DOOR_DISABLE_CONFIRM_ATTR, '');
      yes.setAttribute('type', 'button');
      yes.className = 'perm-door-disable perm-door-confirm-yes';
      if (state.doorBusy) {
        yes.setAttribute('disabled', '');
        yes.textContent = 'Revoking…';
      } else {
        yes.textContent = 'Revoke token';
        yes.addEventListener('click', () => {
          void disableMcpDoor();
        });
      }
      confirmBox.appendChild(yes);
      const no = doc.createElement('button');
      no.setAttribute(PERMISSIONS_MCP_DOOR_DISABLE_CANCEL_ATTR, '');
      no.setAttribute('type', 'button');
      no.className = 'perm-door-cancel';
      no.textContent = 'Cancel';
      no.addEventListener('click', () => {
        state = { ...state, confirmingDisableMcp: false };
        render();
      });
      confirmBox.appendChild(no);
      controls.appendChild(confirmBox);
    } else {
      const disable = doc.createElement('button');
      disable.setAttribute(PERMISSIONS_MCP_DOOR_DISABLE_ATTR, '');
      disable.setAttribute('type', 'button');
      disable.className = 'perm-door-disable';
      if (state.doorBusy) {
        disable.setAttribute('disabled', '');
        disable.textContent = 'Working…';
      } else {
        disable.textContent = 'Disable the MCP door';
        disable.addEventListener('click', () => {
          state = { ...state, confirmingDisableMcp: true };
          render();
        });
      }
      controls.appendChild(disable);
    }
    row.appendChild(controls);
  };

  // ── D-171 slice 4: reception / messenger doors (static informational) ──

  /** D-171 slice 4 — the static informational control block for a non-mcp
   *  door. Unlike the `mcp` door these doors derive no token (decision 8) and
   *  have no per-tool grant model of their own, so the block is purely
   *  explanatory: what the door admits, where it is actually configured, and
   *  that the Per-tool restrictions below apply. Needs no callers → always
   *  rendered. Composed from standalone elements only (no text nodes) so the
   *  fake-DOM tests can walk it. */
  const renderDoorInfo = (
    row: HTMLElement,
    channel: 'reception' | 'messenger',
  ): void => {
    const controls = doc.createElement('div');
    controls.setAttribute(PERMISSIONS_DOOR_INFO_ATTR, '');
    controls.setAttribute('data-channel', channel);
    controls.className = 'perm-door-controls';

    const addInfo = (text: string): void => {
      const line = doc.createElement('div');
      line.className = 'perm-door-info';
      line.textContent = text;
      controls.appendChild(line);
    };

    if (channel === 'reception') {
      addInfo(
        'Open to the web through the public links you publish — each link is '
        + 'its own access boundary.',
      );
      // The Reception page is a sibling route; link to it via the established
      // `#reception` hash nav (mirrors the Settings route's back-link).
      const link = doc.createElement('a');
      link.className = 'perm-door-link';
      link.setAttribute('href', '#reception');
      link.textContent = 'Create and manage links on the Reception page →';
      controls.appendChild(link);
      // Don't claim the Per-tool restrictions below gate link traffic: a public
      // link runs as the `anonymous` actor, which the restriction picker
      // deliberately omits (ACTOR_OPTIONS). The real boundary for a visitor is
      // what each link is configured to do, set on the Reception page.
      addInfo(
        'Public-link visitors are limited by what each link is configured to '
        + 'do on the Reception page — not by the Per-tool restrictions below.',
      );
      addInfo(
        'No token to copy — access is granted per published link, not a shared '
        + 'credential.',
      );
    } else {
      addInfo(
        'Inbound messages from a connected messenger can trigger your recipes.',
      );
      for (const vendor of listMessengerVendors()) {
        const vrow = doc.createElement('div');
        vrow.setAttribute(PERMISSIONS_DOOR_VENDOR_ATTR, '');
        vrow.setAttribute('data-vendor', vendor);
        vrow.className = 'perm-door-vendor';
        const label = getMessengerVendorDeclaration(vendor)?.display_name ?? vendor;
        vrow.textContent = `${label} — configured in Connections`;
        controls.appendChild(vrow);
      }
      addInfo('Which recipes respond is set by each recipe’s trigger.');
      addInfo('Per-tool restrictions below also apply.');
      addInfo(
        'No token to copy — access comes from your connected messenger, not a '
        + 'shared credential.',
      );
    }

    row.appendChild(controls);
  };

  const render = (): void => {
    if (disposed) return;
    clearChildren(root);

    // D-171 — the doors frame is the panel's top-level organizing structure.
    renderDoors();

    // B2 — the create form (when enabled) sits above the inventory.
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
        `Could not load permissions: ${state.listError}`,
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
        'No permission overrides. Restrictions you place on what agents or contracts can do appear here.',
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
      setCreateError('Choose an actor to restrict.');
      return;
    }
    if (d.ingredient_id === '') {
      setCreateError('Choose an ingredient.');
      return;
    }
    const policy = buildPolicy(d);
    if (isEmptyOverridePolicy(policy as Readonly<Record<string, unknown>>)) {
      setCreateError(
        'Set at least one restriction (deny, approval, or max risk without approval).',
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
    heading.textContent = 'Add a restriction';
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
      [{ value: '', label: 'Select actor…' }, ...ACTOR_OPTIONS],
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
        ? `Catalog unavailable: ${state.catalogError}`
        : state.catalog === null
          ? 'Loading ingredients…'
          : catalog.length === 0
            ? 'No catalog ingredients installed'
            : 'Select ingredient…';
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
        { value: '', label: 'All operations (ingredient-wide)' },
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
    deniedSpan.textContent = 'Deny entirely';
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
      'Max risk without approval',
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
      save.textContent = 'Add override';
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

  // ── D-171 slice-2c follow-on #2 — live multi-client door coherence ──
  // Subscribe to the inbound-token broadcast so the mcp door re-syncs when ANY
  // client (this one included) mutates it. The token record changes on EVERY op
  // (issue / update_grants / update_contract / revoke / delete) — the door's
  // open/closed state, grants, Chat mode, and the bound `contract_id` all live on
  // it — so we always re-list the tokens. The bound contract's cap/expiry VALUES
  // change only when the binding changes: a cap/expiry mint/revoke is paired with
  // `update_contract`, and door-disable (`revoke` / `delete`) retires the bound
  // contract. So the contract re-list is gated to those ops — a pure grant/chat
  // edit leaves the contract untouched. The bound contract has no bus event of its
  // own (`contract.*` rides pair-sync), so the token's `update_contract` op is the
  // door's proxy signal.
  //
  // The token + contract re-lists run independently (no ordering dependency): the
  // token-load and contract-load settle paths both re-seed the Advanced draft, and
  // `seedAdvancedDraftIfNeeded` DEFERS whenever the token is bound to a contract
  // not yet in the loaded list — so a token re-list landing before its contract
  // re-list can't latch an empty draft (the seed re-fires once the contract
  // resolves, in whatever order the two lists land, incl. a token-only `update_grants`
  // racing an in-flight `update_contract` contract re-list). A self-originated edit
  // also echoes back — but the broadcast is emitted server-side AFTER the write
  // applies, so the echoed re-list reads the applied state (redundant on top of the
  // mutation's own trailing reconcile, never a clobber). Mirrors the packs panel's
  // subscribe/dispose discipline (unsubscribe in `dispose` first).
  const broadcastUnsubscribers: Array<() => void> = [];
  // Register only when the door is manageable — a panel that's just the override
  // editor (no inbound-token callers) has nothing for this kind to refresh, so a
  // no-op listener would be dead weight. `canEditMcpAdvanced` implies
  // `canManageMcpDoor`, so the contract refresh is reachable only here.
  if (opts.subscribe && canManageMcpDoor) {
    // Door/token state (open/closed + grants + chat + the bound `contract_id`)
    // all live on the token record — refresh it on every inbound-token frame.
    broadcastUnsubscribers.push(
      opts.subscribe('chat.inbound_token_changed', () => {
        if (disposed) return;
        void doRefreshTokens();
      }),
    );
    // D-171 — the Advanced sub-panel's bound-contract VALUES (cap / expiry /
    // lifecycle_state) live on the `contract_definition`, which now has its own
    // authoritative D-121 bus event. Refresh the contracts list off it directly
    // — dropping the old `chat.inbound_token_changed` proxy — so a peer's
    // mint/revoke AND this client's own trailing bare `revokeContract` of a prior
    // limit reflect live (the latter carried no token op, the slice-2c follow-on
    // #2 residual). Only when the Advanced sub-panel is wired (`canEditMcpAdvanced`);
    // a door without the contract callers has nothing to refresh.
    if (canEditMcpAdvanced) {
      broadcastUnsubscribers.push(
        opts.subscribe('contract.contract_definition_changed', () => {
          if (disposed) return;
          void doRefreshContracts();
        }),
      );
    }
  }

  // ── Initial paint + seed load ────────────────────────────────────
  render();
  void doRefresh();
  if (canCreate) void loadCatalog();
  if (canManageMcpDoor) void doRefreshTokens();
  if (canEditMcpGrants) void doRefreshToolCatalog();
  if (canEditMcpAdvanced) void doRefreshContracts();

  return {
    getState: () => state.phase,
    getOverrides: () => state.overrides,
    getListError: () => state.listError,
    refresh: () => doRefresh(),
    whenLoaded: () => pendingLoad,
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
    whenTokensLoaded: () => pendingTokenLoad,
    getMcpDoorOpen: () =>
      state.inboundTokens !== null
      && activeDoorToken(state.inboundTokens, nowFn()) !== null,
    getMcpDoorTokenPlaintext: () => state.doorTokenPlaintext,
    enableMcpDoor: () => enableMcpDoor(),
    disableMcpDoor: () => disableMcpDoor(),
    getMcpDoorChatOffered: () => {
      if (state.inboundTokens === null) return false;
      const token = activeDoorToken(state.inboundTokens, nowFn());
      return token !== null && token.chat_mode !== null && token.chat_mode.offered;
    },
    setMcpDoorChat: (offered) => setMcpDoorChat(offered),
    whenToolCatalogLoaded: () => pendingToolCatalogLoad,
    getMcpDoorGrantGroups: () => mcpGrantGroups(),
    setMcpDoorToolGrant: (toolName, granted) =>
      setMcpDoorToolGrant(toolName, granted),
    setMcpDoorKindGrant: (kind, granted) => setMcpDoorKindGrant(kind, granted),
    whenAdvancedLoaded: () => pendingContractLoad,
    getMcpDoorBoundContract: () => boundContract(),
    setAdvancedField: (field, value) => updateAdvancedDraft(field, value),
    submitMcpDoorLimits: () => submitMcpDoorLimits(),
    getAdvancedError: () => state.advancedError,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      // Drop broadcast subscriptions BEFORE detaching the root so an in-flight
      // listener can't try to render into a removed tree. Each unsubscribe is
      // wrapped — the subscriber owns its teardown, and a throw on its side must
      // not stop us disposing the rest (mirrors the packs panel).
      for (const unsub of broadcastUnsubscribers) {
        try {
          unsub();
        } catch {
          /* swallow per-handle teardown failures */
        }
      }
      broadcastUnsubscribers.length = 0;
      // Drop the one-time bearer plaintext (+ its token binding) from memory on
      // teardown.
      state = { ...state, doorTokenPlaintext: null, doorTokenPlaintextTokenId: null };
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

/** Self-scoped CSS for the Permissions section, scoped under
 *  `[data-recued-permissions-panel]` so the rules are inert when the section
 *  isn't mounted. The settings route joins this into its one `<style>` bundle
 *  (mirrors `CONNECTIONS_GRANT_PANEL_STYLES`). */
export const PERMISSIONS_PANEL_STYLES = `
[data-recued-permissions-panel] .perm-doors {
  margin: 0 0 16px;
}
[data-recued-permissions-panel] .perm-doors-heading {
  font-size: 14px;
  font-weight: 600;
  margin-bottom: 4px;
}
[data-recued-permissions-panel] .perm-doors-intro {
  font-size: 13px;
  color: var(--muted);
  margin-bottom: 10px;
}
[data-recued-permissions-panel] [${PERMISSIONS_DOOR_ROW_ATTR}] {
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 12px;
  margin: 6px 0;
}
[data-recued-permissions-panel] .perm-door-label {
  font-size: 13px;
  font-weight: 600;
  margin-bottom: 2px;
}
[data-recued-permissions-panel] .perm-door-desc {
  font-size: 12px;
  color: var(--muted);
}
[data-recued-permissions-panel] .perm-door-controls {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 10px;
}
[data-recued-permissions-panel] .perm-door-status {
  font-size: 12px;
  font-weight: 600;
  color: var(--muted);
}
[data-recued-permissions-panel] .perm-door-info {
  font-size: 12px;
  color: var(--muted);
}
[data-recued-permissions-panel] .perm-door-link {
  align-self: flex-start;
  font-size: 12px;
  color: var(--accent);
  text-decoration: none;
}
[data-recued-permissions-panel] .perm-door-link:hover {
  text-decoration: underline;
}
[data-recued-permissions-panel] .perm-door-vendor {
  font-size: 12px;
  color: var(--muted);
  padding-left: 12px;
}
[data-recued-permissions-panel] .perm-door-error {
  font-size: 13px;
  color: var(--fail);
}
[data-recued-permissions-panel] .perm-door-enable,
[data-recued-permissions-panel] .perm-door-disable,
[data-recued-permissions-panel] .perm-door-cancel,
[data-recued-permissions-panel] .perm-door-token-copy {
  align-self: flex-start;
  font-size: 13px;
  padding: 6px 14px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface);
  cursor: pointer;
  white-space: nowrap;
}
[data-recued-permissions-panel] .perm-door-disable {
  color: var(--fail);
}
[data-recued-permissions-panel] .perm-door-enable[disabled],
[data-recued-permissions-panel] .perm-door-disable[disabled] {
  opacity: 0.6;
  cursor: default;
}
[data-recued-permissions-panel] [${PERMISSIONS_MCP_DOOR_TOKEN_ATTR}] {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface-subtle);
}
[data-recued-permissions-panel] .perm-door-token-intro,
[data-recued-permissions-panel] .perm-door-token-note {
  font-size: 12px;
  color: var(--muted);
}
[data-recued-permissions-panel] .perm-door-token-value {
  font-family: var(--mono, ui-monospace, monospace);
  font-size: 12px;
  word-break: break-all;
  padding: 6px 8px;
  border-radius: 6px;
  background: var(--surface);
  border: 1px solid var(--border-subtle);
}
[data-recued-permissions-panel] .perm-door-chat {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px;
  border-radius: 6px;
  background: var(--surface);
  border: 1px solid var(--border-subtle);
}
[data-recued-permissions-panel] .perm-door-chat-info {
  flex: 1 1 auto;
}
[data-recued-permissions-panel] .perm-door-chat-label {
  font-size: 13px;
  font-weight: 600;
}
[data-recued-permissions-panel] .perm-door-chat-desc {
  font-size: 12px;
  color: var(--muted);
}
[data-recued-permissions-panel] .perm-door-chat-toggle-on {
  border-color: var(--accent);
  color: var(--accent);
}
[data-recued-permissions-panel] .perm-door-grants {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface-subtle);
}
[data-recued-permissions-panel] .perm-door-grants-heading {
  font-size: 13px;
  font-weight: 600;
}
[data-recued-permissions-panel] .perm-door-grants-intro,
[data-recued-permissions-panel] .perm-door-grants-empty {
  font-size: 12px;
  color: var(--muted);
}
[data-recued-permissions-panel] .perm-door-grant-kind {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px;
  border-radius: 6px;
  background: var(--surface);
  border: 1px solid var(--border-subtle);
}
[data-recued-permissions-panel] .perm-door-grant-kind-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
[data-recued-permissions-panel] .perm-door-grant-kind-label {
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  color: var(--muted);
}
[data-recued-permissions-panel] .perm-door-grant-kind-toggle,
[data-recued-permissions-panel] .perm-door-grant-tool-toggle {
  font-size: 12px;
  padding: 4px 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface);
  cursor: pointer;
  white-space: nowrap;
}
[data-recued-permissions-panel] .perm-door-grant-tool-toggle-on {
  border-color: var(--accent);
  color: var(--accent);
}
[data-recued-permissions-panel] .perm-door-grant-kind-toggle[disabled],
[data-recued-permissions-panel] .perm-door-grant-tool-toggle[disabled] {
  opacity: 0.6;
  cursor: default;
}
[data-recued-permissions-panel] .perm-door-grant-tool {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 0;
}
[data-recued-permissions-panel] .perm-door-grant-tool-info {
  flex: 1 1 auto;
  min-width: 0;
}
[data-recued-permissions-panel] .perm-door-grant-tool-name {
  display: flex;
  align-items: center;
  gap: 6px;
}
[data-recued-permissions-panel] .perm-door-grant-tool-id {
  font-family: var(--mono, ui-monospace, monospace);
  font-size: 12px;
  word-break: break-all;
}
[data-recued-permissions-panel] .perm-door-grant-tool-class {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  padding: 1px 6px;
  border-radius: 10px;
  background: var(--surface-subtle);
  color: var(--muted);
}
[data-recued-permissions-panel] .perm-door-grant-tool-class-write {
  color: var(--fail);
}
[data-recued-permissions-panel] .perm-door-grant-tool-desc {
  font-size: 11px;
  color: var(--muted);
}
[data-recued-permissions-panel] .perm-door-grant-tool-also-reads {
  font-size: 11px;
  color: var(--muted);
  margin-top: 2px;
}
[data-recued-permissions-panel] .perm-door-grant-tool-also-reads::before {
  content: '↳ ';
}
[data-recued-permissions-panel] .perm-door-advanced {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface-subtle);
}
[data-recued-permissions-panel] .perm-door-advanced-heading {
  font-size: 13px;
  font-weight: 600;
}
[data-recued-permissions-panel] .perm-door-advanced-intro,
[data-recued-permissions-panel] .perm-door-advanced-summary {
  font-size: 12px;
  color: var(--muted);
}
[data-recued-permissions-panel] [${PERMISSIONS_MCP_DOOR_ADVANCED_SUMMARY_ATTR}][data-state="expired"],
[data-recued-permissions-panel] [${PERMISSIONS_MCP_DOOR_ADVANCED_SUMMARY_ATTR}][data-state="exhausted"],
[data-recued-permissions-panel] [${PERMISSIONS_MCP_DOOR_ADVANCED_SUMMARY_ATTR}][data-state="revoked"],
[data-recued-permissions-panel] [${PERMISSIONS_MCP_DOOR_ADVANCED_SUMMARY_ATTR}][data-state="unresolved"] {
  color: var(--fail);
  font-weight: 600;
}
[data-recued-permissions-panel] .perm-door-advanced-row {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px;
  border-radius: 6px;
  background: var(--surface);
  border: 1px solid var(--border-subtle);
}
[data-recued-permissions-panel] .perm-door-advanced-row-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
[data-recued-permissions-panel] .perm-door-advanced-row-label {
  font-size: 13px;
  font-weight: 600;
}
[data-recued-permissions-panel] .perm-door-advanced-row-desc {
  font-size: 12px;
  color: var(--muted);
}
[data-recued-permissions-panel] .perm-door-advanced-toggle {
  font-size: 12px;
  padding: 4px 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface);
  cursor: pointer;
  white-space: nowrap;
}
[data-recued-permissions-panel] .perm-door-advanced-toggle-on {
  border-color: var(--accent);
  color: var(--accent);
}
[data-recued-permissions-panel] .perm-door-advanced-toggle[disabled],
[data-recued-permissions-panel] .perm-door-advanced-save[disabled] {
  opacity: 0.6;
  cursor: default;
}
[data-recued-permissions-panel] .perm-door-advanced-input {
  font-size: 13px;
  padding: 4px 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface);
  align-self: flex-start;
}
[data-recued-permissions-panel] .perm-door-advanced-save {
  align-self: flex-start;
  font-size: 13px;
  padding: 6px 14px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface);
  cursor: pointer;
}
[data-recued-permissions-panel] .perm-door-advanced-note {
  font-size: 12px;
  color: var(--muted);
  font-style: italic;
}
[data-recued-permissions-panel] .perm-door-advanced-error {
  font-size: 13px;
  color: var(--fail);
}
[data-recued-permissions-panel] .perm-door-confirm {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
[data-recued-permissions-panel] .perm-door-warn {
  flex-basis: 100%;
  font-size: 12px;
  color: var(--fail);
}
[data-recued-permissions-panel] .perm-door-confirm-yes {
  border-color: var(--fail);
}
[data-recued-permissions-panel] [${PERMISSIONS_OVERRIDES_HEADING_ATTR}] {
  font-size: 14px;
  font-weight: 600;
  margin: 8px 0 4px;
}
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
  flex-direction: row;
  align-items: center;
  gap: 6px;
}
[data-recued-permissions-panel] .perm-create-label {
  color: var(--muted);
}
[data-recued-permissions-panel] .perm-create-save {
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
