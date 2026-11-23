import { expect, it } from 'vitest';
import type { PromptSchedule } from '@recued/contracts';
import { createPromptDraftCheckpoint, createPromptRecoveryStore, parsePromptRecovery, promptDraftUpdate, promptEditOriginal,
  type PromptDraftEntry, type PromptDraftValues } from '../prompt-draft-recovery.js';
import { checkPromptEdit, comparePromptEdits, mergePromptEdits, unresolvedPromptEdits } from '../prompt-edit-recovery.js';
import { searchRecoveryDrafts } from '../../data/recovery-draft-search.js';

const now = Date.parse('2026-10-31T12:00Z');
const saved = (patch: Partial<PromptSchedule> = {}): PromptSchedule => ({ schedule_id: 'ps_original', session_id: 'scheduled-original', revision: 4,
  created_at: now - 1000, title: 'Café briefing', prompt: 'Summarize the customer renewal.', mode: 'recurring', time_zone: 'America/New_York',
  cron_expression: '15 9 * * 1-5', enabled: true, model_source_id: 'slot_2', notify_on_done: true, next_run_at: now + 1000,
  last_run_at: null, last_turn_id: null, last_status: null, ...patch });
const values = (patch: Partial<PromptDraftValues> = {}): PromptDraftValues => ({ title: 'Café briefing', prompt: 'Summarize the customer renewal.',
  mode: 'recurring', oneOffZone: 'America/New_York', time: '2026-11-01T01:30', chosenAt: Date.parse('2026-11-01T06:30:42.123Z'),
  frequency: 'weekdays', clock: '09:15', weekday: '1', cron: '15 9 * * 1-5', timezone: 'America/New_York', model: 'slot_2', notify: true,
  creationId: crypto.randomUUID(), request: null, ...patch });
const entry = (input = values()): PromptDraftEntry => ({ id: 'pdr_' + crypto.randomUUID(), sourceId: 'scheduled_prompt', original: promptEditOriginal(saved()),
  revision: 1, updatedAt: now, status: 'editing', values: input });
const pending = () => { const copy = entry(values({ prompt: 'My new request' })); copy.status = 'unknown'; copy.attempt = crypto.randomUUID();
  copy.values.updateRequest = promptDraftUpdate(copy.values, copy.original!, { model: true, notify: true }); return copy; };
const setup = () => {
  const raw = new Map<string, string>(); let blocked = false;
  const storage = { getItem: (key: string) => raw.get(key) ?? null, setItem(key: string, value: string) { if (blocked) throw Error('quota'); raw.set(key, value); },
    removeItem(key: string) { if (blocked) throw Error('quota'); raw.delete(key); } };
  const store = createPromptRecoveryStore({ scope: 'pair-a', storage, now: () => now });
  return { raw, storage, store, block: (value: boolean) => { blocked = value; }, checkpoint: createPromptDraftCheckpoint({ store, now: () => now, changed() {} }) };
};

it('retains full Unicode original, edited input and the exact update without keeping outcomes or permission state', () => {
  const f = setup(), copy = pending(), text = '文'.repeat(32000);
  copy.original = promptEditOriginal(saved({ prompt: text, last_outcome: { status: 'needs_approval', plan_id: 'plan' } }));
  copy.values.prompt = text; copy.values.updateRequest = promptDraftUpdate(copy.values, copy.original, { model: true, notify: true });
  expect(f.store.save(copy)).toBe(true); expect(f.store.get(copy.id)).toEqual(copy);
  expect(copy.original).not.toHaveProperty('last_outcome'); expect(copy.original).not.toHaveProperty('next_run_at');
  expect(createPromptRecoveryStore({ scope: 'pair-b', storage: f.storage, now: () => now }).list()).toEqual([]);
});

it('allows incomplete edit input but refuses invalid original identities, managed prompts and changed schedule modes', () => {
  const copy = entry(values({ title: '', prompt: '', clock: '', timezone: 'America/', cron: '*/' }));
  expect(parsePromptRecovery(copy, now)).toEqual(copy);
  for (const patch of [{ schedule_id: '' }, { revision: 0 }, { time_zone: 'Bad/Zone' }, { created_at: NaN }, { managed_by: 'agenda' }])
    expect(parsePromptRecovery({ ...copy, original: { ...copy.original, ...patch } }, now)).toBeNull();
  expect(parsePromptRecovery({ ...copy, values: { ...copy.values, mode: 'one_shot' } }, now)).toBeNull();
});

