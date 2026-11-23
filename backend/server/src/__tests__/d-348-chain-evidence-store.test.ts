/** D-348 slice 1 — the evidence chains are learned from: each request of the owner's chats, the calls
 *  it held, the owner's answer to each and how each ended. Kept by the store, from the turn (the
 *  request, its held runs) and from the resumer (the answer, the outcome). */

import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import {
  chainCallSignatureHash,
  chainRequestKeyHash,
  normalizeChainRequestWords,
  type Checkpoint,
  type ExecutionSource,
} from '@recued/contracts';

import {
  CHAIN_REQUEST_STATE_KEY,
  chainOutcomeOfSettled,
  noteChainHeldRun,
  noteChainUnheld,
  openChainRequest,
  recordChainAnswer,
  recordChainOutcome,
  recordChainUndo,
  teachesChains,
} from '../chain-evidence.js';
import { createChainEvidenceStore } from '../storage/chain-evidence-store.js';

const DAY = 86_400_000;
const NOW = 20_000 * DAY + 5_000;

const ownerChat = (turn_id = 't1'): ExecutionSource =>
  ({ channel: 'chat', actor: 'user_self', chat_session_id: 'chat-a', user_id: 'owner', turn_id }) as ExecutionSource;
const telegram: ExecutionSource = { channel: 'messenger', actor: 'user_self', vendor: 'telegram', from: '42' } as ExecutionSource;
const scheduled: ExecutionSource = {
  channel: 'schedule', actor: 'system', schedule_id: 'ps_1', cron: '0 7 * * *', chat_session_id: 'chat-a', turn_id: 't1',
} as unknown as ExecutionSource;
const aiAppChat: ExecutionSource =
  { channel: 'chat', actor: 'contracted_user', chat_session_id: 'chat-x', contract_id: 'ct_app' } as unknown as ExecutionSource;
const mcp: ExecutionSource =
  { channel: 'mcp', actor: 'contracted_user', agent_id: 'a', mcp_token_id: 'tok', contract_id: 'ct_app' } as unknown as ExecutionSource;

const taskHold = (run_id: string, checkpoint_id = `cp-${run_id}`, over: Record<string, unknown> = {}): Checkpoint => ({
  checkpoint_id, run_id, step_state: {}, created_at: 1,
  raw_op: {
    tier1_tool: 'work.create', catalog_slug: 'recued:tier1', operation: 'work.create', op_id: 'work.create',
    op_args: { kind: 'task', title: 'Weekly review' }, risk_tier: 'write', connection_name: '', execution_source: ownerChat(),
  },
  ...over,
}) as unknown as Checkpoint;

const fixture = (key?: Uint8Array) => {
  const db = new Database(':memory:');
  const store = createChainEvidenceStore(db, key === undefined ? undefined : () => key);
  const rows = (table: string) => db.prepare(`SELECT * FROM ${table}`).all() as Array<Record<string, unknown>>;
  /** A turn of the owner's chat: its state, with its request when it has one. */
  const turn = (words: string | undefined, over: { turn_id?: string; source?: ExecutionSource; continuation_of_turn_id?: string } = {}) => {
    const turn_id = over.turn_id ?? 't1';
    const state = new Map<string, unknown>();
    const request = openChainRequest(store, {
      session_id: 'chat-a', turn_id, source: over.source ?? ownerChat(turn_id),
      ...(over.continuation_of_turn_id !== undefined ? { continuation_of_turn_id: over.continuation_of_turn_id }
        : words !== undefined ? { words } : {}),
      at: NOW,
    });
    if (request !== undefined) state.set(CHAIN_REQUEST_STATE_KEY, request);
    return { state, request };
  };
  return { db, store, rows, turn };
};

describe('D-348 — which chats teach (Q5)', () => {
  it('the owner\'s app chat and messenger chats; not a scheduled prompt, not an AI app', () => {
    expect(teachesChains(ownerChat())).toBe(true);
    expect(teachesChains(telegram)).toBe(true);
    expect(teachesChains(scheduled)).toBe(false);
    expect(teachesChains(aiAppChat)).toBe(false);
    expect(teachesChains(mcp)).toBe(false);
  });
});

