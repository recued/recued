/** Shared name→id reference-picker (combobox) — barrel.
 *
 *  ONE inventory-agnostic primitive that replaces the raw-id text inputs
 *  across the webclient (recipe filters, `data.*` ref fields, reception
 *  destinations, approval ids). See `types.ts` for the layering.
 */

export type {
  RefPickerOption,
  RefPickerSelection,
  RefPickerSearchCaller,
  RefPickerState,
  RefPickerRenderConfig,
  WireRefPickerOptions,
  RefPickerHandle,
} from './types.js';

export {
  initialRefPickerState,
  setQuery,
  setResults,
  setLoading,
  setError,
  openList,
  closeList,
  revertQuery,
  moveActive,
  commitOption,
  clearSelection,
  activeOption,
  enterTarget,
  filterRefOptions,
} from './model.js';

export {
  renderRefPicker,
  renderRefPickerResults,
  renderRefPickerResultRows,
  refPickerShellAttr,
  refPickerOptionDomId,
  REF_PICKER_INPUT_ATTR,
  REF_PICKER_RESULTS_ATTR,
  REF_PICKER_CLEAR_ATTR,
  REF_PICKER_OPTION_INDEX_ATTR,
  REF_PICKER_VALUE_ATTR,
} from './render.js';

export { wireRefPicker } from './wire.js';

export { REF_PICKER_STYLES } from './styles.js';
