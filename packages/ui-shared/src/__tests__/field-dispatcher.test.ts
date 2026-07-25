import { describe, it, expect, vi } from 'vitest';
import { attachFieldHandlers, type FieldHandlers } from '../field-dispatcher.js';

/** Minimal fake-DOM helpers — same philosophy as the action-dispatcher
 *  test: mock only the methods the primitive actually touches rather
 *  than pulling in jsdom for one test file. */
const makeFakeElement = (
  tagName: 'INPUT' | 'SELECT' | 'TEXTAREA',
  opts: { type?: string; readonly?: boolean; value?: string; dataset?: Record<string, string> } = {},
) => {
  const listeners: Array<{ evt: string; fn: (e: Event) => void }> = [];
  const attrs = opts.readonly ? new Set(['readonly']) : new Set<string>();
  const el: HTMLElement & { fire: (evt: string) => void; events: () => string[] } = {
    tagName,
    type: opts.type ?? 'text',
    value: opts.value ?? '',
    dataset: opts.dataset ?? {},
    hasAttribute: (name: string) => attrs.has(name),
    addEventListener: (evt: string, fn: (e: Event) => void) => {
      listeners.push({ evt, fn });
    },
    fire: (evt: string) => {
      for (const l of listeners) if (l.evt === evt) l.fn({ target: el } as unknown as Event);
    },
    events: () => listeners.map((l) => l.evt),
  } as unknown as HTMLElement & { fire: (evt: string) => void; events: () => string[] };
  return el;
};

const makeFakeRoot = (byAttribute: Record<string, ReturnType<typeof makeFakeElement>[]>) => {
  return {
    querySelectorAll: (selector: string) => {
      const m = selector.match(/\[([a-z-]+)\]/);
      if (!m) return [];
      return byAttribute[m[1]] ?? [];
    },
  } as unknown as HTMLElement;
};

type K = 'data-var' | 'data-meta-field' | 'data-recipe-field' | 'data-step-field';

describe('attachFieldHandlers', () => {
  it('resolves auto event: input for text, change for select + checkbox', () => {
    const textInput = makeFakeElement('INPUT', { type: 'text' });
    const selectEl = makeFakeElement('SELECT');
    const checkbox = makeFakeElement('INPUT', { type: 'checkbox' });
    const textarea = makeFakeElement('TEXTAREA');

    const handler = vi.fn();
    const handlers: FieldHandlers<K> = {
      'data-var': handler,
      'data-meta-field': handler,
      'data-recipe-field': handler,
      'data-step-field': handler,
    };
    attachFieldHandlers(makeFakeRoot({
      'data-var': [textInput, selectEl, checkbox, textarea],
      'data-meta-field': [],
      'data-recipe-field': [],
      'data-step-field': [],
    }), handlers);

    expect((textInput as unknown as { events: () => string[] }).events()).toEqual(['input']);
    expect((selectEl as unknown as { events: () => string[] }).events()).toEqual(['change']);
    expect((checkbox as unknown as { events: () => string[] }).events()).toEqual(['change']);
    expect((textarea as unknown as { events: () => string[] }).events()).toEqual(['input']);
  });

  it('respects explicit event override', () => {
    const el = makeFakeElement('SELECT'); // select would auto → change
    const handler = vi.fn();
    const handlers: FieldHandlers<K> = {
      'data-var': { handler, event: 'input' }, // force input
      'data-meta-field': handler,
      'data-recipe-field': handler,
      'data-step-field': handler,
    };
    attachFieldHandlers(makeFakeRoot({
      'data-var': [el],
      'data-meta-field': [],
      'data-recipe-field': [],
      'data-step-field': [],
    }), handlers);
    expect((el as unknown as { events: () => string[] }).events()).toEqual(['input']);
  });

  it('invokes the handler with the matching element on the resolved event', () => {
    const el = makeFakeElement('INPUT', { type: 'text', value: 'hello' });
    const handler = vi.fn();
    const handlers: FieldHandlers<K> = {
      'data-var': handler,
      'data-meta-field': handler,
      'data-recipe-field': handler,
      'data-step-field': handler,
    };
    attachFieldHandlers(makeFakeRoot({
      'data-var': [el],
      'data-meta-field': [],
      'data-recipe-field': [],
      'data-step-field': [],
    }), handlers);
    (el as unknown as { fire: (e: string) => void }).fire('input');
    expect(handler).toHaveBeenCalledWith(el, expect.anything());
  });

  it('skips readonly elements when skipReadonly is set', () => {
    const readonlyEl = makeFakeElement('INPUT', { type: 'text', readonly: true });
    const writableEl = makeFakeElement('INPUT', { type: 'text', readonly: false });
    const handler = vi.fn();
    const handlers: FieldHandlers<K> = {
      'data-var': handler,
      'data-meta-field': handler,
      'data-recipe-field': handler,
      'data-step-field': { handler, skipReadonly: true },
    };
    attachFieldHandlers(makeFakeRoot({
      'data-var': [],
      'data-meta-field': [],
      'data-recipe-field': [],
      'data-step-field': [readonlyEl, writableEl],
    }), handlers);
    expect((readonlyEl as unknown as { events: () => string[] }).events()).toEqual([]);
    expect((writableEl as unknown as { events: () => string[] }).events()).toEqual(['input']);
  });

  it('attaches independently per attribute — one handler does not consume another', () => {
    const varEl = makeFakeElement('INPUT', { type: 'text' });
    const metaEl = makeFakeElement('INPUT', { type: 'text' });
    const onVar = vi.fn();
    const onMeta = vi.fn();
    const handlers: FieldHandlers<K> = {
      'data-var': onVar,
      'data-meta-field': onMeta,
      'data-recipe-field': () => {},
      'data-step-field': () => {},
    };
    attachFieldHandlers(makeFakeRoot({
      'data-var': [varEl],
      'data-meta-field': [metaEl],
      'data-recipe-field': [],
      'data-step-field': [],
    }), handlers);
    (varEl as unknown as { fire: (e: string) => void }).fire('input');
    expect(onVar).toHaveBeenCalledTimes(1);
    expect(onMeta).not.toHaveBeenCalled();
  });
});
