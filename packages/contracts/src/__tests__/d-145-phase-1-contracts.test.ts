/** D-145 PA1 — contracts surface tests.
 *
 *  Covers:
 *    - work entity kind closed list
 *    - canonical schema completeness per kind
 *    - reserved data subnamespace widening
 *    - Source registration shape helpers
 *    - lifecycle / due / expiry orthogonal axis closed lists
 *    - currency + amount regex validators */

import { describe, expect, it } from 'vitest';

import {
  CANONICAL_SCHEMAS,
  COMMITMENT_AMOUNT_REGEX,
  COMMITMENT_CURRENCY_REGEX,
  COMMITMENT_DERIVATIONS,
  COMMITMENT_DIRECTIONS,
  COMMITMENT_DUE_STATUSES,
  COMMITMENT_EXPIRY_POLICIES,
  COMMITMENT_LIFECYCLE_STATES,
  COMMITMENT_STATEMENT_MAX,
  CONFLICT_POLICIES,
  CONNECTION_SOURCE_ID,
  PROJECT_HIERARCHY_MAX_DEPTH,
  PROJECT_STATES,
  PROJECT_TITLE_MAX,
  RECUED_BUILTIN_SOURCE_ID,
  RESERVED_DATA_SUBNAMESPACES,
  SOURCE_KINDS,
  SOURCE_TOP_TIER_KINDS,
  SYNC_STATES,
  TASK_PRIORITIES,
  TASK_TITLE_MAX,
  WORK_ENTITY_KINDS,
  getCanonicalSchema,
  isSourceKind,
  isSourceTopTierKind,
  isWorkEntityKind,
  isWorkEntitySourceKind,
} from '../index.js';

describe('D-145 PA1 — work entity kinds', () => {
  it('exposes the five kinds in stable order', () => {
    // D-210 appended `booking`. Appended, NOT inserted: the order is
    // load-bearing for `SOURCE_TOP_TIER_KINDS` (which spreads this) and
    // for every derived list, so a reorder is a wider change than an add.
    expect(WORK_ENTITY_KINDS).toEqual(['task', 'note', 'commitment', 'project', 'booking']);
  });

  it('isWorkEntityKind discriminates the closed list', () => {
    expect(isWorkEntityKind('task')).toBe(true);
    expect(isWorkEntityKind('note')).toBe(true);
    expect(isWorkEntityKind('commitment')).toBe(true);
    expect(isWorkEntityKind('project')).toBe(true);
    expect(isWorkEntityKind('memo')).toBe(false);
    expect(isWorkEntityKind('')).toBe(false);
    expect(isWorkEntityKind(undefined)).toBe(false);
  });

  it('isWorkEntitySourceKind narrows from source-top-tier kind', () => {
    expect(isWorkEntitySourceKind('task')).toBe(true);
    expect(isWorkEntitySourceKind('note')).toBe(true);
    expect(isWorkEntitySourceKind('commitment')).toBe(true);
    expect(isWorkEntitySourceKind('project')).toBe(true);
    expect(isWorkEntitySourceKind('mail_message')).toBe(false);
    expect(isWorkEntitySourceKind('contact')).toBe(false);
    expect(isWorkEntitySourceKind('calendar.event')).toBe(false);
  });
});

describe('D-145 PA1 — Source primitive', () => {
  it('exposes the closed source-kind enum', () => {
    expect(SOURCE_KINDS).toEqual(['builtin', 'connection', 'adapter', 'dish']);
    expect(isSourceKind('builtin')).toBe(true);
    expect(isSourceKind('rogue')).toBe(false);
  });

  it('top-tier-kind set covers the four work entities + mail / calendar / contact', () => {
    expect(SOURCE_TOP_TIER_KINDS).toContain('task');
    expect(SOURCE_TOP_TIER_KINDS).toContain('note');
    expect(SOURCE_TOP_TIER_KINDS).toContain('commitment');
    expect(SOURCE_TOP_TIER_KINDS).toContain('project');
    expect(SOURCE_TOP_TIER_KINDS).toContain('mail_message');
    expect(SOURCE_TOP_TIER_KINDS).toContain('calendar.event');
    expect(SOURCE_TOP_TIER_KINDS).toContain('contact');
    expect(isSourceTopTierKind('task')).toBe(true);
    expect(isSourceTopTierKind('not_a_kind')).toBe(false);
  });

  it('Recued built-in source id format is `recued.<kind>`', () => {
    expect(RECUED_BUILTIN_SOURCE_ID('task')).toBe('recued.task');
    expect(RECUED_BUILTIN_SOURCE_ID('note')).toBe('recued.note');
    expect(RECUED_BUILTIN_SOURCE_ID('commitment')).toBe('recued.commitment');
    expect(RECUED_BUILTIN_SOURCE_ID('project')).toBe('recued.project');
  });

  it('connection source id format is `<vendor>.<connection_id>.<kind>`', () => {
    expect(CONNECTION_SOURCE_ID('hubspot', 'conn_1', 'task')).toBe('hubspot.conn_1.task');
    expect(CONNECTION_SOURCE_ID('salesforce', 'sb_42', 'project')).toBe(
      'salesforce.sb_42.project',
    );
  });

  /* ⛔ The `SOURCE_DEFAULT_PREFS_KEY` case is DELETED with the constant
   *  (D-187 Sources half). It had zero production consumers and the name it
   *  pinned — `<kind>.last_used_source_id` — was never written on use. */
});

