/** D-182 §6 / §10 step 7 — the gateway audit EMITTER must persist the op-level
 *  audit identity (`execution_source` + `origin_unit_id` + `canonical_arg_hash`)
 *  into the durable `connection_gateway` activity row, so a raw op the LLM calls
 *  WITHOUT a recipe is still attributable (who) + groupable (origin unit) +
 *  payload-identifiable in the audit log. An emitter that dropped them would
 *  leave a recipe-less call opaque — the exact gap §8 raw-op door exposure is
 *  gated on closing. Mirrors the D-165 P3 path_scope-persistence test. */
import { describe, it, expect } from 'vitest';
import type { ExecutionSource, GatewayCallAudit } from '@recued/contracts';
import { CONNECTION_GATEWAY_AUDIT_SOURCE } from '@recued/contracts';
import type { ActivityEntry, AuditLogStore } from '@recued/storage';

import { createGatewayAuditEmitter } from '../server-executor.js';

/** Minimal `AuditLogStore` stub — the emitter only ever calls `logActivity`. */
const makeAuditLogStub = () => {
  const entries: ActivityEntry[] = [];
  const auditLog = {
    logActivity: (entry: ActivityEntry) => {
      entries.push(entry);
      return Promise.resolve();
    },
  } as unknown as AuditLogStore;
  return { auditLog, entries };
};

const mcpSource: ExecutionSource = {
  channel: 'mcp',
  actor: 'contracted_user',
  agent_id: 'agent-1',
  tool_call_id: 'tc-1',
  mcp_token_id: 'mt-1',
  contract_id: 'k-1',
};

const baseEvent = (): GatewayCallAudit => ({
  ingredient_id: 'pub/cat',
  operation_id: 'pub/cat.objects.get',
  operation_group: 'g',
  connection_name: 'my-bucket',
  risk_tier: 'read',
  approval: 'never',
  outcome: 'success',
});

describe('D-182 step 7 gateway audit emitter — op-level identity persistence', () => {
  it('persists execution_source + origin_unit_id + canonical_arg_hash into the durable row', () => {
    const { auditLog, entries } = makeAuditLogStub();
    const emit = createGatewayAuditEmitter(auditLog, () => 1700000000000);

    emit({
      ...baseEvent(),
      recipe_id: 'detect-deal-risk',
      step_id: 'score',
      execution_source: mcpSource,
      origin_unit_id: 'corr-1',
      canonical_arg_hash: 'abc123',
    });

    expect(entries).toHaveLength(1);
    const detail = JSON.parse(entries[0].detail ?? '{}');
    expect(detail.source).toBe(CONNECTION_GATEWAY_AUDIT_SOURCE);
    expect(detail.execution_source).toEqual(mcpSource);
    expect(detail.origin_unit_id).toBe('corr-1');
    expect(detail.canonical_arg_hash).toBe('abc123');
  });

  it('persists a recipe-less (raw-op) row: NO recipe_id / step_id, but the op-level identity stands', () => {
    const { auditLog, entries } = makeAuditLogStub();
    const emit = createGatewayAuditEmitter(auditLog, () => 1);

    // No recipe_id / step_id — a raw op the LLM called directly (§8).
    emit({
      ...baseEvent(),
      execution_source: mcpSource,
      origin_unit_id: 'corr-raw',
      canonical_arg_hash: 'deadbeef',
    });

    const detail = JSON.parse(entries[0].detail ?? '{}');
    // No synthetic recipe is fabricated.
    expect('recipe_id' in detail).toBe(false);
    expect('step_id' in detail).toBe(false);
    // … yet the row is op-level auditable: action + target are recipe-independent.
    expect(entries[0].action).toBe('connection_gateway');
    expect(entries[0].target).toBe('my-bucket');
    expect(detail.origin_unit_id).toBe('corr-raw');
    expect(detail.execution_source).toEqual(mcpSource);
    expect(detail.canonical_arg_hash).toBe('deadbeef');
  });

  it('omits the identity fields entirely when the event carries none (source-less dispatch path)', () => {
    const { auditLog, entries } = makeAuditLogStub();
    const emit = createGatewayAuditEmitter(auditLog, () => 1);

    emit({ ...baseEvent(), recipe_id: 'r1', step_id: 's1' });

    const detail = JSON.parse(entries[0].detail ?? '{}');
    expect('execution_source' in detail).toBe(false);
    expect('origin_unit_id' in detail).toBe(false);
    expect('canonical_arg_hash' in detail).toBe(false);
    // the recipe-origin fields are unchanged.
    expect(detail.recipe_id).toBe('r1');
    expect(detail.step_id).toBe('s1');
  });
});
