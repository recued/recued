/** D-174 D14 — Settings -> AI / Models consolidated LLM config page. */

import { describe, expect, it, vi } from 'vitest';
import {
  CHAT_CATALOG_DELIVERY_MODES,
  CHAT_CATALOG_SMART_DEFAULT_BY_SOURCE,
} from '@recued/contracts';

import type {
  HousekeepingConfigRow,
  ServerConfigField,
  ServerLlmPrompt,
} from '@recued/contracts';

import {
  AI_MODELS_ACTION_ERROR_ATTR,
  AI_MODELS_ALLOW_BYOK_TOGGLE_ATTR,
  AI_MODELS_BUDGET_INPUT_ATTR,
  AI_MODELS_BUDGET_SAVE_ATTR,
  AI_MODELS_CATALOG_MODE_SELECT_ATTR,
  AI_MODELS_CHAT_SETUP_ADVANCED_ATTR,
  AI_MODELS_CHAT_SETUP_ATTR,
  AI_MODELS_CHAT_SETUP_BASE_URL_ATTR,
  AI_MODELS_CHAT_SETUP_ERROR_ATTR,
  AI_MODELS_CHAT_SETUP_KEY_ATTR,
  AI_MODELS_CHAT_SETUP_MODEL_ATTR,
  AI_MODELS_CHAT_SETUP_PROVIDER_ATTR,
  AI_MODELS_CHAT_SETUP_SOURCE_ATTR,
  AI_MODELS_CHAT_SETUP_STATUS_ATTR,
  AI_MODELS_CHAT_SETUP_SUBMIT_ATTR,
  AI_MODELS_CONTEXT_WINDOW_INPUT_ATTR,
  AI_MODELS_CONTROL_ATTR,
  AI_MODELS_EMBEDDINGS_FIELD_ATTR,
  AI_MODELS_FAIL_LOUD_ATTR,
  AI_MODELS_MODEL_PREF_BUTTON_ATTR,
  AI_MODELS_PAUSE_BUTTON_ATTR,
  AI_MODELS_PENDING_CONTROL_ATTR,
  AI_MODELS_POOL_ADD_ATTR,
  AI_MODELS_POOL_ADD_FIELD_ATTR,
  AI_MODELS_POOL_REMOVE_CANCEL_ATTR,
  AI_MODELS_POOL_REMOVE_CONFIRM_ATTR,
  AI_MODELS_POOL_REMOVE_DIALOG_ATTR,
  AI_MODELS_POOL_REMOVE_ATTR,
  AI_MODELS_POOL_TOGGLE_ATTR,
  AI_MODELS_PROMPT_BADGE_ATTR,
  AI_MODELS_PROMPT_LOAD_DEFAULT_ATTR,
  AI_MODELS_PROMPT_SAVE_ATTR,
  AI_MODELS_PROMPT_STATUS_ATTR,
  AI_MODELS_PROMPT_TRANSPORT_ATTR,
  AI_MODELS_PROMPT_TRANSPORT_RESET_ATTR,
  AI_MODELS_PROMPT_ALWAYS_ATTR,
  AI_MODELS_PROMPT_POLICY_ATTR,
  AI_MODELS_PROMPT_SECTION_ATTR,
  AI_MODELS_PROMPT_TEXT_ATTR,
  AI_MODELS_SLOT_FIELD_ATTR,
  AI_MODELS_SLOT_TEST_ATTR,
  AI_MODELS_SLOT_TEST_RESULT_ATTR,
  AI_MODELS_PROBE_TRANSCRIPT_ATTR,
  AI_MODELS_SLOT_CLEAR_ATTR,
  AI_MODELS_SLOT_CLEAR_CANCEL_ATTR,
  AI_MODELS_SLOT_CLEAR_CONFIRM_ATTR,
  AI_MODELS_SLOT_CLEAR_DIALOG_ATTR,
  AI_MODELS_SLOT_SAVE_ATTR,
  AI_MODELS_TAB_ATTR,
  AI_MODELS_TAB_PANEL_ATTR,
  AI_MODELS_PAGE_STYLES,
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
}

const makeFakeElement = (tagName: string): FakeElement => {
  const listeners = new Map<string, Array<(ev: unknown) => void>>();
  const attrs = new Map<string, string>();
  const children: FakeElement[] = [];
  const el: FakeElement = {
    tagName: tagName.toUpperCase(),
    textContent: '',
    disabled: false,
    className: '',
    value: '',
    readOnly: false,
    innerHTML: '',
    type: '',
    placeholder: '',
    children,
    parent: null,
    attrs,
    listeners,
    setAttribute: (k, v) => {
      attrs.set(k, v);
      if (k === 'placeholder') el.placeholder = v;
    },
    removeAttribute: (k) => attrs.delete(k),
    getAttribute: (k) => attrs.get(k) ?? null,
    hasAttribute: (k) => attrs.has(k),
    appendChild: (next) => {
      children.push(next);
      next.parent = el;
      return next;
    },
    removeChild: (target) => {
      const idx = children.indexOf(target);
      if (idx < 0) throw new Error('removeChild: not a child');
      children.splice(idx, 1);
      target.parent = null;
      return target;
    },
    get firstChild() {
      return children[0] ?? null;
    },
    remove: () => {
      if (el.parent) el.parent.removeChild(el);
    },
    addEventListener: (name, fn) => {
      const arr = listeners.get(name) ?? [];
      arr.push(fn);
      listeners.set(name, arr);
    },
    removeEventListener: (name, fn) => {
      const arr = listeners.get(name);
      if (!arr) return;
      const idx = arr.indexOf(fn);
      if (idx >= 0) arr.splice(idx, 1);
    },
  };
  return el;
};

const makeFakeDocument = () => ({
  createElement: (tag: string) => makeFakeElement(tag),
});

const findByAttr = (root: FakeElement, attr: string): FakeElement | null => {
  if (root.hasAttribute(attr)) return root;
  for (const child of root.children) {
    const hit = findByAttr(child, attr);
    if (hit) return hit;
  }
  return null;
};

const findByAttrValue = (
  root: FakeElement,
  attr: string,
  value: string,
): FakeElement | null => {
  if (root.getAttribute(attr) === value) return root;
  for (const child of root.children) {
    const hit = findByAttrValue(child, attr, value);
    if (hit) return hit;
  }
  return null;
};

const findByTagText = (
  root: FakeElement,
  tagName: string,
  text: string,
): FakeElement | null => {
  if (root.tagName === tagName.toUpperCase() && root.textContent === text) {
    return root;
  }
  for (const child of root.children) {
    const hit = findByTagText(child, tagName, text);
    if (hit) return hit;
  }
  return null;
};

/** Fire the click listeners registered on the element matching attr=value. */
const clickByAttrValue = (root: FakeElement, attr: string, value: string): void => {
  const el = findByAttrValue(root, attr, value);
  if (!el) throw new Error(`no element with ${attr}="${value}"`);
  for (const fn of el.listeners.get('click') ?? []) fn({});
};

/** Set a <select>'s value + fire its change listeners (drives the DOM
 *  seam the way a user picking an option would). */
const changeSelect = (
  root: FakeElement,
  attr: string,
  value: string,
  next: string,
): void => {
  const el = findByAttrValue(root, attr, value);
  if (!el) throw new Error(`no <select> with ${attr}="${value}"`);
  el.value = next;
  for (const fn of el.listeners.get('change') ?? []) fn({});
};

const inputByAttr = (
  root: FakeElement,
  attr: string,
  value: string,
): void => {
  const el = findByAttr(root, attr);
  if (!el) throw new Error(`no input with ${attr}`);
  el.value = value;
  for (const fn of el.listeners.get('input') ?? []) fn({});
};

/** True if any node in the tree has textContent containing `needle`. */
const hasText = (root: FakeElement, needle: string): boolean => {
  if (typeof root.textContent === 'string' && root.textContent.includes(needle)) return true;
  return root.children.some((c) => hasText(c, needle));
};

/** Let queued microtasks (the surface() catch + re-render) settle. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** First <input> whose `type` property matches (masked key fields). */
const findInputByType = (root: FakeElement, type: string): FakeElement | null => {
  if (root.tagName === 'INPUT' && root.type === type) return root;
  for (const child of root.children) {
    const hit = findInputByType(child, type);
    if (hit) return hit;
  }
  return null;
};

const CHAT_ROLE_DEFAULT = 'You are Recued. You speak in plain, calm prose.';
const CORE_TEXT = 'Emit AIOutput JSON only — never wrap in markdown.';
const APPROVALS_TEXT = "Approvals: … you can't bypass approvals.";
const GATEWAY_POSTURE =
  'You are responding through Recued llm_gateway for an external contract-bound caller.';

const llmPrompts = (
  override?: Partial<ServerLlmPrompt> & { surface: ServerLlmPrompt['surface'] },
): ServerLlmPrompt[] => [
  {
    surface: 'chat',
    role_instructions: CHAT_ROLE_DEFAULT,
    default_role_instructions: CHAT_ROLE_DEFAULT,
    always_on_text: [CORE_TEXT, APPROVALS_TEXT],
    composed_preview: `${CHAT_ROLE_DEFAULT}\n${CORE_TEXT}\n\n${APPROVALS_TEXT}`,
    role: 'system',
    default_role: 'system',
    is_default: true,
    ...(override?.surface === 'chat' ? override : {}),
  },
  {
    surface: 'llm_gateway',
    role_instructions: CHAT_ROLE_DEFAULT,
    default_role_instructions: CHAT_ROLE_DEFAULT,
    always_on_text: [CORE_TEXT, APPROVALS_TEXT, GATEWAY_POSTURE],
    composed_preview: `${CHAT_ROLE_DEFAULT}\n${CORE_TEXT}\n\n${GATEWAY_POSTURE}`,
    role: 'system',
    default_role: 'system',
    is_default: true,
    caller_system_policy: 'context',
    ...(override?.surface === 'llm_gateway' ? override : {}),
  },
];

const schema = (budget: number): ServerConfigField[] => [
  {
    section: 'LLM',
    key: 'llm.budget',
    label: 'Daily token budget',
    type: 'number',
    value: budget,
    min: 0,
    integer: true,
  },
];

const housekeeping = (
  overrides: Partial<HousekeepingConfigRow> = {},
): HousekeepingConfigRow => ({
  preset: 'balanced',
  cycle_budget_ms: 60_000,
  cycle_interval_minutes: 15,
  allow_byok_background: false,
  pause_background_ai_until: null,
  updated_at: 10,
  ...overrides,
});

// The server redacts api_key off the wire (D-174 R28 Slice B) — slots /
// pool entries carry `has_key` instead. The fixtures use that redacted shape.
const llmConfig = () => ({
  slot_1: {
    provider: 'openai-compatible',
    model: 'local-model',
    has_key: true,
    base_url: 'http://127.0.0.1:11434/v1',
    speed: 'fast',
    supports_json: true,
    context_window_tokens: 128_000,
    max_output_tokens: 8_192,
  },
  free_pool: [
    {
      id: 'groq',
      type: 'api',
      provider: 'openai-compatible',
      model: 'llama-free',
      has_key: true,
      speed: 'fast',
      supports_json: true,
      enabled: true,
    },
  ],
  free_pool_strategy: 'round_robin',
});

const mountFixture = (overrides: Partial<Parameters<typeof mountAiModelsPage>[0]> = {}) => {
  const host = makeFakeElement('div');
  const doc = makeFakeDocument();
  const subscriptions = new Map<string, Array<(event: unknown) => void>>();
  const opts = {
    host: host as unknown as HTMLElement,
    document: doc as unknown as Document,
    runGetDefaultModelPref: vi.fn(async () => ({ source_id: 'slot_1' as const, updated_at: 1 })),
    runSetDefaultModelPref: vi.fn(async (args: { source_id: string }) => ({
      source_id: args.source_id as 'slot_1' | 'slot_2' | 'free_pool',
      updated_at: 2,
    })),
    runGetLLMConfig: vi.fn(async () => ({ config: llmConfig() })),
    runSetLLMSlot: vi.fn(async () => ({ ok: true as const })),
    runSetEmbeddingsSlot: vi.fn(async () => ({ ok: true as const })),
    runUpsertFreePoolEntry: vi.fn(async () => ({ ok: true as const })),
    runRemoveFreePoolEntry: vi.fn(async () => ({ ok: true as const, removed: true })),
    runSetFreePoolEntryEnabled: vi.fn(async () => ({ ok: true as const, found: true })),
    runSetChatCatalogMode: vi.fn(async () => ({ ok: true as const })),
    runGetLlmPrompts: vi.fn(async () => ({ prompts: llmPrompts() })),
    runSetLlmPrompt: vi.fn(async () => ({ ok: true as const })),
    runGetConfigSchema: vi.fn(async () => ({ schema: schema(5000) })),
    runSetConfigField: vi.fn(async () => ({ ok: true as const })),
    runReadHousekeepingConfig: vi.fn(async () => housekeeping()),
    runWriteHousekeepingConfig: vi.fn(async (args) => ({
      ok: true as const,
      effective: housekeeping({
        allow_byok_background: args.allow_byok_background ?? false,
        pause_background_ai_until: args.pause_background_ai_until ?? null,
      }),
    })),
    runCacheStats: vi.fn(async () => ({
      total_entries: 1,
      total_hits: 2,
      per_topic: [],
      last_gc_at: null,
    })),
    runCacheClear: vi.fn(async () => ({ ok: true as const, rows_deleted: 1 })),
    now: () => 1_700_000_000_000,
    subscribe: vi.fn((kind: string, cb: (event: unknown) => void) => {
      const list = subscriptions.get(kind) ?? [];
      list.push(cb);
      subscriptions.set(kind, list);
      return () => {
        const current = subscriptions.get(kind) ?? [];
        subscriptions.set(kind, current.filter((entry) => entry !== cb));
      };
    }),
    ...overrides,
  };
  const mount = mountAiModelsPage(opts);
  return { host, mount, opts, subscriptions };
};

describe('D-174 D14 — AI / Models initial load', () => {
  it('keeps internal tabs and model choices large enough for frequent touch use', () => {
    expect(AI_MODELS_PAGE_STYLES).toMatch(
      /button\.ai-models-tab\s*\{[^}]*min-height:\s*36px/s,
    );
    expect(AI_MODELS_PAGE_STYLES).toMatch(
      /\.ai-models-choice-row button\s*\{[^}]*min-height:\s*36px/s,
    );
  });

  it('reads the existing RPCs and renders pending stubs for missing backend seams', async () => {
    const { host, mount, opts } = mountFixture();
    await mount.whenLoaded();

    expect(opts.runGetDefaultModelPref).toHaveBeenCalledTimes(1);
    expect(opts.runGetLLMConfig).toHaveBeenCalledTimes(1);
    expect(opts.runGetConfigSchema).toHaveBeenCalledTimes(1);
    expect(opts.runReadHousekeepingConfig).toHaveBeenCalledTimes(1);
    expect(opts.runCacheStats).toHaveBeenCalledTimes(1);
    expect(mount.cacheCard()).not.toBeNull();
    // D-174 R28 Slice C — embeddings is now a real slot card (the setter is
    // wired), not a pending stub. R29 — the "Local-only AI" (`require_local`)
    // pending stub is DROPPED (there is no local-AI; the sources are
    // slot_1 / slot_2 / free_pool / embeddings only), so it renders nowhere.
    expect(findByAttrValue(host, AI_MODELS_SLOT_SAVE_ATTR, 'embeddings_slot')).not.toBeNull();
    expect(findByAttrValue(host, AI_MODELS_PENDING_CONTROL_ATTR, 'embeddings')).toBeNull();
    expect(findByAttrValue(host, AI_MODELS_PENDING_CONTROL_ATTR, 'require_local')).toBeNull();
    expect(mount.getState().failLoud).toBeNull();
    mount.dispose();
  });

  it('names every provider field and action by its owning source', async () => {
    const { host, mount } = mountFixture();
    await mount.whenLoaded();

    const named = (attr: string, value: string): string | null =>
      findByAttrValue(host, attr, value)?.getAttribute('aria-label') ?? null;

    expect(named(AI_MODELS_SLOT_FIELD_ATTR, 'slot_1:provider'))
      .toBe('Slot 1: fast provider');
    expect(named(AI_MODELS_SLOT_FIELD_ATTR, 'slot_2:model'))
      .toBe('Slot 2: quality / thinking model');
    expect(named(AI_MODELS_SLOT_SAVE_ATTR, 'slot_1'))
      .toBe('Save Slot 1: fast');
    expect(named(AI_MODELS_SLOT_CLEAR_ATTR, 'slot_2'))
      .toBe('Clear Slot 2: quality / thinking');
    expect(named(AI_MODELS_EMBEDDINGS_FIELD_ATTR, 'provider'))
      .toBe('Embeddings slot provider');
    expect(named(AI_MODELS_SLOT_SAVE_ATTR, 'embeddings_slot'))
      .toBe('Save Embeddings slot');
    expect(named(AI_MODELS_SLOT_CLEAR_ATTR, 'embeddings_slot'))
      .toBe('Clear Embeddings slot');

    expect(named(AI_MODELS_CATALOG_MODE_SELECT_ATTR, 'slot_1'))
      .toBe('Slot 1: fast chat tool catalog');
    expect(named(AI_MODELS_CATALOG_MODE_SELECT_ATTR, 'slot_2'))
      .toBe('Slot 2: quality / thinking chat tool catalog');
    expect(named(AI_MODELS_CATALOG_MODE_SELECT_ATTR, 'free_pool'))
      .toBe('Free pool chat tool catalog');

    expect(named(AI_MODELS_POOL_TOGGLE_ATTR, 'groq'))
      .toBe('Disable free-pool entry groq');
    expect(named(AI_MODELS_POOL_REMOVE_ATTR, 'groq'))
      .toBe('Remove free-pool entry groq');
    expect(named(AI_MODELS_POOL_ADD_FIELD_ATTR, 'provider'))
      .toBe('New free-pool entry provider');
    expect(named(AI_MODELS_POOL_ADD_ATTR, ''))
      .toBe('Add free-pool API entry');
    mount.dispose();
  });

  it('exposes one roving tab stop with linked tabpanels', async () => {
    const { host, mount } = mountFixture();
    await mount.whenLoaded();

    const preference = findByAttrValue(host, AI_MODELS_TAB_ATTR, 'preference')!;
    const providers = findByAttrValue(host, AI_MODELS_TAB_ATTR, 'providers')!;
    const providersPanel = findByAttrValue(
      host,
      AI_MODELS_TAB_PANEL_ATTR,
      'providers',
    )!;
    expect(preference.getAttribute('tabindex')).toBe('0');
    expect(providers.getAttribute('tabindex')).toBe('-1');
    expect(providers.getAttribute('aria-controls')).toBe(
      providersPanel.getAttribute('id'),
    );
    expect(providersPanel.getAttribute('role')).toBe('tabpanel');
    expect(providersPanel.getAttribute('aria-labelledby')).toBe(
      providers.getAttribute('id'),
    );

    const preventDefault = vi.fn();
    for (const listener of preference.listeners.get('keydown') ?? []) {
      listener({ key: 'ArrowRight', preventDefault });
    }
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(preference.getAttribute('tabindex')).toBe('-1');
    expect(providers.getAttribute('aria-selected')).toBe('true');
    expect(providers.getAttribute('tabindex')).toBe('0');
    expect(providersPanel.getAttribute('data-active')).toBe('true');
    mount.dispose();
  });

  it('surfaces D-167 fail-loud when the current preference cannot resolve', async () => {
    const { host, mount } = mountFixture({
      // The stored default points at slot_2, but only slot_1 is configured →
      // the default can't resolve to a configured source → fail loud.
      runGetDefaultModelPref: vi.fn(async () => ({
        source_id: 'slot_2' as const,
        updated_at: 1,
      })),
      runGetLLMConfig: vi.fn(async () => ({
        config: {
          slot_1: {
            provider: 'anthropic',
            model: 'claude',
            has_key: true,
            speed: 'quality',
          },
        },
      })),
    });
    await mount.whenLoaded();

    expect(mount.getState().failLoud).toMatch(/No AI model is available/);
    expect(findByAttr(host, AI_MODELS_FAIL_LOUD_ATTR)).not.toBeNull();
    mount.dispose();
  });
});