describe('D-145 PA1 — sync_state + conflict_policy closed lists', () => {
  it('sync_state covers live / stale_unreachable / tombstoned / orphaned', () => {
    expect(SYNC_STATES).toEqual(['live', 'stale_unreachable', 'tombstoned', 'orphaned']);
  });

  it('conflict_policy covers source_wins / recued_wins / manual_merge', () => {
    expect(CONFLICT_POLICIES).toEqual(['source_wins', 'recued_wins', 'manual_merge']);
  });
});

describe('D-145 PA1 — RESERVED_DATA_SUBNAMESPACES widening', () => {
  it('reserves the four work-entity kinds', () => {
    expect(RESERVED_DATA_SUBNAMESPACES.has('task')).toBe(true);
    expect(RESERVED_DATA_SUBNAMESPACES.has('note')).toBe(true);
    expect(RESERVED_DATA_SUBNAMESPACES.has('commitment')).toBe(true);
    expect(RESERVED_DATA_SUBNAMESPACES.has('project')).toBe(true);
  });

  it('preserves the prior reserved entries (no regression)', () => {
    expect(RESERVED_DATA_SUBNAMESPACES.has('memory')).toBe(true);
    expect(RESERVED_DATA_SUBNAMESPACES.has('mail')).toBe(true);
    expect(RESERVED_DATA_SUBNAMESPACES.has('calendar')).toBe(true);
    expect(RESERVED_DATA_SUBNAMESPACES.has('contact')).toBe(true);
    expect(RESERVED_DATA_SUBNAMESPACES.has('crm')).toBe(true);
    expect(RESERVED_DATA_SUBNAMESPACES.has('enrichment')).toBe(true);
  });
});

describe('D-145 PA1 — task contracts', () => {
  it('TASK_PRIORITIES is the closed enum', () => {
    expect(TASK_PRIORITIES).toEqual(['low', 'medium', 'high']);
  });

  it('TASK_TITLE_MAX is 200 per § A.1.1', () => {
    expect(TASK_TITLE_MAX).toBe(200);
  });
});

describe('D-145 PA1 — commitment contracts (orthogonal axes)', () => {
  it('lifecycle_state covers pending / fulfilled / cancelled / expired', () => {
    expect(COMMITMENT_LIFECYCLE_STATES).toEqual(['pending', 'fulfilled', 'cancelled', 'expired']);
  });

  it('due_status is independent — covers not_due / due_soon / overdue / no_deadline', () => {
    expect(COMMITMENT_DUE_STATUSES).toEqual(['not_due', 'due_soon', 'overdue', 'no_deadline']);
  });

  it('expiry_policy covers strict_expire / escalate_overdue / indefinite', () => {
    expect(COMMITMENT_EXPIRY_POLICIES).toEqual([
      'strict_expire',
      'escalate_overdue',
      'indefinite',
    ]);
  });

  it('direction covers outbound / inbound / internal', () => {
    expect(COMMITMENT_DIRECTIONS).toEqual(['outbound', 'inbound', 'internal']);
  });

  it('derivation covers the closed AI / extraction / peer / evidence surface', () => {
    expect(COMMITMENT_DERIVATIONS).toEqual([
      'user_declared',
      'mail_extracted',
      'meeting_extracted',
      'recipe_emitted',
      'peer_received',
      // D-192 F1 — minted from a commitment_evidence capture (ONE value
      // for every evidence family; the evidence_blob entries' `kind`
      // discriminates). Derived-only — never a compose-authoring option.
      'evidence_captured',
    ]);
  });

  it('COMMITMENT_STATEMENT_MAX is 500', () => {
    expect(COMMITMENT_STATEMENT_MAX).toBe(500);
  });

  it('COMMITMENT_CURRENCY_REGEX accepts ISO 4217 three-letter codes', () => {
    expect(COMMITMENT_CURRENCY_REGEX.test('USD')).toBe(true);
    expect(COMMITMENT_CURRENCY_REGEX.test('EUR')).toBe(true);
    expect(COMMITMENT_CURRENCY_REGEX.test('JPY')).toBe(true);
    expect(COMMITMENT_CURRENCY_REGEX.test('usd')).toBe(false);
    expect(COMMITMENT_CURRENCY_REGEX.test('US')).toBe(false);
    expect(COMMITMENT_CURRENCY_REGEX.test('USDT')).toBe(false);
    expect(COMMITMENT_CURRENCY_REGEX.test('840')).toBe(false);
  });

  it('COMMITMENT_AMOUNT_REGEX accepts decimal-as-string at scale 2', () => {
    expect(COMMITMENT_AMOUNT_REGEX.test('5000')).toBe(true);
    expect(COMMITMENT_AMOUNT_REGEX.test('5000.00')).toBe(true);
    expect(COMMITMENT_AMOUNT_REGEX.test('5000.5')).toBe(true);
    expect(COMMITMENT_AMOUNT_REGEX.test('-25.50')).toBe(true);
    expect(COMMITMENT_AMOUNT_REGEX.test('5000.123')).toBe(false);
    expect(COMMITMENT_AMOUNT_REGEX.test('5,000')).toBe(false);
    expect(COMMITMENT_AMOUNT_REGEX.test('5e3')).toBe(false);
    expect(COMMITMENT_AMOUNT_REGEX.test('')).toBe(false);
  });
});

