/** D-169 P2 — top-level Approvals route acceptance.
 *
 *  `bootstrapApprovalsRoute` promotes the D-158 ask surface out of a
 *  Settings section into a first-class `#approvals` route. The panel
 *  itself (`asks-panel.ts`) already has its own unit tests
 *  (`d-169-slice-3b-asks-panel.test.ts`); THIS file covers the ROUTE
 *  shell: the chrome (heading + sibling-route nav), marker-guarded
 *  one-shot style injection, that it re-hosts the SAME placement-agnostic
 *  asks mount (seed load + the shared approval card + submit + live
 *  subscription all reach the panel), the document seam, and dispose.
 *
 *  The panel renders real `HTMLElement` cards with click handlers and
 *  rebuilds via `clearChildren` (`while (firstChild) removeChild`), so —
 *  like the panel's own test — this uses an interactive fake document,
 *  extended (like the reception-bootstrap test) with a `head` that tracks
 *  injected `<style>` tags. The webclient ships no jsdom in vitest. */

import { describe, expect, it, vi } from 'vitest';

import {
  bootstrapApprovalsRoute,
  APPROVALS_ROUTE_HEADING_ATTR,
  APPROVALS_ROUTE_HOST_ATTR,
  APPROVALS_ROUTE_LIST_ATTR,
  APPROVALS_ROUTE_FOCUS_ATTR,
  APPROVALS_ROUTE_EMPTY_ATTR,
  APPROVALS_ROUTE_ERROR_ATTR,
  APPROVALS_ROUTE_PLAN_RESOLUTION_ATTR,
  APPROVALS_ROUTE_PLAN_RESOLUTION_ANNOUNCER_ATTR,
  APPROVALS_ROUTE_PLAN_RESOLUTION_DISMISS_ATTR,
  APPROVALS_ROUTE_PLAN_RESOLUTION_LINK_ATTR,
  APPROVALS_ROUTE_SUMMARY_ATTR,
  APPROVALS_ROUTE_STYLES,
  APPROVALS_ROUTE_STYLES_MARKER,
  type ApprovalChangedSubscriber,
  type ApprovalListCaller,
  type ApprovalResolveCaller,
  type ApprovalsPairListCaller,
  type ApprovalsRecipeNamesCaller,
  type ApprovalSubscribeCaller,
} from '../approvals/bootstrap-approvals-route.js';
import type { WebclientReconnectSubscriber } from '../realtime/connection-status.js';
import {
  ASK_CARD_ATTR,
  ASK_CARD_OPTION_ATTR,
  APPROVAL_CARD_ACTION_ATTR,
  APPROVAL_CARD_ATTR,
  APPROVAL_CARD_CAUTION_ATTR,
  APPROVAL_CARD_LINK_ATTR,
  APPROVAL_CARD_STYLES,
  CHAT_PLAN_CARD_ATTR,
  CHAT_PLAN_CARD_ACTION_ATTR,
  CHAT_PLAN_CARD_CHAT_LINK_ATTR,
  CHAT_PLAN_CARD_RETRY_NOTICE_ATTR,
  CHAT_PLAN_CARD_UNAVAILABLE_NOTICE_ATTR,
} from '@recued/ui-shared/approval-card';
import { ASKS_PANEL_STYLES } from '../approvals/asks-panel.js';
import type { AsksListCaller, AsksSubmitAnswerCaller } from '../approvals/asks-panel.js';
import type {
  PendingChatPlan,
  PendingChatPlanResolution,
} from '../approvals/pending-chat-plans-store.js';
import { PRIMITIVE_STYLES } from '@recued/ui-shared/primitives';
import type { ServerPendingApproval, ServerPendingAsk } from '@recued/contracts';
import { RpcError } from '@recued/contracts';
import type { BroadcastSubscriber } from '../realtime/subscriber.js';

// ════════════════════════════════════════════════════════════════
// Interactive fake DOM (asks-panel pattern) + a head that tracks
// injected <style> tags (reception-bootstrap pattern).
// ════════════════════════════════════════════════════════════════

interface FakeEl {
  tagName: string;
  className: string;
  textContent: string;
  type: string;
  disabled: boolean;
  hidden: boolean;
  focused: boolean;
  attrs: Map<string, string>;
  children: FakeEl[];
  listeners: Map<string, Array<() => void>>;
  readonly firstChild: FakeEl | null;
  setAttribute(k: string, v: string): void;
  getAttribute(k: string): string | null;
  appendChild(c: FakeEl): FakeEl;
  removeChild(c: FakeEl): FakeEl;
  addEventListener(type: string, fn: () => void): void;
  focus(): void;
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
    hidden: false,
    focused: false,
    attrs: new Map(),
    children: [],
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
      el.children.push(c);
      return c;
    },
    removeChild(c) {
      const i = el.children.indexOf(c);
      if (i >= 0) el.children.splice(i, 1);
      return c;
    },
    addEventListener(type, fn) {
      const list = el.listeners.get(type) ?? [];
      list.push(fn);
      el.listeners.set(type, list);
    },
    focus() {
      el.focused = true;
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
  // The route's selector is `style[<attr-name>]`. Parse it minimally.
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
  for (const c of root.children) collectByAttr(c, attr, out);
  return out;
};
const firstByAttr = (root: FakeEl, attr: string): FakeEl | undefined =>
  collectByAttr(root, attr)[0];
const optionButton = (root: FakeEl, optionId: string): FakeEl | undefined =>
  collectByAttr(root, ASK_CARD_OPTION_ATTR).find(
    (b) => b.getAttribute(ASK_CARD_OPTION_ATTR) === optionId,
  );
const approvalAction = (root: FakeEl, decision: string): FakeEl | undefined =>
  collectByAttr(root, APPROVAL_CARD_ACTION_ATTR).find(
    (b) => b.getAttribute(APPROVAL_CARD_ACTION_ATTR) === decision,
  );

