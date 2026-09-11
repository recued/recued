/** D-139 § A.9.2b — `out_of_band_engagement` actually produces.
 *
 *  The last of the twelve D-139 topics to get a producer, and the one that
 *  most needed a seam test rather than a kernel test: its kernel was correct
 *  and unit-tested the whole time, while one of its two matchers had no join
 *  key in production (`meta.subject_hash`, unwritten until ec8f55872) and the
 *  other compared a bracketed CRM header against a stripped mail id.
 *
 *  So these assertions are about the JOIN and the SEAM:
 *    - a real `collection_mail_*` row and a real CRM engagement row that are
 *      the SAME message do not get reported as a gap
 *    - one that genuinely never reached the CRM does
 *    - and an unwired substrate writes NOTHING rather than a confident zero */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  type EngagementsForRecordArgs,
  composePlatformRecordTargetId,
  engagementSubjectHash,
  type EngagementRow,
  type EnrichmentScope,
  type OutOfBandEngagementValue,
} from '@recued/contracts';

import { createEngagementStore, type EngagementStore } from '../storage/engagement-store.js';
import { createEnrichmentStore, type EnrichmentStore } from '../storage/enrichment-store.js';
import { buildRecordEngagementsDeps, type EngagementsResolverDepsInput } from '../engagement-resolver-deps.js';
import { outOfBandEngagementTask } from '../housekeeping/engagement-aggregates/out-of-band-task.js';
import { STANDALONE_TASKS } from '../housekeeping/registration.js';
import type { HousekeepingContext } from '../housekeeping/registry.js';

const NOW = 1_800_000_000_000;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const SCOPE = 'connection.api.hubspot.deal' as EnrichmentScope;
const DEAL = composePlatformRecordTargetId('hubspot', 'deal', 'acme-hubspot', '47291');
const REP = 'rep@recued.com';
const BUYER = 'buyer@acme.com';

let dir: string;
let db: Database.Database;
let enrichmentStore: EnrichmentStore;
let engagementStore: EngagementStore;

const fakeConnectionStore = (): EngagementsResolverDepsInput['connectionStore'] =>
  ({ list: () => [] }) as unknown as EngagementsResolverDepsInput['connectionStore'];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd139-oob-'));
  db = new Database(join(dir, 'test.db'));
  enrichmentStore = createEnrichmentStore(db);
  engagementStore = createEngagementStore(db);
  // A real `data.mail` account table — same name shape the collection layer
  // creates, so `listCollectionDataTables` finds it.
  const slug = createHash('sha256').update('work').digest('hex').slice(0, 10);
  db.exec(`CREATE TABLE collection_mail_${slug} (
    record_id TEXT PRIMARY KEY, received_at INTEGER NOT NULL, modified_at INTEGER NOT NULL,
    hot_fields TEXT NOT NULL, size_bytes INTEGER NOT NULL, source_id TEXT NOT NULL,
    body_inline TEXT, blob_hash TEXT);`);
  (globalThis as { __mailTable?: string }).__mailTable = `collection_mail_${slug}`;
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const seedDeal = (): void => {
  db.prepare(
    `INSERT INTO data_enrichment (_id, topic, scope, target_id, authored_by, ingested_at, authored_at, meta)
     VALUES (?,?,?,?,?,?,?,?)`,
  ).run(`seed:${DEAL}`, 'lifecycle_stage_inferred', SCOPE, DEAL, 'seed', NOW, NOW,
    // `snapshot_hash` is REQUIRED on a platform-reference meta snapshot —
    // omitting it makes the upsert throw `meta_snapshot_invalid`, which the
    // cycle's per-record catch then swallows into a silent `skipped`.
    JSON.stringify({ snapshot_at: NOW, snapshot_hash: `h:${DEAL}`, dealname: 'Acme Q4' }));
};

/** An outbound mail in the owner's mailbox. */
const seedMail = (
  id: string,
  over: { subject?: string; sent_at?: number; rfc_message_id?: string | null; direction?: string; to?: string[] } = {},
): void => {
  const table = (globalThis as { __mailTable?: string }).__mailTable!;
  const hot: Record<string, unknown> = {
    from: REP,
    to: over.to ?? [BUYER],
    cc: [],
    subject: over.subject ?? 'Q4 planning',
    direction: over.direction ?? 'outbound',
    message_id: `provider-${id}`,
  };
  if (over.rfc_message_id !== null) hot.rfc_message_id = over.rfc_message_id ?? `rfc-${id}`;
  const at = over.sent_at ?? NOW - 2 * DAY;
  db.prepare(
    `INSERT INTO ${table} (record_id, received_at, modified_at, hot_fields, size_bytes, source_id)
     VALUES (?,?,?,?,?,?)`,
  ).run(id, at, at, JSON.stringify(hot), 100, id);
};

