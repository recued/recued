/** D-402 slice A4 — "Make a recipe" under an answer whose request worked in a web page: offered only
 *  while the server can answer it, one at a time, and opening the draft in Kitchen. */

import { describe, expect, it, vi } from 'vitest';
import { CHAT_BROWSER_PLAN_HOLD_MS, type ChatMessage, type ChatToolCall } from '@recued/contracts';

import { createRequestRecipe, offersRequestRecipe, REQUEST_RECIPE_ATTR, requestRecipeOpenHash, type RequestRecipeAnswer } from '../request-recipe.js';
import { allOf, FakeEl, fakeDocument, settle } from '../../kitchen/__tests__/kitchen-fake-dom.js';

const NOW = 10 * CHAT_BROWSER_PLAN_HOLD_MS;
const call = (over: Partial<ChatToolCall> = {}): ChatToolCall => ({
  tool_name: 'recued-core/click-web-element', tier: 2, args: {}, status: 'ok', browser: true,
  started_at: NOW - 60_000, completed_at: NOW - 59_000, ...over,
});
const answer = (over: Partial<ChatMessage> = {}): ChatMessage => ({
  id: 'm1', session_id: 'chat-1', role: 'assistant', content: 'Done.', turn_id: 't-1', ts: NOW - 50_000,
  tool_calls: [call()], ...over,
} as ChatMessage);

describe('which answers offer it', () => {
  it('an answer of the owner\'s chat with a finished call that worked in a web page, within the hour', () => {
    expect(offersRequestRecipe(answer(), NOW)).toBe(true);
    expect(offersRequestRecipe(answer({ tool_calls: [call({ tool_name: 'mail.search', browser: undefined }), call()] }), NOW)).toBe(true);
  });

  it('not one without such a call, whose call failed, past the hour, a scheduled one, or not an answer', () => {
    expect(offersRequestRecipe(answer({ tool_calls: [call({ browser: undefined })] }), NOW)).toBe(false);
    expect(offersRequestRecipe(answer({ tool_calls: undefined }), NOW)).toBe(false);
    expect(offersRequestRecipe(answer({ tool_calls: [call({ status: 'error' })] }), NOW)).toBe(false);
    expect(offersRequestRecipe(answer({ tool_calls: [call({ completed_at: NOW - CHAT_BROWSER_PLAN_HOLD_MS })] }), NOW)).toBe(false);
    expect(offersRequestRecipe(answer({ execution_source: { channel: 'schedule' } as ChatMessage['execution_source'] }), NOW)).toBe(false);
    expect(offersRequestRecipe(answer({ turn_id: undefined }), NOW)).toBe(false);
    expect(offersRequestRecipe(answer({ role: 'user' }), NOW)).toBe(false);
  });
});

const rig = (make: (args: { session_id: string; turn_id: string }) => Promise<RequestRecipeAnswer>, opened = true) => {
  const callers = { make: vi.fn(make), open: vi.fn(() => opened) };
  const view = createRequestRecipe(fakeDocument(), callers, () => NOW);
  const draw = (message: ChatMessage, session = 'chat-1') => {
    const actions = new FakeEl('div');
    view.append(actions as unknown as HTMLElement, message, session);
    const button = allOf(actions).find((el) => el.attrs.has(REQUEST_RECIPE_ATTR));
    const status = allOf(actions).find((el) => el.attrs.get('role') === 'status');
    return { actions, button, status };
  };
  return { callers, view, draw };
};
const deferred = () => {
  let resolve!: (value: RequestRecipeAnswer) => void;
  const promise = new Promise<RequestRecipeAnswer>((done) => { resolve = done; });
  return { promise, resolve };
};

describe('the button', () => {
  it('makes the recipe for the answer\'s request and opens it in Kitchen', async () => {
    const r = rig(async () => ({ ok: true, draft_id: 'd-1', kitchen_path: '/webclient/#kitchen/import/d-1', issues: [] }));
    const { button, status } = r.draw(answer());
    expect(button?.textContent).toBe('Make a recipe');
    button!.click();
    expect(r.callers.make).toHaveBeenCalledWith({ session_id: 'chat-1', turn_id: 't-1' });
    await settle();
    expect(r.callers.open).toHaveBeenCalledWith('d-1', undefined);
    expect(status!.textContent).toBe('Opened in Kitchen.');
  });

  it('D-402 slice E4c — opens changes to a saved recipe on that recipe', async () => {
    const r = rig(async () => ({ ok: true, draft_id: 'd-2', kitchen_path: '/webclient/#kitchen/recipe/buy-lamp', recipe_id: 'buy-lamp', issues: [] }));
    r.draw(answer()).button!.click();
    await settle();
    expect(r.callers.open).toHaveBeenCalledWith('d-2', 'buy-lamp');
    // Where the bootstrap goes: the recipe itself, which continues the changes kept for it.
    expect(requestRecipeOpenHash('d-2', 'buy-lamp')).toBe('#kitchen/recipe/buy-lamp');
    expect(requestRecipeOpenHash('d-1')).toBe('#kitchen/import/d-1');
  });

  it('says where the draft waits when the owner has left the chat, and why when none was made', async () => {
    const away = rig(async () => ({ ok: true, draft_id: 'd-1', kitchen_path: '', issues: [] }), false);
    const a = away.draw(answer()); a.button!.click(); await settle();
    expect(a.status!.textContent).toContain('In progress');
    const none = rig(async () => ({ ok: false, reason: 'nothing_kept', issues: ['Recued no longer holds what this request did.'] }));
    const b = none.draw(answer()); b.button!.click(); await settle();
    expect(b.status!.textContent).toBe('Recued no longer holds what this request did.');
    expect(none.callers.open).not.toHaveBeenCalled();
    const broken = rig(async () => { throw new Error('offline'); });
    const c = broken.draw(answer()); c.button!.click(); await settle();
    expect(c.status!.textContent).toContain('Try again');
  });

  it('is not drawn for an answer that does not offer it', () => {
    const r = rig(async () => ({ ok: false, reason: 'nothing_kept', issues: [] }));
    expect(r.draw(answer({ tool_calls: [call({ browser: undefined })] })).button).toBeUndefined();
  });

  it('makes one at a time, and an answer drawn again while its recipe is made shows it, then the outcome', async () => {
    const first = deferred();
    const r = rig(() => first.promise);
    const one = r.draw(answer());
    const two = r.draw(answer({ id: 'm2', turn_id: 't-2' }));
    one.button!.click();
    expect(one.status!.textContent).toBe('Making a recipe…');
    expect(one.button!.attrs.get('aria-disabled')).toBe('true');
    one.button!.click();
    two.button!.click();
    expect(r.callers.make).toHaveBeenCalledTimes(1);
    expect(two.status!.textContent).toContain('another recipe');
    const again = r.draw(answer());
    expect(again.status!.textContent).toBe('Making a recipe…');
    first.resolve({ ok: true, draft_id: 'd-1', kitchen_path: '', issues: [] });
    await settle();
    expect(again.status!.textContent).toBe('Opened in Kitchen.');
    expect(again.button!.attrs.has('aria-disabled')).toBe(false);
  });
});
