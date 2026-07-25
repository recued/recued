/** D-165 P3.path-picker Slice 1 — connection sub-resource storage and rpc tests. */

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  RpcError,
  SUBRESOURCE_PATH_MAX_LEN,
  type ConnectionAuth,
} from '@recued/contracts';

import {
  handleConnectionEnroll,
  handleConnectionProbe,
  handleConnectionUpdate,
} from '../connection-handler.js';
import {
  createConnectionStore,
  ensureConnectionSchema,
  type ConnectionStoreSqlite,
  type ConnectionUpsert,
} from '../storage/connection-store.js';

let db: Database.Database;
let store: ConnectionStoreSqlite;
let now = 1_700_000_000_000;

const tickNow = (): number => now;
const advanceClock = (ms = 1_000): void => { now += ms; };
const bearer = (token: string): ConnectionAuth => ({ type: 'bearer', token });

const mkUpsert = (overrides: Partial<ConnectionUpsert> = {}): ConnectionUpsert => ({
  kind: 'api',
  name: 'hubspot',
  display_name: 'HubSpot Production',
  config_json: JSON.stringify({ base_url: 'https://api.hubapi.com' }),
  auth_ciphertext: 'AEAD-CIPHERTEXT-BASE64',
  enrolled_at: 1_700_000_000_000,
  updated_at: 1_700_000_000_000,
  ...overrides,
});

type EnrollArgs = Parameters<typeof handleConnectionEnroll>[1];

const enrollArgs = (overrides: Partial<EnrollArgs> = {}): EnrollArgs => ({
  name: 'hubspot',
  kind: 'api',
  display_name: 'HubSpot Production',
  config: { base_url: 'https://api.hubapi.com' },
  auth: bearer('t'),
  ...overrides,
});

const expectBadRequest = async (promise: Promise<unknown>): Promise<void> => {
  let thrown: unknown;
  try {
    await promise;
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(RpcError);
  expect(thrown).toMatchObject({ code: 'bad_request' });
};

beforeEach(() => {
  db = new Database(':memory:');
  store = createConnectionStore(db);
  now = 1_700_000_000_000;
});

afterEach(() => {
  db.close();
});

describe('createConnectionStore subresource_path', () => {
  it('round-trips a stored subresource_path', () => {
    store.upsert(mkUpsert({ subresource_path: '/photos' }));

    expect(store.get('api', 'hubspot')?.subresource_path).toBe('/photos');
  });

  it('omits subresource_path when the upsert omits it', () => {
    store.upsert(mkUpsert());

    const fetched = store.get('api', 'hubspot');
    expect(fetched).not.toBeNull();
    expect(Object.prototype.hasOwnProperty.call(fetched!, 'subresource_path')).toBe(false);
  });

  it('adds subresource_path to the legacy connections table schema', () => {
    const legacyDb = new Database(':memory:');
    try {
      legacyDb.exec(`
        CREATE TABLE connections (
          name         TEXT NOT NULL,
          kind         TEXT NOT NULL CHECK (kind IN ('mcp', 'api', 'notification')),
          subtype      TEXT,
          display_name TEXT NOT NULL,
          publisher_id TEXT,
          config_json  TEXT NOT NULL,
          auth_json    TEXT NOT NULL,
          enrolled_at  INTEGER NOT NULL,
          updated_at   INTEGER NOT NULL,
          last_used_at INTEGER,
          health_json  TEXT,
          PRIMARY KEY (kind, name)
        );
      `);

      ensureConnectionSchema(legacyDb);
      const cols = legacyDb
        .prepare(`PRAGMA table_info(connections)`)
        .all() as Array<{ name: string }>;
      expect(cols.map((c) => c.name)).toContain('subresource_path');

      const legacyStore = createConnectionStore(legacyDb);
      legacyStore.upsert(mkUpsert({ subresource_path: '/photos' }));

      expect(legacyStore.get('api', 'hubspot')?.subresource_path).toBe('/photos');
    } finally {
      legacyDb.close();
    }
  });
});

describe('handleConnectionEnroll subresource_path', () => {
  it('defaults an omitted subresource_path to root', async () => {
    const result = await handleConnectionEnroll(
      { store, now: tickNow },
      enrollArgs(),
    );

    expect(result.connection.subresource_path).toBe('/');
  });

  it('returns an explicit canonical subresource_path', async () => {
    const result = await handleConnectionEnroll(
      { store, now: tickNow },
      enrollArgs({ subresource_path: '/photos' }),
    );

    expect(result.connection.subresource_path).toBe('/photos');
  });

  it('canonicalizes non-canonical subresource_path input', async () => {
    const result = await handleConnectionEnroll(
      { store, now: tickNow },
      enrollArgs({ subresource_path: '/photos/' }),
    );

    expect(result.connection.subresource_path).toBe('/photos');
  });

  it('preserves an existing scope when re-enrollment omits subresource_path', async () => {
    await handleConnectionEnroll(
      { store, now: tickNow },
      enrollArgs({ subresource_path: '/photos' }),
    );
    advanceClock();

    const result = await handleConnectionEnroll(
      { store, now: tickNow },
      enrollArgs({
        display_name: 'HubSpot Token Refresh',
        auth: bearer('t-refreshed'),
      }),
    );

    expect(result.connection.subresource_path).toBe('/photos');
    expect(store.get('api', 'hubspot')?.subresource_path).toBe('/photos');
  });

  it('allows an explicit reset to root', async () => {
    await handleConnectionEnroll(
      { store, now: tickNow },
      enrollArgs({ subresource_path: '/photos' }),
    );
    advanceClock();

    const result = await handleConnectionEnroll(
      { store, now: tickNow },
      enrollArgs({ subresource_path: '/' }),
    );

    expect(result.connection.subresource_path).toBe('/');
    expect(store.get('api', 'hubspot')?.subresource_path).toBe('/');
  });

  it('rejects non-string subresource_path values as bad_request RpcError', async () => {
    await expectBadRequest(
      handleConnectionEnroll(
        { store, now: tickNow },
        enrollArgs({ subresource_path: 123 as unknown as string }),
      ),
    );
  });

  it('rejects over-long subresource_path values as bad_request RpcError', async () => {
    await expectBadRequest(
      handleConnectionEnroll(
        { store, now: tickNow },
        enrollArgs({
          subresource_path: `/${'x'.repeat(SUBRESOURCE_PATH_MAX_LEN + 1)}`,
        }),
      ),
    );
  });
});

describe('handleConnectionUpdate subresource_path', () => {
  it('preserves the enrolled scope across display_name updates', async () => {
    await handleConnectionEnroll(
      { store, now: tickNow },
      enrollArgs({ subresource_path: '/photos' }),
    );
    advanceClock();

    const result = await handleConnectionUpdate(
      { store, now: tickNow },
      {
        name: 'hubspot',
        kind: 'api',
        patch: { display_name: 'New' },
      },
    );

    expect(result.connection.display_name).toBe('New');
    expect(result.connection.subresource_path).toBe('/photos');
  });
});

describe('handleConnectionProbe subresource_path', () => {
  it('preserves the enrolled scope across probe restamps', async () => {
    await handleConnectionEnroll(
      { store, now: tickNow },
      enrollArgs({ subresource_path: '/photos' }),
    );
    advanceClock();

    await handleConnectionProbe(
      { store, now: tickNow },
      { name: 'hubspot', kind: 'api' },
    );

    expect(store.get('api', 'hubspot')?.subresource_path).toBe('/photos');
  });
});
