/** Supervision feature (Slice 4) — the pack-detail supervised-daemon controls.
 *
 *  Exercises the `createSupervisionController` flow against a fake server whose
 *  `supervision.set` mutates an in-memory enrollment that `supervision.list`
 *  reflects (discovery + merge), driving the optimistic→reconcile path end to
 *  end: discovery renders an un-enrolled `off` control, an enrol emits exactly
 *  one `supervision.set` with the right `{mode, enabled, args}` then re-lists,
 *  a missing required arg surfaces a per-row error, off un-enrols, Start/Stop
 *  preserves stored args (omits `args`), and a pack only shows the daemon ops
 *  its manifest ships.
 *
 *  Uses the same hand-rolled fake DOM as `d-182-cli-grant-dialog.test.ts`. */

import { describe, expect, it, vi } from 'vitest';

import {
  SUPERVISION_ARG_ATTR,
  SUPERVISION_ERROR_ATTR,
  SUPERVISION_MODE_BTN_ATTR,
  SUPERVISION_NOT_INSTALLED_ATTR,
  SUPERVISION_ROW_ATTR,
  SUPERVISION_SECTION_ATTR,
  SUPERVISION_STATE_ATTR,
  SUPERVISION_TOGGLE_ATTR,
  createSupervisionController,
  type SupervisionListCaller,
  type SupervisionSetCaller,
} from '../settings/supervision-controls.js';
import type {
  CliReachabilityUniverseResponse,
  PackListEntry,
  ServiceRestartPolicy,
  SupervisionDaemonRow,
  SupervisionListResponse,
  SupervisionSetRequest,
} from '@recued/contracts';

// ── fake DOM (trimmed copy of the cli-grant-dialog test harness) ────
interface FakeEl {
  tagName: string;
  className: string;
  textContent: string;
  value: string;
  attrs: Map<string, string>;
  children: FakeEl[];
  listeners: Map<string, Array<(ev?: unknown) => void>>;
  parent: FakeEl | null;
  setAttribute(k: string, v: string): void;
  removeAttribute(k: string): void;
  getAttribute(k: string): string | null;
  hasAttribute(k: string): boolean;
  appendChild(c: FakeEl): FakeEl;
  removeChild(c: FakeEl): FakeEl;
  addEventListener(type: string, fn: (ev?: unknown) => void): void;
  removeEventListener(type: string, fn: (ev?: unknown) => void): void;
  click(): void;
  input(v: string): void;
}

const makeFakeElement = (tag: string): FakeEl => {
  const el: FakeEl = {
    tagName: tag.toUpperCase(),
    className: '',
    textContent: '',
    value: '',
    attrs: new Map(),
    children: [],
    listeners: new Map(),
    parent: null,
    setAttribute(k, v) { el.attrs.set(k, v); },
    removeAttribute(k) { el.attrs.delete(k); },
    getAttribute(k) { return el.attrs.get(k) ?? null; },
    hasAttribute(k) { return el.attrs.has(k); },
    appendChild(c) { el.children.push(c); c.parent = el; return c; },
    removeChild(c) {
      const i = el.children.indexOf(c);
      if (i < 0) throw new Error('removeChild: not a child');
      el.children.splice(i, 1);
      c.parent = null;
      return c;
    },
    addEventListener(type, fn) {
      const list = el.listeners.get(type) ?? [];
      list.push(fn);
      el.listeners.set(type, list);
    },
    removeEventListener(type, fn) {
      const list = el.listeners.get(type);
      if (list === undefined) return;
      const i = list.indexOf(fn);
      if (i >= 0) list.splice(i, 1);
    },
    click() {
      if (el.attrs.has('disabled')) return;
      for (const fn of el.listeners.get('click') ?? []) fn({ target: el });
    },
    input(v) {
      el.value = v;
      for (const fn of el.listeners.get('input') ?? []) fn({ target: el });
    },
  };
  return el;
};

const makeFakeDocument = () => ({ createElement: makeFakeElement });

const collectByAttr = (root: FakeEl, attr: string, out: FakeEl[] = []): FakeEl[] => {
  if (root.attrs.has(attr)) out.push(root);
  for (const c of root.children) collectByAttr(c, attr, out);
  return out;
};

const tick = async (n = 8): Promise<void> => {
  for (let i = 0; i < n; i += 1) await Promise.resolve();
};

