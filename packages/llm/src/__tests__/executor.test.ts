import { beforeEach, describe, it, expect, vi } from 'vitest';
import { executeLLM } from '../executor.js';
import { resetEndpointCapabilities } from '../endpoint-capabilities.js';
import { LLMError } from '../types.js';
import type { LLMAdapter, LLMConfig, LLMMessage } from '../types.js';
import type { IngredientManifest, WebChatTab } from '@recued/contracts';
import { createQuotaTracker } from '../quota.js';

// ⚠ The endpoint-capability memories (native JSON mode, the `system` wire role)
// are PROCESS-GLOBAL by design — they exist so a rejection is paid once per
// endpoint rather than once per call. That makes them leak between test cases:
// the json-fallback test below records a rejection for this fixture's slot, and
// without this reset the NEXT case starts with json mode already suppressed and
// silently asserts nothing. Any test asserting on per-call request shape needs
// this.
beforeEach(() => {
  resetEndpointCapabilities();
});

const baseManifest: IngredientManifest = {
  slug: 'ai-classify',
  name: 'Classify',
  description: 'Classifier',
  author: 'recued',
  kind: 'ai',
  category: 'ai',
  risk_tier: 'read',
  input: {},
  output: {},
};

const config: LLMConfig = {
  slot_1: { provider: 'openai', model: 'gpt-fast', api_key: 'sk-1' },
  slot_2: {
    provider: 'anthropic',
    model: 'claude-quality',
    api_key: 'sk-2',
    supports_thinking: true,
    supports_search: true,
  },
};

/** Build a fake adapter that returns canned responses in order. */
const ZERO_USAGE = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };

const fakeAdapter = (responses: string[]): LLMAdapter => {
  let i = 0;
  return {
    provider: 'anthropic',
    complete: vi.fn(async () => {
      if (i >= responses.length) throw new Error(`No more canned responses (requested ${i + 1})`);
      return { text: responses[i++], usage: ZERO_USAGE };
    }),
  };
};

const noTabs = async (): Promise<Set<WebChatTab>> => new Set();

const makeDeps = (adapter: LLMAdapter) => ({
  config,
  adapters: () => adapter,
  quota: createQuotaTracker(),
  tabProbe: noTabs,
});

describe('executeLLM — contracted (ai-classify)', () => {
  it('returns parsed object on first success', async () => {
    const adapter = fakeAdapter([
      '{"category": "greeting", "confidence": 0.9, "reasoning": "hi"}',
    ]);
    const result = await executeLLM(
      baseManifest,
      { 'llm.data': 'hello', 'llm.categories': ['greeting', 'other'] },
      makeDeps(adapter),
    );
    expect(result).toEqual({ category: 'greeting', confidence: 0.9, reasoning: 'hi' });
    expect(adapter.complete).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry on parse failure — one call = one billing event', async () => {
    // Policy: the executor throws AI_OUTPUT_INVALID on the first parse
    // failure. No corrective re-prompt, no second network call. If the
    // user wants to try again they press Run; the system never silently
    // double-bills them for a malformed response they had no control over.
    const adapter = fakeAdapter(['Sorry, I cannot output JSON here.']);
    await expect(
      executeLLM(
        baseManifest,
        { 'llm.data': 'hello', 'llm.categories': ['greeting'] },
        makeDeps(adapter),
      ),
    ).rejects.toMatchObject({ code: 'AI_OUTPUT_INVALID' });
    expect(adapter.complete).toHaveBeenCalledTimes(1);
  });

  it('throws AI_OUTPUT_INVALID on first unparsable response', async () => {
    const adapter = fakeAdapter(['garbage']);
    await expect(
      executeLLM(
        baseManifest,
        { 'llm.data': 'x', 'llm.categories': ['a'] },
        makeDeps(adapter),
      ),
    ).rejects.toMatchObject({ code: 'AI_OUTPUT_INVALID' });
    expect(adapter.complete).toHaveBeenCalledTimes(1);
  });
});

