/** D-402 slice C (2026-11-17) — a trial run of a draft recipe ("Try it" in Kitchen), whose every change
 *  in a web page is asked about at its step, on the live page (§8.1, ruling 8).
 *
 *  The DOM adapter asks just before the change happens: the element described by the Bridge as the
 *  page then names it, the whole text the step types, and the page. The ask takes "Do it" or "Stop the
 *  trial"; the step waits for the answer here, with the batch's tabs and what it has done waiting in
 *  place, at most five minutes. A restart ends the wait, so the asks a restart leaves open are ended
 *  at boot (their steps are gone). In memory, one server, one owner: the process's registry, as the
 *  secrets asks (`browser-secrets.ts`) and the page reads are.
 *
 *  Which runs are trials: the execute handler marks a run while it executes under `recipe.try`'s
 *  override (`InternalExecuteOverrides.trial`), and a held trial's resume marks it again from its
 *  checkpoint. */

import { randomUUID } from 'node:crypto';

import {
  BROWSER_TRIAL_ASK_KIND,
  BROWSER_TRIAL_DO_OPTION,
  BROWSER_TRIAL_MAX_TEXT_CHARS,
  BROWSER_TRIAL_STOP_OPTION,
  BROWSER_TRIAL_WAIT_MS,
  browserPassHostOf,
  browserTrialSentence,
  type BrowserTrialPrompt,
} from '@recued/contracts';

import type { InternalExecuteOverrides } from '../types.js';
import type { BrowserSecretNotifier } from './browser-secrets.js';

/** What records a trial for its saved test, part by part (`recipe-run-capture-store.ts`). */
export type TrialRecorder = NonNullable<InternalExecuteOverrides['regression_capture']>;

/** What a step asks about, before the change it makes. */
export interface BrowserTrialRequest {
  readonly run_id: string;
  readonly prompt: Omit<BrowserTrialPrompt, 'site' | 'expires_at'>;
  /** The run's: a stopped run stops waiting. */
  readonly signal?: AbortSignal;
  /** The run's budget hook: waiting for the owner is no work of the run's. */
  readonly extendBudget?: (ms: number) => void;
}

/** The owner said to do it; or why the step does not happen, in the words of its error. */
export type BrowserTrialAnswer = { readonly done: true } | { readonly refused: string };

export interface BrowserTrialDeps {
  readonly notifier: BrowserSecretNotifier;
  readonly now?: () => number;
  readonly waitMs?: number;
}

export interface BrowserTrials {
  /** Wire the asks. Once, at boot: it also ends the trial asks a restart left open. */
  install(deps: BrowserTrialDeps): Promise<void>;
  /** A run executing as a trial, until `end`. */
  begin(run_id: string): void;
  end(run_id: string): void;
  isTrial(run_id: string | undefined): boolean;
  /** D-402 slice C (§8.3) — the recorder of a trial run's saved test, kept while the run is held so its
   *  resume reports to it too (`preflight-resumer.ts`). In memory: a restart loses it, and the trial's
   *  capture with it. */
  keepRecorder(run_id: string, recorder: TrialRecorder): void;
  recorderOf(run_id: string): TrialRecorder | undefined;
  forgetRecorder(run_id: string): void;
  /** A held trial's run ended at its hold, with nothing of it to run again: the owner declined it, its
   *  approval could no longer act (`preflight-resumer.ts`), or it expired (`checkpoint-retention.ts`).
   *  Its recorder hears, so its saved test settles as none, and is forgotten. */
  endedAtHold(run_id: string): void;
  /** Ask the owner about one change and wait for the answer. */
  ask(request: BrowserTrialRequest): Promise<BrowserTrialAnswer>;
}

interface Waiting {
  readonly settle: (answer: BrowserTrialAnswer) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly signal: AbortSignal | undefined;
  readonly onAbort: () => void;
  ask_id?: string;
}

/** The address a step happens on, as the owner reads it in the ask: whole, but never longer than a line. */
const shownAddress = (url: string): string => url.length <= 300 ? url : `${url.slice(0, 297)}…`;

