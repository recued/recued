/** D-335 slice W2 — the browser steps of the owner's chat, by the turn whose run did them.
 *
 *  Each type, pick, click, press or send the toolkit does on a page names the element it acted on
 *  (`acted_on`, Bridge 0.0.8): the page's address and title, the element as an ask names it, and a
 *  selector that finds it again another day. The DOM adapter records each under its run; the
 *  execute handler says which chat turn a run belongs to, so a resumed run (one held for approval)
 *  files under the turn that asked for it. The "Worth remembering?" offer reads a turn's steps, and
 *  the owner's "That was right" keeps them (W3).
 *
 *  D-402 slice A1 — and the CALLS a request made, which a recipe is compiled from (D-402 §3.1):
 *  each run bound to the request, by the recipe it ran, its arguments, how it ended, the browsers
 *  its outputs came from (D-349's routing stamps `bridge_id` on them), and its steps' results, so
 *  the reads a job used are not lost (34 of the benchmark's 54 correct runs only read). Every call,
 *  not only the Browser Toolkit's: a job uses other tools too (task K read its PDF with
 *  `document.read`, which runs an internal recipe).
 *
 *  In memory, and only for an hour: nothing outlives the process that the owner did not choose to
 *  keep. What was typed into a field for a password, a sign-in code or a card is never recorded:
 *  its step says only that it is secret (and the kind the step named, A1). A call's arguments are
 *  kept without anything typed, and every typed value is taken out of its results too: the steps
 *  above are where typed text lives, under W2's rule. */

import { CHAT_BROWSER_PLAN_HOLD_MS, type ExecutionBrowserFlowStep } from '@recued/contracts';

/** A step, as the contracts name it for the owner's Learning page. */
export type BrowserFlowStep = ExecutionBrowserFlowStep;
export type BrowserFlowStepKind = BrowserFlowStep['do'];

/** What a run is bound to: the owner's chat turn, or (D-402 slice A2) an AI app's job, which
 *  binds as a session of its own whose one turn is the job. */
export interface BrowserFlowTurn {
  session_id: string;
  turn_id: string;
}

/** D-402 slice A1 — one call a request made, as the plan records it. */
export interface BrowserPlanCall {
  run_id: string;
  /** The recipe the call ran: a toolkit recipe, an internal one such as the document reader, any. */
  recipe_id: string;
  /** D-402 slice B3 — the ops its steps run, in order: which reader a document was read with. */
  ops?: string[];
  /** Its arguments as dispatched, with every typed value taken out (`typed: true` marks where one
   *  was); absent when they were over {@link BROWSER_PLAN_MAX_ARGS_BYTES}. */
  args?: Record<string, unknown>;
  args_dropped?: true;
  started_at: number;
  finished_at?: number;
  /** How the run ended: done, failed, or held for approval. Absent while it is going, and for a run
   *  that threw before it could answer. */
  outcome?: 'done' | 'failed' | 'held';
  error_code?: string;
  /** The browsers its outputs came from, in the order first seen. */
  bridge_ids: string[];
  /** Each step's result, bounded; taken back (`results_dropped`) when the plan's
   *  {@link BROWSER_PLAN_MAX_RESULT_BYTES} are spent, oldest call first. */
  results?: Array<{ step_id: string; result: unknown }>;
  results_dropped?: true;
  /** D-402 slice B2 — each read's cleaned HTML, as the Bridge answered it, in order: what a selector is
   *  worked out from once the page has moved on (§4, rules 3 and 7). Taken back (`reads_dropped`)
   *  past {@link BROWSER_PLAN_MAX_READ_BYTES}, oldest call first. */
  reads?: BrowserPlanRead[];
  reads_dropped?: true;
}

/** D-402 slice B2 — one read's cleaned HTML, and the page it was of. */
export interface BrowserPlanRead {
  /** The page handle it was read from, when the Bridge named one. */
  page?: string;
  url: string;
  html: string;
}

/** D-402 slice B1 — a step a call acted on, and where it sat in the call: the step's number in an Act
 *  batch, 1 for a call that does one action. */
export type BrowserPlanActedStep = BrowserFlowStep & { position?: number };