// ════════════════════════════════════════════════════════════════
// Fake broadcast subscriber + ask factory
// ════════════════════════════════════════════════════════════════

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
    on: on as unknown as BroadcastSubscriber['on'],
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
    fire: (seq: number, pending_count = 0): void => {
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

const ask = (id: string, over: Partial<ServerPendingAsk> = {}): ServerPendingAsk => ({
  ask_id: id,
  title: `Approval ${id}`,
  text: `Approve ${id}?`,
  options: [
    { id: 'yes', label: 'Yes' },
    { id: 'no', label: 'No' },
  ],
  created_at: 1_000,
  ...over,
});

const approval = (
  id: string,
  over: Partial<ServerPendingApproval> = {},
): ServerPendingApproval => ({
  approval_id: id,
  recipe_id: `recipe-${id}`,
  step_id: `step-${id}`,
  ingredient_slug: 'mail-send',
  risk_tier: 'write',
  description: `Send follow-up ${id}`,
  resolved_input: { to: `${id}@example.com`, subject: 'Follow up' },
  created_at: 1_700_000_000_000,
  timeout_at: 1_700_000_300_000,
  initiator_instance: 'laptop',
  ...over,
});

const tick = async (n = 6): Promise<void> => {
  for (let i = 0; i < n; i += 1) await Promise.resolve();
};

const mountFor = (
  opts: {
    runApprovalList?: ApprovalListCaller;
    runApprovalResolve?: ApprovalResolveCaller;
    runApprovalSubscribe?: ApprovalSubscribeCaller;
    runList?: AsksListCaller;
    runSubmitAnswer?: AsksSubmitAnswerCaller;
    recipeNamesCaller?: ApprovalsRecipeNamesCaller;
    pairListCaller?: ApprovalsPairListCaller;
    chatPlans?: {
      list(): ReadonlyArray<PendingChatPlan>;
      subscribe(listener: () => void): () => void;
    };
    runChatPlanResolve?: (args: {
      plan_id: string;
      decision: 'approve' | 'reject';
    }) => Promise<unknown>;
    withApprovalChanged?: boolean;
    withSubscriber?: boolean;
    reconnect?: ReturnType<typeof makeFakeReconnect>;
    initialFocusId?: string;
    doc?: FakeDoc;
  } = {},
) => {
  const doc = opts.doc ?? makeFakeDocument();
  const root = doc.createElement('div');
  const runApprovalList =
    opts.runApprovalList ?? vi.fn(async () => ({ approvals: [approval('ap-1')] }));
  const runApprovalResolve =
    opts.runApprovalResolve
    ?? vi.fn(async (args) => ({
      approval_id: args.approval_id,
      accepted: true,
    }));
  const runApprovalSubscribe =
    opts.runApprovalSubscribe
    ?? vi.fn(async () => ({ approvals: [approval('ap-1')], seq: 1 }));
  const approvalChanged =
    opts.withApprovalChanged === false ? undefined : makeFakeApprovalChanged();
  const runList = opts.runList ?? vi.fn(async () => ({ asks: [ask('a1'), ask('a2')] }));
  const runSubmitAnswer =
    opts.runSubmitAnswer ?? vi.fn(async () => ({ ok: true as const }));
  const sub = opts.withSubscriber === false ? undefined : makeFakeSubscriber();
  const route = bootstrapApprovalsRoute({
    root: root as unknown as HTMLElement,
    document: doc as unknown as Document,
    runApprovalList,
    runApprovalResolve,
    runApprovalSubscribe,
    ...(approvalChanged ? { onApprovalChanged: approvalChanged.on } : {}),
    runList,
    runSubmitAnswer,
    ...(sub ? { subscribe: sub.on } : {}),
    ...(opts.reconnect ? { reconnect: opts.reconnect.subscribe } : {}),
    ...(opts.recipeNamesCaller ? { recipeNamesCaller: opts.recipeNamesCaller } : {}),
    ...(opts.pairListCaller ? { pairListCaller: opts.pairListCaller } : {}),
    ...(opts.chatPlans ? { chatPlans: opts.chatPlans } : {}),
    ...(opts.runChatPlanResolve
      ? { runChatPlanResolve: opts.runChatPlanResolve }
      : {}),
    ...(opts.initialFocusId !== undefined
      ? { initialFocusId: opts.initialFocusId }
      : {}),
    now: () => 1_700_000_100_000,
  });
  return {
    doc,
    root,
    route,
    runApprovalList,
    runApprovalResolve,
    runApprovalSubscribe,
    approvalChanged,
    runList,
    runSubmitAnswer,
    sub,
  };
};

// ════════════════════════════════════════════════════════════════
// Chrome
// ════════════════════════════════════════════════════════════════

describe('D-169 P2 — bootstrapApprovalsRoute: chrome', () => {
  it('appends one route shell to root with the heading', () => {
    const { root, route } = mountFor();

    expect(root.children).toHaveLength(1);
    const shell = root.children[0]!;
    expect(shell.attrs.has(APPROVALS_ROUTE_HOST_ATTR)).toBe(true);

    const heading = firstByAttr(shell, APPROVALS_ROUTE_HEADING_ATTR);
    expect(heading?.textContent).toBe('Approvals');

    route.dispose();
  });
});

// ════════════════════════════════════════════════════════════════
// Re-hosts the placement-agnostic asks mount
// ════════════════════════════════════════════════════════════════

describe('D-169 P2 — bootstrapApprovalsRoute: re-hosts the asks panel', () => {
  it('mounts the asks panel + renders each ask via the SHARED approval card', async () => {
    const runList = vi.fn(async () => ({ asks: [ask('a1'), ask('a2')] }));
    const { root, route } = mountFor({ runList });
    await route.asksPanel().whenLoaded();

    // R20 — the asks panel runs HEADLESS (its host is detached); the route
    // renders the ask cards itself into the ONE unified list.
    expect(collectByAttr(root, APPROVALS_ROUTE_LIST_ATTR)).toHaveLength(1);
    expect(runList).toHaveBeenCalledTimes(1);
    expect(route.asksPanel().getState()).toBe('ready');
    // Same shared card the bridge + the old Settings section render.
    const cards = collectByAttr(root, ASK_CARD_ATTR);
    expect(cards.map((c) => c.getAttribute(ASK_CARD_ATTR))).toEqual(['a1', 'a2']);

    route.dispose();
  });

  it('routes a card-option click through runSubmitAnswer', async () => {
    const runSubmitAnswer = vi.fn(async () => ({ ok: true as const }));
    const { root, route } = mountFor({
      runList: vi.fn(async () => ({ asks: [ask('a1')] })),
      runSubmitAnswer,
    });
    await route.asksPanel().whenLoaded();

    optionButton(root, 'yes')!.click();
    await tick();

    expect(runSubmitAnswer).toHaveBeenCalledTimes(1);
    expect(runSubmitAnswer).toHaveBeenCalledWith({ ask_id: 'a1', option_id: 'yes' });

    route.dispose();
  });

  it('forwards the subscribe seam — a notification.ask bus frame re-fetches the list', async () => {
    const runList = vi.fn(async () => ({ asks: [ask('a1')] }));
    const { route, sub } = mountFor({ runList });
    await route.asksPanel().whenLoaded();
    expect(runList).toHaveBeenCalledTimes(1);
    // The panel subscribed to both ask kinds through the route's seam.
    expect(sub!.count('notification.ask')).toBe(1);
    expect(sub!.count('notification.ask_closed')).toBe(1);

    sub!.fire('notification.ask');
    await tick();
    expect(runList).toHaveBeenCalledTimes(2);

    route.dispose();
  });
});

// ════════════════════════════════════════════════════════════════
// D-174 deep queue
// ════════════════════════════════════════════════════════════════

describe('D-174 — bootstrapApprovalsRoute: deep queue', () => {
  it('renders approval.list rows via the shared approval card with recipe / connection / runs links', async () => {
    const runApprovalList = vi.fn(async () => ({
      approvals: [approval('ap-1'), approval('ap-2')],
    }));
    const runApprovalSubscribe = vi.fn(async () => ({ approvals: [], seq: 1 }));
    const { root, route } = mountFor({
      runApprovalList,
      runApprovalSubscribe,
      runList: vi.fn(async () => ({ asks: [] })),
    });
    await route.whenLoaded();

    expect(runApprovalList).toHaveBeenCalledTimes(1);
    expect(runApprovalSubscribe).toHaveBeenCalledTimes(1);
    expect(route.getApprovals().map((row) => row.approval_id)).toEqual([
      'ap-1',
      'ap-2',
    ]);
    expect(
      collectByAttr(root, APPROVAL_CARD_ATTR).map((card) =>
        card.getAttribute(APPROVAL_CARD_ATTR),
      ),
    ).toEqual(['ap-1', 'ap-2']);
    const firstCard = collectByAttr(root, APPROVAL_CARD_ATTR)[0]!;
    const links = collectByAttr(firstCard, APPROVAL_CARD_LINK_ATTR);
    expect(links.map((link) => link.getAttribute(APPROVAL_CARD_LINK_ATTR))).toEqual([
      'recipe',
      'connection',
      'run',
    ]);
    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      '#recipes/recipe-ap-1',
      '#connections',
      '#logs',
    ]);
    expect(collectByAttr(root, APPROVALS_ROUTE_LIST_ATTR)).toHaveLength(1);

    route.dispose();
  });

  it('R17 — focuses + highlights the run-scoped deep-link card; others stay plain', async () => {
    const { root, route } = mountFor({
      runApprovalList: vi.fn(async () => ({
        approvals: [approval('ap-1'), approval('ap-2')],
      })),
      runApprovalSubscribe: vi.fn(async () => ({ approvals: [], seq: 1 })),
      runList: vi.fn(async () => ({ asks: [] })),
      initialFocusId: 'ap-2',
    });
    await route.whenLoaded();

    // Every card carries the uniform focus hook (its row id); only the matching
    // one is highlighted with data-focused.
    const focusCards = collectByAttr(root, APPROVALS_ROUTE_FOCUS_ATTR);
    expect(focusCards).toHaveLength(2);
    const focused = focusCards.filter(
      (c) => c.getAttribute('data-focused') === 'true',
    );
    expect(focused).toHaveLength(1);
    expect(focused[0]!.getAttribute(APPROVALS_ROUTE_FOCUS_ATTR)).toBe('ap-2');
    const plain = focusCards.filter(
      (c) => c.getAttribute('data-focused') !== 'true',
    );
    expect(plain.map((c) => c.getAttribute(APPROVALS_ROUTE_FOCUS_ATTR))).toEqual([
      'ap-1',
    ]);

    route.dispose();
  });

  it('R17 — an unmatched / already-resolved focus id degrades to the plain queue', async () => {
    const { root, route } = mountFor({
      runApprovalList: vi.fn(async () => ({ approvals: [approval('ap-1')] })),
      runApprovalSubscribe: vi.fn(async () => ({ approvals: [], seq: 1 })),
      runList: vi.fn(async () => ({ asks: [] })),
      initialFocusId: 'gone-9',
    });
    await route.whenLoaded();

    const focusCards = collectByAttr(root, APPROVALS_ROUTE_FOCUS_ATTR);
    expect(focusCards).toHaveLength(1);
    expect(
      focusCards.some((c) => c.getAttribute('data-focused') === 'true'),
    ).toBe(false);
    // The queue still rendered normally.
    expect(collectByAttr(root, APPROVALS_ROUTE_LIST_ATTR)).toHaveLength(1);

    route.dispose();
  });

  it('R17 — focuses an ASK card by ask_id (the real awaiting-run case is an ask)', async () => {
    const { root, route } = mountFor({
      runApprovalList: vi.fn(async () => ({ approvals: [] })),
      runApprovalSubscribe: vi.fn(async () => ({ approvals: [], seq: 1 })),
      runList: vi.fn(async () => ({ asks: [ask('a1'), ask('a2')] })),
      initialFocusId: 'a1',
    });
    await route.whenLoaded();

    // The focus hook + highlight are kind-agnostic — an awaiting run links to
    // its ask card by ask_id (#approvals/<ask_id>).
    const focused = collectByAttr(root, APPROVALS_ROUTE_FOCUS_ATTR).filter(
      (c) => c.getAttribute('data-focused') === 'true',
    );
    expect(focused).toHaveLength(1);
    expect(focused[0]!.getAttribute(APPROVALS_ROUTE_FOCUS_ATTR)).toBe('a1');

    route.dispose();
  });

  it('calls approval.resolve on approve and removes the item from the pending queue', async () => {
    let rows: ReadonlyArray<ServerPendingApproval> = [approval('ap-1')];
    const runApprovalList = vi.fn(async () => ({ approvals: rows }));
    const runApprovalResolve = vi.fn(async (args) => {
      rows = [];
      return { approval_id: args.approval_id, accepted: true as const };
    });
    const { root, route } = mountFor({
      runApprovalList,
      runApprovalResolve,
      runApprovalSubscribe: vi.fn(async () => ({ approvals: rows, seq: 1 })),
      runList: vi.fn(async () => ({ asks: [] })),
    });
    await route.whenLoaded();
    expect(collectByAttr(root, APPROVAL_CARD_ATTR)).toHaveLength(1);

    approvalAction(root, 'approve')!.click();
    await tick();

    expect(runApprovalResolve).toHaveBeenCalledTimes(1);
    expect(runApprovalResolve).toHaveBeenCalledWith({
      approval_id: 'ap-1',
      decision: 'approve',
    });
    expect(route.getApprovals()).toEqual([]);
    expect(collectByAttr(root, APPROVAL_CARD_ATTR)).toHaveLength(0);

    route.dispose();
  });

  it('resolves recipe_id → name + initiator → device in the card meta (#4)', async () => {
    const { root, route } = mountFor({
      runApprovalList: vi.fn(async () => ({ approvals: [approval('ap-1')] })),
      recipeNamesCaller: vi.fn(async () => ({
        recipes: [{ recipe_id: 'recipe-ap-1', name: 'Daily digest' }],
      })),
      pairListCaller: vi.fn(async () => ({
        devices: [{ instance_id: 'laptop', display_name: 'Chrome on macOS' }],
      })),
      runList: vi.fn(async () => ({ asks: [] })),
    });
    await route.whenLoaded();
    await tick(); // loadRecipeNames / loadDeviceLabels are fire-and-forget
    const card = collectByAttr(root, APPROVAL_CARD_ATTR)[0]!;
    const texts: string[] = [];
    const walk = (el: FakeEl): void => {
      if (el.textContent) texts.push(el.textContent);
      el.children.forEach(walk);
    };
    walk(card);
    const meta = texts.find((t) => t.includes('recipe ')) ?? '';
    expect(meta).toContain('recipe Daily digest');
    expect(meta).toContain('from Chrome on macOS');
    expect(meta).not.toContain('recipe-ap-1'); // raw id replaced by the name

    route.dispose();
  });

  it('refreshes approval.list from approval.subscribe push events and approval bus events', async () => {
    let rows: ReadonlyArray<ServerPendingApproval> = [approval('ap-1')];
    const runApprovalList = vi.fn(async () => ({ approvals: rows }));
    const { root, route, approvalChanged, sub } = mountFor({
      runApprovalList,
      runApprovalSubscribe: vi.fn(async () => ({ approvals: rows, seq: 1 })),
      runList: vi.fn(async () => ({ asks: [] })),
    });
    await route.whenLoaded();
    expect(approvalChanged!.count()).toBe(1);
    expect(sub!.count('approval')).toBe(1);

    rows = [approval('ap-2')];
    approvalChanged!.fire(2, 1);
    await tick();
    expect(runApprovalList).toHaveBeenCalledTimes(2);
    expect(
      collectByAttr(root, APPROVAL_CARD_ATTR).map((card) =>
        card.getAttribute(APPROVAL_CARD_ATTR),
      ),
    ).toEqual(['ap-2']);

    rows = [approval('ap-3')];
    sub!.fire('approval', { kind: 'approval', subkind: 'pending', id: 'ap-3', cursor: 3 });
    await tick();
    expect(runApprovalList).toHaveBeenCalledTimes(3);
    expect(
      collectByAttr(root, APPROVAL_CARD_ATTR).map((card) =>
        card.getAttribute(APPROVAL_CARD_ATTR),
      ),
    ).toEqual(['ap-3']);

    route.dispose();
  });

  it('renders one all-clear state when both approval gates and asks are empty', async () => {
    const { root, route } = mountFor({
      runApprovalList: vi.fn(async () => ({ approvals: [] })),
      runApprovalSubscribe: vi.fn(async () => ({ approvals: [], seq: 1 })),
      runList: vi.fn(async () => ({ asks: [] })),
    });
    await route.whenLoaded();

    expect(collectByAttr(root, APPROVAL_CARD_ATTR)).toHaveLength(0);
    expect(collectByAttr(root, ASK_CARD_ATTR)).toHaveLength(0);
    const empty = firstByAttr(root, APPROVALS_ROUTE_EMPTY_ATTR);
    expect(empty?.hidden).toBe(false);
    expect(empty?.textContent).toBe('All clear.');

    route.dispose();
  });

  it('does not claim the queue is empty when Chat approvals could not load', async () => {
    const chatPlans = {
      list: (): ReadonlyArray<PendingChatPlan> => [],
      state: () => ({
        phase: 'error' as const,
        error: new Error('snapshot unavailable'),
      }),
      subscribe: (): (() => void) => () => {},
    };
    const { root, route } = mountFor({
      runApprovalList: vi.fn(async () => ({ approvals: [] })),
      runApprovalSubscribe: vi.fn(async () => ({ approvals: [], seq: 1 })),
      runList: vi.fn(async () => ({ asks: [] })),
      chatPlans,
    });
    await route.whenLoaded();

    expect(firstByAttr(root, APPROVALS_ROUTE_SUMMARY_ATTR)?.textContent).toBe(
      "Pending decisions couldn't be verified.",
    );
    expect(firstByAttr(root, APPROVALS_ROUTE_EMPTY_ATTR)?.hidden).toBe(true);
    expect(firstByAttr(root, APPROVALS_ROUTE_ERROR_ATTR)?.textContent).toContain(
      'snapshot unavailable',
    );
    route.dispose();
  });

  it('R20 — merges gate + ask cards into ONE list, newest-first (no sections)', async () => {
    const { root, route } = mountFor({
      runApprovalList: vi.fn(async () => ({
        approvals: [
          approval('ap-old', { created_at: 100 }),
          approval('ap-new', { created_at: 400 }),
        ],
      })),
      runApprovalSubscribe: vi.fn(async () => ({ approvals: [], seq: 1 })),
      runList: vi.fn(async () => ({
        asks: [ask('a-old', { created_at: 200 }), ask('a-new', { created_at: 300 })],
      })),
    });
    await route.whenLoaded();
    await tick();

    const listEl = firstByAttr(root, APPROVALS_ROUTE_LIST_ATTR)!;
    // Walk the ONE list and record both card kinds in DOM order.
    const order: string[] = [];
    const walk = (el: FakeEl): void => {
      const gid = el.getAttribute(APPROVAL_CARD_ATTR);
      const aid = el.getAttribute(ASK_CARD_ATTR);
      if (gid !== null) order.push(gid);
      else if (aid !== null) order.push(aid);
      el.children.forEach(walk);
    };
    walk(listEl);
    // Newest-first by created_at, interleaved across kinds — gates + asks in
    // ONE list, not two sections.
    expect(order).toEqual(['ap-new', 'a-new', 'a-old', 'ap-old']);

    const summary = firstByAttr(root, APPROVALS_ROUTE_HEADING_ATTR);
    expect(summary?.textContent).toBe('Approvals');

    route.dispose();
  });
});

