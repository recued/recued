import { afterEach, describe, expect, it, vi } from 'vitest';
import { bridgeElementChangedMessage, type BridgeCommand } from '@recued/contracts';
import { buildActionExecutor, type BridgeBrowserApi } from '../actions/executor.js';
import { rebindPageRef } from '../actions/page-rebind.js';
import { describePageElement, PAGE_GONE } from '../actions/page-inspect.js';
import { clickPageElement } from '../actions/page-fields.js';

afterEach(() => vi.unstubAllGlobals());
type Fault = 'none' | 'lost' | 'thrown' | 'foreign' | 'empty' | 'mixed' | 'false-kept';
type Mode = 'initial' | 'retry' | 'success' | 'rebound' | 'recovery' | 'read-lost' | 'stale' | 'missing';

// Real guard, description and click functions with DOM/fingerprint adapters.
// Transport failures are injected after the real identity guard has answered.
const run = async (mode: Mode, fault: Fault = 'none') => {
  const url = 'https://example.com/form';
  const clicks: string[] = []; const guards: Array<{ act: unknown; result: unknown }> = [];
  let attempts = 0; let descriptions = 0;
  const control = () => ({
    row: 'Alpha', isConnected: true, localName: 'button', id: 'save', parentElement: null, innerText: 'Save', textContent: 'Save',
    get ownerDocument(): object { return doc; }, getRootNode(): object { return doc; },
    getAttribute: (name: string) => name === 'aria-label' ? 'Save' : null,
    hasAttribute: () => false, checkVisibility: () => true, matches: () => false, closest: () => null,
    getBoundingClientRect: () => ({ width: 0, height: 0 }),
    click() { clicks.push(this.row); },
  });
  const original = control(); let shown = [original];
  const doc = Object.assign(new EventTarget(), { title: 'Form', documentElement: { hasAttribute: () => false },
    defaultView: { getComputedStyle: () => ({ getPropertyValue: () => '' }) },
    querySelectorAll: (selector: string) => selector === 'button' ? shown : [],
    querySelector: () => shown[0] ?? null, getElementById: () => null });
  const print = (element: typeof original) => ({ tag: 'button', type: 'button', role: 'button', label: 'Save',
    text: 'Save', row: element.row.toLowerCase(), shows: 'Save', in: element.row });
  const refs = { next: 3, byRef: new Map([['e2', original]]), byElement: new WeakMap([[original, 'e2']]),
    seen: new WeakMap([[original, print(original)]]), print };
  if (mode === 'initial' || mode === 'read-lost') original.row = 'Beta';
  if (mode === 'rebound' || mode === 'stale') {
    original.isConnected = false; shown = mode === 'rebound' ? [control()] : [];
  }
  if (mode === 'missing') refs.byRef.clear();
  vi.stubGlobal('document', doc); vi.stubGlobal('location', { href: url });
  vi.stubGlobal('recuedInertOf', undefined); vi.stubGlobal('recuedValidation', undefined);
  vi.stubGlobal('recuedPageRefs', refs);
  const api: BridgeBrowserApi = {
    async findTabByUrlPattern() { return null; }, async executeScript() { return null; },
    async captureVisibleTab() { return null; }, async showNotification(id) { return id; },
    async executeInDocument(_target, func, args) {
      if (![rebindPageRef, describePageElement, clickPageElement].some(f => f === func)) {
        throw new Error(`unexpected script ${func.name}`);
      }
      if (func === describePageElement) descriptions++;
      if (func === clickPageElement && ++attempts === 1 && (mode === 'retry' || mode === 'recovery')) {
        original.isConnected = false;
      }
      const result = await func(...args);
      if (func === rebindPageRef) {
        guards.push({ act: args[1], result });
        if ('changed' in (result as object)) {
          if (fault === 'lost') return null;
          if (fault === 'thrown') throw new Error('identity guard acknowledgement lost');
          if (fault === 'foreign') return { document_id: 'OTHER', result: { kept: true } };
          if (fault === 'empty') return { document_id: 'DOC7', result: {} };
          if (fault === 'mixed') return { document_id: 'DOC7', result: { kept: true, rebound: true } };
          if (fault === 'false-kept') return { document_id: 'DOC7', result: { kept: false } };
        }
        if (mode === 'read-lost') return null;
      }
      if (func === clickPageElement && (mode === 'retry' || mode === 'recovery')) {
        original.isConnected = true;
        if (mode === 'retry') original.row = 'Beta';
      }
      return { document_id: 'DOC7', result };
    },
  };
  const action = mode === 'read-lost' ? 'describe' : 'click';
  const command: BridgeCommand = {
    command_id: 'ack', recipe_run_id: 'run', step_id: 'step',
    ingredient: { publisher_id: 'fixture', slug: 'fixture', version: '1', surface_kind: 'authoring',
      domain_allowlist: ['https://example.com/*'], domain_allowlist_signature: 'fixture' },
    action, target_domain_pattern: 'https://example.com/*', args: { page: '7:DOC7', ref: 'e2' },
    expects_output_keys: action === 'click' ? ['clicked'] : ['page', 'url', 'title', 'role', 'label', 'protected'],
    timeout_ms: 5_000, idempotency_key: 'ack',
  };
  const outcome = await buildActionExecutor(api).execute({ action, command, cancel: { signalled: false } });
  return { outcome, clicks, attempts, descriptions, guards };
};

