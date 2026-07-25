import { describe, expect, it, vi } from 'vitest';

import { piiEgress } from '@recued/gateway';
import type { AIOutput, IngredientManifest } from '@recued/contracts';
import type { EntityPromptPart } from '@recued/middleware';

import {
  ChatPiiPrivacyError,
  wrapExecuteAiCallForPii,
  type PiiEgressPlan,
} from '../chat-pii-egress.js';
import type { ExecuteChatAiCall } from '../chat-orchestrator.js';

const MANIFEST = {} as IngredientManifest;

const makePlan = (
  over: Partial<PiiEgressPlan> = {},
): PiiEgressPlan => ({
  active: true,
  ledger: piiEgress.createSessionLedgerStore().getOrCreate('current'),
  resolver: piiEgress.noopFieldPrivacyResolver,
  summary: {
    value: { mode: 'alias', scope_kind: 'session', counts: {} },
  },
  restoreAuthority: {},
  retainedCandidates: { value: [] },
  ...over,
});

const emptyContribution = {
  candidates: [],
  partial: false,
  joined_source_session_ids: [],
  decrypted_rows: 0,
  decrypted_bytes: 0,
} as const;

/** D-213 §3.8 — X1 now emits the RETURNED PIECES, not bare session ids. */
const joinPiece = (session_id: string, message_id = 'm1', ts = 10) => ({
  session_id,
  message_id,
  ts,
  content: 'Alice Ada said yes',
});

