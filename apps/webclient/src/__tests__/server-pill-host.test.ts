/** Webclient server-status pill host acceptance.
 *
 *  Drives `mountWebclientServerPill` over a fake host (innerHTML + click-
 *  listener stub — no jsdom) and a controllable status seam. Pins the B1
 *  policy: the pill surfaces server health ONLY while `connected`, hides
 *  otherwise (the banner + Account recovery own the down-signal), and drops
 *  its cached snapshot on disconnect so a reconnect can't flash stale state. */

import { describe, expect, it, vi } from 'vitest';
import type { ServerHeartbeatSnapshot } from '@recued/contracts';

import {
  isServerHeartbeatSnapshot,
  mountWebclientServerPill,
} from '../shell/server-pill-host.js';
import type { WebclientConnectionStatus } from '../realtime/connection-status.js';

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
    // optimistic flip — the paused pill + the Resume action both show.
    expect(parts().popoverHost?.innerHTML).toContain('Resume');
    expect(parts().pillHost?.innerHTML).toContain('server-pill--paused');
    mount.dispose();
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
    mount.noteSnapshot(runningSnapshot());
    parts().pillHost?.fire('click', pillClick);
    parts().popoverHost?.fire('click', popoverClick('pause-request'));
    parts().popoverHost?.fire('click', popoverClick('pause-confirm'));
    await flush();
    expect(parts().popoverHost?.innerHTML).toContain('server-control-error');
    // not flipped — still the Pause path (no optimistic paused state on failure).
    expect(parts().popoverHost?.innerHTML).toContain('Pause server');
    expect(parts().pillHost?.innerHTML).not.toContain('server-pill--paused');
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
    return { mount, parts };
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
