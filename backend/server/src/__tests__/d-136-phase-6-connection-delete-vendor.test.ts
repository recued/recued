/** D-136 P6 — connection-delete vendor cascade dispatch tests.
 *
 *  `handleConnectionDelete` captures the connection's `subtype` field
 *  BEFORE removing the row, then invokes
 *  `cascadeForConnectionDelete(kind, name, vendor)` so the cascade
 *  walks the vendor-entity scope cleanup path. Non-api kinds + missing
 *  subtype both skip the vendor argument cleanly. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { handleConnectionDelete } from '../connection-handler.js';
import { createConnectionStore } from '../storage/connection-store.js';

let dir: string;
let db: Database.Database;
let store: ReturnType<typeof createConnectionStore>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd-136-p6-conn-delete-'));
  db = new Database(join(dir, 'conn.db'));
  store = createConnectionStore(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const enrolled = (
  kind: 'api' | 'mcp' | 'notification',
  name: string,
  subtype?: string,
): void => {
  store.upsert({
    kind,
    name,
    ...(subtype ? { subtype } : {}),
    display_name: name,
    config_json: '{}',
    auth_ciphertext: 'placeholder',
    enrolled_at: 1_750_000_000_000,
    updated_at: 1_750_000_000_000,
  });
};

describe('handleConnectionDelete — vendor-aware cascade fire', () => {
  it('passes the connection subtype as `vendor` to the cascade for api kinds', async () => {
    enrolled('api', 'my_hubspot', 'hubspot');
    const cascadeFn = vi.fn();
    const out = await handleConnectionDelete(
      { store, cascadeForConnectionDelete: cascadeFn },
      { kind: 'api', name: 'my_hubspot' },
    );
    expect(out.deleted).toBe(true);
    expect(cascadeFn).toHaveBeenCalledTimes(1);
    expect(cascadeFn).toHaveBeenCalledWith('api', 'my_hubspot', 'hubspot');
  });

  it('passes undefined `vendor` when subtype is absent', async () => {
    enrolled('api', 'unmarked');
    const cascadeFn = vi.fn();
    await handleConnectionDelete(
      { store, cascadeForConnectionDelete: cascadeFn },
      { kind: 'api', name: 'unmarked' },
    );
    expect(cascadeFn).toHaveBeenCalledWith('api', 'unmarked', undefined);
  });

  it('passes undefined `vendor` for non-api kinds even when subtype exists', async () => {
    enrolled('notification', 'slack_team', 'slack');
    const cascadeFn = vi.fn();
    await handleConnectionDelete(
      { store, cascadeForConnectionDelete: cascadeFn },
      { kind: 'notification', name: 'slack_team' },
    );
    expect(cascadeFn).toHaveBeenCalledWith('notification', 'slack_team', undefined);
  });

  it('does not fire cascade when no row was deleted (idempotent re-call)', async () => {
    const cascadeFn = vi.fn();
    const out = await handleConnectionDelete(
      { store, cascadeForConnectionDelete: cascadeFn },
      { kind: 'api', name: 'never_existed' },
    );
    expect(out.deleted).toBe(false);
    expect(cascadeFn).not.toHaveBeenCalled();
  });

  it('does not fail the rpc when cascade throws (best-effort)', async () => {
    enrolled('api', 'my_hubspot', 'hubspot');
    const cascadeFn = vi.fn(() => {
      throw new Error('cascade boom');
    });
    const out = await handleConnectionDelete(
      { store, cascadeForConnectionDelete: cascadeFn },
      { kind: 'api', name: 'my_hubspot' },
    );
    expect(out.deleted).toBe(true);
    expect(cascadeFn).toHaveBeenCalledOnce();
  });

  it('still removes the connection row when no cascade fn is wired', async () => {
    enrolled('api', 'my_hubspot', 'hubspot');
    const out = await handleConnectionDelete({ store }, { kind: 'api', name: 'my_hubspot' });
    expect(out.deleted).toBe(true);
    expect(store.get('api', 'my_hubspot')).toBeNull();
  });
});
