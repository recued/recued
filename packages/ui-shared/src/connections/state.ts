/** D-125 P7.1 — Settings → Connections page state shape.
 *
 *  The page holds three concerns at once: the enrolled-record list,
 *  the active enrollment / edit dialog (kind picker → subtype picker
 *  → form), and per-row probe / delete in-flight markers. The host
 *  passes a single state object into the pure renderer, which routes
 *  internally to list / kind-picker / subtype-picker / form views. */

import type { McpPackReviewView, McpPackStatusView } from './mcp-pack.js';
import type {
  BulkPackManifest,
  ConnectionAuthType,
  ConnectionCredentialCorrectionFieldKey,
  ConnectionCredentialRejectionCorrection,
  ConnectionCredentialRejectionResolution,
  ConnectionCredentialRejectionTriageFieldKey,
  ConnectionCredentialRejectionTriageStage,
  ConnectionCredentialRotationFailureReason,
  ConnectionView,
  ConnectionKind,
  EngagementHealthResponse,
  ReleaseCheckStatus,
  ReprobeEngagementCapabilitiesResponse,
} from '@recued/contracts';
import {
  initialConnectionsSetupGuideState,
  type ConnectionsSetupGuideState,
} from './setup-guide.js';
import type { ConnectionOAuthCredentialFieldKey } from './oauth-credentials.js';

/** Three dialog modes plus closed. The `subtype-picker` step is
 *  skipped for kind=api (no subtypes); the kind picker bypasses
 *  itself when the host opens the dialog with a pre-bound kind
 *  (recipe-install pre-fill — caller knows which kind already).
 *  D-129 P1.3 — vendor flows skip subtype-picker (vendors are
 *  always kind=api) and jump directly from the vendor card on the
 *  kind-picker into the form. The kind-picker renders vendor preset
 *  cards above the bare kind cards; clicking a vendor sets
 *  `dialog.vendor` + `dialog.kind = 'api'` + seeds `dialog.values`
 *  with the vendor's pre-fill map and goes straight to `'form'`. */
export type ConnectionsDialogStage =
  | 'closed'
  | 'kind-picker'
  | 'subtype-picker'
  | 'form';

/** An exact edit became stale while its values (including any replacement
 * credential) remain memory-only in this tab. Saving stays blocked until the
 * owner explicitly reloads or closes the draft. */
export interface ConnectionsDialogExternalChangeState {
  kind: ConnectionKind;
  name: string;
  phase: 'checking' | 'changed' | 'removed' | 'unconfirmed';
  reloading: boolean;
  error: string | null;
}

/** An exact credential replacement is owned by this or another browser tab.
 * Candidate credentials remain solely in `values`; this state carries only
 * connection identity and the safe-takeover phase. */
export interface ConnectionsDialogCredentialRotationOwnershipState {
  kind: ConnectionKind;
  name: string;
  phase:
    | 'active'
    | 'checking'
    | 'pending'
    | 'handoff'
    | 'available'
    | 'safe_stop_checking'
    | 'safe_stopped'
    | 'safe_stop_unconfirmed'
    | 'unconfirmed';
  /** True when this browser can quietly elect one successor after the live
   * owner disappears. False keeps the manual, server-authoritative fallback. */
  automaticTakeover: boolean;
  error: string | null;
}

/** A provider-authoritative credential rejection routed back to visible form
 * controls. Only closed-list schema keys and safe copy are retained; the draft
 * credential itself remains exclusively in `values` for this tab. */
export interface ConnectionsDialogCredentialCorrectionState {
  message: string;
  fieldKeys: ReadonlyArray<ConnectionCredentialCorrectionFieldKey>;
  /** Present only after a consecutive server-observed rejection. Endpoint
   * keys have already been intersected with this form's editable schema. */
  triage?: {
    stage: ConnectionCredentialRejectionTriageStage;
    endpointFieldKeys: ReadonlyArray<ConnectionCredentialRejectionTriageFieldKey>;
    resolution?: ConnectionCredentialRejectionResolution;
  };
  /** Server-authoritative closure state for a regeneration/admin safe stop.
   * The opaque acknowledgement token deliberately remains outside renderer
   * state so it can never enter HTML or accessibility text. */
  safeStopClosure?: {
    phase:
      | 'checking'
      | 'ready'
      | 'acknowledging'
      | 'unconfirmed'
      | 'unsupported';
    error: string | null;
  };
}

