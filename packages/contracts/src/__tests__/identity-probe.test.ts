/** D-148 — the identity-probe protocol contract.
 *
 *  ⚠ WHY A CONTRACTS-LEVEL SUITE WHEN THE ROUTE ALREADY HAS ONE. Mutation
 *  testing found `isValidIdentityFingerprint` surviving every existing test:
 *  loosening it to accept anything reddened nothing, because the server
 *  compares the string to its own fingerprint regardless and a garbage value
 *  simply fails to match. The validator is defense-in-depth THERE — but it is
 *  EXPORTED from contracts, so it is a published shape other implementations
 *  may rely on, and an exported validator with no test of its own is a
 *  liability rather than a contract.
 */

import { describe, expect, it } from 'vitest';
import {
  IDENTITY_PROBE_DOMAIN,
  IDENTITY_PROBE_NONCE_BYTES,
  IDENTITY_PROBE_PATH,
  buildIdentityProbePayload,
  isIdentityProbeRequest,
  isValidIdentityFingerprint,
  isValidIdentityProbeNonce,
} from '../identity-probe.js';

const GOOD_NONCE = 'a'.repeat(43);
const GOOD_FP = `sha256:${'0123456789abcdef'.repeat(4)}`;

describe('identity-probe contract', () => {
  it('pins the wire constants both ends compile against', () => {
    expect(IDENTITY_PROBE_PATH).toBe('/auth/identity-probe');
    expect(IDENTITY_PROBE_DOMAIN).toBe('recued.identity.probe.v1');
    expect(IDENTITY_PROBE_NONCE_BYTES).toBe(32);
  });

  it('accepts a real 32-byte base64url nonce and rejects what is not one', () => {
    // What `crypto.getRandomValues(new Uint8Array(32))` base64url-encodes to.
    expect(isValidIdentityProbeNonce(GOOD_NONCE)).toBe(true);
    expect(isValidIdentityProbeNonce('AAAA-_zz'.repeat(4))).toBe(true);
    for (const bad of [
      '', 'short', 'a'.repeat(21), 'a'.repeat(129),
      'a'.repeat(30) + '+', 'a'.repeat(30) + '/', 'a'.repeat(30) + '=',
      '{"a":1}', 'has space'.padEnd(30, 'x'),
      null, undefined, 42, {}, ['a'.repeat(43)],
    ]) {
      expect(isValidIdentityProbeNonce(bad), `accepted ${String(bad)}`).toBe(false);
    }
  });

  it('⛔ accepts only a lowercase sha256:<64 hex> fingerprint', () => {
    expect(isValidIdentityFingerprint(GOOD_FP)).toBe(true);
    for (const bad of [
      '', 'sha256:', `sha256:${'a'.repeat(63)}`, `sha256:${'a'.repeat(65)}`,
      // ⚠ UPPERCASE IS REJECTED ON PURPOSE. The three implementations that must
      // agree (server, auth Worker, webclient) all emit lowercase hex; accepting
      // uppercase here would let a caller send a value that never matches.
      `sha256:${'A'.repeat(64)}`,
      `md5:${'a'.repeat(64)}`, `SHA256:${'a'.repeat(64)}`,
      'a'.repeat(64), `sha256:${'g'.repeat(64)}`,
      null, undefined, 42, {},
    ]) {
      expect(isValidIdentityFingerprint(bad), `accepted ${String(bad)}`).toBe(false);
    }
  });

  it('requires BOTH fields, of the right shape, on a request', () => {
    expect(isIdentityProbeRequest({ nonce: GOOD_NONCE, expect_fingerprint: GOOD_FP })).toBe(true);
    for (const bad of [
      null, undefined, 'a string', 42, [],
      {}, { nonce: GOOD_NONCE }, { expect_fingerprint: GOOD_FP },
      { nonce: 'short', expect_fingerprint: GOOD_FP },
      { nonce: GOOD_NONCE, expect_fingerprint: 'nope' },
    ]) {
      expect(isIdentityProbeRequest(bad), `accepted ${JSON.stringify(bad)}`).toBe(false);
    }
  });

  it('extra fields are ignored, not a rejection', () => {
    // A newer client may send more; the server signs only what it builds.
    expect(isIdentityProbeRequest({
      nonce: GOOD_NONCE, expect_fingerprint: GOOD_FP, future_field: 'x',
    })).toBe(true);
  });

  it('produces exactly these bytes, in this order', () => {
    expect(buildIdentityProbePayload({ nonce: GOOD_NONCE, server_public_key: 'K' })).toBe(
      `{"domain":"${IDENTITY_PROBE_DOMAIN}","nonce":"${GOOD_NONCE}","server_public_key":"K"}`,
    );
  });

  it('⚠ argument order cannot reach the serializer — so canonical is not what makes this stable', () => {
    // An earlier version of this file claimed canonical JSON was load-bearing
    // "because a serializer preserving insertion order would make the two ends
    // disagree". ⛔ It cannot: `buildIdentityProbePayload` builds ONE fixed
    // object literal, so argument order never reaches the serializer, and
    // swapping canonical for JSON.stringify reds NOTHING. Mutation found it.
    // What makes the two ends agree is that they call THIS function — the
    // assertion below, not the serializer choice.
    expect(buildIdentityProbePayload({ nonce: GOOD_NONCE, server_public_key: 'K' }))
      .toBe(buildIdentityProbePayload({ server_public_key: 'K', nonce: GOOD_NONCE } as never));
  });

  it('⛔ what STRICT canonical actually buys: a malformed value throws, never coerces', () => {
    // The one behavioural difference for this payload. `JSON.stringify` turns a
    // non-finite number into `null` and carries on, which would sign bytes the
    // other end would never rebuild — a silent verification failure with no
    // cause to chase. Strict refuses at the source.
    expect(() => buildIdentityProbePayload({
      nonce: GOOD_NONCE, server_public_key: Number.NaN as never,
    })).toThrow();
    expect(() => buildIdentityProbePayload({
      nonce: Number.POSITIVE_INFINITY as never, server_public_key: 'K',
    })).toThrow();
  });

  it('⛔ carries the domain tag, and a distinct key set from the DDNS payload', () => {
    const parsed = JSON.parse(
      buildIdentityProbePayload({ nonce: GOOD_NONCE, server_public_key: 'K' }),
    ) as Record<string, unknown>;
    expect(parsed.domain).toBe(IDENTITY_PROBE_DOMAIN);
    expect(Object.keys(parsed).sort()).toEqual(['domain', 'nonce', 'server_public_key']);
    // The five fields the cloud DDNS route rebuilds and verifies with the SAME
    // key. Disjointness is an accident, the domain tag is the rule — both are
    // asserted so neither can quietly stop being true.
    for (const ddnsField of ['publisher_id', 'handle', 'ip_v4', 'ip_v6', 'timestamp']) {
      expect(Object.keys(parsed)).not.toContain(ddnsField);
    }
  });
});
