import {
  composeHousekeepingLlmCallables as composeWireHousekeepingLlmCallables,
  type HousekeepingLlmCallables,
  type LlmSubstrate,
} from '../composition/bin/wire-llm-substrate.js';

export type HousekeepingLlmCallableSubstrate = Pick<
  LlmSubstrate,
  | 'llmManager'
  | 'llmConfig'
  | 'resolveLlmConfig'
  | 'llmQuota'
  | 'llmAdapterRegistry'
  | 'llmEmbeddingsAdapterRegistry'
  | 'llmTranscriptionAdapterRegistry'
  | 'emptyTabProbe'
>;

export interface ComposeHousekeepingLlmCallablesOptions {
  readonly substrate: HousekeepingLlmCallableSubstrate;
}

export type { HousekeepingLlmCallables };

export const composeHousekeepingLlmCallables = (
  options: ComposeHousekeepingLlmCallablesOptions,
): HousekeepingLlmCallables =>
  composeWireHousekeepingLlmCallables({ substrate: options.substrate });
