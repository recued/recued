/** D-343 slice 2 (§4, ruling 18) — `episode.record`: the owner's record of a day, in their words.
 *  Each record is something they did or skipped, about an item on that day's agenda or about
 *  nothing planned, and is kept as an episode for ever (`situations/closing-records.ts`).
 *
 *  🔑 ONE CALL PER DAY. Every AI write asks (D-329), and the chat asks one held write at a time
 *  (D-337), so a record per call would make a five-item evening five approvals in a row. The
 *  owner chose a list instead (ruling 18): one call carries the day's records, and its single ask
 *  is the day's checklist ("Done: Ran 5 km, the 3pm call · Skipped: Spanish").
 *
 *  ⛔ EVERYTHING IS CHECKED BEFORE THE OWNER IS ASKED: the day (today or earlier, on the turn's
 *  clock), each record's words and outcome, and each cited item, which must exist and be one the
 *  caller may read. The approved run repeats the checks, as the write it is. On for the owner,
 *  off for every AI app until granted (`core.situation.record`, owner-on / door-off).
 *
 *  🔑 A TASK RECORDED AS DONE IS TICKED OFF BY THE SAME CALL (the owner, 2026-11-14: "it takes up
 *  two approvals which should have been just one"). Its ask lists it ("Ticks off: …",
 *  `episodeRecordTickOffs`), and the call needs the tick-off switch too
 *  (`core.work-entity.task.mark-done`), checked before the owner is asked, so a caller without it
 *  is refused rather than recording a day whose tasks stay open.
 *  ⚠ Model-facing — `chat-prompt-optimization-log.md`. */

import { COLLECTION_GRANT_PREFIX, isAssetDate, isOwnersOwnCall, readRefusalSentence, zonedWallClockToEpochMs, type ChatDispatchContext, type ChatDispatchResult, type ExecutionSource, type SituationRef } from '@recued/contracts';
import type { Tier1Handler } from '@recued/middleware/internal-tool-registry/index.js';
import { isAiToolPrincipal, isCollectionReadGrantedForDispatch, neededSwitchOff, TASK_MARK_DONE_OP_ID, type ChatToolHandlerDeps } from './chat-tool-handlers.js';
import { guardTaskMarkDone } from './work-entity-crud-handler.js';
import type { ClosingItem, ClosingRecordInput } from './situations/closing-records.js';
import { situationSourceAccess } from './situations/sources.js';

/** The grant op the contract governs: owner-on, door-off (`OWNER_DEFAULT_ONLY_GRANT_ENTRIES`). */
export const EPISODE_RECORD_OP_ID = 'core.situation.record';

const ARGS: ReadonlySet<string> = new Set(['day', 'records', 'time_zone']);
const RECORD_ARGS: ReadonlySet<string> = new Set(['title', 'outcome', 'item']);
/** The longest record an episode keeps (its title), and the most a day's call carries. */
const TITLE_MAX = 500;
const RECORDS_MAX = 50;

const refuse = (detail: string): ChatDispatchResult => ({ ok: false, reason: 'invalid_args', detail: `episode.record: ${detail}` });
const blocked = (detail: string): ChatDispatchResult => ({ ok: false, reason: 'classification_blocked', detail: `episode.record: ${detail}` });
const isPlainObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const named = (keys: readonly string[]): string => keys.map((key) => `\`${key}\``).join(', ');

/** The contract grants the write, and the caller is an AI tool's principal. */
const admitted = (deps: ChatToolHandlerDeps, source: ExecutionSource | undefined): boolean => {
  const gate = deps.getOpAdmissionGate?.();
  return gate !== undefined && source !== undefined && isAiToolPrincipal(gate, source) && gate.isOpGranted(source, EPISODE_RECORD_OP_ID);
};
/** The switch the caller lacks to read what a record cites, among that kind of item's own read
 *  switches (its read action, then its data switch); undefined when it may read it. */
