/** The words a usage cap's period is shown in — one set, for every surface that
 *  shows one.
 *
 *  ⛔⛔ THREE COPIES IS WHAT THIS REPLACES, AND ALL THREE WERE WRITTEN THE SAME
 *  HOUR. When `use_period` reached the owner-facing controls it arrived at three
 *  places at once — the MCP door's Advanced panel, the contracts mint form, and
 *  the contracts list row — and each grew its own period→words map. Two of them
 *  had already disagreed: the door offered `ever` where the mint form offered
 *  `in total`, for the same stored value.
 *
 *  🔑 THE DAMAGE IS NOT THE DUPLICATION, IT IS THE DISAGREEMENT. An owner who
 *  sets a limit on one surface and reads it on another is entitled to the same
 *  word for the same thing; two names for one value reads as two settings. A
 *  shared map makes that a compile-time property rather than a review habit.
 *
 *  ⚠ THIS IS COPY, WHICH IS WHY IT IS HERE AND NOT IN CONTRACTS. The VOCABULARY
 *  (`USAGE_CAP_PERIODS`) is a closed set of stored values and belongs with the
 *  types; the words an owner reads are a UI decision and change without the
 *  stored value changing. Keyed by the contract type so a new member cannot be
 *  added without deciding what to call it. */

import type { UsageCapPeriod } from '@recued/contracts';

/** What the owner picks between when setting a cap: "100 `in total`", "100 `per
 *  month`". Parallel phrasing on purpose — the option has to read as the tail of
 *  the sentence the number starts. */
export const USAGE_CAP_PERIOD_OPTION_LABEL: Record<UsageCapPeriod, string> = {
  total: 'in total',
  day: 'per day',
  month: 'per month',
};

/** How a period reads at the END of a "N of M left" phrase.
 *
 *  ⚠ `'total'` contributes NOTHING, deliberately. "3 of 5 left" already says it;
 *  appending " in total" reads as filler on the one case that is also the
 *  default, which is the case most owners will ever see. */
export const USAGE_CAP_PERIOD_REMAINING_SUFFIX: Record<UsageCapPeriod, string> = {
  total: '',
  day: ' today',
  month: ' this month',
};

/** The description under a "Use limit" control. A cap with a window does
 *  something the owner needs told — it comes back — and a lifetime cap does not.
 *
 *  ⛔ "Shut it off after this many uses" IS NOT HERE, and its absence is the
 *  point: that sentence was written when a spent cap could not refuse and a
 *  budget could not refill, and it was wrong on both counts. */
export const usageCapPeriodDescription = (period: UsageCapPeriod): string =>
  period === 'total'
    ? 'Stop after exactly this many calls.'
    : 'Stop after this many calls, then start counting again.';
