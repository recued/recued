/** D-259 § 7.4.3 — the chat/messenger half of the stop, driven through the REAL
 *  handler table.
 *
 *  ⛔ The registry-level arity rules are covered in
 *  `d-181-slice-4-live-control.test.ts`. What THIS file exists to prove is the
 *  join those cannot see: that `recipe.stop` is actually IN the Tier-1 table,
 *  that it reaches the registry, and that it scopes on the turn's own source.
 *  A tool that is defined, typed and unit-tested but absent from the table is
 *  the shape this codebase has been bitten by repeatedly.
 */
import { describe, expect, it, vi } from 'vitest';

import { InFlightRegistry } from '../execution/in-flight-registry.js';
import { LaneSemaphore } from '../execution/lane-semaphore.js';
import { buildChatTier1Handlers } from '../chat-tool-handlers.js';
import type { ChatToolHandlerDeps } from '../chat-tool-handlers.js';
import type { ChatDispatchContext, ExecutionSource } from '@recued/contracts';

const CHAT_SOURCE: ExecutionSource = {
  channel: 'chat',
  actor: 'user_self',
  chat_session_id: 'sess-1',
  user_id: 'owner',
};

const OTHER_CHAT_SOURCE: ExecutionSource = { ...CHAT_SOURCE, chat_session_id: 'sess-2' };

const deps = (registry?: InFlightRegistry): ChatToolHandlerDeps => ({
  getContactStore: () => undefined,
  getCollectionRegistry: () => undefined,
  getAuditLog: () => undefined,
  getEnrichmentStore: () => undefined,
  getRecipeStore: () =>
    ({ ids: () => [], get: () => null, getStored: () => null, listStored: () => [] }) as never,
  getExecutorConfig: () => ({ manifests: { get: () => null } }) as never,
  getExecuteRecipe: () => undefined,
  getInFlightRegistry: () => registry,
});

const ctx = (source: ExecutionSource = CHAT_SOURCE): ChatDispatchContext => ({
  channel: 'internal_function_call',
  session_id: 'sess-1',
  turn_id: 'turn-1',
  execution_source: source,
});

const withRun = (source: ExecutionSource, abort = vi.fn()) => {
  const reg = new InFlightRegistry(new LaneSemaphore());
  reg.registerRun({
    run_id: 'run-1',
    recipe_id: 'recued-core/long-thing',
    source,
    origin: 'attended',
    started_at: 11,
    abort,
  });
  return { reg, abort };
};

describe('D-259 § 7.4.3 — recipe.stop reaches the registry from a chat turn', () => {
  it('is present in the Tier-1 handler table at all', () => {
    expect(buildChatTier1Handlers(deps())['recipe.stop']).toBeDefined();
  });

  it('stops the caller\'s own live run, named by recipe', async () => {
    const { reg, abort } = withRun(CHAT_SOURCE);
    const out = await buildChatTier1Handlers(deps(reg))['recipe.stop']!(
      { recipe_id: 'recued-core/long-thing' }, ctx(),
    );
    expect(out.ok).toBe(true);
    expect(out.ok && out.result).toEqual({
      status: 'stopped', run_id: 'run-1', recipe_id: 'recued-core/long-thing', started_at: 11,
    });
    expect(abort).toHaveBeenCalledOnce();
  });

  it('⛔ collapses another session\'s run to not_found, never not_yours', async () => {
    // § 7.4.4 — a model that can tell "yours" from "exists" can probe for the
    // owner's run ids. The registry keeps both; the WIRE must not.
    const { reg, abort } = withRun(OTHER_CHAT_SOURCE);
    const out = await buildChatTier1Handlers(deps(reg))['recipe.stop']!(
      { run_id: 'run-1' }, ctx(),
    );
    expect(out.ok && out.result).toEqual({ status: 'not_found' });
    expect(abort).not.toHaveBeenCalled();
  });

  it('refuses an ambiguous match and kills nothing', async () => {
    const { reg, abort } = withRun(CHAT_SOURCE);
    const second = vi.fn();
    reg.registerRun({
      run_id: 'run-2',
      recipe_id: 'recued-core/long-thing',
      source: CHAT_SOURCE,
      origin: 'attended',
      started_at: 22,
      abort: second,
    });
    const out = await buildChatTier1Handlers(deps(reg))['recipe.stop']!(
      { recipe_id: 'recued-core/long-thing' }, ctx(),
    );
    expect(out.ok && (out.result as { status: string }).status).toBe('ambiguous');
    expect(abort).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();
  });

  it('rejects both-or-neither intent rather than guessing', async () => {
    const { reg } = withRun(CHAT_SOURCE);
    const handlers = buildChatTier1Handlers(deps(reg));
    for (const args of [{}, { recipe_id: 'a', run_id: 'b' }]) {
      const out = await handlers['recipe.stop']!(args, ctx());
      expect(out.ok).toBe(false);
    }
  });

  it('fails closed when no execution source is on the turn', async () => {
    const { reg, abort } = withRun(CHAT_SOURCE);
    const out = await buildChatTier1Handlers(deps(reg))['recipe.stop']!(
      { recipe_id: 'recued-core/long-thing' },
      { channel: 'internal_function_call', session_id: 'sess-1', turn_id: 'turn-1' },
    );
    expect(out.ok).toBe(false);
    expect(abort).not.toHaveBeenCalled();
  });
});
