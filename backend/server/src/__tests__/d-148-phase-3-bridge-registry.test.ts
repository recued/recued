/** D-148 P3 — bridge registry + context.bridge injection tests.
 *
 *  Covers spec § A.3.6 — registry tracks per-bridge connection state
 *  + populates context.bridge.online for the engine. */

import { describe, it, expect } from 'vitest';
import {
  buildContextBridge,
  createBridgeRegistry,
  type BridgeConnectionRecord,
} from '../bridges/registry.js';
import type { BridgeCapabilityProfile } from '@recued/contracts';

const sample_capabilities: BridgeCapabilityProfile = {
  software_version: '0.0.1',
  chrome_version: '124.0.0.0',
  permissions_granted: ['storage', 'alarms', 'offscreen', 'notifications', 'tabs', 'scripting'],
  granted_origins: ['*://app.hubspot.com/*'],
  offscreen_supported: true,
  alarms_supported: true,
};

const buildRecord = (
  client_token_id: string,
  online_since: number,
  client_label?: string,
): BridgeConnectionRecord => ({
  client_token_id,
  client_label,
  session_id: `sess-${client_token_id}`,
  online_since,
  last_seen_at: online_since,
  capabilities: sample_capabilities,
});

describe('D-148 P3 — registry attach/detach', () => {
  it('attach + get round-trip', () => {
    const r = createBridgeRegistry();
    const rec = buildRecord('tok-1', 1_000);
    r.attach(rec);
    expect(r.get('tok-1')).toEqual(rec);
  });

  it('attach replaces prior entry for same token (reconnect semantics)', () => {
    const r = createBridgeRegistry();
    r.attach(buildRecord('tok-1', 1_000));
    const fresh = buildRecord('tok-1', 2_000);
    r.attach(fresh);
    expect(r.get('tok-1')).toEqual(fresh);
  });

  it('detach drops the connection', () => {
    const r = createBridgeRegistry();
    r.attach(buildRecord('tok-1', 1_000));
    r.detach('tok-1');
    expect(r.get('tok-1')).toBeNull();
  });

  it('touch advances last_seen_at', () => {
    const r = createBridgeRegistry();
    r.attach(buildRecord('tok-1', 1_000));
    r.touch('tok-1', 5_000);
    expect(r.get('tok-1')?.last_seen_at).toBe(5_000);
  });

  it('byLabel finds bridge by client_label', () => {
    const r = createBridgeRegistry();
    r.attach(buildRecord('tok-1', 1_000, 'work-laptop'));
    r.attach(buildRecord('tok-2', 2_000, 'home-laptop'));
    expect(r.byLabel('work-laptop')?.client_token_id).toBe('tok-1');
    expect(r.byLabel('missing')).toBeNull();
  });
});

describe('D-148 P3 — buildContextBridge', () => {
  it('empty registry → online: false', () => {
    const r = createBridgeRegistry();
    expect(buildContextBridge(r)).toEqual({ online: false });
  });

  it('registry with one bridge → online: true + capabilities mirrored', () => {
    const r = createBridgeRegistry();
    r.attach(buildRecord('tok-1', 1_000, 'work-laptop'));
    const ctx = buildContextBridge(r);
    expect(ctx.online).toBe(true);
    expect(ctx.online_since).toBe(1_000);
    expect(ctx.client_label).toBe('work-laptop');
    expect(ctx.capabilities?.granted_origins).toContain('*://app.hubspot.com/*');
  });

  it('multiple bridges → picks most-recently-attached when no preference', () => {
    const r = createBridgeRegistry();
    r.attach(buildRecord('tok-1', 1_000));
    r.attach(buildRecord('tok-2', 5_000));
    r.attach(buildRecord('tok-3', 3_000));
    const ctx = buildContextBridge(r);
    expect(ctx.online_since).toBe(5_000);
  });

  it('preferred_label routes to the labeled bridge', () => {
    const r = createBridgeRegistry();
    r.attach(buildRecord('tok-1', 1_000, 'work-laptop'));
    r.attach(buildRecord('tok-2', 5_000, 'home-laptop'));
    const ctx = buildContextBridge(r, { preferred_label: 'work-laptop' });
    expect(ctx.online_since).toBe(1_000);
    expect(ctx.client_label).toBe('work-laptop');
  });

  it('preferred_label not present → online: false (no fallback)', () => {
    const r = createBridgeRegistry();
    r.attach(buildRecord('tok-1', 1_000, 'work-laptop'));
    const ctx = buildContextBridge(r, { preferred_label: 'home-laptop' });
    expect(ctx.online).toBe(false);
  });
});
