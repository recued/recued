import { isChatModelSourceId, zonedWallClockToEpochMs, type ChatModelSourceId, type PromptSchedule, type PromptScheduleInput, type PromptScheduleTiming, type PromptScheduleUpdate } from '@recued/contracts';
import { createDraftRecoveryStore, type DraftRecoveryEntry, type DraftRecoveryStorage, type DraftRecoveryTicket } from '../data/draft-recovery.js';
import { reminderWallClockValue } from '../reminders/reminder-time.js';
import { readPromptSchedules } from './prompt-search.js';
import { promptRepeatCron, type PromptRepeatFrequency } from './prompt-repeat.js';

export type PromptCreationRequest = PromptScheduleInput & { creation_id: string };
export interface PromptDraftValues {
  title: string; prompt: string; mode: 'one_shot' | 'recurring'; oneOffZone: string; time: string; chosenAt: number | null;
  frequency: PromptRepeatFrequency; clock: string; weekday: string; cron: string; timezone: string;
  selectedWeekdays?: string[]; monthDay?: string;
  model: ChatModelSourceId | ''; notify: boolean; creationId: string; request: PromptCreationRequest | null;
  updateRequest?: PromptScheduleUpdate;
}
export type PromptEditOriginal = Pick<PromptSchedule, 'schedule_id' | 'session_id' | 'created_at' | 'revision' | 'title' | 'prompt' | 'mode' | 'time_zone' | 'run_at' | 'cron_expression' | 'enabled' | 'model_source_id' | 'notify_on_done'>;
export type PromptDraftEntry = DraftRecoveryEntry<PromptDraftValues, PromptEditOriginal>;
export type PromptRecoveryStorage = DraftRecoveryStorage;
// An edit retains the original, owner input and exact submitted request. A
// full 32,000-character Unicode request must fit all three bounded copies.
export const PROMPT_RECOVERY_LIMITS = { entries: 8, entryBytes: 512 * 1024, bytes: 2 * 1024 * 1024, age: 7 * 86_400_000 } as const;
const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const instant = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 8.64e15;
const zone = (value: string): boolean => { try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; } };
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max;
export const promptEditOriginal = (row: PromptEditOriginal): PromptEditOriginal => ({
  schedule_id: row.schedule_id, session_id: row.session_id, created_at: row.created_at, revision: row.revision,
  title: row.title, prompt: row.prompt, mode: row.mode, time_zone: row.time_zone, enabled: row.enabled,
  ...(row.mode === 'one_shot' ? { run_at: row.run_at } : { cron_expression: row.cron_expression }),
  ...(row.model_source_id !== undefined ? { model_source_id: row.model_source_id } : {}),
  ...(row.notify_on_done !== undefined ? { notify_on_done: row.notify_on_done } : {}),
});
const parseOriginal = (input: unknown): PromptEditOriginal | null => {
  const raw = object(input); if (!raw) return null;
  try {
    const row = readPromptSchedules([{ ...raw, next_run_at: null, last_run_at: null, last_turn_id: null, last_status: null }])[0];
    return row ? promptEditOriginal(row) : null;
  } catch { return null; }
};

/** Retain the chosen instant independently of the browser's current timezone.
 * Recurrence is still validated by the server's preview and creation rules. */
