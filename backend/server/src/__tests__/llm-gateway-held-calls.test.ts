/** D-337 follow-up 24, design (b) — a gateway call still waiting when its reply goes is found again
 *  by the reference that reply carries, and told in the conversation's next request, once.
 *
 *  ⛔ The owner: "look out for the cases when 1,2,3 sessions also have 'waiting for approval'". Two
 *  sessions can get the same reply word for word, so nothing here reads the reply's words: each
 *  waiting call has its own random reference, and only the conversation's latest reply is read. */
import { describe, expect, it } from 'vitest';
import { createInMemoryCollection } from '@recued/storage';
import type { LLMMessage } from '@recued/llm';

import { HELD_RESULT_REFUSED_DETAIL } from '../chat-held-results.js';
import { HELD_WRITE_EXPIRED_MESSAGE } from '../chat-held-writes.js';
import { createMcpActionStore, type McpActionRecord } from '../mcp-action-store.js';
import {
  llmGatewayStillWaitingNote,
  llmGatewayWaitingTrailer,
  readCarriedHeldCalls,
  waitingRefsInLatestReply,
} from '../ports/llm-gateway/held-calls.js';

const KEY = 'tok-customer';
const TOOL = 'kitchen/remove-event';
const WAITING_WORDS = 'Your removal is waiting for approval.';

const store = () => createMcpActionStore(createInMemoryCollection<McpActionRecord>());
const hold = async (actions: ReturnType<typeof store>, run_id: string, principal_id = KEY): Promise<string> =>
  (await actions.createHeld({ run_id, principal_id, tool_name: TOOL, kind: 'recipe' })).action_ref;
const history = (...replies: string[]): LLMMessage[] => replies.flatMap((reply, i) => [
  { role: 'user' as const, content: `message ${String(i + 1)}` },
  { role: 'assistant' as const, content: reply },
]).concat([{ role: 'user', content: 'Is it done?' }]);

describe('waitingRefsInLatestReply', () => {
  it('reads the references of the latest reply only, once each', () => {
    const a = `mcpact_${'a'.repeat(32)}`;
    const b = `mcpact_${'b'.repeat(32)}`;
    const c = `mcpact_${'c'.repeat(32)}`;
    expect(waitingRefsInLatestReply(history(
      `First.${llmGatewayWaitingTrailer([a])}`,
      `Second.${llmGatewayWaitingTrailer([b, c])} (${b} again)`,
    ))).toEqual([b, c]);
  });

  it('ignores a reference the user wrote, and a history with no reply', () => {
    const a = `mcpact_${'a'.repeat(32)}`;
    expect(waitingRefsInLatestReply([{ role: 'user', content: `Tell me about ${a}` }])).toEqual([]);
    expect(waitingRefsInLatestReply(history('No reference here.'))).toEqual([]);
  });
});

describe('llmGatewayWaitingTrailer', () => {
  it('names one reference, or several', () => {
    const a = `mcpact_${'a'.repeat(32)}`;
    const b = `mcpact_${'b'.repeat(32)}`;
    expect(llmGatewayWaitingTrailer([a])).toBe(`\n\n[Waiting for approval — ref ${a}]`);
    expect(llmGatewayWaitingTrailer([a, b])).toBe(`\n\n[Waiting for approval — refs ${a}, ${b}]`);
  });
});

describe('llmGatewayStillWaitingNote', () => {
  it('D-337 slice S — says the call still waits, that the model cannot check on it or write first, and when the user hears', () => {
    expect(llmGatewayStillWaitingNote(1, false)).toBe(
      'The action you said earlier was waiting for approval by the person who runs this service is still waiting: '
      + 'nothing has been decided about it yet. You cannot check on it, and you cannot write to the user first, '
      + 'so do not say you will let them know or that they will be notified. If the user asks, tell them it '
      + 'is still waiting, and that they will hear how it went when they next write in this conversation.');
    // Several, beside ones answered since (which the carried note tells).
    expect(llmGatewayStillWaitingNote(2, true)).toBe(
      'The other actions you said earlier were waiting for approval by the person who runs this service are '
      + 'still waiting: nothing has been decided about them yet. You cannot check on them, and you cannot write to the '
      + 'user first, so do not say you will let them know or that they will be notified. If the user asks, '
      + 'tell them they are still waiting, and that they will hear how they went when they next write in this conversation.');
  });
});

