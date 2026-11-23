import { File as NativeFile } from 'node:buffer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BRIDGE_UPLOAD_OUTPUT_KEYS, type BridgeCommand } from '@recued/contracts';
import { buildActionExecutor, type BridgeBrowserApi } from '../actions/executor.js';
import { attachPageFile } from '../actions/page-files.js';
import { describePageElement } from '../actions/page-inspect.js';
import { rebindPageRef } from '../actions/page-rebind.js';

afterEach(() => vi.unstubAllGlobals());

const unproven = ['no-answer', 'throw-after-write', 'wrong-document', 'wrong-document-stale', 'null-result',
  'missing-result', 'empty-result', 'incomplete-result', 'wrong-result-type', 'mixed-stale-receipt', 'false-refusal'] as const;
type Mode = typeof unproven[number] | 'success' | 'cancel-after-answer' | 'lost-description' | 'missing-ref'
  | 'blocked' | 'missing' | 'stale' | 'recovered-stale' | 'not-file' | 'disabled' | 'cancel-after-description';

// Execute the real descriptions, rebinding and attachment. The adapters model
// DOM state, file events and transport receipts; files use the native File class.
const runUpload = async (mode: Mode) => {
  const url = 'https://forms.example.com/upload';
  const cancel = { signalled: false };
  const assignments: Array<{ field: string; files: string[] }> = [];
  const events: Array<{ field: string; type: string }> = [];
  let attachmentCalls = 0; let owner = false; let missing = false;
  class Input {
    isConnected = true; tagName = 'INPUT'; localName = 'input'; type = 'file'; disabled = false; parentElement = null;
    selection: NativeFile[];
    constructor(readonly id: string) { this.selection = [new NativeFile([`previous-${id}`], `previous-${id}.txt`)]; }
    get files() { return this.selection; }
    set files(files: NativeFile[]) {
      this.selection = files; assignments.push({ field: this.id, files: files.map(file => file.name) });
    }
    getRootNode(): object { return doc; }
    getAttribute(name: string) { return name === 'aria-label' ? `Upload ${this.id}` : null; }
    hasAttribute() { return false; }
    matches(selector: string) { return selector === ':disabled' && mode === 'disabled'; }
    closest() { return null; }
    checkVisibility() { return true; }
    querySelector() { return null; }
    querySelectorAll() { return []; }
    dispatchEvent(event: Event) { events.push({ field: this.id, type: event.type }); return true; }
  }
  const first = new Input('A'); const target = new Input('B');
  let replacement: Input | undefined;
  if (mode === 'missing-ref') target.isConnected = false;
  const doc = { title: 'Uploads', documentElement: { hasAttribute: () => owner },
    querySelector: () => missing ? null : target,
    querySelectorAll: (selector: string) => selector === 'input' && replacement ? [replacement]
      : selector === '#upload' && !missing ? [target] : [],
    getElementById: () => null };
  class Transfer { files: NativeFile[] = []; items = { add: (file: NativeFile) => { this.files.push(file); } }; }
  vi.stubGlobal('document', doc); vi.stubGlobal('location', { href: url });
  vi.stubGlobal('HTMLInputElement', Input); vi.stubGlobal('HTMLLabelElement', class {});
  vi.stubGlobal('DataTransfer', Transfer); vi.stubGlobal('File', NativeFile);
  vi.stubGlobal('recuedPageRefs', { next: 3, byRef: new Map([['e2', target]]), byElement: new WeakMap([[target, 'e2']]) });
  const api: BridgeBrowserApi = {
    async findTabByUrlPattern() { return null; }, async executeScript() { return null; },
    async captureVisibleTab() { return null; }, async showNotification(id) { return id; },
    async executeInDocument(_target, func, args) {
      if (![rebindPageRef, describePageElement, attachPageFile].some(script => script === func)) {
        throw new Error(`unexpected script ${func.name}`);
      }
      if (func === attachPageFile) {
        attachmentCalls += 1;
        if (mode === 'blocked') owner = true;
        if (mode === 'missing') missing = true;
        if (mode === 'stale') target.isConnected = false;
        if (mode === 'recovered-stale' && attachmentCalls === 1) {
          target.isConnected = false; replacement = new Input('B');
        }
        if (mode === 'not-file') target.type = 'text';
      }
      const result = await func(...args);
      if (func === describePageElement) {
        if (mode === 'lost-description') return null;
        if (mode === 'cancel-after-description') cancel.signalled = true;
      }
      if (func === attachPageFile) {
        if (mode === 'no-answer') return null;
        if (mode === 'throw-after-write') throw new Error('transport acknowledgement lost');
        if (mode === 'wrong-document') return { document_id: 'OTHER', result };
        if (mode === 'wrong-document-stale') return { document_id: 'OTHER', result: { stale: true } };
        if (mode === 'null-result') return { document_id: 'DOC7', result: null };
        if (mode === 'missing-result') return { document_id: 'DOC7', result: undefined };
        if (mode === 'empty-result') return { document_id: 'DOC7', result: {} };
        if (mode === 'incomplete-result') return { document_id: 'DOC7', result: { attached: 'fixture.txt' } };
        if (mode === 'wrong-result-type') return { document_id: 'DOC7', result: { attached: 42, url, title: 'Uploads' } };
        if (mode === 'mixed-stale-receipt') return { document_id: 'DOC7', result: { ...result as object, stale: true } };
        if (mode === 'false-refusal') return { document_id: 'DOC7', result: { blocked: false } };
        if (mode === 'cancel-after-answer') cancel.signalled = true;
      }
      return { document_id: 'DOC7', result };
    },
  };
  const command: BridgeCommand = {
    command_id: 'upload', recipe_run_id: 'run', step_id: 'step',
    ingredient: { publisher_id: 'fixture', slug: 'fixture', version: '1', surface_kind: 'authoring',
      domain_allowlist: ['https://forms.example.com/*'], domain_allowlist_signature: 'fixture' },
    action: 'upload_file', target_domain_pattern: 'https://forms.example.com/*',
    args: { page: '7:DOC7', ...(mode === 'missing' ? { selector: '#upload' } : { ref: 'e2' }),
      filename: 'fixture.txt', mime_type: 'text/plain', data: Buffer.from('fixture-file').toString('base64') },
    expects_output_keys: [...BRIDGE_UPLOAD_OUTPUT_KEYS], timeout_ms: 5_000, idempotency_key: 'upload',
  };
  const outcome = await buildActionExecutor(api).execute({ action: 'upload_file', command, cancel });
  return { outcome, fields: [first, replacement ?? target], assignments, events, attachmentCalls };
};

