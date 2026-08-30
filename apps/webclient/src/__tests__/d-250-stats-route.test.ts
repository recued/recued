/** D-250 § D7 — the `#stats` route mount.
 *
 *  🔑 THE PANEL'S RENDERING IS TESTED IN ui-shared. What is testable ONLY here is the
 *  seam: that the route reaches the rpc, that a FAILED read does not render as an empty
 *  server, and that no publish action exists while § D4's grant is unbuilt.
 */

import { describe, expect, it, vi } from 'vitest';
import { metricValue, type MetricReadOutput } from '@recued/contracts';

import { bootstrapStatsRoute, STATS_ROUTE_HOST_ATTR } from '../stats/bootstrap-stats-route.js';

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
/** ⚠ THE STUB GREW A DOCUMENT, and the reason is the bug it now covers. The
 *  route used to paint straight into the shell's `contentRoot`, so a bare
 *  `{ innerHTML }` was enough to test it — and that sufficiency was the defect:
 *  a route that only sets `innerHTML` has nothing to REMOVE, so navigating away
 *  left the whole page on screen under its successor. It owns an element now,
 *  which needs `createElement` / `appendChild` / `remove`. Still not a DOM —
 *  four capabilities, so nothing here is testing jsdom. */
const fakeEl = (tag: string) => {
  const el = {
    tagName: tag.toUpperCase(),
    innerHTML: '',
    parent: null as null | { children: unknown[] },
    attrs: new Map<string, string>(),
    setAttribute(k: string, v: string) { el.attrs.set(k, v); },
    getAttribute(k: string) { return el.attrs.get(k) ?? null; },
    remove() {
      const kids = el.parent?.children;
      if (kids === undefined) return;
      const i = kids.indexOf(el);
      if (i >= 0) kids.splice(i, 1);
      el.parent = null;
    },
    appendChild(c: { parent: unknown }) { c.parent = el as never; return c; },
    children: [] as unknown[],
    querySelector: () => null,
  };
  return el;
};

/** The four capabilities the route needs of a document. Shared, because BOTH
 *  containers in this file must carry one now — a container without an
 *  `ownerDocument` cannot own an element, and the route's whole dispose
 *  correctness rests on owning one. */
const fakeDoc = () => {
  // ⚠ A REAL-ENOUGH head: it REMEMBERS what was appended and answers
  // querySelector from it. A `querySelector: () => null` stub always reports
  // "no sheet yet", so the once-only guard can never be observed failing —
  // it would pass against a route that stacked a fresh copy every mount.
  const appended: Array<{ attrs: Map<string, string> }> = [];
  return {
    createElement: fakeEl,
    head: {
      appended,
      querySelector: (sel: string) => {
        const attr = /^style\[([^\]]+)\]$/.exec(sel)?.[1];
        return appended.find((n) => attr !== undefined && n.attrs.has(attr)) ?? null;
      },
      appendChild: (n: { attrs: Map<string, string> }) => { appended.push(n); return n; },
    },
  };
};

/** A container the route can own an element inside.
 *
 *  ⚠ `innerHTML` is a GETTER over its children. Every assertion in this file
 *  reads `container.innerHTML`, and the markup now lives one level down on the
 *  route's own element — so the reader keeps its shape while the route stops
 *  writing into the shell's node. That indirection IS the fix, restated. */
const fakeContainer = (extra: Record<string, unknown> = {}) => {
  const container = {
    children: [] as Array<{ innerHTML: string; parent: unknown }>,
    ownerDocument: fakeDoc(),
    appendChild(c: { parent: unknown }) {
      c.parent = container as never;
      container.children.push(c as never);
      return c;
    },
    addEventListener() {},
    removeEventListener() {},
    ...extra,
  };
  Object.defineProperty(container, 'innerHTML', {
    get: () => container.children.map((c) => c.innerHTML).join(''),
    configurable: true,
  });
  return container as unknown as HTMLElement;
};

/** ⛔ THE FOUR DEPS ARE REQUIRED, so every mount states all four. That is the point:
 *  the composition root cannot forward three of them and quietly drop the fourth, which
 *  is exactly how the publish path shipped dead. A test spreading this helper still
 *  overrides whichever one it is actually asserting on. */
