/** D-148 P6 — cert-chain holder + fingerprint helpers. */

import { describe, expect, it } from 'vitest';
import {
  buildCertChain,
  computeCertFingerprint,
  createCertChainHolder,
} from '../cert-chain.js';

const PEM_CERT = [
  '-----BEGIN CERTIFICATE-----',
  'MIIBhjCCASugAwIBAgIBATAKBggqhkjOPQQDAjBKMQswCQYDVQQGEwJVUzELMAkG',
  '-----END CERTIFICATE-----',
].join('\n');

describe('computeCertFingerprint', () => {
  it('returns a 64-char lowercase hex digest for a parseable PEM', () => {
    const fp = computeCertFingerprint(PEM_CERT);
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
  });

  it('returns the same fingerprint for the same cert (deterministic)', () => {
    expect(computeCertFingerprint(PEM_CERT)).toBe(computeCertFingerprint(PEM_CERT));
  });

  it('ignores embedded whitespace inside the PEM body', () => {
    const noisy = PEM_CERT.replace(/\n/g, '\r\n  ');
    expect(computeCertFingerprint(noisy)).toBe(computeCertFingerprint(PEM_CERT));
  });

  it('returns empty string for an empty / non-PEM input', () => {
    expect(computeCertFingerprint('')).toBe('');
    expect(computeCertFingerprint('not a cert')).toBe('');
    expect(computeCertFingerprint('-----BEGIN FOO-----\nabc\n-----END FOO-----')).toBe('');
  });

  it('returns empty string for malformed PEM (missing END marker)', () => {
    expect(computeCertFingerprint('-----BEGIN CERTIFICATE-----\nabcdef\n')).toBe('');
  });
});

describe('buildCertChain', () => {
  it('attaches fingerprint + expiry when supplied', () => {
    const chain = buildCertChain({
      cert_pem: PEM_CERT,
      private_key_pem: 'KEY',
      expires_at: 1_700_000_000_000,
    });
    expect(chain.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(chain.expires_at).toBe(1_700_000_000_000);
  });

  it('omits expiry when not supplied', () => {
    const chain = buildCertChain({ cert_pem: PEM_CERT, private_key_pem: 'KEY' });
    expect(chain.expires_at).toBeUndefined();
  });

  it('omits fingerprint when cert_pem is empty', () => {
    const chain = buildCertChain({ cert_pem: '', private_key_pem: 'KEY' });
    expect(chain.fingerprint).toBeUndefined();
  });
});

describe('createCertChainHolder', () => {
  it('returns the initial chain via current()', () => {
    const initial = buildCertChain({ cert_pem: PEM_CERT, private_key_pem: 'K' });
    const holder = createCertChainHolder(initial);
    expect(holder.current()).toEqual(initial);
  });

  it('starts with null when no initial chain provided', () => {
    expect(createCertChainHolder(null).current()).toBeNull();
  });

  it('propagates rotation atomically and notifies listeners', () => {
    const a = buildCertChain({ cert_pem: PEM_CERT, private_key_pem: 'A' });
    const b = buildCertChain({ cert_pem: PEM_CERT, private_key_pem: 'B' });
    const holder = createCertChainHolder(a);
    const observed: Array<{ next: string | null; prev: string | null }> = [];
    holder.subscribe((next, prev) => {
      observed.push({
        next: next?.private_key_pem ?? null,
        prev: prev?.private_key_pem ?? null,
      });
    });
    holder.rotate(b);
    expect(holder.current()).toEqual(b);
    expect(observed).toEqual([{ next: 'B', prev: 'A' }]);
  });

  it('supports retiring the chain by rotating to null', () => {
    const a = buildCertChain({ cert_pem: PEM_CERT, private_key_pem: 'A' });
    const holder = createCertChainHolder(a);
    holder.rotate(null);
    expect(holder.current()).toBeNull();
  });

  it('an unsubscribed listener no longer fires on rotation', () => {
    const holder = createCertChainHolder(null);
    const fired: number[] = [];
    const off = holder.subscribe(() => fired.push(1));
    off();
    holder.rotate(buildCertChain({ cert_pem: PEM_CERT, private_key_pem: 'X' }));
    expect(fired).toEqual([]);
  });

  it('isolates listener errors from rotation propagation', () => {
    const holder = createCertChainHolder(null);
    holder.subscribe(() => { throw new Error('boom'); });
    const observed: string[] = [];
    holder.subscribe((next) => {
      observed.push(next?.private_key_pem ?? 'null');
    });
    expect(() => holder.rotate(buildCertChain({ cert_pem: PEM_CERT, private_key_pem: 'X' }))).not.toThrow();
    expect(observed).toEqual(['X']);
  });
});
