/** D-182 §7.1 — the install-time cli grant dialog.
 *
 *  Verifies the post-install modal that grants the owner's cli reachability for
 *  the local-binary tools a pack adds: the before/after universe diff
 *  (`snapshot` + `openForNewTools`) keyed on (slug × op), the "only NEW ops, read
 *  pre-selected, write opt-in" selection model, the owner-principal-only fan-out
 *  of `cli.reachability.set` (one write per selected op), the fail-closed Skip +
 *  default-confirm paths, the partial-failure error chip, and the stale-confirm
 *  reopen guard (Codex F1).
 *
 *  Uses the same hand-rolled fake DOM as `d-182-local-tools-panel.test.ts`. */

import { describe, expect, it, vi } from 'vitest';

import {
  CLI_GRANT_DIALOG_CONFIRM_BTN_ATTR,
  CLI_GRANT_DIALOG_ERROR_ATTR,
  CLI_GRANT_DIALOG_OP_ATTR,
  CLI_GRANT_DIALOG_SKIP_BTN_ATTR,
  CLI_GRANT_DIALOG_STYLES,
  CLI_GRANT_DIALOG_TOOL_ATTR,
  mountCliGrantDialog,
  type CliGrantSetCaller,
  type CliGrantUniverseCaller,
} from '../settings/cli-grant-dialog.js';
import type {
  CliReachabilitySetRequest,
  CliToolGridEntry,
} from '@recued/contracts';

// ── fake DOM (trimmed copy of the local-tools-panel test harness) ────
interface FakeEl {
  tagName: string;
  className: string;
  textContent: string;
  attrs: Map<string, string>;
  children: FakeEl[];
  listeners: Map<string, Array<(ev?: unknown) => void>>;
  parent: FakeEl | null;
  checked: boolean;
  readonly firstChild: FakeEl | null;
  setAttribute(k: string, v: string): void;
  removeAttribute(k: string): void;
  getAttribute(k: string): string | null;
  hasAttribute(k: string): boolean;
  appendChild(c: FakeEl): FakeEl;
  removeChild(c: FakeEl): FakeEl;
  addEventListener(type: string, fn: (ev?: unknown) => void): void;
  removeEventListener(type: string, fn: (ev?: unknown) => void): void;
  click(): void;
  remove(): void;
}

