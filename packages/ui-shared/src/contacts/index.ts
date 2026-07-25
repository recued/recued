/** D-138 Phase 2 — `@recued/ui-shared/contacts` barrel.
 *
 *  Houses the contact-merge review surfaces shared across extension /
 *  webapp / options page. All renderers are pure HTML; the host wires
 *  data-action clicks to `contact.merge.{list, confirm, reject,
 *  split, undo_rejection, resolve_remerge_prompt}` rpcs and patches
 *  the state back through. */

export {
  renderMergeReviewDialog,
  initialMergeReviewDialogState,
  MERGE_REVIEW_FIELDS,
  MERGE_REVIEW_DIALOG_STYLES,
  type MergeReviewContactCard,
  type MergeReviewItem,
  type MergeReviewDialogState,
  type MergeReviewDialogProps,
} from './merge-review-dialog.js';

export {
  renderEnrollmentFocusPage,
  initialEnrollmentFocusPageState,
  isEtaEligible,
  remainingMillis,
  formatRemaining,
  DEFAULT_ETA_CONFIG,
  ENROLLMENT_FOCUS_PAGE_STYLES,
  type EnrollmentFocusStage,
  type SyncProgress,
  type ScanProgress,
  type EtaConfig,
  type EnrollmentFocusPageState,
  type EnrollmentFocusPageProps,
} from './enrollment-focus-page.js';

export {
  renderContactsSettingsSection,
  initialContactsSettingsSectionState,
  CONTACTS_SETTINGS_SECTION_STYLES,
  type ContactsSettingsSectionState,
} from './contacts-settings-section.js';

// D-138 P5 — upstream-merge UI surfaces (vendor preview dialog +
// failure banner).
export {
  renderVendorMergePreviewDialog,
  VENDOR_MERGE_DIALOG_ACTIONS,
  type VendorMergePreviewState,
  type VendorMergeDialogAction,
} from './vendor-merge-preview-dialog.js';

export {
  renderUpstreamMergeFailureBanner,
  type UpstreamMergeFailureBannerState,
} from './upstream-merge-failure-banner.js';
