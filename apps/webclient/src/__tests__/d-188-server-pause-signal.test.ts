/** D-188 — the server's pause as the heartbeat reports it, for the approval lists: an approval
 *  the pause holds back reads so (`ServerPendingAsk.paused`, decided when the server lists the
 *  asks), so a list reads its asks again when the pause turns on or off. */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { __resetServerPauseSignal, noteServerPaused, onServerPauseChange } from '../shell/server-pause-signal.js';

afterEach(() => {
  __resetServerPauseSignal();
});

describe('the server pause signal', () => {
  it('announces a change, never the first report or a repeat', () => {
    const heard: boolean[] = [];
    onServerPauseChange((paused) => heard.push(paused));
    noteServerPaused(false);
    noteServerPaused(false);
    noteServerPaused(undefined);
    expect(heard).toEqual([]);
    noteServerPaused(true);
    noteServerPaused(true);
    noteServerPaused(false);
    expect(heard).toEqual([true, false]);
  });

  it('stops after unsubscribing, and one failing listener does not keep the others stale', () => {
    const later = vi.fn();
    const off = onServerPauseChange(() => { throw new Error('a surface failed'); });
    onServerPauseChange(later);
    noteServerPaused(false);
    noteServerPaused(true);
    expect(later).toHaveBeenCalledWith(true);
    off();
    const gone = vi.fn();
    const offGone = onServerPauseChange(gone);
    offGone();
    noteServerPaused(false);
    expect(gone).not.toHaveBeenCalled();
    expect(later).toHaveBeenCalledTimes(2);
  });
});
