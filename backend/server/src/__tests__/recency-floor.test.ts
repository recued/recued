import { describe, expect, it, afterEach } from 'vitest';
import Database from 'better-sqlite3';

import { createCollectionTable } from '../collections/table.js';

/** A CORRECTION MUST NOT BE EVICTED BY THE THING IT CORRECTS.
 *
 *  FTS5 `rank` is BM25: it rewards term frequency and penalises document length,
 *  so a long old thread repeating "Ridgeway renewal notice period" outranks a
 *  one-line "Update: Ridgeway is now 90 days" from yesterday. Past the limit the
 *  correction is not merely ranked below the stale fact — it is DROPPED, and the
 *  model answers confidently from a superseded record. That reads as fabrication
 *  and is not.
 *
 *  ⛔ Recency is NOT treated as truth here. The floor only guarantees the newest
 *  matches are VISIBLE alongside what they contradict; which fact stands is left
 *  to the reader. A substrate that ruled "newest wins" would be consolidation
 *  with a timestamp — the same tampering, differently spelled. */

let dbs: Database.Database[] = [];
const open = () => { const db = new Database(':memory:'); dbs.push(db); return db; };
afterEach(() => { for (const db of dbs) db.close(); dbs = []; });

const seed = (n: number) => {
  const db = open();
  const table = createCollectionTable({ db, platform: 'mail', slug: 'work' });
  const day = 86_400_000;
  const now = 1_800_000_000_000;
  // Old, repetitive, BM25-favoured.
  for (let i = 0; i < n; i++) {
    table.upsert({
      record_id: `uid:old${i}@INBOX`,
      received_at: now - 90 * day,
      modified_at: now - 90 * day,
      hot_fields: { from: 'a@b.com', subject: 'Ridgeway renewal notice period', is_read: true },
      size_bytes: 10,
      source_id: `<old${i}@x>`,
      body_inline: 'Ridgeway renewal notice period. The Ridgeway renewal notice '
        + 'period was agreed. Ridgeway renewal notice period stands at 30 days.',
      origin_actor: 'system',
    });
  }
  // Recent, short, mentions the subject once.
  table.upsert({
    record_id: 'uid:new@INBOX',
    received_at: now - 2 * day,
    modified_at: now - 2 * day,
    hot_fields: { from: 'a@b.com', subject: 'Ridgeway update', is_read: false },
    size_bytes: 10,
    source_id: '<new@x>',
    body_inline: 'Update: Ridgeway is now 90 days.',
    origin_actor: 'system',
  });
  return table;
};

describe('recency floor', () => {
  it('keeps the recent correction when the result is truncated', () => {
    const table = seed(30);
    const keys = table.search({ platform: 'mail', slug: 'work', query: 'ridgeway', limit: 20 }).map((m) => m.record_id);
    expect(keys).toHaveLength(20);
    expect(keys, 'the correction must survive truncation').toContain('uid:new@INBOX');
  });

  it('changes nothing when the result is NOT truncated', () => {
    // Under the limit everything matching is returned anyway, so the floor must
    // not fire — it is a truncation remedy, not a reordering.
    const table = seed(3);
    const keys = table.search({ platform: 'mail', slug: 'work', query: 'ridgeway', limit: 20 }).map((m) => m.record_id);
    expect(keys).toHaveLength(4);
    expect(keys).toContain('uid:new@INBOX');
  });

  it('still returns a full page of results', () => {
    const table = seed(50);
    expect(table.search({ platform: 'mail', slug: 'work', query: 'ridgeway', limit: 20 })).toHaveLength(20);
  });

  it('does not resurrect non-matching records', () => {
    // The floor reruns the SAME expression; it must never widen the match set.
    const table = seed(30);
    expect(table.search({ platform: 'mail', slug: 'work', query: 'kestrel', limit: 20 })).toHaveLength(0);
  });
});