const deps = () => ({
  unpublish: vi.fn(async () => ({ ok: true as const })),
  publish: vi.fn(async () => ({ ok: true as const })),
  submit: vi.fn(async () => ({ sent: false as const, skip_reason: 'no_handle' as const, results: [] })),
});

const mount = (read: () => Promise<MetricReadOutput>, into?: HTMLElement) => {
  const container = into ?? fakeContainer();
  const route = bootstrapStatsRoute({ ...deps(), container, read, now: () => NOW });
  return { container, route };
};

const headOf = (c: HTMLElement) =>
  (c as unknown as { ownerDocument: { head: { appended: Array<{ textContent: string }> } } })
    .ownerDocument.head.appended;

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

describe('D-250 § D4 — the publish entry point EXISTS', () => {
  /** ⛔⛔ THIS BLOCK USED TO ASSERT THE OPPOSITE, AND THAT IS THE DEFECT IT NOW COVERS.
   *  It read "no publish action while the grant is unbuilt" and checked the panel
   *  contained no `<button>` at all. The grant shipped; the dialog and the erase shipped
   *  with it — and NOTHING RENDERED AN ENTRY POINT, so `renderPublications` returned ''
   *  forever, the dialog was unreachable, and this test stayed green over the whole dead
   *  surface. A negative assertion outlived the premise that justified it.
   *
   *  🔑 THE ORIGINAL CALL WAS HALF RIGHT: no button should GUESS a tag. The conclusion
   *  did not follow — ask for one. § D4's legitimacy is the owner's act, and typing a tag
   *  IS that act. */
  it('⛔⛔ A PUBLISHABLE METRIC RENDERS A WAY TO PUBLISH IT', async () => {
    const { container } = mount(async () => data());
    await settle();
    expect(container.innerHTML).toContain('data-recued-publish-start="autopilot"');
    expect(container.innerHTML).toContain('data-recued-publish-preview-action');
  });

  it('⛔ NO ENTRY POINT FOR A NON-PUBLISHABLE METRIC — the rpc would refuse it', async () => {
    const { container } = mount(async () => data({
      snapshot: {
        computed_at: NOW,
        window: { from: NOW - 86_400_000, to: NOW },
        metrics: [{ metric_id: 'runs', metric_version: 1, reading: metricValue(12),
          label: 'Runs', shape: 'count', direction: 'higher', publishable: false }],
      },
    }));
    await settle();
    expect(container.innerHTML).not.toContain('data-recued-publish-start');
  });
});

describe('D-250 — the surface carries its own stylesheet', () => {
  it('⛔⛔ THE ROWS ARE A REAL TABLE, AND WIDE CONTENT SCROLLS IN ITS OWN BOX', async () => {
    const { container } = mount(async () => data());
    await Promise.resolve();
    const sheet = headOf(container).map((n) => n.textContent).join('');
    // The live defect this replaces: with no sheet anywhere, the browser fell
    // back to `display: list-item` + `list-style: disc`, so metric readings
    // rendered as bullet points with their spans running together. The lists are
    // tables now, so the un-bulleting rule went with the markup that needed it.
    expect(sheet).toContain('border-collapse: collapse');
    expect(sheet).toContain('.stats-table__meaning');
    // ⛔ THE PAGE BODY MUST NEVER SCROLL SIDEWAYS — a three-column table on a
    // narrow screen scrolls inside its own wrapper instead.
    expect(sheet).toMatch(/\.stats-table-wrap \{[^}]*overflow-x: auto/);
    expect(sheet).toContain(STATS_ROUTE_HOST_ATTR);
  });

  it('⛔ A SECOND MOUNT DOES NOT STACK A SECOND COPY OF THE SHEET', async () => {
    const { container } = mount(async () => data());
    await Promise.resolve();
    expect(headOf(container)).toHaveLength(1);
    mount(async () => data(), container);
    await Promise.resolve();
    expect(headOf(container)).toHaveLength(1);
  });
});

