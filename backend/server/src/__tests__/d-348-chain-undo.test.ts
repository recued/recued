/** D-348 Q4 — "any refusal, undo … resets the count": the owner undoes a change a request's held
 *  call made, and nothing the request did before the undo counts toward its chain. A live rule that
 *  holds the call that made the change ends too, but not for good.
 *
 *  Driven, not read: the real execute handler, commit gateway, resumer and local receipts; the
 *  owner's real undo (`local_undo.review` / `decide`, as the app's Undo calls it) over Recued's
 *  own calendar; the real chain stores, on the same database, as the server composes them. */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CanonicalEvent, ExecutionSource, RecipeDefinition } from '@recued/contracts';

import { CHAIN_REQUEST_STATE_KEY, noteChainHeldRun, noteChainUnheld, openChainRequest } from '../chain-evidence.js';
import { handleExecute } from '../execute-handler.js';
import { createPreflightResumer } from '../preflight-resumer.js';
import { createSessionGrantResolver } from '../session-grant-resolver.js';
import { createContractDefinitionStore } from '../storage/contract-definition-store.js';
import { executeResponseAuditRunId } from '../types.js';
import { createChainEvidenceStore } from '../storage/chain-evidence-store.js';
import { createChainRuleStore } from '../storage/chain-rule-store.js';
import { heldChatFixture } from './held-chat-write-fixture.js';
import { ordinaryLocalFixture } from './ordinary-local-mutations-fixture.js';
import { resourceFixtureDisposers } from './preapproval-resources-fixture.js';

afterEach(async () => { for (const dispose of resourceFixtureDisposers.splice(0).reverse()) await dispose(); });

const DAY = 86_400_000;
const WORDS = 'Rename the team meeting';
const rename = (id: string, source_id: string, suffix = ''): RecipeDefinition['steps'][number] => ({ id, ingredient: 'calendar-update',
  input: { slug: 'local', source_id, patch: { summary: `{{config.summary}}${suffix}` } } });