describe('calendar recency floor', () => {
  it('keeps a recently CHANGED event when the page is truncated', async () => {
    const { createCalendarTable } = await import('../collections/calendar/calendar-table.js');
    const db = open();
    const table = createCalendarTable({ db, slug: 'work' });
    const day = 86_400_000;
    const now = 1_800_000_000_000;
    const ev = (id: string, mod: number, summary: string, body: string) => ({
      event: {
        source_id: id, ical_uid: `${id}@x`, calendar_id: 'primary', summary,
        start_at: now, end_at: now + 3_600_000, timezone: 'UTC',
        is_all_day: false, status: 'confirmed', attendees: [],
        created_at: mod, updated_at: mod,
      },
      size_bytes: 20, body_inline: body, now: mod,
    });
    for (let i = 0; i < 30; i++) {
      table.upsert(ev(`old${i}`, now - 90 * day, 'Ridgeway review meeting',
        'Ridgeway review meeting. Ridgeway review meeting agenda. Ridgeway review meeting.') as never);
    }
    // ⛔ keyed on modified_at, not received_at: a rescheduled event's arrival
    // can be months older than the change that matters.
    table.upsert(ev('new1', now - day, 'Ridgeway moved', 'Ridgeway moved to Kestrel Room.') as never);
    // ⚠ Assert on CONTENT, not the id: calendar `record_id` is an opaque hash
    // (`cal:a257ddc…`), not derived from `source_id`, so an id-substring check
    // can never pass and would fail whether or not the floor worked.
    const res = table.search({ query: 'ridgeway', limit: 20 });
    expect(res).toHaveLength(20);
    expect(
      res.some((r) => JSON.stringify(r).includes('Kestrel')),
      'the recently CHANGED event must survive truncation',
    ).toBe(true);
  });
});

describe('partial slots (labelled)', () => {
  const build = () => {
    const db = open();
    const t = createCollectionTable({ db, platform: 'mail', slug: 'w' });
    const day = 86_400_000, now = 1_800_000_000_000;
    const put = (id: string, age: number, body: string) => t.upsert({
      record_id: `uid:${id}`, received_at: now - age, modified_at: now - age,
      hot_fields: { from: 'a@b.c', subject: id, is_read: true },
      size_bytes: 10, source_id: `<${id}>`, body_inline: body, origin_actor: 'system',
    });
    // Stale FULL match — carries every query term and the superseded figure.
    put('stale', 200 * day, 'Ridgeway renewal notice period agreed at 30 days.');
    // The CORRECTION — recent, but re-phrased, so it lacks "notice".
    put('fix', 2 * day, 'Ridgeway renewal is now 90 days.');
    return t;
  };

  /** The same world, but with a HEALTHY full-match page: enough rows carry every
   *  query term that the search is not near-empty. Needed because the default-off
   *  assertion below is about the env flag, and on a one-row page the near-empty
   *  broadening now fires on its own — which would make that test pass or fail
   *  for a reason that has nothing to do with the flag. */
  const buildHealthy = () => {
    const t = build();
    const now = Date.now();
    const day = 86_400_000;
    for (const n of [1, 2, 3]) {
      t.upsert({
        record_id: `uid:bulk${n}`, received_at: now - (100 + n) * day,
        modified_at: now - (100 + n) * day,
        hot_fields: { from: 'a@b.c', subject: `bulk${n}`, is_read: true },
        size_bytes: 10, source_id: `<bulk${n}>`,
        body_inline: 'Ridgeway renewal notice period restated.',
        origin_actor: 'system',
      } as never);
    }
    return t;
  };

  it('is OFF by default on a healthy page — the re-phrased correction stays invisible', () => {
    delete process.env.RECUED_PARTIAL_SLOTS;
    const res = buildHealthy().search({ platform: 'mail', slug: 'w', query: 'ridgeway renewal notice', limit: 20 });
    // Every returned row matched every term; the re-phrased correction did not.
    expect(res.some((r) => r.record_id === 'uid:fix')).toBe(false);
    expect(res.length).toBeGreaterThan(2);
  });

  /** ⛔ A DELIBERATE CHANGE TO A SHIPPED DEFAULT, PINNED SO IT IS NOT SILENT.
   *  The partial-slot machinery used to run only under `RECUED_PARTIAL_SLOTS`.
   *  A NEAR-EMPTY page now runs it regardless, because an `AND` that matched
   *  almost nothing is a failed search wearing a success's clothes — measured on
   *  bench 276, where an over-specific opening query returned ONE row of a
   *  seven-message thread and the model answered from it. The flag still governs
   *  the always-on case; only the distress case is unconditional. */
  it('broadens a NEAR-EMPTY page even with the flag off — and still labels it', () => {
    delete process.env.RECUED_PARTIAL_SLOTS;
    const res = build().search({ platform: 'mail', slug: 'w', query: 'ridgeway renewal notice', limit: 20 });
    const fix = res.find((r) => r.record_id === 'uid:fix');
    expect(fix, 'a near-empty page must reach the re-phrased correction').toBeDefined();
    expect(fix?.partial_match).toBe(true);
    expect(res.find((r) => r.record_id === 'uid:stale')?.partial_match).toBeUndefined();
  });

  it('surfaces the correction, and LABELS it', () => {
    process.env.RECUED_PARTIAL_SLOTS = '1';
    try {
      const res = build().search({ platform: 'mail', slug: 'w', query: 'ridgeway renewal notice', limit: 20 });
      const fix = res.find((r) => r.record_id === 'uid:fix');
      expect(fix, 'the re-phrased correction must be reachable').toBeDefined();
      // ⛔ The label is the point. Unlabelled, this row is indistinguishable
      // from one the query actually asked for.
      expect(fix?.partial_match).toBe(true);
      // and the row that DID match every term must not be mislabelled
      expect(res.find((r) => r.record_id === 'uid:stale')?.partial_match).toBeUndefined();
    } finally {
      delete process.env.RECUED_PARTIAL_SLOTS;
    }
  });
});

