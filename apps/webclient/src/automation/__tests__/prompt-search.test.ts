import { expect, it, vi } from 'vitest';
import { RpcError, parseSavedDataViewDefinition, sameSavedDataViewDefinition, type PromptSchedule } from '@recued/contracts';
import { createPromptSearch, promptMatchesQuery, promptScheduleHref, promptScheduleIdentity, readPromptSchedules } from '../prompt-search.js';
import { renderUniversalSearch } from '../../data/universal-search.js';
import { filterUniversalSearch, searchTypeCounts } from '../../data/universal-search-filter.js';
import { promptSearchTimingText } from '../prompt-search-timing.js';

const now = Date.parse('2026-11-01T06:30Z');
const row = (patch: Partial<PromptSchedule> = {}): PromptSchedule => ({ schedule_id: 'ps_cafe', session_id: 'scheduled-cafe',
  title: 'Café renewal', prompt: '  Keep the exact\ncustomer context. 😀  ', mode: 'recurring', time_zone: 'America/New_York',
  cron_expression: '30 1 * * *', enabled: true, revision: 1, created_at: now - 1000, next_run_at: now,
  last_run_at: null, last_turn_id: null, last_status: null, ...patch });
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };

it('finds normalized words across titles, request text and saved timing without indexing identities or changing the saved request', () => {
  const saved = row();
  expect(promptMatchesQuery(saved, '  CAFE\u0301  CUSTOMER \n context 😀 ')).toBe(true);
  expect(promptMatchesQuery(saved, 'renewal missing')).toBe(false);
  expect(promptMatchesQuery(saved, saved.session_id)).toBe(false);
  expect(promptMatchesQuery(saved, 'America/New_York')).toBe(true);
  expect(readPromptSchedules([saved])[0]?.prompt).toBe('  Keep the exact\ncustomer context. 😀  ');
  expect(promptScheduleHref('id/with #?')).toBe('#automation/schedules/prompt/id%2Fwith%20%23%3F');
});

it('requires a complete bounded list with valid identities, dates and rendered metadata instead of inventing an empty result', () => {
  const complete = Array.from({ length: 200 }, (_, n) => row({ schedule_id: 'ps_' + n }));
  expect(readPromptSchedules(complete)).toHaveLength(200);
  expect(readPromptSchedules([row({ managed_by: 'agenda' })])).toEqual([]);
  for (const malformed of [undefined, { items: [] }, [...complete, row()], [row(), row()], [null],
    [row({ revision: 0 })], [row({ next_run_at: NaN })], [row({ time_zone: 'America/Invalid' })],
    [row({ model_source_id: 'invented' as never })], [row({ run_now_available: 'yes' as never })],
    [row({ last_status: 'invented' as never })], [row({ last_outcome: { status: 'failed', reason: 'invented' as never } })],
    [row({ skip_state: { revision: -1 } })], [row({ skip_state: { revision: 1, next: { run_at: now + 60000 } } })],
    [row({ skip_state: { revision: 1, skipped: { skip_id: 'skip', run_at: now, following_run_at: now - 1, undo_available: true } } })],
    [row({ pending_approvals: { count: 0, plan_id: 'plan' } })]]) {
    expect(() => readPromptSchedules(malformed)).toThrow('could not be confirmed');
  }
  expect(readPromptSchedules([row({ last_status: 'withdrawn' })])[0]?.last_status).toBe('withdrawn');
  expect(readPromptSchedules([row({ skip_state: { revision: 0, next: { run_at: now } } })])[0]?.skip_state?.next?.run_at).toBe(now);
});

it('fetches once per visit and applies each new query to the complete list, including while the first read waits', async () => {
  const held = deferred<PromptSchedule[]>(), caller = vi.fn(() => held.promise), changed = vi.fn();
  const search = createPromptSearch(caller, changed);
  const first = search.load('renewal'); search.setQuery('other');
  await Promise.resolve(); held.resolve([row(), row({ schedule_id: 'other', title: 'Other task' })]); await first;
  expect(search.state()).toMatchObject({ query: 'other', loaded: true, loading: false });
  expect(search.state().matches.map(item => item.schedule_id)).toEqual(['other']);
  await search.load('customer café'); expect(search.state().matches.map(item => item.schedule_id)).toEqual(['ps_cafe']);
  expect(caller).toHaveBeenCalledTimes(1);
  const snapshot = search.snapshot(); search.reset(); search.restore(snapshot); await search.load('renewal');
  expect(caller).toHaveBeenCalledTimes(1); expect(search.state().matches).toHaveLength(1);
});

