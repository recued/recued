/** D-214 S0 — span-anchor substrate composer.
 *
 *  Builds the root-request edge store and the late-bound `SpanAnchorDeps` the
 *  before-turn hook (`chat-span-anchor-middleware.ts`) resolves per turn.
 *
 *  Gated on `db`: a dbless harness gets `undefined`, the hook is never built,
 *  and D-214 has **zero footprint on the turn**. That is not a degenerate case
 *  to tolerate — it is D-214's default posture. The feature is unproven and
 *  §13 Slice 5 gates it behind a bounded experiment before default-on, so
 *  "not wired" has to remain a first-class, working state (§0 R4).
 *
 *  ⛔ **The store is built ONCE, at compose time — not per turn.** It prepares
 *  its statements and installs its schema in the constructor, so rebuilding it
 *  per turn would re-prepare on every message. The hook's `getDeps` is
 *  late-bound for *resolution timing*, not to defer construction; it returns
 *  this same bundle every turn.
 *
 *  ⛔ **`resolveContinuation` is deliberately absent.** Cross-stream spans (an
 *  approved plan re-issuing on the user's next message) are therefore NOT
 *  linked, and that is the designed V1 posture, not an oversight — see the
 *  header of `chat-span-anchor-middleware.ts`. At before-turn time nothing
 *  durable distinguishes "resumes the pending plan" from "asks something new":
 *  `chat_plans.execution_turn_id`, the fact that would, is stamped at
 *  execution — *after* this hook runs. Guessing "continue" fails OPEN (the span
 *  roots at the old request and manufactures a wrong case); opening a fresh
 *  root fails SAFE (the span merely never compiles). §8.2.2 chose the safe
 *  failure. Wiring a predictive resolver here would silently reverse that
 *  ruling.
 */

import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';

import type { SpanAnchorDeps } from '../../chat-span-anchor-middleware.js';
import {
  createExecutionSpanAnchorStore,
  type SpanAnchorKeyProvider,
} from '../../storage/execution-span-anchor-store.js';

export interface ComposeSpanAnchorDeps {
  /** SQLite handle. Undefined → composer returns `undefined` and the hook is
   *  never built. */
  db: Database.Database | undefined;
  /** The chat sub-DEK provider — the SAME one `createChatStore` receives
   *  (`keys.keyProvider('chat')`). The root request is a verbatim user prompt,
   *  so it is sealed under the chat domain rather than a D-214-specific one:
   *  same secret, and a second domain would double the key-lifecycle surface
   *  for no gain.
   *
   *  ⚠ Undefined means the store falls back to **base64, not encryption** — the
   *  documented `chat-store` discipline for dbless harnesses and the
   *  pre-KeyManager boot window. Production always passes it; if you find
   *  yourself passing `undefined` on a real server, that is a bug in the boot
   *  order, not a supported configuration. */
  chatKeyProvider: SpanAnchorKeyProvider | undefined;
  /** Injected so tests are deterministic. Defaults to `randomUUID`. */
  newRootRequestId?: () => string;
}

/** Compose the span-anchor substrate.
 *
 *  Returns the getter shape `createChatStreamMiddlewares` expects
 *  (`getSpanAnchorDeps`), or `undefined` when there is no db — in which case
 *  the caller passes nothing and the hook is not registered at all. */
export const composeSpanAnchor = (
  deps: ComposeSpanAnchorDeps,
): (() => SpanAnchorDeps) | undefined => {
  const { db, chatKeyProvider } = deps;
  if (!db) return undefined;

  const store = createExecutionSpanAnchorStore(db, chatKeyProvider);
  const mintRootRequestId = deps.newRootRequestId ?? (() => randomUUID());

  // One frozen bundle, returned by every call. See the header: late binding is
  // about resolution timing, not deferred construction.
  const bundle: SpanAnchorDeps = { store, mintRootRequestId };
  return () => bundle;
};
