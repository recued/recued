/** D-341 slice B1 — a trigger's standing pre-approval: who it names, read off the run's own
 *  source; what it covers; a grant's bounds; and its words. Ruling 10 (2026-11-08): it has no end
 *  date and no use cap, and lasts until the owner ends it. Ruling 8: a recipe that asks an AI may
 *  carry one, and its words say so. */

import { describe, expect, it } from 'vitest';

import { isCommit, isExecutionSource, type ExecutionSource } from '../commits.js';
import { admitByOpRisk, opAlwaysReviewed, reviewedEachTime } from '../op-risk-admission.js';
import {
  describeTriggerPreapproval,
  describeTriggerPreapprovalOffer,
  describeTriggerPreapprovalTier1Op,
  readTriggerPreapprovalTier1Op,
  scheduledPromptRunOf,
  triggerPreapprovalTier1Op,
  normalizeTriggerPreapprovalGrant,
  readTriggerPreapprovalOffer,
  readTriggerPreapprovalTrigger,
  TRIGGER_PREAPPROVAL_OPTION_ID,
  triggerPreapprovalOption,
  triggeredRunOf,
  triggerPreapprovalCovers,
  triggerPreapprovalState,
  triggerPreapprovalTerms,
  TRIGGER_PREAPPROVAL_ASK_GRANT,
  type TriggerPreapprovalRow,
} from '../trigger-preapproval.js';

const row = (overrides: Partial<TriggerPreapprovalRow> = {}): TriggerPreapprovalRow => ({
  id: 'tpa_1',
  trigger: { kind: 'webhook', ingress_id: 'whi_1' },
  door_contract_id: 'door-1',
  recipe_id: 'receive-body-metrics-apple-health',
  recipe_sha256: 'a'.repeat(64),
  writes: ['recued-core.body-signals.daily_metric.batch'],
  max_per_run: 1,
  uses: 0,
  created_at: 0,
  ...overrides,
});

const call = {
  trigger: { kind: 'webhook', ingress_id: 'whi_1' } as const,
  door_contract_id: 'door-1',
  recipe_id: 'receive-body-metrics-apple-health',
  recipe_sha256: 'a'.repeat(64),
  op: 'recued-core.body-signals.daily_metric.batch',
};

describe('D-341 slice B1 — the trigger a run names', () => {
  it('a webhook run names its ingress and door', () => {
    expect(triggeredRunOf({
      channel: 'webhook', actor: 'anonymous', vendor: 'generic', webhook_secret_id: 'whi_1', contract_id: 'door-1',
    })).toEqual({ trigger: { kind: 'webhook', ingress_id: 'whi_1' }, door_contract_id: 'door-1' });
    // A door-less webhook run (its door was never minted) names no door, so it matches nothing.
    expect(triggeredRunOf({ channel: 'webhook', actor: 'anonymous', vendor: 'generic', webhook_secret_id: 'whi_1' }))
      .toEqual({ trigger: { kind: 'webhook', ingress_id: 'whi_1' } });
  });

  it('a schedule\'s run names the schedule, an event trigger\'s run the trigger, both for the owner only', () => {
    expect(triggeredRunOf({ channel: 'schedule', actor: 'system', schedule_id: 'sch_1' } as ExecutionSource))
      .toEqual({ trigger: { kind: 'schedule', schedule_id: 'sch_1' } });
    expect(triggeredRunOf({ channel: 'schedule', actor: 'system', schedule_id: 'sch_1', contract_id: 'user_self' } as ExecutionSource))
      .toEqual({ trigger: { kind: 'schedule', schedule_id: 'sch_1' } });
    expect(triggeredRunOf({
      channel: 'reactive', actor: 'system', event_kind: 'mail_fact.parcel', source_recipe: 'r', trigger_id: 'trg_1',
    } as ExecutionSource)).toEqual({ trigger: { kind: 'event_trigger', trigger_id: 'trg_1' } });
    for (const source of [
      { channel: 'schedule', actor: 'system', schedule_id: 'sch_1', contract_id: 'ct_partner' },
      { channel: 'reactive', actor: 'system', event_kind: 'x', source_recipe: 'r', trigger_id: 'trg_1', contract_id: 'ct_partner' },
    ]) expect(triggeredRunOf(source as ExecutionSource), JSON.stringify(source)).toBeUndefined();
  });

  it('names none for a prompt schedule, a reactive run no trigger started, or any other source', () => {
    for (const source of [
      { channel: 'schedule', actor: 'system', schedule_id: 'sch_1', prompt_schedule: { prompt_id: 'p' } },
      { channel: 'schedule', actor: 'system' },
      { channel: 'reactive', actor: 'system', event_kind: 'x', source_recipe: 'r' },
      { channel: 'chat', actor: 'user_self', chat_session_id: 's', user_id: 'u' },
      { channel: 'webhook', actor: 'anonymous', vendor: 'generic', webhook_secret_id: '' },
    ]) expect(triggeredRunOf(source as ExecutionSource), JSON.stringify(source)).toBeUndefined();
    expect(triggeredRunOf(undefined)).toBeUndefined();
  });

  it('an event trigger\'s id is a valid reactive source field; a non-string one is not', () => {
    const base = { channel: 'reactive', actor: 'system', event_kind: 'x', source_recipe: 'r' };
    expect(isExecutionSource({ ...base, trigger_id: 'trg_1' })).toBe(true);
    expect(isExecutionSource({ ...base, trigger_id: 7 })).toBe(false);
    expect(isExecutionSource({ ...base, dish_id: 'dsh_1' })).toBe(true);
    expect(isExecutionSource({ ...base, dish_id: 7 })).toBe(false);
  });
});