// ════════════════════════════════════════════════════════════════
// R20 — destructive gate two-step confirm
// ════════════════════════════════════════════════════════════════

describe('R20 — destructive gate confirm', () => {
  const destructive = (id: string): ServerPendingApproval =>
    approval(id, { risk_tier: 'destructive', description: `Delete ${id}` });

  // A resolve that clears the row (so the post-resolve refetch returns []),
  // mirroring the "removes the item from the pending queue" deep-queue test.
  const mountDestructive = () => {
    let rows: ReadonlyArray<ServerPendingApproval> = [destructive('d1')];
    const runApprovalResolve = vi.fn(
      async (args: { approval_id: string }) => {
        rows = rows.filter((r) => r.approval_id !== args.approval_id);
        return { approval_id: args.approval_id, accepted: true as const };
      },
    );
    return mountFor({
      runApprovalList: vi.fn(async () => ({ approvals: rows })),
      runApprovalSubscribe: vi.fn(async () => ({ approvals: rows, seq: 1 })),
      runApprovalResolve,
      runList: vi.fn(async () => ({ asks: [] })),
    });
  };

  it('arms on Approve (no resolve) then resolves on Confirm', async () => {
    const { root, route, runApprovalResolve } = mountDestructive();
    await route.whenLoaded();

    // Unarmed: an "arm" Approve button, no resolve "approve"/"confirm", no caution.
    expect(approvalAction(root, 'arm')).toBeDefined();
    expect(approvalAction(root, 'approve')).toBeUndefined();
    expect(approvalAction(root, 'confirm')).toBeUndefined();
    expect(firstByAttr(root, APPROVAL_CARD_CAUTION_ATTR)).toBeUndefined();

    // First Approve click ARMS — it does NOT resolve.
    approvalAction(root, 'arm')!.click();
    await tick();
    expect(runApprovalResolve).not.toHaveBeenCalled();
    expect(firstByAttr(root, APPROVAL_CARD_CAUTION_ATTR)).toBeDefined();
    expect(approvalAction(root, 'confirm')).toBeDefined();
    expect(approvalAction(root, 'cancel')).toBeDefined();
    expect(approvalAction(root, 'arm')).toBeUndefined();

    // Confirm resolves approve.
    approvalAction(root, 'confirm')!.click();
    await tick();
    expect(runApprovalResolve).toHaveBeenCalledTimes(1);
    expect(runApprovalResolve).toHaveBeenCalledWith({
      approval_id: 'd1',
      decision: 'approve',
    });
    expect(route.getApprovals()).toEqual([]);

    route.dispose();
  });

  it('Cancel disarms back to the unarmed Approve (no resolve fires)', async () => {
    const { root, route, runApprovalResolve } = mountDestructive();
    await route.whenLoaded();

    approvalAction(root, 'arm')!.click();
    await tick();
    expect(approvalAction(root, 'confirm')).toBeDefined();

    approvalAction(root, 'cancel')!.click();
    await tick();
    expect(approvalAction(root, 'arm')).toBeDefined();
    expect(approvalAction(root, 'confirm')).toBeUndefined();
    expect(firstByAttr(root, APPROVAL_CARD_CAUTION_ATTR)).toBeUndefined();
    expect(runApprovalResolve).not.toHaveBeenCalled();

    route.dispose();
  });

  it('Reject still resolves immediately on a destructive gate (no arm)', async () => {
    const { root, route, runApprovalResolve } = mountDestructive();
    await route.whenLoaded();

    approvalAction(root, 'reject')!.click();
    await tick();
    expect(runApprovalResolve).toHaveBeenCalledWith({
      approval_id: 'd1',
      decision: 'reject',
    });

    route.dispose();
  });

  it('a non-destructive gate keeps immediate Approve (no confirm step)', async () => {
    const runApprovalResolve = vi.fn(async (args: { approval_id: string }) => ({
      approval_id: args.approval_id,
      accepted: true as const,
    }));
    const { root, route } = mountFor({
      runApprovalList: vi.fn(async () => ({
        approvals: [approval('w1', { risk_tier: 'write' })],
      })),
      runApprovalSubscribe: vi.fn(async () => ({ approvals: [], seq: 1 })),
      runApprovalResolve,
      runList: vi.fn(async () => ({ asks: [] })),
    });
    await route.whenLoaded();

    expect(approvalAction(root, 'arm')).toBeUndefined();
    approvalAction(root, 'approve')!.click();
    await tick();
    expect(runApprovalResolve).toHaveBeenCalledWith({
      approval_id: 'w1',
      decision: 'approve',
    });

    route.dispose();
  });
});

