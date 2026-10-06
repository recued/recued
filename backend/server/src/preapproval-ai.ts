/** AI is one parent invocation with its required reads in the common graph. */
import type Database from 'better-sqlite3';
import { RpcError, isBatchCapableAISlug, parsePreapprovalJson } from '@recued/contracts';
import { buildLLMCompletionRequest, createQuotaTracker, describeInitialLLMProviderRequest, describeLLMAvailability, describeLLMMatch,
  isEmbeddingsManifest, matchLLM, prepareLLMInput } from '@recued/llm';
import { resolveDispatchSlot } from '@recued/ingredients';
import type { PreapprovalCall, PreapprovalRuntimeIdentity } from './preapproval-dispatch-description.js';
import type { createPreapprovalMail, PreapprovalDomainContext } from './preapproval-mail.js';
import { extractFileRecordId, extractTempFileRef, fileToContentPart, type ServerExecutorConfig } from './server-executor.js';
import { describeAiProviderRequest, llmSourceMaterial, readReviewedAiSnapshot, reviewedAiMediaMarker } from './preapproval-ai-description.js';
import { initializePreapprovalLifecycle, synchronizePreapprovalIdentity } from './storage/preapproval-lifecycle.js';
import { preapprovalPathKey } from './preapproval-invocations.js';
import type { FileContentSnapshot } from './collections/file/file-snapshot.js';
import type { PreapprovalDependency } from './preapproval-model.js';

const fail = (message: string): never => { throw new RpcError('preapproval_unresolved', message, 409); };
export const createPreapprovalAi = (deps: { db: Database.Database; executor: ServerExecutorConfig;
  files?: ReturnType<typeof createPreapprovalMail> }) => {
  initializePreapprovalLifecycle(deps.db);
  return (call: PreapprovalCall, context: PreapprovalDomainContext): PreapprovalRuntimeIdentity | null => {
    if (call.catalog || resolveDispatchSlot(call.manifest) !== 'ai') return null;
    if (isEmbeddingsManifest(call.manifest)) return fail('This embeddings dispatcher requires its own frozen request description.');
    const config = deps.executor.resolveLlmConfig?.() ?? deps.executor.llmConfig;
    if (!config) return fail('Configure a model before requesting review.');
    let input: Record<string, unknown> = call.input;
    const children: PreapprovalRuntimeIdentity['children'] = [];
    let file: FileContentSnapshot | undefined;
    if (isBatchCapableAISlug(call.slug) && input['llm.content_parts'] === undefined) {
      if (extractTempFileRef(input['llm.data'])) return fail('Save this temporary AI input before requesting review.');
      const record = extractFileRecordId(input['llm.data']);
      if (record) {
        if (!deps.files) return fail('The required file-read dispatcher is unavailable.');
        const described = deps.files.fileChild(call, context, 'ai_input', 0, record);
        children.push(described.child); file = described.snapshot.file;
        const part = fileToContentPart({ mime_type: file.mime_type, bytes_b64: reviewedAiMediaMarker(file) });
        input = { ...input, 'llm.data': `[${part.type}: ${file.filename}]`, 'llm.content_parts': [part] };
      }
    }
    // The executor's own known-value matcher: the request reviewed here must be
    // the one `executeLLM` builds, alias for alias (`beforeAiProvider` compares).
    const prepared = prepareLLMInput(call.manifest, input, deps.executor.piiKnownValues);
    if (prepared.empty) return fail('This empty AI batch has no future provider operation to approve.');
    const existing = context.plan?.members.find(member => preapprovalPathKey(member.invocation_path) === preapprovalPathKey(call.path));
    const expected = readReviewedAiSnapshot(existing?.dispatch_snapshot);
    const matchDeps = { config, quota: deps.executor.llmQuota ?? createQuotaTracker(),
      tabProbe: deps.executor.llmTabProbe ?? (async () => new Set<never>()),
      ...(expected ? { matchContext: () => ({ pinSlot: expected.slot }) } : {}) };
    const { requires, forceLayer, pinSlot, allowUpgrade, strategy } = describeLLMMatch(call.manifest, prepared.input, matchDeps);
    const match = matchLLM({ requires, forceLayer, allowUpgrade, ...(pinSlot ? { pinSlot } : {}),
      ...(prepared.requireModalities ? { requireModalities: prepared.requireModalities } : {}) },
    { ...matchDeps, availability: describeLLMAvailability(matchDeps), strategy, rejectSet: new Set() });
    if (match.source.kind !== 'slot') return fail('Choose a configured model slot for this reviewed execution.');
    const slotKey = match.source.slot_key;
    const identity = synchronizePreapprovalIdentity(deps.db, 'llm_source', slotKey, llmSourceMaterial(config[slotKey]));
    if (!identity) return fail('The reviewed model source is unavailable.');
    const pin: PreapprovalDependency = { kind: identity.kind, key: identity.key, incarnation: identity.incarnation,
      revision: identity.revision, content_hash: identity.content_hash, until_phase: 'terminal' };
    const completion = buildLLMCompletionRequest(call.manifest, prepared, match);
    const request = describeAiProviderRequest({ match, ...describeInitialLLMProviderRequest(match.slot, completion.messages, completion.options) }, file);
    const snapshot = parsePreapprovalJson({ kind: 'ai_request', version: 1, slot: slotKey, request });
    return { family: 'ai', binding: parsePreapprovalJson({ source: pin, request }), dispatch_snapshot: snapshot,
      connection_id: identity.incarnation, account_id: `${slotKey}:${match.slot.provider}`,
      // The exact model-bound prompt is review material. Runtime matching uses
      // the same pure builders and keeps the original engine arguments private.
      normalized_input: { ...call.input, reviewed_request: request },
      resources: [pin], dependencies: [pin], children, child_inventory: { complete: true }, nested_recipe: null,
      label: `${call.manifest.name}: ${match.slot.model}`, detail: `${match.slot.provider} · ${slotKey} · ${match.slot.base_url ?? 'Provider default endpoint'}` };
  };
};
