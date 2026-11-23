/** D-339 slice 12a (D-339 §5.6) — the words of the owner's chats' switch for a Body's
 *  numbers, on every Body's page: Off · Ask · Allow, each choice saying what it does, so no state is
 *  read only as "not the other one". */
import type { BodyNumbersMode } from '@recued/contracts';

export const BODY_NUMBERS_TITLE = 'Body numbers in your chats';

/** Under the title: that it is one switch, and where an AI app's is. */
export const BODY_NUMBERS_INTRO = 'One switch for every Body. Your chats always see the names of the readings, '
  + 'not the numbers. AI apps have their own switch, in Contracts.';

export const BODY_NUMBERS_CHOICES: ReadonlyArray<{ readonly mode: BodyNumbersMode; readonly label: string; readonly words: string }> = [
  { mode: 'off', label: 'Off', words: 'Your chats can’t read the numbers.' },
  { mode: 'ask', label: 'Ask', words: 'Your chats ask you before each read.' },
  { mode: 'allow', label: 'Allow', words: 'Your chats read the numbers without asking.' },
];

/** What the page says once the switch is set. */
export const bodyNumbersSetWords = (mode: BodyNumbersMode): string =>
  mode === 'off' ? 'Body numbers are off for your chats.'
    : mode === 'ask' ? 'Your chats will ask before reading body numbers.'
      : 'Your chats will read body numbers without asking.';