// ════════════════════════════════════════════════════════════════
// R20 — chat plan-approvals pulled into the unified list (Option A)
// ════════════════════════════════════════════════════════════════

describe('R20 — chat plan-approvals in #approvals', () => {
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
    proposed_at: 1_700_000_000_500,
    ...over,
  });

  // A fake bootstrap-scoped store: a mutable list + a `set` that fires the
  // route's change listener (production: the chat.plan_proposed/resolved bus).
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

  const chatPlanAction = (root: FakeEl, decision: string): FakeEl | undefined =>
    collectByAttr(root, CHAT_PLAN_CARD_ACTION_ATTR).find(
      (b) => b.getAttribute(CHAT_PLAN_CARD_ACTION_ATTR) === decision,
    );

  // The action button within a SPECIFIC plan card (when several are rendered).
  const planCardAction = (
    root: FakeEl,
    planId: string,
    decision: string,
  ): FakeEl | undefined => {
    const card = collectByAttr(root, CHAT_PLAN_CARD_ATTR).find(
      (c) => c.getAttribute(CHAT_PLAN_CARD_ATTR) === planId,
    );
    return card === undefined
      ? undefined
      : collectByAttr(card, CHAT_PLAN_CARD_ACTION_ATTR).find(
          (b) => b.getAttribute(CHAT_PLAN_CARD_ACTION_ATTR) === decision,
        );
  };

  const mountWithPlans = (
    chatPlans: ReturnType<typeof makeFakeChatPlans>,
    runChatPlanResolve = vi.fn(async () => ({ ok: true })),
  ) =>
    mountFor({
      runApprovalList: vi.fn(async () => ({ approvals: [] })),
      runApprovalSubscribe: vi.fn(async () => ({ approvals: [], seq: 1 })),
      runList: vi.fn(async () => ({ asks: [] })),
      chatPlans: chatPlans.store,
      runChatPlanResolve,
    });

  it('renders a chat-plan card for each pending plan', async () => {
    const chatPlans = makeFakeChatPlans([plan('pl-1'), plan('pl-2')]);
    const { root, route } = mountWithPlans(chatPlans);
    await route.whenLoaded();

    expect(
      collectByAttr(root, CHAT_PLAN_CARD_ATTR).map((c) =>
        c.getAttribute(CHAT_PLAN_CARD_ATTR),
      ),
    ).toEqual(['pl-1', 'pl-2']);

    route.dispose();
  });

  it('identifies a fresh retry approval as new permission, not execution', async () => {
    const chatPlans = makeFakeChatPlans([
      plan('pl-fresh', { retry_of_plan_id: 'pl-uncertain' }),
    ]);
    const { root, route } = mountWithPlans(chatPlans);
    await route.whenLoaded();

    const card = collectByAttr(root, CHAT_PLAN_CARD_ATTR)[0]!;
    expect(card.getAttribute('data-retry-of-plan-id')).toBe('pl-uncertain');
    const notice = collectByAttr(
      card,
      CHAT_PLAN_CARD_RETRY_NOTICE_ATTR,
    )[0]!;
    expect(notice.textContent).toContain(
      'approving this card grants new one-time permission but does not run it',
    );

    route.dispose();
  });

  it('keeps an unreadable recovered plan visible and rejectable, never approvable', async () => {
    const chatPlans = makeFakeChatPlans([
      plan('pl-unavailable', {
        message_id: 'message-review',
        args: null,
        payload_available: false,
      }),
    ]);
    const runChatPlanResolve = vi.fn(async () => ({ ok: true }));
    const { root, route } = mountWithPlans(chatPlans, runChatPlanResolve);
    await route.whenLoaded();

    const card = collectByAttr(root, CHAT_PLAN_CARD_ATTR)[0]!;
    expect(
      collectByAttr(card, CHAT_PLAN_CARD_UNAVAILABLE_NOTICE_ATTR)[0]
        ?.textContent,
    ).toContain('cannot be approved');
    const reviewLink = collectByAttr(
      card,
      CHAT_PLAN_CARD_CHAT_LINK_ATTR,
    )[0]!;
    expect(reviewLink.getAttribute('href')).toBe(
      '#chat/session/s1/plan/pl-unavailable/answer/message-review',
    );
    expect(planCardAction(root, 'pl-unavailable', 'approve')?.disabled).toBe(
      true,
    );
    expect(planCardAction(root, 'pl-unavailable', 'reject')?.disabled).toBe(
      false,
    );

    planCardAction(root, 'pl-unavailable', 'approve')!.click();
    await tick();
    expect(runChatPlanResolve).not.toHaveBeenCalled();
    planCardAction(root, 'pl-unavailable', 'reject')!.click();
    await tick();
    expect(runChatPlanResolve).toHaveBeenCalledWith({
      plan_id: 'pl-unavailable',
      decision: 'reject',
    });
    route.dispose();
  });

  it('Approve → chat.plan.approve, Reject → chat.plan.cancel (via runChatPlanResolve)', async () => {
    // Two plans so each verb hits a fresh pending card before its successful
    // decision is replaced by the ephemeral handoff receipt.
    const chatPlans = makeFakeChatPlans([plan('pl-a'), plan('pl-b')]);
    const runChatPlanResolve = vi.fn(async () => ({ ok: true }));
    const { root, route } = mountWithPlans(chatPlans, runChatPlanResolve);
    await route.whenLoaded();

    planCardAction(root, 'pl-a', 'approve')!.click();
    await tick();
    expect(runChatPlanResolve).toHaveBeenCalledWith({
      plan_id: 'pl-a',
      decision: 'approve',
    });

    planCardAction(root, 'pl-b', 'reject')!.click();
    await tick();
    expect(runChatPlanResolve).toHaveBeenCalledWith({
      plan_id: 'pl-b',
      decision: 'reject',
    });

    route.dispose();
  });

  it('replaces a successful approval with an exact Chat continuation receipt', async () => {
    const chatPlans = makeFakeChatPlans([
      plan('pl-1', { message_id: 'message-review' }),
    ]);
    const runChatPlanResolve = vi.fn(async () => ({ ok: true }));
    const { root, route } = mountWithPlans(chatPlans, runChatPlanResolve);
    await route.whenLoaded();

    chatPlanAction(root, 'approve')!.click();
    await tick();
    expect(runChatPlanResolve).toHaveBeenCalledTimes(1);
    expect(collectByAttr(root, CHAT_PLAN_CARD_ATTR)).toHaveLength(0);
    const receipt = firstByAttr(root, APPROVALS_ROUTE_PLAN_RESOLUTION_ATTR)!;
    expect(receipt.hidden).toBe(false);
    expect(receipt.getAttribute('data-outcome')).toBe('approved');
    expect(
      collectByAttr(receipt, APPROVALS_ROUTE_PLAN_RESOLUTION_LINK_ATTR)[0]
        ?.getAttribute('href'),
    ).toBe('#chat/session/s1/plan/pl-1/answer/message-review');
    expect(
      collectByAttr(receipt, APPROVALS_ROUTE_PLAN_RESOLUTION_LINK_ATTR)[0]
        ?.textContent,
    ).toBe('Continue in Chat');
    expect(
      collectByAttr(receipt, APPROVALS_ROUTE_PLAN_RESOLUTION_LINK_ATTR)[0]
        ?.focused,
    ).toBe(true);
    expect(firstByAttr(root, APPROVALS_ROUTE_EMPTY_ATTR)?.hidden).toBe(true);
    const announcer = firstByAttr(
      root,
      APPROVALS_ROUTE_PLAN_RESOLUTION_ANNOUNCER_ATTR,
    )!;
    expect(announcer.getAttribute('role')).toBe('status');
    expect(announcer.getAttribute('aria-live')).toBe('polite');
    expect(announcer.textContent).toContain(
      'Approved once for these exact details. The action has not run.',
    );

    firstByAttr(
      root,
      APPROVALS_ROUTE_PLAN_RESOLUTION_DISMISS_ATTR,
    )!.click();
    expect(receipt.hidden).toBe(true);
    expect(firstByAttr(root, APPROVALS_ROUTE_EMPTY_ATTR)?.hidden).toBe(false);
    const heading = firstByAttr(root, APPROVALS_ROUTE_HEADING_ATTR)!;
    expect(heading.getAttribute('tabindex')).toBe('-1');
    expect(heading.focused).toBe(true);

    route.dispose();
  });

  it('turns a paired-device rejection into a truthful receipt', async () => {
    const chatPlans = makeFakeChatPlans([
      plan('pl-remote', { message_id: 'message-remote' }),
    ]);
    const { root, route } = mountWithPlans(chatPlans);
    await route.whenLoaded();

    chatPlans.resolve('pl-remote', 'cancelled');

    expect(collectByAttr(root, CHAT_PLAN_CARD_ATTR)).toHaveLength(0);
    const receipt = firstByAttr(root, APPROVALS_ROUTE_PLAN_RESOLUTION_ATTR)!;
    expect(receipt.getAttribute('data-outcome')).toBe('cancelled');
    expect(
      collectByAttr(receipt, APPROVALS_ROUTE_PLAN_RESOLUTION_LINK_ATTR)[0]
        ?.textContent,
    ).toBe('Return to Chat');
    expect(
      collectByAttr(receipt, APPROVALS_ROUTE_PLAN_RESOLUTION_LINK_ATTR)[0]
        ?.getAttribute('href'),
    ).toBe('#chat/session/s1/plan/pl-remote/answer/message-remote');
    expect(firstByAttr(root, APPROVALS_ROUTE_EMPTY_ATTR)?.hidden).toBe(true);

    route.dispose();
  });

  it('reconciles after a stale resolve failure before leaving the card retryable', async () => {
    const chatPlans = makeFakeChatPlans([plan('pl-stale')]);
    const runChatPlanResolve = vi.fn(async () => {
      throw new Error('already resolved elsewhere');
    });
    const { root, route } = mountWithPlans(chatPlans, runChatPlanResolve);
    await route.whenLoaded();
    chatPlans.refresh.mockClear();

    chatPlanAction(root, 'approve')!.click();
    await tick();

    expect(chatPlans.refresh).toHaveBeenCalledTimes(1);
    expect(collectByAttr(root, CHAT_PLAN_CARD_ATTR)).toHaveLength(1);
    expect(
      collectByAttr(root, CHAT_PLAN_CARD_ACTION_ATTR).every(
        (action) => action.disabled === false,
      ),
    ).toBe(true);

    route.dispose();
  });

  it('re-renders when the store changes — a resolved plan drops its card', async () => {
    const chatPlans = makeFakeChatPlans([plan('pl-1')]);
    const { root, route } = mountWithPlans(chatPlans);
    await route.whenLoaded();
    expect(collectByAttr(root, CHAT_PLAN_CARD_ATTR)).toHaveLength(1);

    // Production: chat.plan_resolved drops it from the store. Here, `set`.
    chatPlans.set([]);
    expect(collectByAttr(root, CHAT_PLAN_CARD_ATTR)).toHaveLength(0);
    const empty = firstByAttr(root, APPROVALS_ROUTE_EMPTY_ATTR);
    expect(empty?.hidden).toBe(false);

    route.dispose();
  });

  it('interleaves plans with gates + asks newest-first in ONE list', async () => {
    const chatPlans = makeFakeChatPlans([plan('pl-mid', { proposed_at: 250 })]);
    const { root, route } = mountFor({
      runApprovalList: vi.fn(async () => ({
        approvals: [approval('ap-new', { created_at: 400 })],
      })),
      runApprovalSubscribe: vi.fn(async () => ({ approvals: [], seq: 1 })),
      runList: vi.fn(async () => ({ asks: [ask('a-old', { created_at: 100 })] })),
      chatPlans: chatPlans.store,
      runChatPlanResolve: vi.fn(async () => ({ ok: true })),
    });
    await route.whenLoaded();
    await tick();

    const listEl = firstByAttr(root, APPROVALS_ROUTE_LIST_ATTR)!;
    const order: string[] = [];
    const walk = (el: FakeEl): void => {
      const gid = el.getAttribute(APPROVAL_CARD_ATTR);
      const aid = el.getAttribute(ASK_CARD_ATTR);
      const pid = el.getAttribute(CHAT_PLAN_CARD_ATTR);
      if (gid !== null) order.push(gid);
      else if (aid !== null) order.push(aid);
      else if (pid !== null) order.push(pid);
      el.children.forEach(walk);
    };
    walk(listEl);
    // 400 (gate) · 250 (plan) · 100 (ask) — interleaved across all three kinds.
    expect(order).toEqual(['ap-new', 'pl-mid', 'a-old']);

    route.dispose();
  });
});

