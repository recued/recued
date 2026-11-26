import type { Middleware, TurnContext } from '@recued/middleware';
import { PROSE_FUNCTION_WORDS } from '@recued/middleware-prompt-cache';
import { SITUATION_CONTEXT_MAX_BYTES, type SituationItem, type SituationRef, type SituationResult } from '@recued/contracts';
import type { SituationAccess } from './access.js';
import { situationItemForModel } from './model-projection.js';
import { chatTurnTimeZoneOf } from '../chat-clock.js';
import { ASSET_PROJECTION_CITATION_GUIDANCE, ASSET_COMPARISON_READ_GUIDANCE } from '../chat-source-citations.js';
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
    + ASSET_COMPARISON_READ_GUIDANCE + ' ' + ASSET_PROJECTION_CITATION_GUIDANCE + '\n' : '');
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
const refKeyOf = (ref: SituationRef): string => JSON.stringify([ref.collection, ref.id]);
const wordsOf = (value: string): string[] => value.toLocaleLowerCase('en').match(/[\p{L}\p{N}]+/gu) ?? [];
/** The records "Add records" names by the id their items carry: it sends a task as `{"kind":"task","id":"<id>"}`,
 * and the lookup keys its item `{"collection":"task","id":"<id>"}`. */
const PICKED_RECORD_COLLECTIONS: ReadonlySet<string> = new Set(['task', 'note']);
/** D-406 follow-up (2026-11-22) — a task or note the owner picked settles its own name, as a picked contact does
 * (`createSituationPickSettlement`). The message names the pick by its id, as a JSON string (the references block
 * "Add records" adds). Another record of the same title is its namesake, reached through the pick's own title: it
 * is left out, unless the owner's words reach it another way, by a word outside that title in the name of a person
 * or place on it; one the lookup did not bring, which shows nothing to check, is left out of its ambiguity and its
 * count. Measured live: beside a namesake, both rows `ambiguous` under "ask which one before acting" cost about 30%
 * more reasoning and 3 s a turn, and once in 24 turns a read of the namesake too. */
