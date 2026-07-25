/**
 * D-167 P4 — recipe-mode `pii-protect` / `pii-restore` transforms + the
 * run-local `PiiLedgerStore` + `aliasFieldsBatch`.
 *
 * Tests are written to FAIL against an obviously-wrong implementation, not to
 * echo current behaviour. The load-bearing ones:
 *   - batch order-independence (a per-item `.map()` leaks raw PII — covered)
 *   - the hard restore invariant (never throw / always pass through on miss)
 *   - input is never mutated (protect deep-clones)
 *   - dispose() actually drops the real PII from the store
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  getTransform,
  createPiiLedgerStore,
  getFallbackPiiLedgerStore,
  _resetPiiLedgerState,
  aliasFields,
  aliasFieldsBatch,
  createLedger,
} from '../index.js';
import type { TransformContext } from '../types.js';

const ctx = {
  resolve: () => undefined,
  evaluate: () => false,
  now: () => new Date(),
} as unknown as TransformContext;

const protect = getTransform('pii-protect')!;
const restore = getTransform('pii-restore')!;

type ProtectOut = { aliased: unknown; ledger_handle: string };
type RestoreOut = { restored: unknown };

const doProtect = (data: unknown, fields?: unknown): ProtectOut =>
  protect({ data, ...(fields !== undefined ? { fields } : {}) }, ctx) as ProtectOut;
const doRestore = (data: unknown, ledger_handle: unknown): RestoreOut =>
  restore({ data, ledger_handle }, ctx) as RestoreOut;

beforeEach(() => _resetPiiLedgerState());

describe('pii-protect / pii-restore registration', () => {
  it('are registered transforms', () => {
    expect(typeof protect).toBe('function');
    expect(typeof restore).toBe('function');
  });
});

describe('pii-protect — single object round-trip', () => {
  const orig = {
    from: 'alice@acme.com',
    name: 'Alice Smith',
    body: 'Ping Alice Smith at alice@acme.com today',
  };
  const fields = [
    { path: 'from', kind: 'email' },
    { path: 'name', kind: 'name' },
    { path: 'body', kind: 'content' },
  ];

  it('replaces tagged fields with typed aliases', () => {
    const out = doProtect(structuredClone(orig), fields);
    const aliased = out.aliased as Record<string, string>;
    expect(aliased.from).toBe('m1@d1.invalid');
    expect(aliased.name).toBe('pii.Person1');
    // content pass aliased the name (and the email) inside free text
    expect(aliased.body).toContain('pii.Person1');
    expect(aliased.body).not.toContain('Alice Smith');
    expect(aliased.body).not.toContain('alice@acme.com');
  });

  it('does NOT mutate the input object (deep-clone)', () => {
    const input = structuredClone(orig);
    doProtect(input, fields);
    expect(input).toEqual(orig);
  });

  it('restores the exact original values via the handle', () => {
    const out = doProtect(structuredClone(orig), fields);
    const back = doRestore(out.aliased, out.ledger_handle).restored as Record<string, string>;
    expect(back.from).toBe('alice@acme.com');
    expect(back.name).toBe('Alice Smith');
    expect(back.body).toBe(orig.body);
  });

  it('emits a non-empty ledger_handle', () => {
    const out = doProtect(structuredClone(orig), fields);
    expect(typeof out.ledger_handle).toBe('string');
    expect(out.ledger_handle.length).toBeGreaterThan(0);
  });
});

describe('pii-protect — D-162 batch list', () => {
  it('shares ONE ledger so identical real values collapse to one alias number', () => {
    const out = doProtect(
      [{ e: 'a@x.com' }, { e: 'b@x.com' }],
      [{ path: 'e', kind: 'email' }],
    );
    const aliased = out.aliased as Array<{ e: string }>;
    expect(aliased[0].e).toBe('m1@d1.invalid');
    expect(aliased[1].e).toBe('m2@d1.invalid'); // shared d1 domain, distinct local
    const back = doRestore(out.aliased, out.ledger_handle).restored as Array<{ e: string }>;
    expect(back).toEqual([{ e: 'a@x.com' }, { e: 'b@x.com' }]);
  });

  it('is ORDER-INDEPENDENT: a content item before its anchoring identifier item does not leak raw PII', () => {
    // A naive `data.map(protectUnit)` scans item 0's content against an empty
    // ledger (the email is only anchored by item 1, processed later) and leaves
    // alice@example.com raw — a privacy leak into step.* state. The list-wide
    // two-pass must alias it.
    const out = doProtect(
      [
        { body: 'Email alice@example.com soon' },
        { email: 'alice@example.com' },
      ],
      [
        { path: 'body', kind: 'content' },
        { path: 'email', kind: 'email' },
      ],
    );
    expect(JSON.stringify(out.aliased)).not.toContain('alice@example.com');
    const aliased = out.aliased as Array<Record<string, string>>;
    expect(aliased[0].body).toContain('m1@d1.invalid');
    expect(aliased[1].email).toBe('m1@d1.invalid');
    // and it still round-trips
    const back = doRestore(out.aliased, out.ledger_handle).restored as Array<Record<string, string>>;
    expect(back[0].body).toBe('Email alice@example.com soon');
    expect(back[1].email).toBe('alice@example.com');
  });

  it('preserves array shape and passes non-object/non-string elements through', () => {
    const out = doProtect([{ e: 'a@x.com' }, 42, null, 'plain text'], [{ path: 'e', kind: 'email' }]);
    const aliased = out.aliased as unknown[];
    expect(Array.isArray(aliased)).toBe(true);
    expect(aliased).toHaveLength(4);
    expect((aliased[0] as { e: string }).e).toBe('m1@d1.invalid');
    expect(aliased[1]).toBe(42);
    expect(aliased[2]).toBeNull();
    expect(aliased[3]).toBe('plain text'); // empty ledger before this item, no match
  });
});

describe('pii-restore — hard invariant: never throw, pass through on miss', () => {
  it('unknown / garbage handle → data unchanged', () => {
    const data = { x: 'pii.Person1', y: ['m1@d1.invalid'] };
    const r = doRestore(structuredClone(data), 'pii-ledger:999.999');
    expect(r.restored).toEqual(data);
  });

  it('missing / non-string handle → data unchanged', () => {
    expect(doRestore({ x: 'pii.Person1' }, undefined).restored).toEqual({ x: 'pii.Person1' });
    expect(doRestore({ x: 'pii.Person1' }, 123).restored).toEqual({ x: 'pii.Person1' });
    expect(doRestore('pii.Person1', null).restored).toBe('pii.Person1');
  });

  it('unknown alias inside a real ledger → that span passes through', () => {
    const out = doProtect({ a: 'alice@acme.com' }, [{ path: 'a', kind: 'email' }]);
    // pii.Person7 was never allocated; it must survive verbatim, alongside a real restore.
    const back = doRestore({ a: out.aliased && (out.aliased as Record<string, string>).a, b: 'pii.Person7' }, out.ledger_handle)
      .restored as Record<string, string>;
    expect(back.a).toBe('alice@acme.com');
    expect(back.b).toBe('pii.Person7');
  });

  it('non-string / non-object data → returned unchanged, no throw', () => {
    const out = doProtect({}, []);
    expect(doRestore(42, out.ledger_handle).restored).toBe(42);
    expect(doRestore(null, out.ledger_handle).restored).toBeNull();
    expect(doRestore(true, out.ledger_handle).restored).toBe(true);
  });
});

describe('pii-protect — fields handling', () => {
  it('no fields → no-op pass-through that still emits a handle', () => {
    const out = doProtect({ secret: 'keep', n: 5 });
    expect(out.aliased).toEqual({ secret: 'keep', n: 5 });
    expect(typeof out.ledger_handle).toBe('string');
    expect(out.ledger_handle.length).toBeGreaterThan(0);
  });

  it('throws (fail closed) on a malformed field tag instead of silently dropping it', () => {
    // D-167 safe-feature rule: a tag the substrate can't honor must NOT let raw
    // PII reach the LLM under the illusion of protection — pii-protect throws,
    // which the engine surfaces as TRANSFORM_ERROR and halts before the AI step.
    expect(() => doProtect({ other: 'Bob Jones' }, [{ path: 'other', kind: 'not_a_kind' }])).toThrow(/kind/);
    expect(() => doProtect({ x: 'y' }, [{ path: '', kind: 'name' }])).toThrow(/path/);
    expect(() => doProtect({ x: 'y' }, [{ path: 42, kind: 'name' }])).toThrow(/path/);
    expect(() => doProtect({ x: 'y' }, ['garbage'])).toThrow(/object/);
    expect(() => doProtect({ x: 'y' }, [null])).toThrow(/object/);
    expect(() => doProtect({ x: 'y' }, { not: 'an array' })).toThrow(/array/);
    // A valid tag BEFORE a malformed one still fails the whole step.
    expect(() => doProtect({ a: 'a@x.com', b: 'c' }, [
      { path: 'a', kind: 'email' },
      { path: 'b', kind: 'nope' },
    ])).toThrow(/kind/);
  });

  it('absent or empty fields is a valid no-op (still emits a ledger handle)', () => {
    const absent = doProtect({ a: 'alice@acme.com' });
    expect(absent.aliased).toEqual({ a: 'alice@acme.com' });
    expect(absent.ledger_handle.length).toBeGreaterThan(0);
    const empty = doProtect({ a: 'alice@acme.com' }, []);
    expect(empty.aliased).toEqual({ a: 'alice@acme.com' });
    expect(empty.ledger_handle.length).toBeGreaterThan(0);
  });

  it('fields: null is a valid no-op (like absent — nothing to alias)', () => {
    const input = { a: 'alice@acme.com' };
    const out = doProtect(input, null);
    expect(out.aliased).toEqual(input);
    expect(out.ledger_handle.length).toBeGreaterThan(0);
  });

  it('does not echo the bad kind VALUE in the thrown message (PII-in-logs guard)', () => {
    const act = () => doProtect({ x: 'y' }, [{ path: 'x', kind: 'topsecret_value' }]);
    expect(act).toThrow(/kind/);
    try {
      act();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      expect(/topsecret_value/.test(message)).toBe(false);
      return;
    }
    throw new Error('expected pii-protect to throw');
  });

  it('a __proto__ field path is a no-op and does not pollute', () => {
    const polluted = JSON.parse('{"name":"x","__proto__":{"polluted":true}}');
    const out = doProtect(polluted, [
      { path: '__proto__.polluted', kind: 'name' },
      { path: 'name', kind: 'name' },
    ]);
    const aliased = out.aliased as Record<string, unknown>;
    expect(aliased.name).toBe('pii.Person1');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect((Object.prototype as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe('PiiLedgerStore', () => {
  it('mints unique handles and resolves them; get(unknown) is undefined', () => {
    const store = createPiiLedgerStore();
    const a = store.create();
    const b = store.create();
    expect(a.handle).not.toBe(b.handle);
    expect(store.get(a.handle)).toBe(a.ledger);
    expect(store.get(b.handle)).toBe(b.ledger);
    expect(store.get('nope')).toBeUndefined();
  });

  it('dispose() drops every ledger — get() then misses (real PII gone)', () => {
    const store = createPiiLedgerStore();
    const { handle } = store.create();
    expect(store.get(handle)).toBeDefined();
    store.dispose();
    expect(store.get(handle)).toBeUndefined();
  });

  it('two distinct stores never collide on handles', () => {
    const s1 = createPiiLedgerStore();
    const s2 = createPiiLedgerStore();
    const h1 = s1.create().handle;
    const h2 = s2.create().handle;
    expect(h1).not.toBe(h2);
    // a handle from s1 never resolves in s2
    expect(s2.get(h1)).toBeUndefined();
  });

  it('getFallbackPiiLedgerStore is a stable singleton until _resetPiiLedgerState', () => {
    const first = getFallbackPiiLedgerStore();
    expect(getFallbackPiiLedgerStore()).toBe(first);
    _resetPiiLedgerState();
    expect(getFallbackPiiLedgerStore()).not.toBe(first);
  });

  it('two protect steps in one run get distinct handles but share a run-global alias namespace', () => {
    const a = doProtect({ e: 'a@x.com' }, [{ path: 'e', kind: 'email' }]);
    const b = doProtect({ e: 'b@y.com' }, [{ path: 'e', kind: 'email' }]);
    // Each pii-protect step still mints its own handle.
    expect(a.ledger_handle).not.toBe(b.ledger_handle);
    // each handle restores its OWN data
    expect((doRestore(a.aliased, a.ledger_handle).restored as Record<string, string>).e).toBe('a@x.com');
    expect((doRestore(b.aliased, b.ledger_handle).restored as Record<string, string>).e).toBe('b@y.com');
    // D-167 Slice 2 — run-global numbering: the two steps SHARE one alias
    // namespace, so the second step CONTINUES the run's counters instead of
    // restarting at m1/d1. The two distinct emails get distinct alias surfaces
    // (no collision) — this is what makes a whole-run restoreAll safe.
    expect((a.aliased as Record<string, string>).e).toBe('m1@d1.invalid');
    expect((b.aliased as Record<string, string>).e).toBe('m2@d2.invalid');
    // And because the namespace is shared, EITHER handle restores EITHER step's
    // aliases — never the wrong real value, never raw.
    expect((doRestore(b.aliased, a.ledger_handle).restored as Record<string, string>).e).toBe('b@y.com');
    expect((doRestore(a.aliased, b.ledger_handle).restored as Record<string, string>).e).toBe('a@x.com');
  });
});

describe('aliasFieldsBatch (substrate)', () => {
  it('runs the identifier pass list-wide BEFORE any content scan', () => {
    const ledger = createLedger('t');
    const out = aliasFieldsBatch(
      ledger,
      [{ body: 'see alice@acme.com' }, { email: 'alice@acme.com' }],
      [{ path: 'body', kind: 'content' }, { path: 'email', kind: 'email' }],
    ) as Array<Record<string, string>>;
    expect(out[1].email).toBe('m1@d1.invalid');
    expect(out[0].body).toContain('m1@d1.invalid'); // anchored by item 1's identifier
    expect(JSON.stringify(out)).not.toContain('alice@acme.com');
  });

  it('completes a cross-element email via a domain anchored by a DIFFERENT element', () => {
    // Distinct from the test above (same email on both elements → substring match):
    // here element 0's content names a DIFFERENT local-part (`bob@`) at a domain
    // (`acme.com`) anchored only by element 1's structured email. The list-wide
    // identifier pass populates ONE shared ledger (acme.com → d1) before any
    // content scan, so scanContent's domain-anchored email completion mints a
    // fresh local-part (`bob` → m2) against that cross-element domain alias. (A
    // 2026-05-29 handover mis-flagged this as broken; it works — the probe that
    // "found" the gap was confounded by that session's broken tooling.)
    // NOTE: completion is independently subject to scanContent's trailing
    // word-boundary (`(?![\w.-])`) — it won't fire when the email is immediately
    // followed by `.`/`-`/a word char. That both blocks mis-aliasing a longer
    // domain (`bob@acme.com.au`) and, as a known coverage gap, misses a
    // sentence-final period (`bob@acme.com.`). Orthogonal to element ordering.
    const ledger = createLedger('t');
    const out = aliasFieldsBatch(
      ledger,
      [
        { note: 'please CC bob@acme.com today' }, // content only — no email field of its own
        { email: 'alice@acme.com' },              // anchors acme.com → d1
      ],
      [{ path: 'email', kind: 'email' }, { path: 'note', kind: 'content' }],
    ) as Array<Record<string, string>>;
    expect(out[1].email).toBe('m1@d1.invalid');
    expect(out[0].note).toBe('please CC m2@d1.invalid today'); // bob completed against the cross-element d1
    expect(JSON.stringify(out)).not.toContain('acme.com');
  });

  it('deep-clones — input elements are never mutated', () => {
    const items = [{ e: 'a@x.com' }];
    const snapshot = structuredClone(items);
    aliasFieldsBatch(createLedger('t'), items, [{ path: 'e', kind: 'email' }]);
    expect(items).toEqual(snapshot);
  });

  it('scans bare-string elements against the populated ledger', () => {
    const ledger = createLedger('t');
    const out = aliasFieldsBatch(
      ledger,
      [{ email: 'alice@acme.com' }, 'reply to alice@acme.com'],
      [{ path: 'email', kind: 'email' }],
    ) as unknown[];
    expect(out[1]).toContain('m1@d1.invalid');
    expect(out[1]).not.toContain('alice@acme.com');
  });
});

describe('PiiLedgerStore.restoreAll — D-167 Slice 2 run-wide namespace', () => {
  it('restores aliases minted by two ledgers over one combined nested value', () => {
    const store = createPiiLedgerStore();
    const first = store.create();
    const second = store.create();

    const alice = aliasFields(first.ledger, { owner: 'Alice Smith' }, [
      { path: 'owner', kind: 'name' },
    ]) as { owner: string };
    const bob = aliasFields(second.ledger, { reviewer: 'Bob Jones' }, [
      { path: 'reviewer', kind: 'name' },
    ]) as { reviewer: string };

    expect(alice.owner).toBe('pii.Person1');
    expect(bob.reviewer).toBe('pii.Person2');

    const combined = {
      people: [
        { role: 'owner', name: alice.owner },
        { role: 'reviewer', name: bob.reviewer },
      ],
      message: `Route ${alice.owner} to ${bob.reviewer}`,
    };

    expect(store.restoreAll(combined)).toEqual({
      people: [
        { role: 'owner', name: 'Alice Smith' },
        { role: 'reviewer', name: 'Bob Jones' },
      ],
      message: 'Route Alice Smith to Bob Jones',
    });
  });

  it('continues alias numbering across ledgers from the same store', () => {
    const store = createPiiLedgerStore();
    const first = store.create();
    const second = store.create();

    const alice = aliasFields(first.ledger, { name: 'Alice Smith' }, [
      { path: 'name', kind: 'name' },
    ]) as { name: string };
    const bob = aliasFields(second.ledger, { name: 'Bob Jones' }, [
      { path: 'name', kind: 'name' },
    ]) as { name: string };

    expect(alice.name).toBe('pii.Person1');
    expect(bob.name).toBe('pii.Person2');
  });

  it('reuses the same alias for the same real value across ledgers', () => {
    const store = createPiiLedgerStore();
    const first = store.create();
    const second = store.create();

    const seeded = aliasFields(first.ledger, {
      owner: 'Alice Smith',
      reviewer: 'Bob Jones',
    }, [
      { path: 'owner', kind: 'name' },
      { path: 'reviewer', kind: 'name' },
    ]) as { owner: string; reviewer: string };
    const repeated = aliasFields(second.ledger, { reviewer: 'Bob Jones' }, [
      { path: 'reviewer', kind: 'name' },
    ]) as { reviewer: string };

    expect(seeded.owner).toBe('pii.Person1');
    expect(seeded.reviewer).toBe('pii.Person2');
    expect(repeated.reviewer).toBe('pii.Person2');
  });

  it('passes through data unchanged when the store has never allocated aliases', () => {
    const store = createPiiLedgerStore();
    const aliasLookingObject = {
      text: 'pii.Person1 was never allocated',
      nested: ['m1@d1.invalid', { owner: 'pii.Person1' }],
    };

    expect(store.restoreAll('pii.Person1')).toBe('pii.Person1');
    expect(store.restoreAll(aliasLookingObject)).toEqual(aliasLookingObject);
  });

  it('returns the same reference when no aliases are restorable', () => {
    const freshStore = createPiiLedgerStore();
    const untouched = {
      text: 'pii.Person1 was never allocated',
      nested: ['m1@d1.invalid', { owner: 'pii.Person1' }],
    };

    // Mutation-sensitive: removing the byKindBaseAlias.size === 0 fast path
    // makes restoreArgs deep-rebuild this object, so identity is lost.
    expect(freshStore.restoreAll(untouched)).toBe(untouched);

    const disposedStore = createPiiLedgerStore();
    const { ledger } = disposedStore.create();
    const aliased = aliasFields(ledger, { name: 'Alice Smith' }, [
      { path: 'name', kind: 'name' },
    ]) as { name: string };
    expect(aliased.name).toBe('pii.Person1');
    disposedStore.dispose();

    const afterDispose = { message: `Stale alias ${aliased.name}` };
    expect(disposedStore.restoreAll(afterDispose)).toBe(afterDispose);
  });

  it('passes through aliases after dispose but restores the same input before dispose', () => {
    const store = createPiiLedgerStore();
    const { ledger } = store.create();
    const aliased = aliasFields(ledger, { name: 'Alice Smith' }, [
      { path: 'name', kind: 'name' },
    ]) as { name: string };
    const input = {
      summary: `Escalate ${aliased.name}`,
      assignees: [aliased.name],
    };

    expect(aliased.name).toBe('pii.Person1');
    expect(store.restoreAll(input)).toEqual({
      summary: 'Escalate Alice Smith',
      assignees: ['Alice Smith'],
    });

    store.dispose();

    expect(() => store.restoreAll(input)).not.toThrow();
    expect(store.restoreAll(input)).toEqual(input);
  });

  it('returns non-string primitives unchanged', () => {
    const store = createPiiLedgerStore();
    const { ledger } = store.create();
    const aliased = aliasFields(ledger, { name: 'Alice Smith' }, [
      { path: 'name', kind: 'name' },
    ]) as { name: string };

    expect(aliased.name).toBe('pii.Person1');
    expect(store.restoreAll(aliased.name)).toBe('Alice Smith');

    expect(store.restoreAll(42)).toBe(42);
    expect(store.restoreAll(null)).toBeNull();
    expect(store.restoreAll(false)).toBe(false);
  });
});

describe('pii-protect — D-167 Slice 3 pre-scan collision-proofing (recipe mode)', () => {
  it('a user-typed pii.Person1 literal round-trips and does not un-alias into a real value', () => {
    // The note both NAMES a real person (the `owner` identifier field, aliased to
    // a pii.Person<N>) AND contains the literal token "pii.Person1" (the recipe
    // author / source data anonymizing a different person). Without the Slice 3
    // pre-scan the literal would un-alias into the real owner on restore.
    const out = doProtect(
      { owner: 'Alice Chen', note: 'Alice Chen agreed; ping pii.Person1 too' },
      [{ path: 'owner', kind: 'name' }, { path: 'note', kind: 'content' }],
    );
    const aliased = out.aliased as { owner: string; note: string };
    // The literal reserved pii.Person1, so the real owner aliases PAST it.
    expect(aliased.owner).toBe('pii.Person2');
    expect(aliased.note).toBe('pii.Person2 agreed; ping pii.Person1 too');

    const back = doRestore(out.aliased, out.ledger_handle).restored as {
      owner: string;
      note: string;
    };
    expect(back.owner).toBe('Alice Chen');
    // The literal survives verbatim — NOT corrupted into "Alice Chen".
    expect(back.note).toBe('Alice Chen agreed; ping pii.Person1 too');
  });
});
