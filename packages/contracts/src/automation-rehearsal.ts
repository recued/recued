/** Saved dispatch-selection scenarios. Neither a result nor an activation authorizes a run. */
import { RpcError } from './rpc/types.js';
import { regressionJson, type RegressionJson } from './recipe-regression.js';

export const AUTOMATION_REHEARSAL_LIMITS = Object.freeze({ cases: 40, document_bytes: 256_000, history: 10,
  state_bytes: 2_000_000, tracks: 100, retained_bytes: 16_000_000, proof_ms: 900_000, review_ms: 300_000 });
export type RehearsalTarget = { kind: 'trigger' | 'schedule' | 'timer'; id: string };
export type RehearsalConfiguration =
  | { kind: 'trigger'; enabled: boolean; pattern: string; filter: Record<string, string | number | boolean> | null; fields: string[] | null; watch_interval_ms: number | null }
  | { kind: 'schedule'; enabled: boolean; cron_expression: string; missed_policy: 'auto' | 'ask' | 'skip' | 'catch_up' }
  | { kind: 'timer'; enabled: boolean; reset_circuit: boolean };
export type RehearsalVerdict = 'start' | 'skip' | 'ask';
export interface RehearsalCase {
  id: string; name: string; expected: RehearsalVerdict;
  input: { kind: 'event'; event: { platform: string; slug: string; entity_type: string; event_kind: string; record_id: string; at: number;
    record?: Record<string, RegressionJson>; prev?: Record<string, RegressionJson>; changed_fields?: string[]; in_drain?: true };
    source_ready: boolean; chat_mail: boolean }
    | { kind: 'clock'; at: number; last_run_at: number | null; next_run_at: number; running: boolean; auto_disabled: boolean };
}
export interface RehearsalDocument { title: string; candidate: RehearsalConfiguration; cases: RehearsalCase[] }
export interface RehearsalDecision { verdict: RehearsalVerdict | 'unsupported'; detail: string }
export interface RehearsalComparison { cases: Array<{ id: string; name: string; expected: RehearsalVerdict;
  current: RehearsalDecision; candidate: RehearsalDecision; passed: boolean }>; passed: number; failed: number; coverage: string[] }
export interface RehearsalDraft { revision: number; digest: string; base_digest: string; created_at: number; document: RehearsalDocument }
export interface RehearsalProof { receipt_id: string; draft_revision: number; expires_at: number; comparison: RehearsalComparison }
export interface RehearsalReview { review_id: string; draft_revision: number; expires_at: number;
  before: RehearsalConfiguration; after: RehearsalConfiguration; label: string; coverage: string[] }
export interface RehearsalActivation { sequence: number; at: number; configuration: RehearsalConfiguration; circuit_reset?: true; refresh_confirmed?: true }
export interface RehearsalView { target: RehearsalTarget; label: string; supported: boolean; reason?: string;
  recipe_id: string | null; dish_id: string | null; time_zone: string; interval_ms: number | null;
  revision: number; live_digest: string; current: RehearsalConfiguration | null; draft: RehearsalDraft | null;
  selected_draft?: RehearsalDraft; drafts: Array<{ revision: number; title: string; created_at: number }>;
  qualification: RehearsalProof | null; history: RehearsalActivation[] }
export interface RehearsalSave { target: RehearsalTarget; expected_revision: number; expected_live_digest: string; request_id: string; document: RehearsalDocument }
export interface RehearsalTest { target: RehearsalTarget; expected_revision: number; draft_revision: number }
export interface RehearsalPrepare extends RehearsalTest { receipt_id: string }
export interface RehearsalActivate { target: RehearsalTarget; expected_revision: number; review_id: string; request_id: string }
export interface RehearsalMutation extends RehearsalView { mutation_revision: number; saved_draft?: RehearsalDraft;
  activated?: RehearsalActivation; refresh_warning?: string }