describe('partial slots — position matrix', () => {
  const build = (rankPressure: number, recencyPressure: number, phraseLen: number) => {
    const db = open();
    const t = createCollectionTable({ db, platform: 'mail', slug: 'w' });
    const day = 86_400_000, now = 1_800_000_000_000;
    const terms = ['ridgeway', 'renewal', 'notice'];
    const put = (id: string, age: number, body: string) => t.upsert({
      record_id: `uid:${id}`, received_at: now - age, modified_at: now - age,
      hot_fields: { from: 'a@b.c', subject: id, is_read: true },
      size_bytes: 10, source_id: `<${id}>`, body_inline: body, origin_actor: 'system',
    });
    for (let i = 0; i < rankPressure; i++) {
      put(`old${i}`, 300 * day, 'Ridgeway renewal notice. Ridgeway renewal notice period.');
    }
    put('TRUTH', 30 * day, `${terms.slice(0, phraseLen).join(' ')} — now 90 days.`);
    for (let i = 0; i < recencyPressure; i++) put(`new${i}`, (20 - i * 0.05) * day, 'Ridgeway chatter.');
    return t;
  };
  const buildRecent = (rankPressure: number, noise: number, phraseLen: number) => {
    const db = open();
    const t = createCollectionTable({ db, platform: 'mail', slug: 'w' });
    const day = 86_400_000, now = 1_800_000_000_000;
    const terms = ['ridgeway', 'renewal', 'notice'];
    const put = (id: string, age: number, body: string) => t.upsert({
      record_id: `uid:${id}`, received_at: now - age, modified_at: now - age,
      hot_fields: { from: 'a@b.c', subject: id, is_read: true },
      size_bytes: 10, source_id: `<${id}>`, body_inline: body, origin_actor: 'system',
    });
    for (let i = 0; i < rankPressure; i++) {
      put(`old${i}`, 300 * day, 'Ridgeway renewal notice. Ridgeway renewal notice period.');
    }
    put('TRUTH', 2 * day, `${terms.slice(0, phraseLen).join(' ')} — now 90 days.`);
    for (let i = 0; i < noise; i++) put(`pn${i}`, (25 + i * 0.05) * day, 'Ridgeway renewal chatter.');
    return t;
  };
  const recentTruth = (r: number, noise: number, p: number) =>
    buildRecent(r, noise, p).search({ platform: 'mail', slug: 'w', query: 'ridgeway renewal notice', limit: 20 })
      .some((m) => m.record_id.includes('TRUTH'));

  const reaches = (r: number, rec: number, p: number) =>
    build(r, rec, p).search({ platform: 'mail', slug: 'w', query: 'ridgeway renewal notice', limit: 20 })
      .some((m) => m.record_id.includes('TRUTH'));

  it('reaches a re-phrased correction that is NEWER than the partial noise', () => {
    // The realistic shape: a correction is recent — that is what makes it one.
    // Measured 6/6 at every partial-noise level (0→100) with a single slot.
    process.env.RECUED_PARTIAL_SLOTS = '1';
    try {
      for (const p of [1, 2, 3]) {
        for (const r of [0, 5, 20, 50, 200]) {
          expect(recentTruth(r, 20, p), `phrase ${p}/3, ${r} stale`).toBe(true);
        }
      }
    } finally { delete process.env.RECUED_PARTIAL_SLOTS; }
  });

  it('degrades — not silently — when the correction is old AND out-termed', () => {
    // ⛔⛔ NO PRECISE NEGATIVE CELL IS ASSERTED HERE, DELIBERATELY. The boundary
    // moves with fixture WORDING, and I got it wrong three times in a row:
    //   · 'Ridgeway chatter about the site.' vs 'Ridgeway chatter.' — BM25
    //     penalises length, so the terser rival outranks and the cell flips.
    //   · noise carrying 1 query term vs 2 — a 2-term truth beats the first and
    //     loses to the second.
    //   · a sweep with a RECENT truth proves recency; the same sweep with an
    //     OLDER truth proves relevance. Each of my sweeps was biased toward the
    //     ordering it was testing.
    // What IS stable: a correction competing on neither axis — older than the
    // noise AND carrying fewer query terms — is not recoverable by ordering,
    // because separating it would mean knowing it is a correction, which is
    // semantic. Asserting exactly WHERE that starts would encode a fixture.
    process.env.RECUED_PARTIAL_SLOTS = '1';
    try {
      // uncontested: always reachable, whatever its age
      expect(reaches(50, 0, 1)).toBe(true);
      expect(reaches(5, 0, 2)).toBe(true);
    } finally { delete process.env.RECUED_PARTIAL_SLOTS; }
  });

  it('the 50-stale case that the page-sized exclusion set used to lose', () => {
    // ⛔ REGRESSION GUARD. `fullKeys` was built from `matches`, already capped at
    // the limit — so with 50 stale full matches only 20 were excluded and the
    // other 30 filled every partial slot. Coverage looked fine at rank-depth 20
    // and silently failed at 50: a ceiling that changes what a filter EXCLUDES.
    process.env.RECUED_PARTIAL_SLOTS = '1';
    try { expect(reaches(50, 0, 1)).toBe(true); }
    finally { delete process.env.RECUED_PARTIAL_SLOTS; }
  });

  it('still misses a record sharing NO query term (the matrix can say no)', () => {
    // A uniformly green matrix proves nothing unless the harness can fail.
    process.env.RECUED_PARTIAL_SLOTS = '1';
    try {
      const db = open();
      const t = createCollectionTable({ db, platform: 'mail', slug: 'w' });
      t.upsert({
        record_id: 'uid:TRUTH', received_at: 1, modified_at: 1,
        hot_fields: { from: 'a@b.c', subject: 'x', is_read: true },
        size_bytes: 10, source_id: '<t>', body_inline: 'kestrel braidwood — now 90 days.',
        origin_actor: 'system',
      });
      expect(t.search({ platform: 'mail', slug: 'w', query: 'ridgeway renewal notice', limit: 20 })).toHaveLength(0);
    } finally { delete process.env.RECUED_PARTIAL_SLOTS; }
  });
});