describe('executeLLM — uncontracted (ai-prompt)', () => {
  const promptManifest: IngredientManifest = { ...baseManifest, slug: 'ai-prompt' };

  it('returns raw text by default', async () => {
    const adapter = fakeAdapter(['The answer is 42.']);
    const result = await executeLLM(
      promptManifest,
      { 'llm.prompt': 'What is 6x7?' },
      makeDeps(adapter),
    );
    expect(result).toBe('The answer is 42.');
  });

  it('parses JSON when llm.output_format=json', async () => {
    const adapter = fakeAdapter(['{"answer": 42}']);
    const result = await executeLLM(
      promptManifest,
      { 'llm.prompt': 'q', 'llm.output_format': 'json' },
      makeDeps(adapter),
    );
    expect(result).toEqual({ answer: 42 });
  });

  it('falls back to raw text if JSON parse fails', async () => {
    const adapter = fakeAdapter(['not json']);
    const result = await executeLLM(
      promptManifest,
      { 'llm.prompt': 'q', 'llm.output_format': 'json' },
      makeDeps(adapter),
    );
    expect(result).toBe('not json');
  });

  it('strips a ```json markdown fence the model wrapped its object in', async () => {
    // Real reasoning/coding models (e.g. DashScope qwen3.7) ignore the
    // "JSON only, never markdown" instruction — the fence-tolerant fallback
    // recovers the object instead of leaking a raw string downstream.
    const adapter = fakeAdapter(['```json\n{"answer": 42}\n```']);
    const result = await executeLLM(
      promptManifest,
      { 'llm.prompt': 'q', 'llm.output_format': 'json' },
      makeDeps(adapter),
    );
    expect(result).toEqual({ answer: 42 });
  });

  it('extracts an object from surrounding prose', async () => {
    const adapter = fakeAdapter(['Sure, here you go: {"answer": 42} — done.']);
    const result = await executeLLM(
      promptManifest,
      { 'llm.prompt': 'q', 'llm.output_format': 'json' },
      makeDeps(adapter),
    );
    expect(result).toEqual({ answer: 42 });
  });

  it('recovers a fenced top-level array of objects', async () => {
    const adapter = fakeAdapter([
      '```json\n[{"tool": "a", "args": {}}, {"tool": "b", "args": {}}]\n```',
    ]);
    const result = await executeLLM(
      promptManifest,
      { 'llm.prompt': 'q', 'llm.output_format': 'json' },
      makeDeps(adapter),
    );
    expect(result).toEqual([
      { tool: 'a', args: {} },
      { tool: 'b', args: {} },
    ]);
  });

  it('recovers a fenced OBJECT whose value holds a nested array (the real AIOutput shape)', async () => {
    // The array-first fallback must NOT misfire on the common chat envelope —
    // `{response, events, tool_calls:[…]}` contains a `[`, but its `{` comes
    // first, so `parseJSONArray` returns null (firstObject < firstArray) and it
    // falls to the object scanner. Recovered as the whole object, not the
    // nested tool_calls array.
    const adapter = fakeAdapter([
      '```json\n{"response": "ok", "events": [], "tool_calls": [{"tool": "x", "args": {}}]}\n```',
    ]);
    const result = await executeLLM(
      promptManifest,
      { 'llm.prompt': 'q', 'llm.output_format': 'json' },
      makeDeps(adapter),
    );
    expect(result).toEqual({
      response: 'ok',
      events: [],
      tool_calls: [{ tool: 'x', args: {} }],
    });
  });
});

