/** D-214 immutable source-bound outcome reports.
 *
 * Model-authored fields are sealed separately from server correlation. The
 * observation projection is attached asynchronously and never exposed through
 * a model-facing read.
 */

import type Database from 'better-sqlite3';
import {
  isOutcomeClaim,
  type ExecutionObservation,
  type OutcomeClaim,
  type OutcomeReport,
} from '@recued/contracts';

import {
  openD214Json,
  sealD214Json,
  type D214KeyProvider,
} from './d214-sealed-json.js';

export const EXECUTION_REPORTS_TABLE = 'execution_reports';

export const ensureExecutionReportSchema = (db: Database.Database): void => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS execution_reports (
      report_id                       TEXT PRIMARY KEY,
      execution_span_id               TEXT NOT NULL,
      root_request_id                 TEXT NOT NULL,
      session_id                      TEXT NOT NULL,
      governing_contract_id           TEXT NOT NULL,
      principal_key                   TEXT,
      policy_fingerprint              TEXT NOT NULL,
      first_event_id                  TEXT NOT NULL,
      last_event_id                   TEXT NOT NULL,
      model_claim                     TEXT NOT NULL,
      root_request_encrypted          TEXT NOT NULL,
      open_items_encrypted            TEXT NOT NULL,
      consulted_case_keys_encrypted   TEXT NOT NULL,
      observation_encrypted           TEXT,
      reported_at                     INTEGER NOT NULL,
      closed_at                       INTEGER,
      server_finalized                INTEGER NOT NULL DEFAULT 0,
      pending_reason                  TEXT
    );
  `);
};

interface ReportRow {
  report_id: string;
  execution_span_id: string;
  root_request_id: string;
  session_id: string;
  governing_contract_id: string;
  principal_key: string | null;
  policy_fingerprint: string;
  first_event_id: string;
  last_event_id: string;
  model_claim: string;
  root_request_encrypted: string;
  open_items_encrypted: string;
  consulted_case_keys_encrypted: string;
  observation_encrypted: string | null;
  reported_at: number;
  closed_at: number | null;
  server_finalized: number;
  pending_reason: string | null;
}

export interface StoredExecutionReport {
  report: OutcomeReport;
  session_id: string;
  closed_at?: number;
  server_finalized: boolean;
  policy_fingerprint: string;
  pending_reason?: string;
  observation?: ExecutionObservation;
}

export interface PutExecutionReportInput {
  report_id: string;
  execution_span_id: string;
  root_request_id: string;
  session_id: string;
  governing_contract_id: string;
  principal_key?: string;
  policy_fingerprint: string;
  root_request: string;
  first_event_id: string;
  last_event_id: string;
  model_claim: OutcomeClaim;
  open_items: string[];
  consulted_case_keys: string[];
  reported_at: number;
  closed_at?: number;
  server_finalized?: boolean;
  pending_reason?: string;
}

export interface ExecutionReportStore {
  putImmutable(input: PutExecutionReportInput): Promise<boolean>;
  get(report_id: string): Promise<StoredExecutionReport | undefined>;
  listAll(): Promise<StoredExecutionReport[]>;
  /** Unsealed compiler coverage boundary for the hot-path currency check. */
  closedReportIds(): string[];
  /** ⛔ EVERY report id, sealed payloads UNTOUCHED.
   *
   *  `rebuildMaterialized` needs one thing from the report table — the set of
   *  ids that still exist — and it used to get it from `listAll()`, which opens
   *  FOUR AEAD-sealed fields per row. Measured over 200 sequential turns that
   *  was the single largest per-turn cost (~6.3 ms/compile at 100 reports, and
   *  growing with the corpus), spent entirely to discard the plaintext.
   *
   *  ⚠ Deliberately ALL ids, not `closedReportIds()`. Every source report is
   *  closed today, so the two agree — but that is a property of another
   *  function, and an existence check that silently means "exists AND closed"
   *  is the kind of unreachable-therefore-fine reasoning that stops being true
   *  without anything failing. */
  allReportIds(): string[];
  listForRoot(root_request_id: string): Promise<StoredExecutionReport[]>;
  close(
    report_id: string,
    input: {
      closed_at: number;
      first_event_id: string;
      last_event_id: string;
      policy_fingerprint: string;
      consulted_case_keys: string[];
    },
  ): Promise<boolean>;
  attachObservation(
    report_id: string,
    observation: ExecutionObservation,
  ): Promise<boolean>;
  clearObservation(report_id: string): boolean;
  delete(report_id: string): boolean;
}

export const createExecutionReportStore = (
  db: Database.Database,
  keyProvider?: D214KeyProvider,
): ExecutionReportStore => {
  ensureExecutionReportSchema(db);
  const insert = db.prepare(`
    INSERT INTO execution_reports (
      report_id, execution_span_id, root_request_id, session_id,
      governing_contract_id, principal_key, first_event_id, last_event_id,
      policy_fingerprint,
      model_claim, root_request_encrypted, open_items_encrypted,
      consulted_case_keys_encrypted, observation_encrypted, reported_at,
      closed_at, server_finalized, pending_reason
    ) VALUES (
      @report_id, @execution_span_id, @root_request_id, @session_id,
      @governing_contract_id, @principal_key, @first_event_id, @last_event_id,
      @policy_fingerprint,
      @model_claim, @root_request_encrypted, @open_items_encrypted,
      @consulted_case_keys_encrypted, NULL, @reported_at,
      @closed_at, @server_finalized, @pending_reason
    )
    ON CONFLICT (report_id) DO NOTHING
  `);
  const select = db.prepare(
    'SELECT * FROM execution_reports WHERE report_id = ?',
  );
  const selectAll = db.prepare(`
    SELECT * FROM execution_reports
    ORDER BY reported_at ASC, report_id ASC
  `);
  const selectAllIds = db.prepare(`
    SELECT report_id FROM execution_reports ORDER BY report_id ASC
  `);
  const selectClosedIds = db.prepare(`
    SELECT report_id
      FROM execution_reports
     WHERE closed_at IS NOT NULL
     ORDER BY report_id ASC
  `);
  const selectForRoot = db.prepare(`
    SELECT * FROM execution_reports
    WHERE root_request_id = ?
    ORDER BY reported_at ASC, report_id ASC
  `);
  const closeRow = db.prepare(`
    UPDATE execution_reports
       SET closed_at = @closed_at,
           first_event_id = @first_event_id,
           last_event_id = @last_event_id,
           policy_fingerprint = @policy_fingerprint,
           consulted_case_keys_encrypted = @consulted_case_keys_encrypted,
           pending_reason = NULL
     WHERE report_id = @report_id
       AND closed_at IS NULL
  `);
  const attach = db.prepare(`
    UPDATE execution_reports
       SET observation_encrypted = @observation_encrypted
     WHERE report_id = @report_id
       AND closed_at IS NOT NULL
  `);
  const clearAttachedObservation = db.prepare(`
    UPDATE execution_reports
       SET observation_encrypted = NULL
     WHERE report_id = ?
       AND closed_at IS NOT NULL
  `);
  const remove = db.prepare(
    'DELETE FROM execution_reports WHERE report_id = ?',
  );

  const decode = async (row: ReportRow): Promise<StoredExecutionReport> => {
    if (!isOutcomeClaim(row.model_claim)) {
      throw new Error(
        `execution-report-store: invalid model_claim for ${row.report_id}`,
      );
    }
    const [root_request, open_items, consulted_case_keys, observation] =
      await Promise.all([
        openD214Json<string>(
          row.root_request_encrypted,
          'report-root',
          row.report_id,
          keyProvider,
        ),
        openD214Json<string[]>(
          row.open_items_encrypted,
          'report-open-items',
          row.report_id,
          keyProvider,
        ),
        openD214Json<string[]>(
          row.consulted_case_keys_encrypted,
          'report-consulted',
          row.report_id,
          keyProvider,
        ),
        row.observation_encrypted === null
          ? Promise.resolve(undefined)
          : openD214Json<ExecutionObservation>(
              row.observation_encrypted,
              'report-observation',
              row.report_id,
              keyProvider,
            ),
      ]);
    return {
      report: {
        report_id: row.report_id,
        execution_span_id: row.execution_span_id,
        governing_contract_id: row.governing_contract_id,
        ...(row.principal_key !== null
          ? { principal_key: row.principal_key }
          : {}),
        root_request_id: row.root_request_id,
        root_request,
        event_range: {
          first_event_id: row.first_event_id,
          last_event_id: row.last_event_id,
        },
        model_claim: row.model_claim,
        open_items,
        consulted_case_keys,
        reported_at: row.reported_at,
      },
      session_id: row.session_id,
      ...(row.closed_at !== null ? { closed_at: row.closed_at } : {}),
      server_finalized: row.server_finalized === 1,
      policy_fingerprint: row.policy_fingerprint,
      ...(row.pending_reason !== null
        ? { pending_reason: row.pending_reason }
        : {}),
      ...(observation !== undefined ? { observation } : {}),
    };
  };

  return {
    async putImmutable(input) {
      const [
        root_request_encrypted,
        open_items_encrypted,
        consulted_case_keys_encrypted,
      ] = await Promise.all([
        sealD214Json(
          input.root_request,
          'report-root',
          input.report_id,
          keyProvider,
        ),
        sealD214Json(
          input.open_items,
          'report-open-items',
          input.report_id,
          keyProvider,
        ),
        sealD214Json(
          [...new Set(input.consulted_case_keys)],
          'report-consulted',
          input.report_id,
          keyProvider,
        ),
      ]);
      const result = insert.run({
        ...input,
        principal_key: input.principal_key ?? null,
        root_request_encrypted,
        open_items_encrypted,
        consulted_case_keys_encrypted,
        closed_at: input.closed_at ?? null,
        server_finalized: input.server_finalized ? 1 : 0,
        pending_reason: input.pending_reason ?? null,
      });
      return result.changes === 1;
    },

    async get(report_id) {
      const row = select.get(report_id) as ReportRow | undefined;
      return row ? decode(row) : undefined;
    },

    async listAll() {
      return Promise.all((selectAll.all() as ReportRow[]).map(decode));
    },

    closedReportIds() {
      return (selectClosedIds.all() as Array<{ report_id: string }>)
        .map((row) => row.report_id);
    },

    allReportIds() {
      return (selectAllIds.all() as Array<{ report_id: string }>)
        .map((row) => row.report_id);
    },

    async listForRoot(root_request_id) {
      return Promise.all(
        (selectForRoot.all(root_request_id) as ReportRow[]).map(decode),
      );
    },

    async close(report_id, input) {
      const consulted_case_keys_encrypted = await sealD214Json(
        [...new Set(input.consulted_case_keys)],
        'report-consulted',
        report_id,
        keyProvider,
      );
      const result = closeRow.run({
        report_id,
        ...input,
        consulted_case_keys_encrypted,
      });
      return result.changes === 1;
    },

    async attachObservation(report_id, observation) {
      const observation_encrypted = await sealD214Json(
        observation,
        'report-observation',
        report_id,
        keyProvider,
      );
      return attach.run({ report_id, observation_encrypted }).changes === 1;
    },

    clearObservation(report_id) {
      return clearAttachedObservation.run(report_id).changes === 1;
    },

    delete(report_id) {
      return remove.run(report_id).changes === 1;
    },
  };
};
