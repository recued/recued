/** Explicit user outcome signals for D-214.
 *
 * These are product-produced facts, distinct from plan acceptance. Payloads
 * contain no free text or tool arguments.
 */

import type Database from 'better-sqlite3';
import {
  isExecutionCaseFeedbackKind,
  type ExecutionCaseFeedbackKind,
} from '@recued/contracts';

export interface ExecutionCaseFeedback {
  feedback_id: string;
  root_request_id: string;
  session_id: string;
  kind: ExecutionCaseFeedbackKind;
  source_plan_id?: string;
  recorded_at: number;
}

export const ensureExecutionCaseFeedbackSchema = (
  db: Database.Database,
): void => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS execution_case_feedback (
      feedback_id      TEXT PRIMARY KEY,
      root_request_id  TEXT NOT NULL,
      session_id       TEXT NOT NULL,
      kind             TEXT NOT NULL,
      source_plan_id   TEXT,
      recorded_at      INTEGER NOT NULL
    );

    -- D-219 lookups and cascade deletes are BY ROOT, and this table carried no
    -- index. Every one was a full scan; a retention pass removing N roots did
    -- N scans -- the quadratic shape fixed in audit-retention. Grows with chat.
    CREATE INDEX IF NOT EXISTS idx_exec_case_feedback_root
      ON execution_case_feedback (root_request_id);
  `);
};

interface FeedbackRow {
  feedback_id: string;
  root_request_id: string;
  session_id: string;
  kind: string;
  source_plan_id: string | null;
  recorded_at: number;
}

export interface ExecutionCaseFeedbackStore {
  record(value: ExecutionCaseFeedback): boolean;
  listForRoot(root_request_id: string): ExecutionCaseFeedback[];
  deleteExact(input: {
    feedback_id: string;
    root_request_id: string;
  }): boolean;
  deleteForRoot(root_request_id: string): number;
}

export const createExecutionCaseFeedbackStore = (
  db: Database.Database,
): ExecutionCaseFeedbackStore => {
  ensureExecutionCaseFeedbackSchema(db);
  const insert = db.prepare(`
    INSERT INTO execution_case_feedback (
      feedback_id, root_request_id, session_id, kind, source_plan_id,
      recorded_at
    ) VALUES (
      @feedback_id, @root_request_id, @session_id, @kind, @source_plan_id,
      @recorded_at
    )
    ON CONFLICT (feedback_id) DO NOTHING
  `);
  const list = db.prepare(`
    SELECT * FROM execution_case_feedback
     WHERE root_request_id = ?
     ORDER BY recorded_at ASC, feedback_id ASC
  `);
  const removeExact = db.prepare(`
    DELETE FROM execution_case_feedback
     WHERE feedback_id = @feedback_id
       AND root_request_id = @root_request_id
  `);
  const remove = db.prepare(`
    DELETE FROM execution_case_feedback WHERE root_request_id = ?
  `);
  const fromRow = (row: FeedbackRow): ExecutionCaseFeedback => {
    if (!isExecutionCaseFeedbackKind(row.kind)) {
      throw new Error(
        `execution-case-feedback-store: invalid kind ${row.kind}`,
      );
    }
    return {
      feedback_id: row.feedback_id,
      root_request_id: row.root_request_id,
      session_id: row.session_id,
      kind: row.kind,
      ...(row.source_plan_id !== null
        ? { source_plan_id: row.source_plan_id }
        : {}),
      recorded_at: row.recorded_at,
    };
  };
  return {
    record(value) {
      if (
        !value.feedback_id
        || !value.root_request_id
        || !value.session_id
        || !isExecutionCaseFeedbackKind(value.kind)
        || !Number.isFinite(value.recorded_at)
      ) throw new Error('execution-case-feedback-store: invalid feedback');
      return insert.run({
        ...value,
        source_plan_id: value.source_plan_id ?? null,
      }).changes === 1;
    },
    listForRoot(root_request_id) {
      return (list.all(root_request_id) as FeedbackRow[]).map(fromRow);
    },
    deleteExact(input) {
      if (!input.feedback_id || !input.root_request_id) {
        throw new Error('execution-case-feedback-store: invalid deletion');
      }
      return removeExact.run(input).changes === 1;
    },
    deleteForRoot(root_request_id) {
      return remove.run(root_request_id).changes;
    },
  };
};
