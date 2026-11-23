import { afterEach, describe, expect, it, vi } from 'vitest';
import { type BridgeCommand } from '@recued/contracts';
import { buildActionExecutor, type BridgeBrowserApi } from '../actions/executor.js';
import { clickPageElement } from '../actions/page-fields.js';
import { describePageElement } from '../actions/page-inspect.js';
import { rebindPageRef } from '../actions/page-rebind.js';

afterEach(() => vi.unstubAllGlobals());
type Mode = 'mixed-write' | 'foreign-write' | 'mixed-description' | 'foreign-description'
  | 'success' | 'lost-reply' | 'write-recovery' | 'description-recovery';

// Real descriptions, reference guards and click execution; only DOM state
// and transport receipts are adapters. No scripted description or click result.
const runClick = async (mode: Mode) => {
  const url = 'https://example.com/form';
  let clicks = 0; let attempts = 0; let descriptions = 0; let rebinds = 0;
  const button = {
    isConnected: true, localName: 'button', id: 'save', parentElement: null, innerText: 'Save', textContent: 'Save',
    get ownerDocument(): object { return doc; }, getRootNode(): object { return doc; },
    getAttribute: (name: string) => name === 'aria-label' ? 'Save' : null,
    hasAttribute: () => false, checkVisibility: () => true, matches: () => false, closest: () => null,
    getBoundingClientRect: () => ({ width: 0, height: 0 }),
    click() { clicks++; },
  };
  const doc = { title: 'Form', documentElement: { hasAttribute: () => false }, defaultView: {},
    querySelectorAll: () => [], querySelector: () => button, getElementById: () => null };
  vi.stubGlobal('document', doc); vi.stubGlobal('location', { href: url });
  vi.stubGlobal('recuedPageRefs', { next: 3, byRef: new Map([['e2', button]]), byElement: new WeakMap([[button, 'e2']]) });
  const api: BridgeBrowserApi = {
    async findTabByUrlPattern() { return null; }, async executeScript() { return null; },
    async captureVisibleTab() { return null; }, async showNotification(id) { return id; },
    async executeInDocument(_target, func, args) {
      if (![describePageElement, rebindPageRef, clickPageElement].some(f => f === func)) {
        throw new Error(`unexpected script ${func.name}`);
      }
      if (func === rebindPageRef) rebinds++;
      if (func === describePageElement && ++descriptions === 1 && mode === 'description-recovery') button.isConnected = false;
      if (func === clickPageElement && ++attempts === 1 && mode === 'write-recovery') button.isConnected = false;
      const result = await func(...args);
      button.isConnected = true;
      const corruptWrite = func === clickPageElement && attempts === 1;
      const corruptDescription = func === describePageElement && descriptions === 1;
      if (corruptWrite && mode === 'mixed-write' || corruptDescription && mode === 'mixed-description') {
        return { document_id: 'DOC7', result: { ...result as object, stale: true } };
      }
      if (corruptWrite && mode === 'foreign-write' || corruptDescription && mode === 'foreign-description') {
        return { document_id: 'OTHER', result: { stale: true } };
      }
      if (corruptWrite && mode === 'lost-reply') return null;
      return { document_id: 'DOC7', result };
    },
  };
  const command: BridgeCommand = {
    command_id: 'proof', recipe_run_id: 'run', step_id: 'step',
    ingredient: { publisher_id: 'fixture', slug: 'fixture', version: '1', surface_kind: 'authoring',
      domain_allowlist: ['https://example.com/*'], domain_allowlist_signature: 'fixture' },
    action: 'click', target_domain_pattern: 'https://example.com/*', args: { page: '7:DOC7', ref: 'e2' },
    expects_output_keys: ['clicked'], timeout_ms: 5_000, idempotency_key: 'proof',
  };
  const outcome = await buildActionExecutor(api).execute({ action: 'click', command, cancel: { signalled: false } });
  return { clicks, attempts, descriptions, rebinds, outcome };
};

describe('reference retry proof', () => {
  it.each(['mixed-write', 'foreign-write'] as const)('does not replay a write after %s', async mode => {
    const t = await runClick(mode);
    expect(t.clicks).toBe(1); expect(t.attempts).toBe(1);
    expect(t.descriptions).toBe(1); expect(t.rebinds).toBe(1);
    expect(t.outcome).toMatchObject({ status: 'error', error: { code: 'delivery_uncertain' } });
    expect(t.outcome.outputs).toBeUndefined();
  });

  it.each(['mixed-description', 'foreign-description'] as const)('does not recover or act after %s', async mode => {
    const t = await runClick(mode);
    expect(t.clicks).toBe(0); expect(t.attempts).toBe(0);
    expect(t.descriptions).toBe(1); expect(t.rebinds).toBe(1);
    expect(t.outcome.status).toBe('error'); expect(t.outcome.outputs).toBeUndefined();
  });

  it.each(['success', 'lost-reply'] as const)('preserves %s without another attempt', async mode => {
    const t = await runClick(mode);
    expect(t.clicks).toBe(1); expect(t.attempts).toBe(1);
    expect(t.descriptions).toBe(1); expect(t.rebinds).toBe(1);
    expect(t.outcome).toMatchObject(mode === 'lost-reply'
      ? { status: 'error', error: { code: 'delivery_uncertain' } } : { status: 'ok', outputs: { clicked: true } });
  });

  it.each(['write-recovery', 'description-recovery'] as const)('preserves valid %s with only one click', async mode => {
    const t = await runClick(mode);
    expect(t.clicks).toBe(1); expect(t.rebinds).toBe(2);
    expect(t.attempts).toBe(mode === 'write-recovery' ? 2 : 1);
    expect(t.descriptions).toBe(mode === 'description-recovery' ? 2 : 1);
    expect(t.outcome).toEqual({ status: 'ok', outputs: { clicked: true } });
  });
});
