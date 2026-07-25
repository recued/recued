/** D-174 P5 - top-level Data route.
 *
 *  Back-office warehouse surface: contacts + the four local work
 *  entity kinds are editable, mirror collections are read-only
 *  drill-downs through data.timeline().
 */

import type {
  ConnectionVendorEntity,
  ContactContributionView,
  ContactFieldProvenance,
  ContactMergeCandidate,
  ContactRecord,
  ContactSource,
  ContactSourceHealth,
  ContactImportCandidate,
  ContactImportFilePlan,
  EnrichmentMeta,
  EnrichmentScope,
  FieldValidationError,
  FormResponse,
  FormResponseGetRpcRequest,
  FormResponseGetRpcResponse,
  FormResponseListCursor,
  FormResponseListItem,
  FormResponseListQuery,
  FormResponseListRpcResponse,
  FormDefinition,
  MailingAddress,
  MemoryCreateRequest,
  MemoryDeleteRequest,
  MemoryDeleteResult,
  MemoryGetRequest,
  MemoryGetResponse,
  MemoryImportEntry,
  MemoryImportRequest,
  MemoryImportResult,
  MemoryListEntry,
  MemoryListRequest,
  MemoryListResponse,
  MemoryMutationResult,
  MemoryUpdateRequest,
  MirrorSearchRequest,
  MirrorSearchResponse,
  PlatformIdEntry,
  SourceDropdownOption,
  SourceExtensionSchema,
  SourceRegistration,
  ServerRecipeListEntry,
  TimelineEntry,
  TimelineRequest,
  TimelineResponse,
  UploadCreateRpcRequest,
  UploadCreateRpcResponse,
  UploadDeleteRpcRequest,
  UploadDeleteRpcResponse,
  UploadFinalizeRpcRequest,
  UploadFinalizeRpcResponse,
  UploadProbeRpcRequest,
  UploadProbeRpcResponse,
  WorkEntity,
  WorkEntityDeleteRpcRequest,
  WorkEntityDeleteRpcResponse,
  WorkEntityGetRpcRequest,
  WorkEntityGetRpcResponse,
  WorkEntityKind,
  WorkEntityListRpcRequest,
  WorkEntityListRpcResponse,
  WorkEntityListRow,
  WorkEntityPageState,
  WorkEntityUpsertRpcRequest,
  WorkEntityUpsertRpcResponse,
} from '@recued/contracts';
import {
  getContactSourceDeclaration,
  CONTACT_SOURCE_ID_DERIVED,
  CONTACT_SOURCE_ID_MANUAL,
  FILE_VENDOR_DECLARATIONS,
  BOOKING_DEFAULT_LIFECYCLE_STATE,
  WORK_ENTITY_KINDS,
  applySearchTransition,
  buildSourceDropdownOptions,
  closeDialogTransition,
  filterAndSortEntities,
  formFromCanonicalSchema,
  formFromCanonicalSchemaWithExtension,
  getCanonicalSchema,
  getVendorEntityForScope,
  initialWorkEntityPageState,
  isPlatformReferenceScope,
  openCreateDialogTransition,
  openEditDialogTransition,
  resolveCreateDialogSourceId,
  selectKindTransition,
  selectSourceTransition,
  setDialogErrorsTransition,
  setDialogSourceTransition,
  setDialogSubmitErrorTransition,
  setDialogSubmittingTransition,
  setDialogValuesTransition,
  validateForm,
} from '@recued/contracts';
import {
  ENTITY_DETAIL_PANEL_STYLES,
  FORM_RENDERER_STYLES,
  MERGE_REVIEW_DIALOG_STYLES,
  RefPicker,
  RunModal,
  Upload,
  WORK_ENTITY_PAGE_STYLES,
  collapseToFreshestPerTopic,
  e,
  formatRemaining,
  initialMergeReviewDialogState,
  isEtaEligible,
  pickFreshestMetaSnapshot,
  readFormValues,
  remainingMillis,
  renderEntityDetailPanel,
  renderTimelineSection,
  renderMergeReviewDialog,
  renderWorkEntityPage,
  type EnrichmentSummary,
  type EntityDetailPanelProps,
  type MergeReviewContactCard,
  type MergeReviewDialogState,
  type MergeReviewItem,
  type ScanProgress,
} from '@recued/ui-shared';

import type { BroadcastSubscriber } from '../realtime/subscriber.js';
import { serializeShellRoute } from '../shell/route.js';
import { humanizeRpcError } from '../shell/rpc-error-copy.js';
import { fileRefOptionsFromMirrorResults } from '../recipes/file-ref-picker.js';
import {
  MEMORY_ADD_ACTION,
  MEMORY_COMPOSE_CANCEL_ACTION,
  MEMORY_COMPOSE_SUBMIT_ACTION,
  MEMORY_DELETE_ACTION,
  MEMORY_DELETE_CANCEL_ACTION,
  MEMORY_DELETE_CONFIRM_ACTION,
  MEMORY_DETAIL_CLOSE_ACTION,
  MEMORY_EDIT_ACTION,
  MEMORY_EXPORT_ACTION,
  MEMORY_FIELD_ATTR,
  MEMORY_FILTER_ACTION,
  MEMORY_FILTER_VALUE_ATTR,
  MEMORY_IMPORT_ACTION,
  MEMORY_IMPORT_CANCEL_ACTION,
  MEMORY_IMPORT_SUBMIT_ACTION,
  MEMORY_LENS_SELECT_ACTION,
  MEMORY_LENS_STYLES,
  MEMORY_LENS_VALUE_ATTR,
  MEMORY_OPEN_ACTION,
  MEMORY_ROW_ID_ATTR,
  memoryFilterActors,
  renderLensSwitcher,
  renderMemoryLens,
  type MemoryComposeState,
  type MemoryDetailState,
  type MemoryImportState,
  type MemoryOriginFilter,
} from './memory-lens.js';
import {
  renderCollectionExplorer,
  COLLECTION_EXPLORER_STYLES,
  COLLECTION_SELECT_INSTANCE_ACTION,
  COLLECTION_OPEN_RECORD_ACTION,
  COLLECTION_DETAIL_CLOSE_ACTION,
  COLLECTION_INSTANCE_SLUG_ATTR,
  COLLECTION_RECORD_ID_ATTR,
  type CollectionExplorerDetailState,
} from './collection-explorer.js';
import type {
  Annotation,
  CanonicalCollectionName,
  CollectionInstanceRow,
  CollectionListQuery,
  CollectionPlatform,
  CollectionRecord,
  Link,
  SharedListEntry,
} from '@recued/contracts';
import {
  buildFormResponseManualRunContext,
  findFormResponseAutomationsForResponse,
  type FormResponseAutomationRunMatch,
} from './form-response-automation-run.js';

export const DATA_ROUTE_STYLES_MARKER = 'data-recued-data-route-styles';
export const DATA_ROUTE_HOST_ATTR = 'data-recued-data-route';
export const DATA_ROUTE_HEADING_ATTR = 'data-recued-data-route-heading';
export const DATA_ROUTE_TAB_ATTR = 'data-recued-data-route-tab';
export const DATA_ROUTE_CONTACT_ROW_ATTR = 'data-recued-data-contact-row';
export const DATA_ROUTE_FORM_RESPONSE_ROW_ATTR =
  'data-recued-data-form-response-row';
export const DATA_ROUTE_FORM_RESPONSE_DETAIL_ATTR =
  'data-recued-data-form-response-detail';
export const DATA_ROUTE_FORM_RESPONSE_AUTOMATE_ATTR =
  'data-recued-data-form-response-automate';
/** Opens the saved-automation picker for an already accepted response. */
export const DATA_ROUTE_FORM_RESPONSE_RUN_ATTR =
  'data-recued-data-form-response-run';
/** Inline discovery state/list under the response detail. */
export const DATA_ROUTE_FORM_RESPONSE_RUN_PICKER_ATTR =
  'data-recued-data-form-response-run-picker';
/** One matching saved recipe (value = recipe id). */
export const DATA_ROUTE_FORM_RESPONSE_RUN_RECIPE_ATTR =
  'data-recued-data-form-response-run-recipe';
export const DATA_ROUTE_FORM_RESPONSE_LOAD_MORE_ATTR =
  'data-recued-data-form-response-load-more';
/** R18 load-more — the "Showing N of M" + Load more footer under the contact
 *  list (present only while `loaded < total`). */
export const DATA_ROUTE_CONTACT_LOAD_MORE_ATTR = 'data-recued-data-contact-load-more';
/** R18 load-more — the same footer under a work-entity list. Its `total` is the
 *  server kind/Source count; the client-side search filters the loaded rows, so
 *  the count reads "N of M loaded" and Load more stays available under a search
 *  (bringing in more rows for the search to match). */
export const DATA_ROUTE_WORK_ENTITY_LOAD_MORE_ATTR = 'data-recued-data-work-entity-load-more';
export const DATA_ROUTE_CONTACT_DIALOG_ATTR = 'data-recued-data-contact-dialog';
export const DATA_ROUTE_MIRROR_ATTR = 'data-recued-data-mirror-panel';
/** D-172 Half-A "open" — the Files-tab "Download file" button (present only when
 *  the file-read caller is wired + a file is selected). */
export const DATA_ROUTE_DOWNLOAD_FILE_ATTR = 'data-recued-data-download-file';
/** D-192 file-SOURCE discoverability — the Files-tab "Add a file source" CTA
 *  block + its per-vendor enroll links (value = vendor slug). Deep-links to the
 *  Others enroll form so an S3 / Dropbox metadata mirror is reachable from where
 *  the mirror is viewed, without the bare `#connections/others/enroll/<vendor>`. */
export const DATA_ROUTE_FILE_SOURCES_ATTR = 'data-recued-data-file-sources';
export const DATA_ROUTE_FILE_SOURCE_LINK_ATTR = 'data-recued-data-file-source-link';
export const DATA_ROUTE_SOURCE_ERROR_ATTR = 'data-recued-data-source-error';
export const DATA_ROUTE_UNAVAILABLE_ATTR = 'data-recued-data-unavailable';
/** D-205 #2 — the contact DETAIL view (`#data/contact/<email>`). Supersedes the
 *  flow-20 timeline-only drill-down: the timeline is now one panel INSIDE the
 *  detail, below the identity + per-field provenance block. */
export const DATA_ROUTE_CONTACT_DETAIL_ATTR =
  'data-recued-data-contact-detail';
/** D-205 #2 — the per-field provenance block. THE reason this page exists: it is
 *  the only surface in the product where D-192 C-2's contribution ladder is
 *  visible ("org: Acme — from HubSpot", "name: … — you typed this"). Value =
 *  the contact's canonical email. */
export const DATA_ROUTE_CONTACT_PROVENANCE_ATTR =
  'data-recued-data-contact-provenance';
/** D-205 #2 — the confirmed platform-record links (`platform_ids`). This is the
 *  gate-crossing edge (spec §3): rendering it says "this HubSpot record IS your
 *  contact Bob". Owner-plane only — never resolve it on a surface that lacks
 *  BOTH the core-contact and the vendor grant. */
export const DATA_ROUTE_CONTACT_LINKS_ATTR =
  'data-recued-data-contact-links';
/** D-205 #2b — the merge scan page (`#data/contact/scan`). A SEPARATE page, not
 *  an affordance on the contact detail: a duplicate the user never navigates to
 *  is a duplicate never resolved. */
export const DATA_ROUTE_CONTACT_SCAN_ATTR = 'data-recued-data-contact-scan';
/** D-205 #2b — the live scan-progress line, fed by the `merge_scan_progress`
 *  broadcast. */
export const DATA_ROUTE_SCAN_PROGRESS_ATTR = 'data-recued-data-scan-progress';

/** D-205 #2c — the per-Source health strip on the Contacts list. The first surface
 *  that reads the contact runner's per-cycle counters. */
export const DATA_ROUTE_CONTACT_SOURCES_ATTR = 'data-recued-data-contact-sources';

/** D-205 #2b — the reserved segment-1 literal that addresses the scan page.
 *  It can never collide with a contact id: `#data/contact/<seg>` is an EMAIL
 *  when it contains `@`, and this literal does not. (Same discipline as
 *  `#kitchen`'s `recipe` / `pack` / `new` seg-0 markers.) */
export const DATA_ROUTE_CONTACT_SCAN_SEGMENT = 'scan';

/** D-205 #5b — the import page (`#data/contact/import`). Same reserved-literal
 *  discipline as `scan`: an email always carries an `@` and this does not, so it can
 *  never collide with a contact id. */
export const DATA_ROUTE_CONTACT_IMPORT_SEGMENT = 'import';
export const DATA_ROUTE_CONTACT_IMPORT_ATTR = 'data-recued-data-contact-import';
const DATA_ROUTE_IMPORT_TARGET_ATTR = 'data-import-target';
const DATA_ROUTE_IMPORT_SOURCE_ATTR = 'data-import-source';

const DATA_ROUTE_ACTION_ATTR = 'data-recued-data-action';
const DATA_ROUTE_TAB_ID_ATTR = 'data-data-tab';
const DATA_ROUTE_CONTACT_EMAIL_ATTR = 'data-contact-email';
const DATA_ROUTE_FORM_RESPONSE_ID_ATTR = 'data-form-response-id';
const DATA_ROUTE_CONTACT_FIELD_ATTR = 'data-recued-data-contact-field';
const DATA_ROUTE_CONTACT_SEARCH_ATTR = 'data-recued-data-contact-search';
const DATA_ROUTE_TIMELINE_ENTITY_ATTR = 'data-recued-data-timeline-entity';
const SHARED_ACTION_ATTR = 'data-action';
const DEFAULT_LIMIT = 100;

export type DataOwnItTabId = 'contact' | WorkEntityKind;
export type DataReceivedTabId = 'form_response';
export type MirrorDataKind = 'mail' | 'calendar' | 'crm' | 'files';
/** `webhook` (inbound HTTP deliveries) browses via the collection explorer like
 *  mail/calendar/files, but clusters under "Received" (inbound data) beside
 *  `form_response`. It is deliberately NOT a `MirrorDataKind` (not an external
 *  SaaS mirror) and NOT a `DataReceivedTabId` (that type drives `isReceivedTab`
 *  → the form-response surface; webhook renders via the explorer instead). */
/** D-198 Phase 2/3 — collections the explorer serves as a SINGLE GLOBAL
 *  collection: no per-account instances, read via their own whole-collection
 *  `list` rpc, rendered by the explorer's `singleCollection` mode. The D-120
 *  provenance graph (`annotation` / `link`, "Provenance" cluster) + the durable
 *  shared KV (`shared`, "Storage" cluster). */
export type DataProvenanceTabId = 'annotation' | 'link';
export type DataSingleCollectionTabId = DataProvenanceTabId | 'shared';
export type DataTabId =
  | DataOwnItTabId
  | DataReceivedTabId
  | MirrorDataKind
  | 'webhook'
  | DataSingleCollectionTabId;

export const DATA_OWN_IT_TABS: readonly DataOwnItTabId[] = [
  'contact',
  ...WORK_ENTITY_KINDS,
];

export const DATA_MIRROR_TABS: readonly MirrorDataKind[] = [
  'mail',
  'calendar',
  'crm',
  'files',
];

/** ⏭ **D-210 §4c — this tab is SCHEDULED FOR REMOVAL, as one atomic change.**
 *  `form_response`'s surface now also lives at `#reception/records` (commit `d1e0a4f31`) on the
 *  owner's placement rule: Records is IMMUTABLE, `#data/*` is MUTABLE. Reception is the intended
 *  home; this is the duplicate.
 *
 *  ⛔ **Do NOT just empty this list.** Measured 2026-07-18: emptying it makes the tab unreachable
 *  (it drops out of `DATA_TABS`, so `isDataTab` stops resolving the deep link, and out of
 *  `DATA_RECEIVED_CLUSTER`, so no nav anchor renders) — and that is exactly what leaves the tree
 *  RED, because it strands **264 refs across 25 regions of this file** plus **12 tests** in
 *  `d-174-p5-data-route.test.ts` (8 pure form-response, ~4 needing expectation updates).
 *  Tab + code + tests have to land together or HEAD breaks for every peer.
 *
 *  ⚠ `openFormResponse` is on the route's PUBLIC handle and forces `activeTab='form_response'`;
 *  no production caller exists (tests only), so it goes with the sweep. `humanizeFieldName` is
 *  used only by this block — safe to delete with it. */
export const DATA_RECEIVED_TABS: readonly DataReceivedTabId[] = [
  'form_response',
];

/** D-198 Phase 2 — the "Provenance" cluster: the D-120 annotation + link graph. */
export const DATA_PROVENANCE_TABS: readonly DataProvenanceTabId[] = [
  'annotation',
  'link',
];

/** D-198 Phase 3 — the "Storage" cluster: the durable shared KV (`data.shared.*`). */
export const DATA_SHARED_TABS: readonly DataTabId[] = ['shared'];

const DATA_TABS: readonly DataTabId[] = [
  ...DATA_OWN_IT_TABS,
  ...DATA_RECEIVED_TABS,
  'webhook',
  ...DATA_MIRROR_TABS,
  ...DATA_PROVENANCE_TABS,
  ...DATA_SHARED_TABS,
];

/** The "Received" cluster's DISPLAY tabs — `form_response` (its own bespoke
 *  surface) + the `webhook` explorer tab. Distinct from `DATA_RECEIVED_TABS`,
 *  which stays the `isReceivedTab` render-dispatch basis (form_response only);
 *  webhook renders via the explorer, so it must NOT make `isReceivedTab` true.
 *
 *  🔑 **When `form_response` leaves (D-210 §4c), `webhook` STAYS — that is a ruling, not an
 *  oversight.** The IMMUTABLE/MUTABLE placement rule is scoped to the reception lineage; the
 *  axis that decides Reception-vs-Data is WHO IS ON THE OTHER END, and mutability only orders
 *  things after that. Reception is a HUMAN VISITOR through a door you published; a webhook is a
 *  VENDOR SOURCE — a machine POSTing. Owner (2026-07-18): *"webhook is its own door in code, it
 *  just doesn't earn its place yet, so we temporarily put it in data where it is more relevant."*
 *
 *  ⏭ Open, deliberately not acted on: once `form_response` goes, `webhook` is this cluster's only
 *  member — and under the vendor-source framing it reads as MIRROR-family (beside mail / crm /
 *  files) rather than "Received". Re-clustering is a conscious call, not a tidy-up. */
const DATA_RECEIVED_CLUSTER: readonly DataTabId[] = [...DATA_RECEIVED_TABS, 'webhook'];

export type WorkEntitySourceListCaller = () => Promise<{
  sources: ReadonlyArray<SourceRegistration>;
  defaults_by_kind: Readonly<Partial<Record<WorkEntityKind, string>>>;
}>;

export type DataWorkEntityListCaller = (
  args: WorkEntityListRpcRequest,
) => Promise<WorkEntityListRpcResponse>;
export type DataWorkEntityGetCaller = (
  args: WorkEntityGetRpcRequest,
) => Promise<WorkEntityGetRpcResponse>;
export type DataWorkEntityUpsertCaller = (
  args: WorkEntityUpsertRpcRequest,
) => Promise<WorkEntityUpsertRpcResponse>;
export type DataWorkEntityDeleteCaller = (
  args: WorkEntityDeleteRpcRequest,
) => Promise<WorkEntityDeleteRpcResponse>;

export type DataContactListCaller = (args: {
  name_contains?: string;
  source?: ContactSource;
  since?: number;
  phone_exact?: string;
  limit?: number;
  offset?: number;
}) => Promise<{ contacts: ContactRecord[]; total: number }>;
export type DataContactGetCaller = (
  args: { email: string },
) => Promise<{ contact: ContactRecord | null }>;
/** D-205 merge-review item 3 — every contribution behind a contact's fields, each
 *  stamped by the server with whether it WON its kind. Powers the per-source block
 *  on the detail page: what HubSpot said, what Google said, and which one the ladder
 *  kept. */
export type DataContactContributionsCaller = (
  args: { email: string },
) => Promise<{ contributions: readonly ContactContributionView[] }>;
export type DataContactUpsertCaller = (
  args: {
    email: string;
    name?: string;
    last_interaction?: number;
    first_seen?: number;
    phone?: string;
    company?: string;
  },
) => Promise<{ contact: ContactRecord }>;
export type DataContactDeleteCaller = (
  args: { email: string },
) => Promise<{ ok: true; deleted: boolean }>;

// ── D-205 #2b — the merge scan surface (`#data/contact/scan`) ──────────────
//
// Four rpcs, all local-UI-only by construction: `contact.merge.*` sits in the
// MCP reserved-prefix set, so merge decisions can never be automated by a recipe
// or an external agent. They are user-authoritative, and this is where the user
// authors them.

export type DataContactMergeListCaller = (
  args: { status?: 'pending' | 'merged' | 'rejected'; limit?: number },
) => Promise<{ candidates: ContactMergeCandidate[]; next_cursor?: string }>;
export type DataContactMergeConfirmCaller = (
  args: { candidate_ids: string[]; survivor_email: string },
) => Promise<{ survivor: ContactRecord; losers: ContactRecord[] }>;
export type DataContactMergeRejectCaller = (
  args: { candidate_ids: string[] },
) => Promise<{ candidates: ContactMergeCandidate[]; rejection_rows_written: number }>;
export type DataContactMergeScanNowCaller = (
  args: { mode?: 'delta' | 'full' },
) => Promise<{
  mode: 'delta' | 'full';
  iterated: number;
  surfaced_count: number;
  yield_reason?: 'budget_exhausted' | 'no_work';
}>;

/** D-205 #2c — per-Source health for the Sources strip. Absent → no strip (a
 *  Source list we cannot read is not a Source list we should guess at). */
export type DataContactSourceListCaller = () => Promise<{
  sources: ReadonlyArray<ContactSourceHealth>;
}>;

/** D-205 #5b — `#data/contact/import`. The two rpcs behind the CRM picker.
 *
 *  ⚠ `candidates` returns STRANGERS — people this CRM mirrors that Recued does NOT
 *  know. They are not contacts and must never render as if they were: the entire
 *  point of the surface is that Recued has no relationship with them yet. */
export type DataContactImportCandidatesCaller = (args: {
  source_id: string;
  query?: string;
  offset?: number;
  limit?: number;
}) => Promise<{
  candidates: ReadonlyArray<ContactImportCandidate>;
  total: number;
  mirrored: number;
}>;
/** D-205 #5c — the manual vCard / CSV import. `preview` derives the plan; `apply`
 *  re-parses the SAME bytes and re-derives it, so there is no server state between the
 *  two and the client cannot hand back a plan it edited. */
export type DataContactImportFilePreviewCaller = (args: {
  text: string;
}) => Promise<ContactImportFilePlan>;
export type DataContactImportFileApplyCaller = (args: {
  text: string;
  apply_changes: boolean;
}) => Promise<{
  added: number;
  changed: number;
  skipped: number;
  failures: ReadonlyArray<string>;
}>;

export type DataContactImportPromoteCaller = (args: {
  source_id: string;
  target_ids: ReadonlyArray<string>;
}) => Promise<{
  created: number;
  already_known: number;
  failures: ReadonlyArray<string>;
}>;
export type DataTimelineCaller = (
  args: TimelineRequest,
) => Promise<TimelineResponse>;

export type DataFormResponseListCaller = (
  args: FormResponseListQuery,
) => Promise<FormResponseListRpcResponse>;
export type DataFormResponseGetCaller = (
  args: FormResponseGetRpcRequest,
) => Promise<FormResponseGetRpcResponse>;
export type DataRecipeListCaller = () => Promise<{
  recipes: ReadonlyArray<ServerRecipeListEntry>;
}>;

/** D-198 Slice 1b — the Memory lens feed read (owner-trusted whole-feed
 *  `memory.list`). Absent → the Memory lens shows a not-wired notice. */
export type DataMemoryListCaller = (
  args: MemoryListRequest,
) => Promise<MemoryListResponse>;

/** D-198 Slice 2 — owner memory CRUD callers (`memory.get/create/update/delete`).
 *  Absent → the Memory lens stays read-only (no Add / Edit / Delete / detail). */
export type DataMemoryGetCaller = (args: MemoryGetRequest) => Promise<MemoryGetResponse>;
export type DataMemoryCreateCaller = (args: MemoryCreateRequest) => Promise<MemoryMutationResult>;
export type DataMemoryUpdateCaller = (args: MemoryUpdateRequest) => Promise<MemoryMutationResult>;
export type DataMemoryDeleteCaller = (args: MemoryDeleteRequest) => Promise<MemoryDeleteResult>;
/** D-198 Slice 3 — bulk import (`memory.import`). Absent → the Import panel
 *  reports a not-wired notice. */
export type DataMemoryImportCaller = (args: MemoryImportRequest) => Promise<MemoryImportResult>;

/** D-198 Slice 5 — the generic collection-explorer reads (schema-driven
 *  list→detail over the adapter-backed collections). All three present → the
 *  mail/calendar tabs browse records; absent → a not-wired notice. */
export type DataCollectionListInstancesCaller = () => Promise<{
  instances: CollectionInstanceRow[];
}>;
export type DataCollectionListCaller = (
  args: CollectionListQuery,
) => Promise<{ records: CollectionRecord[] }>;
export type DataCollectionGetCaller = (
  args: { platform: CollectionPlatform; slug: string; record_id: string },
) => Promise<{ record: CollectionRecord | null }>;

/** D-198 Phase 2 — the provenance-graph whole-collection reads (`annotation.list`
 *  / `link.list`, empty filter = whole table). Single global collections, so no
 *  instances + no separate `get` (the list ships full records). Present → the
 *  Annotations / Links tabs browse; absent → a not-wired notice. */
export type DataAnnotationListCaller = () => Promise<{ annotations: Annotation[] }>;
export type DataLinkListCaller = () => Promise<{ links: Link[] }>;

/** D-198 Phase 3 — the durable shared KV browse (`shared.list({ prefix })` over
 *  the `data.shared.` prefix = the durable SQLite tier). Present → the Shared tab
 *  browses; absent → a not-wired notice. */
export type DataSharedListCaller = () => Promise<{ entries: SharedListEntry[] }>;

/** D-174 #22 — mirror-tab name→entity_id keyword search backing the
 *  drill-down combobox. Absent → the mirror tabs keep the raw-id box. */
export type DataMirrorSearchCaller = (
  args: MirrorSearchRequest,
) => Promise<MirrorSearchResponse>;

/** D-172 — the four `upload.*` control-plane rpc callers backing the Data →
 *  File drag/drop widget. All five upload deps absent → the Files tab keeps
 *  the read-only drill-down with no upload affordance. */
export type DataUploadCreateCaller = (
  req: UploadCreateRpcRequest,
) => Promise<UploadCreateRpcResponse>;
export type DataUploadProbeCaller = (
  req: UploadProbeRpcRequest,
) => Promise<UploadProbeRpcResponse>;
export type DataUploadFinalizeCaller = (
  req: UploadFinalizeRpcRequest,
) => Promise<UploadFinalizeRpcResponse>;
export type DataUploadDeleteCaller = (
  req: UploadDeleteRpcRequest,
) => Promise<UploadDeleteRpcResponse>;

/** D-172 Half-A "open" — owner file-content read backing the Files tab
 *  download. Absent → the Files drill-down keeps its metadata-only view with no
 *  download affordance. Owner-trusted `data.file.read` pair-RPC (not the gated
 *  op path); returns the record's bytes for a browser download. */
export type DataFileReadCaller = (args: {
  record_id: string;
}) => Promise<{
  record_id: string;
  bytes_b64: string;
  mime_type: string;
  filename: string;
  size_bytes: number;
}>;

export interface BootstrapDataRouteOptions {
  root: HTMLElement;
  document?: Document;
  workEntitySourceListCaller?: WorkEntitySourceListCaller;
  workEntityListCaller?: DataWorkEntityListCaller;
  workEntityGetCaller?: DataWorkEntityGetCaller;
  workEntityUpsertCaller?: DataWorkEntityUpsertCaller;
  workEntityDeleteCaller?: DataWorkEntityDeleteCaller;
  contactListCaller?: DataContactListCaller;
  contactGetCaller?: DataContactGetCaller;
  /** D-205 item 3 — the per-source value view on the contact detail page. Absent →
   *  the page renders exactly as it did before (winner + its provenance, no
   *  other-sources block). Not a floor for anything: it ADDS a reason to a value the
   *  page already shows. */
  contactContributionsCaller?: DataContactContributionsCaller;
  contactUpsertCaller?: DataContactUpsertCaller;
  contactDeleteCaller?: DataContactDeleteCaller;
  /** D-205 #2b — `#data/contact/scan`. `contactMergeListCaller` +
   *  `contactGetCaller` are the FLOOR (the review cards cannot be hydrated
   *  without both); confirm / reject / scan_now each gate their own affordance.
   *  Absent → the Contacts tab shows no "Find duplicates" entry point at all,
   *  rather than a page that cannot act. */
  contactMergeListCaller?: DataContactMergeListCaller;
  contactMergeConfirmCaller?: DataContactMergeConfirmCaller;
  contactMergeRejectCaller?: DataContactMergeRejectCaller;
  contactMergeScanNowCaller?: DataContactMergeScanNowCaller;
  /** D-205 #2c — the Sources health strip on the Contacts list. Absent → no strip. */
  contactSourceListCaller?: DataContactSourceListCaller;
  /** D-205 #5b — `#data/contact/import`. BOTH are the floor: a picker that can list
   *  but not add is a dead end, and one that can add but not list is unusable. Absent
   *  → no "Import" entry point at all, rather than a page that cannot act. */
  contactImportCandidatesCaller?: DataContactImportCandidatesCaller;
  contactImportPromoteCaller?: DataContactImportPromoteCaller;
  /** D-205 #5c — the manual vCard / CSV import. BOTH are the floor: a preview you
   *  cannot apply is a tease, and an apply you cannot preview is the stale-export
   *  foot-gun with no warning. Absent → no upload panel. */
  contactImportFilePreviewCaller?: DataContactImportFilePreviewCaller;
  contactImportFileApplyCaller?: DataContactImportFileApplyCaller;
  formResponseListCaller?: DataFormResponseListCaller;
  formResponseGetCaller?: DataFormResponseGetCaller;
  /** Owner-only installed recipe discovery + manual execution for explicitly
   *  continuing one already accepted response. Both must be present for the
   *  detail affordance to render. */
  recipeListCaller?: DataRecipeListCaller;
  recipeExecuteCaller?: RunModal.RunModalExecuteCaller;
  timelineCaller?: DataTimelineCaller;
  mirrorSearchCaller?: DataMirrorSearchCaller;
  /** D-198 Slice 1b — the Memory lens feed read (`memory.list`). Absent → the
   *  Memory lens renders a not-wired notice. */
  memoryListCaller?: DataMemoryListCaller;
  /** D-198 Slice 2 — owner memory CRUD (`memory.get/create/update/delete`).
   *  All present → the Memory lens shows Add / Edit / Delete / detail; absent →
   *  read-only feed. */
  memoryGetCaller?: DataMemoryGetCaller;
  memoryCreateCaller?: DataMemoryCreateCaller;
  memoryUpdateCaller?: DataMemoryUpdateCaller;
  memoryDeleteCaller?: DataMemoryDeleteCaller;
  /** D-198 Slice 3 — bulk import (`memory.import`). Present → the Memory lens
   *  shows the Import affordance. */
  memoryImportCaller?: DataMemoryImportCaller;
  /** D-198 Slice 5 — the collection explorer reads. All three present → the
   *  mail / calendar tabs browse list→detail (from the raw-id drill-down);
   *  absent → the tab shows a not-wired notice. */
  collectionListInstancesCaller?: DataCollectionListInstancesCaller;
  collectionListCaller?: DataCollectionListCaller;
  collectionGetCaller?: DataCollectionGetCaller;
  /** D-198 Phase 2 — the "Provenance" cluster reads (`annotation.list` /
   *  `link.list`). Present → the Annotations / Links tabs browse the whole
   *  collection; absent → a not-wired notice. */
  annotationListCaller?: DataAnnotationListCaller;
  linkListCaller?: DataLinkListCaller;
  /** D-198 Phase 3 — the "Storage" cluster read (`shared.list` over the durable
   *  `data.shared.` prefix). Present → the Shared tab browses; absent → notice. */
  sharedListCaller?: DataSharedListCaller;
  // D-172 — Data → File upload. The four rpc callers + the binary-socket
  // connect factory (host-injected, since ui-shared can't reach the token
  // store). All five present → the Files tab renders the drag/drop widget.
  uploadCreateCaller?: DataUploadCreateCaller;
  uploadProbeCaller?: DataUploadProbeCaller;
  uploadFinalizeCaller?: DataUploadFinalizeCaller;
  uploadDeleteCaller?: DataUploadDeleteCaller;
  uploadConnectFactory?: Upload.UploadConnectFactory;
  /** D-172 Half-A "open" — file-content read for the Files tab download. Absent
   *  → no download button (metadata-only drill-down). */
  fileReadCaller?: DataFileReadCaller;
  subscribe?: BroadcastSubscriber['on'];
  /** R18 — deep-link hydration (`#data/<tab>/<entity_id>`, R16). `initialTab`
   *  is validated against the known tabs (invalid → the default Contacts tab);
   *  `initialEntityId` opens that entity's timeline detail on the contact +
   *  mirror tabs (work-entity tabs hydrate the tab only — their detail is a
   *  modal edit, not a timeline view yet). */
  initialTab?: string;
  initialEntityId?: string;
  /** R18 — debounce window (ms) for the `warehouse`/`memory` live-update
   *  re-fetch; coalesces a write burst into one refresh. Default 400ms;
   *  `<= 0` refreshes immediately (tests). */
  liveRefreshDebounceMs?: number;
  /** `Date.now`-compatible clock for the entity-detail panel's
   *  relative-time copy. Tests pass a fixed timestamp for determinism. */
  now?: () => number;
}

export interface DataLoadErrors {
  sources?: string;
  work_entities?: string;
  contacts?: string;
  /** D-205 #2 — the contact DETAIL's `contact.get` failure. Deliberately its own
   *  slot rather than reusing `contacts`: that one is the LIST's, and folding a
   *  single record's fetch failure into it would surface "failed to load
   *  contacts" over a list that loaded perfectly well the moment the user
   *  navigated back. Two different failures, two slots. */
  contact_detail?: string;
  /** D-205 merge-review item 3 — the per-source view's own slot.
   *
   *  ⚠ It NEEDS one. The other-sources list is an absence-shaped surface: when it
   *  renders nothing, the honest reading is "no other source asserts this field" —
   *  so a FAILED fetch that quietly renders nothing does not look like a failure, it
   *  looks like a FACT about the user's data. Same class as the Tier-1 read fences
   *  refusing into `{matches: []}` (D-205 #3): a refusal that renders as absence is a
   *  false negative the user believes. Its own slot, so it can say so. */
  contact_contributions?: string;
  /** D-205 #5b — the import page's own slot (the stranger list + the promote).
   *  Its own, for the same reason `contact_detail` is: folding it into `contacts`
   *  would surface "failed to load contacts" over a list that is perfectly fine. */
  contact_import?: string;
  /** D-205 #2b — the merge scan page's own slot (queue hydrate + `scan_now`).
   *  Per-item confirm/reject failures go INSIDE the dialog (`dialog.error`) —
   *  they belong next to the cluster they failed on, not in the route's banner. */
  contact_merge?: string;
  form_responses?: string;
  timeline?: string;
  memory?: string;
}

