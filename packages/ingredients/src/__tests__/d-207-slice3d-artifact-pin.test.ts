/** D-207 slice 3d — the artifact pin is VERIFIED, never asserted.
 *
 *  ## The hole this closes, in the code's own words
 *
 *  `attachOrderArtifact` carried this comment:
 *
 *    "Pinning it is one-way: a silent RE-POINT would let a later run swap the
 *     delivered bytes out from under an order that has already been approved."
 *
 *  It named the attack and then guarded a different one. It stopped RE-PINNING (a
 *  later run naming a DIFFERENT artifact) and did nothing about RE-POINTING (the
 *  ref stays, the BYTES BEHIND IT CHANGE) — which is the one that matters, because
 *  it leaves the pin looking untouched. `artifact_hash` came from the caller and no
 *  layer ever opened the file, so the pin proved only that the CALLER was
 *  self-consistent.
 *
 *  And a `data.file` record id genuinely does not determine its bytes. The
 *  substrate says so itself — `PinnedCasFileRef` exists for workflows that must get
 *  the same bytes "even when the mutable `data.file` record id is concurrently
 *  repointed".
 *
 *  ⚠ The sharpest form of the bug: the old idempotent-re-pin branch
 *  (`same ref && same hash → unchanged`) IS the system's own "is this still the
 *  artifact I approved?" check — and it answered YES by comparing two strings it
 *  had itself stored. The one question it never asked was the file.
 *
 *  ## What is fenced here, and what is not
 *
 *  This closes PINNING A LIE: an artifact cannot enter the order row unless its
 *  bytes hash, right now, to the hash the caller named. It does NOT by itself stop
 *  a repoint that happens AFTER a good pin and is never re-attached — for that the
 *  CONSUMER must re-materialize against the pinned hash, which is the delivery leg
 *  (3d·2). The pin is the anchor; the consumers enforce against it. Stated plainly
 *  so a later reader does not mistake the anchor for the whole fence.
 */

import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { verifySellerOrderArtifactPin } from '@recued/contracts';
import { createKernelAdapter } from '../kernel.js';

const mkCall = (slug: string, input: Record<string, unknown>) => ({
  slug,
  risk_tier: 'read' as const,
  input,
  output: {},
  manifest_version: 1,
});

const REF = `file:${'a'.repeat(32)}`;
const OTHER_REF = `file:${'b'.repeat(32)}`;

const sha256 = (bytes: string): string =>
  createHash('sha256').update(bytes).digest('hex');

const APPROVED_BYTES = 'the invoice the customer actually paid for';
const SWAPPED_BYTES = 'a completely different document';
const APPROVED_HASH = sha256(APPROVED_BYTES);
const SWAPPED_HASH = sha256(SWAPPED_BYTES);

/** A CAS the test can REPOINT — which is the whole attack. `record_id → bytes`,
 *  with `blob_hash` derived from the bytes exactly as the real `data.file` handler
 *  derives it. Mutating this map is a repoint. */
const cas = (initial: Record<string, string>) => {
  const files = new Map(Object.entries(initial));
  const dataFileRead = vi.fn(async ({ record_id }: { record_id: string }) => {
    const bytes = files.get(record_id);
    if (bytes === undefined) throw new Error(`no such record: ${record_id}`);
    return {
      record_id,
      bytes_b64: Buffer.from(bytes).toString('base64'),
      mime_type: 'application/pdf',
      filename: 'document.pdf',
      size_bytes: bytes.length,
      blob_hash: sha256(bytes),
    };
  });
  return { files, dataFileRead, repoint: (id: string, b: string) => files.set(id, b) };
};

const attachDispatcher = () =>
  vi.fn(async () => ({ result: 'updated' as const, order: {} as never }));

