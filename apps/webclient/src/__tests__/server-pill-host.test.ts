/** Webclient server-status pill host acceptance.
 *
 *  Drives `mountWebclientServerPill` over a fake host (innerHTML + click-
 *  listener stub — no jsdom) and a controllable status seam. Pins the B1
 *  policy: the pill surfaces server health ONLY while `connected`, hides
 *  otherwise (the banner + Account recovery own the down-signal), and drops
 *  its cached snapshot on disconnect so a reconnect can't flash stale state. */

import { describe, expect, it, vi } from 'vitest';
import { RpcError, type ServerHeartbeatSnapshot } from '@recued/contracts';

import {
  SERVER_CONTROL_STORAGE_ATTR,
  isServerHeartbeatSnapshot,
  mountWebclientServerPill,
} from '../shell/server-pill-host.js';
import {
  WEBCLIENT_HEARTBEAT_STALE_MS,
  type WebclientConnectionStatus,
} from '../realtime/connection-status.js';

// last_seen_at is just within the pill's staleness window relative to NOW, so
// a connected snapshot renders the green "running" pill.
const NOW = 1_000_500;
const runningSnapshot = (
  over: Partial<ServerHeartbeatSnapshot> = {},
): ServerHeartbeatSnapshot => ({
  server_id: 'srv-1',
  last_seen_at: 1_000_000,
  lifecycle_state: 'running',
  uptime_s: 7200,
  ...over,
});

const makeFakeHost = () => {
  let html = '';
  let listener: ((evt: Event) => void) | null = null;
  const attrs = new Set<string>();
  const host = {
    get innerHTML() {
      return html;
    },
    set innerHTML(v: string) {
      html = v;
    },
    addEventListener: (evt: string, fn: (event: Event) => void) => {
      if (evt === 'click') listener = fn;
    },
    removeEventListener: (evt: string, fn: (event: Event) => void) => {
      if (evt === 'click' && listener === fn) listener = null;
    },
    setAttribute: (name: string) => attrs.add(name),
    removeAttribute: (name: string) => attrs.delete(name),
    hasAttribute: (name: string) => attrs.has(name),
  } as unknown as HTMLElement;
  return {
    host,
    getHtml: () => html,
    hasListener: () => listener !== null,
    isHidden: () => attrs.has('hidden'),
  };
};

const buildFakeStatus = (initial: WebclientConnectionStatus) => {
  let cur = initial;
  const listeners = new Set<(s: WebclientConnectionStatus) => void>();
  return {
    status: () => cur,
    onStatus: (l: (s: WebclientConnectionStatus) => void) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    set: (next: WebclientConnectionStatus) => {
      cur = next;
      for (const l of [...listeners]) l(next);
    },
    listenerCount: () => listeners.size,
  };
};

describe('webclient server-status pill host', () => {
  it('shows the green Server pill while connected with a fresh snapshot', () => {
    const status = buildFakeStatus('connected');
    const { host, getHtml, isHidden } = makeFakeHost();
    const mount = mountWebclientServerPill({
      host,
      status: status.status,
      onStatus: status.onStatus,
      now: () => NOW,
    });
    expect(isHidden()).toBe(true);
    mount.noteSnapshot(runningSnapshot());
    expect(isHidden()).toBe(false);
    expect(getHtml()).toContain('server-pill--green');
    expect(getHtml()).toContain('Server');
    mount.dispose();
  });

  it('surfaces the A2 paused state — a kill-switched snapshot renders the red pill', () => {
    // A2 is server-side enrichment; the webclient pill renders the states
    // automatically via the shared `computePillState`. A kill-switched
    // (running) server is connected (beats flow), so B1 shows the pill — red.
    const status = buildFakeStatus('connected');
    const { host, getHtml } = makeFakeHost();
    const mount = mountWebclientServerPill({
      host,
      status: status.status,
      onStatus: status.onStatus,
      now: () => NOW,
    });
    mount.noteSnapshot(runningSnapshot({ crash_halt_active: true }));
    expect(getHtml()).toContain('server-pill--red');
    expect(getHtml()).toContain('paused');
    mount.dispose();
  });

  it('B1: hides the pill on a transition FROM connected to any not-connected state', () => {
    // Start connected + shown so the assertion proves the pill HID on the
    // transition — not merely that it never rendered. Covers the half-open
    // `stalled` + `reconnecting` transitions, not just the offline drop.
    for (const st of ['connecting', 'reconnecting', 'stalled', 'offline'] as const) {
      const status = buildFakeStatus('connected');
      const { host, getHtml, isHidden } = makeFakeHost();
      const mount = mountWebclientServerPill({
        host,
        status: status.status,
        onStatus: status.onStatus,
        now: () => NOW,
      });
      mount.noteSnapshot(runningSnapshot());
      expect(getHtml(), `pre ${st}`).toContain('server-pill--green'); // shown while connected
      status.set(st);
      expect(getHtml(), `state=${st}`).toBe(''); // hidden after the transition
      expect(isHidden(), `state=${st}`).toBe(true); // no empty padded host row
      mount.dispose();
    }
  });

  it('hides + clears the snapshot on disconnect — no stale flash on reconnect', () => {
    const status = buildFakeStatus('connected');
    const { host, getHtml, isHidden } = makeFakeHost();
    const mount = mountWebclientServerPill({
      host,
      status: status.status,
      onStatus: status.onStatus,
      now: () => NOW,
    });
    mount.noteSnapshot(runningSnapshot());
    expect(getHtml()).toContain('server-pill--green');

    status.set('offline'); // socket dropped → pill hides
    expect(getHtml()).toBe('');
    expect(isHidden()).toBe(true);

    // Reconnect WITHOUT a fresh beat → must stay hidden (the cached snapshot
    // was cleared), NOT re-render the stale pre-disconnect pill.
    status.set('connected');
    expect(getHtml()).toBe('');
    expect(isHidden()).toBe(true);

    // A fresh beat re-shows it.
    mount.noteSnapshot(runningSnapshot({ uptime_s: 30 }));
    expect(getHtml()).toContain('server-pill--green');
    expect(isHidden()).toBe(false);
    mount.dispose();
  });

  it('dispose detaches the status subscription, clears the host, and is inert after', () => {
    const status = buildFakeStatus('connected');
    const { host, getHtml } = makeFakeHost();
    const mount = mountWebclientServerPill({
      host,
      status: status.status,
      onStatus: status.onStatus,
      now: () => NOW,
    });
    mount.noteSnapshot(runningSnapshot());
    expect(status.listenerCount()).toBe(1);

    mount.dispose();
    expect(status.listenerCount()).toBe(0);
    expect(getHtml()).toBe(''); // pill removed
    // A post-dispose beat is inert.
    expect(() => mount.noteSnapshot(runningSnapshot())).not.toThrow();
    expect(getHtml()).toBe('');
  });
});

