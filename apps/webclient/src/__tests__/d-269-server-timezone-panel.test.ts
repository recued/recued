/** D-269 step 1 — Settings → Server → Timezone + the two-clock preview.
 *
 *  🔑 WHAT THE PANEL IS ACTUALLY FOR. Not "let the owner pick a zone" — it is
 *  where the one fact no clock can report gets SAID: does this machine travel
 *  with its owner? A VPS reading its datacenter zone and a laptop reading its
 *  own are the same code doing the right thing once and the wrong thing once,
 *  and nothing could tell them apart.
 *
 *  ⛔ THE PREVIEW IS THE PART THAT CAN BE WRONG WITHOUT FAILING. A picker that
 *  stores the wrong zone still stores something; the only thing that catches it
 *  is showing the owner what they actually got. So the assertions below pin the
 *  COLLAPSE (one row when the clocks agree), the SPLIT (two when they differ),
 *  and the ASYMMETRY (which row is authoritative) rather than the presence of
 *  text. */

import { describe, expect, it, vi } from 'vitest';
import { twoClockPreview } from '@recued/ui-shared';
import type { ServerTimeZoneGetResponse } from '@recued/contracts';
import {
  mountServerTimeZonePanel,
  SERVER_TZ_CLOCK_ROLE_ATTR,
  SERVER_TZ_CLOCK_ROW_ATTR,
  SERVER_TZ_ERROR_ATTR,
  SERVER_TZ_MODE_ATTR,
  SERVER_TZ_SAVE_ATTR,
  SERVER_TZ_ZONE_INPUT_ATTR,
} from '../settings/server-timezone-panel.js';

/** ⚠ NO JSDOM — the webclient ships none, so every panel test here rolls a
 *  minimal fake document. Same convention as `d-177-rule5-s3-scoped-grant-panel`
 *  and `d-156-phase-5-devices-page-mount`; introducing jsdom for one file would
 *  make this the only panel whose DOM behaves differently from the rest. */
interface FakeEl {
  tagName: string;
  textContent: string;
  type: string;
  name: string;
  value: string;
  placeholder: string;
  checked: boolean;
  disabled: boolean;
  attrs: Map<string, string>;
  children: FakeEl[];
  listeners: Map<string, Array<(e: unknown) => void>>;
  setAttribute(k: string, v: string): void;
  getAttribute(k: string): string | null;
  appendChild(c: FakeEl): FakeEl;
  innerHTML: string;
  addEventListener(t: string, fn: (e: unknown) => void): void;
  dispatchEvent(e: { type: string }): void;
  click(): void;
}

const makeFakeElement = (tag: string): FakeEl => {
  const el: FakeEl = {
    tagName: tag.toUpperCase(),
    textContent: '', type: '', name: '', value: '', placeholder: '',
    checked: false, disabled: false,
    attrs: new Map(), children: [], listeners: new Map(),
    setAttribute(k, v) { el.attrs.set(k, v); },
    getAttribute(k) { return el.attrs.get(k) ?? null; },
    appendChild(c) { el.children.push(c); return c; },
    // ⚠ Models `innerHTML = ''` as a clear, which is what the panel (and every
    // other settings panel) actually uses. The fake previously offered
    // `replaceChildren` instead — and because I wrote the fake AND the panel,
    // both agreed on a method the real composition root's fake does not have.
    set innerHTML(v: string) { if (v === '') el.children.length = 0; },
    get innerHTML() { return ''; },
    addEventListener(t, fn) {
      const list = el.listeners.get(t) ?? [];
      list.push(fn);
      el.listeners.set(t, list);
    },
    dispatchEvent(e) {
      for (const fn of el.listeners.get(e.type) ?? []) fn(e);
    },
    click() {
      if (el.disabled) return;
      for (const fn of el.listeners.get('click') ?? []) fn({ target: el });
    },
  };
  return el;
};

const fakeDocument = { createElement: makeFakeElement } as unknown as Document;