describe('D-348 — a request, and the calls it holds', () => {
  it('is written only once it holds a call, under its words\' key, with its occasion and its words', async () => {
    const f = fixture();
    const { state, request } = f.turn('Add the weekly review task.');
    expect(request).toEqual({
      request_id: 't1', key_hash: chainRequestKeyHash(normalizeChainRequestWords('Add the weekly review task.')),
      pending: expect.objectContaining({ words: 'Add the weekly review task.' }),
    });
    // A turn that holds nothing leaves no row.
    expect(f.rows('chain_requests')).toEqual([]);
    noteChainHeldRun(f.store, state, 'run-1', NOW + 10);
    await vi.waitFor(() => expect(f.rows('chain_requests')).toHaveLength(1));
    const [row] = f.rows('chain_requests');
    expect(row).toMatchObject({
      request_id: 't1', session_id: 'chat-a', at: NOW,
      key_hash: chainRequestKeyHash(normalizeChainRequestWords('Add the weekly review task.')),
      occasion: `chat:chat-a|${String(Math.floor(NOW / DAY))}`,
    });
    expect(await f.store.open('request', 't1', row!.words_encrypted as string)).toBe('Add the weekly review task.');
    expect(f.store.requestOfRun('run-1')).toBe('t1');
    // Its second held call adds a run, not a second request.
    noteChainHeldRun(f.store, state, 'run-2', NOW + 20);
    expect(f.store.requestOfRun('run-2')).toBe('t1');
    await Promise.resolve();
    expect(f.rows('chain_requests')).toHaveLength(1);
  });

  it('a messenger chat\'s request counts its own conversation\'s day', async () => {
    const f = fixture();
    const { state } = f.turn('send the rota', { source: telegram });
    noteChainHeldRun(f.store, state, 'run-1', NOW);
    await vi.waitFor(() => expect(f.rows('chain_requests')).toHaveLength(1));
    expect(f.rows('chain_requests')[0]!.occasion).toBe(`messenger:telegram:42|${String(Math.floor(NOW / DAY))}`);
  });

  it('no request for a scheduled prompt, an AI app, or words that are only punctuation', () => {
    const f = fixture();
    expect(f.turn('Add the task', { source: scheduled }).request).toBeUndefined();
    expect(f.turn('Add the task', { source: aiAppChat }).request).toBeUndefined();
    expect(f.turn('?!').request).toBeUndefined();
  });

  it('a turn that continues another joins its request; a reply like "go ahead" is never one of its own', async () => {
    const f = fixture();
    const first = f.turn('Add the weekly review task.');
    noteChainHeldRun(f.store, first.state, 'run-1', NOW);
    await vi.waitFor(() => expect(f.rows('chain_requests')).toHaveLength(1));
    const next = f.turn(undefined, { turn_id: 't2', continuation_of_turn_id: 't1' });
    // It carries the request's key, for the request's rule (slice 4).
    expect(next.request).toEqual({ request_id: 't1', key_hash: chainRequestKeyHash(normalizeChainRequestWords('Add the weekly review task.')) });
    noteChainHeldRun(f.store, next.state, 'run-2', NOW + 5);
    expect(f.store.requestOfRun('run-2')).toBe('t1');
    // And a continuation of that one, too.
    expect(f.turn(undefined, { turn_id: 't3', continuation_of_turn_id: 't2' }).request).toMatchObject({ request_id: 't1' });
    // A continuation of a turn that made no request makes none.
    expect(f.turn(undefined, { turn_id: 't4', continuation_of_turn_id: 'never' }).request).toBeUndefined();
  });
});