describe('executeLLM — native JSON mode + graceful fallback', () => {
  const promptManifest: IngredientManifest = { ...baseManifest, slug: 'ai-prompt' };
  const jsonConfig: LLMConfig = {
    slot_1: { provider: 'openai', model: 'gpt-fast', api_key: 'sk-1', supports_json: true },
  };
  // An adapter that records each call's options + serves canned text, optionally
  // throwing a chosen error on the first (json-mode) attempt.
  const recordingAdapter = (responses: string[], failFirstJson?: LLMError) => {
    const seen: Array<{ json?: boolean }> = [];
    let i = 0;
    const adapter: LLMAdapter = {
      provider: 'openai',
      complete: async (_slot, _messages, opts) => {
        seen.push({ json: opts.json });
        if (failFirstJson && opts.json) throw failFirstJson;
        if (i >= responses.length) throw new Error('no more canned responses');
        return { text: responses[i++], usage: ZERO_USAGE };
      },
    };
    return { adapter, seen };
  };

  it('passes json:true when output_format=json and the slot declares supports_json', async () => {
    const { adapter, seen } = recordingAdapter(['{"a":1}']);
    await executeLLM(
      promptManifest,
      { 'llm.prompt': 'q', 'llm.output_format': 'json' },
      { ...makeDeps(adapter), config: jsonConfig },
    );
    expect(seen[0].json).toBe(true);
  });

  it('defaults json mode ON for a slot without explicit supports_json (normalized true)', async () => {
    // normalizeLLMSlot fills supports_json -> true for legacy/unspecified slots,
    // so json mode is sent broadly; non-supporting endpoints degrade via the
    // request-boundary fallback below rather than being opted out up-front.
    const { adapter, seen } = recordingAdapter(['{"a":1}']);
    await executeLLM(
      promptManifest,
      { 'llm.prompt': 'q', 'llm.output_format': 'json' },
      makeDeps(adapter), // default config — no explicit supports_json
    );
    expect(seen[0].json).toBe(true);
  });

  it('a supports_json:false slot is filtered for a json call — complete never reached, so never json-moded', async () => {
    // require_json (match.ts) excludes a non-json-capable slot from a json call,
    // so the executor never even calls complete on it — this is the upstream
    // reason the json-mode gate can never send response_format to a false slot.
    const { adapter, seen } = recordingAdapter(['{"a":1}']);
    const noJsonConfig: LLMConfig = {
      slot_1: { provider: 'openai', model: 'gpt-fast', api_key: 'sk-1', supports_json: false },
    };
    await expect(
      executeLLM(
        promptManifest,
        { 'llm.prompt': 'q', 'llm.output_format': 'json' },
        { ...makeDeps(adapter), config: noJsonConfig },
      ),
    ).rejects.toThrow();
    expect(seen).toEqual([]);
  });

  it('does NOT pass json mode for a plain-text call even on a supports_json slot', async () => {
    const { adapter, seen } = recordingAdapter(['hello']);
    await executeLLM(
      promptManifest,
      { 'llm.prompt': 'q' },
      { ...makeDeps(adapter), config: jsonConfig },
    );
    expect(seen[0].json).toBeFalsy();
  });

  it('retries WITHOUT json mode on a non-retryable error from the json attempt', async () => {
    const { adapter, seen } = recordingAdapter(
      ['{"a":2}'],
      new LLMError('AI_LLM_UNAVAILABLE', 'LLM error (400): response_format not supported'),
    );
    const result = await executeLLM(
      promptManifest,
      { 'llm.prompt': 'q', 'llm.output_format': 'json' },
      { ...makeDeps(adapter), config: jsonConfig },
    );
    expect(result).toEqual({ a: 2 });
    expect(seen).toEqual([{ json: true }, { json: false }]);
  });

  it('does NOT fall back to plain mode on a retryable error', async () => {
    const { adapter, seen } = recordingAdapter(
      ['{"a":3}'],
      new LLMError('AI_LLM_UNAVAILABLE', 'rate limited', { status: 429 }, true),
    );
    await expect(
      executeLLM(
        promptManifest,
        { 'llm.prompt': 'q', 'llm.output_format': 'json' },
        { ...makeDeps(adapter), config: jsonConfig },
      ),
    ).rejects.toThrow();
    expect(seen).not.toContainEqual({ json: false });
  });
});

describe('executeLLM — hint resolution', () => {
  it('defaults to quality slot when no hint provided', async () => {
    const adapter = fakeAdapter(['{"rewritten": "x"}']);
    const spy = vi.spyOn(adapter, 'complete');
    await executeLLM(
      { ...baseManifest, slug: 'ai-rewrite' },
      { 'llm.data': 'x', 'llm.style': 'formal' },
      makeDeps(adapter),
    );
    const callArgs = spy.mock.calls[0];
    const passedSlot = callArgs[0];
    expect(passedSlot.model).toBe('claude-quality'); // slot_2
  });

  it('respects llm.model_hint from input', async () => {
    const adapter = fakeAdapter(['{"rewritten": "x"}']);
    const spy = vi.spyOn(adapter, 'complete');
    await executeLLM(
      { ...baseManifest, slug: 'ai-rewrite' },
      { 'llm.data': 'x', 'llm.style': 'formal', 'llm.model_hint': 'fast' },
      makeDeps(adapter),
    );
    expect(spy.mock.calls[0][0].model).toBe('gpt-fast'); // slot_1
  });

  it('falls back to manifest default hint when input lacks it', async () => {
    const adapter = fakeAdapter(['{"rewritten": "x"}']);
    const spy = vi.spyOn(adapter, 'complete');
    const fastDefault: IngredientManifest = {
      ...baseManifest,
      slug: 'ai-rewrite',
      input: { 'llm.model_hint': 'fast' },
    };
    await executeLLM(
      fastDefault,
      { 'llm.data': 'x', 'llm.style': 'formal' },
      makeDeps(adapter),
    );
    expect(spy.mock.calls[0][0].model).toBe('gpt-fast');
  });
});

