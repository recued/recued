/** D-115 Phase 7 — Tier 2 transforms for reactive recipes. */

import { describe, it, expect } from 'vitest';
import {
  mail_received,
  file_changed,
  calendar_starting_soon,
  calendar_changed_since,
  calendar_new_since,
  attendee_diff,
  recipe_succeeded_since,
  time_within_window,
  time_elapsed_since,
  http_changed,
} from '../reactive.js';
import { ctx } from './helpers.js';

const c = ctx();

describe('mail_received', () => {
  const mails = [
    { from: 'alice@example.com', subject: 'Hello world', labels: ['inbox', 'work'] },
    { from: 'BOB@TEST.com', subject: 'RE: Invoice', labels: ['personal'] },
    { from: 'carol@work.com', subject: '[alert] Server down', labels: ['alerts'] },
  ];

  it('returns true when any mail matches from (case-insensitive substring)', () => {
    expect(mail_received({ mails, from: 'alice@' }, c)).toBe(true);
    expect(mail_received({ mails, from: 'BOB' }, c)).toBe(true);
  });

  it('returns false when no mail matches', () => {
    expect(mail_received({ mails, from: 'nobody@' }, c)).toBe(false);
  });

  it('AND-combines from + subject + label filters', () => {
    expect(mail_received(
      { mails, from: 'carol', subject: 'alert', label: 'alerts' },
      c,
    )).toBe(true);
    // from matches but subject doesn't
    expect(mail_received(
      { mails, from: 'carol', subject: 'welcome' },
      c,
    )).toBe(false);
  });

  it('returns false for non-array / null mails', () => {
    expect(mail_received({ mails: null }, c)).toBe(false);
    expect(mail_received({ mails: 'oops' }, c)).toBe(false);
  });

  it('matches label exact, case-insensitive', () => {
    expect(mail_received({ mails, label: 'Work' }, c)).toBe(true);
    expect(mail_received({ mails, label: 'spam' }, c)).toBe(false);
  });

  it('returns true for empty filter + non-empty list (any match)', () => {
    expect(mail_received({ mails: [{ from: 'x' }] }, c)).toBe(true);
    expect(mail_received({ mails: [] }, c)).toBe(false);
  });
});

describe('file_changed', () => {
  const files = [
    { path: '/docs/a.md', modified_at: 100, size: 10 },
    { path: '/docs/b.txt', modified_at: 200 },
    { path: '/src/x.ts', modified_at: 150 },
    { path: '/src/y.ts', modified_at: 50 },
  ];

  it('filters to files modified AFTER since_ms (strict)', () => {
    const r = file_changed({ files, since_ms: 100 }, c) as Array<{ path: string }>;
    expect(r.map((f) => f.path)).toEqual(['/docs/b.txt', '/src/x.ts']);
  });

  it('returns [] when nothing changed', () => {
    expect(file_changed({ files, since_ms: 1000 }, c)).toEqual([]);
  });

  it('constrains by path_prefix', () => {
    const r = file_changed({ files, since_ms: 0, path_prefix: '/src/' }, c) as Array<{ path: string }>;
    expect(r.map((f) => f.path).sort()).toEqual(['/src/x.ts', '/src/y.ts']);
  });

  it('constrains by extension (with or without leading dot)', () => {
    const withDot = file_changed({ files, since_ms: 0, extension: '.ts' }, c) as Array<{ path: string }>;
    const noDot = file_changed({ files, since_ms: 0, extension: 'ts' }, c) as Array<{ path: string }>;
    expect(withDot.map((f) => f.path).sort()).toEqual(['/src/x.ts', '/src/y.ts']);
    expect(noDot).toEqual(withDot);
  });

  it('falls back to updated_at / mtime when modified_at is absent', () => {
    const list = [{ path: '/a', updated_at: 500 }, { path: '/b', mtime: 10 }];
    const r = file_changed({ files: list, since_ms: 100 }, c) as Array<{ path: string }>;
    expect(r.map((f) => f.path)).toEqual(['/a']);
  });

  it('returns [] for non-array / non-finite since_ms', () => {
    expect(file_changed({ files: null, since_ms: 0 }, c)).toEqual([]);
    expect(file_changed({ files, since_ms: 'nope' }, c)).toEqual([]);
  });
});

