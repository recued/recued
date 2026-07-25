/** D-174 - global top-bar approval attention popover. */

import { describe, expect, it, vi } from 'vitest';
import type { ServerPendingApproval, ServerPendingAsk } from '@recued/contracts';

import {
  ATTENTION_CHAT_PLAN_LINK_ATTR,
  ATTENTION_CHAT_PLAN_RESOLUTION_ATTR,
  ATTENTION_CHAT_PLAN_RESOLUTION_ANNOUNCER_ATTR,
  ATTENTION_GATEWAY_ASK_ROW_ATTR,
  ATTENTION_SEE_ALL_LINK_ATTR,
  ATTENTION_TOPBAR_HOST_ATTR,
  ATTENTION_TOPBAR_STYLES,
  ATTENTION_TOPBAR_STYLES_MARKER,
  mountApprovalAttentionPopover,
  type ApprovalAttentionPopoverMount,
} from '../attention/approval-attention-popover.js';
import type {
  ApprovalChangedSubscriber,
  ApprovalListCaller,
  ApprovalResolveCaller,
  ApprovalSubscribeCaller,
} from '../approvals/bootstrap-approvals-route.js';
import type {
  AsksListCaller,
  AsksSubmitAnswerCaller,
} from '../approvals/asks-panel.js';
import type {
  PendingChatPlan,
  PendingChatPlanResolution,
} from '../approvals/pending-chat-plans-store.js';
import type { BroadcastSubscriber } from '../realtime/subscriber.js';
import type { WebclientReconnectSubscriber } from '../realtime/connection-status.js';

interface FakeEl extends HTMLElement {
  attrs: Map<string, string>;
  childList: FakeEl[];
  parentRef: FakeEl | null;
  listeners: Map<string, Set<(event: Event) => void>>;
  fireAction(attrs: Record<string, string>): void;
}

interface FakeDoc {
  head: HTMLHeadElement;
  styleElements: FakeEl[];
  createElement(tag: string): FakeEl;
}

const makeFakeEl = (tag: string): FakeEl => {
  let html = '';
  let text = '';
  const attrs = new Map<string, string>();
  const childList: FakeEl[] = [];
  const listeners = new Map<string, Set<(event: Event) => void>>();
  const el: Partial<FakeEl> = {
    tagName: tag.toUpperCase(),
    attrs,
    childList,
    parentRef: null,
    listeners,
    get innerHTML() {
      return html;
    },
    set innerHTML(value: string) {
      html = value;
    },
    get textContent() {
      return text;
    },
    set textContent(value: string) {
      text = value;
    },
    setAttribute(name, value) {
      attrs.set(name, value);
    },
    getAttribute(name) {
      return attrs.get(name) ?? null;
    },
    hasAttribute(name) {
      return attrs.has(name);
    },
    appendChild: ((child: FakeEl): FakeEl => {
      childList.push(child);
      child.parentRef = el as FakeEl;
      return child;
    }) as unknown as HTMLElement['appendChild'],
    removeChild: ((child: FakeEl): FakeEl => {
      const idx = childList.indexOf(child);
      if (idx < 0) throw new Error('removeChild: not a child');
      childList.splice(idx, 1);
      child.parentRef = null;
      return child;
    }) as unknown as HTMLElement['removeChild'],
    remove: (): void => {
      const parent = el.parentRef;
      if (parent === null || parent === undefined) return;
      const idx = parent.childList.indexOf(el as FakeEl);
      if (idx >= 0) parent.childList.splice(idx, 1);
      el.parentRef = null;
    },
    addEventListener(type: string, fn: EventListenerOrEventListenerObject) {
      const set = listeners.get(type) ?? new Set();
      set.add(fn as (event: Event) => void);
      listeners.set(type, set);
    },
    removeEventListener(type: string, fn: EventListenerOrEventListenerObject) {
      listeners.get(type)?.delete(fn as (event: Event) => void);
    },
    fireAction(actionAttrs) {
      const actionTarget = {
        getAttribute(name: string): string | null {
          return actionAttrs[name] ?? null;
        },
        closest(selector: string) {
          return selector === '[data-action]' ? actionTarget : null;
        },
      };
      const event = {
        target: actionTarget,
        preventDefault: vi.fn(),
      } as unknown as Event;
      for (const fn of listeners.get('click') ?? []) fn(event);
    },
  };
  return el as FakeEl;
};

const makeFakeDocument = (): FakeDoc => {
  const styleElements: FakeEl[] = [];
  const matchSelector = (sel: string): { tag: string; attr: string } | null => {
    const m = sel.match(/^([\w-]+)\[([\w-]+)\]$/);
    return m === null ? null : { tag: m[1]!.toUpperCase(), attr: m[2]! };
  };
  const head: Partial<HTMLHeadElement> = {
    querySelector(selector: string) {
      const parsed = matchSelector(selector);
      if (parsed === null) return null;
      return (
        styleElements.find(
          (s) => s.tagName === parsed.tag && s.attrs.has(parsed.attr),
        ) ?? null
      );
    },
    appendChild: ((el: FakeEl): FakeEl => {
      styleElements.push(el);
      return el;
    }) as unknown as HTMLHeadElement['appendChild'],
  };
  return {
    head: head as HTMLHeadElement,
    styleElements,
    createElement: (tag: string): FakeEl => makeFakeEl(tag),
  };
};

