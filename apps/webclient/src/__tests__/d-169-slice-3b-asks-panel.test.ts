/** D-169 P2 Slice 3b — webclient Approvals (D-158 `ask`) panel tests.
 *
 *  The webclient peer of the bridge side-panel Approvals section. The
 *  shared `@recued/ui-shared/approval-card` primitive's own interactivity
 *  (click → onAnswer, double-click guard, reject → re-enable) is already
 *  covered by `packages/ui-shared/src/__tests__/d-169-approval-card.test.ts`;
 *  THIS file covers the PANEL: the seed load, the server-authoritative
 *  re-fetch model (bus frames + a submit both trigger a re-read), the
 *  `loadGeneration` stale-guard, retain-on-refresh-error, the submit
 *  round-trip wiring, and dispose. It also pins I-12 for the webclient:
 *  the panel renders each ask through the shared card (the rendered nodes
 *  carry `ASK_CARD_ATTR`), so a regression that swapped in a per-client
 *  card would fail here.
 *
 *  `renderAskCard` returns real `HTMLElement`s with click handlers and the
 *  panel rebuilds its content via `clearChildren` (`while (firstChild)
 *  removeChild`), so this uses an interactive fake document (the same
 *  shape as the bridge Slice-3 test, extended with `firstChild` +
 *  `removeChild`) rather than a string-assert harness — the repo ships no
 *  jsdom. */

import { describe, expect, it, vi } from 'vitest';

import {
  mountAsksPanel,
  ASKS_PANEL_HOST_ATTR,
  ASKS_PANEL_EMPTY_ATTR,
  ASKS_PANEL_ERROR_ATTR,
  ASKS_PANEL_LOADING_ATTR,
} from '../approvals/asks-panel.js';
import {
  ASK_CARD_ATTR,
  ASK_CARD_OPTION_ATTR,
} from '@recued/ui-shared/approval-card';
import type { ServerPendingAsk } from '@recued/contracts';
import type { BroadcastSubscriber } from '../realtime/subscriber.js';

// ════════════════════════════════════════════════════════════════
// Interactive fake DOM
// ════════════════════════════════════════════════════════════════

interface FakeEl {
  tagName: string;
  className: string;
  textContent: string;
  type: string;
  disabled: boolean;
  hidden: boolean;
  attrs: Map<string, string>;
  children: FakeEl[];
  listeners: Map<string, Array<() => void>>;
  readonly firstChild: FakeEl | null;
  setAttribute(k: string, v: string): void;
  getAttribute(k: string): string | null;
  appendChild(c: FakeEl): FakeEl;
  removeChild(c: FakeEl): FakeEl;
  addEventListener(type: string, fn: () => void): void;
  click(): void;
}

const makeFakeDocument = (): { createElement(tag: string): FakeEl } => ({
  createElement(tag: string): FakeEl {
    const el: FakeEl = {
      tagName: tag.toUpperCase(),
      className: '',
      textContent: '',
      type: '',
      disabled: false,
      hidden: false,
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
      click() {
        // A disabled button fires no click — mirror real DOM so the
        // in-flight guard is exercised honestly.
        if (el.disabled) return;
        for (const fn of el.listeners.get('click') ?? []) fn();
      },
    };
    return el;
  },
});

const collectByAttr = (root: FakeEl, attr: string, out: FakeEl[] = []): FakeEl[] => {
  if (root.attrs.has(attr)) out.push(root);
  for (const c of root.children) collectByAttr(c, attr, out);
  return out;
};
const allText = (root: FakeEl, acc: string[] = []): string[] => {
  if (root.textContent) acc.push(root.textContent);
  for (const c of root.children) allText(c, acc);
  return acc;
};
const optionButton = (root: FakeEl, optionId: string): FakeEl | undefined =>
  collectByAttr(root, ASK_CARD_OPTION_ATTR).find(
    (b) => b.getAttribute(ASK_CARD_OPTION_ATTR) === optionId,
  );

// ════════════════════════════════════════════════════════════════
// Fake broadcast subscriber + helpers
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