describe('D-250 — dispose', () => {
  /** ⛔⛔ THE HALF THAT WAS MISSING, AND THE BUG IT LET THROUGH. The shell
   *  calls `dispose()` and then mounts the next route; it NEVER clears
   *  `contentRoot`, so a route that does not remove its own markup leaves the
   *  page on screen and the next one renders UNDERNEATH it. Two dispose tests
   *  already existed — a late read does not paint, the listener is dropped —
   *  and neither asked whether anything was still on the page. Driven live
   *  before the fix: `#stats` → `#chat` left the Stats heading, its note, AND
   *  the chat route in `contentRoot`. */
  it('removes its markup from the container, not just its listener', async () => {
    const { container, route } = mount(async () => data());
    await settle();
    expect(container.innerHTML).toContain('Autopilot');

    route.dispose();

    expect(
      (container as unknown as { children: unknown[] }).children,
    ).toHaveLength(0);
    expect(container.innerHTML).toBe('');
  });

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
    const container = fakeContainer({
      addEventListener: (type: string, h: (e: Event) => void) => { handlers.push({ type, h }); },
      removeEventListener: (type: string, h: (e: Event) => void) => {
        const i = handlers.findIndex((x) => x.type === type && x.h === h);
        if (i >= 0) handlers.splice(i, 1);
      },
    });
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
    bootstrapStatsRoute({ ...deps(), container, read: async () => published(), unpublish, now: () => NOW });
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
    bootstrapStatsRoute({ ...deps(), container, read: async () => published(), unpublish, now: () => NOW });
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
      ...deps(),
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
    bootstrapStatsRoute({ ...deps(), container, read: async () => data(), now: () => NOW });
    await settle();
    expect(container.innerHTML).not.toContain('data-recued-publish-stop-action');
  });

  it('dispose removes the listener', async () => {
    const { container, count } = listening();
    const route = bootstrapStatsRoute({ ...deps(), container, read: async () => published(), now: () => NOW });
    await settle();
    route.dispose();
    expect(count()).toBe(0);
  });
});

// ────────────────────────────────────────────────────────────────
// § D7 — the two-step publish: name a tag → SEE the bytes → confirm
// ────────────────────────────────────────────────────────────────

/** ⛔⛔ EVERY TARGET HERE IS DERIVED FROM THE RENDERED MARKUP, NEVER HAND-BUILT.
 *  The erase harness above builds `{ closest: () => ({ getAttribute: () => tag }) }` —
 *  which matches EVERY selector and answers EVERY attribute, so it can prove a handler
 *  runs but never that the panel renders the thing the handler looks for. That is the
 *  exact seam that broke: the dialog and the route agreed, and nothing rendered the
 *  entry point. So this double parses the panel's own HTML: a selector the markup does
 *  not carry resolves to null and the flow dies here as it would in a browser. */
const rendered = (html: string) => {
  const els: Array<Map<string, string>> = [];
  for (const tag of html.matchAll(/<(\w+)([^>]*?)\/?>/g)) {
    const attrs = new Map<string, string>();
    for (const a of (tag[2] ?? '').matchAll(/([\w-]+)(?:="([^"]*)")?/g)) {
      attrs.set(a[1] ?? '', a[2] ?? '');
    }
    els.push(attrs);
  }
  return els;
};

const attrOf = (sel: string): { name: string; value?: string } => {
  const m = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(sel);
  if (m === null) throw new Error(`the route used a selector this double cannot model: ${sel}`);
  return m[2] === undefined ? { name: m[1] ?? '' } : { name: m[1] ?? '', value: m[2] };
};

const matches = (attrs: Map<string, string>, sel: string): boolean => {
  const { name, value } = attrOf(sel);
  if (!attrs.has(name)) return false;
  return value === undefined || attrs.get(name) === value;
};

/** A container that answers `querySelector` from the live markup and holds what the
 *  owner "typed" into each input. */
