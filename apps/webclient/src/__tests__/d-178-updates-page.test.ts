/** D-178 — Settings → Updates page acceptance.
 *
 *  Drives `mountUpdatesPage` through a fake Document (the webclient's per-test
 *  fake-DOM pattern) with injected rpc callers. Covers the check → available →
 *  apply (+ major force) flow, the mode toggle (incl. env-lock), rollback, the
 *  availability callback that drives the rail badge, the periodic poll, and
 *  dispose. */

import { describe, expect, it, vi } from 'vitest';

import type {
  ReleaseCheckResponse,
  UpdateApplyResponse,
  UpdateMode,
  UpdateModeStatus,
  UpdateRollbackResponse,
} from '@recued/contracts';

import {
  UPDATES_APPLY_BTN_ATTR,
  UPDATES_APPLY_RESULT_ATTR,
  UPDATES_AVAILABLE_ATTR,
  UPDATES_CHECK_BTN_ATTR,
  UPDATES_ERROR_ATTR,
  UPDATES_FORCE_APPLY_BTN_ATTR,
  UPDATES_MODE_SELECT_ATTR,
  UPDATES_PAGE_STATE_ATTR,
  UPDATES_ROLLBACK_BTN_ATTR,
  UPDATES_ROLLBACK_RESULT_ATTR,
  UPDATES_STATUS_ATTR,
  mountUpdatesPage,
} from '../settings/updates-page.js';

// ── fake DOM (per-test pattern; only the APIs the page touches) ──────
interface FE {
  tagName: string;
  textContent: string;
  className: string;
  value: string;
  children: FE[];
  parent: FE | null;
  attrs: Map<string, string>;
  listeners: Map<string, Array<(e: unknown) => void>>;
  setAttribute(k: string, v: string): void;
  removeAttribute(k: string): void;
  getAttribute(k: string): string | null;
  hasAttribute(k: string): boolean;
  appendChild(c: FE): FE;
  removeChild(c: FE): FE;
  readonly firstChild: FE | null;
  remove(): void;
  addEventListener(n: string, f: (e: unknown) => void): void;
  removeEventListener(n: string, f: (e: unknown) => void): void;
}

const mk = (tag: string): FE => {
  const attrs = new Map<string, string>();
  const listeners = new Map<string, Array<(e: unknown) => void>>();
  const children: FE[] = [];
  const el: FE = {
    tagName: tag.toUpperCase(),
    textContent: '',
    className: '',
    value: '',
    children,
    parent: null,
    attrs,
    listeners,
    setAttribute: (k, v) => {
      attrs.set(k, v);
    },
    removeAttribute: (k) => {
      attrs.delete(k);
    },
    getAttribute: (k) => attrs.get(k) ?? null,
    hasAttribute: (k) => attrs.has(k),
    appendChild: (c) => {
      children.push(c);
      c.parent = el;
      return c;
    },
    removeChild: (c) => {
      const i = children.indexOf(c);
      if (i >= 0) children.splice(i, 1);
      c.parent = null;
      return c;
    },
    get firstChild() {
      return children[0] ?? null;
    },
    remove: () => {
      if (el.parent !== null) {
        const i = el.parent.children.indexOf(el);
        if (i >= 0) el.parent.children.splice(i, 1);
        el.parent = null;
      }
    },
    addEventListener: (n, f) => {
      const arr = listeners.get(n) ?? [];
      arr.push(f);
      listeners.set(n, arr);
    },
    removeEventListener: (n, f) => {
      const arr = listeners.get(n);
      if (arr === undefined) return;
      const i = arr.indexOf(f);
      if (i >= 0) arr.splice(i, 1);
    },
  };
  return el;
};

const fakeDoc = (): Document =>
  ({ createElement: (t: string) => mk(t) }) as unknown as Document;

const find = (root: FE, attr: string): FE | null => {
  if (root.hasAttribute(attr)) return root;
  for (const child of root.children) {
    const hit = find(child, attr);
    if (hit !== null) return hit;
  }
  return null;
};
/** Real-DOM-style aggregate text (the fake keeps textContent per-node). */
const allText = (root: FE): string =>
  root.textContent + root.children.map(allText).join('');
const fire = (el: FE, name: string): void => {
  for (const f of el.listeners.get(name) ?? []) f({});
};
const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
};

const AVAILABLE: ReleaseCheckResponse = {
  status: 'update-available',
  current_version: '26.7.3',
  channel: 'stable',
  available: {
    version: '26.8.0',
    migration: true,
    is_major: false,
    below_min_supported: false,
    in_rollout_cohort: true,
    auto_apply_eligible: true,
    notes_url: 'https://recued.com/notes',
  },
};
const UP_TO_DATE: ReleaseCheckResponse = {
  status: 'up-to-date',
  current_version: '26.8.0',
  channel: 'stable',
};
const MODE_AUTO: UpdateModeStatus = {
  mode: 'auto',
  source: 'default',
  env_locked: false,
  channel_default: 'auto',
};

