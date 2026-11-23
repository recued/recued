/** D-348 — what one held call of a chain is (Q3): its operation, and the values that say whom it
 *  reaches and what it changes. A create that stays in Recued pins nothing; a delete pins nothing
 *  either (its record is checked when it runs, Q7); a hold it cannot name has no signature at all. */

import { describe, expect, it } from 'vitest';
import type { Checkpoint } from '@recued/contracts';

import { chainCallPins, chainCallSignatureOf, chainTier1Signature } from '../chain-signature.js';

const chatWrite = (tool: string, op_args: Record<string, unknown>, over: Record<string, unknown> = {}): Checkpoint => ({
  checkpoint_id: 'cp1', run_id: 'run1', step_state: {}, created_at: 1,
  raw_op: {
    tier1_tool: tool, catalog_slug: 'recued:tier1', operation: tool, op_id: tool, op_args, risk_tier: 'write',
    connection_name: '', execution_source: { channel: 'chat', actor: 'user_self', chat_session_id: 's', user_id: 'owner' },
  },
  ...over,
}) as unknown as Checkpoint;

/** Why a gate asked, as it records it on the hold: an op set to ask; a delete's tier asks always. */
const asked = (risk_tier = 'write') => ({ pre_lift_approval: risk_tier === 'destructive' ? 'always' : 'ask' });

const packAction = (op_args: Record<string, unknown>, risk_tier = 'write', over: Record<string, unknown> = {}): Checkpoint => ({
  checkpoint_id: 'cp2', run_id: 'run2', step_state: {}, created_at: 1,
  preflight_context: { tool_slug: 'deal.update', risk_tier, authorization_provenance: asked(risk_tier) },
  ...over,
  raw_op: {
    catalog_slug: 'recued-core/hubspot', operation: 'deal.update', op_id: 'hubspot.deal.update', op_args, risk_tier,
    connection_name: 'hubspot', execution_source: { channel: 'chat', actor: 'user_self', chat_session_id: 's', user_id: 'owner' },
  },
}) as unknown as Checkpoint;

const recipeStep = (input: Record<string, unknown>, over: Record<string, unknown> = {}): Checkpoint => ({
  checkpoint_id: 'cp3', run_id: 'run3', recipe_id: 'send-composed-mail', recipe_source_hash: 'h1', gated_step_id: 'send',
  step_state: { send: { input } }, created_at: 1,
  approved_target: { ingredient_slug: 'mail-send' },
  preflight_context: { tool_slug: 'mail-send', risk_tier: 'write', authorization_provenance: asked() },
  ...over,
}) as unknown as Checkpoint;

describe('D-348 — a chat write (Q3)', () => {
  it('a create that stays in Recued pins nothing: a task, a note, a schedule, a contact added', () => {
    expect(chainCallSignatureOf(chatWrite('work.create', { kind: 'task', title: 'Call Ann', assignee_id: 'u_7' })))
      .toEqual({ op: 'tier1:work.create:task', pins: {} });
    expect(chainCallSignatureOf(chatWrite('memory.write', { summary: 'Ann prefers mornings' })))
      .toEqual({ op: 'tier1:memory.write', pins: {} });
    expect(chainCallSignatureOf(chatWrite('recipe.schedule', { recipe_id: 'weekly-report', cron: '0 9 * * 1' })))
      .toEqual({ op: 'tier1:recipe.schedule:weekly-report', pins: {} });
    expect(chainCallSignatureOf(chatWrite('contact.write', { name: 'Ann', email: 'ann@example.com' })))
      .toEqual({ op: 'tier1:contact.write:add', pins: {} });
  });

  it('a change to what exists pins it', () => {
    expect(chainCallSignatureOf(chatWrite('contact.write', { target_id: 'contact_42', email: 'Ann@Example.com' })))
      .toEqual({ op: 'tier1:contact.write:change', pins: { email: ['ann@example.com'], target_id: ['contact_42'] } });
    expect(chainCallSignatureOf(chatWrite('work.update', { kind: 'task', id: 'task_9', status: 'done' })))
      .toEqual({ op: 'tier1:work.update:task', pins: { id: ['task_9'] } });
  });

  it('an event on Recued\'s calendar pins only whom its invitation reaches', () => {
    expect(chainCallSignatureOf(chatWrite('calendar.create', { title: 'Rehearsal', start: '2026-11-12T10:00:00Z' })))
      .toEqual({ op: 'tier1:calendar.create:local', pins: {} });
    expect(chainCallSignatureOf(chatWrite('calendar.create', {
      title: 'Rehearsal', attendees: [{ email: 'Ben@Example.com', name: 'Ben' }, { email: 'ann@example.com' }],
    }))).toEqual({ op: 'tier1:calendar.create:local', pins: { 'attendees.email': ['ann@example.com', 'ben@example.com'] } });
    // On another calendar the event leaves Recued, and its calendar is pinned too.
    expect(chainCallSignatureOf(chatWrite('calendar.create', { calendar_id: 'cal_work', title: 'Rehearsal' })))
      .toEqual({ op: 'tier1:calendar.create:cal_work', pins: { calendar_id: ['cal_work'] } });
  });
});