const server = async (steps: RecipeDefinition['steps'] = [rename('rename', 'meeting')]) => {
  const f = await ordinaryLocalFixture();
  // Asked about, as a write the owner has not set to "always ask": what a chain may learn.
  f.contracts.put('owner_operation', ['calendar-update', 'calendar-update'], { approval: 'ask', op_hash: 'fixture-review' });
  if (!f.calendar.table.get('standup')) {
    const event: CanonicalEvent = { source_id: 'standup', calendar_id: 'local', ical_uid: 'standup@local', summary: 'Original standup',
      start_at: f.clock.now, end_at: f.clock.now + 900_000, timezone: 'UTC', is_all_day: false, status: 'confirmed',
      created_at: f.clock.now, updated_at: f.clock.now };
    f.calendar.table.upsert({ event, size_bytes: 0 });
  }
  f.recipe.variables = { summary: { label: 'Summary', type: 'text' } };
  /** The recipe the owner's chat runs: the meeting renamed as asked. */
  const chatRecipe = () => f.save(steps);
  chatRecipe();
  const chainEvidence = createChainEvidenceStore(f.db);
  const chainRules = createChainRuleStore(f.db, chainEvidence);
  f.execution.chainEvidence = chainEvidence;
  f.execution.chainRules = chainRules;
  f.execution.now = () => f.clock.now;
  const notices: string[] = [];
  const notify = f.block.notify.bind(f.block);
  vi.spyOn(f.block, 'notify').mockImplementation(async (notice, ...rest) => {
    notices.push(notice.title ?? '');
    return notify(notice, ...rest);
  });
  const resumer = createPreflightResumer({ getExecuteDeps: () => f.execution, auditLog: f.execution.auditLog!,
    gatedActionStore: f.execution.gatedActionStore });
  let turn = 0;
  /** The owner asks in their chat; each call the run holds, the owner approves. Returns each step's
   *  change's receipt, which the app's Undo names. */
  const ask = async (summary: string, words = WORDS) => {
    turn += 1;
    const turn_id = `turn-${String(turn)}`;
    const source = { channel: 'chat', actor: 'user_self', chat_session_id: 'chat-1', user_id: 'realm', turn_id } as ExecutionSource;
    const request = openChainRequest(chainEvidence, { session_id: 'chat-1', turn_id, source, words, at: f.clock.now });
    const held = await handleExecute(f.execution, { recipe_id: f.recipe.recipe_id, config: { summary },
      trigger_source: 'chat', execution_source: source } as never);
    if (!held.awaiting_approval || !held.action_ref) throw new Error('Expected a hold: ' + JSON.stringify(held));
    const { run_id } = (await f.execution.gatedActionStore!.get(held.action_ref))!;
    noteChainHeldRun(chainEvidence, new Map([[CHAIN_REQUEST_STATE_KEY, request]]), run_id, f.clock.now);
    await vi.waitFor(() => expect(chainEvidence.keyOfRequest(turn_id)).toBeDefined());
    for (const _hold of steps) {
      const [checkpoint] = await f.execution.checkpointStore!.listByRun(run_id);
      if (checkpoint === undefined) break;
      await resumer.resumeRun(checkpoint, { recipe_id: checkpoint.recipe_id, gated_step_id: checkpoint.gated_step_id });
    }
    expect(f.calendar.table.get('meeting')!.event.summary).toBe(summary);
    const actions = (await f.execution.gatedActionStore!.list()).filter((action) => action.run_id === run_id);
    return Object.fromEntries(actions.map((action) => [action.gated_step_id, action.local_receipt!.receipt_id]));
  };
  /** The owner undoes a change in the app: a review, then their yes. */
  const undo = async (receipt_id: string) => {
    const handlers = f.composed.handlers.localUndo!;
    const review = await handlers.review(receipt_id, f.origin);
    return handlers.decide({ undo_id: review.undo_id, review_hash: review.review_hash, decision: 'approve' }, f.origin);
  };
  const suggested = async () => (await chainRules.listSuggestions(f.clock.now)).map((row) => row.words);
  const accept = async () => {
    const [suggestion] = await chainRules.listSuggestions(f.clock.now);
    return (await chainRules.accept(suggestion!.key_hash, {}, f.clock.now)).rule;
  };
  const rows = (table: string) => f.db.prepare(`SELECT * FROM ${table}`).all() as Array<Record<string, unknown>>;
  return { f, ask, undo, suggested, accept, rows, chainEvidence, chainRules, chatRecipe, notices, nextDay: () => { f.clock.now += DAY; } };
};