export interface ConnectionsDialogCredentialSafeStopClosureNotice {
  kind: ConnectionKind;
  name: string;
  nextStep: 'verify_replacement' | 'check_saved_connection';
}

/** Privacy-safe unresolved work projected by the paired server after a
 * credential safe stop has been acknowledged. The queue belongs to the page,
 * not the editor: closing or replacing a form must not lose the next recovery
 * handoff. Successful checks are never included by the server, which keeps
 * their confirmation receipts one-shot. */
export interface ConnectionsPostSafeStopRecoveryState {
  kind: ConnectionKind;
  name: string;
  status: 'pending' | 'auth_failed' | 'unreachable' | 'unknown';
  acknowledgedAt: number;
  checkedAt?: number;
  credentialCorrection?: ConnectionCredentialRejectionCorrection;
}

export interface ConnectionsDialogState {
  stage: ConnectionsDialogStage;
  /** Edit mode pins identity (kind, name) and pre-fills the form
   *  from an existing record's projection. The host hydrates the
   *  values + remembers the original identity so the rpc routes
   *  through `collection.connection.update` instead of `enroll`. */
  mode: 'create' | 'edit';
  /** Kind locked in once the user (or recipe-install pre-fill)
   *  picks one. Null while on the kind picker. */
  kind: ConnectionKind | null;
  /** Subtype locked in once picked. Null while on the subtype picker
   *  OR when kind=api (no subtype). */
  subtype: string | null;
  /** D-129 P1.3 — vendor segment locked in once a vendor card is
   *  picked from the kind-picker. Null on the bare-kind path; set to
   *  e.g. `'hubspot'` on the vendor-preset path. The form renderer
   *  threads this through `resolveConnectionSchema(kind, subtype,
   *  vendor)` so vendor-flavored schemas (D-129 P1.1) resolve over
   *  the bare-kind defaults. */
  vendor: string | null;
  /** Live form values keyed by their flat dotted-path schema key
   *  (`auth.type` → 'bearer'). Only the keys whose `showWhen`
   *  predicate evaluated to true at submit time are projected into
   *  the rpc payload. */
  values: Record<string, string>;
  /** Edit-mode origin id — `${kind}/${name}` of the record being
   *  patched. Null in create mode. */
  editingId: string | null;
  /** Set by authoritative sibling/focus reconciliation. This warning never
   * replaces `values`; it is the explicit stale-editor boundary. */
  externalChange: ConnectionsDialogExternalChangeState | null;
  /** Browser/server ownership gate for an in-flight replacement. `available`
   * means this tab holds the browser lease and the server reported idle. */
  credentialRotationOwnership:
    | ConnectionsDialogCredentialRotationOwnershipState
    | null;
  /** True while the enroll / update rpc round-trip is in flight.
   *  Disables Submit + dims inputs. */
  saving: boolean;
  /** Inline error from the most recent submit. Cleared on next
   *  field edit / stage change. */
  error: string | null;
  /** Structured provider rejection. Kept separate from `error` so unrelated
   * edits cannot dismiss it and the renderer can associate it with the exact
   * correction controls. */
  credentialCorrection: ConnectionsDialogCredentialCorrectionState | null;
  /** One-shot exact-editor confirmation after the paired server closes the
   * prior safe stop. It carries identity only and is cleared on resumed work. */
  credentialSafeStopClosureNotice:
    | ConnectionsDialogCredentialSafeStopClosureNotice
    | null;
  /** Most recent connection check, retained above the list after the dialog
   *  closes. Credential rotation uses the same region but carries an explicit
   *  verified receipt so it cannot be mistaken for an ordinary row probe.
   *  A post-safe-stop check also carries its closed resolution vocabulary:
   *  the renderer never parses provider prose to decide whether recovery is
   *  complete, retryable, or needs a fresh credential editor. */
  recentProbe?: {
    kind: ConnectionKind;
    name: string;
    status: string;
    purpose?: 'probe' | 'credential_rotation' | 'post_safe_stop';
    resolution?:
      | 'checking'
      | 'resolved'
      | 'reopen'
      | 'retry'
      | 'unsupported'
      | 'changed'
      | 'removed';
    /** Server-provided, value-free correction for a fresh rejection of the
     * currently saved credential. It never revives the acknowledged attempt. */
    credential_correction?: ConnectionCredentialRejectionCorrection;
    checked_at?: number;
    /** True when the receipt was recovered after an interruption. Recovered
     * copy avoids claiming the row is still current before the fresh list
     * snapshot lands. */
    recovered?: boolean;
    verified_at?: number;
    auth_type?: ConnectionAuthType;
    access_expires_at?: number;
  } | null;
  /** D-129 P1.3 — vendor OAuth code-exchange state. The host catches
   *  the "Authorize with <Vendor>" button click, runs the OAuth dance
   *  (`chrome.identity.launchWebAuthFlow` on the extension; popup
   *  window on the webapp), calls `collection.connection.
   *  completeVendorOAuth` rpc, and patches the result back: success
   *  fills `auth.refresh_token` in `values` + sets
   *  `oauthGrantedScopes`; failure fills `oauthError`. The renderer
   *  reads these to disable the button mid-flight, surface the
   *  granted scopes inline once the dance completes, and show the
   *  failure with a re-authorize affordance. */
  oauthInFlight: boolean;
  oauthError: string | null;
  /** Exact provider-credential field that can correct `oauthError`. Null for
   *  popup/server/callback failures that are not caused by one form field. */
  oauthErrorFieldKey: ConnectionOAuthCredentialFieldKey | null;
  /** D-223 — field key → the publisher whose pack suggested the seeded value.
   *  DISPLAY ONLY: it attributes a pre-filled box so that afterwards "I checked
   *  that" and "I did not look" are distinguishable. An entry is dropped the
   *  moment the owner edits that field — the value is theirs from then on — and
   *  nothing about the enrolled connection records where a value came from. */
  hintedFields: Record<string, string>;
  /** A successful in-app token was cleared because the owner changed an app,
   *  endpoint, scope, or environment value that the token was bound to. */
  oauthNeedsReauthorization: boolean;
  oauthGrantedScopes: readonly string[] | null;
  /** Owner-triggered, read-only AI setup assistant. Kept separate from
   *  `values` so its minimized request can never accidentally capture form
   *  credentials. */
  setupGuide: ConnectionsSetupGuideState;
}