describe('D-341 slice B1b — an armed auto-run names its timer by its dish', () => {
  const tick = { channel: 'reactive', actor: 'system', event_kind: 'auto_run_tick', source_recipe: 'r' };

  it('a timer\'s own tick names its auto-run, for the owner only', () => {
    expect(triggeredRunOf({ ...tick, dish_id: 'dsh_1' } as ExecutionSource)).toEqual({ trigger: { kind: 'auto_run', dish_id: 'dsh_1' } });
    expect(triggeredRunOf({ ...tick, dish_id: 'dsh_1', contract_id: 'user_self' } as ExecutionSource))
      .toEqual({ trigger: { kind: 'auto_run', dish_id: 'dsh_1' } });
    for (const source of [
      // Another contract's tick, a tick with no dish, a dish on another reactive run.
      { ...tick, dish_id: 'dsh_1', contract_id: 'ct_partner' },
      { ...tick },
      { ...tick, dish_id: '' },
      { channel: 'reactive', actor: 'system', event_kind: 'mail_fact.parcel', source_recipe: 'r', dish_id: 'dsh_1' },
    ]) expect(triggeredRunOf(source as ExecutionSource), JSON.stringify(source)).toBeUndefined();
    // An event trigger's run that carried a dish is still its trigger's.
    expect(triggeredRunOf({ ...tick, event_kind: 'x', trigger_id: 'trg_1', dish_id: 'dsh_1' } as ExecutionSource))
      .toEqual({ trigger: { kind: 'event_trigger', trigger_id: 'trg_1' } });
  });

  it('a grant, a page and an offer name it by its dish; its words say it runs on its own', () => {
    const trigger = { kind: 'auto_run', dish_id: 'dsh_1' } as const;
    expect(readTriggerPreapprovalTrigger(trigger)).toEqual(trigger);
    expect(readTriggerPreapprovalTrigger({ kind: 'auto_run', schedule_id: 'dsh_1' })).toBeUndefined();
    expect(normalizeTriggerPreapprovalGrant({ trigger, recipe_id: 'r', writes: ['a.b'] }))
      .toEqual({ trigger, recipe_id: 'r', writes: ['a.b'], max_per_run: 1 });
    expect(readTriggerPreapprovalOffer({ trigger, recipe_id: 'r', recipe_sha256: 'a'.repeat(64), op: 'a.b' }))
      .toEqual({ trigger, recipe_id: 'r', recipe_sha256: 'a'.repeat(64), op: 'a.b' });
    expect(triggerPreapprovalOption('auto_run').label).toBe('Always allow for this auto-run');
    expect(describeTriggerPreapproval(row({ trigger, door_contract_id: undefined }), 'Watch pipeline', ['Add a task']))
      .toBe('Watch pipeline, when it runs on its own, may do this without asking: add a task. Once a run, until you end it.');
    expect(describeTriggerPreapprovalOffer({ trigger, recipe_id: 'r', recipe_sha256: 'a'.repeat(64), op: 'a.b' }, '"Watch pipeline"'))
      .toBe('“Always allow for this auto-run” stops asking about this write when "Watch pipeline" runs on its own, once a'
        + ' run, until you end it on the auto-run\'s page or under Contracts. A change to the recipe asks you again.');
    expect(triggerPreapprovalCovers(row({ trigger, door_contract_id: undefined }),
      { ...call, trigger, door_contract_id: undefined })).toBe(true);
    // Another dish's timer is another trigger.
    expect(triggerPreapprovalCovers(row({ trigger, door_contract_id: undefined }),
      { ...call, trigger: { kind: 'auto_run', dish_id: 'dsh_2' }, door_contract_id: undefined })).toBe(false);
  });
});

