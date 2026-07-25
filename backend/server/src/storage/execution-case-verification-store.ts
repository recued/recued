/** Trusted deterministic postcondition facts consumed by D-214.
 *
 * This is an internal producer port, not a chat tool or public RPC. It stores
 * only a closed verdict plus opaque postcondition/source identifiers; raw
 * verifier output and external error text never enter D-214.
 */

import type Database from 'better-sqlite3';

export type ExecutionCaseVerificationKind = 'passed' | 'failed';

export interface ExecutionCaseVerification {
  verification_id: string;
  root_request_id: string;
  session_id: string;
  kind: ExecutionCaseVerificationKind;
  postcondition_key: string;
  source_event_id: string;
  recorded_at: number;
}

export interface ExecutionCaseVerificationStore {
  record(value: ExecutionCaseVerification): boolean;
  listForRoot(root_request_id: string): ExecutionCaseVerification[];
  deleteForRoot(root_request_id: string): number;
}

export const createExecutionCaseVerificationStore = (
  db: Database.Database,
): ExecutionCaseVerificationStore => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS execution_case_verifications (
      verification_id   TEXT PRIMARY KEY,
      root_request_id   TEXT NOT NULL,
      session_id        TEXT NOT NULL,
      kind              TEXT NOT NULL,
      postcondition_key TEXT NOT NULL,
      source_event_id   TEXT NOT NULL,
      recorded_at       INTEGER NOT NULL,
      UNIQUE (root_request_id, postcondition_key, source_event_id)
    );
  `);
  const insert = db.prepare(`
    INSERT INTO execution_case_verifications (
      verification_id, root_request_id, session_id, kind,
      postcondition_key, source_event_id, recorded_at
    ) VALUES (
      @verification_id, @root_request_id, @session_id, @kind,
      @postcondition_key, @source_event_id, @recorded_at
    )
    ON CONFLICT DO NOTHING
  `);
  const list = db.prepare(`
    SELECT * FROM execution_case_verifications
     WHERE root_request_id = ?
     ORDER BY recorded_at ASC, verification_id ASC
  `);
  const remove = db.prepare(`
    DELETE FROM execution_case_verifications WHERE root_request_id = ?
  `);
  return {
    record(value) {
      if (
        !value.verification_id
        || !value.root_request_id
        || !value.session_id
        || (value.kind !== 'passed' && value.kind !== 'failed')
        || !value.postcondition_key
        || !value.source_event_id
        || !Number.isFinite(value.recorded_at)
      ) throw new Error('execution-case-verification-store: invalid fact');
      return insert.run(value).changes === 1;
    },
    listForRoot(root_request_id) {
      return list.all(root_request_id) as ExecutionCaseVerification[];
    },
    deleteForRoot(root_request_id) {
      return remove.run(root_request_id).changes;
    },
  };
};
