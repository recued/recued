/** D-153 P1 — AuditEntry commit-substrate field round-trip.
 *
 *  Verifies that the seven new optional fields graduate cleanly through
 *  `buildAuditEntry` + the in-memory audit-log store. Engine wiring
 *  that populates them at runtime is D-145 (later); this test pins the
 *  storage contract so the engine slice has a target to compose with.
 *
 *  Spec: D-153 § Commit substrate. */

import { describe, expect, it } from 'vitest';

import type { ContractSnapshot, ExecutionSource } from '@recued/contracts';

import {
  buildAuditEntry,
  createAuditLogStore,
  createInMemoryCollection,
  type AuditEntry,
  type AuditEntryInput,
  type AuditLogStore,
  type ActivityEntry,
} from '../index.js';

const baseInput: AuditEntryInput = {
  recipe_id: 'r',
  recipe_hash: 'h',
  commit_status: 'succeeded',
  duration_ms: 100,
  errors: [],
};

const sampleContractSnapshot: ContractSnapshot = {
  contract_id: 'c-1',
  contract_version: '1',
  allowed_tools: ['mail.send', 'calendar.create'],
  approval_required: ['high'],
  scope_restrictions: ['data.mail.*', 'connection.notification.email'],
  resolved_at: 1_700_000_000_000,
};

const sampleExecutionSource: ExecutionSource = {
  channel: 'schedule',
  actor: 'system',
  cron: '0 9 * * *',
  source_recipe: 'daily-briefing',
};

const hasOwn = (value: object, key: PropertyKey): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

describe('AuditEntry — D-153 P1 commit-substrate field round-trip', () => {
  it('omits every new optional field when the input leaves them undefined', () => {
    const entry = buildAuditEntry(baseInput);
    expect(entry.commit_kind).toBeUndefined();
    expect(entry.channel_session_id).toBeUndefined();
    expect(entry.cognition_session_id).toBeUndefined();
    expect(entry.correlation_id).toBeUndefined();
    expect(entry.idempotency_key).toBeUndefined();
    expect(entry.predecessor_commit_id).toBeUndefined();
    expect(entry.contract_snapshot).toBeUndefined();
  });

  it('round-trips commit_kind through buildAuditEntry', () => {
    const entry = buildAuditEntry({ ...baseInput, commit_kind: 'action' });
    expect(entry.commit_kind).toBe('action');
  });

  it('round-trips execution_source through buildAuditEntry', () => {
    const entry = buildAuditEntry({
      ...baseInput,
      execution_source: sampleExecutionSource,
    });
    expect(entry.execution_source).toEqual(sampleExecutionSource);
    expect(hasOwn(entry, 'execution_source')).toBe(true);
  });

  it('omits execution_source when the input leaves it undefined', () => {
    const entry = buildAuditEntry(baseInput);
    expect(entry.execution_source).toBeUndefined();
    expect(hasOwn(entry, 'execution_source')).toBe(false);
  });

  it('round-trips the three session-id fields verbatim', () => {
    const entry = buildAuditEntry({
      ...baseInput,
      channel_session_id: 'ch-slack-thread-7',
      cognition_session_id: 'cog-arc-12',
      correlation_id: 'corr-dentist-task',
    });
    expect(entry.channel_session_id).toBe('ch-slack-thread-7');
    expect(entry.cognition_session_id).toBe('cog-arc-12');
    expect(entry.correlation_id).toBe('corr-dentist-task');
  });

  it('round-trips crash-safety fields (idempotency_key + predecessor_commit_id)', () => {
    const entry = buildAuditEntry({
      ...baseInput,
      idempotency_key: 'idem-uuid-abc',
      predecessor_commit_id: 'commit-prev-123',
    });
    expect(entry.idempotency_key).toBe('idem-uuid-abc');
    expect(entry.predecessor_commit_id).toBe('commit-prev-123');
  });

  it('round-trips contract_snapshot with nested structure intact', () => {
    const entry = buildAuditEntry({
      ...baseInput,
      contract_snapshot: sampleContractSnapshot,
    });
    expect(entry.contract_snapshot).toEqual(sampleContractSnapshot);
  });

  it('persists every new field through the in-memory audit-log store', async () => {
    const log: AuditLogStore = createAuditLogStore(
      createInMemoryCollection<AuditEntry>(),
      createInMemoryCollection<ActivityEntry>(),
    );
    const entry = buildAuditEntry({
      ...baseInput,
      commit_kind: 'cognition_output',
      channel_session_id: 'ch-1',
      cognition_session_id: 'cog-1',
      correlation_id: 'corr-1',
      idempotency_key: 'idem-1',
      predecessor_commit_id: 'commit-prev-1',
      contract_snapshot: sampleContractSnapshot,
    });
    await log.append(entry);
    const recent = await log.listRecent(10);
    expect(recent).toHaveLength(1);
    const persisted = recent[0];
    expect(persisted.commit_status).toBe('succeeded');
    expect(persisted.commit_kind).toBe('cognition_output');
    expect(persisted.channel_session_id).toBe('ch-1');
    expect(persisted.cognition_session_id).toBe('cog-1');
    expect(persisted.correlation_id).toBe('corr-1');
    expect(persisted.idempotency_key).toBe('idem-1');
    expect(persisted.predecessor_commit_id).toBe('commit-prev-1');
    expect(persisted.contract_snapshot).toEqual(sampleContractSnapshot);
  });

  it('rejects commit_status outside the CommitStatus enum at compile time (type-level)', () => {
    // Compile-time assertion only — verified by tsc, not at runtime.
    // If a future edit weakens the type signature, this snippet starts
    // failing to compile.
    const ok: AuditEntryInput['commit_status'] = 'in_doubt';
    expect(ok).toBe('in_doubt');
    // @ts-expect-error — 'unknown_status' is not a CommitStatus literal.
    const bad: AuditEntryInput['commit_status'] = 'unknown_status';
    expect(bad).toBe('unknown_status');
  });
});
