/** D-145 PA11 — bootstrap-settings-route wiring for the "LLM result
 *  cache" card.
 *
 *  Mirrors the slice-111 / D-156 / D-145 PA10 follow-on sections of
 *  `d-148-bootstrap-settings-route.test.ts` — fake DOM with the
 *  `children` accessor + style-tag bookkeeping. Covers:
 *
 *    - card NOT mounted when `housekeepingCacheStatsCaller` omitted.
 *    - card mounted (inside the AI / Models section) when caller supplied.
 *    - Server section does not mount for cache-only after the D-174 D14
 *      relocation.
 *    - Stats caller threaded through; the mount fires it on first
 *      paint.
 *    - Clear caller independently optional — stats-only renders
 *      read-only (no Clear button).
 *    - `llmResultCacheCard()` accessor returns the mount handle when
 *      mounted, null otherwise.
 *    - Style bundle includes the card's self-scoped CSS.
 *    - Dispose tears the card down before the parent section node is
 *      removed. */

import { describe, expect, it, vi } from 'vitest';

import {
  bootstrapSettingsRoute,
  SETTINGS_ROUTE_SECTION_ATTR,
  SETTINGS_ROUTE_STYLES_MARKER,
} from '../settings/bootstrap-settings-route.js';
import {
  LLM_RESULT_CACHE_CARD_STYLES,
  type LlmResultCacheClearCaller,
  type LlmResultCacheStatsCaller,
} from '../settings/llm-result-cache-card-mount.js';
import { createInMemoryWebclientLocalStore } from '../storage/local-store.js';

// ──────────────────────────────────────────────────────────────────
// Minimal fake DOM (copy of d-148-bootstrap-settings-route.test.ts;
// kept local so this file isn't coupled to the larger fixture).
// ──────────────────────────────────────────────────────────────────

interface FakeElement {
  tagName: string;
  textContent: string;
  disabled: boolean;
  className: string;
  value: string;
  readOnly: boolean;
  innerHTML: string;
  children: FakeElement[];
  parent: FakeElement | null;
  attrs: Map<string, string>;
  listeners: Map<string, Array<(ev: unknown) => void>>;
  setAttribute(k: string, v: string): void;
  removeAttribute(k: string): void;
  getAttribute(k: string): string | null;
  hasAttribute(k: string): boolean;
  appendChild(el: FakeElement): FakeElement;
  removeChild(el: FakeElement): FakeElement;
  readonly firstChild: FakeElement | null;
  remove(): void;
  addEventListener(name: string, fn: (ev: unknown) => void): void;
  removeEventListener(name: string, fn: (ev: unknown) => void): void;
  click(): void;
  type: string;
}

const makeFakeElement = (tagName: string): FakeElement => {
  const listeners = new Map<string, Array<(ev: unknown) => void>>();
  const attrs = new Map<string, string>();
  const children: FakeElement[] = [];
  const el: FakeElement = {
    tagName: tagName.toUpperCase(),
    textContent: '',
    disabled: false,
    className: '',
    value: '',
    readOnly: false,
    innerHTML: '',
    type: '',
    children,
    parent: null,
    attrs,
    listeners,
    setAttribute: (k, v) => attrs.set(k, v),
    removeAttribute: (k) => attrs.delete(k),
    getAttribute: (k) => attrs.get(k) ?? null,
    hasAttribute: (k) => attrs.has(k),
    appendChild: (next) => {
      children.push(next);
      next.parent = el;
      return next;
    },
    removeChild: (target) => {
      const idx = children.indexOf(target);
      if (idx < 0) throw new Error('removeChild: not a child');
      children.splice(idx, 1);
      target.parent = null;
      return target;
    },
    get firstChild() {
      return children[0] ?? null;
    },
    remove: () => {
      if (el.parent) el.parent.removeChild(el);
    },
    addEventListener: (name, fn) => {
      const arr = listeners.get(name) ?? [];
      arr.push(fn);
      listeners.set(name, arr);
    },
    removeEventListener: (name, fn) => {
      const arr = listeners.get(name);
      if (!arr) return;
      const idx = arr.indexOf(fn);
      if (idx >= 0) arr.splice(idx, 1);
    },
    click: () => {
      const arr = listeners.get('click') ?? [];
      for (const fn of arr) fn({ target: el });
    },
  };
  return el;
};

interface FakeDocument {
  createElement(tag: string): FakeElement;
  head: {
    appendChild(el: FakeElement): FakeElement;
    querySelector(selector: string): FakeElement | null;
  };
  styleTags: FakeElement[];
}

