import { describe, expect, it, vi } from 'vitest';
import type {
  AIOutput,
  ChatDispatchResult,
  InternalToolRegistry,
  ToolEntry,
} from '@recued/contracts';

import {
  composeChatMainTurnPromptParts,
  runChatTurn,
} from '../chat-turn-executor.js';
import {
  deriveExecutionFlowPattern,
} from '../execution-case-core.js';

const entry: ToolEntry = {
  name: 'mail.send',
  tier: 2,
  description: 'send mail',
  arg_schema: {},
  topic_tags: ['mail'],
  classification: 'write',
  risk_tier: 'write',
  concurrency_safe: false,
};

const registry: InternalToolRegistry = {
  list: () => [entry],
  listByTier: () => [entry],
  getByName: (name) => name === entry.name ? entry : null,
  dispatch: async () => ({ ok: true, result: {} }),
  subscribeRefresh: () => () => {},
};

const input = {
  session_id: 's1',
  turn_id: 't1',
  picker_target: 'self' as const,
  dispatch_peer_name: null,
  available_tools: [{
    recipe_slug: 'mail.send',
    args_schema: {},
  }],
  content: {
    chat_tail: [],
    // ⚠ Names the recipient the proposals below use. The tool loop refuses a
    // dispatch whose identifier no completed step returned, and this fixture's
    // `alice@example.com` was sourced by nothing — which is the fabrication
    // class, not a quirk. These tests are about the CRITIQUE flow, so the
    // fixture is grounded and their subject is unchanged.
    user_message: 'send the report to alice@example.com',
  },
  correction_context: [] as string[],
  model_layer: 'byok' as const,
};

const proposed: AIOutput = {
  response: '',
  events: [],
  tool_calls: [{
    tool: 'mail.send',
    args: { recipient: 'alice@example.com' },
  }],
};

