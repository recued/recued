/** `watched-folder-walk` housekeeping task — each watched folder is walked
 *  again now and then, so a change its watch missed still lands.
 *
 *  A watched folder's records follow its watch, and a watch can miss changes
 *  without a word: on macOS FSEvents drops events in a burst (19-42% of files
 *  written at 200 a second) and loses whatever changes while its stream is
 *  rebuilt, and an overloaded `fseventsd` delivers late or not at all
 *  (measured 2026-10-20 on a Mac up 26 days: `fseventsd` at 93% CPU and
 *  8.4 GB, and a new watch got no event within 10 s for a file written into
 *  it). The folder
 *  walks again on the signals it gets (`onRescanNeeded` in `compose.ts`); this
 *  is for the losses that send none. The walk is a start's: what changed
 *  lands, what went is taken out, an unchanged file costs a stat.
 *
 *  ⛔ Here, on the idle cycle, rather than on a timer of its own: D-110
 *  amendment 11 (2026-07-22) keeps recursive walks off independent timers,
 *  since their I/O grows with the folder. So the owner's housekeeping schedule
 *  sets the pace (every 15 minutes on the default preset, hourly on `light`,
 *  never when off), and a cycle waits while the server is busy. A folder
 *  walked in the last `WATCHED_FOLDER_WALK_EVERY_MS` is skipped, which keeps
 *  the `aggressive` preset, whose cycles come every minute once the server has
 *  been idle five, from walking every minute. Only folders with a realtime
 *  watch: one without walks when asked (amendment 11), never on a schedule.
 *
 *  One walk at a time, the oldest first; when the step's budget is spent the
 *  rest wait for the next cycle. A walk itself is never cut short — a
 *  half-walk takes nothing out, so cutting it would only ever be wasted. */

import type {
  HousekeepingCursor,
  HousekeepingStepResult,
} from '@recued/contracts';

import type { FileStack } from '../../collections/file/compose.js';
import type {
  HousekeepingContext,
  HousekeepingTaskInstance,
} from '../registry.js';

/** How long after a folder's last walk the next one is due. */
export const WATCHED_FOLDER_WALK_EVERY_MS = 15 * 60_000;

export interface BuildWatchedFolderWalkTaskOptions {
  folders: Pick<FileStack, 'watchedFolderWalks' | 'walkFolderAgain'>;
}

export const buildWatchedFolderWalkTask = (
  opts: BuildWatchedFolderWalkTaskOptions,
): HousekeepingTaskInstance => ({
  meta: {
    id: 'watched-folder-walk',
    description: 'Look through each watched folder again for changes its watch missed.',
    interruptible: true,
    kind: 'core',
    tags: ['kind:core', 'domain:file', 'surface:deterministic'],
  },

  async step(
    ctx: HousekeepingContext,
    _cursor: HousekeepingCursor,
    budget_ms: number,
  ): Promise<HousekeepingStepResult> {
    const started = ctx.now();
    const due = opts.folders.watchedFolderWalks()
      .filter((folder) => started - folder.last_walk_at >= WATCHED_FOLDER_WALK_EVERY_MS)
      .sort((a, b) => a.last_walk_at - b.last_walk_at);
    for (const folder of due) {
      if (ctx.now() - started >= budget_ms) {
        return { status: 'yield', reason: 'budget_exhausted', cursor: { kind: 'complete' } };
      }
      await opts.folders.walkFolderAgain(folder.slug);
    }
    return { status: 'complete', cursor: { kind: 'complete' } };
  },
});