/** Depth-first collect by attribute — the fake has no `querySelector`. */
const byAttr = (root: FakeEl, attr: string, value?: string, out: FakeEl[] = []): FakeEl[] => {
  if (root.attrs.has(attr) && (value === undefined || root.attrs.get(attr) === value)) out.push(root);
  for (const c of root.children) byAttr(c, attr, value, out);
  return out;
};

/** Whole-subtree text, for the "what was stored" round-trip assertions. */
const allText = (root: FakeEl): string =>
  root.textContent + root.children.map(allText).join(' ');

/** A summer instant, so a DST-observing zone renders its DST offset. */
const AT = Date.parse('2026-06-15T20:00:00Z');

const snapshot = (
  over: Partial<ServerTimeZoneGetResponse['setting']> = {},
  resolved = 'Asia/Hong_Kong',
  host = 'Europe/Paris',
): ServerTimeZoneGetResponse => ({
  setting: { mode: 'fixed', zone: 'Asia/Hong_Kong', updated_at: 1, ...over },
  resolved_zone: resolved,
  host_zone: host,
});

const mount = (
  res: ServerTimeZoneGetResponse,
  clientZone = 'Asia/Hong_Kong',
  runSet = vi.fn(async () => res),
) => {
  const host = makeFakeElement('div');
  const panel = mountServerTimeZonePanel({
    host: host as unknown as HTMLElement,
    document: fakeDocument,
    runGet: async () => res,
    runSet,
    now: () => AT,
    clientZone,
    locale: 'en-US',
  });
  return { host, panel, runSet };
};

const clockRows = (host: FakeEl) => byAttr(host, SERVER_TZ_CLOCK_ROW_ATTR);

describe('D-269 — the two-clock preview collapses and splits', () => {
  it('⚠ ONE row when the clocks agree — the collapse is the design, not an empty state', () => {
    // Two identical lines in the common case is clutter that trains people to
    // stop reading, and a preview nobody reads cannot warn anybody.
    const view = twoClockPreview({
      serverZone: 'Asia/Hong_Kong', clientZone: 'Asia/Hong_Kong', at: AT, locale: 'en-US',
    });
    expect(view.rows).toHaveLength(1);
    expect(view.diverged).toBe(false);
  });

  it('⛔ TWO rows when they differ, and they are NOT peers', () => {
    const view = twoClockPreview({
      serverZone: 'Asia/Hong_Kong', clientZone: 'Europe/London', at: AT, locale: 'en-US',
    });
    expect(view.diverged).toBe(true);
    // ⛔ The value is SET in the server's zone; the browser row is a
    // TRANSLATION. Rendered as peers an owner edits the local one — the
    // two-editors failure arriving through visual weight rather than a second
    // input. The roles are what stop a renderer flattening them.
    expect(view.rows.map((r) => r.role)).toEqual(['authoritative', 'translation']);
    expect(view.rows[0]!.zone).toBe('Asia/Hong_Kong');
  });

  it('🔑 divergence is judged on the RENDERED CLOCK, not on the zone ids', () => {
    // `Europe/London` and `Europe/Lisbon` are different ids that read the same.
    // Warning about a difference the owner cannot see is how a warning gets
    // ignored, which costs the case where it matters.
    const view = twoClockPreview({
      serverZone: 'Europe/London', clientZone: 'Europe/Lisbon', at: AT, locale: 'en-US',
    });
    expect(view.diverged).toBe(false);
    expect(view.rows).toHaveLength(1);
  });
});

