/** When a timer that waits for DATA really runs (2026-10-05).
 *
 *  Shipped timer recipes that check every few minutes but run only when a
 *  watcher finds something (a meeting coming up, a page that changed) were
 *  each described by their check interval, the wrong time (owner: "do the
 *  event wording for the 14 data-gated timers too"). Each watcher's gate
 *  becomes the clause that says what makes the recipe run, worded from what
 *  the watcher really does:
 *
 *    time-relative  fires once per record per offset ("30 minutes before each
 *                   calendar event starts");
 *    http           the page's content changed.
 *
 *  (The calendar, mail, file, webhook and recipe watchers were retired on
 *  2026-10-05 for event triggers, which `dish-lead.ts` words.)
 *
 *  Values are read as a run reads them (`gateArgValue`): a dish's own setting,
 *  else the recipe's default. One the screen cannot read keeps the clause
 *  general ("the page it watches"), never invented. */

import {
  gateArgValue,
  gateStepsOf,
  joinWords,
  type GateStep,
  type TimeWindowSource,
} from './timer-gate-args.js';

/** A text value as the dish runs with it, or `null` (absent, empty, or worked
 *  out at run time). */
const textArg = (
  step: GateStep,
  name: string,
  recipe: TimeWindowSource,
  overlay: Readonly<Record<string, unknown>> | undefined,
): string | null => {
  const value = gateArgValue(step.args[name], recipe, overlay);
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
};

const quoted = (text: string): string => `“${text}”`;

const OFFSET = /^([+-]?)(\d+)([smhd])$/;
const UNIT: Readonly<Record<string, string>> = { s: 'second', m: 'minute', h: 'hour', d: 'day' };
const UNIT_MS: Readonly<Record<string, number>> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** The record a time-relative gate counts from, and how its anchor reads. */
const anchorOf = (
  collection: string | null,
  field: string | null,
  filter: string | null,
  instance: string | null,
): { readonly subject: string; readonly verb: boolean } => {
  const kind = (collection ?? '').replace(/^data\.(work\.)?/, '').replace(/^work\./, '');
  // A calendar named in `instance` is the only one watched.
  const noun = kind === 'calendar' ? (instance === null ? 'calendar event' : `event in the ${quoted(instance)} calendar`)
    : kind === 'task' ? (filter === 'recued_reminder' ? 'reminder' : 'task')
      : kind === 'mail' ? 'email'
        : kind === 'contact' || kind === 'file' ? kind
          : 'record';
  const verbs: Readonly<Record<string, string>> = kind === 'calendar' ? { start_at: 'starts', end_at: 'ends' }
    : kind === 'task' ? { due_at: 'is due' }
      : kind === 'mail' ? { received_at: 'arrives' }
        : kind === 'file' ? { modified_at: 'changes' }
          : {};
  const verb = field === null ? undefined : verbs[field];
  if (verb !== undefined) return { subject: `each ${noun} ${verb}`, verb: true };
  const what = field === null ? 'time' : field.replace(/_at$/, '').replace(/_/g, ' ');
  return { subject: `each ${noun}’s ${what}`, verb: false };
};

/** "30 minutes before each calendar event starts", "3 days, 1 day and 3 hours
 *  before …", "when each reminder is due". */
const timeRelativeClause = (
  step: GateStep,
  recipe: TimeWindowSource,
  overlay: Readonly<Record<string, unknown>> | undefined,
): string => {
  const anchor = anchorOf(
    textArg(step, 'collection', recipe, overlay),
    textArg(step, 'anchor_field', recipe, overlay),
    textArg(step, 'filter', recipe, overlay),
    textArg(step, 'instance', recipe, overlay),
  );
  const raw = gateArgValue(step.args.offsets, recipe, overlay);
  const offsets = Array.isArray(raw) ? raw.map((offset) => OFFSET.exec(String(offset).trim())) : null;
  if (offsets === null || offsets.length === 0 || offsets.some((offset) => offset === null)) {
    return anchor.verb ? `around the time ${anchor.subject}` : `around ${anchor.subject}`;
  }
  const parsed = offsets.map((match) => {
    const amount = Number(match![2]);
    const unit = match![3]!;
    return {
      ms: (match![1] === '-' ? -1 : 1) * amount * UNIT_MS[unit]!,
      words: `${amount} ${UNIT[unit]}${amount === 1 ? '' : 's'}`,
    };
  });
  const before = parsed.filter((offset) => offset.ms < 0).sort((a, b) => a.ms - b.ms).map((offset) => offset.words);
  const after = parsed.filter((offset) => offset.ms > 0).sort((a, b) => a.ms - b.ms).map((offset) => offset.words);
  const at = parsed.some((offset) => offset.ms === 0);
  const sides = [
    ...(before.length > 0 ? [`${joinWords(before)} before`] : []),
    ...(after.length > 0 ? [`${joinWords(after)} after`] : []),
  ];
  const around = sides.length > 0 ? `${sides.join(' and ')} ${anchor.subject}` : '';
  const exact = at ? `${anchor.verb ? 'when' : 'at'} ${anchor.subject}` : '';
  return [around, exact].filter((part) => part !== '').join(', and ');
};

/** "when the page at example.com/pricing changes". */
const httpClause = (
  step: GateStep,
  recipe: TimeWindowSource,
  overlay: Readonly<Record<string, unknown>> | undefined,
): string => {
  const url = textArg(step, 'target_url', recipe, overlay);
  if (url === null) return 'when the page it watches changes';
  const bare = url.replace(/^https?:\/\//i, '').replace(/\/$/, '');
  return `when the page at ${bare.length > 60 ? `${bare.slice(0, 59)}…` : bare} changes`;
};

/** What makes a timer run besides its clock: one clause per gate that waits
 *  for data, in the recipe's order. Empty: it waits for nothing but its clock
 *  (a time window is said by `time-window.ts`). A trigger step that is no
 *  watcher reads as "when its own checks pass". */
export const timerEventClauses = (
  recipe: TimeWindowSource,
  overlay?: Readonly<Record<string, unknown>>,
): string[] => {
  const clauses: string[] = [];
  for (const step of gateStepsOf(recipe)) {
    switch (step.kind) {
      case 'time':
        break;
      case 'time-relative':
        clauses.push(timeRelativeClause(step, recipe, overlay));
        break;
      case 'http':
        clauses.push(httpClause(step, recipe, overlay));
        break;
      default:
        clauses.push('when its own checks pass');
    }
  }
  return [...new Set(clauses)];
};