/** A CRM email engagement, plus the contact + deal edges that hang it off
 *  the deal. `subject_hash` is stamped with the SAME function the reconcilers
 *  use — not a literal — so the fixture cannot drift from production. */
const seedCrmEmail = (
  id: string,
  over: { subject?: string; sent_at?: number; message_id?: string } = {},
): void => {
  const sent = over.sent_at ?? NOW - 2 * DAY;
  const subject = over.subject ?? 'Q4 planning';
  const row: EngagementRow = {
    connection_id: 'acme-hubspot', target_id: id, vendor: 'hubspot', entity: 'email',
    meta: {
      from_email: REP, to_emails: [BUYER], subject,
      subject_hash: engagementSubjectHash(subject), timestamp: sent,
      ...(over.message_id !== undefined ? { message_id: over.message_id } : {}),
    },
    mirror_blob_hash: null, authorship: 'user', direction: 'outbound',
    dedupe_confidence: 'none', lifecycle_state: 'completed',
    event_at: sent, vendor_created_at: sent, vendor_modified_at: sent,
    ingested_at: NOW, body_state: 'none',
  };
  engagementStore.upsert({ row });
  engagementStore.upsertEdge({
    connection_id: 'acme-hubspot', engagement_target_id: id, edge_type: 'deal',
    target_kind: 'connection.api', target_id: DEAL, vendor: 'hubspot', created_at: NOW,
  });
  engagementStore.upsertEdge({
    connection_id: 'acme-hubspot', engagement_target_id: id, edge_type: 'contact',
    target_kind: 'data.contact', target_id: BUYER, vendor: 'hubspot', created_at: NOW,
    resolveContactRedirect: () => null,
  });
};

const makeCtx = (over: Partial<HousekeepingContext> = {}): HousekeepingContext => {
  const recordDeps = buildRecordEngagementsDeps({
    db, contactStore: { get: () => null, addressSet: () => [] } as never,
    connectionStore: fakeConnectionStore(), now: () => NOW,
  });
  return {
    db, bus: { emit: () => undefined, subscribe: () => () => undefined, dispose: () => undefined },
    enrichmentStore, recipeStore: {}, now: () => NOW, emitAuditRow: () => undefined,
    resolveRecordEngagements: (args: EngagementsForRecordArgs) => engagementStore.resolveEngagementsForRecord(args, recordDeps(args)),
    listDealContacts: (dealId: string, limit: number) => engagementStore.listDealCounterpartyContactEmails(dealId, limit),
    ...over,
  } as unknown as HousekeepingContext;
};

const value = (): OutOfBandEngagementValue | undefined =>
  enrichmentStore.list({
    topic: 'out_of_band_engagement', scope: SCOPE, target_id: DEAL,
    authored_by: 'system.housekeeping.out_of_band_engagement', limit: 1,
  })[0]?.value as OutOfBandEngagementValue | undefined;

describe('D-139 § A.9.2b — registration', () => {
  it('is in STANDALONE_TASKS and is deterministic', async () => {
    expect(STANDALONE_TASKS.map((t) => t.meta.id)).toContain('enrichment.out_of_band_engagement');
    expect(outOfBandEngagementTask.is_ai_surface).toBe(false);
    expect(outOfBandEngagementTask.topic).toBe('out_of_band_engagement');
  });
});

describe('D-139 § A.9.2b — the join suppresses mail the CRM already has', () => {
  it('a Message-ID match is NOT a gap — even bracketed on the CRM side', async () => {
    seedDeal();
    seedMail('m1', { rfc_message_id: 'abc@host' });
    // ⛔ The CRM stores the header VERBATIM. If the index did not normalise,
    // this would read as a gap despite being the same message.
    seedCrmEmail('crm1', { message_id: '<abc@host>' });

    await outOfBandEngagementTask.step(makeCtx(), { kind: 'complete' }, 5_000);
    expect(value()?.out_of_band_count).toBe(0);
  });

  it('a quadruple match is NOT a gap — the CRM row carries no Message-ID', async () => {
    seedDeal();
    seedMail('m1', { rfc_message_id: null });
    seedCrmEmail('crm1');

    await outOfBandEngagementTask.step(makeCtx(), { kind: 'complete' }, 5_000);
    // ⛔ This is the case that was broken: with no `subject_hash` on the CRM
    // side the fallback could never fire, and this mail would have been
    // reported as work the CRM is missing.
    expect(value()?.out_of_band_count).toBe(0);
  });
});

