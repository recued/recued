import { DEFAULT_COMMITMENT_VIEW_FILTERS, parseCommitmentViewFilters, type CommitmentViewFilters } from '@recued/contracts';
import { commitmentCounterpartyLabel, type WorkEntityCommitmentView } from '@recued/ui-shared/work-entity-page';
import { createAssetSearch, type AssetSearchCaller } from './asset-search.js';
import { readSearchAssetReturn, saveSearchAssetReturn } from '../shell/search-asset-return.js';
import { mountSpherePlacement, type SpherePlacementCallers } from '../yours/sphere-placement.js';
import { isContactAnnualDate, isDateOnlyDue } from '@recued/contracts';
import { recordsRecordAddress,type RecordsRecordAddress } from './records-navigation.js';
import { createRecordsImport, RECORDS_IMPORT_OPEN, RECORDS_IMPORT_RETRY, RECORDS_IMPORT_RECIPE_ATTR } from './records-import.js';
import type { SheetImportUploader, WireSheetImportOptions } from '../recipes/spreadsheet-import/index.js';
import type { MainDishSettings } from '../recipes/main-dish-settings.js';
import type { HeldRunFollower } from '../held-run-follow.js';
import { CONNECTION_NAME_REGEX } from '@recued/contracts';
import { connectionsFileAuthenticationAddress } from '../connections/connections-navigation.js';
import { openFilePreview, readStoredFileDownload, type FilePreviewCallers } from '../files/file-preview.js';
import { openFileChatPicker, type FileChatCallers } from '../chat/existing-file-picker.js';
import { cloudFileInstance, cloudFileRecord, cloudFileSourceId, cloudFileSourceSlug, SAVED_FILES_SLUG, savedFilesInstance } from './cloud-file-explorer.js';
import type { CloudFileSource } from '@recued/contracts';
/** D-174 P5 - top-level Data route.
 *
 *  Back-office warehouse surface: contacts + the four local work
 *  entity kinds are editable, mirror collections are read-only
 *  drill-downs through data.timeline().
 */

import { renderFileLifecyclePanel, type FileLifecyclePanelState } from './file-lifecycle-panel.js';
import type {
  FileLifecycleMutation,
  FileLifecyclePreview,
  RecordsChangeFeed,
  RecordsChangeQuery,
  SavedDataView,
  SavedDataViewDefinition,
  SavedDataViewReview,
  SavedDataViewUpdateRequest,
  TaskViewFilters,
  CollectionSourceFreshness,
  ConnectionVendorEntity,
  ContactContributionView,
  ContactFieldProvenance,
  ContactMergeCandidate,
  ContactRecord,
  ContactAdditionalIdentifiers,
  ContactSource,
  ContactSourceHealth,
  ContactImportCandidate,
  ContactImportFilePlan,
  ContactImportOccasionSelection,
  EnrichmentMeta,
  EnrichmentScope,
  FieldValidationError,
  FormResponse,
  FormResponseGetRpcRequest,
  FormResponseGetRpcResponse,
  FormResponseSetStateRpcRequest,
  FormResponseSetStateRpcResponse,
  FormResponseUpdateRpcRequest,
  FormResponseUpdateRpcResponse,
  FormResponseExportRpcRequest,
  FormResponseExportRpcResponse,
  FormResponseLifecycleState,
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
  MemoryReplaceRequest,
  MemoryRestoreRequest,
  MemoryRestoreResult,
  MemoryListResponse,
  MemoryMutationResult,
  MemoryUpdateRequest,
  MirrorSearchRequest,
  MirrorSearchResponse,
  PlatformIdEntry,
  RecordsCsvExportEnvelope,
  RecordsExportEnvelope,
  RecordsExportRequest,
  RecordsExportResponse,
  RecordsFriendlyRecord,
  RecordsGlobalQuotaSnapshot,
  RecordsKindSummary,
  RecordsNamespaceView,
  RecordsOutboxListRequest,
  RecordsOutboxOverview,
  RecordsOutboxRetireRequest,
  RecordsOwnerDeleteRequest,
  RecordsOwnerGetRequest,
  RecordsOwnerGetResponse,
  RecordsOwnerSearchRequest,
  RecordsPackRef,
  RecordsPurgeRequest,
  RecordsRetentionPolicy,
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
  BookingLifecycleState,
  WorkEntity,
  WorkEntityDeleteRpcRequest,
  WorkEntityDeleteRpcResponse,
  WorkEntityGetRpcRequest,
  WorkEntityGetRpcResponse,
  WorkEntityKind,
  WorkEntitySearchKind,
  WorkEntitySearchGroup,
  WorkEntitySearchRpcRequest,
  WorkEntitySearchRpcResponse,
  WorkEntityListRpcRequest,
  WorkEntityListRpcResponse,
  WorkEntityListRow,
  WorkEntityPageState,
  WorkEntityUpsertRpcRequest,
  WorkEntityUpsertRpcResponse,
  WorkEntityTaskMarkDoneRpcRequest,
  WorkEntityTaskMarkDoneRpcResponse,
  TimelineRollup,
} from '@recued/contracts';
import {
  sameSavedDataViewDefinition, DEFAULT_TASK_VIEW_FILTERS, parseTaskViewFilters,
  resolveTaskListFilter, RECORDS_MAX_PREDICATES,
} from '@recued/contracts';
import { allDayEventDays, calendarDayMs, DAY_MS, rankSearchable, readDisplayField, timedDueMs } from '@recued/contracts';
import {
  getContactSourceDeclaration,
  CONTACT_SOURCE_ID_DERIVED,
  CONTACT_SOURCE_ID_MANUAL,
  FILE_VENDOR_DECLARATIONS,
  BOOKING_DEFAULT_LIFECYCLE_STATE,
  BOOKING_LIFECYCLE_STATES,
  FORM_RESPONSE_LIFECYCLE_STATES,
  WORK_ENTITY_KINDS,
  WORK_ENTITY_SEARCH_KINDS,
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
import { renderProjectOverview, PROJECT_OVERVIEW_STYLES, type ProjectOverviewProps } from '@recued/ui-shared/work-entity-page';
import { createProjectWork, type ProjectWork, type ProjectItemsCaller } from './project-work.js';
import {
  ENTITY_DETAIL_PANEL_STYLES,
  FORM_RENDERER_STYLES,
  MERGE_REVIEW_DIALOG_STYLES,
  REFERENCE_PROVENANCE_STYLES,
  RefPicker,
  RunModal,
  Upload,
  WORK_ENTITY_PAGE_STYLES,
  WORK_ENTITY_DIALOG_DISCARD_GUARD_ATTR,
  WORK_ENTITY_DIALOG_DISCARD_KEEP_ACTION,
  WORK_ENTITY_DIALOG_DISCARD_COMMIT_ACTION,
  collapseToFreshestPerTopic,
  e,
  findAccountLane,
  findAccountProvider,
  formatRemaining,
  initialMergeReviewDialogState,
  isEtaEligible,
  pickFreshestMetaSnapshot,
  formatTimestampForInput,
  taskDueShortcutDue,
  type WorkEntityNoteView,
  readFormValues,
  remainingMillis,
  renderEntityDetailPanel,
  renderBookingDetail,
  renderWorkEntityDialog,
  renderTimelineSection,
  renderMergeReviewDialog,
  renderProvenance,
  renderWorkEntityPage,
  type EnrichmentSummary,
  type EntityDetailPanelProps,
  type MergeReviewContactCard,
  type MergeReviewDialogState,
  type MergeReviewItem,
  type ScanProgress,
} from '@recued/ui-shared';

import type { BroadcastSubscriber } from '../realtime/subscriber.js';
import {
  createHierarchicalHistory,
  hierarchicalAddressFromHash,
  hierarchicalLevel,
} from '../shell/hierarchical-navigation.js';
import {
  serializeDataEntityVerificationAddress,
  serializeChatAnswerAddress,
  serializeChatPlanAddress,
  serializeLogsRunAddress,
  parseShellRoute,
  serializeShellRoute,
  serializeSourceRecordAddress,
  serializeSourceRecordVerificationAddress,
  type ChatAnswerAddress,
  type DataEntityVerificationTab,
  type DataVerificationRelationship,
  type LogsRunAddress,
  type SourceRecordDataTab,
} from '../shell/route.js';
import { classifyRpcError, humanizeRpcError } from '../shell/rpc-error-copy.js';
import { runPageObject, type RunPageContext } from '../shell/run-page-context.js';
import {
  createMailFactsSurface,
  MAIL_FACTS_ACTION_PREFIX,
  MAIL_FACTS_FIELD_ATTR,
  MAIL_FACTS_FILTER_ATTR,
  MAIL_FACTS_STYLES,
  type MailFactCallers,
} from './mail-facts-surface.js';
import { createCalendarEventSurface, CALENDAR_EVENT_ACTION_PREFIX, CALENDAR_EVENT_STYLES, type CalendarEventCallers } from './calendar-event-surface.js';
import { createMailMessageSurface, MAIL_MESSAGE_STYLES, type MailMessageCallers } from './mail-message-surface.js';
import {
  createRemindersSurface,
  REMINDERS_ACTION_PREFIX,
  REMINDERS_FIELD_ATTR,
  REMINDERS_STYLES,
  type ReminderCallers,
} from './reminders-surface.js';
import { REMINDER_LIST_LINK } from '@recued/contracts';
import type { MailFactEmailStatus } from '@recued/contracts';
import { mailWorkFollowHref } from '../mail/mail-work-route.js';
import { fileRefOptionsFromMirrorResults } from '../recipes/file-ref-picker.js';
import {
  MEMORY_ADD_ACTION,
  MEMORY_COMPOSE_CANCEL_ACTION,
  MEMORY_COMPOSE_DISCARD_COMMIT_ACTION,
  MEMORY_COMPOSE_DISCARD_GUARD_ATTR,
  MEMORY_COMPOSE_DISCARD_KEEP_ACTION,
  MEMORY_COMPOSE_SUBMIT_ACTION,
  MEMORY_DELETE_ACTION,
  MEMORY_DELETE_CANCEL_ACTION,
  MEMORY_DELETE_CONFIRM_ACTION,
  MEMORY_REPLACE_ACTION,
  MEMORY_RESTORE_ACTION,
  MEMORY_DETAIL_CLOSE_ACTION,
  MEMORY_DETAIL_HEADING_ATTR,
  MEMORY_EDIT_ACTION,
  MEMORY_EXPORT_ACTION,
  MEMORY_MORE_ACTION,
  MEMORY_FIELD_ATTR,
  MEMORY_FILTER_ACTION,
  MEMORY_FILTER_VALUE_ATTR,
  MEMORY_IMPORT_ACTION,
  MEMORY_IMPORT_CANCEL_ACTION,
  MEMORY_IMPORT_DISCARD_COMMIT_ACTION,
  MEMORY_IMPORT_DISCARD_GUARD_ATTR,
  MEMORY_IMPORT_DISCARD_KEEP_ACTION,
  MEMORY_IMPORT_SUBMIT_ACTION,
  MEMORY_LENS_SELECT_ACTION,
  MEMORY_LENS_STYLES,
  MEMORY_LENS_VALUE_ATTR,
  MEMORY_OPEN_ACTION,
  MEMORY_OPEN_RUN_ACTION,
  MEMORY_ROW_ID_ATTR,
  isReplaceableEntry,
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
  COLLECTION_RETRY_ACTION,
  COLLECTION_DETAIL_RETRY_ACTION,
  COLLECTION_DETAIL_CLOSE_ACTION,
  COLLECTION_DETAIL_HEADING_ATTR,
  COLLECTION_DETAIL_RETRY_ATTR,
  COLLECTION_INSTANCE_SLUG_ATTR,
  COLLECTION_RECORD_ID_ATTR,
  COLLECTION_RETRY_ATTR,
  type CollectionExplorerDetailState,
} from './collection-explorer.js';
import { createCalendarAgenda, calendarDateIn, CALENDAR_AGENDA_STYLES, AGENDA_FOCUS, AGENDA_SOURCE } from './calendar-agenda.js';
import { createCalendarCreateSurface, CALENDAR_CREATE_STYLES, type CalendarCreateCallers } from './calendar-create-surface.js';
import { REMINDER_CREATE_STYLES } from '../reminders/reminder-create-form.js';
import { createTaskBulkActions, TASK_BULK_FOCUS, TASK_BULK_STYLES, type TaskBulkActions } from './task-bulk-actions.js';
import type { PackInstalledListCaller, RosterPack } from '../discover/pack-discovery.js';
import {
  renderUniversalSearch,
  UNIVERSAL_SEARCH_STYLES,
  SEARCH_OPEN_RECIPE_ACTION,
  SEARCH_RECIPE_ID_ATTR,
  SEARCH_OPEN_PACK_ACTION,
  SEARCH_PACK_SLUG_ATTR,
  SEARCH_MARKETPLACE_ACTION,
  SEARCH_OPEN_MARKET_PACK_ACTION,
  type UniversalSearchRecipeMatch,
  type UniversalSearchPackMatch,
  type UniversalSearchMarketMatch,
  SEARCH_OPEN_RECORD_ACTION,
  SEARCH_OPEN_GROUP_ACTION,
  SEARCH_OPEN_WORK_ACTION,
  SEARCH_MORE_WORK_ACTION,
  SEARCH_WORK_KIND_ATTR,
  SEARCH_WORK_ID_ATTR,
  SEARCH_OPEN_ASSET_ACTION, SEARCH_MORE_ASSETS_ACTION, SEARCH_ASSET_ID_ATTR,
  SEARCH_OPEN_CONTACT_ACTION,
  SEARCH_MORE_CONTACTS_ACTION,
  SEARCH_CONTACT_EMAIL_ATTR,
  SEARCH_RETRY_ACTION,
  SEARCH_DID_YOU_MEAN_ACTION,
  SEARCH_DID_YOU_MEAN_QUERY_ATTR,
  SEARCH_RECORD_ID_ATTR,
  SEARCH_GROUP_SLUG_ATTR,
  SEARCH_GROUP_PLATFORM_ATTR,
  SEARCH_INPUT_ATTR,
} from './universal-search.js';
import {
  RECORDS_CANCEL_DELETE_ACTION,
  RECORDS_CANCEL_PURGE_ACTION,
  RECORDS_CANCEL_RETIRE_EVENT_ACTION,
  RECORDS_CLOSE_RECORD_ACTION,
  RECORDS_CONFIRM_DELETE_ACTION,
  RECORDS_CONFIRM_PURGE_ACTION,
  RECORDS_CONFIRM_RETIRE_EVENT_ACTION,
  RECORDS_DELETE_RECORD_ACTION,
  RECORDS_EXPLORER_STYLES,
  RECORDS_EXPORT_KIND_ACTION,
  RECORDS_EXPORT_KIND_CSV_ACTION,
  RECORDS_EXPORT_PACK_ACTION,
  RECORDS_EXPORT_PACK_CSV_ACTION,
  RECORDS_EVENT_ID_ATTR,
  RECORDS_ID_ATTR,
  RECORDS_KIND_ATTR,
  RECORDS_NAMESPACE_ATTR,
  RECORDS_OPEN_REFERENCE_ACTION,
  RECORDS_OPEN_RECORD_ACTION,
  RECORDS_PURGE_ACTION,
  RECORDS_PURGE_CONFIRMATION_ATTR,
  RECORDS_MARK_REVIEWED_ACTION,
  RECORDS_REFRESH_CHANGES_ACTION,
  RECORDS_REFRESH_OUTBOX_ACTION,
  RECORDS_RETIRE_EVENT_ACTION,
  RECORDS_SELECT_KIND_ACTION,
  RECORDS_SELECT_NAMESPACE_ACTION,
  RECORDS_TOGGLE_CHANGES_ACTION,
  RECORDS_TOGGLE_OUTBOX_ACTION,
  renderRecordsExplorer,
  type RecordsExplorerState,
} from './records-explorer.js';
import {
  initialRecordsBrowseState, parseRecordsViewDraft, recordsFilterOperators,
  recordsViewDraft, recordsViewHasDraft,
} from './records-view-controls.js';
import type {
  Annotation,
  CanonicalCollectionName,
  CollectionInstanceRow,
  CollectionListQuery,
  CollectionPlatform,
  CollectionRecord,
  CollectionSearchDidYouMean,
  CollectionSearchGroup,
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
export const DATA_ROUTE_CHAT_RETURN_ATTR =
  'data-recued-data-route-chat-return';
export const DATA_ROUTE_LOGS_RETURN_ATTR =
  'data-recued-data-route-logs-return';
export const DATA_ROUTE_VERIFICATION_ACTION_ATTR =
  'data-recued-data-route-verification-action';
export const DATA_ROUTE_VERIFICATION_NEXT_ATTR =
  'data-recued-data-route-verification-next';
export const DATA_ROUTE_TAB_ATTR = 'data-recued-data-route-tab';
export const DATA_ROUTE_TABLIST_ATTR = 'data-recued-data-route-tablist';
export const DATA_ROUTE_COLLECTION_PICKER_ATTR = 'data-recued-data-collection-picker';
export const DATA_ROUTE_TAB_PANEL_ATTR = 'data-recued-data-route-tab-panel';
export const DATA_ROUTE_CONTACT_ROW_ATTR = 'data-recued-data-contact-row';
/** D-226 — a per-pack rollup chip on a contact LIST row. Value is the pack's
 *  label, so a test can assert WHICH pack spoke, not merely that something did. */
export const DATA_ROUTE_CONTACT_ROLLUP_ATTR = 'data-recued-data-contact-rollup';
export const DATA_ROUTE_FORM_RESPONSE_ROW_ATTR =
  'data-recued-data-form-response-row';
export const DATA_ROUTE_FORM_RESPONSE_DETAIL_ATTR =
  'data-recued-data-form-response-detail';
export const DATA_ROUTE_FORM_RESPONSE_DETAIL_HEADING_ATTR =
  'data-recued-data-form-response-detail-heading';
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
export const DATA_ROUTE_FORM_RESPONSE_VALUES_ATTR =
  'data-recued-data-form-response-values';
export const DATA_ROUTE_FORM_RESPONSE_EMAIL_ATTR =
  'data-recued-data-form-response-email';
export const DATA_ROUTE_FORM_RESPONSE_STATE_ATTR =
  'data-recued-data-form-response-state';
export const DATA_ROUTE_FORM_RESPONSE_DISCARD_GUARD_ATTR =
  'data-recued-data-form-response-discard-guard';
export const DATA_ROUTE_FORM_RESPONSE_DISCARD_KEEP_ATTR =
  'data-recued-data-form-response-discard-keep';
export const DATA_ROUTE_FORM_RESPONSE_DISCARD_COMMIT_ATTR =
  'data-recued-data-form-response-discard-commit';
const DATA_ROUTE_FORM_RESPONSE_DISCARD_KEEP_ACTION =
  'keep-form-response-draft';
const DATA_ROUTE_FORM_RESPONSE_DISCARD_COMMIT_ACTION =
  'discard-form-response-draft';
/** R18 load-more — the "Showing N of M" + Load more footer under the contact
 *  list (present only while `loaded < total`). */
export const DATA_ROUTE_CONTACT_LOAD_MORE_ATTR = 'data-recued-data-contact-load-more';
/** R18 load-more — the same footer under a work-entity list. Its `total` is the
 *  server kind/Source count; the client-side search filters the loaded rows, so
 *  the count reads "N of M loaded" and Load more stays available under a search
 *  (bringing in more rows for the search to match). */
export const DATA_ROUTE_WORK_ENTITY_LOAD_MORE_ATTR = 'data-recued-data-work-entity-load-more';
export const DATA_ROUTE_CONTACT_DIALOG_ATTR = 'data-recued-data-contact-dialog';
export const DATA_ROUTE_CONTACT_DISCARD_GUARD_ATTR =
  'data-recued-data-contact-discard-guard';
export const DATA_ROUTE_CONTACT_DISCARD_KEEP_ATTR =
  'data-recued-data-contact-discard-keep';
export const DATA_ROUTE_CONTACT_DISCARD_COMMIT_ATTR =
  'data-recued-data-contact-discard-commit';
const DATA_ROUTE_CONTACT_DISCARD_KEEP_ACTION = 'keep-contact-dialog';
const DATA_ROUTE_CONTACT_DISCARD_COMMIT_ACTION = 'discard-contact-dialog';
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
export const DATA_ROUTE_CONTACT_DETAIL_HEADING_ATTR =
  'data-recued-data-contact-detail-heading';
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
/** Focusable durable receipt for a completed duplicate-contact scan. */
export const DATA_ROUTE_SCAN_RESULT_ATTR = 'data-recued-data-scan-result';
/** Focusable durable receipt for a reconciled merge decision. */
export const DATA_ROUTE_MERGE_RESULT_ATTR = 'data-recued-data-merge-result';

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
/** Focusable durable receipt for a completed contact-import mutation. */
export const DATA_ROUTE_CONTACT_IMPORT_RESULT_ATTR =
  'data-recued-data-contact-import-result';
/** The file preview's dates it could not use as written. */
export const DATA_ROUTE_CONTACT_IMPORT_DATES_ATTR = 'data-recued-data-contact-import-dates';
const DATA_ROUTE_IMPORT_TARGET_ATTR = 'data-import-target';
const DATA_ROUTE_IMPORT_SOURCE_ATTR = 'data-import-source';

const DATA_ROUTE_ACTION_ATTR = 'data-recued-data-action';
const DATA_ROUTE_TAB_ID_ATTR = 'data-data-tab';
const DATA_ROUTE_TAB_PANEL_ID = 'recued-data-collection-panel';
const DATA_ROUTE_CONTACT_EMAIL_ATTR = 'data-contact-email';
const DATA_ROUTE_FORM_RESPONSE_ID_ATTR = 'data-form-response-id';
const DATA_ROUTE_CONTACT_FIELD_ATTR = 'data-recued-data-contact-field';
const DATA_ROUTE_CONTACT_SEARCH_ATTR = 'data-recued-data-contact-search';
const DATA_ROUTE_TIMELINE_ENTITY_ATTR = 'data-recued-data-timeline-entity';
const SHARED_ACTION_ATTR = 'data-action';
const DEFAULT_LIMIT = 100;

type DataWorkEntityKind = Exclude<WorkEntityKind, 'asset'>;
export type DataOwnItTabId = 'contact' | DataWorkEntityKind;
const DATA_WORK_ENTITY_KINDS = WORK_ENTITY_KINDS.filter((kind): kind is DataWorkEntityKind => kind !== 'asset');
export type DataReceivedTabId = 'form_response';
/** D-315 §6 — Data → Received → Mail facts. Its own tab type, like `webhook`:
 *  a member of `DATA_RECEIVED_TABS` would be sent to the form-response
 *  renderer (`isReceivedTab`). It renders through `mail-facts-surface.ts`. */
export type DataMailFactTabId = 'mail_fact';
/** D-324 — Data → Owned → Reminders. Its own tab type, like `mail_fact`: it
 *  renders through `reminders-surface.ts`, not the work-entity tables. */
export type DataReminderTabId = 'reminder';
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
  | DataMailFactTabId
  | DataReminderTabId
  | MirrorDataKind
  | 'records'
  | 'search'
  | DataSingleCollectionTabId;

export const DATA_OWN_IT_TABS: readonly DataOwnItTabId[] = [
  'contact',
  ...DATA_WORK_ENTITY_KINDS,
];

export const DATA_MIRROR_TABS: readonly MirrorDataKind[] = [
  'mail',
  'calendar',
  'crm',
  'files',
];

/** D-210 final two-record model: Reception Records is the immutable, redacted
 *  arrival ledger; Data → Form responses is the mutable owner working copy.
 *  Keep this tab addressable because editing, lifecycle changes, exports, and
 *  recipe continuation all belong on the working-copy surface. */
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
export const DATA_RECORDS_TABS: readonly DataTabId[] = ['records'];

/** Its own cluster: universal search is a FINDING surface ACROSS the other
 *  clusters, not another lens within one of them. Grouping it under "Connected"
 *  or "Owned" would imply a scope it does not have. */
const DATA_SEARCH_TABS: readonly DataTabId[] = ['search'];

// ⛔ D-290 — `today` is not here, and is no longer a `DataTabId` at all. Today
// is its own `#today` route and
// `parseShellRoute` rewrites the legacy address; leaving it here would let
// this route build a `#data/today` link that the parser re-points at another
// surface, and `dataAddress` then throws on its own address.
const DATA_TABS: readonly DataTabId[] = [
  ...DATA_OWN_IT_TABS,
  'reminder',
  ...DATA_RECEIVED_TABS,
  'mail_fact',
  ...DATA_MIRROR_TABS,
  ...DATA_PROVENANCE_TABS,
  ...DATA_SHARED_TABS,
  ...DATA_RECORDS_TABS,
  // 2026-08-28 — universal search. Last in the list because it is a FINDING
  // surface across the others rather than another lens onto one collection.
  'search',
];

/** The "Received" cluster's DISPLAY tabs — `form_response` (its own bespoke
 *  surface) + `mail_fact`. Distinct from `DATA_RECEIVED_TABS`, which stays the
 *  `isReceivedTab` render-dispatch basis (form_response only).
 *
 *  ⛔ A "Webhook deliveries" tab sat here until 2026-10-10: a collection
 *  browser over the Phase D webhook collection, which nothing in production
 *  ever created, so it was always empty. D-201 deliveries are shown on the
 *  owner's Connections → Webhooks panel. */
const DATA_RECEIVED_CLUSTER: readonly DataTabId[] = [...DATA_RECEIVED_TABS, 'mail_fact'];

/** D-324 — the "Owned" cluster's DISPLAY tabs: contacts, the work entities, and
 *  the owner's reminders (their own surface, as Mail facts is in Received). */
const DATA_OWNED_CLUSTER: readonly DataTabId[] = [...DATA_OWN_IT_TABS, 'reminder'];

export type WorkEntitySourceListCaller = () => Promise<{
  sources: ReadonlyArray<SourceRegistration>;
}>;

export type DataWorkEntityListCaller = (
  args: WorkEntityListRpcRequest,
) => Promise<WorkEntityListRpcResponse>;
export type DataWorkEntitySearchCaller = (args: WorkEntitySearchRpcRequest) => Promise<WorkEntitySearchRpcResponse>;
export type DataWorkEntityGetCaller = (
  args: WorkEntityGetRpcRequest,
) => Promise<WorkEntityGetRpcResponse>;
export type DataWorkEntityUpsertCaller = (
  args: WorkEntityUpsertRpcRequest,
) => Promise<WorkEntityUpsertRpcResponse>;
export type DataTaskMarkDoneCaller = (
  args: WorkEntityTaskMarkDoneRpcRequest,
) => Promise<WorkEntityTaskMarkDoneRpcResponse>;
export type DataCommitmentCloseCaller = (
  args: { id: string; outcome: 'fulfill' | 'cancel' },
) => Promise<{ entity: Extract<WorkEntity, { _kind: 'commitment' }> }>;
export type DataWorkEntityDeleteCaller = (
  args: WorkEntityDeleteRpcRequest,
) => Promise<WorkEntityDeleteRpcResponse>;

/** Owner-only mint of a short-lived, single-use manage link for one Reception
 * booking. The host supplies an absolute URL because the WS RPC has no request
 * Host from which to derive the paired server's origin. */
export type DataManageRescheduleLinkCaller = (
  input: { booking_id: string },
) => Promise<{ url: string; expires_at: number }>;

export type DataContactListCaller = (args: {
  query?: string;
  name_contains?: string;
  source?: ContactSource;
  since?: number;
  phone_exact?: string;
  limit?: number;
  offset?: number;
  with_rollups?: boolean;
}) => Promise<{
  contacts: ContactRecord[]; total: number;
  rollups?: Record<string, TimelineRollup[]>;
}>;
export type DataContactGetCaller = (
  args: { email: string },
) => Promise<{ contact: ContactRecord | null; identifiers?: ContactAdditionalIdentifiers }>;
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
    birthday?: string | null;
    anniversary?: string | null;
    relationship?: import('@recued/contracts').ContactRelationship | null;
    privacy_marks?: import('@recued/contracts').ContactPrivacyMark[];
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
  occasions?: ReadonlyArray<ContactImportOccasionSelection>;
}) => Promise<{
  added: number;
  changed: number;
  occasions_saved?: number;
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
export type DataFormResponseUpdateCaller = (
  args: FormResponseUpdateRpcRequest,
) => Promise<FormResponseUpdateRpcResponse>;
export type DataFormResponseSetStateCaller = (
  args: FormResponseSetStateRpcRequest,
) => Promise<FormResponseSetStateRpcResponse>;
export type DataFormResponseExportCaller = (
  args: FormResponseExportRpcRequest,
) => Promise<FormResponseExportRpcResponse>;
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
/** D-198 §10 — the owner undoes an AGENT's forget (`memory.restore`). Absent →
 *  no Restore on agent-forgotten rows. */
export type DataMemoryRestoreCaller = (args: MemoryRestoreRequest) => Promise<MemoryRestoreResult>;
/** D-198 §12 — the owner replaces an agent's entry with their own version
 *  (`memory.replace`). Absent → Replace reports that saving is unavailable. */
export type DataMemoryReplaceCaller = (args: MemoryReplaceRequest) => Promise<MemoryMutationResult>;

/** D-198 Slice 5 — the generic collection-explorer reads (schema-driven
 *  list→detail over the adapter-backed collections). All three present → the
 *  mail/calendar tabs browse records; absent → a not-wired notice. */
export type DataCollectionListInstancesCaller = () => Promise<{
  instances: CollectionInstanceRow[];
}>;
export type DataCollectionListCaller = (
  args: CollectionListQuery,
) => Promise<{ records: CollectionRecord[]; source_freshness?: CollectionSourceFreshness }>;
/** UNIVERSAL SEARCH — one query fanned across every collection, GROUPED. */
export type DataCollectionSearchAllCaller = (
  args: { query: string; per_group?: number },
) => Promise<{ groups: CollectionSearchGroup[]; did_you_mean?: CollectionSearchDidYouMean; absent_words?: string[] }>;
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

/** D-221 — owner-pair control plane. Deliberately separate from `data.*` and
 * from the grant-gated Tier-P executor used by recipes and MCP callers. */
export type DataRecordsNamespaceListCaller = () => Promise<{
  namespaces: RecordsNamespaceView[];
  global_quota: RecordsGlobalQuotaSnapshot;
}>;
export type DataRecordsKindListCaller = (
  args: { owner: RecordsPackRef },
) => Promise<{ kinds: RecordsKindSummary[] }>;
export type DataRecordsSearchCaller = (
  args: RecordsOwnerSearchRequest,
) => Promise<{ records: RecordsFriendlyRecord[]; next_cursor?: string; prev_cursor?: string }>;
export type DataRecordsGetCaller = (
  args: RecordsOwnerGetRequest,
) => Promise<RecordsOwnerGetResponse>;
export type DataRecordsDeleteCaller = (
  args: RecordsOwnerDeleteRequest,
) => Promise<{ deleted: true; id: string; revision: number }>;
export type DataRecordsRetentionListCaller = (
  args: { owner: RecordsPackRef },
) => Promise<{ policies: Record<string, RecordsRetentionPolicy> }>;
export type DataRecordsExportCaller = (
  args: RecordsExportRequest,
) => Promise<RecordsExportResponse>;
export type DataRecordsOutboxListCaller = (
  args: RecordsOutboxListRequest,
) => Promise<RecordsOutboxOverview>;
export type DataRecordsOutboxRetireCaller = (
  args: RecordsOutboxRetireRequest,
) => Promise<{ retired: boolean }>;
/** P2/F2 — one bounded page of a pack's change history. */
export type DataRecordsChangesListCaller = (
  args: RecordsChangeQuery,
) => Promise<RecordsChangeFeed>;
/** P2/F2 — stamp the review mark onto the BOUND saved view. Absent, or no view
 *  bound, and the panel still reads; only the mark is unavailable. */
export type DataRecordsMarkReviewedCaller = (
  args: SavedDataViewUpdateRequest,
) => Promise<{ view: SavedDataView }>;
export type DataRecordsPurgeCaller = (
  args: RecordsPurgeRequest,
) => Promise<{ rows_deleted: number; events_deleted: number }>;

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
export type DataFileReadCaller = (args: Parameters<FilePreviewCallers['read']>[0]) =>
  Promise<Awaited<ReturnType<FilePreviewCallers['read']>> & { size_bytes: number }>;

export interface BootstrapDataRouteOptions {
  /** Resolved by the saved-view host before any collection reads start. */
  savedView?: SavedDataView;
  /** Settings changes, including entering/leaving a detail or draft (null). */
  onViewChange?: (definition: SavedDataViewDefinition | null) => void;
  hideHeading?: boolean;
  root: HTMLElement;
  document?: Document;
  proactiveTodayCaller?: (input: { now: number; before: number }) => Promise<import('@recued/contracts').ProactiveToday>;
  workEntitySourceListCaller?: WorkEntitySourceListCaller;
  workEntityListCaller?: DataWorkEntityListCaller;
  workEntitySearchCaller?: DataWorkEntitySearchCaller;
  assetSearchCaller?: AssetSearchCaller;
  searchContinuityOwner?: object;
  projectItemsCaller?: ProjectItemsCaller;
  workEntityGetCaller?: DataWorkEntityGetCaller;
  onOwnerRecordOpened?: (ref: import('@recued/contracts').SituationRef) => void;
  workEntityUpsertCaller?: DataWorkEntityUpsertCaller;
  taskMarkDoneCaller?: DataTaskMarkDoneCaller;
  commitmentCloseCaller?: DataCommitmentCloseCaller;
  workEntityDeleteCaller?: DataWorkEntityDeleteCaller;
  manageRescheduleLinkCaller?: DataManageRescheduleLinkCaller;
  contactListCaller?: DataContactListCaller;
  contactGetCaller?: DataContactGetCaller;
  contactHistoryCaller?: (id: string) => Promise<Pick<import('@recued/contracts').YoursSnapshot, 'episodes' | 'occasions'>>;
  /** D-325 P44 — hide an episode cited on a contact's page (`yours.change` episode.hide). */
  contactEpisodeHideCaller?: (id: string) => Promise<unknown>;
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
  formResponseUpdateCaller?: DataFormResponseUpdateCaller;
  formResponseSetStateCaller?: DataFormResponseSetStateCaller;
  formResponseExportCaller?: DataFormResponseExportCaller;
  /** Browser download injection; tests and non-browser hosts can capture the
   * bounded export without relying on Blob/ObjectURL globals. */
  formResponseDownload?: (file: FormResponseExportRpcResponse) => void;
  /** D-315 §6 — Data → Received → Mail facts: every rpc the tab calls. An
   *  absent caller hides what needs it. */
  mailFactCallers?: MailFactCallers;
  /** D-324 — Data → Owned → Reminders: the list, a new time, a cancel. An
   *  absent caller hides what needs it. */
  reminderCallers?: ReminderCallers;
  calendarEventCallers?: CalendarEventCallers;
  calendarCreateCallers?: CalendarCreateCallers;
  mailMessageCallers?: MailMessageCallers;
  mailCompose?: import('../mail/mail-compose-host.js').MailComposeDeps;
  /** Owner-only installed recipe discovery + manual execution for explicitly
   *  continuing one already accepted response. Both must be present for the
   *  detail affordance to render. */
  recipeListCaller?: DataRecipeListCaller;
  recipeExecuteCaller?: RunModal.RunModalExecuteCaller;
  /** The shared guided importer; execution still belongs to the selected pack's recipe. */
  sheetImportUploadCaller?: SheetImportUploader;
  fileRefSearchCaller?: WireSheetImportOptions['fileRefSearch'];
  sheetImportSettings?: MainDishSettings;
  followHeldRun?: HeldRunFollower['follow'];
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
  /** D-198 §10 — `memory.restore`, for the Restore on an agent-forgotten row. */
  memoryRestoreCaller?: DataMemoryRestoreCaller;
  /** D-198 §12 — `memory.replace`, for the Replace on an agent's note. */
  memoryReplaceCaller?: DataMemoryReplaceCaller;
  /** D-198 Slice 5 — the collection explorer reads. All three present → the
   *  mail / calendar tabs browse list→detail (from the raw-id drill-down);
   *  absent → the tab shows a not-wired notice. */
  collectionListInstancesCaller?: DataCollectionListInstancesCaller;
  collectionListCaller?: DataCollectionListCaller;
  collectionGetCaller?: DataCollectionGetCaller;
  /** Present → the Search tab searches every collection; absent → a not-wired
   *  notice, matching how every other read caller degrades here. */
  collectionSearchAllCaller?: DataCollectionSearchAllCaller;
  /** Debounce for the universal-search box, matching the contact-search knob. */
  universalSearchDebounceMs?: number;
  /** Installed packs, for the coarser half of the capability search. Optional —
   *  absent simply means no packs group, like every other read caller here. */
  packInstalledListCaller?: PackInstalledListCaller;
  /** ⛔ THE ONLY CLOUD CALL THIS SURFACE CAN MAKE, and it fires ONLY on an
   *  explicit click after the owner's own results came back empty. Absent → no
   *  marketplace offer at all, which is also the correct posture for a server
   *  the owner has deliberately kept off the network. */
  marketplacePackSearchCaller?: (query: string) => Promise<{
    packs: ReadonlyArray<{
      slug: string; name: string; description?: string; publisher_id?: string;
    }>;
  }>;
  /** D-198 Phase 2 — the "Provenance" cluster reads (`annotation.list` /
   *  `link.list`). Present → the Annotations / Links tabs browse the whole
   *  collection; absent → a not-wired notice. */
  annotationListCaller?: DataAnnotationListCaller;
  linkListCaller?: DataLinkListCaller;
  /** D-198 Phase 3 — the "Storage" cluster read (`shared.list` over the durable
   *  `data.shared.` prefix). Present → the Shared tab browses; absent → notice. */
  sharedListCaller?: DataSharedListCaller;
  recordsNamespaceListCaller?: DataRecordsNamespaceListCaller;
  recordsKindListCaller?: DataRecordsKindListCaller;
  recordsSearchCaller?: DataRecordsSearchCaller;
  recordsGetCaller?: DataRecordsGetCaller;
  recordsDeleteCaller?: DataRecordsDeleteCaller;
  recordsRetentionListCaller?: DataRecordsRetentionListCaller;
  recordsExportCaller?: DataRecordsExportCaller;
  recordsOutboxListCaller?: DataRecordsOutboxListCaller;
  recordsChangesListCaller?: DataRecordsChangesListCaller;
  recordsMarkReviewedCaller?: DataRecordsMarkReviewedCaller;
  recordsOutboxRetireCaller?: DataRecordsOutboxRetireCaller;
  recordsPurgeCaller?: DataRecordsPurgeCaller;
  /** Test/non-browser seam for the friendly, generation-pinned JSON export. */
  recordsDownload?: (filename: string, envelope: RecordsExportEnvelope) => void;
  /** Test/non-browser seam for the self-describing CSV export. */
  recordsCsvDownload?: (filename: string, envelope: RecordsCsvExportEnvelope) => void;
  // D-172 — Data → File upload. The four rpc callers + the binary-socket
  // connect factory (host-injected, since ui-shared can't reach the token
  // store). All five present → the Files tab renders the drag/drop widget.
  uploadCreateCaller?: DataUploadCreateCaller;
  uploadProbeCaller?: DataUploadProbeCaller;
  uploadFinalizeCaller?: DataUploadFinalizeCaller;
  uploadDeleteCaller?: DataUploadDeleteCaller;
  uploadConnectFactory?: Upload.UploadConnectFactory;
  /** Owner-only return context supplied by Yours, scoped to this connection. */
  fileAttachmentReturn?: { assetId: string; assetName: string };
  filePreviewCallers?: FilePreviewCallers;
  spheres?: SpherePlacementCallers;
  /** D-172 Half-A "open" — file-content read for the Files tab download. Absent
   *  → no download button (metadata-only drill-down). */
  fileReadCaller?: DataFileReadCaller;
  fileChatCallers?: FileChatCallers;
  onUseFileInChat?: (target: { file: import('@recued/contracts').FileAttachmentSelection; sessionId: string | null }) => void;
  fileUsageCaller?: (args: { record_id: string }) => Promise<FileLifecyclePreview>;
  fileMutateCaller?: (args: FileLifecycleMutation) => Promise<FileLifecyclePreview>;
  subscribe?: BroadcastSubscriber['on'];
  /** Keep the shell router's cached hash aligned with successful in-page
   *  history writes, which do not emit hashchange. */
  onHashSync?: (hash: string) => void;
  /** R18 — deep-link hydration (`#data/<tab>/<entity_id>`, R16). `initialTab`
   *  is validated against the known tabs (invalid → the default Contacts tab,
   *  D-290 — it was Today until Today became its own route);
   *  `initialEntityId` opens that entity's timeline detail on the contact +
   *  mirror tabs (work-entity tabs hydrate the tab only — their detail is a
   *  modal edit, not a timeline view yet). */
  initialTab?: string;
  /** Exact collection instance for an explorer record deep link. Without this
   * locator a multi-account Data tab cannot safely choose an instance. */
  initialCollectionSlug?: string;
  initialEntityId?: string;
  initialRecordsTarget?: RecordsRecordAddress;
  /** The address's third segment (`#data/<tab>/<entity>/<detail>`), for a tab
   *  with a third level: Mail facts is `#data/mail_fact/<view>/<detail>`. */
  initialDetailId?: string;
  /** Originating assistant answer for citation drill-down continuity. */
  chatReturn?: ChatAnswerAddress;
  /** Exact run outcome that asked the owner to verify this item. The nested
   * Chat return, when present, remains inside the Logs address. */
  logsReturn?: LogsRunAddress;
  /** Truthful relationship projected from persisted execution provenance.
   * Used only to explain what Data can and cannot establish. */
  verificationRelationship?: DataVerificationRelationship;
  /** The inbound source record has no account slug. Resolve its record id
   * across connected instances and only auto-open an unambiguous match. */
  verifyInitialSourceRecord?: boolean;
  /** R18 — debounce window (ms) for the `warehouse`/`memory` live-update
   *  re-fetch; coalesces a write burst into one refresh. Default 400ms;
   *  `<= 0` refreshes immediately (tests). */
  liveRefreshDebounceMs?: number;
  /** Coalesces keyboard input in the server-backed Contacts search. Default
   *  180ms; `<= 0` refreshes immediately for deterministic route tests. */
  contactSearchDebounceMs?: number;
  /** Coalesces keyboard input in the server-backed Bookings search. Default
   *  180ms; client-filtered work-item kinds remain immediate. */
  bookingSearchDebounceMs?: number;
  /** Clock for relative-time copy and task date windows. */
  now?: () => number;
  /** Server clock for creating reminders and filtering calendar dates. */
  serverTimeZone?: () => string | undefined;
  /** Task search debounce, independently configurable by embedded hosts. */
  taskSearchDebounceMs?: number;
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
  birthday: string;
  anniversary: string;
  relationship: string;
  privacy_marks: string;
}

interface ContactDialogState {
  mode: 'create' | 'edit';
  values: ContactDialogValues;
  errors: Partial<Record<keyof ContactDialogValues, string>>;
  submitting: boolean;
  submit_error: string | null;
  /** The record an edit was filled from. An emptied field clears only what this
   *  record had; the list row or the open detail may not carry the field. */
  original?: ContactRecord;
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
  from_search?: boolean;
  identifiers?: ContactAdditionalIdentifiers;
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
  history?: Pick<import('@recued/contracts').YoursSnapshot, 'episodes' | 'occasions'> | null;
  history_failed?: boolean;
  /** D-325 P44 — the server can hide an episode cited here. */
  history_can_hide?: boolean;
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

/** Host-only busy-owner extension. Keeping the intersection local also lets the
 *  webclient's write-free project-reference check consume an older ui-shared
 *  declaration build while the source package change is validated separately. */
type ContactMergeDialogState = MergeReviewDialogState & {
  saving_action?: 'confirm' | 'reject';
};

/** D-205 #2b — the merge scan page (`#data/contact/scan`). */
interface ContactScanState {
  /** The ui-shared dialog's own state — items / cursor / survivor overrides /
   *  saving / error. We own it; the dialog is a pure render of it. */
  dialog: ContactMergeDialogState;
  /** Hydrating the candidate queue (`contact.merge.list` + the per-email gets). */
  loading: boolean;
  /** A `scan_now` is in flight. */
  scanning: boolean;
  progress: ContactScanProgress | null;
  /** Outcome of the last completed scan, for the "what just happened" line. */
  last_scan: { iterated: number; surfaced_count: number } | null;
  /** Last user-authored decision retained while its queue reconciliation paints. */
  last_resolution: 'confirm' | 'reject' | null;
}

export interface DataRoute {
  getRunPageContext(): RunPageContext | null;
  currentView(): SavedDataViewDefinition | null;
  /** Rebind saved settings without reloading records or disposing a draft. */
  bindSavedView(view: SavedDataView): void;
  /** Remove the bookmark binding without tearing down a Data action or its draft. */
  detachSavedView(): void;
  getRecoveryContextFreshness(): 'current' | 'unavailable';
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
  /** A user-started source write, import, scan, run, or save is settling. */
  hasInFlightWork(): boolean;
  /** Contextual shell leave copy for an owned Records operation. */
  inFlightWorkPrompt(): string | null;
  /** D-315 — a mail-fact template or kind of email being edited has changes
   *  not saved: the shell asks before the page is left or reloaded. */
  hasUnsavedChanges(): boolean;
  unsavedChangesPrompt(): string | null;
  refresh(): void;
  whenLoaded(): Promise<void>;
  /** Keep an owned search return in the current route on native Back. */
  navigateDeepLink?(hash: string): boolean;
  selectTab(tab: DataTabId): Promise<void>;
  openCreateWorkEntityDialog(): void;
  openEditWorkEntityDialog(kind: WorkEntityKind, id: string, intent?: 'read' | 'edit' | 'details'): Promise<void>;
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
  saveFormResponse(): Promise<void>;
  exportFormResponses(format: 'json' | 'csv'): Promise<void>;
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
[${DATA_ROUTE_CHAT_RETURN_ATTR}],
[${DATA_ROUTE_LOGS_RETURN_ATTR}],
[${DATA_ROUTE_VERIFICATION_NEXT_ATTR}] {
  min-height: 44px;
  margin: 0 0 14px;
  padding: 9px 11px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface-subtle);
  color: var(--muted);
  font-size: 12px;
  line-height: 1.4;
}
[${DATA_ROUTE_CHAT_RETURN_ATTR}] {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
[${DATA_ROUTE_LOGS_RETURN_ATTR}] {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 10px 16px;
  align-items: center;
  border-color: color-mix(in srgb, var(--accent) 28%, var(--border));
}
[${DATA_ROUTE_VERIFICATION_NEXT_ATTR}] {
  display: grid;
  gap: 8px;
  margin: 16px 0 0;
  border-color: color-mix(in srgb, var(--accent) 28%, var(--border));
}
[${DATA_ROUTE_LOGS_RETURN_ATTR}] .data-verification-copy,
[${DATA_ROUTE_VERIFICATION_NEXT_ATTR}] .data-verification-copy {
  display: grid;
  gap: 3px;
  min-width: 0;
}
[${DATA_ROUTE_LOGS_RETURN_ATTR}] .data-verification-label,
[${DATA_ROUTE_VERIFICATION_NEXT_ATTR}] .data-verification-label {
  color: var(--accent);
  font-size: 10px;
  font-weight: 750;
  letter-spacing: .05em;
  text-transform: uppercase;
}
[${DATA_ROUTE_LOGS_RETURN_ATTR}] .data-verification-title,
[${DATA_ROUTE_VERIFICATION_NEXT_ATTR}] .data-verification-title {
  color: var(--fg);
  font-size: 13px;
}
[${DATA_ROUTE_LOGS_RETURN_ATTR}] .data-verification-detail,
[${DATA_ROUTE_LOGS_RETURN_ATTR}] .data-verification-boundary,
[${DATA_ROUTE_VERIFICATION_NEXT_ATTR}] .data-verification-detail {
  margin: 0;
}
[${DATA_ROUTE_LOGS_RETURN_ATTR}] .data-verification-boundary {
  color: var(--fg);
}
[${DATA_ROUTE_LOGS_RETURN_ATTR}] .data-verification-actions,
[${DATA_ROUTE_VERIFICATION_NEXT_ATTR}] .data-verification-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 6px;
}
[${DATA_ROUTE_CHAT_RETURN_ATTR}] a,
[${DATA_ROUTE_LOGS_RETURN_ATTR}] a,
[${DATA_ROUTE_VERIFICATION_NEXT_ATTR}] a {
  box-sizing: border-box;
  min-height: 44px;
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  padding: 4px 8px;
  border-radius: 6px;
  color: var(--accent);
  font-weight: 680;
  text-decoration: none;
}
[${DATA_ROUTE_VERIFICATION_NEXT_ATTR}] a[data-kind="primary"] {
  border: 1px solid var(--accent);
  background: var(--accent);
  color: var(--on-accent);
}
[${DATA_ROUTE_VERIFICATION_NEXT_ATTR}] a[data-kind="primary"]:hover,
[${DATA_ROUTE_VERIFICATION_NEXT_ATTR}] a[data-kind="primary"]:focus-visible {
  background: var(--accent-hover, var(--accent));
}
[${DATA_ROUTE_CHAT_RETURN_ATTR}] a:hover,
[${DATA_ROUTE_CHAT_RETURN_ATTR}] a:focus-visible,
[${DATA_ROUTE_LOGS_RETURN_ATTR}] a:hover,
[${DATA_ROUTE_LOGS_RETURN_ATTR}] a:focus-visible,
[${DATA_ROUTE_VERIFICATION_NEXT_ATTR}] a:hover,
[${DATA_ROUTE_VERIFICATION_NEXT_ATTR}] a:focus-visible {
  background: var(--accent-weak);
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
[${DATA_ROUTE_HOST_ATTR}] .data-collection-picker { display: none; }
@media (max-width: 640px) {
  [${DATA_ROUTE_HOST_ATTR}] .data-tab-groups { display: none; }
  [${DATA_ROUTE_HOST_ATTR}] .data-collection-picker {
    display: flex; align-items: center; gap: 12px; margin-bottom: 16px;
    font-size: 13px; font-weight: 600;
  }
  [${DATA_ROUTE_HOST_ATTR}] .data-collection-picker select {
    flex: 1; min-height: var(--wc-control-h, 38px); font-size: 16px;
  }
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
  box-sizing: border-box;
  min-height: 36px;
  display: inline-flex;
  align-items: center;
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
[${DATA_ROUTE_HOST_ATTR}] .data-file-import-occasion { flex: 1; min-inline-size: 0; margin: 0; padding: 12px; border: 1px solid var(--border); border-radius: 8px; }
[${DATA_ROUTE_HOST_ATTR}] .data-file-import-occasions { list-style: none; padding: 0; }
[${DATA_ROUTE_HOST_ATTR}] .data-file-import-occasion legend { font-weight: 600; overflow-wrap: anywhere; }
[${DATA_ROUTE_HOST_ATTR}] .data-file-import-occasion label { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; max-width: 100%; }
[${DATA_ROUTE_HOST_ATTR}] .data-file-import-occasion select { min-width: 0; width: 100%; max-width: 100%; }
[${DATA_ROUTE_HOST_ATTR}] .data-file-actions { display: flex; flex: 1; flex-wrap: wrap; justify-content: flex-end; gap: 8px; min-width: 0; }
[${DATA_ROUTE_HOST_ATTR}] [data-file-lifecycle] {
  flex-basis: 100%; box-sizing: border-box; min-width: 0; border: 1px solid var(--border);
  border-radius: 8px; padding: 12px; background: var(--surface); font-size: 13px; line-height: 1.5;
}
[${DATA_ROUTE_HOST_ATTR}] [data-file-lifecycle] h3 { margin: 0 0 8px; font-size: 14px; }
[${DATA_ROUTE_HOST_ATTR}] [data-file-lifecycle] p,
[${DATA_ROUTE_HOST_ATTR}] [data-file-lifecycle] ul { margin: 0 0 10px; overflow-wrap: anywhere; }
[${DATA_ROUTE_HOST_ATTR}] [data-file-lifecycle] button { margin: 0 6px 6px 0; }
[${DATA_ROUTE_HOST_ATTR}] [data-file-lifecycle] [role="alert"] { color: var(--danger); }
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
[${DATA_ROUTE_HOST_ATTR}] .data-button:disabled,
[${DATA_ROUTE_HOST_ATTR}] .data-button[aria-disabled="true"] {
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
  min-width: 0;
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
  min-width: 0;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 12px;
  margin: 12px 0;
}
[${DATA_ROUTE_FORM_RESPONSE_DETAIL_ATTR}] .data-response-header h2 {
  min-width: 0;
  margin: 0;
  overflow-wrap: anywhere;
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
[${DATA_ROUTE_FORM_RESPONSE_DISCARD_GUARD_ATTR}] {
  display: grid;
  gap: 10px;
  margin-bottom: 14px;
  padding: 14px;
  border: 1px solid var(--danger);
  border-radius: 8px;
  background: var(--danger-weak);
}
[${DATA_ROUTE_FORM_RESPONSE_DISCARD_GUARD_ATTR}] h3,
[${DATA_ROUTE_FORM_RESPONSE_DISCARD_GUARD_ATTR}] p {
  margin: 0;
}
[${DATA_ROUTE_HOST_ATTR}] .data-form-response-discard-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
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
  min-width: 0;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
  padding: 10px 12px;
}
[${DATA_ROUTE_FORM_RESPONSE_DETAIL_ATTR}] .data-response-meta dt,
[${DATA_ROUTE_FORM_RESPONSE_DETAIL_ATTR}] .data-response-field dt {
  margin-bottom: 5px;
  overflow-wrap: anywhere;
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
  grid-template-columns: minmax(0, 1fr);
  gap: 8px;
  margin: 0;
}
[${DATA_ROUTE_FORM_RESPONSE_DETAIL_ATTR}] .data-form-response-detail-content,
[${DATA_ROUTE_FORM_RESPONSE_DETAIL_ATTR}] .data-response-editor {
  min-width: 0;
}
[${DATA_ROUTE_FORM_RESPONSE_DETAIL_ATTR}] .data-response-editor .data-row-subtle,
[${DATA_ROUTE_FORM_RESPONSE_DETAIL_ATTR}] .data-response-editor [role="alert"] {
  overflow-wrap: anywhere;
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
[${DATA_ROUTE_HOST_ATTR}] .data-contact-rollup {
  display: inline-flex;
  align-items: baseline;
  gap: 5px;
  margin: 3px 6px 0 0;
  padding: 1px 7px;
  border-radius: 999px;
  background: var(--surface-sunk);
  border: 1px solid var(--border);
  font-size: 11px;
  line-height: 1.6;
}
[${DATA_ROUTE_HOST_ATTR}] .data-contact-rollup-label {
  color: var(--text-subtle);
}
[${DATA_ROUTE_HOST_ATTR}] .data-contact-rollup-value {
  color: var(--text);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
/* A bounded walk reads as bounded. The dashed edge carries the same claim as
   the "at least" prefix, so the marker survives a narrow viewport that
   truncates the text. */
[${DATA_ROUTE_HOST_ATTR}] .data-contact-rollup--partial {
  border-style: dashed;
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
  overflow-wrap: anywhere;
}
[${DATA_ROUTE_HOST_ATTR}] .data-contact-detail-heading .data-section-title {
  margin: 0;
}
[${DATA_ROUTE_CONTACT_DETAIL_HEADING_ATTR}]:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 3px;
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
[${DATA_ROUTE_CONTACT_DISCARD_GUARD_ATTR}] {
  display: grid;
  gap: 10px;
  padding: 14px;
  border: 1px solid var(--danger);
  border-radius: 8px;
  background: var(--danger-weak);
}
[${DATA_ROUTE_CONTACT_DISCARD_GUARD_ATTR}] h3,
[${DATA_ROUTE_CONTACT_DISCARD_GUARD_ATTR}] p {
  margin: 0;
}
[${DATA_ROUTE_HOST_ATTR}] .data-contact-discard-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
@media (max-width: 720px) {
  [${DATA_ROUTE_HOST_ATTR}] .data-header {
    display: grid;
  }
  [${DATA_ROUTE_HOST_ATTR}] .data-input {
    width: 100%;
  }
  [${DATA_ROUTE_LOGS_RETURN_ATTR}] {
    grid-template-columns: minmax(0, 1fr);
  }
  [${DATA_ROUTE_LOGS_RETURN_ATTR}] .data-verification-actions {
    justify-content: flex-start;
  }
}
@media (max-width: 560px) {
  [${DATA_ROUTE_LOGS_RETURN_ATTR}] .data-verification-actions a,
  [${DATA_ROUTE_VERIFICATION_NEXT_ATTR}] .data-verification-actions a {
    width: 100%;
    justify-content: center;
  }
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

const dataVerificationGuidance = (
  relationship: DataVerificationRelationship | undefined,
): { readonly title: string; readonly detail: string } => {
  switch (relationship) {
    case 'derived':
      return {
        title: 'Check the record that was made or changed',
        detail:
          'The run wrote this. Check the values here are what you wanted.',
      };
    case 'involved':
      return {
        title: 'Check the item that was touched',
        detail:
          'A step that changes things touched this item. Compare what you see here with what you wanted. The link on its own does not prove anything changed.',
      };
    case 'action':
      return {
        title: 'Look at the record that was used',
        detail:
          'Something outside Recued used this record. It explains what happened, but it does not prove the other side changed.',
      };
    default:
      return {
        title: 'Look at this item',
        detail:
          'Look at what Data shows now, then decide whether anything else is needed.',
      };
  }
};

const errMessage = (err: unknown): string =>
  humanizeRpcError(err);

const isWorkEntityTab = (tab: DataTabId): tab is DataWorkEntityKind =>
  (DATA_WORK_ENTITY_KINDS as readonly string[]).includes(tab);

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
};
/** The tabs the collection explorer serves — keep in sync with the keys of
 *  `EXPLORER_TAB_PLATFORM`. A type predicate (not just `boolean`) so the render
 *  dispatch can prove the non-explorer mirror fallback is `crm`-only. */
type ExplorerTabId = 'mail' | 'calendar' | 'files';
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

const RUN_ADDRESSABLE_DATA_TABS: readonly DataEntityVerificationTab[] = [
  'contact',
  'form_response',
  'crm',
  ...DATA_WORK_ENTITY_KINDS,
  'annotation',
  'link',
  'shared',
];

const isRunAddressableDataTab = (
  tab: DataTabId,
): tab is DataEntityVerificationTab =>
  (RUN_ADDRESSABLE_DATA_TABS as readonly string[]).includes(tab);

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
    case 'search':
      return 'Search';
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
    case 'mail_fact':
      return 'Mail facts';
    case 'reminder':
      return 'Reminders';
    case 'mail':
      return 'Mail';
    case 'calendar':
      return 'Calendar';
    case 'crm':
      return 'CRM';
    case 'files':
      return 'Files';
    case 'annotation':
      return 'Annotations';
    case 'link':
      return 'Links';
    case 'shared':
      return 'Shared';
    case 'records':
      return 'Pack records';
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

/** A form timestamp as epoch ms.
 *
 *  ⛔ FOUND LIVE: the dialog reads a date-time field back as an ISO STRING (with
 *  this browser's offset) and this took numbers only, so every save dropped
 *  the due date — an edit kept the old one, a new task got none — and the
 *  dialog closed as if it had worked.
 *
 *  An UNTOUCHED field keeps its stored value exactly: the input shows minutes,
 *  and a whole-day due as its day at midnight, so reading the display back
 *  would drop seconds and turn a day into this zone's midnight. For a DUE
 *  (`due`), midnight names a whole day; an already timed task keeps its timed
 *  meaning even at midnight, as Today does. Timed values stay off 00:00 UTC
 *  so they cannot read as days. */
const timestampValue = (
  value: unknown,
  original: unknown,
  due: boolean,
  preserveTimedDue = false,
): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string' || value.length === 0) return undefined;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return undefined;
  if (
    typeof original === 'number' && Number.isFinite(original)
    && formatTimestampForInput(original) === formatTimestampForInput(value)
  ) return original;
  if (!due) return ms;
  const shown = formatTimestampForInput(value);
  if (shown.endsWith('T00:00') && (!preserveTimedDue
    || typeof original !== 'number' || isDateOnlyDue(original))) {
    const [year, month, day] = shown.slice(0, 10).split('-').map(Number) as [number, number, number];
    return Date.UTC(year, month - 1, day);
  }
  return timedDueMs(ms);
};

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

/** `setIfDefined` that keeps a `null` — the value that removes a date. */
const setIfPresent = (
  target: Record<string, unknown>,
  key: string,
  value: unknown,
): void => {
  if (value !== undefined) target[key] = value;
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
  mode?: 'create' | 'edit',
): FormDefinition => {
  const schema = getCanonicalSchema(kind);
  const extension = sourceExtensionSchema(source);
  const definition = extension === null
    ? formFromCanonicalSchema(schema)
    : formFromCanonicalSchemaWithExtension(schema, extension);
  const editable = kind === 'task' && mode === 'edit'
    ? { ...definition, fields: definition.fields.filter(
        (field) => field.name !== 'done' && field.name !== 'completed_at',
      ) }
    : kind === 'commitment'
      ? { ...definition, fields: definition.fields.filter(field => field.name !== 'lifecycle_state') }
      : definition;
  return allowEmptyRefArrays(editable);
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
  sources.filter((source) => source.top_tier_kind === kind);

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
  /** The values the edit dialog opened with — what an untouched date-time
   *  field keeps. Absent for a create. */
  original: Readonly<Record<string, unknown>> = {},
): WorkEntityUpsertRpcRequest => {
  if (state.dialog === null) {
    throw new Error('No item is open.');
  }
  const values = state.dialog.values;
  const when = (field: string, due = false): number | undefined =>
    timestampValue(values[field], original[field], due, kind === 'task');
  const update = state.dialog.mode === 'edit';
  /** A due-style date on an edit, where emptying the field REMOVES the date
   *  (`null`; a task says it with `clear_due_at`).
   *  ⛔ It used to be dropped like any blank, so the saved date came back: the
   *  owner cleared it, pressed Save, and nothing changed. On another server's
   *  record the peer Source sends the removal as its clear flag. */
  const dueOrCleared = (field: string): number | null | undefined => {
    const cleared = update
      && (values[field] === '' || values[field] === null)
      && typeof original[field] === 'number';
    return cleared ? null : when(field, true);
  };
  const out: Record<string, unknown> = { kind };
  if (update) {
    out.id = state.dialog.entity_id;
  } else {
    out.source_id = state.dialog.source_id;
  }

  switch (kind) {
    case 'task':
      if (update && typeof original.priority === 'string' && (values.priority === '' || values.priority === null)) {
        throw new Error('This task already has a priority. Choose Low, Medium, or High.');
      }
      setIfDefined(out, 'title', nonEmptyString(values.title));
      setIfDefined(out, 'body', typeof values.body === 'string' ? values.body.trim() : undefined);
      // A task's `null` means "not given", so removing its due date is a flag.
      if (dueOrCleared('due_at') === null) out.clear_due_at = true;
      else setIfDefined(out, 'due_at', dueOrCleared('due_at'));
      setIfDefined(out, 'priority', nonEmptyString(values.priority));
      if (!update) {
        setIfDefined(out, 'done', booleanValue(values.done));
        setIfDefined(out, 'completed_at', when('completed_at'));
      }
      setIfDefined(out, 'assigned_contact_id', nonEmptyString(values.assigned_contact));
      setIfDefined(out, 'parent_calendar_event_id', nonEmptyString(values.parent_calendar_event));
      setIfDefined(out, 'linked_mail_thread_id', nonEmptyString(values.linked_mail_thread));
      setIfDefined(out, 'parent_project_id', nonEmptyString(values.parent_project));
      setIfDefined(out, 'blocks_task_ids', stringArrayValue(values.blocks_task));
      break;
    case 'note':
      setIfDefined(out, 'body', typeof values.body === 'string' ? values.body : undefined);
      setIfDefined(out, 'title', typeof values.title === 'string' ? values.title : undefined);
      setIfDefined(out, 'related_contact_ids', stringArrayValue(values.related_contact));
      setIfDefined(out, 'related_calendar_event_ids', stringArrayValue(values.related_calendar_event));
      setIfDefined(out, 'related_mail_thread_ids', stringArrayValue(values.related_mail_thread));
      setIfDefined(out, 'related_project_ids', stringArrayValue(values.related_project));
      break;
    case 'commitment':
      if (!update) {
        setIfDefined(out, 'direction', nonEmptyString(values.direction));
        setIfDefined(out, 'derivation', nonEmptyString(values.derivation));
        setIfDefined(out, 'promised_at', when('promised_at'));
      }
      setIfDefined(out, 'statement', nonEmptyString(values.statement));
      setIfPresent(out, 'promised_for_at', dueOrCleared('promised_for_at'));
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
      setIfDefined(out, 'description', typeof values.description === 'string' ? values.description.trim() : undefined);
      setIfDefined(out, 'state', nonEmptyString(values.state));
      setIfPresent(out, 'target_completion_at', dueOrCleared('target_completion_at'));
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
      setIfDefined(out, 'slot_start_at', when('slot_start_at'));
      setIfDefined(out, 'slot_end_at', when('slot_end_at'));
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
  birthday: contact.birthday ?? '', anniversary: contact.anniversary ?? '', relationship: contact.relationship ?? '', privacy_marks: (contact.privacy_marks ?? []).join(', '),
});

const emptyContactValues = (): ContactDialogValues => ({
  email: '',
  name: '',
  phone: '',
  company: '',
  birthday: '', anniversary: '', relationship: '', privacy_marks: '',
});

const contactDialogFingerprint = (values: ContactDialogValues): string =>
  JSON.stringify(values);

const validateContactDialog = (
  values: ContactDialogValues,
): Partial<Record<keyof ContactDialogValues, string>> => {
  const errors: Partial<Record<keyof ContactDialogValues, string>> = {};
  const email = values.email.trim();
  if (email.length === 0) {
    errors.email = 'Email is required.';
  } else if (!email.includes('@')) {
    errors.email = 'An email address needs an @ in it.';
  }
  for (const key of ['birthday', 'anniversary'] as const) if (values[key].trim() && !isContactAnnualDate(values[key].trim())) errors[key] = 'Use YYYY-MM-DD or --MM-DD for an unknown year.';
  return errors;
};

const hasContactErrors = (
  errors: Partial<Record<keyof ContactDialogValues, string>>,
): boolean => Object.keys(errors).length > 0;

const contactUpsertArgs = (
  values: ContactDialogValues,
  previous?: ContactRecord,
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
  // An emptied date clears the one the contact had; leaving it out would keep it.
  if (values.birthday.trim() || previous?.birthday) out.birthday = values.birthday.trim() || null;
  if (values.anniversary.trim() || previous?.anniversary) out.anniversary = values.anniversary.trim() || null;
  if (values.relationship.trim() || previous?.relationship) out.relationship = values.relationship.trim() as import('@recued/contracts').ContactRelationship || null;
  const marks = values.privacy_marks.split(',').map(mark => mark.trim()).filter(Boolean) as import('@recued/contracts').ContactPrivacyMark[];
  if (marks.length || previous?.privacy_marks?.length) out.privacy_marks = marks;
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

const renderTabButton = (
  tab: DataTabId,
  active: DataTabId,
  locked: boolean,
  groupLabelId: string,
): string => `
  <button
    type="button"
    class="data-tab"
    role="tab"
    ${DATA_ROUTE_TAB_ATTR}="${e(tab)}"
    ${DATA_ROUTE_ACTION_ATTR}="select-tab"
    ${DATA_ROUTE_TAB_ID_ATTR}="${e(tab)}"
    id="recued-data-tab-${e(tab)}"
    aria-controls="${DATA_ROUTE_TAB_PANEL_ID}"
    aria-describedby="${e(groupLabelId)}"
    aria-selected="${tab === active ? 'true' : 'false'}"
    tabindex="${tab === active ? '0' : '-1'}"
    ${locked && tab !== active ? 'aria-disabled="true"' : ''}
    ${tab === active ? 'data-active="true"' : ''}
  >${e(tabLabel(tab))}</button>
`;

// Keep the collection rail as one keyboard composite while preserving its
// visible ownership/storage group labels as descriptions for each tab.
const renderTabGroup = (
  label: string,
  tabs: readonly DataTabId[],
  active: DataTabId,
  locked: boolean,
): string => {
  const labelId = `recued-data-tab-group-${label.toLowerCase()}-label`;
  return `
  <div class="data-tab-group" role="presentation">
    <span class="data-tab-group-label" id="${e(labelId)}">${e(label)}</span>
    <div class="data-tabs" role="presentation">
      ${tabs.map((tab) => renderTabButton(
        tab,
        active,
        locked,
        labelId,
      )).join('')}
    </div>
  </div>
`;
};

const DATA_TAB_GROUPS: readonly { label: string; tabs: readonly DataTabId[] }[] = [
  { label: 'Owned', tabs: DATA_OWNED_CLUSTER },
  { label: 'Received', tabs: DATA_RECEIVED_CLUSTER },
  { label: 'Connected', tabs: DATA_MIRROR_TABS },
  { label: 'Provenance', tabs: DATA_PROVENANCE_TABS },
  { label: 'Storage', tabs: DATA_SHARED_TABS },
  { label: 'Records', tabs: DATA_RECORDS_TABS },
  { label: 'Find', tabs: DATA_SEARCH_TABS },
];
const renderTabs = (active: DataTabId, locked = false): string => `
  <label class="data-collection-picker">Collection
    <select ${DATA_ROUTE_COLLECTION_PICKER_ATTR} aria-controls="${DATA_ROUTE_TAB_PANEL_ID}" ${locked ? 'disabled' : ''}>
      ${DATA_TAB_GROUPS.map(group => `<optgroup label="${e(group.label)}">${group.tabs.map(tab =>
        `<option value="${e(tab)}" ${tab === active ? 'selected' : ''}>${e(tabLabel(tab))}</option>`).join('')}</optgroup>`).join('')}
    </select>
  </label>
  <div class="data-tab-groups" ${DATA_ROUTE_TABLIST_ATTR}
    role="tablist" aria-label="Data collections" aria-orientation="horizontal">
    ${DATA_TAB_GROUPS.map(group => renderTabGroup(group.label, group.tabs, active, locked)).join('')}
  </div>
`;

const renderErrors = (errors: DataLoadErrors): string =>
  Object.entries(errors).filter((entry): entry is [string, string] =>
    typeof entry[1] === 'string' && entry[1].length > 0,
  ).map(([key, message]) => `
    <p ${DATA_ROUTE_SOURCE_ERROR_ATTR}="${e(key)}" role="alert">${e(message)}</p>
  `).join('');

const renderContactDialog = (
  dialog: ContactDialogState | null,
  discardGuardOpen: boolean,
): string => {
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
  const editorStateAttr = discardGuardOpen
    ? ' inert aria-hidden="true"'
    : '';
  const discardGuard = discardGuardOpen
    ? `
        <section
          ${DATA_ROUTE_CONTACT_DISCARD_GUARD_ATTR}
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="data-contact-discard-title"
          aria-describedby="data-contact-discard-description"
          tabindex="-1"
        >
          <h3 id="data-contact-discard-title">Discard your contact changes?</h3>
          <p id="data-contact-discard-description">Your unfinished changes will be lost.</p>
          <div class="data-contact-discard-actions">
            <button type="button" class="data-button"
              ${DATA_ROUTE_ACTION_ATTR}="${DATA_ROUTE_CONTACT_DISCARD_KEEP_ACTION}"
              ${DATA_ROUTE_CONTACT_DISCARD_KEEP_ATTR}>Keep editing</button>
            <button type="button" class="data-button"
              ${DATA_ROUTE_ACTION_ATTR}="${DATA_ROUTE_CONTACT_DISCARD_COMMIT_ACTION}"
              ${DATA_ROUTE_CONTACT_DISCARD_COMMIT_ATTR}>Discard changes</button>
          </div>
        </section>`
    : '';
  return `
    <div ${DATA_ROUTE_CONTACT_DIALOG_ATTR}="${e(dialog.mode)}">
      <section class="data-dialog-panel" role="dialog" aria-modal="true" aria-label="${e(title)}">
        <div class="data-contact-dialog-editor"${editorStateAttr}>
          <header class="data-dialog-header">
            <h2 class="data-dialog-title">${e(title)}</h2>
            <button type="button" class="data-button data-dialog-close"
              ${DATA_ROUTE_ACTION_ATTR}="close-contact-dialog"${dialog.submitting
                ? ' aria-disabled="true"'
                : ''}>Close</button>
          </header>
          <div class="data-form-grid">
            ${renderContactField(
              'email',
              'Email',
              dialog.values.email,
              dialog.mode === 'edit' || dialog.submitting,
              error('email'),
            )}
            ${renderContactField(
              'name',
              'Name',
              dialog.values.name,
              dialog.submitting,
              error('name'),
            )}
            ${renderContactField(
              'phone',
              'Phone',
              dialog.values.phone,
              dialog.submitting,
              error('phone'),
            )}
            ${renderContactField(
              'company',
              'Company',
              dialog.values.company,
              dialog.submitting,
              error('company'),
            )}
            ${renderContactField('birthday', 'Birthday (YYYY-MM-DD or --MM-DD)', dialog.values.birthday, dialog.submitting, error('birthday'))}
            ${renderContactField('anniversary', 'Anniversary (YYYY-MM-DD or --MM-DD)', dialog.values.anniversary, dialog.submitting, error('anniversary'))}
            <label>Relationship
              <select ${DATA_ROUTE_CONTACT_FIELD_ATTR}="relationship" aria-label="Relationship" ${dialog.submitting ? 'disabled' : ''}>
                ${[['', 'Unspecified'], ['family', 'Family'], ['friend', 'Friend'], ['colleague', 'Colleague'], ['client', 'Client']].map(([value, title]) => `<option value="${e(value!)}" ${dialog.values.relationship === value ? 'selected' : ''}>${e(title!)}</option>`).join('')}
              </select>
            </label>
            <fieldset><legend>Exclude from automatic suggestions</legend>
              ${[['hidden', 'Hidden'], ['deceased', 'Deceased'], ['former_partner', 'Former partner']].map(([mark, title]) => `<label><input type="checkbox" ${DATA_ROUTE_CONTACT_FIELD_ATTR}="privacy_marks" data-contact-privacy-mark="${mark}" value="${mark}" ${dialog.values.privacy_marks.split(',').map(value => value.trim()).includes(mark!) ? 'checked' : ''} ${dialog.submitting ? 'disabled' : ''}>${title}</label>`).join('')}
            </fieldset>
            <p>Hidden, deceased and former-partner contacts are excluded from automatic birthday, occasion and memory suggestions. These marks are set by you.</p>
          </div>
          ${submitError}
          <footer class="data-dialog-actions">
            <button type="button" class="data-button data-dialog-cancel"
              ${DATA_ROUTE_ACTION_ATTR}="close-contact-dialog"${dialog.submitting
                ? ' aria-disabled="true"'
                : ''}>Cancel</button>
            <button type="button" class="data-button data-button--primary"
              ${DATA_ROUTE_ACTION_ATTR}="submit-contact-dialog"
              ${dialog.submitting ? 'aria-disabled="true" aria-busy="true"' : ''}>${dialog.submitting ? 'Saving…' : 'Save'}</button>
          </footer>
        </div>
        ${discardGuard}
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
      return 'worked out from your mail and calendar';
    case 'ai_inferred':
      return who !== null ? `guessed by AI, from ${who}` : 'guessed by AI';
    case 'domain_inferred':
      return 'guessed from the email address';
    default:
      // A rung this build has never heard of. Say the raw value rather than
      // dropping the row — an unknown provenance is still provenance.
      return who !== null ? `from ${who}` : String(p.source);
  }
};

const contactProvenanceKind = (
  source: string,
): 'user' | 'source' | 'derived' | 'neutral' => {
  if (source === 'manual' || source === 'user_confirmed') return 'user';
  if (
    source === 'derived'
    || source === 'ai_inferred'
    || source === 'domain_inferred'
  ) return 'derived';
  if (source === 'vendor_meta' || source === 'contact_book') return 'source';
  return 'neutral';
};

const renderContactProvenance = (p: ContactProvenanceLike): string =>
  renderProvenance({
    primary: describeProvenance(p),
    kind: contactProvenanceKind(p.source),
    className: 'data-contact-origin',
    attributes: { 'data-provenance-source': p.source },
  });

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
  push('anniversary', 'Anniversary', contact.anniversary);
  push('relationship', 'Relationship', contact.relationship);
  push('privacy_marks', 'Privacy marks', contact.privacy_marks?.join(', '));
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
          ${renderContactProvenance(row)}
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
          ? renderContactProvenance(p)
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
            <span class="data-row-subtle">${link.state === 'confirmed' ? 'confirmed by you' : 'linked by Recued'}</span>
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
  openingEditor: boolean,
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
      : renderEntityDetailPanel({
          ...deriveEntityDetailProps(state.response, 'contact', state.email, now),
          // The contact title is h2 and the visible Activity section is h3.
          // Keep the shared panel below both instead of promoting its title
          // back to h2 (and its child sections back to h3).
          headingLevel: 4,
        });
  return `
    <section ${DATA_ROUTE_CONTACT_DETAIL_ATTR}="${e(state.email)}">
      <div class="data-contact-toolbar">
        <button type="button" class="data-button"
          ${DATA_ROUTE_ACTION_ATTR}="close-contact-detail">${state.from_search ? '← Back to search' : '← Back to contacts'}</button>
        <button type="button" class="data-button"
          ${DATA_ROUTE_ACTION_ATTR}="open-edit-contact"
          ${DATA_ROUTE_CONTACT_EMAIL_ATTR}="${e(state.email)}"${openingEditor
            ? ' aria-disabled="true" aria-busy="true"'
            : ''}>${openingEditor ? 'Opening editor…' : 'Edit'}</button>
      </div>
      <header class="data-contact-detail-header">
        <span class="data-contact-avatar data-contact-avatar--lg" aria-hidden="true">${e(
          contact !== null ? contactInitial(contact) : '@',
        )}</span>
        <span class="data-contact-detail-heading">
          <h2 class="data-section-title" ${DATA_ROUTE_CONTACT_DETAIL_HEADING_ATTR} tabindex="-1">${e(heading)}</h2>
          <span class="data-row-meta">${e(state.email)}</span>
          ${contact !== null
            ? `<span class="data-row-subtle">${e(contactSourceLabel(contact.source))} · ${e(String(contact.interaction_count))} interactions</span>`
            : ''}
        </span>
      </header>
      ${identity}
      ${state.identifiers ? `<section aria-label="Additional contact details"><dl class="data-contact-fields">
        ${state.identifiers.emails.length ? `<div class="data-contact-field"><dt class="data-label">Other email addresses</dt><dd>${state.identifiers.emails.map(value => e(value)).join('<br />')}</dd></div>` : ''}
        ${state.identifiers.phones.length ? `<div class="data-contact-field"><dt class="data-label">Other phone numbers</dt><dd>${state.identifiers.phones.map(value => e(value)).join('<br />')}</dd></div>` : ''}
      </dl></section>` : ''}
      <h3 class="data-subsection-title">Activity</h3>
      ${timeline}
      ${state.history !== undefined ? `<section data-contact-proactive-history><h3 class="data-subsection-title">Occasions and recorded episodes</h3>
        ${state.history_failed ? '<p role="status">This history could not be read. Reopen the contact to retry.</p>' : state.history === null ? '<p>Loading recorded history…</p>'
          : `<ul>${state.history.occasions.map(row => `<li><a href="#yours/occasions/occasion/${e(encodeURIComponent(row.id))}">${e(row.title)}</a> · ${e(row.source_next_on ?? row.month_day)}</li>`).join('')}
            ${state.history.episodes.map(row => `<li data-contact-episode="${e(row.id)}"><a href="#yours/episodes/episode/${e(encodeURIComponent(row.id))}">${e(row.title)}</a> · ${e(new Date(row.when.from).toLocaleDateString())}
              <a href="#yours/episodes/episode/${e(encodeURIComponent(row.id))}/correct" aria-label="Correct ${e(row.title)}">Correct</a>
              ${state.history_can_hide ? `<button type="button" ${DATA_ROUTE_ACTION_ATTR}="hide-contact-episode" data-episode-id="${e(row.id)}" aria-label="Hide ${e(row.title)}">Hide</button>` : ''}</li>`).join('')}</ul>
            ${!state.history.occasions.length && !state.history.episodes.length ? '<p>No recorded occasions or episodes for this contact.</p>' : ''}`}</section>` : ''}
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
        ${DATA_ROUTE_ACTION_ATTR}="${footerOpts.action}"${footerOpts.loadingMore
          ? ' aria-disabled="true" aria-busy="true"'
          : ''}>
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
  if (at === null) return 'never brought in';
  const ms = Math.max(0, now - at);
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return 'brought in just now';
  if (minutes < 60) return `synced ${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `synced ${hours}h ago`;
  return `synced ${Math.round(hours / 24)}d ago`;
};

/** The one-line summary of what a cycle DID. Deliberately reports the counters a
 *  user can act on — what came in, and what broke — not all twelve. The rest are
 *  in the expandable detail. */
const cycleSummary = (counts: ContactSourceHealth['last_cycle']): string => {
  if (counts === null) return 'no check has finished yet';
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
    out.push(`${counts.failed_rows.toLocaleString()} records could not be brought in`);
  }
  if (counts.mirror_failed > 0) {
    out.push(`${counts.mirror_failed.toLocaleString()} records could not be copied over`);
  }
  if (counts.unkeyable > 0) {
    // Worth its own line: an unkeyable record also POISONS the delete proof, so the
    // Source silently stops reconciling deletions.
    out.push(
      `${counts.unkeyable.toLocaleString()} records had no id Recued could use, so deleting is paused`,
    );
  }
  // NOT a failure, but the user should see it: a walk that could not prove it saw
  // everything disconnects nothing, by design (fail-closed).
  if (!counts.complete) {
    out.push('the last check could not be sure it saw every record');
  }
  return out;
};

const renderContactSourceRow = (source: ContactSourceHealth, now: number): string => {
  const failures = cycleFailures(source.last_cycle);
  const status = source.degraded
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
        <span class="data-row-subtle">${e(relativeSyncTime(source.last_success_at, now))}</span>
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
  const unhealthy = sources.filter((s) => s.degraded || s.stale).length;
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
    occasions: Record<string, ContactImportOccasionSelection & { selected: boolean }>;
    busy: boolean;
    result: { added: number; changed: number; skipped: number; occasions_saved?: number; failures: ReadonlyArray<string> } | null;
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
              ? 'Adds detail to contacts you already have. Nothing brought in yet.'
              // 🔑 THE CLIFF, IN WORDS. `hydrated` is who it enriched; `skipped` is
              // everyone else — and `skipped` is exactly the stranger count, straight
              // off the runner's own per-cycle counters. Nothing new is computed here.
              : `${cycle.hydrated} of your contacts now have more detail · ${cycle.skipped} ${
                  cycle.skipped === 1 ? 'person' : 'people'
                } you have never written to`,
          )}</span>
          <button type="button" class="data-button"
            ${DATA_ROUTE_ACTION_ATTR}="contact-import-browse"
            ${DATA_ROUTE_IMPORT_SOURCE_ATTR}="${e(s.source_id)}">Browse &amp; add</button>`
        : `<span class="data-row-subtle">${e(
            cycle === null
              ? 'Brings in everyone. Nothing brought in yet.'
              : `${cycle.hydrated + cycle.created} contacts brought in · nothing to choose`,
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
  const applying = f?.busy === true && plan !== null;
  const selectedDates = Object.values(f?.occasions ?? {}).filter(date => date.selected).length;

  return `
  <section class="data-file-import">
    <h3 class="data-section-title">From a file</h3>
    <p class="data-row-subtle">A vCard (.vcf) or CSV export. Whatever it says becomes
      <em>your</em> value for that field — the same as typing it in. Review changes before applying them.</p>
    <input type="file" class="data-input" accept=".vcf,.csv,text/vcard,text/csv"
      ${DATA_ROUTE_ACTION_ATTR}="contact-import-file-pick"
      aria-label="Choose a vCard or CSV file" ${applying ? 'disabled' : ''} />

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

      ${(plan.additional_emails ?? 0) + (plan.additional_phones ?? 0) > 0
        ? `<p class="data-row-subtle">Also keeps ${e([plan.additional_emails ? `${plan.additional_emails} additional email address${plan.additional_emails === 1 ? '' : 'es'}` : '', plan.additional_phones ? `${plan.additional_phones} additional phone number${plan.additional_phones === 1 ? '' : 's'}` : ''].filter(Boolean).join(' and '))}. Existing primary emails stay the same.</p>` : ''}

      ${plan.errors.length === 0
        ? ''
        // ⚠ NEVER silently dropped. A row that vanishes is a person missing from the
        // graph, and the user would have no way to know.
        : `<details class="data-file-import-errors">
             <summary>${e(`${plan.errors.length} ${plan.errors.length === 1 ? 'entry' : 'entries'} could not be imported`)}</summary>
             <ul role="list">${plan.errors.map((x) => `<li>${e(x)}</li>`).join('')}</ul>
           </details>`}

      ${(plan.date_notes ?? []).length === 0
        ? ''
        // D-325 — the person imports, but a date that will not remind them is named.
        : `<details class="data-file-import-dates" ${DATA_ROUTE_CONTACT_IMPORT_DATES_ATTR}>
             <summary>${e(`${plan.date_notes!.length} date${plan.date_notes!.length === 1 ? '' : 's'} could not be used as written`)}</summary>
             <ul role="list">${plan.date_notes!.map((x) => `<li>${e(x)}</li>`).join('')}</ul>
           </details>`}

      ${plan.changes.length === 0
        ? ''
        : `
        <label class="data-file-import-changes-toggle">
          <input type="checkbox" ${DATA_ROUTE_ACTION_ATTR}="contact-import-file-toggle-changes"
            ${f!.apply_changes ? 'checked' : ''} ${applying ? 'disabled' : ''} />
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

      ${(plan.occasions ?? []).length ? `
        <h4 class="data-section-title">Significant dates</h4>
        <p class="data-row-subtle">Choose dates to keep in Yours → Occasions, linked to each contact. Birthdays and anniversaries already use their contact reminders. Existing titles, mute settings and reminder rules are kept.</p>
        <div class="data-contact-toolbar">
          <button type="button" class="data-button" ${DATA_ROUTE_ACTION_ATTR}="contact-import-dates-select-all" ${applying || !plan.occasions!.some(date => !date.unavailable) ? 'disabled' : ''}>Select all dates</button>
          <button type="button" class="data-button" ${DATA_ROUTE_ACTION_ATTR}="contact-import-dates-clear" ${applying ? 'disabled' : ''}>Clear dates</button>
          <span class="data-row-subtle">${selectedDates} selected</span>
        </div>
        <ul class="data-list data-file-import-occasions" role="list">${plan.occasions!.map(date => {
          const choice = f!.occasions[date.key];
          return `<li class="data-row"><fieldset class="data-file-import-occasion" ${applying || date.unavailable ? 'disabled' : ''}>
            <legend>${e(`${date.name} · ${date.label}`)}</legend>
            <label class="data-file-import-changes-toggle"><input type="checkbox" data-contact-import-date="${e(date.key)}" data-contact-import-date-field="selected" ${choice?.selected ? 'checked' : ''} />
              ${date.existing ? 'Update this occasion' : 'Add this occasion'}</label>
            <p class="data-row-subtle">${e(date.existing ? `Current: ${date.existing.title} · ${date.existing.date} (${date.existing.recurrence === 'once' ? 'one time' : 'yearly'}). From file: ${date.date}.` : `From file: ${date.date}`)}</p>
            ${date.unavailable ? `<p class="data-row-subtle">${e(date.unavailable)}</p>` : `
            <div class="data-contact-toolbar">
              <label>Repeat <select class="data-input" aria-label="Repeat ${e(date.label)} for ${e(date.name)}" data-contact-import-date="${e(date.key)}" data-contact-import-date-field="recurrence">
                <option value="yearly" ${choice?.recurrence !== 'once' ? 'selected' : ''}>Every year</option>
                <option value="once" ${choice?.recurrence === 'once' ? 'selected' : ''} ${date.date.startsWith('--') ? 'disabled' : ''}>One time</option>
              </select></label>
              ${date.existing ? '<span class="data-row-subtle">Current reminder rules will be kept.</span>' : `<label>Remind <select class="data-input" aria-label="Remind ${e(date.label)} for ${e(date.name)}" data-contact-import-date="${e(date.key)}" data-contact-import-date-field="reminder_days">
                ${[['7', 'One week before and on the day'], ['1', 'One day before and on the day'], ['30', '30 days before and on the day'], ['0', 'On the day'], ['none', 'No reminder']].map(([value, label]) => `<option value="${value}" ${String(choice?.reminder_days ?? (choice?.reminder_days === null ? 'none' : 7)) === value ? 'selected' : ''}>${label}</option>`).join('')}
              </select></label>`}
            </div>`}
          </fieldset></li>`;
        }).join('')}</ul>` : ''}

      <div class="data-contact-toolbar">
        <button type="button" class="data-button data-button--primary"
          ${DATA_ROUTE_ACTION_ATTR}="contact-import-file-apply"
          ${applying
            ? 'aria-disabled="true" aria-busy="true"'
            : plan.adds === 0 && !(f!.apply_changes && plan.changes.length > 0) && selectedDates === 0
              ? 'disabled'
              : ''}>
          ${e(
            f!.busy
              ? 'Importing…'
              : plan.adds === 0 && !(f!.apply_changes && plan.changes.length) && selectedDates > 0
                ? `Import ${selectedDates} occasion${selectedDates === 1 ? '' : 's'}`
                : `Import ${plan.adds} new${
                  f!.apply_changes && plan.changes.length > 0
                    ? ` and ${plan.changes.length} change${plan.changes.length === 1 ? '' : 's'}`
                    : ''
                }${selectedDates ? ` · ${selectedDates} occasion${selectedDates === 1 ? '' : 's'}` : ''}`,
          )}
        </button>
        <button type="button" class="data-button"
          ${DATA_ROUTE_ACTION_ATTR}="contact-import-file-clear"
          ${applying ? 'aria-disabled="true"' : ''}>Cancel</button>
      </div>`}

    ${f?.result == null
      ? ''
      : `<p class="data-row-subtle" role="status" tabindex="-1"
          ${DATA_ROUTE_CONTACT_IMPORT_RESULT_ATTR}>${e(
          `${f.result.added} added · ${f.result.changed} changed${f.result.occasions_saved ? ` · ${f.result.occasions_saved} occasion${f.result.occasions_saved === 1 ? '' : 's'} saved` : ''}${
            f.result.skipped > 0 ? ` · ${f.result.skipped} left as they were` : ''
          }`,
        )}</p>${f.result.failures.length ? `<ul role="alert">${f.result.failures.map(failure => `<li>${e(failure)}</li>`).join('')}</ul>` : ''}`}
  </section>`;
};

const renderContactImportView = (
  state: ContactImportState,
  sources: readonly ContactSourceHealth[],
  canUploadFile: boolean,
): string => {
  const fileApplyPending =
    state.file?.busy === true && state.file.plan !== null;
  const importMutationPending = fileApplyPending || state.promoting;
  const back = `
    <button type="button" class="data-button"
      ${DATA_ROUTE_ACTION_ATTR}="${state.source_id === null ? 'close-contact-import' : 'contact-import-overview'}"
      ${importMutationPending ? 'aria-disabled="true"' : ''}>
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
      } you have never written to`,
    )}</p>

    <div class="data-contact-toolbar">
      <input type="search" class="data-input"
        ${DATA_ROUTE_ACTION_ATTR}="contact-import-search"
        value="${e(state.query)}"
        placeholder="Search by name, email or company"
        aria-label="Search this CRM" ${state.promoting ? 'disabled' : ''} />
      <button type="button" class="data-button data-button--primary"
        ${DATA_ROUTE_ACTION_ATTR}="contact-import-promote"
        ${state.promoting
          ? 'aria-disabled="true" aria-busy="true"'
          : chosen === 0 || state.loading
            ? 'disabled'
            : ''}>
        ${state.promoting ? 'Adding…' : `Add ${chosen === 0 ? '' : chosen} to my contacts`}
      </button>
    </div>

    ${state.result === null
      ? ''
      : `<p class="data-row-subtle" role="status" tabindex="-1"
          ${DATA_ROUTE_CONTACT_IMPORT_RESULT_ATTR}>${e(
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
              ? 'Nobody in this CRM matches what you typed.'
              : // Not "no contacts" — the honest statement is that there is nobody
                // LEFT to add, which is a different and much better thing.
                'You already have everyone from this CRM.',
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
                     ${state.selected.has(c.target_id) ? 'checked' : ''}
                     ${state.promoting ? 'disabled' : ''} />
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
  const scanInProgress = state.scanning || state.progress !== null;
  const mutationPending = state.scanning || state.dialog.saving;
  const summary = state.progress !== null
    ? renderScanProgress(state.progress, now)
    : state.last_scan !== null
      ? `<p class="data-scan-progress" role="status" tabindex="-1"
          ${DATA_ROUTE_SCAN_PROGRESS_ATTR} ${DATA_ROUTE_SCAN_RESULT_ATTR}>Compared ${e(
          state.last_scan.iterated.toLocaleString(),
        )} contacts · ${e(String(state.last_scan.surfaced_count))} new possible duplicate${
          state.last_scan.surfaced_count === 1 ? '' : 's'
        }.</p>`
      : state.loading
        ? '<p class="data-loading">Loading possible duplicates...</p>'
        : '';
  const scanButton = canScan
    ? `<button type="button" class="data-button"
        ${DATA_ROUTE_ACTION_ATTR}="run-merge-scan"
        ${scanInProgress
          ? 'aria-disabled="true" aria-busy="true"'
          : state.loading || state.dialog.saving
            ? 'disabled'
            : ''}>${scanInProgress ? 'Scanning…' : 'Scan again'}</button>`
    : '';
  const resolutionReceipt = state.last_resolution === null
    ? ''
    : `<p class="data-scan-progress" role="status" tabindex="-1"
        ${DATA_ROUTE_MERGE_RESULT_ATTR}>${
        state.last_resolution === 'confirm'
          ? 'Contacts merged'
          : 'Marked as different'
      } · ${state.loading ? 'Getting the list again…' : 'The list is up to date.'}</p>`;
  return `
    <section ${DATA_ROUTE_CONTACT_SCAN_ATTR}>
      <div class="data-contact-toolbar">
        <button type="button" class="data-button"
          ${DATA_ROUTE_ACTION_ATTR}="close-contact-scan"
          ${mutationPending ? 'aria-disabled="true"' : ''}>← Back to contacts</button>
        ${scanButton}
      </div>
      <h2 class="data-section-title">Possible duplicates</h2>
      <p class="data-row-subtle">Recued groups contacts that look like the same person. Nothing is merged until you say so, and a merge can be undone.</p>
      ${summary}
      ${resolutionReceipt}
      ${state.loading || scanInProgress ? '' : renderMergeReviewDialog({
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


/** D-226 — what one pack says about one contact, as a row of chips.
 *
 *  ⛔ EXPORTED AND PURE ON PURPOSE. Rendering a rollup is where the server's
 *  honesty can quietly be thrown away: an `incomplete` rollup drawn as a plain
 *  number is a figure the server refused to vouch for, presented as fact. That
 *  is a presentation bug with the blast radius of a data bug, so it is a
 *  separately tested function rather than an expression inside a template. */
export const contactRollupChips = (
  rollups: readonly TimelineRollup[] | undefined,
): { label: string; text: string; complete: boolean }[] => {
  if (rollups === undefined) return [];
  const out: { label: string; text: string; complete: boolean }[] = [];
  for (const rollup of rollups) {
    const parts: string[] = [];
    for (const [key, value] of Object.entries(rollup.value)) {
      // A rollup that has nothing to say is SKIPPED rather than rendered as a
      // row of zeros — a list of "0" against every contact is noise that hides
      // the ones that matter. `complete: false` is never skipped: see below.
      if (value === null || value === 0 || value === '0.0000') continue;
      // An average arrives as the division left it (3.3333333333333335), and a
      // chip shows two places. The figure the server sent is not changed.
      const shown = typeof value === 'number' && !Number.isInteger(value)
        ? String(Math.round(value * 100) / 100)
        : String(value);
      parts.push(`${key.replace(/_/g, ' ')} ${shown}`);
    }
    if (parts.length === 0 && rollup.complete) continue;
    out.push({
      label: rollup.label ?? rollup.pack_slug,
      // ⛔ The "at least" is the server's `complete: false` reaching the screen.
      // Dropping it would turn a bounded walk into a confident total.
      text: rollup.complete ? parts.join(' · ') : `at least ${parts.join(' · ')}`,
      complete: rollup.complete,
    });
  }
  return out;
};

const renderContactSurface = (
  contacts: readonly ContactRecord[],
  contactRollups: Record<string, TimelineRollup[]> | undefined,
  total: number,
  loadingMore: boolean,
  search: string,
  dialog: ContactDialogState | null,
  discardGuardOpen: boolean,
  contactDetail: ContactDetailState | null,
  loadingContactDetail: boolean,
  openingContactEditEmail: string | null,
  contactScan: ContactScanState | null,
  canScan: boolean,
  canReviewMerges: boolean,
  contactSources: readonly ContactSourceHealth[],
  contactImport: ContactImportState | null,
  canImport: boolean,
  canUploadFile: boolean,
  now: number,
  loadedCount?: number,
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
    return `${renderContactDetailView(
      contactDetail,
      loadingContactDetail,
      openingContactEditEmail === contactDetail.email,
      now,
    )}${renderContactDialog(dialog, discardGuardOpen)}`;
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
        placeholder="Name, email, phone, company or alias"
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
                  ${contactRollupChips(contactRollups?.[contact.email]).map((chip) => `
                    <span class="data-contact-rollup${chip.complete ? '' : ' data-contact-rollup--partial'}"
                      ${DATA_ROUTE_CONTACT_ROLLUP_ATTR}="${e(chip.label)}">
                      <span class="data-contact-rollup-label">${e(chip.label)}</span>
                      <span class="data-contact-rollup-value">${e(chip.text)}</span>
                    </span>`).join('')}
                </span>
              </button>
            </li>
          `).join('')}
        </ul>`}
    ${renderLoadMoreFooter({
      marker: DATA_ROUTE_CONTACT_LOAD_MORE_ATTR,
      action: 'load-more-contacts',
      loaded: loadedCount ?? contacts.length,
      total,
      loadingMore,
    })}
    ${renderContactDialog(dialog, discardGuardOpen)}
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
        <h3 tabindex="-1">Run this response now</h3>
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
                aria-label="${e(`Look at it and run ${name} (${match.entry.recipe_id})`)}"
                ${DATA_ROUTE_ACTION_ATTR}="review-form-response-automation"
                ${DATA_ROUTE_FORM_RESPONSE_RUN_RECIPE_ATTR}="${e(match.entry.recipe_id)}">Review and run</button>
            </li>`;
          }).join('')}
        </ul>`}
  </section>`;
};

interface FormResponseEditorDraft {
  submissionId: string;
  valuesText: string;
  email: string;
  lifecycle: string;
}

type FormResponseEditorControl = 'values' | 'email' | 'state' | 'save';

interface FormResponseEditorFocus {
  submissionId: string;
  control: FormResponseEditorControl;
  selectionStart: number | null;
  selectionEnd: number | null;
  selectionDirection: 'forward' | 'backward' | 'none' | null;
}

const formResponseEditorControlFrom = (
  element: HTMLElement | null | undefined,
): FormResponseEditorControl | null => {
  if (element?.hasAttribute?.(DATA_ROUTE_FORM_RESPONSE_VALUES_ATTR) === true) {
    return 'values';
  }
  if (element?.hasAttribute?.(DATA_ROUTE_FORM_RESPONSE_EMAIL_ATTR) === true) {
    return 'email';
  }
  if (element?.hasAttribute?.(DATA_ROUTE_FORM_RESPONSE_STATE_ATTR) === true) {
    return 'state';
  }
  return element?.getAttribute?.(DATA_ROUTE_ACTION_ATTR) === 'save-form-response'
    ? 'save'
    : null;
};

const formResponseEditorDraftFrom = (
  response: FormResponse,
): FormResponseEditorDraft => ({
  submissionId: response.submission_id,
  valuesText: JSON.stringify(response.values, null, 2),
  email: response.visitor.email ?? '',
  lifecycle: response.lifecycle_state,
});

const formResponseEditorFingerprint = (
  draft: FormResponseEditorDraft,
): string => JSON.stringify([
  draft.submissionId,
  draft.valuesText,
  draft.email,
  draft.lifecycle,
]);

const renderFormResponseDetail = (
  response: FormResponse,
  automationState: FormResponseAutomationPickerState,
  canRunAutomation: boolean,
  canEdit: boolean,
  editorDraft: FormResponseEditorDraft | null,
  saving: boolean,
  saveError: string | null,
  discardGuardOpen: boolean,
): string => {
  const fields = formResponseFields(response);
  const draft = editorDraft?.submissionId === response.submission_id
    ? editorDraft
    : formResponseEditorDraftFrom(response);
  const editorDisabled = saving ? ' disabled' : '';
  const discoveringAutomation = automationState.status === 'loading';
  const detailStateAttr = discardGuardOpen
    ? ' inert aria-hidden="true"'
    : '';
  const discardGuard = discardGuardOpen
    ? `
      <section
        ${DATA_ROUTE_FORM_RESPONSE_DISCARD_GUARD_ATTR}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="data-form-response-discard-title"
        aria-describedby="data-form-response-discard-description"
        tabindex="-1"
      >
        <h3 id="data-form-response-discard-title">Discard your form-response changes?</h3>
        <p id="data-form-response-discard-description">Your unfinished changes will be lost.</p>
        <div class="data-form-response-discard-actions">
          <button type="button" class="data-button"
            ${DATA_ROUTE_ACTION_ATTR}="${DATA_ROUTE_FORM_RESPONSE_DISCARD_KEEP_ACTION}"
            ${DATA_ROUTE_FORM_RESPONSE_DISCARD_KEEP_ATTR}>Keep editing</button>
          <button type="button" class="data-button"
            ${DATA_ROUTE_ACTION_ATTR}="${DATA_ROUTE_FORM_RESPONSE_DISCARD_COMMIT_ACTION}"
            ${DATA_ROUTE_FORM_RESPONSE_DISCARD_COMMIT_ATTR}>Discard changes</button>
        </div>
      </section>`
    : '';
  return `
    <section ${DATA_ROUTE_FORM_RESPONSE_DETAIL_ATTR}="${e(response.submission_id)}">
      ${discardGuard}
      <div class="data-form-response-detail-content"${detailStateAttr}>
      <button type="button" class="data-button"
        ${DATA_ROUTE_ACTION_ATTR}="close-form-response"${saving
          ? ' aria-disabled="true"'
          : ''}>← Back to form responses</button>
      <div class="data-response-header">
        <h2
          ${DATA_ROUTE_FORM_RESPONSE_DETAIL_HEADING_ATTR}
          tabindex="-1"
        >${e(formResponseVisitorLabel(response))}</h2>
        <span class="data-pill">${e(response.lifecycle_state.replace('_', ' '))}</span>
      </div>
      <dl class="data-response-meta">
        <div><dt>Form</dt><dd>${e(formResponseSourceLabel(response))}</dd></div>
        <div><dt>Form definition</dt><dd>${e(response.form_definition_id)}</dd></div>
        <div><dt>Endpoint</dt><dd>${e(response.endpoint_id)}</dd></div>
        <div><dt>Submitted</dt><dd>${renderFormResponseTime(response.submitted_at)}</dd></div>
        <div><dt>Accepted</dt><dd>${renderFormResponseTime(response.accepted_at)}</dd></div>
        <div><dt>Working record updated</dt><dd>${renderFormResponseTime(response.updated_at)}</dd></div>
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
            ${saving ? 'aria-disabled="true"' : ''}
            href="${e(serializeShellRoute(
              'kitchen',
              'new',
              'form-response',
              response.form_definition_id,
            ))}">Automate this form</a>
          ${canRunAutomation
            ? `<button type="button" class="data-button"
                ${DATA_ROUTE_ACTION_ATTR}="discover-form-response-automations"
                ${DATA_ROUTE_FORM_RESPONSE_RUN_ATTR}${discoveringAutomation
                  ? ' aria-disabled="true" aria-busy="true"'
                  : ''}>${discoveringAutomation
                  ? 'Looking for things that can run…'
                  : 'Run this response'}</button>`
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
      ${canEdit ? `
        <section class="data-response-editor">
          <h3 class="data-section-title">Edit working record</h3>
          <p class="data-row-subtle">This changes the owner-facing destination. The sealed Reception submission remains the original evidence.</p>
          <label>Email
            <input type="email" class="data-input" ${DATA_ROUTE_FORM_RESPONSE_EMAIL_ATTR}
              value="${e(draft.email)}"${editorDisabled} />
          </label>
          <label>Lifecycle
            <select class="data-input" ${DATA_ROUTE_FORM_RESPONSE_STATE_ATTR}${editorDisabled}>
              ${FORM_RESPONSE_LIFECYCLE_STATES.map((state) =>
                `<option value="${state}"${state === draft.lifecycle ? ' selected' : ''}>${e(state.replace('_', ' '))}</option>`
              ).join('')}
            </select>
          </label>
          <label>Answers (JSON)
            <textarea class="data-input" rows="12" ${DATA_ROUTE_FORM_RESPONSE_VALUES_ATTR}${editorDisabled}>${e(draft.valuesText)}</textarea>
          </label>
          <button type="button" class="data-button data-button--primary"
            ${DATA_ROUTE_ACTION_ATTR}="save-form-response"${saving
              ? ' aria-disabled="true" aria-busy="true"'
              : ''}>${saving ? 'Saving…' : 'Save changes'}</button>
          ${saveError === null ? '' : `<p role="alert">${e(saveError)}</p>`}
        </section>
      ` : ''}
      </div>
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
  canEdit: boolean,
  editorDraft: FormResponseEditorDraft | null,
  saving: boolean,
  saveError: string | null,
  discardGuardOpen: boolean,
  canExport: boolean,
  exportingFormat: 'json' | 'csv' | null,
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
            ? 'Recued could not find this answer.'
            : 'Recued could not open this answer. Go back to the list and try again.'}</p>
        </section>`
      : renderFormResponseDetail(
          detail,
          automationState,
          canRunAutomation,
          canEdit,
          editorDraft,
          saving,
          saveError,
          discardGuardOpen,
        );
  }

  return `
    <section>
      <div class="data-contact-toolbar">
        <h2 class="data-section-title">Form responses</h2>
        ${canExport ? `
          <button type="button" class="data-button" data-format="json"
            ${DATA_ROUTE_ACTION_ATTR}="export-form-responses"${exportingFormat === null
              ? ''
              : ' aria-disabled="true"'}${exportingFormat === 'json'
              ? ' aria-busy="true"'
              : ''}>${exportingFormat === 'json' ? 'Exporting JSON…' : 'Export JSON'}</button>
          <button type="button" class="data-button" data-format="csv"
            ${DATA_ROUTE_ACTION_ATTR}="export-form-responses"${exportingFormat === null
              ? ''
              : ' aria-disabled="true"'}${exportingFormat === 'csv'
              ? ' aria-busy="true"'
              : ''}>${exportingFormat === 'csv' ? 'Exporting CSV…' : 'Export CSV'}</button>
        ` : ''}
      </div>
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
                  <span class="data-pill">${e(response.lifecycle_state.replace('_', ' '))}</span>
                </button>
              </li>
            `).join('')}
          </ul>`}
      ${nextCursor === null ? '' : `
        <div class="data-list-footer" ${DATA_ROUTE_FORM_RESPONSE_LOAD_MORE_ATTR}>
          <span class="data-list-count">${responses.length} loaded</span>
          <button type="button" class="data-button"
            ${DATA_ROUTE_ACTION_ATTR}="load-more-form-responses"${loadingMore
              ? ' aria-disabled="true" aria-busy="true"'
              : ''}>
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
/** Exported for test. A private closure here would leave the RESPONSE→PROPS
 *  seam unprovable, and that seam is exactly where D-226's `rollups` was
 *  silently dropped: the derivation names the fields it forwards, so an
 *  omitted one reaches the panel as `undefined` and the section never renders
 *  while every unit below it stays green. */
export const deriveEntityDetailProps = (
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
    // D-226 — ⚠ ANOTHER ENUMERATING PROJECTION. This derivation names the
    // response fields it forwards, so a field it omits reaches the panel as
    // `undefined` and the section silently never renders. Same shape as the
    // rpc wire projection one layer in.
    ...(response.rollups === undefined ? {} : { rollups: response.rollups }),
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
 *  This is the `connection.api` metadata mirror (bytes resolve lazily for an
 *  explicit read and are never eagerly copied) — deliberately distinct from
 *  BOTH the D-172 upload widget rendered above it (file BYTES into the CAS) and
 *  the accounts-lane mutable S3 adapter; the label says "metadata only" so the
 *  two are not conflated. */
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
        ${loadingTimeline
          ? 'aria-disabled="true" aria-busy="true"'
          : ''}>${loadingTimeline ? 'Loading…' : 'Open timeline'}</button>
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
  openingEntityId: string | null,
  bookingLifecycleFilter: BookingLifecycleState | 'all',
  taskViewFilters: TaskViewFilters,
  commitmentViewFilters: CommitmentViewFilters,
  commitmentContactLabels: Readonly<Record<string, string>>,
  bookingDetailId: string | null,
  bookingDetail: WorkEntityGetRpcResponse | null,
  bookingDetailError: string | null,
  loadingBookingDetail: boolean,
  canMintManageLink: boolean,
  manageLinkBusy: boolean,
  manageLinkNotice: { kind: 'ok' | 'error'; text: string } | null,
  discardGuardOpen: boolean,
  /** D-267 — the open edit dialog's provenance feed, ALREADY RENDERED and
   *  already matched to this dialog by the caller. Empty string means nothing
   *  to show (no feed yet, a stale one, or a genuinely empty history) and the
   *  section is then omitted rather than asserting an empty past. */
  historyHtml: string,
  taskCompletion?: { done: boolean; can_change: boolean; busy?: boolean; notice?: string },
  commitmentLifecycle?: { state: string; can_change: boolean; can_fulfill?: boolean; can_cancel?: boolean },
  loadedCount?: number,
  taskDetailsOpen = false,
  noteDetailsOpen = false,
  noteView?: WorkEntityNoteView,
  commitmentView?: WorkEntityCommitmentView,
  closeLabel?: string,
  projectView?: ProjectOverviewProps,
  taskBulk?: { html: string; selection: ReturnType<TaskBulkActions['selection']> },
): string => {
  const options = [...sourceOptionsForKind(sources, state.kind)];
  if (state.selected_source_id !== null && !options.some((option) => option.id === state.selected_source_id)) {
    options.push({ id: state.selected_source_id, label: 'This source is not available', source_kind: 'sentinel', write_capable: false });
  }
  const activeSourceId = state.dialog?.source_id ?? state.selected_source_id;
  const activeSource = activeSourceId === null
    ? undefined
    : enabledSourcesForKind(sources, state.kind).find(
        (source) => source.id === activeSourceId,
      );
  const definition = formDefinitionForKind(state.kind, activeSource, state.dialog?.mode);
  const workEntityHistoryHtml = historyHtml;
  if (state.kind === 'project' && projectView) {
    return renderProjectOverview(projectView) + (projectView.editing && state.dialog
      ? renderWorkEntityDialog({ kind: 'project', definition, state: state.dialog, sources: options, ref_picker: true,
          discard_guard: discardGuardOpen, close_label: 'Back to project', history_html: historyHtml }) : '');
  }
  if (state.kind === 'booking' && bookingDetailId !== null) {
    const dialogHtml = state.dialog === null
      ? ''
      : renderWorkEntityDialog({
          kind: state.kind,
          definition,
          state: state.dialog,
          sources: options,
          ref_picker: true,
          discard_guard: discardGuardOpen,
          ...(workEntityHistoryHtml !== '' ? { history_html: workEntityHistoryHtml } : {}),
        });
    if (loadingBookingDetail) {
      return `<section class="work-entity-booking-detail" aria-busy="true">
        <button type="button" class="work-entity-booking-back" data-action="close-booking-detail">Back to bookings</button>
        <p>Loading booking…</p>
      </section>${dialogHtml}`;
    }
    if (bookingDetailError !== null) {
      return `<section class="work-entity-booking-detail">
        <button type="button" class="work-entity-booking-back" data-action="close-booking-detail">Back to bookings</button>
        <p role="alert">${e(bookingDetailError)}</p>
      </section>${dialogHtml}`;
    }
    const entity = bookingDetail?.entity;
    if (entity !== null && entity !== undefined && entity._kind === 'booking') {
      return `${renderBookingDetail({
        booking: entity,
        ...(bookingDetail?.booking_history !== undefined
          ? { history: bookingDetail.booking_history }
          : {}),
        can_mint_manage_link: canMintManageLink,
        manage_link_busy: manageLinkBusy,
        ...(manageLinkNotice !== null ? { manage_link_notice: manageLinkNotice } : {}),
      })}${dialogHtml}`;
    }
    return `<section class="work-entity-booking-detail">
      <button type="button" class="work-entity-booking-back" data-action="close-booking-detail">Back to bookings</button>
      <p role="alert">This booking no longer exists.</p>
    </section>${dialogHtml}`;
  }
  // Task search and ordering are already applied to the complete SQL result.
  // Booking search is also applied before pagination. Do not apply
  // the generic client title/body predicate a second time: the server also
  // searches booking id and opaque customer id, and a second narrower filter
  // would hide valid matches it just returned.
  const visible = state.kind === 'task' || state.kind === 'commitment' ? entities : filterAndSortEntities(
    state.kind,
    entities,
    state.kind === 'booking' ? '' : state.search_query,
  );
  const rows = joinRowsWithSources(visible, options);
  const canCreate =
    resolveCreateDialogSourceId(
      state.kind,
      state.selected_source_id,
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
    loaded: loadedCount ?? entities.length,
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
    ...(state.kind === 'task' ? { task_filters: taskViewFilters } : {}),
    ...(state.kind === 'commitment' ? { commitment_filters: commitmentViewFilters, counterparty_labels: commitmentContactLabels } : {}),
    ...(taskBulk ? { task_selection: taskBulk.selection, list_toolbar_html: taskBulk.html } : {}),
    ...(state.kind === 'booking'
      ? { booking_lifecycle_filter: bookingLifecycleFilter }
      : {}),
    ...(openingEntityId !== null
      ? { opening_entity_id: openingEntityId }
      : {}),
    discard_guard: discardGuardOpen,
    task_details_open: taskDetailsOpen,
    note_details_open: noteDetailsOpen,
    ...(noteView ? { note_view: noteView } : {}),
    ...(commitmentView ? { commitment_view: commitmentView } : {}),
    ...(closeLabel ? { close_label: closeLabel } : {}),
    ...(taskCompletion !== undefined ? { task_completion: taskCompletion } : {}),
    ...(commitmentLifecycle !== undefined ? { commitment_lifecycle: commitmentLifecycle } : {}),
    ...(workEntityHistoryHtml !== '' ? { history_html: workEntityHistoryHtml } : {}),
    ...(footerHtml !== '' ? { footer_html: footerHtml } : {}),
  });
};

const stableWorkEntityDialogValue = (value: unknown): unknown => {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'string') {
    const normalized = value.trim();
    return normalized.length === 0 ? undefined : value;
  }
  if (Array.isArray(value)) {
    const normalized = value
      .map(stableWorkEntityDialogValue)
      .filter((entry) => entry !== undefined);
    return normalized.length === 0 ? undefined : normalized;
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const normalized = Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, stableWorkEntityDialogValue(record[key])])
        .filter((entry) => entry[1] !== undefined),
    );
    return Object.keys(normalized).length === 0 ? undefined : normalized;
  }
  return value;
};

/** Owner edits send only changed fields. Reference order is immaterial, and a
 *  source-extension patch need only confirm the keys that were submitted. */
const workEntityEditFieldMatches = (key: string, expected: unknown, actual: unknown): boolean => {
  const fingerprint = (value: unknown): string | undefined => JSON.stringify(
    stableWorkEntityDialogValue(Array.isArray(value) && key.endsWith('_ids') ? [...value].sort() : value),
  );
  if (key === 'source_extension_blob' && expected !== null && typeof expected === 'object'
    && actual !== null && typeof actual === 'object') {
    return Object.entries(expected).every(([name, value]) =>
      fingerprint(value) === fingerprint((actual as Record<string, unknown>)[name]));
  }
  return fingerprint(expected) === fingerprint(actual);
};

const workEntityDialogFingerprint = (
  dialog: NonNullable<WorkEntityPageState['dialog']>,
  definition: FormDefinition,
): string => JSON.stringify(stableWorkEntityDialogValue({
  mode: dialog.mode,
  entity_id: dialog.mode === 'edit' ? dialog.entity_id : null,
  source_id: dialog.source_id,
  // Automatic timestamps are rounded by their hidden native inputs. They are
  // never editable and must not turn a repaint into an unfinished draft.
  values: Object.fromEntries(definition.fields.filter(field => !field.hidden)
    .map(field => [field.name, dialog.values[field.name]])),
}));

const memoryComposeFingerprint = (compose: MemoryComposeState): string =>
  JSON.stringify([
    compose.mode,
    compose.editId ?? null,
    compose.kind,
    compose.summary,
    compose.body,
  ]);

const targetWithAttr = (ev: Event, attr: string): HTMLElement | null => {
  const rawTarget = ev.target as (Element & {
    closest?: (selector: string) => Element | null;
  }) | null;
  return (
    rawTarget?.closest?.(`[${attr}]`) as HTMLElement | null | undefined
  ) ?? null;
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
      MAIL_MESSAGE_STYLES,
      WORK_ENTITY_PAGE_STYLES,
      TASK_BULK_STYLES,
      PROJECT_OVERVIEW_STYLES,
      // The mirror drill-down renders the ui-shared entity-detail panel;
      // bundle its CSS so the `.memory-*` classes paint (mirrors the
      // WORK_ENTITY_PAGE_STYLES pattern — consumer owns injection).
      ENTITY_DETAIL_PANEL_STYLES,
      REFERENCE_PROVENANCE_STYLES,
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
      CALENDAR_AGENDA_STYLES,
      CALENDAR_CREATE_STYLES,
      REMINDER_CREATE_STYLES,
      // 2026-08-28 — universal search across every collection.
      UNIVERSAL_SEARCH_STYLES,
      // D-221 — full-ref, schema-driven pack Records owner explorer.
      RECORDS_EXPLORER_STYLES,
      // D-315 §6 — Data → Received → Mail facts.
      MAIL_FACTS_STYLES,
      // D-324 — Data → Owned → Reminders.
      REMINDERS_STYLES,
      CALENDAR_EVENT_STYLES,
    ].join('\n');
    doc.head.appendChild(style);
  }

  const routeRoot = doc.createElement('div');
  routeRoot.setAttribute(DATA_ROUTE_HOST_ATTR, '');
  const collectionPickerBreakpoint = doc.defaultView?.matchMedia?.('(max-width: 640px)');
  // A focus fallback must address the navigation that is actually visible:
  // collection tabs on a wide screen, the same collections in a picker on a
  // phone. This also preserves the existing editor/discard-guard ownership.
  const collectionNavigationTarget = (tab: DataTabId): HTMLElement | null =>
    routeRoot.querySelector?.<HTMLElement>(collectionPickerBreakpoint?.matches
      ? `[${DATA_ROUTE_COLLECTION_PICKER_ATTR}]` : `[${DATA_ROUTE_TAB_ATTR}="${tab}"]`) ?? null;
  opts.root.appendChild(routeRoot);

  let disposed = false;
  let filePreviewAbort: AbortController | null = null;
  let fileDownloadAbort: AbortController | null = null;
  let filePreviewRecord: { id: string; slug: string | null } | null = null;
  let fileChatAbort: AbortController | null = null;
  let fileChatRecord: { id: string; slug: string | null } | null = null;
  // R18 — hydrate the initial tab from the `#data/<tab>` deep link (validated;
  // unknown → Contacts). A work-entity tab seeds the work-entity page state to
  // that kind so the deep link lands on the right list.
  // D-198 Slice 1b — the Data | Memory lens. `#data/memory` arrives as
  // initialTab='memory' (NOT a DataTabId, so it must be recognized here, BEFORE
  // the isDataTab gate below); the Data lens keeps the tab machinery unchanged.
  let activeLens: 'data' | 'memory' = opts.initialTab === 'memory' ? 'memory' : 'data';
  // Memory lens feed state — orthogonal to the Data tabs.
  let memoryEntries: MemoryListEntry[] = [];
  let memoryOriginFilter: MemoryOriginFilter = opts.savedView?.definition.tab === 'memory'
    ? opts.savedView.definition.origin : 'all';
  let memoryFilteringOrigin: MemoryOriginFilter | null = null;
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
  let memoryComposeBaseline: string | null = null;
  let memoryComposeDiscardGuardOpen = false;
  let memoryComposeReturnFocus:
    | { kind: 'add' }
    | { kind: 'edit'; memoryId: string }
    | null = null;
  let memoryDetail: MemoryDetailState | null = null;
  let memoryDetailReturnId: string | null = null;
  let memoryDetailOpenSeq = 0;
  let memoryEditOpeningId: string | null = null;
  let memoryEditOpenSeq = 0;
  let memoryEditError: { memoryId: string; message: string } | null = null;
  let memoryPendingDeleteId: string | undefined;
  let memoryDeletingId: string | null = null;
  let memoryDeleteError: { memoryId: string; message: string } | null = null;
  // D-198 §10 — the agent-forgotten row whose Restore is in flight, and its failure.
  let memoryRestoringId: string | null = null;
  let memoryRestoreError: { memoryId: string; message: string } | null = null;
  // D-198 Slice 3 — the import panel (paste JSON → memory.import).
  let memoryImport: MemoryImportState = { open: false, text: '', submitting: false };
  let memoryImportBaseline: string | null = null;
  let memoryImportDiscardGuardOpen = false;
  // D-198 Slice 3 — a memory-native export walk is in flight.
  let memoryExporting = false;
  /** ⛔ The feed's `next_cursor`. `memory.list` has always returned one and this
   *  route dropped it, so the Memory lens showed the newest `DEFAULT_LIMIT`
   *  entries and gave the owner no way to reach the rest — while its own header
   *  calls the feed "whole-feed". `data.memory` is UNBOUNDED under D-230, so a
   *  single page is never the whole feed. */
  let memoryCursor: string | null = null;
  let memoryLoadingMore = false;
  // Writes are wired only when the whole CRUD caller set is present.
  const memoryCanWrite =
    opts.memoryCreateCaller !== undefined
    && opts.memoryUpdateCaller !== undefined
    && opts.memoryDeleteCaller !== undefined
    && opts.memoryGetCaller !== undefined;
  // ⚠ D-267 made bare `#data` resolve to Today on the reasoning that it was the
  // one tab composing across kinds. That reasoning is SPENT, not merely
  // outvoted: Today is no longer a tab here, so there is nothing for it to
  // choose. Left as history because the next person to wonder why the landing
  // moved twice will find the answer here rather than re-deriving it.
  // D-290 — `contact` is the landing now Today has its own route (owner's
  // call, 2026-09-22). It is the other zero-config surface: no model, no
  // mailbox and no connection needed to show something real.
  let activeTab: DataTabId =
    opts.initialTab !== undefined && isDataTab(opts.initialTab)
      ? opts.initialTab
      : 'contact';
  // D-315 §6 — Data → Received → Mail facts keeps its own state; the route
  // renders it in the tab panel, loads it, and forwards its actions.
  const mailFacts = createMailFactsSurface({
    callers: opts.mailFactCallers ?? {},
    actionAttr: DATA_ROUTE_ACTION_ATTR,
    render: () => render(),
    onAddressChange: () => syncDataHash(),
    // A bill or delivery opened by its address, as Today links to it, is opened as a
    // booking's page is: the server learns trips from it (D-325 §8).
    onThingOpened: id => opts.onOwnerRecordOpened?.({ collection: 'mail_fact', id }),
  });
  // D-324 — Data → Owned → Reminders keeps its own state, as Mail facts does.
  const remindersSurface = createRemindersSurface({
    callers: opts.reminderCallers ?? {},
    ...(opts.serverTimeZone ? { timeZone: opts.serverTimeZone } : {}),
    ...(opts.now ? { now: opts.now } : {}),
    actionAttr: DATA_ROUTE_ACTION_ATTR,
    render: () => render(),
  });
  const calendarCreateSurface = createCalendarCreateSurface({
    callers: opts.calendarCreateCallers ?? {}, actionAttr: DATA_ROUTE_ACTION_ATTR,
    ...(opts.now ? { now: opts.now } : {}),
    context: () => ({ day: calendarAgenda.snapshot().window.day, zone: calendarAgenda.snapshot().zone,
      preferredSlug: calendarAgenda.selectedSource() }),
    render: () => render(),
    onCreated: ({ slug, snapshot }) => {
      const day = snapshot.event.is_all_day ? new Date(snapshot.event.start_at).toISOString().slice(0, 10)
        : calendarDateIn(snapshot.event.start_at, calendarAgenda.snapshot().zone);
      calendarAgenda.showDay(day, slug);
      explorerCollection = 'calendar'; explorerSelectedSlug = slug; explorerRecords = [snapshot.record];
      calendarAgendaReturn = { key: 'date', scrollTop: 0, hash: dataHistory.current().hash, sourcesOpen: false };
      void openExplorerRecord(snapshot.record.record_id);
    },
  });
  const calendarAgenda = createCalendarAgenda({
    ...(opts.collectionListInstancesCaller ? { listInstances: opts.collectionListInstancesCaller } : {}),
    ...(opts.collectionListCaller ? { list: opts.collectionListCaller } : {}),
    ...(opts.now ? { now: opts.now } : {}),
    initialSource: opts.savedView?.definition.tab === 'calendar' ? opts.savedView.definition.collection_slug
      : opts.initialTab === 'calendar' ? opts.initialCollectionSlug ?? null : null,
    actionAttr: DATA_ROUTE_ACTION_ATTR,
    render: () => { if (activeLens === 'data' && activeTab === 'calendar' && explorerDetail === null) render(); },
    onSources: (sources) => { explorerInstances = sources; },
    onViewChange: () => { syncDataHash(); opts.onViewChange?.(currentView()); },
    newEventButton: () => calendarCreateSurface.available() && !calendarCreateSurface.isOpen()
      ? `<button type="button" class="data-button data-button--primary" ${DATA_ROUTE_ACTION_ATTR}="calendar-create-new" data-calendar-create-focus="new">New event</button>` : '',
    createForm: () => calendarCreateSurface.render(),
  });
  let calendarInitialAddress = activeTab === 'calendar' && typeof opts.initialEntityId === 'string';
  let calendarAgendaReturn: { key: string; scrollTop: number; hash: string; sourcesOpen: boolean } | null = null;
  let pendingCalendarAgendaRestore: { key: string; scrollTop: number; sourcesOpen?: boolean } | null = null;
  const calendarEventSurface = createCalendarEventSurface({
    callers: opts.calendarEventCallers ?? {}, actionAttr: DATA_ROUTE_ACTION_ATTR,
    render: () => render(),
    onRemoved: (recordId) => {
      explorerRecords = explorerRecords.filter(record => record.record_id !== recordId);
      if (explorerSelectedSlug) calendarAgenda.remove(explorerSelectedSlug, recordId);
      explorerLiveRefreshPending = true;
    },
    onSaved: (snapshot) => {
      const event = snapshot.event;
      if (explorerSelectedSlug) calendarAgenda.replace(explorerSelectedSlug, snapshot.record);
      explorerRecords = explorerRecords.map(record => record.record_id === event.record_id ? snapshot.record : record);
      if (explorerDetail?.record?.record_id === event.record_id) explorerDetail = { ...explorerDetail, record: snapshot.record };
      explorerLiveRefreshPending = true;
    },
  });
  const mailMessageSurface = createMailMessageSurface({
    document: doc, callers: opts.mailMessageCallers ?? {},
    ...(opts.mailCompose ? { compose: opts.mailCompose } : {}),
    onSelectedRecord: (slug, record) => {
      if (activeTab === 'mail' && explorerSelectedSlug === slug && explorerDetail) {
        explorerDetail = { ...explorerDetail, record_id: record.record_id, record };
      }
    },
    actionAttr: DATA_ROUTE_ACTION_ATTR, render: () => render(),
  });
  if (activeTab === 'mail_fact' && opts.initialEntityId !== undefined) {
    mailFacts.openAddress([opts.initialEntityId, ...(opts.initialDetailId !== undefined ? [opts.initialDetailId] : [])]);
  }
  /** D-315 §6 — the mail detail's two actions need to know whether the email
   *  gave facts and whether it is a security notice (on which neither is
   *  offered, §9). Read once per email shown, whichever way it was opened. */
  let mailFactEmailStatus: { key: string; status: MailFactEmailStatus | null; stale?: true } | null = null;
  const mailFactStatusFor = (slug: string, record_id: string): MailFactEmailStatus | null => {
    const key = `${slug}\u0000${record_id}`;
    if (mailFactEmailStatus?.key === key && mailFactEmailStatus.stale !== true) return mailFactEmailStatus.status;
    // Read again after a mail_fact broadcast: what is shown stays until the
    // new answer lands, so the actions do not blink out meanwhile.
    const shown = mailFactEmailStatus?.key === key ? mailFactEmailStatus.status : null;
    mailFactEmailStatus = { key, status: shown };
    const caller = opts.mailFactCallers?.emailStatus;
    if (caller !== undefined) {
      void caller({ slug, record_id }).then((status) => {
        if (disposed || mailFactEmailStatus?.key !== key) return;
        mailFactEmailStatus = { key, status };
        render();
      }, () => { /* no action is offered */ });
    }
    return shown;
  };
  // Identifies the tab represented by the current DOM. State changes before a
  // repaint, so comparing this with `activeTab` prevents a focused source chip
  // from one collection from claiming a same-named chip on another tab.
  let renderedActiveTab = activeTab;
  // Arrow-key activation repaints the whole route synchronously. Carry the
  // destination through that first paint so the old focused tab cannot reclaim
  // focus before the new collection's async load settles.
  let pendingCollectionTabFocus: DataTabId | null = null;
  /** D-267 — ARRIVING at Search claims the box, so the Ctrl/Cmd+/ chord, the
   *  chat Find chip and the drawer seat all land the owner typing.
   *
   *  ⛔ Set on ARRIVAL only — never on a repaint, or every result set would yank
   *  focus back to the input from whatever row the owner had tabbed to.
   *  ⛔ And never when the TABLIST is moving its own roving focus
   *  (`selectTab(tab, true)` — arrow keys / Home / End): a keyboard user
   *  arrowing across the tabs must stay in the tablist, not be ejected into a
   *  text box at one particular tab. */
  let pendingUniversalSearchFocus = activeTab === 'search';
  /** D-267 — the open edit dialog's provenance feed, keyed so a stale arrival
   *  from a previous dialog cannot paint into the current one. ⛔ `null` while
   *  the read is in flight, and the section is omitted entirely then: an empty
   *  feed rendered early would assert "nothing has touched this" about an
   *  entity whose history has not arrived. */
  let workEntityTimeline: { kind: WorkEntityKind; id: string; entries: TimelineEntry[] } | null = null;
  // A run-verification handoff belongs to the exact item that was addressed.
  // Retire it as soon as the owner navigates away so an in-memory route cannot
  // accidentally carry "reviewed" choices onto a different tab or item after
  // the canonical URL has already dropped the return context.
  let activeLogsReturn = opts.logsReturn;
  let activeVerificationRelationship = opts.verificationRelationship;
  const runVerificationTargetTab = activeTab;
  const runVerificationTargetEntityId = opts.initialEntityId ?? null;
  let pendingInitialVerificationFocus =
    activeLogsReturn !== undefined
    && runVerificationTargetEntityId !== null;
  const retireRunVerification = (): void => {
    activeLogsReturn = undefined;
    activeVerificationRelationship = undefined;
    pendingInitialVerificationFocus = false;
  };
  const retireRunVerificationForDifferentItem = (
    tab: DataTabId,
    entityId: string,
  ): void => {
    if (
      tab !== runVerificationTargetTab
      || entityId !== runVerificationTargetEntityId
    ) {
      retireRunVerification();
    }
  };
  let workEntityState = initialWorkEntityPageState({
    kind: isWorkEntityTab(activeTab) ? activeTab : 'task',
    ...(opts.savedView !== undefined && 'source_id' in opts.savedView.definition
      ? { selected_source_id: opts.savedView.definition.source_id, search_query: opts.savedView.definition.query }
      : {}),
  });
  let sources: SourceRegistration[] = [];
  let defaultsByKind: Partial<Record<WorkEntityKind, string>> = {};
  let workEntities: WorkEntity[] = [];
  // Bumped on each work-entity edit-dialog open; a fetch that resolves after a
  // newer open (or a tab switch) drops rather than installing a stale dialog.
  let workEntityDialogOpenSeq = 0;
  let pendingWorkEntityDialogOpen: {
    kind: WorkEntityKind;
    id: string;
    intent?: 'read' | 'edit' | 'details';
  } | null = null;
  let workEntityDialogReturnFocus:
    | { mode: 'create'; kind: WorkEntityKind }
    | { mode: 'edit'; kind: WorkEntityKind; id: string }
    | null = null;
  let workEntityDialogBaseline: string | null = null;
  let workEntityDialogEntity: WorkEntity | null = null;
  let projectWork: ProjectWork | null = null;
  let projectEditing = false;
  let projectChildReturn: { kind: 'task' | 'note'; id?: string; scrollTop: number; page: WorkEntityPageState; entities: WorkEntity[]; total: number } | null = null;
  let pendingProjectRestore: { key: string; scrollTop: number } | null = null;
  let commitmentMode: 'read' | 'edit' = 'read';
  let commitmentNotice: string | undefined;
  let commitmentDiscardToReader = false;
  let commitmentContactLabels: Record<string, string> = {};
  let noteMode: 'read' | 'edit' = 'read';
  let noteDetailsOpen = false;
  let noteCopying = false;
  let noteCopySequence = 0;
  let noteNotice: WorkEntityNoteView['notice'];
  let noteDiscardToReader = false;
  let taskCompletionNotice: string | null = null;
  let taskCompletionPending: { id: string; sequence: number } | null = null;
  let workEntityDiscardGuardOpen = false;
  let workEntityDiscardReturnFocus:
    | { kind: 'close' | 'cancel' | 'field' | 'form'; field?: string }
    | null = null;
  let bookingLifecycleFilter: BookingLifecycleState | 'all' = opts.savedView !== undefined
    && 'booking_lifecycle' in opts.savedView.definition ? opts.savedView.definition.booking_lifecycle : 'all';
  let taskViewFilters: TaskViewFilters = opts.savedView?.definition.tab === 'task'
    ? opts.savedView.definition.task_filters ?? DEFAULT_TASK_VIEW_FILTERS : DEFAULT_TASK_VIEW_FILTERS;
  let commitmentViewFilters: CommitmentViewFilters = opts.savedView?.definition.tab === 'commitment'
    ? opts.savedView.definition.commitment_filters ?? DEFAULT_COMMITMENT_VIEW_FILTERS : DEFAULT_COMMITMENT_VIEW_FILTERS;
  let commitmentListFilter = { ...commitmentViewFilters };
  let commitmentListSearch = workEntityState.kind === 'commitment' ? workEntityState.search_query.trim() : '';
  let taskListFilter = resolveTaskListFilter(taskViewFilters, (opts.now ?? Date.now)());
  let taskListSearch = workEntityState.kind === 'task' ? workEntityState.search_query.trim() : '';
  const retireTaskListReads = (): void => {
    taskSearchRefresh.cancel(); loadGeneration += 1;
    loading = false; loadingMoreWorkEntities = false;
  };
  const taskBulk = createTaskBulkActions({
    rows: () => activeLens === 'data' && activeTab === 'task'
      ? workEntities.filter(row => facetIncludes({ collection: row._kind, id: row.id })) : [],
    sources: () => sources,
    ready: () => !loading && taskListSearch === workEntityState.search_query.trim(),
    get: opts.workEntityGetCaller, listSources: opts.workEntitySourceListCaller,
    complete: opts.taskMarkDoneCaller, update: opts.workEntityUpsertCaller,
    render: () => render(),
    selectionStarted: retireTaskListReads,
    begin: retireTaskListReads,
    confirmed: task => { workEntities = workEntities.map(row => row._kind === 'task' && row.id === task.id ? task : row); },
    settled: () => { if (!disposed && activeLens === 'data' && activeTab === 'task') pendingLoadPromise = refreshActive(true); },
  });
  const focusTaskBatch = (): void => { routeRoot.querySelector<HTMLElement>('[data-task-bulk-focus="results"]')?.focus(); };
  let bookingDetailId: string | null = null;
  let bookingDetail: WorkEntityGetRpcResponse | null = null;
  let bookingDetailError: string | null = null;
  let loadingBookingDetail = false;
  let loadingWorkEntityDetail = false;
  let bookingDetailSeq = 0;
  let bookingManageLinkBusy = false;
  let bookingManageLinkNotice: { kind: 'ok' | 'error'; text: string } | null = null;
  const resetBookingManageLinkState = (): void => {
    bookingManageLinkBusy = false;
    bookingManageLinkNotice = null;
  };
  // R18 load-more (work entities) — mirrors the contact pagination below.
  // `total` is the server count for the active kind + Source filters (NOT the
  // client-side search, which filters the loaded rows in `filterAndSortEntities`).
  let workEntityTotal = 0;
  let loadingMoreWorkEntities = false;
  // Set at delegated-click time, before the promise-chain callback starts, so
  // two same-tick activations cannot enqueue two successive pages.
  let workEntityLoadMoreQueued = false;
  let pendingWorkEntityLoadMoreFocusKind: WorkEntityKind | null = null;
  let pendingLoadedWorkEntityKeys: Array<{
    kind: WorkEntityKind;
    id: string;
  }> = [];
  let contacts: ContactRecord[] = [];
  // D-226 — keyed on canonical email, for the rows currently rendered.
  let contactRollups: Record<string, TimelineRollup[]> | undefined;
  let contactTotal = 0;
  // R18 load-more — set while an append page (offset > 0) is in flight, so the
  // footer shows a spinner without flashing a loading state over the list.
  let loadingMoreContacts = false;
  // Set at delegated-click time, before the promise-chain callback starts, so
  // two same-tick activations cannot enqueue two successive contact pages.
  let contactLoadMoreQueued = false;
  let pendingContactLoadMoreFocus = false;
  let pendingLoadedContactEmail: string | null = null;
  let contactSearch = opts.savedView?.definition.tab === 'contact' ? opts.savedView.definition.query : '';
  let contactDialog: ContactDialogState | null = null;
  let contactDialogReturnFocus:
    | { kind: 'create' }
    | { kind: 'edit'; email: string }
    | null = null;
  let contactDialogBaseline: string | null = null;
  let contactDiscardGuardOpen = false;
  let contactDiscardReturnFocus:
    | { kind: 'close' | 'cancel' | 'field' | 'form'; field?: keyof ContactDialogValues }
    | null = null;
  let formResponses: FormResponseListItem[] = [];
  let formResponseNextCursor: FormResponseListCursor | null = null;
  let loadingMoreFormResponses = false;
  let formResponseLoadMoreQueued = false;
  let pendingFormResponseLoadMoreFocus = false;
  let pendingLoadedFormResponseIds: string[] = [];
  let formResponseDetailId: string | null = null;
  let formResponseDetail: FormResponse | null = null;
  let formResponseDetailError: string | null = null;
  let loadingFormResponseDetail = false;
  let pendingFormResponseDetailFocusId: string | null = null;
  // The detail editor is uncontrolled at the DOM edge, but route paints replace
  // the whole subtree. Mirror every edit here so validation, automation reads,
  // and save progress cannot silently restore the older server snapshot.
  let formResponseEditorDraft: FormResponseEditorDraft | null = null;
  let formResponseEditorBaseline: string | null = null;
  let formResponseDiscardGuardOpen = false;
  let formResponseDiscardReturnId: string | null = null;
  let formResponseDiscardPendingTab: DataTabId | null = null;
  let formResponseDiscardPendingHref: string | null = null;
  let pendingFormResponseDiscardTabFocus: DataTabId | null = null;
  let pendingFormResponseEditorFocus: {
    submissionId: string;
    control: FormResponseEditorControl;
  } | null = null;
  let savingFormResponse = false;
  let formResponseSaveError: string | null = null;
  let exportingFormResponseFormat: 'json' | 'csv' | null = null;
  // Mutations without their own rendered busy state (deletes and the shared
  // run modal) still need to participate in the server-switch safety fence.
  let opaqueMutationsInFlight = 0;
  let formResponseAutomationState: FormResponseAutomationPickerState = {
    status: 'idle',
  };
  let formResponseAutomationSeq = 0;
  let pendingFormResponseAutomationPickerFocus = false;
  let formResponseRunModal: RunModal.RunModalHandle | null = null;
  // A response detail fetch may resolve after the owner opened a different
  // row or left the tab. Only the latest sequence may install its result.
  let formResponseDetailSeq = 0;
  let timelineEntityId = '';
  let timeline: TimelineSnapshot | null = null;
  // flow-20 — contact drill-down timeline (own-it Contacts tab), separate
  // from the mirror-tab `timeline` above.
  let contactDetail: ContactDetailState | null = null;
  let sphereControl: ReturnType<typeof mountSpherePlacement> | undefined;
  let dataSphere: 'all' | 'personal' | 'professional' | 'unsorted' = 'all';
  let facetKey = ''; let facetGeneration = 0; let facetsLoading = false; let facetError = '';
  // An older server has no sphere placements: the filter is left out, not reported.
  let spheresUnsupported = false;
  const facetPlacements = new Map<string, import('@recued/contracts').YoursSpherePlacement>();
  const facetId = (ref: import('@recued/contracts').SituationRef) => JSON.stringify([ref.collection, ref.id]);
  const facetIncludes = (ref: import('@recued/contracts').SituationRef) => {
    if (dataSphere === 'all') return true; const value = facetPlacements.get(facetId(ref));
    return !!value && (dataSphere === 'unsorted' ? !value.sphere : value.sphere === dataSphere);
  };
  let loadingContactDetail = false;
  let pendingContactDetailFocusEmail: string | null = null;
  let contactEditOpenSeq = 0;
  let openingContactEditEmail: string | null = null;
  let pendingContactEditFocusEmail: string | null = null;
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
  let timelineLoadGeneration = 0;
  // D-172 Half-A "open" — a file download (data.file.read → browser save) is in
  // flight; disables the button + shows a spinner label.
  let downloadingFile = false;
  let fileLifecycle: FileLifecyclePanelState | undefined;
  let fileLifecycleGeneration = 0;
  let fileLifecycleNotice = "";
  let showArchivedFiles = false;
  let errors: DataLoadErrors = {};
  let loadGeneration = 0;
  let navigationGeneration = 0;
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
      query,
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
  let cloudSources: CloudFileSource[] = [];
  let cloudSourcesError = '';
  let cloudFileQuery = ''; let cloudFileQueryInput = '';
  let cloudFileCursor: string | undefined;
  let cloudFilePage = 1;
  let cloudLoadingMore = false; let cloudBrowseError = '';
  let explorerSelectedSlug: string | null = null;
  // Keep intended source identity separately from the latest available roster.
  // A disconnected selection must survive repeated refreshes and tab returns.
  const savedExplorerScopes = new Map<DataTabId, string | null>();
  if (opts.savedView !== undefined && 'collection_slug' in opts.savedView.definition
    // A legacy webhook view never reaches here: `saved-data-route.ts` routes it
    // to Connections → Webhooks. The tab it named no longer exists.
    && opts.savedView.definition.tab !== 'webhook') {
    savedExplorerScopes.set(opts.savedView.definition.tab, opts.savedView.definition.collection_slug);
  }
  // ── UNIVERSAL SEARCH state ───────────────────────────────────────────────
  // ⚠ `groups === undefined` means "not searched yet" and `[]` means "searched,
  // nothing matched" — the renderer shows a prompt for the first and a scoped
  // empty for the second. Collapsing them would tell an owner their data is
  // absent when the search simply has not run.
  let universalSearchQuery = opts.savedView?.definition.tab === 'search' ? opts.savedView.definition.query : '';
  let universalSearchGroups: CollectionSearchGroup[] | undefined;
  let universalSearchWorkGroups: WorkEntitySearchGroup[] | undefined;
  let universalSearchContacts: ContactRecord[] = [];
  let universalSearchContactTotal = 0;
  let universalSearchContactOffset = 0;
  let universalSearchContactMore = false;
  let universalSearchContactLoading = false;
  let universalSearchContactError: string | undefined;
  let universalSearchContactUnsupported = false;
  let universalSearchContactPageSeq = 0;
  let contactSearchReturn: { sequence: number; query: string; email: string; scrollTop: number; hash: string } | null = null;
  let pendingContactSearchRestore: { email: string; scrollTop: number } | null = null;
  let universalSearchWorkLoading = false;
  let universalSearchWorkError: string | undefined;
  /** Kept across searches, so the box's scope does not flicker; a work search that answers clears it. */
  let universalSearchWorkUnsupported = false;
  const universalSearchWorkLoadingKinds = new Set<WorkEntitySearchKind>();
  const universalSearchWorkOffsets = new Map<WorkEntitySearchKind, number>();
  const universalSearchWorkPageSeq = new Map<WorkEntitySearchKind, number>();
  let universalSearchNavigation = 0;
  let workSearchReturn: { sequence: number; query: string; kind: WorkEntitySearchKind; id: string; scrollTop: number } | null = null;
  let pendingWorkSearchRestore: { kind: WorkEntitySearchKind; id: string; scrollTop: number } | null = null;
  /** The server's "did you mean" for the query on screen; cleared with its groups. */
  let universalSearchDidYouMean: CollectionSearchDidYouMean | undefined;
  /** The query's words no store holds — the groups match only the others. */
  let universalSearchAbsentWords: string[] | undefined;
  let universalSearchLoading = false;
  let universalSearchCapabilitiesLoading = false;
  let universalSearchCapabilitiesError: string | undefined;
  let universalSearchError: string | undefined;
  /** Installed recipes matching the same query — the owner's CAPABILITIES.
   *  Filtered CLIENT-SIDE from `recipe.list`, which the route already loads:
   *  a capability catalog is tens-to-hundreds of entries, so a round trip per
   *  keystroke would buy nothing. Ranked by the SHARED `rankSearchable`, so the
   *  owner and `tools.search` agree on what matches. */
  let universalSearchRecipes: UniversalSearchRecipeMatch[] = [];
  let universalSearchPacks: UniversalSearchPackMatch[] = [];
  let universalSearchMarket: UniversalSearchMarketMatch[] = [];
  let universalSearchMarketLoading = false;
  let universalSearchMarketError: string | undefined;
  /** The query the marketplace results belong to — a stale set must never sit
   *  under a different query the owner has since typed. */
  let universalSearchMarketQuery = '';
  /** Guards against an out-of-order response overwriting a newer one. */
  let universalSearchSeq = 0;
  let universalSearchMarketSeq = 0;
  const searchContinuityOwner = opts.searchContinuityOwner ?? opts.root;
  let pendingAssetSearchRestore: { id: string; scrollTop: number; reveal?: boolean } | null = null;
  let assetSearchIds = new Set<string>();
  const assetSearch = createAssetSearch(opts.assetSearchCaller, () => {
    const state = assetSearch.state();
    if (!state.loading && !state.error && doc.activeElement?.getAttribute(DATA_ROUTE_ACTION_ATTR) === SEARCH_MORE_ASSETS_ACTION) {
      const next = state.matches.find(row => !assetSearchIds.has(row.id));
      if (next) pendingAssetSearchRestore = { id: next.id, scrollTop: workSearchScrollHost()?.scrollTop ?? 0, reveal: true };
    }
    assetSearchIds = new Set(state.matches.map(row => row.id));
    if (activeLens === 'data' && activeTab === 'search') render();
  });
  const captureSearchState = () => ({
    universalSearchQuery, universalSearchGroups, universalSearchWorkGroups,
    universalSearchContacts, universalSearchContactTotal, universalSearchContactOffset,
    universalSearchContactMore, universalSearchContactError, universalSearchContactUnsupported,
    universalSearchWorkError, universalSearchWorkUnsupported,
    universalSearchDidYouMean, universalSearchAbsentWords, universalSearchCapabilitiesError,
    universalSearchError, universalSearchRecipes, universalSearchPacks,
    universalSearchMarket, universalSearchMarketError, universalSearchMarketQuery,
    assets: assetSearch.snapshot(),
    pending: { records: universalSearchLoading || universalSearchGroups === undefined && !universalSearchError,
      work: universalSearchWorkLoading || universalSearchWorkGroups === undefined && !universalSearchWorkError && !universalSearchWorkUnsupported,
      contacts: universalSearchContactLoading && universalSearchContacts.length === 0,
      capabilities: universalSearchCapabilitiesLoading },
  });
  type SearchResume = ReturnType<typeof captureSearchState>;
  let initialSearchResume: SearchResume['pending'] | undefined;
  const savedAssetSearch = readSearchAssetReturn<SearchResume>(doc, searchContinuityOwner);
  if (savedAssetSearch && activeTab === 'search' && savedAssetSearch.returnHash === doc.defaultView?.location.hash) {
    ({ universalSearchQuery, universalSearchGroups, universalSearchWorkGroups,
      universalSearchContacts, universalSearchContactTotal, universalSearchContactOffset,
      universalSearchContactMore, universalSearchContactError, universalSearchContactUnsupported,
      universalSearchWorkError, universalSearchWorkUnsupported,
      universalSearchDidYouMean, universalSearchAbsentWords, universalSearchCapabilitiesError,
      universalSearchError, universalSearchRecipes, universalSearchPacks,
      universalSearchMarket, universalSearchMarketError, universalSearchMarketQuery } = savedAssetSearch.state);
    assetSearch.restore(savedAssetSearch.state.assets);
    assetSearchIds = new Set(assetSearch.state().matches.map(row => row.id));
    initialSearchResume = savedAssetSearch.state.pending;
    pendingUniversalSearchFocus = false;
    // The saved-view wrapper adds its tools after the child mounts. Restore
    // after that synchronous layout, before any user event, so scroll anchoring
    // cannot add the tools' height to the retained position.
    queueMicrotask(() => {
      if (disposed || activeTab !== 'search') return;
      pendingAssetSearchRestore = { id: savedAssetSearch.assetId, scrollTop: savedAssetSearch.scroll.top };
      render();
    });
    for (const group of universalSearchWorkGroups ?? []) universalSearchWorkOffsets.set(group.kind, group.offset + group.matches.length);
  }

  let explorerRecords: CollectionRecord[] = [];
  let explorerDetail: CollectionExplorerDetailState | null = null;
  let explorerLiveRefreshPending = false;
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
  let rescheduleForm: { value: string; submitting: boolean; error: string | null; allDay?: boolean } | null = null;
  let pendingRescheduleOpenFocusId: string | null = null;
  // D-210 Appendix B — the "Copy reschedule link" affordance state for the OPEN
  // calendar event. `busy` while the mint rpc is in flight; `notice` is the
  // post-copy line (the URL itself is only shown as a fallback when the clipboard
  // API is unavailable). Reset on detail change so a stale notice never carries.
  let explorerLoading = false;
  let explorerError: string | undefined;
  let explorerErrorRetryable = false;
  let explorerRetrying = false;
  let pendingExplorerRetryFocus: DataTabId | null = null;
  let explorerRetryGeneration = 0;
  let explorerDetailRetryable = false;
  let explorerDetailRetrying = false;
  let pendingExplorerDetailRetryFocus: {
    tab: DataTabId;
    recordId: string;
  } | null = null;
  let explorerSeq = 0;
  let pendingExplorerRecordFocus: {
    tab: DataTabId;
    recordId: string;
  } | null = null;
  let initialExplorerSlug =
    typeof opts.initialCollectionSlug === 'string'
    && opts.initialCollectionSlug.trim().length > 0
      ? opts.initialCollectionSlug
      : null;
  const pendingExplorerVerificationTab: SourceRecordDataTab | null =
    opts.verifyInitialSourceRecord === true
    && (activeTab === 'mail' || activeTab === 'calendar' || activeTab === 'files')
      ? activeTab
      : null;
  let pendingExplorerVerificationRecordId =
    pendingExplorerVerificationTab !== null
    && typeof opts.initialEntityId === 'string'
    && opts.initialEntityId.length > 0
      ? opts.initialEntityId
      : null;

  const resetExplorerState = (): void => {
    calendarAgenda.cancel();
    calendarAgendaReturn = null; pendingCalendarAgendaRestore = null;
    calendarEventSurface.reset();
    mailMessageSurface.reset();
    cloudSources = []; cloudSourcesError = ''; cloudFileCursor = undefined;
    cloudFileQuery = cloudFileQueryInput = ''; cloudLoadingMore = false; cloudBrowseError = '';
    cloudFilePage = 1;
    explorerCollection = null;
    explorerInstances = [];
    explorerSelectedSlug = null;
    explorerRecords = [];
    explorerDetail = null;
    explorerTimeline = null;
    rescheduleForm = null;
    pendingRescheduleOpenFocusId = null;
    explorerLoading = false;
    explorerError = undefined;
    explorerErrorRetryable = false;
    explorerRetrying = false;
    pendingExplorerRetryFocus = null;
    explorerRetryGeneration += 1;
    explorerDetailRetryable = false;
    explorerDetailRetrying = false;
    pendingExplorerDetailRetryFocus = null;
    pendingExplorerRecordFocus = null;
    explorerSeq += 1; // abandon any in-flight explorer fetch
  };

  // D-221 — pack-owned Records state. This is intentionally independent of
  // `explorerRecords`: its callers are `records.*` owner RPCs, never a
  // `collection.*`/`data.*` resolver that a recipe could accidentally share.
  let recordsSeq = 0;
  let pendingRecordsTarget = opts.initialRecordsTarget;
  let savedRecordsSelection = opts.savedView?.definition.tab === 'records'
    ? { owner: opts.savedView.definition.owner, entity: opts.savedView.definition.entity }
    : opts.initialRecordsTarget ? {owner:opts.initialRecordsTarget.owner,entity:opts.initialRecordsTarget.entity} : null;
  let recordsState: RecordsExplorerState = {
    ...initialRecordsBrowseState(opts.savedView?.definition.tab === 'records' ? {
      ...(opts.savedView.definition.filters ? { filters: opts.savedView.definition.filters } : {}),
      ...(opts.savedView.definition.sort ? { sort: opts.savedView.definition.sort } : {}),
    } : {}),
    namespaces: [],
    globalQuota: null,
    selectedNamespace: null,
    kinds: [],
    selectedKind: null,
    records: [],
    detail: null,
    diagnostics: null,
    outbox: null,
    outboxOpen: false,
    outboxRefreshing: false,
    changes: null,
    changesOpen: false,
    changesRefreshing: false,
    reviewMark: null,
    canMarkReviewed: false,
    markingReviewed: false,
    retention: {},
    loading: false,
    loadingNamespaceKey: null,
    loadingKind: null,
    deletePending: false,
    deleting: false,
    exporting: false,
    exportingAction: null,
    retiringEventId: null,
    retiringEventBusy: false,
    purgePending: false,
    purgeConfirmation: '',
    purging: false,
    canDelete: opts.recordsDeleteCaller !== undefined,
    canExport: opts.recordsExportCaller !== undefined,
    canRetireEvents: opts.recordsOutboxRetireCaller !== undefined,
    canPurge: opts.recordsPurgeCaller !== undefined,
  };
  const recordsImport = createRecordsImport({
    document: doc, mount: doc.body ?? opts.root,
    namespace: () => activeLens === 'data' && activeTab === 'records' ? recordsState.selectedNamespace : null,
    listRecipes: opts.recipeListCaller,
    execute: opts.recipeExecuteCaller,
    uploadFile: opts.sheetImportUploadCaller,
    readFile: opts.fileReadCaller,
    fileRefSearch: opts.fileRefSearchCaller,
    configGet: opts.sheetImportSettings?.get,
    configSet: opts.sheetImportSettings?.set,
    followHeldRun: opts.followHeldRun,
    changed: () => render(),
    refresh: async () => {
      await loadRecords(undefined, true);
      if (disposed) return;
      render();
      if (recordsState.error !== undefined) throw new Error(recordsState.error);
    },
    returnFocus: recipeId => {
      const buttons = routeRoot.querySelectorAll?.(`[${RECORDS_IMPORT_RECIPE_ATTR}]`);
      const button = Array.from(buttons ?? []).find(button => button.getAttribute(RECORDS_IMPORT_RECIPE_ATTR) === recipeId);
      (button as HTMLElement | undefined)?.focus();
    },
  });
  const recordsOwnerKey = (owner: RecordsPackRef): string =>
    `${owner.publisher}/${owner.pack_slug}`;
  const resetRecordsState = (): void => {
    recordsSeq += 1;
    recordsState = {
      ...initialRecordsBrowseState(),
      namespaces: [],
      globalQuota: null,
      selectedNamespace: null,
      kinds: [],
      selectedKind: null,
      records: [],
      detail: null,
      diagnostics: null,
      outbox: null,
      outboxOpen: false,
      outboxRefreshing: false,
      changes: null,
      changesOpen: false,
      changesRefreshing: false,
      reviewMark: null,
      canMarkReviewed: false,
      markingReviewed: false,
      retention: {},
      loading: false,
      loadingNamespaceKey: null,
      loadingKind: null,
      deletePending: false,
      deleting: false,
      exporting: false,
      exportingAction: null,
      retiringEventId: null,
      retiringEventBusy: false,
      purgePending: false,
      purgeConfirmation: '',
      purging: false,
      canDelete: opts.recordsDeleteCaller !== undefined,
      canExport: opts.recordsExportCaller !== undefined,
      canRetireEvents: opts.recordsOutboxRetireCaller !== undefined,
      canPurge: opts.recordsPurgeCaller !== undefined,
    };
  };
  const activeRecordsAction = (): string | null => {
    const active = doc.activeElement as HTMLElement | null | undefined;
    return active?.getAttribute?.(SHARED_ACTION_ATTR) ?? null;
  };
  interface RecordsFocusIdentity {
    action: string;
    tagName: string;
    id: string | null;
    kind: string | null;
    namespace: string | null;
    eventId: string | null;
    filterIndex: string | null;
  }
  const activeRecordsFocusIdentity = (): RecordsFocusIdentity | null => {
    const active = doc.activeElement as HTMLElement | null | undefined;
    const action = active?.getAttribute?.(SHARED_ACTION_ATTR) ?? null;
    if (active === null || active === undefined || action?.startsWith('records-') !== true) {
      return null;
    }
    return {
      action,
      tagName: active.tagName,
      id: active.getAttribute(RECORDS_ID_ATTR),
      kind: active.getAttribute(RECORDS_KIND_ATTR),
      namespace: active.getAttribute(RECORDS_NAMESPACE_ATTR),
      eventId: active.getAttribute(RECORDS_EVENT_ID_ATTR),
      filterIndex: active.getAttribute('data-records-filter-index'),
    };
  };
  const focusRecordsIdentity = (identity: RecordsFocusIdentity | null): boolean => {
    if (identity === null) return false;
    const queryable = routeRoot as unknown as {
      querySelectorAll?: (selector: string) => ArrayLike<HTMLElement>;
    };
    const target = Array.from(queryable.querySelectorAll?.(
      `[${SHARED_ACTION_ATTR}="${identity.action}"]`,
    ) ?? []).find((candidate) =>
      candidate.tagName === identity.tagName
      && (identity.id === null || candidate.getAttribute(RECORDS_ID_ATTR) === identity.id)
      && (identity.kind === null || candidate.getAttribute(RECORDS_KIND_ATTR) === identity.kind)
      && (identity.namespace === null
        || candidate.getAttribute(RECORDS_NAMESPACE_ATTR) === identity.namespace)
      && (identity.eventId === null
        || candidate.getAttribute(RECORDS_EVENT_ID_ATTR) === identity.eventId)
      && (identity.filterIndex === null
        || candidate.getAttribute('data-records-filter-index') === identity.filterIndex));
    target?.focus?.({ preventScroll: true });
    target?.scrollIntoView?.({ block: 'nearest' });
    return target !== undefined;
  };
  const focusRecordsAction = (
    action: string,
    attribute?: string,
    value?: string,
  ): boolean => {
    const queryable = routeRoot as unknown as {
      querySelectorAll?: (selector: string) => ArrayLike<HTMLElement>;
    };
    const candidates = Array.from(queryable.querySelectorAll?.(
      `button[${SHARED_ACTION_ATTR}="${action}"]`,
    ) ?? []);
    const target = attribute === undefined
      ? candidates[0]
      : candidates.find((candidate) => candidate.getAttribute(attribute) === value);
    target?.focus?.({ preventScroll: true });
    target?.scrollIntoView?.({ block: 'nearest' });
    return target !== undefined;
  };
  const focusRecordsDetailHeading = (): boolean => {
    const queryable = routeRoot as unknown as {
      querySelector?: (selector: string) => HTMLElement | null;
    };
    const heading = queryable.querySelector?.('#records-detail-title') ?? null;
    heading?.focus?.({ preventScroll: true });
    heading?.scrollIntoView?.({ block: 'nearest' });
    return heading !== null;
  };
  const focusRecordsOutboxSummary = (): boolean => {
    const queryable = routeRoot as unknown as {
      querySelector?: (selector: string) => HTMLElement | null;
    };
    const summary = queryable.querySelector?.(
      `summary[${SHARED_ACTION_ATTR}="${RECORDS_TOGGLE_OUTBOX_ACTION}"]`,
    ) ?? null;
    summary?.focus?.({ preventScroll: true });
    summary?.scrollIntoView?.({ block: 'nearest' });
    return summary !== null;
  };
  const focusRecordsChangesSummary = (): boolean => {
    const queryable = routeRoot as unknown as {
      querySelector?: (selector: string) => HTMLElement | null;
    };
    const summary = queryable.querySelector?.(
      `summary[${SHARED_ACTION_ATTR}="${RECORDS_TOGGLE_CHANGES_ACTION}"]`,
    ) ?? null;
    summary?.focus?.({ preventScroll: true });
    summary?.scrollIntoView?.({ block: 'nearest' });
    return summary !== null;
  };
  const focusRecordsPurgeInput = (): boolean => {
    const queryable = routeRoot as unknown as {
      querySelector?: (selector: string) => HTMLElement | null;
    };
    const input = queryable.querySelector?.(
      `[${RECORDS_PURGE_CONFIRMATION_ATTR}]`,
    ) ?? null;
    input?.focus?.({ preventScroll: true });
    input?.scrollIntoView?.({ block: 'nearest' });
    return input !== null;
  };
  const focusRecordsTab = (): boolean => {
    const tab = collectionNavigationTarget('records');
    tab?.focus?.({ preventScroll: true });
    tab?.scrollIntoView?.({ block: 'nearest' });
    return tab !== null;
  };

  const recordsInFlightOwnerAction = (): string | null => {
    if (recordsState.deleting) return RECORDS_CONFIRM_DELETE_ACTION;
    if (recordsState.retiringEventBusy) {
      return RECORDS_CONFIRM_RETIRE_EVENT_ACTION;
    }
    if (recordsState.purging) return RECORDS_CONFIRM_PURGE_ACTION;
    if (recordsState.exporting && recordsState.exportingAction !== null) {
      return recordsState.exportingAction;
    }
    if (recordsState.outboxRefreshing) return RECORDS_REFRESH_OUTBOX_ACTION;
    if (recordsState.markingReviewed) return RECORDS_MARK_REVIEWED_ACTION;
    if (recordsState.changesRefreshing) return RECORDS_REFRESH_CHANGES_ACTION;
    return null;
  };
  const hasRecordsInFlightWork = (): boolean =>
    recordsImport.hasInFlightWork() || recordsInFlightOwnerAction() !== null;
  const focusRecordsInFlightOwner = (): void => {
    if (recordsImport.hasInFlightWork()) { recordsImport.focus(); return; }
    const action = recordsInFlightOwnerAction();
    if (action !== null) focusRecordsAction(action);
  };
  const focusRecordsListReturn = (recordId: string): void => {
    if (focusRecordsAction(RECORDS_OPEN_RECORD_ACTION, RECORDS_ID_ATTR, recordId)) return;
    if (
      recordsState.selectedKind !== null
      && focusRecordsAction(
        RECORDS_SELECT_KIND_ACTION,
        RECORDS_KIND_ATTR,
        recordsState.selectedKind,
      )
    ) return;
    const namespace = recordsState.selectedNamespace;
    if (namespace !== null) {
      focusRecordsAction(
        RECORDS_SELECT_NAMESPACE_ACTION,
        RECORDS_NAMESPACE_ATTR,
        recordsOwnerKey(namespace.owner),
      );
    }
  };
  const focusContactScanOwner = (
    owner: 'action' | 'result',
  ): boolean => {
    const selector = owner === 'action'
      ? `[${DATA_ROUTE_ACTION_ATTR}="run-merge-scan"]`
      : `[${DATA_ROUTE_SCAN_RESULT_ATTR}]`;
    const target = routeRoot.querySelector?.(selector) as HTMLElement | null | undefined;
    target?.focus?.({ preventScroll: true });
    target?.scrollIntoView?.({ block: 'nearest' });
    return target != null;
  };
  const focusContactMergeOwner = (
    owner: 'contact-merge-confirm' | 'contact-merge-reject' | 'result',
  ): boolean => {
    const selector = owner === 'result'
      ? `[${DATA_ROUTE_MERGE_RESULT_ATTR}]`
      : `[${SHARED_ACTION_ATTR}="${owner}"]`;
    const target = routeRoot.querySelector?.(selector) as HTMLElement | null | undefined;
    target?.focus?.({ preventScroll: true });
    target?.scrollIntoView?.({ block: 'nearest' });
    return target != null;
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
    form: { value: string; submitting: boolean; error: string | null; allDay?: boolean } | null,
  ): string => {
    if (form === null) {
      // Visitor manage links belong to Reception-origin booking detail. This
      // calendar control edits a personal calendar event and intentionally has
      // no `reception.manage.mint` action.
      return `<div class="data-reschedule-actions">
        <button type="button" class="data-button" ${DATA_ROUTE_ACTION_ATTR}="reschedule-open">Reschedule</button>
      </div>`;
    }
    const inputDisabled = form.submitting
      ? ' disabled aria-disabled="true"'
      : '';
    const actionDisabled = form.submitting ? ' aria-disabled="true"' : '';
    const err =
      form.error !== null
        ? `<p class="data-reschedule-error" role="alert">${e(form.error)}</p>`
        : '';
    return `<div class="data-reschedule-form">
      <label class="data-reschedule-label">${form.allDay === true ? 'New day' : 'New start'}
        <input type="${form.allDay === true ? 'date' : 'datetime-local'}" class="data-input" ${DATA_ROUTE_ACTION_ATTR}="reschedule-input" value="${e(form.value)}"${inputDisabled} />
      </label>
      <button type="button" class="data-button" ${DATA_ROUTE_ACTION_ATTR}="reschedule-submit"${actionDisabled}${form.submitting ? ' aria-busy="true"' : ''}>${form.submitting ? 'Rescheduling…' : 'Save'}</button>
      <button type="button" class="data-button" ${DATA_ROUTE_ACTION_ATTR}="reschedule-cancel"${actionDisabled}>Cancel</button>
      ${err}
    </div>`;
  };

  // bar (when the read caller is wired — the explorer renders it only in the
  // detail view).
  const renderExplorerTab = (tab: DataTabId): string => {
    if (tab === 'calendar' && explorerDetail === null
      && (explorerError === undefined || pendingExplorerVerificationRecordId === null)) return calendarAgenda.render();
    const downloadControl =
      tab === 'files' && opts.fileReadCaller !== undefined
        ? `<button type="button" class="data-button" ${DATA_ROUTE_DOWNLOAD_FILE_ATTR}
            ${DATA_ROUTE_ACTION_ATTR}="download-file"${downloadingFile
              ? ' aria-disabled="true" aria-busy="true"'
              : ''}>${
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
    // ⛔ NOT ON A CANCELLED EVENT. Moving one keeps it cancelled — the
    // reschedule recipe patches the times only — so the button offered a
    // change that changes nothing anyone would see (live drive, 2026-10-07).
    const rescheduleControl =
      collectionName === 'calendar'
      && detail?.record != null
      && readDisplayField(detail.record as unknown as Record<string, unknown>, 'status') !== 'cancelled'
      && opts.recipeExecuteCaller !== undefined
      && !calendarEventSurface.isLoading() && !calendarEventSurface.isEditable() && !calendarEventSurface.isEditing()
        ? renderRescheduleControl(rescheduleForm)
        : '';
    const lifecycleControl = tab === 'files' && detail && /^file:[0-9a-f]{32}$/.test(detail.record_id)
      && opts.fileUsageCaller && opts.fileMutateCaller
      ? `<button type="button" class="data-button" ${DATA_ROUTE_ACTION_ATTR}="file-usage">Manage file</button>` : '';
    const lifecyclePanel = lifecycleControl !== '' && fileLifecycle && detail && fileLifecycle.fileId === detail.record_id
      ? renderFileLifecyclePanel(fileLifecycle, DATA_ROUTE_ACTION_ATTR) : '';
    // A connected source's file, or one in a folder Recued watches, goes into
    // Chat as a copy: it is imported first.
    const importChatFile = (detail?.record_id.startsWith('file:remote:') || detail?.record_id.startsWith('file:local:'))
      && opts.fileChatCallers?.cloud;
    const useInChat = tab === 'files' && detail?.record != null && (/^file:[0-9a-f]{32}$/.test(detail.record_id) || importChatFile)
      && opts.fileChatCallers && opts.onUseFileInChat
      ? `<button type="button" class="data-button" ${DATA_ROUTE_ACTION_ATTR}="file-use-in-chat">${importChatFile ? 'Import and use in Chat' : 'Use in Chat'}</button>` : '';
    const previewControl = tab === 'files' && detail?.record != null && opts.filePreviewCallers
      ? `<button type="button" class="data-button" ${DATA_ROUTE_ACTION_ATTR}="file-preview">Preview file</button>` : '';
    // D-315 §6 — an email's two mail-fact actions; none on a security notice.
    const mailStatus = collectionName === 'mail' && detail?.record != null && explorerSelectedSlug !== null
      ? mailFactStatusFor(explorerSelectedSlug, detail.record_id)
      : null;
    const mailFactControls = mailStatus === null || mailStatus.security_notice
      ? ''
      : `${opts.mailFactCallers?.readEmail !== undefined && opts.mailFactCallers.createTemplate !== undefined
          ? `<button type="button" class="data-button" ${DATA_ROUTE_ACTION_ATTR}="mail-fact-make-template">Make a template from this email</button>`
          : ''}${mailStatus.fact_count > 0 && opts.mailFactCallers?.listFacts !== undefined
          ? `<button type="button" class="data-button" ${DATA_ROUTE_ACTION_ATTR}="mail-fact-show-email">Facts from this email (${mailStatus.fact_count})</button>`
          : ''}`;
    const followWork = collectionName === 'mail' && detail?.record != null && explorerSelectedSlug !== null
      ? `<a class="data-button" href="${e(mailWorkFollowHref({ slug: explorerSelectedSlug, record_id: detail.record_id }))}">Follow this work</a>` : '';
    const detailControls = previewControl + (downloadControl !== '' ? downloadControl + lifecycleControl : rescheduleControl + lifecycleControl) + useInChat + mailFactControls + followWork;
    const detailActions = tab === 'files' && detailControls !== ''
      ? `<div class="data-file-actions">${detailControls}</div>${lifecyclePanel}` : detailControls;
    const explorer = renderCollectionExplorer({
      collection: collectionName,
      instances: explorerInstances,
      ...(tab === 'files' ? { instanceLabels: new Map([
        ['received', 'Saved files'], ...cloudSources.map(source => [cloudFileSourceSlug(source.source_id), source.label] as const),
        // A folder says what it is in Connections' words ("Local folder ·
        // clients"), not by its adapter id ("fs · clients").
        ...explorerInstances.flatMap((inst) => {
          const lane = findAccountLane('file');
          const provider = lane ? findAccountProvider(lane, inst.adapter_type) : undefined;
          return provider ? [[inst.slug, `${provider.label} · ${inst.slug}`] as const] : [];
        }),
      ]) } : {}),
      selectedSlug: explorerSelectedSlug,
      records: (tab === 'calendar' || tab === 'mail') && explorerSelectedSlug ? explorerRecords.filter(row => facetIncludes({ collection: tab, id: `${explorerSelectedSlug}:${row.record_id}` })) : explorerRecords,
      detail,
      loading: explorerLoading || loading,
      ...(explorerError !== undefined ? { error: explorerError } : {}),
      ...(explorerErrorRetryable ? { retryable: true } : {}),
      ...(explorerRetrying ? { retrying: true } : {}),
      ...(explorerDetailRetryable ? { detailRetryable: true } : {}),
      ...(explorerDetailRetrying ? { detailRetrying: true } : {}),
      now: (opts.now ?? Date.now)(),
      actionAttr: DATA_ROUTE_ACTION_ATTR,
      ...(detailActions !== '' ? { detailActionsHtml: detailActions } : {}),
      ...(collectionName === 'calendar' && detail?.record != null
        ? { ...(calendarEventSurface.hasSnapshot() ? { detailBodyHtml: calendarEventSurface.render() } : {}),
            detailTimelineHtml: (calendarEventSurface.hasSnapshot() ? '' : calendarEventSurface.render()) + detailTimelineHtml }
        : detailTimelineHtml !== '' ? { detailTimelineHtml } : {}),
      ...(collectionName === 'mail' && detail?.record != null
        ? { ...(mailMessageSurface.hasSnapshot() ? { detailBodyHtml: mailMessageSurface.render() } : {}),
            detailTimelineHtml: (mailMessageSurface.hasSnapshot() ? '' : mailMessageSurface.render()) + detailTimelineHtml }
        : {}),
      // Provenance collections (annotation / link) are single global collections
      // — no instances, no "connected" empty state.
      ...(isSingleCollectionTab(tab) ? { singleCollection: true } : {}),
    });
    if (tab !== 'files') return explorer;
    const uploadShell = uploadDepsReady()
      ? Upload.renderUploadWidget({ widgetId: UPLOAD_WIDGET_ID })
      : '';
    const cloudSource = cloudSources.find(source => cloudFileSourceSlug(source.source_id) === explorerSelectedSlug);
    const cloudBrowse = cloudSource ? `<p role="status">${cloudSource.last_synced_at === null
      ? 'This source has not finished syncing yet.'
      : `Last synced ${e(new Date(cloudSource.last_synced_at).toLocaleString())}.${cloudSource.stale ? ' This file list may be out of date.' : ''}`}</p>
      <p>These files stay in the connected source. Import saves a separate copy in Files.</p>
      ${cloudSource.authentication_connection && CONNECTION_NAME_REGEX.test(cloudSource.authentication_connection)
        ? `<p><a class="data-button" href="${e(connectionsFileAuthenticationAddress(cloudSource.authentication_connection).hash)}">Manage authentication</a></p>` : ''}
      ${!detail ? `<label>Search file names and paths <input class="data-input" type="search" maxlength="200"
        aria-label="Search cloud files" ${DATA_ROUTE_ACTION_ATTR}="file-cloud-query" value="${e(cloudFileQueryInput)}" /></label>
        <button type="button" class="data-button" ${DATA_ROUTE_ACTION_ATTR}="file-cloud-search">Search files</button>` : ''}` : '';
    return `<section ${DATA_ROUTE_MIRROR_ATTR}="files">
      ${opts.fileAttachmentReturn ? `<aside data-yours-file-return><p>Upload a file, then return to attach it to ${e(opts.fileAttachmentReturn.assetName)}.</p>
        <a class="data-button" href="#yours/asset/${e(encodeURIComponent(opts.fileAttachmentReturn.assetId))}/view/files">Return to ${e(opts.fileAttachmentReturn.assetName)}</a></aside>` : ''}
      ${cloudSourcesError ? `<p role="alert">${e(cloudSourcesError)}
        <button type="button" class="data-button" ${DATA_ROUTE_ACTION_ATTR}="file-cloud-refresh">Reload file sources</button></p>` : ''}
      ${opts.fileUsageCaller && explorerSelectedSlug === 'received' ? `<button type="button" class="data-button" ${DATA_ROUTE_ACTION_ATTR}="file-toggle-archived" aria-pressed="${showArchivedFiles}">${showArchivedFiles ? 'Show current files' : 'Show archived files'}</button>` : ''}
      ${fileLifecycleNotice ? `<p role="status" data-file-lifecycle-notice tabindex="-1">${e(fileLifecycleNotice)}</p>` : ''}
      ${uploadShell}
      ${renderFileSourceCta()}
      ${cloudBrowse}
      ${explorer}
      ${cloudBrowseError ? `<p role="alert">${e(cloudBrowseError)}</p>` : ''}
      ${cloudSource && !detail && cloudFileCursor ? `<button type="button" class="data-button"
        ${DATA_ROUTE_ACTION_ATTR}="file-cloud-more"${cloudLoadingMore || explorerLoading ? ' disabled' : ''}>${cloudLoadingMore ? 'Loading…' : 'Load more files'}</button>` : ''}
    </section>`;
  };

  const renderRunVerificationHandoff = (
    returnToRun: LogsRunAddress,
  ): string => {
    const guidance = dataVerificationGuidance(
      activeVerificationRelationship,
    );
    const returnToChat = returnToRun.returnToChat;
    return `<aside ${DATA_ROUTE_LOGS_RETURN_ATTR} role="note" data-relationship="${e(activeVerificationRelationship ?? 'unknown')}">
      <div class="data-verification-copy">
        <span class="data-verification-label">Run verification</span>
        <strong class="data-verification-title">${e(guidance.title)}</strong>
        <p class="data-verification-detail">${e(guidance.detail)}</p>
        <p class="data-verification-boundary">${
          returnToChat === undefined
            ? 'Look at what Data shows below. You cannot run anything again from this page.'
            : 'Look at what Data shows below. Safe next steps appear under the item. You cannot run anything again from this page.'
        }</p>
      </div>
      <div class="data-verification-actions" aria-label="Run navigation">
        <a ${DATA_ROUTE_VERIFICATION_ACTION_ATTR}="run" href="${e(serializeLogsRunAddress(returnToRun))}">Back to run outcome</a>
      </div>
    </aside>`;
  };

  const renderRunVerificationNextSteps = (
    returnToRun: LogsRunAddress,
    itemLoading: boolean,
    itemReady: boolean,
  ): string => {
    const returnToChat = returnToRun.returnToChat;
    if (returnToChat === undefined) return '';
    const chatHref = (
      result: 'reviewed' | 'needs_help',
    ): string => serializeChatPlanAddress({
      sessionId: returnToChat.sessionId,
      planId: returnToChat.planId,
      ...(returnToChat.messageId !== undefined
        ? { messageId: returnToChat.messageId }
        : {}),
      dataVerification: {
        runId: returnToRun.runId,
        result,
        ...(activeVerificationRelationship !== undefined
          ? { relationship: activeVerificationRelationship }
          : {}),
      },
    });
    if (itemLoading) {
      return `<section ${DATA_ROUTE_VERIFICATION_NEXT_ATTR} data-state="loading" aria-live="polite" aria-busy="true">
        <div class="data-verification-copy">
          <span class="data-verification-label">Next step</span>
          <strong class="data-verification-title">Finish reviewing the item</strong>
          <p class="data-verification-detail">Loading the linked item before next steps become available…</p>
        </div>
      </section>`;
    }
    if (!itemReady) {
      return `<section ${DATA_ROUTE_VERIFICATION_NEXT_ATTR} data-state="unresolved" aria-labelledby="data-verification-next-title">
        <div class="data-verification-copy">
          <span class="data-verification-label">Next step</span>
          <strong class="data-verification-title" id="data-verification-next-title">Open the linked item first</strong>
          <p class="data-verification-detail">The exact item is not available to review yet. Choose a source or review the message above, or return to Chat for help. Nothing is marked reviewed.</p>
        </div>
        <div class="data-verification-actions" aria-label="Verification next steps">
          <a ${DATA_ROUTE_VERIFICATION_ACTION_ATTR}="needs-help" href="${e(chatHref('needs_help'))}">I need help finding this item</a>
        </div>
      </section>`;
    }
    const reviewedHref = chatHref('reviewed');
    const needsHelpHref = chatHref('needs_help');
    return `<section ${DATA_ROUTE_VERIFICATION_NEXT_ATTR} data-state="ready" aria-labelledby="data-verification-next-title">
      <div class="data-verification-copy">
        <span class="data-verification-label">Next step</span>
        <strong class="data-verification-title" id="data-verification-next-title">What did Data show?</strong>
        <p class="data-verification-detail">Your choice only returns to the exact Chat action. It does not mark the run successful or retry it.</p>
      </div>
      <div class="data-verification-actions" aria-label="Verification next steps">
        <a ${DATA_ROUTE_VERIFICATION_ACTION_ATTR}="reviewed" data-kind="primary" href="${e(reviewedHref)}">I reviewed it — continue in Chat</a>
        <a ${DATA_ROUTE_VERIFICATION_ACTION_ATTR}="needs-help" href="${e(needsHelpHref)}">I need help interpreting this</a>
      </div>
    </section>`;
  };

  /** Capture only the active list's settings; edit drafts and result bodies never enter a view. */
  const currentView = (): SavedDataViewDefinition | null => {
    // Archived-file browsing is transient and has no saved-view representation.
    if (activeLens === 'data' && activeTab === 'files' && showArchivedFiles) return null;
    if (activeLens === 'memory') {
      if (memoryDetail !== null || memoryCompose.open || memoryImport.open) return null;
      return { tab: 'memory', origin: memoryOriginFilter };
    }
    if (calendarCreateSurface.isOpen() || contactDialog !== null || workEntityState.dialog !== null
      || contactImport !== null || contactScan !== null || currentDeepLinkEntity() !== undefined) return null;
    if (activeTab === 'contact') return { tab: activeTab, query: contactSearch };
    if (activeTab === 'search') return { tab: activeTab, query: universalSearchQuery };
    if (activeTab === 'calendar') {
      const slug = calendarAgenda.selectedSource();
      return calendarAgenda.isToday() && slug !== undefined ? { tab: activeTab, collection_slug: slug } : null;
    }
    if (isWorkEntityTab(activeTab)) return {
      tab: activeTab, query: workEntityState.search_query, source_id: workEntityState.selected_source_id,
      booking_lifecycle: activeTab === 'booking' ? bookingLifecycleFilter : 'all',
      ...(activeTab === 'task' && (taskViewFilters.completion !== 'all'
        || taskViewFilters.due !== 'all' || taskViewFilters.sort !== 'default')
        ? { task_filters: taskViewFilters } : {}),
      ...(activeTab === 'commitment' && (commitmentViewFilters.direction !== 'all' || commitmentViewFilters.status !== 'all')
        ? { commitment_filters: commitmentViewFilters } : {}),
    };
    if (activeTab === 'mail' || activeTab === 'files') {
      return { tab: activeTab, collection_slug: explorerSelectedSlug
        ?? savedExplorerScopes.get(activeTab) ?? null };
    }
    if (activeTab === 'records') {
      if (recordsState.detail !== null || recordsState.purgePending || recordsState.outboxOpen
        || recordsViewHasDraft(recordsState)) return null;
      return { tab: activeTab, owner: recordsState.selectedNamespace?.owner ?? savedRecordsSelection?.owner ?? null,
        entity: recordsState.selectedKind ?? savedRecordsSelection?.entity ?? null, ...recordsState.view };
    }
    if (activeTab === 'form_response' || activeTab === 'annotation' || activeTab === 'link' || activeTab === 'shared') return { tab: activeTab };
    return null;
  };

  const render = (): void => {
    let searchFocusFallback = false;
    let agendaFocusFallback = false;
    const agendaVisible = activeLens === 'data' && activeTab === 'calendar' && explorerDetail === null;
    const agendaFocus = agendaVisible ? (doc.activeElement as HTMLElement | null)?.getAttribute?.(AGENDA_FOCUS) : null;
    const agendaSourcesOpen = agendaVisible
      ? routeRoot.querySelector?.<HTMLDetailsElement>('details[data-calendar-agenda-sources]')?.open : undefined;
    const agendaScroll = agendaVisible ? pendingCalendarAgendaRestore?.scrollTop
      ?? (renderedActiveTab === 'calendar' && routeRoot.querySelector?.('[data-calendar-agenda]') ? workSearchScrollHost()?.scrollTop : undefined) : undefined;
    const mailScrollTop = activeLens === 'data' && activeTab === 'mail' && renderedActiveTab === 'mail'
      && routeRoot.querySelector?.('.data-mail-conversation') ? workSearchScrollHost()?.scrollTop : undefined;
    const mailIndexScroll = activeLens === 'data' && activeTab === 'mail' && renderedActiveTab === 'mail'
      ? mailMessageSurface.captureScroll(routeRoot) : null;
    const projectRead = activeTab === 'project' && projectWork !== null && !projectEditing;
    const projectFocus = projectRead ? pendingProjectRestore?.key
      ?? doc.activeElement?.closest?.('[data-project-focus]')?.getAttribute('data-project-focus') : undefined;
    const projectScroll = projectRead ? pendingProjectRestore?.scrollTop
      ?? (routeRoot.querySelector?.('.project-overview') ? workSearchScrollHost()?.scrollTop : undefined) : undefined;
    const revealAssetSearchFocus = pendingAssetSearchRestore?.reveal === true;
    const searchScrollTop = activeTab === 'search' ? pendingAssetSearchRestore?.scrollTop ?? pendingContactSearchRestore?.scrollTop ?? pendingWorkSearchRestore?.scrollTop
      ?? (renderedActiveTab === 'search' && routeRoot.querySelector?.('.rq-search') ? workSearchScrollHost()?.scrollTop : undefined) : undefined;
    const oldNoteReader = routeRoot.querySelector?.<HTMLElement>('.work-entity-note-reader');
    const oldNoteFocus = oldNoteReader?.contains(doc.activeElement) ? doc.activeElement : null;
    const noteFocus = oldNoteFocus?.getAttribute('data-action');
    const noteFocusSection = oldNoteFocus?.tagName === 'SUMMARY' ? oldNoteFocus.parentElement?.getAttribute('data-note-section') : null;
    const noteSections = new Map(Array.from(oldNoteReader?.querySelectorAll<HTMLDetailsElement>('details[data-note-section]') ?? [])
      .map(section => [section.getAttribute('data-note-section'), section.open]));
    const noteScroll = oldNoteReader ? { id: oldNoteReader.getAttribute('data-note-id'),
      top: oldNoteReader.querySelector<HTMLElement>('.work-entity-note-content')?.scrollTop ?? 0 } : null;
    const canFacet = !projectWork && !spheresUnsupported && opts.spheres?.readMany && activeLens === 'data' && (isWorkEntityTab(activeTab) || ['contact', 'calendar', 'mail'].includes(activeTab));
    // A filter over no loaded records filters nothing, so it shows once there are
    // records (or while a chosen sphere needs a way back to all).
    let facetHasRecords = false;
    if (canFacet) {
      const refs = isWorkEntityTab(activeTab) ? workEntities.map(row => ({ collection: row._kind, id: row.id }))
        : activeTab === 'contact' ? contacts.map(row => ({ collection: 'contact', id: row.contact_id ?? row.email }))
        : explorerSelectedSlug ? explorerRecords.map(row => ({ collection: activeTab, id: `${explorerSelectedSlug}:${row.record_id}` })) : [];
      facetHasRecords = refs.length > 0;
      const key = JSON.stringify([activeTab, refs]);
      if (key !== facetKey) {
        facetKey = key; const generation = ++facetGeneration; facetsLoading = true; facetError = '';
        void (async () => {
          const placements: Awaited<ReturnType<NonNullable<SpherePlacementCallers['readMany']>>> = [];
          for (let offset = 0; offset < refs.length; offset += 500) placements.push(...await opts.spheres!.readMany!(refs.slice(offset, offset + 500)));
          if (disposed || generation !== facetGeneration) return; placements.forEach(value => facetPlacements.set(facetId(value.ref), value));
        })().catch(error => { if (disposed || generation !== facetGeneration) return;
          if (classifyRpcError(error).code === 'unknown_method') { spheresUnsupported = true; dataSphere = 'all'; } else facetError = 'Sphere placements could not be read. This filter may be incomplete.'; })
          // Under "All spheres" the placements change nothing on screen until a sphere is
          // picked, so they load quietly: a repaint here took focus from a just-saved row.
          .finally(() => { if (!disposed && generation === facetGeneration) { facetsLoading = false; if (dataSphere !== 'all' || facetError || spheresUnsupported) render(); } });
      }
    }
    if (filePreviewRecord && (activeLens !== 'data' || activeTab !== 'files' || explorerDetail?.record_id !== filePreviewRecord.id
      || explorerSelectedSlug !== filePreviewRecord.slug)) { filePreviewAbort?.abort(); filePreviewRecord = null; }
    if (fileChatRecord && (activeLens !== 'data' || activeTab !== 'files' || explorerDetail?.record_id !== fileChatRecord.id
      || explorerSelectedSlug !== fileChatRecord.slug)) {
      fileChatAbort?.abort(); fileChatRecord = null;
    }
    if (disposed) return;
    // This route repaints with `innerHTML` as reads settle. Preserve ownership
    // when a collection tab/source, work-entity source/search, response editor
    // control, or timeline/reschedule control has focus: the replacement
    // otherwise strands focus on
    // <body> (and an uncontrolled field can lose its draft). A later repaint
    // captures the live owner again, so moving to another control while a read
    // is pending cancels the restoration naturally.
    const activeElement = doc.activeElement as HTMLElement | null | undefined;
    const focusedSearchControl = activeTab === 'search' && (activeElement?.tagName === 'BUTTON' || activeElement?.tagName === 'A')
      && activeElement.closest?.('.rq-search') ? [DATA_ROUTE_ACTION_ATTR, SEARCH_WORK_KIND_ATTR, SEARCH_WORK_ID_ATTR,
        SEARCH_GROUP_PLATFORM_ATTR, SEARCH_GROUP_SLUG_ATTR, SEARCH_RECORD_ID_ATTR, SEARCH_RECIPE_ID_ATTR,
        SEARCH_PACK_SLUG_ATTR, SEARCH_DID_YOU_MEAN_QUERY_ATTR, SEARCH_CONTACT_EMAIL_ATTR, SEARCH_ASSET_ID_ATTR].map(attribute => [attribute, activeElement.getAttribute(attribute)] as const) : null;
    // D-315 — Mail facts keys each focusable control; restored after the repaint.
    const focusedMailFactsKey = renderedActiveTab === 'mail_fact'
      ? mailFacts.captureFocus(activeElement)
      : null;
    const focusedCalendarEvent = renderedActiveTab === 'calendar' ? calendarEventSurface.captureFocus(activeElement) : null;
    const focusedCalendarCreate = renderedActiveTab === 'calendar' ? calendarCreateSurface.captureFocus(activeElement) : null;
    const focusedMailMessage = renderedActiveTab === 'mail' ? mailMessageSurface.captureFocus(activeElement) : null;
    // D-324 — so does the Reminders tab.
    const focusedTaskBulk = renderedActiveTab === 'task' ? activeElement?.getAttribute?.(TASK_BULK_FOCUS) ?? null : null;
    const focusedRemindersKey = renderedActiveTab === 'reminder'
      ? remindersSurface.captureFocus(activeElement)
      : null;
    const fileAction = activeElement?.getAttribute?.(DATA_ROUTE_ACTION_ATTR);
    const focusedFileLifecycleKey = renderedActiveTab !== 'files' ? null
      : activeElement?.getAttribute?.('data-file-lifecycle') === '' ? 'panel'
      : activeElement?.getAttribute?.('data-file-lifecycle-notice') === '' ? 'notice'
      : fileAction && ['file-usage', 'file-archive', 'file-restore', 'file-delete', 'file-delete-confirm', 'file-delete-cancel', 'file-toggle-archived'].includes(fileAction)
        ? fileAction : null;
    const focusedContactScanOwnerKind: 'action' | 'result' | null = contactScan === null
      ? null
      : activeElement?.getAttribute?.(DATA_ROUTE_ACTION_ATTR) === 'run-merge-scan'
        ? 'action'
        : activeElement?.hasAttribute?.(DATA_ROUTE_SCAN_RESULT_ATTR) === true
          ? 'result'
          : null;
    const activeContactMergeAction = activeElement?.getAttribute?.(
      SHARED_ACTION_ATTR,
    );
    const focusedContactMergeOwner:
      | 'contact-merge-confirm'
      | 'contact-merge-reject'
      | 'result'
      | null = contactScan === null
        ? null
        : activeContactMergeAction === 'contact-merge-confirm'
          || activeContactMergeAction === 'contact-merge-reject'
          ? activeContactMergeAction
          : activeElement?.hasAttribute?.(DATA_ROUTE_MERGE_RESULT_ATTR) === true
            ? 'result'
            : null;
    const focusedContactImportFileOwner =
      activeLens === 'data'
      && activeTab === 'contact'
      && contactImport?.source_id === null
      && (
        activeElement?.getAttribute?.(DATA_ROUTE_ACTION_ATTR)
          === 'contact-import-file-apply'
        || activeElement?.hasAttribute?.(
          DATA_ROUTE_CONTACT_IMPORT_RESULT_ATTR,
        ) === true
      );
    const focusedContactImportPromoteOwner =
      activeLens === 'data'
      && activeTab === 'contact'
      && contactImport?.source_id != null
      && (
        activeElement?.getAttribute?.(DATA_ROUTE_ACTION_ATTR)
          === 'contact-import-promote'
        || activeElement?.hasAttribute?.(
          DATA_ROUTE_CONTACT_IMPORT_RESULT_ATTR,
        ) === true
      );
    const focusedFormResponseAutomationTrigger =
      activeLens === 'data'
      && renderedActiveTab === activeTab
      && isReceivedTab(activeTab)
      && formResponseDetailId !== null
      && activeElement?.getAttribute?.(DATA_ROUTE_ACTION_ATTR)
        === 'discover-form-response-automations';
    if (pendingFormResponseAutomationPickerFocus) {
      const liveOwnerMovedElsewhere =
        activeElement !== null
        && activeElement !== undefined
        && activeElement !== doc.body
        && activeElement.isConnected !== false;
      if (
        activeLens !== 'data'
        || !isReceivedTab(activeTab)
        || formResponseDetailId === null
        || (!focusedFormResponseAutomationTrigger && liveOwnerMovedElsewhere)
      ) {
        pendingFormResponseAutomationPickerFocus = false;
      }
    }
    const activeSearch = activeElement as HTMLInputElement | null | undefined;
    const draftFieldAttribute = contactDialog !== null ? DATA_ROUTE_CONTACT_FIELD_ATTR
      : workEntityState.dialog !== null ? 'data-form-field' : null;
    const draftField = draftFieldAttribute === null ? null : activeElement?.getAttribute?.(draftFieldAttribute);
    const focusedDraftField = draftField == null || draftFieldAttribute === null ? null : {
      attribute: draftFieldAttribute, field: draftField,
      selectionStart: activeSearch?.selectionStart, selectionEnd: activeSearch?.selectionEnd,
      selectionDirection: activeSearch?.selectionDirection,
    };
    const focusedWorkEntityRow =
      activeLens === 'data'
      && renderedActiveTab === activeTab
      && isWorkEntityTab(activeTab)
      && activeElement?.getAttribute?.(SHARED_ACTION_ATTR)
        === 'open-edit-work-entity'
      && activeElement.getAttribute('data-kind') === activeTab
      && activeElement.getAttribute('data-entity-id') !== null
        ? {
            kind: activeTab,
            id: activeElement.getAttribute('data-entity-id')!,
          }
        : null;
    const focusedWorkEntitySource =
      activeLens === 'data'
      && renderedActiveTab === activeTab
      && isWorkEntityTab(activeTab)
      && activeElement?.getAttribute?.(SHARED_ACTION_ATTR) === 'select-source'
        ? activeTab
        : null;
    const focusedWorkEntityDialogSubmit =
      workEntityState.dialog !== null
      && activeElement?.getAttribute?.(SHARED_ACTION_ATTR)
        === 'submit-work-entity-dialog';
    const focusedContactDialogSubmit =
      contactDialog !== null
      && activeElement?.getAttribute?.(DATA_ROUTE_ACTION_ATTR)
        === 'submit-contact-dialog';
    const focusedTimelineTrigger =
      activeLens === 'data'
      && renderedActiveTab === activeTab
      && isMirrorTab(activeTab)
      && activeElement?.getAttribute?.(DATA_ROUTE_ACTION_ATTR) === 'load-timeline';
    const focusedTimelineEntityInput =
      activeLens === 'data'
      && renderedActiveTab === activeTab
      && isMirrorTab(activeTab)
      && activeSearch?.hasAttribute?.(DATA_ROUTE_TIMELINE_ENTITY_ATTR) === true
        ? {
            selectionStart: activeSearch.selectionStart,
            selectionEnd: activeSearch.selectionEnd,
            selectionDirection: activeSearch.selectionDirection,
          }
        : null;
    const focusedFileDownloadId =
      activeLens === 'data'
      && renderedActiveTab === activeTab
      && activeTab === 'files'
      && explorerDetail !== null
      && activeElement?.hasAttribute?.(DATA_ROUTE_DOWNLOAD_FILE_ATTR) === true
        ? explorerDetail.record_id
        : null;
    const focusedRescheduleControlRaw = activeElement?.getAttribute?.(
      DATA_ROUTE_ACTION_ATTR,
    );
    const focusedRescheduleControl =
      activeLens === 'data'
      && renderedActiveTab === activeTab
      && activeTab === 'calendar'
      && explorerDetail !== null
      && (
        (
          focusedRescheduleControlRaw === 'reschedule-open'
          && rescheduleForm === null
        )
        || (
          rescheduleForm !== null
          && (
            focusedRescheduleControlRaw === 'reschedule-input'
            || focusedRescheduleControlRaw === 'reschedule-submit'
            || focusedRescheduleControlRaw === 'reschedule-cancel'
          )
        )
      )
        ? {
            recordId: explorerDetail.record_id,
            action: focusedRescheduleControlRaw,
          }
        : null;
    const focusedFormResponseExportFormatRaw =
      activeElement?.getAttribute?.(DATA_ROUTE_ACTION_ATTR)
        === 'export-form-responses'
        ? activeElement.getAttribute('data-format')
        : null;
    const focusedFormResponseExportFormat =
      activeLens === 'data'
      && renderedActiveTab === activeTab
      && isReceivedTab(activeTab)
      && (
        focusedFormResponseExportFormatRaw === 'json'
        || focusedFormResponseExportFormatRaw === 'csv'
      )
        ? focusedFormResponseExportFormatRaw
        : null;
    const focusedFormResponseEditorControl =
      activeLens === 'data'
      && renderedActiveTab === activeTab
      && isReceivedTab(activeTab)
      && formResponseDetailId !== null
        ? formResponseEditorControlFrom(activeElement)
        : null;
    const focusedFormResponseEditor: FormResponseEditorFocus | null =
      focusedFormResponseEditorControl === null
      || formResponseDetailId === null
        ? null
        : {
            submissionId: formResponseDetailId,
            control: focusedFormResponseEditorControl,
            selectionStart:
              focusedFormResponseEditorControl === 'values'
              || focusedFormResponseEditorControl === 'email'
                ? (activeElement as HTMLInputElement | HTMLTextAreaElement)
                    .selectionStart
                : null,
            selectionEnd:
              focusedFormResponseEditorControl === 'values'
              || focusedFormResponseEditorControl === 'email'
                ? (activeElement as HTMLInputElement | HTMLTextAreaElement)
                    .selectionEnd
                : null,
            selectionDirection:
              focusedFormResponseEditorControl === 'values'
              || focusedFormResponseEditorControl === 'email'
                ? (activeElement as HTMLInputElement | HTMLTextAreaElement)
                    .selectionDirection
                : null,
          };
    if (pendingFormResponseEditorFocus !== null) {
      const liveOwnerMovedElsewhere =
        activeElement !== null
        && activeElement !== undefined
        && activeElement !== doc.body
        && activeElement.isConnected !== false;
      if (
        activeLens !== 'data'
        || !isReceivedTab(activeTab)
        || formResponseDetailId !== pendingFormResponseEditorFocus.submissionId
        || (focusedFormResponseEditor === null && liveOwnerMovedElsewhere)
      ) {
        pendingFormResponseEditorFocus = null;
      }
    }
    const focusedFormResponseDetailId =
      activeLens === 'data'
      && renderedActiveTab === activeTab
      && isReceivedTab(activeTab)
      && activeElement?.hasAttribute?.(
        DATA_ROUTE_FORM_RESPONSE_DETAIL_HEADING_ATTR,
      ) === true
        ? formResponseDetailId
        : null;
    if (pendingFormResponseDetailFocusId !== null) {
      const stillOwnedByRow =
        isReceivedTab(renderedActiveTab)
        && activeElement?.getAttribute?.(DATA_ROUTE_FORM_RESPONSE_ID_ATTR)
          === pendingFormResponseDetailFocusId
        && activeElement.getAttribute(DATA_ROUTE_ACTION_ATTR)
          === 'open-form-response';
      const liveOwnerMovedElsewhere =
        activeElement !== null
        && activeElement !== undefined
        && activeElement !== doc.body
        && activeElement.isConnected !== false;
      if (
        activeLens !== 'data'
        || !isReceivedTab(activeTab)
        || (!stillOwnedByRow && liveOwnerMovedElsewhere)
      ) {
        pendingFormResponseDetailFocusId = null;
      }
    }
    if (pendingFormResponseLoadMoreFocus) {
      const stillOwnedByLoadMore = activeElement?.getAttribute?.(
        DATA_ROUTE_ACTION_ATTR,
      ) === 'load-more-form-responses';
      const liveOwnerMovedElsewhere =
        activeElement !== null
        && activeElement !== undefined
        && activeElement !== doc.body
        && activeElement.isConnected !== false;
      if (
        activeLens !== 'data'
        || !isReceivedTab(activeTab)
        || (!stillOwnedByLoadMore && liveOwnerMovedElsewhere)
      ) {
        pendingFormResponseLoadMoreFocus = false;
        pendingLoadedFormResponseIds = [];
      }
    }
    if (pendingWorkEntityLoadMoreFocusKind !== null) {
      const stillOwnedByLoadMore = activeElement?.getAttribute?.(
        DATA_ROUTE_ACTION_ATTR,
      ) === 'load-more-work-entities';
      const liveOwnerMovedElsewhere =
        activeElement !== null
        && activeElement !== undefined
        && activeElement !== doc.body
        && activeElement.isConnected !== false;
      if (
        activeLens !== 'data'
        || activeTab !== pendingWorkEntityLoadMoreFocusKind
        || (!stillOwnedByLoadMore && liveOwnerMovedElsewhere)
      ) {
        pendingWorkEntityLoadMoreFocusKind = null;
        pendingLoadedWorkEntityKeys = [];
      }
    }
    if (pendingContactLoadMoreFocus) {
      const stillOwnedByLoadMore = activeElement?.getAttribute?.(
        DATA_ROUTE_ACTION_ATTR,
      ) === 'load-more-contacts';
      const liveOwnerMovedElsewhere =
        activeElement !== null
        && activeElement !== undefined
        && activeElement !== doc.body
        && activeElement.isConnected !== false;
      if (!stillOwnedByLoadMore && liveOwnerMovedElsewhere) {
        pendingContactLoadMoreFocus = false;
        pendingLoadedContactEmail = null;
      }
    }
    const focusedContactDetailEmail =
      activeLens === 'data'
      && renderedActiveTab === activeTab
      && activeTab === 'contact'
      && activeElement?.hasAttribute?.(
        DATA_ROUTE_CONTACT_DETAIL_HEADING_ATTR,
      ) === true
        ? contactDetail?.email ?? null
        : null;
    if (pendingContactDetailFocusEmail !== null) {
      const stillOwnedByRow =
        renderedActiveTab === 'contact'
        && activeElement?.getAttribute?.(DATA_ROUTE_CONTACT_EMAIL_ATTR)
          === pendingContactDetailFocusEmail
        && activeElement.getAttribute(DATA_ROUTE_ACTION_ATTR)
          === 'open-contact-detail';
      const stillOwnedBySearchResult =
        activeElement?.getAttribute?.(DATA_ROUTE_ACTION_ATTR) === SEARCH_OPEN_CONTACT_ACTION
        && activeElement.getAttribute(SEARCH_CONTACT_EMAIL_ATTR) === pendingContactDetailFocusEmail;
      const liveOwnerMovedElsewhere =
        activeElement !== null
        && activeElement !== undefined
        && activeElement !== doc.body
        && activeElement.isConnected !== false;
      if (!stillOwnedByRow && !stillOwnedBySearchResult && liveOwnerMovedElsewhere) {
        pendingContactDetailFocusEmail = null;
      }
    }
    if (pendingContactEditFocusEmail !== null) {
      const stillOwnedByEdit =
        activeElement?.getAttribute?.(DATA_ROUTE_ACTION_ATTR)
          === 'open-edit-contact'
        && activeElement.getAttribute(DATA_ROUTE_CONTACT_EMAIL_ATTR)
          === pendingContactEditFocusEmail;
      const liveOwnerMovedElsewhere =
        activeElement !== null
        && activeElement !== undefined
        && activeElement !== doc.body
        && activeElement.isConnected !== false;
      if (
        activeLens !== 'data'
        || activeTab !== 'contact'
        || contactDetail?.email !== pendingContactEditFocusEmail
        || (!stillOwnedByEdit && liveOwnerMovedElsewhere)
      ) {
        pendingContactEditFocusEmail = null;
      }
    }
    const commitmentFocused = activeTab === 'commitment' && activeElement?.closest?.('.work-entity-commitment-reader')
      ? { id: activeElement.closest('.work-entity-commitment-reader')?.getAttribute('data-commitment-id'), action: activeElement.getAttribute?.(SHARED_ACTION_ATTR),
          status: activeElement.hasAttribute?.('data-commitment-status'), notice: activeElement.hasAttribute?.('data-commitment-notice') } : null;
    const focusedTaskFilter = activeLens === 'data' && (activeTab === 'task' || activeTab === 'commitment')
      && renderedActiveTab === activeTab
      && activeElement?.getAttribute?.(SHARED_ACTION_ATTR)?.startsWith(`filter-${activeTab}-`)
      ? activeElement.getAttribute(SHARED_ACTION_ATTR) : null;
    const focusedSearch =
      activeLens === 'data'
      && renderedActiveTab === activeTab
      && activeTab === 'contact'
      && activeSearch?.hasAttribute?.(DATA_ROUTE_CONTACT_SEARCH_ATTR) === true
        ? {
            tab: activeTab,
            kind: 'contact' as const,
            selectionStart: activeSearch.selectionStart,
            selectionEnd: activeSearch.selectionEnd,
            selectionDirection: activeSearch.selectionDirection,
          }
        : activeLens === 'data'
          && renderedActiveTab === activeTab
          && isWorkEntityTab(activeTab)
          && activeSearch?.getAttribute?.(SHARED_ACTION_ATTR)
            === 'search-work-entities'
          && activeSearch.getAttribute('data-kind') === activeTab
            ? {
                tab: activeTab,
                kind: 'work-entity' as const,
                selectionStart: activeSearch.selectionStart,
                selectionEnd: activeSearch.selectionEnd,
                selectionDirection: activeSearch.selectionDirection,
              }
            // D-267 — the universal-search box was NOT in this list, so every
            // arriving result set replaced the input the owner was typing into
            // and dropped the caret. The keystroke handler deliberately does not
            // render, which hid it until the debounce fired; the repaint that
            // paints results is the one that steals focus. A fast path into a
            // box that loses your caret on the third character is not a fast
            // path, so this is part of making the chord worth having.
            : activeLens === 'data'
              && renderedActiveTab === activeTab
              && activeTab === 'search'
              && activeSearch?.hasAttribute?.(SEARCH_INPUT_ATTR) === true
              ? {
                  tab: activeTab,
                  kind: 'universal' as const,
                  selectionStart: activeSearch.selectionStart,
                  selectionEnd: activeSearch.selectionEnd,
                  selectionDirection: activeSearch.selectionDirection,
                }
            // ⛔ The cloud file search box was missing too, and its list repaints
            // when a source's first page lands, which is just when an owner who
            // picked the source starts typing. The repaint replaced the box, so
            // focus fell to <body> and the rest of the search went nowhere: Enter
            // then searched for part of it, or for nothing.
            : activeLens === 'data'
              && renderedActiveTab === activeTab
              && activeTab === 'files'
              && activeSearch?.getAttribute?.(DATA_ROUTE_ACTION_ATTR) === 'file-cloud-query'
              ? {
                  tab: activeTab,
                  kind: 'cloud-file' as const,
                  selectionStart: activeSearch.selectionStart,
                  selectionEnd: activeSearch.selectionEnd,
                  selectionDirection: activeSearch.selectionDirection,
                }
            : null;
    const focusedTabRaw = activeElement?.getAttribute?.(DATA_ROUTE_TAB_ATTR);
    const focusedCollectionPicker = activeElement?.hasAttribute?.(DATA_ROUTE_COLLECTION_PICKER_ATTR) === true;
    const focusedTab = focusedTabRaw !== null
      && focusedTabRaw !== undefined
      && isDataTab(focusedTabRaw)
        ? focusedTabRaw
        : null;
    const focusedExplorerSlug =
      activeLens === 'data'
      && renderedActiveTab === activeTab
      && isExplorerTab(activeTab)
        ? activeElement?.getAttribute?.(COLLECTION_INSTANCE_SLUG_ATTR) ?? null
        : null;
    const focusedExplorerRetry =
      activeLens === 'data'
      && renderedActiveTab === activeTab
      && (isExplorerTab(activeTab) || isSingleCollectionTab(activeTab))
      && activeElement?.hasAttribute?.(COLLECTION_RETRY_ATTR) === true;
    if (pendingExplorerRetryFocus !== null) {
      const stillOwnedByRetry =
        renderedActiveTab === pendingExplorerRetryFocus
        && focusedExplorerRetry;
      const liveOwnerMovedElsewhere =
        activeElement !== null
        && activeElement !== undefined
        && activeElement !== doc.body
        && activeElement.isConnected !== false;
      if (!stillOwnedByRetry && liveOwnerMovedElsewhere) {
        pendingExplorerRetryFocus = null;
      }
    }
    const focusedExplorerDetailRetryId =
      activeLens === 'data'
      && renderedActiveTab === activeTab
      && isExplorerTab(activeTab)
      && activeElement?.hasAttribute?.(COLLECTION_DETAIL_RETRY_ATTR) === true
        ? explorerDetail?.record_id ?? null
        : null;
    if (pendingExplorerDetailRetryFocus !== null) {
      const stillOwnedByRetry =
        renderedActiveTab === pendingExplorerDetailRetryFocus.tab
        && focusedExplorerDetailRetryId
          === pendingExplorerDetailRetryFocus.recordId;
      const liveOwnerMovedElsewhere =
        activeElement !== null
        && activeElement !== undefined
        && activeElement !== doc.body
        && activeElement.isConnected !== false;
      if (!stillOwnedByRetry && liveOwnerMovedElsewhere) {
        pendingExplorerDetailRetryFocus = null;
      }
    }
    const focusedExplorerDetailId =
      activeLens === 'data'
      && renderedActiveTab === activeTab
      && (isExplorerTab(activeTab) || isSingleCollectionTab(activeTab))
      && activeElement?.hasAttribute?.(COLLECTION_DETAIL_HEADING_ATTR) === true
        ? explorerDetail?.record_id ?? null
        : null;
    if (pendingExplorerRecordFocus !== null) {
      const stillOwnedByRow =
        renderedActiveTab === pendingExplorerRecordFocus.tab
        && activeElement?.getAttribute?.(COLLECTION_RECORD_ID_ATTR)
          === pendingExplorerRecordFocus.recordId;
      const liveOwnerMovedElsewhere =
        activeElement !== null
        && activeElement !== undefined
        && activeElement !== doc.body
        && activeElement.isConnected !== false;
      if (!stillOwnedByRow && liveOwnerMovedElsewhere) {
        pendingExplorerRecordFocus = null;
      }
    }
    const body = activeTab === 'contact'
      ? renderContactSurface(
          contacts.filter(row => facetIncludes({ collection: 'contact', id: row.contact_id ?? row.email })),
          contactRollups,
          contactTotal,
          loadingMoreContacts,
          contactSearch,
          contactDialog,
          contactDiscardGuardOpen,
          contactDetail,
          loadingContactDetail,
          openingContactEditEmail,
          contactScan,
          opts.contactMergeScanNowCaller !== undefined,
          canReviewMerges,
          contactSources,
          contactImport,
          canImport,
          canUploadFile,
          (opts.now ?? Date.now)(),
          contacts.length,
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
            opts.formResponseUpdateCaller !== undefined
              && opts.formResponseSetStateCaller !== undefined,
            formResponseEditorDraft,
            savingFormResponse,
            formResponseSaveError,
            formResponseDiscardGuardOpen,
            opts.formResponseExportCaller !== undefined,
            exportingFormResponseFormat,
          )
      : isWorkEntityTab(activeTab)
        ? renderWorkEntitySurface(
            workEntityState,
            sources,
            defaultsByKind,
            workEntities.filter(row => facetIncludes({ collection: row._kind, id: row.id })),
            workEntityTotal,
            loadingMoreWorkEntities,
            pendingWorkEntityDialogOpen?.kind === activeTab
              ? pendingWorkEntityDialogOpen.id
              : null,
            bookingLifecycleFilter,
            taskViewFilters,
            commitmentViewFilters,
            commitmentContactLabels,
            bookingDetailId,
            bookingDetail,
            bookingDetailError,
            loadingBookingDetail,
            opts.manageRescheduleLinkCaller !== undefined,
            bookingManageLinkBusy,
            bookingManageLinkNotice,
            workEntityDiscardGuardOpen,
            // ⛔ Matched to the dialog on screen HERE, not inside the renderer:
            // a feed from a previously-open entity would attribute one row's
            // history to another. Empty when the read has not landed, so the
            // section is omitted rather than asserting an empty past.
            (() => {
              const dialog = workEntityState.dialog;
              if (dialog === null || dialog.mode !== 'edit') return '';
              if (workEntityTimeline === null) return '';
              if (workEntityTimeline.kind !== workEntityState.kind) return '';
              if (workEntityTimeline.id !== dialog.entity_id) return '';
              if (workEntityTimeline.entries.length === 0) return '';
              
              return renderTimelineSection(
                workEntityTimeline.entries,
                (opts.now ?? Date.now)(),
                (entry) => {
                  const runId = runIdFromTimelinePayload(entry.payload);
                  return runId !== null ? runHref(runId) : null;
                },
                (entry) => summarizePayload(entry.payload),
              );
            })(),
            (() => {
              const dialog = workEntityState.dialog;
              const entity = workEntityDialogEntity;
              if (activeTab !== 'task' || dialog?.mode !== 'edit'
                || entity?._kind !== 'task' || entity.id !== dialog.entity_id) return undefined;
              const source = sources.find((entry) => entry.id === entity.source_id);
              return { done: entity.done,
                busy: taskCompletionPending?.id === entity.id
                  && taskCompletionPending.sequence === workEntityDialogOpenSeq,
                can_change: opts.taskMarkDoneCaller !== undefined
                  && opts.workEntityGetCaller !== undefined && opts.workEntitySourceListCaller !== undefined
                  && entity.sync_state === 'live' && entity.deleted_at == null && !entity.pending_write
                  && source?.top_tier_kind === 'task' && source.write_capable
                  && source.sync_posture !== 'read_through',
                ...(entity.pending_write
                  ? { notice: 'A task change is waiting for source confirmation.' }
                  : taskCompletionNotice !== null ? { notice: taskCompletionNotice } : {}) };
            })(),
            workEntityDialogEntity?._kind === 'commitment' ? {
              state: workEntityDialogEntity.lifecycle_state,
              can_change: canCloseCommitment(workEntityDialogEntity, 'fulfill') || canCloseCommitment(workEntityDialogEntity, 'cancel'),
              can_fulfill: canCloseCommitment(workEntityDialogEntity, 'fulfill'),
              can_cancel: canCloseCommitment(workEntityDialogEntity, 'cancel'),
            } : undefined,
            workEntities.length,
            taskDetailsOpen,
            noteDetailsOpen,
            (() => {
              const entity = workEntityDialogEntity;
              if (activeTab !== 'note' || entity?._kind !== 'note'
                || workEntityState.dialog?.mode !== 'edit' || workEntityState.dialog.entity_id !== entity.id) return undefined;
              return { entity, mode: noteMode, can_edit: canEditNote(entity),
                copying: noteCopying, opening: pendingWorkEntityDialogOpen?.id === entity.id,
                ...(noteNotice ? { notice: noteNotice } : {}) };
            })(),
            (() => {
              const entity = workEntityDialogEntity;
              if (activeTab !== 'commitment' || entity?._kind !== 'commitment' || workEntityState.dialog?.mode !== 'edit'
                || workEntityState.dialog.entity_id !== entity.id) return undefined;
              return { entity, mode: commitmentMode, can_edit: canEditCommitment(entity),
                counterparty_label: commitmentCounterpartyLabel(entity, commitmentContactLabels),
                opening: pendingWorkEntityDialogOpen?.id === entity.id, notice: commitmentNotice };
            })(),
            projectChildReturn ? 'Back to project' : workSearchReturn ? 'Back to search' : undefined,
            projectOverviewProps(),
            activeTab === 'task' && !workEntityState.dialog && taskBulk.enabled()
              ? { selection: taskBulk.selection(), html: taskBulk.render() } : undefined,
          )
        : activeTab === 'search'
          ? renderUniversalSearch({
              query: universalSearchQuery,
              ...(opts.assetSearchCaller ? { assetSearch: assetSearch.state() } : {}),
              ...(opts.contactListCaller ? { contactSearch: { contacts: universalSearchContacts,
                total: universalSearchContactTotal, loading: universalSearchContactLoading, more: universalSearchContactMore,
                ...(universalSearchContactError ? { error: universalSearchContactError } : {}),
                ...(universalSearchContactUnsupported ? { unsupported: true } : {}) } } : {}),
              ...(universalSearchWorkGroups !== undefined ? { workGroups: universalSearchWorkGroups } : {}),
              workLoading: universalSearchWorkLoading,
              workLoadingKinds: universalSearchWorkLoadingKinds,
              ...(universalSearchWorkError !== undefined ? { workError: universalSearchWorkError } : {}),
              ...(universalSearchWorkUnsupported ? { workUnsupported: true } : {}),
              ...(universalSearchLoading ? { loading: true } : {}),
              ...(universalSearchCapabilitiesLoading ? { capabilitiesLoading: true } : {}),
              ...(universalSearchCapabilitiesError !== undefined ? { capabilitiesError: universalSearchCapabilitiesError } : {}),
              ...(universalSearchGroups !== undefined
                ? { groups: universalSearchGroups }
                : {}),
              ...(universalSearchDidYouMean !== undefined
                ? { didYouMean: universalSearchDidYouMean }
                : {}),
              ...(universalSearchAbsentWords !== undefined
                ? { absentWords: universalSearchAbsentWords }
                : {}),
              ...(universalSearchRecipes.length > 0
                ? { recipes: universalSearchRecipes }
                : {}),
              ...(universalSearchPacks.length > 0
                ? { packs: universalSearchPacks }
                : {}),
              ...(universalSearchMarket.length > 0
                ? { marketplace: universalSearchMarket }
                : {}),
              ...(universalSearchMarketLoading ? { marketplaceLoading: true } : {}),
              ...(universalSearchMarketError !== undefined
                ? { marketplaceError: universalSearchMarketError }
                : {}),
              ...(opts.marketplacePackSearchCaller !== undefined
                ? { marketplaceOffered: true }
                : {}),
              ...(universalSearchError !== undefined
                ? { error: universalSearchError }
                : {}),
              actionAttr: DATA_ROUTE_ACTION_ATTR,
            }, (opts.now ?? Date.now)())
        : activeTab === 'mail_fact'
          ? mailFacts.render()
        : activeTab === 'reminder'
          ? remindersSurface.render()
        : activeTab === 'records'
          ? renderRecordsExplorer({ ...recordsState, importBusy: recordsImport.hasInFlightWork() }, recordsImport.render())
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
          composeDiscardGuard: memoryComposeDiscardGuardOpen,
          detail: memoryDetail,
          importPanel: memoryImport,
          importDiscardGuard: memoryImportDiscardGuardOpen,
          ...(memoryFilteringOrigin !== null
            ? { filteringOrigin: memoryFilteringOrigin }
            : {}),
          exporting: memoryExporting,
          hasMore: memoryCursor !== null,
          loadingMore: memoryLoadingMore,
          ...(memoryPendingDeleteId !== undefined ? { pendingDeleteId: memoryPendingDeleteId } : {}),
          ...(memoryDeletingId !== null ? { deletingId: memoryDeletingId } : {}),
          ...(memoryDeleteError !== null
            && memoryDeleteError.memoryId === memoryPendingDeleteId
            ? { deleteError: memoryDeleteError.message }
            : {}),
          ...(memoryEditOpeningId !== null
            ? { openingEditId: memoryEditOpeningId }
            : {}),
          ...(memoryEditError !== null ? { editError: memoryEditError } : {}),
          ...(memoryRestoringId !== null ? { restoringId: memoryRestoringId } : {}),
          ...(memoryRestoreError !== null ? { restoreError: memoryRestoreError } : {}),
          canWrite: memoryCanWrite,
        })
      : body;

    const verificationItemReady = (
      activeLogsReturn !== undefined
      && activeLens === 'data'
      && activeTab === runVerificationTargetTab
      && runVerificationTargetEntityId !== null
    )
      ? activeTab === 'contact'
        ? (
            contactDetail?.email === runVerificationTargetEntityId
            && contactDetail.contact !== null
          )
        : isReceivedTab(activeTab)
          ? (
              formResponseDetailId === runVerificationTargetEntityId
              && formResponseDetail !== null
            )
          : activeTab === 'booking'
            ? (
                bookingDetailId === runVerificationTargetEntityId
                && bookingDetail?.entity !== null
                && bookingDetail?.entity !== undefined
              )
            : isWorkEntityTab(activeTab)
              ? (
                  workEntityState.dialog?.mode === 'edit'
                  && workEntityState.dialog.entity_id
                    === runVerificationTargetEntityId
                )
              : isExplorerTab(activeTab) || isSingleCollectionTab(activeTab)
                ? (
                    explorerDetail?.record_id === runVerificationTargetEntityId
                    && (
                      isSingleCollectionTab(activeTab)
                        ? explorerRecords.some(
                            (record) =>
                              record.record_id
                                === runVerificationTargetEntityId,
                          )
                        : explorerDetail.record !== null
                          && explorerDetail.record !== undefined
                    )
                  )
                : activeTab === 'crm'
                  ? timeline?.response !== null
                    && timeline?.response !== undefined
                  : false
      : false;
    const routeReturn = activeLogsReturn !== undefined
      ? renderRunVerificationHandoff(activeLogsReturn)
      : opts.chatReturn !== undefined
        ? `<aside ${DATA_ROUTE_CHAT_RETURN_ATTR} role="note">
            <span>You came here from a cited Chat answer.</span>
            <a href="${e(serializeChatAnswerAddress(opts.chatReturn))}">Back to cited answer</a>
          </aside>`
        : '';
    const verificationItemLoading =
      loading
      || loadingContactDetail
      || loadingFormResponseDetail
      || loadingTimeline
      || loadingBookingDetail
      || loadingWorkEntityDetail
      || explorerLoading
      || explorerDetailRetrying
      || explorerDetail?.loading === true;
    const verificationNext =
      activeLogsReturn?.returnToChat === undefined
        ? ''
        : renderRunVerificationNextSteps(
            activeLogsReturn,
            verificationItemLoading,
            verificationItemReady,
          );
    const markup = `
      ${opts.hideHeading ? '' : `<header class="data-header">
        <h1 class="data-title" ${DATA_ROUTE_HEADING_ATTR}>Data</h1>
      </header>`}
      ${routeReturn}
      ${projectChildReturn && workEntityState.dialog === null
        ? `<p><button type="button" ${DATA_ROUTE_ACTION_ATTR}="return-project-overview">Back to project</button></p>` : ''}
      ${!projectChildReturn && workSearchReturn && workEntityState.dialog === null
        ? `<p><button type="button" ${DATA_ROUTE_ACTION_ATTR}="return-work-search">Back to search</button></p>` : ''}
      ${renderLensSwitcher(
        activeLens,
        DATA_ROUTE_ACTION_ATTR,
        memoryExporting
          || memoryFilteringOrigin !== null
          || hasRecordsInFlightWork(),
      )}
      ${activeLens === 'memory'
        ? ''
        : renderTabs(
            activeTab,
            savingFormResponse
              || formResponseDiscardGuardOpen
              || hasRecordsInFlightWork(),
          )}
      ${loading && activeLens !== 'memory' && activeTab !== 'calendar' ? '<p class="data-loading">Loading data...</p>' : ''}
      ${renderErrors(errors)}
      ${canFacet && (facetHasRecords || dataSphere !== 'all') ? `<label>Sphere (loaded records) <select data-data-sphere aria-label="Data sphere" style="min-height:44px">${[['all', 'All spheres'], ['personal', 'Personal'], ['professional', 'Work'], ['unsorted', 'Unsorted']].map(([value, title]) => `<option value="${value}"${value === dataSphere ? ' selected' : ''}>${title}</option>`).join('')}</select></label>
        ${dataSphere === 'all' ? '' : '<p>This filter applies to loaded records. Load more to find further matches.</p>'}
        ${facetsLoading && dataSphere !== 'all' ? '<p role="status">Reading sphere placements…</p>' : ''}${facetError ? `<p role="status">${e(facetError)}</p>` : ''}` : ''}
      ${activeLens === 'memory'
        ? lensBody
        : `<div ${DATA_ROUTE_TAB_PANEL_ATTR} id="${DATA_ROUTE_TAB_PANEL_ID}"
            role="tabpanel" aria-labelledby="recued-data-tab-${e(activeTab)}">
            ${lensBody}
          </div>`}
      ${verificationNext}
    `;
    const picker = routeRoot.querySelector<HTMLSelectElement>(`[${DATA_ROUTE_COLLECTION_PICKER_ATTR}]`);
    const pickerLabel = picker?.parentElement;
    if (activeLens === 'data' && picker != null && pickerLabel?.parentElement === routeRoot) {
      // Keep the native select connected and focused: replacing it resets its
      // multi-letter typeahead and can close an open platform picker.
      const nextRoot = doc.createElement('div');
      nextRoot.innerHTML = markup;
      const nextPicker = nextRoot.querySelector<HTMLSelectElement>(`[${DATA_ROUTE_COLLECTION_PICKER_ATTR}]`)!;
      const nextLabel = nextPicker.parentElement!;
      for (const child of Array.from(routeRoot.childNodes)) {
        if (child !== pickerLabel) child.remove();
      }
      while (nextRoot.firstChild !== nextLabel) {
        routeRoot.insertBefore(nextRoot.firstChild!, pickerLabel);
      }
      nextLabel.remove();
      routeRoot.append(...nextRoot.childNodes);
      if (picker.value !== activeTab) picker.value = activeTab;
      picker.disabled = nextPicker.disabled;
    } else {
      routeRoot.innerHTML = markup;
    }
    sphereControl?.dispose(); sphereControl = undefined;
    if (opts.spheres && activeLens === 'data') {
      const workId = isWorkEntityTab(activeTab) && workEntityState.dialog?.mode === 'edit' ? workEntityState.dialog.entity_id : activeTab === 'booking' ? bookingDetailId : null;
      const ref = activeTab === 'contact' && contactDetail?.contact
        ? { collection: 'contact', id: contactDetail.contact.contact_id ?? contactDetail.email }
        : workId ? { collection: activeTab, id: workId }
        : (activeTab === 'calendar' || activeTab === 'mail') && explorerDetail?.record && explorerSelectedSlug
          ? { collection: activeTab, id: `${explorerSelectedSlug}:${explorerDetail.record_id}` } : null;
      // In a dialog the control sits above its actions, so Save stays the last stop of its focus loop.
      const dialog = routeRoot.querySelector<HTMLElement>('dialog,[role="dialog"]');
      const actions = dialog?.querySelector<HTMLElement>('.work-entity-dialog-actions, .data-dialog-actions') ?? null;
      const taskContent = dialog?.querySelector<HTMLElement>('.work-entity-task-content, .work-entity-note-content, .work-entity-commitment-content') ?? null;
      if (ref) sphereControl = mountSpherePlacement(taskContent ?? actions?.parentElement ?? dialog ?? routeRoot, ref, {
        read: opts.spheres.read,
        change: async input => { opaqueMutationsInFlight += 1; try { const result = await opts.spheres!.change(input); facetKey = ''; return result; } finally { opaqueMutationsInFlight -= 1; } },
      }, taskContent ? null : actions);
      if (dialog?.classList.contains('work-entity-note-reader')) {
        dialog.querySelector('[data-sphere-placement]')?.setAttribute('data-note-section', 'sphere');
      }
    }
    if (noteScroll) {
      const reader = routeRoot.querySelector<HTMLElement>('.work-entity-note-reader');
      const content = reader?.querySelector<HTMLElement>('.work-entity-note-content');
      if (content && reader?.getAttribute('data-note-id') === noteScroll.id) {
        let focusedSummary: HTMLElement | null = null;
        reader.querySelectorAll<HTMLDetailsElement>('details[data-note-section]').forEach(section => {
          const key = section.getAttribute('data-note-section');
          if (noteSections.has(key)) section.open = noteSections.get(key)!;
          if (key === noteFocusSection) focusedSummary = section.querySelector('summary');
        });
        content.scrollTop = noteScroll.top;
        const focusTarget = noteFocus ? reader.querySelector<HTMLElement>(`[data-action="${noteFocus}"]`)
          : oldNoteFocus?.hasAttribute('data-note-notice') ? reader.querySelector<HTMLElement>('[data-note-notice]')
          : oldNoteFocus?.classList.contains('work-entity-dialog-title') ? reader.querySelector<HTMLElement>('.work-entity-dialog-title')
          : focusedSummary;
        focusTarget?.focus({ preventScroll: true });
      }
    }
    renderedActiveTab = activeTab;
    if (agendaVisible) {
      const disclosure = routeRoot.querySelector?.<HTMLDetailsElement>('details[data-calendar-agenda-sources]');
      if (disclosure) disclosure.open = pendingCalendarAgendaRestore?.sourcesOpen ?? agendaSourcesOpen ?? false;
      const key = pendingCalendarAgendaRestore?.key ?? agendaFocus;
      if (key) {
        const controls = [...routeRoot.querySelectorAll<HTMLElement>(`[${AGENDA_FOCUS}]`)];
        const target = controls.find(control => control.getAttribute(AGENDA_FOCUS) === key);
        agendaFocusFallback = target === undefined;
        (target ?? controls.find(control => control.getAttribute(AGENDA_FOCUS) === 'date'))?.focus({ preventScroll: !agendaFocusFallback });
      }
      pendingCalendarAgendaRestore = null;
    }
    if (activeTab === 'search' && (focusedSearchControl || pendingWorkSearchRestore || pendingContactSearchRestore || pendingAssetSearchRestore)) {
      const origin = pendingWorkSearchRestore;
      const target = Array.from(routeRoot.querySelectorAll<HTMLElement>('.rq-search button, .rq-search a')).find(element => pendingAssetSearchRestore
        ? element.getAttribute(DATA_ROUTE_ACTION_ATTR) === SEARCH_OPEN_ASSET_ACTION
          && element.getAttribute(SEARCH_ASSET_ID_ATTR) === pendingAssetSearchRestore.id
        : pendingContactSearchRestore
        ? element.getAttribute(DATA_ROUTE_ACTION_ATTR) === SEARCH_OPEN_CONTACT_ACTION
          && element.getAttribute(SEARCH_CONTACT_EMAIL_ATTR) === pendingContactSearchRestore.email
        : origin
        ? element.getAttribute(DATA_ROUTE_ACTION_ATTR) === SEARCH_OPEN_WORK_ACTION
          && element.getAttribute(SEARCH_WORK_KIND_ATTR) === origin.kind && element.getAttribute(SEARCH_WORK_ID_ATTR) === origin.id
        : focusedSearchControl?.every(([attribute, value]) => element.getAttribute(attribute) === value));
      (target ?? routeRoot.querySelector<HTMLElement>(`[${SEARCH_INPUT_ATTR}]`))?.focus({ preventScroll: true });
      searchFocusFallback = target === undefined;
      pendingWorkSearchRestore = null; pendingContactSearchRestore = null; pendingAssetSearchRestore = null;
    }
    if (activeElement?.hasAttribute?.('data-data-sphere')) routeRoot.querySelector<HTMLSelectElement>('[data-data-sphere]')?.focus();
    if (opts.savedView !== undefined && currentView() !== null
      && (activeLens === 'memory' ? !memoryLoading : !loading && !explorerLoading && !recordsState.loading)) {
      syncDataHash();
    }
    if (
      focusedContactImportFileOwner
      && activeLens === 'data'
      && activeTab === 'contact'
      && contactImport?.source_id === null
    ) {
      const replacement = (
        contactImport.file?.plan != null
          ? routeRoot.querySelector(
              `[${DATA_ROUTE_ACTION_ATTR}="contact-import-file-apply"]`,
            )
          : contactImport.file?.result != null
            ? routeRoot.querySelector(
                `[${DATA_ROUTE_CONTACT_IMPORT_RESULT_ATTR}]`,
              )
            : null
      ) as HTMLElement | null;
      replacement?.focus?.({ preventScroll: true });
      replacement?.scrollIntoView?.({ block: 'nearest' });
    }
    if (
      focusedContactImportPromoteOwner
      && activeLens === 'data'
      && activeTab === 'contact'
      && contactImport?.source_id != null
    ) {
      const replacement = (
        contactImport.promoting || contactImport.result === null
          ? routeRoot.querySelector(
              `[${DATA_ROUTE_ACTION_ATTR}="contact-import-promote"]`,
            )
          : routeRoot.querySelector(
              `[${DATA_ROUTE_CONTACT_IMPORT_RESULT_ATTR}]`,
            )
      ) as HTMLElement | null;
      replacement?.focus?.({ preventScroll: true });
      replacement?.scrollIntoView?.({ block: 'nearest' });
    }
    if (contactScan !== null && focusedContactScanOwnerKind !== null) {
      focusContactScanOwner(focusedContactScanOwnerKind);
    }
    if (contactScan !== null && focusedContactMergeOwner !== null) {
      focusContactMergeOwner(focusedContactMergeOwner);
    }
    if (
      pendingCollectionTabFocus !== null
      && activeLens === 'data'
      && activeTab === pendingCollectionTabFocus
    ) {
      const replacement = collectionNavigationTarget(pendingCollectionTabFocus);
      replacement?.focus?.({ preventScroll: true });
      if (replacement !== null) pendingCollectionTabFocus = null;
    } else if ((focusedTab !== null || focusedCollectionPicker) && activeLens === 'data') {
      const replacement = collectionNavigationTarget(focusedTab ?? activeTab);
      replacement?.focus?.({ preventScroll: true });
    }
    if (commitmentFocused && activeTab === 'commitment' && workEntityDialogEntity?.id === commitmentFocused.id) {
      const reader = routeRoot.querySelector<HTMLElement>('.work-entity-commitment-reader');
      const target = commitmentFocused.status ? reader?.querySelector<HTMLElement>('[data-commitment-status]')
        : commitmentFocused.notice ? reader?.querySelector<HTMLElement>('[data-commitment-notice]')
        : commitmentFocused.action ? reader?.querySelector<HTMLElement>(`[data-action="${commitmentFocused.action}"]`) : null;
      (target ?? reader?.querySelector<HTMLElement>('[data-commitment-status]'))?.focus?.({ preventScroll: true });
    }
    if (focusedTaskFilter !== null && activeLens === 'data' && (activeTab === 'task' || activeTab === 'commitment')) {
      routeRoot.querySelector<HTMLElement>(`select[${SHARED_ACTION_ATTR}="${focusedTaskFilter}"]`)
        ?.focus?.({ preventScroll: true });
    }
    if (
      pendingUniversalSearchFocus
      && activeLens === 'data'
      && activeTab === 'search'
    ) {
      const box = routeRoot.querySelector?.<HTMLInputElement>(
        `[${SEARCH_INPUT_ATTR}]`,
      );
      box?.focus?.({ preventScroll: true });
      // Cleared only once the box actually existed to take it: the first paint
      // after `selectTab` can precede the search body.
      if (box !== null && box !== undefined) pendingUniversalSearchFocus = false;
    }
    if (
      focusedSearch !== null
      && activeLens === 'data'
      && activeTab === focusedSearch.tab
    ) {
      const replacement = focusedSearch.kind === 'contact'
        ? routeRoot.querySelector<HTMLInputElement>(
            `[${DATA_ROUTE_CONTACT_SEARCH_ATTR}]`,
          )
        : focusedSearch.kind === 'universal'
        ? routeRoot.querySelector?.<HTMLInputElement>(`[${SEARCH_INPUT_ATTR}]`) ?? null
        : focusedSearch.kind === 'cloud-file'
        ? routeRoot.querySelector?.<HTMLInputElement>(`input[${DATA_ROUTE_ACTION_ATTR}="file-cloud-query"]`) ?? null
        : routeRoot.querySelector<HTMLInputElement>(
            `input[${SHARED_ACTION_ATTR}="search-work-entities"]`
            + `[data-kind="${focusedSearch.tab}"]`,
          );
      replacement?.focus?.({ preventScroll: true });
      if (
        replacement !== null
        && focusedSearch.selectionStart !== null
        && focusedSearch.selectionEnd !== null
      ) {
        const valueLength = replacement.value.length;
        replacement.setSelectionRange(
          Math.min(focusedSearch.selectionStart, valueLength),
          Math.min(focusedSearch.selectionEnd, valueLength),
          focusedSearch.selectionDirection ?? undefined,
        );
      }
    }
    if (
      focusedWorkEntityRow !== null
      && activeLens === 'data'
      && activeTab === focusedWorkEntityRow.kind
    ) {
      const replacement = Array.from(routeRoot.querySelectorAll<HTMLElement>(
        `[${SHARED_ACTION_ATTR}="open-edit-work-entity"]`,
      )).find(
        (candidate) =>
          candidate.getAttribute('data-kind') === focusedWorkEntityRow.kind
          && candidate.getAttribute('data-entity-id') === focusedWorkEntityRow.id,
      ) ?? null;
      replacement?.focus?.({ preventScroll: true });
    }
    if (
      focusedWorkEntitySource !== null
      && activeLens === 'data'
      && activeTab === focusedWorkEntitySource
    ) {
      const replacement = routeRoot.querySelector(
        `select[${SHARED_ACTION_ATTR}="select-source"]`,
      ) as HTMLSelectElement | null;
      replacement?.focus?.({ preventScroll: true });
    }
    if (
      focusedWorkEntityDialogSubmit
      && workEntityState.dialog !== null
    ) {
      const replacement = routeRoot.querySelector(
        `[${SHARED_ACTION_ATTR}="submit-work-entity-dialog"]`,
      ) as HTMLElement | null;
      replacement?.focus?.({ preventScroll: true });
    }
    if (focusedContactDialogSubmit && contactDialog !== null) {
      const replacement = routeRoot.querySelector(
        `[${DATA_ROUTE_ACTION_ATTR}="submit-contact-dialog"]`,
      ) as HTMLElement | null;
      replacement?.focus?.({ preventScroll: true });
    }
    if (focusedDraftField !== null) {
      const replacement = Array.from(routeRoot.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
        `[${focusedDraftField.attribute}]`,
      )).find((element) => element.getAttribute(focusedDraftField.attribute) === focusedDraftField.field
        && element.getAttribute('type') !== 'hidden');
      replacement?.focus?.({ preventScroll: true });
      if (replacement !== undefined && typeof replacement.setSelectionRange === 'function'
        && focusedDraftField.selectionStart != null && focusedDraftField.selectionEnd != null) {
        replacement.setSelectionRange(focusedDraftField.selectionStart, focusedDraftField.selectionEnd,
          focusedDraftField.selectionDirection ?? undefined);
      }
    }
    if (
      focusedContactDetailEmail !== null
      && activeLens === 'data'
      && activeTab === 'contact'
      && contactDetail?.email === focusedContactDetailEmail
    ) {
      const replacement = routeRoot.querySelector(
        `[${DATA_ROUTE_CONTACT_DETAIL_HEADING_ATTR}]`,
      ) as HTMLElement | null;
      replacement?.focus?.({ preventScroll: true });
    }
    if (
      pendingContactDetailFocusEmail !== null
      && activeLens === 'data'
      && activeTab === 'contact'
      && contactDetail?.email === pendingContactDetailFocusEmail
      && !loadingContactDetail
    ) {
      pendingContactDetailFocusEmail = null;
      const heading = routeRoot.querySelector(
        `[${DATA_ROUTE_CONTACT_DETAIL_HEADING_ATTR}]`,
      ) as HTMLElement | null;
      heading?.focus?.({ preventScroll: true });
    }
    if (
      pendingContactEditFocusEmail !== null
      && activeLens === 'data'
      && activeTab === 'contact'
      && contactDetail?.email === pendingContactEditFocusEmail
    ) {
      const edit = routeRoot.querySelector(
        `[${DATA_ROUTE_ACTION_ATTR}="open-edit-contact"]`
        + `[${DATA_ROUTE_CONTACT_EMAIL_ATTR}="${CSS.escape(
          pendingContactEditFocusEmail,
        )}"]`,
      ) as HTMLElement | null;
      edit?.focus?.({ preventScroll: true });
      if (openingContactEditEmail !== pendingContactEditFocusEmail) {
        pendingContactEditFocusEmail = null;
      }
    }
    if (
      focusedFormResponseDetailId !== null
      && activeLens === 'data'
      && isReceivedTab(activeTab)
      && formResponseDetailId === focusedFormResponseDetailId
    ) {
      const replacement = routeRoot.querySelector(
        `[${DATA_ROUTE_FORM_RESPONSE_DETAIL_HEADING_ATTR}]`,
      ) as HTMLElement | null;
      replacement?.focus?.({ preventScroll: true });
    }
    if (
      pendingFormResponseDetailFocusId !== null
      && activeLens === 'data'
      && isReceivedTab(activeTab)
      && formResponseDetailId === pendingFormResponseDetailFocusId
      && !loadingFormResponseDetail
    ) {
      pendingFormResponseDetailFocusId = null;
      const target = (
        routeRoot.querySelector(
          `[${DATA_ROUTE_FORM_RESPONSE_DETAIL_HEADING_ATTR}]`,
        )
        ?? routeRoot.querySelector(
          `[${DATA_ROUTE_ACTION_ATTR}="close-form-response"]`,
        )
      ) as HTMLElement | null;
      target?.focus?.({ preventScroll: true });
    }
    const formResponseEditorFocus = pendingFormResponseEditorFocus === null
      ? focusedFormResponseEditor
      : {
          ...pendingFormResponseEditorFocus,
          selectionStart: null,
          selectionEnd: null,
          selectionDirection: null,
        };
    if (
      formResponseEditorFocus !== null
      && activeLens === 'data'
      && isReceivedTab(activeTab)
      && formResponseDetailId === formResponseEditorFocus.submissionId
    ) {
      const selector = formResponseEditorFocus.control === 'values'
        ? `[${DATA_ROUTE_FORM_RESPONSE_VALUES_ATTR}]`
        : formResponseEditorFocus.control === 'email'
          ? `[${DATA_ROUTE_FORM_RESPONSE_EMAIL_ATTR}]`
          : formResponseEditorFocus.control === 'state'
            ? `[${DATA_ROUTE_FORM_RESPONSE_STATE_ATTR}]`
            : `[${DATA_ROUTE_ACTION_ATTR}="save-form-response"]`;
      const replacement = routeRoot.querySelector(selector) as (
        HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | HTMLElement
      ) | null;
      replacement?.focus?.({ preventScroll: true });
      if (
        replacement !== null
        && 'setSelectionRange' in replacement
        && typeof replacement.setSelectionRange === 'function'
        && formResponseEditorFocus.selectionStart !== null
        && formResponseEditorFocus.selectionEnd !== null
      ) {
        const valueLength = replacement.value.length;
        replacement.setSelectionRange(
          Math.min(formResponseEditorFocus.selectionStart, valueLength),
          Math.min(formResponseEditorFocus.selectionEnd, valueLength),
          formResponseEditorFocus.selectionDirection ?? undefined,
        );
      }
      if (
        pendingFormResponseEditorFocus !== null
        && replacement !== null
      ) {
        pendingFormResponseEditorFocus = null;
      } else if (
        pendingFormResponseEditorFocus !== null
        && !loadingFormResponseDetail
      ) {
        const fallback = (
          routeRoot.querySelector(
            `[${DATA_ROUTE_FORM_RESPONSE_DETAIL_HEADING_ATTR}]`,
          )
          ?? routeRoot.querySelector(
            `[${DATA_ROUTE_ACTION_ATTR}="close-form-response"]`,
          )
        ) as HTMLElement | null;
        fallback?.focus?.({ preventScroll: true });
        pendingFormResponseEditorFocus = null;
      }
    }
    if (
      focusedFormResponseExportFormat !== null
      && activeLens === 'data'
      && isReceivedTab(activeTab)
      && formResponseDetailId === null
    ) {
      const replacement = routeRoot.querySelector(
        `[${DATA_ROUTE_ACTION_ATTR}="export-form-responses"]`
        + `[data-format="${focusedFormResponseExportFormat}"]`,
      ) as HTMLElement | null;
      replacement?.focus?.({ preventScroll: true });
    }
    if (
      pendingFormResponseAutomationPickerFocus
      && activeLens === 'data'
      && isReceivedTab(activeTab)
      && formResponseDetailId !== null
    ) {
      const automationStatus = formResponseAutomationState.status;
      const picker = automationStatus === 'ready' || automationStatus === 'error'
        ? routeRoot.querySelector(
            `[${DATA_ROUTE_FORM_RESPONSE_RUN_PICKER_ATTR}="${automationStatus}"]`,
          )
        : null;
      const target = (automationStatus === 'loading'
        ? routeRoot.querySelector(`[${DATA_ROUTE_FORM_RESPONSE_RUN_ATTR}]`)
        : automationStatus === 'ready'
          ? picker?.querySelector('h3') ?? null
          : automationStatus === 'error'
            ? picker?.querySelector(
                `[${DATA_ROUTE_ACTION_ATTR}="discover-form-response-automations"]`,
              ) ?? null
            : null) as HTMLElement | null;
      if (target !== null) {
        target.focus({ preventScroll: true });
        if (automationStatus !== 'loading') {
          pendingFormResponseAutomationPickerFocus = false;
          target.scrollIntoView({ block: 'nearest' });
        }
      }
    }
    if (
      focusedTimelineTrigger
      && activeLens === 'data'
      && isMirrorTab(activeTab)
    ) {
      const replacement = routeRoot.querySelector(
        `[${DATA_ROUTE_ACTION_ATTR}="load-timeline"]`,
      ) as HTMLElement | null;
      replacement?.focus?.({ preventScroll: true });
    }
    if (
      focusedTimelineEntityInput !== null
      && activeLens === 'data'
      && isMirrorTab(activeTab)
    ) {
      const replacement = routeRoot.querySelector<HTMLInputElement>(
        `[${DATA_ROUTE_TIMELINE_ENTITY_ATTR}]`,
      );
      replacement?.focus?.({ preventScroll: true });
      if (
        replacement !== null
        && focusedTimelineEntityInput.selectionStart !== null
        && focusedTimelineEntityInput.selectionEnd !== null
      ) {
        const valueLength = replacement.value.length;
        replacement.setSelectionRange(
          Math.min(focusedTimelineEntityInput.selectionStart, valueLength),
          Math.min(focusedTimelineEntityInput.selectionEnd, valueLength),
          focusedTimelineEntityInput.selectionDirection ?? undefined,
        );
      }
    }
    if (
      focusedFileDownloadId !== null
      && activeLens === 'data'
      && activeTab === 'files'
      && explorerDetail?.record_id === focusedFileDownloadId
    ) {
      const replacement = routeRoot.querySelector(
        `[${DATA_ROUTE_DOWNLOAD_FILE_ATTR}]`,
      ) as HTMLElement | null;
      replacement?.focus?.({ preventScroll: true });
    }
    if (
      focusedRescheduleControl !== null
      && activeLens === 'data'
      && activeTab === 'calendar'
      && explorerDetail?.record_id === focusedRescheduleControl.recordId
      && (
        (
          focusedRescheduleControl.action === 'reschedule-open'
          && rescheduleForm === null
        )
        || (
          focusedRescheduleControl.action !== 'reschedule-open'
          && rescheduleForm !== null
        )
      )
    ) {
      const replacement = routeRoot.querySelector?.(
        `[${DATA_ROUTE_ACTION_ATTR}="${focusedRescheduleControl.action}"]`,
      ) as HTMLElement | null | undefined;
      replacement?.focus?.({ preventScroll: true });
    }
    if (
      pendingRescheduleOpenFocusId !== null
      && activeLens === 'data'
      && activeTab === 'calendar'
      && explorerDetail?.record_id === pendingRescheduleOpenFocusId
      && explorerDetail.loading === false
      && rescheduleForm === null
    ) {
      const replacement = routeRoot.querySelector?.(
        `[${DATA_ROUTE_ACTION_ATTR}="reschedule-open"]`,
      ) as HTMLElement | null | undefined;
      replacement?.focus?.({ preventScroll: true });
      if (replacement != null) pendingRescheduleOpenFocusId = null;
    }
    if (focusedExplorerSlug !== null && activeLens === 'data') {
      const replacement = Array.from(
        routeRoot.querySelectorAll<HTMLElement>(
          `[${COLLECTION_INSTANCE_SLUG_ATTR}]`,
        ),
      ).find(
        (candidate) =>
          candidate.getAttribute(COLLECTION_INSTANCE_SLUG_ATTR)
            === focusedExplorerSlug,
      );
      replacement?.focus?.({ preventScroll: true });
    }
    if (
      pendingExplorerRetryFocus !== null
      && activeLens === 'data'
      && activeTab === pendingExplorerRetryFocus
    ) {
      const retry = routeRoot.querySelector(
        `[${COLLECTION_RETRY_ATTR}]`,
      ) as HTMLElement | null;
      if (explorerRetrying) {
        retry?.focus?.({ preventScroll: true });
      } else {
        const selectedSource = explorerSelectedSlug === null
          ? null
          : Array.from(routeRoot.querySelectorAll<HTMLElement>(
              `[${COLLECTION_INSTANCE_SLUG_ATTR}]`,
            )).find(
              (candidate) => candidate.getAttribute(
                COLLECTION_INSTANCE_SLUG_ATTR,
              ) === explorerSelectedSlug,
            ) ?? null;
        const tab = collectionNavigationTarget(activeTab);
        (retry ?? selectedSource ?? tab)?.focus?.({ preventScroll: true });
        pendingExplorerRetryFocus = null;
      }
    }
    if (
      pendingExplorerDetailRetryFocus !== null
      && activeLens === 'data'
      && activeTab === pendingExplorerDetailRetryFocus.tab
      && explorerDetail?.record_id
        === pendingExplorerDetailRetryFocus.recordId
    ) {
      const retry = routeRoot.querySelector(
        `[${COLLECTION_DETAIL_RETRY_ATTR}]`,
      ) as HTMLElement | null;
      if (explorerDetailRetrying) {
        retry?.focus?.({ preventScroll: true });
      } else {
        const target = (
          retry
          ?? routeRoot.querySelector(`[${COLLECTION_DETAIL_HEADING_ATTR}]`)
          ?? routeRoot.querySelector(
            `[${DATA_ROUTE_ACTION_ATTR}="${COLLECTION_DETAIL_CLOSE_ACTION}"]`,
          )
        ) as HTMLElement | null;
        target?.focus?.({ preventScroll: true });
        pendingExplorerDetailRetryFocus = null;
      }
    }
    if (
      focusedExplorerDetailId !== null
      && explorerDetail?.record_id === focusedExplorerDetailId
      && activeLens === 'data'
    ) {
      const replacement = routeRoot.querySelector(
        `[${COLLECTION_DETAIL_HEADING_ATTR}]`,
      ) as HTMLElement | null;
      replacement?.focus?.({ preventScroll: true });
    }
    if (
      pendingExplorerRecordFocus !== null
      && pendingExplorerRecordFocus.tab === activeTab
      && explorerDetail?.record_id === pendingExplorerRecordFocus.recordId
      && explorerDetail.loading === false
    ) {
      pendingExplorerRecordFocus = null;
      const target = (
        routeRoot.querySelector(`[${COLLECTION_DETAIL_HEADING_ATTR}]`)
        ?? routeRoot.querySelector(
          `[${DATA_ROUTE_ACTION_ATTR}="${COLLECTION_DETAIL_CLOSE_ACTION}"]`,
        )
      ) as HTMLElement | null;
      target?.focus?.({ preventScroll: true });
    }
    if (pendingContactLoadMoreFocus) {
      const loadMore = routeRoot.querySelector?.(
        `[${DATA_ROUTE_ACTION_ATTR}="load-more-contacts"]`,
      ) as HTMLElement | null | undefined;
      if (loadingMoreContacts) {
        loadMore?.focus?.({ preventScroll: true });
      } else {
        const appendedContact = pendingLoadedContactEmail === null
          ? null
          : Array.from(routeRoot.querySelectorAll<HTMLElement>(
              `[${DATA_ROUTE_ACTION_ATTR}="open-contact-detail"]`,
            )).find(
              (candidate) =>
                candidate.getAttribute(DATA_ROUTE_CONTACT_EMAIL_ATTR)
                === pendingLoadedContactEmail,
            ) ?? null;
        const fallback = collectionNavigationTarget('contact');
        (loadMore ?? appendedContact ?? fallback)?.focus?.({ preventScroll: true });
        pendingContactLoadMoreFocus = false;
        pendingLoadedContactEmail = null;
      }
    }
    if (
      pendingWorkEntityLoadMoreFocusKind !== null
      && activeLens === 'data'
      && activeTab === pendingWorkEntityLoadMoreFocusKind
    ) {
      const loadMore = routeRoot.querySelector?.(
        `[${DATA_ROUTE_ACTION_ATTR}="load-more-work-entities"]`,
      ) as HTMLElement | null | undefined;
      if (loadingMoreWorkEntities) {
        loadMore?.focus?.({ preventScroll: true });
      } else {
        const appendedEntity = Array.from(
          routeRoot.querySelectorAll<HTMLElement>(
            `[${SHARED_ACTION_ATTR}="open-edit-work-entity"],`
            + `[${SHARED_ACTION_ATTR}="open-work-entity-detail"]`,
          ),
        ).find((candidate) => pendingLoadedWorkEntityKeys.some(
          (key) =>
            candidate.getAttribute('data-kind') === key.kind
            && candidate.getAttribute('data-entity-id') === key.id,
        )) ?? null;
        const search = routeRoot.querySelector?.(
          `input[${SHARED_ACTION_ATTR}="search-work-entities"]`
          + `[data-kind="${pendingWorkEntityLoadMoreFocusKind}"]`,
        ) as HTMLElement | null | undefined;
        const fallback = collectionNavigationTarget(pendingWorkEntityLoadMoreFocusKind);
        (loadMore ?? appendedEntity ?? search ?? fallback)?.focus?.({
          preventScroll: true,
        });
        pendingWorkEntityLoadMoreFocusKind = null;
        pendingLoadedWorkEntityKeys = [];
      }
    }
    if (
      pendingFormResponseLoadMoreFocus
      && activeLens === 'data'
      && isReceivedTab(activeTab)
    ) {
      const loadMore = routeRoot.querySelector?.(
        `[${DATA_ROUTE_ACTION_ATTR}="load-more-form-responses"]`,
      ) as HTMLElement | null | undefined;
      if (loadingMoreFormResponses) {
        loadMore?.focus?.({ preventScroll: true });
      } else {
        const appendedResponse = Array.from(
          routeRoot.querySelectorAll<HTMLElement>(
            `[${DATA_ROUTE_ACTION_ATTR}="open-form-response"]`,
          ),
        ).find((candidate) => pendingLoadedFormResponseIds.includes(
          candidate.getAttribute(DATA_ROUTE_FORM_RESPONSE_ID_ATTR) ?? '',
        )) ?? null;
        const fallback = collectionNavigationTarget('form_response');
        (loadMore ?? appendedResponse ?? fallback)?.focus?.({
          preventScroll: true,
        });
        pendingFormResponseLoadMoreFocus = false;
        pendingLoadedFormResponseIds = [];
      }
    }
    if (activeLens === 'data' && activeTab === 'task') taskBulk.restoreFocus(routeRoot, focusedTaskBulk);
    if (activeLens === 'data' && activeTab === 'mail_fact') {
      mailFacts.restoreFocus(routeRoot, focusedMailFactsKey);
    }
    if (activeLens === 'data' && activeTab === 'reminder') {
      remindersSurface.restoreFocus(routeRoot, focusedRemindersKey);
    }
    if (activeLens === 'data' && activeTab === 'calendar') calendarEventSurface.restoreFocus(routeRoot, focusedCalendarEvent);
    if (activeLens === 'data' && activeTab === 'calendar') calendarCreateSurface.restoreFocus(routeRoot, focusedCalendarCreate);
    if (activeLens === 'data' && activeTab === 'mail') {
      mailMessageSurface.restoreScroll(routeRoot, mailIndexScroll);
      mailMessageSurface.restoreFocus(routeRoot, focusedMailMessage);
    }
    if (activeLens === 'data' && activeTab === 'files' && focusedFileLifecycleKey !== null) {
      const panel = routeRoot.querySelector<HTMLElement>('[data-file-lifecycle]');
      const notice = routeRoot.querySelector<HTMLElement>('[data-file-lifecycle-notice]');
      const target = focusedFileLifecycleKey === 'panel' || focusedFileLifecycleKey === 'file-usage' ? panel ?? notice
        : focusedFileLifecycleKey === 'notice' ? notice
        : routeRoot.querySelector<HTMLElement>(`[${DATA_ROUTE_ACTION_ATTR}="${focusedFileLifecycleKey}"]:not(:disabled)`) ?? panel ?? notice;
      target?.focus({ preventScroll: focusedFileLifecycleKey !== 'file-usage' && !(target === notice && focusedFileLifecycleKey !== 'notice') });
    }
    // Attach live pickers to any `data.contact` ref shells the work-entity
    // dialog just painted (no-op otherwise).
    mountWorkEntityRefPickers();
    // Attach (or rewire) the Files-tab upload widget (no-op elsewhere).
    mountUploadWidget();
    if (memoryFilteringOrigin !== null) {
      focusMemoryOriginFilter(memoryFilteringOrigin);
    } else if (memoryExporting) {
      focusMemoryExport();
    } else if (memoryDeletingId !== null) {
      focusMemoryDeleteConfirm(memoryDeletingId);
    } else if (memoryEditOpeningId !== null) {
      focusMemoryEditAction(memoryEditOpeningId);
    } else if (memoryImportDiscardGuardOpen) {
      focusMemoryImportDiscardGuard();
    } else if (memoryComposeDiscardGuardOpen) {
      focusMemoryComposeDiscardGuard();
    } else if (formResponseDiscardGuardOpen) {
      focusFormResponseDiscardGuard();
    } else if (contactDiscardGuardOpen) {
      focusContactDiscardGuard();
    } else if (workEntityDiscardGuardOpen) {
      focusWorkEntityDiscardGuard();
    }
    if (
      pendingFormResponseDiscardTabFocus !== null
      && activeLens === 'data'
      && activeTab === pendingFormResponseDiscardTabFocus
    ) {
      focusDataTab(pendingFormResponseDiscardTabFocus);
      if (!loading) pendingFormResponseDiscardTabFocus = null;
    }
    if (activeTab === 'search' && searchScrollTop !== undefined) {
      const scrollHost = workSearchScrollHost();
      if (scrollHost) scrollHost.scrollTop = searchScrollTop;
      const owner = doc.activeElement as HTMLElement | null;
      if ((owner?.tagName === 'BUTTON' || searchFocusFallback || revealAssetSearchFocus) && owner?.closest?.('.rq-search')) owner.scrollIntoView?.({ block: 'nearest' });
    }
    if (agendaVisible && agendaScroll !== undefined && !agendaFocusFallback) {
      const host = workSearchScrollHost();
      if (host) host.scrollTop = agendaScroll;
    }
    if (projectRead) {
      const target = projectFocus ? Array.from(routeRoot.querySelectorAll<HTMLElement>('[data-project-focus]')).find(node => node.getAttribute('data-project-focus') === projectFocus)
        ?? routeRoot.querySelector<HTMLElement>('[data-project-focus="heading"]') : undefined;
      target?.focus({ preventScroll: true });
      const host = workSearchScrollHost();
      if (host && projectScroll !== undefined) host.scrollTop = projectScroll;
      if (target) target.scrollIntoView?.({ block: 'nearest' });
      pendingProjectRestore = null;
    }
    if (activeLens === 'data' && activeTab === 'mail' && mailScrollTop !== undefined) {
      const host = workSearchScrollHost();
      if (host) host.scrollTop = mailScrollTop;
    }
    opts.onViewChange?.(currentView());
  };

  /** An exact run → Data address should land keyboard and screen-reader users
   * on the record they came to verify, after every initial async paint (including
   * the optional calendar timeline) has settled. */
  const focusInitialVerificationTarget = (): void => {
    if (
      !pendingInitialVerificationFocus
      || activeLogsReturn === undefined
      || activeTab !== runVerificationTargetTab
      || explorerDetail?.record_id !== runVerificationTargetEntityId
      || explorerDetail.record === null
      || explorerDetail.record === undefined
    ) return;
    const queryable = routeRoot as unknown as {
      querySelector?: (selectors: string) => HTMLElement | null;
    };
    const heading =
      queryable.querySelector?.(`[${COLLECTION_DETAIL_HEADING_ATTR}]`) ?? null;
    if (heading === null) return;
    pendingInitialVerificationFocus = false;
    heading.focus?.({ preventScroll: true });
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
      nextErrors.sources = 'Recued cannot list sources here.';
      return;
    }
    try {
      const response = await opts.workEntitySourceListCaller();
      if (disposed || generation !== loadGeneration) return;
      sources = [...response.sources];
    } catch (err) {
      if (disposed || generation !== loadGeneration) return;
      sources = [];
      defaultsByKind = {};
      nextErrors.sources = errMessage(err);
    }
  };

  // Shared request shape for the initial/replace fetch (offset 0) + the
  // load-more append. Tasks and bookings filter before pagination. Task dates
  // and search stay fixed across pages until the next full refresh.
  const workEntityListRequest = (offset: number): WorkEntityListRpcRequest => {
    const request: WorkEntityListRpcRequest = {
      kind: workEntityState.kind,
      limit: DEFAULT_LIMIT,
    };
    if (offset > 0) request.offset = offset;
    if (workEntityState.selected_source_id !== null) {
      request.source_id = workEntityState.selected_source_id;
    }
    if (workEntityState.kind === 'task') {
      request.task_filter = taskListFilter;
      if (taskListSearch.length > 0) request.search = taskListSearch;
    }
    if (workEntityState.kind === 'commitment') {
      request.commitment_filter = commitmentListFilter;
      if (commitmentListSearch) request.search = commitmentListSearch;
    }
    if (workEntityState.kind === 'booking') {
      const search = workEntityState.search_query.trim();
      if (search.length > 0) request.search = search;
      if (bookingLifecycleFilter !== 'all') {
        request.booking_lifecycle_states = [bookingLifecycleFilter];
      }
    }
    return request;
  };

  const refreshWorkEntities = async (
    nextErrors: DataLoadErrors,
    generation: number,
  ): Promise<void> => {
    // Retain the exact saved Source even after it disconnects. A select with no
    // matching option must not show All while the query still names that Source.
    const selectedSource = workEntityState.selected_source_id;
    if (opts.savedView !== undefined && selectedSource !== null && !sourceOptionsForKind(sources, workEntityState.kind).some((source) => source.id === selectedSource)) {
      workEntities = [];
      workEntityTotal = 0;
      nextErrors.work_entities = 'The source you picked is gone. Choose another one to carry on.';
      return;
    }
    if (opts.workEntityListCaller === undefined) {
      workEntities = [];
      workEntityTotal = 0;
      nextErrors.work_entities = 'Recued cannot list items here.';
      return;
    }
    try {
      const response = await opts.workEntityListCaller(workEntityListRequest(0));
      if (disposed || generation !== loadGeneration) return;
      workEntities = [...response.entities];
      workEntityTotal = response.total;
      if (response.counterparty_labels) commitmentContactLabels = { ...commitmentContactLabels, ...response.counterparty_labels };
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
    if (activeTab === 'commitment' && (commitmentListSearch !== workEntityState.search_query.trim()
      || commitmentListFilter.direction !== commitmentViewFilters.direction || commitmentListFilter.status !== commitmentViewFilters.status)) return;
    if (loadingMoreWorkEntities || workEntities.length >= workEntityTotal) return;
    const generation = loadGeneration;
    loadingMoreWorkEntities = true;
    render();
    try {
      const response = await opts.workEntityListCaller(
        workEntityListRequest(workEntities.length),
      );
      if (disposed || generation !== loadGeneration) return;
      const knownKeys = new Set(
        workEntities.map((entity) => `${entity._kind}\u0000${entity.id}`),
      );
      pendingLoadedWorkEntityKeys = pendingWorkEntityLoadMoreFocusKind === null
        ? []
        : response.entities
            .filter(
              (entity) => !knownKeys.has(`${entity._kind}\u0000${entity.id}`),
            )
            .map((entity) => ({ kind: entity._kind, id: entity.id }));
      workEntities = [...workEntities, ...response.entities];
      workEntityTotal = response.total;
      if (response.counterparty_labels) commitmentContactLabels = { ...commitmentContactLabels, ...response.counterparty_labels };
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
      request.query = contactSearch.trim();
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
      nextErrors.contacts = 'Recued cannot list contacts here.';
      return;
    }
    try {
      const response = await opts.contactListCaller(
        { ...contactListRequest(0), with_rollups: true });
      if (disposed || generation !== loadGeneration) return;
      contacts = [...response.contacts];
      contactTotal = response.total;
      // ⚠ Replaced, never merged. A stale map beside fresh rows would draw the
      // previous search's numbers against the current one's names.
      contactRollups = response.rollups;
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
      const response = await opts.contactListCaller(
        { ...contactListRequest(contacts.length), with_rollups: true });
      if (disposed || generation !== loadGeneration) return;
      const knownEmails = new Set(contacts.map((contact) => contact.email));
      pendingLoadedContactEmail = pendingContactLoadMoreFocus
        ? response.contacts.find(
            (contact) => !knownEmails.has(contact.email),
          )?.email ?? null
        : null;
      contacts = [...contacts, ...response.contacts];
      contactTotal = response.total;
      // ⛔ MERGED here, replaced on refresh — the two paths differ because the
      // ROWS differ. Load-more appends rows and must append their rollups; not
      // asking for them at all (the easy miss) would leave page 2 chip-less
      // beside a chipped page 1, which reads as "these clients owe nothing".
      contactRollups = { ...(contactRollups ?? {}), ...(response.rollups ?? {}) };
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
      nextErrors.form_responses = 'Recued cannot list answers here.';
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
      pendingLoadedFormResponseIds = pendingFormResponseLoadMoreFocus
        ? response.responses
            .filter((row) => !known.has(row.submission_id))
            .map((row) => row.submission_id)
        : [];
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
  /** Append the next page of the memory feed.
   *
   *  ⚠ APPENDS, never replaces — `refreshMemory` owns the replace path, and a
   *  Load-more that replaced would silently drop everything already on screen.
   *
   *  ⚠ Guarded on BOTH the generation and the in-flight flag: a second click
   *  while the first is outstanding would page twice from the same cursor and
   *  duplicate a page into the list. */
  const loadMoreMemory = async (): Promise<void> => {
    if (opts.memoryListCaller === undefined) return;
    if (memoryLoadingMore || memoryCursor === null) return;
    const generation = ++loadGeneration;
    const cursor = memoryCursor;
    memoryLoadingMore = true;
    render();
    try {
      const actors = memoryFilterActors(memoryOriginFilter);
      const response = await opts.memoryListCaller({
        ...(actors ? { origin_actors: actors } : {}),
        limit: DEFAULT_LIMIT,
        cursor,
      });
      if (disposed || generation !== loadGeneration) return;
      memoryEntries = [...memoryEntries, ...response.entries];
      memoryCursor = response.next_cursor ?? null;
      memoryError = undefined;
    } catch (err) {
      if (disposed || generation !== loadGeneration) return;
      // ⚠ The already-loaded entries STAY. A failed page-2 is not a reason to
      // empty a list the owner is reading; the error names the failure and the
      // cursor is kept so the retry resumes from the same place.
      memoryError = humanizeRpcError(err);
    } finally {
      if (!disposed && generation === loadGeneration) {
        memoryLoadingMore = false;
        render();
      }
    }
  };

  const refreshMemory = async (generation: number): Promise<void> => {
    if (opts.memoryListCaller === undefined) {
      memoryEntries = [];
      memoryError = 'Recued cannot list memories here.';
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
      memoryCursor = response.next_cursor ?? null;
      memoryError = undefined;
    } catch (err) {
      if (disposed || generation !== loadGeneration) return;
      memoryEntries = [];
      // ⚠ Cleared with the entries. A stale cursor beside an empty list offers
      // a "Load more" that pages from a feed the user is no longer looking at.
      memoryCursor = null;
      memoryError = humanizeRpcError(err);
    }
  };

  // ── D-198 Slice 5 — collection explorer (mail / calendar) ─────────────────

  const refreshCalendarAgenda = async (silent: boolean, slug?: string, sourcesOnly = false): Promise<void> => {
    const seq = ++explorerSeq;
    explorerCollection = 'calendar';
    if (slug !== undefined) calendarAgenda.selectSource(slug);
    await calendarAgenda.refresh({ silent, sourcesOnly });
    if (disposed || seq !== explorerSeq) return;
    explorerInstances = calendarAgenda.snapshot().sources.map(source => source.instance);
    const selected = slug ?? initialExplorerSlug ?? (calendarAgenda.selectedSource() || null);
    initialExplorerSlug = null;
    if (pendingExplorerVerificationTab === 'calendar' && pendingExplorerVerificationRecordId !== null
      && !selected && explorerInstances.length > 1) {
      const resolution = await resolveExplorerVerification('calendar', explorerInstances, pendingExplorerVerificationRecordId);
      if (disposed || seq !== explorerSeq) return;
      explorerSelectedSlug = resolution.kind === 'match' ? resolution.slug : null;
      explorerError = resolution.kind === 'match' ? undefined : resolution.message;
      explorerRecords = [];
      explorerLoading = false;
      return;
    }
    explorerSelectedSlug = selected && calendarAgenda.snapshot().error ? selected
      : selected && explorerInstances.some(source => source.slug === selected) ? selected
      : selected ? null : explorerInstances.length === 1 ? explorerInstances[0]!.slug : null;
    explorerRecords = calendarAgenda.snapshot().sources.find(source => source.instance.slug === explorerSelectedSlug)?.records ?? [];
    explorerLoading = false;
    if (selected && explorerSelectedSlug === null && !calendarAgenda.snapshot().error) explorerError = 'The source this record came from is gone.';
    else explorerError = undefined;
  };

  /** Fetch `(platform, slug)` records into `explorerRecords`. Guarded on
   *  `explorerSeq` (the caller bumps it) so a stale response is dropped. */
  const fetchExplorerRecords = async (
    platform: CollectionPlatform,
    slug: string,
    seq: number,
  ): Promise<void> => {
    const sourceId = platform === 'file' ? cloudFileSourceId(slug) : undefined;
    const caller = opts.collectionListCaller;
    cloudFileCursor = undefined; cloudBrowseError = ''; cloudLoadingMore = false;
    cloudFilePage = 1;
    if (caller === undefined && !(sourceId && opts.fileChatCallers?.cloud)) {
      explorerRecords = [];
      return;
    }
    try {
      const response = sourceId && opts.fileChatCallers?.cloud
        ? await opts.fileChatCallers.cloud.list({ source_id: sourceId, query: cloudFileQuery, limit: 30 })
        : await caller!({ platform, slug, limit: DEFAULT_LIMIT,
          ...(platform === 'file' && slug === 'received' && showArchivedFiles ? { filters: { archived: 1 } } : {}) });
      if (disposed || seq !== explorerSeq) return;
      explorerRecords = 'files' in response ? response.files.map(file => cloudFileRecord(file, sourceId!)) : response.records;
      cloudFileCursor = 'next_cursor' in response ? response.next_cursor : undefined;
      explorerError = undefined;
      explorerErrorRetryable = false;
    } catch (err) {
      if (disposed || seq !== explorerSeq) return;
      explorerRecords = [];
      // A server with no database registers no saved-files collection: that is
      // nothing saved yet, not a failure to show.
      if (slug === SAVED_FILES_SLUG && (err as { code?: unknown } | null)?.code === 'COLLECTION_NOT_FOUND') {
        explorerError = undefined;
        explorerErrorRetryable = false;
        return;
      }
      explorerError = humanizeRpcError(err);
      explorerErrorRetryable = true;
    }
  };

  /** Keep the explorer over one file family without claiming remote pointers
   * are retained collection records. Exact reads use the same selection service
   * as the Chat picker and never fetch bytes. */
  const getExplorerRecord: DataCollectionGetCaller = async args => {
    const sourceId = args.platform === 'file' ? cloudFileSourceId(args.slug) : undefined;
    if (sourceId) {
      if (!args.record_id.startsWith('file:remote:')) return { record: null };
      const cloud = opts.fileChatCallers?.cloud;
      if (!cloud) throw new Error('This server cannot reach files you have connected.');
      const file = await cloud.get({ record_id: args.record_id });
      return { record: file.source_id === sourceId ? cloudFileRecord(file, sourceId) : null };
    }
    if (args.platform === 'file' && args.record_id.startsWith('file:remote:')) return { record: null };
    if (!opts.collectionGetCaller) throw new Error('Recued cannot open records here.');
    return opts.collectionGetCaller(args);
  };

  /** A search REPLACES the list, so it supersedes any list read in flight: the
   *  `explorerSeq` bump drops that read's answer. A page walk CONTINUES the list
   *  on screen, so it waits for that list.
   *
   *  ⛔ A search used to wait as well, by returning before it kept the query. An
   *  Enter pressed while a source's first page loaded left the owner's search in
   *  the box over a list that ignored it, and "Load more" then paged the OLD
   *  query: 36 rows for a search that matches 35. */
  const browseCloudFiles = async (append: boolean): Promise<void> => {
    const slug = explorerSelectedSlug;
    const sourceId = slug ? cloudFileSourceId(slug) : undefined;
    const cloud = opts.fileChatCallers?.cloud;
    if (activeTab !== 'files' || !sourceId || !cloud) return;
    if (append && (explorerLoading || cloudLoadingMore || !cloudFileCursor)) return;
    if (!append) cloudFileQuery = cloudFileQueryInput.trim();
    const seq = ++explorerSeq;
    if (!append) { explorerLoading = true; explorerDetail = null; cloudLoadingMore = false; }
    else cloudLoadingMore = true;
    cloudBrowseError = ''; render();
    try {
      if (!append) { await fetchExplorerRecords('file', slug!, seq); return; }
      const result = await cloud.list({ source_id: sourceId, query: cloudFileQuery, limit: 30, cursor: cloudFileCursor });
      if (disposed || seq !== explorerSeq) return;
      const seen = new Set(explorerRecords.map(file => file.record_id));
      explorerRecords.push(...result.files.filter(file => !seen.has(file.record_id)).map(file => cloudFileRecord(file, sourceId)));
      cloudFileCursor = result.next_cursor;
      cloudFilePage++;
    } catch (error) {
      if (!disposed && seq === explorerSeq) cloudBrowseError = humanizeRpcError(error);
    } finally {
      if (!disposed && seq === explorerSeq) { explorerLoading = false; cloudLoadingMore = false; render(); }
    }
  };

  /** D-198 Phase 2/3 — load a single-collection tab (annotation / link / shared):
   *  one whole-collection `list` (no instances), entries mapped into the explorer
   *  shape. The list ships full records, so there is no separate lazy `get`. */
  const loadSingleCollection = async (tab: DataSingleCollectionTabId): Promise<void> => {
    explorerLiveRefreshPending = false;
    const seq = ++explorerSeq;
    explorerCollection = tab as CanonicalCollectionName; // schema key === tab id
    explorerInstances = [];
    explorerSelectedSlug = null;
    explorerDetail = null;
    explorerDetailRetryable = false;
    explorerDetailRetrying = false;
    pendingExplorerDetailRetryFocus = null;
    if (!explorerRetrying) {
      explorerError = undefined;
      explorerErrorRetryable = false;
    }
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
        explorerError = 'Recued cannot show this here.';
        explorerErrorRetryable = false;
      } else {
        explorerRecords = records;
        explorerError = undefined;
        explorerErrorRetryable = false;
      }
    } catch (err) {
      if (disposed || seq !== explorerSeq) return;
      explorerRecords = [];
      explorerError = humanizeRpcError(err);
      explorerErrorRetryable = true;
    } finally {
      if (!disposed && seq === explorerSeq) explorerLoading = false;
    }
  };

  type ExplorerVerificationResolution =
    | { readonly kind: 'match'; readonly slug: string }
    | { readonly kind: 'choose'; readonly message: string }
    | { readonly kind: 'missing'; readonly message: string };

  /** Resolve a provenance record id across account instances without guessing.
   * `collection.get` is the only exact read available for a source record. A
   * partial probe failure or duplicate match deliberately falls back to the
   * visible source picker instead of choosing a potentially wrong account. */
  const resolveExplorerVerification = async (
    platform: CollectionPlatform,
    instances: ReadonlyArray<CollectionInstanceRow>,
    recordId: string,
  ): Promise<ExplorerVerificationResolution> => {
    const caller = opts.collectionGetCaller || opts.fileChatCallers?.cloud ? getExplorerRecord : undefined;
    if (caller === undefined) {
      return {
        kind: 'choose',
        message:
          'Pick the connected source that might have this item, so Recued can check it.',
      };
    }
    const probes = await Promise.all(instances.map(async (instance) => {
      try {
        const { record } = await caller({
          platform,
          slug: instance.slug,
          record_id: recordId,
        });
        return {
          slug: instance.slug,
          matched: record !== null,
          failed: false,
        };
      } catch {
        return {
          slug: instance.slug,
          matched: false,
          failed: true,
        };
      }
    }));
    const matches = probes.filter((probe) => probe.matched);
    const hasFailure = probes.some((probe) => probe.failed);
    if (matches.length === 1 && !hasFailure) {
      return { kind: 'match', slug: matches[0]!.slug };
    }
    if (matches.length > 1) {
      return {
        kind: 'choose',
        message:
          'More than one connected source has this id. Pick the one you want Recued to check.',
      };
    }
    if (hasFailure) {
      return {
        kind: 'choose',
        message:
          'Recued could not check every connected source. Pick one for it to check.',
      };
    }
    return {
      kind: 'missing',
      message:
        'Recued cannot find this item in your Data. It may have been deleted, or it may not have been brought in yet.',
    };
  };

  /** Load an explorer tab: list its instances, auto-select the sole one (or wait
   *  for a pick), then fetch its records. Called from `refreshActive`; the outer
   *  generation guard there paints the result. */
  const loadExplorer = async (tab: DataTabId, preferredSourceSlug?: string): Promise<void> => {
    explorerLiveRefreshPending = false;
    if (isSingleCollectionTab(tab)) return loadSingleCollection(tab);
    const platform = EXPLORER_TAB_PLATFORM[tab];
    const seq = ++explorerSeq;
    const requestedSlug = preferredSourceSlug ?? initialExplorerSlug ?? savedExplorerScopes.get(tab) ?? null;
    initialExplorerSlug = null;
    const previouslySelectedSlug = explorerSelectedSlug;
    // Keep the intended source through a failed roster read, so Retry cannot
    // silently select a different account. Membership is checked after loading.
    if (requestedSlug !== null) explorerSelectedSlug = requestedSlug;
    // The display schema is keyed on the canonical collection name = the
    // CollectionPlatform (`file`), NOT the tab id (`files`). Using the tab id
    // would miss the schema (→ record_id titles). mail/calendar coincide, files
    // does not.
    explorerCollection = (platform ?? (tab as CollectionPlatform)) as CanonicalCollectionName;
    explorerDetail = null;
    explorerDetailRetryable = false;
    explorerDetailRetrying = false;
    pendingExplorerDetailRetryFocus = null;
    if (!explorerRetrying) {
      explorerError = undefined;
      explorerErrorRetryable = false;
    }
    explorerLoading = true;
    const caller = opts.collectionListInstancesCaller;
    if (platform === undefined || caller === undefined) {
      explorerInstances = [];
      explorerSelectedSlug = null;
      explorerRecords = [];
      explorerLoading = false;
      if (caller === undefined) {
        explorerError = 'Recued cannot browse this here.';
        explorerErrorRetryable = false;
      }
      return;
    }
    try {
      let instances: CollectionInstanceRow[];
      if (tab === 'files' && opts.fileChatCallers?.cloud) {
        const [local, remote] = await Promise.allSettled([caller(), opts.fileChatCallers.cloud.sources().then(result => {
          if (!Array.isArray(result.sources)) throw new Error('This server cannot reach files you have connected.');
          return result.sources;
        })]);
        if (disposed || seq !== explorerSeq) return;
        cloudSources = remote.status === 'fulfilled' ? remote.value : [];
        cloudSourcesError = [
          ...(local.status === 'rejected' ? [`Could not load saved files. ${humanizeRpcError(local.reason)}`] : []),
          ...(remote.status === 'rejected' ? [`Could not load connected file sources. ${humanizeRpcError(remote.reason)}`] : []),
        ].join(' ');
        instances = [...(local.status === 'fulfilled' ? local.value.instances : []), ...cloudSources.map(cloudFileInstance)];
      } else {
        instances = (await caller()).instances;
      }
      if (disposed || seq !== explorerSeq) return;
      // The files saved in Recued first, whatever else is connected.
      if (tab === 'files' && opts.collectionListCaller !== undefined) {
        instances = [savedFilesInstance, ...instances.filter((i) => i.slug !== SAVED_FILES_SLUG)];
      }
      explorerInstances = instances.filter((i) => i.platform === platform);
      const preferredSlug = requestedSlug ?? previouslySelectedSlug;
      const verificationRecordId =
        activeTab === pendingExplorerVerificationTab
          ? pendingExplorerVerificationRecordId
          : null;
      if (
        preferredSlug === null
        && verificationRecordId !== null
        && explorerInstances.length > 1
      ) {
        const resolution = await resolveExplorerVerification(
          platform,
          explorerInstances,
          verificationRecordId,
        );
        if (disposed || seq !== explorerSeq) return;
        explorerSelectedSlug =
          resolution.kind === 'match' ? resolution.slug : null;
        if (resolution.kind !== 'match') {
          explorerError = resolution.message;
          explorerErrorRetryable = false;
        }
      } else {
        explorerSelectedSlug =
          preferredSlug !== null
          && explorerInstances.some((instance) => instance.slug === preferredSlug)
            ? preferredSlug
            : requestedSlug !== null
              ? null
              : explorerInstances.length === 1
                ? explorerInstances[0]!.slug
                // The Files tab always lists the saved files; beside exactly
                // one connected source, that source still opens as it did.
                : tab === 'files' && explorerInstances.filter((i) => i.slug !== SAVED_FILES_SLUG).length === 1
                  ? explorerInstances.find((i) => i.slug !== SAVED_FILES_SLUG)!.slug
                  : null;
      }
      explorerRecords = [];
      if (requestedSlug !== null && explorerSelectedSlug === null) {
        explorerError =
          opts.savedView === undefined
            ? 'The source this record came from is gone.'
            : 'The source for this view is gone. Pick another one to carry on.';
        explorerErrorRetryable = false;
      }
      // The roster is ready even when this source's records are slow. Keep
      // other accounts selectable while the chosen account is loading.
      render();
      if (explorerSelectedSlug !== null) {
        if (opts.savedView !== undefined) savedExplorerScopes.set(tab, explorerSelectedSlug);
        await fetchExplorerRecords(platform, explorerSelectedSlug, seq);
      }
    } catch (err) {
      if (disposed || seq !== explorerSeq) return;
      explorerInstances = [];
      explorerRecords = [];
      explorerError = humanizeRpcError(err);
      explorerErrorRetryable = true;
    } finally {
      if (!disposed && seq === explorerSeq) explorerLoading = false;
    }
  };

  /** Pick a different instance (only offered when >1) → fetch its records. */
  const selectExplorerInstance = async (slug: string): Promise<void> => {
    const platform = EXPLORER_TAB_PLATFORM[activeTab];
    if (platform === undefined || slug === explorerSelectedSlug) return;
    if (!mailMessageSurface.beforeLeave()) return;
    if (!calendarEventSurface.beforeLeave(() => { void selectExplorerInstance(slug); })) return;
    if (!calendarCreateSurface.beforeLeave(() => { void selectExplorerInstance(slug); })) return;
    calendarEventSurface.reset();
    mailMessageSurface.reset();
    cloudFileQuery = cloudFileQueryInput = ''; cloudFileCursor = undefined; cloudBrowseError = '';
    explorerSelectedSlug = slug;
    if (opts.savedView !== undefined) savedExplorerScopes.set(activeTab, slug);
    explorerRecords = [];
    explorerDetail = null;
    explorerDetailRetryable = false;
    explorerDetailRetrying = false;
    pendingExplorerDetailRetryFocus = null;
    explorerError = undefined;
    explorerErrorRetryable = false;
    explorerRetrying = false;
    pendingExplorerRetryFocus = null;
    explorerRetryGeneration += 1;
    pendingExplorerRecordFocus = null;
    pendingRescheduleOpenFocusId = null;
    explorerLoading = true;
    render();
    syncDataHash(); // switching instance drops the open record → `#data/<tab>`
    const seq = ++explorerSeq;
    await fetchExplorerRecords(platform, slug, seq);
    if (disposed || seq !== explorerSeq) return;
    explorerLoading = false;
    if (
      activeTab === pendingExplorerVerificationTab
      && pendingExplorerVerificationRecordId !== null
    ) {
      await openExplorerRecord(pendingExplorerVerificationRecordId);
      return;
    }
    render();
  };

  /** Retry the active explorer's instance + list read without making the owner
   * leave the tab. The prior alert stays visible as context while the retry is
   * busy; success returns focus to the selected source (or the tab when there
   * is no selected source), and failure returns to Retry. */
  const retryExplorer = async (): Promise<void> => {
    if (
      explorerRetrying
      || !explorerErrorRetryable
      || activeLens !== 'data'
      || (!isExplorerTab(activeTab) && !isSingleCollectionTab(activeTab))
    ) {
      return;
    }
    const retryTab = activeTab;
    const activeElement = doc.activeElement as HTMLElement | null | undefined;
    pendingExplorerRetryFocus =
      activeElement?.hasAttribute?.(COLLECTION_RETRY_ATTR) === true
        ? retryTab
        : null;
    const retryGeneration = ++explorerRetryGeneration;
    explorerRetrying = true;
    render();
    await loadExplorer(retryTab, explorerSelectedSlug ?? undefined);
    if (
      disposed
      || retryGeneration !== explorerRetryGeneration
      || activeLens !== 'data'
      || activeTab !== retryTab
    ) {
      return;
    }
    explorerRetrying = false;
    render();
  };

  /** Resolve one exact platform record after either the initial open or an
   * inline retry. Both entry points share the same stale-response and calendar
   * timeline behavior. */
  const readExplorerRecord = async (
    tab: DataTabId,
    platform: CollectionPlatform,
    slug: string,
    record_id: string,
    seq: number,
    caller: NonNullable<BootstrapDataRouteOptions['collectionGetCaller']>,
  ): Promise<void> => {
    let loadedRecord: CollectionRecord | null = null;
    try {
      const { record } = await caller({ platform, slug, record_id });
      if (disposed || seq !== explorerSeq) return;
      explorerDetail = { record_id, loading: false, record };
      explorerDetailRetryable = false;
      explorerDetailRetrying = false;
      loadedRecord = record;
      if (platform === 'calendar' && record !== null) void calendarEventSurface.open({ slug, source_id: record.source_id }, record.record_id);
      if (platform === 'mail' && record !== null) void mailMessageSurface.open({ slug, record_id: record.record_id });
      // The verification handoff has found its exact item. From here on,
      // switching accounts is ordinary browsing rather than repeatedly forcing
      // this record id onto every source. A null result stays pending so the
      // owner can try another source after an ambiguous/partial resolution.
      if (
        record !== null
        && tab === pendingExplorerVerificationTab
        && record_id === pendingExplorerVerificationRecordId
      ) {
        pendingExplorerVerificationRecordId = null;
      }
    } catch (err) {
      if (disposed || seq !== explorerSeq) return;
      explorerDetail = { record_id, loading: false, error: humanizeRpcError(err) };
      explorerDetailRetryable = true;
      explorerDetailRetrying = false;
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

  /** Open one record's detail (lazy `collection.get`). */
  const openCalendarAgendaEvent = async (slug: string, recordId: string, key: string): Promise<void> => {
    if (activeLens !== 'data' || activeTab !== 'calendar' || !calendarAgenda.record(slug, recordId)) return;
    if (!calendarCreateSurface.beforeLeave(() => { void openCalendarAgendaEvent(slug, recordId, key); })) return;
    loadGeneration += 1; loading = false;
    calendarAgenda.cancel();
    calendarAgendaReturn = { key, scrollTop: workSearchScrollHost()?.scrollTop ?? 0, hash: dataHistory.current().hash,
      sourcesOpen: routeRoot.querySelector<HTMLDetailsElement>('details[data-calendar-agenda-sources]')?.open ?? false };
    explorerCollection = 'calendar';
    explorerInstances = calendarAgenda.snapshot().sources.map(source => source.instance);
    explorerSelectedSlug = slug;
    explorerRecords = calendarAgenda.snapshot().sources.find(source => source.instance.slug === slug)?.records ?? [];
    await openExplorerRecord(recordId);
  };

  const openExplorerRecord = async (record_id: string): Promise<void> => {
    if (!calendarCreateSurface.beforeLeave(() => { void openExplorerRecord(record_id); })) return;
    if (!mailMessageSurface.beforeLeave()) return;
    if (!calendarEventSurface.beforeLeave(() => { void openExplorerRecord(record_id); })) return;
    calendarEventSurface.reset();
    mailMessageSurface.reset();
    fileLifecycle = undefined; fileLifecycleGeneration++; fileLifecycleNotice = '';
    retireRunVerificationForDifferentItem(activeTab, record_id);
    pendingRescheduleOpenFocusId = null;
    explorerDetailRetryable = false;
    explorerDetailRetrying = false;
    pendingExplorerDetailRetryFocus = null;
    const activeElement = doc.activeElement as HTMLElement | null | undefined;
    pendingExplorerRecordFocus =
      renderedActiveTab === activeTab
      && activeElement?.getAttribute?.(COLLECTION_RECORD_ID_ATTR) === record_id
        ? { tab: activeTab, recordId: record_id }
        : null;
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
    const tab = activeTab;
    const platform = EXPLORER_TAB_PLATFORM[tab];
    const caller = opts.collectionGetCaller || opts.fileChatCallers?.cloud ? getExplorerRecord : undefined;
    if (platform === undefined || explorerSelectedSlug === null) return;
    const slug = explorerSelectedSlug;
    explorerDetail = { record_id, loading: true };
    render();
    syncDataHash(); // reflect the open record as `#data/<tab>/<record_id>`
    if (caller === undefined) {
      explorerDetail = {
        record_id,
        loading: false,
        error: 'Recued cannot open records here.',
      };
      render();
      return;
    }
    const seq = ++explorerSeq;
    explorerTimeline = null; // drop the prior record's timeline
    rescheduleForm = null; // D-210 R-4 — drop a stale reschedule form on record switch
    await readExplorerRecord(tab, platform, slug, record_id, seq, caller);
  };

  /** Retry an exact failed `collection.get` without dropping back to the list.
   * The alert stays visible while busy. Focus follows Retry only while that
   * control still owns it, then lands on Retry again or the loaded heading. */
  const retryExplorerDetail = async (): Promise<void> => {
    const detail = explorerDetail;
    const tab = activeTab;
    const platform = EXPLORER_TAB_PLATFORM[tab];
    const caller = opts.collectionGetCaller || opts.fileChatCallers?.cloud ? getExplorerRecord : undefined;
    if (
      explorerDetailRetrying
      || !explorerDetailRetryable
      || detail === null
      || detail.error === undefined
      || activeLens !== 'data'
      || !isExplorerTab(tab)
      || platform === undefined
      || explorerSelectedSlug === null
      || caller === undefined
    ) {
      return;
    }
    const recordId = detail.record_id;
    const slug = explorerSelectedSlug;
    const activeElement = doc.activeElement as HTMLElement | null | undefined;
    pendingExplorerDetailRetryFocus =
      renderedActiveTab === tab
      && activeElement?.hasAttribute?.(COLLECTION_DETAIL_RETRY_ATTR) === true
        ? { tab, recordId }
        : null;
    pendingExplorerRecordFocus = null;
    explorerDetailRetrying = true;
    const seq = ++explorerSeq;
    render();
    await readExplorerRecord(tab, platform, slug, recordId, seq, caller);
  };

  const closeExplorerDetail = (alreadyNavigated = false): void => {
    if (!mailMessageSurface.beforeLeave()) return;
    if (!calendarEventSurface.beforeLeave(() => closeExplorerDetail(alreadyNavigated))) return;
    calendarEventSurface.reset();
    mailMessageSurface.reset();
    const activeElement = doc.activeElement as HTMLElement | null | undefined;
    const returnRecordId =
      activeElement?.getAttribute?.(DATA_ROUTE_ACTION_ATTR)
        === COLLECTION_DETAIL_CLOSE_ACTION
        ? explorerDetail?.record_id ?? null
        : null;
    retireRunVerification();
    pendingExplorerRecordFocus = null;
    explorerDetail = null;
    explorerDetailRetryable = false;
    explorerDetailRetrying = false;
    pendingExplorerDetailRetryFocus = null;
    explorerTimeline = null; // D-210 step 3 — drop the closed record's timeline
    rescheduleForm = null; // D-210 R-4 — drop the reschedule form on close
    pendingRescheduleOpenFocusId = null;
    // Abandon any in-flight `collection.get` — without this bump its
    // `seq === explorerSeq` guard still passes and reinstates the detail view
    // (+ the Files download button) after the user navigated Back.
    explorerSeq += 1;
    if (activeTab === 'calendar') {
      const origin = calendarAgendaReturn;
      calendarAgendaReturn = null;
      pendingCalendarAgendaRestore = origin ?? { key: 'date', scrollTop: 0 };
      explorerSelectedSlug = null; explorerRecords = []; explorerLoading = false; loading = false;
      if (alreadyNavigated && origin) dataHistory.adopt(dataAddress(origin.hash, undefined));
      else syncDataHash();
      explorerLiveRefreshPending = false;
      pendingLoadPromise = calendarAgenda.refresh({ silent: true });
      return;
    }
    render();
    if (returnRecordId !== null) {
      const row = Array.from(
        routeRoot.querySelectorAll<HTMLElement>(
          `[${COLLECTION_RECORD_ID_ATTR}]`,
        ),
      ).find(
        (candidate) =>
          candidate.getAttribute(COLLECTION_RECORD_ID_ATTR) === returnRecordId,
      );
      const source = explorerSelectedSlug === null
        ? null
        : Array.from(
            routeRoot.querySelectorAll<HTMLElement>(
              `[${COLLECTION_INSTANCE_SLUG_ATTR}]`,
            ),
          ).find(
            (candidate) =>
              candidate.getAttribute(COLLECTION_INSTANCE_SLUG_ATTR)
                === explorerSelectedSlug,
          ) ?? null;
      const tab = collectionNavigationTarget(activeTab);
      (row ?? source ?? tab)?.focus?.({ preventScroll: true });
    }
    syncDataHash(); // back to the list → `#data/<tab>`
    if (explorerLiveRefreshPending) {
      explorerLiveRefreshPending = false;
      runLiveRefresh();
    }
  };

  const validatedRecordsView = (namespace: RecordsNamespaceView, kind: string) => {
    const entity = namespace.schema.entities[kind];
    if (entity === undefined) throw new Error('That kind of record is gone.');
    parseRecordsViewDraft(recordsViewDraft(recordsState.view), entity);
    return recordsState.view;
  };

  const loadRecordsPage = async (cursor?: string, page = 1): Promise<void> => {
    const namespace = recordsState.selectedNamespace;
    const kind = recordsState.selectedKind;
    const caller = opts.recordsSearchCaller;
    if (!namespace || !kind || !caller || recordsState.loading || hasRecordsInFlightWork()) return;
    const seq = ++recordsSeq;
    const focus = activeRecordsFocusIdentity();
    recordsState = { ...recordsState, loading: true, error: undefined,
      ...(cursor === undefined ? { records: [], nextCursor: null, prevCursor: null, page: 1 } : {}) };
    render();
    focusRecordsIdentity(focus);
    try {
      const response = await caller({ owner: namespace.owner, entity: kind,
        ...validatedRecordsView(namespace, kind), include_orphaned: true, limit: DEFAULT_LIMIT,
        ...(cursor === undefined ? {} : { cursor }) });
      if (disposed || seq !== recordsSeq) return;
      recordsState = { ...recordsState, records: response.records, page, loading: false,
        nextCursor: response.next_cursor ?? null, prevCursor: response.prev_cursor ?? null };
    } catch (error) {
      if (disposed || seq !== recordsSeq) return;
      // Keep the last successful page and its handles for retry. Refresh results
      // starts a new query if the server expired or invalidated a page handle.
      recordsState = { ...recordsState, loading: false, error: humanizeRpcError(error) };
    }
    const settledFocus = activeRecordsFocusIdentity();
    render();
    focusRecordsIdentity(settledFocus);
    syncDataHash();
  };

  const applyRecordsView = (action: 'apply' | 'reset' | 'clear-filters' = 'apply'): void => {
    if (activeTab !== 'records' || recordsState.loading || hasRecordsInFlightWork()) return;
    const entity = recordsState.selectedNamespace?.schema.entities[recordsState.selectedKind ?? ''];
    if (!entity) return;
    try {
      const view = action === 'reset' ? {} : action === 'clear-filters'
        ? (recordsState.view.sort === undefined ? {} : { sort: recordsState.view.sort })
        : parseRecordsViewDraft(recordsState.viewDraft, entity);
      const viewDraft = recordsViewDraft(view);
      // Clearing filters must neither apply nor discard an unfinished sort edit.
      if (action === 'clear-filters') viewDraft.sort = recordsState.viewDraft.sort;
      if (activeRecordsAction()?.startsWith('records-filter-')
        || activeRecordsAction() === 'records-clear-filters') focusRecordsAction('records-apply-view');
      recordsState = { ...recordsState, view, viewDraft };
      pendingLoadPromise = loadRecordsPage();
    } catch (error) {
      const focus = activeRecordsFocusIdentity();
      recordsState = { ...recordsState, error: humanizeRpcError(error) };
      render();
      focusRecordsIdentity(focus);
    }
  };

  const changeRecordsViewDraft = (target: HTMLInputElement | HTMLSelectElement): boolean => {
    const action = target.getAttribute('data-action');
    if (activeTab !== 'records' || !['records-filter-field', 'records-filter-op', 'records-filter-value', 'records-view-sort'].includes(action ?? '')) return false;
    if (recordsState.loading || hasRecordsInFlightWork()) return true;
    const draft = recordsState.viewDraft;
    if (action === 'records-view-sort') recordsState = { ...recordsState, viewDraft: { ...draft, sort: target.value } };
    else {
      const index = Number(target.getAttribute('data-records-filter-index'));
      const row = draft.filters[index];
      if (!row) return true;
      let changed = { ...row, [action === 'records-filter-field' ? 'field' : action === 'records-filter-op' ? 'op' : 'value']: target.value };
      if (action === 'records-filter-field') {
        const field = recordsState.selectedNamespace?.schema.entities[recordsState.selectedKind ?? '']?.fields.find(field => field.key === target.value);
        if (!field) return true;
        changed = { field: field.key, op: recordsFilterOperators(field)[0] ?? 'is_null', value: '' };
      }
      if (action === 'records-filter-op') changed.value = '';
      recordsState = { ...recordsState, viewDraft: { ...draft, filters: draft.filters.map((entry, i) => i === index ? changed : entry) } };
    }
    if (action === 'records-filter-value') {
      // Keep the input and caret mounted while reflecting draft availability.
      const pending = recordsViewHasDraft(recordsState);
      const status = routeRoot.querySelector<HTMLElement>('[data-records-draft-status]');
      if (status) status.hidden = !pending;
      for (const [action, available] of [
        ['records-next-page', recordsState.nextCursor !== null],
        ['records-prev-page', recordsState.prevCursor !== null],
        ['records-first-page', true],
      ] as const) {
        const button = routeRoot.querySelector(`[data-action="${action}"]`);
        if (pending || !available) button?.setAttribute('aria-disabled', 'true');
        else button?.removeAttribute('aria-disabled');
      }
      opts.onViewChange?.(currentView());
    }
    else {
      const focus = activeRecordsFocusIdentity();
      render();
      focusRecordsIdentity(focus);
    }
    return true;
  };

  const loadRecordsNamespace = async (
    namespace: RecordsNamespaceView,
    preferredKind?: string,
    returnFocusId?: string,
  ): Promise<void> => {
    const kindsCaller = opts.recordsKindListCaller;
    const searchCaller = opts.recordsSearchCaller;
    const seq = ++recordsSeq;
    if (opts.savedView !== undefined) {
      savedRecordsSelection = { owner: namespace.owner, entity: preferredKind ?? null };
    }
    recordsState = {
      ...recordsState,
      ...(preferredKind === undefined ? initialRecordsBrowseState() : { nextCursor: null, prevCursor: null, page: 1 }),
      selectedNamespace: namespace,
      selectedKind: null,
      kinds: [],
      records: [],
      detail: null,
      diagnostics: null,
      outbox: null,
      changes: null,
      changesOpen: false,
      changesRefreshing: false,
      reviewMark: null,
      canMarkReviewed: false,
      markingReviewed: false,
      retention: {},
      loading: true,
      deletePending: false,
      deleting: false,
      outboxRefreshing: false,
      retiringEventId: null,
      retiringEventBusy: false,
      purgePending: false,
      purgeConfirmation: '',
      purging: false,
      error: undefined,
    };
    void recordsImport.load(namespace);
    const focusedControl = activeRecordsFocusIdentity();
    render();
    focusRecordsIdentity(focusedControl);
    if (returnFocusId !== undefined) focusRecordsListReturn(returnFocusId);
    if (kindsCaller === undefined || searchCaller === undefined) {
      if (seq !== recordsSeq || disposed) return;
      recordsState = {
        ...recordsState,
        loading: false,
        error: 'Recued cannot manage Records here.',
      };
      return;
    }
    try {
      const [kindResponse, retentionResponse, outboxResponse, changesResponse] = await Promise.all([
        kindsCaller({ owner: namespace.owner }),
        opts.recordsRetentionListCaller?.({ owner: namespace.owner })
          ?? Promise.resolve({ policies: {} }),
        opts.recordsOutboxListCaller?.({ owner: namespace.owner, limit: 100 })
          ?? Promise.resolve(null),
        // ⛔ P2/F2 — WITHOUT THIS THE PANEL CANNOT EXIST. `renderChanges`
        // returns '' while `changes` is null, and every other trigger (toggle,
        // refresh, post-mark) is a control INSIDE that panel — so the feature
        // was reachable only from itself. Loading here, beside the outbox, is
        // what gives the collapsed summary something to count.
        opts.recordsChangesListCaller?.({
          owner: namespace.owner,
          limit: 50,
          ...(reviewMarkFor(namespace.owner) === null
            ? {} : { after: reviewMarkFor(namespace.owner)!.reviewed_through }),
        }).catch(() => null) ?? Promise.resolve(null),
      ]);
      if (disposed || seq !== recordsSeq) return;
      // The store normally includes zero-row schema kinds. Merge defensively so
      // an older server cannot hide an empty kind from its installed snapshot.
      const counts = new Map(kindResponse.kinds.map((kind) => [kind.kind, kind]));
      const kinds = Object.keys(namespace.schema.entities).sort().map((kind) =>
        counts.get(kind) ?? { kind, rows: 0, payload_bytes: 0 });
      if ((opts.savedView !== undefined || pendingRecordsTarget !== undefined) && preferredKind !== undefined && !kinds.some((kind) => kind.kind === preferredKind)) {
        recordsState = { ...recordsState, kinds, loading: false, error: 'The kind you picked is gone. Choose another one to carry on.' };
        return;
      }
      const selectedKind = preferredKind && kinds.some((kind) => kind.kind === preferredKind)
        ? preferredKind
        : kinds[0]?.kind ?? null;
      if (opts.savedView !== undefined) savedRecordsSelection = { owner: namespace.owner, entity: selectedKind };
      recordsState = {
        ...recordsState,
        ...(preferredKind !== undefined && selectedKind !== preferredKind ? initialRecordsBrowseState() : {}),
        kinds,
        selectedKind,
        retention: retentionResponse.policies,
        outbox: outboxResponse,
        changes: changesResponse,
        reviewMark: reviewMarkFor(namespace.owner),
        canMarkReviewed: reviewBindingFor(namespace.owner) !== null
          && opts.recordsMarkReviewedCaller !== undefined,
      };
      if (selectedKind === null) {
        recordsState = { ...recordsState, loading: false };
        return;
      }
      const result = await searchCaller({
        owner: namespace.owner,
        entity: selectedKind,
        ...validatedRecordsView(namespace, selectedKind),
        include_orphaned: true,
        limit: DEFAULT_LIMIT,
      });
      if (disposed || seq !== recordsSeq) return;
      recordsState = { ...recordsState, records: result.records, loading: false,
        nextCursor: result.next_cursor ?? null, prevCursor: result.prev_cursor ?? null };
    } catch (error) {
      if (disposed || seq !== recordsSeq) return;
      recordsState = {
        ...recordsState,
        records: [],
        detail: null,
        diagnostics: null,
        loading: false,
        error: humanizeRpcError(error),
      };
    }
  };

  const loadRecords = async (returnFocusId?: string, retainOnReadFailure = false): Promise<void> => {
    const previousState = recordsState;
    const caller = opts.recordsNamespaceListCaller;
    const seq = ++recordsSeq;
    recordsState = { ...recordsState, loading: true, error: undefined };
    if (caller === undefined) {
      recordsState = {
        ...recordsState,
        namespaces: [],
        globalQuota: null,
        selectedNamespace: null,
        loading: false,
        error: 'Recued cannot manage Records here.',
      };
      return;
    }
    try {
      const response = await caller();
      if (disposed || seq !== recordsSeq) return;
      const previous = recordsState.selectedNamespace?.owner ?? savedRecordsSelection?.owner ?? undefined;
      const selected = previous === undefined
        ? response.namespaces[0] ?? null
        : response.namespaces.find((namespace) =>
            namespace.owner.publisher === previous.publisher && namespace.owner.pack_slug === previous.pack_slug)
          ?? (!retainOnReadFailure && opts.savedView === undefined && opts.initialRecordsTarget === undefined ? response.namespaces[0] ?? null : null);
      recordsState = {
        ...recordsState,
        namespaces: response.namespaces,
        globalQuota: response.global_quota,
        selectedNamespace: selected,
        loading: selected !== null,
      };
      if (selected === null) {
        void recordsImport.load(null);
        recordsState = { ...recordsState, records: [], kinds: [], selectedKind: null, detail: null,
          diagnostics: null, outbox: null, outboxOpen: false, retention: {}, loading: false,
          changes: null, changesOpen: false, reviewMark: null, canMarkReviewed: false,
          ...(previous === undefined ? {} : { error: 'The Pack you picked is gone. Choose another one to carry on.' }) };
        return;
      }
      const namespaceSeq=recordsSeq+1;
      await loadRecordsNamespace(
        selected,
        previous !== undefined && recordsOwnerKey(previous) === recordsOwnerKey(selected.owner)
          ? recordsState.selectedKind ?? savedRecordsSelection?.entity ?? undefined : undefined,
        returnFocusId,
      );
      if(disposed || recordsSeq!==namespaceSeq)return;
      if (pendingRecordsTarget && recordsState.selectedKind !== pendingRecordsTarget.entity) { recordsState={...recordsState,selectedKind:null,records:[],loading:false,error:'The requested Records kind is unavailable.'}; }
      if (pendingRecordsTarget && recordsState.selectedKind === pendingRecordsTarget.entity) {
        const target=pendingRecordsTarget;pendingRecordsTarget=undefined;await openRecordsRecord(target.id);if(!disposed && recordsState.detail?.id===target.id)focusRecordsDetailHeading();
      }
    } catch (error) {
      if (disposed || seq !== recordsSeq) return;
      if (retainOnReadFailure) {
        recordsState = { ...previousState, loading: false, error: humanizeRpcError(error) };
        return;
      }
      recordsState = {
        ...recordsState,
        namespaces: [],
        globalQuota: null,
        selectedNamespace: null,
        records: [],
        detail: null,
        loading: false,
        error: humanizeRpcError(error),
      };
    }
  };

  const selectRecordsNamespace = async (key: string): Promise<void> => {
    if (
      recordsState.loadingNamespaceKey !== null
      || recordsState.loadingKind !== null
    ) return;
    const selected = recordsState.namespaces.find((namespace) =>
      recordsOwnerKey(namespace.owner) === key);
    const selectedKey = recordsState.selectedNamespace === null
      ? null
      : recordsOwnerKey(recordsState.selectedNamespace.owner);
    if (
      selected === undefined
      || (selectedKey === key && recordsState.error === undefined)
    ) return;
    recordsState = {
      ...recordsState,
      loadingNamespaceKey: key,
      loadingKind: null,
      error: undefined,
    };
    await loadRecordsNamespace(selected, selectedKey === key
      ? recordsState.selectedKind ?? savedRecordsSelection?.entity ?? undefined : undefined);
    if (
      disposed
      || activeTab !== 'records'
      || recordsState.selectedNamespace === null
      || recordsOwnerKey(recordsState.selectedNamespace.owner) !== key
    ) return;
    const settledFocus = activeRecordsFocusIdentity();
    recordsState = { ...recordsState, loadingNamespaceKey: null };
    render();
    focusRecordsIdentity(settledFocus);
  };

  const selectRecordsKind = async (kind: string): Promise<void> => {
    const namespace = recordsState.selectedNamespace;
    const caller = opts.recordsSearchCaller;
    if (
      recordsState.loadingNamespaceKey !== null
      || recordsState.loadingKind !== null
      || namespace === null
      || caller === undefined
      || !recordsState.kinds.some((entry) => entry.kind === kind)
      || (recordsState.selectedKind === kind && recordsState.error === undefined)
    ) return;
    if (opts.savedView !== undefined) savedRecordsSelection = { owner: namespace.owner, entity: kind };
    const seq = ++recordsSeq;
    const focusedControl = activeRecordsFocusIdentity();
    recordsState = {
      ...recordsState,
      ...(recordsState.selectedKind === kind ? { nextCursor: null, prevCursor: null, page: 1 } : initialRecordsBrowseState()),
      selectedKind: kind,
      records: [],
      detail: null,
      diagnostics: null,
      loading: true,
      loadingKind: kind,
      error: undefined,
      deletePending: false,
    };
    render();
    focusRecordsIdentity(focusedControl);
    try {
      const result = await caller({
        owner: namespace.owner,
        entity: kind,
        ...validatedRecordsView(namespace, kind),
        include_orphaned: true,
        limit: DEFAULT_LIMIT,
      });
      if (disposed || seq !== recordsSeq) return;
      recordsState = { ...recordsState, records: result.records, loading: false,
        nextCursor: result.next_cursor ?? null, prevCursor: result.prev_cursor ?? null };
    } catch (error) {
      if (disposed || seq !== recordsSeq) return;
      recordsState = {
        ...recordsState,
        records: [],
        loading: false,
        error: humanizeRpcError(error),
      };
    }
    const settledFocus = activeRecordsFocusIdentity();
    recordsState = { ...recordsState, loadingKind: null };
    render();
    focusRecordsIdentity(settledFocus);
  };

  const openRecordsRecord = async (id: string): Promise<void> => {
    const namespace = recordsState.selectedNamespace;
    const entity = recordsState.selectedKind;
    const caller = opts.recordsGetCaller;
    if (namespace === null || entity === null || caller === undefined) return;
    const carryFocus =
      activeRecordsAction() === RECORDS_OPEN_RECORD_ACTION
      && (doc.activeElement as HTMLElement | null)?.getAttribute(RECORDS_ID_ATTR) === id;
    const seq = ++recordsSeq;
    recordsState = { ...recordsState, loading: true, error: undefined, deletePending: false };
    render();
    if (carryFocus) {
      focusRecordsAction(RECORDS_OPEN_RECORD_ACTION, RECORDS_ID_ATTR, id);
    }
    try {
      const { record, diagnostics } = await caller({ owner: namespace.owner, entity, id });
      if (disposed || seq !== recordsSeq) return;
      recordsState = {
        ...recordsState,
        detail: record,
        diagnostics,
        loading: false,
        ...(record === null ? { error: 'This record no longer exists.' } : {}),
      };
    } catch (error) {
      if (disposed || seq !== recordsSeq) return;
      recordsState = { ...recordsState, loading: false, error: humanizeRpcError(error) };
    }
    const stillOwnsFocus =
      carryFocus
      && activeRecordsAction() === RECORDS_OPEN_RECORD_ACTION
      && (doc.activeElement as HTMLElement | null)?.getAttribute(RECORDS_ID_ATTR) === id;
    render();
    if (stillOwnsFocus) {
      if (recordsState.detail === null) {
        focusRecordsAction(RECORDS_OPEN_RECORD_ACTION, RECORDS_ID_ATTR, id);
      } else {
        focusRecordsDetailHeading();
      }
    }
  };

  const confirmRecordsDelete = async (): Promise<void> => {
    const namespace = recordsState.selectedNamespace;
    const entity = recordsState.selectedKind;
    const record = recordsState.detail;
    const caller = opts.recordsDeleteCaller;
    if (
      namespace === null || entity === null || record === null
      || caller === undefined || recordsState.deleting
    ) return;
    const carriedAction = activeRecordsAction();
    const carryFocus =
      carriedAction === RECORDS_CONFIRM_DELETE_ACTION
      || carriedAction === RECORDS_CANCEL_DELETE_ACTION;
    let deleted = false;
    let settledAction: string | null = null;
    const seq = ++recordsSeq;
    recordsState = { ...recordsState, deleting: true, error: undefined };
    render();
    if (carryFocus) focusRecordsAction(carriedAction);
    try {
      await caller({
        owner: namespace.owner,
        entity,
        id: record.id,
        expected_version: record._record.version,
        expected_revision: record._record.revision,
      });
      if (disposed || seq !== recordsSeq) return;
      const activeAction = activeRecordsAction();
      if (
        activeAction === RECORDS_CONFIRM_DELETE_ACTION
        || activeAction === RECORDS_CANCEL_DELETE_ACTION
      ) {
        settledAction = activeAction;
      }
      recordsState = {
        ...recordsState,
        records: recordsState.records.filter((entry) => entry.id !== record.id),
        detail: null,
        diagnostics: null,
        deletePending: false,
        deleting: false,
      };
      // Re-read namespace quota/generations after the atomic delete.
      await loadRecords(settledAction === null ? undefined : record.id);
      deleted = true;
    } catch (error) {
      if (disposed || seq !== recordsSeq) return;
      const activeAction = activeRecordsAction();
      if (
        activeAction === RECORDS_CONFIRM_DELETE_ACTION
        || activeAction === RECORDS_CANCEL_DELETE_ACTION
      ) {
        settledAction = activeAction;
      }
      recordsState = {
        ...recordsState,
        deleting: false,
        error: humanizeRpcError(error),
      };
    }
    render();
    if (settledAction !== null) {
      if (deleted) {
        focusRecordsListReturn(record.id);
      } else if (!focusRecordsAction(settledAction)) {
        focusRecordsAction(RECORDS_CONFIRM_DELETE_ACTION);
      }
    }
  };

  const downloadRecordsExport = (
    filename: string,
    envelope: RecordsExportEnvelope,
  ): void => {
    if (opts.recordsDownload !== undefined) {
      opts.recordsDownload(filename, envelope);
      return;
    }
    const view = doc.defaultView;
    if (view === null || view === undefined || typeof view.URL?.createObjectURL !== 'function') {
      throw new Error('You cannot download files here.');
    }
    const blob = new view.Blob([JSON.stringify(envelope, null, 2)], { type: 'application/json' });
    const url = view.URL.createObjectURL(blob);
    try {
      const link = doc.createElement('a');
      link.href = url;
      link.download = filename;
      link.hidden = true;
      (doc.body ?? opts.root).appendChild(link);
      link.click();
      link.remove();
    } finally {
      view.URL.revokeObjectURL(url);
    }
  };

  const downloadRecordsCsv = (
    filename: string,
    envelope: RecordsCsvExportEnvelope,
  ): void => {
    if (opts.recordsCsvDownload !== undefined) {
      opts.recordsCsvDownload(filename, envelope);
      return;
    }
    const view = doc.defaultView;
    if (view === null || view === undefined || typeof view.URL?.createObjectURL !== 'function') {
      throw new Error('You cannot download files here.');
    }
    const blob = new view.Blob([envelope.csv], { type: 'text/csv;charset=utf-8' });
    const url = view.URL.createObjectURL(blob);
    try {
      const link = doc.createElement('a');
      link.href = url;
      link.download = filename;
      link.hidden = true;
      (doc.body ?? opts.root).appendChild(link);
      link.click();
      link.remove();
    } finally {
      view.URL.revokeObjectURL(url);
    }
  };

  const exportRecords = async (format: 'json' | 'csv', entity?: string): Promise<void> => {
    const namespace = recordsState.selectedNamespace;
    const caller = opts.recordsExportCaller;
    if (namespace === null || caller === undefined || recordsState.exporting) return;
    const action = entity === undefined
      ? format === 'csv' ? RECORDS_EXPORT_PACK_CSV_ACTION : RECORDS_EXPORT_PACK_ACTION
      : format === 'csv' ? RECORDS_EXPORT_KIND_CSV_ACTION : RECORDS_EXPORT_KIND_ACTION;
    const carryFocus = activeRecordsAction() === action;
    recordsState = {
      ...recordsState,
      exporting: true,
      exportingAction: action,
      error: undefined,
    };
    render();
    if (carryFocus) focusRecordsAction(action);
    try {
      const envelope = await caller({
        owner: namespace.owner,
        ...(entity !== undefined ? { entity } : {}),
        format,
      });
      const safe = `${namespace.owner.publisher}-${namespace.owner.pack_slug}${entity ? `-${entity}` : ''}`
        .replace(/[^a-zA-Z0-9._-]+/g, '-');
      if (format === 'csv') {
        if (envelope.format !== 'recued.records.csv.v1') throw new Error('Your server sent back the wrong kind of file.');
        downloadRecordsCsv(`${safe}-records.csv`, envelope);
      } else {
        if (envelope.format !== 'recued.records.v1') throw new Error('Your server sent back the wrong kind of file.');
        downloadRecordsExport(`${safe}-records.json`, envelope);
      }
    } catch (error) {
      recordsState = { ...recordsState, error: humanizeRpcError(error) };
    } finally {
      const settledFocus = activeRecordsFocusIdentity();
      recordsState = {
        ...recordsState,
        exporting: false,
        exportingAction: null,
      };
      render();
      focusRecordsIdentity(settledFocus);
    }
  };

  /** P2/F2 — the review mark lives on the BOUND saved view, so a pack opened by
   *  clicking through the namespace nav has changes to read and nowhere to
   *  record that they were read. Both halves are derived here, together, so the
   *  panel can never offer a "Mark reviewed" button with no view behind it. */
  const reviewBindingFor = (owner: RecordsPackRef): SavedDataView | null => {
    const view = savedViewBinding;
    // ⛔ `savedViewLinked` TOO, not just the binding. `detachSavedView` clears
    // the LINK and leaves `savedViewBinding` populated, so reading the binding
    // alone would keep stamping a mark onto a bookmark the owner explicitly
    // unbound — the one act that says "stop associating this with that view".
    if (view === undefined || !savedViewLinked) return null;
    const definition = view.definition;
    if (definition.tab !== 'records' || definition.owner === null) return null;
    return recordsOwnerKey(definition.owner) === recordsOwnerKey(owner) ? view : null;
  };
  const reviewMarkFor = (owner: RecordsPackRef): SavedDataViewReview | null =>
    reviewBindingFor(owner)?.review ?? null;
  const recordsReviewBinding = (): SavedDataView | null => {
    const namespace = recordsState.selectedNamespace;
    return namespace === null ? null : reviewBindingFor(namespace.owner);
  };

  const refreshRecordsChanges = async (): Promise<void> => {
    const namespace = recordsState.selectedNamespace;
    const caller = opts.recordsChangesListCaller;
    if (namespace === null || caller === undefined || recordsState.changesRefreshing) return;
    const bound = recordsReviewBinding();
    const initialFocus = activeRecordsFocusIdentity();
    recordsState = { ...recordsState, changesRefreshing: true, error: undefined };
    render();
    focusRecordsIdentity(initialFocus);
    try {
      const changes = await caller({
        owner: namespace.owner,
        limit: 50,
        // ⛔ Read from the MARK, never from "recently". An unmarked view shows
        // its most recent page; a marked one shows only what came after.
        ...(bound?.review === undefined ? {} : { after: bound.review.reviewed_through }),
      });
      if (disposed || recordsState.selectedNamespace === null
        || recordsOwnerKey(recordsState.selectedNamespace.owner) !== recordsOwnerKey(namespace.owner)) return;
      recordsState = {
        ...recordsState,
        changes,
        changesRefreshing: false,
        reviewMark: bound?.review ?? null,
        canMarkReviewed: bound !== null && opts.recordsMarkReviewedCaller !== undefined,
        error: undefined,
      };
    } catch (error) {
      if (disposed || recordsState.selectedNamespace === null
        || recordsOwnerKey(recordsState.selectedNamespace.owner) !== recordsOwnerKey(namespace.owner)) return;
      recordsState = { ...recordsState, changesRefreshing: false, error: humanizeRpcError(error) };
    }
    render();
  };

  const markRecordsReviewed = async (): Promise<void> => {
    const caller = opts.recordsMarkReviewedCaller;
    const bound = recordsReviewBinding();
    const next = recordsState.changes?.next;
    if (caller === undefined || bound === null || next === undefined
      || recordsState.markingReviewed) return;
    recordsState = { ...recordsState, markingReviewed: true, error: undefined };
    render();
    try {
      // ⛔ `next` is the cursor of what was ON SCREEN, not `Date.now()`. Anything
      // that landed while the owner was reading is NOT reviewed, and stamping a
      // server clock here would bury it unseen.
      const { view } = await caller({
        id: bound.id, expected_revision: bound.revision, review: next,
      });
      if (disposed) return;
      savedViewBinding = view;
      recordsState = { ...recordsState, markingReviewed: false, reviewMark: view.review ?? null };
      render();
      await refreshRecordsChanges();
    } catch (error) {
      if (disposed) return;
      recordsState = { ...recordsState, markingReviewed: false, error: humanizeRpcError(error) };
      render();
    }
  };

  const refreshRecordsOutbox = async (): Promise<void> => {
    const namespace = recordsState.selectedNamespace;
    const caller = opts.recordsOutboxListCaller;
    if (namespace === null || caller === undefined || recordsState.outboxRefreshing) return;
    const initialFocus = activeRecordsFocusIdentity();
    recordsState = {
      ...recordsState,
      outboxRefreshing: true,
      error: undefined,
    };
    render();
    focusRecordsIdentity(initialFocus);
    try {
      const outbox = await caller({ owner: namespace.owner, limit: 100 });
      if (disposed || recordsState.selectedNamespace === null
        || recordsOwnerKey(recordsState.selectedNamespace.owner) !== recordsOwnerKey(namespace.owner)) return;
      recordsState = {
        ...recordsState,
        outbox,
        outboxRefreshing: false,
        error: undefined,
      };
    } catch (error) {
      if (disposed || recordsState.selectedNamespace === null
        || recordsOwnerKey(recordsState.selectedNamespace.owner) !== recordsOwnerKey(namespace.owner)) return;
      recordsState = {
        ...recordsState,
        outboxRefreshing: false,
        error: humanizeRpcError(error),
      };
    }
    const settledFocus = activeRecordsFocusIdentity();
    render();
    focusRecordsIdentity(settledFocus);
  };

  const retireRecordsEvent = async (eventId: string): Promise<void> => {
    const namespace = recordsState.selectedNamespace;
    const caller = opts.recordsOutboxRetireCaller;
    if (
      namespace === null
      || caller === undefined
      || recordsState.retiringEventId !== eventId
      || recordsState.retiringEventBusy
    ) return;
    const carriedAction = activeRecordsAction();
    const carryFocus =
      carriedAction === RECORDS_CONFIRM_RETIRE_EVENT_ACTION
      || carriedAction === RECORDS_CANCEL_RETIRE_EVENT_ACTION;
    recordsState = {
      ...recordsState,
      outboxOpen: true,
      retiringEventBusy: true,
      error: undefined,
    };
    render();
    if (carryFocus) focusRecordsAction(carriedAction);
    try {
      await caller({ owner: namespace.owner, event_id: eventId, confirmation: eventId });
      if (
        disposed
        || recordsState.selectedNamespace === null
        || recordsOwnerKey(recordsState.selectedNamespace.owner)
          !== recordsOwnerKey(namespace.owner)
      ) return;
      const settledAction = activeRecordsAction();
      const stillOwnsFocus =
        settledAction === RECORDS_CONFIRM_RETIRE_EVENT_ACTION
        || settledAction === RECORDS_CANCEL_RETIRE_EVENT_ACTION
        || settledAction === RECORDS_TOGGLE_OUTBOX_ACTION;
      recordsState = {
        ...recordsState,
        retiringEventId: null,
        retiringEventBusy: false,
        error: undefined,
      };
      // The pending counter is part of the namespace/global quota snapshots.
      await loadRecords(stillOwnsFocus ? eventId : undefined);
      render();
      if (stillOwnsFocus) focusRecordsOutboxSummary();
    } catch (error) {
      if (
        disposed
        || recordsState.selectedNamespace === null
        || recordsOwnerKey(recordsState.selectedNamespace.owner)
          !== recordsOwnerKey(namespace.owner)
      ) return;
      const settledAction = activeRecordsAction();
      recordsState = {
        ...recordsState,
        retiringEventBusy: false,
        error: humanizeRpcError(error),
      };
      render();
      if (settledAction === RECORDS_TOGGLE_OUTBOX_ACTION) {
        focusRecordsOutboxSummary();
      } else if (
        settledAction === RECORDS_CONFIRM_RETIRE_EVENT_ACTION
        || settledAction === RECORDS_CANCEL_RETIRE_EVENT_ACTION
      ) {
        focusRecordsAction(settledAction);
      }
    }
  };

  const purgeRecordsNamespace = async (confirmation: string): Promise<void> => {
    const namespace = recordsState.selectedNamespace;
    const caller = opts.recordsPurgeCaller;
    if (namespace === null || namespace.state.state !== 'orphaned'
      || caller === undefined || recordsState.purging) return;
    const expected = recordsOwnerKey(namespace.owner);
    if (confirmation !== expected) {
      recordsState = {
        ...recordsState,
        error: `Type ${expected} exactly to purge this namespace.`,
      };
      render();
      focusRecordsPurgeInput();
      return;
    }
    const carriedFocus = activeRecordsFocusIdentity();
    const carriedInput = (doc.activeElement as HTMLElement | null)?.hasAttribute(
      RECORDS_PURGE_CONFIRMATION_ATTR,
    ) === true;
    recordsState = { ...recordsState, purging: true, error: undefined };
    render();
    if (carriedInput) focusRecordsPurgeInput();
    else focusRecordsIdentity(carriedFocus);
    try {
      await caller({ owner: namespace.owner, confirmation });
      if (
        disposed
        || recordsState.selectedNamespace === null
        || recordsOwnerKey(recordsState.selectedNamespace.owner) !== expected
      ) return;
      const settledFocus = activeRecordsFocusIdentity();
      const settledInput = (doc.activeElement as HTMLElement | null)?.hasAttribute(
        RECORDS_PURGE_CONFIRMATION_ATTR,
      ) === true;
      const stillOwnsFocus = settledFocus !== null || settledInput;
      recordsState = {
        ...recordsState,
        purging: false,
        purgePending: false,
        purgeConfirmation: '',
      };
      await loadRecords(stillOwnsFocus ? expected : undefined);
      render();
      if (stillOwnsFocus && !focusRecordsIdentity(settledFocus)) {
        focusRecordsTab();
      }
    } catch (error) {
      if (
        disposed
        || recordsState.selectedNamespace === null
        || recordsOwnerKey(recordsState.selectedNamespace.owner) !== expected
      ) return;
      const settledFocus = activeRecordsFocusIdentity();
      const settledInput = (doc.activeElement as HTMLElement | null)?.hasAttribute(
        RECORDS_PURGE_CONFIRMATION_ATTR,
      ) === true;
      recordsState = {
        ...recordsState,
        purging: false,
        error: humanizeRpcError(error),
      };
      render();
      if (settledInput) focusRecordsPurgeInput();
      else focusRecordsIdentity(settledFocus);
    }
  };

  const openRecordsReference = async (entity: string, id: string): Promise<void> => {
    const namespace = recordsState.selectedNamespace;
    if (namespace === null || namespace.schema.entities[entity] === undefined) return;
    if (recordsState.selectedKind !== entity) await selectRecordsKind(entity);
    if (disposed || recordsState.selectedNamespace === null
      || recordsOwnerKey(recordsState.selectedNamespace.owner) !== recordsOwnerKey(namespace.owner)
      || recordsState.selectedKind !== entity) return;
    await openRecordsRecord(id);
  };

  const refreshActive = async (
    silent = false,
    explorerScope?: { tab: DataTabId; slug: string },
  ): Promise<void> => {
    const generation = ++loadGeneration;
    if (activeTab === 'commitment') {
      commitmentListFilter = { ...commitmentViewFilters };
      commitmentListSearch = workEntityState.search_query.trim();
    }
    if (activeTab === 'task') {
      taskListFilter = resolveTaskListFilter(taskViewFilters, (opts.now ?? Date.now)());
      taskListSearch = workEntityState.search_query.trim();
    }
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
      if (!disposed && generation === loadGeneration && activeTab === 'project' && projectWork && !projectEditing
        && workEntityState.dialog?.entity_id === projectWork.project.id) {
        await openEditWorkEntityDialog('project', projectWork.project.id, 'read', true);
      }
    } else if (activeTab === 'search') {
      const resume = initialSearchResume; initialSearchResume = undefined;
      await runUniversalSearch(resume);
    } else if (activeTab === 'calendar') {
      const addressPending = calendarInitialAddress;
      calendarInitialAddress = false;
      if (explorerDetail !== null && explorerSelectedSlug !== null && opts.collectionGetCaller) {
        await readExplorerRecord('calendar', 'calendar', explorerSelectedSlug, explorerDetail.record_id,
          ++explorerSeq, opts.collectionGetCaller);
      } else {
        await refreshCalendarAgenda(silent, explorerScope?.tab === 'calendar' ? explorerScope.slug : undefined,
          addressPending);
      }
    } else if (activeTab === 'records') {
      await loadRecords();
    } else if (activeTab === 'mail_fact') {
      // The tab holds its own loading and error state.
      await mailFacts.refresh(silent);
    } else if (activeTab === 'reminder') {
      // D-324 — so does the Reminders tab.
      await remindersSurface.refresh(silent);
    } else if (isExplorerTab(activeTab) || isSingleCollectionTab(activeTab)) {
      // D-198 Slice 5 — the explorer owns its own async guard (`explorerSeq`) +
      // error state; the outer generation guard below still gates the paint.
      // Phase 2: provenance tabs (annotation / link) load through the same path.
      await loadExplorer(activeTab, explorerScope?.tab === activeTab ? explorerScope.slug : undefined);
    }

    if (disposed || generation !== loadGeneration) return;
    errors = nextErrors;
    loading = false;
    render();
  };

  const startRefresh = (): void => {
    if (taskBulk.busy()) { focusTaskBatch(); return; }
    if (!mailMessageSurface.beforeLeave()) return;
    if (!calendarEventSurface.beforeLeave(startRefresh)) return;
    calendarEventSurface.reset();
    mailMessageSurface.reset();
    pendingLoadPromise = refreshActive();
  };

  interface DebouncedRefresh {
    schedule(stillCurrent: () => boolean): void;
    cancel(): void;
  }
  const createDebouncedRefresh = (delayMs: number): DebouncedRefresh => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let settleScheduled: (() => void) | null = null;
    let scheduleGeneration = 0;
    const cancel = (): void => {
      scheduleGeneration += 1;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      const settle = settleScheduled;
      settleScheduled = null;
      settle?.();
    };
    return {
      cancel,
      schedule: (stillCurrent): void => {
        cancel();
        const generation = scheduleGeneration;
        // A response for an older query must not repaint during the debounce gap.
        loadGeneration += 1;
        if (delayMs <= 0) {
          startRefresh();
          return;
        }
        let settle!: () => void;
        const scheduled = new Promise<void>((resolve) => {
          settle = resolve;
        });
        settleScheduled = settle;
        timer = setTimeout(() => {
          timer = null;
          if (settleScheduled === settle) settleScheduled = null;
          if (
            disposed
            || generation !== scheduleGeneration
            || !stillCurrent()
          ) {
            settle();
            return;
          }
          const refresh = refreshActive();
          pendingLoadPromise = refresh;
          void refresh.then(settle, settle);
        }, delayMs);
        pendingLoadPromise = scheduled;
      },
    };
  };
  const contactSearchRefresh = createDebouncedRefresh(
    opts.contactSearchDebounceMs ?? 180,
  );
  const bookingSearchRefresh = createDebouncedRefresh(
    opts.bookingSearchDebounceMs ?? 180,
  );
  const taskSearchRefresh = createDebouncedRefresh(opts.taskSearchDebounceMs ?? 180);
  const commitmentSearchRefresh = createDebouncedRefresh(180);

  /** ⚠ ITS OWN TIMER, NOT `createDebouncedRefresh`. That helper debounces the
   *  route's whole-page `startRefresh()`, which re-reads every lens; this loader
   *  is self-contained and repaints itself, so borrowing the shared one would
   *  reload the world on every keystroke to fetch one list. */
  let universalSearchTimer: ReturnType<typeof setTimeout> | null = null;
  /** Capability hits are a hint, not a browse — a long list of recipes would
   *  bury the records the owner was probably looking for. */
  const RECIPE_SEARCH_LIMIT = 5;
  const PACK_SEARCH_LIMIT = 5;
  const MARKET_SEARCH_LIMIT = 6;

  /** Retire replies at the edit/navigation boundary, before the next debounce.
   * A query comparison alone misses an edit away and back to the same words. */
  const retireUniversalSearch = (): void => {
    assetSearch.reset();
    universalSearchSeq += 1;
    universalSearchMarketSeq += 1;
    if (universalSearchTimer !== null) clearTimeout(universalSearchTimer);
    universalSearchTimer = null;
    universalSearchGroups = undefined;
    universalSearchContacts = []; universalSearchContactTotal = 0; universalSearchContactOffset = 0;
    universalSearchContactMore = false; universalSearchContactLoading = false; universalSearchContactError = undefined;
    universalSearchContactPageSeq += 1;
    universalSearchWorkGroups = undefined;
    universalSearchWorkLoading = false;
    universalSearchWorkError = undefined;
    universalSearchWorkLoadingKinds.clear();
    universalSearchWorkOffsets.clear();
    universalSearchWorkPageSeq.clear();
    universalSearchDidYouMean = undefined;
    universalSearchAbsentWords = undefined;
    universalSearchRecipes = [];
    universalSearchPacks = [];
    universalSearchMarket = [];
    universalSearchMarketQuery = '';
    universalSearchMarketError = undefined;
    universalSearchMarketLoading = false;
    universalSearchLoading = false;
    universalSearchCapabilitiesLoading = false;
    universalSearchCapabilitiesError = undefined;
    universalSearchError = undefined;
  };

  const runUniversalSearch = async (resume = { records: true, work: true, contacts: true, capabilities: true }): Promise<void> => {
    if (disposed || activeLens !== 'data' || activeTab !== 'search') return;
    const caller = opts.collectionSearchAllCaller;
    const query = universalSearchQuery.trim();
    if (query === '') {
      retireUniversalSearch();
      render();
      return;
    }
    const seq = ++universalSearchSeq;
    universalSearchNavigation = navigationGeneration;
    const isCurrent = (): boolean => !disposed
      && seq === universalSearchSeq && universalSearchNavigation === navigationGeneration
      && activeLens === 'data' && (activeTab === 'search' || workSearchReturn?.sequence === seq || contactSearchReturn?.sequence === seq)
      && query === universalSearchQuery.trim();
    if (resume.records) {
      universalSearchLoading = true; universalSearchGroups = undefined;
      universalSearchDidYouMean = undefined; universalSearchAbsentWords = undefined; universalSearchError = undefined;
    }
    if (resume.capabilities) {
      universalSearchCapabilitiesLoading = true; universalSearchCapabilitiesError = undefined;
      universalSearchRecipes = []; universalSearchPacks = [];
    }
    if (resume.contacts) {
      universalSearchContacts = []; universalSearchContactTotal = 0; universalSearchContactOffset = 0;
      universalSearchContactMore = false; universalSearchContactLoading = false; universalSearchContactError = undefined;
      universalSearchContactPageSeq += 1;
    }
    if (resume.work) {
      universalSearchWorkGroups = undefined; universalSearchWorkLoading = opts.workEntitySearchCaller !== undefined;
      universalSearchWorkError = undefined; universalSearchWorkLoadingKinds.clear();
      universalSearchWorkOffsets.clear(); universalSearchWorkPageSeq.clear();
    }
    // A new local search retires any marketplace answer: it belonged to the
    // previous query, and leaving it up would attach cloud results to words the
    // owner never sent.
    if (universalSearchMarketQuery !== query) {
      universalSearchMarket = [];
      universalSearchMarketError = undefined;
    }
    render();
    // Each branch paints as it settles. In particular a slow capability list
    // must neither delay starting the record search nor hide its ready rows.
    const recordSearch = (async (): Promise<void> => {
      if (!resume.records) return;
      try {
        if (caller === undefined) throw new Error('This server cannot search mail, calendar or files.');
        const { groups, did_you_mean: didYouMean, absent_words: absentWords } = await caller({ query });
        if (!isCurrent()) return;
        universalSearchGroups = groups;
        universalSearchDidYouMean = didYouMean;
        universalSearchAbsentWords = absentWords;
        universalSearchError = undefined;
      } catch (err) {
        if (!isCurrent()) return;
        universalSearchGroups = undefined;
        universalSearchDidYouMean = undefined;
        universalSearchAbsentWords = undefined;
        universalSearchError = humanizeRpcError(err);
      } finally {
        if (isCurrent()) {
          universalSearchLoading = false;
          if (activeTab === 'search') render();
        }
      }
    })();
    const workSearch = (async (): Promise<void> => {
      if (!resume.work || !opts.workEntitySearchCaller) return;
      try {
        const result = await opts.workEntitySearchCaller({ query });
        if (!isCurrent()) return;
        universalSearchWorkUnsupported = false;
        universalSearchWorkGroups = result.groups;
        for (const group of result.groups) universalSearchWorkOffsets.set(group.kind, group.offset + group.matches.length);
      } catch (error) {
        if (!isCurrent()) return;
        // A server before 26.10.28 cannot search these kinds. Retrying cannot help, so it is not a
        // failure: the box says to update the server, and the rest completes the search.
        if (classifyRpcError(error).code === 'unknown_method') universalSearchWorkUnsupported = true;
        else universalSearchWorkError = `Tasks, notes, projects and commitments could not be searched. ${humanizeRpcError(error)}`;
      } finally {
        if (isCurrent()) {
          universalSearchWorkLoading = false;
          if (activeTab === 'search') render();
        }
      }
    })();
    // Recipe and pack lists settle together to preserve pack/member absorption.
    // A failed lookup leaves the other results usable, but cannot establish an
    // empty search or justify a marketplace offer.
    const capabilityErrors: string[] = [];
    const recipeRead = (async (): Promise<ServerRecipeListEntry[]> => {
      const listCaller = opts.recipeListCaller;
      if (!resume.capabilities || listCaller === undefined) return [];
      try {
        return (await listCaller()).recipes.slice();
      } catch {
        capabilityErrors.push('Installed recipes could not be searched.');
        return [];
      }
    })();
    const packRead = (async (): Promise<ReadonlyArray<RosterPack>> => {
      const packCaller = opts.packInstalledListCaller;
      if (!resume.capabilities || packCaller === undefined) return [];
      try {
        return (await packCaller()).packs// ⚠ `installed_any_version` too: a pack installed at a DIFFERENT version than
        // the server bundle is still one the owner has, and omitting it would hide
        // a capability they demonstrably possess.
        .filter((p) => p.installed || p.installed_any_version === true);
      } catch {
        capabilityErrors.push('Installed packs could not be searched.');
        return [];
      }
    })();
    const capabilitySearch = (async (): Promise<void> => {
      if (!resume.capabilities) return;
      const [recipeList, packList] = await Promise.all([recipeRead, packRead]);
      if (!isCurrent()) return;

      universalSearchPacks = rankSearchable(
        packList,
        (p) => ({
          name: p.name ?? p.slug,
          ...(p.description !== undefined ? { description: p.description } : {}),
        }),
        query,
        PACK_SEARCH_LIMIT,
      ).map((p) => ({
        slug: p.slug,
        name: p.name ?? p.slug,
        ...(p.description !== undefined ? { description: p.description } : {}),
        ...(p.publisher !== undefined ? { publisher: p.publisher } : {}),
      }));

      // ⛔⛔ A MEMBER IS ABSORBED ONLY WHEN ITS PACK ALSO MATCHED. Suppressing every
      // bundled recipe outright looks tidier and LOSES REAL HITS: measured on the
      // shipped corpus, `recued-core/fleet-money` carries a recipe called
      // "Settlements" and the pack's own text contains none of that word — so an
      // owner searching "settlements" for a recipe they demonstrably have would
      // get nothing. Same capability at two granularities collapses to the pack;
      // a member whose pack did not match still surfaces, attributed to it.
      const matchedPackSlugs = new Set(universalSearchPacks.map((p) => p.slug));
      const bundleSlug = (bundle: string): string => bundle.split('/').pop() ?? bundle;
      universalSearchRecipes = rankSearchable(
        recipeList,
        (r) => ({
          name: r.recipe.metadata.name,
          description: r.recipe.metadata.description,
          ...(r.recipe.metadata.tags !== undefined ? { tags: r.recipe.metadata.tags } : {}),
        }),
        query,
        RECIPE_SEARCH_LIMIT,
      ).filter((r) => {
        const bundle = r.recipe.metadata.recipe_bundle;
        return bundle === undefined || !matchedPackSlugs.has(bundleSlug(bundle));
      }).map((r) => {
        const bundle = r.recipe.metadata.recipe_bundle;
        return {
          recipe_id: r.recipe_id,
          name: r.recipe.metadata.name,
          description: r.recipe.metadata.description,
          publisher_id: r.publisher_id,
          ...(bundle !== undefined ? { bundle } : {}),
        };
      });
      universalSearchCapabilitiesLoading = false;
      universalSearchCapabilitiesError = capabilityErrors.length > 0 ? capabilityErrors.join(' ') : undefined;
      if (activeTab === 'search') render();
    })();
    await Promise.all([recordSearch, workSearch, capabilitySearch, resume.contacts ? loadUniversalContactSearch(true) : Promise.resolve(), assetSearch.load(query)]);
  };

  const loadUniversalContactSearch = async (replace = false): Promise<void> => {
    const caller = opts.contactListCaller;
    if (!caller || universalSearchContactLoading) return;
    const sequence = universalSearchSeq, page = ++universalSearchContactPageSeq;
    const query = universalSearchQuery.trim();
    if (!query) return;
    const current = () => !disposed && sequence === universalSearchSeq && page === universalSearchContactPageSeq
      && query === universalSearchQuery.trim() && universalSearchNavigation === navigationGeneration
      && (activeTab === 'search' || workSearchReturn?.sequence === sequence || contactSearchReturn?.sequence === sequence);
    const previous = universalSearchContacts;
    let offset = replace ? 0 : universalSearchContactOffset;
    const goal = replace ? Math.max(5, previous.length) : offset + 10;
    const matches: ContactRecord[] = replace ? [] : [...previous];
    let total = universalSearchContactTotal;
    universalSearchContactLoading = true; universalSearchContactError = undefined;
    if (activeTab === 'search') render();
    try {
      do {
        const result = await caller({ query, offset, limit: Math.min(100, goal - offset) });
        if (!current()) return;
        if (!Array.isArray(result.contacts) || !Number.isSafeInteger(result.total) || result.total < 0
          || result.total > offset && result.contacts.length === 0) throw new Error('The contact search page could not be confirmed. Try again.');
        const known = new Set(matches.map(contact => contact.email));
        matches.push(...result.contacts.filter(contact => !known.has(contact.email)));
        offset += result.contacts.length; total = result.total;
      } while (offset < total && offset < goal);
      universalSearchContacts = matches; universalSearchContactTotal = total;
      universalSearchContactOffset = offset; universalSearchContactMore = offset < total;
      universalSearchContactUnsupported = false;
      const owner = doc.activeElement;
      if (activeTab === 'search' && owner?.getAttribute(DATA_ROUTE_ACTION_ATTR) === SEARCH_MORE_CONTACTS_ACTION) {
        const known = new Set(previous.map(contact => contact.email));
        const next = matches.find(contact => !known.has(contact.email)) ?? matches.at(-1);
        if (next) pendingContactSearchRestore = { email: next.email, scrollTop: workSearchScrollHost()?.scrollTop ?? 0 };
      }
    } catch (error) {
      if (!current()) return;
      universalSearchContactUnsupported = classifyRpcError(error).code === 'unknown_method';
      universalSearchContactError = universalSearchContactUnsupported ? undefined : humanizeRpcError(error);
    } finally {
      if (current()) { universalSearchContactLoading = false; if (activeTab === 'search') render(); }
    }
  };

  const loadMoreWorkSearch = async (kind: WorkEntitySearchKind, replace = false): Promise<void> => {
    const caller = opts.workEntitySearchCaller;
    const group = universalSearchWorkGroups?.find(value => value.kind === kind);
    if (!caller || !group || !replace && universalSearchWorkLoadingKinds.has(kind)) return;
    const sequence = universalSearchSeq;
    const pageSequence = (universalSearchWorkPageSeq.get(kind) ?? 0) + 1;
    universalSearchWorkPageSeq.set(kind, pageSequence);
    const query = universalSearchQuery.trim();
    const current = () => !disposed && sequence === universalSearchSeq
      && pageSequence === universalSearchWorkPageSeq.get(kind) && query === universalSearchQuery.trim()
      && universalSearchNavigation === navigationGeneration
      && (activeTab === 'search' || workSearchReturn?.sequence === sequence || contactSearchReturn?.sequence === sequence);
    universalSearchWorkLoadingKinds.add(kind);
    if (activeTab === 'search') render();
    let offset = replace ? 0 : universalSearchWorkOffsets.get(kind) ?? group.matches.length;
    const goal = replace ? Math.max(5, group.matches.length) : offset + 10;
    const matches = replace ? [] : [...group.matches];
    let more = true;
    try {
      do {
        const result = await caller({ query, kind, limit: Math.min(50, goal - offset), offset });
        if (!current()) return;
        const page = result.groups.find(value => value.kind === kind);
        if (!page || page.offset !== offset) throw new Error('The search page could not be confirmed. Try again.');
        if (page.error) throw new Error(page.error);
        if (page.more && page.matches.length === 0) throw new Error('The search page did not advance. Try again.');
        const known = new Set(matches.map(match => match.id));
        matches.push(...page.matches.filter(match => !known.has(match.id)));
        offset += page.matches.length;
        more = page.more;
      } while (more && offset < goal);
      universalSearchWorkOffsets.set(kind, offset);
      universalSearchWorkGroups = universalSearchWorkGroups?.map(value => value.kind === kind
        ? { kind, matches, offset: 0, more } : value);
      const owner = doc.activeElement;
      if ((!replace || group.error) && activeTab === 'search' && owner?.getAttribute(DATA_ROUTE_ACTION_ATTR) === SEARCH_MORE_WORK_ACTION
        && owner.getAttribute(SEARCH_WORK_KIND_ATTR) === kind) {
        const previousIds = new Set(group.matches.map(match => match.id));
        const next = matches.find(match => !previousIds.has(match.id)) ?? matches.at(-1);
        if (next) pendingWorkSearchRestore = { kind, id: next.id, scrollTop: workSearchScrollHost()?.scrollTop ?? 0 };
      }
    } catch (error) {
      if (!current()) return;
      universalSearchWorkGroups = universalSearchWorkGroups?.map(value => value.kind === kind
        ? { ...value, error: humanizeRpcError(error) } : value);
    } finally {
      if (current()) {
        universalSearchWorkLoadingKinds.delete(kind);
        if (activeTab === 'search') render();
      }
    }
  };

  /** ⛔ OWNER-INITIATED. Never called from the input path — see the caller's
   *  contract. Typing must not become a stream of cloud queries. */
  const runMarketplaceSearch = async (): Promise<void> => {
    const caller = opts.marketplacePackSearchCaller;
    const query = universalSearchQuery.trim();
    if (disposed || activeLens !== 'data' || activeTab !== 'search'
      || caller === undefined || query === '' || universalSearchMarketLoading
      || universalSearchLoading || universalSearchCapabilitiesLoading
      || universalSearchCapabilitiesError !== undefined
      || assetSearch.state().loading || assetSearch.state().error !== undefined || assetSearch.state().unsupported
      || assetSearch.state().matches.length > 0
      || universalSearchContactLoading || universalSearchContactError !== undefined || universalSearchContactUnsupported
      || universalSearchContacts.length > 0
      || universalSearchWorkLoading || universalSearchWorkError !== undefined
      || universalSearchWorkGroups?.some(group => group.error || group.matches.length > 0)
      || universalSearchError !== undefined || universalSearchGroups === undefined
      || universalSearchGroups.length > 0 || universalSearchRecipes.length > 0
      || universalSearchPacks.length > 0) return;
    const seq = ++universalSearchMarketSeq;
    const navigation = navigationGeneration;
    const isCurrent = (): boolean => !disposed
      && seq === universalSearchMarketSeq && navigation === navigationGeneration
      && activeLens === 'data' && activeTab === 'search'
      && query === universalSearchQuery.trim();
    universalSearchMarketLoading = true;
    universalSearchMarketQuery = query;
    universalSearchMarketError = undefined;
    render();
    try {
      const { packs } = await caller(query);
      if (!isCurrent()) return;
      universalSearchMarketQuery = query;
      universalSearchMarket = packs.slice(0, MARKET_SEARCH_LIMIT).map((p) => ({
        slug: p.slug,
        name: p.name,
        ...(p.description !== undefined ? { description: p.description } : {}),
        ...(p.publisher_id !== undefined ? { publisher_id: p.publisher_id } : {}),
      }));
    } catch (err) {
      if (!isCurrent()) return;
      universalSearchMarket = [];
      universalSearchMarketError = humanizeRpcError(err);
    } finally {
      if (isCurrent()) {
        universalSearchMarketLoading = false;
        render();
      }
    }
  };

  const scheduleUniversalSearch = (): void => {
    if (universalSearchTimer !== null) clearTimeout(universalSearchTimer);
    const scheduled = universalSearchQuery;
    universalSearchTimer = setTimeout(() => {
      universalSearchTimer = null;
      // Still the same query, still on this tab — otherwise the keystroke that
      // scheduled this is no longer what the owner is looking at.
      if (disposed || activeTab !== 'search' || universalSearchQuery !== scheduled) return;
      void runUniversalSearch();
    }, opts.universalSearchDebounceMs ?? 180);
  };

  const scheduleContactSearchRefresh = (): void => {
    const scheduledSearch = contactSearch;
    contactSearchRefresh.schedule(() =>
      activeLens === 'data'
      && activeTab === 'contact'
      && contactSearch === scheduledSearch);
  };

  // R18 — reflect the current (tab, open-entity) as `#data/<tab>/<id>` through
  // the shared hierarchy. A list→detail visit pushes; sideways/closing changes
  // replace, and neither remounts the shell. Reads state so the URL always
  // matches what's rendered; history failures remain best-effort.
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
    if (activeTab === 'records' && recordsState.detail) return recordsState.detail.id;
    if (activeTab === 'booking' && bookingDetailId !== null) {
      return bookingDetailId;
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
  /** ⛔ THE SURFACE COMES FROM THE HASH, NOT FROM THIS MODULE'S NAME. While a
   *  saved view is bound this route addresses as `views` (D-291) and the moment
   *  its filters diverge it addresses as `data` again — one route, two
   *  surfaces, decided per navigation. Hardcoding `'data'` here made
   *  `hierarchicalAddressFromHash` throw the instant the parser re-pointed
   *  `#data/view/...`, which is the same way the D-290 Today rewrite broke its
   *  own route. */
  /** D-315 §6 — Mail facts has a third level: `#data/mail_fact/<view>` (a
   *  view is a sideways move, so switching one replaces the entry), then a
   *  detail inside a view (a deeper place, so opening one pushes). */
  const mailFactLevels = () => {
    const [view, detail] = mailFacts.addressSegments();
    return [
      ...(view !== undefined ? [hierarchicalLevel(`data-mail-fact-view:${view}`, view)] : []),
      ...(detail !== undefined ? [hierarchicalLevel(`data-detail:${detail}`, detail)] : []),
    ];
  };
  const dataAddress = (
    hash: string,
    deepLinkEntity: string | undefined,
  ) => hierarchicalAddressFromHash(
    parseShellRoute(hash).surface,
    hash,
    ...(activeLens === 'memory'
      ? [hierarchicalLevel('data-lens:memory', 'memory')]
      : [
          hierarchicalLevel(`data-tab:${activeTab}`, activeTab),
          ...(activeTab === 'mail_fact' && parseShellRoute(hash).surface === 'data'
            ? mailFactLevels()
            : deepLinkEntity === undefined
            ? []
            : [hierarchicalLevel(
                `data-detail:${deepLinkEntity}`,
                deepLinkEntity,
              )]),
        ]),
  );
  /** Seed from the parsed deep-link input, not asynchronously hydrated state.
   * The shared controller therefore cannot mistake first paint for a new detail
   * visit, while later source-record canonicalization remains a replace. */
  const initialDataEntity = activeLens === 'data'
    ? opts.initialEntityId
    : undefined;
  const dataHistory = createHierarchicalHistory({
    initial: dataAddress(
      opts.savedView !== undefined
        ? serializeShellRoute('views', opts.savedView.id)
        : activeLens === 'memory'
        ? serializeShellRoute('data', 'memory')
        : activeTab === 'mail_fact'
        ? serializeShellRoute('data', activeTab, ...mailFacts.addressSegments())
        : serializeShellRoute('data', activeTab, initialDataEntity),
      initialDataEntity,
    ),
    history: () => doc.defaultView?.history,
    onCommit: (address) => opts.onHashSync?.(address.hash),
  });
  let savedViewLinked = opts.savedView !== undefined;
  let savedViewBinding = opts.savedView;
  const syncDataHash = (): void => {
    const definition = currentView();
    if (savedViewLinked && savedViewBinding !== undefined && definition !== null
      && sameSavedDataViewDefinition(definition, savedViewBinding.definition)) {
      dataHistory.navigate(dataAddress(serializeShellRoute('views', savedViewBinding.id), undefined));
      return;
    }
    // D-198 Slice 1b — the Memory lens addresses as `#data/memory` (no entity
    // segment); the Data lens keeps `#data/<tab>/<entity>`.
    const exactSourceRecordTab: SourceRecordDataTab | null =
      activeTab === 'mail' || activeTab === 'calendar' || activeTab === 'files'
        ? activeTab
        : null;
    const deepLinkEntity = currentDeepLinkEntity();
    const hash =
      activeLens === 'memory'
        ? serializeShellRoute('data', 'memory')
        : activeTab === 'records' && recordsState.selectedNamespace && recordsState.selectedKind && recordsState.detail
          ? recordsRecordAddress({owner:recordsState.selectedNamespace.owner,entity:recordsState.selectedKind,id:recordsState.detail.id})
        : activeTab === 'mail_fact'
          ? serializeShellRoute('data', activeTab, ...mailFacts.addressSegments())
        : exactSourceRecordTab !== null
          && explorerSelectedSlug !== null
          && explorerDetail !== null
          ? serializeSourceRecordAddress({
              tab: exactSourceRecordTab,
              collectionSlug: explorerSelectedSlug,
              recordId: explorerDetail.record_id,
              ...(activeLogsReturn !== undefined
                ? {
                    returnToRun: activeLogsReturn,
                    ...(activeVerificationRelationship !== undefined
                      ? {
                          verificationRelationship:
                            activeVerificationRelationship,
                        }
                      : {}),
                  }
                : opts.chatReturn !== undefined
                  ? { returnToChat: opts.chatReturn }
                  : {}),
            })
          : activeLogsReturn !== undefined
            && pendingExplorerVerificationTab !== null
            && activeTab === pendingExplorerVerificationTab
            && pendingExplorerVerificationRecordId !== null
            ? serializeSourceRecordVerificationAddress({
                tab: pendingExplorerVerificationTab,
                recordId: pendingExplorerVerificationRecordId,
                returnToRun: activeLogsReturn,
                ...(activeVerificationRelationship !== undefined
                  ? {
                      verificationRelationship:
                        activeVerificationRelationship,
                    }
                  : {}),
              })
          : activeLogsReturn !== undefined
            && deepLinkEntity !== undefined
            && isRunAddressableDataTab(activeTab)
            ? serializeDataEntityVerificationAddress({
                tab: activeTab,
                entityId: deepLinkEntity,
                returnToRun: activeLogsReturn,
                ...(activeVerificationRelationship !== undefined
                  ? {
                      verificationRelationship:
                        activeVerificationRelationship,
                    }
                  : {}),
              })
            : serializeShellRoute('data', activeTab, deepLinkEntity);
    const fromSearch = activeTab === 'contact' && contactSearchReturn
      && deepLinkEntity === contactSearchReturn.email && dataHistory.current().hash === contactSearchReturn.hash;
    const fromAgenda = activeTab === 'calendar' && calendarAgendaReturn
      && explorerDetail !== null && dataHistory.current().hash === calendarAgendaReturn.hash;
    dataHistory.navigate(dataAddress(hash, deepLinkEntity), fromSearch || fromAgenda ? { intent: 'push' } : undefined);
  };

  const cancelContactEditOpen = (): void => {
    contactEditOpenSeq += 1;
    openingContactEditEmail = null;
    pendingContactEditFocusEmail = null;
  };

  const selectTab = async (
    tab: DataTabId,
    focusActivatedTab = false,
    sourceSlug?: string,
    preserveWorkSearch = false,
  ): Promise<void> => {
    if (activeTab === tab && sourceSlug === undefined) return;
    if (taskBulk.busy()) { focusTaskBatch(); return; }
    if (!mailMessageSurface.beforeLeave()) return;
    if (!calendarEventSurface.beforeLeave(() => { void selectTab(tab, focusActivatedTab, sourceSlug, preserveWorkSearch); })) return;
    if (!calendarCreateSurface.beforeLeave(() => { void selectTab(tab, focusActivatedTab, sourceSlug, preserveWorkSearch); })) return;
    if (activeTab === 'reminder' && !remindersSurface.beforeLeave()) return;
    if (hasRecordsInFlightWork()) {
      focusRecordsInFlightOwner();
      return;
    }
    if (savingFormResponse) return;
    if (formResponseDiscardGuardOpen) {
      focusFormResponseDiscardGuard();
      return;
    }
    if (memoryComposeDiscardGuardOpen) {
      focusMemoryComposeDiscardGuard();
      return;
    }
    if (
      formResponseDetailId !== null
      && hasUnsavedFormResponseEditor()
    ) {
      showFormResponseDiscardGuard(tab);
      return;
    }
    if (tab === 'search' && activeTab === 'contact' && contactSearchReturn && !preserveWorkSearch) { returnToContactSearch(); return; }
    if (focusActivatedTab) pendingCollectionTabFocus = tab;
    if (activeTab === 'search' && !preserveWorkSearch) retireUniversalSearch();
    if (!preserveWorkSearch) {
      workSearchReturn = null; contactSearchReturn = null; pendingContactSearchRestore = null;
      projectWork?.dispose(); projectWork = null; projectChildReturn = null; pendingProjectRestore = null;
    }
    navigationGeneration += 1;
    if (preserveWorkSearch) universalSearchNavigation = navigationGeneration;
    timelineLoadGeneration += 1;
    loadingTimeline = false;
    retireRunVerification();
    workEntityDialogOpenSeq += 1;
    pendingWorkEntityDialogOpen = null;
    workEntityDialogReturnFocus = null;
    loadingWorkEntityDetail = false;
    cancelContactEditOpen();
    taskBulk.reset();
    activeTab = tab;
    contactDialog = null;
    contactDialogReturnFocus = null;
    retireContactDialogDraft();
    resetFormResponseAutomation();
    formResponseDetailSeq += 1;
    formResponseDetailId = null;
    formResponseDetail = null;
    formResponseEditorDraft = null;
    retireFormResponseEditorDraft();
    pendingFormResponseEditorFocus = null;
    formResponseDetailError = null;
    loadingFormResponseDetail = false;
    formResponseSaveError = null;
    bookingDetailSeq += 1;
    bookingDetailId = null;
    bookingDetail = null;
    bookingDetailError = null;
    loadingBookingDetail = false;
    resetBookingManageLinkState();
    // An entity_id from one mirror kind doesn't apply to another (the
    // timeline display is kind-gated anyway) — start each tab fresh.
    timelineEntityId = '';
    // D-198 Slice 5 — drop any prior explorer records/detail; `refreshActive`
    // reloads for the new tab if it's an explorer tab.
    resetExplorerState();
    resetRecordsState();
    if (isWorkEntityTab(tab)) {
      workEntityState = selectKindTransition(workEntityState, tab);
    }
    // ⛔ NOT WHEN THE CALLER IS CLAIMING THE TAB ITSELF. `focusActivatedTab` is
    // collection navigation path (the tablist or mobile picker), which must
    // leave focus on that control so the owner can keep changing collections.
    // Claiming the search box there ejected a keyboard user from navigation.
    if (tab === 'search' && !focusActivatedTab) pendingUniversalSearchFocus = true;
    if (tab === 'contact' && preserveWorkSearch && contactSearchReturn) {
      // A search hit already addresses the profile. The list and Source-health
      // reads behind it are independent and must not delay opening it.
      loadGeneration += 1;
      loading = false;
      pendingLoadPromise = openContactDetail(contactSearchReturn.email, true);
    } else {
      syncDataHash();
      const scope = sourceSlug === undefined ? undefined : { tab, slug: sourceSlug };
      pendingLoadPromise = refreshActive(false, scope);
    }
    await pendingLoadPromise;
  };

  const workSearchScrollHost = (): Element | null => {
    // Embedded Data views can scroll with the document; the content marker
    // alone does not establish a scroll container.
    let node: HTMLElement | null = routeRoot;
    while (node) {
      const overflow = doc.defaultView?.getComputedStyle?.(node)?.overflowY;
      if (node.scrollHeight > node.clientHeight && overflow && /^(auto|scroll|overlay|hidden)$/.test(overflow)) return node;
      node = node.parentElement;
    }
    return doc.scrollingElement;
  };

  const returnToContactSearch = (alreadyNavigated = false): void => {
    const origin = contactSearchReturn;
    if (!origin || disposed) return;
    contactSearchReturn = null; contactDetail = null; loadingContactDetail = false;
    cancelContactEditOpen(); pendingContactDetailFocusEmail = null;
    loadGeneration += 1; navigationGeneration += 1; universalSearchNavigation = navigationGeneration;
    activeTab = 'search'; loading = false; errors = {}; universalSearchQuery = origin.query;
    pendingContactSearchRestore = origin;
    if (alreadyNavigated) dataHistory.adopt(dataAddress(origin.hash, undefined));
    else syncDataHash();
    render();
    void loadUniversalContactSearch(true);
  };

  const openContactSearchResult = async (email: string): Promise<void> => {
    if (activeTab !== 'search' || !universalSearchContacts.some(contact => contact.email === email)) return;
    const sequence = universalSearchSeq;
    contactSearchReturn = { sequence, query: universalSearchQuery, email,
      scrollTop: workSearchScrollHost()?.scrollTop ?? 0, hash: dataHistory.current().hash };
    const previousNavigation = navigationGeneration;
    const opening = selectTab('contact', false, undefined, true);
    if (navigationGeneration === previousNavigation) contactSearchReturn = null;
    await opening;
  };

  const returnToWorkSearch = (): void => {
    const origin = workSearchReturn;
    if (!origin || disposed) return;
    workSearchReturn = null;
    loadGeneration += 1;
    workEntityDialogOpenSeq += 1;
    pendingWorkEntityDialogOpen = null;
    loadingWorkEntityDetail = false;
    workEntityState = closeDialogTransition(workEntityState);
    retireWorkEntityDialogDraft();
    navigationGeneration += 1;
    universalSearchNavigation = navigationGeneration;
    activeTab = 'search'; loading = false;
    universalSearchQuery = origin.query;
    errors = {};
    pendingWorkSearchRestore = origin;
    syncDataHash(); render();
    void loadMoreWorkSearch(origin.kind, true);
  };

  const openWorkSearchResult = async (kind: WorkEntitySearchKind, id: string): Promise<void> => {
    const atDestination = () => activeTab === kind;
    if (activeTab !== 'search' || !universalSearchWorkGroups?.some(group => group.kind === kind
      && group.matches.some(match => match.id === id))) return;
    const sequence = universalSearchSeq;
    const scrollTop = workSearchScrollHost()?.scrollTop ?? 0;
    workSearchReturn = { sequence, query: universalSearchQuery, kind, id, scrollTop };
    const previousNavigation = navigationGeneration;
    const opening = selectTab(kind, false, undefined, true);
    const navigation = navigationGeneration;
    if (navigation === previousNavigation) { workSearchReturn = null; return; }
    await opening;
    if (disposed || navigation !== navigationGeneration || workSearchReturn?.sequence !== sequence || !atDestination()) return;
    await openEditWorkEntityDialog(kind, id);
  };

  /** Search names an exact source. Let the explorer load its roster and that
   * source in order, then open a record only while this navigation still owns
   * both the tab and source. A later click, Back, or disposal retires the work. */
  const openSearchDestination = async (
    tab: DataTabId,
    slug: string,
    recordId?: string,
  ): Promise<void> => {
    if (disposed || activeLens !== 'data') return;
    const previousNavigation = navigationGeneration;
    if (tab === 'calendar') calendarInitialAddress = recordId !== undefined;
    const opening = selectTab(tab, true, slug);
    const navigation = navigationGeneration;
    const explorerGeneration = explorerSeq;
    await opening;
    if (
      disposed || navigation === previousNavigation
      || navigation !== navigationGeneration || explorerGeneration !== explorerSeq
      || activeLens !== 'data' || activeTab !== tab
      || explorerSelectedSlug !== slug
      || !explorerInstances.some(instance => instance.slug === slug)
    ) return;
    if (recordId !== undefined) await openExplorerRecord(recordId);
  };

  // D-198 Slice 1b — switch the Data | Memory lens. Orthogonal to the tab; the
  // Data lens preserves its active tab + open detail when you come back.
  const selectLens = async (lens: 'data' | 'memory'): Promise<void> => {
    if (taskBulk.busy()) { focusTaskBatch(); return; }
    if (lens !== activeLens && !mailMessageSurface.beforeLeave()) return;
    if (lens !== activeLens && !calendarEventSurface.beforeLeave(() => { void selectLens(lens); })) return;
    if (lens !== activeLens && !calendarCreateSurface.beforeLeave(() => { void selectLens(lens); })) return;
    if (lens !== activeLens && activeTab === 'reminder' && !remindersSurface.beforeLeave()) return;
    if (hasRecordsInFlightWork()) {
      focusRecordsInFlightOwner();
      return;
    }
    if (memoryFilteringOrigin !== null) {
      focusMemoryOriginFilter(memoryFilteringOrigin);
      return;
    }
    if (memoryExporting) {
      focusMemoryExport();
      return;
    }
    if (activeLens === lens) return;
    if (savingFormResponse) return;
    if (memoryDeletingId !== null) {
      focusMemoryDeleteConfirm(memoryDeletingId);
      return;
    }
    if (memoryEditOpeningId !== null) {
      focusMemoryEditAction(memoryEditOpeningId);
      return;
    }
    if (formResponseDiscardGuardOpen) {
      focusFormResponseDiscardGuard();
      return;
    }
    if (memoryComposeDiscardGuardOpen) {
      focusMemoryComposeDiscardGuard();
      return;
    }
    if (memoryImportDiscardGuardOpen) {
      focusMemoryImportDiscardGuard();
      return;
    }
    if (memoryCompose.submitting) {
      focusMemoryComposeSave();
      return;
    }
    if (memoryImport.submitting) {
      focusMemoryImportSubmit();
      return;
    }
    if (activeTab === 'search') retireUniversalSearch();
    workSearchReturn = null; contactSearchReturn = null; pendingContactSearchRestore = null;
    projectWork?.dispose(); projectWork = null; projectChildReturn = null; pendingProjectRestore = null;
    pendingWorkSearchRestore = null;
    navigationGeneration += 1;
    retireRunVerification();
    workEntityDialogOpenSeq += 1;
    pendingWorkEntityDialogOpen = null;
    workEntityDialogReturnFocus = null;
    loadingWorkEntityDetail = false;
    cancelContactEditOpen();
    if (lens === 'memory') closeFormResponseRunModal();
    taskBulk.reset();
    activeLens = lens;
    syncDataHash();
    pendingLoadPromise = refreshActive();
    await pendingLoadPromise;
  };

  const setMemoryOriginFilter = async (filter: MemoryOriginFilter): Promise<void> => {
    if (memoryFilteringOrigin !== null) {
      focusMemoryOriginFilter(memoryFilteringOrigin);
      return;
    }
    if (memoryExporting) {
      focusMemoryExport();
      return;
    }
    if (memoryOriginFilter === filter && memoryError === undefined) return;
    if (memoryDeletingId !== null) {
      focusMemoryDeleteConfirm(memoryDeletingId);
      return;
    }
    if (memoryEditOpeningId !== null) {
      focusMemoryEditAction(memoryEditOpeningId);
      return;
    }
    memoryOriginFilter = filter;
    memoryFilteringOrigin = filter;
    memoryEntries = [];
    memoryError = undefined;
    pendingLoadPromise = refreshActive();
    await pendingLoadPromise;
    if (disposed || memoryFilteringOrigin !== filter) return;
    memoryFilteringOrigin = null;
    render();
    focusMemoryOriginFilter(filter);
  };

  // ── D-198 Slice 2 — owner memory CRUD (compose / detail / delete) ─────────

  /** Read the uncontrolled compose inputs from the DOM. The `onInput` handler
   *  keeps state synced between renders; this is the belt-and-braces read at
   *  submit, mirroring `syncContactDialogFromDom`. */
  const syncMemoryComposeFromDom = (): void => {
    if (!memoryCompose.open || memoryCompose.submitting) return;
    const queryable = routeRoot as unknown as {
      querySelector?: (selector: string) => Element | null;
    };
    const read = (field: string): string | undefined => {
      const el = queryable.querySelector?.(
        `[${MEMORY_FIELD_ATTR}="${field}"]`,
      ) as HTMLInputElement | HTMLTextAreaElement | null | undefined;
      return el === null || el === undefined ? undefined : el.value;
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

  const focusMemoryComposeField = (field: 'kind' | 'summary' | 'body'): void => {
    const queryable = routeRoot as unknown as {
      querySelector?: (selector: string) => HTMLElement | null;
    };
    const target = queryable.querySelector?.(
      `[${MEMORY_FIELD_ATTR}="${field}"]`,
    ) ?? null;
    target?.focus?.({ preventScroll: true });
    target?.scrollIntoView?.({ block: 'nearest' });
  };

  const focusMemoryComposeAction = (action: string): void => {
    const queryable = routeRoot as unknown as {
      querySelector?: (selector: string) => HTMLElement | null;
    };
    const target = queryable.querySelector?.(
      `[${DATA_ROUTE_ACTION_ATTR}="${action}"]`,
    ) ?? null;
    target?.focus?.({ preventScroll: true });
    target?.scrollIntoView?.({ block: 'nearest' });
  };

  const focusMemoryComposeCancel = (): void => {
    focusMemoryComposeAction(MEMORY_COMPOSE_CANCEL_ACTION);
  };

  const focusMemoryComposeSave = (): void => {
    focusMemoryComposeAction(MEMORY_COMPOSE_SUBMIT_ACTION);
  };

  const focusMemoryComposeDiscardGuard = (): void => {
    const queryable = routeRoot as unknown as {
      querySelector?: (selector: string) => HTMLElement | null;
    };
    const guard = queryable.querySelector?.(
      `[${MEMORY_COMPOSE_DISCARD_GUARD_ATTR}]`,
    ) ?? null;
    guard?.focus?.({ preventScroll: true });
    guard?.scrollIntoView?.({ block: 'nearest' });
  };

  /** The row's form-opening button: Edit on your note, Replace (D-198 §12) on
   *  an agent's. One query per action, so it needs no selector-list support. */
  const memoryRowFormAction = (memoryId: string): HTMLElement | null => {
    const queryable = routeRoot as unknown as {
      querySelectorAll?: (selector: string) => ArrayLike<HTMLElement>;
    };
    return [MEMORY_EDIT_ACTION, MEMORY_REPLACE_ACTION]
      .flatMap((action) => Array.from(queryable.querySelectorAll?.(
        `[${DATA_ROUTE_ACTION_ATTR}="${action}"]`,
      ) ?? []))
      .find((candidate) => candidate.getAttribute(MEMORY_ROW_ID_ATTR) === memoryId) ?? null;
  };

  const focusMemoryComposeReturnTarget = (
    origin: typeof memoryComposeReturnFocus,
  ): void => {
    if (origin === null) return;
    const queryable = routeRoot as unknown as {
      querySelector?: (selector: string) => HTMLElement | null;
      querySelectorAll?: (selector: string) => ArrayLike<HTMLElement>;
    };
    const edit = origin.kind === 'edit' ? memoryRowFormAction(origin.memoryId) : null;
    const add = queryable.querySelector?.(
      `[${DATA_ROUTE_ACTION_ATTR}="${MEMORY_ADD_ACTION}"]`,
    ) ?? null;
    const lens = queryable.querySelector?.(
      `[${DATA_ROUTE_ACTION_ATTR}="${MEMORY_LENS_SELECT_ACTION}"]`
      + `[${MEMORY_LENS_VALUE_ATTR}="memory"]`,
    ) ?? null;
    const target = edit ?? add ?? lens;
    target?.focus?.({ preventScroll: true });
    target?.scrollIntoView?.({ block: 'nearest' });
  };

  const focusMemoryEditAction = (memoryId: string): void => {
    const target = memoryRowFormAction(memoryId);
    target?.focus?.({ preventScroll: true });
    target?.scrollIntoView?.({ block: 'nearest' });
  };

  const captureMemoryComposeBaseline = (): void => {
    syncMemoryComposeFromDom();
    memoryComposeBaseline = memoryCompose.open
      ? memoryComposeFingerprint(memoryCompose)
      : null;
    memoryComposeDiscardGuardOpen = false;
  };

  const retireMemoryComposeDraft = (): void => {
    memoryComposeBaseline = null;
    memoryComposeDiscardGuardOpen = false;
    memoryComposeReturnFocus = null;
  };

  const closeMemoryComposeDiscardGuard = (): void => {
    if (!memoryComposeDiscardGuardOpen) return;
    memoryComposeDiscardGuardOpen = false;
    render();
    focusMemoryComposeCancel();
  };

  const showMemoryComposeDiscardGuard = (): void => {
    if (memoryComposeDiscardGuardOpen) {
      focusMemoryComposeDiscardGuard();
      return;
    }
    memoryComposeDiscardGuardOpen = true;
    render();
    focusMemoryComposeDiscardGuard();
  };

  const hasUnsavedMemoryCompose = (): boolean => {
    syncMemoryComposeFromDom();
    return memoryCompose.open
      && memoryComposeBaseline !== null
      && memoryComposeFingerprint(memoryCompose) !== memoryComposeBaseline;
  };

  const openMemoryCompose = (): void => {
    if (memoryCompose.submitting) return;
    memoryComposeReturnFocus = { kind: 'add' };
    memoryCompose = { open: true, mode: 'create', kind: '', summary: '', body: '', submitting: false };
    memoryDetailOpenSeq += 1;
    memoryDetail = null;
    memoryDetailReturnId = null;
    memoryPendingDeleteId = undefined;
    render();
    captureMemoryComposeBaseline();
    focusMemoryComposeField('kind');
  };

  const cancelMemoryCompose = (discardChanges = false): void => {
    if (!memoryCompose.open || memoryCompose.submitting) return;
    if (memoryComposeDiscardGuardOpen && !discardChanges) {
      closeMemoryComposeDiscardGuard();
      return;
    }
    if (!discardChanges && hasUnsavedMemoryCompose()) {
      showMemoryComposeDiscardGuard();
      return;
    }
    const returnFocus = memoryComposeReturnFocus;
    memoryCompose = { ...memoryCompose, open: false, submitting: false, error: undefined };
    retireMemoryComposeDraft();
    render();
    focusMemoryComposeReturnTarget(returnFocus);
  };

  /** Open the compose form in EDIT mode, prefilled from the full entry
   *  (`memory.get` resolves the body). Own (`user_self`) rows only. REPLACE mode
   *  (D-198 §12) opens the same form on an agent's note, prefilled the same way,
   *  and saving writes a new note of yours in its place. */
  const openMemoryEdit = async (memory_id: string, mode: 'edit' | 'replace' = 'edit'): Promise<void> => {
    if (memoryEditOpeningId !== null) {
      focusMemoryEditAction(memoryEditOpeningId);
      return;
    }
    const getCaller = opts.memoryGetCaller;
    if (getCaller === undefined) return;
    const seq = ++memoryEditOpenSeq;
    memoryEditOpeningId = memory_id;
    memoryEditError = null;
    memoryPendingDeleteId = undefined;
    render();
    focusMemoryEditAction(memory_id);
    try {
      const entry = await getCaller({ memory_id });
      if (
        disposed
        || seq !== memoryEditOpenSeq
        || memoryEditOpeningId !== memory_id
      ) return;
      if (mode === 'edit' ? entry.origin_actor !== 'user_self' : !isReplaceableEntry(entry)) {
        memoryEditOpeningId = null;
        memoryEditError = {
          memoryId: memory_id,
          message: mode === 'edit'
            ? 'You can only edit your own memories.'
            : 'Only the current version of a note an agent saved can be replaced.',
        };
        render();
        focusMemoryEditAction(memory_id);
        return;
      }
      memoryCompose = {
        open: true,
        mode,
        editId: memory_id,
        kind: entry.kind,
        summary: entry.summary ?? '',
        body: entry.body ?? '',
        submitting: false,
      };
      memoryEditOpeningId = null;
      memoryEditError = null;
      memoryComposeReturnFocus = { kind: 'edit', memoryId: memory_id };
      memoryDetailOpenSeq += 1;
      memoryDetail = null;
      memoryDetailReturnId = null;
      render();
      captureMemoryComposeBaseline();
      focusMemoryComposeField('kind');
    } catch (err) {
      if (
        disposed
        || seq !== memoryEditOpenSeq
        || memoryEditOpeningId !== memory_id
      ) return;
      memoryEditOpeningId = null;
      memoryEditError = { memoryId: memory_id, message: errMessage(err) };
      render();
      focusMemoryEditAction(memory_id);
    }
  };

  const submitMemoryCompose = async (): Promise<void> => {
    if (
      !memoryCompose.open
      || memoryCompose.submitting
      || memoryComposeDiscardGuardOpen
    ) return;
    syncMemoryComposeFromDom();
    if (memoryCompose.kind.trim().length === 0) {
      memoryCompose = { ...memoryCompose, error: 'Kind is required.' };
      render();
      return;
    }
    const createCaller = opts.memoryCreateCaller;
    const updateCaller = opts.memoryUpdateCaller;
    const replaceCaller = opts.memoryReplaceCaller;
    const isEdit = memoryCompose.mode === 'edit' && memoryCompose.editId !== undefined;
    const isReplace = memoryCompose.mode === 'replace' && memoryCompose.editId !== undefined;
    if (isReplace ? replaceCaller === undefined : isEdit ? updateCaller === undefined : createCaller === undefined) {
      memoryCompose = { ...memoryCompose, error: 'You cannot save memories here.' };
      render();
      return;
    }
    const draft = { kind: memoryCompose.kind, summary: memoryCompose.summary, body: memoryCompose.body };
    const editId = memoryCompose.editId;
    memoryCompose = { ...memoryCompose, submitting: true, error: undefined };
    render();
    focusMemoryComposeSave();
    try {
      let replacedBy: string | undefined;
      if (isReplace && editId !== undefined && replaceCaller !== undefined) {
        replacedBy = (await replaceCaller({
          memory_id: editId,
          kind: draft.kind,
          ...(draft.summary.length > 0 ? { summary: draft.summary } : {}),
          body: draft.body,
        })).memory_id;
      } else if (isEdit && editId !== undefined && updateCaller !== undefined) {
        await updateCaller({ memory_id: editId, kind: draft.kind, summary: draft.summary, body: draft.body });
      } else if (createCaller !== undefined) {
        await createCaller({
          kind: draft.kind,
          ...(draft.summary.length > 0 ? { summary: draft.summary } : {}),
          body: draft.body,
        });
      }
      if (disposed) return;
      // A replaced agent row loses its Replace, so land on your new note instead.
      const returnFocus = replacedBy !== undefined
        ? { kind: 'edit' as const, memoryId: replacedBy }
        : memoryComposeReturnFocus;
      memoryCompose = { open: false, mode: 'create', kind: '', summary: '', body: '', submitting: false };
      retireMemoryComposeDraft();
      pendingLoadPromise = refreshActive();
      await pendingLoadPromise;
      if (!disposed) focusMemoryComposeReturnTarget(returnFocus);
    } catch (err) {
      if (disposed) return;
      // An older server has no `memory.replace` and says so: it never saves an
      // unlinked note in its place (D-198 §12).
      const error = isReplace && classifyRpcError(err).code === 'unknown_method'
        ? 'Your Recued server needs an update to replace an agent’s note. Until then, forget it and add your own.'
        : errMessage(err);
      memoryCompose = { ...memoryCompose, submitting: false, error };
      render();
      focusMemoryComposeSave();
    }
  };

  const focusMemoryDetailHeading = (): void => {
    const queryable = routeRoot as unknown as {
      querySelector?: (selector: string) => HTMLElement | null;
    };
    const heading = queryable.querySelector?.(
      `[${MEMORY_DETAIL_HEADING_ATTR}]`,
    ) ?? null;
    heading?.focus?.({ preventScroll: true });
    heading?.scrollIntoView?.({ block: 'nearest' });
  };

  const focusMemoryDetailReturnTarget = (memoryId: string | null): void => {
    const queryable = routeRoot as unknown as {
      querySelector?: (selector: string) => HTMLElement | null;
      querySelectorAll?: (selector: string) => ArrayLike<HTMLElement>;
    };
    const view = memoryId === null
      ? null
      : Array.from(queryable.querySelectorAll?.(
          `[${DATA_ROUTE_ACTION_ATTR}="${MEMORY_OPEN_ACTION}"]`,
        ) ?? []).find(
          (candidate) => candidate.getAttribute(MEMORY_ROW_ID_ATTR) === memoryId,
        ) ?? null;
    const add = queryable.querySelector?.(
      `[${DATA_ROUTE_ACTION_ATTR}="${MEMORY_ADD_ACTION}"]`,
    ) ?? null;
    const target = view ?? add;
    target?.focus?.({ preventScroll: true });
    target?.scrollIntoView?.({ block: 'nearest' });
  };

  /** Open the detail view; lazy-loads the full body via `memory.get`. */
  const openMemoryDetail = async (memory_id: string): Promise<void> => {
    if (
      memoryDetail?.memory_id === memory_id
      && memoryDetail.loading
    ) {
      focusMemoryDetailHeading();
      return;
    }
    const getCaller = opts.memoryGetCaller;
    if (getCaller === undefined) return;
    const seq = ++memoryDetailOpenSeq;
    memoryPendingDeleteId = undefined;
    memoryDetailReturnId = memory_id;
    memoryDetail = { memory_id, loading: true };
    render();
    focusMemoryDetailHeading();
    try {
      const entry = await getCaller({ memory_id });
      if (
        disposed
        || seq !== memoryDetailOpenSeq
        || memoryDetail?.memory_id !== memory_id
      ) return;
      memoryDetail = { memory_id, loading: false, entry };
      render();
      focusMemoryDetailHeading();
    } catch (err) {
      if (
        disposed
        || seq !== memoryDetailOpenSeq
        || memoryDetail?.memory_id !== memory_id
      ) return;
      memoryDetail = { memory_id, loading: false, error: errMessage(err) };
      render();
      focusMemoryDetailHeading();
    }
  };

  const closeMemoryDetail = (): void => {
    if (memoryDeletingId !== null) {
      focusMemoryDeleteConfirm(memoryDeletingId);
      return;
    }
    const returnId = memoryDetailReturnId ?? memoryDetail?.memory_id ?? null;
    memoryDetailOpenSeq += 1;
    memoryDetail = null;
    memoryDetailReturnId = null;
    memoryPendingDeleteId = undefined;
    render();
    focusMemoryDetailReturnTarget(returnId);
  };

  const focusMemoryRowAction = (action: string, memoryId: string): void => {
    const queryable = routeRoot as unknown as {
      querySelectorAll?: (selector: string) => ArrayLike<HTMLElement>;
    };
    const target = Array.from(queryable.querySelectorAll?.(
      `[${DATA_ROUTE_ACTION_ATTR}="${action}"]`,
    ) ?? []).find(
      (candidate) => candidate.getAttribute(MEMORY_ROW_ID_ATTR) === memoryId,
    ) ?? null;
    target?.focus?.({ preventScroll: true });
    target?.scrollIntoView?.({ block: 'nearest' });
  };

  const focusMemoryDeleteConfirm = (memoryId: string): void => {
    focusMemoryRowAction(MEMORY_DELETE_CONFIRM_ACTION, memoryId);
  };

  const focusMemoryOriginFilter = (filter: MemoryOriginFilter): void => {
    const queryable = routeRoot as unknown as {
      querySelector?: (selector: string) => HTMLElement | null;
    };
    const target = queryable.querySelector?.(
      `[${DATA_ROUTE_ACTION_ATTR}="${MEMORY_FILTER_ACTION}"]`
      + `[${MEMORY_FILTER_VALUE_ATTR}="${filter}"]`,
    ) ?? null;
    target?.focus?.({ preventScroll: true });
    target?.scrollIntoView?.({ block: 'nearest' });
  };

  const focusMemoryDeleteCompletion = (): void => {
    const queryable = routeRoot as unknown as {
      querySelector?: (selector: string) => HTMLElement | null;
    };
    const add = queryable.querySelector?.(
      `[${DATA_ROUTE_ACTION_ATTR}="${MEMORY_ADD_ACTION}"]`,
    ) ?? null;
    const filter = queryable.querySelector?.(
      `[${DATA_ROUTE_ACTION_ATTR}="${MEMORY_FILTER_ACTION}"]`
      + `[${MEMORY_FILTER_VALUE_ATTR}="${memoryOriginFilter}"]`,
    ) ?? null;
    const lens = queryable.querySelector?.(
      `[${DATA_ROUTE_ACTION_ATTR}="${MEMORY_LENS_SELECT_ACTION}"]`
      + `[${MEMORY_LENS_VALUE_ATTR}="memory"]`,
    ) ?? null;
    const target = add ?? filter ?? lens;
    target?.focus?.({ preventScroll: true });
    target?.scrollIntoView?.({ block: 'nearest' });
  };

  const requestMemoryDelete = (memory_id: string): void => {
    if (memoryDeletingId !== null) {
      focusMemoryDeleteConfirm(memoryDeletingId);
      return;
    }
    memoryPendingDeleteId = memory_id;
    memoryDeleteError = null;
    memoryError = undefined;
    render();
    focusMemoryDeleteConfirm(memory_id);
  };

  const cancelMemoryDelete = (): void => {
    if (memoryDeletingId !== null) {
      focusMemoryDeleteConfirm(memoryDeletingId);
      return;
    }
    const memoryId = memoryPendingDeleteId;
    memoryPendingDeleteId = undefined;
    memoryDeleteError = null;
    render();
    if (memoryId !== undefined) {
      focusMemoryRowAction(MEMORY_DELETE_ACTION, memoryId);
    }
  };

  const confirmMemoryDelete = async (memory_id: string): Promise<void> => {
    if (memoryDeletingId !== null) {
      focusMemoryDeleteConfirm(memoryDeletingId);
      return;
    }
    const deleteCaller = opts.memoryDeleteCaller;
    if (deleteCaller === undefined) return;
    memoryPendingDeleteId = memory_id;
    memoryDeletingId = memory_id;
    memoryDeleteError = null;
    memoryError = undefined;
    opaqueMutationsInFlight += 1;
    render();
    focusMemoryDeleteConfirm(memory_id);
    try {
      await deleteCaller({ memory_id });
      if (disposed) return;
      if (memoryDetail?.memory_id === memory_id) {
        memoryDetailOpenSeq += 1;
        memoryDetail = null;
        memoryDetailReturnId = null;
      }
      memoryPendingDeleteId = undefined;
      memoryDeletingId = null;
      memoryDeleteError = null;
      pendingLoadPromise = refreshActive();
      focusMemoryDeleteCompletion();
      await pendingLoadPromise;
      if (!disposed) focusMemoryDeleteCompletion();
    } catch (err) {
      if (disposed) return;
      memoryDeletingId = null;
      memoryPendingDeleteId = memory_id;
      memoryDeleteError = { memoryId: memory_id, message: errMessage(err) };
      render();
      focusMemoryDeleteConfirm(memory_id);
    } finally {
      opaqueMutationsInFlight -= 1;
    }
  };

  /** D-198 §10 — Restore an entry an AGENT forgot. One step: it removes nothing,
   *  and the owner can forget the entry again from the same row. */
  const restoreMemory = async (memory_id: string): Promise<void> => {
    if (memoryRestoringId !== null) return;
    const restoreCaller = opts.memoryRestoreCaller;
    if (restoreCaller === undefined) return;
    memoryRestoringId = memory_id;
    memoryRestoreError = null;
    memoryError = undefined;
    opaqueMutationsInFlight += 1;
    render();
    try {
      await restoreCaller({ memory_id });
      if (disposed) return;
      memoryRestoringId = null;
      pendingLoadPromise = refreshActive();
      await pendingLoadPromise;
      if (!disposed) focusMemoryRowAction(MEMORY_DELETE_ACTION, memory_id);
    } catch (err) {
      if (disposed) return;
      memoryRestoringId = null;
      memoryRestoreError = { memoryId: memory_id, message: errMessage(err) };
      render();
      focusMemoryRowAction(MEMORY_RESTORE_ACTION, memory_id);
    } finally {
      opaqueMutationsInFlight -= 1;
    }
  };

  // D-198 Slice 3 — bulk import (paste JSON → memory.import).

  const syncMemoryImportFromDom = (): void => {
    if (!memoryImport.open || memoryImport.submitting) return;
    const queryable = routeRoot as unknown as {
      querySelector?: (selector: string) => Element | null;
    };
    const el = queryable.querySelector?.(
      `[${MEMORY_FIELD_ATTR}="import"]`,
    ) as HTMLTextAreaElement | null | undefined;
    if (el !== null && el !== undefined) {
      memoryImport = { ...memoryImport, text: el.value };
    }
  };

  const focusMemoryImportAction = (action: string): void => {
    const queryable = routeRoot as unknown as {
      querySelector?: (selector: string) => HTMLElement | null;
    };
    const target = queryable.querySelector?.(
      `[${DATA_ROUTE_ACTION_ATTR}="${action}"]`,
    ) ?? null;
    target?.focus?.({ preventScroll: true });
    target?.scrollIntoView?.({ block: 'nearest' });
  };

  const focusMemoryImportField = (): void => {
    const queryable = routeRoot as unknown as {
      querySelector?: (selector: string) => HTMLElement | null;
    };
    const target = queryable.querySelector?.(
      `[${MEMORY_FIELD_ATTR}="import"]`,
    ) ?? null;
    target?.focus?.({ preventScroll: true });
    target?.scrollIntoView?.({ block: 'nearest' });
  };

  const focusMemoryImportClose = (): void => {
    focusMemoryImportAction(MEMORY_IMPORT_CANCEL_ACTION);
  };

  const focusMemoryImportSubmit = (): void => {
    focusMemoryImportAction(MEMORY_IMPORT_SUBMIT_ACTION);
  };

  const focusMemoryImportOpener = (): void => {
    focusMemoryImportAction(MEMORY_IMPORT_ACTION);
  };

  const focusMemoryImportDiscardGuard = (): void => {
    const queryable = routeRoot as unknown as {
      querySelector?: (selector: string) => HTMLElement | null;
    };
    const guard = queryable.querySelector?.(
      `[${MEMORY_IMPORT_DISCARD_GUARD_ATTR}]`,
    ) ?? null;
    guard?.focus?.({ preventScroll: true });
    guard?.scrollIntoView?.({ block: 'nearest' });
  };

  const captureMemoryImportBaseline = (): void => {
    syncMemoryImportFromDom();
    memoryImportBaseline = memoryImport.open ? memoryImport.text : null;
    memoryImportDiscardGuardOpen = false;
  };

  const retireMemoryImportDraft = (): void => {
    memoryImportBaseline = null;
    memoryImportDiscardGuardOpen = false;
  };

  const closeMemoryImportDiscardGuard = (): void => {
    if (!memoryImportDiscardGuardOpen) return;
    memoryImportDiscardGuardOpen = false;
    render();
    focusMemoryImportClose();
  };

  const showMemoryImportDiscardGuard = (): void => {
    if (memoryImportDiscardGuardOpen) {
      focusMemoryImportDiscardGuard();
      return;
    }
    memoryImportDiscardGuardOpen = true;
    render();
    focusMemoryImportDiscardGuard();
  };

  const hasUnsavedMemoryImport = (): boolean => {
    syncMemoryImportFromDom();
    return memoryImport.open
      && memoryImportBaseline !== null
      && memoryImport.text !== memoryImportBaseline;
  };

  const openMemoryImport = (): void => {
    memoryImport = { open: true, text: '', submitting: false };
    memoryCompose = { ...memoryCompose, open: false };
    memoryDetailOpenSeq += 1;
    memoryDetail = null;
    memoryDetailReturnId = null;
    memoryPendingDeleteId = undefined;
    render();
    captureMemoryImportBaseline();
    focusMemoryImportField();
  };

  const cancelMemoryImport = (discardChanges = false): void => {
    if (!memoryImport.open) return;
    if (memoryImport.submitting) {
      focusMemoryImportSubmit();
      return;
    }
    if (memoryImportDiscardGuardOpen && !discardChanges) {
      closeMemoryImportDiscardGuard();
      return;
    }
    if (!discardChanges && hasUnsavedMemoryImport()) {
      showMemoryImportDiscardGuard();
      return;
    }
    memoryImport = { open: false, text: '', submitting: false };
    retireMemoryImportDraft();
    render();
    focusMemoryImportOpener();
  };

  const submitMemoryImport = async (): Promise<void> => {
    if (
      !memoryImport.open
      || memoryImport.submitting
      || memoryImportDiscardGuardOpen
    ) return;
    syncMemoryImportFromDom();
    const importCaller = opts.memoryImportCaller;
    if (importCaller === undefined) {
      memoryImport = { ...memoryImport, error: 'You cannot bring memories in here.' };
      render();
      focusMemoryImportSubmit();
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
      memoryImport = { ...memoryImport, error: 'Recued could not read that. Paste a file it can understand.' };
      render();
      focusMemoryImportSubmit();
      return;
    }
    if (!Array.isArray(entries)) {
      memoryImport = { ...memoryImport, error: 'Recued expected a list of entries.' };
      render();
      focusMemoryImportSubmit();
      return;
    }
    memoryImport = { ...memoryImport, submitting: true, error: undefined, result: undefined };
    render();
    focusMemoryImportSubmit();
    try {
      const result = await importCaller({ entries: entries as MemoryImportRequest['entries'] });
      if (disposed) return;
      // Keep the panel open showing the tally; the feed refreshes underneath.
      memoryImport = { ...memoryImport, submitting: false, result };
      memoryImportBaseline = memoryImport.text;
      memoryImportDiscardGuardOpen = false;
      pendingLoadPromise = refreshActive();
      focusMemoryImportSubmit();
      await pendingLoadPromise;
      if (!disposed) focusMemoryImportSubmit();
    } catch (err) {
      if (disposed) return;
      memoryImport = { ...memoryImport, submitting: false, error: errMessage(err) };
      render();
      focusMemoryImportSubmit();
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

  const focusMemoryExport = (): void => {
    const queryable = routeRoot as unknown as {
      querySelector?: (selector: string) => HTMLElement | null;
    };
    const target = queryable.querySelector?.(
      `[${DATA_ROUTE_ACTION_ATTR}="${MEMORY_EXPORT_ACTION}"]`,
    ) ?? null;
    target?.focus?.({ preventScroll: true });
    target?.scrollIntoView?.({ block: 'nearest' });
  };

  /** Memory-native export (§ export): walk the WHOLE feed under the active
   *  origin filter, resolve each body-carrying row's full body via `memory.get`
   *  (the feed ships only previews), assemble a `{ entries }` payload that
   *  `memory.import` round-trips, and download it. */
  const exportMemory = async (): Promise<void> => {
    const listCaller = opts.memoryListCaller;
    if (listCaller === undefined) return;
    if (memoryExporting) {
      focusMemoryExport();
      return;
    }
    const EXPORT_PAGE_SIZE = 200;
    const EXPORT_MAX_PAGES = 200; // hard walk cap (≤ 40k entries) — never loops
    memoryExporting = true;
    memoryError = undefined;
    render();
    focusMemoryExport();
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
        focusMemoryExport();
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
    return formDefinitionForKind(workEntityState.kind, activeSource, workEntityState.dialog?.mode);
  };

  const focusWorkEntityDialog = (): void => {
    if (activeTab === 'project' && projectWork && !projectEditing) {
      routeRoot.querySelector?.<HTMLElement>('[data-project-focus="heading"]')?.focus({ preventScroll: true }); return;
    }
    const queryable = routeRoot as unknown as {
      querySelector?: (selector: string) => HTMLElement | null;
    };
    const dialog = queryable.querySelector?.('.work-entity-dialog') ?? null;
    const form = dialog?.querySelector(
      '.work-entity-dialog-form',
    ) as HTMLElement | null;
    const target = (form?.querySelector(
      'input:not([type="hidden"]):not([disabled]):not([readonly]), '
      + 'textarea:not([disabled]):not([readonly]), select:not([disabled])',
    ) ?? dialog?.querySelector('.work-entity-dialog-title') ?? null) as (
      HTMLElement | null
    );
    target?.focus?.({ preventScroll: true });
    target?.scrollIntoView?.({ block: 'nearest' });
  };

  const focusWorkEntityDialogField = (field: string): void => {
    const queryable = routeRoot as unknown as {
      querySelectorAll?: (selector: string) => ArrayLike<HTMLElement>;
    };
    const owners = Array.from(queryable.querySelectorAll?.(
      '.work-entity-dialog [data-form-field]',
    ) ?? []).filter(
      (candidate) => candidate.getAttribute('data-form-field') === field,
    );
    const direct = owners.find((candidate) =>
      candidate.getAttribute('type') !== 'hidden'
      && ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(candidate.tagName),
    );
    const nested = owners[0]?.closest('.form-renderer-row')?.querySelector(
      'input:not([type="hidden"]):not([disabled]), textarea:not([disabled]), '
      + 'select:not([disabled]), button:not([disabled])',
    ) as HTMLElement | null | undefined;
    const target = direct ?? nested ?? null;
    target?.focus?.({ preventScroll: true });
    target?.scrollIntoView?.({ block: 'nearest' });
  };

  const focusWorkEntityDialogReturnTarget = (): void => {
    const origin = workEntityDialogReturnFocus;
    workEntityDialogReturnFocus = null;
    if (origin === null) return;
    const queryable = routeRoot as unknown as {
      querySelector?: (selector: string) => HTMLElement | null;
      querySelectorAll?: (selector: string) => ArrayLike<HTMLElement>;
    };
    const action = origin.mode === 'create'
      ? 'open-create-work-entity-dialog'
      : origin.kind === 'booking'
        ? 'edit-booking-detail'
        : 'open-edit-work-entity';
    const exact = Array.from(queryable.querySelectorAll?.(
      `[${SHARED_ACTION_ATTR}="${action}"]`,
    ) ?? []).find(
      (candidate) =>
        candidate.getAttribute('data-kind') === origin.kind
        && (
          origin.mode === 'create'
          || candidate.getAttribute('data-entity-id') === origin.id
        ),
    ) ?? null;
    const search = queryable.querySelector?.(
      `input[${SHARED_ACTION_ATTR}="search-work-entities"]`
      + `[data-kind="${origin.kind}"]`,
    ) ?? null;
    const tab = origin.kind === 'asset' ? null : collectionNavigationTarget(origin.kind);
    const target = exact ?? search ?? tab;
    target?.focus?.({ preventScroll: true });
    target?.scrollIntoView?.({ block: 'nearest' });
  };

  const captureWorkEntityDialogBaseline = (): void => {
    // Canonical defaults can be absent from a stored row but materialized by
    // the renderer (for example Task priority). Decode the first paint through
    // the same seam used at dismissal before calling it the clean baseline.
    syncWorkEntityDialogFromDom();
    workEntityDialogBaseline = workEntityState.dialog === null
      ? null
      : workEntityDialogFingerprint(workEntityState.dialog, activeWorkEntityDefinition());
    workEntityDiscardGuardOpen = false;
    workEntityDiscardReturnFocus = null;
  };

  const retireWorkEntityDialogDraft = (): void => {
    workEntityDialogBaseline = null;
    workEntityDialogEntity = null;
    taskCompletionNotice = null;
    workEntityDiscardGuardOpen = false;
    workEntityDiscardReturnFocus = null;
    commitmentMode = 'read'; commitmentNotice = undefined; commitmentDiscardToReader = false;
    noteMode = 'read'; noteDetailsOpen = false; noteCopying = false;
    noteCopySequence += 1; noteNotice = undefined; noteDiscardToReader = false;
  };

  const captureWorkEntityDiscardReturnFocus = (): void => {
    const active = doc.activeElement as HTMLElement | null | undefined;
    const fieldOwner = active?.closest?.('[data-form-field]') as
      | HTMLElement
      | null
      | undefined;
    const field = active?.getAttribute?.('data-form-field')
      ?? fieldOwner?.getAttribute('data-form-field')
      ?? undefined;
    workEntityDiscardReturnFocus = active?.classList?.contains(
      'work-entity-dialog-close',
    ) === true
      ? { kind: 'close' }
      : active?.classList?.contains('work-entity-dialog-cancel') === true
        ? { kind: 'cancel' }
        : field !== undefined
          ? { kind: 'field', field }
          : { kind: 'form' };
  };

  const focusWorkEntityDiscardReturnTarget = (): void => {
    const owner = workEntityDiscardReturnFocus;
    workEntityDiscardReturnFocus = null;
    if (owner?.kind === 'close' || owner?.kind === 'cancel') {
      const selector = owner.kind === 'close'
        ? '.work-entity-dialog-close'
        : '.work-entity-dialog-cancel';
      const queryable = routeRoot as unknown as {
        querySelector?: (selector: string) => HTMLElement | null;
      };
      const target = queryable.querySelector?.(selector) ?? null;
      target?.focus?.({ preventScroll: true });
      return;
    }
    if (owner?.kind === 'field' && owner.field !== undefined) {
      focusWorkEntityDialogField(owner.field);
      return;
    }
    focusWorkEntityDialog();
  };

  const focusWorkEntityDiscardGuard = (): void => {
    const queryable = routeRoot as unknown as {
      querySelector?: (selector: string) => HTMLElement | null;
    };
    const guard = queryable.querySelector?.(
      `[${WORK_ENTITY_DIALOG_DISCARD_GUARD_ATTR}]`,
    ) ?? null;
    guard?.focus?.({ preventScroll: true });
    guard?.scrollIntoView?.({ block: 'nearest' });
  };

  const closeWorkEntityDiscardGuard = (): void => {
    if (!workEntityDiscardGuardOpen) return;
    workEntityDiscardGuardOpen = false;
    render();
    focusWorkEntityDiscardReturnTarget();
  };

  const showWorkEntityDiscardGuard = (): void => {
    if (workEntityDiscardGuardOpen) {
      focusWorkEntityDiscardGuard();
      return;
    }
    captureWorkEntityDiscardReturnFocus();
    workEntityDiscardGuardOpen = true;
    render();
    focusWorkEntityDiscardGuard();
  };

  const hasUnsavedWorkEntityDialog = (): boolean => {
    if (activeTab === 'project' && projectWork && !projectEditing) return false;
    syncWorkEntityDialogFromDom();
    return workEntityState.dialog !== null
      && workEntityDialogBaseline !== null
      && workEntityDialogFingerprint(workEntityState.dialog, activeWorkEntityDefinition())
        !== workEntityDialogBaseline;
  };

  const closeWorkEntityDialog = (discardChanges = false, returnToNote = false, returnToCommitment = false): void => {
    if (
      workEntityState.dialog === null
      || workEntityState.dialog.submitting === true
    ) return;
    if (workEntityDiscardGuardOpen && !discardChanges) {
      closeWorkEntityDiscardGuard();
      return;
    }
    if (!discardChanges && hasUnsavedWorkEntityDialog()) {
      noteDiscardToReader = returnToNote;
      commitmentDiscardToReader = returnToCommitment;
      showWorkEntityDiscardGuard();
      return;
    }
    retireRunVerification();
    workEntityDialogOpenSeq += 1;
    pendingWorkEntityDialogOpen = null;
    loadingWorkEntityDetail = false;
    if (returnToCommitment && workEntityState.kind === 'commitment' && workEntityDialogEntity?._kind === 'commitment') {
      workEntityState = openEditDialogTransition(workEntityState, workEntityDialogEntity, getCanonicalSchema('commitment'));
      workEntityDialogOriginal = { ...workEntityState.dialog!.values };
      commitmentMode = 'read'; commitmentNotice = undefined; commitmentDiscardToReader = false;
      workEntityDiscardGuardOpen = false;
      render(); captureWorkEntityDialogBaseline();
      (routeRoot.querySelector<HTMLElement>('[data-action="edit-commitment"]')
        ?? routeRoot.querySelector<HTMLElement>('.work-entity-dialog-title'))?.focus?.();
      loadWorkEntityTimeline('commitment', workEntityDialogEntity.id, workEntityDialogOpenSeq);
      return;
    }
    if (returnToNote && workEntityState.kind === 'note' && workEntityDialogEntity?._kind === 'note') {
      workEntityState = openEditDialogTransition(workEntityState, workEntityDialogEntity, getCanonicalSchema('note'));
      workEntityDialogOriginal = { ...workEntityState.dialog!.values };
      noteMode = 'read'; noteDetailsOpen = false; noteNotice = undefined;
      noteCopying = false; noteCopySequence += 1; noteDiscardToReader = false;
      workEntityDiscardGuardOpen = false;
      render(); captureWorkEntityDialogBaseline();
      (routeRoot.querySelector<HTMLElement>('[data-action="edit-note"]')
        ?? routeRoot.querySelector<HTMLElement>('.work-entity-dialog-title'))?.focus();
      loadWorkEntityTimeline('note', workEntityDialogEntity.id, workEntityDialogOpenSeq);
      return;
    }
    workEntityState = closeDialogTransition(workEntityState);
    retireWorkEntityDialogDraft();
    if (projectChildReturn) { returnToProjectOverview(); return; }
    if (projectWork && activeTab === 'project' && projectEditing) {
      workEntityState = openEditDialogTransition(workEntityState, projectWork.project, getCanonicalSchema('project'));
      workEntityDialogEntity = projectWork.project;
      projectEditing = false; render(); captureWorkEntityDialogBaseline();
      routeRoot.querySelector<HTMLElement>('[data-project-focus="edit"]')?.focus();
      void openEditWorkEntityDialog('project', projectWork.project.id, 'read', true);
      return;
    }
    if (activeTab === 'project') { projectWork?.dispose(); projectWork = null; }
    if (workSearchReturn) { returnToWorkSearch(); return; }
    syncDataHash();
    render();
    focusWorkEntityDialogReturnTarget();
  };

  const openCreateWorkEntityDialog = (sourceOverride?: string): void => {
    if (taskBulk.busy()) { focusTaskBatch(); return; }
    taskBulk.reset();
    workEntityDialogOriginal = {};
    workEntityDialogEntity = null;
    commitmentMode = 'edit'; commitmentNotice = undefined; commitmentDiscardToReader = false;
    noteMode = 'edit'; noteDetailsOpen = false; noteNotice = undefined;
    noteCopying = false; noteCopySequence += 1; noteDiscardToReader = false;
    taskDetailsOpen = false;
    taskDueShortcutAnchor = undefined;
    retireRunVerification();
    loadingWorkEntityDetail = false;
    pendingWorkEntityDialogOpen = null;
    workEntityDialogReturnFocus = null;
    const sourceId = resolveCreateDialogSourceId(
      workEntityState.kind,
      sourceOverride ?? workEntityState.selected_source_id,
      enabledSourcesForKind(sources, workEntityState.kind),
    );
    if (sourceId === null) return;
    if (!projectChildReturn) workSearchReturn = null;
    // Bump the open sequence so an edit fetch still in flight (its dialog not
    // yet installed) can't resolve later and clobber this create dialog.
    workEntityDialogOpenSeq += 1;
    workEntityState = openCreateDialogTransition(
      workEntityState,
      sourceId,
      { ...initialValuesForKind(workEntityState.kind),
        ...(projectChildReturn && projectWork ? workEntityState.kind === 'task'
          ? { parent_project: projectWork.project.id } : { related_project: [projectWork.project.id] } : {}) },
    );
    workEntityDialogReturnFocus = {
      mode: 'create',
      kind: workEntityState.kind,
    };
    syncDataHash(); // create has no entity id → drops any prior edit id
    render();
    captureWorkEntityDialogBaseline();
    focusWorkEntityDialog();
  };

  /** The values the open EDIT dialog started from. */
  let workEntityDialogOriginal: Readonly<Record<string, unknown>> = {};
  let taskDetailsOpen = false;
  // Preserve a shortcut's seconds through the form's minute-only read-back.
  let taskDueShortcutAnchor: number | undefined;
  const canEditProject = (entity: Extract<WorkEntity, { _kind: 'project' }>): boolean =>
    opts.workEntityUpsertCaller !== undefined && opts.workEntityGetCaller !== undefined
    && entity.sync_state === 'live' && entity.deleted_at == null && !entity.pending_write
    && sources.some(source => source.id === entity.source_id && source.top_tier_kind === 'project'
      && source.write_capable && source.sync_posture !== 'read_through');

  const projectCreateSource = (kind: 'task' | 'note'): string | null =>
    opts.workEntityUpsertCaller && opts.workEntityGetCaller
      ? resolveCreateDialogSourceId(kind, null, enabledSourcesForKind(sources, kind)) : null;

  const projectOverviewProps = (): ProjectOverviewProps | undefined => {
    if (activeTab !== 'project' || !projectWork || workEntityState.dialog?.mode !== 'edit'
      || workEntityState.dialog.entity_id !== projectWork.project.id) return undefined;
    return { project: projectWork.project, sections: projectWork.sections, editing: projectEditing,
      source_label: sources.find(source => source.id === projectWork!.project.source_id)?.source_label ?? 'Source unavailable',
      stale: projectWork.project.sync_state === 'stale_unreachable'
        || projectWork.freshness !== undefined && !['fresh', 'local'].includes(projectWork.freshness.state),
      source_incomplete: projectWork.freshness?.list_complete === false,
      can_edit: canEditProject(projectWork.project), can_create_task: projectCreateSource('task') !== null,
      can_create_note: projectCreateSource('note') !== null, close_label: workSearchReturn ? 'Back to search' : 'Back to projects' };
  };

  const openProjectWorkItem = async (kind: 'task' | 'note', id?: string): Promise<void> => {
    const overview = projectWork;
    if (!overview || activeTab !== 'project' || projectEditing || pendingWorkEntityDialogOpen) return;
    if (id !== undefined && !overview.sections[kind].items.some(item => item.id === id)) return;
    const createSource = id === undefined ? projectCreateSource(kind) : null;
    if (id === undefined && createSource === null) return;
    projectChildReturn = { kind, ...(id !== undefined ? { id } : {}), scrollTop: workSearchScrollHost()?.scrollTop ?? 0,
      page: workEntityState, entities: [...workEntities], total: workEntityTotal };
    const previousNavigation = navigationGeneration;
    const opening = selectTab(kind, false, undefined, true);
    const navigation = navigationGeneration;
    if (navigation === previousNavigation) { projectChildReturn = null; return; }
    await opening;
    if (disposed || navigation !== navigationGeneration || projectWork !== overview || !projectChildReturn) return;
    if (id === undefined) openCreateWorkEntityDialog(createSource!);
    else await openEditWorkEntityDialog(kind, id);
  };

  const returnToProjectOverview = (): void => {
    const origin = projectChildReturn;
    const overview = projectWork;
    if (!origin || !overview || disposed) return;
    projectChildReturn = null;
    loadGeneration += 1; navigationGeneration += 1; universalSearchNavigation = navigationGeneration;
    workEntityDialogOpenSeq += 1; pendingWorkEntityDialogOpen = null; loadingWorkEntityDetail = false;
    workEntityState = closeDialogTransition(workEntityState); retireWorkEntityDialogDraft();
    activeTab = 'project'; loading = false; errors = {};
    workEntities = origin.entities; workEntityTotal = origin.total;
    workEntityState = openEditDialogTransition(origin.page, overview.project, getCanonicalSchema('project'));
    workEntityDialogEntity = overview.project;
    workEntityDialogOriginal = { ...workEntityState.dialog!.values };
    workEntityDialogReturnFocus = { mode: 'edit', kind: 'project', id: overview.project.id };
    projectEditing = false;
    pendingProjectRestore = { key: origin.id ? `${origin.kind}:${origin.id}` : `new-${origin.kind}`, scrollTop: origin.scrollTop };
    syncDataHash(); render(); captureWorkEntityDialogBaseline();
    void openEditWorkEntityDialog('project', overview.project.id, 'read', true);
  };

  const commitmentWritable = (entity: Extract<WorkEntity, { _kind: 'commitment' }>): boolean =>
    entity.sync_state === 'live' && entity.deleted_at == null && !entity.pending_write
    && sources.some(source => source.id === entity.source_id && source.top_tier_kind === 'commitment'
      && source.write_capable && source.sync_posture !== 'read_through');
  const canEditCommitment = (entity: Extract<WorkEntity, { _kind: 'commitment' }>): boolean =>
    opts.workEntityUpsertCaller !== undefined && opts.workEntityGetCaller !== undefined && commitmentWritable(entity);
  const canCloseCommitment = (entity: Extract<WorkEntity, { _kind: 'commitment' }>, outcome: 'fulfill' | 'cancel'): boolean =>
    opts.commitmentCloseCaller !== undefined && commitmentWritable(entity)
    && (entity.lifecycle_state === 'pending' || entity.lifecycle_state === 'expired'
      && (outcome === 'cancel' || entity.expiry_policy !== 'strict_expire'));

  const canEditNote = (entity: Extract<WorkEntity, { _kind: 'note' }>): boolean =>
    opts.workEntityUpsertCaller !== undefined && opts.workEntityGetCaller !== undefined
    && entity.sync_state === 'live' && entity.deleted_at == null && !entity.pending_write
    && sources.some(source => source.id === entity.source_id && source.top_tier_kind === 'note'
      && source.write_capable && source.sync_posture !== 'read_through');

  const loadWorkEntityTimeline = (kind: WorkEntityKind, id: string, sequence: number): void => {
    workEntityTimeline = null;
    if (!opts.timelineCaller) return;
    void opts.timelineCaller({ entity_id: `${kind}:${id}` }).then(response => {
      if (disposed || sequence !== workEntityDialogOpenSeq) return;
      workEntityTimeline = { kind, id, entries: response.entries }; render();
    }).catch(() => { /* An unavailable timeline is omitted. */ });
  };

  const focusNoteNotice = (): void => {
    const notice = routeRoot.querySelector<HTMLElement>('[data-note-notice]');
    notice?.focus({ preventScroll: true }); notice?.scrollIntoView({ block: 'nearest' });
  };

  const copyNoteText = async (): Promise<void> => {
    const entity = workEntityDialogEntity;
    if (disposed || activeTab !== 'note' || noteMode !== 'read' || entity?._kind !== 'note' || noteCopying) return;
    const sequence = ++noteCopySequence;
    const opened = workEntityDialogOpenSeq;
    const stillHere = () => !disposed && sequence === noteCopySequence && opened === workEntityDialogOpenSeq
      && activeTab === 'note' && noteMode === 'read' && workEntityState.dialog?.mode === 'edit'
      && workEntityState.dialog.entity_id === entity.id;
    noteCopying = true; noteNotice = undefined; render();
    routeRoot.querySelector<HTMLElement>('[data-action="copy-note-text"]')?.focus({ preventScroll: true });
    let copied = false;
    try {
      const clipboard = doc.defaultView?.navigator?.clipboard;
      if (clipboard?.writeText) { await clipboard.writeText(entity.body); copied = true; }
      else if (typeof doc.execCommand === 'function') {
        const input = doc.createElement('textarea'); input.value = entity.body; input.readOnly = true;
        input.style.cssText = 'position:fixed;opacity:0;pointer-events:none;';
        doc.body.append(input);
        try { input.select(); copied = doc.execCommand('copy'); } finally { input.remove(); }
      }
    } catch { /* Keep the note available for manual selection. */ }
    if (!stillHere()) return;
    const carryFocus = doc.activeElement?.getAttribute('data-action') === 'copy-note-text';
    noteCopying = false;
    noteNotice = copied ? { kind: 'ok', text: 'Note text copied.' }
      : { kind: 'error', text: 'Copy did not complete. Select the note text and copy it.' };
    render(); if (carryFocus) focusNoteNotice();
  };

  const openEditWorkEntityDialog = async (
    kind: WorkEntityKind,
    id: string,
    noteIntent: 'read' | 'edit' | 'details' = 'read',
    preserveFocus = false,
  ): Promise<void> => {
    if (taskBulk.busy()) { focusTaskBatch(); return; }
    taskBulk.reset();
    if (kind === 'asset') {
      const view = doc.defaultView;
      if (view) view.location.hash = `#yours/asset/${encodeURIComponent(id)}`;
      return;
    }

    if (
      pendingWorkEntityDialogOpen?.kind === kind
      && pendingWorkEntityDialogOpen.id === id && pendingWorkEntityDialogOpen.intent === noteIntent
    ) return;
    retireRunVerificationForDifferentItem(kind, id);
    const seq = ++workEntityDialogOpenSeq;
    if (kind === 'note') { noteCopying = false; noteCopySequence += 1; noteNotice = undefined; }
    if (kind !== 'booking') {
      bookingDetailSeq += 1;
      bookingDetailId = null;
      bookingDetail = null;
      bookingDetailError = null;
      loadingBookingDetail = false;
      resetBookingManageLinkState();
    }
    if (activeTab !== kind) {
      activeTab = kind;
      workEntityState = selectKindTransition(workEntityState, kind);
    }
    pendingWorkEntityDialogOpen = { kind, id, intent: noteIntent };
    workEntityDialogReturnFocus = { mode: 'edit', kind, id };
    loadingWorkEntityDetail = true;
    render();
    let entity: WorkEntity | null =
      workEntities.find((row) => row._kind === kind && row.id === id) ?? null;
    let openedFreshness: WorkEntityGetRpcResponse['source_freshness'];
    if (opts.workEntityGetCaller !== undefined) {
      try {
        const [response, registered] = await Promise.all([
          opts.workEntityGetCaller({ kind, id }),
          (kind === 'note' || kind === 'commitment' || kind === 'project' && noteIntent !== 'read') && opts.workEntitySourceListCaller
            ? opts.workEntitySourceListCaller().catch(error => {
                if (noteIntent === 'read') return undefined;
                throw error;
              }) : Promise.resolve(undefined),
        ]);
        if (disposed || seq !== workEntityDialogOpenSeq || activeTab !== kind) return;
        entity = response.entity;
        openedFreshness = response.source_freshness;
        if (response.counterparty_labels) commitmentContactLabels = { ...commitmentContactLabels, ...response.counterparty_labels };
        if (registered) sources = [...registered.sources];
      } catch (err) {
        if (disposed || seq !== workEntityDialogOpenSeq) return;
        pendingWorkEntityDialogOpen = null;
        loadingWorkEntityDetail = false;
        errors = { ...errors, work_entities: errMessage(err) };
        if (kind === 'note' && noteIntent !== 'read') noteNotice = { kind: 'error', text: `Could not open the editor. ${errMessage(err)}` };
        render();
        if (kind === 'note' && noteIntent !== 'read') routeRoot.querySelector<HTMLElement>('[data-note-notice]')?.focus();
        else if (!preserveFocus) focusWorkEntityDialogReturnTarget();
        return;
      }
    }
    // A newer open (any kind) or a tab switch away happened while the fetch was
    // in flight → don't install this now-stale dialog / URL.
    if (disposed || seq !== workEntityDialogOpenSeq || activeTab !== kind) return;
    if (entity === null || entity._kind !== kind || entity.id !== id) {
      pendingWorkEntityDialogOpen = null;
      loadingWorkEntityDetail = false;
      errors = { ...errors, work_entities: `No ${kind} was returned for ${id}.` };
      render();
      if (!preserveFocus) focusWorkEntityDialogReturnTarget();
      return;
    }
    workEntityState = openEditDialogTransition(
      workEntityState,
      entity,
      getCanonicalSchema(kind),
    );
    workEntityDialogEntity = entity;
    noteCopying = false; noteCopySequence += 1; noteNotice = undefined; noteDiscardToReader = false;
    if (entity._kind === 'commitment') {
      commitmentMode = noteIntent !== 'read' && canEditCommitment(entity) ? 'edit' : 'read'; commitmentNotice = undefined; commitmentDiscardToReader = false;
    }
    if (entity._kind === 'note') {
      noteMode = noteIntent !== 'read' && canEditNote(entity) ? 'edit' : 'read';
      noteDetailsOpen = noteIntent === 'details';
      if (noteIntent !== 'read' && noteMode === 'read') noteNotice = { kind: 'error', text: 'This note cannot be edited now. Check its source or pending changes.' };
    }
    if (entity._kind === 'project') {
      if (projectWork?.project.id !== entity.id) {
        projectWork?.dispose();
        projectWork = createProjectWork(entity, opts.projectItemsCaller, () => {
          if (!disposed && activeTab === 'project' && !projectEditing) render();
        });
      } else projectWork.project = entity;
      projectWork.freshness = openedFreshness;
      const currentProject = entity;
      workEntities = workEntities.map(row => row._kind === 'project' && row.id === currentProject.id ? currentProject : row);
      projectEditing = noteIntent !== 'read' && canEditProject(entity);
    }
    taskDetailsOpen = false;
    taskDueShortcutAnchor = undefined;
    taskCompletionNotice = null;
    // What an untouched date-time field keeps on save (`timestampValue`).
    workEntityDialogOriginal = { ...(workEntityState.dialog?.values ?? {}) };
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
    pendingWorkEntityDialogOpen = null;
    loadingWorkEntityDetail = false;
    syncDataHash(); // the edit dialog's entity is now the addressable id
    render();
    captureWorkEntityDialogBaseline();
    if (kind === 'note' && noteNotice?.kind === 'error') focusNoteNotice();
    else if (!preserveFocus) focusWorkEntityDialog();
    if (kind === 'booking') opts.onOwnerRecordOpened?.({ collection: kind, id });
    loadWorkEntityTimeline(kind, id, seq);
    if (entity._kind === 'project' && projectWork && !projectEditing) {
      void projectWork.load('task', true); void projectWork.load('note', true);
    }
  };

  const openBookingDetail = async (id: string): Promise<void> => {
    retireRunVerificationForDifferentItem('booking', id);
    const seq = ++bookingDetailSeq;
    if (activeTab !== 'booking') {
      activeTab = 'booking';
      workEntityState = selectKindTransition(workEntityState, 'booking');
    }
    workEntityState = closeDialogTransition(workEntityState);
    retireWorkEntityDialogDraft();
    bookingDetailId = id;
    bookingDetail = null;
    bookingDetailError = null;
    loadingBookingDetail = true;
    resetBookingManageLinkState();
    syncDataHash();
    render();
    try {
      const response = opts.workEntityGetCaller !== undefined
        ? await opts.workEntityGetCaller({ kind: 'booking', id })
        : {
            entity:
              workEntities.find((entity) => entity._kind === 'booking' && entity.id === id)
              ?? null,
          };
      if (
        disposed
        || seq !== bookingDetailSeq
        || activeTab !== 'booking'
        || bookingDetailId !== id
      ) return;
      bookingDetail = response;
      bookingDetailError = null;
    } catch (err) {
      if (
        disposed
        || seq !== bookingDetailSeq
        || activeTab !== 'booking'
        || bookingDetailId !== id
      ) return;
      bookingDetail = null;
      bookingDetailError = errMessage(err);
    } finally {
      if (
        !disposed
        && seq === bookingDetailSeq
        && activeTab === 'booking'
        && bookingDetailId === id
      ) {
        loadingBookingDetail = false;
        syncDataHash();
        render();
        if (bookingDetail?.entity) opts.onOwnerRecordOpened?.({ collection: 'booking', id });
      }
    }
  };

  const closeBookingDetail = (): void => {
    retireRunVerification();
    bookingDetailSeq += 1;
    bookingDetailId = null;
    bookingDetail = null;
    bookingDetailError = null;
    loadingBookingDetail = false;
    resetBookingManageLinkState();
    workEntityState = closeDialogTransition(workEntityState);
    retireWorkEntityDialogDraft();
    syncDataHash();
    render();
  };

  /** Mint and copy a visitor manage link for the open Reception-origin booking.
   * A manual booking has no sealed Reception reservation and therefore cannot
   * mint. Sequence + identity guards drop a completion after navigation. */
  const copyBookingManageLink = async (): Promise<void> => {
    const caller = opts.manageRescheduleLinkCaller;
    if (caller === undefined || bookingManageLinkBusy) return;
    const entity = bookingDetail?.entity;
    if (
      entity === null
      || entity === undefined
      || entity._kind !== 'booking'
      || entity.id !== bookingDetailId
      || typeof entity.reception_record_id !== 'string'
      || entity.reception_record_id.length === 0
    ) {
      bookingManageLinkNotice = {
        kind: 'error',
        text: 'Recued cannot make a link for changing this booking.',
      };
      render();
      return;
    }

    const seq = bookingDetailSeq;
    const bookingId = entity.id;
    bookingManageLinkBusy = true;
    bookingManageLinkNotice = null;
    render();
    try {
      const { url } = await caller({ booking_id: bookingId });
      if (
        disposed
        || seq !== bookingDetailSeq
        || activeTab !== 'booking'
        || bookingDetailId !== bookingId
      ) return;
      const clipboard = doc.defaultView?.navigator?.clipboard;
      let copied = false;
      if (typeof clipboard?.writeText === 'function') {
        try {
          await clipboard.writeText(url);
          copied = true;
        } catch {
          copied = false;
        }
      }
      if (
        disposed
        || seq !== bookingDetailSeq
        || activeTab !== 'booking'
        || bookingDetailId !== bookingId
      ) return;
      bookingManageLinkBusy = false;
      bookingManageLinkNotice = copied
        ? {
            kind: 'ok',
            text: 'Link copied. It works once, and only for a short while.',
          }
        : { kind: 'ok', text: `Reschedule link: ${url}` };
      render();
    } catch (err) {
      if (
        disposed
        || seq !== bookingDetailSeq
        || activeTab !== 'booking'
        || bookingDetailId !== bookingId
      ) return;
      bookingManageLinkBusy = false;
      bookingManageLinkNotice = { kind: 'error', text: errMessage(err) };
      render();
    }
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
    if (workEntityState.kind === 'note') {
      const body = form.querySelector<HTMLTextAreaElement>('[data-form-field="body"]');
      const title = form.querySelector<HTMLInputElement>('[data-form-field="title"]');
      const original = workEntityState.dialog.mode === 'edit' ? workEntityDialogOriginal : {};
      if (body) values.body = typeof original.body === 'string' && body.value === original.body.replace(/\r\n?/g, '\n')
        ? original.body : body.value;
      // A text input removes line breaks even when an imported title is untouched.
      const displayedTitle = typeof original.title === 'string' ? original.title.replace(/[\r\n]/g, '') : original.title;
      if (title) values.title = title.value === displayedTitle ? original.title : title.value.trim();
    }
    workEntityState = setDialogValuesTransition(workEntityState, values);
  };

  const focusWorkEntityArrayItem = (
    field: string,
    index: number,
  ): void => {
    const queryable = routeRoot as unknown as {
      querySelectorAll?: (selector: string) => ArrayLike<HTMLElement>;
    };
    const owner = Array.from(queryable.querySelectorAll?.(
      '[data-form-array-item][data-form-array-index]',
    ) ?? []).find(
      (candidate) =>
        candidate.getAttribute('data-form-array-item') === field
        && candidate.getAttribute('data-form-array-index') === String(index),
    ) ?? null;
    const direct = owner !== null
      && owner.getAttribute('type') !== 'hidden'
      && ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(owner.tagName)
        ? owner
        : null;
    const picker = owner?.closest('[data-ref-picker]')?.querySelector(
      '[data-ref-picker-input]',
    ) as HTMLElement | null | undefined;
    const nested = owner?.querySelector(
      'input:not([type="hidden"]):not([disabled]), textarea:not([disabled]), '
      + 'select:not([disabled]), button:not([disabled])',
    ) as HTMLElement | null | undefined;
    const target = direct ?? picker ?? nested ?? null;
    target?.focus?.({ preventScroll: true });
    target?.scrollIntoView?.({ block: 'nearest' });
  };

  const focusWorkEntityArrayAdd = (field: string): void => {
    const queryable = routeRoot as unknown as {
      querySelectorAll?: (selector: string) => ArrayLike<HTMLElement>;
    };
    const target = Array.from(queryable.querySelectorAll?.(
      '[data-form-array-add]',
    ) ?? []).find(
      (candidate) => candidate.getAttribute('data-form-array-add') === field,
    ) ?? null;
    target?.focus?.({ preventScroll: true });
    target?.scrollIntoView?.({ block: 'nearest' });
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
    const addedIndex = next.length - 1;
    setWorkEntityDialogValues({
      ...workEntityState.dialog.values,
      [field]: next,
    });
    focusWorkEntityArrayItem(field, addedIndex);
  };

  const removeWorkEntityArrayItem = (field: string, index: number): void => {
    if (workEntityState.dialog === null) return;
    if (!Number.isInteger(index) || index < 0) return;
    syncWorkEntityDialogFromDom();
    if (workEntityState.dialog === null) return;
    const current = workEntityState.dialog.values[field];
    if (!Array.isArray(current)) return;
    if (index >= current.length) return;
    const next = current.filter((_, i) => i !== index);
    setWorkEntityDialogValues({
      ...workEntityState.dialog.values,
      [field]: next,
    });
    if (next.length === 0) {
      focusWorkEntityArrayAdd(field);
    } else {
      focusWorkEntityArrayItem(field, Math.min(index, next.length - 1));
    }
  };

  const focusTaskCompletionError = (): void => {
    const error = routeRoot.querySelector<HTMLElement>('.work-entity-dialog-submit-error');
    error?.focus?.({ preventScroll: true });
    error?.scrollIntoView?.({ block: 'nearest' });
  };

  const changeCommitmentLifecycle = async (outcome: 'fulfill' | 'cancel'): Promise<void> => {
    const dialog = workEntityState.dialog;
    const opened = workEntityDialogEntity;
    const close = opts.commitmentCloseCaller;
    if (disposed || activeLens !== 'data' || activeTab !== 'commitment' || dialog?.mode !== 'edit'
      || dialog.submitting || workEntityDiscardGuardOpen || opened?._kind !== 'commitment'
      || opened.id !== dialog.entity_id || pendingWorkEntityDialogOpen || !close || !canCloseCommitment(opened, outcome)) return;
    if (hasUnsavedWorkEntityDialog()) {
      workEntityState = setDialogSubmitErrorTransition(workEntityState, 'Save or discard your edits before closing the commitment.');
      render(); focusTaskCompletionError(); return;
    }
    const seq = workEntityDialogOpenSeq;
    const stillHere = (): boolean => !disposed && seq === workEntityDialogOpenSeq
      && activeTab === 'commitment' && workEntityState.dialog?.entity_id === opened.id;
    workEntityState = setDialogSubmittingTransition(workEntityState, true);
    workEntityState = setDialogSubmitErrorTransition(workEntityState, null);
    opaqueMutationsInFlight += 1;
    render();
    try {
      const { entity } = await close({ id: opened.id, outcome });
      if (!stillHere()) return;
      if (entity._kind !== 'commitment' || entity.id !== opened.id
        || entity.source_id !== opened.source_id || entity.source_record_id !== opened.source_record_id || entity.created_at !== opened.created_at
        || entity.lifecycle_state !== (outcome === 'fulfill' ? 'fulfilled' : 'cancelled')) {
        throw new Error('The server did not confirm the close. Reopen the commitment to check it.');
      }
      workEntityDialogEntity = entity; commitmentMode = 'read'; commitmentNotice = undefined;
      workEntityState = openEditDialogTransition(workEntityState, entity, getCanonicalSchema('commitment'));
      workEntityDialogOriginal = { ...(workEntityState.dialog?.values ?? {}) };
      render(); captureWorkEntityDialogBaseline();
      routeRoot.querySelector<HTMLElement>('[data-commitment-status]')?.focus?.({ preventScroll: true });
      pendingLoadPromise = refreshActive(true);
      await pendingLoadPromise;
    } catch (error) {
      if (!stillHere()) return;
      workEntityState = setDialogSubmittingTransition(workEntityState, false);
      workEntityState = setDialogSubmitErrorTransition(workEntityState, errMessage(error));
      render(); focusTaskCompletionError();
    } finally { opaqueMutationsInFlight -= 1; }
  };

  const changeTaskCompletion = async (done: boolean): Promise<void> => {
    const dialog = workEntityState.dialog;
    const opened = workEntityDialogEntity;
    const markDone = opts.taskMarkDoneCaller;
    const get = opts.workEntityGetCaller;
    const listSources = opts.workEntitySourceListCaller;
    if (disposed || activeLens !== 'data' || activeTab !== 'task' || dialog?.mode !== 'edit'
      || dialog.submitting || workEntityDiscardGuardOpen || opened?._kind !== 'task'
      || opened.id !== dialog.entity_id || opened.done === done || !markDone || !get || !listSources) return;
    if (hasUnsavedWorkEntityDialog()) {
      workEntityState = setDialogSubmitErrorTransition(workEntityState,
        'Save or discard your edits before changing task completion.');
      render();
      focusTaskCompletionError();
      return;
    }
    const seq = workEntityDialogOpenSeq;
    const mutation = { id: opened.id, sequence: seq };
    taskCompletionPending = mutation;
    const stillHere = (): boolean => !disposed && seq === workEntityDialogOpenSeq
      && activeLens === 'data' && activeTab === 'task' && workEntityState.dialog?.mode === 'edit'
      && workEntityState.dialog.entity_id === opened.id;
    workEntityState = setDialogSubmittingTransition(workEntityState, true);
    workEntityState = setDialogSubmitErrorTransition(workEntityState, null);
    taskCompletionNotice = null;
    opaqueMutationsInFlight += 1;
    render();
    try {
      // Read the current task and its source; send only the chosen lifecycle
      // change. An old editor must not replay its title, body or due date.
      const [{ entity }, { sources: currentSources }] = await Promise.all([
        get({ kind: 'task', id: opened.id }), listSources(),
      ]);
      if (!stillHere()) return;
      const sameTask = (row: WorkEntity | null): row is Extract<WorkEntity, { _kind: 'task' }> =>
        row?._kind === 'task' && row.id === opened.id && row.source_id === opened.source_id
        && row.source_record_id === opened.source_record_id && row.created_at === opened.created_at
        && row.sync_state === 'live' && row.deleted_at == null;
      const source = entity ? currentSources.find((entry) => entry.id === entity.source_id) : undefined;
      if (!sameTask(entity) || source?.top_tier_kind !== 'task' || !source.write_capable
        || source.sync_posture === 'read_through') {
        throw new Error('This task cannot be changed here now. Close the editor and check its source.');
      }
      if (entity.pending_write) {
        throw new Error('This task has a change waiting for its source. Close and reopen it to check before trying again.');
      }
      const result = await markDone({ id: opened.id, done });
      if (!stillHere()) return;
      if (result.entity.pending_write) {
        throw new Error('Your change is saved in Recued, but the source has not confirmed it yet. Close and reopen the task to check before trying again.');
      }
      if (!sameTask(result.entity) || result.entity.done !== done) {
        throw new Error('The server did not confirm the change. Close and reopen the task to check it.');
      }
      workEntityDialogEntity = result.entity;
      if (taskCompletionPending === mutation) taskCompletionPending = null;
      workEntityState = openEditDialogTransition(workEntityState, result.entity, getCanonicalSchema('task'));
      workEntityDialogOriginal = { ...(workEntityState.dialog?.values ?? {}) };
      workEntityState = setDialogValuesTransition(workEntityState, {
        ...workEntityState.dialog!.values,
        ...sourceExtensionValuesFromEntity(activeWorkEntityDefinition(), result.entity),
      });
      taskCompletionNotice = done ? 'Task completed.' : 'Task reopened.';
      render();
      captureWorkEntityDialogBaseline();
      routeRoot.querySelector<HTMLElement>('[data-task-completion-status]')?.focus?.({ preventScroll: true });
      // Retire older list reads immediately. A failed list refresh cannot
      // undo the confirmed completion displayed by this editor.
      pendingLoadPromise = refreshActive(true);
      await pendingLoadPromise;
    } catch (error) {
      if (!stillHere()) return;
      if (taskCompletionPending === mutation) taskCompletionPending = null;
      workEntityState = setDialogSubmittingTransition(workEntityState, false);
      workEntityState = setDialogSubmitErrorTransition(workEntityState, errMessage(error));
      render();
      focusTaskCompletionError();
    } finally {
      if (taskCompletionPending === mutation) taskCompletionPending = null;
      opaqueMutationsInFlight -= 1;
    }
  };

  const confirmWorkEntityDialog = async (): Promise<void> => {
    if (
      workEntityState.dialog === null
      || workEntityState.dialog.submitting === true
    ) return;
    if (activeTab === 'project' && projectWork && !projectEditing) return;
    if (workEntityState.kind === 'note' && workEntityState.dialog.mode === 'edit' && noteMode === 'read') return;
    if (workEntityState.kind === 'commitment' && workEntityState.dialog.mode === 'edit' && commitmentMode === 'read') return;
    if (opts.workEntityUpsertCaller === undefined) {
      workEntityState = setDialogSubmitErrorTransition(
        workEntityState,
        'You cannot save items here.',
      );
      render();
      return;
    }

    const definition = activeWorkEntityDefinition();
    const fieldErrors = validateForm(definition, workEntityState.dialog.values);
    if (fieldErrors.length > 0) {
      const firstInvalidField = fieldErrors[0]?.field;
      workEntityState = setDialogErrorsTransition(
        workEntityState,
        validationMap(fieldErrors),
      );
      render();
      if (firstInvalidField !== undefined) {
        focusWorkEntityDialogField(firstInvalidField);
      }
      return;
    }

    let request: WorkEntityUpsertRpcRequest;
    const editingTask = workEntityState.kind === 'task' && workEntityState.dialog.mode === 'edit'
      && workEntityDialogEntity?._kind === 'task' ? workEntityDialogEntity : null;
    const editingNote = workEntityState.kind === 'note' && workEntityState.dialog.mode === 'edit'
      && workEntityDialogEntity?._kind === 'note' ? workEntityDialogEntity : null;
    const editingCommitment = workEntityState.kind === 'commitment' && workEntityState.dialog.mode === 'edit'
      && workEntityDialogEntity?._kind === 'commitment' ? workEntityDialogEntity : null;
    const editingEntity = editingTask ?? editingNote ?? editingCommitment;
    const submittedSequence = workEntityDialogOpenSeq;
    const submittedProject = projectWork;
    try {
      if (projectChildReturn && workEntityState.dialog?.mode === 'create' && workEntityDialogEntity) {
        throw new Error('The source already returned an item. Your draft is still here. Check that item before creating another.');
      }
      if (projectWork && projectEditing && !canEditProject(projectWork.project)) {
        throw new Error('This project cannot be changed now. Your draft is still here. Check its source or pending changes.');
      }
      if (editingEntity?.pending_write) {
        throw new Error(`This ${editingEntity._kind} has a change waiting for its source. Close and reopen it to check before trying again.`);
      }
      if (editingCommitment && !canEditCommitment(editingCommitment)) throw new Error('This promise cannot be changed now. Your draft is still here. Check its source.');
      if (editingNote && !canEditNote(editingNote)) {
        throw new Error('This note cannot be edited now. Your draft is still here. Check its source.');
      }
      request = projectWorkEntityUpsert(
        workEntityState.kind,
        workEntityState,
        definition,
        { ...(workEntityState.dialog.mode === 'edit' ? workEntityDialogOriginal : {}),
          ...(taskDueShortcutAnchor !== undefined ? { due_at: taskDueShortcutAnchor } : {}) },
      );
      if (editingEntity) {
        const patch = request as unknown as Record<string, unknown>;
        for (const key of Object.keys(patch)) {
          if (key !== 'kind' && key !== 'id' && key !== 'clear_due_at'
            && workEntityEditFieldMatches(key, patch[key], (editingEntity as unknown as Record<string, unknown>)[key])) delete patch[key];
        }
      }
    } catch (err) {
      workEntityState = setDialogSubmitErrorTransition(
        workEntityState,
        errMessage(err),
      );
      render();
      if (workEntityState.kind === 'task' || workEntityState.kind === 'note' || workEntityState.kind === 'commitment') focusTaskCompletionError();
      return;
    }

    workEntityState = setDialogSubmittingTransition(workEntityState, true);
    workEntityState = setDialogSubmitErrorTransition(workEntityState, null);
    render();
    try {
      const unchanged = editingEntity && Object.keys(request).every(key => key === 'kind' || key === 'id');
      const result = unchanged
        ? { entity: editingEntity } : await opts.workEntityUpsertCaller(request);
      if (disposed) return;
      if ((editingNote || editingCommitment || submittedProject) && (submittedSequence !== workEntityDialogOpenSeq || submittedProject && submittedProject !== projectWork)) return;
      if (request.kind === 'project' && projectWork && projectEditing) {
        const saved = result.entity;
        if (saved._kind !== 'project' || saved.id !== projectWork.project.id || saved.source_id !== projectWork.project.source_id
          || saved.source_record_id !== projectWork.project.source_record_id || saved.created_at !== projectWork.project.created_at) {
          throw new Error('The source did not confirm this project. Your draft is still here.');
        }
        if (saved.pending_write) {
          projectWork.project = saved;
          throw new Error('The project changes are waiting for source confirmation. Your draft is still here. Check the source before trying again.');
        }
        if (saved.sync_state !== 'live' || saved.deleted_at != null
          || Object.entries(request).some(([key, value]) => key !== 'kind' && key !== 'id'
            && !workEntityEditFieldMatches(key, value, (saved as unknown as Record<string, unknown>)[key]))) {
          throw new Error('The source did not confirm the project changes. Your draft is still here.');
        }
        projectWork.project = saved;
        workEntities = workEntities.map(entity => entity._kind === 'project' && entity.id === saved.id ? saved : entity);
      }
      if (projectChildReturn && workEntityState.dialog?.mode === 'create') {
        const saved = result.entity;
        if (saved._kind === request.kind && saved.id) workEntityDialogEntity = saved;
        if (saved._kind !== request.kind || !saved.id || saved.pending_write || saved.sync_state !== 'live' || saved.deleted_at != null
          || ('source_id' in request && saved.source_id !== request.source_id)
          || request.kind === 'task' && saved._kind === 'task' && request.parent_project_id !== undefined && saved.parent_project_id !== request.parent_project_id
          || request.kind === 'note' && saved._kind === 'note' && request.related_project_ids !== undefined
            && !workEntityEditFieldMatches('related_project_ids', request.related_project_ids, saved.related_project_ids)) {
          throw new Error('The source did not confirm the new item. Your draft is still here.');
        }
      }
      if (editingTask) {
        const saved = result.entity;
        const unconfirmed = () => new Error('The source did not confirm your edits. Your draft is still here. Check the task before trying again.');
        if (saved._kind !== 'task' || saved.id !== editingTask.id || saved.source_id !== editingTask.source_id
          || saved.source_record_id !== editingTask.source_record_id || saved.created_at !== editingTask.created_at) throw unconfirmed();
        if (saved.pending_write) {
          workEntityDialogEntity = saved;
          throw new Error('Your change is saved in Recued, but the source has not confirmed it yet. Your draft is still here. Close and reopen the task to check before trying again.');
        }
        if (saved.sync_state !== 'live' || saved.deleted_at != null
          || Object.entries(request).some(([key, value]) => key === 'clear_due_at'
            ? saved.due_at != null : key !== 'kind' && key !== 'id'
              && !workEntityEditFieldMatches(key, value, (saved as unknown as Record<string, unknown>)[key]))) throw unconfirmed();
      }
      if (editingNote) {
        const saved = result.entity;
        if (saved._kind !== 'note' || saved.id !== editingNote.id || saved.source_id !== editingNote.source_id
          || saved.source_record_id !== editingNote.source_record_id || saved.created_at !== editingNote.created_at) {
          throw new Error('The source did not confirm this note. Your draft is still here.');
        }
        if (saved.pending_write) {
          workEntityDialogEntity = saved;
          throw new Error('Your change is saved in Recued, but the source has not confirmed it yet. Your draft is still here. Close and reopen the note to check before trying again.');
        }
        if (saved.sync_state !== 'live' || saved.deleted_at != null || Object.entries(request).some(([key, value]) =>
          key !== 'kind' && key !== 'id' && !workEntityEditFieldMatches(key, value, (saved as unknown as Record<string, unknown>)[key]))) {
          throw new Error('The source did not confirm your edits. Your draft is still here. Check the note before trying again.');
        }
        workEntityDialogEntity = saved;
        workEntityState = openEditDialogTransition(workEntityState, saved, getCanonicalSchema('note'));
        workEntityDialogOriginal = { ...workEntityState.dialog!.values };
        noteMode = 'read'; noteCopying = false; noteCopySequence += 1; noteDetailsOpen = false;
        noteNotice = { kind: 'ok', text: unchanged ? 'No changes to save.' : 'Note saved.' };
        const sequence = ++workEntityDialogOpenSeq;
        syncDataHash(); render(); captureWorkEntityDialogBaseline(); focusNoteNotice();
        loadWorkEntityTimeline('note', saved.id, sequence);
        pendingLoadPromise = refreshActive(true);
        return;
      }
      if (editingCommitment) {
        const saved = result.entity;
        if (saved._kind !== 'commitment' || saved.id !== editingCommitment.id || saved.source_id !== editingCommitment.source_id
          || saved.source_record_id !== editingCommitment.source_record_id || saved.created_at !== editingCommitment.created_at) {
          throw new Error('The source did not confirm this promise. Your draft is still here.');
        }
        if (saved.pending_write) {
          workEntityDialogEntity = saved;
          throw new Error('Your change is saved in Recued, but the source has not confirmed it yet. Your draft is still here. Close and reopen the promise to check before trying again.');
        }
        if (saved.sync_state !== 'live' || saved.deleted_at != null
          || Object.entries(request).some(([key, value]) => key !== 'kind' && key !== 'id'
            && !workEntityEditFieldMatches(key, value, (saved as unknown as Record<string, unknown>)[key]))) {
          throw new Error('The source did not confirm your edits. Your draft is still here. Check the promise before trying again.');
        }
        workEntityDialogEntity = saved;
        workEntityState = openEditDialogTransition(workEntityState, saved, getCanonicalSchema('commitment'));
        workEntityDialogOriginal = { ...workEntityState.dialog!.values };
        commitmentMode = 'read'; commitmentNotice = unchanged ? 'No changes to save.' : 'Commitment saved.';
        render(); captureWorkEntityDialogBaseline();
        routeRoot.querySelector<HTMLElement>('[data-commitment-notice]')?.focus?.({ preventScroll: true });
        pendingLoadPromise = refreshActive(true);
        return;
      }
      if (projectChildReturn || projectWork && projectEditing || workSearchReturn) {
        workEntityState = setDialogSubmittingTransition(workEntityState, false);
        closeWorkEntityDialog(true);
        return;
      }
      workEntityState = closeDialogTransition(
        setDialogSubmittingTransition(workEntityState, false),
      );
      retireWorkEntityDialogDraft();
      syncDataHash(); // dialog closed → drop the entity id from the URL
      pendingLoadPromise = refreshActive();
      await pendingLoadPromise;
      if (!disposed && request.kind === 'booking' && bookingDetailId !== null) {
        await openBookingDetail(bookingDetailId);
      }
      if (!disposed) focusWorkEntityDialogReturnTarget();
    } catch (err) {
      if (disposed || (editingNote || editingCommitment || submittedProject) && (submittedSequence !== workEntityDialogOpenSeq || submittedProject && submittedProject !== projectWork)) return;
      workEntityState = setDialogSubmittingTransition(workEntityState, false);
      workEntityState = setDialogSubmitErrorTransition(
        workEntityState,
        errMessage(err),
      );
      render();
      if (workEntityState.kind === 'task' || workEntityState.kind === 'note' || workEntityState.kind === 'commitment') focusTaskCompletionError();
    }
  };

  const deleteWorkEntity = async (
    kind: WorkEntityKind,
    id: string,
  ): Promise<void> => {
    if (opts.workEntityDeleteCaller === undefined) {
      errors = { ...errors, work_entities: 'You cannot delete items here.' };
      render();
      return;
    }
    opaqueMutationsInFlight += 1;
    try {
      await opts.workEntityDeleteCaller({ kind, id });
      // If the edit dialog for the just-deleted entity is open, close it (and
      // drop its now-dangling id from the URL) so nothing addresses a gone row.
      if (
        workEntityState.dialog?.mode === 'edit'
        && workEntityState.dialog.entity_id === id
      ) {
        workEntityState = closeDialogTransition(workEntityState);
        retireWorkEntityDialogDraft();
        syncDataHash();
      }
      if (kind === 'booking' && bookingDetailId === id) {
        bookingDetailSeq += 1;
        bookingDetailId = null;
        bookingDetail = null;
        bookingDetailError = null;
        loadingBookingDetail = false;
        resetBookingManageLinkState();
        syncDataHash();
      }
      pendingLoadPromise = refreshActive();
      await pendingLoadPromise;
    } catch (err) {
      errors = { ...errors, work_entities: errMessage(err) };
      render();
    } finally {
      opaqueMutationsInFlight -= 1;
    }
  };

  const focusContactDialogField = (
    field: keyof ContactDialogValues,
  ): void => {
    const queryable = routeRoot as unknown as {
      querySelector?: (selector: string) => HTMLElement | null;
    };
    const input = queryable.querySelector?.(
      `[${DATA_ROUTE_CONTACT_FIELD_ATTR}="${field}"]`,
    ) ?? null;
    input?.focus?.({ preventScroll: true });
  };

  const focusContactDialogReturnTarget = (): void => {
    const origin = contactDialogReturnFocus;
    contactDialogReturnFocus = null;
    if (origin === null) return;
    const queryable = routeRoot as unknown as {
      querySelector?: (selector: string) => HTMLElement | null;
      querySelectorAll?: (selector: string) => ArrayLike<HTMLElement>;
    };
    const trigger = origin.kind === 'create'
      ? queryable.querySelector?.(
          `[${DATA_ROUTE_ACTION_ATTR}="open-create-contact"]`,
        ) ?? null
      : Array.from(
          queryable.querySelectorAll?.(
            `[${DATA_ROUTE_CONTACT_EMAIL_ATTR}]`,
          ) ?? [],
        ).find(
          (candidate) =>
            candidate.getAttribute(DATA_ROUTE_ACTION_ATTR)
              === 'open-edit-contact'
            && candidate.getAttribute(DATA_ROUTE_CONTACT_EMAIL_ATTR)
              === origin.email,
        ) ?? null;
    const fallback = origin.kind === 'edit'
      ? queryable.querySelector?.(
          `[${DATA_ROUTE_CONTACT_DETAIL_HEADING_ATTR}]`,
        ) ?? null
      : queryable.querySelector?.(
          `[${DATA_ROUTE_CONTACT_SEARCH_ATTR}]`,
        ) ?? null;
    const tab = collectionNavigationTarget('contact');
    (trigger ?? fallback ?? tab)?.focus?.({ preventScroll: true });
  };

  const captureContactDialogBaseline = (): void => {
    syncContactDialogFromDom();
    contactDialogBaseline = contactDialog === null
      ? null
      : contactDialogFingerprint(contactDialog.values);
    contactDiscardGuardOpen = false;
    contactDiscardReturnFocus = null;
  };

  const retireContactDialogDraft = (): void => {
    contactDialogBaseline = null;
    contactDiscardGuardOpen = false;
    contactDiscardReturnFocus = null;
  };

  const captureContactDiscardReturnFocus = (): void => {
    const active = doc.activeElement as HTMLElement | null | undefined;
    const field = active?.getAttribute?.(DATA_ROUTE_CONTACT_FIELD_ATTR);
    contactDiscardReturnFocus = active?.classList?.contains(
      'data-dialog-close',
    ) === true
      ? { kind: 'close' }
      : active?.classList?.contains('data-dialog-cancel') === true
        ? { kind: 'cancel' }
        : field !== null
          && field !== undefined
          && field in emptyContactValues()
          ? { kind: 'field', field: field as keyof ContactDialogValues }
          : { kind: 'form' };
  };

  const focusContactDiscardReturnTarget = (): void => {
    const owner = contactDiscardReturnFocus;
    contactDiscardReturnFocus = null;
    if (owner?.kind === 'close' || owner?.kind === 'cancel') {
      const selector = owner.kind === 'close'
        ? '.data-dialog-close'
        : '.data-dialog-cancel';
      const queryable = routeRoot as unknown as {
        querySelector?: (selector: string) => HTMLElement | null;
      };
      const target = queryable.querySelector?.(selector) ?? null;
      target?.focus?.({ preventScroll: true });
      return;
    }
    if (owner?.kind === 'field' && owner.field !== undefined) {
      focusContactDialogField(owner.field);
      return;
    }
    focusContactDialogField(contactDialog?.mode === 'edit' ? 'name' : 'email');
  };

  const focusContactDiscardGuard = (): void => {
    const queryable = routeRoot as unknown as {
      querySelector?: (selector: string) => HTMLElement | null;
    };
    const guard = queryable.querySelector?.(
      `[${DATA_ROUTE_CONTACT_DISCARD_GUARD_ATTR}]`,
    ) ?? null;
    guard?.focus?.({ preventScroll: true });
    guard?.scrollIntoView?.({ block: 'nearest' });
  };

  const closeContactDiscardGuard = (): void => {
    if (!contactDiscardGuardOpen) return;
    contactDiscardGuardOpen = false;
    render();
    focusContactDiscardReturnTarget();
  };

  const showContactDiscardGuard = (): void => {
    if (contactDiscardGuardOpen) {
      focusContactDiscardGuard();
      return;
    }
    captureContactDiscardReturnFocus();
    contactDiscardGuardOpen = true;
    render();
    focusContactDiscardGuard();
  };

  const hasUnsavedContactDialog = (): boolean => {
    syncContactDialogFromDom();
    return contactDialog !== null
      && contactDialogBaseline !== null
      && contactDialogFingerprint(contactDialog.values) !== contactDialogBaseline;
  };

  const closeContactDialog = (discardChanges = false): void => {
    if (contactDialog === null || contactDialog.submitting) return;
    if (contactDiscardGuardOpen && !discardChanges) {
      closeContactDiscardGuard();
      return;
    }
    if (!discardChanges && hasUnsavedContactDialog()) {
      showContactDiscardGuard();
      return;
    }
    contactDialog = null;
    retireContactDialogDraft();
    render();
    focusContactDialogReturnTarget();
  };

  const openCreateContactDialog = (): void => {
    contactDialogReturnFocus = { kind: 'create' };
    contactDialog = {
      mode: 'create',
      values: emptyContactValues(),
      errors: {},
      submitting: false,
      submit_error: null,
    };
    render();
    captureContactDialogBaseline();
    focusContactDialogField('email');
  };

  const openEditContactDialog = async (email: string): Promise<void> => {
    const trimmed = email.trim();
    if (
      trimmed.length === 0
      || openingContactEditEmail !== null
      || contactDialog !== null
    ) {
      return;
    }
    const originDetailEmail = contactDetail?.email === trimmed ? trimmed : null;
    const activeElement = doc.activeElement as HTMLElement | null | undefined;
    pendingContactEditFocusEmail =
      activeElement?.getAttribute?.(DATA_ROUTE_ACTION_ATTR)
        === 'open-edit-contact'
      && activeElement.getAttribute(DATA_ROUTE_CONTACT_EMAIL_ATTR) === trimmed
        ? trimmed
        : null;
    const seq = ++contactEditOpenSeq;
    openingContactEditEmail = trimmed;
    render();

    let contact = contacts.find((row) => row.email === trimmed) ?? null;
    if (opts.contactGetCaller !== undefined) {
      try {
        const response = await opts.contactGetCaller({ email: trimmed });
        contact = response.contact;
      } catch (err) {
        if (
          disposed
          || seq !== contactEditOpenSeq
          || openingContactEditEmail !== trimmed
          || (
            originDetailEmail !== null
            && contactDetail?.email !== originDetailEmail
          )
        ) return;
        openingContactEditEmail = null;
        errors = { ...errors, contacts: errMessage(err) };
        render();
        return;
      }
    }
    if (
      disposed
      || seq !== contactEditOpenSeq
      || openingContactEditEmail !== trimmed
      || (
        originDetailEmail !== null
        && contactDetail?.email !== originDetailEmail
      )
    ) return;
    openingContactEditEmail = null;
    if (contact === null) {
      errors = {
        ...errors,
        contacts: `No contact was returned for ${trimmed}.`,
      };
      render();
      return;
    }
    pendingContactEditFocusEmail = null;
    contactDialogReturnFocus = { kind: 'edit', email: trimmed };
    contactDialog = {
      mode: 'edit',
      values: contactValuesFromRecord(contact),
      original: contact,
      errors: {},
      submitting: false,
      submit_error: null,
    };
    render();
    captureContactDialogBaseline();
    focusContactDialogField('name');
  };

  const setContactDialogValues = (
    values: Partial<ContactDialogValues>,
  ): void => {
    if (contactDialog === null || contactDialog.submitting) return;
    contactDialog = {
      ...contactDialog,
      values: { ...contactDialog.values, ...values },
      errors: {},
      submit_error: null,
    };
    render();
  };

  const syncContactDialogFromDom = (): void => {
    if (contactDialog === null || contactDialog.submitting) return;
    // String-only test/host DOMs cannot be decoded; their route state is the
    // canonical draft because no uncontrolled browser inputs exist there.
    if (typeof routeRoot.querySelector !== 'function') return;
    const next = { ...contactDialog.values };
    for (const key of Object.keys(next) as Array<keyof ContactDialogValues>) {
      const input = routeRoot.querySelector(
        `[${DATA_ROUTE_CONTACT_FIELD_ATTR}="${key}"]`,
      ) as HTMLInputElement | null;
      if (key === 'privacy_marks') {
        if (typeof routeRoot.querySelectorAll === 'function') next[key] = [...routeRoot.querySelectorAll<HTMLInputElement>('[data-contact-privacy-mark]')].filter(control => control.checked).map(control => control.value).join(', ');
      }
      else if (input !== null) next[key] = input.value;
    }
    contactDialog = { ...contactDialog, values: next };
  };

  const confirmContactDialog = async (): Promise<void> => {
    if (contactDialog === null || contactDialog.submitting) return;
    if (opts.contactUpsertCaller === undefined) {
      contactDialog = {
        ...contactDialog,
        submit_error: 'You cannot save contacts here.',
      };
      render();
      return;
    }
    const dialogErrors = validateContactDialog(contactDialog.values);
    if (hasContactErrors(dialogErrors)) {
      contactDialog = { ...contactDialog, errors: dialogErrors };
      render();
      const firstInvalidField = (
        ['email', 'name', 'phone', 'company', 'birthday', 'anniversary', 'relationship', 'privacy_marks'] as const
      ).find((field) => dialogErrors[field] !== undefined);
      if (firstInvalidField !== undefined) {
        focusContactDialogField(firstInvalidField);
      }
      return;
    }
    const submittedValues = { ...contactDialog.values };
    const previous = contactDialog.original ?? contactDetail?.contact ?? contacts.find(row => row.email === submittedValues.email);
    contactDialog = { ...contactDialog, submitting: true, submit_error: null };
    render();
    const editedEmail = submittedValues.email.trim();
    try {
      await opts.contactUpsertCaller(contactUpsertArgs(submittedValues, previous));
      if (disposed) return;
      contactDialog = null;
      retireContactDialogDraft();
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
      if (!disposed) focusContactDialogReturnTarget();
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
      errors = { ...errors, contacts: 'You cannot delete contacts here.' };
      render();
      return;
    }
    opaqueMutationsInFlight += 1;
    try {
      await opts.contactDeleteCaller({ email });
      contactDialog = null;
      contactDialogReturnFocus = null;
      retireContactDialogDraft();
      pendingLoadPromise = refreshActive();
      await pendingLoadPromise;
    } catch (err) {
      errors = { ...errors, contacts: errMessage(err) };
      render();
    } finally {
      opaqueMutationsInFlight -= 1;
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
    pendingFormResponseAutomationPickerFocus = false;
    closeFormResponseRunModal();
  };

  const discoverFormResponseAutomations = async (): Promise<void> => {
    const response = formResponseDetail;
    const listCaller = opts.recipeListCaller;
    if (
      response === null
      || listCaller === undefined
      || opts.recipeExecuteCaller === undefined
      || formResponseAutomationState.status === 'loading'
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
        message: `Recued could not load your saved automations: ${humanizeRpcError(error)}`,
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
        message: `Recued could not open the run: ${humanizeRpcError(error)}`,
      };
      render();
    }
  };

  const confirmFormResponseAutomationRun = async (): Promise<void> => {
    const modal = formResponseRunModal;
    if (modal === null) return;
    opaqueMutationsInFlight += 1;
    try {
      await modal.confirmRun();
    } finally {
      opaqueMutationsInFlight -= 1;
    }
  };

  const captureFormResponseEditorBaseline = (): void => {
    formResponseEditorBaseline = formResponseEditorDraft === null
      ? null
      : formResponseEditorFingerprint(formResponseEditorDraft);
    formResponseDiscardGuardOpen = false;
    formResponseDiscardReturnId = null;
    formResponseDiscardPendingTab = null;
    formResponseDiscardPendingHref = null;
    pendingFormResponseDiscardTabFocus = null;
  };

  const retireFormResponseEditorDraft = (): void => {
    formResponseEditorBaseline = null;
    formResponseDiscardGuardOpen = false;
    formResponseDiscardReturnId = null;
    formResponseDiscardPendingTab = null;
    formResponseDiscardPendingHref = null;
    pendingFormResponseDiscardTabFocus = null;
  };

  const syncFormResponseEditorDraftFromDom = (): void => {
    const draft = formResponseEditorDraft;
    if (
      draft === null
      || formResponseDetailId !== draft.submissionId
      || savingFormResponse
    ) return;
    const queryable = routeRoot as unknown as {
      querySelector?: (selector: string) => HTMLElement | null;
    };
    const values = queryable.querySelector?.(
      `[${DATA_ROUTE_FORM_RESPONSE_VALUES_ATTR}]`,
    ) as HTMLTextAreaElement | null | undefined;
    const email = queryable.querySelector?.(
      `[${DATA_ROUTE_FORM_RESPONSE_EMAIL_ATTR}]`,
    ) as HTMLInputElement | null | undefined;
    const lifecycle = queryable.querySelector?.(
      `[${DATA_ROUTE_FORM_RESPONSE_STATE_ATTR}]`,
    ) as HTMLSelectElement | null | undefined;
    formResponseEditorDraft = {
      ...draft,
      valuesText: values?.value ?? draft.valuesText,
      email: email?.value ?? draft.email,
      lifecycle: lifecycle?.value ?? draft.lifecycle,
    };
  };

  const focusFormResponseBack = (): void => {
    const queryable = routeRoot as unknown as {
      querySelector?: (selector: string) => HTMLElement | null;
    };
    const back = queryable.querySelector?.(
      `[${DATA_ROUTE_ACTION_ATTR}="close-form-response"]`,
    ) ?? null;
    back?.focus?.({ preventScroll: true });
    back?.scrollIntoView?.({ block: 'nearest' });
  };

  const focusDataTab = (tab: DataTabId): void => {
    const target = collectionNavigationTarget(tab);
    target?.focus?.({ preventScroll: true });
    target?.scrollIntoView?.({ block: 'nearest' });
  };

  const focusFormResponseAutomate = (): void => {
    const queryable = routeRoot as unknown as {
      querySelector?: (selector: string) => HTMLElement | null;
    };
    const target = queryable.querySelector?.(
      `[${DATA_ROUTE_FORM_RESPONSE_AUTOMATE_ATTR}]`,
    ) ?? null;
    target?.focus?.({ preventScroll: true });
    target?.scrollIntoView?.({ block: 'nearest' });
  };

  const focusFormResponseDiscardGuard = (): void => {
    const queryable = routeRoot as unknown as {
      querySelector?: (selector: string) => HTMLElement | null;
    };
    const guard = queryable.querySelector?.(
      `[${DATA_ROUTE_FORM_RESPONSE_DISCARD_GUARD_ATTR}]`,
    ) ?? null;
    guard?.focus?.({ preventScroll: true });
    guard?.scrollIntoView?.({ block: 'nearest' });
  };

  const closeFormResponseDiscardGuard = (): void => {
    if (!formResponseDiscardGuardOpen) return;
    const pendingTab = formResponseDiscardPendingTab;
    const pendingHref = formResponseDiscardPendingHref;
    formResponseDiscardGuardOpen = false;
    formResponseDiscardReturnId = null;
    formResponseDiscardPendingTab = null;
    formResponseDiscardPendingHref = null;
    render();
    if (pendingTab !== null) focusDataTab(pendingTab);
    else if (pendingHref !== null) focusFormResponseAutomate();
    else focusFormResponseBack();
  };

  const showFormResponseDiscardGuard = (
    pendingTab: DataTabId | null = null,
    pendingHref: string | null = null,
  ): void => {
    if (formResponseDiscardGuardOpen) {
      focusFormResponseDiscardGuard();
      return;
    }
    formResponseDiscardReturnId = pendingTab === null && pendingHref === null
      ? formResponseDetailId
      : null;
    formResponseDiscardPendingTab = pendingTab;
    formResponseDiscardPendingHref = pendingHref;
    formResponseDiscardGuardOpen = true;
    render();
    focusFormResponseDiscardGuard();
  };

  const hasUnsavedFormResponseEditor = (): boolean => {
    syncFormResponseEditorDraftFromDom();
    return formResponseEditorDraft !== null
      && formResponseEditorBaseline !== null
      && formResponseEditorFingerprint(formResponseEditorDraft)
        !== formResponseEditorBaseline;
  };

  const openFormResponse = async (submission_id: string): Promise<void> => {
    if (submission_id.trim().length === 0) return;
    if (pendingFormResponseEditorFocus?.submissionId !== submission_id) {
      pendingFormResponseEditorFocus = null;
    }
    const activeElement = doc.activeElement as HTMLElement | null | undefined;
    pendingFormResponseDetailFocusId =
      isReceivedTab(renderedActiveTab)
      && isReceivedTab(activeTab)
      && activeElement?.getAttribute?.(DATA_ROUTE_ACTION_ATTR)
        === 'open-form-response'
      && activeElement.getAttribute(DATA_ROUTE_FORM_RESPONSE_ID_ATTR)
        === submission_id
        ? submission_id
        : null;
    retireRunVerificationForDifferentItem(activeTab, submission_id);
    resetFormResponseAutomation();
    retireFormResponseEditorDraft();
    const seq = ++formResponseDetailSeq;
    if (!isReceivedTab(activeTab)) activeTab = 'form_response';
    formResponseDetailId = submission_id;
    formResponseDetail = null;
    formResponseEditorDraft = null;
    formResponseDetailError = null;
    loadingFormResponseDetail = true;
    savingFormResponse = false;
    formResponseSaveError = null;
    if (errors.form_responses !== undefined) {
      errors = { ...errors };
      delete errors.form_responses;
    }
    syncDataHash();
    render();
    try {
      if (opts.formResponseGetCaller === undefined) {
        throw new Error('Recued cannot open answers here.');
      }
      const result = await opts.formResponseGetCaller({ submission_id });
      if (
        disposed
        || seq !== formResponseDetailSeq
        || !isReceivedTab(activeTab)
        || formResponseDetailId !== submission_id
      ) return;
      formResponseDetail = result.response;
      formResponseEditorDraft = result.response === null
        ? null
        : formResponseEditorDraftFrom(result.response);
      captureFormResponseEditorBaseline();
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

  const closeFormResponse = (discardChanges = false): void => {
    if (savingFormResponse) return;
    if (formResponseDiscardGuardOpen && !discardChanges) {
      closeFormResponseDiscardGuard();
      return;
    }
    if (!discardChanges && hasUnsavedFormResponseEditor()) {
      showFormResponseDiscardGuard();
      return;
    }
    const activeElement = doc.activeElement as HTMLElement | null | undefined;
    const returnId = formResponseDiscardReturnId
      ?? (activeElement?.getAttribute?.(DATA_ROUTE_ACTION_ATTR)
        === 'close-form-response'
        ? formResponseDetailId
        : null);
    retireRunVerification();
    resetFormResponseAutomation();
    pendingFormResponseDetailFocusId = null;
    formResponseDetailSeq += 1;
    formResponseDetailId = null;
    formResponseDetail = null;
    formResponseEditorDraft = null;
    retireFormResponseEditorDraft();
    pendingFormResponseEditorFocus = null;
    formResponseDetailError = null;
    loadingFormResponseDetail = false;
    savingFormResponse = false;
    formResponseSaveError = null;
    if (errors.form_responses !== undefined) {
      errors = { ...errors };
      delete errors.form_responses;
    }
    syncDataHash();
    render();
    if (returnId !== null) {
      const queryable = routeRoot as unknown as {
        querySelector?: (selector: string) => HTMLElement | null;
        querySelectorAll?: (selector: string) => ArrayLike<HTMLElement>;
      };
      const row = Array.from(
        queryable.querySelectorAll?.(
          `[${DATA_ROUTE_ACTION_ATTR}="open-form-response"]`,
        ) ?? [],
      ).find(
        (candidate) =>
          candidate.getAttribute(DATA_ROUTE_FORM_RESPONSE_ID_ATTR) === returnId,
      );
      const tab = collectionNavigationTarget('form_response');
      (row ?? tab)?.focus?.({ preventScroll: true });
    }
  };

  const saveFormResponse = async (): Promise<void> => {
    const anchor = formResponseDetail;
    if (
      anchor === null
      || opts.formResponseUpdateCaller === undefined
      || opts.formResponseSetStateCaller === undefined
      || savingFormResponse
    ) return;
    const valuesControl = routeRoot.querySelector(
      `[${DATA_ROUTE_FORM_RESPONSE_VALUES_ATTR}]`,
    ) as HTMLTextAreaElement | null;
    const emailControl = routeRoot.querySelector(
      `[${DATA_ROUTE_FORM_RESPONSE_EMAIL_ATTR}]`,
    ) as HTMLInputElement | null;
    const stateControl = routeRoot.querySelector(
      `[${DATA_ROUTE_FORM_RESPONSE_STATE_ATTR}]`,
    ) as HTMLSelectElement | null;
    if (valuesControl === null || emailControl === null || stateControl === null) return;
    formResponseEditorDraft = {
      submissionId: anchor.submission_id,
      valuesText: valuesControl.value,
      email: emailControl.value,
      lifecycle: stateControl.value,
    };
    let values: Record<string, unknown>;
    try {
      const parsed = JSON.parse(valuesControl.value) as unknown;
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('Answers have to be a JSON object.');
      }
      values = parsed as Record<string, unknown>;
    } catch (error) {
      formResponseSaveError = error instanceof Error
        ? error.message
        : 'Recued could not read those answers. Check the JSON.';
      pendingFormResponseEditorFocus = {
        submissionId: anchor.submission_id,
        control: 'values',
      };
      render();
      return;
    }
    if (!FORM_RESPONSE_LIFECYCLE_STATES.includes(stateControl.value as FormResponseLifecycleState)) {
      formResponseSaveError = 'Pick one of the states offered.';
      pendingFormResponseEditorFocus = {
        submissionId: anchor.submission_id,
        control: 'state',
      };
      render();
      return;
    }
    const lifecycle = stateControl.value as FormResponseLifecycleState;
    const email = emailControl.value.trim();
    savingFormResponse = true;
    formResponseSaveError = null;
    render();
    try {
      const updated = await opts.formResponseUpdateCaller({
        submission_id: anchor.submission_id,
        values,
        visitor: email.length > 0 ? { email } : {},
      });
      if (disposed || formResponseDetail !== anchor) return;
      let response = updated.response;
      if (response !== null && lifecycle !== response.lifecycle_state) {
        const stateResult = await opts.formResponseSetStateCaller({
          submission_id: anchor.submission_id,
          lifecycle_state: lifecycle,
        });
        response = stateResult.response;
      }
      if (disposed || formResponseDetail !== anchor) return;
      formResponseDetail = response;
      formResponseEditorDraft = response === null
        ? null
        : formResponseEditorDraftFrom(response);
      captureFormResponseEditorBaseline();
      if (response === null) formResponseSaveError = 'That answer is gone.';
      pendingLoadPromise = refreshActive(true);
      await pendingLoadPromise;
    } catch (error) {
      if (disposed || formResponseDetail !== anchor) return;
      formResponseSaveError = errMessage(error);
      // One of the two narrow mutations may have succeeded. Re-read so the
      // page never pretends the pre-save snapshot is still authoritative.
      pendingFormResponseEditorFocus = {
        submissionId: anchor.submission_id,
        control: 'save',
      };
      await openFormResponse(anchor.submission_id);
      if (!disposed) formResponseSaveError = errMessage(error);
    } finally {
      if (!disposed && formResponseDetailId === anchor.submission_id) {
        savingFormResponse = false;
        render();
      }
    }
  };

  const downloadFormResponseExport = (file: FormResponseExportRpcResponse): void => {
    if (opts.formResponseDownload !== undefined) {
      opts.formResponseDownload(file);
      return;
    }
    const view = doc.defaultView;
    if (view === null || view === undefined || typeof view.URL?.createObjectURL !== 'function') {
      throw new Error('You cannot download files here.');
    }
    const blob = new view.Blob([file.content], { type: file.mime_type });
    const url = view.URL.createObjectURL(blob);
    try {
      const link = doc.createElement('a');
      link.href = url;
      link.download = file.filename;
      link.hidden = true;
      (doc.body ?? opts.root).appendChild(link);
      link.click();
      link.remove();
    } finally {
      view.URL.revokeObjectURL(url);
    }
  };

  const exportFormResponses = async (format: 'json' | 'csv'): Promise<void> => {
    if (
      opts.formResponseExportCaller === undefined
      || exportingFormResponseFormat !== null
    ) return;
    exportingFormResponseFormat = format;
    if (errors.form_responses !== undefined) {
      errors = { ...errors };
      delete errors.form_responses;
    }
    render();
    try {
      // The server bounds ONE rpc payload and hands back `next_cursor` when
      // more remains. Loop it so the owner gets a COMPLETE file: the ceiling
      // used to be a refusal naming filters this tab does not expose, which
      // meant anyone past it could never export at all.
      //
      // ⛔ Never stop early and download what we have — a partial file that
      // looks complete is worse than the refusal it replaced. The bound below
      // is a runaway guard, and hitting it raises rather than saves.
      const MAX_CHUNKS = 50;
      const chunks: string[] = [];
      let file = await opts.formResponseExportCaller({ format });
      let records = file.record_count;
      chunks.push(file.content);
      let guard = 0;
      while (file.next_cursor !== undefined) {
        if (disposed) return;
        guard += 1;
        if (guard >= MAX_CHUNKS) {
          throw new Error(
            `Export is larger than ${MAX_CHUNKS} chunks (${records} records so far). `
            + 'Nothing was downloaded. Pick a smaller range and try again.',
          );
        }
        file = await opts.formResponseExportCaller({
          format,
          before: file.next_cursor,
        });
        chunks.push(file.content);
        records += file.record_count;
      }
      if (disposed) return;
      downloadFormResponseExport({
        ...file,
        // JSON chunks are separate arrays; concatenating their text would not
        // be valid JSON, so re-wrap into one document. CSV chunks concatenate
        // directly — only the first carries a header.
        content: format === 'csv'
          ? chunks.filter((c) => c.length > 0).join('\r\n')
          : JSON.stringify(
            chunks.flatMap((c) => JSON.parse(c) as unknown[]),
            null,
            2,
          ),
        record_count: records,
      });
    } catch (error) {
      if (!disposed) errors = { ...errors, form_responses: errMessage(error) };
    } finally {
      if (!disposed) {
        exportingFormResponseFormat = null;
        render();
      }
    }
  };

  const openTimelineDrilldown = async (
    kind: MirrorDataKind,
    entity_id: string,
  ): Promise<void> => {
    const requestGeneration = ++timelineLoadGeneration;
    retireRunVerificationForDifferentItem(kind, entity_id);
    activeTab = kind;
    timelineEntityId = entity_id;
    syncDataHash();
    if (opts.timelineCaller === undefined) {
      loadingTimeline = false;
      errors = { ...errors, timeline: 'Recued cannot show a timeline here.' };
      render();
      return;
    }
    const trimmed = entity_id.trim();
    if (trimmed.length === 0) {
      loadingTimeline = false;
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
      if (
        disposed
        || requestGeneration !== timelineLoadGeneration
        || activeTab !== kind
        || timelineEntityId !== entity_id
      ) return;
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
      if (
        disposed
        || requestGeneration !== timelineLoadGeneration
        || activeTab !== kind
        || timelineEntityId !== entity_id
      ) return;
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
  const openContactDetail = async (email: string, focusHeading = false): Promise<void> => {
    const trimmed = email.trim();
    if (trimmed.length === 0) return;
    cancelContactEditOpen();
    const activeElement = doc.activeElement as HTMLElement | null | undefined;
    pendingContactDetailFocusEmail =
      focusHeading || renderedActiveTab === 'contact'
      && activeTab === 'contact'
      && activeElement?.getAttribute?.(DATA_ROUTE_ACTION_ATTR)
        === 'open-contact-detail'
      && activeElement.getAttribute(DATA_ROUTE_CONTACT_EMAIL_ATTR) === trimmed
        ? trimmed
        : null;
    retireRunVerificationForDifferentItem('contact', trimmed);
    // Mutually exclusive with the scan page — see `openContactScan`.
    contactScan = null;
    contactScanSeq += 1;
    const navigation = navigationGeneration;
    const pendingDetail: ContactDetailState = {
      email: trimmed,
      from_search: contactSearchReturn?.email === trimmed,
      contact: null,
      response: null,
      contributions: [],
      contributions_failed: false,
    };
    contactDetail = pendingDetail;
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
      { ok: true; contact: ContactRecord | null; identifiers?: ContactAdditionalIdentifiers } | { ok: false; message: string }
    > => {
      if (opts.contactGetCaller === undefined) {
        return {
          ok: true,
          contact: contacts.find((c) => c.email === trimmed) ?? null,
        };
      }
      try {
        const result = await opts.contactGetCaller({ email: trimmed });
        return { ok: true, ...result };
      } catch (err) {
        return { ok: false, message: errMessage(err) };
      }
    };
    const fetchTimeline = async (): Promise<
      { ok: true; response: TimelineResponse | null } | { ok: false; message: string }
    > => {
      if (opts.timelineCaller === undefined) {
        return { ok: false, message: 'Recued cannot show a timeline here.' };
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
    // A reopened profile for the same identity is a newer read as well.
    if (disposed || navigation !== navigationGeneration || contactDetail !== pendingDetail) return;
    // D-325 — a reference by contact id (Today, an occasion) opens the same page
    // by the contact's email, so its timeline and address are the usual ones.
    const byId = contactResult.ok ? contactResult.contact : null;
    if (!trimmed.includes('@') && byId?.email && byId.email !== trimmed) { void openContactDetail(byId.email); return; }

    const nextErrors: DataLoadErrors = { ...errors };
    if (!contactResult.ok) nextErrors.contact_detail = contactResult.message;
    if (!timelineResult.ok) nextErrors.timeline = timelineResult.message;
    if (!contributionsResult.ok) nextErrors.contact_contributions = contributionsResult.message;
    contactDetail = {
      email: trimmed,
      from_search: contactSearchReturn?.email === trimmed,
      contact: contactResult.ok ? contactResult.contact : null,
      ...(contactResult.ok && contactResult.identifiers ? { identifiers: contactResult.identifiers } : {}),
      response: timelineResult.ok ? timelineResult.response : null,
      contributions: contributionsResult.ok ? contributionsResult.contributions : [],
      contributions_failed: !contributionsResult.ok,
      // The recorded history is loading from the first paint, so nothing repaints
      // the detail between a restored focus and the history landing.
      ...(opts.contactHistoryCaller && contactResult.ok && contactResult.contact ? { history: null, history_can_hide: opts.contactEpisodeHideCaller !== undefined } : {}),
    };
    loadingContactDetail = false;
    errors = nextErrors;
    render();
    if (opts.contactHistoryCaller && contactDetail.contact) {
      const current = contactDetail;
      // The history lands after the page has settled (a save has already put focus
      // back on Edit), so its repaint returns focus to the same control.
      const paintKeepingFocus = () => {
        const active = doc.activeElement as HTMLElement | null; const action = active?.getAttribute?.(DATA_ROUTE_ACTION_ATTR);
        const email = active?.getAttribute?.(DATA_ROUTE_CONTACT_EMAIL_ATTR);
        render();
        if (action && active && !active.isConnected) routeRoot.querySelector<HTMLElement>(`[${DATA_ROUTE_ACTION_ATTR}="${CSS.escape(action)}"]`
          + (email ? `[${DATA_ROUTE_CONTACT_EMAIL_ATTR}="${CSS.escape(email)}"]` : ''))?.focus({ preventScroll: true });
      };
      void opts.contactHistoryCaller(current.contact!.contact_id ?? current.contact!.email).then(history => {
        if (disposed || contactDetail !== current || activeTab !== 'contact') return; current.history = history; paintKeepingFocus();
      }).catch(error => { if (!disposed && contactDetail === current && activeTab === 'contact') {
        if (classifyRpcError(error).code === 'unknown_method') delete current.history; else current.history_failed = true; paintKeepingFocus(); } });
    }
  };
  /** D-325 P44 — Hide where an episode is cited: it leaves this page and every list,
   * and is named under Memory exclusions in Yours → Episodes, where it can come back. */
  const hideContactEpisode = async (id: string): Promise<void> => {
    const current = contactDetail;
    if (!current?.contact || !opts.contactEpisodeHideCaller || !opts.contactHistoryCaller) return;
    try {
      await opts.contactEpisodeHideCaller(id);
      const history = await opts.contactHistoryCaller(current.contact.contact_id ?? current.contact.email);
      if (disposed || contactDetail !== current) return;
      current.history = history; render();
      routeRoot.querySelector<HTMLElement>('[data-contact-proactive-history] h3')?.setAttribute('tabindex', '-1');
      routeRoot.querySelector<HTMLElement>('[data-contact-proactive-history] h3')?.focus({ preventScroll: true });
    } catch (error) {
      if (disposed || contactDetail !== current) return;
      errors = { ...errors, contacts: errMessage(error) }; render();
    }
  };

  // D-172 Half-A "open" — turn a `data.file.read` result into a browser save.
  // Guarded on the `window` blob/URL APIs (absent in the test fake DOM →
  // no-op, the caller assertion still holds).
  const triggerFileDownload = (file: {
    bytes: Uint8Array;
    mime_type: string;
    filename: string;
  }): void => {
    const view = doc.defaultView as unknown as {
      atob?: (s: string) => string;
      Blob?: typeof Blob;
      URL?: { createObjectURL(b: Blob): string; revokeObjectURL(u: string): void };
    } | null | undefined;
    if (!view?.Blob || !view.URL) return;
    const blob = new view.Blob([new Uint8Array(file.bytes)], {
      type: file.mime_type || 'application/octet-stream',
    });
    const url = view.URL.createObjectURL(blob);
    const anchor = doc.createElement('a');
    anchor.href = url;
    anchor.download = file.filename || 'download';
    anchor.click();
    setTimeout(() => view.URL!.revokeObjectURL(url), 1000);
  };

  const loadFileUsage = async (error?: string): Promise<void> => {
    const fileId = explorerDetail?.record_id;
    if (!fileId || !opts.fileUsageCaller || activeTab !== 'files') return;
    const generation = ++fileLifecycleGeneration;
    fileLifecycle = { fileId, busy: true, ...(error ? { error } : {}) }; render();
    try {
      const preview = await opts.fileUsageCaller({ record_id: fileId });
      if (disposed || generation !== fileLifecycleGeneration || activeTab !== 'files' || explorerDetail?.record_id !== fileId) return;
      fileLifecycle = { fileId, preview, busy: false, ...(error ? { error } : {}) };
    } catch (failure) {
      if (disposed || generation !== fileLifecycleGeneration || activeTab !== 'files' || explorerDetail?.record_id !== fileId) return;
      fileLifecycle = { fileId, busy: false, error: errMessage(failure) };
    }
    render();
  };
  const finishFileMutation = async (current: FileLifecyclePanelState, action: FileLifecycleMutation['action'], notice?: string): Promise<void> => {
    explorerRecords = explorerRecords.filter(record => record.record_id !== current.fileId && record.record_id !== current.preview?.record_id);
    fileLifecycle = undefined; explorerDetail = null;
    fileLifecycleNotice = notice ?? (action === 'archive' ? 'File put away. You can still find it under archived files, and in your conversations.'
      : action === 'restore' ? 'File restored to your library.' : 'File deleted for good. The messages about it are still there.');
    // Show the confirmed change even when the following list read is slow.
    render();
    await loadExplorer('files', explorerSelectedSlug ?? undefined);
    if (!disposed && activeTab === 'files') render();
  };
  const mutateFile = async (action: FileLifecycleMutation['action']): Promise<void> => {
    const current = fileLifecycle;
    if (!current?.preview || current.busy || (action === 'delete' && current.preview.in_use) || !opts.fileMutateCaller
      || activeTab !== 'files' || explorerDetail?.record_id !== current.fileId
      || (action === 'restore' && current.preview.can_restore !== true)
      || (action === 'delete' && !current.confirmDelete)) return;
    const generation = ++fileLifecycleGeneration;
    fileLifecycle = { ...current, busy: true, operation: action }; render();
    try {
      opaqueMutationsInFlight += 1;
      try {
        await opts.fileMutateCaller({ record_id: current.preview.record_id, action, revision: current.preview.revision });
      } finally { opaqueMutationsInFlight -= 1; }
      if (disposed || generation !== fileLifecycleGeneration || activeTab !== 'files' || explorerDetail?.record_id !== current.fileId) return;
      await finishFileMutation(current, action);
    } catch (error) {
      if (disposed || generation !== fileLifecycleGeneration || activeTab !== 'files' || explorerDetail?.record_id !== current.fileId) return;
      // Check state after a race or lost response without repeating the write.
      await loadFileUsage(errMessage(error));
      if (action === 'restore' && !disposed && fileLifecycleGeneration === generation + 1
        && activeTab === 'files' && explorerDetail?.record_id === current.fileId
        && fileLifecycle?.fileId === current.fileId && fileLifecycle.preview
        && !fileLifecycle.preview.archived && !fileLifecycle.preview.deleted) {
        await finishFileMutation(current, action, 'The file is in your library.');
      }
    }
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
    const abort = new AbortController(); fileDownloadAbort = abort;
    const cleared = { ...errors };
    delete cleared.timeline;
    errors = cleared;
    render();
    try {
      const file = await readStoredFileDownload({ record_id: recordId }, { read: opts.fileReadCaller }, abort.signal);
      if (disposed || !file) return;
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

  const focusRescheduleAction = (
    action: 'reschedule-open' | 'reschedule-input' | 'reschedule-submit',
  ): void => {
    const target = routeRoot.querySelector?.(
      `[${DATA_ROUTE_ACTION_ATTR}="${action}"]`,
    ) as HTMLElement | null | undefined;
    target?.focus?.({ preventScroll: true });
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
      rescheduleForm = { ...rescheduleForm, error: 'You cannot move this event.' };
      render();
      focusRescheduleAction('reschedule-input');
      return;
    }
    // An all-day event moves by days: the picked day as it is stored (its UTC
    // midnight), the same number of days long. A timed one by local time.
    const allDay = rescheduleForm.allDay === true;
    const newStart = allDay
      ? calendarDayMs(rescheduleForm.value) ?? Number.NaN
      : new Date(rescheduleForm.value).getTime();
    if (!Number.isFinite(newStart)) {
      rescheduleForm = { ...rescheduleForm, error: allDay ? 'Pick a new day.' : 'Pick a new start time.' };
      render();
      focusRescheduleAction('reschedule-input');
      return;
    }
    const hot = record.hot_fields;
    const curStart = Number(hot.start_at);
    const curEnd = Number(hot.end_at);
    const durationMs =
      Number.isFinite(curStart) && Number.isFinite(curEnd) && curEnd > curStart
        ? curEnd - curStart
        : allDay ? DAY_MS : 0;
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
        rescheduleForm = { value: keepValue, submitting: false, error: 'This move needs you to say yes.', allDay };
        render();
        return;
      }
      if (res.success) {
        rescheduleForm = null;
        const refresh = openExplorerRecord(recordId); // refresh the detail + timeline
        pendingRescheduleOpenFocusId = recordId;
        void refresh;
        return;
      }
      rescheduleForm = { value: keepValue, submitting: false, error: 'Recued could not move it. Try again.', allDay };
      render();
    } catch (err) {
      if (disposed || seq !== explorerSeq) return;
      rescheduleForm = { value: keepValue, submitting: false, error: errMessage(err), allDay };
      render();
    }
  };

  const closeContactDetail = (): void => {
    if (contactDetail === null) return;
    if (contactSearchReturn) { returnToContactSearch(); return; }
    const activeElement = doc.activeElement as HTMLElement | null | undefined;
    const returnEmail =
      activeElement?.getAttribute?.(DATA_ROUTE_ACTION_ATTR)
        === 'close-contact-detail'
        ? contactDetail.email
        : null;
    retireRunVerification();
    cancelContactEditOpen();
    pendingContactDetailFocusEmail = null;
    contactDetail = null;
    loadingContactDetail = false;
    // The detail's failures die with the detail — carrying them back would show
    // an error banner over a list that is fine.
    const { timeline: _t, contact_detail: _d, ...rest } = errors;
    errors = rest;
    syncDataHash();
    render();
    if (returnEmail !== null) {
      const row = Array.from(
        routeRoot.querySelectorAll<HTMLElement>(
          `[${DATA_ROUTE_CONTACT_EMAIL_ATTR}]`,
        ),
      ).find(
        (candidate) =>
          candidate.getAttribute(DATA_ROUTE_ACTION_ATTR)
            === 'open-contact-detail'
          && candidate.getAttribute(DATA_ROUTE_CONTACT_EMAIL_ATTR)
            === returnEmail,
      );
      const search = routeRoot.querySelector(
        `[${DATA_ROUTE_CONTACT_SEARCH_ATTR}]`,
      ) as HTMLElement | null;
      const tab = collectionNavigationTarget('contact');
      (row ?? search ?? tab)?.focus?.({ preventScroll: true });
    }
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
    cancelContactEditOpen();
    contactDetail = null;
    loadingContactDetail = false;
    if (contactScan === null) {
      contactScan = {
        dialog: initialMergeReviewDialogState(),
        loading: true,
        scanning: false,
        progress: null,
        last_scan: null,
        last_resolution: null,
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
  // A file picker can be used again while the prior preview is still parsing.
  // Keep the derived plan attached to the exact pick that produced it.
  let contactImportFilePreviewSeq = 0;
  const contactImportFileApplyPending = (): boolean =>
    contactImport?.file?.busy === true && contactImport.file.plan !== null;
  const contactImportMutationPending = (): boolean =>
    contactImport?.promoting === true || contactImportFileApplyPending();
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
    cancelContactEditOpen();
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
    if (contactImport === null || contactImportMutationPending()) return;
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
    if (
      caller === undefined
      || contactImport === null
      || contactImportMutationPending()
    ) return;
    const previewSeq = ++contactImportFilePreviewSeq;
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
        occasions: {},
        busy: true,
        result: null,
      },
    };
    render();
    try {
      const text = await file.text();
      const plan = await caller({ text });
      if (
        disposed
        || previewSeq !== contactImportFilePreviewSeq
        || contactImport?.file == null
      ) return;
      contactImport = {
        ...contactImport,
        file: { ...contactImport.file, text, plan, busy: false, occasions: Object.fromEntries((plan.occasions ?? []).map(date => [date.key, { key: date.key, selected: false, recurrence: date.existing?.recurrence ?? 'yearly', reminder_days: 7, ...(date.existing ? { expected_version: date.existing.version } : {}) }])) },
      };
    } catch (err) {
      if (
        disposed
        || previewSeq !== contactImportFilePreviewSeq
        || contactImport?.file == null
      ) return;
      contactImport = { ...contactImport, file: null };
      errors = { ...errors, contact_import: errMessage(err) };
    }
    render();
  };

  const applyImportFile = async (): Promise<void> => {
    const caller = opts.contactImportFileApplyCaller;
    const currentFile = contactImport?.file ?? null;
    if (
      caller === undefined
      || contactImport === null
      || currentFile === null
      || currentFile.busy
      || currentFile.plan === null
    ) return;
    const { text, apply_changes } = currentFile;
    // Keep an exact owner identity as well as locking the visible controls. If
    // another route transition replaces the import state programmatically, the
    // old response must not graft its receipt onto that newer view.
    const applyingFile = { ...currentFile, busy: true };
    contactImport = { ...contactImport, file: applyingFile };
    render();
    try {
      const occasions = Object.values(currentFile.occasions).filter(date => date.selected).map(({ selected: _selected, ...choice }) => choice);
      const res = await caller({ text, apply_changes, ...(occasions.length ? { occasions } : {}) });
      if (disposed || contactImport?.file !== applyingFile) return;
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
      if (disposed || contactImport?.file !== applyingFile) return;
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
      || contactImport.loading
    ) {
      return;
    }
    const source_id = contactImport.source_id;
    const target_ids = [...contactImport.selected];
    const promotingImport = { ...contactImport, promoting: true, result: null };
    contactImport = promotingImport;
    render();
    try {
      const res = await caller({ source_id, target_ids });
      if (disposed || contactImport !== promotingImport) return;
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
      if (disposed || contactImport !== promotingImport) return;
      contactImport = { ...contactImport, promoting: false };
      errors = { ...errors, contact_import: errMessage(err) };
      render();
    }
  };

  const closeContactScan = (): void => {
    if (
      contactScan === null
      || contactScan.scanning
      || contactScan.dialog.saving
    ) return;
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
    if (
      contactScan === null
      || scanCaller === undefined
      || contactScan.scanning
      || contactScan.progress !== null
      || contactScan.loading
      || contactScan.dialog.saving
    ) return;
    contactScan = {
      ...contactScan,
      scanning: true,
      last_scan: null,
      last_resolution: null,
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
      const carryFocus =
        (doc.activeElement as HTMLElement | null | undefined)?.getAttribute?.(
          DATA_ROUTE_ACTION_ATTR,
        ) === 'run-merge-scan';
      contactScan = {
        ...contactScan,
        scanning: false,
        loading: true,
        progress: null,
        last_scan: { iterated: result.iterated, surfaced_count: result.surfaced_count },
      };
      render();
      if (carryFocus) focusContactScanOwner('result');
      await hydrateMergeQueue();
    } catch (err) {
      if (disposed || contactScan === null) return;
      const carryFocus =
        (doc.activeElement as HTMLElement | null | undefined)?.getAttribute?.(
          DATA_ROUTE_ACTION_ATTR,
        ) === 'run-merge-scan';
      contactScan = { ...contactScan, scanning: false, progress: null };
      errors = { ...errors, contact_merge: errMessage(err) };
      render();
      if (carryFocus) focusContactScanOwner('action');
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
    if (
      contactScan === null
      || contactScan.loading
      || contactScan.scanning
      || contactScan.progress !== null
      || contactScan.dialog.saving
    ) return;
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
    if (
      contactScan === null
      || contactScan.loading
      || contactScan.scanning
      || contactScan.progress !== null
      || contactScan.dialog.saving
    ) return;
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
    if (
      contactScan === null
      || contactScan.loading
      || contactScan.scanning
      || contactScan.progress !== null
      || contactScan.dialog.saving
    ) return;
    const item = currentMergeItem();
    if (item === null) return;
    const caller =
      resolution === 'confirm'
        ? opts.contactMergeConfirmCaller
        : opts.contactMergeRejectCaller;
    if (caller === undefined) return;
    const candidateIds = item.candidates.map((c) => c.id);
    const survivorEmail = currentSurvivor(item);
    const mergeAction = resolution === 'confirm'
      ? 'contact-merge-confirm' as const
      : 'contact-merge-reject' as const;
    contactScan = {
      ...contactScan,
      last_resolution: null,
      dialog: {
        ...contactScan.dialog,
        saving: true,
        saving_action: resolution,
        error: null,
      },
    };
    render();
    try {
      if (resolution === 'confirm') {
        const confirmCaller = opts.contactMergeConfirmCaller;
        if (confirmCaller === undefined) return;
        await confirmCaller({
          candidate_ids: candidateIds,
          survivor_email: survivorEmail,
        });
      } else {
        const rejectCaller = opts.contactMergeRejectCaller;
        if (rejectCaller === undefined) return;
        await rejectCaller({ candidate_ids: candidateIds });
      }
      if (disposed || contactScan === null) return;
      const carryFocus =
        (doc.activeElement as HTMLElement | null | undefined)?.getAttribute?.(
          SHARED_ACTION_ATTR,
        ) === mergeAction;
      contactScan = {
        ...contactScan,
        loading: true,
        last_resolution: resolution,
        dialog: {
          ...contactScan.dialog,
          saving: false,
          saving_action: undefined,
        },
      };
      render();
      if (carryFocus) focusContactMergeOwner('result');
      // The resolved cluster leaves the pending queue, so re-hydrate rather than
      // splice locally: a confirm rewrites annotations + links onto the survivor
      // and can cascade, and the list behind us is now stale too.
      await hydrateMergeQueue();
      if (disposed) return;
      pendingLoadPromise = refreshActive(true);
    } catch (err) {
      if (disposed || contactScan === null) return;
      const carryFocus =
        (doc.activeElement as HTMLElement | null | undefined)?.getAttribute?.(
          SHARED_ACTION_ATTR,
        ) === mergeAction;
      contactScan = {
        ...contactScan,
        dialog: {
          ...contactScan.dialog,
          saving: false,
          saving_action: undefined,
          error: errMessage(err),
        },
      };
      render();
      if (carryFocus) focusContactMergeOwner(mergeAction);
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

    const automateLink = targetWithAttr(
      ev,
      DATA_ROUTE_FORM_RESPONSE_AUTOMATE_ATTR,
    );
    if (automateLink !== null && formResponseDetail !== null) {
      const href = automateLink.getAttribute('href');
      if (savingFormResponse || (href !== null && hasUnsavedFormResponseEditor())) {
        ev.preventDefault();
        ev.stopPropagation();
        if (savingFormResponse) {
          pendingFormResponseEditorFocus = {
            submissionId: formResponseDetail.submission_id,
            control: 'save',
          };
          render();
        } else if (href !== null) {
          showFormResponseDiscardGuard(null, href);
        }
        return;
      }
    }

    const target = targetWithAttr(ev, DATA_ROUTE_ACTION_ATTR)
      ?? targetWithAttr(ev, SHARED_ACTION_ATTR);
    if (target === null) return;
    const action =
      target.getAttribute(DATA_ROUTE_ACTION_ATTR)
      ?? target.getAttribute(SHARED_ACTION_ATTR)
      ?? '';
    if (activeLens === 'data' && activeTab === 'task' && taskBulk.handleAction(action)) return;
    if (taskBulk.busy()) { focusTaskBatch(); return; }
    if (activeLens === 'data' && activeTab === 'calendar' && calendarCreateSurface.handleAction(action)) return;
    if (activeLens === 'data' && activeTab === 'calendar' && explorerDetail === null
      && calendarAgenda.handleAction(action, target)) return;
    if (action.startsWith(CALENDAR_EVENT_ACTION_PREFIX)) {
      if (activeLens === 'data' && activeTab === 'calendar') calendarEventSurface.handleAction(action);
      return;
    }
    if (action.startsWith('mail-message-')) {
      if (activeLens === 'data' && activeTab === 'mail') mailMessageSurface.handleAction(action, target);
      return;
    }
    if (action.startsWith(MAIL_FACTS_ACTION_PREFIX)) {
      if (activeLens === 'data' && activeTab === 'mail_fact') mailFacts.handleAction(action, target);
      return;
    }
    if (action.startsWith(REMINDERS_ACTION_PREFIX)) {
      if (activeLens === 'data' && activeTab === 'reminder') remindersSurface.handleAction(action, target);
      return;
    }
    // D-315 §6 — from an email in Data → Mail to Data → Received → Mail facts.
    if (action === 'mail-fact-make-template' || action === 'mail-fact-show-email') {
      const slug = explorerSelectedSlug;
      const detail = explorerDetail;
      if (slug === null || detail === null || activeTab !== 'mail') return;
      const email = { slug, record_id: detail.record_id };
      const subject = detail.record?.hot_fields.subject;
      // The tab's intent first, so the tab opens on it.
      if (action === 'mail-fact-make-template') void mailFacts.makeTemplateFrom(email);
      else void mailFacts.showEmail(email, typeof subject === 'string' ? subject : undefined);
      void selectTab('mail_fact');
      return;
    }
    if (memoryDeletingId !== null && action.startsWith('memory-')) {
      focusMemoryDeleteConfirm(memoryDeletingId);
      return;
    }
    if (memoryFilteringOrigin !== null && action.startsWith('memory-')) {
      ev.preventDefault();
      focusMemoryOriginFilter(memoryFilteringOrigin);
      return;
    }
    if (memoryExporting && action.startsWith('memory-')) {
      ev.preventDefault();
      focusMemoryExport();
      return;
    }
    if (memoryEditOpeningId !== null && action.startsWith('memory-')) {
      focusMemoryEditAction(memoryEditOpeningId);
      return;
    }
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
    if (action === MEMORY_COMPOSE_DISCARD_KEEP_ACTION) {
      closeMemoryComposeDiscardGuard();
      return;
    }
    if (action === MEMORY_COMPOSE_DISCARD_COMMIT_ACTION) {
      cancelMemoryCompose(true);
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
    if (action === MEMORY_MORE_ACTION) {
      void loadMoreMemory();
      return;
    }
    if (action === MEMORY_OPEN_RUN_ACTION) return;
    if (action === MEMORY_IMPORT_ACTION) {
      openMemoryImport();
      return;
    }
    if (action === MEMORY_IMPORT_DISCARD_KEEP_ACTION) {
      closeMemoryImportDiscardGuard();
      return;
    }
    if (action === MEMORY_IMPORT_DISCARD_COMMIT_ACTION) {
      cancelMemoryImport(true);
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
      || action === MEMORY_REPLACE_ACTION
      || action === MEMORY_DELETE_ACTION
      || action === MEMORY_DELETE_CONFIRM_ACTION
      || action === MEMORY_DELETE_CANCEL_ACTION
      || action === MEMORY_RESTORE_ACTION
    ) {
      const memoryId = target.getAttribute(MEMORY_ROW_ID_ATTR);
      if (memoryId === null || memoryId.length === 0) return;
      if (action === MEMORY_OPEN_ACTION) void openMemoryDetail(memoryId);
      else if (action === MEMORY_EDIT_ACTION) void openMemoryEdit(memoryId);
      else if (action === MEMORY_REPLACE_ACTION) void openMemoryEdit(memoryId, 'replace');
      else if (action === MEMORY_DELETE_ACTION) requestMemoryDelete(memoryId);
      else if (action === MEMORY_DELETE_CONFIRM_ACTION) void confirmMemoryDelete(memoryId);
      else if (action === MEMORY_RESTORE_ACTION) void restoreMemory(memoryId);
      else cancelMemoryDelete();
      return;
    }
    // CSV imports use the selected pack's declared recipe and the shared
    // guided import. The remaining owner controls use records.* directly.
    // D-221 — pack Records owner explorer. These actions call only the
    // `records.*` registered-pair control plane; none dispatch through a
    // recipe `data` namespace or through the agent-facing catalog executor.
    const recordsNavigationLocked =
      recordsState.deleting
      || recordsState.retiringEventBusy
      || recordsState.purging
      || recordsState.loadingNamespaceKey !== null
      || recordsState.loadingKind !== null
      || recordsImport.hasInFlightWork();
    if (action === RECORDS_IMPORT_OPEN || action === RECORDS_IMPORT_RETRY) {
      if (recordsNavigationLocked || recordsState.loading) return;
      if (action === RECORDS_IMPORT_RETRY) void recordsImport.retry();
      else recordsImport.open(target.getAttribute(RECORDS_IMPORT_RECIPE_ATTR) ?? '');
      return;
    }
    if (action === 'records-add-filter' || action === 'records-remove-filter') {
      if (recordsNavigationLocked || recordsState.loading || hasRecordsInFlightWork()) return;
      const filters = recordsState.viewDraft.filters;
      const fields = recordsState.selectedNamespace?.schema.entities[recordsState.selectedKind ?? '']?.fields ?? [];
      const field = fields.find(field => field.kind !== 'id' && !filters.some(row => row.field === field.key));
      if (action === 'records-add-filter' && (!field || filters.length >= RECORDS_MAX_PREDICATES)) return;
      recordsState = { ...recordsState, viewDraft: { ...recordsState.viewDraft, filters: action === 'records-add-filter'
        ? [...filters, { field: field!.key, op: recordsFilterOperators(field!)[0]!, value: '' }]
        : filters.filter((_, i) => i !== Number(target.getAttribute('data-records-filter-index'))) } };
      render();
      focusRecordsAction('records-add-filter');
      return;
    }
    if (action === 'records-reset-view' || action === 'records-apply-view' || action === 'records-clear-filters') {
      ev.preventDefault();
      if (!recordsNavigationLocked) applyRecordsView(action === 'records-reset-view' ? 'reset'
        : action === 'records-clear-filters' ? 'clear-filters' : 'apply');
      return;
    }
    if (action === 'records-next-page' || action === 'records-prev-page' || action === 'records-first-page') {
      if (recordsNavigationLocked || recordsState.loading || recordsViewHasDraft(recordsState)) return;
      const cursor = action === 'records-next-page' ? recordsState.nextCursor : recordsState.prevCursor;
      if (action === 'records-first-page') pendingLoadPromise = loadRecordsPage();
      else if (cursor) pendingLoadPromise = loadRecordsPage(cursor, Math.max(1, recordsState.page + (action === 'records-next-page' ? 1 : -1)));
      return;
    }
    if (action === RECORDS_SELECT_NAMESPACE_ACTION) {
      if (recordsNavigationLocked) return;
      const key = target.getAttribute(RECORDS_NAMESPACE_ATTR);
      if (key !== null) void selectRecordsNamespace(key);
      return;
    }
    if (action === RECORDS_SELECT_KIND_ACTION) {
      if (recordsNavigationLocked) return;
      const kind = target.getAttribute(RECORDS_KIND_ATTR);
      if (kind !== null) void selectRecordsKind(kind);
      return;
    }
    if (action === RECORDS_OPEN_RECORD_ACTION) {
      if (recordsNavigationLocked) return;
      const id = target.getAttribute(RECORDS_ID_ATTR);
      if (id !== null) void openRecordsRecord(id);
      return;
    }
    if (action === RECORDS_OPEN_REFERENCE_ACTION) {
      if (recordsNavigationLocked) return;
      const kind = target.getAttribute(RECORDS_KIND_ATTR);
      const id = target.getAttribute(RECORDS_ID_ATTR);
      if (kind !== null && id !== null) void openRecordsReference(kind, id);
      return;
    }
    if (action === RECORDS_CLOSE_RECORD_ACTION) {
      if (recordsNavigationLocked) return;
      const recordId = recordsState.detail?.id ?? null;
      recordsSeq += 1;
      recordsState = {
        ...recordsState,
        detail: null,
        diagnostics: null,
        deletePending: false,
        deleting: false,
        error: undefined,
      };
      render();
      if (recordId !== null) focusRecordsListReturn(recordId);
      return;
    }
    if (action === RECORDS_DELETE_RECORD_ACTION) {
      if (recordsNavigationLocked) return;
      recordsState = { ...recordsState, deletePending: true, error: undefined };
      render();
      focusRecordsAction(RECORDS_CONFIRM_DELETE_ACTION);
      return;
    }
    if (action === RECORDS_CANCEL_DELETE_ACTION) {
      if (recordsNavigationLocked) return;
      recordsState = { ...recordsState, deletePending: false, error: undefined };
      render();
      focusRecordsAction(RECORDS_DELETE_RECORD_ACTION);
      return;
    }
    if (action === RECORDS_CONFIRM_DELETE_ACTION) {
      if (recordsState.retiringEventBusy || recordsState.purging) return;
      void confirmRecordsDelete();
      return;
    }
    if (action === RECORDS_EXPORT_PACK_ACTION) {
      if (recordsNavigationLocked) return;
      void exportRecords('json');
      return;
    }
    if (action === RECORDS_EXPORT_KIND_ACTION) {
      if (recordsNavigationLocked) return;
      if (recordsState.selectedKind !== null) void exportRecords('json', recordsState.selectedKind);
      return;
    }
    if (action === RECORDS_EXPORT_PACK_CSV_ACTION) {
      if (recordsNavigationLocked) return;
      void exportRecords('csv');
      return;
    }
    if (action === RECORDS_EXPORT_KIND_CSV_ACTION) {
      if (recordsNavigationLocked) return;
      if (recordsState.selectedKind !== null) void exportRecords('csv', recordsState.selectedKind);
      return;
    }
    if (action === RECORDS_REFRESH_CHANGES_ACTION) {
      if (recordsNavigationLocked) return;
      void refreshRecordsChanges();
      return;
    }
    if (action === RECORDS_MARK_REVIEWED_ACTION) {
      if (recordsNavigationLocked) return;
      void markRecordsReviewed();
      return;
    }
    if (action === RECORDS_TOGGLE_CHANGES_ACTION) {
      ev.preventDefault();
      if (recordsNavigationLocked) return;
      const opening = !recordsState.changesOpen;
      recordsState = { ...recordsState, changesOpen: opening };
      render();
      // Read on FIRST open only. The panel is collapsed for most visits and a
      // fetch per toggle would bill a query to closing it.
      focusRecordsChangesSummary();
      if (opening && recordsState.changes === null) void refreshRecordsChanges();
      return;
    }
    if (action === RECORDS_REFRESH_OUTBOX_ACTION) {
      if (recordsNavigationLocked) return;
      void refreshRecordsOutbox();
      return;
    }
    if (action === RECORDS_TOGGLE_OUTBOX_ACTION) {
      ev.preventDefault();
      if (recordsNavigationLocked) return;
      recordsState = { ...recordsState, outboxOpen: !recordsState.outboxOpen };
      render();
      focusRecordsOutboxSummary();
      return;
    }
    if (action === RECORDS_RETIRE_EVENT_ACTION) {
      if (recordsNavigationLocked) return;
      const eventId = target.getAttribute(RECORDS_EVENT_ID_ATTR);
      if (eventId !== null) {
        recordsState = {
          ...recordsState,
          outboxOpen: true,
          retiringEventId: eventId,
          retiringEventBusy: false,
          error: undefined,
        };
        render();
        focusRecordsAction(
          RECORDS_CONFIRM_RETIRE_EVENT_ACTION,
          RECORDS_EVENT_ID_ATTR,
          eventId,
        );
      }
      return;
    }
    if (action === RECORDS_CANCEL_RETIRE_EVENT_ACTION) {
      if (recordsNavigationLocked) return;
      const eventId = recordsState.retiringEventId;
      recordsState = {
        ...recordsState,
        outboxOpen: true,
        retiringEventId: null,
        retiringEventBusy: false,
      };
      render();
      if (eventId !== null) {
        focusRecordsAction(
          RECORDS_RETIRE_EVENT_ACTION,
          RECORDS_EVENT_ID_ATTR,
          eventId,
        );
      }
      return;
    }
    if (action === RECORDS_CONFIRM_RETIRE_EVENT_ACTION) {
      if (recordsState.deleting || recordsState.purging) return;
      const eventId = target.getAttribute(RECORDS_EVENT_ID_ATTR);
      if (eventId !== null) void retireRecordsEvent(eventId);
      return;
    }
    if (action === RECORDS_PURGE_ACTION) {
      if (recordsNavigationLocked) return;
      recordsState = {
        ...recordsState,
        purgePending: true,
        purgeConfirmation: '',
        error: undefined,
      };
      render();
      focusRecordsPurgeInput();
      return;
    }
    if (action === RECORDS_CANCEL_PURGE_ACTION) {
      if (recordsNavigationLocked) return;
      recordsState = {
        ...recordsState,
        purgePending: false,
        purgeConfirmation: '',
        error: undefined,
      };
      render();
      focusRecordsAction(RECORDS_PURGE_ACTION);
      return;
    }
    if (action === RECORDS_CONFIRM_PURGE_ACTION) {
      if (recordsState.deleting || recordsState.retiringEventBusy) return;
      void purgeRecordsNamespace(recordsState.purgeConfirmation);
      return;
    }
    // D-198 Slice 5 — collection explorer dispatch (mail / calendar / files).
    // Fire-and-forget (NOT chained onto `pendingLoadPromise`): both read
    // `EXPLORER_TAB_PLATFORM[activeTab]` synchronously at click time, so a
    // deferred continuation can't reinterpret the click under a tab the user
    // switched to meanwhile. The record detail is set synchronously (the button
    // paints at once); the async `collection.get` is `explorerSeq`-guarded.
    if (action === COLLECTION_RETRY_ACTION) {
      void retryExplorer();
      return;
    }
    if (action === COLLECTION_DETAIL_RETRY_ACTION) {
      void retryExplorerDetail();
      return;
    }
    if (action === COLLECTION_SELECT_INSTANCE_ACTION) {
      const slug = target.getAttribute(COLLECTION_INSTANCE_SLUG_ATTR);
      if (slug !== null) void selectExplorerInstance(slug);
      return;
    }
    if (action === COLLECTION_OPEN_RECORD_ACTION) {
      const recordId = target.getAttribute(COLLECTION_RECORD_ID_ATTR);
      const agendaSource = target.getAttribute(AGENDA_SOURCE), agendaKey = target.getAttribute(AGENDA_FOCUS);
      if (activeTab === 'calendar' && explorerDetail === null && agendaSource && agendaKey && recordId) {
        void openCalendarAgendaEvent(agendaSource, recordId, agendaKey);
      } else if (recordId !== null && recordId.length > 0) void openExplorerRecord(recordId);
      return;
    }
    if (action === COLLECTION_DETAIL_CLOSE_ACTION) {
      closeExplorerDetail();
      return;
    }
    // ── UNIVERSAL SEARCH ────────────────────────────────────────────────────
    if (action === 'return-project-overview') { returnToProjectOverview(); return; }
    if (action === 'return-work-search') {
      if (workEntityState.dialog) closeWorkEntityDialog(); else returnToWorkSearch();
      return;
    }
    if (action === SEARCH_OPEN_ASSET_ACTION) {
      const mouse = ev as MouseEvent;
      if (mouse.button > 0 || mouse.ctrlKey || mouse.metaKey || mouse.shiftKey || mouse.altKey) return;
      const id = target.getAttribute(SEARCH_ASSET_ID_ATTR);
      if (!id || !assetSearch.state().matches.some(row => row.id === id)) { ev.preventDefault(); return; }
      saveSearchAssetReturn(doc, searchContinuityOwner, { assetId: id,
        returnHash: doc.defaultView?.location.hash ?? '#data/search', state: captureSearchState(),
        scroll: { top: workSearchScrollHost()?.scrollTop ?? 0, left: 0 } });
      // Leave native anchor navigation intact, including keyboard and new-tab use.
      return;
    }
    if (action === SEARCH_MORE_ASSETS_ACTION) {
      const state = assetSearch.state();
      if (!state.loading) void assetSearch.load(universalSearchQuery, state.error ? state.retry_append === true : true);
      return;
    }
    if (action === SEARCH_OPEN_CONTACT_ACTION) {
      const email = target.getAttribute(SEARCH_CONTACT_EMAIL_ATTR);
      if (email) void openContactSearchResult(email);
      return;
    }
    if (action === SEARCH_MORE_CONTACTS_ACTION) {
      if (!universalSearchContactLoading) void loadUniversalContactSearch(!!universalSearchContactError);
      return;
    }
    if (action === SEARCH_OPEN_WORK_ACTION || action === SEARCH_MORE_WORK_ACTION) {
      const kind = WORK_ENTITY_SEARCH_KINDS.find(value => value === target.getAttribute(SEARCH_WORK_KIND_ATTR));
      if (!kind) return;
      if (action === SEARCH_MORE_WORK_ACTION) {
        if (!universalSearchWorkLoadingKinds.has(kind)) {
          void loadMoreWorkSearch(kind, !!universalSearchWorkGroups?.find(group => group.kind === kind)?.error);
        }
      } else {
        const id = target.getAttribute(SEARCH_WORK_ID_ATTR);
        if (id) void openWorkSearchResult(kind, id);
      }
      return;
    }
    if (action === SEARCH_OPEN_RECORD_ACTION || action === SEARCH_OPEN_GROUP_ACTION) {
      const recordId = target.getAttribute(SEARCH_RECORD_ID_ATTR);
      const slug = target.getAttribute(SEARCH_GROUP_SLUG_ATTR);
      const platform = target.getAttribute(SEARCH_GROUP_PLATFORM_ATTR);
      // Collection platforms use `file`; the Data tab is named `files`.
      const tab = platform === 'file' ? 'files'
        : platform === 'mail' || platform === 'calendar' ? platform : null;
      if (action === SEARCH_OPEN_RECORD_ACTION && (recordId === null || recordId.length === 0)) return;
      if (tab !== null && slug !== null && slug.length > 0) {
        void openSearchDestination(tab, slug,
          action === SEARCH_OPEN_RECORD_ACTION ? recordId ?? undefined : undefined);
      }
      return;
    }
    if (action === SEARCH_OPEN_RECIPE_ACTION) {
      // ⛔ OPENS, NEVER RUNS. A search result is a finding affordance; running a
      // recipe is an action that belongs on the approval path, not on a click
      // in a list the owner is scanning.
      const recipeId = target.getAttribute(SEARCH_RECIPE_ID_ATTR);
      const view = doc.defaultView;
      if (recipeId !== null && recipeId.length > 0 && view !== null && view !== undefined) {
        view.location.hash = serializeShellRoute('recipes', recipeId);
      }
      return;
    }
    if (action === SEARCH_OPEN_PACK_ACTION) {
      // Pack detail owns install / uninstall / grants — a pack install carries
      // permissions, so it can never be a click in a result list.
      const slug = target.getAttribute(SEARCH_PACK_SLUG_ATTR);
      const view = doc.defaultView;
      if (slug !== null && slug.length > 0 && view !== null && view !== undefined) {
        view.location.hash = serializeShellRoute('packs', slug);
      }
      return;
    }
    if (action === SEARCH_MARKETPLACE_ACTION) {
      void runMarketplaceSearch();
      return;
    }
    if (action === SEARCH_OPEN_MARKET_PACK_ACTION) {
      // Same destination as an installed pack: `#packs/<slug>` detail owns
      // install and its grants. One landing, one place the permissions are
      // shown, whether the owner already has it or not.
      const slug = target.getAttribute(SEARCH_PACK_SLUG_ATTR);
      const view = doc.defaultView;
      if (slug !== null && slug.length > 0 && view !== null && view !== undefined) {
        view.location.hash = serializeShellRoute('packs', slug);
      }
      return;
    }
    if (action === SEARCH_RETRY_ACTION) {
      void runUniversalSearch();
      return;
    }
    if (action === SEARCH_DID_YOU_MEAN_ACTION) {
      // Runs the corrected search as if typed: the box takes the new query on
      // the repaint, and the saved view follows it like any other edit.
      const corrected = target.getAttribute(SEARCH_DID_YOU_MEAN_QUERY_ATTR);
      if (corrected !== null && corrected.trim() !== '') {
        retireUniversalSearch();
        universalSearchQuery = corrected;
        opts.onViewChange?.(currentView());
        void runUniversalSearch();
      }
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
    if (action === 'hide-contact-episode') {
      const id = target.getAttribute('data-episode-id');
      if (id !== null) void hideContactEpisode(id);
      return;
    }
    if (action === 'open-contact-detail') {
      const email = target.getAttribute(DATA_ROUTE_CONTACT_EMAIL_ATTR);
      if (email !== null) void openContactDetail(email);
      return;
    }
    if (action === 'load-more-contacts') {
      if (contactLoadMoreQueued || loadingMoreContacts) return;
      // Chain AFTER any in-flight load (a silent live-refresh) rather than
      // racing it: `loadMoreContacts` then computes `offset = contacts.length`
      // off the post-refresh list, not a stale one. `refreshActive` never
      // rejects, so the chain stays resolvable; `whenLoaded()` awaits it too.
      contactLoadMoreQueued = true;
      if (doc.activeElement === target) pendingContactLoadMoreFocus = true;
      pendingLoadPromise = pendingLoadPromise.then(async () => {
        try {
          await loadMoreContacts();
        } finally {
          contactLoadMoreQueued = false;
        }
      });
      return;
    }
    if (action === 'open-form-response') {
      const submissionId = target.getAttribute(DATA_ROUTE_FORM_RESPONSE_ID_ATTR);
      if (submissionId !== null) void openFormResponse(submissionId);
      return;
    }
    if (action === DATA_ROUTE_FORM_RESPONSE_DISCARD_KEEP_ACTION) {
      closeFormResponseDiscardGuard();
      return;
    }
    if (action === DATA_ROUTE_FORM_RESPONSE_DISCARD_COMMIT_ACTION) {
      const pendingTab = formResponseDiscardPendingTab;
      if (pendingTab !== null) {
        retireFormResponseEditorDraft();
        const navigation = selectTab(pendingTab);
        pendingFormResponseDiscardTabFocus = pendingTab;
        focusDataTab(pendingTab);
        void navigation;
        return;
      }
      const pendingHref = formResponseDiscardPendingHref;
      if (pendingHref !== null) {
        retireFormResponseEditorDraft();
        const view = doc.defaultView;
        if (view !== null && view !== undefined) {
          view.location.hash = pendingHref;
        } else {
          render();
          focusFormResponseAutomate();
        }
        return;
      }
      closeFormResponse(true);
      return;
    }
    if (action === 'close-form-response') {
      closeFormResponse();
      return;
    }
    if (action === 'save-form-response') {
      void saveFormResponse();
      return;
    }
    if (action === 'export-form-responses') {
      const format = target.getAttribute('data-format');
      if (format === 'json' || format === 'csv') void exportFormResponses(format);
      return;
    }
    if (action === 'discover-form-response-automations') {
      // The open detail is already the discovery anchor, and the lookup has
      // its own response/sequence guards. Do not queue behind an unrelated
      // silent list refresh that may still be in flight or replace the route's
      // main load promise.
      if (doc.activeElement === target) {
        pendingFormResponseAutomationPickerFocus = true;
      }
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
      if (formResponseLoadMoreQueued || loadingMoreFormResponses) return;
      formResponseLoadMoreQueued = true;
      if (doc.activeElement === target && isReceivedTab(activeTab)) {
        pendingFormResponseLoadMoreFocus = true;
      }
      pendingLoadPromise = pendingLoadPromise.then(async () => {
        try {
          await loadMoreFormResponses();
        } finally {
          formResponseLoadMoreQueued = false;
        }
      });
      return;
    }
    if (action === 'load-more-work-entities') {
      if (workEntityLoadMoreQueued || loadingMoreWorkEntities) return;
      workEntityLoadMoreQueued = true;
      if (doc.activeElement === target && isWorkEntityTab(activeTab)) {
        pendingWorkEntityLoadMoreFocusKind = activeTab;
      }
      pendingLoadPromise = pendingLoadPromise.then(async () => {
        try {
          await loadMoreWorkEntities();
        } finally {
          workEntityLoadMoreQueued = false;
        }
      });
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
    if (action === 'contact-import-dates-select-all' || action === 'contact-import-dates-clear') {
      const file = contactImport?.file;
      if (!contactImport || !file?.plan || contactImportFileApplyPending()) return;
      const available = new Set((file.plan.occasions ?? []).filter(date => !date.unavailable).map(date => date.key));
      const occasions = Object.fromEntries(Object.entries(file.occasions).map(([key, choice]) => [key,
        { ...choice, selected: action === 'contact-import-dates-select-all' && available.has(key) }]));
      contactImport = { ...contactImport, file: { ...file, occasions } };
      render();
      routeRoot.querySelector<HTMLElement>(`[${DATA_ROUTE_ACTION_ATTR}="${action}"]`)?.focus();
      return;
    }
    if (action === 'contact-import-file-toggle-changes') {
      if (contactImport?.file == null || contactImportFileApplyPending()) return;
      contactImport = {
        ...contactImport,
        file: { ...contactImport.file, apply_changes: !contactImport.file.apply_changes },
      };
      render();
      return;
    }
    if (action === 'contact-import-file-clear') {
      if (contactImport === null || contactImportFileApplyPending()) return;
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
      if (contactImportMutationPending()) return;
      // Back to the Source list. Drop the selection with it: a tick made against one
      // CRM's list must never survive into another's, where the same `target_id`
      // would address a different person entirely.
      if (contactImport !== null) {
        contactImportSeq += 1;
        contactImport = initialContactImportState();
      }
      render();
      return;
    }
    if (action === 'contact-import-browse') {
      if (contactImportMutationPending()) return;
      const source_id = target.getAttribute(DATA_ROUTE_IMPORT_SOURCE_ATTR) ?? '';
      if (source_id.length === 0 || contactImport === null) return;
      contactImport = { ...initialContactImportState(), source_id };
      void loadImportCandidates();
      return;
    }
    if (action === 'contact-import-toggle') {
      const target_id = target.getAttribute(DATA_ROUTE_IMPORT_TARGET_ATTR) ?? '';
      if (
        target_id.length === 0
        || contactImport === null
        || contactImport.promoting
      ) return;
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
    if (action === DATA_ROUTE_CONTACT_DISCARD_KEEP_ACTION) {
      closeContactDiscardGuard();
      return;
    }
    if (action === DATA_ROUTE_CONTACT_DISCARD_COMMIT_ACTION) {
      closeContactDialog(true);
      return;
    }
    if (action === 'close-contact-dialog') {
      closeContactDialog();
      return;
    }
    if (action === 'submit-contact-dialog') {
      syncContactDialogFromDom();
      void confirmContactDialog();
      return;
    }
    if (action === 'load-timeline') {
      if (!loadingTimeline && isMirrorTab(activeTab)) {
        void openTimelineDrilldown(activeTab, timelineEntityId);
      }
      return;
    }
    if (action === 'file-cloud-search' || action === 'file-cloud-more') {
      void browseCloudFiles(action === 'file-cloud-more'); return;
    }
    if (action === 'file-cloud-refresh') { if (activeTab === 'files') startRefresh(); return; }
    if (action === 'file-preview') {
      const fileId = explorerDetail?.record_id;
      if (!fileId || activeTab !== 'files' || !opts.filePreviewCallers) return;
      filePreviewAbort?.abort(); const abort = new AbortController(); filePreviewAbort = abort;
      filePreviewRecord = { id: fileId, slug: explorerSelectedSlug };
      void openFilePreview(doc, { record_id: fileId }, opts.filePreviewCallers, abort.signal).finally(() => {
        if (filePreviewAbort === abort) { filePreviewAbort = null; filePreviewRecord = null; }
      }); return;
    }
    if (action === 'file-use-in-chat') {
      const fileId = explorerDetail?.record_id;
      if (!fileId || activeTab !== 'files' || !opts.fileChatCallers || !opts.onUseFileInChat) return;
      fileChatAbort?.abort(); const abort = new AbortController(); fileChatAbort = abort;
      fileChatRecord = { id: fileId, slug: explorerSelectedSlug };
      void openFileChatPicker(doc, fileId, opts.fileChatCallers, abort.signal).then(target => {
        if (target && !disposed && !abort.signal.aborted && activeLens === 'data' && activeTab === 'files' && explorerDetail?.record_id === fileId) opts.onUseFileInChat!(target);
      }).finally(() => {
        if (fileChatAbort === abort) { fileChatAbort = null; fileChatRecord = null; }
      });
      return;
    }
    if (action === 'file-usage') { if (!fileLifecycle?.busy) pendingLoadPromise = loadFileUsage(); return; }
    if (action === 'file-toggle-archived') {
      showArchivedFiles = !showArchivedFiles; fileLifecycle = undefined; fileLifecycleGeneration++;
      pendingLoadPromise = loadExplorer('files').then(() => { if (!disposed) render(); }); return;
    }
    if (action === 'file-delete' || action === 'file-delete-cancel') {
      if (fileLifecycle && !fileLifecycle.busy) { fileLifecycle = { ...fileLifecycle, confirmDelete: action === 'file-delete' }; render();
        routeRoot.querySelector<HTMLElement>('[data-file-lifecycle]')?.focus(); }
      return;
    }
    if (action === 'file-archive' || action === 'file-restore' || action === 'file-delete-confirm') {
      pendingLoadPromise = mutateFile(action === 'file-archive' ? 'archive' : action === 'file-restore' ? 'restore' : 'delete'); return;
    }
    if (action === 'download-file') {
      // Begin synchronously so the state guard owns a second click/Enter before
      // it can queue behind the first request and become a second download.
      if (!downloadingFile) pendingLoadPromise = downloadFile();
      return;
    }
    if (action === 'project-edit') {
      if (projectWork && canEditProject(projectWork.project)) void openEditWorkEntityDialog('project', projectWork.project.id, 'edit');
      return;
    }
    if (action === 'project-work-open' || action === 'project-work-new') {
      const kind = target.getAttribute('data-project-kind');
      if (kind === 'task' || kind === 'note') void openProjectWorkItem(kind, action === 'project-work-new' ? undefined : target.getAttribute('data-project-item-id') ?? undefined);
      return;
    }
    if (action === 'project-work-more' || action === 'project-work-retry') {
      const kind = target.getAttribute('data-project-kind');
      if ((kind === 'task' || kind === 'note') && projectWork && !projectWork.sections[kind].loading) {
        void projectWork.load(kind, action === 'project-work-retry');
      }
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
    if (action === 'open-work-entity-detail') {
      const kind = target.getAttribute('data-kind');
      const id = target.getAttribute('data-entity-id');
      if (kind === 'booking' && id !== null) void openBookingDetail(id);
      return;
    }
    if (action === 'close-booking-detail') {
      closeBookingDetail();
      return;
    }
    if (action === 'edit-booking-detail') {
      const id = target.getAttribute('data-entity-id');
      if (id !== null) void openEditWorkEntityDialog('booking', id);
      return;
    }
    if (action === 'copy-booking-manage-link') {
      void copyBookingManageLink();
      return;
    }
    if (action === WORK_ENTITY_DIALOG_DISCARD_KEEP_ACTION) {
      closeWorkEntityDiscardGuard();
      return;
    }
    if (action === WORK_ENTITY_DIALOG_DISCARD_COMMIT_ACTION) {
      closeWorkEntityDialog(true, noteDiscardToReader, commitmentDiscardToReader);
      return;
    }
    if (action === 'close-work-entity-dialog') {
      closeWorkEntityDialog();
      return;
    }
    if (action === 'return-note-reader') { closeWorkEntityDialog(false, true); return; }
    if (action === 'return-commitment-reader') { closeWorkEntityDialog(false, false, true); return; }
    if (action === 'copy-note-text') { void copyNoteText(); return; }
    if (action === 'edit-commitment') {
      if (workEntityDialogEntity?._kind === 'commitment' && !pendingWorkEntityDialogOpen
        && !workEntityState.dialog?.submitting && canEditCommitment(workEntityDialogEntity)) {
        void openEditWorkEntityDialog('commitment', workEntityDialogEntity.id, 'edit');
      }
      return;
    }
    if (action === 'edit-note' || action === 'edit-note-details') {
      if (workEntityDialogEntity?._kind === 'note' && !pendingWorkEntityDialogOpen) {
        void openEditWorkEntityDialog('note', workEntityDialogEntity.id, action === 'edit-note-details' ? 'details' : 'edit');
      }
      return;
    }
    if (action === 'toggle-note-details') {
      if (workEntityState.kind !== 'note' || !workEntityState.dialog || workEntityState.dialog.submitting || workEntityDiscardGuardOpen) return;
      syncWorkEntityDialogFromDom(); noteDetailsOpen = target.getAttribute('aria-expanded') !== 'true';
      render(); routeRoot.querySelector<HTMLElement>('[data-action="toggle-note-details"]')?.focus(); return;
    }
    if (action === 'close-work-entity-dialog-on-backdrop') {
      if (ev.target === target) {
        closeWorkEntityDialog();
      }
      return;
    }
    if (action === 'reschedule-open') {
      // Prefill the picker with the event's current start (local wall-clock) —
      // or, for an all-day event, its first DAY: its times are days, and a time
      // picked for one was stored as a time (`calendar-days.ts`).
      const record = explorerDetail?.record ?? null;
      const startAt = record != null ? Number(record.hot_fields.start_at) : NaN;
      const allDay = record != null && (record.hot_fields.is_all_day === true || record.hot_fields.is_all_day === 1);
      rescheduleForm = {
        value: !Number.isFinite(startAt)
          ? ''
          : allDay
            ? allDayEventDays({ start_at: startAt, end_at: startAt + DAY_MS }).first
            : toDatetimeLocal(startAt),
        submitting: false,
        error: null,
        allDay,
      };
      render();
      focusRescheduleAction('reschedule-input');
      return;
    }
    if (action === 'reschedule-cancel') {
      if (rescheduleForm?.submitting === true) return;
      rescheduleForm = null;
      render();
      focusRescheduleAction('reschedule-open');
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
    if (action === 'toggle-work-entity-task-details' || action.startsWith('work-entity-task-due-')) {
      const dialog = workEntityState.dialog;
      if (workEntityState.kind !== 'task' || !dialog || dialog.submitting || workEntityDiscardGuardOpen) return;
      syncWorkEntityDialogFromDom();
      if (action === 'work-entity-task-due-pick') {
        const input = routeRoot.querySelector<HTMLInputElement>('[data-form-field="due_at"]');
        input?.focus();
        try { input?.showPicker?.(); } catch { /* Focus still offers native keyboard editing. */ }
        return;
      }
      if (action === 'toggle-work-entity-task-details') {
        taskDetailsOpen = target.getAttribute('aria-expanded') !== 'true';
      } else {
        const shortcut = action.slice('work-entity-task-due-'.length);
        if (shortcut !== 'today' && shortcut !== 'tomorrow' && shortcut !== 'clear') return;
        const value = workEntityState.dialog!.values.due_at;
        const due = timestampValue(value, taskDueShortcutAnchor ?? workEntityDialogOriginal.due_at, true, true);
        try {
          taskDueShortcutAnchor = taskDueShortcutDue(shortcut, due, (opts.now ?? Date.now)());
        } catch (error) {
          workEntityState = setDialogSubmitErrorTransition(workEntityState, errMessage(error));
          render(); focusTaskCompletionError();
          return;
        }
        workEntityState = setDialogValuesTransition(workEntityState, {
          ...workEntityState.dialog!.values, due_at: taskDueShortcutAnchor ?? null,
        });
      }
      render();
      routeRoot.querySelector<HTMLElement>(action === 'work-entity-task-due-clear'
        ? '[data-form-field="due_at"]' : `[data-action="${action}"]`)?.focus();
      return;
    }
    if (action === 'complete-work-entity-task' || action === 'reopen-work-entity-task') {
      pendingLoadPromise = changeTaskCompletion(action === 'complete-work-entity-task');
      return;
    }
    if (action === 'fulfill-work-entity-commitment' || action === 'cancel-work-entity-commitment') {
      pendingLoadPromise = changeCommitmentLifecycle(action === 'fulfill-work-entity-commitment' ? 'fulfill' : 'cancel');
      return;
    }
  };

  const onInput = (ev: Event): void => {
    const target = ev.target as HTMLInputElement | HTMLTextAreaElement | null;
    if (target === null) return;
    if (activeTab === 'calendar' && typeof target.getAttribute === 'function' && calendarAgenda.handleInput(target)) return;
    if (activeTab === 'calendar' && calendarCreateSurface.handleInput(target as HTMLElement)) return;
    if (activeTab === 'calendar' && calendarEventSurface.handleInput(target as HTMLElement)) return;
    // D-315 — the Mail facts editor's text fields keep their draft without a repaint.
    if (activeTab === 'mail_fact' && typeof target.getAttribute === 'function'
      && target.getAttribute(MAIL_FACTS_FIELD_ATTR) !== null
      && mailFacts.handleInput(target as HTMLElement)) return;
    // Reminder wording and time keep their draft without repainting while typing.
    if (activeTab === 'reminder' && typeof target.getAttribute === 'function'
      && target.getAttribute(REMINDERS_FIELD_ATTR) !== null
      && remindersSurface.handleInput(target as HTMLElement)) return;
    if (typeof target.getAttribute === 'function' && target.getAttribute('data-action') === 'records-filter-value'
      && changeRecordsViewDraft(target as HTMLInputElement)) return;
    if (workEntityState.dialog !== null && !workEntityState.dialog.submitting && !workEntityDiscardGuardOpen
      && target.closest?.('.work-entity-dialog-form') != null) {
      if (target.getAttribute('data-form-field') === 'due_at') taskDueShortcutAnchor = undefined;
      // The form renderer owns its inputs. Keep the draft in route state too,
      // so a pending list read cannot repaint those inputs with old values.
      syncWorkEntityDialogFromDom();
      return;
    }
    if (
      typeof target.hasAttribute === 'function'
      && target.hasAttribute(SEARCH_INPUT_ATTR)
    ) {
      if (universalSearchQuery.trim() !== target.value.trim()) {
        retireUniversalSearch();
        universalSearchLoading = target.value.trim() !== '';
      }
      universalSearchQuery = target.value;
      // ⛔ NO `render()` HERE. Repainting on every keystroke replaces the input
      // element the owner is typing into, which drops the caret to the end and
      // makes editing mid-string impossible. The value is already on screen —
      // the DOM has it — so state catches up silently and the debounced search
      // repaints when results arrive.
      scheduleUniversalSearch();
      opts.onViewChange?.(currentView());
      return;
    }
    if (
      typeof target.hasAttribute === 'function'
      && target.hasAttribute(RECORDS_PURGE_CONFIRMATION_ATTR)
      && recordsState.purgePending
      && !recordsState.purging
    ) {
      recordsState = { ...recordsState, purgeConfirmation: target.value };
      return;
    }
    if (
      formResponseEditorDraft !== null
      && formResponseDetailId === formResponseEditorDraft.submissionId
      && typeof target.hasAttribute === 'function'
    ) {
      if (target.hasAttribute(DATA_ROUTE_FORM_RESPONSE_VALUES_ATTR)) {
        formResponseEditorDraft = {
          ...formResponseEditorDraft,
          valuesText: target.value,
        };
        return;
      }
      if (target.hasAttribute(DATA_ROUTE_FORM_RESPONSE_EMAIL_ATTR)) {
        formResponseEditorDraft = {
          ...formResponseEditorDraft,
          email: target.value,
        };
        return;
      }
    }
    if (typeof target.hasAttribute === 'function' && target.hasAttribute(DATA_ROUTE_CONTACT_SEARCH_ATTR)) {
      contactSearch = target.value;
      opts.onViewChange?.(currentView());
      if (activeTab === 'contact') scheduleContactSearchRefresh();
      return;
    }
    // D-205 #5b — the import page's own search. Re-reads the STRANGER list, not the
    // contact list: the two are different questions over different data, and folding
    // them into one box would search your contacts for people who are not in them.
    if (
      typeof target.getAttribute === 'function'
      && target.getAttribute(DATA_ROUTE_ACTION_ATTR) === 'contact-import-search'
      && contactImport !== null
      && !contactImport.promoting
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
      && !rescheduleForm.submitting
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
      if (activeTab === 'task' && action === 'task-bulk-date') { taskBulk.setDate(target.value); return; }
      if (action === 'search-work-entities') {
        if (activeTab === 'task' && taskBulk.busy()) { target.value = workEntityState.search_query; return; }
        if (activeTab === 'task') taskBulk.reset();
        const kind = target.getAttribute('data-kind');
        if (isWorkEntityTab(activeTab) && kind === workEntityState.kind) {
          workEntityState = applySearchTransition(workEntityState, target.value);
          opts.onViewChange?.(currentView());
          if (workEntityState.kind === 'booking') {
            const scheduledSearch = workEntityState.search_query;
            bookingSearchRefresh.schedule(() =>
              activeLens === 'data'
              && activeTab === 'booking'
              && workEntityState.kind === 'booking'
              && workEntityState.search_query === scheduledSearch);
          } else if (workEntityState.kind === 'commitment') {
            loadGeneration += 1; loadingMoreWorkEntities = false;
            const scheduledSearch = workEntityState.search_query;
            commitmentSearchRefresh.schedule(() => activeLens === 'data' && activeTab === 'commitment'
              && workEntityState.kind === 'commitment' && workEntityState.search_query === scheduledSearch);
          } else if (workEntityState.kind === 'task') {
            const scheduledSearch = workEntityState.search_query;
            taskSearchRefresh.schedule(() => activeLens === 'data' && activeTab === 'task'
              && workEntityState.kind === 'task' && workEntityState.search_query === scheduledSearch);
          } else {
            render();
          }
        }
        return;
      }
      const privacyMark = target.getAttribute('data-contact-privacy-mark');
      if (privacyMark && contactDialog && !contactDialog.submitting) {
        const marks = new Set(contactDialog.values.privacy_marks.split(',').map(value => value.trim()).filter(Boolean));
        if ((target as HTMLInputElement).checked) marks.add(privacyMark); else marks.delete(privacyMark);
        contactDialog = { ...contactDialog, values: { ...contactDialog.values, privacy_marks: [...marks].join(', ') } }; return;
      }
      const contactField = target.getAttribute(DATA_ROUTE_CONTACT_FIELD_ATTR) as keyof ContactDialogValues | null;
      if (
        contactDialog !== null
        && !contactDialog.submitting
        && contactField !== null
        && contactField in contactDialog.values
      ) {
        contactDialog = {
          ...contactDialog,
          values: { ...contactDialog.values, [contactField]: target.value },
        };
        return;
      }
      // D-198 Slice 2/3 — keep the compose / import forms synced with their
      // uncontrolled inputs (no render on keystroke, so typing never flickers).
      const memoryField = target.getAttribute(MEMORY_FIELD_ATTR);
      if (
        memoryCompose.open
        && !memoryCompose.submitting
        && !memoryComposeDiscardGuardOpen
        && (memoryField === 'kind' || memoryField === 'summary' || memoryField === 'body')
      ) {
        memoryCompose = { ...memoryCompose, [memoryField]: target.value };
        return;
      }
      if (
        memoryImport.open
        && !memoryImport.submitting
        && !memoryImportDiscardGuardOpen
        && memoryField === 'import'
      ) {
        memoryImport = {
          open: true,
          text: target.value,
          submitting: false,
        };
        return;
      }
      if (target.getAttribute(DATA_ROUTE_ACTION_ATTR) === 'file-cloud-query') {
        cloudFileQueryInput = target.value; return;
      }
      if (target.hasAttribute(DATA_ROUTE_TIMELINE_ENTITY_ATTR)) {
        const changed = timelineEntityId !== target.value;
        timelineEntityId = target.value;
        if (changed && loadingTimeline) {
          timelineLoadGeneration += 1;
          loadingTimeline = false;
          timeline = null;
          const { timeline: _timelineError, ...rest } = errors;
          errors = rest;
          render();
        }
      }
    }
  };

  const onChange = (ev: Event): void => {
    const target = ev.target as HTMLInputElement | HTMLSelectElement | null;
    if (target === null || typeof target.getAttribute !== 'function') return;
    if (activeTab === 'calendar' && calendarAgenda.handleChange(target)) return;
    if (activeTab === 'calendar' && calendarCreateSurface.handleInput(target as HTMLElement, true)) return;
    const importDateKey = target.getAttribute('data-contact-import-date');
    const importDateField = target.getAttribute('data-contact-import-date-field');
    if (importDateKey && importDateField && contactImport?.file && !contactImportFileApplyPending()) {
      const current = contactImport.file.occasions[importDateKey];
      if (!current) return;
      const next = { ...current };
      if (importDateField === 'selected') next.selected = (target as unknown as HTMLInputElement).checked;
      else if (importDateField === 'recurrence' && (target.value === 'once' || target.value === 'yearly')) next.recurrence = target.value;
      else if (importDateField === 'reminder_days') {
        if (target.value === 'none') next.reminder_days = null;
        else if (['0', '1', '7', '30'].includes(target.value)) next.reminder_days = Number(target.value) as 0 | 1 | 7 | 30;
      }
      contactImport = { ...contactImport, file: { ...contactImport.file, occasions: { ...contactImport.file.occasions, [importDateKey]: next } } };
      render();
      [...routeRoot.querySelectorAll<HTMLElement>('[data-contact-import-date]')].find(node => node.getAttribute('data-contact-import-date') === importDateKey && node.getAttribute('data-contact-import-date-field') === importDateField)?.focus();
      return;
    }
    if (target.getAttribute('data-data-sphere') !== null && ['all', 'personal', 'professional', 'unsorted'].includes(target.value)) {
      dataSphere = target.value as typeof dataSphere; facetKey = ''; render(); routeRoot.querySelector<HTMLSelectElement>('[data-data-sphere]')?.focus(); return;
    }
    if (target.getAttribute(DATA_ROUTE_COLLECTION_PICKER_ATTR) !== null) {
      const next = target.value;
      // A protected edit may refuse the switch. Keep the current collection
      // selected until the existing navigation guard accepts it.
      if (isDataTab(next)) void selectTab(next, true);
      if (target.value !== activeTab) target.value = activeTab;
      return;
    }
    if (activeTab === 'mail_fact'
      && (target.getAttribute(MAIL_FACTS_FILTER_ATTR) !== null || target.getAttribute(MAIL_FACTS_FIELD_ATTR) !== null)
      && mailFacts.handleChange(target)) return;
    if (activeTab === 'calendar' && calendarEventSurface.handleInput(target, true)) return;
    if (activeTab === 'reminder' && target.getAttribute(REMINDERS_FIELD_ATTR) !== null
      && remindersSurface.handleChange(target)) return;
    if (changeRecordsViewDraft(target)) return;
    if (workEntityState.dialog !== null && !workEntityState.dialog.submitting && !workEntityDiscardGuardOpen
      && target.closest?.('.work-entity-dialog-form') != null) {
      syncWorkEntityDialogFromDom();
      return;
    }
    if (
      formResponseEditorDraft !== null
      && formResponseDetailId === formResponseEditorDraft.submissionId
      && target.hasAttribute(DATA_ROUTE_FORM_RESPONSE_STATE_ATTR)
    ) {
      formResponseEditorDraft = {
        ...formResponseEditorDraft,
        lifecycle: target.value,
      };
      return;
    }
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
    if (action === 'task-bulk-toggle' && activeTab === 'task') { taskBulk.toggle(target.getAttribute('data-task-id') ?? '', (target as HTMLInputElement).checked); return; }
    if (action === 'task-bulk-date' && activeTab === 'task') { taskBulk.setDate(target.value); return; }
    if (taskBulk.busy()) { render(); focusTaskBatch(); return; }
    if (action === 'select-source') {
      taskBulk.reset();
      const options = sourceOptionsForKind(sources, workEntityState.kind);
      const valid = new Set(options.map((option) => option.id));
      workEntityState = selectSourceTransition(workEntityState, target.value, valid);
      bookingSearchRefresh.cancel();
      taskSearchRefresh.cancel();
      commitmentSearchRefresh.cancel();
      startRefresh();
      return;
    }
    if (action === 'filter-booking-lifecycle' && activeTab === 'booking') {
      const next = target.value;
      if (next === 'all' || BOOKING_LIFECYCLE_STATES.includes(next as BookingLifecycleState)) {
        bookingLifecycleFilter = next as BookingLifecycleState | 'all';
        bookingSearchRefresh.cancel();
        pendingLoadPromise = refreshActive(true);
      }
      return;
    }
    if (activeTab === 'commitment' && action?.startsWith('filter-commitment-')) {
      const field = action.slice('filter-commitment-'.length);
      if (field !== 'direction' && field !== 'status') return;
      const next = parseCommitmentViewFilters({ ...commitmentViewFilters, [field]: target.value });
      if (next) { commitmentViewFilters = next; commitmentSearchRefresh.cancel(); startRefresh(); }
      return;
    }
    if (activeTab === 'task' && action?.startsWith('filter-task-')) {
      taskBulk.reset();
      const field = action.slice('filter-task-'.length);
      if (field !== 'completion' && field !== 'due' && field !== 'sort') return;
      const next = parseTaskViewFilters({ ...taskViewFilters, [field]: target.value });
      if (next !== null) {
        taskViewFilters = next;
        taskSearchRefresh.cancel();
        startRefresh();
      }
      return;
    }
    if (action === 'select-create-source') {
      workEntityState = setDialogSourceTransition(workEntityState, target.value);
      render();
    }
  };

  const onKeyDown = (ev: KeyboardEvent): void => {
    if (ev.key === 'Enter' && targetWithAttr(ev, DATA_ROUTE_ACTION_ATTR)?.getAttribute(DATA_ROUTE_ACTION_ATTR) === 'file-cloud-query') {
      ev.preventDefault(); void browseCloudFiles(false); return;
    }
    const collectionTab = targetWithAttr(ev, DATA_ROUTE_TAB_ATTR);
    if (
      collectionTab !== null
      && collectionTab.getAttribute('aria-disabled') !== 'true'
    ) {
      const currentTab = collectionTab.getAttribute(DATA_ROUTE_TAB_ID_ATTR);
      if (currentTab !== null && isDataTab(currentTab)) {
        const tabs = Array.from(routeRoot.querySelectorAll<HTMLElement>(
          `[${DATA_ROUTE_TAB_ATTR}]`,
        )).filter((tab) => tab.getAttribute('aria-disabled') !== 'true');
        const currentIndex = tabs.indexOf(collectionTab);
        let nextIndex: number | null = null;
        if (ev.key === 'ArrowRight') {
          nextIndex = (currentIndex + 1) % tabs.length;
        } else if (ev.key === 'ArrowLeft') {
          nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
        } else if (ev.key === 'Home') {
          nextIndex = 0;
        } else if (ev.key === 'End') {
          nextIndex = tabs.length - 1;
        }
        if (currentIndex >= 0 && nextIndex !== null) {
          const nextTab = tabs[nextIndex]?.getAttribute(DATA_ROUTE_TAB_ID_ATTR);
          if (nextTab !== null && nextTab !== undefined && isDataTab(nextTab)) {
            ev.preventDefault();
            void selectTab(nextTab, true);
            return;
          }
        }
      }
    }
    const recordsKindTab = targetWithAttr(ev, RECORDS_KIND_ATTR);
    if (
      activeLens === 'data'
      && activeTab === 'records'
      && recordsKindTab?.getAttribute(SHARED_ACTION_ATTR)
        === RECORDS_SELECT_KIND_ACTION
      && recordsKindTab.getAttribute('aria-disabled') !== 'true'
    ) {
      const tabs = Array.from(routeRoot.querySelectorAll<HTMLElement>(
        `[${SHARED_ACTION_ATTR}="${RECORDS_SELECT_KIND_ACTION}"]`,
      )).filter((tab) => tab.getAttribute('aria-disabled') !== 'true');
      const currentIndex = tabs.indexOf(recordsKindTab);
      let nextIndex: number | null = null;
      if (ev.key === 'ArrowRight') {
        nextIndex = (currentIndex + 1) % tabs.length;
      } else if (ev.key === 'ArrowLeft') {
        nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
      } else if (ev.key === 'Home') {
        nextIndex = 0;
      } else if (ev.key === 'End') {
        nextIndex = tabs.length - 1;
      }
      if (currentIndex >= 0 && nextIndex !== null) {
        const nextTab = tabs[nextIndex];
        const nextKind = nextTab?.getAttribute(RECORDS_KIND_ATTR);
        if (nextTab !== undefined && nextKind !== null && nextKind !== undefined) {
          ev.preventDefault();
          nextTab.focus({ preventScroll: true });
          void selectRecordsKind(nextKind);
          return;
        }
      }
    }
    if (ev.key === 'Escape' && !ev.isComposing && activeLens === 'data' && activeTab === 'calendar' && calendarCreateSurface.isOpen()) {
      ev.preventDefault(); ev.stopPropagation(); calendarCreateSurface.handleAction('calendar-create-cancel'); return;
    }
    if (activeLens === 'data' && activeTab === 'calendar' && calendarEventSurface.guardKeyDown(ev, routeRoot)) return;
    if (ev.key === 'Escape' && !ev.isComposing && activeLens === 'data' && activeTab === 'calendar' && calendarEventSurface.escape()) {
      ev.preventDefault(); ev.stopPropagation(); return;
    }
    if (
      !memoryImportDiscardGuardOpen
      && !memoryComposeDiscardGuardOpen
      && !formResponseDiscardGuardOpen
      && contactDialog === null
      && workEntityState.dialog === null
    ) return;
    if (ev.key === 'Escape' && ev.isComposing) return;
    const queryable = routeRoot as unknown as {
      querySelector?: (selector: string) => HTMLElement | null;
    };
    const overlay = memoryImportDiscardGuardOpen
      ? queryable.querySelector?.(
          `[${MEMORY_IMPORT_DISCARD_GUARD_ATTR}]`,
        ) ?? null
      : memoryComposeDiscardGuardOpen
      ? queryable.querySelector?.(
          `[${MEMORY_COMPOSE_DISCARD_GUARD_ATTR}]`,
        ) ?? null
      : formResponseDiscardGuardOpen
      ? queryable.querySelector?.(
          `[${DATA_ROUTE_FORM_RESPONSE_DISCARD_GUARD_ATTR}]`,
        ) ?? null
      : contactDiscardGuardOpen
      ? queryable.querySelector?.(
          `[${DATA_ROUTE_CONTACT_DISCARD_GUARD_ATTR}]`,
        ) ?? null
      : workEntityDiscardGuardOpen
      ? queryable.querySelector?.(
          `[${WORK_ENTITY_DIALOG_DISCARD_GUARD_ATTR}]`,
        ) ?? null
      : contactDialog !== null
        ? queryable.querySelector?.(`[${DATA_ROUTE_CONTACT_DIALOG_ATTR}]`) ?? null
        : queryable.querySelector?.('.work-entity-dialog') ?? null;
    if (overlay === null) return;
    if (ev.key === 'Escape') {
      ev.preventDefault();
      ev.stopPropagation();
      if (memoryImportDiscardGuardOpen) {
        closeMemoryImportDiscardGuard();
      } else if (memoryComposeDiscardGuardOpen) {
        closeMemoryComposeDiscardGuard();
      } else if (formResponseDiscardGuardOpen) {
        closeFormResponseDiscardGuard();
      } else if (contactDiscardGuardOpen) {
        closeContactDiscardGuard();
      } else if (workEntityDiscardGuardOpen) {
        closeWorkEntityDiscardGuard();
      } else if (contactDialog !== null) {
        closeContactDialog();
      } else {
        closeWorkEntityDialog(false, workEntityState.kind === 'note' && noteMode === 'edit' && workEntityState.dialog?.mode === 'edit');
      }
      return;
    }
    if (ev.key !== 'Tab') return;
    const focusable = Array.from(overlay.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), '
      + 'textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
    )).filter(
      (candidate) =>
        !candidate.hasAttribute('hidden')
        && candidate.getAttribute('aria-hidden') !== 'true',
    );
    const first = focusable[0];
    const last = focusable.at(-1);
    if (first === undefined || last === undefined) {
      ev.preventDefault();
      return;
    }
    const activeElement = doc.activeElement;
    if (activeElement === overlay) {
      ev.preventDefault();
      (ev.shiftKey ? last : first).focus({ preventScroll: true });
      return;
    }
    if (ev.shiftKey && (activeElement === first || !overlay.contains(activeElement))) {
      ev.preventDefault();
      last.focus({ preventScroll: true });
    } else if (!ev.shiftKey && (activeElement === last || !overlay.contains(activeElement))) {
      ev.preventDefault();
      first.focus({ preventScroll: true });
    }
  };

  routeRoot.addEventListener('click', onClick);
  routeRoot.addEventListener('input', onInput);
  const onRecordsViewSubmit = (event: Event): void => {
    if (!(event.target as HTMLElement | null)?.hasAttribute?.('data-records-view-form')) return;
    event.preventDefault();
    applyRecordsView();
  };
  routeRoot.addEventListener('submit', onRecordsViewSubmit);
  routeRoot.addEventListener('submit', calendarCreateSurface.handleSubmit);
  routeRoot.addEventListener('change', onChange);
  routeRoot.addEventListener('keydown', onKeyDown);

  const isCollectionNavigation = (target: EventTarget | null): boolean => {
    const element = target as HTMLElement | null;
    return element?.hasAttribute?.(DATA_ROUTE_TAB_ATTR) === true
      || element?.hasAttribute?.(DATA_ROUTE_COLLECTION_PICKER_ATTR) === true;
  };
  let collectionNavigationHasFocus = false;
  const onCollectionFocusIn = (event: FocusEvent): void => {
    collectionNavigationHasFocus = isCollectionNavigation(event.target);
  };
  const onCollectionFocusOut = (event: FocusEvent): void => {
    if (!isCollectionNavigation(event.target)) return;
    const element = event.target as HTMLElement;
    // Browsers can blur the now-hidden control before the media-query event.
    // Retain ownership only for that transition, not for an ordinary blur.
    const hiddenByBreakpoint = collectionPickerBreakpoint?.matches
      ? element.hasAttribute(DATA_ROUTE_TAB_ATTR)
      : element.hasAttribute(DATA_ROUTE_COLLECTION_PICKER_ATTR);
    if (!hiddenByBreakpoint || event.relatedTarget !== null) collectionNavigationHasFocus = false;
  };
  const onCollectionBreakpointChange = (): void => {
    if (disposed || activeLens !== 'data' || !collectionNavigationHasFocus) return;
    const focused = doc.activeElement;
    if (focused !== null && focused !== doc.body && !isCollectionNavigation(focused)) return;
    collectionNavigationTarget(activeTab)?.focus({ preventScroll: true });
  };
  doc.addEventListener('focusin', onCollectionFocusIn);
  doc.addEventListener('focusout', onCollectionFocusOut);
  collectionPickerBreakpoint?.addEventListener?.('change', onCollectionBreakpointChange);

  startRefresh();
  // Bind the queued open to the route the user actually requested. Ordinary
  // same-tab refreshes may finish first, but a tab/lens navigation retires the
  // old address instead of applying its record id to the new surface.
  const initialDeepLinkNavigationGeneration = navigationGeneration;
  const initialDeepLinkTab = activeTab;
  const initialDeepLinkLens = activeLens;

  // R18 — deep-link hydration: after the initial tab's load settles, open the
  // addressed entity's timeline detail. Contact + mirror tabs have a timeline
  // view; work-entity tabs hydrate the tab only (detail = modal edit, not a
  // timeline yet). Chained onto `pendingLoadPromise` so `whenLoaded()` awaits it.
  const initialEntityId = opts.initialEntityId;
  if (initialEntityId !== undefined && initialEntityId.length > 0) {
    pendingLoadPromise = pendingLoadPromise.then(() => {
      if (
        disposed
        || navigationGeneration !== initialDeepLinkNavigationGeneration
        || activeTab !== initialDeepLinkTab
        || activeLens !== initialDeepLinkLens
      ) return undefined;
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
        return activeTab === 'booking'
          ? openBookingDetail(initialEntityId)
          : openEditWorkEntityDialog(activeTab, initialEntityId);
      }
      syncDataHash();
      return undefined;
    });
  }
  if (pendingInitialVerificationFocus) {
    pendingLoadPromise = pendingLoadPromise.then(() => {
      if (!disposed) focusInitialVerificationTarget();
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
    // A late upload/warehouse notification must not dismiss a record the
    // owner just opened, or erase the selection captured by the Run palette.
    if (activeLens === 'data' && (isExplorerTab(activeTab) || isSingleCollectionTab(activeTab))
      && explorerDetail !== null) {
      explorerLiveRefreshPending = true;
      return;
    }
    // Import publishes a warehouse event before its receipt reaches this UI.
    // Keep that event (and unrelated writes) from retiring the active handoff.
    // A remote page walk or search also stays stable until an explicit refresh.
    if (activeLens === 'data' && activeTab === 'files'
      && (filePreviewRecord !== null || fileChatRecord !== null || (explorerSelectedSlug !== null && cloudFileSourceId(explorerSelectedSlug)
        && (explorerLoading || cloudLoadingMore || cloudFilePage > 1 || cloudFileQuery.length > 0
          || (doc.activeElement as HTMLElement | null)?.getAttribute?.(DATA_ROUTE_ACTION_ATTR) === 'file-cloud-query')))) return;
    // Broadcasts must not replace a page walk or an editor the owner is using.
    // Refresh results explicitly starts a fresh read; idle first pages stay live.
    // D-315 — the same for Mail facts: a later page, or a load under way.
    if (activeLens === 'data' && activeTab === 'task' && taskBulk.holdsList()) return;
    if (activeLens === 'data' && activeTab === 'mail_fact' && mailFacts.isBusy()) return;
    // D-324 — nor a time being changed or a cancel waiting for its answer.
    if (activeLens === 'data' && activeTab === 'reminder' && remindersSurface.isBusy()) return;
    if (activeLens === 'data' && activeTab === 'project' && projectWork
      && Object.values(projectWork.sections).some(section => section.loading)) return;
    if (activeLens === 'data' && activeTab === 'records'
      && (recordsState.loading || recordsState.page > 1 || recordsViewHasDraft(recordsState)
        || recordsState.detail !== null || recordsState.purgePending || recordsState.outboxOpen
        || hasRecordsInFlightWork()
        || (doc.activeElement as HTMLElement | null)?.closest?.('.records-view-controls, .records-pagination') != null)) return;
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
      // D-324 — a reminder rang: the list moves it to the ones rung. A reminder
      // writes no warehouse event, so this notification is the only signal.
      opts.subscribe('notification.notify', (event) => {
        if (activeLens === 'data' && activeTab === 'reminder' && event.link_url === REMINDER_LIST_LINK) {
          scheduleLiveRefresh();
        }
      }),
      // D-315 §6 — facts written or removed (a scan, a backfill and an unpaired
      // fact write no thing event, so `warehouse` alone misses them), or a
      // template changed. Only the Mail facts tab re-reads for it.
      opts.subscribe('mail_fact', () => {
        // The open email's facts may have changed (a template or a backfill
        // read it): its actions are read again.
        if (mailFactEmailStatus !== null) {
          mailFactEmailStatus = { ...mailFactEmailStatus, stale: true };
          if (activeLens === 'data' && activeTab !== 'mail_fact') render();
        }
        if (activeLens === 'data' && activeTab === 'mail_fact') scheduleLiveRefresh();
      }),
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
          const carryFocus =
            !contactScan.scanning
            && (doc.activeElement as HTMLElement | null | undefined)
              ?.getAttribute?.(DATA_ROUTE_ACTION_ATTR) === 'run-merge-scan';
          contactScan = {
            ...contactScan,
            loading: true,
            progress: null,
            last_scan: {
              iterated: event.iterated,
              surfaced_count: event.surfaced_count ?? progress.surfaced,
            },
          };
          render();
          if (carryFocus) focusContactScanOwner('result');
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

  const hasDataInFlightWork = (): boolean => taskBulk.busy() || opaqueMutationsInFlight > 0
    || workEntityState.dialog?.submitting === true
    || contactDialog?.submitting === true
    || savingFormResponse
    || exportingFormResponseFormat !== null
    || bookingManageLinkBusy
    || memoryCompose.submitting
    || memoryImport.submitting
    || memoryEditOpeningId !== null
    || memoryFilteringOrigin !== null
    || memoryExporting
    || rescheduleForm?.submitting === true
    || contactScan?.scanning === true
    || contactScan?.dialog.saving === true
    || contactImport?.promoting === true
    || contactImport?.file?.busy === true
    || hasRecordsInFlightWork()
    || formResponseRunModal?.getState().executing === true
    || formResponseRunModal?.getState().mutating === true
    || formResponseRunModal?.getState().trigger_mutating === true
    // D-315 — a template, a kind of email or a switch saving.
    || mailFacts.hasInFlightWork()
    // D-324 — a reminder being moved or cancelled.
    || remindersSurface.hasInFlightWork()
    || calendarEventSurface.hasInFlightWork()
    || calendarCreateSurface.hasInFlightWork()
    || mailMessageSurface.hasInFlightWork();

  return {
    currentView,
    getRunPageContext: () => {
      if (disposed || activeLens !== 'data') return null;
      let selected: ReturnType<typeof runPageObject> | null = null;
      if (activeTab === 'records') {
        const { detail, selectedNamespace, selectedKind } = recordsState;
        if (!recordsState.loading && recordsState.error === undefined
          && detail && selectedNamespace && selectedKind) {
          selected = runPageObject(selectedKind, detail.id, detail, selectedNamespace.owner);
        }
      } else if (activeTab === 'contact' && contactDetail?.contact && !loadingContactDetail) {
        const contact = contactDetail.contact;
        selected = runPageObject('contact', contact.contact_id || contact._id || contact.email, { ...contact });
      } else if (isReceivedTab(activeTab) && formResponseDetail && formResponseDetailId
        && formResponseDetailError === null) {
        selected = runPageObject('form_response', formResponseDetailId, { ...formResponseDetail });
      } else if (activeTab === 'booking' && bookingDetailId && bookingDetail?.entity) {
        selected = runPageObject('booking', bookingDetailId, { ...bookingDetail.entity });
      } else if ((isExplorerTab(activeTab) || isSingleCollectionTab(activeTab))
        && !explorerLoading && !explorerError && !explorerDetail?.loading
        && !explorerDetail?.error && explorerDetail && explorerCollection) {
        const detail = explorerDetail;
        const loaded = detail.record ?? (isSingleCollectionTab(activeTab)
          ? explorerRecords.find(row => row.record_id === detail.record_id) : undefined);
        if (loaded) selected = runPageObject(explorerCollection, loaded.record_id, {
          ...loaded.hot_fields, ...loaded,
          ...(explorerSelectedSlug === null ? {} : { collection_slug: explorerSelectedSlug }),
        });
      }
      return selected ? { label: selected.label, objects: [selected] } : null;
    },
    bindSavedView: (view) => { savedViewBinding = view; savedViewLinked = true; syncDataHash(); },
    detachSavedView: () => { savedViewLinked = false; syncDataHash(); },
    getRecoveryContextFreshness: () => {
      const unavailable = activeLens === 'memory'
        ? memoryLoading || memoryError !== undefined
        : loading || Object.values(errors).some(Boolean)
          || (activeTab === 'records' && (recordsState.loading || recordsState.error !== undefined))
          || (activeTab === 'search' && (universalSearchLoading || universalSearchError !== undefined))
          || ((isExplorerTab(activeTab) || isSingleCollectionTab(activeTab)) && (explorerLoading || explorerError !== undefined));
      return disposed || unavailable ? 'unavailable' : 'current';
    },
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
    hasInFlightWork: hasDataInFlightWork,
    hasUnsavedChanges: () => mailMessageSurface.hasUnsavedChanges() || calendarEventSurface.hasUnsavedChanges() || calendarCreateSurface.hasUnsavedChanges() || recordsImport.hasUnsavedChanges() || mailFacts.hasUnsavedChanges() || remindersSurface.hasUnsavedChanges(),
    unsavedChangesPrompt: () => (mailMessageSurface.hasUnsavedChanges()
      ? 'Leave Data? Your email draft is not saved.' : calendarCreateSurface.hasUnsavedChanges()
      ? 'Leave Data? Your new event is not saved.' : calendarEventSurface.hasUnsavedChanges()
      ? 'Leave Data? Your event changes are not saved.' : recordsImport.hasUnsavedChanges()
      ? 'Leave Data? Your spreadsheet import is still open.' : mailFacts.hasUnsavedChanges()
      ? 'Leave Data? Your changes to a mail-fact template or kind of email are not saved.'
      : remindersSurface.hasUnsavedChanges()
        ? 'Leave Data? Your reminder changes are not saved.'
        : null),
    inFlightWorkPrompt: () => hasRecordsInFlightWork()
      ? 'Something is still happening in Records. Leave Data anyway?'
      : hasDataInFlightWork()
        ? 'Something is still happening. Leave Data anyway?'
        : null,
    refresh: startRefresh,
    whenLoaded: async () => {
      await taskBulk.whenSettled();
      await pendingLoadPromise;
      if (activeTab === 'search') await assetSearch.whenLoaded();
      if (activeTab === 'calendar' && explorerDetail === null) await calendarAgenda.whenLoaded();
      if (activeTab === 'reminder') await remindersSurface.whenLoaded();
    },
    navigateDeepLink: (hash) => {
      if (!disposed && activeLens === 'data' && activeTab === 'calendar' && explorerDetail !== null
        && calendarAgendaReturn?.hash === hash && !hasDataInFlightWork() && !calendarEventSurface.hasUnsavedChanges()) {
        closeExplorerDetail(true);
        return true;
      }
      if (disposed || activeLens !== 'data' || activeTab !== 'contact' || !contactSearchReturn
        || hash !== contactSearchReturn.hash || contactDialog !== null || openingContactEditEmail !== null
        || hasDataInFlightWork()) return false;
      returnToContactSearch(true);
      return true;
    },
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
    saveFormResponse,
    exportFormResponses,
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
      if (contactImport === null || contactImportMutationPending()) return;
      contactImport = { ...initialContactImportState(), source_id };
      await loadImportCandidates();
    },
    toggleImportTarget: (target_id: string): void => {
      if (contactImport === null || contactImport.promoting) return;
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
      if (contactImport?.file == null || contactImportFileApplyPending()) return;
      contactImport = { ...contactImport, file: { ...contactImport.file, apply_changes: on } };
      render();
    },
    contactImport: () => contactImport,
    dispose: () => {
      sphereControl?.dispose();
      if (disposed) return;
      if (activeTab === 'search') {
        const saved = readSearchAssetReturn<SearchResume>(doc, searchContinuityOwner);
        if (saved) saveSearchAssetReturn(doc, searchContinuityOwner, { ...saved, state: captureSearchState() });
      }
      disposed = true;
      retireUniversalSearch();
      assetSearch.dispose();
      remindersSurface.dispose();
      taskBulk.dispose();
      calendarAgenda.dispose();
      calendarCreateSurface.dispose();
      calendarEventSurface.dispose();
      mailMessageSurface.dispose();
      projectWork?.dispose();
      fileChatAbort?.abort(); filePreviewAbort?.abort(); fileDownloadAbort?.abort();
      contactSearchRefresh.cancel();
      bookingSearchRefresh.cancel();
      taskSearchRefresh.cancel();
      commitmentSearchRefresh.cancel();
      if (liveRefreshTimer !== null) {
        clearTimeout(liveRefreshTimer);
        liveRefreshTimer = null;
      }
      for (const off of liveUnsubscribers.splice(0)) off();
      closeFormResponseRunModal();
      recordsImport.destroy();
      disposeWorkEntityRefPickers();
      disposeUploadWidget();
      routeRoot.removeEventListener('click', onClick);
      routeRoot.removeEventListener('input', onInput);
      routeRoot.removeEventListener('change', onChange);
      routeRoot.removeEventListener('submit', onRecordsViewSubmit);
      routeRoot.removeEventListener('keydown', onKeyDown);
      routeRoot.removeEventListener('submit', calendarCreateSurface.handleSubmit);
      doc.removeEventListener('focusin', onCollectionFocusIn);
      doc.removeEventListener('focusout', onCollectionFocusOut);
      collectionPickerBreakpoint?.removeEventListener?.('change', onCollectionBreakpointChange);
      try {
        opts.root.removeChild(routeRoot);
      } catch {
        routeRoot.remove();
      }
    },
  };
};