describe('partial slots — TRAP harness (what the earlier tests could not see)', () => {
  /** ⛔⛔ EVERY EARLIER ASSERTION HERE ASKS "IS THE TRUTH REACHABLE?", WHICH A
   *  MECHANISM THAT RETURNED EVERYTHING WOULD PASS. At ~25 records against a
   *  limit of 20 that is nearly what happens — the truth surfaced in all nine
   *  position cells, and so did 3 of 4 decoys. Nothing was being SELECTED.
   *
   *  This harness gives each decoy a DIFFERENT wrong figure and places it where
   *  an ordering might prefer it, then forces the limit to bind with ambient
   *  filler. It is the only test here that can distinguish "surfaced the
   *  correction" from "surfaced a lot of things, one of which was correct". */
  const world = (truthAge: number, filler: number) => {
    const db = open();
    const t = createCollectionTable({ db, platform: 'mail', slug: 'w' });
    const day = 86_400_000, now = 1_800_000_000_000;
    const put = (id: string, age: number, b: string) => t.upsert({
      record_id: `uid:${id}`, received_at: now - age, modified_at: now - age,
      hot_fields: { from: 'a@b.c', subject: id, is_read: true },
      size_bytes: 10, source_id: `<${id}>`, body_inline: b, origin_actor: 'system',
    });
    for (let i = 0; i < 40; i++) {
      put(`stale${i}`, 300 * day, 'Ridgeway renewal notice. Ridgeway renewal notice period is 30 days.');
    }
    const chat = ['Ridgeway renewal paperwork with finance.', 'Renewal notice template updated.'];
    for (let i = 0; i < filler; i++) put(`f${i}`, (3 + i * 0.1) * day, chat[i % 2]);
    put('TRUTH', truthAge * day, 'ridgeway renewal — now 90 days.');
    put('TRAP_recent', 1 * day, 'Ridgeway renewal — 60 days.');
    put('TRAP_terse', 40 * day, 'Ridgeway 45.');
    return t;
  };
  const page = (truthAge: number, filler: number) => {
    process.env.RECUED_PARTIAL_SLOTS = '1';
    try {
      return world(truthAge, filler)
        .search({ platform: 'mail', slug: 'w', query: 'ridgeway renewal notice', limit: 20 })
        .map((r) => r.record_id);
    } finally { delete process.env.RECUED_PARTIAL_SLOTS; }
  };

  it('finds a correction that is NEWER than the ambient chatter', () => {
    expect(page(0.5, 50).some((i) => i.includes('TRUTH'))).toBe(true);
  });

  it('MISSES a correction older than the chatter, and surfaces decoys instead', () => {
    // ⛔ THE MEASURED CEILING OF THIS WHOLE MECHANISM, AND IT IS STRUCTURAL.
    // A 30-day-old correction loses the recency half to routine traffic that
    // merely mentions the same words, and the relevance half gives it no edge —
    // it is a 2-term match among 2-term filler. A live mailbox ALWAYS has recent
    // chatter sharing those terms, so the window in which partial slots find a
    // correction closes as soon as ordinary traffic accumulates.
    //
    // The 7/7 model result was measured in a fixture with essentially no ambient
    // traffic. This is why it should not be defaulted on.
    const ids = page(30, 50);
    expect(ids.some((i) => i.includes('TRUTH')), 'old correction is unreachable').toBe(false);
    expect(ids.some((i) => i.includes('TRAP_recent')), 'a decoy takes the slot').toBe(true);
  });
});

