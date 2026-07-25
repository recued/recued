/** D-205 — a confirmed merge now INVALIDATES the enrichment keyed on the identities it
 *  changed. Closes the eighth "declared, built, tested — and wired to nothing" cluster in
 *  this family.
 *
 *  ## The bug
 *  `ContactMergeRpcDeps.onIdentityChanged` has existed since D-138, and its own doc comment
 *  promises *"the boot wire injects the real cascade engine"*. **No boot wire ever did.**
 *  `cascadeForIdentityChange` had **zero production callers** — the only suppliers of the
 *  callback anywhere in the repo were tests.
 *
 *  The reason is almost comically mundane, and it is the same reason D-205 #2c found for
 *  the contact Sources' health: **the engine was never REACHABLE from the composer that
 *  needed it.** `enrichmentCascadeRef` has been on the `AppContext` since D-136, but
 *  `compose-rpc-context.ts` takes a narrowed `Pick<AppContext, …>` that did not list it —
 *  so the contact-merge composer could not see it, could not supply the hook, and every
 *  confirmed merge left the loser's contact-scoped enrichment rows standing, keyed on an
 *  identity that no longer exists.
 *
 *  This is NOT theoretical: the merge substrate is wired, and D-205 #2b shipped the UI
 *  (`#data/contact/scan`) that lets a user trigger merges.
 *
 *  ## What is pinned
 *  The composer supplies `onIdentityChanged` **iff** the engine is present, and it passes
 *  BOTH identities — the losers (whose rows are stale by construction: that identity is
 *  gone) and the survivor (whose aggregates genuinely change, because C-2's projection
 *  reads ACROSS the merge group even though nothing MOVES between contacts).
 *
 *  These drive the REAL composer. A test that hand-built the deps object would prove
 *  nothing about the wire — the wire IS the bug. */

import { describe, expect, it, vi } from 'vitest';

import { composeContactMergeRpcDeps } from '../composition/bin/wire-contact-merge-rpc-deps.js';
import type { CascadeEngine } from '../storage/enrichment-cascade.js';

/** The narrowest input the composer accepts: a contact store (else it returns the
 *  undefined bundle) plus the bus. Everything else is optional and irrelevant here. */
const composeWith = (enrichmentCascade: CascadeEngine | undefined) =>
  composeContactMergeRpcDeps({
    contactStore: {} as never,
    annotationStore: undefined,
    promptStore: undefined,
    housekeepingState: undefined,
    db: undefined,
    eventBus: { emit: () => {} } as never,
    schedulerRegistry: { getScheduler: () => undefined } as never,
    setActiveScanMode: () => {},
    enrichmentCascade,
  });

describe('D-205 — the merge identity cascade is WIRED', () => {
  it('the composer supplies onIdentityChanged when the engine is present', () => {
    const cascadeForIdentityChange = vi.fn();
    const { contactMergeDeps } = composeWith({ cascadeForIdentityChange } as never);

    // Before this fix the composer never even looked at a cascade engine, so this was
    // always undefined in production and the hook at contact-merge-handler.ts:293 was
    // permanently skipped.
    expect(contactMergeDeps?.onIdentityChanged).toBeDefined();
  });

  it('a merge invalidates BOTH the losers AND the survivor', () => {
    const cascadeForIdentityChange = vi.fn();
    const { contactMergeDeps } = composeWith({ cascadeForIdentityChange } as never);

    contactMergeDeps!.onIdentityChanged!({
      survivor_email: 'bob@example.com',
      loser_emails: ['bob.old@example.com', 'b@example.com'],
    });

    expect(cascadeForIdentityChange).toHaveBeenCalledTimes(1);
    const [scope, source_id, identity_keys] = cascadeForIdentityChange.mock.calls[0]!;

    expect(scope).toBe('contact');
    // `source_id` is observability-only (the cascade hands it to `fireNotifier` and never
    // keys on it), so the survivor is the honest label for "which merge caused this".
    expect(source_id).toBe('bob@example.com');

    // 🔑 BOTH, each for its own reason:
    //   · the LOSERS  — their identity is gone; rows keyed on it are stale by construction.
    //   · the SURVIVOR — its aggregates change even though nothing MOVED between contacts,
    //     because C-2's projection reads ACROSS the merge group (D-205 rule 2). Omitting it
    //     would leave the survivor's enrichment computed from pre-merge evidence — a stale
    //     aggregate that looks perfectly healthy, which is the failure mode this whole
    //     family keeps producing.
    expect([...(identity_keys as string[])].sort()).toEqual(
      ['b@example.com', 'bob.old@example.com', 'bob@example.com'].sort(),
    );
  });

  it('no engine (dbless harness) → no hook, exactly as before', () => {
    const { contactMergeDeps } = composeWith(undefined);
    // Behaviour-preserving where the engine genuinely is not there. The hook is optional
    // on `ContactMergeRpcDeps` and the handler already guards `if (deps.onIdentityChanged)`.
    expect(contactMergeDeps?.onIdentityChanged).toBeUndefined();
    // …but the composer still produced a usable bundle.
    expect(contactMergeDeps?.contactStore).toBeDefined();
  });
});
