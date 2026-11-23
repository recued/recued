/** D-145 PA6 — work-entity page substrate barrel.
 *
 *  Pairs with `@recued/contracts/work-entity-page` (types + state
 *  machine + filtering). Spec: D-145 § Phase PA6. */

export {
  renderSourceAffordanceChips,
  renderSourceDropdown,
  type SourceDropdownProps,
} from './source-dropdown.js';
export {
  projectRowText,
  renderWorkEntityListView,
} from './list-view.js';
export {
  renderWorkEntityDialog,
  WORK_ENTITY_DIALOG_DISCARD_GUARD_ATTR,
  WORK_ENTITY_DIALOG_DISCARD_KEEP_ATTR,
  WORK_ENTITY_DIALOG_DISCARD_COMMIT_ATTR,
  WORK_ENTITY_DIALOG_DISCARD_KEEP_ACTION,
  WORK_ENTITY_DIALOG_DISCARD_COMMIT_ACTION,
  type WorkEntityDialogProps,
} from './dialog.js';
export {
  renderWorkEntityPage,
  renderWorkEntityPageHeader,
  type WorkEntityPageProps,
  type TaskListLayout,
} from './page.js';
export {
  renderBookingDetail, bookingTimeLabel, bookingReaderWarning,
  type BookingDetailProps,
} from './booking-detail.js';
export { WORK_ENTITY_PAGE_STYLES } from './styles.js';
export { commitmentCounterpartyLabel, commitmentDeadlineLabel, commitmentDirectionLabel, commitmentReaderWarning, commitmentStatusLabel, type WorkEntityCommitmentView } from './commitment-reader.js';
export { renderProjectOverview, PROJECT_OVERVIEW_STYLES, type ProjectOverviewProps, type ProjectWorkSection } from './project-overview.js';
export { renderProjectLinkReview, type ProjectLinkReviewProps } from './project-link-review.js';
export type { NoteRelatedRecordView } from './note-reader.js';
export { renderTaskReader, taskDeadlineLabel, taskReaderWarning, type WorkEntityTaskView } from './task-reader.js';
export type { WorkReaderCopyView } from './reader-copy.js';

export { renderProjectCommunication, type ProjectCommunicationView } from './project-communication.js';
export { renderProjectAttention, projectAttentionIssueText, PROJECT_ATTENTION_LABELS, PROJECT_ATTENTION_STYLES, type ProjectAttentionView } from './project-attention.js';
