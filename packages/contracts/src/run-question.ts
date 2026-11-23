/** D-402 slice F3 (§7.4, §7.5) — the question before a run: one question about the whole run, asked
 *  before step 1 of a recipe whose steps would ask the owner where an approval ahead can stand in,
 *  started by the owner's chat or an AI app.
 *
 *  > Run "File the water bill"?
 *  > Without asking, it will: act in your browser on water.example.com · send an email to
 *  > accounts@example.com · write a file to Bills/
 *  > It will still ask before: moving a file
 *  > Its AI decides what it writes. What it reads goes to your AI models.
 *  > Also: saves 1 downloaded file to your files
 *
 *  In this order: what the answer covers (the decision), what will still ask (so it is not the last
 *  question), what the AI decides, then the rest. Counts only where the recipe fixes them, else the
 *  bound. Where things go when a setting decides it. Steps that never ask are not presented as
 *  allowed: they run whatever the answer, short of No, so they go under "Also", and only when they
 *  leave something behind. The owner's words throughout: sites by their host, writes as D-341's page
 *  names them, never an op name, a slug or a risk tier.
 *
 *  Pure: no I/O, no clock. */

import {
  readPreapprovalBrowsers, readPreapprovalCaller, readPreapprovalNested, type PreapprovalBrowsers, type PreapprovalCaller, type PreapprovalNested,
} from './trigger-preapproval.js';

/** The ask's handler kind. */
export const RUN_QUESTION_ASK_KIND = 'run_question';

/** The four answers. ⚠ Ids stay within 23 bytes: Telegram carries `ask-<uuid>|<option>` in a 64-byte
 *  callback. Labels stay within Slack's 75 characters. */
export const RUN_QUESTION_ONCE = 'run_once';
export const RUN_QUESTION_ALWAYS = 'run_always';
export const RUN_QUESTION_EACH_STEP = 'run_each_step';
export const RUN_QUESTION_NO = 'run_no';
export type RunQuestionAnswer = typeof RUN_QUESTION_ONCE | typeof RUN_QUESTION_ALWAYS | typeof RUN_QUESTION_EACH_STEP
  | typeof RUN_QUESTION_NO;

export const isRunQuestionAnswer = (value: unknown): value is RunQuestionAnswer =>
  value === RUN_QUESTION_ONCE || value === RUN_QUESTION_ALWAYS || value === RUN_QUESTION_EACH_STEP || value === RUN_QUESTION_NO;

/** The answers, in the order they are offered. "Always" only where the caller may hold one (D-402
 *  ruling 4: an AI app's comes with the revoke that takes it back). */
export const runQuestionOptions = (always: boolean, runs = 1, eachStep = true): ReadonlyArray<{ readonly id: RunQuestionAnswer; readonly label: string }> => [
  { id: RUN_QUESTION_ONCE, label: runs > 1 ? 'Yes, these times' : 'Yes, this time' },
  ...(always ? [{ id: RUN_QUESTION_ALWAYS, label: 'Always, for this recipe' } as const] : []),
  // D-402 ruling 17 — not for a run whose inner recipes would ask: an inner run cannot stop to ask.
  ...(eachStep ? [{ id: RUN_QUESTION_EACH_STEP, label: 'Ask me at each step' } as const] : []),
  { id: RUN_QUESTION_NO, label: 'No' },
];

/** One thing the run does, in the owner's words. */
export interface RunQuestionWrite {
  /** What it does: "Send an email", "Act in your browser". */
  readonly label: string;
  /** Where it goes, when the recipe or a setting decides it, with its preposition: "on
   *  water.example.com", "to accounts@example.com", "to Bills/". */
  readonly where?: string;
  /** How many times: a number the recipe fixes, or the bound it never goes past ("up to 20"). */
  readonly times?: { readonly exactly: number } | { readonly up_to: number };
}

/** A write that asks every time, and why, in the owner's words (`RECIPE_STILL_ASKS_SAID`). */
export interface RunQuestionStill extends RunQuestionWrite {
  readonly reason: string;
}

/** D-402 slice H4a (§7.5) — what a run does in one of its browsers, for a recipe that uses several: the
 *  browser by the owner's name, the sites it reads there, and the sites it acts on there. */
export interface RunQuestionBrowser {
  readonly name: string;
  readonly reads: readonly string[];
  readonly acts: readonly string[];
}

export interface RunQuestion {
  /** The recipe's own name. */
  readonly recipe_name: string;
  /** Runs of it this one question is for (D-402 ruling 13): one, or several in one chat round. */
  readonly runs: number;
  /** What the answer lets happen without asking. */
  readonly covers: readonly RunQuestionWrite[];
  /** What still asks, whatever the answer. */
  readonly still: readonly RunQuestionStill[];
  /** Its AI steps decide what it writes (D-341 ruling 8). */
  readonly ai: boolean;
  /** Each kind of secret a browser step types: asked for at its step when Recued holds none. */
  readonly secrets: readonly string[];
  /** How many of its steps save a file the run downloads to the owner's files. */
  readonly saves_files: number;
  /** Who asked for the run: the owner's chat, or an AI app by its name. */
  readonly asked_by: { readonly kind: 'owner_chat' } | { readonly kind: 'ai_app'; readonly name: string };
  /** D-402 slice H4a — for a recipe that uses several browsers, what it does in each, in the order it gets
   *  there. Its reads are said too, since they say what crosses from one browser to another. */
  readonly browsers?: readonly RunQuestionBrowser[];
  /** D-402 ruling 17 — the recipes it runs (D-232), by name: the answer covers their writes too. */
  readonly runs_also?: readonly string[];
}

