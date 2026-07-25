/** D-214 S0 — the before-turn hook that populates the root-request edge.
 *
 *  The interesting assertions are the negative ones: that a tool loop does NOT
 *  mint a root per turn, that an unresolved cross-stream resume fails SAFE
 *  rather than attaching to the wrong root, and that the hook contributes
 *  nothing to the prompt. Each of those is invisible in a happy-path check.
 */

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TurnContext } from '@recued/middleware';
import {
  SPAN_ANCHOR_EXPLICIT_CONTINUATION_STATE_KEY,
  SPAN_ANCHOR_MIDDLEWARE_ID,
  createSpanAnchorSource,
  type SpanAnchorDeps,
} from '../chat-span-anchor-middleware.js';
import {
  createExecutionSpanAnchorStore,
  type ExecutionSpanAnchorStore,
} from '../storage/execution-span-anchor-store.js';

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const makeStore = (): ExecutionSpanAnchorStore => {
  const db = new Database(':memory:');
  cleanups.push(() => db.close());
  // No key provider — base64 fallback. The sealing path has its own suite;
  // here the subject is the hook's decisions, not the crypto.
  return createExecutionSpanAnchorStore(db);
};

interface HarnessCtx {
  ctx: TurnContext;
  contributed: Array<{ role: string; text: string }>;
  resolved: string[];
}

/** A `TurnContext` sufficient for this hook. `state` is deliberately shared
 *  across the turns of one stream — that IS the within-stream mechanism under
 *  test, so a per-turn fresh Map would make the tool-loop case pass vacuously. */
const makeCtx = (
  state: Map<string, unknown>,
  over: {
    session_id?: string;
    turn_id?: string;
    turn_index?: number;
    surface?: string;
    history?: Array<{ role: string; text: string }>;
  } = {},
): HarnessCtx => {
  const contributed: Array<{ role: string; text: string }> = [];
  const resolved: string[] = [];
  const ctx = {
    session_id: over.session_id ?? 'sess-1',
    surface: over.surface ?? 'chat',
    turn_index: over.turn_index ?? 0,
    turn_id: over.turn_id ?? 'turn-1',
    history: over.history ?? [
      { role: 'user', text: 'email Alice the Q3 report' },
    ],
    prompt: {
      contribute: (part: { role: string; text: string }) => {
        contributed.push(part);
      },
    },
    interjections: [],
    capacity: {},
    out: {},
    state,
    resolve: (text: string) => {
      resolved.push(text);
    },
  } as unknown as TurnContext;
  return { ctx, contributed, resolved };
};

/** ⚠ The minter counter must live OUTSIDE the returned object. `getDeps` is
 *  late-bound and called once per turn, so a counter closed over inside
 *  `makeDeps` would reset every turn and mint `root-1` forever — which silently
 *  turns "opened a second root" into "joined the first" and made the
 *  fail-safe test below pass for the wrong reason. */
const makeDepsFactory = (
  store: ExecutionSpanAnchorStore,
  over: Partial<SpanAnchorDeps> = {},
): (() => SpanAnchorDeps) => {
  let n = 0;
  return () => ({
    store,
    mintRootRequestId: () => `root-${(n += 1)}`,
    now: () => 1_000,
    ...over,
  });
};

describe('D-214 span-anchor hook — opening a span', () => {
  it('opens a root for the first turn and anchors it', async () => {
    const store = makeStore();
    const hook = createSpanAnchorSource(makeDepsFactory(store));
    const { ctx } = makeCtx(new Map());

    await hook.prompt?.(ctx);

    expect(store.resolveRoot('sess-1', 'turn-1')).toBe('root-1');
    expect(await store.readRootRequest('root-1')).toBe(
      'email Alice the Q3 report',
    );
  });

  /** ⛔ The one that would silently ruin aggregation. A tool loop is many
   *  turns of ONE user message; a root per turn would make every span its own
   *  case and the recurrence floor unreachable — the same failure mode A18
   *  measured for flow-keyed cases, arriving through a different door. */
  it('does NOT mint a new root per turn of one stream', async () => {
    const store = makeStore();
    const hook = createSpanAnchorSource(makeDepsFactory(store));
    const state = new Map<string, unknown>();

    await hook.prompt?.(makeCtx(state, { turn_id: 'turn-1', turn_index: 0 }).ctx);
    await hook.prompt?.(makeCtx(state, { turn_id: 'turn-2', turn_index: 1 }).ctx);
    await hook.prompt?.(makeCtx(state, { turn_id: 'turn-3', turn_index: 2 }).ctx);

    expect(store.listAnchors('root-1').map((a) => a.turn_id)).toEqual([
      'turn-1',
      'turn-2',
      'turn-3',
    ]);
    expect(store.getRoot('root-2')).toBeUndefined();
  });

  /** Lineage, not just membership: `origin_turn_id` is what makes "which turn
   *  resumed which" recoverable once turns share a root (§4.2). */
  it('records within-stream lineage turn by turn', async () => {
    const store = makeStore();
    const hook = createSpanAnchorSource(makeDepsFactory(store));
    const state = new Map<string, unknown>();

    await hook.prompt?.(makeCtx(state, { turn_id: 'turn-1' }).ctx);
    await hook.prompt?.(makeCtx(state, { turn_id: 'turn-2' }).ctx);

    expect(store.listAnchors('root-1').map((a) => a.origin_turn_id)).toEqual([
      undefined,
      'turn-1',
    ]);
  });

  it('is idempotent — a replayed turn keeps its first anchor', async () => {
    const store = makeStore();
    const hook = createSpanAnchorSource(makeDepsFactory(store));

    await hook.prompt?.(makeCtx(new Map(), { turn_id: 'turn-1' }).ctx);
    // A fresh state Map is the point: a retried turn has lost its scratch.
    await hook.prompt?.(makeCtx(new Map(), { turn_id: 'turn-1' }).ctx);

    expect(store.listAnchors('root-1').map((a) => a.turn_id)).toEqual(['turn-1']);
    expect(store.getRoot('root-2')).toBeUndefined();
  });
});

