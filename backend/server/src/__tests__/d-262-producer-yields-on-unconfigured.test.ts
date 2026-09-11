/** D-262 — an unconfigured source / spent cap YIELDS at the PRODUCER too.
 *
 *  ⛔⛔ THE RULE LIVED AT TWO ENDS AND ONLY ONE WAS WIDENED. `d-262-transcription-yield`
 *  covers the SCHEDULER: an error thrown out of a task step must not count
 *  toward the three-strike auto-disable. But the enrichment producer catches
 *  the same error INSIDE its per-record loop, and its catch runs FIRST — so the
 *  scheduler's copy of the classification never sees a per-record error at all.
 *
 *  With `AI_NO_TRANSCRIPTION_SOURCE` in the scheduler's set and not the
 *  producer's, every audio row took a `producer_failure` instead: backoff,
 *  escalation, and `permanently_failed` at attempt 5 with NO auto-retry. An
 *  owner who configured the slot on day four would find the rows dead — and
 *  the only thing that could have revived them is the call the missing
 *  configuration was refusing. The task stayed enabled, which is exactly why
 *  the scheduler-level test passes while the rows rot.
 *
 *  ⇒ Both ends now share `pool-unsatisfiable.js`. This file drives the end the
 *  other test cannot reach.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LLMError } from '@recued/llm';
import {
  buildEnrichmentProducerTask,
  type HousekeepingEnrichmentProducer,
} from '../housekeeping/enrichment-producer.js';
import type { HousekeepingContext } from '../housekeeping/registry.js';
import type { SourceCollectionWalker, SourceRecord } from '../housekeeping/source-walkers.js';
import { createEnrichmentStore, type EnrichmentStore } from '../storage/enrichment-store.js';
import type { CollectionRecord } from '@recued/contracts';

let dir: string;
let db: Database.Database;
let store: EnrichmentStore;
const now = 1_700_000_000_000;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd-262-prod-yield-'));
  db = new Database(join(dir, 'test.db'));
  db.pragma('journal_mode = WAL');
  store = createEnrichmentStore(db);
});

afterEach(() => {
  store.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const stubCtx = (): HousekeepingContext => ({
  db,
  bus: { emit: () => undefined, subscribe: () => () => undefined, dispose: () => undefined } as never,
  enrichmentStore: store,
  recipeStore: {} as never,
  now: () => now,
  emitAuditRow: () => undefined,
});

const record = (id: string): SourceRecord => ({
  target_id: id,
  data: {
    record_id: id,
    received_at: now,
    modified_at: now,
    hot_fields: {},
    size_bytes: 100,
    source_id: id,
  } as CollectionRecord,
  cursor_token: id,
});

const walker = (records: SourceRecord[]): SourceCollectionWalker => ({
  *walkAfter(cursor_token: string, batch_size: number) {
    let yielded = 0;
    for (const r of records) {
      if (r.cursor_token <= cursor_token) continue;
      if (yielded >= batch_size) return;
      yield r;
      yielded += 1;
    }
  },
  hashOf(r) { return `v1:${r.target_id}`; },
  fetchOne(target_id) { return records.find((r) => r.target_id === target_id) ?? null; },
});

const throwingProducer = (make: () => Error): HousekeepingEnrichmentProducer => ({
  topic: 'purpose',
  source_scope: 'mail',
  scope_read_declaration: [{ collection: 'data.mail', sample_field_paths: ['subject'] }],
  estimate_per_record_tokens: () => 0,
  async produce() { throw make(); },
});

const runStep = async (make: () => Error) => {
  const task = buildEnrichmentProducerTask({
    producer: throwingProducer(make),
    walker: walker([record('m1'), record('m2')]),
  });
  return task.step(stubCtx(), { kind: 'complete' }, 60_000);
};

/** Rows the producer left behind for this topic — a `producer_failure` writes
 *  one (that is how backoff is tracked); a yield must write none. */
const rowsFor = (): number =>
  (db.prepare(
    `SELECT COUNT(*) AS n FROM data_enrichment WHERE topic = 'purpose'`,
  ).get() as { n: number }).n;

describe('D-262 — the producer treats "cannot run yet" as a yield, not a per-row failure', () => {
  it('⛔ an unconfigured transcription source YIELDS and punishes no row', async () => {
    const result = await runStep(() => new LLMError(
      'AI_NO_TRANSCRIPTION_SOURCE',
      'No transcription source is configured.',
      {},
    ));
    expect(result.status).toBe('yield');
    expect(result).toMatchObject({ reason: 'pool_policy_unsatisfiable' });
    // ⛔ THE ASSERTION THAT MATTERS. A `producer_failure` writes a row to carry
    // the attempt count and the retry token; five of those and the row is
    // `permanently_failed` with no auto-retry. Nothing may be written here.
    expect(rowsFor()).toBe(0);
  });

  it('⛔ a spent daily cap does the same — it clears at 00:00 UTC on its own', async () => {
    const result = await runStep(() => new LLMError(
      'AI_TOKEN_BUDGET_EXCEEDED',
      'Transcription is over its daily limit (5/5 calls).',
      {},
    ));
    expect(result.status).toBe('yield');
    expect(rowsFor()).toBe(0);
  });

  it('⛔⛔ AND REPEATED CYCLES NEVER ESCALATE — five of them still leave the rows clean', async () => {
    // The consequence, driven rather than reasoned. Five is the escalation
    // threshold: at attempt 5 a failing row becomes `permanently_failed` and
    // stops being retried, so an owner configuring the slot afterwards finds
    // it already given up on them.
    for (let i = 0; i < 5; i += 1) {
      const r = await runStep(() => new LLMError('AI_NO_TRANSCRIPTION_SOURCE', 'not configured', {}));
      expect(r.status).toBe('yield');
    }
    expect(rowsFor()).toBe(0);
  });

  // ⚠ `AI_LLM_UNAVAILABLE` IS DELIBERATELY *NOT* IN THIS FILE'S YIELD SET, AND
  // THAT IS D-136 P6, NOT AN OVERSIGHT. A FORCED layer that cannot be satisfied
  // yields (the harness imposed the constraint); layer `'any'` — `free_then_byok`
  // — is a per-row failure, because the resolver was free to try free THEN byok
  // and still found nothing. `d-132-phase-2-scheduler.test.ts` asserts both.
  //
  // ⛔⛔ I "FIXED" THIS ON 2026-09-07 AND WAS WRONG. It looks identical to the bug
  // above — same escalation to `permanently_failed`, same dead rows after the
  // owner configures AI — so I widened the condition and proved it by mutation.
  // The mutation only reddened MY OWN two files, which is precisely why it read
  // as safe: run wide enough and `d-132` fails immediately. ⇒ A mutation proof is
  // only as broad as the files you re-run, and "0 red" across a narrow set is not
  // evidence of anything.
  //
  // ⬜ Genuinely uncovered (checked 2026-09-07): `AI_LLM_UNAVAILABLE` at a FORCED
  // layer whose `details.forceLayer` DISAGREES with the harness's must stay a
  // per-row failure. Nothing asserts that mismatch branch.
  it('⚠ and an LLMError that is NOT in the shared set is still a per-row failure', async () => {
    // ⚠ `AI_TIMEOUT` is a REAL member of the code union — the first draft used
    // `AI_RATE_LIMITED`, which is not one, and vitest ran it green because it
    // strips types. `typecheck:tests` is the only gate that reads test files.
    const result = await runStep(() => new LLMError('AI_TIMEOUT', 'took too long', {}));
    expect(result.status).not.toBe('yield');
    expect(rowsFor()).toBeGreaterThan(0);
  });
});
