/** D-165 P3.path-picker (Slice 3b) — the gateway audit EMITTER must persist
 *  the `path_scope` forensic detail into the durable `connection_gateway`
 *  activity row, not just carry it on the in-memory `GatewayCallAudit`. The
 *  spec (D-165:933`) requires the row to hold the connection's
 *  canonical path + the call's canonical target + the template that produced
 *  it; an emitter that dropped `path_scope` would leave scoped-denial
 *  investigations opaque. */
import { describe, it, expect } from 'vitest';
import type { GatewayCallAudit } from '@recued/contracts';
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

const baseEvent = (): GatewayCallAudit => ({
  ingredient_id: 'pub/cat',
  operation_id: 'pub/cat.objects.get',
  operation_group: 'g',
  connection_name: 'my-bucket',
  risk_tier: 'read',
  approval: 'never',
  outcome: 'failed',
});

describe('D-165 P3 gateway audit emitter — path_scope persistence', () => {
  it('persists the full path_scope detail into the durable row on a violation', () => {
    const { auditLog, entries } = makeAuditLogStub();
    const emit = createGatewayAuditEmitter(auditLog, () => 1700000000000);

    emit({
      ...baseEvent(),
      failure_mode: 'path_scope_violation',
      path_scope: {
        policy: 'descendant_only',
        connection_path: '/my-bucket',
        target_path: '/other-bucket/key',
        template: '/{bucket}/{key}',
        reason: 'not_in_scope',
      },
    });

    expect(entries).toHaveLength(1);
    expect(entries[0].action).toBe('connection_gateway');
    expect(entries[0].target).toBe('my-bucket');

    const detail = JSON.parse(entries[0].detail ?? '{}');
    expect(detail.source).toBe(CONNECTION_GATEWAY_AUDIT_SOURCE);
    expect(detail.failure_mode).toBe('path_scope_violation');
    // The spec-required forensic triple (`:933`) + the policy + reason all
    // survive serialization into the persisted row.
    expect(detail.path_scope).toEqual({
      policy: 'descendant_only',
      connection_path: '/my-bucket',
      target_path: '/other-bucket/key',
      template: '/{bucket}/{key}',
      reason: 'not_in_scope',
    });
  });

  it('preserves a path_scope detail that omits target_path (unresolved template token)', () => {
    const { auditLog, entries } = makeAuditLogStub();
    const emit = createGatewayAuditEmitter(auditLog, () => 1);

    emit({
      ...baseEvent(),
      failure_mode: 'path_scope_violation',
      path_scope: {
        policy: 'descendant_only',
        connection_path: '/my-bucket',
        template: '/{bucket}/{key}',
        reason: 'unresolved_template_token',
      },
    });

    const detail = JSON.parse(entries[0].detail ?? '{}');
    expect(detail.path_scope.reason).toBe('unresolved_template_token');
    expect('target_path' in detail.path_scope).toBe(false);
  });

  it('omits path_scope entirely from a successful (in-scope / no-contract) row', () => {
    const { auditLog, entries } = makeAuditLogStub();
    const emit = createGatewayAuditEmitter(auditLog, () => 1);

    emit({ ...baseEvent(), outcome: 'success', duration_ms: 5 });

    const detail = JSON.parse(entries[0].detail ?? '{}');
    expect(detail.outcome).toBe('success');
    expect('path_scope' in detail).toBe(false);
  });
});
