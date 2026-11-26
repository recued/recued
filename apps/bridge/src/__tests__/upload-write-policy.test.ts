import { afterEach, describe, expect, it, vi } from 'vitest';
import { File as NativeFile } from 'node:buffer';
import { BRIDGE_UPLOAD_OUTPUT_KEYS, type BridgeCommand } from '@recued/contracts';
import { buildActionExecutor, type BridgeBrowserApi } from '../actions/executor.js';
import { attachPageFile } from '../actions/page-files.js';
import { describePageElement } from '../actions/page-inspect.js';
import { rebindPageRef } from '../actions/page-rebind.js';

afterEach(() => vi.unstubAllGlobals());

type State = 'ordinary' | 'moved-url' | 'covering-modal' | 'inside-modal'
  | 'native-disabled' | 'matched-disabled' | 'aria-disabled' | 'owner-surface';
type Binding = 'field' | 'label' | 'wrapper' | 'selector';

// Actual executor, rebind and attachment functions over DOM/DataTransfer
// adapters, with native File objects. No live browser or upload requests.
const runUpload = async (state: State, binding: Binding = 'field') => {
  const url = 'https://forms.example.com/apply';
  const assignments: string[][] = [];
  const events: string[] = [];
  const previous = new NativeFile(['previous-file'], 'previous.txt', { type: 'text/plain' });
  const modal = { checkVisibility: () => true };
  class Input {
    isConnected = true;
    tagName = 'INPUT'; localName = 'input'; type = 'file';
    disabled = state === 'native-disabled';
    parentElement = null;
    selection = [previous];
    get files() { return this.selection; }
    set files(files: NativeFile[]) { this.selection = files; assignments.push(files.map(file => file.name)); }
    get ownerDocument(): object { return doc; }
    getRootNode(): object { return state === 'inside-modal' ? { host: modal } : doc; }
    getAttribute(name: string) { return name === 'aria-disabled' && state === 'aria-disabled' ? 'true' : null; }
    matches(selector: string) {
      return (selector.includes(':disabled') && (this.disabled || state === 'matched-disabled'))
        || (selector.includes('[aria-disabled="true"]') && state === 'aria-disabled');
    }
    closest() { return null; }
    querySelector() { return null; }
    dispatchEvent(event: Event) { events.push(event.type); return true; }
  }
  class Label {
    isConnected = true; tagName = 'LABEL'; localName = 'label'; parentElement = null;
    constructor(readonly control: Input) {}
    closest() { return null; }
    getRootNode(): object { return doc; }
  }
  class Transfer {
    files: NativeFile[] = [];
    items = { add: (file: NativeFile) => { this.files.push(file); } };
  }
  const field = new Input();
  const target = binding === 'label' ? new Label(field) : binding === 'wrapper'
    ? { isConnected: true, tagName: 'DIV', localName: 'div', querySelector: () => field, querySelectorAll: () => [field],
      closest: () => null } : field;
  const doc = { title: 'Apply', documentElement: { hasAttribute: (name: string) => name === 'data-recued-owner-surface' && state === 'owner-surface' },
    querySelector: () => target,
    querySelectorAll: (selector: string) => selector === '#file' ? [target] : selector === 'dialog:modal, [aria-modal="true"]'
      && (state === 'inside-modal' || state === 'covering-modal') ? [modal] : [],
  };
  vi.stubGlobal('document', doc); vi.stubGlobal('location', { href: url });
  vi.stubGlobal('HTMLInputElement', Input); vi.stubGlobal('HTMLLabelElement', Label);
  vi.stubGlobal('DataTransfer', Transfer); vi.stubGlobal('File', NativeFile);
  vi.stubGlobal('recuedPageRefs', { next: 3, byRef: new Map([['e2', target]]), byElement: new WeakMap([[target, 'e2']]) });
  const api: BridgeBrowserApi = {
    async findTabByUrlPattern() { return null; },
    async executeScript() { return null; },
    async captureVisibleTab() { return null; },
    async showNotification(id) { return id; },
    async executeInDocument(_target, func, args) {
      if (func === rebindPageRef) return { document_id: 'DOC7', result: await func(...args) };
      if (func === describePageElement) {
        if (state === 'moved-url') vi.stubGlobal('location', { href: 'https://forms.example.com/another-request' });
        return { document_id: 'DOC7', result: { outputs: { url, title: 'Apply', role: 'file field', label: 'Attachment', protected: false } } };
      }
      if (func !== attachPageFile) throw new Error(`unexpected script ${func.name}`);
      return { document_id: 'DOC7', result: await func(...args) };
    },
  };
  const command: BridgeCommand = {
    command_id: 'upload', recipe_run_id: 'run', step_id: 'step',
    ingredient: { publisher_id: 'fixture', slug: 'fixture', version: '1', surface_kind: 'authoring',
      domain_allowlist: ['https://forms.example.com/*'], domain_allowlist_signature: 'fixture' },
    action: 'upload_file', target_domain_pattern: 'https://forms.example.com/*',
    args: { page: '7:DOC7', ...(binding === 'selector' ? { selector: '#file' } : { ref: 'e2' }),
      filename: 'fixture.txt', mime_type: 'text/plain', data: Buffer.from('fixture-file').toString('base64') },
    expects_output_keys: [...BRIDGE_UPLOAD_OUTPUT_KEYS], timeout_ms: 5_000, idempotency_key: 'upload',
  };
  const outcome = await buildActionExecutor(api).execute({ action: 'upload_file', command, cancel: { signalled: false } });
  return { outcome, field, assignments, events, previous, url };
};

describe('upload write policy', () => {
  it.each(['moved-url', 'covering-modal', 'matched-disabled', 'aria-disabled'] as const)
    ('refuses %s before changing the selected file or emitting events', async state => {
      const t = await runUpload(state);
      expect(t.outcome).toMatchObject({ status: 'error', error: {
        code: state === 'moved-url' ? 'tab_navigation_blocked' : 'value_not_applied',
      } });
      expect(t.assignments).toEqual([]);
      expect(t.events).toEqual([]);
      expect(t.field.files).toEqual([t.previous]);
      expect(await t.field.files[0]!.text()).toBe('previous-file');
    });

  it.each(['field', 'label', 'wrapper', 'selector'] as const)('preserves a valid %s upload', async binding => {
    const t = await runUpload('ordinary', binding);
    expect(t.outcome).toMatchObject({ status: 'ok', outputs: { attached: 'fixture.txt', url: t.url } });
    expect(t.assignments).toEqual([['fixture.txt']]);
    expect(await t.field.files[0]!.text()).toBe('fixture-file');
    expect(t.field.files[0]!.type).toBe('text/plain');
    expect(t.events).toEqual(['input', 'change']);
  });

  it('allows the resolved field inside a dialog shadow tree when its label is outside', async () => {
    const t = await runUpload('inside-modal', 'label');
    expect(t.outcome).toMatchObject({ status: 'ok', outputs: { attached: 'fixture.txt' } });
    expect(t.assignments).toEqual([['fixture.txt']]);
    expect(t.events).toEqual(['input', 'change']);
  });

  it.each(['native-disabled', 'owner-surface'] as const)('preserves the existing %s refusal', async state => {
    const t = await runUpload(state);
    expect(t.outcome).toMatchObject({ status: 'error', error: {
      code: state === 'native-disabled' ? 'selector_not_found' : 'tab_navigation_blocked',
    } });
    expect(t.assignments).toEqual([]);
    expect(t.events).toEqual([]);
    expect(t.field.files).toEqual([t.previous]);
  });
});