describe('D-269 — the panel', () => {
  it('renders one clock row for a laptop (server zone === this browser)', async () => {
    const { host, panel } = mount(snapshot({ mode: 'follows_host' }, 'Asia/Hong_Kong'));
    await panel.refresh();
    expect(panel.getState()).toBe('ready');
    expect(clockRows(host)).toHaveLength(1);
    expect(panel.getClocks()?.diverged).toBe(false);
  });

  it('⛔ splits — and marks which row is authoritative — when the owner is elsewhere', async () => {
    const { host, panel } = mount(snapshot({}, 'Asia/Hong_Kong'), 'Europe/London');
    await panel.refresh();
    const rows = clockRows(host);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.getAttribute(SERVER_TZ_CLOCK_ROLE_ATTR)).toBe('authoritative');
    expect(rows[1]!.getAttribute(SERVER_TZ_CLOCK_ROLE_ATTR)).toBe('translation');
  });

  it('🔑 the DEPLOYMENT question leads, and picking follows_host saves immediately', async () => {
    // Asking for a zone first would invite a laptop owner to set one, where the
    // right answer is to follow the host. And `follows_host` needs no second
    // input, so making them press Save would be a step with nothing in it.
    const runSet = vi.fn(async () => snapshot({ mode: 'follows_host' }, 'Europe/London'));
    const { host, panel } = mount(snapshot({ mode: 'fixed' }), 'Asia/Hong_Kong', runSet);
    await panel.refresh();
    const follows = byAttr(host, SERVER_TZ_MODE_ATTR, 'follows_host')[0];
    expect(follows).toBeDefined();
    follows!.checked = true;
    follows!.dispatchEvent({ type: 'change' });
    await Promise.resolve(); await Promise.resolve();
    expect(runSet).toHaveBeenCalledWith({ mode: 'follows_host' });
  });

  it('⚠ picking `fixed` reveals the zone field WITHOUT saving — it has nothing to save yet', async () => {
    const runSet = vi.fn(async () => snapshot());
    const { host, panel } = mount(snapshot({ mode: 'follows_host' }), 'Asia/Hong_Kong', runSet);
    await panel.refresh();
    expect(byAttr(host, SERVER_TZ_ZONE_INPUT_ATTR)).toHaveLength(0);

    const fixed = byAttr(host, SERVER_TZ_MODE_ATTR, 'fixed')[0];
    fixed!.checked = true;
    fixed!.dispatchEvent({ type: 'change' });
    await Promise.resolve();

    expect(byAttr(host, SERVER_TZ_ZONE_INPUT_ATTR)).toHaveLength(1);
    // ⛔ Saving on the radio would either fail (no zone) or silently keep a
    // stale one — a `fixed` that resolves to the host, which is exactly the
    // invisible assumption this whole family exists to abolish.
    expect(runSet).not.toHaveBeenCalled();
  });

  it('⛔ surfaces the SERVER\'s refusal verbatim — it is the only thing that knows why', async () => {
    // Paraphrasing here would put a second, drifting copy of "a fixed offset
    // cannot follow DST" in the client.
    const runSet = vi.fn(async () => {
      throw new Error("server.timezone.set: '-08:00' cannot serve as a wall clock.");
    });
    const { host, panel } = mount(snapshot(), 'Asia/Hong_Kong', runSet);
    await panel.refresh();
    byAttr(host, SERVER_TZ_ZONE_INPUT_ATTR)[0]!.value = '-08:00';
    byAttr(host, SERVER_TZ_SAVE_ATTR)[0]!.click();
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();

    expect(panel.getError()).toContain('cannot serve as a wall clock');
    expect(byAttr(host, SERVER_TZ_ERROR_ATTR)[0]?.textContent)
      .toContain('cannot serve as a wall clock');
  });

  it('⛔⛔ ECHOES WHAT WAS STORED — the only thing that catches `EST` meaning Panama', async () => {
    // `Intl` accepts `EST` and resolves it to `America/Panama`, which never
    // observes DST. No validator can know a New Yorker meant New York, so the
    // round-trip IS the catch: the panel must show the stored id, not the typed
    // string.
    const { host, panel } = mount(
      snapshot({ mode: 'fixed', zone: 'America/Panama' }, 'America/Panama'),
      'America/New_York',
    );
    await panel.refresh();
    expect(allText(host)).toContain('Saved as America/Panama.');
    // And the divergence is visible at the same moment: Panama and New York are
    // an hour apart in summer, which is the whole cost of the mistake.
    expect(panel.getClocks()?.diverged).toBe(true);
  });
});
