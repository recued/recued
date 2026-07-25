/** D-149 P8 § A.5.5 + § N.6 — `approval-pii.ts` AEAD round-trip + AAD-binding tests.
 *
 *  Covers:
 *    - Round-trip seal → open recovers the plaintext verbatim.
 *    - Distinct HKDF info label ⇒ key is different from form-PII +
 *      booking-PII + drop-PII keys.
 *    - AAD binding: a sealed ciphertext from `(endpoint A, intent X)`
 *      fails to decrypt when re-presented with `(endpoint B, …)` or
 *      `(…, intent Y, …)` AAD; cross-field decrypt also fails.
 *    - Null / empty plaintext returns null (caller persists NULL). */

import { describe, expect, it } from 'vitest';
import {
  buildApprovalIntentAad,
  deriveApprovalIntentPiiKeyFromSubDek,
  openApprovalIntentPiiField,
  sealApprovalIntentPiiField,
} from '../ports/reception/approval-pii.js';
import { deriveDropBlobPiiKeyFromSubDek } from '../ports/reception/drop-pii.js';
import { deriveFormSubmissionPiiKeyFromSubDek } from '../ports/reception/form-pii.js';

const SUB_DEK = new Uint8Array(32).fill(0x4c);

describe('D-149 P8 § A.5.5 — approval-pii AEAD round-trip', () => {
  it('round-trips visitor_email ciphertext via AAD-bound key', async () => {
    const key = deriveApprovalIntentPiiKeyFromSubDek(SUB_DEK);
    const ct = await sealApprovalIntentPiiField({
      key,
      endpoint_id: 'ep-1',
      intent_id: 'i-1',
      field: 'visitor_email',
      plaintext: 'visitor@example.com',
    });
    expect(ct).not.toBeNull();
    const pt = await openApprovalIntentPiiField({
      key,
      endpoint_id: 'ep-1',
      intent_id: 'i-1',
      field: 'visitor_email',
      ciphertext: ct,
    });
    expect(pt).toBe('visitor@example.com');
  });

  it('round-trips visitor_name + outcome ciphertext independently', async () => {
    const key = deriveApprovalIntentPiiKeyFromSubDek(SUB_DEK);
    const nameCt = await sealApprovalIntentPiiField({
      key,
      endpoint_id: 'ep-1',
      intent_id: 'i-1',
      field: 'visitor_name',
      plaintext: 'Bob Smith',
    });
    const outcomeCt = await sealApprovalIntentPiiField({
      key,
      endpoint_id: 'ep-1',
      intent_id: 'i-1',
      field: 'outcome',
      plaintext: 'pick:morning_slot',
    });
    expect(
      await openApprovalIntentPiiField({
        key,
        endpoint_id: 'ep-1',
        intent_id: 'i-1',
        field: 'visitor_name',
        ciphertext: nameCt,
      }),
    ).toBe('Bob Smith');
    expect(
      await openApprovalIntentPiiField({
        key,
        endpoint_id: 'ep-1',
        intent_id: 'i-1',
        field: 'outcome',
        ciphertext: outcomeCt,
      }),
    ).toBe('pick:morning_slot');
  });

  it('returns null for empty / null / undefined plaintext', async () => {
    const key = deriveApprovalIntentPiiKeyFromSubDek(SUB_DEK);
    expect(
      await sealApprovalIntentPiiField({
        key,
        endpoint_id: 'ep-1',
        intent_id: 'i-1',
        field: 'visitor_email',
        plaintext: undefined,
      }),
    ).toBeNull();
    expect(
      await sealApprovalIntentPiiField({
        key,
        endpoint_id: 'ep-1',
        intent_id: 'i-1',
        field: 'visitor_email',
        plaintext: null,
      }),
    ).toBeNull();
    expect(
      await sealApprovalIntentPiiField({
        key,
        endpoint_id: 'ep-1',
        intent_id: 'i-1',
        field: 'visitor_email',
        plaintext: '',
      }),
    ).toBeNull();
  });
});

describe('D-149 P8 § A.5.5 — AAD-binding rejects cross-row / cross-field decrypt', () => {
  it('cross-intent decrypt fails', async () => {
    const key = deriveApprovalIntentPiiKeyFromSubDek(SUB_DEK);
    const ct = await sealApprovalIntentPiiField({
      key,
      endpoint_id: 'ep-1',
      intent_id: 'i-1',
      field: 'visitor_email',
      plaintext: 'v@example.com',
    });
    await expect(
      openApprovalIntentPiiField({
        key,
        endpoint_id: 'ep-1',
        intent_id: 'i-other',
        field: 'visitor_email',
        ciphertext: ct,
      }),
    ).rejects.toThrow();
  });

  it('cross-endpoint decrypt fails', async () => {
    const key = deriveApprovalIntentPiiKeyFromSubDek(SUB_DEK);
    const ct = await sealApprovalIntentPiiField({
      key,
      endpoint_id: 'ep-1',
      intent_id: 'i-1',
      field: 'visitor_email',
      plaintext: 'v@example.com',
    });
    await expect(
      openApprovalIntentPiiField({
        key,
        endpoint_id: 'ep-other',
        intent_id: 'i-1',
        field: 'visitor_email',
        ciphertext: ct,
      }),
    ).rejects.toThrow();
  });

  it('cross-field decrypt fails', async () => {
    const key = deriveApprovalIntentPiiKeyFromSubDek(SUB_DEK);
    const ct = await sealApprovalIntentPiiField({
      key,
      endpoint_id: 'ep-1',
      intent_id: 'i-1',
      field: 'visitor_email',
      plaintext: 'v@example.com',
    });
    await expect(
      openApprovalIntentPiiField({
        key,
        endpoint_id: 'ep-1',
        intent_id: 'i-1',
        field: 'outcome',
        ciphertext: ct,
      }),
    ).rejects.toThrow();
  });
});

describe('D-149 P8 § A.5.5 — HKDF info-label separation from sibling PII keys', () => {
  // D-210 A.8 slice 4c — was 'drop / form / booking'. The booking key stream is
  // retired; the name drops it too rather than promising a comparison that no
  // longer runs. ⇒ [[feedback_a_test_name_is_a_guarantee]]
  it('approval key differs from drop / form keys derived from same sub-DEK', () => {
    const approval = deriveApprovalIntentPiiKeyFromSubDek(SUB_DEK);
    const drop = deriveDropBlobPiiKeyFromSubDek(SUB_DEK);
    const form = deriveFormSubmissionPiiKeyFromSubDek(SUB_DEK);
    expect(Buffer.from(approval).equals(Buffer.from(drop))).toBe(false);
    expect(Buffer.from(approval).equals(Buffer.from(form))).toBe(false);
  });

  it('rejects 31-byte sub_dek as malformed input', () => {
    expect(() => deriveApprovalIntentPiiKeyFromSubDek(new Uint8Array(31))).toThrow();
  });

  it('builds deterministic AAD bytes per (endpoint, intent, field)', () => {
    const a = buildApprovalIntentAad({
      endpoint_id: 'ep',
      intent_id: 'i',
      field: 'visitor_email',
    });
    const b = buildApprovalIntentAad({
      endpoint_id: 'ep',
      intent_id: 'i',
      field: 'visitor_email',
    });
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });
});
