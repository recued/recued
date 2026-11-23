/** Test connection — the probe that asks the endpoint instead of guessing.
 *
 *  `server.setLLMSlot` is parse-and-persist: nothing in the save path makes a
 *  network call, so a wrong key / missing model / typo'd base_url is accepted
 *  silently and surfaces hours later as a failed recipe. These tests pin what
 *  the probe reports and — as importantly — what it refuses to claim. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  classifyProviderError,
  hydrateEndpointCapabilities,
  diagnoseProbeFailure,
  imageInputSeen,
  isModelMissingRejection,
  PICTURE_PROBE_TIMEOUT_MS,
  PROBE_PICTURE,
  probeLlmSource,
  resetEndpointCapabilities,
} from '../index.js';
import { createOpenAIAdapter } from '../adapters/openai.js';
import { LLMError, markOutputLimit } from '../types.js';
import type {
  LLMAdapter,
  LLMCompletionOptions,
  LLMCompletionResult,
  LLMMessage,
  LLMSlot,
} from '../types.js';

const slot = (over: Partial<LLMSlot> = {}): LLMSlot => ({
  provider: 'openai-compatible',
  model: 'local-llama',
  api_key: 'k',
  base_url: 'http://localhost:11434',
  ...over,
});

const OK: LLMCompletionResult = {
  text: 'ok',
  usage: {
    input_tokens: 8,
    output_tokens: 1,
    total_tokens: 9,
    model_id: 'local-llama',
  },
};

const adapterThat = (
  behaviour: (messages: LLMMessage[], options: LLMCompletionOptions) =>
    LLMCompletionResult,
): { adapter: LLMAdapter; calls: Array<{ roles: string[]; json: boolean; timeout: number | null }> } => {
  const calls: Array<{ roles: string[]; json: boolean; timeout: number | null }> = [];
  const adapter: LLMAdapter = {
    provider: 'openai-compatible',
    complete: vi.fn(async (
      _s: LLMSlot,
      messages: LLMMessage[],
      options: LLMCompletionOptions,
    ) => {
      calls.push({
        roles: messages.map((m) => m.role),
        json: options.json === true,
        timeout: options.timeout_ms,
      });
      return behaviour(messages, options);
    }),
  };
  return { adapter, calls };
};

const clock = () => {
  let t = 1_000;
  return () => (t += 25);
};

beforeEach(() => {
  resetEndpointCapabilities();
});

describe('diagnoseProbeFailure — point at the field the owner should fix', () => {
  it('separates a credential problem from a network one', () => {
    // Both mean "no answer", but the fix is in a different box of the form.
    expect(diagnoseProbeFailure(classifyProviderError(401, 'nope', null)).diagnosis)
      .toBe('auth');
    expect(diagnoseProbeFailure(classifyProviderError(403, 'nope', null)).diagnosis)
      .toBe('auth');
    expect(diagnoseProbeFailure(
      new LLMError('AI_LLM_UNAVAILABLE', 'LLM call failed: fetch failed'),
    ).diagnosis).toBe('unreachable');
    expect(diagnoseProbeFailure(
      new LLMError('AI_TIMEOUT', 'LLM call timed out after 20000ms'),
    ).diagnosis).toBe('unreachable');
  });

  it('names a missing model on the shapes providers actually use for it', () => {
    expect(diagnoseProbeFailure(classifyProviderError(404, 'no such model', null))
      .diagnosis).toBe('model_missing');
    // ⚠ Several openai-compatible servers answer 400 for an unknown model id,
    // and the id sits BETWEEN the word and the verdict. A pattern that demands
    // they be adjacent matches none of these — which is how it was written the
    // first time.
    for (const body of [
      '{"error":{"message":"The model `llama-9` does not exist"}}',
      '{"error":{"code":"model_not_found","message":"nope"}}',
      '{"error":{"message":"Unknown model: llama-9"}}',
      '{"error":{"message":"model gpt-nine not found"}}',
    ]) {
      expect(diagnoseProbeFailure(classifyProviderError(400, body, null)).diagnosis)
        .toBe('model_missing');
    }
    // …but an ordinary 400 that merely mentions a model is still a bad request.
    expect(diagnoseProbeFailure(classifyProviderError(
      400,
      '{"error":{"message":"temperature must be <= 2 for this model"}}',
      null,
    )).diagnosis).toBe('rejected');
  });

  /** ⛔ ONE RULE FOR TEST CONNECTION AND A REAL CALL (`isModelMissingRejection`): a chat turn that
   *  meets a retired model says so by this test, so the two cannot disagree about one answer. */
  it('reads a missing model by the rule a real call uses, on the shapes providers send', () => {
    const missing = [
      // OpenAI, for a model it shut down or never had.
      classifyProviderError(404, '{"error":{"message":"The model `gpt-4.1-mini` does not exist or you do not have access to it.","type":"invalid_request_error","code":"model_not_found"}}', null),
      // Google, live 2026-11-16, two weeks before the model's shutdown date.
      classifyProviderError(404, '{"error":{"code":404,"message":"This model models/gemini-2.5-flash is no longer available to new users. Please update your code to use models/gemini-3.8-flash.","status":"NOT_FOUND"}}', null),
      classifyProviderError(404, '{"type":"error","error":{"type":"not_found_error","message":"model: claude-2.0"}}', null),
      classifyProviderError(404, '{"error":"model \\"llama9\\" not found, try pulling it first"}', null),
      // Groq and OpenRouter say it with a 400; Groq's words alone are enough, its code alone too.
      classifyProviderError(400, '{"error":{"message":"The model `llama3-70b-8192` has been decommissioned and is no longer supported."}}', null),
      classifyProviderError(400, '{"error":{"message":"Model retired.","type":"invalid_request_error","code":"model_decommissioned"}}', null),
      classifyProviderError(400, '{"error":{"message":"openai/gpt-nine is not a valid model ID","code":400}}', null),
    ];
    for (const e of missing) {
      expect(isModelMissingRejection(e)).toBe(true);
      expect(diagnoseProbeFailure(e).diagnosis).toBe('model_missing');
    }
    const other = [
      // A 404 that names no model is a wrong address, not a missing model.
      classifyProviderError(404, '404 page not found', null),
      classifyProviderError(400, '{"error":{"message":"Unsupported value: \'reasoning_effort\' does not support \'none\' with this model."}}', null),
      classifyProviderError(400, '{"error":{"message":"This model\'s maximum context length is 128000 tokens."}}', null),
      classifyProviderError(401, '{"error":"model access denied"}', null),
      classifyProviderError(503, '{"error":"model overloaded"}', null),
    ];
    for (const e of other) expect(isModelMissingRejection(e)).toBe(false);
    expect(diagnoseProbeFailure(other[0]).diagnosis).toBe('rejected');
  });

  it('keeps rate limit and provider outage distinct from a bad request', () => {
    expect(diagnoseProbeFailure(classifyProviderError(429, 'slow down', null))
      .diagnosis).toBe('rate_limited');
    expect(diagnoseProbeFailure(classifyProviderError(503, 'down', null))
      .diagnosis).toBe('provider_error');
    expect(diagnoseProbeFailure(classifyProviderError(400, 'bad thing', null))
      .diagnosis).toBe('rejected');
  });

  /** ⛔ Reads `details.status`, never the message. `classifyProviderError`
   *  truncates the body at 200 chars, so a status parsed out of the string is
   *  lossy — a provider with a long preamble would push the code out of range
   *  and land silently in the wrong bucket. */
  it('classifies by status even when the body is truncated past recognition', () => {
    const long = `${'x'.repeat(400)} unauthorized`;
    const e = classifyProviderError(401, long, null);
    expect(e.message).toContain('…');
    expect(diagnoseProbeFailure(e).diagnosis).toBe('auth');
  });
});

