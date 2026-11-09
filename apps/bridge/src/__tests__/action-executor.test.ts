/** D-148 P3 — action executor tests.
 *
 *  Covers the BridgeAction dispatch table per spec § A.3.1 and the
 *  output-key validation gate. */

import { describe, it, expect, vi } from 'vitest';
import { buildActionExecutor, type BridgeBrowserApi } from '../actions/executor.js';
import { fillPageField, readPageField } from '../actions/page-fields.js';
import { PAGE_MESSAGE_RULES } from '../actions/page-problems.js';
import { PICK_RULES } from '../actions/page-pick.js';
import { SELECTOR_RULES } from '../picker/selector-engine.js';
import { describePageFrame, listChromeFrames, PAGE_FRAMES_WAIT_MS, PAGE_REREAD_KEPT_GONE, settleFrames, type PageFrame } from '../actions/page-inspect.js';
import type { DocumentScripting } from '../actions/reviewed-document.js';
import {
  BRIDGE_CLICK_LOAD_MAX_MS,
  BRIDGE_CLICK_OUTPUT_KEYS,
  BRIDGE_CLICK_SETTLE_MS,
  BRIDGE_FILL_OUTPUT_KEYS,
  BRIDGE_PICK_OUTPUT_KEYS,
  BRIDGE_SUBMIT_OUTPUT_KEYS,
  BRIDGE_WATCH_MAX_MS,
  BRIDGE_CLICK_WAIT_MS,
  bridgeElementChangedMessage,
  type BridgeAction,
  type BridgeCommand,
} from '@recued/contracts';

const buildBrowser = (overrides: Partial<BridgeBrowserApi> = {}): BridgeBrowserApi => ({
  async findTabByUrlPattern() {
    return { tab_id: 1, url: 'https://app.hubspot.com/contacts/1', window_id: 100 };
  },
  async executeScript() {
    return null;
  },
  async captureVisibleTab() {
    return 'data:image/png;base64,FAKE';
  },
  async showNotification(notification_id) {
    return notification_id;
  },
  ...overrides,
});

const buildCommand = (action: BridgeAction, args: Record<string, unknown> = {}, expects: string[] = []): BridgeCommand => ({
  command_id: 'cmd-1',
  recipe_run_id: 'run-1',
  step_id: 'step-1',
  ingredient: {
    publisher_id: 'recued-core',
    slug: 'foo',
    version: '1.0.0',
    surface_kind: 'reading',
    domain_allowlist: ['*://app.hubspot.com/*'],
    domain_allowlist_signature: 'PUB',
  },
  action,
  target_domain_pattern: '*://app.hubspot.com/*',
  args,
  expects_output_keys: expects,
  timeout_ms: 30_000,
  idempotency_key: 'idem-1',
});

describe('D-148 P3 — action executor (read_dom)', () => {
  it('executes against the matched tab + returns text', async () => {
    const executor = buildActionExecutor(
      buildBrowser({
        async executeScript() {
          return { outputs: { text: 'Hello from DOM' } };
        },
      }),
    );
    const out = await executor.execute({
      command: buildCommand('read_dom', { selector: '#title' }, ['text']),
      action: 'read_dom',
      cancel: { signalled: false },
    });
    expect(out.status).toBe('ok');
    expect(out.outputs?.text).toBe('Hello from DOM');
  });

  it('selector_not_found when querySelector returns null', async () => {
    const executor = buildActionExecutor(
      buildBrowser({ async executeScript() { return { missing: true }; } }),
    );
    const out = await executor.execute({
      command: buildCommand('read_dom', { selector: '#missing' }),
      action: 'read_dom',
      cancel: { signalled: false },
    });
    expect(out.status).toBe('error');
    expect(out.error?.code).toBe('selector_not_found');
  });

  it('capacity_gap_tab_unavailable when no tab matches', async () => {
    const executor = buildActionExecutor(
      buildBrowser({ async findTabByUrlPattern() { return null; } }),
    );
    const out = await executor.execute({
      command: buildCommand('read_dom', { selector: '#title' }),
      action: 'read_dom',
      cancel: { signalled: false },
    });
    expect(out.status).toBe('error');
    expect(out.error?.code).toBe('capacity_gap_tab_unavailable');
  });
});

describe('D-148 P3 — action executor (click + fill + wait + extract)', () => {
  const writeActions = ['click', 'fill'] as const;
  const invalidAcknowledgements = [undefined, null, 0, 1, 'true', {}, { clicked: true }, []];
  it.each(writeActions.flatMap(action => invalidAcknowledgements.map(ack => ({ action, ack }))))(
    'keeps $action uncertainty for a missing or malformed acknowledgement ($ack)', async ({ action, ack }) => {
      const executor = buildActionExecutor(buildBrowser({ executeScript: async () => ack }));
      const out = await executor.execute({ action, cancel: { signalled: false },
        command: buildCommand(action, { selector: '#save', value: 'value' }, [action === 'click' ? 'clicked' : 'filled']) });
      expect(out).toMatchObject({ status: 'error', error: { code: 'delivery_uncertain' } });
      expect(out.outputs).toBeUndefined();
    });

  it.each(writeActions)('keeps an explicit missing $action answer as a confirmed missing selector', async action => {
    // Both answer in the shared field shape (`page-fields.ts`).
    const executor = buildActionExecutor(buildBrowser({ executeScript: async () => ({ missing: true }) }));
    const out = await executor.execute({ action, cancel: { signalled: false },
      command: buildCommand(action, { selector: '#save', value: 'value' }, [action === 'click' ? 'clicked' : 'filled']) });
    expect(out).toMatchObject({ status: 'error', error: { code: 'selector_not_found' } });
  });

  it('click executes', async () => {
    const executor = buildActionExecutor(
      buildBrowser({ async executeScript() { return { outputs: { clicked: true } }; } }),
    );
    const out = await executor.execute({
      command: buildCommand('click', { selector: 'button' }, ['clicked']),
      action: 'click',
      cancel: { signalled: false },
    });
    expect(out.status).toBe('ok');
    expect(out.outputs?.clicked).toBe(true);
  });

  it('fill executes when value provided', async () => {
    const executor = buildActionExecutor(
      buildBrowser({ async executeScript() { return { outputs: { filled: true } }; } }),
    );
    const out = await executor.execute({
      command: buildCommand('fill', { selector: 'input', value: 'foo' }, ['filled']),
      action: 'fill',
      cancel: { signalled: false },
    });
    expect(out.status).toBe('ok');
  });

  it('fill missing value → error', async () => {
    const executor = buildActionExecutor(buildBrowser());
    const out = await executor.execute({
      command: buildCommand('fill', { selector: 'input' }),
      action: 'fill',
      cancel: { signalled: false },
    });
    expect(out.status).toBe('error');
  });

  it('wait_for_selector executes', async () => {
    const executor = buildActionExecutor(
      buildBrowser({ async executeScript() { return true; } }),
    );
    const out = await executor.execute({
      command: buildCommand('wait_for_selector', { selector: '#x' }, ['present']),
      action: 'wait_for_selector',
      cancel: { signalled: false },
    });
    expect(out.status).toBe('ok');
  });

  it('extract_table returns row map', async () => {
    const executor = buildActionExecutor(
      buildBrowser({
        async executeScript() {
          return [{ name: 'Alice', deal: 'D1' }] as Array<Record<string, string>>;
        },
      }),
    );
    const out = await executor.execute({
      command: buildCommand('extract_table', { selector: 'table' }, ['rows']),
      action: 'extract_table',
      cancel: { signalled: false },
    });
    expect(out.status).toBe('ok');
    expect((out.outputs?.rows as unknown[])?.length).toBe(1);
  });
});

// read_dom and fill run the shared field functions (page-fields.ts), which
// answer in one shape on both executors. These pin how this executor reads it;
// what the functions do on a real page is pinned in real Chrome by
// `backend/server/src/__tests__/bridge-page-fields-browser.test.ts`.
describe('read_dom + fill — the shared field answers', () => {
  const run = (action: 'read_dom' | 'fill', answer: unknown) =>
    buildActionExecutor(buildBrowser({ executeScript: async () => answer })).execute({
      action, cancel: { signalled: false },
      command: buildCommand(action, { selector: '#field', value: 'value' }, [action === 'fill' ? 'filled' : 'text']),
    });

  it('injects the shared field functions, so both executors run the same code', async () => {
    const injected: unknown[] = [];
    const executor = buildActionExecutor(buildBrowser({
      async executeScript(_tab, fn) { injected.push(fn); return { missing: true }; },
    }));
    for (const action of ['read_dom', 'fill'] as const) {
      await executor.execute({ action, cancel: { signalled: false },
        command: buildCommand(action, { selector: '#field', value: 'value' }) });
    }
    expect(injected[0]).toBe(readPageField);
    expect(injected[1]).toBe(fillPageField);
  });

  it('refuses a protected field instead of reading it', async () => {
    expect(await run('read_dom', { protected: true })).toMatchObject({ status: 'error', error: { code: 'field_protected' } });
  });

  it('reports a write the page did not take as a confirmed failure, with its reason', async () => {
    expect(await run('fill', { not_applied: 'The editor did not take the text.' })).toMatchObject({
      status: 'error', error: { code: 'value_not_applied', message: 'The editor did not take the text.' } });
  });

  it.each(['read_dom', 'fill'] as const)('refuses the owner client for %s', async action => {
    expect(await run(action, { blocked: true })).toMatchObject({ status: 'error', error: { code: 'tab_navigation_blocked' } });
  });

  // Each refusal belongs to one operation: a read is never "not applied", and
  // a write is never "protected". Anything off-shape proves nothing.
  it.each([
    ['read_dom', undefined], ['read_dom', 'text'], ['read_dom', { outputs: { text: 1 } }],
    ['read_dom', { outputs: { text: 'a', extra: 'b' } }], ['read_dom', { not_applied: 'x' }],
    ['read_dom', { protected: true, missing: true }],
    ['fill', { protected: true }], ['fill', { not_applied: 1 }], ['fill', { outputs: { filled: 'true' } }],
  ] as const)('treats a malformed %s answer as unproven (%j)', async (action, answer) => {
    const out = await run(action, answer);
    expect(out).toMatchObject({ status: 'error', error: { code: action === 'fill' ? 'delivery_uncertain' : 'unknown' } });
    expect(out.outputs).toBeUndefined();
  });
});

