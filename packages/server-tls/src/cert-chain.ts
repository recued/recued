/** D-148 § A.6 — TLS cert + key handle for the four-port layout.
 *
 *  All four ports share one TLS termination surface — one cert with
 *  SAN entries covering the public hostname. Rotation is atomic: load
 *  new chain → swap reference in the listener set → next handshake
 *  uses the new chain → existing connections continue on their
 *  already-completed handshake.
 *
 *  Per spec § A.6 / § A.6.5 we never mutate the loaded chain; rotation
 *  always swaps the pointer. Rotation propagation is therefore a
 *  pointer-swap that every listener observes through the same shared
 *  reference. */

import { createHash } from 'node:crypto';
import type { CertChain } from './types.js';

/** Wrap a cert + key into a typed `CertChain`. Computes the
 *  SHA-256 fingerprint of the leaf cert PEM (DER bytes equivalence
 *  via deterministic PEM-strip + base64-decode + hash). The
 *  fingerprint is what the Reachability Doctor compares against for
 *  the `cert_fingerprint_mismatch` recommendation + what the cert-
 *  pin notice (§ A.6.5) signs. */
export const buildCertChain = (input: {
  cert_pem: string;
  private_key_pem: string;
  expires_at?: number;
}): CertChain => {
  const fingerprint = computeCertFingerprint(input.cert_pem);
  const out: CertChain = {
    cert_pem: input.cert_pem,
    private_key_pem: input.private_key_pem,
  };
  if (fingerprint) out.fingerprint = fingerprint;
  if (typeof input.expires_at === 'number') out.expires_at = input.expires_at;
  return out;
};

/** Compute the SHA-256 fingerprint of the leaf cert in PEM form.
 *  Returns lowercase hex (no separators) on success; empty string when
 *  the input doesn't look like a PEM cert (the listener layer treats
 *  empty as "no cert loaded" — common in `certbot` / `caddy` modes
 *  where TLS is upstream). */
export const computeCertFingerprint = (cert_pem: string): string => {
  if (typeof cert_pem !== 'string' || cert_pem.length === 0) return '';
  const begin = '-----BEGIN CERTIFICATE-----';
  const end = '-----END CERTIFICATE-----';
  const beginIdx = cert_pem.indexOf(begin);
  if (beginIdx === -1) return '';
  const endIdx = cert_pem.indexOf(end, beginIdx + begin.length);
  if (endIdx === -1) return '';
  const body = cert_pem
    .slice(beginIdx + begin.length, endIdx)
    .replace(/\s+/g, '');
  if (body.length === 0) return '';
  let der: Buffer;
  try {
    der = Buffer.from(body, 'base64');
  } catch {
    return '';
  }
  if (der.length === 0) return '';
  return createHash('sha256').update(der).digest('hex');
};

/** Mutable holder for the chain. Listeners read through the holder
 *  every handshake (the substrate exposes a getter rather than a
 *  snapshot, so a rotation propagates without a re-bind). The holder
 *  also fires `onRotate` callbacks so dependent layers (cert-pin
 *  rotation notice signer, doctor cache invalidator) can react. */
export interface CertChainHolder {
  /** Read the current chain. May be null when no cert is loaded
   *  (LAN-only / upstream-TLS modes). */
  current(): CertChain | null;
  /** Replace the chain atomically. Fires `onRotate` callbacks with
   *  the previous + new chain. Passing null retires the chain (e.g.
   *  switching to upstream-TLS mode). */
  rotate(next: CertChain | null): void;
  /** Subscribe to rotation events. Returns an unsubscribe function. */
  subscribe(listener: CertRotationListener): () => void;
}

export type CertRotationListener = (
  next: CertChain | null,
  previous: CertChain | null,
) => void;

/** Build a holder from an initial chain. Initial state may be null —
 *  the listener layer starts in plaintext / upstream-TLS mode then,
 *  and a later `rotate(...)` lands the cert. */
export const createCertChainHolder = (initial: CertChain | null): CertChainHolder => {
  let chain: CertChain | null = initial;
  const listeners = new Set<CertRotationListener>();
  return {
    current: () => chain,
    rotate: (next) => {
      const previous = chain;
      chain = next;
      for (const listener of listeners) {
        try {
          listener(next, previous);
        } catch {
          // Listener errors must not poison the rotation; the
          // substrate logs at the listener's site, not here.
        }
      }
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
};
