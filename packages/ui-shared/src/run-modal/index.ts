/** Shared Run | Schedule modal — barrel.
 *
 *  ONE modal for launching an installed recipe (Run tab + Schedule tab),
 *  reused by the recipes library page and the chat-composer "Run a recipe"
 *  command-palette (webclient IA §D.L1). See `types.ts` for the layering.
 */

export type {
  RunModalTab,
  RunModalState,
  RunModalHandle,
  WireRunModalOptions,
  RunModalExecuteCaller,
  RunModalSchedulesListCaller,
  RunModalSchedulesCreateCaller,
  RunModalSchedulesUpdateCaller,
  RunModalSchedulesDeleteCaller,
  RunModalTriggersListCaller,
  RunModalTriggersCreateCaller,
  RunModalTriggersUpdateCaller,
  RunModalTriggersDeleteCaller,
} from './types.js';

export {
  initialRunModalState,
  parseRunConfig,
  runTargetGate,
  recipeSchedules,
  recipeTriggers,
  recipeDisplayName,
  plural,
} from './model.js';

export {
  renderRunModal,
  RUN_MODAL_OVERLAY_ATTR,
  RUN_MODAL_ACTION_ATTR,
  RUN_MODAL_TAB_ATTR,
  RUN_MODAL_CONFIG_ATTR,
  RUN_MODAL_TARGET_ATTR,
  RUN_MODAL_TARGET_WARNING_ATTR,
  RUN_MODAL_CONTEXT_ATTR,
  RUN_MODAL_IDENTITY_ATTR,
  RUN_MODAL_RESULT_ATTR,
  RUN_MODAL_FACTS_ATTR,
  RUN_MODAL_REASON_ATTR,
  RUN_MODAL_PRESET_ATTR,
  RUN_MODAL_RULE_ID_ATTR,
  RUN_MODAL_SCHEDULE_ERROR_ATTR,
  RUN_MODAL_MISSED_POLICY_ATTR,
  RUN_MODAL_NEW_MISSED_POLICY_ATTR,
  missedPolicySelectId,
  RUN_MODAL_PATTERN_ATTR,
  RUN_MODAL_TRIGGER_ERROR_ATTR,
  type RunModalCaps,
} from './render.js';

export { wireRunModal } from './wire.js';

export { RUN_MODAL_STYLES } from './styles.js';
