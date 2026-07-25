/** D-145 PA6 — work-entity page substrate, contracts barrel.
 *
 *  Pairs with `@recued/ui-shared/work-entity-page` (HTML rendering +
 *  DOM read-back). Spec: D-145 § Phase PA6.
 */

export {
  COMMITMENT_LIFECYCLE_LIST_ORDER,
  PROJECT_STATE_LIST_ORDER,
  SOURCE_DROPDOWN_ALL_VALUE,
  type SourceDropdownOption,
  type WorkEntityIconName,
  type WorkEntityListRow,
  type WorkEntityListSortDirection,
  type WorkEntityListSortSpec,
  type WorkEntityListViewProps,
  type WorkEntityNavSpec,
  type WorkEntityPageDialogState,
  type WorkEntityPageDialogStateCreate,
  type WorkEntityPageDialogStateEdit,
  type WorkEntityPageState,
} from './types.js';

export {
  WORK_ENTITY_NAV,
  WORK_ENTITY_NAV_ORDER,
  workEntityNavSpec,
  workEntityNavSpecsInOrder,
} from './nav-registry.js';

export {
  SOURCE_DROPDOWN_ALL_LABEL,
  buildSourceDropdownOptions,
  dropdownIdToSelectedSourceId,
  resolveCreateDialogSourceId,
  selectedSourceIdToDropdownId,
} from './source-dropdown.js';

export {
  filterAndSortEntities,
  filterEntitiesBySearch,
  sortEntitiesByDefault,
} from './list-view.js';

export {
  applySearchTransition,
  closeDialogTransition,
  entityToFormValues,
  initialWorkEntityPageState,
  openCreateDialogTransition,
  openEditDialogTransition,
  selectKindTransition,
  selectSourceTransition,
  setDialogErrorsTransition,
  setDialogSourceTransition,
  setDialogSubmitErrorTransition,
  setDialogSubmittingTransition,
  setDialogValuesTransition,
  type WorkEntityPageStateInit,
} from './state.js';
