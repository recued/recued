/** Owner view settings in the realm database; its normal encryption/backup applies. */
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  RpcError, SAVED_DATA_VIEW_LIMIT, SAVED_DATA_VIEW_NAME_LIMIT,
  PACK_SAVED_VIEWS_PER_PACK_LIMIT, type SavedDataViewPackRef, type SavedDataViewDefinition,
  parseSavedDataViewDefinition, parseSavedDataViewAlertSettings, parseRecordsChangeCursor,
  sameSavedDataViewDefinition, sameSavedDataViewReviewScope,
  savedDataViewSupportsAlerts, savedDataViewSupportsReview, type SavedDataView,
  type SavedDataViewCreateRequest, type SavedDataViewRenameRequest,
  type SavedDataViewDeleteRequest, type SavedDataViewUpdateRequest,
  type SavedDataViewRetiredResolveRequest,
} from '@recued/contracts';
import { createSavedDataViewAlertStore, type SavedDataViewAlertStore, type SavedDataViewMatchReader } from './saved-data-view-alert-store.js';

export interface SavedDataViewStore {
  alerts: SavedDataViewAlertStore;
  list(): SavedDataView[];
  get(id: string): SavedDataView | null;
  create(request: SavedDataViewCreateRequest): SavedDataView;
  update(request: SavedDataViewUpdateRequest): SavedDataView;
  rename(request: SavedDataViewRenameRequest): SavedDataView;
  delete(request: SavedDataViewDeleteRequest): void;
  /** D-289 — owner-owned dismissal of a pack view. Survives reinstall. */
  setHidden(request: SavedDataViewDeleteRequest & { hidden: boolean }): SavedDataView;
  /** D-289 — re-assert one pack's views from its manifest. Install + reinstall. */
  syncPackViews(
    pack: SavedDataViewPackRef,
    views: ReadonlyArray<{ id: string; name: string; definition: SavedDataViewDefinition }>,
  ): { added: number; updated: number; retired: number };
  /** D-289 — drop the views a pack shipped. Uninstall.
   *
   *  ⚠ `publisher` OMITTED SWEEPS EVERY PUBLISHER WITH THAT SLUG, mirroring
   *  `removePackReceptionTemplates`, because the uninstall rpc carries only a
   *  slug — there is no publisher at that call site to narrow by. Two packs
   *  sharing a slug under different publishers is the case this cannot tell
   *  apart; the surviving pack's views return on its next install, since the
   *  sync is idempotent. Callers that DO know the publisher should pass it. */
  removePackViews(slug: string, publisher?: string): number;
  /** D-300 — the pack views an update stopped shipping that the owner had set up, kept
   *  for the owner to resolve. Never in `list()`, never watched by an alert. */
  listRetired(): SavedDataView[];
  /** D-300 — the owner's answer to one: set up a view the update added the same way,
   *  keep it as their own view, or dismiss it. Returns the view that carries the setup
   *  now (`null` on dismiss). */
  resolveRetired(request: SavedDataViewRetiredResolveRequest): SavedDataView | null;
}

const nameOf = (value: unknown): string => {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > SAVED_DATA_VIEW_NAME_LIMIT
    || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new RpcError('bad_request', `View name must be 1–${SAVED_DATA_VIEW_NAME_LIMIT} characters.`, 400);
  }
  return value.trim();
};
const requireId = (id: unknown): string => {
  if (typeof id !== 'string' || !/^view_[a-f0-9-]{36}$/.test(id)) {
    throw new RpcError('bad_request', 'Invalid saved view id.', 400);
  }
  return id;
};
const decode = (row: unknown): SavedDataView | null => {
  if (row === undefined) return null;
  const stored = row as { data: string };
  const parsed: SavedDataView = JSON.parse(stored.data);
  const definition = parseSavedDataViewDefinition(parsed.definition);
  if (definition === null) throw new RpcError('bad_request', 'This saved view is not supported by this server version.', 400);
  return { ...parsed, definition };
};

