import type Database from 'better-sqlite3';
import type { Asset, SituationRef, Sphere } from '@recued/contracts';
import type { WorkEntityStore } from './work-entity-store.js';

export interface SpherePlacement { sphere?: Sphere; reason: string; pinned: boolean; source?: string }
interface ItemPlacement { sphere: Sphere; source: string | null }
export const createSphereStore = (db: Database.Database, work?: WorkEntityStore,
  contactRelationship?: (id: string) => 'family' | 'friend' | 'colleague' | 'client' | undefined,
  sourceForReference?: (ref: SituationRef) => { source?: string; sphere?: Sphere } | undefined) => {
  db.exec(`CREATE TABLE IF NOT EXISTS sphere_sources (source TEXT PRIMARY KEY, sphere TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sphere_items (collection TEXT NOT NULL, id TEXT NOT NULL, sphere TEXT NOT NULL, source TEXT,
      PRIMARY KEY(collection,id));`);
  const sourcePlacement = (source: string): Sphere | undefined =>
    (db.prepare('SELECT sphere FROM sphere_sources WHERE source=?').get(source) as { sphere: Sphere } | undefined)?.sphere;
  const pinnedPlacement = (item: ItemPlacement, source?: string): SpherePlacement => ({ sphere: item.sphere, reason: 'placed by you', pinned: true,
    ...(source ?? item.source ? { source: source ?? item.source! } : {}) });
  const fromSourceOrDerived = (source: string | undefined, derived: Sphere | undefined, lookup = sourcePlacement): SpherePlacement => {
    const placed = source ? lookup(source) ?? (source.startsWith('calendar:') && source.split(':').length > 2 ? lookup(source.split(':').slice(0, 2).join(':')) : undefined) : undefined;
    if (placed) return { sphere: placed, reason: `from: ${source}`, pinned: false, source };
    if (!derived && source && /^work:(?:jira|asana|linear)(?:[.:/]|$)/u.test(source)) derived = 'professional';
    return { ...(derived ? { sphere: derived } : {}), reason: derived ? 'from: source or relationship' : 'unsorted', pinned: false, ...(source ? { source } : {}) };
  };
  const assetPlacement = (id: string, asset: Asset | null, source: string | undefined, derived: Sphere | undefined, lookup = sourcePlacement): SpherePlacement => {
    if (asset?.sphere_override) return { sphere: asset.sphere_override, reason: 'placed by you', pinned: true, source: `work:${asset.source_id}` };
    source ??= asset ? `work:${asset.source_id}` : undefined;
    derived ??= asset?.sphere;
    const placed = lookup(`asset:${id}`);
    if (placed) return { sphere: placed, reason: 'from: asset placement', pinned: false, source: `asset:${id}` };
    return fromSourceOrDerived(source, derived, lookup);
  };
  const resolve = (ref: SituationRef, source?: string, derived?: Sphere, visiting = new Set<string>()): SpherePlacement => {
    const key = JSON.stringify([ref.collection, ref.id]);
    if (visiting.has(key)) return { reason: 'unsorted', pinned: false };
    visiting.add(key);
    const origin = sourceForReference?.(ref); source ??= origin?.source; derived ??= origin?.sphere;
    const item = db.prepare('SELECT sphere,source FROM sphere_items WHERE collection=? AND id=?').get(ref.collection, ref.id) as ItemPlacement | undefined;
    if (item) return pinnedPlacement(item, source);
    if (ref.collection === 'asset' && work) {
      return assetPlacement(ref.id, work.readAssetEffective(ref.id), source, derived);
    } else if (ref.collection === 'commitment' && work) {
      const commitment = work.readCommitment(ref.id);
      source ??= commitment ? `work:${commitment.source_id}` : undefined;
      // §4.11 — an occurrence follows its asset (or occasion) before the
      // commitment source's default; only its own pin, above, comes first.
      const occurrence_id = commitment?.source_extension_blob?.occurrence_id;
      const hasOccurrences = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='asset_occurrences'").get();
      const occurrence = typeof occurrence_id === 'string' && hasOccurrences
        ? db.prepare('SELECT * FROM asset_occurrences WHERE id=?').get(occurrence_id) as { asset_id: string; subject_kind?: string } | undefined : undefined;
      if (occurrence) {
        const kind = occurrence.subject_kind === 'occasion' ? 'occasion' : 'asset';
        const placement = resolve({ collection: kind, id: occurrence.asset_id }, undefined, undefined, visiting);
        if (placement.sphere) return { sphere: placement.sphere, reason: `from: ${kind}`, pinned: false, source: `${kind}:${occurrence.asset_id}` };
      }
      const direct = source ? sourcePlacement(source) : undefined;
      if (direct) return { sphere: direct, reason: `from: ${source}`, pinned: false, source };
      if (commitment?.counterparty_contact_id) derived ??= resolve({ collection: 'contact', id: commitment.counterparty_contact_id }, undefined, undefined, visiting).sphere;
    } else if (ref.collection === 'occasion' || ref.collection === 'episode') {
      const table = ref.collection === 'occasion' ? 'proactive_occasions' : 'proactive_episodes';
      if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) {
        const row = db.prepare(`SELECT value FROM ${table} WHERE id=?`).get(ref.id) as { value: string } | undefined;
        const value = row ? JSON.parse(row.value) as { sphere?: Sphere; source?: SituationRef } : undefined;
        derived ??= value?.sphere;
        if (!derived && value?.source) derived = resolve(value.source, undefined, undefined, visiting).sphere;
      }
      source ??= `${ref.collection}:${ref.id}`;
    } else if (ref.collection === 'contact') {
      source ??= `contact:${ref.id}`;
      const relationship = contactRelationship?.(ref.id);
      derived ??= relationship === 'family' || relationship === 'friend' ? 'personal'
        : relationship === 'colleague' || relationship === 'client' ? 'professional' : undefined;
    } else if (work && ['task', 'note', 'booking', 'project'].includes(ref.collection)) {
      const row = work.readByKind(ref.collection as 'task' | 'note' | 'booking' | 'project', ref.id);
      source ??= row ? `work:${row.source_id}` : undefined;
    } else if (ref.collection === 'calendar') {
      const index = ref.id.indexOf(':');
      if (index > 0) source ??= `calendar:${ref.id.slice(0, index)}`;
    } else if (ref.collection === 'mail') {
      const index = ref.id.indexOf(':');
      if (index > 0) source ??= `mail:${ref.id.slice(0, index)}`;
    }
    return fromSourceOrDerived(source, derived);
  };
  /** Bounded owner reads. All lookup maps belong to this call, so pins, source
   * defaults and inherited facts are read afresh on the next snapshot. */
  const resolveAssets = (ids: readonly string[]): Map<string, SpherePlacement> => {
    const result = new Map<string, SpherePlacement>(); const keys = [...new Set(ids)];
    if (!work) return new Map(keys.map(id => [id, resolve({ collection: 'asset', id })]));
    for (let offset = 0; offset < keys.length; offset += 200) {
      const page = keys.slice(offset, offset + 200);
      const origins = new Map(page.map(id => [id, sourceForReference?.({ collection: 'asset', id })]));
      const items = new Map((db.prepare(`SELECT id,sphere,source FROM sphere_items WHERE collection='asset' AND id IN (${page.map(() => '?').join(',')})`)
        .all(...page) as Array<ItemPlacement & { id: string }>).map(row => [row.id, row]));
      const unpinned = page.filter(id => !items.has(id));
      const assets = work.readAssetsEffective(unpinned); const sources = new Set<string>();
      for (const id of unpinned) {
        const asset = assets.get(id); if (asset?.sphere_override) continue;
        sources.add(`asset:${id}`);
        const source = origins.get(id)?.source ?? (asset ? `work:${asset.source_id}` : undefined);
        if (source) {
          sources.add(source);
          if (source.startsWith('calendar:') && source.split(':').length > 2) sources.add(source.split(':').slice(0, 2).join(':'));
        }
      }
      const placements = new Map<string, Sphere>(); const sourceKeys = [...sources];
      for (let skip = 0; skip < sourceKeys.length; skip += 200) {
        const group = sourceKeys.slice(skip, skip + 200);
        for (const row of db.prepare(`SELECT source,sphere FROM sphere_sources WHERE source IN (${group.map(() => '?').join(',')})`)
          .all(...group) as Array<{ source: string; sphere: Sphere }>) placements.set(row.source, row.sphere);
      }
      for (const id of page) {
        const item = items.get(id); const origin = origins.get(id);
        result.set(id, item ? pinnedPlacement(item, origin?.source)
          : assetPlacement(id, assets.get(id) ?? null, origin?.source, origin?.sphere, source => placements.get(source)));
      }
    }
    return result;
  };
  const validateSphere = (sphere: Sphere | null) => { if (sphere !== null && sphere !== 'personal' && sphere !== 'professional') throw new Error('Choose personal, professional or reset'); };
  return {
    resolve, resolveAssets, sourcePlacement,
    setItem(ref: SituationRef, sphere: Sphere | null): void {
      validateSphere(sphere);
      if (!ref || typeof ref.collection !== 'string' || !ref.collection || typeof ref.id !== 'string' || !ref.id || ref.id.length > 2000) throw new Error('Invalid sphere item');
      const placement = resolve(ref);
      if (sphere === null) db.prepare('DELETE FROM sphere_items WHERE collection=? AND id=?').run(ref.collection, ref.id);
      else db.prepare('INSERT INTO sphere_items(collection,id,sphere,source) VALUES(?,?,?,?) ON CONFLICT(collection,id) DO UPDATE SET sphere=excluded.sphere,source=excluded.source')
        .run(ref.collection, ref.id, sphere, placement.source ?? null);
    },
    setSource(source: string, sphere: Sphere | null): { retained: number } {
      validateSphere(sphere);
      if (typeof source !== 'string' || !source.trim() || source.length > 2000) throw new Error('Invalid sphere source');
      const retained = (db.prepare('SELECT count(*) AS n FROM sphere_items WHERE source=?').get(source) as { n: number }).n;
      if (sphere === null) db.prepare('DELETE FROM sphere_sources WHERE source=?').run(source);
      else db.prepare('INSERT INTO sphere_sources(source,sphere) VALUES(?,?) ON CONFLICT(source) DO UPDATE SET sphere=excluded.sphere').run(source, sphere);
      return { retained };
    },
    sources: (): Array<{ source: string; sphere: Sphere }> => db.prepare('SELECT * FROM sphere_sources ORDER BY source').all() as Array<{ source: string; sphere: Sphere }>,
  };
};
export type SphereStore = ReturnType<typeof createSphereStore>;
