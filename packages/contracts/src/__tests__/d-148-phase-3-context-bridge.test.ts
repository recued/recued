/** D-148 P3 — `context.bridge` resolution.
 *
 *  Mirrors the existing `context-server.test.ts` shape — the
 *  resolver walks the dotted path; this test confirms the engine's
 *  injected `context.bridge` field is reachable from recipes via
 *  `{{context.bridge.online}}` and friends. */

import { describe, expect, it } from 'vitest';
import { resolveRef } from '../resolve.js';
import type { NamespaceStores } from '../resolve.js';
import type { ContextBridge } from '../context.js';

const makeStores = (bridge: ContextBridge | undefined): NamespaceStores => ({
  vault: {},
  config: {},
  context: bridge ? { bridge } : {},
  meta: {},
  step: {},
});

describe('D-148 P3 — context.bridge resolution', () => {
  it('online: true reachable via {{context.bridge.online}}', () => {
    const stores = makeStores({ online: true, online_since: 1_000 });
    expect(resolveRef('{{context.bridge.online}}', stores)).toBe(true);
  });

  it('online: false reachable', () => {
    const stores = makeStores({ online: false });
    expect(resolveRef('{{context.bridge.online}}', stores)).toBe(false);
  });

  it('client_label reachable when bridge present + labeled', () => {
    const stores = makeStores({
      online: true,
      online_since: 1_000,
      client_label: 'work-laptop',
    });
    expect(resolveRef('{{context.bridge.client_label}}', stores)).toBe('work-laptop');
  });

  it('absent context.bridge → resolves undefined', () => {
    const stores = makeStores(undefined);
    expect(resolveRef('{{context.bridge.online}}', stores)).toBeUndefined();
  });

  it('capabilities sub-fields reachable', () => {
    const stores = makeStores({
      online: true,
      online_since: 1_000,
      capabilities: {
        software_version: '0.0.1',
        chrome_version: '124.0',
        permissions_granted: ['storage', 'tabs'],
        granted_origins: ['*://app.hubspot.com/*'],
        offscreen_supported: true,
        alarms_supported: true,
      },
    });
    expect(resolveRef('{{context.bridge.capabilities.chrome_version}}', stores)).toBe('124.0');
    expect(resolveRef('{{context.bridge.capabilities.offscreen_supported}}', stores)).toBe(true);
  });

  it('returns the whole bridge object at {{context.bridge}}', () => {
    const stores = makeStores({ online: true, online_since: 1_000 });
    expect(resolveRef('{{context.bridge}}', stores)).toEqual({
      online: true,
      online_since: 1_000,
    });
  });
});