describe('executeLLM — max_tokens computation', () => {
  it('passes 8000 for quality', async () => {
    const adapter = fakeAdapter(['{"rewritten": "x"}']);
    await executeLLM(
      { ...baseManifest, slug: 'ai-rewrite' },
      { 'llm.data': 'x', 'llm.style': 'formal' },
      makeDeps(adapter),
    );
    const opts = (adapter.complete as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][2] as { max_tokens: number };
    expect(opts.max_tokens).toBe(8000);
  });

  it('passes 4000 for fast', async () => {
    const adapter = fakeAdapter(['{"rewritten": "x"}']);
    await executeLLM(
      { ...baseManifest, slug: 'ai-rewrite' },
      { 'llm.data': 'x', 'llm.style': 'formal', 'llm.model_hint': 'fast' },
      makeDeps(adapter),
    );
    const opts = (adapter.complete as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][2] as { max_tokens: number };
    expect(opts.max_tokens).toBe(4000);
  });
});

describe('executeLLM — timeout defaults to null (no auto-abort)', () => {
  it('passes null when deps.timeout_ms is undefined', async () => {
    const adapter = fakeAdapter(['{"rewritten": "x"}']);
    await executeLLM(
      { ...baseManifest, slug: 'ai-rewrite' },
      { 'llm.data': 'x', 'llm.style': 'formal' },
      makeDeps(adapter),
    );
    const opts = (adapter.complete as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][2] as { timeout_ms: number | null };
    expect(opts.timeout_ms).toBeNull();
  });

  it('respects explicit deps.timeout_ms override when caller opts in', async () => {
    const adapter = fakeAdapter(['{"rewritten": "x"}']);
    await executeLLM(
      { ...baseManifest, slug: 'ai-rewrite' },
      { 'llm.data': 'x', 'llm.style': 'formal' },
      { ...makeDeps(adapter), timeout_ms: 60_000 },
    );
    const opts = (adapter.complete as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][2] as { timeout_ms: number | null };
    expect(opts.timeout_ms).toBe(60_000);
  });

  it('clamps an absurdly high opted-in override to the hard cap (2 hours)', async () => {
    const adapter = fakeAdapter(['{"rewritten": "x"}']);
    await executeLLM(
      { ...baseManifest, slug: 'ai-rewrite' },
      { 'llm.data': 'x', 'llm.style': 'formal' },
      { ...makeDeps(adapter), timeout_ms: 99_999_999 },
    );
    const opts = (adapter.complete as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][2] as { timeout_ms: number | null };
    expect(opts.timeout_ms).toBe(7_200_000); // LLM_HARD_CAP_MS
  });

  it('clamps a non-number override to null (treated as no opt-in)', async () => {
    const adapter = fakeAdapter(['{"rewritten": "x"}']);
    await executeLLM(
      { ...baseManifest, slug: 'ai-rewrite' },
      { 'llm.data': 'x', 'llm.style': 'formal' },
      { ...makeDeps(adapter), timeout_ms: 'forever' as unknown as number },
    );
    const opts = (adapter.complete as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][2] as { timeout_ms: number | null };
    expect(opts.timeout_ms).toBeNull();
  });
});

describe('executeLLM — misconfiguration', () => {
  it('throws AI_LLM_UNAVAILABLE when no slots configured', async () => {
    const adapter = fakeAdapter([]);
    await expect(
      executeLLM(
        baseManifest,
        { 'llm.data': 'x', 'llm.categories': ['a'] },
        { config: {}, adapters: () => adapter, quota: createQuotaTracker(), tabProbe: noTabs },
      ),
    ).rejects.toMatchObject({ code: 'AI_LLM_UNAVAILABLE' });
  });

  it('throws when contracted prompt is missing required input', async () => {
    const adapter = fakeAdapter([]);
    await expect(
      executeLLM(baseManifest, { 'llm.categories': ['a'] }, makeDeps(adapter)),
    ).rejects.toThrow(LLMError);
  });
});

// ────────────────────────────────────────────────────────────────
// Cross-call cooldown — 429 marks the source in QuotaTracker so
// subsequent calls skip it until Retry-After expires.
// ────────────────────────────────────────────────────────────────

