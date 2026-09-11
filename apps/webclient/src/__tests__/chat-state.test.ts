/** D-137 P1.4 — webclient chat-state reducer.
 *
 *  Acceptance:
 *    - hydrateThreadFromSnapshot seeds session + messages
 *    - beginInFlightTurn creates an empty in-flight turn keyed on turn_id
 *    - chat.token_streamed appends to assistant_content
 *    - chat.tool_call_started pushes a tool_call (status: started)
 *    - chat.tool_call_completed patches matching tool_call to ok/error
 *    - chat.message_complete clears in-flight + appends authoritative
 *    - chat.session_changed patches picker / model_pref / title / archived
 *    - dropped: wrong session_id, completed stale turn_id, off-list event kind
 */

import { describe, it, expect } from 'vitest';
import type {
  ChatMessage,
  ChatSession,
  ServerEvent,
} from '@recued/contracts';
import {
  beginInFlightTurn,
  hydrateThreadFromSnapshot,
  initialChatThreadState,
  isChatThreadEvent,
  reduceChatThreadEvent,
} from '../chat/state.js';

const mkSession = (id: string): ChatSession => ({
  id,
  created_at: 1000,
  last_active_at: 1000,
  picker_state: { current: 'self' },
  model_routing: { current: 'byok' },
  archived: false,
});

const mkUserMessage = (id: string, session_id: string): ChatMessage => ({
  id,
  session_id,
  role: 'user',
  contributor: 'user',
  content: 'hi',
  target_server: 'self',
  picker_at_send: {
    display_name: 'Self',
    signature: { server_kind: 'recued', version: '1.0', instance_id: 'inst' },
  },
  model_used: { provider: 'local', model_id: 'm' },
  ts: 1000,
});

const mkAssistantMessage = (id: string, session_id: string): ChatMessage => ({
  ...mkUserMessage(id, session_id),
  role: 'assistant',
  contributor: 'model',
  content: 'final',
});

describe('durable tool-call updates', () => {
  it('updates the exact visible call and refuses stale or cross-session revival', () => {
    const call = { message_id: 'call', session_id: 's', turn_id: 't', tool_name: 'recipe.run',
      state: 'running' as const, started_at: 1, updated_at: 1 };
    let state = hydrateThreadFromSnapshot(initialChatThreadState(), {
      ...mkSession('s'), messages: [{ ...mkUserMessage('call', 's'), role: 'tool', tool_call: call }],
    });
    const event = (value: unknown, session_id = 's'): ServerEvent => ({
      kind: 'chat.session_changed', session_id, field: 'tool_call', value, cursor: 1,
    });
    expect(reduceChatThreadEvent(state, event({ ...call, message_id: 'not-loaded' }))).toBe(state);
    state = reduceChatThreadEvent(state, event({ ...call, last_signal_at: 2, updated_at: 2 }));
    expect(state.messages[0]?.tool_call?.last_signal_at).toBe(2);
    expect(reduceChatThreadEvent(state, event({ ...call, updated_at: 3 }, 'other'))).toBe(state);
    state = reduceChatThreadEvent(state, event({ ...call, state: 'interrupted', updated_at: 3 }));
    state = reduceChatThreadEvent(state, event({ ...call, updated_at: 4 }));
    expect(state.messages[0]?.tool_call?.state).toBe('interrupted');
    state = reduceChatThreadEvent(state, event({ ...call, state: 'succeeded', updated_at: 5 }));
    expect(state.messages[0]?.tool_call?.state).toBe('succeeded');
    state = reduceChatThreadEvent(state, event({ ...call, updated_at: 6 }));
    expect(state.messages[0]?.tool_call?.state).toBe('succeeded');
  });
});

describe('isChatThreadEvent', () => {
  it('returns true for the chat-thread kinds', () => {
    const kinds: ServerEvent['kind'][] = [
      'chat.token_streamed',
      'chat.tool_call_started',
      'chat.tool_call_completed',
      'chat.plan_proposed',
      'chat.plan_resolved',
      'chat.transparency',
      'chat.message_complete',
      'chat.session_changed',
    ];
    for (const k of kinds) {
      expect(isChatThreadEvent({ kind: k } as ServerEvent)).toBe(true);
    }
  });

  it('returns false for non-chat kinds', () => {
    expect(isChatThreadEvent({ kind: 'memory' } as unknown as ServerEvent)).toBe(false);
    expect(isChatThreadEvent({ kind: 'approval' } as unknown as ServerEvent)).toBe(false);
  });
});

