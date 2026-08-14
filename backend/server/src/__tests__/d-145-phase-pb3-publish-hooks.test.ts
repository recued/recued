/** D-145 PB3 — per-store publish-hook tests.
 *
 *  Per § B.4 + the PB1.7 deferred-from-bin note. Each helper publishes
 *  the right invalidation topic with the right payload shape so the
 *  cache invalidates the correct rows. */

import { describe, it, expect } from 'vitest';

import * as capacity from '@recued/middleware/capacity/index.js';
import type { CapacityInvalidationPayload } from '@recued/contracts';

import {
  publishBridgeLoginStateChange,
  publishBridgeOnlineStateChange,
  publishBridgeUserRefreshLogin,
  publishConnectionStateChange,
  publishIngredientStateChange,
  publishPermissionGrantChange,
  publishQuotaHeadroomChange,
} from '../capacity-spec-deps.js';

const buildSourceWithCapture = () => {
  const source = capacity.createCapacityInvalidationSource();
  const captured: CapacityInvalidationPayload[] = [];
  // Subscribe to every topic so we can capture all fired payloads.
  const topics = [
    'bridge.online_state_changed',
    'bridge.login_state_changed',
    'bridge.user_refresh_login',
    'ingredient.installed',
    'ingredient.uninstalled',
    'ingredient.bumped',
    'permission.grant_changed',
    'connection.enrolled',
    'connection.disabled',
    'connection.reprobed',
    'quota.headroom_changed',
  ] as const;
  for (const topic of topics) {
    source.subscribe(topic, (payload) => {
      captured.push(payload);
    });
  }
  return { source, captured };
};

describe('publishConnectionStateChange', () => {
  it('publishes connection.enrolled with vendor + entity + connection_id', () => {
    const { source, captured } = buildSourceWithCapture();
    publishConnectionStateChange(source, 'enrolled', {
      vendor: 'hubspot',
      entity: 'deal',
      connection_id: 'conn-123',
    });
    expect(captured).toHaveLength(1);
    expect(captured[0]).toEqual({
      topic: 'connection.enrolled',
      vendor: 'hubspot',
      entity: 'deal',
      connection_id: 'conn-123',
    });
  });

  it('publishes connection.disabled', () => {
    const { source, captured } = buildSourceWithCapture();
    publishConnectionStateChange(source, 'disabled', { vendor: 'salesforce' });
    expect(captured).toHaveLength(1);
    expect(captured[0]?.topic).toBe('connection.disabled');
    expect(captured[0]?.vendor).toBe('salesforce');
  });

  it('publishes connection.reprobed', () => {
    const { source, captured } = buildSourceWithCapture();
    publishConnectionStateChange(source, 'reprobed', { vendor: 'hubspot', entity: 'contact' });
    expect(captured).toHaveLength(1);
    expect(captured[0]?.topic).toBe('connection.reprobed');
    expect(captured[0]?.entity).toBe('contact');
  });

  it('omits entity / connection_id when not provided', () => {
    const { source, captured } = buildSourceWithCapture();
    publishConnectionStateChange(source, 'reprobed', { vendor: 'hubspot' });
    expect(captured[0]).toEqual({ topic: 'connection.reprobed', vendor: 'hubspot' });
  });
});

describe('publishIngredientStateChange', () => {
  it('publishes ingredient.installed with slug', () => {
    const { source, captured } = buildSourceWithCapture();
    publishIngredientStateChange(source, 'installed', { slug: 'detect-deal-risk-hubspot' });
    expect(captured).toHaveLength(1);
    expect(captured[0]).toEqual({
      topic: 'ingredient.installed',
      slug: 'detect-deal-risk-hubspot',
    });
  });

  it('publishes ingredient.uninstalled', () => {
    const { source, captured } = buildSourceWithCapture();
    publishIngredientStateChange(source, 'uninstalled', { slug: 'foo' });
    expect(captured[0]?.topic).toBe('ingredient.uninstalled');
  });

  it('publishes ingredient.bumped (selector_freshness invalidation)', () => {
    const { source, captured } = buildSourceWithCapture();
    publishIngredientStateChange(source, 'bumped', { slug: 'webchat-gemini' });
    expect(captured[0]?.topic).toBe('ingredient.bumped');
    expect(captured[0]?.slug).toBe('webchat-gemini');
  });
});

