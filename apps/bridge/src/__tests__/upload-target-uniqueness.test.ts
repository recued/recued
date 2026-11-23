import { afterEach, describe, expect, it, vi } from 'vitest';
import { File as NativeFile } from 'node:buffer';
import { BRIDGE_UPLOAD_OUTPUT_KEYS, type BridgeCommand } from '@recued/contracts';
import { buildActionExecutor, type BridgeBrowserApi } from '../actions/executor.js';
import { attachPageFile } from '../actions/page-files.js';
import { describePageElement } from '../actions/page-inspect.js';
import { rebindPageRef } from '../actions/page-rebind.js';

afterEach(() => vi.unstubAllGlobals());
type Binding = 'selector' | 'wrapper' | 'ref' | 'label';
type Case = { name: string; binding: Binding; shown: boolean[] };

// Real descriptions, rebinding, attachment and executor; only the DOM,
// DataTransfer and transport are adapters. Files use the native File class.
const runUpload = async (binding: Binding, shown: boolean[]) => {
  const url = 'https://forms.example.com/upload';
  const assignments: Array<{ field: string; files: string[] }> = [];
  const events: Array<{ field: string; type: string }> = [];
  class Input {
    isConnected = true; tagName = 'INPUT'; localName = 'input'; type = 'file'; disabled = false; parentElement = null;
    selection: NativeFile[];
    constructor(readonly id: string, readonly visible: boolean) {
      this.selection = [new NativeFile([`previous-${id}`], `previous-${id}.txt`)];
    }
    get files() { return this.selection; }
    set files(files: NativeFile[]) { this.selection = files; assignments.push({ field: this.id, files: files.map(file => file.name) }); }
    get ownerDocument(): object { return doc; }
    getRootNode(): object { return doc; }
    getAttribute(name: string) { return name === 'aria-label' ? `Upload ${this.id}` : null; }
    hasAttribute() { return false; }
    matches() { return false; }
    closest() { return null; }
    checkVisibility() { return this.visible; }
    querySelector() { return null; }
    querySelectorAll() { return []; }
    dispatchEvent(event: Event) { events.push({ field: this.id, type: event.type }); return true; }
  }
  const first = new Input('A', shown[0]!);
  const second = new Input('B', shown[1] ?? true);
  const candidates = shown.length === 1 ? [first] : [first, second];
  class Label {
    isConnected = true; tagName = 'LABEL'; localName = 'label'; parentElement = null; innerText = 'Upload B';
    constructor(readonly control: Input) {}
    getAttribute(name: string) { return name === 'aria-label' ? 'Upload B' : null; }
    getRootNode(): object { return doc; }
  }
  const wrapper = { isConnected: true, tagName: 'DIV', localName: 'div', parentElement: null, innerText: 'Attachments',
    getAttribute: (name: string) => name === 'aria-label' ? 'Attachments' : null, getRootNode: () => doc,
    querySelector: () => candidates[0] ?? null, querySelectorAll: () => candidates,
    checkVisibility: () => true, closest: () => null };
  const target = binding === 'wrapper' ? wrapper : binding === 'label' ? new Label(second) : binding === 'ref' ? second : first;
  const doc = { title: 'Uploads', documentElement: { hasAttribute: () => false }, querySelector: () => candidates[0] ?? null,
    querySelectorAll: (selector: string) => selector === '.upload' ? candidates
      : selector === 'input[type="file"]' ? [first, second] : [], getElementById: () => null };
  class Transfer { files: NativeFile[] = []; items = { add: (file: NativeFile) => { this.files.push(file); } }; }
  vi.stubGlobal('document', doc); vi.stubGlobal('location', { href: url });
  vi.stubGlobal('HTMLInputElement', Input); vi.stubGlobal('HTMLLabelElement', Label);
  vi.stubGlobal('DataTransfer', Transfer); vi.stubGlobal('File', NativeFile);
  vi.stubGlobal('recuedPageRefs', { next: 3, byRef: new Map([['e2', target]]), byElement: new WeakMap([[target, 'e2']]) });
  const api: BridgeBrowserApi = {
    async findTabByUrlPattern() { return null; }, async executeScript() { return null; },
    async captureVisibleTab() { return null; }, async showNotification(id) { return id; },
    async executeInDocument(_target, func, args) {
      if (![rebindPageRef, describePageElement, attachPageFile].some(script => script === func)) throw new Error(`unexpected script ${func.name}`);
      return { document_id: 'DOC7', result: await func(...args) };
    },
  };
  const command: BridgeCommand = {
    command_id: 'unique', recipe_run_id: 'run', step_id: 'step',
    ingredient: { publisher_id: 'fixture', slug: 'fixture', version: '1', surface_kind: 'authoring',
      domain_allowlist: ['https://forms.example.com/*'], domain_allowlist_signature: 'fixture' },
    action: 'upload_file', target_domain_pattern: 'https://forms.example.com/*',
    args: { page: '7:DOC7', ...(binding === 'selector' ? { selector: '.upload' } : { ref: 'e2' }),
      filename: 'fixture.txt', mime_type: 'text/plain', data: Buffer.from('fixture-file').toString('base64') },
    expects_output_keys: [...BRIDGE_UPLOAD_OUTPUT_KEYS], timeout_ms: 5_000, idempotency_key: 'unique',
  };
  const outcome = await buildActionExecutor(api).execute({ action: 'upload_file', command, cancel: { signalled: false } });
  return { outcome, fields: [first, second], assignments, events };
};