/** D-192 slice 5 — the delete-confirm modal state. Non-null while a Delete
 *  click awaits confirmation. */
export interface ConnectionsDeleteConfirmState {
  kind: ConnectionKind;
  name: string;
  /** The `previewPurge` "[N] item(s)" count. `null` while the fetch is in
   *  flight OR the caller is unwired / the connection is non-purgeable → the
   *  confirm renders WITHOUT the "also remove" checkbox (a plain delete). A
   *  count of 0 likewise hides the checkbox (nothing to remove). */
  count: number | null;
  /** The "also remove the [N] item(s)" opt-in. Default `false` (ratified — the
   *  delete keeps the mirrored data unless the user explicitly opts in). */
  removeMirror: boolean;
  /** True while the delete rpc is in flight (Remove pressed) — disables the
   *  confirm buttons. */
  deleting: boolean;
}

/** Memory-only presentation of a paired server's authoritative receipt read.
 * The opaque receipt and every raw transport/server error remain inside the
 * verifier; UI surfaces receive only this allowlisted recovery state. */
export interface ServerUpdateReceiptVerificationState {
  readonly phase:
    | 'checking'
    | 'waiting'
    | 'retryable'
    | 'unknown'
    | 'reviewing_closure'
    | 'closing'
    | 'closed'
    | 'checking_baseline'
    | 'baseline_retryable'
    | 'baseline_confirmed'
    | 'finishing'
    | 'completed';
  readonly operation: 'update' | 'rollback';
  readonly startedAt: number;
  readonly reason?:
    | 'restart_pending'
    | 'temporary_failure'
    | 'unknown_receipt'
    | 'operation_mismatch'
    | 'closure_in_flight'
    | 'closure_unavailable'
    | 'baseline_unavailable'
    | 'finish_unavailable'
    | 'server_closed_unresolved';
  /** One-shot, memory-only projection of fresh reads from the selected server.
   * It describes only the state that exists now; it is never evidence that the
   * unresolved update or rollback succeeded or failed. The completed phase
   * keeps this projection only in the tab that explicitly retired the latch;
   * reloads and sibling tabs never replay that confirmation. */
  readonly baseline?: {
    readonly currentVersion: string;
    readonly channel: 'stable' | 'edge';
    readonly updateStatus: ReleaseCheckStatus;
    readonly affectedConnection?: {
      readonly kind: ConnectionKind;
      readonly name: string;
      readonly activity: 'idle' | 'pending' | 'unavailable';
    };
  };
}