interface ContactDialogValues {
  email: string;
  name: string;
  phone: string;
  company: string;
}

interface ContactDialogState {
  mode: 'create' | 'edit';
  values: ContactDialogValues;
  errors: Partial<Record<keyof ContactDialogValues, string>>;
  submitting: boolean;
  submit_error: string | null;
}

interface TimelineSnapshot {
  kind: MirrorDataKind;
  entity_id: string;
  response: TimelineResponse | null;
}

/** D-205 #2 — the contact DETAIL view (`#data/contact/<email>`), on the own-it
 *  Contacts tab. Kept separate from the mirror-tab `TimelineSnapshot` so
 *  browsing a contact never perturbs the MirrorDataKind raw-id flow.
 *
 *  THREE independent fetches back this, and any may be absent without sinking the
 *  page: `contact` (the projected record — carries the per-field provenance this
 *  page exists to show) comes from `contact.get`, `response` (the activity feed)
 *  from `data.timeline`, and `contributions` (what every OTHER source said about
 *  each field) from `contact.contributions`. A host that wires only some still
 *  renders the part it has, because they answer different questions and none is a
 *  precondition for another. */
interface ContactDetailState {
  email: string;
  contact: ContactRecord | null;
  response: TimelineResponse | null;
  /** D-205 merge-review item 3 — every contribution behind this contact's fields,
   *  each stamped by the SERVER with whether it won its kind. The projection keeps
   *  only the winner, so without these the ladder is visible only in its outcome:
   *  you can see Recued chose HubSpot's `Acme Inc.`, but never that Google said
   *  `Acme Corp`.
   *
   *  ⛔ **Never re-rank these client-side.** `winner` is authoritative — it was
   *  stamped by the same resolver the projection runs. A second implementation of
   *  which-value-wins is exactly the bug merge-review item 1 fixed. */
  contributions: readonly ContactContributionView[];
  /** True when the contributions fetch FAILED (as opposed to returning nothing).
   *
   *  ⚠ The distinction is the whole point, and `contributions: []` cannot carry it.
   *  An empty list is a CLAIM — "no other source asserts these fields" — and it is a
   *  claim about the user's data. A failed fetch that renders the same empty list
   *  makes that claim falsely, and the user has no way to tell. `renderErrors` says
   *  WHY it broke; this says WHAT is therefore missing, next to the fields it is
   *  missing from. (Same class as the D-205 #3 read fences refusing into
   *  `{matches: []}` — a refusal that renders as absence is a false negative stated
   *  as fact.) */
  contributions_failed: boolean;
}

/** D-205 #2b — live progress of a running `contact.merge.scan_now`, assembled
 *  from the `merge_scan_progress` broadcast.
 *
 *  The broadcast carries `(iterated, total)` but no RATE, so the ETA has to be
 *  derived here: `samples` counts the progress events seen and `started_at`
 *  anchors the elapsed time, which together give the `ms_per_iteration` the
 *  ui-shared ETA helpers need. They refuse to project from too few samples —
 *  which is the point, because a scan's first ticks are the least representative
 *  of its rate, and an ETA that lurches is worse than no ETA. */
interface ContactScanProgress {
  iterated: number;
  total: number | null;
  surfaced: number;
  samples: number;
  started_at: number;
}

/** D-205 #2b — the merge scan page (`#data/contact/scan`). */
interface ContactScanState {
  /** The ui-shared dialog's own state — items / cursor / survivor overrides /
   *  saving / error. We own it; the dialog is a pure render of it. */
  dialog: MergeReviewDialogState;
  /** Hydrating the candidate queue (`contact.merge.list` + the per-email gets). */
  loading: boolean;
  /** A `scan_now` is in flight. */
  scanning: boolean;
  progress: ContactScanProgress | null;
  /** Outcome of the last completed scan, for the "what just happened" line. */
  last_scan: { iterated: number; surfaced_count: number } | null;
}

export interface DataRoute {
  activeTab(): DataTabId;
  /** D-198 Slice 1b — the active lens ('data' tabs vs the 'memory' feed). */
  activeLens(): 'data' | 'memory';
  memoryEntries(): ReadonlyArray<MemoryListEntry>;
  memoryOriginFilter(): MemoryOriginFilter;
  workEntityState(): WorkEntityPageState;
  contacts(): ReadonlyArray<ContactRecord>;
  formResponses(): ReadonlyArray<FormResponseListItem>;
  workEntities(): ReadonlyArray<WorkEntity>;
  timeline(): TimelineSnapshot | null;
  getLoadErrors(): DataLoadErrors;
  refresh(): void;
  whenLoaded(): Promise<void>;
  selectTab(tab: DataTabId): Promise<void>;
  openCreateWorkEntityDialog(): void;
  openEditWorkEntityDialog(kind: WorkEntityKind, id: string): Promise<void>;
  setWorkEntityDialogValues(values: Record<string, unknown>): void;
  confirmWorkEntityDialog(): Promise<void>;
  deleteWorkEntity(kind: WorkEntityKind, id: string): Promise<void>;
  openCreateContactDialog(): void;
  openEditContactDialog(email: string): Promise<void>;
  setContactDialogValues(values: Partial<ContactDialogValues>): void;
  confirmContactDialog(): Promise<void>;
  deleteContact(email: string): Promise<void>;
  openFormResponse(submission_id: string): Promise<void>;
  closeFormResponse(): void;
  discoverFormResponseAutomations(): Promise<void>;
  reviewFormResponseAutomation(recipe_id: string): void;
  confirmFormResponseAutomationRun(): Promise<void>;
  openTimelineDrilldown(kind: MirrorDataKind, entity_id: string): Promise<void>;
  /** D-205 #2 — open `#data/contact/<email>`: the projected record + its
   *  per-field provenance + the activity timeline. */
  openContactDetail(email: string): Promise<void>;
  closeContactDetail(): void;
  // ── D-205 #2b — the merge scan page (`#data/contact/scan`) ──────────────
  openContactScan(): Promise<void>;
  closeContactScan(): void;
  /** Run `contact.merge.scan_now({ mode: 'full' })`, then re-hydrate the queue. */
  runMergeScan(): Promise<void>;
  /** Confirm / reject the cluster under the cursor. */
  resolveMergeItem(resolution: 'confirm' | 'reject'): Promise<void>;
  setMergeSurvivor(email: string): void;
  moveMergeCursor(delta: number): void;
  contactScan(): ContactScanState | null;
  /** D-205 #5b — `#data/contact/import`. Exposed for the same reason the scan page's
   *  hooks are: the surface's contract is what it DOES (which rpc, with which
   *  arguments), and driving that through synthetic DOM events tests the browser, not
   *  the decision. */
  openContactImport(): Promise<void>;
  browseImportSource(source_id: string): Promise<void>;
  toggleImportTarget(target_id: string): void;
  promoteImport(): Promise<void>;
  /** D-205 #5c — the file import. */
  previewImportFile(file: File): Promise<void>;
  applyImportFile(): Promise<void>;
  setImportApplyChanges(on: boolean): void;
  contactImport(): ContactImportState | null;
  dispose(): void;
}

const DATA_ROUTE_STYLES = `
[${DATA_ROUTE_HOST_ATTR}] {
  /* Inherit the shell's light/dark tokens instead of hard-pinning light
     values, which left inner --bg/--surface-sunk elements dark-on-dark
     in dark mode (visual-UX review). */
  max-width: var(--wc-content-max, 1080px);
  margin: 0 auto;
  padding: 16px;
  color: var(--fg);
}
[${DATA_ROUTE_HOST_ATTR}] .data-header {
  display: flex;
  align-items: baseline;
  gap: 12px;
  margin-bottom: 14px;
}
[${DATA_ROUTE_HOST_ATTR}] .data-title {
  margin: 0;
  font-size: 20px;
  font-weight: 650;
}
[${DATA_ROUTE_HOST_ATTR}] .data-inline-link {
  color: var(--accent);
  font-size: 13px;
  text-decoration: none;
}
/* R18 — the tab strip is grouped: Owned (editable) vs Connected (read-only
   search), each a labelled cluster. */
[${DATA_ROUTE_HOST_ATTR}] .data-tab-groups {
  display: flex;
  flex-wrap: wrap;
  gap: 10px 22px;
  margin: 0 0 14px;
}
[${DATA_ROUTE_HOST_ATTR}] .data-tab-group {
  display: grid;
  gap: 5px;
}
[${DATA_ROUTE_HOST_ATTR}] .data-tab-group-label {
  font-size: 10px;
  font-weight: 650;
  text-transform: uppercase;
  letter-spacing: .05em;
  color: var(--muted);
}
[${DATA_ROUTE_HOST_ATTR}] .data-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 0;
}
[${DATA_ROUTE_HOST_ATTR}] .data-tab {
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface);
  color: var(--fg);
  padding: 7px 10px;
  font: inherit;
  font-size: 13px;
  cursor: pointer;
}
[${DATA_ROUTE_HOST_ATTR}] .data-tab[data-active="true"] {
  border-color: var(--accent);
  background: var(--accent-subtle);
  color: var(--accent);
  font-weight: 650;
}
[${DATA_ROUTE_HOST_ATTR}] .data-loading,
[${DATA_ROUTE_UNAVAILABLE_ATTR}],
[${DATA_ROUTE_SOURCE_ERROR_ATTR}] {
  margin: 8px 0;
  font-size: 13px;
  line-height: 1.45;
  color: var(--muted);
}
[${DATA_ROUTE_SOURCE_ERROR_ATTR}] {
  border-left: 3px solid var(--danger);
  padding-left: 8px;
  color: var(--danger);
}
[${DATA_ROUTE_UNAVAILABLE_ATTR}] {
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface-subtle);
  padding: 10px 12px;
}
[${DATA_ROUTE_HOST_ATTR}] .data-contact-toolbar,
[${DATA_ROUTE_HOST_ATTR}] .data-mirror-toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 10px 0;
}
[${DATA_ROUTE_HOST_ATTR}] .data-input {
  min-width: min(280px, 100%);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 8px;
  font: inherit;
  font-size: 13px;
}
[${DATA_ROUTE_HOST_ATTR}] .data-button {
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface);
  color: var(--fg);
  padding: 7px 10px;
  font: inherit;
  font-size: 13px;
  cursor: pointer;
}
[${DATA_ROUTE_HOST_ATTR}] .data-button--primary {
  border-color: var(--accent);
  background: var(--accent);
  color: var(--on-accent);
}
[${DATA_ROUTE_HOST_ATTR}] .data-button--danger {
  border-color: var(--danger);
  color: var(--danger);
}
[${DATA_ROUTE_HOST_ATTR}] .data-button:disabled {
  cursor: not-allowed;
  opacity: .65;
}
[${DATA_ROUTE_HOST_ATTR}] a.data-button {
  display: inline-block;
  text-decoration: none;
}
[${DATA_ROUTE_HOST_ATTR}] .data-file-sources {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 12px;
  margin: 10px 0;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface-subtle);
}
[${DATA_ROUTE_HOST_ATTR}] .data-file-sources-label {
  font-size: 13px;
  color: var(--muted);
}
[${DATA_ROUTE_HOST_ATTR}] .data-file-sources-links {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
[${DATA_ROUTE_HOST_ATTR}] .data-empty-actions {
  margin-top: 10px;
}
[${DATA_ROUTE_HOST_ATTR}] .data-section-title {
  margin: 0 0 8px;
  font-size: 15px;
  font-weight: 650;
}
[${DATA_ROUTE_HOST_ATTR}] .data-contact-list,
[${DATA_ROUTE_HOST_ATTR}] .data-form-response-list,
[${DATA_ROUTE_HOST_ATTR}] .data-timeline-list {
  display: grid;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}
[${DATA_ROUTE_HOST_ATTR}] .data-list-footer {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 12px;
}
[${DATA_ROUTE_HOST_ATTR}] .data-list-count {
  font-size: 13px;
  color: var(--muted);
}
[${DATA_ROUTE_HOST_ATTR}] .data-row-button,
[${DATA_ROUTE_HOST_ATTR}] .data-timeline-row {
  width: 100%;
  min-width: 0;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
  padding: 10px;
  text-align: left;
}
[${DATA_ROUTE_HOST_ATTR}] .data-row-button {
  cursor: pointer;
}
/* flow-20 — contact rows host a secondary "Timeline" control beside the
   edit row button. */
[${DATA_ROUTE_HOST_ATTR}] .data-contact-list li {
  display: flex;
  gap: 8px;
  align-items: stretch;
}
[${DATA_ROUTE_HOST_ATTR}] .data-form-response-list .data-row-button {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 5px 14px;
  align-items: center;
}
[${DATA_ROUTE_HOST_ATTR}] .data-form-response-list .data-row-title,
[${DATA_ROUTE_HOST_ATTR}] .data-form-response-list .data-row-meta {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
[${DATA_ROUTE_HOST_ATTR}] .data-form-response-list .data-row-meta,
[${DATA_ROUTE_HOST_ATTR}] .data-form-response-list .data-row-subtle {
  grid-column: 1;
  margin-top: 0;
}
[${DATA_ROUTE_HOST_ATTR}] .data-form-response-list .data-pill {
  grid-column: 2;
  grid-row: 1 / span 2;
}
[${DATA_ROUTE_FORM_RESPONSE_DETAIL_ATTR}] .data-response-header {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 12px;
  margin: 12px 0;
}
[${DATA_ROUTE_FORM_RESPONSE_DETAIL_ATTR}] .data-response-header h2 {
  margin: 0;
  font-size: 18px;
}
[${DATA_ROUTE_FORM_RESPONSE_DETAIL_ATTR}] .data-response-meta {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 8px;
  margin: 0 0 16px;
}
[${DATA_ROUTE_FORM_RESPONSE_DETAIL_ATTR}] .data-response-automation {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px 20px;
  margin: 0 0 16px;
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface-subtle);
}
[${DATA_ROUTE_FORM_RESPONSE_DETAIL_ATTR}] .data-response-automation-copy {
  display: grid;
  gap: 3px;
  min-width: 0;
}
[${DATA_ROUTE_FORM_RESPONSE_DETAIL_ATTR}] .data-response-automation-copy strong {
  font-size: 13px;
}
[${DATA_ROUTE_FORM_RESPONSE_DETAIL_ATTR}] .data-response-automation-copy span {
  color: var(--muted);
  font-size: 12px;
  line-height: 1.45;
}
[${DATA_ROUTE_FORM_RESPONSE_DETAIL_ATTR}] .data-response-automation-actions {
  display: flex;
  flex: 0 0 auto;
  gap: 8px;
}
[${DATA_ROUTE_FORM_RESPONSE_RUN_PICKER_ATTR}] {
  margin: -4px 0 18px;
  padding: 14px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--surface);
}
[${DATA_ROUTE_FORM_RESPONSE_RUN_PICKER_ATTR}] p {
  margin: 0;
  color: var(--muted);
  font-size: 12px;
  line-height: 1.5;
}
[${DATA_ROUTE_FORM_RESPONSE_RUN_PICKER_ATTR}] [role="alert"] {
  margin-bottom: 10px;
  color: var(--danger);
}
[${DATA_ROUTE_FORM_RESPONSE_RUN_PICKER_ATTR}] h3 {
  margin: 0 0 4px;
  font-size: 15px;
}
[${DATA_ROUTE_FORM_RESPONSE_RUN_PICKER_ATTR}] ul {
  display: grid;
  gap: 8px;
  margin: 14px 0 0;
  padding: 0;
  list-style: none;
}
[${DATA_ROUTE_FORM_RESPONSE_RUN_PICKER_ATTR}] li {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  align-items: center;
  gap: 8px 12px;
  padding: 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface-subtle);
}
[${DATA_ROUTE_FORM_RESPONSE_RUN_PICKER_ATTR}] li > div {
  display: grid;
  gap: 3px;
  min-width: 0;
}
[${DATA_ROUTE_FORM_RESPONSE_RUN_PICKER_ATTR}] code {
  overflow: hidden;
  color: var(--muted);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
@media (max-width: 640px) {
  [${DATA_ROUTE_FORM_RESPONSE_DETAIL_ATTR}] .data-response-automation {
    align-items: stretch;
    flex-direction: column;
  }
  [${DATA_ROUTE_FORM_RESPONSE_DETAIL_ATTR}] .data-response-automation .data-button {
    text-align: center;
  }
  [${DATA_ROUTE_FORM_RESPONSE_DETAIL_ATTR}] .data-response-automation-actions {
    display: grid;
  }
  [${DATA_ROUTE_FORM_RESPONSE_RUN_PICKER_ATTR}] li {
    grid-template-columns: 1fr auto;
  }
  [${DATA_ROUTE_FORM_RESPONSE_RUN_PICKER_ATTR}] li .data-button {
    grid-column: 1 / -1;
  }
}
[${DATA_ROUTE_FORM_RESPONSE_DETAIL_ATTR}] .data-response-meta div,
[${DATA_ROUTE_FORM_RESPONSE_DETAIL_ATTR}] .data-response-field {
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
  padding: 10px 12px;
}
[${DATA_ROUTE_FORM_RESPONSE_DETAIL_ATTR}] .data-response-meta dt,
[${DATA_ROUTE_FORM_RESPONSE_DETAIL_ATTR}] .data-response-field dt {
  margin-bottom: 5px;
  color: var(--muted);
  font-size: 11px;
  font-weight: 650;
  text-transform: uppercase;
  letter-spacing: .04em;
}
[${DATA_ROUTE_FORM_RESPONSE_DETAIL_ATTR}] .data-response-meta dd,
[${DATA_ROUTE_FORM_RESPONSE_DETAIL_ATTR}] .data-response-field dd {
  margin: 0;
  overflow-wrap: anywhere;
  font-size: 13px;
  line-height: 1.5;
  white-space: pre-wrap;
}
[${DATA_ROUTE_FORM_RESPONSE_DETAIL_ATTR}] .data-response-fields {
  display: grid;
  gap: 8px;
  margin: 0;
}
[${DATA_ROUTE_FORM_RESPONSE_DETAIL_ATTR}] .data-response-field pre {
  margin: 0;
  overflow: auto;
  white-space: pre-wrap;
  font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
}
[${DATA_ROUTE_HOST_ATTR}] .data-contact-list .data-row-button {
  flex: 1;
}
/* Contact rows lead with an initial glyph + a stacked text column so the
   list reads as a dense, intentional roster (not three bare lines). */
[${DATA_ROUTE_HOST_ATTR}] .data-contact-row-button {
  display: flex;
  gap: 11px;
  align-items: center;
}
[${DATA_ROUTE_HOST_ATTR}] .data-contact-avatar {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: 999px;
  background: var(--surface-sunk);
  border: 1px solid var(--border);
  color: var(--accent);
  font-size: 13px;
  font-weight: 650;
}
[${DATA_ROUTE_HOST_ATTR}] .data-contact-text {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}
[${DATA_ROUTE_HOST_ATTR}] .data-contact-text .data-row-meta,
[${DATA_ROUTE_HOST_ATTR}] .data-contact-text .data-row-subtle {
  margin-top: 0;
}
[${DATA_ROUTE_HOST_ATTR}] .data-contact-text .data-row-title,
[${DATA_ROUTE_HOST_ATTR}] .data-contact-text .data-row-meta,
[${DATA_ROUTE_HOST_ATTR}] .data-contact-text .data-row-subtle {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* D-205 #2 — the contact detail page. */
[${DATA_ROUTE_HOST_ATTR}] .data-contact-detail-header {
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 12px 0 16px;
}
[${DATA_ROUTE_HOST_ATTR}] .data-contact-detail-heading {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
[${DATA_ROUTE_HOST_ATTR}] .data-contact-detail-heading .data-section-title {
  margin: 0;
}
[${DATA_ROUTE_HOST_ATTR}] .data-contact-detail-heading .data-row-meta,
[${DATA_ROUTE_HOST_ATTR}] .data-contact-detail-heading .data-row-subtle {
  margin-top: 0;
}
[${DATA_ROUTE_HOST_ATTR}] .data-contact-avatar--lg {
  width: 44px;
  height: 44px;
  font-size: 18px;
  flex: 0 0 auto;
}
[${DATA_ROUTE_HOST_ATTR}] .data-contact-merged {
  padding: 10px 12px;
  margin: 0 0 16px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface-sunk);
  font-size: 13px;
}
[${DATA_ROUTE_HOST_ATTR}] .data-contact-fields {
  display: grid;
  grid-template-columns: minmax(96px, max-content) 1fr;
  gap: 8px 16px;
  margin: 0 0 20px;
}
[${DATA_ROUTE_HOST_ATTR}] .data-contact-field {
  display: contents;
}
[${DATA_ROUTE_HOST_ATTR}] .data-contact-field .data-label {
  align-self: baseline;
}
[${DATA_ROUTE_HOST_ATTR}] .data-contact-value {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 4px 8px;
  margin: 0;
  min-width: 0;
}
[${DATA_ROUTE_HOST_ATTR}] .data-contact-value-text {
  font-size: 14px;
  overflow-wrap: anywhere;
}
/* The provenance line. Deliberately quiet: it annotates the value, it does not
   compete with it. */
[${DATA_ROUTE_HOST_ATTR}] .data-contact-origin {
  font-size: 12px;
  color: var(--muted);
}
[${DATA_ROUTE_HOST_ATTR}] .data-contact-origin::before {
  content: "— ";
}
/* The stored address is NORMALIZED for matching (lowercased + abbreviations
   expanded), so it is the only field whose canonical form reads as a typo.
   Capitalize for DISPLAY only: CSS capitalize uppercases the first letter of
   each word and leaves the rest untouched, so "austin" reads as "Austin" while
   "TX" and "US" survive intact. The stored value is not touched. */
[${DATA_ROUTE_HOST_ATTR}] .data-contact-field[data-provenance-field="address"] .data-contact-value-text {
  text-transform: capitalize;
}
[${DATA_ROUTE_HOST_ATTR}] .data-contact-links {
  margin: 0 0 20px;
}
[${DATA_ROUTE_HOST_ATTR}] .data-contact-link-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
[${DATA_ROUTE_HOST_ATTR}] .data-contact-link {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 8px;
  font-size: 13px;
}
[${DATA_ROUTE_HOST_ATTR}] .data-contact-link-vendor {
  font-weight: 650;
}
[${DATA_ROUTE_HOST_ATTR}] .data-contact-link-id {
  font-family: var(--mono, ui-monospace, monospace);
  font-size: 12px;
  color: var(--muted);
  overflow-wrap: anywhere;
}
[${DATA_ROUTE_HOST_ATTR}] .data-subsection-title {
  font-size: 13px;
  font-weight: 650;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--muted);
  margin: 0 0 8px;
}
/* D-205 #2c — the Sources health strip. */
[${DATA_ROUTE_HOST_ATTR}] .data-sources-strip {
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface-sunk);
  padding: 8px 12px;
  margin: 0 0 12px;
  font-size: 13px;
}
[${DATA_ROUTE_HOST_ATTR}] .data-sources-summary {
  display: flex;
  align-items: baseline;
  gap: 8px;
  cursor: pointer;
  font-weight: 650;
}
[${DATA_ROUTE_HOST_ATTR}] .data-source-list {
  list-style: none;
  margin: 10px 0 2px;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
[${DATA_ROUTE_HOST_ATTR}] .data-source-row {
  display: flex;
  flex-direction: column;
  gap: 3px;
}
[${DATA_ROUTE_HOST_ATTR}] .data-source-head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 8px;
}
[${DATA_ROUTE_HOST_ATTR}] .data-source-label {
  font-weight: 650;
}
/* The status chip. Colour is a REDUNDANT cue — the label already says it in
   words, so the strip stays legible to a colour-blind reader and in mono. */
[${DATA_ROUTE_HOST_ATTR}] .data-source-status {
  padding: 1px 7px;
  border-radius: 999px;
  border: 1px solid var(--border-strong);
  font-size: 11px;
  font-weight: 650;
  text-transform: uppercase;
  letter-spacing: 0.03em;
}
[${DATA_ROUTE_HOST_ATTR}] .data-source-status--bad {
  border-color: var(--danger);
  color: var(--danger);
}
[${DATA_ROUTE_HOST_ATTR}] .data-source-status--warn,
[${DATA_ROUTE_HOST_ATTR}] .data-source-status--off {
  color: var(--muted);
}
[${DATA_ROUTE_HOST_ATTR}] .data-source-failures {
  list-style: none;
  margin: 2px 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 12px;
  color: var(--danger);
}
[${DATA_ROUTE_HOST_ATTR}] .data-source-detail {
  margin-top: 4px;
  font-size: 12px;
}
[${DATA_ROUTE_HOST_ATTR}] .data-source-detail summary {
  cursor: pointer;
  color: var(--muted);
}
/* The runner's failure SAMPLES, verbatim. Long and unstructured by construction —
   let it wrap and scroll rather than truncating a bug report. */
[${DATA_ROUTE_HOST_ATTR}] .data-source-error-text {
  margin: 4px 0 0;
  padding: 6px 8px;
  border-radius: 6px;
  background: var(--surface);
  border: 1px solid var(--border);
  font-family: var(--mono, ui-monospace, monospace);
  font-size: 11px;
  line-height: 1.5;
  max-height: 140px;
  overflow-y: auto;
  overflow-wrap: anywhere;
}
/* D-205 #2b — the merge scan page's live progress line. */
[${DATA_ROUTE_HOST_ATTR}] .data-scan-progress {
  padding: 8px 12px;
  margin: 0 0 16px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface-sunk);
  font-size: 13px;
  color: var(--muted);
}
[${DATA_ROUTE_HOST_ATTR}] .data-row-title {
  font-size: 14px;
  font-weight: 650;
}
[${DATA_ROUTE_HOST_ATTR}] .data-row-meta,
[${DATA_ROUTE_HOST_ATTR}] .data-row-subtle {
  margin-top: 4px;
  font-size: 12px;
  color: var(--muted);
}
[${DATA_ROUTE_HOST_ATTR}] .data-pill {
  display: inline-flex;
  align-items: center;
  min-height: 20px;
  border-radius: 999px;
  background: var(--accent-subtle);
  color: var(--accent);
  padding: 1px 7px;
  font-size: 11px;
  font-weight: 650;
}
[${DATA_ROUTE_CONTACT_DIALOG_ATTR}] {
  position: fixed;
  inset: 0;
  z-index: 120;
  display: grid;
  place-items: start center;
  padding: 56px 16px 16px;
  background: rgba(24, 33, 36, .28);
}
[${DATA_ROUTE_HOST_ATTR}] .data-dialog-panel {
  width: min(560px, 100%);
  max-height: calc(100vh - 80px);
  overflow: auto;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
  box-shadow: 0 24px 48px rgba(24, 33, 36, .18);
  padding: 14px;
}
[${DATA_ROUTE_HOST_ATTR}] .data-dialog-header {
  display: flex;
  align-items: baseline;
  gap: 10px;
  margin-bottom: 10px;
}
[${DATA_ROUTE_HOST_ATTR}] .data-dialog-title {
  margin: 0;
  font-size: 16px;
  font-weight: 650;
}
[${DATA_ROUTE_HOST_ATTR}] .data-dialog-close {
  margin-left: auto;
}
[${DATA_ROUTE_HOST_ATTR}] .data-form-grid {
  display: grid;
  gap: 10px;
}
[${DATA_ROUTE_HOST_ATTR}] .data-field {
  display: grid;
  gap: 4px;
}
[${DATA_ROUTE_HOST_ATTR}] .data-label {
  font-size: 12px;
  font-weight: 650;
  color: var(--muted);
}
[${DATA_ROUTE_HOST_ATTR}] .data-error {
  margin: 4px 0 0;
  color: var(--danger);
  font-size: 12px;
}
[${DATA_ROUTE_HOST_ATTR}] .data-dialog-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  justify-content: flex-end;
  margin-top: 12px;
}
@media (max-width: 720px) {
  [${DATA_ROUTE_HOST_ATTR}] .data-header {
    display: grid;
  }
  [${DATA_ROUTE_HOST_ATTR}] .data-input {
    width: 100%;
  }
}
@media (max-width: 560px) {
  [${DATA_ROUTE_HOST_ATTR}] .data-contact-list li {
    flex-direction: column;
    align-items: stretch;
  }
  /* Two columns of label+value do not fit a phone — stack them, and let the
     label read as a caption above its value. */
  [${DATA_ROUTE_HOST_ATTR}] .data-contact-fields {
    grid-template-columns: 1fr;
    gap: 12px;
  }
  [${DATA_ROUTE_HOST_ATTR}] .data-contact-field {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
}
`;

const errMessage = (err: unknown): string =>
  humanizeRpcError(err);

const isWorkEntityTab = (tab: DataTabId): tab is WorkEntityKind =>
  (WORK_ENTITY_KINDS as readonly string[]).includes(tab);

const isMirrorTab = (tab: DataTabId): tab is MirrorDataKind =>
  (DATA_MIRROR_TABS as readonly string[]).includes(tab);

/** D-198 Slice 5 — the mirror tabs the generic collection explorer serves,
 *  mapped to their `CollectionPlatform`. For these the tab id IS the canonical
 *  collection name (except `files` → the `file` platform). Phase 1b lit up the
 *  two clean read mirrors (mail + calendar); Phase 1c adds `files` — it browses
 *  via the explorer AND keeps its D-172 upload widget + `data.file.read`
 *  download + D-192 file-source CTA as tab chrome (see the render dispatch).
 *  `crm` stays a `data.timeline` drill-down (not a `CollectionPlatform`). */
const EXPLORER_TAB_PLATFORM: Partial<Record<DataTabId, CollectionPlatform>> = {
  mail: 'mail',
  calendar: 'calendar',
  files: 'file',
  webhook: 'webhook',
};
/** The tabs the collection explorer serves — keep in sync with the keys of
 *  `EXPLORER_TAB_PLATFORM`. A type predicate (not just `boolean`) so the render
 *  dispatch can prove the non-explorer mirror fallback is `crm`-only. */
type ExplorerTabId = 'mail' | 'calendar' | 'files' | 'webhook';
const isExplorerTab = (tab: DataTabId): tab is ExplorerTabId =>
  Object.prototype.hasOwnProperty.call(EXPLORER_TAB_PLATFORM, tab);

/** D-198 Phase 2/3 — single-collection tabs (annotation / link / shared) render
 *  via the SAME explorer engine but read through a whole-collection `list` rpc
 *  (`annotation.list` / `link.list` / `shared.list`) — no instances — so they
 *  need their own load / open branch, not `EXPLORER_TAB_PLATFORM`. */
const SINGLE_COLLECTION_TABS: readonly DataSingleCollectionTabId[] = [
  ...DATA_PROVENANCE_TABS,
  'shared',
];
const isSingleCollectionTab = (tab: DataTabId): tab is DataSingleCollectionTabId =>
  (SINGLE_COLLECTION_TABS as readonly string[]).includes(tab);

/** D-198 Phase 2 — project a `CanonicalRecord`-shaped annotation / link into the
 *  `CollectionRecord` the explorer engine renders (mirrors calendar's snapshot
 *  mapping). The whole record goes into `hot_fields` — the display schema picks
 *  the primary + summary fields for the row, and the detail's raw-JSON disclosure
 *  then shows the COMPLETE provenance record (staleness stamps + origin), which
 *  is the point of a provenance browse. No body / bytes / instance — the
 *  single-collection list ships full records already. */
const annotationToExplorerRecord = (a: Annotation): CollectionRecord => ({
  record_id: a._id,
  source_id: a._id,
  received_at: a.authored_at,
  modified_at: a.event_at ?? a.authored_at,
  size_bytes: 0,
  hot_fields: { ...a },
});

const linkToExplorerRecord = (l: Link): CollectionRecord => ({
  record_id: l._id,
  source_id: l._id,
  received_at: l.created_at,
  modified_at: l.event_at ?? l.created_at,
  size_bytes: 0,
  hot_fields: { ...l },
});

/** D-198 Phase 3 — project a durable shared KV entry (`{ key, value }`, no
 *  timestamp) into the explorer's `CollectionRecord`. The `shared` display
 *  schema shows key → value; the detail raw-JSON shows the full value. The 0
 *  received_at (no timestamp) hides the "Received" meta row in compact mode. */
const sharedToExplorerRecord = (entry: SharedListEntry): CollectionRecord => ({
  record_id: entry.key,
  source_id: entry.key,
  received_at: 0,
  modified_at: 0,
  size_bytes: 0,
  hot_fields: { key: entry.key, value: entry.value },
});

const isReceivedTab = (tab: DataTabId): tab is DataReceivedTabId =>
  (DATA_RECEIVED_TABS as readonly string[]).includes(tab);

const isDataTab = (tab: string): tab is DataTabId =>
  (DATA_TABS as readonly string[]).includes(tab);

const tabLabel = (tab: DataTabId): string => {
  switch (tab) {
    case 'contact':
      return 'Contacts';
    case 'task':
      return 'Tasks';
    case 'commitment':
      return 'Commitments';
    case 'note':
      return 'Notes';
    case 'project':
      return 'Projects';
    case 'booking':
      return 'Bookings';
    case 'form_response':
      return 'Form responses';
    case 'mail':
      return 'Mail';
    case 'calendar':
      return 'Calendar';
    case 'crm':
      return 'CRM';
    case 'files':
      return 'Files';
    case 'webhook':
      return 'Webhook deliveries';
    case 'annotation':
      return 'Annotations';
    case 'link':
      return 'Links';
    case 'shared':
      return 'Shared';
  }
};

const mirrorCollection = (kind: MirrorDataKind): string => {
  switch (kind) {
    case 'mail':
      return 'mail';
    case 'calendar':
      return 'calendar';
    case 'crm':
      return 'crm';
    case 'files':
      return 'file';
  }
};

const nonEmptyString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : undefined;

const numberValue = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

const booleanValue = (value: unknown): boolean | undefined =>
  typeof value === 'boolean' ? value : undefined;

const stringArrayValue = (value: unknown): readonly string[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const out = value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return out.length > 0 ? out : [];
};

const setIfDefined = (
  target: Record<string, unknown>,
  key: string,
  value: unknown,
): void => {
  if (value !== undefined && value !== null) target[key] = value;
};

const sourceExtensionSchema = (
  source: SourceRegistration | undefined,
): SourceExtensionSchema | null => {
  const raw = source?.schema_extension_blob;
  if (raw === undefined || raw === null) return null;
  const fields = (raw as { fields?: unknown }).fields;
  if (!Array.isArray(fields)) return null;
  return raw as unknown as SourceExtensionSchema;
};

const allowEmptyRefArrays = (definition: FormDefinition): FormDefinition => ({
  kind: definition.kind,
  fields: definition.fields.map((field) =>
    field.type === 'array' && field.item_type === 'ref'
      ? { ...field, required: false }
      : field,
  ),
});

const formDefinitionForKind = (
  kind: WorkEntityKind,
  source: SourceRegistration | undefined,
): FormDefinition => {
  const schema = getCanonicalSchema(kind);
  const extension = sourceExtensionSchema(source);
  const definition = extension === null
    ? formFromCanonicalSchema(schema)
    : formFromCanonicalSchemaWithExtension(schema, extension);
  return allowEmptyRefArrays(definition);
};

