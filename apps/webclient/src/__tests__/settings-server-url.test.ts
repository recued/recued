/** D-148 P4 — settings: server URL validator + fingerprint match. */

import { describe, expect, it } from 'vitest';
import {
  computeCertFingerprintMatch,
  validateServerUrl,
} from '../settings/server-url.js';

describe('D-148 P4 — settings.server_url', () => {
  it('accepts wss://host[:port]/path', () => {
    const r = validateServerUrl('wss://alice.recued.cloud:8443/ws');
    expect(r.ok).toBe(true);
  });

  it('rejects http(s) scheme', () => {
    expect(validateServerUrl('https://alice.recued.cloud').ok).toBe(false);
    expect(validateServerUrl('http://alice.recued.cloud').ok).toBe(false);
  });

  it('rejects ws:// by default; permits under explicit allow_insecure_localhost', () => {
    expect(validateServerUrl('ws://localhost:8443').ok).toBe(false);
    expect(
      validateServerUrl('ws://localhost:8443', { allow_insecure_localhost: true }).ok,
    ).toBe(true);
    expect(
      validateServerUrl('ws://example.com:8443', { allow_insecure_localhost: true }).ok,
    ).toBe(false);
  });

  it('rejects malformed input', () => {
    expect(validateServerUrl('').ok).toBe(false);
    expect(validateServerUrl('not a url').ok).toBe(false);
    expect(validateServerUrl('wss://').ok).toBe(false);
  });

  it('rejects out-of-range port', () => {
    const r = validateServerUrl('wss://x:99999');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('url_malformed');
  });
});

describe('D-148 P4 — settings.cert_fingerprint match', () => {
  const pin_state = (overrides: Partial<{ next?: string }>): {
    current_fingerprint: string;
    next_fingerprint?: string;
    current_valid_until: number;
  } => {
    const out: {
      current_fingerprint: string;
      next_fingerprint?: string;
      current_valid_until: number;
    } = {
      current_fingerprint: 'cur-fp',
      current_valid_until: 9_999_999,
    };
    if (overrides.next !== undefined) out.next_fingerprint = overrides.next;
    return out;
  };

  it('match on current', () => {
    const r = computeCertFingerprintMatch('cur-fp', pin_state({}));
    expect(r).toEqual({ match: 'current' });
  });

  it('match on next during overlap', () => {
    const r = computeCertFingerprintMatch('next-fp', pin_state({ next: 'next-fp' }));
    expect(r).toEqual({ match: 'next' });
  });

  it('mismatch when neither', () => {
    const r = computeCertFingerprintMatch('other', pin_state({ next: 'next-fp' }));
    expect(r.match).toBe('mismatch');
  });

  it('mismatch when no pin yet (TOFU not via this path)', () => {
    const r = computeCertFingerprintMatch('observed', null);
    expect(r.match).toBe('mismatch');
  });
});