describe('D-348 — a pack action and a recipe\'s held step (Q3, Q7)', () => {
  it('a pack action is its catalog, operation and connection, and pins the record, a number id too', () => {
    expect(chainCallSignatureOf(packAction({ deal_id: 9001, stage: 'won' }))).toEqual({
      op: 'op:recued-core/hubspot|deal.update|hubspot', pins: { deal_id: ['9001'] },
    });
  });

  it('a delete pins nothing and says it is one: its record is checked when it runs (slice 6)', () => {
    // Its operation declares the record it deletes, so the gate can check it against what was found.
    const declared = { deleteRecordArg: (slug: string, operation: string) =>
      (slug === 'recued-core/hubspot' && operation === 'deal.update') || operation === 'pub/hubspot-catalog.deal.delete'
        ? 'deal_id' : undefined };
    expect(chainCallSignatureOf(packAction({ deal_id: 9001 }, 'destructive'), declared)).toEqual({
      op: 'op:recued-core/hubspot|deal.update|hubspot', pins: {}, delete: true,
    });
    // A recipe's pack delete, as the catalog gate's hold names it: by its qualified id.
    expect(chainCallSignatureOf(recipeStep({ deal_id: '9001' }, {
      preflight_context: { tool_slug: 'hubspot-catalog', risk_tier: 'destructive', authorization_provenance: asked('destructive') },
      approved_target: { ingredient_slug: 'hubspot-catalog', operation_id: 'pub/hubspot-catalog.deal.delete', connection_name: 'hubspot' },
    }), declared)).toEqual({ op: 'step:send-composed-mail@h1|hubspot-catalog|pub/hubspot-catalog.deal.delete|hubspot', pins: {}, delete: true });
  });

  it('⛔ a delete the gate cannot check is on no chain: a pack\'s declaring no record, or one of Recued\'s own off its list', () => {
    expect(chainCallSignatureOf(packAction({ deal_id: 9001 }, 'destructive'), { deleteRecordArg: () => undefined }))
      .toBeUndefined();
    expect(chainCallSignatureOf(packAction({ deal_id: 9001 }, 'destructive'))).toBeUndefined();
    // Recued's own is held at the commit gateway, which names no operation: its closed list decides.
    const own = (slug: string, input: Record<string, unknown>) => recipeStep(input, {
      preflight_context: { tool_slug: slug, risk_tier: 'destructive', authorization_provenance: asked('destructive') },
      approved_target: { ingredient_slug: slug },
    });
    expect(chainCallSignatureOf(own('shared-delete-prefix', { prefix: 'seen.' }))).toBeUndefined();
    expect(chainCallSignatureOf(own('file-move', { from_slug: 'a', from_path: 'x', to_slug: 'b', to_path: 'y' }))).toBeUndefined();
    expect(chainCallSignatureOf(own('calendar-delete', { slug: 'home', source_id: 'e_1', scope: 'series' }))).toBeUndefined();
    // Slice 6b — one on the list is named, as a delete: its record is checked when it runs.
    expect(chainCallSignatureOf(own('file-delete', { slug: 'notes', path: 'a.md' }))).toEqual({
      op: 'step:send-composed-mail@h1|file-delete||', pins: {}, delete: true,
    });
    expect(chainCallSignatureOf(own('task-delete', { id: 't_1' }))).toMatchObject({ delete: true });
  });

  it('slice 6b — a held loop of deletes is one call, however many items it covers; any other loop is not', () => {
    const loop = { foreach_progress: { source_length: 4, next_index: 1 } };
    // A held loop's step keeps no state: its calls are on its cover, as its approval lists them.
    const deletes = (calendar: string, items: ReadonlyArray<Record<string, unknown>>) => recipeStep({}, {
      ...loop,
      preflight_context: {
        tool_slug: calendar, risk_tier: 'destructive', authorization_provenance: asked('destructive'),
        foreach_cover: { total: items.length, items: items.map((args) => ({ summary: 'x', args_preview: args })) },
      },
      approved_target: { ingredient_slug: calendar },
    });
    expect(chainCallSignatureOf(deletes('task-delete', [{ id: 't_1' }, { id: 't_2' }, { id: 't_3' }])))
      .toEqual({ op: 'step:send-composed-mail@h1|task-delete||', pins: {}, delete: true });
    // Every listed call must name its one record: one series, or a cover that lists none, and it is not.
    expect(chainCallSignatureOf(deletes('calendar-delete', [
      { slug: 'home', source_id: 'e_1' }, { slug: 'home', source_id: 'e_2', scope: 'series' },
    ]))).toBeUndefined();
    expect(chainCallSignatureOf(deletes('task-delete', []))).toBeUndefined();
    expect(chainCallSignatureOf(recipeStep({ to: ['ann@example.com'] }, loop))).toBeUndefined();
  });

  it('a recipe\'s held step is the recipe, its version and its call, and pins whom it reaches', () => {
    expect(chainCallSignatureOf(recipeStep({
      to: ['Ben@Example.com', 'ann@example.com'], subject: 'The new time', thread_id: 'th_12', body: 'see you at 10',
    }))).toEqual({
      op: 'step:send-composed-mail@h1|mail-send||',
      pins: { thread_id: ['th_12'], to: ['ann@example.com', 'ben@example.com'] },
    });
    // What the owner changed before approving is what ran, so it is what the call was.
    expect(chainCallSignatureOf(recipeStep({ to: ['ann@example.com'] }, { arg_overrides: { to: ['cara@example.com'] } }))!.pins)
      .toEqual({ to: ['cara@example.com'] });
  });

  it('⛔ a hold it cannot name has no signature, never a looser one', () => {
    // A held foreach whose one approval covers the rest of its items.
    expect(chainCallSignatureOf(recipeStep({ to: ['ann@example.com'] }, {
      foreach_progress: { source_length: 4, next_index: 1 },
    }))).toBeUndefined();
    expect(chainCallSignatureOf(recipeStep({}, { recipe_id: undefined }))).toBeUndefined();
  });
});

