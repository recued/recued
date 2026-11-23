import { afterEach, expect, it, vi } from 'vitest';
import { createPromptDraftCheckpoint, createPromptRecoveryStore, parsePromptRecovery, promptDraftRequest, promptDraftTiming,
  type PromptDraftEntry, type PromptDraftValues } from '../prompt-draft-recovery.js';
import { resolveRecoveryDraft, searchRecoveryDrafts } from '../../data/recovery-draft-search.js';
import { renderUniversalSearch } from '../../data/universal-search.js';
import { searchTypeCounts } from '../../data/universal-search-filter.js';

const now = Date.parse('2026-11-01T05:00Z');
const values = (): PromptDraftValues => ({ title: '  Morning briefing  ', prompt: '\n  Summarize my Café mail.\n  Keep urgent items.  ', mode: 'one_shot',
  oneOffZone: 'America/New_York', time: '2026-11-01T01:30', chosenAt: Date.parse('2026-11-01T06:30:42.123Z'),
  frequency: 'weekdays', clock: '09:15', weekday: '1', cron: '0 9 * * *', timezone: 'Europe/Paris',
  model: 'slot_2', notify: true, creationId: crypto.randomUUID(), request: null });
const row = (): PromptDraftEntry => ({ id: 'pdr_' + crypto.randomUUID(), sourceId: 'scheduled_prompt', original: null,
  revision: 1, updatedAt: now, status: 'editing', values: values() });
const pending = (): PromptDraftEntry => {
  const entry = row(); return { ...entry, status: 'pending', attempt: crypto.randomUUID(),
    values: { ...entry.values, request: promptDraftRequest(entry.values, { model: true, notify: true }) } };
};
const setup = () => {
  const raw = new Map<string, string>(); let clock = now, blocked = false, unreadable = false;
  const storage = { getItem(key: string) { if (unreadable) throw Error('unreadable'); return raw.get(key) ?? null; },
    setItem(key: string, value: string) { if (blocked) throw Error('quota'); raw.set(key, value); },
    removeItem(key: string) { if (blocked) throw Error('quota'); raw.delete(key); } };
  const store = createPromptRecoveryStore({ scope: 'server-and-pair-a', storage, now: () => clock });
  const checkpoint = createPromptDraftCheckpoint({ store, now: () => clock, changed() {} });
  return { raw, storage, store, checkpoint, block(value = true) { blocked = value; }, unreadable(value = true) { unreadable = value; },
    advance() { clock += 8 * 86_400_000; } };
};
afterEach(() => vi.useRealTimers());

it('retains incomplete input, hidden cadence choices and a full Unicode prompt within the storage budget', () => {
  const f = setup(), entry = row(), incomplete = { ...entry, values: { ...entry.values, title: '', prompt: '文'.repeat(32000),
    time: '', chosenAt: null, timezone: 'America/', clock: '', cron: '*/' } };
  expect(f.store.save(incomplete)).toBe(true); expect(f.store.get(entry.id)).toEqual(incomplete);
  const submitted = pending(); submitted.values.prompt = '文'.repeat(32000);
  submitted.values.request = promptDraftRequest(submitted.values, { model: true, notify: true });
  expect(f.store.save(submitted)).toBe(true); expect(f.store.get(submitted.id)).toEqual(submitted);
  expect(parsePromptRecovery({ ...entry, values: { ...entry.values, prompt: 'a'.repeat(32001) } }, now)).toBeNull();
});

it('keeps the exact repeated-hour instant and canonicalizes recurrence while preserving the raw owner text', () => {
  const value = values();
  expect(promptDraftTiming(value)).toEqual({ mode: 'one_shot', time_zone: 'America/New_York', run_at: '2026-11-01T06:30:42.123Z' });
  const recurring = { ...value, mode: 'recurring' as const, frequency: 'custom' as const, cron: '  15   9 * * 1-5  ', timezone: ' Europe/Paris ' };
  expect(promptDraftRequest(recurring, { model: true, notify: true })).toMatchObject({ title: 'Morning briefing',
    prompt: 'Summarize my Café mail.\n  Keep urgent items.', cron_expression: '15 9 * * 1-5', time_zone: 'Europe/Paris', model_source_id: 'slot_2', notify_on_done: true });
  expect(parsePromptRecovery({ ...row(), values: value }, now)?.values.prompt).toBe(value.prompt);
  expect(parsePromptRecovery({ ...row(), values: { ...value, time: '2026-11-02T01:30' } }, now)).toBeNull();
});