describe('reduceChatThreadEvent', () => {
  it('hydrates session + messages from snapshot', () => {
    const s = initialChatThreadState();
    const next = hydrateThreadFromSnapshot(s, {
      ...mkSession('sess-1'),
      messages: [mkUserMessage('u1', 'sess-1')],
    });
    expect(next.session?.id).toBe('sess-1');
    expect(next.messages).toHaveLength(1);
  });

  it('begins an in-flight turn', () => {
    let s = initialChatThreadState();
    s = hydrateThreadFromSnapshot(s, { ...mkSession('sess-1'), messages: [] });
    s = beginInFlightTurn(s, 'turn-1');
    expect(s.inflight?.turn_id).toBe('turn-1');
    expect(s.inflight?.assistant_content).toBe('');
  });

  it('appends delta on token_streamed', () => {
    let s = initialChatThreadState();
    s = hydrateThreadFromSnapshot(s, { ...mkSession('sess-1'), messages: [] });
    s = beginInFlightTurn(s, 'turn-1');
    s = reduceChatThreadEvent(s, {
      kind: 'chat.token_streamed',
      session_id: 'sess-1',
      turn_id: 'turn-1',
      delta: 'hello',
      cursor: 1,
    } as unknown as ServerEvent);
    s = reduceChatThreadEvent(s, {
      kind: 'chat.token_streamed',
      session_id: 'sess-1',
      turn_id: 'turn-1',
      delta: ' world',
      cursor: 2,
    } as unknown as ServerEvent);
    expect(s.inflight?.assistant_content).toBe('hello world');
  });

  it('pushes a tool_call on tool_call_started + patches on tool_call_completed', () => {
    let s = initialChatThreadState();
    s = hydrateThreadFromSnapshot(s, { ...mkSession('sess-1'), messages: [] });
    s = beginInFlightTurn(s, 'turn-1');
    s = reduceChatThreadEvent(s, {
      kind: 'chat.tool_call_started',
      session_id: 'sess-1',
      turn_id: 'turn-1',
      tool_name: 'mail.search',
      tier: 1,
      args: { q: 'p' },
      cursor: 1,
    } as unknown as ServerEvent);
    expect(s.inflight?.tool_calls).toHaveLength(1);
    expect(s.inflight?.tool_calls[0]?.status).toBe('started');
    // Codex P1.4 review P2 fold — reducer is pure (no Date.now()).
    // In-flight tool_calls don't carry timestamps; the authoritative
    // ChatMessage on message_complete does.
    expect(
      (s.inflight?.tool_calls[0] as unknown as { started_at?: unknown })?.started_at,
    ).toBeUndefined();

    s = reduceChatThreadEvent(s, {
      kind: 'chat.tool_call_completed',
      session_id: 'sess-1',
      turn_id: 'turn-1',
      tool_name: 'mail.search',
      tier: 1,
      status: 'ok',
      result_ref: 'sess-1:turn-1:mail.search',
      cursor: 2,
    } as unknown as ServerEvent);
    expect(s.inflight?.tool_calls[0]?.status).toBe('ok');
    expect(s.inflight?.tool_calls[0]?.result_ref).toBe('sess-1:turn-1:mail.search');
    expect(
      (s.inflight?.tool_calls[0] as unknown as { completed_at?: unknown })?.completed_at,
    ).toBeUndefined();
  });

  it('keeps the error detail on a tool_call_completed error (D-182)', () => {
    let s = initialChatThreadState();
    s = hydrateThreadFromSnapshot(s, { ...mkSession('sess-1'), messages: [] });
    s = beginInFlightTurn(s, 'turn-1');
    s = reduceChatThreadEvent(s, {
      kind: 'chat.tool_call_started',
      session_id: 'sess-1',
      turn_id: 'turn-1',
      tool_name: 'recipe.run',
      tier: 2,
      args: {},
      cursor: 1,
    } as unknown as ServerEvent);
    s = reduceChatThreadEvent(s, {
      kind: 'chat.tool_call_completed',
      session_id: 'sess-1',
      turn_id: 'turn-1',
      tool_name: 'recipe.run',
      tier: 2,
      status: 'error',
      reason: 'execution_error',
      detail: "cli tool 'whisper' was not found",
      cursor: 2,
    } as unknown as ServerEvent);
    expect(s.inflight?.tool_calls[0]?.status).toBe('error');
    expect(s.inflight?.tool_calls[0]?.reason).toBe('execution_error');
    expect(
      (s.inflight?.tool_calls[0] as unknown as { detail?: string })?.detail,
    ).toBe("cli tool 'whisper' was not found");
  });

  it('captures transparency events in the in-flight drawer', () => {
    let s = initialChatThreadState();
    s = hydrateThreadFromSnapshot(s, { ...mkSession('sess-1'), messages: [] });
    s = beginInFlightTurn(s, 'turn-1');
    s = reduceChatThreadEvent(s, {
      kind: 'chat.transparency',
      session_id: 'sess-1',
      turn_id: 'turn-1',
      event: { kind: 'engine.catalog_assembled', section_counts: { recipes: 12 } },
      cursor: 1,
    } as unknown as ServerEvent);
    expect(s.inflight?.transparency).toHaveLength(1);
    expect(s.inflight?.transparency[0]?.kind).toBe('transparency');
  });

  it('completes in-flight + appends authoritative message on message_complete', () => {
    let s = initialChatThreadState();
    s = hydrateThreadFromSnapshot(s, { ...mkSession('sess-1'), messages: [] });
    s = beginInFlightTurn(s, 'turn-1');
    s = reduceChatThreadEvent(s, {
      kind: 'chat.message_complete',
      session_id: 'sess-1',
      turn_id: 'turn-1',
      final: mkAssistantMessage('a1', 'sess-1'),
      cursor: 1,
    } as unknown as ServerEvent);
    expect(s.inflight).toBeNull();
    expect(s.messages).toHaveLength(1);
    expect(s.messages[0]?.role).toBe('assistant');
  });

  it('does not duplicate message_complete on broadcast replay', () => {
    let s = initialChatThreadState();
    s = hydrateThreadFromSnapshot(s, { ...mkSession('sess-1'), messages: [] });
    s = beginInFlightTurn(s, 'turn-1');
    const evt = {
      kind: 'chat.message_complete',
      session_id: 'sess-1',
      turn_id: 'turn-1',
      final: mkAssistantMessage('a1', 'sess-1'),
      cursor: 1,
    } as unknown as ServerEvent;
    s = reduceChatThreadEvent(s, evt);
    s = reduceChatThreadEvent(s, evt);  // Replay.
    expect(s.messages).toHaveLength(1);
  });

  it('patches picker on session_changed', () => {
    let s = initialChatThreadState();
    s = hydrateThreadFromSnapshot(s, { ...mkSession('sess-1'), messages: [] });
    s = reduceChatThreadEvent(s, {
      kind: 'chat.session_changed',
      session_id: 'sess-1',
      field: 'picker',
      value: { current: 'connection.mcp.bob' },
      cursor: 1,
    } as unknown as ServerEvent);
    expect(s.session?.picker_state.current).toBe('connection.mcp.bob');
  });

  it('patches model_pref on session_changed', () => {
    let s = initialChatThreadState();
    s = hydrateThreadFromSnapshot(s, { ...mkSession('sess-1'), messages: [] });
    s = reduceChatThreadEvent(s, {
      kind: 'chat.session_changed',
      session_id: 'sess-1',
      field: 'model_pref',
      value: { current: 'byok' },
      cursor: 1,
    } as unknown as ServerEvent);
    expect(s.session?.model_routing.current).toBe('byok');
  });

  it('D-167: model_pref REPLACES routing — a clear drops stale provider/model_id + sets overridden=false', () => {
    let s = initialChatThreadState();
    // Seed an overridden session carrying a provider + model_id.
    s = hydrateThreadFromSnapshot(s, {
      ...mkSession('sess-1'),
      model_routing: { current: 'byok', provider: 'anthropic', model_id: 'claude', overridden: true },
      messages: [],
    });
    // Clear broadcast carries only the effective layer + overridden:false.
    s = reduceChatThreadEvent(s, {
      kind: 'chat.session_changed',
      session_id: 'sess-1',
      field: 'model_pref',
      value: { current: 'free_pool', overridden: false },
      cursor: 1,
    } as unknown as ServerEvent);
    expect(s.session?.model_routing).toEqual({ current: 'free_pool', overridden: false });
    expect(s.session?.model_routing.provider).toBeUndefined();
    expect(s.session?.model_routing.model_id).toBeUndefined();
  });

  it('D-167: model_pref override broadcast carries overridden=true', () => {
    let s = initialChatThreadState();
    s = hydrateThreadFromSnapshot(s, { ...mkSession('sess-1'), messages: [] });
    s = reduceChatThreadEvent(s, {
      kind: 'chat.session_changed',
      session_id: 'sess-1',
      field: 'model_pref',
      value: { current: 'byok', overridden: true },
      cursor: 1,
    } as unknown as ServerEvent);
    expect(s.session?.model_routing).toEqual({ current: 'byok', overridden: true });
  });

  it('preserves the exact slot from a model_pref broadcast', () => {
    let s = initialChatThreadState();
    s = hydrateThreadFromSnapshot(s, { ...mkSession('sess-1'), messages: [] });
    s = reduceChatThreadEvent(s, {
      kind: 'chat.session_changed',
      session_id: 'sess-1',
      field: 'model_pref',
      value: {
        current: 'byok',
        model_hint: 'fast',
        source_id: 'slot_2',
        overridden: true,
      },
      cursor: 1,
    } as unknown as ServerEvent);
    expect(s.session?.model_routing).toEqual({
      current: 'byok',
      model_hint: 'fast',
      source_id: 'slot_2',
      overridden: true,
    });
  });

  it('D-167: chat.default_model_pref_changed re-renders an INHERITED open chat', () => {
    let s = initialChatThreadState();
    s = hydrateThreadFromSnapshot(s, {
      ...mkSession('sess-1'),
      model_routing: { current: 'byok', overridden: false },
      messages: [],
    });
    s = reduceChatThreadEvent(s, {
      kind: 'chat.default_model_pref_changed',
      layer: 'free_pool',
      source_id: 'free_pool',
      updated_at: 5,
      cursor: 1,
    } as unknown as ServerEvent);
    expect(s.session?.model_routing).toEqual({
      current: 'free_pool',
      source_id: 'free_pool',
      overridden: false,
    });
  });

  it('D-167: chat.default_model_pref_changed leaves an OVERRIDDEN chat untouched', () => {
    let s = initialChatThreadState();
    s = hydrateThreadFromSnapshot(s, {
      ...mkSession('sess-1'),
      model_routing: { current: 'byok', overridden: true },
      messages: [],
    });
    const before = s.session;
    s = reduceChatThreadEvent(s, {
      kind: 'chat.default_model_pref_changed',
      layer: 'free_pool',
      updated_at: 5,
      cursor: 1,
    } as unknown as ServerEvent);
    expect(s.session?.model_routing).toEqual({ current: 'byok', overridden: true });
    expect(s.session).toBe(before); // unchanged reference — no needless churn
  });

  it('D-167: isChatThreadEvent recognises chat.default_model_pref_changed', () => {
    expect(
      isChatThreadEvent({
        kind: 'chat.default_model_pref_changed',
        layer: 'byok',
        updated_at: 1,
        cursor: 1,
      } as unknown as ServerEvent),
    ).toBe(true);
  });

  it('drops events for other sessions', () => {
    let s = initialChatThreadState();
    s = hydrateThreadFromSnapshot(s, { ...mkSession('sess-1'), messages: [] });
    s = beginInFlightTurn(s, 'turn-1');
    const before = s;
    s = reduceChatThreadEvent(s, {
      kind: 'chat.token_streamed',
      session_id: 'sess-OTHER',
      turn_id: 'turn-1',
      delta: 'x',
      cursor: 1,
    } as unknown as ServerEvent);
    expect(s).toBe(before);
  });

  it('drops events for a completed stale turn_id while admitting unknown concurrent turns', () => {
    let s = initialChatThreadState();
    s = hydrateThreadFromSnapshot(s, {
      ...mkSession('sess-1'),
      messages: [{ ...mkAssistantMessage('old', 'sess-1'), turn_id: 'turn-OLD' }],
    });
    s = beginInFlightTurn(s, 'turn-1');
    const before = s;
    s = reduceChatThreadEvent(s, {
      kind: 'chat.token_streamed',
      session_id: 'sess-1',
      turn_id: 'turn-OLD',
      delta: 'x',
      cursor: 1,
    } as unknown as ServerEvent);
    expect(s).toBe(before);
  });
});