describe('D-341 slice B4 — a reception form names its endpoint and its door', () => {
  // A reception endpoint's id is base64url: it may start with `-` or `_`.
  const form = { channel: 'reception', actor: 'anonymous', reception_id: '-Xy_9', contract_id: 'door-r1' };
  const trigger = { kind: 'reception', endpoint_id: '-Xy_9' } as const;

  it('a submission names its form and the door it ran through; a contracted visitor\'s names none', () => {
    expect(isExecutionSource(form)).toBe(true);
    expect(triggeredRunOf(form as ExecutionSource)).toEqual({ trigger, door_contract_id: 'door-r1' });
    expect(triggeredRunOf({ ...form, reception_id: '_abc' } as ExecutionSource))
      .toEqual({ trigger: { kind: 'reception', endpoint_id: '_abc' }, door_contract_id: 'door-r1' });
    // A door-less submission names no door, so it matches nothing.
    const { contract_id: _door, ...doorless } = form;
    expect(triggeredRunOf(doorless as ExecutionSource)).toEqual({ trigger });
    for (const source of [
      { ...form, actor: 'contracted_user' },
      { ...form, reception_id: '' },
      { ...form, reception_id: '.x' },
    ]) expect(triggeredRunOf(source as ExecutionSource), JSON.stringify(source)).toBeUndefined();
  });

  it('a grant, a page and an offer name it by its endpoint; an offer without its door is no offer', () => {
    expect(readTriggerPreapprovalTrigger(trigger)).toEqual(trigger);
    expect(readTriggerPreapprovalTrigger({ kind: 'reception', ingress_id: '-Xy_9' })).toBeUndefined();
    expect(normalizeTriggerPreapprovalGrant({ trigger, recipe_id: 'r', writes: ['a.b'] }))
      .toEqual({ trigger, recipe_id: 'r', writes: ['a.b'], max_per_run: 1 });
    const offer = { trigger, door_contract_id: 'door-r1', recipe_id: 'r', recipe_sha256: 'a'.repeat(64), op: 'a.b' };
    expect(readTriggerPreapprovalOffer(JSON.parse(JSON.stringify(offer)))).toEqual(offer);
    expect(readTriggerPreapprovalOffer({ ...offer, door_contract_id: undefined })).toBeUndefined();
  });

  it('covers its form\'s runs through the same door only', () => {
    const formRow = row({ trigger, door_contract_id: 'door-r1' });
    const formCall = { ...call, trigger, door_contract_id: 'door-r1' };
    expect(triggerPreapprovalCovers(formRow, formCall)).toBe(true);
    for (const [name, rowOverrides, callOverrides] of [
      ['a door minted since', {}, { door_contract_id: 'door-r2' }],
      ['a door-less run', {}, { door_contract_id: undefined }],
      ['a row with no door', { door_contract_id: undefined }, {}],
      ['another form', {}, { trigger: { kind: 'reception', endpoint_id: 'Xy_9' } }],
      ['a webhook of the same id', {}, { trigger: { kind: 'webhook', ingress_id: '-Xy_9' } }],
    ] as Array<[string, Partial<TriggerPreapprovalRow>, Partial<typeof formCall>]>) {
      expect(triggerPreapprovalCovers({ ...formRow, ...rowOverrides }, { ...formCall, ...callOverrides } as never), name)
        .toBe(false);
    }
  });

  it('its words name the form', () => {
    expect(triggerPreapprovalOption('reception').label).toBe('Always allow for this form');
    expect(describeTriggerPreapproval(row({ trigger }), 'Book a table', ['Save a booking'], ['triage']))
      .toBe('Book a table, when its form runs it, may do this without asking: save a booking. Its AI decides what it'
        + ' writes. Once a run, until you end it.');
    expect(describeTriggerPreapprovalOffer({ trigger, door_contract_id: 'door-r1', recipe_id: 'r', recipe_sha256: 'a'.repeat(64),
      op: 'a.b' }, '"Book a table"')).toBe('“Always allow for this form” stops asking about this write when its form runs'
      + ' "Book a table", once a run, until you end it on the form\'s page or under Contracts. A change to the recipe asks'
      + ' you again.');
  });
});

