/** D-157 P1 - preflight checkpoint contracts.
 *
 *  Pins the structural `Checkpoint` guard and the run-anchor status
 *  extension that lets a recipe-run anchor pause at `'awaiting_approval'`
 *  without widening the per-commit `CommitStatus` closed list. */

import { describe, expect, it } from 'vitest';

import type { Checkpoint } from '../checkpoint.js';
import { isCheckpoint } from '../checkpoint.js';
import { hashForeachCheckpointSource } from '../foreach-checkpoint.js';
import {
  COMMIT_STATUSES,
  RUN_ANCHOR_STATUSES,
  isRunAnchorStatus,
} from '../commits.js';

const checkpoint = (overrides: Partial<Checkpoint> = {}): Checkpoint => ({
  checkpoint_id: 'checkpoint-1',
  run_id: 'run-1',
  recipe_id: 'recipe-1',
  gated_step_id: 'send-mail',
  step_state: { lookup: { email: 'ada@example.com' } },
  created_at: 1_700_000_000_000,
  ...overrides,
});

const without = (
  field: keyof Checkpoint,
): Record<string, unknown> => {
  const candidate = { ...checkpoint() } as Record<string, unknown>;
  delete candidate[field];
  return candidate;
};

const invalidStringFieldCandidates = (
  field: keyof Pick<
    Checkpoint,
    'checkpoint_id' | 'run_id' | 'recipe_id' | 'gated_step_id'
  >,
): unknown[] => [
  without(field),
  { ...checkpoint(), [field]: null },
  { ...checkpoint(), [field]: '' },
  { ...checkpoint(), [field]: 0 },
  { ...checkpoint(), [field]: { nested: true } },
];

