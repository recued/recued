import { describe, expect, it } from 'vitest';

import {
  DDNS_ZONES,
  defaultDdnsZone,
  hostnameForHandle,
  isProDdnsHost,
  zoneByLabel,
} from '../network.js';

describe('D-176 — hostnameForHandle', () => {
  it('trims whitespace, lowercases the handle, and appends the default-zone suffix', () => {
    expect(hostnameForHandle('  Alice-Team  ')).toBe('alice-team.recued.net');
  });

  it('leaves an already-lowercase handle label unchanged before appending the suffix', () => {
    expect(hostnameForHandle('alice')).toBe('alice.recued.net');
  });

  it('appends an explicitly-passed zone suffix', () => {
    const dflt = defaultDdnsZone();
    expect(hostnameForHandle('alice', dflt)).toBe(`alice${dflt.suffix}`);
    // Any registry zone composes the same way (forward-compat for a 2nd zone).
    for (const zone of DDNS_ZONES) {
      expect(hostnameForHandle('alice', zone)).toBe(`alice${zone.suffix}`);
    }
  });

  it('round-trips single-label handles through isProDdnsHost', () => {
    for (const handle of ['alice', 'mary-team', 'm9']) {
      expect(isProDdnsHost(hostnameForHandle(handle))).toBe(true);
    }
  });
});

describe('D-176 — zoneByLabel', () => {
  it('resolves every registry zone by its label', () => {
    for (const zone of DDNS_ZONES) {
      expect(zoneByLabel(zone.label)).toBe(zone);
    }
  });

  it('resolves the default zone by its label', () => {
    const dflt = defaultDdnsZone();
    expect(zoneByLabel(dflt.label)).toBe(dflt);
  });

  it('returns undefined for an unknown or empty label (callers fall back to the default zone)', () => {
    // `cloud` is the documented future/disabled zone — not in the registry yet.
    expect(zoneByLabel('cloud')).toBeUndefined();
    expect(zoneByLabel('nope')).toBeUndefined();
    expect(zoneByLabel('')).toBeUndefined();
  });

  it('composes with hostnameForHandle: a stored label round-trips to the same hostname', () => {
    // The exact resolve pattern the provisioner + cloud DDNS update use.
    for (const zone of DDNS_ZONES) {
      const resolved = zoneByLabel(zone.label) ?? defaultDdnsZone();
      expect(hostnameForHandle('alice', resolved)).toBe(`alice${zone.suffix}`);
    }
  });
});
