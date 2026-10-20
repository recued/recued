import type { IngredientManifest, SituationCluster } from '@recued/contracts';
import type { ExecuteChatAiCall } from '../chat-orchestrator.js';
import { situationModelProjection } from './model-projection.js';

const manifest: IngredientManifest = { slug: 'situation-summary', name: 'Situation highlight', description: 'Select a highlight from a granted cluster; runtime only.',
  author: 'recued', kind: 'ai', category: 'ai', risk_tier: 'read', version: 1,
  input: { 'llm.system_prompt': null, 'llm.prompt': null, 'llm.output_format': 'json' }, output: { result: 'body' } };
/** The optional model chooses one supplied value. Its prose never becomes an
 * asserted fact: the highlight is rendered from the selected source record. */
export const createClusterSummary = (deps: { call: ExecuteChatAiCall; ready: () => 'any' | 'free' | undefined }) =>
  async (cluster: SituationCluster, authorize?: () => boolean): Promise<string | undefined> => {
    const layer = deps.ready(); if (!layer || !cluster.items.length) return undefined;
    if (authorize?.() === false) return undefined;
    const projected = situationModelProjection({ clusters: [{ ...cluster, omitted: 0 }], omitted: 0, ambiguous: [] });
    const output = await deps.call(manifest, {
      'llm.system_prompt': 'Choose the one supplied item most useful for the owner to notice. Return only JSON {"highlight_position":0}, using its zero-based position. Do not write prose or introduce facts. An unknown verdict is not a mismatch.',
      'llm.prompt': JSON.stringify({ user_message: 'Which supplied item should lead this overview?', prior_tool_calls: [{ tool_name: 'situation.query', result: projected }] }),
      'llm.output_format': 'json', 'llm.force_layer': layer,
    }, { timeout_ms: 3000, before_provider_call: () => { if (authorize?.() === false) throw new Error('Situation permissions changed before the model call'); } });
    let body = output.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch { return undefined; } }
    const position = body && typeof body === 'object' ? (body as Record<string, unknown>).highlight_position : undefined;
    if (!Number.isInteger(position) || typeof position !== 'number' || position < 0 || position >= cluster.items.length) return undefined;
    return `First: ${cluster.items[position]!.what.value}`;
  };
