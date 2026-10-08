/** D-319 — what starts a recipe, in one sentence: the switch-on form says it
 *  under the recipe's settings ("It starts when a parcel's state changes."),
 *  and a dish's line says it beside its switch.
 *
 *  Read from the recipe's DECLARATIONS, not from trigger rows: the form asks
 *  before any row exists. A mail fact is said as D-315 says it; any other
 *  event by its kind of record; a recipe that starts on nothing runs when the
 *  owner runs it. Pure, so a test needs no DOM. */

import type { RecipeDefinition, RecipeEventTrigger } from '@recued/contracts';
import { eventPatternSegments, settingOfEventSegment } from '@recued/contracts';

import { humanizeFactName, withIndefiniteArticle } from './run-modal/mail-fact-trigger.js';
import { gateArgValue } from './timer-gate-args.js';
import { intervalInWords, timerRunsPhrase, type TimeWindowSource } from './time-window.js';

export { intervalInWords };

const VERB: Record<string, string> = {
  created: 'arrives',
  updated: 'changes',
  deleted: 'is removed',
  received: 'arrives',
  request: 'is sent',
};

const NOUN: ReadonlyArray<readonly [RegExp, string]> = [
  [/^data\.mail(\.|$)/, 'an email'],
  [/^data\.calendar(\.|$)/, 'a calendar event'],
  [/^data\.file(\.|$)/, 'a file'],
  [/^data\.contact(\.|$)/, 'a contact'],
  [/^data\.reception(\.|$)/, 'a form'],
  [/^data\.form_response(\.|$)/, 'a form response'],
  [/^data\.messenger(\.|$)/, 'a message'],
  [/^data\.work(\.|$)/, 'a work item'],
  [/^data\.dom\.element(\.|$)/, 'the page element it watches'],
  [/^run(\.|$)/, 'a run'],
  [/^record(\.|$)/, 'a record'],
];

/** What a setting part of a pattern names, by the kind of record. */
const PLACE: ReadonlyArray<readonly [RegExp, string]> = [
  [/^data\.mail(\.|$)/, 'mailbox'],
  [/^data\.calendar(\.|$)/, 'calendar'],
  [/^data\.file(\.|$)/, 'folder'],
];

/** A last part that matches any change. */
const ANY_CHANGE = 'arrives, changes or is removed';

