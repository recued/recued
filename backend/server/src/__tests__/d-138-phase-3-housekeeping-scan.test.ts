/** D-138 Phase 3 — housekeeping scan + cycle observer + prompt store
 *  + scan_now rpc tests.
 *
 *  Covers:
 *    - `contact-merge-candidate-scan` task delta-scans contacts
 *      modified since `cursor.last_seen_at`
 *    - Idempotent re-runs (pair_key UNIQUE)
 *    - Rejection pre-filter blocks re-surfacing
 *    - Bus emits per surfaced candidate + per-stride progress emit
 *    - Prompt store persists + resolves prompts
 *    - Cycle observer fires prompts for plausibility-matched
 *      rejected pairs inside one cycle window
 *    - Cycle observer is a no-op outside an active cycle
 *      (between-cycle deletes don't trigger A.10 prompts per spec
 *      § A.10 Reviewer #11)
 *    - Contact store fires `onPlatformLinkChanged` on link / unlink
 *    - `contact.merge.scan_now` rpc dispatches via `runScanNow`
 *      closure with mode = delta | full
 *    - `contact.merge.scan_now` surfaces `not_configured` when
 *      `runScanNow` is absent */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CONTACT_MERGE_CANDIDATE_SCAN_TASK_ID } from '@recued/contracts';

import type { HousekeepingContext } from '../housekeeping/registry.js';

import {
  createContactStore,
  type ContactStore,
  type PlatformLinkChange,
} from '../storage/contact-store.js';
import {
  buildContactMergeCandidateScanTask,
  CONTACT_MERGE_SCAN_BATCH_SIZE,
} from '../housekeeping/tasks/contact-merge-candidate-scan.js';
import { createRemergePromptStore } from '../contact-merge-prompt-store.js';
import { createContactMergeCycleObserver } from '../contact-merge-cycle-observer.js';
import {
  handleContactMergeScanNow,
  handleContactMergeResolveRemergePrompt,
  type ContactMergeRpcDeps,
} from '../contact-merge-handler.js';

let dir: string;
let db: Database.Database;
let store: ContactStore;
let linkChanges: PlatformLinkChange[];

const stubBus = (
  recorded: { kind: string; [k: string]: unknown }[],
): { emit: (e: { kind: string; [k: string]: unknown }) => unknown } => ({
  emit: (event) => {
    recorded.push(event);
    return event;
  },
});

const stubCtx = (overrides: Partial<HousekeepingContext> = {}): HousekeepingContext =>
  ({
    db,
    bus: { emit: vi.fn() } as unknown as HousekeepingContext['bus'],
    enrichmentStore: {} as HousekeepingContext['enrichmentStore'],
    recipeStore: {} as HousekeepingContext['recipeStore'],
    now: () => Date.now(),
    emitAuditRow: vi.fn(),
    ...overrides,
  } as HousekeepingContext);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd138-p3-'));
  db = new Database(join(dir, 'test.db'));
  db.pragma('journal_mode = WAL');
  linkChanges = [];
  store = createContactStore(db, {
    onPlatformLinkChanged: (change) => {
      linkChanges.push(change);
    },
  });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const seedAcmePair = (): void => {
  // Two predicate-matching rows: same name + same company. Predicate
  // surfaces the pair on housekeeping scan.
  store.upsertManual({ email: 'a@x.com', name: 'Alice Jones', company: 'Acme' });
  store.upsertManual({ email: 'b@x.com', name: 'Alice Jones', company: 'Acme' });
};

