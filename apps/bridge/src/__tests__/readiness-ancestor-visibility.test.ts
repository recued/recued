import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BridgeCommand } from '@recued/contracts';
import { buildActionExecutor, type BridgeBrowserApi } from '../actions/executor.js';
import { inspectPage } from '../actions/page-inspect.js';
import { checkPageElement } from '../actions/page-wait.js';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

type OwnerDocument = { defaultView: { getComputedStyle: (element: FixtureElement) => { display: string } } };
class FixtureElement {
  nodeType = 1;
  isConnected = true;
  isContentEditable = false;
  shadowRoot = null;
  parentElement: FixtureElement | null = null;
  assignedSlot: FixtureElement | null = null;
  rootHost: FixtureElement | null = null;
  ownerDocument!: OwnerDocument;
  cssVisible = true;
  childNodes: Array<FixtureElement | { nodeType: number; nodeValue: string }> = [];
  constructor(public localName: string, public attrs: Record<string, string> = {}, text?: string) {
    if (text !== undefined) this.childNodes.push({ nodeType: 3, nodeValue: text });
  }
  get parentNode() { return this.parentElement; }
  get children() { return this.childNodes.filter((node): node is FixtureElement => node instanceof FixtureElement); }
  get classList() { return new Set((this.attrs.class ?? '').split(/\s+/).filter(Boolean)); }
  get textContent(): string { return this.childNodes.map(node => node instanceof FixtureElement ? node.textContent : node.nodeValue).join(''); }
  get innerText() { return this.textContent; }
  getAttribute(name: string) { return this.attrs[name] ?? null; }
  hasAttribute(name: string) { return Object.hasOwn(this.attrs, name); }
  checkVisibility() { return this.cssVisible; }
  getRootNode() { return { host: this.rootHost }; }
  matches(_selector: string) { return false; }
  closest(_selector: string): FixtureElement | null { return null; }
}

const url = 'https://example.test/page';
const check = { selector: '.target', until: 'shown', text: 'Ready' } as const;
const limits = { max_chars: 4000, max_value_chars: 200 };
type Kind = 'hidden' | 'mixed' | 'visible' | 'own-hidden' | 'css-hidden' | 'shadow-host' | 'assigned-slot' | 'bounded';

// Real predicates, inspection and executor; DOM ancestry, rendering and clock
// are controlled. Native DOM behavior is qualified separately in browsers.
const fixture = (kind: Kind) => {
  const all: FixtureElement[] = [];
  const node = (tag: string, attrs: Record<string, string> = {}, text?: string) => {
    const result = new FixtureElement(tag, attrs, text); all.push(result); return result;
  };
  const append = (parent: FixtureElement, child: FixtureElement) => { parent.childNodes.push(child); child.parentElement = parent; };
  const html = node('html'), body = node('body'); append(html, body);
  const hidden = ['hidden', 'mixed', 'shadow-host'].includes(kind);
  const parent = node('section', { 'aria-hidden': hidden ? 'true' : 'false' }); append(body, parent);
  const target = node('div', { id: hidden ? 'hidden' : 'visible', class: 'target' },
    kind === 'bounded' ? 'Ready ' + 'x'.repeat(400) : hidden || kind === 'assigned-slot' ? 'Ready excluded' : 'Ready public');
  append(parent, target);
  const matches = [target];
  if (kind === 'mixed') { const visible = node('div', { id: 'visible', class: 'target' }, 'Ready public'); append(body, visible); matches.push(visible); }
  if (kind === 'own-hidden') target.attrs['aria-hidden'] = 'true';
  if (kind === 'css-hidden') target.cssVisible = false;
  if (kind === 'shadow-host') { parent.childNodes = []; target.parentElement = null; target.rootHost = parent; }
  if (kind === 'assigned-slot') {
    const wrapper = node('section', { 'aria-hidden': 'true' }); wrapper.rootHost = parent;
    const slot = node('slot'); append(wrapper, slot); target.assignedSlot = slot;
  }
  const style = (_element: FixtureElement) => ({ display: 'block' });
  const view = { getComputedStyle: style };
  const doc = { nodeType: 9, documentElement: html, body, defaultView: view, title: 'Fixture', readyState: 'complete',
    querySelectorAll: (selector: string) => selector === '.target' ? matches : [] };
  for (const element of all) element.ownerDocument = doc;
  vi.stubGlobal('document', doc); vi.stubGlobal('window', view);
  vi.stubGlobal('location', { href: url }); vi.stubGlobal('getComputedStyle', style);
  vi.stubGlobal('Node', class { static ELEMENT_NODE = 1; static TEXT_NODE = 3; });
  vi.stubGlobal('recuedPageRefs', { next: 2, byRef: new Map([['e1', target]]), byElement: new WeakMap([[target, 'e1']]) });
  return { parent, target };
};

const fused = () => inspectPage({ selector: check.selector }, limits, null, 0, true, check);