/** Presentation-only recovery state for a secret-free rotation marker. The
 * opaque attempt id remains in the host/store and is never rendered. */
export interface ConnectionsCredentialRotationRecoveryState {
  kind: ConnectionKind;
  name: string;
  phase:
    | 'checking'
    | 'pending'
    | 'handoff'
    | 'handoff_waiting'
    | 'resumable'
    | 'editor_ready'
    | 'restart_ready'
    | 'restart_checking'
    | 'restart_triaging'
    | 'restart_handoff'
    | 'restart_waiting'
    | 'restart_unsupported'
    | 'restart_resolved'
    | 'safe_stop_checking'
    | 'safe_stopped'
    | 'safe_stop_unconfirmed'
    | 'superseded'
    | 'waiting'
    | 'not_received'
    | 'failed'
    | 'unsupported';
  failureReason?: ConnectionCredentialRotationFailureReason;
  /** Secret-free server handoff retained while the exact failed attempt is
   * being resumed or reviewed. Never synthesized from provider prose. */
  correction?: ConnectionCredentialRejectionCorrection;
  /** Cold discovery can surface several current stops. The UI presents the
   * newest exact handoff and reports how many remain without retaining their
   * identities in browser storage. */
  outstandingSafeStopCount?: number;
  /** Memory-only explicit intent. Set only after the owner chooses Start fresh,
   * so reconnect may resume that preflight without turning a passive sibling
   * handoff into an unsolicited editor open. */
  resumePreflightOnReconnect?: true;
  /** One-shot, privacy-safe return from the Account server-update guide. The
   * route carries only kind/name; this flag tailors the retry receipt so the
   * owner can tell the requested update check is the work now in progress. */
  returnedFromServerUpdate?: true;
  /** Server-authoritative, credential-free evidence captured only when the
   * required activity RPC is still absent after the explicit update return.
   * It is safe to render and hand to an administrator: no server URL, profile
   * token, connection configuration, or replacement value is included. */
  serverUpdateTriage?: ConnectionsServerUpdateTriage;
  /** Memory-only, profile-scoped progress from the tab coordinating a server
   * update or rollback. It carries no connection identity, endpoint, version,
   * credential, form value, or raw error. */
  serverUpdateProgress?: {
    phase: 'applying' | 'awaiting_reconnect';
    operation: 'update' | 'rollback';
    startedAt: number;
    operationId?: string;
  };
  /** Route-independent verifier status for the exact progress lineage above.
   * This state is never persisted and deliberately excludes the receipt and
   * raw failure details. */
  serverUpdateVerification?: ServerUpdateReceiptVerificationState;
  /** Last authoritative non-secret row revision used to make an idle
   * cleared-handoff receipt actionable. Start fresh must match it again after
   * its server-activity preflight; any later list read revokes the offer if the
   * connection changes before the clean editor opens. */
  baselineUpdatedAt?: number;
}

/** Why a returned server still cannot run the safe credential-rotation
 * activity preflight. The reason is derived from `update.check` plus the
 * running version observed before the update detour; it is never guessed from
 * browser timing alone. */