export const createSavedDataViewStore = (
  db: Database.Database,
  options: { readTasks?: SavedDataViewMatchReader; readRecords?: SavedDataViewMatchReader; now?: () => number } = {},
): SavedDataViewStore => {
  db.exec('CREATE TABLE IF NOT EXISTS saved_data_views (id TEXT PRIMARY KEY NOT NULL, data TEXT NOT NULL)');
  const alerts = createSavedDataViewAlertStore(db, { task: options.readTasks, records: options.readRecords }, options.now);
  /** Any row, a retired one included — the resolve path needs it; everything else asks
   *  `get`, to which a retired view no longer exists. */
  const getRow = (id: string): SavedDataView | null =>
    decode(db.prepare('SELECT data FROM saved_data_views WHERE id = ?').get(requireId(id)));
  const get = (id: string): SavedDataView | null => {
    const view = getRow(id);
    return view === null || view.retired !== undefined ? null : view;
  };
  const write = (view: SavedDataView, insert = false): void => {
    if (insert) {
      db.prepare('INSERT INTO saved_data_views (id, data) VALUES (?, ?)')
        .run(view.id, JSON.stringify(view));
      return;
    }
    db.prepare('UPDATE saved_data_views SET data = ? WHERE id = ?').run(JSON.stringify(view), view.id);
  };
  /** Every row, unsorted — the pack sync needs identity, not presentation. */
  const listAll = (): SavedDataView[] =>
    db.prepare('SELECT data FROM saved_data_views').all().map((row) => decode(row)!);
  /** D-289 — refuse a mutation the next pack install would silently undo.
   *
   *  ⛔ THE REFUSAL IS THE HONEST HALF OF A UI DECISION. The Data list renders
   *  no Rename/Delete on a pack view, so reaching here means a stale client, a
   *  scripted caller, or a race with an install — all cases where succeeding
   *  would be worse than refusing, because the change survives exactly until
   *  the next reinstall and then vanishes with no trace and no explanation
   *  (D-145 PA10: do not offer what the substrate reverses).
   *
   *  ⚠ PER-FIELD, NOT BLANKET. `alert`, `review` and `hidden` are the OWNER's
   *  on a pack view and must keep working; only `name` and `definition` are
   *  the pack's. A blanket refusal would make a pack view un-alertable, which
   *  is most of why anyone would want one. */
  const refusePackOwned = (view: SavedDataView, field: string): void => {
    if (view.pack === undefined) return;
    throw new RpcError('bad_request',
      `“${view.name}” comes from the ${view.pack.slug} pack, so its ${field} is set by the pack.`
      + ' Hide it instead, or uninstall the pack.', 400);
  };

  /** D-289 — only a PACK view can be hidden. An owner view has Delete;
   *  hiding it would be a second, weaker way to make a row go away, and two
   *  mechanisms for one intent is how a list ends up with rows nobody can
   *  account for. Shared by `update` and `setHidden` so the rule cannot be
   *  reached down a path that skips it. */
  const assertHideable = (view: SavedDataView): void => {
    if (view.pack !== undefined) return;
    throw new RpcError('bad_request', 'Only a pack view can be hidden. Delete your own views.', 400);
  };

  /** `SAVED_DATA_VIEW_LIMIT` is the OWNER's allowance: owner rows only. */
  const refuseOwnerLimit = (): void => {
    const count = db.prepare(
      `SELECT COUNT(*) AS count FROM saved_data_views
         WHERE json_extract(data, '$.pack') IS NULL`,
    ).get() as { count: number };
    if (count.count >= SAVED_DATA_VIEW_LIMIT) throw new RpcError('bad_request', `You can save up to ${SAVED_DATA_VIEW_LIMIT} views. Delete a view to make room.`, 400);
  };

  const current = (request: SavedDataViewDeleteRequest): SavedDataView => {
    const view = get(request.id);
    if (view === null) throw new RpcError('not_found', 'This saved view was deleted. Refresh your saved views.', 404);
    if (!Number.isSafeInteger(request.expected_revision) || request.expected_revision !== view.revision) {
      throw new RpcError('conflict', 'This saved view changed in another browser. Refresh it before trying again.', 409);
    }
    return view;
  };
  return {
    alerts,
    get,
    list: () => db.prepare('SELECT data FROM saved_data_views ORDER BY id').all()
      .map((row) => decode(row)!).filter((view) => view.retired === undefined)
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)),
    create: db.transaction((request: SavedDataViewCreateRequest) => {
      const name = nameOf(request.name);
      const definition = parseSavedDataViewDefinition(request.definition);
      if (definition === null) throw new RpcError('bad_request', 'Invalid saved view settings.', 400);
      // ⛔ OWNER ROWS ONLY. `SAVED_DATA_VIEW_LIMIT` is the OWNER's allowance
      // (owner's ruling, 2026-09-22): counting pack views here would make
      // installing a pack silently spend slots, and the refusal below would
      // then blame the owner — "Delete a view to make room" — for space a pack
      // took. Pack views are capped separately, per pack, at sync time.
      refuseOwnerLimit();
      const now = Date.now();
      const view: SavedDataView = { id: `view_${randomUUID()}`, name, definition, revision: 1, created_at: now, updated_at: now };
      db.prepare('INSERT INTO saved_data_views (id, data) VALUES (?, ?)').run(view.id, JSON.stringify(view));
      return view;
    }),
    update: db.transaction((request: SavedDataViewUpdateRequest) => {
      const view = current(request);
      if (!Object.hasOwn(request, 'definition') && !Object.hasOwn(request, 'alert')
        && !Object.hasOwn(request, 'review') && !Object.hasOwn(request, 'hidden')) {
        throw new RpcError('bad_request',
          'Provide saved view settings, alert settings, a review mark, or a hidden flag.', 400);
      }
      if (Object.hasOwn(request, 'definition')) refusePackOwned(view, 'settings');
      const definition = Object.hasOwn(request, 'definition')
        ? parseSavedDataViewDefinition(request.definition) : view.definition;
      if (definition === null) throw new RpcError('bad_request', 'Invalid saved view settings.', 400);
      const updated: SavedDataView = { ...view, definition, revision: view.revision + 1, updated_at: Date.now() };
      if (Object.hasOwn(request, 'alert')) {
        const settings = parseSavedDataViewAlertSettings(request.alert);
        if (settings === null) throw new RpcError('bad_request', 'Invalid alert settings.', 400);
        updated.alert = alerts.configure(updated, settings);
      } else if (!savedDataViewSupportsAlerts(definition)) {
        delete updated.alert;
        alerts.clear(view.id);
      } else if (view.alert?.enabled && !sameSavedDataViewDefinition(view.definition, definition)) {
        updated.alert = alerts.configure(updated, view.alert);
      }
      // P2/F2 review mark. Mirrors the alert block above and inherits its
      // shape for the same reason: a mark, like an alert, is state ABOUT a view
      // that a definition edit can invalidate.
      if (Object.hasOwn(request, 'review')) {
        if (request.review === null) {
          delete updated.review;
        } else {
          if (!savedDataViewSupportsReview(definition)) {
            throw new RpcError('bad_request',
              'Only a Records view with a pack and kind selected can be marked reviewed.', 400);
          }
          const cursor = parseRecordsChangeCursor(request.review);
          if (cursor === null) throw new RpcError('bad_request', 'Invalid review mark.', 400);
          updated.review = { reviewed_through: cursor, reviewed_at: Date.now() };
        }
      } else if (!savedDataViewSupportsReview(definition)
        || !sameSavedDataViewReviewScope(view.definition, definition)) {
        // ⛔ DROP IT RATHER THAN CARRY IT. Repointing the view at another pack
        // or entity leaves the stored cursor addressing a stream it was never
        // taken from, and a stale mark there does not merely mislead — it makes
        // the feed SILENTLY SKIP everything before that position in the new
        // stream. Losing the mark costs one re-read; keeping it hides changes.
        delete updated.review;
      }
      // D-289 — the owner's dismissal of a pack view. Same guard as the
      // standalone `setHidden`, because there is one rule and it must not be
      // possible to reach the write down a path that skips it.
      if (Object.hasOwn(request, 'hidden')) {
        assertHideable(view);
        if (request.hidden === true) updated.hidden = true; else delete updated.hidden;
      }
      write(updated);
      return updated;
    }),
    rename: db.transaction((request: SavedDataViewRenameRequest) => {
      const view = current(request);
      refusePackOwned(view, 'name');
      const renamed = { ...view, name: nameOf(request.name), revision: view.revision + 1, updated_at: Date.now() };
      write(renamed);
      return renamed;
    }),
    delete: db.transaction((request: SavedDataViewDeleteRequest) => {
      refusePackOwned(current(request), 'presence');
      alerts.clear(request.id);
      db.prepare('DELETE FROM saved_data_views WHERE id = ?').run(request.id);
    }),
    setHidden: db.transaction((request: SavedDataViewDeleteRequest & { hidden: boolean }) => {
      const view = current(request);
      assertHideable(view);
      const updated: SavedDataView = { ...view, revision: view.revision + 1, updated_at: Date.now() };
      if (request.hidden) updated.hidden = true; else delete updated.hidden;
      write(updated);
      return updated;
    }),
    /** ⛔ IN-PLACE, NOT REPLACE-CLEAN — see `pack-saved-views.ts`. Pack-owned
     *  fields are re-asserted; `hidden`, `alert`, `review` and `created_at` are
     *  carried across untouched, because they are the owner's answer to a view
     *  and a reinstall is not a question. */
    syncPackViews: db.transaction((
      pack: SavedDataViewPackRef,
      views: ReadonlyArray<{ id: string; name: string; definition: SavedDataViewDefinition }>,
    ) => {
      if (views.length > PACK_SAVED_VIEWS_PER_PACK_LIMIT) {
        throw new RpcError('bad_request',
          `The ${pack.slug} pack ships ${views.length} views; at most `
          + `${PACK_SAVED_VIEWS_PER_PACK_LIMIT} are allowed.`, 400);
      }
      const now = Date.now();
      const existing = new Map(listAll()
        .filter((v) => v.pack?.publisher === pack.publisher && v.pack.slug === pack.slug)
        .map((v) => [v.id, v] as const));
      let added = 0; let updated = 0;
      // D-300 — the views this update brings that the pack did not ship before: what a
      // view it stops shipping was most likely renamed to.
      const replacements = views
        .filter((declared) => !existing.has(declared.id))
        .map((declared) => ({ id: declared.id, name: declared.name }));
      for (const declared of views) {
        const prior = existing.get(declared.id);
        if (prior === undefined) {
          write({ id: declared.id, name: declared.name, definition: declared.definition,
            revision: 1, created_at: now, updated_at: now, pack }, true);
          added += 1;
          continue;
        }
        existing.delete(declared.id);
        // D-300 — a view an earlier update retired, shipped again under its old name:
        // it comes back as the owner left it, alert included.
        if (prior.retired !== undefined) {
          const revived: SavedDataView = { ...prior, name: declared.name, definition: declared.definition,
            revision: prior.revision + 1, updated_at: now };
          delete revived.retired;
          if (prior.retired.alert && savedDataViewSupportsAlerts(declared.definition)) {
            revived.alert = alerts.configure(revived, prior.retired.alert);
          }
          write(revived);
          updated += 1;
          continue;
        }
        // Unchanged declaration ⇒ no write, so a boot re-scan does not churn
        // `revision` and invalidate every client's CAS for nothing.
        if (prior.name === declared.name
          && sameSavedDataViewDefinition(prior.definition, declared.definition)) continue;
        write({ ...prior, name: declared.name, definition: declared.definition,
          revision: prior.revision + 1, updated_at: now });
        updated += 1;
      }
      // Whatever this pack shipped before and no longer does.
      // ⛔ D-300 — a view the owner set up (hidden it, put an alert on it, reviewed it) is
      // KEPT, retired, for them to resolve: a rename mints a new id (identity is
      // publisher + slug + name) and nothing can tell which new view replaces which old
      // one (the D-293 no-rename ruling), so deleting it dropped the owner's setup with no
      // trace. Its alert stops watching; the settings wait in `retired.alert`. A view with
      // nothing of the owner's on it goes, as before.
      for (const [staleId, stale] of existing) {
        alerts.clear(staleId);
        if (stale.retired !== undefined) continue;
        const setUp = stale.hidden === true || stale.alert?.enabled === true || stale.review !== undefined;
        if (!setUp) {
          db.prepare('DELETE FROM saved_data_views WHERE id = ?').run(staleId);
          continue;
        }
        const retired: SavedDataView = {
          ...stale,
          retired: {
            at: now,
            replacements,
            ...(stale.alert?.enabled === true
              ? { alert: { enabled: true, time_zone: stale.alert.time_zone } }
              : {}),
          },
        };
        delete retired.alert;
        write(retired);
      }
      return { added, updated, retired: existing.size };
    }),
    listRetired: () => listAll().filter((view) => view.retired !== undefined)
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)),
    resolveRetired: db.transaction((request: SavedDataViewRetiredResolveRequest) => {
      const view = getRow(requireId(request?.id));
      if (view === null || view.retired === undefined) {
        throw new RpcError('not_found', 'This view was already dealt with. Refresh your saved views.', 404);
      }
      const retirement = view.retired;
      const remove = (): void => {
        alerts.clear(view.id);
        db.prepare('DELETE FROM saved_data_views WHERE id = ?').run(view.id);
      };
      const now = Date.now();
      if (request.action === 'dismiss') {
        remove();
        return null;
      }
      if (request.action === 'keep') {
        // A FRESH id: the old one is the pack's (publisher + slug + name), and a later
        // update shipping that name again would collide with the owner's copy.
        refuseOwnerLimit();
        const kept: SavedDataView = { id: `view_${randomUUID()}`, name: view.name, definition: view.definition,
          revision: 1, created_at: now, updated_at: now };
        if (retirement.alert && savedDataViewSupportsAlerts(kept.definition)) {
          write(kept, true);
          kept.alert = alerts.configure(kept, retirement.alert);
          write(kept);
        } else {
          write(kept, true);
        }
        remove();
        return kept;
      }
      if (request.action !== 'apply') {
        throw new RpcError('bad_request', 'Choose apply, keep or dismiss.', 400);
      }
      const target = get(requireId(request.to_id));
      if (target === null || target.pack === undefined
        || target.pack.slug !== view.pack?.slug || target.pack.publisher !== view.pack.publisher) {
        throw new RpcError('bad_request', 'Pick one of the views this pack update added.', 400);
      }
      const updated: SavedDataView = { ...target, revision: target.revision + 1, updated_at: now };
      if (view.hidden === true) updated.hidden = true;
      if (retirement.alert && savedDataViewSupportsAlerts(target.definition)) {
        updated.alert = alerts.configure(updated, retirement.alert);
      }
      // ⛔ The mark is a cursor into ONE stream; carried to another it would make the feed
      // silently skip everything before it. Same rule as `update`.
      if (view.review !== undefined && savedDataViewSupportsReview(target.definition)
        && sameSavedDataViewReviewScope(view.definition, target.definition)) {
        updated.review = view.review;
      }
      write(updated);
      remove();
      return updated;
    }),
    removePackViews: db.transaction((slug: string, publisher?: string) => {
      const mine = listAll().filter((v) => v.pack?.slug === slug
        && (publisher === undefined || v.pack.publisher === publisher));
      for (const view of mine) {
        alerts.clear(view.id);
        db.prepare('DELETE FROM saved_data_views WHERE id = ?').run(view.id);
      }
      return mine.length;
    }),
  };
};