// D-335 — what the page read does in a page is pinned in real Chrome by
// `backend/server/src/__tests__/bridge-page-inspect-browser.test.ts`. These pin
// how this executor picks the document and reads the answer.
describe('click — a refusal before anything was sent is confirmed', () => {
  // The realistic click refuses an element that is disabled or that something
  // covers before it sends any event (2026-11-01): the step failed, and nothing
  // on the page was clicked.
  it('reports the reason as a write that did not happen, never as uncertain', async () => {
    const out = await buildActionExecutor(buildBrowser({
      executeScript: async () => ({ not_applied: 'Something else on the page covers it (“Accept cookies”), so it was not clicked. '
        + 'Close or answer that first.' }),
    })).execute({ action: 'click', cancel: { signalled: false }, command: buildCommand('click', { selector: '#send' }, ['clicked']) });
    expect(out).toEqual({ status: 'error', error: { code: 'value_not_applied',
      message: 'Something else on the page covers it (“Accept cookies”), so it was not clicked. Close or answer that first.',
      detail: '#send' } });
  });
});

describe('inspect — one document, and only a well-formed answer', () => {
  const keys = ['page', 'url', 'title', 'html', 'truncated'];
  const read = { url: 'https://app.hubspot.com/deals', title: 'Deals', html: '<body></body>', truncated: false };
  const run = (args: Record<string, unknown>, executeInDocument: BridgeBrowserApi['executeInDocument'],
    findTabByUrlPattern?: BridgeBrowserApi['findTabByUrlPattern']) =>
    buildActionExecutor(buildBrowser({ executeInDocument, ...(findTabByUrlPattern ? { findTabByUrlPattern } : {}) }))
      .execute({ action: 'inspect', cancel: { signalled: false }, command: buildCommand('inspect', args, keys) });

  it('answers the handle of the document Chrome read', async () => {
    expect(await run({}, async () => ({ document_id: 'DOC9', result: { outputs: read } })))
      .toEqual({ status: 'ok', outputs: { page: '1:DOC9', ...read } });
  });

  it('reads the document a page handle names, without looking a tab up', async () => {
    const targets: unknown[] = [];
    const out = await run({ page: '7:DOC7', ref: 'e2' },
      async (target, func, args) => {
        // Slice M — the ref is first looked for again, should the page have rebuilt its element.
        if (func.name === 'rebindPageRef') return { document_id: 'DOC7', result: { kept: true } };
        targets.push({ target, scope: args[0] });
        return { document_id: 'DOC7', result: { outputs: read } };
      },
      async () => { throw new Error('a page handle must not select a tab'); });
    expect(out).toMatchObject({ status: 'ok', outputs: { page: '7:DOC7' } });
    expect(targets).toEqual([{ target: { tab_id: 7, document_id: 'DOC7' }, scope: { ref: 'e2' } }]);
  });

  const gone: Array<[string, NonNullable<BridgeBrowserApi['executeInDocument']>]> = [
    ['Chrome has no such document', async () => null],
    ['Chrome refused the injection', async () => { throw new Error('No document with id DOC7'); }],
    ['another document answered', async () => ({ document_id: 'DOC8', result: { outputs: read } })],
  ];
  // Inspecting the same handle again could only fail again (slice D): the AI
  // is sent to the tabs for the page's current handle.
  it.each(gone)('reports the page gone, and where its new handle is, when %s', async (_label, executeInDocument) => {
    expect(await run({ page: '7:DOC7' }, executeInDocument)).toEqual({ status: 'error', error: {
      code: 'selector_not_found', message: 'The page has reloaded, gone to another address or closed since it was read: '
        + 'list the tabs for its current page handle, then inspect it.' } });
  });

  // D-335 slice P — the server names how much to read; a server from before names nothing and
  // hands the HTML to a model, so it gets the sizes it always had.
  it.each([
    [{}, { max_chars: 40_000, max_value_chars: 2_000 }],
    [{ max_chars: 250_000, max_value_chars: 20_000 }, { max_chars: 250_000, max_value_chars: 20_000 }],
    // An answer past the ceiling would not fit one message to the server.
    [{ max_chars: 5_000_000 }, { max_chars: 600_000, max_value_chars: 2_000 }],
  ])('reads as much as the command names (%j)', async (sizes, limits) => {
    const asked: unknown[] = [];
    await run({ page: '7:DOC7', ...sizes }, async (_target, func, args) => {
      if (func.name === 'rebindPageRef') return { document_id: 'DOC7', result: { kept: true } };
      asked.push(args[1]);
      return { document_id: 'DOC7', result: { outputs: read } };
    });
    expect(asked).toEqual([limits]);
  });

  it.each([{ max_chars: 0 }, { max_chars: 1.5 }, { max_chars: '40000' }, { max_value_chars: -1 }, { max_chars: null }])(
    'refuses a size that is not a whole number of characters, reading nothing (%j)', async sizes => {
      const read = vi.fn();
      expect(await run({ page: '7:DOC7', ...sizes }, read)).toEqual({ status: 'error', error: { code: 'unknown',
        message: 'bridge: max_chars and max_value_chars are whole numbers of characters.' } });
      expect(read).not.toHaveBeenCalled();
    });

  // Anything but one known key, with exactly the four outputs, proves nothing.
  it.each([
    undefined, 'html', { outputs: read, missing: true }, { outputs: { ...read, extra: 1 } },
    { outputs: { ...read, truncated: 'no' } }, { outputs: { url: read.url, title: read.title, html: read.html } },
    { not_applied: 'x' }, { protected: true },
  ])('treats a malformed answer as no answer (%j)', async answer => {
    const out = await run({}, async () => ({ document_id: 'DOC9', result: answer }));
    expect(out).toMatchObject({ status: 'error', error: { code: 'unknown' } });
    expect(out.outputs).toBeUndefined();
  });
});