describe('thread-linked partial lane — the decoy that broke the trap case', () => {
  /** The trap harness above showed the ordering lanes losing to decoys: one
   *  NEWER (wins recency), one TERSER (wins BM25), while the real correction —
   *  30 days old, partially matching — surfaced in neither. No ordering recovers
   *  it, because on both axes the decoys genuinely rank higher.
   *
   *  🔑 A correction is a REPLY. It shares a thread with the record it corrects;
   *  ambient chatter does not. That is structural, cheap, and decides the case
   *  the orderings cannot. */
  const world = (correctionInThread: boolean) => {
    const db = open();
    const t = createCollectionTable({ db, platform: 'mail', slug: 'w' });
    const day = 86_400_000, now = 1_800_000_000_000;
    const put = (id: string, age: number, b: string, thread: string) => t.upsert({
      record_id: `uid:${id}`, received_at: now - age, modified_at: now - age,
      hot_fields: { from: 'a@b.c', subject: id, is_read: true, thread_id: thread },
      size_bytes: 10, source_id: `<${id}>`, body_inline: b, origin_actor: 'system',
    });
    for (let i = 0; i < 40; i++) {
      put(`stale${i}`, 300 * day,
        'Ridgeway renewal notice. Ridgeway renewal notice period is 30 days.', 'T-RENEW');
    }
    const chat = ['Ridgeway renewal paperwork with finance.', 'Renewal notice template updated.'];
    for (let i = 0; i < 50; i++) put(`f${i}`, (3 + i * 0.1) * day, chat[i % 2], `T-CHAT${i}`);
    put('TRUTH', 30 * day, 'ridgeway renewal — now 90 days.',
      correctionInThread ? 'T-RENEW' : 'T-ELSEWHERE');
    put('TRAP_recent', 1 * day, 'Ridgeway renewal — 60 days.', 'T-OTHER');
    put('TRAP_terse', 40 * day, 'Ridgeway 45.', 'T-OTHER2');
    return t;
  };
  const page = (inThread: boolean) => {
    process.env.RECUED_PARTIAL_SLOTS = '1';
    try {
      return world(inThread).search({ platform: 'mail', slug: 'w', query: 'ridgeway renewal notice', limit: 20 })
        .map((r) => r.record_id);
    } finally { delete process.env.RECUED_PARTIAL_SLOTS; }
  };

  it('recovers the correction when it replies in the corrected thread', () => {
    const ids = page(true);
    expect(ids.some((i) => i.includes('TRUTH')), 'thread linkage beats both decoys').toBe(true);
  });

  it('still misses it when the correction is on an unrelated thread', () => {
    // ⛔ THE HONEST REMAINING CEILING. Thread linkage is a real signal, not a
    // general fix: a correction sent as a NEW message, older than the ambient
    // chatter and only partially matching, has nothing left to distinguish it.
    expect(page(false).some((i) => i.includes('TRUTH'))).toBe(false);
  });
});

