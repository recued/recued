/** D-145 PB6 — AIOutput shape contract tests.
 *
 *  Covers § B.7.1 AIOutput closed shape (response + events +
 *  tool_calls), `validateAIOutput` shape gate, substrate self-check
 *  (`assertAIOutputInvariants`). D-164 P6b/c retired the
 *  `cognition_diff` slot + cognition placeholder helpers. */

import { describe, expect, it } from 'vitest';

import {
  AI_OUTPUT_VALIDATION_KINDS,
  AI_OUTPUT_VALIDATION_KIND_SET,
  assertAIOutputInvariants,
  coerceAIOutput,
  validateAIOutput,
  type AIOutput,
} from '../ai-output.js';

describe('D-145 PB6 — AI_OUTPUT_VALIDATION_KINDS closed list', () => {
  it('contains exactly 4 entries', () => {
    expect(AI_OUTPUT_VALIDATION_KINDS.length).toBe(4);
    expect(new Set(AI_OUTPUT_VALIDATION_KINDS)).toEqual(
      new Set([
        'response_not_string',
        'events_not_array',
        'tool_calls_not_array',
        'tool_call_not_shaped',
      ]),
    );
  });

  it('AI_OUTPUT_VALIDATION_KIND_SET pinned in lockstep', () => {
    expect(AI_OUTPUT_VALIDATION_KIND_SET.size).toBe(
      AI_OUTPUT_VALIDATION_KINDS.length,
    );
  });
});

describe('D-145 PB6 — validateAIOutput', () => {
  const baseValid: AIOutput = {
    response: 'Nice — what kind?',
    events: [
      {
        kind: 'extraction.purchase',
        confidence: 0.92,
        args: { amount: 5000, currency: 'USD' },
      },
    ],
    tool_calls: [],
  };

  it('accepts a fully-valid AIOutput', () => {
    expect(validateAIOutput(baseValid)).toEqual([]);
  });

  // ── tool_call ENTRY shape ──────────────────────────────────────────
  // Array shape alone was not enough. Measured live (qwen3.7-plus,
  // substrate-bench task 155): a tool_calls entry with no `tool` key passed
  // this gate, reached `resolveConcurrencySafe` → `getByName(undefined)`, and
  // threw inside `topicOfEnrichmentToolName`'s `name.startsWith(...)` — taking
  // the whole turn down. This gate exists so malformed model output halts
  // cleanly with a closed-list reason instead of tripping an invariant
  // downstream, so a nameless call has to be caught HERE.

  it('accepts a well-formed tool call', () => {
    expect(validateAIOutput({
      response: '',
      events: [],
      tool_calls: [{ tool: 'contact.search', args: { query: 'Wren' } }],
    })).toEqual([]);
  });

  it('rejects a tool call with NO tool name — the live crash shape', () => {
    // The exact payload the model emitted: args, no name.
    expect(validateAIOutput({
      response: '',
      events: [],
      tool_calls: [{ args: { query: 'Wren', limit: 5 } }],
    })).toEqual([
      { kind: 'tool_call_not_shaped', detail: 'tool_calls[0].tool: missing' },
    ]);
  });

  it('rejects a non-string or empty tool name, and names the index', () => {
    const issues = validateAIOutput({
      response: '',
      events: [],
      tool_calls: [
        { tool: 'contact.search', args: {} },
        { tool: 42, args: {} },
        { tool: '   ', args: {} },
      ],
    });
    expect(issues).toEqual([
      { kind: 'tool_call_not_shaped', detail: 'tool_calls[1].tool: number' },
      { kind: 'tool_call_not_shaped', detail: 'tool_calls[2].tool: string' },
    ]);
  });

  it('rejects the WHOLE output rather than dispatching the valid entries', () => {
    // Dropping the bad entry and running the rest would silently execute half
    // of a plan the model meant as a whole — a worse failure than halting.
    const issues = validateAIOutput({
      response: '',
      events: [],
      tool_calls: [{ tool: 'mail.send', args: {} }, { args: {} }],
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]!.kind).toBe('tool_call_not_shaped');
  });

  it('never throws on a null or primitive tool_calls entry', () => {
    // The gate's own contract: "this gate must NEVER throw."
    expect(() => validateAIOutput({
      response: '',
      events: [],
      tool_calls: [null, 'contact.search', 7, undefined],
    })).not.toThrow();
    expect(validateAIOutput({
      response: '',
      events: [],
      tool_calls: [null],
    })).toEqual([
      { kind: 'tool_call_not_shaped', detail: 'tool_calls[0].tool: missing' },
    ]);
  });

  it('carries no tool ARGS into the issue detail', () => {
    // Everything the model sees is alias-space at the PII boundary; echoing
    // args into a validation detail would route them past the egress scan.
    const issues = validateAIOutput({
      response: '',
      events: [],
      tool_calls: [{ args: { email: 'wren.tulloch@example.test' } }],
    });
    expect(JSON.stringify(issues)).not.toContain('wren.tulloch');
    expect(JSON.stringify(issues)).not.toContain('example.test');
  });

  it('accepts AIOutput with empty events + tool_calls', () => {
    expect(
      validateAIOutput({
        response: 'Sounds good',
        events: [],
        tool_calls: [],
      }),
    ).toEqual([]);
  });

  it('flags response_not_string when response is missing / wrong type', () => {
    const issues = validateAIOutput({
      ...baseValid,
      response: 42 as unknown as string,
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]!.kind).toBe('response_not_string');
  });

  it('flags events_not_array when events is not array', () => {
    const issues = validateAIOutput({
      ...baseValid,
      events: 'not array' as unknown as AIOutput['events'],
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]!.kind).toBe('events_not_array');
  });

  it('flags tool_calls_not_array when tool_calls is not array', () => {
    const issues = validateAIOutput({
      ...baseValid,
      tool_calls: null as unknown as AIOutput['tool_calls'],
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]!.kind).toBe('tool_calls_not_array');
  });

  it('reports ALL issues at once when multiple fields are bad', () => {
    const issues = validateAIOutput({
      response: undefined as unknown as string,
      events: 'oops' as unknown as AIOutput['events'],
      tool_calls: undefined as unknown as AIOutput['tool_calls'],
    });
    expect(issues).toHaveLength(3);
    expect(new Set(issues.map((i) => i.kind))).toEqual(
      new Set([
        'response_not_string',
        'events_not_array',
        'tool_calls_not_array',
      ]),
    );
  });
});

