/** D-321 slice 3 — the pack page's Programs block (`pack-programs-controls.ts`)
 *  and the pack list's program badge (`programBadge`).
 *
 *  The callers are a fake server that answers like the real one: a Refuse /
 *  Warn write changes what the next `packs.tool_status` returns, so what the
 *  block shows after a click is what the server said, not what the block
 *  assumed. Self-contained fake-DOM harness, cribbed from the D-320 suite. */

import { describe, expect, it } from 'vitest';

import type { CliVersionOutside, PackListEntry, PackToolStatus, PacksToolStatusRequest } from '@recued/contracts';

import {
  PACK_PROGRAMS_ACTION_ATTR,
  PACK_PROGRAMS_ATTR,
  PACK_PROGRAMS_ERROR_ATTR,
  PACK_PROGRAMS_INSTALL_ATTR,
  PACK_PROGRAMS_OUTSIDE_ATTR,
  PACK_PROGRAMS_ROW_ATTR,
  PACK_PROGRAMS_STATE_ATTR,
  createPackProgramsController,
  packProgramsFocusOf,
  packProgramsFocusTargets,
  programDisplayName,
  type PackProgramsCallers,
} from '../settings/pack-programs-controls.js';
import { packBadges, programBadge } from '../discover/pack-discovery.js';

interface FakeElement {
  tagName: string;
  textContent: string;
  disabled: boolean;
  className: string;
  type: string;
  title: string;
  children: FakeElement[];
  parent: FakeElement | null;
  attrs: Map<string, string>;
  listeners: Map<string, Array<(ev: unknown) => void>>;
  setAttribute(k: string, v: string): void;
  getAttribute(k: string): string | null;
  hasAttribute(k: string): boolean;
  appendChild(el: FakeElement): FakeElement;
  addEventListener(name: string, fn: (ev: unknown) => void): void;
  click(): void;
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
    type: '',
    title: '',
    children,
    parent: null,
    attrs,
    listeners,
    setAttribute: (k, v) => {
      attrs.set(k, v);
      if (k === 'disabled') el.disabled = true;
    },
    getAttribute: (k) => attrs.get(k) ?? null,
    hasAttribute: (k) => attrs.has(k),
    appendChild: (next) => {
      children.push(next);
      next.parent = el;
      return next;
    },
    addEventListener: (name, fn) => {
      const arr = listeners.get(name) ?? [];
      arr.push(fn);
      listeners.set(name, arr);
    },
    click: () => {
      if (el.disabled || el.attrs.has('disabled')) return;
      for (const fn of [...(listeners.get('click') ?? [])]) fn({ target: el });
    },
  };
  return el;
};

const doc = { createElement: (tag: string) => makeFakeElement(tag) } as unknown as Document;

const all = (root: FakeElement, attr: string): FakeElement[] => {
  const out: FakeElement[] = [];
  const walk = (n: FakeElement): void => {
    if (n.hasAttribute(attr)) out.push(n);
    for (const c of n.children) walk(c);
  };
  walk(root);
  return out;
};
const one = (root: FakeElement, attr: string, value?: string): FakeElement | null =>
  all(root, attr).find((e) => value === undefined || e.getAttribute(attr) === value) ?? null;
const text = (root: FakeElement): string =>
  (root.textContent ?? '') + root.children.map(text).join('');
const flush = async (n = 10): Promise<void> => {
  for (let i = 0; i < n; i += 1) await Promise.resolve();
};

const PACK = 'opencode-pack';
const pack = { slug: PACK } as unknown as PackListEntry;
const RANGE = { from: '1.18.35', before: '2.0.0' };

const opencode = (over: Partial<PackToolStatus> = {}): PackToolStatus => ({
  catalog: 'recued-core/opencode',
  binary: 'opencode',
  state: 'untested',
  version: '2.0.1',
  checked_at: 1,
  tested: RANGE,
  outside: 'refuse',
  pack_outside: 'refuse',
  install: ['npm install -g opencode-ai@1'],
  docs: ['https://opencode.ai/docs'],
  ...over,
});

