/** D-167 — multi-record fan-in AI-egress PII aliasing (L3 residual).
 *
 *  The single-record seam (`wrapHousekeepingCtxForRecord`) seeds the alias
 *  ledger from ONE structured record. Fan-in producers fold their `llm.data`
 *  corpus across MANY source rows, so the PII that egresses lives across N
 *  records — a per-record seed can't cover it. This file pins the fan-in seam
 *  (`wrapHousekeepingCtxForFanIn`) two ways:
 *
 *    A. Directly — proving the load-bearing property a single-record seam
 *       lacks: a value structured ONLY in record A is aliased where it surfaces
 *       in a blob that also carries record B's data (identifier pass runs over
 *       all seeds before any content scan), and the model output restores to
 *       real values.
 *    B. Through the live `topic_cluster` producer — the corpus the cloud /
 *       free-pool model sees carries aliases while the persisted cluster labels
 *       (the warehouse row) carry the restored real values. Plus the dormant
 *       no-op (byte-identical to pre-D-167 until a privacy-tagged mail schema is
 *       installed).
 *
 *  Spec: D-167 §"Runtime flow", §"Scope", §Hard invariant.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { EnrichmentScope, IngredientManifest, PiiFieldTag } from '@recued/contracts';

import { wrapHousekeepingCtxForFanIn } from '../housekeeping/enrichment-pii-egress.js';
import { runTopicClusterCycle, TOPIC_CLUSTER_TOPIC } from '../housekeeping/index.js';
import type { HousekeepingContext } from '../housekeeping/registry.js';
import { ensureHousekeepingSchema } from '../housekeeping/schema.js';
import { createEnrichmentStore, type EnrichmentStore } from '../storage/enrichment-store.js';

const NOW = 1_700_000_000_000;
const ONE_HOUR = 60 * 60 * 1000;
const MANIFEST = {} as IngredientManifest;

/** Tags a mail-shaped record's sender email + display name. Mirrors the
 *  privacy tags a real installed mail schema would carry for `data.mail`. */
const mailTagSource = (scope: EnrichmentScope): readonly PiiFieldTag[] =>
  scope === 'mail'
    ? [
        { path: 'from', kind: 'email' },
        { path: 'from_name', kind: 'name' },
      ]
    : [];

// ────────────────────────────────────────────────────────────────
// A. wrapHousekeepingCtxForFanIn — direct
// ────────────────────────────────────────────────────────────────

/** A minimal ctx carrying only the fields the wrap reads. */
const makeCtx = (over: Partial<HousekeepingContext> = {}): HousekeepingContext =>
  ({
    enrichmentPiiTagSource: mailTagSource,
    ...over,
  }) as unknown as HousekeepingContext;

describe('D-167 fan-in seam — wrapHousekeepingCtxForFanIn', () => {
  it('seeds ONE ledger from MANY records — a value structured only in record A is aliased where it surfaces alongside record B', async () => {
    const egress: Array<Record<string, unknown>> = [];
    const llmWithMeta = vi.fn(async (_m: IngredientManifest, input: Record<string, unknown>) => {
      egress.push(input);
      // The model echoes the (aliased) corpus it was shown into its output.
      return { result: { echo: String(input['llm.data']) }, model_id: 'prov:m' };
    });
    const ctx = makeCtx({ llmWithMeta });

    // Record A carries alice's identifiers, record B carries bob's. The corpus
    // blob (folded downstream from BOTH) mentions BOTH — a single-record seam
    // seeded from only one row would leak the other person's PII.
    const records = [
      { from: 'alice@acme.com', from_name: 'Alice Chen' },
      { from: 'bob@globex.com', from_name: 'Bob Lee' },
    ];
    const wrapped = wrapHousekeepingCtxForFanIn(ctx, 'mail', records);
    const out = await wrapped.llmWithMeta!(MANIFEST, {
      'llm.data': 'Thread: Alice Chen (alice@acme.com) replied to Bob Lee (bob@globex.com)',
    });

    // Egress: NEITHER person's real identifiers reached the model.
    const sent = String(egress[0]?.['llm.data']);
    expect(sent).not.toContain('Alice Chen');
    expect(sent).not.toContain('Bob Lee');
    expect(sent).not.toContain('alice@acme.com');
    expect(sent).not.toContain('bob@globex.com');
    expect(sent).toMatch(/Person\d/);
    expect(sent).toMatch(/m\d+@d\d+\.invalid/);

    // Restore: the producer-visible output carries the REAL values again.
    const echo = (out.result as { echo: string }).echo;
    expect(echo).toContain('Alice Chen');
    expect(echo).toContain('Bob Lee');
    expect(echo).toContain('alice@acme.com');
    expect(echo).toContain('bob@globex.com');
    expect(echo).not.toMatch(/Person\d/);
    expect(echo).not.toMatch(/m\d+@d\d+\.invalid/);
    expect(out.model_id).toBe('prov:m');
  });

  it('is a no-op (returns the same ctx) when no record carries a tagged value', () => {
    const ctx = makeCtx({ llm: vi.fn() });
    expect(
      wrapHousekeepingCtxForFanIn(ctx, 'mail', [{ unrelated: 'x' }, { also: 'y' }]),
    ).toBe(ctx);
  });

  it('is a no-op for an empty records list', () => {
    const ctx = makeCtx({ llm: vi.fn() });
    expect(wrapHousekeepingCtxForFanIn(ctx, 'mail', [])).toBe(ctx);
  });

  it('is a no-op when no tag source is wired', () => {
    const ctx = makeCtx({ enrichmentPiiTagSource: undefined, llm: vi.fn() });
    expect(wrapHousekeepingCtxForFanIn(ctx, 'mail', [{ from: 'a@b.com' }])).toBe(ctx);
  });
});