const firstByAttr = (root: FakeEl, attr: string): FakeEl | undefined => {
  if (root.attrs.has(attr)) return root;
  for (const child of root.childList) {
    const found = firstByAttr(child, attr);
    if (found !== undefined) return found;
  }
  return undefined;
};

const approval = (
  id: string,
  overrides: Partial<ServerPendingApproval> = {},
): ServerPendingApproval => ({
  approval_id: id,
  recipe_id: `recipe-${id}`,
  step_id: `step-${id}`,
  ingredient_slug: 'mail-send',
  risk_tier: 'write',
  description: `Send follow-up ${id}`,
  resolved_input: { to: `${id}@example.com` },
  created_at: 1_700_000_000_000,
  timeout_at: 1_700_000_300_000,
  initiator_instance: 'laptop',
  ...overrides,
});

const ask = (
  id: string,
  overrides: Partial<ServerPendingAsk> = {},
): ServerPendingAsk => ({
  ask_id: id,
  title: `Gateway write approval ${id}`,
  text: `Allow gateway write ${id}?`,
  options: [
    { id: 'approve', label: 'Approve' },
    { id: 'reject', label: 'Reject' },
  ],
  created_at: 1_700_000_000_500,
  ...overrides,
});

const makeFakeSubscriber = () => {
  const byKind = new Map<string, Set<(e: unknown) => void>>();
  let unsubCount = 0;
  const on = (kind: string, listener: (e: unknown) => void): (() => void) => {
    const set = byKind.get(kind) ?? new Set();
    set.add(listener);
    byKind.set(kind, set);
    return () => {
      unsubCount += 1;
      set.delete(listener);
    };
  };
  return {
    on: on as BroadcastSubscriber['on'],
    fire: (kind: string, event: unknown = {}): void => {
      for (const fn of [...(byKind.get(kind) ?? [])]) fn(event);
    },
    count: (kind: string): number => byKind.get(kind)?.size ?? 0,
    unsubCount: (): number => unsubCount,
  };
};

const makeFakeApprovalChanged = () => {
  const listeners = new Set<(e: { seq: number; pending_count: number }) => void>();
  let unsubCount = 0;
  const on: ApprovalChangedSubscriber = (listener) => {
    listeners.add(listener);
    return () => {
      unsubCount += 1;
      listeners.delete(listener);
    };
  };
  return {
    on,
    fire: (seq: number, pending_count: number): void => {
      for (const listener of [...listeners]) listener({ seq, pending_count });
    },
    count: (): number => listeners.size,
    unsubCount: (): number => unsubCount,
  };
};

const makeFakeReconnect = () => {
  const listeners = new Set<() => void>();
  return {
    subscribe: ((listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }) as WebclientReconnectSubscriber,
    fire: (): void => {
      for (const l of [...listeners]) l();
    },
    listenerCount: (): number => listeners.size,
  };
};

const tick = async (n = 6): Promise<void> => {
  for (let i = 0; i < n; i += 1) await Promise.resolve();
};

const mountFor = (
  opts: {
    rows?: () => ReadonlyArray<ServerPendingApproval>;
    asks?: () => ReadonlyArray<ServerPendingAsk>;
    runApprovalList?: ApprovalListCaller;
    runApprovalResolve?: ApprovalResolveCaller;
    runApprovalSubscribe?: ApprovalSubscribeCaller;
    runPendingAsksList?: AsksListCaller;
    runPendingAskSubmitAnswer?: AsksSubmitAnswerCaller;
    chatPlans?: {
      list(): ReadonlyArray<PendingChatPlan>;
      subscribe(listener: () => void): () => void;
    };
    runChatPlanResolve?: (args: {
      plan_id: string;
      decision: 'approve' | 'reject';
    }) => Promise<unknown>;
    reconnect?: ReturnType<typeof makeFakeReconnect>;
  } = {},
): {
  doc: FakeDoc;
  root: FakeEl;
  topbar: FakeEl;
  handle: ApprovalAttentionPopoverMount;
  runApprovalList: ApprovalListCaller;
  runApprovalResolve: ApprovalResolveCaller;
  runApprovalSubscribe: ApprovalSubscribeCaller;
  runPendingAsksList: AsksListCaller;
  runPendingAskSubmitAnswer: AsksSubmitAnswerCaller;
  approvalChanged: ReturnType<typeof makeFakeApprovalChanged>;
  sub: ReturnType<typeof makeFakeSubscriber>;
} => {
  const doc = makeFakeDocument();
  const root = doc.createElement('div');
  const rows = opts.rows ?? (() => [approval('ap-1')]);
  const asks = opts.asks ?? (() => []);
  const runApprovalList =
    opts.runApprovalList ?? vi.fn(async () => ({ approvals: rows() }));
  const runApprovalResolve =
    opts.runApprovalResolve
    ?? vi.fn(async (args) => ({
      approval_id: args.approval_id,
      accepted: true as const,
    }));
  const runApprovalSubscribe =
    opts.runApprovalSubscribe
    ?? vi.fn(async () => ({ approvals: rows(), seq: 1 }));
  const runPendingAsksList =
    opts.runPendingAsksList ?? vi.fn(async () => ({ asks: asks() }));
  const runPendingAskSubmitAnswer =
    opts.runPendingAskSubmitAnswer
    ?? vi.fn(async () => ({ ok: true as const }));
  const approvalChanged = makeFakeApprovalChanged();
  const sub = makeFakeSubscriber();
  const handle = mountApprovalAttentionPopover({
    host: root as unknown as HTMLElement,
    document: doc as unknown as Document,
    runApprovalList,
    runApprovalResolve,
    runApprovalSubscribe,
    runPendingAsksList,
    runPendingAskSubmitAnswer,
    onApprovalChanged: approvalChanged.on,
    subscribe: sub.on,
    ...(opts.chatPlans ? { chatPlans: opts.chatPlans } : {}),
    ...(opts.runChatPlanResolve
      ? { runChatPlanResolve: opts.runChatPlanResolve }
      : {}),
    ...(opts.reconnect ? { reconnect: opts.reconnect.subscribe } : {}),
  });
  const topbar = firstByAttr(root, ATTENTION_TOPBAR_HOST_ATTR);
  if (topbar === undefined) throw new Error('topbar not mounted');
  return {
    doc,
    root,
    topbar,
    handle,
    runApprovalList,
    runApprovalResolve,
    runApprovalSubscribe,
    runPendingAsksList,
    runPendingAskSubmitAnswer,
    approvalChanged,
    sub,
  };
};