// ── D-188 controllable variant — a lightweight fake DOM (no jsdom in the
// webclient test env) rich enough for the anchor + popover structure. Each
// element captures its listeners so the test can fire synthetic clicks.
interface FakeEl {
  ownerDocument: unknown;
  className: string;
  children: FakeEl[];
  innerHTML: string;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  hasAttribute(name: string): boolean;
  appendChild(c: FakeEl): FakeEl;
  removeChild(c: FakeEl): FakeEl;
  addEventListener(t: string, fn: (e: unknown) => void): void;
  removeEventListener(t: string, fn: (e: unknown) => void): void;
  contains(): boolean;
  fire(t: string, e: unknown): void;
}
const makeFakeEl = (doc: unknown): FakeEl => {
  const listeners = new Map<string, Set<(e: unknown) => void>>();
  const attrs = new Map<string, string>();
  const el: FakeEl = {
    ownerDocument: doc,
    className: '',
    children: [],
    innerHTML: '',
    setAttribute(name, value) { attrs.set(name, value); },
    removeAttribute(name) { attrs.delete(name); },
    hasAttribute(name) { return attrs.has(name); },
    appendChild(c) { el.children.push(c); return c; },
    removeChild(c) { el.children = el.children.filter((x) => x !== c); return c; },
    addEventListener(t, fn) {
      const set = listeners.get(t) ?? new Set();
      set.add(fn);
      listeners.set(t, set);
    },
    removeEventListener(t, fn) { listeners.get(t)?.delete(fn); },
    contains() { return false; },
    fire(t, e) { for (const fn of listeners.get(t) ?? []) fn(e); },
  };
  return el;
};
const makeControllableHost = () => {
  const doc = { createElement: () => makeFakeEl(doc), addEventListener() {}, removeEventListener() {} };
  const host = makeFakeEl(doc);
  return { host, parts: () => {
    const anchor = host.children[0];
    return { anchor, pillHost: anchor?.children[0], popoverHost: anchor?.children[1] };
  } };
};
const pillClick = { target: { closest: (s: string) => (s.includes('server-pill-click') ? {} : null) } };
const popoverClick = (action: string) => ({
  target: { closest: () => ({ getAttribute: () => action }) },
  preventDefault: () => {},
});
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('webclient server pill — master pause control (D-188)', () => {
  it('reads only a fresh stable heartbeat target as current state', () => {
    const status = buildFakeStatus('connected');
    const { host } = makeControllableHost();
    let now = NOW;
    const mount = mountWebclientServerPill({
      host: host as unknown as HTMLElement,
      status: status.status,
      onStatus: status.onStatus,
      now: () => now,
      runSetPaused: vi.fn(async () => ({ ok: true, active_since: null })),
    });

    mount.noteSnapshot(runningSnapshot({ last_seen_at: -1 }));
    expect(mount.readCurrentState()).toBeNull();
    mount.noteSnapshot(runningSnapshot({ last_seen_at: 99_000_000 }));
    // Freshness is bound to local receipt time, not an untrusted/skewed server
    // timestamp, so a future payload clock cannot extend this observation.
    expect(mount.readCurrentState()).toEqual({ state: 'running' });
    now += WEBCLIENT_HEARTBEAT_STALE_MS;
    expect(mount.readCurrentState()).toBeNull();
    expect(mount.openControls()).toBe('unavailable');

    mount.noteSnapshot(runningSnapshot({
      last_seen_at: 99_000_001,
      lifecycle_state: 'restarting',
    }));
    expect(mount.readCurrentState()).toBeNull();
    mount.noteSnapshot(runningSnapshot({
      last_seen_at: 99_000_002,
      crash_halt_active: true,
    }));
    expect(mount.readCurrentState()).toBeNull();
    mount.noteSnapshot(runningSnapshot({
      last_seen_at: 99_000_003,
      paused: true,
    }));
    expect(mount.readCurrentState()).toEqual({ state: 'paused' });
    mount.dispose();
  });

  it('hands off only to fresh controls and returns on connection loss', () => {
    const status = buildFakeStatus('connected');
    const { host, parts } = makeControllableHost();
    const onControlAvailabilityChange = vi.fn();
    const onReturn = vi.fn();
    const mount = mountWebclientServerPill({
      host: host as unknown as HTMLElement,
      status: status.status,
      onStatus: status.onStatus,
      now: () => NOW,
      runSetPaused: vi.fn(async () => ({ ok: true, active_since: null })),
      onControlAvailabilityChange,
    });

    expect(onControlAvailabilityChange).toHaveBeenLastCalledWith(false);
    const handoff = { ownerId: 'diagnosis-1', onReturn, onReceipt: vi.fn() };
    expect(mount.openControls(handoff)).toBe('unavailable');
    mount.noteSnapshot(runningSnapshot());
    expect(onControlAvailabilityChange).toHaveBeenLastCalledWith(true);
    expect(mount.openControls(handoff)).toBe('opened');
    expect(parts().popoverHost?.innerHTML).toContain(
      'data-recued-webclient-server-control-popover',
    );
    expect(parts().popoverHost?.innerHTML).toContain(
      'Active server controls',
    );

    status.set('reconnecting');
    expect(parts().popoverHost?.innerHTML).toBe('');
    expect(onReturn).toHaveBeenCalledOnce();
    expect(onControlAvailabilityChange).toHaveBeenLastCalledWith(false);
    expect(mount.openControls()).toBe('unavailable');
    mount.dispose();
  });

  it('renders a CLICKABLE pill when runSetPaused is wired', () => {
    const status = buildFakeStatus('connected');
    const { host, parts } = makeControllableHost();
    const mount = mountWebclientServerPill({
      host: host as unknown as HTMLElement,
      status: status.status,
      onStatus: status.onStatus,
      now: () => NOW,
      runSetPaused: vi.fn(async () => ({ ok: true, active_since: null })),
    });
    mount.noteSnapshot(runningSnapshot());
    expect(parts().pillHost?.innerHTML).toContain('data-action="server-pill-click"');
    mount.dispose();
  });

  it('⛔ the popover shows the STORAGE read-out, most-constrained first', () => {
    // ⛔ THE SEAM A PURE TEST CANNOT COVER. `pressureSurfaceRows` is unit-tested
    // in contracts; that proves the row MODEL and says nothing about whether
    // any client renders it — which was the entire defect. `used_bytes` /
    // `quota_bytes` / `pct` reached every client on the heartbeat since Phase B
    // and no surface displayed them.
    const status = buildFakeStatus('connected');
    const { host, parts } = makeControllableHost();
    const mount = mountWebclientServerPill({
      host: host as unknown as HTMLElement,
      status: status.status,
      onStatus: status.onStatus,
      now: () => NOW,
      runSetPaused: vi.fn(async () => ({ ok: true, active_since: null })),
    });
    mount.noteSnapshot(runningSnapshot({
      pressure_details: {
        worst_state: 'pressure_managed',
        per_surface: [
          { surface: 'audit', state: 'running', used_bytes: 104857600, quota_bytes: 5368709120, pct: 2 },
          { surface: 'cache', state: 'pressure_managed', used_bytes: 188743680, quota_bytes: 209715200, pct: 90 },
        ],
      },
    }));
    parts().pillHost?.fire('click', pillClick);
    const html = parts().popoverHost?.innerHTML ?? '';

    expect(html).toContain(SERVER_CONTROL_STORAGE_ATTR);
    expect(html).toContain('Storage');
    expect(html).toContain('5.00 GB');
    expect(html).toContain('(90%)');
    // Most-constrained first: cache must precede audit in the DOM.
    expect(html.indexOf('cache')).toBeLessThan(html.indexOf('audit'));
    // ...and the pressured surface is marked.
    expect(html).toContain('server-control-storage-row--attention');
    mount.dispose();
  });

  it('a snapshot with no pressure block renders no storage section', () => {
    // Absence must read as absence, not as an empty "Storage" heading that
    // looks like a server holding nothing.
    const status = buildFakeStatus('connected');
    const { host, parts } = makeControllableHost();
    const mount = mountWebclientServerPill({
      host: host as unknown as HTMLElement,
      status: status.status,
      onStatus: status.onStatus,
      now: () => NOW,
      runSetPaused: vi.fn(async () => ({ ok: true, active_since: null })),
    });
    mount.noteSnapshot(runningSnapshot());
    parts().pillHost?.fire('click', pillClick);
    const html = parts().popoverHost?.innerHTML ?? '';
    expect(html).toContain('Pause server');           // the popover DID render
    expect(html).not.toContain(SERVER_CONTROL_STORAGE_ATTR);
    mount.dispose();
  });

  it('clicking the pill opens a popover with a Pause server button', () => {
    const status = buildFakeStatus('connected');
    const { host, parts } = makeControllableHost();
    const mount = mountWebclientServerPill({
      host: host as unknown as HTMLElement,
      status: status.status,
      onStatus: status.onStatus,
      now: () => NOW,
      runSetPaused: vi.fn(async () => ({ ok: true, active_since: null })),
    });
    mount.noteSnapshot(runningSnapshot());
    expect(parts().popoverHost?.innerHTML).toBe(''); // closed initially
    parts().pillHost?.fire('click', pillClick);
    expect(parts().popoverHost?.innerHTML).toContain('Pause server');
    mount.dispose();
  });

  it('Pause server → Confirm pause calls runSetPaused(true) + flips to Resume', async () => {
    const status = buildFakeStatus('connected');
    const { host, parts } = makeControllableHost();
    const runSetPaused = vi.fn(async () => ({ ok: true, active_since: 1 }));
    const mount = mountWebclientServerPill({
      host: host as unknown as HTMLElement,
      status: status.status,
      onStatus: status.onStatus,
      now: () => NOW,
      runSetPaused,
    });
    mount.noteSnapshot(runningSnapshot());
    parts().pillHost?.fire('click', pillClick);
    // confirm-on-pause: first click arms the confirm, not the rpc.
    parts().popoverHost?.fire('click', popoverClick('pause-request'));
    expect(parts().popoverHost?.innerHTML).toContain('Confirm pause');
    expect(runSetPaused).not.toHaveBeenCalled();
    parts().popoverHost?.fire('click', popoverClick('pause-confirm'));
    expect(runSetPaused).toHaveBeenCalledWith(true);
    await flush();
    // The authoritative response flips the paused pill + resulting action.
    expect(parts().popoverHost?.innerHTML).toContain('Resume');
    expect(parts().pillHost?.innerHTML).toContain('server-pill--paused');
    mount.dispose();
  });

  it('emits a confirmed pause receipt and reconciles a newer server state', async () => {
    const status = buildFakeStatus('connected');
    const { host, parts } = makeControllableHost();
    const receipts = vi.fn();
    const mount = mountWebclientServerPill({
      host: host as unknown as HTMLElement,
      status: status.status,
      onStatus: status.onStatus,
      now: () => NOW,
      runSetPaused: vi.fn(async () => ({ ok: true, active_since: 1 })),
    });
    mount.noteSnapshot(runningSnapshot({ paused: false }));
    expect(mount.openControls({
      ownerId: 'diagnosis-pause',
      onReturn: vi.fn(),
      onReceipt: receipts,
    })).toBe('opened');
    parts().popoverHost?.fire('click', popoverClick('pause-request'));
    parts().popoverHost?.fire('click', popoverClick('pause-confirm'));
    expect(receipts).toHaveBeenLastCalledWith({
      action: 'pause',
      phase: 'pending',
    });
    await flush();
    expect(receipts).toHaveBeenLastCalledWith({
      action: 'pause',
      phase: 'confirmed',
      currentState: 'paused',
    });

    mount.noteSnapshot(runningSnapshot({ paused: false, uptime_s: 7201 }));
    expect(receipts).toHaveBeenLastCalledWith({
      action: 'pause',
      phase: 'superseded',
      currentState: 'running',
    });

    parts().pillHost?.fire('click', pillClick);
    const repeatedOwnerReceipts = vi.fn();
    mount.openControls({
      ownerId: 'diagnosis-pause',
      onReturn: vi.fn(),
      onReceipt: repeatedOwnerReceipts,
    });
    expect(repeatedOwnerReceipts).toHaveBeenLastCalledWith({
      action: 'pause',
      phase: 'superseded',
      currentState: 'running',
    });
    const nextOwnerReceipts = vi.fn();
    mount.openControls({
      ownerId: 'diagnosis-next',
      onReturn: vi.fn(),
      onReceipt: nextOwnerReceipts,
    });
    expect(nextOwnerReceipts).not.toHaveBeenCalled();
    mount.dispose();
  });

  it('keeps a retired in-flight request explicit for a new review owner', async () => {
    const status = buildFakeStatus('connected');
    const { host, parts } = makeControllableHost();
    let resolvePause = (_value: unknown): void => undefined;
    const runSetPaused = vi.fn(() => new Promise((resolve) => {
      resolvePause = resolve;
    }));
    const firstReceipts = vi.fn();
    const nextReceipts = vi.fn();
    const onCurrentStateAvailabilityChange = vi.fn();
    const mount = mountWebclientServerPill({
      host: host as unknown as HTMLElement,
      status: status.status,
      onStatus: status.onStatus,
      now: () => NOW,
      runSetPaused,
      onCurrentStateAvailabilityChange,
    });
    expect(onCurrentStateAvailabilityChange).toHaveBeenLastCalledWith(false);
    mount.noteSnapshot(runningSnapshot());
    expect(onCurrentStateAvailabilityChange).toHaveBeenLastCalledWith(true);
    expect(mount.readCurrentState()).toEqual({ state: 'running' });
    mount.openControls({
      ownerId: 'diagnosis-first',
      onReturn: vi.fn(),
      onReceipt: firstReceipts,
    });
    parts().popoverHost?.fire('click', popoverClick('pause-request'));
    parts().popoverHost?.fire('click', popoverClick('pause-confirm'));
    expect(onCurrentStateAvailabilityChange).toHaveBeenLastCalledWith(false);
    expect(mount.readCurrentState()).toBeNull();
    expect(firstReceipts).toHaveBeenLastCalledWith({
      action: 'pause',
      phase: 'pending',
    });
    expect(parts().popoverHost?.innerHTML).toContain(
      'Pause is still awaiting a server response.',
    );

    mount.closeControls();
    expect(mount.openControls({
      ownerId: 'diagnosis-re-review',
      onReturn: vi.fn(),
      onReceipt: nextReceipts,
    })).toBe('opened');
    expect(parts().popoverHost?.innerHTML).toContain(
      'controls stay unavailable until it settles',
    );
    expect(parts().popoverHost?.innerHTML).toContain(
      'disabled aria-busy="true"',
    );
    expect(nextReceipts).not.toHaveBeenCalled();
    expect(runSetPaused).toHaveBeenCalledTimes(1);
    mount.noteSnapshot(runningSnapshot({ last_seen_at: 1_000_200 }));
    expect(onCurrentStateAvailabilityChange).toHaveBeenLastCalledWith(false);
    expect(mount.readCurrentState()).toBeNull();

    resolvePause({ ok: true, active_since: 1 });
    await flush();
    expect(parts().popoverHost?.innerHTML).toContain('Execution paused');
    expect(parts().popoverHost?.innerHTML).not.toContain(
      'still awaiting a server response',
    );
    // The late completion updates live state, but generation ownership keeps
    // it from becoming a synthetic receipt for the re-review.
    expect(nextReceipts).not.toHaveBeenCalled();
    expect(runSetPaused).toHaveBeenCalledTimes(1);
    expect(onCurrentStateAvailabilityChange).toHaveBeenLastCalledWith(false);
    expect(mount.readCurrentState()).toBeNull();

    // The RPC result may update the visible control, but closure waits for a
    // subsequent heartbeat so an old cached snapshot cannot be called current.
    mount.noteSnapshot(runningSnapshot({
      paused: true,
      last_seen_at: 1_000_400,
    }));
    expect(onCurrentStateAvailabilityChange).toHaveBeenLastCalledWith(true);
    expect(mount.readCurrentState()).toEqual({ state: 'paused' });
    mount.dispose();
    expect(onCurrentStateAvailabilityChange).toHaveBeenLastCalledWith(false);
  });

  it('Resume (from a paused snapshot) calls runSetPaused(false), no confirm', () => {
    const status = buildFakeStatus('connected');
    const { host, parts } = makeControllableHost();
    const runSetPaused = vi.fn(async () => ({ ok: true, active_since: null }));
    const mount = mountWebclientServerPill({
      host: host as unknown as HTMLElement,
      status: status.status,
      onStatus: status.onStatus,
      now: () => NOW,
      runSetPaused,
    });
    mount.noteSnapshot(runningSnapshot({ paused: true }));
    parts().pillHost?.fire('click', pillClick);
    expect(parts().popoverHost?.innerHTML).toContain('Resume');
    parts().popoverHost?.fire('click', popoverClick('resume'));
    expect(runSetPaused).toHaveBeenCalledWith(false);
    mount.dispose();
  });

  it('a failed pause shows a humanized error and does NOT optimistically flip', async () => {
    const status = buildFakeStatus('connected');
    const { host, parts } = makeControllableHost();
    const runSetPaused = vi.fn(async () => { throw new Error('boom'); });
    const mount = mountWebclientServerPill({
      host: host as unknown as HTMLElement,
      status: status.status,
      onStatus: status.onStatus,
      now: () => NOW,
      runSetPaused,
    });
    const receipts = vi.fn();
    mount.noteSnapshot(runningSnapshot());
    mount.openControls({
      ownerId: 'diagnosis-failed-pause',
      onReturn: vi.fn(),
      onReceipt: receipts,
    });
    parts().popoverHost?.fire('click', popoverClick('pause-request'));
    parts().popoverHost?.fire('click', popoverClick('pause-confirm'));
    await flush();
    expect(parts().popoverHost?.innerHTML).toContain('server-control-error');
    // not flipped — still the Pause path (no optimistic paused state on failure).
    expect(parts().popoverHost?.innerHTML).toContain('Pause server');
    expect(parts().pillHost?.innerHTML).not.toContain('server-pill--paused');
    expect(receipts).toHaveBeenLastCalledWith({
      action: 'pause',
      phase: 'failed',
      currentState: 'running',
      detail: 'boom',
    });
    mount.dispose();
  });

  it('reports a dropped pause response as unconfirmed, never failed', async () => {
    const status = buildFakeStatus('connected');
    const { host, parts } = makeControllableHost();
    const receipts = vi.fn();
    const mount = mountWebclientServerPill({
      host: host as unknown as HTMLElement,
      status: status.status,
      onStatus: status.onStatus,
      now: () => NOW,
      runSetPaused: vi.fn(async () => {
        throw new RpcError(
          'connection_lost',
          'raw method-shaped transport error',
          undefined,
          'server.setPaused',
        );
      }),
    });
    mount.noteSnapshot(runningSnapshot());
    mount.openControls({
      ownerId: 'diagnosis-unknown-pause',
      onReturn: vi.fn(),
      onReceipt: receipts,
    });
    parts().popoverHost?.fire('click', popoverClick('pause-request'));
    parts().popoverHost?.fire('click', popoverClick('pause-confirm'));
    await flush();
    expect(receipts).toHaveBeenLastCalledWith({
      action: 'pause',
      phase: 'unconfirmed',
      currentState: 'running',
      detail: 'The connection dropped before this finished, so its result is unknown.',
    });
    mount.dispose();
  });

  it('bounds long server detail in the diagnosis receipt', async () => {
    const status = buildFakeStatus('connected');
    const { host, parts } = makeControllableHost();
    const receipts = vi.fn();
    const longDetail = 'x'.repeat(500);
    const mount = mountWebclientServerPill({
      host: host as unknown as HTMLElement,
      status: status.status,
      onStatus: status.onStatus,
      now: () => NOW,
      runSetPaused: vi.fn(async () => { throw new Error(longDetail); }),
    });
    mount.noteSnapshot(runningSnapshot());
    mount.openControls({
      ownerId: 'diagnosis-long-error',
      onReturn: vi.fn(),
      onReceipt: receipts,
    });
    parts().popoverHost?.fire('click', popoverClick('pause-request'));
    parts().popoverHost?.fire('click', popoverClick('pause-confirm'));
    await flush();

    const receipt = receipts.mock.lastCall?.[0];
    expect(receipt?.phase).toBe('failed');
    expect(receipt?.detail).toHaveLength(320);
    expect(receipt?.detail).toMatch(/…$/);
    mount.dispose();
  });

  it('does not paint a retired action failure into a newer diagnosis owner', async () => {
    const status = buildFakeStatus('connected');
    const { host, parts } = makeControllableHost();
    let rejectPause = (_reason: unknown): void => undefined;
    const runSetPaused = vi.fn(() => new Promise<{
      ok: true;
      active_since: number | null;
    }>((_resolve, reject) => {
      rejectPause = reject;
    }));
    const firstReceipts = vi.fn();
    const nextReceipts = vi.fn();
    const mount = mountWebclientServerPill({
      host: host as unknown as HTMLElement,
      status: status.status,
      onStatus: status.onStatus,
      now: () => NOW,
      runSetPaused,
    });
    mount.noteSnapshot(runningSnapshot());
    mount.openControls({
      ownerId: 'diagnosis-retired',
      onReturn: vi.fn(),
      onReceipt: firstReceipts,
    });
    parts().popoverHost?.fire('click', popoverClick('pause-request'));
    parts().popoverHost?.fire('click', popoverClick('pause-confirm'));
    expect(firstReceipts).toHaveBeenLastCalledWith({
      action: 'pause',
      phase: 'pending',
    });

    mount.closeControls();
    expect(mount.openControls({
      ownerId: 'diagnosis-next',
      onReturn: vi.fn(),
      onReceipt: nextReceipts,
    })).toBe('opened');
    rejectPause(new Error('belongs only to the retired action'));
    await flush();

    expect(firstReceipts).toHaveBeenCalledTimes(1);
    expect(nextReceipts).not.toHaveBeenCalled();
    expect(parts().popoverHost?.innerHTML).not.toContain(
      'belongs only to the retired action',
    );
    expect(parts().popoverHost?.innerHTML).toContain('Pause server');
    mount.dispose();
  });
});