describe('PB7 webclient failure paint reducer', () => {
  const hydrated = () =>
    hydrateThreadFromSnapshot(initialChatThreadState(), {
      ...mkSession('sess-1'),
      messages: [],
    });

  const decoderFailure = (
    overrides: Partial<{
      reason: 'no_source' | 'provider_failure' | 'invalid_output';
      site: 'initial' | 'tool_loop';
    }> = {},
  ) => ({
    kind: 'chat.transparency',
    session_id: 'sess-1',
    turn_id: 'turn-1',
    event: {
      kind: 'engine.decoder_unavailable',
      reason: overrides.reason ?? 'provider_failure',
      site: overrides.site ?? 'initial',
    },
    cursor: 1,
  } as unknown as ServerEvent);

  it('projects failure-class transparency without requiring an in-flight turn', () => {
    const s = reduceChatThreadEvent(hydrated(), decoderFailure());

    // Route-side scaffold handling re-pin: the turn's first broadcast
    // event now ADOPTS a scaffold (previously the event was dropped and
    // inflight stayed null); the failure projection is unchanged.
    expect(s.inflight).toMatchObject({ turn_id: 'turn-1' });
    expect(s.inflight?.transparency).toHaveLength(1);
    expect(s.turn_failures).toEqual([
      {
        turn_id: 'turn-1',
        kind: 'engine.decoder_unavailable',
        text: 'the AI provider failed before answering',
        settings_link: false,
      },
    ]);
  });

  it('also appends the drawer entry when the matching in-flight turn exists', () => {
    let s = beginInFlightTurn(hydrated(), 'turn-1');
    const evt = decoderFailure();

    s = reduceChatThreadEvent(s, evt);

    expect(s.turn_failures).toEqual([
      {
        turn_id: 'turn-1',
        kind: 'engine.decoder_unavailable',
        text: 'the AI provider failed before answering',
        settings_link: false,
      },
    ]);
    expect(s.inflight?.transparency).toEqual([
      { kind: 'transparency', payload: (evt as { event: unknown }).event },
    ]);
  });

  it('keeps only the latest failure notice per turn', () => {
    let s = hydrated();

    s = reduceChatThreadEvent(s, {
      kind: 'chat.transparency',
      session_id: 'sess-1',
      turn_id: 'turn-1',
      event: { kind: 'engine.budget_exceeded', total_calls: 1, total_cost_cents: 0 },
      cursor: 1,
    } as unknown as ServerEvent);
    s = reduceChatThreadEvent(s, decoderFailure());

    expect(s.turn_failures).toHaveLength(1);
    expect(s.turn_failures[0]).toEqual({
      turn_id: 'turn-1',
      kind: 'engine.decoder_unavailable',
      text: 'the AI provider failed before answering',
      settings_link: false,
    });
  });

  it('marks no_source decoder failures with the Settings affordance', () => {
    const s = reduceChatThreadEvent(
      hydrated(),
      decoderFailure({ reason: 'no_source' }),
    );

    expect(s.turn_failures).toEqual([
      {
        turn_id: 'turn-1',
        kind: 'engine.decoder_unavailable',
        text: 'no AI model source available for this turn — check Settings → AI / Models',
        settings_link: true,
      },
    ]);
  });

  it('does not project non-failure, non-transparency, or unknown transparency payloads', () => {
    let s = hydrated();

    for (const event of [
      { kind: 'recued.multi_turn.round_started' },
      { kind: 'chat.token_streamed' },
      { kind: 'transparency.unknown' },
      'not-an-event',
      null,
    ]) {
      s = reduceChatThreadEvent(s, {
        kind: 'chat.transparency',
        session_id: 'sess-1',
        turn_id: 'turn-1',
        event,
        cursor: 1,
      } as unknown as ServerEvent);
    }

    expect(s.turn_failures).toEqual([]);
    // Route-side scaffold handling re-pin: turn-scoped transparency
    // events adopt a scaffold for the uncompleted turn (drawer entries
    // accumulate) — only the FAILURE projection stays empty.
    expect(s.inflight).toMatchObject({ turn_id: 'turn-1' });
    expect(s.inflight?.transparency).toHaveLength(5);
  });

  it('drops failure transparency for the wrong session_id before painting', () => {
    const s = hydrated();
    const next = reduceChatThreadEvent(s, {
      ...decoderFailure(),
      session_id: 'sess-other',
    } as unknown as ServerEvent);

    expect(next).toBe(s);
    expect(next.turn_failures).toEqual([]);
  });

  it('stamps message_id on the matching notice and leaves replay stable', () => {
    let s = reduceChatThreadEvent(hydrated(), decoderFailure());
    const complete = {
      kind: 'chat.message_complete',
      session_id: 'sess-1',
      turn_id: 'turn-1',
      final: mkAssistantMessage('a1', 'sess-1'),
      cursor: 2,
    } as unknown as ServerEvent;

    s = reduceChatThreadEvent(s, complete);
    const stamped = s.turn_failures[0];

    expect(stamped).toEqual({
      turn_id: 'turn-1',
      message_id: 'a1',
      kind: 'engine.decoder_unavailable',
      text: 'the AI provider failed before answering',
      settings_link: false,
    });

    s = reduceChatThreadEvent(s, complete);

    expect(s.messages).toHaveLength(1);
    expect(s.turn_failures).toHaveLength(1);
    expect(s.turn_failures[0]).toBe(stamped);
  });

  it('resets turn_failures on a fresh snapshot hydrate', () => {
    let s = reduceChatThreadEvent(hydrated(), decoderFailure());

    expect(s.turn_failures).toHaveLength(1);

    s = hydrateThreadFromSnapshot(s, {
      ...mkSession('sess-1'),
      messages: [mkAssistantMessage('a1', 'sess-1')],
    });

    expect(s.turn_failures).toEqual([]);
    expect(initialChatThreadState().turn_failures).toEqual([]);
  });
});
describe('route-side scaffold handling — adopt-on-first-event', () => {
  const hydrated = () =>
    hydrateThreadFromSnapshot(initialChatThreadState(), {
      ...mkSession('sess-1'),
      messages: [],
    });

  const tokenStreamed = (
    turn_id: string,
    delta: string,
    cursor = 1,
  ): ServerEvent => ({
    kind: 'chat.token_streamed',
    session_id: 'sess-1',
    turn_id,
    delta,
    cursor,
  } as unknown as ServerEvent);

  const toolCallStarted = (turn_id: string, cursor = 1): ServerEvent => ({
    kind: 'chat.tool_call_started',
    session_id: 'sess-1',
    turn_id,
    tool_name: 'mail.search',
    tier: 1,
    args: { q: 'p' },
    cursor,
  } as unknown as ServerEvent);

  const toolCallCompleted = (turn_id: string, cursor = 1): ServerEvent => ({
    kind: 'chat.tool_call_completed',
    session_id: 'sess-1',
    turn_id,
    tool_name: 'mail.search',
    tier: 1,
    status: 'ok',
    result_ref: `sess-1:${turn_id}:mail.search`,
    cursor,
  } as unknown as ServerEvent);

  const messageComplete = (
    turn_id: string,
    id: string,
    content = 'final',
    cursor = 1,
  ): ServerEvent => ({
    kind: 'chat.message_complete',
    session_id: 'sess-1',
    turn_id,
    final: { ...mkAssistantMessage(id, 'sess-1'), content },
    cursor,
  } as unknown as ServerEvent);

  it('PRODUCTION end-to-end adopts on first delta and leaves no post-ack scaffold', () => {
    let s = hydrated();

    s = reduceChatThreadEvent(s, tokenStreamed('turn-1', 'Hello ', 1));
    expect(s.inflight?.turn_id).toBe('turn-1');
    expect(s.inflight?.assistant_content).toBe('Hello ');

    s = reduceChatThreadEvent(s, tokenStreamed('turn-1', 'world', 2));
    expect(s.inflight?.assistant_content).toBe('Hello world');

    s = reduceChatThreadEvent(s, toolCallStarted('turn-1', 3));
    expect(s.inflight?.tool_calls).toHaveLength(1);
    expect(s.inflight?.tool_calls[0]).toMatchObject({
      tool_name: 'mail.search',
      status: 'started',
    });

    s = reduceChatThreadEvent(s, toolCallCompleted('turn-1', 4));
    expect(s.inflight?.tool_calls[0]).toMatchObject({
      status: 'ok',
      result_ref: 'sess-1:turn-1:mail.search',
    });

    s = reduceChatThreadEvent(s, messageComplete('turn-1', 'm1', 'Hello world', 5));
    expect(s.inflight).toBeNull();
    expect(s.messages).toHaveLength(1);
    expect(s.messages[0]).toMatchObject({
      id: 'm1',
      role: 'assistant',
      content: 'Hello world',
    });
    expect(s.completed_turn_ids).toContain('turn-1');

    const beforeAck = s;
    s = beginInFlightTurn(s, 'turn-1');
    expect(s).toBe(beforeAck);
  });

  it('adopts when tool_call_started is the first turn event', () => {
    const s = reduceChatThreadEvent(hydrated(), toolCallStarted('turn-tools'));

    expect(s.inflight?.turn_id).toBe('turn-tools');
    expect(s.inflight?.assistant_content).toBe('');
    expect(s.inflight?.tool_calls).toEqual([
      {
        tool_name: 'mail.search',
        tier: 1,
        args: { q: 'p' },
        status: 'started',
      },
    ]);
  });

  it('does not resurrect a completed turn on a late token_streamed replay', () => {
    let s = reduceChatThreadEvent(
      hydrated(),
      messageComplete('turn-done', 'm-done', 'Done.'),
    );

    const beforeLateReplay = s;
    s = reduceChatThreadEvent(s, tokenStreamed('turn-done', 'late'));

    expect(s).toBe(beforeLateReplay);
  });

  it('tracks a different concurrent turn as a sibling without stealing the primary', () => {
    let s = reduceChatThreadEvent(hydrated(), tokenStreamed('turn-A', 'A'));

    s = reduceChatThreadEvent(s, tokenStreamed('turn-B', 'B'));
    s = reduceChatThreadEvent(s, toolCallStarted('turn-B'));

    s = reduceChatThreadEvent(s, tokenStreamed('turn-A', '+'));
    expect(s.inflight?.turn_id).toBe('turn-A');
    expect(s.inflight?.assistant_content).toBe('A+');
    expect(s.inflight?.siblings?.[0]).toMatchObject({
      turn_id: 'turn-B',
      assistant_content: 'B',
      tool_calls: [{ tool_name: 'mail.search', status: 'started' }],
    });
  });

  it('lets an explicit local send join an adopted scaffold and promotes it when the first completes', () => {
    let s = reduceChatThreadEvent(hydrated(), tokenStreamed('turn-A', 'from A'));

    s = beginInFlightTurn(s, 'turn-B');
    expect(s.inflight).toMatchObject({ turn_id: 'turn-A', assistant_content: 'from A' });
    expect(s.inflight?.siblings?.[0]).toMatchObject({ turn_id: 'turn-B', assistant_content: '' });

    s = reduceChatThreadEvent(s, messageComplete('turn-A', 'mA', 'A done'));
    expect(s.messages.map((m) => m.id)).toEqual(['mA']);
    expect(s.completed_turn_ids).toContain('turn-A');
    expect(s.inflight).toMatchObject({ turn_id: 'turn-B', assistant_content: '' });

    s = reduceChatThreadEvent(s, tokenStreamed('turn-B', 'B live'));
    expect(s.inflight?.turn_id).toBe('turn-B');
    expect(s.inflight?.assistant_content).toBe('B live');
  });

  it('supports ack-first ordering when beginInFlightTurn creates the scaffold', () => {
    let s = beginInFlightTurn(hydrated(), 'turn-ack-first');

    s = reduceChatThreadEvent(s, tokenStreamed('turn-ack-first', 'Ack ', 1));
    s = reduceChatThreadEvent(s, tokenStreamed('turn-ack-first', 'first', 2));
    expect(s.inflight?.assistant_content).toBe('Ack first');

    s = reduceChatThreadEvent(
      s,
      messageComplete('turn-ack-first', 'm-ack-first', 'Ack first', 3),
    );

    expect(s.inflight).toBeNull();
    expect(s.messages.map((m) => m.id)).toEqual(['m-ack-first']);
    expect(s.completed_turn_ids).toContain('turn-ack-first');
  });

  it('dedupes completed_turn_ids on replay and caps the memory at 50', () => {
    let s = hydrated();
    const replay = messageComplete('turn-replay', 'm-replay', 'Replay done.');

    s = reduceChatThreadEvent(s, replay);
    s = reduceChatThreadEvent(s, replay);

    expect(s.completed_turn_ids).toEqual(['turn-replay']);
    expect(s.messages.map((m) => m.id)).toEqual(['m-replay']);

    s = hydrated();
    for (let i = 0; i < 51; i += 1) {
      s = reduceChatThreadEvent(
        s,
        messageComplete(`turn-${i}`, `m-${i}`, `done ${i}`, i + 1),
      );
    }

    expect(s.completed_turn_ids).toHaveLength(50);
    expect(s.completed_turn_ids).not.toContain('turn-0');
    expect(s.completed_turn_ids[0]).toBe('turn-1');
    expect(s.completed_turn_ids.at(-1)).toBe('turn-50');
  });

  it('resets completed_turn_ids and inflight on hydrateThreadFromSnapshot', () => {
    let s = beginInFlightTurn(hydrated(), 'turn-open');
    s = reduceChatThreadEvent(s, messageComplete('turn-done', 'm-done', 'Done.'));

    expect(s.inflight?.turn_id).toBe('turn-open');
    expect(s.completed_turn_ids).toEqual(['turn-done']);

    s = hydrateThreadFromSnapshot(s, {
      ...mkSession('sess-1'),
      messages: [mkAssistantMessage('m1', 'sess-1')],
    });

    expect(s.inflight).toBeNull();
    expect(s.completed_turn_ids).toEqual([]);
    expect(s.messages.map((m) => m.id)).toEqual(['m1']);
  });
});