describe('Set up Chat — focused first-run journey', () => {
  it('loads only setup state, saves slot_1 + the default, then returns to Chat', async () => {
    const onChatSetupComplete = vi.fn();
    const { host, mount, opts } = mountFixture({
      initialView: 'chat-setup',
      onChatSetupComplete,
      chatSetupReturnHref: '#chat/session/chat%2Fone',
      runGetDefaultModelPref: vi.fn(async () => ({
        source_id: null,
        updated_at: 0,
      })),
      runGetLLMConfig: vi.fn(async () => ({ config: {} })),
    });
    await mount.whenLoaded();

    expect(findByAttr(host, AI_MODELS_CHAT_SETUP_ATTR)).not.toBeNull();
    expect(findByAttr(host, AI_MODELS_CHAT_SETUP_PROVIDER_ATTR)?.value).toBe('openai');
    expect(findByAttr(host, AI_MODELS_CHAT_SETUP_MODEL_ATTR)?.value).toBe('gpt-4.1-mini');
    expect(findByAttr(host, AI_MODELS_TAB_ATTR)).toBeNull();
    expect(opts.runGetLlmPrompts).not.toHaveBeenCalled();
    expect(opts.runGetConfigSchema).not.toHaveBeenCalled();
    expect(opts.runReadHousekeepingConfig).not.toHaveBeenCalled();
    expect(opts.runCacheStats).not.toHaveBeenCalled();

    const advanced = findByAttr(host, AI_MODELS_CHAT_SETUP_ADVANCED_ATTR);
    expect(advanced?.getAttribute('href')).toBe('#settings/ai-models');
    expect(findByTagText(host, 'a', 'Back to Chat')?.getAttribute('href'))
      .toBe('#chat/session/chat%2Fone');
    inputByAttr(host, AI_MODELS_CHAT_SETUP_KEY_ATTR, 'sk-setup');
    clickByAttrValue(host, AI_MODELS_CHAT_SETUP_SUBMIT_ATTR, 'new');
    await flush();

    expect(opts.runSetLLMSlot).toHaveBeenCalledWith({
      slot_key: 'slot_1',
      slot: expect.objectContaining({
        provider: 'openai',
        model: 'gpt-4.1-mini',
        api_key: 'sk-setup',
        speed: 'fast',
      }),
    });
    expect(opts.runSetDefaultModelPref).toHaveBeenCalledWith({
      source_id: 'slot_1',
    });
    expect(onChatSetupComplete).toHaveBeenCalledTimes(1);
    expect(
      findByAttrValue(host, AI_MODELS_CHAT_SETUP_STATUS_ATTR, 'ready'),
    ).not.toBeNull();
    expect(findByTagText(host, 'a', 'Start chatting')?.getAttribute('href'))
      .toBe('#chat/session/chat%2Fone');
    mount.dispose();
  });

  it('does not submit a model while its IME composition is active', async () => {
    const { host, mount, opts } = mountFixture({
      initialView: 'chat-setup',
      runGetDefaultModelPref: vi.fn(async () => ({
        source_id: null,
        updated_at: 0,
      })),
      runGetLLMConfig: vi.fn(async () => ({ config: {} })),
    });
    await mount.whenLoaded();

    inputByAttr(host, AI_MODELS_CHAT_SETUP_MODEL_ATTR, '会話モデル');
    inputByAttr(host, AI_MODELS_CHAT_SETUP_KEY_ATTR, 'sk-ime-test');
    const model = findByAttr(host, AI_MODELS_CHAT_SETUP_MODEL_ATTR)!;
    const composingPreventDefault = vi.fn();
    for (const listener of model.listeners.get('keydown') ?? []) {
      listener({
        key: 'Enter',
        isComposing: true,
        preventDefault: composingPreventDefault,
      });
    }
    expect(composingPreventDefault).not.toHaveBeenCalled();
    expect(opts.runSetLLMSlot).not.toHaveBeenCalled();

    const submitPreventDefault = vi.fn();
    for (const listener of model.listeners.get('keydown') ?? []) {
      listener({
        key: 'Enter',
        isComposing: false,
        preventDefault: submitPreventDefault,
      });
    }
    expect(submitPreventDefault).toHaveBeenCalledTimes(1);
    expect(opts.runSetLLMSlot).toHaveBeenCalledTimes(1);
    await flush();
    mount.dispose();
  });

  it('owns and serializes both writes in the new-source handoff', async () => {
    let resolveSlot!: (value: { ok: true }) => void;
    let resolvePreference!: (value: {
      source_id: 'slot_1';
      updated_at: number;
    }) => void;
    const runSetLLMSlot = vi.fn(
      () => new Promise<{ ok: true }>((resolve) => {
        resolveSlot = resolve;
      }),
    );
    const runSetDefaultModelPref = vi.fn(
      () => new Promise<{
        source_id: 'slot_1';
        updated_at: number;
      }>((resolve) => {
        resolvePreference = resolve;
      }),
    );
    const onChatSetupComplete = vi.fn();
    const { host, mount } = mountFixture({
      initialView: 'chat-setup',
      onChatSetupComplete,
      runGetDefaultModelPref: vi.fn(async () => ({
        source_id: null,
        updated_at: 0,
      })),
      runGetLLMConfig: vi.fn(async () => ({ config: {} })),
      runSetLLMSlot,
      runSetDefaultModelPref,
    });
    await mount.whenLoaded();
    expect(mount.hasInFlightWork()).toBe(false);

    inputByAttr(host, AI_MODELS_CHAT_SETUP_KEY_ATTR, 'sk-setup');
    clickByAttrValue(host, AI_MODELS_CHAT_SETUP_SUBMIT_ATTR, 'new');
    expect(mount.hasInFlightWork()).toBe(true);

    const saving = findByAttrValue(
      host,
      AI_MODELS_CHAT_SETUP_SUBMIT_ATTR,
      'new',
    );
    expect(saving?.textContent).toBe('Saving setup…');
    expect(saving?.getAttribute('aria-disabled')).toBe('true');
    expect(saving?.getAttribute('aria-busy')).toBe('true');
    expect(saving?.disabled).toBe(false);
    expect(findByAttr(host, AI_MODELS_CHAT_SETUP_PROVIDER_ATTR)?.disabled)
      .toBe(true);
    expect(findByAttr(host, AI_MODELS_CHAT_SETUP_KEY_ATTR)?.readOnly)
      .toBe(true);
    clickByAttrValue(host, AI_MODELS_CHAT_SETUP_SUBMIT_ATTR, 'new');
    expect(runSetLLMSlot).toHaveBeenCalledTimes(1);
    expect(runSetDefaultModelPref).not.toHaveBeenCalled();

    resolveSlot({ ok: true });
    await flush();
    const finishing = findByAttrValue(
      host,
      AI_MODELS_CHAT_SETUP_STATUS_ATTR,
      'saving',
    );
    expect(finishing?.textContent).toBe('Finishing Chat setup…');
    expect(finishing?.getAttribute('role')).toBe('status');
    expect(finishing?.getAttribute('tabindex')).toBe('-1');
    expect(runSetDefaultModelPref).toHaveBeenCalledTimes(1);
    expect(onChatSetupComplete).not.toHaveBeenCalled();
    expect(mount.hasInFlightWork()).toBe(true);

    resolvePreference({ source_id: 'slot_1', updated_at: 1 });
    await flush();
    expect(
      findByAttrValue(host, AI_MODELS_CHAT_SETUP_STATUS_ATTR, 'ready'),
    ).not.toBeNull();
    expect(runSetLLMSlot).toHaveBeenCalledTimes(1);
    expect(runSetDefaultModelPref).toHaveBeenCalledTimes(1);
    expect(onChatSetupComplete).toHaveBeenCalledTimes(1);
    expect(mount.hasInFlightWork()).toBe(false);
    mount.dispose();
  });

  it('keeps validation local and does not write an empty key', async () => {
    const { host, mount, opts } = mountFixture({
      initialView: 'chat-setup',
      runGetDefaultModelPref: vi.fn(async () => ({
        source_id: null,
        updated_at: 0,
      })),
      runGetLLMConfig: vi.fn(async () => ({ config: {} })),
    });
    await mount.whenLoaded();

    clickByAttrValue(host, AI_MODELS_CHAT_SETUP_SUBMIT_ATTR, 'new');
    expect(findByAttr(host, AI_MODELS_CHAT_SETUP_ERROR_ATTR)?.textContent)
      .toContain('API key');
    expect(opts.runSetLLMSlot).not.toHaveBeenCalled();
    expect(opts.runSetDefaultModelPref).not.toHaveBeenCalled();
    mount.dispose();
  });

  it('requires and saves the base URL for an OpenAI-compatible endpoint', async () => {
    const { host, mount, opts } = mountFixture({
      initialView: 'chat-setup',
      runGetDefaultModelPref: vi.fn(async () => ({
        source_id: null,
        updated_at: 0,
      })),
      runGetLLMConfig: vi.fn(async () => ({ config: {} })),
    });
    await mount.whenLoaded();

    changeSelect(
      host,
      AI_MODELS_CHAT_SETUP_PROVIDER_ATTR,
      '',
      'openai-compatible',
    );
    inputByAttr(host, AI_MODELS_CHAT_SETUP_MODEL_ATTR, 'local-chat');
    inputByAttr(host, AI_MODELS_CHAT_SETUP_KEY_ATTR, 'local-key');
    clickByAttrValue(host, AI_MODELS_CHAT_SETUP_SUBMIT_ATTR, 'new');
    expect(findByAttr(host, AI_MODELS_CHAT_SETUP_ERROR_ATTR)?.textContent)
      .toContain('base URL');
    expect(opts.runSetLLMSlot).not.toHaveBeenCalled();

    inputByAttr(
      host,
      AI_MODELS_CHAT_SETUP_BASE_URL_ATTR,
      'http://127.0.0.1:11434/v1',
    );
    clickByAttrValue(host, AI_MODELS_CHAT_SETUP_SUBMIT_ATTR, 'new');
    await flush();
    expect(opts.runSetLLMSlot).toHaveBeenCalledWith({
      slot_key: 'slot_1',
      slot: expect.objectContaining({
        provider: 'openai-compatible',
        model: 'local-chat',
        api_key: 'local-key',
        base_url: 'http://127.0.0.1:11434/v1',
      }),
    });
    mount.dispose();
  });

  it('rejects a malformed compatible Base URL before saving', async () => {
    const { host, mount, opts } = mountFixture({
      initialView: 'chat-setup',
      runGetDefaultModelPref: vi.fn(async () => ({
        source_id: null,
        updated_at: 0,
      })),
      runGetLLMConfig: vi.fn(async () => ({ config: {} })),
    });
    await mount.whenLoaded();

    changeSelect(
      host,
      AI_MODELS_CHAT_SETUP_PROVIDER_ATTR,
      '',
      'openai-compatible',
    );
    inputByAttr(host, AI_MODELS_CHAT_SETUP_MODEL_ATTR, 'local-chat');
    inputByAttr(host, AI_MODELS_CHAT_SETUP_KEY_ATTR, 'local-key');
    inputByAttr(
      host,
      AI_MODELS_CHAT_SETUP_BASE_URL_ATTR,
      'localhost:11434/v1',
    );
    clickByAttrValue(host, AI_MODELS_CHAT_SETUP_SUBMIT_ATTR, 'new');

    expect(findByAttr(host, AI_MODELS_CHAT_SETUP_ERROR_ATTR)?.textContent)
      .toContain('http:// or https://');
    expect(opts.runSetLLMSlot).not.toHaveBeenCalled();
    mount.dispose();
  });

  it('clears the masked key when the provider changes', async () => {
    const { host, mount, opts } = mountFixture({
      initialView: 'chat-setup',
      runGetDefaultModelPref: vi.fn(async () => ({
        source_id: null,
        updated_at: 0,
      })),
      runGetLLMConfig: vi.fn(async () => ({ config: {} })),
    });
    await mount.whenLoaded();

    inputByAttr(host, AI_MODELS_CHAT_SETUP_KEY_ATTR, 'sk-openai');
    changeSelect(host, AI_MODELS_CHAT_SETUP_PROVIDER_ATTR, '', 'anthropic');
    expect(findByAttr(host, AI_MODELS_CHAT_SETUP_KEY_ATTR)?.value).toBe('');
    clickByAttrValue(host, AI_MODELS_CHAT_SETUP_SUBMIT_ATTR, 'new');

    expect(findByAttr(host, AI_MODELS_CHAT_SETUP_ERROR_ATTR)?.textContent)
      .toContain('API key');
    expect(opts.runSetLLMSlot).not.toHaveBeenCalled();
    mount.dispose();
  });

  it('clears a stale custom endpoint when saving a standard provider', async () => {
    const { host, mount, opts } = mountFixture({
      initialView: 'chat-setup',
      runGetDefaultModelPref: vi.fn(async () => ({
        source_id: null,
        updated_at: 0,
      })),
      runGetLLMConfig: vi.fn(async () => ({
        config: {
          slot_1: {
            provider: 'openai-compatible',
            model: 'old-model',
            base_url: 'https://old-endpoint.invalid/v1',
            has_key: false,
          },
        },
      })),
    });
    await mount.whenLoaded();

    inputByAttr(host, AI_MODELS_CHAT_SETUP_KEY_ATTR, 'sk-openai');
    clickByAttrValue(host, AI_MODELS_CHAT_SETUP_SUBMIT_ATTR, 'new');
    await flush();

    const written = vi.mocked(opts.runSetLLMSlot).mock.calls[0]![0].slot;
    expect(written).not.toHaveProperty('base_url');
    mount.dispose();
  });

  it('recognizes an already-selected source instead of asking for its key again', async () => {
    const { host, mount } = mountFixture({ initialView: 'chat-setup' });
    await mount.whenLoaded();

    expect(
      findByAttrValue(host, AI_MODELS_CHAT_SETUP_STATUS_ATTR, 'ready'),
    ).not.toBeNull();
    expect(hasText(host, 'Fast · openai-compatible')).toBe(true);
    expect(findByAttr(host, AI_MODELS_CHAT_SETUP_KEY_ATTR)).toBeNull();
    mount.dispose();
  });

  it('fails closed when the current LLM config cannot be read', async () => {
    const { host, mount, opts } = mountFixture({
      initialView: 'chat-setup',
      runGetLLMConfig: vi.fn(async () => {
        throw new Error('offline');
      }),
    });
    await mount.whenLoaded();

    expect(findByAttr(host, AI_MODELS_CHAT_SETUP_ERROR_ATTR)?.textContent)
      .toContain('Could not read');
    expect(hasText(host, 'Try again')).toBe(true);
    expect(findByAttr(host, AI_MODELS_CHAT_SETUP_KEY_ATTR)).toBeNull();
    expect(opts.runSetLLMSlot).not.toHaveBeenCalled();
    mount.dispose();
  });

  it('shows a stable finishing state while selecting an existing source', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const onChatSetupComplete = vi.fn();
    const { host, mount } = mountFixture({
      initialView: 'chat-setup',
      onChatSetupComplete,
      runGetDefaultModelPref: vi.fn(async () => ({
        source_id: null,
        updated_at: 0,
      })),
      runSetDefaultModelPref: vi.fn(async ({ source_id }) => {
        await gate;
        return { source_id, updated_at: 1 };
      }),
    });
    await mount.whenLoaded();

    expect(findByAttr(host, AI_MODELS_CHAT_SETUP_SOURCE_ATTR)).not.toBeNull();
    clickByAttrValue(host, AI_MODELS_CHAT_SETUP_SUBMIT_ATTR, 'existing');
    expect(
      findByAttrValue(host, AI_MODELS_CHAT_SETUP_STATUS_ATTR, 'saving'),
    ).not.toBeNull();
    expect(findByAttr(host, AI_MODELS_CHAT_SETUP_KEY_ATTR)).toBeNull();

    release();
    await flush();
    expect(onChatSetupComplete).toHaveBeenCalledTimes(1);
    mount.dispose();
  });
});