describe('D-138 P3 — contact-merge-candidate-scan housekeeping task', () => {
  it('surfaces a candidate for two predicate-matching contacts', async () => {
    seedAcmePair();
    const events: { kind: string; [k: string]: unknown }[] = [];
    const task = buildContactMergeCandidateScanTask({
      store,
      eventBus: stubBus(events) as never,
      idFactory: () => `cand-${events.length}`,
      progressStride: 1000, // disable per-iter progress for clarity
    });
    const result = await task.step(stubCtx(), { kind: 'complete' }, 60_000);
    expect(result.status).toBe('complete');
    const queued = store.listMergeCandidates({ status: 'pending' });
    expect(queued.candidates.length).toBe(1);
    expect(queued.candidates[0].detected_by).toBe('housekeeping');
    expect(queued.candidates[0].matched_fields).toEqual(
      expect.arrayContaining(['name', 'company']),
    );
    // One merge_candidate inserted event + one merge_scan_progress
    // op:'complete' event.
    const inserts = events.filter((e) => e.kind === 'merge_candidate');
    expect(inserts.length).toBe(1);
    const completion = events.find(
      (e) => e.kind === 'merge_scan_progress' && e['op'] === 'complete',
    );
    expect(completion).toBeDefined();
    expect(completion?.['surfaced_count']).toBe(1);
  });

  it('delta cursor advances to max(updated_at) seen', async () => {
    seedAcmePair();
    const task = buildContactMergeCandidateScanTask({ store });
    const ctx = stubCtx();
    const first = await task.step(ctx, { kind: 'complete' }, 60_000);
    expect(first.cursor.kind).toBe('time_email');
    const firstTimeEmail = first.cursor as {
      kind: 'time_email';
      last_seen_at: number;
      last_email: string;
    };
    expect(firstTimeEmail.last_seen_at).toBeGreaterThan(0);
    expect(firstTimeEmail.last_email).not.toBe('');
    const before = firstTimeEmail.last_seen_at;

    // Re-run from the advanced cursor — no contacts have changed
    // since, so the walker yields zero rows.
    const second = await task.step(ctx, first.cursor, 60_000);
    expect(second.status).toBe('complete');
    expect(second.cursor.kind).toBe('time_email');
    expect(
      (second.cursor as { last_seen_at: number; last_email: string }).last_seen_at,
    ).toBe(before);
  });

  it('walks every contact in a same-millisecond cluster across batch boundaries', async () => {
    // Codex review fix — if the cursor only carried `last_seen_at`,
    // a batch boundary inside a same-millisecond group of contacts
    // would skip the un-walked peers next iteration. The
    // `(updated_at, email)` cursor + `> tuple` query keeps every
    // peer in scope.
    const sharedTs = 1_700_000_000_000;
    db.prepare(`UPDATE contacts SET updated_at = ?, name = ?`).run(sharedTs, 'Shared');
    for (const local of ['k', 'l', 'm', 'n', 'o']) {
      store.upsertManual({
        email: `${local}@x.com`,
        name: 'Shared Name',
        company: 'Acme',
      });
    }
    db.prepare(`UPDATE contacts SET updated_at = ?`).run(sharedTs);
    const task = buildContactMergeCandidateScanTask({ store, batchSize: 2 });
    const ctx = stubCtx();
    let cursor: import('@recued/contracts').HousekeepingCursor = { kind: 'complete' };
    const seenEmails = new Set<string>();
    for (let i = 0; i < 10; i++) {
      const result = await task.step(ctx, cursor, 60_000);
      cursor = result.cursor;
      // Pull the queued candidates' emails to confirm coverage.
      const queue = store.listMergeCandidates({ status: 'pending', limit: 100 });
      for (const c of queue.candidates) {
        seenEmails.add(c.email_a);
        seenEmails.add(c.email_b);
      }
      if (result.status === 'complete') break;
    }
    // Every seeded contact should appear in at least one candidate
    // edge — confirms the walker didn't drop peers at batch boundary.
    expect(seenEmails.has('k@x.com')).toBe(true);
    expect(seenEmails.has('o@x.com')).toBe(true);
  });

  it('idempotent — re-running on identical data does not duplicate queue rows', async () => {
    seedAcmePair();
    const task = buildContactMergeCandidateScanTask({
      store,
      idFactory: vi.fn(() => 'fresh-id-' + Math.random()),
    });
    await task.step(stubCtx(), { kind: 'complete' }, 60_000);
    await task.step(stubCtx(), { kind: 'complete' }, 60_000);
    const queued = store.listMergeCandidates({ status: 'pending' });
    expect(queued.candidates.length).toBe(1);
  });

  it('rejection pre-filter blocks re-surfacing', async () => {
    seedAcmePair();
    store.addRejection({
      email_a: 'a@x.com',
      email_b: 'b@x.com',
      rejected_at: 1,
    });
    const task = buildContactMergeCandidateScanTask({ store });
    await task.step(stubCtx(), { kind: 'complete' }, 60_000);
    const queued = store.listMergeCandidates({ status: 'pending' });
    expect(queued.candidates.length).toBe(0);
  });

  it('skips tombstones (`merged_into IS NULL`) on the walker side', async () => {
    seedAcmePair();
    store.upsertManual({ email: 'c@x.com', name: 'Alice Jones', company: 'Acme' });
    // Tombstone b@x.com → a@x.com
    const b = store.get('b@x.com')!;
    store.setMergedInto([b], 'a@x.com', Date.now());
    const task = buildContactMergeCandidateScanTask({ store });
    await task.step(stubCtx(), { kind: 'complete' }, 60_000);
    const queued = store.listMergeCandidates({ status: 'pending' });
    // Only one candidate edge: (a, c). No (b, ...) since b is tombstoned.
    expect(queued.candidates.length).toBe(1);
  });

  it('emits per-stride progress events during the walk', async () => {
    // Seed enough rows to clear the stride threshold.
    for (let i = 0; i < 5; i++) {
      store.upsertManual({
        email: `bob${i}@example.com`,
        name: 'Bob Smith',
        company: 'Acme',
      });
    }
    const events: { kind: string; [k: string]: unknown }[] = [];
    const task = buildContactMergeCandidateScanTask({
      store,
      eventBus: stubBus(events) as never,
      progressStride: 2,
    });
    await task.step(stubCtx(), { kind: 'complete' }, 60_000);
    const progresses = events.filter(
      (e) => e.kind === 'merge_scan_progress' && e['op'] === 'progress',
    );
    expect(progresses.length).toBeGreaterThanOrEqual(2);
  });

  it('yields with budget_exhausted when batchSize fills + may have more pending', async () => {
    // Codex review fix — yield reason for "batch full, more rows
    // pending" is `'budget_exhausted'`, not `'no_work'`. The rpc
    // drain loop iterates while the task yields with this reason and
    // exits only on `'complete'`.
    for (let i = 0; i < 4; i++) {
      store.upsertManual({
        email: `unique${i}@example.com`,
        name: `Unique${i} Person`,
        company: `OneOf${i}`,
      });
    }
    const task = buildContactMergeCandidateScanTask({ store, batchSize: 2 });
    const result = await task.step(stubCtx(), { kind: 'complete' }, 60_000);
    expect(result.status).toBe('yield');
    expect((result as { reason?: string }).reason).toBe('budget_exhausted');
  });

  it('emits merge_scan_progress with the runtime mode resolved by getMode', async () => {
    seedAcmePair();
    let mode: 'delta' | 'full' = 'delta';
    const events: { kind: string; [k: string]: unknown }[] = [];
    const task = buildContactMergeCandidateScanTask({
      store,
      eventBus: stubBus(events) as never,
      getMode: () => mode,
      progressStride: 1000,
    });
    // First run — bus reports `mode: 'delta'`.
    await task.step(stubCtx(), { kind: 'complete' }, 60_000);
    const deltaCompletion = events.find(
      (e) => e.kind === 'merge_scan_progress' && e['op'] === 'complete',
    );
    expect(deltaCompletion?.['mode']).toBe('delta');

    // Flip the mode + force another scan via timestamp bump.
    mode = 'full';
    db.prepare(`UPDATE contacts SET updated_at = ?`).run(Date.now() + 10_000);
    events.length = 0;
    await task.step(stubCtx(), { kind: 'complete' }, 60_000);
    const fullCompletion = events.find(
      (e) => e.kind === 'merge_scan_progress' && e['op'] === 'complete',
    );
    expect(fullCompletion?.['mode']).toBe('full');
  });
});

