/** ⛔⛔ IN-TURN RECOVERY OF WHAT THE TRIM DROPPED.
 *
 *  Measured over 2,326 stored packets carrying `prior_tool_calls`: 82% are
 *  under 8 KB and lose nothing, but the tail is violent — p90 60 KB, p99 366 KB,
 *  max 670 KB. So this path is RARE BUT SEVERE, and both halves of that shape
 *  are load-bearing: it must exist, and it must never hand back the whole value
 *  it is compensating for. */
import { describe, expect, it } from 'vitest';
import {
  composeChatMainTurnPromptParts, composeChatMainTurnSystemPrompt, runChatTurn,
} from '../chat-turn-executor.js';
import { estimateConservativeMessagesTokens } from '@recued/llm';
import {
  CONTEXT_SLICE_MAX_BYTES,
  resolveContextSlice,
} from '../chat-context-slice.js';

const rows = Array.from({ length: 400 }, (_, i) => ({
  id: `row-${i}`,
  note: i === 137 ? 'the xanthoril clause' : `filler ${i}`,
}));

// ⛔⛔ THE TOOL HAD NEVER ONCE DELIVERED A MATCH. Measured across the last 30
//   stored reports: 28 of 28 `context.slice` calls that matched anything
//   returned ZERO of it — `{matched: 1, returned: 0, truncated: true}`, a
//   success-shaped non-answer with no error for the model to react to. In the
//   run that exposed it the model asked twice, got nothing twice, emitted no
//   tool calls for two further rounds, and the turn ended with a `memory.write`
//   it had promised never performed.
//
//   The cause is whole-element budgeting meeting a leaf bigger than the cap:
//   `long_text.text` from a work.read is the whole note body (7,612 bytes in
//   the measured run) against CONTEXT_SLICE_MAX_BYTES = 2,048. And a truncated
//   work.read is exactly what the executor tells the model to recover with
//   `context.slice({ref, query})`.
describe('resolveContextSlice — a match larger than the budget', () => {
  const NEEDLE = 'mooring rotation';
  const body = `${'filler prose. '.repeat(400)}${NEEDLE} is recorded at berth nine.${' trailing. '.repeat(400)}`;
  const elided = new Map<string, unknown>([['ctx_9', { long_text: { text: body } }]]);

  it('⛔ returns a WINDOW rather than nothing when the only match is oversized', () => {
    const got = resolveContextSlice({ ref: 'ctx_9', query: NEEDLE }, elided);
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(body.length).toBeGreaterThan(CONTEXT_SLICE_MAX_BYTES);
    expect(got.matched).toBe(1);
    expect(got.returned).toBe(1);          // was 0 — the whole defect
    expect(got.truncated).toBe(true);      // still honest about being cut
    const slice = (got.slice as string[])[0];
    expect(slice).toContain(NEEDLE);       // the window CONTAINS the needle
    expect(slice).toContain('berth nine'); // and the context after it
  });

  it('never exceeds the byte budget, marker included', () => {
    const got = resolveContextSlice({ ref: 'ctx_9', query: NEEDLE }, elided);
    if (!got.ok) return;
    const bytes = Buffer.byteLength((got.slice as string[])[0], 'utf8');
    expect(bytes).toBeLessThanOrEqual(CONTEXT_SLICE_MAX_BYTES);
  });

  it('honours an explicit smaller max_bytes', () => {
    const got = resolveContextSlice({ ref: 'ctx_9', query: NEEDLE, max_bytes: 200 }, elided);
    if (!got.ok) return;
    const slice = (got.slice as string[])[0];
    expect(Buffer.byteLength(slice, 'utf8')).toBeLessThanOrEqual(200);
    expect(slice).toContain(NEEDLE);
  });

  // ⚠ The whole-element rule still holds where it was earned: half an object
  //   or half an array does not parse, so those may not be windowed.
  it('does NOT window a non-string oversized match', () => {
    const big = { id: 'r1', blob: 'x'.repeat(CONTEXT_SLICE_MAX_BYTES * 2), tag: 'mooring rotation' };
    const m = new Map<string, unknown>([['ctx_o', [big]]]);
    const got = resolveContextSlice({ ref: 'ctx_o', query: 'mooring rotation' }, m);
    if (!got.ok) return;
    expect(got.returned).toBe(0);
    expect(got.truncated).toBe(true);
  });
});

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
  const content = { chat_tail: [], user_message: 'find the clause' };
  // Reserve working room above the CURRENT prompt, rather than relying on a
  // literal 1,500-token window. Core text growth put that window at the final
  // no-preview rung, where fitting deliberately takes priority over refs.
  const budget = estimateConservativeMessagesTokens([
    { role: 'system', content: composeChatMainTurnSystemPrompt() },
    { role: 'user', content: composeChatMainTurnPromptParts({ available_tools: [], content }).body },
  ]) + 1_000;
  const drive = async (inputTokenBudget: number) => {
    const packets: string[] = [];
    const systems: string[] = [];
    const dispatched: string[] = [];
    let round = 0;
    await runChatTurn(
      {
        session_id: 's', turn_id: 't', picker_target: 'self',
        dispatch_peer_name: null, available_tools: [],
        content,
        correction_context: [], model_layer: 'byok',
        input_token_budget: inputTokenBudget,
      },
      {
        executeAiCall: async (_m: unknown, input: Record<string, unknown>) => {
          const prompt = String(input['llm.prompt']);
          packets.push(prompt);
          systems.push(String(input['llm.system_prompt']));
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
            if (ref === undefined) return { body: { response: 'no recovery ref', events: [], tool_calls: [] } };
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
        dispatchTool: async (call) => {
          dispatched.push(call.tool_name);
          return { ok: true as const, result: { rows } };
        },
        emit: () => undefined,
        now: () => 1_000,
      },
    );
    return { packets, systems, dispatched };
  };

  it('⛔ a model that lost a value to the trim gets the part it asks for', async () => {
    const { packets, systems, dispatched } = await drive(budget);
    expect(packets).toHaveLength(3);
    const marked = packets.filter((p) => p.includes('llm_gateway_context_omitted'));
    expect(marked, 'something was trimmed').not.toHaveLength(0);
    expect(marked.some((p) => p.includes('context_ref')), 'marker carries a ref')
      .toBe(true);
    // The recovered fragment comes back in a later packet — and ONLY the match.
    const after = packets[2] ?? '';
    expect(after, 'the asked-for row came back').toContain('row-137');
    expect(after, 'the haystack did not').not.toContain('row-399');
    expect(dispatched, 'recovery is local, without re-running the original tool').toEqual(['mail.search']);
    for (const [index, body] of packets.entries()) {
      expect(estimateConservativeMessagesTokens([
        { role: 'system', content: systems[index]! }, { role: 'user', content: body },
      ]), 'every packet fits, including the recovered fragment').toBeLessThanOrEqual(budget);
    }
  });

  it('keeps the smallest fitting marker when there is no room for recovery metadata', async () => {
    const control = await drive(budget);
    const smallest = JSON.parse(control.packets[1]!) as {
      prior_tool_calls: Array<{ args: unknown; result: unknown }>;
    };
    for (const call of smallest.prior_tool_calls) {
      call.args = { llm_gateway_context_omitted: true };
      call.result = { llm_gateway_context_omitted: true };
    }
    const floor = estimateConservativeMessagesTokens([
      { role: 'system', content: control.systems[1]! },
      { role: 'user', content: JSON.stringify(smallest) },
    ]);
    const { packets, systems } = await drive(floor);
    expect(packets).toHaveLength(2);
    expect(packets[1]).toContain('llm_gateway_context_omitted');
    expect(packets[1]).not.toContain('context_ref');
    expect(packets[1]).not.toContain('recover_with');
    expect(packets[1]).not.toContain('row-399');
    expect(estimateConservativeMessagesTokens([
      { role: 'system', content: systems[1]! }, { role: 'user', content: packets[1]! },
    ])).toBeLessThanOrEqual(floor);
  });
});