// D-335 slice B — a write by page reads the element first, then writes. What a
// page does in real Chrome is pinned by `bridge-page-inspect-browser.test.ts`;
// these pin what this executor concludes when Chrome loses the answer.
describe('fill and click by page — what a lost answer means', () => {
  const read = { url: 'https://app.hubspot.com/deals', title: 'Deals', role: 'button', label: 'Send', protected: false };
  const run = (action: 'fill' | 'click', write: NonNullable<BridgeBrowserApi['executeInDocument']>) =>
    buildActionExecutor(buildBrowser({
      async executeInDocument(target, func, args) {
        if (func.name === 'rebindPageRef') return { document_id: 'DOC7', result: { kept: true } };
        return func.name === 'describePageElement' ? { document_id: 'DOC7', result: { outputs: read } }
          : write(target, func, args);
      },
    })).execute({ action, cancel: { signalled: false },
      command: buildCommand(action, { page: '7:DOC7', ref: 'e2', value: 'text' }, [action === 'fill' ? 'filled' : 'clicked']) });

  // A click that navigates can take its own answer with it: the click may have happened.
  it.each(['fill', 'click'] as const)('a %s whose injection is refused after the element was read is uncertain', async action => {
    expect(await run(action, async () => { throw new Error('Frame with ID 0 was removed.'); }))
      .toMatchObject({ status: 'error', error: { code: 'delivery_uncertain' } });
    expect(await run(action, async () => ({ document_id: 'DOC8', result: { outputs: { clicked: true } } })))
      .toMatchObject({ status: 'error', error: { code: 'delivery_uncertain' } });
  });

  // The element is read first: a page gone by then is a confirmed failure, and
  // the AI is sent to the tabs, since its handle can only fail again.
  it.each(['fill', 'click'] as const)('a %s on a page that has gone touches nothing and names where the page is now', async action => {
    const written = vi.fn();
    const out = await buildActionExecutor(buildBrowser({
      async executeInDocument(_target, func) {
        // Looking for the ref again, and reading the element, touch nothing.
        if (func.name === 'describePageElement' || func.name === 'rebindPageRef') return null;
        written();
        return null;
      },
    })).execute({ action, cancel: { signalled: false },
      command: buildCommand(action, { page: '7:DOC7', ref: 'e2', value: 'text' }, [action === 'fill' ? 'filled' : 'clicked']) });
    expect(out).toEqual({ status: 'error', error: { code: 'selector_not_found',
      message: 'The page has reloaded, gone to another address or closed since it was read: '
        + 'list the tabs for its current page handle, then inspect it.' } });
    expect(written).not.toHaveBeenCalled();
  });

  it('D-335 slice M — a step by ref first looks for its element again, should the page have drawn it anew', async () => {
    const order = (args: Record<string, unknown>) => {
      const calls: Array<[string, unknown[]]> = [];
      const out = buildActionExecutor(buildBrowser({
        async executeInDocument(_target, func, given) {
          calls.push([func.name, [...given]]);
          if (func.name === 'rebindPageRef') return { document_id: 'DOC7', result: { rebound: true } };
          return func.name === 'describePageElement' ? { document_id: 'DOC7', result: { outputs: read } }
            : { document_id: 'DOC7', result: { outputs: { clicked: true } } };
        },
      })).execute({ action: 'click', cancel: { signalled: false }, command: buildCommand('click', { page: '7:DOC7', ...args }, ['clicked']) });
      return { calls, out };
    };
    const byRef = order({ ref: 'e2' });
    expect(await byRef.out).toEqual({ status: 'ok', outputs: { clicked: true } });
    expect(byRef.calls.map(([name]) => name)).toEqual(['rebindPageRef', 'describePageElement', 'clickPageElement']);
    // D-347 follow-up 17 — a click acts, so the look also holds the element to what the read showed.
    expect(byRef.calls[0]![1]).toEqual(['e2', true]);
    // A selector names no ref to look for.
    const bySelector = order({ selector: '#send' });
    await bySelector.out;
    expect(bySelector.calls.map(([name]) => name)).toEqual(['describePageElement', 'clickPageElement']);
  });

  // D-335 slice X (2026-11-06) — a search page that rebuilds its form a moment after the box takes
  // focus: a press sent right after the typing found the box at the look, then gone at the press.
  it('D-335 slice X — an element the page rebuilds between the look for it and the step is looked for once more', async () => {
    const step = (action: 'click' | 'press', staleFor: Record<string, number>) => {
      const calls: string[] = [];
      const left = { ...staleFor };
      const out = buildActionExecutor(buildBrowser({
        async executeInDocument(_target, func) {
          calls.push(func.name);
          if (func.name === 'rebindPageRef') return { document_id: 'DOC7', result: { kept: true } };
          if ((left[func.name] ?? 0) > 0) {
            left[func.name]! -= 1;
            return { document_id: 'DOC7', result: { stale: true } };
          }
          return func.name === 'describePageElement' ? { document_id: 'DOC7', result: { outputs: read } }
            : { document_id: 'DOC7', result: { outputs: action === 'press' ? { pressed: 'Enter' } : { clicked: true } } };
        },
      })).execute({ action, cancel: { signalled: false },
        command: buildCommand(action, { page: '7:DOC7', ref: 'e2', ...(action === 'press' ? { key: 'Enter' } : {}) },
          [action === 'press' ? 'pressed' : 'clicked']) });
      return { calls, out };
    };
    // Gone at the key: the look again names the rebuilt box, and the key goes there.
    const pressed = step('press', { pressPageKey: 1 });
    expect(await pressed.out).toEqual({ status: 'ok', outputs: { pressed: 'Enter' } });
    expect(pressed.calls).toEqual(['rebindPageRef', 'describePageElement', 'pressPageKey', 'rebindPageRef', 'pressPageKey']);
    // Gone when it is read, before anything is done.
    const read2 = step('click', { describePageElement: 1 });
    expect(await read2.out).toEqual({ status: 'ok', outputs: { clicked: true } });
    expect(read2.calls).toEqual(['rebindPageRef', 'describePageElement', 'rebindPageRef', 'describePageElement', 'clickPageElement']);
    // Once only: a page that rebuilt it again by then refuses as before, and nothing was clicked.
    const again = step('click', { clickPageElement: 2 });
    expect(await again.out).toMatchObject({ status: 'error', error: { code: 'selector_not_found',
      message: 'The page changed since it was inspected: inspect it again.' } });
    expect(again.calls).toEqual(['rebindPageRef', 'describePageElement', 'clickPageElement', 'rebindPageRef', 'clickPageElement']);
  });

  it('D-347 follow-up 18 — a click by ref waits for a cover to go within its command\'s budget, leaving 15 s for the rest', async () => {
    const waited = async (timeout_ms: number) => {
      const given: unknown[][] = [];
      await buildActionExecutor(buildBrowser({
        async executeInDocument(_target, func, args) {
          if (func.name === 'clickPageElement') given.push([...args]);
          if (func.name === 'rebindPageRef') return { document_id: 'DOC7', result: { kept: true } };
          return func.name === 'describePageElement' ? { document_id: 'DOC7', result: { outputs: read } }
            : { document_id: 'DOC7', result: { outputs: { clicked: true } } };
        },
      })).execute({ action: 'click', cancel: { signalled: false },
        command: { ...buildCommand('click', { page: '7:DOC7', ref: 'e2' }, ['clicked']), timeout_ms } });
      return given[0]!.slice(2);
    };
    expect(await waited(30_000)).toEqual(['e2', BRIDGE_CLICK_WAIT_MS]);
    expect(await waited(20_000)).toEqual(['e2', 5_000]);
    expect(await waited(12_000)).toEqual(['e2', 0]);
  });

  it('D-347 follow-up 17 — a step that acts by a ref whose element now shows something else is refused, saying what', async () => {
    const calls: string[] = [];
    const out = await buildActionExecutor(buildBrowser({
      async executeInDocument(_target, func, args) {
        calls.push(func.name === 'rebindPageRef' ? `rebindPageRef(${String(args[1])})` : func.name);
        if (func.name === 'rebindPageRef') {
          return { document_id: 'DOC7', result: args[1] === true
            ? { changed: { now: '“Delete” in “Dee Delete”', was: '“Delete” in “Bob Delete”' } } : { kept: true } };
        }
        return func.name === 'describePageElement' ? { document_id: 'DOC7', result: { outputs: read } }
          : { document_id: 'DOC7', result: { outputs: { clicked: true } } };
      },
    })).execute({ action: 'click', cancel: { signalled: false }, command: buildCommand('click', { page: '7:DOC7', ref: 'e2' }, ['clicked']) });
    expect(out).toMatchObject({ status: 'error', error: { code: 'selector_not_found',
      message: bridgeElementChangedMessage('e2', '“Delete” in “Dee Delete”', '“Delete” in “Bob Delete”') } });
    // The look at it was all: nothing was read or clicked.
    expect(calls).toEqual(['rebindPageRef(true)']);
  });

  it('writes at the address it read, naming the ref', async () => {
    const calls: unknown[][] = [];
    await run('fill', async (_target, _func, args) => { calls.push([...args]); return { document_id: 'DOC7', result: { outputs: { filled: true } } }; });
    expect(calls).toEqual([['', 'text', read.url, 'e2']]);
  });
});

describe('2026-11-04 — a click by page answers the page its tab then shows, when the server asks', () => {
  const read = { url: 'https://app.hubspot.com/deals', title: 'Deals', role: 'button', label: 'Search', protected: false };
  const landed = { page: '7:DOC9', url: 'https://app.hubspot.com/results', title: 'Results' };
  const click = (expects: string[], pageAfterClick?: BridgeBrowserApi['pageAfterClick']) => {
    const asked: unknown[][] = [];
    const executor = buildActionExecutor(buildBrowser({
      async executeInDocument(_target, func) {
        return func.name === 'describePageElement' ? { document_id: 'DOC7', result: { outputs: read } }
          : { document_id: 'DOC7', result: { outputs: { clicked: true } } };
      },
      ...(pageAfterClick !== undefined ? { pageAfterClick: async (...args: Parameters<NonNullable<BridgeBrowserApi['pageAfterClick']>>) => {
        asked.push(args);
        return pageAfterClick(...args);
      } } : {}),
    }));
    return { asked, out: executor.execute({ action: 'click', cancel: { signalled: false },
      command: buildCommand('click', { page: '7:DOC7', ref: 'e2' }, expects) }) };
  };

  it('a click that loaded a page answers it, by its new handle, from where the click was', async () => {
    // Whether it moved, and nothing else this server did not list (slice J).
    const t = click(['clicked', 'page', 'url', 'title'], async () => ({ moved: true, ...landed }));
    expect(await t.out).toEqual({ status: 'ok', outputs: { clicked: true, ...landed } });
    expect(t.asked[0]!.slice(0, 2)).toEqual([7, { url: read.url, page: '7:DOC7' }]);
  });

  it('an older server, which asks for `clicked` alone, gets `clicked` alone', async () => {
    const t = click(['clicked'], async () => ({ moved: true, ...landed }));
    expect(await t.out).toEqual({ status: 'ok', outputs: { clicked: true } });
    expect(t.asked).toEqual([]);
  });

  it('a page that cannot be answered leaves the click as it was', async () => {
    expect(await click(['clicked', 'page', 'url', 'title'], async () => undefined).out)
      .toEqual({ status: 'ok', outputs: { clicked: true } });
  });
});

/** D-335 slice W — these tests are about other keys: they ask as a server from before slice W does,
 *  without `acted_on`, which slice W's own tests pin. */
const preW = (keys: readonly string[]): string[] => keys.filter((key) => key !== 'acted_on');

