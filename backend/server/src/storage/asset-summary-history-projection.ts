import type Database from 'better-sqlite3';

export const ASSET_HISTORY_PROJECTION_COLUMN = 'summary_history_fields_v1';
const insertTrigger = 'data_asset_summary_history_fields_v1_insert';
const updateTrigger = 'data_asset_summary_history_fields_v1_update';

/** Canonical field identities only. Unsupported legacy data stays NULL so the
 * existing JavaScript decoder remains authoritative. No connection UDF is used
 * by the persistent triggers, including writes from a second connection. */
const project = (blob: string): string => {
  const valid = `CASE WHEN rule.type='object' THEN CASE
    WHEN json_type(rule.value,'$.enabled')='false'
      AND (SELECT COUNT(*) FROM jsonb_each(rule.value) WHERE key='enabled')=1 THEN 1
    WHEN json_type(rule.value,'$.enabled')='true' AND json_type(rule.value,'$.when')='object'
      AND (SELECT COUNT(*) FROM jsonb_each(rule.value) WHERE key IN ('enabled','when'))=2
      AND json_type(rule.value,'$.when.kind')='text' AND CASE
        WHEN json_extract(rule.value,'$.when.kind')='objective' THEN
          json_type(rule.value,'$.when.field')='text'
          AND json_extract(rule.value,'$.when.field') NOT GLOB '*[^ -~]*'
          AND length(json_extract(rule.value,'$.when.field'))=length(CAST(json_extract(rule.value,'$.when.field') AS BLOB))
          AND (SELECT COUNT(*) FROM jsonb_each(rule.value,'$.when') WHERE key IN ('kind','field'))=2
        ELSE (SELECT COUNT(*) FROM jsonb_each(rule.value,'$.when') WHERE key='kind')=1 END
      THEN 1 ELSE 0 END ELSE 0 END`;
  const wanted = `CASE WHEN rule.type='object' THEN json_type(rule.value,'$.enabled')='true'
    AND json_extract(rule.value,'$.when.kind')='objective' ELSE 0 END`;
  const field = `json_extract(CASE WHEN rule.type='object' THEN rule.value ELSE '{}' END,'$.when.field')`;
  return `CASE WHEN typeof(${blob})='text' AND instr(${blob},char(0))=0 AND json_valid(${blob})
    THEN CASE WHEN json_type(${blob})='object' AND json_type(${blob},'$.rules')='array'
      AND NOT EXISTS (SELECT 1 FROM json_each(${blob}) WHERE key NOT IN
        ('dates','readings','observations','values','anchors','attributes','settings','rules','field_sources','automatic_updates'))
      AND (SELECT COUNT(*)=COUNT(DISTINCT key) FROM json_each(${blob})) THEN
        CASE json_array_length(${blob},'$.rules') WHEN 0 THEN '[]'
          WHEN 1 THEN (SELECT CASE WHEN ${valid}=1 THEN CASE WHEN ${wanted}
            THEN json(jsonb_array(${field})) ELSE '[]' END END FROM jsonb_each(${blob},'$.rules') rule)
          ELSE (SELECT CASE WHEN MIN(${valid}) IS NOT 0 THEN
            json(jsonb_group_array(DISTINCT ${field}) FILTER (WHERE ${wanted})) END FROM jsonb_each(${blob},'$.rules') rule) END
      END END`;
};

/** Opt-in prototype: one atomic schema change and backfill. Normal boot does
 * not call this installer. Missing or changed triggers force a backfill, since
 * writes while they were absent may have left a stale projection. Backfilled
 * counts rows whose cached value changed; healthy rows are not rewritten. */
export const installAssetSummaryHistoryProjection = (db: Database.Database) => db.transaction(() => {
  const columns = db.pragma('table_info(data_asset)') as Array<{ name: string; type: string }>;
  if (!columns.length) throw new Error('Asset schema must exist before installing its history projection');
  const column = columns.find(row => row.name === ASSET_HISTORY_PROJECTION_COLUMN);
  if (column && column.type !== 'TEXT') throw new Error('Unexpected asset history projection column type');
  // LIMIT keeps this one-row projection separate from the update, so its JSON
  // work is evaluated once for both the comparison and the assigned value.
  const refresh = `UPDATE data_asset SET ${ASSET_HISTORY_PROJECTION_COLUMN}=projection.fields
    FROM (SELECT ${project('NEW.data_blob')} AS fields LIMIT 1) projection
    WHERE data_asset.id=NEW.id AND ${ASSET_HISTORY_PROJECTION_COLUMN} COLLATE BINARY IS NOT projection.fields;`;
  const definitions = [`CREATE TRIGGER ${insertTrigger} AFTER INSERT ON data_asset BEGIN
    ${refresh}
  END`, `CREATE TRIGGER ${updateTrigger} AFTER UPDATE OF data_blob ON data_asset
    WHEN NEW.data_blob IS NOT OLD.data_blob BEGIN
    ${refresh}
  END`];
  const triggers = db.prepare("SELECT sql FROM sqlite_schema WHERE type='trigger' AND name IN (?,?)")
    .all(insertTrigger, updateTrigger) as Array<{ sql: string }>;
  const normalized = (sql: string) => sql.trim().replace(/;$/u, '').replace(/\s+/gu, ' ');
  const current = triggers.length === 2 && definitions.every(sql => triggers.some(row => normalized(row.sql) === normalized(sql)));
  const rebuild = !column || !current;
  if (!column) db.exec(`ALTER TABLE data_asset ADD COLUMN ${ASSET_HISTORY_PROJECTION_COLUMN} TEXT`);
  if (!current) db.exec(`DROP TRIGGER IF EXISTS ${insertTrigger}; DROP TRIGGER IF EXISTS ${updateTrigger}; ${definitions.join(';')};`);
  const backfilled = rebuild ? db.prepare(`WITH projection AS MATERIALIZED (
    SELECT id,${project('data_blob')} AS fields FROM data_asset
  ) UPDATE data_asset SET ${ASSET_HISTORY_PROJECTION_COLUMN}=projection.fields FROM projection
    WHERE data_asset.id=projection.id AND ${ASSET_HISTORY_PROJECTION_COLUMN} COLLATE BINARY IS NOT projection.fields`).run().changes : 0;
  return { installed: !column, backfilled };
}).immediate();

/** Visibility is read from current SQL columns. Projection data depends only
 * on the blob; an unsupported blob always retains the complete legacy path. */
export const assetSummaryHistoryProjectionSql = (row: string) => `CASE WHEN ${row}.${ASSET_HISTORY_PROJECTION_COLUMN} IS NOT NULL
  THEN CASE WHEN ${row}.deleted_at IS NULL AND ${row}.sync_state IN ('live','stale_unreachable') AND ${row}.status IN ('active','lent')
    THEN ${row}.${ASSET_HISTORY_PROJECTION_COLUMN} ELSE '[]' END
  ELSE asset_summary_history_fields(${row}.data_blob,${row}.status,${row}.sync_state,${row}.deleted_at) END`;