describe('D-348 — the owner\'s answer and how the call ended', () => {
  const held = async (f: ReturnType<typeof fixture>, run_id = 'run-1') => {
    const { state } = f.turn('Add the weekly review task.');
    noteChainHeldRun(f.store, state, run_id, NOW);
    await vi.waitFor(() => expect(f.rows('chain_requests')).toHaveLength(1));
  };

  it('approved: kept with what the call is, then how it ended', async () => {
    const f = fixture();
    await held(f);
    await recordChainAnswer({ chainEvidence: f.store, now: () => NOW + 100 }, taskHold('run-1'), 'approved');
    recordChainOutcome({ chainEvidence: f.store }, { execution_source: ownerChat(), run_id: 'run-1', tool_name: 'work.create',
      result: { success: true }, ts: NOW + 200 });
    const [call] = f.rows('chain_calls');
    expect(call).toMatchObject({
      checkpoint_id: 'cp-run-1', run_id: 'run-1', request_id: 't1', answer: 'approved', outcome: 'ran',
      is_delete: 0, at: NOW + 100, settled_at: NOW + 200,
      signature_hash: chainCallSignatureHash({ op: 'tier1:work.create:task', pins: {} }),
    });
    expect(JSON.parse(await f.store.open('call', 'cp-run-1', call!.signature_encrypted as string)))
      .toEqual({ op: 'tier1:work.create:task', pins: {} });
  });

  it('refused: kept as refused, and nothing ends it', async () => {
    const f = fixture();
    await held(f);
    await recordChainAnswer({ chainEvidence: f.store }, taskHold('run-1'), 'refused');
    recordChainOutcome({ chainEvidence: f.store }, { execution_source: ownerChat(), run_id: 'run-1', tool_name: 'work.create',
      result: { success: false, denied: true }, ts: NOW });
    expect(f.rows('chain_calls')[0]).toMatchObject({ answer: 'refused', outcome: null });
    // And the store itself ends only what the owner approved, whatever it is told.
    f.store.runSettled('run-1', 'failed', NOW + 1);
    expect(f.rows('chain_calls')[0]).toMatchObject({ answer: 'refused', outcome: null });
  });

  it('changed before approving: kept as such, for it counts for nothing', async () => {
    const f = fixture();
    await held(f);
    // A note's wording, the one thing a chat write's card lets the owner change.
    const note = taskHold('run-1', 'cp-1');
    await recordChainAnswer({ chainEvidence: f.store }, {
      ...note, raw_op: { ...note.raw_op!, tier1_tool: 'memory.write', op_args: { summary: 'Ann likes mornings' } },
      arg_overrides: { summary: 'Ann likes early mornings' },
    } as Checkpoint, 'approved');
    // A recipe's held step changed on its approval page.
    noteChainHeldRun(f.store, f.turn('Add the weekly review task.').state, 'run-2', NOW);
    await recordChainAnswer({ chainEvidence: f.store }, {
      checkpoint_id: 'cp-2', run_id: 'run-2', recipe_id: 'r', gated_step_id: 's', step_state: { s: { input: { to: 'a@b.co' } } },
      approved_target: { ingredient_slug: 'mail-send' }, arg_overrides: { to: 'c@d.co' }, created_at: 1,
    } as unknown as Checkpoint, 'approved');
    expect(f.rows('chain_calls').map((row) => [row.checkpoint_id, row.answer])).toEqual([
      ['cp-1', 'approved_changed'], ['cp-2', 'approved_changed'],
    ]);
    // A chat write's other arguments are no change the owner made.
    noteChainHeldRun(f.store, f.turn('Add the weekly review task.').state, 'run-3', NOW);
    await recordChainAnswer({ chainEvidence: f.store }, taskHold('run-3', 'cp-3', { arg_overrides: { title: 'x' } }), 'approved');
    expect(f.rows('chain_calls').find((row) => row.checkpoint_id === 'cp-3')).toMatchObject({ answer: 'approved' });
  });

  it('a call no request of the owner\'s chats held is not kept; an answer told twice keeps its first', async () => {
    const f = fixture();
    await recordChainAnswer({ chainEvidence: f.store }, taskHold('run-elsewhere'), 'approved');
    expect(f.rows('chain_calls')).toEqual([]);
    await held(f);
    await recordChainAnswer({ chainEvidence: f.store }, taskHold('run-1'), 'approved');
    await recordChainAnswer({ chainEvidence: f.store }, taskHold('run-1'), 'refused');
    expect(f.rows('chain_calls').map((row) => row.answer)).toEqual(['approved']);
  });

  it('a hold it cannot name is kept without a signature, so its refusal still counts', async () => {
    const f = fixture();
    await held(f);
    await recordChainAnswer({ chainEvidence: f.store }, taskHold('run-1', 'cp-1', {
      raw_op: undefined, recipe_id: undefined, gated_step_id: 'send', step_state: { send: { input: {} } },
    }), 'refused');
    expect(f.rows('chain_calls')[0]).toMatchObject({ answer: 'refused', signature_hash: null, signature_encrypted: null });
  });

  it('how a settled run ended, as the resumer tells it', () => {
    expect(chainOutcomeOfSettled({ result: { success: true } })).toBe('ran');
    expect(chainOutcomeOfSettled({ result: {}, state: 'succeeded' })).toBe('ran');
    expect(chainOutcomeOfSettled({ result: { success: false } })).toBe('failed');
    expect(chainOutcomeOfSettled({ result: {}, state: 'failed' })).toBe('failed');
    // Not sure it finished.
    expect(chainOutcomeOfSettled({ result: { success: true }, state: 'interrupted' })).toBe('unknown');
    expect(chainOutcomeOfSettled({ result: undefined })).toBe('unknown');
    // A refusal is its answer.
    expect(chainOutcomeOfSettled({ result: { denied: true } })).toBeUndefined();
    // Stopped again for a later approval: not ended.
    expect(chainOutcomeOfSettled({ result: { success: false, awaiting_approval: true } })).toBeUndefined();
  });

  it('a run that settles twice keeps its first outcome', async () => {
    const f = fixture();
    await held(f);
    await recordChainAnswer({ chainEvidence: f.store }, taskHold('run-1'), 'approved');
    f.store.runSettled('run-1', 'unknown', NOW + 1);
    f.store.runSettled('run-1', 'ran', NOW + 2);
    expect(f.rows('chain_calls')[0]).toMatchObject({ outcome: 'unknown', settled_at: NOW + 1 });
  });
});

