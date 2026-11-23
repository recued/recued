import type Database from 'better-sqlite3';
import { savedWorkLinks, savedWorkLinkIndexId, type SavedWorkAddress } from '@recued/contracts';

export const registerWorkBodyLinkFunction = (db: Database.Database): void => {
  db.function('saved_work_links', { deterministic: true }, (body: unknown) =>
    JSON.stringify(savedWorkLinks(typeof body === 'string' ? body : '').map(link => ({ ...link, id: savedWorkLinkIndexId(link) }))));
};

/** A derived index, kept atomic with every SQLite write (including sync and
 * deletion). It describes text references, never provider relationship edges. */
export const ensureWorkBodyLinkSchema = (db: Database.Database): void => {
  db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS work_entity_body_link (
        owner_kind TEXT NOT NULL, owner_id TEXT NOT NULL,
        target_client TEXT NOT NULL, target_kind TEXT NOT NULL, target_id TEXT NOT NULL,
        PRIMARY KEY(owner_kind, owner_id, target_client, target_kind, target_id)
      );
      CREATE INDEX IF NOT EXISTS idx_work_entity_body_link_target
        ON work_entity_body_link(target_kind, target_id, target_client);
      CREATE TABLE IF NOT EXISTS work_entity_body_link_version (version INTEGER PRIMARY KEY);
    `);
    for (const kind of ['task', 'note'] as const) {
      const insert = (row: string) => `INSERT OR IGNORE INTO work_entity_body_link
        SELECT '${kind}', ${row}.id, json_extract(value, '$.client'), json_extract(value, '$.kind'), json_extract(value, '$.id')
        FROM json_each(saved_work_links(${row}.body));`;
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS trg_data_${kind}_body_link_insert AFTER INSERT ON data_${kind} BEGIN
          ${insert('new')}
        END;
        CREATE TRIGGER IF NOT EXISTS trg_data_${kind}_body_link_update AFTER UPDATE OF id, body ON data_${kind} BEGIN
          DELETE FROM work_entity_body_link WHERE owner_kind = '${kind}' AND owner_id = old.id;
          ${insert('new')}
        END;
        CREATE TRIGGER IF NOT EXISTS trg_data_${kind}_body_link_delete AFTER DELETE ON data_${kind} BEGIN
          DELETE FROM work_entity_body_link WHERE owner_kind = '${kind}' AND owner_id = old.id;
        END;
      `);
    }
    // The marker and backfill commit together. An interrupted first boot can
    // retry; an ordinary boot never scans all saved bodies again.
    if (!db.prepare('SELECT 1 FROM work_entity_body_link_version WHERE version = 3').get()) {
      db.exec('DELETE FROM work_entity_body_link');
      for (const kind of ['task', 'note'] as const) {
        db.exec(`INSERT OR IGNORE INTO work_entity_body_link
          SELECT '${kind}', owner.id, json_extract(value, '$.client'), json_extract(value, '$.kind'), json_extract(value, '$.id')
          FROM data_${kind} AS owner, json_each(saved_work_links(owner.body))`);
      }
      db.exec('INSERT INTO work_entity_body_link_version(version) VALUES (3)');
    }
  })();
};

export interface WorkBodyLinkQuery {
  target: SavedWorkAddress; target_ids?: readonly string[]; limit: number; offset: number; excluded_source_ids: readonly string[];
}
/** Filter current row/source visibility before paging, even if index residue
 * remains for tombstones or a source changes its storage posture. */
export const workBodyLinkOwners = (db: Database.Database, query: WorkBodyLinkQuery): Array<{ kind: 'task' | 'note'; id: string }> => {
  const select = (kind: 'task' | 'note') => `SELECT '${kind}' AS kind, owner.id, owner.updated_at
    FROM work_entity_body_link AS link JOIN data_${kind} AS owner ON link.owner_id = owner.id
    JOIN source_registry AS source ON source.id = owner.source_id
    WHERE link.owner_kind = '${kind}' AND link.target_kind = @kind AND link.target_id IN (SELECT value FROM json_each(@ids))
      AND link.target_client IN ('', @client)
      AND NOT (link.owner_kind = @kind AND link.owner_id = @id)
      AND owner.deleted_at IS NULL AND owner.sync_state IN ('live', 'stale_unreachable')
      AND owner.source_id NOT IN (SELECT value FROM json_each(@excluded))
      AND source.sync_posture != 'read_through'`;
  // DISTINCT collapses an absolute and a hash-relative link from one source.
  return db.prepare(`SELECT DISTINCT kind, id, updated_at FROM (${select('task')} UNION ALL ${select('note')})
    ORDER BY updated_at DESC, kind ASC, id ASC LIMIT @limit OFFSET @offset`).all({
    kind: query.target.kind, id: query.target.id, ids: JSON.stringify(query.target_ids ?? [savedWorkLinkIndexId(query.target)]), client: query.target.client,
    excluded: JSON.stringify(query.excluded_source_ids), limit: query.limit, offset: query.offset,
  }) as Array<{ kind: 'task' | 'note'; id: string }>;
};
