import { describe, expect, it, vi } from 'vitest';

import type { SessionEntry } from '@recued/chat';
import type { TurnContext } from '@recued/middleware';

import { detectAnaphora } from '../intention/anaphora';
import { findReferentCandidate } from '../intention/session-attach';
import {
  attach,
  INTENTION_RESULT_STATE_KEY,
  type IntentionResult,
} from '../intention/index';
import { promptCacheMiddleware } from '../index';

const makeSessionEntry = (
  role: SessionEntry['role'],
  text: string,
  ts = 0,
): SessionEntry => ({
  session_id: 's',
  surface: 'chat',
  role,
  text,
  ts,
});

const makeTurnContext = (history: readonly SessionEntry[]) => {
  const contribute = vi.fn();
  const resolve = vi.fn();
  const state = new Map<string, unknown>();
  const stateSet = vi.spyOn(state, 'set');
  const ctx = {
    history,
    prompt: {
      contribute,
      parts: () => [],
    },
    resolve,
    state,
  } as unknown as TurnContext;

  return { contribute, ctx, resolve, state, stateSet };
};

describe('D-164 P4c detectAnaphora positive closed-list cases', () => {
  it('detects pronouns with the correct trigger and position', () => {
    expect(detectAnaphora('what about her?')).toEqual({
      kind: 'pronoun',
      trigger: 'her',
      position: 11,
    });
  });

  it('detects demonstrative + one with the correct trigger and position', () => {
    expect(detectAnaphora('I want this one')).toEqual({
      kind: 'demonstrative',
      trigger: 'this one',
      position: 7,
    });
  });

  it('detects bare plural demonstratives with the correct trigger and position', () => {
    expect(detectAnaphora('compare those')).toEqual({
      kind: 'demonstrative',
      trigger: 'those',
      position: 8,
    });
  });

  it('detects ordinals without including a trailing one in the trigger', () => {
    expect(detectAnaphora('show the second one')).toEqual({
      kind: 'ordinal',
      trigger: 'the second',
      position: 5,
    });
  });

  it.each([
    ['show the last one', 'the last', 5],
    ['show the previous one', 'the previous', 5],
    ['use the latter', 'the latter', 4],
    ['use the former', 'the former', 4],
  ])('detects %s from the ordinal closed list', (text, trigger, position) => {
    expect(detectAnaphora(text)).toEqual({
      kind: 'ordinal',
      trigger,
      position,
    });
  });
});

describe('D-164 P4c detectAnaphora negative cases', () => {
  it('returns null for plain non-anaphoric text', () => {
    expect(detectAnaphora("find Bob's email")).toBeNull();
  });

  it('does not fire on bare this or that without one', () => {
    expect(detectAnaphora('this is good')).toBeNull();
  });

  it('does not fire on bare ordinals without the', () => {
    expect(detectAnaphora('first question')).toBeNull();
  });

  it('does not match pronoun substrings inside other words', () => {
    expect(detectAnaphora('submit the email')).toBeNull();
  });
});

describe('D-164 P4c detectAnaphora earliest-position-wins selection', () => {
  it('prefers an early ordinal over later pronouns', () => {
    expect(detectAnaphora('the first one looks good - they said it')).toEqual({
      kind: 'ordinal',
      trigger: 'the first',
      position: 0,
    });
  });

  it('prefers an early pronoun over a later ordinal', () => {
    expect(detectAnaphora('they said the first one')).toEqual({
      kind: 'pronoun',
      trigger: 'they',
      position: 0,
    });
  });

  it('returns null for an empty string', () => {
    expect(detectAnaphora('')).toBeNull();
  });
});

describe('D-164 P4c findReferentCandidate', () => {
  it('returns null for empty history', () => {
    expect(findReferentCandidate([])).toBeNull();
  });

  it('returns null for user-only history', () => {
    expect(findReferentCandidate([
      makeSessionEntry('user', 'find Alice', 1),
      makeSessionEntry('user', 'compare those', 2),
    ])).toBeNull();
  });

  it('returns the assistant entry between user turns', () => {
    const assistant = makeSessionEntry('assistant', 'Alice and Bob match', 2);

    expect(findReferentCandidate([
      makeSessionEntry('user', 'find Alice', 1),
      assistant,
      makeSessionEntry('user', 'compare those', 3),
    ])).toEqual({ entry: assistant });
  });

  it('returns the latest assistant when multiple assistant turns precede the user', () => {
    const firstAssistant = makeSessionEntry('assistant', 'First answer', 1);
    const latestAssistant = makeSessionEntry('assistant', 'Second answer', 2);

    expect(findReferentCandidate([
      firstAssistant,
      latestAssistant,
      makeSessionEntry('user', 'what about them?', 3),
    ])).toEqual({ entry: latestAssistant });
  });

  it('returns the raw SessionEntry with all fields intact', () => {
    const assistant = makeSessionEntry('assistant', 'Full entry', 42);
    const result = findReferentCandidate([
      makeSessionEntry('user', 'start', 1),
      assistant,
    ]);

    expect(result?.entry).toBe(assistant);
    expect(result?.entry).toEqual({
      session_id: 's',
      surface: 'chat',
      role: 'assistant',
      text: 'Full entry',
      ts: 42,
    });
  });
});

