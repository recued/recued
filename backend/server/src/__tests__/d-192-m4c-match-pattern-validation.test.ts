/** D-192 M4c — connection write-time validation for messenger match_patterns. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MESSAGE_MATCH_CONFIG_KEY,
  RpcError,
  type ConnectionAuth,
} from '@recued/contracts';

import {
  createConnectionStore,
  type ConnectionStoreSqlite,
} from '../storage/connection-store.js';
import {
  handleConnectionEnroll,
  handleConnectionUpdate,
} from '../connection-handler.js';

let dir: string;
let db: Database.Database;
let store: ConnectionStoreSqlite;
let now = 1_700_000_000_000;
const tickNow = (): number => now;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'connection-handler-'));
  db = new Database(join(dir, 'test.db'));
  db.pragma('journal_mode = WAL');
  store = createConnectionStore(db);
  now = 1_700_000_000_000;
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const bearer = (token: string): ConnectionAuth => ({ type: 'bearer', token });

const slackEnrollArgs = (
  config: Record<string, unknown>,
): Parameters<typeof handleConnectionEnroll>[1] => ({
  kind: 'notification',
  name: 'slack',
  subtype: 'slack',
  display_name: 'Slack',
  config,
  auth: bearer('SLACK-TOKEN-DO-NOT-LEAK'),
});

const expectBadRequest = async (
  promise: Promise<unknown>,
  message?: RegExp,
): Promise<void> => {
  try {
    await promise;
    throw new Error('expected RpcError bad_request');
  } catch (err) {
    expect(err).toBeInstanceOf(RpcError);
    expect((err as RpcError).code).toBe('bad_request');
    if (message) expect((err as Error).message).toMatch(message);
  }
};

const storedConfig = (): Record<string, unknown> => {
  const row = store.get('notification', 'slack');
  expect(row).not.toBeNull();
  return JSON.parse(row!.config_json) as Record<string, unknown>;
};

describe('D-192 M4c match_patterns validation on enroll', () => {
  it('accepts valid tag and content patterns', async () => {
    const result = await handleConnectionEnroll(
      { store, now: tickNow },
      slackEnrollArgs({
        [MESSAGE_MATCH_CONFIG_KEY]: [
          { kind: 'tag', value: 'commit' },
          { kind: 'content', value: 'ship', mode: 'word' },
        ],
      }),
    );

    expect(result.connection.name).toBe('slack');
    expect(result.connection.kind).toBe('notification');
  });

  it('accepts an empty pattern array', async () => {
    const result = await handleConnectionEnroll(
      { store, now: tickNow },
      slackEnrollArgs({ [MESSAGE_MATCH_CONFIG_KEY]: [] }),
    );

    expect(result.connection.name).toBe('slack');
  });

  it('accepts config without a match_patterns key', async () => {
    const result = await handleConnectionEnroll(
      { store, now: tickNow },
      slackEnrollArgs({}),
    );

    expect(result.connection.name).toBe('slack');
  });

  it('rejects an unknown pattern kind before persisting', async () => {
    await expectBadRequest(
      handleConnectionEnroll(
        { store, now: tickNow },
        slackEnrollArgs({ [MESSAGE_MATCH_CONFIG_KEY]: [{ kind: 'bogus', value: 'x' }] }),
      ),
      /match_patterns/,
    );
    expect(store.count()).toBe(0);
  });

  it('rejects an un-matchable tag value before persisting', async () => {
    await expectBadRequest(
      handleConnectionEnroll(
        { store, now: tickNow },
        slackEnrollArgs({ [MESSAGE_MATCH_CONFIG_KEY]: [{ kind: 'tag', value: 'foo-bar' }] }),
      ),
      /match_patterns/,
    );
    expect(store.count()).toBe(0);
  });

  it('rejects non-array match_patterns before persisting', async () => {
    await expectBadRequest(
      handleConnectionEnroll(
        { store, now: tickNow },
        slackEnrollArgs({ [MESSAGE_MATCH_CONFIG_KEY]: 'commit' }),
      ),
      /match_patterns must be an array/,
    );
    expect(store.count()).toBe(0);
  });

  it('rejects null members with RpcError instead of a raw TypeError', async () => {
    await expectBadRequest(
      handleConnectionEnroll(
        { store, now: tickNow },
        slackEnrollArgs({
          [MESSAGE_MATCH_CONFIG_KEY]: [
            null,
            { kind: 'tag', value: 'commit' },
          ],
        }),
      ),
      /match_patterns/,
    );
    expect(store.count()).toBe(0);
  });
});

describe('D-192 M4c match_patterns validation on update', () => {
  const initialPatterns = [{ kind: 'tag', value: 'commit' }];

  beforeEach(async () => {
    await handleConnectionEnroll(
      { store, now: tickNow },
      slackEnrollArgs({ [MESSAGE_MATCH_CONFIG_KEY]: initialPatterns }),
    );
  });

  it('accepts valid pattern updates and persists them in config_json', async () => {
    const nextPatterns = [
      { kind: 'tag', value: 'release' },
      { kind: 'content', value: 'ship', mode: 'word' },
    ];

    const result = await handleConnectionUpdate(
      { store, now: tickNow },
      {
        name: 'slack',
        kind: 'notification',
        patch: { config: { [MESSAGE_MATCH_CONFIG_KEY]: nextPatterns } },
      },
    );

    expect(result.connection.name).toBe('slack');
    expect(storedConfig()[MESSAGE_MATCH_CONFIG_KEY]).toEqual(nextPatterns);
  });

  it('rejects invalid pattern updates before changing stored config_json', async () => {
    await expectBadRequest(
      handleConnectionUpdate(
        { store, now: tickNow },
        {
          name: 'slack',
          kind: 'notification',
          patch: {
            config: { [MESSAGE_MATCH_CONFIG_KEY]: [{ kind: 'bogus', value: 'x' }] },
          },
        },
      ),
      /match_patterns/,
    );

    expect(storedConfig()[MESSAGE_MATCH_CONFIG_KEY]).toEqual(initialPatterns);
  });

  it('does not touch existing patterns when the update omits config', async () => {
    const result = await handleConnectionUpdate(
      { store, now: tickNow },
      {
        name: 'slack',
        kind: 'notification',
        patch: { display_name: 'Slack Workspace' },
      },
    );

    expect(result.connection.display_name).toBe('Slack Workspace');
    expect(storedConfig()[MESSAGE_MATCH_CONFIG_KEY]).toEqual(initialPatterns);
  });
});
