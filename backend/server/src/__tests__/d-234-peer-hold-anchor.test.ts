/** D-234 § 234.4 slice 7 — the host turns a peer pause into a DURABLE hold.
 *
 *  Slices 5 and 6 made the engine pause and the op reachable. Neither wrote
 *  anything down: a run raised the signal, ended, and left nothing to resume
 *  from. This is the piece that makes the hold survive the process.
 *
 *  ⛔⛔ THE INVARIANT UNDER TEST IS AN ORDERING ONE, AND IT MATTERS MORE HERE THAN
 *  IT DID FOR D-157. The anchor may carry `awaiting_peer` ONLY when the
 *  checkpoint is durable. An `awaiting_peer` row with no `checkpoint_id` is not
 *  merely an unresumable ghost — since slice 2 the retention scan treats a HELD
 *  anchor as live and refuses to reclaim it, so the ghost would sit there
 *  forever: unresumable and never collected. D-157's equivalent ghost at least
 *  got swept. */
import { describe, expect, it } from 'vitest';

import { isHeldRunAnchorStatus } from '@recued/contracts';

describe('§ 234.4 — the peer-pause anchor rule', () => {
  /** The decision the host makes, extracted so it can be exercised without
   *  standing up the whole execute-handler. ⚠ MIRRORS the expression in
   *  `execute-handler.ts`; if that changes shape this must be re-read, which is
   *  why the assertions below name the invariant rather than the code. */
  const anchorStatus = (r: {
    killed?: boolean;
    awaiting_approval?: boolean;
    awaiting_peer?: boolean;
    success?: boolean;
    checkpointId?: string;
  }): string =>
    r.killed === true
      ? 'killed'
      : r.awaiting_approval
        ? (r.checkpointId !== undefined ? 'awaiting_approval' : 'failed')
        : r.awaiting_peer
          ? (r.checkpointId !== undefined ? 'awaiting_peer' : 'failed')
          : r.success ? 'succeeded' : 'failed';

  it('a durable peer pause carries `awaiting_peer`', () => {
    expect(anchorStatus({ awaiting_peer: true, checkpointId: 'cp-1' }))
      .toBe('awaiting_peer');
  });

  it('⛔⛔ WITHOUT A CHECKPOINT IT IS `failed`, NEVER HELD', () => {
    // The ghost this prevents is worse than D-157's: slice 2 taught the
    // retention scan that a held anchor is live, so an `awaiting_peer` row with
    // no checkpoint would never be reclaimed AND never resume.
    expect(anchorStatus({ awaiting_peer: true })).toBe('failed');
  });

  it('a kill beats a peer pause', () => {
    // A killed run is terminal: it must not leave a resumable hold behind.
    expect(anchorStatus({ killed: true, awaiting_peer: true, checkpointId: 'cp-1' }))
      .toBe('killed');
  });

  it('an approval pause still wins when both are somehow set', () => {
    // ⚠ Defensive, not expected: the engine returns one or the other. But the
    // approval branch is the one with a local ask to pair, so if both ever
    // appeared, resolving to the peer status would strand that ask.
    expect(anchorStatus({
      awaiting_approval: true, awaiting_peer: true, checkpointId: 'cp-1',
    })).toBe('awaiting_approval');
  });

  it('leaves the ordinary outcomes untouched', () => {
    expect(anchorStatus({ success: true })).toBe('succeeded');
    expect(anchorStatus({ success: false })).toBe('failed');
  });

  it('every status this can produce is one the held-predicate agrees about', () => {
    // ⚠ The join slice 2 established: whatever the host writes, the retention
    // scan / boot sweep / resumer read it through `isHeldRunAnchorStatus`. A
    // status the host can emit that the predicate misclassifies is the retention
    // landmine again, wearing a new name.
    for (const s of ['awaiting_peer', 'awaiting_approval']) {
      expect(isHeldRunAnchorStatus(s)).toBe(true);
    }
    for (const s of ['succeeded', 'failed', 'killed']) {
      expect(isHeldRunAnchorStatus(s)).toBe(false);
    }
  });
});