describe('D-214 proposal critique in the real cooperative executor', () => {
  it('reinvokes before dispatch, then sends a repeated proposal through ordinary dispatch', async () => {
    const ordering: string[] = [];
    const prompts: Record<string, unknown>[] = [];
    let round = 0;
    const executeAiCall = vi.fn(async (_manifest, raw) => {
      prompts.push(JSON.parse(String(raw['llm.prompt'])) as Record<string, unknown>);
      ordering.push(`model-${round}`);
      const body = round++ < 2
        ? proposed
        : { response: 'done', events: [], tool_calls: [] };
      return { body };
    });
    let critiqueCalls = 0;
    const critiqueProposal = vi.fn(async () => {
      ordering.push(`critic-${critiqueCalls}`);
      if (critiqueCalls++ > 0) return null;
      return {
        critique: {
          candidate_pattern: deriveExecutionFlowPattern([
            { tool_name: 'mail.send', risk_tier: 'write' },
          ]),
          support: [],
          contradictions: [],
          alternatives: [],
        },
      };
    });
    const dispatchTool = vi.fn(async (): Promise<ChatDispatchResult> => {
      ordering.push('gateway-dispatch');
      return { ok: true, result: { sent: true } };
    });

    const result = await runChatTurn(input, {
      executeAiCall,
      registry,
      critiqueProposal,
      dispatchTool,
      emit: () => {},
      now: () => 1_000,
    });
    expect(result.assistant_content).toBe('done');
    expect(dispatchTool).toHaveBeenCalledTimes(1);
    expect(ordering.indexOf('critic-0')).toBeLessThan(
      ordering.indexOf('gateway-dispatch'),
    );
    expect(ordering.indexOf('model-1')).toBeLessThan(
      ordering.indexOf('gateway-dispatch'),
    );
    expect(prompts[1]!.prior_tool_calls).toEqual([
      expect.objectContaining({
        tool_name: 'execution.case.critique',
        result: expect.objectContaining({
          advisory_only: true,
        }),
      }),
    ]);
    expect(JSON.stringify(prompts[1])).not.toContain('intervention_id');
    expect(JSON.stringify(prompts[1])).not.toContain('candidate_flow_hash');
    expect(prompts[2]!.prior_tool_calls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ tool_name: 'execution.case.critique' }),
        expect.objectContaining({ tool_name: 'mail.send', status: 'ok' }),
      ]),
    );
  });

  it('⛔ reports the critique-reinvoke empty exit as output_unreadable, not completed', async () => {
    // ⛔ THE SECOND EXIT. `loopEmptyUnrecovered` is set at two different
    // `break`s — the `!moreTools` exit (covered by the orchestrator ratchet)
    // and THIS one, where the critique reinvocation itself comes back
    // unreadable. A fix written against the first branch alone leaves this
    // path still reporting `completed`, so the reason is derived from the
    // FLAG after the loop and this test is what proves the pair is covered.
    const events: Record<string, unknown>[] = [];
    let round = 0;
    const executeAiCall = vi.fn(async () => ({
      body: round++ === 0
        ? proposed
        : { response: '', events: [], tool_calls: [] },
    }));
    const dispatchTool = vi.fn(async (): Promise<ChatDispatchResult> => ({
      ok: true,
      result: { sent: true },
    }));
    let critiqueCalls = 0;
    const result = await runChatTurn(input, {
      executeAiCall,
      registry,
      critiqueProposal: async () => {
        if (critiqueCalls++ > 0) return null;
        return {
          critique: {
            candidate_pattern: deriveExecutionFlowPattern([
              { tool_name: 'mail.send', risk_tier: 'write' },
            ]),
            support: [],
            contradictions: [],
            alternatives: [],
          },
        };
      },
      dispatchTool,
      emit: (e) => { events.push(e as Record<string, unknown>); },
      now: () => 1_000,
    });

    // The exit is genuinely the critique one: the reinvoke came back empty
    // BEFORE anything dispatched.
    expect(dispatchTool).toHaveBeenCalledTimes(0);
    const terminated = events
      .map((e) => e.event as { kind?: string; termination_reason?: string })
      .filter((e) => e?.kind === 'recued.multi_turn.loop_terminated');
    expect(terminated).toEqual([
      expect.objectContaining({ termination_reason: 'output_unreadable' }),
    ]);
    expect(result.assistant_content).not.toBe('');
  });

  it('adds no model round and no dispatch effect when evidence is absent', async () => {
    let round = 0;
    const executeAiCall = vi.fn(async () => ({
      body: round++ === 0
        ? proposed
        : { response: 'done', events: [], tool_calls: [] },
    }));
    const dispatchTool = vi.fn(async (): Promise<ChatDispatchResult> => ({
      ok: true,
      result: { sent: true },
    }));
    await runChatTurn(input, {
      executeAiCall,
      registry,
      critiqueProposal: async () => null,
      dispatchTool,
      emit: () => {},
      now: () => 1_000,
    });
    expect(executeAiCall).toHaveBeenCalledTimes(2);
    expect(dispatchTool).toHaveBeenCalledTimes(1);
  });

  it('⛔ D-219 9b-ii: the approval-pending result carries NO self-report errand', async () => {
    const prompts: Record<string, unknown>[] = [];
    let round = 0;
    await runChatTurn(input, {
      executeAiCall: async (_manifest, raw) => {
        prompts.push(
          JSON.parse(String(raw['llm.prompt'])) as Record<string, unknown>,
        );
        return {
          body: round++ === 0
            ? proposed
            : { response: 'waiting', events: [], tool_calls: [] },
        };
      },
      registry,
      dispatchTool: async () => ({
        ok: false,
        reason: 'awaiting_approval',
        detail: 'plan_id=p1',
      }),
      emit: () => {},
      now: () => 1_000,
    });
    const prior = (prompts[1]!.prior_tool_calls as Array<{
      detail: string;
    }>)[0]!;
    // WAS: "puts the completion nudge on the model-facing plan result". The
    // nudge told the model to call `outcome.report` once the approved work
    // finished — the one moment it was asked to self-report. Slice 9b removed
    // the last counter that read what it said, and slice 9a removed the reason
    // to want it (every governed turn is recorded without asking). The
    // instruction is deleted, and the plan-id detail it rode on is untouched.
    expect(prior.detail).toBe('plan_id=p1');
    expect(prior.detail).not.toContain('outcome.report');
    // ⚠ No trailing separator either: an empty-string tombstone would have left
    // `plan_id=p1\n` here and read as "still appending something".
    expect(prior.detail.endsWith('\n')).toBe(false);
  });
});

describe('D-214 cards stay below the cacheable prefix', () => {
  it('changes only the dynamic tail and never serializes open_items', () => {
    const baseline = composeChatMainTurnPromptParts({
      available_tools: [],
      content: { chat_tail: [], user_message: 'send the report' },
    });
    const augmented = composeChatMainTurnPromptParts({
      available_tools: [],
      content: { chat_tail: [], user_message: 'send the report' },
      execution_case_context: {
        notice: 'Historical evidence only.',
        cards: [{
          request_shape: {
            schema_version: 1,
            locale_candidates: ['en'],
            surface_terms: ['send', 'report'],
            segmented_terms: ['send', 'report'],
            entity_slots: [],
            intent_facets: ['send report'],
            constraint_facets: ['send'],
            risk_facets: [],
          },
          flows: [],
          outcome_strength: {
            positive: 1,
            negative: 0,
            contested: false,
            evidence_families: ['typed_acceptance'],
          },
          recent: {
            window: 1,
            positive: 1,
            negative: 0,
            consecutive_contradictions: 0,
          },
          request_observations: 1,
          last_seen_at: 1,
          superseded: false,
          history: [],
          applicability_notes: ['Current Gateway policy still applies.'],
        }],
      },
    });
    expect(augmented.cacheable_prefix).toBe(baseline.cacheable_prefix);
    expect(augmented.body).toContain('execution_case_context');
    expect(augmented.body).not.toContain('open_items');
  });
});

