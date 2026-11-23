import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BridgeCommand } from '@recued/contracts';
import { buildActionExecutor, type BridgeBrowserApi } from '../actions/executor.js';
import { fillPageField } from '../actions/page-fields.js';
import { findPickOption, notePickLists, PICK_RULES, pickTook, typeWithKeys } from '../actions/page-pick.js';
import { rebindPageRef } from '../actions/page-rebind.js';
import { PAGE_CHANGED } from '../actions/page-inspect.js';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

// Real note, fill, lookup, rebinding, keyboard and confirmation scripts over DOM adapters.
// Browser transport and the description are scripted; no live Chrome.
const fixture = () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
  const url = 'https://example.com/new';
  const writes: Array<{ field: string; value: string }> = [];
  const events: Array<{ field: string; type: string }> = [];
  const focuses: string[] = [];
  let ownerSurface = false;
  let modals: Array<{ checkVisibility(): boolean }> = [];
  class Input {
    isConnected = true;
    localName = 'input';
    shadowRoot = null;
    parentElement = null;
    contents = '';
    disabled = false;
    ariaDisabled = false;
    constructor(readonly id: string, readonly label: string) {}
    get value() { return this.contents; }
    set value(value: string) { this.contents = value; writes.push({ field: this.id, value }); }
    get ownerDocument(): object { return doc; }
    getRootNode(): object { return doc; }
    getAttribute(name: string) { return name === 'aria-disabled' && this.ariaDisabled ? 'true'
      : name === 'type' ? 'text' : name === 'name' ? this.id : name === 'aria-label' ? this.label : null; }
    closest() { return null; }
    checkVisibility() { return true; }
    matches(selector: string) { return selector === ':disabled' ? this.disabled : selector.includes('input') && !selector.includes('[type='); }
    getBoundingClientRect() { return { top: 0, left: 0, right: 100, bottom: 20, width: 100, height: 20 }; }
    focus() { focuses.push(this.id); doc.activeElement = this; }
    dispatchEvent(event: Event) { events.push({ field: this.id, type: event.type }); return true; }
  }
  const original = new Input('company', 'Company');
  const other = new Input('notes', 'Notes');
  other.contents = 'keep these notes';
  let candidates = [original, other];
  let selectorTargets = [original];
  const doc = {
    documentElement: { hasAttribute: (name: string) => name === 'data-recued-owner-surface' && ownerSurface },
    body: { querySelectorAll: () => [] },
    activeElement: other,
    querySelector: () => selectorTargets[0] ?? null,
    querySelectorAll(selector: string) { return selector === 'dialog:modal, [aria-modal="true"]' ? modals
      : selector === '#company' ? selectorTargets : selector === 'input' || selector === '*' ? candidates : []; },
    getElementById: () => null,
  };
  const refs = { next: 3, byRef: new Map([['e2', original]]), byElement: new WeakMap([[original, 'e2']]) };
  vi.stubGlobal('document', doc);
  vi.stubGlobal('location', { href: url });
  vi.stubGlobal('HTMLInputElement', Input);
  vi.stubGlobal('HTMLTextAreaElement', Input);
  vi.stubGlobal('InputEvent', Event);
  vi.stubGlobal('KeyboardEvent', Event);
  vi.stubGlobal('recuedPageRefs', refs);
  return { url, original, other, writes, events, focuses, refs,
    markOwnerSurface() { ownerSurface = true; },
    showModal(containing = false) {
      const modal = { checkVisibility: () => true };
      modals = [modal];
      if (containing) original.getRootNode = () => ({ host: modal,
        querySelectorAll: doc.querySelectorAll.bind(doc), getElementById: doc.getElementById });
    },
    retargetSelector() { selectorTargets = [other]; },
    ambiguousSelector() { selectorTargets = [original, new Input('company', 'Company')]; },
    focusOther() { doc.activeElement = other; },
    replace(count: number) {
      original.isConnected = false;
      const replacements = Array.from({ length: count }, () => new Input('company', 'Company'));
      candidates = [...replacements, other];
      selectorTargets = replacements;
      return replacements;
    },
  };
};
type Page = ReturnType<typeof fixture>;
type Hook = (page: Page, script: string, at: number, cancel: { signalled: boolean }) => void;
const runPick = async (page: Page, options: { selector?: boolean; noteAnswer?: unknown; loseKeyReply?: boolean; after?: Hook } = {}) => {
  const cancel = { signalled: false };
  const calls: string[] = [];
  const started = Date.now();
  const api: BridgeBrowserApi = {
    async findTabByUrlPattern() { return null; },
    async executeScript() { return null; },
    async captureVisibleTab() { return null; },
    async showNotification(id) { return id; },
    async executeInDocument(_target, func, args) {
      calls.push(func.name);
      let result: unknown;
      if ([rebindPageRef, notePickLists, fillPageField, findPickOption, typeWithKeys].some(script => script === func)) result = await func(...args);
      else if (func.name === 'describePageElement') result = { outputs: {
        url: page.url, title: 'New record', role: 'combo box', label: 'Company', protected: false,
      } };
      else throw new Error(`unexpected script ${func.name}`);
      if (func === fillPageField) page.focusOther();
      options.after?.(page, func.name, Date.now() - started, cancel);
      if (func === notePickLists && Object.hasOwn(options, 'noteAnswer')) result = options.noteAnswer;
      if (func === typeWithKeys && options.loseKeyReply) return null;
      return { document_id: 'DOC7', result };
    },
  };
  const command: BridgeCommand = {
    command_id: 'pick', recipe_run_id: 'run', step_id: 'step',
    ingredient: { publisher_id: 'fixture', slug: 'fixture', version: '1', surface_kind: 'authoring',
      domain_allowlist: ['https://example.com/*'], domain_allowlist_signature: 'fixture' },
    action: 'pick', target_domain_pattern: 'https://example.com/*',
    args: { page: '7:DOC7', ...(options.selector ? { selector: '#company' } : { ref: 'e2' }),
      value: 'Acme', pick: 'Acme Corp', pick_ms: 1_500 },
    expects_output_keys: ['filled', 'picked'], timeout_ms: 30_000, idempotency_key: 'pick',
  };
  const pending = buildActionExecutor(api).execute({ action: 'pick', command, cancel });
  await vi.advanceTimersByTimeAsync(5_000);
  return { outcome: await pending, calls };
};

