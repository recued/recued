import { describe, expect, it } from 'vitest';

import {
  DRAIN_STEP_NAMES,
  ERR,
  SERVER_RPC_METHODS,
  SERVER_RPC_METHOD_SET,
  type CollectionHealth,
  type CollectionListQuery,
  type CollectionPlatform,
  type CollectionRecord,
  type CollectionSearchMatch,
  type CollectionSearchQuery,
  type CollectionState,
  type RecipeErrorCode,
  type ServerRpcRegistry,
} from '../index.js';

describe('Phase D error codes', () => {
  const newCodes: RecipeErrorCode[] = [
    'COLLECTION_NOT_FOUND',
    'COLLECTION_SOURCE_UNREACHABLE',
    'WEBHOOK_UNAVAILABLE',
  ];

  for (const code of newCodes) {
    it(`ERR['${code}'] is declared with a severity`, () => {
      expect(ERR[code]).toMatch(/^(fatal|error|warn)$/);
    });
  }

  it('WEBHOOK_UNAVAILABLE is fatal (D-096 — no cloud relay; self-host required)', () => {
    // Calling code treats `fatal` as a non-retryable terminal — matches
    // our D-096 stance that the only fix is a public address or a user-
    // hosted tunnel, not a retry.
    expect(ERR.WEBHOOK_UNAVAILABLE).toBe('fatal');
  });

  it('COLLECTION_SOURCE_UNREACHABLE is error (retryable with reconnect)', () => {
    // Mail server down, OAuth revoked, file path missing — all transient
    // from our side. `error` keeps it in the retry lane.
    expect(ERR.COLLECTION_SOURCE_UNREACHABLE).toBe('error');
  });
});

describe('Phase D rpc methods', () => {
  const newMethods: (keyof ServerRpcRegistry)[] = [
    'collection.list',
    'collection.search',
    'collection.get',
    'collection.runRetention',
    'collection.listEndpoints',
  ];

  for (const method of newMethods) {
    it(`SERVER_RPC_METHODS lists '${method}'`, () => {
      expect(SERVER_RPC_METHODS).toContain(method);
      expect(SERVER_RPC_METHOD_SET.has(method)).toBe(true);
    });
  }
});

describe('Phase D drain step — pause_collections', () => {
  it('DRAIN_STEP_NAMES includes pause_collections', () => {
    expect(DRAIN_STEP_NAMES).toContain('pause_collections');
  });

  it('pause_collections runs before pause_scheduler', () => {
    // Rationale: in-flight scheduled ticks read from the warehouse;
    // pausing collections first gives them a clean "collection
    // unavailable" error instead of dangling on a half-closed IMAP
    // socket or fs.watch handle.
    const colIdx = DRAIN_STEP_NAMES.indexOf('pause_collections');
    const schedIdx = DRAIN_STEP_NAMES.indexOf('pause_scheduler');
    expect(colIdx).toBeLessThan(schedIdx);
  });
});

describe('CollectionRecord shape', () => {
  it('accepts an inline-body record', () => {
    const rec: CollectionRecord = {
      record_id: 'uid:42@INBOX',
      received_at: 1_700_000_000_000,
      modified_at: 1_700_000_000_000,
      hot_fields: { from: 'a@b.com', subject: 'hi', is_read: false },
      size_bytes: 1234,
      source_id: '<abc@mail.example>',
      body_inline: 'Hello world',
    };
    expect(rec.body_inline).toBe('Hello world');
    expect(rec.blob_hash).toBeUndefined();
  });

  it('accepts a CAS-blob record', () => {
    const rec: CollectionRecord = {
      record_id: 'uid:43@INBOX',
      received_at: 1_700_000_000_000,
      modified_at: 1_700_000_000_000,
      hot_fields: {},
      size_bytes: 200_000,
      source_id: '<big@mail.example>',
      blob_hash: 'sha256:aabbcc',
    };
    expect(rec.blob_hash).toBe('sha256:aabbcc');
    expect(rec.body_inline).toBeUndefined();
  });
});

describe('CollectionPlatform union', () => {
  it('covers mail / file / webhook', () => {
    const platforms: CollectionPlatform[] = ['mail', 'file', 'webhook'];
    expect(platforms.length).toBe(3);
  });
});

describe('CollectionListQuery / SearchQuery shape', () => {
  it('accepts a minimal list query', () => {
    const q: CollectionListQuery = { platform: 'mail', slug: 'work' };
    expect(q.filters).toBeUndefined();
    expect(q.limit).toBeUndefined();
  });

  it('accepts a fully-populated list query', () => {
    const q: CollectionListQuery = {
      platform: 'mail',
      slug: 'work',
      filters: { thread_id: 'T123', is_read: false },
      since: 1_700_000_000_000,
      until: 1_700_100_000_000,
      limit: 50,
    };
    expect(q.filters?.is_read).toBe(false);
    expect(q.limit).toBe(50);
  });

  it('accepts a search query with FTS5 expression', () => {
    const q: CollectionSearchQuery = {
      platform: 'mail',
      slug: 'work',
      query: 'project NEAR "q3 review"',
      limit: 20,
    };
    expect(q.query).toContain('NEAR');
  });
});

describe('CollectionSearchMatch shape', () => {
  it('carries rank + snippet alongside the record reference', () => {
    const m: CollectionSearchMatch = {
      record_id: 'uid:7@INBOX',
      hot_fields: { subject: 'Q3 review' },
      rank: -3.14,
      snippet: '…the <b>project</b> <b>Q3 review</b> meeting…',
    };
    expect(m.rank).toBeLessThan(0);
    expect(m.snippet).toContain('<b>');
  });
});

describe('CollectionHealth / CollectionState', () => {
  it('State union covers the five adapter lifecycles', () => {
    const states: CollectionState[] = [
      'connected',
      'disconnected',
      'syncing',
      'idle',
      'error',
    ];
    expect(states.length).toBe(5);
  });

  it('Health carries metrics + state', () => {
    const h: CollectionHealth = {
      platform: 'mail',
      slug: 'work',
      last_indexed_at: 1_700_000_000_000,
      pending_queue_size: 3,
      error_count_24h: 0,
      state: 'connected',
    };
    expect(h.state).toBe('connected');
    expect(h.pending_queue_size).toBe(3);
  });
});
