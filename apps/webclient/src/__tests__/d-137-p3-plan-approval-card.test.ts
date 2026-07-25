import { describe, expect, it, vi } from 'vitest';
import type {
  BroadcastEventKind,
  ChatMessage,
  ChatPlanProposal,
  ChatSession,
  ChatSessionSummary,
  ServerEvent,
} from '@recued/contracts';

import {
  applyPlanResolution,
  beginInFlightTurn,
  hydrateThreadFromSnapshot,
  initialChatThreadState,
  reduceChatThreadEvent,
  type ChatThreadState,
} from '../chat/state.js';
import {
  bootstrapChatRoute,
  CHAT_ROUTE_ERROR_ATTR,
  CHAT_ROUTE_MESSAGE_ATTR,
  CHAT_ROUTE_PLAN_APPROVE_ATTR,
  CHAT_ROUTE_PLAN_CANCEL_ATTR,
  CHAT_ROUTE_PLAN_CARD_ATTR,
  type ChatRoute,
  type ChatRouteConn,
} from '../chat/bootstrap-chat-route.js';

interface FakeEl {
  tagName: string;
  className: string;
  textContent: string;
  type: string;
  disabled: boolean;
  value: string;
  attrs: Map<string, string>;
  children: FakeEl[];
  parent: FakeEl | null;
  listeners: Map<string, Array<() => void>>;
  readonly firstChild: FakeEl | null;
  setAttribute(k: string, v: string): void;
  getAttribute(k: string): string | null;
  appendChild(c: FakeEl): FakeEl;
  removeChild(c: FakeEl): FakeEl;
  remove(): void;
  addEventListener(type: string, fn: () => void): void;
  click(): void;
}

interface FakeDoc {
  styleElements: FakeEl[];
  head: { querySelector(sel: string): FakeEl | null; appendChild(el: FakeEl): FakeEl };
  createElement(tag: string): FakeEl;
}

const makeFakeEl = (tag: string): FakeEl => {
  const el: FakeEl = {
    tagName: tag.toUpperCase(),
    className: '',
    textContent: '',
    type: '',
    disabled: false,
    value: '',
    attrs: new Map(),
    children: [],
    parent: null,
    listeners: new Map(),
    get firstChild() {
      return el.children[0] ?? null;
    },
    setAttribute(k, v) {
      el.attrs.set(k, v);
    },
    getAttribute(k) {
      return el.attrs.get(k) ?? null;
    },
    appendChild(c) {
      c.parent = el;
      el.children.push(c);
      return c;
    },
    removeChild(c) {
      const idx = el.children.indexOf(c);
      if (idx < 0) throw new Error('removeChild: not a child');
      el.children.splice(idx, 1);
      c.parent = null;
      return c;
    },
    remove() {
      if (el.parent === null) return;
      const idx = el.parent.children.indexOf(el);
      if (idx >= 0) el.parent.children.splice(idx, 1);
      el.parent = null;
    },
    addEventListener(type, fn) {
      const list = el.listeners.get(type) ?? [];
      list.push(fn);
      el.listeners.set(type, list);
    },
    click() {
      if (el.disabled) return;
      for (const fn of el.listeners.get('click') ?? []) fn();
    },
  };
  return el;
};

const makeFakeDocument = (): FakeDoc => {
  const styleElements: FakeEl[] = [];
  const matchSelector = (sel: string): { tag: string; attr: string } | null => {
    const m = sel.match(/^([\w-]+)\[([\w-]+)\]$/);
    return m === null ? null : { tag: m[1]!.toUpperCase(), attr: m[2]! };
  };
  return {
    styleElements,
    head: {
      querySelector(sel) {
        const parsed = matchSelector(sel);
        if (parsed === null) return null;
        return (
          styleElements.find(
            (s) => s.tagName === parsed.tag && s.attrs.has(parsed.attr),
          ) ?? null
        );
      },
      appendChild(el) {
        styleElements.push(el);
        return el;
      },
    },
    createElement: (tag) => makeFakeEl(tag),
  };
};

const collectByAttr = (root: FakeEl, attr: string, out: FakeEl[] = []): FakeEl[] => {
  if (root.attrs.has(attr)) out.push(root);
  for (const child of root.children) collectByAttr(child, attr, out);
  return out;
};