/** A fake server: one pack's tools, with the owner's choice applied the way
 *  the real read applies it. */
const fakeServer = (tools: PackToolStatus[]) => {
  let owner: CliVersionOutside | undefined;
  const calls: Array<{ method: string; args: unknown }> = [];
  const view = (): PackToolStatus[] => tools.map((tool) => (tool.tested === undefined ? tool : {
    ...tool,
    outside: owner ?? tool.pack_outside,
    ...(owner !== undefined ? { owner_outside: owner } : {}),
  }));
  const callers: Required<PackProgramsCallers> = {
    status: async (args: PacksToolStatusRequest) => {
      calls.push({ method: 'status', args });
      return { system: 'macos', packs: tools.length > 0 ? [{ slug: PACK, tools: view() }] : [] };
    },
    setOutside: async (args) => {
      calls.push({ method: 'setOutside', args });
      owner = args.outside;
      return {
        ingredient_id: args.ingredient_id, outside: args.outside, pack_outside: 'refuse',
        tested: RANGE, version_hash: 'a'.repeat(64), written_at: 1,
      };
    },
    clearOutside: async (args) => {
      calls.push({ method: 'clearOutside', args });
      const deleted = owner !== undefined;
      owner = undefined;
      return { deleted };
    },
  };
  return { callers, calls };
};

const mount = (callers: PackProgramsCallers | undefined, copied: string[] = []) => {
  let renders = 0;
  const controller = createPackProgramsController({
    document: doc,
    ...(callers !== undefined ? { callers } : {}),
    onChange: () => { renders += 1; },
    copyText: async (t) => { copied.push(t); },
  });
  const render = (): FakeElement | null => controller.renderForPack(pack) as unknown as FakeElement | null;
  return { controller, render, renders: () => renders };
};