describe('autocomplete field ownership', () => {
  it('keeps keyboard recovery on a live named field even while another field has focus', async () => {
    const p = fixture();
    const result = await runPick(p);
    expect(result.calls.filter(name => name === 'typeWithKeys')).toHaveLength(1);
    expect(p.original.value).toBe('Acme');
    expect(p.writes.filter(write => write.field === 'company').length).toBeGreaterThan(1);
    expect(p.other.value).toBe('keep these notes');
  });

  const refused = (['lookup', 'keyboard'] as const).flatMap(boundary =>
    [0, 2].map(count => ({ boundary, count, state: count === 0 ? 'missing' : 'ambiguous' })));
  it.each(refused)('refuses a $state field at $boundary recovery without touching unrelated input', async ({ boundary, count }) => {
    const p = fixture();
    let changed = false;
    const result = await runPick(p, { after(page, script, at) {
      if (!changed && (boundary === 'lookup' ? script === 'fillPageField' : script === 'findPickOption' && at >= 1_000)) {
        changed = true; page.replace(count);
      }
    } });
    expect(changed).toBe(true);
    expect(result.outcome).toMatchObject({ status: 'error', error: { code: 'selector_not_found', message: PAGE_CHANGED } });
    expect(p.other.value).toBe('keep these notes');
    expect(p.writes.filter(write => write.field !== 'company')).toEqual([]);
    expect(result.calls.filter(name => name === 'typeWithKeys')).toHaveLength(boundary === 'keyboard' ? 1 : 0);
  });

  it.each(['lookup', 'keyboard'] as const)('recovers a uniquely rebuilt field at %s while leaving unrelated focus alone', async boundary => {
    const p = fixture();
    let replacement: Page['original'] | undefined;
    const result = await runPick(p, { after(page, script, at) {
      if (replacement === undefined && (boundary === 'lookup' ? script === 'fillPageField' : script === 'findPickOption' && at >= 1_000)) {
        replacement = page.replace(1)[0];
      }
    } });
    expect(result.calls).toContain('typeWithKeys');
    expect(replacement?.value).toBe('Acme');
    expect(p.other.value).toBe('keep these notes');
  });

  it('pins a selector to the field noted before typing, even if the selector later names another field', async () => {
    const p = fixture();
    const result = await runPick(p, { selector: true, after(page, script) {
      if (script === 'notePickLists') page.retargetSelector();
    } });
    expect(result.calls).toContain('typeWithKeys');
    expect(p.original.value).toBe('Acme');
    expect(p.other.value).toBe('keep these notes');
  });

  it('recovers a selector\'s unique replacement without a previous inspection', async () => {
    const p = fixture();
    // No previous inspection need have assigned refs for a selector-based pick.
    vi.stubGlobal('recuedPageRefs', undefined);
    let replacement: Page['original'] | undefined;
    const result = await runPick(p, { selector: true, after(page, script) {
      if (script === 'fillPageField' && replacement === undefined) replacement = page.replace(1)[0];
    } });
    expect(result.calls).toContain('typeWithKeys');
    expect(replacement?.value).toBe('Acme');
    expect(p.other.value).toBe('keep these notes');
  });

  it('keeps the ordinary fill refusal when a selector becomes ambiguous before binding', async () => {
    const p = fixture();
    const result = await runPick(p, { selector: true, after(page, script) {
      if (script === 'describePageElement') page.ambiguousSelector();
    } });
    expect(result.outcome).toMatchObject({ status: 'error', error: { code: 'selector_not_found' } });
    expect(p.writes).toEqual([]);
  });

  it.each(['note', 'lookup'] as const)('does not type after cancellation during the %s', async boundary => {
    const p = fixture();
    const result = await runPick(p, { after(_page, script, at, cancel) {
      if (boundary === 'note' ? script === 'notePickLists' : script === 'findPickOption' && at >= 1_000) cancel.signalled = true;
    } });
    expect(result.outcome.status).toBe('cancelled');
    expect(result.calls).not.toContain('typeWithKeys');
    if (boundary === 'note') { expect(result.calls).not.toContain('fillPageField'); expect(p.writes).toEqual([]); }
    expect(p.other.value).toBe('keep these notes');
  });

  it.each([null, { noted: true, ref: 'e99' }])('does not type without a confirmed binding to the requested field: %j', async noteAnswer => {
    const p = fixture();
    const result = await runPick(p, { noteAnswer });
    expect(result.outcome.status).toBe('error');
    expect(result.calls).not.toContain('fillPageField');
    expect(p.writes).toEqual([]);
    expect(p.other.value).toBe('keep these notes');
  });

  it('keeps a lost keyboard acknowledgement uncertain and does not replay typing', async () => {
    const p = fixture();
    const result = await runPick(p, { loseKeyReply: true });
    expect(result.outcome).toMatchObject({ status: 'error', error: { code: 'delivery_uncertain' } });
    expect(result.calls.filter(name => name === 'typeWithKeys')).toHaveLength(1);
    expect(result.calls.at(-1)).toBe('typeWithKeys');
    expect(p.other.value).toBe('keep these notes');
  });

  it.each(['unrelated', 'rebound'] as const)('uses the bound field for confirmation with %s matching text', state => {
    const p = fixture();
    notePickLists('', 'e2', PICK_RULES);
    const world = globalThis as typeof globalThis & { recuedPickNote: { chosen?: { option: unknown; label: string } } };
    world.recuedPickNote.chosen = { option: { isConnected: false, closest: () => null, parentElement: null }, label: 'Acme Corp' };
    p.other.contents = 'Acme Corp';
    const replacement = p.replace(state === 'rebound' ? 1 : 0)[0];
    if (replacement) {
      replacement.contents = 'Acme Corp';
      expect(rebindPageRef('e2', true)).toEqual({ rebound: true });
    }
    expect(pickTook('', 'e2', 'Acme', 'Acme Corp', PICK_RULES))
      .toEqual(state === 'rebound' ? { took: 'shown' } : { not_shown: true });
    expect(p.writes).toEqual([]);
  });
});

