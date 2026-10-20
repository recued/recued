import type { Middleware, TurnContext } from '@recued/middleware';
import type { SituationItem } from '@recued/contracts';
import type { SituationAccess } from './access.js';
import { situationModelProjection } from './model-projection.js';

export const SITUATION_PREFETCH_MIDDLEWARE_ID = 'situation-prefetch';
export const SITUATION_PREFETCH_BUDGET_MS = 125;
export const SITUATION_PREFETCH_MAX_BYTES = 6000;
const stripMarkers = (value: unknown): unknown => Array.isArray(value) ? value.map(stripMarkers)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== '__entity').map(([key, item]) => [key, stripMarkers(item)])) : value;
const render = (payload: readonly Record<string, unknown>[]): string => {
  if (!payload.length) return '';
  const header = 'Matching situations already on file, with values and source references. Reasons and verdicts explain relevance; set aside matches irrelevant to the request. '
    + 'An ambiguous name has several records: ask which one before acting. Unknown is not outside.\n';
  const lines: string[] = []; let bytes = Buffer.byteLength(header, 'utf8');
  for (const row of payload) {
    const line = JSON.stringify(stripMarkers(row)); const size = Buffer.byteLength(line, 'utf8') + 1;
    if (bytes + size > SITUATION_PREFETCH_MAX_BYTES) continue;
    lines.push(line); bytes += size;
  }
  return lines.length ? header + lines.join('\n') : '';
};
export const createSituationPrefetch = (deps: {
  getAccess: () => SituationAccess | undefined;
  measure?: (name: string, value: number, labels: Record<string, string>) => void;
  budget_ms?: number;
}): Middleware => ({
  id: SITUATION_PREFETCH_MIDDLEWARE_ID,
  async prompt(ctx: TurnContext): Promise<void> {
    if (ctx.source?.channel !== 'chat') return;
    const access = deps.getAccess(); if (!access) return;
    const measure = deps.measure ?? access.measure;
    const message = [...ctx.history].reverse().find(entry => entry.role === 'user')?.text;
    if (!message?.trim()) return;
    const controller = new AbortController();
    const started = performance.now();
    const budget = Math.max(1, Math.min(250, deps.budget_ms ?? SITUATION_PREFETCH_BUDGET_MS));
    let timer: ReturnType<typeof setTimeout> | undefined;
    let outcome = 'miss'; let hits = 0;
    try {
      const timeout = new Promise<null>(resolve => { timer = setTimeout(() => { controller.abort(); resolve(null); }, budget); });
      const result = await Promise.race([access.prefetch(message, ctx.source, controller.signal), timeout]);
      if (!result || controller.signal.aborted || performance.now() - started > budget) { outcome = 'timeout'; return; }
      const projected = situationModelProjection(result);
      const ambiguous = new Set(result.ambiguous.flatMap(entry => entry.choices.map(ref => JSON.stringify([ref.collection, ref.id]))));
      const payload: Record<string, unknown>[] = [];
      for (const cluster of projected.clusters) for (const item of cluster.items) {
        if (payload.length >= 3) break;
        const row: SituationItem & { cluster_id: string; ambiguous?: boolean } = { ...item, cluster_id: cluster.id,
          what: { ...item.what, value: item.what.value?.slice(0, 240) ?? null },
          evidence: item.evidence.slice(0, 3),
          ...(ambiguous.has(JSON.stringify([item.ref.collection, item.ref.id])) ? { ambiguous: true } : {}),
        };
        const next = [...payload, row];
        if (Buffer.byteLength(JSON.stringify(next), 'utf8') > SITUATION_PREFETCH_MAX_BYTES) continue;
        payload.push(row as unknown as Record<string, unknown>);
      }
      if (!payload.length) return;
      hits = payload.length; outcome = 'hit';
      ctx.prompt.contribute({ role: 'entity', entity: 'situation_item', payload, render: rows => {
        const block = render(rows);
        if (block) measure?.('prefetch.egress_bytes', Buffer.byteLength(block, 'utf8'), { outcome: 'injected' });
        return block;
      } });
    } catch { outcome = controller.signal.aborted ? 'timeout' : 'withheld'; }
    finally {
      if (timer) clearTimeout(timer);
      controller.abort();
      measure?.('prefetch.lookup_ms', performance.now() - started, { outcome });
      if (hits) measure?.('prefetch.matched_items', hits, { outcome });
    }
  },
});
