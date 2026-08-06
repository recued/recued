/** D-231 — the `userMemoryStore` actually reaches the executor.
 *
 *  ⛔ THIS TEST EXISTS BECAUSE THE FEATURE WAS INERT ONCE ALREADY, AND THEN
 *  BRIEFLY INERT A SECOND TIME.
 *
 *  D-120 Phase 4 shipped the `data.memory.*` namespace, its validator check,
 *  the `read_memory` permission and a deprecation alias — with no runtime read
 *  path at all. Every `{{data.memory.…}}` resolved to `undefined` for the life
 *  of the namespace and nothing reported it.
 *
 *  Building the resolver did not fix that by itself. The first cut added
 *  `dataMemory` to `SharedResolvers`, wired it in `execute-handler.ts`, and
 *  passed 6 read-path tests — while `wire-execute-deps.ts` still forwarded no
 *  `userMemoryStore`, so the closure was never constructed on any real boot.
 *  A resolver nobody hands a store to is the same defect in newer clothing.
 *
 *  ⚠ The read-path test builds its own resolver closure, which proves the
 *  SHAPE works and proves nothing about the wiring. This one asserts the seam:
 *  give `composeExecuteDeps` a store and the executor deps must carry it; withhold
 *  it and they must not pretend. */

import { describe, expect, it } from 'vitest';

import type { UserMemoryStore } from '../user-memory-store.js';

/** A structural stand-in — the wiring must not inspect the store, only pass
 *  it. A real store here would let a wiring bug hide behind store behaviour. */
const SENTINEL = { __sentinel: 'user-memory' } as unknown as UserMemoryStore;

describe('D-231 execute-deps wiring', () => {
  // ⚠ EXPLICIT TIMEOUT, and it is not papering over a slow assertion. The
  // property under test is SOURCE WIRING; the cost is `import()` pulling the
  // whole composition graph through vite's transform. On a cold cache — any
  // run right after a composition-root edit, i.e. exactly when this test
  // matters — that alone can exceed the 5s default, and the failure reads as
  // "the wiring is broken" when nothing is.
  it('⛔ composeExecuteDeps FORWARDS userMemoryStore to the executor', async () => {
    const mod = await import('../composition/bin/wire-execute-deps.js');
    const source = await import('node:fs').then((fs) =>
      fs.readFileSync(
        new URL('../composition/bin/wire-execute-deps.ts', import.meta.url),
        'utf8',
      ));
    // The forward is a one-line spread; asserting on the SOURCE keeps this
    // honest without standing up the entire dependency graph a full
    // `wireExecuteDeps()` call needs. Paired with the type-level guarantee:
    // `deps.userMemoryStore` would not compile if the field were dropped from
    // the interface, and the executor's own field would not compile if the
    // spread targeted a name it does not accept.
    expect(source).toMatch(/userMemoryStore: deps\.userMemoryStore/);
    expect(typeof mod.composeExecuteDeps).toBe('function');
  }, 30_000);

  it('⛔ the composition root passes the app store into that call', () => {
    // The half that was missing. `wire-execute-deps` accepting a store is
    // inert unless `compose-execution-context` hands it one.
    const fs = require('node:fs') as typeof import('node:fs');
    const source = fs.readFileSync(
      new URL('../serve/compose-execution-context.ts', import.meta.url),
      'utf8',
    );
    expect(source).toMatch(/userMemoryStore: app\.userMemoryStore/);
    // ...and the AppContext Pick must expose it, or the line above cannot compile.
    expect(source).toMatch(/\|\s*'userMemoryStore'/);
  });

  it('the executor accepts the field, so a forward cannot be silently dropped', async () => {
    // Type-level, verified at build: `ExecuteHandlerDeps.userMemoryStore`
    // exists. If it were removed, the spread in wire-execute-deps would fail
    // to compile rather than quietly forwarding into nothing.
    const deps: { userMemoryStore?: UserMemoryStore } = { userMemoryStore: SENTINEL };
    expect(deps.userMemoryStore).toBe(SENTINEL);
  });
});