describe('probeLlmSource', () => {
  it('reports ok, the capabilities, and how long it took', async () => {
    const { adapter, calls } = adapterThat(() => OK);
    const result = await probeLlmSource({
      adapter,
      slot: slot({ supports_json: true }),
      now: clock(),
    });

    expect(result.ok).toBe(true);
    expect(result.diagnosis).toBe('ok');
    expect(result.accepts_system_role).toBe(true);
    expect(result.supports_json).toBe(true);
    expect(result.elapsed_ms).toBeGreaterThan(0);
    // One request when nothing is refused.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.roles).toEqual(['system', 'user']);
    expect(calls[0]?.json).toBe(true);
  });

  /** ⚠ A real call is unbounded on purpose (`timeout_ms` defaults to `null` —
   *  the owner already paid for the compute). Behind a button that inverts: an
   *  unbounded probe is a spinner with no end, and "my endpoint is wedged" is
   *  exactly the case this feature exists to report. */
  it('time-boxes itself, unlike a real call', async () => {
    const { adapter, calls } = adapterThat(() => OK);
    await probeLlmSource({ adapter, slot: slot(), now: clock() });
    expect(calls[0]?.timeout).toBe(20_000);
  });

  it('reports the failure instead of throwing it', async () => {
    const adapter: LLMAdapter = {
      provider: 'openai-compatible',
      complete: vi.fn(async () => {
        throw classifyProviderError(401, '{"error":"bad key"}', null);
      }),
    };
    const result = await probeLlmSource({ adapter, slot: slot(), now: clock() });

    // A failed probe is a RESULT — the whole point is putting it in front of
    // the owner, so it must not reject and become an error toast.
    expect(result.ok).toBe(false);
    expect(result.diagnosis).toBe('auth');
    expect(result.detail).toContain('bad key');
  });

  /** ⛔ A failed probe learned NOTHING about capabilities. Reporting a default
   *  as though it were observed is how a "verified" badge starts lying. */
  it('claims no capability knowledge when the call failed', async () => {
    const adapter: LLMAdapter = {
      provider: 'openai-compatible',
      complete: vi.fn(async () => {
        throw classifyProviderError(404, 'no model', null);
      }),
    };
    const result = await probeLlmSource({ adapter, slot: slot(), now: clock() });
    expect(result.accepts_system_role).toBeUndefined();
    expect(result.supports_json).toBeUndefined();
  });

  /** 🔑 The capability answers are READ BACK from the shared detectors, not
   *  re-derived here. One request setting both a system role and
   *  `response_format` cannot tell you which a 400 was about; the isolation
   *  logic already exists in `completeWithFallbacks`. */
  it('reports the endpoint refusing a system role, having still succeeded', async () => {
    const { adapter, calls } = adapterThat((messages) => {
      if (messages.some((m) => m.role === 'system')) {
        throw classifyProviderError(
          400,
          '{"error":{"message":"System role not supported"}}',
          null,
        );
      }
      return OK;
    });
    const result = await probeLlmSource({ adapter, slot: slot(), now: clock() });

    expect(result.ok).toBe(true);
    expect(result.accepts_system_role).toBe(false);
    expect(result.supports_json).toBe(true);
    expect(calls.map((c) => c.roles)).toEqual([['system', 'user'], ['user']]);
  });

  /** The declaration this probe exists to check. `supports_json` defaults ON
   *  and is never verified, so a slot that cannot do it 400s on nearly every
   *  real call (every contracted ai-* function asks for JSON). */
  it('catches a supports_json declaration the endpoint does not honour', async () => {
    const { adapter } = adapterThat((_m, options) => {
      if (options.json) {
        throw classifyProviderError(
          400,
          '{"error":"response_format is not supported"}',
          null,
        );
      }
      return OK;
    });
    const result = await probeLlmSource({
      adapter,
      slot: slot({ supports_json: true }),
      now: clock(),
    });

    expect(result.ok).toBe(true);
    expect(result.supports_json).toBe(false);
    expect(result.accepts_system_role).toBe(true);
  });

  it('does not test JSON mode on a slot that never claimed it', async () => {
    const { adapter, calls } = adapterThat(() => OK);
    const result = await probeLlmSource({
      adapter,
      slot: slot({ supports_json: false }),
      now: clock(),
    });
    // Asking anyway would report a failure the owner did not configure.
    expect(calls[0]?.json).toBe(false);
    expect(result.supports_json).toBe(false);
  });

  /** ⛔ A PROBE MUST NOT CONFIRM ITSELF. `completeWithFallbacks` reads the
   *  capability memory and sends the degraded request up front, so a probe run
   *  against a warm cache would re-report the cached verdict as a fresh
   *  measurement — and once those notes are persisted, that verdict would be
   *  permanent and unfalsifiable. Test connection IS the re-detection. */
  it('re-detects from scratch instead of echoing a cached verdict', async () => {
    // A previous process (wrongly, or before the endpoint was fixed) recorded
    // both capabilities as unsupported.
    hydrateEndpointCapabilities([{
      fingerprint: 'openai-compatible http://localhost:11434 local-llama',
      system_role_unsupported: true,
      json_mode_unsupported: true,
    }]);

    const { adapter, calls } = adapterThat(() => OK);
    const result = await probeLlmSource({
      adapter,
      slot: slot({ supports_json: true }),
      now: clock(),
    });

    // It sent the CAPABLE shape, not the cached-degraded one…
    expect(calls[0]?.roles).toEqual(['system', 'user']);
    expect(calls[0]?.json).toBe(true);
    // …and reported what it actually observed, overturning the stale note.
    expect(result.accepts_system_role).toBe(true);
    expect(result.supports_json).toBe(true);
  });

  /** ⚠ A probe that skips the quota tracker is an unmetered hole in the daily
   *  budget — one the owner can pull on demand, from a button. */
  it('reports its usage so the caller can meter it', async () => {
    const { adapter } = adapterThat(() => OK);
    const onUsage = vi.fn();
    await probeLlmSource({ adapter, slot: slot(), onUsage, now: clock() });
    expect(onUsage).toHaveBeenCalledWith(9);
  });

  /** ⛔ The probe allows one token, and a model that thinks can spend it thinking and stop with no
   *  answer. That reported `gemini-3.8-flash` "rejected" (live 2026-11-16). The endpoint took the
   *  request and answered it, which is the question. Run through the real OpenAI adapter, in the
   *  shape OpenAI's reasoning models answer with. */
  it('passes a model that spends its one token thinking, and meters what it used', async () => {
    const realFetch = globalThis.fetch;
    const bodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ choices: [{ index: 0, finish_reason: 'length', message: { role: 'assistant', content: '' } }],
        usage: { prompt_tokens: 20, completion_tokens: 1, total_tokens: 21, completion_tokens_details: { reasoning_tokens: 1 } } }),
      { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    try {
      const onUsage = vi.fn();
      const result = await probeLlmSource({ adapter: createOpenAIAdapter('openai'),
        slot: { provider: 'openai', model: 'gpt-6-luna', api_key: 'k', supports_json: true }, onUsage, now: clock() });
      expect(result).toMatchObject({ ok: true, diagnosis: 'ok', accepts_system_role: true, supports_json: true });
      expect(onUsage).toHaveBeenCalledWith(21);
      expect(bodies[0]?.max_completion_tokens).toBe(1);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('still fails a reply with no answer that did not stop at the limit', async () => {
    const { adapter } = adapterThat(() => {
      throw new LLMError('AI_RESPONSE_PARSE_FAILED', 'Google response had no text parts');
    });
    const result = await probeLlmSource({ adapter, slot: slot(), now: clock() });
    expect(result).toMatchObject({ ok: false, diagnosis: 'rejected' });
  });
});

/** Test connection is the one place a chat model proves it can see pictures
 *  (`endpoint-capabilities` § Picture input). The default is "cannot", so these
 *  pin both halves: what counts as a verdict, and what must NOT be taken as one. */
describe('probeLlmSource — the picture check', () => {
  const FP = 'openai-compatible http://localhost:11434 local-llama';
  const pictureOf = (messages: LLMMessage[]) =>
    messages.flatMap((m) => m.content_parts ?? []).find((p) => p.type === 'image');

  /** An adapter that answers the connection check "ok" and the picture with
   *  `onPicture` — a string to say, or an error to throw. */
  const answeringPicture = (onPicture: string | Error) => {
    const sent: Array<{ messages: LLMMessage[]; options: LLMCompletionOptions }> = [];
    const adapter: LLMAdapter = {
      provider: 'openai-compatible',
      complete: vi.fn(async (_s: LLMSlot, messages: LLMMessage[], options: LLMCompletionOptions) => {
        sent.push({ messages, options });
        if (pictureOf(messages) === undefined) return OK;
        if (onPicture instanceof Error) throw onPicture;
        return { ...OK, text: onPicture };
      }),
    };
    return { adapter, sent };
  };

  it('shows the bundled picture after the connection answered, and proves a model that reads it', async () => {
    const { adapter, sent } = answeringPicture('4827');
    const onUsage = vi.fn();
    const result = await probeLlmSource({
      adapter, slot: slot(), now: clock(), onUsage, pictures: true,
    });

    expect(result).toMatchObject({ ok: true, sees_pictures: true, picture_answer: '4827' });
    expect(imageInputSeen(slot())).toBe(true);
    expect(sent).toHaveLength(2);
    const [first, second] = sent;
    expect(pictureOf(first!.messages)).toBeUndefined();
    // The real request shape: one user turn, the picture as a content part, no
    // JSON mode (the answer is a number), and its own, longer time box.
    expect(second!.messages.map((m) => m.role)).toEqual(['user']);
    expect(pictureOf(second!.messages)?.source).toEqual({
      kind: 'base64', media_type: 'image/png', data: PROBE_PICTURE.data_b64,
    });
    expect(second!.options.json).toBe(false);
    expect(second!.options.timeout_ms).toBe(PICTURE_PROBE_TIMEOUT_MS);
    // Both requests are metered.
    expect(onUsage).toHaveBeenCalledTimes(2);
  });

  it('counts the number however the model words it', async () => {
    const { adapter } = answeringPicture('The number is 4,827.');
    const result = await probeLlmSource({ adapter, slot: slot(), now: clock(), pictures: true });
    expect(result.sees_pictures).toBe(true);
  });

  /** ⛔ THE CASE THE NUMBER EXISTS FOR: an endpoint that drops the picture and
   *  lets the model answer anyway. Anything but the number is "cannot see",
   *  and it withdraws a proof an earlier Test recorded. */
  it('calls a model that answers without the picture blind, withdrawing an earlier proof', async () => {
    hydrateEndpointCapabilities([{ fingerprint: FP, image_input_seen: true }]);
    const { adapter } = answeringPicture('I cannot see any picture. Please upload it.');
    const result = await probeLlmSource({ adapter, slot: slot(), now: clock(), pictures: true });
    expect(result).toMatchObject({
      sees_pictures: false, picture_answer: 'I cannot see any picture. Please upload it.',
    });
    expect(imageInputSeen(slot())).toBe(false);
  });

  it('takes a refusal of the picture as "cannot see"', async () => {
    const { adapter } = answeringPicture(classifyProviderError(
      400, '{"error":{"message":"image input is not supported by this model"}}', null,
    ));
    const result = await probeLlmSource({ adapter, slot: slot(), now: clock(), pictures: true });
    expect(result.ok).toBe(true);
    expect(result.sees_pictures).toBe(false);
    expect(result.picture_detail).toContain('image input is not supported');
  });

  /** ⛔ NOT A VERDICT. The default is "cannot", so recording any of these as
   *  "cannot" would switch off the owner's camera checks over a failure that
   *  was never about pictures. */
  it.each([
    ['a rate limit', classifyProviderError(429, 'slow down', null)],
    ['a timeout', new LLMError('AI_TIMEOUT', 'LLM call timed out after 30000ms')],
    ['an outage', classifyProviderError(503, 'down', null)],
    ['an empty answer', ''],
  ] as const)('reaches no verdict on %s, and keeps the earlier proof', async (_name, onPicture) => {
    hydrateEndpointCapabilities([{ fingerprint: FP, image_input_seen: true }]);
    const { adapter } = answeringPicture(onPicture);
    const result = await probeLlmSource({ adapter, slot: slot(), now: clock(), pictures: true });
    expect(result.ok).toBe(true);
    expect(result.sees_pictures).toBeUndefined();
    expect(result.picture_detail).toBeDefined();
    expect(imageInputSeen(slot())).toBe(true);
  });

  it('says a model that ran out of room before answering left the picture unknown, and meters it', async () => {
    hydrateEndpointCapabilities([{ fingerprint: FP, image_input_seen: true }]);
    const { adapter } = answeringPicture(markOutputLimit(
      new LLMError('AI_RESPONSE_PARSE_FAILED', 'OpenAI response had no answer: the model spent its whole output limit reasoning'),
      'length', { input_tokens: 300, output_tokens: 256, total_tokens: 556 },
    ) as LLMError);
    const onUsage = vi.fn();
    const result = await probeLlmSource({ adapter, slot: slot(), now: clock(), onUsage, pictures: true });
    expect(result.ok).toBe(true);
    expect(result.sees_pictures).toBeUndefined();
    expect(result.picture_detail).toBe('The model ran out of room before answering, so whether it can see pictures is unknown.');
    expect(onUsage.mock.calls).toEqual([[9], [556]]);
    expect(imageInputSeen(slot())).toBe(true);
  });

  it('shows no picture when the connection itself failed, and keeps the proof', async () => {
    hydrateEndpointCapabilities([{ fingerprint: FP, image_input_seen: true }]);
    const adapter: LLMAdapter = {
      provider: 'openai-compatible',
      complete: vi.fn(async () => { throw classifyProviderError(401, 'bad key', null); }),
    };
    const result = await probeLlmSource({ adapter, slot: slot(), now: clock(), pictures: true });
    expect(result.ok).toBe(false);
    expect(result.sees_pictures).toBeUndefined();
    expect(adapter.complete).toHaveBeenCalledTimes(1);
    expect(imageInputSeen(slot())).toBe(true);
  });

  it('shows no picture unless asked', async () => {
    const { adapter, sent } = answeringPicture('4827');
    const result = await probeLlmSource({ adapter, slot: slot(), now: clock() });
    expect(sent).toHaveLength(1);
    expect(result.sees_pictures).toBeUndefined();
  });
});