describe('identity guard acknowledgements', () => {
  it.each([
    { mode: 'initial', fault: 'lost' }, { mode: 'retry', fault: 'lost' },
    { mode: 'initial', fault: 'thrown' }, { mode: 'retry', fault: 'foreign' },
    { mode: 'initial', fault: 'empty' }, { mode: 'initial', fault: 'mixed' },
    { mode: 'initial', fault: 'false-kept' },
  ] as const)('stops $mode execution after a $fault guard reply', async ({ mode, fault }) => {
    const t = await run(mode, fault);
    expect(t.clicks).toEqual([]);
    expect(t.attempts).toBe(mode === 'retry' ? 1 : 0);
    expect(t.outcome).toMatchObject({ status: 'error', error: { code: 'selector_not_found' } });
    expect(t.outcome.outputs).toBeUndefined();
    expect(t.guards.at(-1)).toMatchObject({ act: true, result: { changed: {
      now: '“Save” in “Beta”', was: '“Save” in “Alpha”' } } });
  });

  // 2026-11-19: a reply from no document or another one is the page gone (a reload, a navigation): the caller lists
  // the tabs for the current handle. It said "could not verify… Inspect the page", and inspecting by the old handle
  // can only fail again; the D-335 browser test of a write after a reload went red on it.
  it.each([
    { mode: 'initial', fault: 'lost', message: PAGE_GONE }, { mode: 'retry', fault: 'lost', message: PAGE_GONE },
    { mode: 'initial', fault: 'thrown', message: PAGE_GONE }, { mode: 'retry', fault: 'foreign', message: PAGE_GONE },
    { mode: 'initial', fault: 'foreign', message: PAGE_GONE },
    { mode: 'initial', fault: 'empty', message: 'The browser could not verify that this is still the inspected element.' },
    { mode: 'initial', fault: 'mixed', message: 'The browser could not verify that this is still the inspected element.' },
    { mode: 'initial', fault: 'false-kept', message: 'The browser could not verify that this is still the inspected element.' },
  ] as const)('answers a $mode $fault guard reply with what the caller can do next', async ({ mode, fault, message }) => {
    const t = await run(mode, fault);
    expect(t.clicks).toEqual([]);
    expect(String((t.outcome as { error?: { message?: unknown } }).error?.message)).toContain(message);
  });

  it.each(['initial', 'retry'] as const)('preserves a confirmed %s changed-target refusal', async mode => {
    const t = await run(mode);
    expect(t.clicks).toEqual([]);
    expect(t.attempts).toBe(mode === 'retry' ? 1 : 0);
    expect(t.outcome).toMatchObject({ status: 'error', error: { code: 'selector_not_found', message:
      bridgeElementChangedMessage('e2', '“Save” in “Beta”', '“Save” in “Alpha”') } });
  });

  it.each(['success', 'rebound', 'recovery'] as const)('preserves %s and clicks only the inspected target', async mode => {
    const t = await run(mode);
    expect(t.outcome).toEqual({ status: 'ok', outputs: { clicked: true } });
    expect(t.clicks).toEqual(['Alpha']); expect(t.attempts).toBe(mode === 'recovery' ? 2 : 1);
    expect(t.guards[0]).toMatchObject({ act: true, result: mode === 'rebound' ? { rebound: true } : { kept: true } });
  });

  it.each(['stale', 'missing'] as const)('preserves the confirmed %s refusal', async mode => {
    const t = await run(mode);
    expect(t.clicks).toEqual([]); expect(t.attempts).toBe(0);
    expect(t.outcome).toMatchObject({ status: 'error', error: { code: 'selector_not_found' } });
    expect(t.guards[0]).toMatchObject({ act: true, result: { [mode]: true } });
  });

  it('keeps an ordinary read working when its guard reply is lost', async () => {
    const t = await run('read-lost');
    expect(t.outcome).toMatchObject({ status: 'ok', outputs: { label: 'Save' } });
    expect(t.clicks).toEqual([]); expect(t.attempts).toBe(0); expect(t.descriptions).toBe(1);
    expect(t.guards).toEqual([{ act: false, result: { kept: true } }]);
  });
});