export type ConnectionsServerUpdateTriageReason =
  | 'update_still_available'
  | 'running_version_unchanged'
  | 'running_version_changed'
  | 'launcher_update_required'
  | 'self_update_unavailable'
  | 'current_build_missing_capability'
  | 'release_check_inconclusive';

/** Privacy-safe projection of the authoritative update check. */
export interface ConnectionsServerUpdateTriage {
  reason: ConnectionsServerUpdateTriageReason;
  checkStatus: ReleaseCheckStatus | 'unavailable';
  baselineVersion?: string;
  currentVersion?: string;
  channel?: 'stable' | 'edge';
  availableVersion?: string;
}

export interface ConnectionsPageState {
  loading: boolean;
  error: string | null;
  /** Flat list returned from `collection.connection.list`. The
   *  renderer faceted-groups by kind. */
  connections: ConnectionView[];
  /** Interrupted verify-before-swap reconciliation. It stays above the list
   * until a terminal receipt is shown or the exact connection is reviewed. */
  credentialRotationRecovery: ConnectionsCredentialRotationRecoveryState | null;
  /** Server-ordered unresolved post-ack checks/reopens. Kept separately from
   * the one visible receipt so a completed item can hand off to the next one
   * without replaying its success state. */
  postSafeStopRecoveries: ConnectionsPostSafeStopRecoveryState[];
  /** Connection-detail "Used by packs" — the INSTALLED packs' manifests, so the
   *  renderer can compute the inverse pivot (per api connection → the packs that
   *  use its vendor + scope coverage). Optional + best-effort: the host hydrates
   *  it from `packs.list`; absent → no "Used by packs" section. */
  installedPackManifests?: readonly BulkPackManifest[];
  /** D-225 Slice 2 — per-MCP-connection generated-pack status, keyed by
   *  `connectionRowKey`. Hydrated from `collection.connection.mcpPackStatus`,
   *  which needs no probe (both sides are already at rest), so the host can
   *  fetch one per mcp row without cost.
   *
   *  ⚠ ABSENT is not "up to date". A row with no entry renders NO badge, which
   *  is correct only because it means "not fetched yet" — the moment an entry
   *  exists, `unknown` renders VISIBLY rather than as silence. A host that
   *  hydrated failures as absent would recreate exactly the false all-clear the
   *  `unknown` status exists to prevent. */
  mcpPackStatus?: Readonly<Record<string, McpPackStatusView>>;
  /** D-225 Slice 2 — the open generated-pack review. Non-null while the owner
   *  is looking at what a server publishes, before Save installs it.
   *
   *  ⚠ It is a DISCLOSURE, not a second editor. `mcpPackCommit` writes no
   *  risk/approval rulings — those go through `contract.ownerOperation.*`,
   *  which enforces the approval floor and the downgrade confirm. Putting a
   *  per-row relax control on a screen the owner is skimming would route a
   *  downgrade around exactly the confirmation it exists to require. The chain
   *  continues into pack detail, where that editor already lives. */
  mcpPackReview: McpPackReviewState | null;
  /** Per-row probe in-flight markers, keyed by `${kind}/${name}`. */
  probeInFlight: Set<string>;
  /** Per-row delete in-flight markers, same keying. Used to disable
   *  the Delete button mid-rpc. */
  deleteInFlight: Set<string>;
  dialog: ConnectionsDialogState;
  /** D-192 slice 5 — the delete-confirm modal. Non-null while a Delete click is
   *  awaiting confirmation; carries the `previewPurge` count + the "also remove
   *  the mirrored data" opt-in. Null = no confirm open. */
  deleteConfirm: ConnectionsDeleteConfirmState | null;
  /** D-127 wire-up — dynamic option lists feeding `options_source`
   *  fields on the connection-form schema. Currently populated keys:
   *    - `data.mail.send_capable_instances` ⇒ `collection.mail.list`
   *      filtered client-side by `send_capable: true`, projected to
   *      slugs.
   *  Hosts hydrate this on connections-page open (sidebar /
   *  options page / webapp); the renderer reads it via the
   *  `dynamicOptions` prop on `ConnectionsPageProps` so the
   *  `sender_mail_instance` picker shows the live list. Empty
   *  entries trigger the field's `emptyGuidance` message. */
  dynamicOptions: Record<string, readonly string[]>;
  /** D-139 P2 — engagement-health detail panel state per connection
   *  name (HubSpot / Salesforce vendor connections only). The UI
   *  renders the per-entity health surface, capability grid, and
   *  action affordances inline below the matching connection row when
   *  the user expands the row. State is keyed by `connectionRowKey`
   *  (`${kind}/${name}`) so it co-exists with the existing per-row
   *  state maps. */
  engagementHealth: {
    /** Set of connection-row keys whose detail panel is currently
     *  expanded. Click on the row toggles membership; the host
     *  hydrates `data` on first expand. */
    expanded: Set<string>;
    /** Per-row in-flight markers for the rpc round-trip. */
    loading: Set<string>;
    /** Per-row in-flight markers for the Salesforce re-probe rpc. */
    reprobing: Set<string>;
    /** Per-row in-flight markers for the install-scheduled-puller
     *  affordance. The host runs the install through the existing
     *  recipe-install flow + flips this off when complete. */
    installing: Set<string>;
    /** Per-row error string from the most recent failed rpc. */
    error: Record<string, string>;
    /** Per-row engagement-health response from the most recent
     *  successful rpc. Hosts patch this through after each
     *  `engagementHealth` / `reprobeEngagementCapabilities` call. */
    data: Record<string, EngagementHealthResponse>;
    /** D-139 P2 Codex review fold #6 — per-row PushTopic auto-creation
     *  outcome from the most recent successful re-probe rpc. The panel
     *  renders this as a separate "PushTopic creation" status section
     *  so users can see whether SOAP create succeeded / preserved /
     *  failed per object. Hosts patch this through alongside `data`
     *  after a successful `reprobeEngagementCapabilities` call. */
    lastReprobe: Record<string, ReprobeEngagementCapabilitiesResponse>;
  };
}