const allText = (root: FakeEl): string =>
  [root.textContent, ...root.children.map((child) => allText(child))].join(' ');

const tick = async (n = 4): Promise<void> => {
  for (let i = 0; i < n; i += 1) await Promise.resolve();
};

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
}

const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const chatSession = (id = 'chat_1'): ChatSession => ({
  id,
  title: 'Ops chat',
  created_at: 1_000,
  last_active_at: 2_000,
  archived: false,
  picker_state: { current: 'self' },
  model_routing: {
    current: 'byok',
    provider: 'local',
    model_id: 'local-default',
    overridden: false,
  },
});

const sessionSummary = (id = 'chat_1'): ChatSessionSummary => ({
  id,
  title: 'Ops chat',
  created_at: 1_000,
  last_active_at: 2_000,
  message_count: 1,
  archived: false,
  picker_state: { current: 'self' },
  model_routing: {
    current: 'byok',
    provider: 'local',
    overridden: false,
  },
});

const assistantMessage = (
  id: string,
  content = 'Assistant response.',
  session_id = 'chat_1',
): ChatMessage => ({
  id,
  session_id,
  role: 'assistant',
  contributor: 'model',
  content,
  target_server: 'self',
  picker_at_send: {
    display_name: 'This server',
    signature: {
      server_kind: 'recued',
      version: '1.0.0',
      instance_id: 'inst_1',
    },
  },
  model_used: { provider: 'local', model_id: 'local-default' },
  ts: 2_000,
});

const chatPlan = (
  overrides: Partial<ChatPlanProposal> = {},
): ChatPlanProposal => ({
  plan_id: 'plan_1',
  session_id: 'chat_1',
  turn_id: 'turn_1',
  tool: 'mail.send',
  tier: 2,
  classification: 'write',
  args: { to: 'mary@example.com', body: 'Hello' },
  args_hash: 'hash_1',
  status: 'proposed',
  created_at: 3_000,
  ...overrides,
});

type PlanProposedEvent = Extract<ServerEvent, { kind: 'chat.plan_proposed' }>;
type PlanResolvedEvent = Extract<ServerEvent, { kind: 'chat.plan_resolved' }>;
type MessageCompleteEvent = Extract<ServerEvent, { kind: 'chat.message_complete' }>;
type TokenStreamedEvent = Extract<ServerEvent, { kind: 'chat.token_streamed' }>;

const planProposed = (
  overrides: Partial<Omit<PlanProposedEvent, 'kind'>> = {},
): PlanProposedEvent => ({
  kind: 'chat.plan_proposed',
  session_id: 'chat_1',
  turn_id: 'turn_1',
  plan_id: 'plan_1',
  tool: 'mail.send',
  tier: 2,
  args: { to: 'mary@example.com', body: 'Hello' },
  cursor: 1,
  ...overrides,
});

const planResolved = (
  plan: ChatPlanProposal,
  overrides: Partial<Omit<PlanResolvedEvent, 'kind' | 'plan'>> = {},
): PlanResolvedEvent => ({
  kind: 'chat.plan_resolved',
  session_id: plan.session_id,
  turn_id: plan.turn_id,
  plan,
  cursor: 2,
  ...overrides,
});

const messageComplete = (
  turn_id: string,
  final: ChatMessage,
  cursor = 3,
): MessageCompleteEvent => ({
  kind: 'chat.message_complete',
  session_id: final.session_id,
  turn_id,
  final,
  cursor,
});

const tokenStreamed = (
  turn_id: string,
  delta: string,
  cursor = 1,
): TokenStreamedEvent => ({
  kind: 'chat.token_streamed',
  session_id: 'chat_1',
  turn_id,
  delta,
  cursor,
});

const hydrated = (
  messages: ChatMessage[] = [],
  session: ChatSession = chatSession(),
): ChatThreadState =>
  hydrateThreadFromSnapshot(initialChatThreadState(), {
    ...session,
    messages,
  });

const onlyPlanCard = (state: ChatThreadState) => {
  expect(state.plan_cards).toHaveLength(1);
  const card = state.plan_cards[0];
  if (card === undefined) throw new Error('missing plan card');
  return card;
};

