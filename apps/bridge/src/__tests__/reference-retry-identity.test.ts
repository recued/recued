import { afterEach, describe, expect, it, vi } from 'vitest';
import { bridgeElementChangedMessage, type BridgeAction, type BridgeCommand } from '@recued/contracts';
import { buildActionExecutor, type BridgeBrowserApi } from '../actions/executor.js';
import { clickPageElement } from '../actions/page-fields.js';
import { rebindPageRef } from '../actions/page-rebind.js';

const url = 'https://example.com/form';
const read = { url, title: 'Records', role: 'button', label: 'Delete', protected: false };
const changed = { now: '“Delete” in “Dee Delete”', was: '“Delete” in “Bob Delete”' };
const refusal = { status: 'error', error: { code: 'selector_not_found',
  message: bridgeElementChangedMessage('e2', changed.now, changed.was) } };
const command = (action: BridgeAction, args: Record<string, unknown>, expects: string[]): BridgeCommand => ({
  command_id: 'identity', recipe_run_id: 'run', step_id: 'step',
  ingredient: { publisher_id: 'fixture', slug: 'fixture', version: '1', surface_kind: 'authoring',
    domain_allowlist: ['https://example.com/*'], domain_allowlist_signature: 'fixture' },
  action, target_domain_pattern: 'https://example.com/*', args: { page: '7:DOC7', ref: 'e2', ...args },
  expects_output_keys: expects, timeout_ms: 5_000, idempotency_key: 'identity',
});
const browser = (executeInDocument: NonNullable<BridgeBrowserApi['executeInDocument']>): BridgeBrowserApi => ({
  async findTabByUrlPattern() { return null; },
  async executeScript() { return null; },
  async captureVisibleTab() { return null; },
  async showNotification(id) { return id; },
  executeInDocument,
});

afterEach(() => vi.unstubAllGlobals());