describe('D-145 PB6 — validateAIOutput untrusted-input guard (Codex P2)', () => {
  it('null input emits all three structural issues without throwing', () => {
    const issues = validateAIOutput(null);
    expect(issues).toHaveLength(3);
    expect(new Set(issues.map((i) => i.kind))).toEqual(
      new Set([
        'response_not_string',
        'events_not_array',
        'tool_calls_not_array',
      ]),
    );
  });

  it('undefined input emits all three structural issues without throwing', () => {
    const issues = validateAIOutput(undefined);
    expect(issues).toHaveLength(3);
  });

  it('primitive input (string / number / boolean) emits all three issues', () => {
    expect(validateAIOutput('not an output')).toHaveLength(3);
    expect(validateAIOutput(42)).toHaveLength(3);
    expect(validateAIOutput(true)).toHaveLength(3);
  });

  it('object missing all three fields emits all three issues', () => {
    const issues = validateAIOutput({});
    expect(issues).toHaveLength(3);
  });
});

describe('D-145 PB6 — assertAIOutputInvariants', () => {
  it('passes on the as-shipped substrate', () => {
    expect(() => assertAIOutputInvariants()).not.toThrow();
  });
});

describe('coerceAIOutput — real-model envelope normalization', () => {
  it('reads a bare NATIVE tool-use block — the shape that silently lost a round', () => {
    // Verbatim from a live qwen3.7-plus turn (bench 181, 2026-08-18). Before the
    // branch existed this produced `tool_calls: []` — a well-formed AIOutput that
    // dispatched nothing, costing one round with no surfaced error.
    const out = coerceAIOutput({
      type: 'tool_use',
      id: 'toolu_bdrk_01F3KZmsZm1U1o2X4Y5V6W7Z',
      name: 'recipe.run',
      input: { recipe_id: 'recued-core/add-unit', config: { label: 'Flat 2' } },
    }) as AIOutput;
    expect(out.tool_calls).toEqual([
      { tool: 'recipe.run', args: { recipe_id: 'recued-core/add-unit', config: { label: 'Flat 2' } } },
    ]);
    expect(out.response).toBe('');
  });

  it('reads an ARRAY of native tool_use blocks — bench 181 died on this', () => {
    // Verbatim final output of a slice+lean-core run. The dropped call was the
    // NEXT STEP OF THE CHAIN: the model was working, the harness lost the call,
    // and the loop reported `completed`.
    const out = coerceAIOutput([
      { type: 'tool_use', id: 'toolu_01MjFf', name: 'recued-core/add-customer',
        input: { name: 'Riverside Holdings', payment_method: 'cash' } },
    ]) as AIOutput;
    expect(out.tool_calls).toEqual([
      { tool: 'recued-core/add-customer',
        args: { name: 'Riverside Holdings', payment_method: 'cash' } },
    ]);
    expect(validateAIOutput(out)).toEqual([]);
  });

  it('reads `{tool_name, args}` — a near-miss on the contract field name', () => {
    const out = coerceAIOutput([
      { tool_name: 'recued-core/list-customers', args: { limit: 100 } },
    ]) as AIOutput;
    expect(out.tool_calls).toEqual([
      { tool: 'recued-core/list-customers', args: { limit: 100 } },
    ]);
    expect(validateAIOutput(out)).toEqual([]);
  });

  it('normalizes a PRESENT tool_calls array too — right wrapper, wrong fields', () => {
    const out = coerceAIOutput({
      response: 'on it',
      tool_calls: [{ tool_name: 'mail.search', args: { q: 'x' } }],
    }) as AIOutput;
    expect(out.tool_calls).toEqual([{ tool: 'mail.search', args: { q: 'x' } }]);
    expect(out.response).toBe('on it');
  });

  it('⛔ leaves an UNRECOGNISED shape alone for the validator to flag', () => {
    // The guard against inventing calls. A fourth alias needs a transcript,
    // not a guess — each accepted shape is a new way for garbage to read as a
    // confident tool call.
    const out = coerceAIOutput([{ nonsense: true }]) as AIOutput;
    expect(out.tool_calls).toEqual([{ nonsense: true }]);
    expect(validateAIOutput(out).length).toBeGreaterThan(0);
  });

  it('⛔ a normal envelope carrying `name`/`input` is NOT reinterpreted', () => {
    // The mutation-killer. Dropping any wrapper-key guard would make this
    // envelope's `response` and `tool_calls` vanish into a fabricated call.
    const out = coerceAIOutput({
      response: 'here you go',
      tool_calls: [{ tool: 'mail.search', args: { q: 'x' } }],
      name: 'not-a-tool',
      input: { nope: true },
    }) as AIOutput;
    expect(out.response).toBe('here you go');
    expect(out.tool_calls).toEqual([{ tool: 'mail.search', args: { q: 'x' } }]);
  });

  it('⛔ `name` without an object `input` is left alone — no garbage tool name', () => {
    const out = coerceAIOutput({ name: 'recipe.run', input: 'not-an-object' }) as AIOutput;
    expect(out.tool_calls).toEqual([]);
  });

  it('fills a MISSING events key (model dropped the empty optional)', () => {
    const out = coerceAIOutput({
      response: 'hi',
      tool_calls: [{ tool: 'contact.search', args: { query: 'x' } }],
    });
    expect(validateAIOutput(out)).toHaveLength(0);
    expect((out as AIOutput).events).toEqual([]);
    // present fields preserved untouched
    expect((out as AIOutput).response).toBe('hi');
    expect((out as AIOutput).tool_calls).toHaveLength(1);
  });

  it('fills missing tool_calls AND events for a response-only object', () => {
    const out = coerceAIOutput({ response: 'just talking' }) as AIOutput;
    expect(validateAIOutput(out)).toHaveLength(0);
    expect(out.events).toEqual([]);
    expect(out.tool_calls).toEqual([]);
  });

  it('fills a missing response (model emitted only a tool call)', () => {
    const out = coerceAIOutput({ events: [], tool_calls: [] }) as AIOutput;
    expect(validateAIOutput(out)).toHaveLength(0);
    expect(out.response).toBe('');
  });

  it('is a no-op on a well-formed envelope (all keys present)', () => {
    const input = { response: 'r', events: [], tool_calls: [] };
    const out = coerceAIOutput(input) as AIOutput;
    expect(out).toEqual(input);
    expect(validateAIOutput(out)).toHaveLength(0);
  });

  it('does NOT mask a present null field — validateAIOutput still flags it', () => {
    // A genuinely malformed envelope (null, not a dropped key) must stay
    // malformed; `??` would have masked this, the `=== undefined` guard does not.
    const out = coerceAIOutput({ response: 'r', events: null, tool_calls: [] });
    const issues = validateAIOutput(out);
    expect(issues.map((i) => i.kind)).toContain('events_not_array');
  });

  it('does NOT rewrite a present wrong-typed field', () => {
    const out = coerceAIOutput({
      response: 'r',
      events: 'oops',
      tool_calls: [],
    }) as Record<string, unknown>;
    expect(out.events).toBe('oops');
    expect(validateAIOutput(out).map((i) => i.kind)).toContain(
      'events_not_array',
    );
  });

  it('wraps a bare {tool, args} into the tool_calls envelope', () => {
    const out = coerceAIOutput({
      tool: 'bench/send-email',
      args: { to: 'a@b.com' },
    }) as AIOutput;
    expect(validateAIOutput(out)).toHaveLength(0);
    expect(out.response).toBe('');
    expect(out.tool_calls).toEqual([
      { tool: 'bench/send-email', args: { to: 'a@b.com' } },
    ]);
  });

  it('does NOT reinterpret a normal envelope that also happens to carry a tool key', () => {
    // wrapper keys present → common-case branch, NOT the bare-tool branch.
    const out = coerceAIOutput({
      response: 'r',
      tool_calls: [{ tool: 't', args: {} }],
      tool: 'stray',
    }) as Record<string, unknown>;
    expect((out.tool_calls as unknown[])).toHaveLength(1);
    expect(out.tool).toBe('stray'); // spread preserves the stray key, not wrapped
  });

  it('wraps a bare array of tool calls into the envelope', () => {
    const out = coerceAIOutput([
      { tool: 'a', args: {} },
      { tool: 'b', args: {} },
    ]) as AIOutput;
    expect(validateAIOutput(out)).toHaveLength(0);
    expect(out.tool_calls).toHaveLength(2);
  });

  it('returns non-object / non-array primitives unchanged', () => {
    expect(coerceAIOutput(null)).toBeNull();
    expect(coerceAIOutput('raw text')).toBe('raw text');
    expect(coerceAIOutput(42)).toBe(42);
    // and validateAIOutput still rejects them
    expect(validateAIOutput(coerceAIOutput('raw text'))).toHaveLength(3);
  });
});

