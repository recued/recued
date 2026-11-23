/** D-402 slice A5 — an AI app's labels for its job, checked against what Recued recorded (§5.1).
 *
 *  Recued never sees an AI app's request, so the app says where its values came from when it asks
 *  for a draft: which values the owner gave it (inputs, asked for at each run), which it read in the
 *  job, where it used judgement, and which values its answer gave. Each claim is checked against the
 *  job's record: an input must occur in what the job did (a typed or picked value, an address, a
 *  call's arguments); a value read, or given as the answer, must occur in a result Recued returned in
 *  the job; a judgement must name something the job did or read. A claim the record contradicts is
 *  refused with its reason. One the record cannot settle, because part of it was over its bounds, is
 *  kept as a note for the owner in Kitchen ("What the record can't settle goes to the owner"). Case,
 *  spacing and quotes are set aside, and an address is read decoded. */

import type { BrowserFlowStep, BrowserPlanCall } from './browser-flow-record.js';

/** The kinds of judgement (D-402 §6.1). */
export const BROWSER_JOB_JUDGEMENT_KINDS = ['pick', 'extract', 'write', 'decide'] as const;
export type BrowserJobJudgementKind = typeof BROWSER_JOB_JUDGEMENT_KINDS[number];

export interface BrowserJobLabels {
  /** The recipe's name. */
  title?: string;
  /** Values the owner gave the app in their request: each becomes a setting asked for at each run. */
  inputs: Array<{ name: string; value: string; label?: string }>;
  /** Values the app read in this job and then used. */
  reads: Array<{ value: string; name?: string }>;
  /** Where the app used judgement: what it chose (the element's text, the text it typed, the option
   *  it picked, or the value it got), and the criterion, in one sentence. */
  judgements: Array<{ kind: BrowserJobJudgementKind; chose?: string; criterion: string }>;
  /** The values the app's answer gave. */
  answer: Array<{ name: string; value: string }>;
}

export const BROWSER_JOB_MAX_LABELS = 50;
export const BROWSER_JOB_LABEL_MAX_CHARS = 500;
const NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/u;

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** The labels as the app sent them, or why they cannot be read. Every list is optional. */
export const parseBrowserJobLabels = (raw: unknown): { labels: BrowserJobLabels } | { refusals: string[] } => {
  if (raw !== undefined && !record(raw)) return { refusals: ['draft must be an object.'] };
  const draft = raw ?? {};
  const refusals: string[] = [];
  const text = (where: string, value: unknown, required: boolean): string | undefined => {
    if (value === undefined && !required) return undefined;
    if (typeof value !== 'string' || value.trim() === '') { refusals.push(`${where} must be text.`); return undefined; }
    if (value.length > BROWSER_JOB_LABEL_MAX_CHARS) {
      refusals.push(`${where} is over ${BROWSER_JOB_LABEL_MAX_CHARS} characters.`); return undefined;
    }
    return value;
  };
  const list = (key: string): Record<string, unknown>[] => {
    const value = draft[key];
    if (value === undefined) return [];
    if (!Array.isArray(value) || !value.every(record)) { refusals.push(`${key} must be a list of objects.`); return []; }
    if (value.length > BROWSER_JOB_MAX_LABELS) { refusals.push(`${key} has over ${BROWSER_JOB_MAX_LABELS} entries.`); return []; }
    return value;
  };
  const name = (where: string, value: unknown): string | undefined => {
    const named = text(where, value, true);
    if (named !== undefined && !NAME.test(named)) {
      refusals.push(`${where} "${named}" must start with a letter and use only letters, digits and underscores.`);
      return undefined;
    }
    return named;
  };
  const title = text('title', draft.title, false);
  const inputs = list('inputs').map((entry, i) => ({ name: name(`inputs[${i}].name`, entry.name),
    value: text(`inputs[${i}].value`, entry.value, true), label: text(`inputs[${i}].label`, entry.label, false) }));
  const names = inputs.map((input) => input.name).filter((n): n is string => n !== undefined);
  for (const repeated of new Set(names.filter((n, i) => names.indexOf(n) !== i))) {
    refusals.push(`inputs name "${repeated}" more than once.`);
  }
  const reads = list('reads').map((entry, i) => ({ value: text(`reads[${i}].value`, entry.value, true),
    name: text(`reads[${i}].name`, entry.name, false) }));
  const judgements = list('judgements').map((entry, i) => {
    const kind = entry.kind;
    if (typeof kind !== 'string' || !(BROWSER_JOB_JUDGEMENT_KINDS as readonly string[]).includes(kind)) {
      refusals.push(`judgements[${i}].kind must be one of ${BROWSER_JOB_JUDGEMENT_KINDS.join(', ')}.`);
    }
    return { kind: kind as BrowserJobJudgementKind, chose: text(`judgements[${i}].chose`, entry.chose, kind !== 'decide'),
      criterion: text(`judgements[${i}].criterion`, entry.criterion, true) };
  });
  const answer = list('answer').map((entry, i) => ({ name: name(`answer[${i}].name`, entry.name),
    value: text(`answer[${i}].value`, entry.value, true) }));
  if (refusals.length > 0) return { refusals };
  return { labels: {
    ...(title !== undefined ? { title: title.trim() } : {}),
    inputs: inputs.map(({ name: n, value, label }) => ({ name: n!, value: value!, ...(label !== undefined ? { label } : {}) })),
    reads: reads.map(({ value, name: n }) => ({ value: value!, ...(n !== undefined ? { name: n } : {}) })),
    judgements: judgements.map(({ kind, chose, criterion }) => ({ kind, ...(chose !== undefined ? { chose } : {}), criterion: criterion! })),
    answer: answer.map(({ name: n, value }) => ({ name: n!, value: value! })),
  } };
};