describe('D-213 Track B — X1 egress reharvest integration', () => {
  it('uses only X1 ids, aliases every dynamic field, and restores only what this request showed', async () => {
    const contribute = vi.fn(async (input: {
      readonly joined_pieces: readonly { session_id: string }[];
    }) => ({
      ...emptyContribution,
      candidates: [
        { value: 'Alice Ada', kind: 'name' as const },
        { value: 'Absent Corporation', kind: 'org' as const },
      ],
      joined_source_session_ids: input.joined_pieces.map((p) => p.session_id),
    }));
    const plan = makePlan({
      candidateReharvest: {
        contributor: { contribute },
        getJoinedPieces: () => [joinPiece('history-2'), joinPiece('history-1')],
        hasRegisteredRecall: () => true,
      },
    });
    let providerPacket: Record<string, unknown> = {};
    const real: ExecuteChatAiCall = vi.fn(async (_manifest, input) => {
      providerPacket = JSON.parse(String(input['llm.prompt'])) as Record<
        string,
        unknown
      >;
      const alias = String(providerPacket.user_message);
      return {
        body: {
          response: `contact ${alias}`,
          events: [],
          tool_calls: [],
        } satisfies AIOutput,
      };
    });

    const result = await wrapExecuteAiCallForPii(real, plan)(
      MANIFEST,
      {
        'llm.prompt': JSON.stringify({
          available_tools: [{
            description: 'Alice Ada remains in the stable catalog head',
          }],
          user_message: 'Ask Alice Ada',
          chat_tail: [{ role: 'user', content: 'Alice Ada owns this' }],
          recall_context: [{ result: { content: 'Alice Ada said yes' } }],
          prior_tool_calls: [{ result: { owner: 'Alice Ada' } }],
          correction_context: ['Alice Ada prefers email'],
          output_feedback: { note: 'Alice Ada was omitted' },
        }),
      },
    );

    expect(contribute).toHaveBeenCalledOnce();
    expect(contribute).toHaveBeenCalledWith({
      joined_pieces: [joinPiece('history-2'), joinPiece('history-1')],
    });
    for (const field of [
      'user_message',
      'chat_tail',
      'recall_context',
      'prior_tool_calls',
      'correction_context',
      'output_feedback',
    ]) {
      expect(JSON.stringify(providerPacket[field])).not.toContain('Alice Ada');
    }
    expect(JSON.stringify(providerPacket.available_tools)).toContain('Alice Ada');
    expect((result.body as AIOutput).response).toBe('contact Ask Alice Ada');
    expect(plan.ledger.byKindRealValue.has('name::Alice Ada')).toBe(true);
    expect(
      plan.ledger.byKindRealValue.has('org::Absent Corporation'),
    ).toBe(false);
  });

  it('derives overlap suffixes from raw owner disclosure before direct protection rewrites it', async () => {
    const plan = makePlan({
      resolver: () => [{ path: 'owner', kind: 'name' }],
      candidateReharvest: {
        contributor: {
          contribute: async () => ({
            ...emptyContribution,
            candidates: [{ value: 'Alice Ada', kind: 'name' as const }],
          }),
        },
        getJoinedPieces: () => [joinPiece('history')],
        hasRegisteredRecall: () => true,
      },
    });
    let providerPacket: {
      user_message?: string;
      recall_context?: Array<{ result: string }>;
    } = {};
    const real: ExecuteChatAiCall = async (_manifest, input) => {
      providerPacket = JSON.parse(String(input['llm.prompt'])) as typeof providerPacket;
      return {
        body: { response: 'ok', events: [], tool_calls: [] } satisfies AIOutput,
      };
    };

    await wrapExecuteAiCallForPii(real, plan)(
      MANIFEST,
      {
        'llm.prompt': JSON.stringify({
          owner: 'Alice Ada',
          user_message: 'Alice Ada',
          recall_context: [{ result: 'Alice Ada' }],
        }),
      },
    );

    expect(providerPacket.user_message).toBe('pii.Person1.alice.ada');
    expect(providerPacket.recall_context?.[0]?.result).toBe(
      'pii.Person1.alice.ada',
    );
  });

  it('does not overwrite Track A recall completeness with candidate-harvest partiality', async () => {
    const plan = makePlan({
      candidateReharvest: {
        contributor: {
          contribute: async () => ({
            ...emptyContribution,
            partial: true,
          }),
        },
        getJoinedPieces: () => [joinPiece('history-1')],
        hasRegisteredRecall: () => true,
      },
    });
    let providerPacket: Record<string, unknown> = {};
    const real: ExecuteChatAiCall = async (_manifest, input) => {
      providerPacket = JSON.parse(String(input['llm.prompt'])) as Record<
        string,
        unknown
      >;
      return {
        body: { response: 'ok', events: [], tool_calls: [] } satisfies AIOutput,
      };
    };

    await wrapExecuteAiCallForPii(real, plan)(
      MANIFEST,
      {
        'llm.prompt': JSON.stringify({
          recall_context: [{
            result: {
              ok: true,
              matches: [],
              exhausted: true,
              partial: false,
            },
          }],
        }),
      },
    );

    expect(providerPacket.recall_context).toEqual([{
      result: {
        ok: true,
        matches: [],
        exhausted: true,
        partial: false,
      },
    }]);
    expect(providerPacket).not.toHaveProperty('candidate_partial');
  });

  it('keeps a casing anchor for numbering without granting it request restore authority', async () => {
    const plan = makePlan({
      candidateReharvest: {
        contributor: {
          contribute: async () => ({
            ...emptyContribution,
            candidates: [
              { value: 'Alice Ada', kind: 'name' as const },
              { value: 'ALICE ADA', kind: 'name' as const },
            ],
          }),
        },
        getJoinedPieces: () => [],
        hasRegisteredRecall: () => true,
      },
    });
    let shownAlias = '';
    const real: ExecuteChatAiCall = async (_manifest, input) => {
      const packet = JSON.parse(String(input['llm.prompt'])) as {
        recall_context: Array<{ result: string }>;
      };
      shownAlias = packet.recall_context[0]!.result;
      return {
        body: {
          response: `${shownAlias} / pii.Person1`,
          events: [],
          tool_calls: [],
        } satisfies AIOutput,
      };
    };

    const result = await wrapExecuteAiCallForPii(real, plan)(
      MANIFEST,
      {
        'llm.prompt': JSON.stringify({
          recall_context: [{ result: 'ALICE ADA' }],
        }),
      },
    );

    expect(shownAlias).toBe('cap_pii.Person1');
    expect((result.body as AIOutput).response).toBe(
      'ALICE ADA / pii.Person1',
    );
    expect(
      plan.ledger.byKindRealValue.get('name::Alice Ada')?.alias_value,
    ).toBe('pii.Person1');
    expect(
      plan.ledger.byKindRealValue.get('name::ALICE ADA')?.alias_value,
    ).toBe('cap_pii.Person1');
    expect(
      plan.restoreAuthority?.value?.ledger.byKindBaseAlias.has(
        'name::pii.Person1',
      ),
    ).toBe(false);
  });

  it('commits only structured-source mappings whose aliases reached the final packet', async () => {
    const part: EntityPromptPart = {
      source: 'prompt-cache',
      role: 'entity',
      entity: 'contact',
      payload: [{
        name: 'Alice Ada',
        phone: '+14155550100',
      }],
      // The phone is a bounded live protection seed but is not rendered into
      // this request. P1 requires its staged mapping to disappear before commit.
      render: (payload) => String(payload[0]?.name ?? ''),
    };
    const plan = makePlan({
      resolver: (packet) => Array.isArray(packet as unknown)
        ? [
            { path: '0.name', kind: 'name' },
            { path: '0.phone', kind: 'phone' },
          ]
        : [],
    });
    let sent = '';
    const real: ExecuteChatAiCall = async (_manifest, input) => {
      sent = String(input['llm.prompt']);
      return {
        body: { response: 'ok', events: [], tool_calls: [] } satisfies AIOutput,
      };
    };

    await wrapExecuteAiCallForPii(
      real,
      plan,
      undefined,
      [part],
    )(MANIFEST, {
      'llm.prompt': JSON.stringify({ user_message: 'hello' }),
    });

    expect(sent).toContain('pii.Person1');
    expect(sent).not.toContain('+14155550100');
    expect(plan.ledger.byKindRealValue.has('name::Alice Ada')).toBe(true);
    expect(
      plan.ledger.byKindRealValue.has('phone::+14155550100'),
    ).toBe(false);
  });

  it('pre-scans alias-shaped literals inside late-injected structured entity payloads', async () => {
    const plan = makePlan({
      resolver: (packet) => Array.isArray(packet as unknown)
        ? [{ path: '0.name', kind: 'name' }]
        : [],
    });
    expect(
      (piiEgress.aliasPacketForEgress({
        ledger: plan.ledger,
        packet: { owner: 'Pat Lee' },
        resolver: () => [{ path: 'owner', kind: 'name' }],
      }).aliased as { owner: string }).owner,
    ).toBe('pii.Person1');
    const part: EntityPromptPart = {
      source: 'prompt-cache',
      role: 'entity',
      entity: 'contact',
      payload: [{ name: 'pii.Person1' }],
      render: (payload) => String(payload[0]?.name ?? ''),
    };
    let shown = '';
    const real: ExecuteChatAiCall = async (_manifest, input) => {
      const packet = JSON.parse(String(input['llm.prompt'])) as {
        prefetch_context: string[];
      };
      shown = packet.prefetch_context[0] ?? '';
      return {
        body: {
          response: shown,
          events: [],
          tool_calls: [],
        } satisfies AIOutput,
      };
    };

    const result = await wrapExecuteAiCallForPii(
      real,
      plan,
      undefined,
      [part],
    )(MANIFEST, {
      'llm.prompt': JSON.stringify({ user_message: 'hello' }),
    });
    expect(shown).toBe('pii.Person2');
    expect((result.body as AIOutput).response).toBe('pii.Person1');
    expect((result.body as AIOutput).response).not.toBe('Pat Lee');
  });

  it('protects schema paths before candidate key aliasing can rename them', async () => {
    const packet = {
      recall_context: [{ result: { content: 'history' } }],
      prior_tool_calls: [{
        result: {
          'CONTACT-77': { owner: 'new-owner@acme.com' },
        },
      }],
    };
    const plan = makePlan({
      resolver: () => [{
        path: 'prior_tool_calls.0.result.CONTACT-77.owner',
        kind: 'email',
      }],
      candidateReharvest: {
        contributor: {
          contribute: async () => ({
            ...emptyContribution,
            candidates: [{
              value: 'CONTACT-77',
              kind: 'external_id' as const,
            }],
          }),
        },
        getJoinedPieces: () => [],
        hasRegisteredRecall: () => true,
      },
    });
    let sent = '';
    const real: ExecuteChatAiCall = async (_manifest, input) => {
      sent = String(input['llm.prompt']);
      return {
        body: { response: 'ok', events: [], tool_calls: [] } satisfies AIOutput,
      };
    };

    await wrapExecuteAiCallForPii(real, plan)(
      MANIFEST,
      { 'llm.prompt': JSON.stringify(packet) },
    );

    expect(sent).not.toContain('CONTACT-77');
    expect(sent).not.toContain('new-owner@acme.com');
    expect(sent).toContain('pii.Id1');
    expect(sent).toContain('@d1.invalid');
  });

  it('never treats top-level protocol field names as candidate data', async () => {
    const plan = makePlan({
      candidateReharvest: {
        contributor: {
          contribute: async () => ({
            ...emptyContribution,
            candidates: [{
              value: 'user_message',
              kind: 'external_id' as const,
            }],
          }),
        },
        getJoinedPieces: () => [],
        hasRegisteredRecall: () => true,
      },
    });
    let providerPacket: Record<string, unknown> = {};
    const real: ExecuteChatAiCall = async (_manifest, input) => {
      providerPacket = JSON.parse(String(input['llm.prompt'])) as Record<
        string,
        unknown
      >;
      return {
        body: { response: 'ok', events: [], tool_calls: [] } satisfies AIOutput,
      };
    };

    await wrapExecuteAiCallForPii(real, plan)(
      MANIFEST,
      {
        'llm.prompt': JSON.stringify({
          user_message: 'hello',
          recall_context: [{ result: { content: 'history' } }],
        }),
      },
    );

    expect(providerPacket).toHaveProperty('user_message', 'hello');
    expect(Object.keys(providerPacket)).not.toContain('pii.Id1');
    expect(
      plan.ledger.byKindRealValue.has('external_id::user_message'),
    ).toBe(false);
  });

  it.each([
    ['missing', {}],
    ['non-string', { 'llm.prompt': 42 }],
    ['malformed JSON', { 'llm.prompt': '{not-json' }],
    ['primitive JSON', { 'llm.prompt': '"text"' }],
    ['array JSON', { 'llm.prompt': '[]' }],
  ])('fails closed on a %s recall-bearing envelope', async (_name, input) => {
    const real = vi.fn<ExecuteChatAiCall>();
    const plan = makePlan({
      candidateReharvest: {
        contributor: { contribute: async () => emptyContribution },
        getJoinedPieces: () => [],
        hasRegisteredRecall: () => true,
      },
    });

    const failure = wrapExecuteAiCallForPii(real, plan)(MANIFEST, input);
    await expect(failure).rejects.toMatchObject({
      code: 'chat_pii_privacy_failed',
      retryable: false,
    });
    expect(real).not.toHaveBeenCalled();
    expect(plan.ledger.byKindRealValue.size).toBe(0);
  });

  it.each([
    ['missing recall_context', { user_message: 'hello' }],
    ['empty recall_context', { recall_context: [] }],
    ['non-array recall_context', { recall_context: { result: 'history' } }],
    ['primitive recall entry', { recall_context: ['history'] }],
    ['array recall entry', { recall_context: [['history']] }],
  ])('fails closed on %s after the packet pre-scan', async (_name, packet) => {
    const real = vi.fn<ExecuteChatAiCall>();
    const plan = makePlan({
      candidateReharvest: {
        contributor: { contribute: async () => emptyContribution },
        getJoinedPieces: () => [],
        hasRegisteredRecall: () => true,
      },
    });

    await expect(
      wrapExecuteAiCallForPii(real, plan)(
        MANIFEST,
        {
          'llm.system_prompt': 'Do not reinterpret pii.Person1',
          'llm.prompt': JSON.stringify(packet),
        },
      ),
    ).rejects.toBeInstanceOf(ChatPiiPrivacyError);
    expect(real).not.toHaveBeenCalled();
    expect(plan.ledger.byKindRealValue.size).toBe(0);
  });

  it('turns resolver and serialization failures into non-retry privacy failures before provider egress', async () => {
    const real = vi.fn<ExecuteChatAiCall>();
    const recall = {
      contributor: { contribute: async () => emptyContribution },
      getJoinedPieces: () => [],
      hasRegisteredRecall: () => true,
    };
    const resolverFailure = makePlan({
      resolver: () => {
        throw new Error('resolver carried private detail');
      },
      candidateReharvest: recall,
    });
    const validPrompt = JSON.stringify({
      recall_context: [{ result: { content: 'historical evidence' } }],
    });

    await expect(
      wrapExecuteAiCallForPii(real, resolverFailure)(
        MANIFEST,
        { 'llm.prompt': validPrompt },
      ),
    ).rejects.toBeInstanceOf(ChatPiiPrivacyError);

    const serializationFailure = makePlan({
      candidateReharvest: recall,
    });
    await expect(
      wrapExecuteAiCallForPii(real, serializationFailure)(
        MANIFEST,
        {
          'llm.prompt': validPrompt,
          unencodable: 1n,
        },
      ),
    ).rejects.toBeInstanceOf(ChatPiiPrivacyError);
    expect(real).not.toHaveBeenCalled();
    expect(resolverFailure.ledger.byKindRealValue.size).toBe(0);
    expect(serializationFailure.ledger.byKindRealValue.size).toBe(0);
  });

  it('rejects a validator that mutates the protected packet before send', async () => {
    const real = vi.fn<ExecuteChatAiCall>();
    const plan = makePlan({
      candidateReharvest: {
        contributor: { contribute: async () => emptyContribution },
        getJoinedPieces: () => [],
        hasRegisteredRecall: () => true,
      },
    });
    await expect(
      wrapExecuteAiCallForPii(
        real,
        plan,
        undefined,
        undefined,
        (aliasedInput) => {
          delete aliasedInput['llm.prompt'];
        },
      )(
        MANIFEST,
        {
          'llm.prompt': JSON.stringify({
            recall_context: [{ result: { content: 'historical evidence' } }],
          }),
        },
      ),
    ).rejects.toBeInstanceOf(ChatPiiPrivacyError);
    expect(real).not.toHaveBeenCalled();
    expect(plan.ledger.byKindRealValue.size).toBe(0);
  });

  it('publishes tool candidates only after the provider request succeeds', async () => {
    const resolver: piiEgress.FieldPrivacyResolver = () => [
      { path: 'prior_tool_calls.0.result.owner', kind: 'email' },
      { path: 'recall_context.0.result.owner', kind: 'email' },
    ];
    const prompt = JSON.stringify({
      prior_tool_calls: [{ result: { owner: 'tool-owner@acme.com' } }],
      recall_context: [{ result: { owner: 'recall-owner@acme.com' } }],
    });
    const published: unknown[] = [];
    const success: ExecuteChatAiCall = async () => ({
      body: { response: 'done', events: [], tool_calls: [] } satisfies AIOutput,
    });
    await wrapExecuteAiCallForPii(
      success,
      makePlan({ resolver }),
      undefined,
      undefined,
      undefined,
      (candidates) => published.push(candidates),
    )(MANIFEST, { 'llm.prompt': prompt });
    expect(published).toEqual([[
      { value: 'tool-owner@acme.com', kind: 'email' },
    ]]);

    const rejected: unknown[] = [];
    const failure: ExecuteChatAiCall = async () => {
      throw new Error('provider failed');
    };
    await expect(
      wrapExecuteAiCallForPii(
        failure,
        makePlan({ resolver }),
        undefined,
        undefined,
        undefined,
        (candidates) => rejected.push(candidates),
      )(MANIFEST, { 'llm.prompt': prompt }),
    ).rejects.toThrow('provider failed');
    expect(rejected).toEqual([]);
  });

  it('does not swallow a PRIVACY failure raised inside the reharvest block', async () => {
    // ⛔ The catch around the reharvest exists for the CONTRIBUTOR's bounded
    // source reads — "a read miss weakens coverage but cannot make direct
    // protection fail open". Its scope also covers the candidate ALIAS pass, so
    // that pass's own integrity guard was being swallowed. An integrity failure
    // is not a coverage miss: it must keep its fail-closed contract.
    const plan = makePlan({
      candidateReharvest: {
        contributor: {
          contribute: async () => {
            throw new ChatPiiPrivacyError('candidate pass lost a dynamic field');
          },
        },
        getJoinedPieces: () => [joinPiece('history')],
        hasRegisteredRecall: () => true,
      },
    });
    const real: ExecuteChatAiCall = vi.fn(async () => ({
      body: { response: 'sent', events: [], tool_calls: [] } satisfies AIOutput,
    }));
    await expect(
      wrapExecuteAiCallForPii(real, plan)(MANIFEST, {
        'llm.prompt': JSON.stringify({
          user_message: 'Ask Alice Ada',
          recall_context: [{ result: { content: 'Alice Ada said yes' } }],
        }),
      }),
    ).rejects.toBeInstanceOf(ChatPiiPrivacyError);
    // Fail CLOSED — the provider was never called.
    expect(real).not.toHaveBeenCalled();
  });

  it('still swallows an ordinary contributor read failure as additive-only', async () => {
    const plan = makePlan({
      candidateReharvest: {
        contributor: {
          contribute: async () => {
            throw new Error('bounded source read failed');
          },
        },
        getJoinedPieces: () => [joinPiece('history')],
        hasRegisteredRecall: () => true,
      },
    });
    const real: ExecuteChatAiCall = vi.fn(async () => ({
      body: { response: 'sent', events: [], tool_calls: [] } satisfies AIOutput,
    }));
    await expect(
      wrapExecuteAiCallForPii(real, plan)(MANIFEST, {
        'llm.prompt': JSON.stringify({
          user_message: 'Ask Alice Ada',
          recall_context: [{ result: { content: 'Alice Ada said yes' } }],
        }),
      }),
    ).resolves.toBeDefined();
    expect(real).toHaveBeenCalledOnce();
  });

});