export const rehearsalObject = (raw: unknown, keys: readonly string[]): Record<string, unknown> => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(key => !keys.includes(key))) {
    throw new RpcError('bad_request', 'Invalid automation rehearsal fields.', 400);
  }
  return raw as Record<string, unknown>;
};
export const rehearsalText = (raw: unknown, label: string, max = 200): string => {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > max || /[\u0000-\u001f]/u.test(raw)) throw new RpcError('bad_request', 'Provide ' + label + ' using at most ' + max + ' characters.', 400);
  return raw;
};
export const rehearsalBytes = (raw: unknown): number => {
  try { return new TextEncoder().encode(JSON.stringify(raw)).byteLength; }
  catch { throw new RpcError('bad_request', 'Use bounded JSON for automation rehearsal.', 400); }
};
const boolean = (raw: unknown): boolean => { if (typeof raw !== 'boolean') throw new RpcError('bad_request', 'Use true or false.', 400); return raw; };
const timestamp = (raw: unknown): number => {
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 0 || raw > 8_640_000_000_000_000) throw new RpcError('bad_request', 'Use a valid timestamp in milliseconds.', 400); return raw;
};
const strings = (raw: unknown, limit = 50): string[] => {
  if (!Array.isArray(raw) || raw.length > limit) throw new RpcError('bad_request', 'Use at most ' + limit + ' text values.', 400);
  return [...new Set(raw.map(item => rehearsalText(item, 'a field name')))];
};
export const parseRehearsalTarget = (raw: unknown): RehearsalTarget => {
  const value = rehearsalObject(raw, ['kind', 'id']);
  if (value.kind !== 'trigger' && value.kind !== 'schedule' && value.kind !== 'timer') throw new RpcError('bad_request', 'Choose an event trigger, schedule or dish timer.', 400);
  return { kind: value.kind, id: rehearsalText(value.id, 'an existing automation id') };
};
export const parseRehearsalConfiguration = (raw: unknown): RehearsalConfiguration => {
  const value = rehearsalObject(raw, ['kind', 'enabled', 'pattern', 'filter', 'fields', 'watch_interval_ms', 'cron_expression', 'missed_policy', 'reset_circuit']);
  const enabled = boolean(value.enabled);
  if (value.kind === 'timer') {
    rehearsalObject(raw, ['kind', 'enabled', 'reset_circuit']);
    const reset_circuit = boolean(value.reset_circuit);
    if (reset_circuit && !enabled) throw new RpcError('bad_request', 'A circuit reset needs an enabled timer.', 400);
    return { kind: 'timer', enabled, reset_circuit };
  }
  if (value.kind === 'schedule') {
    rehearsalObject(raw, ['kind', 'enabled', 'cron_expression', 'missed_policy']);
    if (!['auto', 'ask', 'skip', 'catch_up'].includes(String(value.missed_policy))) throw new RpcError('bad_request', 'Choose a missed-run policy.', 400);
    return { kind: 'schedule', enabled, cron_expression: rehearsalText(value.cron_expression, 'a cron expression'),
      missed_policy: value.missed_policy as 'auto' | 'ask' | 'skip' | 'catch_up' };
  }
  if (value.kind !== 'trigger') throw new RpcError('bad_request', 'Unknown automation configuration.', 400);
  rehearsalObject(raw, ['kind', 'enabled', 'pattern', 'filter', 'fields', 'watch_interval_ms']);
  let filter: Record<string, string | number | boolean> | null = null;
  if (value.filter !== null) {
    if (!value.filter || typeof value.filter !== 'object' || Array.isArray(value.filter) || Object.keys(value.filter).length > 50) throw new RpcError('bad_request', 'Use at most 50 scalar payload filters, or null.', 400);
    filter = Object.fromEntries(Object.entries(value.filter).map(([key, entry]) => {
      if (!(typeof entry === 'string' || typeof entry === 'boolean' || typeof entry === 'number' && Number.isFinite(entry))) throw new RpcError('bad_request', 'Payload filter values must be text, numbers or booleans.', 400);
      rehearsalText(key, 'a payload path');
      if (typeof entry === 'string' && entry.length > 2000) throw new RpcError('bad_request', 'Keep a filter value below 2000 characters.', 400);
      return [key, entry];
    }));
    if (!Object.keys(filter).length) filter = null;
  }
  const fields = value.fields === null ? null : strings(value.fields);
  const watch = value.watch_interval_ms;
  if (watch !== null && (typeof watch !== 'number' || !Number.isFinite(watch) || watch <= 0)) throw new RpcError('bad_request', 'Use a positive watch interval in milliseconds, or null.', 400);
  return { kind: 'trigger', enabled, pattern: rehearsalText(value.pattern, 'an event pattern'), filter,
    fields: fields?.length ? fields : null, watch_interval_ms: watch as number | null };
};
export const parseRehearsalDocument = (raw: unknown): RehearsalDocument => {
  if (rehearsalBytes(raw) > AUTOMATION_REHEARSAL_LIMITS.document_bytes) throw new RpcError('bad_request', 'Keep a rehearsal document below 256 KB.', 400);
  const value = rehearsalObject(raw, ['title', 'candidate', 'cases']);
  if (!Array.isArray(value.cases) || !value.cases.length || value.cases.length > AUTOMATION_REHEARSAL_LIMITS.cases) throw new RpcError('bad_request', 'Use one to 40 scenarios.', 400);
  const cases: RehearsalCase[] = value.cases.map(rawCase => {
    const item = rehearsalObject(rawCase, ['id', 'name', 'expected', 'input']);
    if (item.expected !== 'start' && item.expected !== 'skip' && item.expected !== 'ask') throw new RpcError('bad_request', 'Choose start, skip or ask.', 400);
    const input = rehearsalObject(item.input, ['kind', 'at', 'last_run_at', 'next_run_at', 'running', 'auto_disabled', 'event', 'source_ready', 'chat_mail']);
    let parsed: RehearsalCase['input'];
    if (input.kind === 'clock') {
      rehearsalObject(input, ['kind', 'at', 'last_run_at', 'next_run_at', 'running', 'auto_disabled']);
      parsed = { kind: 'clock', at: timestamp(input.at), last_run_at: input.last_run_at === null ? null : timestamp(input.last_run_at),
        next_run_at: timestamp(input.next_run_at), running: boolean(input.running), auto_disabled: boolean(input.auto_disabled) };
    } else if (input.kind === 'event') {
      rehearsalObject(input, ['kind', 'event', 'source_ready', 'chat_mail']);
      const event = rehearsalObject(input.event, ['platform', 'slug', 'entity_type', 'event_kind', 'record_id', 'at', 'record', 'prev', 'changed_fields', 'in_drain']);
      if (!['created', 'updated', 'deleted', 'synced', 'completed', 'due_soon', 'overdue', 'state_changed', 'failed'].includes(String(event.event_kind))) throw new RpcError('bad_request', 'Choose a warehouse event kind.', 400);
      const object = (raw: unknown): Record<string, RegressionJson> => {
        const value = regressionJson(raw); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RpcError('bad_request', 'Use an object for record snapshots.', 400); return value;
      };
      if (event.in_drain !== undefined && event.in_drain !== true) throw new RpcError('bad_request', 'A drain marker must be true or absent.', 400);
      parsed = { kind: 'event', source_ready: boolean(input.source_ready), chat_mail: boolean(input.chat_mail), event: {
        platform: rehearsalText(event.platform, 'an event platform'), slug: rehearsalText(event.slug, 'an event source'),
        entity_type: rehearsalText(event.entity_type, 'an entity type'), event_kind: String(event.event_kind), record_id: rehearsalText(event.record_id, 'a fixture record id'),
        at: timestamp(event.at), ...(event.record === undefined ? {} : { record: object(event.record) }), ...(event.prev === undefined ? {} : { prev: object(event.prev) }),
        ...(event.changed_fields === undefined ? {} : { changed_fields: strings(event.changed_fields) }), ...(event.in_drain === true ? { in_drain: true } : {}),
      } };
    } else throw new RpcError('bad_request', 'Choose an event or clock scenario.', 400);
    return { id: rehearsalText(item.id, 'a scenario id', 100), name: rehearsalText(item.name, 'a scenario name'), expected: item.expected, input: parsed };
  });
  if (new Set(cases.map(item => item.id)).size !== cases.length) throw new RpcError('bad_request', 'Scenario ids must be unique.', 400);
  return { title: rehearsalText(value.title, 'a rehearsal title'), candidate: parseRehearsalConfiguration(value.candidate), cases };
};