describe('D-145 PB6 — an alias must never eat a tool RESULT', () => {
  // ⛔⛔ THE REGRESSION THIS EXISTS TO STOP. The packet shows the model its own
  // `prior_tool_calls` as `{ tool_name, args, status, result, started_at,
  // completed_at }` — whose first two fields ARE the `{tool_name, args}` alias.
  // A model that echoes that block back (observed on bench 181, a 2-entry echo)
  // was re-read as a fresh batch and the tools RAN A SECOND TIME, 18ms apart —
  // which is also exactly what D-219 slice 8 excludes as a repeat. The echo did
  // not merely duplicate work; it destroyed the execution case.
  const echoEntry = {
    tool_name: 'recued-core/list-buildings',
    args: { limit: 100 },
    status: 'ok',
    result: { success: true },
    started_at: 1,
    completed_at: 2,
  };

  it('turns an all-echo array into a RECOVERABLE empty envelope, not a failed one', () => {
    const out = coerceAIOutput([echoEntry, { ...echoEntry, tool_name: 'recued-core/add-unit' }]) as {
      response: string; events: unknown[]; tool_calls: ReadonlyArray<unknown>;
    };
    expect(out.tool_calls).toEqual([]);
    // ⛔ VALID, deliberately. A validation failure returns `kind: 'failed'` and
    // ABORTS the turn with no retry; an empty envelope earns the one recovery
    // round that asks the model to re-emit. The echo expressed no intent, so
    // the recoverable path is the honest one — and it is NOT a re-dispatch.
    expect(validateAIOutput(out)).toEqual([]);
  });

  it('keeps a MIXED array failing validation rather than dropping half a plan', () => {
    const out = coerceAIOutput([echoEntry, { tool: 'recued-core/add-unit', args: {} }]) as {
      tool_calls: ReadonlyArray<Record<string, unknown>>;
    };
    expect(out.tool_calls).toHaveLength(2);
    expect(validateAIOutput(out).some((i) => i.kind === 'tool_call_not_shaped')).toBe(true);
  });

  it('still converts a GENUINE {tool_name, args} call that carries no result fields', () => {
    const out = coerceAIOutput([{ tool_name: 'recued-core/list-customers', args: { limit: 5 } }]) as {
      tool_calls: ReadonlyArray<Record<string, unknown>>;
    };
    expect(out.tool_calls).toEqual([
      { tool: 'recued-core/list-customers', args: { limit: 5 } },
    ]);
    expect(validateAIOutput(out)).toEqual([]);
  });

  it('reads the OpenAI {name, arguments} shape when arguments is an OBJECT', () => {
    // Observed live (bench 181): the chain's `add-customer` step, dropped entirely.
    const out = coerceAIOutput({
      name: 'recipe.run',
      arguments: { recipe_id: 'recued-core/add-customer', config: { name: 'Riverside Holdings' } },
    }) as { tool_calls: ReadonlyArray<Record<string, unknown>> };
    expect(out.tool_calls).toEqual([
      {
        tool: 'recipe.run',
        args: { recipe_id: 'recued-core/add-customer', config: { name: 'Riverside Holdings' } },
      },
    ]);
  });

  it('leaves the JSON-STRING arguments variant alone', () => {
    // Standing ruling: a parse-on-guess trades a visible empty round for a
    // silent wrong one. Unhandled until a transcript shows it.
    const out = coerceAIOutput({ name: 'recipe.run', arguments: '{"recipe_id":"x"}' }) as {
      tool_calls?: unknown;
    };
    expect(out.tool_calls).toEqual([]);
  });
});

