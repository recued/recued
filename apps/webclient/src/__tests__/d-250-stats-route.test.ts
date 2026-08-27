/** D-250 § D7 — the `#stats` route mount.
 *
 *  🔑 THE PANEL'S RENDERING IS TESTED IN ui-shared. What is testable ONLY here is the
 *  seam: that the route reaches the rpc, that a FAILED read does not render as an empty
 *  server, and that no publish action exists while § D4's grant is unbuilt.
 */

import { describe, expect, it, vi } from 'vitest';
import { metricValue, type MetricReadOutput } from '@recued/contracts';

import { bootstrapStatsRoute } from '../stats/bootstrap-stats-route.js';

const NOW = 1_700_000_000_000;

const data = (over: Partial<MetricReadOutput> = {}): MetricReadOutput => ({
  snapshot: {
    computed_at: NOW,
    window: { from: NOW - 86_400_000, to: NOW },
    metrics: [{ metric_id: 'autopilot', metric_version: 1, reading: metricValue(0.5),
      label: 'Autopilot', shape: 'share', direction: 'higher', publishable: true }],
  },
  artifacts: [],
  milestones: [],
  publications: [],
  ...over,
});

/** ⚠ A STUB CONTAINER, not a DOM. The webclient suite has no browser environment and
 *  builds fakes (`records-explorer.test.ts` does the same) — and the route needs exactly
 *  one capability, an `innerHTML` setter, so anything richer would be testing jsdom. */
const mount = (read: () => Promise<MetricReadOutput>) => {
  const container = { innerHTML: '' } as unknown as HTMLElement;
  const route = bootstrapStatsRoute({ container, read, now: () => NOW });
  return { container, route };
};

const settle = () => new Promise((r) => setTimeout(r, 0));

describe('D-250 § D7 — the route reads and renders', () => {
  it('calls metric.read once on mount and paints the panel', async () => {
    const read = vi.fn(async () => data());
    const { container } = mount(read);
    await settle();
    expect(read).toHaveBeenCalledTimes(1);
    expect(container.innerHTML).toContain('Autopilot');
    expect(container.innerHTML).toContain('50%');
  });

  it('renders the heading landing target the recovery policy names', async () => {
    // ⛔ `recovery-intent-landing.ts` points Stats at this exact attribute. A landing
    // target that never resolves silently drops focus to the document.
    const { container } = mount(async () => data());
    await settle();
    expect(container.innerHTML).toContain('data-recued-stats-route-heading');
  });
});

describe('D-250 § D7 — the mount is visible before the read settles', () => {
  it('⛔⛔ PAINTS SYNCHRONOUSLY, so "mounted" and "hung" are not the same state', async () => {
    // A read that never settles is exactly what a client with no live server sees. If
    // the route waited for it, the pane stayed blank and nothing could tell a mounted
    // route from an unwired one — which is how the discriminator went untested.
    const { container } = mount(() => new Promise(() => {}));
    expect(container.innerHTML).toContain('data-recued-stats-route-heading');
    expect(container.innerHTML).toContain('data-recued-stats-loading');
  });

  it('the loading state is replaced once the read lands', async () => {
    const { container } = mount(async () => data());
    await settle();
    expect(container.innerHTML).not.toContain('data-recued-stats-loading');
    expect(container.innerHTML).toContain('Autopilot');
  });
});

describe('D-250 § D7 — a failed read is not an empty server', () => {
  it('⛔⛔ AN RPC ERROR DOES NOT RENDER "nothing measured yet"', async () => {
    // That would tell an owner with months of history that their server has none — the
    // same absent-versus-zero confusion the panel avoids, one layer up.
    const { container } = mount(async () => { throw new Error('socket closed'); });
    await settle();
    expect(container.innerHTML).not.toContain('Nothing measured yet');
    expect(container.innerHTML).toContain('data-recued-stats-error');
    expect(container.innerHTML).toContain('Could not read your stats');
  });

  it('an empty snapshot DOES render the empty state — the two stay distinct', async () => {
    const { container } = mount(async () => data({ snapshot: null }));
    await settle();
    expect(container.innerHTML).toContain('Nothing measured yet');
    expect(container.innerHTML).not.toContain('data-recued-stats-error');
  });
});

