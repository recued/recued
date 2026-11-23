/** D-343 (the owner, 2026-11-14: "the approval message can be more human friendly") — a held AI
 *  tool call's approval carries its plain words for the channels that show text (Telegram, Slack,
 *  email): what it does and to which records, why it waits, and what "Allow in this chat" lets
 *  happen. No tool name, no raw argument. The app's card reads `text`, which stays as it was. A
 *  recipe's hold and an outside agent's call carry plain words too (the owner: "do 5 then 2"). */
import { describe, expect, it } from 'vitest';
import type { Checkpoint } from '@recued/contracts';
import { tier1CallsTitle, tier1KindsPhrase } from '@recued/contracts';
import { buildGatheredPreflightAsk, buildPreflightAsk, type GatheredHoldAsk } from '../preflight-reconciliation.js';

const LABELS = { id: { a1: 'Call the plumber', b2: 'Spanish lesson' } };
const hold = (n: number, tool: string, args: Record<string, unknown>, name: string): GatheredHoldAsk => ({
  checkpoint: {
    checkpoint_id: `cp-${String(n)}`, run_id: `run-${String(n)}`, step_state: {}, created_at: n,
    raw_op: { tier1_tool: tool, op_id: tool, catalog_slug: 'recued:tier1', operation: tool, connection_name: '', op_args: args,
      risk_tier: 'write', execution_source: { channel: 'messenger', vendor: 'telegram', actor: 'user_self',
        chat_session_id: 'messenger:telegram:1', turn_id: 't', user_id: 'owner' } },
    preflight_context: { tool_slug: tool, risk_tier: 'write', value_labels: LABELS, kind_grant: {
      channel: 'chat', actor: 'user_self', channel_session_id: 'chat:messenger:telegram:1', ingredient_slug: 'recued:tier1',
      operation_id: `${tool}:task`, risk_tier: 'write', name, ttl_ms: 3_600_000, max_uses: 100 } },
  } as unknown as Checkpoint,
  context: { raw_op: { op_id: tool }, tool_slug: tool, risk_tier: 'write' },
  item: { summary: tool, args_preview: args },
});
const tick = (n: number, id: string) => hold(n, 'work.update', { kind: 'task', id, done: true }, 'Change a task');