export const promptDraftTiming = (value: PromptDraftValues): PromptScheduleTiming => {
  if (value.mode === 'one_shot') {
    const at = value.chosenAt ?? zonedWallClockToEpochMs(value.time, value.oneOffZone);
    if (!instant(at) || reminderWallClockValue(at, value.oneOffZone) !== value.time) throw new Error('Choose a valid local date and time.');
    return { mode: 'one_shot', time_zone: value.oneOffZone, run_at: new Date(at).toISOString() };
  }
  const cron_expression = promptRepeatCron(value);
  const time_zone = value.timezone.trim();
  if (!zone(time_zone)) throw new Error('Choose a valid IANA timezone.');
  if (!cron_expression || cron_expression.length > 120) throw new Error('Choose a valid recurring schedule.');
  return { mode: 'recurring', time_zone, cron_expression };
};
export const promptDraftRequest = (value: PromptDraftValues, offered: { model: boolean; notify: boolean }): PromptCreationRequest => ({
  title: value.title.trim(), prompt: value.prompt.trim(), ...promptDraftTiming(value), creation_id: value.creationId,
  ...(offered.model ? { model_source_id: value.model || null } : {}), ...(offered.notify ? { notify_on_done: value.notify } : {}),
});
export const promptDraftUpdate = (value: PromptDraftValues, original: PromptEditOriginal, offered: { model: boolean; notify: boolean }): PromptScheduleUpdate => {
  if (value.mode !== original.mode) throw Error('A saved scheduled prompt cannot change between Once and Recurring.');
  const { mode: _mode, ...timing } = promptDraftTiming(value);
  return { schedule_id: original.schedule_id, expected_revision: original.revision, title: value.title.trim(), prompt: value.prompt.trim(), ...timing,
    ...(offered.model ? { model_source_id: value.model || null } : {}), ...(offered.notify ? { notify_on_done: value.notify } : {}) };
};

/** Stored choices are owner input, never evidence of current server capability.
 * Submitted copies bind only known fields to their original request and ID. */
export const parsePromptRecovery = (input: unknown, now: number): PromptDraftEntry | null => {
  const row = object(input), raw = object(row?.values);
  const original = row?.original === null ? null : parseOriginal(row?.original);
  if (!row || !raw || typeof row.id !== 'string' || !row.id.startsWith('pdr_') || !uuid(row.id.slice(4))
    || row.sourceId !== 'scheduled_prompt' || row.original !== null && !original || !Number.isSafeInteger(row.revision) || Number(row.revision) < 1
    || !instant(row.updatedAt) || row.updatedAt > now + 60_000 || !['editing', 'pending', 'unknown'].includes(String(row.status))
    || row.status === 'editing' && row.updatedAt < now - PROMPT_RECOVERY_LIMITS.age
    || !text(raw.title, 160) || !text(raw.prompt, 32000) || !['one_shot', 'recurring'].includes(String(raw.mode))
    || !text(raw.oneOffZone, 100) || !zone(raw.oneOffZone) || !text(raw.time, 32) || raw.chosenAt !== null && !instant(raw.chosenAt)
    || !['daily', 'weekdays', 'weekly', 'selected_days', 'monthly', 'custom'].includes(String(raw.frequency)) || !text(raw.clock, 32)
    || raw.monthDay !== undefined && !text(raw.monthDay, 32) || raw.frequency === 'monthly' && raw.monthDay === undefined
    || raw.selectedWeekdays !== undefined && (!Array.isArray(raw.selectedWeekdays) || raw.selectedWeekdays.length > 7
      || raw.selectedWeekdays.some(day => typeof day !== 'string' || !/^[0-6]$/.test(day)) || new Set(raw.selectedWeekdays).size !== raw.selectedWeekdays.length)
    || raw.frequency === 'selected_days' && raw.selectedWeekdays === undefined
    || !text(raw.weekday, 1) || !/^[0-6]$/.test(raw.weekday) || !text(raw.cron, 1024) || !text(raw.timezone, 256)
    || raw.model !== '' && !isChatModelSourceId(raw.model) || typeof raw.notify !== 'boolean' || !uuid(raw.creationId)) return null;
  const values: PromptDraftValues = { title: raw.title, prompt: raw.prompt, mode: raw.mode as PromptDraftValues['mode'],
    oneOffZone: raw.oneOffZone, time: raw.time, chosenAt: raw.chosenAt as number | null, frequency: raw.frequency as PromptDraftValues['frequency'],
    clock: raw.clock, weekday: raw.weekday, cron: raw.cron, timezone: raw.timezone, model: raw.model as PromptDraftValues['model'],
    notify: raw.notify, creationId: raw.creationId, request: null,
    ...(raw.monthDay !== undefined ? { monthDay: raw.monthDay as string } : {}),
    ...(raw.selectedWeekdays !== undefined ? { selectedWeekdays: [...raw.selectedWeekdays as string[]] } : {}) };
  if (values.chosenAt !== null && reminderWallClockValue(values.chosenAt, values.oneOffZone) !== values.time) return null;
  if (original && (values.mode !== original.mode || original.mode === 'one_shot' && values.oneOffZone !== original.time_zone)) return null;
  if (row.status === 'editing') { if (raw.request !== null || raw.updateRequest != null) return null; }
  else {
    const request = object(original ? raw.updateRequest : raw.request);
    if (!request || !uuid(row.attempt) || !values.title.trim() || !values.prompt.trim()
      || request.notify_on_done !== undefined && typeof request.notify_on_done !== 'boolean'
      || request.model_source_id !== undefined && request.model_source_id !== null && !isChatModelSourceId(request.model_source_id)
      || values.model !== '' && request.model_source_id === undefined || values.notify && request.notify_on_done === undefined) return null;
    try {
      const offered = { model: request.model_source_id !== undefined, notify: request.notify_on_done !== undefined };
      const expected = original ? promptDraftUpdate(values, original, offered) : promptDraftRequest(values, offered);
      for (const key of ['title', 'prompt', 'mode', 'time_zone', 'run_at', 'cron_expression', 'creation_id', 'model_source_id', 'notify_on_done', 'schedule_id', 'expected_revision'] as const)
        // Both request shapes are deliberately checked, including fields the
        // other shape must omit. A recovered edit can never become a create.
        if (request[key] !== (expected as unknown as Record<string, unknown>)[key]) return null;
      if (original) { if (raw.request !== null) return null; values.updateRequest = expected as PromptScheduleUpdate; }
      else { if (raw.updateRequest != null) return null; values.request = expected as PromptCreationRequest; }
    } catch { return null; }
  }
  return { id: row.id, sourceId: 'scheduled_prompt', original, revision: Number(row.revision), updatedAt: row.updatedAt,
    status: row.status as PromptDraftEntry['status'], values, ...(row.status !== 'editing' ? { attempt: row.attempt as string } : {}) };
};
export const createPromptRecoveryStore = (options: { scope: string; storage?: PromptRecoveryStorage | null; now?: () => number }) =>
  createDraftRecoveryStore<PromptDraftValues, PromptEditOriginal>({ ...options, key: 'recued.prompt-schedule.draft-recovery.v1:' + encodeURIComponent(options.scope),
    limits: PROMPT_RECOVERY_LIMITS, parse: parsePromptRecovery });