describe('webclient server pill — restart + crash-halt (D-188)', () => {
  const mountWith = (
    snapshot: ServerHeartbeatSnapshot,
    extra: Partial<Parameters<typeof mountWebclientServerPill>[0]> = {},
  ) => {
    const status = buildFakeStatus('connected');
    const { host, parts } = makeControllableHost();
    const mount = mountWebclientServerPill({
      host: host as unknown as HTMLElement,
      status: status.status,
      onStatus: status.onStatus,
      now: () => NOW,
      runSetPaused: vi.fn(async () => ({})),
      ...extra,
    });
    mount.noteSnapshot(snapshot);
    return { mount, parts, status };
  };

  it('hides Restart when the supervisor will not respawn (dev / native)', () => {
    for (const mode of ['dev', 'native'] as const) {
      const { mount, parts } = mountWith(runningSnapshot({ supervisor_mode: mode }), {
        runRequestRestart: vi.fn(async () => ({ accepted: true })),
      });
      parts().pillHost?.fire('click', pillClick);
      expect(parts().popoverHost?.innerHTML, mode).toContain('Pause server');
      expect(parts().popoverHost?.innerHTML, mode).not.toContain('Restart');
      mount.dispose();
    }
  });

  it('shows Restart under a respawning supervisor (systemd)', () => {
    const { mount, parts } = mountWith(runningSnapshot({ supervisor_mode: 'systemd' }), {
      runRequestRestart: vi.fn(async () => ({ accepted: true })),
    });
    parts().pillHost?.fire('click', pillClick);
    expect(parts().popoverHost?.innerHTML).toContain('Restart');
    mount.dispose();
  });

  it('hides Restart when no restart rpc is wired, even under a supervisor', () => {
    const { mount, parts } = mountWith(runningSnapshot({ supervisor_mode: 'systemd' }));
    parts().pillHost?.fire('click', pillClick);
    expect(parts().popoverHost?.innerHTML).not.toContain('Restart');
    mount.dispose();
  });

  it('Restart → Confirm restart calls the rpc and shows the restarting note', async () => {
    const runRequestRestart = vi.fn(async () => ({ accepted: true }));
    const { mount, parts } = mountWith(runningSnapshot({ supervisor_mode: 'systemd' }), {
      runRequestRestart,
    });
    parts().pillHost?.fire('click', pillClick);
    parts().popoverHost?.fire('click', popoverClick('restart-request'));
    expect(parts().popoverHost?.innerHTML).toContain('Confirm restart');
    expect(runRequestRestart).not.toHaveBeenCalled(); // confirm-gated
    parts().popoverHost?.fire('click', popoverClick('restart-confirm'));
    expect(runRequestRestart).toHaveBeenCalledTimes(1);
    await flush();
    expect(parts().popoverHost?.innerHTML).toContain('Restarting');
    mount.dispose();
  });

  it('carries an accepted restart receipt through disconnect to uptime proof', async () => {
    const receipts = vi.fn();
    const onReturn = vi.fn();
    const { mount, parts, status } = mountWith(
      runningSnapshot({ supervisor_mode: 'systemd', uptime_s: 7200 }),
      { runRequestRestart: vi.fn(async () => ({ accepted: true })) },
    );
    expect(mount.openControls({
      ownerId: 'diagnosis-restart',
      onReturn,
      onReceipt: receipts,
    })).toBe('opened');
    parts().popoverHost?.fire('click', popoverClick('restart-request'));
    parts().popoverHost?.fire('click', popoverClick('restart-confirm'));
    expect(receipts).toHaveBeenLastCalledWith({
      action: 'restart',
      phase: 'pending',
    });
    await flush();
    expect(receipts).toHaveBeenLastCalledWith({
      action: 'restart',
      phase: 'accepted',
      currentState: 'restarting',
    });

    status.set('reconnecting');
    expect(onReturn).toHaveBeenCalledOnce();
    status.set('connected');
    mount.noteSnapshot(runningSnapshot({
      supervisor_mode: 'systemd',
      uptime_s: 3,
    }));
    expect(receipts).toHaveBeenLastCalledWith({
      action: 'restart',
      phase: 'confirmed',
      currentState: 'running',
    });
    mount.dispose();
  });

  it('does not call reconnect alone a completed restart without uptime proof', async () => {
    const receipts = vi.fn();
    const { mount, parts, status } = mountWith(
      runningSnapshot({ supervisor_mode: 'systemd', uptime_s: 7200 }),
      { runRequestRestart: vi.fn(async () => ({ accepted: true })) },
    );
    mount.openControls({
      ownerId: 'diagnosis-restart-no-proof',
      onReturn: vi.fn(),
      onReceipt: receipts,
    });
    parts().popoverHost?.fire('click', popoverClick('restart-request'));
    parts().popoverHost?.fire('click', popoverClick('restart-confirm'));
    await flush();
    status.set('reconnecting');
    status.set('connected');
    mount.noteSnapshot(runningSnapshot({
      supervisor_mode: 'systemd',
      uptime_s: 7300,
      paused: true,
    }));
    expect(receipts).toHaveBeenLastCalledWith({
      action: 'restart',
      phase: 'reconnected',
      currentState: 'paused',
    });
    mount.dispose();
  });

  it('reconciles a fresh post-restart heartbeat that beats the accepted response', async () => {
    const receipts = vi.fn();
    let acceptRestart = (): void => undefined;
    const runRequestRestart = vi.fn(() => new Promise<{ accepted: true }>(
      (resolve) => {
        acceptRestart = () => resolve({ accepted: true });
      },
    ));
    const { mount, parts, status } = mountWith(
      runningSnapshot({ supervisor_mode: 'systemd', uptime_s: 7200 }),
      { runRequestRestart },
    );
    mount.openControls({
      ownerId: 'diagnosis-restart-race',
      onReturn: vi.fn(),
      onReceipt: receipts,
    });
    parts().popoverHost?.fire('click', popoverClick('restart-request'));
    parts().popoverHost?.fire('click', popoverClick('restart-confirm'));
    status.set('reconnecting');
    status.set('connected');
    mount.noteSnapshot(runningSnapshot({
      supervisor_mode: 'systemd',
      uptime_s: 2,
    }));
    expect(receipts).toHaveBeenLastCalledWith({
      action: 'restart',
      phase: 'pending',
    });

    acceptRestart();
    await flush();
    expect(receipts).toHaveBeenLastCalledWith({
      action: 'restart',
      phase: 'confirmed',
      currentState: 'running',
    });
    mount.dispose();
  });

  it('SECURITY: a restart-confirm armed under a supervisor auto-disarms + cannot fire if it later reports none', () => {
    const runRequestRestart = vi.fn(async () => ({ accepted: true }));
    const status = buildFakeStatus('connected');
    const { host, parts } = makeControllableHost();
    const mount = mountWebclientServerPill({
      host: host as unknown as HTMLElement,
      status: status.status,
      onStatus: status.onStatus,
      now: () => NOW,
      runSetPaused: vi.fn(async () => ({})),
      runRequestRestart,
    });
    mount.noteSnapshot(runningSnapshot({ supervisor_mode: 'systemd' }));
    parts().pillHost?.fire('click', pillClick);
    parts().popoverHost?.fire('click', popoverClick('restart-request'));
    expect(parts().popoverHost?.innerHTML).toContain('Confirm restart');
    // The supervisor drops to a non-respawning mode before the user confirms.
    mount.noteSnapshot(runningSnapshot({ supervisor_mode: 'native' }));
    expect(parts().popoverHost?.innerHTML).not.toContain('Confirm restart'); // auto-disarmed
    // Even a stale confirm click cannot fire the rpc — the action-boundary gate.
    parts().popoverHost?.fire('click', popoverClick('restart-confirm'));
    expect(runRequestRestart).not.toHaveBeenCalled();
    mount.dispose();
  });

  it('crash-halt renders the red fault info + Restart recovery, NOT pause/resume', () => {
    const { mount, parts } = mountWith(
      runningSnapshot({ crash_halt_active: true, supervisor_mode: 'systemd' }),
      { runRequestRestart: vi.fn(async () => ({ accepted: true })) },
    );
    parts().pillHost?.fire('click', pillClick);
    const html = parts().popoverHost?.innerHTML ?? '';
    expect(html).toContain('Crash loop detected');
    expect(html).toContain('server-control-status--crash');
    expect(html).toContain('Restart'); // honest recovery
    expect(html).not.toContain('Pause server'); // a fault, not a pause/resume-as-fix
    mount.dispose();
  });

  it('crash-halt without a supervisor shows the info but no Restart button', () => {
    const { mount, parts } = mountWith(
      runningSnapshot({ crash_halt_active: true, supervisor_mode: 'native' }),
      { runRequestRestart: vi.fn(async () => ({ accepted: true })) },
    );
    parts().pillHost?.fire('click', pillClick);
    const html = parts().popoverHost?.innerHTML ?? '';
    expect(html).toContain('Crash loop detected');
    expect(html).not.toContain('Restart');
    mount.dispose();
  });
});

