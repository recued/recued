import { CRM_ALIAS_VALUES, ACCT_ALIAS_VALUES, parseOpId, type ForeachCheckpointResult } from '@recued/contracts';
import type { RecipeStepGroup } from './recipe-step-choices.js';
export const recipeStepSupportsForeach = (group: RecipeStepGroup, step: Readonly<Record<string, unknown>>): boolean => {
  if (group !== 'steps') return false;
  if (typeof step.op === 'string') {
    const parts = step.op.split('.');
    if (!parseOpId(step.op) && parts.length === 2 && [...CRM_ALIAS_VALUES, ...ACCT_ALIAS_VALUES].some(alias => alias === parts[0])) return false;
    return true;
  }
  return typeof step.ingredient === 'string' || typeof step.transform === 'string' || typeof step.guard === 'string';
};
export const foreachAuthoringHelp = 'Resolve an array and run this sequential step once per item. {{item}} is the current value; {{item.field}} reads a field. Ordinary per-item failures are collected rather than failing the run; approval pauses still suspend it. Results contain per-item envelopes. stop_when reads the completed aggregate with no item bound.';
const resultHelp: Record<keyof ForeachCheckpointResult, string> = {
  ok: 'Whether this iteration completed without an ordinary error.',
  skipped: 'Present and true when the per-item filter skipped this iteration.',
  result: 'The result for a completed iteration; absent on an error.',
  error: 'The ordinary error for a failed iteration; absent on success.',
  item: 'The source item echoed by the iteration, including when the call failed.',
};
export const foreachResultFields = (): { name: string; description: string }[] => Object.entries(resultHelp).map(([name, description]) => ({ name, description }));
