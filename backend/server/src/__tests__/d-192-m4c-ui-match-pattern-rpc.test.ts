/** D-192 M4c-UI — the messenger match-pattern read + merge-write rpc pair,
 *  plus the `update` carry-over that stops a generic config patch from dropping
 *  the triggers. These back the Settings pattern editor (the field is stripped
 *  from `ConnectionView`, so the client needs a dedicated read + a
 *  non-clobbering write). */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MESSAGE_MATCH_CONFIG_KEY,
  RpcError,
  type ConnectionAuth,
  type MessageMatchPattern,
} from '@recued/contracts';

import {
  createConnectionStore,
  type ConnectionStoreSqlite,
} from '../storage/connection-store.js';
import {
  handleConnectionEnroll,
  handleConnectionGetMatchPatterns,
  handleConnectionSetMatchPatterns,
  handleConnectionUpdate,
} from '../connection-handler.js';

let dir: string;
let db: Database.Database;
let store: ConnectionStoreSqlite;
let now = 1_700_000_000_000;
const tickNow = (): number => now;
const deps = (): { store: ConnectionStoreSqlite; now: () => number } => ({ store, now: tickNow });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'm4c-ui-rpc-'));
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

const PATTERNS: MessageMatchPattern[] = [
  { kind: 'tag', value: 'commit' },
  { kind: 'content', value: 'send', mode: 'word' },
];

const enrollSlack = async (config: Record<string, unknown>): Promise<void> => {
  await handleConnectionEnroll(deps(), {
    kind: 'notification',
    name: 'slack',
    subtype: 'slack',
    display_name: 'Slack',
    config,
    auth: bearer('SLACK-TOKEN-DO-NOT-LEAK'),
  });
};

const storedConfig = (): Record<string, unknown> => {
  const row = store.get('notification', 'slack');
  expect(row).not.toBeNull();
  return JSON.parse(row!.config_json) as Record<string, unknown>;
};

const getPatterns = (): Promise<{ match_patterns: MessageMatchPattern[] }> =>
  handleConnectionGetMatchPatterns(deps(), { kind: 'notification', name: 'slack' });

const expectRpc = async (promise: Promise<unknown>, code: string, message?: RegExp): Promise<void> => {
  try {
    await promise;
    throw new Error(`expected RpcError ${code}`);
  } catch (err) {
    expect(err).toBeInstanceOf(RpcError);
    expect((err as RpcError).code).toBe(code);
    if (message) expect((err as Error).message).toMatch(message);
  }
};

describe('D-192 M4c-UI — getMatchPatterns', () => {
  it('returns [] for a connection with no declared patterns', async () => {
    await enrollSlack({ channel_id: 'C1' });
    expect((await getPatterns()).match_patterns).toEqual([]);
  });

  it('returns the stored patterns', async () => {
    await enrollSlack({ channel_id: 'C1', [MESSAGE_MATCH_CONFIG_KEY]: PATTERNS });
    expect((await getPatterns()).match_patterns).toEqual(PATTERNS);
  });

  it('is tolerant of a malformed config_json (→ [])', async () => {
    store.upsert({
      name: 'slack',
      kind: 'notification',
      subtype: 'slack',
      display_name: 'Slack',
      config_json: '{not json',
      auth_ciphertext: 'x',
      enrolled_at: now,
      updated_at: now,
    });
    expect((await getPatterns()).match_patterns).toEqual([]);
  });

  it('not_found for a missing connection', async () => {
    await expectRpc(getPatterns(), 'not_found');
  });
});