describe('isServerHeartbeatSnapshot (wire-payload guard)', () => {
  it('accepts a well-formed snapshot (incl. a null server_id)', () => {
    expect(isServerHeartbeatSnapshot(runningSnapshot())).toBe(true);
    expect(
      isServerHeartbeatSnapshot({ server_id: null, last_seen_at: 0 }),
    ).toBe(true);
  });

  it('rejects malformed / partial frames the renderer would mishandle', () => {
    // `{}` is the headline case — it slips past the renderer's null-guard and
    // would otherwise render a bogus "Server · 0s".
    expect(isServerHeartbeatSnapshot({})).toBe(false);
    expect(isServerHeartbeatSnapshot({ server_id: 'x' })).toBe(false); // no last_seen_at
    expect(isServerHeartbeatSnapshot({ last_seen_at: 1 })).toBe(false); // no server_id
    expect(
      isServerHeartbeatSnapshot({ server_id: 5, last_seen_at: 1 }),
    ).toBe(false); // wrong server_id type
    expect(isServerHeartbeatSnapshot(null)).toBe(false);
    expect(isServerHeartbeatSnapshot(undefined)).toBe(false);
    expect(isServerHeartbeatSnapshot('nope')).toBe(false);
    expect(isServerHeartbeatSnapshot(42)).toBe(false);
  });
});
