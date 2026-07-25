/** D-145 PA6 — work-entity page substrate barrel.
 *
 *  Pairs with `@recued/contracts/work-entity-page` (types + state
 *  machine + filtering). Spec: docs/d-145-spec.md § Phase PA6. */

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
export { WORK_ENTITY_PAGE_STYLES } from './styles.js';