export type PromptRecoveryStore = ReturnType<typeof createPromptRecoveryStore>;
type PromptDraftTicket = DraftRecoveryTicket & { snapshot: string };

/** Verify the latest copy before closing, and fence settlement by exact attempt
 * and revision so a late reply cannot erase newer owner input. */
export const createPromptDraftCheckpoint = (options: { store?: PromptRecoveryStore; now?: () => number; changed(): void }) => {
  const now = options.now ?? Date.now;
  let entry: PromptDraftEntry | null = null, dirty = false, persisted = false, failed = false, storedSnapshot = '';
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clear = () => { clearTimeout(timer); timer = undefined; entry = null; dirty = persisted = failed = false; storedSnapshot = ''; };
  const flush = (force = false): boolean => {
    clearTimeout(timer); timer = undefined;
    if (!entry || !dirty && !force) return true;
    if (persisted && JSON.stringify(options.store?.get(entry.id)) !== storedSnapshot) { failed = true; options.changed(); return false; }
    const next = { ...entry, revision: entry.revision + 1, updatedAt: now() };
    failed = !options.store?.save(next);
    if (!failed) { entry = next; storedSnapshot = JSON.stringify(parsePromptRecovery(next, now())); persisted = true; dirty = false; }
    options.changed(); return !failed;
  };
  const suspend = () => { flush(); clear(); };
  return {
    flush, suspend, id: () => entry?.id, current: () => entry ? parsePromptRecovery(entry, now()) : null,
    message: () => !options.store ? '' : failed ? 'Latest details could not be kept in this tab. Keep this form open or copy its details.'
      : entry && entry.status !== 'editing' ? 'Save not confirmed. The original request is kept in this tab.'
        : persisted ? 'Draft kept in this tab.' : 'Unfinished drafts are kept in this tab for up to 7 days.',
    begin(values: PromptDraftValues, restored?: PromptDraftEntry, original: PromptEditOriginal | null = null) {
      suspend(); if (!options.store) return;
      entry = restored ? structuredClone(restored) : { id: 'pdr_' + crypto.randomUUID(), sourceId: 'scheduled_prompt', original: original ? promptEditOriginal(original) : null,
        revision: 1, updatedAt: now(), status: 'editing', values: structuredClone(values) };
      persisted = Boolean(restored);
      storedSnapshot = restored ? JSON.stringify(restored) : '';
    },
    capture(values: PromptDraftValues) {
      if (!entry || entry.status !== 'editing' || JSON.stringify(entry.values) === JSON.stringify(values)) return;
      entry = { ...entry, values: structuredClone(values) }; dirty = true; clearTimeout(timer); timer = setTimeout(() => flush(), 180);
    },
    keepForLater(): boolean {
      if (!entry || !options.store || !flush(!persisted && !dirty)) return false;
      const expected = parsePromptRecovery(entry, now()), actual = options.store.get(entry.id);
      if (!expected || !actual || JSON.stringify(actual) !== JSON.stringify(expected)) { failed = true; options.changed(); return false; }
      clear(); return true;
    },
    rebase(original: PromptEditOriginal, values: PromptDraftValues): boolean {
      if (!entry?.original || entry.original.schedule_id !== original.schedule_id || entry.original.session_id !== original.session_id || entry.original.created_at !== original.created_at) return false;
      const previous = entry; entry = { ...entry, original: promptEditOriginal(original), status: 'editing', values: structuredClone(values) }; delete entry.attempt; dirty = true;
      if (flush()) return true;
      entry = previous; dirty = false; return false;
    },
    startAttempt(values: PromptDraftValues): PromptDraftTicket | undefined {
      if (!entry) return undefined;
      const previous = entry; entry = { ...entry, values: structuredClone(values), status: 'pending', attempt: crypto.randomUUID() }; dirty = true;
      if (!flush()) { entry = previous; dirty = true; return { id: entry.id, attempt: '', revision: entry.revision, blocked: true, snapshot: '' }; }
      return { id: entry.id, attempt: entry.attempt!, revision: entry.revision, snapshot: JSON.stringify(parsePromptRecovery(entry, now())) };
    },
    settle(ticket: PromptDraftTicket | undefined, outcome: 'confirmed' | 'refused' | 'unknown') {
      if (!ticket) return;
      const current = options.store?.get(ticket.id);
      if (current?.revision !== ticket.revision || current.attempt !== ticket.attempt || JSON.stringify(current) !== ticket.snapshot) return;
      const { updateRequest: _update, ...editable } = current.values;
      const next: PromptDraftEntry = { ...current, revision: current.revision + 1, updatedAt: now(),
        status: outcome === 'refused' ? 'editing' : 'unknown', values: outcome === 'refused' ? { ...editable, request: null } : current.values };
      const saved = outcome === 'confirmed' ? options.store?.remove(current.id) : options.store?.save(next);
      if (entry?.id !== ticket.id || entry.attempt !== ticket.attempt) return;
      if (saved && outcome === 'confirmed') clear();
      else { entry = next; failed = !saved; dirty = !saved; if (saved) { storedSnapshot = JSON.stringify(parsePromptRecovery(next, now())); } }
      options.changed();
    },
    discard(): boolean {
      if (entry && persisted && (JSON.stringify(options.store?.get(entry.id)) !== storedSnapshot || !options.store?.remove(entry.id))) {
        failed = true; options.changed(); return false;
      }
      clear(); return true;
    },
  };
};