/** D-402 slice B1 — a call with the steps it acted on, in order: what the compiler reads. */
export interface BrowserPlanCallWithSteps extends BrowserPlanCall {
  acted: BrowserPlanActedStep[];
}

export interface BrowserFlowRecorder {
  /** The chat turn (or job) a run belongs to. A run bound to none records nothing. */
  bindRun(run_id: string, turn: BrowserFlowTurn): void;
  /** One step a run did; `position` is where it sat in its call (slice B1). */
  record(run_id: string, step: Omit<BrowserFlowStep, 'at'>, position?: number): void;
  /** D-402 slice A1 — a bound run started: the recipe it runs and its arguments. `browser` says the
   *  recipe acts in a browser (a `core.dom.*` step), whose typed values are taken out of its
   *  arguments; another recipe's arguments are kept as given. A run resumed after an approval
   *  starts again under the same id and keeps its call. */
  startCall(run_id: string, call: { recipe_id: string; args: Record<string, unknown>; browser?: boolean; ops?: string[] }): void;
  /** D-402 slice B2 — a page the run read, as the Bridge's cleaned HTML. */
  recordRead(run_id: string, read: BrowserPlanRead): void;
  /** D-402 slice A1 — how a bound run ended, and its steps' results. */
  finishCall(run_id: string, finish: {
    outcome: 'done' | 'failed' | 'held';
    error_code?: string;
    steps?: ReadonlyArray<{ id: string; result: unknown }>;
  }): void;
  /** The steps of the session's turns that `inTurn` accepts, in the order they were done. */
  stepsFor(session_id: string, inTurn: (turn_id: string) => boolean): BrowserFlowStep[];
  /** D-402 slice A1 — the calls of the session's turns that `inTurn` accepts, in the order made. */
  callsFor(session_id: string, inTurn: (turn_id: string) => boolean): BrowserPlanCall[];
  /** D-402 slice B1 — those calls, each with the steps it acted on: the plan the compiler reads. */
  planFor(session_id: string, inTurn: (turn_id: string) => boolean): BrowserPlanCallWithSteps[];
  /** Forget the steps and calls of those turns (kept, or answered otherwise). */
  forget(session_id: string, inTurn: (turn_id: string) => boolean): void;
  /** D-402 slice A5 — keep a session's steps and calls past the hour, until `until` (an AI app's
   *  job waiting for the owner to answer its draft request); `undefined` lets them go by the hour
   *  again. Bounded by the caller's own hold. */
  keep(session_id: string, until: number | undefined): void;
}

/** How long steps nobody kept are held: the hour the chat offers "Make a recipe" for. */
export const BROWSER_FLOW_HOLD_MS = CHAT_BROWSER_PLAN_HOLD_MS;
/** The most steps held for one session: a long session drops its oldest first. */
export const BROWSER_FLOW_MAX_STEPS = 200;
/** D-402 slice A1 — the most calls held for one session or job, oldest dropped first. */
export const BROWSER_PLAN_MAX_CALLS = 200;
/** D-402 slice A1 — the results (page text, HTML, tables) one session or job keeps, in bytes of
 *  JSON. Past it the oldest calls' results go; the calls themselves stay. */
export const BROWSER_PLAN_MAX_RESULT_BYTES = 1_000_000;
/** D-402 slice A1 — one call's arguments, in bytes of JSON. */
export const BROWSER_PLAN_MAX_ARGS_BYTES = 64_000;
/** D-402 slice B2 — the page HTML one session or job keeps: a budget of its own beside the results',
 *  so a long page does not take the results with it. Past it the oldest calls' reads go. */