describe('D-348 Q4 — a change the owner undid', () => {
  const ran = async (f: ReturnType<typeof fixture>, run_id = 'run-1') => {
    const { state } = f.turn('Rename the meeting.');
    noteChainHeldRun(f.store, state, run_id, NOW);
    await vi.waitFor(() => expect(f.rows('chain_requests')).toHaveLength(1));
    await recordChainAnswer({ chainEvidence: f.store }, taskHold(run_id), 'approved');
    f.store.runSettled(run_id, 'ran', NOW + 1);
  };

  it('is kept with its request and the time it was undone, on the server\'s clock; the call still ran', async () => {
    const f = fixture();
    await ran(f);
    recordChainUndo({ chainEvidence: f.store, now: () => NOW + 5 * DAY }, { run_id: 'run-1', receipt_id: 'lmr_1' });
    expect(f.rows('chain_undos')).toEqual([{ receipt_id: 'lmr_1', run_id: 'run-1', request_id: 't1', at: NOW + 5 * DAY }]);
    // How the call ended is not rewritten: the undo is its own fact, with its own time.
    expect(f.rows('chain_calls')[0]).toMatchObject({ outcome: 'ran', settled_at: NOW + 1 });
  });

  it('once per change, however often it is told; another change of the run is another undo', async () => {
    const f = fixture();
    await ran(f);
    for (const [receipt_id, at] of [['lmr_1', NOW + 2], ['lmr_1', NOW + 3], ['lmr_2', NOW + 4]] as const) {
      expect(f.store.runUndone({ run_id: 'run-1', receipt_id, at })).toBeDefined();
    }
    expect(f.rows('chain_undos').map((row) => [row.receipt_id, row.at])).toEqual([['lmr_1', NOW + 2], ['lmr_2', NOW + 4]]);
  });

  it('names the call that made the change, for a rule holding it to end: its own hold, else the run\'s one', async () => {
    const f = fixture();
    const key_hash = chainRequestKeyHash(normalizeChainRequestWords('Rename the meeting.'));
    await ran(f);
    const task = f.rows('chain_calls')[0]!.signature_hash;
    expect(f.store.runUndone({ run_id: 'run-1', receipt_id: 'lmr_1', at: NOW + 2 }))
      .toEqual({ key_hash, signature_hashes: [task] });
    // A run of two: the one whose hold the change names; with none named, neither.
    noteChainHeldRun(f.store, f.turn('Rename the meeting.').state, 'run-2', NOW);
    const note = taskHold('run-2', 'cp-note');
    await recordChainAnswer({ chainEvidence: f.store }, taskHold('run-2', 'cp-task'), 'approved');
    await recordChainAnswer({ chainEvidence: f.store }, {
      ...note, raw_op: { ...note.raw_op!, tier1_tool: 'memory.write', op_args: { summary: 'Ann likes mornings' } },
    } as Checkpoint, 'approved');
    f.store.runSettled('run-2', 'ran', NOW + 1);
    const saved = f.rows('chain_calls').find((row) => row.checkpoint_id === 'cp-note')!.signature_hash;
    expect(saved).not.toBe(task);
    expect(f.store.runUndone({ run_id: 'run-2', receipt_id: 'lmr_2', checkpoint_id: 'cp-note', at: NOW + 3 }))
      .toEqual({ key_hash, signature_hashes: [saved] });
    expect(f.store.runUndone({ run_id: 'run-2', receipt_id: 'lmr_3', at: NOW + 4 })).toEqual({ key_hash, signature_hashes: [] });
    // A refused call made no change: the run's one approved call did.
    noteChainHeldRun(f.store, f.turn('Rename the meeting.').state, 'run-3', NOW);
    await recordChainAnswer({ chainEvidence: f.store }, taskHold('run-3', 'cp-yes'), 'approved');
    await recordChainAnswer({ chainEvidence: f.store }, { ...note, run_id: 'run-3', checkpoint_id: 'cp-no' } as Checkpoint, 'refused');
    expect(f.store.runUndone({ run_id: 'run-3', receipt_id: 'lmr_4', at: NOW + 5 })).toEqual({ key_hash, signature_hashes: [task] });
  });

  it('nothing for a run no request of the owner\'s chats held', () => {
    const f = fixture();
    expect(f.store.runUndone({ run_id: 'run-elsewhere', receipt_id: 'lmr_1', at: NOW })).toBeUndefined();
    recordChainUndo({ chainEvidence: f.store }, { run_id: 'run-elsewhere', receipt_id: 'lmr_2' });
    expect(f.rows('chain_undos')).toEqual([]);
  });

  it('a store that fails costs the undo nothing', async () => {
    const f = fixture();
    await ran(f);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    f.db.exec('DROP TABLE chain_undos');
    expect(() => recordChainUndo({ chainEvidence: f.store }, { run_id: 'run-1', receipt_id: 'lmr_1' })).not.toThrow();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('the undo of run run-1 was not kept'));
    warn.mockRestore();
  });
});