it('preserves confirmed results when refresh fails, distinguishes unsupported servers and can retry', async () => {
  const caller = vi.fn<() => Promise<PromptSchedule[]>>().mockResolvedValueOnce([row()]).mockRejectedValueOnce(Error('Refresh interrupted'))
    .mockRejectedValueOnce(new RpcError('unknown_method', 'Old server', 404)).mockResolvedValueOnce([]);
  const search = createPromptSearch(caller, () => {}); await search.load('café'); await search.load('café', true);
  expect(search.state()).toMatchObject({ loaded: true, loading: false, error: 'Refresh interrupted' });
  expect(search.state().matches).toHaveLength(1); await search.load('café', true);
  expect(search.state().unsupported).toBe(true); expect(search.state().matches).toHaveLength(1);
  await search.load('café', true); expect(search.state()).toMatchObject({ matches: [], loaded: true, loading: false, unsupported: false });
  expect(search.state().error).toBeUndefined();
});

it('rechecks the selected lifetime and configuration, including silent changes at the same revision', async () => {
  let current = row(); const search = createPromptSearch(async () => [current], () => {}); await search.load('café');
  const selected = search.state().matches[0]!;
  current = row({ prompt: 'Changed without a new revision' });
  await expect(search.resolve(selected)).rejects.toThrow('changed'); expect(search.state().rows[0]).toEqual(current);
  expect(promptScheduleIdentity(row({ created_at: now }))).not.toBe(promptScheduleIdentity(selected));
  expect(promptScheduleIdentity(row({ enabled: false }))).not.toBe(promptScheduleIdentity(selected));
  expect(promptScheduleIdentity(row({ model_source_id: 'slot_2' }))).not.toBe(promptScheduleIdentity(selected));
  expect(promptScheduleIdentity(row({ notify_on_done: true }))).not.toBe(promptScheduleIdentity(selected));
  current = row({ last_run_at: now, last_status: 'failed', last_outcome: { status: 'needs_attention', reason: 'tool_failed' } });
  expect(await search.resolve(selected)).toEqual(current);
});

it('refreshes removed selections without substituting another prompt', async () => {
  const caller = vi.fn<() => Promise<PromptSchedule[]>>().mockResolvedValueOnce([row()]).mockResolvedValueOnce([row({ schedule_id: 'other' })]);
  const search = createPromptSearch(caller, () => {}); await search.load('café');
  await expect(search.resolve(search.state().matches[0]!)).rejects.toThrow('removed');
  expect(search.state().matches.map(item => item.schedule_id)).toEqual(['other']);
});

it('fences pending selection against a newer query, refresh, reset or disposal', async () => {
  for (const boundary of ['query', 'refresh', 'reset', 'dispose']) {
    const held = deferred<PromptSchedule[]>(); const caller = vi.fn<() => Promise<PromptSchedule[]>>().mockResolvedValueOnce([row()]).mockReturnValueOnce(held.promise).mockResolvedValue([row()]);
    const search = createPromptSearch(caller, () => {}); await search.load('café'); const opening = search.resolve(search.state().matches[0]!);
    if (boundary === 'query') search.setQuery('newer');
    if (boundary === 'refresh') await search.load('newer', true);
    if (boundary === 'reset') search.reset();
    if (boundary === 'dispose') search.dispose();
    held.resolve([row()]); expect(await opening).toBeNull();
    if (boundary === 'query' || boundary === 'refresh') expect(search.state().query).toBe('newer');
  }
});