it('binds every pending update to the original schedule, revision and immutable edited settings', () => {
  const copy = pending(); expect(parsePromptRecovery(copy, now)).toEqual(copy);
  for (const patch of [{ schedule_id: 'another' }, { expected_revision: 5 }, { title: 'Other title' }, { prompt: 'Other request' },
    { time_zone: 'UTC' }, { cron_expression: '0 9 * * *' }, { model_source_id: null }, { notify_on_done: false }, { creation_id: crypto.randomUUID() }, { mode: 'recurring' }])
    expect(parsePromptRecovery({ ...copy, values: { ...copy.values, updateRequest: { ...copy.values.updateRequest, ...patch } } }, now)).toBeNull();
  expect(parsePromptRecovery({ ...copy, values: { ...copy.values, request: { creation_id: copy.values.creationId } } }, now)).toBeNull();
  expect(parsePromptRecovery({ ...copy, original: null }, now)).toBeNull();
});

it('leaves untouched edits unsaved, flushes changed text and requires read-back before Keep can close', () => {
  const f = setup(), input = values(); f.checkpoint.begin(input, undefined, saved()); expect(f.checkpoint.flush()).toBe(true); expect(f.store.list()).toEqual([]);
  f.checkpoint.capture({ ...input, prompt: '\n  Exact revised request.  ' }); expect(f.checkpoint.flush()).toBe(true);
  expect(f.store.list()[0]?.values.prompt).toBe('\n  Exact revised request.  ');
  f.block(true); f.checkpoint.capture({ ...input, title: 'Latest revision' }); expect(f.checkpoint.keepForLater()).toBe(false);
  f.block(false); expect(f.checkpoint.keepForLater()).toBe(true); expect(f.store.list()[0]?.values.title).toBe('Latest revision');
});

it('blocks dispatch if the pending edit cannot be stored and retains the exact request after an unknown result', () => {
  const f = setup(), copy = pending(); f.checkpoint.begin(copy.values, undefined, copy.original);
  f.block(true); expect(f.checkpoint.startAttempt(copy.values)?.blocked).toBe(true); expect(f.store.list()).toEqual([]);
  f.block(false); const ticket = f.checkpoint.startAttempt(copy.values)!;
  expect(f.store.get(ticket.id)).toMatchObject({ status: 'pending', original: copy.original, values: { updateRequest: copy.values.updateRequest } });
  f.checkpoint.settle(ticket, 'unknown'); expect(f.store.get(ticket.id)?.status).toBe('unknown');
  expect(f.store.get(ticket.id)?.values.updateRequest).toEqual(copy.values.updateRequest); f.checkpoint.suspend();
});

it('fences settlement, discard and overwrite against a silently changed copy at the same revision', () => {
  const f = setup(), copy = pending(); f.checkpoint.begin(copy.values, undefined, copy.original);
  const ticket = f.checkpoint.startAttempt(copy.values)!, current = f.store.get(ticket.id)!;
  const newer = { ...current, values: { ...current.values, prompt: 'Changed elsewhere', updateRequest: { ...current.values.updateRequest!, prompt: 'Changed elsewhere' } } };
  expect(f.store.save(newer)).toBe(true); f.checkpoint.settle(ticket, 'confirmed'); expect(f.store.get(ticket.id)).toEqual(newer);
  expect(f.checkpoint.discard()).toBe(false); expect(f.checkpoint.keepForLater()).toBe(false); f.checkpoint.suspend();
});

it('retains unconfirmed edits without aging them out and releases their immutable request only after a definite refusal', () => {
  const f = setup(), copy = pending(); expect(f.store.save(copy)).toBe(true);
  expect(createPromptRecoveryStore({ scope: 'pair-a', storage: f.storage, now: () => now + 8 * 86_400_000 }).get(copy.id)).toEqual(copy);
  f.checkpoint.begin(copy.values, copy); const ticket = f.checkpoint.startAttempt(copy.values)!; f.checkpoint.settle(ticket, 'refused');
  expect(f.store.get(copy.id)).toMatchObject({ status: 'editing', values: { request: null } }); expect(f.store.get(copy.id)?.values.updateRequest).toBeUndefined();
  expect(f.checkpoint.discard()).toBe(true);
});

it('checks saved settings without treating a later run, missing prompt or changed lifetime as a writable original', () => {
  const original = promptEditOriginal(saved());
  expect(checkPromptEdit(original, saved({ last_status: 'failed', last_run_at: now, last_outcome: { status: 'failed' } }))).toBe('unchanged');
  expect(checkPromptEdit(original, undefined)).toBe('missing');
  expect(checkPromptEdit(original, saved({ session_id: 'other' }))).toBe('replaced');
  expect(checkPromptEdit(original, saved({ created_at: now }))).toBe('replaced');
  expect(checkPromptEdit(original, saved({ revision: 5, enabled: false }))).toBe('changed');
  expect(checkPromptEdit(original, saved({ prompt: 'Silent same-revision change' }))).toBe('changed');
  const once = saved({ mode: 'one_shot', run_at: now - 1000, enabled: false });
  const definition = promptEditOriginal(once), input = values({ mode: 'one_shot', prompt: 'Revised finished request', oneOffZone: once.time_zone,
    time: '2026-10-31T07:59', chosenAt: now - 1000 });
  expect(checkPromptEdit(definition, once)).toBe('unchanged');
  const update = promptDraftUpdate(input, definition, { model: true, notify: true });
  expect(checkPromptEdit(definition, { ...once, revision: once.revision + 1, prompt: update.prompt! }, update)).toBe('matches');
});

