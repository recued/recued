import { describe, expect, it, vi } from 'vitest';
import type {
  AIOutput,
  ChatDispatchResult,
  InternalToolRegistry,
  ToolEntry,
} from '@recued/contracts';

import {
  composeChatMainTurnPromptParts,
  EXECUTION_CASE_COMPLETION_NUDGE,
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
    user_message: 'send the report',
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

  it('puts the completion nudge on the model-facing plan result without changing the plan id detail', async () => {
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
    expect(prior.detail).toContain('plan_id=p1');
    expect(prior.detail).toContain(EXECUTION_CASE_COMPLETION_NUDGE);
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