const host = (): { el: FE; asHost: HTMLElement } => {
  const el = mk('div');
  return { el, asHost: el as unknown as HTMLElement };
};

describe('mountUpdatesPage', () => {
  it('checks on mount → up-to-date renders status + clears availability', async () => {
    const h = host();
    const onAvailabilityChanged = vi.fn();
    const runCheck = vi.fn(async () => UP_TO_DATE);
    const m = mountUpdatesPage({ host: h.asHost, document: fakeDoc(), runCheck, onAvailabilityChanged });
    await flush();
    expect(find(h.el, UPDATES_PAGE_STATE_ATTR)?.getAttribute(UPDATES_PAGE_STATE_ATTR)).toBe('checked');
    expect(find(h.el, UPDATES_STATUS_ATTR)?.textContent).toMatch(/latest/i);
    expect(find(h.el, UPDATES_AVAILABLE_ATTR)?.hasAttribute('hidden')).toBe(true);
    expect(onAvailabilityChanged).toHaveBeenLastCalledWith(false);
    m.dispose();
  });

  it('update-available → shows version + fires availability true; apply → restarting', async () => {
    const h = host();
    const onAvailabilityChanged = vi.fn();
    const runCheck = vi.fn(async () => AVAILABLE);
    const runApply = vi.fn(async (): Promise<UpdateApplyResponse> => ({ status: 'restarting' }));
    const m = mountUpdatesPage({ host: h.asHost, document: fakeDoc(), runCheck, runApply, onAvailabilityChanged });
    await flush();
    const avail = find(h.el, UPDATES_AVAILABLE_ATTR);
    expect(avail?.hasAttribute('hidden')).toBe(false);
    expect(allText(avail as FE)).toContain('26.8.0');
    expect(onAvailabilityChanged).toHaveBeenLastCalledWith(true);
    fire(find(h.el, UPDATES_APPLY_BTN_ATTR) as FE, 'click');
    await flush();
    expect(runApply).toHaveBeenCalledWith({});
    expect(find(h.el, UPDATES_APPLY_RESULT_ATTR)?.textContent).toMatch(/restart/i);
    m.dispose();
  });

  it('major update: apply returns major-blocked → a force button applies with { force: true }', async () => {
    const h = host();
    const runCheck = vi.fn(async (): Promise<ReleaseCheckResponse> => ({
      ...AVAILABLE,
      available: { ...AVAILABLE.available!, is_major: true },
    }));
    const runApply = vi.fn(
      async (_a: { force?: boolean }): Promise<UpdateApplyResponse> => ({ status: 'restarting' }),
    );
    // first apply → major-blocked (surfaces the force button); the force apply
    // falls through to the default → restarting.
    runApply.mockResolvedValueOnce({ status: 'major-blocked' });
    const m = mountUpdatesPage({ host: h.asHost, document: fakeDoc(), runCheck, runApply });
    await flush();
    fire(find(h.el, UPDATES_APPLY_BTN_ATTR) as FE, 'click');
    await flush();
    expect(runApply).toHaveBeenNthCalledWith(1, {});
    const forceBtn = find(h.el, UPDATES_FORCE_APPLY_BTN_ATTR);
    expect(forceBtn).not.toBeNull();
    fire(forceBtn as FE, 'click');
    await flush();
    expect(runApply).toHaveBeenNthCalledWith(2, { force: true });
    m.dispose();
  });

  it('mode: getMode populates the select; change calls setMode', async () => {
    const h = host();
    const runGetMode = vi.fn(async () => MODE_AUTO);
    const runSetMode = vi.fn(async (a: { mode: UpdateMode }): Promise<UpdateModeStatus> => ({
      ...MODE_AUTO,
      mode: a.mode,
      source: 'user',
    }));
    const m = mountUpdatesPage({
      host: h.asHost,
      document: fakeDoc(),
      runCheck: async () => UP_TO_DATE,
      runGetMode,
      runSetMode,
    });
    await flush();
    const sel = find(h.el, UPDATES_MODE_SELECT_ATTR) as FE;
    expect(sel.value).toBe('auto');
    expect(sel.hasAttribute('disabled')).toBe(false);
    sel.value = 'off';
    fire(sel, 'change');
    await flush();
    expect(runSetMode).toHaveBeenCalledWith({ mode: 'off' });
    m.dispose();
  });

  it('env-locked mode disables the select', async () => {
    const h = host();
    const m = mountUpdatesPage({
      host: h.asHost,
      document: fakeDoc(),
      runCheck: async () => UP_TO_DATE,
      runGetMode: async (): Promise<UpdateModeStatus> => ({
        mode: 'off',
        source: 'env',
        env_locked: true,
        channel_default: 'auto',
      }),
      runSetMode: async (a) => ({ mode: a.mode, source: 'env', env_locked: true, channel_default: 'auto' }),
    });
    await flush();
    expect(find(h.el, UPDATES_MODE_SELECT_ATTR)?.hasAttribute('disabled')).toBe(true);
    m.dispose();
  });

  it('rollback renders the result + snapshot note', async () => {
    const h = host();
    const runRollback = vi.fn(async (): Promise<UpdateRollbackResponse> => ({
      status: 'rolled-back',
      restored_snapshot: true,
    }));
    const m = mountUpdatesPage({ host: h.asHost, document: fakeDoc(), runCheck: async () => UP_TO_DATE, runRollback });
    await flush();
    fire(find(h.el, UPDATES_ROLLBACK_BTN_ATTR) as FE, 'click');
    await flush();
    const res = find(h.el, UPDATES_ROLLBACK_RESULT_ATTR);
    expect(res?.hasAttribute('hidden')).toBe(false);
    expect(res?.textContent).toMatch(/snapshot/i);
    m.dispose();
  });

  it('startPoll drives a re-check; dispose cancels it', async () => {
    const h = host();
    const cancel = vi.fn();
    let pollCb: (() => void) | null = null;
    const startPoll = vi.fn((cb: () => void) => {
      pollCb = cb;
      return cancel;
    });
    const runCheck = vi.fn(async () => UP_TO_DATE);
    const m = mountUpdatesPage({ host: h.asHost, document: fakeDoc(), runCheck, startPoll, pollIntervalMs: 1000 });
    await flush();
    expect(startPoll).toHaveBeenCalledWith(expect.any(Function), 1000);
    expect(runCheck).toHaveBeenCalledTimes(1);
    (pollCb as unknown as () => void)();
    await flush();
    expect(runCheck).toHaveBeenCalledTimes(2);
    m.dispose();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('a check failure surfaces an error + clears availability', async () => {
    const h = host();
    const onAvailabilityChanged = vi.fn();
    const m = mountUpdatesPage({
      host: h.asHost,
      document: fakeDoc(),
      runCheck: async () => {
        throw new Error('feed down');
      },
      onAvailabilityChanged,
    });
    await flush();
    expect(find(h.el, UPDATES_PAGE_STATE_ATTR)?.getAttribute(UPDATES_PAGE_STATE_ATTR)).toBe('error');
    expect(find(h.el, UPDATES_ERROR_ATTR)?.hasAttribute('hidden')).toBe(false);
    expect(onAvailabilityChanged).toHaveBeenLastCalledWith(false);
    m.dispose();
  });

  it('the Check button is disabled while a check is in flight', async () => {
    const h = host();
    let resolve: ((r: ReleaseCheckResponse) => void) | null = null;
    const runCheck = vi.fn(
      () =>
        new Promise<ReleaseCheckResponse>((r) => {
          resolve = r;
        }),
    );
    const m = mountUpdatesPage({ host: h.asHost, document: fakeDoc(), runCheck });
    await flush();
    expect(find(h.el, UPDATES_CHECK_BTN_ATTR)?.hasAttribute('disabled')).toBe(true);
    (resolve as unknown as (r: ReleaseCheckResponse) => void)(UP_TO_DATE);
    await flush();
    expect(find(h.el, UPDATES_CHECK_BTN_ATTR)?.hasAttribute('disabled')).toBe(false);
    m.dispose();
  });

  it('a failed re-check hides the stale available card + clears the badge (F1)', async () => {
    const h = host();
    const onAvailabilityChanged = vi.fn();
    const runCheck = vi.fn(async () => AVAILABLE);
    const m = mountUpdatesPage({ host: h.asHost, document: fakeDoc(), runCheck, onAvailabilityChanged });
    await flush();
    expect(find(h.el, UPDATES_AVAILABLE_ATTR)?.hasAttribute('hidden')).toBe(false);
    expect(onAvailabilityChanged).toHaveBeenLastCalledWith(true);
    runCheck.mockRejectedValueOnce(new Error('feed down'));
    await m.refresh();
    await flush();
    expect(find(h.el, UPDATES_AVAILABLE_ATTR)?.hasAttribute('hidden')).toBe(true);
    expect(onAvailabilityChanged).toHaveBeenLastCalledWith(false);
    m.dispose();
  });

  it('an apply proving no installable update hides the card + clears the badge (F2)', async () => {
    const h = host();
    const onAvailabilityChanged = vi.fn();
    const runCheck = vi.fn(async () => AVAILABLE);
    const runApply = vi.fn(async (): Promise<UpdateApplyResponse> => ({ status: 'not-available' }));
    const m = mountUpdatesPage({ host: h.asHost, document: fakeDoc(), runCheck, runApply, onAvailabilityChanged });
    await flush();
    fire(find(h.el, UPDATES_APPLY_BTN_ATTR) as FE, 'click');
    await flush();
    expect(find(h.el, UPDATES_APPLY_RESULT_ATTR)?.textContent).toMatch(/no installable update/i);
    expect(find(h.el, UPDATES_AVAILABLE_ATTR)?.hasAttribute('hidden')).toBe(true);
    expect(onAvailabilityChanged).toHaveBeenLastCalledWith(false);
    m.dispose();
  });
});
