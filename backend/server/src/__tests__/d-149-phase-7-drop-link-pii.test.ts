/** D-149 P7 § A.5.4 + § N.6 — `drop-pii.ts` AEAD round-trip + AAD-binding tests.
 *
 *  Covers:
 *    - Round-trip seal → open recovers the plaintext verbatim.
 *    - Distinct HKDF info label ⇒ key is different from form-PII +
 *      booking-PII keys.
 *    - AAD binding: a sealed ciphertext from `(endpoint A, blob X)` fails
 *      to decrypt when re-presented with `(endpoint B, …)` or
 *      `(…, blob Y, …)` AAD; cross-field decrypt also fails.
 *    - Null / empty plaintext returns null (caller persists NULL). */

import { describe, expect, it } from 'vitest';
import {
  buildDropBlobAad,
  deriveDropBlobPiiKeyFromSubDek,
  openDropBlobPiiField,
  sealDropBlobPiiField,
} from '../ports/reception/drop-pii.js';
import { deriveFormSubmissionPiiKeyFromSubDek } from '../ports/reception/form-pii.js';

const SUB_DEK = new Uint8Array(32).fill(0x4b);

describe('D-149 P7 § A.5.4 — drop-pii AEAD round-trip', () => {
  it('round-trips visitor_email ciphertext via AAD-bound key', async () => {
    const key = deriveDropBlobPiiKeyFromSubDek(SUB_DEK);
    const ct = await sealDropBlobPiiField({
      key,
      endpoint_id: 'ep-1',
      blob_id: 'b-1',
      field: 'visitor_email',
      plaintext: 'visitor@example.com',
    });
    expect(ct).not.toBeNull();
    const pt = await openDropBlobPiiField({
      key,
      endpoint_id: 'ep-1',
      blob_id: 'b-1',
      field: 'visitor_email',
      ciphertext: ct,
    });
    expect(pt).toBe('visitor@example.com');
  });

  it('round-trips visitor_name + visitor_description ciphertext', async () => {
    const key = deriveDropBlobPiiKeyFromSubDek(SUB_DEK);
    const nameCt = await sealDropBlobPiiField({
      key,
      endpoint_id: 'ep-1',
      blob_id: 'b-1',
      field: 'visitor_name',
      plaintext: 'Mary Smith',
    });
    const descCt = await sealDropBlobPiiField({
      key,
      endpoint_id: 'ep-1',
      blob_id: 'b-1',
      field: 'visitor_description',
      plaintext: 'A contract for review.',
    });
    expect(
      await openDropBlobPiiField({
        key,
        endpoint_id: 'ep-1',
        blob_id: 'b-1',
        field: 'visitor_name',
        ciphertext: nameCt,
      }),
    ).toBe('Mary Smith');
    expect(
      await openDropBlobPiiField({
        key,
        endpoint_id: 'ep-1',
        blob_id: 'b-1',
        field: 'visitor_description',
        ciphertext: descCt,
      }),
    ).toBe('A contract for review.');
  });

  it('returns null for empty / null / undefined plaintext', async () => {
    const key = deriveDropBlobPiiKeyFromSubDek(SUB_DEK);
    expect(
      await sealDropBlobPiiField({
        key,
        endpoint_id: 'ep-1',
        blob_id: 'b-1',
        field: 'visitor_email',
        plaintext: undefined,
      }),
    ).toBeNull();
    expect(
      await sealDropBlobPiiField({
        key,
        endpoint_id: 'ep-1',
        blob_id: 'b-1',
        field: 'visitor_email',
        plaintext: null,
      }),
    ).toBeNull();
    expect(
      await sealDropBlobPiiField({
        key,
        endpoint_id: 'ep-1',
        blob_id: 'b-1',
        field: 'visitor_email',
        plaintext: '',
      }),
    ).toBeNull();
  });

  it('fails to decrypt across endpoint_id', async () => {
    const key = deriveDropBlobPiiKeyFromSubDek(SUB_DEK);
    const ct = await sealDropBlobPiiField({
      key,
      endpoint_id: 'ep-A',
      blob_id: 'b-1',
      field: 'visitor_email',
      plaintext: 'hi@example.com',
    });
    await expect(
      openDropBlobPiiField({
        key,
        endpoint_id: 'ep-B',
        blob_id: 'b-1',
        field: 'visitor_email',
        ciphertext: ct,
      }),
    ).rejects.toThrow();
  });

  it('fails to decrypt across blob_id', async () => {
    const key = deriveDropBlobPiiKeyFromSubDek(SUB_DEK);
    const ct = await sealDropBlobPiiField({
      key,
      endpoint_id: 'ep-A',
      blob_id: 'b-1',
      field: 'visitor_email',
      plaintext: 'hi@example.com',
    });
    await expect(
      openDropBlobPiiField({
        key,
        endpoint_id: 'ep-A',
        blob_id: 'b-2',
        field: 'visitor_email',
        ciphertext: ct,
      }),
    ).rejects.toThrow();
  });

  it('fails to decrypt across field label', async () => {
    const key = deriveDropBlobPiiKeyFromSubDek(SUB_DEK);
    const ct = await sealDropBlobPiiField({
      key,
      endpoint_id: 'ep-A',
      blob_id: 'b-1',
      field: 'visitor_email',
      plaintext: 'hi@example.com',
    });
    await expect(
      openDropBlobPiiField({
        key,
        endpoint_id: 'ep-A',
        blob_id: 'b-1',
        field: 'visitor_name',
        ciphertext: ct,
      }),
    ).rejects.toThrow();
  });

  // D-210 A.8 slice 4c — was 'distinct from form-PII + booking-PII keys'. The
  // booking comparand went with its key stream; the NAME goes with it, because a
  // test name is a guarantee about what ran. ⇒ [[feedback_a_test_name_is_a_guarantee]]
  it('derives a key distinct from the form-PII key', () => {
    const dropKey = deriveDropBlobPiiKeyFromSubDek(SUB_DEK);
    const formKey = deriveFormSubmissionPiiKeyFromSubDek(SUB_DEK);
    expect(dropKey.length).toBe(32);
    expect(Buffer.compare(Buffer.from(dropKey), Buffer.from(formKey))).not.toBe(0);
  });

  it('rejects a non-32-byte sub_dek', () => {
    expect(() => deriveDropBlobPiiKeyFromSubDek(new Uint8Array(16))).toThrow();
    expect(() => deriveDropBlobPiiKeyFromSubDek(new Uint8Array(48))).toThrow();
  });

  it('buildDropBlobAad produces stable deterministic bytes', () => {
    const a = buildDropBlobAad({ endpoint_id: 'ep-1', blob_id: 'b-1', field: 'visitor_email' });
    const b = buildDropBlobAad({ endpoint_id: 'ep-1', blob_id: 'b-1', field: 'visitor_email' });
    expect(Buffer.compare(Buffer.from(a), Buffer.from(b))).toBe(0);
    const decoded = new TextDecoder().decode(a);
    expect(decoded).toContain('recued/v1/reception/drop_blob/ep-1/b-1/visitor_email');
  });
});
