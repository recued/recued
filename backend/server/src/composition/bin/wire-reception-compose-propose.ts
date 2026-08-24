/** D-151 P2 — production substrate for `reception.compose.propose`.
 *
 *  Binds the D-145 `ai.synthesize` primitive to the server LLM
 *  substrate, then hands a primitive registry to the reception RPC
 *  handler. The registry's memory/enrichment/data adapters are
 *  deliberate zero-row consults; only `ai.synthesize` reaches the
 *  LLM layer. */

import { executeLLM, type ForceLayer, type LLMMatchResolved, type MatchContextHook, type TokenUsage } from '@recued/llm';
import type { IngredientManifest, ModelHint } from '@recued/contracts';
import type { ExecuteRecuedRequestContext } from '@recued/middleware/orchestrator/index.js';
import type { AISynthesizeAdapter, AIPoolPolicy } from '@recued/middleware/primitives/ai-synthesize.js';
import type { CapacitySpecPrimitiveDeps } from '@recued/middleware/primitives/index.js';
import {
  createReceptionComposePrimitiveRegistry,
  type ReceptionComposeProposeDeps,
} from '../../reception-rpc-handler.js';
import type { LlmSubstrate } from './wire-llm-substrate.js';

export interface ComposeReceptionComposeProposeDeps {
  readonly llmConfig: LlmSubstrate['llmConfig'];
  readonly llmQuota: LlmSubstrate['llmQuota'] | undefined;
  readonly llmAdapterRegistry: LlmSubstrate['llmAdapterRegistry'] | undefined;
  readonly emptyTabProbe: LlmSubstrate['emptyTabProbe'] | undefined;
  /** D-250 § D — the owner's daily token counter.
   *
   *  ⛔ THIS SURFACE REACHED NOTHING AT ALL. It was the last provider call that
   *  fed neither a counter nor a record: the hook captured usage into a local,
   *  read `model_id` off it, returned `total_tokens` to the caller, and dropped
   *  the rest. Endpoint authoring is discretionary owner spend, so the counter
   *  is where it belongs. */
  readonly addOwnerTokenUsage?: (tokens: number) => void;
  readonly capacitySpecDeps?: CapacitySpecPrimitiveDeps;
  readonly persist?: ExecuteRecuedRequestContext['persist'];
  readonly now?: () => number;
}

const COMPOSE_PROPOSE_MANIFEST: IngredientManifest = {
  slug: 'compose-endpoint-proposal',
  name: 'Compose endpoint proposal',
  description: 'Generate a D-151 ProposedEndpointConfig from a Compose intent packet.',
  author: 'recued',
  kind: 'ai',
  category: 'ai',
  risk_tier: 'read',
  input: {
    'llm.requires': {
      speed: 'fast',
      output_format: 'json',
      allow_downgrade: true,
    },
  },
  output: { result: 'body' },
};

const tierToModelHint = (tier: 'fast' | 'mid' | 'reasoning'): ModelHint => {
  if (tier === 'reasoning') return 'thinking';
  if (tier === 'mid') return 'quality';
  return 'fast';
};

const poolPolicyToForceLayer = (policy: AIPoolPolicy): ForceLayer => {
  switch (policy) {
    case 'free_only':
    case 'free_then_byok':
      return 'free';
    case 'byok_only':
      return 'byok';
  }
};

const COMPOSE_PROPOSE_SYSTEM_PROMPT = [
  'You generate a single JSON object for Recued Compose.',
  'Return only a ProposedEndpointConfig object with version 1.0.0.',
  'Allowed intent-first kinds are reception_page, scheduling_link, and intake_form.',
  'Do not propose status_link, drop_link, approval_link, or contracted_bilateral exposure.',
  'Do not add phone, address, birthday, employer, income, payment, password, government ID, SSN, or tax fields.',
  'Use source_path "intent" and include a redacted ai_trace_redacted object with derived slots only.',
].join('\n');

export const composeReceptionComposePropose = (
  deps: ComposeReceptionComposeProposeDeps,
): ReceptionComposeProposeDeps | undefined => {
  const { llmConfig, llmQuota, llmAdapterRegistry, emptyTabProbe } = deps;
  if (!llmConfig || !llmQuota || !llmAdapterRegistry || !emptyTabProbe) {
    return undefined;
  }

  const adapter: AISynthesizeAdapter = {
    async synthesize(request) {
      const modelHint = tierToModelHint(request.tier);
      const forceLayer = poolPolicyToForceLayer(request.pool_policy);
      let usage: TokenUsage | undefined;
      let match: LLMMatchResolved | undefined;
      // D-191 — force-local retired; the synthesize call keeps its
      // pool-policy-derived `forceLayer` (free vs BYOK), nothing more.
      const matchContext: MatchContextHook = () => ({ forceLayer });
      const body = await executeLLM(
        COMPOSE_PROPOSE_MANIFEST,
        {
          'llm.instruction_block': COMPOSE_PROPOSE_SYSTEM_PROMPT,
          'llm.data_block': {
            packet: request.packet,
            max_tokens: request.max_tokens,
          },
          'llm.output_format': 'json',
          'llm.model_hint': modelHint,
          'llm.allow_downgrade': true,
        },
        {
          config: llmConfig,
          adapters: llmAdapterRegistry,
          quota: llmQuota,
          tabProbe: emptyTabProbe,
          webChatSupported: false,
          matchContext,
          onTokenUsage: (u) => {
            usage = u;
            // D-250 § D — the same result also advances the owner's daily
            // counter. Previously this assignment was the ONLY thing that
            // happened to it.
            deps.addOwnerTokenUsage?.(u.total_tokens);
          },
          onMatchResolved: (evt) => {
            match = evt;
          },
        },
      );
      const provider = match?.winner.slot.provider ?? 'unknown';
      const model_id = usage?.model_id ?? match?.winner.slot.model ?? 'unknown';
      return {
        response: typeof body === 'string' ? body : JSON.stringify(body ?? null),
        events: [
          {
            kind: 'compose.llm_match',
            payload: { provider, model_id },
          },
        ],
        provider,
        model_id,
        ...(usage?.total_tokens !== undefined ? { total_tokens: usage.total_tokens } : {}),
      };
    },
  };

  const registry = deps.capacitySpecDeps
    ? createReceptionComposePrimitiveRegistry(adapter, { capacitySpecDeps: deps.capacitySpecDeps })
    : createReceptionComposePrimitiveRegistry(adapter);

  return {
    // Compose proposal is a preview-only endpoint-authoring call: its
    // policy deliberately skips `capacity_spec` and performs only the
    // zero-row context consults plus `ai.synthesize`. The registry
    // helper's default capacity bundle is fail-closed for accidental
    // capacity invocations; callers that enforce capacity pass real deps
    // through `capacitySpecDeps`.
    registry,
    ...(deps.persist ? { persist: deps.persist } : {}),
    ...(deps.now ? { now: deps.now } : {}),
    defaultAiProvider: 'compose',
    defaultAiModelId: 'compose-endpoint-proposal',
  };
};