describe('D-164 P4c attach', () => {
  it('writes nothing for non-anaphoric latest user text', () => {
    const { ctx, state, stateSet } = makeTurnContext([
      makeSessionEntry('assistant', 'Alice is available', 1),
      makeSessionEntry('user', 'find Bob email', 2),
    ]);

    attach(ctx);

    expect(stateSet).not.toHaveBeenCalled();
    expect(state.size).toBe(0);
  });

  it('writes an IntentionResult for anaphoric user text with a prior assistant referent', () => {
    const assistant = makeSessionEntry('assistant', 'Alice and Bob match', 1);
    const { ctx, state, stateSet } = makeTurnContext([
      makeSessionEntry('user', 'find matching contacts', 0),
      assistant,
      makeSessionEntry('user', 'compare those', 2),
    ]);

    attach(ctx);

    expect(stateSet).toHaveBeenCalledTimes(1);
    expect(state.get(INTENTION_RESULT_STATE_KEY)).toEqual({
      signal: {
        kind: 'demonstrative',
        trigger: 'those',
        position: 8,
      },
      referent: { entry: assistant },
    });
  });

  it('writes an IntentionResult with a null referent for anaphoric user-only history', () => {
    const { ctx, state } = makeTurnContext([
      makeSessionEntry('user', 'they', 1),
    ]);

    attach(ctx);

    expect(state.get(INTENTION_RESULT_STATE_KEY)).toEqual({
      signal: {
        kind: 'pronoun',
        trigger: 'they',
        position: 0,
      },
      referent: null,
    });
  });

  it('is idempotent over the same context', () => {
    const assistant = makeSessionEntry('assistant', 'Alice and Bob match', 1);
    const { ctx, stateSet } = makeTurnContext([
      assistant,
      makeSessionEntry('user', 'compare those', 2),
    ]);

    attach(ctx);
    attach(ctx);

    expect(stateSet).toHaveBeenCalledTimes(2);
    const [firstKey, firstResult] = stateSet.mock.calls[0] as [
      string,
      IntentionResult,
    ];
    const [secondKey, secondResult] = stateSet.mock.calls[1] as [
      string,
      IntentionResult,
    ];
    expect(firstKey).toBe(INTENTION_RESULT_STATE_KEY);
    expect(secondKey).toBe(INTENTION_RESULT_STATE_KEY);
    expect(secondResult).toEqual(firstResult);
  });

  it('never calls resolve or prompt.contribute with or without anaphora', () => {
    const nonAnaphoric = makeTurnContext([
      makeSessionEntry('user', 'find Bob email', 1),
    ]);
    const anaphoric = makeTurnContext([
      makeSessionEntry('assistant', 'Alice and Bob match', 1),
      makeSessionEntry('user', 'compare those', 2),
    ]);

    attach(nonAnaphoric.ctx);
    attach(anaphoric.ctx);

    expect(nonAnaphoric.resolve).not.toHaveBeenCalled();
    expect(nonAnaphoric.contribute).not.toHaveBeenCalled();
    expect(anaphoric.resolve).not.toHaveBeenCalled();
    expect(anaphoric.contribute).not.toHaveBeenCalled();
  });

  it('exports the literal intention result state key', () => {
    expect(INTENTION_RESULT_STATE_KEY).toBe('prompt-cache:intention');
  });
});

describe('D-164 P4c promptCacheMiddleware.prompt integration', () => {
  it('keeps the prompt hook a no-op on non-anaphoric input', async () => {
    const { contribute, ctx, resolve, state, stateSet } = makeTurnContext([
      makeSessionEntry('user', 'find Bob email', 1),
    ]);
    const prompt = promptCacheMiddleware.prompt;

    if (prompt === undefined) {
      throw new Error('promptCacheMiddleware.prompt must be registered');
    }

    await prompt(ctx);

    expect(contribute).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
    expect(stateSet).not.toHaveBeenCalled();
    expect(state.size).toBe(0);
  });

  it('attaches intention state through the prompt hook for anaphoric input', async () => {
    const assistant = makeSessionEntry('assistant', 'Alice and Bob match', 1);
    const { contribute, ctx, resolve, state, stateSet } = makeTurnContext([
      assistant,
      makeSessionEntry('user', 'they', 2),
    ]);
    const prompt = promptCacheMiddleware.prompt;

    if (prompt === undefined) {
      throw new Error('promptCacheMiddleware.prompt must be registered');
    }

    await prompt(ctx);

    expect(contribute).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
    expect(stateSet).toHaveBeenCalledTimes(1);
    expect(state.get(INTENTION_RESULT_STATE_KEY)).toEqual({
      signal: {
        kind: 'pronoun',
        trigger: 'they',
        position: 0,
      },
      referent: { entry: assistant },
    });
  });
});