describe('D-174 D14 — AI / Models write-through controls', () => {
  it('keeps model preference selection focusable, busy, and single-flight', async () => {
    let resolvePreference!: (value: {
      source_id: 'slot_1' | 'slot_2' | 'free_pool';
      updated_at: number;
    }) => void;
    const runSetDefaultModelPref = vi.fn(
      () => new Promise<{
        source_id: 'slot_1' | 'slot_2' | 'free_pool';
        updated_at: number;
      }>((resolve) => {
        resolvePreference = resolve;
      }),
    );
    const { host, mount } = mountFixture({ runSetDefaultModelPref });
    await mount.whenLoaded();
    expect(mount.hasInFlightWork()).toBe(false);

    clickByAttrValue(host, AI_MODELS_MODEL_PREF_BUTTON_ATTR, 'free_pool');
    const pending = findByAttrValue(
      host,
      AI_MODELS_MODEL_PREF_BUTTON_ATTR,
      'free_pool',
    );
    const sibling = findByAttrValue(
      host,
      AI_MODELS_MODEL_PREF_BUTTON_ATTR,
      'slot_1',
    );
    expect(pending?.textContent).toContain('Selecting ');
    expect(pending?.getAttribute('aria-disabled')).toBe('true');
    expect(pending?.getAttribute('aria-busy')).toBe('true');
    expect(pending?.disabled).toBe(false);
    expect(sibling?.getAttribute('aria-disabled')).toBe('true');
    expect(sibling?.getAttribute('aria-busy')).toBeNull();
    expect(mount.hasInFlightWork()).toBe(true);
    clickByAttrValue(host, AI_MODELS_MODEL_PREF_BUTTON_ATTR, 'free_pool');
    clickByAttrValue(host, AI_MODELS_MODEL_PREF_BUTTON_ATTR, 'slot_1');
    expect(runSetDefaultModelPref).toHaveBeenCalledTimes(1);

    resolvePreference({ source_id: 'free_pool', updated_at: 2 });
    await flush();
    const selected = findByAttrValue(
      host,
      AI_MODELS_MODEL_PREF_BUTTON_ATTR,
      'free_pool',
    );
    expect(selected?.textContent).toContain('Selected:');
    expect(selected?.getAttribute('aria-disabled')).toBeNull();
    expect(selected?.getAttribute('aria-busy')).toBeNull();
    expect(mount.hasInFlightWork()).toBe(false);
    mount.dispose();
  });

  it('keeps BYOK slot save focusable, busy, and single-flight', async () => {
    let resolveSave!: (value: { ok: true }) => void;
    const runSetLLMSlot = vi.fn(
      () => new Promise<{ ok: true }>((resolve) => {
        resolveSave = resolve;
      }),
    );
    const { host, mount } = mountFixture({ runSetLLMSlot });
    await mount.whenLoaded();

    clickByAttrValue(host, AI_MODELS_SLOT_SAVE_ATTR, 'slot_1');
    const pending = findByAttrValue(host, AI_MODELS_SLOT_SAVE_ATTR, 'slot_1');
    const sibling = findByAttrValue(host, AI_MODELS_SLOT_SAVE_ATTR, 'slot_2');
    const clear = findByAttrValue(host, AI_MODELS_SLOT_CLEAR_ATTR, 'slot_1');
    expect(pending?.textContent).toBe('Saving slot…');
    expect(pending?.getAttribute('aria-disabled')).toBe('true');
    expect(pending?.getAttribute('aria-busy')).toBe('true');
    expect(pending?.disabled).toBe(false);
    expect(sibling?.getAttribute('aria-disabled')).toBe('true');
    expect(clear?.getAttribute('aria-disabled')).toBe('true');
    expect(findByAttrValue(
      host,
      AI_MODELS_SLOT_FIELD_ATTR,
      'slot_1:model',
    )?.readOnly).toBe(true);
    clickByAttrValue(host, AI_MODELS_SLOT_SAVE_ATTR, 'slot_1');
    clickByAttrValue(host, AI_MODELS_SLOT_CLEAR_ATTR, 'slot_1');
    expect(runSetLLMSlot).toHaveBeenCalledTimes(1);

    resolveSave({ ok: true });
    await flush();
    const settled = findByAttrValue(host, AI_MODELS_SLOT_SAVE_ATTR, 'slot_1');
    expect(settled?.textContent).toBe('Save slot');
    expect(settled?.getAttribute('aria-disabled')).toBeNull();
    expect(settled?.getAttribute('aria-busy')).toBeNull();
    mount.dispose();
  });

  it('requires labelled confirmation before clearing a BYOK slot', async () => {
    const { host, mount, opts } = mountFixture();
    await mount.whenLoaded();

    clickByAttrValue(host, AI_MODELS_SLOT_CLEAR_ATTR, 'slot_1');
    const dialog = findByAttrValue(
      host,
      AI_MODELS_SLOT_CLEAR_DIALOG_ATTR,
      'slot_1',
    );
    expect(dialog?.getAttribute('role')).toBe('alertdialog');
    expect(dialog?.getAttribute('aria-modal')).toBe('true');
    expect(dialog?.getAttribute('aria-labelledby')).not.toBeNull();
    expect(dialog?.getAttribute('aria-describedby')).not.toBeNull();
    expect(hasText(dialog!, 'Clear Slot 1: fast?')).toBe(true);
    expect(hasText(dialog!, 'saved provider settings and API key')).toBe(true);
    expect(opts.runSetLLMSlot).not.toHaveBeenCalled();

    clickByAttrValue(host, AI_MODELS_SLOT_CLEAR_CANCEL_ATTR, 'slot_1');
    expect(findByAttr(host, AI_MODELS_SLOT_CLEAR_DIALOG_ATTR)).toBeNull();
    expect(opts.runSetLLMSlot).not.toHaveBeenCalled();

    clickByAttrValue(host, AI_MODELS_SLOT_CLEAR_ATTR, 'slot_1');
    clickByAttrValue(host, AI_MODELS_SLOT_CLEAR_CONFIRM_ATTR, 'slot_1');
    await flush();
    expect(opts.runSetLLMSlot).toHaveBeenCalledTimes(1);
    expect(opts.runSetLLMSlot).toHaveBeenLastCalledWith({
      slot_key: 'slot_1',
      slot: null,
    });
    expect(findByAttr(host, AI_MODELS_SLOT_CLEAR_DIALOG_ATTR)).toBeNull();
    mount.dispose();
  });

  it('keeps a confirmed BYOK slot clear owned and single-flight through failure', async () => {
    let rejectClear!: (reason: Error) => void;
    const runSetLLMSlot = vi.fn(
      () => new Promise<{ ok: true }>((_resolve, reject) => {
        rejectClear = reject;
      }),
    );
    const { host, mount } = mountFixture({ runSetLLMSlot });
    await mount.whenLoaded();

    clickByAttrValue(host, AI_MODELS_SLOT_CLEAR_ATTR, 'slot_1');
    clickByAttrValue(host, AI_MODELS_SLOT_CLEAR_CONFIRM_ATTR, 'slot_1');
    const pendingDialog = findByAttrValue(
      host,
      AI_MODELS_SLOT_CLEAR_DIALOG_ATTR,
      'slot_1',
    );
    const pendingConfirm = findByAttrValue(
      host,
      AI_MODELS_SLOT_CLEAR_CONFIRM_ATTR,
      'slot_1',
    );
    const pendingCancel = findByAttrValue(
      host,
      AI_MODELS_SLOT_CLEAR_CANCEL_ATTR,
      'slot_1',
    );
    expect(pendingDialog?.getAttribute('aria-busy')).toBe('true');
    expect(pendingConfirm?.textContent).toBe('Clearing slot…');
    expect(pendingConfirm?.getAttribute('aria-disabled')).toBe('true');
    expect(pendingConfirm?.getAttribute('aria-busy')).toBe('true');
    expect(pendingConfirm?.disabled).toBe(false);
    expect(pendingCancel?.getAttribute('aria-disabled')).toBe('true');
    expect(pendingCancel?.disabled).toBe(false);
    clickByAttrValue(host, AI_MODELS_SLOT_CLEAR_CONFIRM_ATTR, 'slot_1');
    clickByAttrValue(host, AI_MODELS_SLOT_CLEAR_CANCEL_ATTR, 'slot_1');
    expect(runSetLLMSlot).toHaveBeenCalledTimes(1);
    expect(findByAttr(host, AI_MODELS_SLOT_CLEAR_DIALOG_ATTR)).not.toBeNull();

    rejectClear(new Error('clear failed'));
    await flush();
    const retry = findByAttrValue(
      host,
      AI_MODELS_SLOT_CLEAR_CONFIRM_ATTR,
      'slot_1',
    );
    expect(findByAttr(host, AI_MODELS_SLOT_CLEAR_DIALOG_ATTR)).not.toBeNull();
    expect(hasText(host, 'clear failed')).toBe(true);
    expect(retry?.textContent).toBe('Clear slot');
    expect(retry?.getAttribute('aria-disabled')).toBeNull();
    expect(retry?.getAttribute('aria-busy')).toBeNull();
    clickByAttrValue(host, AI_MODELS_SLOT_CLEAR_CANCEL_ATTR, 'slot_1');
    expect(findByAttr(host, AI_MODELS_SLOT_CLEAR_DIALOG_ATTR)).toBeNull();
    mount.dispose();
  });

  it('routes embeddings Clear through the shared labelled confirmation', async () => {
    const { host, mount, opts } = mountFixture();
    await mount.whenLoaded();

    clickByAttrValue(host, AI_MODELS_SLOT_CLEAR_ATTR, 'embeddings_slot');
    const dialog = findByAttrValue(
      host,
      AI_MODELS_SLOT_CLEAR_DIALOG_ATTR,
      'embeddings_slot',
    );
    expect(dialog?.getAttribute('role')).toBe('alertdialog');
    expect(dialog?.getAttribute('aria-modal')).toBe('true');
    expect(hasText(dialog!, 'Clear Embeddings slot?')).toBe(true);
    expect(hasText(dialog!, 'saved provider settings and API key')).toBe(true);
    expect(opts.runSetEmbeddingsSlot).not.toHaveBeenCalled();

    clickByAttrValue(
      host,
      AI_MODELS_SLOT_CLEAR_CANCEL_ATTR,
      'embeddings_slot',
    );
    expect(findByAttr(host, AI_MODELS_SLOT_CLEAR_DIALOG_ATTR)).toBeNull();
    expect(opts.runSetEmbeddingsSlot).not.toHaveBeenCalled();

    clickByAttrValue(host, AI_MODELS_SLOT_CLEAR_ATTR, 'embeddings_slot');
    clickByAttrValue(
      host,
      AI_MODELS_SLOT_CLEAR_CONFIRM_ATTR,
      'embeddings_slot',
    );
    await flush();
    expect(opts.runSetEmbeddingsSlot).toHaveBeenCalledTimes(1);
    expect(opts.runSetEmbeddingsSlot).toHaveBeenLastCalledWith({ slot: null });
    expect(findByAttr(host, AI_MODELS_SLOT_CLEAR_DIALOG_ATTR)).toBeNull();
    mount.dispose();
  });

  it('writes model preference and reflects the live broadcast', async () => {
    const { mount, opts, subscriptions } = mountFixture();
    await mount.whenLoaded();

    // The picker speaks source_id directly — the rpc persists the chosen id
    // (the server resolves source_id → {layer, model_hint} live).
    await mount.setModelPreference('slot_1');
    expect(opts.runSetDefaultModelPref).toHaveBeenCalledWith({ source_id: 'slot_1' });
    const writtenPref = mount.getState().modelPreference;
    expect(writtenPref.kind).toBe('resolved');
    if (writtenPref.kind === 'resolved') {
      expect(writtenPref.source_id).toBe('slot_1');
      expect(writtenPref.options.find((o) => o.selected)!.id).toBe('slot_1');
    }

    // The broadcast carries source_id (canonical) + a resolved {layer,model_hint}
    // snapshot; the Settings picker keys on source_id.
    subscriptions.get('chat.default_model_pref_changed')![0]!({
      kind: 'chat.default_model_pref_changed',
      source_id: 'free_pool',
      layer: 'free_pool',
      updated_at: 7,
    });
    const pref = mount.getState().modelPreference;
    expect(pref.kind).toBe('resolved');
    if (pref.kind === 'resolved') expect(pref.source_id).toBe('free_pool');
    mount.dispose();
  });

  it('writes BYOK slots + free-pool management through the field-level RPCs', async () => {
    const { mount, opts } = mountFixture();
    await mount.whenLoaded();

    await mount.saveByokSlot('slot_2', {
      provider: 'anthropic',
      model: 'claude-3',
      api_key: 'sk-ant',
      speed: 'thinking',
    });
    // Only slot_2 crosses the wire — slot_1 is NOT resent (the two-tab
    // clobber fix): the call carries just this slot, not the whole config.
    expect(opts.runSetLLMSlot).toHaveBeenLastCalledWith({
      slot_key: 'slot_2',
      slot: expect.objectContaining({
        provider: 'anthropic',
        model: 'claude-3',
        api_key: 'sk-ant',
        speed: 'thinking',
      }),
    });

    await mount.setFreePoolEntryEnabled('groq', false);
    expect(opts.runSetFreePoolEntryEnabled).toHaveBeenLastCalledWith({
      id: 'groq',
      enabled: false,
    });

    await mount.addFreePoolApiEntry({
      id: 'openrouter',
      provider: 'openai-compatible',
      model: 'free-model',
      api_key: 'or-key',
      base_url: 'https://openrouter.ai/api/v1',
    });
    expect(opts.runUpsertFreePoolEntry).toHaveBeenLastCalledWith({
      entry: expect.objectContaining({
        id: 'openrouter',
        type: 'api',
        enabled: true,
      }),
    });
    mount.dispose();
  });

  it('clears a slot via setLLMSlot with slot:null', async () => {
    const { mount, opts } = mountFixture();
    await mount.whenLoaded();
    await mount.clearByokSlot('slot_1');
    expect(opts.runSetLLMSlot).toHaveBeenLastCalledWith({ slot_key: 'slot_1', slot: null });
    mount.dispose();
  });

  it('preserves a sibling provider draft while a slot save rerenders', async () => {
    const { host, mount } = mountFixture();
    await mount.whenLoaded();

    const siblingModel = findByAttrValue(
      host,
      AI_MODELS_SLOT_FIELD_ATTR,
      'slot_2:model',
    )!;
    siblingModel.value = 'draft-model-id';
    for (const listener of siblingModel.listeners.get('input') ?? []) listener({});

    clickByAttrValue(host, AI_MODELS_SLOT_SAVE_ATTR, 'slot_1');
    await flush();
    expect(findByAttrValue(
      host,
      AI_MODELS_SLOT_FIELD_ATTR,
      'slot_2:model',
    )?.value).toBe('draft-model-id');
    mount.dispose();
  });

  it('preserves an embeddings draft across a sibling provider action', async () => {
    const { host, mount, opts } = mountFixture();
    await mount.whenLoaded();

    const values: ReadonlyArray<readonly [string, string]> = [
      ['provider', 'openai-compatible'],
      ['model', 'text-embedding-demo'],
      ['api-key', 'embedding-secret'],
      ['base-url', 'https://embeddings.example.test/v1'],
    ];
    for (const [field, value] of values) {
      const input = findByAttrValue(
        host,
        AI_MODELS_EMBEDDINGS_FIELD_ATTR,
        field,
      )!;
      input.value = value;
      for (const listener of input.listeners.get('input') ?? []) listener({});
    }

    clickByAttrValue(host, AI_MODELS_POOL_TOGGLE_ATTR, 'groq');
    await flush();
    expect(findByAttrValue(
      host,
      AI_MODELS_EMBEDDINGS_FIELD_ATTR,
      'model',
    )?.value).toBe('text-embedding-demo');
    expect(findByAttrValue(
      host,
      AI_MODELS_EMBEDDINGS_FIELD_ATTR,
      'api-key',
    )?.value).toBe('embedding-secret');

    clickByAttrValue(host, AI_MODELS_SLOT_SAVE_ATTR, 'embeddings_slot');
    await flush();
    expect(opts.runSetEmbeddingsSlot).toHaveBeenLastCalledWith({
      slot: expect.objectContaining({
        provider: 'openai-compatible',
        model: 'text-embedding-demo',
        api_key: 'embedding-secret',
        base_url: 'https://embeddings.example.test/v1',
      }),
    });
    expect(findByAttrValue(
      host,
      AI_MODELS_EMBEDDINGS_FIELD_ATTR,
      'api-key',
    )?.value).toBe('');
    mount.dispose();
  });

  it('keeps embeddings slot save focusable, busy, and single-flight', async () => {
    let resolveSave!: (value: { ok: true }) => void;
    const runSetEmbeddingsSlot = vi.fn(
      () => new Promise<{ ok: true }>((resolve) => {
        resolveSave = resolve;
      }),
    );
    const { host, mount } = mountFixture({ runSetEmbeddingsSlot });
    await mount.whenLoaded();

    clickByAttrValue(host, AI_MODELS_SLOT_SAVE_ATTR, 'embeddings_slot');
    const pending = findByAttrValue(
      host,
      AI_MODELS_SLOT_SAVE_ATTR,
      'embeddings_slot',
    );
    const clear = findByAttrValue(
      host,
      AI_MODELS_SLOT_CLEAR_ATTR,
      'embeddings_slot',
    );
    expect(pending?.textContent).toBe('Saving slot…');
    expect(pending?.getAttribute('aria-disabled')).toBe('true');
    expect(pending?.getAttribute('aria-busy')).toBe('true');
    expect(pending?.disabled).toBe(false);
    expect(clear?.getAttribute('aria-disabled')).toBe('true');
    expect(findByAttrValue(
      host,
      AI_MODELS_EMBEDDINGS_FIELD_ATTR,
      'model',
    )?.readOnly).toBe(true);
    clickByAttrValue(host, AI_MODELS_SLOT_SAVE_ATTR, 'embeddings_slot');
    clickByAttrValue(host, AI_MODELS_SLOT_CLEAR_ATTR, 'embeddings_slot');
    expect(runSetEmbeddingsSlot).toHaveBeenCalledTimes(1);

    resolveSave({ ok: true });
    await flush();
    const settled = findByAttrValue(
      host,
      AI_MODELS_SLOT_SAVE_ATTR,
      'embeddings_slot',
    );
    expect(settled?.textContent).toBe('Save slot');
    expect(settled?.getAttribute('aria-disabled')).toBeNull();
    expect(settled?.getAttribute('aria-busy')).toBeNull();
    mount.dispose();
  });

  it('clears a persisted slot base URL when the owner empties the field', async () => {
    const { host, mount, opts } = mountFixture();
    await mount.whenLoaded();

    const baseUrl = findByAttrValue(
      host,
      AI_MODELS_SLOT_FIELD_ATTR,
      'slot_1:base-url',
    )!;
    baseUrl.value = '';
    for (const listener of baseUrl.listeners.get('input') ?? []) listener({});
    const apiKey = findByAttrValue(
      host,
      AI_MODELS_SLOT_FIELD_ATTR,
      'slot_1:api-key',
    )!;
    apiKey.value = 'replacement-key';
    for (const listener of apiKey.listeners.get('input') ?? []) listener({});

    clickByAttrValue(host, AI_MODELS_SLOT_SAVE_ATTR, 'slot_1');
    await flush();
    const written = vi.mocked(opts.runSetLLMSlot).mock.calls.at(-1)![0].slot;
    expect(written).not.toHaveProperty('base_url');
    mount.dispose();
  });

  it('removes a free-pool entry via removeFreePoolEntry (the prior gap)', async () => {
    const { host, mount, opts } = mountFixture();
    await mount.whenLoaded();
    // The Remove button is rendered for the configured entry.
    expect(findByAttrValue(host, AI_MODELS_POOL_REMOVE_ATTR, 'groq')).not.toBeNull();
    await mount.removeFreePoolEntry('groq');
    expect(opts.runRemoveFreePoolEntry).toHaveBeenLastCalledWith({ id: 'groq' });
    // Local state drops the entry after the server confirms.
    expect(mount.getState().llmConfig?.free_pool).toEqual([]);
    mount.dispose();
  });

  it('requires confirmation before removing a rendered free-pool entry', async () => {
    const { host, mount, opts } = mountFixture();
    await mount.whenLoaded();

    clickByAttrValue(host, AI_MODELS_POOL_REMOVE_ATTR, 'groq');
    expect(findByAttrValue(
      host,
      AI_MODELS_POOL_REMOVE_DIALOG_ATTR,
      'groq',
    )).not.toBeNull();
    expect(opts.runRemoveFreePoolEntry).not.toHaveBeenCalled();

    clickByAttrValue(host, AI_MODELS_POOL_REMOVE_CANCEL_ATTR, 'groq');
    expect(findByAttr(host, AI_MODELS_POOL_REMOVE_DIALOG_ATTR)).toBeNull();
    expect(findByAttrValue(host, AI_MODELS_POOL_REMOVE_ATTR, 'groq'))
      .not.toBeNull();

    clickByAttrValue(host, AI_MODELS_POOL_REMOVE_ATTR, 'groq');
    clickByAttrValue(host, AI_MODELS_POOL_REMOVE_CONFIRM_ATTR, 'groq');
    await flush();
    expect(opts.runRemoveFreePoolEntry).toHaveBeenCalledTimes(1);
    expect(findByAttr(host, AI_MODELS_POOL_REMOVE_DIALOG_ATTR)).toBeNull();
    expect(findByAttrValue(host, AI_MODELS_POOL_REMOVE_ATTR, 'groq')).toBeNull();
    mount.dispose();
  });

  it('keeps pool removal focusable, busy, and single-flight', async () => {
    let resolveRemove!: (value: { ok: true; removed: true }) => void;
    const runRemoveFreePoolEntry = vi.fn(
      () => new Promise<{ ok: true; removed: true }>((resolve) => {
        resolveRemove = resolve;
      }),
    );
    const { host, mount } = mountFixture({ runRemoveFreePoolEntry });
    await mount.whenLoaded();

    clickByAttrValue(host, AI_MODELS_POOL_REMOVE_ATTR, 'groq');
    clickByAttrValue(host, AI_MODELS_POOL_REMOVE_CONFIRM_ATTR, 'groq');
    const dialog = findByAttrValue(
      host,
      AI_MODELS_POOL_REMOVE_DIALOG_ATTR,
      'groq',
    );
    const confirm = findByAttrValue(
      host,
      AI_MODELS_POOL_REMOVE_CONFIRM_ATTR,
      'groq',
    );
    const cancel = findByAttrValue(
      host,
      AI_MODELS_POOL_REMOVE_CANCEL_ATTR,
      'groq',
    );
    expect(dialog?.getAttribute('aria-busy')).toBe('true');
    expect(confirm?.textContent).toBe('Removing…');
    expect(confirm?.getAttribute('aria-disabled')).toBe('true');
    expect(confirm?.getAttribute('aria-busy')).toBe('true');
    expect(confirm?.disabled).toBe(false);
    expect(cancel?.getAttribute('aria-disabled')).toBe('true');
    expect(cancel?.disabled).toBe(false);
    clickByAttrValue(host, AI_MODELS_POOL_REMOVE_CONFIRM_ATTR, 'groq');
    clickByAttrValue(host, AI_MODELS_POOL_REMOVE_CANCEL_ATTR, 'groq');
    expect(runRemoveFreePoolEntry).toHaveBeenCalledTimes(1);

    resolveRemove({ ok: true, removed: true });
    await flush();
    expect(findByAttr(host, AI_MODELS_POOL_REMOVE_DIALOG_ATTR)).toBeNull();
    expect(findByAttrValue(host, AI_MODELS_POOL_REMOVE_ATTR, 'groq')).toBeNull();
    mount.dispose();
  });

  it('keeps a failed pool removal confirmable for retry', async () => {
    const { host, mount, opts } = mountFixture({
      runRemoveFreePoolEntry: vi.fn(async () => {
        throw new Error('remove failed');
      }),
    });
    await mount.whenLoaded();

    clickByAttrValue(host, AI_MODELS_POOL_REMOVE_ATTR, 'groq');
    clickByAttrValue(host, AI_MODELS_POOL_REMOVE_CONFIRM_ATTR, 'groq');
    await flush();

    expect(opts.runRemoveFreePoolEntry).toHaveBeenCalledTimes(1);
    expect(findByAttr(host, AI_MODELS_ACTION_ERROR_ATTR)).not.toBeNull();
    expect(findByAttrValue(
      host,
      AI_MODELS_POOL_REMOVE_DIALOG_ATTR,
      'groq',
    )).not.toBeNull();
    expect(findByAttrValue(
      host,
      AI_MODELS_POOL_REMOVE_CONFIRM_ATTR,
      'groq',
    )?.disabled).toBe(false);
    mount.dispose();
  });

  it('preserves the free-pool add draft across a sibling toggle', async () => {
    const { host, mount } = mountFixture();
    await mount.whenLoaded();

    const id = findByAttrValue(
      host,
      AI_MODELS_POOL_ADD_FIELD_ATTR,
      'id',
    )!;
    const model = findByAttrValue(
      host,
      AI_MODELS_POOL_ADD_FIELD_ATTR,
      'model',
    )!;
    id.value = 'draft-entry';
    model.value = 'draft-model';
    for (const listener of id.listeners.get('input') ?? []) listener({});
    for (const listener of model.listeners.get('input') ?? []) listener({});

    clickByAttrValue(host, AI_MODELS_POOL_TOGGLE_ATTR, 'groq');
    await flush();
    expect(findByAttrValue(
      host,
      AI_MODELS_POOL_ADD_FIELD_ATTR,
      'id',
    )?.value).toBe('draft-entry');
    expect(findByAttrValue(
      host,
      AI_MODELS_POOL_ADD_FIELD_ATTR,
      'model',
    )?.value).toBe('draft-model');
    mount.dispose();
  });

  it('keeps each free-pool toggle focusable, busy, and single-flight', async () => {
    let resolveToggle!: (value: { ok: true; found: true }) => void;
    const runSetFreePoolEntryEnabled = vi.fn(
      () => new Promise<{ ok: true; found: true }>((resolve) => {
        resolveToggle = resolve;
      }),
    );
    const { host, mount } = mountFixture({ runSetFreePoolEntryEnabled });
    await mount.whenLoaded();

    clickByAttrValue(host, AI_MODELS_POOL_TOGGLE_ATTR, 'groq');
    const pending = findByAttrValue(host, AI_MODELS_POOL_TOGGLE_ATTR, 'groq');
    const remove = findByAttrValue(host, AI_MODELS_POOL_REMOVE_ATTR, 'groq');
    expect(pending?.textContent).toBe('Disabling…');
    expect(pending?.getAttribute('aria-disabled')).toBe('true');
    expect(pending?.getAttribute('aria-busy')).toBe('true');
    expect(pending?.disabled).toBe(false);
    expect(remove?.getAttribute('aria-disabled')).toBe('true');
    expect(remove?.disabled).toBe(false);
    clickByAttrValue(host, AI_MODELS_POOL_TOGGLE_ATTR, 'groq');
    clickByAttrValue(host, AI_MODELS_POOL_REMOVE_ATTR, 'groq');
    expect(runSetFreePoolEntryEnabled).toHaveBeenCalledTimes(1);
    expect(findByAttr(host, AI_MODELS_POOL_REMOVE_DIALOG_ATTR)).toBeNull();

    resolveToggle({ ok: true, found: true });
    await flush();
    const settled = findByAttrValue(host, AI_MODELS_POOL_TOGGLE_ATTR, 'groq');
    expect(settled?.textContent).toBe('Enable');
    expect(settled?.getAttribute('aria-disabled')).toBeNull();
    expect(settled?.getAttribute('aria-busy')).toBeNull();
    mount.dispose();
  });

  it('clears the free-pool add draft only after the write confirms', async () => {
    let resolveAdd!: (value: { ok: true }) => void;
    const runUpsertFreePoolEntry = vi.fn(
      () => new Promise<{ ok: true }>((resolve) => {
        resolveAdd = resolve;
      }),
    );
    const { host, mount } = mountFixture({ runUpsertFreePoolEntry });
    await mount.whenLoaded();

    const values: ReadonlyArray<readonly [string, string]> = [
      ['id', 'openrouter'],
      ['model', 'free-model'],
      ['api-key', 'secret'],
    ];
    for (const [field, value] of values) {
      const input = findByAttrValue(host, AI_MODELS_POOL_ADD_FIELD_ATTR, field)!;
      input.value = value;
      for (const listener of input.listeners.get('input') ?? []) listener({});
    }
    clickByAttrValue(host, AI_MODELS_POOL_ADD_ATTR, '');
    expect(runUpsertFreePoolEntry).toHaveBeenLastCalledWith({
      entry: expect.objectContaining({
        id: 'openrouter',
        model: 'free-model',
        api_key: 'secret',
      }),
    });
    const pending = findByAttrValue(host, AI_MODELS_POOL_ADD_ATTR, '');
    expect(pending?.textContent).toBe('Adding entry…');
    expect(pending?.getAttribute('aria-disabled')).toBe('true');
    expect(pending?.getAttribute('aria-busy')).toBe('true');
    expect(pending?.disabled).toBe(false);
    expect(findByAttrValue(
      host,
      AI_MODELS_POOL_ADD_FIELD_ATTR,
      'api-key',
    )?.value).toBe('secret');
    expect(findByAttrValue(
      host,
      AI_MODELS_POOL_ADD_FIELD_ATTR,
      'api-key',
    )?.readOnly).toBe(true);
    clickByAttrValue(host, AI_MODELS_POOL_ADD_ATTR, '');
    clickByAttrValue(host, AI_MODELS_POOL_ADD_ATTR, '');
    expect(runUpsertFreePoolEntry).toHaveBeenCalledTimes(1);

    resolveAdd({ ok: true });
    await flush();
    expect(findByAttrValue(
      host,
      AI_MODELS_POOL_ADD_FIELD_ATTR,
      'id',
    )?.value).toBe('');
    expect(findByAttrValue(
      host,
      AI_MODELS_POOL_ADD_FIELD_ATTR,
      'provider',
    )?.value).toBe('openai-compatible');
    mount.dispose();
  });

  it('surfaces a failed write as an action-error banner (no unhandled rejection)', async () => {
    const { host, mount } = mountFixture({
      runSetLLMSlot: vi.fn(async () => {
        throw new Error('boom');
      }),
    });
    await mount.whenLoaded();
    expect(findByAttr(host, AI_MODELS_ACTION_ERROR_ATTR)).toBeNull();
    const failedDraft = findByAttrValue(
      host,
      AI_MODELS_SLOT_FIELD_ATTR,
      'slot_2:model',
    )!;
    failedDraft.value = 'retry-this-model';
    for (const listener of failedDraft.listeners.get('input') ?? []) listener({});
    // Click "Save slot" on slot_2 → the dedicated save owner catches the
    // rejected rpc and renders the banner without losing the retry draft.
    clickByAttrValue(host, AI_MODELS_SLOT_SAVE_ATTR, 'slot_2');
    await flush();
    const banner = findByAttr(host, AI_MODELS_ACTION_ERROR_ATTR);
    expect(banner).not.toBeNull();
    expect(banner!.textContent.length).toBeGreaterThan(0);
    expect(findByAttrValue(
      host,
      AI_MODELS_SLOT_FIELD_ATTR,
      'slot_2:model',
    )?.value).toBe('retry-this-model');
    mount.dispose();
  });

  it('threads a per-slot daily_budget_tokens through setLLMSlot (and 0 clears it)', async () => {
    const { mount, opts } = mountFixture();
    await mount.whenLoaded();

    await mount.saveByokSlot('slot_2', {
      provider: 'anthropic',
      model: 'claude-3',
      api_key: 'sk-ant',
      speed: 'thinking',
      daily_budget_tokens: 50_000,
    });
    expect(opts.runSetLLMSlot).toHaveBeenLastCalledWith({
      slot_key: 'slot_2',
      slot: expect.objectContaining({ daily_budget_tokens: 50_000 }),
    });

    // 0 clears the cap — the persisted slot must NOT carry daily_budget_tokens.
    await mount.saveByokSlot('slot_2', {
      provider: 'anthropic',
      model: 'claude-3',
      api_key: 'sk-ant',
      speed: 'thinking',
      daily_budget_tokens: 0,
    });
    const lastCall = vi.mocked(opts.runSetLLMSlot).mock.calls.at(-1)![0] as {
      slot: Record<string, unknown>;
    };
    expect(lastCall.slot).not.toHaveProperty('daily_budget_tokens');
    mount.dispose();
  });

  it('renders a per-slot "Daily token budget" field in the BYOK slot cards', async () => {
    const { host, mount } = mountFixture();
    await mount.whenLoaded();
    expect(hasText(host, 'Daily token budget')).toBe(true);
    mount.dispose();
  });

  it('renders and saves positive context-window limits for BYOK and free-pool API sources', async () => {
    const { host, mount, opts } = mountFixture();
    await mount.whenLoaded();

    const slotContext = findByAttrValue(
      host,
      AI_MODELS_CONTEXT_WINDOW_INPUT_ATTR,
      'slot_1',
    );
    expect(slotContext).not.toBeNull();
    expect(slotContext!.type).toBe('number');
    expect(slotContext!.value).toBe('128000');
    expect(slotContext!.getAttribute('min')).toBe('1');
    expect(slotContext!.getAttribute('step')).toBe('1');
    expect(findByAttrValue(
      host,
      AI_MODELS_CONTEXT_WINDOW_INPUT_ATTR,
      'free_pool:new',
    )?.value).toBe('');

    await mount.saveByokSlot('slot_1', {
      provider: 'openai-compatible',
      model: 'local-model',
      context_window_tokens: 200_000,
    });
    expect(opts.runSetLLMSlot).toHaveBeenLastCalledWith({
      slot_key: 'slot_1',
      slot: expect.objectContaining({ context_window_tokens: 200_000 }),
    });

    await mount.addFreePoolApiEntry({
      id: 'context-pool',
      provider: 'openai-compatible',
      model: 'large-context',
      api_key: 'secret',
      context_window_tokens: 32_768,
    });
    expect(opts.runUpsertFreePoolEntry).toHaveBeenLastCalledWith({
      entry: expect.objectContaining({ context_window_tokens: 32_768 }),
    });
    mount.dispose();
  });

  it('preserves context on unrelated saves but clears it when the concrete model changes', async () => {
    const { host, mount, opts } = mountFixture();
    await mount.whenLoaded();

    // Blank in the rendered field means "leave unchanged", not an invented
    // provider default or a destructive zero.
    const slotContext = findByAttrValue(
      host,
      AI_MODELS_CONTEXT_WINDOW_INPUT_ATTR,
      'slot_1',
    )!;
    slotContext.value = '';
    clickByAttrValue(host, AI_MODELS_SLOT_SAVE_ATTR, 'slot_1');
    await flush();
    let slotCall = vi.mocked(opts.runSetLLMSlot).mock.calls.at(-1)![0] as {
      slot: Record<string, unknown>;
    };
    expect(slotCall.slot.context_window_tokens).toBe(128_000);
    // The pre-existing output ceiling remains carried by the redacted/current
    // slot even though this UI does not add a second advanced control for it.
    expect(slotCall.slot.max_output_tokens).toBe(8_192);

    // A context claim belongs to the concrete provider/model/endpoint. An
    // invalid replacement while changing model must clear the old claim so the
    // gateway fails closed instead of assuming the new model has the old size.
    await mount.saveByokSlot('slot_1', {
      provider: 'openai-compatible',
      model: 'local-model-2',
      context_window_tokens: 12.5,
    });
    slotCall = vi.mocked(opts.runSetLLMSlot).mock.calls.at(-1)![0] as {
      slot: Record<string, unknown>;
    };
    expect(slotCall.slot).not.toHaveProperty('context_window_tokens');

    await mount.addFreePoolApiEntry({
      id: 'invalid-context',
      provider: 'openai-compatible',
      model: 'model',
      api_key: 'secret',
      context_window_tokens: 0,
    });
    const entryCall = vi.mocked(opts.runUpsertFreePoolEntry).mock.calls.at(-1)![0] as {
      entry: Record<string, unknown>;
    };
    expect(entryCall.entry).not.toHaveProperty('context_window_tokens');
    mount.dispose();
  });

  it('writes budget and AI policy controls through existing config RPCs', async () => {
    const { mount, opts } = mountFixture();
    await mount.whenLoaded();

    await mount.setBudget(10_000);
    expect(opts.runSetConfigField).toHaveBeenCalledWith({
      key: 'llm.budget',
      value: 10_000,
    });

    await mount.setAllowByokBackground(true);
    expect(opts.runWriteHousekeepingConfig).toHaveBeenLastCalledWith({
      preset: 'balanced',
      allow_byok_background: true,
    });

    await mount.setPauseBackgroundAiUntil(1_700_000_060_000);
    expect(opts.runWriteHousekeepingConfig).toHaveBeenLastCalledWith({
      preset: 'balanced',
      pause_background_ai_until: 1_700_000_060_000,
    });
    mount.dispose();
  });

  it('keeps shared AI policy writes focusable, busy, and single-flight', async () => {
    let resolveWrite!: (value: {
      ok: true;
      effective: HousekeepingConfigRow;
    }) => void;
    const runWriteHousekeepingConfig = vi.fn(
      () => new Promise<{
        ok: true;
        effective: HousekeepingConfigRow;
      }>((resolve) => {
        resolveWrite = resolve;
      }),
    );
    const { host, mount } = mountFixture({ runWriteHousekeepingConfig });
    await mount.whenLoaded();

    clickByAttrValue(
      host,
      AI_MODELS_ALLOW_BYOK_TOGGLE_ATTR,
      'background',
    );
    const allow = findByAttrValue(
      host,
      AI_MODELS_ALLOW_BYOK_TOGGLE_ATTR,
      'background',
    );
    const pause = findByAttrValue(host, AI_MODELS_PAUSE_BUTTON_ATTR, '1h');
    const resume = findByAttrValue(
      host,
      AI_MODELS_PAUSE_BUTTON_ATTR,
      'resume',
    );
    expect(allow?.textContent).toBe('Updating background BYOK…');
    expect(allow?.getAttribute('aria-disabled')).toBe('true');
    expect(allow?.getAttribute('aria-busy')).toBe('true');
    expect(allow?.disabled).toBe(false);
    expect(pause?.getAttribute('aria-disabled')).toBe('true');
    expect(resume?.getAttribute('aria-disabled')).toBe('true');
    clickByAttrValue(host, AI_MODELS_PAUSE_BUTTON_ATTR, '1h');
    clickByAttrValue(host, AI_MODELS_PAUSE_BUTTON_ATTR, 'resume');
    clickByAttrValue(
      host,
      AI_MODELS_ALLOW_BYOK_TOGGLE_ATTR,
      'background',
    );
    expect(runWriteHousekeepingConfig).toHaveBeenCalledTimes(1);

    resolveWrite({
      ok: true,
      effective: housekeeping({ allow_byok_background: true }),
    });
    await flush();
    const settled = findByAttrValue(
      host,
      AI_MODELS_ALLOW_BYOK_TOGGLE_ATTR,
      'background',
    );
    expect(settled?.textContent).toBe('Disable background BYOK');
    expect(settled?.getAttribute('aria-disabled')).toBeNull();
    expect(settled?.getAttribute('aria-busy')).toBeNull();
    expect(findByAttrValue(
      host,
      AI_MODELS_PAUSE_BUTTON_ATTR,
      '1h',
    )?.getAttribute('aria-disabled')).toBeNull();
    mount.dispose();
  });

  it('preserves an unsaved budget across a sibling policy write', async () => {
    const { host, mount, opts } = mountFixture();
    await mount.whenLoaded();

    const budget = findByAttrValue(
      host,
      AI_MODELS_BUDGET_INPUT_ATTR,
      'llm.budget',
    )!;
    budget.value = '1234';
    for (const listener of budget.listeners.get('input') ?? []) listener({});

    clickByAttrValue(host, AI_MODELS_ALLOW_BYOK_TOGGLE_ATTR, 'background');
    await flush();
    expect(findByAttrValue(
      host,
      AI_MODELS_BUDGET_INPUT_ATTR,
      'llm.budget',
    )?.value).toBe('1234');

    clickByAttrValue(host, AI_MODELS_BUDGET_SAVE_ATTR, 'llm.budget');
    await flush();
    expect(opts.runSetConfigField).toHaveBeenLastCalledWith({
      key: 'llm.budget',
      value: 1234,
    });
    expect(findByAttrValue(
      host,
      AI_MODELS_BUDGET_INPUT_ATTR,
      'llm.budget',
    )?.value).toBe('1234');
    mount.dispose();
  });

  it('keeps budget Save focusable, busy, and single-flight', async () => {
    let resolveSave!: (value: { ok: true }) => void;
    const runSetConfigField = vi.fn(
      () => new Promise<{ ok: true }>((resolve) => {
        resolveSave = resolve;
      }),
    );
    const { host, mount } = mountFixture({ runSetConfigField });
    await mount.whenLoaded();

    const budget = findByAttrValue(
      host,
      AI_MODELS_BUDGET_INPUT_ATTR,
      'llm.budget',
    )!;
    budget.value = '1234';
    for (const listener of budget.listeners.get('input') ?? []) listener({});
    clickByAttrValue(host, AI_MODELS_BUDGET_SAVE_ATTR, 'llm.budget');

    const pending = findByAttrValue(
      host,
      AI_MODELS_BUDGET_SAVE_ATTR,
      'llm.budget',
    );
    expect(pending?.textContent).toBe('Saving budget…');
    expect(pending?.getAttribute('aria-disabled')).toBe('true');
    expect(pending?.getAttribute('aria-busy')).toBe('true');
    expect(pending?.disabled).toBe(false);
    expect(findByAttrValue(
      host,
      AI_MODELS_BUDGET_INPUT_ATTR,
      'llm.budget',
    )?.readOnly).toBe(true);
    clickByAttrValue(host, AI_MODELS_BUDGET_SAVE_ATTR, 'llm.budget');
    clickByAttrValue(host, AI_MODELS_BUDGET_SAVE_ATTR, 'llm.budget');
    expect(runSetConfigField).toHaveBeenCalledTimes(1);

    resolveSave({ ok: true });
    await flush();
    const settled = findByAttrValue(
      host,
      AI_MODELS_BUDGET_SAVE_ATTR,
      'llm.budget',
    );
    expect(settled?.textContent).toBe('Save budget');
    expect(settled?.getAttribute('aria-disabled')).toBeNull();
    expect(settled?.getAttribute('aria-busy')).toBeNull();
    expect(findByAttrValue(
      host,
      AI_MODELS_BUDGET_INPUT_ATTR,
      'llm.budget',
    )?.readOnly).toBe(false);
    expect(findByAttrValue(
      host,
      AI_MODELS_BUDGET_INPUT_ATTR,
      'llm.budget',
    )?.value).toBe('1234');
    mount.dispose();
  });
});