describe('D-214 span-anchor hook — cross-stream continuation', () => {
  it('joins an explicitly named same-session prior turn without accepting a root id', async () => {
    const store = makeStore();
    const hook = createSpanAnchorSource(makeDepsFactory(store));
    await hook.prompt?.(makeCtx(new Map(), { turn_id: 'turn-1' }).ctx);
    const state = new Map<string, unknown>([
      [SPAN_ANCHOR_EXPLICIT_CONTINUATION_STATE_KEY, {
        origin_turn_id: 'turn-1',
      }],
    ]);
    await hook.prompt?.(
      makeCtx(state, {
        turn_id: 'turn-2',
        history: [{ role: 'user', text: 'try a different approach' }],
      }).ctx,
    );

    expect(store.listAnchors('root-1')).toMatchObject([
      { turn_id: 'turn-1' },
      { turn_id: 'turn-2', origin_turn_id: 'turn-1' },
    ]);
    expect(store.getRoot('root-2')).toBeUndefined();
    expect(Object.hasOwn(
      state.get(SPAN_ANCHOR_EXPLICIT_CONTINUATION_STATE_KEY) as object,
      'root_request_id',
    )).toBe(false);
  });

  /** ⛔ With no resolver wired, a resume must open a FRESH root, not attach to
   *  whatever came before. Attaching would fail OPEN — the span roots at the
   *  old request and manufactures a wrong case. Opening fresh fails SAFE — the
   *  cross-stream span merely does not compile. §8.2.2 chose the safe failure,
   *  so this test asserts a deliberate limitation, not an achievement. */
  it('opens a fresh root when no resolver is wired — fails safe, never attaches', async () => {
    const store = makeStore();
    const hook = createSpanAnchorSource(makeDepsFactory(store));

    await hook.prompt?.(makeCtx(new Map(), { turn_id: 'turn-1' }).ctx);
    // A later stream: new scratch, as a real resume would have.
    await hook.prompt?.(
      makeCtx(new Map(), {
        turn_id: 'turn-2',
        history: [{ role: 'user', text: 'yes, go ahead' }],
      }).ctx,
    );

    expect(store.resolveRoot('sess-1', 'turn-1')).toBe('root-1');
    expect(store.resolveRoot('sess-1', 'turn-2')).toBe('root-2');
    expect(store.listAnchors('root-1').map((a) => a.turn_id)).toEqual(['turn-1']);
  });

  it('joins the resolved root when a durable correlation supplies one', async () => {
    const store = makeStore();
    // Realistic: a resolver reads durable plan links, and none exist before
    // the first turn. A resolver that answered on turn 1 would be inventing a
    // root, which is the failure the existence check below defends against.
    const resolveContinuation = vi.fn((input: { turn_id: string }) =>
      input.turn_id === 'turn-2'
        ? { root_request_id: 'root-1', origin_turn_id: 'turn-1' }
        : undefined,
    );
    const hook = createSpanAnchorSource(
      makeDepsFactory(store, { resolveContinuation }),
    );

    await hook.prompt?.(makeCtx(new Map(), { turn_id: 'turn-1' }).ctx);
    await hook.prompt?.(
      makeCtx(new Map(), {
        turn_id: 'turn-2',
        history: [{ role: 'user', text: 'yes, go ahead' }],
      }).ctx,
    );

    expect(store.listAnchors('root-1').map((a) => a.turn_id)).toEqual([
      'turn-1',
      'turn-2',
    ]);
    expect(store.getRoot('root-2')).toBeUndefined();
  });

  /** ⛔ The resolver is a PORT someone else implements, and SQLite enforces
   *  foreign keys only when `foreign_keys` is ON — so a resolver naming a root
   *  that was evicted or simply wrong would otherwise insert a DANGLING anchor.
   *  That still degrades safely (no root request ⇒ nothing compiles) but it
   *  degrades invisibly, and a dangling row reads exactly like a real one.
   *  Falling through to a fresh root keeps the failure safe AND visible. */
  it('ignores a resolved root that does not exist and opens a fresh one', async () => {
    const store = makeStore();
    const resolveContinuation = vi.fn(() => ({
      root_request_id: 'root-does-not-exist',
    }));
    const hook = createSpanAnchorSource(
      makeDepsFactory(store, { resolveContinuation }),
    );

    await hook.prompt?.(makeCtx(new Map(), { turn_id: 'turn-1' }).ctx);

    expect(store.resolveRoot('sess-1', 'turn-1')).toBe('root-1');
    expect(store.listAnchors('root-does-not-exist')).toEqual([]);
    expect(await store.readRootRequest('root-1')).toBe(
      'email Alice the Q3 report',
    );
  });

  /** The resolver must not be consulted for a turn already anchored, nor for
   *  within-stream turns — both are exact already, and asking would give an
   *  imprecise source a chance to override a precise one. */
  it('does not consult the resolver for within-stream turns', async () => {
    const store = makeStore();
    const resolveContinuation = vi.fn(() => undefined);
    const hook = createSpanAnchorSource(
      makeDepsFactory(store, { resolveContinuation }),
    );
    const state = new Map<string, unknown>();

    await hook.prompt?.(makeCtx(state, { turn_id: 'turn-1' }).ctx);
    expect(resolveContinuation).toHaveBeenCalledTimes(1); // the opening turn
    await hook.prompt?.(makeCtx(state, { turn_id: 'turn-2' }).ctx);
    expect(resolveContinuation).toHaveBeenCalledTimes(1); // unchanged
  });
});