describe('upload acknowledgements', () => {
  it.each(unproven)('keeps %s uncertain after one attachment attempt', async mode => {
    const t = await runUpload(mode);
    expect(t.outcome).toMatchObject({ status: 'error', error: { code: 'delivery_uncertain' } });
    expect(t.outcome.outputs).toBeUndefined();
    expect(t.attachmentCalls).toBe(1);
    expect(t.assignments).toEqual([{ field: 'B', files: ['fixture.txt'] }]);
    expect(t.events).toEqual([{ field: 'B', type: 'input' }, { field: 'B', type: 'change' }]);
    expect(await t.fields[1]!.files[0]!.text()).toBe('fixture-file');
    expect(await t.fields[0]!.files[0]!.text()).toBe('previous-A');
  });

  it.each(['success', 'cancel-after-answer'] as const)('preserves a confirmed attachment with %s', async mode => {
    const t = await runUpload(mode);
    expect(t.outcome).toEqual({ status: 'ok', outputs: {
      attached: 'fixture.txt', page: '7:DOC7', url: 'https://forms.example.com/upload', title: 'Uploads' } });
    expect(t.attachmentCalls).toBe(1);
    expect(t.assignments).toEqual([{ field: 'B', files: ['fixture.txt'] }]);
    expect(t.events).toHaveLength(2);
    expect(await t.fields[1]!.files[0]!.text()).toBe('fixture-file');
  });

  it('recovers a confirmed stale refusal and attaches only once', async () => {
    const t = await runUpload('recovered-stale');
    expect(t.outcome).toMatchObject({ status: 'ok', outputs: { attached: 'fixture.txt' } });
    expect(t.attachmentCalls).toBe(2);
    expect(t.assignments).toEqual([{ field: 'B', files: ['fixture.txt'] }]);
    expect(t.events).toEqual([{ field: 'B', type: 'input' }, { field: 'B', type: 'change' }]);
    expect(await t.fields[1]!.files[0]!.text()).toBe('fixture-file');
  });

  it.each([
    ['blocked', 'tab_navigation_blocked'], ['missing', 'selector_not_found'], ['stale', 'selector_not_found'],
    ['not-file', 'selector_not_found'], ['disabled', 'value_not_applied'],
  ] as const)('preserves the confirmed %s refusal', async (mode, code) => {
    const t = await runUpload(mode);
    expect(t.outcome).toMatchObject({ status: 'error', error: { code } });
    expect(t.outcome.outputs).toBeUndefined();
    expect(t.assignments).toEqual([]); expect(t.events).toEqual([]);
    for (const field of t.fields) expect(await field.files[0]!.text()).toBe(`previous-${field.id}`);
  });

  it.each(['lost-description', 'missing-ref', 'cancel-after-description'] as const)('does not attach after %s', async mode => {
    const t = await runUpload(mode);
    expect(t.outcome).toMatchObject(mode === 'cancel-after-description' ? { status: 'cancelled' }
      : { status: 'error', error: { code: 'selector_not_found' } });
    expect(t.attachmentCalls).toBe(0);
    expect(t.assignments).toEqual([]); expect(t.events).toEqual([]);
    for (const field of t.fields) expect(await field.files[0]!.text()).toBe(`previous-${field.id}`);
  });
});
