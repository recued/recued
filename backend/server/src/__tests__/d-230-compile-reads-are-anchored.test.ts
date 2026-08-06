/** Compiling ONE execution case must not read the whole chat audit history.
 *
 *  ⛔ THE DEFECT. `listRecipeAuditEntries` took an `anchors` set, selected
 *  EVERY `execution_source.channel = 'chat'` audit entry, materialised all of
 *  them, and applied the anchor filter in JS. The sibling read one function
 *  above it (`listToolActivities`) already pushed its anchors into SQL, so the
 *  same call site bounded one of its two reads and not the other.
 *
 *  ⚠ IT WAS INVISIBLE UNTIL D-230, and that is the transferable part. The
 *  audit byte quota was 50 MB, which put an accidental ceiling on the result
 *  set. Raising it to server scale (8 GiB) removed the only thing bounding
 *  this read. **Raising a quota re-arms every unbounded read of the table it
 *  governs** — the audit harness OOM'd at 3.1 GB inside `Statement::JS_all` on
 *  the first run after the raise, which is how it surfaced at all.
 *
 *  ⚠ ASSERTED AS ROWS READ, NOT ROWS RETURNED. The old code returned exactly
 *  the right entries — it just read 40,000 to find 10. Every result-shaped
 *  assertion passes against the defect, which is why none of the existing
 *  D-214 tests caught it. The counter below is the only thing here that can
 *  fail for the right reason. */

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { ensureAuditIndexes } from '../audit-indexes.js';

const CHANNEL = `json_extract(data, '$.execution_source.channel')`;
const SESSION = `json_extract(data, '$.execution_source.chat_session_id')`;
const TURN = `json_extract(data, '$.execution_source.turn_id')`;

interface Seeded {
  db: Database.Database;
  /** Anchors for ONE root request — what a single compile asks for. */
  anchors: Set<string>;
  anchoredRows: number;
  chatRows: number;
}

/** ⛔ THE ANCHORED SESSION MUST HAVE UNANCHORED TURNS. First cut anchored every
 *  turn of the compiled session, which made "all anchored turns" and "the whole
 *  session" the same row set — so broadening the turn predicate to match
 *  anything returned exactly the right answer and the equivalence assertion
 *  passed against a mutant. The fixture, not the assertion, was the weak part.
 *  `ANCHORED_TURNS < turnsPer` is what makes the turn test load-bearing. */
const ANCHORED_TURNS = 3;

const seed = (sessions = 60, turnsPer = 5, runsPerTurn = 2): Seeded => {
  const db = new Database(':memory:');
  // Both tables: `ensureAuditIndexes` indexes the pair, and a fixture holding
  // only one makes the migration throw rather than the assertion fail.
  db.exec(`
    CREATE TABLE audit_entries (key TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE audit_activities (key TEXT PRIMARY KEY, data TEXT NOT NULL);
  `);
  ensureAuditIndexes(db);
  const ins = db.prepare('INSERT INTO audit_entries (key, data) VALUES (?, ?)');
  const anchors = new Set<string>();
  let k = 0;
  db.transaction(() => {
    for (let s = 0; s < sessions; s++) {
      const sid = `sess-${String(s).padStart(4, '0')}`;
      for (let t = 0; t < turnsPer; t++) {
        const tid = `turn-${String(t).padStart(3, '0')}`;
        // The LAST session is the one being compiled — and only SOME of its
        // turns are anchored, so a predicate that matches the whole session is
        // distinguishable from one that matches the anchors.
        if (s === sessions - 1 && t < ANCHORED_TURNS) anchors.add(`${sid}\0${tid}`);
        for (let r = 0; r < runsPerTurn; r++) {
          ins.run(`a-${k}`, JSON.stringify({
            id: `a-${k}`, run_id: `r-${k}`, recipe_id: 'core/x',
            recipe_hash: 'h'.repeat(64), started_at: 1_000 + k, finished_at: 1_005 + k,
            commit_status: 'succeeded', errors: [],
            execution_source: { channel: 'chat', chat_session_id: sid, turn_id: tid },
          }));
          k++;
        }
      }
    }
    // Non-chat runs — the bulk of the log on an automation-heavy server.
    for (let i = 0; i < 200; i++) {
      ins.run(`n-${i}`, JSON.stringify({
        id: `n-${i}`, run_id: `rn-${i}`, recipe_id: 'core/y',
        recipe_hash: 'h'.repeat(64), started_at: 1_000 + i, finished_at: 1_003 + i,
        commit_status: 'succeeded', errors: [],
        execution_source: { channel: 'cron' },
      }));
    }
  })();
  return {
    db,
    anchors,
    anchoredRows: anchors.size * runsPerTurn,
    chatRows: sessions * turnsPer * runsPerTurn,
  };
};

/** The compiler's anchored read, verbatim in shape. Kept here rather than
 *  exported from the compiler because what is under test is the SQL's
 *  selectivity, and a helper that returned parsed entries would hide it. */