const initialValuesForKind = (kind: WorkEntityKind): Record<string, unknown> => {
  const schema = getCanonicalSchema(kind);
  const out: Record<string, unknown> = {};
  for (const field of schema.fields) {
    if (field.default !== undefined) out[field.name] = field.default;
  }
  for (const rel of schema.relationships) {
    if (rel.cardinality === 'many') out[rel.name] = [];
  }
  if (kind === 'commitment') {
    out.direction = out.direction ?? 'outbound';
    out.derivation = out.derivation ?? 'user_declared';
    out.expiry_policy = out.expiry_policy ?? 'escalate_overdue';
  }
  if (kind === 'project') {
    out.state = out.state ?? 'active';
  }
  if (kind === 'task') {
    out.done = out.done ?? false;
  }
  if (kind === 'booking') {
    // 'confirmed', NOT BOOKING_LIFECYCLE_STATES[0] — the dialog must not open
    // on `pending`, which nothing in Recued ever writes.
    out.lifecycle_state = out.lifecycle_state ?? BOOKING_DEFAULT_LIFECYCLE_STATE;
  }
  return out;
};

const validationMap = (
  errors: readonly FieldValidationError[],
): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const error of errors) out[error.field] = error.message;
  return out;
};

const enabledSourcesForKind = (
  sources: readonly SourceRegistration[],
  kind: WorkEntityKind,
): readonly SourceRegistration[] =>
  sources.filter((source) =>
    source.top_tier_kind === kind && source.enabled !== false,
  );

const sourceOptionsForKind = (
  sources: readonly SourceRegistration[],
  kind: WorkEntityKind,
): readonly SourceDropdownOption[] =>
  buildSourceDropdownOptions(kind, enabledSourcesForKind(sources, kind));

const joinRowsWithSources = (
  entities: readonly WorkEntity[],
  sourceOptions: readonly SourceDropdownOption[],
): readonly WorkEntityListRow[] => {
  const byId = new Map(sourceOptions.map((source) => [source.id, source]));
  return entities.map((entity) => {
    const source = byId.get(entity.source_id) ?? {
      id: entity.source_id,
      label: entity.source_id,
      source_kind: 'adapter' as const,
      write_capable: false,
      mcp_exposed: false,
    };
    return { entity, source };
  });
};

const maybeAddMonetaryValue = (
  out: Record<string, unknown>,
  values: Record<string, unknown>,
): void => {
  const amount = nonEmptyString(values.monetary_amount);
  const currency = nonEmptyString(values.monetary_currency);
  if (amount !== undefined && currency !== undefined) {
    out.monetary_value = { amount, currency };
  }
};

const shouldPersistSourceExtensionValue = (value: unknown): boolean => {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
};

const sourceExtensionBlobFromValues = (
  definition: FormDefinition,
  values: Record<string, unknown>,
): Record<string, unknown> | undefined => {
  const out: Record<string, unknown> = {};
  for (const field of definition.fields) {
    if (field.origin !== 'extension') continue;
    const value = values[field.name];
    if (shouldPersistSourceExtensionValue(value)) out[field.name] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
};

const sourceExtensionValuesFromEntity = (
  definition: FormDefinition,
  entity: WorkEntity,
): Record<string, unknown> => {
  const blob = entity.source_extension_blob;
  if (blob === undefined) return {};
  const out: Record<string, unknown> = {};
  for (const field of definition.fields) {
    if (field.origin !== 'extension') continue;
    if (blob[field.name] !== undefined) out[field.name] = blob[field.name];
  }
  return out;
};

const projectWorkEntityUpsert = (
  kind: WorkEntityKind,
  state: WorkEntityPageState,
  definition: FormDefinition,
): WorkEntityUpsertRpcRequest => {
  if (state.dialog === null) {
    throw new Error('No work entity dialog is open.');
  }
  const values = state.dialog.values;
  const update = state.dialog.mode === 'edit';
  const out: Record<string, unknown> = { kind };
  if (update) {
    out.id = state.dialog.entity_id;
  } else {
    out.source_id = state.dialog.source_id;
  }

  switch (kind) {
    case 'task':
      setIfDefined(out, 'title', nonEmptyString(values.title));
      setIfDefined(out, 'body', nonEmptyString(values.body));
      setIfDefined(out, 'due_at', numberValue(values.due_at));
      setIfDefined(out, 'priority', nonEmptyString(values.priority));
      if (!update) {
        setIfDefined(out, 'done', booleanValue(values.done));
        setIfDefined(out, 'completed_at', numberValue(values.completed_at));
      }
      setIfDefined(out, 'assigned_contact_id', nonEmptyString(values.assigned_contact));
      setIfDefined(out, 'parent_calendar_event_id', nonEmptyString(values.parent_calendar_event));
      setIfDefined(out, 'linked_mail_thread_id', nonEmptyString(values.linked_mail_thread));
      setIfDefined(out, 'parent_project_id', nonEmptyString(values.parent_project));
      setIfDefined(out, 'blocks_task_ids', stringArrayValue(values.blocks_task));
      break;
    case 'note':
      setIfDefined(out, 'body', nonEmptyString(values.body));
      setIfDefined(out, 'title', nonEmptyString(values.title));
      setIfDefined(out, 'related_contact_ids', stringArrayValue(values.related_contact));
      setIfDefined(out, 'related_calendar_event_ids', stringArrayValue(values.related_calendar_event));
      setIfDefined(out, 'related_mail_thread_ids', stringArrayValue(values.related_mail_thread));
      setIfDefined(out, 'related_project_ids', stringArrayValue(values.related_project));
      break;
    case 'commitment':
      if (!update) {
        setIfDefined(out, 'direction', nonEmptyString(values.direction));
        setIfDefined(out, 'derivation', nonEmptyString(values.derivation));
        setIfDefined(out, 'promised_at', numberValue(values.promised_at));
      }
      setIfDefined(out, 'statement', nonEmptyString(values.statement));
      setIfDefined(out, 'promised_for_at', numberValue(values.promised_for_at));
      setIfDefined(out, 'expiry_policy', nonEmptyString(values.expiry_policy));
      setIfDefined(out, 'derivation_confidence', numberValue(values.derivation_confidence));
      maybeAddMonetaryValue(out, values);
      setIfDefined(out, 'counterparty_contact_id', nonEmptyString(values.counterparty_contact));
      setIfDefined(out, 'derived_from_mail_thread_id', nonEmptyString(values.derived_from_mail_thread));
      setIfDefined(out, 'derived_from_meeting_id', nonEmptyString(values.derived_from_meeting));
      setIfDefined(out, 'blocks_task_ids', stringArrayValue(values.blocks_task));
      setIfDefined(out, 'blocks_project_ids', stringArrayValue(values.blocks_project));
      break;
    case 'project':
      setIfDefined(out, 'title', nonEmptyString(values.title));
      setIfDefined(out, 'description', nonEmptyString(values.description));
      setIfDefined(out, 'state', nonEmptyString(values.state));
      setIfDefined(out, 'target_completion_at', numberValue(values.target_completion_at));
      setIfDefined(out, 'related_contact_ids', stringArrayValue(values.related_contacts));
      setIfDefined(out, 'parent_project_id', nonEmptyString(values.parent_project));
      break;
    // ⚠ This switch is `break`-style and the function ends in
    // `as unknown as WorkEntityUpsertRpcRequest` — a missing arm submits a
    // record with NO kind-specific fields and tsc says nothing.
    // `reception_record_id` is write-once provenance the dialog must never
    // author, so it stays absent here on purpose.
    //
    // D-210 A.2 — the slot IS a dialog field now: the booking owns its own
    // time, so this is where the owner edits it (including for a phone
    // booking they mint by hand). Both keys are forwarded whenever either
    // is present — `booking-update` refuses a half-supplied pair rather
    // than half-applying it, so a partial edit must reach the server as a
    // partial edit and be REFUSED, not be silently completed here from the
    // stale value the dialog happens to be holding.
    case 'booking':
      setIfDefined(out, 'title', nonEmptyString(values.title));
      setIfDefined(out, 'lifecycle_state', nonEmptyString(values.lifecycle_state));
      setIfDefined(out, 'slot_start_at', numberValue(values.slot_start_at));
      setIfDefined(out, 'slot_end_at', numberValue(values.slot_end_at));
      maybeAddMonetaryValue(out, values);
      setIfDefined(out, 'counterparty_contact_id', nonEmptyString(values.counterparty_contact));
      break;
  }
  setIfDefined(out, 'source_extension_blob', sourceExtensionBlobFromValues(definition, values));
  return out as unknown as WorkEntityUpsertRpcRequest;
};

const contactValuesFromRecord = (contact: ContactRecord): ContactDialogValues => ({
  email: contact.email,
  name: contact.name ?? '',
  phone: contact.phone ?? '',
  company: contact.company ?? '',
});

const emptyContactValues = (): ContactDialogValues => ({
  email: '',
  name: '',
  phone: '',
  company: '',
});

const validateContactDialog = (
  values: ContactDialogValues,
): Partial<Record<keyof ContactDialogValues, string>> => {
  const errors: Partial<Record<keyof ContactDialogValues, string>> = {};
  const email = values.email.trim();
  if (email.length === 0) {
    errors.email = 'Email is required.';
  } else if (!email.includes('@')) {
    errors.email = 'Email must include @.';
  }
  return errors;
};

const hasContactErrors = (
  errors: Partial<Record<keyof ContactDialogValues, string>>,
): boolean => Object.keys(errors).length > 0;

const contactUpsertArgs = (
  values: ContactDialogValues,
): Parameters<DataContactUpsertCaller>[0] => {
  const out: Parameters<DataContactUpsertCaller>[0] = {
    email: values.email.trim(),
  };
  const name = nonEmptyString(values.name);
  const phone = nonEmptyString(values.phone);
  const company = nonEmptyString(values.company);
  if (name !== undefined) out.name = name;
  if (phone !== undefined) out.phone = phone;
  if (company !== undefined) out.company = company;
  return out;
};

const contactLabel = (contact: ContactRecord): string =>
  contact.name?.trim() || contact.email;

// Human-readable label for a contact's discovery origin. The raw `ContactSource`
// enum (`email_from` / `calendar_attendee` / …) read as cryptic tokens in the
// row AND collided with the first-class "Source" concept (a `SourceRegistration`
// — where work entities sync from) used everywhere else in #data. These describe
// HOW Recued first saw the contact, not a sync Source. Falls back to the raw
// value so a future enum member degrades to something rather than nothing.
const CONTACT_SOURCE_LABELS: Record<ContactSource, string> = {
  email_from: 'Inbound email',
  email_to: 'Outbound email',
  calendar_attendee: 'Calendar',
  // D-205 #4 — imported from the user's own contact book (Google People / MS
  // Graph / CardDAV). "Imported" reads as the ACT; the Sources strip on this same
  // page already names WHICH book, so repeating the vendor here would be noise.
  contact_book: 'Imported',
  // D-205 #5 — the user PULLED this person out of a connected CRM. Distinct from
  // `contact_book` on purpose: a contact book imported them because they were in it,
  // and the user reached into the CRM and chose THIS person out of ten thousand.
  crm_import: 'Added from CRM',
  manual: 'Added manually',
};
const contactSourceLabel = (source: ContactSource): string =>
  CONTACT_SOURCE_LABELS[source] ?? source;

/** Leading glyph for a contact row — the first letter of the display
 *  label (or email), uppercased. Pure presentation; `aria-hidden`. */
const contactInitial = (contact: ContactRecord): string => {
  const ch = (contactLabel(contact).trim()[0] ?? '?').toUpperCase();
  return /[A-Z0-9]/.test(ch) ? ch : '@';
};

const summarizePayload = (payload: unknown): string => {
  if (payload === null || payload === undefined) return '';
  if (typeof payload === 'string') return payload;
  if (typeof payload === 'number' || typeof payload === 'boolean') {
    return String(payload);
  }
  try {
    const json = JSON.stringify(payload);
    return json.length > 180 ? `${json.slice(0, 179)}...` : json;
  } catch {
    return String(payload);
  }
};

const runIdFromTimelinePayload = (payload: unknown): string | null => {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return null;
  }
  const record = payload as Record<string, unknown>;
  const runId = record.run_id ?? record.recipe_run_id;
  return typeof runId === 'string' && runId.length > 0 ? runId : null;
};

const runHref = (run_id: string): string =>
  serializeShellRoute('logs', run_id);

const renderTabButton = (tab: DataTabId, active: DataTabId): string => `
  <button
    type="button"
    class="data-tab"
    role="tab"
    ${DATA_ROUTE_TAB_ATTR}="${e(tab)}"
    ${DATA_ROUTE_ACTION_ATTR}="select-tab"
    ${DATA_ROUTE_TAB_ID_ATTR}="${e(tab)}"
    aria-selected="${tab === active ? 'true' : 'false'}"
    ${tab === active ? 'data-active="true"' : ''}
  >${e(tabLabel(tab))}</button>
`;

// R18 — one labelled tab cluster (Owned = editable lists · Connected = read-only
// search index). The two groups make the LIST's nature legible at a glance.
const renderTabGroup = (
  label: string,
  tabs: readonly DataTabId[],
  active: DataTabId,
): string => `
  <div class="data-tab-group">
    <span class="data-tab-group-label">${e(label)}</span>
    <div class="data-tabs" role="tablist" aria-label="${e(label)} collections">
      ${tabs.map((tab) => renderTabButton(tab, active)).join('')}
    </div>
  </div>
`;

const renderTabs = (active: DataTabId): string => `
  <div class="data-tab-groups">
    ${renderTabGroup('Owned', DATA_OWN_IT_TABS, active)}
    ${renderTabGroup('Received', DATA_RECEIVED_CLUSTER, active)}
    ${renderTabGroup('Connected', DATA_MIRROR_TABS, active)}
    ${renderTabGroup('Provenance', DATA_PROVENANCE_TABS, active)}
    ${renderTabGroup('Storage', DATA_SHARED_TABS, active)}
  </div>
`;

const renderErrors = (errors: DataLoadErrors): string =>
  Object.entries(errors).filter((entry): entry is [string, string] =>
    typeof entry[1] === 'string' && entry[1].length > 0,
  ).map(([key, message]) => `
    <p ${DATA_ROUTE_SOURCE_ERROR_ATTR}="${e(key)}" role="alert">${e(message)}</p>
  `).join('');

const renderContactDialog = (dialog: ContactDialogState | null): string => {
  if (dialog === null) return '';
  const title = dialog.mode === 'create' ? 'New contact' : 'Edit contact';
  const error = (key: keyof ContactDialogValues): string =>
    dialog.errors[key] !== undefined
      ? `<p class="data-error" role="alert">${e(dialog.errors[key])}</p>`
      : '';
  const submitError =
    dialog.submit_error !== null
      ? `<p class="data-error" role="alert">${e(dialog.submit_error)}</p>`
      : '';
  return `
    <div ${DATA_ROUTE_CONTACT_DIALOG_ATTR}="${e(dialog.mode)}">
      <section class="data-dialog-panel" role="dialog" aria-modal="true" aria-label="${e(title)}">
        <header class="data-dialog-header">
          <h2 class="data-dialog-title">${e(title)}</h2>
          <button type="button" class="data-button data-dialog-close"
            ${DATA_ROUTE_ACTION_ATTR}="close-contact-dialog">Close</button>
        </header>
        <div class="data-form-grid">
          ${renderContactField('email', 'Email', dialog.values.email, dialog.mode === 'edit', error('email'))}
          ${renderContactField('name', 'Name', dialog.values.name, false, error('name'))}
          ${renderContactField('phone', 'Phone', dialog.values.phone, false, error('phone'))}
          ${renderContactField('company', 'Company', dialog.values.company, false, error('company'))}
        </div>
        ${submitError}
        <footer class="data-dialog-actions">
          <button type="button" class="data-button"
            ${DATA_ROUTE_ACTION_ATTR}="close-contact-dialog">Cancel</button>
          <button type="button" class="data-button data-button--primary"
            ${DATA_ROUTE_ACTION_ATTR}="submit-contact-dialog"
            ${dialog.submitting ? 'disabled' : ''}>${dialog.submitting ? 'Saving...' : 'Save'}</button>
        </footer>
      </section>
    </div>
  `;
};

const renderContactField = (
  key: keyof ContactDialogValues,
  label: string,
  value: string,
  readOnly: boolean,
  error: string,
): string => `
  <label class="data-field">
    <span class="data-label">${e(label)}</span>
    <input
      class="data-input"
      type="text"
      value="${e(value)}"
      ${DATA_ROUTE_CONTACT_FIELD_ATTR}="${e(key)}"
      ${readOnly ? 'readonly' : ''}
    />
    ${error}
  </label>
`;

// ── D-205 #2 — the contact detail page ────────────────────────────────────
//
// The ONLY surface in the product where D-192 C-2's contribution ladder is
// visible. Every other contact view shows a projected VALUE; this one shows
// where that value came from, per field.

/** Vendor slug → the name a human recognizes.
 *
 *  ⚠ This is the FOURTH copy of this map in the repo (`connections/
 *  engagement-health.ts`, `connections/page.ts`, `contacts/
 *  upstream-merge-failure-banner.ts`), and all of them are module-private, so
 *  there is nothing to import. The overrides exist only because a slug titlecases
 *  wrong ("Hubspot"); `engagement-health.ts` already ledgers the fuller fix —
 *  thread the vendor registry's real `display_name` down — as a prop-threading
 *  change it declined to make. Same floor here, same reason, and the same
 *  titlecase fallback so `zoho-crm` reads "Zoho Crm" rather than "Zoho-crm".
 *  When someone lifts this into a shared helper, this is the fourth caller. */
// Only the slugs the titlecase fallback gets WRONG need a seat here —
// `salesforce` / `pipedrive` / `google` already titlecase correctly.
const CONTACT_VENDOR_LABELS: Readonly<Record<string, string>> = {
  hubspot: 'HubSpot',
  carddav: 'CardDAV',
};

const vendorLabel = (vendor: string): string => {
  const known = CONTACT_VENDOR_LABELS[vendor];
  if (known !== undefined) return known;
  const titlecased = vendor
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
  return titlecased.length > 0 ? titlecased : vendor;
};

/** `source_id` → the "who" behind a winning contribution, or null when we do not
 *  honestly know one.
 *
 *  The id is `CONNECTION_SOURCE_ID(vendor, connection_name, kind)` —
 *  `hubspot.work.contact` — so it carries the connection NAME as well as the
 *  vendor, and that matters: two HubSpot portals (or two Google accounts) are two
 *  Sources with independent record-id spaces. Collapsing both to "HubSpot" would
 *  re-introduce the vendor-is-not-an-identity confusion that the
 *  `(contact_id, kind, source_id)` contribution key exists to prevent.
 *
 *  Returns null for Recued's own two internal writers (they are not "sources" a
 *  user would recognize) and for anything unparseable, so the caller falls back
 *  to describing the RUNG rather than naming a source that is not one. */
const provenanceWho = (source_id: string | undefined): string | null => {
  if (source_id === undefined) return null;
  const id = source_id.trim();
  if (id.length === 0) return null;
  if (id === CONTACT_SOURCE_ID_MANUAL || id === CONTACT_SOURCE_ID_DERIVED) return null;
  const [vendor, connection] = id.split('.');
  if (vendor === undefined || vendor.length === 0) return null;
  const label = vendorLabel(vendor);
  return connection !== undefined && connection.length > 0
    ? `${label} (${connection})`
    : label;
};

/** Anything that carries a ladder rung + (maybe) the instance that asserted it: a
 *  materialized `ContactFieldProvenance` (the WINNER, on the contact row) or a raw
 *  `ContactContributionView` (any source's row, from D-205 item 3). One describer for
 *  both, so a source is never worded two different ways depending on whether it won.
 *
 *  ⚠ `source` is a bare `string`, not the closed rung union — deliberately, and the
 *  compiler forced the question. `ContactContribution.source` is open: a persisted
 *  row (or a pack-declared Source) can carry a rung THIS BUILD HAS NEVER HEARD OF.
 *  `describeProvenance`'s `default:` branch was written for precisely that and says
 *  the raw value rather than dropping the row. Safe to widen here because nothing
 *  below does a `Record<Rung, …>` lookup on it — a switch with a default degrades
 *  gracefully where a record lookup would silently return `undefined`.
 *  [[feedback_widening_a_union_disarms_record_exhaustiveness]] */
interface ContactProvenanceLike {
  readonly source: string;
  readonly source_id?: string;
}

/** One field's provenance as a human sentence fragment.
 *
 *  ⚠ This must never NAME a source it was not given. `source_id` is optional
 *  precisely because a row may predate any importer and carry no recorded instance —
 *  "we don't know who" is then the truth, and a plausible-looking guess would be
 *  worse than silence, because this line renders as FACT. So whenever
 *  `provenanceWho` comes back null, the RUNG alone drives the copy: it says how much
 *  to trust the value without inventing an author for it. */
const describeProvenance = (p: ContactProvenanceLike): string => {
  const who = provenanceWho(p.source_id);
  switch (p.source) {
    case 'manual':
      return 'you typed this';
    case 'user_confirmed':
      return who !== null ? `you confirmed this, from ${who}` : 'you confirmed this';
    case 'vendor_meta':
      return who !== null ? `from ${who}` : 'from a connected CRM';
    case 'contact_book':
      return who !== null ? `from ${who}` : 'from a contact book';
    case 'derived':
      return 'derived from your mail and calendar';
    case 'ai_inferred':
      return who !== null ? `inferred by AI, from ${who}` : 'inferred by AI';
    case 'domain_inferred':
      return 'guessed from the email domain';
    default:
      // A rung this build has never heard of. Say the raw value rather than
      // dropping the row — an unknown provenance is still provenance.
      return who !== null ? `from ${who}` : String(p.source);
  }
};

const formatMailingAddress = (addr: MailingAddress): string =>
  [addr.address1, addr.address2, addr.city, addr.state, addr.zip, addr.country]
    .map((part) => (part ?? '').trim())
    .filter((part) => part.length > 0)
    .join(', ');

interface ContactDetailField {
  /** The provenance-map key — see the mapping note in `contactDetailFields`. */
  readonly key: string;
  readonly label: string;
  readonly value: string;
}

/** Project a contact into the ordered field rows the detail page renders.
 *
 *  ⚠ **The provenance map is keyed by the CONTRIBUTION KIND, not by the
 *  `ContactRecord` column name — and two of them differ.** The column `company`
 *  is asserted as the kind `org`; the column `mailing_address` is asserted as the
 *  kind `address`. Looking the map up by column name yields `undefined` for
 *  exactly those two, so a field that HAS provenance would render as if it had
 *  none — the silent-miss failure, on the one page whose whole job is provenance.
 *  The pairing is therefore a table, not an assumption. */
const contactDetailFields = (contact: ContactRecord): ContactDetailField[] => {
  const rows: ContactDetailField[] = [];
  const push = (key: string, label: string, value: string | undefined): void => {
    const trimmed = (value ?? '').trim();
    if (trimmed.length > 0) rows.push({ key, label, value: trimmed });
  };
  push('name', 'Name', contact.name);
  push('org', 'Company', contact.company);
  push('title', 'Title', contact.title);
  push('phone', 'Phone', contact.phone);
  push(
    'address',
    'Address',
    contact.mailing_address !== undefined
      ? formatMailingAddress(contact.mailing_address)
      : undefined,
  );
  push('birthday', 'Birthday', contact.birthday);
  // ⛔ `photo` is a remote URL as the VENDOR supplied it, and it renders as TEXT
  // on purpose. Do NOT "improve" this into an <img src={photo}> — D-192 C-2's
  // North star is that avatar bytes are NEVER fetched, and an <img> would beacon
  // the vendor's URL from the user's browser on every page view, leaking that
  // they opened this contact and when. A future slice can serve the bytes through
  // the file-family `storage_ref:{kind:'remote'}` seam; until then, the URL is
  // the honest thing to show.
  push('photo', 'Photo', contact.photo);
  return rows;
};

/** Render one contribution's value for the per-source list. The store holds an
 *  `address` as a structured object and everything else as a scalar, so this is the
 *  read-side twin of `contactDetailFields`' formatting.
 *
 *  A shape it cannot render returns `null` and the row is DROPPED rather than
 *  stringified into `"[object Object]"` — the same call the materializer makes when
 *  its shape guard fires. A garbage value looks like data. */
const contributionValueText = (value: unknown): string | null => {
  if (typeof value === 'string') return value.trim() || null;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value !== null && typeof value === 'object') {
    const rendered = formatMailingAddress(value as MailingAddress).trim();
    return rendered.length > 0 ? rendered : null;
  }
  return null;
};

/** D-205 merge-review item 3 — the LOSING contributions for one field.
 *
 *  The projection keeps one value per field, so the detail page could show WHAT
 *  Recued holds and (since #2a) WHO said so — but never what the other sources said,
 *  nor why they lost. The ladder was legible only in its outcome. This is the input.
 *
 *  ⛔ **The winner is never recomputed here.** `contribution.winner` was stamped by
 *  the server with the same resolver the projection runs; a client-side ladder is the
 *  exact bug merge-review item 1 fixed. This function only FILTERS on that flag.
 *
 *  Renders nothing when there is nothing to say (one source, or none) — an
 *  "other sources" heading over an empty list would imply Recued looked and found
 *  disagreement where there is none. */
const renderContactFieldOtherSources = (
  rows: readonly ContactContributionView[],
): string => {
  const losers = rows.filter((row) => !row.winner);
  if (losers.length === 0) return '';
  const items = losers
    .map((row) => {
      const text = contributionValueText(row.value);
      if (text === null) return '';
      // `describeProvenance` takes the SAME (source, source_id) pair — reused, not
      // re-worded, so a contribution and a winner never describe the same source
      // with two different sentences. It also already refuses to name a source it
      // was not given.
      return `
        <li class="data-contact-alt-source" data-alt-source="${e(row.source)}">
          <span class="data-contact-alt-value">${e(text)}</span>
          <span class="data-contact-origin">${e(describeProvenance(row))}</span>
        </li>
      `;
    })
    .join('');
  if (items.trim() === '') return '';
  return `
    <ul class="data-contact-alt-sources" role="list">
      ${items}
    </ul>
  `;
};

const renderContactProvenanceBlock = (
  contact: ContactRecord,
  contributions: readonly ContactContributionView[],
  contributionsFailed: boolean,
): string => {
  const fields = contactDetailFields(contact);
  const provenance = contact.projection_provenance;
  if (fields.length === 0) {
    return `<p ${DATA_ROUTE_UNAVAILABLE_ATTR}>Recued knows this address, but nothing else about the person yet. Connect a CRM or a contact book and their details fill in here.</p>`;
  }
  // ⚠ Keyed by CONTRIBUTION KIND, exactly like `projection_provenance` — and
  // `ContactDetailField.key` is already the kind (`org`, `address`), not the column.
  // That pairing is the whole reason `contactDetailFields` uses a table.
  const byKind = new Map<string, ContactContributionView[]>();
  for (const row of contributions) {
    const bucket = byKind.get(row.kind);
    if (bucket === undefined) byKind.set(row.kind, [row]);
    else bucket.push(row);
  }
  // A FAILED fetch must not read as "no other source has an opinion" — that is a
  // claim about the user's data, and it is the one this block would silently make.
  const failure = contributionsFailed
    ? `<p class="data-contact-alt-error" ${DATA_ROUTE_UNAVAILABLE_ATTR}>Recued could not load what your other sources say about these fields, so only the value it kept is shown.</p>`
    : '';
  return `
    <dl class="data-contact-fields" ${DATA_ROUTE_CONTACT_PROVENANCE_ATTR}="${e(contact.email)}">
      ${fields.map((field) => {
        const p = provenance?.[field.key];
        // A field with no contribution behind it is NOT the same as one with an
        // empty contribution — say nothing rather than guess.
        const origin = p !== undefined
          ? `<span class="data-contact-origin" data-provenance-source="${e(p.source)}">${e(describeProvenance(p))}</span>`
          : '';
        const others = renderContactFieldOtherSources(byKind.get(field.key) ?? []);
        return `
          <div class="data-contact-field" data-provenance-field="${e(field.key)}">
            <dt class="data-label">${e(field.label)}</dt>
            <dd class="data-contact-value">
              <span class="data-contact-value-text">${e(field.value)}</span>
              ${origin}
              ${others}
            </dd>
          </div>
        `;
      }).join('')}
    </dl>
    ${failure}
  `;
};

/** The confirmed platform-record links. Spec §3: rendering this resolves the
 *  gate-crossing edge — it asserts "this HubSpot record IS your contact Bob". */
const renderContactLinks = (links: readonly PlatformIdEntry[]): string => {
  if (links.length === 0) return '';
  return `
    <section class="data-contact-links" ${DATA_ROUTE_CONTACT_LINKS_ATTR}>
      <h3 class="data-subsection-title">Linked records</h3>
      <ul class="data-contact-link-list" role="list">
        ${links.map((link) => `
          <li class="data-contact-link" data-link-vendor="${e(link.vendor)}">
            <span class="data-contact-link-vendor">${e(vendorLabel(link.vendor))}</span>
            <code class="data-contact-link-id">${e(link.platform_id)}</code>
            <span class="data-row-subtle">${link.state === 'confirmed' ? 'confirmed by you' : 'linked automatically'}</span>
          </li>
        `).join('')}
      </ul>
    </section>
  `;
};

/** D-205 #2 — the contact detail (`#data/contact/<email>`): identity, the
 *  per-field provenance block, the platform links, then the activity timeline. */
const renderContactDetailView = (
  state: ContactDetailState,
  loading: boolean,
  now: number,
): string => {
  const contact = state.contact;
  const heading = contact !== null ? contactLabel(contact) : state.email;
  // A tombstone must never render as a live contact — `resolveContactIdentity`
  // follows `merged_into` to the survivor, and so must the human reading this.
  const mergedBanner = contact?.merged_into !== undefined
    ? `<p class="data-contact-merged" role="status">This contact was merged into
        <a href="${e(serializeShellRoute('data', 'contact', contact.merged_into))}">${e(contact.merged_into)}</a>.
        Its details now live there.</p>`
    : '';
  const identity = contact === null
    ? loading
      ? '<p class="data-loading">Loading contact...</p>'
      : `<p ${DATA_ROUTE_UNAVAILABLE_ATTR}>No contact record found for this address.</p>`
    : `
      ${mergedBanner}
      ${renderContactProvenanceBlock(contact, state.contributions, state.contributions_failed)}
      ${renderContactLinks(contact.platform_ids ?? [])}
    `;
  const timeline = loading
    ? '<p class="data-loading">Loading timeline...</p>'
    : state.response === null
      ? `<p ${DATA_ROUTE_UNAVAILABLE_ATTR}>No timeline available for this contact yet.</p>`
      : renderEntityDetailPanel(
          deriveEntityDetailProps(state.response, 'contact', state.email, now),
        );
  return `
    <section ${DATA_ROUTE_CONTACT_DETAIL_ATTR}="${e(state.email)}">
      <div class="data-contact-toolbar">
        <button type="button" class="data-button"
          ${DATA_ROUTE_ACTION_ATTR}="close-contact-detail">← Back to contacts</button>
        <button type="button" class="data-button"
          ${DATA_ROUTE_ACTION_ATTR}="open-edit-contact"
          ${DATA_ROUTE_CONTACT_EMAIL_ATTR}="${e(state.email)}">Edit</button>
      </div>
      <header class="data-contact-detail-header">
        <span class="data-contact-avatar data-contact-avatar--lg" aria-hidden="true">${e(
          contact !== null ? contactInitial(contact) : '@',
        )}</span>
        <span class="data-contact-detail-heading">
          <h2 class="data-section-title">${e(heading)}</h2>
          <span class="data-row-meta">${e(state.email)}</span>
          ${contact !== null
            ? `<span class="data-row-subtle">${e(contactSourceLabel(contact.source))} · ${e(String(contact.interaction_count))} interactions</span>`
            : ''}
        </span>
      </header>
      ${identity}
      <h3 class="data-subsection-title">Activity</h3>
      ${timeline}
    </section>
  `;
};

// Shared "N of M loaded" + Load more footer for the paginated lists (contacts +
// work entities). Empty when everything's loaded (`loaded >= total`). "loaded"
// (not "showing") is honest for the work-entity list too, whose client-side
// search filters the loaded rows — so a search with few visible rows can still
// truthfully report how many of the total are loaded, and Load more brings in
// more rows to search.
const renderLoadMoreFooter = (footerOpts: {
  marker: string;
  action: string;
  loaded: number;
  total: number;
  loadingMore: boolean;
}): string => {
  if (footerOpts.loaded >= footerOpts.total) return '';
  return `<div class="data-list-footer" ${footerOpts.marker}>
      <span class="data-list-count">${footerOpts.loaded} of ${footerOpts.total} loaded</span>
      <button type="button" class="data-button"
        ${DATA_ROUTE_ACTION_ATTR}="${footerOpts.action}"${footerOpts.loadingMore ? ' disabled' : ''}>
        ${footerOpts.loadingMore ? 'Loading…' : 'Load more'}</button>
    </div>`;
};

// ── D-205 #2c — the Sources health strip ──────────────────────────────────
//
// The first surface that has ever READ the contact runner's cycle counts. Since
// D-205 #1 the runner has persisted twelve counters plus an error message carrying
// its failure SAMPLES, and the only consumer that ever looked at a contact Source's
// health was `source_freshness_degradation` — which selects `(last_success_at,
// degraded)` and nothing else. So a leaf that failed EVERY record on EVERY cycle
// reported one boolean, and the diagnosis sat unread in the row beside it.