describe('inherited ARIA visibility in readiness and inspection', () => {
  it.each(['shown', 'gone'] as const)('treats an excluded region correctly for until=%s', until => {
    fixture('hidden');
    expect(checkPageElement({ ...check, until })).toMatchObject({ outputs: { met: until === 'gone',
      match_counts: { matched: 1, visible: 0, text_matched: 0 } } });
  });

  it('counts only the eligible match when an excluded match comes first', () => {
    fixture('mixed');
    expect(checkPageElement(check)).toMatchObject({ outputs: { met: true,
      match_counts: { matched: 2, visible: 1, text_matched: 1 } } });
  });

  it('keeps the fused wait pending without returning excluded content', () => {
    fixture('hidden');
    expect(fused()).toEqual({ waiting: { url, title: 'Fixture' } });
  });

  it('fuses readiness with a read of the visible match after an excluded one', () => {
    fixture('mixed');
    expect(fused()).toMatchObject({ outputs: { html: '<div id="visible" class="target">Ready public</div>',
      selector_matches: 2, selected_index: 2, truncated: false } });
  });

  it.each(['hidden', 'shadow-host', 'assigned-slot'] as const)('excludes a scoped %s root', kind => {
    fixture(kind);
    expect(inspectPage(kind === 'hidden' ? { selector: check.selector } : { ref: 'e1' }, limits))
      .toMatchObject({ outputs: { html: '', truncated: false } });
  });

  it.each(['timeout', 'revealed'] as const)('keeps polling until the region is %s', async mode => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const page = fixture('hidden');
    if (mode === 'revealed') setTimeout(() => { page.parent.attrs['aria-hidden'] = 'false'; }, 200);
    const api: BridgeBrowserApi = {
      async findTabByUrlPattern() { return null; }, async executeScript() { return null; },
      async captureVisibleTab() { return null; }, async showNotification(id) { return id; },
      async executeInDocument(_target, func, args) { return { document_id: 'DOC7', result: await func(...args) }; },
    };
    const command: BridgeCommand = {
      command_id: 'wait', recipe_run_id: 'run', step_id: 'step',
      ingredient: { publisher_id: 'fixture', slug: 'fixture', version: '1', surface_kind: 'reading',
        domain_allowlist: ['https://example.test/*'], domain_allowlist_signature: 'fixture' },
      action: 'wait_for_element', target_domain_pattern: 'https://example.test/*',
      args: { page: '7:DOC7', ...check, timeout_ms: 400 },
      expects_output_keys: ['page', 'url', 'title', 'found', 'waited_ms', 'match_counts'], timeout_ms: 5000, idempotency_key: 'wait',
    };
    const execution = buildActionExecutor(api).execute({ action: 'wait_for_element', command, cancel: { signalled: false } });
    await vi.advanceTimersByTimeAsync(400);
    expect(await execution).toMatchObject({ status: 'ok', outputs: { found: mode === 'revealed', waited_ms: mode === 'revealed' ? 200 : 400 } });
  });

  it('preserves visible text matching and the shown/gone relationship', () => {
    fixture('visible');
    expect(checkPageElement({ ...check, text: ' ready\n PUBLIC ' })).toMatchObject({ outputs: { met: true,
      match_counts: { matched: 1, visible: 1, text_matched: 1 } } });
    expect(checkPageElement({ ...check, until: 'gone' })).toMatchObject({ outputs: { met: false } });
  });

  it('preserves the visible fused read and its metadata', () => {
    fixture('visible');
    expect(fused()).toEqual({ outputs: { url, title: 'Fixture', html: '<div id="visible" class="target">Ready public</div>',
      truncated: false, selector_matches: 1, selected_index: 1, loading: false } });
  });

  it('keeps scoped visible reads within their output budget', () => {
    fixture('bounded');
    const answer = inspectPage({ selector: check.selector }, { ...limits, max_chars: 32 });
    if (!('outputs' in answer)) throw new Error('missing bounded inspection');
    expect(answer.outputs.html.length).toBeLessThanOrEqual(32);
    expect(answer.outputs.truncated).toBe(true);
  });

  it('preserves the whole-page exclusion and its visible sibling', () => {
    fixture('mixed');
    const answer = inspectPage({}, limits);
    if (!('outputs' in answer)) throw new Error('missing whole-page inspection');
    expect(answer.outputs.html).not.toContain('Ready excluded');
    expect(answer.outputs.html).toContain('Ready public');
  });

  it.each(['own-hidden', 'css-hidden'] as const)('preserves the existing %s behavior', kind => {
    fixture(kind);
    expect(checkPageElement(check)).toMatchObject({ outputs: { met: false } });
    expect(checkPageElement({ ...check, until: 'gone' })).toMatchObject({ outputs: { met: true } });
    expect(fused()).toEqual({ waiting: { url, title: 'Fixture' } });
    expect(inspectPage({ selector: check.selector }, limits)).toMatchObject({ outputs: { html: '', truncated: false } });
  });
});