describe('D-207 slice 3d — a recipe may NAME the bytes, but never be BELIEVED about them', () => {
  /** NON-VACUITY. Every refusal below is meaningless if the two hashes coincide.
   *  Pin that there is genuinely a lie available to tell. */
  it('the fixture can actually express the lie it is testing for', () => {
    expect(APPROVED_HASH).not.toBe(SWAPPED_HASH);
    expect(APPROVED_HASH).toMatch(/^[0-9a-f]{64}$/);
    expect(SWAPPED_HASH).toMatch(/^[0-9a-f]{64}$/);
  });

  it('⛔ REFUSES a hash that does not match the bytes behind the ref', async () => {
    const { dataFileRead } = cas({ [REF]: APPROVED_BYTES });
    const sellerOrderAttachArtifact = attachDispatcher();
    const adapter = createKernelAdapter({ sellerOrderAttachArtifact, dataFileRead });

    await expect(
      adapter(
        mkCall('seller-order-attach-artifact', {
          order_key: 'ord:paid-doc:sub_1',
          expected_revision: 3,
          artifact_ref: REF,
          // The caller says these are the approved bytes. They are not.
          artifact_hash: SWAPPED_HASH,
        }),
      ),
    ).rejects.toMatchObject({ code: 'BAD_INPUT' });

    // Refused BEFORE the store could ever see it — the lie never reaches the row.
    expect(sellerOrderAttachArtifact).not.toHaveBeenCalled();
  });

  /** 🔴 THE ONE THE OLD CODE LET THROUGH. Nothing about the pin changes — same ref,
   *  same hash, so the one-way check is satisfied and the old store returned
   *  `unchanged`. But the BYTES moved underneath, so "unchanged" was a lie about
   *  the only thing anybody cared about. */
  it('⛔ REFUSES a re-attach whose ref was REPOINTED under it (same ref, same hash, different bytes)', async () => {
    const { dataFileRead, repoint } = cas({ [REF]: APPROVED_BYTES });
    const sellerOrderAttachArtifact = attachDispatcher();
    const adapter = createKernelAdapter({ sellerOrderAttachArtifact, dataFileRead });

    const pin = {
      order_key: 'ord:paid-doc:sub_1',
      expected_revision: 3,
      artifact_ref: REF,
      artifact_hash: APPROVED_HASH,
    };

    // The honest pin lands.
    await adapter(mkCall('seller-order-attach-artifact', pin));
    expect(sellerOrderAttachArtifact).toHaveBeenCalledTimes(1);

    // …and now the mutable record id is repointed at other bytes.
    repoint(REF, SWAPPED_BYTES);

    // The SAME call — byte-for-byte the same arguments — must now be refused.
    await expect(
      adapter(mkCall('seller-order-attach-artifact', pin)),
    ).rejects.toMatchObject({ code: 'BAD_INPUT' });
    expect(sellerOrderAttachArtifact).toHaveBeenCalledTimes(1);
  });

  it('⛔ REFUSES an unreadable artifact — never pins what it cannot prove', async () => {
    const { dataFileRead } = cas({ [OTHER_REF]: APPROVED_BYTES });
    const sellerOrderAttachArtifact = attachDispatcher();
    const adapter = createKernelAdapter({ sellerOrderAttachArtifact, dataFileRead });

    await expect(
      adapter(
        mkCall('seller-order-attach-artifact', {
          order_key: 'ord:paid-doc:sub_1',
          expected_revision: 3,
          artifact_ref: REF, // deleted / never existed
          artifact_hash: APPROVED_HASH,
        }),
      ),
    ).rejects.toMatchObject({ code: 'BAD_INPUT' });
    expect(sellerOrderAttachArtifact).not.toHaveBeenCalled();
  });

  /** Without a reader there is no way to prove the hash, so there is no way to pin
   *  honestly. Refusing beats pinning on faith and calling it verified. */
  it('⛔ REFUSES when there is no data.file reader at all, rather than pinning unverified', async () => {
    const sellerOrderAttachArtifact = attachDispatcher();
    const adapter = createKernelAdapter({ sellerOrderAttachArtifact });

    await expect(
      adapter(
        mkCall('seller-order-attach-artifact', {
          order_key: 'ord:paid-doc:sub_1',
          expected_revision: 3,
          artifact_ref: REF,
          artifact_hash: APPROVED_HASH,
        }),
      ),
    ).rejects.toMatchObject({ code: 'SERVER_NOT_REACHABLE' });
    expect(sellerOrderAttachArtifact).not.toHaveBeenCalled();
  });

  it('pins when the bytes really are what the caller named — and hands the store the VERIFIED carrier', async () => {
    const { dataFileRead } = cas({ [REF]: APPROVED_BYTES });
    const sellerOrderAttachArtifact = attachDispatcher();
    const adapter = createKernelAdapter({ sellerOrderAttachArtifact, dataFileRead });

    await adapter(
      mkCall('seller-order-attach-artifact', {
        order_key: 'ord:paid-doc:sub_1',
        expected_revision: 3,
        artifact_ref: REF,
        artifact_hash: APPROVED_HASH,
      }),
    );

    // The store never sees the caller's two loose strings — only the proven pin.
    expect(sellerOrderAttachArtifact).toHaveBeenCalledWith({
      order_key: 'ord:paid-doc:sub_1',
      expected_revision: 3,
      artifact: {
        backing: 'cas',
        record_id: REF,
        content_sha256: APPROVED_HASH,
      },
    });
    expect(dataFileRead).toHaveBeenCalledWith({ record_id: REF });
  });
});

describe('D-207 slice 3d — verifySellerOrderArtifactPin, the one implementation', () => {
  const reader = cas({ [REF]: APPROVED_BYTES }).dataFileRead;

  it.each([
    ['a ref that is not a data.file CAS id', 'cas://abc', APPROVED_HASH, 'malformed_ref'],
    ['a hash that is not a lowercase SHA-256', REF, 'sha256:abc', 'malformed_hash'],
    ['an uppercased hash', REF, APPROVED_HASH.toUpperCase(), 'malformed_hash'],
  ])('refuses %s', async (_label, artifact_ref, artifact_hash, reason) => {
    const result = await verifySellerOrderArtifactPin(
      { artifact_ref, artifact_hash },
      reader,
    );
    expect(result).toMatchObject({ ok: false, reason });
  });

  /** ⚠ The formats are owned by `isPinnedCasFileRef` — one guard, next to neither
   *  of the things it guards. The arc has now been bitten three times by a closed
   *  vocabulary copied beside what it protects; this is not a fourth. */
  it('produces a PinnedCasFileRef — the substrate carrier, not a second one', async () => {
    const result = await verifySellerOrderArtifactPin(
      { artifact_ref: REF, artifact_hash: APPROVED_HASH },
      reader,
    );
    expect(result).toEqual({
      ok: true,
      pin: { backing: 'cas', record_id: REF, content_sha256: APPROVED_HASH },
    });
  });
});
