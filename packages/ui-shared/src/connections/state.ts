/** D-125 P7.1 — Settings → Connections page state shape.
 *
 *  The page holds three concerns at once: the enrolled-record list,
 *  the active enrollment / edit dialog (kind picker → subtype picker
 *  → form), and per-row probe / delete in-flight markers. The host
 *  passes a single state object into the pure renderer, which routes
 *  internally to list / kind-picker / subtype-picker / form views. */

import type {
  BulkPackManifest,
  ConnectionView,
  ConnectionKind,
  EngagementHealthResponse,
  ReprobeEngagementCapabilitiesResponse,
} from '@recued/contracts';

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
  /** True while the enroll / update rpc round-trip is in flight.
   *  Disables Submit + dims inputs. */
  saving: boolean;
  /** Inline error from the most recent submit. Cleared on next
   *  field edit / stage change. */
  error: string | null;
  /** Probe stamp from the most recent successful enroll — surfaced
   *  inline above the list view after dialog close so the user sees
   *  the post-save probe outcome. Null when no recent save. */
  recentProbe?: { kind: ConnectionKind; name: string; status: string } | null;
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
  oauthGrantedScopes: readonly string[] | null;
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

export interface ConnectionsPageState {
  loading: boolean;
  error: string | null;
  /** Flat list returned from `collection.connection.list`. The
   *  renderer faceted-groups by kind. */
  connections: ConnectionView[];
  /** Connection-detail "Used by packs" — the INSTALLED packs' manifests, so the
   *  renderer can compute the inverse pivot (per api connection → the packs that
   *  use its vendor + scope coverage). Optional + best-effort: the host hydrates
   *  it from `packs.list`; absent → no "Used by packs" section. */
  installedPackManifests?: readonly BulkPackManifest[];
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
  saving: false,
  error: null,
  recentProbe: null,
  oauthInFlight: false,
  oauthError: null,
  oauthGrantedScopes: null,
});

export const initialConnectionsPageState = (): ConnectionsPageState => ({
  loading: false,
  error: null,
  connections: [],
  probeInFlight: new Set(),
  deleteInFlight: new Set(),
  dialog: initialConnectionsDialogState(),
  deleteConfirm: null,
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