describe('D-145 PB6 — shapes drawn from OUR OWN packet vocabulary', () => {
  it('reads {recipe_slug, args} — the field name the catalog advertises', () => {
    // ⛔ THE COMPLETE THIRD STEP OF A CHAIN WAS DROPPED ON THIS. Verbatim from
    // bench 181: every id grounded, the start date present, and unreadable only
    // because `available_tools` calls the field `recipe_slug` and the decoder
    // insisted on `tool`.
    const out = coerceAIOutput({
      recipe_slug: 'recued-core/open-rental-contract',
      args: {
        customer_id: 'rec_bba818eb-6a43-4139-91ed-bf862cc252f2',
        unit_id: 'rec_3cc9e3ad-3821-465d-9e1a-2a4c1938987e',
        rent: '1200',
        start_date: '2026-09-01',
        end_date: '',
      },
    }) as { tool_calls: ReadonlyArray<Record<string, unknown>> };
    expect(out.tool_calls).toHaveLength(1);
    expect(out.tool_calls[0]!.tool).toBe('recued-core/open-rental-contract');
    expect(validateAIOutput(out)).toEqual([]);
  });

  it('wraps a BARE extraction event back into events[]', () => {
    const out = coerceAIOutput({
      kind: 'extraction.intent',
      payload: { intent: 'Add a customer to the rental book' },
    }) as { events: ReadonlyArray<Record<string, unknown>>; tool_calls: unknown[] };
    expect(out.events).toHaveLength(1);
    expect(out.events[0]!.kind).toBe('extraction.intent');
    expect(out.tool_calls).toEqual([]);
  });

  it('does NOT mint a tool call from a bare {kind, payload} naming a TOOL', () => {
    // `request.dissection` arrived in exactly this shape. Minting a dispatch
    // from an unverified name is the silent-wrong-action trade; an empty
    // envelope earns the recovery round instead, which is visible.
    const out = coerceAIOutput({
      kind: 'request.dissection',
      payload: { schema_version: 1, intent: 'list my buildings' },
    }) as { events: unknown[]; tool_calls: unknown[] };
    expect(out.tool_calls).toEqual([]);
    expect(out.events).toEqual([]);
    expect(validateAIOutput(out)).toEqual([]);
  });

  it('leaves a result echo carrying recipe_slug alone', () => {
    // The echo guard must still win over the new alias.
    const out = coerceAIOutput([{
      recipe_slug: 'recued-core/add-unit', args: {}, status: 'ok', result: { success: true },
    }]) as { tool_calls: unknown[] };
    expect(out.tool_calls).toEqual([]);
  });
});

