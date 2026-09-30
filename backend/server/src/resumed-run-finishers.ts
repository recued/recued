/** What a tool delivers for its own run once an approval lets it finish.
 *
 *  A tool that runs a recipe and then processes the run's response does that
 *  processing only when the run finishes inside the call. `document.read` is
 *  the case this exists for: its reader recipe returns the selected file's
 *  bytes, and only the reader turns them into a result, after rechecking the
 *  caller's file grant and the source version, decoding, bounding and paging
 *  them. A run held for approval finishes later, in the preflight resumer,
 *  whose two deliveries (the MCP action result and the owner-chat result row)
 *  carried the run's RAW response: the bytes, with none of those checks.
 *
 *  So the tool registers the processing it would have applied, keyed on the
 *  held run's `run_id`, and the resumer delivers that result instead.
 *
 *  ⚠ PROCESS MEMORY, bounded by count and age like the reader's own cache. A
 *  restart or an eviction between the hold and the approval loses the
 *  finisher, and the reader's recipe then delivers none of its output rather
 *  than the raw response. So does a hold made in another process: the stdio
 *  `recued --mcp` profile composes its own handlers, and the owner's approval
 *  resumes in the server. Module state, not a composed dependency, because a
 *  registry one composition site forgot to pass would quietly turn every
 *  approved read into "read it again". */

import type { ChatDispatchResult, Checkpoint } from '@recued/contracts';
import { projectRunResultForAgent } from './run-result-agent-projection.js';
import type { ExecuteResponse } from './types.js';

export interface ResumedRunFinisher {
  /** The tool the caller invoked, which names the owner-chat result row. */
  readonly tool_name: string;
  /** The tool's result for the resumed run's terminal response. */
  readonly finish: (response: ExecuteResponse) => Promise<ChatDispatchResult>;
}

export interface FinishedResumedRun {
  readonly tool_name: string;
  readonly result: ChatDispatchResult;
}

/** Held reads waiting for an owner at one time. */
export const RESUMED_RUN_FINISHERS_MAX = 64;
/** An approval given later than this finds no finisher and reads again. */
export const RESUMED_RUN_FINISHER_TTL_MS = 24 * 60 * 60 * 1_000;

/** Insertion order is age order: `registerResumedRunFinisher` re-inserts. */
const finishers = new Map<string, { finisher: ResumedRunFinisher; at: number }>();

const dropExpired = (now: number): void => {
  for (const [run_id, entry] of finishers) {
    if (now - entry.at < RESUMED_RUN_FINISHER_TTL_MS) break;
    finishers.delete(run_id);
  }
};

export const registerResumedRunFinisher = (
  run_id: string,
  finisher: ResumedRunFinisher,
  now: number = Date.now(),
): void => {
  finishers.delete(run_id);
  finishers.set(run_id, { finisher, at: now });
  dropExpired(now);
  while (finishers.size > RESUMED_RUN_FINISHERS_MAX) {
    const oldest = finishers.keys().next().value;
    if (oldest === undefined) break;
    finishers.delete(oldest);
  }
};

/** Removes and returns the finisher registered for `run_id`, if still held.
 *  Its own age is checked too: the sweep stops at the first live entry, which
 *  a clock step backwards can place ahead of older ones. */
export const takeResumedRunFinisher = (
  run_id: string,
  now: number = Date.now(),
): ResumedRunFinisher | undefined => {
  dropExpired(now);
  const entry = finishers.get(run_id);
  finishers.delete(run_id);
  return entry !== undefined && now - entry.at < RESUMED_RUN_FINISHER_TTL_MS ? entry.finisher : undefined;
};

/** `document.read`'s reader recipe (`documentReadRecipe`). Its output is the
 *  selected file's bytes, raw or converted, which only the reader's own checks
 *  may turn into a result. */
export const DOCUMENT_READ_RECIPE_ID = 'read-work-document';

/** The reader recipe's run with no finisher left: the reader's checks cannot
 *  run here, so none of the run's output is delivered. Matched on the inline
 *  snapshot as well as the id, because the reader always dispatches inline and
 *  an installed recipe that happens to share the id is not the reader. */
const withheldReaderFinisher = (
  checkpoint: Pick<Checkpoint, 'recipe_id' | 'recipe_snapshot'>,
  config: Record<string, unknown> | undefined,
): ResumedRunFinisher | undefined => {
  if (checkpoint.recipe_id !== DOCUMENT_READ_RECIPE_ID || checkpoint.recipe_snapshot === undefined) return undefined;
  const steps = checkpoint.recipe_snapshot.steps;
  const converted = Array.isArray(steps)
    && steps.some(step => (step as { id?: unknown } | null)?.id === 'convert');
  const source = config?.source;
  const ref = source !== null && typeof source === 'object' ? (source as { record_id?: unknown }).record_id : source;
  const fileRef = typeof ref === 'string' && /^file:[0-9a-f]{32}$/.test(ref) ? { file_ref: ref } : {};
  return {
    tool_name: 'document.read',
    finish: async (response) => response.success
      ? { ok: true, result: { status: converted ? 'converted' : 'approved', ...fileRef,
        hint: `${converted ? 'The document converter ran after approval' : 'The approved document read ran'}, but its text was not kept for this reply. Call document.read again with the same file_ref to read it; it may need approval again.` } }
      // What did not complete keeps its errors and loses its output.
      : { ok: true, result: projectRunResultForAgent({ ...response, output: { render: [], sidebar: [] } }),
        run_failed: { detail: 'The approved document reading did not complete.' } },
  };
};

/** The delivery for a resumed run when a finisher claims it; undefined means
 *  the run's own response is delivered, as before. A run that paused again
 *  keeps its finisher for the resume that ends it. */
export const finishResumedRun = async (
  checkpoint: Pick<Checkpoint, 'run_id' | 'recipe_id' | 'recipe_snapshot'>,
  config: Record<string, unknown> | undefined,
  response: ExecuteResponse,
): Promise<FinishedResumedRun | undefined> => {
  if (response.awaiting_approval === true || response.awaiting_peer === true) return undefined;
  const finisher = takeResumedRunFinisher(checkpoint.run_id) ?? withheldReaderFinisher(checkpoint, config);
  if (finisher === undefined) return undefined;
  try {
    return { tool_name: finisher.tool_name, result: await finisher.finish(response) };
  } catch {
    // A finisher that throws delivers nothing of the run, never the raw response.
    const detail = 'The approved run finished, but its result could not be prepared. Run the tool again.';
    return { tool_name: finisher.tool_name, result: { ok: true, result: { status: 'unavailable', hint: detail }, run_failed: { detail } } };
  }
};