describe('D-341 slice B1 — what one covers', () => {
  it('covers the named write for the same trigger, door and recipe version while live', () => {
    expect(triggerPreapprovalCovers(row(), call)).toBe(true);
    // However many times it has been used: it has no use cap.
    expect(triggerPreapprovalCovers(row({ uses: 10_000 }), call)).toBe(true);
  });

  it('covers nothing else', () => {
    const misses: Array<[string, Partial<TriggerPreapprovalRow>, Partial<typeof call>]> = [
      ['another op', {}, { op: 'recued-core.body-signals.daily_metric.delete' }],
      ['another version', {}, { recipe_sha256: 'b'.repeat(64) }],
      ['another recipe', {}, { recipe_id: 'other' }],
      ['another webhook', {}, { trigger: { kind: 'webhook', ingress_id: 'whi_2' } as never }],
      ['a door minted since', {}, { door_contract_id: 'door-2' }],
      ['a door-less run', {}, { door_contract_id: undefined }],
      ['a row with no door', { door_contract_id: undefined }, { door_contract_id: undefined }],
      ['a schedule of the same id', {}, { trigger: { kind: 'schedule', schedule_id: 'whi_1' } as never }],
      ['revoked', { revoked_at: 1 }, {}],
    ];
    for (const [name, rowOverrides, callOverrides] of misses) {
      expect(triggerPreapprovalCovers(row(rowOverrides), { ...call, ...callOverrides }), name).toBe(false);
    }
  });

  it('a schedule\'s or an event trigger\'s needs no door', () => {
    const trigger = { kind: 'schedule', schedule_id: 'sch_1' } as const;
    expect(triggerPreapprovalCovers(row({ trigger, door_contract_id: undefined }),
      { ...call, trigger, door_contract_id: undefined })).toBe(true);
  });

  it('its state says why it covers nothing: ended by the owner first, then a changed recipe', () => {
    expect(triggerPreapprovalState(row(), 'a'.repeat(64))).toBe('live');
    expect(triggerPreapprovalState(row(), 'b'.repeat(64))).toBe('outdated');
    expect(triggerPreapprovalState(row({ uses: 10_000 }), 'a'.repeat(64))).toBe('live');
    expect(triggerPreapprovalState(row({ revoked_at: 1 }), 'b'.repeat(64))).toBe('revoked');
  });
});

describe('D-341 slice B1 — a grant\'s shape and bounds', () => {
  const grant = {
    trigger: { kind: 'webhook', ingress_id: 'whi_1' },
    recipe_id: 'receive-body-metrics-apple-health',
    writes: ['recued-core.body-signals.daily_metric.batch'],
  };

  it('fills in once a run, and nothing else: it lasts until the owner ends it', () => {
    expect(normalizeTriggerPreapprovalGrant(grant)).toEqual({ ...grant, max_per_run: 1 });
    expect(TRIGGER_PREAPPROVAL_ASK_GRANT).toEqual({ max_per_run: 1 });
  });

  it('keeps the times a run the owner chose, up to 100, and drops a repeated write', () => {
    expect(normalizeTriggerPreapprovalGrant({ ...grant, max_per_run: 100 })).toEqual({ ...grant, max_per_run: 100 });
    expect(normalizeTriggerPreapprovalGrant({ ...grant, writes: [grant.writes[0], grant.writes[0]], max_per_run: 3 }))
      .toEqual({ ...grant, max_per_run: 3 });
  });

  it('refuses a use cap or an end date rather than ignore one, a wider cap a run, a missing trigger, recipe or write, and an unknown kind', () => {
    const bad: Array<[unknown, RegExp]> = [
      [{ ...grant, max_uses: 30 }, /no use cap or end date: it lasts until you end it/u],
      [{ ...grant, ttl_ms: 86_400_000 }, /no use cap or end date: it lasts until you end it/u],
      [{ ...grant, max_per_run: 101 }, /max_per_run can be at most 100/u],
      [{ ...grant, max_per_run: 0 }, /max_per_run must be a whole number/u],
      [{ ...grant, max_per_run: 1.5 }, /max_per_run must be a whole number/u],
      [{ ...grant, writes: [] }, /writes must name at least one op/u],
      [{ ...grant, writes: ['ok', 7] }, /each write must be an op id/u],
      [{ ...grant, writes: Array.from({ length: 21 }, (_, i) => `op.${String(i)}`) }, /at most 20 ops/u],
      [{ ...grant, recipe_id: '' }, /recipe_id is required/u],
      [{ ...grant, trigger: { kind: 'webhook' } }, /trigger.ingress_id is required/u],
      [{ ...grant, trigger: { kind: 'schedule', ingress_id: 'whi_1' } }, /trigger.schedule_id is required/u],
      [{ ...grant, trigger: { kind: 'reception_form', door: 'x' } }, /trigger.kind must be one of/u],
      [null, /must be an object/u],
    ];
    for (const [input, message] of bad) {
      expect(() => normalizeTriggerPreapprovalGrant(input), JSON.stringify(input)).toThrow(message);
    }
  });
});