describe('D-139 § A.9.2b — a genuine gap IS reported', () => {
  it('mail with no CRM counterpart counts, and dates the latest', async () => {
    seedDeal();
    seedMail('m1', { subject: 'Contract redlines', sent_at: NOW - 3 * DAY, rfc_message_id: 'nope@host' });
    seedCrmEmail('crm1'); // a DIFFERENT message — establishes the contact edge

    await outOfBandEngagementTask.step(makeCtx(), { kind: 'complete' }, 5_000);
    const v = value();
    expect(v?.out_of_band_count).toBe(1);
    expect(v?.latest_unmatched_at).toBe(NOW - 3 * DAY);
    expect(v?.confidence_gate_passed).toBe(true);
  });

  it('mail inside the 30-minute grace window is not yet a gap', async () => {
    seedDeal();
    seedMail('m1', { subject: 'Just sent', sent_at: NOW - 5 * 60 * 1000, rfc_message_id: 'fresh@host' });
    seedCrmEmail('crm1');

    await outOfBandEngagementTask.step(makeCtx(), { kind: 'complete' }, 5_000);
    // CRM logging is async — flagging immediately would report a gap that
    // closes itself minutes later.
    expect(value()?.out_of_band_count).toBe(0);
  });

  it('a DRAFT is not outbound mail — it was never sent', async () => {
    seedDeal();
    seedMail('m1', { subject: 'Unsent draft', direction: 'draft', rfc_message_id: 'draft@host' });
    seedCrmEmail('crm1');

    await outOfBandEngagementTask.step(makeCtx(), { kind: 'complete' }, 5_000);
    // The CRM is RIGHT to have no record of a draft.
    expect(value()?.out_of_band_count).toBe(0);
  });
});

describe('D-139 § A.9.2b — the limits it is honest about', () => {
  it('a SUBJECT-LESS mail is dropped, even when it is a genuine gap', () => {
    // ⚠ Pinned as a KNOWN under-report, not an accident. Without a subject
    // there is no fallback key, and passing `null` through would make the
    // kernel compare null-against-null on CRM rows that also lack one —
    // matching every subject-less mail to every subject-less CRM row and
    // SUPPRESSING real gaps at scale. Losing the rare subject-less mail
    // beats silently muting a whole class.
    //
    // ⛔ Mutation-measured: deleting the guard left the rest of this suite
    // green, so this case is the only thing holding the choice in place. If
    // the trade is ever revisited, this assertion should FLIP, not vanish.
    seedDeal();
    seedMail('m1', { subject: '', rfc_message_id: 'nosubject@host' });
    seedCrmEmail('crm1');
    return outOfBandEngagementTask.step(makeCtx(), { kind: 'complete' }, 5_000).then(() => {
      expect(value()?.out_of_band_count).toBe(0);
    });
  });
});

describe('D-139 § A.9.2b — the no-op posture', () => {
  it('no contact reader ⇒ writes NOTHING, not a confident zero', async () => {
    seedDeal();
    seedMail('m1', { rfc_message_id: 'nope@host' });
    seedCrmEmail('crm1');
    const ctx = makeCtx();
    delete (ctx as { listDealContacts?: unknown }).listDealContacts;

    await outOfBandEngagementTask.step(ctx, { kind: 'complete' }, 5_000);
    // ⛔ Without the contact reader every deal resolves an EMPTY contact set,
    // every mail lookup misses, and the kernel would return
    // `out_of_band_count: 0` — "no visibility gap" from having not looked.
    expect(value()).toBeUndefined();
  });

  it('no engagement resolver ⇒ writes NOTHING', async () => {
    seedDeal();
    const ctx = makeCtx();
    delete (ctx as { resolveRecordEngagements?: unknown }).resolveRecordEngagements;
    await outOfBandEngagementTask.step(ctx, { kind: 'complete' }, 5_000);
    expect(value()).toBeUndefined();
  });
});