describe('D-348 §7.8 — a change no hold recorded, a permission having let it through', () => {
  const key_hash = chainRequestKeyHash(normalizeChainRequestWords('Rename the meeting.'));

  it('is noted by what made it, with its request\'s key and never its words, and no request row', () => {
    const f = fixture();
    const { state } = f.turn('Rename the meeting.');
    noteChainUnheld(f.store, state, { ref: 'tool:rename', session_id: 'chat-a', at: NOW });
    noteChainUnheld(f.store, state, { ref: 'run-unheld', session_id: 'chat-a', at: NOW + 1 });
    expect(f.rows('chain_unheld_refs')).toEqual([
      { ref: 'tool:rename', key_hash, session_id: 'chat-a', at: NOW },
      { ref: 'run-unheld', key_hash, session_id: 'chat-a', at: NOW + 1 },
    ]);
    // A turn that holds nothing writes no request, and its words are not kept for this.
    expect(f.rows('chain_requests')).toEqual([]);
  });

  it('a messenger chat\'s too; nothing for a scheduled prompt, words that are only punctuation, or no ref', () => {
    const f = fixture();
    noteChainUnheld(f.store, f.turn('Rename it', { source: telegram }).state, { ref: 'r-telegram', session_id: 'chat-a', at: NOW });
    noteChainUnheld(f.store, f.turn('Rename it', { source: scheduled }).state, { ref: 'r-scheduled', session_id: 'chat-a', at: NOW });
    noteChainUnheld(f.store, f.turn('?!').state, { ref: 'r-punctuation', session_id: 'chat-a', at: NOW });
    noteChainUnheld(f.store, f.turn('Rename it').state, { ref: undefined, session_id: 'chat-a', at: NOW });
    expect(f.rows('chain_unheld_refs').map((row) => row.ref)).toEqual(['r-telegram']);
  });

  it('its undo resets the request\'s key as of then, once per change; another\'s undo is not it', () => {
    const f = fixture();
    noteChainUnheld(f.store, f.turn('Rename the meeting.').state, { ref: 'tool:rename', session_id: 'chat-a', at: NOW });
    recordChainUndo({ chainEvidence: f.store, now: () => NOW + 2 * DAY }, { chat_call_id: 'tool:rename', receipt_id: 'lmr_1' });
    recordChainUndo({ chainEvidence: f.store, now: () => NOW + 3 * DAY }, { chat_call_id: 'tool:rename', receipt_id: 'lmr_1' });
    expect(f.rows('chain_unheld_undos')).toEqual([
      { receipt_id: 'lmr_1', ref: 'tool:rename', key_hash, session_id: 'chat-a', at: NOW + 2 * DAY },
    ]);
    // A change nothing noted: no request of the owner's chats made it.
    expect(f.store.unheldUndone({ ref: 'tool:elsewhere', receipt_id: 'lmr_2', at: NOW })).toBeUndefined();
    recordChainUndo({ chainEvidence: f.store }, { run_id: 'run-elsewhere', receipt_id: 'lmr_3' });
    expect(f.rows('chain_unheld_undos').map((row) => row.receipt_id)).toEqual(['lmr_1']);
  });

  it('a run a hold recorded is undone as before, never also as an unheld one', async () => {
    const f = fixture();
    const { state } = f.turn('Rename the meeting.');
    noteChainHeldRun(f.store, state, 'run-1', NOW);
    noteChainUnheld(f.store, state, { ref: 'run-1', session_id: 'chat-a', at: NOW });
    await vi.waitFor(() => expect(f.rows('chain_requests')).toHaveLength(1));
    recordChainUndo({ chainEvidence: f.store, now: () => NOW + DAY }, { run_id: 'run-1', receipt_id: 'lmr_1' });
    expect(f.rows('chain_undos').map((row) => row.receipt_id)).toEqual(['lmr_1']);
    expect(f.rows('chain_unheld_undos')).toEqual([]);
  });

  it('a store that fails costs the undo nothing', () => {
    const f = fixture();
    noteChainUnheld(f.store, f.turn('Rename the meeting.').state, { ref: 'tool:rename', session_id: 'chat-a', at: NOW });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    f.db.exec('DROP TABLE chain_unheld_undos');
    expect(() => recordChainUndo({ chainEvidence: f.store }, { chat_call_id: 'tool:rename', receipt_id: 'lmr_1' })).not.toThrow();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('the undo of tool:rename was not kept'));
    f.db.exec('DROP TABLE chain_unheld_refs');
    expect(() => noteChainUnheld(f.store, f.turn('Rename the meeting.').state, { ref: 'tool:again', session_id: 'chat-a', at: NOW }))
      .not.toThrow();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('tool:again was not noted'));
    warn.mockRestore();
  });
});

