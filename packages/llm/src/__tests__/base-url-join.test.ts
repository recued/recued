/** A pasted `base_url` reaches the right endpoint under BOTH conventions.
 *
 *  ⛔ THE DEFECT. Every adapter appended its version segment unconditionally:
 *  `${base_url}/v1/chat/completions`. That is correct only if the user's
 *  base_url stops before the version — and most vendors document it the other
 *  way round. Groq, DashScope, Ollama and vLLM all publish a base ending in
 *  `/v1`, so pasting the documented value produced `…/v1/v1/chat/completions`,
 *  a 404, and a chat turn that silently produced nothing.
 *
 *  ⚠ FOUND BY A LIVE TURN, NOT BY A TEST. The adapter suites all construct
 *  slots with a bare host, so every one of them passed against the defect —
 *  the fixture encoded the same assumption the bug did. The cases below are
 *  written from what vendors actually publish.
 *
 *  ⚠ Asserted at the URL the adapter FETCHES, not on the helper alone. A unit
 *  test of `joinApiBase` proves the string function; it cannot prove the six
 *  call sites use it. The fetch spy is what ties the two together. */

import { describe, expect, it } from 'vitest';

import { createOpenAIAdapter } from '../adapters/openai.js';
import { createGoogleAdapter } from '../adapters/google.js';
import { createAnthropicAdapter } from '../adapters/anthropic.js';
import { joinApiBase } from '../base-url.js';
import type { LLMSlot } from '../types.js';

describe('joinApiBase', () => {
  it('appends exactly once whichever convention the user pastes', () => {
    // The two halves of the contract. Left column is what a user might enter;
    // both must land on the same endpoint.
    expect(joinApiBase('https://api.openai.com', 'v1')).toBe('https://api.openai.com');
    expect(joinApiBase('https://api.openai.com/v1', 'v1')).toBe('https://api.openai.com');
    expect(joinApiBase('https://api.groq.com/openai/v1', 'v1')).toBe('https://api.groq.com/openai');
    expect(joinApiBase('http://localhost:11434/v1/', 'v1')).toBe('http://localhost:11434');
    expect(joinApiBase('https://generativelanguage.googleapis.com/v1beta', 'v1beta'))
      .toBe('https://generativelanguage.googleapis.com');
  });

  it('⛔ strips only a WHOLE trailing segment', () => {
    // The naive fix — a substring replace — would maul all three of these.
    expect(joinApiBase('https://v1.example.com', 'v1')).toBe('https://v1.example.com');
    expect(joinApiBase('https://host/v10', 'v1')).toBe('https://host/v10');
    expect(joinApiBase('https://host/v1/proxy', 'v1')).toBe('https://host/v1/proxy');
  });

  it('is case-insensitive on the segment', () => {
    // A pasted `/V1` is the same endpoint to every provider here; failing on
    // capitalisation would be the same unhelpful 404 by another route.
    expect(joinApiBase('https://host/V1', 'v1')).toBe('https://host');
  });
});

const slotWith = (base: string, provider: LLMSlot['provider']): LLMSlot => ({
  provider, model: 'm', api_key: 'k', base_url: base,
});

/** Capture the URL an adapter fetches, then fail the request — the response
 *  shape is irrelevant here and a fake one would only add a way to be wrong.
 *
 *  ⚠ The adapters call the GLOBAL `fetch`; there is no injection seam. Swapping
 *  the global is therefore the real call path, not a stub of it. First cut
 *  passed a `fetchImpl` option the adapters ignore, so nothing was ever
 *  captured and the assertion compared '' to '' — a green test measuring
 *  nothing, caught only because the bare-base case asserts a concrete URL. */
const captureUrl = async (run: () => Promise<unknown>): Promise<string> => {
  let seen = '';
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    seen = typeof input === 'string' ? input : String(input);
    return new Response('{}', { status: 500 });
  }) as unknown as typeof globalThis.fetch;
  try {
    await run().catch(() => undefined);
  } finally {
    globalThis.fetch = original;
  }
  return seen;
};

describe('adapters reach one endpoint from either convention', () => {
  const cases: ReadonlyArray<
    readonly [string, string, string, (b: string) => Promise<unknown>]
  > = [
    [
      'openai-compatible chat', 'https://coding-intl.dashscope.aliyuncs.com/compatible-mode',
      '/v1/chat/completions',
      (b) => createOpenAIAdapter('openai-compatible').complete(
        slotWith(b, 'openai-compatible'), [{ role: 'user', content: 'x' }],
        { model: 'm', max_tokens: 8, timeout_ms: 5000 },
      ),
    ],
    [
      'anthropic messages', 'https://api.anthropic.com', '/v1/messages',
      (b) => createAnthropicAdapter().complete(
        slotWith(b, 'anthropic'), [{ role: 'user', content: 'x' }],
        { model: 'm', max_tokens: 8, timeout_ms: 5000 },
      ),
    ],
    [
      'google generateContent', 'https://generativelanguage.googleapis.com',
      '/v1beta/models/m:generateContent',
      (b) => createGoogleAdapter().complete(
        slotWith(b, 'google'), [{ role: 'user', content: 'x' }],
        { model: 'm', max_tokens: 8, timeout_ms: 5000 },
      ),
    ],
  ];

  for (const [label, bare, path, run] of cases) {
    it(`${label} — bare base and version-suffixed base agree`, async () => {
      const version = path.split('/')[1];
      const fromBare = await captureUrl(() => run(bare));
      const fromSuffixed = await captureUrl(() => run(`${bare}/${version}`));

      expect(fromBare, 'bare base').toBe(`${bare}${path}`);
      // ⛔ THE DEFECT IN ONE LINE: this used to be `${bare}/v1/v1/...`.
      expect(fromSuffixed, 'version-suffixed base').toBe(fromBare);
      expect(fromSuffixed).not.toMatch(
        new RegExp(`/${version}/${version}/`),
      );
    });
  }
});
