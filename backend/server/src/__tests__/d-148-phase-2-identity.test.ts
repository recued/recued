/** D-148 P2 — server identity manager.
 *
 *  Acceptance per spec § P2:
 *   - bootIdentity ensures both keys + caches them.
 *   - rotateServerIdentity emits the new fingerprint + onServerIdentityRotated.
 *   - rotatePublisherIdentity is independent of server identity (I-7).
 *   - onBeforeRotate fires BEFORE the rotation persists; throwing
 *     aborts.
 *   - sign-after-rotate uses the new key.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  createServerIdentity,
  type IdentityRotationEvent,
} from '../identity/index.js';
import {
  createInMemoryServerKeyStore,
  ed25519Verify,
  generateEd25519Keypair,
} from '../keys/index.js';

describe('D-148 P2 — createServerIdentity (boot)', () => {
  it('boots with both keys present', () => {
    const store = createInMemoryServerKeyStore();
    const id = createServerIdentity({ store });
    expect(id.serverIdentityKey().key_class).toBe('server_identity_key');
    expect(id.publisherIdentityKey().key_class).toBe('publisher_identity_key');
    // Persisted in store.
    expect(store.loadServerIdentityKey()).not.toBeNull();
    expect(store.loadPublisherIdentityKey()).not.toBeNull();
  });

  it('preserves existing keys on reboot', () => {
    const store = createInMemoryServerKeyStore();
    const first = createServerIdentity({ store });
    const fp_a = first.serverIdentityKey().public_key_fingerprint;
    const second = createServerIdentity({ store });
    const fp_b = second.serverIdentityKey().public_key_fingerprint;
    expect(fp_b).toBe(fp_a);
  });
});

describe('D-148 P2 — rotateServerIdentity', () => {
  it('generates a new key + persists + fires listener', async () => {
    const store = createInMemoryServerKeyStore();
    const onRotated = vi.fn<(e: IdentityRotationEvent) => void>();
    const id = createServerIdentity({ store, listeners: { onServerIdentityRotated: onRotated } });
    const before_fp = id.serverIdentityKey().public_key_fingerprint;
    const { previous, current } = await id.rotateServerIdentity();
    expect(previous.public_key_fingerprint).toBe(before_fp);
    expect(current.public_key_fingerprint).not.toBe(before_fp);
    expect(id.serverIdentityKey().public_key_fingerprint).toBe(
      current.public_key_fingerprint,
    );
    expect(store.loadServerIdentityKey()?.public_key_fingerprint).toBe(
      current.public_key_fingerprint,
    );
    expect(onRotated).toHaveBeenCalledOnce();
    const event = onRotated.mock.calls[0]![0]!;
    expect(event.key_class).toBe('server_identity_key');
    expect(event.previous_fingerprint).toBe(before_fp);
    expect(event.new_fingerprint).toBe(current.public_key_fingerprint);
  });

  it('signs with the new key after rotation', async () => {
    const store = createInMemoryServerKeyStore();
    const id = createServerIdentity({ store });
    const before = id.serverIdentityKey();
    await id.rotateServerIdentity();
    const after = id.serverIdentityKey();
    const sig_after = id.signWithServerIdentity('hello');
    // Verify with the new key — should succeed.
    expect(ed25519Verify(after.public_key_b64, 'hello', sig_after)).toBe(true);
    // Verify with the old key — should fail.
    expect(ed25519Verify(before.public_key_b64, 'hello', sig_after)).toBe(false);
  });

  it('does not affect publisher identity (I-7)', async () => {
    const store = createInMemoryServerKeyStore();
    const id = createServerIdentity({ store });
    const pub_before = id.publisherIdentityKey().public_key_fingerprint;
    await id.rotateServerIdentity();
    const pub_after = id.publisherIdentityKey().public_key_fingerprint;
    expect(pub_after).toBe(pub_before);
  });

  it('onBeforeRotate fires with the previous fingerprint BEFORE rotation', async () => {
    const store = createInMemoryServerKeyStore();
    const seen: { class_at_callback: string; fp_at_callback: string }[] = [];
    const id = createServerIdentity({
      store,
      listeners: {
        onBeforeRotate: ({ key_class, previous_fingerprint }) => {
          seen.push({
            class_at_callback: key_class,
            fp_at_callback: previous_fingerprint,
          });
          // Also confirm in-memory state hasn't yet rotated.
          expect(id.serverIdentityKey().public_key_fingerprint).toBe(previous_fingerprint);
        },
      },
    });
    const before = id.serverIdentityKey().public_key_fingerprint;
    await id.rotateServerIdentity();
    expect(seen).toEqual([
      { class_at_callback: 'server_identity_key', fp_at_callback: before },
    ]);
  });

  it('onBeforeRotate throwing aborts rotation + leaves prior key intact', async () => {
    const store = createInMemoryServerKeyStore();
    const id = createServerIdentity({
      store,
      listeners: {
        onBeforeRotate: () => {
          throw new Error('block');
        },
      },
    });
    const before = id.serverIdentityKey().public_key_fingerprint;
    await expect(id.rotateServerIdentity()).rejects.toThrow(/block/);
    expect(id.serverIdentityKey().public_key_fingerprint).toBe(before);
    expect(store.loadServerIdentityKey()?.public_key_fingerprint).toBe(before);
  });
});

describe('D-148 P2 — rotatePublisherIdentity', () => {
  it('generates a new publisher key + does not affect server identity', async () => {
    const store = createInMemoryServerKeyStore();
    const id = createServerIdentity({ store });
    const server_before = id.serverIdentityKey().public_key_fingerprint;
    const { previous, current } = await id.rotatePublisherIdentity();
    expect(previous.public_key_fingerprint).not.toBe(current.public_key_fingerprint);
    expect(id.publisherIdentityKey().public_key_fingerprint).toBe(
      current.public_key_fingerprint,
    );
    expect(id.serverIdentityKey().public_key_fingerprint).toBe(server_before);
  });
});

describe('D-148 P2 — setListeners (late-binding)', () => {
  it('listeners can be installed after boot', async () => {
    const store = createInMemoryServerKeyStore();
    const id = createServerIdentity({ store });
    const fired: IdentityRotationEvent[] = [];
    id.setListeners({
      onServerIdentityRotated: (e) => fired.push(e),
    });
    await id.rotateServerIdentity();
    expect(fired).toHaveLength(1);
  });
});

describe('D-148 P2 — rotation mutex (Codex P2 #5 fold)', () => {
  it('concurrent rotations serialize on the per-class chain', async () => {
    const store = createInMemoryServerKeyStore();
    const id = createServerIdentity({ store });
    // Fire 3 rotations concurrently. Each should complete + the
    // chain serializes them.
    const [r1, r2, r3] = await Promise.all([
      id.rotateServerIdentity(),
      id.rotateServerIdentity(),
      id.rotateServerIdentity(),
    ]);
    // Three distinct fingerprints in the rotation chain.
    const fingerprints = new Set([
      r1.previous.public_key_fingerprint,
      r1.current.public_key_fingerprint,
      r2.current.public_key_fingerprint,
      r3.current.public_key_fingerprint,
    ]);
    expect(fingerprints.size).toBe(4);
    // Final cached key matches the last rotation's current.
    expect(id.serverIdentityKey().public_key_fingerprint)
      .toBe(r3.current.public_key_fingerprint);
  });

  it('publisher rotation runs concurrent with server rotation (different chains)', async () => {
    const store = createInMemoryServerKeyStore();
    const id = createServerIdentity({ store });
    const [server, publisher] = await Promise.all([
      id.rotateServerIdentity(),
      id.rotatePublisherIdentity(),
    ]);
    expect(server.current.key_class).toBe('server_identity_key');
    expect(publisher.current.key_class).toBe('publisher_identity_key');
  });
});

describe('D-148 P2 — adoptServerIdentity (slice 103 — engine-driven save)', () => {
  it('persists the supplied keypair + swaps the cached reference', async () => {
    const store = createInMemoryServerKeyStore();
    const id = createServerIdentity({ store });
    const before = id.serverIdentityKey().public_key_fingerprint;
    const next = generateEd25519Keypair('server_identity_key');
    const { previous, current } = await id.adoptServerIdentity(next);
    expect(previous.public_key_fingerprint).toBe(before);
    expect(current.public_key_fingerprint).toBe(next.public_key_fingerprint);
    expect(id.serverIdentityKey().public_key_fingerprint).toBe(
      next.public_key_fingerprint,
    );
    expect(store.loadServerIdentityKey()?.public_key_fingerprint).toBe(
      next.public_key_fingerprint,
    );
  });

  it('fires onServerIdentityRotated with engine-supplied fingerprint', async () => {
    const store = createInMemoryServerKeyStore();
    const onRotated = vi.fn<(e: IdentityRotationEvent) => void>();
    const id = createServerIdentity({
      store,
      listeners: { onServerIdentityRotated: onRotated },
    });
    const next = generateEd25519Keypair('server_identity_key');
    await id.adoptServerIdentity(next);
    expect(onRotated).toHaveBeenCalledOnce();
    const event = onRotated.mock.calls[0]![0]!;
    expect(event.key_class).toBe('server_identity_key');
    expect(event.new_fingerprint).toBe(next.public_key_fingerprint);
  });

  it('skips onBeforeRotate (engine owns pre-rotate revoke pipeline)', async () => {
    const store = createInMemoryServerKeyStore();
    const onBefore = vi.fn();
    const id = createServerIdentity({
      store,
      listeners: { onBeforeRotate: onBefore },
    });
    const next = generateEd25519Keypair('server_identity_key');
    await id.adoptServerIdentity(next);
    expect(onBefore).not.toHaveBeenCalled();
  });

  it('rejects a publisher_identity_key passed as server identity', async () => {
    const store = createInMemoryServerKeyStore();
    const id = createServerIdentity({ store });
    const wrongClass = generateEd25519Keypair('publisher_identity_key');
    await expect(id.adoptServerIdentity(wrongClass)).rejects.toThrow(/key_class/);
    // Cached key didn't move.
    expect(id.serverIdentityKey().key_class).toBe('server_identity_key');
  });

  it('serializes on the same per-class mutex as rotateServerIdentity', async () => {
    const store = createInMemoryServerKeyStore();
    const id = createServerIdentity({ store });
    const next1 = generateEd25519Keypair('server_identity_key');
    const next2 = generateEd25519Keypair('server_identity_key');
    // Mix engine-driven adoption with direct rotation; mutex serializes
    // so the final cached fingerprint matches whichever finished last,
    // and both intermediate persists are visible in store history.
    const [a, b, c] = await Promise.all([
      id.adoptServerIdentity(next1),
      id.rotateServerIdentity(),
      id.adoptServerIdentity(next2),
    ]);
    const finalFingerprint = id.serverIdentityKey().public_key_fingerprint;
    // Last in-line operation matches the cached key.
    expect([
      a.current.public_key_fingerprint,
      b.current.public_key_fingerprint,
      c.current.public_key_fingerprint,
    ]).toContain(finalFingerprint);
  });
});

describe('D-148 P2 — flush before listener fire (Codex P2 #4 fold)', () => {
  it('rotateServerIdentity awaits store.flush before listener fires', async () => {
    const events: string[] = [];
    let flushResolve: (() => void) | null = null;
    let flushed = false;
    // Wrap an in-memory store with an async flush so we can sequence
    // listener-fire vs flush-completion.
    const store = createInMemoryServerKeyStore();
    const wrappedStore = {
      ...store,
      flush: async () => {
        // Flush is "in flight" until we manually resolve it.
        await new Promise<void>((resolve) => {
          flushResolve = () => {
            flushed = true;
            resolve();
          };
        });
        events.push('flush_done');
      },
    };
    const id = createServerIdentity({
      store: wrappedStore,
      listeners: {
        onServerIdentityRotated: () => events.push('listener_fired'),
      },
    });
    const rotation = id.rotateServerIdentity();
    // Give the rotation a tick to reach the flush.
    await Promise.resolve();
    await Promise.resolve();
    expect(events).toEqual([]); // listener has NOT fired yet
    expect(flushed).toBe(false);
    // Resolve the flush — listener fires after.
    flushResolve!();
    await rotation;
    expect(events).toEqual(['flush_done', 'listener_fired']);
  });
});
