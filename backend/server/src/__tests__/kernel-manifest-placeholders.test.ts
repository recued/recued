/** A kernel step that omits an optional input runs as if it were absent.
 *
 *  Every kernel manifest declares its optional inputs as `null`, a placeholder
 *  meaning "exists, no default". Dispatch merged them under the step's args, so
 *  an omitted input reached the handler as `null`, and the 2026-09-24 audit found
 *  handlers reading it as a value. Each case below was a live defect; it goes
 *  through the REAL path: `createIngredientExecutor` with the real kernel manifest
 *  merges, then the real kernel adapter, then the production dispatcher over a
 *  real store.
 *
 *  ⛔ Every earlier test of these handlers hand-built the adapter's input and
 *  never included the manifest's nulls, so all of them passed over the defects. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createIngredientExecutor, createKernelAdapter, type KernelDispatchers } from '@recued/ingredients';
import { resolveDeep, type CanonicalEvent } from '@recued/contracts';

import { KERNEL_MANIFESTS } from '../kernel-manifests.js';
import {
  handleAnnotationDelete, handleAnnotationList, handleLinkDelete, handleLinkList,
} from '../annotation-handler.js';
import { handleCalendarList } from '../collections/calendar/calendar-dispatcher.js';
import { createCalendarTable } from '../collections/calendar/calendar-table.js';
import { handleSharedPatch, handleSharedRead, handleSharedWrite } from '../shared-handler.js';
import { createAnnotationStore, type AnnotationStore } from '../storage/annotation-store.js';
import { createBlobStore } from '../storage/blob-store.js';
import { createSharedStore } from '../storage/shared-store.js';
import { createWorkEntityStore, ensureWorkEntitySchema, type WorkEntityStore } from '../storage/work-entity-store.js';
import { createWorkEntityDispatchers } from '../work-entity-ingredients.js';
import { createWorkEntityResolver } from '../work-entity-resolver.js';

const NOW = 1_700_000_000_000;
const HOUR = 3_600_000;

let dir: string;
let db: Database.Database;
let store: WorkEntityStore;
let annotations: AnnotationStore;
let exec: (slug: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kernel-placeholders-'));
  db = new Database(join(dir, 'test.db'));
  ensureWorkEntitySchema(db);
  store = createWorkEntityStore(db);
  for (const kind of ['project', 'booking', 'task'] as const) {
    store.registerSource({
      id: `recued.${kind}`, top_tier_kind: kind, source_kind: 'builtin',
      source_label: `Recued built-in (${kind})`, write_capable: true,
    });
  }
  annotations = createAnnotationStore({ db, blobs: createBlobStore(join(dir, 'blobs')), now: () => NOW });
  const calendar = createCalendarTable({ db, slug: 'primary' });
  const event: CanonicalEvent = {
    source_id: 'evt-1', ical_uid: 'evt-1@local.recued', calendar_id: 'local', summary: 'Planning with Ana',
    start_at: NOW + 2 * HOUR, end_at: NOW + 3 * HOUR, timezone: 'UTC', is_all_day: false,
    status: 'confirmed', created_at: NOW, updated_at: NOW,
  } as CanonicalEvent;
  calendar.upsert({ event, size_bytes: 0, now: NOW });

  const annotationDeps = { store: annotations };
  const dispatchers: KernelDispatchers = {
    // The production composers, as `wire-executor-config.ts` and
    // `collections/calendar/compose.ts` wire them.
    ...createWorkEntityDispatchers({ store, resolver: createWorkEntityResolver(store), now: () => NOW }),
    linkList: (input) => handleLinkList(annotationDeps, input),
    linkDelete: (input) => handleLinkDelete(annotationDeps, input),
    annotationList: (input) => handleAnnotationList(annotationDeps, input),
    calendarList: (input) => handleCalendarList({
      now: () => NOW,
      instances: { get: () => ({ caps: {}, auth_state: 'ok', adapter_type: 'local' }) } as never,
      getCollection: () => ({ table: calendar, health: () => ({ last_indexed_at: NOW, pending_queue_size: 0 }) }) as never,
    }, input),
  } as KernelDispatchers;
  const run = createIngredientExecutor({
    manifestLoader: async (slug) => KERNEL_MANIFESTS.find((m) => m.slug === slug) ?? null,
    kernelAdapter: createKernelAdapter(dispatchers),
    adapterRegistry: {} as never,
  });
  exec = async (slug, args) => (await run(slug, args, undefined, undefined, undefined)) as Record<string, unknown>;
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('the audit\'s live defects, through the real merge', () => {
  it('⛔ calendar-list without a calendar_id reads the calendar (11 shipped recipes read it empty)', async () => {
    const out = await exec('calendar-list', { slug: 'primary', since: NOW, until: NOW + 24 * HOUR, limit: 20 });
    expect((out.records as Array<{ summary: string }>).map((r) => r.summary)).toEqual(['Planning with Ana']);
  });

  it('⛔ project-create and project-update without a parent project (every shipped one threw)', async () => {
    const created = await exec('project-create', { title: 'Kitchen remodel', description: 'Phase one' });
    const project = created.project as { id: string; description: string };
    expect(project.description).toBe('Phase one');
    const updated = await exec('project-update', { id: project.id, title: 'Kitchen and bath remodel' });
    // …and an update that does not name the description keeps it.
    expect(updated.project).toMatchObject({ title: 'Kitchen and bath remodel', description: 'Phase one' });
  });

  it('⛔ booking-update that does not name the slot keeps it, and does not re-stamp the state', async () => {
    const created = await exec('booking-create', {
      title: 'Consultation', slot_start_at: NOW + 24 * HOUR, slot_end_at: NOW + 25 * HOUR,
    });
    const booking = created.booking as { id: string; lifecycle_state: string; state_changed_at: number };
    // booking-create without lifecycle_state or money now works too: born confirmed.
    expect(booking.lifecycle_state).toBe('confirmed');
    const updated = (await exec('booking-update', { id: booking.id, title: 'Consultation (Ana)' })).booking;
    expect(updated).toMatchObject({
      title: 'Consultation (Ana)', slot_start_at: NOW + 24 * HOUR, slot_end_at: NOW + 25 * HOUR,
      state_changed_at: booking.state_changed_at,
    });
  });

  it('⛔ work-entity-list without a source_id lists (all 16 shipped steps threw)', async () => {
    await exec('task-create', { title: 'Call the plumber' });
    const out = await exec('work-entity-list', { kind: 'task', limit: 20 });
    expect(JSON.stringify(out)).toContain('Call the plumber');
  });

  it('⛔ link-list and annotation-list with only some filters find their rows (they matched nothing)', async () => {
    await annotations.link({
      from_collection: 'task', from_id: 't1', to_collection: 'file', to_id: 'receipt-1',
      role: 'receipt', authored_by_recipe_id: 'track-warranty-from-receipt',
    });
    await annotations.annotate({
      target_collection: 'mail', target_id: 'm1', key: 'summary', value: 'Invoice due', authored_by_recipe_id: 'r1',
      source_record_hash: 'src-1',
    });
    const links = await exec('link-list', { from_collection: 'task', from_id: 't1', role: 'receipt' });
    expect((links.links as Array<{ to_id: string }>).map((l) => l.to_id)).toEqual(['receipt-1']);
    const found = await exec('annotation-list', { target_collection: 'mail', target_id: 'm1' });
    expect((found.annotations as Array<{ key: string }>).map((a) => a.key)).toEqual(['summary']);
  });

});

/** A link or annotation delete never widens (integrity audit, 2026-09-24).
 *
 *  Dropping the placeholders exposed what their nulls had hidden: the filter
 *  compiler skips a field with no value and ignores a key it does not know, and
 *  the delete guards counted KEYS. So a recipe ref that resolved to nothing, or an
 *  undeclared key, compiled to `DELETE FROM links`. This runs the real executor
 *  WITH ref resolution, as a recipe, because the one earlier test (`{}` with a bare
 *  `toThrow()` and no resolution) could not see either path. */