const ask = (
  id: string,
  over: Partial<ServerPendingAsk> = {},
): ServerPendingAsk => ({
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

/** Await several microtask turns — long enough for a submit's
 *  `await runSubmitAnswer` → fire-and-forget `doRefresh` chain to set the
 *  new `pendingLoad`, which a following `whenLoaded()` then awaits. */
const tick = async (n = 6): Promise<void> => {
  for (let i = 0; i < n; i += 1) await Promise.resolve();
};

const deferred = <T>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const mountFor = (
  runList: () => Promise<{ asks: ReadonlyArray<ServerPendingAsk> }>,
  runSubmitAnswer = vi.fn(async () => ({ ok: true as const })),
  withSubscriber = true,
) => {
  const doc = makeFakeDocument();
  const host = doc.createElement('div');
  const sub = withSubscriber ? makeFakeSubscriber() : undefined;
  const mount = mountAsksPanel({
    host: host as unknown as HTMLElement,
    document: doc as unknown as Document,
    runList,
    runSubmitAnswer,
    ...(sub ? { subscribe: sub.on } : {}),
  });
  return { doc, host, sub, mount, runSubmitAnswer };
};

// ════════════════════════════════════════════════════════════════
// Tests
// ════════════════════════════════════════════════════════════════

describe('D-169 P2 Slice 3b — webclient Approvals panel', () => {
  it('seeds from runList + renders each ask via the SHARED approval card (I-12)', async () => {
    const runList = vi.fn(async () => ({ asks: [ask('a1'), ask('a2')] }));
    const { host, mount } = mountFor(runList);
    await mount.whenLoaded();

    expect(runList).toHaveBeenCalledTimes(1);
    expect(mount.getState()).toBe('ready');
    expect(mount.getAsks().map((a) => a.ask_id)).toEqual(['a1', 'a2']);
    // I-12: the shared primitive's stable hooks prove the webclient
    // renders the same card the bridge does (no per-client copy).
    const cards = collectByAttr(host, ASK_CARD_ATTR);
    expect(cards.map((c) => c.getAttribute(ASK_CARD_ATTR))).toEqual(['a1', 'a2']);
    // Two option buttons per ask.
    expect(collectByAttr(host, ASK_CARD_OPTION_ATTR)).toHaveLength(4);
    mount.dispose();
  });

  it('renders the empty state (no cards) when no asks are open', async () => {
    const { host, mount } = mountFor(vi.fn(async () => ({ asks: [] })));
    await mount.whenLoaded();

    expect(mount.getState()).toBe('ready');
    expect(collectByAttr(host, ASK_CARD_ATTR)).toHaveLength(0);
    expect(collectByAttr(host, ASKS_PANEL_EMPTY_ATTR)).toHaveLength(1);
    expect(allText(host).join(' ')).toContain('No pending approvals');
    mount.dispose();
  });

  it('shows a loading line on first mount before the seed resolves', () => {
    const d = deferred<{ asks: ReadonlyArray<ServerPendingAsk> }>();
    const { host, mount } = mountFor(() => d.promise);
    // Before resolution: loading line, no cards, no empty/error.
    expect(mount.getState()).toBe('loading');
    expect(collectByAttr(host, ASKS_PANEL_LOADING_ATTR)).toHaveLength(1);
    expect(collectByAttr(host, ASK_CARD_ATTR)).toHaveLength(0);
    expect(collectByAttr(host, ASKS_PANEL_EMPTY_ATTR)).toHaveLength(0);
    d.resolve({ asks: [] });
    mount.dispose();
  });

  it('surfaces an error chip when the seed load fails (no cards, no empty-state)', async () => {
    const { host, mount } = mountFor(
      vi.fn(async () => {
        throw new Error('rpc boom');
      }),
    );
    await mount.whenLoaded();

    expect(mount.getState()).toBe('error');
    expect(mount.getListError()).toBe('rpc boom');
    const chip = collectByAttr(host, ASKS_PANEL_ERROR_ATTR);
    expect(chip).toHaveLength(1);
    expect(chip[0].textContent).toContain('rpc boom');
    expect(collectByAttr(host, ASK_CARD_ATTR)).toHaveLength(0);
    // An error is not an empty list — the empty-state copy must not show.
    expect(collectByAttr(host, ASKS_PANEL_EMPTY_ATTR)).toHaveLength(0);
    mount.dispose();
  });

  it('RETAINS the prior asks (+ shows the chip) when a LATER refresh fails', async () => {
    const runList = vi
      .fn<() => Promise<{ asks: ReadonlyArray<ServerPendingAsk> }>>()
      .mockResolvedValueOnce({ asks: [ask('keep')] })
      .mockRejectedValueOnce(new Error('transient'));
    const { host, mount } = mountFor(runList);
    await mount.whenLoaded();
    expect(collectByAttr(host, ASK_CARD_ATTR)).toHaveLength(1);

    await mount.refresh(); // second call rejects

    expect(mount.getState()).toBe('error');
    expect(mount.getListError()).toBe('transient');
    // The card the user can still act on survives the transient failure,
    // rendered beneath the error chip.
    expect(collectByAttr(host, ASKS_PANEL_ERROR_ATTR)).toHaveLength(1);
    expect(collectByAttr(host, ASK_CARD_ATTR).map((c) => c.getAttribute(ASK_CARD_ATTR))).toEqual(['keep']);
    expect(mount.getAsks().map((a) => a.ask_id)).toEqual(['keep']);
    mount.dispose();
  });

  it('re-fetches on a live `notification.ask` bus frame (a new ask appears)', async () => {
    const runList = vi
      .fn<() => Promise<{ asks: ReadonlyArray<ServerPendingAsk> }>>()
      .mockResolvedValueOnce({ asks: [] })
      .mockResolvedValue({ asks: [ask('fresh')] });
    const { host, sub, mount } = mountFor(runList);
    await mount.whenLoaded();
    expect(collectByAttr(host, ASK_CARD_ATTR)).toHaveLength(0);

    sub!.fire('notification.ask', { kind: 'notification.ask', ask_id: 'fresh' });
    await tick();
    await mount.whenLoaded();

    expect(runList).toHaveBeenCalledTimes(2); // seed + bus-triggered re-fetch
    expect(collectByAttr(host, ASK_CARD_ATTR).map((c) => c.getAttribute(ASK_CARD_ATTR))).toEqual(['fresh']);
    mount.dispose();
  });

  it('re-fetches on a live `notification.ask_closed` bus frame (the closed ask drops)', async () => {
    const runList = vi
      .fn<() => Promise<{ asks: ReadonlyArray<ServerPendingAsk> }>>()
      .mockResolvedValueOnce({ asks: [ask('x'), ask('y')] })
      .mockResolvedValue({ asks: [ask('y')] });
    const { host, sub, mount } = mountFor(runList);
    await mount.whenLoaded();
    expect(collectByAttr(host, ASK_CARD_ATTR)).toHaveLength(2);

    sub!.fire('notification.ask_closed', { kind: 'notification.ask_closed', ask_id: 'x' });
    await tick();
    await mount.whenLoaded();

    expect(collectByAttr(host, ASK_CARD_ATTR).map((c) => c.getAttribute(ASK_CARD_ATTR))).toEqual(['y']);
    expect(mount.getAsks().map((a) => a.ask_id)).toEqual(['y']);
    mount.dispose();
  });

  it('clicking an option submits via runSubmitAnswer({ask_id, option_id}) + reconciles the answered ask out', async () => {
    const runList = vi
      .fn<() => Promise<{ asks: ReadonlyArray<ServerPendingAsk> }>>()
      .mockResolvedValueOnce({ asks: [ask('a1')] })
      .mockResolvedValue({ asks: [] }); // a1 answered → gone on re-fetch
    const runSubmitAnswer = vi.fn(async () => ({ ok: true as const }));
    const { host, mount } = mountFor(runList, runSubmitAnswer);
    await mount.whenLoaded();

    const yes = optionButton(host, 'yes');
    expect(yes).toBeDefined();
    yes!.click();
    await tick();
    await mount.whenLoaded();
    await tick();

    expect(runSubmitAnswer).toHaveBeenCalledTimes(1);
    expect(runSubmitAnswer).toHaveBeenCalledWith({ ask_id: 'a1', option_id: 'yes' });
    // The defensive re-fetch dropped the answered ask.
    expect(mount.getAsks()).toHaveLength(0);
    expect(collectByAttr(host, ASK_CARD_ATTR)).toHaveLength(0);
    mount.dispose();
  });

  it('a submit FAILURE re-enables the card (the option button is clickable again) + does not drop the ask', async () => {
    const runList = vi.fn(async () => ({ asks: [ask('a1')] }));
    const runSubmitAnswer = vi
      .fn<() => Promise<{ ok: true }>>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue({ ok: true as const });
    const { host, mount } = mountFor(runList, runSubmitAnswer);
    await mount.whenLoaded();

    const yes = optionButton(host, 'yes');
    yes!.click(); // submit #1 rejects
    await tick();

    // The shared card owns the re-enable-on-reject affordance: the button
    // is enabled again (a disabled button's `.click()` is a no-op), and
    // the ask is still present (no spurious drop on a failed submit).
    expect(yes!.disabled).toBe(false);
    expect(mount.getAsks().map((a) => a.ask_id)).toEqual(['a1']);
    // A retry now goes through.
    yes!.click();
    await tick();
    expect(runSubmitAnswer).toHaveBeenCalledTimes(2);
    mount.dispose();
  });

  it('the loadGeneration guard: a stale (older) runList result never clobbers a newer one', async () => {
    const queue: Array<ReturnType<typeof deferred<{ asks: ReadonlyArray<ServerPendingAsk> }>>> = [];
    const runList = vi.fn(() => {
      const d = deferred<{ asks: ReadonlyArray<ServerPendingAsk> }>();
      queue.push(d);
      return d.promise;
    });
    const { host, mount } = mountFor(runList);
    // queue[0] = the seed (generation 1), still pending.
    const refreshDone = mount.refresh(); // queue[1] = generation 2.
    expect(queue).toHaveLength(2);

    // The NEWER call (gen 2) resolves first → it writes.
    queue[1].resolve({ asks: [ask('newer')] });
    await refreshDone;
    expect(mount.getAsks().map((a) => a.ask_id)).toEqual(['newer']);

    // The OLDER call (gen 1) resolves late → it MUST be dropped.
    queue[0].resolve({ asks: [ask('older')] });
    await tick();
    expect(mount.getAsks().map((a) => a.ask_id)).toEqual(['newer']);
    expect(collectByAttr(host, ASK_CARD_ATTR).map((c) => c.getAttribute(ASK_CARD_ATTR))).toEqual(['newer']);
    mount.dispose();
  });

  it('subscribes to both ask bus kinds + dispose unsubscribes both, removes the root, and is idempotent', async () => {
    const runList = vi.fn(async () => ({ asks: [ask('a1')] }));
    const { host, sub, mount } = mountFor(runList);
    await mount.whenLoaded();

    expect(sub!.count('notification.ask')).toBe(1);
    expect(sub!.count('notification.ask_closed')).toBe(1);
    expect(collectByAttr(host, ASKS_PANEL_HOST_ATTR)).toHaveLength(1);

    mount.dispose();
    expect(sub!.unsubCount()).toBe(2); // both listeners dropped
    expect(sub!.count('notification.ask')).toBe(0);
    expect(sub!.count('notification.ask_closed')).toBe(0);
    // The panel's root is detached from the host.
    expect(collectByAttr(host, ASKS_PANEL_HOST_ATTR)).toHaveLength(0);

    // A bus frame after dispose triggers no re-fetch (guarded + unsubscribed).
    sub!.fire('notification.ask', { kind: 'notification.ask', ask_id: 'late' });
    await tick();
    expect(runList).toHaveBeenCalledTimes(1); // seed only

    // Idempotent.
    expect(() => mount.dispose()).not.toThrow();
    expect(sub!.unsubCount()).toBe(2);
  });

  it('works without a subscriber (no live updates) — seed renders, no throw on dispose', async () => {
    const { host, mount } = mountFor(vi.fn(async () => ({ asks: [ask('a1')] })), undefined, false);
    await mount.whenLoaded();
    expect(collectByAttr(host, ASK_CARD_ATTR)).toHaveLength(1);
    expect(() => mount.dispose()).not.toThrow();
  });
});