describe('D-174 R28 Slice B — api_key redaction', () => {
  it('renders a REMOTE (has_key) BYOK slot in the picker — redaction must not hide it', async () => {
    // Regression for the redaction defect: a remote slot has no local
    // base_url, so it only survives if the projection gates on `has_key`
    // (not the now-absent api_key).
    const { mount } = mountFixture({
      runGetLLMConfig: vi.fn(async () => ({
        config: {
          slot_1: { provider: 'openai', model: 'gpt-4o', has_key: true, speed: 'fast' },
        },
      })),
      runGetDefaultModelPref: vi.fn(async () => ({
        source_id: 'slot_1' as const,
        updated_at: 1,
      })),
    });
    await mount.whenLoaded();
    const pref = mount.getState().modelPreference;
    expect(pref.kind).toBe('resolved');
    if (pref.kind === 'resolved') {
      expect(pref.options.map((o) => o.id)).toContain('slot_1');
    }
    mount.dispose();
  });

  it('saveByokSlot with a blank key sends api_key:"" + keeps has_key locally', async () => {
    const { mount, opts } = mountFixture();
    await mount.whenLoaded();
    // slot_1 is configured (has_key) — edit the model with NO key field.
    await mount.saveByokSlot('slot_1', {
      provider: 'openai-compatible',
      model: 'local-model-2',
    });
    expect(opts.runSetLLMSlot).toHaveBeenLastCalledWith({
      slot_key: 'slot_1',
      slot: expect.objectContaining({ model: 'local-model-2', api_key: '' }),
    });
    // Provider + base_url unchanged → the server preserves the key, so the
    // local redacted state must keep has_key (not flip to "keyless").
    expect(mount.getState().llmConfig?.slot_1).toMatchObject({ has_key: true });
    expect(mount.getState().llmConfig?.slot_1).not.toHaveProperty('api_key');
    mount.dispose();
  });

  it('masks the API key input fields (type=password)', async () => {
    const { host, mount } = mountFixture();
    await mount.whenLoaded();
    expect(findInputByType(host, 'password')).not.toBeNull();
    mount.dispose();
  });

  it('saveByokSlot blank key + CHANGED provider drops the slot locally (mirrors server)', async () => {
    const { mount, opts } = mountFixture({
      runGetLLMConfig: vi.fn(async () => ({
        config: { slot_1: { provider: 'openai', model: 'gpt-4o', has_key: true } },
      })),
    });
    await mount.whenLoaded();
    // Change provider, leave the key blank → the server drops the now-keyless
    // slot, so the local state must mirror it as unconfigured (not a phantom).
    await mount.saveByokSlot('slot_1', { provider: 'anthropic', model: 'claude' });
    expect(opts.runSetLLMSlot).toHaveBeenLastCalledWith({
      slot_key: 'slot_1',
      slot: expect.objectContaining({ provider: 'anthropic', api_key: '' }),
    });
    expect(mount.getState().llmConfig?.slot_1).toBeNull();
  });

  it('addFreePoolApiEntry keeps no plaintext key in local state (redacted mirror)', async () => {
    const { mount, opts } = mountFixture();
    await mount.whenLoaded();
    await mount.addFreePoolApiEntry({
      id: 'openrouter',
      provider: 'openai-compatible',
      model: 'm',
      api_key: 'or-secret',
    });
    // The secret IS sent to the server...
    expect(opts.runUpsertFreePoolEntry).toHaveBeenLastCalledWith({
      entry: expect.objectContaining({ id: 'openrouter', api_key: 'or-secret' }),
    });
    // ...but the local clone keeps only has_key, never the plaintext key.
    const pool = (mount.getState().llmConfig?.free_pool ?? []) as Array<Record<string, unknown>>;
    const added = pool.find((e) => e.id === 'openrouter');
    expect(added).toMatchObject({ id: 'openrouter', has_key: true });
    expect(added).not.toHaveProperty('api_key');
    mount.dispose();
  });
});