describe('D-174 - approval attention top-bar adapter', () => {
  it('mounts the shared slot, badge, popover, and #approvals see-all link', async () => {
    const rows = [approval('ap-1'), approval('ap-2')];
    const { doc, topbar, handle, runApprovalList, runApprovalSubscribe } =
      mountFor({ rows: () => rows });
    await handle.whenLoaded();

    expect(runApprovalList).toHaveBeenCalledTimes(1);
    expect(runApprovalSubscribe).toHaveBeenCalledTimes(1);
    expect(topbar.innerHTML).toContain('top-bar-attention-badge');
    expect(topbar.innerHTML).toContain('>2<');
    expect(doc.styleElements).toHaveLength(1);
    expect(doc.styleElements[0]!.attrs.has(ATTENTION_TOPBAR_STYLES_MARKER))
      .toBe(true);
    expect(doc.styleElements[0]!.textContent).toBe(ATTENTION_TOPBAR_STYLES);

    topbar.fireAction({ 'data-action': 'open-attention' });

    expect(handle.isOpen()).toBe(true);
    expect(topbar.innerHTML).toContain('attention-popover');
    expect(topbar.innerHTML).toContain('data-action="approval-decide-server"');
    expect(topbar.innerHTML).toContain(`href="#approvals" ${ATTENTION_SEE_ALL_LINK_ATTR}`);
    handle.dispose();
  });

  it('counts pending notification.pending_asks entries in the top-bar badge', async () => {
    const { topbar, handle, runPendingAsksList } = mountFor({
      rows: () => [],
      asks: () => [ask('gw-1')],
    });
    await handle.whenLoaded();

    expect(runPendingAsksList).toHaveBeenCalledTimes(1);
    expect(handle.getApprovals()).toEqual([]);
    expect(handle.getAsks().map((row) => row.ask_id)).toEqual(['gw-1']);
    expect(topbar.innerHTML).toContain('top-bar-attention-badge');
    expect(topbar.innerHTML).toContain('>1<');
    handle.dispose();
  });

  it('covers reception inbox awaiting_approval holds through notification.pending_asks gateway.preflight attention', async () => {
    const receptionInboxAsk = ask('gw-reception-inbox-preflight', {
      title: 'Reception inbox approval required',
      text: 'gateway.preflight ask for a reception inbox awaiting_approval hold',
    });
    const { topbar, handle, runPendingAsksList } = mountFor({
      rows: () => [],
      asks: () => [receptionInboxAsk],
    });
    await handle.whenLoaded();

    expect(runPendingAsksList).toHaveBeenCalledTimes(1);
    expect(handle.getApprovals()).toEqual([]);
    expect(handle.getAsks().map((row) => row.ask_id)).toEqual([
      'gw-reception-inbox-preflight',
    ]);
    expect(topbar.innerHTML).toContain('top-bar-attention-badge');
    expect(topbar.innerHTML).toContain('>1<');

    topbar.fireAction({ 'data-action': 'open-attention' });

    // R20 — ONE unified list, no per-kind section headers.
    expect(topbar.innerHTML).not.toContain('Gateway asks');
    expect(topbar.innerHTML).toContain('class="attention-list"');
    expect(topbar.innerHTML).toContain('Reception inbox approval required');
    expect(topbar.innerHTML).toContain(
      'gateway.preflight ask for a reception inbox awaiting_approval hold',
    );
    expect(topbar.innerHTML).toContain('gateway ask');
    expect(topbar.innerHTML).not.toContain('notification.pending_asks');
    expect(topbar.innerHTML).toContain(
      `${ATTENTION_GATEWAY_ASK_ROW_ATTR}="gw-reception-inbox-preflight"`,
    );
    handle.dispose();
  });

  it('renders pending notification.pending_asks entries in the popover list with gateway labels', async () => {
    const { topbar, handle } = mountFor({
      rows: () => [],
      asks: () => [
        ask('gw-1', {
          title: 'Review HubSpot write',
          text: 'Allow update to HubSpot contact?',
        }),
      ],
    });
    await handle.whenLoaded();

    topbar.fireAction({ 'data-action': 'open-attention' });

    // R20 — ONE unified list, no per-kind section headers.
    expect(topbar.innerHTML).not.toContain('Gateway asks');
    expect(topbar.innerHTML).toContain('class="attention-list"');
    expect(topbar.innerHTML).toContain('Review HubSpot write');
    expect(topbar.innerHTML).toContain('Allow update to HubSpot contact?');
    expect(topbar.innerHTML).toContain('gateway ask');
    expect(topbar.innerHTML).not.toContain('notification.pending_asks');
    expect(topbar.innerHTML).toContain(
      `${ATTENTION_GATEWAY_ASK_ROW_ATTR}="gw-1"`,
    );
    expect(topbar.innerHTML).toContain('data-action="gateway-ask-answer"');
    expect(topbar.innerHTML).toContain(`href="#approvals" ${ATTENTION_SEE_ALL_LINK_ATTR}`);
    handle.dispose();
  });

  it('refreshes pending asks from notification.ask and notification.ask_closed broadcasts', async () => {
    let asks: ReadonlyArray<ServerPendingAsk> = [];
    const runPendingAsksList = vi.fn(async () => ({ asks }));
    const { topbar, handle, sub } = mountFor({
      rows: () => [],
      runPendingAsksList,
    });
    await handle.whenLoaded();
    expect(sub.count('notification.ask')).toBe(1);
    expect(sub.count('notification.ask_closed')).toBe(1);
    expect(topbar.innerHTML).not.toContain('top-bar-attention-badge');

    asks = [ask('gw-live')];
    sub.fire('notification.ask', {
      kind: 'notification.ask',
      ask_id: 'gw-live',
    });
    await tick();

    expect(runPendingAsksList).toHaveBeenCalledTimes(2);
    expect(topbar.innerHTML).toContain('top-bar-attention-badge');
    expect(topbar.innerHTML).toContain('>1<');
    topbar.fireAction({ 'data-action': 'open-attention' });
    expect(topbar.innerHTML).toContain(
      `${ATTENTION_GATEWAY_ASK_ROW_ATTR}="gw-live"`,
    );

    asks = [];
    sub.fire('notification.ask_closed', {
      kind: 'notification.ask_closed',
      ask_id: 'gw-live',
    });
    await tick();

    expect(runPendingAsksList).toHaveBeenCalledTimes(3);
    expect(topbar.innerHTML).not.toContain('top-bar-attention-badge');
    expect(topbar.innerHTML).toContain('All clear');
    handle.dispose();
  });

  it('answers a gateway ask through notification.submitAnswer and refreshes the union count', async () => {
    let asks: ReadonlyArray<ServerPendingAsk> = [ask('gw-submit')];
    const runPendingAsksList = vi.fn(async () => ({ asks }));
    const runPendingAskSubmitAnswer = vi.fn(async () => {
      asks = [];
      return { ok: true as const };
    });
    const { topbar, handle } = mountFor({
      rows: () => [],
      runPendingAsksList,
      runPendingAskSubmitAnswer,
    });
    await handle.whenLoaded();
    topbar.fireAction({ 'data-action': 'open-attention' });

    topbar.fireAction({
      'data-action': 'gateway-ask-answer',
      'data-ask-id': 'gw-submit',
      'data-option-id': 'approve',
    });
    await tick();

    expect(runPendingAskSubmitAnswer).toHaveBeenCalledTimes(1);
    expect(runPendingAskSubmitAnswer).toHaveBeenCalledWith({
      ask_id: 'gw-submit',
      option_id: 'approve',
    });
    expect(runPendingAsksList).toHaveBeenCalledTimes(2);
    expect(handle.getAsks()).toEqual([]);
    expect(topbar.innerHTML).not.toContain(
      `${ATTENTION_GATEWAY_ASK_ROW_ATTR}="gw-submit"`,
    );
    expect(topbar.innerHTML).not.toContain('top-bar-attention-badge');
    handle.dispose();
  });

  it('resolves an approval inline, removes it, and updates the badge count', async () => {
    let rows: ReadonlyArray<ServerPendingApproval> = [approval('ap-1')];
    const runApprovalResolve = vi.fn(async (args) => {
      rows = [];
      return { approval_id: args.approval_id, accepted: true as const };
    });
    const { topbar, handle } = mountFor({
      rows: () => rows,
      runApprovalResolve,
    });
    await handle.whenLoaded();
    topbar.fireAction({ 'data-action': 'open-attention' });

    topbar.fireAction({
      'data-action': 'approval-decide-server',
      'data-approval-id': 'ap-1',
      'data-decision': 'approve',
    });
    await tick();

    expect(runApprovalResolve).toHaveBeenCalledTimes(1);
    expect(runApprovalResolve).toHaveBeenCalledWith({
      approval_id: 'ap-1',
      decision: 'approve',
    });
    expect(handle.getApprovals()).toEqual([]);
    expect(topbar.innerHTML).not.toContain('data-approval-id="ap-1"');
    expect(topbar.innerHTML).not.toContain('top-bar-attention-badge');
    handle.dispose();
  });

  it('refreshes from approval.subscribe push events and the D-121 approval bus', async () => {
    let rows: ReadonlyArray<ServerPendingApproval> = [approval('ap-1')];
    const runApprovalList = vi.fn(async () => ({ approvals: rows }));
    const { topbar, handle, approvalChanged, sub } = mountFor({
      rows: () => rows,
      runApprovalList,
    });
    await handle.whenLoaded();
    topbar.fireAction({ 'data-action': 'open-attention' });
    expect(approvalChanged.count()).toBe(1);
    expect(sub.count('approval')).toBe(1);
    expect(sub.count('notification.ask')).toBe(1);
    expect(sub.count('notification.ask_closed')).toBe(1);

    rows = [approval('ap-2')];
    approvalChanged.fire(2, 1);
    await tick();
    expect(runApprovalList).toHaveBeenCalledTimes(2);
    expect(topbar.innerHTML).toContain('data-approval-id="ap-2"');

    rows = [];
    sub.fire('approval', {
      kind: 'approval',
      subkind: 'resolved',
      id: 'ap-2',
      cursor: 3,
    });
    await tick();
    expect(runApprovalList).toHaveBeenCalledTimes(3);
    expect(topbar.innerHTML).toContain('All clear');
    expect(topbar.innerHTML).not.toContain('top-bar-attention-badge');
    handle.dispose();
  });

  it('renders all-clear when opened with no pending approvals', async () => {
    const { topbar, handle } = mountFor({ rows: () => [] });
    await handle.whenLoaded();

    topbar.fireAction({ 'data-action': 'open-attention' });

    expect(topbar.innerHTML).toContain('All clear');
    expect(topbar.innerHTML).not.toContain('top-bar-attention-badge');
    handle.dispose();
  });

  it('removes the persistent host and unsubscribes on dispose', async () => {
    const { root, handle, approvalChanged, sub } = mountFor();
    await handle.whenLoaded();
    expect(root.childList).toHaveLength(2);

    handle.dispose();

    expect(root.childList).toHaveLength(0);
    expect(approvalChanged.unsubCount()).toBe(1);
    expect(sub.unsubCount()).toBe(3);
  });
});

