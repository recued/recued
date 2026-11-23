import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TRANSPARENCY_STREAM_SETTINGS,
  TIER1_TOOL_NAMES,
  type ChatMessage,
  type ChatToolCall,
  type ChatToolCallRecord,
  type TransparencyEvent,
  type TransparencyStreamSettings,
} from '@recued/contracts';

import {
  callLabel,
  callName,
  callWords,
  projectInFlightActivity,
  projectMessageActivity,
  projectSettledCallNotices,
  projectTransparencyNote,
} from '../chat/activity.js';
import type { InFlightTurn } from '../chat/state.js';

const checkMark = String.fromCodePoint(0x2713);
const rightArrow = String.fromCodePoint(0x2192);

const toolCall = (overrides: Partial<ChatToolCall> = {}): ChatToolCall => ({
  tool_name: 'mail.search',
  tier: 1,
  args: { q: 'ops' },
  status: 'started',
  started_at: 1_000,
  ...overrides,
});

const chatMessage = (overrides: Partial<ChatMessage> = {}): ChatMessage => ({
  id: 'msg_1',
  session_id: 'sess_1',
  role: 'assistant',
  contributor: 'model',
  content: 'done',
  target_server: 'self',
  picker_at_send: {
    display_name: 'This server',
    signature: {
      server_kind: 'recued',
      version: '1.0',
      instance_id: 'server_1',
    },
  },
  model_used: { provider: 'local', model_id: 'local-default' },
  ts: 2_000,
  ...overrides,
});