describe('D-341 slice B1 — its words and its commit', () => {
  it('says which trigger, which writes in the owner\'s words, and that it lasts until the owner ends it', () => {
    expect(describeTriggerPreapproval(row({ uses: 2 }), 'Receive Apple Health readings',
      ['Save up to 100 daily readings in one transaction, all or none'])).toBe(
      'Receive Apple Health readings, when its webhook runs it, may do this without asking: save up to 100 daily'
      + ' readings in one transaction, all or none. Once a run, until you end it.');
    // With no labels, the op ids, left as they are; several writes, each named; a recipe that asks an AI says so.
    expect(describeTriggerPreapproval(row({ trigger: { kind: 'schedule', schedule_id: 's' }, writes: ['a.b', 'c.d'],
      max_per_run: 5 }), 'R', undefined, ['summarize']))
      .toBe('R, when its schedule runs it, may do these without asking: a.b; c.d. Its AI decides what it writes.'
        + ' Up to 5 times a run, until you end it.');
  });

  it('its terms, where the owner sees one: how often a run, how often used, and that it lasts', () => {
    expect(triggerPreapprovalTerms({ max_per_run: 1, uses: 0 })).toBe('Once a run · not used yet · until you end it');
    expect(triggerPreapprovalTerms({ max_per_run: 1, uses: 1 })).toBe('Once a run · used once · until you end it');
    expect(triggerPreapprovalTerms({ max_per_run: 3, uses: 41 })).toBe('Up to 3 times a run · used 41 times · until you end it');
  });

  it('a commit may name the pre-approval that let it through, by a non-empty id', () => {
    // The D-145 slice 3b.0 fixture's shape: a valid commit, so only the field under test differs.
    const commit = {
      commit_id: 'commit-1', kind: 'query', ingredient: 'calendar', tool: 'list', args: {}, status: 'pending',
      source: { channel: 'user', actor: 'user_self', user_id: 'user-1', client_token_id: 'client-token-1' },
      channel_session_id: 'user:user-1', correlation_id: 'corr-1', request_id: 'request-1', dispatch_depth: 0,
      idempotency_key: 'idem-1', dispatched_at: 1_700_000_000_000,
    };
    expect(isCommit(commit)).toBe(true);
    expect(isCommit({ ...commit, trigger_preapproval: { id: 'tpa_1' } })).toBe(true);
    for (const bad of [{ id: '' }, {}, 'tpa_1', null, ['tpa_1']]) {
      expect(isCommit({ ...commit, trigger_preapproval: bad }), JSON.stringify(bad)).toBe(false);
    }
  });
});

