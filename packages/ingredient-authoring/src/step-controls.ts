import { CACHE_FRESHNESS_MODES, type BaseStep, type CacheFreshness, type IngredientStep, type StepFailureKind, type StepOptions, type StepPages } from '@recued/contracts';
import type { RecipeStepGroup } from './recipe-step-choices.js';
import { foreachAuthoringHelp } from './iteration-authoring.js';

type Control = Pick<BaseStep, 'skip_when' | 'fail_on' | 'stop_when' | 'fail_kind' | 'fail_reason' | 'cache'> & Pick<StepOptions, 'pages'> & Pick<IngredientStep, 'foreach'>;
export type StepControlKey = keyof Control;
export interface StepControlField { key: StepControlKey; description: string; condition: boolean }
const fields: { [K in keyof Control]-?: { description: string; condition: NonNullable<Control[K]> extends string ? false : true } } = {
  skip_when: { condition: true, description: 'Skip this step when the condition holds. It does not stop the remaining run.' },
  fail_on: { condition: true, description: 'Stop the run as a failure when this condition holds. fail_kind can classify the refusal; fail_reason explains it.' },
  stop_when: { condition: true, description: 'End the run successfully after a sequential step when this holds. A failure wins first. No item is bound here, even after foreach.' },
  fail_kind: { condition: false, description: 'Classify a fail_on refusal as policy or config. Requires fail_on. Only the transport may classify a failure as unavailable.' },
  fail_reason: { condition: false, description: 'Plain words shown when guard or fail_on stops the run. Requires one of those conditions. Template references are refused; explain what to fix without inserting private values.' },
  cache: { condition: false, description: 'Literal cache freshness for an eligible step. fresh bypasses cache reads and writes; acceptable uses unexpired data; any may reuse expired data. This does not make an uncacheable call cacheable.' },
  pages: { condition: false, description: 'Explicitly read all Records search pages, up to the shared search-row limit. Sequential operation or ingredient steps only; dispatch rejects this on other operations.' },
  foreach: { condition: false, description: foreachAuthoringHelp },
};
export const stepControlFields = (group: RecipeStepGroup): StepControlField[] =>
  (Object.keys(fields) as StepControlKey[]).filter(key => group === 'prefetch_steps' ? key === 'cache'
    : group !== 'trigger_steps' || key !== 'stop_when' && key !== 'pages' && key !== 'foreach').map(key => ({ key, ...fields[key] }));
export const stepFailureKindHelp: Record<StepFailureKind, string> = {
  policy: 'The recipe deliberately refuses the action under its policy. Retrying cannot help.',
  config: 'The recipe lacks required setup. Correct its configuration before retrying.',
};
export const stepCacheHelp: Record<CacheFreshness, string> = {
  fresh: 'Re-fetch without reading or writing a cache entry.',
  acceptable: 'Reuse an unexpired cache entry when this step is eligible for caching.',
  any: 'May reuse an expired cache entry. Choose this only when stale data is acceptable.',
};
const stepPagesHelp: Record<StepPages, string> = { all: 'Read all Records search pages within the shared row bound.' };
export const stepPolicyChoices = (key: StepControlKey): { value: string; description: string }[] =>
  key === 'cache' ? CACHE_FRESHNESS_MODES.map(value => ({ value, description: stepCacheHelp[value] }))
    : key === 'pages' ? Object.entries(stepPagesHelp).map(([value, description]) => ({ value, description }))
      : key === 'fail_kind' ? Object.entries(stepFailureKindHelp).map(([value, description]) => ({ value, description })) : [];
