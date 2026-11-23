/** A declined held write goes into the conversation's note (2026-11-19; the owner's "4"). Measured: after a declined
 *  rename, a turn that said "Continue." read the note's unchanged intent as a request and proposed the rename again
 *  (1 of 2 runs); the run whose note happened to say so asked instead. The host now writes it, once. */
import { expect, it } from 'vitest';
import { createHeldChatWrites } from '../chat-held-writes.js';
import { declinedActionWords, parseStoredBrief, withDeclinedAction } from '../chat-rolling-brief.js';

const note = JSON.stringify({ intent: 'Rename calendar event EVENT-7 to Review.', constraints: ['Keep answers short.'],
  pending: ['Awaiting approval for the rename.'], findings: [], completed: [] });
const plan = { plan_id: 'p1', session_id: 's', turn_id: 't1', tool: 'calendar.rename', tier: 1,
  args: { event_id: 'EVENT-7', title: 'Review' }, status: 'proposed', created_at: 1, hold: { run_id: 'run-1' } };

const settleWith = async (result: unknown, initial: string | null = note) => {
  let stored = initial; const writes: string[] = [];
  const held = createHeldChatWrites({
    plans: { findByHoldRun: async () => plan, resolve: async (_id: string, status: string) => ({ ...plan, status, resolved_at: 2 }),
      markConsumed: async () => undefined, recordExecution: async () => undefined, answerMessageId: () => undefined,
      lapseHold: async () => undefined } as never,
    chatStore: { appendMessage: async () => undefined, readSessionBrief: async () => stored,
      writeSessionBrief: async (_s: string, json: string) => { writes.push(json); stored = json; } } as never,
    broadcast: { emit: () => {} }, signature: { server_kind: 'recued', version: 'test', instance_id: 'declined' } as never,
    now: () => 3,
  });
  const answer = { execution_source: undefined, run_id: 'run-1', tool_name: 'calendar.rename', result, ts: 3 };
  expect(await held.settle(answer)).toBe(true);
  expect(await held.settle(answer)).toBe(true);
  return { writes, stored };
};

it('notes a declined held write in the conversation\'s note, once', async () => {
  const { writes, stored } = await settleWith({ denied: true });
  expect(writes).toHaveLength(1);
  const read = parseStoredBrief(JSON.parse(stored!))!;
  // The fixture's tool has no card title: the tool and its arguments name the action.
  expect(read.constraints).toEqual(['Keep answers short.',
    'The owner declined calendar.rename with event_id: EVENT-7, title: Review; it does not run unless the owner asks for it again.']);
  expect(read.intent).toBe('Rename calendar event EVENT-7 to Review.');
});

it('leaves the note alone when the write ran, and when there is no note', async () => {
  expect((await settleWith({ success: true })).writes).toEqual([]);
  expect((await settleWith({ denied: true }, null)).writes).toEqual([]);
});

it('names the action by its tool, title and arguments, bounded', () => {
  expect(declinedActionWords('work.create', 'Add a task', { kind: 'task', title: 'Call Bob', tags: ['a', 'b'] }))
    .toBe('work.create (Add a task) with kind: task, title: Call Bob, tags: ["a","b"]');
  const long = declinedActionWords('mail.send', undefined, { to: 'ops@example.test', body: `Line one\n\n${'x'.repeat(400)}` });
  expect(long.startsWith('mail.send with to: ops@example.test, body: Line one xxx')).toBe(true);
  expect(long.endsWith('…')).toBe(true);
  expect(long.length).toBe('mail.send with '.length + 240);
  expect(declinedActionWords('notes.clear', undefined, {})).toBe('notes.clear');
});

it('adds the line once, keeps the rest, and drops the retired style\'s fields', () => {
  const once = withDeclinedAction(JSON.stringify({ ...JSON.parse(note), active_context: { version: 1 },
    legacy_standard_note: { version: 1 } }), 'Rename EVENT-7')!;
  expect(JSON.parse(once)).not.toHaveProperty('active_context');
  expect(JSON.parse(once)).not.toHaveProperty('legacy_standard_note');
  expect(withDeclinedAction(once, 'Rename EVENT-7')).toBeNull();
  expect(withDeclinedAction('not json', 'Rename EVENT-7')).toBeNull();
});