describe('D-335 slice J — sending a form, and a CAPTCHA the page shows', () => {
  const read = { url: 'https://app.hubspot.com/login', title: 'Sign in', role: 'text box', label: 'Search', protected: false };
  const landed = { moved: true, page: '7:DOC9', url: 'https://app.hubspot.com/home', title: 'Home' };
  const run = (action: BridgeAction, args: Record<string, unknown>, expects: readonly string[],
    answers: { write?: unknown; challenge?: unknown; sends?: boolean;
      after?: Awaited<ReturnType<NonNullable<BridgeBrowserApi['pageAfterClick']>>> },
    timeout_ms = 30_000) => {
    const calls: Array<{ func: string; args: unknown[] }> = [];
    const prepared: unknown[][] = [];
    const waits: unknown[][] = [];
    const executor = buildActionExecutor(buildBrowser({
      async executeInDocument(_target, func, given) {
        if (func.name === 'describePageElement') return { document_id: 'DOC7', result: { outputs: read } };
        if (func.name === 'rebindPageRef') return { document_id: 'DOC7', result: { kept: true } };
        // Slice K — the messages noted before a click or a send, and whether it sends a form.
        if (func.name === 'prepareStepChecks') {
          prepared.push([...given]);
          return { document_id: 'DOC7', result: { sends: answers.sends ?? false } };
        }
        calls.push({ func: func.name, args: [...given] });
        return { document_id: 'DOC7', result: func.name === 'pageChallenge' ? answers.challenge ?? null : answers.write };
      },
      async pageAfterClick(...given) {
        waits.push(given);
        return answers.after;
      },
    }));
    return { calls, prepared, waits, out: executor.execute({ action, cancel: { signalled: false },
      command: { ...buildCommand(action, { page: '7:DOC7', ref: 'e2', ...args }, [...expects]), timeout_ms } }) };
  };
  const sent = { outputs: { submitted: true } };

  it('sends the form the element is in, and answers the page it lands on', async () => {
    const t = run('submit', {}, preW(BRIDGE_SUBMIT_OUTPUT_KEYS), { write: sent, after: landed });
    expect(await t.out).toEqual({ status: 'ok', outputs: { submitted: true, ...landed } });
    expect(t.calls).toEqual([{ func: 'submitPageForm', args: ['', read.url, 'e2'] }]);
  });

  it('types first, in the same script, when the command carries a value', async () => {
    const t = run('submit', { value: 'cats' }, preW(BRIDGE_SUBMIT_OUTPUT_KEYS), { write: sent, after: landed });
    expect(await t.out).toEqual({ status: 'ok', outputs: { filled: true, submitted: true, ...landed } });
    expect(t.calls).toEqual([{ func: 'fillPageField', args: ['', 'cats', read.url, 'e2', true] }]);
  });

  it('a form the page would not send is a confirmed failure, and nothing is watched', async () => {
    const t = run('submit', {}, preW(BRIDGE_SUBMIT_OUTPUT_KEYS),
      { write: { not_applied: 'The form was not sent: q: Please fill in this field.' }, after: landed });
    expect(await t.out).toEqual({ status: 'error', error: { code: 'value_not_applied',
      message: 'The form was not sent: q: Please fill in this field.', detail: 'e2' } });
    expect(t.waits).toEqual([]);
    // An answer that is not "sent" proves nothing: the page may have sent it.
    expect(await run('submit', {}, preW(BRIDGE_SUBMIT_OUTPUT_KEYS), { write: { outputs: { clicked: true } } }).out)
      .toMatchObject({ status: 'error', error: { code: 'delivery_uncertain' } });
  });

  it('watches for the page to move on as long as the server asks, inside the command\'s budget', async () => {
    const watch = async (watch_ms: unknown, timeout_ms = 30_000) => {
      const t = run('submit', watch_ms === undefined ? {} : { watch_ms }, preW(BRIDGE_SUBMIT_OUTPUT_KEYS),
        { write: sent, after: landed }, timeout_ms);
      await t.out;
      return t.waits[0]![3];
    };
    expect(await watch(undefined)).toEqual({ settleMs: BRIDGE_CLICK_SETTLE_MS, loadMs: BRIDGE_CLICK_LOAD_MAX_MS });
    expect(await watch(5_000)).toEqual({ settleMs: 5_000, loadMs: BRIDGE_CLICK_LOAD_MAX_MS });
    expect(await watch(60_000)).toEqual({ settleMs: BRIDGE_WATCH_MAX_MS, loadMs: BRIDGE_CLICK_LOAD_MAX_MS });
    expect(await watch('5000')).toEqual({ settleMs: BRIDGE_CLICK_SETTLE_MS, loadMs: BRIDGE_CLICK_LOAD_MAX_MS });
    // A command with 8 seconds has 5 to spend after its script: all of it on the watch.
    expect(await watch(10_000, 8_000)).toEqual({ settleMs: 5_000, loadMs: 0 });
  });

  it('asks the page for a CAPTCHA, and passes on what it learns, only when the server lists them', async () => {
    const challenged = { ...landed, challenge: 'reCAPTCHA' };
    const asked = run('click', {}, preW(BRIDGE_CLICK_OUTPUT_KEYS), { write: { outputs: { clicked: true } }, after: challenged });
    expect(await asked.out).toEqual({ status: 'ok', outputs: { clicked: true, ...challenged } });
    // Slice K: a server that lists `problem` has the watch look for error messages too.
    expect(asked.waits[0]![5]).toEqual({ challenge: true, problems: PAGE_MESSAGE_RULES });
    // A server from before slice J: the page, and nothing it did not list.
    const older = run('click', {}, ['clicked', 'page', 'url', 'title'], { write: { outputs: { clicked: true } }, after: challenged });
    expect(await older.out).toEqual({ status: 'ok', outputs: { clicked: true, page: landed.page, url: landed.url, title: landed.title } });
    expect(older.waits[0]![5]).toEqual({ challenge: false });
  });

  it('typing asks the same page for a CAPTCHA once the text is in, when the server lists it', async () => {
    const filled = { outputs: { filled: true } };
    const shown = run('fill', { value: 'me@example.com' }, preW(BRIDGE_FILL_OUTPUT_KEYS), { write: filled, challenge: 'hCaptcha' });
    expect(await shown.out).toEqual({ status: 'ok', outputs: { filled: true, challenge: 'hCaptcha' } });
    expect(shown.calls.map((call) => call.func)).toEqual(['fillPageField', 'pageChallenge']);
    expect(await run('fill', { value: 'x' }, preW(BRIDGE_FILL_OUTPUT_KEYS), { write: filled, challenge: null }).out)
      .toEqual({ status: 'ok', outputs: { filled: true } });
    const older = run('fill', { value: 'x' }, ['filled'], { write: filled, challenge: 'hCaptcha' });
    expect(await older.out).toEqual({ status: 'ok', outputs: { filled: true } });
    expect(older.calls.map((call) => call.func)).toEqual(['fillPageField']);
    expect(older.waits).toEqual([]);
  });
});

describe('D-335 slice K — a click or a send watched for its failure', () => {
  const read = { url: 'https://app.hubspot.com/login', title: 'Sign in', role: 'button', label: 'Sign in', protected: false };
  const landed = { moved: false, page: '7:DOC7', url: read.url, title: 'Sign in' };
  const click = (args: Record<string, unknown>, expects: readonly string[], sends: boolean | { unsent: string },
    after: Awaited<ReturnType<NonNullable<BridgeBrowserApi['pageAfterClick']>>> = landed) => {
    const prepared: unknown[][] = [];
    const waits: unknown[][] = [];
    const executor = buildActionExecutor(buildBrowser({
      async executeInDocument(_target, func, given) {
        if (func.name === 'describePageElement') return { document_id: 'DOC7', result: { outputs: read } };
        if (func.name === 'prepareStepChecks') {
          prepared.push([...given]);
          return { document_id: 'DOC7', result: typeof sends === 'boolean' ? { sends } : { sends: false, ...sends } };
        }
        return { document_id: 'DOC7', result: { outputs: { clicked: true } } };
      },
      async pageAfterClick(...given) {
        waits.push(given);
        return after;
      },
    }));
    return { prepared, waits, out: executor.execute({ action: 'click', cancel: { signalled: false },
      command: buildCommand('click', { page: '7:DOC7', ref: 'e4', ...args }, [...expects]) }) };
  };

  it('notes the page\'s messages before the click, only for a server that asks for problems', async () => {
    const asked = click({}, preW(BRIDGE_CLICK_OUTPUT_KEYS), false);
    await asked.out;
    expect(asked.prepared).toEqual([['', 'e4', PAGE_MESSAGE_RULES]]);
    const older = click({}, ['clicked', 'page', 'url', 'title', 'moved', 'challenge'], false);
    await older.out;
    expect(older.prepared).toEqual([]);
    expect(older.waits[0]![5]).toEqual({ challenge: true });
  });

  it('a click on a form\'s send button is watched as a send, and says it sent the form', async () => {
    const sending = click({ send_watch_ms: 5_000 }, preW(BRIDGE_CLICK_OUTPUT_KEYS), true);
    expect(await sending.out).toEqual({ status: 'ok', outputs: { clicked: true, sent: true, ...landed } });
    expect(sending.waits[0]![3]).toEqual({ settleMs: 5_000, loadMs: BRIDGE_CLICK_LOAD_MAX_MS });
    // A click that sends nothing keeps the usual watch, and says nothing of sending.
    const plain = click({ send_watch_ms: 5_000 }, preW(BRIDGE_CLICK_OUTPUT_KEYS), false);
    expect(await plain.out).toEqual({ status: 'ok', outputs: { clicked: true, ...landed } });
    expect(plain.waits[0]![3]).toEqual({ settleMs: BRIDGE_CLICK_SETTLE_MS, loadMs: BRIDGE_CLICK_LOAD_MAX_MS });
    // The send watch is a floor on the watch asked for, never a cap.
    const longer = click({ send_watch_ms: 5_000, watch_ms: 8_000 }, preW(BRIDGE_CLICK_OUTPUT_KEYS), true);
    await longer.out;
    expect(longer.waits[0]![3]).toEqual({ settleMs: 8_000, loadMs: BRIDGE_CLICK_LOAD_MAX_MS });
  });

  it('a send button on a form the browser will not send answers why, as the problem, and sent nothing', async () => {
    const unsent = 'The form was not sent: email: Please fill out this field.';
    const refused = click({ send_watch_ms: 5_000 }, preW(BRIDGE_CLICK_OUTPUT_KEYS), { unsent },
      { ...landed, problem: 'Something else on the page' });
    expect(await refused.out).toEqual({ status: 'ok', outputs: { clicked: true, ...landed, problem: unsent } });
    expect(refused.waits[0]![3]).toEqual({ settleMs: BRIDGE_CLICK_SETTLE_MS, loadMs: BRIDGE_CLICK_LOAD_MAX_MS });
  });

  it('passes the step\'s failure to the watch, and what the watch saw back', async () => {
    const watched = click({ fail: { selector: '.flash.error', text: 'invalid' } }, preW(BRIDGE_CLICK_OUTPUT_KEYS), false,
      { ...landed, failed: true, problem: 'Your password is invalid!' });
    expect(await watched.out).toEqual({ status: 'ok', outputs: { clicked: true, ...landed, failed: true,
      problem: 'Your password is invalid!' } });
    expect(watched.waits[0]![5]).toEqual({ challenge: true, problems: PAGE_MESSAGE_RULES,
      fail: { selector: '.flash.error', until: 'shown', text: 'invalid' } });
  });

  it.each([{ selector: '' }, { selector: '.e', shows: '.x' }, 'error', { selector: '.e', text: 3 }])(
    'refuses a failure it cannot read (%j) before anything is clicked', async (fail) => {
      const refused = click({ fail }, preW(BRIDGE_CLICK_OUTPUT_KEYS), false);
      expect(await refused.out).toEqual({ status: 'error', error: { code: 'unknown',
        message: 'bridge: fail is { selector, text } naming what means the step failed' } });
      expect(refused.waits).toEqual([]);
    });
});

/** D-335 slice L — `pick`: the page answers each in-page function as scripted, and the clock is
 *  fake, so how long it waits and when it types again a key at a time are exact. */