const requirePlanCard = (root: FakeEl, planId: string): FakeEl => {
  const card = collectByAttr(root, CHAT_ROUTE_PLAN_CARD_ATTR).find(
    (el) => el.getAttribute('data-plan-id') === planId,
  );
  if (card === undefined) throw new Error(`missing plan card ${planId}`);
  return card;
};

const requireMessageRow = (root: FakeEl, text: string): FakeEl => {
  const row = collectByAttr(root, CHAT_ROUTE_MESSAGE_ATTR).find((el) =>
    allText(el).includes(text),
  );
  if (row === undefined) throw new Error(`missing message row ${text}`);
  return row;
};

const requireChildClass = (root: FakeEl, className: string): FakeEl => {
  const child = root.children.find((el) => el.className === className);
  if (child === undefined) throw new Error(`missing child class ${className}`);
  return child;
};

const childIndex = (parent: FakeEl, child: FakeEl): number => {
  const index = parent.children.indexOf(child);
  if (index < 0) throw new Error('child is not attached to parent');
  return index;
};

const planArgsText = (card: FakeEl): string =>
  requireChildClass(card, 'chat-plan-card-args').textContent;

const planHint = (card: FakeEl): FakeEl | undefined =>
  card.children.find((el) => el.className === 'chat-plan-card-hint');

type RawConn = (method: string, payload?: unknown) => Promise<unknown>;
type PlanRpc = (payload: { plan_id: string }) => Promise<{ plan: ChatPlanProposal }>;

interface RouteHarness {
  root: FakeEl;
  route: ChatRoute;
  connSpy: ReturnType<typeof vi.fn<RawConn>>;
  publish(event: ServerEvent): void;
}

interface RouteHarnessOptions {
  messages?: ChatMessage[];
  approvePlan?: PlanRpc;
  cancelPlan?: PlanRpc;
}

const requirePlanPayload = (payload: unknown): { plan_id: string } => {
  if (
    payload === null ||
    typeof payload !== 'object' ||
    typeof (payload as { plan_id?: unknown }).plan_id !== 'string'
  ) {
    throw new Error('missing plan_id payload');
  }
  return payload as { plan_id: string };
};

const mountChatRoute = (options: RouteHarnessOptions = {}): RouteHarness => {
  const doc = makeFakeDocument();
  const root = doc.createElement('div');
  const listeners = new Map<BroadcastEventKind, Array<(event: ServerEvent) => void>>();
  const session = chatSession();
  const messages = options.messages ?? [];
  const connSpy = vi.fn<RawConn>(async (method, payload) => {
    if (method === 'chat.sessions.list') return { sessions: [sessionSummary()] };
    if (method === 'chat.session.get') return { ...session, messages };
    if (method === 'chat.session.create') return { session_id: 'chat_new' };
    if (method === 'chat.send') return { turn_id: 'turn_send' };
    if (method === 'server.getLLMConfig') {
      return {
        config: {
          slot_1: {
            provider: 'local',
            model: 'local-default',
            api_key: 'configured',
          },
        },
      };
    }
    if (method === 'prefs.get') return { prefs: {} };
    if (method === 'chat.plan.approve') {
      const planPayload = requirePlanPayload(payload);
      return options.approvePlan !== undefined
        ? options.approvePlan(planPayload)
        : { plan: chatPlan({ plan_id: planPayload.plan_id, status: 'approved' }) };
    }
    if (method === 'chat.plan.cancel') {
      const planPayload = requirePlanPayload(payload);
      return options.cancelPlan !== undefined
        ? options.cancelPlan(planPayload)
        : { plan: chatPlan({ plan_id: planPayload.plan_id, status: 'cancelled' }) };
    }
    throw new Error(`unexpected method ${method}`);
  });

  const subscribe = <K extends BroadcastEventKind>(
    kind: K,
    listener: (event: Extract<ServerEvent, { kind: K }>) => void,
  ): (() => void) => {
    const wrapped = listener as unknown as (event: ServerEvent) => void;
    const list = listeners.get(kind) ?? [];
    list.push(wrapped);
    listeners.set(kind, list);
    return () => {
      const current = listeners.get(kind) ?? [];
      listeners.set(
        kind,
        current.filter((fn) => fn !== wrapped),
      );
    };
  };

  const route = bootstrapChatRoute({
    root: root as unknown as HTMLElement,
    document: doc as unknown as Document,
    conn: connSpy as unknown as ChatRouteConn,
    subscribe,
  });

  return {
    root,
    route,
    connSpy,
    publish(event) {
      for (const listener of listeners.get(event.kind) ?? []) listener(event);
    },
  };
};

