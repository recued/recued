/** 2026-11-20 (the owner: "go ahead", the settle check) — a read asked to settle waits for the page to stop changing.
 *  On browser task P, 27 of 30 act batches carried a wait the model wrote (58 s, 14% of answer time) and 6 of its 9
 *  waits on a selector it invented failed: a click that loads nothing was read as the page drew. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BRIDGE_READ_QUIET_MS, type BridgeAction, type BridgeCommand } from '@recued/contracts';
import { buildActionExecutor, type BridgeBrowserApi } from '../actions/executor.js';
import { pageSettleProbe, readSettleMs, readWaitChangeMs, type PageSettleState } from '../actions/page-settle.js';

afterEach(() => { vi.unstubAllGlobals(); });

/** A document whose content changes when the test says, on a clock the test moves. */
type FakeAnimation = { playState: string; endTime: number; visible?: boolean; target?: false };
const page = (busy: Array<{ visible: boolean }> = [], animations?: FakeAnimation[]) => {
  let now = 1_000;
  const observers: Array<{ callback: (records: Array<{ type: string }>) => void; options: unknown; target: unknown }> = [];
  vi.stubGlobal('performance', { now: () => now });
  vi.stubGlobal('window', {});
  vi.stubGlobal('document', { querySelectorAll: (selector: string) => selector === '[aria-busy="true"]'
    ? busy.map(({ visible }) => ({ checkVisibility: () => visible })) : [],
    ...(animations ? { getAnimations: () => animations.map(({ playState, endTime, visible = true, target }) => ({ playState,
      effect: { getComputedTiming: () => ({ endTime }), target: target === false ? null : { checkVisibility: () => visible } } })) } : {}) });
  vi.stubGlobal('MutationObserver', class {
    constructor(private readonly callback: (records: Array<{ type: string }>) => void) {}
    observe(target: unknown, options: unknown) { observers.push({ callback: this.callback, options, target }); }
  });
  return {
    observers, busy,
    pass: (ms: number) => { now += ms; },
    change: (...types: string[]) => { for (const { callback } of observers) callback(types.map((type) => ({ type }))); },
  };
};

describe('pageSettleProbe — how long the content has been still, and whether a region is busy', () => {
  it('starts watching once per document, and measures from its own start', () => {
    const p = page();
    const first = { busy: false, animating: false, changes: 0, marked: null, spinning: false };
    expect(pageSettleProbe()).toEqual({ ...first, quiet_ms: 0, fresh: true });
    p.pass(250);
    expect(pageSettleProbe()).toEqual({ ...first, quiet_ms: 250, fresh: false });
    expect(p.observers).toHaveLength(1);
    expect(p.observers[0]!.options).toEqual({ subtree: true, childList: true, characterData: true });
  });

  it('counts added, removed or changed content, and not attributes alone', () => {
    const p = page();
    pageSettleProbe();
    p.pass(600);
    p.change('attributes');
    expect(pageSettleProbe().quiet_ms).toBe(600);
    p.change('childList');
    expect(pageSettleProbe().quiet_ms).toBe(0);
    p.pass(300);
    p.change('attributes', 'characterData');
    expect(pageSettleProbe().quiet_ms).toBe(0);
  });

  it('is animating while a finite animation runs on a shown element, and not for an endless, paused, hidden or targetless one', () => {
    const animating = (animations?: FakeAnimation[]) => { vi.unstubAllGlobals(); page([], animations); return pageSettleProbe().animating; };
    expect(animating()).toBe(false);
    expect(animating([{ playState: 'running', endTime: 300 }])).toBe(true);
    expect(animating([{ playState: 'running', endTime: Infinity }])).toBe(false);
    expect(animating([{ playState: 'paused', endTime: 300 }, { playState: 'finished', endTime: 300 }])).toBe(false);
    expect(animating([{ playState: 'running', endTime: 300, visible: false }])).toBe(false);
    expect(animating([{ playState: 'running', endTime: 300, target: false }])).toBe(false);
    expect(animating([{ playState: 'running', endTime: Infinity }, { playState: 'running', endTime: 300 }])).toBe(true);
  });

  it('is busy while a shown region says aria-busy, and not for a hidden one', () => {
    expect((page([{ visible: false }]), pageSettleProbe()).busy).toBe(false);
    vi.unstubAllGlobals();
    expect((page([{ visible: false }, { visible: true }]), pageSettleProbe()).busy).toBe(true);
  });
});