/** Relative "2h ago" for a sync timestamp. Null → "never". */
const relativeSyncTime = (at: number | null, now: number): string => {
  if (at === null) return 'never synced';
  const ms = Math.max(0, now - at);
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return 'synced just now';
  if (minutes < 60) return `synced ${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `synced ${hours}h ago`;
  return `synced ${Math.round(hours / 24)}d ago`;
};

/** The one-line summary of what a cycle DID. Deliberately reports the counters a
 *  user can act on — what came in, and what broke — not all twelve. The rest are
 *  in the expandable detail. */
const cycleSummary = (counts: ContactSourceHealth['last_cycle']): string => {
  if (counts === null) return 'no cycle has completed yet';
  const parts: string[] = [`${counts.hydrated.toLocaleString()} hydrated`];
  if (counts.linked > 0) parts.push(`${counts.linked.toLocaleString()} linked`);
  if (counts.skipped > 0) parts.push(`${counts.skipped.toLocaleString()} not matched`);
  if (counts.disconnected > 0) {
    parts.push(`${counts.disconnected.toLocaleString()} disconnected`);
  }
  return parts.join(' · ');
};

/** The 🔴 counters — the ones that mean the Source is not doing its job. Each is a
 *  distinct failure with a distinct consequence, so they are named, not summed. */
const cycleFailures = (counts: ContactSourceHealth['last_cycle']): string[] => {
  if (counts === null) return [];
  const out: string[] = [];
  if (counts.failed_rows > 0) {
    out.push(`${counts.failed_rows.toLocaleString()} records failed to import`);
  }
  if (counts.mirror_failed > 0) {
    out.push(`${counts.mirror_failed.toLocaleString()} records could not be mirrored`);
  }
  if (counts.unkeyable > 0) {
    // Worth its own line: an unkeyable record also POISONS the delete proof, so the
    // Source silently stops reconciling deletions.
    out.push(
      `${counts.unkeyable.toLocaleString()} records had no usable id (deletions paused)`,
    );
  }
  // NOT a failure, but the user should see it: a walk that could not prove it saw
  // everything disconnects nothing, by design (fail-closed).
  if (!counts.complete) {
    out.push('the last walk could not confirm it saw every record');
  }
  return out;
};

const renderContactSourceRow = (source: ContactSourceHealth, now: number): string => {
  const failures = cycleFailures(source.last_cycle);
  const status = !source.enabled
    ? { label: 'Off', tone: 'off' }
    : source.degraded
      ? { label: 'Degraded', tone: 'bad' }
      : source.stale
        ? { label: 'Stale', tone: 'warn' }
        : { label: 'OK', tone: 'ok' };
  // The raw message is long (~500 chars) and carries the runner's samples. It is
  // shown VERBATIM in a disclosure rather than re-parsed into fields: it was
  // assembled from structure the writer already flattened, so reconstructing it
  // would be a guess — and a diagnosis that guesses is worse than one that quotes.
  const detail = source.last_error_message !== null
    ? `<details class="data-source-detail">
        <summary>What went wrong</summary>
        <p class="data-source-error-text">${e(source.last_error_message)}</p>
      </details>`
    : '';
  return `
    <li class="data-source-row" data-source-id="${e(source.source_id)}"
      data-source-status="${e(status.tone)}">
      <span class="data-source-head">
        <span class="data-source-status data-source-status--${e(status.tone)}">${e(status.label)}</span>
        <span class="data-source-label">${e(source.source_label)}</span>
        <span class="data-row-subtle">${e(
          source.enabled ? relativeSyncTime(source.last_success_at, now) : 'not running',
        )}</span>
      </span>
      <span class="data-row-subtle">${e(cycleSummary(source.last_cycle))}</span>
      ${failures.length > 0
        ? `<ul class="data-source-failures" role="list">
            ${failures.map((f) => `<li>${e(f)}</li>`).join('')}
          </ul>`
        : ''}
      ${detail}
    </li>
  `;
};

const renderContactSourcesStrip = (
  sources: readonly ContactSourceHealth[],
  now: number,
): string => {
  // No contact Sources enrolled is not a problem to report — it is the default
  // state, and the list's own empty-state already points at Connections.
  if (sources.length === 0) return '';
  const unhealthy = sources.filter((s) => s.enabled && (s.degraded || s.stale)).length;
  return `
    <details class="data-sources-strip" ${DATA_ROUTE_CONTACT_SOURCES_ATTR}
      ${unhealthy > 0 ? 'open' : ''}>
      <summary class="data-sources-summary">
        Contact sources
        <span class="data-row-subtle">${e(
          unhealthy > 0
            ? `${unhealthy} of ${sources.length} need attention`
            : `${sources.length} healthy`,
        )}</span>
      </summary>
      <ul class="data-source-list" role="list">
        ${sources.map((s) => renderContactSourceRow(s, now)).join('')}
      </ul>
    </details>
  `;
};

// ── D-205 #5b — the import page (`#data/contact/import`) ──────────────────
//
//  The answer to the cold-start cliff, and the surface that makes the two import
//  POSTURES legible instead of mysterious:
//
//    - a CONTACT BOOK is `full_import`. It is YOUR list; every entry is someone you
//      chose to keep, so Recued imports all of them. There is nothing to decide, and
//      this page says so rather than offering a picker that would do nothing.
//    - a CRM is `hydrate_on_match`. It is your COMPANY's list — 10k rows, mostly
//      people you have never met — so it only ever ENRICHES someone you already
//      know. On an empty graph that mints ZERO contacts, and `#data/contact` sits
//      empty after you connected a CRM with ten thousand records in it. Correct, and
//      it reads as broken. **This page is where that stops being a mystery.**
//
//  ⚠ The candidates are STRANGERS. They are not contacts and must never render as
//  though they were — no avatar, no timeline, no "open". The whole point of the
//  surface is that Recued has no relationship with these people yet, and the user is
//  the one who decides which of them it should.

interface ContactImportState {
  /** The Source being browsed. Null = the overview (every Source + its posture). */
  source_id: string | null;
  query: string;
  candidates: readonly ContactImportCandidate[];
  /** Strangers matching the query. */
  total: number;
  /** Every record this Source mirrors, matched or not. `(total, mirrored)` is the
   *  pair that makes the cliff legible. */
  mirrored: number;
  /** `target_id`s the user has ticked. */
  selected: ReadonlySet<string>;
  loading: boolean;
  promoting: boolean;
  /** The last promote's outcome, for the confirmation line. */
  result: { created: number; already_known: number; failures: readonly string[] } | null;
  /** D-205 #5c — the manual file import. `text` is held so `apply` can re-send the
   *  SAME bytes the preview was derived from. */
  file: {
    text: string;
    name: string;
    plan: ContactImportFilePlan | null;
    apply_changes: boolean;
    busy: boolean;
    result: { added: number; changed: number; skipped: number } | null;
  } | null;
}

const initialContactImportState = (): ContactImportState => ({
  source_id: null,
  query: '',
  candidates: [],
  total: 0,
  mirrored: 0,
  selected: new Set(),
  loading: false,
  promoting: false,
  result: null,
  file: null,
});

/** Is this Source a CRM (a picker applies) or a contact book (it does not)?
 *
 *  Read off the DECLARATION, never guessed from the vendor slug — the posture IS the
 *  declaration's `import_scope`, and a future `full_import` vendor must not need this
 *  file edited. */
const sourceIsPickable = (source_id: string): boolean => {
  const vendor = source_id.split('.')[0] ?? '';
  const declaration = getContactSourceDeclaration(vendor);
  return declaration !== null && declaration.import_scope === 'hydrate_on_match';
};

const renderImportOverviewRow = (s: ContactSourceHealth): string => {
  const pickable = sourceIsPickable(s.source_id);
  const cycle = s.last_cycle;
  return `
    <li class="data-source-row">
      <span class="data-source-label">${e(s.source_label)}</span>
      ${pickable
        ? `<span class="data-row-subtle">${e(
            cycle === null
              ? 'Enriches contacts you already know. Not synced yet.'
              // 🔑 THE CLIFF, IN WORDS. `hydrated` is who it enriched; `skipped` is
              // everyone else — and `skipped` is exactly the stranger count, straight
              // off the runner's own per-cycle counters. Nothing new is computed here.
              : `${cycle.hydrated} of your contacts enriched · ${cycle.skipped} ${
                  cycle.skipped === 1 ? 'person' : 'people'
                } you have not corresponded with`,
          )}</span>
          <button type="button" class="data-button"
            ${DATA_ROUTE_ACTION_ATTR}="contact-import-browse"
            ${DATA_ROUTE_IMPORT_SOURCE_ATTR}="${e(s.source_id)}">Browse &amp; add</button>`
        : `<span class="data-row-subtle">${e(
            cycle === null
              ? 'Imports everyone. Not synced yet.'
              : `${cycle.hydrated + cycle.created} contacts imported · nothing to choose`,
          )}</span>`}
    </li>
  `;
};

/** D-205 #5c — the manual vCard / CSV upload.
 *
 *  🔑 **The review is the CONFLICTS, and only the conflicts.** An upload writes at the
 *  `manual` rung — the TOP of the C-2a ladder, where nothing can ever correct it. That
 *  is right when you TYPE a value. It is a foot-gun when you upload a 2019 export you
 *  never opened, because those stale values would silently freeze the graph and your
 *  live CRM could never fix any of them.
 *
 *  So: the ADDs need no review (nothing to overwrite), agreement is a no-op, and the
 *  DISAGREEMENTS with what you can SEE today are the one thing that asks for your
 *  attention — opt-in, rendered `from → to`. */
const renderFileImportPanel = (state: ContactImportState): string => {
  const f = state.file;
  const plan = f?.plan ?? null;

  return `
  <section class="data-file-import">
    <h3 class="data-section-title">From a file</h3>
    <p class="data-row-subtle">A vCard (.vcf) or CSV export. Whatever it says becomes
      <em>your</em> value for that field — the same as typing it in.</p>
    <input type="file" class="data-input" accept=".vcf,.csv,text/vcard,text/csv"
      ${DATA_ROUTE_ACTION_ATTR}="contact-import-file-pick"
      aria-label="Choose a vCard or CSV file" />

    ${plan === null
      ? f?.busy === true
        ? `<p ${DATA_ROUTE_UNAVAILABLE_ATTR}>Reading ${e(f.name)}…</p>`
        : ''
      : `
      <p class="data-row-subtle">${e(
        `${f!.name} · ${plan.format.toUpperCase()} · ${plan.adds} new · ${
          plan.changes.length
        } change${plan.changes.length === 1 ? '' : 's'} · ${plan.unchanged} already up to date`,
      )}</p>

      ${plan.errors.length === 0
        ? ''
        // ⚠ NEVER silently dropped. A row that vanishes is a person missing from the
        // graph, and the user would have no way to know.
        : `<details class="data-file-import-errors">
             <summary>${e(`${plan.errors.length} row${plan.errors.length === 1 ? '' : 's'} could not be read`)}</summary>
             <ul role="list">${plan.errors.map((x) => `<li>${e(x)}</li>`).join('')}</ul>
           </details>`}

      ${plan.changes.length === 0
        ? ''
        : `
        <label class="data-file-import-changes-toggle">
          <input type="checkbox" ${DATA_ROUTE_ACTION_ATTR}="contact-import-file-toggle-changes"
            ${f!.apply_changes ? 'checked' : ''} />
          ${e(
            `Also change ${plan.changes.length} contact${plan.changes.length === 1 ? '' : 's'} you already have`,
          )}
        </label>
        <ul class="data-list" role="list">
          ${plan.changes
            .map(
              (c) => `
            <li class="data-row">
              <span class="data-row-title">${e(c.name)}</span>
              <span class="data-row-subtle">${e(
                c.fields
                  .map((x) => `${x.field}: ${x.from.length > 0 ? x.from : '—'} → ${x.to}`)
                  .join(' · '),
              )}</span>
            </li>`,
            )
            .join('')}
        </ul>`}

      <div class="data-contact-toolbar">
        <button type="button" class="data-button data-button--primary"
          ${DATA_ROUTE_ACTION_ATTR}="contact-import-file-apply"
          ${f!.busy || (plan.adds === 0 && !(f!.apply_changes && plan.changes.length > 0)) ? 'disabled' : ''}>
          ${e(
            f!.busy
              ? 'Importing…'
              : `Import ${plan.adds} new${
                  f!.apply_changes && plan.changes.length > 0
                    ? ` and ${plan.changes.length} change${plan.changes.length === 1 ? '' : 's'}`
                    : ''
                }`,
          )}
        </button>
        <button type="button" class="data-button"
          ${DATA_ROUTE_ACTION_ATTR}="contact-import-file-clear">Cancel</button>
      </div>`}

    ${f?.result == null
      ? ''
      : `<p class="data-row-subtle" role="status">${e(
          `${f.result.added} added · ${f.result.changed} changed${
            f.result.skipped > 0 ? ` · ${f.result.skipped} left as they were` : ''
          }`,
        )}</p>`}
  </section>`;
};

const renderContactImportView = (
  state: ContactImportState,
  sources: readonly ContactSourceHealth[],
  canUploadFile: boolean,
): string => {
  const back = `
    <button type="button" class="data-button"
      ${DATA_ROUTE_ACTION_ATTR}="${state.source_id === null ? 'close-contact-import' : 'contact-import-overview'}">
      ${state.source_id === null ? 'Back to contacts' : 'All sources'}
    </button>`;

  if (state.source_id === null) {
    return `
    <section ${DATA_ROUTE_CONTACT_IMPORT_ATTR}>
      <div class="data-contact-toolbar">${back}</div>
      <h2 class="data-section-title">Import contacts</h2>
      ${sources.length === 0
        ? `<p ${DATA_ROUTE_UNAVAILABLE_ATTR}>No contact sources are connected yet. Connect one in Settings → Connections.</p>`
        : `<ul class="data-source-list" role="list">
             ${sources.map(renderImportOverviewRow).join('')}
           </ul>`}
      ${canUploadFile ? renderFileImportPanel(state) : ''}
    </section>`;
  }

  const label = sources.find((s) => s.source_id === state.source_id)?.source_label
    ?? state.source_id;
  const chosen = state.selected.size;

  return `
  <section ${DATA_ROUTE_CONTACT_IMPORT_ATTR}>
    <div class="data-contact-toolbar">${back}</div>
    <h2 class="data-section-title">Add from ${e(label)}</h2>
    <p class="data-row-subtle">${e(
      // The honest framing. These people are in your CRM; they are not in your
      // contacts, and Recued did not put them there because it has no evidence you
      // know them. You do.
      `${state.mirrored} record${state.mirrored === 1 ? '' : 's'} in this CRM · ${state.total} ${
        state.total === 1 ? 'person' : 'people'
      } you have not corresponded with`,
    )}</p>

    <div class="data-contact-toolbar">
      <input type="search" class="data-input"
        ${DATA_ROUTE_ACTION_ATTR}="contact-import-search"
        value="${e(state.query)}"
        placeholder="Search by name, email or company"
        aria-label="Search this CRM" />
      <button type="button" class="data-button data-button--primary"
        ${DATA_ROUTE_ACTION_ATTR}="contact-import-promote"
        ${chosen === 0 || state.promoting ? 'disabled' : ''}>
        ${state.promoting ? 'Adding…' : `Add ${chosen === 0 ? '' : chosen} to my contacts`}
      </button>
    </div>

    ${state.result === null
      ? ''
      : `<p class="data-row-subtle" role="status">${e(
          [
            `${state.result.created} added`,
            state.result.already_known > 0
              ? `${state.result.already_known} already in your contacts`
              : '',
            state.result.failures.length > 0
              ? `${state.result.failures.length} could not be added`
              : '',
          ]
            .filter((x) => x.length > 0)
            .join(' · '),
        )}</p>`}

    ${state.loading
      ? `<p ${DATA_ROUTE_UNAVAILABLE_ATTR}>Loading…</p>`
      : state.candidates.length === 0
        ? `<p ${DATA_ROUTE_UNAVAILABLE_ATTR}>${e(
            state.query.trim().length > 0
              ? 'Nobody in this CRM matches your search.'
              : // Not "no contacts" — the honest statement is that there is nobody
                // LEFT to add, which is a different and much better thing.
                'Everyone in this CRM is already one of your contacts.',
          )}</p>`
        : `<ul class="data-list" role="list">
             ${state.candidates
               .map(
                 (c) => `
               <li class="data-row">
                 <label class="data-row-main">
                   <input type="checkbox"
                     ${DATA_ROUTE_ACTION_ATTR}="contact-import-toggle"
                     ${DATA_ROUTE_IMPORT_TARGET_ATTR}="${e(c.target_id)}"
                     ${state.selected.has(c.target_id) ? 'checked' : ''} />
                   <span class="data-row-title">${e(c.name ?? c.email)}</span>
                   <span class="data-row-subtle">${e(
                     [c.email, c.company, c.phone].filter((x) => x !== undefined).join(' · '),
                   )}</span>
                 </label>
               </li>`,
               )
               .join('')}
           </ul>`}
  </section>`;
};

// ── D-205 #2b — the merge scan page ───────────────────────────────────────
//
// The merge substrate has existed since D-138 and has never had a caller: all 7
// `contact.merge.*` rpcs and both broadcast kinds shipped with zero webclient
// consumers, because until D-192 slice 7 no reconciler ever wrote the `contacts`
// table and the detector had nothing to detect. This page is their first.

/** Project a canonical contact into the dialog's card shape. The dialog never
 *  reaches for storage — every field is pre-projected here. */
const toMergeCard = (contact: ContactRecord): MergeReviewContactCard => {
  const card: MergeReviewContactCard = {
    email: contact.email,
    last_interaction: contact.last_interaction,
  };
  if (contact.name !== undefined) card.name = contact.name;
  if (contact.company !== undefined) card.company = contact.company;
  if (contact.phone !== undefined) card.phone = contact.phone;
  if (contact.mailing_address !== undefined) card.mailing_address = contact.mailing_address;
  if (contact.updated_at !== undefined) card.updated_at = contact.updated_at;
  // The per-field C-2a ladder provenance. Without it the dialog cannot predict
  // which value the merge will actually project and falls back to NO highlight —
  // so this line is what makes the winner highlight true rather than absent.
  // (`contact.get` carries it: a persisted column, hydrated by the store's one
  // shared `rowToRecord` mapper. Same column the detail page renders.)
  if (contact.projection_provenance !== undefined) {
    card.provenance = contact.projection_provenance;
  }
  card.source = contactSourceLabel(contact.source);
  // Carried so the dialog can render the vendor badges. It does NOT enable the
  // destructive "Also merge upstream" action — that is gated separately, on
  // whether this host declared it can service it (it has not).
  if (contact.platform_ids !== undefined) card.platform_ids = contact.platform_ids;
  return card;
};

/** Default survivor: most recent `last_interaction`, ties broken by row
 *  `updated_at`, then by the (lex-sorted) card order for stability. Spec § A.6.
 *  The user can always override — this only decides what is pre-selected. */
const pickDefaultSurvivor = (cards: readonly MergeReviewContactCard[]): string => {
  let best = cards[0];
  if (best === undefined) return '';
  for (const card of cards.slice(1)) {
    if (card.last_interaction > best.last_interaction) {
      best = card;
      continue;
    }
    if (
      card.last_interaction === best.last_interaction
      && (card.updated_at ?? 0) > (best.updated_at ?? 0)
    ) {
      best = card;
    }
  }
  return best.email;
};

/** Turn the substrate's candidate EDGES into the dialog's review CLUSTERS.
 *
 *  `contact.merge.list` returns one row per detected PAIR. A person duplicated
 *  three ways arrives as several pair rows that share emails, and the user must
 *  see them as ONE cluster — resolving them pair-by-pair is both miserable and
 *  wrong (merging A→B then B→C leaves a chain the survivor logic has to unwind).
 *  So the host walks the connected components of the candidate graph.
 *
 *  🔑 **Each item carries the SURFACED edges of its component, never the
 *  transitive closure.** A 6-card cluster with 8 detected edges must send those
 *  8 candidate ids to `contact.merge.reject`, not C(6,2)=15 — because reject
 *  writes one PERMANENT rejection row per id it is given, and the 7 extra pairs
 *  are ones the detector never proposed. Rejecting them would durably suppress
 *  merges the user never saw, let alone declined. The substrate is explicit
 *  about this (spec § A.6 / Reviewer #5); this filter is where it is honored. */
const buildMergeItems = (
  candidates: readonly ContactMergeCandidate[],
  contactsByEmail: ReadonlyMap<string, ContactRecord>,
): MergeReviewItem[] => {
  const adjacency = new Map<string, Set<string>>();
  const link = (from: string, to: string): void => {
    const peers = adjacency.get(from);
    if (peers === undefined) adjacency.set(from, new Set([to]));
    else peers.add(to);
  };
  for (const candidate of candidates) {
    link(candidate.email_a, candidate.email_b);
    link(candidate.email_b, candidate.email_a);
  }

  const seen = new Set<string>();
  const items: MergeReviewItem[] = [];
  for (const start of adjacency.keys()) {
    if (seen.has(start)) continue;
    // BFS the connected component.
    const component = new Set<string>();
    const queue: string[] = [start];
    while (queue.length > 0) {
      const email = queue.shift();
      if (email === undefined || component.has(email)) continue;
      component.add(email);
      seen.add(email);
      for (const peer of adjacency.get(email) ?? []) {
        if (!component.has(peer)) queue.push(peer);
      }
    }
    const edges = candidates.filter(
      (c) => component.has(c.email_a) && component.has(c.email_b),
    );
    const cards = [...component]
      .sort()
      .map((email) => contactsByEmail.get(email))
      .filter((c): c is ContactRecord => c !== undefined)
      .map(toMergeCard);
    // A component whose contacts we could not hydrate is not reviewable — a card
    // we cannot show is a card the user cannot judge. Drop it rather than render
    // a half-cluster whose Merge button would silently discard the missing side.
    if (cards.length < 2) continue;
    items.push({
      cards,
      candidates: edges,
      default_survivor: pickDefaultSurvivor(cards),
    });
  }
  return items;
};

/** The live "scanning…" line. Renders a bare count until the ETA helpers judge
 *  the rate trustworthy, then appends a remaining-time estimate. */
const renderScanProgress = (progress: ContactScanProgress, now: number): string => {
  const compared = progress.iterated.toLocaleString();
  const scanned = progress.total !== null
    ? `Compared ${compared} of ${progress.total.toLocaleString()} contacts`
    : `Compared ${compared} contacts`;
  const scan: ScanProgress = {
    compared: progress.iterated,
    total_iterations: progress.total ?? 0,
    samples: progress.samples,
    ms_per_iteration: progress.iterated > 0
      ? (now - progress.started_at) / progress.iterated
      : null,
  };
  const remaining = isEtaEligible(scan) ? remainingMillis(scan) : null;
  const eta = remaining !== null ? ` · ${formatRemaining(remaining)} left` : '';
  const found = progress.surfaced > 0
    ? ` · ${progress.surfaced} possible duplicate${progress.surfaced === 1 ? '' : 's'}`
    : '';
  return `
    <p class="data-scan-progress" role="status" ${DATA_ROUTE_SCAN_PROGRESS_ATTR}>
      ${e(scanned)}${e(eta)}${e(found)}
    </p>
  `;
};

const renderContactScanView = (
  state: ContactScanState,
  canScan: boolean,
  now: number,
): string => {
  const pending = state.dialog.items.length;
  const summary = state.loading
    ? '<p class="data-loading">Loading possible duplicates...</p>'
    : state.progress !== null
      ? renderScanProgress(state.progress, now)
      : state.last_scan !== null
        ? `<p class="data-scan-progress" role="status" ${DATA_ROUTE_SCAN_PROGRESS_ATTR}>Compared ${e(
            state.last_scan.iterated.toLocaleString(),
          )} contacts · ${e(String(state.last_scan.surfaced_count))} new possible duplicate${
            state.last_scan.surfaced_count === 1 ? '' : 's'
          }.</p>`
        : '';
  const scanButton = canScan
    ? `<button type="button" class="data-button"
        ${DATA_ROUTE_ACTION_ATTR}="run-merge-scan"
        ${state.scanning ? 'disabled' : ''}>${state.scanning ? 'Scanning…' : 'Scan again'}</button>`
    : '';
  return `
    <section ${DATA_ROUTE_CONTACT_SCAN_ATTR}>
      <div class="data-contact-toolbar">
        <button type="button" class="data-button"
          ${DATA_ROUTE_ACTION_ATTR}="close-contact-scan">← Back to contacts</button>
        ${scanButton}
      </div>
      <h2 class="data-section-title">Possible duplicates</h2>
      <p class="data-row-subtle">Recued groups contacts that look like the same person. Nothing is merged until you say so, and a merge can be undone.</p>
      ${summary}
      ${state.loading ? '' : renderMergeReviewDialog({
        ...state.dialog,
        surface: 'notification',
        // ⛔ NOT declared: this host has not wired the DESTRUCTIVE vendor-side
        // merge (`upstream_merge.*` + its arm/fire preview, D-138 P5). Omitting
        // the flag is what keeps "Also merge upstream" off the page — rendering
        // a button we cannot service is how this arc produced six of its
        // "built and wired to nothing" clusters. The vendor BADGES still show.
      })}
      ${pending === 0 && !state.loading && state.progress === null
        ? `<p ${DATA_ROUTE_UNAVAILABLE_ATTR}>No possible duplicates right now.</p>`
        : ''}
    </section>
  `;
};

const renderContactSurface = (
  contacts: readonly ContactRecord[],
  total: number,
  loadingMore: boolean,
  search: string,
  dialog: ContactDialogState | null,
  contactDetail: ContactDetailState | null,
  loadingContactDetail: boolean,
  contactScan: ContactScanState | null,
  canScan: boolean,
  canReviewMerges: boolean,
  contactSources: readonly ContactSourceHealth[],
  contactImport: ContactImportState | null,
  canImport: boolean,
  canUploadFile: boolean,
  now: number,
): string => {
  if (contactScan !== null) {
    return renderContactScanView(contactScan, canScan, now);
  }
  // D-205 #5b — the import page. Mutually exclusive with the scan + the detail,
  // exactly like they are with each other (one tab, one view — the openers close
  // the others explicitly rather than leaving one to resurrect underneath).
  if (contactImport !== null) {
    return renderContactImportView(contactImport, contactSources, canUploadFile);
  }
  if (contactDetail !== null) {
    // The edit dialog is modal OVER the detail (opened by its Edit button), so
    // it has to render here too — not only on the list.
    return `${renderContactDetailView(contactDetail, loadingContactDetail, now)}${renderContactDialog(dialog)}`;
  }
  return `
  <section>
    <h2 class="data-section-title">Contacts</h2>
    ${renderContactSourcesStrip(contactSources, now)}
    <div class="data-contact-toolbar">
      <input
        type="search"
        class="data-input"
        ${DATA_ROUTE_CONTACT_SEARCH_ATTR}
        value="${e(search)}"
        placeholder="Search contacts"
        aria-label="Search contacts"
      />
      ${canReviewMerges
        ? `<button type="button" class="data-button"
            ${DATA_ROUTE_ACTION_ATTR}="open-contact-scan">Find duplicates</button>`
        : ''}
      ${canImport || canUploadFile
        ? `<button type="button" class="data-button"
            ${DATA_ROUTE_ACTION_ATTR}="open-contact-import">Import</button>`
        : ''}
      <button type="button" class="data-button data-button--primary"
        ${DATA_ROUTE_ACTION_ATTR}="open-create-contact">New contact</button>
    </div>
    ${contacts.length === 0
      ? search.trim().length > 0
        ? `<p ${DATA_ROUTE_UNAVAILABLE_ATTR}>No contacts match your search.</p>`
        : `<div ${DATA_ROUTE_UNAVAILABLE_ATTR}>
            No contacts yet. Recued fills this in as it reads your mail and calendar — connect a source to get started, or add one with the New contact button above.
            <div class="data-empty-actions">
              <a class="data-button data-button--primary" href="#connections">Connect a source</a>
            </div>
          </div>`
      : `<ul class="data-contact-list" role="list">
          ${contacts.map((contact) => `
            <li ${DATA_ROUTE_CONTACT_ROW_ATTR}="${e(contact.email)}">
              <button type="button" class="data-row-button data-contact-row-button"
                ${DATA_ROUTE_ACTION_ATTR}="open-contact-detail"
                ${DATA_ROUTE_CONTACT_EMAIL_ATTR}="${e(contact.email)}">
                <span class="data-contact-avatar" aria-hidden="true">${e(contactInitial(contact))}</span>
                <span class="data-contact-text">
                  <span class="data-row-title">${e(contactLabel(contact))}</span>
                  <span class="data-row-meta">${e(contact.email)}${contact.company ? ` - ${e(contact.company)}` : ''}</span>
                  <span class="data-row-subtle">${e(contactSourceLabel(contact.source))} - ${e(String(contact.interaction_count))} interactions</span>
                </span>
              </button>
            </li>
          `).join('')}
        </ul>`}
    ${renderLoadMoreFooter({
      marker: DATA_ROUTE_CONTACT_LOAD_MORE_ATTR,
      action: 'load-more-contacts',
      loaded: contacts.length,
      total,
      loadingMore,
    })}
    ${renderContactDialog(dialog)}
  </section>
`;
};

interface FormResponseFieldView {
  readonly name: string;
  readonly label: string;
  readonly value: unknown;
}

type FormResponseAutomationPickerState =
  | { readonly status: 'idle' }
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly message: string }
  | {
      readonly status: 'ready';
      readonly matches: ReadonlyArray<FormResponseAutomationRunMatch>;
    };

const humanizeFieldName = (name: string): string =>
  name
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (character) => character.toUpperCase());

/** Rebuild the accepted response in the exact field order/labels frozen with
 * the submission. Any value absent from a legacy/malformed snapshot remains
 * visible at the end under a humanized key instead of being silently dropped. */
const formResponseFields = (
  response: FormResponse,
): readonly FormResponseFieldView[] => {
  const fields = response.definition_snapshot.fields;
  const declared = Array.isArray(fields) ? fields : [];
  const seen = new Set<string>();
  const out: FormResponseFieldView[] = [];
  for (const field of declared) {
    if (field === null || typeof field !== 'object' || Array.isArray(field)) continue;
    const record = field as Record<string, unknown>;
    if (typeof record.name !== 'string' || record.name.trim().length === 0) continue;
    const name = record.name;
    if (seen.has(name)) continue;
    seen.add(name);
    out.push({
      name,
      label:
        typeof record.label === 'string' && record.label.trim().length > 0
          ? record.label
          : humanizeFieldName(name),
      value: response.values[name],
    });
  }
  for (const [name, value] of Object.entries(response.values)) {
    if (seen.has(name)) continue;
    out.push({ name, label: humanizeFieldName(name), value });
  }
  return out;
};

const formResponseVisitorLabel = (
  response: Pick<FormResponseListItem, 'visitor'>,
): string =>
  typeof response.visitor.email === 'string' && response.visitor.email.length > 0
    ? response.visitor.email
    : 'Anonymous visitor';

const formResponseSourceLabel = (
  response: FormResponse | FormResponseListItem,
): string => {
  const template = 'metadata' in response
    ? response.metadata.template_ref
    : response.template_ref;
  const source = typeof template === 'string' && template.length > 0
    ? template
    : response.form_definition_id;
  const shortName = source.split(/[/:]/).filter((part) => part.length > 0).at(-1);
  return humanizeFieldName(shortName ?? source);
};

const formatFormResponseTime = (timestamp: number): string => {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? String(timestamp) : date.toLocaleString();
};

const renderFormResponseTime = (timestamp: number): string => {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return e(String(timestamp));
  return `<time datetime="${e(date.toISOString())}">${e(date.toLocaleString())}</time>`;
};

const renderFormResponseValue = (value: unknown): string => {
  if (value === undefined || value === null || value === '') return '<span aria-label="No answer">—</span>';
  if (typeof value === 'boolean') return e(value ? 'Yes' : 'No');
  if (typeof value === 'string' || typeof value === 'number') return e(String(value));
  try {
    return `<pre>${e(JSON.stringify(value, null, 2))}</pre>`;
  } catch {
    return e(String(value));
  }
};

const renderFormResponseAutomationPicker = (
  state: FormResponseAutomationPickerState,
): string => {
  if (state.status === 'idle') return '';
  if (state.status === 'loading') {
    return `<section ${DATA_ROUTE_FORM_RESPONSE_RUN_PICKER_ATTR}="loading">
      <p class="data-loading">Finding saved automations…</p>
    </section>`;
  }
  if (state.status === 'error') {
    return `<section ${DATA_ROUTE_FORM_RESPONSE_RUN_PICKER_ATTR}="error">
      <p role="alert">${e(state.message)}</p>
      <button type="button" class="data-button"
        ${DATA_ROUTE_ACTION_ATTR}="discover-form-response-automations">Try again</button>
    </section>`;
  }

  return `<section ${DATA_ROUTE_FORM_RESPONSE_RUN_PICKER_ATTR}="ready">
    <div class="data-response-run-heading">
      <div>
        <h3>Run this response now</h3>
        <p>This is an explicit manual run. Review the prefilled routing context and recipe configuration before confirming; the acceptance event is not re-emitted.</p>
      </div>
    </div>
    ${state.matches.length === 0
      ? '<p>No saved automation matches this response yet. Create one in Kitchen first.</p>'
      : `<ul role="list">
          ${state.matches.map((match) => {
            const storedName: unknown = match.entry.recipe?.metadata?.name;
            const name = typeof storedName === 'string' && storedName.trim().length > 0
              ? storedName.trim()
              : match.entry.recipe_id;
            const scope = match.scope === 'this_form'
              ? 'This form'
              : match.scope === 'all_forms'
                ? 'All forms'
                : 'Filtered match';
            return `<li>
              <div>
                <strong>${e(name)}</strong>
                <code>${e(match.entry.recipe_id)}</code>
              </div>
              <span class="data-pill">${e(scope)}</span>
              <button type="button" class="data-button data-button--primary"
                ${DATA_ROUTE_ACTION_ATTR}="review-form-response-automation"
                ${DATA_ROUTE_FORM_RESPONSE_RUN_RECIPE_ATTR}="${e(match.entry.recipe_id)}">Review and run</button>
            </li>`;
          }).join('')}
        </ul>`}
  </section>`;
};

const renderFormResponseDetail = (
  response: FormResponse,
  automationState: FormResponseAutomationPickerState,
  canRunAutomation: boolean,
): string => {
  const fields = formResponseFields(response);
  return `
    <section ${DATA_ROUTE_FORM_RESPONSE_DETAIL_ATTR}="${e(response.submission_id)}">
      <button type="button" class="data-button"
        ${DATA_ROUTE_ACTION_ATTR}="close-form-response">← Back to form responses</button>
      <div class="data-response-header">
        <h2>${e(formResponseVisitorLabel(response))}</h2>
        <span class="data-pill">Accepted</span>
      </div>
      <dl class="data-response-meta">
        <div><dt>Form</dt><dd>${e(formResponseSourceLabel(response))}</dd></div>
        <div><dt>Form definition</dt><dd>${e(response.form_definition_id)}</dd></div>
        <div><dt>Endpoint</dt><dd>${e(response.endpoint_id)}</dd></div>
        <div><dt>Submitted</dt><dd>${renderFormResponseTime(response.submitted_at)}</dd></div>
        <div><dt>Accepted</dt><dd>${renderFormResponseTime(response.accepted_at)}</dd></div>
        <div><dt>Reference</dt><dd>${e(response.submission_id)}</dd></div>
      </dl>
      <div class="data-response-automation">
        <div class="data-response-automation-copy">
          <strong>Continue with an automation</strong>
          <span>Start a Kitchen recipe for future owner-accepted responses from this form. The draft reads full answers only when it runs.</span>
        </div>
        <div class="data-response-automation-actions">
          <a class="data-button data-button--primary"
            ${DATA_ROUTE_FORM_RESPONSE_AUTOMATE_ATTR}="${e(response.form_definition_id)}"
            href="${e(serializeShellRoute(
              'kitchen',
              'new',
              'form-response',
              response.form_definition_id,
            ))}">Automate this form</a>
          ${canRunAutomation
            ? `<button type="button" class="data-button"
                ${DATA_ROUTE_ACTION_ATTR}="discover-form-response-automations"
                ${DATA_ROUTE_FORM_RESPONSE_RUN_ATTR}>Run this response</button>`
            : ''}
        </div>
      </div>
      ${renderFormResponseAutomationPicker(automationState)}
      <h3 class="data-section-title">Answers</h3>
      ${fields.length === 0
        ? `<p ${DATA_ROUTE_UNAVAILABLE_ATTR}>This response contains no submitted values.</p>`
        : `<dl class="data-response-fields">
            ${fields.map((field) => `
              <div class="data-response-field" data-form-response-field="${e(field.name)}">
                <dt>${e(field.label)}</dt>
                <dd>${renderFormResponseValue(field.value)}</dd>
              </div>
            `).join('')}
          </dl>`}
    </section>
  `;
};