// ────────────────────────────────────────────────────────────────
// B. topic_cluster — the live fan-in producer
// ────────────────────────────────────────────────────────────────

const MAIL_TABLE = 'collection_mail_55555555ee';

let dir: string;
let db: Database.Database;
let store: EnrichmentStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd-167-fanin-pii-'));
  db = new Database(join(dir, 'test.db'));
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${MAIL_TABLE} (
      record_id   TEXT PRIMARY KEY,
      received_at INTEGER NOT NULL,
      modified_at INTEGER NOT NULL,
      hot_fields  TEXT NOT NULL,
      size_bytes  INTEGER NOT NULL,
      source_id   TEXT NOT NULL,
      body_inline TEXT,
      blob_hash   TEXT
    );
  `);
  store = createEnrichmentStore(db);
  ensureHousekeepingSchema(db);
});

afterEach(() => {
  store.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

interface InsertedMail {
  record_id: string;
  thread_id: string;
  subject: string;
  from: string;
  from_name: string;
  received_at: number;
}

const insertMail = (m: InsertedMail): void => {
  const hot = {
    subject: m.subject,
    thread_id: m.thread_id,
    from: m.from,
    from_name: m.from_name,
    to: [],
    cc: [],
  };
  db.prepare(
    `INSERT INTO ${MAIL_TABLE} (
       record_id, received_at, modified_at, hot_fields,
       size_bytes, source_id, body_inline, blob_hash
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(m.record_id, m.received_at, m.received_at, JSON.stringify(hot), 100, m.record_id, null, null);
};

const mkCtx = (over: {
  llmWithMeta: HousekeepingContext['llmWithMeta'];
  enrichmentPiiTagSource?: HousekeepingContext['enrichmentPiiTagSource'];
}): HousekeepingContext =>
  ({
    db,
    bus: { emit: () => undefined, subscribe: () => () => undefined, dispose: () => undefined },
    enrichmentStore: store,
    recipeStore: {},
    now: () => NOW,
    emitAuditRow: () => undefined,
    llmWithMeta: over.llmWithMeta,
    ...(over.enrichmentPiiTagSource
      ? { enrichmentPiiTagSource: over.enrichmentPiiTagSource }
      : {}),
  }) as unknown as HousekeepingContext;

// Two threads sharing tokens "q4 / renewal / sync" → one cluster of 2 threads.
// Record m1 STRUCTURALLY carries "Alice Chen"; m2's SUBJECT mentions her by
// name. Only a fan-in seed (seeding the ledger from m1) aliases "Alice Chen"
// where it surfaces in m2's subject — a single-record seam seeded from m2
// alone (whose sender is Bob) would ship her name raw to the model.
const seedTwoThreadCluster = (): void => {
  insertMail({
    record_id: 'm1',
    thread_id: 't1',
    subject: 'Q4 renewal sync notes',
    from: 'alice@acme.com',
    from_name: 'Alice Chen',
    received_at: NOW - ONE_HOUR,
  });
  insertMail({
    record_id: 'm2',
    thread_id: 't2',
    subject: 'Q4 renewal sync with Alice Chen',
    from: 'bob@globex.com',
    from_name: 'Bob Lee',
    received_at: NOW,
  });
};

