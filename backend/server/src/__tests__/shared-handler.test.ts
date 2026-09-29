import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { RpcError } from '@recued/contracts';

import { createBlobStore } from '../storage/blob-store.js';
import { createSharedStore } from '../storage/shared-store.js';
import {
  handleSharedWrite,
  handleSharedCompareAndSet,
  handleSharedPatch,
  handleSharedRead,
  handleSharedList,
  handleSharedSearch,
  handleSharedDelete,
  handleSharedDeletePrefix,
  keyRoutesToDurable,
  keyRoutesToCache,
} from '../shared-handler.js';

let dir: string;
let db: Database.Database;
let deps: Parameters<typeof handleSharedWrite>[0];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'shared-handler-'));
  db = new Database(join(dir, 'test.db'));
  db.pragma('journal_mode = WAL');
  const blobs = createBlobStore(join(dir, 'blobs'));
  const store = createSharedStore({ db, blobs });
  deps = { store, getAuthorId: () => 'tester' };
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('key routing', () => {
  it('data.shared.* → durable', () => {
    expect(keyRoutesToDurable('data.shared.deal.1')).toBe(true);
    expect(keyRoutesToDurable('shared.foo')).toBe(false);
  });

  it('shared.* (non-data) → cache', () => {
    expect(keyRoutesToCache('shared.foo')).toBe(true);
    expect(keyRoutesToCache('data.shared.foo')).toBe(false);
  });
});

describe('handleSharedWrite', () => {
  it('writes and returns bytes_written', async () => {
    const res = await handleSharedWrite(deps, {
      key: 'data.shared.deal.1',
      value: { stage: 'open' },
    });
    expect(res.ok).toBe(true);
    expect(res.key).toBe('data.shared.deal.1');
    expect(res.bytes_written).toBeGreaterThan(0);
  });

  it('rejects keys outside data.shared.*', async () => {
    await expect(
      handleSharedWrite(deps, { key: 'shared.foo', value: 1 }),
    ).rejects.toBeInstanceOf(RpcError);
  });

  it('rejects missing key', async () => {
    await expect(handleSharedWrite(deps, { value: 1 })).rejects.toMatchObject({
      code: 'bad_request',
    });
  });

  it('ignores inherited key and value fields', async () => {
    const inheritedKey = Object.create({ key: 'data.shared.inherited', value: 'proto' });
    await expect(
      handleSharedWrite(deps, inheritedKey),
    ).rejects.toMatchObject({ code: 'bad_request' });

    const inheritedValue = Object.create({ value: 'proto' });
    inheritedValue.key = 'data.shared.own-key';
    await handleSharedWrite(deps, inheritedValue);
    const listed = await handleSharedList(deps, { prefix: 'data.shared.own-key' });
    expect(listed.entries[0].value).toBeNull();
  });

  it('rejects ttl on data.shared.* writes', async () => {
    await expect(
      handleSharedWrite(deps, { key: 'data.shared.a', value: 1, ttl: 30 }),
    ).rejects.toMatchObject({ code: 'bad_request' });
  });
});

