/** An audit entry omits the two fields that are empty on every row.
 *
 *  ⛔ WHY ONLY TWO. Measured on real runs, `trigger_url` was `null` on 8/8 rows
 *  (19 B) and `errors` was `[]` on 8/8 (12 B) — 4.4% of a 698 B entry, spent
 *  entirely on key names to say "nothing here". Every OTHER empty-looking field
 *  (`config_snapshot: {}` and friends) is REQUIRED by `AuditEntry`, so a
 *  generic "drop all empties" pass would write rows that violate their own
 *  declared type. The strip is a closed list for exactly that reason, and this
 *  test pins the list.
 *
 *  ⛔ ABSENT AND EMPTY MUST READ THE SAME. Rows written before this change
 *  still carry `errors: []` and `trigger_url: null`, so every reader has to
 *  handle both — that is why the fields became OPTIONAL rather than being
 *  silently dropped from a required contract. TypeScript enumerated the ten
 *  unguarded readers across eight files; this file pins the round-trip.
 *
 *  ⚠ `false` and `0` are not empty. Only a null `trigger_url` and a zero-length
 *  `errors` qualify. */

import { describe, expect, it } from 'vitest';

import { createAuditLogStore } from '../audit.js';
import type { AuditEntry } from '../audit.js';

/** An in-memory collection with the shape `createAuditLogStore` consumes. */
const memoryCollection = () => {
  const rows = new Map<string, unknown>();
  return {
    rows,
    api: {
      async get(key: string) { return rows.get(key); },
      async set(key: string, value: unknown) { rows.set(key, value); },
      async delete(key: string) { rows.delete(key); },
      async list() { return [...rows.values()]; },
      async keys() { return [...rows.keys()]; },
    } as never,
  };
};

const entry = (over: Partial<AuditEntry> = {}): AuditEntry => ({
  run_id: 'run-1',
  recipe_id: 'core/x',
  recipe_hash: 'h'.repeat(64),
  started_at: 1_000,
  finished_at: 1_050,
  duration_ms: 50,
  commit_status: 'succeeded',
  config_snapshot: {},
  errors: [],
  trigger_url: null,
  trigger_source: 'manual',
  instance_id: 'inst-1',
  links: [],
  ...over,
} as AuditEntry);

const store = () => {
  const entries = memoryCollection();
  const activities = memoryCollection();
  return {
    entries,
    log: createAuditLogStore(entries.api, activities.api),
  };
};

describe('audit entry empty-field omission', () => {
  it('⛔ omits trigger_url when null and errors when empty', async () => {
    const { entries, log } = store();
    await log.append(entry());
    const stored = entries.rows.get('run-1') as Record<string, unknown>;

    expect('trigger_url' in stored).toBe(false);
    expect('errors' in stored).toBe(false);
    // ...and the row is still a complete audit record.
    expect(stored.run_id).toBe('run-1');
    expect(stored.commit_status).toBe('succeeded');
  });

  it('⛔ KEEPS them when they carry information', async () => {
    // The whole point is that an omission means "nothing here". A real trigger
    // URL or a real error must survive, or this is data loss wearing a
    // compression costume.
    const { entries, log } = store();
    await log.append(entry({
      trigger_url: 'https://app.hubspot.com/contacts/1',
      errors: [{ code: 'boom', message: 'it broke' }] as never,
    }));
    const stored = entries.rows.get('run-1') as Record<string, unknown>;

    expect(stored.trigger_url).toBe('https://app.hubspot.com/contacts/1');
    expect(stored.errors).toEqual([{ code: 'boom', message: 'it broke' }]);
  });

  it('⛔ does NOT strip any other field, however empty it looks', async () => {
    // `config_snapshot`, `commit_status`, `links` and the rest are REQUIRED on
    // `AuditEntry`. Dropping them would write a row that violates its own type,
    // which is why the strip is a closed list rather than a generic sweep.
    const { entries, log } = store();
    await log.append(entry());
    const stored = entries.rows.get('run-1') as Record<string, unknown>;

    for (const key of [
      'run_id', 'recipe_id', 'recipe_hash', 'started_at', 'finished_at',
      'duration_ms', 'commit_status', 'config_snapshot', 'trigger_source',
      'instance_id', 'links',
    ]) {
      expect(key in stored, `${key} must survive`).toBe(true);
    }
    expect(stored.config_snapshot).toEqual({}); // empty, and kept
  });

  it('an empty-string trigger_url is a VALUE, not an absence', async () => {
    const { entries, log } = store();
    await log.append(entry({ trigger_url: '' }));
    const stored = entries.rows.get('run-1') as Record<string, unknown>;
    expect('trigger_url' in stored).toBe(true);
    expect(stored.trigger_url).toBe('');
  });

  it('reads back through the store with the fields absent', async () => {
    // The round trip readers actually take. An omitted `errors` must not make
    // a listing throw or report a failure.
    const { log } = store();
    await log.append(entry());
    const recent = await log.listRecent(10);
    expect(recent).toHaveLength(1);
    expect(recent[0]!.run_id).toBe('run-1');
    expect(recent[0]!.errors ?? []).toEqual([]);
    expect(recent[0]!.trigger_url ?? null).toBeNull();
  });
});
