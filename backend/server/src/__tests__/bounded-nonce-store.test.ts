/** The bounded single-use nonce store shared by every public door.
 *
 *  ⛔ These are RETENTION tests, not just correctness tests. The D-210 audit
 *  fixed unbounded growth in ONE of five stores; the four written from the same
 *  template kept the leak, each reachable from an unauthenticated endpoint. The
 *  regression guards below are what make "fixed the class, not the file" true. */

import { describe, expect, it } from 'vitest';
import {
  createBoundedNonceStore,
  DEFAULT_NONCE_MAX_ENTRIES,
} from '../bounded-nonce-store.js';
import { createInMemorySchedulingFormNonceStore, SCHEDULING_FORM_NONCE_TTL_MS }
  from '../ports/reception/handlers/scheduling-link.js';
import { createInMemoryIntakeFormNonceStore, INTAKE_FORM_NONCE_TTL_MS }
  from '../ports/reception/handlers/intake-form.js';
import { createInMemoryApprovalLinkNonceStore, APPROVAL_LINK_NONCE_TTL_MS }
  from '../ports/reception/handlers/approval-link.js';
import { createInMemoryDropLinkNonceStore, DROP_LINK_NONCE_TTL_MS }
  from '../ports/reception/handlers/drop-link.js';
import { createInMemoryAskLandingNonceStore, ASK_LANDING_NONCE_TTL_MS }
  from '../ask-landing-nonce-store.js';

const TTL = 30 * 60 * 1000;

describe('bounded nonce store — core', () => {
  it('round-trips within the TTL and is single-use', () => {
    const store = createBoundedNonceStore<null>({ ttlMs: TTL });
    const nonce = store.issue('scope-a', 0, null);
    expect(store.consume('scope-a', nonce, TTL)).toEqual({ value: null });
    expect(store.consume('scope-a', nonce, TTL)).toBeNull();
  });

  it('rejects a wrong scope, an unknown nonce and an expired nonce', () => {
    const store = createBoundedNonceStore<null>({ ttlMs: TTL });
    const nonce = store.issue('scope-a', 0, null);
    expect(store.consume('scope-b', nonce, 0)).toBeNull();
    expect(store.consume('scope-a', 'never-issued', 0)).toBeNull();
    const stale = store.issue('scope-a', 0, null);
    expect(store.consume('scope-a', stale, TTL + 1)).toBeNull();
  });

  it('leaves a cross-scope-presented nonce usable BY DEFAULT', () => {
    // ⛔ The reception doors' posture, and the default. A visitor with two links
    // open, a prefetch, or a stray resubmit must not burn a nonce out from
    // under the page that legitimately holds it.
    const store = createBoundedNonceStore<null>({ ttlMs: TTL });
    const nonce = store.issue('scope-a', 0, null);
    expect(store.consume('scope-b', nonce, 0)).toBeNull();
    expect(store.consume('scope-a', nonce, 0)).not.toBeNull();
  });

  it('spends a cross-scope-presented nonce when the door opts in', () => {
    // Ask-landing's posture: a presented nonce is no longer a secret.
    const store = createBoundedNonceStore<null>({
      ttlMs: TTL,
      spendOnScopeMismatch: true,
    });
    const nonce = store.issue('ask-1', 0, null);
    expect(store.consume('ask-2', nonce, 0)).toBeNull();
    expect(store.consume('ask-1', nonce, 0)).toBeNull();
  });

  it('carries a per-nonce payload', () => {
    const store = createBoundedNonceStore<{ pair: string }>({ ttlMs: TTL });
    const a = store.issue('scope-a', 0, { pair: 'one' });
    const b = store.issue('scope-a', 0, { pair: 'two' });
    expect(store.consume('scope-a', b, 0)?.value).toEqual({ pair: 'two' });
    expect(store.consume('scope-a', a, 0)?.value).toEqual({ pair: 'one' });
  });

  // ⚠ There is deliberately NO test asserting "expired entries are swept".
  // Under an oldest-first global cap the sweep has no externally observable
  // effect — stale entries are always the oldest, so lazy eviction reclaims
  // exactly what the sweep would. The sweep makes release PROMPT rather than
  // capacity-pressure-driven; the CAP is what actually bounds the store, and
  // the test below is the regression guard that matters.
  // [[feedback_a_test_name_is_a_guarantee]]
  it('bounds total entries, evicting oldest-first', () => {
    const store = createBoundedNonceStore<null>({ ttlMs: TTL, maxEntries: 3 });
    const first = store.issue('scope-a', 0, null);
    const second = store.issue('scope-a', 0, null);
    for (let i = 0; i < 5; i += 1) store.issue('scope-a', 0, null);
    expect(store.consume('scope-a', first, 0)).toBeNull();
    expect(store.consume('scope-a', second, 0)).toBeNull();
  });

  it('bounds per scope ONLY when asked, and never across scopes', () => {
    const capped = createBoundedNonceStore<null>({ ttlMs: TTL, maxPerScope: 2 });
    const evicted = capped.issue('ask-1', 0, null);
    capped.issue('ask-1', 0, null);
    capped.issue('ask-1', 0, null);
    expect(capped.consume('ask-1', evicted, 0)).toBeNull();
    // A different scope is untouched by ask-1's churn.
    const other = capped.issue('ask-2', 0, null);
    capped.issue('ask-1', 0, null);
    capped.issue('ask-1', 0, null);
    expect(capped.consume('ask-2', other, 0)).not.toBeNull();
  });

  it('rejects invalid bounds', () => {
    expect(() => createBoundedNonceStore({ ttlMs: 0 })).toThrow(/positive integer/);
    expect(() => createBoundedNonceStore({ ttlMs: TTL, maxEntries: 0 }))
      .toThrow(/positive integer/);
    expect(() => createBoundedNonceStore({ ttlMs: TTL, maxPerScope: 1.5 }))
      .toThrow(/positive integer/);
  });
});