/** "In Work it reads shop.example.com. What it reads in Work is used in Personal." Said only for a recipe
 *  that uses several browsers, after what it does without asking, whose lines already name the browser
 *  each action is in ("act in Personal on crm.example.com"): what it reads where, and what crosses. */
const browsersSaid = (browsers: readonly RunQuestionBrowser[] | undefined): string => {
  if (browsers === undefined || browsers.length < 2) return '';
  const each = browsers.filter((browser) => browser.reads.length > 0)
    .map((browser) => `In ${browser.name} it reads ${browser.reads.join(', ')}.`);
  // What crosses: each browser it reads in, to each later one it acts in.
  const crosses: string[] = [];
  browsers.forEach((reader, index) => {
    if (reader.reads.length === 0) return;
    for (const actor of browsers.slice(index + 1)) {
      const line = `What it reads in ${reader.name} is used in ${actor.name}.`;
      if (actor.acts.length > 0 && actor.name !== reader.name && !crosses.includes(line)) crosses.push(line);
    }
  });
  return each.length + crosses.length === 0 ? '' : ` ${[...each, ...crosses].join(' ')}`;
};

/** A line set mid-sentence: a sentence's capital lowered. */
const lower = (label: string): string => (/^[A-Z][a-z]/u.test(label) ? `${label[0]!.toLowerCase()}${label.slice(1)}` : label);

/** "send an email to accounts@example.com, up to 3 times". */
export const runQuestionLine = (write: RunQuestionWrite): string => {
  const times = write.times === undefined ? ''
    : 'exactly' in write.times ? (write.times.exactly === 1 ? '' : `, ${String(write.times.exactly)} times`)
      : `, up to ${String(write.times.up_to)} times`;
  const where = write.where === undefined || write.where === '' ? '' : ` ${write.where}`;
  return `${lower(write.label)}${where}${times}`;
};

/** The question's title: "Run “File the water bill”?"; "Run “File the water bill” 3 times?". */
export const runQuestionTitle = (question: Pick<RunQuestion, 'recipe_name' | 'runs'>): string =>
  `Run “${question.recipe_name}”${question.runs > 1 ? ` ${String(question.runs)} times` : ''}?`;

/** “A”; “A” and “B”; “A”, “B” and “C”. */
const namesSaid = (names: readonly string[]): string => {
  const quoted = names.map((name) => `“${name}”`);
  return quoted.length <= 1 ? quoted.join('') : `${quoted.slice(0, -1).join(', ')} and ${quoted[quoted.length - 1]!}`;
};

/** Its first block, which a messenger shows beside the buttons: who asked, the recipes it runs (D-402
 *  ruling 17: the answer covers them too), and what the answer lets happen without asking. */
export const runQuestionFirstBlock = (question: RunQuestion): string => {
  const who = question.asked_by.kind === 'ai_app' ? `${question.asked_by.name} asks to run it.` : 'Your chat asks to run it.';
  const runs = question.runs_also === undefined || question.runs_also.length === 0 ? ''
    : ` It also runs ${namesSaid(question.runs_also)}.`;
  const covers = question.covers.length === 0 ? '' : ` Without asking, it will: ${question.covers.map(runQuestionLine).join('; ')}.`;
  return `${who}${runs}${covers}${browsersSaid(question.browsers)}`;
};

/** The whole question, in §7.5's order, as the app shows it. */
export const runQuestionText = (question: RunQuestion): string => {
  const parts = [runQuestionFirstBlock(question)];
  if (question.still.length > 0) {
    // Why each still asks is the full list's ("Show all steps"); the question names them, as §7.4 does.
    parts.push(`It will still ask before: ${question.still.map(runQuestionLine).join('; ')}.`);
  }
  if (question.secrets.length > 0) {
    parts.push(`It will ask for your ${question.secrets.join(' and ')} at its step, unless Recued already holds it.`);
  }
  if (question.ai) parts.push('Its AI decides what it writes. What it reads goes to your AI models.');
  if (question.saves_files > 0) {
    parts.push(`Also: saves ${question.saves_files === 1 ? '1 downloaded file' : `${String(question.saves_files)} downloaded files`} to your files.`);
  }
  return parts.join('\n\n');
};

/** D-402 slice F3 — what a run held before step 1 keeps on its checkpoint (`Checkpoint.run_question`):
 *  the question it asked, who asked for the run, the recipe version an answer grants for, and whether
 *  "Always" was offered. The answer is checked against it: an option the ask never offered does
 *  nothing. */
