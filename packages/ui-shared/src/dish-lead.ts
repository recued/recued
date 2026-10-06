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

/** One raw bus pattern in words ("an email arrives"). A part a setting fills
 *  (`data.file.{{config.file_slug}}.*.created`) says which one, as `settingOf`
 *  reads it: "a file arrives in the “scans” folder", or, with none chosen,
 *  "in the folder you choose". */
const rawEventInWords = (pattern: string, settingOf: (setting: string) => unknown): string => {
  const vendor = /^data\.connection\.api\.([a-z0-9_-]+)\.([a-z0-9_-]+)/.exec(pattern);
  const noun = vendor !== null
    ? `a ${vendor[1]} ${vendor[2]}`
    : NOUN.find(([test]) => test.test(pattern))?.[1] ?? 'something it watches';
  const segments = eventPatternSegments(pattern);
  const last = segments.at(-1) ?? '';
  if (/^run(\.|$)/.test(pattern)) return last === 'failed' ? 'a run fails' : 'a run finishes';
  const setting = segments.map(settingOfEventSegment).find((name): name is string => name !== null);
  if (setting === undefined) return `${noun} ${VERB[last] ?? 'changes'}`;
  const place = PLACE.find(([test]) => test.test(pattern))?.[1];
  const value = settingOf(setting);
  const where = typeof value === 'string' && value.length > 0
    ? `in the “${value}”${place === undefined ? '' : ` ${place}`}`
    : `in the ${place ?? 'one'} you choose`;
  return `${noun} ${VERB[last] ?? 'changes'} ${where}`;
};

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
  return typeof entry.event === 'string' ? rawEventInWords(entry.event, settingOf) : null;
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
