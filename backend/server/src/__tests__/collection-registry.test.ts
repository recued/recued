import { describe, it, expect } from 'vitest';
import { createCollectionRegistry } from '../collections/registry.js';
import type { Collection, CollectionSyncAdapter } from '../collections/types.js';
import type {
  CollectionHealth,
  CollectionPlatform,
} from '@recued/contracts';
import type { StorageGate } from '@recued/storage-gate';

/** Minimal stub collection. All read/write methods return empty —
 *  the registry only inspects `platform`, `slug`, and `close()`. */
const stubCollection = (
  platform: CollectionPlatform,
  slug: string,
  overrides: Partial<Collection> = {},
): Collection => {
  const sync: CollectionSyncAdapter = {
    start: async () => {},
    stop: async () => {},
  };
  const health: CollectionHealth = {
    platform,
    slug,
    last_indexed_at: 0,
    pending_queue_size: 0,
    error_count_24h: 0,
    state: 'idle',
  };
  return {
    platform,
    slug,
    gate: {} as StorageGate,
    sync,
    upsert: () => {},
    delete: () => true,
    get: () => null,
    list: () => [],
    search: () => [],
    health: () => health,
    runRetention: async () => ({
      pruned_count: 0,
      bytes_freed: 0,
      blob_hashes_freed: [],
      duration_ms: 0,
    }),
    close: async () => {},
    ...overrides,
  };
};

describe('CollectionRegistry — register + lookup', () => {
  it('register + get roundtrips by (platform, slug)', () => {
    const reg = createCollectionRegistry();
    const c = stubCollection('mail', 'work');
    reg.register(c);
    expect(reg.get('mail', 'work')).toBe(c);
  });

  it('get returns undefined for an unknown pair', () => {
    const reg = createCollectionRegistry();
    reg.register(stubCollection('mail', 'work'));
    expect(reg.get('mail', 'personal')).toBeUndefined();
    expect(reg.get('file', 'work')).toBeUndefined();
  });

  it('get is case-sensitive on both arguments', () => {
    // TOML section names are passed through verbatim; case-insensitive
    // lookup would mask real config typos.
    const reg = createCollectionRegistry();
    reg.register(stubCollection('mail', 'Work'));
    expect(reg.get('mail', 'Work')).toBeDefined();
    expect(reg.get('mail', 'work')).toBeUndefined();
    expect(reg.get('Mail', 'Work')).toBeUndefined();
  });

  it('list returns collections in registration order', () => {
    const reg = createCollectionRegistry();
    const a = stubCollection('mail', 'work');
    const b = stubCollection('file', 'downloads');
    const c = stubCollection('webhook', 'github');
    reg.register(a);
    reg.register(b);
    reg.register(c);
    expect(reg.list()).toEqual([a, b, c]);
  });

  it('list returns a shallow copy (not the internal array)', () => {
    const reg = createCollectionRegistry();
    const a = stubCollection('mail', 'work');
    reg.register(a);
    const snapshot = reg.list();
    snapshot.pop();
    expect(reg.list()).toEqual([a]);
  });
});

describe('CollectionRegistry — duplicate registration', () => {
  it('throws when (platform, slug) is already registered', () => {
    const reg = createCollectionRegistry();
    reg.register(stubCollection('mail', 'work'));
    expect(() => reg.register(stubCollection('mail', 'work'))).toThrow(
      /duplicate registration/,
    );
  });

  it('allows the same slug across different platforms', () => {
    // Users pair a `work` mail account with a `work` webhook
    // endpoint — registry key is (platform, slug), not slug alone.
    const reg = createCollectionRegistry();
    reg.register(stubCollection('mail', 'work'));
    reg.register(stubCollection('file', 'work'));
    reg.register(stubCollection('webhook', 'work'));
    expect(reg.list().length).toBe(3);
  });

  it('failed duplicate register does not mutate state', () => {
    const reg = createCollectionRegistry();
    const a = stubCollection('mail', 'work');
    reg.register(a);
    try { reg.register(stubCollection('mail', 'work')); } catch { /* ignore */ }
    expect(reg.list()).toEqual([a]);
    expect(reg.get('mail', 'work')).toBe(a);
  });
});

