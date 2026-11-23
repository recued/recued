/** D-404 slice B1 — `chat.next_steps.state`: which steps under chat answers have landed. The handler
 *  reads the question with the shared reader and answers only about steps it was asked. */
import { describe, expect, it, vi } from 'vitest';
import { RpcError } from '@recued/contracts';

import { handleNextStepsState, type ChatRpcDeps } from '../chat-handler.js';

const deps = (nextStepsLanded?: ChatRpcDeps['nextStepsLanded']): ChatRpcDeps =>
  ({ store: {} as never, ...(nextStepsLanded !== undefined ? { nextStepsLanded } : {}) }) as unknown as ChatRpcDeps;

describe('chat.next_steps.state', () => {
  it('answers the steps that landed, of those asked', () => {
    const landed = vi.fn(() => [{ kind: 'pack' as const, id: 'rental-book' }]);
    expect(handleNextStepsState(deps(landed), { steps: [{ kind: 'pack', id: 'rental-book' }, { kind: 'thing', id: 'boiler' }] }))
      .toEqual({ landed: [{ kind: 'pack', id: 'rental-book' }] });
    expect(landed).toHaveBeenCalledWith([{ kind: 'pack', id: 'rental-book' }, { kind: 'thing', id: 'boiler' }]);
  });

  it('⛔ never names a step it was not asked about, and asks nothing for a question with no step', () => {
    const landed = vi.fn(() => [{ kind: 'pack' as const, id: 'other' }, { kind: 'thing' as const, id: 'boiler' }]);
    expect(handleNextStepsState(deps(landed), { steps: [{ kind: 'thing', id: 'boiler' }] })).toEqual({ landed: [{ kind: 'thing', id: 'boiler' }] });
    const none = vi.fn(() => []);
    expect(handleNextStepsState(deps(none), { steps: [{ kind: 'switch', id: 'data.task' }] })).toEqual({ landed: [] });
    expect(none).not.toHaveBeenCalled();
  });

  it('refuses a question that is not a list of steps, and says when the server is not wired for it', () => {
    expect(() => handleNextStepsState(deps(() => []), { steps: 'pack:x' })).toThrow(RpcError);
    expect(() => handleNextStepsState(deps(() => []), null)).toThrow(RpcError);
    expect(() => handleNextStepsState(deps(), { steps: [] })).toThrow(/not wired/u);
  });
});