describe('chat activity projections', () => {
  it('puts progress on its exact running call and removes it when that call settles', () => {
    const turn: InFlightTurn = { turn_id: 'turn-progress', assistant_content: '', transparency: [],
      tool_calls: [{ ...toolCall(), call_id: 'call-a' }, { ...toolCall(), call_id: 'call-b' }] };
    const record: ChatToolCallRecord = { message_id: 'call-b', session_id: 'sess_1', turn_id: turn.turn_id,
      tool_name: 'mail.search', state: 'running', started_at: 1, updated_at: 2,
      progress: { kind: 'provider', current: 3, total: 10 } };
    const rows = projectInFlightActivity(turn, undefined, { 'call:call-b': record });
    expect(rows.map(row => row.text)).toEqual(['searching your mail...', 'searching your mail... · Tool progress: 3 of 10']);
    const settled = projectInFlightActivity(turn, undefined, { 'call:call-b': { ...record, state: 'succeeded' } });
    expect(settled.map(row => row.text)).toEqual(['searching your mail...', 'searching your mail...']);
  });
  it('projects tool rows for started, ok, and error statuses', () => {
    // Case 1.
    const rows = projectMessageActivity(
      chatMessage({
        tool_calls: [
          toolCall({ status: 'started' }),
          toolCall({ status: 'ok' }),
          toolCall({
            status: 'error',
            reason: 'connection_unavailable',
          }),
          toolCall({ status: 'error' }),
        ],
      }),
    );

    expect(rows).toEqual([
      { kind: 'tool', text: 'searching your mail...', status: 'started' },
      {
        kind: 'tool',
        text: 'searched your mail ' + checkMark,
        status: 'ok',
      },
      {
        kind: 'tool',
        text: 'couldn\'t search your mail: its connection is not available',
        status: 'error',
      },
      {
        kind: 'tool',
        text: 'couldn\'t search your mail: it failed',
        status: 'error',
      },
    ]);
  });

  it('returns verbatim chat.channel_note text and drops empty notes', () => {
    // Case 2.
    expect(
      projectTransparencyNote({
        kind: 'chat.channel_note',
        note: 'Recued is checking the latest context.',
      }),
    ).toBe('Recued is checking the latest context.');
    expect(projectTransparencyNote({ kind: 'chat.channel_note', note: '   ' }))
      .toBeNull();
  });

  it('renders a valid memory_lookup event through the template registry', () => {
    // Case 3.
    const event = {
      kind: 'memory_lookup',
      query_summary: 'family context',
      result_count: 3,
    } satisfies TransparencyEvent;

    expect(projectTransparencyNote(event)).toBe(
      'checking family context... ' + rightArrow + ' 3 found',
    );
  });

  it('drops valid-kind malformed payloads before template substitution', () => {
    // Case 4.
    const note = projectTransparencyNote({
      kind: 'extraction.detected',
    });

    expect(note).toBeNull();
  });

  it('drops valid failure-class payloads because PB7 failure paint owns them', () => {
    // Case 5.
    const event = {
      kind: 'engine.decoder_unavailable',
      reason: 'no_source',
      site: 'initial',
    } satisfies TransparencyEvent;

    expect(projectTransparencyNote(event)).toBeNull();
  });

  it('drops valid orchestration-class payloads under default stream settings', () => {
    // Case 6.
    const event = {
      kind: 'recued.token_usage',
      input_tokens: 100,
      output_tokens: 25,
      total_tokens: 125,
    } satisfies TransparencyEvent;

    expect(projectTransparencyNote(event)).toBeNull();
  });

  it('drops silent templates and hidden default tiers', () => {
    // Case 7.
    const silent = {
      kind: 'cascade.fired',
      recipe_id: 'recipe_1',
    } satisfies TransparencyEvent;
    const hidden = {
      kind: 'engine.gate_short_circuit',
      template_hash: 'abc123456789',
    } satisfies TransparencyEvent;

    expect(projectTransparencyNote(silent)).toBeNull();
    expect(projectTransparencyNote(hidden)).toBeNull();
  });

  it('drops non-object payloads and unknown kinds', () => {
    // Case 8.
    expect(projectTransparencyNote('not an event')).toBeNull();
    expect(projectTransparencyNote(null)).toBeNull();
    expect(projectTransparencyNote({ kind: 'chat.unknown', note: 'nope' }))
      .toBeNull();
  });

  it('orders in-flight transparency notes before tool rows and drops plan entries', () => {
    // Case 9. Plan proposals project NO narrative row — the § A.11
    // plan-approval card (state.ts `plan_cards`) is their canonical
    // paint, and a narrative echo would double-paint it. Stray
    // `plan_proposed` scaffold entries (the pre-card shape) fall
    // through the transparency validator and drop silently.
    const turn: InFlightTurn = {
      turn_id: 'turn_1',
      assistant_content: '',
      transparency: [
        {
          kind: 'transparency',
          payload: { kind: 'chat.channel_note', note: 'checking recent memory' },
        },
        {
          kind: 'plan_proposed',
          payload: { plan_id: 'plan_1', tool: 'crm.update' },
        },
        {
          kind: 'plan_proposed',
          payload: { plan_id: 'plan_malformed' },
        },
      ],
      tool_calls: [
        {
          tool_name: 'mail.search',
          tier: 1,
          args: { q: 'ops' },
          status: 'started',
        },
        {
          tool_name: 'calendar.create',
          tier: 1,
          args: { title: 'Review' },
          status: 'error',
        },
      ],
    };

    expect(projectInFlightActivity(turn)).toEqual([
      { kind: 'note', text: 'checking recent memory' },
      { kind: 'tool', text: 'searching your mail...', status: 'started' },
      {
        kind: 'tool',
        text: 'couldn\'t add a calendar event: it failed',
        status: 'error',
      },
    ]);
  });

  it('projects completed assistant tool_calls and ignores non-assistant rows', () => {
    // Case 10.
    expect(
      projectMessageActivity(
        chatMessage({
          tool_calls: [toolCall({ status: 'ok' })],
        }),
      ),
    ).toEqual([
      {
        kind: 'tool',
        text: 'searched your mail ' + checkMark,
        status: 'ok',
      },
    ]);
    expect(projectMessageActivity(chatMessage({ role: 'user' }))).toEqual([]);
    expect(projectMessageActivity(chatMessage())).toEqual([]);
  });

  // D-259 §6.1 retired (2026-10-05): chat no longer offers to keep a run as a
  // dish. Calls stored before then still carry `dish_promotable: true`, and the
  // row they project to must not.
  it('carries run and standing-dish addresses into rows, and drops a retired promotion mark', () => {
    const storedBeforeRetirement = Object.assign(
      toolCall({ status: 'ok', run_id: 'run_259' }),
      { dish_promotable: true },
    );
    expect(
      projectMessageActivity(
        chatMessage({
          tool_calls: [
            storedBeforeRetirement,
            toolCall({
              status: 'ok',
              run_id: 'run_260',
              dish_id: 'dsh_standing',
            }),
          ],
        }),
      ),
    ).toEqual([
      {
        kind: 'tool',
        text: 'searched your mail ' + checkMark,
        status: 'ok',
        run_id: 'run_259',
      },
      {
        kind: 'tool',
        text: 'searched your mail ' + checkMark,
        status: 'ok',
        run_id: 'run_260',
        dish_id: 'dsh_standing',
      },
    ]);
  });
});