describe('Checkpoint', () => {
  it('isCheckpoint accepts a fully-valid checkpoint object', () => {
    expect(isCheckpoint(checkpoint())).toBe(true);
  });

  it('accepts recipe and foreach authority pins with valid shapes', () => {
    const source = [{ email: 'a@example.test' }, { email: 'b@example.test' }];
    expect(isCheckpoint(checkpoint({
      recipe_source_hash: 'recipe-source-v1',
      gated_action_predecessor_ref: 'action-segment-1',
      foreach_progress: {
        step_id: 'send-mail',
        next_index: 1,
        source_length: source.length,
        source_hash: hashForeachCheckpointSource(source),
        results: [{ ok: true, item: source[0], result: { sent: true } }],
      },
    }))).toBe(true);
  });

  it('rejects an empty or non-string gated-action segment predecessor', () => {
    for (const gated_action_predecessor_ref of ['', 0, null, {}]) {
      expect(isCheckpoint({
        ...checkpoint(),
        gated_action_predecessor_ref,
      })).toBe(false);
    }
    expect(isCheckpoint(checkpoint({
      gated_action_predecessor_ref: 'action-segment-1',
    }))).toBe(false);
  });

  it('rejects a malformed or missing complete-source foreach pin', () => {
    const base = {
      step_id: 'send-mail',
      next_index: 1,
      source_length: 2,
      source_hash: 'a'.repeat(64),
      results: [{ ok: true, item: 'first' }],
    };
    for (const source_hash of [undefined, '', 'A'.repeat(64), 'a'.repeat(63)]) {
      expect(isCheckpoint({
        ...checkpoint(),
        foreach_progress: { ...base, source_hash },
      })).toBe(false);
    }
  });

  it('keeps recipe_source_hash out of the raw-op checkpoint partition', () => {
    expect(isCheckpoint({
      ...rawOpCheckpoint(),
      recipe_source_hash: 'recipe-source-v1',
    })).toBe(false);
  });

  it('isCheckpoint accepts a checkpoint with approved_target identity fields', () => {
    expect(isCheckpoint(checkpoint({
      approved_target: {
        ingredient_slug: 'x',
        operation_id: 'y',
        connection_name: 'z',
      },
    }))).toBe(true);
  });

  it('isCheckpoint rejects approved_target with a non-string present field', () => {
    expect(isCheckpoint({
      ...checkpoint(),
      approved_target: { operation_id: 42 },
    })).toBe(false);
  });

  it('isCheckpoint rejects an approved_target array', () => {
    expect(isCheckpoint({
      ...checkpoint(),
      approved_target: ['x'],
    })).toBe(false);
  });

  it('isCheckpoint accepts a checkpoint with no approved_target', () => {
    const candidate = checkpoint();

    expect(candidate).not.toHaveProperty('approved_target');
    expect(isCheckpoint(candidate)).toBe(true);
  });

  // D-173 N.5 — editable-args boundary object. Mirrors the
  // `approved_target` JSON-narrowing cases: a present `arg_overrides`
  // must be a plain non-array object; absent passes unchanged.
  it('isCheckpoint accepts a checkpoint with a plain arg_overrides object', () => {
    expect(isCheckpoint(checkpoint({
      arg_overrides: { start_at: 1_700_000_100_000, calendar_id: 'cal-x' },
    }))).toBe(true);
  });

  it('isCheckpoint accepts an empty arg_overrides object', () => {
    expect(isCheckpoint(checkpoint({ arg_overrides: {} }))).toBe(true);
  });

  it('isCheckpoint accepts a checkpoint with no arg_overrides (byte-unchanged path)', () => {
    const candidate = checkpoint();

    expect(candidate).not.toHaveProperty('arg_overrides');
    expect(isCheckpoint(candidate)).toBe(true);
  });

  it('isCheckpoint rejects a non-object arg_overrides (string / number / array / null)', () => {
    const candidates: unknown[] = [
      { ...checkpoint(), arg_overrides: 'edits' },
      { ...checkpoint(), arg_overrides: 42 },
      { ...checkpoint(), arg_overrides: ['start_at'] },
      { ...checkpoint(), arg_overrides: null },
      { ...checkpoint(), arg_overrides: true },
    ];

    for (const candidate of candidates) expect(isCheckpoint(candidate)).toBe(false);
  });

  it('isCheckpoint rejects invalid checkpoint_id values', () => {
    for (const candidate of invalidStringFieldCandidates('checkpoint_id')) {
      expect(isCheckpoint(candidate)).toBe(false);
    }
  });

  it('isCheckpoint rejects invalid run_id values', () => {
    for (const candidate of invalidStringFieldCandidates('run_id')) {
      expect(isCheckpoint(candidate)).toBe(false);
    }
  });

  it('isCheckpoint rejects invalid recipe_id values', () => {
    for (const candidate of invalidStringFieldCandidates('recipe_id')) {
      expect(isCheckpoint(candidate)).toBe(false);
    }
  });

  it('isCheckpoint rejects invalid gated_step_id values', () => {
    for (const candidate of invalidStringFieldCandidates('gated_step_id')) {
      expect(isCheckpoint(candidate)).toBe(false);
    }
  });

  it('isCheckpoint rejects invalid step_state values', () => {
    const candidates: unknown[] = [
      without('step_state'),
      { ...checkpoint(), step_state: null },
      { ...checkpoint(), step_state: [] },
      { ...checkpoint(), step_state: 'state' },
      { ...checkpoint(), step_state: 1 },
    ];

    for (const candidate of candidates) expect(isCheckpoint(candidate)).toBe(false);
  });

  it('isCheckpoint rejects invalid created_at values', () => {
    const candidates: unknown[] = [
      without('created_at'),
      { ...checkpoint(), created_at: Number.NaN },
      { ...checkpoint(), created_at: Infinity },
      { ...checkpoint(), created_at: -Infinity },
      { ...checkpoint(), created_at: '1700000000000' },
      { ...checkpoint(), created_at: null },
      { ...checkpoint(), created_at: undefined },
    ];

    for (const candidate of candidates) expect(isCheckpoint(candidate)).toBe(false);
  });

  it('isCheckpoint rejects non-object inputs without throwing', () => {
    expect(isCheckpoint(null)).toBe(false);
    expect(isCheckpoint(undefined)).toBe(false);
    expect(isCheckpoint([])).toBe(false);
    expect(isCheckpoint('checkpoint')).toBe(false);
    expect(isCheckpoint(42)).toBe(false);
  });

  it('isCheckpoint tolerates extra unknown fields', () => {
    expect(isCheckpoint({
      ...checkpoint(),
      ask_id: 'ask-1',
      ignored: { nested: true },
    })).toBe(true);
  });
});