describe('readCarriedHeldCalls', () => {
  it('tells each settled call with its outcome, and carries the ones still waiting', async () => {
    const actions = store();
    const ran = await hold(actions, 'run-ran');
    const refused = await hold(actions, 'run-refused');
    const expired = await hold(actions, 'run-expired');
    const failed = await hold(actions, 'run-failed');
    const waiting = await hold(actions, 'run-waiting');
    const running = await hold(actions, 'run-running');
    await actions.finish('run-ran', { status: 'completed', status_message: 'done', result: { removed: 'Dentist' } });
    await actions.finish('run-refused', { status: 'denied', status_message: 'no', result: { denied: true } });
    await actions.finish('run-expired', {
      status: 'cancelled', status_message: 'expired', result: { status: 'cancelled', expired: true },
    });
    await actions.finish('run-failed', { status: 'failed', status_message: 'failed', result: { status: 'failed', error: 'calendar unreachable' } });
    await actions.markRunning('run-running');

    const carried = await readCarriedHeldCalls(actions, history(
      `${WAITING_WORDS}${llmGatewayWaitingTrailer([ran, refused, expired, failed, waiting, running])}`,
    ), KEY);

    expect(carried.waiting).toEqual([waiting, running]);
    expect(carried.settled.map((call) => ({ tool: call.tool_name, status: call.status }))).toEqual([
      { tool: TOOL, status: 'ok' },
      { tool: TOOL, status: 'error' },
      { tool: TOOL, status: 'error' },
      { tool: TOOL, status: 'ok' },
    ]);
    expect(carried.settled[0]).toMatchObject({ result: { removed: 'Dentist' } });
    expect(carried.settled[1]).toMatchObject({ reason: 'plan_cancelled', detail: HELD_RESULT_REFUSED_DETAIL });
    expect(carried.settled[2]).toMatchObject({ reason: 'plan_cancelled', detail: HELD_WRITE_EXPIRED_MESSAGE });
    expect(carried.settled[3]).toMatchObject({ result: { status: 'failed', error: 'calendar unreachable' } });
  });

  it('⛔ ignores a reference another key owns, and one nobody knows', async () => {
    const actions = store();
    const theirs = await hold(actions, 'run-theirs', 'tok-someone-else');
    await actions.finish('run-theirs', { status: 'completed', status_message: 'done', result: { secret: 'theirs' } });
    const unknown = `mcpact_${'0'.repeat(32)}`;
    const carried = await readCarriedHeldCalls(actions, history(
      `${WAITING_WORDS}${llmGatewayWaitingTrailer([theirs, unknown])}`,
    ), KEY);
    expect(carried).toEqual({ settled: [], waiting: [] });
  });

  it('⛔ keeps a reference waiting when the store cannot be read, so it is not lost', async () => {
    const ref = `mcpact_${'d'.repeat(32)}`;
    const failing = { getOwned: async () => { throw new Error('locked'); } };
    const carried = await readCarriedHeldCalls(failing, history(
      `${WAITING_WORDS}${llmGatewayWaitingTrailer([ref])}`,
    ), KEY);
    expect(carried).toEqual({ settled: [], waiting: [ref] });
  });

  it('⛔ an approval that expired retires the run, not its record: read as the door reads it, it is told as expired', async () => {
    // Retention retires a recipe run nobody answered in time (`RECIPE_APPROVAL_TIMEOUT`) and
    // leaves its record waiting. Without the door's status read the conversation would hear
    // "waiting" in every reply from then on.
    const actions = store();
    const expired = await hold(actions, 'run-expired-recipe');
    const waiting = await hold(actions, 'run-still-waiting');
    const done = await hold(actions, 'run-done');
    await actions.finish('run-done', { status: 'completed', status_message: 'done', result: { removed: 'x' } });
    const read: string[] = [];
    const reconcile = async (record: McpActionRecord): Promise<McpActionRecord> => {
      read.push(record.run_id);
      if (record.run_id !== 'run-expired-recipe') return record;
      // What `reconcileMcpAction` writes from the run retention retired.
      return (await actions.finish(record.run_id, {
        status: 'failed',
        status_message: 'Approval was not granted in time. Re-run the recipe to try again.',
        result: {
          status: 'failed', run_id: record.run_id,
          error: { code: 'RECIPE_APPROVAL_TIMEOUT', message: 'Approval was not granted in time. Re-run the recipe to try again.' },
          message: 'Approval was not granted in time. Re-run the recipe to try again.',
        },
      }))!;
    };
    const carried = await readCarriedHeldCalls(actions, history(
      `${WAITING_WORDS}${llmGatewayWaitingTrailer([expired, waiting, done])}`,
    ), KEY, reconcile);

    expect(read).toEqual(['run-expired-recipe', 'run-still-waiting']);
    expect(carried.waiting).toEqual([waiting]);
    expect(carried.settled).toHaveLength(2);
    expect(carried.settled[0]).toMatchObject({ reason: 'plan_cancelled', detail: HELD_WRITE_EXPIRED_MESSAGE });
    expect(carried.settled[1]).toMatchObject({ result: { removed: 'x' } });
  });

  it('⛔ CONTROL: a run that failed for another reason is told as failed, with its result', async () => {
    const actions = store();
    const ref = await hold(actions, 'run-other');
    await actions.finish('run-other', {
      status: 'failed', status_message: 'failed',
      result: { status: 'failed', error: { code: 'CONNECTION_UNAVAILABLE', message: 'calendar unreachable' } },
    });
    const carried = await readCarriedHeldCalls(actions, history(
      `${WAITING_WORDS}${llmGatewayWaitingTrailer([ref])}`,
    ), KEY);
    expect(carried.settled[0]).toMatchObject({ result: { error: { code: 'CONNECTION_UNAVAILABLE' } } });
    expect(carried.settled[0]).not.toMatchObject({ reason: 'plan_cancelled' });
  });

  it('⛔ keeps a reference waiting when the door\'s read cannot be done', async () => {
    const actions = store();
    const ref = await hold(actions, 'run-r');
    const carried = await readCarriedHeldCalls(actions, history(
      `${WAITING_WORDS}${llmGatewayWaitingTrailer([ref])}`,
    ), KEY, async () => { throw new Error('audit log locked'); });
    expect(carried).toEqual({ settled: [], waiting: [ref] });
  });

  it('three parallel sessions with the same words each hear only their own call', async () => {
    // The owner's case: an app runs sessions 1, 2 and 3 at once; each got the same reply word
    // for word, each with its own reference. Only session 2's call has been answered.
    const actions = store();
    const refs = [await hold(actions, 'run-1'), await hold(actions, 'run-2'), await hold(actions, 'run-3')];
    await actions.finish('run-2', { status: 'completed', status_message: 'done', result: { removed: 'session 2 event' } });
    const read = (ref: string) => readCarriedHeldCalls(actions, history(
      `${WAITING_WORDS}${llmGatewayWaitingTrailer([ref])}`,
    ), KEY);
    const [one, two, three] = await Promise.all(refs.map(read));
    expect(one).toEqual({ settled: [], waiting: [refs[0]] });
    expect(two!.waiting).toEqual([]);
    expect(two!.settled).toHaveLength(1);
    expect(two!.settled[0]).toMatchObject({ result: { removed: 'session 2 event' } });
    expect(three).toEqual({ settled: [], waiting: [refs[2]] });
  });

  it('a reply that told the outcome carries no reference, so the next request tells nothing again', async () => {
    const actions = store();
    const ref = await hold(actions, 'run-told');
    await actions.finish('run-told', { status: 'completed', status_message: 'done', result: { removed: 'x' } });
    const carried = await readCarriedHeldCalls(actions, history(
      `${WAITING_WORDS}${llmGatewayWaitingTrailer([ref])}`,
      'It was removed.',
    ), KEY);
    expect(carried).toEqual({ settled: [], waiting: [] });
  });
});