describe('D-174 - attention popover: re-arms approval.subscribe on reconnect', () => {
  it('re-runs the subscription + refreshes the queues on a reconnect fire', async () => {
    const reconnect = makeFakeReconnect();
    const { handle, runApprovalSubscribe, runApprovalList } = mountFor({ reconnect });
    await handle.whenLoaded();
    const subsBefore = (runApprovalSubscribe as ReturnType<typeof vi.fn>).mock.calls.length;
    const listBefore = (runApprovalList as ReturnType<typeof vi.fn>).mock.calls.length;

    reconnect.fire(); // server back up
    await tick();

    expect((runApprovalSubscribe as ReturnType<typeof vi.fn>).mock.calls.length)
      .toBeGreaterThan(subsBefore);
    expect((runApprovalList as ReturnType<typeof vi.fn>).mock.calls.length)
      .toBeGreaterThan(listBefore);
    handle.dispose();
  });

  it('detaches the reconnect listener on dispose', async () => {
    const reconnect = makeFakeReconnect();
    const { handle } = mountFor({ reconnect });
    await handle.whenLoaded();
    expect(reconnect.listenerCount()).toBe(1);
    handle.dispose();
    expect(reconnect.listenerCount()).toBe(0);
    expect(() => reconnect.fire()).not.toThrow();
  });

  it('resets the seq baseline on reconnect so a restarted server\'s low-seq events are accepted', async () => {
    const reconnect = makeFakeReconnect();
    let subSeq = 42; // pre-restart high-water
    const runApprovalSubscribe = vi.fn(async () => ({ approvals: [], seq: subSeq }));
    const runApprovalList = vi.fn(async () => ({ approvals: [] }));
    const { handle, approvalChanged } = mountFor({
      runApprovalSubscribe,
      runApprovalList,
      reconnect,
    });
    await handle.whenLoaded();
    subSeq = 0; // server restarts → seq epoch resets
    reconnect.fire();
    await tick();
    const listBefore = runApprovalList.mock.calls.length;
    // Post-restart event at seq 1 must be ACCEPTED (baseline reset to 0), not
    // dropped as `1 <= 42` — otherwise the always-present badge stops updating.
    approvalChanged.fire(1, 0);
    await tick();
    expect(runApprovalList.mock.calls.length).toBeGreaterThan(listBefore);
    handle.dispose();
  });
});

