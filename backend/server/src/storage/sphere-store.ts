import type Database from 'better-sqlite3';
import type { Asset, SituationRef, Sphere } from '@recued/contracts';
import { ASSET_TABLE, assetListWhere, createAssetSummaryHistoryBatch, hasNativeAssetProjection, rowToAsset, type AssetRow, type WorkEntityListQuery, type WorkEntityStore } from './work-entity-store.js';
import { bindSqliteReadBatch, createSqliteReadBatch } from './sqlite-read-batch.js';

export interface SpherePlacement { sphere?: Sphere; reason: string; pinned: boolean; source?: string }
export type SphereOriginResolver = (ref: SituationRef) => { source?: string; sphere?: Sphere } | undefined;
const nonAssetResolvers = new WeakSet<SphereOriginResolver>();
/** Route only non-asset origins to a callback. Assets retain native projection. */
export const nonAssetSphereOrigins = (resolve: SphereOriginResolver): SphereOriginResolver => {
  const native: SphereOriginResolver = ref => ref.collection === 'asset' ? undefined : resolve(ref);
  nonAssetResolvers.add(native); return native;
};
export interface AssetPlacementReadBatch {
  read(id: string): SpherePlacement | undefined;
  wrote(rows: number, connection: Database.Database): void;
  invalidate(): void;
}
interface ItemPlacement { sphere: Sphere; source: string | null }
interface AssetPlacementRow {
  id: string; source: string | null; fallback: string | null;
  pinned_sphere: Sphere | null; pinned_source: string | null;
  asset_sphere: Sphere | null; source_sphere: Sphere | null; fallback_sphere: Sphere | null;
}
export interface AssetSpherePage {
  ids: string[];
  total: number;
  placements: Map<string, SpherePlacement>;
}
export interface AssetSphereBatch {
  assets: Asset[];
  placements: Map<string, SpherePlacement>;
}
interface AssetSphereRow {
  id: string | null; source_id: string; sphere_override: Sphere | null; inherited_sphere: Sphere | null;
  pinned_sphere: Sphere | null; pinned_source: string | null;
  asset_sphere: Sphere | null; source_sphere: Sphere | null;
}
export const createSphereStore = (db: Database.Database, work?: WorkEntityStore,
  contactRelationship?: (id: string) => 'family' | 'friend' | 'colleague' | 'client' | undefined,
  sourceForReference?: SphereOriginResolver) => {
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
  const assetPlacement = (id: string, asset: Pick<Asset, 'source_id' | 'sphere_override' | 'sphere'> | null, source: string | undefined, derived: Sphere | undefined, lookup = sourcePlacement): SpherePlacement => {
    if (asset?.sphere_override) return { sphere: asset.sphere_override, reason: 'placed by you', pinned: true, source: `work:${asset.source_id}` };
    source ??= asset ? `work:${asset.source_id}` : undefined;
    derived ??= asset?.sphere;
    const placed = lookup(`asset:${id}`);
    if (placed) return { sphere: placed, reason: 'from: asset placement', pinned: false, source: `asset:${id}` };
    return fromSourceOrDerived(source, derived, lookup);
  };
  const resolveKnownOrigin = (ref: SituationRef, source: string | undefined, derived: Sphere | undefined,
    visiting: Set<string>, origin: ReturnType<NonNullable<typeof sourceForReference>>): SpherePlacement => {
    const key = JSON.stringify([ref.collection, ref.id]);
    if (visiting.has(key)) return { reason: 'unsorted', pinned: false };
    visiting.add(key);
    source ??= origin?.source; derived ??= origin?.sphere;
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
  const resolve = (ref: SituationRef, source?: string, derived?: Sphere, visiting = new Set<string>()): SpherePlacement => {
    if (visiting.has(JSON.stringify([ref.collection, ref.id]))) return { reason: 'unsorted', pinned: false };
    return resolveKnownOrigin(ref, source, derived, visiting, sourceForReference?.(ref));
  };
  /** Bounded owner reads. Optional raw scan rows belong to the current synchronous
   * selection only. The shared projection reader fetches missing ancestors;
   * all other calls, including reads after an await, load fresh facts. */
  const projectAssets = (ids: readonly string[], scanned: readonly Asset[] | undefined,
    originFor: typeof sourceForReference): Map<string, SpherePlacement> => {
    const result = new Map<string, SpherePlacement>(); const keys = [...new Set(ids)];
    if (!work) return new Map(keys.map(id => [id, resolve({ collection: 'asset', id })]));
    const known = new Map(scanned?.map(asset => [asset.id, asset]));
    for (let offset = 0; offset < keys.length; offset += 200) {
      const page = keys.slice(offset, offset + 200);
      const origins = new Map(page.map(id => [id, originFor?.({ collection: 'asset', id })]));
      let combined: AssetPlacementRow[] | undefined;
      if (page.every(id => known.has(id))) {
        // Source identity does not inherit. Read metadata before projecting only
        // unpinned assets, so a pin still shields a broken ancestor.
        const requested = page.map(id => {
          const asset = known.get(id)!;
          const source = asset.sphere_override ? null : origins.get(id)?.source ?? `work:${asset.source_id}`;
          const fallback = source?.startsWith('calendar:') && source.split(':').length > 2 ? source.split(':').slice(0, 2).join(':') : null;
          return [id, source, fallback];
        });
        try {
          combined = db.prepare(`WITH asset_placement_requested(id,source,fallback) AS (VALUES ${page.map(() => '(?,?,?)').join(',')})
            SELECT wanted.id,wanted.source,wanted.fallback,item.sphere AS pinned_sphere,item.source AS pinned_source,
              asset_source.sphere AS asset_sphere,origin_source.sphere AS source_sphere,calendar_source.sphere AS fallback_sphere
            FROM asset_placement_requested wanted
              LEFT JOIN sphere_items item ON item.collection='asset' AND item.id=wanted.id
              LEFT JOIN sphere_sources asset_source ON item.id IS NULL AND wanted.source IS NOT NULL AND asset_source.source='asset:' || wanted.id
              LEFT JOIN sphere_sources origin_source ON item.id IS NULL AND COALESCE(asset_source.sphere,'')='' AND origin_source.source=wanted.source
              LEFT JOIN sphere_sources calendar_source ON item.id IS NULL AND COALESCE(asset_source.sphere,'')=''
                AND COALESCE(origin_source.sphere,'')='' AND calendar_source.source=wanted.fallback`).all(...requested.flat()) as AssetPlacementRow[];
        } catch { /* Retain the original bounded metadata reads and their error behavior. */ }
      }
      const items = combined ? new Map(combined.flatMap(row => row.pinned_sphere === null ? []
        : [[row.id, { sphere: row.pinned_sphere, source: row.pinned_source }] as const]))
        : new Map((db.prepare(`SELECT id,sphere,source FROM sphere_items WHERE collection='asset' AND id IN (${page.map(() => '?').join(',')})`)
          .all(...page) as Array<ItemPlacement & { id: string }>).map(row => [row.id, row]));
      const unpinned = page.filter(id => !items.has(id));
      const assets = scanned ? work.readAssetsEffective(unpinned, scanned) : work.readAssetsEffective(unpinned);
      const placements = new Map<string, Sphere>();
      if (combined) {
        for (const row of combined) {
          if (row.asset_sphere !== null) placements.set(`asset:${row.id}`, row.asset_sphere);
          if (row.source !== null && row.source_sphere !== null) placements.set(row.source, row.source_sphere);
          if (row.fallback !== null && row.fallback_sphere !== null) placements.set(row.fallback, row.fallback_sphere);
        }
      } else {
        const sources = new Set<string>();
        for (const id of unpinned) {
          const asset = assets.get(id); if (asset?.sphere_override) continue;
          sources.add(`asset:${id}`);
          const source = origins.get(id)?.source ?? (asset ? `work:${asset.source_id}` : undefined);
          if (source) {
            sources.add(source);
            if (source.startsWith('calendar:') && source.split(':').length > 2) sources.add(source.split(':').slice(0, 2).join(':'));
          }
        }
        const sourceKeys = [...sources];
        for (let skip = 0; skip < sourceKeys.length; skip += 200) {
          const group = sourceKeys.slice(skip, skip + 200);
          for (const row of db.prepare(`SELECT source,sphere FROM sphere_sources WHERE source IN (${group.map(() => '?').join(',')})`)
            .all(...group) as Array<{ source: string; sphere: Sphere }>) placements.set(row.source, row.sphere);
        }
      }
      for (const id of page) {
        const item = items.get(id); const origin = origins.get(id);
        result.set(id, item ? pinnedPlacement(item, origin?.source)
          : assetPlacement(id, assets.get(id) ?? null, origin?.source, origin?.sphere, source => placements.get(source)));
      }
    }
    return result;
  };
  const resolveAssets = (ids: readonly string[], scanned?: readonly Asset[]): Map<string, SpherePlacement> => projectAssets(ids, scanned, sourceForReference);
  /** A synchronous publication page may write situations and acknowledgements.
   * Reuse placements only while SQLite reports exactly those accounted writes.
   * Any listener write, external commit, schema change or custom projection
   * discards the batch. Origin callbacks still run once, in event order. */
  function prefetchAssetPlacements(this: { resolve: typeof resolve; resolveAssets: typeof resolveAssets }, ids: readonly string[]): AssetPlacementReadBatch | undefined {
    const owner = this;
    const usable = () => {
      try { return !!work && owner?.resolve === resolve && owner.resolveAssets === resolveAssets && work.hasDefaultAssetProjection(); }
      catch { return false; }
    };
    if (!ids.length || !usable()) return undefined;
    const version = createSqliteReadBatch(db);
    const placements = projectAssets(ids, undefined, undefined);
    if (!version.current()) return undefined;
    let active = true;
    const invalidate = () => { active = false; placements.clear(); version.invalidate(); };
    const batch: AssetPlacementReadBatch = {
      invalidate,
      wrote(rows, connection) { if (!version.wrote(rows, connection)) invalidate(); },
      read(id) {
        if (!active || !usable() || !placements.has(id)) { invalidate(); return undefined; }
        const ref = { collection: 'asset', id }; const origin = sourceForReference?.(ref);
        if (!usable()) invalidate();
        // Explicit origins already require fresh point resolution. Check the
        // batch only before a later event actually reuses a cached placement.
        if (origin?.source !== undefined || origin?.sphere !== undefined) return resolveKnownOrigin(ref, undefined, undefined, new Set(), origin);
        if (active) { try { if (!version.current()) invalidate(); } catch { invalidate(); } }
        if (active) return placements.get(id);
        return resolveKnownOrigin(ref, undefined, undefined, new Set(), origin);
      },
    };
    const read = batch.read;
    const shareable = () => Object.getOwnPropertyDescriptor(batch, 'read')?.value === read
      && !!work && hasNativeAssetProjection(work)
      && (!sourceForReference || nonAssetResolvers.has(sourceForReference)) && Object.getOwnPropertyDescriptor(owner, 'resolve')?.value === resolve
      && Object.getOwnPropertyDescriptor(owner, 'resolveAssets')?.value === resolveAssets && usable();
    if (shareable()) bindSqliteReadBatch(batch, version, shareable);
    return batch;
  }
  // Pass the selected IDs back to SQLite as one bounded value. Larger rosters
  // retain the original membership query instead of growing a JS asset cache.
  const historyMembershipLimit = 1024 * 1024;
  let historyScope: { sphere: Sphere | 'unsorted'; key: string; checked: boolean; members?: string } | undefined;
  const assetSphereSql = (query?: Pick<WorkEntityListQuery, 'search' | 'limit' | 'offset'>, safetyChecked = false) => {
    const { norm, where } = assetListWhere(query);
    // Canonical columns determine membership. Fall back for legacy blobs that
    // could change projection behavior, including a malformed ignored parent.
    // Duplicate keys differ between SQLite path lookup and JSON.parse.
    const canonical = (row: string) => safetyChecked ? '1' : `CASE WHEN json_valid(${row}.data_blob) THEN CASE WHEN
      typeof(${row}.id)='text' AND json_type(${row}.data_blob)='object' AND json_type(${row}.data_blob,'$.anchors')='array'
      AND NOT EXISTS (SELECT 1 FROM json_each(${row}.data_blob,'$.anchors') WHERE type='null')
      AND NOT EXISTS (SELECT 1 FROM json_each(${row}.data_blob) GROUP BY key HAVING COUNT(*)>1 OR key NOT IN
        ('dates','readings','observations','values','anchors','attributes','settings','rules','field_sources','automatic_updates'))
      AND (${row}.sphere IS NULL OR ${row}.sphere IN ('personal','professional'))
      AND (${row}.sphere_override IS NULL OR ${row}.sphere_override IN ('personal','professional'))
      THEN 1 ELSE 0 END ELSE 0 END`;
    return { norm, key: JSON.stringify(where), params: where.params, sql: `WITH RECURSIVE asset_sphere_roots AS MATERIALIZED (
      SELECT id,source_id,belongs_to,sphere,sphere_override,updated_at,${canonical('asset')} AS valid
      FROM ${ASSET_TABLE} asset ${where.sql}
    ), asset_sphere_walk(root_id,id,belongs_to,sphere,path,depth,stopped,invalid) AS (
      SELECT root.id,root.id,root.belongs_to,COALESCE(root.sphere_override,root.sphere),json_array(root.id),0,0,1-root.valid
      FROM asset_sphere_roots root LEFT JOIN sphere_items pin ON pin.collection='asset' AND pin.id=root.id WHERE pin.id IS NULL
      UNION ALL
      SELECT walk.root_id,parent.id,parent.belongs_to,
        CASE WHEN parent.deleted_at IS NULL THEN COALESCE(walk.sphere,parent.sphere_override,parent.sphere) ELSE walk.sphere END,
        json_insert(walk.path,'$[#]',parent.id),walk.depth+1,parent.deleted_at IS NOT NULL,MAX(walk.invalid,1-${canonical('parent')})
      FROM asset_sphere_walk walk JOIN ${ASSET_TABLE} parent ON parent.id=walk.belongs_to
      WHERE walk.stopped=0 AND walk.depth<64 AND walk.belongs_to<>'' AND NOT EXISTS (SELECT 1 FROM json_each(walk.path) WHERE value=parent.id)
    ), asset_sphere_inherited AS (
      SELECT root_id,MAX(sphere) AS sphere FROM asset_sphere_walk GROUP BY root_id
    ), asset_sphere_matches AS MATERIALIZED (
      SELECT root.id,root.updated_at,root.source_id,root.sphere_override,inherited.sphere AS inherited_sphere,
        pin.sphere AS pinned_sphere,pin.source AS pinned_source,asset_source.sphere AS asset_sphere,origin_source.sphere AS source_sphere,
        COALESCE(pin.sphere,root.sphere_override,NULLIF(asset_source.sphere,''),NULLIF(origin_source.sphere,''),inherited.sphere,
          CASE WHEN root.source_id IN ('jira','asana','linear') OR root.source_id GLOB 'jira[.:/]*'
            OR root.source_id GLOB 'asana[.:/]*' OR root.source_id GLOB 'linear[.:/]*' THEN 'professional' END,'unsorted') AS resolved_sphere
      FROM asset_sphere_roots root
        LEFT JOIN sphere_items pin ON pin.collection='asset' AND pin.id=root.id
        LEFT JOIN sphere_sources asset_source ON asset_source.source='asset:' || root.id
        LEFT JOIN sphere_sources origin_source ON origin_source.source='work:' || root.source_id
        LEFT JOIN asset_sphere_inherited inherited ON inherited.root_id=root.id
    ), asset_sphere_safety AS (
      ${safetyChecked ? 'SELECT 0 AS unsupported' : `SELECT EXISTS (SELECT 1 FROM asset_sphere_roots WHERE valid=0)
        OR EXISTS (SELECT 1 FROM asset_sphere_walk walk WHERE invalid=1 OR walk.stopped=0 AND
          (walk.depth=64 AND walk.belongs_to IS NOT NULL OR EXISTS (SELECT 1 FROM json_each(walk.path) WHERE value=walk.belongs_to))) AS unsupported`}
    )` };
  };
  const selectedPlacement = (row: AssetSphereRow): SpherePlacement => row.pinned_sphere !== null
    ? pinnedPlacement({ sphere: row.pinned_sphere, source: row.pinned_source })
    : assetPlacement(row.id!, { source_id: row.source_id, ...(row.sphere_override ? { sphere_override: row.sphere_override } : {}),
      ...(row.inherited_sphere ? { sphere: row.inherited_sphere } : {}) }, undefined, undefined,
    source => (source === `asset:${row.id}` ? row.asset_sphere : row.source_sphere) ?? undefined);
  function assetPage(this: { resolve: typeof resolve; resolveAssets: typeof resolveAssets }, sphere: Sphere | 'unsorted',
    query?: Pick<WorkEntityListQuery, 'search' | 'limit' | 'offset'>): AssetSpherePage | undefined {
    if (!work || sourceForReference || this?.resolve !== resolve || this.resolveAssets !== resolveAssets) return undefined;
    if (!['personal', 'professional', 'unsorted'].includes(sphere)) throw new Error('Unknown asset sphere');
    const { norm, params, sql } = assetSphereSql(query);
    interface PageRow extends AssetSphereRow { total: number; unsupported: number }
    const selected = db.prepare(`${sql}, asset_sphere_total AS (
      SELECT COUNT(*) AS total FROM asset_sphere_matches WHERE resolved_sphere=?
    ), asset_sphere_page AS (
      SELECT * FROM asset_sphere_matches WHERE resolved_sphere=? ORDER BY updated_at DESC,id ASC LIMIT ? OFFSET ?
    ) SELECT page.*,counts.total,safety.unsupported FROM asset_sphere_total counts CROSS JOIN asset_sphere_safety safety
      LEFT JOIN asset_sphere_page page ON 1 ORDER BY page.updated_at DESC,page.id ASC`)
      .all(...params, sphere, sphere, norm.limit, norm.offset) as PageRow[];
    if (selected[0]!.unsupported) return undefined;
    const placements = new Map<string, SpherePlacement>(); const ids: string[] = [];
    for (const row of selected) {
      if (row.id === null) continue;
      const placement = selectedPlacement(row);
      if ((placement.sphere ?? 'unsorted') !== sphere) return undefined;
      ids.push(row.id); placements.set(row.id, placement);
    }
    return { ids, total: selected[0]!.total, placements };
  }
  /** Stream raw attention candidates in the same 200-asset groups as the scan.
   * Completion is true only for a supported, fully consumed selection; false
   * requests the original scan. Preparing and stepping stay inside the generator
   * so an unopened or closed iterator never holds a SQLite read cursor. */
  function assetCandidates(this: { resolve: typeof resolve; resolveAssets: typeof resolveAssets }, sphere: Sphere | 'unsorted',
    query?: Pick<WorkEntityListQuery, 'search'>): Generator<AssetSphereBatch, boolean, void> | undefined {
    if (!work || sourceForReference || this?.resolve !== resolve || this.resolveAssets !== resolveAssets) return undefined;
    if (!['personal', 'professional', 'unsorted'].includes(sphere)) throw new Error('Unknown asset sphere');
    const { key, params, sql } = assetSphereSql(query); const scope = historyScope; const fields = createAssetSummaryHistoryBatch(db);
    type CandidateRow = AssetSphereRow & Omit<AssetRow, 'id'> & { unsupported: number; history_members?: string | null };
    return (function* (): Generator<AssetSphereBatch, boolean, void> {
      const shareMembership = scope && historyScope === scope && scope.sphere === sphere && scope.key === key;
      const cursor = db.prepare(`${sql}, asset_sphere_candidates AS${shareMembership ? ' NOT MATERIALIZED' : ''} (
        SELECT * FROM asset_sphere_matches WHERE resolved_sphere=?
      ) SELECT asset.*,candidate.inherited_sphere,candidate.pinned_sphere,candidate.pinned_source,
          candidate.asset_sphere,candidate.source_sphere,safety.unsupported${shareMembership ? `,
          CASE WHEN safety.unsupported=0 AND (candidate.id IS NULL OR candidate.id=(
            SELECT id FROM asset_sphere_candidates ORDER BY updated_at DESC,id ASC LIMIT 1))
            AND COALESCE((SELECT SUM(length(CAST(json_quote(id) AS BLOB))+1) FROM asset_sphere_candidates),0)<${historyMembershipLimit}
          THEN (SELECT json_group_array(id) FROM asset_sphere_candidates) END AS history_members` : ''}
        FROM asset_sphere_safety safety LEFT JOIN asset_sphere_candidates candidate ON 1
          LEFT JOIN ${ASSET_TABLE} asset ON asset.id=candidate.id
        ORDER BY candidate.updated_at DESC,candidate.id ASC`).iterate(...params, sphere) as IterableIterator<CandidateRow>;
      try {
        let assets: Asset[] = []; let placements = new Map<string, SpherePlacement>();
        for (;;) {
          const next = cursor.next(); if (next.done) break;
          const row = next.value;
          if (row.unsupported) return false;
          // The first supported row has completed both global safety checks.
          // Only this read-only scope and its exact selector may reuse them.
          if (scope && historyScope === scope && scope.sphere === sphere && scope.key === key) {
            scope.checked = true;
            if (typeof row.history_members === 'string') scope.members = row.history_members;
          }
          if (row.id === null) continue;
          const placement = selectedPlacement(row);
          if ((placement.sphere ?? 'unsorted') !== sphere) return false;
          const assetRow = { ...row, id: row.id }; const asset = rowToAsset(assetRow);
          assets.push(asset); fields.add(assetRow, asset); placements.set(row.id, placement);
          if (assets.length === 200) { fields.publish(); yield { assets, placements }; assets = []; placements = new Map(); }
        }
        if (assets.length) { fields.publish(); yield { assets, placements }; }
        return true;
      } finally { fields.close(); cursor.return?.(); }
    })();
  }
  /** Use the native candidate selector's membership and safety checks for a
   * synchronous, replayable attention read with no writes. Unsupported selectors keep ordinary
   * histories, and a failed candidate scan exits this scope before scan fallback. */
  function withAssetReadingHistories<T>(this: { resolve: typeof resolve; resolveAssets: typeof resolveAssets; assetCandidates: typeof assetCandidates },
    sphere: Sphere | 'unsorted', query: Pick<WorkEntityListQuery, 'search'>, read: () => T): T {
    if (!work || typeof work.withAssetReadingHistories !== 'function' || sourceForReference
      || this?.resolve !== resolve || this.resolveAssets !== resolveAssets || this.assetCandidates !== assetCandidates) return read();
    if (!['personal', 'professional', 'unsorted'].includes(sphere)) throw new Error('Unknown asset sphere');
    const scope: NonNullable<typeof historyScope> = { sphere, key: '', checked: false };
    let selection;
    try {
      const { key, sql, params } = assetSphereSql(query); scope.key = key;
      const checkedSql = assetSphereSql(query, true).sql;
      selection = { get ctes() {
        if (historyScope === scope && scope.members !== undefined)
          return 'WITH asset_summary_history_members AS (SELECT value AS id FROM json_each(?))';
        const prefix = historyScope === scope && scope.checked ? checkedSql : sql;
        return `${prefix}, asset_summary_history_members AS (
          SELECT id FROM asset_sphere_matches WHERE resolved_sphere=? AND (SELECT unsupported FROM asset_sphere_safety)=0
        )`;
      }, get params() { return historyScope === scope && scope.members !== undefined ? [scope.members] : [...params, sphere]; } };
    } catch { return read(); /* Retain the candidate and scan's normalization errors. */ }
    const previous = historyScope; historyScope = scope;
    try { return work.withAssetReadingHistories({ ...query, selection }, read); }
    finally { scope.members = undefined; historyScope = previous; }
  }
  const validateSphere = (sphere: Sphere | null) => { if (sphere !== null && sphere !== 'personal' && sphere !== 'professional') throw new Error('Choose personal, professional or reset'); };
  return {
    resolve, resolveAssets, prefetchAssetPlacements, assetPage, assetCandidates, withAssetReadingHistories, sourcePlacement,
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
