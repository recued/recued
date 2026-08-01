/** `ServerRpcRegistry` (type) ↔ `SERVER_RPC_METHODS` (runtime list) ratchet.
 *
 *  The server rpc surface is declared TWICE:
 *
 *    · `ServerRpcRegistry` — the compile-time interface. Adding a key here is
 *      what makes `rpcConn.call('…')` typecheck and what the handler slices are
 *      typed against.
 *    · `SERVER_RPC_METHODS` / `SERVER_RPC_METHOD_SET` — the runtime array the
 *      dispatcher routes from.
 *
 *  Nothing made them agree. A type-only addition typechecks clean, passes every
 *  handler unit test, and then `ws-server.ts` THROWS at wire time
 *  (`handler wired for '…' which is not in SERVER_RPC_METHOD_SET`) — so the
 *  first thing that notices is the server refusing to boot.
 *
 *  That is exactly how `collection.calendar.attachGraphGrant` shipped: added to
 *  the interface + the handler slice, absent from the list, green across 8691
 *  tests, dead on boot. This file closes it at TYPECHECK time instead.
 *
 *  ⚠ These are COMPILE-time assertions. They fail under `npm run
 *  typecheck:tests`, not by throwing at runtime — the runtime `it` blocks below
 *  exist so the file is also a visible, named test rather than a silent
 *  type-only artifact. */

import { describe, expect, it } from 'vitest';
import { SERVER_RPC_METHODS, SERVER_RPC_METHOD_SET } from '../index.js';
import type { ServerRpcRegistry } from '../index.js';

type RegistryKey = keyof ServerRpcRegistry & string;
type ListedMethod = (typeof SERVER_RPC_METHODS)[number];

/** Declared in the interface but NOT routable at runtime — the direction that
 *  bricks server boot. */
type MissingFromList = Exclude<RegistryKey, ListedMethod>;

/** Routable at runtime with no typed contract — the direction that lets a
 *  caller reach a method no handler is typed for. */
type MissingFromRegistry = Exclude<ListedMethod, RegistryKey>;

/** Resolves to `true` only when the exclusion is empty; otherwise `never`, and
 *  the assignment below stops compiling with the offending method names in the
 *  error text. */
type IsEmpty<T> = [T] extends [never] ? true : never;

// ⛔ If this line fails to compile, a method is in `ServerRpcRegistry` but not in
// `SERVER_RPC_METHODS`. The server will throw at wire time. Add it to the array
// in `rpc/server-registry.ts` — do not delete this assertion.
const _everyRegistryKeyIsRoutable: IsEmpty<MissingFromList> = true;

// ⛔ If this line fails to compile, a method is routable but has no entry in
// `ServerRpcRegistry`.
const _everyRoutableMethodIsTyped: IsEmpty<MissingFromRegistry> = true;

void _everyRegistryKeyIsRoutable;
void _everyRoutableMethodIsTyped;

describe('server rpc surface — type registry ↔ runtime method list', () => {
  it('keeps the runtime list free of duplicates', () => {
    // A duplicate is harmless to the Set but means two edits added the same
    // method, which usually means one of them was a merge artifact.
    expect(SERVER_RPC_METHODS.length).toBe(new Set(SERVER_RPC_METHODS).size);
  });

  it('derives the routing Set from the list, so the two cannot drift', () => {
    expect(SERVER_RPC_METHOD_SET.size).toBe(new Set(SERVER_RPC_METHODS).size);
    for (const method of SERVER_RPC_METHODS) {
      expect(SERVER_RPC_METHOD_SET.has(method)).toBe(true);
    }
  });

  it('routes the shared-Graph-grant attach (the method this ratchet was born from)', () => {
    // Named explicitly, not as decoration: it is the regression. A future
    // refactor that drops it from the list would otherwise only surface as a
    // failed server boot.
    expect(SERVER_RPC_METHOD_SET.has('collection.calendar.attachGraphGrant')).toBe(true);
  });
});