const makeFakeDocument = (): FakeDocument => {
  const styleTags: FakeElement[] = [];
  const parseSelector = (sel: string): { tag: string; attr: string } | null => {
    const m = sel.match(/^([\w-]+)\[([\w-]+)\]$/);
    return m === null ? null : { tag: m[1]!.toUpperCase(), attr: m[2]! };
  };
  return {
    createElement: (tag) => makeFakeElement(tag),
    head: {
      appendChild: (next) => {
        styleTags.push(next);
        return next;
      },
      querySelector: (selector) => {
        const parsed = parseSelector(selector);
        if (parsed === null) return null;
        return (
          styleTags.find(
            (s) => s.tagName === parsed.tag && s.attrs.has(parsed.attr),
          ) ?? null
        );
      },
    },
    styleTags,
  };
};

const findByAttrValue = (
  root: FakeElement,
  attr: string,
  value: string,
): FakeElement | null => {
  if (root.getAttribute(attr) === value) return root;
  for (const c of root.children) {
    const hit = findByAttrValue(c, attr, value);
    if (hit) return hit;
  }
  return null;
};

const findByDataAttr = (
  root: FakeElement,
  attr: string,
): FakeElement | null => {
  if (root.hasAttribute(attr)) return root;
  for (const c of root.children) {
    const hit = findByDataAttr(c, attr);
    if (hit) return hit;
  }
  return null;
};

// ──────────────────────────────────────────────────────────────────
// Fixtures
// ──────────────────────────────────────────────────────────────────

const populatedStatsResult = () => ({
  total_entries: 12,
  total_hits: 36,
  per_topic: [{ topic: 'summary' as const, entry_count: 12, hit_count: 36 }],
  last_gc_at: null as number | null,
});

const buildRoute = (overrides: {
  housekeepingCacheStatsCaller?: LlmResultCacheStatsCaller;
  housekeepingCacheClearCaller?: LlmResultCacheClearCaller;
} = {}): {
  host: FakeElement;
  doc: FakeDocument;
  route: ReturnType<typeof bootstrapSettingsRoute>;
} => {
  const host = makeFakeElement('div');
  const doc = makeFakeDocument();
  const route = bootstrapSettingsRoute({
    root: host as unknown as HTMLElement,
    document: doc as unknown as Document,
    localStore: createInMemoryWebclientLocalStore(),
    ...overrides,
  });
  return { host, doc, route };
};

// ──────────────────────────────────────────────────────────────────
// Gated mount
// ──────────────────────────────────────────────────────────────────