const itemReadSwitchOff = (
  deps: ChatToolHandlerDeps,
  ctx: ChatDispatchContext,
  access: { verb_op: string; collection: string },
): string | undefined => {
  const gate = deps.getOpAdmissionGate?.();
  if (gate === undefined || ctx.execution_source === undefined || !gate.isOpGranted(ctx.execution_source, access.verb_op)) {
    return access.verb_op;
  }
  return isCollectionReadGrantedForDispatch(deps, ctx, access.collection as Parameters<typeof isCollectionReadGrantedForDispatch>[2])
    ? undefined
    : `${COLLECTION_GRANT_PREFIX}${access.collection}`;
};
/** An item's `ref` as situation.query gives it; the marker a tool result carries is dropped. */
const refOf = (value: unknown): SituationRef | null => {
  if (!isPlainObject(value) || typeof value.collection !== 'string' || !value.collection.trim() || typeof value.id !== 'string' || !value.id.trim()
    || (value.field !== undefined && typeof value.field !== 'string')) return null;
  return { collection: value.collection.trim(), id: value.id.trim(), ...(typeof value.field === 'string' && value.field.trim() ? { field: value.field.trim() } : {}) };
};

interface Parsed { readonly day: string; readonly time_zone?: string; readonly records: readonly ClosingRecordInput[] }
/** The tasks a day's records tick off: each one recorded as done. */
const tickOffs = (records: readonly ClosingRecordInput[]): ClosingRecordInput[] =>
  records.filter((record) => record.outcome === 'done' && record.item?.ref.collection === 'task');

const parse = (deps: ChatToolHandlerDeps, raw: unknown, ctx: ChatDispatchContext): Parsed | ChatDispatchResult => {
  const closing = deps.getClosingRecords?.();
  if (!closing) return { ok: false, reason: 'execution_error', detail: 'episode.record: records are unavailable on this server' };
  if (!isPlainObject(raw)) return refuse('args must be an object');
  const other = Object.keys(raw).filter((key) => !ARGS.has(key) && raw[key] !== undefined);
  if (other.length > 0) return refuse(`it takes \`day\` and \`records\`, not ${named(other)}`);
  // The turn's zone, which a held call carries (`TURN_ZONE_ARGS`); the server's for a caller with none.
  const given = typeof raw.time_zone === 'string' && zonedWallClockToEpochMs('2000-01-01', raw.time_zone) !== null ? raw.time_zone : undefined;
  const zone = given ?? ctx.time_zone;
  if (typeof raw.day !== 'string' || !isAssetDate(raw.day)) return refuse('`day` is the day the records are for, as YYYY-MM-DD');
  if (raw.day > closing.today(zone)) return refuse(`\`day\` is today or an earlier day, not ${raw.day}`);
  if (!Array.isArray(raw.records) || raw.records.length === 0 || raw.records.length > RECORDS_MAX) {
    return refuse(`\`records\` lists what they did or skipped that day, 1 to ${RECORDS_MAX} of them`);
  }
  const seen = new Set<string>(); const records: ClosingRecordInput[] = [];
  for (const [index, row] of raw.records.entries()) {
    const at = `records[${index}]`;
    if (!isPlainObject(row)) return refuse(`${at} is {"title": …, "outcome": "done" or "skipped"}, with \`item\` for an item on the agenda`);
    const extra = Object.keys(row).filter((key) => !RECORD_ARGS.has(key) && row[key] !== undefined);
    if (extra.length > 0) return refuse(`${at} takes \`title\`, \`outcome\` and \`item\`, not ${named(extra)}`);
    const title = typeof row.title === 'string' ? row.title.trim() : '';
    if (title.length === 0 || title.length > TITLE_MAX) return refuse(`${at}.title is what they did, in their words, at most ${TITLE_MAX} characters`);
    if (row.outcome !== 'done' && row.outcome !== 'skipped') return refuse(`${at}.outcome is \`done\` or \`skipped\``);
    let item: ClosingItem | undefined;
    if (row.item !== undefined) {
      const ref = refOf(row.item);
      if (ref === null) return refuse(`${at}.item is an agenda item's \`ref\` from situation.query: {"collection": …, "id": …}`);
      const none = refuse(`${at}.item names no ${ref.collection} item \`${ref.id}\`; situation.query gives each item's \`ref\``);
      const access = situationSourceAccess(ref.collection);
      if (access === undefined) return none;
      // Read access first, so a caller learns nothing of an item it may not read.
      const off = itemReadSwitchOff(deps, ctx, access);
      if (off !== undefined) {
        return blocked(`${at}.item: ${readRefusalSentence(`Reading ${ref.collection} items`, off, isOwnersOwnCall(ctx.execution_source))}`);
      }
      const found = closing.item(ref, zone);
      if (found === null) return none;
      item = found;
    }
    const key = item ? JSON.stringify([item.ref.collection, item.ref.id, item.ref.field ?? '']) : JSON.stringify(title.toLocaleLowerCase('en'));
    if (seen.has(key)) return refuse(`${at} repeats an earlier record: send each thing once`);
    seen.add(key);
    records.push({ title, outcome: row.outcome, ...(item ? { item } : {}) });
  }
  if (tickOffs(records).length > 0) {
    const gate = deps.getOpAdmissionGate?.();
    if (gate === undefined || ctx.execution_source === undefined || !gate.isOpGranted(ctx.execution_source, TASK_MARK_DONE_OP_ID)) {
      return neededSwitchOff('episode.record', TASK_MARK_DONE_OP_ID, ctx.execution_source);
    }
    if (deps.getWorkEntityCrudDeps?.() === undefined) return { ok: false, reason: 'execution_error', detail: 'episode.record: tasks cannot be ticked off on this server' };
  }
  return { day: raw.day, ...(zone !== undefined ? { time_zone: zone } : {}), records };
};

