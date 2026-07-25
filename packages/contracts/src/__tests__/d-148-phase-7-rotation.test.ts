/** D-148 P7 + D-169 P0 Slice 2B — rotation registry contract tests.
 *
 *  Closed-list invariants:
 *   - ROTATION_OPS enumerates all 7 ops (D-169 P0 Slice 2B retired
 *     `bridge_token_rotate`; bridge bearers now rotate through
 *     `webclient_token_rotate`)
 *   - ROTATION_OP_KEY_CLASS covers every non-compromise op
 *   - isRotationOp narrows correctly
 *   - ROTATION_ERROR_CODES covers every documented failure mode
 *   - KeyRotationEvent / ExposureChangedEvent / CertRotationNotice /
 *     CertRotationRevertedEvent type-shape smoke checks
 */

import { describe, it, expect } from 'vitest';
import {
  ROTATION_OPS,
  ROTATION_OP_KEY_CLASS,
  ROTATION_ERROR_CODES,
  isRotationOp,
  type CertRotationNotice,
  type ExposureChangedEvent,
  type KeyRotationEvent,
  type RotationOrExposureEvent,
  type RotationResult,
} from '../d-148-rotation.js';

describe('D-148 P7 — rotation contract registry', () => {
  it('enumerates all 7 rotation ops (D-169 P0 Slice 2B retired `bridge_token_rotate`)', () => {
    expect(ROTATION_OPS).toEqual([
      'master_dek_rotate',
      'server_identity_rotate',
      'publisher_identity_rotate',
      'tls_renew',
      'webclient_token_rotate',
      'webhook_secret_rotate',
      'mark_compromised',
    ]);
    expect((ROTATION_OPS as ReadonlyArray<string>).includes('bridge_token_rotate')).toBe(false);
  });

  it('every non-compromise op carries a key_class binding', () => {
    for (const op of ROTATION_OPS) {
      if (op === 'mark_compromised') continue;
      expect(ROTATION_OP_KEY_CLASS[op]).toBeDefined();
    }
  });

  it('isRotationOp narrows correctly', () => {
    expect(isRotationOp('master_dek_rotate')).toBe(true);
    expect(isRotationOp('mark_compromised')).toBe(true);
    expect(isRotationOp('not-a-real-op')).toBe(false);
    expect(isRotationOp(42)).toBe(false);
    expect(isRotationOp(undefined)).toBe(false);
  });

  it('error codes cover the closed list', () => {
    expect(ROTATION_ERROR_CODES).toContain('op_unknown');
    expect(ROTATION_ERROR_CODES).toContain('key_not_loaded');
    expect(ROTATION_ERROR_CODES).toContain('rotation_in_progress');
    expect(ROTATION_ERROR_CODES).toContain('compromise_already_recorded');
    expect(ROTATION_ERROR_CODES).toContain('acme_helper_unavailable');
    expect(ROTATION_ERROR_CODES).toContain('subscription_required');
    expect(ROTATION_ERROR_CODES).toContain('target_not_found');
    expect(ROTATION_ERROR_CODES).toContain('forbidden');
    expect(ROTATION_ERROR_CODES).toContain('unsigned_notice');
    expect(ROTATION_ERROR_CODES).toContain('storage_io_error');
    expect(ROTATION_ERROR_CODES).toContain('key_class_mismatch');
  });

  it('discriminated event union accepts the remaining event types', () => {
    const rotation: KeyRotationEvent = {
      type: 'key_rotation',
      op: 'master_dek_rotate',
      key_class: 'master_dek',
      rotated_at: 1,
      repair_required: false,
      compromise: false,
    };
    const exposure: ExposureChangedEvent = {
      type: 'exposure_changed',
      resolution: {
      health: { lan: true, public: true },
      ws: { lan: true, public: false },
      mcp: { lan: true, public: false },
      llm_gateway: { lan: true, public: false },
      webhooks: { lan: true, public: true },
        reception: { lan: false, public: false },
        oauth: { lan: false, public: false },
        ask: { lan: false, public: false },
        webclient: { lan: true, public: false },
      },
      derived_preset_label: 'custom',
      public_mcp_acknowledgement: { acknowledged: false },
      changed_at: 1,
      changed_by_client_id: 'admin',
    };
    const cert: CertRotationNotice = {
      type: 'cert_rotation_notice',
      current_fingerprint: 'sha256:1',
      next_fingerprint: 'sha256:2',
      rotation_at: 1,
      signature: 'sig',
      signer_fingerprint: 'sha256:1',
      emitted_at: 1,
    };
    // Compile-time pin: every variant is assignable to the union.
    // (D-156 P9 retired PairRequiredEvent — the rotation engine no
    // longer broadcasts re-pair signals; clients recover via the
    // webclient `onReauthRequired` funnel on the next handshake.)
    const events: RotationOrExposureEvent[] = [rotation, exposure, cert];
    expect(events).toHaveLength(3);
  });

  it('master_dek + sub_dek map correctly in op→class table', () => {
    expect(ROTATION_OP_KEY_CLASS.master_dek_rotate).toBe('master_dek');
    expect(ROTATION_OP_KEY_CLASS.server_identity_rotate).toBe('server_identity_key');
    expect(ROTATION_OP_KEY_CLASS.publisher_identity_rotate).toBe('publisher_identity_key');
    expect(ROTATION_OP_KEY_CLASS.tls_renew).toBe('tls_private_key');
    expect(ROTATION_OP_KEY_CLASS.webclient_token_rotate).toBe('webclient_token');
    expect(ROTATION_OP_KEY_CLASS.webhook_secret_rotate).toBe('webhook_secret');
  });

  it('RotationResult ok-true and ok-false discriminator', () => {
    const ok: RotationResult = {
      ok: true,
      op: 'master_dek_rotate',
      key_class: 'master_dek',
      reencrypted_blob_count: 100,
      rotated_at: 1,
    };
    const fail: RotationResult = {
      ok: false,
      op: 'tls_renew',
      error: 'acme_helper_unavailable',
    };
    expect(ok.ok).toBe(true);
    expect(fail.ok).toBe(false);
  });
});