describe('D-341 slice B2 — what an ask offers to grant', () => {
  const offer = {
    trigger: { kind: 'webhook', ingress_id: 'whi_1' }, door_contract_id: 'door-1',
    recipe_id: 'receive-body-metrics-apple-health', recipe_sha256: 'a'.repeat(64), op: 'recued-core.body-signals.daily_metric.batch',
  };

  it('reads back an offer the checkpoint kept, and only a whole one', () => {
    expect(readTriggerPreapprovalOffer(JSON.parse(JSON.stringify(offer)))).toEqual(offer);
    // A recipe that asks an AI is marked so; only `true` marks it.
    expect(readTriggerPreapprovalOffer({ ...offer, asks_ai: true })).toEqual({ ...offer, asks_ai: true });
    expect(readTriggerPreapprovalOffer({ ...offer, asks_ai: 'yes' })).not.toHaveProperty('asks_ai');
    // A schedule's or an event trigger's has no door; one it carried anyway is dropped.
    expect(readTriggerPreapprovalOffer({ ...offer, trigger: { kind: 'schedule', schedule_id: 'sch_1' } }))
      .toEqual({ ...offer, trigger: { kind: 'schedule', schedule_id: 'sch_1' }, door_contract_id: undefined });
    expect(readTriggerPreapprovalOffer({ ...offer, trigger: { kind: 'schedule', schedule_id: 'sch_1' } }))
      .not.toHaveProperty('door_contract_id');
    for (const bad of [
      { ...offer, door_contract_id: undefined },
      { ...offer, recipe_sha256: 'not-a-hash' },
      { ...offer, op: '' },
      { ...offer, recipe_id: undefined },
      { ...offer, trigger: { kind: 'reception_form', door: 'x' } },
      { ...offer, trigger: { kind: 'webhook' } },
      null, 'offer', [offer],
    ]) expect(readTriggerPreapprovalOffer(bad), JSON.stringify(bad)).toBeUndefined();
  });

  it('offers it as "Always allow for this …", its id fitting a Telegram button', () => {
    expect(triggerPreapprovalOption('webhook')).toEqual({ id: 'allow_trigger', label: 'Always allow for this webhook' });
    expect(triggerPreapprovalOption('schedule').label).toBe('Always allow for this schedule');
    expect(triggerPreapprovalOption('event_trigger').label).toBe('Always allow for this trigger');
    expect(new TextEncoder().encode(TRIGGER_PREAPPROVAL_OPTION_ID).length).toBeLessThanOrEqual(23);
  });

  it('says what the answer lets happen, that it lasts until the owner ends it and where, and when its AI decides', () => {
    expect(describeTriggerPreapprovalOffer(offer as never, '"Receive Apple Health readings"')).toBe(
      '“Always allow for this webhook” stops asking about this write when its webhook runs "Receive Apple Health'
      + ' readings", once a run, until you end it on the webhook\'s page or under Contracts. A change to the recipe'
      + ' asks you again.');
    expect(describeTriggerPreapprovalOffer({ ...offer, trigger: { kind: 'event_trigger', trigger_id: 't' }, asks_ai: true } as never,
      '"Sort new mail"')).toBe('“Always allow for this trigger” stops asking about this write when its trigger runs'
      + ' "Sort new mail", once a run, until you end it on the trigger\'s page or under Contracts. Its AI decides what it'
      + ' writes. A change to the recipe asks you again.');
  });
});

describe('D-341 slice B2b — the trigger a page names', () => {
  it('reads each kind by its own id, and nothing else', () => {
    expect(readTriggerPreapprovalTrigger({ kind: 'webhook', ingress_id: 'whi_1' })).toEqual({ kind: 'webhook', ingress_id: 'whi_1' });
    expect(readTriggerPreapprovalTrigger({ kind: 'schedule', schedule_id: 'sch_1' })).toEqual({ kind: 'schedule', schedule_id: 'sch_1' });
    expect(readTriggerPreapprovalTrigger({ kind: 'event_trigger', trigger_id: 'trg_1' }))
      .toEqual({ kind: 'event_trigger', trigger_id: 'trg_1' });
    // Another kind's id field is not this kind's: a webhook named by a schedule's id names nothing.
    expect(readTriggerPreapprovalTrigger({ kind: 'webhook', schedule_id: 'sch_1' })).toBeUndefined();
    // Only the fields it names are kept.
    expect(readTriggerPreapprovalTrigger({ kind: 'schedule', schedule_id: 'sch_1', recipe_id: 'x' }))
      .toEqual({ kind: 'schedule', schedule_id: 'sch_1' });
    for (const bad of [
      { kind: 'reception_form', door: 'x' }, { kind: 'schedule' }, { kind: 'schedule', schedule_id: '' },
      { kind: 'schedule', schedule_id: '   ' }, { kind: 'event_trigger', trigger_id: 7 }, null, 'schedule', [],
    ]) expect(readTriggerPreapprovalTrigger(bad), JSON.stringify(bad)).toBeUndefined();
  });
});