describe('executeLLM — rate-limit cooldown persists to the quota tracker', () => {
  // Both slots at fast tier so the matcher has two candidates at the
  // same speed level — lets rejectSet push us from slot_1 to slot_2
  // without needing the upgrade/downgrade relaxation path.
  const twoFastSlots: LLMConfig = {
    slot_1: {
      provider: 'openai', model: 'gpt-fast-a', api_key: 'sk-a',
      speed: 'fast', supports_json: true,
    },
    slot_2: {
      provider: 'openai', model: 'gpt-fast-b', api_key: 'sk-b',
      speed: 'fast', supports_json: true,
    },
  };

  it('on retryable 429 with retry_after_ms, the failed source is put in cooldown for that duration', async () => {
    const adapter: LLMAdapter = {
      provider: 'openai',
      complete: vi.fn(async (slot) => {
        if (slot.model === 'gpt-fast-a') {
          throw new LLMError(
            'AI_LLM_UNAVAILABLE',
            'rate limited (429)',
            { status: 429, retry_after_ms: 120_000 },
            true,
          );
        }
        return {
          text: '{"category":"a","confidence":1,"reasoning":"ok"}',
          usage: ZERO_USAGE,
        };
      }),
    };
    const quota = createQuotaTracker();
    await executeLLM(
      baseManifest,
      { 'llm.data': 'hi', 'llm.categories': ['a'] },
      { config: twoFastSlots, adapters: () => adapter, quota, tabProbe: noTabs },
    );

    // Cascade ran: slot_1 → slot_2 → success.
    expect(adapter.complete).toHaveBeenCalledTimes(2);
    // slot_1 is now in cooldown for 120s; slot_2 is not.
    expect(quota.isInCooldown('slot_1')).toBe(true);
    expect(quota.isInCooldown('slot_2')).toBe(false);
  });

  it('a second executeLLM call with the same QuotaTracker skips the cooling source without a round-trip', async () => {
    // End-to-end cross-call proof: call 1 sees slot_1 get 429'd (one
    // adapter invocation, cascades to slot_2). Call 2 shares the same
    // QuotaTracker, so buildAvailability filters slot_1 out before
    // match even considers it — the adapter is invoked exactly ONCE
    // on call 2 (slot_2 directly, NOT slot_1-then-cascade).
    const adapter: LLMAdapter = {
      provider: 'openai',
      complete: vi.fn(async (slot) => {
        if (slot.model === 'gpt-fast-a') {
          throw new LLMError(
            'AI_LLM_UNAVAILABLE',
            'rate limited (429)',
            { status: 429, retry_after_ms: 60_000 },
            true,
          );
        }
        return {
          text: '{"category":"a","confidence":1,"reasoning":"ok"}',
          usage: ZERO_USAGE,
        };
      }),
    };
    const quota = createQuotaTracker();
    const deps = { config: twoFastSlots, adapters: () => adapter, quota, tabProbe: noTabs };

    await executeLLM(
      baseManifest,
      { 'llm.data': 'hi', 'llm.categories': ['a'] },
      deps,
    );
    // Call 1: 2 adapter invocations (slot_1 429 → cascade → slot_2 ok).
    expect(adapter.complete).toHaveBeenCalledTimes(2);

    await executeLLM(
      baseManifest,
      { 'llm.data': 'hi', 'llm.categories': ['a'] },
      deps,
    );
    // Call 2: only ONE additional invocation. If cooldown didn't
    // persist, we'd see 2 more (slot_1 429 again → cascade). Seeing
    // exactly 1 more proves the match layer skipped slot_1 before
    // making any HTTP call.
    expect(adapter.complete).toHaveBeenCalledTimes(3);
    // And the successful call went to slot_2 both times — slot_1 is
    // still cooling.
    const call2Slot = (adapter.complete as unknown as { mock: { calls: [unknown, unknown, unknown][] } })
      .mock.calls[2][0] as { model: string };
    expect(call2Slot.model).toBe('gpt-fast-b');
  });

  it('retryable errors without retry_after_ms fall back to the 60s default cooldown', async () => {
    const adapter: LLMAdapter = {
      provider: 'openai',
      complete: vi.fn(async (slot) => {
        if (slot.model === 'gpt-fast-a') {
          throw new LLMError('AI_LLM_UNAVAILABLE', 'auth failed', { status: 401 }, true);
        }
        return {
          text: '{"category":"a","confidence":1,"reasoning":"ok"}',
          usage: ZERO_USAGE,
        };
      }),
    };
    const quota = createQuotaTracker();
    await executeLLM(
      baseManifest,
      { 'llm.data': 'hi', 'llm.categories': ['a'] },
      { config: twoFastSlots, adapters: () => adapter, quota, tabProbe: noTabs },
    );
    expect(quota.isInCooldown('slot_1')).toBe(true);
  });

  // F7a (s13 spot-run) — when every candidate source fails retryably, the
  // terminal error must surface the PROVIDER failure, not mask it behind the
  // bare "No LLM source matches requirements".
  it('a cascade exhausted by provider failures surfaces the last provider error, not a bare no-match', async () => {
    // Both slots fail retryably; after both are rejected the next walk's
    // matchLLM finds nothing → the no-match path. The thrown error must carry
    // the provider message ("LLM error (500): groq upstream") AND its
    // code/details, with the no-fallback context appended.
    const adapter: LLMAdapter = {
      provider: 'openai',
      complete: vi.fn(async () => {
        throw new LLMError('AI_LLM_UNAVAILABLE', 'LLM error (500): groq upstream', { status: 500 }, true);
      }),
    };
    let thrown: LLMError | undefined;
    try {
      await executeLLM(
        baseManifest,
        { 'llm.data': 'hi', 'llm.categories': ['a'] },
        { config: twoFastSlots, adapters: () => adapter, quota: createQuotaTracker(), tabProbe: noTabs },
      );
    } catch (e) {
      thrown = e as LLMError;
    }
    expect(thrown).toBeInstanceOf(LLMError);
    // The provider failure leads the message — NOT swallowed by no-match.
    expect(thrown!.message).toContain('LLM error (500): groq upstream');
    expect(thrown!.message).toContain('no fallback LLM source matched');
    // Provider code + status preserved for callers that branch on them.
    expect(thrown!.code).toBe('AI_LLM_UNAVAILABLE');
    expect(thrown!.details?.status).toBe(500);
    expect(thrown!.details?.fallback_unavailable).toContain('No LLM source matches');
    // The cascade is terminal — not retryable.
    expect(thrown!.retryable).toBe(false);
    // Cross-package coupling: backend chat-turn-executor classifies this
    // failure into the `engine.decoder_unavailable` transparency event via
    // NO_LLM_SOURCE_DETAIL_RE. Leading with the provider error must NOT drop
    // the substring that classifier matches — the appended no-match context
    // preserves it, so a chat user still gets the "switch models" copy
    // (semantically right: a provider-exhausted cascade IS "no source now").
    expect(thrown!.message).toMatch(/no llm source matches|no llm config|AI_LLM_UNAVAILABLE/i);
  });
});