const renderFormResponseSurface = (
  responses: readonly FormResponseListItem[],
  nextCursor: FormResponseListCursor | null,
  loadingMore: boolean,
  detailId: string | null,
  detail: FormResponse | null,
  detailError: string | null,
  loadingDetail: boolean,
  automationState: FormResponseAutomationPickerState,
  canRunAutomation: boolean,
): string => {
  if (detailId !== null) {
    if (loadingDetail) {
      return `
        <section ${DATA_ROUTE_FORM_RESPONSE_DETAIL_ATTR}="${e(detailId)}">
          <button type="button" class="data-button"
            ${DATA_ROUTE_ACTION_ATTR}="close-form-response">← Back to form responses</button>
          <p class="data-loading">Loading response...</p>
        </section>`;
    }
    return detail === null
      ? `<section ${DATA_ROUTE_FORM_RESPONSE_DETAIL_ATTR}="${e(detailId)}">
          <button type="button" class="data-button"
            ${DATA_ROUTE_ACTION_ATTR}="close-form-response">← Back to form responses</button>
          <p ${DATA_ROUTE_UNAVAILABLE_ATTR}>${detailError === null
            ? 'This form response was not found.'
            : 'Could not load this form response. Return to the list and try again.'}</p>
        </section>`
      : renderFormResponseDetail(detail, automationState, canRunAutomation);
  }

  return `
    <section>
      <h2 class="data-section-title">Form responses <span class="data-pill">read-only</span></h2>
      ${responses.length === 0
        ? `<p ${DATA_ROUTE_UNAVAILABLE_ATTR}>No accepted form responses yet. New submissions stay in Reception Inbox until you approve them.</p>`
        : `<ul class="data-form-response-list" role="list">
            ${responses.map((response) => `
              <li ${DATA_ROUTE_FORM_RESPONSE_ROW_ATTR}="${e(response.submission_id)}">
                <button type="button" class="data-row-button"
                  ${DATA_ROUTE_ACTION_ATTR}="open-form-response"
                  ${DATA_ROUTE_FORM_RESPONSE_ID_ATTR}="${e(response.submission_id)}">
                  <span class="data-row-title">${e(formResponseVisitorLabel(response))}</span>
                  <span class="data-row-meta">${e(formResponseSourceLabel(response))}</span>
                  <span class="data-row-subtle">Accepted ${e(formatFormResponseTime(response.accepted_at))}</span>
                  <span class="data-pill">View</span>
                </button>
              </li>
            `).join('')}
          </ul>`}
      ${nextCursor === null ? '' : `
        <div class="data-list-footer" ${DATA_ROUTE_FORM_RESPONSE_LOAD_MORE_ATTR}>
          <span class="data-list-count">${responses.length} loaded</span>
          <button type="button" class="data-button"
            ${DATA_ROUTE_ACTION_ATTR}="load-more-form-responses"${loadingMore ? ' disabled' : ''}>
            ${loadingMore ? 'Loading…' : 'Load more'}
          </button>
        </div>`}
    </section>
  `;
};

/** Defensively read a timeline entry's enrichment-source payload. The
 *  D-128 P5 enrichment payload is `{ topic, scope, target_id, value,
 *  meta?, ingredient_slug?, model_id?, staleness_class, authored_by }`.
 *  Returns null for non-enrichment entries or malformed payloads. */
interface EnrichmentTimelinePayload {
  topic: string;
  value: unknown;
  authored_by: string;
  staleness_class: EnrichmentSummary['staleness_class'];
  ingredient_slug: string | null;
  model_id: string | null;
  scope: string | null;
  target_id: string | null;
  meta: EnrichmentMeta | null;
}

const STALENESS_CLASSES: ReadonlySet<string> = new Set(['fresh', 'stale', 'expired']);

const readEnrichmentTimelinePayload = (
  entry: TimelineEntry,
): EnrichmentTimelinePayload | null => {
  if (entry.source !== 'enrichment') return null;
  const p = entry.payload;
  if (p === null || typeof p !== 'object' || Array.isArray(p)) return null;
  const r = p as Record<string, unknown>;
  if (typeof r.topic !== 'string' || r.topic.length === 0) return null;
  const staleness =
    typeof r.staleness_class === 'string' && STALENESS_CLASSES.has(r.staleness_class)
      ? (r.staleness_class as EnrichmentSummary['staleness_class'])
      : 'fresh';
  const meta =
    r.meta !== null && typeof r.meta === 'object' && !Array.isArray(r.meta)
      ? (r.meta as EnrichmentMeta)
      : null;
  return {
    topic: r.topic,
    value: r.value,
    authored_by: typeof r.authored_by === 'string' ? r.authored_by : 'unknown',
    staleness_class: staleness,
    ingredient_slug: typeof r.ingredient_slug === 'string' ? r.ingredient_slug : null,
    model_id: typeof r.model_id === 'string' ? r.model_id : null,
    scope: typeof r.scope === 'string' ? r.scope : null,
    target_id: typeof r.target_id === 'string' ? r.target_id : null,
    meta,
  };
};

/** Collapse a timeline response into the entity-detail panel's props.
 *  The single `data.timeline()` call is the only data source: the
 *  enrichment-source entries (D-128 P5) populate the Enrichments + meta
 *  sections; the full feed drives the Timeline section. */
const deriveEntityDetailProps = (
  response: TimelineResponse,
  // The entity's collection (`mirrorCollection(kind)` for a mirror tab, or
  // `'contact'` for the flow-20 contact drill-down) — used only as the
  // scope fallback when no enrichment row stamps a canonical scope.
  collection: string,
  enteredId: string,
  now: number,
): EntityDetailPanelProps => {
  const rows = response.entries
    .map((entry) => {
      const payload = readEnrichmentTimelinePayload(entry);
      return payload === null ? null : { payload, ts: entry.ts };
    })
    .filter((row): row is { payload: EnrichmentTimelinePayload; ts: number } => row !== null);

  const enrichments: ReadonlyArray<EnrichmentSummary> = collapseToFreshestPerTopic(
    rows.map(({ payload, ts }) => ({
      topic: payload.topic,
      value: payload.value,
      authored_by: payload.authored_by,
      authored_at: ts,
      staleness_class: payload.staleness_class,
      ingredient_slug: payload.ingredient_slug,
      model_id: payload.model_id,
    })),
  );

  const metaSnapshot = pickFreshestMetaSnapshot(
    rows.map(({ payload, ts }) => ({ meta: payload.meta, ingested_at: ts })),
  );

  // Prefer the canonical scope/target_id the producer stamped on the
  // freshest enrichment row (yields the connection.api.<vendor>.<entity>
  // scope for platform-reference entities); fall back to the mirror
  // collection + the id the user typed.
  const freshest = rows.reduce<{ payload: EnrichmentTimelinePayload; ts: number } | null>(
    (best, row) => (best === null || row.ts > best.ts ? row : best),
    null,
  );
  const scope = freshest?.payload.scope ?? collection;
  const target_id = freshest?.payload.target_id ?? enteredId;

  return {
    scope,
    target_id,
    vendorEntity: getVendorEntityForScope(scope as EnrichmentScope),
    metaSnapshot,
    enrichments,
    timelineEntries: response.entries,
    now,
    // Meta is the platform-reference compute slot (D-128 §A.2) — hide the
    // section (+ its misleading "install a pack" hint) for native scopes.
    showMetaSection: isPlatformReferenceScope(scope as EnrichmentScope),
    runHref: (entry) => {
      const runId = runIdFromTimelinePayload(entry.payload);
      return runId !== null ? runHref(runId) : null;
    },
    summarizePayload: (entry) => summarizePayload(entry.payload),
  };
};

const renderMirrorDrilldown = (
  snapshot: TimelineSnapshot | null,
  kind: MirrorDataKind,
  enteredId: string,
  now: number,
): string => {
  if (snapshot === null || snapshot.response === null) {
    return `<p ${DATA_ROUTE_UNAVAILABLE_ATTR}>No entity selected.</p>`;
  }
  return renderEntityDetailPanel(
    deriveEntityDetailProps(snapshot.response, mirrorCollection(kind), enteredId, now),
  );
};

/** D-192 file-SOURCE discoverability (Option A) — the Files-tab "Add a file
 *  source" CTA. One enroll deep link per declared file vendor
 *  (`FILE_VENDOR_DECLARATIONS` → `#connections/others/enroll/<vendor>`), so a
 *  user browsing their (often empty) file mirror can connect an S3 / Dropbox
 *  metadata source from where the mirror is viewed — no bare deep link needed.
 *  Registry-driven: a third file vendor surfaces here with no edit to this route.
 *
 *  This is the `connection.api` META-mirror (bytes NEVER fetched) — deliberately
 *  distinct from BOTH the D-172 upload widget rendered above it (file BYTES into
 *  the CAS) and the accounts-lane byte-ingest S3; the label says "metadata only"
 *  so the two are not conflated. */
const renderFileSourceCta = (): string => {
  const links = FILE_VENDOR_DECLARATIONS
    .map(
      (v) =>
        `<a class="data-button" ${DATA_ROUTE_FILE_SOURCE_LINK_ATTR}="${e(v.vendor)}" `
        + `href="${e(serializeShellRoute('connections', 'others', 'enroll', v.vendor))}">`
        + `${e(v.display_name)} →</a>`,
    )
    .join('\n        ');
  return `
    <div class="data-file-sources" ${DATA_ROUTE_FILE_SOURCES_ATTR}>
      <span class="data-file-sources-label">Mirror file metadata from a cloud source — metadata only, bytes stay in place</span>
      <div class="data-file-sources-links">
        ${links}
      </div>
    </div>`;
};

const renderMirrorSurface = (
  kind: MirrorDataKind,
  timelineEntityId: string,
  timeline: TimelineSnapshot | null,
  loadingTimeline: boolean,
  now: number,
  // D-174 #22 — pre-rendered name→id picker shell for searchable kinds
  // (mail / calendar / files). `null` keeps the raw-id box (crm has no
  // local searchable store; also the fallback when no caller is wired).
  pickerShell: string | null,
  // D-172 — pre-rendered drag/drop upload widget shell (files tab only, and
  // only when the upload deps are wired). `null` everywhere else.
  uploadShell: string | null,
  // D-172 Half-A "open" — pre-rendered "Download file" control (files tab only,
  // when the file-read caller is wired + a file is selected). `''` otherwise.
  downloadFileControl: string,
): string => `
  <section ${DATA_ROUTE_MIRROR_ATTR}="${e(kind)}">
    <h2 class="data-section-title">${e(tabLabel(kind))} <span class="data-pill">read-only</span></h2>
    ${uploadShell ?? ''}
    ${kind === 'files' ? renderFileSourceCta() : ''}
    <div class="data-mirror-toolbar">
      ${pickerShell ?? `<input
        type="text"
        class="data-input"
        ${DATA_ROUTE_TIMELINE_ENTITY_ATTR}
        value="${e(timelineEntityId)}"
        placeholder="${e(`${mirrorCollection(kind)}:id`)}"
        aria-label="Entity"
      />`}
      <button type="button" class="data-button data-button--primary"
        ${DATA_ROUTE_ACTION_ATTR}="load-timeline"
        ${loadingTimeline ? 'disabled' : ''}>${loadingTimeline ? 'Loading...' : 'Open timeline'}</button>
      ${downloadFileControl}
    </div>
    ${renderMirrorDrilldown(timeline, kind, timelineEntityId, now)}
  </section>
`;

const renderWorkEntitySurface = (
  state: WorkEntityPageState,
  sources: readonly SourceRegistration[],
  defaults: Readonly<Partial<Record<WorkEntityKind, string>>>,
  entities: readonly WorkEntity[],
  total: number,
  loadingMore: boolean,
): string => {
  const options = sourceOptionsForKind(sources, state.kind);
  const activeSourceId = state.dialog?.source_id ?? state.selected_source_id;
  const activeSource = activeSourceId === null
    ? undefined
    : enabledSourcesForKind(sources, state.kind).find(
        (source) => source.id === activeSourceId,
      );
  const definition = formDefinitionForKind(state.kind, activeSource);
  const visible = filterAndSortEntities(state.kind, entities, state.search_query);
  const rows = joinRowsWithSources(visible, options);
  const canCreate =
    resolveCreateDialogSourceId(
      state.kind,
      state.selected_source_id,
      defaults[state.kind] ?? null,
      enabledSourcesForKind(sources, state.kind),
    ) !== null;
  // Load-more paginates the raw (server kind/Source) set. It stays visible under
  // a client-side search too — the "N of M loaded" count is honest (it counts
  // loaded rows, not the search-filtered `visible.length`), and Load more brings
  // in more rows for the search to match, so a match past the first page is
  // reachable rather than stranded.
  const footerHtml = renderLoadMoreFooter({
    marker: DATA_ROUTE_WORK_ENTITY_LOAD_MORE_ATTR,
    action: 'load-more-work-entities',
    loaded: entities.length,
    total,
    loadingMore,
  });
  return renderWorkEntityPage({
    state,
    source_options: options,
    rows,
    form_definition: definition,
    can_create: canCreate,
    // `data.contact` ref fields render as live name→id pickers; the route
    // wires them after each render via `mountWorkEntityRefPickers`.
    ref_picker: true,
    ...(footerHtml !== '' ? { footer_html: footerHtml } : {}),
  });
};

const targetWithAttr = (ev: Event, attr: string): HTMLElement | null => {
  const rawTarget = ev.target as (Element & {
    closest?: (selector: string) => Element | null;
  }) | null;
  return rawTarget?.closest?.(`[${attr}]`) as HTMLElement | null;
};

