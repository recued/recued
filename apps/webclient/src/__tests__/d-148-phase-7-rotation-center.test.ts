/** D-148 P7 — webclient rotation-center renderer.
 *
 *  Substrate-only tests over `apps/webclient/src/settings/rotation-center.ts`.
 *  The webclient never executes rotations itself; it only shapes the
 *  dispatch payload + maps results to user-facing copy.
 */

import { describe, it, expect } from 'vitest';
import {
  ROTATION_BUTTON_REGISTRY,
  ROTATION_COPY,
  ROTATION_ERROR_COPY,
  buildRotationDispatch,
  isTlsRotationSuccess,
  requiresRepairFollowup,
  severityForResult,
} from '../settings/rotation-center.js';
import {
  ROTATION_OPS,
  ROTATION_OP_KEY_CLASS,
  type RotationOp,
  type RotationResult,
} from '@recued/contracts';

describe('D-148 P7 — rotation-center renderer', () => {
  it('per-op copy exists for every op', () => {
    for (const op of ROTATION_OPS) {
      expect(ROTATION_COPY[op]).toBeDefined();
      expect(ROTATION_COPY[op].confirm_title).toBeTruthy();
      expect(ROTATION_COPY[op].confirm_body).toBeTruthy();
      expect(ROTATION_COPY[op].success_title).toBeTruthy();
    }
  });

  it('error copy covers every closed-list error code', () => {
    const expected = [
      'op_unknown',
      'key_class_mismatch',
      'key_not_loaded',
      'rotation_in_progress',
      'compromise_already_recorded',
      'acme_helper_unavailable',
      'subscription_required',
      'target_not_found',
      'forbidden',
      'unsigned_notice',
      'storage_io_error',
    ] as const;
    for (const code of expected) {
      expect(ROTATION_ERROR_COPY[code]).toBeTruthy();
    }
  });

  it('button registry maps every op to a key class + selector hint', () => {
    expect(ROTATION_BUTTON_REGISTRY).toHaveLength(ROTATION_OPS.length);
    for (const row of ROTATION_BUTTON_REGISTRY) {
      if (row.op === 'mark_compromised') {
        expect(row.key_class).toBe('any');
        expect(row.selector).toBe('key_class');
      } else {
        expect(row.key_class).toBe(ROTATION_OP_KEY_CLASS[row.op]);
      }
    }
  });

  it('buildRotationDispatch is a typed pass-through (substrate decides shape)', () => {
    const a = buildRotationDispatch({ op: 'master_dek_rotate' });
    expect(a.op).toBe('master_dek_rotate');
    // D-169 P0 Slice 2B — `webclient_token_rotate` now serves both
    // bridge + webclient paired clients; `bridge_token_rotate` retired
    // alongside the `bridge_token` KeyClass.
    const b = buildRotationDispatch({ op: 'webclient_token_rotate', client_id: 'c1' });
    expect(b).toMatchObject({ op: 'webclient_token_rotate', client_id: 'c1' });
    const c = buildRotationDispatch({
      op: 'mark_compromised',
      key_class: 'webhook_secret',
      reason: 'incident',
    });
    expect(c).toMatchObject({ op: 'mark_compromised', key_class: 'webhook_secret' });
  });

  it('requiresRepairFollowup detects re-pair-required results', () => {
    const ok: RotationResult = {
      ok: true,
      op: 'server_identity_rotate',
      key_class: 'server_identity_key',
      repair_client_ids: ['c1', 'c2'],
      rotated_at: 1,
    };
    const no: RotationResult = {
      ok: true,
      op: 'master_dek_rotate',
      key_class: 'master_dek',
      reencrypted_blob_count: 0,
      rotated_at: 1,
    };
    const fail: RotationResult = { ok: false, op: 'master_dek_rotate', error: 'rotation_in_progress' };
    expect(requiresRepairFollowup(ok)).toBe(true);
    expect(requiresRepairFollowup(no)).toBe(false);
    expect(requiresRepairFollowup(fail)).toBe(false);
  });

  it('isTlsRotationSuccess narrows correctly', () => {
    const tls: RotationResult = {
      ok: true,
      op: 'tls_renew',
      key_class: 'tls_private_key',
      new_fingerprint: 'sha256:abc',
      rotated_at: 1,
    };
    const other: RotationResult = {
      ok: true,
      op: 'master_dek_rotate',
      key_class: 'master_dek',
      rotated_at: 1,
    };
    expect(isTlsRotationSuccess(tls)).toBe(true);
    expect(isTlsRotationSuccess(other)).toBe(false);
  });

  it('severityForResult: success vs warning vs error', () => {
    const okOther: RotationResult = {
      ok: true,
      op: 'master_dek_rotate',
      key_class: 'master_dek',
      rotated_at: 1,
    };
    const okCompromise: RotationResult = {
      ok: true,
      op: 'mark_compromised',
      key_class: 'webhook_secret',
      rotated_at: 1,
    };
    const fail: RotationResult = {
      ok: false,
      op: 'tls_renew',
      error: 'acme_helper_unavailable',
    };
    expect(severityForResult(okOther)).toBe('success');
    expect(severityForResult(okCompromise)).toBe('warning');
    expect(severityForResult(fail)).toBe('error');
  });
});
