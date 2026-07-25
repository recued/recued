/** D-149 P6 § A.5.3 + § N.6 — `form-pii.ts` AEAD round-trip + AAD-binding tests.
 *
 *  Covers:
 *    - Round-trip seal → open recovers the plaintext verbatim.
 *    - The sub-DEK actually keys the stream: different sub-DEKs derive
 *      different keys, and a ciphertext refuses to open under another one.
 *    - AAD binding: a sealed ciphertext from (endpoint A, submission X)
 *      fails to decrypt when re-presented with (endpoint B, …) or
 *      (…, submission Y, …) AAD.
 *    - Null / empty plaintext returns null (caller persists NULL).
 *
 *  ⚠ D-210 A.8 slice 4c — this suite now covers the BOOKING flow too. A booking
 *  is a `reception_form_submission` row and its fields seal under THIS key, so
 *  the retired `booking-pii.ts` suite's two sub-DEK claims were ported here
 *  rather than deleted with it: nothing else in the tree varied the sub-DEK, so
 *  dropping them would have left the derivation's only real input untested
 *  precisely as it started carrying a second flow.
 *  ⇒ [[feedback_a_reduction_is_faked_by_doing_less]] */

import { describe, expect, it } from 'vitest';
import {
  buildFormSubmissionAad,
  deriveFormSubmissionPiiKeyFromSubDek,
  openFormSubmissionField,
  sealFormSubmissionField,
} from '../ports/reception/form-pii.js';

const SUB_DEK = new Uint8Array(32).fill(0x4b);