describe('D-145 PA1 — project contracts', () => {
  it('project state covers active / paused / completed / archived', () => {
    expect(PROJECT_STATES).toEqual(['active', 'paused', 'completed', 'archived']);
  });

  it('PROJECT_TITLE_MAX is 200', () => {
    expect(PROJECT_TITLE_MAX).toBe(200);
  });

  it('PROJECT_HIERARCHY_MAX_DEPTH is 3 per § A.1.4', () => {
    expect(PROJECT_HIERARCHY_MAX_DEPTH).toBe(3);
  });
});

describe('D-145 PA1 — canonical schema definitions', () => {
  it('exposes one schema per work-entity kind', () => {
    expect(Object.keys(CANONICAL_SCHEMAS).sort()).toEqual(
      ['booking', 'commitment', 'note', 'project', 'task'].sort(),
    );
  });

  it('each schema declares its own kind', () => {
    expect(getCanonicalSchema('task').kind).toBe('task');
    expect(getCanonicalSchema('note').kind).toBe('note');
    expect(getCanonicalSchema('commitment').kind).toBe('commitment');
    expect(getCanonicalSchema('project').kind).toBe('project');
  });

  it('task schema carries the canonical fields per § A.1.1', () => {
    const fields = new Set(getCanonicalSchema('task').fields.map((f) => f.name));
    expect(fields.has('id')).toBe(true);
    expect(fields.has('title')).toBe(true);
    expect(fields.has('done')).toBe(true);
    expect(fields.has('priority')).toBe(true);
    expect(fields.has('due_at')).toBe(true);
    expect(fields.has('completed_at')).toBe(true);
  });

  it('note schema carries last_user_action_at (NOT last_referenced_at)', () => {
    const fields = new Set(getCanonicalSchema('note').fields.map((f) => f.name));
    expect(fields.has('last_user_action_at')).toBe(true);
    expect(fields.has('last_referenced_at')).toBe(false);
  });

  it('commitment schema carries lifecycle / due / expiry orthogonal axes', () => {
    const fields = new Set(getCanonicalSchema('commitment').fields.map((f) => f.name));
    expect(fields.has('lifecycle_state')).toBe(true);
    expect(fields.has('due_status')).toBe(true);
    expect(fields.has('expiry_policy')).toBe(true);
    // Prior conflated `state` enum is retired per § A.1.3.
    expect(fields.has('state')).toBe(false);
  });

  it('project schema carries last_activity_at + state', () => {
    const fields = new Set(getCanonicalSchema('project').fields.map((f) => f.name));
    expect(fields.has('last_activity_at')).toBe(true);
    expect(fields.has('state')).toBe(true);
  });

  it('task schema declares the relationships per § A.1.1', () => {
    const rels = new Set(getCanonicalSchema('task').relationships.map((r) => r.name));
    expect(rels.has('assigned_contact')).toBe(true);
    expect(rels.has('parent_calendar_event')).toBe(true);
    expect(rels.has('linked_mail_thread')).toBe(true);
    expect(rels.has('parent_project')).toBe(true);
    expect(rels.has('blocks_task')).toBe(true);
  });

  it('commitment monetary_value flattens to amount + currency columns', () => {
    const fields = getCanonicalSchema('commitment').fields;
    const names = new Set(fields.map((f) => f.name));
    expect(names.has('monetary_amount')).toBe(true);
    expect(names.has('monetary_currency')).toBe(true);
  });

  it('every schema carries at least one index per § A.1', () => {
    for (const k of WORK_ENTITY_KINDS) {
      expect(getCanonicalSchema(k).indices.length).toBeGreaterThan(0);
    }
  });

  it('note schema declares the fts5:body index per § A.1.2', () => {
    const flat = getCanonicalSchema('note').indices.flat();
    expect(flat).toContain('fts5:body');
  });
});