export const initialConnectionsDialogState = (): ConnectionsDialogState => ({
  stage: 'closed',
  mode: 'create',
  kind: null,
  subtype: null,
  vendor: null,
  values: {},
  editingId: null,
  externalChange: null,
  credentialRotationOwnership: null,
  saving: false,
  error: null,
  credentialCorrection: null,
  credentialSafeStopClosureNotice: null,
  recentProbe: null,
  oauthInFlight: false,
  oauthError: null,
  oauthErrorFieldKey: null,
  hintedFields: {},
  oauthNeedsReauthorization: false,
  oauthGrantedScopes: null,
  setupGuide: initialConnectionsSetupGuideState(),
});

/** The open generated-pack review screen. */
export interface McpPackReviewState {
  connection: { kind: 'mcp'; name: string };
  /** Probing while true — the screen shows what the server says NOW. */
  loading: boolean;
  /** A failed probe. ⛔ The screen must show this rather than an empty list:
   *  zero rows reads as "this server has no tools", and an owner could Save
   *  that believing they had reviewed something. */
  error: string | null;
  pack_slug: string | null;
  view: McpPackReviewView | null;
  /** Install in flight. */
  saving: boolean;
}

export const initialConnectionsPageState = (): ConnectionsPageState => ({
  loading: false,
  error: null,
  connections: [],
  credentialRotationRecovery: null,
  postSafeStopRecoveries: [],
  probeInFlight: new Set(),
  deleteInFlight: new Set(),
  dialog: initialConnectionsDialogState(),
  deleteConfirm: null,
  mcpPackReview: null,
  dynamicOptions: {},
  engagementHealth: {
    expanded: new Set(),
    loading: new Set(),
    reprobing: new Set(),
    installing: new Set(),
    error: {},
    data: {},
    lastReprobe: {},
  },
});

/** Compose the row-level key used for probeInFlight / deleteInFlight
 *  membership checks. Same shape as the connection-row composite
 *  primary key. */
export const connectionRowKey = (kind: ConnectionKind, name: string): string =>
  `${kind}/${name}`;
