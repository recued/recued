/** The first registered schema migration. Keep its SQL immutable after release;
 * future changes belong in the next numbered migration. Legacy store callers
 * also use this initializer, so their fresh-table definition cannot diverge. */
export const EVENT_TRIGGER_SCHEMA_STATEMENTS = [
  { sql: `CREATE TABLE IF NOT EXISTS event_triggers (
      trigger_id TEXT PRIMARY KEY,
      recipe_id TEXT NOT NULL,
      publisher_id TEXT NOT NULL,
      pattern TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      last_fired_at INTEGER,
      last_error TEXT,
      dish_id TEXT,
      watch_interval_ms INTEGER,
      origin TEXT NOT NULL DEFAULT 'user',
      filter TEXT,
      fields TEXT
    )` },
  { sql: "ALTER TABLE event_triggers ADD COLUMN origin TEXT NOT NULL DEFAULT 'user'", column: 'origin' },
  { sql: 'ALTER TABLE event_triggers ADD COLUMN filter TEXT', column: 'filter' },
  { sql: 'ALTER TABLE event_triggers ADD COLUMN fields TEXT', column: 'fields' },
  { sql: 'ALTER TABLE event_triggers ADD COLUMN dish_id TEXT', column: 'dish_id' },
  { sql: 'ALTER TABLE event_triggers ADD COLUMN watch_interval_ms INTEGER', column: 'watch_interval_ms' },
  { sql: 'ALTER TABLE event_triggers ADD COLUMN read_contract_id TEXT', column: 'read_contract_id' },
  { sql: 'CREATE INDEX IF NOT EXISTS idx_event_triggers_recipe ON event_triggers(recipe_id, publisher_id)' },
  { sql: 'CREATE INDEX IF NOT EXISTS idx_event_triggers_enabled ON event_triggers(enabled) WHERE enabled = 1' },
] as const;
