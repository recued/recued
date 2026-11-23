/** 2026-11-21 (the owner: "can it be resumed manually by user (present to user on what already has and basically user
 *  can continue maybe?)") — Continue under the latest answer that stopped at its rounds. */

import { describe, expect, it, vi } from 'vitest';
import { CHAT_TOOL_BUDGET_EXHAUSTED_MESSAGE } from '@recued/contracts';

import { appendContinue, CONTINUE_ANSWER_ATTR, CONTINUE_MESSAGE, offersContinue } from '../continue-answer.js';
import { allOf, FakeEl, fakeDocument } from '../../kitchen/__tests__/kitchen-fake-dom.js';

const STOPPED = `So far this turn reached “Poetry | Books to Scrape” (https://books.toscrape.com/poetry/).\n\n${CHAT_TOOL_BUDGET_EXHAUSTED_MESSAGE}`;
const answer = (over: Partial<{ id: string; role: string; content: string; reached_round_limit: true }> = {}) =>
  ({ id: 'm2', role: 'assistant', content: STOPPED, ...over });

describe('which answers offer Continue', () => {
  it('the latest answer whose last line is the stop reason, with or without the pages before it', () => {
    expect(offersContinue(answer(), 'm2')).toBe(true);
    expect(offersContinue(answer({ content: `${CHAT_TOOL_BUDGET_EXHAUSTED_MESSAGE}\n` }), 'm2')).toBe(true);
  });

  it('not an older answer, one that finished, one that only quotes the reason, or the owner\'s own message', () => {
    expect(offersContinue(answer(), 'm3')).toBe(false);
    expect(offersContinue(answer(), undefined)).toBe(false);
    expect(offersContinue(answer({ content: 'The cheapest is “Libertarianism for Beginners”.' }), 'm2')).toBe(false);
    expect(offersContinue(answer({ content: `${CHAT_TOOL_BUDGET_EXHAUSTED_MESSAGE} I carried on and finished.` }), 'm2')).toBe(false);
    expect(offersContinue(answer({ role: 'user' }), 'm2')).toBe(false);
  });

  // 2026-11-21 (the owner: "recued sees the limit, stop the model, show a continue") — the server marks a turn that
  // ended at its round limit, so an answer its last call wrote offers Continue as the stop reason does.
  it('the latest answer the server marked as ending at its round limit, whatever it says', () => {
    const atLimit = answer({ content: 'I could not finish: the trail goes on at “Puffin” from page 12.', reached_round_limit: true });
    expect(offersContinue(atLimit, 'm2')).toBe(true);
    expect(offersContinue(answer({ content: '{"title":"Bench stock review verified"}', reached_round_limit: true }), 'm2')).toBe(true);
    expect(offersContinue(atLimit, 'm3')).toBe(false);
    expect(offersContinue({ ...atLimit, role: 'user' }, 'm2')).toBe(false);
  });
});

describe('the button', () => {
  const draw = (sending = false) => {
    // The kitchen fake has `append` only; the button attaches the way the route's actions do.
    const actions = Object.assign(new FakeEl('div'), { appendChild(this: FakeEl, child: FakeEl) { this.append(child); return child; } });
    const send = vi.fn();
    appendContinue(fakeDocument(), actions as unknown as HTMLElement, answer(), send, sending);
    const button = allOf(actions).find((el) => el.attrs.has(CONTINUE_ANSWER_ATTR))!;
    return { button, send };
  };

  it('sends "Continue." once, and then stays disabled', () => {
    const { button, send } = draw();
    expect(button.textContent).toBe('Continue');
    expect(button.attrs.get(CONTINUE_ANSWER_ATTR)).toBe('m2');
    button.click();
    button.click();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(CONTINUE_MESSAGE);
    expect(CONTINUE_MESSAGE).toBe('Continue.');
    expect(button.disabled).toBe(true);
  });

  it('is disabled while a message is being sent', () => {
    const { button, send } = draw(true);
    expect(button.disabled).toBe(true);
    button.click();
    expect(send).not.toHaveBeenCalled();
  });
});