describe('D-348 §5.1 — off every chain: a hold the gates never let a chain stand in for', () => {
  const because = (provenance: Record<string, unknown> | undefined) =>
    ({ preflight_context: { tool_slug: 'mail-send', risk_tier: 'write', ...(provenance ? { authorization_provenance: provenance } : {}) } });

  it('an action set to "always ask" has no signature, as a pack action or a recipe\'s step', () => {
    expect(chainCallSignatureOf(packAction({ deal_id: 9001 }, 'write', {
      preflight_context: { tool_slug: 'deal.update', risk_tier: 'write', authorization_provenance: { pre_lift_approval: 'always' } },
    }))).toBeUndefined();
    expect(chainCallSignatureOf(recipeStep({ to: ['ann@example.com'] }, because({ pre_lift_approval: 'always' })))).toBeUndefined();
    // The control: set to ask, or to never and raised by the floor, the same call is named.
    expect(chainCallSignatureOf(recipeStep({ to: ['ann@example.com'] }, because({ pre_lift_approval: 'never' })))).toBeDefined();
  });

  it('nor a review given each time, nor any other review the gate adds', () => {
    for (const lift_reason of ['review_commitment', 'review_quote_signoff', 'review_approval_workflow', 'review_customer_payment', 'quality']) {
      expect(chainCallSignatureOf(recipeStep({ to: ['ann@example.com'] }, because({ pre_lift_approval: 'ask', lift_reason }))))
        .toBeUndefined();
    }
  });

  it('nor a browser batch that puts one of the owner\'s files into a page', () => {
    const act = (steps: Array<Record<string, unknown>>) => recipeStep({ target: '*://example.test/*', page: '7:ABCDEF0123', steps }, {
      approved_target: { ingredient_slug: 'core-dom-act' },
      preflight_context: { tool_slug: 'core-dom-act', risk_tier: 'write', authorization_provenance: asked() },
    });
    expect(chainCallSignatureOf(act([{ do: 'upload', ref: 'e7', file: `file:${'b'.repeat(32)}` }]))).toBeUndefined();
    expect(chainCallSignatureOf(act([{ do: 'click', ref: 'e12' }]))).toBeDefined();
  });

  it('nor a hold that does not say why it asked', () => {
    expect(chainCallSignatureOf(recipeStep({ to: ['ann@example.com'] }, because(undefined)))).toBeUndefined();
  });

  it('a delete\'s "always" is its tier\'s, not a setting: it is named, and learned on its own (Q7)', () => {
    expect(chainCallSignatureOf(packAction({ deal_id: 9001 }, 'destructive'), { deleteRecordArg: () => 'deal_id' }))
      .toMatchObject({ delete: true });
  });
});

describe('D-348 — the pins', () => {
  it('reads every identifying field and every address, at any depth, sorted, once each', () => {
    expect(chainCallPins({
      to: ['b@x.io', 'A@X.io', 'b@x.io'], cc: [], note: 'write to c@x.io', owner: { contact_id: 'c_1' }, count: 3,
    })).toEqual({ 'owner.contact_id': ['c_1'], to: ['a@x.io', 'b@x.io'] });
  });
});

describe('D-348 slice 4 — a chat write\'s signature at its gate', () => {
  it('is its hold\'s, read from the call', () => {
    expect(chainTier1Signature('work.create', { kind: 'task', title: 'x' })).toEqual({ op: 'tier1:work.create:task', pins: {} });
    expect(chainTier1Signature('contact.write', { target_id: 'c_1' })).toEqual(
      chainCallSignatureOf(chatWrite('contact.write', { target_id: 'c_1' })));
  });

  it('⛔ a save the owner is asked about every time has none, so no chain ever holds it', () => {
    expect(chainTier1Signature('memory.write', { summary: 'Mia lives in Cork', despite_revoked: 'mem-1' })).toBeUndefined();
    expect(chainCallSignatureOf(chatWrite('memory.write', { summary: 'x', despite_revoked: 'mem-1' }))).toBeUndefined();
    expect(chainTier1Signature('no.such.tool', {})).toBeUndefined();
  });
});