// ────────────────────────────────────────────────────────────────
// Callback hooks + overrides
// ────────────────────────────────────────────────────────────────

describe('executeLLM — callbacks and overrides', () => {
  it('invokes token-usage and normalized finish-reason callbacks after a successful call', async () => {
    const adapter: LLMAdapter = {
      provider: 'anthropic',
      complete: vi.fn(async () => ({
        text: '{"category":"a","confidence":1,"reasoning":"ok"}',
        finish_reason: 'length' as const,
        usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
      })),
    };
    const usageEvents: Parameters<NonNullable<Parameters<typeof executeLLM>[2]['onTokenUsage']>>[0][] = [];
    const finishReasons: Array<'stop' | 'length' | 'content_filter' | undefined> = [];
    await executeLLM(
      baseManifest,
      { 'llm.data': 'x', 'llm.categories': ['a'] },
      {
        ...makeDeps(adapter),
        onTokenUsage: (u) => { usageEvents.push(u); },
        onFinishReason: (reason) => { finishReasons.push(reason); },
      },
    );
    expect(usageEvents).toHaveLength(1);
    const ev = usageEvents[0];
    expect(ev.total_tokens).toBe(30);
    expect(ev.attribution?.kind).toBe('slot');
    // Back-compat field
    if (ev.attribution?.kind === 'slot') expect(ev.slot_key).toBe(ev.attribution.slot_key);
    expect(finishReasons).toEqual(['length']);
  });

  it('accounts for one content-filtered call and returns a typed non-cascading refusal', async () => {
    const adapter: LLMAdapter = {
      provider: 'anthropic',
      complete: vi.fn(async () => ({
        text: '',
        finish_reason: 'content_filter' as const,
        usage: { input_tokens: 12, output_tokens: 0, total_tokens: 12 },
      })),
    };
    const usageEvents: Parameters<NonNullable<Parameters<typeof executeLLM>[2]['onTokenUsage']>>[0][] = [];
    const finishReasons: Array<'stop' | 'length' | 'content_filter' | undefined> = [];

    await expect(executeLLM(
      baseManifest,
      { 'llm.data': 'x', 'llm.categories': ['a'] },
      {
        ...makeDeps(adapter),
        onTokenUsage: (usage) => { usageEvents.push(usage); },
        onFinishReason: (reason) => { finishReasons.push(reason); },
      },
    )).rejects.toMatchObject({
      code: 'AI_MODEL_REFUSED',
      retryable: false,
      details: { slug: 'ai-classify', finish_reason: 'content_filter' },
    });

    expect(adapter.complete).toHaveBeenCalledTimes(1);
    expect(usageEvents).toEqual([expect.objectContaining({ total_tokens: 12 })]);
    expect(finishReasons).toEqual(['content_filter']);
  });

  it('invokes onMatchResolved with the debug payload each walk', async () => {
    const adapter = fakeAdapter(['{"category":"a","confidence":1,"reasoning":"ok"}']);
    const resolved: unknown[] = [];
    await executeLLM(
      baseManifest,
      { 'llm.data': 'x', 'llm.categories': ['a'] },
      { ...makeDeps(adapter), onMatchResolved: (e) => { resolved.push(e); } },
    );
    expect(resolved).toHaveLength(1);
    expect((resolved[0] as { type: string }).type).toBe('llm_match_resolved');
  });

  // F7b (s13 spot-run) — the match event must never carry the live API key.
  it('redacts the winner slot api_key in the onMatchResolved event (real call still works)', async () => {
    const adapter = fakeAdapter(['{"category":"a","confidence":1,"reasoning":"ok"}']);
    const resolved: Array<{ winner: { slot: { api_key: string } } }> = [];
    await executeLLM(
      baseManifest,
      { 'llm.data': 'x', 'llm.categories': ['a'] },
      { ...makeDeps(adapter), onMatchResolved: (e) => { resolved.push(e as never); } },
    );
    // The emitted winner carries a placeholder, not the configured key.
    expect(resolved[0].winner.slot.api_key).toBe('[redacted]');
    // The adapter that actually ran received the REAL key (redaction is
    // emit-boundary only). Contracted ai-classify defaults to the quality
    // hint → slot_2 (sk-2); the point is it is NOT the redaction placeholder.
    const callSlot = (adapter.complete as ReturnType<typeof vi.fn>).mock.calls[0][0] as { api_key: string };
    expect(callSlot.api_key).not.toBe('[redacted]');
    expect(callSlot.api_key).toBe('sk-2');
  });

  it('redacts a free-pool entry api_key in the match event', async () => {
    const adapter = fakeAdapter(['{"category":"a","confidence":1,"reasoning":"ok"}']);
    const resolved: Array<{ winner: { slot: { api_key: string }; source: { kind: string; entry?: { api_key: string } } } }> = [];
    const poolConfig: LLMConfig = {
      free_pool: [
        { id: 'groq-free', type: 'api', provider: 'openai-compatible', model: 'llama', api_key: 'gsk-secret', base_url: 'https://x', speed: 'fast', supports_json: true, enabled: true },
      ],
    };
    await executeLLM(
      baseManifest,
      { 'llm.data': 'x', 'llm.categories': ['a'] },
      { config: poolConfig, adapters: () => adapter, quota: createQuotaTracker(), tabProbe: noTabs, onMatchResolved: (e) => { resolved.push(e as never); } },
    );
    expect(resolved[0].winner.source.kind).toBe('pool');
    expect(resolved[0].winner.source.entry?.api_key).toBe('[redacted]');
    // The synthesized winner slot (built from the pool entry) is redacted too.
    expect(resolved[0].winner.slot.api_key).toBe('[redacted]');
  });

  it('matchContext override is respected (forceLayer)', async () => {
    // Only slot_1 is fast; slot_2 is quality. Requiring byok + fast forces slot_1.
    const adapter: LLMAdapter = {
      provider: 'openai',
      complete: vi.fn(async (slot) => ({
        text: JSON.stringify({ category: 'c', confidence: 1, reasoning: 'r' }),
        usage: ZERO_USAGE,
      })),
    };
    const cfg: LLMConfig = {
      slot_1: { provider: 'openai', model: 'gpt-fast', api_key: 'sk-1', speed: 'fast', supports_json: true },
    };
    await executeLLM(
      baseManifest,
      { 'llm.data': 'x', 'llm.categories': ['a'] },
      {
        config: cfg,
        adapters: () => adapter,
        quota: createQuotaTracker(),
        tabProbe: noTabs,
        matchContext: () => ({ forceLayer: 'byok', allowUpgrade: false }),
      },
    );
    expect((adapter.complete as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0])
      .toMatchObject({ model: 'gpt-fast' });
  });

  it('input["llm.force_layer"] overrides matchContext', async () => {
    // matchContext says byok, input says free — input wins.
    const cfg: LLMConfig = {
      slot_1: { provider: 'openai', model: 'slot-model', api_key: 'sk', speed: 'fast', supports_json: true },
      free_pool: [{
        id: 'pool-1', type: 'api',
        provider: 'openai-compatible', model: 'pool-model', api_key: 'sk',
        base_url: 'https://api.example.com/v1',
        speed: 'fast', supports_json: true, enabled: true,
      }],
    };
    const adapter: LLMAdapter = {
      provider: 'openai',
      complete: vi.fn(async () => ({
        text: '{"category":"c","confidence":1,"reasoning":"r"}',
        usage: ZERO_USAGE,
      })),
    };
    await executeLLM(
      baseManifest,
      { 'llm.data': 'x', 'llm.categories': ['a'], 'llm.force_layer': 'free' },
      {
        config: cfg,
        adapters: () => adapter,
        quota: createQuotaTracker(),
        tabProbe: noTabs,
        matchContext: () => ({ forceLayer: 'byok' }),
      },
    );
    // Pool entry wins because input.llm.force_layer === 'free'.
    expect((adapter.complete as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0])
      .toMatchObject({ model: 'pool-model' });
  });

  it('non-retryable LLMError is rethrown untouched (no cascade)', async () => {
    const adapter: LLMAdapter = {
      provider: 'openai',
      complete: vi.fn(async () => {
        throw new LLMError('AI_LLM_UNAVAILABLE', 'auth broken', { status: 401 }, false);
      }),
    };
    await expect(executeLLM(
      baseManifest,
      { 'llm.data': 'x', 'llm.categories': ['a'] },
      makeDeps(adapter),
    )).rejects.toMatchObject({ code: 'AI_LLM_UNAVAILABLE', retryable: false });
    expect(adapter.complete).toHaveBeenCalledTimes(1);
  });

  it('non-LLMError throws are rethrown untouched', async () => {
    const adapter: LLMAdapter = {
      provider: 'openai',
      complete: vi.fn(async () => { throw new Error('socket hang up'); }),
    };
    await expect(executeLLM(
      baseManifest,
      { 'llm.data': 'x', 'llm.categories': ['a'] },
      makeDeps(adapter),
    )).rejects.toThrow('socket hang up');
    expect(adapter.complete).toHaveBeenCalledTimes(1);
  });
});