describe('chat activity transparency settings', () => {
  it('suppresses channel notes when the master transparency setting is off', () => {
    const disabled: TransparencyStreamSettings = {
      ...DEFAULT_TRANSPARENCY_STREAM_SETTINGS,
      enabled: false,
    };
    const note = {
      kind: 'chat.channel_note',
      note: 'Recued is checking the latest context.',
    };

    expect(projectTransparencyNote(note, disabled)).toBeNull();
    expect(projectTransparencyNote(note, DEFAULT_TRANSPARENCY_STREAM_SETTINGS))
      .toBe('Recued is checking the latest context.');
  });

  it('renders orchestration events only when that class is enabled', () => {
    const event = {
      kind: 'recued.token_usage',
      input_tokens: 100,
      output_tokens: 25,
      total_tokens: 125,
    } satisfies TransparencyEvent;
    const orchestrationOn: TransparencyStreamSettings = {
      ...DEFAULT_TRANSPARENCY_STREAM_SETTINGS,
      visible_classes: {
        ...DEFAULT_TRANSPARENCY_STREAM_SETTINGS.visible_classes,
        orchestration: true,
      },
    };

    expect(projectTransparencyNote(event)).toBeNull();
    expect(projectTransparencyNote(event, orchestrationOn)).toBe(
      '125 tokens (in 100 / out 25)',
    );
  });

  it('projects context-limit stop notes while respecting orchestration visibility', () => {
    const event = {
      kind: 'recued.multi_turn.loop_terminated',
      total_rounds: 3,
      termination_reason: 'context_trim_livelock',
    } satisfies TransparencyEvent;
    const orchestrationOn: TransparencyStreamSettings = {
      ...DEFAULT_TRANSPARENCY_STREAM_SETTINGS,
      visible_classes: {
        ...DEFAULT_TRANSPARENCY_STREAM_SETTINGS.visible_classes,
        orchestration: true,
      },
    };
    const turn: InFlightTurn = {
      turn_id: 'turn_1',
      assistant_content: '',
      transparency: [{ kind: 'transparency', payload: event }],
      tool_calls: [],
    };

    expect(projectTransparencyNote(event, orchestrationOn)).toBe(
      'stopped after 3 rounds — results were repeatedly removed to fit the context window',
    );
    expect(projectInFlightActivity(turn, orchestrationOn)).toEqual([
      {
        kind: 'note',
        text: 'stopped after 3 rounds — results were repeatedly removed to fit the context window',
      },
    ]);
    expect(projectInFlightActivity(turn)).toEqual([]);
    expect(projectInFlightActivity(turn, { ...orchestrationOn, enabled: false }))
      .toEqual([]);
  });

  it('filters summary-only visible events when the max tier is none', () => {
    const event = {
      kind: 'ai_call',
      tier: 'fast',
      round: 1,
    } satisfies TransparencyEvent;
    const maxNone: TransparencyStreamSettings = {
      ...DEFAULT_TRANSPARENCY_STREAM_SETTINGS,
      max_redaction_tier: 'none',
    };

    expect(projectTransparencyNote(event, maxNone)).toBeNull();
    expect(projectTransparencyNote(event, DEFAULT_TRANSPARENCY_STREAM_SETTINGS))
      .toBe('thinking... (round 1)');
  });

  it('keeps tool rows when master-off settings suppress narrative rows', () => {
    const disabled: TransparencyStreamSettings = {
      ...DEFAULT_TRANSPARENCY_STREAM_SETTINGS,
      enabled: false,
    };
    const turn: InFlightTurn = {
      turn_id: 'turn_1',
      assistant_content: '',
      transparency: [
        {
          kind: 'plan_proposed',
          payload: { plan_id: 'plan_1', tool: 'crm.update' },
        },
        {
          kind: 'transparency',
          payload: {
            kind: 'chat.channel_note',
            note: 'checking recent memory',
          },
        },
      ],
      tool_calls: [
        {
          tool_name: 'mail.search',
          tier: 1,
          args: { q: 'ops' },
          status: 'started',
        },
      ],
    };

    expect(projectInFlightActivity(turn, disabled)).toEqual([
      { kind: 'tool', text: 'searching your mail...', status: 'started' },
    ]);
  });
});