// D-182 §8 — the recipe-LESS raw-op door checkpoint discriminant.
const rawOpBlock = (
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  op_id: 'recued-core.crm-pack.deal.create',
  catalog_slug: 'recued-core/hubspot-catalog',
  operation: 'deal.create',
  connection_name: 'hubspot-prod',
  op_args: { body: { properties: { dealname: 'Acme' } } },
  execution_source: {
    channel: 'mcp',
    actor: 'contracted_user',
    agent_id: 'agent-1',
    tool_call_id: 'call-1',
    mcp_token_id: 'tok-1',
    contract_id: 'contract-1',
  },
  risk_tier: 'write',
  arg_shape_hash: 'arg-hash',
  canonical_payload_hash: 'payload-hash',
  correlation_id: 'call-1',
  ...overrides,
});

const rawOpCheckpoint = (
  rawOverrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  checkpoint_id: 'checkpoint-raw-1',
  run_id: 'run-raw-1',
  step_state: {},
  raw_op: rawOpBlock(rawOverrides),
  created_at: 1_700_000_000_000,
});

describe('Checkpoint raw_op discriminant (D-182 §8)', () => {
  it('accepts a fully-valid recipe-less raw-op checkpoint', () => {
    expect(isCheckpoint(rawOpCheckpoint())).toBe(true);
  });

  it('accepts a raw-op checkpoint for a connectionless (ai/storage) op', () => {
    // The op resolves no connection — `connection_name` is `''`, not absent.
    expect(isCheckpoint(rawOpCheckpoint({ connection_name: '' }))).toBe(true);
  });

  it('accepts a raw-op checkpoint with no optional hashes (un-canonicalizable payload)', () => {
    const candidate = rawOpCheckpoint();
    const raw = (candidate.raw_op as Record<string, unknown>);
    delete raw.arg_shape_hash;
    delete raw.canonical_payload_hash;
    delete raw.correlation_id;
    expect(isCheckpoint(candidate)).toBe(true);
  });

  it('accepts a raw-op checkpoint with a contract_snapshot object', () => {
    expect(isCheckpoint(
      rawOpCheckpoint({ contract_snapshot: { allowed_tools: [] } }),
    )).toBe(true);
  });

  it('rejects a raw-op checkpoint that ALSO carries recipe_id (mixed partition)', () => {
    expect(isCheckpoint({ ...rawOpCheckpoint(), recipe_id: 'recipe-1' })).toBe(false);
  });

  it('rejects a raw-op checkpoint that ALSO carries gated_step_id (mixed partition)', () => {
    expect(isCheckpoint({ ...rawOpCheckpoint(), gated_step_id: 'send' })).toBe(false);
  });

  it('rejects a raw-op block missing a required identity field', () => {
    for (const f of ['op_id', 'catalog_slug', 'operation', 'risk_tier'] as const) {
      // Build the full checkpoint, then DELETE the field off its block (passing
      // a partial as overrides would just let `rawOpBlock`'s defaults re-add it).
      const candidate = rawOpCheckpoint();
      delete (candidate.raw_op as Record<string, unknown>)[f];
      expect(isCheckpoint(candidate)).toBe(false);
      // empty string is also rejected for the non-empty fields
      expect(isCheckpoint(rawOpCheckpoint({ [f]: '' }))).toBe(false);
    }
  });

  it('rejects a raw-op block with a non-string connection_name', () => {
    expect(isCheckpoint(rawOpCheckpoint({ connection_name: 42 }))).toBe(false);
    expect(isCheckpoint(rawOpCheckpoint({ connection_name: null }))).toBe(false);
  });

  it('rejects a raw-op block whose op_args / execution_source is not a plain object', () => {
    expect(isCheckpoint(rawOpCheckpoint({ op_args: ['x'] }))).toBe(false);
    expect(isCheckpoint(rawOpCheckpoint({ op_args: 'args' }))).toBe(false);
    expect(isCheckpoint(rawOpCheckpoint({ execution_source: null }))).toBe(false);
    expect(isCheckpoint(rawOpCheckpoint({ execution_source: [] }))).toBe(false);
  });

  it('rejects a raw-op block with a non-string optional hash', () => {
    expect(isCheckpoint(rawOpCheckpoint({ arg_shape_hash: 7 }))).toBe(false);
    expect(isCheckpoint(rawOpCheckpoint({ canonical_payload_hash: {} }))).toBe(false);
    expect(isCheckpoint(rawOpCheckpoint({ correlation_id: 1 }))).toBe(false);
  });

  it('rejects a non-object / array raw_op block', () => {
    expect(isCheckpoint({ ...rawOpCheckpoint(), raw_op: null })).toBe(false);
    expect(isCheckpoint({ ...rawOpCheckpoint(), raw_op: [] })).toBe(false);
    expect(isCheckpoint({ ...rawOpCheckpoint(), raw_op: 'op' })).toBe(false);
  });

  it('still requires checkpoint_id / run_id / step_state / created_at on a raw-op checkpoint', () => {
    expect(isCheckpoint({ ...rawOpCheckpoint(), checkpoint_id: '' })).toBe(false);
    expect(isCheckpoint({ ...rawOpCheckpoint(), run_id: '' })).toBe(false);
    expect(isCheckpoint({ ...rawOpCheckpoint(), step_state: null })).toBe(false);
    expect(isCheckpoint({ ...rawOpCheckpoint(), created_at: Number.NaN })).toBe(false);
  });
});