describe('calendar_starting_soon', () => {
  const now = 1_700_000_000_000;
  const events = [
    { id: 'past', start_at: now - 60_000 },
    { id: 'soon', start_at: now + 5 * 60_000 }, // 5 min away
    { id: 'later', start_at: now + 30 * 60_000 }, // 30 min away
    { id: 'future', start_at: now + 2 * 60 * 60_000 }, // 2h away
  ];

  it('includes events starting within the window', () => {
    const r = calendar_starting_soon({ events, minutes_ahead: 15, now }, c) as Array<{ id: string }>;
    expect(r.map((e) => e.id)).toEqual(['soon']);
  });

  it('excludes events already started (start_at <= now)', () => {
    const r = calendar_starting_soon({ events, minutes_ahead: 240, now }, c) as Array<{ id: string }>;
    expect(r.map((e) => e.id).includes('past')).toBe(false);
  });

  it('inclusive upper bound at the window edge', () => {
    const edgeEvents = [{ id: 'edge', start_at: now + 10 * 60_000 }];
    const r = calendar_starting_soon({ events: edgeEvents, minutes_ahead: 10, now }, c) as Array<{ id: string }>;
    expect(r.map((e) => e.id)).toEqual(['edge']);
  });

  it('returns [] for non-array / missing args', () => {
    expect(calendar_starting_soon({ events: null, minutes_ahead: 10, now }, c)).toEqual([]);
    expect(calendar_starting_soon({ events, minutes_ahead: 'bad', now }, c)).toEqual([]);
  });

  it('drops events without a numeric start_at', () => {
    const bad = [{ id: 'no_start' }, { id: 'str', start_at: 'soon' }];
    expect(calendar_starting_soon({ events: bad, minutes_ahead: 10, now }, c)).toEqual([]);
  });
});

describe('calendar_changed_since', () => {
  const events = [
    { source_id: 'a', updated_at: 100 },
    { source_id: 'b', updated_at: 200 },
    { source_id: 'c', updated_at: 50 },
    { source_id: 'd', modified_at: 300 },  // legacy field name
  ];

  it('filters to events modified strictly AFTER since_ms', () => {
    const r = calendar_changed_since({ events, since_ms: 100 }, c) as Array<{ source_id: string }>;
    expect(r.map((e) => e.source_id).sort()).toEqual(['b', 'd']);
  });

  it('returns [] when nothing changed after the watermark', () => {
    expect(calendar_changed_since({ events, since_ms: 1000 }, c)).toEqual([]);
  });

  it('returns [] for non-array / non-finite since_ms', () => {
    expect(calendar_changed_since({ events: null, since_ms: 0 }, c)).toEqual([]);
    expect(calendar_changed_since({ events, since_ms: 'bad' }, c)).toEqual([]);
  });

  it('falls back to mtime when neither updated_at nor modified_at is set', () => {
    const list = [{ source_id: 'x', mtime: 500 }];
    const r = calendar_changed_since({ events: list, since_ms: 100 }, c) as Array<{ source_id: string }>;
    expect(r.map((e) => e.source_id)).toEqual(['x']);
  });
});

describe('calendar_new_since', () => {
  const events = [
    { source_id: 'a', created_at: 100, updated_at: 500 },
    { source_id: 'b', created_at: 200, updated_at: 200 },
    { source_id: 'c', created_at: 50, updated_at: 900 },   // recently updated but NOT new
  ];

  it('filters to events CREATED strictly AFTER since_ms (edits do not count)', () => {
    const r = calendar_new_since({ events, since_ms: 75 }, c) as Array<{ source_id: string }>;
    expect(r.map((e) => e.source_id).sort()).toEqual(['a', 'b']);
  });

  it('ignores updated_at — only created_at matters', () => {
    const r = calendar_new_since({ events, since_ms: 150 }, c) as Array<{ source_id: string }>;
    expect(r.map((e) => e.source_id)).toEqual(['b']);
  });

  it('drops entries missing a numeric created_at', () => {
    const mixed = [{ source_id: 'no_created' }, { source_id: 'bad', created_at: 'x' }];
    expect(calendar_new_since({ events: mixed, since_ms: 0 }, c)).toEqual([]);
  });
});