describe('a link or annotation delete never widens', () => {
  let del: (slug: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>;
  beforeEach(async () => {
    for (const [from_id, role] of [['t1', 'receipt'], ['t2', 'receipt'], ['t3', 'warranty']] as const) {
      await annotations.link({
        from_collection: 'task', from_id, to_collection: 'file', to_id: `f-${from_id}`, role, authored_by_recipe_id: 'r1',
      });
    }
    for (const [target_id, key] of [['m1', 'summary'], ['m2', 'summary'], ['m1', 'risk']] as const) {
      await annotations.annotate({
        target_collection: 'mail', target_id, key, value: 'x', authored_by_recipe_id: 'r1', source_record_hash: `h-${target_id}-${key}`,
      });
    }
    const deps = { store: annotations };
    const run = createIngredientExecutor({
      manifestLoader: async (slug) => KERNEL_MANIFESTS.find((m) => m.slug === slug) ?? null,
      kernelAdapter: createKernelAdapter({
        linkDelete: (input) => handleLinkDelete(deps, input),
        annotationDelete: (input) => handleAnnotationDelete(deps, input),
      } as KernelDispatchers),
      adapterRegistry: {} as never,
      // Nothing was picked, so `{{step.pick.*}}` resolves to nothing.
      resolveRefs: (input) => resolveDeep(input, { vault: {}, config: {}, context: {}, meta: {}, step: {} } as never) as Record<string, unknown>,
    });
    del = async (slug, args) => (await run(slug, args, undefined, undefined, { recipe_id: 'r1' } as never)) as Record<string, unknown>;
  });
  const linksLeft = async () => (await annotations.listLinks({ from_collection: 'task' })).length;
  const annotationsLeft = async () => (await annotations.listAnnotations({ target_collection: 'mail' })).length;

  it('⛔ a filter ref that resolved to nothing is refused, not read as "any" (it deleted every link)', async () => {
    await expect(del('link-delete', { from_id: '{{step.pick.id}}' }))
      .rejects.toThrow(/link-delete: 'from_id' has no value/);
    await expect(del('link-delete', { from_id: '{{step.pick.id}}', role: 'receipt' }))
      .rejects.toThrow(/'from_id' has no value/);
    expect(await linksLeft()).toBe(3);
    await expect(del('annotation-delete', { key: '{{step.pick.key}}' }))
      .rejects.toThrow(/annotation-delete: 'key' has no value/);
    expect(await annotationsLeft()).toBe(3);
  });

  it('⛔ a key the filter does not know is refused, alone or beside real ones', async () => {
    await expect(del('link-delete', { link_id: 'l-123' })).rejects.toThrow(/'link_id' is not a filter field/);
    await expect(del('link-delete', { link_id: 'l-123', role: 'receipt' })).rejects.toThrow(/'link_id' is not a filter field/);
    expect(await linksLeft()).toBe(3);
    // The author pin would have made the store's own check pass.
    await expect(del('annotation-delete', { annotation_id: 'a-1' }))
      .rejects.toThrow(/annotation-delete: 'annotation_id' is not a filter field/);
    expect(await annotationsLeft()).toBe(3);
  });

  it('a delete that names nothing is refused', async () => {
    await expect(del('link-delete', {})).rejects.toThrow(/link-delete: at least one filter field is required/);
    await expect(del('annotation-delete', { authored_by_recipe_id: 'r1' }))
      .rejects.toThrow(/annotation-delete: at least one filter field is required/);
    expect(await linksLeft()).toBe(3);
    expect(await annotationsLeft()).toBe(3);
  });

  it('a delete that names what it means deletes exactly that', async () => {
    expect(await del('link-delete', { from_collection: 'task', role: 'receipt' })).toMatchObject({ ok: true, deleted: 2 });
    expect((await annotations.listLinks({ from_collection: 'task' })).map((l) => l.role)).toEqual(['warranty']);
    expect(await del('annotation-delete', { key: 'summary' })).toMatchObject({ ok: true, deleted: 2 });
    expect((await annotations.listAnnotations({ target_collection: 'mail' })).map((a) => a.key)).toEqual(['risk']);
  });
});

describe('where a null is the caller\'s own, it keeps its meaning', () => {
  it('shared-compare-and-set: omitting expected_revision still means create-if-absent', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const cas = createIngredientExecutor({
      manifestLoader: async (slug) => KERNEL_MANIFESTS.find((m) => m.slug === slug) ?? null,
      kernelAdapter: createKernelAdapter({
        compareAndSet: async (input) => { seen.push(input as Record<string, unknown>); return { ok: true, revision: 1 }; },
      } as KernelDispatchers),
      adapterRegistry: {} as never,
    });
    // The manifest documents null as "create only if absent". Dispatch drops the
    // placeholder, so the case restores that default for an omitted revision…
    await cas('shared-compare-and-set', { key: 'cursor.a', value: { at: 1 } }, undefined, undefined, undefined);
    // …and a null the caller writes means the same.
    await cas('shared-compare-and-set', { key: 'cursor.a', expected_revision: null, value: { at: 1 } }, undefined, undefined, undefined);
    expect(seen.map((s) => s.expected_revision)).toEqual([null, null]);
  });
});

