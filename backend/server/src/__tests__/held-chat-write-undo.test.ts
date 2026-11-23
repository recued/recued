/** A chat's own write, held for the owner's approval (D-329) and approved, keeps the receipt the
 *  owner's Undo needs, as a write approved on its card does. Before, an approved hold ran its call
 *  with no review, so no change the owner's own chats made could be undone: they always hold.
 *
 *  Driven, not read (`held-chat-write-fixture.ts`): the real chat gate, plan store, hold, ask and
 *  answer path, resumer and settlement, the approved run as the server wires it, and a real update
 *  of an event on Recued's own calendar. */

import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { calendarChatUpdateInput } from '../collections/calendar/chat-update-input.js';
import { heldChatFixture } from './held-chat-write-fixture.js';
import { resourceFixtureDisposers } from './preapproval-resources-fixture.js';

afterEach(async () => { for (const dispose of resourceFixtureDisposers.splice(0).reverse()) await dispose(); });

const RENAME = { calendar_id: 'local', source_id: 'meeting', summary: 'Chat reviewed meeting' };

describe('a chat\'s own write, held and approved', () => {
  it('keeps the receipt the owner\'s Undo needs, and the Undo puts the event back', async () => {
    const c = await heldChatFixture();
    const before = c.receipts();
    const { result, plan } = await c.ask('calendar.update', RENAME);
    expect(result).toMatchObject({ ok: false, reason: 'awaiting_approval' });
    expect(plan.hold).toBeDefined();
    expect(c.invoke).not.toHaveBeenCalled();

    await c.answer('approve');
    const card = await c.card(plan.plan_id);
    expect(c.f.calendar.table.get('meeting')!.event.summary).toBe('Chat reviewed meeting');
    expect(card.plan.status).toBe('approved');
    // Its card was told, once, that it was approved.
    expect(c.events.filter((event) => event.kind === 'chat.plan_resolved')).toEqual([
      expect.objectContaining({ plan: expect.objectContaining({ plan_id: plan.plan_id, status: 'approved' }) })]);
    expect(card.execution).toMatchObject({ status: 'completed', local_receipt: { kind: 'local_calendar' } });
    expect(c.receipts() - before).toBe(1);
    expect(c.invoke).toHaveBeenCalledTimes(1);

    const receipt = card.execution!.status === 'completed' ? card.execution!.local_receipt!.receipt_id : '';
    expect(await c.undo(receipt)).toMatchObject({ status: 'completed' });
    expect(c.f.calendar.table.get('meeting')!.event.summary).toBe('Original meeting');
  });

  it('⛔ refused when its event changed after it was proposed: nothing changes, and its card says it was not done', async () => {
    const c = await heldChatFixture();
    const { plan } = await c.ask('calendar.update', RENAME);
    // Changed elsewhere while the ask waited.
    await c.f.execution.executorConfig.kernelDispatchers!.calendarUpdate!({ slug: 'local', source_id: 'meeting',
      patch: { summary: 'Changed elsewhere' } });
    const before = c.receipts();
    await c.answer('approve');
    const card = await c.card(plan.plan_id);
    expect(card.execution).toMatchObject({ status: 'failed' });
    expect(c.f.calendar.table.get('meeting')!.event.summary).toBe('Changed elsewhere');
    expect(c.receipts()).toBe(before);
  });

  it('⛔ refused when its grant is withdrawn while it is prepared: checked again inside its write', async () => {
    const c = await heldChatFixture();
    const { plan } = await c.ask('calendar.update', RENAME);
    const gate = c.f.execution.opAdmissionGate!;
    const granted = gate.isOpGranted.bind(gate);
    let withdrawn = false;
    gate.isOpGranted = (source, entry) => !withdrawn && granted(source, entry);
    // Withdrawn after the resume's own check, as the call starts.
    c.invoke.mockImplementationOnce(async (_name, args) => {
      withdrawn = true;
      return { ok: true, result: await c.f.execution.executorConfig.kernelDispatchers!.calendarUpdate!(
        calendarChatUpdateInput(args as Record<string, unknown>)) };
    });
    const before = c.receipts();
    await c.answer('approve');
    const card = await c.card(plan.plan_id);
    expect(card.execution).toMatchObject({ status: 'failed' });
    expect(c.f.calendar.table.get('meeting')!.event.summary).toBe('Original meeting');
    expect(c.receipts()).toBe(before);
  });

  it('a write that changes nothing Recued can undo runs as it did, with no receipt', async () => {
    const c = await heldChatFixture();
    const before = c.receipts();
    const { plan } = await c.ask('note.add', { text: 'Bring the slides' });
    expect(plan.resource_review).toBeUndefined();
    await c.answer('approve');
    const card = await c.card(plan.plan_id);
    expect(card.execution).toMatchObject({ status: 'completed' });
    expect(card.execution).not.toHaveProperty('local_receipt');
    expect(c.invoke).toHaveBeenCalledWith('note.add', { text: 'Bring the slides' }, expect.anything());
    expect(c.receipts()).toBe(before);
  });

  it('a change Recued reviews but cannot undo runs as it did: under no review, keeping nothing', async () => {
    const c = await heldChatFixture();
    // An event on another provider's calendar: reviewed against its version, never undone.
    const remote = { schema_version: 1, operation: 'remote.update', input_hash: 'a'.repeat(64), captured_at: c.f.clock.now,
      resources: [{ kind: 'calendar', key: 'remote:standup', label: 'Standup', binding: 'google', version: 'v1',
        before: { summary: 'Standup' }, after: { summary: 'Team standup' }, precondition: { kind: 'etag', value: 'e1' } }] };
    const hooks = c.f.execution.executorConfig.resourceReview!;
    c.f.execution.executorConfig.resourceReview = { ...hooks,
      capture: (slug, input, approved, resuming) => (slug === 'remote.update' ? remote as never : hooks.capture(slug, input, approved, resuming)) };
    const before = c.receipts();
    const { plan } = await c.ask('remote.update', { event: 'standup', summary: 'Team standup' });
    expect(plan.resource_review).toMatchObject({ operation: 'remote.update' });
    await c.answer('approve');
    const card = await c.card(plan.plan_id);
    expect(card.execution).toMatchObject({ status: 'completed' });
    expect(card.execution).not.toHaveProperty('local_receipt');
    expect(c.reviewed).toEqual([undefined]);
    expect(c.receipts()).toBe(before);
  });

  it('a refused ask runs nothing and spends nothing', async () => {
    const c = await heldChatFixture();
    await c.ask('calendar.update', RENAME);
    await c.answer('deny');
    await vi.waitFor(async () => expect((await c.plans.listForSession!(c.session_id))[0]!.plan).toMatchObject({ status: 'cancelled' }));
    expect(c.invoke).not.toHaveBeenCalled();
    expect(c.f.calendar.table.get('meeting')!.event.summary).toBe('Original meeting');
  });
});