describe('D-138 P3 — RemergePromptStore', () => {
  it('persists prompt + reads it back via `get`', () => {
    const promptStore = createRemergePromptStore(db);
    const row = promptStore.record({
      id: 'p1',
      affected_email: 'a@x.com',
      partner_email: 'b@x.com',
      vendor: 'hubspot',
      fired_at: 1_700_000_000_000,
    });
    expect(row.id).toBe('p1');
    const fetched = promptStore.get('p1');
    expect(fetched?.affected_email).toBe('a@x.com');
  });

  it('resolve flips status; pending() omits resolved rows', () => {
    const promptStore = createRemergePromptStore(db);
    promptStore.record({
      id: 'p1',
      affected_email: 'a@x.com',
      partner_email: 'b@x.com',
      vendor: 'hubspot',
      fired_at: 1,
    });
    promptStore.record({
      id: 'p2',
      affected_email: 'c@x.com',
      partner_email: 'd@x.com',
      vendor: 'salesforce',
      fired_at: 2,
    });
    expect(promptStore.pending().length).toBe(2);
    promptStore.resolve('p1', 'remerge', 100);
    const after = promptStore.pending();
    expect(after.length).toBe(1);
    expect(after[0].id).toBe('p2');
  });

  it('record() is idempotent on (affected, partner, vendor) for unresolved rows', () => {
    const promptStore = createRemergePromptStore(db);
    const first = promptStore.record({
      id: 'p1',
      affected_email: 'a@x.com',
      partner_email: 'b@x.com',
      vendor: 'hubspot',
      fired_at: 1,
    });
    const second = promptStore.record({
      id: 'p2',
      affected_email: 'a@x.com',
      partner_email: 'b@x.com',
      vendor: 'hubspot',
      fired_at: 2,
    });
    expect(second.id).toBe(first.id);
    expect(promptStore.pending().length).toBe(1);
  });

  it('record() rejects identical email pair', () => {
    const promptStore = createRemergePromptStore(db);
    expect(() =>
      promptStore.record({
        id: 'p1',
        affected_email: 'a@x.com',
        partner_email: 'a@x.com',
        vendor: 'hubspot',
        fired_at: 1,
      }),
    ).toThrow(/invalid_pair/);
  });

  it('get() returns null for already-resolved prompts (Codex review fix)', () => {
    const promptStore = createRemergePromptStore(db);
    promptStore.record({
      id: 'p1',
      affected_email: 'a@x.com',
      partner_email: 'b@x.com',
      vendor: 'hubspot',
      fired_at: 1,
    });
    expect(promptStore.get('p1')).not.toBeNull();
    promptStore.resolve('p1', 'treat_as_deletion', 100);
    // After resolution, get() returns null so the rpc handler's
    // `not_found` path fires instead of letting a replayed
    // `remerge_prompt` event flip the resolution.
    expect(promptStore.get('p1')).toBeNull();
  });
});