// ── fixtures ─────────────────────────────────────────────────────────
interface DaemonDef {
  ingredient_slug: string;
  op: string;
  required_args: string[];
  restart_policy: ServiceRestartPolicy;
  restart_on_server_start: boolean;
}

const CLOUDFLARED: DaemonDef = {
  ingredient_slug: 'cloudflared',
  op: 'tunnel.run_detached',
  required_args: ['tunnel_name'],
  restart_policy: 'on-crash',
  restart_on_server_start: true,
};

/** A minimal PackListEntry — the controller only reads `manifest.contents`.
 *  Uses the real daemon-pack shape: a `type:'composition'` content ref whose
 *  `composition.slug` is the catalog identity (the discovered `ingredient_slug`),
 *  NOT a plain `type:'ingredient'` ref. */
const packFor = (ingredientSlugs: string[]): PackListEntry =>
  ({
    manifest: {
      contents: ingredientSlugs.map((slug) => ({
        type: 'composition',
        composition: { slug, ingredients: [{ slug }] },
      })),
    },
  } as unknown as PackListEntry);

const opKey = (i: string, o: string): string => `${i}::${o}`;

interface Enrollment {
  mode: 'manual' | 'auto';
  enabled: boolean;
  args: Record<string, unknown>;
}

interface MountOpts {
  universe?: DaemonDef[];
  seedEnrolled?: Array<{ def: DaemonDef; mode: 'manual' | 'auto'; enabled: boolean; args?: Record<string, unknown> }>;
  /** ingredient_slug → binary-on-PATH. Presence wires the reachability universe
   *  caller (one tool entry per slug); absent ⇒ no caller (readiness unknown). */
  reachable?: Record<string, boolean>;
}

const mountController = (opts: MountOpts = {}) => {
  const doc = makeFakeDocument();
  const host = doc.createElement('div');
  const universe = opts.universe ?? [CLOUDFLARED];

  // The fake server: enrolled config keyed (ingredient_slug, op). `list`
  // discovers the universe + merges enrollment; `set` mutates it.
  const enrolled = new Map<string, Enrollment>();
  for (const s of opts.seedEnrolled ?? []) {
    enrolled.set(opKey(s.def.ingredient_slug, s.def.op), { mode: s.mode, enabled: s.enabled, args: s.args ?? { tunnel_name: 'prod' } });
  }
  const defFor = (i: string, o: string): DaemonDef | undefined =>
    universe.find((d) => d.ingredient_slug === i && d.op === o);

  const rowFor = (d: DaemonDef): SupervisionDaemonRow => {
    const e = enrolled.get(opKey(d.ingredient_slug, d.op));
    if (!e) {
      return {
        ingredient_slug: d.ingredient_slug,
        op: d.op,
        mode: 'off',
        enabled: false,
        restart_policy: d.restart_policy,
        restart_on_server_start: d.restart_on_server_start,
        state: 'unknown',
        readiness: 'legacy',
        readiness_detail: null,
        ready_at: null,
        health: 'unknown',
        health_detail: null,
        last_health_at: null,
        pid: null,
        started_at: null,
        consecutive_crashes: 0,
        last_crash_at: null,
        last_exit_code: null,
        required_args: d.required_args,
      };
    }
    return {
      ingredient_slug: d.ingredient_slug,
      op: d.op,
      mode: e.mode,
      enabled: e.enabled,
      restart_policy: e.mode === 'manual' ? 'never' : d.restart_policy,
      restart_on_server_start: e.mode === 'manual' ? false : d.restart_on_server_start,
      state: e.enabled ? 'running' : 'stopped',
      readiness: 'legacy',
      readiness_detail: null,
      ready_at: null,
      health: 'unknown',
      health_detail: null,
      last_health_at: null,
      pid: e.enabled ? 4242 : null,
      started_at: e.enabled ? 1 : null,
      consecutive_crashes: 0,
      last_crash_at: null,
      last_exit_code: null,
      required_args: d.required_args,
    };
  };

  const runList = vi.fn<SupervisionListCaller>(
    async (): Promise<SupervisionListResponse> => ({ daemons: universe.map(rowFor) }),
  );

  const runSet = vi.fn<SupervisionSetCaller>(async (req: SupervisionSetRequest) => {
    const k = opKey(req.ingredient_slug, req.op);
    if (req.mode === 'off') {
      enrolled.delete(k);
      return null;
    }
    const d = defFor(req.ingredient_slug, req.op);
    if (!d) throw new Error('not a daemon op');
    const prev = enrolled.get(k);
    const args = req.args ?? prev?.args ?? {};
    const enabled = req.enabled ?? true;
    // Mirror the server's missing-arg reject on an enrol that will run.
    if (enabled) {
      const missing = d.required_args.filter((a) => (args as Record<string, unknown>)[a] === undefined || (args as Record<string, unknown>)[a] === '');
      if (missing.length > 0) throw new Error(`missing required arg(s): ${missing.join(', ')}`);
    }
    enrolled.set(k, { mode: req.mode, enabled, args });
    return rowFor(d);
  });

  // Reachability universe — one tool entry per reachable-map slug (a cli
  // ingredient invokes exactly one tool, so catalog_slugs = [slug]). Wired only
  // when `opts.reachable` is provided; a vi.fn so a test can force a probe
  // failure via mockRejectedValueOnce.
  const runReachabilityUniverse = opts.reachable
    ? vi.fn(async (): Promise<CliReachabilityUniverseResponse> => ({
        tools: Object.entries(opts.reachable as Record<string, boolean>).map(([slug, reachable]) => ({
          tool: slug,
          catalog_slugs: [slug],
          operations: [],
          reachable,
        })),
      }))
    : undefined;

  // Fake D-121 subscriber — capture the `supervision` listener so a test can
  // fire a server broadcast.
  const listeners = new Map<string, () => void>();
  const controller = createSupervisionController({
    document: doc as unknown as Document,
    runList,
    runSet,
    ...(runReachabilityUniverse ? { runReachabilityUniverse } : {}),
    subscribe: (kind, cb) => { listeners.set(kind, cb as () => void); return () => listeners.delete(kind); },
    onChange: () => {
      host.children.length = 0;
      // single pack carrying every universe ingredient
      const pack = packFor([...new Set(universe.map((d) => d.ingredient_slug))]);
      const section = controller.renderForPack(pack);
      if (section) host.appendChild(section as unknown as FakeEl);
    },
  });

  return {
    doc, host, controller, runList, runSet, enrolled, runReachabilityUniverse,
    fireSupervision: () => listeners.get('supervision')?.(),
  };
};

