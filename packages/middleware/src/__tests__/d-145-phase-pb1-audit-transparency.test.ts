/** D-145 PB1.5 — audit + transparency emission round-trip tests. */

import { describe, expect, it } from 'vitest';

import * as capacity from '../capacity/index.js';
import {
  CAPACITY_AUDIT_GAP_ACTION,
  CAPACITY_AUDIT_OK_ACTION,
  type CapacityCheckAuditDetail,
} from '@recued/contracts';

describe('D-145 PB1.5 — audit emitter', () => {
  it('emitOk passes JSON-encoded detail through to logActivity', async () => {
    const calls: { action: string; target: string; detail?: string }[] = [];
    const adapter: capacity.AuditLogAdapter = {
      logActivity(entry) {
        calls.push({ action: entry.action, target: entry.target, detail: entry.detail });
      },
    };
    const emitter = capacity.createCapacityAuditEmitter(adapter);
    const detail: CapacityCheckAuditDetail = {
      walk_id: 'w1',
      capacity_keys: ['bridge_online'],
      cache_hits: 0,
      cache_misses: 1,
    };
    await emitter.emitOk(detail, {
      audit_emitter: emitter,
      transparency_emitter: { async emit() {} },
      primitive: 'bridge.dispatch',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.action).toBe(CAPACITY_AUDIT_OK_ACTION);
    expect(calls[0]!.target).toBe('bridge.dispatch');
    expect(JSON.parse(calls[0]!.detail!).walk_id).toBe('w1');
  });

  it('emitGap uses the gap action code', async () => {
    const calls: { action: string }[] = [];
    const adapter: capacity.AuditLogAdapter = {
      logActivity(entry) {
        calls.push({ action: entry.action });
      },
    };
    const emitter = capacity.createCapacityAuditEmitter(adapter);
    await emitter.emitGap(
      {
        walk_id: 'w1',
        capacity_keys: ['bridge_online'],
        cache_hits: 0,
        cache_misses: 1,
        gap_kind: 'bridge_online',
        gap_key: 'bridge_online',
      },
      {
        audit_emitter: emitter,
        transparency_emitter: { async emit() {} },
      },
    );
    expect(calls[0]!.action).toBe(CAPACITY_AUDIT_GAP_ACTION);
  });
});

describe('D-145 PB1.5 — transparency emitter', () => {
  it('createCapturingTransparencyEmitter records emitted events', async () => {
    const [emitter, events] = capacity.createCapturingTransparencyEmitter();
    await emitter.emit({
      kind: 'capacity_check.gap',
      walk_id: 'w1',
      gap_kind: 'bridge_online',
      gap_key: 'bridge_online',
      gap_params: { kind: 'bridge_online' },
      remediation: {
        action: 'show_bridge_install_prompt',
        user_facing_copy: 'Install.',
      },
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.gap_kind).toBe('bridge_online');
  });

  it('noop emitter is silent', async () => {
    const emitter = capacity.createNoopTransparencyEmitter();
    await emitter.emit({
      kind: 'capacity_check.gap',
      walk_id: 'w1',
      gap_kind: 'bridge_online',
      gap_key: 'bridge_online',
      gap_params: { kind: 'bridge_online' },
      remediation: {
        action: 'show_bridge_install_prompt',
        user_facing_copy: 'Install.',
      },
    });
    // no assertion — just that it doesn't throw.
    expect(true).toBe(true);
  });
});