export interface RunQuestionHold {
  readonly question: RunQuestion;
  readonly caller: PreapprovalCaller;
  readonly recipe_sha256: string;
  readonly always: boolean;
  /** D-402 slice H4 — the browsers the run's settings named when it was asked: what an answer's
   *  pre-approval holds each site's writes to. */
  readonly browsers?: PreapprovalBrowsers;
  /** D-402 ruling 17 — the recipes the run starts, at the versions the question saw: an answer's
   *  pre-approval covers their writes at these versions. */
  readonly nested?: PreapprovalNested;
  /** D-402 ruling 17 — false when "Ask me at each step" was not offered: the run's inner recipes would
   *  ask, and an inner run cannot stop to. */
  readonly each_step?: false;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = (value: unknown, max = 2_000): value is string => typeof value === 'string' && value.length > 0 && value.length <= max;

const readWrite = (value: unknown): RunQuestionWrite | undefined => {
  if (!isRecord(value) || !isText(value.label, 300)) return undefined;
  if (value.where !== undefined && !isText(value.where, 500)) return undefined;
  const times = value.times;
  if (times !== undefined && !(isRecord(times) && ((Number.isSafeInteger(times.exactly) && (times.exactly as number) >= 1)
    || (Number.isSafeInteger(times.up_to) && (times.up_to as number) >= 1)))) return undefined;
  return {
    label: value.label,
    ...(value.where !== undefined ? { where: value.where as string } : {}),
    ...(times !== undefined ? { times: Number.isSafeInteger((times as Record<string, unknown>).exactly)
      ? { exactly: (times as Record<string, number>).exactly! } : { up_to: (times as Record<string, number>).up_to! } } : {}),
  };
};

/** A persisted hold read back, or undefined: one this version cannot read holds nothing it can answer. */
export const readRunQuestionHold = (value: unknown): RunQuestionHold | undefined => {
  if (!isRecord(value) || !isRecord(value.question) || typeof value.always !== 'boolean'
    || typeof value.recipe_sha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(value.recipe_sha256)) return undefined;
  const caller = readPreapprovalCaller(value.caller);
  const q = value.question;
  if (caller === undefined || !isText(q.recipe_name, 300) || !Number.isSafeInteger(q.runs) || (q.runs as number) < 1
    || !Array.isArray(q.covers) || !Array.isArray(q.still) || typeof q.ai !== 'boolean' || !Array.isArray(q.secrets)
    || !q.secrets.every((secret) => isText(secret, 40)) || !Number.isSafeInteger(q.saves_files) || (q.saves_files as number) < 0
    || !isRecord(q.asked_by)) return undefined;
  const covers = q.covers.map(readWrite);
  const still = q.still.map((write) => {
    const read = readWrite(write);
    return read !== undefined && isRecord(write) && isText(write.reason, 300) ? { ...read, reason: write.reason } : undefined;
  });
  if (covers.some((write) => write === undefined) || still.some((write) => write === undefined)) return undefined;
  const asked_by = q.asked_by.kind === 'owner_chat' ? { kind: 'owner_chat' as const }
    : q.asked_by.kind === 'ai_app' && isText(q.asked_by.name, 200) ? { kind: 'ai_app' as const, name: q.asked_by.name } : undefined;
  if (asked_by === undefined) return undefined;
  const sites = (value: unknown): value is string[] => Array.isArray(value) && value.length <= 50 && value.every((site) => isText(site, 300));
  const questionBrowsers = q.browsers === undefined ? undefined
    : Array.isArray(q.browsers) && q.browsers.length <= 20 && q.browsers.every((one) => isRecord(one) && isText(one.name, 200)
      && sites(one.reads) && sites(one.acts))
      ? (q.browsers as Array<Record<string, unknown>>).map((one) => ({ name: one.name as string, reads: one.reads as string[], acts: one.acts as string[] }))
      : null;
  if (questionBrowsers === null) return undefined;
  const browsers = value.browsers === undefined ? undefined : readPreapprovalBrowsers(value.browsers);
  if (value.browsers !== undefined && browsers === undefined) return undefined;
  const nested = value.nested === undefined ? undefined : readPreapprovalNested(value.nested);
  if (value.nested !== undefined && nested === undefined) return undefined;
  if (value.each_step !== undefined && value.each_step !== false) return undefined;
  const runsAlso = q.runs_also === undefined ? undefined
    : Array.isArray(q.runs_also) && q.runs_also.length <= 20 && q.runs_also.every((name) => isText(name, 300)) ? q.runs_also as string[] : null;
  if (runsAlso === null) return undefined;
  return {
    question: {
      recipe_name: q.recipe_name, runs: q.runs as number, covers: covers as RunQuestionWrite[], still: still as RunQuestionStill[],
      ai: q.ai, secrets: q.secrets as string[], saves_files: q.saves_files as number, asked_by,
      ...(questionBrowsers !== undefined ? { browsers: questionBrowsers } : {}),
      ...(runsAlso !== undefined ? { runs_also: runsAlso } : {}),
    },
    caller,
    recipe_sha256: value.recipe_sha256,
    always: value.always,
    ...(browsers !== undefined ? { browsers } : {}),
    ...(nested !== undefined ? { nested } : {}),
    ...(value.each_step === false ? { each_step: false as const } : {}),
  };
};