const makeFakeElement = (tag: string): FakeEl => {
  const el: FakeEl = {
    tagName: tag.toUpperCase(),
    className: '',
    textContent: '',
    attrs: new Map(),
    children: [],
    listeners: new Map(),
    parent: null,
    checked: false,
    get firstChild() {
      return el.children[0] ?? null;
    },
    setAttribute(k, v) {
      el.attrs.set(k, v);
    },
    removeAttribute(k) {
      el.attrs.delete(k);
    },
    getAttribute(k) {
      return el.attrs.get(k) ?? null;
    },
    hasAttribute(k) {
      return el.attrs.has(k);
    },
    appendChild(c) {
      el.children.push(c);
      c.parent = el;
      return c;
    },
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
      // A real checkbox click toggles `.checked` then fires `change` — the
      // dialog's op toggles listen on `change`, so the fake must too.
      if (el.getAttribute('type') === 'checkbox') {
        el.checked = !el.checked;
        for (const fn of el.listeners.get('change') ?? []) fn({ target: el });
      }
    },
    remove() {
      if (el.parent) el.parent.removeChild(el);
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

const deferred = <T>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

// ── fixtures ─────────────────────────────────────────────────────────
const OWNER = 'user_self';

const WHISPER: CliToolGridEntry = {
  tool: 'whisper',
  catalog_slugs: ['whisper'],
  operations: [{ operation_id: 'transcribe', catalog_slug: 'whisper', risk_tier: 'write' }],
};
const MAGICK: CliToolGridEntry = {
  tool: 'magick',
  catalog_slugs: ['magick-a', 'magick-b'],
  operations: [
    { operation_id: 'identify', catalog_slug: 'magick-a', risk_tier: 'read' },
    { operation_id: 'convert', catalog_slug: 'magick-a', risk_tier: 'write' },
    { operation_id: 'mogrify', catalog_slug: 'magick-b', risk_tier: 'write' },
  ],
};
/** magick with only its read op — the "tool gains an op" before-state. */
const MAGICK_READ_ONLY: CliToolGridEntry = {
  tool: 'magick',
  catalog_slugs: ['magick-a'],
  operations: [{ operation_id: 'identify', catalog_slug: 'magick-a', risk_tier: 'read' }],
};

interface MountOpts {
  initialUniverse?: CliToolGridEntry[];
  universeThrows?: boolean;
  runSet?: CliGrantSetCaller;
}

const mountFor = (opts: MountOpts = {}) => {
  const doc = makeFakeDocument();
  const host = doc.createElement('div');
  let currentUniverse: CliToolGridEntry[] = opts.initialUniverse ?? [];

  const runUniverse = vi.fn<CliGrantUniverseCaller>(async () => {
    if (opts.universeThrows) throw new Error('unknown_method');
    return { tools: currentUniverse };
  });

  const recorded: CliReachabilitySetRequest[] = [];
  const defaultSet: CliGrantSetCaller = async (args) => {
    recorded.push(args);
    return {
      principal: args.principal ?? OWNER,
      ingredient_id: args.ingredient_id,
      operation_id: args.operation_id,
      allowed: args.allowed,
      set_at: 1,
    };
  };
  const runSet = vi.fn<CliGrantSetCaller>(opts.runSet ?? defaultSet);

  const mount = mountCliGrantDialog({
    host: host as unknown as HTMLElement,
    document: doc as unknown as Document,
    runUniverse,
    runSet,
  });

  const setUniverse = (u: CliToolGridEntry[]): void => {
    currentUniverse = u;
  };

  return { doc, host, mount, runUniverse, runSet, recorded, setUniverse };
};

const opBox = (host: FakeEl, slug: string, op: string): FakeEl | undefined =>
  collectByAttr(host, CLI_GRANT_DIALOG_OP_ATTR).find(
    (b) => b.getAttribute('data-slug') === slug && b.getAttribute('data-operation') === op,
  );

// ════════════════════════════════════════════════════════════════════

describe('D-182 §7.1 cli grant dialog — snapshot', () => {
  it('snapshots the (slug × op) universe keys', async () => {
    const { mount, setUniverse } = mountFor();
    setUniverse([WHISPER, MAGICK]);
    const snap = await mount.snapshot();
    expect(snap).not.toBeNull();
    // The diff later treats present keys as "not new"; opening with this exact
    // snapshot against the same universe yields nothing new.
    setUniverse([WHISPER, MAGICK]);
    await mount.openForNewTools(snap!);
    expect(mount.isOpen()).toBe(false);
  });

  it('returns null when the pre-install universe read fails (caller skips the dialog)', async () => {
    const { mount } = mountFor({ universeThrows: true });
    expect(await mount.snapshot()).toBeNull();
  });
});

describe('D-182 §7.1 cli grant dialog — before/after diff', () => {
  it('opens for a brand-new tool, offering its ops', async () => {
    const { mount, host, setUniverse } = mountFor();
    setUniverse([]);
    const before = await mount.snapshot();
    setUniverse([WHISPER]);
    void mount.openForNewTools(before!);
    await tick();
    expect(mount.isOpen()).toBe(true);
    expect(mount.getDialogTools()).toEqual([{ tool: 'whisper', new_ops: ['transcribe'] }]);
    expect(opBox(host, 'whisper', 'transcribe')).toBeDefined();
  });

  it('does not open when nothing new appeared (non-cli or no-op install)', async () => {
    const { mount, setUniverse } = mountFor();
    setUniverse([WHISPER]);
    const before = await mount.snapshot();
    setUniverse([WHISPER]); // identical after-install universe
    await mount.openForNewTools(before!);
    expect(mount.isOpen()).toBe(false);
  });

  it('offers ONLY the newly-added ops when a tool gains them', async () => {
    const { mount, setUniverse } = mountFor();
    setUniverse([MAGICK_READ_ONLY]);
    const before = await mount.snapshot();
    setUniverse([MAGICK]); // magick gained two write ops (identify was already present)
    void mount.openForNewTools(before!);
    await tick();
    expect(mount.getDialogTools()).toEqual([{ tool: 'magick', new_ops: ['convert', 'mogrify'] }]);
  });

  it('does not open when the post-install universe read fails', async () => {
    const { mount, setUniverse } = mountFor();
    setUniverse([]);
    const before = await mount.snapshot();
    // Now make the post-install read throw.
    const errMount = mountFor({ universeThrows: true });
    await errMount.mount.openForNewTools(before ?? new Set());
    expect(errMount.mount.isOpen()).toBe(false);
  });
});

describe('D-182 §7.1 cli grant dialog — selection model', () => {
  it('pre-selects read ops, leaves write off', async () => {
    const { mount, setUniverse } = mountFor();
    setUniverse([]);
    const before = await mount.snapshot();
    setUniverse([MAGICK]);
    void mount.openForNewTools(before!);
    await tick();
    expect(mount.isOpSelected('magick-a', 'identify')).toBe(true); // read
    expect(mount.isOpSelected('magick-a', 'convert')).toBe(false); // write
    expect(mount.isOpSelected('magick-b', 'mogrify')).toBe(false); // write
  });

  it('distinguishes ops whose (slug, op) pairs concatenate-collide (separator regression — Codex P2)', async () => {
    // slug `ab` / op `c` and slug `a` / op `bc` both concatenate to "abc"; a
    // missing separator would alias them into one selection key. They must stay
    // independent ops with independent selection + grant.
    const COLLIDE: CliToolGridEntry = {
      tool: 'x',
      catalog_slugs: ['ab', 'a'],
      operations: [
        { operation_id: 'c', catalog_slug: 'ab', risk_tier: 'write' },
        { operation_id: 'bc', catalog_slug: 'a', risk_tier: 'write' },
      ],
    };
    const { mount, recorded, setUniverse } = mountFor();
    setUniverse([]);
    const before = await mount.snapshot();
    setUniverse([COLLIDE]);
    void mount.openForNewTools(before!);
    await tick();
    mount.toggleOp('ab', 'c');
    // Selecting (ab, c) must NOT also select (a, bc).
    expect(mount.isOpSelected('ab', 'c')).toBe(true);
    expect(mount.isOpSelected('a', 'bc')).toBe(false);
    await mount.confirm();
    await tick();
    // Exactly the one op was granted — no aliasing.
    expect(recorded.map((r) => `${r.ingredient_id}|${r.operation_id}`)).toEqual(['ab|c']);
  });

  it('toggleOp flips an op; a DOM checkbox click does the same', async () => {
    const { mount, host, setUniverse } = mountFor();
    setUniverse([]);
    const before = await mount.snapshot();
    setUniverse([MAGICK]);
    void mount.openForNewTools(before!);
    await tick();
    mount.toggleOp('magick-a', 'convert');
    expect(mount.isOpSelected('magick-a', 'convert')).toBe(true);
    // DOM path: clicking the convert checkbox toggles it back off.
    opBox(host, 'magick-a', 'convert')?.click();
    expect(mount.isOpSelected('magick-a', 'convert')).toBe(false);
  });
});

describe('D-182 §7.1 cli grant dialog — confirm', () => {
  it('grants the selected ops at the OWNER principal (one write each), then closes', async () => {
    const { mount, recorded, setUniverse } = mountFor();
    setUniverse([]);
    const before = await mount.snapshot();
    setUniverse([MAGICK]);
    void mount.openForNewTools(before!);
    await tick();
    // identify (read) is pre-selected; opt into both write ops too.
    mount.toggleOp('magick-a', 'convert');
    mount.toggleOp('magick-b', 'mogrify');
    await mount.confirm();
    await tick();
    const keys = recorded
      .map((r) => `${r.principal ?? OWNER}|${r.ingredient_id}|${r.operation_id}`)
      .sort();
    expect(keys).toEqual([
      `${OWNER}|magick-a|convert`,
      `${OWNER}|magick-a|identify`,
      `${OWNER}|magick-b|mogrify`,
    ]);
    for (const r of recorded) {
      expect(r.principal).toBe(OWNER);
      expect(r.allowed).toBe(true);
    }
    expect(mount.isOpen()).toBe(false);
  });

  it('a default confirm on a write-only tool grants nothing (fail-closed) and closes', async () => {
    const { mount, recorded, setUniverse } = mountFor();
    setUniverse([]);
    const before = await mount.snapshot();
    setUniverse([WHISPER]);
    void mount.openForNewTools(before!);
    await tick();
    // whisper has only a Write op, which starts OFF → confirm grants nothing.
    await mount.confirm();
    await tick();
    expect(recorded).toHaveLength(0);
    expect(mount.isOpen()).toBe(false);
  });

  it('the DOM Confirm button grants the selected ops', async () => {
    const { mount, host, recorded, setUniverse } = mountFor();
    setUniverse([]);
    const before = await mount.snapshot();
    setUniverse([WHISPER]);
    void mount.openForNewTools(before!);
    await tick();
    opBox(host, 'whisper', 'transcribe')?.click(); // opt into the write op
    collectByAttr(host, CLI_GRANT_DIALOG_CONFIRM_BTN_ATTR)[0]?.click();
    await tick();
    expect(recorded.map((r) => r.operation_id)).toEqual(['transcribe']);
    expect(mount.isOpen()).toBe(false);
  });

  it('Skip closes granting nothing', async () => {
    const { mount, host, recorded, setUniverse } = mountFor();
    setUniverse([]);
    const before = await mount.snapshot();
    setUniverse([MAGICK]);
    void mount.openForNewTools(before!);
    await tick();
    collectByAttr(host, CLI_GRANT_DIALOG_SKIP_BTN_ATTR)[0]?.click();
    expect(recorded).toHaveLength(0);
    expect(mount.isOpen()).toBe(false);
  });

  it('openForNewTools resolves when the dialog closes (confirm/skip)', async () => {
    const { mount, setUniverse } = mountFor();
    setUniverse([]);
    const before = await mount.snapshot();
    setUniverse([MAGICK]);
    const p = mount.openForNewTools(before!);
    await tick();
    mount.skip();
    await expect(p).resolves.toBeUndefined();
  });
});

describe('D-182 §7.1 cli grant dialog — robustness', () => {
  it('keeps the dialog open + shows an error on a PARTIAL confirm failure', async () => {
    const runSet: CliGrantSetCaller = async (args) => {
      if (args.operation_id === 'mogrify') throw new Error('disk full');
      return {
        principal: args.principal ?? OWNER,
        ingredient_id: args.ingredient_id,
        operation_id: args.operation_id,
        allowed: args.allowed,
      };
    };
    const { mount, host, setUniverse } = mountFor({ runSet });
    setUniverse([]);
    const before = await mount.snapshot();
    setUniverse([MAGICK]);
    void mount.openForNewTools(before!);
    await tick();
    mount.toggleOp('magick-b', 'mogrify');
    await mount.confirm();
    await tick();
    expect(mount.isOpen()).toBe(true);
    expect(mount.getError()).toContain('disk full');
    expect(collectByAttr(host, CLI_GRANT_DIALOG_ERROR_ATTR)).toHaveLength(1);
  });

  it('a stale confirm cannot close or corrupt a freshly reopened dialog (F1)', async () => {
    const gate = deferred<void>();
    let holdFirst = true;
    const runSet: CliGrantSetCaller = async (args) => {
      if (holdFirst) {
        holdFirst = false;
        await gate.promise;
      }
      return {
        principal: args.principal ?? OWNER,
        ingredient_id: args.ingredient_id,
        operation_id: args.operation_id,
        allowed: args.allowed,
      };
    };
    const { mount, setUniverse } = mountFor({ runSet });
    // Dialog A — whisper.
    setUniverse([]);
    const before = await mount.snapshot();
    setUniverse([WHISPER]);
    const pA = mount.openForNewTools(before!);
    await tick();
    mount.toggleOp('whisper', 'transcribe');
    const cA = mount.confirm(); // holds on the gate (first runSet call)
    await tick();
    expect(mount.isSubmitting()).toBe(true);

    // Dialog B — a second install adds magick while A's confirm is in flight.
    const before2 = await mount.snapshot(); // whisper present now
    setUniverse([WHISPER, MAGICK]);
    const pB = mount.openForNewTools(before2!);
    await tick();
    await pA; // the reopen closed A → its promise resolved
    expect(mount.isOpen()).toBe(true);
    expect(mount.getDialogTools()).toEqual([
      { tool: 'magick', new_ops: ['identify', 'convert', 'mogrify'] },
    ]);
    expect(mount.isSubmitting()).toBe(false);

    // Release A's held write — its stale callback must NOT touch B.
    gate.resolve();
    await cA;
    await tick();
    expect(mount.isOpen()).toBe(true);
    expect(mount.getDialogTools()).toEqual([
      { tool: 'magick', new_ops: ['identify', 'convert', 'mogrify'] },
    ]);
    expect(mount.getError()).toBeNull();
    // B still pending the owner's choice.
    expect(mount.isSubmitting()).toBe(false);
    void pB;
  });

  it('dispose mid-open removes the overlay + resolves the pending promise', async () => {
    const { mount, host, setUniverse } = mountFor();
    setUniverse([]);
    const before = await mount.snapshot();
    setUniverse([MAGICK]);
    const p = mount.openForNewTools(before!);
    await tick();
    expect(mount.isOpen()).toBe(true);
    mount.dispose();
    await expect(p).resolves.toBeUndefined();
    expect(mount.isOpen()).toBe(false);
    expect(collectByAttr(host, CLI_GRANT_DIALOG_TOOL_ATTR)).toHaveLength(0);
  });
});

describe('D-182 §7.1 cli grant dialog — presentation contract', () => {
  it('keeps new local-tool grants scroll-safe and readable on narrow screens', () => {
    expect(CLI_GRANT_DIALOG_STYLES).toContain('max-width: 640px');
    expect(CLI_GRANT_DIALOG_STYLES).toContain(
      '.cg-op:has(.cg-op-box:checked)',
    );
    expect(CLI_GRANT_DIALOG_STYLES).toContain('@media (max-width: 600px)');
  });
});