it('retires late list responses after reset, refresh and disposal', async () => {
  const first = deferred<PromptSchedule[]>(), last = deferred<PromptSchedule[]>();
  const caller = vi.fn<() => Promise<PromptSchedule[]>>().mockReturnValueOnce(first.promise).mockReturnValueOnce(last.promise);
  const changed = vi.fn(), search = createPromptSearch(caller, changed);
  const a = search.load('old'); search.reset(); const b = search.load('new');
  last.resolve([row({ title: 'New request' })]); await b; const confirmed = search.snapshot();
  first.resolve([row()]); await a; expect(search.snapshot()).toEqual(confirmed);
  const held = deferred<PromptSchedule[]>(); caller.mockReturnValueOnce(held.promise);
  const c = search.load('again', true); search.dispose(); const calls = changed.mock.calls.length;
  held.resolve([]); await c; expect(changed).toHaveBeenCalledTimes(calls);
});

it('renders escaped request excerpts, saved-zone next runs and attention status in the selected type with honest counts', async () => {
  const search = createPromptSearch(async () => [row({ title: 'Café <img>', pending_approvals: { count: 1, plan_id: 'plan' },
    prompt: 'Before '.repeat(80) + 'Customer <script>alert(1)</script> renewal' })], () => {});
  await search.load('customer'); const props = { query: 'customer', actionAttr: 'data-action', resultType: 'scheduled_prompt' as const,
    promptSearch: search.state(), groups: [], workGroups: [], recipes: [], packs: [] };
  expect(searchTypeCounts(props).scheduled_prompt).toEqual({ loaded: 1, more: false, pending: false, unavailable: false });
  const html = renderUniversalSearch(props);
  expect(html).toContain('#automation/schedules/prompt/ps_cafe'); expect(html).toContain('Café &lt;img&gt;');
  expect(html).toContain('&lt;script&gt;'); expect(html).not.toContain('<script>');
  expect(html).toContain('Active · Needs you'); expect(html).toContain('2026-11-01T06:30:00.000Z');
  expect(html).toContain('GMT-5'); expect(html).toContain('America/New_York');
  expect(filterUniversalSearch(props, 'mail').promptSearch).toBeUndefined();
  expect(renderUniversalSearch({ ...props, query: '' })).toContain('Open scheduled prompt');
});

it('does not claim an empty search or offer a cloud search when saved prompts are pending or unavailable', async () => {
  const search = createPromptSearch(async () => [], () => {}); await search.load('customer');
  const props = { query: 'customer', actionAttr: 'data-action', groups: [], workGroups: [], recipes: [], packs: [], marketplaceOffered: true };
  for (const patch of [{ loading: true }, { error: 'Could not read saved prompts' }, { unsupported: true }]) {
    const html = renderUniversalSearch({ ...props, promptSearch: { ...search.state(), ...patch } });
    expect(html).not.toContain('No matches in the searched sources'); expect(html).not.toContain('universal-search-marketplace');
  }
  const html = renderUniversalSearch({ ...props, promptSearch: { ...search.state(), matches: [row()] } });
  expect(html).toContain('Open scheduled prompt'); expect(html).not.toContain('universal-search-marketplace');
});

it('roundtrips a saved Scheduled prompts view without broadening it to All', () => {
  const saved = { tab: 'search' as const, query: 'customer', result_type: 'scheduled_prompt' as const };
  expect(parseSavedDataViewDefinition(saved)).toEqual(saved);
  expect(sameSavedDataViewDefinition(saved, { tab: 'search', query: 'customer' })).toBe(false);
});

it('finds declared weekdays, monthly dates, clock times and timezone cities across saved timing fields', () => {
  const selected = row({ title: 'Review', prompt: 'Read the notes.', cron_expression: '15 9 * * 2,4', time_zone: 'Asia/Tokyo' });
  expect(promptMatchesQuery(selected, 'Thursday Tokyo 09:15')).toBe(true);
  expect(promptMatchesQuery(selected, 'Friday Tokyo')).toBe(false);
  expect(promptMatchesQuery(row({ cron_expression: '0 9 31 * *' }), 'monthly 31 New York')).toBe(true);
  expect(promptMatchesQuery(row({ cron_expression: '0 9 1 1 *' }), 'monthly')).toBe(false);
  expect(promptMatchesQuery(row({ cron_expression: '0 9 * * *' }), 'Thursday')).toBe(true);
  expect(promptMatchesQuery(row({ cron_expression: '0 9 * * 1-5' }), 'Sunday')).toBe(false);
  const custom = row({ cron_expression: '5,35 8-17 * * 1-5' });
  expect(promptMatchesQuery(custom, 'Thursday')).toBe(true);expect(promptMatchesQuery(custom, '09:00')).toBe(false);
});