describe('thread neighbours — the answer that matches NO query term', () => {
  /** ⛔⛔ THE CASE EVERY LEXICAL MECHANISM STRUCTURALLY CANNOT REACH. A thread is
   *  a conversation, and the answer is usually the REPLY:
   *      msg1  "Ridgeway renewal notice period: move from 30d to 90d?"  ← matches
   *      msg2  "no lets be fair & change it to 60d so we can both be happy"
   *  msg2 is the answer and carries NO query term — it is not in the AND set,
   *  not in the relaxed set, not even an OR candidate. Partial slots cannot
   *  reach it; neither can the thread-LINKED lane, which still filters the OR
   *  set. Only pulling thread neighbours regardless of match makes it visible.
   *
   *  It is labelled `thread_context`, not `partial_match`: it shares no
   *  vocabulary with the question, and overstating why it is on the page would
   *  break the same disclose-don't-decide rule the label exists to serve. */
  const convo = () => {
    const db = open();
    const t = createCollectionTable({ db, platform: 'mail', slug: 'w' });
    const day = 86_400_000, now = 1_800_000_000_000;
    const put = (id: string, age: number, b: string, th: string) => t.upsert({
      record_id: `uid:${id}`, received_at: now - age, modified_at: now - age,
      hot_fields: { from: 'a@b.c', subject: id, is_read: true, thread_id: th },
      size_bytes: 10, source_id: `<${id}>`, body_inline: b, origin_actor: 'system',
    });
    put('msg1', 10 * day,
      'Ridgeway renewal notice period: are you sure you want to move from 30d to 90d?', 'T-RENEW');
    put('msg2', 9 * day, 'no lets be fair & change it to 60d so we can both be happy', 'T-RENEW');
    for (let i = 0; i < 30; i++) {
      put(`f${i}`, (3 + i * 0.1) * day, 'Ridgeway renewal paperwork with finance.', `T-CHAT${i}`);
    }
    return t;
  };

  it('reaches a reply that matches nothing, and labels it thread_context', () => {
    process.env.RECUED_PARTIAL_SLOTS = '1';
    try {
      const rows = convo().search({ platform: 'mail', slug: 'w', query: 'ridgeway renewal notice period', limit: 20 });
      const answer = rows.find((r) => r.record_id.includes('msg2'));
      expect(answer, 'the conversational answer must be reachable').toBeDefined();
      expect(answer?.thread_context).toBe(true);
      expect(answer?.partial_match, 'it matched NO term — not a partial match')
        .toBeUndefined();
    } finally { delete process.env.RECUED_PARTIAL_SLOTS; }
  });

  it('pulls no neighbours when nothing matched in the first place', () => {
    process.env.RECUED_PARTIAL_SLOTS = '1';
    try {
      expect(convo().search({ platform: 'mail', slug: 'w', query: 'kestrel braidwood', limit: 20 })).toHaveLength(0);
    } finally { delete process.env.RECUED_PARTIAL_SLOTS; }
  });
});