it('binds every interrupted request field to the saved creation identity and choices, dropping unknown fields', () => {
  const entry = pending();
  expect(parsePromptRecovery({ ...entry, values: { ...entry.values, request: { ...entry.values.request, extra: 'ignored' }, extra: 'ignored' } }, now)).toEqual(entry);
  for (const patch of [{ creation_id: crypto.randomUUID() }, { title: 'Other' }, { prompt: 'Other request' },
    { run_at: '2026-11-01T05:30:42.123Z' }, { time_zone: 'UTC' }, { model_source_id: 'slot_1' }, { notify_on_done: false }, { cron_expression: '0 9 * * *' }]) {
    expect(parsePromptRecovery({ ...entry, values: { ...entry.values, request: { ...entry.values.request, ...patch } } }, now)).toBeNull();
  }
  expect(parsePromptRecovery({ ...entry, attempt: 'not-an-attempt' }, now)).toBeNull();
});

it('preserves omitted optional fields for a retry instead of inventing support from saved data', () => {
  const entry = row(); entry.values.model = ''; entry.values.notify = false;
  const request = promptDraftRequest(entry.values, { model: false, notify: false });
  const saved = { ...entry, status: 'unknown' as const, attempt: crypto.randomUUID(), values: { ...entry.values, request } };
  expect(parsePromptRecovery(saved, now)?.values.request).toEqual(request);
  expect(request).not.toHaveProperty('model_source_id'); expect(request).not.toHaveProperty('notify_on_done');
  expect(parsePromptRecovery({ ...saved, values: { ...saved.values, model: 'slot_2' } }, now)).toBeNull();
});

it('isolates pairings and expires editing drafts while retaining unconfirmed creation requests', () => {
  const f = setup(), editing = row(), attempt = pending();
  expect(f.store.save(editing)).toBe(true); expect(f.store.save(attempt)).toBe(true);
  expect(createPromptRecoveryStore({ scope: 'another-pair', storage: f.storage, now: () => now }).list()).toEqual([]);
  f.advance(); expect(f.store.list()).toEqual([attempt]);
  f.unreadable(); expect(f.store.inspect?.()).toEqual({ entries: [], unavailable: true });
});

it('keeps untouched forms only on explicit request and refuses to close before successful write and read-back', () => {
  vi.useFakeTimers(); const f = setup(); f.checkpoint.begin(values()); vi.runAllTimers(); expect(f.store.list()).toEqual([]);
  f.block(); expect(f.checkpoint.keepForLater()).toBe(false); expect(f.checkpoint.id()).toBeDefined();
  f.block(false); expect(f.checkpoint.flush()).toBe(true); f.unreadable();
  expect(f.checkpoint.keepForLater()).toBe(false); expect(f.checkpoint.id()).toBeDefined();
  f.unreadable(false); expect(f.checkpoint.keepForLater()).toBe(true); expect(f.checkpoint.id()).toBeUndefined();
  expect(f.store.list()[0]?.values).toEqual(valuesWithId(f.store.list()[0]!.values.creationId));
});
const valuesWithId = (creationId: string) => ({ ...values(), creationId });

it('flushes the latest input immediately and blocks overwrite, keep and discard against a newer revision', () => {
  vi.useFakeTimers(); const f = setup(), original = values(); f.checkpoint.begin(original);
  f.checkpoint.capture({ ...original, prompt: 'Latest input' }); expect(f.checkpoint.flush()).toBe(true);
  const kept = f.store.list()[0]!, newer = { ...kept, revision: kept.revision + 1, values: { ...kept.values, prompt: 'Newer input' } };
  expect(kept.values.prompt).toBe('Latest input'); expect(f.store.save(newer)).toBe(true);
  f.checkpoint.capture({ ...original, prompt: 'Stale input' }); expect(f.checkpoint.flush()).toBe(false);
  expect(f.checkpoint.keepForLater()).toBe(false); expect(f.checkpoint.discard()).toBe(false);
  expect(f.store.get(kept.id)).toEqual(newer); f.checkpoint.suspend();
});