describe('D-145 PB6 — the bare request.dissection shapes', () => {
  const payload = { schema_version: 1, intent: 'List my buildings' };

  it('reads the single-key wrapper {"request.dissection": {…}}', () => {
    const out = coerceAIOutput({ 'request.dissection': payload }) as {
      tool_calls: ReadonlyArray<Record<string, unknown>>;
    };
    expect(out.tool_calls).toEqual([{ tool: 'request.dissection', args: payload }]);
    expect(validateAIOutput(out)).toEqual([]);
  });

  it('reads {kind: "request.dissection", args: {…}}', () => {
    const out = coerceAIOutput({ kind: 'request.dissection', args: payload }) as {
      tool_calls: ReadonlyArray<Record<string, unknown>>;
    };
    expect(out.tool_calls).toEqual([{ tool: 'request.dissection', args: payload }]);
  });

  it('still REFUSES {kind, payload} — the model expressed an event, not a call', () => {
    const out = coerceAIOutput({ kind: 'request.dissection', payload }) as {
      tool_calls: unknown[]; events: unknown[];
    };
    expect(out.tool_calls).toEqual([]);
    expect(out.events).toEqual([]);
  });

  it('does not mistake a two-key catalog echo for a single-key wrapper', () => {
    const out = coerceAIOutput({
      recipe_slug: 'recued-core/open-rental-contract',
      args_schema: { type: 'object' },
    }) as { tool_calls: unknown[] };
    expect(out.tool_calls).toEqual([]);
  });

  it('does not mint a call from a single-key wrapper whose key is a plain word', () => {
    // `{summary: {...}}` is prose structure, not a tool name. The `.`/`/`
    // requirement is what keeps ordinary single-key objects out.
    const out = coerceAIOutput({ summary: { text: 'done' } }) as { tool_calls: unknown[] };
    expect(out.tool_calls).toEqual([]);
  });

  it('does not mint a call from a single-key wrapper holding a non-object', () => {
    const out = coerceAIOutput({ 'a.b': 'not an object' }) as { tool_calls: unknown[] };
    expect(out.tool_calls).toEqual([]);
  });
});

