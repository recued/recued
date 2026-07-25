/** Token budget thresholds — shared between extension and server.
 *
 *  Stages gate different behaviors as usage approaches the daily limit:
 *    - schedule_cutoff: scheduled/background runs stop (save budget for manual)
 *    - warning:         UI/CLI shows a warning
 *    - hard_limit:      all AI calls blocked
 *
 *  Values are percentages of the daily budget (0-100).
 */

export interface BudgetThresholds {
  /** Scheduled runs stop at this % to preserve budget for manual use. */
  schedule_cutoff: number;
  /** Warning shown to user at this %. */
  warning: number;
  /** All AI calls blocked at this %. */
  hard_limit: number;
}

export const DEFAULT_BUDGET_THRESHOLDS: BudgetThresholds = {
  schedule_cutoff: 80,
  warning: 95,
  hard_limit: 100,
};

export type BudgetStatus = 'ok' | 'schedule_cutoff' | 'warning' | 'exceeded';

/** Compute the current budget status given usage and budget. */
export const checkBudgetStatus = (
  usage: number,
  budget: number,
  thresholds: BudgetThresholds = DEFAULT_BUDGET_THRESHOLDS,
): { status: BudgetStatus; percent: number } => {
  if (budget <= 0) return { status: 'ok', percent: 0 }; // unlimited
  const percent = Math.round((usage / budget) * 100);
  if (percent >= thresholds.hard_limit) return { status: 'exceeded', percent };
  if (percent >= thresholds.warning) return { status: 'warning', percent };
  if (percent >= thresholds.schedule_cutoff) return { status: 'schedule_cutoff', percent };
  return { status: 'ok', percent };
};