describe('a call that stopped to wait reads as what it is now', () => {
  // Its dispatch QUEUED, so its persisted status is `ok`: the row said
  // "used … ✓" while the call waited, and kept saying it after a refusal.
  const tool = 'recued-core/control-device';
  const record = (overrides: Partial<ChatToolCallRecord>): ChatToolCallRecord => ({
    message_id: 'tool:x', session_id: 'sess_1', turn_id: 't', tool_name: tool, run_id: 'run-1',
    state: 'held', started_at: 1, updated_at: 2, held_at: 2, ...overrides,
  });
  const message = chatMessage({ tool_calls: [toolCall({ tool_name: tool, status: 'ok', run_id: 'run-1' })] });
  const rowFor = (overrides: Partial<ChatToolCallRecord>) =>
    projectMessageActivity(message, { 'run-1': record(overrides) })[0];

  it('says it is waiting, then how it ended', () => {
    expect(rowFor({})).toMatchObject({ text: `waiting to hear back: ${tool}`, status: 'started', run_id: 'run-1' });
    expect(rowFor({ state: 'succeeded' })).toMatchObject({ text: `used ${tool} ${checkMark}`, status: 'ok' });
    expect(rowFor({ state: 'failed', denied: true })).toMatchObject({ text: `didn't run ${tool}: you said no`, status: 'error' });
    expect(rowFor({ state: 'failed' })).toMatchObject({ text: `couldn't run ${tool}: it did not finish`, status: 'error' });
    // D-337 slice R — its approval expired: it never ran, and no one said no.
    expect(rowFor({ state: 'failed', expired: true })).toMatchObject({
      text: `didn't run ${tool}: no one answered in time`, status: 'error' });
    expect(rowFor({ state: 'interrupted' })).toMatchObject({ status: 'error' });
    // No record ⇒ exactly the row it always was.
    expect(projectMessageActivity(message)[0]).toMatchObject({ text: `used ${tool} ${checkMark}`, status: 'ok' });
  });

  it('adds one plain update under the answer once a call that waited has settled', () => {
    const notices = (overrides: Partial<ChatToolCallRecord>) =>
      projectSettledCallNotices(message, { 'run-1': record(overrides) });
    expect(notices({})).toEqual([]);
    expect(notices({ state: 'succeeded' })).toEqual([{ run_id: 'run-1', text: `Update: ${tool} has now finished.` }]);
    expect(notices({ state: 'failed', denied: true })).toEqual([
      { run_id: 'run-1', text: `Update: you said no, so ${tool} did not run.` }]);
    expect(notices({ state: 'failed' })).toEqual([{ run_id: 'run-1', text: `Update: ${tool} did not finish.` }]);
    expect(notices({ state: 'failed', expired: true })).toEqual([
      { run_id: 'run-1', text: `Update: no one answered in time, so ${tool} did not run.` }]);
    // A call that never waited needs no update: its ✓ is already the truth.
    const { held_at: _never, ...neverWaited } = record({ state: 'succeeded' });
    expect(projectSettledCallNotices(message, { 'run-1': neverWaited })).toEqual([]);
    expect(projectSettledCallNotices(message, undefined)).toEqual([]);
    expect(projectSettledCallNotices(chatMessage({ role: 'user' }), { 'run-1': record({ state: 'succeeded' }) })).toEqual([]);
  });
});