describe('D-167 fan-in seam — topic_cluster producer', () => {
  it('aliases the labelling corpus on egress and persists RESTORED cluster labels', async () => {
    seedTwoThreadCluster();

    const egress: Array<Record<string, unknown>> = [];
    const llmWithMeta = vi.fn(async (_m: IngredientManifest, input: Record<string, unknown>) => {
      egress.push(input);
      // Label the (single) cluster, echoing the aliased corpus into the summary
      // so restore has aliases to map back on the producer side.
      return {
        result: {
          labels: [
            {
              cluster_index: 0,
              topic_name: 'Renewal',
              summary: `Re: ${String(input['llm.data'])}`,
            },
          ],
        },
        model_id: 'prov:topic-model',
      };
    });
    const ctx = mkCtx({ llmWithMeta, enrichmentPiiTagSource: mailTagSource });

    const { produced } = await runTopicClusterCycle(ctx);
    expect(produced).toBe(1);
    expect(llmWithMeta).toHaveBeenCalledOnce();

    // Egress: the model never saw the full name verbatim (the cross-record seed
    // from m1 aliased it where it appears in m2's subject). The tokenised
    // "Top tokens" line still carries lowercase fragments ("alice", "chen") —
    // an inherent comfort miss of the pre-tokenised corpus, not a full-
    // identifier leak; we assert on the verbatim identifier the seam protects.
    const corpus = String(egress[0]?.['llm.data']);
    expect(corpus).not.toContain('Alice Chen');
    expect(corpus).toMatch(/Person\d/);

    // Persisted warehouse row: the cluster label carries RESTORED real values.
    const rows = store.list({ topic: TOPIC_CLUSTER_TOPIC, fresh_only: false, limit: 10 });
    expect(rows).toHaveLength(1);
    const value = rows[0]!.value as { summary: string; topic_name: string };
    expect(value.summary).toContain('Alice Chen');
    expect(value.summary).not.toMatch(/Person\d/);
    expect(rows[0]!.model_id).toBe('prov:topic-model');
  });

  it('does NOT seed the ledger from a scanned-but-dropped record (no unrelated-PII restore)', async () => {
    // m1 + m2 cluster as before (Alice/Bob renewal). m3 is a single-thread
    // "noise" record (`clusterThreads` drops it below MIN_THREADS_PER_CLUSTER),
    // so its subject NEVER reaches the corpus — but it was still scanned. m3 is
    // OLDEST so under the rejected "seed every scanned row" approach its sender
    // "Zoe Quinn" would have been allocated `pii.Person3` (Bob=pii.Person1, Alice=
    // pii.Person2, Zoe=pii.Person3, newest-first). The model then emits that alias
    // literal. With per-corpus seeding Zoe is NOT in the ledger, so `pii.Person3`
    // stays un-restored and her real name can't bleed into a cluster label.
    seedTwoThreadCluster();
    insertMail({
      record_id: 'm3',
      thread_id: 't3',
      subject: 'Standalone lunch invite xyzzy',
      from: 'zoe@initech.com',
      from_name: 'Zoe Quinn',
      received_at: NOW - 2 * ONE_HOUR,
    });

    const llmWithMeta = vi.fn(async (_m: IngredientManifest, _input: Record<string, unknown>) => ({
      // Model hallucinates an alias-shaped literal for the dropped record.
      result: {
        labels: [
          { cluster_index: 0, topic_name: 'Renewal', summary: 'Renewal thread; see pii.Person3 elsewhere.' },
        ],
      },
      model_id: 'prov:m',
    }));
    const ctx = mkCtx({ llmWithMeta, enrichmentPiiTagSource: mailTagSource });

    const { produced } = await runTopicClusterCycle(ctx);
    expect(produced).toBe(1);

    const rows = store.list({ topic: TOPIC_CLUSTER_TOPIC, fresh_only: false, limit: 10 });
    expect(rows).toHaveLength(1);
    const value = rows[0]!.value as { summary: string };
    // The dropped record's real PII never entered the ledger → never restored.
    expect(value.summary).not.toContain('Zoe Quinn');
    // The hallucinated alias passes through unchanged (proves Zoe was unseeded).
    expect(value.summary).toContain('pii.Person3');
  });

  it('egresses the corpus raw when no tag source is wired (dormant no-op)', async () => {
    seedTwoThreadCluster();

    const egress: Array<Record<string, unknown>> = [];
    const llmWithMeta = vi.fn(async (_m: IngredientManifest, input: Record<string, unknown>) => {
      egress.push(input);
      return {
        result: { labels: [{ cluster_index: 0, topic_name: 'Renewal', summary: 'ok' }] },
        model_id: 'prov:m',
      };
    });
    const ctx = mkCtx({ llmWithMeta }); // no enrichmentPiiTagSource → wrap is a no-op

    await runTopicClusterCycle(ctx);

    const corpus = String(egress[0]?.['llm.data']);
    // Byte-identical to pre-D-167: the real name reaches the model untouched.
    expect(corpus).toContain('Alice Chen');
    expect(corpus).not.toMatch(/Person\d/);
  });
});