describe('D-343 — an approval in plain words for Telegram, Slack and email', () => {
  it('two tasks ticked off read as such, each by its name', () => {
    const ask = buildGatheredPreflightAsk([tick(1, 'a1'), tick(2, 'b2')]);
    expect(ask.message.plain?.title).toBe('Approve: Tick off 2 tasks');
    const text = ask.message.plain!.text;
    expect(text.split('\n').slice(0, 3)).toEqual(['The AI in your Telegram chat wants to tick off 2 tasks:', '  1. Call the plumber', '  2. Spanish lesson']);
    expect(text).toContain('so they wait for your yes.');
    expect(text).toContain('“Allow in this chat” lets its AI change tasks without asking for the next hour (up to 100), deciding what each is and who or what it is for.');
    // The owner's ruling of 2026-11-10 stays said.
    expect(text).toContain('deciding what each is and who or what it is for');
    expect(text.trimEnd().endsWith('Approve all 2?')).toBe(true);
    for (const raw of ['work.update', 'Technical', 'done: true', 'Task:', 'share', 'chat turn', 'held']) expect(text).not.toContain(raw);
  });

  it('leaves the text the app\'s card reads as it was', () => {
    const ask = buildGatheredPreflightAsk([tick(1, 'a1'), tick(2, 'b2')]);
    expect(ask.message.title).toBe('Approve: Tick a task off, 2 actions');
    expect(ask.message.text).toContain('Technical: tool work.update.');
    expect(ask.options.map((option) => option.id)).toEqual(['approve', 'allow_kind', 'deny']);
  });

  it('one held call names its record, and other details keep their names', () => {
    const one = tick(1, 'a1');
    const plain = buildPreflightAsk({ checkpoint: one.checkpoint, context: one.context }).message.plain!;
    expect(plain.title).toBe('Approve: Tick a task off');
    expect(plain.text.split('\n').slice(0, 2)).toEqual(['The AI in your Telegram chat wants to tick a task off:', '  Call the plumber']);
    expect(plain.text).toContain('so it waits for your yes.');
    // D-343 (the owner's day audit, 2026-11-15) — the title asks and the buttons answer: no third "Approve?".
    expect(plain.text).not.toContain('Approve?');
    const add = buildGatheredPreflightAsk([hold(1, 'work.create', { kind: 'task', title: 'Call Ann' }, 'Add a task'),
      hold(2, 'work.create', { kind: 'task', title: 'Call Ben', due: '2026-11-15' }, 'Add a task')]).message.plain!;
    expect(add.text.split('\n').slice(0, 3)).toEqual(['The AI in your Telegram chat wants to add 2 tasks:', '  1. Call Ann', '  2. Call Ben · due: 2026-11-15']);
  });

  it('a recipe\'s hold says its title, lists what it would do, and drops its technical line', () => {
    const send = (n: number): GatheredHoldAsk => ({
      checkpoint: { checkpoint_id: `cp-m${String(n)}`, run_id: `run-m${String(n)}`, gated_step_id: 'send', created_at: n,
        step_state: { send: { input: { to: [`guest${String(n)}@example.com`], subject: 'New time' } } },
        preflight_context: { tool_slug: 'mail-send', risk_tier: 'write', recipe_title: 'Send a composed email',
          value_labels: { to: { [`guest${String(n)}@example.com`]: `Guest ${String(n)}` } } } } as unknown as Checkpoint,
      context: { recipe_id: 'send-composed-mail', gated_step_id: 'send', tool_slug: 'mail-send', risk_tier: 'write' },
      item: { summary: 'mail-send', args_preview: { to: [`guest${String(n)}@example.com`], subject: 'New time' } },
    });
    const ask = buildGatheredPreflightAsk([send(1), send(2), send(3)]);
    expect(ask.message.plain!.text.split('\n').slice(0, 5)).toEqual(['"Send a composed email" wants to go ahead 3 times:',
      '  For all 3: subject: New time', '  1. to: Guest 1', '  2. to: Guest 2', '  3. to: Guest 3']);
    expect(ask.message.plain!.text).toContain('These change data outside Recued, so they wait for your yes.');
    for (const raw of ['Technical', 'send-composed-mail', 'chat turn', 'held']) expect(ask.message.plain!.text).not.toContain(raw);
    // The card's text keeps its technical line.
    expect(ask.message.text).toContain('Technical: recipe send-composed-mail, step send, action mail-send.');
  });

  it('an agent\'s call names a built-in operation as the Grant switches page does, any other by its short name', () => {
    const agent = (op: string, operation: string) => buildPreflightAsk({
      checkpoint: { checkpoint_id: 'cr', run_id: 'rr', step_state: {}, created_at: 1, raw_op: { op_id: op, catalog_slug: 'x', operation,
        connection_name: '', op_args: {}, execution_source: { channel: 'mcp', actor: 'contracted_user', agent_id: 'a', tool_call_id: 'c',
          mcp_token_id: 't', contract_id: 'k' }, risk_tier: 'write', arg_shape_hash: 'h', canonical_payload_hash: 'p', correlation_id: 'c' } } as unknown as Checkpoint,
      context: { raw_op: { op_id: op }, tool_slug: op, risk_tier: 'write' } }).message;
    const mail = agent('core.mail.send', 'core.mail.send');
    expect(mail.text.split('\n')[0]).toBe('An AI agent wants to run core.mail.send.');
    expect(mail.plain).toMatchObject({ title: 'Approve: Send an email' });
    expect(mail.plain!.text.split('\n')[0]).toBe('An AI agent wants to send an email.');
    expect(agent('recued-core.crm-pack.deal.create', 'deal.create').plain!.text.split('\n')[0]).toBe('An AI agent wants to use “deal.create”.');
  });

  it('counts the kinds a title names, and only whole ones', () => {
    expect(tier1CallsTitle('Add a thing you own', 3)).toBe('Add 3 things you own');
    expect(tier1CallsTitle('Mark a booking completed', 2)).toBe('Mark 2 bookings completed');
    expect(tier1CallsTitle('Stop an occasion’s reminders', 2)).toBe('Stop an occasion’s reminders, 2 times');
    expect(tier1CallsTitle('Record your day · Sat 14 Nov', 2)).toBe('Record your day · Sat 14 Nov, 2 times');
    expect(tier1CallsTitle('Add a task', 1)).toBe('Add a task');
    expect(tier1KindsPhrase('Send an email')).toBe('Send an email');
  });
});
