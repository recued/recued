/** D-344 slice B — Settings → AI / Models: each model's Thinking, the provider's default, off or on,
 *  on a slot and on a free-pool entry, saved as the model's `thinking` and cleared by the provider's
 *  default. The owner: "thinking on-off should be the model configuration rather than the ask-page
 *  only". Driven through the page's own controls, on a fake document as the D-174 page test is. */

import { describe, expect, it, vi } from 'vitest';

import {
  AI_MODELS_POOL_ADD_ATTR,
  AI_MODELS_POOL_ADD_FIELD_ATTR,
  AI_MODELS_POOL_EDIT_ATTR,
  AI_MODELS_POOL_SAVE_ATTR,
  AI_MODELS_SLOT_FIELD_ATTR,
  AI_MODELS_SLOT_SAVE_ATTR,
  mountAiModelsPage,
} from '../settings/ai-models-page.js';

interface FakeElement {
  tagName: string;
  textContent: string;
  disabled: boolean;
  className: string;
  value: string;
  readOnly: boolean;
  innerHTML: string;
  type: string;
  placeholder: string;
  children: FakeElement[];
  parent: FakeElement | null;
  attrs: Map<string, string>;
  listeners: Map<string, Array<(ev: unknown) => void>>;
  setAttribute(k: string, v: string): void;
  removeAttribute(k: string): void;
  getAttribute(k: string): string | null;
  hasAttribute(k: string): boolean;
  appendChild(el: FakeElement): FakeElement;
  removeChild(el: FakeElement): FakeElement;
  readonly firstChild: FakeElement | null;
  remove(): void;
  addEventListener(name: string, fn: (ev: unknown) => void): void;
  removeEventListener(name: string, fn: (ev: unknown) => void): void;
  focus?(): void;
}

const element = (tagName: string): FakeElement => {
  const listeners = new Map<string, Array<(ev: unknown) => void>>();
  const attrs = new Map<string, string>();
  const children: FakeElement[] = [];
  const el: FakeElement = {
    tagName: tagName.toUpperCase(), textContent: '', disabled: false, className: '', value: '', readOnly: false,
    innerHTML: '', type: '', placeholder: '', children, parent: null, attrs, listeners,
    setAttribute: (k, v) => { attrs.set(k, v); if (k === 'placeholder') el.placeholder = v; },
    removeAttribute: (k) => attrs.delete(k),
    getAttribute: (k) => attrs.get(k) ?? null,
    hasAttribute: (k) => attrs.has(k),
    appendChild: (next) => { children.push(next); next.parent = el; return next; },
    removeChild: (target) => { children.splice(children.indexOf(target), 1); target.parent = null; return target; },
    get firstChild() { return children[0] ?? null; },
    remove: () => { el.parent?.removeChild(el); },
    addEventListener: (name, fn) => { listeners.set(name, [...(listeners.get(name) ?? []), fn]); },
    removeEventListener: (name, fn) => { listeners.set(name, (listeners.get(name) ?? []).filter((f) => f !== fn)); },
    focus: () => undefined,
  };
  return el;
};

