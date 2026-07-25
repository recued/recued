/** D-148 § A.6.5 — `cert.rotation_notice` + `cert.rotation_reverted`
 *  broadcast event shape coverage.
 *
 *  The cert-rotation events ride the same per-pair broadcast bus as
 *  `token.rotated` (D-148 § A.4.4). These assertions are the closed-
 *  list ratchet for the new variants — adding a third cert-rotation
 *  event would have to update both the union AND this test.
 */

import { describe, expect, it } from 'vitest';
import {
  ALL_BROADCAST_EVENT_KINDS,
  BROADCAST_EVENT_KIND_SET,
  DEFAULT_SUBSCRIPTIONS,
  type ServerEvent,
} from '../index.js';

describe('D-148 § A.6.5 — cert.rotation_notice broadcast', () => {
  it('is in ALL_BROADCAST_EVENT_KINDS + BROADCAST_EVENT_KIND_SET', () => {
    expect(ALL_BROADCAST_EVENT_KINDS).toContain('cert.rotation_notice');
    expect(BROADCAST_EVENT_KIND_SET.has('cert.rotation_notice')).toBe(true);
  });

  it('is in DEFAULT_SUBSCRIPTIONS (every paired client opts in)', () => {
    expect(DEFAULT_SUBSCRIPTIONS).toContain('cert.rotation_notice');
  });

  it('shape carries fingerprints + rotation_at + signature + signer + cursor', () => {
    const ev: ServerEvent = {
      kind: 'cert.rotation_notice',
      current_fingerprint: 'sha256:current',
      next_fingerprint: 'sha256:next',
      rotation_at: 5_000_000,
      signature: 'sig_b64',
      signer_fingerprint: 'sha256:signer',
      emitted_at: 4_990_000,
      cursor: 42,
    };
    expect(ev.kind).toBe('cert.rotation_notice');
    if (ev.kind === 'cert.rotation_notice') {
      expect(ev.current_fingerprint).toBe('sha256:current');
      expect(ev.next_fingerprint).toBe('sha256:next');
      expect(ev.rotation_at).toBe(5_000_000);
      expect(ev.signature).toBe('sig_b64');
      expect(ev.signer_fingerprint).toBe('sha256:signer');
      expect(ev.emitted_at).toBe(4_990_000);
      expect(ev.cursor).toBe(42);
    }
  });
});

describe('D-148 § A.6.5 — cert.rotation_reverted broadcast', () => {
  it('is in ALL_BROADCAST_EVENT_KINDS + DEFAULT_SUBSCRIPTIONS', () => {
    expect(ALL_BROADCAST_EVENT_KINDS).toContain('cert.rotation_reverted');
    expect(BROADCAST_EVENT_KIND_SET.has('cert.rotation_reverted')).toBe(true);
    expect(DEFAULT_SUBSCRIPTIONS).toContain('cert.rotation_reverted');
  });

  it('shape — required + optional reason', () => {
    const withReason: ServerEvent = {
      kind: 'cert.rotation_reverted',
      reverted_to_fingerprint: 'sha256:old',
      reason: 'TLS chain regression',
      reverted_at: 6_000_000,
      signature: 'sig_b64',
      signer_fingerprint: 'sha256:signer',
      cursor: 43,
    };
    expect(withReason.kind).toBe('cert.rotation_reverted');
    if (withReason.kind === 'cert.rotation_reverted') {
      expect(withReason.reason).toBe('TLS chain regression');
    }
    const withoutReason: ServerEvent = {
      kind: 'cert.rotation_reverted',
      reverted_to_fingerprint: 'sha256:old',
      reverted_at: 6_000_000,
      signature: 'sig_b64',
      signer_fingerprint: 'sha256:signer',
      cursor: 44,
    };
    if (withoutReason.kind === 'cert.rotation_reverted') {
      expect(withoutReason.reason).toBeUndefined();
    }
  });
});

