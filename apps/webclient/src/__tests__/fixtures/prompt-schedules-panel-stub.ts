import type { mountPromptSchedulesPanel as mountRealPanel } from '../../automation/prompt-schedules-panel.js';

/** The legacy Chat unit fixtures model only their subject's DOM APIs. The real
 * schedule panel and its Chat integration run in e2e/prompt-schedules.spec.ts. */
export const mountPromptSchedulesPanel: typeof mountRealPanel = () => ({
  setSession() {},
  setFilter() {},
  pending: () => false,
  hasDraft: () => false,
  hasSearch: () => false,
  getQuery: () => '',
  setQuery() {},
  focusSchedule: () => false,
  resolveSchedule: async () => null,
  hasRecoveries: () => false,
  resumeDraft: () => false,
  flush: () => true,
  showRecoveryNotice() {},
  protectDraft: () => false,
  openCreate() {},
  refresh: async () => {},
  whenLoaded: async () => {},
  dispose() {},
});
