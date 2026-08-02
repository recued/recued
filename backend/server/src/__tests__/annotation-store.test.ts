/** D-119 Phase 13 — Annotation + Link SQLite store tests.
 *
 *  Covers:
 *    - write/read for annotations and links
 *    - per-record indexes (target_collection,target_id) +
 *      (from_collection,from_id) + (to_collection,to_id)
 *    - per-key bulk index
 *    - inline/CAS split at 64 KB
 *    - filter queries on list / delete
 *    - cascade-on-parent-delete (annotations + links in one txn)
 *    - latest-wins per-record ref read
 *    - inbound vs outbound link reads */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createBlobStore } from '../storage/blob-store.js';
import {
  createAnnotationStore,
  AnnotationKeyInvalidError,
  AnnotationValueTooLargeError,
} from '../storage/annotation-store.js';
import { ANNOTATION_INLINE_CUTOFF_BYTES } from '@recued/contracts';

let dir: string;
let db: Database.Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'annotation-store-'));
  db = new Database(join(dir, 'test.db'));
  db.pragma('journal_mode = WAL');
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const mkStore = (now: number = 1_000_000) => {
  const blobs = createBlobStore(join(dir, 'blobs'));
  let counter = 0;
  let clock = now;
  return {
    blobs,
    store: createAnnotationStore({
      db,
      blobs,
      now: () => clock++,
      newId: () => `id-${++counter}`,
    }),
    advanceClock: (delta: number) => { clock += delta; },
  };
};