const isDisabled = (el: FakeEl | undefined): boolean => !!el && el.hasAttribute('disabled');

const modeButton = (host: FakeEl, mode: string): FakeEl | undefined =>
  collectByAttr(host, SUPERVISION_MODE_BTN_ATTR).find((b) => b.getAttribute(SUPERVISION_MODE_BTN_ATTR) === mode);

describe('supervision-controls — pack-detail daemon controls', () => {
  it('discovers an un-enrolled daemon op and renders an off control + arg input', async () => {
    const h = mountController();
    await h.controller.refresh();
    const pack = packFor(['cloudflared']);
    const section = h.controller.renderForPack(pack) as unknown as FakeEl;
    expect(section).not.toBeNull();
    expect(section.attrs.has(SUPERVISION_SECTION_ATTR)).toBe(true);
    const rows = collectByAttr(section, SUPERVISION_ROW_ATTR);
    expect(rows).toHaveLength(1);
    // off is active (primary), no Start/Stop yet, an arg input is present
    expect(modeButton(section, 'off')!.className).toContain('rx-btn-primary');
    expect(collectByAttr(section, SUPERVISION_TOGGLE_ATTR)).toHaveLength(0);
    const argInputs = collectByAttr(section, SUPERVISION_ARG_ATTR);
    expect(argInputs).toHaveLength(1);
    expect(argInputs[0].getAttribute(SUPERVISION_ARG_ATTR)).toBe('tunnel_name');
  });

  it('renderForPack returns null for a pack that ships none of the daemon ingredients', async () => {
    const h = mountController();
    await h.controller.refresh();
    expect(h.controller.renderForPack(packFor(['ollama']))).toBeNull();
  });

  it('enrols as manual with the filled arg → one supervision.set then re-list shows Start/Stop + running', async () => {
    const h = mountController();
    await h.controller.refresh();
    // initial paint (refresh() is pure; the real panel paints after awaiting it)
    h.host.appendChild(h.controller.renderForPack(packFor(['cloudflared'])) as unknown as FakeEl);
    // fill the arg, then click Manual
    collectByAttr(h.host, SUPERVISION_ARG_ATTR)[0].input('my-tunnel');
    modeButton(h.host, 'manual')!.click();
    await tick();

    expect(h.runSet).toHaveBeenCalledTimes(1);
    expect(h.runSet.mock.calls[0][0]).toMatchObject({
      ingredient_slug: 'cloudflared',
      op: 'tunnel.run_detached',
      mode: 'manual',
      enabled: true,
      args: { tunnel_name: 'my-tunnel' },
    });
    expect(h.runList).toHaveBeenCalledTimes(2); // initial + post-set reconcile
    // reconciled render: manual active, a Stop toggle, running pill
    expect(modeButton(h.host, 'manual')!.className).toContain('rx-btn-primary');
    const toggle = collectByAttr(h.host, SUPERVISION_TOGGLE_ATTR)[0];
    expect(toggle.getAttribute(SUPERVISION_TOGGLE_ATTR)).toBe('stop');
    expect(collectByAttr(h.host, SUPERVISION_STATE_ATTR)[0].getAttribute(SUPERVISION_STATE_ATTR)).toBe('running');
  });

  it('rejects a manual enrol with a missing required arg → per-row error, no enrollment', async () => {
    const h = mountController();
    await h.controller.refresh();
    h.host.children.length = 0;
    h.host.appendChild(h.controller.renderForPack(packFor(['cloudflared'])) as unknown as FakeEl);
    // click Manual WITHOUT filling tunnel_name
    modeButton(h.host, 'manual')!.click();
    await tick();
    expect(h.runSet).toHaveBeenCalledTimes(1);
    expect(h.enrolled.size).toBe(0); // server rejected → still un-enrolled
    const err = collectByAttr(h.host, SUPERVISION_ERROR_ATTR)[0];
    expect(err).toBeDefined();
    expect(err.textContent).toContain('missing required arg');
  });

  it('Stop on an enrolled+running daemon omits args (preserves stored) and disables it', async () => {
    const h = mountController({ seedEnrolled: [{ def: CLOUDFLARED, mode: 'auto', enabled: true, args: { tunnel_name: 'prod' } }] });
    await h.controller.refresh();
    h.host.children.length = 0;
    h.host.appendChild(h.controller.renderForPack(packFor(['cloudflared'])) as unknown as FakeEl);
    collectByAttr(h.host, SUPERVISION_TOGGLE_ATTR)[0].click(); // Stop
    await tick();
    expect(h.runSet).toHaveBeenCalledTimes(1);
    const req = h.runSet.mock.calls[0][0];
    expect(req).toMatchObject({ ingredient_slug: 'cloudflared', op: 'tunnel.run_detached', mode: 'auto', enabled: false });
    expect('args' in req).toBe(false); // omitted → server preserves stored args
    expect(collectByAttr(h.host, SUPERVISION_STATE_ATTR)[0].getAttribute(SUPERVISION_STATE_ATTR)).toBe('stopped');
  });

  it('off un-enrols an enrolled daemon (one set{mode:off}, dropped from the server)', async () => {
    const h = mountController({ seedEnrolled: [{ def: CLOUDFLARED, mode: 'manual', enabled: true }] });
    await h.controller.refresh();
    h.host.children.length = 0;
    h.host.appendChild(h.controller.renderForPack(packFor(['cloudflared'])) as unknown as FakeEl);
    modeButton(h.host, 'off')!.click();
    await tick();
    expect(h.runSet).toHaveBeenCalledTimes(1);
    expect(h.runSet.mock.calls[0][0]).toMatchObject({ mode: 'off' });
    expect(h.enrolled.size).toBe(0);
    // back to the off control
    expect(modeButton(h.host, 'off')!.className).toContain('rx-btn-primary');
  });

  it('re-lists on a supervision broadcast (live state push, no UI action)', async () => {
    const h = mountController({ seedEnrolled: [{ def: CLOUDFLARED, mode: 'auto', enabled: true, args: { tunnel_name: 'prod' } }] });
    await h.controller.refresh();
    h.host.appendChild(h.controller.renderForPack(packFor(['cloudflared'])) as unknown as FakeEl);
    expect(collectByAttr(h.host, SUPERVISION_STATE_ATTR)[0].getAttribute(SUPERVISION_STATE_ATTR)).toBe('running');
    // The daemon changed state on the SERVER with no UI action (e.g. a crash /
    // external stop), then the `supervision` broadcast fires.
    h.enrolled.set(opKey(CLOUDFLARED.ingredient_slug, CLOUDFLARED.op), { mode: 'auto', enabled: false, args: { tunnel_name: 'prod' } });
    h.runList.mockClear();
    h.fireSupervision();
    await tick();
    expect(h.runList).toHaveBeenCalled(); // re-listed for authoritative state
    expect(collectByAttr(h.host, SUPERVISION_STATE_ATTR)[0].getAttribute(SUPERVISION_STATE_ATTR)).toBe('stopped'); // UI updated live
  });
});