describe('D-348 §7.8 — a change a standing permission let a chat write make, undone from its line', () => {
  const receipt = { receipt_id: 'lmr_1', kind: 'local_calendar' as const, committed_at: 3 };
  // A chat's own write has no run: its line finds its record by the call's own row.
  const record = (overrides: Partial<ChatToolCallRecord> = {}): ChatToolCallRecord => ({
    message_id: 'tool:rename', session_id: 'sess_1', turn_id: 't', tool_name: 'calendar.update',
    state: 'succeeded', started_at: 1, updated_at: 3, local_receipt: receipt, ...overrides,
  });
  const message = chatMessage({ tool_calls: [toolCall({ tool_name: 'calendar.update', status: 'ok', call_id: 'tool:rename' })] });

  it('the line carries the change\'s receipt, found by the call\'s own row', () => {
    expect(projectMessageActivity(message, { 'call:tool:rename': record() })[0])
      .toMatchObject({ text: `changed a calendar event ${checkMark}`, status: 'ok', local_receipt_id: 'lmr_1' });
    // Kept under another key, it is still found by its row.
    expect(projectMessageActivity(message, { other: record() })[0]).toMatchObject({ local_receipt_id: 'lmr_1' });
  });

  it('none until the change succeeded, none without a receipt, and none for another call', () => {
    const cases: Array<Record<string, ChatToolCallRecord> | undefined> = [
      { 'call:tool:rename': record({ state: 'running' }) },
      { 'call:tool:rename': record({ local_receipt: undefined }) },
      { 'call:tool:other': record({ message_id: 'tool:other' }) },
      undefined,
    ];
    for (const records of cases) {
      expect(projectMessageActivity(message, records)[0]).not.toHaveProperty('local_receipt_id');
    }
  });

  it('the live row too, by its call', () => {
    const turn = { turn_id: 't', transparency: [], tool_calls: [{ ...toolCall({ tool_name: 'calendar.update', status: 'ok' }), call_id: 'tool:rename' }] };
    expect(projectInFlightActivity(turn as unknown as InFlightTurn, DEFAULT_TRANSPARENCY_STREAM_SETTINGS,
      { 'call:tool:rename': record() })[0]).toMatchObject({ local_receipt_id: 'lmr_1' });
  });
});

describe('a call reads as what it did, in the words its card uses', () => {
  const line = (call: Partial<ChatToolCall>) => projectMessageActivity(chatMessage({ tool_calls: [toolCall(call)] }))[0]!.text;

  it('every chat tool has words for it: its title, in each tense a line needs', () => {
    const missing = TIER1_TOOL_NAMES.filter((tool) => callWords({ tool_name: tool, args: {} }) === undefined);
    expect(missing).toEqual([]);
    expect(callWords({ tool_name: 'calendar.update', args: {} }))
      .toEqual({ title: 'Change a calendar event', base: 'change a calendar event',
        doing: 'changing a calendar event', done: 'changed a calendar event' });
  });

  it('done, under way, and refused, each in its own words', () => {
    expect(line({ tool_name: 'mail.search', status: 'ok' })).toBe('searched your mail ' + checkMark);
    expect(line({ tool_name: 'mail.read', status: 'started' })).toBe('reading an email...');
    expect(line({ tool_name: 'calendar.create', status: 'error', reason: 'connection_unavailable' }))
      .toBe("couldn't add a calendar event: its connection is not available");
    expect(line({ tool_name: 'tools.search', status: 'ok' })).toBe('looked for the right tool ' + checkMark);
  });

  it('a work call says what it adds or changes, by its arguments', () => {
    expect(line({ tool_name: 'work.create', args: { kind: 'task', title: 'Pay rent' }, status: 'ok' })).toBe('added a task ' + checkMark);
    expect(line({ tool_name: 'work.update', args: { kind: 'task', done: true }, status: 'ok' })).toBe('ticked a task off ' + checkMark);
    expect(line({ tool_name: 'contact.write', args: { target_id: 'contact_1' }, status: 'ok' })).toBe('changed a contact ' + checkMark);
  });

  it('an app\'s tool, or a recipe\'s an older server named no recipe for, keeps its name', () => {
    expect(line({ tool_name: 'recued-core/control-device', tier: 2, status: 'ok' })).toBe('used recued-core/control-device ' + checkMark);
    expect(line({ tool_name: 'notion__search', tier: 3, status: 'started' })).toBe('running notion__search...');
    expect(callName({ tool_name: 'recued-core/control-device' })).toBe('recued-core/control-device');
    expect(callName({ tool_name: 'work.create', args: { kind: 'note' } })).toBe('“Add a note”');
  });

  it('a waited call and its later news name it by its title too', () => {
    const record: ChatToolCallRecord = { message_id: 'tool:1', session_id: 'sess_1', turn_id: 't', tool_name: 'calendar.update',
      run_id: 'run-1', state: 'held', started_at: 1, updated_at: 2, held_at: 2 };
    const message = chatMessage({ tool_calls: [toolCall({ tool_name: 'calendar.update', status: 'ok', run_id: 'run-1' })] });
    expect(projectMessageActivity(message, { 'run-1': record })[0]!.text).toBe('waiting to hear back: change a calendar event');
    expect(projectMessageActivity(message, { 'run-1': { ...record, state: 'failed', denied: true } })[0]!.text)
      .toBe("didn't change a calendar event: you said no");
    expect(projectSettledCallNotices(message, { 'run-1': { ...record, state: 'succeeded' } }))
      .toEqual([{ run_id: 'run-1', text: 'Update: “Change a calendar event” has now finished.' }]);
  });
});