describe('handleSharedCompareAndSet', () => {
  const key = 'data.shared.recipe.bundle.state.submission-1';

  it('creates and advances a revision-controlled row', async () => {
    await expect(handleSharedCompareAndSet(deps, {
      key,
      expected_revision: null,
      value: { revision: 0, phase: 'awaiting_payment' },
    })).resolves.toEqual({
      ok: true,
      key,
      revision: 0,
      created: true,
      bytes_written: expect.any(Number),
    });

    await expect(handleSharedCompareAndSet(deps, {
      key,
      expected_revision: 0,
      value: { revision: 1, phase: 'paid' },
    })).resolves.toMatchObject({ revision: 1, created: false });
  });

  it('surfaces a stale expectation as a typed 409 and preserves the winner', async () => {
    await handleSharedCompareAndSet(deps, {
      key,
      expected_revision: null,
      value: { revision: 0, runner: 'winner' },
    });

    await expect(handleSharedCompareAndSet(deps, {
      key,
      expected_revision: null,
      value: { revision: 0, runner: 'loser' },
    })).rejects.toMatchObject({
      code: 'conflict',
      status: 409,
      method: 'shared.compare-and-set',
      details: {
        key,
        expected_revision: null,
        actual_revision: 0,
        found: true,
      },
    });
    await expect(handleSharedRead(deps, { key })).resolves.toMatchObject({
      value: { revision: 0, runner: 'winner' },
    });
  });

  it('requires explicit own inputs and an exact next value revision', async () => {
    await expect(handleSharedCompareAndSet(deps, {
      key,
      value: { revision: 0 },
    })).rejects.toMatchObject({ code: 'bad_request' });
    await expect(handleSharedCompareAndSet(deps, {
      key,
      expected_revision: null,
    })).rejects.toMatchObject({ code: 'bad_request' });
    await expect(handleSharedCompareAndSet(deps, {
      key,
      expected_revision: null,
      value: { revision: 1 },
    })).rejects.toMatchObject({ code: 'bad_request' });

    const inherited = Object.create({
      expected_revision: null,
      value: { revision: 0 },
    }) as Record<string, unknown>;
    inherited.key = key;
    await expect(handleSharedCompareAndSet(deps, inherited)).rejects.toMatchObject({
      code: 'bad_request',
    });
  });

  it('rejects ordinary last-writer-wins overwrite after CAS creation', async () => {
    await handleSharedCompareAndSet(deps, {
      key,
      expected_revision: null,
      value: { revision: 0, phase: 'awaiting_payment' },
    });

    await expect(handleSharedWrite(deps, {
      key,
      value: { revision: 99, phase: 'complete' },
    })).rejects.toMatchObject({ code: 'conflict', status: 409 });
  });

  it('rejects cache-tier keys', async () => {
    await expect(handleSharedCompareAndSet(deps, {
      key: 'shared.state.1',
      expected_revision: null,
      value: { revision: 0 },
    })).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('reports the inline-only size ceiling as payload_too_large', async () => {
    await expect(handleSharedCompareAndSet(deps, {
      key,
      expected_revision: null,
      value: { revision: 0, payload: 'x'.repeat(64 * 1024) },
    })).rejects.toMatchObject({ code: 'payload_too_large', status: 413 });
  });
});

describe('handleSharedPatch', () => {
  const key = 'data.shared.recipe.follow-up.active.thread-1';

  it('changes only the named fields and says what it did', async () => {
    await handleSharedWrite(deps, { key, value: { status: 'watching', order_id: 'ord-1' } });
    expect(await handleSharedPatch(deps, { key, set: { status: 'needs_owner' } }))
      .toMatchObject({ ok: true, key, found: true, applied: true, bytes_written: expect.any(Number) });
    expect(await handleSharedRead(deps, { key })).toMatchObject({ value: { status: 'needs_owner', order_id: 'ord-1' } });
  });

  it('an absent record and a match that no longer holds are answers, not errors', async () => {
    expect(await handleSharedPatch(deps, { key, set: { status: 'x' } }))
      .toEqual({ ok: true, key, found: false, applied: false, bytes_written: 0 });
    await handleSharedWrite(deps, { key, value: { reply_id: 'r-2' } });
    expect(await handleSharedPatch(deps, { key, set: { task_id: 't' }, match: { reply_id: 'r-1' } }))
      .toEqual({ ok: true, key, found: true, applied: false, bytes_written: 0 });
  });

  it('refuses a cache-tier key, a bad patch, a revision-controlled row and an oversized record, typed', async () => {
    await expect(handleSharedPatch(deps, { key: 'shared.state.1', set: { x: 1 } }))
      .rejects.toMatchObject({ code: 'bad_request' });
    await expect(handleSharedPatch(deps, { set: { x: 1 } })).rejects.toMatchObject({ code: 'bad_request' });
    await handleSharedWrite(deps, { key, value: { status: 'watching' } });
    await expect(handleSharedPatch(deps, { key, set: { status: 'x' }, unset: ['status'] }))
      .rejects.toMatchObject({ code: 'bad_request', status: 400 });
    await handleSharedCompareAndSet(deps, { key: 'data.shared.state.cas', expected_revision: null, value: { revision: 0 } });
    await expect(handleSharedPatch(deps, { key: 'data.shared.state.cas', set: { x: 1 } }))
      .rejects.toMatchObject({ code: 'conflict', status: 409 });
    await expect(handleSharedPatch(deps, { key, set: { note: 'x'.repeat(64 * 1024) } }))
      .rejects.toMatchObject({ code: 'payload_too_large', status: 413 });
  });
});

describe('handleSharedList', () => {
  beforeEach(async () => {
    await handleSharedWrite(deps, { key: 'data.shared.deal.1', value: 'a' });
    await handleSharedWrite(deps, { key: 'data.shared.deal.2', value: 'b' });
    await handleSharedWrite(deps, { key: 'data.shared.contact.1', value: 'c' });
  });

  it('lists entries under a prefix', async () => {
    const res = await handleSharedList(deps, { prefix: 'data.shared.deal' });
    expect(res.entries.map((e) => e.key).sort()).toEqual([
      'data.shared.deal.1',
      'data.shared.deal.2',
    ]);
  });

  it('accepts the documented trailing-dot namespace prefix', async () => {
    await handleSharedWrite(deps, { key: 'data.shared.deal', value: 'parent' });
    const res = await handleSharedList(deps, { prefix: 'data.shared.deal.' });
    expect(res.entries.map((e) => e.key).sort()).toEqual([
      'data.shared.deal.1',
      'data.shared.deal.2',
    ]);
  });

  it('rejects cache-scope prefixes', async () => {
    await expect(
      handleSharedList(deps, { prefix: 'shared.foo' }),
    ).rejects.toBeInstanceOf(RpcError);
  });

  // ⛔ THE EXACT PREFIX THE WEBCLIENT'S Data → Storage TAB SENDS. Nothing
  // covered it, and it threw `shared_key_invalid: key must be a non-empty
  // string` on every load — the root prefix strips to `''` here. Spell the
  // literal the caller spells, not a representative one.
  it('lists the whole durable tier at the root prefix', async () => {
    const res = await handleSharedList(deps, { prefix: 'data.shared.' });
    expect(res.entries.map((e) => e.key).sort()).toEqual([
      'data.shared.contact.1',
      'data.shared.deal.1',
      'data.shared.deal.2',
    ]);
  });

  it('answers the root prefix with an empty list when nothing is stored', async () => {
    await handleSharedDeletePrefix(deps, { prefix: 'data.shared.deal' });
    await handleSharedDeletePrefix(deps, { prefix: 'data.shared.contact' });
    await expect(handleSharedList(deps, { prefix: 'data.shared.' }))
      .resolves.toEqual({ entries: [] });
  });

  // The root prefix is a READ widening only. `deleteByPrefix` still routes
  // through the strict validator, so a root prefix cannot wipe the tier.
  it('does NOT extend the root prefix to delete-prefix', async () => {
    await expect(
      handleSharedDeletePrefix(deps, { prefix: 'data.shared.' }),
    ).rejects.toMatchObject({ code: 'bad_request' });
    const res = await handleSharedList(deps, { prefix: 'data.shared.' });
    expect(res.entries).toHaveLength(3);
  });
});

describe('handleSharedRead', () => {
  it('reads one exact record by key', async () => {
    await handleSharedWrite(deps, { key: 'data.shared.deal.1', value: { stage: 'open' } });
    await handleSharedWrite(deps, { key: 'data.shared.deal.10', value: { stage: 'closed' } });

    const res = await handleSharedRead(deps, { key: 'data.shared.deal.1' });

    expect(res).toEqual({
      found: true,
      key: 'data.shared.deal.1',
      value: { stage: 'open' },
      cas_revision: null,
    });
  });

  it('exposes the store-owned CAS token instead of trusting value.revision', async () => {
    await handleSharedCompareAndSet(deps, {
      key: 'data.shared.state.controlled',
      expected_revision: null,
      value: { revision: 0 },
    });
    await expect(handleSharedRead(deps, {
      key: 'data.shared.state.controlled',
    })).resolves.toMatchObject({
      found: true,
      cas_revision: 0,
      value: { revision: 0 },
    });
  });

  it('returns found=false for a missing exact key', async () => {
    await handleSharedWrite(deps, { key: 'data.shared.deal.10', value: { stage: 'closed' } });

    await expect(handleSharedRead(deps, { key: 'data.shared.deal.1' })).resolves.toEqual({
      found: false,
      key: 'data.shared.deal.1',
    });
  });

  it('rejects cache-scope keys', async () => {
    await expect(
      handleSharedRead(deps, { key: 'shared.foo' }),
    ).rejects.toBeInstanceOf(RpcError);
  });

  it('ignores inherited key fields', async () => {
    const inheritedKey = Object.create({ key: 'data.shared.inherited' });

    await expect(
      handleSharedRead(deps, inheritedKey),
    ).rejects.toMatchObject({ code: 'bad_request' });
  });
});

describe('handleSharedSearch', () => {
  beforeEach(async () => {
    await handleSharedWrite(deps, {
      key: 'data.shared.deal.acme',
      value: { title: 'Acme Q3 expansion' },
    });
    await handleSharedWrite(deps, {
      key: 'data.shared.deal.other',
      value: { title: 'Brand new Q4 deal' },
    });
  });

  it('searches FTS5 and returns ranked matches', async () => {
    const res = await handleSharedSearch(deps, {
      scope: 'data.shared.deal.*',
      query: 'Acme',
    });
    expect(res.matches).toHaveLength(1);
    expect(res.matches[0].key).toBe('data.shared.deal.acme');
  });
});

describe('handleSharedDelete', () => {
  it('deletes a single record', async () => {
    await handleSharedWrite(deps, { key: 'data.shared.a', value: 1 });
    const res = await handleSharedDelete(deps, { key: 'data.shared.a' });
    expect(res.ok).toBe(true);
  });

  it('returns a typed conflict instead of deleting a revision-controlled row', async () => {
    const key = 'data.shared.state.protected-delete';
    await handleSharedCompareAndSet(deps, {
      key,
      expected_revision: null,
      value: { revision: 0 },
    });

    await expect(handleSharedDelete(deps, { key })).rejects.toMatchObject({
      code: 'conflict',
      status: 409,
      method: 'shared.delete',
      details: { key, operation: 'delete' },
    });
    await expect(handleSharedRead(deps, { key })).resolves.toMatchObject({ found: true });
  });
});

describe('handleSharedDeletePrefix', () => {
  it('deletes every matching record and returns the count', async () => {
    await handleSharedWrite(deps, { key: 'data.shared.x.1', value: 1 });
    await handleSharedWrite(deps, { key: 'data.shared.x.2', value: 2 });
    await handleSharedWrite(deps, { key: 'data.shared.y.1', value: 3 });
    const res = await handleSharedDeletePrefix(deps, { prefix: 'data.shared.x' });
    expect(res.deleted).toBe(2);
  });

  it('accepts a trailing-dot namespace prefix', async () => {
    await handleSharedWrite(deps, { key: 'data.shared.x.1', value: 1 });
    await handleSharedWrite(deps, { key: 'data.shared.x.2', value: 2 });
    await handleSharedWrite(deps, { key: 'data.shared.y.1', value: 3 });
    await handleSharedWrite(deps, { key: 'data.shared.x', value: 'parent' });

    const res = await handleSharedDeletePrefix(deps, { prefix: 'data.shared.x.' });

    expect(res.deleted).toBe(2);
    await expect(handleSharedRead(deps, { key: 'data.shared.x' })).resolves.toMatchObject({ found: true });
    await expect(handleSharedRead(deps, { key: 'data.shared.y.1' })).resolves.toMatchObject({ found: true });
  });

  it('returns a typed conflict and deletes nothing when the prefix contains a controlled row', async () => {
    const prefix = 'data.shared.workflow';
    await handleSharedWrite(deps, {
      key: `${prefix}.legacy`,
      value: { keep: true },
    });
    await handleSharedCompareAndSet(deps, {
      key: `${prefix}.state`,
      expected_revision: null,
      value: { revision: 0 },
    });

    await expect(handleSharedDeletePrefix(deps, { prefix })).rejects.toMatchObject({
      code: 'conflict',
      status: 409,
      method: 'shared.delete-prefix',
      details: {
        key: `${prefix}.state`,
        operation: 'delete-prefix',
      },
    });
    await expect(handleSharedRead(deps, { key: `${prefix}.legacy` }))
      .resolves.toMatchObject({ found: true });
    await expect(handleSharedRead(deps, { key: `${prefix}.state` }))
      .resolves.toMatchObject({ found: true });
  });
});