describe('D-348 §7.8 — a chat\'s own write a standing permission lets through without asking', () => {
  // A D-329 write rule the owner accepted for renaming events.
  const rule = (_source: unknown, tool: string) => (tool === 'calendar.update' || tool === 'note.add'
    ? { rule_id: 'wr_1', uses_remaining: 9 } : undefined);

  it('keeps its receipt on its line, and the Undo puts the event back', async () => {
    const c = await heldChatFixture({ useWriteRule: rule });
    const before = c.receipts();
    const { result } = await c.ask('calendar.update', RENAME);
    expect(result).toMatchObject({ ok: true });
    expect(c.f.calendar.table.get('meeting')!.event.summary).toBe('Chat reviewed meeting');
    // It ran under a review of its change, taken as the rule let it through.
    expect(c.reviewed).toEqual([expect.objectContaining({ operation: 'calendar-update' })]);
    const call = c.lastCall()!;
    expect(call).toMatchObject({ tool_name: 'calendar.update', state: 'succeeded', local_receipt: { kind: 'local_calendar' } });
    expect(c.receipts() - before).toBe(1);
    expect(await c.undo(call.local_receipt!.receipt_id)).toMatchObject({ status: 'completed' });
    expect(c.f.calendar.table.get('meeting')!.event.summary).toBe('Original meeting');
  });

  it('⛔ in a whole turn its answer names the call\'s row, so the line finds the receipt, live and reloaded', async () => {
    // The test above dispatches the call itself. The owner's app finds a line's receipt through
    // the answer's own list of calls, which only a turn writes.
    const c = await heldChatFixture({ useWriteRule: rule });
    const answer = await c.wholeTurn('calendar.update', RENAME);
    expect(c.f.calendar.table.get('meeting')!.event.summary).toBe('Chat reviewed meeting');
    const call = c.lastCall()!;
    expect(call).toMatchObject({ tool_name: 'calendar.update', state: 'succeeded', local_receipt: { kind: 'local_calendar' } });
    expect(answer.tool_calls).toEqual([expect.objectContaining({ tool_name: 'calendar.update', call_id: call.message_id })]);
    // Live: the call's settlement reaches the open chat with its receipt.
    expect(c.events).toContainEqual(expect.objectContaining({ kind: 'chat.session_changed', field: 'tool_call',
      value: expect.objectContaining({ message_id: call.message_id, state: 'succeeded', local_receipt: call.local_receipt }) }));
  });

  it('a write that changes nothing Recued can undo keeps nothing, and runs as it did', async () => {
    const c = await heldChatFixture({ useWriteRule: rule });
    const before = c.receipts();
    await c.ask('note.add', { text: 'Bring the slides' });
    expect(c.reviewed).toEqual([undefined]);
    expect(c.lastCall()).toMatchObject({ tool_name: 'note.add', state: 'succeeded' });
    expect(c.lastCall()).not.toHaveProperty('local_receipt');
    expect(c.receipts()).toBe(before);
  });

  it('a change Recued reviews but cannot undo runs as it did: under no review, keeping nothing', async () => {
    const c = await heldChatFixture({ useWriteRule: (_source, tool) => (tool === 'remote.update' ? { rule_id: 'wr_1', uses_remaining: 9 } : undefined) });
    const remote = { schema_version: 1, operation: 'remote.update', input_hash: 'a'.repeat(64), captured_at: c.f.clock.now,
      resources: [{ kind: 'calendar', key: 'remote:standup', label: 'Standup', binding: 'google', version: 'v1',
        before: { summary: 'Standup' }, after: { summary: 'Team standup' }, precondition: { kind: 'etag', value: 'e1' } }] };
    const hooks = c.f.execution.executorConfig.resourceReview!;
    c.f.execution.executorConfig.resourceReview = { ...hooks,
      capture: (slug, input, approved, resuming) => (slug === 'remote.update' ? remote as never : hooks.capture(slug, input, approved, resuming)) };
    const before = c.receipts();
    expect(await (await c.ask('remote.update', { event: 'standup', summary: 'Team standup' })).result).toMatchObject({ ok: true });
    expect(c.reviewed).toEqual([undefined]);
    expect(c.lastCall()).toMatchObject({ tool_name: 'remote.update', state: 'succeeded' });
    expect(c.lastCall()).not.toHaveProperty('local_receipt');
    expect(c.receipts()).toBe(before);
  });

  it('a change that needs no ask is untouched: under no review, keeping nothing, as before', async () => {
    const c = await heldChatFixture({ useWriteRule: rule });
    // Reviewed as a rename of a local event would be, so only its needing no ask keeps it out.
    const hooks = c.f.execution.executorConfig.resourceReview!;
    c.f.execution.executorConfig.resourceReview = { ...hooks,
      capture: (slug, input, approved, resuming) => hooks.capture(slug === 'calendar.touch' ? 'calendar.update' : slug, input, approved, resuming) };
    const before = c.receipts();
    expect((await c.ask('calendar.touch', RENAME)).result).toMatchObject({ ok: true });
    expect(c.f.calendar.table.get('meeting')!.event.summary).toBe('Chat reviewed meeting');
    expect(c.reviewed).toEqual([undefined]);
    expect(c.lastCall()).toMatchObject({ tool_name: 'calendar.touch', state: 'succeeded' });
    expect(c.lastCall()).not.toHaveProperty('local_receipt');
    expect(c.receipts()).toBe(before);
  });

  it('a change that failed keeps no receipt, and its line no Undo', async () => {
    const c = await heldChatFixture({ useWriteRule: rule });
    const before = c.receipts();
    await expect(c.ask('calendar.update', { ...RENAME, source_id: 'no-such-event' })).rejects.toThrow(/CALENDAR_EVENT_NOT_FOUND/);
    expect(c.lastCall()).toMatchObject({ tool_name: 'calendar.update' });
    expect(c.lastCall()).not.toHaveProperty('local_receipt');
    expect(c.receipts()).toBe(before);
  });
});