describe('a call that ran an installed recipe reads by the recipe\'s name', () => {
  // The owner, 2026-11-13: a recipe's line read its tool's name ("used recued-core/control-device ✓").
  const recipe = (call: Partial<ChatToolCall> = {}): ChatToolCall =>
    toolCall({ tool_name: 'recued-core/weekly-digest', tier: 2, args: {}, recipe_name: 'Weekly digest', ...call });
  const line = (call: Partial<ChatToolCall>) => projectMessageActivity(chatMessage({ tool_calls: [recipe(call)] }))[0]!.text;

  it('done, under way and refused, by its name', () => {
    expect(line({ status: 'ok' })).toBe('ran “Weekly digest” ' + checkMark);
    expect(line({ status: 'started' })).toBe('running “Weekly digest”...');
    expect(line({ status: 'error', reason: 'execution_error' })).toBe("couldn't run “Weekly digest”: it failed");
    expect(line({ status: 'error', reason: 'not_asked_yet' }))
      .toBe('left until you answer the approval before it: run “Weekly digest”');
    expect(callWords(recipe())).toEqual({ title: 'Weekly digest', base: 'run “Weekly digest”',
      doing: 'running “Weekly digest”', done: 'ran “Weekly digest”' });
  });

  it('a recipe run by `recipe.run` too, where it read "ran a recipe"; an inline one keeps that', () => {
    expect(line({ tool_name: 'recipe.run', tier: 1, args: { recipe_id: 'recued-core/weekly-digest' }, status: 'ok' }))
      .toBe('ran “Weekly digest” ' + checkMark);
    const { recipe_name: _none, ...inline } = recipe({ tool_name: 'recipe.run', tier: 1, args: { recipe: {} }, status: 'ok' });
    expect(projectMessageActivity(chatMessage({ tool_calls: [inline] }))[0]!.text).toBe('ran a recipe ' + checkMark);
  });

  it('a name that is only spaces names nothing: the tool\'s name stays', () => {
    expect(line({ recipe_name: '   ', status: 'ok' })).toBe('used recued-core/weekly-digest ' + checkMark);
  });

  it('a call that waited, and its later news, by its name', () => {
    const record: ChatToolCallRecord = { message_id: 'tool:1', session_id: 'sess_1', turn_id: 't',
      tool_name: 'recued-core/weekly-digest', run_id: 'run-1', state: 'held', started_at: 1, updated_at: 2, held_at: 2 };
    const message = chatMessage({ tool_calls: [recipe({ status: 'ok', run_id: 'run-1' })] });
    expect(projectMessageActivity(message, { 'run-1': record })[0]!.text).toBe('waiting to hear back: run “Weekly digest”');
    expect(projectMessageActivity(message, { 'run-1': { ...record, state: 'failed', denied: true } })[0]!.text)
      .toBe("didn't run “Weekly digest”: you said no");
    expect(projectSettledCallNotices(message, { 'run-1': { ...record, state: 'succeeded' } }))
      .toEqual([{ run_id: 'run-1', text: 'Update: “Weekly digest” has now finished.' }]);
    expect(callName(recipe())).toBe('“Weekly digest”');
  });

  it('the live row, from the call\'s start', () => {
    const turn: InFlightTurn = { turn_id: 't', assistant_content: '', transparency: [], tool_calls: [{
      tool_name: 'recued-core/weekly-digest', tier: 2, args: {}, status: 'started', recipe_name: 'Weekly digest' }] };
    expect(projectInFlightActivity(turn)[0]).toMatchObject({ kind: 'tool', text: 'running “Weekly digest”...' });
  });

  it('a schedule or a stop by what it does to the recipe, where it read "scheduled a recipe"', () => {
    const scheduled = { tool_name: 'recipe.schedule', tier: 1 as const, args: { recipe_id: 'recued-core/weekly-digest' } };
    const stopped = { tool_name: 'recipe.stop', tier: 1 as const, args: { recipe_id: 'recued-core/weekly-digest' } };
    expect(line({ ...scheduled, status: 'ok' })).toBe('scheduled “Weekly digest” ' + checkMark);
    expect(line({ ...scheduled, status: 'started' })).toBe('scheduling “Weekly digest”...');
    expect(line({ ...scheduled, status: 'error', reason: 'execution_error' })).toBe("couldn't schedule “Weekly digest”: it failed");
    expect(line({ ...stopped, status: 'ok' })).toBe('stopped “Weekly digest” ' + checkMark);
    expect(line({ ...stopped, status: 'started' })).toBe('stopping “Weekly digest”...');
    // In a sentence of its own it is the call that is named, not the recipe: the recipe did not finish.
    expect(callName(recipe(scheduled))).toBe('“Schedule ‘Weekly digest’”');
    expect(callName(recipe(stopped))).toBe('“Stop ‘Weekly digest’”');
    const record: ChatToolCallRecord = { message_id: 'tool:1', session_id: 'sess_1', turn_id: 't',
      tool_name: 'recipe.schedule', run_id: 'run-1', state: 'held', started_at: 1, updated_at: 2, held_at: 2 };
    const message = chatMessage({ tool_calls: [recipe({ ...scheduled, status: 'ok', run_id: 'run-1' })] });
    expect(projectMessageActivity(message, { 'run-1': record })[0]!.text).toBe('waiting to hear back: schedule “Weekly digest”');
    expect(projectMessageActivity(message, { 'run-1': { ...record, state: 'failed', denied: true } })[0]!.text)
      .toBe("didn't schedule “Weekly digest”: you said no");
    expect(projectSettledCallNotices(message, { 'run-1': { ...record, state: 'succeeded' } }))
      .toEqual([{ run_id: 'run-1', text: 'Update: “Schedule ‘Weekly digest’” has now finished.' }]);
    // With no name (a stop by run, an older server) each keeps its title.
    const { recipe_name: _none, ...unnamed } = recipe({ ...stopped, args: { run_id: 'run_1' }, status: 'ok' });
    expect(projectMessageActivity(chatMessage({ tool_calls: [unnamed] }))[0]!.text).toBe('stopped a recipe ' + checkMark);
  });
});

