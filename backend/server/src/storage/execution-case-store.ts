/** D-214 source observations and materialized ExecutionCase aggregates.
 *
 * There is deliberately no retrieval index. Candidate generation performs a
 * bounded scoped decrypt-and-scan through this store; the schema contains only
 * primary/unique constraints needed for identity and source joins.
 */

import type Database from 'better-sqlite3';
import type { ExecutionCase } from '@recued/contracts';

// ⛔ The key derivation is IMPORTED, never re-implemented. The compiler groups
// observations with these exact two functions; a local copy here would let the
// scoped read and the rebuild disagree about which rows belong to a case.
import {
  executionCaseKey,
  requestShapeHash,
  type CaseSourceObservation,
} from '../execution-case-core.js';
import {
  openD214Json,
  sealD214Json,
  type D214KeyProvider,
} from './d214-sealed-json.js';

export const EXECUTION_CASES_TABLE = 'execution_cases';
export const EXECUTION_CASE_SOURCES_TABLE = 'execution_case_sources';
export const EXECUTION_CASE_OBSERVATIONS_TABLE =
  'execution_case_observations';
export const EXECUTION_CASE_COMPILER_STATE_TABLE =
  'execution_case_compiler_state';
export const EXECUTION_CASE_COMPILED_REPORTS_TABLE =
  'execution_case_compiled_reports';