describe('reference retry identity', () => {
  // Real injected guard and click, with a controlled document/ref registry.
  // Browser transport and the preceding description are adapters, not live Chrome.
  const page = () => {
    const clicks: string[] = [];
    const control = (row: string) => ({
      row, isConnected: true, localName: 'button', id: '', textContent: 'Delete', shadowRoot: null,
      getAttribute: () => null, checkVisibility: () => true, matches: () => false, closest: () => null,
      getBoundingClientRect: () => ({ width: 0, height: 0 }),
      click() { clicks.push(this.row); },
    });
    const original = control('Bob Delete');
    let shown = [original];
    const doc = { documentElement: { hasAttribute: () => false }, querySelectorAll: () => shown, defaultView: {} };
    const print = (element: ReturnType<typeof control>) => ({ tag: 'button', type: 'button', role: 'button',
      label: 'Delete', text: 'Delete', row: element.row.toLowerCase(), shows: 'Delete', in: element.row });
    const seen = new WeakMap([[original, print(original)]]);
    Object.assign(original, { ownerDocument: doc });
    vi.stubGlobal('document', doc);
    vi.stubGlobal('location', { href: url });
    vi.stubGlobal('recuedPageRefs', { next: 3, byRef: new Map([['e2', original]]),
      byElement: new WeakMap([[original, 'e2']]), seen, print });
    return { original, clicks, replace() {
      const replacement = control('Bob Delete');
      Object.assign(replacement, { ownerDocument: doc });
      shown = [replacement];
    } };
  };

  it.each(['changed', 'unchanged', 'rebuilt'] as const)('handles a %s target using the injected guard and click', async state => {
    const p = page();
    let attempts = 0;
    const executor = buildActionExecutor(browser(async (_target, func, args) => {
      if (func === rebindPageRef) return { document_id: 'DOC7', result: await func(...args) };
      if (func.name === 'describePageElement') return { document_id: 'DOC7', result: { outputs: read } };
      if (func !== clickPageElement) throw new Error(`unexpected script ${func.name}`);
      attempts++;
      if (attempts === 1) {
        p.original.isConnected = false;
        const result = await func(...args);
        if (state === 'rebuilt') p.replace();
        else { p.original.isConnected = true; if (state === 'changed') p.original.row = 'Dee Delete'; }
        return { document_id: 'DOC7', result };
      }
      return { document_id: 'DOC7', result: await func(...args) };
    }));
    const outcome = await executor.execute({ action: 'click', cancel: { signalled: false }, command: command('click', {}, ['clicked']) });
    if (state === 'changed') {
      expect(outcome).toMatchObject(refusal);
      expect(attempts).toBe(1);
      expect(p.clicks).toEqual([]);
    } else {
      expect(outcome).toEqual({ status: 'ok', outputs: { clicked: true } });
      expect(attempts).toBe(2);
      expect(p.clicks).toEqual(['Bob Delete']);
    }
  });

  // Each guarded branch, including reads that prepare an action, must stop at
  // a retry refusal. Success after the stale answer would be an unguarded act.
  const stages: Array<{ action: BridgeAction; script: string; occurrence?: number; args?: Record<string, unknown> }> = [
    { action: 'click', script: 'describePageElement' },
    { action: 'click', script: 'describePageElement', occurrence: 2,
      args: { ready_check: { selector: '#done', until: 'shown' }, send_watch_ms: 0 } },
    { action: 'fill', script: 'fillPageField', args: { value: 'draft' } },
    { action: 'submit', script: 'submitPageForm' },
    { action: 'press', script: 'pressPageKey', args: { key: 'Enter' } },
    { action: 'hover', script: 'describePageElement' },
    { action: 'hover', script: 'hoverPageElement' },
    { action: 'download_file', script: 'pageFileAddress' },
    { action: 'upload_file', script: 'describePageElement', args: { filename: 'a.txt', mime_type: 'text/plain', data: 'YQ==' } },
    { action: 'upload_file', script: 'attachPageFile', args: { filename: 'a.txt', mime_type: 'text/plain', data: 'YQ==' } },
    { action: 'pick', script: 'describePageElement', args: { value: 'Bob', pick: 'Bob' } },
    { action: 'pick', script: 'fillPageField', args: { value: 'Bob', pick: 'Bob' } },
  ];
  it.each(stages.map(stage => ({ ...stage, occurrence: stage.occurrence ?? 1 })))
    ('refuses changed content at $action / $script / $occurrence', async ({ action, script, occurrence, args = {} }) => {
    let stale = false, reached = 0;
    const afterStale: string[] = [];
    const executor = buildActionExecutor(browser(async (_target, func, parameters) => {
      if (stale) afterStale.push(func.name);
      if (func === rebindPageRef) return { document_id: 'DOC7', result: stale && parameters[1] === true ? { changed } : { kept: true } };
      if (func.name === script && ++reached === occurrence) {
        stale = true;
        return { document_id: 'DOC7', result: { stale: true } };
      }
      if (func.name === 'describePageElement') return { document_id: 'DOC7', result: { outputs: { ...read, prepared_sends: false } } };
      if (func.name === 'checkPageElement') return { document_id: 'DOC7', result: { outputs: { url, title: read.title, met: false } } };
      if (func.name === 'notePickLists') return { document_id: 'DOC7', result: { noted: true, ref: 'e2' } };
      if (func.name === 'pageFileAddress') return { document_id: 'DOC7', result: { url, title: read.title,
        address: 'https://example.com/file', cross_origin: false } };
      if (func.name === 'fetchFile') return { document_id: 'DOC7', result: { failed: 'fixture' } };
      return { document_id: 'DOC7', result: { outputs: { clicked: true, filled: true, submitted: true, pressed: 'Enter' } } };
    }));
    const outcome = await executor.execute({ action, cancel: { signalled: false }, command: command(action, args, []) });
    expect(reached).toBe(occurrence);
    expect(outcome).toMatchObject(refusal);
    expect(afterStale).toEqual(['rebindPageRef']);
  });

  it('still lets an ordinary describe retry read changed content', async () => {
    let descriptions = 0;
    const executor = buildActionExecutor(browser(async (_target, func, args) => {
      if (func === rebindPageRef) return { document_id: 'DOC7', result: args[1] === true ? { changed } : { kept: true } };
      if (func.name !== 'describePageElement') throw new Error(`unexpected script ${func.name}`);
      return { document_id: 'DOC7', result: ++descriptions === 1 ? { stale: true } : { outputs: { ...read, label: 'Changed' } } };
    }));
    const outcome = await executor.execute({ action: 'describe', cancel: { signalled: false },
      command: command('describe', {}, ['page', 'url', 'title', 'role', 'label', 'protected']) });
    expect(outcome).toMatchObject({ status: 'ok', outputs: { label: 'Changed' } });
    expect(descriptions).toBe(2);
  });
});