describe('every public door is bounded and swept', () => {
  // Each door's factory, its TTL, and whether its scope belongs to one
  // decision-maker (per-scope cap safe) or is shared by many visitors.
  const doors = [
    {
      name: 'scheduling-link',
      make: () => createInMemorySchedulingFormNonceStore(),
      ttl: SCHEDULING_FORM_NONCE_TTL_MS,
      sharedScope: true,
    },
    {
      name: 'approval-link',
      make: () => createInMemoryApprovalLinkNonceStore(),
      ttl: APPROVAL_LINK_NONCE_TTL_MS,
      sharedScope: true,
    },
    {
      name: 'drop-link',
      make: () => createInMemoryDropLinkNonceStore(),
      ttl: DROP_LINK_NONCE_TTL_MS,
      sharedScope: true,
    },
    {
      name: 'ask-landing',
      make: () => createInMemoryAskLandingNonceStore(),
      ttl: ASK_LANDING_NONCE_TTL_MS,
      sharedScope: false,
    },
  ] as const;

  for (const door of doors) {
    it(`${door.name}: an issued-but-never-consumed nonce does not outlive its TTL`, () => {
      const store = door.make();
      const abandoned = store.issue('endpoint-1', 0);
      // The realistic leak driver: a visitor who loads the page and never
      // submits, a mail scanner, a crawler. Nothing consumes.
      expect(store.consume('endpoint-1', abandoned, door.ttl + 1)).toBe(false);
    });

    it(`${door.name}: round-trips and is single-use`, () => {
      const store = door.make();
      const nonce = store.issue('endpoint-1', 0);
      expect(store.consume('endpoint-1', nonce, 0)).toBe(true);
      expect(store.consume('endpoint-1', nonce, 0)).toBe(false);
      const other = store.issue('endpoint-1', 0);
      expect(store.consume('endpoint-2', other, 0)).toBe(false);
    });
  }

  it('intake-form: same guarantees, and the pair payload survives copy-in/out', () => {
    const store = createInMemoryIntakeFormNonceStore();
    const abandoned = store.issue('endpoint-1', 0);
    expect(store.consume('endpoint-1', abandoned, INTAKE_FORM_NONCE_TTL_MS + 1))
      .toBeNull();

    const binding = {
      version: 1 as const,
      form_definition_id: 'fd_client_inquiry_v1',
      recipe_id: 'paired-recipe',
      recipe_version: 1,
      pair_revision: `d200-pair-v1-${'a'.repeat(64)}` as const,
    };
    const nonce = store.issue('endpoint-1', 0, binding);
    // Mutating the caller's object must not change what consume reads back —
    // the stamp is immutable render evidence.
    (binding as { recipe_id: string }).recipe_id = 'tampered';
    const stamp = store.consume('endpoint-1', nonce, 0);
    expect(stamp?.pair_binding).toMatchObject({ recipe_id: 'paired-recipe' });
    // A malformed binding is still refused at the door.
    expect(() => store.issue('endpoint-1', 0, { recipe_id: 'nope' } as never))
      .toThrow(/invalid pair binding/);
  });

  it('shared-scope doors do NOT cap per scope — concurrent visitors coexist', () => {
    // ⛔ REGRESSION GUARD. Copying ask-landing's `maxPerAsk: 4` onto a door
    // scoped by `endpoint_id` would mean the 5th concurrent visitor to a
    // booking page silently evicts the 1st visitor's nonce and their submit
    // 403s. The global ceiling is the bound for these, not a per-scope one.
    for (const door of doors.filter((d) => d.sharedScope)) {
      const store = door.make();
      const first = store.issue('endpoint-1', 0);
      for (let i = 0; i < 200; i += 1) store.issue('endpoint-1', 0);
      expect(
        [door.name, store.consume('endpoint-1', first, 0)],
      ).toEqual([door.name, true]);
    }
  });

  it('the shared default ceiling is high enough for real in-flight load', () => {
    // 60 req/min against a 30-min TTL ⇒ ~1,800 live nonces from one source.
    expect(DEFAULT_NONCE_MAX_ENTRIES).toBeGreaterThan(1_800);
  });

  it('EVERY door is bounded — the oldest entry cannot survive past the ceiling', () => {
    // ⛔ THE ORIGINAL DEFECT, pinned at the door rather than the core. Pre-fix
    // each of these was a plain Map freed only by a successful `consume`, so a
    // visitor who never submits — or a scanner, or a crawler — left an entry
    // resident for the life of the process. Unbounded meant the first nonce was
    // STILL consumable after any number of later issues; now it is not.
    for (const door of doors) {
      const store = door.make();
      const first = store.issue('endpoint-1', 0);
      for (let i = 0; i < DEFAULT_NONCE_MAX_ENTRIES + 1; i += 1) {
        // Same clock throughout: this is capacity pressure, not expiry.
        store.issue(`endpoint-${i % 7}`, 0);
      }
      expect([door.name, store.consume('endpoint-1', first, 0)])
        .toEqual([door.name, false]);
    }
  });
});