describe('D-348 — a deleted conversation takes what it kept', () => {
  it('its requests, and every turn, run, call and undo they hold; another conversation\'s stay', async () => {
    const f = fixture();
    const a = f.turn('Add the weekly review task.');
    noteChainHeldRun(f.store, a.state, 'run-1', NOW);
    await vi.waitFor(() => expect(f.rows('chain_requests')).toHaveLength(1));
    f.turn(undefined, { turn_id: 't2', continuation_of_turn_id: 't1' });
    await recordChainAnswer({ chainEvidence: f.store }, taskHold('run-1'), 'approved');
    // Another conversation's request.
    const state = new Map<string, unknown>([[CHAIN_REQUEST_STATE_KEY,
      openChainRequest(f.store, { session_id: 'chat-b', turn_id: 'tb', source: ownerChat('tb'), words: 'Add it', at: NOW })]]);
    noteChainHeldRun(f.store, state, 'run-b', NOW);
    await vi.waitFor(() => expect(f.rows('chain_requests')).toHaveLength(2));
    await recordChainAnswer({ chainEvidence: f.store }, taskHold('run-b'), 'approved');
    f.store.runUndone({ run_id: 'run-1', receipt_id: 'lmr_a', at: NOW + 1 });
    f.store.runUndone({ run_id: 'run-b', receipt_id: 'lmr_b', at: NOW + 1 });
    noteChainUnheld(f.store, a.state, { ref: 'tool:a', session_id: 'chat-a', at: NOW });
    noteChainUnheld(f.store, state, { ref: 'tool:b', session_id: 'chat-b', at: NOW });
    f.store.unheldUndone({ ref: 'tool:a', receipt_id: 'lmr_ua', at: NOW + 1 });
    f.store.unheldUndone({ ref: 'tool:b', receipt_id: 'lmr_ub', at: NOW + 1 });

    expect(f.store.deleteSession('chat-a')).toBe(1);
    expect(f.rows('chain_requests').map((row) => row.request_id)).toEqual(['tb']);
    expect(f.rows('chain_turns').map((row) => row.turn_id)).toEqual(['tb']);
    expect(f.rows('chain_runs').map((row) => row.run_id)).toEqual(['run-b']);
    expect(f.rows('chain_calls').map((row) => row.run_id)).toEqual(['run-b']);
    expect(f.rows('chain_undos').map((row) => row.receipt_id)).toEqual(['lmr_b']);
    expect(f.rows('chain_unheld_refs').map((row) => row.ref)).toEqual(['tool:b']);
    expect(f.rows('chain_unheld_undos').map((row) => row.receipt_id)).toEqual(['lmr_ub']);
  });
});

