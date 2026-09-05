/** ⛔⛔ IN-TURN RECOVERY OF WHAT THE TRIM DROPPED.
 *
 *  Measured over 2,326 stored packets carrying `prior_tool_calls`: 82% are
 *  under 8 KB and lose nothing, but the tail is violent — p90 60 KB, p99 366 KB,
 *  max 670 KB. So this path is RARE BUT SEVERE, and both halves of that shape
 *  are load-bearing: it must exist, and it must never hand back the whole value
 *  it is compensating for. */
import { describe, expect, it } from 'vitest';
import { runChatTurn } from '../chat-turn-executor.js';
import {
  CONTEXT_SLICE_MAX_BYTES,
  resolveContextSlice,
} from '../chat-context-slice.js';

const rows = Array.from({ length: 400 }, (_, i) => ({
  id: `row-${i}`,
  note: i === 137 ? 'the xanthoril clause' : `filler ${i}`,
}));

describe('resolveContextSlice', () => {
  const elided = new Map<string, unknown>([['ctx_1', rows]]);

  it('returns only the matching elements, not the haystack', () => {
    const got = resolveContextSlice({ ref: 'ctx_1', query: 'xanthoril' }, elided);
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.matched).toBe(1);
    expect(JSON.stringify(got.slice)).toContain('row-137');
    expect(JSON.stringify(got.slice)).not.toContain('filler 0');
  });

  it('⛔ never returns more than the cap — the value was dropped for SIZE', () => {
    // No query is not "everything": handing back 400 rows would re-create the
    // overflow that caused the trim in the first place.
    const got = resolveContextSlice({ ref: 'ctx_1' }, elided);
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(Buffer.byteLength(JSON.stringify(got.slice), 'utf8'))
      .toBeLessThanOrEqual(CONTEXT_SLICE_MAX_BYTES);
    expect(got.truncated, 'says so rather than implying completeness').toBe(true);
    expect(got.matched, 'and still reports the true total').toBe(400);
  });

  it('⛔ a caller cannot raise the cap past the limit', () => {
    const got = resolveContextSlice(
      { ref: 'ctx_1', max_bytes: 10_000_000 }, elided,
    );
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(Buffer.byteLength(JSON.stringify(got.slice), 'utf8'))
      .toBeLessThanOrEqual(CONTEXT_SLICE_MAX_BYTES);
  });

  it('⛔ returns whole elements, never a half-serialized one', () => {
    const got = resolveContextSlice({ ref: 'ctx_1' }, elided);
    if (!got.ok) return;
    // Malformed JSON would look like data to a model. Round-tripping proves
    // the budget cut BETWEEN elements.
    expect(() => JSON.parse(JSON.stringify(got.slice))).not.toThrow();
  });

  it('names the live refs instead of a bare not-found', () => {
    const got = resolveContextSlice({ ref: 'ctx_99' }, elided);
    expect(got.ok).toBe(false);
    if (got.ok) return;
    expect(got.detail).toContain('ctx_1');
  });
});

describe('the turn answers a slice request itself', () => {
  it('⛔ a model that lost a value to the trim gets the part it asks for', async () => {
    const packets: string[] = [];
    let round = 0;
    await runChatTurn(
      {
        session_id: 's', turn_id: 't', picker_target: 'self',
        dispatch_peer_name: null, available_tools: [],
        content: { chat_tail: [], user_message: 'find the clause' },
        correction_context: [], model_layer: 'byok',
        input_token_budget: 1_500,
      } as never,
      {
        executeAiCall: async (_m: unknown, input: Record<string, unknown>) => {
          const prompt = String(input['llm.prompt']);
          packets.push(prompt);
          round += 1;
          if (round === 1) {
            return { body: { response: 'looking', events: [],
              tool_calls: [{ tool: 'mail.search', args: { q: 'x' } }] } };
          }
          if (round === 2) {
            // The result it was using has been elided. A model reads the ref
            // POSITIONALLY — the marker sits where the value was — so take the
            // one under `result`, not the first in the packet. (`args` is
            // elided too during the preview search, and grabbing that one asks
            // the wrong question of the right tool.)
            const ptc = (JSON.parse(prompt) as {
              prior_tool_calls?: Array<{ result?: { context_ref?: string } }>;
            }).prior_tool_calls ?? [];
            const ref = ptc[0]?.result?.context_ref;
            return { body: { response: 'recovering', events: [],
              tool_calls: [{ tool: 'context.slice',
                args: { ref, query: 'xanthoril' } }] } };
          }
          return { body: { response: 'done', events: [], tool_calls: [] } };
        },
        registry: {
          list: () => [], listByTier: () => [],
          getByName: () => ({ name: 'mail.search', tier: 1, concurrency_safe: false }),
          dispatch: async () => ({ ok: true, result: { rows } }),
          subscribeRefresh: () => () => undefined,
        } as never,
        dispatchTool: async () => ({ ok: true as const, result: { rows } }),
        emit: () => undefined,
        now: () => 1_000,
      } as never,
    );

    const marked = packets.filter((p) => p.includes('llm_gateway_context_omitted'));
    expect(marked, 'something was trimmed').not.toHaveLength(0);
    expect(marked.some((p) => p.includes('context_ref')), 'marker carries a ref')
      .toBe(true);
    // The recovered fragment comes back in a later packet — and ONLY the match.
    const after = packets[2] ?? '';
    expect(after, 'the asked-for row came back').toContain('row-137');
    expect(after, 'the haystack did not').not.toContain('row-399');
  });
});