const run = (deps: ChatToolHandlerDeps, raw: unknown, ctx: ChatDispatchContext): Parsed | ChatDispatchResult => {
  if (!admitted(deps, ctx.execution_source)) return neededSwitchOff('episode.record', EPISODE_RECORD_OP_ID, ctx.execution_source);
  return parse(deps, raw, ctx);
};

export const createEpisodeRecordHandler = (deps: ChatToolHandlerDeps): Tier1Handler => async (raw, ctx) => {
  const parsed = run(deps, raw, ctx);
  if ('ok' in parsed) return parsed;
  try {
    const saved = deps.getClosingRecords!()!.record(parsed);
    // Then each task recorded as done is ticked off, as `work.update` ticks one off (its lock, and
    // no new completion time for one already done). A tick-off that fails leaves the record.
    const crud = deps.getWorkEntityCrudDeps?.();
    // A day closed after it ended (the owner, 2026-11-14: "closing an old entry many days after"):
    // its tasks were done that day, so they are ticked off at its last moment on the owner's clock,
    // not when the record was approved. Today's are ticked off now.
    const closing = deps.getClosingRecords!()!;
    const zone = parsed.time_zone;
    const nextDay = new Date(Date.parse(`${parsed.day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    const dayEnd = parsed.day < closing.today(zone) ? zonedWallClockToEpochMs(`${nextDay}T00:00`, zone ?? 'UTC') : null;
    const completedAt = dayEnd !== null ? dayEnd - 1 : undefined;
    const ticked: string[] = []; const notTicked: string[] = [];
    for (const record of tickOffs(parsed.records)) {
      try {
        if (crud === undefined) throw new Error('unavailable');
        await guardTaskMarkDone(crud, { id: record.item!.ref.id, done: true, ...(completedAt !== undefined ? { completed_at: completedAt } : {}) });
        ticked.push(record.title);
      } catch { notTicked.push(record.title); }
    }
    // D-343 (the owner's day audit, 2026-11-15) — a task recorded as skipped is still open: "Didn't call
    // the plumber" left it due that day and the chat moved on. Said here, where the reply after the
    // owner's yes is written, so the chat offers to move it.
    const stillOpen = parsed.records.flatMap((record) => {
      if (record.outcome !== 'skipped' || record.item?.ref.collection !== 'task') return [];
      const task = crud?.store.readTask(record.item.ref.id);
      return task !== null && task !== undefined && task.completed_at == null ? [{ title: task.title, id: task.id }] : [];
    });
    return { ok: true, result: { recorded: saved.length, day: parsed.day,
      records: saved.map((episode) => ({ title: episode.title, outcome: episode.outcome })),
      ...(ticked.length > 0 ? { ticked_off: ticked } : {}), ...(notTicked.length > 0 ? { not_ticked_off: notTicked } : {}),
      ...(stillOpen.length > 0 ? { still_open: stillOpen,
        next: 'These skipped tasks are still open. Ask the user whether to move each to another day; change nothing until they say.' } : {}) } };
  } catch (e) {
    return { ok: false, reason: 'execution_error', detail: `episode.record failed: ${e instanceof Error ? e.message : String(e)}` };
  }
};

/** What an `episode.record` call would be refused for, before the owner is asked; `null` when it
 *  would run. */
export const checkEpisodeRecord = async (deps: ChatToolHandlerDeps, raw: unknown, ctx: ChatDispatchContext): Promise<ChatDispatchResult | null> => {
  const parsed = run(deps, raw, ctx);
  return 'ok' in parsed ? parsed : null;
};