describe('D-174 R28 Slice C — embeddings slot card', () => {
  it('saveEmbeddingsSlot routes to the embeddings setter ({ slot }, no slot_key) and redacts the local key', async () => {
    const { mount, opts } = mountFixture();
    await mount.whenLoaded();
    await mount.saveEmbeddingsSlot({
      provider: 'openai',
      model: 'text-embedding-3-small',
      api_key: 'sk-embed',
    });
    expect(opts.runSetEmbeddingsSlot).toHaveBeenLastCalledWith({
      slot: expect.objectContaining({
        provider: 'openai',
        model: 'text-embedding-3-small',
        api_key: 'sk-embed',
      }),
    });
    // Routed to the embeddings setter, NOT the chat slot setter (owner
    // constraint: embeddings is never a chat model-select option).
    expect(opts.runSetLLMSlot).not.toHaveBeenCalled();
    // Local mirror keeps only has_key, never the plaintext key.
    expect(mount.getState().llmConfig?.embeddings_slot).toMatchObject({ has_key: true });
    expect(mount.getState().llmConfig?.embeddings_slot).not.toHaveProperty('api_key');
    mount.dispose();
  });

  it('saveEmbeddingsSlot with a blank key sends api_key:"" (server preserves the stored key)', async () => {
    const { mount, opts } = mountFixture({
      runGetLLMConfig: vi.fn(async () => ({
        config: {
          embeddings_slot: { provider: 'openai', model: 'text-embedding-3-small', has_key: true },
        },
      })),
    });
    await mount.whenLoaded();
    // Edit the model with NO key field, same provider → the server preserves.
    await mount.saveEmbeddingsSlot({ provider: 'openai', model: 'text-embedding-3-large' });
    expect(opts.runSetEmbeddingsSlot).toHaveBeenLastCalledWith({
      slot: expect.objectContaining({ model: 'text-embedding-3-large', api_key: '' }),
    });
    expect(mount.getState().llmConfig?.embeddings_slot).toMatchObject({ has_key: true });
    expect(mount.getState().llmConfig?.embeddings_slot).not.toHaveProperty('api_key');
    mount.dispose();
  });

  it('clears a persisted embeddings base URL when the owner empties the field', async () => {
    const { host, mount, opts } = mountFixture({
      runGetLLMConfig: vi.fn(async () => ({
        config: {
          embeddings_slot: {
            provider: 'openai-compatible',
            model: 'old-embedding-model',
            base_url: 'https://old-embeddings.example.test/v1',
            has_key: true,
          },
        },
      })),
    });
    await mount.whenLoaded();

    const baseUrl = findByAttrValue(
      host,
      AI_MODELS_EMBEDDINGS_FIELD_ATTR,
      'base-url',
    )!;
    baseUrl.value = '';
    for (const listener of baseUrl.listeners.get('input') ?? []) listener({});
    const apiKey = findByAttrValue(
      host,
      AI_MODELS_EMBEDDINGS_FIELD_ATTR,
      'api-key',
    )!;
    apiKey.value = 'replacement-key';
    for (const listener of apiKey.listeners.get('input') ?? []) listener({});

    clickByAttrValue(host, AI_MODELS_SLOT_SAVE_ATTR, 'embeddings_slot');
    await flush();
    const written = vi.mocked(opts.runSetEmbeddingsSlot).mock.calls.at(-1)![0].slot;
    expect(written).not.toHaveProperty('base_url');
    mount.dispose();
  });

  it('clearEmbeddingsSlot sends slot:null and clears local state', async () => {
    const { mount, opts } = mountFixture();
    await mount.whenLoaded();
    await mount.clearEmbeddingsSlot();
    expect(opts.runSetEmbeddingsSlot).toHaveBeenLastCalledWith({ slot: null });
    expect(mount.getState().llmConfig?.embeddings_slot).toBeNull();
    mount.dispose();
  });
});

