/** D-266 — `Ask me` as a REAL ask.
 *
 *  The Automation card alone reaches only an owner who opens the page.
 *  Raising the same question through the notification block gets channel
 *  routing, the passive notice on surfaces that do not carry asks, and —
 *  by construction rather than by a suppression rule — exactly ONE
 *  message per channel. A separate "wake notification" beside the ask
 *  would have been a second message in the same chat conversation.
 *
 *  ⛔ ONE OPEN ASK AT A TIME, WHICH IS WHAT "ONE ASK PER WAKE" MEANS IN
 *  CODE. The tick runs every minute and the misses stay outstanding until
 *  answered, so raising per tick would produce a prompt a minute. While
 *  an ask of this kind is open, `project` raises nothing; once it is
 *  answered or cancelled, the next tick covers whatever is still waiting.
 *
 *  ⚠ AND THE ASK CAN OUTLIVE ITS CONDITION, WHICH IS THE FAILURE THIS
 *  MODULE EXISTS TO PREVENT. A missed run resolves ITSELF the moment the
 *  next regular cycle fires — no answer required. An ask left open after
 *  that asks the owner to decide something already decided by the clock,
 *  and answering it would act on schedules that have since run. So every
 *  tick re-derives the report and cancels an ask whose subjects are all
 *  gone. (Same discipline as D-261's `closeStoppedAsks`; the report is
 *  recomputed, so there is no second source of truth to drift.)
 */

import type { MissedRunReport } from '@recued/scheduler';

/** The registry key the answer is re-dispatched under. Opaque to the
 *  block; it must stay stable across restarts because open asks persist
 *  with this slug written into them. */
export const MISSED_RUNS_ASK_KIND = 'schedule.missed_runs';

/** Shape of the persisted handler payload. Holds the RECIPE IDS the ask
 *  was raised for, never the schedule ids: the owner answers per recipe
 *  (one run per recipe — a brief supersedes a brief), and a recipe's
 *  waiting schedules can change between raise and answer. */
export interface MissedRunsAskPayload {
  recipe_ids: string[];
  [k: string]: unknown;
}

/** The narrow slice of `NotificationBlock` this needs. Declared locally
 *  so the module does not drag the whole block type into the scheduler
 *  boot chain. */
export interface MissedRunAskNotifier {
  ask(
    message: { title: string; text: string; link_url?: string },
    options: readonly { id: string; label: string }[],
    handler: { kind: string; payload: Record<string, unknown> },
  ): Promise<{ ask_id: string }>;
  cancelAsk(ask_id: string): Promise<'cancelled' | 'not_open'>;
  listOpenAsks(): Promise<{ ask_id: string; handler_kind: string; handler_payload: Record<string, unknown> }[]>;
  registerAskHandler(
    kind: string,
    handler: (payload: Record<string, unknown>, answer: { option: string }) => void | Promise<void>,
  ): void;
}

/** Does this object actually carry the four methods the ask needs?
 *
 *  ⛔ EXISTS BECAUSE `register()` IS THE FIRST *EAGER* CALL THE BOOT
 *  MAKES ON THE NOTIFICATION BLOCK. Every other method the boot holds is
 *  invoked later, if at all, so a supplier missing one used to fail in
 *  the feature that called it; now it would fail at STARTUP and take the
 *  whole runtime down. Missed-run asks are a feature, the server booting
 *  is not — so a block without the surface degrades exactly as an absent
 *  block does.
 *
 *  ⚠ Lives HERE, beside the interface it checks, so callers cannot test
 *  a copy of it and believe they tested this. */
export const hasMissedRunAskSurface = (
  block: unknown,
): block is MissedRunAskNotifier => {
  const candidate = block as Partial<MissedRunAskNotifier> | null | undefined;
  return typeof candidate?.ask === 'function'
    && typeof candidate.cancelAsk === 'function'
    && typeof candidate.listOpenAsks === 'function'
    && typeof candidate.registerAskHandler === 'function';
};