describe('D-335 slice L — typing into a field that suggests, then picking a suggestion by its text', () => {
  const read = { url: 'https://app.hubspot.com/deals/new', title: 'New deal', role: 'combo box', label: 'Company',
    protected: false };
  const stayed = { moved: false, page: '7:DOC7', url: read.url, title: read.title };
  const found = { found: 'e40', label: 'Acme Corp', url: read.url };
  type After = Awaited<ReturnType<NonNullable<BridgeBrowserApi['pageAfterClick']>>>;
  /** Each call of `findPickOption` and `pickTook` takes the next answer, the last one again after. */
  const pick = async (script: { finds: unknown[]; tooks?: unknown[]; click?: unknown; after?: After;
    movedWhileWaiting?: boolean }, args: Record<string, unknown> = {}) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
    try {
      const calls: Array<{ func: string; args: unknown[]; at: number }> = [];
      const started = Date.now();
      let finds = 0;
      let tooks = 0;
      const next = (list: unknown[], index: number) => list[Math.min(index, list.length - 1)];
      const executor = buildActionExecutor(buildBrowser({
        async executeInDocument(_target, func, given) {
          calls.push({ func: func.name, args: [...given], at: Date.now() - started });
          const answer = (result: unknown) => ({ document_id: 'DOC7', result });
          switch (func.name) {
            case 'rebindPageRef': return answer({ kept: true });
            case 'describePageElement': return answer({ outputs: read });
            case 'notePickLists': return answer({ noted: true });
            case 'fillPageField': return answer({ outputs: { filled: true } });
            case 'findPickOption':
              return script.movedWhileWaiting === true ? { document_id: 'DOC8', result: null } : answer(next(script.finds, finds++));
            case 'typeWithKeys': return answer({ typed: true });
            case 'clickPageElement': return answer(script.click ?? { outputs: { clicked: true } });
            case 'pickTook': return answer(next(script.tooks ?? [{ took: 'hidden' }], tooks++));
            default: return answer(null);
          }
        },
        async pageAfterClick() {
          return script.after ?? stayed;
        },
      }));
      const out = executor.execute({ action: 'pick', cancel: { signalled: false }, command: buildCommand('pick',
        { page: '7:DOC7', ref: 'e2', value: 'Acme', pick: 'Acme Corp', pick_ms: 3_000, ...args }, [...preW(BRIDGE_PICK_OUTPUT_KEYS)]) });
      await vi.advanceTimersByTimeAsync(20_000);
      return { calls, out: await out, named: (name: string) => calls.filter((call) => call.func === name) };
    } finally {
      vi.useRealTimers();
    }
  };

  it('notes the page, types, clicks the suggestion by the ref it was given, and answers what it picked', async () => {
    const t = await pick({ finds: [{ no_list: true }, { no_list: true }, found] });
    expect(t.out).toEqual({ status: 'ok', outputs: { filled: true, picked: 'Acme Corp', ...stayed } });
    expect(t.calls.map((call) => call.func)).toEqual(['rebindPageRef', 'describePageElement', 'notePickLists', 'fillPageField',
      'findPickOption', 'findPickOption', 'findPickOption', 'clickPageElement', 'pickTook']);
    expect(t.named('notePickLists')[0]!.args).toEqual(['', 'e2', PICK_RULES]);
    expect(t.named('fillPageField')[0]!.args).toEqual(['', 'Acme', read.url, 'e2']);
    expect(t.named('findPickOption')[0]!.args).toEqual(['', 'e2', 'Acme Corp', PICK_RULES]);
    expect(t.named('clickPageElement')[0]!.args).toEqual(['', read.url, 'e40']);
    expect(t.named('pickTook')[0]!.args).toEqual(['', 'e2', 'Acme', 'Acme Corp', PICK_RULES]);
  });

  it('types it again a key at a time when no list shows within a second, once', async () => {
    const t = await pick({ finds: [...Array.from({ length: 7 }, () => ({ no_list: true })), found] });
    expect(t.out).toMatchObject({ status: 'ok', outputs: { picked: 'Acme Corp' } });
    const keys = t.named('typeWithKeys');
    expect(keys).toHaveLength(1);
    expect(keys[0]!.args).toEqual(['', 'e2', 'Acme']);
    expect(keys[0]!.at).toBeGreaterThanOrEqual(1_000);
  });

  it('none that matches: the suggestions, once they have stayed the same a while, and nothing clicked', async () => {
    const t = await pick({ finds: [{ none: ['Acme Inc', 'Acme Ltd'] }] });
    expect(t.out).toEqual({ status: 'error', error: { code: 'value_not_applied',
      message: 'None of its suggestions is “Acme Corp”. They were: “Acme Inc”; “Acme Ltd”. Pick one of them by its text.' } });
    expect(t.named('clickPageElement')).toEqual([]);
    // Answered once they had stayed the same for 1.2 seconds, before the 3 the step allows.
    expect(t.named('findPickOption').at(-1)!.at).toBeLessThan(2_000);
    expect(t.named('typeWithKeys')).toEqual([]);
  });

  it('several that match: each of them, and nothing clicked', async () => {
    const t = await pick({ finds: [{ several: ['Acme Corp (Boston)', 'Acme Corp (Austin)'] }] });
    expect(t.out).toEqual({ status: 'error', error: { code: 'value_not_applied', message: 'Several of its suggestions '
      + 'match “Acme Corp”: “Acme Corp (Boston)”; “Acme Corp (Austin)”. Pick one of them by its whole text.' } });
    expect(t.named('clickPageElement')).toEqual([]);
  });

  it('no list at all: says so once the time is up, with the text left in the field', async () => {
    const t = await pick({ finds: [{ no_list: true }] });
    expect(t.out).toEqual({ status: 'error', error: { code: 'value_not_applied', message: 'No suggestions showed '
      + 'within 3 seconds of typing “Acme”, so nothing was picked. The text is in the field.' } });
    expect(t.named('typeWithKeys')).toHaveLength(1);
    expect(t.named('findPickOption').at(-1)!.at).toBeGreaterThanOrEqual(3_000);
  });

  it('a click the field did not take is a failure that says so', async () => {
    const open = await pick({ finds: [found], tooks: [{ open: true }] });
    expect(open.out).toEqual({ status: 'error', error: { code: 'value_not_applied',
      message: '“Acme Corp” was clicked, but its list is still open and nothing shows it was picked.' } });
    // Checked for a while, then given up.
    expect(open.named('pickTook').length).toBeGreaterThan(3);
    const notShown = await pick({ finds: [found], tooks: [{ not_shown: true }] });
    expect(notShown.out).toMatchObject({ status: 'error', error: {
      message: '“Acme Corp” was clicked, but the field does not show it, so it may not have been picked.' } });
    // One that took it a moment later is fine.
    const later = await pick({ finds: [found], tooks: [{ open: true }, { took: 'shown' }] });
    expect(later.out).toMatchObject({ status: 'ok' });
  });

  it('a suggestion that is a link: the page it loaded is the answer, and the field is not checked', async () => {
    const landed = { moved: true, page: '7:DOC9', url: 'https://app.hubspot.com/companies/1', title: 'Acme Corp' };
    const t = await pick({ finds: [found], after: landed });
    expect(t.out).toEqual({ status: 'ok', outputs: { filled: true, picked: 'Acme Corp', ...landed } });
    expect(t.named('pickTook')).toEqual([]);
  });

  it('a click that is refused passes on why, and a page that moves on while it waits ends it', async () => {
    const covered = await pick({ finds: [found], click: { not_applied: 'Something else on the page covers it.' } });
    expect(covered.out).toEqual({ status: 'error', error: { code: 'value_not_applied',
      message: 'Something else on the page covers it.', detail: 'Acme Corp' } });
    const moved = await pick({ finds: [found], movedWhileWaiting: true });
    expect(moved.out).toEqual({ status: 'error', error: { code: 'value_not_applied',
      message: 'The page moved on once “Acme” was typed, before a suggestion was picked.' } });
  });

  it.each([{ pick: '' }, { pick: undefined }, { value: '' }, { page: undefined }])(
    'refuses a pick it cannot make (%j) before anything is typed', async (args) => {
      const t = await pick({ finds: [found] }, args);
      expect(t.out).toMatchObject({ status: 'error', error: { code: 'unknown' } });
      expect(t.named('fillPageField')).toEqual([]);
    });
});

describe('D-148 P3 — screenshot + os_notification', () => {
  it('screenshot returns data_url', async () => {
    const executor = buildActionExecutor(buildBrowser());
    const out = await executor.execute({
      command: buildCommand('screenshot', {}, ['data_url']),
      action: 'screenshot',
      cancel: { signalled: false },
    });
    expect(out.status).toBe('ok');
    expect(out.outputs?.data_url).toContain('data:image/png');
  });

  it('F1 — screenshot threads the matched tab id + window + domain pattern to captureVisibleTab', async () => {
    let captured: { tab_id: number; window_id: number; url_pattern: string } | undefined;
    const executor = buildActionExecutor(
      buildBrowser({
        async findTabByUrlPattern() {
          return { tab_id: 7, url: 'https://app.hubspot.com/x', window_id: 42 };
        },
        async captureVisibleTab(args) {
          captured = args;
          return 'data:image/png;base64,FAKE';
        },
      }),
    );
    const out = await executor.execute({
      command: buildCommand('screenshot', {}, ['data_url']),
      action: 'screenshot',
      cancel: { signalled: false },
    });
    expect(out.status).toBe('ok');
    // The shim needs all three to confine the capture to the matched tab.
    expect(captured).toEqual({ tab_id: 7, window_id: 42, url_pattern: '*://app.hubspot.com/*' });
  });

  it('F1 — screenshot fails closed when the matched tab cannot be confirmed (null capture)', async () => {
    const executor = buildActionExecutor(
      buildBrowser({
        async findTabByUrlPattern() {
          return { tab_id: 7, url: 'https://app.hubspot.com/x', window_id: 42 };
        },
        // Shim returns null when the matched tab isn't the confirmed active tab
        // — the executor must NOT emit a screenshot (no other tab's pixels leak).
        async captureVisibleTab() {
          return null;
        },
      }),
    );
    const out = await executor.execute({
      command: buildCommand('screenshot', {}, ['data_url']),
      action: 'screenshot',
      cancel: { signalled: false },
    });
    expect(out.status).toBe('error');
    expect(out.error?.code).toBe('tab_navigation_blocked');
  });

  it('os_notification dispatches via showNotification', async () => {
    let captured: Record<string, unknown> | null = null;
    const executor = buildActionExecutor(
      buildBrowser({
        async showNotification(id, opts) {
          captured = { id, opts };
          return id;
        },
      }),
    );
    const out = await executor.execute({
      command: buildCommand('os_notification', { title: 'X', body: 'Y' }, ['notification_id']),
      action: 'os_notification',
      cancel: { signalled: false },
    });
    expect(out.status).toBe('ok');
    expect(captured).not.toBeNull();
  });
});

describe('D-148 P3 — output-key validation', () => {
  it('accepts outputs that match expects_output_keys', async () => {
    const executor = buildActionExecutor(
      buildBrowser({ async executeScript() { return { outputs: { text: 'value' } }; } }),
    );
    const out = await executor.execute({
      command: buildCommand('read_dom', { selector: '#x' }, ['text']),
      action: 'read_dom',
      cancel: { signalled: false },
    });
    expect(out.status).toBe('ok');
    expect(out.outputs?.text).toBe('value');
  });

  it('Codex P3 #7 fold — empty expects_output_keys rejects outputs', async () => {
    const executor = buildActionExecutor(
      buildBrowser({ async executeScript() { return { outputs: { text: 'value' } }; } }),
    );
    const out = await executor.execute({
      command: buildCommand('read_dom', { selector: '#x' }, []), // explicit empty
      action: 'read_dom',
      cancel: { signalled: false },
    });
    expect(out.status).toBe('error');
    expect(out.error?.code).toBe('unknown');
  });

  it('cooperative cancel before execution returns cancelled', async () => {
    const executor = buildActionExecutor(buildBrowser());
    const out = await executor.execute({
      command: buildCommand('read_dom', { selector: '#x' }),
      action: 'read_dom',
      cancel: { signalled: true },
    });
    expect(out.status).toBe('cancelled');
  });
});