describe('tool_call_completed duplicate tool rows', () => {
  it('patches only the first matching started row', () => {
    // Reducer regression: one completion resolves one duplicate dispatch.
    let s = initialChatThreadState();
    s = hydrateThreadFromSnapshot(s, { ...mkSession('sess-1'), messages: [] });
    s = beginInFlightTurn(s, 'turn-1');

    const started = {
      kind: 'chat.tool_call_started',
      session_id: 'sess-1',
      turn_id: 'turn-1',
      tool_name: 'mail.search',
      tier: 1,
      args: { q: 'p' },
      cursor: 1,
    } satisfies ServerEvent;

    s = reduceChatThreadEvent(s, started);
    s = reduceChatThreadEvent(s, { ...started, cursor: 2 });
    s = reduceChatThreadEvent(s, {
      kind: 'chat.tool_call_completed',
      session_id: 'sess-1',
      turn_id: 'turn-1',
      tool_name: 'mail.search',
      tier: 1,
      status: 'ok',
      result_ref: 'sess-1:turn-1:mail.search:first',
      cursor: 3,
    } satisfies ServerEvent);

    expect(s.inflight?.tool_calls).toEqual([
      {
        tool_name: 'mail.search',
        tier: 1,
        args: { q: 'p' },
        status: 'ok',
        result_ref: 'sess-1:turn-1:mail.search:first',
      },
      {
        tool_name: 'mail.search',
        tier: 1,
        args: { q: 'p' },
        status: 'started',
      },
    ]);
  });
});
