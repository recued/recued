/** D-156 P4 — Pair deeplink parser.
 *
 *  Covers `parsePairDeeplink` — the boot-time query-string parser that
 *  reads `?code=…` and produces a `PairCodeInputDeeplinkSeed` plus an
 *  `active` flag the webclient bootstrap uses to flip
 *  `useNewPairCodeInput` on the unpaired-error fallback branch.
 *
 *  Suite layout:
 *    - source-shape tolerance (raw string with `?` / without / empty /
 *      URLSearchParams instance)
 *    - single-field seeding (`?code=` only)
 *    - inactive cases (no params / empty values / whitespace-only values)
 *    - whitespace trim
 *    - unrelated params ignored
 *    - `?url=` is REJECTED (Codex 2026-05-18 P4 critical fold) —
 *      attacker-controlled URL pre-fill would exfiltrate the user's
 *      24-word recovery key on submit. The parser must NEVER seed
 *      `serverUrl` from a query param, regardless of the value.
 *
 *  No network, no DOM — `parsePairDeeplink` is a pure helper. */

import { describe, it, expect } from 'vitest';

import { parsePairDeeplink } from '../auth/pair-deeplink.js';

describe('parsePairDeeplink — source shapes', () => {
  it('accepts a raw search string with leading `?`', () => {
    const parsed = parsePairDeeplink('?code=ABCD1234');
    expect(parsed.active).toBe(true);
    expect(parsed.seed).toEqual({ pairingCode: 'ABCD1234' });
  });

  it('accepts a raw search string without leading `?`', () => {
    const parsed = parsePairDeeplink('code=ABCD1234');
    expect(parsed.active).toBe(true);
    expect(parsed.seed).toEqual({ pairingCode: 'ABCD1234' });
  });

  it('accepts an explicit URLSearchParams instance', () => {
    const params = new URLSearchParams('code=XYZ12345');
    const parsed = parsePairDeeplink(params);
    expect(parsed.active).toBe(true);
    expect(parsed.seed).toEqual({ pairingCode: 'XYZ12345' });
  });
});

describe('parsePairDeeplink — pairing-code seeding', () => {
  it('seeds pairingCode when ?code= is present', () => {
    const parsed = parsePairDeeplink('?code=DEEPLINK');
    expect(parsed.active).toBe(true);
    expect(parsed.seed).toEqual({ pairingCode: 'DEEPLINK' });
    expect(parsed.seed.serverUrl).toBeUndefined();
  });

  it('preserves the code verbatim (no case-folding or rewriting)', () => {
    const parsed = parsePairDeeplink('?code=ABcd-9999');
    expect(parsed.active).toBe(true);
    expect(parsed.seed).toEqual({ pairingCode: 'ABcd-9999' });
  });
});

describe('parsePairDeeplink — ?url= is NOT seeded (critical security fold)', () => {
  // Codex 2026-05-18 P4 critical finding — a malicious deeplink
  // `app.recued.com/pair?url=https://attacker.example&code=...`
  // would pre-fill the attacker's URL into the form, then submit the
  // user's 24-word recovery key to `attacker.example/auth/pair`. The
  // parser MUST NEVER seed `serverUrl` from a query param. The CLI
  // doesn't emit `?url=` either; users type their server URL
  // themselves so the recovery-key POST destination is always
  // self-authored. These tests are the regression tripwire.

  it('ignores ?url= when present alone (no active deeplink)', () => {
    const parsed = parsePairDeeplink('?url=http%3A%2F%2Flocalhost%3A3001');
    expect(parsed.active).toBe(false);
    expect(parsed.seed).toEqual({});
    expect(parsed.seed.serverUrl).toBeUndefined();
  });

  it('ignores ?url= alongside ?code= (code seeds, url does not)', () => {
    const parsed = parsePairDeeplink(
      '?code=ABCD1234&url=https%3A%2F%2Fserver.example.com',
    );
    expect(parsed.active).toBe(true);
    expect(parsed.seed).toEqual({ pairingCode: 'ABCD1234' });
    expect(parsed.seed.serverUrl).toBeUndefined();
  });

  it('ignores ?url= even when attacker-coded against an https host', () => {
    const parsed = parsePairDeeplink(
      '?code=DEEPLINK&url=https%3A%2F%2Fattacker.example',
    );
    expect(parsed.seed).toEqual({ pairingCode: 'DEEPLINK' });
    expect(parsed.seed.serverUrl).toBeUndefined();
  });
});

describe('parsePairDeeplink — inactive cases', () => {
  it('returns inactive for an empty string', () => {
    const parsed = parsePairDeeplink('');
    expect(parsed.active).toBe(false);
    expect(parsed.seed).toEqual({});
  });

  it('returns inactive for an empty `?` query', () => {
    const parsed = parsePairDeeplink('?');
    expect(parsed.active).toBe(false);
    expect(parsed.seed).toEqual({});
  });

  it('returns inactive when ?code= has empty value', () => {
    const parsed = parsePairDeeplink('?code=');
    expect(parsed.active).toBe(false);
    expect(parsed.seed).toEqual({});
  });

  it('returns inactive when only unrelated params are present', () => {
    const parsed = parsePairDeeplink('?utm_source=hn&ref=docs');
    expect(parsed.active).toBe(false);
    expect(parsed.seed).toEqual({});
  });

  it('returns inactive when ?code= value is pure whitespace', () => {
    const parsed = parsePairDeeplink('?code=%20%20');
    expect(parsed.active).toBe(false);
    expect(parsed.seed).toEqual({});
  });
});

describe('parsePairDeeplink — trimming + sanitisation', () => {
  it('trims leading whitespace from the code', () => {
    const params = new URLSearchParams();
    params.set('code', '   ABCD1234');
    const parsed = parsePairDeeplink(params);
    expect(parsed.seed).toEqual({ pairingCode: 'ABCD1234' });
  });

  it('trims trailing whitespace from the code', () => {
    const params = new URLSearchParams();
    params.set('code', 'ABCD1234   ');
    const parsed = parsePairDeeplink(params);
    expect(parsed.seed).toEqual({ pairingCode: 'ABCD1234' });
  });

  it('ignores unrelated params alongside a valid code', () => {
    const parsed = parsePairDeeplink(
      '?utm_source=hn&code=ABCD1234&ref=docs',
    );
    expect(parsed.active).toBe(true);
    expect(parsed.seed).toEqual({ pairingCode: 'ABCD1234' });
  });
});

describe('parsePairDeeplink — return-shape invariants', () => {
  it('always returns a seed object (never undefined) when inactive', () => {
    const parsed = parsePairDeeplink('');
    expect(parsed.seed).not.toBeUndefined();
    expect(typeof parsed.seed).toBe('object');
  });

  it('seed never carries serverUrl regardless of query content', () => {
    // Exhaustively test attacker-shaped inputs — none should populate
    // serverUrl. The critical fold's regression tripwire.
    for (const attackerInput of [
      '?url=http%3A%2F%2Fattacker.example',
      '?url=javascript%3Aalert(1)',
      '?url=//attacker.example',
      '?url=https%3A%2F%2Fapp.recued.com%2Fpair%3Furl%3Devil',
      '?code=ABCD&url=http%3A%2F%2Fevil',
    ]) {
      const parsed = parsePairDeeplink(attackerInput);
      expect(parsed.seed.serverUrl).toBeUndefined();
    }
  });

  it('seed only ever has a pairingCode key (no serverUrl key)', () => {
    const parsed = parsePairDeeplink('?code=ABCD&url=evil');
    expect(Object.keys(parsed.seed)).toEqual(['pairingCode']);
  });
});