// ── D-261 F32 follow-on — the owner client is not a screenshot target ────────
//
// The four INJECTED actions (read_dom / click / fill / extract_table) each carry
// the `data-recued-owner-surface` fence inside the injected function. `screenshot`
// reads PIXELS through `captureVisibleTab` and runs no script, so it inherited
// nothing — and a recipe with DOM capability whose `target_domain_pattern`
// matched the webclient could photograph a pending review: the message body, the
// attachments, the approval buttons. "It only reads" is not mitigation for a
// capture; reading is the attack.
describe('owner-client capture fence', () => {
  const ownerTab = (probe: () => unknown): BridgeBrowserApi =>
    buildBrowser({
      async findTabByUrlPattern() {
        return { tab_id: 7, url: 'https://app.recued.com/#approvals', window_id: 1 };
      },
      async executeScript() { return probe(); },
    });
  const shoot = (api: BridgeBrowserApi) =>
    buildActionExecutor(api).execute({
      command: buildCommand('screenshot', {}, ['data_url']),
      action: 'screenshot',
      cancel: { signalled: false },
    });

  it('refuses to capture a document carrying the owner marker', async () => {
    const out = await shoot(ownerTab(() => true));
    expect(out.status).toBe('error');
    expect(out.error?.code).toBe('tab_navigation_blocked');
    expect(out.outputs?.data_url).toBeUndefined();
  });

  it('still captures an ordinary page', async () => {
    const out = await shoot(ownerTab(() => false));
    expect(out.status).toBe('ok');
    expect(out.outputs?.data_url).toBe('data:image/png;base64,FAKE');
  });

  /** A refused injection cannot PROVE the tab is not the owner surface, and a
   *  page too restricted to inject into is generally too restricted to capture. */
  it('refuses when the probe itself is blocked', async () => {
    const out = await shoot(ownerTab(() => { throw new Error('cannot access page'); }));
    expect(out.status).toBe('error');
    expect(out.error?.code).toBe('tab_navigation_blocked');
  });

  /** ⚠ NOT an attack surface: the probe runs in an isolated world, so a hostile
   *  page cannot force a non-boolean. Treat a shim anomaly as "not the owner"
   *  rather than breaking every ordinary capture. */
  it('treats a non-boolean probe result as an ordinary page', async () => {
    const out = await shoot(ownerTab(() => null));
    expect(out.status).toBe('ok');
  });

  it('fences wait_for_selector too — presence still answers questions about the owner client', async () => {
    const executor = buildActionExecutor(buildBrowser({
      async executeScript(_tab, fn) {
        // Drive the REAL injected function against a marked document, the way
        // Chrome would — a fake that just returns a value proves nothing.
        const documentStub = {
          documentElement: { hasAttribute: (name: string) => name === 'data-recued-owner-surface' },
          querySelector: () => ({}),
        };
        const prior = (globalThis as { document?: unknown }).document;
        (globalThis as { document?: unknown }).document = documentStub;
        try { return (fn as (s: string) => unknown)('#anything'); }
        finally { (globalThis as { document?: unknown }).document = prior; }
      },
    }));
    await expect(executor.execute({
      command: buildCommand('wait_for_selector', { selector: '#anything' }),
      action: 'wait_for_selector',
      cancel: { signalled: false },
    })).rejects.toThrow('The owner client cannot be automated.');
  });
});

// D-335 slice G — the owner's list of sites Recued must never use. Every path
// that reaches a page checks it before anything is read or done there.
describe('the owner\'s list of blocked sites', () => {
  const LISTED = { status: 'error', error: { code: 'tab_navigation_blocked',
    message: 'The owner listed this site as one Recued must never use, so nothing was read or done there.' } };
  const UNREADABLE = { status: 'error', error: { code: 'tab_navigation_blocked',
    message: 'The Browser Bridge could not read the owner\'s list of sites Recued must never use, so it did nothing.' } };
  /** A browser on app.hubspot.com whose every page action is recorded. */
  const browser = (blocked: () => Promise<readonly string[]>, overrides: Partial<BridgeBrowserApi> = {}) => {
    const touched: string[] = [];
    const api = buildBrowser({
      blockedSites: blocked,
      async tabUrl() { touched.push('tabUrl'); return 'https://app.hubspot.com/deals/7'; },
      async executeScript() { touched.push('executeScript'); return { outputs: { text: 'read', clicked: true, filled: true } }; },
      async executeInDocument() { touched.push('executeInDocument'); return { document_id: 'DOC7', result: { outputs: { url: 'https://app.hubspot.com/deals/7', title: 'Deals', html: '<p>x</p>', truncated: false } } }; },
      async executeReviewedDocument() { touched.push('executeReviewedDocument'); return { status: 'ok', outputs: { filled: true } }; },
      async listPages(_pattern, isBlocked) {
        touched.push('listPages');
        const all = [{ page: '7:DOC7', url: 'https://app.hubspot.com/deals/7', title: 'Deals' },
          { page: '8:DOC8', url: 'https://mail.example.com/', title: 'Mail' }];
        return { tabs: all.filter(tab => !isBlocked?.(tab.url)), truncated: false };
      },
      async openPage(url, _pattern, _wait, isBlocked) {
        touched.push(`openPage ${isBlocked?.('https://www.hubspot.com/x') ? 'closes' : 'keeps'} a listed landing`);
        return { status: 'ok', outputs: { page: '9:DOC9', url, title: 'Opened' } };
      },
      async captureVisibleTab() { touched.push('captureVisibleTab'); return 'data:image/png;base64,FAKE'; },
      ...overrides,
    });
    return { executor: buildActionExecutor(api), touched };
  };
  const run = (executor: ReturnType<typeof buildActionExecutor>, action: BridgeAction, args: Record<string, unknown>,
    expects: string[] = [], extra: Partial<BridgeCommand> = {}) =>
    executor.execute({ action, cancel: { signalled: false }, command: { ...buildCommand(action, args, expects), ...extra } });
  const listed = async () => ['hubspot.com'];

  it.each([
    ['read_dom', { selector: '#title' }],
    ['click', { selector: '#send' }],
    ['fill', { selector: '#to', value: 'x' }],
    ['wait_for_selector', { selector: '#x' }],
    ['extract_table', { selector: 'table' }],
    ['screenshot', {}],
    ['inspect', {}],
  ] as const)('%s on the matched tab of a listed site: refused, nothing read or done', async (action, args) => {
    const { executor, touched } = browser(listed);
    expect(await run(executor, action, args)).toEqual(LISTED);
    expect(touched).toEqual([]);
  });

  it.each([
    ['inspect', { page: '7:DOC7' }],
    ['describe', { page: '7:DOC7', ref: 'e2' }],
    ['fill', { page: '7:DOC7', ref: 'e2', value: 'x' }],
    ['click', { page: '7:DOC7', ref: 'e2' }],
  ] as const)('%s by page on a listed site: its tab\'s address is read, nothing else', async (action, args) => {
    const { executor, touched } = browser(listed);
    expect(await run(executor, action, args)).toEqual(LISTED);
    expect(touched).toEqual(['tabUrl']);
  });

  it('by page, a tab that has gone is the page gone, and nothing is read', async () => {
    const { executor, touched } = browser(listed, { async tabUrl() { return null; } });
    expect(await run(executor, 'inspect', { page: '7:DOC7' })).toMatchObject({ error: { code: 'selector_not_found',
      message: expect.stringContaining('list the tabs for its current page handle') } });
    expect(touched).toEqual([]);
  });

  it('a reviewed document on a listed site: refused before the reviewed executor runs', async () => {
    const { executor, touched } = browser(listed);
    expect(await run(executor, 'fill', { selector: '#to', value: 'x' }, ['filled'],
      { reviewed_document: { tab_id: 7, document_id: 'DOC7', url: 'https://app.hubspot.com/deals/7' } })).toEqual(LISTED);
    expect(touched).toEqual([]);
  });

  it('list_tabs leaves a listed site out; open_tab refuses a listed address before any tab exists', async () => {
    const { executor, touched } = browser(async () => ['example.com', 'hubspot.com']);
    expect(await run(executor, 'list_tabs', {}, ['tabs', 'truncated'])).toEqual({ status: 'ok', outputs: { tabs: [], truncated: false } });
    expect(await run(executor, 'open_tab', { url: 'https://app.hubspot.com/x' }, ['page', 'url', 'title'])).toEqual(LISTED);
    expect(touched).toEqual(['listPages']);
  });

  it('open_tab on an address off the list hands the list on, so a listed landing is closed', async () => {
    const { executor, touched } = browser(listed);
    expect(await run(executor, 'open_tab', { url: 'https://other.example/x' }, ['page', 'url', 'title']))
      .toMatchObject({ status: 'ok' });
    expect(touched).toEqual(['openPage closes a listed landing']);
  });

  it('a site off the list, and no list at all, run as before; with no list, no tab address is read', async () => {
    const elsewhere = browser(async () => ['example.com']);
    expect(await run(elsewhere.executor, 'inspect', { page: '7:DOC7' }, ['page', 'url', 'title', 'html', 'truncated']))
      .toMatchObject({ status: 'ok' });
    expect(elsewhere.touched).toEqual(['tabUrl', 'executeInDocument']);
    const none = browser(async () => []);
    expect(await run(none.executor, 'inspect', { page: '7:DOC7' }, ['page', 'url', 'title', 'html', 'truncated']))
      .toMatchObject({ status: 'ok' });
    expect(none.touched).toEqual(['executeInDocument']);
  });

  it('a list that cannot be read refuses every page, and a notification still goes', async () => {
    const { executor, touched } = browser(async () => { throw new Error('corrupt'); });
    for (const [action, args, expects] of [['read_dom', { selector: '#t' }, ['text']], ['inspect', { page: '7:DOC7' }, []],
      ['list_tabs', {}, ['tabs', 'truncated']], ['open_tab', { url: 'https://other.example/' }, []]] as const) {
      expect(await run(executor, action, args, [...expects])).toEqual(UNREADABLE);
    }
    expect(touched).toEqual([]);
    expect(await run(executor, 'os_notification', { title: 'T', body: 'B' }, ['notification_id'])).toMatchObject({ status: 'ok' });
  });
});