describe('D-149 P6 § A.5.3 — form-pii AEAD round-trip', () => {
  it('round-trips submission_blob ciphertext via the AAD-bound key', async () => {
    const key = deriveFormSubmissionPiiKeyFromSubDek(SUB_DEK);
    const ct = await sealFormSubmissionField({
      key,
      endpoint_id: 'ep-1',
      submission_id: 'sub-1',
      field: 'submission_blob',
      plaintext: '{"fields":{"a":1}}',
    });
    expect(ct).not.toBeNull();
    const pt = await openFormSubmissionField({
      key,
      endpoint_id: 'ep-1',
      submission_id: 'sub-1',
      field: 'submission_blob',
      ciphertext: ct,
    });
    expect(pt).toBe('{"fields":{"a":1}}');
  });

  it('round-trips visitor_email ciphertext', async () => {
    const key = deriveFormSubmissionPiiKeyFromSubDek(SUB_DEK);
    const ct = await sealFormSubmissionField({
      key,
      endpoint_id: 'ep-1',
      submission_id: 'sub-1',
      field: 'visitor_email',
      plaintext: 'visitor@example.com',
    });
    const pt = await openFormSubmissionField({
      key,
      endpoint_id: 'ep-1',
      submission_id: 'sub-1',
      field: 'visitor_email',
      ciphertext: ct,
    });
    expect(pt).toBe('visitor@example.com');
  });

  it('returns null for empty / null / undefined plaintext', async () => {
    const key = deriveFormSubmissionPiiKeyFromSubDek(SUB_DEK);
    expect(
      await sealFormSubmissionField({
        key,
        endpoint_id: 'ep-1',
        submission_id: 'sub-1',
        field: 'visitor_email',
        plaintext: undefined,
      }),
    ).toBeNull();
    expect(
      await sealFormSubmissionField({
        key,
        endpoint_id: 'ep-1',
        submission_id: 'sub-1',
        field: 'visitor_email',
        plaintext: null,
      }),
    ).toBeNull();
    expect(
      await sealFormSubmissionField({
        key,
        endpoint_id: 'ep-1',
        submission_id: 'sub-1',
        field: 'visitor_email',
        plaintext: '',
      }),
    ).toBeNull();
  });

  it('fails to decrypt when endpoint_id AAD differs', async () => {
    const key = deriveFormSubmissionPiiKeyFromSubDek(SUB_DEK);
    const ct = await sealFormSubmissionField({
      key,
      endpoint_id: 'ep-A',
      submission_id: 'sub-1',
      field: 'visitor_email',
      plaintext: 'hi@example.com',
    });
    await expect(
      openFormSubmissionField({
        key,
        endpoint_id: 'ep-B',
        submission_id: 'sub-1',
        field: 'visitor_email',
        ciphertext: ct,
      }),
    ).rejects.toThrow();
  });

  it('fails to decrypt when submission_id AAD differs', async () => {
    const key = deriveFormSubmissionPiiKeyFromSubDek(SUB_DEK);
    const ct = await sealFormSubmissionField({
      key,
      endpoint_id: 'ep-A',
      submission_id: 'sub-1',
      field: 'visitor_email',
      plaintext: 'hi@example.com',
    });
    await expect(
      openFormSubmissionField({
        key,
        endpoint_id: 'ep-A',
        submission_id: 'sub-2',
        field: 'visitor_email',
        ciphertext: ct,
      }),
    ).rejects.toThrow();
  });

  it('fails to decrypt when field label AAD differs', async () => {
    const key = deriveFormSubmissionPiiKeyFromSubDek(SUB_DEK);
    const ct = await sealFormSubmissionField({
      key,
      endpoint_id: 'ep-A',
      submission_id: 'sub-1',
      field: 'visitor_email',
      plaintext: 'hi@example.com',
    });
    await expect(
      openFormSubmissionField({
        key,
        endpoint_id: 'ep-A',
        submission_id: 'sub-1',
        field: 'submission_blob',
        ciphertext: ct,
      }),
    ).rejects.toThrow();
  });

  // ⚠ D-210 A.8 slice 4c — the `formKey !== bookingKey` case is GONE because the
  // BOOKING KEY STREAM is gone (a booking's fields seal under this very key
  // now), not because the separation guarantee weakened. The form key's
  // distinctness from every key that still exists is asserted from the other
  // side: `drop !== form` in the P7 suite and `approval !== form` in P8. All
  // three live streams remain pairwise separated.
  // ⛔ A case leaves this suite only when its KEY leaves the substrate.

  it('rejects a non-32-byte sub_dek', () => {
    expect(() => deriveFormSubmissionPiiKeyFromSubDek(new Uint8Array(16))).toThrow();
  });

  // ── Ported from the retired booking-PII suite (D-210 A.8 slice 4c) ──
  // The sub-DEK is the ONLY secret input to this derivation, and no other test
  // in the tree varies it. Without these two, a derivation that ignored its
  // argument entirely would pass every remaining case in this file.

  it('different sub-DEKs derive different keys', () => {
    const k1 = deriveFormSubmissionPiiKeyFromSubDek(new Uint8Array(32).fill(0x01));
    const k2 = deriveFormSubmissionPiiKeyFromSubDek(new Uint8Array(32).fill(0x02));
    expect(k1.length).toBe(32);
    expect(Buffer.compare(Buffer.from(k1), Buffer.from(k2))).not.toBe(0);
  });

  it('fails to decrypt under a different sub-DEK', async () => {
    const key = deriveFormSubmissionPiiKeyFromSubDek(SUB_DEK);
    const ct = await sealFormSubmissionField({
      key,
      endpoint_id: 'ep-1',
      submission_id: 'sub-1',
      field: 'visitor_email',
      plaintext: 'ada@example.test',
    });
    const otherKey = deriveFormSubmissionPiiKeyFromSubDek(new Uint8Array(32).fill(0x77));
    // A wrong key must REFUSE, never hand back a blank that a caller would
    // persist as "the visitor gave no address".
    await expect(openFormSubmissionField({
      key: otherKey,
      endpoint_id: 'ep-1',
      submission_id: 'sub-1',
      field: 'visitor_email',
      ciphertext: ct,
    })).rejects.toThrow();
  });

  it('buildFormSubmissionAad produces stable, deterministic bytes', () => {
    const a = buildFormSubmissionAad({
      endpoint_id: 'ep-1',
      submission_id: 'sub-1',
      field: 'visitor_email',
    });
    const b = buildFormSubmissionAad({
      endpoint_id: 'ep-1',
      submission_id: 'sub-1',
      field: 'visitor_email',
    });
    expect(Buffer.compare(Buffer.from(a), Buffer.from(b))).toBe(0);
    const decoded = new TextDecoder().decode(a);
    expect(decoded).toContain('recued/v1/reception/form_submission/ep-1/sub-1/visitor_email');
  });
});
