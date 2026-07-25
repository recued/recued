/** M4b.1 — `archive-upload-sweep` housekeeping task.
 *
 *  Drives the archive upload service's `sweepExpired` on the D-123 idle cadence.
 *  It reaps two things:
 *    - Expired archive upload SESSIONS + their orphan scratch (shared core
 *      sweep — overlaps the webclient `upload-session-sweep` over the one
 *      `upload_session` store, but is the SOLE cover on a boot where the
 *      webclient upload service isn't wired but the archive one is).
 *    - STAGED archives in `exports/` past their TTL — the backstop the export
 *      GC can't provide (it ignores staging names by design), so a finalized
 *      archive that was imported (or abandoned) doesn't linger forever.
 *
 *  Cursor: `{ kind: 'complete' }` — every step is a fresh full sweep at `now()`.
 *  Idempotent (active sessions bump their expiry; a fresh staged file is younger
 *  than the TTL), so re-firing next idle cycle is cheap. No `onInvalidate` —
 *  expiry is time-driven. */

import type {
  HousekeepingCursor,
  HousekeepingStepResult,
} from '@recued/contracts';

import type { ArchiveUploadService } from '../../archive/archive-upload-service.js';
import type {
  HousekeepingContext,
  HousekeepingTaskInstance,
} from '../registry.js';

export interface BuildArchiveUploadSweepTaskOptions {
  /** The per-pair archive upload service whose `sweepExpired` this task drives.
   *  bin.ts elides the registration when the service isn't wired (db-less boot). */
  service: Pick<ArchiveUploadService, 'sweepExpired'>;
}

export const buildArchiveUploadSweepTask = (
  opts: BuildArchiveUploadSweepTaskOptions,
): HousekeepingTaskInstance => {
  return {
    meta: {
      id: 'archive-upload-sweep',
      description:
        'Reap expired archive-upload sessions + scratch, and prune '
        + 'staged archives in exports/ past their TTL.',
      interruptible: true,
      kind: 'core',
      tags: ['kind:core', 'domain:upload', 'surface:deterministic'],
    },

    async step(
      ctx: HousekeepingContext,
      _cursor: HousekeepingCursor,
      _budget_ms: number,
    ): Promise<HousekeepingStepResult> {
      // One bounded pass per cycle (the session sweep is LIMIT-capped in the
      // store; the staging prune is a single exports/ scan). The housekeeping
      // clock takes precedence so tests injecting `ctx.now` stay deterministic.
      await opts.service.sweepExpired({ now: ctx.now() });
      return { status: 'complete', cursor: { kind: 'complete' } };
    },
  };
};
