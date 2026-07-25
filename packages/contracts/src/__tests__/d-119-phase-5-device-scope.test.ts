/** D-119 Phase 5 — UI device-scope router (contracts).
 *
 *  Phase 5 ships:
 *    - `DeviceScope` discriminated union (local / server / remote-ext)
 *    - `parseDeviceScope` + `serializeDeviceScope` round-trip
 *    - `deviceScopeEquals` for current-scope checkmark dedupe
 *    - `deviceScopeTabs` per-scope tab list (spec wireframes)
 *    - `deviceScopeHasSettings` + `deviceScopeIsLimitedView`
 *
 *  Tests cover wire-form parsing (incl. legacy `paired-server` row id
 *  and `<ext-id>:server` form the Phase 3 dropdown emitted), default
 *  scope, equality semantics, and per-scope tab decisions.
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_DEVICE_SCOPE,
  DEVICE_SCOPE_LOCAL_ID,
  deviceScopeEquals,
  deviceScopeHasSettings,
  deviceScopeIsLimitedView,
  deviceScopeTabs,
  parseDeviceScope,
  serializeDeviceScope,
  type DeviceScope,
} from '../index.js';

describe('parseDeviceScope', () => {
  it('parses the fixed local device id', () => {
    expect(parseDeviceScope(DEVICE_SCOPE_LOCAL_ID)).toEqual({ kind: 'local' });
  });

  it('parses the legacy `paired-server` id (Phase 3 dropdown)', () => {
    expect(parseDeviceScope('paired-server')).toEqual({
      kind: 'server',
      id: 'paired-server',
    });
  });

  it('parses `<ext-id>:server` (remote-ext\'s own paired server)', () => {
    expect(parseDeviceScope('ext-work:server')).toEqual({
      kind: 'server',
      id: 'ext-work:server',
    });
  });

  it('parses `server:<id>` form', () => {
    expect(parseDeviceScope('server:home-srv-uuid')).toEqual({
      kind: 'server',
      id: 'home-srv-uuid',
    });
  });

  it('parses `remote-ext:<id>` form', () => {
    expect(parseDeviceScope('remote-ext:ext-work')).toEqual({
      kind: 'remote-ext',
      id: 'ext-work',
    });
  });

  it('treats bare instance ids as remote-ext (Phase 3 dropdown row id)', () => {
    expect(parseDeviceScope('ext-phone-uuid')).toEqual({
      kind: 'remote-ext',
      id: 'ext-phone-uuid',
    });
  });

  it('returns null on empty string', () => {
    expect(parseDeviceScope('')).toBeNull();
  });

  it('returns null on `server:` with no id', () => {
    expect(parseDeviceScope('server:')).toBeNull();
  });

  it('returns null on `remote-ext:` with no id', () => {
    expect(parseDeviceScope('remote-ext:')).toBeNull();
  });

  it('returns null on `:server` (empty ext-id prefix)', () => {
    expect(parseDeviceScope(':server')).toBeNull();
  });

  it('returns null on non-string input', () => {
    expect(parseDeviceScope(undefined as unknown as string)).toBeNull();
    expect(parseDeviceScope(null as unknown as string)).toBeNull();
  });
});

describe('serializeDeviceScope', () => {
  it('serializes local to the fixed wire id', () => {
    expect(serializeDeviceScope({ kind: 'local' })).toBe(DEVICE_SCOPE_LOCAL_ID);
  });

  it('serializes paired-server using its legacy fixed id', () => {
    expect(serializeDeviceScope({ kind: 'server', id: 'paired-server' })).toBe(
      'paired-server',
    );
  });

  it('preserves `<ext-id>:server` ids verbatim', () => {
    expect(
      serializeDeviceScope({ kind: 'server', id: 'ext-work:server' }),
    ).toBe('ext-work:server');
  });

  it('prefixes raw server ids with `server:`', () => {
    expect(serializeDeviceScope({ kind: 'server', id: 'home-srv' })).toBe(
      'server:home-srv',
    );
  });

  it('prefixes remote-ext ids with `remote-ext:`', () => {
    expect(
      serializeDeviceScope({ kind: 'remote-ext', id: 'ext-phone' }),
    ).toBe('remote-ext:ext-phone');
  });
});

describe('round-trip', () => {
  const cases: Array<{ wire: string; scope: DeviceScope }> = [
    { wire: DEVICE_SCOPE_LOCAL_ID, scope: { kind: 'local' } },
    { wire: 'paired-server', scope: { kind: 'server', id: 'paired-server' } },
    {
      wire: 'ext-work:server',
      scope: { kind: 'server', id: 'ext-work:server' },
    },
    { wire: 'server:home-srv', scope: { kind: 'server', id: 'home-srv' } },
    { wire: 'remote-ext:ext-phone', scope: { kind: 'remote-ext', id: 'ext-phone' } },
  ];

  it.each(cases)('round-trips $wire', ({ wire, scope }) => {
    expect(parseDeviceScope(wire)).toEqual(scope);
    expect(serializeDeviceScope(scope)).toBe(wire);
  });
});

describe('deviceScopeEquals', () => {
  it('returns true for two local scopes', () => {
    expect(deviceScopeEquals({ kind: 'local' }, { kind: 'local' })).toBe(true);
  });

  it('returns true for same server id', () => {
    expect(
      deviceScopeEquals(
        { kind: 'server', id: 'home' },
        { kind: 'server', id: 'home' },
      ),
    ).toBe(true);
  });

  it('returns false for different kinds', () => {
    expect(
      deviceScopeEquals({ kind: 'local' }, { kind: 'server', id: 'paired-server' }),
    ).toBe(false);
  });

  it('returns false for same kind, different ids', () => {
    expect(
      deviceScopeEquals(
        { kind: 'remote-ext', id: 'a' },
        { kind: 'remote-ext', id: 'b' },
      ),
    ).toBe(false);
  });
});

describe('deviceScopeTabs', () => {
  it('local: Recipes + Settings', () => {
    expect(deviceScopeTabs({ kind: 'local' })).toEqual(['recipes', 'settings']);
  });

  it('server: Recipes + Dashboard + Warehouse + Settings (in spec order)', () => {
    expect(
      deviceScopeTabs({ kind: 'server', id: 'paired-server' }),
    ).toEqual(['recipes', 'dashboard', 'warehouse', 'settings']);
  });

  it('remote-ext: Recipes only (limited view)', () => {
    expect(deviceScopeTabs({ kind: 'remote-ext', id: 'ext-x' })).toEqual([
      'recipes',
    ]);
  });
});

describe('deviceScopeHasSettings', () => {
  it('local has Settings', () => {
    expect(deviceScopeHasSettings({ kind: 'local' })).toBe(true);
  });

  it('server has Settings', () => {
    expect(
      deviceScopeHasSettings({ kind: 'server', id: 'paired-server' }),
    ).toBe(true);
  });

  it('remote-ext has no Settings (limited view)', () => {
    expect(
      deviceScopeHasSettings({ kind: 'remote-ext', id: 'ext-x' }),
    ).toBe(false);
  });
});

describe('deviceScopeIsLimitedView', () => {
  it('only remote-ext is limited view', () => {
    expect(deviceScopeIsLimitedView({ kind: 'local' })).toBe(false);
    expect(
      deviceScopeIsLimitedView({ kind: 'server', id: 'paired-server' }),
    ).toBe(false);
    expect(
      deviceScopeIsLimitedView({ kind: 'remote-ext', id: 'ext-x' }),
    ).toBe(true);
  });
});

describe('DEFAULT_DEVICE_SCOPE', () => {
  it('is `local`', () => {
    expect(DEFAULT_DEVICE_SCOPE).toEqual({ kind: 'local' });
  });
});

describe('recipe.list in SERVER_RPC_METHOD_SET', () => {
  it('the new pair-WS rpc is in the method set so the boot-time check passes', async () => {
    const { SERVER_RPC_METHOD_SET } = await import('../index.js');
    expect(SERVER_RPC_METHOD_SET.has('recipe.list')).toBe(true);
  });
});