/** What a file of one type is called, for a trigger narrowed to it. */
const FILE_KIND: ReadonlyArray<readonly [RegExp, string]> = [
  [/^(?:text\/calendar|application\/ics)$/i, 'a calendar invite'],
  [/^application\/pdf$/i, 'a PDF'],
  [/^image\//i, 'an image'],
  [/^audio\//i, 'an audio file'],
  [/^video\//i, 'a video'],
  [/^text\/csv$/i, 'a CSV file'],
];

const fileKindOf = (mime: string): string =>
  FILE_KIND.find(([test]) => test.test(mime))?.[1] ?? `a file of type “${mime}”`;

/** A trigger's `filter` in words. A narrowing that names WHAT it watches
 *  replaces the noun — `record.mime_type` on a file ("a calendar invite"),
 *  `kind` on a record ("a job event record") — and any other reads as "only
 *  when …".
 *
 *  ⛔ WITHOUT THIS THE SENTENCE OVERSTATED WHAT STARTS THE RECIPE. The invite
 *  recipes start only on a `text/calendar` file, and every one of them said
 *  "Starts when a file arrives", the narrowing shown beside it as
 *  `record.mime_type = text/calendar` (live drive, 2026-10-07). */
const filterInWords = (
  pattern: string,
  filter: Readonly<Record<string, unknown>> | undefined,
): { readonly noun?: string; readonly only: readonly string[] } => {
  let noun: string | undefined;
  const only: string[] = [];
  for (const [key, value] of Object.entries(filter ?? {})) {
    if (/^data\.file(\.|$)/.test(pattern) && key === 'record.mime_type' && typeof value === 'string') {
      noun = fileKindOf(value);
    } else if (/^record(\.|$)/.test(pattern) && key === 'kind' && typeof value === 'string') {
      noun = `a ${value.replace(/[_-]+/g, ' ')} record`;
    } else {
      const field = key.replace(/^record\./, '').replace(/[_.-]+/g, ' ');
      const said = typeof value === 'boolean' ? (value ? 'yes' : 'no') : `“${String(value)}”`;
      only.push(`only when ${field} is ${said}`);
    }
  }
  return { ...(noun !== undefined ? { noun } : {}), only };
};

/** One raw bus pattern in words ("an email arrives"). A part a setting fills
 *  (`data.file.{{config.file_slug}}.*.created`) says which one, as `settingOf`
 *  reads it: "a file arrives in the “scans” folder", or, with none chosen,
 *  "in the folder you choose". A part already filled in (a trigger ROW's
 *  pattern) is said the same way, and `filter` narrows the rest. */
const rawEventInWords = (
  pattern: string,
  settingOf: (setting: string) => unknown,
  filter?: Readonly<Record<string, unknown>>,
): string => {
  const segments = eventPatternSegments(pattern);
  const last = segments.at(-1) ?? '';
  if (/^run(\.|$)/.test(pattern)) return last === 'failed' ? 'a run fails' : 'a run finishes';
  const vendor = /^data\.connection\.api\.([a-z0-9_-]+)\.([a-z0-9_-]+)/.exec(pattern);
  const narrowed = filterInWords(pattern, filter);
  const noun = narrowed.noun ?? (vendor !== null
    ? `a ${vendor[1]} ${vendor[2]}`
    : NOUN.find(([test]) => test.test(pattern))?.[1] ?? 'something it watches');
  const verb = last === '*' || last === '**' ? ANY_CHANGE : VERB[last] ?? 'changes';
  const place = PLACE.find(([test]) => test.test(pattern))?.[1];
  const setting = segments.map(settingOfEventSegment).find((name): name is string => name !== null);
  // `data.<mail|calendar|file>.<instance>.…`; `received` is the store of files
  // that arrive (mail attachments, uploads), not a folder.
  const instance = place !== undefined && setting === undefined ? segments[2] : undefined;
  let where = '';
  if (setting !== undefined) {
    const value = settingOf(setting);
    where = typeof value === 'string' && value.length > 0
      ? ` in the “${value}”${place === undefined ? '' : ` ${place}`}`
      : ` in the ${place ?? 'one'} you choose`;
  } else if (instance !== undefined && !/^\*{1,2}$/.test(instance)
    && !(place === 'folder' && instance === 'received')) {
    where = ` in the “${instance}” ${place}`;
  }
  return [`${noun} ${verb}${where}`, ...narrowed.only].join(', ');
};

/** One trigger ROW in words — "a calendar invite arrives". A row's pattern is
 *  already concrete, so nothing is read from settings. */
export const eventTriggerInWords = (
  trigger: { readonly pattern: string; readonly filter?: Readonly<Record<string, unknown>> },
): string => rawEventInWords(trigger.pattern, () => undefined, trigger.filter);

/** One declared trigger in words; a setting it names is read as `settingOf`
 *  reads it. */
const declarationInWords = (entry: RecipeEventTrigger, settingOf: (setting: string) => unknown): string | null => {
  if (entry === null || typeof entry !== 'object') return null;
  if (typeof entry.on === 'string') {
    const fact = /^mail_fact(?:\.([a-z0-9_]+))?$/.exec(entry.on);
    if (fact !== null) {
      // D-315 — a fact read from mail: "a shipment's state changes".
      const kind = fact[1] === undefined ? 'fact' : humanizeFactName(fact[1].replace(/^custom_/, '')).toLowerCase();
      const fields = (Array.isArray(entry.fields) ? entry.fields : [])
        .filter((field): field is string => typeof field === 'string' && !field.startsWith('_'))
        .map((field) => humanizeFactName(field).toLowerCase());
      const where = Object.entries(entry.where ?? {})
        .map(([field, value]) => `${humanizeFactName(field).toLowerCase()} is ${typeof value === 'string' ? humanizeFactName(value).toLowerCase() : String(value)}`);
      const base = fields.length > 0
        ? `${withIndefiniteArticle(kind)}’s ${fields.join(' or ')} changes`
        : `mail about ${withIndefiniteArticle(kind)} is read`;
      return where.length > 0 ? `${base} and its ${where.join(' and ')}` : base;
    }
    // The shorthand names the thing and what happens to it ("deal.changed").
    const [thing, verb] = entry.on.split('.').slice(-2);
    return thing !== undefined && verb !== undefined
      ? `${/^[aeiou]/.test(thing) ? 'an' : 'a'} ${thing.replace(/_/g, ' ')} ${verb === 'changed' ? 'changes' : verb === 'created' ? 'arrives' : verb}`
      : null;
  }
  return typeof entry.event === 'string' ? rawEventInWords(entry.event, settingOf, entry.filter) : null;
};

/** What starts the recipe, as a verb phrase: "starts when a shipment’s state
 *  changes", "runs every 15 minutes", "runs when you run it". A dish's line
 *  says it as a clause; the switch-on form as a sentence.
 *
 *  A timer says when it REALLY runs (`timerRunsPhrase`): its time window ("runs
 *  every 10 minutes from 8:00 to 9:00 AM on weekdays") or what it waits for
 *  ("runs 30 minutes before each calendar event starts, checking every 5
 *  minutes"), read with `overlay`, the dish's own settings (absent: the
 *  recipe's defaults). */
export const startPhrase = (
  recipe: Pick<RecipeDefinition, 'auto_run' | 'event_triggers'> & TimeWindowSource,
  overlay?: Readonly<Record<string, unknown>>,
): string => {
  if (recipe.auto_run !== undefined) return timerRunsPhrase(recipe, recipe.auto_run.interval_ms, overlay);
  // A setting a trigger names, as a run of the dish reads it: its own value,
  // else the recipe's default.
  const settingOf = (setting: string): unknown => gateArgValue(`{{config.${setting}}}`, recipe, overlay);
  const said = [...new Set((recipe.event_triggers ?? [])
    .map((entry) => declarationInWords(entry as RecipeEventTrigger, settingOf))
    .filter((words): words is string => words !== null))];
  if (said.length === 0) return 'runs when you run it';
  return `starts when ${said.join(', or when ')}`;
};

/** What starts the recipe, as one sentence ending in a full stop. */
export const whatStartsIt = (
  recipe: Pick<RecipeDefinition, 'auto_run' | 'event_triggers'> & TimeWindowSource,
  overlay?: Readonly<Record<string, unknown>>,
): string => `It ${startPhrase(recipe, overlay)}.`;