describe('D-348 Q4 — an undo of what a request did resets what it taught', () => {
  it('the suggestion goes as the owner undoes the change, and comes back after three days more', async () => {
    const s = await server();
    let receipt = '';
    for (const summary of ['Team sync', 'Team sync 2', 'Team sync 3']) {
      receipt = (await s.ask(summary)).rename!;
      s.nextDay();
    }
    expect(await s.suggested()).toEqual([WORDS]);

    expect(await s.undo(receipt)).toMatchObject({ status: 'completed' });
    expect(s.f.calendar.table.get('meeting')!.event.summary).toBe('Team sync 2');
    expect(s.rows('chain_undos')).toEqual([expect.objectContaining({ request_id: 'turn-3', at: s.f.clock.now })]);
    expect(await s.suggested()).toEqual([]);

    // The days before the undo count no more: three after it are needed.
    s.nextDay();
    await s.ask('Team sync 4');
    s.nextDay();
    await s.ask('Team sync 5');
    expect(await s.suggested()).toEqual([]);
    s.nextDay();
    await s.ask('Team sync 6');
    expect(await s.suggested()).toEqual([WORDS]);
  });

  it('an undo of a change no request of the owner\'s chats made resets nothing', async () => {
    const s = await server();
    for (const summary of ['Team sync', 'Team sync 2']) { await s.ask(summary); s.nextDay(); }
    // A rename run by the owner from the app rather than asked for in a chat (set to "always ask",
    // so the owner's own run is asked about too, and keeps its change's receipt).
    s.f.contracts.put('owner_operation', ['calendar-update', 'calendar-update'], { approval: 'always', op_hash: 'fixture-review' });
    const held = await s.f.hold([{ id: 'rename', ingredient: 'calendar-update',
      input: { slug: 'local', source_id: 'meeting', patch: { summary: 'From the app' } } }]);
    await held.resume();
    const receipt = (await s.f.execution.gatedActionStore!.get(held.action.action_ref))!.local_receipt!.receipt_id;
    expect(await s.undo(receipt)).toMatchObject({ status: 'completed' });
    expect(s.rows('chain_undos')).toEqual([]);
    // The request's two days still count: a third suggests it.
    s.f.contracts.put('owner_operation', ['calendar-update', 'calendar-update'], { approval: 'ask', op_hash: 'fixture-review' });
    s.chatRecipe();
    await s.ask('Team sync 3');
    expect(await s.suggested()).toEqual([WORDS]);
  });

  it('a change the rule made without asking keeps its receipt: its undo ends the rule and resets the request', async () => {
    const s = await server();
    for (const summary of ['Team sync', 'Team sync 2', 'Team sync 3']) { await s.ask(summary); s.nextDay(); }
    const rule = await s.accept();
    const receipts = () => s.rows('local_mutation_receipts').map((row) => JSON.parse(row.data as string) as
      { receipt_id: string; owner: string; owner_ref: string });
    const before = receipts().length;
    const source = { channel: 'chat', actor: 'user_self', chat_session_id: 'chat-1', user_id: 'realm', turn_id: 'turn-ruled' } as ExecutionSource;
    const result = await handleExecute(s.f.execution, { recipe_id: s.f.recipe.recipe_id, config: { summary: 'Team sync 4' },
      trigger_source: 'chat', execution_source: source } as never, { chain_request_key: rule.key_hash });
    expect(result).toMatchObject({ success: true });
    expect(result.awaiting_approval).toBeUndefined();
    expect(s.f.calendar.table.get('meeting')!.event.summary).toBe('Team sync 4');
    expect(await s.chainRules.listRules(s.f.clock.now)).toEqual([expect.objectContaining({ uses_remaining: 99 })]);
    // It kept a receipt, and its commit names the rule that let it through.
    expect(receipts()).toHaveLength(before + 1);
    const made = receipts().at(-1)!;
    const commit = JSON.parse((s.f.db.prepare('SELECT data FROM commits WHERE key=?').get(made.owner_ref) as { data: string }).data);
    expect(commit).toMatchObject({ chain_rule: { id: rule.rule_id } });

    s.nextDay();
    expect(await s.undo(made.receipt_id)).toMatchObject({ status: 'completed' });
    expect(s.f.calendar.table.get('meeting')!.event.summary).toBe('Team sync 3');
    expect(await s.chainRules.listRules(s.f.clock.now)).toEqual([]);
    await vi.waitFor(() => expect(s.notices).toContain('A rule ended because you undid a change'));
    const ended = (await s.f.execution.auditLog!.listActivities()).filter((row) => row.action === 'chain_rule_revoked');
    expect(ended.map((row) => [row.target, JSON.parse(row.detail!).ended_by])).toEqual([[rule.rule_id, 'undo']]);
    // Not for good, and nothing before the undo counts: three days after it bring it back.
    for (const summary of ['Team sync 5', 'Team sync 6']) { s.nextDay(); await s.ask(summary); }
    expect(await s.suggested()).toEqual([]);
    s.nextDay();
    await s.ask('Team sync 7');
    expect(await s.suggested()).toEqual([WORDS]);
  });

  it('§7.8 — a change a grant let the request\'s run make without asking: its undo resets the request all the same', async () => {
    const s = await server();
    for (const summary of ['Team sync', 'Team sync 2', 'Team sync 3']) { await s.ask(summary); s.nextDay(); }
    expect(await s.suggested()).toEqual([WORDS]);
    // "Allow in this chat" for renaming an event, for the hour: the request's next run asks nothing.
    // Its grants kept on the server's clock, as the test's.
    const definitions = createContractDefinitionStore(s.f.contracts, { now: () => s.f.clock.now });
    s.f.execution.sessionGrantResolver = createSessionGrantResolver({ definitionStore: definitions, now: () => s.f.clock.now });
    definitions.mintKindGrant({ minted_by: 'owner', display_name: 'Allowed in this chat — Rename an event',
      scope: { channels: ['chat'], actors: ['user_self'], ingredient_ids: ['calendar-update'], operation_ids: ['calendar-update'] },
      channel_session_id: 'chat:chat-1', risk_tier: 'write', approved_action_ref: 'run-allowed',
      expiry_at: s.f.clock.now + 3_600_000, max_uses: 100 });
    const source = { channel: 'chat', actor: 'user_self', chat_session_id: 'chat-1', user_id: 'realm', turn_id: 'turn-allowed' } as ExecutionSource;
    const request = openChainRequest(s.chainEvidence, { session_id: 'chat-1', turn_id: 'turn-allowed', source, words: WORDS, at: s.f.clock.now });
    const receipts = () => s.rows('local_mutation_receipts').map((row) => JSON.parse(row.data as string) as
      { receipt_id: string; owner: string; owner_ref: string });
    const before = receipts().length;
    // The chat's AI writes the rename as its own recipe, which a grant that names none lets through.
    const result = await handleExecute(s.f.execution, { recipe: { ...s.f.recipe, recipe_id: 'chat-written-rename' },
      config: { summary: 'Team sync 4' }, trigger_source: 'chat', execution_source: source } as never,
    { chain_request_key: request!.key_hash! });
    expect(result).toMatchObject({ success: true });
    expect(result.awaiting_approval).toBeUndefined();
    expect(s.f.calendar.table.get('meeting')!.event.summary).toBe('Team sync 4');
    // As the chat notes a run of its request that held nothing, by the id it reads off the run
    // (`noteChainUnheld`; the chat's own call of it is tested below).
    const run_id = executeResponseAuditRunId(result)!;
    expect(run_id).toEqual(expect.any(String));
    noteChainUnheld(s.chainEvidence, new Map([[CHAIN_REQUEST_STATE_KEY, request]]), { ref: run_id, session_id: 'chat-1', at: s.f.clock.now });
    expect(receipts()).toHaveLength(before + 1);
    const made = receipts().at(-1)!;
    expect(made).toMatchObject({ owner: 'ordinary_commit' });

    expect(await s.undo(made.receipt_id)).toMatchObject({ status: 'completed' });
    expect(s.f.calendar.table.get('meeting')!.event.summary).toBe('Team sync 3');
    expect(s.rows('chain_unheld_undos')).toEqual([expect.objectContaining({ ref: run_id, at: s.f.clock.now })]);
    expect(s.rows('chain_undos')).toEqual([]);
    expect(await s.suggested()).toEqual([]);
    // Nothing before the undo counts: three days after it bring it back (the grant long ended).
    for (const summary of ['Team sync 5', 'Team sync 6']) { s.nextDay(); await s.ask(summary); }
    expect(await s.suggested()).toEqual([]);
    s.nextDay();
    await s.ask('Team sync 7');
    expect(await s.suggested()).toEqual([WORDS]);
  });

  it('learning never costs the undo: a chain store that fails leaves it done', async () => {
    const s = await server();
    const receipt = (await s.ask('Team sync')).rename!;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    s.f.db.exec('DROP TABLE chain_undos');
    expect(await s.undo(receipt)).toMatchObject({ status: 'completed' });
    expect(s.f.calendar.table.get('meeting')!.event.summary).toBe('Original meeting');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('was not kept'));
    warn.mockRestore();
  });
});