// D-335 slice R — a frame from another site, which no script in the page can read, named as a page
// of its own: the frame of the tab's top page at its address, else on its site, each taken once.
describe('frames from another site, named as pages of their own', () => {
  const frame = (document_id: string, url: string, in_top = true): PageFrame =>
    ({ frame_id: Number(document_id.replace(/\D/g, '')) || 1, document_id, url, in_top });
  const NAMED = (n: number, src?: string) => `<iframe${src ? ` src="${src}"` : ''} title="T${String(n)}" data-recued-frame="${String(n)}"></iframe>`;

  it('gives each the handle of the frame at its address, then on its site, in the page\'s order', () => {
    const html = `<p>x</p>${NAMED(1, 'https://ads.example/a')}${NAMED(2, 'https://forms.example/f?id=1')}${NAMED(3, 'https://ads.example/b')}`;
    const frames = [frame('DOC3', 'https://ads.example/b'), frame('DOC2', 'https://forms.example/f?id=1&loaded=1'),
      frame('DOC1', 'https://ads.example/a')];
    expect(settleFrames(html, 7, frames, () => false)).toBe('<p>x</p>'
      + '<iframe src="https://ads.example/a" title="T1" page="7:DOC1"></iframe>'
      // Not at its address any more, but on its site.
      + '<iframe src="https://forms.example/f?id=1" title="T2" page="7:DOC2"></iframe>'
      + '<iframe src="https://ads.example/b" title="T3" page="7:DOC3"></iframe>');
  });

  it('one it cannot match, on a listed site, in a frame of a frame, or where frames are not looked for, is unread', () => {
    const html = `${NAMED(1, 'https://pay.example/card')}${NAMED(2, 'https://blocked.example/x')}${NAMED(3, 'https://deep.example/y')}${NAMED(4)}`;
    const frames = [frame('DOC2', 'https://blocked.example/x'), frame('DOC3', 'https://deep.example/y', false)];
    const settled = settleFrames(html, 7, frames, url => url.includes('blocked.example'));
    expect(settled.match(/ unread=""/g)).toHaveLength(4);
    expect(settled).not.toContain(' page="');
    expect(settleFrames(NAMED(1, 'https://ads.example/a'), 7, null, () => false))
      .toBe('<iframe src="https://ads.example/a" title="T1" unread=""></iframe>');
    expect(settleFrames('<p>no frames</p>', 7, [], () => false)).toBe('<p>no frames</p>');
  });

  it('an inspection of a tab\'s top page names its frames; one of a frame leaves its own unread', async () => {
    const read = { url: 'https://app.hubspot.com/deals/7', title: 'Deals', truncated: false,
      html: `<p>x</p>${NAMED(1, 'https://forms.example/f')}` };
    const listFrames = vi.fn(async () => [frame('DOC9', 'https://forms.example/f')]);
    const top = buildActionExecutor(buildBrowser({ listFrames,
      async executeInDocument() { return { document_id: 'DOC7', frame_id: 0, result: { outputs: { ...read } } }; } }));
    const keys = ['page', 'url', 'title', 'html', 'truncated'];
    expect(await top.execute({ action: 'inspect', cancel: { signalled: false }, command: buildCommand('inspect', { page: '7:DOC7' }, keys) }))
      .toMatchObject({ status: 'ok', outputs: { html: '<p>x</p><iframe src="https://forms.example/f" title="T1" page="7:DOC9"></iframe>' } });
    const inFrame = buildActionExecutor(buildBrowser({ listFrames,
      async executeInDocument() { return { document_id: 'DOC8', frame_id: 3, result: { outputs: { ...read } } }; } }));
    expect(await inFrame.execute({ action: 'inspect', cancel: { signalled: false }, command: buildCommand('inspect', { page: '7:DOC8' }, keys) }))
      .toMatchObject({ status: 'ok', outputs: { html: '<p>x</p><iframe src="https://forms.example/f" title="T1" unread=""></iframe>' } });
    expect(listFrames).toHaveBeenCalledTimes(1);
    // Frames that did not answer in time: the read is answered, its frames unread.
    const late = buildActionExecutor(buildBrowser({ async listFrames() { throw new Error('the frames did not answer in time'); },
      async executeInDocument() { return { document_id: 'DOC7', frame_id: 0, result: { outputs: { ...read } } }; } }));
    expect(await late.execute({ action: 'inspect', cancel: { signalled: false }, command: buildCommand('inspect', { page: '7:DOC7' }, keys) }))
      .toMatchObject({ status: 'ok', outputs: { html: '<p>x</p><iframe src="https://forms.example/f" title="T1" unread=""></iframe>' } });
  });

  it('asks each frame only where it is, as soon as it can answer, and waits at most PAGE_FRAMES_WAIT_MS', async () => {
    const asked: Array<Parameters<DocumentScripting['executeScript']>[0]> = [];
    const scripting: DocumentScripting = {
      async executeScript(options) {
        asked.push(options);
        return [{ frameId: 0, documentId: 'TOP', result: { url: 'https://app.example/', in_top: false, owner: false } },
          { frameId: 4, documentId: 'DOC4', result: { url: 'https://forms.example/f', in_top: true, owner: false } },
          // The owner's client, and a frame that could not answer.
          { frameId: 5, documentId: 'DOC5', result: { url: 'https://app.recued.com/', in_top: true, owner: true } },
          { frameId: 6, documentId: 'DOC6', result: undefined }];
      },
    };
    expect(await listChromeFrames(scripting)(7)).toEqual([{ frame_id: 4, document_id: 'DOC4', url: 'https://forms.example/f', in_top: true }]);
    expect(asked).toMatchObject([{ target: { tabId: 7, allFrames: true }, func: describePageFrame, injectImmediately: true }]);
    // A frame on a site the owner listed answers too, so it answers nothing it holds: not its title.
    const top = {};
    vi.stubGlobal('location', { href: 'https://blocked.example/inbox' });
    vi.stubGlobal('window', { parent: top, top });
    vi.stubGlobal('document', { title: 'Inbox (3) — private', documentElement: { hasAttribute: () => false } });
    try {
      expect(describePageFrame()).toEqual({ url: 'https://blocked.example/inbox', in_top: true, owner: false });
    } finally {
      vi.unstubAllGlobals();
    }
    vi.useFakeTimers();
    try {
      const hung = listChromeFrames({ executeScript: () => new Promise(() => undefined) })(7);
      const refused = expect(hung).rejects.toThrow('the frames did not answer in time');
      await vi.advanceTimersByTimeAsync(PAGE_FRAMES_WAIT_MS);
      await refused;
    } finally {
      vi.useRealTimers();
    }
  });

  it('a click by a frame\'s handle is watched in that frame; one by a tab\'s page, in the tab', async () => {
    const watched: Array<{ url: string; page?: string; frame_id?: number }> = [];
    const clickIn = (frame_id: number) => buildActionExecutor(buildBrowser({
      async executeInDocument(_target, func) {
        return func.name === 'describePageElement'
          ? { document_id: 'DOC8', frame_id, result: { outputs: { url: 'https://forms.example/f', title: 'Form', role: 'button',
            label: 'Send', protected: false } } }
          : { document_id: 'DOC8', frame_id, result: { outputs: { clicked: true } } };
      },
      async pageAfterClick(_tab, before) {
        watched.push(before);
        return { moved: false, page: '7:DOC8', url: 'https://forms.example/f', title: 'Form' };
      },
    })).execute({ action: 'click', cancel: { signalled: false },
      command: { ...buildCommand('click', { page: '7:DOC8', ref: 'e2' }, ['clicked', 'page', 'url', 'title']),
        target_domain_pattern: '*://*/*' } });
    expect(await clickIn(5)).toMatchObject({ status: 'ok', outputs: { clicked: true, page: '7:DOC8' } });
    expect(await clickIn(0)).toMatchObject({ status: 'ok' });
    expect(watched).toEqual([{ url: 'https://forms.example/f', page: '7:DOC8', frame_id: 5 },
      { url: 'https://forms.example/f', page: '7:DOC8' }]);
  });

  it('a frame\'s handle is on its own site: on a listed one, nothing it read is answered and nothing is typed or clicked there', async () => {
    const touched: string[] = [];
    const executor = buildActionExecutor(buildBrowser({
      blockedSites: async () => ['blocked.example'],
      // The tab's page is on a site off the list; the frame the handle names is on it.
      async tabUrl() { return 'https://app.hubspot.com/deals/7'; },
      async executeInDocument(_target, func) {
        touched.push(func.name);
        return func.name === 'describePageElement'
          ? { document_id: 'DOC8', result: { outputs: { url: 'https://blocked.example/form', title: 'Form', role: 'button', label: 'Send', protected: false } } }
          : { document_id: 'DOC8', result: { outputs: { url: 'https://blocked.example/form', title: 'Form', html: '<p>secret</p>', truncated: false } } };
      },
    }));
    const LISTED = { status: 'error', error: { code: 'tab_navigation_blocked',
      message: 'The owner listed this site as one Recued must never use, so nothing was read or done there.' } };
    // Every site, as the toolkit's grant is: the owner's list is what refuses.
    const anywhere = (command: BridgeCommand): BridgeCommand => ({ ...command, target_domain_pattern: '*://*/*' });
    expect(await executor.execute({ action: 'inspect', cancel: { signalled: false },
      command: anywhere(buildCommand('inspect', { page: '7:DOC8' }, ['page', 'url', 'title', 'html', 'truncated'])) })).toEqual(LISTED);
    expect(await executor.execute({ action: 'click', cancel: { signalled: false },
      command: anywhere(buildCommand('click', { page: '7:DOC8', ref: 'e2' }, ['clicked'])) })).toEqual(LISTED);
    expect(await executor.execute({ action: 'fill', cancel: { signalled: false },
      command: anywhere(buildCommand('fill', { page: '7:DOC8', ref: 'e2', value: 'x' }, ['filled'])) })).toEqual(LISTED);
    // Read, described, and never the click or the typing.
    expect(touched.filter(name => name === 'clickPageElement' || name === 'fillPageField')).toEqual([]);
  });
});

