import { chatSourceCitationsOf, type ChatDispatchContext, type ChatDispatchResult, type ChatSourceCitation, type SituationQueryInput } from '@recued/contracts';
import { isNonTerminalToolResult } from './chat-tool-call-context.js';
import { qualificationProjectionMetrics } from './qualification-projection-metrics.js';

// Automatic preparation may return a view that the answer never uses. This
// lifetime-only marker restricts attachment; it grants no source authority and
// never serializes into a packet, tool result or stored history.
const prepared = new WeakSet<object>();
export const rememberProjectionRefresh = (result: ChatDispatchResult): void => { prepared.add(result); };
export const isProjectionRefresh = (result: object): boolean => prepared.has(result);

export const MAX_PROJECTION_REFRESH_READS = 4;
type Projection = Extract<ChatSourceCitation, { kind: 'asset_projection' }>;
const projectionRequest = (source: Projection, time: number): Record<string, unknown> => {
  if (source.projection.kind === 'details') return {
    time, subjects: [{ collection: 'asset', id: source.asset_id }], limit_clusters: 1, limit_items: 8,
  } satisfies SituationQueryInput;
  if (source.projection.kind === 'context') return { context: { root: { ...source.projection.root, asset_id: source.asset_id } } };
  const [group, field] = source.projection.field.split('.');
  return { context: { root: { kind: 'field', asset_id: source.asset_id, group, field } } };
};
export const PROJECTION_REFRESH_GUIDANCE = 'The host checked fresh scoped native evidence for saved views cited by your draft. '
  + 'Use successful current native evidence in prefetch or prior_tool_calls for current saved values, including their exact observation clocks and returned citation Markdown. '
  + 'Earlier brief findings, answers and source handles remain historical; they do not override these fresh reads. '
  + 'A failed, missing, omitted or trimmed refresh does not establish a current value. Recover the required scoped evidence or explain the limitation. '
  + 'Field/details sources attest only their saved views. Context sources attest only their returned bounded relationships, rules and writer state, with their stated limitations. Neither attests a complete asset, original evidence contents, computed situation verdicts or unchecked writer activity. '
  + 'Historical questions can still discuss earlier evidence as historical.';

/** Identities come only from this owner's already-loaded native provenance.
 * Prose/brief text selects a kept handle; it cannot supply an asset ID, field,
 * permission, value or current-source receipt. One read per distinct scope. */