describe('Lever-2 per-slot (Phase 3) — chat catalog mode', () => {
  // A config carrying a per-source override map (server returns it unredacted).
  const withCatalogModes = (
    modes: Record<string, string>,
  ): (() => Promise<{ config: Record<string, unknown> }>) =>
    vi.fn(async () => ({ config: { ...llmConfig(), catalog_modes: modes } }));

  it('keeps the shared catalog map focusable, busy, and single-flight', async () => {
    let resolveWrite!: (value: { ok: true }) => void;
    const runSetChatCatalogMode = vi.fn(
      () => new Promise<{ ok: true }>((resolve) => {
        resolveWrite = resolve;
      }),
    );
    const { host, mount } = mountFixture({ runSetChatCatalogMode });
    await mount.whenLoaded();

    changeSelect(host, AI_MODELS_CATALOG_MODE_SELECT_ATTR, 'slot_1', 'index');
    const slotOne = findByAttrValue(
      host,
      AI_MODELS_CATALOG_MODE_SELECT_ATTR,
      'slot_1',
    );
    const slotTwo = findByAttrValue(
      host,
      AI_MODELS_CATALOG_MODE_SELECT_ATTR,
      'slot_2',
    );
    expect(slotOne?.value).toBe('index');
    expect(slotOne?.getAttribute('aria-disabled')).toBe('true');
    expect(slotOne?.getAttribute('aria-busy')).toBe('true');
    expect(slotOne?.disabled).toBe(false);
    expect(slotTwo?.getAttribute('aria-disabled')).toBe('true');
    changeSelect(host, AI_MODELS_CATALOG_MODE_SELECT_ATTR, 'slot_1', 'full');
    changeSelect(
      host,
      AI_MODELS_CATALOG_MODE_SELECT_ATTR,
      'slot_2',
      'lean-core',
    );
    expect(findByAttrValue(
      host,
      AI_MODELS_CATALOG_MODE_SELECT_ATTR,
      'slot_1',
    )?.value).toBe('index');
    expect(findByAttrValue(
      host,
      AI_MODELS_CATALOG_MODE_SELECT_ATTR,
      'slot_2',
    )?.value).toBe('');
    expect(runSetChatCatalogMode).toHaveBeenCalledTimes(1);

    resolveWrite({ ok: true });
    await flush();
    const settled = findByAttrValue(
      host,
      AI_MODELS_CATALOG_MODE_SELECT_ATTR,
      'slot_1',
    );
    expect(settled?.value).toBe('index');
    expect(settled?.getAttribute('aria-disabled')).toBeNull();
    expect(settled?.getAttribute('aria-busy')).toBeNull();
    expect(mount.getState().llmConfig?.catalog_modes).toEqual({
      slot_1: 'index',
    });
    mount.dispose();
  });

  it('renders a catalog <select> per source with Automatic + the 3 modes, reflecting the current override', async () => {
    const { host, mount } = mountFixture({
      // slot_1 pinned to index; slot_2 + free_pool unset (Automatic).
      runGetLLMConfig: withCatalogModes({ slot_1: 'index' }),
    });
    await mount.whenLoaded();

    for (const source of ['slot_1', 'slot_2', 'free_pool'] as const) {
      const select = findByAttrValue(host, AI_MODELS_CATALOG_MODE_SELECT_ATTR, source);
      expect(select, `select for ${source}`).not.toBeNull();
      // Automatic ('') + full + index + lean-core.
      expect(select!.children.map((c) => c.value)).toEqual([
        '',
        'full',
        'index',
        'lean-core',
      ]);
    }
    // The explicit override drives the selected value; unset → Automatic ('').
    expect(findByAttrValue(host, AI_MODELS_CATALOG_MODE_SELECT_ATTR, 'slot_1')!.value).toBe('index');
    expect(findByAttrValue(host, AI_MODELS_CATALOG_MODE_SELECT_ATTR, 'slot_2')!.value).toBe('');
    expect(findByAttrValue(host, AI_MODELS_CATALOG_MODE_SELECT_ATTR, 'free_pool')!.value).toBe('');
    mount.dispose();
  });

  it('explains each mode in a legend so the choice is informed', async () => {
    const { host, mount } = mountFixture();
    await mount.whenLoaded();
    // The "how to choose" legend + one distinguishing phrase per mode.
    expect(hasText(host, 'What do these modes mean?')).toBe(true);
    expect(hasText(host, 'full input schema')).toBe(true); // full
    expect(hasText(host, 'listed by name and summary')).toBe(true); // index
    expect(hasText(host, 'searches to discover recipes')).toBe(true); // lean-core
    mount.dispose();
  });

  it('the Automatic hint states the shipped default per source', async () => {
    const { host, mount } = mountFixture();
    await mount.whenLoaded();
    // ⚠ THE HINT IS DERIVED FROM THE MAP, so this asserts AGREEMENT rather than
    // a literal. The previous version hard-coded "Index" (and said so in its
    // name), which failed on the 2026-08-05 flip to `lean-core` — a correct
    // change reddening a test that was only ever meant to prove the UI and the
    // server read ONE map.
    const shortLabel: Record<string, string> = {
      full: 'Full', index: 'Index', 'lean-core': 'Lean core',
    };
    for (const [source, phrase] of [
      ['free_pool', 'the free pool'],
      ['slot_1', 'a BYOK slot'],
    ] as const) {
      const mode = CHAT_CATALOG_SMART_DEFAULT_BY_SOURCE[source];
      expect(
        hasText(host, `Automatic uses ${shortLabel[mode]} for ${phrase}`),
        `${source} hint`,
      ).toBe(true);
    }
    // ...and it is not vacuous: a mode the map does NOT carry must be absent.
    const absent = CHAT_CATALOG_DELIVERY_MODES.find(
      (m) => m !== CHAT_CATALOG_SMART_DEFAULT_BY_SOURCE.slot_1,
    );
    expect(hasText(host, `Automatic uses ${shortLabel[absent!]} for a BYOK slot`))
      .toBe(false);
    mount.dispose();
  });

  it('setChatCatalogMode writes the field-level rpc + mirrors the mode locally', async () => {
    const { mount, opts } = mountFixture();
    await mount.whenLoaded();

    await mount.setChatCatalogMode('slot_2', 'lean-core');
    expect(opts.runSetChatCatalogMode).toHaveBeenLastCalledWith({
      source_id: 'slot_2',
      mode: 'lean-core',
    });
    expect(mount.getState().llmConfig?.catalog_modes).toEqual({ slot_2: 'lean-core' });
    mount.dispose();
  });

  it('setChatCatalogMode(null) clears an override and drops the map once empty', async () => {
    const { mount, opts } = mountFixture({
      runGetLLMConfig: withCatalogModes({ slot_1: 'index' }),
    });
    await mount.whenLoaded();

    await mount.setChatCatalogMode('slot_1', null);
    expect(opts.runSetChatCatalogMode).toHaveBeenLastCalledWith({
      source_id: 'slot_1',
      mode: null,
    });
    // The only override was cleared → the map is dropped entirely (byte-matches
    // an unconfigured re-read, where getLLMConfig omits catalog_modes).
    expect(mount.getState().llmConfig).not.toHaveProperty('catalog_modes');
    mount.dispose();
  });

  it('clearing one of several overrides keeps the rest', async () => {
    const { mount } = mountFixture({
      runGetLLMConfig: withCatalogModes({ slot_1: 'index', free_pool: 'lean-core' }),
    });
    await mount.whenLoaded();

    await mount.setChatCatalogMode('slot_1', null);
    expect(mount.getState().llmConfig?.catalog_modes).toEqual({ free_pool: 'lean-core' });
    mount.dispose();
  });

  it('SETTING a source merges into (does not clobber) the other overrides', async () => {
    // Distinct values per source so a wrong-key / replace-instead-of-merge bug
    // can't hide behind a shared value (the field-level write must merge).
    const { mount } = mountFixture({
      runGetLLMConfig: withCatalogModes({ slot_1: 'full', free_pool: 'lean-core' }),
    });
    await mount.whenLoaded();

    await mount.setChatCatalogMode('slot_2', 'index');
    expect(mount.getState().llmConfig?.catalog_modes).toEqual({
      slot_1: 'full',
      slot_2: 'index',
      free_pool: 'lean-core',
    });
    mount.dispose();
  });

  it('the DOM change handler drives the write end-to-end (through surface)', async () => {
    const { host, mount, opts } = mountFixture();
    await mount.whenLoaded();

    changeSelect(host, AI_MODELS_CATALOG_MODE_SELECT_ATTR, 'free_pool', 'index');
    await flush();
    expect(opts.runSetChatCatalogMode).toHaveBeenLastCalledWith({
      source_id: 'free_pool',
      mode: 'index',
    });
    // ...and the confirmed write is mirrored into local state (this assertion
    // fails if setChatCatalogMode stops mirroring — the rpc-args check alone
    // would not).
    expect(mount.getState().llmConfig?.catalog_modes).toEqual({ free_pool: 'index' });
    // A successful write leaves no action-error banner.
    expect(findByAttr(host, AI_MODELS_ACTION_ERROR_ATTR)).toBeNull();
    mount.dispose();
  });

  it('picking Automatic ("") from the DOM clears the override (mode:null)', async () => {
    const { host, mount, opts } = mountFixture({
      runGetLLMConfig: withCatalogModes({ slot_1: 'index' }),
    });
    await mount.whenLoaded();

    changeSelect(host, AI_MODELS_CATALOG_MODE_SELECT_ATTR, 'slot_1', '');
    await flush();
    expect(opts.runSetChatCatalogMode).toHaveBeenLastCalledWith({
      source_id: 'slot_1',
      mode: null,
    });
    // The DOM clear path also drops the (now-empty) map from local state.
    expect(mount.getState().llmConfig).not.toHaveProperty('catalog_modes');
    mount.dispose();
  });

  it('a failed catalog-mode write surfaces an action-error banner + leaves local state unchanged', async () => {
    const { host, mount } = mountFixture({
      runGetLLMConfig: withCatalogModes({ slot_1: 'index' }),
      runSetChatCatalogMode: vi.fn(async () => {
        throw new Error('boom');
      }),
    });
    await mount.whenLoaded();
    expect(findByAttr(host, AI_MODELS_ACTION_ERROR_ATTR)).toBeNull();
    changeSelect(host, AI_MODELS_CATALOG_MODE_SELECT_ATTR, 'slot_1', 'full');
    await flush();
    const banner = findByAttr(host, AI_MODELS_ACTION_ERROR_ATTR);
    expect(banner).not.toBeNull();
    expect(banner!.textContent.length).toBeGreaterThan(0);
    // The rpc threw BEFORE commitLocal, so the local override is untouched
    // (commit-after-confirm: a failed write never mutates local state).
    expect(mount.getState().llmConfig?.catalog_modes).toEqual({ slot_1: 'index' });
    mount.dispose();
  });

  it('omits the catalog control when runSetChatCatalogMode is not wired', async () => {
    const { host, mount } = mountFixture({ runSetChatCatalogMode: undefined });
    await mount.whenLoaded();
    for (const source of ['slot_1', 'slot_2', 'free_pool'] as const) {
      expect(findByAttrValue(host, AI_MODELS_CATALOG_MODE_SELECT_ATTR, source)).toBeNull();
    }
    // setChatCatalogMode still throws a clear "not wired" error if invoked.
    await expect(mount.setChatCatalogMode('slot_1', 'index')).rejects.toThrow(/not wired/);
    mount.dispose();
  });
});

/** Settings → AI/Models → System prompts.
 *
 *  THE EDITABLE BOX IS BLOCK 1 — the role + instructions. Recued's core text
 *  (the AIOutput wire contract) and feature text (the approvals posture, the
 *  gateway's contract-scoping lines) are composed around it and are rendered
 *  READ-ONLY beneath: an owner should be able to SEE everything else the model
 *  is told, because a fence you cannot read is indistinguishable from a fence
 *  that is not there. */
