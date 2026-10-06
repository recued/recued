import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TRANSPARENCY_STREAM_SETTINGS,
  type ChatMessage,
  type ChatToolCall,
  type ChatToolCallRecord,
  type TransparencyEvent,
  type TransparencyStreamSettings,
} from '@recued/contracts';

import {
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
      { kind: 'tool', text: 'running mail.search...', status: 'started' },
      {
        kind: 'tool',
        text: 'used mail.search ' + checkMark,
        status: 'ok',
      },
      {
        kind: 'tool',
        text: 'couldn\'t run mail.search: connection unavailable',
        status: 'error',
      },
      {
        kind: 'tool',
        text: 'couldn\'t run mail.search: execution error',
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
      { kind: 'tool', text: 'running mail.search...', status: 'started' },
      {
        kind: 'tool',
        text: 'couldn\'t run calendar.create: execution error',
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
        text: 'used mail.search ' + checkMark,
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
        text: 'used mail.search ' + checkMark,
        status: 'ok',
        run_id: 'run_259',
      },
      {
        kind: 'tool',
        text: 'used mail.search ' + checkMark,
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
      { kind: 'tool', text: 'running mail.search...', status: 'started' },
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
    // A call that never waited needs no update: its ✓ is already the truth.
    const { held_at: _never, ...neverWaited } = record({ state: 'succeeded' });
    expect(projectSettledCallNotices(message, { 'run-1': neverWaited })).toEqual([]);
    expect(projectSettledCallNotices(message, undefined)).toEqual([]);
    expect(projectSettledCallNotices(chatMessage({ role: 'user' }), { 'run-1': record({ state: 'succeeded' }) })).toEqual([]);
  });
});