describe('D-138 P3 — cycle observer A.10 plausibility', () => {
  const seedRejectedPair = (): void => {
    store.upsertManual({ email: 'a@x.com', name: 'Alice' });
    store.upsertManual({ email: 'b@x.com', name: 'Alice Different Person' });
    store.addRejection({ email_a: 'a@x.com', email_b: 'b@x.com', rejected_at: 1 });
  };

  it('fires prompt when rejected partner gains same-vendor link inside cycle window', () => {
    seedRejectedPair();
    const promptStore = createRemergePromptStore(db);
    const events: { kind: string; [k: string]: unknown }[] = [];
    const observer = createContactMergeCycleObserver({
      store,
      promptStore,
      eventBus: stubBus(events) as never,
      idFactory: () => 'p-fixed',
    });
    observer.beginCycle();
    // Vendor reconciler removed a@x.com's HubSpot link, then added
    // one to b@x.com (same vendor) inside the cycle.
    observer.recordChange({
      kind: 'removed',
      canonical_email: 'a@x.com',
      vendor: 'hubspot',
      platform_id: 'hubspot_contact_111',
    });
    observer.recordChange({
      kind: 'added',
      canonical_email: 'b@x.com',
      vendor: 'hubspot',
      platform_id: 'hubspot_contact_222',
    });
    const fired = observer.closeCycle();
    expect(fired).toBe(1);
    const prompt = promptStore.pending()[0];
    expect(prompt.affected_email).toBe('a@x.com');
    expect(prompt.partner_email).toBe('b@x.com');
    expect(prompt.vendor).toBe('hubspot');
    const busFired = events.filter((e) => e.kind === 'remerge_prompt');
    expect(busFired.length).toBe(1);
  });

  it('does NOT fire prompt for cross-vendor partner re-link', () => {
    seedRejectedPair();
    const promptStore = createRemergePromptStore(db);
    const observer = createContactMergeCycleObserver({ store, promptStore });
    observer.beginCycle();
    observer.recordChange({
      kind: 'removed',
      canonical_email: 'a@x.com',
      vendor: 'hubspot',
      platform_id: 'hubspot_contact_111',
    });
    observer.recordChange({
      kind: 'added',
      canonical_email: 'b@x.com',
      vendor: 'salesforce', // different vendor
      platform_id: 'salesforce_contact_222',
    });
    const fired = observer.closeCycle();
    expect(fired).toBe(0);
  });

  it('does NOT fire when not in active cycle (between-cycle delete is no-op)', () => {
    seedRejectedPair();
    const promptStore = createRemergePromptStore(db);
    const observer = createContactMergeCycleObserver({ store, promptStore });
    // No beginCycle.
    observer.recordChange({
      kind: 'removed',
      canonical_email: 'a@x.com',
      vendor: 'hubspot',
      platform_id: 'hubspot_contact_111',
    });
    observer.recordChange({
      kind: 'added',
      canonical_email: 'b@x.com',
      vendor: 'hubspot',
      platform_id: 'hubspot_contact_222',
    });
    expect(observer.closeCycle()).toBe(0);
    expect(promptStore.pending().length).toBe(0);
  });

  it('skips when no rejected pair connects the changed rows', () => {
    store.upsertManual({ email: 'a@x.com', name: 'Alice' });
    store.upsertManual({ email: 'b@x.com', name: 'Bob' });
    // No rejection — plausibility doesn't apply.
    const promptStore = createRemergePromptStore(db);
    const observer = createContactMergeCycleObserver({ store, promptStore });
    observer.beginCycle();
    observer.recordChange({
      kind: 'removed',
      canonical_email: 'a@x.com',
      vendor: 'hubspot',
      platform_id: 'p1',
    });
    observer.recordChange({
      kind: 'added',
      canonical_email: 'b@x.com',
      vendor: 'hubspot',
      platform_id: 'p2',
    });
    expect(observer.closeCycle()).toBe(0);
  });

  it('skips when affected row has been tombstoned', () => {
    seedRejectedPair();
    const a = store.get('a@x.com')!;
    store.setMergedInto([a], 'b@x.com', Date.now());
    const promptStore = createRemergePromptStore(db);
    const observer = createContactMergeCycleObserver({ store, promptStore });
    observer.beginCycle();
    observer.recordChange({
      kind: 'removed',
      canonical_email: 'a@x.com',
      vendor: 'hubspot',
      platform_id: 'p1',
    });
    observer.recordChange({
      kind: 'added',
      canonical_email: 'b@x.com',
      vendor: 'hubspot',
      platform_id: 'p2',
    });
    expect(observer.closeCycle()).toBe(0);
  });

  it('record + resolve via rpc handler with concrete prompt store', async () => {
    seedRejectedPair();
    const promptStore = createRemergePromptStore(db);
    const observer = createContactMergeCycleObserver({
      store,
      promptStore,
      idFactory: () => 'p1',
    });
    observer.beginCycle();
    observer.recordChange({
      kind: 'removed',
      canonical_email: 'a@x.com',
      vendor: 'hubspot',
      platform_id: 'p1',
    });
    observer.recordChange({
      kind: 'added',
      canonical_email: 'b@x.com',
      vendor: 'hubspot',
      platform_id: 'p2',
    });
    observer.closeCycle();

    const result = await handleContactMergeResolveRemergePrompt(
      { contactStore: store, promptStore } as ContactMergeRpcDeps,
      { prompt_id: 'p1', resolution: 'remerge' },
    );
    expect(result.result).toBe('queued_merge_candidate');
    // Rejection cleared.
    expect(store.isPairRejected('a@x.com', 'b@x.com')).toBe(false);
    // Prompt resolved.
    expect(promptStore.pending().length).toBe(0);
  });
});