describe('publishPermissionGrantChange', () => {
  it('publishes permission.grant_changed with permission name', () => {
    const { source, captured } = buildSourceWithCapture();
    publishPermissionGrantChange(source, { permission: 'all_urls' });
    expect(captured).toHaveLength(1);
    expect(captured[0]).toEqual({ topic: 'permission.grant_changed', permission: 'all_urls' });
  });
});

describe('publishQuotaHeadroomChange', () => {
  it('publishes quota.headroom_changed with pool when set', () => {
    const { source, captured } = buildSourceWithCapture();
    publishQuotaHeadroomChange(source, { pool: 'free' });
    expect(captured[0]).toEqual({ topic: 'quota.headroom_changed', pool: 'free' });
  });

  it('publishes pool-less when omitted (covers Pause-AI flips)', () => {
    const { source, captured } = buildSourceWithCapture();
    publishQuotaHeadroomChange(source);
    expect(captured[0]).toEqual({ topic: 'quota.headroom_changed' });
  });
});

describe('publishBridgeOnlineStateChange', () => {
  it('publishes bridge.online_state_changed with bridge_instance_id', () => {
    const { source, captured } = buildSourceWithCapture();
    publishBridgeOnlineStateChange(source, { bridge_instance_id: 'br-1' });
    expect(captured[0]).toEqual({
      topic: 'bridge.online_state_changed',
      bridge_instance_id: 'br-1',
    });
  });

  it('publishes pool-less envelope when no bridge_instance_id', () => {
    const { source, captured } = buildSourceWithCapture();
    publishBridgeOnlineStateChange(source);
    expect(captured[0]).toEqual({ topic: 'bridge.online_state_changed' });
  });
});

describe('publishBridgeLoginStateChange', () => {
  it('publishes bridge.login_state_changed with site', () => {
    const { source, captured } = buildSourceWithCapture();
    publishBridgeLoginStateChange(source, { site: 'facebook.com' });
    expect(captured[0]).toEqual({
      topic: 'bridge.login_state_changed',
      site: 'facebook.com',
    });
  });

  it('publishes with bridge_instance_id when set', () => {
    const { source, captured } = buildSourceWithCapture();
    publishBridgeLoginStateChange(source, {
      site: 'gemini.google.com',
      bridge_instance_id: 'br-2',
    });
    expect(captured[0]?.bridge_instance_id).toBe('br-2');
  });
});

describe('publishBridgeUserRefreshLogin', () => {
  it('publishes bridge.user_refresh_login with site', () => {
    const { source, captured } = buildSourceWithCapture();
    publishBridgeUserRefreshLogin(source, { site: 'linkedin.com' });
    expect(captured[0]).toEqual({
      topic: 'bridge.user_refresh_login',
      site: 'linkedin.com',
    });
  });
});

describe('cache invalidation integration', () => {
  it('cache subscribes to all PB3 topics and drops matching rows', () => {
    const source = capacity.createCapacityInvalidationSource();
    const cache = capacity.createCapacityCache({ invalidationSource: source });

    // Seed a connection_active row.
    cache.write(
      'connection_active:hubspot:deal',
      {
        audit_emitter: capacity.createCapacityAuditEmitter({ logActivity() {} }),
        transparency_emitter: capacity.createNoopTransparencyEmitter(),
      },
      {
        capacity_kind: 'connection_active',
        capacity_key: 'connection_active:hubspot:deal',
        vendor: 'hubspot',
        entity: 'deal',
        result: { ok: true },
        checked_at: 1000,
      },
    );
    expect(cache.size()).toBe(1);

    publishConnectionStateChange(source, 'disabled', {
      vendor: 'hubspot',
      entity: 'deal',
    });

    // The cache layer's PB1 subscription drops the matching row.
    expect(cache.size()).toBe(0);
  });
});
