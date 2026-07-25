/** D-169 P0 - bridge capability profile rpc handler tests. */

import { describe, expect, it, vi } from 'vitest';
import { RpcError, type BridgeCapabilityProfile } from '@recued/contracts';
import {
  handleBridgeCapabilityProfilePush,
  makeBridgeCapabilityHandlers,
} from '../bridge-capability-handler.js';
import type { BridgeRegistry } from '../bridges/registry.js';

const sampleProfile = (
  overrides: Partial<BridgeCapabilityProfile> = {},
): BridgeCapabilityProfile => ({
  software_version: '1.2.3',
  chrome_version: '126.0.6478.0',
  permissions_granted: ['storage', 'tabs'],
  granted_origins: ['*://app.hubspot.com/*'],
  offscreen_supported: true,
  alarms_supported: true,
  ...overrides,
});

const buildRegistry = (updateResult = true): BridgeRegistry => ({
  attach: vi.fn(),
  detach: vi.fn(),
  touch: vi.fn(),
  updateCapabilities: vi.fn(() => updateResult),
  list: vi.fn(() => []),
  get: vi.fn(() => null),
  byLabel: vi.fn(() => null),
  clear: vi.fn(),
});

const expectRpcError = (
  run: () => unknown,
  code: string,
): RpcError => {
  let err: unknown;
  try {
    run();
  } catch (caught) {
    err = caught;
  }
  expect(err).toBeInstanceOf(RpcError);
  const rpc = err as RpcError;
  expect(rpc.code).toBe(code);
  expect(rpc.method).toBe('bridge.capabilityProfile.push');
  return rpc;
};

const withoutField = (
  profile: BridgeCapabilityProfile,
  key: keyof BridgeCapabilityProfile,
): Record<string, unknown> => {
  const out = { ...profile } as Record<string, unknown>;
  delete out[key];
  return out;
};

describe('D-169 P0 - handleBridgeCapabilityProfilePush', () => {
  it('invokes registry.updateCapabilities with client_token_id, profile, and now', () => {
    const registry = buildRegistry();
    const profile = sampleProfile();
    const result = handleBridgeCapabilityProfilePush(
      { registry, now: () => 1_700_000_000_123 },
      'tok-1',
      { profile },
    );

    expect(result).toEqual({ ok: true });
    expect(registry.updateCapabilities).toHaveBeenCalledTimes(1);
    expect(registry.updateCapabilities).toHaveBeenCalledWith(
      'tok-1',
      profile,
      1_700_000_000_123,
    );
  });

  it('rejects when client_token_id is missing', () => {
    expectRpcError(
      () => handleBridgeCapabilityProfilePush(
        { registry: buildRegistry() },
        undefined,
        { profile: sampleProfile() },
      ),
      'unauthorized',
    );
  });

  it.each([
    ['missing profile', {}],
    ['null profile', { profile: null }],
    ['non-object profile', { profile: 'bad' }],
  ])('rejects an invalid args shape: %s', (_label, args) => {
    expectRpcError(
      () => handleBridgeCapabilityProfilePush(
        { registry: buildRegistry() },
        'tok-1',
        args as never,
      ),
      'invalid_argument',
    );
  });

  it.each([
    ['software_version missing', withoutField(sampleProfile(), 'software_version')],
    ['software_version wrong type', { ...sampleProfile(), software_version: 123 }],
    ['chrome_version missing', withoutField(sampleProfile(), 'chrome_version')],
    ['chrome_version wrong type', { ...sampleProfile(), chrome_version: 123 }],
    ['permissions_granted missing', withoutField(sampleProfile(), 'permissions_granted')],
    ['permissions_granted wrong type', { ...sampleProfile(), permissions_granted: 'storage' }],
    ['granted_origins missing', withoutField(sampleProfile(), 'granted_origins')],
    ['granted_origins wrong type', { ...sampleProfile(), granted_origins: '*://example.com/*' }],
    ['offscreen_supported missing', withoutField(sampleProfile(), 'offscreen_supported')],
    ['offscreen_supported wrong type', { ...sampleProfile(), offscreen_supported: 'yes' }],
    ['alarms_supported missing', withoutField(sampleProfile(), 'alarms_supported')],
    ['alarms_supported wrong type', { ...sampleProfile(), alarms_supported: 'yes' }],
  ])('rejects required field drift: %s', (_label, profile) => {
    expectRpcError(
      () => handleBridgeCapabilityProfilePush(
        { registry: buildRegistry() },
        'tok-1',
        { profile: profile as unknown as BridgeCapabilityProfile },
      ),
      'invalid_argument',
    );
  });

  it.each([
    [
      'permissions_granted contains non-string',
      { ...sampleProfile(), permissions_granted: ['storage', 123] },
    ],
    [
      'granted_origins contains non-string',
      { ...sampleProfile(), granted_origins: ['*://example.com/*', 123] },
    ],
    [
      'user_agent is non-string',
      { ...sampleProfile(), user_agent: 123 },
    ],
  ])('rejects Angle 5 element/type drift: %s', (_label, profile) => {
    expectRpcError(
      () => handleBridgeCapabilityProfilePush(
        { registry: buildRegistry() },
        'tok-1',
        { profile: profile as unknown as BridgeCapabilityProfile },
      ),
      'invalid_argument',
    );
  });

  it('returns ok when updateCapabilities reports no existing record', () => {
    const registry = buildRegistry(false);
    const result = handleBridgeCapabilityProfilePush(
      { registry, now: () => 42 },
      'tok-1',
      { profile: sampleProfile() },
    );

    expect(result).toEqual({ ok: true });
    expect(registry.updateCapabilities).toHaveBeenCalledTimes(1);
  });
});

describe('D-169 P0 - makeBridgeCapabilityHandlers', () => {
  it('returns undefined when deps are absent so the composer surfaces not_configured', () => {
    expect(makeBridgeCapabilityHandlers(undefined)).toBeUndefined();
  });
});
