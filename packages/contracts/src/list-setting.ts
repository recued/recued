/** A list setting: a recipe variable whose hint says `type: 'array'`, as the
 *  owner gives it.
 *
 *  ⛔ THE SETTINGS FORM HAS NO LIST CONTROL. An `array` hint renders as a
 *  one-line text box (D-222 § 7: a type the union does not declare falls back
 *  to text), so a saved setting was the text typed into it, `"slack, email"`,
 *  and a box emptied again was `""`. Every consumer takes the value as a list: a
 *  notification's channels, a watch's weekdays, the right side of an `in`
 *  condition, an API body's ids. So the text reached each of them as the wrong
 *  type. 628 settings, and typing into any of them broke the step it fed
 *  (D-312 found it on channels).
 *
 *  Read in two places, with these rules:
 *  - the server, where a run's config is composed, so the audit snapshot, the
 *    held-action identity and the engine all see the list, whichever form (or
 *    chat tool) saved the text;
 *  - the form, so a newer form saves a real list to an older server.
 *
 *  ⚠ `'array'` stays out of `ValueHintType`: `value-hint.ts` rules that one
 *  member added alone is worse than the cast. It is compared as a string here,
 *  as the renderer compares `'long_text'`.
 *
 *  D-314: a list setting with `options` is a set of checkboxes instead of the
 *  box. `options` holds the values themselves, or names one list Recued keeps
 *  (`["@weekdays"]`), which supplies what each value reads as. */

import {
  NOTIFICATION_DELIVERY_CHANNELS,
  type NotificationDeliveryChannel,
} from './notifications.js';

/** Items are separated by commas, semicolons or new lines. Not spaces: an item
 *  can hold one ("In progress"). */
const ITEM_SEPARATOR = /[,;\n]/u;

/** True when a setting's default is a list of numbers, so typed items are
 *  numbers too: weekdays `1, 2, 3`. */
export const isListOfNumbers = (sample: unknown): boolean =>
  Array.isArray(sample)
  && sample.length > 0
  && sample.every((value) => typeof value === 'number');

/** The list that `text` spells.
 *
 *  - Blank text is no value (`undefined`), so the setting falls back to its
 *    default, or to none.
 *  - Text that is a JSON array is that array, for items that contain commas.
 *  - Otherwise each item is trimmed and empty ones are dropped.
 *  - With `numbers`, an item that reads as a number becomes one. */
export const listFromTypedText = (
  text: string,
  { numbers = false }: { numbers?: boolean } = {},
): unknown[] | undefined => {
  const trimmed = text.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // Not JSON: read it as typed items.
    }
  }
  const items = trimmed.split(ITEM_SEPARATOR)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  if (items.length === 0) return undefined;
  return numbers
    ? items.map((item) => {
      const n = Number(item);
      return Number.isFinite(n) ? n : item;
    })
    : items;
};

/** True for a variable hint that declares a list. */
export const isListSetting = (hint: unknown): boolean =>
  hint !== null
  && typeof hint === 'object'
  && !Array.isArray(hint)
  && (hint as { type?: unknown }).type === 'array';

/** `config` with each list setting that holds text read as its list, and a
 *  blank one removed so its default applies. Every other value passes through
 *  as it is, and `config` itself comes back when nothing is text. */
export const readTypedListSettings = <C extends Readonly<Record<string, unknown>>>(
  variables: Readonly<Record<string, unknown>> | undefined,
  config: C,
): C => {
  let out: Record<string, unknown> | null = null;
  for (const [key, hint] of Object.entries(variables ?? {})) {
    if (!isListSetting(hint) || !Object.hasOwn(config, key)) continue;
    const value = config[key];
    if (typeof value !== 'string') continue;
    out ??= { ...config };
    const list = listFromTypedText(value, { numbers: isListOfNumbers((hint as { default?: unknown }).default) });
    if (list === undefined) delete out[key];
    else out[key] = list;
  }
  return (out ?? config) as C;
};

// ── D-314: a list setting's choices ──────────────────────────────────────

/** One choice a list setting offers: the value it saves, and what it reads as. */
export interface ListChoice {
  readonly value: string | number;
  readonly label: string;
}