describe('upload target uniqueness', () => {
  const ambiguous: Case[] = [
    { name: 'two shown selector matches', binding: 'selector', shown: [true, true] },
    { name: 'two hidden selector matches', binding: 'selector', shown: [false, false] },
    { name: 'a hidden and a shown selector match', binding: 'selector', shown: [false, true] },
    { name: 'two shown fields in a container', binding: 'wrapper', shown: [true, true] },
    { name: 'two hidden fields in a container', binding: 'wrapper', shown: [false, false] },
  ];
  it.each(ambiguous)('refuses $name without changing any selection or emitting events', async ({ binding, shown }) => {
    const t = await runUpload(binding, shown);
    expect(t.outcome).toMatchObject({ status: 'error', error: { code: 'value_not_applied' } });
    expect(t.outcome.outputs).toBeUndefined();
    expect(t.assignments).toEqual([]);
    expect(t.events).toEqual([]);
    for (const field of t.fields) {
      expect(field.files.map(file => file.name)).toEqual([`previous-${field.id}.txt`]);
      expect(await field.files[0]!.text()).toBe(`previous-${field.id}`);
    }
  });

  const unique: Case[] = [
    { name: 'one shown selector match', binding: 'selector', shown: [true] },
    { name: 'one hidden selector match', binding: 'selector', shown: [false] },
    { name: 'one shown field in a container', binding: 'wrapper', shown: [true] },
    { name: 'one hidden field in a container', binding: 'wrapper', shown: [false] },
    { name: 'an exact ref beside another file input', binding: 'ref', shown: [true, true] },
    { name: 'a label beside another file input', binding: 'label', shown: [true, true] },
  ];
  it.each(unique)('preserves $name', async ({ binding, shown }) => {
    const t = await runUpload(binding, shown);
    const id = binding === 'ref' || binding === 'label' ? 'B' : 'A';
    expect(t.outcome).toMatchObject({ status: 'ok', outputs: { attached: 'fixture.txt' } });
    expect(t.assignments).toEqual([{ field: id, files: ['fixture.txt'] }]);
    expect(t.events).toEqual(['input', 'change'].map(type => ({ field: id, type })));
    const selected = t.fields.find(field => field.id === id)!;
    expect(await selected.files[0]!.text()).toBe('fixture-file');
    expect(selected.files[0]!.type).toBe('text/plain');
    const other = t.fields.find(field => field.id !== id)!;
    expect(other.files.map(file => file.name)).toEqual([`previous-${other.id}.txt`]);
  });
});