// ════════════════════════════════════════════════════════════════
// Style injection
// ════════════════════════════════════════════════════════════════

describe('D-169 P2 — bootstrapApprovalsRoute: style injection', () => {
  it('injects exactly one <style> tag carrying the payload + marker', () => {
    const { doc, route } = mountFor();
    expect(doc.styleElements).toHaveLength(1);
    const style = doc.styleElements[0]!;
    expect(style.tagName).toBe('STYLE');
    expect(style.attrs.has(APPROVALS_ROUTE_STYLES_MARKER)).toBe(true);
    expect(style.textContent).toBe(APPROVALS_ROUTE_STYLES);
    route.dispose();
  });

  it('is idempotent across two bootstraps on the same document', () => {
    const doc = makeFakeDocument();
    const a = mountFor({ doc });
    const b = mountFor({ doc });
    expect(doc.styleElements).toHaveLength(1);
    a.route.dispose();
    b.route.dispose();
  });

  it('bundles the route chrome + the shared ask-card / panel styles + primitives', () => {
    // Assert the actual constants are included (not a representative
    // selector another layer might also carry — e.g. `.rx-` appears in
    // both PRIMITIVE_STYLES and the ask card), so dropping either layer
    // from the bundle fails this test.
    expect(APPROVALS_ROUTE_STYLES).toContain(PRIMITIVE_STYLES);
    expect(APPROVALS_ROUTE_STYLES).toContain(ASKS_PANEL_STYLES);
    expect(APPROVALS_ROUTE_STYLES).toContain(APPROVAL_CARD_STYLES);
    expect(APPROVALS_ROUTE_STYLES).toContain(`[${APPROVALS_ROUTE_HOST_ATTR}]`);
  });
});