describe('D-145 PB6 — the {name, args} hybrid', () => {
  it('reads a native-style array whose entries pair `name` with `args`', () => {
    // Verbatim from a live lean-core turn; it was dropped whole and the round
    // was only saved by the guided retry.
    const out = coerceAIOutput([
      { type: 'tool_call', id: 'toolu_bdrk_01W4', name: 'tools.search', args: { query: 'add customer' } },
    ]) as { tool_calls: ReadonlyArray<Record<string, unknown>> };
    expect(out.tool_calls).toEqual([
      { tool: 'tools.search', args: { query: 'add customer' } },
    ]);
    expect(validateAIOutput(out)).toEqual([]);
  });

  it('still prefers `input` when a native block carries BOTH', () => {
    const out = coerceAIOutput({ name: 't', input: { a: 1 }, args: { b: 2 } }) as {
      tool_calls: ReadonlyArray<Record<string, unknown>>;
    };
    expect(out.tool_calls[0]!.args).toEqual({ a: 1 });
  });

  it('does not read a RESULT echo that happens to carry name+args', () => {
    const out = coerceAIOutput([
      { name: 'recued-core/add-unit', args: {}, status: 'ok', result: { success: true } },
    ]) as { tool_calls: unknown[] };
    expect(out.tool_calls).toEqual([]);
  });
});