describe('shared-patch: a part the step leaves out is absent, not null', () => {
  it('a patch that only removes, and one that only sets, both reach the store as themselves', async () => {
    const shared = createSharedStore({ db, blobs: createBlobStore(join(dir, 'shared-blobs')) });
    const run = createIngredientExecutor({
      manifestLoader: async (slug) => KERNEL_MANIFESTS.find((m) => m.slug === slug) ?? null,
      kernelAdapter: createKernelAdapter({
        patch: (input) => handleSharedPatch({ store: shared }, input),
      } as KernelDispatchers),
      adapterRegistry: {} as never,
    });
    const key = 'data.shared.row.1';
    await handleSharedWrite({ store: shared }, { key, value: { status: 'open', task_id: 't-1' } });
    // The manifest declares `set` / `unset` / `match` as null placeholders; a
    // patch naming one part must reach the store with the others absent, or an
    // unset-only patch is refused as "set must be an object".
    expect(await run('shared-patch', { key, unset: ['task_id'] }, undefined, undefined, undefined))
      .toMatchObject({ found: true, applied: true });
    expect(await run('shared-patch', { key, set: { status: 'closed' } }, undefined, undefined, undefined))
      .toMatchObject({ applied: true });
    expect((await handleSharedRead({ store: shared }, { key })).value).toEqual({ status: 'closed' });
  });
});