describe('D-348 — what is kept is sealed under the chat key', () => {
  it('request words open only under their key, on their own row, and reject tampering', async () => {
    const key = new Uint8Array(32).fill(7);
    const f = fixture(key);
    await (async () => {
      const { state } = f.turn('Send Ann the agenda');
      noteChainHeldRun(f.store, state, 'run-1', NOW);
      await vi.waitFor(() => expect(f.rows('chain_requests')).toHaveLength(1));
    })();
    const sealed = f.rows('chain_requests')[0]!.words_encrypted as string;
    expect(await f.store.open('request', 't1', sealed)).toBe('Send Ann the agenda');
    const otherKey = fixture(new Uint8Array(32).fill(8));
    try {
      await expect(otherKey.store.open('request', 't1', sealed)).rejects.toThrow();
    } finally { otherKey.db.close(); }
    // Moved onto another row, it does not open.
    await expect(f.store.open('request', 't2', sealed)).rejects.toThrow();
    const changed = Buffer.from(sealed, 'base64');
    changed[changed.length - 1]! ^= 1;
    await expect(f.store.open('request', 't1', changed.toString('base64'))).rejects.toThrow();
  });

  it('a locked vault keeps nothing, and costs the turn nothing', async () => {
    const db = new Database(':memory:');
    const store = createChainEvidenceStore(db, () => null);
    const state = new Map<string, unknown>();
    const request = openChainRequest(store, { session_id: 'chat-a', turn_id: 't1', source: ownerChat(), words: 'Add it', at: NOW });
    state.set(CHAIN_REQUEST_STATE_KEY, request);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(() => noteChainHeldRun(store, state, 'run-1', NOW)).not.toThrow();
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
    warn.mockRestore();
    expect(db.prepare('SELECT * FROM chain_requests').all()).toEqual([]);
  });
});
