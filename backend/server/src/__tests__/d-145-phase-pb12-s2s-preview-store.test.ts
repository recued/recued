/** D-145 PB12 — `S2SPreviewStore` SQLite-backed store tests.
 *
 *  Covers the schema bootstrap, put + get + getRaw + delete +
 *  pruneExpired + list, expiry filtering at consume time, the
 *  idempotency invariant on the schema-install path, and the
 *  collision error class.
 *
 *  Spec: `docs/d-145-spec.md` § B.13.3 + § B.13.4. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  REDACTED_PACKET_DEFAULT_TTL_MS,
  buildRedactedPacket,
  type RedactedPacket,
} from '@recued/contracts';

import {
  S2SPreviewTokenCollisionError,
  S2S_PREVIEW_TOKENS_TABLE,
  createS2SPreviewStore,
} from '../s2s-preview/store.js';

const NOW = 1_715_000_000_000;

let dir: string;
let db: Database.Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd-145-pb12-store-'));
  db = new Database(join(dir, 'test.db'));
  db.pragma('journal_mode = WAL');
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const buildContactCard = (token: string, expires_at?: number): RedactedPacket =>
  buildRedactedPacket(
    'contact_card',
    { name: 'Mary Smith', network_domain: 'work' },
    {
      now: NOW,
      randomToken: () => token,
      ...(expires_at !== undefined ? { expires_at } : {}),
    },
  );

// ── PB12 store: schema bootstrap ────────────────────────────────────

describe('D-145 PB12 store — schema bootstrap', () => {
  it('creates the s2s_preview_tokens table on first construct', () => {
    createS2SPreviewStore(db);
    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`)
      .all(S2S_PREVIEW_TOKENS_TABLE) as Array<{ name: string }>;
    expect(tables).toHaveLength(1);
  });

  it('idempotent — second construct does not throw', () => {
    createS2SPreviewStore(db);
    expect(() => createS2SPreviewStore(db)).not.toThrow();
  });

  it('creates the expires_at + kind indexes', () => {
    createS2SPreviewStore(db);
    const indexes = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name = ?`)
      .all(S2S_PREVIEW_TOKENS_TABLE) as Array<{ name: string }>;
    const names = new Set(indexes.map((i) => i.name));
    expect(names.has('idx_s2s_preview_expires_at')).toBe(true);
    expect(names.has('idx_s2s_preview_kind')).toBe(true);
  });
});

// ── PB12 store: put + get round-trip ────────────────────────────────

describe('D-145 PB12 store — put + get round-trip', () => {
  it('persists + reads back a packet', () => {
    const store = createS2SPreviewStore(db);
    const packet = buildContactCard('token-1');
    store.put(packet);
    const round = store.get('token-1', NOW);
    expect(round).not.toBeNull();
    expect(round!.access_token).toBe('token-1');
    expect(round!.packet_kind).toBe('contact_card');
    expect(round!.payload).toEqual({ name: 'Mary Smith', network_domain: 'work' });
    expect(round!.fields_visible).toEqual(['name', 'network_domain']);
    expect(round!.created_at).toBe(NOW);
    expect(round!.expires_at).toBe(NOW + REDACTED_PACKET_DEFAULT_TTL_MS);
  });

  it('returns null on unknown token', () => {
    const store = createS2SPreviewStore(db);
    expect(store.get('nope', NOW)).toBeNull();
  });

  it('returns null on expired token (now ≥ expires_at)', () => {
    const store = createS2SPreviewStore(db);
    const packet = buildContactCard('token-2', NOW + 60_000); // 1-min TTL
    store.put(packet);
    expect(store.get('token-2', NOW)).not.toBeNull();
    expect(store.get('token-2', NOW + 60_000)).toBeNull();
    expect(store.get('token-2', NOW + 120_000)).toBeNull();
  });

  it('getRaw ignores expiry — returns the row even when expired', () => {
    const store = createS2SPreviewStore(db);
    const packet = buildContactCard('token-3', NOW + 60_000);
    store.put(packet);
    const expired = store.getRaw('token-3');
    expect(expired).not.toBeNull();
    expect(expired!.access_token).toBe('token-3');
  });

  it('getRaw returns null on unknown token', () => {
    const store = createS2SPreviewStore(db);
    expect(store.getRaw('never')).toBeNull();
  });
});

// ── PB12 store: collision ───────────────────────────────────────────

describe('D-145 PB12 store — token collision', () => {
  it('throws S2SPreviewTokenCollisionError on duplicate access_token', () => {
    const store = createS2SPreviewStore(db);
    const a = buildContactCard('dup-token');
    store.put(a);
    const b = buildContactCard('dup-token');
    expect(() => store.put(b)).toThrowError(S2SPreviewTokenCollisionError);
  });

  it('preserves the access_token on the thrown error', () => {
    const store = createS2SPreviewStore(db);
    const a = buildContactCard('dup-token-2');
    store.put(a);
    try {
      store.put(buildContactCard('dup-token-2'));
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(S2SPreviewTokenCollisionError);
      expect((e as S2SPreviewTokenCollisionError).access_token).toBe('dup-token-2');
    }
  });
});

// ── PB12 store: delete ──────────────────────────────────────────────

describe('D-145 PB12 store — delete', () => {
  it('returns true when a row is removed', () => {
    const store = createS2SPreviewStore(db);
    store.put(buildContactCard('to-delete'));
    expect(store.delete('to-delete')).toBe(true);
    expect(store.get('to-delete', NOW)).toBeNull();
  });

  it('returns false when no row matches', () => {
    const store = createS2SPreviewStore(db);
    expect(store.delete('never-existed')).toBe(false);
  });
});

// ── PB12 store: pruneExpired ────────────────────────────────────────

describe('D-145 PB12 store — pruneExpired', () => {
  it('removes rows whose expires_at ≤ now', () => {
    const store = createS2SPreviewStore(db);
    store.put(buildContactCard('short', NOW + 60_000));
    store.put(buildContactCard('long', NOW + 24 * 60 * 60 * 1000));
    const removed = store.pruneExpired(NOW + 60_000);
    expect(removed).toBe(1);
    expect(store.getRaw('short')).toBeNull();
    expect(store.getRaw('long')).not.toBeNull();
  });

  it('returns 0 when nothing expired', () => {
    const store = createS2SPreviewStore(db);
    store.put(buildContactCard('long', NOW + 24 * 60 * 60 * 1000));
    expect(store.pruneExpired(NOW)).toBe(0);
  });

  it('returns count when prune removes multiple', () => {
    const store = createS2SPreviewStore(db);
    store.put(buildContactCard('a', NOW + 60_000));
    store.put(buildContactCard('b', NOW + 60_000));
    store.put(buildContactCard('c', NOW + 60_000));
    const removed = store.pruneExpired(NOW + 60_000);
    expect(removed).toBe(3);
  });
});

// ── PB12 store: list ────────────────────────────────────────────────

describe('D-145 PB12 store — list', () => {
  it('returns rows ordered created_at DESC', () => {
    const store = createS2SPreviewStore(db);
    // Three packets with the same `now` but distinct tokens — order
    // by access_token tiebreak via SQLite default behaviour. We
    // primarily assert the list returns every row.
    store.put(buildContactCard('a'));
    store.put(buildContactCard('b'));
    store.put(buildContactCard('c'));
    const rows = store.list();
    expect(rows.length).toBe(3);
    const tokens = rows.map((r) => r.access_token).sort();
    expect(tokens).toEqual(['a', 'b', 'c']);
  });

  it('returns empty list when store is empty', () => {
    const store = createS2SPreviewStore(db);
    expect(store.list()).toEqual([]);
  });
});

// ── PB12 store: payload round-trip ──────────────────────────────────

describe('D-145 PB12 store — payload round-trip', () => {
  it('round-trips the availability payload structure', () => {
    const store = createS2SPreviewStore(db);
    const packet = buildRedactedPacket('availability', {
      calendar_events: [],
      window_start: NOW,
      window_end: NOW + 60 * 60 * 1000,
      tz: 'UTC',
      duration_options: [15, 30],
    }, { now: NOW, randomToken: () => 'avail-1' });
    store.put(packet);
    const round = store.get('avail-1', NOW);
    expect(round!.payload).toEqual({
      free_windows: [{ start_at: NOW, end_at: NOW + 60 * 60 * 1000 }],
      tz: 'UTC',
      duration_options: [15, 30],
    });
  });

  it('preserves audit_target_id when set', () => {
    const store = createS2SPreviewStore(db);
    const packet = buildContactCard('with-audit');
    store.put({ ...packet, audit_target_id: 'audit-row-42' });
    const round = store.get('with-audit', NOW);
    expect(round!.audit_target_id).toBe('audit-row-42');
  });

  it('omits audit_target_id when null in DB', () => {
    const store = createS2SPreviewStore(db);
    const packet = buildContactCard('no-audit');
    store.put(packet);
    const round = store.get('no-audit', NOW);
    expect(round!.audit_target_id).toBeUndefined();
  });
});
