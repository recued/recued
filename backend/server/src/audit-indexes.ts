/** Phase B: json_extract indexes for the audit-retention pruner.
 *
 *  The audit log is stored via `createSQLiteCollection` as opaque JSON.
 *  The Phase B retention pruner (audit-retention.ts, Commit 7) selects
 *  rows by `started_at` / `timestamp` age AND excludes reserve-class
 *  rows; without these indexes those predicates require a full-table
 *  scan + JSON parse per row, which becomes the dominant cost on large
 *  logs.
 *
 *  All indexes are idempotent (`IF NOT EXISTS`) — safe to call on every
 *  boot. No data migration needed: rows written before Phase B have
 *  `reserve` absent, which the pruner treats as non-reserve. */

import type Database from 'better-sqlite3';

import { ensureAuditUsageCounter } from './audit-usage-counter.js';

export const ensureAuditIndexes = (db: Database.Database): void => {
  // ⚠ Same lifecycle as the indexes — every caller that ensures audit indexes
  // is a caller that has the audit tables, and the counter is useless without
  // them. Piggy-backing here means an existing install picks it up on its next
  // boot with no separate migration step to forget.
  ensureAuditUsageCounter(db);
  db.exec(`
    CREATE INDEX IF NOT EXISTS audit_entries_reserve_idx
      ON audit_entries (json_extract(data, '$.reserve'));
    CREATE INDEX IF NOT EXISTS audit_entries_started_at_idx
      ON audit_entries (json_extract(data, '$.started_at'));
    CREATE INDEX IF NOT EXISTS audit_activities_reserve_idx
      ON audit_activities (json_extract(data, '$.reserve'));
    CREATE INDEX IF NOT EXISTS audit_activities_timestamp_idx
      ON audit_activities (json_extract(data, '$.timestamp'));
    -- The execution-case compiler filters the WHOLE audit log on these two
    -- expressions (execution-case-compiler.ts listRecipeAuditEntries /
    -- listChatToolCallActivities), so without these its cost rises with
    -- everything the server has recently done rather than with the case being
    -- compiled.
    --
    -- SIZED, not unbounded: audit.quota.bytes caps this surface and the size
    -- pass keeps it near 70% of that.
    -- ⚠ THAT CAP MOVED. This comment said "50MB by default ... so ~70-100k
    -- rows", which was true when written; D-230 raised the default to 5 GB, so
    -- the same reasoning now allows ~7.5M rows -- two orders of magnitude more.
    -- Do not re-derive a row count here: quote the KEY, not the number, or the
    -- next re-scale leaves this stale again.
    --
    -- Justification measured rather than asserted: +1.10us per audit write and
    -- ~1MB of index on a 35MB table (+3%). Break-even is ~8,150 audit writes
    -- per compile. compileReport() runs per execution report (chat turns,
    -- feedback, verification) while audit rows come from every recipe run, so a
    -- heavily automated server with little chat use can exceed that ratio --
    -- but at 1.10us and 1MB the worst case is still negligible.
    -- PARTIAL: only chat-channel entries and chat_tool_call activities are ever
    -- looked up this way, and they are a small slice of the log, so a full
    -- index would make every unrelated audit write pay for them.
    CREATE INDEX IF NOT EXISTS audit_entries_exec_channel_idx
      ON audit_entries (json_extract(data, '$.execution_source.channel'))
      WHERE json_extract(data, '$.execution_source.channel') IS NOT NULL;
    CREATE INDEX IF NOT EXISTS audit_activities_action_idx
      ON audit_activities (json_extract(data, '$.action'))
      WHERE json_extract(data, '$.action') IS NOT NULL;
    -- COMPOSITE, because the per-action read-backs are
    -- "latest row for this action": an action filter plus ORDER BY timestamp
    -- DESC LIMIT 1. The single-column index above turns the filter into a
    -- seek but still sorts the matches; carrying timestamp makes the whole
    -- thing an index seek returning one row.
    -- Measured on the lifecycle-drain read at 700k rows:
    --   no index 126.87ms | action only 0.43ms | composite 0.01ms
    CREATE INDEX IF NOT EXISTS audit_activities_action_ts_idx
      ON audit_activities (json_extract(data, '$.action'), json_extract(data, '$.timestamp') DESC)
      WHERE json_extract(data, '$.action') IS NOT NULL;
    -- Per-case compile anchors on (chat_session_id, turn_id). Without this the
    -- compiler read EVERY chat-channel entry and filtered in JS; the byte quota
    -- was the only bound, and D-230 raised it 50 MB -> 8 GiB.
    -- Measured over 100k rows / 40k chat-channel, one root request's 5 turns:
    --   whole-table + JS filter 165.00ms (40,000 rows, ~29 MB retained)
    --   pushdown, no index        37.89ms (10 rows)
    --   pushdown, this index       0.03ms (10 rows)
    -- PARTIAL on channel = 'chat' so non-chat runs -- the bulk of the log on an
    -- automation-heavy server -- pay nothing to maintain it.
    -- ⚠ The = 'chat' here is a LITERAL, not IS NOT NULL: a partial index is
    -- only usable when the query repeats its WHERE clause, and the compiler's
    -- query filters on that exact literal.
    CREATE INDEX IF NOT EXISTS audit_entries_chat_turn_idx
      ON audit_entries (
        json_extract(data, '$.execution_source.chat_session_id'),
        json_extract(data, '$.execution_source.turn_id'))
      WHERE json_extract(data, '$.execution_source.channel') = 'chat';
  `);
};