// ────────────────────────────────────────────────────────────────
// deriveRequires — internal logic covered through public call
// ────────────────────────────────────────────────────────────────

describe('executeLLM — deriveRequires via manifest llm.requires', () => {
  it('uses manifest-declared llm.requires when present', async () => {
    const adapter = fakeAdapter(['{"rewritten":"x"}']);
    const manifestWithRequires: IngredientManifest = {
      ...baseManifest,
      slug: 'ai-rewrite',
      input: {
        'llm.requires': {
          speed: 'fast',
          output_format: 'json',
          needs_search: false,
          allow_downgrade: false,
        },
      },
    };
    await executeLLM(
      manifestWithRequires,
      { 'llm.data': 'x', 'llm.style': 'formal' },
      makeDeps(adapter),
    );
    // Fast hint routes to slot_1 (gpt-fast), not slot_2.
    expect((adapter.complete as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0])
      .toMatchObject({ model: 'gpt-fast' });
  });

  it('input llm.allow_downgrade=false overrides manifest requires to block downgrade', async () => {
    // Manifest asks for "thinking" with allow_downgrade=true; input overrides
    // to false. With only slot_1(fast) + slot_2(quality) and no thinking tier,
    // the match fails instead of downgrading.
    const adapter = fakeAdapter([]);
    const manifest: IngredientManifest = {
      ...baseManifest,
      slug: 'ai-rewrite',
      input: {
        'llm.requires': {
          speed: 'thinking',
          output_format: 'json',
          needs_search: false,
          allow_downgrade: true,
        },
      },
    };
    await expect(executeLLM(
      manifest,
      { 'llm.data': 'x', 'llm.style': 'formal', 'llm.allow_downgrade': false },
      makeDeps(adapter),
    )).rejects.toMatchObject({ code: 'AI_LLM_UNAVAILABLE' });
  });
});

describe('executeLLM — per-slot token accounting (D-079/D-094 budgets)', () => {
  it('records a slot completion under the slot key so per-slot budgets can enforce', async () => {
    const adapter: LLMAdapter = {
      provider: 'anthropic',
      complete: vi.fn(async () => ({
        text: 'ok',
        usage: { input_tokens: 30, output_tokens: 70, total_tokens: 100 },
      })),
    };
    const quota = createQuotaTracker();
    const promptManifest: IngredientManifest = { ...baseManifest, slug: 'ai-prompt' };
    // Force slot_1 (fast) so the charge lands deterministically.
    await executeLLM(
      promptManifest,
      { 'llm.prompt': 'hi', 'llm.model_hint': 'fast' },
      { config, adapters: () => adapter, quota, tabProbe: noTabs },
    );
    // The winning slot gets charged under its slot key — before this fix,
    // slot completions were never recorded (recordUsage was pool-only).
    expect(quota.tokensToday('slot_1')).toBe(100);
    expect(quota.tokensToday('slot_2')).toBe(0);
  });
});