describe('D-138 P3 — onPlatformLinkChanged callback', () => {
  it('fires `added` event on first link', () => {
    store.upsertManual({ email: 'a@x.com' });
    store.linkPlatformId({
      canonical_email: 'a@x.com',
      vendor: 'hubspot',
      platform_id: 'p1',
      state: 'auto',
      linked_at: 1,
      linked_by: 'reconciler:hubspot',
    });
    expect(linkChanges.length).toBe(1);
    expect(linkChanges[0]).toMatchObject({
      kind: 'added',
      canonical_email: 'a@x.com',
      vendor: 'hubspot',
      platform_id: 'p1',
    });
  });

  it('fires removed + added pair on rekey to a different canonical_email', () => {
    store.upsertManual({ email: 'a@x.com' });
    store.upsertManual({ email: 'b@x.com' });
    store.linkPlatformId({
      canonical_email: 'a@x.com',
      vendor: 'hubspot',
      platform_id: 'p1',
      state: 'auto',
      linked_at: 1,
      linked_by: 'reconciler:hubspot',
    });
    linkChanges.length = 0;
    store.linkPlatformId({
      canonical_email: 'b@x.com',
      vendor: 'hubspot',
      platform_id: 'p1',
      state: 'auto',
      linked_at: 2,
      linked_by: 'reconciler:hubspot',
    });
    expect(linkChanges.length).toBe(2);
    expect(linkChanges[0]).toMatchObject({ kind: 'removed', canonical_email: 'a@x.com' });
    expect(linkChanges[1]).toMatchObject({ kind: 'added', canonical_email: 'b@x.com' });
  });

  it('fires `removed` event on unlink', () => {
    store.upsertManual({ email: 'a@x.com' });
    store.linkPlatformId({
      canonical_email: 'a@x.com',
      vendor: 'hubspot',
      platform_id: 'p1',
      state: 'auto',
      linked_at: 1,
      linked_by: 'reconciler:hubspot',
    });
    linkChanges.length = 0;
    store.unlinkPlatformId('hubspot', 'p1');
    expect(linkChanges.length).toBe(1);
    expect(linkChanges[0]).toMatchObject({ kind: 'removed' });
  });

  it('idempotent same-canonical re-link emits no event', () => {
    store.upsertManual({ email: 'a@x.com' });
    store.linkPlatformId({
      canonical_email: 'a@x.com',
      vendor: 'hubspot',
      platform_id: 'p1',
      state: 'auto',
      linked_at: 1,
      linked_by: 'reconciler:hubspot',
    });
    linkChanges.length = 0;
    store.linkPlatformId({
      canonical_email: 'a@x.com',
      vendor: 'hubspot',
      platform_id: 'p1',
      state: 'auto',
      linked_at: 2,
      linked_by: 'reconciler:hubspot',
    });
    expect(linkChanges.length).toBe(0);
  });
});