describe('autocomplete keyboard write checks', () => {
  it.each(['disabled', 'aria-disabled', 'modal', 'owner-surface', 'moved-url'] as const)
    ('refuses %s recovery before any focus, value change or event', async state => {
      const p = fixture();
      let checkpoint: { writes: number; events: number; focuses: number } | undefined;
      const result = await runPick(p, { after(page, script, at) {
        if (checkpoint || script !== 'findPickOption' || at < 1_000) return;
        if (state === 'disabled') page.original.disabled = true;
        if (state === 'aria-disabled') page.original.ariaDisabled = true;
        if (state === 'modal') page.showModal();
        if (state === 'owner-surface') page.markOwnerSurface();
        if (state === 'moved-url') vi.stubGlobal('location', { href: 'https://example.com/another-record' });
        page.original.contents = 'owner edit';
        checkpoint = { writes: page.writes.length, events: page.events.length, focuses: page.focuses.length };
      } });
      expect(checkpoint).toBeDefined();
      expect(result.calls).toContain('typeWithKeys');
      expect(p.original.value).toBe('owner edit');
      expect(p.writes.slice(checkpoint!.writes)).toEqual([]);
      expect(p.events.slice(checkpoint!.events)).toEqual([]);
      expect(p.focuses.slice(checkpoint!.focuses)).toEqual([]);
      expect(result.outcome).toMatchObject({ status: 'error', error: {
        code: state === 'owner-surface' || state === 'moved-url' ? 'tab_navigation_blocked' : 'value_not_applied',
      } });
      // The recovery refusal agrees with the existing ordinary fill check.
      const pending = fillPageField('', 'Acme', p.url, 'e2');
      await vi.advanceTimersByTimeAsync(100);
      const ordinary = await pending;
      expect('blocked' in ordinary || 'not_applied' in ordinary).toBe(true);
      expect(p.writes.slice(checkpoint!.writes)).toEqual([]);
    });

  it('checks a uniquely rebound field again before typing into it', async () => {
    const p = fixture();
    let replacement: Page['original'] | undefined;
    let checkpoint: { writes: number; events: number; focuses: number } | undefined;
    const result = await runPick(p, { after(page, script, at) {
      if (replacement || script !== 'findPickOption' || at < 1_000) return;
      replacement = page.replace(1)[0]!;
      replacement.disabled = true;
      replacement.contents = 'owner edit';
      checkpoint = { writes: page.writes.length, events: page.events.length, focuses: page.focuses.length };
    } });
    expect(replacement).toBeDefined();
    expect(replacement!.value).toBe('owner edit');
    expect(p.writes.slice(checkpoint!.writes)).toEqual([]);
    expect(p.events.slice(checkpoint!.events)).toEqual([]);
    expect(p.focuses.slice(checkpoint!.focuses)).toEqual([]);
    expect(result.outcome).toMatchObject({ status: 'error', error: { code: 'value_not_applied', message: 'This field is disabled.' } });
  });

  it('allows keyboard recovery inside the active dialog through composed ancestry', async () => {
    const p = fixture();
    let shown = false;
    const result = await runPick(p, { after(page, script, at) {
      if (shown || script !== 'findPickOption' || at < 1_000) return;
      shown = true; page.showModal(true);
    } });
    expect(shown).toBe(true);
    expect(result.calls.filter(name => name === 'typeWithKeys')).toHaveLength(1);
    expect(p.original.value).toBe('Acme');
    expect(p.writes.length).toBeGreaterThan(1);
    expect(p.other.value).toBe('keep these notes');
    const pending = fillPageField('', 'Acme', p.url, 'e2');
    await vi.advanceTimersByTimeAsync(100);
    expect(await pending).toEqual({ outputs: { filled: true } });
  });
});