describe('attendee_diff', () => {
  it('returns added / removed / response_changed with full events', () => {
    const prior = {
      attendees: [
        { email: 'a@x.com', response_status: 'accepted' },
        { email: 'b@x.com', response_status: 'needs_action' },
      ],
    };
    const current = {
      attendees: [
        { email: 'a@x.com', response_status: 'accepted' },
        { email: 'b@x.com', response_status: 'declined' },
        { email: 'c@x.com', response_status: 'needs_action' },
      ],
    };
    const r = attendee_diff({ prior, current }, c) as {
      added: Array<{ email: string }>;
      removed: Array<{ email: string }>;
      response_changed: Array<{ email: string; from: string; to: string }>;
    };
    expect(r.added.map((a) => a.email)).toEqual(['c@x.com']);
    expect(r.removed.map((a) => a.email)).toEqual([]);
    expect(r.response_changed).toEqual([
      { email: 'b@x.com', from: 'needs_action', to: 'declined' },
    ]);
  });

  it('treats null prior as "all new added"', () => {
    const current = { attendees: [{ email: 'x@y.com', response_status: 'accepted' }] };
    const r = attendee_diff({ prior: null, current }, c) as {
      added: Array<{ email: string }>;
      removed: unknown[];
      response_changed: unknown[];
    };
    expect(r.added.map((a) => a.email)).toEqual(['x@y.com']);
    expect(r.removed).toEqual([]);
    expect(r.response_changed).toEqual([]);
  });

  it('matches emails case-insensitively', () => {
    const prior = { attendees: [{ email: 'A@X.com', response_status: 'accepted' }] };
    const current = { attendees: [{ email: 'a@x.COM', response_status: 'declined' }] };
    const r = attendee_diff({ prior, current }, c) as {
      added: unknown[];
      removed: unknown[];
      response_changed: Array<{ email: string; from: string; to: string }>;
    };
    expect(r.added).toEqual([]);
    expect(r.removed).toEqual([]);
    expect(r.response_changed).toEqual([
      { email: 'a@x.com', from: 'accepted', to: 'declined' },
    ]);
  });

  it('accepts raw attendee arrays directly', () => {
    const priorAttendees = [{ email: 'a@x.com', response_status: 'accepted' }];
    const currentAttendees = [{ email: 'a@x.com', response_status: 'declined' }];
    const r = attendee_diff(
      { prior_attendees: priorAttendees, current_attendees: currentAttendees },
      c,
    ) as { response_changed: Array<{ email: string; from: string; to: string }> };
    expect(r.response_changed).toEqual([
      { email: 'a@x.com', from: 'accepted', to: 'declined' },
    ]);
  });
});

describe('recipe_succeeded_since', () => {
  // D-153 P1 — transform reads `commit_status` directly (CommitStatus
  // lifecycle enum); pre-D-153 `outcome` / `status` / `success`
  // defensive fallback was retired when the substrate replaced the
  // boolean `success` field.
  const entries = [
    { recipe_id: 'a', commit_status: 'succeeded', finished_at: 100 },
    { recipe_id: 'a', commit_status: 'succeeded', finished_at: 300 },
    { recipe_id: 'a', commit_status: 'failed', finished_at: 500 },
    { recipe_id: 'b', commit_status: 'succeeded', finished_at: 400 },
  ];

  it('filters by recipe_id + commit_status===succeeded + since_ms', () => {
    const r = recipe_succeeded_since(
      { entries, recipe_id: 'a', since_ms: 200 },
      c,
    ) as Array<{ finished_at: number }>;
    expect(r.map((e) => e.finished_at)).toEqual([300]);
  });

  it('without recipe_id: matches across all recipes', () => {
    const r = recipe_succeeded_since({ entries, since_ms: 0 }, c) as unknown[];
    expect(r).toHaveLength(3);
  });

  it('rejects rows lacking commit_status (no defensive fallback post-D-153)', () => {
    const legacy = [{ recipe_id: 'a', success: true, finished_at: 100 }];
    const r = recipe_succeeded_since({ entries: legacy, since_ms: 0 }, c) as unknown[];
    expect(r).toEqual([]);
  });

  it('returns [] for non-array / non-finite since_ms', () => {
    expect(recipe_succeeded_since({ entries: null, since_ms: 0 }, c)).toEqual([]);
    expect(recipe_succeeded_since({ entries, since_ms: NaN }, c)).toEqual([]);
  });
});