describe('D-321 — the Programs block', () => {
  it('loads on first sight, then shows each program, the range and what a run does', async () => {
    const server = fakeServer([opencode()]);
    const { controller, render } = mount(server.callers);
    const loading = render();
    expect(text(loading!)).toContain('Checking the programs…');
    expect(server.calls).toEqual([{ method: 'status', args: { pack_slug: PACK } }]);
    await controller.whenSettled();
    const section = render()!;
    expect(section.getAttribute(PACK_PROGRAMS_ATTR)).toBe(PACK);
    const row = one(section, PACK_PROGRAMS_ROW_ATTR, 'recued-core/opencode')!;
    expect(row.getAttribute(PACK_PROGRAMS_STATE_ATTR)).toBe('untested');
    expect(text(row)).toContain('opencode');
    expect(text(row)).toContain('2.0.1 · not tested');
    expect(text(row)).toContain('This pack was tested with 1.x versions from 1.18.35.');
    expect(text(row)).toContain('Its actions are refused until you install a tested version or choose Warn.');
  });

  it('a pack that runs no program shows no block', async () => {
    const { controller, render } = mount(fakeServer([]).callers);
    render();
    await controller.whenSettled();
    expect(render()).toBeNull();
  });

  it('each state reads in words', async () => {
    const server = fakeServer([
      opencode({ catalog: 'a', binary: 'opencode', state: 'ready', version: '1.18.35' }),
      opencode({ catalog: 'b', binary: '/usr/local/bin/ffmpeg', state: 'broken', version: undefined, detail: 'dyld: Library not loaded: /opt/x.dylib' }),
      { catalog: 'c', binary: 'magick', state: 'missing', install: ['brew install imagemagick'], docs: [] },
      { catalog: 'd', binary: 'whisper', state: 'ready', install: [], docs: [] },
      opencode({ catalog: 'e', binary: 'codex', state: 'unreadable', version: undefined, outside: 'warn', pack_outside: 'warn', detail: "'codex --version' exited with code 1" }),
    ]);
    const { controller, render } = mount(server.callers);
    render();
    await controller.whenSettled();
    const section = render()!;
    const row = (catalog: string) => text(one(section, PACK_PROGRAMS_ROW_ATTR, catalog)!);
    expect(row('a')).toContain('1.18.35 · tested');
    expect(row('b')).toContain('ffmpeg');
    expect(row('b')).toContain('Installed, but does not start');
    expect(row('b')).toContain('dyld: Library not loaded: /opt/x.dylib');
    expect(row('b')).toContain('Its actions are refused until it starts.');
    expect(row('c')).toContain('Not installed');
    expect(row('c')).toContain('Its actions fail until you install it.');
    expect(row('d')).toContain('Installed');
    expect(row('e')).toContain('Version unknown');
    expect(row('e')).toContain('Its actions still run.');
    // A ready program shows no install commands; a missing one does.
    expect(one(one(section, PACK_PROGRAMS_ROW_ATTR, 'a')!, PACK_PROGRAMS_INSTALL_ATTR)).toBeNull();
    expect(one(one(section, PACK_PROGRAMS_ROW_ATTR, 'c')!, PACK_PROGRAMS_INSTALL_ATTR)?.textContent)
      .toBe('brew install imagemagick');
  });

  it("Warn is the owner's choice: written, then read back from the server", async () => {
    const server = fakeServer([opencode()]);
    const { controller, render } = mount(server.callers);
    render();
    await controller.whenSettled();
    let section = render()!;
    expect(one(section, PACK_PROGRAMS_OUTSIDE_ATTR, 'refuse')!.getAttribute('aria-pressed')).toBe('true');
    expect(one(section, PACK_PROGRAMS_OUTSIDE_ATTR, 'warn')!.getAttribute('aria-pressed')).toBe('false');
    expect(text(section)).toContain("The pack's default is Refuse.");
    expect(one(section, PACK_PROGRAMS_ACTION_ATTR, 'use-default')).toBeNull();

    one(section, PACK_PROGRAMS_OUTSIDE_ATTR, 'warn')!.click();
    await controller.whenSettled();
    await flush();
    await controller.whenSettled();
    expect(server.calls.slice(1)).toEqual([
      { method: 'setOutside', args: { ingredient_id: 'recued-core/opencode', outside: 'warn' } },
      { method: 'status', args: { pack_slug: PACK } },
    ]);
    section = render()!;
    expect(one(section, PACK_PROGRAMS_OUTSIDE_ATTR, 'warn')!.getAttribute('aria-pressed')).toBe('true');
    expect(text(section)).toContain('Its actions still run.');

    one(section, PACK_PROGRAMS_ACTION_ATTR, 'use-default')!.click();
    await controller.whenSettled();
    await flush();
    await controller.whenSettled();
    expect(server.calls.at(-2)).toEqual({ method: 'clearOutside', args: { ingredient_id: 'recued-core/opencode' } });
    section = render()!;
    expect(one(section, PACK_PROGRAMS_OUTSIDE_ATTR, 'refuse')!.getAttribute('aria-pressed')).toBe('true');
  });

  it('a choice made for an older range says so', async () => {
    const server = fakeServer([opencode({ owner_outside: 'warn', stale_owner_choice: true })]);
    const { controller, render } = mount(server.callers);
    render();
    await controller.whenSettled();
    const section = render()!;
    expect(text(section)).toContain(
      "You chose Warn for this pack's earlier versions. The pack's default applies until you choose again.",
    );
    // The option shown is the pack's default, and pressing it does nothing: this is
    // how the owner clears a choice made for other terms (D-321 audit).
    expect(one(section, PACK_PROGRAMS_ACTION_ATTR, 'use-default')).not.toBeNull();
  });

  it('without the write calls, the setting is shown and cannot be changed', async () => {
    const server = fakeServer([opencode()]);
    const { controller, render } = mount({ status: server.callers.status });
    render();
    await controller.whenSettled();
    const section = render()!;
    for (const outside of ['refuse', 'warn']) {
      expect(one(section, PACK_PROGRAMS_OUTSIDE_ATTR, outside)!.hasAttribute('disabled')).toBe(true);
    }
  });

  it('"Check again" asks the server to probe again', async () => {
    const server = fakeServer([opencode()]);
    const { controller, render } = mount(server.callers);
    render();
    await controller.whenSettled();
    one(render()!, PACK_PROGRAMS_ACTION_ATTR, 'check-again')!.click();
    const busy = one(render()!, PACK_PROGRAMS_ACTION_ATTR, 'check-again')!;
    expect(busy.hasAttribute('disabled')).toBe(true);
    expect(busy.textContent).toBe('Checking…');
    await controller.whenSettled();
    expect(server.calls.at(-1)).toEqual({ method: 'status', args: { pack_slug: PACK, recheck: true } });
    expect(one(render()!, PACK_PROGRAMS_ACTION_ATTR, 'check-again')!.textContent).toBe('Check again');
  });

  it('copies an install command, and never runs one', async () => {
    const copied: string[] = [];
    const server = fakeServer([opencode({ state: 'missing', version: undefined })]);
    const { controller, render } = mount(server.callers, copied);
    render();
    await controller.whenSettled();
    const copy = one(render()!, PACK_PROGRAMS_ACTION_ATTR, 'copy')!;
    expect(copy.textContent).toBe('Copy');
    copy.click();
    await flush();
    expect(copied).toEqual(['npm install -g opencode-ai@1']);
    expect(one(render()!, PACK_PROGRAMS_ACTION_ATTR, 'copy')!.textContent).toBe('Copied');
    expect(server.calls.every((c) => c.method === 'status')).toBe(true);
    const docs = all(render()!, 'href')[0]!;
    expect(docs.getAttribute('href')).toBe('https://opencode.ai/docs');
    expect(docs.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('a failed write says so and keeps the block', async () => {
    const server = fakeServer([opencode()]);
    const failing: PackProgramsCallers = {
      ...server.callers,
      setOutside: async () => { throw new Error('refused by the server'); },
    };
    const { controller, render } = mount(failing);
    render();
    await controller.whenSettled();
    one(render()!, PACK_PROGRAMS_OUTSIDE_ATTR, 'warn')!.click();
    await controller.whenSettled();
    const section = render()!;
    expect(text(one(section, PACK_PROGRAMS_ERROR_ATTR)!)).toContain('That did not work');
    expect(one(section, PACK_PROGRAMS_ROW_ATTR, 'recued-core/opencode')).not.toBeNull();
  });

  it('a failed load offers to try again; a server without the call shows nothing', async () => {
    let fail = true;
    const status: PackProgramsCallers['status'] = async () => {
      if (fail) throw new Error('server unreachable');
      return { system: 'linux', packs: [{ slug: PACK, tools: [opencode()] }] };
    };
    const { controller, render } = mount({ status });
    render();
    await controller.whenSettled();
    const failed = render()!;
    expect(one(failed, PACK_PROGRAMS_ERROR_ATTR)).not.toBeNull();
    fail = false;
    one(failed, PACK_PROGRAMS_ACTION_ATTR, 'retry')!.click();
    await controller.whenSettled();
    expect(one(render()!, PACK_PROGRAMS_ROW_ATTR, 'recued-core/opencode')).not.toBeNull();

    const old = mount({ status: async () => { throw Object.assign(new Error('no such method'), { code: 'unknown_method' }); } });
    old.render();
    await old.controller.whenSettled();
    expect(old.render()).toBeNull();
  });

  it('no callers: no block', () => {
    expect(mount(undefined).render()).toBeNull();
  });

  it('names a program by the last part of its path', () => {
    expect(programDisplayName('opencode')).toBe('opencode');
    expect(programDisplayName('/opt/homebrew/bin/ffmpeg')).toBe('ffmpeg');
    expect(programDisplayName('C:\\Program Files\\Windows Defender\\MpCmdRun.exe')).toBe('MpCmdRun.exe');
  });
});

describe('D-321 — the pack list badge', () => {
  const tool = (state: PackToolStatus['state'], over: Partial<PackToolStatus> = {}): PackToolStatus =>
    opencode({ state, ...over });

  it('one badge for the most urgent program', () => {
    expect(programBadge([tool('ready', { version: '1.18.35' })])).toBeNull();
    expect(programBadge([])).toBeNull();
    expect(programBadge(undefined)).toBeNull();
    expect(programBadge([tool('missing')])).toMatchObject({ label: 'Needs opencode', tone: 'danger' });
    expect(programBadge([tool('broken', { binary: '/usr/bin/ffmpeg' })])).toMatchObject({ label: 'ffmpeg does not start', tone: 'danger' });
    expect(programBadge([tool('untested')])).toMatchObject({ label: 'opencode 2.0.1 not tested', tone: 'danger' });
    expect(programBadge([tool('untested', { outside: 'warn' })])).toMatchObject({ label: 'opencode 2.0.1 not tested', tone: 'muted' });
    expect(programBadge([tool('unreadable')])).toMatchObject({ label: 'opencode version unknown', tone: 'danger' });
    expect(programBadge([tool('untested'), tool('broken', { binary: 'ffmpeg' }), tool('missing', { binary: 'magick' })]))
      .toMatchObject({ label: 'ffmpeg does not start' });
    expect(programBadge([tool('untested')])!.title).toContain('This pack was tested with 1.x versions from 1.18.35.');
  });

  it('a program that stops the pack\'s actions comes first, whatever its state (D-321 audit)', () => {
    // An untested version under Warn runs; a version that cannot be read under
    // Refuse does not, so it is the one the badge must name.
    expect(programBadge([
      tool('untested', { binary: 'pi', outside: 'warn' }),
      tool('unreadable', { binary: 'codex', outside: 'refuse' }),
    ])).toMatchObject({ label: 'codex version unknown', tone: 'danger' });
  });

  it('sits after "Needs update" and before the provenance badges', () => {
    const row = { slug: PACK, publisher_certified: true } as unknown as Parameters<typeof packBadges>[0];
    const badges = packBadges(row, new Set([PACK]), new Set([PACK]), new Map([[PACK, [tool('missing')]]]));
    expect(badges.map((b) => b.label)).toEqual(['Needs update', 'Needs opencode', 'Included', '✓ Certified']);
    expect(packBadges(row, undefined, undefined, new Map()).map((b) => b.label)).toEqual(['✓ Certified']);
  });
});

describe('D-321 audit — the Programs block', () => {
  const allWith = (root: FakeElement, attr: string, value: string): FakeElement[] =>
    all(root, attr).filter((e) => e.getAttribute(attr) === value);

  it('a copy that fails says why, and each Copy names its command to a screen reader', async () => {
    const server = fakeServer([opencode({
      state: 'missing',
      version: undefined,
      install: ['npm install -g opencode-ai@1', 'brew install anomalyco/tap/opencode'],
    })]);
    const controller = createPackProgramsController({
      document: doc,
      callers: server.callers,
      onChange: () => undefined,
      copyText: async () => { throw new Error('This browser does not allow copying here.'); },
    });
    const render = (): FakeElement => controller.renderForPack(pack) as unknown as FakeElement;
    render();
    await controller.whenSettled();
    const copies = allWith(render(), PACK_PROGRAMS_ACTION_ATTR, 'copy');
    expect(copies.map((c) => c.getAttribute('aria-label'))).toEqual([
      'Copy: npm install -g opencode-ai@1',
      'Copy: brew install anomalyco/tap/opencode',
    ]);
    copies[0]!.click();
    await flush();
    expect(text(render())).toContain('Could not copy: This browser does not allow copying here.');
  });

  it('it is red only when the program stops the pack\'s actions: not under Warn', async () => {
    const toneOf = async (tool: PackToolStatus): Promise<string | null> => {
      const { controller, render } = mount(fakeServer([tool]).callers);
      render();
      await controller.whenSettled();
      return one(render()!, PACK_PROGRAMS_ROW_ATTR)!.getAttribute('data-tone');
    };
    expect(await toneOf(opencode())).toBe('danger');
    expect(await toneOf(opencode({ state: 'missing', version: undefined }))).toBe('danger');
    expect(await toneOf(opencode({ outside: 'warn', pack_outside: 'warn' }))).toBe('muted');
    expect(await toneOf(opencode({ state: 'ready', version: '1.18.35' }))).toBe('muted');
  });

  it('an older answer that lands after a newer one is dropped', async () => {
    const answers: Array<(tools: PackToolStatus[]) => void> = [];
    const callers: PackProgramsCallers = {
      status: () => new Promise((resolve) => {
        answers.push((tools) => resolve({ system: 'macos', packs: [{ slug: PACK, tools }] }));
      }),
    };
    const { controller, render } = mount(callers);
    render();
    // The pack list loads again (a `packs.list` refresh): a second read starts.
    controller.refresh();
    render();
    answers[1]!([opencode({ state: 'ready', version: '1.18.35' })]);
    await flush();
    answers[0]!([opencode()]);
    await flush();
    expect(one(render()!, PACK_PROGRAMS_ROW_ATTR)!.getAttribute(PACK_PROGRAMS_STATE_ATTR)).toBe('ready');
  });

  it('after a write, the block stays on screen while it reads again', async () => {
    const server = fakeServer([opencode()]);
    let reads = 0;
    let release: (() => void) | undefined;
    const callers: PackProgramsCallers = {
      ...server.callers,
      status: async (args) => {
        reads += 1;
        if (reads === 2) await new Promise<void>((done) => { release = done; });
        return server.callers.status(args);
      },
    };
    const { controller, render } = mount(callers);
    render();
    await controller.whenSettled();
    one(render()!, PACK_PROGRAMS_OUTSIDE_ATTR, 'warn')!.click();
    await flush();
    expect(reads).toBe(2);
    expect(text(render()!)).not.toContain('Checking the programs');
    expect(one(render()!, PACK_PROGRAMS_ROW_ATTR)).not.toBeNull();
    release!();
    await controller.whenSettled();
  });

  it('marks each control, so the page can put focus back on it after it re-renders', async () => {
    const server = fakeServer([opencode()]);
    const { controller, render } = mount(server.callers);
    render();
    await controller.whenSettled();
    const warn = one(render()!, PACK_PROGRAMS_OUTSIDE_ATTR, 'warn')!;
    const focus = packProgramsFocusOf(warn as unknown as HTMLElement)!;
    expect(focus).toEqual({
      attr: PACK_PROGRAMS_OUTSIDE_ATTR, value: 'warn', pack: PACK, catalog: 'recued-core/opencode', command: null,
    });
    const find = (root: FakeElement, matches: (e: HTMLElement) => boolean): FakeElement | undefined => {
      const walk = (n: FakeElement): FakeElement | undefined =>
        (matches(n as unknown as HTMLElement) ? n : undefined) ?? n.children.map(walk).find((x) => x !== undefined);
      return walk(root);
    };
    const [same, chosen, again] = packProgramsFocusTargets(focus);
    const fresh = render()!;
    expect(find(fresh, same!)?.getAttribute(PACK_PROGRAMS_OUTSIDE_ATTR)).toBe('warn');
    // A control that is gone ("Use the pack's default", once used) falls back to the
    // option now chosen for the same program, then to "Check again".
    const gone = packProgramsFocusTargets({ ...focus, attr: PACK_PROGRAMS_ACTION_ATTR, value: 'use-default' });
    expect(find(fresh, gone[0]!)).toBeUndefined();
    expect(find(fresh, chosen!)?.getAttribute(PACK_PROGRAMS_OUTSIDE_ATTR)).toBe('refuse');
    expect(find(fresh, again!)?.getAttribute(PACK_PROGRAMS_ACTION_ATTR)).toBe('check-again');
    expect(packProgramsFocusOf(null)).toBeNull();
  });
});