const openMountedRoute = async (h: RouteHarness): Promise<void> => {
  await tick();
  await h.route.openSession('chat_1');
  await tick();
};

const stageProposedCard = async (
  h: RouteHarness,
  planId: string,
  turnId: string,
): Promise<void> => {
  await openMountedRoute(h);
  h.publish(
    planProposed({
      plan_id: planId,
      turn_id: turnId,
      args: { subject: 'Review me' },
    }),
  );
  h.publish(messageComplete(turnId, assistantMessage('msg_' + planId, 'Needs approval.')));
  await tick();
};

describe('D-137 P3 plan-approval reducer', () => {
  it('inserts proposals once and refuses replayed proposal downgrades', () => {
    let state = hydrated();

    state = reduceChatThreadEvent(state, planProposed());
    expect(onlyPlanCard(state)).toMatchObject({
      plan_id: 'plan_1',
      turn_id: 'turn_1',
      tool: 'mail.send',
      tier: 2,
      args: { to: 'mary@example.com', body: 'Hello' },
      status: 'proposed',
    });

    const afterReplay = reduceChatThreadEvent(
      state,
      planProposed({
        tool: 'mail.delete',
        args: { id: 'do-not-overwrite' },
        cursor: 2,
      }),
    );
    expect(afterReplay).toBe(state);
    expect(onlyPlanCard(afterReplay).tool).toBe('mail.send');

    const resolved = reduceChatThreadEvent(
      afterReplay,
      planResolved(chatPlan({ status: 'approved', resolved_at: 3_500 })),
    );
    expect(onlyPlanCard(resolved).status).toBe('approved');

    const lateProposal = reduceChatThreadEvent(
      resolved,
      planProposed({ args: { id: 'late-proposal' }, cursor: 4 }),
    );
    expect(lateProposal).toBe(resolved);
    expect(onlyPlanCard(lateProposal).status).toBe('approved');
  });

  it('applies resolution flips, late-join materialization, replay idempotence, proposed refusal, and session gating', () => {
    let state = reduceChatThreadEvent(hydrated(), planProposed());
    const approved = chatPlan({ status: 'approved', resolved_at: 3_500 });

    state = reduceChatThreadEvent(state, planResolved(approved));
    expect(onlyPlanCard(state).status).toBe('approved');

    const replay = reduceChatThreadEvent(state, planResolved(approved, { cursor: 3 }));
    expect(replay).toBe(state);

    const proposedDowngrade = applyPlanResolution(
      state,
      chatPlan({ status: 'proposed', args: { id: 'downgrade' } }),
    );
    expect(proposedDowngrade).toBe(state);

    const wrongSession = applyPlanResolution(
      state,
      chatPlan({
        session_id: 'chat_other',
        status: 'cancelled',
        resolved_at: 3_600,
      }),
    );
    expect(wrongSession).toBe(state);

    const lateJoin = applyPlanResolution(
      hydrated(),
      chatPlan({
        plan_id: 'plan_late',
        turn_id: 'turn_late',
        status: 'cancelled',
        args: { id: 'late' },
        resolved_at: 3_700,
      }),
    );
    expect(onlyPlanCard(lateJoin)).toMatchObject({
      plan_id: 'plan_late',
      turn_id: 'turn_late',
      tool: 'mail.send',
      tier: 2,
      args: { id: 'late' },
      status: 'cancelled',
    });
  });

  it('stamps message_id on message_complete and clears ephemeral cards on hydrate', () => {
    let state = reduceChatThreadEvent(hydrated(), planProposed());
    state = beginInFlightTurn(state, 'turn_1');

    state = reduceChatThreadEvent(
      state,
      messageComplete('turn_1', assistantMessage('msg_1', 'Final answer.')),
    );
    const stamped = onlyPlanCard(state);

    expect(stamped.message_id).toBe('msg_1');
    expect(state.messages.map((m) => m.id)).toEqual(['msg_1']);
    expect(state.inflight).toBeNull();

    const replay = reduceChatThreadEvent(
      state,
      messageComplete('turn_1', assistantMessage('msg_1', 'Final answer.'), 4),
    );
    expect(replay.messages).toHaveLength(1);
    expect(onlyPlanCard(replay)).toBe(stamped);

    const reset = hydrateThreadFromSnapshot(replay, {
      ...chatSession(),
      messages: [assistantMessage('msg_snapshot', 'Reloaded.')],
    });
    expect(reset.plan_cards).toEqual([]);
    expect(reset.inflight).toBeNull();
    expect(reset.completed_turn_ids).toEqual([]);
  });
});

