import type { Middleware, TurnContext } from '@recued/middleware';
import { SITUATION_CONTEXT_MAX_BYTES, type SituationItem } from '@recued/contracts';
import type { SituationAccess } from './access.js';
import { situationItemForModel } from './model-projection.js';
import { ASSET_PROJECTION_CITATION_GUIDANCE } from '../chat-source-citations.js';
import { situationPrefetchSourceCapture } from './prefetch-source-citations.js';
import { situationText } from './query.js';

export const SITUATION_PREFETCH_MIDDLEWARE_ID = 'situation-prefetch';
/** A guard against a lookup that never ends, not a latency target: a missed lookup
 * leaves the model to look the same thing up with a tool, which takes longer than
 * the wait. Before occasions were indexed, a large warehouse missed the old 125 ms
 * on every turn at background priority (about 420 ms; 90 ms at normal priority). */
export const SITUATION_PREFETCH_BUDGET_MS = 2_000;
export const SITUATION_PREFETCH_MAX_BYTES = SITUATION_CONTEXT_MAX_BYTES;
const stripMarkers = (value: unknown): unknown => Array.isArray(value) ? value.map(stripMarkers)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== '__entity').map(([key, item]) => [key, stripMarkers(item)])) : value;
type PrefetchRow = SituationItem & { cluster_id: string; ambiguous?: boolean; citation_source?: Record<string, unknown> } & Record<string, unknown>;
/** An asset's details give way before its item does: first to the names of
 * what they held, then entirely. A row is never dropped for its details. */
const leaner = (row: PrefetchRow): PrefetchRow[] => {
  if (!row.details) return [row];
  const { details, ...bare } = row;
  const held = (['dates', 'readings', 'settings', 'attributes'] as const).filter(group => details[group] !== undefined);
  return [row, { ...bare, details: { ...(details.class_id ? { class_id: details.class_id } : {}), status: details.status,
    ...(held.length ? { left_out: held } : {}) } }, bare];
};
/** What a capped block leaves out, as the tool's `omitted` and `partial` say it:
 * a model given a block stops looking (D-167), so three rows of seven would
 * otherwise read as all seven. It names the tool since the tool stopped capping:
 * a trip for a family of eight lists every passport there, where the block shows three. */
const coverage = (shown: number, matched: number, partial: boolean): string => {
  const missing = matched - shown;
  return (missing > 0 ? `Shown here: ${shown} of the ${matched} matching items on file. ${missing} ${missing === 1 ? 'is' : 'are'} not listed; situation.query returns every match.\n` : '')
    + (partial ? 'Some sources were too large to search in full, so more may match.\n' : '');
};
const PREFETCH_HEADER = 'Matching situations already on file, with values and source references. Reasons and verdicts explain relevance; set aside matches irrelevant to the request. '
  + 'An ambiguous name has several records: ask which one before acting. Unknown is not outside. '
  + 'A record’s holder does not identify the speaker. Apply personal travel-document constraints only when the traveller is established by the request or supplied context; otherwise ask who is travelling.\n';
const headerFor = (rows: readonly Record<string, unknown>[]): string => PREFETCH_HEADER
  + (rows.some(row => row.citation_source) ? 'The citation_source in each JSON row covers only /details in that row. '
    + ASSET_PROJECTION_CITATION_GUIDANCE + '\n' : '');
const lineOf = (row: unknown): string => JSON.stringify(stripMarkers(row));
/** The bytes of a block showing every one of `rows`, counted as the renderer counts them. */
const blockBytes = (rows: readonly Record<string, unknown>[], matched: number, partial: boolean): number =>
  Buffer.byteLength(headerFor(rows) + coverage(rows.length, matched, partial), 'utf8')
  + rows.reduce<number>((sum, row) => sum + Buffer.byteLength(lineOf(row), 'utf8') + 1, 0);