// 2026-11-20 (the owner: "go ahead", a wait at the Bridge) — what a plain wait of seconds counts from and holds on.
describe('pageSettleProbe — the changes a wait counts, and the mark a read leaves', () => {
  it('counts each change of content, never of attributes alone, and a mark keeps the count it was left at', () => {
    const p = page();
    expect(pageSettleProbe().changes).toBe(0);
    p.change('attributes');
    expect(pageSettleProbe().changes).toBe(0);
    p.change('childList', 'attributes');
    p.change('characterData');
    expect(pageSettleProbe(true)).toMatchObject({ changes: 2, marked: null });
    expect(pageSettleProbe()).toMatchObject({ changes: 2, marked: 2 });
    p.change('childList');
    expect(pageSettleProbe()).toMatchObject({ changes: 3, marked: 2, fresh: false });
  });

  it('is spinning for an endless animation started since the mark, and not for one already running then, or before any mark', () => {
    page();
    const animation = (endTime: number, visible = true) => ({ playState: 'running', effect: { getComputedTiming: () => ({ endTime }),
      target: { checkVisibility: () => visible } } });
    const decoration = animation(Infinity);
    const running: Array<ReturnType<typeof animation>> = [decoration];
    vi.stubGlobal('document', { querySelectorAll: () => [], getAnimations: () => running });
    expect(pageSettleProbe().spinning).toBe(false);
    pageSettleProbe(true);
    expect(pageSettleProbe().spinning).toBe(false);
    running.push(animation(Infinity, false));
    expect(pageSettleProbe().spinning).toBe(false);
    const spinner = animation(Infinity);
    running.push(spinner);
    expect(pageSettleProbe()).toMatchObject({ spinning: true, animating: false });
    running.splice(running.indexOf(spinner), 1);
    expect(pageSettleProbe().spinning).toBe(false);
  });
});

describe('readSettleMs — the settle a read asks for', () => {
  it('is none for none or nonsense, and at most the longest settle', () => {
    for (const value of [undefined, 0, -5, Number.NaN, '3000', null]) expect(readSettleMs(value)).toBeUndefined();
    expect(readSettleMs(250)).toBe(250);
    expect(readSettleMs(60_000)).toBe(3_000);
  });

  it('readWaitChangeMs is none for none or nonsense, and at most the longest wait', () => {
    for (const value of [undefined, 0, -5, Number.NaN, '3000', null]) expect(readWaitChangeMs(value)).toBeUndefined();
    expect(readWaitChangeMs(2_500)).toBe(2_500);
    // 2026-11-21 (D-402, task H) — a wait for a change may take 30 s, as long as one wait may (`long_waits`).
    expect(readWaitChangeMs(60_000)).toBe(30_000);
  });
});

const read = { url: 'https://app.example.com/notes', title: 'Notes', html: '<body><main>Notes</main></body>', truncated: false };
const command = (args: Record<string, unknown>, expects: string[]): BridgeCommand => ({
  command_id: 'cmd-1', recipe_run_id: 'run-1', step_id: 'step-1',
  ingredient: { publisher_id: 'recued-core', slug: 'dom-inspect', version: '1.0.0', surface_kind: 'reading',
    domain_allowlist: ['*://app.example.com/*'], domain_allowlist_signature: 'PUB' },
  action: 'inspect' as BridgeAction, target_domain_pattern: '*://app.example.com/*', args, expects_output_keys: expects,
  timeout_ms: 30_000, idempotency_key: 'idem-1',
});