const publishHost = () => {
  const handlers: Array<{ type: string; h: (e: Event) => void }> = [];
  const inputs = new Map<string, string>();
  const container = fakeContainer({
    addEventListener: (type: string, h: (e: Event) => void) => { handlers.push({ type, h }); },
    removeEventListener: (type: string, h: (e: Event) => void) => {
      const i = handlers.findIndex((x) => x.type === type && x.h === h);
      if (i >= 0) handlers.splice(i, 1);
    },
    querySelector: (sel: string) => {
      const els = rendered(container.innerHTML);
      const start = els.findIndex((a) => matches(a, sel));
      if (start < 0) return null;
      return {
        // Scoped to the form: scan forward from it until the next form starts.
        querySelector: (inner: string) => {
          for (let i = start + 1; i < els.length; i += 1) {
            const attrs = els[i];
            if (attrs === undefined) break;
            if (attrs.has('data-recued-publish-start')) break;
            if (matches(attrs, inner)) {
              const key = `${attrOf(sel).value ?? ''}:${attrOf(inner).name}`;
              // ⚠ `.value` in a browser is what the owner TYPED, falling back to the
              // rendered `value` attribute. Both halves matter: the season field ships a
              // default and the tag field does not.
              return { value: inputs.get(key) ?? attrs.get('value') ?? '' };
            }
          }
          return null;
        },
      };
    },
  }) as unknown as HTMLElement & { innerHTML: string };
  const type = (metric: string, field: string, value: string) => {
    inputs.set(`${metric}:${field}`, value);
  };
  const click = (sel: string) => {
    const attrs = rendered(container.innerHTML).find((a) => matches(a, sel));
    if (attrs === undefined) throw new Error(`nothing in the panel matches ${sel}`);
    const ev = {
      target: {
        closest: (want: string) => (matches(attrs, want)
          ? { getAttribute: (k: string) => attrs.get(k) ?? null }
          : null),
      },
    } as unknown as Event;
    for (const x of [...handlers]) if (x.type === 'click') x.h(ev);
  };
  return { container, click, type };
};

describe('D-250 § D7 — publish is two steps, and step one sends nothing', () => {
  it('⛔⛔ PREVIEW SENDS NOTHING — it only opens the payload', async () => {
    // § D7: "the publish dialog carries the whole payload … before any of it leaves".
    // A one-click publish would send a number the owner never saw, which is the entire
    // reason the dialog exists.
    const { container, click, type } = publishHost();
    const publish = vi.fn(async () => ({ ok: true as const }));
    bootstrapStatsRoute({ ...deps(), container, read: async () => data(), publish, now: () => NOW });
    await settle();
    type('autopilot', 'data-recued-publish-tag', 'ops');
    click('[data-recued-publish-preview-action]');
    await settle();
    expect(publish).not.toHaveBeenCalled();
    expect(container.innerHTML).toContain('data-recued-publish-confirm="autopilot"');
    // The bytes themselves — the tag the owner typed and the value being published.
    expect(container.innerHTML).toContain('https://recued.com/explore/ops');
    expect(container.innerHTML).toContain('0.5');
  });

  it('⛔⛔ CONFIRM PUBLISHES EXACTLY WHAT THE PREVIEW SHOWED', async () => {
    const { container, click, type } = publishHost();
    const publish = vi.fn(async () => ({ ok: true as const }));
    bootstrapStatsRoute({ ...deps(), container, read: async () => data(), publish, now: () => NOW });
    await settle();
    type('autopilot', 'data-recued-publish-tag', 'ops');
    click('[data-recued-publish-preview-action]');
    await settle();
    click('[data-recued-publish-confirm-action]');
    await settle();
    expect(publish).toHaveBeenCalledWith({
      tag: 'ops', metric_id: 'autopilot', season_id: '1',
    });
  });

  it('⛔ AN EMPTY TAG OPENS NOTHING — a payload addressed to nowhere', async () => {
    const { container, click } = publishHost();
    const publish = vi.fn(async () => ({ ok: true as const }));
    bootstrapStatsRoute({ ...deps(), container, read: async () => data(), publish, now: () => NOW });
    await settle();
    click('[data-recued-publish-preview-action]');
    await settle();
    expect(container.innerHTML).not.toContain('data-recued-publish-confirm=');
    expect(publish).not.toHaveBeenCalled();
  });

  it('the season the owner edits is the season that is published', async () => {
    // ⚠ Not a restatement of the confirm test: that one rides the rendered default, so
    // it would pass against a route that ignored the field and hard-coded '1'.
    const { container, click, type } = publishHost();
    const publish = vi.fn(async () => ({ ok: true as const }));
    bootstrapStatsRoute({ ...deps(), container, read: async () => data(), publish, now: () => NOW });
    await settle();
    type('autopilot', 'data-recued-publish-tag', 'ops');
    type('autopilot', 'data-recued-publish-season', '2026h2');
    click('[data-recued-publish-preview-action]');
    await settle();
    click('[data-recued-publish-confirm-action]');
    await settle();
    expect(publish).toHaveBeenCalledWith({
      tag: 'ops', metric_id: 'autopilot', season_id: '2026h2',
    });
  });

  it('cancel closes the preview and publishes nothing', async () => {
    const { container, click, type } = publishHost();
    const publish = vi.fn(async () => ({ ok: true as const }));
    bootstrapStatsRoute({ ...deps(), container, read: async () => data(), publish, now: () => NOW });
    await settle();
    type('autopilot', 'data-recued-publish-tag', 'ops');
    click('[data-recued-publish-preview-action]');
    await settle();
    click('[data-recued-publish-cancel-action]');
    await settle();
    expect(publish).not.toHaveBeenCalled();
    expect(container.innerHTML).not.toContain('data-recued-publish-confirm=');
    expect(container.innerHTML).toContain('data-recued-publish-start="autopilot"');
  });

  it('⛔ A PREVIEW LEFT OPEN DOES NOT SURVIVE THE NEXT PUBLISH', async () => {
    // Otherwise the confirm button repaints under the owner's cursor after the publish
    // it already performed, and a second click double-publishes.
    const { container, click, type } = publishHost();
    const publish = vi.fn(async () => ({ ok: true as const }));
    bootstrapStatsRoute({ ...deps(), container, read: async () => data(), publish, now: () => NOW });
    await settle();
    type('autopilot', 'data-recued-publish-tag', 'ops');
    click('[data-recued-publish-preview-action]');
    await settle();
    click('[data-recued-publish-confirm-action]');
    await settle();
    expect(container.innerHTML).not.toContain('data-recued-publish-confirm=');
  });
});