export const bootstrapDataRoute = (
  opts: BootstrapDataRouteOptions,
): DataRoute => {
  const doc = opts.document ?? (globalThis as { document?: Document }).document;
  if (doc === undefined) {
    throw new Error(
      'bootstrapDataRoute: no document available - pass `opts.document` for non-browser environments',
    );
  }

  if (doc.head.querySelector(`style[${DATA_ROUTE_STYLES_MARKER}]`) === null) {
    const style = doc.createElement('style');
    style.setAttribute(DATA_ROUTE_STYLES_MARKER, '');
    style.textContent = [
      DATA_ROUTE_STYLES,
      FORM_RENDERER_STYLES,
      WORK_ENTITY_PAGE_STYLES,
      // The mirror drill-down renders the ui-shared entity-detail panel;
      // bundle its CSS so the `.memory-*` classes paint (mirrors the
      // WORK_ENTITY_PAGE_STYLES pattern — consumer owns injection).
      ENTITY_DETAIL_PANEL_STYLES,
      // D-205 #2b — `#data/contact/scan` renders the ui-shared merge-review
      // dialog; bundle its CSS so the `.merge-review-*` classes paint.
      MERGE_REVIEW_DIALOG_STYLES,
      // The work-entity dialog's `data.contact` ref fields render the
      // shared name→id picker combobox; bundle its CSS.
      RefPicker.REF_PICKER_STYLES,
      // The Data → File tab renders the shared drag/drop upload widget.
      Upload.UPLOAD_STYLES,
      // D-198 Slice 1b — the Memory lens feed.
      MEMORY_LENS_STYLES,
      // D-198 Slice 5 — the mail / calendar / files collection explorer.
      COLLECTION_EXPLORER_STYLES,
    ].join('\n');
    doc.head.appendChild(style);
  }

  const routeRoot = doc.createElement('div');
  routeRoot.setAttribute(DATA_ROUTE_HOST_ATTR, '');
  opts.root.appendChild(routeRoot);

  let disposed = false;
  // R18 — hydrate the initial tab from the `#data/<tab>` deep link (validated;
  // unknown → Contacts). A work-entity tab seeds the work-entity page state to
  // that kind so the deep link lands on the right list.
  // D-198 Slice 1b — the Data | Memory lens. `#data/memory` arrives as
  // initialTab='memory' (NOT a DataTabId, so it must be recognized here, BEFORE
  // the isDataTab gate below); the Data lens keeps the tab machinery unchanged.
  let activeLens: 'data' | 'memory' = opts.initialTab === 'memory' ? 'memory' : 'data';
  // Memory lens feed state — orthogonal to the Data tabs.
  let memoryEntries: MemoryListEntry[] = [];
  let memoryOriginFilter: MemoryOriginFilter = 'all';
  let memoryLoading = false;
  let memoryError: string | undefined;
  // D-198 Slice 2 — the owner CRUD sub-state (compose form / detail view /
  // inline delete-confirm). Orthogonal to the feed above; a view stack in the
  // lens (detail > compose > list).
  let memoryCompose: MemoryComposeState = {
    open: false,
    mode: 'create',
    kind: '',
    summary: '',
    body: '',
    submitting: false,
  };
  let memoryDetail: MemoryDetailState | null = null;
  let memoryPendingDeleteId: string | undefined;
  // D-198 Slice 3 — the import panel (paste JSON → memory.import).
  let memoryImport: MemoryImportState = { open: false, text: '', submitting: false };
  // D-198 Slice 3 — a memory-native export walk is in flight.
  let memoryExporting = false;
  // Writes are wired only when the whole CRUD caller set is present.
  const memoryCanWrite =
    opts.memoryCreateCaller !== undefined
    && opts.memoryUpdateCaller !== undefined
    && opts.memoryDeleteCaller !== undefined
    && opts.memoryGetCaller !== undefined;
  let activeTab: DataTabId =
    opts.initialTab !== undefined && isDataTab(opts.initialTab)
      ? opts.initialTab
      : 'contact';
  let workEntityState = initialWorkEntityPageState({
    kind: isWorkEntityTab(activeTab) ? activeTab : 'task',
  });
  let sources: SourceRegistration[] = [];
  let defaultsByKind: Partial<Record<WorkEntityKind, string>> = {};
  let workEntities: WorkEntity[] = [];
  // Bumped on each work-entity edit-dialog open; a fetch that resolves after a
  // newer open (or a tab switch) drops rather than installing a stale dialog.
  let workEntityDialogOpenSeq = 0;
  // R18 load-more (work entities) — mirrors the contact pagination below.
  // `total` is the server count for the active kind + Source filters (NOT the
  // client-side search, which filters the loaded rows in `filterAndSortEntities`).
  let workEntityTotal = 0;
  let loadingMoreWorkEntities = false;
  let contacts: ContactRecord[] = [];
  let contactTotal = 0;
  // R18 load-more — set while an append page (offset > 0) is in flight, so the
  // footer shows a spinner without flashing a loading state over the list.
  let loadingMoreContacts = false;
  let contactSearch = '';
  let contactDialog: ContactDialogState | null = null;
  let formResponses: FormResponseListItem[] = [];
  let formResponseNextCursor: FormResponseListCursor | null = null;
  let loadingMoreFormResponses = false;
  let formResponseDetailId: string | null = null;
  let formResponseDetail: FormResponse | null = null;
  let formResponseDetailError: string | null = null;
  let loadingFormResponseDetail = false;
  let formResponseAutomationState: FormResponseAutomationPickerState = {
    status: 'idle',
  };
  let formResponseAutomationSeq = 0;
  let formResponseRunModal: RunModal.RunModalHandle | null = null;
  // A response detail fetch may resolve after the owner opened a different
  // row or left the tab. Only the latest sequence may install its result.
  let formResponseDetailSeq = 0;
  let timelineEntityId = '';
  let timeline: TimelineSnapshot | null = null;
  // flow-20 — contact drill-down timeline (own-it Contacts tab), separate
  // from the mirror-tab `timeline` above.
  let contactDetail: ContactDetailState | null = null;
  let loadingContactDetail = false;
  // D-205 #2b — the merge scan page. Null when closed.
  let contactScan: ContactScanState | null = null;
  // D-205 #5b — `#data/contact/import`.
  let contactImport: ContactImportState | null = null;
  // Guards against a stale hydrate painting over a fresher one (scan → confirm →
  // reload all race the same slot).
  let contactScanSeq = 0;
  /** The review cards cannot exist without BOTH the queue AND the per-contact
   *  hydrate, so both are the floor for offering the page at all. Missing either
   *  → no "Find duplicates" entry point, rather than a page that cannot act. */
  const canReviewMerges =
    opts.contactMergeListCaller !== undefined && opts.contactGetCaller !== undefined;
  /** D-205 #5b — BOTH callers are the floor. A picker that can list but not add is a
   *  dead end; one that can add but not list is unusable. Absent → no entry point at
   *  all, rather than a page that cannot act — the discipline #2b established when it
   *  fail-closed the upstream-merge button. */
  const canImport =
    opts.contactImportCandidatesCaller !== undefined
    && opts.contactImportPromoteCaller !== undefined;
  /** D-205 #5c — the file upload. BOTH are the floor: a preview you cannot apply is a
   *  tease; an apply you cannot preview is the stale-export foot-gun with no warning. */
  const canUploadFile =
    opts.contactImportFilePreviewCaller !== undefined
    && opts.contactImportFileApplyCaller !== undefined;
  // D-205 #2c — the Sources health strip.
  let contactSources: readonly ContactSourceHealth[] = [];
  let loading = true;
  let loadingTimeline = false;
  // D-172 Half-A "open" — a file download (data.file.read → browser save) is in
  // flight; disables the button + shows a spinner label.
  let downloadingFile = false;
  let errors: DataLoadErrors = {};
  let loadGeneration = 0;
  let pendingLoadPromise: Promise<void> = Promise.resolve();

  // ── work-entity `data.contact` ref-pickers ─────────────────────────
  // The work-entity dialog renders `data.contact` ref fields (single:
  // task.assigned_contact / commitment.counterparty_contact; array:
  // note.related_contact / project.related_contacts) as picker SHELLS
  // (`ref_picker: true`). After every render the route ATTACHES a live
  // name→id picker to each shell; the picker's hidden mirror carries the
  // committed email, which `readFormValues` reads back at submit — the
  // value shape is unchanged (one email for singles, a `string[]` of
  // emails for arrays). Pickers are ephemeral per render (disposed +
  // re-wired) so Add/Remove, which re-shuffles array indices, needs no
  // per-handle bookkeeping.
  let workEntityRefPickers: RefPicker.RefPickerHandle[] = [];

  /** Server-backed contact search for the picker dropdown. A thrown rpc
   *  error bubbles to the picker, which surfaces it inline. */
  const contactRefSearch: RefPicker.RefPickerSearchCaller = async (query) => {
    if (opts.contactListCaller === undefined) return [];
    const { contacts: results } = await opts.contactListCaller({
      name_contains: query,
      limit: 20,
    });
    return results.map((c) => ({
      id: c.email,
      label: c.name ?? c.email,
      sublabel: c.email,
    }));
  };

  /** Best-effort display label for a stored contact id (an email).
   *  Resolves the name from the in-memory contact list when present
   *  (zero async); otherwise shows the email (owner-chosen fallback). */
  const resolveContactLabel = (email: string): string =>
    contacts.find((c) => c.email === email)?.name ?? email;

  const disposeWorkEntityRefPickers = (): void => {
    for (const handle of workEntityRefPickers) handle.destroy();
    workEntityRefPickers = [];
  };

  /** Re-attach a live picker to every `data.contact` ref shell in the
   *  open work-entity dialog. MUST run after `routeRoot.innerHTML` is set
   *  (the shells only exist post-paint). A no-op when no dialog is open. */
  const mountWorkEntityRefPickers = (): void => {
    disposeWorkEntityRefPickers();
    // Degrade gracefully on a string-only fake DOM (the data-route unit
    // tests store innerHTML without parsing it into nodes): the picker
    // can't attach without a queryable host, so skip rather than throw.
    if (typeof routeRoot.querySelector !== 'function') return;
    const form = routeRoot.querySelector('.work-entity-dialog-form');
    if (form === null) return;
    form.querySelectorAll('[data-ref-picker]').forEach((shell) => {
      const pickerId = shell.getAttribute('data-ref-picker');
      if (pickerId === null) return;
      const mirror = shell.querySelector(
        `[${RefPicker.REF_PICKER_VALUE_ATTR}]`,
      ) as HTMLInputElement | null;
      const id = mirror?.value.trim() ?? '';
      const initialValue =
        id === '' ? null : { id, label: resolveContactLabel(id) };
      workEntityRefPickers.push(
        RefPicker.wireRefPicker(form, {
          search: contactRefSearch,
          config: { pickerId },
          minChars: 1,
          initialValue,
        }),
      );
    });
  };

  // D-198 Slice 5 — collection-explorer state (mail / calendar tabs). One active
  // collection at a time; reset on tab switch. `explorerSeq` guards async
  // responses against rapid instance/record clicks (stale-drop).
  let explorerCollection: CanonicalCollectionName | null = null;
  let explorerInstances: CollectionInstanceRow[] = [];
  let explorerSelectedSlug: string | null = null;
  let explorerRecords: CollectionRecord[] = [];
  let explorerDetail: CollectionExplorerDetailState | null = null;
  // D-210 step 3 — the open calendar record's timeline (its move history:
  // D-120 write links + the D-119 `scheduled-from` origin edge). Fetched
  // lazily on open, calendar-only for now (the explorer's detailTimelineHtml
  // slot is generic — widen the gate in `openExplorerRecord` to add others).
  let explorerTimeline: TimelineEntry[] | null = null;
  // Page size for the calendar detail timeline — mirrors the crm drill-down.
  const CALENDAR_TIMELINE_LIMIT = 50;
  // D-210 R-4 — the owner's reschedule control state for the OPEN calendar event.
  // `null` = closed (only the "Reschedule" button shows); open holds the datetime
  // input's value + submit state. Reset whenever the detail changes so a stale
  // form never carries across events.
  let rescheduleForm: { value: string; submitting: boolean; error: string | null } | null = null;
  // D-210 Appendix B — the "Copy reschedule link" affordance state for the OPEN
  // calendar event. `busy` while the mint rpc is in flight; `notice` is the
  // post-copy line (the URL itself is only shown as a fallback when the clipboard
  // API is unavailable). Reset on detail change so a stale notice never carries.
  let explorerLoading = false;
  let explorerError: string | undefined;
  let explorerSeq = 0;

  const resetExplorerState = (): void => {
    explorerCollection = null;
    explorerInstances = [];
    explorerSelectedSlug = null;
    explorerRecords = [];
    explorerDetail = null;
    explorerTimeline = null;
    rescheduleForm = null;
    explorerLoading = false;
    explorerError = undefined;
    explorerSeq += 1; // abandon any in-flight explorer fetch
  };

  /** D-200 — the same owner-trusted file inventory behind Data → Files,
   * projected as durable file refs for recipe `file_ref` variables. Unlike the
   * active-tab picker above, this stays pinned to `files` while a form-response
   * run modal is open over any Data lens. */
  const fileRefSearch: RefPicker.RefPickerSearchCaller = async (query) => {
    if (opts.mirrorSearchCaller === undefined) return [];
    const { results } = await opts.mirrorSearchCaller({
      kind: 'files',
      query,
      limit: 20,
    });
    return fileRefOptionsFromMirrorResults(results);
  };

  // ── Data → File drag/drop upload widget (D-172) ────────────────────
  // The Files mirror tab gains a resumable-upload widget when all four
  // `upload.*` callers + the binary-socket connect factory are wired. The
  // engine lives in the widget HANDLE (not the DOM), so — unlike the search
  // picker — we keep ONE handle across re-renders and `rewire()` it post-paint
  // (a re-render mid-upload must not abort the in-flight transfer). The handle
  // is created lazily on first paint of the Files tab and disposed when we
  // leave it (or on route dispose).
  const UPLOAD_WIDGET_ID = 'data-file-upload';
  let uploadWidget: Upload.UploadHandle | null = null;

  const uploadDepsReady = (): boolean =>
    opts.uploadCreateCaller !== undefined &&
    opts.uploadProbeCaller !== undefined &&
    opts.uploadFinalizeCaller !== undefined &&
    opts.uploadDeleteCaller !== undefined &&
    opts.uploadConnectFactory !== undefined;

  const disposeUploadWidget = (): void => {
    uploadWidget?.destroy();
    uploadWidget = null;
  };

  /** Attach (or re-attach) the upload widget to the freshly-painted Files
   *  shell. No-op off the Files tab, when the deps aren't wired, on the
   *  string-only fake DOM, and when the shell is absent — disposing the
   *  handle when we've navigated away so an in-flight upload is cancelled. */
  const mountUploadWidget = (): void => {
    if (typeof routeRoot.querySelector !== 'function') return;
    const ready =
      activeTab === 'files' &&
      uploadDepsReady() &&
      routeRoot.querySelector(`[data-upload="${UPLOAD_WIDGET_ID}"]`) !== null;
    if (!ready) {
      disposeUploadWidget();
      return;
    }
    if (uploadWidget !== null) {
      uploadWidget.rewire(routeRoot);
      return;
    }
    uploadWidget = Upload.wireUploadWidget(routeRoot, {
      callers: {
        create: opts.uploadCreateCaller!,
        probe: opts.uploadProbeCaller!,
        finalize: opts.uploadFinalizeCaller!,
        delete: opts.uploadDeleteCaller!,
      },
      connect: opts.uploadConnectFactory!,
      config: { widgetId: UPLOAD_WIDGET_ID },
      // A finalized upload lands a new `data.file.received` record — refresh
      // the Files tab so the timeline / drill-down can reach it.
      onDone: () => {
        if (activeTab === 'files') startRefresh();
      },
    });
  };

  // D-198 Slice 5 — render one explorer tab (mail / calendar / files). The
  // generic engine drives the list→detail; the `files` tab additionally layers
  // its D-172 upload widget + D-192 file-source CTA as persistent tab chrome
  // above the browse view (persistent so an in-flight upload survives drilling
  // into a record + back), and a "Download file" control in the record-detail
  // D-210 R-4 — unix-ms → the "YYYY-MM-DDTHH:mm" a datetime-local input shows,
  // in the viewer's local time (the frame the owner picks a new wall-clock time
  // in). The reverse (`new Date(value).getTime()`) reads the picked string back as
  // local time, so the round-trip is tz-consistent for the owner.
  const toDatetimeLocal = (unixMs: number): string => {
    if (!Number.isFinite(unixMs)) return '';
    const d = new Date(unixMs);
    const pad = (n: number): string => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };

  /** D-210 R-4 — the reschedule affordance on a calendar event's detail bar.
   *  Closed = just the button; open = a datetime picker (prefilled with the
   *  event's current start, set by the `reschedule-open` handler) + Save. The
   *  owner picks the time — no AI writes it (LLM-as-editor is out of scope). Save
   *  runs `reschedule-calendar-event` (see `submitReschedule`), which moves the
   *  event; the reactive notify recipe then tells any booking visitor. */
  const renderRescheduleControl = (
    form: { value: string; submitting: boolean; error: string | null } | null,
  ): string => {
    if (form === null) {
      // ⛔ D-210 A.2 (slice 3b) — the on-the-go "Copy reschedule link" affordance
      // stood here and was REMOVED, not re-gated. It hands a VISITOR a page to
      // move their own reservation, and `reception.manage.mint` now names a
      // BOOKING and refuses anything without a `reception_record_id`. On a
      // personal calendar event — the only record this control still serves —
      // its one possible outcome is a 404, so keeping it behind a condition
      // would have shipped a button that always errors.
      //
      // The rpc, its handler and the recipes are all intact and reachable; only
      // this entry point is gone, because a booking has no detail surface to put
      // it on (the explorer serves mail/calendar/files/webhook, and the
      // work-entity page is a list + a dialog). See the 3b handover.
      return `<div class="data-reschedule-actions">
        <button type="button" class="data-button" ${DATA_ROUTE_ACTION_ATTR}="reschedule-open">Reschedule</button>
      </div>`;
    }
    const disabled = form.submitting ? ' disabled' : '';
    const err =
      form.error !== null
        ? `<p class="data-reschedule-error" role="alert">${e(form.error)}</p>`
        : '';
    return `<div class="data-reschedule-form">
      <label class="data-reschedule-label">New start
        <input type="datetime-local" class="data-input" ${DATA_ROUTE_ACTION_ATTR}="reschedule-input" value="${e(form.value)}"${disabled} />
      </label>
      <button type="button" class="data-button" ${DATA_ROUTE_ACTION_ATTR}="reschedule-submit"${disabled}>${form.submitting ? 'Rescheduling…' : 'Save'}</button>
      <button type="button" class="data-button" ${DATA_ROUTE_ACTION_ATTR}="reschedule-cancel"${disabled}>Cancel</button>
      ${err}
    </div>`;
  };

  // bar (when the read caller is wired — the explorer renders it only in the
  // detail view).
  const renderExplorerTab = (tab: DataTabId): string => {
    const downloadControl =
      tab === 'files' && opts.fileReadCaller !== undefined
        ? `<button type="button" class="data-button" ${DATA_ROUTE_DOWNLOAD_FILE_ATTR}
            ${DATA_ROUTE_ACTION_ATTR}="download-file"${downloadingFile ? ' disabled' : ''}>${
            downloadingFile ? 'Downloading…' : 'Download file'
          }</button>`
        : '';
    // Provenance detail carries only a record_id — resolve the record against the
    // CURRENT `explorerRecords` here so a live refresh that swapped the list is
    // reflected (removed → the engine's "no longer exists" state). Platform
    // detail keeps its lazy `collection.get` snapshot.
    const detail =
      explorerDetail !== null && isSingleCollectionTab(tab)
        ? {
            ...explorerDetail,
            record:
              explorerRecords.find((r) => r.record_id === explorerDetail!.record_id) ?? null,
          }
        : explorerDetail;
    // Canonical collection name (schema key) = the platform (`file`), not the
    // tab id (`files`) — see `loadExplorer`.
    const collectionName =
      explorerCollection
      ?? (EXPLORER_TAB_PLATFORM[tab] as CanonicalCollectionName | undefined)
      ?? (tab as CanonicalCollectionName);
    // D-210 step 3 — render the calendar event's timeline below its fields (its
    // move history + `scheduled-from` origin). Only when the loaded record IS a
    // calendar event and its timeline has arrived; runHref / summarizePayload
    // mirror the crm drill-down so a memory entry links to its run.
    const detailTimelineHtml =
      collectionName === 'calendar' && detail?.record != null && explorerTimeline !== null
        ? renderTimelineSection(
            explorerTimeline,
            (opts.now ?? Date.now)(),
            (entry) => {
              const runId = runIdFromTimelinePayload(entry.payload);
              return runId !== null ? runHref(runId) : null;
            },
            (entry) => summarizePayload(entry.payload),
          )
        : '';
    // D-210 R-4 — the owner's reschedule control on a calendar event's detail bar,
    // gated to calendar (like the timeline above) + only when the execute caller
    // is wired. Mutually exclusive with the Files download control (different
    // tabs), so they share the one detail-bar slot.
    const rescheduleControl =
      collectionName === 'calendar'
      && detail?.record != null
      && opts.recipeExecuteCaller !== undefined
        ? renderRescheduleControl(rescheduleForm)
        : '';
    const detailActions = downloadControl !== '' ? downloadControl : rescheduleControl;
    const explorer = renderCollectionExplorer({
      collection: collectionName,
      instances: explorerInstances,
      selectedSlug: explorerSelectedSlug,
      records: explorerRecords,
      detail,
      loading: explorerLoading,
      ...(explorerError !== undefined ? { error: explorerError } : {}),
      now: (opts.now ?? Date.now)(),
      actionAttr: DATA_ROUTE_ACTION_ATTR,
      ...(detailActions !== '' ? { detailActionsHtml: detailActions } : {}),
      ...(detailTimelineHtml !== '' ? { detailTimelineHtml } : {}),
      // Provenance collections (annotation / link) are single global collections
      // — no instances, no "connected" empty state.
      ...(isSingleCollectionTab(tab) ? { singleCollection: true } : {}),
    });
    if (tab !== 'files') return explorer;
    const uploadShell = uploadDepsReady()
      ? Upload.renderUploadWidget({ widgetId: UPLOAD_WIDGET_ID })
      : '';
    return `<section ${DATA_ROUTE_MIRROR_ATTR}="files">
      ${uploadShell}
      ${renderFileSourceCta()}
      ${explorer}
    </section>`;
  };

  const render = (): void => {
    if (disposed) return;
    const body = activeTab === 'contact'
      ? renderContactSurface(
          contacts,
          contactTotal,
          loadingMoreContacts,
          contactSearch,
          contactDialog,
          contactDetail,
          loadingContactDetail,
          contactScan,
          opts.contactMergeScanNowCaller !== undefined,
          canReviewMerges,
          contactSources,
          contactImport,
          canImport,
          canUploadFile,
          (opts.now ?? Date.now)(),
        )
      : isReceivedTab(activeTab)
        ? renderFormResponseSurface(
            formResponses,
            formResponseNextCursor,
            loadingMoreFormResponses,
            formResponseDetailId,
            formResponseDetail,
            formResponseDetailError,
            loadingFormResponseDetail,
            formResponseAutomationState,
            opts.recipeListCaller !== undefined
              && opts.recipeExecuteCaller !== undefined,
          )
      : isWorkEntityTab(activeTab)
        ? renderWorkEntitySurface(
            workEntityState,
            sources,
            defaultsByKind,
            workEntities,
            workEntityTotal,
            loadingMoreWorkEntities,
          )
        : isExplorerTab(activeTab) || isSingleCollectionTab(activeTab)
          ? renderExplorerTab(activeTab)
        : // Only `crm` remains a `data.timeline` raw-id drill-down — mail /
          // calendar / files / webhook browse via the explorer, annotation /
          // link via the single-collection explorer. `crm` has no local
          // searchable store, so the name→id picker + upload/download (files-
          // only) never apply here.
          renderMirrorSurface(
            activeTab,
            timelineEntityId,
            timeline?.kind === activeTab ? timeline : null,
            loadingTimeline,
            (opts.now ?? Date.now)(),
            null,
            null,
            '',
          );

    // D-198 Slice 1b — the Memory lens replaces the tab body with the feed.
    // `body` (the tab ternary above) is still computed on the memory lens but
    // discarded — it is pure + cheap over the not-yet-loaded empty lists.
    const lensBody = activeLens === 'memory'
      ? renderMemoryLens({
          entries: memoryEntries,
          originFilter: memoryOriginFilter,
          loading: memoryLoading,
          ...(memoryError !== undefined ? { error: memoryError } : {}),
          now: (opts.now ?? Date.now)(),
          actionAttr: DATA_ROUTE_ACTION_ATTR,
          runHref: (run_id: string) => serializeShellRoute('logs', run_id),
          // D-198 Slice 2/3 — owner CRUD + import sub-state + affordance gating.
          compose: memoryCompose,
          detail: memoryDetail,
          importPanel: memoryImport,
          exporting: memoryExporting,
          ...(memoryPendingDeleteId !== undefined ? { pendingDeleteId: memoryPendingDeleteId } : {}),
          canWrite: memoryCanWrite,
        })
      : body;

    routeRoot.innerHTML = `
      <header class="data-header">
        <h1 class="data-title" ${DATA_ROUTE_HEADING_ATTR}>Data</h1>
      </header>
      ${renderLensSwitcher(activeLens, DATA_ROUTE_ACTION_ATTR)}
      ${activeLens === 'memory' ? '' : renderTabs(activeTab)}
      ${loading && activeLens !== 'memory' ? '<p class="data-loading">Loading data...</p>' : ''}
      ${renderErrors(errors)}
      ${lensBody}
    `;
    // Attach live pickers to any `data.contact` ref shells the work-entity
    // dialog just painted (no-op otherwise).
    mountWorkEntityRefPickers();
    // Attach (or rewire) the Files-tab upload widget (no-op elsewhere).
    mountUploadWidget();
  };

  // The `generation` guard drops a stale response: a slow refresh (e.g. a
  // silent live-update) must NOT assign its list AFTER a newer refresh already
  // rendered — without it the shared `sources`/`workEntities`/`contacts` could be
  // clobbered with stale data the next render then shows (codex R18 MEDIUM).
  const refreshSources = async (
    nextErrors: DataLoadErrors,
    generation: number,
  ): Promise<void> => {
    if (opts.workEntitySourceListCaller === undefined) {
      sources = [];
      defaultsByKind = {};
      nextErrors.sources = 'work_entity.source.list caller is not wired in this host.';
      return;
    }
    try {
      const response = await opts.workEntitySourceListCaller();
      if (disposed || generation !== loadGeneration) return;
      sources = [...response.sources];
      defaultsByKind = { ...response.defaults_by_kind };
    } catch (err) {
      if (disposed || generation !== loadGeneration) return;
      sources = [];
      defaultsByKind = {};
      nextErrors.sources = errMessage(err);
    }
  };

  // Shared request shape for the initial/replace fetch (offset 0) + the
  // load-more append. The active kind + Source filter compose the server query;
  // the client-side search is applied later in `filterAndSortEntities`.
  const workEntityListRequest = (offset: number): WorkEntityListRpcRequest => {
    const request: WorkEntityListRpcRequest = {
      kind: workEntityState.kind,
      limit: DEFAULT_LIMIT,
    };
    if (offset > 0) request.offset = offset;
    if (workEntityState.selected_source_id !== null) {
      request.source_id = workEntityState.selected_source_id;
    }
    return request;
  };

  const refreshWorkEntities = async (
    nextErrors: DataLoadErrors,
    generation: number,
  ): Promise<void> => {
    if (opts.workEntityListCaller === undefined) {
      workEntities = [];
      workEntityTotal = 0;
      nextErrors.work_entities = 'work_entity.list caller is not wired in this host.';
      return;
    }
    try {
      const response = await opts.workEntityListCaller(workEntityListRequest(0));
      if (disposed || generation !== loadGeneration) return;
      workEntities = [...response.entities];
      workEntityTotal = response.total;
    } catch (err) {
      if (disposed || generation !== loadGeneration) return;
      workEntities = [];
      workEntityTotal = 0;
      nextErrors.work_entities = errMessage(err);
    }
  };

  // R18 load-more — append the next page of raw (server-filtered) rows at
  // `offset = loaded count`. Like the contact variant: no `loadGeneration` bump,
  // drops its result if a full refresh landed first, chained after any in-flight
  // load so `offset` reads the post-refresh list.
  const loadMoreWorkEntities = async (): Promise<void> => {
    if (opts.workEntityListCaller === undefined) return;
    if (loadingMoreWorkEntities || workEntities.length >= workEntityTotal) return;
    const generation = loadGeneration;
    loadingMoreWorkEntities = true;
    render();
    try {
      const response = await opts.workEntityListCaller(
        workEntityListRequest(workEntities.length),
      );
      if (disposed || generation !== loadGeneration) return;
      workEntities = [...workEntities, ...response.entities];
      workEntityTotal = response.total;
      if (errors.work_entities !== undefined) {
        errors = { ...errors };
        delete errors.work_entities;
      }
    } catch (err) {
      if (disposed || generation !== loadGeneration) return;
      errors = { ...errors, work_entities: errMessage(err) };
    } finally {
      if (!disposed && generation === loadGeneration) {
        loadingMoreWorkEntities = false;
        render();
      }
    }
  };

  // Shared request shape for both the initial/replace fetch (offset 0) and the
  // load-more append fetch — same search filter so pagination walks the query's
  // own result set, and the server `total` reflects that filter.
  const contactListRequest = (
    offset: number,
  ): Parameters<DataContactListCaller>[0] => {
    const request: Parameters<DataContactListCaller>[0] = { limit: DEFAULT_LIMIT };
    if (offset > 0) request.offset = offset;
    if (contactSearch.trim().length > 0) {
      request.name_contains = contactSearch.trim();
    }
    return request;
  };

  const refreshContacts = async (
    nextErrors: DataLoadErrors,
    generation: number,
  ): Promise<void> => {
    if (opts.contactListCaller === undefined) {
      contacts = [];
      contactTotal = 0;
      nextErrors.contacts = 'contact.list caller is not wired in this host.';
      return;
    }
    try {
      const response = await opts.contactListCaller(contactListRequest(0));
      if (disposed || generation !== loadGeneration) return;
      contacts = [...response.contacts];
      contactTotal = response.total;
    } catch (err) {
      if (disposed || generation !== loadGeneration) return;
      contacts = [];
      contactTotal = 0;
      nextErrors.contacts = errMessage(err);
    }
  };

  /** D-205 #2c — the Sources health strip. Loaded ALONGSIDE the contact list (not
   *  gating it): a Source-health read that fails must not blank the contacts, and a
   *  contact list that fails should still be able to tell you WHY — a broken Source
   *  is the likeliest reason it is empty. Its failure is silent by design: the strip
   *  is diagnosis, and an error banner about the diagnosis would bury the thing being
   *  diagnosed. */
  const refreshContactSources = async (generation: number): Promise<void> => {
    if (opts.contactSourceListCaller === undefined) return;
    try {
      const response = await opts.contactSourceListCaller();
      if (disposed || generation !== loadGeneration) return;
      contactSources = response.sources;
    } catch {
      if (disposed || generation !== loadGeneration) return;
      contactSources = [];
    }
  };

  // R18 load-more — append the next page of contacts at `offset = loaded count`
  // without disturbing the rows already on screen. No `loadGeneration` bump (it
  // extends, not replaces); it captures the current generation and drops its
  // result if a full refresh (tab switch / search / silent live-update) lands
  // first, so an append can never clobber a fresher list.
  const loadMoreContacts = async (): Promise<void> => {
    if (opts.contactListCaller === undefined) return;
    if (loadingMoreContacts || contacts.length >= contactTotal) return;
    const generation = loadGeneration;
    loadingMoreContacts = true;
    render();
    try {
      const response = await opts.contactListCaller(contactListRequest(contacts.length));
      if (disposed || generation !== loadGeneration) return;
      contacts = [...contacts, ...response.contacts];
      contactTotal = response.total;
      // A recovered append clears a prior load-more error banner.
      if (errors.contacts !== undefined) {
        errors = { ...errors };
        delete errors.contacts;
      }
    } catch (err) {
      if (disposed || generation !== loadGeneration) return;
      errors = { ...errors, contacts: errMessage(err) };
    } finally {
      if (!disposed && generation === loadGeneration) {
        loadingMoreContacts = false;
        render();
      }
    }
  };

  const refreshFormResponses = async (
    nextErrors: DataLoadErrors,
    generation: number,
  ): Promise<void> => {
    if (opts.formResponseListCaller === undefined) {
      formResponses = [];
      formResponseNextCursor = null;
      nextErrors.form_responses = 'form_response.list caller is not wired in this host.';
      return;
    }
    try {
      const response = await opts.formResponseListCaller({ limit: DEFAULT_LIMIT });
      if (disposed || generation !== loadGeneration) return;
      formResponses = [...response.responses];
      formResponseNextCursor = response.next_cursor ?? null;
    } catch (err) {
      if (disposed || generation !== loadGeneration) return;
      formResponses = [];
      formResponseNextCursor = null;
      nextErrors.form_responses = errMessage(err);
    }
  };

  const loadMoreFormResponses = async (): Promise<void> => {
    if (opts.formResponseListCaller === undefined) return;
    if (!isReceivedTab(activeTab)) return;
    if (loadingMoreFormResponses || formResponseNextCursor === null) return;
    const generation = loadGeneration;
    const cursor = formResponseNextCursor;
    loadingMoreFormResponses = true;
    render();
    try {
      const response = await opts.formResponseListCaller({
        limit: DEFAULT_LIMIT,
        before: cursor,
      });
      if (disposed || generation !== loadGeneration) return;
      const known = new Set(formResponses.map((row) => row.submission_id));
      formResponses = [
        ...formResponses,
        ...response.responses.filter((row) => !known.has(row.submission_id)),
      ];
      formResponseNextCursor = response.next_cursor ?? null;
      if (errors.form_responses !== undefined) {
        errors = { ...errors };
        delete errors.form_responses;
      }
    } catch (err) {
      if (disposed || generation !== loadGeneration) return;
      errors = { ...errors, form_responses: errMessage(err) };
    } finally {
      if (!disposed && generation === loadGeneration) {
        loadingMoreFormResponses = false;
        render();
      }
    }
  };

  // D-198 Slice 1b — load the Memory lens feed (`memory.list`). Generation-
  // guarded like the tab refreshers so a slow / live refetch can't clobber
  // newer state (e.g. after an origin-filter change or lens switch).
  const refreshMemory = async (generation: number): Promise<void> => {
    if (opts.memoryListCaller === undefined) {
      memoryEntries = [];
      memoryError = 'memory.list caller is not wired in this host.';
      return;
    }
    try {
      const actors = memoryFilterActors(memoryOriginFilter);
      const response = await opts.memoryListCaller({
        ...(actors ? { origin_actors: actors } : {}),
        limit: DEFAULT_LIMIT,
      });
      if (disposed || generation !== loadGeneration) return;
      memoryEntries = [...response.entries];
      memoryError = undefined;
    } catch (err) {
      if (disposed || generation !== loadGeneration) return;
      memoryEntries = [];
      memoryError = humanizeRpcError(err);
    }
  };

  // ── D-198 Slice 5 — collection explorer (mail / calendar) ─────────────────

  /** Fetch `(platform, slug)` records into `explorerRecords`. Guarded on
   *  `explorerSeq` (the caller bumps it) so a stale response is dropped. */
  const fetchExplorerRecords = async (
    platform: CollectionPlatform,
    slug: string,
    seq: number,
  ): Promise<void> => {
    const caller = opts.collectionListCaller;
    if (caller === undefined) {
      explorerRecords = [];
      return;
    }
    try {
      const { records } = await caller({ platform, slug, limit: DEFAULT_LIMIT });
      if (disposed || seq !== explorerSeq) return;
      explorerRecords = records;
      explorerError = undefined;
    } catch (err) {
      if (disposed || seq !== explorerSeq) return;
      explorerRecords = [];
      explorerError = humanizeRpcError(err);
    }
  };

  /** D-198 Phase 2/3 — load a single-collection tab (annotation / link / shared):
   *  one whole-collection `list` (no instances), entries mapped into the explorer
   *  shape. The list ships full records, so there is no separate lazy `get`. */
  const loadSingleCollection = async (tab: DataSingleCollectionTabId): Promise<void> => {
    const seq = ++explorerSeq;
    explorerCollection = tab as CanonicalCollectionName; // schema key === tab id
    explorerInstances = [];
    explorerSelectedSlug = null;
    explorerDetail = null;
    explorerError = undefined;
    explorerLoading = true;
    const load = async (): Promise<CollectionRecord[] | null> => {
      if (tab === 'annotation') {
        if (opts.annotationListCaller === undefined) return null;
        return (await opts.annotationListCaller()).annotations.map(annotationToExplorerRecord);
      }
      if (tab === 'link') {
        if (opts.linkListCaller === undefined) return null;
        return (await opts.linkListCaller()).links.map(linkToExplorerRecord);
      }
      if (opts.sharedListCaller === undefined) return null;
      return (await opts.sharedListCaller()).entries.map(sharedToExplorerRecord);
    };
    try {
      const records = await load();
      if (disposed || seq !== explorerSeq) return;
      if (records === null) {
        explorerRecords = [];
        explorerError = 'This collection is not wired in this host.';
      } else {
        explorerRecords = records;
        explorerError = undefined;
      }
    } catch (err) {
      if (disposed || seq !== explorerSeq) return;
      explorerRecords = [];
      explorerError = humanizeRpcError(err);
    } finally {
      if (!disposed && seq === explorerSeq) explorerLoading = false;
    }
  };

  /** Load an explorer tab: list its instances, auto-select the sole one (or wait
   *  for a pick), then fetch its records. Called from `refreshActive`; the outer
   *  generation guard there paints the result. */
  const loadExplorer = async (tab: DataTabId): Promise<void> => {
    if (isSingleCollectionTab(tab)) return loadSingleCollection(tab);
    const platform = EXPLORER_TAB_PLATFORM[tab];
    const seq = ++explorerSeq;
    // The display schema is keyed on the canonical collection name = the
    // CollectionPlatform (`file`), NOT the tab id (`files`). Using the tab id
    // would miss the schema (→ record_id titles). mail/calendar coincide, files
    // does not.
    explorerCollection = (platform ?? (tab as CollectionPlatform)) as CanonicalCollectionName;
    explorerDetail = null;
    explorerError = undefined;
    explorerLoading = true;
    const caller = opts.collectionListInstancesCaller;
    if (platform === undefined || caller === undefined) {
      explorerInstances = [];
      explorerSelectedSlug = null;
      explorerRecords = [];
      explorerLoading = false;
      if (caller === undefined) {
        explorerError = 'The collection explorer is not wired in this host.';
      }
      return;
    }
    try {
      const { instances } = await caller();
      if (disposed || seq !== explorerSeq) return;
      explorerInstances = instances.filter((i) => i.platform === platform);
      explorerSelectedSlug =
        explorerInstances.length === 1 ? explorerInstances[0]!.slug : null;
      explorerRecords = [];
      if (explorerSelectedSlug !== null) {
        await fetchExplorerRecords(platform, explorerSelectedSlug, seq);
      }
    } catch (err) {
      if (disposed || seq !== explorerSeq) return;
      explorerInstances = [];
      explorerRecords = [];
      explorerError = humanizeRpcError(err);
    } finally {
      if (!disposed && seq === explorerSeq) explorerLoading = false;
    }
  };

  /** Pick a different instance (only offered when >1) → fetch its records. */
  const selectExplorerInstance = async (slug: string): Promise<void> => {
    const platform = EXPLORER_TAB_PLATFORM[activeTab];
    if (platform === undefined || slug === explorerSelectedSlug) return;
    explorerSelectedSlug = slug;
    explorerRecords = [];
    explorerDetail = null;
    explorerLoading = true;
    render();
    syncDataHash(); // switching instance drops the open record → `#data/<tab>`
    const seq = ++explorerSeq;
    await fetchExplorerRecords(platform, slug, seq);
    if (disposed || seq !== explorerSeq) return;
    explorerLoading = false;
    render();
  };

  /** Open one record's detail (lazy `collection.get`). */
  const openExplorerRecord = async (record_id: string): Promise<void> => {
    if (isSingleCollectionTab(activeTab)) {
      // The single-collection list already holds full records — no `get` rpc.
      // Store ONLY the id; `renderExplorerTab` resolves it against the CURRENT
      // `explorerRecords` each render, so a concurrent live refresh that swapped
      // the list never leaves a stale detail (and a since-removed record shows
      // the engine's "no longer exists" state).
      explorerDetail = { record_id, loading: false };
      render();
      syncDataHash(); // reflect the open record as `#data/<tab>/<record_id>`
      return;
    }
    const platform = EXPLORER_TAB_PLATFORM[activeTab];
    const caller = opts.collectionGetCaller;
    if (platform === undefined || explorerSelectedSlug === null) return;
    const slug = explorerSelectedSlug;
    explorerDetail = { record_id, loading: true };
    render();
    syncDataHash(); // reflect the open record as `#data/<tab>/<record_id>`
    if (caller === undefined) {
      explorerDetail = { record_id, loading: false, error: 'Record detail is not wired in this host.' };
      render();
      return;
    }
    const seq = ++explorerSeq;
    explorerTimeline = null; // drop the prior record's timeline
    rescheduleForm = null; // D-210 R-4 — drop a stale reschedule form on record switch
    let loadedRecord: CollectionRecord | null = null;
    try {
      const { record } = await caller({ platform, slug, record_id });
      if (disposed || seq !== explorerSeq) return;
      explorerDetail = { record_id, loading: false, record };
      loadedRecord = record;
    } catch (err) {
      if (disposed || seq !== explorerSeq) return;
      explorerDetail = { record_id, loading: false, error: humanizeRpcError(err) };
    }
    render();
    // D-210 step 3 — after the record renders, lazily fetch a calendar event's
    // timeline (its move history) and re-render. Calendar-only + best-effort:
    // a failure leaves the detail without a timeline, never blocking the record
    // view. Keyed on the event's `source_id` — the `calendar:<source_id>`
    // subject the D-120 write links + the D-119 `scheduled-from` origin edge
    // are written against.
    if (platform === 'calendar' && loadedRecord !== null && opts.timelineCaller !== undefined) {
      const sourceId =
        typeof loadedRecord.source_id === 'string' ? loadedRecord.source_id : '';
      if (sourceId.length > 0) {
        try {
          const response = await opts.timelineCaller({
            entity_id: `calendar:${sourceId}`,
            limit: CALENDAR_TIMELINE_LIMIT,
          });
          if (disposed || seq !== explorerSeq) return;
          explorerTimeline = response.entries;
          render();
        } catch {
          // best-effort — no timeline on failure
        }
      }
    }
  };

  const closeExplorerDetail = (): void => {
    explorerDetail = null;
    explorerTimeline = null; // D-210 step 3 — drop the closed record's timeline
    rescheduleForm = null; // D-210 R-4 — drop the reschedule form on close
    // Abandon any in-flight `collection.get` — without this bump its
    // `seq === explorerSeq` guard still passes and reinstates the detail view
    // (+ the Files download button) after the user navigated Back.
    explorerSeq += 1;
    render();
    syncDataHash(); // back to the list → `#data/<tab>`
  };

  const refreshActive = async (silent = false): Promise<void> => {
    const generation = ++loadGeneration;
    // A full refresh REPLACES the list from offset 0 — the generation bump above
    // already invalidates any in-flight append, so clear its footer spinner too.
    loadingMoreContacts = false;
    loadingMoreWorkEntities = false;
    loadingMoreFormResponses = false;

    // D-198 Slice 1b — the Memory lens loads the feed, not a tab collection.
    // Orthogonal to `activeTab`; the feed drives its own loading + error state.
    if (activeLens === 'memory') {
      if (!silent) {
        memoryLoading = true;
        render();
      }
      await refreshMemory(generation);
      if (disposed || generation !== loadGeneration) return;
      memoryLoading = false;
      render();
      return;
    }

    // R18 — a live-update (warehouse/memory) refreshes SILENTLY: no loading flash
    // over the list the user is reading; the fresh data swaps in on the final
    // render below. A user-driven refresh keeps the loading state.
    if (!silent) {
      loading = true;
      errors = {};
      render();
    }

    const nextErrors: DataLoadErrors = {};
    if (activeTab === 'contact') {
      // D-205 #2c — in PARALLEL: the strip diagnoses the list, so making the user
      // wait for one before the other buys nothing, and a slow Source-health read
      // must not delay the contacts themselves.
      await Promise.all([
        refreshContacts(nextErrors, generation),
        refreshContactSources(generation),
      ]);
    } else if (isReceivedTab(activeTab)) {
      await refreshFormResponses(nextErrors, generation);
    } else if (isWorkEntityTab(activeTab)) {
      // Source topology is a dependency of work-entity browsing only. Keep
      // contacts, accepted forms, and connected mirrors usable when the Source
      // management slice is absent or recovering.
      await refreshSources(nextErrors, generation);
      await refreshWorkEntities(nextErrors, generation);
    } else if (isExplorerTab(activeTab) || isSingleCollectionTab(activeTab)) {
      // D-198 Slice 5 — the explorer owns its own async guard (`explorerSeq`) +
      // error state; the outer generation guard below still gates the paint.
      // Phase 2: provenance tabs (annotation / link) load through the same path.
      await loadExplorer(activeTab);
    }

    if (disposed || generation !== loadGeneration) return;
    errors = nextErrors;
    loading = false;
    render();
  };

  const startRefresh = (): void => {
    pendingLoadPromise = refreshActive();
  };

  // R18 — reflect the current (tab, open-entity) as `#data/<tab>/<id>` in the
  // URL via `replaceState` (R16 addressability) — no hashchange, so the shell
  // does NOT remount (master-detail stays smooth) but a refresh / shared link
  // re-opens the same view. Reads state so the URL always matches what's
  // rendered. Guarded for the test fake DOM (no `defaultView`); replaceState can
  // throw in sandboxed embeddings, so it is best-effort.
  const currentDeepLinkEntity = (): string | undefined => {
    // D-205 #2b — the scan page is the reserved `scan` literal; otherwise the
    // open contact's email. Only one of the two can be open at a time.
    if (activeTab === 'contact') {
      if (contactScan !== null) return DATA_ROUTE_CONTACT_SCAN_SEGMENT;
      // D-205 #5b — the import page is the reserved `import` literal. Only ever ONE
      // of scan / import / detail is open, so the segment has one answer.
      if (contactImport !== null) return DATA_ROUTE_CONTACT_IMPORT_SEGMENT;
      return contactDetail?.email;
    }
    if (isReceivedTab(activeTab)) return formResponseDetailId ?? undefined;
    // D-198 — an OPEN explorer / single-collection record is the addressable id
    // (`#data/<tab>/<record_id>`), so a refresh / shared link re-opens it.
    if ((isExplorerTab(activeTab) || isSingleCollectionTab(activeTab)) && explorerDetail !== null) {
      return explorerDetail.record_id;
    }
    if (isMirrorTab(activeTab) && timelineEntityId.length > 0) {
      return timelineEntityId;
    }
    // Work-entity detail IS the edit dialog — the edited entity is the
    // addressable id, so an open edit dialog keeps `#data/<kind>/<id>` in the
    // URL (a refresh / shared link re-opens it, symmetric with the timeline
    // tabs). Create mode has no id, so it stays `#data/<kind>`.
    if (isWorkEntityTab(activeTab) && workEntityState.dialog?.mode === 'edit') {
      return workEntityState.dialog.entity_id;
    }
    return undefined;
  };
  const syncDataHash = (): void => {
    const history = doc.defaultView?.history;
    if (history?.replaceState === undefined) return;
    // D-198 Slice 1b — the Memory lens addresses as `#data/memory` (no entity
    // segment); the Data lens keeps `#data/<tab>/<entity>`.
    const hash = activeLens === 'memory'
      ? serializeShellRoute('data', 'memory')
      : serializeShellRoute('data', activeTab, currentDeepLinkEntity());
    try {
      history.replaceState(null, '', hash);
    } catch {
      // Non-fatal — addressability degrades to in-page-only.
    }
  };

  const selectTab = async (tab: DataTabId): Promise<void> => {
    if (activeTab === tab) return;
    activeTab = tab;
    contactDialog = null;
    resetFormResponseAutomation();
    formResponseDetailSeq += 1;
    formResponseDetailId = null;
    formResponseDetail = null;
    formResponseDetailError = null;
    loadingFormResponseDetail = false;
    // An entity_id from one mirror kind doesn't apply to another (the
    // timeline display is kind-gated anyway) — start each tab fresh.
    timelineEntityId = '';
    // D-198 Slice 5 — drop any prior explorer records/detail; `refreshActive`
    // reloads for the new tab if it's an explorer tab.
    resetExplorerState();
    if (isWorkEntityTab(tab)) {
      workEntityState = selectKindTransition(workEntityState, tab);
    }
    syncDataHash();
    pendingLoadPromise = refreshActive();
    await pendingLoadPromise;
  };

  // D-198 Slice 1b — switch the Data | Memory lens. Orthogonal to the tab; the
  // Data lens preserves its active tab + open detail when you come back.
  const selectLens = async (lens: 'data' | 'memory'): Promise<void> => {
    if (activeLens === lens) return;
    if (lens === 'memory') closeFormResponseRunModal();
    activeLens = lens;
    syncDataHash();
    pendingLoadPromise = refreshActive();
    await pendingLoadPromise;
  };

  const setMemoryOriginFilter = async (filter: MemoryOriginFilter): Promise<void> => {
    if (memoryOriginFilter === filter) return;
    memoryOriginFilter = filter;
    pendingLoadPromise = refreshActive();
    await pendingLoadPromise;
  };

  // ── D-198 Slice 2 — owner memory CRUD (compose / detail / delete) ─────────

  /** Read the uncontrolled compose inputs from the DOM. The `onInput` handler
   *  keeps state synced between renders; this is the belt-and-braces read at
   *  submit, mirroring `syncContactDialogFromDom`. */
  const syncMemoryComposeFromDom = (): void => {
    if (!memoryCompose.open) return;
    const read = (field: string): string | undefined => {
      const el = routeRoot.querySelector(
        `[${MEMORY_FIELD_ATTR}="${field}"]`,
      ) as HTMLInputElement | HTMLTextAreaElement | null;
      return el === null ? undefined : el.value;
    };
    const kind = read('kind');
    const summary = read('summary');
    const body = read('body');
    memoryCompose = {
      ...memoryCompose,
      ...(kind !== undefined ? { kind } : {}),
      ...(summary !== undefined ? { summary } : {}),
      ...(body !== undefined ? { body } : {}),
    };
  };

  const openMemoryCompose = (): void => {
    memoryCompose = { open: true, mode: 'create', kind: '', summary: '', body: '', submitting: false };
    memoryDetail = null;
    memoryPendingDeleteId = undefined;
    render();
  };

  const cancelMemoryCompose = (): void => {
    memoryCompose = { ...memoryCompose, open: false, submitting: false, error: undefined };
    render();
  };

  /** Open the compose form in EDIT mode, prefilled from the full entry
   *  (`memory.get` resolves the body). Own (`user_self`) rows only. */
  const openMemoryEdit = async (memory_id: string): Promise<void> => {
    const getCaller = opts.memoryGetCaller;
    if (getCaller === undefined) return;
    memoryPendingDeleteId = undefined;
    try {
      const entry = await getCaller({ memory_id });
      if (disposed) return;
      if (entry.origin_actor !== 'user_self') return; // view-only rows aren't editable
      memoryCompose = {
        open: true,
        mode: 'edit',
        editId: memory_id,
        kind: entry.kind,
        summary: entry.summary ?? '',
        body: entry.body ?? '',
        submitting: false,
      };
      memoryDetail = null;
      render();
    } catch (err) {
      if (disposed) return;
      memoryError = errMessage(err);
      render();
    }
  };

  const submitMemoryCompose = async (): Promise<void> => {
    syncMemoryComposeFromDom();
    if (memoryCompose.kind.trim().length === 0) {
      memoryCompose = { ...memoryCompose, error: 'Kind is required.' };
      render();
      return;
    }
    const createCaller = opts.memoryCreateCaller;
    const updateCaller = opts.memoryUpdateCaller;
    const isEdit = memoryCompose.mode === 'edit' && memoryCompose.editId !== undefined;
    if (isEdit ? updateCaller === undefined : createCaller === undefined) {
      memoryCompose = { ...memoryCompose, error: 'Memory writes are not wired in this host.' };
      render();
      return;
    }
    const draft = { kind: memoryCompose.kind, summary: memoryCompose.summary, body: memoryCompose.body };
    const editId = memoryCompose.editId;
    memoryCompose = { ...memoryCompose, submitting: true, error: undefined };
    render();
    try {
      if (isEdit && editId !== undefined && updateCaller !== undefined) {
        await updateCaller({ memory_id: editId, kind: draft.kind, summary: draft.summary, body: draft.body });
      } else if (createCaller !== undefined) {
        await createCaller({
          kind: draft.kind,
          ...(draft.summary.length > 0 ? { summary: draft.summary } : {}),
          body: draft.body,
        });
      }
      if (disposed) return;
      memoryCompose = { open: false, mode: 'create', kind: '', summary: '', body: '', submitting: false };
      pendingLoadPromise = refreshActive();
      await pendingLoadPromise;
    } catch (err) {
      if (disposed) return;
      memoryCompose = { ...memoryCompose, submitting: false, error: errMessage(err) };
      render();
    }
  };

  /** Open the detail view; lazy-loads the full body via `memory.get`. */
  const openMemoryDetail = async (memory_id: string): Promise<void> => {
    const getCaller = opts.memoryGetCaller;
    if (getCaller === undefined) return;
    memoryPendingDeleteId = undefined;
    memoryDetail = { memory_id, loading: true };
    render();
    try {
      const entry = await getCaller({ memory_id });
      if (disposed || memoryDetail?.memory_id !== memory_id) return;
      memoryDetail = { memory_id, loading: false, entry };
      render();
    } catch (err) {
      if (disposed || memoryDetail?.memory_id !== memory_id) return;
      memoryDetail = { memory_id, loading: false, error: errMessage(err) };
      render();
    }
  };

  const closeMemoryDetail = (): void => {
    memoryDetail = null;
    memoryPendingDeleteId = undefined;
    render();
  };

  const requestMemoryDelete = (memory_id: string): void => {
    memoryPendingDeleteId = memory_id;
    render();
  };

  const cancelMemoryDelete = (): void => {
    memoryPendingDeleteId = undefined;
    render();
  };

  const confirmMemoryDelete = async (memory_id: string): Promise<void> => {
    const deleteCaller = opts.memoryDeleteCaller;
    if (deleteCaller === undefined) return;
    memoryPendingDeleteId = undefined;
    try {
      await deleteCaller({ memory_id });
      if (disposed) return;
      if (memoryDetail?.memory_id === memory_id) memoryDetail = null;
      pendingLoadPromise = refreshActive();
      await pendingLoadPromise;
    } catch (err) {
      if (disposed) return;
      memoryError = errMessage(err);
      render();
    }
  };

  // D-198 Slice 3 — bulk import (paste JSON → memory.import).

  const syncMemoryImportFromDom = (): void => {
    if (!memoryImport.open) return;
    const el = routeRoot.querySelector(
      `[${MEMORY_FIELD_ATTR}="import"]`,
    ) as HTMLTextAreaElement | null;
    if (el !== null) memoryImport = { ...memoryImport, text: el.value };
  };

  const openMemoryImport = (): void => {
    memoryImport = { open: true, text: '', submitting: false };
    memoryCompose = { ...memoryCompose, open: false };
    memoryDetail = null;
    memoryPendingDeleteId = undefined;
    render();
  };

  const cancelMemoryImport = (): void => {
    memoryImport = { open: false, text: '', submitting: false };
    render();
  };

  const submitMemoryImport = async (): Promise<void> => {
    syncMemoryImportFromDom();
    const importCaller = opts.memoryImportCaller;
    if (importCaller === undefined) {
      memoryImport = { ...memoryImport, error: 'Memory import is not wired in this host.' };
      render();
      return;
    }
    // Accept `{ entries: [...] }` (an export envelope) or a bare `[...]` array.
    let entries: unknown;
    try {
      const parsed: unknown = JSON.parse(memoryImport.text);
      entries = Array.isArray(parsed)
        ? parsed
        : parsed !== null && typeof parsed === 'object'
          ? (parsed as { entries?: unknown }).entries
          : undefined;
    } catch {
      memoryImport = { ...memoryImport, error: 'Could not parse JSON — paste a valid export.' };
      render();
      return;
    }
    if (!Array.isArray(entries)) {
      memoryImport = { ...memoryImport, error: 'Expected an "entries" array (or a bare array).' };
      render();
      return;
    }
    memoryImport = { ...memoryImport, submitting: true, error: undefined, result: undefined };
    render();
    try {
      const result = await importCaller({ entries: entries as MemoryImportRequest['entries'] });
      if (disposed) return;
      // Keep the panel open showing the tally; the feed refreshes underneath.
      memoryImport = { ...memoryImport, submitting: false, result };
      pendingLoadPromise = refreshActive();
      await pendingLoadPromise;
    } catch (err) {
      if (disposed) return;
      memoryImport = { ...memoryImport, submitting: false, error: errMessage(err) };
      render();
    }
  };

  /** Serialize the assembled entries to a downloaded JSON file (round-trips
   *  `memory.import`). Blob object-URL, degrading to a `data:` URL when Blob /
   *  URL aren't available (older / sandboxed embeddings). */
  const triggerMemoryDownload = (entries: MemoryImportEntry[]): void => {
    const json = JSON.stringify({ entries }, null, 2);
    const stamp = new Date((opts.now ?? Date.now)()).toISOString().slice(0, 10);
    const filename = `recued-memory-${stamp}.json`;
    const view = doc.defaultView;
    const clickDownload = (href: string): void => {
      const a = doc.createElement('a');
      a.href = href;
      a.download = filename;
      doc.body.appendChild(a);
      a.click();
      a.remove();
    };
    try {
      if (view?.URL?.createObjectURL !== undefined && typeof view.Blob === 'function') {
        const url = view.URL.createObjectURL(new view.Blob([json], { type: 'application/json' }));
        clickDownload(url);
        view.URL.revokeObjectURL(url);
        return;
      }
    } catch {
      /* fall through to the data: URL path */
    }
    clickDownload(`data:application/json;charset=utf-8,${encodeURIComponent(json)}`);
  };

  /** Memory-native export (§ export): walk the WHOLE feed under the active
   *  origin filter, resolve each body-carrying row's full body via `memory.get`
   *  (the feed ships only previews), assemble a `{ entries }` payload that
   *  `memory.import` round-trips, and download it. */
  const exportMemory = async (): Promise<void> => {
    const listCaller = opts.memoryListCaller;
    if (listCaller === undefined || memoryExporting) return;
    const EXPORT_PAGE_SIZE = 200;
    const EXPORT_MAX_PAGES = 200; // hard walk cap (≤ 40k entries) — never loops
    memoryExporting = true;
    memoryError = undefined;
    render();
    try {
      const actors = memoryFilterActors(memoryOriginFilter);
      const listed: MemoryListEntry[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const resp = await listCaller({
          ...(actors ? { origin_actors: actors } : {}),
          limit: EXPORT_PAGE_SIZE,
          ...(cursor ? { cursor } : {}),
        });
        listed.push(...resp.entries);
        cursor = resp.next_cursor;
        pages += 1;
      } while (cursor !== undefined && pages < EXPORT_MAX_PAGES);

      const getCaller = opts.memoryGetCaller;
      const entries: MemoryImportEntry[] = [];
      for (const row of listed) {
        const entry: MemoryImportEntry = {
          memory_id: row.memory_id,
          origin_actor: row.origin_actor,
          kind: row.kind,
          ts: row.ts,
        };
        if (row.summary !== undefined) entry.summary = row.summary;
        if (row.event_at !== undefined) entry.event_at = row.event_at;
        if (row.reason_code !== undefined) entry.reason_code = row.reason_code;
        if (row.links !== undefined && row.links.length > 0) {
          entry.provenance_entity_ids = row.links.map((l) => l.entity_id);
        }
        if (row.has_body === true && getCaller !== undefined) {
          try {
            const full = await getCaller({ memory_id: row.memory_id });
            if (full.body !== undefined) entry.body = full.body;
          } catch {
            /* an unreadable body still exports its metadata */
          }
        }
        entries.push(entry);
      }
      if (disposed) return;
      triggerMemoryDownload(entries);
    } catch (err) {
      if (disposed) return;
      memoryError = errMessage(err);
    } finally {
      if (!disposed) {
        memoryExporting = false;
        render();
      }
    }
  };

  const activeWorkEntityDefinition = (): FormDefinition => {
    const activeSourceId =
      workEntityState.dialog?.source_id ?? workEntityState.selected_source_id;
    const activeSource = activeSourceId === null
      ? undefined
      : enabledSourcesForKind(sources, workEntityState.kind).find(
          (source) => source.id === activeSourceId,
        );
    return formDefinitionForKind(workEntityState.kind, activeSource);
  };

  const openCreateWorkEntityDialog = (): void => {
    const sourceId = resolveCreateDialogSourceId(
      workEntityState.kind,
      workEntityState.selected_source_id,
      defaultsByKind[workEntityState.kind] ?? null,
      enabledSourcesForKind(sources, workEntityState.kind),
    );
    if (sourceId === null) return;
    // Bump the open sequence so an edit fetch still in flight (its dialog not
    // yet installed) can't resolve later and clobber this create dialog.
    workEntityDialogOpenSeq += 1;
    workEntityState = openCreateDialogTransition(
      workEntityState,
      sourceId,
      initialValuesForKind(workEntityState.kind),
    );
    syncDataHash(); // create has no entity id → drops any prior edit id
    render();
  };

  const openEditWorkEntityDialog = async (
    kind: WorkEntityKind,
    id: string,
  ): Promise<void> => {
    const seq = ++workEntityDialogOpenSeq;
    if (activeTab !== kind) {
      activeTab = kind;
      workEntityState = selectKindTransition(workEntityState, kind);
    }
    let entity: WorkEntity | null =
      workEntities.find((row) => row._kind === kind && row.id === id) ?? null;
    if (opts.workEntityGetCaller !== undefined) {
      try {
        const response = await opts.workEntityGetCaller({ kind, id });
        entity = response.entity;
      } catch (err) {
        if (disposed || seq !== workEntityDialogOpenSeq) return;
        errors = { ...errors, work_entities: errMessage(err) };
        render();
        return;
      }
    }
    // A newer open (any kind) or a tab switch away happened while the fetch was
    // in flight → don't install this now-stale dialog / URL.
    if (disposed || seq !== workEntityDialogOpenSeq || activeTab !== kind) return;
    if (entity === null) {
      errors = { ...errors, work_entities: `No ${kind} was returned for ${id}.` };
      render();
      return;
    }
    workEntityState = openEditDialogTransition(
      workEntityState,
      entity,
      getCanonicalSchema(kind),
    );
    const extensionValues = sourceExtensionValuesFromEntity(
      activeWorkEntityDefinition(),
      entity,
    );
    if (Object.keys(extensionValues).length > 0 && workEntityState.dialog !== null) {
      workEntityState = setDialogValuesTransition(workEntityState, {
        ...workEntityState.dialog.values,
        ...extensionValues,
      });
    }
    syncDataHash(); // the edit dialog's entity is now the addressable id
    render();
  };

  const setWorkEntityDialogValues = (
    values: Record<string, unknown>,
  ): void => {
    workEntityState = setDialogValuesTransition(workEntityState, values);
    render();
  };

  const syncWorkEntityDialogFromDom = (): void => {
    if (workEntityState.dialog === null) return;
    // Same fake-DOM guard as `mountWorkEntityRefPickers`: a string-only
    // host can't be read, so the synced state stays as last set.
    if (typeof routeRoot.querySelector !== 'function') return;
    const form = routeRoot.querySelector('.work-entity-dialog-form');
    if (form === null) return;
    const values = readFormValues(form, activeWorkEntityDefinition());
    workEntityState = setDialogValuesTransition(workEntityState, values);
  };

  /** Append an empty row to a `data.contact` ref array (note/project
   *  related contacts). We snapshot the live DOM first so already-picked
   *  rows + other typed inputs survive the re-render, then re-render
   *  (which re-wires the pickers, including the new empty one). */
  const addWorkEntityArrayItem = (field: string): void => {
    if (workEntityState.dialog === null) return;
    syncWorkEntityDialogFromDom();
    if (workEntityState.dialog === null) return;
    const current = workEntityState.dialog.values[field];
    const next = Array.isArray(current) ? [...current, ''] : [''];
    setWorkEntityDialogValues({
      ...workEntityState.dialog.values,
      [field]: next,
    });
  };

  const removeWorkEntityArrayItem = (field: string, index: number): void => {
    if (workEntityState.dialog === null) return;
    if (!Number.isInteger(index) || index < 0) return;
    syncWorkEntityDialogFromDom();
    if (workEntityState.dialog === null) return;
    const current = workEntityState.dialog.values[field];
    if (!Array.isArray(current)) return;
    const next = current.filter((_, i) => i !== index);
    setWorkEntityDialogValues({
      ...workEntityState.dialog.values,
      [field]: next,
    });
  };

  const confirmWorkEntityDialog = async (): Promise<void> => {
    if (workEntityState.dialog === null) return;
    if (opts.workEntityUpsertCaller === undefined) {
      workEntityState = setDialogSubmitErrorTransition(
        workEntityState,
        'work_entity.upsert caller is not wired in this host.',
      );
      render();
      return;
    }

    const definition = activeWorkEntityDefinition();
    const fieldErrors = validateForm(definition, workEntityState.dialog.values);
    if (fieldErrors.length > 0) {
      workEntityState = setDialogErrorsTransition(
        workEntityState,
        validationMap(fieldErrors),
      );
      render();
      return;
    }

    let request: WorkEntityUpsertRpcRequest;
    try {
      request = projectWorkEntityUpsert(
        workEntityState.kind,
        workEntityState,
        definition,
      );
    } catch (err) {
      workEntityState = setDialogSubmitErrorTransition(
        workEntityState,
        errMessage(err),
      );
      render();
      return;
    }

    workEntityState = setDialogSubmittingTransition(workEntityState, true);
    workEntityState = setDialogSubmitErrorTransition(workEntityState, null);
    render();
    try {
      await opts.workEntityUpsertCaller(request);
      if (disposed) return;
      workEntityState = closeDialogTransition(
        setDialogSubmittingTransition(workEntityState, false),
      );
      syncDataHash(); // dialog closed → drop the entity id from the URL
      pendingLoadPromise = refreshActive();
      await pendingLoadPromise;
    } catch (err) {
      if (disposed) return;
      workEntityState = setDialogSubmittingTransition(workEntityState, false);
      workEntityState = setDialogSubmitErrorTransition(
        workEntityState,
        errMessage(err),
      );
      render();
    }
  };

  const deleteWorkEntity = async (
    kind: WorkEntityKind,
    id: string,
  ): Promise<void> => {
    if (opts.workEntityDeleteCaller === undefined) {
      errors = { ...errors, work_entities: 'work_entity.delete caller is not wired in this host.' };
      render();
      return;
    }
    try {
      await opts.workEntityDeleteCaller({ kind, id });
      // If the edit dialog for the just-deleted entity is open, close it (and
      // drop its now-dangling id from the URL) so nothing addresses a gone row.
      if (
        workEntityState.dialog?.mode === 'edit'
        && workEntityState.dialog.entity_id === id
      ) {
        workEntityState = closeDialogTransition(workEntityState);
        syncDataHash();
      }
      pendingLoadPromise = refreshActive();
      await pendingLoadPromise;
    } catch (err) {
      errors = { ...errors, work_entities: errMessage(err) };
      render();
    }
  };

  const openCreateContactDialog = (): void => {
    contactDialog = {
      mode: 'create',
      values: emptyContactValues(),
      errors: {},
      submitting: false,
      submit_error: null,
    };
    render();
  };

  const openEditContactDialog = async (email: string): Promise<void> => {
    let contact = contacts.find((row) => row.email === email) ?? null;
    if (opts.contactGetCaller !== undefined) {
      try {
        const response = await opts.contactGetCaller({ email });
        contact = response.contact;
      } catch (err) {
        errors = { ...errors, contacts: errMessage(err) };
        render();
        return;
      }
    }
    if (contact === null) {
      errors = { ...errors, contacts: `No contact was returned for ${email}.` };
      render();
      return;
    }
    contactDialog = {
      mode: 'edit',
      values: contactValuesFromRecord(contact),
      errors: {},
      submitting: false,
      submit_error: null,
    };
    render();
  };

  const setContactDialogValues = (
    values: Partial<ContactDialogValues>,
  ): void => {
    if (contactDialog === null) return;
    contactDialog = {
      ...contactDialog,
      values: { ...contactDialog.values, ...values },
      errors: {},
      submit_error: null,
    };
    render();
  };

  const syncContactDialogFromDom = (): void => {
    if (contactDialog === null) return;
    const next = { ...contactDialog.values };
    for (const key of Object.keys(next) as Array<keyof ContactDialogValues>) {
      const input = routeRoot.querySelector(
        `[${DATA_ROUTE_CONTACT_FIELD_ATTR}="${key}"]`,
      ) as HTMLInputElement | null;
      if (input !== null) next[key] = input.value;
    }
    contactDialog = { ...contactDialog, values: next };
  };

  const confirmContactDialog = async (): Promise<void> => {
    if (contactDialog === null) return;
    if (opts.contactUpsertCaller === undefined) {
      contactDialog = {
        ...contactDialog,
        submit_error: 'contact.upsert caller is not wired in this host.',
      };
      render();
      return;
    }
    const dialogErrors = validateContactDialog(contactDialog.values);
    if (hasContactErrors(dialogErrors)) {
      contactDialog = { ...contactDialog, errors: dialogErrors };
      render();
      return;
    }
    contactDialog = { ...contactDialog, submitting: true, submit_error: null };
    render();
    const editedEmail = contactDialog.values.email.trim();
    try {
      await opts.contactUpsertCaller(contactUpsertArgs(contactDialog.values));
      if (disposed) return;
      contactDialog = null;
      pendingLoadPromise = refreshActive();
      await pendingLoadPromise;
      if (disposed) return;
      // D-205 #2 — an edit made FROM the detail page must re-fetch it, not just
      // the list behind it. A manual write lands as a `manual` contribution,
      // which sits at the TOP of the C-2a ladder — so it does not merely change
      // the value, it changes the WINNER, and with it every provenance line the
      // page is showing. Leaving the open detail on the pre-edit record would
      // keep rendering "from HubSpot" under a value the user just typed.
      if (contactDetail !== null && contactDetail.email === editedEmail) {
        await openContactDetail(editedEmail);
      }
    } catch (err) {
      if (disposed || contactDialog === null) return;
      contactDialog = {
        ...contactDialog,
        submitting: false,
        submit_error: errMessage(err),
      };
      render();
    }
  };

  const deleteContact = async (email: string): Promise<void> => {
    if (opts.contactDeleteCaller === undefined) {
      errors = { ...errors, contacts: 'contact.delete caller is not wired in this host.' };
      render();
      return;
    }
    try {
      await opts.contactDeleteCaller({ email });
      contactDialog = null;
      pendingLoadPromise = refreshActive();
      await pendingLoadPromise;
    } catch (err) {
      errors = { ...errors, contacts: errMessage(err) };
      render();
    }
  };

  const closeFormResponseRunModal = (): void => {
    const open = formResponseRunModal;
    formResponseRunModal = null;
    open?.destroy();
  };

  const resetFormResponseAutomation = (): void => {
    formResponseAutomationSeq += 1;
    formResponseAutomationState = { status: 'idle' };
    closeFormResponseRunModal();
  };

  const discoverFormResponseAutomations = async (): Promise<void> => {
    const response = formResponseDetail;
    const listCaller = opts.recipeListCaller;
    if (
      response === null
      || listCaller === undefined
      || opts.recipeExecuteCaller === undefined
    ) {
      return;
    }
    const seq = ++formResponseAutomationSeq;
    const detailSeq = formResponseDetailSeq;
    formResponseAutomationState = { status: 'loading' };
    render();
    try {
      const result = await listCaller();
      if (
        disposed
        || seq !== formResponseAutomationSeq
        || detailSeq !== formResponseDetailSeq
        || formResponseDetail !== response
      ) {
        return;
      }
      formResponseAutomationState = {
        status: 'ready',
        matches: findFormResponseAutomationsForResponse(
          result.recipes,
          response,
        ),
      };
    } catch (error: unknown) {
      if (
        disposed
        || seq !== formResponseAutomationSeq
        || detailSeq !== formResponseDetailSeq
      ) {
        return;
      }
      formResponseAutomationState = {
        status: 'error',
        message: `Couldn’t load saved automations: ${humanizeRpcError(error)}`,
      };
    }
    render();
  };

  const reviewFormResponseAutomation = (recipe_id: string): void => {
    if (
      formResponseRunModal !== null
      || formResponseDetail === null
      || formResponseAutomationState.status !== 'ready'
      || opts.recipeExecuteCaller === undefined
    ) {
      return;
    }
    const match = formResponseAutomationState.matches.find(
      (candidate) => candidate.entry.recipe_id === recipe_id,
    );
    if (match === undefined) return;

    let handle: RunModal.RunModalHandle | null = null;
    try {
      handle = RunModal.wireRunModal({
        recipe: match.entry,
        document: doc,
        initialTab: 'run',
        execute: opts.recipeExecuteCaller,
        ...(opts.mirrorSearchCaller !== undefined
          ? { fileRefSearch }
          : {}),
        onClose: () => {
          if (formResponseRunModal === handle) formResponseRunModal = null;
        },
      });
      handle.setContextValues(
        buildFormResponseManualRunContext(formResponseDetail),
      );
      formResponseRunModal = handle;
      const portal = (doc as { body?: HTMLElement }).body ?? opts.root;
      portal.appendChild(handle.element);
    } catch (error: unknown) {
      handle?.destroy();
      formResponseRunModal = null;
      formResponseAutomationState = {
        status: 'error',
        message: `Couldn’t open run review: ${humanizeRpcError(error)}`,
      };
      render();
    }
  };

  const confirmFormResponseAutomationRun = (): Promise<void> =>
    formResponseRunModal?.confirmRun() ?? Promise.resolve();

  const openFormResponse = async (submission_id: string): Promise<void> => {
    if (submission_id.trim().length === 0) return;
    resetFormResponseAutomation();
    const seq = ++formResponseDetailSeq;
    if (!isReceivedTab(activeTab)) activeTab = 'form_response';
    formResponseDetailId = submission_id;
    formResponseDetail = null;
    formResponseDetailError = null;
    loadingFormResponseDetail = true;
    if (errors.form_responses !== undefined) {
      errors = { ...errors };
      delete errors.form_responses;
    }
    syncDataHash();
    render();
    try {
      if (opts.formResponseGetCaller === undefined) {
        throw new Error('form_response.get caller is not wired in this host.');
      }
      const result = await opts.formResponseGetCaller({ submission_id });
      if (
        disposed
        || seq !== formResponseDetailSeq
        || !isReceivedTab(activeTab)
        || formResponseDetailId !== submission_id
      ) return;
      formResponseDetail = result.response;
      formResponseDetailError = null;
    } catch (err) {
      if (disposed || seq !== formResponseDetailSeq) return;
      formResponseDetail = null;
      formResponseDetailError = errMessage(err);
      errors = { ...errors, form_responses: formResponseDetailError };
    } finally {
      if (!disposed && seq === formResponseDetailSeq) {
        loadingFormResponseDetail = false;
        syncDataHash();
        render();
      }
    }
  };

  const closeFormResponse = (): void => {
    resetFormResponseAutomation();
    formResponseDetailSeq += 1;
    formResponseDetailId = null;
    formResponseDetail = null;
    formResponseDetailError = null;
    loadingFormResponseDetail = false;
    if (errors.form_responses !== undefined) {
      errors = { ...errors };
      delete errors.form_responses;
    }
    syncDataHash();
    render();
  };

  const openTimelineDrilldown = async (
    kind: MirrorDataKind,
    entity_id: string,
  ): Promise<void> => {
    activeTab = kind;
    timelineEntityId = entity_id;
    syncDataHash();
    if (opts.timelineCaller === undefined) {
      errors = { ...errors, timeline: 'data.timeline caller is not wired in this host.' };
      render();
      return;
    }
    const trimmed = entity_id.trim();
    if (trimmed.length === 0) {
      timeline = null;
      render();
      return;
    }
    const resolved = trimmed.includes(':')
      ? trimmed
      : `${mirrorCollection(kind)}:${trimmed}`;
    loadingTimeline = true;
    const { timeline: _timelineBeforeLoad, ...withoutTimelineError } = errors;
    errors = withoutTimelineError;
    render();
    try {
      const response = await opts.timelineCaller({
        entity_id: resolved,
        limit: 50,
      });
      // Stale guard — drop if the user navigated to a different tab / entity
      // while this was in flight (a live-update re-fetch can race a fresh user
      // selection; mirrors openContactDetail — codex R18 MEDIUM).
      if (disposed || activeTab !== kind || timelineEntityId !== entity_id) return;
      timeline = { kind, entity_id: resolved, response };
      timelineEntityId = resolved;
      // Re-sync now the id is normalized so the URL matches the rendered entity
      // (codex R18 LOW): `#data/<kind>/<resolved>` round-trips to itself.
      syncDataHash();
      loadingTimeline = false;
      const { timeline: _timelineError, ...rest } = errors;
      errors = rest;
      render();
    } catch (err) {
      if (disposed || activeTab !== kind || timelineEntityId !== entity_id) return;
      timeline = { kind, entity_id: resolved, response: null };
      loadingTimeline = false;
      errors = { ...errors, timeline: errMessage(err) };
      render();
    }
  };

  // D-205 #2 — open the contact DETAIL (`#data/contact/<email>`): the projected
  // record (with its per-field provenance) plus the activity timeline.
  //
  // The two fetches are INDEPENDENT and neither is allowed to sink the other. A
  // failing `data.timeline` must still leave the identity + provenance block on
  // screen — that block is the reason the page exists, and it is exactly the case
  // where a user is most likely to be asking "where did this value come from?".
  // So both are settled, not raced, and each failure is reported in its own slot.
  const openContactDetail = async (email: string): Promise<void> => {
    const trimmed = email.trim();
    if (trimmed.length === 0) return;
    // Mutually exclusive with the scan page — see `openContactScan`.
    contactScan = null;
    contactScanSeq += 1;
    contactDetail = {
      email: trimmed,
      contact: null,
      response: null,
      contributions: [],
      contributions_failed: false,
    };
    syncDataHash();
    loadingContactDetail = true;
    // Clear only THIS page's two slots. `errors.contacts` belongs to the list
    // behind us and must survive — opening a detail is not evidence the list
    // loaded.
    const {
      timeline: _timelineBeforeLoad,
      contact_detail: _detailBeforeLoad,
      ...clearedErrors
    } = errors;
    errors = clearedErrors;
    render();

    // Fall back to the row already in the list when the host wires no
    // `contact.get` — the list record carries the projection (and its
    // provenance) too, since both come off the same `rowToRecord` mapper.
    const fetchContact = async (): Promise<
      { ok: true; contact: ContactRecord | null } | { ok: false; message: string }
    > => {
      if (opts.contactGetCaller === undefined) {
        return {
          ok: true,
          contact: contacts.find((c) => c.email === trimmed) ?? null,
        };
      }
      try {
        const { contact } = await opts.contactGetCaller({ email: trimmed });
        return { ok: true, contact };
      } catch (err) {
        return { ok: false, message: errMessage(err) };
      }
    };
    const fetchTimeline = async (): Promise<
      { ok: true; response: TimelineResponse | null } | { ok: false; message: string }
    > => {
      if (opts.timelineCaller === undefined) {
        return { ok: false, message: 'data.timeline caller is not wired in this host.' };
      }
      try {
        const response = await opts.timelineCaller({
          entity_id: `contact:${trimmed}`,
          limit: 50,
        });
        return { ok: true, response };
      } catch (err) {
        return { ok: false, message: errMessage(err) };
      }
    };
    // D-205 item 3 — what every OTHER source said. An UNWIRED caller is not an
    // error (the host simply does not offer the view, and the page renders exactly
    // as it did before); a FAILED one is, and it must say so — silently rendering no
    // other-sources list would tell the user "nothing else asserts this field",
    // which is a claim about their data, not about a failed fetch.
    const fetchContributions = async (): Promise<
      | { ok: true; contributions: readonly ContactContributionView[] }
      | { ok: false; message: string }
    > => {
      if (opts.contactContributionsCaller === undefined) {
        return { ok: true, contributions: [] };
      }
      try {
        const { contributions } = await opts.contactContributionsCaller({ email: trimmed });
        return { ok: true, contributions };
      } catch (err) {
        return { ok: false, message: errMessage(err) };
      }
    };

    const [contactResult, timelineResult, contributionsResult] = await Promise.all([
      fetchContact(),
      fetchTimeline(),
      fetchContributions(),
    ]);
    // Drop all three if the user navigated away / opened another contact in flight.
    if (disposed || contactDetail?.email !== trimmed) return;

    const nextErrors: DataLoadErrors = { ...errors };
    if (!contactResult.ok) nextErrors.contact_detail = contactResult.message;
    if (!timelineResult.ok) nextErrors.timeline = timelineResult.message;
    if (!contributionsResult.ok) nextErrors.contact_contributions = contributionsResult.message;
    contactDetail = {
      email: trimmed,
      contact: contactResult.ok ? contactResult.contact : null,
      response: timelineResult.ok ? timelineResult.response : null,
      contributions: contributionsResult.ok ? contributionsResult.contributions : [],
      contributions_failed: !contributionsResult.ok,
    };
    loadingContactDetail = false;
    errors = nextErrors;
    render();
  };

  // D-172 Half-A "open" — turn a `data.file.read` result into a browser save.
  // Guarded on the `window` blob/URL APIs (absent in the test fake DOM →
  // no-op, the caller assertion still holds).
  const triggerFileDownload = (file: {
    bytes_b64: string;
    mime_type: string;
    filename: string;
  }): void => {
    const view = doc.defaultView as unknown as {
      atob?: (s: string) => string;
      Blob?: typeof Blob;
      URL?: { createObjectURL(b: Blob): string; revokeObjectURL(u: string): void };
    } | null | undefined;
    if (!view?.atob || !view.Blob || !view.URL) return;
    const binary = view.atob(file.bytes_b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    const blob = new view.Blob([bytes], {
      type: file.mime_type || 'application/octet-stream',
    });
    const url = view.URL.createObjectURL(blob);
    const anchor = doc.createElement('a');
    anchor.href = url;
    anchor.download = file.filename || 'download';
    anchor.click();
    view.URL.revokeObjectURL(url);
  };

  const downloadFile = async (): Promise<void> => {
    if (opts.fileReadCaller === undefined || downloadingFile) return;
    // D-198 Slice 5 Phase 1c — the Files tab browses via the explorer, so the
    // download targets the OPEN record (the detail-bar button), not a raw-id box.
    // Pass the record_id WHOLE: the read path is keyed by the FULL id — a CAS
    // `file:<32hex>` (resolved by `collection.get`) or a D-192 vendor-mirror
    // `file:remote:<b64 scope>:<b64 target>` (resolved by `parseRemoteFileRecordId`
    // → lazy byte-fetch). Stripping the `file:` prefix breaks BOTH (an
    // unresolvable id → 404); the earlier strip only survived because the test
    // fixture used a prefix-less id.
    const recordId = (explorerDetail?.record_id ?? '').trim();
    if (recordId.length === 0) return;
    downloadingFile = true;
    const cleared = { ...errors };
    delete cleared.timeline;
    errors = cleared;
    render();
    try {
      const file = await opts.fileReadCaller({ record_id: recordId });
      if (disposed) return;
      triggerFileDownload(file);
    } catch (err) {
      if (disposed) return;
      errors = { ...errors, timeline: errMessage(err) };
    } finally {
      if (!disposed) {
        downloadingFile = false;
        render();
      }
    }
  };

  /** D-210 R-4 — run the reschedule recipe for the OPEN calendar event with the
   *  form's new start; the end shifts by the current duration (length preserved).
   *  On success re-opens the record to refresh the detail + move-history timeline.
   *  An `awaiting_approval` result means the move holds for the owner's approval
   *  (a `write` op under the D-209 ceiling); the visitor notification, if the
   *  event came from a booking, rides the reactive notify recipe separately. */
  const submitReschedule = async (): Promise<void> => {
    const caller = opts.recipeExecuteCaller;
    if (caller === undefined || rescheduleForm === null || rescheduleForm.submitting) return;
    const record = explorerDetail?.record ?? null;
    const slug = explorerSelectedSlug;
    const sourceId =
      record !== null && typeof record.source_id === 'string' ? record.source_id : '';
    if (record === null || slug === null || sourceId.length === 0) {
      rescheduleForm = { ...rescheduleForm, error: 'This event cannot be rescheduled.' };
      render();
      return;
    }
    const newStart = new Date(rescheduleForm.value).getTime();
    if (!Number.isFinite(newStart)) {
      rescheduleForm = { ...rescheduleForm, error: 'Pick a valid new start time.' };
      render();
      return;
    }
    const hot = record.hot_fields;
    const curStart = Number(hot.start_at);
    const curEnd = Number(hot.end_at);
    const durationMs =
      Number.isFinite(curStart) && Number.isFinite(curEnd) && curEnd > curStart
        ? curEnd - curStart
        : 0;
    const recordId = explorerDetail?.record_id ?? '';
    const keepValue = rescheduleForm.value;
    // Snapshot the explorer generation (NOT a bump — we start no load) so a
    // completion that lands AFTER the owner navigated away (opened another event,
    // went Back, switched tab) is dropped: otherwise success force-navigates back
    // here, and awaiting/failure resurrects THIS form's message over whatever is
    // now open. Mirrors `openExplorerRecord`'s `seq` guard.
    const seq = explorerSeq;
    rescheduleForm = { ...rescheduleForm, submitting: true, error: null };
    render();
    try {
      const res = await caller({
        recipe_id: 'reschedule-calendar-event',
        config: {
          calendar_slug: slug,
          event_source_id: sourceId,
          new_start_at: newStart,
          new_end_at: newStart + durationMs,
        },
      });
      if (disposed || seq !== explorerSeq) return;
      if (res.awaiting_approval === true) {
        rescheduleForm = { value: keepValue, submitting: false, error: 'This move is waiting for your approval.' };
        render();
        return;
      }
      if (res.success) {
        rescheduleForm = null;
        void openExplorerRecord(recordId); // refresh the detail + timeline
        return;
      }
      rescheduleForm = { value: keepValue, submitting: false, error: 'Reschedule failed. Please try again.' };
      render();
    } catch (err) {
      if (disposed || seq !== explorerSeq) return;
      rescheduleForm = { value: keepValue, submitting: false, error: errMessage(err) };
      render();
    }
  };

  const closeContactDetail = (): void => {
    if (contactDetail === null) return;
    contactDetail = null;
    loadingContactDetail = false;
    // The detail's failures die with the detail — carrying them back would show
    // an error banner over a list that is fine.
    const { timeline: _t, contact_detail: _d, ...rest } = errors;
    errors = rest;
    syncDataHash();
    render();
  };

  // ── D-205 #2b — the merge scan page ─────────────────────────────────────

  /** Load the pending queue and hydrate it into review clusters.
   *
   *  ⚠ The per-email fetch goes through `contact.get`, NOT the already-loaded
   *  `contacts` list. That list is CAPPED (and search-filtered), so reusing it
   *  would silently drop any cluster whose members fall outside the current page
   *  — and a duplicate that never renders is a duplicate never resolved, which is
   *  the exact failure this page exists to prevent. Correctness here needs
   *  completeness, so it pays for the round trips. */
  const hydrateMergeQueue = async (): Promise<void> => {
    const listCaller = opts.contactMergeListCaller;
    const getCaller = opts.contactGetCaller;
    if (contactScan === null || listCaller === undefined || getCaller === undefined) return;
    const seq = ++contactScanSeq;
    contactScan = { ...contactScan, loading: true };
    render();
    try {
      const { candidates } = await listCaller({ status: 'pending', limit: 50 });
      const emails = [...new Set(candidates.flatMap((c) => [c.email_a, c.email_b]))];
      const fetched = await Promise.all(
        emails.map(async (email) => {
          try {
            const { contact } = await getCaller({ email });
            return contact;
          } catch {
            // One unfetchable contact must not sink the whole queue — its cluster
            // drops (see `buildMergeItems`), the rest still review.
            return null;
          }
        }),
      );
      if (disposed || contactScan === null || seq !== contactScanSeq) return;
      const byEmail = new Map<string, ContactRecord>();
      for (const contact of fetched) {
        if (contact !== null) byEmail.set(contact.email, contact);
      }
      const items = buildMergeItems(candidates, byEmail);
      contactScan = {
        ...contactScan,
        loading: false,
        dialog: {
          // ⚠ Rebuild from `initialMergeReviewDialogState()`, NOT from the old
          // dialog. `survivor_overrides` is keyed by CURSOR — a position in the
          // queue — and a re-hydrate RE-INDEXES that queue (the cluster the user
          // just merged is gone, so everything after it shifts up by one).
          // Carrying the old map forward would silently apply a survivor the user
          // chose for cluster N to whatever cluster now sits at index N: a merge
          // committed against a person they never picked. Dropping the overrides
          // costs a re-pick; keeping them corrupts. Do not "optimize" this into a
          // spread of the previous dialog.
          ...initialMergeReviewDialogState(),
          items,
          // The cursor itself is safe to carry: it is a POSITION, and staying at
          // it lands the user on the next unresolved cluster rather than bouncing
          // them back to the top of the queue.
          cursor: Math.min(contactScan.dialog.cursor, Math.max(0, items.length - 1)),
        },
      };
      const { contact_merge: _cleared, ...rest } = errors;
      errors = rest;
      render();
    } catch (err) {
      if (disposed || contactScan === null || seq !== contactScanSeq) return;
      contactScan = { ...contactScan, loading: false };
      errors = { ...errors, contact_merge: errMessage(err) };
      render();
    }
  };

  const openContactScan = async (): Promise<void> => {
    if (!canReviewMerges) return;
    // The scan and the detail are mutually-exclusive views of the same tab, and
    // the renderer picks scan first — so leaving a detail open underneath would
    // silently resurrect it on close, and `currentDeepLinkEntity` would have two
    // candidate answers. Close it explicitly rather than mask it.
    contactDetail = null;
    loadingContactDetail = false;
    if (contactScan === null) {
      contactScan = {
        dialog: initialMergeReviewDialogState(),
        loading: true,
        scanning: false,
        progress: null,
        last_scan: null,
      };
    }
    syncDataHash();
    render();
    await hydrateMergeQueue();
  };

  // ── D-205 #5b — `#data/contact/import` ─────────────────────────────────
  //
  //  Mutually exclusive with the scan + the detail: one tab, one view. Each opener
  //  closes the others EXPLICITLY rather than leaving one to resurrect underneath —
  //  `openContactScan` learned that the hard way, and `currentDeepLinkEntity` would
  //  otherwise have two candidate answers.

  /** Re-read the strangers for the browsed Source. Sequence-guarded: the user can
   *  type into the search box faster than the round-trip, and a late response for an
   *  old query would silently overwrite a newer list. */
  let contactImportSeq = 0;
  const loadImportCandidates = async (): Promise<void> => {
    const caller = opts.contactImportCandidatesCaller;
    if (caller === undefined || contactImport === null || contactImport.source_id === null) return;
    const seq = ++contactImportSeq;
    const source_id = contactImport.source_id;
    const query = contactImport.query;
    contactImport = { ...contactImport, loading: true };
    render();
    try {
      const res = await caller({ source_id, query, limit: 100 });
      if (disposed || seq !== contactImportSeq || contactImport === null) return;
      contactImport = {
        ...contactImport,
        candidates: res.candidates,
        total: res.total,
        mirrored: res.mirrored,
        loading: false,
      };
    } catch (err) {
      if (disposed || seq !== contactImportSeq || contactImport === null) return;
      contactImport = { ...contactImport, loading: false };
      errors = { ...errors, contact_import: errMessage(err) };
    }
    render();
  };

  const openContactImport = async (): Promise<void> => {
    if (!canImport && !canUploadFile) return;
    contactDetail = null;
    loadingContactDetail = false;
    contactScan = null;
    if (contactImport === null) contactImport = initialContactImportState();
    syncDataHash();
    render();
    // The overview needs the Sources + their per-cycle counters — the `skipped` count
    // IS the stranger count, and it is what makes the cliff legible without computing
    // anything new.
    await refreshContactSources(loadGeneration);
  };

  const closeContactImport = (): void => {
    if (contactImport === null) return;
    contactImport = null;
    contactImportSeq += 1;
    const { contact_import: _cleared, ...rest } = errors;
    errors = rest;
    syncDataHash();
    render();
  };

  /** D-205 #5c — read the picked file and PREVIEW it. The bytes are held in state so
   *  `apply` re-sends the SAME text the plan was derived from — there is no server
   *  state between the two rpcs, and the client cannot hand back a plan it edited. */
  const previewImportFile = async (file: File): Promise<void> => {
    const caller = opts.contactImportFilePreviewCaller;
    if (caller === undefined || contactImport === null) return;
    contactImport = {
      ...contactImport,
      file: {
        text: '',
        name: file.name,
        plan: null,
        // ⛔ DEFAULT FALSE. The changes are the risky half — three thousand stale
        // values landing at the TOP of the ladder, where the user's live CRM could
        // never correct them. Opting IN is the whole point of the review.
        apply_changes: false,
        busy: true,
        result: null,
      },
    };
    render();
    try {
      const text = await file.text();
      const plan = await caller({ text });
      if (disposed || contactImport?.file == null) return;
      contactImport = {
        ...contactImport,
        file: { ...contactImport.file, text, plan, busy: false },
      };
    } catch (err) {
      if (disposed || contactImport?.file == null) return;
      contactImport = { ...contactImport, file: null };
      errors = { ...errors, contact_import: errMessage(err) };
    }
    render();
  };

  const applyImportFile = async (): Promise<void> => {
    const caller = opts.contactImportFileApplyCaller;
    if (caller === undefined || contactImport?.file == null || contactImport.file.busy) return;
    const { text, apply_changes } = contactImport.file;
    contactImport = { ...contactImport, file: { ...contactImport.file, busy: true } };
    render();
    try {
      const res = await caller({ text, apply_changes });
      if (disposed || contactImport?.file == null) return;
      contactImport = {
        ...contactImport,
        // The plan is spent — re-showing it would invite a second apply over contacts
        // that have already moved. The result line is what is true now.
        file: { ...contactImport.file, busy: false, plan: null, result: res },
      };
      render();
      // The contact list behind this page has new members. Refresh it, or closing the
      // page shows a list missing exactly the people you just imported.
      const nextErrors: DataLoadErrors = {};
      await refreshContacts(nextErrors, ++loadGeneration);
      if (!disposed) errors = { ...errors, ...nextErrors };
      render();
    } catch (err) {
      if (disposed || contactImport?.file == null) return;
      contactImport = { ...contactImport, file: { ...contactImport.file, busy: false } };
      errors = { ...errors, contact_import: errMessage(err) };
      render();
    }
  };

  const promoteSelectedContacts = async (): Promise<void> => {
    const caller = opts.contactImportPromoteCaller;
    if (
      caller === undefined
      || contactImport === null
      || contactImport.source_id === null
      || contactImport.selected.size === 0
      || contactImport.promoting
    ) {
      return;
    }
    const source_id = contactImport.source_id;
    const target_ids = [...contactImport.selected];
    contactImport = { ...contactImport, promoting: true, result: null };
    render();
    try {
      const res = await caller({ source_id, target_ids });
      if (disposed || contactImport === null) return;
      contactImport = {
        ...contactImport,
        promoting: false,
        result: res,
        // Clear the ticks: those people are contacts now, and the re-read below drops
        // them from the stranger list. A tick left behind would address someone who is
        // no longer in it.
        selected: new Set(),
      };
      render();
      // Re-read. The promoted people are no longer strangers, so the list must shrink
      // — and `(total, mirrored)` must move with it. Leaving the stale list on screen
      // would invite the user to add the same person twice.
      await loadImportCandidates();
      // And the CONTACT LIST behind this page now has new members. Refresh it, or
      // closing the page shows a list that is missing exactly the people you just added.
      // `refreshContacts` writes into a caller-owned error bag; give it a fresh one
      // and fold the result, so a contact-list failure surfaces on the CONTACT list's
      // slot rather than being mistaken for an import failure.
      const nextErrors: DataLoadErrors = {};
      await refreshContacts(nextErrors, ++loadGeneration);
      if (!disposed) errors = { ...errors, ...nextErrors };
      render();
    } catch (err) {
      if (disposed || contactImport === null) return;
      contactImport = { ...contactImport, promoting: false };
      errors = { ...errors, contact_import: errMessage(err) };
      render();
    }
  };

  const closeContactScan = (): void => {
    if (contactScan === null) return;
    contactScan = null;
    contactScanSeq += 1;
    const { contact_merge: _cleared, ...rest } = errors;
    errors = rest;
    syncDataHash();
    render();
  };

  /** Run the detector now. Progress arrives out-of-band on the
   *  `merge_scan_progress` broadcast; this call resolves when the scan
   *  yields/completes, and then the queue is re-hydrated. */
  const runMergeScan = async (): Promise<void> => {
    const scanCaller = opts.contactMergeScanNowCaller;
    if (contactScan === null || scanCaller === undefined || contactScan.scanning) return;
    contactScan = {
      ...contactScan,
      scanning: true,
      last_scan: null,
      progress: {
        iterated: 0,
        total: null,
        surfaced: 0,
        samples: 0,
        started_at: (opts.now ?? Date.now)(),
      },
    };
    const { contact_merge: _cleared, ...rest } = errors;
    errors = rest;
    render();
    try {
      // `full` resets the cursor so the walk covers every non-tombstone contact —
      // the install-over-an-existing-graph case, which is exactly the state a
      // user who just clicked "Find duplicates" is in.
      const result = await scanCaller({ mode: 'full' });
      if (disposed || contactScan === null) return;
      contactScan = {
        ...contactScan,
        scanning: false,
        progress: null,
        last_scan: { iterated: result.iterated, surfaced_count: result.surfaced_count },
      };
      render();
      await hydrateMergeQueue();
    } catch (err) {
      if (disposed || contactScan === null) return;
      contactScan = { ...contactScan, scanning: false, progress: null };
      errors = { ...errors, contact_merge: errMessage(err) };
      render();
    }
  };

  /** The candidate ids of the item currently under the cursor. Read from STATE,
   *  never from the clicked button's `data-candidate-ids` — a DOM attribute is a
   *  snapshot of the last paint, and this is the payload of a merge. */
  const currentMergeItem = (): MergeReviewItem | null => {
    if (contactScan === null) return null;
    return contactScan.dialog.items[contactScan.dialog.cursor] ?? null;
  };

  const currentSurvivor = (item: MergeReviewItem): string => {
    if (contactScan === null) return item.default_survivor;
    return (
      contactScan.dialog.survivor_overrides[contactScan.dialog.cursor]
      ?? item.default_survivor
    );
  };

  const setMergeSurvivor = (email: string): void => {
    if (contactScan === null) return;
    const trimmed = email.trim();
    if (trimmed.length === 0) return;
    contactScan = {
      ...contactScan,
      dialog: {
        ...contactScan.dialog,
        survivor_overrides: {
          ...contactScan.dialog.survivor_overrides,
          [contactScan.dialog.cursor]: trimmed,
        },
      },
    };
    render();
  };

  const moveMergeCursor = (delta: number): void => {
    if (contactScan === null) return;
    const next = contactScan.dialog.cursor + delta;
    if (next < 0 || next >= contactScan.dialog.items.length) return;
    contactScan = {
      ...contactScan,
      dialog: { ...contactScan.dialog, cursor: next, error: null },
    };
    render();
  };

  /** Confirm or reject the cluster under the cursor. Both take the SURFACED
   *  candidate edges verbatim — see `buildMergeItems` for why the transitive
   *  closure would be a durable, invisible mistake. */
  const resolveMergeItem = async (resolution: 'confirm' | 'reject'): Promise<void> => {
    if (contactScan === null || contactScan.dialog.saving) return;
    const item = currentMergeItem();
    if (item === null) return;
    const caller =
      resolution === 'confirm'
        ? opts.contactMergeConfirmCaller
        : opts.contactMergeRejectCaller;
    if (caller === undefined) return;
    const candidateIds = item.candidates.map((c) => c.id);
    contactScan = {
      ...contactScan,
      dialog: { ...contactScan.dialog, saving: true, error: null },
    };
    render();
    try {
      if (resolution === 'confirm') {
        const confirmCaller = opts.contactMergeConfirmCaller;
        if (confirmCaller === undefined) return;
        await confirmCaller({
          candidate_ids: candidateIds,
          survivor_email: currentSurvivor(item),
        });
      } else {
        const rejectCaller = opts.contactMergeRejectCaller;
        if (rejectCaller === undefined) return;
        await rejectCaller({ candidate_ids: candidateIds });
      }
      if (disposed || contactScan === null) return;
      contactScan = {
        ...contactScan,
        dialog: { ...contactScan.dialog, saving: false },
      };
      // The resolved cluster leaves the pending queue, so re-hydrate rather than
      // splice locally: a confirm rewrites annotations + links onto the survivor
      // and can cascade, and the list behind us is now stale too.
      await hydrateMergeQueue();
      if (disposed) return;
      pendingLoadPromise = refreshActive(true);
    } catch (err) {
      if (disposed || contactScan === null) return;
      contactScan = {
        ...contactScan,
        dialog: { ...contactScan.dialog, saving: false, error: errMessage(err) },
      };
      render();
    }
  };

  const onClick = (ev: Event): void => {
    // Form-renderer array Add/Remove for the work-entity dialog's
    // `data.contact` ref arrays (note/project related contacts). These
    // buttons carry `data-form-array-add` / `data-form-array-remove`,
    // not `data-action`, so dispatch them before the action lookup.
    const arrayAdd = targetWithAttr(ev, 'data-form-array-add');
    if (arrayAdd !== null) {
      const field = arrayAdd.getAttribute('data-form-array-add');
      if (field !== null) addWorkEntityArrayItem(field);
      return;
    }
    const arrayRemove = targetWithAttr(ev, 'data-form-array-remove');
    if (arrayRemove !== null) {
      const field = arrayRemove.getAttribute('data-form-array-remove');
      const idxRaw = arrayRemove.getAttribute('data-form-array-index');
      if (field !== null && idxRaw !== null) {
        removeWorkEntityArrayItem(field, Number(idxRaw));
      }
      return;
    }

    const target = targetWithAttr(ev, DATA_ROUTE_ACTION_ATTR)
      ?? targetWithAttr(ev, SHARED_ACTION_ATTR);
    if (target === null) return;
    const action =
      target.getAttribute(DATA_ROUTE_ACTION_ATTR)
      ?? target.getAttribute(SHARED_ACTION_ATTR)
      ?? '';
    if (action === 'select-tab') {
      const tab = target.getAttribute(DATA_ROUTE_TAB_ID_ATTR);
      if (tab !== null && isDataTab(tab)) void selectTab(tab);
      return;
    }
    // D-198 Slice 1b — Data | Memory lens switch + Memory origin filter.
    if (action === MEMORY_LENS_SELECT_ACTION) {
      const lens = target.getAttribute(MEMORY_LENS_VALUE_ATTR);
      if (lens === 'data' || lens === 'memory') void selectLens(lens);
      return;
    }
    if (action === MEMORY_FILTER_ACTION) {
      const filter = target.getAttribute(MEMORY_FILTER_VALUE_ATTR);
      if (
        filter === 'all' || filter === 'user_self'
        || filter === 'contracted_user' || filter === 'system'
      ) {
        void setMemoryOriginFilter(filter);
      }
      return;
    }
    // D-198 Slice 2 — owner memory CRUD dispatch. Row-scoped actions read the
    // target `memory_id` off `MEMORY_ROW_ID_ATTR`.
    if (action === MEMORY_ADD_ACTION) {
      openMemoryCompose();
      return;
    }
    if (action === MEMORY_COMPOSE_SUBMIT_ACTION) {
      void submitMemoryCompose();
      return;
    }
    if (action === MEMORY_COMPOSE_CANCEL_ACTION) {
      cancelMemoryCompose();
      return;
    }
    if (action === MEMORY_DETAIL_CLOSE_ACTION) {
      closeMemoryDetail();
      return;
    }
    if (action === MEMORY_EXPORT_ACTION) {
      void exportMemory();
      return;
    }
    if (action === MEMORY_IMPORT_ACTION) {
      openMemoryImport();
      return;
    }
    if (action === MEMORY_IMPORT_SUBMIT_ACTION) {
      void submitMemoryImport();
      return;
    }
    if (action === MEMORY_IMPORT_CANCEL_ACTION) {
      cancelMemoryImport();
      return;
    }
    if (
      action === MEMORY_OPEN_ACTION
      || action === MEMORY_EDIT_ACTION
      || action === MEMORY_DELETE_ACTION
      || action === MEMORY_DELETE_CONFIRM_ACTION
      || action === MEMORY_DELETE_CANCEL_ACTION
    ) {
      const memoryId = target.getAttribute(MEMORY_ROW_ID_ATTR);
      if (memoryId === null || memoryId.length === 0) return;
      if (action === MEMORY_OPEN_ACTION) void openMemoryDetail(memoryId);
      else if (action === MEMORY_EDIT_ACTION) void openMemoryEdit(memoryId);
      else if (action === MEMORY_DELETE_ACTION) requestMemoryDelete(memoryId);
      else if (action === MEMORY_DELETE_CONFIRM_ACTION) void confirmMemoryDelete(memoryId);
      else cancelMemoryDelete();
      return;
    }
    // D-198 Slice 5 — collection explorer dispatch (mail / calendar / files).
    // Fire-and-forget (NOT chained onto `pendingLoadPromise`): both read
    // `EXPLORER_TAB_PLATFORM[activeTab]` synchronously at click time, so a
    // deferred continuation can't reinterpret the click under a tab the user
    // switched to meanwhile. The record detail is set synchronously (the button
    // paints at once); the async `collection.get` is `explorerSeq`-guarded.
    if (action === COLLECTION_SELECT_INSTANCE_ACTION) {
      const slug = target.getAttribute(COLLECTION_INSTANCE_SLUG_ATTR);
      if (slug !== null) void selectExplorerInstance(slug);
      return;
    }
    if (action === COLLECTION_OPEN_RECORD_ACTION) {
      const recordId = target.getAttribute(COLLECTION_RECORD_ID_ATTR);
      if (recordId !== null && recordId.length > 0) void openExplorerRecord(recordId);
      return;
    }
    if (action === COLLECTION_DETAIL_CLOSE_ACTION) {
      closeExplorerDetail();
      return;
    }
    if (action === 'open-create-contact') {
      openCreateContactDialog();
      return;
    }
    if (action === 'open-edit-contact') {
      const email = target.getAttribute(DATA_ROUTE_CONTACT_EMAIL_ATTR);
      if (email !== null) void openEditContactDialog(email);
      return;
    }
    if (action === 'open-contact-detail') {
      const email = target.getAttribute(DATA_ROUTE_CONTACT_EMAIL_ATTR);
      if (email !== null) void openContactDetail(email);
      return;
    }
    if (action === 'load-more-contacts') {
      // Chain AFTER any in-flight load (a silent live-refresh) rather than
      // racing it: `loadMoreContacts` then computes `offset = contacts.length`
      // off the post-refresh list, not a stale one. `refreshActive` never
      // rejects, so the chain stays resolvable; `whenLoaded()` awaits it too.
      pendingLoadPromise = pendingLoadPromise.then(() => loadMoreContacts());
      return;
    }
    if (action === 'open-form-response') {
      const submissionId = target.getAttribute(DATA_ROUTE_FORM_RESPONSE_ID_ATTR);
      if (submissionId !== null) void openFormResponse(submissionId);
      return;
    }
    if (action === 'close-form-response') {
      closeFormResponse();
      return;
    }
    if (action === 'discover-form-response-automations') {
      // The open detail is already the discovery anchor, and the lookup has
      // its own response/sequence guards. Do not queue behind an unrelated
      // silent list refresh that may still be in flight or replace the route's
      // main load promise.
      void discoverFormResponseAutomations();
      return;
    }
    if (action === 'review-form-response-automation') {
      const recipeId = target.getAttribute(
        DATA_ROUTE_FORM_RESPONSE_RUN_RECIPE_ATTR,
      );
      if (recipeId !== null) reviewFormResponseAutomation(recipeId);
      return;
    }
    if (action === 'load-more-form-responses') {
      pendingLoadPromise = pendingLoadPromise.then(() => loadMoreFormResponses());
      return;
    }
    if (action === 'load-more-work-entities') {
      pendingLoadPromise = pendingLoadPromise.then(() => loadMoreWorkEntities());
      return;
    }
    if (action === 'close-contact-detail') {
      closeContactDetail();
      return;
    }
    // ── D-205 #2b — the merge scan page ──────────────────────────────────
    if (action === 'open-contact-scan') {
      void openContactScan();
      return;
    }
    // ── D-205 #5b — the import page ──────────────────────────────────────
    if (action === 'open-contact-import') {
      void openContactImport();
      return;
    }
    // ── D-205 #5c — the file upload ──────────────────────────────────────
    if (action === 'contact-import-file-toggle-changes') {
      if (contactImport?.file == null) return;
      contactImport = {
        ...contactImport,
        file: { ...contactImport.file, apply_changes: !contactImport.file.apply_changes },
      };
      render();
      return;
    }
    if (action === 'contact-import-file-clear') {
      if (contactImport === null) return;
      contactImport = { ...contactImport, file: null };
      render();
      return;
    }
    if (action === 'contact-import-file-apply') {
      void applyImportFile();
      return;
    }
    if (action === 'close-contact-import') {
      closeContactImport();
      return;
    }
    if (action === 'contact-import-overview') {
      // Back to the Source list. Drop the selection with it: a tick made against one
      // CRM's list must never survive into another's, where the same `target_id`
      // would address a different person entirely.
      if (contactImport !== null) contactImport = initialContactImportState();
      render();
      return;
    }
    if (action === 'contact-import-browse') {
      const source_id = target.getAttribute(DATA_ROUTE_IMPORT_SOURCE_ATTR) ?? '';
      if (source_id.length === 0 || contactImport === null) return;
      contactImport = { ...initialContactImportState(), source_id };
      void loadImportCandidates();
      return;
    }
    if (action === 'contact-import-toggle') {
      const target_id = target.getAttribute(DATA_ROUTE_IMPORT_TARGET_ATTR) ?? '';
      if (target_id.length === 0 || contactImport === null) return;
      const selected = new Set(contactImport.selected);
      if (selected.has(target_id)) selected.delete(target_id);
      else selected.add(target_id);
      contactImport = { ...contactImport, selected };
      render();
      return;
    }
    if (action === 'contact-import-promote') {
      void promoteSelectedContacts();
      return;
    }
    if (action === 'close-contact-scan') {
      closeContactScan();
      return;
    }
    if (action === 'run-merge-scan') {
      void runMergeScan();
      return;
    }
    if (action === 'contact-merge-confirm') {
      void resolveMergeItem('confirm');
      return;
    }
    if (action === 'contact-merge-reject') {
      void resolveMergeItem('reject');
      return;
    }
    if (action === 'contact-merge-set-survivor') {
      const email = target.getAttribute('data-email');
      if (email !== null) setMergeSurvivor(email);
      return;
    }
    if (action === 'contact-merge-prev') {
      moveMergeCursor(-1);
      return;
    }
    if (action === 'contact-merge-next') {
      moveMergeCursor(1);
      return;
    }
    if (action === 'close-contact-dialog') {
      contactDialog = null;
      render();
      return;
    }
    if (action === 'submit-contact-dialog') {
      syncContactDialogFromDom();
      void confirmContactDialog();
      return;
    }
    if (action === 'load-timeline') {
      if (isMirrorTab(activeTab)) void openTimelineDrilldown(activeTab, timelineEntityId);
      return;
    }
    if (action === 'download-file') {
      // Chain onto `pendingLoadPromise` so `whenLoaded()` awaits the read.
      pendingLoadPromise = pendingLoadPromise.then(() => downloadFile());
      return;
    }
    if (action === 'open-create-work-entity-dialog') {
      openCreateWorkEntityDialog();
      return;
    }
    if (action === 'open-edit-work-entity') {
      const kind = target.getAttribute('data-kind');
      const id = target.getAttribute('data-entity-id');
      if (kind !== null && id !== null && isWorkEntityTab(kind as DataTabId)) {
        void openEditWorkEntityDialog(kind as WorkEntityKind, id);
      }
      return;
    }
    if (action === 'close-work-entity-dialog') {
      workEntityState = closeDialogTransition(workEntityState);
      syncDataHash(); // dialog closed → drop the entity id from the URL
      render();
      return;
    }
    if (action === 'close-work-entity-dialog-on-backdrop') {
      if (ev.target === target) {
        workEntityState = closeDialogTransition(workEntityState);
        syncDataHash();
        render();
      }
      return;
    }
    if (action === 'reschedule-open') {
      // Prefill the picker with the event's current start (local wall-clock).
      const record = explorerDetail?.record ?? null;
      const startAt = record != null ? Number(record.hot_fields.start_at) : NaN;
      rescheduleForm = {
        value: Number.isFinite(startAt) ? toDatetimeLocal(startAt) : '',
        submitting: false,
        error: null,
      };
      render();
      return;
    }
    if (action === 'reschedule-cancel') {
      rescheduleForm = null;
      render();
      return;
    }
    if (action === 'reschedule-submit') {
      void submitReschedule();
      return;
    }
    if (action === 'submit-work-entity-dialog') {
      syncWorkEntityDialogFromDom();
      void confirmWorkEntityDialog();
    }
  };

  const onInput = (ev: Event): void => {
    const target = ev.target as HTMLInputElement | HTMLTextAreaElement | null;
    if (target === null) return;
    if (typeof target.hasAttribute === 'function' && target.hasAttribute(DATA_ROUTE_CONTACT_SEARCH_ATTR)) {
      contactSearch = target.value;
      if (activeTab === 'contact') startRefresh();
      return;
    }
    // D-205 #5b — the import page's own search. Re-reads the STRANGER list, not the
    // contact list: the two are different questions over different data, and folding
    // them into one box would search your contacts for people who are not in them.
    if (
      typeof target.getAttribute === 'function'
      && target.getAttribute(DATA_ROUTE_ACTION_ATTR) === 'contact-import-search'
      && contactImport !== null
    ) {
      contactImport = { ...contactImport, query: target.value };
      void loadImportCandidates();
      return;
    }
    // D-210 R-4 — the reschedule datetime input. Update state only (no re-render)
    // so typing isn't interrupted; `submitReschedule` reads `rescheduleForm.value`
    // on Save.
    if (
      typeof target.getAttribute === 'function'
      && target.getAttribute(DATA_ROUTE_ACTION_ATTR) === 'reschedule-input'
      && rescheduleForm !== null
    ) {
      rescheduleForm = { ...rescheduleForm, value: target.value };
      return;
    }
    // D-205 #5c — the file picker. `<input type=file>` fires `change`/`input`, and the
    // picked file rides on `.files`, never on `.value` (which is a fake path).
    if (
      typeof target.getAttribute === 'function'
      && target.getAttribute(DATA_ROUTE_ACTION_ATTR) === 'contact-import-file-pick'
    ) {
      const file = (target as unknown as { files?: FileList | null }).files?.[0];
      if (file !== undefined && file !== null) void previewImportFile(file);
      return;
    }
    if (typeof target.getAttribute === 'function') {
      const action = target.getAttribute(SHARED_ACTION_ATTR);
      if (action === 'search-work-entities') {
        const kind = target.getAttribute('data-kind');
        if (isWorkEntityTab(activeTab) && kind === workEntityState.kind) {
          workEntityState = applySearchTransition(workEntityState, target.value);
          render();
        }
        return;
      }
      const contactField = target.getAttribute(DATA_ROUTE_CONTACT_FIELD_ATTR) as keyof ContactDialogValues | null;
      if (contactDialog !== null && contactField !== null && contactField in contactDialog.values) {
        contactDialog = {
          ...contactDialog,
          values: { ...contactDialog.values, [contactField]: target.value },
        };
        return;
      }
      // D-198 Slice 2/3 — keep the compose / import forms synced with their
      // uncontrolled inputs (no render on keystroke, so typing never flickers).
      const memoryField = target.getAttribute(MEMORY_FIELD_ATTR);
      if (memoryCompose.open && (memoryField === 'kind' || memoryField === 'summary' || memoryField === 'body')) {
        memoryCompose = { ...memoryCompose, [memoryField]: target.value };
        return;
      }
      if (memoryImport.open && memoryField === 'import') {
        memoryImport = { ...memoryImport, text: target.value };
        return;
      }
      if (target.hasAttribute(DATA_ROUTE_TIMELINE_ENTITY_ATTR)) {
        timelineEntityId = target.value;
      }
    }
  };

  const onChange = (ev: Event): void => {
    const target = ev.target as HTMLSelectElement | null;
    if (target === null || typeof target.getAttribute !== 'function') return;
    const action = target.getAttribute(SHARED_ACTION_ATTR);
    // D-205 #2b — the multi-way survivor picker is a RADIO, so it must be handled
    // on `change`, not `click`: arrow-keying between radios moves the selection
    // and fires `change` WITHOUT ever firing `click`. Handling it on click alone
    // would leave a keyboard user's visible selection disagreeing with the
    // survivor the Merge button actually commits.
    if (action === 'contact-merge-pick-survivor') {
      const email = target.getAttribute('data-email');
      if (email !== null) setMergeSurvivor(email);
      return;
    }
    if (action === 'select-source') {
      const options = sourceOptionsForKind(sources, workEntityState.kind);
      const valid = new Set(options.map((option) => option.id));
      workEntityState = selectSourceTransition(workEntityState, target.value, valid);
      startRefresh();
      return;
    }
    if (action === 'select-create-source') {
      workEntityState = setDialogSourceTransition(workEntityState, target.value);
      render();
    }
  };

  routeRoot.addEventListener('click', onClick);
  routeRoot.addEventListener('input', onInput);
  routeRoot.addEventListener('change', onChange);

  startRefresh();

  // R18 — deep-link hydration: after the initial tab's load settles, open the
  // addressed entity's timeline detail. Contact + mirror tabs have a timeline
  // view; work-entity tabs hydrate the tab only (detail = modal edit, not a
  // timeline yet). Chained onto `pendingLoadPromise` so `whenLoaded()` awaits it.
  const initialEntityId = opts.initialEntityId;
  if (initialEntityId !== undefined && initialEntityId.length > 0) {
    pendingLoadPromise = pendingLoadPromise.then(() => {
      if (disposed) return undefined;
      // D-198 Slice 1b — the Memory lens has no per-entity deep link (v1); a
      // hand-crafted `#data/memory/<x>` must not open a Data-tab detail.
      if (activeLens === 'memory') return undefined;
      if (activeTab === 'contact') {
        // `#data/contact/scan` addresses the merge page; anything else is an
        // email. The literal cannot collide with a contact id — every email
        // carries an `@` and `scan` does not.
        if (initialEntityId === DATA_ROUTE_CONTACT_SCAN_SEGMENT) return openContactScan();
        // D-205 #5b — neither literal can collide with a contact id: every email
        // carries an `@`, and `scan` / `import` do not.
        if (initialEntityId === DATA_ROUTE_CONTACT_IMPORT_SEGMENT) return openContactImport();
        return openContactDetail(initialEntityId);
      }
      if (isReceivedTab(activeTab)) return openFormResponse(initialEntityId);
      // D-198 — explorer + single-collection tabs open the ADDRESSED RECORD's
      // detail directly (platform via `collection.get`; single-collection finds
      // it in the loaded list). Runs after the initial load, so the records /
      // auto-selected instance are ready; an unknown id shows "no longer exists".
      if (isExplorerTab(activeTab) || isSingleCollectionTab(activeTab)) {
        return openExplorerRecord(initialEntityId);
      }
      // Only the crm drill-down still opens a `data.timeline` from the deep link.
      if (isMirrorTab(activeTab) && !isExplorerTab(activeTab)) {
        return openTimelineDrilldown(activeTab, initialEntityId);
      }
      // Work-entity detail IS a modal edit — the deep link opens it (symmetric
      // with the contact/mirror timeline detail). `openEditWorkEntityDialog`
      // fetches the entity + opens the dialog; render() then keeps the id in the
      // URL. A missing / unfetchable id surfaces an error there (not a false
      // selection), so the un-openable-id drop is no longer needed.
      if (isWorkEntityTab(activeTab)) {
        return openEditWorkEntityDialog(activeTab, initialEntityId);
      }
      syncDataHash();
      return undefined;
    });
  }

  // R18 — live-update: re-fetch the current list (warehouse) + any open timeline
  // (memory) as the AI / housekeeping writes the warehouse in the background.
  // FormResponse promotion emits `warehouse/form_response` immediately after
  // first canonical persistence, before any optional downstream resume.
  // Debounced to coalesce a write burst; the list refresh is silent (no loading
  // flash). The server fans these kinds to this client because the webclient
  // names them in WEBCLIENT_DEFAULT_SUBSCRIPTIONS (D-169 TR-10).
  const liveRefreshDebounceMs = opts.liveRefreshDebounceMs ?? 400;
  const liveUnsubscribers: Array<() => void> = [];
  let liveRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  const runLiveRefresh = (): void => {
    if (disposed) return;
    pendingLoadPromise = refreshActive(true);
    if (contactDetail !== null) {
      void openContactDetail(contactDetail.email);
    } else if (isMirrorTab(activeTab) && timelineEntityId.length > 0) {
      void openTimelineDrilldown(activeTab, timelineEntityId);
    }
  };
  const scheduleLiveRefresh = (): void => {
    if (disposed) return;
    if (liveRefreshDebounceMs <= 0) {
      runLiveRefresh();
      return;
    }
    if (liveRefreshTimer !== null) clearTimeout(liveRefreshTimer);
    liveRefreshTimer = setTimeout(() => {
      liveRefreshTimer = null;
      runLiveRefresh();
    }, liveRefreshDebounceMs);
  };
  if (opts.subscribe !== undefined) {
    liveUnsubscribers.push(
      opts.subscribe('warehouse', scheduleLiveRefresh),
      opts.subscribe('memory', scheduleLiveRefresh),
      // D-205 #2b — the FIRST listeners these two broadcast kinds have ever had.
      // Both are already in WEBCLIENT_DEFAULT_SUBSCRIPTIONS, so the server has
      // been fanning them to this client all along and nothing was reading them.
      opts.subscribe('merge_scan_progress', (event) => {
        if (disposed || contactScan === null) return;
        // A scan can also be driven from Settings → Housekeeping, so a progress
        // event may arrive with no local `scan_now` in flight. Reflect it anyway
        // — the page is showing that queue either way.
        const progress = contactScan.progress ?? {
          iterated: 0,
          total: null,
          surfaced: 0,
          samples: 0,
          started_at: (opts.now ?? Date.now)(),
        };
        if (event.op === 'complete') {
          contactScan = {
            ...contactScan,
            progress: null,
            last_scan: {
              iterated: event.iterated,
              surfaced_count: event.surfaced_count ?? progress.surfaced,
            },
          };
          render();
          // The queue is what changed; re-hydrate it. (`scan_now`'s own resolve
          // does this too — `contactScanSeq` makes the duplicate hydrate a no-op
          // rather than a race.)
          void hydrateMergeQueue();
          return;
        }
        contactScan = {
          ...contactScan,
          progress: {
            ...progress,
            iterated: event.iterated,
            total: event.total,
            surfaced: event.surfaced_count ?? progress.surfaced,
            samples: progress.samples + 1,
          },
        };
        render();
      }),
      // A candidate surfaced (or was resolved elsewhere) while the page is open.
      // The payload is deliberately narrow — "the queue changed, refresh it".
      //
      // Skipped while a confirm/reject is in flight: a re-hydrate re-indexes the
      // queue, and the resolve path hydrates on its own once it lands. Yanking
      // the list out from under an in-flight commit would only race it.
      opts.subscribe('merge_candidate', () => {
        if (disposed || contactScan === null) return;
        if (contactScan.scanning || contactScan.dialog.saving) return;
        void hydrateMergeQueue();
      }),
    );
  }

  return {
    activeTab: () => activeTab,
    activeLens: () => activeLens,
    memoryEntries: () => memoryEntries,
    memoryOriginFilter: () => memoryOriginFilter,
    workEntityState: () => workEntityState,
    contacts: () => contacts,
    formResponses: () => formResponses,
    workEntities: () => workEntities,
    timeline: () => timeline,
    getLoadErrors: () => errors,
    refresh: startRefresh,
    whenLoaded: () => pendingLoadPromise,
    selectTab,
    openCreateWorkEntityDialog,
    openEditWorkEntityDialog,
    setWorkEntityDialogValues,
    confirmWorkEntityDialog,
    deleteWorkEntity,
    openCreateContactDialog,
    openEditContactDialog,
    setContactDialogValues,
    confirmContactDialog,
    deleteContact,
    openFormResponse,
    closeFormResponse,
    discoverFormResponseAutomations,
    reviewFormResponseAutomation,
    confirmFormResponseAutomationRun,
    openTimelineDrilldown,
    openContactDetail,
    closeContactDetail,
    openContactScan,
    closeContactScan,
    runMergeScan,
    resolveMergeItem,
    setMergeSurvivor,
    moveMergeCursor,
    contactScan: () => contactScan,
    openContactImport,
    browseImportSource: async (source_id: string): Promise<void> => {
      if (contactImport === null) return;
      contactImport = { ...initialContactImportState(), source_id };
      await loadImportCandidates();
    },
    toggleImportTarget: (target_id: string): void => {
      if (contactImport === null) return;
      const selected = new Set(contactImport.selected);
      if (selected.has(target_id)) selected.delete(target_id);
      else selected.add(target_id);
      contactImport = { ...contactImport, selected };
      render();
    },
    promoteImport: promoteSelectedContacts,
    previewImportFile,
    applyImportFile,
    setImportApplyChanges: (on: boolean): void => {
      if (contactImport?.file == null) return;
      contactImport = { ...contactImport, file: { ...contactImport.file, apply_changes: on } };
      render();
    },
    contactImport: () => contactImport,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      if (liveRefreshTimer !== null) {
        clearTimeout(liveRefreshTimer);
        liveRefreshTimer = null;
      }
      for (const off of liveUnsubscribers.splice(0)) off();
      closeFormResponseRunModal();
      disposeWorkEntityRefPickers();
      disposeUploadWidget();
      routeRoot.removeEventListener('click', onClick);
      routeRoot.removeEventListener('input', onInput);
      routeRoot.removeEventListener('change', onChange);
      try {
        opts.root.removeChild(routeRoot);
      } catch {
        routeRoot.remove();
      }
    },
  };
};