describe('D-145 PA11 — bootstrapSettingsRoute: cache card gated mount', () => {
  it('does NOT mount AI / Models or Server when no AI/Server caller is supplied', () => {
    const { host, route } = buildRoute();
    expect(findByAttrValue(host, SETTINGS_ROUTE_SECTION_ATTR, 'ai-models')).toBeNull();
    expect(findByAttrValue(host, SETTINGS_ROUTE_SECTION_ATTR, 'server')).toBeNull();
    expect(route.llmResultCacheCard()).toBeNull();
    route.dispose();
  });

  it('mounts the AI / Models section + cache card when only the stats caller is supplied', () => {
    const runStats = vi.fn(async () => populatedStatsResult());
    const { host, route } = buildRoute({ housekeepingCacheStatsCaller: runStats });

    const aiModels = findByAttrValue(host, SETTINGS_ROUTE_SECTION_ATTR, 'ai-models');
    expect(aiModels).not.toBeNull();
    const server = findByAttrValue(host, SETTINGS_ROUTE_SECTION_ATTR, 'server');
    expect(server).toBeNull();
    const cardHost = findByDataAttr(host, 'data-recued-cache-card-host');
    expect(cardHost).not.toBeNull();
    expect(route.llmResultCacheCard()).not.toBeNull();
    route.dispose();
  });

  it('fires the stats caller on mount', async () => {
    const runStats = vi.fn(async () => populatedStatsResult());
    const { route } = buildRoute({ housekeepingCacheStatsCaller: runStats });

    expect(runStats).toHaveBeenCalledTimes(1);
    await route.llmResultCacheCard()!.whenLoaded();
    expect(route.llmResultCacheCard()!.getState().stats?.total_entries).toBe(12);
    route.dispose();
  });

  it('clear caller is independently optional — stats-only mount renders read-only', async () => {
    const runStats = vi.fn(async () => populatedStatsResult());
    const { route } = buildRoute({ housekeepingCacheStatsCaller: runStats });

    await route.llmResultCacheCard()!.whenLoaded();
    // Read-only — confirming-clear can't be set because runClear is
    // absent; the renderer also suppresses the Clear button. The
    // mount's getState reflects the closed-flag state.
    expect(route.llmResultCacheCard()!.getState().confirmingClear).toBe(false);
    route.dispose();
  });

  it('threads both callers when supplied + clear refreshes stats on success', async () => {
    let statsCallCount = 0;
    const runStats = vi.fn(async () => {
      statsCallCount += 1;
      return statsCallCount === 1
        ? populatedStatsResult()
        : {
            total_entries: 0,
            total_hits: 0,
            per_topic: [],
            last_gc_at: null as number | null,
          };
    });
    const runClear = vi.fn(async () => ({ ok: true as const, rows_deleted: 12 }));

    const { host, route } = buildRoute({
      housekeepingCacheStatsCaller: runStats,
      housekeepingCacheClearCaller: runClear,
    });
    const cardMount = route.llmResultCacheCard()!;
    await cardMount.whenLoaded();

    // Drive the clear flow by firing synthetic clicks against the
    // card-host element's click listener. The card-host is attached
    // INSIDE the route's Server section; we walk to it via the data-
    // attr stamp.
    const cardHost = findByDataAttr(host, 'data-recued-cache-card-host')!;
    const synthesizeClick = (action: string): void => {
      const actionEl = {
        getAttribute: (name: string) =>
          name === 'data-action' ? action : null,
      };
      const target = {
        closest: (sel: string) =>
          sel === '[data-action]' ? actionEl : null,
      };
      const listenersMap = cardHost.listeners;
      const handlers = listenersMap.get('click') ?? [];
      for (const fn of handlers) {
        fn({ target } as unknown as Event);
      }
    };

    synthesizeClick('housekeeping-cache-clear');
    synthesizeClick('housekeeping-cache-clear-confirm');
    await cardMount.whenClearSettled();

    expect(runClear).toHaveBeenCalledTimes(1);
    expect(runStats).toHaveBeenCalledTimes(2);
    expect(cardMount.getState().stats?.total_entries).toBe(0);
    route.dispose();
  });
});

// ──────────────────────────────────────────────────────────────────
// Style bundle
// ──────────────────────────────────────────────────────────────────

describe('D-145 PA11 — bootstrapSettingsRoute: style bundle', () => {
  it('includes LLM_RESULT_CACHE_CARD_STYLES in the marker-guarded style tag', () => {
    const runStats = vi.fn(async () => populatedStatsResult());
    const { doc, route } = buildRoute({
      housekeepingCacheStatsCaller: runStats,
    });
    expect(doc.styleTags).toHaveLength(1);
    const style = doc.styleTags[0]!;
    expect(style.hasAttribute(SETTINGS_ROUTE_STYLES_MARKER)).toBe(true);
    expect(style.textContent).toContain(LLM_RESULT_CACHE_CARD_STYLES.trim());
    expect(style.textContent).toContain('.housekeeping-cache-card');
    route.dispose();
  });

  it('still injects the bundle even when no cache caller is supplied (no-op scoped CSS)', () => {
    const { doc, route } = buildRoute();
    expect(doc.styleTags).toHaveLength(1);
    const style = doc.styleTags[0]!;
    // The CSS is inert when no .housekeeping-cache-card element exists,
    // so always injecting is fine + avoids a per-mount style flip.
    expect(style.textContent).toContain('.housekeeping-cache-card');
    route.dispose();
  });
});

// ──────────────────────────────────────────────────────────────────
// Dispose chain
// ──────────────────────────────────────────────────────────────────

describe('D-145 PA11 — bootstrapSettingsRoute: dispose', () => {
  it('disposes the card mount before removing the route root', async () => {
    const runStats = vi.fn(async () => populatedStatsResult());
    const { host, route } = buildRoute({
      housekeepingCacheStatsCaller: runStats,
    });
    await route.llmResultCacheCard()!.whenLoaded();
    route.dispose();
    // After dispose the cache-card-host attribute is cleared by the
    // mount's dispose path.
    expect(findByDataAttr(host, 'data-recued-cache-card-host')).toBeNull();
    // Route root removed.
    expect(host.children.length).toBe(0);
  });
});