it('confirms only the exact intended next revision while preserving activation state and refusing ambiguous later revisions', () => {
  const copy = pending(), request = copy.values.updateRequest!, after = saved({ revision: 5, prompt: request.prompt });
  expect(checkPromptEdit(copy.original!, after, request)).toBe('matches');
  expect(checkPromptEdit(copy.original!, saved(), request)).toBe('unchanged');
  for (const patch of [{ revision: 6 }, { enabled: false }, { prompt: 'Different' }, { model_source_id: 'slot_1' as const }, { notify_on_done: false }])
    expect(checkPromptEdit(copy.original!, { ...after, ...patch }, request)).toBe('changed');
});

it('combines edits to different fields with current saved values and preserves current pause state', () => {
  const original = saved(), current = saved({ title: 'Saved new title', revision: 5, enabled: false, model_source_id: 'slot_1', notify_on_done: false });
  const input = values({ prompt: '\n My revised request  ' }), comparison = comparePromptEdits(original, input, current);
  expect(unresolvedPromptEdits(comparison)).toBe(0); const merged = mergePromptEdits(comparison)!;
  expect(merged).toMatchObject({ title: 'Saved new title', prompt: '\n My revised request  ', model: 'slot_1', notify: false });
  expect(promptDraftUpdate(merged, current, { model: true, notify: true })).toMatchObject({ schedule_id: original.schedule_id, expected_revision: 5, prompt: 'My revised request' });
  expect(merged).not.toHaveProperty('enabled'); expect(merged).not.toHaveProperty('updateRequest');
});

it('requires a choice for conflicting fields and keeps a repeated-hour instant and its timezone together', () => {
  const original = saved({ mode: 'one_shot', run_at: Date.parse('2026-11-01T05:30:42.123Z'), cron_expression: undefined });
  const current = { ...original, revision: 5, run_at: Date.parse('2026-11-01T07:00Z'), prompt: 'Saved request' };
  const input = values({ mode: 'one_shot', prompt: 'My request' }), comparison = comparePromptEdits(original, input, current);
  expect(unresolvedPromptEdits(comparison)).toBe(2); expect(mergePromptEdits(comparison)).toBeNull();
  comparison.choices = { prompt: 'mine', timing: 'mine' }; const merged = mergePromptEdits(comparison)!;
  expect(merged.prompt).toBe('My request'); expect(merged.chosenAt).toBe(Date.parse('2026-11-01T06:30:42.123Z'));
  expect(promptDraftUpdate(merged, current, { model: true, notify: true }).run_at).toBe('2026-11-01T06:30:42.123Z');
  comparison.choices.timing = 'saved'; expect(mergePromptEdits(comparison)?.chosenAt).toBe(current.run_at);
});

it('persists a reviewed base before preparing edits, and Search finds that existing edit without indexing IDs', () => {
  const f = setup(), copy = entry(values({ title: 'Renamed kept title', prompt: 'Kestrel updated request' })); expect(f.store.save(copy)).toBe(true); f.checkpoint.begin(copy.values, copy);
  const current = saved({ revision: 5, title: 'Current title', enabled: false }), comparison = comparePromptEdits(copy.original!, copy.values, current);
  comparison.choices.title = 'mine'; const merged = mergePromptEdits(comparison)!;
  expect(f.checkpoint.rebase(current, merged)).toBe(true); const prepared = f.checkpoint.current()!;
  expect(prepared.original).toEqual(promptEditOriginal(current)); expect(f.store.get(copy.id)).toEqual(prepared);
  expect(searchRecoveryDrafts({ prompt: f.store }, 'Kestrel').matches[0]).toMatchObject({ kind: 'prompt', editingExisting: true });
  expect(searchRecoveryDrafts({ prompt: f.store }, 'Current title').matches[0]?.editingExisting).toBe(true);
  expect(searchRecoveryDrafts({ prompt: f.store }, current.schedule_id).matches).toEqual([]); f.checkpoint.suspend();
});

it('requires explicit choices when a current server cannot confirm kept model or notification settings', () => {
  const current = saved({ model_source_id: undefined, notify_on_done: undefined }), comparison = comparePromptEdits(saved(), values(), current);
  expect(unresolvedPromptEdits(comparison)).toBe(2); expect(comparison.rows.every(row => row.saved === 'Not confirmed by this server')).toBe(true);
  comparison.choices = { model: 'saved', notify: 'saved' }; expect(mergePromptEdits(comparison)).toMatchObject({ model: '', notify: false });
  comparison.choices = { model: 'mine', notify: 'mine' }; expect(mergePromptEdits(comparison)).toMatchObject({ model: 'slot_2', notify: true });
});