describe('an unreadable mid-loop output earns ONE guided retry, like an empty one', () => {
  // ⛔ Measured on bench 181 (lean-core): a turn that had already dispatched
  // four recipes and materialized an execution case ABORTED on a bare string
  // reply, and another aborted on an array of non-call objects after two
  // steps. An EMPTY output would have survived both — it earns a recovery
  // round. The output that said something malformed did not, which is the
  // asymmetry this covers.
  const registryOf = (entry: ToolEntry): InternalToolRegistry => ({
    list: () => [entry],
    listByTier: () => [entry],
    getByName: (n) => (n === entry.name ? entry : null),
    dispatch: async () => ({ ok: true, result: {} }),
    subscribeRefresh: () => () => {},
  });

  it('retries a bare-string reinvoke and completes instead of aborting', async () => {
    const events: Record<string, unknown>[] = [];
    let round = 0;
    const executeAiCall = vi.fn(async () => {
      round += 1;
      if (round === 1) return { body: proposed };
      // The synthesis reinvoke comes back as a bare string — parsed, rejected.
      if (round === 2) return { body: 'Riverside Holdings is added.' };
      return { body: { response: 'done', events: [], tool_calls: [] } };
    });
    const result = await runChatTurn(input, {
      executeAiCall,
      registry: registryOf(entry),
      critiqueProposal: async () => null,
      dispatchTool: async () => ({ ok: true, result: { sent: true } }),
      emit: (e) => { events.push(e as Record<string, unknown>); },
      now: () => 1_000,
    });

    expect(result.assistant_content).toBe('done');
    const terminated = events
      .map((e) => e.event as { kind?: string; termination_reason?: string })
      .filter((e) => e?.kind === 'recued.multi_turn.loop_terminated');
    expect(terminated).toEqual([
      expect.objectContaining({ termination_reason: 'completed' }),
    ]);
    // The retry is BOUNDED at one extra call: plan, bad synthesis, retry.
    expect(executeAiCall).toHaveBeenCalledTimes(3);
  });

  it('does NOT retry a provider failure — only a decode failure', async () => {
    // A provider/network error carries no `validation_issues`; retrying it
    // spends another call on the same outage.
    let round = 0;
    const executeAiCall = vi.fn(async () => {
      round += 1;
      if (round === 1) return { body: proposed };
      throw new Error('upstream exploded');
    });
    const events: Record<string, unknown>[] = [];
    await runChatTurn(input, {
      executeAiCall,
      registry: registryOf(entry),
      critiqueProposal: async () => null,
      dispatchTool: async () => ({ ok: true, result: { sent: true } }),
      emit: (e) => { events.push(e as Record<string, unknown>); },
      now: () => 1_000,
    });
    expect(executeAiCall).toHaveBeenCalledTimes(2);
    const terminated = events
      .map((e) => e.event as { kind?: string; termination_reason?: string })
      .filter((e) => e?.kind === 'recued.multi_turn.loop_terminated');
    expect(terminated).toEqual([
      expect.objectContaining({ termination_reason: 'aborted' }),
    ]);
  });
});

describe('the INITIAL output earns the same guided retry as a mid-loop one', () => {
  // ⛔ MEASURED LIVE (D-247 probe, lean-core): the model's FIRST output carried
  // `tool_calls: [{kind: 'extraction.request_dissection', payload}, {tool:
  // 'tools.search', args}]` — one event-shaped entry among real calls. One bad
  // entry fails the whole output, so the turn ended after ONE model call with
  // `decoder_unavailable { reason: 'invalid_output', site: 'initial' }` and the
  // `tools.search` beside it never ran.
  //
  // 🔑 The mid-loop retry had already shipped. Fixing one site is not fixing the
  // rule, and the initial site is where an unreadable output costs MOST: the
  // turn has done nothing yet and simply stops.
  it('retries a malformed first output instead of ending the turn', async () => {
    let round = 0;
    const executeAiCall = vi.fn(async () => {
      round += 1;
      if (round === 1) {
        // Verbatim shape from the live probe: an event object inside tool_calls.
        return { body: { response: 'checking', events: [], tool_calls: [
          { kind: 'extraction.request_dissection', payload: { schema_version: 1 } },
          { tool: 'mail.send', args: { recipient: 'alice@example.com' } },
        ] } };
      }
      return { body: { response: 'recovered', events: [], tool_calls: [] } };
    });
    const result = await runChatTurn(input, {
      executeAiCall,
      registry,
      critiqueProposal: async () => null,
      dispatchTool: async () => ({ ok: true, result: {} }),
      emit: () => {},
      now: () => 1_000,
    });
    expect(result.assistant_content).toBe('recovered');
    expect(executeAiCall).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry a provider failure on the first call', async () => {
    const executeAiCall = vi.fn(async () => { throw new Error('upstream down'); });
    await runChatTurn(input, {
      executeAiCall,
      registry,
      critiqueProposal: async () => null,
      dispatchTool: async () => ({ ok: true, result: {} }),
      emit: () => {},
      now: () => 1_000,
    });
    expect(executeAiCall).toHaveBeenCalledTimes(1);
  });
});
