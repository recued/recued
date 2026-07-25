/** D-145 engine-wiring slice 3a — D-153 atomic commit predicates. */

import { describe, expect, it } from 'vitest';

import {
  MAX_DISPATCH_DEPTH,
  isCommit,
  isContractSnapshot,
  type Commit,
  type ContractSnapshot,
  type ExecutionSource,
} from '../commits.js';

const validSource = (): ExecutionSource => ({
  channel: 'mcp',
  actor: 'contracted_user',
  agent_id: 'agent-1',
  tool_call_id: 'tool-call-1',
  mcp_token_id: 'mcp-token-1',
  contract_id: 'contract-1',
});

const validSnapshot = (): ContractSnapshot => ({
  contract_id: 'contract-1',
  contract_version: 'v3',
  allowed_tools: ['mail.send', 'calendar.create'],
  approval_required: ['destructive'],
  scope_restrictions: ['data.mail.read', 'connection.calendar.write'],
  resolved_at: 1_700_000_000_100,
});

const validCommit = (overrides: Partial<Commit> = {}): Commit => ({
  commit_id: 'commit-1',
  kind: 'action',
  ingredient: 'mail',
  tool: 'send',
  args: { to: 'ada@example.com', subject: 'Hello' },
  output: { provider_id: 'msg-1' },
  status: 'succeeded',
  source: validSource(),
  contract_snapshot: validSnapshot(),
  channel_session_id: 'mcp:agent-1',
  cognition_session_id: 'cognition-1',
  correlation_id: 'corr-1',
  request_id: 'request-1',
  predecessor_commit_id: 'commit-0',
  dispatch_depth: 2,
  idempotency_key: 'idem-1',
  dispatched_at: 1_700_000_000_000,
  completed_at: 1_700_000_000_250,
  duration_ms: 250,
  ...overrides,
});

const minimalCommit = (): Record<string, unknown> => ({
  commit_id: 'commit-1',
  kind: 'query',
  ingredient: 'calendar',
  tool: 'list',
  args: {},
  status: 'pending',
  source: {
    channel: 'user',
    actor: 'user_self',
    user_id: 'user-1',
    client_token_id: 'client-token-1',
  },
  channel_session_id: 'user:user-1',
  correlation_id: 'corr-1',
  request_id: 'request-1',
  dispatch_depth: 0,
  idempotency_key: 'idem-1',
  dispatched_at: 1_700_000_000_000,
});

const withoutField = (
  value: object,
  field: string,
): Record<string, unknown> => {
  const next = { ...value } as Record<string, unknown>;
  delete next[field];
  return next;
};

describe('D-145 slice 3a Commit predicate', () => {
  it('exports the D-153 dispatch-depth ceiling', () => {
    expect(MAX_DISPATCH_DEPTH).toBe(32);
  });

  it('accepts a fully valid commit with nested source and contract snapshot', () => {
    expect(isCommit(validCommit())).toBe(true);
  });

  it('accepts commits when optional fields are absent', () => {
    const commit = minimalCommit();

    expect(commit).not.toHaveProperty('output');
    expect(commit).not.toHaveProperty('arg_shape_hash');
    expect(commit).not.toHaveProperty('canonical_payload_hash');
    expect(commit).not.toHaveProperty('entity_scope');
    expect(commit).not.toHaveProperty('cognition_session_id');
    expect(commit).not.toHaveProperty('predecessor_commit_id');
    expect(commit).not.toHaveProperty('completed_at');
    expect(commit).not.toHaveProperty('duration_ms');
    expect(commit).not.toHaveProperty('contract_snapshot');
    expect(isCommit(commit)).toBe(true);
  });

  it('accepts D-177 action-identity stamp fields as optional strings', () => {
    expect(isCommit({
      ...minimalCommit(),
      arg_shape_hash: 'shape-hash',
      canonical_payload_hash: 'payload-hash',
      entity_scope: 'crm:deal:42',
    })).toBe(true);
  });

  it('rejects non-string D-177 action-identity stamp fields when present', () => {
    const badValues: Array<[string, unknown]> = [
      ['arg_shape_hash', 123],
      ['canonical_payload_hash', null],
      ['entity_scope', { id: '42' }],
    ];

    for (const [field, badValue] of badValues) {
      expect(isCommit({ ...minimalCommit(), [field]: badValue }), field).toBe(false);
    }
  });

  it('rejects each required commit field when missing', () => {
    const requiredFields = [
      'commit_id',
      'kind',
      'ingredient',
      'tool',
      'args',
      'status',
      'source',
      'channel_session_id',
      'correlation_id',
      'dispatch_depth',
      'idempotency_key',
      'dispatched_at',
    ];

    for (const field of requiredFields) {
      expect(isCommit(withoutField(minimalCommit(), field)), field).toBe(false);
    }
  });

  it('rejects each required commit field when wrong-typed', () => {
    const badValues: Array<[string, unknown]> = [
      ['commit_id', 123],
      ['kind', 123],
      ['ingredient', false],
      ['tool', 42],
      ['args', []],
      ['status', 123],
      ['source', 123],
      ['channel_session_id', null],
      ['correlation_id', false],
      ['dispatch_depth', '0'],
      ['idempotency_key', 42],
      ['dispatched_at', '1700000000000'],
    ];

    for (const [field, badValue] of badValues) {
      expect(isCommit({ ...minimalCommit(), [field]: badValue }), field).toBe(false);
    }
  });

  it('rejects non-integer and negative dispatch depths', () => {
    expect(isCommit({ ...minimalCommit(), dispatch_depth: 1.5 })).toBe(false);
    expect(isCommit({ ...minimalCommit(), dispatch_depth: -1 })).toBe(false);
  });

  it('rejects a malformed nested source', () => {
    expect(isCommit({
      ...minimalCommit(),
      source: {
        channel: 'housekeeping',
        actor: 'system',
        cycle_id: 'cycle-1',
        task: 'sweep',
        visible_to_user: true,
      },
    })).toBe(false);
  });

  it('rejects a malformed nested contract snapshot', () => {
    expect(isCommit({
      ...minimalCommit(),
      contract_snapshot: {
        ...validSnapshot(),
        allowed_tools: ['mail.send', 7],
      },
    })).toBe(false);
  });
});

describe('D-145 slice 3a ContractSnapshot predicate', () => {
  it('accepts a fully valid contract snapshot', () => {
    expect(isContractSnapshot(validSnapshot())).toBe(true);
  });

  it('rejects each required snapshot field when missing', () => {
    const requiredFields = [
      'contract_id',
      'contract_version',
      'allowed_tools',
      'approval_required',
      'scope_restrictions',
      'resolved_at',
    ];

    for (const field of requiredFields) {
      expect(isContractSnapshot(withoutField(validSnapshot(), field)), field).toBe(false);
    }
  });

  it('rejects each required snapshot field when wrong-typed', () => {
    const badValues: Array<[string, unknown]> = [
      ['contract_id', 123],
      ['contract_version', 3],
      ['allowed_tools', ['mail.send', 7]],
      ['approval_required', 'destructive'],
      ['scope_restrictions', [false]],
      ['resolved_at', '1700000000100'],
    ];

    for (const [field, badValue] of badValues) {
      expect(isContractSnapshot({ ...validSnapshot(), [field]: badValue }), field)
        .toBe(false);
    }
  });

});