// ════════════════════════════════════════════════════════════════
// Dispose + document seam
// ════════════════════════════════════════════════════════════════

describe('D-169 P2 — bootstrapApprovalsRoute: dispose + seam', () => {
  it('detaches the route shell from root + unsubscribes on dispose', async () => {
    const { root, route, sub, approvalChanged } = mountFor();
    await route.asksPanel().whenLoaded();
    expect(root.children).toHaveLength(1);

    route.dispose();

    expect(root.children).toHaveLength(0);
    // Two ask-kind subscriptions + the approval-bus invalidation dropped.
    expect(sub!.unsubCount()).toBe(3);
    expect(approvalChanged!.unsubCount()).toBe(1);
  });

  it('keeps the injected <style> after dispose (global, may be shared)', () => {
    const { doc, route } = mountFor();
    expect(doc.styleElements).toHaveLength(1);
    route.dispose();
    expect(doc.styleElements).toHaveLength(1);
  });

  it('dispose is idempotent', () => {
    const { route } = mountFor();
    expect(() => {
      route.dispose();
      route.dispose();
      route.dispose();
    }).not.toThrow();
  });

  it('throws a clear error when no document is available', () => {
    // The vitest node env has no `document` global, so omitting the seam
    // reaches the runtime guard.
    expect(() =>
      bootstrapApprovalsRoute({
        root: makeFakeEl('div') as unknown as HTMLElement,
        runApprovalList: vi.fn(async () => ({ approvals: [] })),
        runApprovalResolve: vi.fn(async (args) => ({
          approval_id: args.approval_id,
          accepted: true,
        })),
        runApprovalSubscribe: vi.fn(async () => ({ approvals: [], seq: 1 })),
        runList: vi.fn(async () => ({ asks: [] })),
        runSubmitAnswer: vi.fn(async () => ({ ok: true as const })),
      }),
    ).toThrow(/no document available/);
  });
});