export const BROWSER_PLAN_MAX_READ_BYTES = 2_000_000;

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const bytesOf = (value: unknown): number => {
  try { return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8'); } catch { return Number.POSITIVE_INFINITY; }
};

/** D-402 slice A1 — whether a recipe acts in a browser: a `core.dom.*` step, or one stored lowered
 *  to its `dom-*` ingredient (an installed recipe keeps the ingredient, not the op). */
export const recipeActsInBrowser = (recipe: { steps?: unknown; prefetch_steps?: unknown }): boolean =>
  [recipe.prefetch_steps, recipe.steps].some((list) => Array.isArray(list) && list.some((step) => record(step)
    && ((typeof step.op === 'string' && step.op.startsWith('core.dom.'))
      || (typeof step.ingredient === 'string' && step.ingredient.startsWith('dom-')))));

/** A call's arguments without anything typed: a top-level `value` (Type into a web page) and each
 *  step's `value` (Act on a web page), taken out and marked `typed: true`. The typed values are
 *  returned so the call's results can be cleared of them too. A `steps` list sent as text is read
 *  as JSON; one that isn't is dropped, since it may hold typed text. */
export const browserPlanArgs = (args: Record<string, unknown>): {
  args: Record<string, unknown>; typed: string[];
} => {
  const typed: string[] = [];
  const strip = (value: Record<string, unknown>): Record<string, unknown> => {
    if (!Object.prototype.hasOwnProperty.call(value, 'value')) return value;
    const { value: given, ...rest } = value;
    if (typeof given === 'string' && given.length > 0) typed.push(given);
    return { ...rest, typed: true };
  };
  const out = strip({ ...args });
  if (Object.prototype.hasOwnProperty.call(out, 'steps')) {
    let steps = out.steps;
    if (typeof steps === 'string') {
      try { steps = JSON.parse(steps) as unknown; } catch { steps = undefined; }
    }
    if (Array.isArray(steps)) out.steps = steps.map((step) => (record(step) ? strip({ ...step }) : step));
    else if (typeof out.steps === 'string') { delete out.steps; out.steps_dropped = true; }
  }
  return { args: out, typed };
};

/** A result with the given typed values replaced, at any depth: what an action answers can repeat
 *  what it typed. Only the values that went into a protected field are given (see `finishCall`):
 *  replacing every typed value would also cut a short one ("3", "large") out of the page's own text. */
const withoutTyped = (value: unknown, typed: readonly string[], depth = 0): unknown => {
  if (typed.length === 0 || depth > 32) return value;
  if (typeof value === 'string') {
    let out = value;
    for (const text of typed) if (out.includes(text)) out = out.split(text).join('[typed]');
    return out;
  }
  if (Array.isArray(value)) return value.map((item) => withoutTyped(item, typed, depth + 1));
  if (record(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, withoutTyped(item, typed, depth + 1)]));
  }
  return value;
};

/** The browser a page handle names (`bridge:<id>:<tab>:<document>`, D-349), without throwing on one
 *  that isn't a handle. */
const browserOfPage = (page: unknown): string | undefined => {
  if (typeof page !== 'string') return undefined;
  const match = /^bridge:([^:]+):\d{1,10}:[\w-]{1,128}$/.exec(page);
  if (!match) return undefined;
  try { return decodeURIComponent(match[1]!); } catch { return undefined; }
};

/** The browsers a result names, in the order met: D-349 stamps a `bridge_id` on each output, and a
 *  recipe whose output map keeps only some fields still keeps its page handles, which name theirs. */
const bridgeIdsOf = (value: unknown, into: string[], depth = 0): void => {
  if (depth > 8 || into.length >= 8) return;
  if (Array.isArray(value)) { for (const item of value.slice(0, 500)) bridgeIdsOf(item, into, depth + 1); return; }
  if (!record(value)) return;
  for (const id of [typeof value.bridge_id === 'string' ? value.bridge_id : undefined, browserOfPage(value.page)]) {
    if (id !== undefined && id !== '' && !into.includes(id) && into.length < 8) into.push(id);
  }
  for (const [key, item] of Object.entries(value)) if (key !== 'bridge_id' && key !== 'page') bridgeIdsOf(item, into, depth + 1);
};

type HeldCall = BrowserPlanCall & { turn_id: string; typed: string[]; result_bytes: number; read_bytes?: number };
type HeldStep = BrowserFlowStep & { turn_id: string; run_id: string; position?: number };

