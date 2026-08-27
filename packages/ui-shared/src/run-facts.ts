import type { RecipeRunFacts } from '@recued/contracts';

const countFormat = new Intl.NumberFormat('en-US', {
  maximumFractionDigits: 0,
});
const secondsFormat = new Intl.NumberFormat('en-US', {
  maximumFractionDigits: 1,
});

const isCount = (value: number | undefined): value is number =>
  typeof value === 'number'
  && Number.isSafeInteger(value)
  && value >= 0;

const isDuration = (value: number): boolean =>
  Number.isFinite(value) && value >= 0;

const counted = (value: number, singular: string): string =>
  `${countFormat.format(value)} ${singular}${value === 1 ? '' : 's'}`;

/** Format the persisted recipe-run receipt in one stable, scan-friendly order.
 *  Provider usage is an evidence pair: if either half is absent, neither is
 *  rendered. This avoids turning missing telemetry into a zero-cost claim. */
export const formatRecipeRunFacts = (
  facts: RecipeRunFacts | undefined,
): string | null => {
  if (
    facts === undefined
    || !isCount(facts.steps_run)
    || !isCount(facts.items_total)
    || !isDuration(facts.duration_ms)
  ) return null;

  const parts = [
    counted(facts.steps_run, 'step'),
    counted(facts.items_total, 'item'),
  ];
  if (isCount(facts.provider_calls) && isCount(facts.total_tokens)) {
    parts.push(
      counted(facts.provider_calls, 'provider call'),
      counted(facts.total_tokens, 'token'),
    );
  }
  const seconds = Math.round((facts.duration_ms / 1_000) * 10) / 10;
  parts.push(`${secondsFormat.format(seconds)} ${
    seconds === 1 ? 'second' : 'seconds'
  }`);
  return parts.join(' · ');
};