describe('CollectionRegistry — dispose', () => {
  it('calls close() on every collection in registration order', async () => {
    const reg = createCollectionRegistry();
    const closed: string[] = [];
    reg.register(stubCollection('mail', 'work', {
      close: async () => { closed.push('mail:work'); },
    }));
    reg.register(stubCollection('file', 'downloads', {
      close: async () => { closed.push('file:downloads'); },
    }));
    reg.register(stubCollection('webhook', 'github', {
      close: async () => { closed.push('webhook:github'); },
    }));
    await reg.dispose();
    expect(closed).toEqual(['mail:work', 'file:downloads', 'webhook:github']);
  });

  it('clears the registry after dispose', async () => {
    const reg = createCollectionRegistry();
    reg.register(stubCollection('mail', 'work'));
    reg.register(stubCollection('file', 'downloads'));
    await reg.dispose();
    expect(reg.list()).toEqual([]);
    expect(reg.get('mail', 'work')).toBeUndefined();
  });

  it('is idempotent — second dispose is a no-op', async () => {
    const reg = createCollectionRegistry();
    let closeCalls = 0;
    reg.register(stubCollection('mail', 'work', {
      close: async () => { closeCalls++; },
    }));
    await reg.dispose();
    await reg.dispose();
    expect(closeCalls).toBe(1);
  });

  it('coalesces disposal and starts every close before waiting', async () => {
    const reg = createCollectionRegistry();
    const started: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    reg.register(stubCollection('mail', 'slow', {
      close: async () => { started.push('mail:slow'); await gate; },
    }));
    reg.register(stubCollection('webhook', 'intake', {
      close: async () => { started.push('webhook:intake'); await gate; },
    }));

    const first = reg.dispose();
    const second = reg.dispose();
    expect(second).toBe(first);
    expect(started).toEqual(['mail:slow', 'webhook:intake']);

    release();
    await first;
  });

  it('rejects register() after dispose', async () => {
    const reg = createCollectionRegistry();
    await reg.dispose();
    expect(() => reg.register(stubCollection('mail', 'work'))).toThrow(
      /cannot register after dispose/,
    );
  });

  it('continues to close later collections when an earlier close() throws', async () => {
    // Mirrors the drain orchestrator's "best-effort close" policy —
    // a stuck IMAP LOGOUT must not strand a later fs.watch handle.
    const reg = createCollectionRegistry();
    const closed: string[] = [];
    reg.register(stubCollection('mail', 'bad', {
      close: async () => { throw new Error('imap unclean'); },
    }));
    reg.register(stubCollection('file', 'ok', {
      close: async () => { closed.push('file:ok'); },
    }));
    await reg.dispose().catch(() => { /* expected */ });
    expect(closed).toEqual(['file:ok']);
  });

  it('surfaces a composite error when any close() throws', async () => {
    const reg = createCollectionRegistry();
    reg.register(stubCollection('mail', 'bad1', {
      close: async () => { throw new Error('a'); },
    }));
    reg.register(stubCollection('mail', 'ok'));
    reg.register(stubCollection('file', 'bad2', {
      close: async () => { throw new Error('b'); },
    }));
    let caught: unknown;
    try { await reg.dispose(); } catch (err) { caught = err; }
    expect(caught).toBeInstanceOf(AggregateError);
    const agg = caught as AggregateError;
    expect(agg.errors.length).toBe(2);
    expect((agg.errors[0] as Error).message).toBe('a');
    expect((agg.errors[1] as Error).message).toBe('b');
  });

  it('dispose clears state even when close() throws', async () => {
    const reg = createCollectionRegistry();
    reg.register(stubCollection('mail', 'bad', {
      close: async () => { throw new Error('boom'); },
    }));
    await reg.dispose().catch(() => { /* ignore */ });
    // Registry must be unusable afterward — no stale entries, no
    // late registrations.
    expect(reg.list()).toEqual([]);
    expect(() => reg.register(stubCollection('mail', 'new'))).toThrow(
      /cannot register after dispose/,
    );
  });
});