/** Set aside case, spacing and quotes. */
const plain = (value: string): string => value.normalize('NFKC').toLowerCase()
  .replace(/["'`‘’“”«»]/gu, '').replace(/\s+/gu, ' ').trim();

/** An address read as a person reads it: its encoding undone. */
const decoded = (url: string): string => {
  try { return decodeURIComponent(url.replace(/\+/gu, ' ')); } catch { return url; }
};

/** Every string inside a value, however deep. */
const strings = (value: unknown, out: string[] = [], depth = 0): string[] => {
  if (depth > 12) return out;
  if (typeof value === 'string') out.push(value);
  else if (typeof value === 'number' || typeof value === 'boolean') out.push(String(value));
  else if (Array.isArray(value)) for (const item of value) strings(item, out, depth + 1);
  else if (record(value)) for (const item of Object.values(value)) strings(item, out, depth + 1);
  return out;
};

const describeStep = (step: BrowserFlowStep, n: number): string => {
  const what = step.do === 'type' ? 'typed into' : step.do === 'pick' ? 'picked in' : step.do === 'press' ? 'pressed a key in'
    : step.do === 'submit' ? 'sent' : 'clicked';
  return `step ${n} (${what} "${step.element.label}" on ${step.title || step.url})`;
};

export interface BrowserJobLabelCheck {
  /** Claims the record contradicts, each with its reason. */
  refusals: string[];
  /** What the owner reads in Kitchen: each label as the app gave it, and the claims the record could not settle. */
  notes: string[];
}

export const checkBrowserJobLabels = (labels: BrowserJobLabels, plan: {
  steps: readonly BrowserFlowStep[]; calls: readonly BrowserPlanCall[];
}): BrowserJobLabelCheck => {
  const refusals: string[] = [];
  const notes: string[] = [];
  // What the job did: typed and picked values, addresses, the calls' own arguments.
  const did = [
    ...plan.steps.flatMap((step) => [step.value, step.pick, decoded(step.url)].filter((v): v is string => typeof v === 'string')),
    ...plan.calls.flatMap((call) => strings(call.args).map(decoded)),
  ].map(plain);
  // What Recued returned in the job.
  const returned = plan.calls.flatMap((call) => strings(call.results)).map(plain);
  const argsShort = plan.calls.some((call) => call.args_dropped === true);
  const resultsShort = plan.calls.some((call) => call.results_dropped === true);
  const found = (haystack: readonly string[], value: string): boolean => {
    const needle = plain(value);
    return needle !== '' && haystack.some((text) => text.includes(needle));
  };

  for (const input of labels.inputs) {
    if (found(did, input.value)) {
      notes.push(`The app says "${input.value}" came from your request: asked for at each run as ${input.label ?? input.name}.`);
    } else if (argsShort) {
      notes.push(`The app says "${input.value}" came from your request, but part of the job's record was too large to keep, so Recued could not check it.`);
    } else {
      refusals.push(`inputs: "${input.value}" (${input.name}) is not in anything this job typed, picked, opened or sent.`);
    }
  }
  for (const [kind, entries] of [['reads', labels.reads], ['answer', labels.answer]] as const) {
    for (const entry of entries) {
      const name = 'name' in entry && entry.name !== undefined ? ` (${entry.name})` : '';
      if (found(returned, entry.value)) {
        notes.push(kind === 'reads'
          ? `The app read "${entry.value}"${name} in the job and used it.`
          : `The app's answer gave "${entry.value}"${name}.`);
      } else if (resultsShort) {
        notes.push(`The app says it ${kind === 'reads' ? 'read' : 'answered with'} "${entry.value}"${name}, but part of what the job read was too large to keep, so Recued could not check it.`);
      } else {
        refusals.push(`${kind}: "${entry.value}"${name} is not in anything Recued returned in this job.`);
      }
    }
  }
  labels.judgements.forEach((judgement) => {
    if (judgement.chose === undefined) {
      notes.push(`The app decided which way to go (${judgement.kind}): ${judgement.criterion}`);
      return;
    }
    const needle = plain(judgement.chose);
    // The step whose element, typed text or picked option holds what it chose, or is held in it
    // (an element's whole text read back in part); a label under 3 characters only as a whole.
    const at = needle === '' ? -1 : plan.steps.findIndex((step) => [step.element.label, step.value, step.pick]
      .some((text) => {
        if (typeof text !== 'string') return false;
        const shown = plain(text);
        return shown !== '' && (shown.includes(needle) || (shown.length >= 3 && needle.includes(shown)));
      }));
    if (at >= 0) {
      notes.push(`The app used judgement at ${describeStep(plan.steps[at]!, at + 1)}, choosing "${judgement.chose}" (${judgement.kind}): ${judgement.criterion}`);
    } else if (found(returned, judgement.chose)) {
      notes.push(`The app used judgement over what it read, choosing "${judgement.chose}" (${judgement.kind}): ${judgement.criterion}`);
    } else if (resultsShort) {
      notes.push(`The app says it chose "${judgement.chose}" (${judgement.kind}), but part of the job's record was too large to keep, so Recued could not check it: ${judgement.criterion}`);
    } else {
      refusals.push(`judgements: "${judgement.chose}" is not anything this job acted on or read.`);
    }
  });
  return { refusals, notes };
};