describe('D-250 § B3.3 — send the batch now', () => {
  const published = (): MetricReadOutput => ({
    ...data(),
    publications: [
      { tag: 'ops', metric_id: 'autopilot', season_id: '1', state: 'active', granted_at: NOW },
    ],
  });

  it('⛔⛔ THE SUBMIT BUTTON CALLS metric.submit', async () => {
    const { container, click } = publishHost();
    const submit = vi.fn(async () => ({ sent: true as const, results: [] }));
    bootstrapStatsRoute({ ...deps(), container, read: async () => published(), submit, now: () => NOW });
    await settle();
    click('[data-recued-submit-action]');
    await settle();
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it('⛔ NOTHING TO SEND, NO BUTTON — an unpublished server has no batch', async () => {
    const { container } = publishHost();
    bootstrapStatsRoute({ ...deps(), container, read: async () => data(), now: () => NOW });
    await settle();
    expect(container.innerHTML).not.toContain('data-recued-submit-action');
  });

  it('a failed submit still refreshes, so the surface never lies about state', async () => {
    const { container, click } = publishHost();
    let reads = 0;
    bootstrapStatsRoute({
      ...deps(),
      container, now: () => NOW,
      submit: async () => { throw new Error('offline'); },
      read: async () => { reads += 1; return published(); },
    });
    await settle();
    click('[data-recued-submit-action]');
    await settle();
    expect(reads).toBe(2);
  });
});


// ────────────────────────────────────────────────────────────────
// § B3.3 — the route RENDERS what the submit returned
// ────────────────────────────────────────────────────────────────

describe('D-250 § B3.3 — the submit outcome reaches the screen', () => {
  const published = (): MetricReadOutput => ({
    ...data(),
    publications: [
      { tag: 'ops', metric_id: 'autopilot', season_id: '1', state: 'active', granted_at: NOW },
    ],
  });

  const drive = async (submit: () => Promise<never> | Promise<unknown>) => {
    const { container, click } = publishHost();
    bootstrapStatsRoute({
      ...deps(), container, read: async () => published(), now: () => NOW,
      submit: submit as never,
    });
    await settle();
    click('[data-recued-submit-action]');
    await settle();
    return container;
  };

  it('⛔⛔ A SKIP REASON IS RENDERED — the press is never silent', async () => {
    // The defect this replaces: `void submit().then(refresh, refresh)` threw the result
    // away, so the screen was identical before and after. With no board existing anywhere
    // yet, that button could only ever do nothing visible.
    const container = await drive(async () => ({
      sent: false, skip_reason: 'nothing_measured', results: [],
    }));
    expect(container.innerHTML).toContain('data-recued-submit-status="nothing_measured"');
  });

  it('a successful send renders the sent status with its board count', async () => {
    const container = await drive(async () => ({
      sent: true, results: [{ kind: 'ranked' }, { kind: 'ranked' }],
    }));
    expect(container.innerHTML).toContain('data-recued-submit-status="sent"');
    expect(container.innerHTML).toContain('2 boards updated');
  });

  /** ⛔⛔ THE ROUTE USED TO COUNT `results.length`, so a batch whose every entry came back
   *  `{kind:'rejected', reason:'unknown_board'}` rendered as "2 boards answered" — an
   *  unqualified success for a submission where nothing the owner published was accepted.
   *  With no board existing anywhere in production yet, that is the batch every server
   *  would have got on its first press. */
  it('⛔⛔ AN ALL-REJECTED BATCH IS NOT REPORTED AS SUCCESS', async () => {
    const container = await drive(async () => ({
      sent: true,
      results: [
        { kind: 'rejected', reason: 'unknown_board' },
        { kind: 'rejected', reason: 'unknown_board' },
      ],
    }));
    expect(container.innerHTML).toContain('data-recued-submit-status="rejected"');
    expect(container.innerHTML).toContain('Nothing was accepted');
    expect(container.innerHTML).toContain('unknown_board');
  });

  it('a mixed batch names both halves', async () => {
    const container = await drive(async () => ({
      sent: true,
      results: [{ kind: 'ranked' }, { kind: 'rejected', reason: 'unknown_board' }],
    }));
    expect(container.innerHTML).toContain('data-recued-submit-status="sent"');
    expect(container.innerHTML).toContain('1 board updated');
    expect(container.innerHTML).toContain('1 entry rejected');
  });

  it('⛔ A CONFIRMED WITHDRAWAL IS COUNTED SEPARATELY, not as a board update', async () => {
    // § C4 — the ack is the only thing that terminates a withdrawal's retry, and it is
    // not a score landing.
    const container = await drive(async () => ({
      sent: true, results: [{ kind: 'withdrawn' }],
    }));
    expect(container.innerHTML).toContain('1 withdrawal confirmed');
    expect(container.innerHTML).not.toContain('board updated');
  });

  it('⛔ AN UNKNOWN `kind` COUNTS AS REJECTED, never as a score that landed', async () => {
    // A kind a future cloud adds must not be reported to the owner as success by a build
    // that has never heard of it.
    const container = await drive(async () => ({
      sent: true, results: [{ kind: 'some_future_kind' }],
    }));
    expect(container.innerHTML).toContain('data-recued-submit-status="rejected"');
  });

  it('⛔ AN RPC REJECTION IS A SEND FAILURE, NOT SILENCE', async () => {
    const container = await drive(async () => { throw new Error('socket closed'); });
    expect(container.innerHTML).toContain('data-recued-submit-status="send_failed"');
  });

  it('⛔ A NOT-SENT RESULT WITH NO REASON READS AS send_failed, never as nothing', async () => {
    // Only reachable from a server older than the field. "It did not send and will not
    // say why" is the recoverable fault — treating it as success, or as silence, would
    // reintroduce exactly what this fixes.
    const container = await drive(async () => ({ sent: false, results: [] }));
    expect(container.innerHTML).toContain('data-recued-submit-status="send_failed"');
  });
});
