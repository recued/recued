import { FORMAT_HINTS, type FormatHint } from '@recued/contracts';

/** Portable authoring help for the resolver's public display hints. */
const descriptions: Record<FormatHint, string> = {
  currency: 'Format a numeric value as USD using the runtime locale.',
  number: 'Format a numeric value with grouping and decimals using the runtime locale.',
  date: 'Format a date string or supported epoch timestamp using the runtime locale. A date-only value keeps its calendar day.',
  relative: 'Format a date string or supported epoch timestamp as relative day text, such as today or 2 days ago.',
  percent: 'Format a numeric fraction as a percentage using the runtime locale; for example, 0.25 represents 25%.',
};
export const referenceFormatHintHelp = (hint: string): string | undefined =>
  FORMAT_HINTS.has(hint as FormatHint) ? descriptions[hint as FormatHint] : undefined;
