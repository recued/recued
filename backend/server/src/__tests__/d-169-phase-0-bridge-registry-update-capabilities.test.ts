/** D-169 P0 - BridgeRegistry.updateCapabilities tests. */

import { describe, expect, it } from 'vitest';
import type { BridgeCapabilityProfile } from '@recued/contracts';
import {
  createBridgeRegistry,
  type BridgeConnectionRecord,
} from '../bridges/registry.js';

const sampleCapabilities = (
  overrides: Partial<BridgeCapabilityProfile> = {},
): BridgeCapabilityProfile => ({
  software_version: '1.2.3',
  chrome_version: '126.0.6478.0',
  permissions_granted: ['storage'],
  granted_origins: ['*://before.example/*'],
  offscreen_supported: true,
  alarms_supported: false,
  ...overrides,
});

const buildRecord = (
  client_token_id: string,
  overrides: Partial<BridgeConnectionRecord> = {},
): BridgeConnectionRecord => ({
  client_token_id,
  client_label: 'work-laptop',
  session_id: 'sess-original',
  online_since: 1_000,
  last_seen_at: 1_000,
  capabilities: sampleCapabilities(),
  ...overrides,
});

describe('D-169 P0 - BridgeRegistry.updateCapabilities', () => {
  it('returns false when no record exists and does not auto-create', () => {
    const registry = createBridgeRegistry();

    const ok = registry.updateCapabilities(
      'missing-token',
      sampleCapabilities({ granted_origins: ['*://after.example/*'] }),
      2_000,
    );

    expect(ok).toBe(false);
    expect(registry.get('missing-token')).toBeNull();
    expect(registry.list()).toEqual([]);
  });

  it('mutates capabilities and last_seen_at while preserving connection identity fields', () => {
    const registry = createBridgeRegistry();
    registry.attach(buildRecord('tok-1'));
    const updated = sampleCapabilities({
      permissions_granted: ['storage', 'tabs'],
      granted_origins: ['*://after.example/*'],
      alarms_supported: true,
    });

    registry.updateCapabilities('tok-1', updated, 5_000);

    const record = registry.get('tok-1');
    expect(record?.capabilities).toBe(updated);
    expect(record?.last_seen_at).toBe(5_000);
    expect(record?.session_id).toBe('sess-original');
    expect(record?.online_since).toBe(1_000);
    expect(record?.client_label).toBe('work-laptop');
  });

  it('returns true when an existing record was updated', () => {
    const registry = createBridgeRegistry();
    registry.attach(buildRecord('tok-1'));

    expect(registry.updateCapabilities('tok-1', sampleCapabilities(), 2_000))
      .toBe(true);
  });
});