describe('System prompts — the box holds the role, not the whole prompt', () => {
  it('names each editor and action by its prompt surface', async () => {
    const { host, mount } = mountFixture();
    await mount.whenLoaded();

    for (const [surface, title] of [
      ['chat', 'Chat'],
      ['llm_gateway', 'LLM gateway'],
    ] as const) {
      const section = findByAttrValue(
        host,
        AI_MODELS_PROMPT_SECTION_ATTR,
        surface,
      )!;
      const titleId = `recued-ai-models-prompt-${surface}-title`;
      expect(section.getAttribute('aria-labelledby')).toBe(titleId);
      expect(findByAttrValue(host, 'id', titleId)).not.toBeNull();
      expect(findByAttrValue(
        host,
        AI_MODELS_PROMPT_TEXT_ATTR,
        surface,
      )?.getAttribute('aria-label')).toBe(`${title} system prompt`);
      expect(findByAttrValue(
        host,
        AI_MODELS_PROMPT_SAVE_ATTR,
        surface,
      )?.getAttribute('aria-label')).toBe(`Save ${title} system prompt`);
      expect(findByAttrValue(
        host,
        AI_MODELS_PROMPT_LOAD_DEFAULT_ATTR,
        surface,
      )?.getAttribute('aria-label'))
        .toBe(`Load the built-in ${title} system prompt into the editor`);
      expect(findByAttrValue(
        host,
        AI_MODELS_PROMPT_ALWAYS_ATTR,
        surface,
      )?.getAttribute('aria-label'))
        .toBe(`${title} always-on prompt text`);
    }
    expect(findByAttrValue(
      host,
      AI_MODELS_PROMPT_POLICY_ATTR,
      'llm_gateway',
    )?.getAttribute('aria-label'))
      .toBe('LLM gateway customer system prompt policy');
    mount.dispose();
  });

  it('pre-fills each surface with the role block in force', async () => {
    const { host, mount } = mountFixture();
    await mount.whenLoaded();

    expect(findByAttrValue(host, AI_MODELS_PROMPT_TEXT_ATTR, 'chat')?.value)
      .toBe(CHAT_ROLE_DEFAULT);
    // ...and NOT the wire contract. That is not the owner's to write.
    expect(findByAttrValue(host, AI_MODELS_PROMPT_TEXT_ATTR, 'chat')?.value)
      .not.toContain('AIOutput');
    mount.dispose();
  });

  it('keeps the prompt controls mounted while an owner drafts', async () => {
    const { host, mount } = mountFixture();
    await mount.whenLoaded();

    const area = findByAttrValue(host, AI_MODELS_PROMPT_TEXT_ATTR, 'chat')!;
    const status = findByAttrValue(host, AI_MODELS_PROMPT_STATUS_ATTR, 'chat')!;
    area.value = 'A two-keystroke draft';
    for (const listener of area.listeners.get('input') ?? []) listener({});
    // Element IDENTITY, not just value: a re-render here would rebuild the
    // textarea and drop the caret mid-word.
    expect(findByAttrValue(host, AI_MODELS_PROMPT_TEXT_ATTR, 'chat')).toBe(area);
    expect(findByAttrValue(host, AI_MODELS_PROMPT_STATUS_ATTR, 'chat'))
      .toBe(status);
    expect(findByAttrValue(host, AI_MODELS_PROMPT_TEXT_ATTR, 'chat')?.value)
      .toBe('A two-keystroke draft');

    const policy = findByAttrValue(host, AI_MODELS_PROMPT_POLICY_ATTR, 'llm_gateway')!;
    policy.value = 'append';
    for (const listener of policy.listeners.get('change') ?? []) listener({});
    expect(findByAttrValue(host, AI_MODELS_PROMPT_POLICY_ATTR, 'llm_gateway'))
      .toBe(policy);
    mount.dispose();
  });

  /** ⛔ THE WHOLE POINT OF THE CARD'S SHAPE. A `<select>` offering
   *  `system / user / assistant` beside a prompt box and a Save button reads as
   *  "choose which prompt you are writing" / "save the text INTO a role". There
   *  is ONE stored string per surface delivered as ONE message — three options
   *  in the save path describe a data shape the substrate does not have. */
  it('offers no wire-role picker — one string, one message, no destination', async () => {
    const { host, mount } = mountFixture();
    await mount.whenLoaded();

    for (const surface of ['chat', 'llm_gateway'] as const) {
      const section = findByAttrValue(
        host,
        AI_MODELS_PROMPT_SECTION_ATTR,
        surface,
      )!;
      const selects: FakeElement[] = [];
      const walk = (node: FakeElement): void => {
        if (node.tagName === 'SELECT') selects.push(node);
        for (const child of node.children) walk(child);
      };
      walk(section);
      // The gateway keeps exactly one — the caller policy, which is a real
      // decision about a stranger's text, not a transport knob.
      const expected = surface === 'llm_gateway' ? 1 : 0;
      expect(selects.length).toBe(expected);
      for (const select of selects) {
        expect(select.getAttribute(AI_MODELS_PROMPT_POLICY_ATTR)).toBe(surface);
      }
    }
    mount.dispose();
  });

  it('says whether the box holds what is saved, and changes when it stops', async () => {
    const { host, mount } = mountFixture({
      runGetLlmPrompts: vi.fn(async () => ({
        prompts: llmPrompts({
          surface: 'llm_gateway',
          role_instructions: 'You are a dentist.',
          is_default: false,
        }),
      })),
    });
    await mount.whenLoaded();

    // The badge reports the ROW; this reports the BOX. They agree until a
    // keystroke, which is exactly when the owner needs to be told they differ.
    expect(findByAttrValue(host, AI_MODELS_PROMPT_STATUS_ATTR, 'chat')?.textContent)
      .toBe('Showing the built-in default, in force now.');
    expect(
      findByAttrValue(host, AI_MODELS_PROMPT_STATUS_ATTR, 'llm_gateway')?.textContent,
    ).toBe('Showing your saved prompt, in force now.');

    const area = findByAttrValue(host, AI_MODELS_PROMPT_TEXT_ATTR, 'chat')!;
    area.value = 'You are a lawyer.';
    for (const listener of area.listeners.get('input') ?? []) listener({});
    expect(findByAttrValue(host, AI_MODELS_PROMPT_STATUS_ATTR, 'chat')?.textContent)
      .toBe('Unsaved changes — Save to put this in force.');

    // …and back: typing the saved text again is not a change.
    area.value = CHAT_ROLE_DEFAULT;
    for (const listener of area.listeners.get('input') ?? []) listener({});
    expect(findByAttrValue(host, AI_MODELS_PROMPT_STATUS_ATTR, 'chat')?.textContent)
      .toBe('Showing the built-in default, in force now.');
    mount.dispose();
  });

  it('shows the always-on text the owner cannot edit', async () => {
    const { host, mount } = mountFixture();
    await mount.whenLoaded();

    const always = findByAttrValue(host, AI_MODELS_PROMPT_ALWAYS_ATTR, 'llm_gateway');
    expect(always).not.toBeNull();
    expect(hasText(always!, CORE_TEXT)).toBe(true);
    expect(hasText(always!, GATEWAY_POSTURE)).toBe(true);
    mount.dispose();
  });

  it('offers the caller policy on the gateway only', async () => {
    const { host, mount } = mountFixture();
    await mount.whenLoaded();

    expect(findByAttrValue(host, AI_MODELS_PROMPT_POLICY_ATTR, 'llm_gateway')?.value)
      .toBe('context');
    // A caller's system message only exists on the gateway — chat has no caller.
    expect(findByAttrValue(host, AI_MODELS_PROMPT_POLICY_ATTR, 'chat')).toBeNull();
    mount.dispose();
  });

  it('badges an authored role block as customised', async () => {
    const { host, mount } = mountFixture({
      runGetLlmPrompts: vi.fn(async () => ({
        prompts: llmPrompts({
          surface: 'llm_gateway',
          role_instructions: 'You are a dentist.',
          is_default: false,
        }),
      })),
    });
    await mount.whenLoaded();

    expect(findByAttrValue(host, AI_MODELS_PROMPT_BADGE_ATTR, 'custom')?.textContent)
      .toBe('Customised');
    mount.dispose();
  });
});

describe('System prompts — saving, the policy, and the reset that is a delete', () => {
  it('keeps each prompt mutation focusable, busy, and single-flight', async () => {
    let resolveSave!: (value: { ok: true }) => void;
    const runSetLlmPrompt = vi.fn(
      () => new Promise<{ ok: true }>((resolve) => {
        resolveSave = resolve;
      }),
    );
    const { host, mount } = mountFixture({ runSetLlmPrompt });
    await mount.whenLoaded();

    const area = findByAttrValue(host, AI_MODELS_PROMPT_TEXT_ATTR, 'chat')!;
    area.value = 'A durable owner-authored prompt.';
    for (const fn of area.listeners.get('input') ?? []) fn({});
    clickByAttrValue(host, AI_MODELS_PROMPT_SAVE_ATTR, 'chat');

    const pending = findByAttrValue(host, AI_MODELS_PROMPT_SAVE_ATTR, 'chat');
    const loadDefault = findByAttrValue(
      host,
      AI_MODELS_PROMPT_LOAD_DEFAULT_ATTR,
      'chat',
    );
    expect(pending?.textContent).toBe('Saving…');
    expect(pending?.getAttribute('aria-disabled')).toBe('true');
    expect(pending?.getAttribute('aria-busy')).toBe('true');
    expect(pending?.disabled).toBe(false);
    expect(loadDefault?.getAttribute('aria-disabled')).toBe('true');
    expect(loadDefault?.disabled).toBe(false);
    expect(findByAttrValue(
      host,
      AI_MODELS_PROMPT_TEXT_ATTR,
      'chat',
    )?.readOnly).toBe(true);
    clickByAttrValue(host, AI_MODELS_PROMPT_SAVE_ATTR, 'chat');
    expect(runSetLlmPrompt).toHaveBeenCalledTimes(1);

    // `Load default` is client-only, so single-flight has to be enforced in the
    // handler — an `aria-disabled` button still fires its click listener, and
    // overwriting the box mid-save would strand the owner looking at text the
    // in-flight request is not carrying.
    clickByAttrValue(host, AI_MODELS_PROMPT_LOAD_DEFAULT_ATTR, 'chat');
    expect(findByAttrValue(host, AI_MODELS_PROMPT_TEXT_ATTR, 'chat')?.value)
      .toBe('A durable owner-authored prompt.');

    resolveSave({ ok: true });
    await flush();
    const settled = findByAttrValue(host, AI_MODELS_PROMPT_SAVE_ATTR, 'chat');
    expect(settled?.textContent).toBe('Save');
    expect(settled?.getAttribute('aria-disabled')).toBeNull();
    expect(settled?.getAttribute('aria-busy')).toBeNull();
    expect(findByAttrValue(
      host,
      AI_MODELS_PROMPT_TEXT_ATTR,
      'chat',
    )?.readOnly).toBe(false);
    expect(findByAttrValue(
      host,
      AI_MODELS_PROMPT_LOAD_DEFAULT_ATTR,
      'chat',
    )?.getAttribute('aria-disabled')).toBeNull();
    mount.dispose();
  });

  it('sends block 1, the wire role, and the caller policy', async () => {
    const { host, mount, opts } = mountFixture();
    await mount.whenLoaded();

    const area = findByAttrValue(host, AI_MODELS_PROMPT_TEXT_ATTR, 'llm_gateway')!;
    area.value = 'You are a dentist. Check the calendar before answering.';
    for (const fn of area.listeners.get('input') ?? []) fn({});
    changeSelect(host, AI_MODELS_PROMPT_POLICY_ATTR, 'llm_gateway', 'append');
    clickByAttrValue(host, AI_MODELS_PROMPT_SAVE_ATTR, 'llm_gateway');
    await flush();

    expect(opts.runSetLlmPrompt).toHaveBeenCalledWith({
      surface: 'llm_gateway',
      role_instructions: 'You are a dentist. Check the calendar before answering.',
      role: 'system',
      caller_system_policy: 'append',
    });
    mount.dispose();
  });

  /** ⛔ The card has no role editor, so a save must CARRY the stored value.
   *  Re-asserting the default would silently undo an owner whose provider
   *  rejects `system` — a setting they can no longer see would revert on their
   *  next unrelated wording tweak, and nothing would say so. */
  it('carries a non-default wire role through a save untouched', async () => {
    const { host, mount, opts } = mountFixture({
      runGetLlmPrompts: vi.fn(async () => ({
        prompts: llmPrompts({ surface: 'chat', role: 'user' }),
      })),
    });
    await mount.whenLoaded();

    const area = findByAttrValue(host, AI_MODELS_PROMPT_TEXT_ATTR, 'chat')!;
    area.value = 'You are a lawyer.';
    for (const fn of area.listeners.get('input') ?? []) fn({});
    clickByAttrValue(host, AI_MODELS_PROMPT_SAVE_ATTR, 'chat');
    await flush();

    expect(opts.runSetLlmPrompt).toHaveBeenCalledWith({
      surface: 'chat',
      role_instructions: 'You are a lawyer.',
      role: 'user',
    });
    mount.dispose();
  });

  it('omits the caller policy on chat — there is no caller there', async () => {
    const { host, mount, opts } = mountFixture();
    await mount.whenLoaded();

    const area = findByAttrValue(host, AI_MODELS_PROMPT_TEXT_ATTR, 'chat')!;
    area.value = 'You are a lawyer.';
    for (const fn of area.listeners.get('input') ?? []) fn({});
    clickByAttrValue(host, AI_MODELS_PROMPT_SAVE_ATTR, 'chat');
    await flush();

    expect(opts.runSetLlmPrompt).toHaveBeenCalledWith({
      surface: 'chat',
      role_instructions: 'You are a lawyer.',
      role: 'system',
    });
    mount.dispose();
  });

  it('resets by sending null — the server deletes the row, absence IS the default', async () => {
    const { mount, opts } = mountFixture();
    await mount.whenLoaded();

    await mount.resetLlmPrompt('llm_gateway');

    expect(opts.runSetLlmPrompt).toHaveBeenCalledWith({
      surface: 'llm_gateway',
      role_instructions: null,
      role: null,
      caller_system_policy: null,
    });
    mount.dispose();
  });

  /** `Load default` writes NOTHING. The old control hit the server on first
   *  click, with the built-in never shown and no confirm — so "let me see what
   *  I'd be going back to" cost you the thing you were going back FROM. */
  it('loads the built-in into the box without touching the server', async () => {
    const { host, mount, opts } = mountFixture({
      runGetLlmPrompts: vi.fn(async () => ({
        prompts: llmPrompts({
          surface: 'chat',
          role_instructions: 'You are a dentist.',
          is_default: false,
        }),
      })),
    });
    await mount.whenLoaded();

    expect(findByAttrValue(host, AI_MODELS_PROMPT_TEXT_ATTR, 'chat')?.value)
      .toBe('You are a dentist.');
    clickByAttrValue(host, AI_MODELS_PROMPT_LOAD_DEFAULT_ATTR, 'chat');

    expect(findByAttrValue(host, AI_MODELS_PROMPT_TEXT_ATTR, 'chat')?.value)
      .toBe(CHAT_ROLE_DEFAULT);
    expect(findByAttrValue(host, AI_MODELS_PROMPT_STATUS_ATTR, 'chat')?.textContent)
      .toBe('Unsaved changes — Save to put this in force.');
    // Still customised on the server: nothing has been written yet.
    expect(opts.runSetLlmPrompt).not.toHaveBeenCalled();
    expect(findByAttrValue(host, AI_MODELS_PROMPT_BADGE_ATTR, 'custom'))
      .not.toBeNull();
    mount.dispose();
  });

  /** 🔑 …and this is what makes `Load default` + `Save` the reset the button
   *  used to be. `null` is the ONLY way the server expresses default (it
   *  deletes the row); storing a byte-identical copy would badge as Customised
   *  and PIN the text — a later release changing the built-in would never reach
   *  this server, silently, because the row still wins. */
  it('saves a box holding the built-in as null, not as a copy of it', async () => {
    const { host, mount, opts } = mountFixture({
      runGetLlmPrompts: vi.fn(async () => ({
        prompts: llmPrompts({
          surface: 'chat',
          role_instructions: 'You are a dentist.',
          role: 'user',
          is_default: false,
        }),
      })),
    });
    await mount.whenLoaded();

    clickByAttrValue(host, AI_MODELS_PROMPT_LOAD_DEFAULT_ATTR, 'chat');
    clickByAttrValue(host, AI_MODELS_PROMPT_SAVE_ATTR, 'chat');
    await flush();

    expect(opts.runSetLlmPrompt).toHaveBeenCalledWith({
      surface: 'chat',
      role_instructions: null,
      // A full reset takes the wire role with it — same as the old button.
      role: null,
    });
    mount.dispose();
  });

  /** ⛔ Hidden must not mean STUCK. The picker is gone, and `setSystemRole` has
   *  exactly one caller (`server.setLlmPrompt`) — no CLI, no config field — so
   *  a role left off-default with nothing on screen would be unreachable except
   *  by wiping the prompt it rides on. */
  it('announces an off-default wire role and offers the way back', async () => {
    const { host, mount, opts } = mountFixture({
      runGetLlmPrompts: vi.fn(async () => ({
        prompts: llmPrompts({
          surface: 'chat',
          role_instructions: 'You are a dentist.',
          role: 'user',
          is_default: false,
        }),
      })),
    });
    await mount.whenLoaded();

    // Silent on every surface still at the default — this is a rare state.
    expect(findByAttrValue(host, AI_MODELS_PROMPT_TRANSPORT_ATTR, 'llm_gateway'))
      .toBeNull();
    const notice = findByAttrValue(host, AI_MODELS_PROMPT_TRANSPORT_ATTR, 'chat');
    expect(notice).not.toBeNull();
    expect(hasText(
      notice!,
      'Delivered to the model as a user message, not a system message.',
    )).toBe(true);

    clickByAttrValue(host, AI_MODELS_PROMPT_TRANSPORT_RESET_ATTR, 'chat');
    await flush();

    // ROLE ONLY. `role_instructions: null` here would take the owner's text
    // with it, and a control labelled "Deliver as system" must not do that.
    expect(opts.runSetLlmPrompt).toHaveBeenCalledWith({
      surface: 'chat',
      role_instructions: 'You are a dentist.',
      role: null,
    });
    mount.dispose();
  });

  /** …and it must not commit UNSAVED edits sitting in the box above it. */
  it('reverts the role without saving the draft the owner is mid-way through', async () => {
    const { host, mount, opts } = mountFixture({
      runGetLlmPrompts: vi.fn(async () => ({
        prompts: llmPrompts({
          surface: 'chat',
          role_instructions: 'You are a dentist.',
          role: 'assistant',
          is_default: false,
        }),
      })),
    });
    await mount.whenLoaded();

    const area = findByAttrValue(host, AI_MODELS_PROMPT_TEXT_ATTR, 'chat')!;
    area.value = 'Half-typed thought I am not done with';
    for (const fn of area.listeners.get('input') ?? []) fn({});
    clickByAttrValue(host, AI_MODELS_PROMPT_TRANSPORT_RESET_ATTR, 'chat');
    await flush();

    expect(opts.runSetLlmPrompt).toHaveBeenCalledWith({
      surface: 'chat',
      role_instructions: 'You are a dentist.',
      role: null,
    });
    mount.dispose();
  });

  it('reads a blank box as a reset, never as a role with no instructions', async () => {
    const { host, mount, opts } = mountFixture();
    await mount.whenLoaded();

    const area = findByAttrValue(host, AI_MODELS_PROMPT_TEXT_ATTR, 'chat')!;
    area.value = '   \n  ';
    for (const fn of area.listeners.get('input') ?? []) fn({});
    clickByAttrValue(host, AI_MODELS_PROMPT_SAVE_ATTR, 'chat');
    await flush();

    expect(opts.runSetLlmPrompt).toHaveBeenCalledWith({
      surface: 'chat',
      role_instructions: null,
      role: null,
    });
    mount.dispose();
  });

  it('spells out what replace actually costs the owner', async () => {
    const { host, mount } = mountFixture();
    await mount.whenLoaded();

    changeSelect(host, AI_MODELS_PROMPT_POLICY_ATTR, 'llm_gateway', 'replace');

    // The trade is the owner's BEHAVIOURAL guardrails inside capability they
    // already granted. Say it, rather than leave them to discover it.
    const section = findByAttrValue(host, AI_MODELS_PROMPT_SECTION_ATTR, 'llm_gateway')!;
    expect(hasText(section, 'used instead of yours')).toBe(true);
    expect(hasText(section, 'your wording no longer applies')).toBe(true);
    mount.dispose();
  });
});