describe('supervision-controls — install readiness gate', () => {
  it('shows a "not installed" badge + disables manual/auto when the binary is unreachable', async () => {
    const h = mountController({ reachable: { cloudflared: false } });
    await h.controller.refresh();
    const section = h.controller.renderForPack(packFor(['cloudflared'])) as unknown as FakeEl;
    expect(collectByAttr(section, SUPERVISION_NOT_INSTALLED_ATTR)).toHaveLength(1);
    expect(isDisabled(modeButton(section, 'manual'))).toBe(true);
    expect(isDisabled(modeButton(section, 'auto'))).toBe(true);
    expect(isDisabled(modeButton(section, 'off'))).toBe(false); // un-enrol always allowed
  });

  it("disables Start (not off) for an enrolled+stopped daemon whose binary is unreachable", async () => {
    const h = mountController({
      reachable: { cloudflared: false },
      seedEnrolled: [{ def: CLOUDFLARED, mode: 'manual', enabled: false }],
    });
    await h.controller.refresh();
    const section = h.controller.renderForPack(packFor(['cloudflared'])) as unknown as FakeEl;
    const toggle = collectByAttr(section, SUPERVISION_TOGGLE_ATTR)[0];
    expect(toggle.getAttribute(SUPERVISION_TOGGLE_ATTR)).toBe('start');
    expect(isDisabled(toggle)).toBe(true); // can't start an uninstalled binary
    expect(isDisabled(modeButton(section, 'off'))).toBe(false);
  });

  it('keeps Stop enabled for a running daemon whose binary went missing', async () => {
    const h = mountController({
      reachable: { cloudflared: false },
      seedEnrolled: [{ def: CLOUDFLARED, mode: 'auto', enabled: true, args: { tunnel_name: 'prod' } }],
    });
    await h.controller.refresh();
    const section = h.controller.renderForPack(packFor(['cloudflared'])) as unknown as FakeEl;
    const toggle = collectByAttr(section, SUPERVISION_TOGGLE_ATTR)[0];
    expect(toggle.getAttribute(SUPERVISION_TOGGLE_ATTR)).toBe('stop');
    expect(isDisabled(toggle)).toBe(false); // a daemon can always be stopped
  });

  it('no badge + controls enabled when the binary IS reachable', async () => {
    const h = mountController({ reachable: { cloudflared: true } });
    await h.controller.refresh();
    const section = h.controller.renderForPack(packFor(['cloudflared'])) as unknown as FakeEl;
    expect(collectByAttr(section, SUPERVISION_NOT_INSTALLED_ATTR)).toHaveLength(0);
    expect(isDisabled(modeButton(section, 'manual'))).toBe(false);
    expect(isDisabled(modeButton(section, 'auto'))).toBe(false);
  });

  it('no gating when readiness is unknown (no universe caller wired)', async () => {
    const h = mountController(); // no `reachable` ⇒ no universe caller
    await h.controller.refresh();
    const section = h.controller.renderForPack(packFor(['cloudflared'])) as unknown as FakeEl;
    expect(collectByAttr(section, SUPERVISION_NOT_INSTALLED_ATTR)).toHaveLength(0);
    expect(isDisabled(modeButton(section, 'manual'))).toBe(false);
  });

  it('a universe-probe failure CLEARS stale gating (readiness back to unknown → re-enabled)', async () => {
    const h = mountController({ reachable: { cloudflared: false } });
    await h.controller.refresh();
    let section = h.controller.renderForPack(packFor(['cloudflared'])) as unknown as FakeEl;
    expect(isDisabled(modeButton(section, 'manual'))).toBe(true); // gated on the reachable:false load
    // The next probe fails → readiness unknown; the stale `false` must NOT persist.
    h.runReachabilityUniverse!.mockRejectedValueOnce(new Error('probe down'));
    await h.controller.refresh();
    section = h.controller.renderForPack(packFor(['cloudflared'])) as unknown as FakeEl;
    expect(collectByAttr(section, SUPERVISION_NOT_INSTALLED_ATTR)).toHaveLength(0);
    expect(isDisabled(modeButton(section, 'manual'))).toBe(false);
  });
});
