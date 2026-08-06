/** D-214 A25 encrypted, model-invisible intervention attribution.
 *
 * This store is intentionally not exported through an RPC composer. Its only
 * consumer is the D-214 experiment service and owner aggregate diagnostics.
 */

import { createHash, createHmac } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  isCaseInterventionAssignment,
  isCaseInterventionRole,
  type CaseInterventionEvidence,
  type CaseInterventionRecord,
} from '@recued/contracts';

import {
  openD214Json,
  sealD214Json,
  type D214KeyProvider,
} from './d214-sealed-json.js';

export const CASE_INTERVENTIONS_TABLE = 'case_interventions';

export const ensureCaseInterventionSchema = (db: Database.Database): void => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS case_experiment_assignments (
      experiment_id    TEXT NOT NULL,
      root_request_id  TEXT NOT NULL,
      assignment       TEXT NOT NULL,
      assigned_at      INTEGER NOT NULL,
      PRIMARY KEY (experiment_id, root_request_id)
    );

    CREATE TABLE IF NOT EXISTS case_experiment_definitions (
      experiment_id    TEXT PRIMARY KEY,
      definition_hash  TEXT NOT NULL,
      definition_json  TEXT NOT NULL,
      registered_at    INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS case_experiment_invalid_roots (
      experiment_id    TEXT NOT NULL,
      root_request_id  TEXT NOT NULL,
      reason_code      TEXT NOT NULL,
      invalidated_at   INTEGER NOT NULL,
      PRIMARY KEY (experiment_id, root_request_id)
    );

    CREATE TABLE IF NOT EXISTS case_experiment_turn_metrics (
      experiment_id    TEXT NOT NULL,
      root_request_id  TEXT NOT NULL,
      session_id       TEXT NOT NULL,
      turn_id          TEXT NOT NULL,
      planner_rounds   INTEGER NOT NULL,
      PRIMARY KEY (experiment_id, root_request_id, session_id, turn_id)
    );

    CREATE TABLE IF NOT EXISTS case_interventions (
      opportunity_key        TEXT PRIMARY KEY,
      intervention_id        TEXT NOT NULL UNIQUE,
      experiment_id          TEXT NOT NULL,
      root_request_id        TEXT NOT NULL,
      governing_contract_id  TEXT NOT NULL,
      principal_key          TEXT NOT NULL,
      surface                TEXT NOT NULL,
      assignment             TEXT NOT NULL,
      recorded_at            INTEGER NOT NULL,
      recorded_sequence      INTEGER NOT NULL,
      payload_encrypted      TEXT NOT NULL,
      planner_egress_at      INTEGER,
      span_closed_at         INTEGER
    );

    CREATE TABLE IF NOT EXISTS case_experiment_health (
      experiment_id  TEXT PRIMARY KEY,
      healthy        INTEGER NOT NULL,
      failure_count  INTEGER NOT NULL,
      last_failure   TEXT,
      updated_at     INTEGER NOT NULL
    );

    -- D-219 lookups and cascade deletes are BY ROOT, and this table carried no
    -- index. Every one was a full scan; a retention pass removing N roots did
    -- N scans -- the quadratic shape fixed in audit-retention. Grows with chat.
    CREATE INDEX IF NOT EXISTS idx_case_interventions_root
      ON case_interventions (root_request_id);
    CREATE INDEX IF NOT EXISTS idx_case_exp_assignments_root
      ON case_experiment_assignments (root_request_id);
    CREATE INDEX IF NOT EXISTS idx_case_exp_invalid_roots_root
      ON case_experiment_invalid_roots (root_request_id);
    CREATE INDEX IF NOT EXISTS idx_case_exp_turn_metrics_root
      ON case_experiment_turn_metrics (root_request_id);
  `);
  const interventionColumns = new Set(
    (db.prepare(`PRAGMA table_info(${CASE_INTERVENTIONS_TABLE})`).all() as
      Array<{ name: string }>).map((row) => row.name),
  );
  if (!interventionColumns.has('recorded_sequence')) {
    db.exec(`
      ALTER TABLE case_interventions ADD COLUMN recorded_sequence INTEGER;
    `);
  }
  db.exec(`
    UPDATE case_interventions
       SET recorded_sequence = rowid
     WHERE recorded_sequence IS NULL;

    CREATE UNIQUE INDEX IF NOT EXISTS
      idx_case_interventions_root_sequence
    ON case_interventions (
      experiment_id, root_request_id, recorded_sequence
    );
  `);
};

interface InterventionRow {
  opportunity_key: string;
  intervention_id: string;
  payload_encrypted: string;
  recorded_sequence: number;
  planner_egress_at: number | null;
  span_closed_at: number | null;
}

interface InterventionInsert {
  opportunity_key: string;
  intervention_id: string;
  experiment_id: string;
  root_request_id: string;
  governing_contract_id: string;
  principal_key: string;
  surface: CaseInterventionRecord['surface'];
  assignment: CaseInterventionRecord['assignment'];
  recorded_at: number;
  payload_encrypted: string;
  max_opportunities_per_root?: number;
}

export interface StoredCaseIntervention {
  record: CaseInterventionRecord;
  recorded_sequence: number;
  planner_egress_at?: number;
  span_closed_at?: number;
}

export interface CaseExperimentHealth {
  experiment_id: string;
  healthy: boolean;
  failure_count: number;
  last_failure?: string;
  updated_at: number;
}

export interface CaseExperimentAggregate {
  experiment_id: string;
  assigned_roots: {
    control: number;
    treatment: number;
  };
  invalid_roots: {
    control: number;
    treatment: number;
  };
  arms: Record<'control' | 'treatment', {
    opportunities: number;
    roots_with_opportunity: number;
    selected_nonempty: number;
    shown_nonempty: number;
    planner_egress: number;
    span_closed: number;
    missing_egress: number;
    missing_span_close: number;
    augmentation_opportunities: number;
    critique_opportunities: number;
  }>;
  health?: CaseExperimentHealth;
}

export interface CaseExperimentDefinitionStamp {
  experiment_id: string;
  surface: 'request_augmentation' | 'proposal_critique';
  eligible_population: string;
  starts_at: number;
  ends_at: number;
  max_roots: number;
  max_critique_opportunities_per_root: number;
  max_evidence: number;
  min_relevance_score: number;
  primary_axes: readonly string[];
  material_harm_bounds: Readonly<Record<string, number>>;
  decision_rule: string;
  planner_fingerprint: string;
  prompt_fingerprint: string;
  retrieval_fingerprint: string;
  policy_fingerprint: string;
}

export interface CaseInterventionStore {
  /** Atomically locks the complete pre-registration before the first root is
   * assigned. A changed definition under one experiment id is rejected. */
  assertDefinition(
    definition: CaseExperimentDefinitionStamp,
    registered_at?: number,
  ): void;
  assignment(input: {
    experiment_id: string;
    root_request_id: string;
    assigned_at: number;
    definition: CaseExperimentDefinitionStamp;
    /** A pre-registered experiment cap. A new root is not assigned after the
     * cap; an already-assigned root always resolves to its stable arm. */
    max_roots?: number;
  }): 'control' | 'treatment' | undefined;
  put(record: CaseInterventionRecord): Promise<boolean>;
  getForOpportunity(
    record: CaseInterventionRecord,
  ): Promise<StoredCaseIntervention | undefined>;
  listForExperiment(experiment_id: string): Promise<StoredCaseIntervention[]>;
  listForRoot(
    experiment_id: string,
    root_request_id: string,
  ): Promise<StoredCaseIntervention[]>;
  /** Deduplicated union of evidence actually shown anywhere in this root.
   * This crosses continuation streams and experiments, but never includes
   * merely qualifying or selected control-arm evidence. */
  shownCaseKeysForRoot(root_request_id: string): Promise<string[]>;
  /** Internal measurement join only. Never exposed by an RPC or card. */
  listAssignments(experiment_id: string): Array<{
    root_request_id: string;
    assignment: 'control' | 'treatment';
    /** Absent means the turn-completion metric was not durably recorded; it
     * must not be reported as a zero-round turn. */
    planner_rounds?: number;
  }>;
  markPlannerEgress(intervention_id: string, at: number): boolean;
  markSpanClosed(root_request_id: string, at: number): number;
  markUnhealthy(experiment_id: string, reasonCode: string, at: number): void;
  markRootInvalid(
    experiment_id: string,
    root_request_id: string,
    reasonCode: string,
    at: number,
  ): void;
  recordPlannerRounds(input: {
    root_request_id: string;
    session_id: string;
    turn_id: string;
    rounds: number;
  }): number;
  health(experiment_id: string): CaseExperimentHealth | undefined;
  /** Owner aggregate diagnostics only; returns no raw intervention rows. */
  aggregate(experiment_id: string): Promise<CaseExperimentAggregate>;
  deleteForRoot(root_request_id: string): number;
  deleteForCase(case_id: string): Promise<number>;
}

const evidenceKey = (item: CaseInterventionEvidence): string =>
  `${item.case_id}\0${item.role}`;

const validateEvidence = (
  values: readonly CaseInterventionEvidence[],
  allowedRoles: ReadonlySet<string>,
  label: string,
): void => {
  const seen = new Set<string>();
  for (const value of values) {
    if (
      !value.case_id
      || !value.case_key
      || !isCaseInterventionRole(value.role)
      || !allowedRoles.has(value.role)
    ) throw new Error(`case-intervention-store: invalid ${label}`);
    const key = evidenceKey(value);
    if (seen.has(key)) {
      throw new Error(`case-intervention-store: duplicate ${label}`);
    }
    seen.add(key);
  }
};

const sameEvidence = (
  left: readonly CaseInterventionEvidence[],
  right: readonly CaseInterventionEvidence[],
): boolean =>
  left.length === right.length
  && left.every((item, index) =>
    evidenceKey(item) === evidenceKey(right[index]!));

export const validateCaseInterventionRecord = (
  record: CaseInterventionRecord,
): void => {
  if (
    record.schema_version !== 1
    || !record.intervention_id
    || !record.experiment_id
    || !record.root_request_id
    || !record.session_id
    || !record.turn_id
    || !record.governing_contract_id
    || !record.principal_key
    || !isCaseInterventionAssignment(record.assignment)
    || !Number.isSafeInteger(record.compiler_version)
    || !Number.isFinite(record.recorded_at)
  ) throw new Error('case-intervention-store: invalid envelope');
  const allowed = record.surface === 'request_augmentation'
    ? new Set(['augmentation'])
    : new Set(['support', 'contradiction', 'alternative']);
  validateEvidence(record.qualifying_evidence, allowed, 'qualifying_evidence');
  validateEvidence(record.selected_evidence, allowed, 'selected_evidence');
  validateEvidence(record.shown_evidence, allowed, 'shown_evidence');
  const qualifying = new Set(record.qualifying_evidence.map(evidenceKey));
  if (!record.selected_evidence.every((item) =>
    qualifying.has(evidenceKey(item)))) {
    throw new Error(
      'case-intervention-store: selected_evidence must be a subset',
    );
  }
  if (record.assignment === 'control' && record.shown_evidence.length !== 0) {
    throw new Error('case-intervention-store: control cannot show evidence');
  }
  if (
    record.assignment === 'treatment'
    && !sameEvidence(record.selected_evidence, record.shown_evidence)
  ) {
    throw new Error(
      'case-intervention-store: treatment must show exactly its selection',
    );
  }
  if (
    record.surface === 'request_augmentation'
    && (
      record.candidate_source_count < 0
      || !Number.isSafeInteger(record.candidate_source_count)
      || !record.candidate_source_id
    )
  ) throw new Error('case-intervention-store: invalid augmentation source');
  if (
    record.surface === 'proposal_critique'
    && !record.candidate_flow_hash
  ) throw new Error('case-intervention-store: invalid candidate flow hash');
};

const opportunityKeyFor = (record: CaseInterventionRecord): string =>
  createHash('sha256')
    .update(JSON.stringify(
      record.surface === 'request_augmentation'
        ? [
            record.experiment_id,
            record.root_request_id,
            record.surface,
          ]
        : [
            record.experiment_id,
            record.root_request_id,
            record.session_id,
            record.turn_id,
            record.surface,
            record.candidate_flow_hash,
          ],
    ))
    .digest('hex');

const canonicalDefinitionJson = (
  definition: CaseExperimentDefinitionStamp,
): string => JSON.stringify({
  experiment_id: definition.experiment_id,
  surface: definition.surface,
  eligible_population: definition.eligible_population,
  starts_at: definition.starts_at,
  ends_at: definition.ends_at,
  max_roots: definition.max_roots,
  max_critique_opportunities_per_root:
    definition.max_critique_opportunities_per_root,
  max_evidence: definition.max_evidence,
  min_relevance_score: definition.min_relevance_score,
  primary_axes: [...definition.primary_axes],
  material_harm_bounds: Object.fromEntries(
    Object.entries(definition.material_harm_bounds)
      .sort(([left], [right]) => left.localeCompare(right)),
  ),
  decision_rule: definition.decision_rule,
  planner_fingerprint: definition.planner_fingerprint,
  prompt_fingerprint: definition.prompt_fingerprint,
  retrieval_fingerprint: definition.retrieval_fingerprint,
  policy_fingerprint: definition.policy_fingerprint,
});

const definitionStamp = (
  definition: CaseExperimentDefinitionStamp,
): { json: string; hash: string } => {
  const json = canonicalDefinitionJson(definition);
  return {
    json,
    hash: createHash('sha256').update(json).digest('hex'),
  };
};

export const createCaseInterventionStore = (
  db: Database.Database,
  keyProvider?: D214KeyProvider,
  assignmentSecret: Uint8Array = new TextEncoder().encode(
    'd214-test-assignment-secret',
  ),
): CaseInterventionStore => {
  ensureCaseInterventionSchema(db);
  const getAssignment = db.prepare(`
    SELECT assignment FROM case_experiment_assignments
     WHERE experiment_id = ? AND root_request_id = ?
  `);
  const putAssignment = db.prepare(`
    INSERT INTO case_experiment_assignments (
      experiment_id, root_request_id, assignment, assigned_at
    ) VALUES (?, ?, ?, ?)
    ON CONFLICT (experiment_id, root_request_id) DO NOTHING
  `);
  const countAssignments = db.prepare(`
    SELECT COUNT(*) AS count
      FROM case_experiment_assignments
     WHERE experiment_id = ?
  `);
  const getDefinition = db.prepare(`
    SELECT definition_hash, definition_json
      FROM case_experiment_definitions
     WHERE experiment_id = ?
  `);
  const putDefinition = db.prepare(`
    INSERT INTO case_experiment_definitions (
      experiment_id, definition_hash, definition_json, registered_at
    ) VALUES (?, ?, ?, ?)
  `);
  const getInvalidRoot = db.prepare(`
    SELECT reason_code
      FROM case_experiment_invalid_roots
     WHERE experiment_id = ? AND root_request_id = ?
  `);
  const upsertInvalidRoot = db.prepare(`
    INSERT INTO case_experiment_invalid_roots (
      experiment_id, root_request_id, reason_code, invalidated_at
    ) VALUES (?, ?, ?, ?)
    ON CONFLICT (experiment_id, root_request_id) DO UPDATE SET
      reason_code = excluded.reason_code,
      invalidated_at = MIN(
        case_experiment_invalid_roots.invalidated_at,
        excluded.invalidated_at
      )
  `);
  const putPlannerRounds = db.prepare(`
    INSERT INTO case_experiment_turn_metrics (
      experiment_id, root_request_id, session_id, turn_id, planner_rounds
    )
    SELECT experiment_id, root_request_id, ?, ?, ?
      FROM case_experiment_assignments
     WHERE root_request_id = ?
    ON CONFLICT (
      experiment_id, root_request_id, session_id, turn_id
    ) DO UPDATE SET
      planner_rounds = excluded.planner_rounds
  `);
  const nextRecordedSequence = db.prepare(`
    SELECT COALESCE(MAX(recorded_sequence), 0) + 1 AS sequence
      FROM case_interventions
     WHERE experiment_id = ? AND root_request_id = ?
  `);
  const countRootSurfaceOpportunities = db.prepare(`
    SELECT COUNT(*) AS count
      FROM case_interventions
     WHERE experiment_id = ? AND root_request_id = ? AND surface = ?
  `);
  const insert = db.prepare(`
    INSERT INTO case_interventions (
      opportunity_key, intervention_id, experiment_id, root_request_id,
      governing_contract_id, principal_key, surface, assignment, recorded_at,
      recorded_sequence, payload_encrypted, planner_egress_at, span_closed_at
    ) VALUES (
      @opportunity_key, @intervention_id, @experiment_id, @root_request_id,
      @governing_contract_id, @principal_key, @surface, @assignment,
      @recorded_at, @recorded_sequence, @payload_encrypted, NULL, NULL
    )
    ON CONFLICT (opportunity_key) DO NOTHING
  `);
  const listExperiment = db.prepare(`
    SELECT i.opportunity_key, i.intervention_id, i.payload_encrypted,
           i.recorded_sequence,
           i.planner_egress_at, i.span_closed_at
      FROM case_interventions i
      LEFT JOIN case_experiment_invalid_roots invalid
        ON invalid.experiment_id = i.experiment_id
       AND invalid.root_request_id = i.root_request_id
     WHERE i.experiment_id = ? AND invalid.root_request_id IS NULL
     ORDER BY i.recorded_sequence ASC
  `);
  const listRoot = db.prepare(`
    SELECT i.opportunity_key, i.intervention_id, i.payload_encrypted,
           i.recorded_sequence,
           i.planner_egress_at, i.span_closed_at
      FROM case_interventions i
      LEFT JOIN case_experiment_invalid_roots invalid
        ON invalid.experiment_id = i.experiment_id
       AND invalid.root_request_id = i.root_request_id
     WHERE i.experiment_id = ? AND i.root_request_id = ?
       AND invalid.root_request_id IS NULL
     ORDER BY i.recorded_sequence ASC
  `);
  const listRootAcrossExperiments = db.prepare(`
    SELECT i.opportunity_key, i.intervention_id, i.payload_encrypted,
           i.recorded_sequence,
           i.planner_egress_at, i.span_closed_at
      FROM case_interventions i
     WHERE i.root_request_id = ? AND i.planner_egress_at IS NOT NULL
     ORDER BY i.experiment_id ASC, i.recorded_sequence ASC
  `);
  const setEgress = db.prepare(`
    UPDATE case_interventions
       SET planner_egress_at = COALESCE(planner_egress_at, ?)
     WHERE intervention_id = ?
  `);
  const setClosed = db.prepare(`
    UPDATE case_interventions
       SET span_closed_at = COALESCE(span_closed_at, ?)
     WHERE root_request_id = ?
  `);
  const upsertHealth = db.prepare(`
    INSERT INTO case_experiment_health (
      experiment_id, healthy, failure_count, last_failure, updated_at
    ) VALUES (?, 0, 1, ?, ?)
    ON CONFLICT (experiment_id) DO UPDATE SET
      healthy = 0,
      failure_count = failure_count + 1,
      last_failure = excluded.last_failure,
      updated_at = excluded.updated_at
  `);
  const getHealth = db.prepare(`
    SELECT * FROM case_experiment_health WHERE experiment_id = ?
  `);
  const listAssignments = db.prepare(`
    SELECT a.assignment, COUNT(*) AS count
      FROM case_experiment_assignments a
      LEFT JOIN case_experiment_invalid_roots invalid
        ON invalid.experiment_id = a.experiment_id
       AND invalid.root_request_id = a.root_request_id
     WHERE a.experiment_id = ? AND invalid.root_request_id IS NULL
     GROUP BY a.assignment
  `);
  const listInvalidAssignments = db.prepare(`
    SELECT a.assignment, COUNT(*) AS count
      FROM case_experiment_assignments a
      INNER JOIN case_experiment_invalid_roots invalid
        ON invalid.experiment_id = a.experiment_id
       AND invalid.root_request_id = a.root_request_id
     WHERE a.experiment_id = ?
     GROUP BY a.assignment
  `);
  const listAssignmentRoots = db.prepare(`
    SELECT a.root_request_id, a.assignment,
           SUM(metrics.planner_rounds) AS planner_rounds
      FROM case_experiment_assignments a
      LEFT JOIN case_experiment_invalid_roots invalid
        ON invalid.experiment_id = a.experiment_id
       AND invalid.root_request_id = a.root_request_id
      LEFT JOIN case_experiment_turn_metrics metrics
        ON metrics.experiment_id = a.experiment_id
       AND metrics.root_request_id = a.root_request_id
     WHERE a.experiment_id = ? AND invalid.root_request_id IS NULL
     GROUP BY a.root_request_id, a.assignment, a.assigned_at
     ORDER BY a.assigned_at ASC, a.root_request_id ASC
  `);
  const deleteRootRows = db.prepare(`
    DELETE FROM case_interventions WHERE root_request_id = ?
  `);
  const deleteRootAssignment = db.prepare(`
    DELETE FROM case_experiment_assignments WHERE root_request_id = ?
  `);
  const deleteRootInvalid = db.prepare(`
    DELETE FROM case_experiment_invalid_roots WHERE root_request_id = ?
  `);
  const deleteRootMetrics = db.prepare(`
    DELETE FROM case_experiment_turn_metrics WHERE root_request_id = ?
  `);
  const selectAll = db.prepare(`
    SELECT opportunity_key, intervention_id, payload_encrypted,
           recorded_sequence,
           planner_egress_at, span_closed_at
      FROM case_interventions
  `);
  const deleteIntervention = db.prepare(`
    DELETE FROM case_interventions WHERE intervention_id = ?
  `);
  const selectOpportunity = db.prepare(`
    SELECT opportunity_key, intervention_id, payload_encrypted,
           recorded_sequence,
           planner_egress_at, span_closed_at
      FROM case_interventions
     WHERE opportunity_key = ?
  `);

  const decode = async (row: InterventionRow): Promise<StoredCaseIntervention> => ({
    record: await openD214Json<CaseInterventionRecord>(
      row.payload_encrypted,
      'intervention',
      row.intervention_id,
      keyProvider,
    ),
    recorded_sequence: row.recorded_sequence,
    ...(row.planner_egress_at !== null
      ? { planner_egress_at: row.planner_egress_at }
      : {}),
    ...(row.span_closed_at !== null
      ? { span_closed_at: row.span_closed_at }
      : {}),
  });
  const readHealth = (
    experiment_id: string,
  ): CaseExperimentHealth | undefined => {
    const row = getHealth.get(experiment_id) as {
      experiment_id: string;
      healthy: number;
      failure_count: number;
      last_failure: string | null;
      updated_at: number;
    } | undefined;
    return row
      ? {
          experiment_id: row.experiment_id,
          healthy: row.healthy === 1,
          failure_count: row.failure_count,
          ...(row.last_failure !== null
            ? { last_failure: row.last_failure }
            : {}),
          updated_at: row.updated_at,
        }
      : undefined;
  };

  const registerDefinition = (
    definition: CaseExperimentDefinitionStamp,
    registered_at: number,
  ): void => {
    const stamp = definitionStamp(definition);
    const existing = getDefinition.get(definition.experiment_id) as {
      definition_hash: string;
      definition_json: string;
    } | undefined;
    if (existing) {
      if (
        existing.definition_hash !== stamp.hash
        || existing.definition_json !== stamp.json
      ) {
        throw new Error(
          'case-intervention-store: experiment definition mismatch',
        );
      }
      return;
    }
    const { count } = countAssignments.get(definition.experiment_id) as {
      count: number;
    };
    if (count > 0) {
      throw new Error(
        'case-intervention-store: experiment definition was not registered',
      );
    }
    putDefinition.run(
      definition.experiment_id,
      stamp.hash,
      stamp.json,
      registered_at,
    );
  };

  const definitionFor = (
    experiment_id: string,
  ): CaseExperimentDefinitionStamp | undefined => {
    const row = getDefinition.get(experiment_id) as {
      definition_hash: string;
      definition_json: string;
    } | undefined;
    if (!row) return undefined;
    try {
      if (
        createHash('sha256').update(row.definition_json).digest('hex')
          !== row.definition_hash
      ) {
        throw new Error('hash mismatch');
      }
      return JSON.parse(row.definition_json) as CaseExperimentDefinitionStamp;
    } catch {
      throw new Error(
        'case-intervention-store: corrupt experiment definition',
      );
    }
  };

  const assertDefinition = db.transaction((
    definition: CaseExperimentDefinitionStamp,
    registered_at: number = Date.now(),
  ): void => {
    registerDefinition(definition, registered_at);
  });

  const assign = db.transaction((input: {
    experiment_id: string;
    root_request_id: string;
    assigned_at: number;
    definition: CaseExperimentDefinitionStamp;
    max_roots?: number;
  }): 'control' | 'treatment' | undefined => {
      if (input.definition.experiment_id !== input.experiment_id) {
        throw new Error(
          'case-intervention-store: experiment definition mismatch',
        );
      }
      registerDefinition(input.definition, input.assigned_at);
      if (getInvalidRoot.get(
        input.experiment_id,
        input.root_request_id,
      )) return undefined;
      const existing = getAssignment.get(
        input.experiment_id,
        input.root_request_id,
      ) as { assignment: 'control' | 'treatment' } | undefined;
      if (existing) return existing.assignment;
      if (input.max_roots !== undefined) {
        if (!Number.isSafeInteger(input.max_roots) || input.max_roots <= 0) {
          throw new Error('case-intervention-store: invalid root cap');
        }
        const { count } = countAssignments.get(input.experiment_id) as {
          count: number;
        };
        if (count >= input.max_roots) return undefined;
      }
      const digest = createHmac('sha256', assignmentSecret)
        .update(`${input.experiment_id}\0${input.root_request_id}`)
        .digest();
      const assignment = (digest[0]! & 1) === 0 ? 'control' : 'treatment';
      putAssignment.run(
        input.experiment_id,
        input.root_request_id,
        assignment,
        input.assigned_at,
      );
      const committed = getAssignment.get(
        input.experiment_id,
        input.root_request_id,
      ) as { assignment: 'control' | 'treatment' };
      return committed.assignment;
  });
  const commitIntervention = db.transaction((
    input: InterventionInsert,
  ): boolean => {
    // The critic's read-side cap is an early exit only. Recheck under the same
    // transaction as insertion so concurrent continuation streams cannot both
    // consume the final slot.
    if (selectOpportunity.get(input.opportunity_key)) return false;
    if (input.max_opportunities_per_root !== undefined) {
      const { count } = countRootSurfaceOpportunities.get(
        input.experiment_id,
        input.root_request_id,
        input.surface,
      ) as { count: number };
      if (count >= input.max_opportunities_per_root) return false;
    }
    const row = nextRecordedSequence.get(
      input.experiment_id,
      input.root_request_id,
    ) as { sequence: number };
    return insert.run({
      ...input,
      recorded_sequence: row.sequence,
    }).changes === 1;
  });

  return {
    assertDefinition,

    assignment: assign,

    async put(record) {
      validateCaseInterventionRecord(record);
      const definition = definitionFor(record.experiment_id);
      if (
        !definition
        || record.surface !== definition.surface
        || record.planner_fingerprint !== definition.planner_fingerprint
        || record.prompt_fingerprint !== definition.prompt_fingerprint
        || record.retrieval_fingerprint !== definition.retrieval_fingerprint
        || record.policy_fingerprint !== definition.policy_fingerprint
      ) {
        throw new Error(
          'case-intervention-store: intervention definition mismatch',
        );
      }
      const expected = getAssignment.get(
        record.experiment_id,
        record.root_request_id,
      ) as { assignment: 'control' | 'treatment' } | undefined;
      if (getInvalidRoot.get(
        record.experiment_id,
        record.root_request_id,
      )) {
        throw new Error('case-intervention-store: root is invalid');
      }
      if (expected?.assignment !== record.assignment) {
        throw new Error('case-intervention-store: assignment mismatch');
      }
      const payload_encrypted = await sealD214Json(
        record,
        'intervention',
        record.intervention_id,
        keyProvider,
      );
      return commitIntervention({
        opportunity_key: opportunityKeyFor(record),
        intervention_id: record.intervention_id,
        experiment_id: record.experiment_id,
        root_request_id: record.root_request_id,
        governing_contract_id: record.governing_contract_id,
        principal_key: record.principal_key,
        surface: record.surface,
        assignment: record.assignment,
        recorded_at: record.recorded_at,
        payload_encrypted,
        ...(record.surface === 'proposal_critique'
          ? {
              max_opportunities_per_root:
                definition.max_critique_opportunities_per_root,
            }
          : {}),
      });
    },

    async getForOpportunity(record) {
      const row = selectOpportunity.get(
        opportunityKeyFor(record),
      ) as InterventionRow | undefined;
      return row ? decode(row) : undefined;
    },

    async listForExperiment(experiment_id) {
      return Promise.all(
        (listExperiment.all(experiment_id) as InterventionRow[]).map(decode),
      );
    },

    async listForRoot(experiment_id, root_request_id) {
      return Promise.all(
        (listRoot.all(experiment_id, root_request_id) as InterventionRow[])
          .map(decode),
      );
    },

    async shownCaseKeysForRoot(root_request_id) {
      const keys = new Set<string>();
      const rows = await Promise.all(
        (listRootAcrossExperiments.all(root_request_id) as InterventionRow[])
          .map(decode),
      );
      for (const row of rows) {
        for (const evidence of row.record.shown_evidence) {
          keys.add(evidence.case_key);
        }
      }
      return [...keys].sort();
    },

    listAssignments(experiment_id) {
      return (listAssignmentRoots.all(experiment_id) as Array<{
        root_request_id: string;
        assignment: string;
        planner_rounds: number | null;
      }>).flatMap((row) =>
        isCaseInterventionAssignment(row.assignment)
          ? [{
              root_request_id: row.root_request_id,
              assignment: row.assignment,
              ...(row.planner_rounds !== null
                ? { planner_rounds: row.planner_rounds }
                : {}),
            }]
          : []);
    },

    markPlannerEgress(intervention_id, at) {
      return setEgress.run(at, intervention_id).changes === 1;
    },

    markSpanClosed(root_request_id, at) {
      return setClosed.run(at, root_request_id).changes;
    },

    markUnhealthy(experiment_id, reasonCode, at) {
      upsertHealth.run(experiment_id, reasonCode.slice(0, 128), at);
    },

    markRootInvalid(experiment_id, root_request_id, reasonCode, at) {
      upsertInvalidRoot.run(
        experiment_id,
        root_request_id,
        reasonCode.slice(0, 128),
        at,
      );
    },

    recordPlannerRounds(input) {
      if (
        !input.root_request_id
        || !input.session_id
        || !input.turn_id
        || !Number.isSafeInteger(input.rounds)
        || input.rounds < 0
      ) {
        throw new Error('case-intervention-store: invalid planner rounds');
      }
      return putPlannerRounds.run(
        input.session_id,
        input.turn_id,
        input.rounds,
        input.root_request_id,
      ).changes;
    },

    health(experiment_id) {
      return readHealth(experiment_id);
    },

    async aggregate(experiment_id) {
      const assignmentRows = listAssignments.all(experiment_id) as Array<{
        assignment: 'control' | 'treatment';
        count: number;
      }>;
      const assigned_roots = { control: 0, treatment: 0 };
      for (const row of assignmentRows) {
        if (isCaseInterventionAssignment(row.assignment)) {
          assigned_roots[row.assignment] = row.count;
        }
      }
      const invalid_roots = { control: 0, treatment: 0 };
      for (const row of listInvalidAssignments.all(experiment_id) as Array<{
        assignment: 'control' | 'treatment';
        count: number;
      }>) {
        if (isCaseInterventionAssignment(row.assignment)) {
          invalid_roots[row.assignment] = row.count;
        }
      }
      const blank = () => ({
        opportunities: 0,
        roots_with_opportunity: 0,
        selected_nonempty: 0,
        shown_nonempty: 0,
        planner_egress: 0,
        span_closed: 0,
        missing_egress: 0,
        missing_span_close: 0,
        augmentation_opportunities: 0,
        critique_opportunities: 0,
      });
      const arms = {
        control: blank(),
        treatment: blank(),
      };
      const roots = {
        control: new Set<string>(),
        treatment: new Set<string>(),
      };
      for (const item of await Promise.all(
        (listExperiment.all(experiment_id) as InterventionRow[]).map(decode),
      )) {
        const arm = arms[item.record.assignment];
        roots[item.record.assignment].add(item.record.root_request_id);
        arm.opportunities += 1;
        if (item.record.selected_evidence.length > 0) {
          arm.selected_nonempty += 1;
        }
        if (item.record.shown_evidence.length > 0) arm.shown_nonempty += 1;
        if (item.planner_egress_at !== undefined) arm.planner_egress += 1;
        else arm.missing_egress += 1;
        if (item.span_closed_at !== undefined) arm.span_closed += 1;
        else arm.missing_span_close += 1;
        if (item.record.surface === 'request_augmentation') {
          arm.augmentation_opportunities += 1;
        } else {
          arm.critique_opportunities += 1;
        }
      }
      arms.control.roots_with_opportunity = roots.control.size;
      arms.treatment.roots_with_opportunity = roots.treatment.size;
      const aggregate: CaseExperimentAggregate = {
        experiment_id,
        assigned_roots,
        invalid_roots,
        arms,
      };
      const currentHealth = readHealth(experiment_id);
      return currentHealth
        ? { ...aggregate, health: currentHealth }
        : aggregate;
    },

    deleteForRoot(root_request_id) {
      const remove = db.transaction(() => {
        const count = deleteRootRows.run(root_request_id).changes;
        deleteRootInvalid.run(root_request_id);
        deleteRootMetrics.run(root_request_id);
        deleteRootAssignment.run(root_request_id);
        return count;
      });
      return remove();
    },

    async deleteForCase(case_id) {
      const rows = selectAll.all() as InterventionRow[];
      let deleted = 0;
      for (const row of rows) {
        const decoded = await decode(row);
        if (
          decoded.record.qualifying_evidence.some((item) =>
            item.case_id === case_id)
          || decoded.record.selected_evidence.some((item) =>
            item.case_id === case_id)
          || decoded.record.shown_evidence.some((item) =>
            item.case_id === case_id)
        ) {
          deleted += deleteIntervention.run(row.intervention_id).changes;
        }
      }
      return deleted;
    },
  };
};