describe('a call that stopped for the owner\'s yes reads as its card does', () => {
  // Live, 2026-11-13: it read "couldn't change a calendar event: it is waiting for your yes", and
  // still did under its card once the card said the change was done.
  const held = (call: Partial<ChatToolCall> = {}): ChatToolCall => toolCall({ tool_name: 'calendar.update', tier: 1,
    args: { source_id: 'e1', summary: 'Team meeting' }, status: 'error', reason: 'awaiting_approval',
    detail: 'plan_id=plan_1. Sent to the owner to approve.', awaiting_plan_id: 'plan_1', ...call });
  type Card = NonNullable<Parameters<typeof projectMessageActivity>[2]>[number];
  const line = (card?: Partial<Card>, call: ChatToolCall = held()) => projectMessageActivity(chatMessage({ tool_calls: [call] }),
    undefined, card === undefined ? [] : [{ plan_id: 'plan_1', status: 'proposed', ...card }])[0]!;

  it('waits while its card does, as no failure', () => {
    expect(line()).toMatchObject({ text: 'waiting for your yes: change a calendar event', status: 'started' });
    expect(line({})).toMatchObject({ text: 'waiting for your yes: change a calendar event', status: 'started' });
  });

  it('follows the card once it is answered', () => {
    expect(line({ status: 'approved' }).text).toBe('changing a calendar event...');
    expect(line({ status: 'approved', execution: { status: 'running', turn_id: 't' } }).text).toBe('changing a calendar event...');
    expect(line({ status: 'approved', execution: { status: 'completed', turn_id: 't', result_ref: 'r' } }))
      .toMatchObject({ text: 'changed a calendar event ' + checkMark, status: 'ok' });
    expect(line({ status: 'approved', execution: { status: 'held', turn_id: 't', result_ref: 'r', hold_kind: 'approval' } }))
      .toMatchObject({ text: 'waiting to hear back: change a calendar event', status: 'started' });
    expect(line({ status: 'approved', execution: { status: 'failed', turn_id: 't', reason: 'execution_error' } }))
      .toMatchObject({ text: "couldn't change a calendar event: it failed", status: 'error' });
    expect(line({ status: 'approved', execution: { status: 'failed', turn_id: 't', reason: 'run_cancelled' } }).text)
      .toBe("didn't change a calendar event: it was stopped");
    expect(line({ status: 'approved', execution: { status: 'unknown', turn_id: 't' } }).text)
      .toBe('stopped part-way: change a calendar event. Recued does not know what happened');
    expect(line({ status: 'cancelled' })).toMatchObject({ text: "didn't change a calendar event: you cancelled it", status: 'error' });
    expect(line({ status: 'cancelled', lapsed: true }).text).toBe("didn't change a calendar event: no one answered in time");
  });

  it('a call an older server kept finds its card by the plan its detail names', () => {
    const { awaiting_plan_id: _none, ...older } = held();
    expect(line({ status: 'approved', execution: { status: 'completed', turn_id: 't', result_ref: 'r' } }, older).text)
      .toBe('changed a calendar event ' + checkMark);
  });

  it('follows no other card, and no call that did not wait', () => {
    expect(projectMessageActivity(chatMessage({ tool_calls: [held()] }), undefined,
      [{ plan_id: 'plan_2', status: 'cancelled' }])[0]!.text).toBe('waiting for your yes: change a calendar event');
    const { awaiting_plan_id: _none, ...failed } = held({ reason: 'execution_error' });
    expect(line({ status: 'approved', execution: { status: 'completed', turn_id: 't', result_ref: 'r' } }, failed))
      .toMatchObject({ status: 'error' });
  });
});