describe('D-250 § D4 — no publish action while the grant is unbuilt', () => {
  it('⛔ THE SURFACE OFFERS NO PUBLISH OR ERASE BUTTON', async () => {
    // § D4 makes publishing a separate outward act carrying its own bounded, revocable
    // grant. A button that cannot publish is worse than none — and one that COULD would
    // be riding the read path's authorization, which is exactly what § D4 forbids.
    const { container } = mount(async () => data());
    await settle();
    expect(container.innerHTML).not.toContain('<button');
    expect(container.innerHTML.toLowerCase()).not.toContain('publish');
  });
});

describe('D-250 — dispose', () => {
  it('a read landing after dispose does not paint', async () => {
    let release: (v: MetricReadOutput) => void = () => {};
    const { container, route } = mount(() => new Promise((r) => { release = r; }));
    route.dispose();
    release(data());
    await settle();
    expect(container.innerHTML).not.toContain('Autopilot');
  });
});

// ────────────────────────────────────────────────────────────────
// § C4 / § D7 — leaving a board is always one click
// ────────────────────────────────────────────────────────────────

describe('D-250 § C4 — the erase is wired, and survives a repaint', () => {
  /** A container that records listeners, so the delegated click can be fired. */
  const listening = () => {
    // ⛔ THE EVENT TYPE IS RESPECTED. A double that fires every handler regardless of
    // what it registered for cannot tell 'click' from anything else — proved by mutation:
    // binding to a nonsense event name left this suite green. Same shape as a stub that
    // matches a table name by substring.
    const handlers: Array<{ type: string; h: (e: Event) => void }> = [];
    const container = {
      innerHTML: '',
      addEventListener: (type: string, h: (e: Event) => void) => { handlers.push({ type, h }); },
      removeEventListener: (type: string, h: (e: Event) => void) => {
        const i = handlers.findIndex((x) => x.type === type && x.h === h);
        if (i >= 0) handlers.splice(i, 1);
      },
    } as unknown as HTMLElement;
    const click = (tag: string) => {
      const ev = { target: { closest: () => ({ getAttribute: () => tag }) } } as unknown as Event;
      for (const x of [...handlers]) if (x.type === 'click') x.h(ev);
    };
    return { container, click, count: () => handlers.length };
  };

  const published = (): MetricReadOutput => ({
    ...data(),
    publications: [
      { tag: 'ops', metric_id: 'autopilot', season_id: '1', state: 'active', granted_at: NOW },
    ],
  });

  it('⛔⛔ THE STOP BUTTON CALLS metric.unpublish WITH THE TAG', async () => {
    const { container, click } = listening();
    const unpublish = vi.fn(async () => ({ ok: true as const }));
    bootstrapStatsRoute({ container, read: async () => published(), unpublish, now: () => NOW });
    await settle();
    expect(container.innerHTML).toContain('data-recued-publish-stop-action');
    click('ops');
    await settle();
    expect(unpublish).toHaveBeenCalledWith({ tag: 'ops' });
  });

  it('⛔⛔ THE LISTENER IS DELEGATED — one binding, not one per repaint', async () => {
    // Bound to the button instead, the erase would die on the first refresh: every
    // repaint replaces the markup, and the FIRST click is what triggers a repaint. It
    // would work once and then silently stop, which is worse than never working.
    const { container, click, count } = listening();
    const unpublish = vi.fn(async () => ({ ok: true as const }));
    bootstrapStatsRoute({ container, read: async () => published(), unpublish, now: () => NOW });
    await settle();
    expect(count()).toBe(1);
    click('ops');
    await settle();
    click('ops');
    await settle();
    expect(unpublish).toHaveBeenCalledTimes(2);
    expect(count()).toBe(1);
  });

  it('a failed unpublish still refreshes, so the surface never lies about state', async () => {
    const { container, click } = listening();
    const unpublish = vi.fn(async () => { throw new Error('offline'); });
    let reads = 0;
    bootstrapStatsRoute({
      container, unpublish, now: () => NOW,
      read: async () => { reads += 1; return published(); },
    });
    await settle();
    click('ops');
    await settle();
    expect(reads).toBe(2);
  });

  it('⛔ NO STOP ACTION WITHOUT A PUBLICATION — nothing to leave', async () => {
    const { container } = listening();
    bootstrapStatsRoute({ container, read: async () => data(), now: () => NOW });
    await settle();
    expect(container.innerHTML).not.toContain('data-recued-publish-stop-action');
  });

  it('dispose removes the listener', async () => {
    const { container, count } = listening();
    const route = bootstrapStatsRoute({ container, read: async () => published(), now: () => NOW });
    await settle();
    route.dispose();
    expect(count()).toBe(0);
  });
});
