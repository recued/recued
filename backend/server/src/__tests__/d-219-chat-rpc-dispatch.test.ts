/** D-219 item 2/2b — the three Learning rpcs, driven through the DISPATCH MAP.
 *
 *  ⚠ THE NAMES ARE ALREADY SAFE — don't add tests for them. Both sides are
 *  typed against `ServerRpcRegistry`: a typo'd dispatch key fails tsc with
 *  TS2353 ("does not exist in type Pick<CompleteHandlerRegistry, ChatMethods>"),
 *  and a typo'd CLIENT call degrades `rpcConn.call` to `Promise<unknown>`,
 *  which then fails to satisfy `LearningCasesListCaller`. Both verified by
 *  mutation. A test asserting the strings match would restate the type system.
 *
 *  ⛔ WHAT IS NOT SAFE IS THE BEHAVIOUR BEHIND THE NAME. Types pin that a key
 *  exists, never that it forwards the right things: dropping the owner's typed
 *  `prompt` on the way to the dep typechecks cleanly, leaves the whole backend
 *  suite green, and returns a valid-looking draft that simply ignored what they
 *  asked for. Every existing test called a handler symbol directly or asserted
 *  the MCP prefix, so nothing exercised the map at all.
 *
 *  So each test below enters through `makeChatHandlers(deps).handlers[NAME]`
 *  and asserts what reached the DEP and what came back — not that the key is
 *  spelled right.
 */

import { describe, expect, it } from 'vitest';
import { CHAT_RPC_METHODS, type ExecutionCaseLearnedEntry } from '@recued/contracts';

import { makeChatHandlers, type ChatRpcDeps } from '../chat-handler.js';

/** The literals the WEBCLIENT sends. Written out rather than imported from the
 *  server's own union on purpose: importing the server's names would make this
 *  test agree with itself. These are transcribed from
 *  `apps/webclient/src/webclient-bootstrap.ts`. */
const CLIENT_CALLS = {
  learned: 'chat.execution.learned',
  forget: 'chat.execution.forget',
  draft: 'chat.execution.draft_recipe',
  authored: 'chat.execution.authored',
} as const;

const entry = (case_id: string): ExecutionCaseLearnedEntry => ({
  case_id,
  request: ['send a weekly summary'],
  flows: [],
  shown_to_model: false,
  request_observations: 2,
  last_seen_at: 1_750_000_000_000,
});

interface Rig {
  deps: ChatRpcDeps;
  forgot: string[];
  drafted: Array<{ case_id: string; prompt: string }>;
  authored: Array<{ case_id: string; recipe_id: string }>;
}

const setup = (): Rig => {
  const forgot: string[] = [];
  const drafted: Array<{ case_id: string; prompt: string }> = [];
  const authored: Array<{ case_id: string; recipe_id: string }> = [];
  const deps = {
    executionCaseLearned: async () => [entry('case_alpha'), entry('case_beta')],
    executionCaseForget: async (case_id: string) => {
      forgot.push(case_id);
      return { removed: true, cases_remaining: 1 };
    },
    executionCaseDraftRecipe: async (input: { case_id: string; prompt: string }) => {
      drafted.push(input);
      return { ok: true, recipe: { recipe_id: 'drafted' }, issues: [] };
    },
    executionCaseAuthored: async (input: { case_id: string; recipe_id: string }) => {
      authored.push(input);
      return { recorded: true };
    },
  } as unknown as ChatRpcDeps;
  return { deps, forgot, drafted, authored };
};

const sliceOf = (deps: ChatRpcDeps) => {
  const slice = makeChatHandlers(deps);
  expect(slice).toBeDefined();
  return slice!;
};

/** These tests enter below the transport, so they intentionally supply only the
 * RPC params and omit the client/context arguments owned by the wire adapter. */
const callableHandlers = (deps: ChatRpcDeps) =>
  sliceOf(deps).handlers as unknown as Record<
    string, (args: unknown) => Promise<unknown>
  >;