describe('D-174 / R20 - bell popover: chat plans + destructive confirm', () => {
  const plan = (
    plan_id: string,
    over: Partial<PendingChatPlan> = {},
  ): PendingChatPlan => ({
    plan_id,
    session_id: 's1',
    turn_id: 't1',
    tool: 'mail-send',
    tier: 2,
    args: { to: 'a@b.com' },
    payload_available: true,
    proposed_at: 1_700_000_000_700,
    ...over,
  });

  const makeFakeChatPlans = (initial: PendingChatPlan[] = []) => {
    let plans: PendingChatPlan[] = [...initial];
    let resolution: PendingChatPlanResolution | null = null;
    const listeners = new Set<() => void>();
    const refresh = vi.fn(async (): Promise<void> => {});
    const notify = (): void => {
      for (const listener of [...listeners]) listener();
    };
    return {
      store: {
        list: (): ReadonlyArray<PendingChatPlan> => plans,
        latestResolution: (): PendingChatPlanResolution | null => resolution,
        recordResolution: (
          resolvedPlan: PendingChatPlan,
          decision: 'approve' | 'reject',
        ): void => {
          plans = plans.filter(
            (candidate) => candidate.plan_id !== resolvedPlan.plan_id,
          );
          resolution = {
            plan_id: resolvedPlan.plan_id,
            session_id: resolvedPlan.session_id,
            turn_id: resolvedPlan.turn_id,
            ...(resolvedPlan.message_id !== undefined
              ? { message_id: resolvedPlan.message_id }
              : {}),
            tool: resolvedPlan.tool,
            outcome: decision === 'approve' ? 'approved' : 'cancelled',
            resolved_at: 1_700_000_001_000,
          };
          notify();
        },
        dismissResolution: (planId: string): void => {
          if (resolution?.plan_id !== planId) return;
          resolution = null;
          notify();
        },
        refresh,
        subscribe: (listener: () => void): (() => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
      set: (next: PendingChatPlan[]): void => {
        plans = next;
        notify();
      },
      resolve: (
        planId: string,
        outcome: PendingChatPlanResolution['outcome'],
      ): void => {
        const resolvedPlan = plans.find(
          (candidate) => candidate.plan_id === planId,
        );
        if (resolvedPlan === undefined) return;
        plans = plans.filter((candidate) => candidate.plan_id !== planId);
        resolution = {
          plan_id: resolvedPlan.plan_id,
          session_id: resolvedPlan.session_id,
          turn_id: resolvedPlan.turn_id,
          ...(resolvedPlan.message_id !== undefined
            ? { message_id: resolvedPlan.message_id }
            : {}),
          tool: resolvedPlan.tool,
          outcome,
          resolved_at: 1_700_000_001_000,
        };
        notify();
      },
      refresh,
    };
  };

  it('renders chat-plan rows in the unified peek + resolves via runChatPlanResolve', async () => {
    const chatPlans = makeFakeChatPlans([
      plan('pl-1', { message_id: 'message-review' }),
    ]);
    const runChatPlanResolve = vi.fn(async () => ({ ok: true }));
    const { root, topbar, handle } = mountFor({
      rows: () => [],
      asks: () => [],
      chatPlans: chatPlans.store,
      runChatPlanResolve,
    });
    await handle.whenLoaded();
    topbar.fireAction({ 'data-action': 'open-attention' });

    expect(topbar.innerHTML).toContain('Run mail-send');
    expect(topbar.innerHTML).toContain('chat plan - tier 2');
    expect(topbar.innerHTML).toContain('data-action="chat-plan-decide"');

    topbar.fireAction({
      'data-action': 'chat-plan-decide',
      'data-plan-id': 'pl-1',
      'data-decision': 'approve',
    });
    await tick();
    expect(runChatPlanResolve).toHaveBeenCalledWith({
      plan_id: 'pl-1',
      decision: 'approve',
    });
    expect(topbar.innerHTML).not.toContain('data-action="chat-plan-decide"');
    expect(topbar.innerHTML).toContain(
      `${ATTENTION_CHAT_PLAN_RESOLUTION_ATTR}="pl-1"`,
    );
    expect(topbar.innerHTML).toContain('Approved mail-send');
    expect(topbar.innerHTML).toContain(
      'Approved once for these exact details. The action has not run.',
    );
    expect(topbar.innerHTML).toContain('Continue in Chat');
    expect(topbar.innerHTML).toContain(
      'href="#chat/session/s1/plan/pl-1/answer/message-review"',
    );
    expect(topbar.innerHTML).not.toContain('All clear');
    const announcer = firstByAttr(
      root,
      ATTENTION_CHAT_PLAN_RESOLUTION_ANNOUNCER_ATTR,
    )!;
    expect(announcer.getAttribute('role')).toBe('status');
    expect(announcer.getAttribute('aria-live')).toBe('polite');
    expect(announcer.textContent).toContain(
      'Approved once for these exact details. The action has not run.',
    );
    topbar.fireAction({ 'data-action': 'open-chat-plan' });
    await tick();
    expect(topbar.innerHTML).not.toContain('role="dialog"');
    handle.dispose();
  });

  it('announces a resolution only when its blocking-tab handoff is visible', async () => {
    const chatPlans = makeFakeChatPlans([
      plan('pl-tab', { message_id: 'message-tab' }),
    ]);
    const { root, topbar, handle } = mountFor({
      rows: () => [],
      asks: () => [],
      chatPlans: chatPlans.store,
      runChatPlanResolve: vi.fn(async () => ({ ok: true })),
    });
    await handle.whenLoaded();
    topbar.fireAction({ 'data-action': 'open-attention' });
    topbar.fireAction({
      'data-action': 'set-attention-tab',
      'data-attention-tab': 'notifications',
    });

    const announcer = firstByAttr(
      root,
      ATTENTION_CHAT_PLAN_RESOLUTION_ANNOUNCER_ATTR,
    )!;
    chatPlans.resolve('pl-tab', 'approved');
    expect(topbar.innerHTML).not.toContain(
      ATTENTION_CHAT_PLAN_RESOLUTION_ATTR,
    );
    expect(announcer.textContent).toBe('');

    topbar.fireAction({
      'data-action': 'set-attention-tab',
      'data-attention-tab': 'blocking',
    });
    expect(topbar.innerHTML).toContain(ATTENTION_CHAT_PLAN_RESOLUTION_ATTR);
    expect(announcer.textContent).toContain(
      'Approved once for these exact details. The action has not run.',
    );
    handle.dispose();
  });

  it('keeps an unverified-queue warning visible beside a resolution receipt', async () => {
    const resolution: PendingChatPlanResolution = {
      plan_id: 'pl-unverified',
      session_id: 's1',
      turn_id: 't1',
      message_id: 'message-unverified',
      tool: 'mail-send',
      outcome: 'approved',
      resolved_at: 1_700_000_001_000,
    };
    const chatPlans = {
      list: (): ReadonlyArray<PendingChatPlan> => [],
      latestResolution: (): PendingChatPlanResolution => resolution,
      state: () => ({
        phase: 'error' as const,
        error: new Error('snapshot unavailable'),
      }),
      subscribe: (): (() => void) => () => {},
    };
    const { topbar, handle } = mountFor({
      rows: () => [],
      asks: () => [],
      chatPlans,
    });
    await handle.whenLoaded();
    topbar.fireAction({ 'data-action': 'open-attention' });

    expect(topbar.innerHTML).toContain(ATTENTION_CHAT_PLAN_RESOLUTION_ATTR);
    expect(topbar.innerHTML).toContain(
      "Pending decisions couldn't be verified.",
    );
    handle.dispose();
  });

  it('labels a fresh retry approval as new permission after uncertainty', async () => {
    const chatPlans = makeFakeChatPlans([
      plan('pl-fresh', { retry_of_plan_id: 'pl-uncertain' }),
    ]);
    const { topbar, handle } = mountFor({
      rows: () => [],
      asks: () => [],
      chatPlans: chatPlans.store,
      runChatPlanResolve: vi.fn(async () => ({ ok: true })),
    });
    await handle.whenLoaded();
    topbar.fireAction({ 'data-action': 'open-attention' });

    expect(topbar.innerHTML).toContain('Fresh review: mail-send');
    expect(topbar.innerHTML).toContain(
      'new permission after uncertain outcome - tier 2',
    );
    expect(topbar.innerHTML).toContain(
      'Earlier permission was used; review this action again before approving.',
    );
    expect(topbar.innerHTML).toContain(
      'data-retry-of-plan-id="pl-uncertain"',
    );

    handle.dispose();
  });

  it('links recovered plans to Chat and withholds approval without exact details', async () => {
    const chatPlans = makeFakeChatPlans([
      plan('pl-unavailable', {
        message_id: 'message-review',
        args: null,
        payload_available: false,
      }),
    ]);
    const runChatPlanResolve = vi.fn(async () => ({ ok: true }));
    const { topbar, handle } = mountFor({
      rows: () => [],
      asks: () => [],
      chatPlans: chatPlans.store,
      runChatPlanResolve,
    });
    await handle.whenLoaded();
    topbar.fireAction({ 'data-action': 'open-attention' });

    expect(topbar.innerHTML).toContain(ATTENTION_CHAT_PLAN_LINK_ATTR);
    expect(topbar.innerHTML).toContain(
      'href="#chat/session/s1/plan/pl-unavailable/answer/message-review"',
    );
    expect(topbar.innerHTML).toContain(
      'Exact reviewed details are unavailable after recovery.',
    );
    expect(topbar.innerHTML).toMatch(
      /data-decision="approve"\s+data-plan-id="pl-unavailable" disabled/,
    );
    expect(topbar.innerHTML).not.toMatch(
      /data-decision="reject"\s+data-plan-id="pl-unavailable" disabled/,
    );

    topbar.fireAction({
      'data-action': 'chat-plan-decide',
      'data-plan-id': 'pl-unavailable',
      'data-decision': 'approve',
    });
    await tick();
    expect(runChatPlanResolve).not.toHaveBeenCalled();
    topbar.fireAction({
      'data-action': 'chat-plan-decide',
      'data-plan-id': 'pl-unavailable',
      'data-decision': 'reject',
    });
    await tick();
    expect(runChatPlanResolve).toHaveBeenCalledWith({
      plan_id: 'pl-unavailable',
      decision: 'reject',
    });
    handle.dispose();
  });

  it('replaces a stale error with the paired-device resolution handoff', async () => {
    const chatPlans = makeFakeChatPlans([
      plan('pl-remote-resolve', { message_id: 'message-remote' }),
    ]);
    const { topbar, handle } = mountFor({
      rows: () => [],
      asks: () => [],
      chatPlans: chatPlans.store,
      runChatPlanResolve: vi.fn(async () => {
        throw new Error('temporary resolve failure');
      }),
    });
    await handle.whenLoaded();
    topbar.fireAction({ 'data-action': 'open-attention' });
    chatPlans.refresh.mockClear();
    topbar.fireAction({
      'data-action': 'chat-plan-decide',
      'data-plan-id': 'pl-remote-resolve',
      'data-decision': 'reject',
    });
    await tick();
    expect(topbar.innerHTML).toContain('temporary resolve failure');
    expect(chatPlans.refresh).toHaveBeenCalledTimes(1);

    // Production equivalent: chat.plan_resolved arrives from another paired
    // client and the shared store removes the row + retains its outcome.
    chatPlans.resolve('pl-remote-resolve', 'cancelled');
    expect(topbar.innerHTML).not.toContain('temporary resolve failure');
    expect(topbar.innerHTML).toContain('Rejected mail-send');
    expect(topbar.innerHTML).toContain(
      'The action will not run. Return to Chat if you want to adjust the request.',
    );
    expect(topbar.innerHTML).toContain(
      'href="#chat/session/s1/plan/pl-remote-resolve/answer/message-remote"',
    );
    expect(topbar.innerHTML).not.toContain('All clear');

    topbar.fireAction({
      'data-action': 'dismiss-chat-plan-resolution',
      'data-plan-id': 'pl-remote-resolve',
    });
    expect(topbar.innerHTML).not.toContain(ATTENTION_CHAT_PLAN_RESOLUTION_ATTR);
    expect(topbar.innerHTML).toContain('All clear');
    handle.dispose();
  });

  it('removes the resolved row immediately after a successful authoritative rpc', async () => {
    const chatPlans = makeFakeChatPlans([plan('pl-1')]);
    const runChatPlanResolve = vi.fn(async () => ({ ok: true }));
    const { topbar, handle } = mountFor({
      rows: () => [],
      asks: () => [],
      chatPlans: chatPlans.store,
      runChatPlanResolve,
    });
    await handle.whenLoaded();
    topbar.fireAction({ 'data-action': 'open-attention' });

    topbar.fireAction({
      'data-action': 'chat-plan-decide',
      'data-plan-id': 'pl-1',
      'data-decision': 'approve',
    });
    await tick();
    expect(runChatPlanResolve).toHaveBeenCalledTimes(1);
    expect(topbar.innerHTML).not.toContain('chat-plan-decide');
    expect(topbar.innerHTML).toContain(ATTENTION_CHAT_PLAN_RESOLUTION_ATTR);
    handle.dispose();
  });

  it('re-renders the peek when the chat-plan store changes', async () => {
    const chatPlans = makeFakeChatPlans([]);
    const { topbar, handle } = mountFor({
      rows: () => [],
      asks: () => [],
      chatPlans: chatPlans.store,
      runChatPlanResolve: vi.fn(async () => ({ ok: true })),
    });
    await handle.whenLoaded();
    topbar.fireAction({ 'data-action': 'open-attention' });
    expect(topbar.innerHTML).not.toContain('chat-plan-decide');

    chatPlans.set([plan('pl-2')]);
    expect(topbar.innerHTML).toContain('data-action="chat-plan-decide"');
    expect(topbar.innerHTML).toContain('Run mail-send');
    handle.dispose();
  });

  it('destructive gate: Approve arms an inline Confirm (no resolve), then Confirm resolves', async () => {
    const runApprovalResolve = vi.fn(async (args: { approval_id: string }) => ({
      approval_id: args.approval_id,
      accepted: true as const,
    }));
    const { topbar, handle } = mountFor({
      rows: () => [approval('d1', { risk_tier: 'destructive' })],
      asks: () => [],
      runApprovalResolve,
    });
    await handle.whenLoaded();
    topbar.fireAction({ 'data-action': 'open-attention' });

    // Unarmed: an arm action, no inline Confirm yet.
    expect(topbar.innerHTML).toContain('data-action="approval-arm"');
    expect(topbar.innerHTML).not.toContain('Confirm');

    topbar.fireAction({ 'data-action': 'approval-arm', 'data-approval-id': 'd1' });
    expect(runApprovalResolve).not.toHaveBeenCalled();
    expect(topbar.innerHTML).toContain('Confirm');
    expect(topbar.innerHTML).toContain('cannot be undone');
    expect(topbar.innerHTML).toContain('data-action="approval-disarm"');

    // Confirm routes through approval-decide-server with decision=approve.
    topbar.fireAction({
      'data-action': 'approval-decide-server',
      'data-approval-id': 'd1',
      'data-decision': 'approve',
    });
    await tick();
    expect(runApprovalResolve).toHaveBeenCalledWith({
      approval_id: 'd1',
      decision: 'approve',
    });
    handle.dispose();
  });

  it('destructive gate: Cancel disarms back to Approve (no resolve)', async () => {
    const runApprovalResolve = vi.fn(async (args: { approval_id: string }) => ({
      approval_id: args.approval_id,
      accepted: true as const,
    }));
    const { topbar, handle } = mountFor({
      rows: () => [approval('d1', { risk_tier: 'destructive' })],
      asks: () => [],
      runApprovalResolve,
    });
    await handle.whenLoaded();
    topbar.fireAction({ 'data-action': 'open-attention' });
    topbar.fireAction({ 'data-action': 'approval-arm', 'data-approval-id': 'd1' });
    expect(topbar.innerHTML).toContain('data-action="approval-disarm"');

    topbar.fireAction({ 'data-action': 'approval-disarm', 'data-approval-id': 'd1' });
    expect(topbar.innerHTML).not.toContain('data-action="approval-disarm"');
    expect(topbar.innerHTML).toContain('data-action="approval-arm"');
    expect(runApprovalResolve).not.toHaveBeenCalled();
    handle.dispose();
  });
});