// D-335 slice T — the server's read after an action keeps the refs of elements the page removed.
describe('reread: an inspection that keeps the refs a page lost', () => {
  it('runs the inspection with how many gone refs to keep; inspect keeps none, as before', async () => {
    const seen: Array<[string, unknown[]]> = [];
    const executor = buildActionExecutor(buildBrowser({
      async executeInDocument(_target, func, args) {
        seen.push([func.name, [...args]]);
        return { document_id: 'DOC7', frame_id: 0, result: { outputs: { url: 'https://app.hubspot.com/deals/7', title: 'Deals',
          html: '<p>x</p>', truncated: false } } };
      },
    }));
    const keys = ['page', 'url', 'title', 'html', 'truncated'];
    for (const action of ['reread', 'inspect'] as const) {
      const outcome = await executor.execute({ action, cancel: { signalled: false }, command: buildCommand(action, { page: '7:DOC7' }, keys) });
      expect(outcome, `${action}: ${JSON.stringify(outcome.error)}`).toMatchObject({ status: 'ok', outputs: { page: '7:DOC7', html: '<p>x</p>' } });
    }
    expect(seen.filter(([name]) => name === 'inspectPage').map(([, args]) => args.slice(2)))
      .toEqual([[null, PAGE_REREAD_KEPT_GONE], []]);
  });
});


// D-335 slice U — a key pressed in the element a page handle names, read before it is pressed.
describe('press: a key in an element, as a click is sent', () => {
  const read = { url: 'https://app.hubspot.com/deals/7', title: 'Deals', role: 'text box', label: 'Message', protected: false };
  const pressing = (answer: Record<string, unknown>) => {
    const seen: Array<[string, unknown[]]> = [];
    const executor = buildActionExecutor(buildBrowser({
      async executeInDocument(_target, func, args) {
        seen.push([func.name, [...args]]);
        return func.name === 'describePageElement' ? { document_id: 'DOC7', result: { outputs: read } }
          : { document_id: 'DOC7', result: answer };
      },
    }));
    const press = (key: unknown, expects = ['pressed', 'sent']) => executor.execute({ action: 'press', cancel: { signalled: false },
      command: buildCommand('press', { page: '7:DOC7', ref: 'e3', key }, expects) });
    return { seen, press };
  };

  it('reads the element, then presses the key as read, and answers it with whether Enter sent a form', async () => {
    const t = pressing({ outputs: { pressed: 'Control+Enter', sent: true } });
    expect(await t.press('ctrl+enter')).toEqual({ status: 'ok', outputs: { pressed: 'Control+Enter', sent: true } });
    // Slice M's look for the ref first, then the element read, then the key.
    expect(t.seen.map(([name]) => name)).toEqual(['rebindPageRef', 'describePageElement', 'pressPageKey']);
    expect(t.seen[2]![1]).toEqual(['', read.url, 'e3', expect.objectContaining({ name: 'Control+Enter', key: 'Enter', ctrlKey: true })]);
  });

  it('a key it does not know is refused before the page is touched', async () => {
    const t = pressing({ outputs: { pressed: 'x' } });
    expect(await t.press('Hyper+a')).toMatchObject({ status: 'error', error: { code: 'unknown' } });
    expect(t.seen).toEqual([]);
  });

  it('a press that was not applied says why; an answer it cannot read is uncertain, not done', async () => {
    expect(await pressing({ not_applied: 'It is disabled, so no key was pressed in it.' }).press('Enter'))
      .toEqual({ status: 'error', error: { code: 'value_not_applied', message: 'It is disabled, so no key was pressed in it.', detail: 'e3' } });
    expect(await pressing({ outputs: { pressed: 'Enter', clicked: true } }).press('Enter'))
      .toMatchObject({ status: 'error', error: { code: 'delivery_uncertain' } });
  });
});

// D-335 slice W — the element acted on, for a server that keeps the turn's steps: read by the
// probe before anything is typed or clicked, with what finds it again another day.
describe('acted_on: the element an action was on, for a server that asks', () => {
  const read = { url: 'https://app.hubspot.com/deals/new', title: 'New deal', role: 'text box', label: 'Deal name',
    protected: false };
  const acting = (stable: string | undefined) => {
    const seen: Array<[string, unknown[]]> = [];
    const executor = buildActionExecutor(buildBrowser({
      async executeInDocument(_target, func, args) {
        seen.push([func.name, [...args]]);
        if (func.name === 'describePageElement') {
          // The probe works the selector out only when it is handed the rules.
          const rules = args[2];
          return { document_id: 'DOC7', result: { outputs: { ...read, ...(rules != null && stable !== undefined
            ? { stable_selector: stable } : {}) } } };
        }
        return { document_id: 'DOC7', result: func.name === 'fillPageField' ? { outputs: { filled: true } }
          : { outputs: { clicked: true } } };
      },
    }));
    const run = (action: 'fill' | 'click', expects: readonly string[]) => executor.execute({ action, cancel: { signalled: false },
      command: buildCommand(action, { page: '7:DOC7', ref: 'e3', ...(action === 'fill' ? { value: 'recued-notes' } : {}) }, [...expects]) });
    return { seen, run };
  };

  it('typing answers the page, how the field is named, and its selector, asked with the picker\'s rules', async () => {
    const t = acting('#deal-name-input');
    expect(await t.run('fill', BRIDGE_FILL_OUTPUT_KEYS)).toEqual({ status: 'ok', outputs: { filled: true,
      acted_on: { ...read, selector: '#deal-name-input' } } });
    expect(t.seen.find(([name]) => name === 'describePageElement')![1]).toEqual([{ ref: 'e3' }, null, SELECTOR_RULES]);
  });

  it('with no selector that finds it alone, the rest still; a server that does not ask gets none, and passes no rules', async () => {
    expect(await acting(undefined).run('click', ['clicked', 'acted_on'])).toEqual({ status: 'ok', outputs: { clicked: true,
      acted_on: read } });
    const older = acting('#deal-name-input');
    expect(await older.run('click', ['clicked'])).toEqual({ status: 'ok', outputs: { clicked: true } });
    expect(older.seen.find(([name]) => name === 'describePageElement')![1]).toEqual([{ ref: 'e3' }, null, null]);
  });
});

// D-335 slice X — a tab's own navigation, closing it, and pointing at an element, by page handle.
describe('a tab moved, closed or pointed at, by its page handle', () => {
  const moves = () => {
    const calls: unknown[][] = [];
    const executor = buildActionExecutor(buildBrowser({
      async movePage(...args) { calls.push(['move', ...args.slice(0, 3)]); return { status: 'ok', outputs: { page: '7:DOC8', url: 'https://app.hubspot.com/deals/8', title: 'Deal' } }; },
      async closePage(tab_id) { calls.push(['close', tab_id]); return { status: 'ok', outputs: { closed: true } }; },
      async tabUrl() { return 'https://app.hubspot.com/deals/7'; },
      async blockedSites() { return ['listed.example']; },
    }));
    const run = (action: BridgeAction, args: Record<string, unknown>) => executor.execute({ action, cancel: { signalled: false },
      command: buildCommand(action, args, ['page', 'url', 'title', 'closed']) });
    return { calls, run };
  };

  it('goes to an address, back, reloads and closes the tab the handle names', async () => {
    const t = moves();
    expect(await t.run('navigate', { page: '7:DOC7', url: 'https://app.hubspot.com/deals/8' })).toMatchObject({ status: 'ok' });
    await t.run('go_back', { page: '7:DOC7' });
    await t.run('reload_page', { page: '7:DOC7' });
    expect(await t.run('close_tab', { page: '7:DOC7' })).toEqual({ status: 'ok', outputs: { closed: true } });
    expect(t.calls).toEqual([
      ['move', 7, { to: 'address', url: 'https://app.hubspot.com/deals/8' }, '*://app.hubspot.com/*'],
      ['move', 7, { to: 'back' }, '*://app.hubspot.com/*'],
      ['move', 7, { to: 'reload' }, '*://app.hubspot.com/*'],
      ['close', 7],
    ]);
  });

  it('refuses an address on the owner\'s list, and a command with no handle, before the tab moves', async () => {
    const t = moves();
    expect(await t.run('navigate', { page: '7:DOC7', url: 'https://www.listed.example/inbox' }))
      .toMatchObject({ status: 'error', error: { code: 'tab_navigation_blocked' } });
    expect(await t.run('go_back', {})).toMatchObject({ status: 'error', error: { code: 'unknown' } });
    expect(await t.run('navigate', { page: '7:DOC7' })).toEqual({ status: 'error',
      error: { code: 'unknown', message: 'bridge: navigate requires a url argument' } });
    expect(t.calls).toEqual([]);
  });

  it('points at an element: read first, then the pointer at the address just read', async () => {
    const read = { url: 'https://app.hubspot.com/deals/7', title: 'Deals', role: 'link', label: 'Products', protected: false };
    const seen: Array<[string, unknown[]]> = [];
    const pointing = (answer: Record<string, unknown>) => buildActionExecutor(buildBrowser({
      async executeInDocument(_target, func, args) {
        seen.push([func.name, [...args]]);
        return func.name === 'describePageElement' ? { document_id: 'DOC7', result: { outputs: read } }
          : { document_id: 'DOC7', result: answer };
      },
    }));
    const hover = (answer: Record<string, unknown>) => pointing(answer).execute({ action: 'hover', cancel: { signalled: false },
      command: buildCommand('hover', { page: '7:DOC7', selector: 'nav li.products' }, ['hovered', 'page', 'url', 'title']) });
    expect(await hover({ hovered: true })).toEqual({ status: 'ok',
      outputs: { hovered: true, page: '7:DOC7', url: read.url, title: 'Deals' } });
    expect(seen.map(([name]) => name)).toEqual(['describePageElement', 'hoverPageElement']);
    expect(seen[1]![1]).toEqual(['nav li.products', read.url, null]);
    expect(await hover({ missing: true })).toMatchObject({ status: 'error', error: { code: 'selector_not_found' } });
    expect(await hover({ blocked: true })).toMatchObject({ status: 'error', error: { code: 'tab_navigation_blocked' } });
  });
});
