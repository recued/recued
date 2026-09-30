/** D-319 — what starts a recipe, in one sentence: the switch-on form says it
 *  under the recipe's settings ("It starts when a parcel's state changes."),
 *  and a dish's line says it beside its switch.
 *
 *  Read from the recipe's DECLARATIONS, not from trigger rows: the form asks
 *  before any row exists. A mail fact is said as D-315 says it; any other
 *  event by its kind of record; a recipe that starts on nothing runs when the
 *  owner runs it. Pure, so a test needs no DOM. */

import type { RecipeDefinition, RecipeEventTrigger } from '@recued/contracts';

import { humanizeFactName, withIndefiniteArticle } from './run-modal/mail-fact-trigger.js';

/** An interval in words, as "every …" says it: "15 minutes", "hour", "2 days". */
export const intervalInWords = (ms: number): string => {
  const unit = (n: number, one: string): string => (n === 1 ? one : `${n} ${one}s`);
  if (ms < 60_000) return unit(Math.max(1, Math.round(ms / 1000)), 'second');
  if (ms < 3_600_000) return unit(Math.round(ms / 60_000), 'minute');
  if (ms < 86_400_000) return unit(Math.round(ms / 3_600_000), 'hour');
  return unit(Math.round(ms / 86_400_000), 'day');
};

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

/** One raw bus pattern in words ("an email arrives"). */
const rawEventInWords = (pattern: string): string => {
  const vendor = /^data\.connection\.api\.([a-z0-9_-]+)\.([a-z0-9_-]+)/.exec(pattern);
  const noun = vendor !== null
    ? `a ${vendor[1]} ${vendor[2]}`
    : NOUN.find(([test]) => test.test(pattern))?.[1] ?? 'something it watches';
  const last = pattern.split('.').at(-1) ?? '';
  if (/^run(\.|$)/.test(pattern)) return last === 'failed' ? 'a run fails' : 'a run finishes';
  return `${noun} ${VERB[last] ?? 'changes'}`;
};

/** One declared trigger in words. */
const declarationInWords = (entry: RecipeEventTrigger): string | null => {
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
  return typeof entry.event === 'string' ? rawEventInWords(entry.event) : null;
};

/** What starts the recipe, as a verb phrase: "starts when a shipment’s state
 *  changes", "runs every 15 minutes", "runs when you run it". A dish's line
 *  says it as a clause; the switch-on form as a sentence. */
export const startPhrase = (
  recipe: Pick<RecipeDefinition, 'auto_run' | 'event_triggers'>,
): string => {
  if (recipe.auto_run !== undefined) {
    return `runs every ${intervalInWords(recipe.auto_run.interval_ms)}`;
  }
  const said = [...new Set((recipe.event_triggers ?? [])
    .map((entry) => declarationInWords(entry as RecipeEventTrigger))
    .filter((words): words is string => words !== null))];
  if (said.length === 0) return 'runs when you run it';
  return `starts when ${said.join(', or when ')}`;
};

/** What starts the recipe, as one sentence ending in a full stop. */
export const whatStartsIt = (
  recipe: Pick<RecipeDefinition, 'auto_run' | 'event_triggers'>,
): string => `It ${startPhrase(recipe)}.`;