/** The choices a list setting offers, in the order they are shown. */
export interface ListChoices {
  readonly choices: readonly ListChoice[];
  /** A saved item as one of the choices' values, or `undefined` when it is
   *  none of them. A form keeps such an item visible rather than dropping it. */
  readonly normalize: (item: unknown) => string | number | undefined;
}

/** A notification channel as an owner writes it: any case, with `in-app` for
 *  `in_app` (D-312). The notification adapter reads names with this too. */
export const notificationChannelName = (name: string): string =>
  name.trim().toLowerCase().replace(/-/gu, '_');

/** Keyed by the delivery vocabulary, so a transport added there does not
 *  compile until it has a label here. */
const NOTIFICATION_CHANNEL_LABELS: Readonly<Record<NotificationDeliveryChannel, string>> = {
  slack: 'Slack',
  telegram: 'Telegram',
  whatsapp: 'WhatsApp',
  discord: 'Discord',
  teams: 'Teams',
  email: 'Email',
  in_app: 'In-app',
};

const WEEKDAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;

/** The lists Recued keeps, which a list setting names in its `options` as
 *  `@<name>` rather than copying the values into every recipe. A name here is
 *  a value a recipe can hold, so one is never renamed. */
export const LIST_VOCABULARIES: Readonly<Record<string, ListChoices>> = {
  /** The time watcher's days (`core.watch.time`): 1 is Monday and 7 Sunday.
   *  The watcher reads 0 as Sunday too, so a saved 0 shows as Sunday. */
  weekdays: {
    choices: WEEKDAY_LABELS.map((label, index) => ({ value: index + 1, label })),
    normalize: (item) => {
      const day = typeof item === 'number'
        ? item
        : typeof item === 'string' && item.trim() !== '' ? Number(item) : Number.NaN;
      if (!Number.isInteger(day) || day < 0 || day > 7) return undefined;
      return day === 0 ? 7 : day;
    },
  },
  /** Where a notification goes: `core.notification.send`'s `channels`. */
  notification_channels: {
    choices: NOTIFICATION_DELIVERY_CHANNELS.map((channel) => ({
      value: channel,
      label: NOTIFICATION_CHANNEL_LABELS[channel],
    })),
    normalize: (item) => {
      if (typeof item !== 'string') return undefined;
      const name = notificationChannelName(item);
      return (NOTIFICATION_DELIVERY_CHANNELS as readonly string[]).includes(name) ? name : undefined;
    },
  },
};

const VOCABULARY_REF = /^@([a-z][a-z_]*)$/u;

/** The name in `["@weekdays"]`: options that name one list Recued keeps.
 *  Anything else (several options, or one plain value) is `undefined`. */
export const listVocabularyRef = (options: unknown): string | undefined => {
  if (!Array.isArray(options) || options.length !== 1 || typeof options[0] !== 'string') return undefined;
  return VOCABULARY_REF.exec(options[0])?.[1];
};

/** The choices a list setting offers, or `undefined` when it offers none and
 *  stays a box.
 *
 *  - `["@weekdays"]` offers that list, with its labels.
 *  - Plain options offer themselves, each reading as it is written. They are
 *    numbers when the setting's default is a list of numbers.
 *  - A name this build does not keep offers nothing: a recipe newer than the
 *    form gets the box, which still reads a typed list. */
export const listSettingChoices = (hint: unknown): ListChoices | undefined => {
  if (!isListSetting(hint)) return undefined;
  const options = (hint as { options?: unknown }).options;
  if (!Array.isArray(options) || options.length === 0) return undefined;
  if (!options.every((option) => typeof option === 'string' && option.trim().length > 0)) return undefined;
  const ref = listVocabularyRef(options);
  if (ref !== undefined) return Object.hasOwn(LIST_VOCABULARIES, ref) ? LIST_VOCABULARIES[ref] : undefined;
  const numbers = isListOfNumbers((hint as { default?: unknown }).default);
  const choices: ListChoice[] = (options as string[]).map((option) => {
    const n = Number(option);
    return { value: numbers && Number.isFinite(n) ? n : option, label: option };
  });
  return {
    choices,
    normalize: (item) => {
      if (typeof item !== 'string' && typeof item !== 'number') return undefined;
      const written = String(item).trim();
      return choices.find((choice) => String(choice.value) === written)?.value;
    },
  };
};