describe('D-348 Q4 — an undo of what a live rule covers ends the rule, but not for good', () => {
  it('the rule ends, the owner is told and Live control is told; three days after the undo suggest it again', async () => {
    const s = await server();
    let receipt = '';
    for (const summary of ['Team sync', 'Team sync 2', 'Team sync 3']) { receipt = (await s.ask(summary)).rename!; s.nextDay(); }
    const rule = await s.accept();
    const changes: string[] = [];
    s.chainRules.onChange((change) => changes.push(`${change.op}:${change.rule_id}`));

    expect(await s.undo(receipt)).toMatchObject({ status: 'completed' });
    expect(changes).toEqual([`revoke:${rule.rule_id}`]);
    expect(await s.chainRules.listRules(s.f.clock.now)).toEqual([]);
    await vi.waitFor(() => expect(s.notices).toContain('A rule ended because you undid a change'));
    const ended = (await s.f.execution.auditLog!.listActivities()).filter((row) => row.action === 'chain_rule_revoked');
    expect(ended.map((row) => [row.target, JSON.parse(row.detail!).ended_by])).toEqual([[rule.rule_id, 'undo']]);

    // The request asks again; not for good, as an End is: three days after the undo bring it back.
    for (const summary of ['Team sync 4', 'Team sync 5']) { s.nextDay(); await s.ask(summary); }
    expect(await s.suggested()).toEqual([]);
    s.nextDay();
    await s.ask('Team sync 6');
    expect(await s.suggested()).toEqual([WORDS]);
  });

  it('a run of two calls: the undo names the one whose change it undid, by the hold it was approved on', async () => {
    const s = await server([rename('rename', 'meeting'), rename('standup', 'standup', ' standup')]);
    let made: Record<string, string> = {};
    for (const summary of ['Team sync', 'Team sync 2', 'Team sync 3']) { made = await s.ask(summary); s.nextDay(); }
    expect(Object.keys(made).sort()).toEqual(['rename', 'standup']);
    const [suggestion] = await s.chainRules.listSuggestions(s.f.clock.now);
    expect(suggestion!.members).toHaveLength(2);
    const rule = await s.accept();
    const changes: string[] = [];
    s.chainRules.onChange((change) => changes.push(`${change.op}:${change.rule_id}`));
    // The run held two calls, so only the hold the change was approved on can say which made it.
    expect(await s.undo(made.standup!)).toMatchObject({ status: 'completed' });
    expect(s.f.calendar.table.get('standup')!.event.summary).toBe('Team sync 2 standup');
    expect(s.f.calendar.table.get('meeting')!.event.summary).toBe('Team sync 3');
    expect(changes).toEqual([`revoke:${rule.rule_id}`]);
    expect(await s.chainRules.listRules(s.f.clock.now)).toEqual([]);
  });
});