/** An inspect of page 1:DOC1 whose probe answers `states` in turn (the last one repeats), then the read. */
const inspectWith = async (args: Record<string, unknown>, states: Array<Partial<PageSettleState> & { quiet_ms: number; busy: boolean } | 'gone'>,
  expects = ['page', 'url', 'title', 'html', 'truncated', 'settled'], marks: boolean[] = []) => {
  const calls: string[] = [];
  let probes = 0;
  const executeInDocument: NonNullable<BridgeBrowserApi['executeInDocument']> = async (_target, func, funcArgs) => {
    if (func === pageSettleProbe) {
      const mark = (funcArgs as unknown[] | undefined)?.[0] === true;
      marks.push(mark);
      // The mark a wait leaves after it has waited answers what it is asked, and is not one of the states.
      if (mark && args.wait_change_ms !== undefined) return { document_id: 'DOC1', result: null };
      const state = states[Math.min(probes++, states.length - 1)]!;
      calls.push('probe');
      return state === 'gone' ? { document_id: 'DOC2', result: { quiet_ms: 0, busy: false } } : { document_id: 'DOC1', result: state };
    }
    calls.push('read');
    return { document_id: probes > 0 && states[Math.min(probes - 1, states.length - 1)] === 'gone' ? 'DOC2' : 'DOC1',
      result: { outputs: read } };
  };
  const api = { executeInDocument, async findTabByUrlPattern() { return null; }, async executeScript() { return null; },
    async captureVisibleTab() { return ''; }, async showNotification(id: string) { return id; } } as unknown as BridgeBrowserApi;
  const started = Date.now();
  const out = await buildActionExecutor(api).execute({ action: 'inspect', cancel: { signalled: false },
    command: command({ page: '1:DOC1', ...args }, expects) });
  return { out, calls, spent: Date.now() - started };
};

describe('inspect asked to settle', () => {
  it('reads once the page has been still long enough, and says it had settled', async () => {
    const { out, calls } = await inspectWith({ settle_ms: 3_000 },
      [{ quiet_ms: 0, busy: false }, { quiet_ms: BRIDGE_READ_QUIET_MS, busy: false }]);
    expect(calls).toEqual(['probe', 'probe', 'read']);
    expect(out).toEqual({ status: 'ok', outputs: { page: '1:DOC1', ...read, settled: true } });
  });

  it('waits while a finite animation runs, though the content is still', async () => {
    const { out, calls } = await inspectWith({ settle_ms: 3_000 },
      [{ quiet_ms: 900, busy: false, animating: true }, { quiet_ms: 1_000, busy: false, animating: false }]);
    expect(calls).toEqual(['probe', 'probe', 'read']);
    expect(out).toMatchObject({ status: 'ok', outputs: { settled: true } });
  });

  it('waits while a shown region is busy, though the content is still', async () => {
    const { out, calls } = await inspectWith({ settle_ms: 3_000 },
      [{ quiet_ms: 900, busy: true }, { quiet_ms: 1_000, busy: false }]);
    expect(calls).toEqual(['probe', 'probe', 'read']);
    expect(out).toMatchObject({ status: 'ok', outputs: { settled: true } });
  });

  it('reads anyway at the end of its settle, and says the page was still changing', async () => {
    const { out, calls, spent } = await inspectWith({ settle_ms: 250 }, [{ quiet_ms: 0, busy: false }]);
    expect(calls.at(-1)).toBe('read');
    expect(calls.filter((call) => call === 'probe').length).toBeGreaterThan(1);
    expect(spent).toBeGreaterThanOrEqual(240);
    expect(out).toMatchObject({ status: 'ok', outputs: { settled: false } });
  });

  it('answers settled only to a server that expects it, though it still waits', async () => {
    const { out, calls } = await inspectWith({ settle_ms: 3_000 },
      [{ quiet_ms: 0, busy: false }, { quiet_ms: BRIDGE_READ_QUIET_MS, busy: false }], ['page', 'url', 'title', 'html', 'truncated']);
    expect(calls).toEqual(['probe', 'probe', 'read']);
    expect(out).toEqual({ status: 'ok', outputs: { page: '1:DOC1', ...read } });
  });

  it('never asks the page when the read asks no settle', async () => {
    const { out, calls } = await inspectWith({}, [{ quiet_ms: 0, busy: false }]);
    expect(calls).toEqual(['read']);
    expect(out).toEqual({ status: 'ok', outputs: { page: '1:DOC1', ...read } });
  });

  it('leaves a document that went while it waited for the read to report', async () => {
    const { out, calls } = await inspectWith({ settle_ms: 3_000 }, ['gone']);
    expect(calls).toEqual(['probe', 'read']);
    expect(out).toMatchObject({ status: 'error', error: { code: 'selector_not_found' } });
  });

  it('leaves the mark a later wait counts from, at each look', async () => {
    const marks: boolean[] = [];
    await inspectWith({ settle_ms: 3_000 }, [{ quiet_ms: 0, busy: false }, { quiet_ms: BRIDGE_READ_QUIET_MS, busy: false }], undefined, marks);
    expect(marks).toEqual([true, true]);
  });
});