export const ensureExecutionCaseSchema = (db: Database.Database): void => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS execution_case_observations (
      observation_id          TEXT PRIMARY KEY,
      report_id               TEXT NOT NULL,
      root_request_id         TEXT NOT NULL,
      governing_contract_id   TEXT NOT NULL,
      principal_key           TEXT NOT NULL,
      observed_at             INTEGER NOT NULL,
      payload_encrypted       TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS execution_cases (
      case_id                         TEXT PRIMARY KEY,
      case_key                        TEXT NOT NULL UNIQUE,
      governing_contract_id           TEXT NOT NULL,
      principal_key                   TEXT NOT NULL,
      request_shape_hash              TEXT NOT NULL,
      policy_fingerprint              TEXT NOT NULL,
      compiler_version                INTEGER NOT NULL,
      superseded_by                   TEXT,
      first_seen_at                   INTEGER NOT NULL,
      last_seen_at                    INTEGER NOT NULL,
      payload_encrypted               TEXT NOT NULL,
      representative_prompt_encrypted TEXT
    );

    CREATE TABLE IF NOT EXISTS execution_case_sources (
      case_id     TEXT NOT NULL,
      report_id   TEXT NOT NULL,
      PRIMARY KEY (case_id, report_id),
      FOREIGN KEY (case_id)
        REFERENCES execution_cases (case_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS execution_case_compiler_state (
      singleton        INTEGER PRIMARY KEY CHECK (singleton = 1),
      compiler_version INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS execution_case_compiled_reports (
      report_id        TEXT PRIMARY KEY,
      compiler_version INTEGER NOT NULL
    );
  `);
  // ⛔ D-219 — `case_key` in PLAINTEXT on the observation row, so one compile can
  // read the observations of the keys it touched instead of decrypting the whole
  // corpus. Measured: the full scan was ~6 ms per compile at 100 observations and
  // rising, i.e. quadratic over a session's life.
  //
  // ⚠ NO NEW EXPOSURE. `case_key` is already a plaintext UNIQUE column on
  // `execution_cases`; it is a hash over (contract, principal, request-shape
  // hash, policy fingerprint) and carries no prompt text. This adds a second
  // copy of a value the same database already stores in the clear, not a new
  // class of readable data.
  //
  // ⚠ NULLABLE, and that is the migration. A row written before this column
  // existed has none, and the compiler treats "any affected row without a key"
  // as "cannot scope — do the full rebuild". Backfilling would mean decrypting
  // the corpus at boot; the next full recompile writes them anyway.
  //
  // ⛔ AND NO INDEX ON IT, deliberately. A22 forbids adding an index to these
  // tables until the D-213 §6.4 bar is cleared (no decrypted text outside the
  // realm encryption, plus measured RSS against a real corpus), and a ratchet in
  // `d-214-execution-case-integration` pins it. The index is not what the fix
  // needed: the cost being removed is the AEAD OPEN PER ROW (~0.06 ms), not the
  // row scan (microseconds for a short TEXT compare over a retention-bounded
  // table). If the scan ever becomes the bottleneck, that is the moment to clear
  // the bar with measurements — not before.
  const observationColumns = new Set(
    (db.prepare(`PRAGMA table_info(${EXECUTION_CASE_OBSERVATIONS_TABLE})`).all() as
      Array<{ name: string }>).map((row) => row.name),
  );
  if (!observationColumns.has('case_key')) {
    db.exec(`
      ALTER TABLE execution_case_observations ADD COLUMN case_key TEXT;
    `);
  }
};

interface ObservationRow {
  observation_id: string;
  report_id: string;
  payload_encrypted: string;
}

interface CaseRow {
  case_id: string;
  case_key: string;
  governing_contract_id: string;
  principal_key: string;
  request_shape_hash: string;
  policy_fingerprint: string;
  compiler_version: number;
  superseded_by: string | null;
  first_seen_at: number;
  last_seen_at: number;
  payload_encrypted: string;
  representative_prompt_encrypted: string | null;
}

export interface ScopedExecutionCase {
  row: ExecutionCase;
  representative_prompt?: string;
}

export interface ExecutionCaseStore {
  putObservation(observation: CaseSourceObservation): Promise<boolean>;
  listObservations(): Promise<CaseSourceObservation[]>;
  /** ⛔ D-219 — the observations of these case keys ONLY, so a compile is
   *  proportional to what it touched rather than to the whole corpus.
   *
   *  ⚠ Returns rows for the keys as STORED. A caller must first establish that
   *  every affected row HAS a key (see {@link keylessObservationCount}) — a
   *  pre-migration row carries none, and silently omitting it would drop a
   *  member of the group and change what admits. */
  listObservationsForCaseKeys(
    case_keys: readonly string[],
  ): Promise<CaseSourceObservation[]>;
  /** How many stored observations predate the `case_key` column. Non-zero means
   *  a scoped rebuild cannot be trusted and the caller must do the full one. */
  keylessObservationCount(): number;
  /** The case keys an observation of these reports files under, WITHOUT opening
   *  a sealed payload. This is how a compile learns which keys it touched. */
  caseKeysForReports(report_ids: readonly string[]): string[];
  /** One span's observations, oldest first. D-219 slice 9c — the offer needs
   *  the turn it is asking ABOUT, and after 9a every governed turn records one,
   *  so scanning the whole corpus per turn to find it would make a per-turn cost
   *  that already grows with the corpus grow twice. */
  listObservationsForRoot(
    root_request_id: string,
  ): Promise<CaseSourceObservation[]>;
  observationCount(report_id: string): number;
  deleteObservation(report_id: string): boolean;
  compilerVersion(): number | undefined;
  setCompilerVersion(version: number): void;
  clearCompilerVersion(): void;
  compiledReportVersions(): ReadonlyMap<string, number>;
  markReportCompiled(report_id: string, compiler_version: number): void;
  clearCompiledReports(): void;
  replaceMaterialized(
    rows: readonly ExecutionCase[],
    sourceReportIdsByCase: ReadonlyMap<string, readonly string[]>,
    representativePromptByCase: ReadonlyMap<string, string>,
    options?: {
      /** ⛔ D-219 scoped rebuild. A rebuild that only re-derived SOME case keys
       *  has no observation in hand for the others, so its prompt map covers
       *  only what it touched — and the default (absent ⇒ NULL) would erase the
       *  representative prompt of every case it deliberately left alone,
       *  silently degrading stage-1 retrieval to a surface-term join.
       *
       *  With this set, a case absent from the map keeps its stored ciphertext
       *  VERBATIM: carried across as bytes, never opened, so preserving costs no
       *  decrypt and moves no plaintext. Default OFF, so the full rebuild —
       *  which genuinely means "no observation backs this prompt any more" —
       *  behaves exactly as before. */
      preserveMissingPrompts?: boolean;
    },
  ): Promise<void>;
  get(case_id: string): Promise<ExecutionCase | undefined>;
  getByKey(case_key: string): Promise<ExecutionCase | undefined>;
  listScope(scope: {
    governing_contract_id: string;
    principal_key: string;
  }, options?: {
    include_superseded?: boolean;
    limit?: number;
    with_prompt?: boolean;
  }): Promise<ScopedExecutionCase[]>;
  listAll(): Promise<ExecutionCase[]>;
  sourceReportIds(case_id: string): string[];
  deleteUnsupported(report_id: string): string[];
  clearMaterialized(): number;
}

export const createExecutionCaseStore = (
  db: Database.Database,
  keyProvider?: D214KeyProvider,
): ExecutionCaseStore => {
  ensureExecutionCaseSchema(db);
  const insertObservation = db.prepare(`
    INSERT INTO execution_case_observations (
      observation_id, report_id, root_request_id,
      governing_contract_id, principal_key,
      observed_at, case_key, payload_encrypted
    ) VALUES (
      @observation_id, @report_id, @root_request_id,
      @governing_contract_id, @principal_key,
      @observed_at, @case_key, @payload_encrypted
    )
    ON CONFLICT (observation_id) DO NOTHING
  `);
  const selectObservations = db.prepare(`
    SELECT observation_id, report_id, payload_encrypted
      FROM execution_case_observations
     ORDER BY observed_at ASC, observation_id ASC
  `);
  const selectObservationsForRoot = db.prepare(`
    SELECT observation_id, report_id, payload_encrypted
      FROM execution_case_observations
     WHERE root_request_id = ?
     ORDER BY observed_at ASC, observation_id ASC
  `);
  const removeObservation = db.prepare(`
    DELETE FROM execution_case_observations WHERE report_id = ?
  `);
  const countObservations = db.prepare(`
    SELECT COUNT(*) AS count
      FROM execution_case_observations
     WHERE report_id = ?
  `);
  const getCompilerVersion = db.prepare(`
    SELECT compiler_version
      FROM execution_case_compiler_state
     WHERE singleton = 1
  `);
  const putCompilerVersion = db.prepare(`
    INSERT INTO execution_case_compiler_state (singleton, compiler_version)
    VALUES (1, ?)
    ON CONFLICT (singleton) DO UPDATE SET
      compiler_version = excluded.compiler_version
  `);
  const removeCompilerVersion = db.prepare(`
    DELETE FROM execution_case_compiler_state WHERE singleton = 1
  `);
  const selectCompiledReports = db.prepare(`
    SELECT report_id, compiler_version
      FROM execution_case_compiled_reports
     ORDER BY report_id ASC
  `);
  const putCompiledReport = db.prepare(`
    INSERT INTO execution_case_compiled_reports (
      report_id, compiler_version
    ) VALUES (?, ?)
    ON CONFLICT (report_id) DO UPDATE SET
      compiler_version = excluded.compiler_version
  `);
  const removeCompiledReport = db.prepare(`
    DELETE FROM execution_case_compiled_reports WHERE report_id = ?
  `);
  const removeAllCompiledReports = db.prepare(`
    DELETE FROM execution_case_compiled_reports
  `);
  const selectCase = db.prepare('SELECT * FROM execution_cases WHERE case_id = ?');
  const selectCaseByKey = db.prepare(
    'SELECT * FROM execution_cases WHERE case_key = ?',
  );
  const selectAllCases = db.prepare(`
    SELECT * FROM execution_cases ORDER BY case_key ASC
  `);
  const selectScopeCases = db.prepare(`
    SELECT * FROM execution_cases
     WHERE governing_contract_id = @governing_contract_id
       AND principal_key = @principal_key
       AND (@include_superseded = 1 OR superseded_by IS NULL)
     ORDER BY last_seen_at DESC, case_id ASC
     LIMIT @limit
  `);
  const selectSources = db.prepare(`
    SELECT report_id FROM execution_case_sources
     WHERE case_id = ?
     ORDER BY report_id ASC
  `);
  const selectCasesForReport = db.prepare(`
    SELECT case_id FROM execution_case_sources
     WHERE report_id = ?
     ORDER BY case_id ASC
  `);
  const removeSource = db.prepare(`
    DELETE FROM execution_case_sources WHERE report_id = ?
  `);
  const removeAllSources = db.prepare('DELETE FROM execution_case_sources');
  const removeAllCases = db.prepare('DELETE FROM execution_cases');
  const insertCase = db.prepare(`
    INSERT INTO execution_cases (
      case_id, case_key, governing_contract_id, principal_key,
      request_shape_hash, policy_fingerprint, compiler_version,
      superseded_by, first_seen_at, last_seen_at, payload_encrypted,
      representative_prompt_encrypted
    ) VALUES (
      @case_id, @case_key, @governing_contract_id, @principal_key,
      @request_shape_hash, @policy_fingerprint, @compiler_version,
      @superseded_by, @first_seen_at, @last_seen_at, @payload_encrypted,
      @representative_prompt_encrypted
    )
  `);
  const insertSource = db.prepare(`
    INSERT INTO execution_case_sources (case_id, report_id)
    VALUES (?, ?)
  `);

  const selectObservationsForCaseKeys = (count: number) => db.prepare(`
    SELECT observation_id, report_id, payload_encrypted
      FROM execution_case_observations
     WHERE case_key IN (${new Array(count).fill('?').join(', ')})
     ORDER BY observed_at ASC, observation_id ASC
  `);
  const selectCasePrompts = db.prepare(`
    SELECT case_id, representative_prompt_encrypted FROM execution_cases
  `);
  const selectKeylessCount = db.prepare(`
    SELECT COUNT(*) AS n FROM execution_case_observations WHERE case_key IS NULL
  `);

  const decodeCase = (row: CaseRow): Promise<ExecutionCase> =>
    openD214Json<ExecutionCase>(
      row.payload_encrypted,
      'case-payload',
      row.case_id,
      keyProvider,
    );

  return {
    async putObservation(observation) {
      const payload_encrypted = await sealD214Json(
        observation,
        'case-observation',
        observation.observation_id,
        keyProvider,
      );
      return insertObservation.run({
        report_id: observation.report_id,
        observation_id: observation.observation_id,
        root_request_id: observation.root_request_id,
        governing_contract_id: observation.governing_contract_id,
        principal_key: observation.principal_key,
        observed_at: observation.observed_at,
        // ⛔ Derived HERE, through the same two functions the compiler groups
        // with. A second derivation of this key — even a correct-looking one —
        // is the hand-copied-vocabulary shape that has already cost this arc
        // five surviving mutations: the scoped read would then return a
        // different set from the one the rebuild groups by, and the divergence
        // would be silent.
        case_key: executionCaseKey({
          governing_contract_id: observation.governing_contract_id,
          principal_key: observation.principal_key,
          request_shape_hash: requestShapeHash(observation.request_shape),
          policy_fingerprint: observation.policy_fingerprint || 'none',
        }),
        payload_encrypted,
      }).changes === 1;
    },

    async listObservationsForCaseKeys(case_keys) {
      if (case_keys.length === 0) return [];
      const rows = selectObservationsForCaseKeys(case_keys.length)
        .all(...case_keys) as ObservationRow[];
      return Promise.all(rows.map((row) =>
        openD214Json<CaseSourceObservation>(
          row.payload_encrypted,
          'case-observation',
          row.observation_id,
          keyProvider,
        )));
    },

    keylessObservationCount() {
      return (selectKeylessCount.get() as { n: number }).n;
    },

    caseKeysForReports(report_ids) {
      if (report_ids.length === 0) return [];
      const rows = db.prepare(`
        SELECT DISTINCT case_key
          FROM execution_case_observations
         WHERE case_key IS NOT NULL
           AND report_id IN (${new Array(report_ids.length).fill('?').join(', ')})
      `).all(...report_ids) as Array<{ case_key: string }>;
      return rows.map((row) => row.case_key);
    },

    async listObservations() {
      const rows = selectObservations.all() as ObservationRow[];
      return Promise.all(rows.map((row) =>
        openD214Json<CaseSourceObservation>(
          row.payload_encrypted,
          'case-observation',
          row.observation_id,
          keyProvider,
        )));
    },

    async listObservationsForRoot(root_request_id) {
      const rows = selectObservationsForRoot.all(
        root_request_id,
      ) as ObservationRow[];
      return Promise.all(rows.map((row) =>
        openD214Json<CaseSourceObservation>(
          row.payload_encrypted,
          'case-observation',
          row.observation_id,
          keyProvider,
        )));
    },

    deleteObservation(report_id) {
      const remove = db.transaction(() => {
        const changed = removeObservation.run(report_id).changes > 0;
        removeCompiledReport.run(report_id);
        return changed;
      });
      return remove();
    },

    compilerVersion() {
      const row = getCompilerVersion.get() as
        | { compiler_version: number }
        | undefined;
      return row?.compiler_version;
    },

    setCompilerVersion(version) {
      if (!Number.isSafeInteger(version) || version <= 0) {
        throw new Error('execution-case-store: invalid compiler version');
      }
      putCompilerVersion.run(version);
    },

    clearCompilerVersion() {
      removeCompilerVersion.run();
    },

    compiledReportVersions() {
      return new Map(
        (selectCompiledReports.all() as Array<{
          report_id: string;
          compiler_version: number;
        }>).map((row) => [row.report_id, row.compiler_version]),
      );
    },

    observationCount(report_id) {
      return (countObservations.get(report_id) as { count: number }).count;
    },

    markReportCompiled(report_id, compiler_version) {
      if (
        !report_id
        || !Number.isSafeInteger(compiler_version)
        || compiler_version <= 0
      ) {
        throw new Error('execution-case-store: invalid compiled report');
      }
      putCompiledReport.run(report_id, compiler_version);
    },

    clearCompiledReports() {
      removeAllCompiledReports.run();
    },

    async replaceMaterialized(
      rows,
      sourceReportIdsByCase,
      representativePromptByCase,
      options,
    ) {
      // Read BEFORE the delete below, and as ciphertext: preserving a prompt is
      // a byte carry-over, not a round trip through plaintext.
      const storedPrompts = options?.preserveMissingPrompts === true
        ? new Map(
            (selectCasePrompts.all() as Array<{
              case_id: string;
              representative_prompt_encrypted: string | null;
            }>).map((row) =>
              [row.case_id, row.representative_prompt_encrypted] as const),
          )
        : new Map<string, string | null>();
      const prepared = await Promise.all(rows.map(async (row) => ({
        row,
        payload_encrypted: await sealD214Json(
          row,
          'case-payload',
          row.case_id,
          keyProvider,
        ),
        representative_prompt_encrypted:
          representativePromptByCase.has(row.case_id)
            ? await sealD214Json(
                representativePromptByCase.get(row.case_id),
                'case-prompt',
                row.case_id,
                keyProvider,
              )
            : storedPrompts.get(row.case_id) ?? null,
      })));
      const replace = db.transaction(() => {
        removeAllSources.run();
        removeAllCases.run();
        for (const item of prepared) {
          const row = item.row;
          insertCase.run({
            case_id: row.case_id,
            case_key: row.case_key,
            governing_contract_id: row.governing_contract_id,
            principal_key: row.principal_key,
            request_shape_hash: row.request_shape_hash,
            policy_fingerprint: row.policy_fingerprint,
            compiler_version: row.compiler_version,
            superseded_by: row.superseded_by ?? null,
            first_seen_at: row.first_seen_at,
            last_seen_at: row.last_seen_at,
            payload_encrypted: item.payload_encrypted,
            representative_prompt_encrypted:
              item.representative_prompt_encrypted,
          });
          for (const reportId of sourceReportIdsByCase.get(row.case_id) ?? []) {
            insertSource.run(row.case_id, reportId);
          }
        }
      });
      replace();
    },

    async get(case_id) {
      const row = selectCase.get(case_id) as CaseRow | undefined;
      return row ? decodeCase(row) : undefined;
    },

    async getByKey(case_key) {
      const row = selectCaseByKey.get(case_key) as CaseRow | undefined;
      return row ? decodeCase(row) : undefined;
    },

    async listScope(scope, options) {
      const rows = selectScopeCases.all({
        ...scope,
        include_superseded: options?.include_superseded ? 1 : 0,
        limit: Math.max(0, options?.limit ?? 100),
      }) as CaseRow[];
      return Promise.all(rows.map(async (row): Promise<ScopedExecutionCase> => {
        const decoded = await decodeCase(row);
        if (!options?.with_prompt || row.representative_prompt_encrypted === null) {
          return { row: decoded };
        }
        return {
          row: decoded,
          representative_prompt: await openD214Json<string>(
            row.representative_prompt_encrypted,
            'case-prompt',
            row.case_id,
            keyProvider,
          ),
        };
      }));
    },

    async listAll() {
      return Promise.all((selectAllCases.all() as CaseRow[]).map(decodeCase));
    },

    sourceReportIds(case_id) {
      return (selectSources.all(case_id) as Array<{ report_id: string }>)
        .map((row) => row.report_id);
    },

    deleteUnsupported(report_id) {
      const remove = db.transaction(() => {
        const affected = (
          selectCasesForReport.all(report_id) as Array<{ case_id: string }>
        ).map((row) => row.case_id);
        removeSource.run(report_id);
        removeObservation.run(report_id);
        removeCompiledReport.run(report_id);
        return affected;
      });
      return remove();
    },

    clearMaterialized() {
      const clear = db.transaction(() => {
        removeAllSources.run();
        return removeAllCases.run().changes;
      });
      return clear();
    },
  };
};
