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
  type WorkEntityDialogProps,
} from './dialog.js';
export {
  renderWorkEntityPage,
  type WorkEntityPageProps,
} from './page.js';
export {
  renderBookingDetail,
  type BookingDetailProps,
} from './booking-detail.js';
export { WORK_ENTITY_PAGE_STYLES } from './styles.js';
