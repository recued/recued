import type { Middleware, TurnContext } from '@recued/middleware';
import type { SituationItem } from '@recued/contracts';
import type { SituationAccess } from './access.js';
import { situationModelProjection } from './model-projection.js';

export const SITUATION_PREFETCH_MIDDLEWARE_ID = 'situation-prefetch';
export const SITUATION_PREFETCH_BUDGET_MS = 125;
export const SITUATION_PREFETCH_MAX_BYTES = 6000;
const stripMarkers = (value: unknown): unknown => Array.isArray(value) ? value.map(stripMarkers)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== '__entity').map(([key, item]) => [key, stripMarkers(item)])) : value;
/** What a capped block leaves out, as the tool's `omitted` and `partial` say it:
 * a model given a block stops looking (D-167), so three rows of seven would
 * otherwise read as all seven. */
const coverage = (shown: number, matched: number, partial: boolean): string => {
  const missing = matched - shown;
  return (missing > 0 ? `Shown here: ${shown} of the ${matched} matching items on file. ${missing} ${missing === 1 ? 'is' : 'are'} not listed.\n` : '')
    + (partial ? 'Some sources were too large to search in full, so more may match.\n' : '');
};
export const renderSituationPrefetch = (payload: readonly Record<string, unknown>[], matched: number, partial: boolean): string => {
  if (!payload.length) return '';
  const header = 'Matching situations already on file, with values and source references. Reasons and verdicts explain relevance; set aside matches irrelevant to the request. '
    + 'An ambiguous name has several records: ask which one before acting. Unknown is not outside.\n';
  const lines: string[] = []; const sizes: number[] = []; let bytes = Buffer.byteLength(header, 'utf8');
  for (const row of payload) {
    const line = JSON.stringify(stripMarkers(row)); const size = Buffer.byteLength(line, 'utf8') + 1;
    if (bytes + size > SITUATION_PREFETCH_MAX_BYTES) continue;
    lines.push(line); sizes.push(size); bytes += size;
  }
  // The coverage line counts against the cap: a row gives way to it and is counted.
  let note = coverage(lines.length, matched, partial);
  while (lines.length && bytes + Buffer.byteLength(note, 'utf8') > SITUATION_PREFETCH_MAX_BYTES) {
    lines.pop(); bytes -= sizes.pop()!; note = coverage(lines.length, matched, partial);
  }
  return lines.length ? header + note + lines.join('\n') : '';
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
    let outcome = 'miss'; let hits = 0; let matchedTotal = 0;
    try {
      const timeout = new Promise<null>(resolve => { timer = setTimeout(() => { controller.abort(); resolve(null); }, budget); });
      const result = await Promise.race([access.prefetch(message, ctx.source, controller.signal), timeout]);
      if (!result || controller.signal.aborted || performance.now() - started > budget) { outcome = 'timeout'; return; }
      const projected = situationModelProjection(result);
      // Everything the message matched, shown or not; the rows below are at most three of it.
      const matched = result.omitted + result.clusters.reduce((sum, cluster) => sum + cluster.items.length, 0);
      const partial = Boolean(result.partial?.length);
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
      hits = payload.length; matchedTotal = matched; outcome = 'hit';
      ctx.prompt.contribute({ role: 'entity', entity: 'situation_item', payload, render: rows => {
        const block = renderSituationPrefetch(rows, matched, partial);
        if (block) measure?.('prefetch.egress_bytes', Buffer.byteLength(block, 'utf8'), { outcome: 'injected' });
        return block;
      } });
    } catch { outcome = controller.signal.aborted ? 'timeout' : 'withheld'; }
    finally {
      if (timer) clearTimeout(timer);
      controller.abort();
      measure?.('prefetch.lookup_ms', performance.now() - started, { outcome });
      if (hits) {
        measure?.('prefetch.shown_items', hits, { outcome });
        measure?.('prefetch.matched_items', matchedTotal, { outcome });
      }
    }
  },
});