describe('D-219 — the Learning rpcs are reachable under the names the client sends', () => {
  it('the METHODS ARRAY claims all three — the one half types do not check', () => {
    // ⛔ `methods` is the wire registration; `handlers` is the dispatch. The
    // handler map is a Pick<> over ChatMethods, so a missing or misspelled KEY
    // is a tsc error — but `methods` is just an array, and dropping an entry
    // from it typechecks CLEANLY (verified by mutation: tsc silent, this test
    // red). The method then exists in the map and is never registered, so the
    // client's call fails method-not-found against a server that implements it.
    const slice = sliceOf(setup().deps);
    const claimed = new Set<string>(slice.methods);
    for (const method of Object.values(CLIENT_CALLS)) {
      expect(claimed.has(method)).toBe(true);
      // Both directions: a method the server registers but contracts does not
      // list is off-wire for a typed client, and vice versa.
      expect(CHAT_RPC_METHODS as readonly string[]).toContain(method);
    }
  });

  it('chat.execution.learned dispatches to the learned dep', async () => {
    const rig = setup();
    const handlers = callableHandlers(rig.deps);
    const result = await handlers[CLIENT_CALLS.learned]!(undefined);
    // The panel reads `.cases` — a handler wired to the wrong dep, or one that
    // returned the bare array, renders an empty list against a full corpus.
    expect(result).toEqual({
      cases: [entry('case_alpha'), entry('case_beta')],
    });
  });

  it('chat.execution.forget dispatches the case id through to the forget dep', async () => {
    const rig = setup();
    const handlers = callableHandlers(rig.deps);
    const result = await handlers[CLIENT_CALLS.forget]!({ case_id: 'case_alpha' });
    expect(rig.forgot).toEqual(['case_alpha']);
    expect(result).toEqual({ removed: true, cases_remaining: 1 });
  });

  it('chat.execution.draft_recipe dispatches case id AND prompt', async () => {
    const rig = setup();
    const handlers = callableHandlers(rig.deps);
    const result = await handlers[CLIENT_CALLS.draft]!({
      case_id: 'case_alpha',
      prompt: 'make it weekly',
    });
    // ⚠ The prompt is the owner's typed instruction. A dispatch that dropped it
    // would still return a valid-looking draft — just one that ignored what
    // they asked for, which is the failure that reads as "the AI is bad".
    expect(rig.drafted).toEqual([
      { case_id: 'case_alpha', prompt: 'make it weekly' },
    ]);
    expect(result).toMatchObject({ ok: true });
  });

  it('chat.execution.authored dispatches both ids, and demands both', async () => {
    // ⚠ The ids are all the caller gets to supply — the server resolves the
    // durable case_key and hashes the recipe itself — so both must arrive.
    const rig = setup();
    const handlers = callableHandlers(rig.deps);
    const result = await handlers[CLIENT_CALLS.authored]!({
      case_id: 'case_alpha', recipe_id: 'weekly-summary',
    });
    expect(rig.authored).toEqual([
      { case_id: 'case_alpha', recipe_id: 'weekly-summary' },
    ]);
    expect(result).toEqual({ recorded: true });
    await expect(handlers[CLIENT_CALLS.authored]!({ case_id: 'case_alpha' }))
      .rejects.toThrow(/recipe_id/u);
  });

  it('⛔ an unwired dep answers not_configured rather than throwing shapelessly', async () => {
    // The panel distinguishes an ERROR from an EMPTY list, and only a typed
    // rpc error gets it there. A server composed without the execution-case
    // deps must say so — silence would render as "nothing learned yet".
    const handlers = callableHandlers({} as ChatRpcDeps);
    for (const method of Object.values(CLIENT_CALLS)) {
      await expect(handlers[method]!({ case_id: 'c', recipe_id: 'r' }))
        .rejects.toThrow(/not wired/u);
    }
  });
});