// ════════════════════════════════════════════════════════════════
// Reconnect re-subscribe (Slice 2)
// ════════════════════════════════════════════════════════════════

describe('bootstrapApprovalsRoute: re-arms approval.subscribe on reconnect', () => {
  it('re-runs the subscription on a reconnect fire and clears a stale liveError', async () => {
    const reconnect = makeFakeReconnect();
    let attempt = 0;
    const runApprovalSubscribe = vi.fn(async () => {
      attempt += 1;
      if (attempt === 1) throw new Error('server_offline'); // boot-time failure
      return { approvals: [approval('ap-1')], seq: 2 };
    });
    const { route } = mountFor({ runApprovalSubscribe, reconnect });
    await tick();
    expect(runApprovalSubscribe).toHaveBeenCalledTimes(1);
    // The failed boot-time subscribe leaves a stale "live updates unavailable".
    expect(route.getApprovalError()).toContain('server_offline');

    reconnect.fire(); // server back up
    await tick();
    expect(runApprovalSubscribe).toHaveBeenCalledTimes(2);
    expect(route.getApprovalError()).toBeNull(); // cleared on the successful re-arm
    route.dispose();
  });

  it('refreshes the approval list on reconnect (catches offline changes)', async () => {
    const reconnect = makeFakeReconnect();
    const runApprovalList = vi.fn(async () => ({ approvals: [approval('ap-1')] }));
    const { route } = mountFor({ runApprovalList, reconnect });
    await tick();
    const before = runApprovalList.mock.calls.length;
    reconnect.fire();
    await tick();
    expect(runApprovalList.mock.calls.length).toBeGreaterThan(before);
    route.dispose();
  });

  it('detaches the reconnect listener on dispose', async () => {
    const reconnect = makeFakeReconnect();
    const { route } = mountFor({ reconnect });
    await tick();
    expect(reconnect.listenerCount()).toBe(1);
    route.dispose();
    expect(reconnect.listenerCount()).toBe(0);
    expect(() => reconnect.fire()).not.toThrow();
  });

  it('resets the seq baseline on reconnect so a restarted server\'s low-seq events are accepted', async () => {
    const reconnect = makeFakeReconnect();
    let subSeq = 42; // pre-restart high-water mark
    const runApprovalSubscribe = vi.fn(async () => ({ approvals: [], seq: subSeq }));
    const runApprovalList = vi.fn(async () => ({ approvals: [] }));
    const { route, approvalChanged } = mountFor({
      runApprovalSubscribe,
      runApprovalList,
      reconnect,
    });
    await tick();
    // The mount subscribe set the client baseline to 42.
    subSeq = 0; // server restarts → its seq epoch resets
    reconnect.fire();
    await tick();
    const listBefore = runApprovalList.mock.calls.length;
    // A post-restart change event at seq 1 must be ACCEPTED — without the
    // baseline reset it would be dropped as `1 <= 42` and live updates die.
    approvalChanged!.fire(1, 0);
    await tick();
    expect(runApprovalList.mock.calls.length).toBeGreaterThan(listBefore);
    route.dispose();
  });

  it('shows a calm connection line (no raw internals) when a load fails offline with no data', async () => {
    const offline = (method: string) =>
      new RpcError('server_offline', `webclient rpc: server offline — '${method}' was not delivered`, undefined, method);
    const runApprovalSubscribe = vi.fn(async () => { throw offline('approval.subscribe'); });
    const runApprovalList = vi.fn(async () => { throw offline('approval.list'); });
    const { route, root } = mountFor({ runApprovalSubscribe, runApprovalList });
    await tick();
    const err = firstByAttr(root, APPROVALS_ROUTE_ERROR_ATTR);
    expect(err).toBeDefined();
    expect(err!.getAttribute(APPROVALS_ROUTE_ERROR_ATTR)).toBe('connection');
    expect(err!.textContent).toBe("Can't reach your server right now.");
    // No method name, ms, code, or rpc jargon leaks.
    expect(err!.textContent).not.toMatch(/approval\.|30000ms|webclient rpc|was not delivered|server_offline/);
    route.dispose();
  });

  it('suppresses the connection error when there are approvals to keep (defers to the banner)', async () => {
    const runApprovalSubscribe = vi.fn(async () => ({ approvals: [approval('ap-1')], seq: 1 }));
    const runApprovalList = vi.fn(async () => {
      throw new RpcError('server_offline', 'raw', undefined, 'approval.list');
    });
    const { route, root } = mountFor({ runApprovalSubscribe, runApprovalList });
    await tick();
    // Data is present (from the subscribe) → the banner is the signal; no inline dump.
    expect(firstByAttr(root, APPROVALS_ROUTE_ERROR_ATTR)).toBeUndefined();
    route.dispose();
  });

  it('shows a REAL server error inline, humanized + labelled', async () => {
    const runApprovalList = vi.fn(async () => {
      throw new RpcError('bad_request', 'Bad filter.', undefined, 'approval.list');
    });
    const { route, root } = mountFor({ runApprovalList });
    await tick();
    const err = firstByAttr(root, APPROVALS_ROUTE_ERROR_ATTR);
    expect(err).toBeDefined();
    expect(err!.getAttribute(APPROVALS_ROUTE_ERROR_ATTR)).toBe('error');
    expect(err!.textContent).toBe("Couldn't load approval gates: Bad filter.");
    route.dispose();
  });

  it('a stale in-flight subscribe does not clobber a newer reconnect baseline', async () => {
    const reconnect = makeFakeReconnect();
    type SubRes = { approvals: ReadonlyArray<ServerPendingApproval>; seq: number };
    let resolveMount: (v: SubRes) => void = () => {};
    let call = 0;
    const runApprovalSubscribe = vi.fn((): Promise<SubRes> => {
      call += 1;
      if (call === 1) {
        return new Promise<SubRes>((res) => {
          resolveMount = res;
        }); // mount subscribe hangs
      }
      return Promise.resolve({ approvals: [], seq: 0 }); // reconnect: fresh epoch
    });
    const runApprovalList = vi.fn(async () => ({ approvals: [] }));
    const { route, approvalChanged } = mountFor({
      runApprovalSubscribe,
      runApprovalList,
      reconnect,
    });
    await tick();
    reconnect.fire(); // 2nd subscribe resolves immediately with seq 0
    await tick();
    // The stale mount subscribe finally resolves with a HIGH seq — the
    // generation guard must drop it so the baseline stays 0, not 99.
    resolveMount({ approvals: [], seq: 99 });
    await tick();
    const listBefore = runApprovalList.mock.calls.length;
    approvalChanged!.fire(1, 0); // seq 1 must still be accepted
    await tick();
    expect(runApprovalList.mock.calls.length).toBeGreaterThan(listBefore);
    route.dispose();
  });
});