it('searches one-offs in their saved timezone and excludes inactive timing and activity dates', () => {
  const once = row({ mode: 'one_shot', run_at: Date.parse('2026-11-05T00:30Z'), time_zone: 'America/Los_Angeles', cron_expression: '0 9 * * 4' });
  expect(promptMatchesQuery(once, 'Wednesday Los Angeles 16:30')).toBe(true);
  expect(promptMatchesQuery(once, 'Thursday')).toBe(false);
  const recurring = row({ cron_expression: '0 9 * * 1', run_at: once.run_at, next_run_at: once.run_at!, last_run_at: once.run_at! });
  expect(promptMatchesQuery(recurring, 'Wednesday')).toBe(false);
  expect(promptMatchesQuery(recurring, '2026-11-05')).toBe(false);
});

it('does not turn private identifiers or unrelated operational fields into timing matches', () => {
  const saved = row({ title: 'Review', prompt: 'Read notes.', cron_expression: '0 9 * * 1', time_zone: 'Europe/Paris',
    schedule_id: 'ps_thursday_tokyo', session_id: 'chat_monthly', run_request_scope: 'monthly_31', model_source_id: 'slot_2' });
  for (const query of ['Tokyo', 'Thursday', 'monthly', 'slot_2', saved.schedule_id, saved.session_id])expect(promptMatchesQuery(saved, query)).toBe(false);
});

it('refreshes cached timing when a row object receives new configuration without losing later request edits', () => {
  const saved = row({ cron_expression: '0 9 * * 1', time_zone: 'Asia/Tokyo' });
  expect(promptMatchesQuery(saved, 'Monday Tokyo')).toBe(true);
  Object.assign(saved, { cron_expression: '15 11 * * 4', time_zone: 'Europe/Paris' });
  expect(promptMatchesQuery(saved, 'Monday Tokyo')).toBe(false);expect(promptMatchesQuery(saved, 'Thursday Paris 11:15')).toBe(true);
  saved.prompt = 'A completely new zebrafish request.';expect(promptMatchesQuery(saved, 'zebrafish')).toBe(true);
});

it('shows and safely highlights the actual metadata terms that supplied a match', async () => {
  const saved = row({ title: 'Review <img>', prompt: 'Read <script>notes</script>.', cron_expression: '15 9 * * 1-5', time_zone: 'Asia/Tokyo' });
  const query = 'Thursday Tokyo 09:15', search = createPromptSearch(async () => [saved], () => {});await search.load(query);
  const html = renderUniversalSearch({ query, actionAttr: 'data-action', resultType: 'scheduled_prompt', promptSearch: search.state() });
  for (const term of ['Thursday', 'Tokyo', '09', '15'])expect(html).toContain(`<mark>${term}</mark>`);
  expect(promptSearchTimingText(saved, query)).toContain('09:15');
  expect(html).toContain('Review &lt;img&gt;');expect(html).not.toContain('<script>');
  expect(promptSearchTimingText(saved, '')).not.toContain('Thursday');expect(promptSearchTimingText(saved, query)).toContain('Thursday');
});

it('escapes unrecognized saved timing instead of treating its text as result markup', async () => {
  const saved = row({ title: 'Review', prompt: 'Read notes.', cron_expression: '0 9 <img onerror=alert(1)> * *' });
  const search = createPromptSearch(async () => [saved], () => {});await search.load('img');expect(search.state().matches).toHaveLength(1);
  const html = renderUniversalSearch({ query: 'img', actionAttr: 'data-action', resultType: 'scheduled_prompt', promptSearch: search.state() });
  expect(html).toContain('&lt;');expect(html).not.toContain('<img');
});