export const projectionRefreshRequests = (
  previous: readonly ChatSourceCitation[],
  tail: readonly { role: string; content: string }[],
  brief: unknown,
  time: number,
): { requests: Array<Record<string, unknown>>; omitted: number } => {
  const latest = [...tail].reverse().find(message => message.role === 'assistant');
  const handles = new Set([latest?.content ?? '', JSON.stringify(brief) ?? '']
    .flatMap(text => [...text.matchAll(/#source\/(src_[a-f0-9]{24})\b/gu)].map(match => match[1]!)));
  const seen = new Set<string>();
  const selected = chatSourceCitationsOf(previous)
    .filter((source): source is Extract<ChatSourceCitation, { kind: 'asset_projection' }> => source.kind === 'asset_projection' && handles.has(source.id))
    .sort((a, b) => b.read_at - a.read_at)
    .filter(source => {
      const key = JSON.stringify([source.asset_id, source.projection]);
      if (seen.has(key)) return false;
      seen.add(key); return true;
    });
  return {
    requests: selected.slice(0, MAX_PROJECTION_REFRESH_READS).map(source => projectionRequest(source, time)),
    omitted: Math.max(0, selected.length - MAX_PROJECTION_REFRESH_READS),
  };
};

const scopeKey = (source: Projection): string => JSON.stringify([source.asset_id, source.projection]);

/** A native field-version reader or bounded details/context query, admitted
 * before and after its read, validates a kept version. No new result or citation
 * is exposed to Chat; changed/unavailable views still need
 * ordinary dispatch. No timestamp substitutes for the exact scoped version. */
export const createProjectionVersionProbe = (deps: {
  query: (args: Record<string, unknown>, ctx: ChatDispatchContext) => Promise<ChatDispatchResult>;
  fieldVersion?: (request: unknown, ctx: ChatDispatchContext) => Promise<string | undefined>;
  admit: (ctx: ChatDispatchContext) => boolean;
  now: () => number;
}) => {
  const record = qualificationProjectionMetrics();
  return async (kept: Projection, ctx: ChatDispatchContext): Promise<boolean> => {
    const source = chatSourceCitationsOf([kept])[0];
    if (source?.kind !== 'asset_projection') return false;
    const reader = source.projection.kind === 'field' && deps.fieldVersion ? 'field_version' : 'query';
    if (!deps.admit(ctx)) { record?.(ctx, source, reader, 'refused', false); return false; }
    try {
      const args = projectionRequest(source, deps.now());
      if (source.projection.kind === 'field' && deps.fieldVersion) {
        const version = await deps.fieldVersion(args.context, ctx);
        const admitted = deps.admit(ctx); const unchanged = admitted && version === source.read_version;
        record?.(ctx, source, reader, admitted ? unchanged ? 'unchanged' : 'refresh_required' : 'refused', version !== undefined);
        return unchanged;
      }
      const result = await deps.query(args, ctx);
      const admitted = deps.admit(ctx);
      const fresh = result.ok && !result.run_failed && !isNonTerminalToolResult(result) ? chatSourceCitationsOf(result.source_citations)
        .filter((candidate): candidate is Projection => candidate.kind === 'asset_projection' && scopeKey(candidate) === scopeKey(source)) : [];
      const unchanged = admitted && fresh.some(candidate => candidate.read_version === source.read_version);
      record?.(ctx, source, reader, admitted ? unchanged ? 'unchanged' : 'refresh_required' : 'refused', fresh.length > 0);
      return unchanged;
    } catch { record?.(ctx, source, reader, 'failed', false); return false; }
  };
};

/** A draft demands evidence by citing a kept source, rather than by containing
 * a guessed intent keyword. Exact scope versions can validate unchanged saved
 * values. Changed/unavailable views must reach a new model packet first. */
export const createProjectionDemand = (previous: readonly ChatSourceCitation[], options: { nativeFacts?: boolean } = {}) => {
  const kept = chatSourceCitationsOf(previous).filter((source): source is Projection => source.kind === 'asset_projection');
  const checked = new Set<string>();
  let reads = 0;
  return {
    // Writes invalidate prior checks, but never replenish the turn's read cap.
    invalidate(): void { checked.clear(); },
    async check(draft: string, current: readonly ChatSourceCitation[],
      read: (args: Record<string, unknown>) => Promise<ChatDispatchResult>, time: number,
      probe?: (source: Projection) => Promise<boolean>): Promise<{ revise: boolean; limited: boolean }> {
      const handles = new Set(draft.match(/#source\/src_[a-f0-9]{24}\b/gu) ?? []);
      const cited = kept.filter(source => handles.has(`#source/${source.id}`)).sort((a, b) =>
        (options.nativeFacts ? Number(b.projection.kind === 'context') - Number(a.projection.kind === 'context') : 0) || b.read_at - a.read_at);
      // A governed graph refresh can also return exact scalar receipts. Read
      // the graph first and use only those actual receipts to validate its
      // other cited inputs, avoiding a redundant field-version probe.
      const observed = [...chatSourceCitationsOf(current)];
      let revise = false;
      for (const source of cited) {
        const key = scopeKey(source);
        if (checked.has(key)) continue;
        checked.add(key);
        let fresh = [...observed].reverse().find((candidate): candidate is Projection =>
          candidate.kind === 'asset_projection' && scopeKey(candidate) === key);
        if (!fresh) {
          if (reads >= MAX_PROJECTION_REFRESH_READS) return { revise: true, limited: true };
          reads++;
          // One bounded scope check may perform a probe then a dispatched
          // refresh. An unchanged probe retains the original read clock.
          const needFacts = options.nativeFacts && source.projection.kind === 'context';
          if (!needFacts && probe && await probe(source)) continue;
          const args = projectionRequest(source, time);
          const result = await read(args); rememberProjectionRefresh(result);
          if (result.ok && !result.run_failed && !isNonTerminalToolResult(result)) observed.push(...chatSourceCitationsOf(result.source_citations));
          // A boolean probe cannot supply native fact options. Recompose even
          // an unchanged graph after the ordinary governed read; scalar probes
          // retain their existing fast path.
          if (needFacts) revise = true;
          fresh = result.ok && !result.run_failed && !isNonTerminalToolResult(result) ? chatSourceCitationsOf(result.source_citations).find((candidate): candidate is Projection =>
            candidate.kind === 'asset_projection' && scopeKey(candidate) === key) : undefined;
        }
        // A version covers the returned saved values, not a new read clock.
        // Recompose any draft that spells out the earlier read time as well.
        if (!fresh || fresh.read_version !== source.read_version
          || fresh.read_at !== source.read_at && draft.includes(String(source.read_at))) revise = true;
      }
      return { revise, limited: false };
    },
  };
};
