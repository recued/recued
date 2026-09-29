/** D-315 §6 — the `mail_fact` announcement: a scan writes one email's facts at a
 *  time, so changes are announced at most once per delay, and the last one
 *  always is. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createMailFactAnnouncer, type MailFactAnnouncement } from '../mail-facts/announcer.js';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the mail fact announcer', () => {
  it('announces a burst once, after the delay, and each kind on its own', () => {
    const emitted: MailFactAnnouncement[] = [];
    const announcer = createMailFactAnnouncer((what) => emitted.push(what), 1_000);
    for (let i = 0; i < 50; i += 1) announcer.announce('facts');
    announcer.announce('templates');
    expect(emitted).toEqual([]);
    vi.advanceTimersByTime(999);
    expect(emitted).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(emitted.sort()).toEqual(['facts', 'templates']);
  });

  it('announces a change that arrives after the last announcement', () => {
    const emitted: MailFactAnnouncement[] = [];
    const announcer = createMailFactAnnouncer((what) => emitted.push(what), 1_000);
    announcer.announce('facts');
    vi.advanceTimersByTime(1_000);
    announcer.announce('facts');
    vi.advanceTimersByTime(1_000);
    expect(emitted).toEqual(['facts', 'facts']);
  });

  it('survives a failing bus, and announces nothing after dispose', () => {
    const emit = vi.fn(() => { throw new Error('bus down'); });
    const announcer = createMailFactAnnouncer(emit, 1_000);
    announcer.announce('facts');
    expect(() => vi.advanceTimersByTime(1_000)).not.toThrow();
    announcer.announce('facts');
    announcer.dispose();
    vi.advanceTimersByTime(5_000);
    expect(emit).toHaveBeenCalledTimes(1);
  });
});