describe('D-348 Q4 — a chat\'s own write, held and approved, then undone', () => {
  const WORDS_CHAT = 'Rename the team meeting';
  /** One day of the owner asking, its rename held and approved; the change's receipt. */
  const day = async (c: Awaited<ReturnType<typeof heldChatFixture>>, summary: string) => {
    const { plan } = await c.ask('calendar.update', { calendar_id: 'local', source_id: 'meeting', summary }, WORDS_CHAT);
    await c.answer('approve');
    const card = await c.card(plan.plan_id);
    c.nextDay();
    return card.execution!.status === 'completed' ? card.execution!.local_receipt!.receipt_id : '';
  };

  it('its undo resets what the request taught, as a recipe step\'s does', async () => {
    const c = await heldChatFixture();
    let receipt = '';
    for (const summary of ['Team sync', 'Team sync 2', 'Team sync 3']) receipt = await day(c, summary);
    expect((await c.chainRules.listSuggestions(c.f.clock.now)).map((row) => row.words)).toEqual([WORDS_CHAT]);
    expect(await c.undo(receipt)).toMatchObject({ status: 'completed' });
    expect(c.f.db.prepare('SELECT count(*) FROM chain_undos').pluck().get()).toBe(1);
    expect(await c.chainRules.listSuggestions(c.f.clock.now)).toEqual([]);
  });

  it('a live rule that covers it ends, but not for good', async () => {
    const c = await heldChatFixture();
    let receipt = '';
    for (const summary of ['Team sync', 'Team sync 2', 'Team sync 3']) receipt = await day(c, summary);
    const [suggestion] = await c.chainRules.listSuggestions(c.f.clock.now);
    const { rule } = await c.chainRules.accept(suggestion!.key_hash, {}, c.f.clock.now);
    expect(await c.undo(receipt)).toMatchObject({ status: 'completed' });
    expect(await c.chainRules.listRules(c.f.clock.now)).toEqual([]);
    const ended = (await c.f.execution.auditLog!.listActivities()).filter((row) => row.action === 'chain_rule_revoked');
    expect(ended.map((row) => row.target)).toEqual([rule.rule_id]);
  });

  it('§7.8 — a write a D-329 rule lets through without asking: undone, its request starts again; no rule ends', async () => {
    let allowed = false;
    const c = await heldChatFixture({ useWriteRule: (_source, tool) => (allowed && tool === 'calendar.update'
      ? { rule_id: 'wr_1', uses_remaining: 9 } : undefined) });
    for (const summary of ['Team sync', 'Team sync 2', 'Team sync 3']) await day(c, summary);
    expect((await c.chainRules.listSuggestions(c.f.clock.now)).map((row) => row.words)).toEqual([WORDS_CHAT]);
    allowed = true;
    const { result } = await c.ask('calendar.update', { calendar_id: 'local', source_id: 'meeting', summary: 'Team sync 4' }, WORDS_CHAT);
    allowed = false;
    expect(result).toMatchObject({ ok: true });
    const call = c.lastCall()!;
    expect(call).toMatchObject({ state: 'succeeded', local_receipt: { kind: 'local_calendar' } });
    // Noted by its row with its request's key, as the chat let it through.
    expect(c.f.db.prepare('SELECT ref FROM chain_unheld_refs').pluck().all()).toEqual([call.message_id]);
    expect(await c.undo(call.local_receipt!.receipt_id)).toMatchObject({ status: 'completed' });
    expect(c.f.db.prepare('SELECT ref FROM chain_unheld_undos').pluck().all()).toEqual([call.message_id]);
    expect(await c.chainRules.listSuggestions(c.f.clock.now)).toEqual([]);
    expect((await c.f.execution.auditLog!.listActivities()).filter((row) => row.action === 'chain_rule_revoked')).toEqual([]);
    c.nextDay();
    for (const summary of ['Team sync 5', 'Team sync 6']) await day(c, summary);
    expect(await c.chainRules.listSuggestions(c.f.clock.now)).toEqual([]);
    await day(c, 'Team sync 7');
    expect((await c.chainRules.listSuggestions(c.f.clock.now)).map((row) => row.words)).toEqual([WORDS_CHAT]);
  });

  it('§7.8 — a run the request\'s turn starts that holds nothing is noted for its undo; one that holds is not', async () => {
    const c = await heldChatFixture();
    await c.ask('routine.start', {}, WORDS_CHAT);
    expect(c.f.db.prepare('SELECT ref, session_id FROM chain_unheld_refs').all())
      .toEqual([{ ref: 'run-routine-1', session_id: c.session_id }]);
    // One that holds is recorded as held, never as unheld too.
    await c.ask('routine.start', { hold: true }, WORDS_CHAT);
    await vi.waitFor(() => expect(c.f.db.prepare('SELECT run_id FROM chain_runs').pluck().all()).toEqual(['run-routine-2']));
    // A call outside a request (no words) notes nothing.
    await c.ask('routine.start', {}, '?!');
    expect(c.f.db.prepare('SELECT ref FROM chain_unheld_refs').pluck().all()).toEqual(['run-routine-1']);
  });

  it('a write the request\'s rule makes without asking keeps its Undo on its line; undone, the rule ends', async () => {
    const c = await heldChatFixture();
    for (const summary of ['Team sync', 'Team sync 2', 'Team sync 3']) await day(c, summary);
    const [suggestion] = await c.chainRules.listSuggestions(c.f.clock.now);
    const { rule } = await c.chainRules.accept(suggestion!.key_hash, {}, c.f.clock.now);
    const { result } = await c.ask('calendar.update', { calendar_id: 'local', source_id: 'meeting', summary: 'Team sync 4' }, WORDS_CHAT);
    expect(result).toMatchObject({ ok: true });
    expect(await c.chainRules.listRules(c.f.clock.now)).toEqual([expect.objectContaining({ uses_remaining: 99 })]);
    const call = c.lastCall()!;
    expect(call).toMatchObject({ state: 'succeeded', local_receipt: { kind: 'local_calendar' } });
    c.nextDay();
    expect(await c.undo(call.local_receipt!.receipt_id)).toMatchObject({ status: 'completed' });
    expect(c.f.calendar.table.get('meeting')!.event.summary).toBe('Team sync 3');
    expect(await c.chainRules.listRules(c.f.clock.now)).toEqual([]);
    const ended = (await c.f.execution.auditLog!.listActivities()).filter((row) => row.action === 'chain_rule_revoked');
    expect(ended.map((row) => [row.target, JSON.parse(row.detail!).ended_by])).toEqual([[rule.rule_id, 'undo']]);
  });
});
