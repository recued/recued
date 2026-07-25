/** D-174 D14 — Settings -> AI / Models consolidated LLM config page. */

import { describe, expect, it, vi } from 'vitest';

import type {
  HousekeepingConfigRow,
  ServerConfigField,
  ServerLlmPrompt,
} from '@recued/contracts';

import {
  AI_MODELS_ACTION_ERROR_ATTR,
  AI_MODELS_CATALOG_MODE_SELECT_ATTR,
  AI_MODELS_CONTEXT_WINDOW_INPUT_ATTR,
  AI_MODELS_FAIL_LOUD_ATTR,
  AI_MODELS_PENDING_CONTROL_ATTR,
  AI_MODELS_POOL_REMOVE_ATTR,
  AI_MODELS_PROMPT_BADGE_ATTR,
  AI_MODELS_PROMPT_RESET_ATTR,
  AI_MODELS_PROMPT_ROLE_ATTR,
  AI_MODELS_PROMPT_SAVE_ATTR,
  AI_MODELS_PROMPT_ALWAYS_ATTR,
  AI_MODELS_PROMPT_POLICY_ATTR,
  AI_MODELS_PROMPT_SECTION_ATTR,
  AI_MODELS_PROMPT_TEXT_ATTR,
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

describe('D-174 D14 — AI / Models write-through controls', () => {
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

  it('surfaces a failed write as an action-error banner (no unhandled rejection)', async () => {
    const { host, mount } = mountFixture({
      runSetLLMSlot: vi.fn(async () => {
        throw new Error('boom');
      }),
    });
    await mount.whenLoaded();
    expect(findByAttr(host, AI_MODELS_ACTION_ERROR_ATTR)).toBeNull();
    // Click "Save slot" on slot_2 → the button handler fires the action
    // through surface(), which catches the rejected rpc and renders the
    // banner (vs the old bare `void api.x()` unhandled rejection).
    clickByAttrValue(host, AI_MODELS_SLOT_SAVE_ATTR, 'slot_2');
    await flush();
    const banner = findByAttr(host, AI_MODELS_ACTION_ERROR_ATTR);
    expect(banner).not.toBeNull();
    expect(banner!.textContent.length).toBeGreaterThan(0);
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

  it('the Automatic hint states the shipped default per source (free pool → Index, slots → Full)', async () => {
    const { host, mount } = mountFixture();
    await mount.whenLoaded();
    // The free-pool control recommends Index; the BYOK slot controls recommend Full.
    expect(hasText(host, 'Automatic uses Index for the free pool')).toBe(true);
    expect(hasText(host, 'Automatic uses Full for a BYOK slot')).toBe(true);
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
  it('sends block 1, the wire role, and the caller policy', async () => {
    const { host, mount, opts } = mountFixture();
    await mount.whenLoaded();

    const area = findByAttrValue(host, AI_MODELS_PROMPT_TEXT_ATTR, 'llm_gateway')!;
    area.value = 'You are a dentist. Check the calendar before answering.';
    for (const fn of area.listeners.get('input') ?? []) fn({});
    changeSelect(host, AI_MODELS_PROMPT_POLICY_ATTR, 'llm_gateway', 'append');
    changeSelect(host, AI_MODELS_PROMPT_ROLE_ATTR, 'llm_gateway', 'user');
    clickByAttrValue(host, AI_MODELS_PROMPT_SAVE_ATTR, 'llm_gateway');
    await flush();

    expect(opts.runSetLlmPrompt).toHaveBeenCalledWith({
      surface: 'llm_gateway',
      role_instructions: 'You are a dentist. Check the calendar before answering.',
      role: 'user',
      caller_system_policy: 'append',
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
    const { host, mount, opts } = mountFixture();
    await mount.whenLoaded();

    clickByAttrValue(host, AI_MODELS_PROMPT_RESET_ATTR, 'llm_gateway');
    await flush();

    expect(opts.runSetLlmPrompt).toHaveBeenCalledWith({
      surface: 'llm_gateway',
      role_instructions: null,
      role: null,
      caller_system_policy: null,
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
