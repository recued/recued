/** LLM provider registry — one entry per supported provider tying its
 *  chat + embeddings adapters together.
 *
 *  Before this registry, the chat adapter list and the embeddings
 *  adapter list were hard-coded in two parallel central files
 *  (`adapters/index.ts` + `embeddings/adapters/index.ts`). Adding a
 *  fifth provider (Cohere, Bedrock, …) meant editing both files plus
 *  the `LLMProvider` union. The two lists could drift — a provider
 *  could ship chat support without anyone realising embeddings was
 *  missing, or vice versa.
 *
 *  The registry inverts that. Each provider declares a single
 *  `LlmProviderEntry` carrying both surface factories; the two default-
 *  registry factories iterate this one list. Adding a provider becomes:
 *
 *    1. Widen `LLMProvider` (and therefore `AdapterKey`) in `../types.ts`
 *       if the provider id is new.
 *    2. New `providers/<slug>.ts` exporting `<slug>ProviderEntry` —
 *       includes whichever of `buildChatAdapter` / `buildEmbeddingsAdapter`
 *       the provider supports (declaring neither is allowed but useless).
 *    3. One entry appended to `LLM_PROVIDER_REGISTRY` below.
 *
 *  `createDefaultRegistry` + `createDefaultEmbeddingsRegistry` need
 *  no change — they iterate the registry without name-checking
 *  providers.
 *
 *  Static imports — the per-provider entry files are tiny (each is a
 *  thin facade around the existing per-adapter factories that already
 *  live in `adapters/<slug>.ts` and `embeddings/adapters/<slug>.ts`).
 *  No defensible reason to defer their import: every consumer of this
 *  package today calls one of the default-registry factories at boot. */

import type { AdapterKey, LLMAdapter } from '../types.js';
import type { EmbeddingsAdapter } from '../embeddings/types.js';
import { anthropicProviderEntry } from './anthropic.js';
import { openaiProviderEntry } from './openai.js';
import { openaiCompatibleProviderEntry } from './openai-compatible.js';
import { googleProviderEntry } from './google.js';

/** Runtime deps the chat-adapter factory may consult. */
export interface ChatAdapterBuildDeps {
  webChatBridge?: unknown;
}

/** Per-provider boot entry — provider id + the chat/embeddings factory
 *  pair.
 *
 *  - `provider` is the adapter-registry key.
 *  - `buildChatAdapter` — receives `ChatAdapterBuildDeps`. Returning
 *    `undefined` means "this provider isn't reachable in the current
 *    runtime" — the registry omits the key entirely so the lookup
 *    falls through to `AI_LLM_UNAVAILABLE` exactly as if the provider
 *    didn't exist. Absent field → no chat surface (e.g. an embeddings-
 *    only provider would set it to `undefined`).
 *  - `buildEmbeddingsAdapter` — takes no deps today. Returns the
 *    `EmbeddingsAdapter` instance directly. Absent field → no
 *    embeddings surface. Anthropic's embeddings
 *    factory is a stub that throws AI_LLM_UNAVAILABLE at call time
 *    (no public Anthropic embeddings model); that's still considered
 *    "registered" so the resolver's provider-availability probe can
 *    report it explicitly. */
export interface LlmProviderEntry {
  provider: AdapterKey;
  buildChatAdapter?: (deps: ChatAdapterBuildDeps) => LLMAdapter | undefined;
  buildEmbeddingsAdapter?: () => EmbeddingsAdapter;
}

/** The canonical provider list. Order matters only for deterministic iteration logs — registry
 *  lookups are by `provider` key, not by index. */
export const LLM_PROVIDER_REGISTRY: ReadonlyArray<LlmProviderEntry> = [
  anthropicProviderEntry,
  openaiProviderEntry,
  openaiCompatibleProviderEntry,
  googleProviderEntry,
];