it('persists the exact pending request before returning its ticket and blocks even the first dispatch on failure', () => {
  const f = setup(), attempt = pending(); f.checkpoint.begin(attempt.values); f.block();
  expect(f.checkpoint.startAttempt(attempt.values)?.blocked).toBe(true); expect(f.store.list()).toEqual([]);
  f.block(false); const ticket = f.checkpoint.startAttempt(attempt.values)!;
  expect(f.store.get(ticket.id)).toMatchObject({ status: 'pending', revision: ticket.revision, attempt: ticket.attempt, values: attempt.values });
  f.checkpoint.suspend();
});

it('fences late replies and clears only the matching original request after a confirmed retry', () => {
  const f = setup(), attempt = pending(); f.checkpoint.begin(attempt.values);
  const old = f.checkpoint.startAttempt(attempt.values)!; f.checkpoint.settle(old, 'unknown');
  const unknown = f.store.get(old.id)!, resumed = createPromptDraftCheckpoint({ store: f.store, now: () => now, changed() {} });
  resumed.begin(unknown.values, unknown); const current = resumed.startAttempt(unknown.values)!;
  f.checkpoint.settle(old, 'confirmed'); expect(f.store.get(old.id)?.attempt).toBe(current.attempt);
  expect(f.store.get(old.id)?.values.request).toEqual(attempt.values.request);
  resumed.settle(current, 'confirmed'); expect(f.store.list()).toEqual([]); f.checkpoint.suspend(); resumed.suspend();
});

it('keeps a replayable request after failed confirmation cleanup and releases it only after a definite refusal', () => {
  const f = setup(), attempt = pending(); f.checkpoint.begin(attempt.values);
  const ticket = f.checkpoint.startAttempt(attempt.values)!; f.block(); f.checkpoint.settle(ticket, 'confirmed');
  f.block(false); expect(f.checkpoint.keepForLater()).toBe(true); const saved = f.store.get(ticket.id)!;
  expect(saved.status).toBe('unknown'); expect(saved.values.request).toEqual(attempt.values.request);
  f.checkpoint.begin(saved.values, saved); const retry = f.checkpoint.startAttempt(saved.values)!; f.checkpoint.settle(retry, 'refused');
  expect(f.store.get(saved.id)).toMatchObject({ status: 'editing', values: { request: null } }); expect(f.checkpoint.discard()).toBe(true);
});

it('finds actual prompt content and cadence under Drafts, excludes opaque IDs and inactive fields, and rejects stale choices', () => {
  const f = setup(), entry = row(); entry.values = { ...entry.values, mode: 'recurring', frequency: 'weekly', clock: '16:45', weekday: '2', cron: 'hidden inactive expression' };
  expect(f.store.save(entry)).toBe(true); const stores = { prompt: f.store };
  const match = searchRecoveryDrafts(stores, 'café urgent tuesday 16:45 paris slot 2').matches[0]!;
  expect(match.kind).toBe('prompt'); expect(resolveRecoveryDraft(stores, match)).toEqual(entry);
  expect(searchRecoveryDrafts(stores, entry.values.creationId).matches).toEqual([]);
  expect(searchRecoveryDrafts(stores, 'hidden inactive').matches).toEqual([]);
  const props = { query: 'Café', actionAttr: 'data-action', resultType: 'draft' as const, recoveryDraftSearch: searchRecoveryDrafts(stores, 'Café') };
  expect(searchTypeCounts(props).draft.loaded).toBe(1); expect(renderUniversalSearch(props)).toContain('Resume scheduled prompt draft Morning briefing');
  expect(f.store.save({ ...entry, values: { ...entry.values, prompt: 'Changed at the same revision' } })).toBe(true);
  expect(resolveRecoveryDraft(stores, match)).toBeNull();
});
