/** D-172 resumable uploads — `upload-session-sweep` housekeeping task.
 *
 *  Reaps expired `upload_session` rows (idle / abandoned / premature-quit —
 *  indistinguishable from idle server-side) + their scratch files, plus the
 *  fs-scan orphan backstop (row-less scratch past TTL). Wraps the webclient
 *  upload service's `sweepExpired` as a `kind: 'core'` task so the D-123
 *  scheduler picks it up on the regular idle cadence. This is the disk-DoS
 *  safety valve: without it, an abandoned upload (tab closed mid-stream) leaks
 *  its scratch forever; the create-time caps bound concurrency but only the
 *  sweeper frees a stranded session's budget.
 *
 *  Cursor: `{ kind: 'complete' }` — every step is a fresh full sweep at `now()`.
 *  The sweep is idempotent (an active session bumps its expiry on every chunk,
 *  so it is never reaped while live), so re-firing next idle cycle is cheap.
 *
 *  No `onInvalidate` — expiry is time-driven; no source write changes whether a
 *  session's TTL has elapsed in real time.
 *
 *  Spec: internal design notes
 *  (rev 2 lifecycle § + rev 4 build order). */

import type {
  HousekeepingCursor,
  HousekeepingStepResult,
} from '@recued/contracts';

import type { WebclientUploadService } from '../../upload/webclient-upload-service.js';
import type {
  HousekeepingContext,
  HousekeepingTaskInstance,
} from '../registry.js';

export interface BuildUploadSweepTaskOptions {
  /** The per-pair webclient upload service whose `sweepExpired` this task
   *  drives. bin.ts elides the registration when the service isn't wired
   *  (db-less / no-CAS boot). */
  service: Pick<WebclientUploadService, 'sweepExpired'>;
}

export const buildUploadSweepTask = (
  opts: BuildUploadSweepTaskOptions,
): HousekeepingTaskInstance => {
  return {
    meta: {
      id: 'upload-session-sweep',
      description:
        'Reap expired resumable-upload sessions (idle / abandoned) + '
        + 'their scratch files, plus the row-less-scratch orphan backstop.',
      interruptible: true,
      kind: 'core',
      tags: ['kind:core', 'domain:upload', 'surface:deterministic'],
    },

    async step(
      ctx: HousekeepingContext,
      _cursor: HousekeepingCursor,
      _budget_ms: number,
    ): Promise<HousekeepingStepResult> {
      // One bounded pass per cycle. `listExpired` is LIMIT-capped in the store
      // (default 100); a backlog drains across successive idle cycles. The
      // housekeeping clock takes precedence so tests injecting `ctx.now` stay
      // run-to-run deterministic.
      await opts.service.sweepExpired({ now: ctx.now() });
      return { status: 'complete', cursor: { kind: 'complete' } };
    },
  };
};