describe('createAnnotationStore', () => {
  describe('annotate / per-record reads', () => {
    it('round-trips an inline annotation with stamps', async () => {
      const { store } = mkStore();
      const ann = await store.annotate({
        target_collection: 'mail',
        target_id: 'msg-1',
        key: 'summary',
        value: 'Quarterly review pinged 2x',
        authored_by_recipe_id: 'r1',
        source_record_hash: 'src-1',
        recipe_hash: 'rec-1',
        model_used: 'gpt-4',
      });
      expect(ann._collection).toBe('annotation');
      expect(ann._id).toMatch(/^id-/);
      expect(ann.target_collection).toBe('mail');
      expect(ann.value).toBe('Quarterly review pinged 2x');
      expect(ann.source_record_hash).toBe('src-1');

      const rows = await store.annotationsForRecord('mail', 'msg-1');
      expect(rows).toHaveLength(1);
      expect(rows[0].value).toBe('Quarterly review pinged 2x');
    });

    it('latest-wins on duplicate (target,id,key) — annotationsForRecord returns one row', async () => {
      const { store, advanceClock } = mkStore();
      await store.annotate({
        target_collection: 'mail', target_id: 'msg-1', key: 'summary',
        value: 'first', authored_by_recipe_id: 'r1',
        source_record_hash: 'src-1', recipe_hash: 'rec-1',
      });
      advanceClock(1000);
      await store.annotate({
        target_collection: 'mail', target_id: 'msg-1', key: 'summary',
        value: 'second', authored_by_recipe_id: 'r1',
        source_record_hash: 'src-2', recipe_hash: 'rec-1',
      });

      const rows = await store.annotationsForRecord('mail', 'msg-1');
      expect(rows).toHaveLength(1);
      expect(rows[0].value).toBe('second');
    });

    it('different keys on the same record coexist', async () => {
      const { store } = mkStore();
      await store.annotate({
        target_collection: 'mail', target_id: 'msg-1', key: 'summary',
        value: 'a', authored_by_recipe_id: 'r1',
        source_record_hash: 'src', recipe_hash: 'rec',
      });
      await store.annotate({
        target_collection: 'mail', target_id: 'msg-1', key: 'risk_score',
        value: 0.7, authored_by_recipe_id: 'r1',
        source_record_hash: 'src', recipe_hash: 'rec',
      });
      const rows = await store.annotationsForRecord('mail', 'msg-1');
      expect(rows).toHaveLength(2);
      const byKey = Object.fromEntries(rows.map((r) => [r.key, r.value]));
      expect(byKey.summary).toBe('a');
      expect(byKey.risk_score).toBe(0.7);
    });

    it('values over the inline cutoff route through CAS and round-trip', async () => {
      const { blobs, store } = mkStore();
      const big = 'x'.repeat(ANNOTATION_INLINE_CUTOFF_BYTES + 100);
      await store.annotate({
        target_collection: 'mail', target_id: 'msg-1', key: 'transcript',
        value: big, authored_by_recipe_id: 'r1',
        source_record_hash: 'src', recipe_hash: 'rec',
      });
      const rows = await store.annotationsForRecord('mail', 'msg-1');
      expect(rows[0].value).toBe(big);
      const blobBytes = await blobs.totalBytes();
      expect(blobBytes).toBeGreaterThan(ANNOTATION_INLINE_CUTOFF_BYTES);
    });

    it('rejects empty target_collection / target_id / key', async () => {
      const { store } = mkStore();
      await expect(
        store.annotate({
          target_collection: '', target_id: 'x', key: 'summary',
          value: 'v', authored_by_recipe_id: 'r1',
          source_record_hash: 's', recipe_hash: 'r',
        }),
      ).rejects.toBeInstanceOf(AnnotationKeyInvalidError);
    });

    it('rejects keys with invalid characters', async () => {
      const { store } = mkStore();
      await expect(
        store.annotate({
          target_collection: 'mail', target_id: 'x', key: 'has space',
          value: 'v', authored_by_recipe_id: 'r1',
          source_record_hash: 's', recipe_hash: 'r',
        }),
      ).rejects.toBeInstanceOf(AnnotationKeyInvalidError);
    });
  });

  describe('annotation-list / annotation-search / delete by filter', () => {
    const seed = async (store: ReturnType<typeof mkStore>['store']): Promise<void> => {
      await store.annotate({
        target_collection: 'mail', target_id: 'm1', key: 'summary',
        value: 'Acme Q3 review',
        authored_by_recipe_id: 'r1',
        source_record_hash: 'a', recipe_hash: 'b',
      });
      await store.annotate({
        target_collection: 'mail', target_id: 'm2', key: 'summary',
        value: 'Brand expansion',
        authored_by_recipe_id: 'r1',
        source_record_hash: 'a', recipe_hash: 'b',
      });
      await store.annotate({
        target_collection: 'mail', target_id: 'm1', key: 'risk_score',
        value: 0.9,
        authored_by_recipe_id: 'r2',
        source_record_hash: 'a', recipe_hash: 'b',
      });
      await store.annotate({
        target_collection: 'calendar', target_id: 'evt-1', key: 'summary',
        value: 'Standup',
        authored_by_recipe_id: 'r1',
        source_record_hash: 'a', recipe_hash: 'b',
      });
    };

    it('list filters by target_collection + key (the (target, id) and (key) indexes)', async () => {
      const { store } = mkStore();
      await seed(store);
      const summaries = await store.listAnnotations({ key: 'summary' });
      expect(summaries.map((a) => a.target_id).sort()).toEqual(['evt-1', 'm1', 'm2']);

      const mailOnly = await store.listAnnotations({ target_collection: 'mail' });
      expect(mailOnly).toHaveLength(3);

      const oneRecord = await store.listAnnotations({
        target_collection: 'mail', target_id: 'm1',
      });
      expect(oneRecord.map((a) => a.key).sort()).toEqual(['risk_score', 'summary']);
    });

    it('list filter by authored_by_recipe_id narrows to one author', async () => {
      const { store } = mkStore();
      await seed(store);
      const r1 = await store.listAnnotations({ authored_by_recipe_id: 'r1' });
      expect(r1.map((a) => a.key).sort()).toEqual(['summary', 'summary', 'summary']);
      const r2 = await store.listAnnotations({ authored_by_recipe_id: 'r2' });
      expect(r2).toHaveLength(1);
    });

    it('search returns FTS matches with rank', async () => {
      const { store } = mkStore();
      await seed(store);
      const results = await store.searchAnnotations({ query: 'Acme' });
      expect(results).toHaveLength(1);
      expect(results[0].target_id).toBe('m1');
      expect(typeof results[0].rank).toBe('number');
    });

    it('search narrows by key when supplied', async () => {
      const { store } = mkStore();
      await seed(store);
      // The token "review" appears in m1's summary.
      const all = await store.searchAnnotations({ query: 'review' });
      expect(all.length).toBeGreaterThan(0);
      const onlyRisk = await store.searchAnnotations({
        query: 'review', key: 'risk_score',
      });
      expect(onlyRisk).toHaveLength(0);
    });

    it('delete by filter requires at least one filter field', async () => {
      const { store } = mkStore();
      await seed(store);
      await expect(store.deleteAnnotations({})).rejects.toBeInstanceOf(
        AnnotationKeyInvalidError,
      );
    });

    it('delete by filter removes only matching rows', async () => {
      const { store } = mkStore();
      await seed(store);
      const removed = await store.deleteAnnotations({ key: 'risk_score' });
      expect(removed).toBe(1);
      const remaining = await store.listAnnotations({});
      expect(remaining).toHaveLength(3);
      expect(remaining.every((a) => a.key === 'summary')).toBe(true);
    });

    it('delete by filter preserves deduplicated CAS bytes referenced by a survivor', async () => {
      const { blobs, store } = mkStore();
      const deleteSpy = vi.spyOn(blobs, 'delete');
      const big = 'f'.repeat(ANNOTATION_INLINE_CUTOFF_BYTES + 100);
      await store.annotate({
        target_collection: 'mail', target_id: 'doomed', key: 'transcript',
        value: big, authored_by_recipe_id: 'r1',
        source_record_hash: 'a', recipe_hash: 'b',
      });
      await store.annotate({
        target_collection: 'mail', target_id: 'survivor', key: 'transcript',
        value: big, authored_by_recipe_id: 'r2',
        source_record_hash: 'c', recipe_hash: 'd',
      });

      await expect(store.deleteAnnotations({ target_id: 'doomed' })).resolves.toBe(1);

      expect(deleteSpy).not.toHaveBeenCalled();
      await expect(store.annotationsForRecord('mail', 'survivor')).resolves.toMatchObject([
        { value: big },
      ]);
      expect(await blobs.totalBytes()).toBeGreaterThan(0);
    });

    it('deleteAnnotation preserves deduplicated CAS bytes referenced by a survivor', async () => {
      const { blobs, store } = mkStore();
      const deleteSpy = vi.spyOn(blobs, 'delete');
      const big = 'e'.repeat(ANNOTATION_INLINE_CUTOFF_BYTES + 100);
      const doomed = await store.annotate({
        target_collection: 'mail', target_id: 'doomed', key: 'transcript',
        value: big, authored_by_recipe_id: 'r1',
        source_record_hash: 'a', recipe_hash: 'b',
      });
      await store.annotate({
        target_collection: 'mail', target_id: 'survivor', key: 'transcript',
        value: big, authored_by_recipe_id: 'r2',
        source_record_hash: 'c', recipe_hash: 'd',
      });

      await expect(store.deleteAnnotation(doomed._id)).resolves.toBe(true);

      expect(deleteSpy).not.toHaveBeenCalled();
      await expect(store.annotationsForRecord('mail', 'survivor')).resolves.toMatchObject([
        { value: big },
      ]);
    });

    it('rolls back the main row and FTS mutation when a filtered delete fails', async () => {
      const { store } = mkStore();
      await store.annotate({
        target_collection: 'mail', target_id: 'protected', key: 'summary',
        value: 'Acme deletion must roll back', authored_by_recipe_id: 'r1',
        source_record_hash: 'a', recipe_hash: 'b',
      });
      db.exec(`
        CREATE TRIGGER annotation_delete_test_abort
        BEFORE DELETE ON annotation
        BEGIN
          SELECT RAISE(ABORT, 'test delete blocked');
        END
      `);

      await expect(store.deleteAnnotations({ target_id: 'protected' }))
        .rejects.toThrow(/test delete blocked/);

      await expect(store.listAnnotations({ target_id: 'protected' })).resolves.toHaveLength(1);
      await expect(store.searchAnnotations({ query: 'Acme' })).resolves.toMatchObject([
        { target_id: 'protected' },
      ]);
    });
  });

  describe('value size guard', () => {
    it('rejects values above 10 MiB', async () => {
      const { store } = mkStore();
      const oversized = 'x'.repeat(10 * 1024 * 1024 + 100);
      await expect(
        store.annotate({
          target_collection: 'mail', target_id: 'x', key: 'summary',
          value: oversized,
          authored_by_recipe_id: 'r1',
          source_record_hash: 'a', recipe_hash: 'b',
        }),
      ).rejects.toBeInstanceOf(AnnotationValueTooLargeError);
    });
  });

  describe('links — write + indexes + bulk', () => {
    it('round-trips a link', async () => {
      const { store } = mkStore();
      const link = await store.link({
        from_collection: 'mail', from_id: 'm1',
        to_collection: 'file', to_id: 'f1',
        role: 'attachment', authored_by_recipe_id: 'r1',
      });
      expect(link._collection).toBe('link');
      expect(link.from_collection).toBe('mail');
    });

    it('outboundLinks reads via (from_collection, from_id) index', async () => {
      const { store } = mkStore();
      await store.link({
        from_collection: 'mail', from_id: 'm1',
        to_collection: 'file', to_id: 'f1',
        role: 'attachment', authored_by_recipe_id: 'r1',
      });
      await store.link({
        from_collection: 'mail', from_id: 'm1',
        to_collection: 'calendar', to_id: 'evt-1',
        role: 'scheduled-from', authored_by_recipe_id: 'r1',
      });
      await store.link({
        from_collection: 'mail', from_id: 'm2',
        to_collection: 'file', to_id: 'f9',
        role: 'attachment', authored_by_recipe_id: 'r1',
      });
      const out = await store.outboundLinks('mail', 'm1');
      expect(out).toHaveLength(2);
      const roles = out.map((l) => l.role).sort();
      expect(roles).toEqual(['attachment', 'scheduled-from']);
    });

    it('inboundLinks reads via (to_collection, to_id) index', async () => {
      const { store } = mkStore();
      await store.link({
        from_collection: 'mail', from_id: 'm1',
        to_collection: 'file', to_id: 'f1',
        role: 'attachment', authored_by_recipe_id: 'r1',
      });
      await store.link({
        from_collection: 'mail', from_id: 'm2',
        to_collection: 'file', to_id: 'f1',
        role: 'attachment', authored_by_recipe_id: 'r2',
      });
      const inbound = await store.inboundLinks('file', 'f1');
      expect(inbound).toHaveLength(2);
      expect(inbound.map((l) => l.from_id).sort()).toEqual(['m1', 'm2']);
    });

    it('listLinks filter narrows on either side', async () => {
      const { store } = mkStore();
      await store.link({
        from_collection: 'mail', from_id: 'm1', to_collection: 'file', to_id: 'f1',
        role: 'attachment', authored_by_recipe_id: 'r1',
      });
      await store.link({
        from_collection: 'mail', from_id: 'm2', to_collection: 'file', to_id: 'f2',
        role: 'reply-to', authored_by_recipe_id: 'r1',
      });
      const attachments = await store.listLinks({ role: 'attachment' });
      expect(attachments).toHaveLength(1);
      expect(attachments[0].to_id).toBe('f1');
    });
  });

  describe('staleness-driven eviction (Phase 13.7)', () => {
    it('evicts rows whose recipe_hash drifted', async () => {
      const { store } = mkStore();
      await store.annotate({
        target_collection: 'mail', target_id: 'm1', key: 'summary',
        value: 'old',
        authored_by_recipe_id: 'r1',
        source_record_hash: 's-1', recipe_hash: 'rec-1',
      });
      const evicted = await store.evictStaleAnnotations(
        { authored_by_recipe_id: 'r1' },
        { recipe_hash: 'rec-2' },
      );
      expect(evicted).toBe(1);
      const rows = await store.listAnnotations({ authored_by_recipe_id: 'r1' });
      expect(rows).toHaveLength(0);
    });

    it('keeps rows whose stamps still match current', async () => {
      const { store } = mkStore();
      await store.annotate({
        target_collection: 'mail', target_id: 'm1', key: 'summary',
        value: 'fresh',
        authored_by_recipe_id: 'r1',
        source_record_hash: 's-1', recipe_hash: 'rec-1',
      });
      const evicted = await store.evictStaleAnnotations(
        { authored_by_recipe_id: 'r1' },
        { recipe_hash: 'rec-1', source_record_hash: 's-1' },
      );
      expect(evicted).toBe(0);
    });

    it('detects model_used drift only when both stamps are present', async () => {
      const { store } = mkStore();
      // Row 1: AI-stamped with gpt-4
      await store.annotate({
        target_collection: 'mail', target_id: 'm1', key: 'summary',
        value: 'a',
        authored_by_recipe_id: 'r1',
        source_record_hash: 's', recipe_hash: 'r',
        model_used: 'gpt-4',
      });
      // Row 2: transform-only (no model_used)
      await store.annotate({
        target_collection: 'mail', target_id: 'm2', key: 'summary',
        value: 'b',
        authored_by_recipe_id: 'r1',
        source_record_hash: 's', recipe_hash: 'r',
      });
      // Current model has rotated to claude
      const evicted = await store.evictStaleAnnotations(
        { authored_by_recipe_id: 'r1' },
        { recipe_hash: 'r', model_used: 'claude-3' },
      );
      // Only row 1 evicts — row 2's transform-only stamp is unaffected
      // by model rotation.
      expect(evicted).toBe(1);
      const left = await store.listAnnotations({ authored_by_recipe_id: 'r1' });
      expect(left).toHaveLength(1);
      expect(left[0].target_id).toBe('m2');
    });

    it('rejects missing current.recipe_hash', async () => {
      const { store } = mkStore();
      await expect(
        store.evictStaleAnnotations({}, {} as { recipe_hash: string }),
      ).rejects.toBeInstanceOf(AnnotationKeyInvalidError);
    });

    it('source_record_hash drift triggers eviction', async () => {
      const { store } = mkStore();
      await store.annotate({
        target_collection: 'mail', target_id: 'm1', key: 'summary',
        value: 'seen-when-source-was-X',
        authored_by_recipe_id: 'r1',
        source_record_hash: 'src-X', recipe_hash: 'rec-1',
      });
      const evicted = await store.evictStaleAnnotations(
        { target_collection: 'mail', target_id: 'm1' },
        { recipe_hash: 'rec-1', source_record_hash: 'src-Y' },
      );
      expect(evicted).toBe(1);
    });
  });

  describe('cascade-on-parent-delete (transactional sweep)', () => {
    it('removes annotations and links touching the deleted record in one txn', async () => {
      const { store } = mkStore();
      // Annotation on the doomed record
      await store.annotate({
        target_collection: 'mail', target_id: 'm1', key: 'summary',
        value: 'about to be deleted',
        authored_by_recipe_id: 'r1',
        source_record_hash: 'a', recipe_hash: 'b',
      });
      // Outbound link
      await store.link({
        from_collection: 'mail', from_id: 'm1',
        to_collection: 'file', to_id: 'f1', role: 'attachment',
        authored_by_recipe_id: 'r1',
      });
      // Inbound link (mail m1 is the target)
      await store.link({
        from_collection: 'calendar', from_id: 'evt-1',
        to_collection: 'mail', to_id: 'm1', role: 'follow-up-on',
        authored_by_recipe_id: 'r1',
      });
      // A link unrelated to m1 — must survive
      await store.link({
        from_collection: 'mail', from_id: 'm2',
        to_collection: 'file', to_id: 'f9', role: 'attachment',
        authored_by_recipe_id: 'r1',
      });

      const result = store.cascadeDelete('mail', 'm1');
      expect(result.annotations_deleted).toBe(1);
      expect(result.links_deleted).toBe(2);

      // Survivors
      const survivors = await store.listLinks({});
      expect(survivors).toHaveLength(1);
      expect(survivors[0].from_id).toBe('m2');

      const annLeft = await store.annotationsForRecord('mail', 'm1');
      expect(annLeft).toHaveLength(0);
    });

    it('cascade is a no-op for an unrelated record', async () => {
      const { store } = mkStore();
      await store.annotate({
        target_collection: 'mail', target_id: 'm1', key: 'summary',
        value: 'still here',
        authored_by_recipe_id: 'r1',
        source_record_hash: 'a', recipe_hash: 'b',
      });
      const result = store.cascadeDelete('mail', 'does-not-exist');
      expect(result.annotations_deleted).toBe(0);
      expect(result.links_deleted).toBe(0);
      const ann = await store.annotationsForRecord('mail', 'm1');
      expect(ann).toHaveLength(1);
    });

    it('cascade preserves deduplicated CAS bytes referenced by another record', async () => {
      const { blobs, store } = mkStore();
      const deleteSpy = vi.spyOn(blobs, 'delete');
      const big = 'c'.repeat(ANNOTATION_INLINE_CUTOFF_BYTES + 100);
      await store.annotate({
        target_collection: 'mail', target_id: 'doomed', key: 'transcript',
        value: big, authored_by_recipe_id: 'r1',
        source_record_hash: 'a', recipe_hash: 'b',
      });
      await store.annotate({
        target_collection: 'mail', target_id: 'survivor', key: 'transcript',
        value: big, authored_by_recipe_id: 'r2',
        source_record_hash: 'c', recipe_hash: 'd',
      });

      expect(store.cascadeDelete('mail', 'doomed').annotations_deleted).toBe(1);
      await Promise.resolve();

      expect(deleteSpy).not.toHaveBeenCalled();
      await expect(store.annotationsForRecord('mail', 'survivor')).resolves.toMatchObject([
        { value: big },
      ]);
    });
  });

  describe('rewriteRecordId — D-138 § A.8 extras preservation', () => {
    const seedContactAnnotation = (
      store: ReturnType<typeof mkStore>['store'],
      target_id: string,
      key: string,
      value: unknown,
    ): Promise<unknown> =>
      store.annotate({
        target_collection: 'contact',
        target_id,
        key,
        value,
        authored_by_recipe_id: 'r1',
        source_record_hash: `src-${target_id}-${key}`,
        recipe_hash: 'rec-1',
      });

    it('collision preserves deduplicated CAS bytes referenced by another record', async () => {
      const { blobs, store } = mkStore();
      const deleteSpy = vi.spyOn(blobs, 'delete');
      const big = 'r'.repeat(ANNOTATION_INLINE_CUTOFF_BYTES + 100);
      await seedContactAnnotation(store, 'survivor@x.com', 'note', 'canonical');
      await seedContactAnnotation(store, 'loser@x.com', 'note', big);
      await seedContactAnnotation(store, 'unrelated@x.com', 'note', big);

      await expect(
        store.rewriteRecordId('contact', 'loser@x.com', 'survivor@x.com'),
      ).resolves.toMatchObject({ annotations_collided: 1 });
      await Promise.resolve();

      expect(deleteSpy).not.toHaveBeenCalled();
      await expect(
        store.annotationsForRecord('contact', 'unrelated@x.com'),
      ).resolves.toMatchObject([{ value: big }]);
    });

    it('preserves the loser value in survivor extras on a key collision (survivor value wins)', async () => {
      const { store } = mkStore();
      await seedContactAnnotation(store, 'survivor@x.com', 'note', 'survivor-note');
      await seedContactAnnotation(store, 'loser@x.com', 'note', 'loser-note');

      const res = await store.rewriteRecordId('contact', 'loser@x.com', 'survivor@x.com');
      expect(res.annotations_collided).toBe(1);
      expect(res.annotations_rewritten).toBe(0);

      const survivor = await store.annotationsForRecord('contact', 'survivor@x.com');
      expect(survivor).toHaveLength(1);
      expect(survivor[0]!.value).toBe('survivor-note');
      expect(survivor[0]!.extras).toEqual({ 'loser@x.com': 'loser-note' });

      // Loser row dropped.
      const loser = await store.annotationsForRecord('contact', 'loser@x.com');
      expect(loser).toHaveLength(0);
    });

    it('rewrites the loser onto the survivor without extras when there is no collision', async () => {
      const { store } = mkStore();
      await seedContactAnnotation(store, 'survivor@x.com', 'note', 'survivor-note');
      await seedContactAnnotation(store, 'loser@x.com', 'only-loser', 'loser-only');

      const res = await store.rewriteRecordId('contact', 'loser@x.com', 'survivor@x.com');
      expect(res.annotations_rewritten).toBe(1);
      expect(res.annotations_collided).toBe(0);

      const survivor = await store.annotationsForRecord('contact', 'survivor@x.com');
      const onlyLoser = survivor.find((a) => a.key === 'only-loser');
      expect(onlyLoser?.value).toBe('loser-only');
      expect(onlyLoser?.extras).toBeUndefined();
    });

    it('accumulates one extras key per absorbed loser across a multi-way merge', async () => {
      const { store } = mkStore();
      await seedContactAnnotation(store, 'survivor@x.com', 'note', 'survivor-note');
      await seedContactAnnotation(store, 'a@x.com', 'note', 'a-note');
      await seedContactAnnotation(store, 'b@x.com', 'note', 'b-note');

      await store.rewriteRecordId('contact', 'a@x.com', 'survivor@x.com');
      await store.rewriteRecordId('contact', 'b@x.com', 'survivor@x.com');

      const survivor = await store.annotationsForRecord('contact', 'survivor@x.com');
      expect(survivor).toHaveLength(1);
      expect(survivor[0]!.value).toBe('survivor-note');
      expect(survivor[0]!.extras).toEqual({
        'a@x.com': 'a-note',
        'b@x.com': 'b-note',
      });
    });

    it('preserves a blob-stored (>64 KB) loser value in extras while the survivor inline value wins', async () => {
      const { store } = mkStore();
      const bigLoserValue = 'L'.repeat(ANNOTATION_INLINE_CUTOFF_BYTES + 50);
      await seedContactAnnotation(store, 'survivor@x.com', 'big', 'small-survivor');
      await seedContactAnnotation(store, 'loser@x.com', 'big', bigLoserValue);

      const res = await store.rewriteRecordId('contact', 'loser@x.com', 'survivor@x.com');
      expect(res.annotations_collided).toBe(1);

      const survivor = await store.annotationsForRecord('contact', 'survivor@x.com');
      expect(survivor).toHaveLength(1);
      expect(survivor[0]!.value).toBe('small-survivor');
      expect((survivor[0]!.extras as Record<string, unknown>)['loser@x.com']).toBe(bigLoserValue);
    });

    it('is idempotent — a re-run after the loser side is absorbed is a no-op', async () => {
      const { store } = mkStore();
      await seedContactAnnotation(store, 'survivor@x.com', 'note', 'survivor-note');
      await seedContactAnnotation(store, 'loser@x.com', 'note', 'loser-note');
      await store.rewriteRecordId('contact', 'loser@x.com', 'survivor@x.com');

      const second = await store.rewriteRecordId('contact', 'loser@x.com', 'survivor@x.com');
      expect(second).toEqual({
        annotations_rewritten: 0,
        annotations_collided: 0,
        links_rewritten: 0,
      });
      // extras not double-written on the no-op re-run.
      const survivor = await store.annotationsForRecord('contact', 'survivor@x.com');
      expect(survivor[0]!.extras).toEqual({ 'loser@x.com': 'loser-note' });
    });

    it('is a no-op when fromId === toId', async () => {
      const { store } = mkStore();
      await seedContactAnnotation(store, 'same@x.com', 'note', 'v');
      const res = await store.rewriteRecordId('contact', 'same@x.com', 'same@x.com');
      expect(res).toEqual({
        annotations_rewritten: 0,
        annotations_collided: 0,
        links_rewritten: 0,
      });
      const anns = await store.annotationsForRecord('contact', 'same@x.com');
      expect(anns).toHaveLength(1);
      expect(anns[0]!.extras).toBeUndefined();
    });
  });
});