export const createBrowserFlowRecorder = (options: { now?: () => number; holdMs?: number } = {}): BrowserFlowRecorder => {
  const now = options.now ?? Date.now;
  const holdMs = options.holdMs ?? BROWSER_FLOW_HOLD_MS;
  const runs = new Map<string, BrowserFlowTurn & { at: number }>();
  const sessions = new Map<string, HeldStep[]>();
  const plans = new Map<string, HeldCall[]>();
  /** Sessions kept past the hour, until when (D-402 slice A5). */
  const keeping = new Map<string, number>();
  const sweep = () => {
    const before = now() - holdMs;
    for (const [session, until] of keeping) if (until <= now()) keeping.delete(session);
    for (const [run, bound] of runs) if (bound.at < before && !keeping.has(bound.session_id)) runs.delete(run);
    for (const [session, steps] of sessions) {
      if (keeping.has(session)) continue;
      const fresh = steps.filter((step) => step.at >= before);
      if (fresh.length === 0) sessions.delete(session);
      else if (fresh.length !== steps.length) sessions.set(session, fresh);
    }
    for (const [session, calls] of plans) {
      if (keeping.has(session)) continue;
      const fresh = calls.filter((call) => (call.finished_at ?? call.started_at) >= before);
      if (fresh.length === 0) plans.delete(session);
      else if (fresh.length !== calls.length) plans.set(session, fresh);
    }
  };
  /** The plan's results kept within its byte budget, oldest calls' results going first. */
  const withinBudget = (calls: HeldCall[]) => {
    let total = calls.reduce((sum, call) => sum + call.result_bytes, 0);
    for (const call of calls) {
      if (total <= BROWSER_PLAN_MAX_RESULT_BYTES) break;
      if (call.results === undefined) continue;
      total -= call.result_bytes;
      delete call.results;
      call.result_bytes = 0;
      call.results_dropped = true;
    }
  };
  /** D-402 slice B2 — the plan's reads kept within their own budget, oldest calls' reads going first. */
  const readsWithinBudget = (calls: HeldCall[]) => {
    let total = calls.reduce((sum, call) => sum + (call.read_bytes ?? 0), 0);
    for (const call of calls) {
      if (total <= BROWSER_PLAN_MAX_READ_BYTES) break;
      if (call.reads === undefined) continue;
      total -= call.read_bytes ?? 0;
      delete call.reads;
      call.read_bytes = 0;
      call.reads_dropped = true;
    }
  };
  const copy = ({ turn_id: _turn, typed: _typed, result_bytes: _bytes, read_bytes: _reads, ...call }: HeldCall): BrowserPlanCall =>
    structuredClone(call);
  const callOf = (run_id: string): HeldCall | undefined => {
    const bound = runs.get(run_id);
    if (bound === undefined) return undefined;
    return plans.get(bound.session_id)?.find((call) => call.run_id === run_id);
  };
  return {
    bindRun(run_id, turn) {
      sweep();
      runs.set(run_id, { session_id: turn.session_id, turn_id: turn.turn_id, at: now() });
    },
    record(run_id, step, position) {
      const bound = runs.get(run_id);
      if (bound === undefined) return;
      const steps = sessions.get(bound.session_id) ?? [];
      steps.push({ ...step, at: now(), turn_id: bound.turn_id, run_id, ...(position !== undefined ? { position } : {}) });
      sessions.set(bound.session_id, steps.slice(-BROWSER_FLOW_MAX_STEPS));
    },
    startCall(run_id, call) {
      const bound = runs.get(run_id);
      if (bound === undefined || callOf(run_id) !== undefined) return;
      const { args, typed } = call.browser === true ? browserPlanArgs(call.args) : { args: { ...call.args }, typed: [] };
      const fits = bytesOf(args) <= BROWSER_PLAN_MAX_ARGS_BYTES;
      const calls = plans.get(bound.session_id) ?? [];
      calls.push({
        run_id, recipe_id: call.recipe_id, ...(call.ops !== undefined && call.ops.length > 0 ? { ops: call.ops.slice(0, 20) } : {}),
        ...(fits ? { args } : { args_dropped: true as const }),
        started_at: now(), bridge_ids: [], turn_id: bound.turn_id, typed, result_bytes: 0,
      });
      plans.set(bound.session_id, calls.slice(-BROWSER_PLAN_MAX_CALLS));
    },
    recordRead(run_id, read) {
      const call = callOf(run_id);
      if (call === undefined || read.html === '' || read.url === '') return;
      const bytes = Buffer.byteLength(read.html, 'utf8');
      if (bytes > BROWSER_PLAN_MAX_READ_BYTES) { call.reads_dropped = true; return; }
      (call.reads ??= []).push({ ...(read.page !== undefined ? { page: read.page } : {}), url: read.url, html: read.html });
      call.read_bytes = (call.read_bytes ?? 0) + bytes;
      const bound = runs.get(run_id);
      if (bound !== undefined) readsWithinBudget(plans.get(bound.session_id) ?? []);
    },
    finishCall(run_id, finish) {
      const call = callOf(run_id);
      if (call === undefined) return;
      call.finished_at = now();
      call.outcome = finish.outcome;
      if (finish.error_code !== undefined) call.error_code = finish.error_code;
      else delete call.error_code;
      if (finish.steps !== undefined) {
        // What went into a protected field: a typed value no step of this run kept, since W2 keeps
        // every other one with its step. A step whose element was never described (an older Bridge,
        // a step that failed) counts too: kept out when unsure.
        const bound = runs.get(run_id);
        const kept = new Set((bound === undefined ? [] : sessions.get(bound.session_id) ?? [])
          .filter((step) => step.run_id === run_id && typeof step.value === 'string').map((step) => step.value!));
        const unkept = call.typed.filter((text) => !kept.has(text));
        const results = finish.steps
          .filter((step) => step.result !== undefined && step.result !== null)
          .map((step) => ({ step_id: step.id, result: withoutTyped(step.result, unkept) }));
        for (const step of results) bridgeIdsOf(step.result, call.bridge_ids);
        // What went into a protected field never stays in a read either.
        if (call.reads !== undefined && unkept.length > 0) {
          call.reads = call.reads.map((read) => ({ ...read, html: withoutTyped(read.html, unkept) as string }));
        }
        const bytes = bytesOf(results);
        delete call.results_dropped;
        if (results.length > 0 && bytes <= BROWSER_PLAN_MAX_RESULT_BYTES) {
          call.results = results;
          call.result_bytes = bytes;
        } else {
          delete call.results;
          call.result_bytes = 0;
          if (results.length > 0) call.results_dropped = true;
        }
        if (bound !== undefined) withinBudget(plans.get(bound.session_id) ?? []);
      }
      // A finished run's typed values are no longer needed; a resume starts the call again.
      if (finish.outcome !== 'held') call.typed = [];
    },
    stepsFor(session_id, inTurn) {
      sweep();
      return (sessions.get(session_id) ?? []).filter((step) => inTurn(step.turn_id))
        .map(({ turn_id: _turn, run_id: _run, position: _position, ...step }) => step);
    },
    planFor(session_id, inTurn) {
      sweep();
      const steps = (sessions.get(session_id) ?? []).filter((step) => inTurn(step.turn_id));
      return (plans.get(session_id) ?? []).filter((call) => inTurn(call.turn_id)).map((call) => ({
        ...copy(call),
        acted: steps.filter((step) => step.run_id === call.run_id)
          .map(({ turn_id: _turn, run_id: _run, ...step }) => structuredClone(step)),
      }));
    },
    callsFor(session_id, inTurn) {
      sweep();
      return (plans.get(session_id) ?? []).filter((call) => inTurn(call.turn_id)).map(copy);
    },
    forget(session_id, inTurn) {
      const steps = sessions.get(session_id);
      if (steps !== undefined) {
        const left = steps.filter((step) => !inTurn(step.turn_id));
        if (left.length === 0) sessions.delete(session_id);
        else sessions.set(session_id, left);
      }
      const calls = plans.get(session_id);
      if (calls !== undefined) {
        const left = calls.filter((call) => !inTurn(call.turn_id));
        if (left.length === 0) plans.delete(session_id);
        else plans.set(session_id, left);
      }
    },
    keep(session_id, until) {
      if (until === undefined) keeping.delete(session_id);
      else keeping.set(session_id, until);
    },
  };
};

/** The process's recorder, as the page read store is the process's: one server, one owner. */
export const browserFlows: BrowserFlowRecorder = createBrowserFlowRecorder();
