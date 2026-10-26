import { chatSourceCitationsOf, CHAT_SOURCE_CITATION_LIMIT, type ChatSourceCitation, type SituationItem } from '@recued/contracts';
import type { EntityPromptPart } from '@recued/middleware';
import { sourceCitation } from '../chat-source-citations.js';
import { projectionCitationHint } from '../chat-situation-source-citations.js';
import { assetProjectionReadOf } from './asset-projection-provenance.js';

type ProjectionSource = Extract<ChatSourceCitation, { kind: 'asset_projection' }>;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
/** Host registration, not a serialized middleware state key. Only the ordinary
 * owner driver opens this capture. A producer cannot mint authority with an id,
 * a copied record, an entity marker or a source-looking JSON property. */
const turns = new WeakMap<object, SituationPrefetchSourceCapture>();
export interface SituationPrefetchSourceCapture {
  retain(parts: readonly EntityPromptPart[]): readonly EntityPromptPart[];
  describe(item: SituationItem): ReturnType<typeof projectionCitationHint> | undefined;
  observe(prompt: unknown): void;
  sources(): readonly ProjectionSource[];
}
export const situationPrefetchSourceCapture = (state: object | undefined): SituationPrefetchSourceCapture | undefined =>
  state ? turns.get(state) : undefined;

export const registerSituationPrefetchSourceCapture = (state: object): SituationPrefetchSourceCapture => {
  const known = new Map<string, { source: ProjectionSource; details: object }>();
  const retained = new Map<string, ProjectionSource>();
  const exposed = new Map<string, ProjectionSource>();
  const capture: SituationPrefetchSourceCapture = {
    retain(parts) {
      retained.clear();
      return parts.filter(part => {
        if (part.source !== 'situation-prefetch') return true;
        const accepted: ProjectionSource[] = [];
        for (const row of part.payload) {
          if (row.citation_source === undefined) continue;
          const hint = row.citation_source;
          if (!object(hint) || typeof hint.source_ref !== 'string' || !object(row.ref)) return false;
          const record = known.get(hint.source_ref.replace(/^#source\//u, ''));
          if (!record || row.ref.collection !== 'asset' || row.ref.id !== record.source.asset_id
            || JSON.stringify(hint) !== JSON.stringify(projectionCitationHint(record.source, ['/details']))
            || !assetProjectionReadOf(record.details, row.details)) return false;
          accepted.push(record.source);
        }
        for (const source of accepted) retained.set(source.id, source);
        return true;
      });
    },
    describe(item) {
      if (item.ref.collection !== 'asset' || !item.details) return undefined;
      const read = assetProjectionReadOf(item.details, item.details);
      if (!read || read.asset_id !== item.ref.id || read.projection.kind !== 'details') return undefined;
      const source = chatSourceCitationsOf([sourceCitation({ kind: 'asset_projection', asset_id: read.asset_id, projection: read.projection },
        read.name, read.read_version, read.read_at)])[0];
      if (source?.kind !== 'asset_projection' || !known.has(source.id) && known.size >= CHAT_SOURCE_CITATION_LIMIT) return undefined;
      known.set(source.id, { source, details: item.details });
      return projectionCitationHint(source, ['/details']);
    },
    observe(prompt) {
      // Observe the protected main packet only after a successful provider call.
      // A capped/dropped block, ineffective privacy plan or failed call gives
      // no current source. Metadata alone is never authority.
      if (typeof prompt !== 'string') return;
      try {
        const envelope: unknown = JSON.parse(prompt);
        const packet: unknown = object(envelope) && typeof envelope['llm.prompt'] === 'string'
          ? JSON.parse(envelope['llm.prompt']) : envelope;
        if (!object(packet) || typeof packet.user_message !== 'string' || !Array.isArray(packet.prefetch_context)) return;
        for (const block of packet.prefetch_context) {
          if (typeof block !== 'string') continue;
          for (const line of block.split('\n')) {
            let row: unknown; try { row = JSON.parse(line); } catch { continue; }
            if (!object(row) || !object(row.details) || !object(row.citation_source)) continue;
            const hint = row.citation_source;
            if (typeof hint.source_ref !== 'string') continue;
            const source = retained.get(hint.source_ref.replace(/^#source\//u, ''));
            if (source && JSON.stringify(hint) === JSON.stringify(projectionCitationHint(source, ['/details']))) exposed.set(source.id, source);
          }
        }
      } catch { /* Missing or malformed egress cannot invent a source. */ }
    },
    sources: () => [...exposed.values()],
  };
  turns.set(state, capture);
  return capture;
};