export const renderSituationPrefetch = (payload: readonly Record<string, unknown>[], matched: number, partial: boolean): string => {
  if (!payload.length) return '';
  // Keep the original data selection before spending bytes on source metadata.
  // Aliases can expand: repeat the calculation on the actual protected rows.
  const kept: Array<{ row: Record<string, unknown>; source: unknown }> = [];
  let bytes = Buffer.byteLength(PREFETCH_HEADER, 'utf8');
  for (const original of payload) {
    const { citation_source: source, ...row } = original;
    const size = Buffer.byteLength(lineOf(row), 'utf8') + 1;
    if (bytes + size > SITUATION_PREFETCH_MAX_BYTES) continue;
    kept.push({ row, source }); bytes += size;
  }
  while (kept.length && bytes + Buffer.byteLength(coverage(kept.length, matched, partial), 'utf8') > SITUATION_PREFETCH_MAX_BYTES) {
    bytes -= Buffer.byteLength(lineOf(kept.pop()!.row), 'utf8') + 1;
  }
  const rows = kept.map(entry => entry.row);
  for (const [index, entry] of kept.entries()) {
    if (!entry.source) continue;
    const enriched = { ...entry.row, citation_source: entry.source };
    const candidate = rows.map((row, position) => position === index ? enriched : row);
    if (blockBytes(candidate, matched, partial) <= SITUATION_PREFETCH_MAX_BYTES) rows[index] = enriched;
  }
  return rows.length ? headerFor(rows) + coverage(rows.length, matched, partial) + rows.map(lineOf).join('\n') : '';
};
export const createSituationPrefetch = (deps: {
  getAccess: () => SituationAccess | undefined;
  /** A contact's name by an id an item's `who` carries (`situationPersonName`). */
  personName?: (id: string) => string | undefined;
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
    const budget = Math.max(1, Math.min(SITUATION_PREFETCH_BUDGET_MS, deps.budget_ms ?? SITUATION_PREFETCH_BUDGET_MS));
    let timer: ReturnType<typeof setTimeout> | undefined;
    let outcome = 'miss'; let hits = 0; let matchedTotal = 0;
    try {
      const timeout = new Promise<null>(resolve => { timer = setTimeout(() => { controller.abort(); resolve(null); }, budget); });
      const capture = situationPrefetchSourceCapture(ctx.state);
      const result = await Promise.race([access.prefetch(message, ctx.source, controller.signal, Boolean(capture)), timeout]);
      if (!result || controller.signal.aborted || performance.now() - started > budget) { outcome = 'timeout'; return; }
      // Everything the message matched, shown or not; the rows below are at most three of it.
      const matched = result.omitted + result.clusters.reduce((sum, cluster) => sum + cluster.items.length, 0);
      const partial = Boolean(result.partial?.length);
      const ambiguous = new Set(result.ambiguous.flatMap(entry => entry.choices.map(ref => JSON.stringify([ref.collection, ref.id]))));
      const payload: Record<string, unknown>[] = [];
      // Keep the query's consequence/person/name priorities across groups, too.
      // Round-robin only inside each tier: weaker keyword hits must not push a
      // literal name or a named person's second item out of the three-row block.
      const text = situationText({ text: message, surface: 'prefetch' });
      const queues = result.clusters.map(cluster => cluster.items.map(item => ({ cluster_id: cluster.id, floor: item.consequence === 'floor',
        person: ['match', 'near'].includes(item.who.verdict), direct: text.title(item.what.value ?? ''),
        item: situationItemForModel(item, deps.personName) })));
      const tiers = [true, false].flatMap(floor => [true, false].flatMap(person => [true, false].map(direct =>
        queues.map(queue => queue.filter(entry => entry.floor === floor && entry.person === person && entry.direct === direct)))));
      for (const tier of tiers) for (let depth = 0; payload.length < 3 && tier.some(queue => depth < queue.length); depth += 1) for (const queue of tier) {
        const next = queue[depth]; if (!next || payload.length >= 3) continue;
        const { cluster_id, item } = next;
        const row: PrefetchRow = { ...item, cluster_id,
          what: { ...item.what, value: item.what.value?.slice(0, 240) ?? null },
          evidence: item.evidence.slice(0, 3),
          ...(ambiguous.has(JSON.stringify([item.ref.collection, item.ref.id])) ? { ambiguous: true } : {}),
        };
        // A row fits when the block it renders into does, header and count line included.
        // Rows measured as a bare array fitted only because their markers, which rendering
        // strips, happened to leave about that much room.
        const fitting = leaner(row).find(candidate => blockBytes([...payload, candidate], matched, partial) <= SITUATION_PREFETCH_MAX_BYTES);
        if (!fitting) continue;
        payload.push(fitting as unknown as Record<string, unknown>);
      }
      if (!payload.length) return;
      for (const row of payload) {
        const hint = capture?.describe(row as unknown as SituationItem);
        if (hint) row.citation_source = hint;
      }
      // The rows go unmarked: the chat checks each contribution (`chat-pii-source.ts`)
      // and refuses a producer's own `__entity` marker, so the egress gather stamps
      // `situation_item` on each row, and that schema tags the ids of its refs.
      ctx.prompt.contribute({ role: 'entity', entity: 'situation_item', payload, render: rows => {
        const block = renderSituationPrefetch(rows, matched, partial);
        if (block) measure?.('prefetch.egress_bytes', Buffer.byteLength(block, 'utf8'), { outcome: 'injected' });
        return block;
      } });
      // Counted once the chat took the rows: a refused contribution showed nothing.
      hits = payload.length; matchedTotal = matched; outcome = 'hit';
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