describe('as the server wires it', () => {
  // The tests above hand the execute deps the approved run themselves, so they stay green if the
  // server never does: these lines are the server doing it (as D-231's wiring is pinned).
  it('⛔ the chat builds it, the app keeps it, and the execute deps hand it to the resume', () => {
    const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
    expect(read('../composition/bin/wire-chat-orchestrator.ts'))
      .toMatch(/runApprovedTier1Write: createRunApprovedTier1Write\(\{\s*plans: planApprovalStoreShared,/);
    expect(read('../serve/compose-app-context.ts')).toMatch(/tier1ApprovedRunRef: chatBundle\.runApprovedTier1Write/);
    const root = read('../serve/compose-execution-context.ts');
    expect(root).toMatch(/runApprovedTier1Write: \(call, dispatch\) =>\s*\(app\.tier1ApprovedRunRef !== undefined \? app\.tier1ApprovedRunRef\(call, dispatch\)/);
    expect(root).toMatch(/\|\s*'tier1ApprovedRunRef'/);
    expect(read('../composition/bin/wire-execute-deps.ts')).toMatch(/runApprovedTier1Write: deps\.runApprovedTier1Write/);
    expect(read('../raw-op-dispatch.ts')).toMatch(/await deps\.runApprovedTier1Write!\(\{ run_id, tool, args: raw\.op_args, source,/);
  });
});