describe('D-138 P3 — contact.merge.scan_now rpc', () => {
  it('surfaces not_configured when runScanNow is unwired', async () => {
    await expect(
      handleContactMergeScanNow(
        { contactStore: store } as ContactMergeRpcDeps,
        { mode: 'delta' },
      ),
    ).rejects.toThrow(/scan runner not wired/);
  });

  it('dispatches with mode = full', async () => {
    const runScanNow = vi.fn().mockResolvedValue({ iterated: 3, surfaced_count: 2 });
    const result = await handleContactMergeScanNow(
      { contactStore: store, runScanNow } as ContactMergeRpcDeps,
      { mode: 'full' },
    );
    expect(runScanNow).toHaveBeenCalledWith({ mode: 'full' });
    expect(result.mode).toBe('full');
    expect(result.iterated).toBe(3);
    expect(result.surfaced_count).toBe(2);
  });

  it('defaults to mode = delta when args.mode is omitted', async () => {
    const runScanNow = vi.fn().mockResolvedValue({ iterated: 0, surfaced_count: 0 });
    const result = await handleContactMergeScanNow(
      { contactStore: store, runScanNow } as ContactMergeRpcDeps,
      undefined,
    );
    expect(runScanNow).toHaveBeenCalledWith({ mode: 'delta' });
    expect(result.mode).toBe('delta');
  });

  it('passes through yield_reason', async () => {
    const runScanNow = vi.fn().mockResolvedValue({
      iterated: 1,
      surfaced_count: 0,
      yield_reason: 'budget_exhausted' as const,
    });
    const result = await handleContactMergeScanNow(
      { contactStore: store, runScanNow } as ContactMergeRpcDeps,
      { mode: 'full' },
    );
    expect(result.yield_reason).toBe('budget_exhausted');
  });
});

describe('D-138 P3 — task id + batch-size constants', () => {
  it('exports the canonical task id', () => {
    expect(CONTACT_MERGE_CANDIDATE_SCAN_TASK_ID).toBe('contact-merge-candidate-scan');
    expect(CONTACT_MERGE_SCAN_BATCH_SIZE).toBeGreaterThan(0);
  });
});