export interface MissedRunAskDeps {
  notifier: MissedRunAskNotifier;
  /** Applies the owner's decision — the same `schedules.answerMissed`
   *  the Automation card calls, so both surfaces converge on one path. */
  answer(input: { answer: 'run' | 'skip'; recipe_ids: string[] }): void;
  /** Display name for a recipe id; absent ⇒ the id is shown. */
  recipeName?(recipe_id: string): string | undefined;
  /** Deep link to the Automation Schedules section, where the owner can
   *  answer per recipe instead of all-or-nothing. */
  link?: string;
  /** Reports a failure without taking down the tick. */
  onError?(message: string, error: unknown): void;
}

const readPayload = (payload: Record<string, unknown>): string[] => {
  const ids = payload.recipe_ids;
  if (!Array.isArray(ids)) return [];
  return ids.filter((id): id is string => typeof id === 'string');
};

/** "Morning brief — missed 4 · Invoice sweep — missed 1" */
const summarize = (
  report: MissedRunReport,
  recipeName: MissedRunAskDeps['recipeName'],
): string => report.entries
  .map((entry) => {
    const name = recipeName?.(entry.recipe_id) ?? entry.recipe_id;
    // `missed_cycles` counts FULL cycles BEYOND the one catch-up on
    // offer, so the owner-facing number is one higher. 'unknown' means
    // no cadence could be sampled — say so rather than print a number
    // we did not measure.
    const missed = entry.missed_cycles === 'unknown'
      ? 'missed at least one'
      : `missed ${entry.missed_cycles + 1}`;
    return `${name} — ${missed}`;
  })
  .join(' · ');

export const createMissedRunAsk = (deps: MissedRunAskDeps) => {
  const openAsk = async (): Promise<
    { ask_id: string; recipe_ids: string[] } | null
  > => {
    for (const ask of await deps.notifier.listOpenAsks()) {
      if (ask.handler_kind !== MISSED_RUNS_ASK_KIND) continue;
      return { ask_id: ask.ask_id, recipe_ids: readPayload(ask.handler_payload) };
    }
    return null;
  };

  return {
    /** Wire the answer path. Call once at boot — an open ask persists
     *  across restarts and is answerable only if its kind is registered. */
    register(): void {
      deps.notifier.registerAskHandler(MISSED_RUNS_ASK_KIND, (payload, answer) => {
        const recipe_ids = readPayload(payload);
        if (recipe_ids.length === 0) return;
        if (answer.option !== 'run' && answer.option !== 'skip') return;
        deps.answer({ answer: answer.option, recipe_ids });
      });
    },

    /** Called once per scheduler tick with the freshly recomputed report. */
    async project(report: MissedRunReport): Promise<void> {
      try {
        const open = await openAsk();
        const waiting = new Set(report.entries.map((entry) => entry.recipe_id));

        if (open !== null) {
          // ⛔ Cancel only when NOTHING the ask named is still waiting.
          // A partial resolution leaves the ask standing: its remaining
          // subjects are real, and re-raising for the remainder would
          // cost the owner a second prompt for one question.
          const stillWaiting = open.recipe_ids.some((id) => waiting.has(id));
          if (!stillWaiting) {
            await deps.notifier.cancelAsk(open.ask_id);
          }
          return;
        }

        if (report.entries.length === 0) return;

        const recipe_ids = report.entries.map((entry) => entry.recipe_id);
        await deps.notifier.ask(
          {
            title: 'Some scheduled runs were missed',
            text: `${summarize(report, deps.recipeName)}. Run the most recent of `
              + 'each, or skip them? Only one run per recipe is offered.',
            ...(deps.link ? { link_url: deps.link } : {}),
          },
          [
            { id: 'run', label: 'Run them' },
            { id: 'skip', label: 'Skip them' },
          ],
          { kind: MISSED_RUNS_ASK_KIND, payload: { recipe_ids } },
        );
      } catch (error) {
        // Best-effort: a notification failure must never stop the tick
        // that fires schedules.
        deps.onError?.('missed-run ask projection failed', error);
      }
    },
  };
};