export const createBrowserTrials = (): BrowserTrials => {
  let deps: BrowserTrialDeps | undefined;
  const runs = new Set<string>();
  const recorders = new Map<string, TrialRecorder>();
  const waiting = new Map<string, Waiting>();
  const now = () => deps?.now?.() ?? Date.now();

  /** End a wait: its ask closes everywhere, unless the owner's answer is what ended it. */
  const finish = (request_id: string, answer: BrowserTrialAnswer, close: boolean): void => {
    const wait = waiting.get(request_id);
    if (wait === undefined) return;
    waiting.delete(request_id);
    clearTimeout(wait.timer);
    wait.signal?.removeEventListener('abort', wait.onAbort);
    if (close && wait.ask_id !== undefined) void deps?.notifier.cancelAsk(wait.ask_id).catch(() => undefined);
    wait.settle(answer);
  };

  return {
    async install(next) {
      deps = next;
      next.notifier.registerAskHandler(BROWSER_TRIAL_ASK_KIND, (payload, answer) => {
        if (typeof payload.request_id !== 'string' || !waiting.has(payload.request_id)) return;
        if (answer.option === BROWSER_TRIAL_DO_OPTION) finish(payload.request_id, { done: true }, false);
        else if (answer.option === BROWSER_TRIAL_STOP_OPTION) {
          finish(payload.request_id, { refused: 'you stopped the trial here, before this step changed anything' }, false);
        }
      });
      for (const ask of await next.notifier.listOpenAsks().catch(() => [])) {
        if (ask.handler_kind === BROWSER_TRIAL_ASK_KIND) await next.notifier.cancelAsk(ask.ask_id).catch(() => undefined);
      }
    },

    begin(run_id) { runs.add(run_id); },
    end(run_id) { runs.delete(run_id); },
    isTrial(run_id) { return run_id !== undefined && runs.has(run_id); },
    keepRecorder(run_id, recorder) { recorders.set(run_id, recorder); },
    recorderOf(run_id) { return recorders.get(run_id); },
    forgetRecorder(run_id) { recorders.delete(run_id); },
    endedAtHold(run_id) {
      const recorder = recorders.get(run_id);
      recorders.delete(run_id);
      // A saved test is a courtesy to the owner: the run's end is already recorded.
      try { recorder?.ended?.(); } catch { /* nothing to undo */ }
    },

    async ask(request) {
      if (deps === undefined) {
        return { refused: 'this trial asks before each change, and Recued cannot ask you here, so nothing was changed' };
      }
      if (request.signal?.aborted === true) return { refused: 'the trial was stopped' };
      const waitMs = deps.waitMs ?? BROWSER_TRIAL_WAIT_MS;
      request.extendBudget?.(waitMs);
      const minutes = Math.round(waitMs / 60_000);
      const how = minutes < 1 ? 'a short while' : minutes === 1 ? 'a minute' : `${minutes} minutes`;
      const request_id = randomUUID();
      const text = request.prompt.text !== undefined && request.prompt.text.length > BROWSER_TRIAL_MAX_TEXT_CHARS
        ? `${request.prompt.text.slice(0, BROWSER_TRIAL_MAX_TEXT_CHARS)}…` : request.prompt.text;
      const prompt: BrowserTrialPrompt = { ...request.prompt, url: shownAddress(request.prompt.url),
        ...(text !== undefined ? { text } : {}), site: browserPassHostOf(request.prompt.url) ?? request.prompt.url,
        expires_at: now() + waitMs };
      const answered = new Promise<BrowserTrialAnswer>((settle) => {
        const timer = setTimeout(() => finish(request_id, { refused: `nobody answered within ${how}, so the trial stopped `
          + 'before this step changed anything' }, true), waitMs);
        timer.unref?.();
        const onAbort = () => finish(request_id, { refused: 'the trial was stopped while it waited for your answer' }, true);
        request.signal?.addEventListener('abort', onAbort, { once: true });
        waiting.set(request_id, { settle, timer, signal: request.signal, onAbort });
      });
      try {
        const { ask_id } = await deps.notifier.ask(
          { title: `Trying your recipe: step ${String(prompt.step)} of ${String(prompt.of)}`,
            text: `${browserTrialSentence(prompt)} This is a trial of a recipe that is not saved yet, so it asks before each `
              + `change. It waits ${how} for your answer.` },
          [{ id: BROWSER_TRIAL_DO_OPTION, label: 'Do it' }, { id: BROWSER_TRIAL_STOP_OPTION, label: 'Stop the trial' }],
          { kind: BROWSER_TRIAL_ASK_KIND, payload: { ...prompt, request_id } },
        );
        const wait = waiting.get(request_id);
        if (wait === undefined) void deps.notifier.cancelAsk(ask_id).catch(() => undefined);
        else wait.ask_id = ask_id;
      } catch {
        finish(request_id, { refused: 'Recued could not ask you about this step, so nothing was changed' }, false);
      }
      return answered;
    },
  };
};

/** The process's: the server installs it at boot, once the notification block is up. */
export const browserTrials: BrowserTrials = createBrowserTrials();