describe('D-192 M4c-UI — setMatchPatterns', () => {
  it('sets patterns and preserves every other config field', async () => {
    await enrollSlack({ channel_id: 'C1', signing_secret: 'S1' });
    const out = await handleConnectionSetMatchPatterns(deps(), {
      kind: 'notification',
      name: 'slack',
      match_patterns: PATTERNS,
    });
    expect(out.match_patterns).toEqual(PATTERNS); // echoes the saved list
    const config = storedConfig();
    expect(config[MESSAGE_MATCH_CONFIG_KEY]).toEqual(PATTERNS);
    // MERGE — channel_id + the inbound secret survive (never sent by the editor).
    expect(config.channel_id).toBe('C1');
    expect(config.signing_secret).toBe('S1');
    expect((await getPatterns()).match_patterns).toEqual(PATTERNS);
  });

  it('preserves row identity + auth (only config + updated_at change)', async () => {
    await enrollSlack({ channel_id: 'C1' });
    const before = store.get('notification', 'slack');
    expect(before).not.toBeNull();
    now += 5_000;
    await handleConnectionSetMatchPatterns(deps(), {
      kind: 'notification',
      name: 'slack',
      match_patterns: PATTERNS,
    });
    const after = store.get('notification', 'slack');
    expect(after!.auth_ciphertext).toBe(before!.auth_ciphertext); // the bot token survives
    expect(after!.display_name).toBe(before!.display_name);
    expect(after!.enrolled_at).toBe(before!.enrolled_at);
    expect(after!.updated_at).toBe(now); // bumped
  });

  it('clears the field on an empty array (other config still preserved)', async () => {
    await enrollSlack({ channel_id: 'C1', [MESSAGE_MATCH_CONFIG_KEY]: PATTERNS });
    await handleConnectionSetMatchPatterns(deps(), {
      kind: 'notification',
      name: 'slack',
      match_patterns: [],
    });
    const config = storedConfig();
    expect(MESSAGE_MATCH_CONFIG_KEY in config).toBe(false); // key removed, not []
    expect(config.channel_id).toBe('C1');
    expect((await getPatterns()).match_patterns).toEqual([]);
  });

  it('rejects a non-array / invalid patterns / missing arg', async () => {
    await enrollSlack({ channel_id: 'C1' });
    await expectRpc(
      handleConnectionSetMatchPatterns(deps(), {
        kind: 'notification',
        name: 'slack',
        match_patterns: 'commit' as unknown as MessageMatchPattern[],
      }),
      'bad_request',
      /must be an array/,
    );
    await expectRpc(
      handleConnectionSetMatchPatterns(deps(), {
        kind: 'notification',
        name: 'slack',
        match_patterns: [{ kind: 'tag', value: 'two words' }] as MessageMatchPattern[],
      }),
      'bad_request',
      /invalid match_patterns/,
    );
    await expectRpc(
      handleConnectionSetMatchPatterns(deps(), {
        kind: 'notification',
        name: 'slack',
        match_patterns: undefined as unknown as MessageMatchPattern[],
      }),
      'bad_request',
      /is required/,
    );
    // A rejected write never mutated the row.
    expect((await getPatterns()).match_patterns).toEqual([]);
  });

  it('not_found for a missing connection (validated args still 404, no write)', async () => {
    await expectRpc(
      handleConnectionSetMatchPatterns(deps(), {
        kind: 'notification',
        name: 'slack',
        match_patterns: PATTERNS,
      }),
      'not_found',
    );
  });
});

describe('D-192 M4c-UI — update preserves match_patterns across a config replace', () => {
  it('a generic config patch (new channel_id, no patterns) keeps the triggers', async () => {
    await enrollSlack({ channel_id: 'C1', [MESSAGE_MATCH_CONFIG_KEY]: PATTERNS });
    await handleConnectionUpdate(deps(), {
      name: 'slack',
      kind: 'notification',
      patch: { config: { channel_id: 'C2' } }, // the editor form never sends match_patterns
    });
    const config = storedConfig();
    expect(config.channel_id).toBe('C2');
    expect(config[MESSAGE_MATCH_CONFIG_KEY]).toEqual(PATTERNS); // NOT clobbered
  });

  it('also preserves the view-stripped inbound secrets (signing_secret) across a channel_id edit', async () => {
    // The client rebuilds patch.config from the STRIPPED view, so it can never
    // re-send signing_secret — a wholesale replace would break Slack inbound
    // webhook verification. The carry-over preserves it alongside the triggers.
    await enrollSlack({ channel_id: 'C1', signing_secret: 'S1', [MESSAGE_MATCH_CONFIG_KEY]: PATTERNS });
    await handleConnectionUpdate(deps(), {
      name: 'slack',
      kind: 'notification',
      patch: { config: { channel_id: 'C2' } },
    });
    const config = storedConfig();
    expect(config.channel_id).toBe('C2');
    expect(config.signing_secret).toBe('S1'); // NOT clobbered (M4c-UI fold)
    expect(config[MESSAGE_MATCH_CONFIG_KEY]).toEqual(PATTERNS);
  });

  it('honours an explicit match_patterns in patch.config', async () => {
    await enrollSlack({ channel_id: 'C1', [MESSAGE_MATCH_CONFIG_KEY]: PATTERNS });
    const replacement: MessageMatchPattern[] = [{ kind: 'mention', value: 'anna' }];
    await handleConnectionUpdate(deps(), {
      name: 'slack',
      kind: 'notification',
      patch: { config: { channel_id: 'C1', [MESSAGE_MATCH_CONFIG_KEY]: replacement } },
    });
    expect(storedConfig()[MESSAGE_MATCH_CONFIG_KEY]).toEqual(replacement);
  });

  it('leaves config untouched when the patch omits config entirely', async () => {
    await enrollSlack({ channel_id: 'C1', [MESSAGE_MATCH_CONFIG_KEY]: PATTERNS });
    await handleConnectionUpdate(deps(), {
      name: 'slack',
      kind: 'notification',
      patch: { display_name: 'Slack Renamed' },
    });
    const config = storedConfig();
    expect(config.channel_id).toBe('C1');
    expect(config[MESSAGE_MATCH_CONFIG_KEY]).toEqual(PATTERNS);
  });
});
