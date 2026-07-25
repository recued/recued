import type { LLMRequirements, ModelHint } from '@recued/contracts';
import type {
  AvailabilitySnapshot,
  CoordinationStrategy,
  LLMConfig,
} from './types.js';
import { LLMError, normalizeLLMSlot } from './types.js';
import type { QuotaTracker } from './quota.js';
import { matchLLM, type ForceLayer } from './match.js';

/** One LLM-touching step the engine wants to preflight. The caller (engine)
 *  derives `requires` from the ingredient manifest + step input.
 *  `allowUpgrade` is the recipe-variable → user-global resolution;
 *  `forceLayer` is the recipe/step-level layer restriction (default 'any'). */
export interface PreflightStepMeta {
  step_id: string;
  ingredient_slug: string;
  requires: LLMRequirements;
  allowUpgrade: boolean;
  forceLayer?: ForceLayer;
}

export interface PreflightDeps {
  config: LLMConfig;
  availability: AvailabilitySnapshot;
  quota: QuotaTracker;
  strategy: CoordinationStrategy;
}

export interface PreflightIssue {
  step_id: string;
  ingredient: string;
  requires: LLMRequirements;
  /** Diagnostic category. `no_tier` means no configured source can serve the
   *  required speed. `no_json` / `no_search` = capability missing. `all_unavailable`
   *  = at least one qualifying source exists but all are currently unavailable
   *  (keys missing, quota exhausted, tab closed). */
  reason: 'no_tier' | 'no_json' | 'no_search' | 'all_unavailable';
  /** User-facing hint, ready to surface in the UI. */
  suggestion: string;
}

export type PreflightResult = { ok: true } | { ok: false; issues: PreflightIssue[] };

const anySlotSupports = (
  config: LLMConfig,
  pred: (speed: ModelHint, json: boolean, search: boolean) => boolean,
): boolean => {
  const slots = [
    normalizeLLMSlot(config.slot_1, 'slot_1'),
    normalizeLLMSlot(config.slot_2, 'slot_2'),
  ].filter((s): s is NonNullable<typeof s> => Boolean(s));
  for (const s of slots) {
    if (pred(s.speed ?? 'fast', s.supports_json ?? true, s.supports_search === true)) return true;
  }
  return false;
};

const anyPoolEntrySupports = (
  config: LLMConfig,
  pred: (speed: ModelHint, json: boolean, search: boolean) => boolean,
): boolean => {
  for (const e of config.free_pool ?? []) {
    if (!e.enabled) continue;
    if (e.type === 'api') {
      if (pred(e.speed, e.supports_json, e.supports_search === true)) return true;
    } else {
      if (pred(e.speed, false, false)) return true;
    }
  }
  return false;
};

const classifyReason = (
  requires: LLMRequirements,
  config: LLMConfig,
): PreflightIssue['reason'] => {
  const pred = (wantSpeed: ModelHint, wantJson: boolean, wantSearch: boolean) =>
    (speed: ModelHint, json: boolean, search: boolean) =>
      speed === wantSpeed && (!wantJson || json) && (!wantSearch || search);

  const needJson = requires.output_format === 'json';
  const needSearch = requires.needs_search === true;

  const canSpeed = anySlotSupports(config, pred(requires.speed, false, false))
    || anyPoolEntrySupports(config, pred(requires.speed, false, false));
  if (!canSpeed) return 'no_tier';

  if (needJson) {
    const canJson = anySlotSupports(config, pred(requires.speed, true, false))
      || anyPoolEntrySupports(config, pred(requires.speed, true, false));
    if (!canJson) return 'no_json';
  }
  if (needSearch) {
    const canSearch = anySlotSupports(config, pred(requires.speed, needJson, true))
      || anyPoolEntrySupports(config, pred(requires.speed, needJson, true));
    if (!canSearch) return 'no_search';
  }
  return 'all_unavailable';
};

const reasonSuggestion = (
  requires: LLMRequirements,
  reason: PreflightIssue['reason'],
): string => {
  const speed = requires.speed;
  const up = speed.charAt(0).toUpperCase() + speed.slice(1);
  const upgradeHint = 'Or enable "Allow LLM upgrade" in this recipe\'s variables.';
  switch (reason) {
    case 'no_tier':
      return `This recipe requires a ${speed}-tier LLM. Add a ${speed}-tier entry in Options → LLM. ${upgradeHint}`;
    case 'no_json':
      return `${up}-tier LLM with JSON support is required. Add a JSON-capable ${speed}-tier entry.`;
    case 'no_search':
      return `${up}-tier LLM with web-search support is required. Add a search-capable ${speed}-tier entry in Options → LLM.`;
    case 'all_unavailable':
      return `A ${speed}-tier LLM is configured but currently unavailable (quota exhausted, tab closed, or over budget). Wait for quota reset, open the relevant chat tab, or raise the budget.`;
  }
};

/** Run matchLLM in dry-run mode for every LLM-touching step. No quota side
 *  effects (currentCursor reads; no advanceCursor / recordUsage calls).
 *  Returns { ok: true } when every step can resolve; otherwise an ordered
 *  list of specific issues for UI surfacing. */
export const preflightMatch = (
  steps: PreflightStepMeta[],
  deps: PreflightDeps,
): PreflightResult => {
  const issues: PreflightIssue[] = [];
  for (const step of steps) {
    try {
      matchLLM(
        {
          requires: step.requires,
          allowUpgrade: step.allowUpgrade,
          forceLayer: step.forceLayer ?? 'any',
        },
        deps,
      );
    } catch (e) {
      if (e instanceof LLMError && e.code === 'AI_LLM_UNAVAILABLE') {
        const reason = classifyReason(step.requires, deps.config);
        issues.push({
          step_id: step.step_id,
          ingredient: step.ingredient_slug,
          requires: step.requires,
          reason,
          suggestion: reasonSuggestion(step.requires, reason),
        });
      } else {
        throw e;
      }
    }
  }
  return issues.length === 0 ? { ok: true } : { ok: false, issues };
};