describe('time_within_window', () => {
  // 2026-04-08T12:00:00Z — a Wednesday (day 3) at noon UTC.
  // Local-hour depends on runner TZ; test hour-independent paths.
  const now = new Date('2026-04-08T12:00:00Z').getTime();

  it('true when no constraints supplied', () => {
    expect(time_within_window({ now }, c)).toBe(true);
  });

  it('weekdays constraint — in', () => {
    const d = new Date(now);
    expect(time_within_window({ now, weekdays: [d.getDay()] }, c)).toBe(true);
  });

  it('weekdays constraint — out', () => {
    const d = new Date(now);
    // pick a day that isn't today
    const other = (d.getDay() + 1) % 7;
    expect(time_within_window({ now, weekdays: [other] }, c)).toBe(false);
  });

  it('start_hour / end_hour constraint — in', () => {
    const d = new Date(now);
    const h = d.getHours();
    expect(time_within_window({ now, start_hour: h, end_hour: h + 1 }, c)).toBe(true);
  });

  it('start_hour / end_hour constraint — out', () => {
    const d = new Date(now);
    const h = d.getHours();
    const wrong = (h + 12) % 24;
    expect(time_within_window(
      { now, start_hour: wrong, end_hour: (wrong + 1) % 24 },
      c,
    )).toBe(false);
  });

  it('false for non-finite now', () => {
    expect(time_within_window({ now: 'bad' }, c)).toBe(false);
  });
});

describe('time_elapsed_since', () => {
  it('true when elapsed >= window', () => {
    expect(time_elapsed_since({ now: 1000, since_ms: 0, window_ms: 500 }, c)).toBe(true);
    expect(time_elapsed_since({ now: 1000, since_ms: 500, window_ms: 500 }, c)).toBe(true);
  });

  it('false when elapsed < window', () => {
    expect(time_elapsed_since({ now: 1000, since_ms: 900, window_ms: 500 }, c)).toBe(false);
  });

  it('absent since_ms counts as elapsed (first tick)', () => {
    expect(time_elapsed_since({ now: 100, window_ms: 1000 }, c)).toBe(true);
  });

  it('false for non-finite now / window', () => {
    expect(time_elapsed_since({ now: 'bad', since_ms: 0, window_ms: 100 }, c)).toBe(false);
    expect(time_elapsed_since({ now: 100, since_ms: 0, window_ms: 'bad' }, c)).toBe(false);
  });
});

describe('http_changed', () => {
  it('etag mismatch → true', () => {
    expect(http_changed({ current_etag: '"a"', previous_etag: '"b"' }, c)).toBe(true);
  });

  it('etag match → false', () => {
    expect(http_changed({ current_etag: '"a"', previous_etag: '"a"' }, c)).toBe(false);
  });

  it('hash mismatch → true', () => {
    expect(http_changed({ current_hash: 'deadbeef', previous_hash: 'cafef00d' }, c)).toBe(true);
  });

  it('hash match → false', () => {
    expect(http_changed({ current_hash: 'x', previous_hash: 'x' }, c)).toBe(false);
  });

  it('missing previous but current present → true (first tick)', () => {
    expect(http_changed({ current_etag: '"a"' }, c)).toBe(true);
    expect(http_changed({ current_hash: 'abc' }, c)).toBe(true);
  });

  it('etag takes precedence over hash', () => {
    expect(http_changed({
      current_etag: '"a"', previous_etag: '"a"',
      current_hash: 'x', previous_hash: 'y',
    }, c)).toBe(false);
  });

  it('no comparable fields → false (unchanged default)', () => {
    expect(http_changed({}, c)).toBe(false);
  });
});
