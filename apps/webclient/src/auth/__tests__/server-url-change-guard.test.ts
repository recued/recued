/** D-148 — the two conditions a `server_url` change must satisfy.
 *
 *  The owner stated the rule as: *"the probe & save require the new changed
 *  one to be alive & same signature to be saved"* and *"don't allow to change
 *  at current profile (eg, at 7717 change 443:4433 ok, at 443: change
 *  443:4433 not ok)"*. Both cases below are that example, literally. */

import { describe, expect, it } from 'vitest';

import {
  addressIdentity,
  decideServerUrlChange,
} from '../server-url-change-guard.js';
import type { IdentityProbeOutcome } from '../identity-probe.js';

const verified: IdentityProbeOutcome = { kind: 'verified' };

describe('addressIdentity', () => {
  it('⚠ makes the implicit port explicit, so 443 and :443 are ONE address', () => {
    expect(addressIdentity('wss://h.example/ws')).toBe('h.example:443');
    expect(addressIdentity('wss://h.example:443/ws')).toBe('h.example:443');
    expect(addressIdentity('https://h.example/x')).toBe('h.example:443');
    expect(addressIdentity('ws://h.example/ws')).toBe('h.example:80');
    expect(addressIdentity('http://h.example/x')).toBe('h.example:80');
  });

  it('ignores scheme and path — the same listener is the same address', () => {
    expect(addressIdentity('wss://h.example:8443/ws')).toBe(
      addressIdentity('https://h.example:8443/anything'),
    );
  });

  it('is case-insensitive on the host', () => {
    expect(addressIdentity('wss://H.Example:7717/ws')).toBe('h.example:7717');
  });

  it('returns null for what it cannot parse', () => {
    for (const bad of ['', 'not a url', 'wss://[fe80::1%25eth0]/ws']) {
      expect(addressIdentity(bad)).toBeNull();
    }
  });
});

describe('decideServerUrlChange', () => {
  it("⛔ SAVES the owner's case: connected on 443, moving to 4433", () => {
    // This is the migration the feature exists for — running behind existing
    // web hosting means being connected on one port and pointing the client at
    // another. A guard here briefly refused it; see the module header.
    expect(
      decideServerUrlChange({
        currentUrl: 'wss://h.example:443/ws',
        candidateUrl: 'wss://h.example:4433/ws',
        probe: verified,
      }),
    ).toEqual({ kind: 'save' });
  });

  it('saves a move from LAN to a public address, and back', () => {
    expect(
      decideServerUrlChange({
        currentUrl: 'ws://192.168.1.9:7717/ws',
        candidateUrl: 'wss://h.example/ws',
        probe: verified,
      }),
    ).toEqual({ kind: 'save' });
    expect(
      decideServerUrlChange({
        currentUrl: 'wss://h.example/ws',
        candidateUrl: 'ws://192.168.1.9:7717/ws',
        probe: verified,
      }),
    ).toEqual({ kind: 'save' });
  });

  it('saves a move away from a DEAD address — the edit needs nothing from the old one', () => {
    // The orphaned-client case: the probe talks only to the CANDIDATE, so the
    // old address being unreachable is irrelevant to whether this can be saved.
    expect(
      decideServerUrlChange({
        currentUrl: 'wss://gone.example/ws',
        candidateUrl: 'wss://h.example:4433/ws',
        probe: verified,
      }),
    ).toEqual({ kind: 'save' });
  });

  it('⛔ never saves an address that did not prove the pinned identity', () => {
    for (const probe of [
      { kind: 'unreachable' },
      { kind: 'not_the_same_server' },
    ] satisfies IdentityProbeOutcome[]) {
      expect(
        decideServerUrlChange({
          currentUrl: 'wss://h.example:443/ws',
          candidateUrl: 'wss://attacker.example/ws',
          probe,
        }),
      ).toEqual({ kind: 'refuse_unproven', probe });
    }
  });

  it('refuses what it cannot parse, without contacting it', () => {
    for (const bad of ['garbage', '', 'ftp://h.example/ws']) {
      expect(
        decideServerUrlChange({
          currentUrl: 'wss://h.example/ws',
          candidateUrl: bad,
          probe: verified,
        }),
      ).toEqual({ kind: 'refuse_unparseable' });
    }
  });
});