describe('D-137 P3 plan-approval chat route', () => {
  it('renders stamped, in-flight, and orphan cards with status attributes and text args', async () => {
    expect(CHAT_ROUTE_PLAN_CARD_ATTR).toBe('data-recued-chat-route-plan-card');
    expect(CHAT_ROUTE_PLAN_APPROVE_ATTR).toBe('data-recued-chat-route-plan-approve');
    expect(CHAT_ROUTE_PLAN_CANCEL_ATTR).toBe('data-recued-chat-route-plan-cancel');

    const h = mountChatRoute({
      messages: [assistantMessage('msg_anchor', 'Completed anchor.')],
    });
    await openMountedRoute(h);

    h.publish(
      planProposed({
        plan_id: 'plan_stamped',
        turn_id: 'turn_stamped',
        args: { to: 'mary@example.com', body: '<b>literal</b>' },
      }),
    );
    h.publish(messageComplete('turn_stamped', assistantMessage('msg_anchor', 'Completed anchor.')));
    h.publish(tokenStreamed('turn_live', 'Live scaffold.'));
    h.publish(
      planProposed({
        plan_id: 'plan_live',
        turn_id: 'turn_live',
        args: null,
        cursor: 4,
      }),
    );
    h.publish(
      planResolved(
        chatPlan({
          plan_id: 'plan_orphan',
          turn_id: 'turn_orphan',
          status: 'cancelled',
          args: undefined,
          resolved_at: 4_000,
        }),
        { cursor: 5 },
      ),
    );
    await tick();

    const stamped = requirePlanCard(h.root, 'plan_stamped');
    const live = requirePlanCard(h.root, 'plan_live');
    const orphan = requirePlanCard(h.root, 'plan_orphan');
    const anchorRow = requireMessageRow(h.root, 'Completed anchor.');
    const liveRow = requireMessageRow(h.root, 'Live scaffold.');

    expect(stamped.getAttribute('data-status')).toBe('proposed');
    expect(live.getAttribute('data-status')).toBe('proposed');
    expect(orphan.getAttribute('data-status')).toBe('cancelled');

    // The mechanism hint is approved-only: proposed cards speak
    // through the buttons; cancelled is terminal and self-evident.
    expect(planHint(stamped)).toBeUndefined();
    expect(planHint(live)).toBeUndefined();
    expect(planHint(orphan)).toBeUndefined();

    expect(stamped.parent).toBe(anchorRow.parent);
    expect(childIndex(stamped.parent!, stamped)).toBe(
      childIndex(anchorRow.parent!, anchorRow) + 1,
    );
    expect(live.parent).toBe(liveRow.parent);
    expect(childIndex(live.parent!, live)).toBe(childIndex(liveRow.parent!, liveRow) + 1);
    expect(orphan.parent).not.toBeNull();
    expect(childIndex(orphan.parent!, orphan)).toBe(orphan.parent!.children.length - 1);

    expect(planArgsText(stamped)).toBe(
      JSON.stringify({ to: 'mary@example.com', body: '<b>literal</b>' }, null, 2),
    );
    expect(planArgsText(live)).toBe('(none)');
    expect(planArgsText(orphan)).toBe('(none)');

    h.route.dispose();
  });

  it('approves through rpc, disables both buttons while pending, and flips optimistically', async () => {
    const approve = deferred<{ plan: ChatPlanProposal }>();
    const h = mountChatRoute({
      approvePlan: () => approve.promise,
    });
    await stageProposedCard(h, 'plan_approve', 'turn_approve');

    requirePlanCard(h.root, 'plan_approve');
    collectByAttr(h.root, CHAT_ROUTE_PLAN_APPROVE_ATTR)[0]!.click();
    await tick();

    expect(h.connSpy).toHaveBeenCalledWith('chat.plan.approve', {
      plan_id: 'plan_approve',
    });
    expect(collectByAttr(h.root, CHAT_ROUTE_PLAN_APPROVE_ATTR)[0]!.disabled).toBe(true);
    expect(collectByAttr(h.root, CHAT_ROUTE_PLAN_CANCEL_ATTR)[0]!.disabled).toBe(true);

    approve.resolve({
      plan: chatPlan({
        plan_id: 'plan_approve',
        turn_id: 'turn_approve',
        status: 'approved',
        resolved_at: 4_000,
      }),
    });

    await vi.waitFor(() => {
      expect(requirePlanCard(h.root, 'plan_approve').getAttribute('data-status')).toBe(
        'approved',
      );
    });
    expect(collectByAttr(h.root, CHAT_ROUTE_PLAN_APPROVE_ATTR)).toHaveLength(0);
    expect(collectByAttr(h.root, CHAT_ROUTE_PLAN_CANCEL_ATTR)).toHaveLength(0);
    // Truthful since cross-turn consumption (e7b9c044): the agent's
    // re-issue on the next turn consumes the approval + dispatches.
    expect(planHint(requirePlanCard(h.root, 'plan_approve'))?.textContent).toBe(
      'Runs when you continue the conversation.',
    );

    h.route.dispose();
  });

  it('cancels through rpc and removes the action buttons after the optimistic flip', async () => {
    const h = mountChatRoute();
    await stageProposedCard(h, 'plan_cancel', 'turn_cancel');

    collectByAttr(h.root, CHAT_ROUTE_PLAN_CANCEL_ATTR)[0]!.click();

    await vi.waitFor(() => {
      expect(requirePlanCard(h.root, 'plan_cancel').getAttribute('data-status')).toBe(
        'cancelled',
      );
    });
    expect(planHint(requirePlanCard(h.root, 'plan_cancel'))).toBeUndefined();
    expect(h.connSpy).toHaveBeenCalledWith('chat.plan.cancel', {
      plan_id: 'plan_cancel',
    });
    expect(collectByAttr(h.root, CHAT_ROUTE_PLAN_APPROVE_ATTR)).toHaveLength(0);
    expect(collectByAttr(h.root, CHAT_ROUTE_PLAN_CANCEL_ATTR)).toHaveLength(0);

    h.route.dispose();
  });

  it('surfaces rpc rejection on the route error line and re-enables the proposed buttons', async () => {
    const approve = deferred<{ plan: ChatPlanProposal }>();
    const h = mountChatRoute({
      approvePlan: () => approve.promise,
    });
    await stageProposedCard(h, 'plan_reject', 'turn_reject');

    collectByAttr(h.root, CHAT_ROUTE_PLAN_APPROVE_ATTR)[0]!.click();
    await tick();
    expect(collectByAttr(h.root, CHAT_ROUTE_PLAN_APPROVE_ATTR)[0]!.disabled).toBe(true);
    expect(collectByAttr(h.root, CHAT_ROUTE_PLAN_CANCEL_ATTR)[0]!.disabled).toBe(true);

    approve.reject(new Error('plan already resolved'));

    await vi.waitFor(() => {
      expect(collectByAttr(h.root, CHAT_ROUTE_ERROR_ATTR)[0]?.textContent).toBe(
        'plan already resolved',
      );
    });
    expect(requirePlanCard(h.root, 'plan_reject').getAttribute('data-status')).toBe(
      'proposed',
    );
    expect(collectByAttr(h.root, CHAT_ROUTE_PLAN_APPROVE_ATTR)[0]!.disabled).toBe(false);
    expect(collectByAttr(h.root, CHAT_ROUTE_PLAN_CANCEL_ATTR)[0]!.disabled).toBe(false);

    h.route.dispose();
  });
});
