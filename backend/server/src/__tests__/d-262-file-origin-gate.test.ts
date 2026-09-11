/** D-262 § B12.2 — a stranger's reception drop must not spend the owner's tokens.
 *
 *  ⛔ THE EXPOSURE THIS CLOSES WAS LIVE, AND IT DID NOT ARRIVE AS A CALL. Every
 *  external DOOR was checked and none accepted voice — no MCP chat tool exists,
 *  the `llm_gateway` rejects non-text content parts, `upload.` is MCP-reserved.
 *  But `reception_drop` is the open-visitor path: anyone with a public intake
 *  link puts a file in the warehouse, and the file-scoped AI producers selected
 *  on `media_class` and NOTHING ELSE. The external input arrives as DATA, which
 *  is why enumerating callers misses it.
 *
 *  ⚠ What held it back was `default_trust_state: 'manual'` — a gate D-132's
 *  promotion banner nudges owners past at three manual runs. So it was latent,
 *  not safe.
 *
 *  🔑 THE RATCHET IS THE POINT. Fixing three producers by hand has no
 *  completion criterion: a fourth file-scoped AI producer would simply not call
 *  the gate, and nothing would say so. This derives the requirement from the
 *  registration table instead, so the test fails the day someone adds one.
 */

import { describe, expect, it, vi } from 'vitest';

import { PER_RECORD_PRODUCERS } from '../housekeeping/registration.js';
import { mayAiEnrichFile, fileOriginOf } from '../housekeeping/producers/_file-media.js';
import type { HousekeepingContext } from '../housekeeping/registry.js';
import type { SourceRecord } from '../housekeeping/source-walkers.js';

/** ⛔ A FULLY PROCESSABLE RECORD, and the `storage_ref` is the load-bearing
 *  part. The first cut of this fixture omitted it — so every producer returned
 *  null at `fetchCasFileBytes` (no CAS hash) rather than at the origin gate, and
 *  a MUTATION that deleted the gate entirely left the suite green. The test
 *  passed for a reason that had nothing to do with what it claimed to check.
 *  ⇒ Everything here must look exactly like a file the producer WOULD enrich,
 *  so provenance is the only thing left that can stop it. */
const fileRecord = (origin: string, media_class: string) => ({
  record_id: 'file:deadbeef',
  storage_ref: { kind: 'cas', blob_hash: 'a'.repeat(64) },
  blob_hash: 'a'.repeat(64),
  hot_fields: { origin, media_class, mime_type: 'audio/ogg', filename: 'note.ogg' },
} as never);

const sourceRec = (origin: string, media_class: string): SourceRecord<never> => ({
  id: 'file:deadbeef',
  data: fileRecord(origin, media_class),
} as never);

/** A context whose every AI capability throws: reaching ANY of them is the
 *  failure, so the assertion does not depend on which one a producer would
 *  have used. */
const explodingCtx = (): HousekeepingContext => ({
  db: {} as never,
  bus: {} as never,
  enrichmentStore: {} as never,
  recipeStore: {} as never,
  now: () => 1_700_000_000_000,
  emitAuditRow: () => undefined,
  blobs: {
    get: () => { throw new Error('read the bytes of a stranger file'); },
    getFile: () => { throw new Error('read the bytes of a stranger file'); },
  },
  llm: () => { throw new Error('spent tokens on a stranger file'); },
  llmWithMeta: () => { throw new Error('spent tokens on a stranger file'); },
  embed: () => { throw new Error('spent tokens on a stranger file'); },
  transcribe: () => { throw new Error('spent tokens on a stranger file'); },
} as never);

const fileAiProducers = PER_RECORD_PRODUCERS
  .filter((e) => e.walker_kind === 'file')
  .map((e) => e.producer)
  .filter((p) => p.estimate_per_record_tokens() > 0);

describe('D-262 § B12.2 — the file-origin gate', () => {
  it('finds the file-scoped AI producers from the registration table, not a hand-written list', () => {
    // If this is 0 the rest of the file is vacuous — the filter would pass
    // every producer without ever exercising one.
    expect(fileAiProducers.length).toBeGreaterThanOrEqual(3);
  });

  for (const producer of fileAiProducers) {
    it(`⛔ '${producer.topic}' refuses a reception_drop without touching an AI capability`, async () => {
      const ctx = explodingCtx();
      // Its OWN media class, so the producer cannot decline for the boring
      // reason — this file is exactly what it looks for, except for provenance.
      const mediaClass = producer.topic === 'transcript'
        ? 'voice'
        : producer.topic === 'caption' ? 'image' : 'document';
      const result = await producer.produce(ctx, sourceRec('reception_drop', mediaClass));
      expect(result).toBeNull();
    });
  }
});

describe('D-262 § B12.2 — the allowlist itself', () => {
  it('admits the origins that are the owner acting, in one form or another', () => {
    for (const origin of [
      'webclient_upload', 'messenger_media', 'mail_attachment',
      'tool_output', 'connection_download',
    ]) {
      expect(mayAiEnrichFile(fileRecord(origin, 'voice'))).toBe(true);
    }
  });

  it('⛔ refuses the open-visitor path', () => {
    expect(mayAiEnrichFile(fileRecord('reception_drop', 'voice'))).toBe(false);
  });

  it('⛔ FAILS CLOSED on an origin nobody has thought of yet', () => {
    // The reason this is an allowlist. A denylist would hand AI spend to the
    // next ingestion path someone builds, and its author would have no reason
    // to look at this file.
    expect(mayAiEnrichFile(fileRecord('some_future_public_intake', 'voice'))).toBe(false);
  });

  it('⛔ FAILS CLOSED on a record with no origin at all', () => {
    // A record whose provenance cannot be read is not a record whose
    // provenance is safe.
    expect(mayAiEnrichFile({ record_id: 'f', hot_fields: {} } as never)).toBe(false);
    expect(fileOriginOf({ record_id: 'f', hot_fields: {} } as never)).toBeNull();
  });
});
