/** D-321 — the programs each run started under Warn although their version was
 *  not one the pack was tested with, held until the run's record is written.
 *
 *  The executor learns it before a launch (`checkToolVersion`); the execute
 *  handler writes the run's record at the end. This is the hand-off between
 *  the two, keyed by run id: `add` from the executor, `take` (which forgets)
 *  when the record is built, so the note lands on the run's Logs detail.
 *
 *  ⚠ Bounded. A run that never writes its record (a crash mid-run) would
 *  otherwise leave its notes here forever; past `maxRuns` the oldest run's
 *  notes are dropped, which loses a Logs note, never a refusal. */

import type { RunUntestedTool } from '@recued/contracts';

export interface RunUntestedTools {
  add(runId: string, note: RunUntestedTool): void;
  /** The run's notes, in the order they were added, each tool and version once;
   *  forgotten once taken. */
  take(runId: string): RunUntestedTool[];
}

const sameNote = (a: RunUntestedTool, b: RunUntestedTool): boolean =>
  a.tool === b.tool && a.version === b.version && a.state === b.state;

const copyNote = (note: RunUntestedTool): RunUntestedTool => ({ ...note, tested: { ...note.tested } });

export const createRunUntestedTools = (maxRuns = 500): RunUntestedTools => {
  const byRun = new Map<string, RunUntestedTool[]>();
  return {
    add(runId, note) {
      const notes = byRun.get(runId) ?? [];
      if (!notes.some((n) => sameNote(n, note))) notes.push(copyNote(note));
      byRun.delete(runId);
      byRun.set(runId, notes);
      while (byRun.size > maxRuns) {
        const oldest = byRun.keys().next().value;
        if (oldest === undefined) break;
        byRun.delete(oldest);
      }
    },
    take(runId) {
      const notes = byRun.get(runId) ?? [];
      byRun.delete(runId);
      return notes;
    },
  };
};

/** `prior`, then each note of `taken` it does not hold yet.
 *
 *  A resumed run's record replaces its paused one, and the paused record
 *  already holds the programs the run started before it paused: the steps
 *  before the pause do not run again, so only that record still knows them. */
export const mergeRunUntestedTools = (
  prior: readonly RunUntestedTool[],
  taken: readonly RunUntestedTool[],
): RunUntestedTool[] => {
  const merged = prior.map(copyNote);
  for (const note of taken) {
    if (!merged.some((n) => sameNote(n, note))) merged.push(copyNote(note));
  }
  return merged;
};

const isRunUntestedTool = (value: unknown): value is RunUntestedTool => {
  if (value === null || typeof value !== 'object') return false;
  const note = value as Record<string, unknown>;
  const tested = note.tested as Record<string, unknown> | null | undefined;
  return typeof note.tool === 'string'
    && (note.version === undefined || typeof note.version === 'string')
    && (note.state === 'untested' || note.state === 'unreadable')
    && tested !== null && typeof tested === 'object' && typeof tested.from === 'string'
    && (tested.before === undefined || typeof tested.before === 'string');
};

/** The notes a run's stored record holds; none for no record, or for notes
 *  that are not notes. */
export const untestedToolsOf = (
  record: { untested_tools?: readonly unknown[] } | null | undefined,
): RunUntestedTool[] => {
  const notes = record?.untested_tools;
  return Array.isArray(notes) ? notes.filter(isRunUntestedTool).map(copyNote) : [];
};