describe('D-341 slice B3 — a scheduled prompt names its schedule and the version of its prompt', () => {
  const V1 = 'c'.repeat(64);
  const source = (over: Record<string, unknown> = {}) => ({
    channel: 'schedule', actor: 'system', schedule_id: 'ps_1', cron: '0 7 * * *', chat_session_id: 'scheduled-1', turn_id: 'turn-1',
    prompt_schedule: { schedule_id: 'ps_1', occurrence_id: 'ps_1:3:1700', revision: 3, due_at: 1700, cron: '0 7 * * *', prompt_sha256: V1, ...over },
  });

  it('its run names the schedule, the version of the text it runs and its occurrence; nothing else does', () => {
    expect(isExecutionSource(source())).toBe(true);
    expect(scheduledPromptRunOf(source() as ExecutionSource)).toEqual({
      trigger: { kind: 'prompt_schedule', schedule_id: 'ps_1' }, prompt_sha256: V1, run_id: 'prompt:ps_1:3:1700',
    });
    // Not as a recipe's trigger: a recipe its chat starts is that recipe's run.
    expect(triggeredRunOf(source() as ExecutionSource)).toBeUndefined();
    // An occurrence queued before the stamp names none; a stamp that is no hash is no source.
    const { prompt_sha256: _stamp, ...unstamped } = source().prompt_schedule;
    expect(isExecutionSource({ ...source(), prompt_schedule: unstamped })).toBe(true);
    expect(scheduledPromptRunOf({ ...source(), prompt_schedule: unstamped } as ExecutionSource)).toBeUndefined();
    expect(isExecutionSource(source({ prompt_sha256: 'not-a-hash' }))).toBe(false);
    for (const other of [
      { channel: 'schedule', actor: 'system', schedule_id: 'sch_1', cron: '0 7 * * *', source_recipe: 'r' },
      { channel: 'chat', actor: 'user_self', chat_session_id: 's', user_id: 'u' },
    ]) expect(scheduledPromptRunOf(other as ExecutionSource), JSON.stringify(other)).toBeUndefined();
  });

  it('names its AI\'s writes as a write rule does, and none a rule cannot name', () => {
    expect(triggerPreapprovalTier1Op('work.create', { kind: 'task', title: 'Pay the gas bill' })).toBe('work.create:task');
    expect(triggerPreapprovalTier1Op('work.create', { kind: 'asset', type: 'passport' })).toBe('work.create:asset:passport');
    expect(triggerPreapprovalTier1Op('calendar.create', { summary: 'Dentist' })).toBe('calendar.create:local');
    expect(triggerPreapprovalTier1Op('memory.write', { text: 'Ada likes tea' })).toBe('memory.write');
    expect(triggerPreapprovalTier1Op('contact.write', { name: 'Ada' })).toBe('contact.write:add');
    for (const [tool, args] of [
      ['work.create', {}], ['mail.send', { to: 'a@example.test' }],
      // Saving again a claim the owner revoked asks every time, as with a write rule.
      ['memory.write', { text: 'x', despite_revoked: 'clm_1' }],
      // An id this vocabulary cannot carry.
      ['calendar.create', { calendar_id: 'has spaces' }],
    ] as const) expect(triggerPreapprovalTier1Op(tool, args), `${tool} ${JSON.stringify(args)}`).toBeUndefined();
    expect(readTriggerPreapprovalTier1Op('work.create:task')).toEqual({ tool: 'work.create', scope: 'task' });
    expect(readTriggerPreapprovalTier1Op('memory.write')).toEqual({ tool: 'memory.write', scope: '' });
    // An unknown tool is none, with a scope or without one.
    for (const bad of ['memory.write:x', 'work.create', 'contact.write:delete', 'mail.send', 'mail.send:outbox', '', 7]) {
      expect(readTriggerPreapprovalTier1Op(bad), String(bad)).toBeUndefined();
    }
    expect(describeTriggerPreapprovalTier1Op('work.create:task')).toBe('Add a task');
    expect(describeTriggerPreapprovalTier1Op('calendar.create:local')).toBe('Add a calendar event, for your Recued calendar');
    expect(describeTriggerPreapprovalTier1Op('nonsense')).toBe('nonsense');
  });

  it('its words: when it runs on its schedule, its AI decides, and a change to its prompt asks again', () => {
    const trigger = { kind: 'prompt_schedule', schedule_id: 'ps_1' } as const;
    expect(triggerPreapprovalOption('prompt_schedule').label).toBe('Always allow for this scheduled prompt');
    expect(describeTriggerPreapproval(row({ trigger, door_contract_id: undefined, writes: ['work.create:task'] }), 'Morning bills',
      ['Add a task'], ['prompt'])).toBe('Morning bills, when it runs on its schedule, may do this without asking: add a task. Its AI'
      + ' decides what it writes. Once a run, until you end it.');
    const offer = { trigger, recipe_id: 'ps_1', recipe_sha256: V1, op: 'work.create:task' };
    expect(describeTriggerPreapprovalOffer({ ...offer, asks_ai: true }, 'it')).toBe('“Always allow for this scheduled prompt” stops asking'
      + ' about this write when it runs on its schedule, once a run, until you end it on the scheduled prompt\'s page or under'
      + ' Contracts. Its AI decides what it writes. A change to its prompt asks you again.');
    expect(readTriggerPreapprovalOffer(JSON.parse(JSON.stringify(offer)))).toEqual(offer);
    expect(readTriggerPreapprovalTrigger(trigger)).toEqual(trigger);
    // It covers its own prompt's version, and nothing of a recipe schedule of the same id.
    const granted = row({ trigger, door_contract_id: undefined, recipe_id: 'ps_1', recipe_sha256: V1, writes: ['work.create:task'] });
    expect(triggerPreapprovalCovers(granted, offer)).toBe(true);
    expect(triggerPreapprovalCovers(granted, { ...offer, recipe_sha256: 'd'.repeat(64) })).toBe(false);
    expect(triggerPreapprovalCovers(granted, { ...offer, op: 'work.create:note' })).toBe(false);
    expect(triggerPreapprovalCovers(granted, { ...offer, trigger: { kind: 'schedule', schedule_id: 'ps_1' } })).toBe(false);
  });
});