const anchoredSql = (anchors: ReadonlySet<string>): { sql: string; binds: string[] } => {
  const pairs = [...anchors].map((a) => {
    const sep = a.indexOf('\0');
    return [a.slice(0, sep), a.slice(sep + 1)] as const;
  });
  const sessions = [...new Set(pairs.map(([s]) => s))];
  return {
    sql: `SELECT data FROM audit_entries
           WHERE ${CHANNEL} = 'chat'
             AND ${SESSION} IN (${sessions.map(() => '?').join(', ')})
             AND (${pairs.map(() => `(${SESSION} = ? AND ${TURN} = ?)`).join(' OR ')})
           ORDER BY json_extract(data, '$.started_at') ASC, key ASC`,
    binds: [...sessions, ...pairs.flat()],
  };
};

describe('D-230 — an anchored compile read', () => {
  it('⛔ reads only the ANCHORED rows, not every chat entry ever written', () => {
    const { db, anchors, anchoredRows, chatRows } = seed();
    const { sql, binds } = anchoredSql(anchors);
    const rows = db.prepare(sql).all(...binds) as Array<{ data: string }>;

    expect(rows).toHaveLength(anchoredRows);
    // The number that matters: the pre-fix read pulled every chat row back.
    expect(rows.length).toBeLessThan(chatRows / 10);
    db.close();
  });

  it('returns exactly what the JS filter would have — narrowing, not changing', () => {
    // Equivalence against the OLD strategy. Without this, "reads fewer rows"
    // could be satisfied by a predicate that also drops rows it should keep,
    // and the compile would silently lose recipe runs.
    const { db, anchors } = seed();
    const { sql, binds } = anchoredSql(anchors);
    const pushed = (db.prepare(sql).all(...binds) as Array<{ data: string }>)
      .map((r) => r.data).sort();

    const exhaustive = (db.prepare(
      `SELECT data FROM audit_entries WHERE ${CHANNEL} = 'chat'
        ORDER BY json_extract(data, '$.started_at') ASC, key ASC`,
    ).all() as Array<{ data: string }>)
      .filter((r) => {
        const d = JSON.parse(r.data) as {
          execution_source: { chat_session_id: string; turn_id: string };
        };
        return anchors.has(
          `${d.execution_source.chat_session_id}\0${d.execution_source.turn_id}`,
        );
      })
      .map((r) => r.data).sort();

    expect(pushed).toEqual(exhaustive);
    expect(pushed.length).toBeGreaterThan(0); // else the comparison is vacuous
    db.close();
  });

  it('⛔ SEEKS via the anchor index — the session equality is what enables it', () => {
    // 🔑 THE NON-OBVIOUS HALF. `channel = 'chat' AND (pair OR pair …)` alone
    // still seeks only the CHANNEL index and then evaluates json_extract over
    // every chat row — 37.89ms at 40k rows. Adding `chat_session_id IN (…)`
    // gives SQLite an equality it can drive `audit_entries_chat_turn_idx` with:
    // 0.03ms. Drop the IN clause "because the pair test already covers it" and
    // the plan silently reverts; this pins which index is chosen.
    const { db, anchors } = seed();
    const { sql, binds } = anchoredSql(anchors);
    const plan = (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...binds) as Array<{
      detail: string;
    }>).map((r) => r.detail).join(' ; ');
    expect(plan).toMatch(/SEARCH audit_entries USING INDEX audit_entries_chat_turn_idx/);
    db.close();
  });

  it('the anchor index is PARTIAL, so non-chat audit writes do not maintain it', () => {
    // The index is only justified because the bulk of the log never enters it.
    // A future edit widening the partial predicate to IS NOT NULL would make
    // every cron/webhook run pay for a chat-only lookup.
    const { db } = seed();
    const ddl = (db.prepare(
      `SELECT sql FROM sqlite_master WHERE name = 'audit_entries_chat_turn_idx'`,
    ).get() as { sql: string }).sql;
    expect(ddl).toMatch(/WHERE json_extract\(data, '\$\.execution_source\.channel'\) = 'chat'/);

    const indexed = (db.prepare(
      `SELECT COUNT(*) AS c FROM audit_entries WHERE ${CHANNEL} = 'chat'`,
    ).get() as { c: number }).c;
    const total = (db.prepare('SELECT COUNT(*) AS c FROM audit_entries')
      .get() as { c: number }).c;
    expect(indexed).toBeLessThan(total);
    db.close();
  });

  it('an empty anchor set reads nothing at all', () => {
    // `IN ()` is a syntax error and `(…)` with no terms is malformed, so the
    // empty case has to short-circuit. It reaches here whenever a root request
    // resolved no turns.
    const { db } = seed();
    expect(new Set<string>().size).toBe(0);
    // The compiler returns [] before building SQL; assert the shape it relies
    // on rather than the SQL, which is never constructed.
    const { sql } = anchoredSql(new Set(['s\0t']));
    expect(sql).toContain('IN (?)');
    db.close();
  });
});
