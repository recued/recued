/** D-174 - global top-bar approval attention popover. */

import { describe, expect, it, vi } from 'vitest';
import type {
  ConnectionCredentialPostSafeStopVerificationSummary,
  ConnectionView,
  ServerPendingApproval,
  ServerPendingAsk,
} from '@recued/contracts';

import {
  ATTENTION_CLOSE_BUTTON_ATTR,
  ATTENTION_CHAT_PLAN_LINK_ATTR,
  ATTENTION_CHAT_PLAN_RESOLUTION_ATTR,
  ATTENTION_CHAT_PLAN_RESOLUTION_ANNOUNCER_ATTR,
  ATTENTION_CONNECTION_RECOVERY_REVIEW_ATTR,
  ATTENTION_CONNECTION_RECOVERY_LINK_ATTR,
  ATTENTION_CONNECTIONS_LINK_ATTR,
  ATTENTION_DIALOG_ATTR,
  ATTENTION_ERROR_ANNOUNCER_ATTR,
  ATTENTION_GATEWAY_ASK_ROW_ATTR,
  ATTENTION_INACTIVE_PROFILE_RECOVERY_ATTR,
  ATTENTION_RECOVERY_EXCURSION_RETURN_ATTR,
  ATTENTION_RECOVERY_EXCURSION_RETURN_ANNOUNCER_ATTR,
  ATTENTION_RECOVERY_INTENT_CONTINUATION_ATTR,
  ATTENTION_RECOVERY_INTENT_EXPIRY_HANDOFF_ATTR,
  ATTENTION_RECOVERY_INTENT_SERVER_OUTCOME_ATTR,
  ATTENTION_RECOVERY_INTENT_SERVER_STATE_ATTR,
  ATTENTION_SEE_ALL_LINK_ATTR,
  ATTENTION_TOPBAR_HOST_ATTR,
  ATTENTION_TOPBAR_STYLES,
  ATTENTION_TOPBAR_STYLES_MARKER,
  mountApprovalAttentionPopover,
  type AttentionInactiveConnectionRecoveryHint,
  type AttentionRecoveryExcursionReturn,
  type AttentionRecoveryIntentContinuation,
  type AttentionRecoveryIntentExpiryHandoff,
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
import type { ConnectionsEnrollListCaller } from '../settings/connections-enroll-panel.js';
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
  listeners: Map<string, Set<(event: Event) => void>>;
  createElement(tag: string): FakeEl;
  addEventListener(type: string, listener: (event: Event) => void): void;
  removeEventListener(type: string, listener: (event: Event) => void): void;
  fire(type: string, event: Event): void;
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
    contains(candidate: Node | null) {
      if (candidate === (el as FakeEl)) return true;
      return childList.some((child) => child.contains(candidate));
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
  const listeners = new Map<string, Set<(event: Event) => void>>();
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
    listeners,
    createElement: (tag: string): FakeEl => makeFakeEl(tag),
    addEventListener: (type, listener): void => {
      const byType = listeners.get(type) ?? new Set();
      byType.add(listener);
      listeners.set(type, byType);
    },
    removeEventListener: (type, listener): void => {
      listeners.get(type)?.delete(listener);
    },
    fire: (type, event): void => {
      for (const listener of [...(listeners.get(type) ?? [])]) listener(event);
    },
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

const connection = (
  name: string,
  overrides: Partial<ConnectionView> = {},
): ConnectionView => ({
  kind: 'api',
  name,
  display_name: name,
  updated_at: 1,
  auth_type: 'bearer',
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

const makeFakeRecoverySubscribe = () => {
  const listeners = new Set<() => void>();
  return {
    subscribe: (listener: () => void): (() => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    fire: (): void => {
      for (const listener of [...listeners]) listener();
    },
    listenerCount: (): number => listeners.size,
  };
};

const tick = async (n = 6): Promise<void> => {
  for (let i = 0; i < n; i += 1) await Promise.resolve();
};
const nextTask = (): Promise<void> => new Promise((resolve) => {
  globalThis.setTimeout(resolve, 0);
});

const mountFor = (
  opts: {
    rows?: () => ReadonlyArray<ServerPendingApproval>;
    asks?: () => ReadonlyArray<ServerPendingAsk>;
    runApprovalList?: ApprovalListCaller;
    runApprovalResolve?: ApprovalResolveCaller;
    runApprovalSubscribe?: ApprovalSubscribeCaller;
    runPendingAsksList?: AsksListCaller;
    runPendingAskSubmitAnswer?: AsksSubmitAnswerCaller;
    runConnectionRecoveryList?: ConnectionsEnrollListCaller;
    connectionRecoveryProfile?: { id: string; label: string };
    inactiveConnectionRecoveryHints?: ReadonlyArray<
      AttentionInactiveConnectionRecoveryHint
    >;
    onReviewInactiveConnectionRecovery?: (
      profileId: string,
    ) => 'opened' | 'missing' | 'unavailable';
    initialConnectionRecoveryReview?: { serverProfileId: string };
    onConnectionRecoverySnapshot?: (snapshot: {
      serverProfileId: string;
      hasRecoveries: boolean;
      observedAt: number;
    }) => void;
    onConnectionRecoveryReviewSettled?: (profileId: string) => void;
    onConnectionRecoveryReviewDismissed?: (profileId: string) => void;
    initialRecoveryExcursionReturn?: AttentionRecoveryExcursionReturn;
    onReviewRecoveryExcursionReturn?: (
      profileId: string,
    ) => 'opened' | 'missing' | 'unavailable';
    onDismissRecoveryExcursionReturn?: (profileId: string) => void;
    initialRecoveryIntentContinuation?: AttentionRecoveryIntentContinuation;
    onResumeRecoveryIntentContinuation?: (
      continuation: AttentionRecoveryIntentContinuation,
    ) => 'started' | 'missing' | 'unavailable';
    onReviewRecoveryIntentContinuation?: (
      continuation: AttentionRecoveryIntentContinuation,
    ) => 'started' | 'missing' | 'unavailable';
    onRemediateRecoveryIntentConnection?: (
      continuation: AttentionRecoveryIntentContinuation,
    ) => 'started' | 'missing' | 'unavailable';
    onReviewRecoveryIntentServer?: (
      continuation: AttentionRecoveryIntentContinuation,
    ) => 'started' | 'missing' | 'unavailable';
    onResolveRecoveryIntentReview?: (
      continuation: AttentionRecoveryIntentContinuation,
    ) => 'started' | 'missing' | 'unavailable';
    onKeepRecoveryIntentReviewBlocked?: (
      continuation: AttentionRecoveryIntentContinuation,
    ) => 'started' | 'missing' | 'unavailable';
    onDeferRecoveryIntentVerification?: (
      continuation: AttentionRecoveryIntentContinuation,
    ) => 'started' | 'missing' | 'unavailable';
    initialRecoveryIntentExpiryHandoff?:
      AttentionRecoveryIntentExpiryHandoff;
    onReviewRecoveryIntentExpiryHandoff?: (
      handoff: AttentionRecoveryIntentExpiryHandoff,
    ) => 'started' | 'missing' | 'unavailable';
    onDismissRecoveryIntentExpiryHandoff?: () => void;
    onDismissRecoveryIntentContinuation?: () => void;
    now?: () => number;
    recoverySubscription?: ReturnType<typeof makeFakeRecoverySubscribe>;
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
  runConnectionRecoveryList?: ConnectionsEnrollListCaller;
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
    ...(opts.runConnectionRecoveryList
      ? {
          runConnectionRecoveryList: opts.runConnectionRecoveryList,
          connectionRecoveryProfile: opts.connectionRecoveryProfile ?? {
            id: 'profile-home',
            label: 'Home server',
          },
          connectionRecoveryHref: ({ serverProfileId, kind, name }) =>
            `#connections/others/finish-recovery/profile/${serverProfileId}/${kind}/${name}`,
        }
      : {}),
    ...(opts.recoverySubscription
      ? {
          subscribeConnectionRecovery:
            opts.recoverySubscription.subscribe,
        }
      : {}),
    ...(opts.inactiveConnectionRecoveryHints !== undefined
      ? {
          inactiveConnectionRecoveryHints:
            opts.inactiveConnectionRecoveryHints,
        }
      : {}),
    ...(opts.onReviewInactiveConnectionRecovery !== undefined
      ? {
          onReviewInactiveConnectionRecovery:
            opts.onReviewInactiveConnectionRecovery,
        }
      : {}),
    ...(opts.initialConnectionRecoveryReview !== undefined
      ? {
          initialConnectionRecoveryReview:
            opts.initialConnectionRecoveryReview,
        }
      : {}),
    ...(opts.onConnectionRecoverySnapshot !== undefined
      ? { onConnectionRecoverySnapshot: opts.onConnectionRecoverySnapshot }
      : {}),
    ...(opts.onConnectionRecoveryReviewSettled !== undefined
      ? {
          onConnectionRecoveryReviewSettled:
            opts.onConnectionRecoveryReviewSettled,
        }
      : {}),
    ...(opts.onConnectionRecoveryReviewDismissed !== undefined
      ? {
          onConnectionRecoveryReviewDismissed:
            opts.onConnectionRecoveryReviewDismissed,
        }
      : {}),
    ...(opts.initialRecoveryExcursionReturn !== undefined
      ? {
          initialRecoveryExcursionReturn:
            opts.initialRecoveryExcursionReturn,
        }
      : {}),
    ...(opts.onReviewRecoveryExcursionReturn !== undefined
      ? {
          onReviewRecoveryExcursionReturn:
            opts.onReviewRecoveryExcursionReturn,
        }
      : {}),
    ...(opts.onDismissRecoveryExcursionReturn !== undefined
      ? {
          onDismissRecoveryExcursionReturn:
            opts.onDismissRecoveryExcursionReturn,
        }
      : {}),
    ...(opts.initialRecoveryIntentContinuation !== undefined
      ? {
          initialRecoveryIntentContinuation:
            opts.initialRecoveryIntentContinuation,
        }
      : {}),
    ...(opts.onResumeRecoveryIntentContinuation !== undefined
      ? {
          onResumeRecoveryIntentContinuation:
            opts.onResumeRecoveryIntentContinuation,
        }
      : {}),
    ...(opts.onReviewRecoveryIntentContinuation !== undefined
      ? {
          onReviewRecoveryIntentContinuation:
            opts.onReviewRecoveryIntentContinuation,
        }
      : {}),
    ...(opts.onRemediateRecoveryIntentConnection !== undefined
      ? {
          onRemediateRecoveryIntentConnection:
            opts.onRemediateRecoveryIntentConnection,
        }
      : {}),
    ...(opts.onReviewRecoveryIntentServer !== undefined
      ? {
          onReviewRecoveryIntentServer:
            opts.onReviewRecoveryIntentServer,
        }
      : {}),
    ...(opts.onResolveRecoveryIntentReview !== undefined
      ? {
          onResolveRecoveryIntentReview:
            opts.onResolveRecoveryIntentReview,
        }
      : {}),
    ...(opts.onKeepRecoveryIntentReviewBlocked !== undefined
      ? {
          onKeepRecoveryIntentReviewBlocked:
            opts.onKeepRecoveryIntentReviewBlocked,
        }
      : {}),
    ...(opts.onDeferRecoveryIntentVerification !== undefined
      ? {
          onDeferRecoveryIntentVerification:
            opts.onDeferRecoveryIntentVerification,
        }
      : {}),
    ...(opts.initialRecoveryIntentExpiryHandoff !== undefined
      ? {
          initialRecoveryIntentExpiryHandoff:
            opts.initialRecoveryIntentExpiryHandoff,
        }
      : {}),
    ...(opts.onReviewRecoveryIntentExpiryHandoff !== undefined
      ? {
          onReviewRecoveryIntentExpiryHandoff:
            opts.onReviewRecoveryIntentExpiryHandoff,
        }
      : {}),
    ...(opts.onDismissRecoveryIntentExpiryHandoff !== undefined
      ? {
          onDismissRecoveryIntentExpiryHandoff:
            opts.onDismissRecoveryIntentExpiryHandoff,
        }
      : {}),
    ...(opts.onDismissRecoveryIntentContinuation !== undefined
      ? {
          onDismissRecoveryIntentContinuation:
            opts.onDismissRecoveryIntentContinuation,
        }
      : {}),
    ...(opts.now !== undefined ? { now: opts.now } : {}),
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
    ...(opts.runConnectionRecoveryList
      ? { runConnectionRecoveryList: opts.runConnectionRecoveryList }
      : {}),
    approvalChanged,
    sub,
  };
};

describe('D-174 - approval attention top-bar adapter', () => {
  it('mounts a bell, one plain-language queue, and the full-queue handoff', async () => {
    const rows = [approval('ap-1'), approval('ap-2')];
    const { doc, topbar, handle, runApprovalList, runApprovalSubscribe } =
      mountFor({ rows: () => rows });
    await handle.whenLoaded();

    expect(runApprovalList).toHaveBeenCalledTimes(1);
    expect(runApprovalSubscribe).toHaveBeenCalledTimes(1);
    expect(topbar.innerHTML).toContain('top-bar-attention-badge');
    expect(topbar.innerHTML).toContain('top-bar-attention-bell');
    expect(topbar.innerHTML).not.toContain('⚠');
    expect(topbar.innerHTML).toContain('>2<');
    expect(doc.styleElements).toHaveLength(1);
    expect(doc.styleElements[0]!.attrs.has(ATTENTION_TOPBAR_STYLES_MARKER))
      .toBe(true);
    expect(doc.styleElements[0]!.textContent).toBe(ATTENTION_TOPBAR_STYLES);
    expect(ATTENTION_TOPBAR_STYLES).toMatch(
      /\.attention-popover-close\s*\{[^}]*width:\s*36px;[^}]*height:\s*36px/s,
    );
    expect(ATTENTION_TOPBAR_STYLES).toMatch(
      /\.attention-row-action\s*\{[^}]*min-height:\s*36px/s,
    );
    expect(ATTENTION_TOPBAR_STYLES).toMatch(
      /\.webclient-attention-footer a\s*\{[^}]*min-height:\s*36px/s,
    );

    topbar.fireAction({ 'data-action': 'open-attention' });

    expect(handle.isOpen()).toBe(true);
    expect(topbar.innerHTML).toContain(ATTENTION_DIALOG_ATTR);
    expect(topbar.innerHTML).toContain(ATTENTION_CLOSE_BUTTON_ATTR);
    expect(topbar.innerHTML).toContain('2 items are waiting for you.');
    expect(topbar.innerHTML).not.toContain('Other notifications');
    expect(topbar.innerHTML).not.toContain('role="tablist"');
    expect(topbar.innerHTML).toContain('data-action="approval-decide-server"');
    expect(topbar.innerHTML).toContain(
      '<h3 class="attention-row-title">Send follow-up ap-1</h3>',
    );
    expect(topbar.innerHTML).toContain('Approval &middot; Mail send &middot; Changes data');
    expect(topbar.innerHTML).toContain(
      'aria-label="Approve: Send follow-up ap-1"',
    );
    expect(topbar.innerHTML).toContain('data-action="open-approvals"');
    expect(topbar.innerHTML).toContain(ATTENTION_SEE_ALL_LINK_ATTR);
    expect(topbar.innerHTML).toContain('Open approvals');
    handle.dispose();
  });

  it('closes from the header, Escape, outside click, focus departure, and full-queue handoff', async () => {
    const { doc, root, topbar, handle } = mountFor();
    await handle.whenLoaded();

    topbar.fireAction({ 'data-action': 'open-attention' });
    topbar.fireAction({ 'data-action': 'close-attention' });
    expect(handle.isOpen()).toBe(false);

    topbar.fireAction({ 'data-action': 'open-attention' });
    const preventDefault = vi.fn();
    const stopPropagation = vi.fn();
    doc.fire('keydown', {
      key: 'Escape',
      preventDefault,
      stopPropagation,
    } as unknown as KeyboardEvent);
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(stopPropagation).toHaveBeenCalledTimes(1);
    expect(handle.isOpen()).toBe(false);

    topbar.fireAction({ 'data-action': 'open-attention' });
    doc.fire('click', { target: root } as unknown as MouseEvent);
    expect(handle.isOpen()).toBe(false);

    topbar.fireAction({ 'data-action': 'open-attention' });
    doc.fire('focusin', { target: root } as unknown as FocusEvent);
    await nextTask();
    expect(handle.isOpen()).toBe(false);

    // Another shell surface can open Attention from its own click handler.
    // That same event must not bubble into the outside-click closer and undo
    // the handoff before the dialog is painted.
    handle.open();
    doc.fire('click', { target: root } as unknown as MouseEvent);
    expect(handle.isOpen()).toBe(true);
    await nextTask();
    doc.fire('click', { target: root } as unknown as MouseEvent);
    expect(handle.isOpen()).toBe(false);

    topbar.fireAction({ 'data-action': 'open-attention' });
    topbar.fireAction({ 'data-action': 'open-approvals' });
    await tick();
    expect(handle.isOpen()).toBe(false);
    expect(topbar.innerHTML).not.toContain(ATTENTION_DIALOG_ATTR);
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

  it('surfaces every authoritative post-ack recovery with exact, privacy-safe Connections handoffs', async () => {
    const reconnect = makeFakeReconnect();
    const recoverySubscription = makeFakeRecoverySubscribe();
    const connections = [
      connection('billing-crm', {
        display_name: 'Billing CRM',
        updated_at: 11,
      }),
      connection('research-bridge', {
        kind: 'mcp',
        display_name: 'Research bridge',
        updated_at: 22,
      }),
    ];
    let recoveries: ConnectionCredentialPostSafeStopVerificationSummary[] = [
      {
        kind: 'mcp',
        name: 'research-bridge',
        status: 'auth_failed',
        // The server puts this causally newer row first even though both wall
        // clocks moved backwards. Attention must preserve that lineage order.
        acknowledged_at: 1_700_000_001_000,
        checked_at: 1_700_000_000_500,
        connection_updated_at: 22,
        credential_correction: {
          auth_type: 'bearer',
          field_keys: ['auth.token'],
        },
      },
      {
        kind: 'api',
        name: 'billing-crm',
        status: 'pending',
        acknowledged_at: 1_700_000_002_000,
      },
    ];
    const runConnectionRecoveryList = vi.fn(async () => ({
      connections,
      credential_post_safe_stop_verifications: recoveries,
    }));
    const { topbar, handle } = mountFor({
      rows: () => [],
      asks: () => [],
      runConnectionRecoveryList,
      recoverySubscription,
      reconnect,
    });
    await handle.whenLoaded();

    expect(handle.getConnectionRecoveries()).toHaveLength(2);
    expect(handle.getConnectionRecoveries()[0]).toMatchObject({
      serverProfileId: 'profile-home',
      serverProfileLabel: 'Home server',
    });
    expect(topbar.innerHTML).toContain('>2<');
    topbar.fireAction({ 'data-action': 'open-attention' });
    expect(topbar.innerHTML).toContain('Finish recovery for Billing CRM');
    expect(topbar.innerHTML).toContain(
      'Research bridge still needs sign-in attention',
    );
    expect(topbar.innerHTML).toContain(
      '#connections/others/finish-recovery/profile/profile-home/api/billing-crm',
    );
    expect(topbar.innerHTML).toContain(
      '#connections/others/finish-recovery/profile/profile-home/mcp/research-bridge',
    );
    expect(topbar.innerHTML).toContain('Server profile: Home server');
    expect(topbar.innerHTML.indexOf(
      'Research bridge still needs sign-in attention',
    )).toBeLessThan(topbar.innerHTML.indexOf(
      'Finish recovery for Billing CRM',
    ));
    expect(topbar.innerHTML).toContain(ATTENTION_CONNECTION_RECOVERY_LINK_ATTR);
    expect(topbar.innerHTML).toContain(ATTENTION_CONNECTIONS_LINK_ATTR);
    expect(topbar.innerHTML).not.toContain('auth.token');
    expect(topbar.innerHTML).not.toContain('1700000000500');

    handle.setConnectionRecoveryProfileLabel('Renamed home');
    expect(topbar.innerHTML).toContain('Server profile: Renamed home');
    expect(topbar.innerHTML).toContain(
      '#connections/others/finish-recovery/profile/profile-home/api/billing-crm',
    );

    topbar.fireAction({
      'data-action': 'open-connection-recovery',
      'data-connection-kind': 'api',
      'data-connection-name': 'billing-crm',
    });
    await tick();
    expect(handle.isOpen()).toBe(false);

    recoveries = [recoveries[0]!];
    recoverySubscription.fire();
    await tick();
    expect(handle.getConnectionRecoveries().map((item) => item.name)).toEqual([
      'research-bridge',
    ]);
    expect(topbar.innerHTML).toContain('>1<');

    reconnect.fire();
    await tick();
    expect(runConnectionRecoveryList.mock.calls.length).toBeGreaterThanOrEqual(3);

    // A newly malformed authoritative snapshot must revoke the older exact
    // action instead of leaving a stale recovery link clickable.
    recoveries = [{
      kind: 'mcp',
      name: 'research-bridge',
      status: 'auth_failed',
      acknowledged_at: 1_700_000_004_000,
      checked_at: 1_700_000_004_100,
      connection_updated_at: 21,
    }];
    recoverySubscription.fire();
    await tick();
    expect(handle.getConnectionRecoveries()).toEqual([]);
    expect(topbar.innerHTML).not.toContain(
      'Research bridge still needs sign-in attention',
    );
    topbar.fireAction({ 'data-action': 'open-attention' });
    expect(topbar.innerHTML).toContain(
      'The server returned an invalid connection recovery queue.',
    );
    handle.dispose();
    expect(recoverySubscription.listenerCount()).toBe(0);
  });

  it('keeps a stale or malformed post-ack projection out of Attention', async () => {
    const runConnectionRecoveryList = vi.fn(async () => ({
      connections: [connection('changed-row', { updated_at: 8 })],
      credential_post_safe_stop_verifications: [{
        kind: 'api' as const,
        name: 'changed-row',
        status: 'auth_failed' as const,
        acknowledged_at: 5,
        checked_at: 6,
        connection_updated_at: 7,
      }],
    }));
    const { topbar, handle } = mountFor({
      rows: () => [],
      asks: () => [],
      runConnectionRecoveryList,
    });
    await handle.whenLoaded();

    expect(handle.getConnectionRecoveries()).toEqual([]);
    expect(topbar.innerHTML).not.toContain('top-bar-attention-badge');
    topbar.fireAction({ 'data-action': 'open-attention' });
    expect(topbar.innerHTML).toContain(
      'The server returned an invalid connection recovery queue.',
    );
    expect(topbar.innerHTML).not.toContain('Finish recovery for changed-row');
    handle.dispose();
  });

  it('shows an inactive profile as a stale identity-free reminder and opens its deliberate switch review', async () => {
    const reviewInactive = vi.fn(() => 'opened' as const);
    const { topbar, handle } = mountFor({
      rows: () => [],
      asks: () => [],
      runConnectionRecoveryList: async () => ({ connections: [] }),
      inactiveConnectionRecoveryHints: [{
        serverProfileId: 'profile-office',
        serverProfileLabel: 'Office <shared>',
        observedAt: 2 * 60 * 60_000,
      }],
      onReviewInactiveConnectionRecovery: reviewInactive,
      now: () => 4 * 60 * 60_000,
    });
    await handle.whenLoaded();

    expect(handle.getInactiveConnectionRecoveryHints()).toEqual([{
      serverProfileId: 'profile-office',
      serverProfileLabel: 'Office <shared>',
      observedAt: 2 * 60 * 60_000,
    }]);
    expect(topbar.innerHTML).toContain('>1<');
    topbar.fireAction({ 'data-action': 'open-attention' });
    expect(topbar.innerHTML).toContain(ATTENTION_INACTIVE_PROFILE_RECOVERY_ATTR);
    expect(topbar.innerHTML).toContain('Office &lt;shared&gt; may still need');
    expect(topbar.innerHTML).toContain('Last confirmed while active 2 hours ago');
    expect(topbar.innerHTML).toContain('not a live result');
    expect(topbar.innerHTML).toContain('Open Account to review the profile switch');
    expect(topbar.innerHTML).toContain('Review switch');
    expect(topbar.innerHTML).not.toContain('api/');
    expect(topbar.innerHTML).not.toContain('connection-name');

    handle.setInactiveConnectionRecoveryHints([{
      serverProfileId: 'profile-office',
      serverProfileLabel: 'Renamed office',
      observedAt: 2 * 60 * 60_000,
    }]);
    expect(topbar.innerHTML).toContain('Renamed office may still need');

    topbar.fireAction({
      'data-action': 'review-inactive-connection-recovery',
      'data-server-profile-id': 'profile-office',
    });
    expect(reviewInactive).toHaveBeenCalledWith('profile-office');
    expect(handle.isOpen()).toBe(false);
    handle.dispose();
  });

  it('keeps an inactive reminder actionable when Account is temporarily unavailable', async () => {
    const reviewInactive = vi.fn(() => 'unavailable' as const);
    const { topbar, handle } = mountFor({
      rows: () => [],
      asks: () => [],
      runConnectionRecoveryList: async () => ({ connections: [] }),
      inactiveConnectionRecoveryHints: [{
        serverProfileId: 'profile-office',
        serverProfileLabel: 'Office server',
        observedAt: 1_000,
      }],
      onReviewInactiveConnectionRecovery: reviewInactive,
      now: () => 2_000,
    });
    await handle.whenLoaded();
    topbar.fireAction({ 'data-action': 'open-attention' });
    topbar.fireAction({
      'data-action': 'review-inactive-connection-recovery',
      'data-server-profile-id': 'profile-office',
    });

    expect(handle.isOpen()).toBe(true);
    expect(handle.getInactiveConnectionRecoveryHints()).toHaveLength(1);
    expect(topbar.innerHTML).toContain('can’t be opened from Account right now');
    expect(topbar.innerHTML).toContain('profile action already in progress');
    expect(topbar.innerHTML).toContain('Review switch');

    handle.setInactiveConnectionRecoveryHints([]);
    expect(topbar.innerHTML).not.toContain('can’t be opened from Account right now');
    expect(handle.getInactiveConnectionRecoveryHints()).toEqual([]);
    handle.dispose();
  });

  it('auto-opens a destination review and replaces the stale hint with fresh authoritative rows', async () => {
    const snapshot = vi.fn();
    const settled = vi.fn();
    const dismissed = vi.fn();
    const saved = connection('fresh-check', { updated_at: 10 });
    const { topbar, handle } = mountFor({
      rows: () => [],
      asks: () => [],
      connectionRecoveryProfile: {
        id: 'profile-office',
        label: 'Office server',
      },
      runConnectionRecoveryList: async () => ({
        connections: [saved],
        credential_post_safe_stop_verifications: [{
          kind: 'api',
          name: 'fresh-check',
          status: 'pending',
          acknowledged_at: 9,
        }],
      }),
      initialConnectionRecoveryReview: {
        serverProfileId: 'profile-office',
      },
      onConnectionRecoverySnapshot: snapshot,
      onConnectionRecoveryReviewSettled: settled,
      onConnectionRecoveryReviewDismissed: dismissed,
      now: () => 50_000,
    });

    expect(handle.isOpen()).toBe(true);
    await handle.whenLoaded();
    expect(topbar.innerHTML).toContain(ATTENTION_CONNECTION_RECOVERY_REVIEW_ATTR);
    expect(topbar.innerHTML).toContain('A fresh check found 1 connection recovery');
    expect(topbar.innerHTML).toContain('Finish recovery for fresh-check');
    expect(topbar.innerHTML).toContain('fresh authoritative list');
    expect(snapshot).toHaveBeenCalledWith({
      serverProfileId: 'profile-office',
      hasRecoveries: true,
      observedAt: 50_000,
    });
    expect(settled).toHaveBeenCalledOnce();

    topbar.fireAction({
      'data-action': 'dismiss-connection-recovery-review',
    });
    expect(handle.isOpen()).toBe(false);
    expect(dismissed).not.toHaveBeenCalled();
    handle.dispose();
  });

  it('keeps a failed destination review retryable, then retires it only after an authoritative all-clear', async () => {
    let unavailable = true;
    const settled = vi.fn();
    const dismissed = vi.fn();
    const runConnectionRecoveryList = vi.fn(async () => {
      if (unavailable) throw new Error('offline');
      return { connections: [] };
    });
    const { topbar, handle } = mountFor({
      rows: () => [],
      asks: () => [],
      connectionRecoveryProfile: {
        id: 'profile-office',
        label: 'Office server',
      },
      runConnectionRecoveryList,
      initialConnectionRecoveryReview: {
        serverProfileId: 'profile-office',
      },
      onConnectionRecoveryReviewSettled: settled,
      onConnectionRecoveryReviewDismissed: dismissed,
      now: () => 50_000,
    });
    await handle.whenLoaded();

    expect(topbar.innerHTML).toContain('Couldn’t confirm Office server yet');
    expect(topbar.innerHTML).toContain('no stale connection details were shown');
    expect(topbar.innerHTML).toContain('Office server still needs a fresh recovery check');
    expect(topbar.innerHTML).toContain('Retry check');
    expect(topbar.innerHTML).not.toContain('You&rsquo;re all caught up');
    expect(topbar.innerHTML).not.toContain("Couldn't refresh connection recovery");
    expect(settled).not.toHaveBeenCalled();
    expect(dismissed).not.toHaveBeenCalled();

    unavailable = false;
    topbar.fireAction({
      'data-action': 'retry-connection-recovery-review',
    });
    await handle.whenLoaded();
    expect(topbar.innerHTML).toContain('Office server is clear');
    expect(topbar.innerHTML).toContain('fresh authoritative check found no');
    expect(topbar.innerHTML).toContain('fresh Office server recovery check is complete');
    expect(topbar.innerHTML).not.toContain('You&rsquo;re all caught up');
    expect(settled).toHaveBeenCalledWith('profile-office');
    expect(dismissed).not.toHaveBeenCalled();
    handle.dispose();
  });

  it('keeps a reload-safe neutral return discoverable without replaying the all-clear receipt', async () => {
    const reviewReturn = vi.fn(() => 'opened' as const);
    const { root, topbar, handle } = mountFor({
      rows: () => [],
      asks: () => [],
      connectionRecoveryProfile: {
        id: 'profile-office',
        label: 'Office server',
      },
      runConnectionRecoveryList: async () => ({ connections: [] }),
      initialRecoveryExcursionReturn: {
        serverProfileId: 'profile-home',
        serverProfileLabel: 'Home <private>',
      },
      onReviewRecoveryExcursionReturn: reviewReturn,
    });
    await handle.whenLoaded();

    expect(handle.isOpen()).toBe(false);
    expect(handle.getRecoveryExcursionReturn()).toEqual({
      serverProfileId: 'profile-home',
      serverProfileLabel: 'Home <private>',
    });
    const returnAnnouncer = firstByAttr(
      root,
      ATTENTION_RECOVERY_EXCURSION_RETURN_ANNOUNCER_ATTR,
    );
    expect(ATTENTION_TOPBAR_STYLES).toContain(
      `[${ATTENTION_RECOVERY_EXCURSION_RETURN_ANNOUNCER_ATTR}]`,
    );
    expect(returnAnnouncer?.getAttribute('role')).toBe('status');
    expect(returnAnnouncer?.getAttribute('aria-live')).toBe('polite');
    expect(returnAnnouncer?.textContent).toBe('');
    expect(topbar.innerHTML).toContain('>1<');
    topbar.fireAction({ 'data-action': 'open-attention' });
    expect(returnAnnouncer?.textContent).toBe(
      'A saved return to Home <private> is ready to review.',
    );
    expect(topbar.innerHTML).toContain(ATTENTION_RECOVERY_EXCURSION_RETURN_ATTR);
    expect(topbar.innerHTML).toContain('Return to Home &lt;private&gt; when you’re ready');
    expect(topbar.innerHTML).toContain('normal server-switch review');
    expect(topbar.innerHTML).toContain('not record details');
    expect(topbar.innerHTML).not.toContain('is clear');
    expect(topbar.innerHTML).not.toContain('fresh authoritative check');
    expect(topbar.innerHTML).not.toContain('You&rsquo;re all caught up');

    topbar.fireAction({
      'data-action': 'review-recovery-excursion-return',
      'data-server-profile-id': 'profile-home',
    });
    expect(reviewReturn).toHaveBeenCalledWith('profile-home');
    expect(handle.isOpen()).toBe(false);
    // Opening Account reviews the switch; it does not consume the return.
    expect(handle.getRecoveryExcursionReturn()?.serverProfileId)
      .toBe('profile-home');
    handle.dispose();
  });

  it('announces a newly ready return and lets the owner explicitly stay', async () => {
    const stay = vi.fn();
    const { root, topbar, handle } = mountFor({
      rows: () => [],
      asks: () => [],
      connectionRecoveryProfile: {
        id: 'profile-office',
        label: 'Office server',
      },
      runConnectionRecoveryList: async () => ({ connections: [] }),
      onReviewRecoveryExcursionReturn: () => 'opened',
      onDismissRecoveryExcursionReturn: stay,
    });
    await handle.whenLoaded();
    topbar.fireAction({ 'data-action': 'open-attention' });
    handle.setRecoveryExcursionReturn({
      serverProfileId: 'profile-home',
      serverProfileLabel: 'Renamed home',
    });
    expect(topbar.innerHTML).toContain('Return to Renamed home');
    expect(firstByAttr(
      root,
      ATTENTION_RECOVERY_EXCURSION_RETURN_ANNOUNCER_ATTR,
    )?.textContent).toBe(
      'A saved return to Renamed home is ready to review.',
    );

    topbar.fireAction({
      'data-action': 'dismiss-recovery-excursion-return',
      'data-server-profile-id': 'profile-home',
    });
    expect(stay).toHaveBeenCalledWith('profile-home');
    expect(handle.getRecoveryExcursionReturn()).toBeNull();
    expect(firstByAttr(
      root,
      ATTENTION_RECOVERY_EXCURSION_RETURN_ANNOUNCER_ATTR,
    )?.textContent).toBe('');
    expect(topbar.innerHTML).toContain('You&rsquo;re all caught up');
    expect(topbar.innerHTML).not.toContain('top-bar-attention-badge');
    handle.dispose();
  });

  it('offers a quiet paused-return recheck without claiming readiness or replaying a receipt', async () => {
    const continuation: AttentionRecoveryIntentContinuation = {
      serverProfileId: 'profile-home',
      serverProfileLabel: 'Home <private>',
      landingHash: '#contracts',
      areaLabel: 'Contracts',
      intent: 'continue',
      phase: 'ready',
      remediation: null,
    };
    const resume = vi.fn(() => 'started' as const);
    const { root, topbar, handle } = mountFor({
      rows: () => [],
      asks: () => [],
      initialRecoveryIntentContinuation: continuation,
      onResumeRecoveryIntentContinuation: resume,
    });
    const triggerFocus = vi.fn();
    (topbar as unknown as {
      querySelector: (selector: string) => HTMLElement | null;
    }).querySelector = (selector) => selector === '[data-action="open-attention"]'
      ? { focus: triggerFocus } as unknown as HTMLElement
      : null;
    await handle.whenLoaded();

    expect(handle.isOpen()).toBe(false);
    expect(handle.getRecoveryIntentContinuation()).toEqual(continuation);
    expect(topbar.innerHTML).toContain('>1<');
    const announcer = firstByAttr(
      root,
      ATTENTION_RECOVERY_EXCURSION_RETURN_ANNOUNCER_ATTR,
    );
    expect(announcer?.textContent).toBe('');

    topbar.fireAction({ 'data-action': 'open-attention' });
    expect(topbar.innerHTML).toContain(
      ATTENTION_RECOVERY_INTENT_CONTINUATION_ATTR,
    );
    expect(topbar.innerHTML).toContain('Finish returning to Contracts');
    expect(topbar.innerHTML).toContain(
      'Recued paused this return on Home &lt;private&gt; so it wouldn’t interrupt you.',
    );
    expect(topbar.innerHTML).not.toContain('Home <private>');
    expect(topbar.innerHTML).toContain('Recheck area');
    expect(topbar.innerHTML).toContain(
      'aria-label="Recheck Contracts on Home &lt;private&gt;"',
    );
    expect(topbar.innerHTML).not.toContain('Contracts is ready');
    expect(topbar.innerHTML).not.toContain('Back on');
    expect(announcer?.textContent).toBe(
      'A paused return to Contracts is saved for when you’re ready.',
    );

    topbar.fireAction({
      'data-action': 'resume-recovery-intent-continuation',
    });
    expect(resume).toHaveBeenCalledOnce();
    expect(resume).toHaveBeenCalledWith(continuation);
    expect(handle.isOpen()).toBe(false);
    expect(triggerFocus).toHaveBeenCalledOnce();
    expect(triggerFocus).toHaveBeenCalledWith({ preventScroll: true });
    // Starting the authoritative check is not completion. Bootstrap clears the
    // item only after it focuses a useful current-route target.
    expect(handle.getRecoveryIntentContinuation()).toEqual(continuation);
    handle.setRecoveryIntentContinuation(null);
    expect(handle.getRecoveryIntentContinuation()).toBeNull();
    expect(topbar.innerHTML).not.toContain('top-bar-attention-badge');
    handle.dispose();
  });

  it('keeps a failed paused recheck actionable and retires it on dismissal', async () => {
    const dismiss = vi.fn();
    const { topbar, handle } = mountFor({
      rows: () => [],
      asks: () => [],
      onResumeRecoveryIntentContinuation: () => 'unavailable',
      onDismissRecoveryIntentContinuation: dismiss,
    });
    await handle.whenLoaded();
    topbar.fireAction({ 'data-action': 'open-attention' });
    handle.setRecoveryIntentContinuation({
      serverProfileId: 'profile-home',
      serverProfileLabel: 'Home server',
      landingHash: '#connections/mail',
      areaLabel: 'Mail',
      intent: 'choose_again',
      phase: 'ready',
      remediation: null,
    });

    expect(topbar.innerHTML).toContain('Return to Mail and choose again');
    topbar.fireAction({
      'data-action': 'resume-recovery-intent-continuation',
    });
    expect(handle.isOpen()).toBe(true);
    expect(topbar.innerHTML).toContain('can’t be rechecked right now');
    expect(topbar.innerHTML).toContain('Recheck area');

    topbar.fireAction({
      'data-action': 'dismiss-recovery-intent-continuation',
    });
    expect(dismiss).toHaveBeenCalledOnce();
    expect(handle.getRecoveryIntentContinuation()).toBeNull();
    expect(topbar.innerHTML).not.toContain('can’t be rechecked right now');
    expect(topbar.innerHTML).toContain('You&rsquo;re all caught up');
    handle.dispose();
  });

  it('shows an explicit non-repeatable pending recheck when Attention is reopened', async () => {
    const resume = vi.fn(() => 'started' as const);
    const dismiss = vi.fn();
    const { root, topbar, handle } = mountFor({
      rows: () => [],
      asks: () => [],
      initialRecoveryIntentContinuation: {
        serverProfileId: 'profile-home',
        serverProfileLabel: 'Home server',
        landingHash: '#contracts',
        areaLabel: 'Contracts',
        intent: 'continue',
        phase: 'checking',
        remediation: null,
      },
      onResumeRecoveryIntentContinuation: resume,
      onDismissRecoveryIntentContinuation: dismiss,
    });
    await handle.whenLoaded();

    const announcer = firstByAttr(
      root,
      ATTENTION_RECOVERY_EXCURSION_RETURN_ANNOUNCER_ATTR,
    );
    expect(announcer?.textContent).toBe('');
    topbar.fireAction({ 'data-action': 'open-attention' });
    expect(topbar.innerHTML).toContain('data-phase="checking"');
    expect(topbar.innerHTML).toContain('aria-busy="true"');
    expect(topbar.innerHTML).toContain('Rechecking Contracts');
    expect(topbar.innerHTML).toContain('Rechecking&hellip;');
    expect(topbar.innerHTML).toContain('disabled');
    expect(topbar.innerHTML).toMatch(
      /<button[^>]*aria-busy="true"[^>]*disabled[^>]*>\s*Rechecking&hellip;/s,
    );
    expect(topbar.innerHTML).not.toContain(
      'data-action="resume-recovery-intent-continuation"',
    );
    expect(announcer?.textContent).toBe(
      'Rechecking Contracts on Home server.',
    );

    // A stale/synthetic activation cannot start a duplicate request even if
    // it bypasses the browser's disabled-button behavior.
    topbar.fireAction({
      'data-action': 'resume-recovery-intent-continuation',
    });
    expect(resume).not.toHaveBeenCalled();
    expect(handle.isOpen()).toBe(true);
    topbar.fireAction({
      'data-action': 'dismiss-recovery-intent-continuation',
    });
    expect(dismiss).toHaveBeenCalledOnce();
    handle.dispose();
  });

  it('turns a failed recheck into explicit Review and Try again choices', async () => {
    const continuation: AttentionRecoveryIntentContinuation = {
      serverProfileId: 'profile-home',
      serverProfileLabel: 'Home <private>',
      landingHash: '#contracts',
      areaLabel: 'Contracts',
      intent: 'choose_again',
      phase: 'failed',
      remediation: 'retry',
    };
    const review = vi.fn(() => 'started' as const);
    const resume = vi.fn(() => 'started' as const);
    const { root, topbar, handle } = mountFor({
      rows: () => [],
      asks: () => [],
      initialRecoveryIntentContinuation: continuation,
      onResumeRecoveryIntentContinuation: resume,
      onReviewRecoveryIntentContinuation: review,
    });
    const triggerFocus = vi.fn();
    (topbar as unknown as {
      querySelector: (selector: string) => HTMLElement | null;
    }).querySelector = (selector) => selector === '[data-action="open-attention"]'
      ? { focus: triggerFocus } as unknown as HTMLElement
      : null;
    await handle.whenLoaded();

    topbar.fireAction({ 'data-action': 'open-attention' });
    expect(topbar.innerHTML).toContain('data-phase="failed"');
    expect(topbar.innerHTML).toContain('Contracts couldn’t be refreshed');
    expect(topbar.innerHTML).toContain('Review Contracts');
    expect(topbar.innerHTML).toContain('Try again');
    expect(ATTENTION_TOPBAR_STYLES).toContain(
      '.attention-recovery-intent-continuation[data-phase="failed"]',
    );
    expect(topbar.innerHTML).toContain(
      'aria-label="Review Contracts on Home &lt;private&gt;"',
    );
    expect(topbar.innerHTML).not.toContain('Home <private>');
    expect(firstByAttr(
      root,
      ATTENTION_RECOVERY_EXCURSION_RETURN_ANNOUNCER_ATTR,
    )?.textContent).toBe(
      'Contracts couldn’t be refreshed. Review the area or try again.',
    );

    topbar.fireAction({
      'data-action': 'review-recovery-intent-continuation',
    });
    expect(review).toHaveBeenCalledWith(continuation);
    expect(resume).not.toHaveBeenCalled();
    expect(handle.isOpen()).toBe(false);
    expect(triggerFocus).toHaveBeenCalledWith({ preventScroll: true });
    handle.dispose();
  });

  it('routes a disconnected recheck through Account without exposing failure detail', async () => {
    const continuation: AttentionRecoveryIntentContinuation = {
      serverProfileId: 'profile-home',
      serverProfileLabel: 'Home <private>',
      landingHash: '#contracts',
      areaLabel: 'Contracts',
      intent: 'choose_again',
      phase: 'failed',
      remediation: 'connection',
    };
    const remediate = vi.fn(() => 'started' as const);
    const review = vi.fn(() => 'started' as const);
    const resume = vi.fn(() => 'started' as const);
    const { root, topbar, handle } = mountFor({
      rows: () => [],
      asks: () => [],
      initialRecoveryIntentContinuation: continuation,
      onResumeRecoveryIntentContinuation: resume,
      onReviewRecoveryIntentContinuation: review,
      onRemediateRecoveryIntentConnection: remediate,
    });
    await handle.whenLoaded();

    topbar.fireAction({ 'data-action': 'open-attention' });
    expect(topbar.innerHTML).toContain('data-remediation="connection"');
    expect(topbar.innerHTML).toContain(
      'Reconnect before returning to Contracts',
    );
    expect(topbar.innerHTML).toContain(
      'return you to the exact place to choose again',
    );
    expect(topbar.innerHTML).toContain('Review connection');
    expect(topbar.innerHTML).toContain('Review Contracts');
    expect(topbar.innerHTML).not.toContain('Try again');
    expect(ATTENTION_TOPBAR_STYLES).toContain(
      '[data-phase="failed"][data-remediation="connection"]',
    );
    expect(ATTENTION_TOPBAR_STYLES).toContain(
      '.attention-plan-resolution-actions > :first-child:nth-last-child(3)',
    );
    expect(topbar.innerHTML).toContain(
      'aria-label="Review the Home &lt;private&gt; connection before returning to Contracts"',
    );
    expect(topbar.innerHTML).not.toContain('Home <private>');
    expect(firstByAttr(
      root,
      ATTENTION_RECOVERY_EXCURSION_RETURN_ANNOUNCER_ATTR,
    )?.textContent).toBe(
      'Contracts needs Home <private> connected. Review the connection to retry the exact return after reconnect.',
    );

    topbar.fireAction({
      'data-action': 'remediate-recovery-intent-connection',
    });
    expect(remediate).toHaveBeenCalledWith(continuation);
    expect(review).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
    expect(handle.isOpen()).toBe(false);
    handle.dispose();
  });

  it('makes the armed reconnect retry explicit and non-repeatable', async () => {
    const continuation: AttentionRecoveryIntentContinuation = {
      serverProfileId: 'profile-home',
      serverProfileLabel: 'Home server',
      landingHash: '#connections/mail',
      areaLabel: 'Mail',
      intent: 'continue',
      phase: 'waiting_for_connection',
      remediation: 'connection',
    };
    const remediate = vi.fn(() => 'started' as const);
    const resume = vi.fn(() => 'started' as const);
    const dismiss = vi.fn();
    const { root, topbar, handle } = mountFor({
      rows: () => [],
      asks: () => [],
      initialRecoveryIntentContinuation: continuation,
      onResumeRecoveryIntentContinuation: resume,
      onRemediateRecoveryIntentConnection: remediate,
      onDismissRecoveryIntentContinuation: dismiss,
    });
    await handle.whenLoaded();

    topbar.fireAction({ 'data-action': 'open-attention' });
    expect(topbar.innerHTML).toContain('data-phase="waiting_for_connection"');
    expect(topbar.innerHTML).toContain('data-remediation="connection"');
    expect(topbar.innerHTML).toContain('Waiting to recheck Mail');
    expect(topbar.innerHTML).toContain('Waiting for connection&hellip;');
    expect(topbar.innerHTML).toContain('aria-busy="true"');
    expect(topbar.innerHTML).toContain('Stop waiting');
    expect(topbar.innerHTML).not.toContain(
      'data-action="resume-recovery-intent-continuation"',
    );
    expect(firstByAttr(
      root,
      ATTENTION_RECOVERY_EXCURSION_RETURN_ANNOUNCER_ATTR,
    )?.textContent).toBe(
      'Waiting for Home server. Mail will be rechecked after it reconnects.',
    );

    // A synthetic resume activation cannot race the reconnect-owned retry.
    topbar.fireAction({
      'data-action': 'resume-recovery-intent-continuation',
    });
    expect(resume).not.toHaveBeenCalled();
    topbar.fireAction({
      'data-action': 'dismiss-recovery-intent-continuation',
    });
    expect(dismiss).toHaveBeenCalledOnce();
    expect(handle.getRecoveryIntentContinuation()).toBeNull();
    expect(remediate).not.toHaveBeenCalled();
    handle.dispose();
  });

  it('ends a repeated recovery loop with direct review and explicit closure', async () => {
    const continuation: AttentionRecoveryIntentContinuation = {
      serverProfileId: 'profile-home',
      serverProfileLabel: 'Home <private>',
      landingHash: '#contracts',
      areaLabel: 'Contracts',
      intent: 'choose_again',
      phase: 'failed',
      remediation: 'escalated',
    };
    const review = vi.fn(() => 'started' as const);
    const reviewServer = vi.fn(() => 'started' as const);
    const resume = vi.fn(() => 'started' as const);
    const remediate = vi.fn(() => 'started' as const);
    const resolveReview = vi.fn(() => 'started' as const);
    const keepBlocked = vi.fn(() => 'started' as const);
    const dismiss = vi.fn();
    const { root, topbar, handle } = mountFor({
      rows: () => [],
      asks: () => [],
      initialRecoveryIntentContinuation: continuation,
      onResumeRecoveryIntentContinuation: resume,
      onReviewRecoveryIntentContinuation: review,
      onRemediateRecoveryIntentConnection: remediate,
      onReviewRecoveryIntentServer: reviewServer,
      onResolveRecoveryIntentReview: resolveReview,
      onKeepRecoveryIntentReviewBlocked: keepBlocked,
      onDismissRecoveryIntentContinuation: dismiss,
    });
    await handle.whenLoaded();

    topbar.fireAction({ 'data-action': 'open-attention' });
    expect(topbar.innerHTML).toContain('data-remediation="escalated"');
    expect(topbar.innerHTML).toContain('Still can’t verify Contracts');
    expect(topbar.innerHTML).toContain(
      'Two recovery attempts couldn’t finish safely in this tab',
    );
    expect(topbar.innerHTML).toContain('stopped the retry loop');
    expect(topbar.innerHTML).toContain('Review Contracts');
    expect(topbar.innerHTML).toContain('Review server');
    expect(topbar.innerHTML).toContain('Stop recovery');
    expect(topbar.innerHTML).not.toContain('Try again');
    expect(topbar.innerHTML).not.toContain('Review connection');
    expect(topbar.innerHTML).toContain(
      'aria-label="Review Home &lt;private&gt; before returning to Contracts"',
    );
    expect(topbar.innerHTML).not.toContain('Home <private>');
    expect(ATTENTION_TOPBAR_STYLES).toContain(
      '[data-phase="failed"][data-remediation="escalated"]',
    );
    expect(firstByAttr(
      root,
      ATTENTION_RECOVERY_EXCURSION_RETURN_ANNOUNCER_ATTR,
    )?.textContent).toBe(
      'Recued stopped retrying Contracts in this tab. It won’t retry on its own.',
    );

    // Synthetic stale actions cannot bypass the cap.
    topbar.fireAction({
      'data-action': 'resume-recovery-intent-continuation',
    });
    topbar.fireAction({
      'data-action': 'remediate-recovery-intent-connection',
    });
    expect(resume).not.toHaveBeenCalled();
    expect(remediate).not.toHaveBeenCalled();

    topbar.fireAction({
      'data-action': 'review-recovery-intent-server',
    });
    expect(reviewServer).toHaveBeenCalledWith(continuation);
    expect(review).not.toHaveBeenCalled();
    expect(handle.isOpen()).toBe(false);
    expect(handle.getRecoveryIntentContinuation()).toEqual(continuation);

    const serverOutcome: AttentionRecoveryIntentContinuation = {
      ...continuation,
      phase: 'awaiting_review_outcome',
      reviewTarget: 'server',
    };
    handle.setRecoveryIntentContinuation(serverOutcome);
    topbar.fireAction({ 'data-action': 'open-attention' });
    expect(topbar.innerHTML).toContain(
      'data-phase="awaiting_review_outcome"',
    );
    expect(topbar.innerHTML).toContain('data-review-target="server"');
    expect(topbar.innerHTML).toContain(
      'What happened after reviewing Home &lt;private&gt;?',
    );
    expect(topbar.innerHTML).toContain(
      'Recued won’t assume the direct review fixed the issue',
    );
    expect(topbar.innerHTML).toContain(
      'Looks resolved &mdash; verify &amp; choose again',
    );
    expect(topbar.innerHTML).toContain(
      'aria-label="Looks resolved; verify Contracts on Home &lt;private&gt;, then choose again"',
    );
    expect(topbar.innerHTML).toContain(
      'Still blocked &mdash; keep reminder',
    );
    expect(topbar.innerHTML).toContain('Stop recovery');
    expect(topbar.innerHTML).not.toContain('Try again');
    expect(topbar.innerHTML).not.toContain(
      'data-action="review-recovery-intent-server"',
    );
    expect(topbar.innerHTML).not.toContain(
      'data-action="review-recovery-intent-continuation"',
    );
    expect(topbar.innerHTML).not.toContain(
      'data-action="resume-recovery-intent-continuation"',
    );
    expect(topbar.innerHTML).not.toContain('Home <private>');
    expect(ATTENTION_TOPBAR_STYLES).toContain(
      '[data-phase="awaiting_review_outcome"]',
    );
    expect(firstByAttr(
      root,
      ATTENTION_RECOVERY_EXCURSION_RETURN_ANNOUNCER_ATTR,
    )?.textContent).toBe(
      'Review outcome needed for Contracts. Choose the Looks resolved option to run one fresh check, or keep the reminder if it is still blocked.',
    );

    // Synthetic stale actions cannot escape the explicit outcome handoff.
    topbar.fireAction({
      'data-action': 'resume-recovery-intent-continuation',
    });
    topbar.fireAction({
      'data-action': 'review-recovery-intent-continuation',
    });
    topbar.fireAction({
      'data-action': 'review-recovery-intent-server',
    });
    expect(resume).not.toHaveBeenCalled();
    expect(review).not.toHaveBeenCalled();
    expect(reviewServer).toHaveBeenCalledOnce();

    topbar.fireAction({
      'data-action': 'keep-recovery-intent-review-blocked',
    });
    expect(keepBlocked).toHaveBeenCalledWith(serverOutcome);
    expect(handle.isOpen()).toBe(false);
    expect(handle.getRecoveryIntentContinuation()).toEqual(serverOutcome);

    const receiptOutcome: AttentionRecoveryIntentContinuation = {
      ...serverOutcome,
      serverControlOutcome: {
        action: 'pause',
        phase: 'superseded',
        currentState: 'running',
      },
    };
    handle.setRecoveryIntentContinuation({
      ...receiptOutcome,
      serverControlOutcome: {
        ...receiptOutcome.serverControlOutcome!,
        detail: 'private transport detail',
      } as NonNullable<
        AttentionRecoveryIntentContinuation['serverControlOutcome']
      > & { readonly detail: string },
    });
    expect(handle.getRecoveryIntentContinuation()).toEqual(receiptOutcome);
    topbar.fireAction({ 'data-action': 'open-attention' });
    expect(topbar.innerHTML).toContain(
      `${ATTENTION_RECOVERY_INTENT_SERVER_OUTCOME_ATTR}="superseded"`,
    );
    expect(topbar.innerHTML).toContain(
      'data-server-control-action="pause"',
    );
    expect(topbar.innerHTML).toContain(
      'data-server-control-state="running"',
    );
    expect(topbar.innerHTML).toContain('Server state changed after Pause');
    expect(topbar.innerHTML).toContain(
      'Pause completed, but a newer status from Home &lt;private&gt; reports a different execution state.',
    );
    expect(topbar.innerHTML).toContain(
      'Latest known state: execution is running.',
    );
    expect(topbar.innerHTML).toContain(
      'This server result does not verify Contracts.',
    );
    expect(topbar.innerHTML).toContain('Pause will not replay.');
    expect(topbar.innerHTML).toContain(
      'Verify Contracts &amp; choose again',
    );
    expect(topbar.innerHTML).toContain(
      'aria-label="Verify Contracts on Home &lt;private&gt;, then choose again; Pause will not replay"',
    );
    expect(topbar.innerHTML).not.toContain(
      'What happened after reviewing',
    );
    expect(topbar.innerHTML).not.toContain('private transport detail');
    expect(firstByAttr(
      root,
      ATTENTION_RECOVERY_EXCURSION_RETURN_ANNOUNCER_ATTR,
    )?.textContent).toBe(
      'Server state changed after Pause on Home <private>. This server result does not verify Contracts. Run one fresh Contracts check before choosing again; Pause will not replay.',
    );
    topbar.fireAction({
      'data-action': 'keep-recovery-intent-review-blocked',
    });
    expect(keepBlocked).toHaveBeenLastCalledWith(receiptOutcome);
    expect(handle.isOpen()).toBe(false);
    expect(handle.getRecoveryIntentContinuation()).toEqual(receiptOutcome);

    // A baseline belongs only to an unresolved historical receipt. Ignore a
    // malformed/redundant observation attached to an already settled result.
    handle.setRecoveryIntentContinuation({
      ...receiptOutcome,
      serverCurrentState: { state: 'paused' },
    });
    expect(handle.getRecoveryIntentContinuation()).toEqual(receiptOutcome);

    const pendingReceiptOutcome: AttentionRecoveryIntentContinuation = {
      ...serverOutcome,
      serverControlOutcome: {
        action: 'restart',
        phase: 'pending',
      },
    };
    handle.setRecoveryIntentContinuation(pendingReceiptOutcome);
    topbar.fireAction({ 'data-action': 'open-attention' });
    expect(topbar.innerHTML).toContain('Restart was still pending');
    expect(topbar.innerHTML).toContain(
      'The last receipt from Home &lt;private&gt; had not confirmed the Restart request.',
    );
    expect(topbar.innerHTML).toContain(
      'Review Home &lt;private&gt; again to compare its current live state with this receipt',
    );
    expect(topbar.innerHTML).toContain('Review server again');
    expect(topbar.innerHTML).toContain('Verify Contracts instead');
    expect(topbar.innerHTML).not.toContain(
      'Still blocked &mdash; keep reminder',
    );
    expect(firstByAttr(
      root,
      ATTENTION_RECOVERY_EXCURSION_RETURN_ANNOUNCER_ATTR,
    )?.textContent).toBe(
      'Restart was still pending on Home <private>. Review that exact server again, or verify Contracts instead before choosing again. Restart will not replay.',
    );
    expect(topbar.innerHTML).not.toContain('Restart is still pending');
    topbar.fireAction({
      'data-action': 'review-recovery-intent-server',
    });
    expect(reviewServer).toHaveBeenLastCalledWith(pendingReceiptOutcome);
    expect(handle.isOpen()).toBe(false);

    const reconciledReceiptOutcome: AttentionRecoveryIntentContinuation = {
      ...pendingReceiptOutcome,
      serverCurrentState: { state: 'running' },
    };
    handle.setRecoveryIntentContinuation(reconciledReceiptOutcome);
    topbar.fireAction({ 'data-action': 'open-attention' });
    expect(topbar.innerHTML).toContain(
      `${ATTENTION_RECOVERY_INTENT_SERVER_STATE_ATTR}="running"`,
    );
    expect(topbar.innerHTML).toContain('Current server state: running');
    expect(topbar.innerHTML).toContain(
      'The exact review received a fresh status from Home &lt;private&gt; reporting that execution was running.',
    );
    expect(topbar.innerHTML).toContain(
      'does not prove the earlier Restart request started a fresh process',
    );
    expect(topbar.innerHTML).toContain(
      'Verify Contracts &amp; choose again',
    );
    expect(topbar.innerHTML).toContain(
      'Still blocked &mdash; keep reminder',
    );
    expect(topbar.innerHTML).not.toContain('Review server again');
    expect(topbar.innerHTML).not.toContain('Verify Contracts instead');
    expect(firstByAttr(
      root,
      ATTENTION_RECOVERY_EXCURSION_RETURN_ANNOUNCER_ATTR,
    )?.textContent).toBe(
      'Latest review of Home <private> found execution running. The earlier Restart result remains historical. Run one fresh Contracts check before choosing again; Restart will not replay.',
    );
    topbar.fireAction({
      'data-action': 'resolve-recovery-intent-review',
    });
    expect(resolveReview).toHaveBeenLastCalledWith(
      reconciledReceiptOutcome,
    );
    expect(handle.isOpen()).toBe(false);

    const areaOutcome: AttentionRecoveryIntentContinuation = {
      ...serverOutcome,
      reviewTarget: 'area',
    };
    handle.setRecoveryIntentContinuation(areaOutcome);
    topbar.fireAction({ 'data-action': 'open-attention' });
    expect(topbar.innerHTML).toContain(
      'What happened after reviewing Contracts?',
    );
    topbar.fireAction({
      'data-action': 'resolve-recovery-intent-review',
    });
    expect(resolveReview).toHaveBeenCalledWith(areaOutcome);
    expect(handle.isOpen()).toBe(false);

    topbar.fireAction({ 'data-action': 'open-attention' });
    topbar.fireAction({
      'data-action': 'dismiss-recovery-intent-continuation',
    });
    expect(dismiss).toHaveBeenCalledOnce();
    expect(handle.getRecoveryIntentContinuation()).toBeNull();
    handle.dispose();

    const routeOnly = mountFor({
      rows: () => [],
      asks: () => [],
      initialRecoveryIntentContinuation: continuation,
      onResumeRecoveryIntentContinuation: resume,
      onReviewRecoveryIntentContinuation: review,
    });
    await routeOnly.handle.whenLoaded();
    routeOnly.topbar.fireAction({ 'data-action': 'open-attention' });
    expect(routeOnly.topbar.innerHTML).toContain(
      'Review Contracts directly before choosing again',
    );
    expect(routeOnly.topbar.innerHTML).not.toContain('Review server');
    expect(routeOnly.topbar.innerHTML).not.toContain(
      'or Home &lt;private&gt; directly',
    );
    routeOnly.handle.dispose();
  });

  it('fails closed to route review when no authoritative retry exists', async () => {
    const continuation: AttentionRecoveryIntentContinuation = {
      serverProfileId: 'profile-home',
      serverProfileLabel: 'Home server',
      landingHash: '#settings',
      areaLabel: 'Settings',
      intent: 'continue',
      phase: 'failed',
      remediation: 'review',
    };
    const review = vi.fn(() => 'started' as const);
    const resume = vi.fn(() => 'unavailable' as const);
    const { root, topbar, handle } = mountFor({
      rows: () => [],
      asks: () => [],
      initialRecoveryIntentContinuation: continuation,
      onResumeRecoveryIntentContinuation: resume,
      onReviewRecoveryIntentContinuation: review,
    });
    await handle.whenLoaded();

    topbar.fireAction({ 'data-action': 'open-attention' });
    expect(topbar.innerHTML).toContain('data-remediation="review"');
    expect(topbar.innerHTML).toContain('Review Settings before continuing');
    expect(topbar.innerHTML).toContain('Review Settings');
    expect(topbar.innerHTML).not.toContain('Try again');
    expect(topbar.innerHTML).not.toContain('Review connection');
    expect(ATTENTION_TOPBAR_STYLES).toContain(
      '[data-phase="failed"][data-remediation="review"]',
    );
    expect(firstByAttr(
      root,
      ATTENTION_RECOVERY_EXCURSION_RETURN_ANNOUNCER_ATTR,
    )?.textContent).toBe(
      'Settings cannot be safely rechecked here. Review the current area before continuing.',
    );

    // A stale/synthetic retry activation cannot bypass the closed-list
    // review-only remediation selected by bootstrap.
    topbar.fireAction({
      'data-action': 'resume-recovery-intent-continuation',
    });
    expect(resume).not.toHaveBeenCalled();
    expect(handle.isOpen()).toBe(true);
    topbar.fireAction({
      'data-action': 'review-recovery-intent-continuation',
    });
    expect(review).toHaveBeenCalledWith(continuation);
    expect(resume).not.toHaveBeenCalled();
    expect(handle.isOpen()).toBe(false);
    handle.dispose();
  });

  it('restores one privacy-safe exact-area check after reconciliation', async () => {
    const continuation: AttentionRecoveryIntentContinuation = {
      serverProfileId: 'profile-home',
      serverProfileLabel: 'Home <private>',
      landingHash: '#contracts',
      areaLabel: 'Contracts',
      intent: 'choose_again',
      phase: 'verification_ready',
      remediation: 'escalated',
      reviewTarget: 'server',
    };
    const resolveReview = vi.fn(() => 'started' as const);
    const review = vi.fn(() => 'started' as const);
    const reviewServer = vi.fn(() => 'started' as const);
    const keepBlocked = vi.fn(() => 'started' as const);
    const deferVerification = vi.fn(
      (): 'started' | 'missing' | 'unavailable' => 'started',
    );
    deferVerification.mockReturnValueOnce('unavailable');
    const dismiss = vi.fn();
    const { root, topbar, handle } = mountFor({
      rows: () => [],
      asks: () => [],
      initialRecoveryIntentContinuation: {
        ...continuation,
        // Memory-only reconciliation material must be discarded even if a
        // stale caller tries to attach it to the restored phase.
        serverControlOutcome: {
          action: 'restart',
          phase: 'pending',
        },
        serverCurrentState: { state: 'running' },
      },
      onResumeRecoveryIntentContinuation: vi.fn(() => 'started' as const),
      onResolveRecoveryIntentReview: resolveReview,
      onReviewRecoveryIntentContinuation: review,
      onReviewRecoveryIntentServer: reviewServer,
      onKeepRecoveryIntentReviewBlocked: keepBlocked,
      onDeferRecoveryIntentVerification: deferVerification,
      onDismissRecoveryIntentContinuation: dismiss,
    });
    await handle.whenLoaded();

    expect(handle.getRecoveryIntentContinuation()).toEqual(continuation);
    topbar.fireAction({ 'data-action': 'open-attention' });
    expect(topbar.innerHTML).toContain('data-phase="verification_ready"');
    expect(topbar.innerHTML).toContain('data-review-target="server"');
    expect(topbar.innerHTML).toContain('Finish checking Contracts');
    expect(topbar.innerHTML).toContain(
      'The server re-review finished, but the final Contracts check did not',
    );
    expect(topbar.innerHTML).toContain(
      'restored only where to return and that you wanted to choose again',
    );
    expect(topbar.innerHTML).toContain(
      'not the server action, receipt, current state, or credentials',
    );
    expect(topbar.innerHTML).toContain('Check Contracts now');
    expect(topbar.innerHTML).toContain('Keep for later');
    expect(topbar.innerHTML).toContain(
      'aria-label="Keep the Contracts check for later on Home &lt;private&gt;"',
    );
    expect(topbar.innerHTML).not.toContain(
      ATTENTION_RECOVERY_INTENT_SERVER_OUTCOME_ATTR,
    );
    expect(topbar.innerHTML).not.toContain(
      ATTENTION_RECOVERY_INTENT_SERVER_STATE_ATTR,
    );
    expect(topbar.innerHTML).not.toContain('Restart was still pending');
    expect(topbar.innerHTML).not.toContain('Current server state: running');
    expect(firstByAttr(
      root,
      ATTENTION_RECOVERY_EXCURSION_RETURN_ANNOUNCER_ATTR,
    )?.textContent).toBe(
      'One fresh Contracts check remains. Only the saved return was restored—not the server action, receipt, current state, or credentials. Check the area now or keep it for later; nothing will replay.',
    );
    expect(ATTENTION_TOPBAR_STYLES).toContain(
      '[data-phase="verification_ready"]',
    );

    // The restored marker offers only the route-owned check or explicit stop;
    // synthetic direct-review/outcome actions cannot bypass that boundary.
    topbar.fireAction({
      'data-action': 'review-recovery-intent-server',
    });
    topbar.fireAction({
      'data-action': 'review-recovery-intent-continuation',
    });
    topbar.fireAction({
      'data-action': 'keep-recovery-intent-review-blocked',
    });
    expect(reviewServer).not.toHaveBeenCalled();
    expect(review).not.toHaveBeenCalled();
    expect(keepBlocked).not.toHaveBeenCalled();

    topbar.fireAction({
      'data-action': 'defer-recovery-intent-verification',
    });
    expect(deferVerification).toHaveBeenCalledWith(continuation);
    expect(handle.isOpen()).toBe(true);
    expect(handle.getRecoveryIntentContinuation()).toEqual(continuation);
    expect(topbar.innerHTML).toContain(
      'That check couldn’t be kept for later right now',
    );
    expect(topbar.innerHTML).toContain(
      'It remains here unchanged; no check or prior action ran',
    );
    expect(dismiss).not.toHaveBeenCalled();

    topbar.fireAction({
      'data-action': 'defer-recovery-intent-verification',
    });
    expect(deferVerification).toHaveBeenCalledTimes(2);
    expect(handle.isOpen()).toBe(false);
    expect(handle.getRecoveryIntentContinuation()).toEqual(continuation);
    expect(dismiss).not.toHaveBeenCalled();

    // Deferral is visibly reversible from the bell and cannot silently turn
    // into either the check or the destructive Stop recovery action.
    topbar.fireAction({ 'data-action': 'open-attention' });
    expect(handle.isOpen()).toBe(true);
    expect(topbar.innerHTML).toContain('data-phase="verification_ready"');
    expect(topbar.innerHTML).toContain('Keep for later');
    expect(resolveReview).not.toHaveBeenCalled();
    topbar.fireAction({
      'data-action': 'resolve-recovery-intent-review',
    });
    expect(resolveReview).toHaveBeenCalledWith(continuation);
    expect(handle.isOpen()).toBe(false);
    handle.setRecoveryIntentContinuation({
      ...continuation,
      reviewTarget: 'area',
    });
    expect(handle.getRecoveryIntentContinuation()).toBeNull();
    handle.dispose();
  });

  it('never renders an ownerless exact-area defer action', async () => {
    const continuation: AttentionRecoveryIntentContinuation = {
      serverProfileId: 'profile-home',
      serverProfileLabel: 'Home server',
      landingHash: '#contracts',
      areaLabel: 'Contracts',
      intent: 'choose_again',
      phase: 'verification_ready',
      remediation: 'escalated',
      reviewTarget: 'server',
    };
    const { topbar, handle } = mountFor({
      rows: () => [],
      asks: () => [],
      initialRecoveryIntentContinuation: continuation,
      onResumeRecoveryIntentContinuation: vi.fn(() => 'started' as const),
      onResolveRecoveryIntentReview: vi.fn(() => 'started' as const),
      // Deliberately omit onDeferRecoveryIntentVerification. A durable card
      // without an owner would promise a Keep for later action that can only
      // fail after activation.
    });
    await handle.whenLoaded();

    expect(handle.getRecoveryIntentContinuation()).toBeNull();
    topbar.fireAction({ 'data-action': 'open-attention' });
    expect(topbar.innerHTML).not.toContain('verification_ready');
    expect(topbar.innerHTML).not.toContain(
      'data-action="defer-recovery-intent-verification"',
    );
    handle.dispose();
  });

  it('resurfaces a deferred exact-area check quietly with bounded timing', async () => {
    const now = 1_700_000_600_000;
    const continuation: AttentionRecoveryIntentContinuation = {
      serverProfileId: 'profile-home',
      serverProfileLabel: 'Home server',
      landingHash: '#contracts',
      areaLabel: 'Contracts',
      intent: 'choose_again',
      phase: 'verification_ready',
      remediation: 'escalated',
      reviewTarget: 'server',
      deferredAt: now - 5 * 60_000,
      expiresAt: now + 10 * 60_000,
    };
    const { root, topbar, handle } = mountFor({
      rows: () => [],
      asks: () => [],
      initialRecoveryIntentContinuation: continuation,
      onResumeRecoveryIntentContinuation: vi.fn(() => 'started' as const),
      onResolveRecoveryIntentReview: vi.fn(() => 'started' as const),
      onDeferRecoveryIntentVerification: vi.fn(() => 'started' as const),
      now: () => now,
    });
    await handle.whenLoaded();

    expect(topbar.innerHTML).not.toContain('top-bar-attention-badge');
    expect(topbar.innerHTML).toContain('top-bar-attention--saved');
    expect(topbar.innerHTML).not.toContain('top-bar-attention--ready');
    expect(topbar.innerHTML).toContain(
      'No items need your attention; 1 item saved for later',
    );
    topbar.fireAction({ 'data-action': 'open-attention' });
    expect(topbar.innerHTML).toContain('data-deferred="true"');
    expect(topbar.innerHTML).toContain('Contracts check kept for later');
    expect(topbar.innerHTML).toContain(
      'This exact check is saved quietly in this tab',
    );
    expect(topbar.innerHTML).toContain(
      'Kept for later 5 min ago · expires in 10 min',
    );
    expect(topbar.innerHTML).toContain(
      'A Contracts check is saved quietly for later',
    );
    expect(firstByAttr(
      root,
      ATTENTION_RECOVERY_EXCURSION_RETURN_ANNOUNCER_ATTR,
    )?.textContent).toBe('');
    handle.dispose();
  });

  it('makes expiry an intent-free one-shot broad-area handoff', async () => {
    const now = 1_700_002_100_000;
    const handoff: AttentionRecoveryIntentExpiryHandoff = {
      serverProfileId: 'profile-home',
      serverProfileLabel: 'Home <private>',
      landingHash: '#contracts',
      areaLabel: 'Contracts',
      deferredAt: now - 20 * 60_000,
      expiredAt: now - 5 * 60_000,
      phase: 'ready',
    };
    const review = vi.fn(
      (): 'started' | 'missing' | 'unavailable' => 'started',
    );
    review.mockReturnValueOnce('unavailable');
    const dismiss = vi.fn();
    const { root, topbar, handle } = mountFor({
      rows: () => [],
      asks: () => [],
      initialRecoveryIntentExpiryHandoff: handoff,
      onReviewRecoveryIntentExpiryHandoff: review,
      onDismissRecoveryIntentExpiryHandoff: dismiss,
      now: () => now,
    });
    await handle.whenLoaded();

    expect(topbar.innerHTML).not.toContain('top-bar-attention-badge');
    expect(topbar.innerHTML).toContain('top-bar-attention--saved');
    expect(topbar.innerHTML).toContain('top-bar-attention--ready');
    expect(topbar.innerHTML).toContain(
      'No items need your attention; 1 saved item ready to review',
    );
    topbar.fireAction({ 'data-action': 'open-attention' });
    expect(topbar.innerHTML).toContain(
      ATTENTION_RECOVERY_INTENT_EXPIRY_HANDOFF_ATTR,
    );
    expect(topbar.innerHTML).toContain('Saved Contracts check expired');
    expect(topbar.innerHTML).toContain(
      'discarded the prior intent and unfinished check',
    );
    expect(topbar.innerHTML).toContain(
      'Expired 5 min ago · exact return removed',
    );
    expect(topbar.innerHTML).toContain('Review current Contracts');
    expect(topbar.innerHTML).not.toContain('choose_again');
    expect(topbar.innerHTML).not.toContain('Home <private>');

    topbar.fireAction({
      'data-action': 'review-recovery-intent-expiry-handoff',
    });
    expect(review).toHaveBeenCalledWith(handoff);
    expect(handle.isOpen()).toBe(true);
    expect(handle.getRecoveryIntentExpiryHandoff()).toEqual(handoff);
    expect(topbar.innerHTML).toContain(
      'The expired check remains discarded',
    );

    topbar.fireAction({
      'data-action': 'review-recovery-intent-expiry-handoff',
    });
    expect(handle.isOpen()).toBe(false);
    expect(handle.getRecoveryIntentExpiryHandoff()).toBeNull();
    expect(dismiss).not.toHaveBeenCalled();

    handle.setRecoveryIntentExpiryHandoff({
      ...handoff,
      landingHash: '#contracts/private-contract',
    });
    expect(handle.getRecoveryIntentExpiryHandoff()).toBeNull();

    handle.setRecoveryIntentExpiryHandoff({
      ...handoff,
      retryReason: 'offline',
    });
    expect(handle.getRecoveryIntentExpiryHandoff()).toBeNull();
    handle.setRecoveryIntentExpiryHandoff(null);

    handle.setRecoveryIntentExpiryHandoff({
      ...handoff,
      phase: 'retry',
      retryReason: 'offline',
    });
    expect(firstByAttr(
      root,
      ATTENTION_RECOVERY_EXCURSION_RETURN_ANNOUNCER_ATTR,
    )?.textContent).toBe('');
    expect(topbar.innerHTML).toContain('top-bar-attention--retry');
    expect(topbar.innerHTML).toContain(
      'No items need your attention; 1 saved review needs retry',
    );
    topbar.fireAction({ 'data-action': 'open-attention' });
    expect(topbar.innerHTML).toContain('data-phase="retry"');
    expect(topbar.innerHTML).toContain('data-retry-reason="offline"');
    expect(topbar.innerHTML).toContain('Contracts couldn’t be refreshed');
    expect(topbar.innerHTML).toContain('Home &lt;private&gt; is offline');
    expect(topbar.innerHTML).toContain('Retry current Contracts');
    expect(topbar.innerHTML).not.toContain('Home <private>');

    handle.setRecoveryIntentExpiryHandoff({
      ...handoff,
      phase: 'handoff',
      diagnosisTarget: 'area',
    });
    expect(topbar.innerHTML).toContain('top-bar-attention--diagnosis');
    expect(topbar.innerHTML).toContain(
      'No items need your attention; 1 saved review needs diagnosis',
    );
    expect(topbar.innerHTML).toContain('data-phase="handoff"');
    expect(topbar.innerHTML).toContain('data-diagnosis-target="area"');
    expect(topbar.innerHTML).toContain('Contracts needs direct review');
    expect(topbar.innerHTML).toContain('Open current Contracts');
    expect(topbar.innerHTML).not.toContain('Retry current Contracts');

    handle.setRecoveryIntentExpiryHandoff({
      ...handoff,
      phase: 'handoff',
      diagnosisTarget: 'server',
    });
    expect(topbar.innerHTML).toContain(
      'Home &lt;private&gt; needs connection review',
    );
    expect(topbar.innerHTML).toContain('Review server connection');
    expect(topbar.innerHTML).toContain(
      'Review Home &lt;private&gt; server connection',
    );
    expect(topbar.innerHTML).toContain(
      'stopped after two connection-blocked checks',
    );

    handle.setRecoveryIntentExpiryHandoff({
      ...handoff,
      phase: 'outcome',
    });
    expect(topbar.innerHTML).toContain('top-bar-attention--decision');
    expect(topbar.innerHTML).toContain(
      'No items need your attention; 1 saved review needs a decision',
    );
    expect(topbar.innerHTML).toContain('data-phase="outcome"');
    expect(topbar.innerHTML).toContain(
      'Contracts is ready for one fresh check',
    );
    expect(topbar.innerHTML).toContain('Check current Contracts once');
    expect(topbar.innerHTML).toContain('Close review');
    expect(topbar.innerHTML).not.toContain('data-diagnosis-target');

    handle.setRecoveryIntentExpiryHandoff({
      ...handoff,
      phase: 'outcome',
      checkBlocker: 'server',
    });
    expect(topbar.innerHTML).toContain('data-check-blocker="server"');
    expect(topbar.innerHTML).toContain(
      'Reconnect Home &lt;private&gt; before the fresh check',
    );
    expect(topbar.innerHTML).toContain('Waiting for server');
    expect(topbar.innerHTML).toContain('disabled');
    expect(topbar.innerHTML).toContain(
      'reconnect will not start it',
    );

    handle.setRecoveryIntentExpiryHandoff({
      ...handoff,
      phase: 'rechecking',
    });
    expect(topbar.innerHTML).toContain('data-phase="rechecking"');
    expect(topbar.innerHTML).toContain('aria-busy="true"');
    expect(topbar.innerHTML).toContain('Checking current Contracts once');
    expect(topbar.innerHTML).toContain('Stop and close');
    expect(topbar.innerHTML).not.toContain(
      'data-action="review-recovery-intent-expiry-handoff"',
    );

    handle.setRecoveryIntentExpiryHandoff({
      ...handoff,
      phase: 'closure',
      closureTarget: 'area',
    });
    expect(topbar.innerHTML).toContain('top-bar-attention--closure');
    expect(topbar.innerHTML).toContain(
      'No items need your attention; 1 saved review needs closure',
    );
    expect(topbar.innerHTML).toContain('data-phase="closure"');
    expect(topbar.innerHTML).toContain('data-closure-target="area"');
    expect(topbar.innerHTML).toContain(
      'Current Contracts remains unconfirmed',
    );
    expect(topbar.innerHTML).toContain('Open current Contracts');
    expect(topbar.innerHTML).toContain('Close review');
    topbar.fireAction({
      'data-action': 'dismiss-recovery-intent-expiry-handoff',
    });
    expect(dismiss).toHaveBeenCalledOnce();
    expect(handle.getRecoveryIntentExpiryHandoff()).toBeNull();
    handle.dispose();
  });

  it('announces only user-started expired-area checking and retry transitions', async () => {
    const now = 1_700_002_100_000;
    const handoff: AttentionRecoveryIntentExpiryHandoff = {
      serverProfileId: 'profile-home',
      serverProfileLabel: 'Home server',
      landingHash: '#contracts',
      areaLabel: 'Contracts',
      deferredAt: now - 20 * 60_000,
      expiredAt: now - 5 * 60_000,
      phase: 'ready',
    };
    let publishChecking = (): void => undefined;
    const { root, topbar, handle } = mountFor({
      rows: () => [],
      asks: () => [],
      initialRecoveryIntentExpiryHandoff: handoff,
      onReviewRecoveryIntentExpiryHandoff: () => {
        publishChecking();
        return 'started';
      },
      onDismissRecoveryIntentExpiryHandoff: vi.fn(),
      now: () => now,
    });
    publishChecking = () => handle.setRecoveryIntentExpiryHandoff({
      ...handoff,
      phase: 'checking',
    });
    await handle.whenLoaded();

    const announcer = firstByAttr(
      root,
      ATTENTION_RECOVERY_EXCURSION_RETURN_ANNOUNCER_ATTR,
    )!;
    expect(announcer.textContent).toBe('');
    topbar.fireAction({ 'data-action': 'open-attention' });
    topbar.fireAction({
      'data-action': 'review-recovery-intent-expiry-handoff',
    });
    expect(handle.isOpen()).toBe(false);
    expect(handle.getRecoveryIntentExpiryHandoff()?.phase).toBe('checking');
    expect(topbar.innerHTML).toContain('top-bar-attention--checking');
    expect(topbar.innerHTML).toContain(
      'No items need your attention; 1 saved review is being checked',
    );
    expect(announcer.textContent).toContain('Checking current Contracts');

    handle.setRecoveryIntentExpiryHandoff({
      ...handoff,
      phase: 'retry',
      retryReason: 'unavailable',
    });
    expect(announcer.textContent).toContain(
      'Current Contracts could not be confirmed',
    );
    expect(announcer.textContent).toContain('nothing will run automatically');

    handle.setRecoveryIntentExpiryHandoff(null);
    expect(announcer.textContent).toBe('');
    handle.dispose();
  });

  it('keeps a blocking saved return ahead of a quiet expired review in spoken priority', async () => {
    const now = 1_700_002_100_000;
    const { root, topbar, handle } = mountFor({
      rows: () => [],
      asks: () => [],
      initialRecoveryExcursionReturn: {
        serverProfileId: 'profile-office',
        serverProfileLabel: 'Office server',
      },
      onReviewRecoveryExcursionReturn: vi.fn(() => 'opened' as const),
      initialRecoveryIntentExpiryHandoff: {
        serverProfileId: 'profile-home',
        serverProfileLabel: 'Home server',
        landingHash: '#contracts',
        areaLabel: 'Contracts',
        deferredAt: now - 20 * 60_000,
        expiredAt: now - 5 * 60_000,
        phase: 'retry',
        retryReason: 'unavailable',
      },
      onReviewRecoveryIntentExpiryHandoff: vi.fn(() => 'started' as const),
      onDismissRecoveryIntentExpiryHandoff: vi.fn(),
      now: () => now,
    });
    await handle.whenLoaded();

    topbar.fireAction({ 'data-action': 'open-attention' });
    const announcer = firstByAttr(
      root,
      ATTENTION_RECOVERY_EXCURSION_RETURN_ANNOUNCER_ATTR,
    )!;
    expect(announcer.textContent).toBe(
      'A saved return to Office server is ready to review.',
    );
    expect(announcer.textContent).not.toContain('Contracts');
    handle.dispose();
  });

  it('makes interrupted resolved verification an explicit safe re-entry', async () => {
    const areaInterrupted: AttentionRecoveryIntentContinuation = {
      serverProfileId: 'profile-home',
      serverProfileLabel: 'Home <private>',
      landingHash: '#contracts',
      areaLabel: 'Contracts',
      intent: 'choose_again',
      phase: 'verification_interrupted',
      remediation: 'escalated',
      reviewTarget: 'area',
      interruptionReason: 'connection',
    };
    const resolveReview = vi.fn(() => 'started' as const);
    const review = vi.fn(() => 'started' as const);
    const reviewServer = vi.fn(() => 'started' as const);
    const keepBlocked = vi.fn(() => 'started' as const);
    const deferVerification = vi.fn(() => 'started' as const);
    const dismiss = vi.fn();
    const { root, topbar, handle } = mountFor({
      rows: () => [],
      asks: () => [],
      initialRecoveryIntentContinuation: areaInterrupted,
      onResumeRecoveryIntentContinuation: vi.fn(() => 'started' as const),
      onResolveRecoveryIntentReview: resolveReview,
      onReviewRecoveryIntentContinuation: review,
      onReviewRecoveryIntentServer: reviewServer,
      onKeepRecoveryIntentReviewBlocked: keepBlocked,
      onDeferRecoveryIntentVerification: deferVerification,
      onDismissRecoveryIntentContinuation: dismiss,
    });
    await handle.whenLoaded();

    topbar.fireAction({ 'data-action': 'open-attention' });
    expect(topbar.innerHTML).toContain(
      'data-phase="verification_interrupted"',
    );
    expect(topbar.innerHTML).toContain('Verification was interrupted');
    expect(topbar.innerHTML).toContain(
      'Your “Looks resolved” outcome and exact return are still saved',
    );
    expect(topbar.innerHTML).toContain('It won’t retry on its own');
    expect(topbar.innerHTML).toContain('Retry verification');
    expect(topbar.innerHTML).toContain('Review Contracts');
    expect(topbar.innerHTML).toContain('Stop recovery');
    expect(topbar.innerHTML).not.toContain(
      'Looks resolved &mdash; verify',
    );
    expect(topbar.innerHTML).not.toContain(
      'Still blocked &mdash; keep reminder',
    );
    expect(topbar.innerHTML).not.toContain('Home <private>');
    expect(firstByAttr(
      root,
      ATTENTION_RECOVERY_EXCURSION_RETURN_ANNOUNCER_ATTR,
    )?.textContent).toBe(
      'Verification of Contracts was interrupted. It won’t retry on its own. Retry verification, review Contracts again, or stop recovery.',
    );
    expect(ATTENTION_TOPBAR_STYLES).toContain(
      '[data-phase="verification_interrupted"]',
    );

    // Only the persisted target's direct-review action is valid.
    topbar.fireAction({
      'data-action': 'review-recovery-intent-server',
    });
    topbar.fireAction({
      'data-action': 'keep-recovery-intent-review-blocked',
    });
    topbar.fireAction({
      'data-action': 'defer-recovery-intent-verification',
    });
    expect(reviewServer).not.toHaveBeenCalled();
    expect(keepBlocked).not.toHaveBeenCalled();
    expect(deferVerification).not.toHaveBeenCalled();
    topbar.fireAction({
      'data-action': 'review-recovery-intent-continuation',
    });
    expect(review).toHaveBeenCalledWith(areaInterrupted);
    expect(handle.isOpen()).toBe(false);

    const serverInterrupted: AttentionRecoveryIntentContinuation = {
      ...areaInterrupted,
      reviewTarget: 'server',
    };
    handle.setRecoveryIntentContinuation(serverInterrupted);
    topbar.fireAction({ 'data-action': 'open-attention' });
    expect(topbar.innerHTML).toContain('Review server');
    expect(topbar.innerHTML).not.toContain(
      'data-action="review-recovery-intent-continuation"',
    );
    topbar.fireAction({
      'data-action': 'resolve-recovery-intent-review',
    });
    expect(resolveReview).toHaveBeenCalledWith(serverInterrupted);
    expect(handle.isOpen()).toBe(false);
    expect(dismiss).not.toHaveBeenCalled();
    handle.dispose();
  });

  it('bounds repeated verification interruptions with connection-first review', async () => {
    const handoff: AttentionRecoveryIntentContinuation = {
      serverProfileId: 'profile-home',
      serverProfileLabel: 'Home <private>',
      landingHash: '#contracts',
      areaLabel: 'Contracts',
      intent: 'choose_again',
      phase: 'verification_handoff',
      remediation: 'escalated',
      reviewTarget: 'area',
      interruptionReason: 'connection',
    };
    const resume = vi.fn(() => 'started' as const);
    const resolveReview = vi.fn(() => 'started' as const);
    const review = vi.fn(() => 'started' as const);
    const reviewServer = vi.fn(
      (): 'started' | 'unavailable' => 'started',
    );
    const { root, topbar, handle } = mountFor({
      rows: () => [],
      asks: () => [],
      initialRecoveryIntentContinuation: handoff,
      onResumeRecoveryIntentContinuation: resume,
      onResolveRecoveryIntentReview: resolveReview,
      onReviewRecoveryIntentContinuation: review,
      onReviewRecoveryIntentServer: reviewServer,
    });
    await handle.whenLoaded();

    topbar.fireAction({ 'data-action': 'open-attention' });
    expect(topbar.innerHTML).toContain('data-phase="verification_handoff"');
    expect(topbar.innerHTML).toContain(
      'Review the connection before another check',
    );
    expect(topbar.innerHTML).toContain(
      'Two verification attempts did not finish safely',
    );
    expect(topbar.innerHTML).toContain('stopped the retry loop');
    expect(topbar.innerHTML).toContain('Review connection');
    expect(topbar.innerHTML).toContain('Review Contracts');
    expect(topbar.innerHTML).toContain('Stop recovery');
    expect(topbar.innerHTML).not.toContain('Retry verification');
    expect(topbar.innerHTML).not.toContain('Looks resolved');
    expect(topbar.innerHTML).not.toContain('Home <private>');
    expect(firstByAttr(
      root,
      ATTENTION_RECOVERY_EXCURSION_RETURN_ANNOUNCER_ATTR,
    )?.textContent).toBe(
      'Verification of Contracts was interrupted twice. Recued stopped the retry loop. Review the Home <private> connection or Contracts, or stop recovery.',
    );

    // The closed-list reason participates in presentation identity. A later
    // interruption must update the cue even when phase, target, and route stay
    // unchanged through a live shell render.
    const navigationHandoff: AttentionRecoveryIntentContinuation = {
      ...handoff,
      interruptionReason: 'navigation',
    };
    handle.setRecoveryIntentContinuation(navigationHandoff);
    expect(topbar.innerHTML).toContain('Verification keeps getting interrupted');
    expect(topbar.innerHTML).not.toContain(
      'Review the connection before another check',
    );
    handle.setRecoveryIntentContinuation(handoff);
    expect(topbar.innerHTML).toContain(
      'Review the connection before another check',
    );

    // A synthetic stale outcome/retry cannot bypass the connection-aware cap.
    topbar.fireAction({
      'data-action': 'resolve-recovery-intent-review',
    });
    topbar.fireAction({
      'data-action': 'resume-recovery-intent-continuation',
    });
    expect(resolveReview).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
    expect(handle.isOpen()).toBe(true);

    topbar.fireAction({
      'data-action': 'review-recovery-intent-server',
    });
    expect(reviewServer).toHaveBeenCalledWith(handoff);
    expect(review).not.toHaveBeenCalled();
    expect(handle.isOpen()).toBe(false);

    reviewServer.mockReturnValue('unavailable');
    handle.open();
    expect(handle.isOpen()).toBe(true);
    topbar.fireAction({
      'data-action': 'review-recovery-intent-server',
    });
    expect(handle.isOpen()).toBe(true);
    expect(topbar.innerHTML).toContain(
      'review Contracts instead, or stop recovery',
    );
    handle.dispose();

    // A degraded shell without Account must not advertise an unavailable
    // connection action; the route-owned review becomes the honest primary.
    const areaOnly = mountFor({
      rows: () => [],
      asks: () => [],
      initialRecoveryIntentContinuation: handoff,
      onResumeRecoveryIntentContinuation: resume,
      onReviewRecoveryIntentContinuation: review,
    });
    await areaOnly.handle.whenLoaded();
    areaOnly.topbar.fireAction({ 'data-action': 'open-attention' });
    expect(areaOnly.topbar.innerHTML).toContain(
      'Review Contracts before another check',
    );
    expect(areaOnly.topbar.innerHTML).toContain(
      'Review Contracts, then explicitly confirm the outcome',
    );
    expect(areaOnly.topbar.innerHTML).toContain(
      'review that area before another check',
    );
    expect(areaOnly.topbar.innerHTML).not.toContain(
      'Review the connection before another check',
    );
    expect(areaOnly.topbar.innerHTML).not.toContain(
      'data-action="review-recovery-intent-server"',
    );
    expect(firstByAttr(
      areaOnly.root,
      ATTENTION_RECOVERY_EXCURSION_RETURN_ANNOUNCER_ATTR,
    )?.textContent).toBe(
      'Verification of Contracts was interrupted twice. Recued stopped the retry loop. Review Contracts, or stop recovery.',
    );
    areaOnly.handle.dispose();

    const stopOnly = mountFor({
      rows: () => [],
      asks: () => [],
      initialRecoveryIntentContinuation: handoff,
      onResumeRecoveryIntentContinuation: resume,
    });
    await stopOnly.handle.whenLoaded();
    stopOnly.topbar.fireAction({ 'data-action': 'open-attention' });
    expect(stopOnly.topbar.innerHTML).toContain(
      'This view cannot open a safe review target',
    );
    expect(stopOnly.topbar.innerHTML).toContain(
      'keep the saved return for later or stop recovery',
    );
    expect(stopOnly.topbar.innerHTML).not.toContain(
      'data-action="review-recovery-intent-continuation"',
    );
    expect(stopOnly.topbar.innerHTML).not.toContain(
      'data-action="review-recovery-intent-server"',
    );
    expect(firstByAttr(
      stopOnly.root,
      ATTENTION_RECOVERY_EXCURSION_RETURN_ANNOUNCER_ATTR,
    )?.textContent).toBe(
      'Verification of Contracts was interrupted twice. Recued stopped the retry loop. Keep the saved return for later, or stop recovery.',
    );
    stopOnly.handle.dispose();

    const serverOnlyHandoff: AttentionRecoveryIntentContinuation = {
      ...handoff,
      reviewTarget: 'server',
      interruptionReason: 'reload',
    };
    const unavailableServer = mountFor({
      rows: () => [],
      asks: () => [],
      initialRecoveryIntentContinuation: serverOnlyHandoff,
      onResumeRecoveryIntentContinuation: resume,
      onReviewRecoveryIntentServer: vi.fn(() => 'unavailable' as const),
    });
    await unavailableServer.handle.whenLoaded();
    unavailableServer.topbar.fireAction({ 'data-action': 'open-attention' });
    unavailableServer.topbar.fireAction({
      'data-action': 'review-recovery-intent-server',
    });
    expect(unavailableServer.handle.isOpen()).toBe(true);
    expect(unavailableServer.topbar.innerHTML).toContain(
      'keep it for later, or stop recovery',
    );
    expect(unavailableServer.topbar.innerHTML).not.toContain(
      'review Contracts instead',
    );
    unavailableServer.handle.dispose();
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
    expect(topbar.innerHTML).toContain(
      'Connected action &middot; Answer to continue',
    );
    expect(topbar.innerHTML).not.toContain('notification.pending_asks');
    expect(topbar.innerHTML).toContain(
      `${ATTENTION_GATEWAY_ASK_ROW_ATTR}="gw-reception-inbox-preflight"`,
    );
    handle.dispose();
  });

  it('collapses the argument payload behind a counted disclosure', async () => {
    // A real intake hold pushed the Approve button below a dozen lines of
    // identifiers. The question stays in the open; the payload is one
    // click away — the shape `renderAskCard` already gives the #approvals
    // queue and the Bridge panel.
    const { topbar, handle } = mountFor({
      rows: () => [],
      asks: () => [
        ask('gw-payload', {
          title: 'Approve mail-send (write)',
          text: [
            'Recipe send-email wants to run mail-send (step send).',
            'Write actions change data outside Recued, so Recued held it for you.',
            '',
            '  to: sam.rivera@meridian-systems.example',
            '  subject: Re: Renewal',
            '  not set: cc, bcc, attachments',
            '',
            'Approve?',
          ].join('\n'),
        }),
      ],
    });
    await handle.whenLoaded();

    topbar.fireAction({ 'data-action': 'open-attention' });
    const html = topbar.innerHTML;

    expect(html).toContain('<summary>Details (3)</summary>');
    // COLLAPSED, NOT DROPPED — the owner decides which fields matter, so
    // every one of them is still on the surface where they answer.
    expect(html).toContain('sam.rivera@meridian-systems.example');
    expect(html).toContain('not set: cc, bcc, attachments');
    // The question the buttons answer is composed LAST for a reason: it
    // must not end up behind the disclosure with the payload.
    const detailsAt = html.indexOf('attention-row-payload');
    expect(html.indexOf('Approve?')).toBeLessThan(detailsAt);
    handle.dispose();
  });

  it('counts FIELDS behind the disclosure, not group headers', async () => {
    // `metadata:` opens a block and carries no value of its own. Counting
    // it would promise one more thing behind the disclosure than there is
    // — and the count is the only thing a reader has to judge a collapsed
    // payload by before deciding whether to open it.
    const { topbar, handle } = mountFor({
      rows: () => [],
      asks: () => [
        ask('gw-grouped', {
          title: 'Approve intake.materialize (write)',
          text: [
            'Recipe intake wants to run intake.materialize (step go).',
            '',
            '  title: Dana Whitfield',
            '  metadata:',
            '    timeline: asap',
            '    budget_range: under_10k',
            '',
            'Approve?',
          ].join('\n'),
        }),
      ],
    });
    await handle.whenLoaded();

    topbar.fireAction({ 'data-action': 'open-attention' });

    expect(topbar.innerHTML).toContain('<summary>Details (3)</summary>');
    // The header and its leaves all survive into the disclosure.
    expect(topbar.innerHTML).toContain('metadata:');
    expect(topbar.innerHTML).toContain('budget_range: under_10k');
    handle.dispose();
  });

  it('leaves an ask with no indented payload exactly as it was', async () => {
    // The split is structural, so a custom ask or a peer's question — no
    // indented lines — renders with no disclosure at all rather than an
    // empty one.
    const { topbar, handle } = mountFor({
      rows: () => [],
      asks: () => [
        ask('gw-plain', {
          title: 'Review HubSpot write',
          text: 'Allow update to HubSpot contact?',
        }),
      ],
    });
    await handle.whenLoaded();

    topbar.fireAction({ 'data-action': 'open-attention' });

    expect(topbar.innerHTML).toContain('Allow update to HubSpot contact?');
    expect(topbar.innerHTML).not.toContain('attention-row-payload');
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
    expect(topbar.innerHTML).toContain(
      'Connected action &middot; Answer to continue',
    );
    expect(topbar.innerHTML).not.toContain('notification.pending_asks');
    expect(topbar.innerHTML).toContain(
      `${ATTENTION_GATEWAY_ASK_ROW_ATTR}="gw-1"`,
    );
    expect(topbar.innerHTML).toContain('data-action="gateway-ask-answer"');
    expect(topbar.innerHTML).toContain(
      'aria-label="Approve: Review HubSpot write"',
    );
    expect(topbar.innerHTML).toContain(ATTENTION_SEE_ALL_LINK_ATTR);
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
    expect(topbar.innerHTML).toContain('You&rsquo;re all caught up');
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

  it('reports an unresolved inline decision as in-flight work', async () => {
    let rows: ReadonlyArray<ServerPendingApproval> = [approval('ap-owned')];
    let resolveDecision!: () => void;
    const decision = new Promise<void>((resolve) => {
      resolveDecision = resolve;
    });
    const { topbar, handle } = mountFor({
      rows: () => rows,
      runApprovalResolve: vi.fn(async (args) => {
        await decision;
        rows = [];
        return { approval_id: args.approval_id, accepted: true as const };
      }),
    });
    await handle.whenLoaded();
    topbar.fireAction({ 'data-action': 'open-attention' });
    expect(handle.hasInFlightWork()).toBe(false);

    topbar.fireAction({
      'data-action': 'approval-decide-server',
      'data-approval-id': 'ap-owned',
      'data-decision': 'approve',
    });
    expect(handle.hasInFlightWork()).toBe(true);

    resolveDecision();
    await tick(12);
    expect(handle.hasInFlightWork()).toBe(false);
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
    expect(topbar.innerHTML).toContain('You&rsquo;re all caught up');
    expect(topbar.innerHTML).not.toContain('top-bar-attention-badge');
    handle.dispose();
  });

  it('renders a calm all-caught-up state when no decision is pending', async () => {
    const { topbar, handle } = mountFor({ rows: () => [] });
    await handle.whenLoaded();

    topbar.fireAction({ 'data-action': 'open-attention' });

    expect(topbar.innerHTML).toContain('You&rsquo;re all caught up');
    expect(topbar.innerHTML).toContain('No items are waiting on you.');
    expect(topbar.innerHTML).not.toContain('top-bar-attention-badge');
    handle.dispose();
  });

  it('removes the persistent host and unsubscribes on dispose', async () => {
    const { doc, root, handle, approvalChanged, sub } = mountFor();
    await handle.whenLoaded();
    expect(root.childList).toHaveLength(4);
    expect(firstByAttr(
      root,
      ATTENTION_RECOVERY_EXCURSION_RETURN_ANNOUNCER_ATTR,
    )).toBeDefined();

    handle.dispose();

    expect(root.childList).toHaveLength(0);
    expect(approvalChanged.unsubCount()).toBe(1);
    expect(sub.unsubCount()).toBe(3);
    expect(doc.listeners.get('click')?.size ?? 0).toBe(0);
    expect(doc.listeners.get('keydown')?.size ?? 0).toBe(0);
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

    expect(topbar.innerHTML).toContain('Run Mail send');
    expect(topbar.innerHTML).toContain('Chat approval &middot; Recipe');
    expect(topbar.innerHTML).toContain('aria-label="Approve: Mail send"');
    expect(topbar.innerHTML).toContain(
      'aria-label="Review Mail send in Chat"',
    );
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
    expect(topbar.innerHTML).not.toContain('You&rsquo;re all caught up');
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

  it('announces a resolution only when the attention handoff is visible', async () => {
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
    const announcer = firstByAttr(
      root,
      ATTENTION_CHAT_PLAN_RESOLUTION_ANNOUNCER_ATTR,
    )!;
    chatPlans.resolve('pl-tab', 'approved');
    expect(topbar.innerHTML).not.toContain(
      ATTENTION_CHAT_PLAN_RESOLUTION_ATTR,
    );
    expect(announcer.textContent).toBe('');

    topbar.fireAction({ 'data-action': 'open-attention' });
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
    expect(topbar.innerHTML).toContain('We couldn&rsquo;t verify the queue');
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

    expect(topbar.innerHTML).toContain('Review again: Mail send');
    expect(topbar.innerHTML).toContain('Fresh approval &middot; Recipe');
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
    const { root, topbar, handle } = mountFor({
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
    const errorAnnouncer = firstByAttr(
      root,
      ATTENTION_ERROR_ANNOUNCER_ATTR,
    )!;
    expect(errorAnnouncer.getAttribute('role')).toBe('status');
    expect(errorAnnouncer.getAttribute('aria-live')).toBe('polite');
    expect(errorAnnouncer.textContent).toContain('temporary resolve failure');
    expect(chatPlans.refresh).toHaveBeenCalledTimes(1);

    // Production equivalent: chat.plan_resolved arrives from another paired
    // client and the shared store removes the row + retains its outcome.
    chatPlans.resolve('pl-remote-resolve', 'cancelled');
    expect(topbar.innerHTML).not.toContain('temporary resolve failure');
    expect(errorAnnouncer.textContent).toBe('');
    expect(topbar.innerHTML).toContain('Rejected mail-send');
    expect(topbar.innerHTML).toContain(
      'The action will not run. Return to Chat if you want to adjust the request.',
    );
    expect(topbar.innerHTML).toContain(
      'href="#chat/session/s1/plan/pl-remote-resolve/answer/message-remote"',
    );
    expect(topbar.innerHTML).not.toContain('You&rsquo;re all caught up');

    topbar.fireAction({
      'data-action': 'dismiss-chat-plan-resolution',
      'data-plan-id': 'pl-remote-resolve',
    });
    expect(topbar.innerHTML).not.toContain(ATTENTION_CHAT_PLAN_RESOLUTION_ATTR);
    expect(topbar.innerHTML).toContain('You&rsquo;re all caught up');
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
    expect(topbar.innerHTML).toContain('Run Mail send');
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