describe('a call as a list names it, on a line of its own', () => {
  it('by what it does, in the chat\'s own words; a recipe by its name; else its tool\'s name', () => {
    expect(callLabel({ tool_name: 'calendar.update' })).toBe('Change a calendar event');
    expect(callLabel({ tool_name: 'work.update' })).toBe('Change a task, note or more');
    expect(callLabel({ tool_name: 'work.create', args: { kind: 'task' } })).toBe('Add a task');
    expect(callLabel({ tool_name: 'recipe.run' })).toBe('Run a recipe');
    expect(callLabel({ tool_name: 'recued-core/weekly-digest', recipe_name: 'Weekly digest' })).toBe('Run “Weekly digest”');
    expect(callLabel({ tool_name: 'recipe.run', recipe_name: 'Weekly digest' })).toBe('Run “Weekly digest”');
    expect(callLabel({ tool_name: 'recipe.schedule', recipe_name: 'Weekly digest' })).toBe('Schedule “Weekly digest”');
    expect(callLabel({ tool_name: 'recipe.stop', recipe_name: 'Weekly digest' })).toBe('Stop “Weekly digest”');
    expect(callLabel({ tool_name: 'recued-core/weekly-digest' })).toBe('recued-core/weekly-digest');
    expect(callLabel({ tool_name: 'recued_op_hubspot_deal_search' })).toBe('recued_op_hubspot_deal_search');
  });
});