// 2026-11-20 (the owner: "go ahead", a wait at the Bridge) — a plain wait of seconds, sent as a read that waits for a change.
describe('inspect asked to wait for a change', () => {
  const WAITS = ['page', 'url', 'title', 'html', 'truncated', 'settled', 'changed'];
  const at = (changes: number, quiet_ms: number, more: Partial<PageSettleState> = {}) =>
    ({ changes, marked: 3, fresh: false, quiet_ms, busy: false, animating: false, spinning: false, ...more });

  it('waits for a change past the mark, then for the page to hold still, and leaves its own mark before the read', async () => {
    const marks: boolean[] = [];
    const { out, calls } = await inspectWith({ wait_change_ms: 5_000, settle_ms: 3_000 },
      [at(3, 2_000), at(4, 0), at(4, BRIDGE_READ_QUIET_MS)], WAITS, marks);
    expect(calls).toEqual(['probe', 'probe', 'probe', 'read']);
    expect(marks).toEqual([false, false, false, true]);
    expect(out).toEqual({ status: 'ok', outputs: { page: '1:DOC1', ...read, settled: true, changed: true } });
  });

  it('counts a change made after the mark but before it began, such as a click made then', async () => {
    const { out, calls } = await inspectWith({ wait_change_ms: 5_000 }, [at(5, 0), at(5, BRIDGE_READ_QUIET_MS)], WAITS);
    expect(calls).toEqual(['probe', 'probe', 'read']);
    expect(out).toMatchObject({ status: 'ok', outputs: { settled: true, changed: true } });
  });

  it('counts a document the watch had not seen as changed, so it only waits for it to hold still', async () => {
    const { out, calls } = await inspectWith({ wait_change_ms: 5_000 },
      [at(0, 0, { fresh: true, marked: null }), at(0, BRIDGE_READ_QUIET_MS)], WAITS);
    expect(calls).toEqual(['probe', 'probe', 'read']);
    expect(out).toMatchObject({ status: 'ok', outputs: { settled: true, changed: true } });
  });

  it('counts from its own start in a document the watch saw but no read marked', async () => {
    const { out, calls } = await inspectWith({ wait_change_ms: 5_000 },
      [at(5, 2_000, { marked: null }), at(6, 0, { marked: null }), at(6, BRIDGE_READ_QUIET_MS, { marked: null })], WAITS);
    expect(calls).toEqual(['probe', 'probe', 'probe', 'read']);
    expect(out).toMatchObject({ status: 'ok', outputs: { settled: true, changed: true } });
  });

  it('holds while a spinner started since the mark runs, and while the page is busy or animating', async () => {
    const { out, calls } = await inspectWith({ wait_change_ms: 5_000 },
      [at(4, 1_000, { spinning: true }), at(4, 1_000, { busy: true }), at(4, 1_000, { animating: true }), at(4, 1_000)], WAITS);
    expect(calls).toEqual(['probe', 'probe', 'probe', 'probe', 'read']);
    expect(out).toMatchObject({ status: 'ok', outputs: { settled: true, changed: true } });
  });

  it('reads at the end of its wait when the page did not change, and says so', async () => {
    const { out, calls, spent } = await inspectWith({ wait_change_ms: 250 }, [at(3, 5_000)], WAITS);
    expect(calls.at(-1)).toBe('read');
    expect(spent).toBeGreaterThanOrEqual(240);
    expect(out).toMatchObject({ status: 'ok', outputs: { settled: false, changed: false } });
  });

  it('answers changed only to a server that expects it', async () => {
    const { out } = await inspectWith({ wait_change_ms: 5_000 }, [at(4, BRIDGE_READ_QUIET_MS)]);
    expect(out).toEqual({ status: 'ok', outputs: { page: '1:DOC1', ...read, settled: true } });
  });
});
