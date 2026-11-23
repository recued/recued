/** Settings → global chat behaviour projection.
 *
 *  ⛔ NO TOOL CATALOG HERE. The catalog mode is per-AI (the server resolves it
 *  from the source a turn runs on), so it is shown and set on each AI's card
 *  on Providers; `d-174-d14-ai-models-page.test.ts` pins that the Chat
 *  behaviour section renders none. */

import { describe, expect, it } from 'vitest';

import { buildChatBehaviourModel } from '../settings/chat-behaviour.js';

describe('global chat behaviour projection', () => {
  it('is loading until the brief snapshot arrives', () => {
    expect(buildChatBehaviourModel(null).kind).toBe('loading');
    expect(buildChatBehaviourModel(undefined).kind).toBe('loading');
    expect(buildChatBehaviourModel({ enabled: true }).kind).toBe('resolved');
  });

  it('reports the rolling brief straight from the snapshot', () => {
    expect(buildChatBehaviourModel({ enabled: true }))
      .toEqual({ kind: 'resolved', rolling_brief: true });
    expect(buildChatBehaviourModel({ enabled: false }))
      .toEqual({ kind: 'resolved', rolling_brief: false });
  });

  it('a non-boolean `enabled` is LOADING, never a silent false', () => {
    // The webclient projects server state; inventing `false` here would render
    // the brief as off on a server where it is on.
    expect(buildChatBehaviourModel({ enabled: 'yes' }).kind).toBe('loading');
    expect(buildChatBehaviourModel({}).kind).toBe('loading');
  });
});
