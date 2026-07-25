/** Phase G (D-109) — server status pill render + mount tests.
 *
 *  The mount helper touches a handful of `HTMLElement` methods
 *  (innerHTML, addEventListener, removeEventListener); we stub those
 *  rather than pulling in a jsdom environment. */

import { describe, expect, it, vi } from 'vitest';
import type { ServerHeartbeatSnapshot } from '@recued/contracts';
import { renderServerPill } from '../render.js';
import { mountServerPill } from '../mount.js';

const baseSnapshot = (over: Partial<ServerHeartbeatSnapshot> = {}): ServerHeartbeatSnapshot => ({
  server_id: 'srv-abc',
  server_name: 'Home',
  last_seen_at: 1_000_000,
  lifecycle_state: 'running',
  uptime_s: 7200,
  supervisor_mode: 'systemd',
  crash_halt_active: false,
  pressure_details: {
    worst_state: 'running',
    per_surface: [],
  },
  collections: [],
  ...over,
});

/** Minimal HTMLElement stub. Tracks innerHTML writes + the registered
 *  click listener so tests can simulate events. */
const makeFakeHost = () => {
  let html = '';
  let listener: ((evt: Event) => void) | null = null;
  const host = {
    get innerHTML() { return html; },
    set innerHTML(v: string) { html = v; },
    addEventListener: (evt: string, fn: (event: Event) => void) => {
      if (evt === 'click') listener = fn;
    },
    removeEventListener: (evt: string, fn: (event: Event) => void) => {
      if (evt === 'click' && listener === fn) listener = null;
    },
  } as unknown as HTMLElement;
  const fire = (target: unknown) => {
    if (listener) {
      const evt = { target } as unknown as Event;
      listener(evt);
    }
  };
  return { host, fire, getHtml: () => html, hasListener: () => listener !== null };
};

describe('renderServerPill', () => {
  const NOW = 1_000_000 + 1000;

  it('hides entirely when no server is paired', () => {
    expect(renderServerPill(null, {}, NOW)).toBe('');
  });

  it('hides when snapshot has server_id: null', () => {
    const snap: ServerHeartbeatSnapshot = {
      server_id: null,
      last_seen_at: NOW,
    };
    expect(renderServerPill(snap, {}, NOW)).toBe('');
  });

  it('renders the steady-state pill as a clickable button', () => {
    const html = renderServerPill(baseSnapshot(), {}, NOW);
    expect(html).toContain('server-pill--green');
    expect(html).toContain('server-pill__dot');
    expect(html).toContain('Server · 2h');
    expect(html).toContain('<button');
    expect(html).toContain('data-action="server-pill-click"');
  });

  it('renders non-clickable span when clickable: false', () => {
    const html = renderServerPill(baseSnapshot(), { clickable: false }, NOW);
    expect(html).toContain('<span');
    expect(html).not.toContain('data-action="server-pill-click"');
  });

  it('renders red for kill switch active', () => {
    const html = renderServerPill(
      baseSnapshot({ crash_halt_active: true }),
      {},
      NOW,
    );
    expect(html).toContain('server-pill--red');
    expect(html).toContain('paused');
  });

  it('renders gray when heartbeat is stale', () => {
    const html = renderServerPill(
      baseSnapshot({ last_seen_at: NOW - 60_000 }),
      {},
      NOW,
    );
    expect(html).toContain('server-pill--gray');
    expect(html).toContain('offline');
  });

  it('renders orange for draining lifecycle', () => {
    const html = renderServerPill(
      baseSnapshot({ lifecycle_state: 'draining' }),
      {},
      NOW,
    );
    expect(html).toContain('server-pill--orange');
    expect(html).toContain('busy');
  });

  it('carries an aria-label on the clickable variant', () => {
    const html = renderServerPill(baseSnapshot(), {}, NOW);
    expect(html).toMatch(/aria-label=".+"/);
  });
});

describe('mountServerPill', () => {
  const NOW = 1_000_000 + 1000;

  it('renders into the host element on mount', () => {
    const { host, getHtml } = makeFakeHost();
    const handle = mountServerPill({
      host,
      getSnapshot: () => baseSnapshot(),
      now: () => NOW,
    });
    expect(getHtml()).toContain('server-pill--green');
    handle.dispose();
  });

  it('hides when getSnapshot returns null', () => {
    const { host, getHtml } = makeFakeHost();
    const handle = mountServerPill({
      host,
      getSnapshot: () => null,
      now: () => NOW,
    });
    expect(getHtml()).toBe('');
    handle.dispose();
  });

  it('update() re-renders from the latest snapshot', () => {
    const { host, getHtml } = makeFakeHost();
    let snap: ServerHeartbeatSnapshot | null = baseSnapshot();
    const handle = mountServerPill({
      host,
      getSnapshot: () => snap,
      now: () => NOW,
    });
    expect(getHtml()).toContain('server-pill--green');
    snap = baseSnapshot({ crash_halt_active: true });
    handle.update();
    expect(getHtml()).toContain('server-pill--red');
    handle.dispose();
  });

  it('fires onClick with the snapshot when the pill button is clicked', () => {
    const { host, fire } = makeFakeHost();
    const onClick = vi.fn();
    mountServerPill({
      host,
      getSnapshot: () => baseSnapshot(),
      onClick,
      now: () => NOW,
    });
    // Fake a click on an element that matches the pill button selector.
    const fakeButton = {
      closest: (sel: string) => (sel === '[data-action="server-pill-click"]' ? fakeButton : null),
    };
    fire(fakeButton);
    expect(onClick).toHaveBeenCalledOnce();
    expect(onClick.mock.calls[0]![0]).toMatchObject({ server_id: 'srv-abc' });
  });

  it('ignores clicks outside the pill button', () => {
    const { host, fire } = makeFakeHost();
    const onClick = vi.fn();
    mountServerPill({
      host,
      getSnapshot: () => baseSnapshot(),
      onClick,
      now: () => NOW,
    });
    const unrelated = { closest: () => null };
    fire(unrelated);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('dispose() removes the listener + clears html', () => {
    const { host, getHtml, hasListener } = makeFakeHost();
    const handle = mountServerPill({
      host,
      getSnapshot: () => baseSnapshot(),
      now: () => NOW,
    });
    handle.dispose();
    expect(getHtml()).toBe('');
    expect(hasListener()).toBe(false);
  });
});