describe('D-341 — a pre-approval waives a ceiling\'s ask, never a review (D-192 F1)', () => {
  const unattended: ExecutionSource = {
    channel: 'schedule', actor: 'system', schedule_id: 'sch_1', cron: '0 7 * * *', source_recipe: 'propose-daily',
  };

  it('a proposed commitment held by a ceiling that already asks still records its review', () => {
    // A run held to reads asks for any write; the proposal's review is recorded all the same, so
    // nothing that waives the ceiling's ask can add the commitment unseen.
    expect(admitByOpRisk({ slug: 'commitment-propose', risk_tier: 'write', ceiling: 'read', source: unattended }))
      .toMatchObject({ verdict: 'ask', authorization_provenance: { pre_lift_approval: 'ask', lift_reason: 'review_commitment' } });
    // Lifted from an admit, as before.
    expect(admitByOpRisk({ slug: 'commitment-propose', risk_tier: 'write', ceiling: 'write', source: unattended }))
      .toMatchObject({ verdict: 'ask', authorization_provenance: { pre_lift_approval: 'never', lift_reason: 'review_commitment' } });
    // A plain create keeps the ceiling's ask alone, which a pre-approval may waive.
    expect(admitByOpRisk({ slug: 'commitment-create', risk_tier: 'write', ceiling: 'read', source: unattended })
      .authorization_provenance).not.toHaveProperty('lift_reason');
  });

  it('names the ops the gate always reviews, whoever runs them; a send only for a person driving', () => {
    for (const slug of ['commitment-propose', 'quote-signoff-release', 'quote-completion-review', 'approval-workflow-continue',
      'customer-payment-correct', 'core-commitment-propose']) expect(opAlwaysReviewed(slug), slug).toBe(true);
    for (const slug of ['commitment-create', 'mail-send', 'peer-ask', 'dom-click', 'task-create',
      'recued-core.body-signals.daily_metric.batch']) expect(opAlwaysReviewed(slug), slug).toBe(false);
  });
});

describe('D-177 with D-192 F1 — the reviews no session grant stands in for', () => {
  it('names the business reviews, the proposal among them; a send\'s review is the owner\'s chat\'s to relax', () => {
    for (const lift of ['review_commitment', 'review_quote_signoff', 'review_approval_workflow', 'review_customer_payment']) {
      expect(reviewedEachTime(lift), lift).toBe(true);
    }
    for (const lift of ['review_send', 'quality', undefined]) expect(reviewedEachTime(lift), String(lift)).toBe(false);
  });
});