describe('D-214 span-anchor hook — what it must NOT do', () => {
  /** Request-time augmentation is Slice 4, gated behind its own anchoring
   *  metric. A card injected from here would be S4 done in the wrong slice and
   *  unmeasured — and it would also contaminate the very evidence D-214
   *  collects (A2 steering contamination, acceptance #26). */
  it('contributes nothing to the prompt and never resolves the turn', async () => {
    const store = makeStore();
    const hook = createSpanAnchorSource(makeDepsFactory(store));
    const { ctx, contributed, resolved } = makeCtx(new Map());

    await hook.prompt?.(ctx);

    expect(contributed).toEqual([]);
    expect(resolved).toEqual([]);
  });

  /** V1 is chat-only (§5.3) — `outcome.report` is a chat tool, so a messenger
   *  span has no planning model and forms no case. Anchoring it would only
   *  accumulate rows nothing compiles. */
  it('ignores non-chat surfaces', async () => {
    const store = makeStore();
    const hook = createSpanAnchorSource(makeDepsFactory(store));

    await hook.prompt?.(
      makeCtx(new Map(), { surface: 'messenger-telegram' }).ctx,
    );

    expect(store.getRoot('root-1')).toBeUndefined();
  });

  it('no-ops with no deps wired', async () => {
    const hook = createSpanAnchorSource(() => undefined);
    const { ctx } = makeCtx(new Map());
    await expect(hook.prompt?.(ctx)).resolves.toBeUndefined();
  });

  /** A span with no root user request fails §8.2 eligibility anyway — it has
   *  no matchable request shape — so anchoring one would create a row nothing
   *  can key on. */
  it('does not anchor a span with no user message', async () => {
    const store = makeStore();
    const hook = createSpanAnchorSource(makeDepsFactory(store));

    await hook.prompt?.(
      makeCtx(new Map(), { history: [{ role: 'assistant', text: 'hi' }] }).ctx,
    );

    expect(store.getRoot('root-1')).toBeUndefined();
  });

  /** D-214 is advisory end to end (#13/#23). A lost anchor costs one
   *  uncompiled span; a thrown error would cost the user their turn. A locked
   *  FileVault lands here too, and losing the span is correct — the
   *  alternative is storing the prompt unsealed. */
  it('never fails the turn when the store throws', async () => {
    const exploding = {
      getAnchor: () => undefined,
      openSpan: () => {
        throw new Error('vault locked');
      },
    } as unknown as ExecutionSpanAnchorStore;
    const hook = createSpanAnchorSource(makeDepsFactory(exploding));
    const { ctx } = makeCtx(new Map());

    await expect(hook.prompt?.(ctx)).resolves.toBeUndefined();
  });

  it('registers under a stable, namespaced id', () => {
    const hook = createSpanAnchorSource(() => undefined);
    expect(hook.id).toBe(SPAN_ANCHOR_MIDDLEWARE_ID);
    expect(hook.id).toBe('d214-span-anchor');
    // Observation only — no after-turn hook exists to process results.
    expect(hook.update).toBeUndefined();
  });
});