const pickedRecordNamesakes = (message: string, result: Pick<SituationResult, 'clusters' | 'ambiguous'>,
  personName?: (id: string) => string | undefined): { picked: (ref: SituationRef) => boolean; namesakes: ReadonlySet<string> } => {
  const picked = (ref: SituationRef): boolean => PICKED_RECORD_COLLECTIONS.has(ref.collection) && message.includes(JSON.stringify(ref.id));
  const items = result.clusters.flatMap(cluster => cluster.items);
  const byKey = new Map(items.map(item => [refKeyOf(item.ref), item]));
  const titleOf = (item: SituationItem): string => (item.what.value ?? '').toLocaleLowerCase('en');
  // An `ambiguous` entry names a title in lower case, or the people a message named. It is a title's when a record
  // the lookup brought among its choices has that title. The chat's lookup brings two groups at most, so a pick it
  // did not bring is known by its title's entry.
  const titleEntry = (entry: SituationResult['ambiguous'][number]): boolean => entry.choices.some(choice => {
    const item = byKey.get(refKeyOf(choice)); return item !== undefined && titleOf(item) === entry.name;
  });
  const titles = new Set([...items.filter(item => picked(item.ref)).map(titleOf),
    ...result.ambiguous.filter(entry => entry.choices.some(picked) && titleEntry(entry)).map(entry => entry.name)].filter(Boolean));
  const namesakes = new Set<string>();
  if (!titles.size) return { picked, namesakes };
  const tokens = new Set(wordsOf(message).filter(word => [...word].length >= 2 && !PROSE_FUNCTION_WORDS.has(word)));
  for (const ref of [...items.filter(item => titles.has(titleOf(item))).map(item => item.ref),
    ...result.ambiguous.filter(entry => titles.has(entry.name)).flatMap(entry => entry.choices)]) {
    if (picked(ref)) continue;
    const item = byKey.get(refKeyOf(ref));
    const title = new Set(wordsOf(item === undefined ? '' : titleOf(item)));
    const anotherWay = [...(item?.who.value ?? []).flatMap(id => wordsOf(personName?.(id) ?? '')), ...wordsOf(item?.where.value?.name ?? '')]
      .some(word => tokens.has(word) && !title.has(word));
    if (!anotherWay) namesakes.add(refKeyOf(ref));
  }
  return { picked, namesakes };
};
export const createSituationPrefetch = (deps: {
  getAccess: () => SituationAccess | undefined;
  /** A contact's name by an id an item's `who` carries (`situationPersonName`). */
  personName?: (id: string) => string | undefined;
  /** D-406 follow-up (2026-11-20) — for a message carrying a contact the owner picked by its exact id, whether a
   *  person is that contact's namesake, reached only through its name's words (`createSituationPickSettlement`);
   *  null when it carries none. */
  settledByPick?: (message: string) => ((personId: string) => boolean) | null;
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
      // D-406 follow-up (2026-11-20) — a contact the owner picked settles its own name: a namesake's items are
      // left out, and an ambiguity only between them is none. Before, the pick's own title brought both people's
      // birthdays, each `ambiguous`, under "ask which one before acting" (`chat-picked-contacts.ts`).
      const settles = deps.settledByPick?.(message) ?? null;
      // D-406 follow-up (2026-11-22) — so does a task or note the owner picked (`pickedRecordNamesakes`).
      const { picked, namesakes } = pickedRecordNamesakes(message, result, deps.personName);
      const settledAway = (item: SituationItem): boolean => namesakes.has(refKeyOf(item.ref))
        || settles !== null && Boolean(item.who.value?.length) && item.who.value!.every(settles);
      const clusters = settles === null && namesakes.size === 0 ? result.clusters
        : result.clusters.map(cluster => ({ ...cluster, items: cluster.items.filter(item => !settledAway(item)) })).filter(cluster => cluster.items.length > 0);
      const brought = new Set(result.clusters.flatMap(cluster => cluster.items.map(item => refKeyOf(item.ref))));
      const leftOut = new Set([...namesakes, ...result.clusters.flatMap(cluster => cluster.items.filter(settledAway).map(item => refKeyOf(item.ref)))]);
      // Everything the message matched, shown or not; the rows below are at most three of it. A namesake left out
      // that the lookup did not bring is among its `omitted`, and no longer a match.
      const matched = result.omitted - [...namesakes].filter(key => !brought.has(key)).length
        + clusters.reduce((sum, cluster) => sum + cluster.items.length, 0);
      const partial = Boolean(result.partial?.length);
      // Records the owner picked, every one of them, are no ambiguity: the owner said which.
      const ambiguous = new Set(result.ambiguous.flatMap(entry => {
        const choices = entry.choices.filter(choice => !leftOut.has(refKeyOf(choice)));
        return choices.length > 1 && !choices.every(picked) ? choices.map(refKeyOf) : [];
      }));
      const payload: Record<string, unknown>[] = [];
      // Keep the query's consequence/person/name priorities across groups, too.
      // Round-robin only inside each tier: weaker keyword hits must not push a
      // literal name or a named person's second item out of the three-row block.
      const text = situationText({ text: message, surface: 'prefetch' });
      // D-338 — each row says when it happens on the turn's clock, as the tool's items do.
      const zone = chatTurnTimeZoneOf(ctx.state);
      const queues = clusters.map(cluster => cluster.items.map(item => ({ cluster_id: cluster.id, floor: item.consequence === 'floor',
        person: ['match', 'near'].includes(item.who.verdict), direct: text.title(item.what.value ?? ''),
        item: situationItemForModel(item, deps.personName, { zone, isPrivate: access.isPrivate }) })));
      const tiers = [true, false].flatMap(floor => [true, false].flatMap(person => [true, false].map(direct =>
        queues.map(queue => queue.filter(entry => entry.floor === floor && entry.person === person && entry.direct === direct)))));
      for (const tier of tiers) for (let depth = 0; payload.length < 3 && tier.some(queue => depth < queue.length); depth += 1) for (const queue of tier) {
        const next = queue[depth]; if (!next || payload.length >= 3) continue;
        const { cluster_id, item } = next;
        const row: PrefetchRow = { ...item, cluster_id,
          what: { ...item.what, value: item.what.value?.slice(0, 240) ?? null },
          evidence: item.evidence.slice(0, 3),
          ...(ambiguous.has(refKeyOf(item.ref)) ? { ambiguous: true } : {}),
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