/** Test connection — `server.setLLMSlot` is parse-and-persist, so nothing in
 *  the save path ever contacts the endpoint. A wrong key, a model that does not
 *  exist, or a typo'd base_url is accepted silently and surfaces hours later as
 *  a failed recipe, attributed to whatever happened to run. This is the button
 *  that asks. */
describe('Test connection', () => {
  const probeOk = {
    ok: true,
    diagnosis: 'ok' as const,
    accepts_system_role: true,
    supports_json: true,
    elapsed_ms: 240,
  };

  it('probes the FORM values, not the saved slot', async () => {
    const runProbeLlmSource = vi.fn(async () => probeOk);
    const { host, mount } = mountFixture({ runProbeLlmSource });
    await mount.whenLoaded();

    const model = findByAttrValue(host, AI_MODELS_SLOT_FIELD_ATTR, 'slot_1:model')!;
    model.value = 'gpt-4o-mini';
    for (const fn of model.listeners.get('input') ?? []) fn({});
    clickByAttrValue(host, AI_MODELS_SLOT_TEST_ATTR, 'slot_1');
    await flush();

    // Mid-edit the owner is asking "will this work if I save it" — probing the
    // SAVED slot would answer a question nobody asked.
    expect(runProbeLlmSource).toHaveBeenCalledWith(expect.objectContaining({
      target: { kind: 'slot', slot_key: 'slot_1' },
      draft: expect.objectContaining({ model: 'gpt-4o-mini' }),
    }));
    mount.dispose();
  });

  /** ⚠ The stored key never reaches the client (redacted to `has_key`), so a
   *  blank field means "use the stored one" and only the SERVER can resolve it.
   *  Sending `api_key: ''` would read as "no credential". */
  it('omits the key entirely when the owner has not typed one', async () => {
    const runProbeLlmSource = vi.fn(
      async (_args: {
        target: { kind: string };
        draft?: Record<string, unknown> | null;
      }) => probeOk,
    );
    const { host, mount } = mountFixture({ runProbeLlmSource });
    await mount.whenLoaded();

    clickByAttrValue(host, AI_MODELS_SLOT_TEST_ATTR, 'slot_1');
    await flush();

    const sent = runProbeLlmSource.mock.calls[0]![0];
    expect('api_key' in (sent.draft ?? {})).toBe(false);
    mount.dispose();
  });

  it('shows a failure as a verdict naming the field, not a status code', async () => {
    const { host, mount } = mountFixture({
      runProbeLlmSource: vi.fn(async () => ({
        ok: false,
        diagnosis: 'auth' as const,
        detail: 'LLM auth failed (401): {"error":"bad key"}',
        elapsed_ms: 120,
      })),
    });
    await mount.whenLoaded();

    clickByAttrValue(host, AI_MODELS_SLOT_TEST_ATTR, 'slot_1');
    await flush();

    const box = findByAttrValue(host, AI_MODELS_SLOT_TEST_RESULT_ATTR, 'slot_1')!;
    expect(box.getAttribute('data-probe-ok')).toBe('false');
    // "401 Unauthorized" is the provider's framing; "the API key" is the
    // owner's, and it is the box they have to go and edit.
    expect(hasText(box, 'The API key was rejected. Check the key.')).toBe(true);
    // …and the provider's own words survive underneath, for a self-hosted
    // endpoint where the raw text is the only thing that identifies the fault.
    expect(hasText(box, 'bad key')).toBe(true);
    mount.dispose();
  });

  /** ⛔ A failed probe learned NOTHING about capabilities. Rendering a default
   *  as though it were observed is how a "verified" badge starts lying. */
  it('claims no capability facts on a failed probe', async () => {
    const { host, mount } = mountFixture({
      runProbeLlmSource: vi.fn(async () => ({
        ok: false,
        diagnosis: 'unreachable' as const,
        detail: 'LLM call failed: fetch failed',
        elapsed_ms: 20_000,
      })),
    });
    await mount.whenLoaded();
    clickByAttrValue(host, AI_MODELS_SLOT_TEST_ATTR, 'slot_1');
    await flush();

    const box = findByAttrValue(host, AI_MODELS_SLOT_TEST_RESULT_ATTR, 'slot_1')!;
    expect(hasText(box, 'JSON mode')).toBe(false);
    expect(hasText(box, 'system-message')).toBe(false);
    mount.dispose();
  });

  it('reports the capability facts nothing else verifies', async () => {
    const { host, mount } = mountFixture({
      runProbeLlmSource: vi.fn(async () => ({
        ok: true,
        diagnosis: 'ok' as const,
        accepts_system_role: false,
        supports_json: false,
        elapsed_ms: 90,
      })),
    });
    await mount.whenLoaded();
    clickByAttrValue(host, AI_MODELS_SLOT_TEST_ATTR, 'slot_1');
    await flush();

    const box = findByAttrValue(host, AI_MODELS_SLOT_TEST_RESULT_ATTR, 'slot_1')!;
    // `supports_json` is owner-DECLARED and defaults on — this is the first
    // thing in the product that has ever checked it.
    expect(hasText(box, 'JSON mode not supported')).toBe(true);
    expect(hasText(box, 'no system-message support')).toBe(true);
    mount.dispose();
  });

  /** ⚠ Costs a real request against the owner's credential. */
  it('is single-flight and never fires on its own', async () => {
    let release!: () => void;
    const runProbeLlmSource = vi.fn(
      () => new Promise<typeof probeOk>((resolve) => {
        release = () => resolve(probeOk);
      }),
    );
    const { host, mount } = mountFixture({ runProbeLlmSource });
    await mount.whenLoaded();
    // Nothing probes on load — the owner has to ask.
    expect(runProbeLlmSource).not.toHaveBeenCalled();

    clickByAttrValue(host, AI_MODELS_SLOT_TEST_ATTR, 'slot_1');
    const button = findByAttrValue(host, AI_MODELS_SLOT_TEST_ATTR, 'slot_1');
    expect(button?.textContent).toBe('Testing…');
    expect(button?.getAttribute('aria-busy')).toBe('true');
    clickByAttrValue(host, AI_MODELS_SLOT_TEST_ATTR, 'slot_1');
    clickByAttrValue(host, AI_MODELS_SLOT_TEST_ATTR, 'slot_2');
    expect(runProbeLlmSource).toHaveBeenCalledTimes(1);

    release();
    await flush();
    expect(findByAttrValue(host, AI_MODELS_SLOT_TEST_ATTR, 'slot_1')?.textContent)
      .toBe('Test connection');
    mount.dispose();
  });

/** ⚠ TWO things the base fixture omits, and BOTH are required. The card is
   *  gated on `runSetTranscriptionSlot` being wired at all (`renderTranscriptionSlot`
   *  returns early without it), and the Test button needs a slot in the config to
   *  probe. Supplying only the config renders nothing and the failure reads as
   *  "no element" — which says nothing about which half is missing. */
  const transcriptionFixture = () => ({
    runGetLLMConfig: vi.fn(async () => ({
      config: {
        ...llmConfig(),
        transcription_slot: { provider: 'openai', model: 'whisper-1', has_key: true },
      },
    })),
    runSetTranscriptionSlot: vi.fn(async () => ({ ok: true as const })),
  });
  // ⛔⛔ REVIEW FINDING (2026-09-07). THE SERVER RETURNED THE TRANSCRIPT AND THE
  // PAGE DROPPED IT. § B7 added the field for one stated reason: a
  // `transcription_language` the owner did not mean returns fluent NONSENSE
  // rather than an error, and this is the only surface that can reveal it.
  // Rendering the verdict and the elapsed time and nothing else defeated the
  // whole check — "ok, 900 ms" over a slot mis-set to Turkish looks exactly
  // like one that works. Same "handled but never reaching the surface" shape as
  // a broadcast kind nobody subscribed to.
  it('⛔⛔ SHOWS what the transcription probe heard, beside what the clip says', async () => {
    const runProbeLlmSource = vi.fn(async () => ({
      ok: true,
      diagnosis: 'ok' as const,
      transcript: 'Bu bir transkript mikrofon testidir.',
      expected_transcript: 'This is a transcript microphone test.',
      probe_language: 'tr',
      elapsed_ms: 910,
    }));
    const { host, mount } = mountFixture({ runProbeLlmSource, ...transcriptionFixture() });
    await mount.whenLoaded();

    clickByAttrValue(host, AI_MODELS_SLOT_TEST_ATTR, 'transcription_slot');
    await flush();

    const box = findByAttrValue(host, AI_MODELS_SLOT_TEST_RESULT_ATTR, 'transcription_slot')!;
    // ⛔ The heard line has to REACH the page. Asserting only `ok` is what let
    // this ship: the verdict was right and the evidence was discarded.
    expect(hasText(box, 'Bu bir transkript mikrofon testidir.')).toBe(true);
    // ⚠ And the expected line beside it — the owner may not read Turkish, which
    // is exactly the case the field exists for. One line alone is unjudgeable.
    expect(hasText(box, 'This is a transcript microphone test.')).toBe(true);
    // The pin that caused it, so the mismatch is traceable to a setting.
    expect(hasText(box, 'tr')).toBe(true);
    mount.dispose();
  });

  it('⚠ says `auto-detect` rather than nothing when no language was pinned', async () => {
    // Absent is a real answer, not a missing one — and it is a DIFFERENT answer
    // from any particular language.
    const runProbeLlmSource = vi.fn(async () => ({
      ok: true,
      diagnosis: 'ok' as const,
      transcript: 'This is a transcript microphone test.',
      expected_transcript: 'This is a transcript microphone test.',
      elapsed_ms: 400,
    }));
    const { host, mount } = mountFixture({ runProbeLlmSource, ...transcriptionFixture() });
    await mount.whenLoaded();
    clickByAttrValue(host, AI_MODELS_SLOT_TEST_ATTR, 'transcription_slot');
    await flush();
    const box = findByAttrValue(host, AI_MODELS_SLOT_TEST_RESULT_ATTR, 'transcription_slot')!;
    expect(hasText(box, 'auto-detect')).toBe(true);
    mount.dispose();
  });

  it('⛔ renders NO transcript block for a FAILED probe — it learned nothing', async () => {
    const runProbeLlmSource = vi.fn(async () => ({
      ok: false,
      diagnosis: 'auth' as const,
      detail: 'invalid api key',
      elapsed_ms: 30,
    }));
    const { host, mount } = mountFixture({ runProbeLlmSource, ...transcriptionFixture() });
    await mount.whenLoaded();
    clickByAttrValue(host, AI_MODELS_SLOT_TEST_ATTR, 'transcription_slot');
    await flush();
    const box = findByAttrValue(host, AI_MODELS_SLOT_TEST_RESULT_ATTR, 'transcription_slot')!;
    expect(findByAttrValue(box, AI_MODELS_PROBE_TRANSCRIPT_ATTR, 'true')).toBeFalsy();
    mount.dispose();
  });

  /** ⚠ Same button, DIFFERENT probe on the far side — `embed`, not a chat
   *  completion. The fact that comes back is the vector width. */
  it('reports the vector width for the embeddings slot', async () => {
    const runProbeLlmSource = vi.fn(async () => ({
      ok: true,
      diagnosis: 'ok' as const,
      dimensions: 1536,
      elapsed_ms: 88,
    }));
    const { host, mount } = mountFixture({ runProbeLlmSource });
    await mount.whenLoaded();

    clickByAttrValue(host, AI_MODELS_SLOT_TEST_ATTR, 'embeddings_slot');
    await flush();

    expect(runProbeLlmSource).toHaveBeenCalledWith(expect.objectContaining({
      target: { kind: 'slot', slot_key: 'embeddings_slot' },
    }));
    const box = findByAttrValue(host, AI_MODELS_SLOT_TEST_RESULT_ATTR, 'embeddings_slot')!;
    // A model quietly serving 768-d where the owner expected 1536-d is a
    // working connection that produces unusable neighbours.
    expect(hasText(box, '1536-dimension vectors')).toBe(true);
    // …and no chat capability claims, because neither question applies here.
    expect(hasText(box, 'JSON mode')).toBe(false);
    mount.dispose();
  });

  it('probes one pool entry by id, and sends no draft for it', async () => {
    const runProbeLlmSource = vi.fn(
      async (_args: { target: { kind: string }; draft?: unknown }) => probeOk,
    );
    const { host, mount } = mountFixture({
      runProbeLlmSource,
      runGetLLMConfig: vi.fn(async () => ({
        config: {
          free_pool: [
            { id: 'groq-a', type: 'api', provider: 'openai-compatible', model: 'llama', enabled: true },
            { id: 'groq-b', type: 'api', provider: 'openai-compatible', model: 'llama', enabled: true },
          ],
        } as never,
      })),
    });
    await mount.whenLoaded();

    clickByAttrValue(host, AI_MODELS_SLOT_TEST_ATTR, 'pool:groq-b');
    await flush();

    const sent = runProbeLlmSource.mock.calls[0]![0];
    expect(sent.target).toEqual({ kind: 'pool_entry', entry_id: 'groq-b' });
    // A pool row has no editable fields, so there is nothing to draft — sending
    // one would invent form values the owner never typed.
    expect('draft' in sent).toBe(false);
    expect(findByAttrValue(host, AI_MODELS_SLOT_TEST_RESULT_ATTR, 'pool:groq-b'))
      .not.toBeNull();
    // The sibling row's verdict slot stays empty.
    expect(findByAttrValue(host, AI_MODELS_SLOT_TEST_RESULT_ATTR, 'pool:groq-a'))
      .toBeNull();
    mount.dispose();
  });
  it('T3-AUD-1 — a pool row DISCLOSES what that provider does with the owner data', async () => {
    // The composition check. The resolver's own unit tests prove the table is
    // right; only this proves an owner ever SEES it. The defect was never a
    // wrong claim — it was the total absence of one, on the surface where the
    // trade is actually taken.
    const { host, mount } = mountFixture({
      runGetLLMConfig: vi.fn(async () => ({
        config: {
          free_pool: [
            // Native Google: no base_url, so the provider id is the only handle.
            { id: 'gem', type: 'api', provider: 'google', model: 'gemini-flash', enabled: true },
            // A local endpoint: nothing leaves the machine.
            { id: 'ollama', type: 'api', provider: 'openai-compatible', model: 'qwen',
              base_url: 'http://localhost:11434/v1', enabled: true },
            // A provider whose terms nobody has read.
            { id: 'other', type: 'api', provider: 'openai-compatible', model: 'x',
              base_url: 'https://openrouter.ai/api/v1', enabled: true },
          ],
        } as never,
      })),
    });
    await mount.whenLoaded();

    const gem = findByAttrValue(host, AI_MODELS_CONTROL_ATTR, 'free_pool:gem:data_use');
    expect(gem).not.toBeNull();
    // The clause with legal teeth for a large part of the audience.
    expect(gem!.textContent).toContain('only PAID use');
    expect(gem!.textContent).toContain('trains on what you send');
    // Cited, so the owner can go and read it themselves.
    expect(gem!.textContent).toContain('https://ai.google.dev/gemini-api/terms');

    // ⛔ SILENT for a local endpoint. A warning here would be false, and noise
    // is what makes a real warning ignorable.
    expect(findByAttrValue(host, AI_MODELS_CONTROL_ATTR, 'free_pool:ollama:data_use'))
      .toBeNull();

    // …but NOT silent for an unread provider: "we have not checked" is
    // information, and saying nothing would read as approval.
    const other = findByAttrValue(host, AI_MODELS_CONTROL_ATTR, 'free_pool:other:data_use');
    expect(other).not.toBeNull();
    expect(other!.textContent).toContain('not reviewed');

    mount.dispose();
  });

  /** ⚠ Each probe is a real request against the owner's credential, and a
   *  column of Test buttons is an invitation to fire five at once. */
  it('is single-flight ACROSS sources, not just within one', async () => {
    let release!: () => void;
    const runProbeLlmSource = vi.fn(
      () => new Promise<typeof probeOk>((resolve) => { release = () => resolve(probeOk); }),
    );
    const { host, mount } = mountFixture({ runProbeLlmSource });
    await mount.whenLoaded();

    clickByAttrValue(host, AI_MODELS_SLOT_TEST_ATTR, 'slot_1');
    clickByAttrValue(host, AI_MODELS_SLOT_TEST_ATTR, 'embeddings_slot');
    expect(runProbeLlmSource).toHaveBeenCalledTimes(1);
    expect(findByAttrValue(host, AI_MODELS_SLOT_TEST_ATTR, 'embeddings_slot')
      ?.getAttribute('aria-disabled')).toBe('true');

    release();
    await flush();
    expect(findByAttrValue(host, AI_MODELS_SLOT_TEST_ATTR, 'embeddings_slot')
      ?.getAttribute('aria-disabled')).toBeNull();
    mount.dispose();
  });

  it('hides the button when the caller is not wired', async () => {
    const { host, mount } = mountFixture({ runProbeLlmSource: undefined });
    await mount.whenLoaded();
    expect(findByAttrValue(host, AI_MODELS_SLOT_TEST_ATTR, 'slot_1')).toBeNull();
    mount.dispose();
  });
});