describe('RunAnchorStatus', () => {
  it('RUN_ANCHOR_STATUSES extends every CommitStatus with the two HOLDS', () => {
    for (const status of COMMIT_STATUSES) {
      expect(RUN_ANCHOR_STATUSES).toContain(status);
    }
    expect(RUN_ANCHOR_STATUSES).toContain('awaiting_approval');
    // D-234 § 234.4 — `awaiting_peer`: held for a PEER'S owner's answer. This
    // ratchet caught the widening, which is what it is for; the count is bumped
    // deliberately rather than relaxed. A hold is a run suspended into a live
    // `Checkpoint`, and the two differ only in WHERE the ask lives — here, or on
    // the peer's server. `isHeldRunAnchorStatus` is the predicate every resumer /
    // boot sweep / retention scan should use instead of either literal.
    expect(RUN_ANCHOR_STATUSES).toContain('awaiting_peer');
    expect(RUN_ANCHOR_STATUSES).toHaveLength(COMMIT_STATUSES.length + 2);
  });

  it('keeps awaiting_approval out of the CommitStatus closed list', () => {
    expect(COMMIT_STATUSES).not.toContain('awaiting_approval');
  });

  it('keeps COMMIT_STATUSES pinned to the seven commit lifecycle states (D-181 adds killed)', () => {
    expect(COMMIT_STATUSES).toEqual([
      'pending',
      'running',
      'succeeded',
      'failed',
      'cancelled',
      'killed',
      'in_doubt',
    ]);
  });

  it('isRunAnchorStatus accepts every run-anchor status', () => {
    for (const status of RUN_ANCHOR_STATUSES) {
      expect(isRunAnchorStatus(status)).toBe(true);
    }
  });

  it('isRunAnchorStatus rejects unknown strings, wrong case, and non-strings', () => {
    expect(isRunAnchorStatus('unknown')).toBe(false);
    expect(isRunAnchorStatus('committed')).toBe(false);
    expect(isRunAnchorStatus('')).toBe(false);
    expect(isRunAnchorStatus('AWAITING_APPROVAL')).toBe(false);
    expect(isRunAnchorStatus(42)).toBe(false);
    expect(isRunAnchorStatus(null)).toBe(false);
    expect(isRunAnchorStatus(undefined)).toBe(false);
    expect(isRunAnchorStatus({})).toBe(false);
    expect(isRunAnchorStatus([])).toBe(false);
  });
});