const find = (root: FakeElement, attr: string, value: string): FakeElement => {
  const walk = (el: FakeElement): FakeElement | null => {
    if (el.getAttribute(attr) === value) return el;
    for (const child of el.children) {
      const hit = walk(child);
      if (hit) return hit;
    }
    return null;
  };
  const hit = walk(root);
  if (!hit) throw new Error(`no element with ${attr}="${value}"`);
  return hit;
};
const fire = (el: FakeElement, name: string): void => { for (const fn of el.listeners.get(name) ?? []) fn({}); };
const choose = (el: FakeElement, value: string): void => { el.value = value; fire(el, 'change'); };
const type = (el: FakeElement, value: string): void => { el.value = value; fire(el, 'input'); };
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const mount = async () => {
  const host = element('div');
  const runSetLLMSlot = vi.fn(async () => ({ ok: true as const }));
  const runUpsertFreePoolEntry = vi.fn(async () => ({ ok: true as const }));
  const page = mountAiModelsPage({
    host: host as unknown as HTMLElement,
    document: { createElement: (tag: string) => element(tag) } as unknown as Document,
    runGetLLMConfig: vi.fn(async () => ({ config: {
      slot_1: { provider: 'openai-compatible', model: 'qwen3.7-plus', has_key: true,
        base_url: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', speed: 'fast', supports_json: true, thinking: 'off' },
      free_pool: [{ id: 'groq', type: 'api', provider: 'openai-compatible', model: 'qwen3-32b', has_key: true,
        base_url: 'https://api.groq.com/openai/v1', speed: 'fast', supports_json: true, enabled: true }],
    }, supports: { pool_entry_drafts: true } })),
    runSetLLMSlot,
    runUpsertFreePoolEntry,
    now: () => 1_700_000_000_000,
    subscribe: vi.fn(() => () => undefined),
  } as never);
  await page.whenLoaded();
  await flush();
  return { host, runSetLLMSlot, runUpsertFreePoolEntry };
};

describe('D-344 slice B — a model\'s Thinking in Settings → AI / Models', () => {
  it('a slot shows its setting, and saves a choice, or clears it with the provider\'s default', async () => {
    const { host, runSetLLMSlot } = await mount();
    const thinking = find(host, AI_MODELS_SLOT_FIELD_ATTR, 'slot_1:thinking');
    expect(thinking.value).toBe('off');
    expect(thinking.children.map((option) => [option.value, option.textContent]))
      .toEqual([['', 'Provider default'], ['off', 'Off'], ['on', 'On']]);
    choose(thinking, 'on');
    fire(find(host, AI_MODELS_SLOT_SAVE_ATTR, 'slot_1'), 'click');
    await flush();
    expect(runSetLLMSlot).toHaveBeenLastCalledWith({ slot_key: 'slot_1', slot: expect.objectContaining({ thinking: 'on' }) });
    choose(find(host, AI_MODELS_SLOT_FIELD_ATTR, 'slot_1:thinking'), '');
    fire(find(host, AI_MODELS_SLOT_SAVE_ATTR, 'slot_1'), 'click');
    await flush();
    expect((runSetLLMSlot.mock.calls.at(-1) as unknown as [{ slot: Record<string, unknown> }])[0].slot).not.toHaveProperty('thinking');
  });

  it('a slot\'s other fields saved without touching Thinking keep it', async () => {
    const { host, runSetLLMSlot } = await mount();
    type(find(host, AI_MODELS_SLOT_FIELD_ATTR, 'slot_1:model'), 'qwen3.7-max');
    fire(find(host, AI_MODELS_SLOT_SAVE_ATTR, 'slot_1'), 'click');
    await flush();
    expect(runSetLLMSlot).toHaveBeenLastCalledWith({ slot_key: 'slot_1',
      slot: expect.objectContaining({ model: 'qwen3.7-max', thinking: 'off' }) });
  });

  it('a free-pool entry saves its Thinking when edited, and a new one with it when added', async () => {
    const { host, runUpsertFreePoolEntry } = await mount();
    fire(find(host, AI_MODELS_POOL_EDIT_ATTR, 'groq'), 'click');
    await flush();
    choose(find(host, AI_MODELS_POOL_ADD_FIELD_ATTR, 'thinking'), 'off');
    fire(find(host, AI_MODELS_POOL_SAVE_ATTR, 'groq'), 'click');
    await flush();
    expect(runUpsertFreePoolEntry).toHaveBeenLastCalledWith({ entry: expect.objectContaining({ id: 'groq', thinking: 'off' }) });
    await flush();
    type(find(host, AI_MODELS_POOL_ADD_FIELD_ATTR, 'id'), 'qwen');
    type(find(host, AI_MODELS_POOL_ADD_FIELD_ATTR, 'model'), 'qwen3.7-plus');
    type(find(host, AI_MODELS_POOL_ADD_FIELD_ATTR, 'api-key'), 'sk-new');
    type(find(host, AI_MODELS_POOL_ADD_FIELD_ATTR, 'base-url'), 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1');
    choose(find(host, AI_MODELS_POOL_ADD_FIELD_ATTR, 'thinking'), 'on');
    fire(find(host, AI_MODELS_POOL_ADD_ATTR, ''), 'click');
    await flush();
    expect(runUpsertFreePoolEntry).toHaveBeenLastCalledWith({ entry: expect.objectContaining({ id: 'qwen', thinking: 'on' }) });
  });
});
