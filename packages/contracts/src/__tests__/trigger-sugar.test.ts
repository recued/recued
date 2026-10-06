/** Reactive authoring sugar — grammar, compile-down, dispatch-filter
 *  evaluator, and entry validation (design § 3/§ 4).
 *
 *  The compile pins here are wire-level: the patterns must match what
 *  the platform-reference emit sites produce
 *  (`data.connection.api.<vendor>.<entity>.<conn>.<entity>.<kind>` from
 *  both the vendor reconcilers and the watch poll loop;
 *  `data.messenger.<vendor>.message.created`;
 *  `data.reception.<kind>.request.created`;
 *  `data.form_response.accepted.response.created`) — drift here is a silently
 *  dead subscription. */

import { describe, expect, it } from 'vitest';
import {
  compileTriggerSugarEntry,
  eventPatternSegments,
  eventPatternSettings,
  matchesTriggerDispatchFilter,
  parseTriggerOn,
  recipeEventTriggerNotes,
  resolveEventPatternSettings,
  settingOfEventSegment,
  validateRecipeEventTriggerEntry,
  whereToDispatchFilter,
} from '../trigger-sugar.js';
import type { MailFactTypeSpec } from '../mail-facts.js';

const REGISTRY = [
  { vendor: 'hubspot', entity: 'deal', crm_alias: 'deal' as const },
  { vendor: 'salesforce', entity: 'opportunity', crm_alias: 'deal' as const },
  { vendor: 'hubspot', entity: 'company', crm_alias: 'account' as const },
  { vendor: 'linear', entity: 'issue' }, // non-CRM — no alias
];

describe('parseTriggerOn', () => {
  it('parses the five forms', () => {
    expect(parseTriggerOn('deal.changed')).toEqual({ kind: 'alias', alias: 'deal', verb: 'changed' });
    expect(parseTriggerOn('account.removed')).toEqual({ kind: 'alias', alias: 'account', verb: 'removed' });
    expect(parseTriggerOn('hubspot.deal.created')).toEqual({
      kind: 'vendor_entity', vendor: 'hubspot', entity: 'deal', verb: 'created',
    });
    expect(parseTriggerOn('message.received')).toEqual({ kind: 'messenger' });
    expect(parseTriggerOn('reception.request')).toEqual({ kind: 'reception' });
    expect(parseTriggerOn('form_response.accepted')).toEqual({ kind: 'form_response' });
  });

  it('rejects everything outside the closed grammar', () => {
    for (const bad of [
      'deal.updated',         // bus kind, not a canonical verb
      'deal',                 // one segment
      'widget.changed',       // unknown alias
      'a.b.c.d',              // four segments
      'my-crm.invoice.changed', // hyphenated vendor — outside the strict scope grammar
      'hubspot.Deal.changed', // uppercase entity
      'message.created',      // shorthand is exactly message.received
      'reception.created',
      'form_response.created',
      '',
    ]) {
      expect(parseTriggerOn(bad), bad).toBeNull();
    }
  });
});

describe('compileTriggerSugarEntry', () => {
  it('fans an alias form across every registry entity carrying it, mapping changed→updated', () => {
    const compiled = compileTriggerSugarEntry({ on: 'deal.changed' }, REGISTRY)!;
    expect(compiled.map((c) => c.pattern).sort()).toEqual([
      'data.connection.api.hubspot.deal.**.updated',
      'data.connection.api.salesforce.opportunity.**.updated',
    ]);
  });

  it('narrows the connection segment positionally when a literal connection is given', () => {
    const compiled = compileTriggerSugarEntry(
      { on: 'hubspot.deal.removed', connection: 'my-hubspot' },
      [],
    )!;
    expect(compiled).toEqual([
      { pattern: 'data.connection.api.hubspot.deal.my-hubspot.deal.deleted' },
    ]);
  });

  it('lowers where (id → record_id, field → record.<field>) and carries fields onto every fanned subscription', () => {
    const compiled = compileTriggerSugarEntry(
      { on: 'deal.changed', fields: ['stage'], where: { id: 'deal_7', stage: 'won' } },
      REGISTRY,
    )!;
    expect(compiled).toHaveLength(2);
    for (const sub of compiled) {
      expect(sub.fields).toEqual(['stage']);
      expect(sub.filter).toEqual({ record_id: 'deal_7', 'record.stage': 'won' });
    }
  });

  it('compiles the fixed platform shorthands to their emitted event paths', () => {
    expect(compileTriggerSugarEntry({ on: 'message.received', connection: 'slack' }, [])).toEqual([
      { pattern: 'data.messenger.slack.message.created' },
    ]);
    expect(compileTriggerSugarEntry({ on: 'message.received' }, [])).toEqual([
      { pattern: 'data.messenger.*.message.created' },
    ]);
    expect(compileTriggerSugarEntry({ on: 'reception.request' }, [])).toEqual([
      { pattern: 'data.reception.*.request.created' },
    ]);
    expect(compileTriggerSugarEntry({ on: 'form_response.accepted' }, [])).toEqual([
      { pattern: 'data.form_response.accepted.response.created' },
    ]);
  });

  it('accepted form responses narrow by emitted routing ids without exposing submitted values', () => {
    expect(compileTriggerSugarEntry({
      on: 'form_response.accepted',
      where: { endpoint_id: 'endpoint-1', form_definition_id: 'form-1' },
    }, [])).toEqual([{
      pattern: 'data.form_response.accepted.response.created',
      filter: {
        'record.endpoint_id': 'endpoint-1',
        'record.form_definition_id': 'form-1',
      },
    }]);
  });

  it('fails closed instead of compiling unknown or non-string accepted-response narrowing', () => {
    expect(compileTriggerSugarEntry({
      on: 'form_response.accepted',
      where: { form_defintion_id: 'typo' },
    }, [])).toEqual([]);
    expect(compileTriggerSugarEntry({
      on: 'form_response.accepted',
      where: { form_definition_id: 7 },
    }, [])).toEqual([]);
    expect(compileTriggerSugarEntry({
      on: 'form_response.accepted',
      where: null,
    } as never, [])).toEqual([]);
  });

  it('reception narrows by endpoint kind via where.kind → record.kind (the doorbell record carries it)', () => {
    expect(
      compileTriggerSugarEntry({ on: 'reception.request', where: { kind: 'intake_form' } }, []),
    ).toEqual([
      { pattern: 'data.reception.*.request.created', filter: { 'record.kind': 'intake_form' } },
    ]);
  });

  it('returns [] for a zero-coverage alias and null for non-sugar input', () => {
    expect(compileTriggerSugarEntry({ on: 'contact.changed' }, REGISTRY)).toEqual([]);
    expect(compileTriggerSugarEntry({ on: 'not a form' }, REGISTRY)).toBeNull();
    expect(compileTriggerSugarEntry({}, REGISTRY)).toBeNull();
  });

  it('dedupes duplicate registry rows per (vendor, entity)', () => {
    const compiled = compileTriggerSugarEntry({ on: 'deal.created' }, [
      ...REGISTRY,
      { vendor: 'hubspot', entity: 'deal', crm_alias: 'deal' as const },
    ])!;
    expect(compiled.filter((c) => c.pattern.includes('hubspot'))).toHaveLength(1);
  });
});

describe('matchesTriggerDispatchFilter', () => {
  const fatPayload = {
    record_id: 'deal_9',
    at: 1,
    platform: 'connection.api.hubspot.deal',
    slug: 'my-hubspot',
    entity_type: 'deal',
    record: { stage: 'negotiation', amount: 500, key_dates: { close_date: 1700 } },
    changed_fields: ['stage', 'key_dates.close_date'],
  };
  const doorbellPayload = {
    record_id: 'deal_9',
    at: 1,
    platform: 'connection.api.hubspot.deal',
    slug: 'my-hubspot',
    entity_type: 'deal',
  };

  it('fields gate: intersects changed_fields on fat events, PASSES doorbell events without the list', () => {
    expect(matchesTriggerDispatchFilter({ fields: ['stage'] }, fatPayload)).toBe(true);
    expect(matchesTriggerDispatchFilter({ fields: ['amount'] }, fatPayload)).toBe(false);
    expect(matchesTriggerDispatchFilter({ fields: ['key_dates.close_date'] }, fatPayload)).toBe(true);
    // The load-bearing posture: reconciler-sourced events carry no
    // changed_fields — the gate must NOT silently kill the row.
    expect(matchesTriggerDispatchFilter({ fields: ['amount'] }, doorbellPayload)).toBe(true);
  });

  it('filter gate: present paths compare strict-equal, missing paths PASS', () => {
    expect(matchesTriggerDispatchFilter(
      { filter: { 'record.stage': 'negotiation' } }, fatPayload,
    )).toBe(true);
    expect(matchesTriggerDispatchFilter(
      { filter: { 'record.stage': 'won' } }, fatPayload,
    )).toBe(false);
    expect(matchesTriggerDispatchFilter(
      { filter: { 'record.amount': 500 } }, fatPayload,
    )).toBe(true);
    expect(matchesTriggerDispatchFilter(
      { filter: { 'record.amount': '500' } }, fatPayload,
    )).toBe(false); // strict — no string/number coercion
    // record absent on the doorbell → record.stage unresolvable → PASS.
    expect(matchesTriggerDispatchFilter(
      { filter: { 'record.stage': 'won' } }, doorbellPayload,
    )).toBe(true);
  });

  it('record_id narrowing works on EVERY source (always present)', () => {
    expect(matchesTriggerDispatchFilter({ filter: { record_id: 'deal_9' } }, doorbellPayload)).toBe(true);
    expect(matchesTriggerDispatchFilter({ filter: { record_id: 'deal_8' } }, doorbellPayload)).toBe(false);
    expect(matchesTriggerDispatchFilter({ filter: { record_id: 'deal_8' } }, fatPayload)).toBe(false);
  });

  it('combines both gates (AND) and passes with neither', () => {
    expect(matchesTriggerDispatchFilter(
      { fields: ['stage'], filter: { 'record.stage': 'negotiation' } }, fatPayload,
    )).toBe(true);
    expect(matchesTriggerDispatchFilter(
      { fields: ['stage'], filter: { 'record.stage': 'won' } }, fatPayload,
    )).toBe(false);
    expect(matchesTriggerDispatchFilter({}, doorbellPayload)).toBe(true);
  });
});

describe('whereToDispatchFilter', () => {
  it('maps id to record_id and everything else under record.*', () => {
    expect(whereToDispatchFilter({ id: 'x', stage: 'won', amount: 5 })).toEqual({
      record_id: 'x',
      'record.stage': 'won',
      'record.amount': 5,
    });
  });
});

describe('validateRecipeEventTriggerEntry', () => {
  const valid = (entry: unknown) => validateRecipeEventTriggerEntry(entry);

  it('accepts the shipped raw form and well-formed sugar', () => {
    expect(valid({ event: 'data.connection.api.hubspot.deal.**.updated' })).toEqual([]);
    expect(valid({ event: 'data.mail.**.created', filter: { 'record.folder': 'inbox' } })).toEqual([]);
    expect(valid({ on: 'deal.changed', fields: ['stage'], where: { id: 'd1', amount: 5 } })).toEqual([]);
    expect(valid({ on: 'acmecrm.invoice.created', connection: 'acmecrm' })).toEqual([]);
    expect(valid({ on: 'message.received', connection: 'slack' })).toEqual([]);
    expect(valid({ on: 'reception.request', where: { kind: 'intake_form' } })).toEqual([]);
    expect(valid({
      on: 'form_response.accepted',
      where: { form_definition_id: 'form-1' },
    })).toEqual([]);
    expect(valid({
      on: 'form_response.accepted',
      where: { endpoint_id: 'endpoint-1' },
    })).toEqual([]);
  });

  it('requires exactly one of event / on', () => {
    expect(valid({})).toHaveLength(1);
    expect(valid({ event: 'a.b', on: 'deal.changed' })).toHaveLength(1);
    expect(valid('nope')).toHaveLength(1);
  });

  it('rejects sugar-only fields on raw entries and filter on sugar entries', () => {
    expect(valid({ event: 'a.b', connection: 'x' })).not.toEqual([]);
    expect(valid({ event: 'a.b', fields: ['x'] })).not.toEqual([]);
    expect(valid({ event: 'a.b', where: { x: 1 } })).not.toEqual([]);
    expect(valid({ on: 'deal.changed', filter: { x: 1 } })).not.toEqual([]);
  });

  it('rejects bad on values with the grammar in the message', () => {
    const problems = valid({ on: 'deal.updated' });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('created | changed | removed');
  });

  it('pins literal-only connection and where values (refs cannot resolve at dispatch)', () => {
    expect(valid({ on: 'acmecrm.invoice.changed', connection: '{{config.crm}}' })).not.toEqual([]);
    expect(valid({ on: 'deal.changed', where: { stage: '{{config.stage}}' } })).not.toEqual([]);
  });

  it('rejects connection on ALIAS forms (would fan never-firing rows per non-owning vendor)', () => {
    const problems = valid({ on: 'deal.changed', connection: 'my-hubspot' });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('<vendor>.<entity>.changed');
  });

  it('rejects raw event values outside the bus pattern grammar (the silent-dead typo gap)', () => {
    expect(valid({ event: 'not a pattern!!' })).not.toEqual([]);
    expect(valid({ event: 'data..email' })).not.toEqual([]);
    expect(valid({ event: 'data.mail.**.created' })).toEqual([]);
  });

  it('rejects connection on reception, fields on the platform shorthands, and malformed shapes', () => {
    expect(valid({ on: 'reception.request', connection: 'x' })).not.toEqual([]);
    expect(valid({ on: 'form_response.accepted', connection: 'x' })).not.toEqual([]);
    expect(valid({ on: 'message.received', fields: ['text'] })).not.toEqual([]);
    expect(valid({ on: 'reception.request', fields: ['kind'] })).not.toEqual([]);
    expect(valid({ on: 'form_response.accepted', fields: ['values'] })).not.toEqual([]);
    expect(valid({ on: 'deal.changed', fields: [] })).not.toEqual([]);
    expect(valid({ on: 'deal.changed', fields: ['ok', ''] })).not.toEqual([]);
    expect(valid({ on: 'deal.changed', where: { stage: { nested: true } } })).not.toEqual([]);
    expect(valid({ on: 'deal.changed', where: { id: 7 } })).not.toEqual([]);
    expect(valid({ event: 'a.b', filter: { x: [1] } })).not.toEqual([]);
  });

  it('rejects accepted-response filters that are absent from the fixed routing record', () => {
    expect(valid({
      on: 'form_response.accepted',
      where: { form_defintion_id: 'typo' },
    })[0]).toContain('id, endpoint_id, or form_definition_id');
    expect(valid({
      on: 'form_response.accepted',
      where: { form_definition_id: 7 },
    })).toContain("'where.form_definition_id' must be a string id for 'form_response.accepted'");
  });
});

/** 2026-10-05 — a raw pattern's part a dish's setting fills, so one recipe
 *  watches the folder (mailbox, calendar) each dish names. */
describe('a setting part in a raw `event` pattern', () => {
  it('keeps a setting part whole: it holds a dot of its own', () => {
    expect(eventPatternSegments('data.file.{{config.file_slug}}.*.created'))
      .toEqual(['data', 'file', '{{config.file_slug}}', '*', 'created']);
    expect(eventPatternSegments('data.mail.**.created')).toEqual(['data', 'mail', '**', 'created']);
    expect(eventPatternSettings('data.file.{{config.file_slug}}.{{config.kind}}.created')).toEqual(['file_slug', 'kind']);
    expect(settingOfEventSegment('{{config.file_slug}}')).toBe('file_slug');
    expect(settingOfEventSegment('{{step.folder}}')).toBeNull();
  });

  it('fills each from the dish’s value, and refuses one that is not a single plain part', () => {
    const fill = (value: unknown) => resolveEventPatternSettings('data.file.{{config.file_slug}}.*.created', () => value);
    expect(fill('scans')).toBe('data.file.scans.*.created');
    expect(fill('my_folder-2')).toBe('data.file.my_folder-2.*.created');
    // None chosen, a widening wildcard, a part-shifting dot, not text.
    for (const value of [undefined, null, '', '*', '**', 'a.b', 'a b', 42]) expect(fill(value)).toBeNull();
    expect(resolveEventPatternSettings('data.mail.**.created', () => 'never read')).toBe('data.mail.**.created');
  });

  it('is accepted as a whole part after the first two', () => {
    expect(validateRecipeEventTriggerEntry({ event: 'data.file.{{config.file_slug}}.*.created' })).toEqual([]);
    expect(validateRecipeEventTriggerEntry({ event: 'data.mail.{{config.mail_slug}}.message.created', filter: { 'record.folder': 'inbox' } })).toEqual([]);
    expect(validateRecipeEventTriggerEntry({ event: 'run.notify-run-failed.{{config.dish}}.failed' })).toEqual([]);
  });

  it.each([
    ['the kind of event', 'data.{{config.kind}}.*.*.created', 'only after its first two'],
    ['the namespace', '{{config.ns}}.file.*.created', 'only after its first two'],
    ['part of a part', 'data.file.in-{{config.file_slug}}.*.created', 'only as the whole part'],
    ['anything but a setting', 'data.file.{{step.folder}}.*.created', 'only as the whole part'],
    ['an unclosed reference', 'data.file.{{config.file_slug.*.created', 'only as the whole part'],
  ])('⛔ refuses a setting in %s', (_where, event, says) => {
    const problems = validateRecipeEventTriggerEntry({ event });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(says);
  });

  it('still checks the rest of the pattern', () => {
    expect(validateRecipeEventTriggerEntry({ event: 'data.file.{{config.file_slug}}..created' })[0]).toContain('not a valid bus pattern');
  });
});

describe('mail facts — `mail_fact` (D-315 §5.1)', () => {
  // A trigger watches variables, whatever kind of email has them (ruling 42).
  const valid = (entry: unknown) => validateRecipeEventTriggerEntry(entry);
  const notes = (entry: unknown) => recipeEventTriggerNotes(entry);
  const ownersOnly = ' — only a kind made on the owner’s server can start it';

  it('parses one kind or any kind, and never reads a third part as vendor.entity.verb', () => {
    expect(parseTriggerOn('mail_fact')).toEqual({ kind: 'mail_fact', type: null });
    expect(parseTriggerOn('mail_fact.shipment')).toEqual({ kind: 'mail_fact', type: 'shipment' });
    expect(parseTriggerOn('mail_fact.custom_wine_club')).toEqual({ kind: 'mail_fact', type: 'custom_wine_club' });
    // Today's grammar would take this as vendor `mail_fact`, entity `shipment`:
    // a connection pattern that never fires and never errors.
    expect(parseTriggerOn('mail_fact.shipment.changed')).toBeNull();
    expect(parseTriggerOn('mail_fact.parcel')).toBeNull();
    expect(parseTriggerOn('mail_fact.')).toBeNull();
  });

  it('compiles to one kind’s things, or every kind’s, with where under record.* and fields as given', () => {
    expect(compileTriggerSugarEntry({ on: 'mail_fact' }, [])).toEqual([{ pattern: 'data.mail_fact.*.thing.*' }]);
    expect(compileTriggerSugarEntry({ on: 'mail_fact.lead' }, [])).toEqual([{ pattern: 'data.mail_fact.lead.thing.*' }]);
    expect(compileTriggerSugarEntry(
      { on: 'mail_fact.shipment', fields: ['state'], where: { state: 'delivered', complete: true } },
      [],
    )).toEqual([{
      pattern: 'data.mail_fact.shipment.thing.*',
      filter: { 'record.state': 'delivered', 'record.complete': true },
      fields: ['state'],
    }]);
  });

  it('says what is wrong with the on value: a verb, or no such kind', () => {
    expect(valid({ on: 'mail_fact.shipment.changed' })).toEqual([
      "'mail_fact.shipment.changed': a mail-fact trigger takes no verb — 'mail_fact.shipment' wakes on the thing's creation and on every change; narrow with 'fields' and 'where'",
    ]);
    expect(valid({ on: 'mail_fact.parcel' })[0]).toContain("'mail_fact.parcel' names no kind of email — use 'mail_fact.<kind>'");
  });

  it('refuses a key that is no part of a mail-fact trigger, rather than leaving it wider than written', () => {
    // Ignored, `typ` would have watched every kind.
    expect(valid({ on: 'mail_fact', typ: 'shipment', fields: ['state'] })).toEqual([
      "'typ' is not part of a mail-fact trigger — it takes 'on', 'fields', 'where' and 'template_variable'",
    ]);
    expect(valid({ on: 'mail_fact.shipment', feilds: ['state'] })[0]).toContain("'feilds' is not part of a mail-fact trigger");
    expect(compileTriggerSugarEntry({ on: 'mail_fact', typ: 'shipment' } as never, [])).toEqual([]);
  });

  it('narrows to the recipe’s own template by its setting: the id only the reconciler knows (§5.1, §5.2)', () => {
    const entry = { on: 'mail_fact.shipment', fields: ['state'], template_variable: 'template' };
    expect(valid(entry)).toEqual([]);
    // Without the setting, or with no template chosen: no row, which would
    // otherwise wake for every template's facts.
    expect(compileTriggerSugarEntry(entry, [])).toEqual([]);
    expect(compileTriggerSugarEntry(entry, [], { templateOf: () => null })).toEqual([]);
    expect(compileTriggerSugarEntry(entry, [], { templateOf: (name) => (name === 'template' ? 'mtpl_1' : null) })).toEqual([{
      pattern: 'data.mail_fact.shipment.thing.*',
      filter: { 'record.template': 'mtpl_1' },
      fields: ['state'],
    }]);
    expect(compileTriggerSugarEntry(
      { on: 'mail_fact', where: { state: 'delivered' }, template_variable: 'template' },
      [],
      { templateOf: () => 'mtpl_1' },
    )).toEqual([{ pattern: 'data.mail_fact.*.thing.*', filter: { 'record.state': 'delivered', 'record.template': 'mtpl_1' } }]);
  });

  it('⛔ refuses a template_variable that names nothing, sits beside where.template, or narrows anything but a mail fact', () => {
    expect(valid({ on: 'mail_fact.shipment', template_variable: '' })).toEqual([
      "'template_variable' must name one of the recipe's mail_template variables",
    ]);
    const both = { on: 'mail_fact.shipment', template_variable: 'template', where: { template: 'mtpl_1' } };
    expect(valid(both)).toEqual(["'template_variable' and 'where.template' each name the template — keep one"]);
    expect(compileTriggerSugarEntry(both, [], { templateOf: () => 'mtpl_2' })).toEqual([]);
    expect(valid({ on: 'form_response.accepted', template_variable: 'template' })).toContain(
      "'template_variable' applies only to a mail-fact trigger — it names the template whose facts wake it",
    );
    expect(valid({ event: 'data.mail_fact.*.thing.*', template_variable: 'template' })).toContain(
      "'template_variable' requires the 'on' form — a raw 'event' entry narrows via its pattern / 'filter'",
    );
  });

  it('materializes nothing for what no fact can match (an unvalidated import)', () => {
    const entries: Parameters<typeof compileTriggerSugarEntry>[0][] = [
      { on: 'mail_fact', where: { id: 'mthing_1' } },
      { on: 'mail_fact', where: { type: 'shipment' } },
      { on: 'mail_fact', where: { state: 'Delivered' } },      // a state is a lower-case word
      { on: 'mail_fact', where: { carrier: ' UPS' } },
      { on: 'mail_fact', where: { tracking_number: '' } },
      { on: 'mail_fact', where: { complete: 'yes' } },
      { on: 'mail_fact', fields: ['complete'] },               // not a variable
      { on: 'mail_fact', fields: ['Stage'] },
      { on: 'mail_fact', connection: 'work' },
      { on: 'mail_fact', where: { last_email_at: 5 } },
      // What the kind named does not have.
      { on: 'mail_fact.shipment', where: { state: 'overdue' } },
      { on: 'mail_fact.shipment', where: { notice: 'reminder' } },
      { on: 'mail_fact.bill', where: { amount_due: 5 } },
      { on: 'mail_fact.shipment', fields: ['stage'] },
      // What the check refuses with its own reason, never left wider or dead.
      { on: 'mail_fact.shipment', filter: { 'record.state': 'delivered' } } as never,
      { on: 'mail_fact.shipment', url: 'x', selector: 'y' } as never,
      { on: 'mail_fact.shipment', fields: 'state' } as never,
      { on: 'mail_fact.shipment', fields: [] },
      { on: 'mail_fact.shipment', where: { state: '{{config.state}}' } },
      { on: 'mail_fact.shipment', where: { carrier: 'United Parcel Service' } },
    ];
    for (const entry of entries) {
      expect(compileTriggerSugarEntry(entry, []), JSON.stringify(entry)).toEqual([]);
    }
  });

  it('materializes what no built-in kind has from a recipe — a kind made later may have it', () => {
    expect(compileTriggerSugarEntry({ on: 'mail_fact', fields: ['vintage'], where: { colour: 'red' } }, [])).toEqual([
      { pattern: 'data.mail_fact.*.thing.*', filter: { 'record.colour': 'red' }, fields: ['vintage'] },
    ]);
  });

  it('is strict at dispatch: an unread variable is null, and null never matches', () => {
    const row = { filter: { 'record.state': 'delivered' }, fields: ['state'] };
    const event = (state: string | null, changed: string[]) => ({
      platform: 'mail_fact', record_id: 'mthing_1', record: { state, carrier: 'UPS' }, changed_fields: changed,
    });
    expect(matchesTriggerDispatchFilter(row, event('delivered', ['state']))).toBe(true);
    expect(matchesTriggerDispatchFilter(row, event(null, ['carrier']))).toBe(false);
    expect(matchesTriggerDispatchFilter(row, event('delivered', ['carrier']))).toBe(false);
  });

  it('is strict across kinds: a fact whose kind lacks a variable does not match it', () => {
    // A purchase has no notice. Anywhere else a missing path passes (a
    // doorbell event carries no record); on a fact it would wake a
    // price-change recipe for every purchase.
    const row = { filter: { 'record.notice': 'price_change' } };
    const purchase = { platform: 'mail_fact', record_id: 'mthing_2', record: { merchant: 'Shop', state: 'paid' }, changed_fields: ['state'] };
    expect(matchesTriggerDispatchFilter(row, purchase)).toBe(false);
    expect(matchesTriggerDispatchFilter(row, { ...purchase, record: { ...purchase.record, notice: 'price_change' } })).toBe(true);
    expect(matchesTriggerDispatchFilter(row, { ...purchase, platform: 'connection' })).toBe(true);
    // And a fact event always says what changed: without it, a fields gate does not pass.
    const { changed_fields: _changed, ...unsaid } = purchase;
    expect(matchesTriggerDispatchFilter({ fields: ['state'] }, unsaid)).toBe(false);
    expect(matchesTriggerDispatchFilter({ fields: ['state'] }, { ...unsaid, platform: 'connection' })).toBe(true);
  });

  it('accepts the spec’s examples, with nothing to note', () => {
    for (const entry of [
      { on: 'mail_fact' },
      { on: 'mail_fact', fields: ['state'], where: { state: 'delivered' } },
      { on: 'mail_fact', fields: ['carrier', 'tracking_number'] },
      { on: 'mail_fact', fields: ['notice'], where: { notice: 'reminder' } },
      { on: 'mail_fact', where: { complete: true, template: 'mtpl_1', due_at: '2026-10-01' } },
    ]) {
      expect(valid(entry), JSON.stringify(entry)).toEqual([]);
      expect(notes(entry), JSON.stringify(entry)).toEqual([]);
    }
  });

  it('refuses what no fact of any kind can match', () => {
    expect(valid({ on: 'mail_fact', connection: 'work' })[0]).toContain("'connection' does not apply to a mail fact");
    expect(valid({ on: 'mail_fact', where: { id: 'mthing_1' } })).toEqual([
      "'where.id' does not apply to a mail fact — a thing's id is minted on the owner's server",
    ]);
    expect(valid({ on: 'mail_fact', where: { type: 'shipment' } })).toEqual([
      "'where.type': name the kind in 'on' — 'mail_fact.shipment' — or leave it out for any kind",
    ]);
    expect(valid({ on: 'mail_fact.shipment', where: { last_email_at: 5 } })).toEqual([
      "'where.last_email_at': a time is never matched exactly — name it in 'fields' to wake for every new email about the thing",
    ]);
    expect(valid({ on: 'mail_fact', fields: ['complete'] })).toEqual([
      "'fields' names 'complete', which is not a variable — 'fields' lists the variables whose change wakes it",
    ]);
    expect(valid({ on: 'mail_fact', where: { 'Due At': '2026-10-01' } })[0]).toContain('is not a variable');
    expect(valid({ on: 'mail_fact', where: { state: 'Delivered' } })).toEqual([
      "'where.state' must be a state as every kind of email writes one: lower-case words joined by _ (for example out_for_delivery)",
    ]);
    expect(valid({ on: 'mail_fact', where: { complete: 'yes' } })).toEqual(["'where.complete' must be true or false"]);
    expect(valid({ on: 'mail_fact', where: { state: '{{config.state}}' } })).not.toEqual([]);
  });

  it('refuses a string value no fact can hold: empty, or text not written as it is stored', () => {
    // An empty reading is stored as null, and found text is stored collapsed.
    for (const where of [{ tracking_number: '' }, { carrier: ' ' }]) {
      expect(valid({ on: 'mail_fact', where })).toEqual([
        `'where.${Object.keys(where)[0]}' must not be empty — a fact never stores an empty value`,
      ]);
    }
    expect(valid({ on: 'mail_fact', where: { template: '' } })).toEqual(["'where.template' must be a template's id"]);
    for (const carrier of [' UPS', 'UPS ', 'Royal  Mail', 'Royal\tMail']) {
      expect(valid({ on: 'mail_fact', where: { carrier } })).toEqual([
        "'where.carrier' must be written as the fact stores it — no spaces at either end, and one between words",
      ]);
    }
    expect(valid({ on: 'mail_fact', where: { carrier: 'Royal Mail' } })).toEqual([]);
  });

  it('compares no time, and wants an id written as facts store it', () => {
    // A fact stores a date-time to the second: watch it with `fields` instead.
    expect(valid({ on: 'mail_fact.shipment', where: { delivered_at: '2026-09-26' } })[0]).toMatch(/^'where\.delivered_at' is not filterable on shipment — use its variables \(money, times, files and data are not; watch a time with 'fields'\)/);
    expect(valid({ on: 'mail_fact.shipment', fields: ['delivered_at'] })).toEqual([]);
    expect(valid({ on: 'mail_fact.purchase', where: { order_id: '#112-3345' } })).toEqual([
      "'where.order_id' must be written as a fact stores it: '112-3345'",
    ]);
    expect(valid({ on: 'mail_fact.purchase', where: { order_id: '112-3345' } })).toEqual([]);
  });

  it('wants a carrier written as facts store it', () => {
    expect(valid({ on: 'mail_fact.shipment', where: { carrier: 'United Parcel Service' } })).toEqual([
      "'where.carrier' must be written as a fact stores it: 'UPS'",
    ]);
    expect(valid({ on: 'mail_fact', where: { carrier: 'fedex' } })).toEqual(["'where.carrier' must be written as a fact stores it: 'FedEx'"]);
    expect(valid({ on: 'mail_fact.shipment', where: { carrier: 'UPS' } })).toEqual([]);
    expect(valid({ on: 'mail_fact.shipment', where: { carrier: 'Royal Mail' } })).toEqual([]);
  });

  it('wants a value written as facts store text: canonical, so it can match one (§9)', () => {
    // A fullwidth carrier is the carrier, and named as facts name it.
    expect(valid({ on: 'mail_fact.shipment', where: { carrier: '\uFF35\uFF30\uFF33' } })).toEqual([
      "'where.carrier' must be written as a fact stores it: 'UPS' — plain letters and digits, and nothing that does not show",
    ]);
    expect(valid({ on: 'mail_fact.shipment', where: { tracking_number: '1Z\u200B999AA1' } })).toEqual([
      "'where.tracking_number' must be written as a fact stores it: '1Z999AA1' — plain letters and digits, and nothing that does not show",
    ]);
    expect(valid({ on: 'mail_fact', where: { merchant: 'Shop\u00A0A' } })).toEqual([
      "'where.merchant' must be written as the fact stores it — no spaces at either end, and one between words",
    ]);
    // An id written in fullwidth digits is the id facts store.
    expect(valid({ on: 'mail_fact.purchase', where: { order_id: '\uFF11\uFF11\uFF12-3345' } })).toEqual([
      "'where.order_id' must be written as a fact stores it: '112-3345' — plain letters and digits, and nothing that does not show",
    ]);
    expect(valid({ on: 'mail_fact', where: { merchant: 'Shop A' } })).toEqual([]);
  });

  it('checks a trigger on one kind against that kind exactly', () => {
    expect(valid({ on: 'mail_fact.shipment', fields: ['state', 'carrier'], where: { state: 'delivered', carrier: 'UPS' } })).toEqual([]);
    expect(valid({ on: 'mail_fact.shipment', where: { state: 'overdue' } })).toEqual([
      "'where.state' must be one of label_created, in_transit, out_for_delivery, delivered, exception, returned",
    ]);
    // A shipment has no notice; a bill's amount is money.
    expect(valid({ on: 'mail_fact.shipment', where: { notice: 'reminder' } })[0]).toContain("'where.notice' is not filterable on shipment");
    expect(valid({ on: 'mail_fact.bill', where: { amount_due: 5 } })[0]).toContain("'where.amount_due' is not filterable on bill");
    expect(valid({ on: 'mail_fact.shipment', fields: ['stage'] })[0]).toContain("'fields' names 'stage', which is not a variable of shipment");
    expect(valid({ on: 'mail_fact.shipment', where: { expected_at: '10/01/2026' } })).toEqual([
      "'where.expected_at' must be a date as the fact stores it (YYYY-MM-DD)",
    ]);
    // Exact on its kind, so nothing is left to note.
    expect(notes({ on: 'mail_fact.shipment', fields: ['state'] })).toEqual([]);
  });

  it('wakes on every new email about the thing only for a trigger that names its time (ruling 44)', () => {
    for (const on of ['mail_fact', 'mail_fact.shipment', 'mail_fact.bill']) {
      expect(valid({ on, fields: ['last_email_at'] }), on).toEqual([]);
      expect(notes({ on, fields: ['last_email_at'] }), on).toEqual([]);
    }
    const timeOnly = {
      platform: 'mail_fact', record_id: 'mthing_1', record: { state: 'in_transit' }, prev: { state: 'in_transit' }, changed_fields: ['last_email_at'],
    };
    // "Every change" is a change of what the thing says: a repeat email is not one.
    expect(matchesTriggerDispatchFilter({}, timeOnly)).toBe(false);
    expect(matchesTriggerDispatchFilter({ filter: { 'record.state': 'in_transit' } }, timeOnly)).toBe(false);
    expect(matchesTriggerDispatchFilter({ fields: ['state'] }, timeOnly)).toBe(false);
    expect(matchesTriggerDispatchFilter({ fields: ['last_email_at'] }, timeOnly)).toBe(true);
    expect(matchesTriggerDispatchFilter({ fields: ['last_email_at'], filter: { 'record.state': 'in_transit' } }, timeOnly)).toBe(true);
    // A new email that also changed something is a change for everyone.
    const withState = { ...timeOnly, changed_fields: ['state', 'last_email_at'] };
    expect(matchesTriggerDispatchFilter({}, withState)).toBe(true);
    expect(matchesTriggerDispatchFilter({ fields: ['state'] }, withState)).toBe(true);
    // A creation always counts — even one that read nothing but its time (a
    // template whose AI could not answer): it carries no `prev`.
    const { prev: _prev, ...created } = timeOnly;
    expect(matchesTriggerDispatchFilter({}, created)).toBe(true);
    expect(matchesTriggerDispatchFilter({ filter: { 'record.template': 'mtpl_1' } }, { ...created, record: { template: 'mtpl_1' } })).toBe(true);
  });

  it('notes, and does not refuse, what no built-in kind has: a kind the owner makes may have it', () => {
    const noted = (entry: Record<string, unknown>, note: string) => {
      expect(valid({ on: 'mail_fact', ...entry }), note).toEqual([]);
      expect(notes({ on: 'mail_fact', ...entry })).toEqual([note]);
    };
    noted({ where: { vintage: '2019' } }, `'where.vintage': no built-in kind of email has a variable 'vintage'${ownersOnly}`);
    noted({ fields: ['vintage'] }, `'fields': no built-in kind of email has a variable 'vintage'${ownersOnly}`);
    noted({ where: { state: 'uncorked' } }, `'where.state': no built-in kind of email has the state 'uncorked'${ownersOnly}`);
    noted(
      { where: { amount_due: 5 } },
      `'where.amount_due': every kind of email that has amount_due holds money, a time, a file or data in it, which a filter cannot compare (watch it with 'fields')${ownersOnly}`,
    );
    noted(
      { where: { expected_at: '10/01/2026' } },
      `'where.expected_at' must be a date as the fact stores it (YYYY-MM-DD) in every built-in kind of email that has it${ownersOnly}`,
    );
    noted(
      { where: { tracking_number: '1Z 999' } },
      `'where.tracking_number' must be written as a fact stores it: '1Z999' in every built-in kind of email that has it${ownersOnly}`,
    );
    // Every `where` holds for one fact: a delivered shipment has no notices.
    noted(
      { where: { state: 'delivered', notice: 'reminder' } },
      `'where': no built-in kind of email has state and notice with these values together${ownersOnly}`,
    );
    noted(
      { fields: ['tracking_number'], where: { notice: 'reminder' } },
      `'fields': no kind of email the 'where' matches has a variable 'tracking_number'${ownersOnly}`,
    );
    // Any other trigger has nothing to note.
    expect(notes({ on: 'form_response.accepted' })).toEqual([]);
    expect(notes({ event: 'data.mail_fact.*.thing.*' })).toEqual([]);
  });
});

describe('a kind of email the owner made (D-315 §4.5, §5.1)', () => {
  const wine: MailFactTypeSpec = {
    id: 'custom_wine_club',
    name: 'Wine club',
    description: 'A box from the wine club.',
    variables: [
      { name: 'club', kind: 'text', required: true },
      { name: 'box_id', kind: 'id', required: true },
      { name: 'colour', kind: 'enum', required: false, values: ['red', 'white'] },
      { name: 'price', kind: 'money', required: false },
    ],
    states: ['shipped', 'delivered', 'uncorked'],
    notices: [],
    identity: [['club', 'box_id']],
  };
  const onThisServer = { mailFactTypes: () => [wine] };

  it('lets a trigger made on its server watch its variables, and refuses what no kind there has', () => {
    expect(validateRecipeEventTriggerEntry({ on: 'mail_fact', fields: ['state'], where: { colour: 'red' } }, onThisServer))
      .toEqual([]);
    expect(validateRecipeEventTriggerEntry({ on: 'mail_fact', where: { state: 'uncorked' } }, onThisServer)).toEqual([]);
    expect(validateRecipeEventTriggerEntry({ on: 'mail_fact', where: { colour: 'rose' } }, onThisServer))
      .toEqual(["'where.colour': no kind of email on this server has the colour 'rose'"]);
    expect(validateRecipeEventTriggerEntry({ on: 'mail_fact', where: { price: 5 } }, onThisServer))
      .toEqual(["'where.price': every kind of email that has price holds money, a time, a file or data in it, which a filter cannot compare (watch it with 'fields')"]);
    expect(validateRecipeEventTriggerEntry({ on: 'mail_fact', fields: ['vintage'] }, onThisServer))
      .toEqual(["'fields': no kind of email on this server has a variable 'vintage'"]);
    // The check that knows every kind refuses; it has nothing left to note.
    expect(recipeEventTriggerNotes({ on: 'mail_fact', fields: ['vintage'] }, onThisServer)).toEqual([]);
  });

  it('can be the one kind a trigger is on: exact where it exists, refused where it does not, noted in a recipe', () => {
    expect(validateRecipeEventTriggerEntry({ on: 'mail_fact.custom_wine_club', where: { colour: 'red' } }, onThisServer)).toEqual([]);
    expect(validateRecipeEventTriggerEntry({ on: 'mail_fact.custom_wine_club', where: { colour: 'rose' } }, onThisServer))
      .toEqual(["'where.colour' must be one of red, white"]);
    expect(validateRecipeEventTriggerEntry({ on: 'mail_fact.custom_beer_club' }, onThisServer))
      .toEqual(["'mail_fact.custom_beer_club': there is no kind of email 'custom_beer_club' on this server"]);
    expect(compileTriggerSugarEntry({ on: 'mail_fact.custom_wine_club', where: { state: 'uncorked' } }, [], onThisServer))
      .toEqual([{ pattern: 'data.mail_fact.custom_wine_club.thing.*', filter: { 'record.state': 'uncorked' } }]);
    // A recipe's check cannot see the owner's kinds: it notes the kind, and
    // the recipe's row is made, for the server that has it.
    const entry = { on: 'mail_fact.custom_wine_club', where: { colour: 'red' } };
    expect(validateRecipeEventTriggerEntry(entry)).toEqual([]);
    expect(recipeEventTriggerNotes(entry)).toEqual([
      "'mail_fact.custom_wine_club': a kind of email made on a server exists only there — this recipe starts only where it was made",
    ]);
    expect(compileTriggerSugarEntry(entry, [])).toEqual([
      { pattern: 'data.mail_fact.custom_wine_club.thing.*', filter: { 'record.colour': 'red' } },
    ]);
  });

  it('compiles for its server what is there, and nothing for what no kind there has', () => {
    expect(compileTriggerSugarEntry({ on: 'mail_fact', where: { colour: 'red' } }, [], onThisServer))
      .toEqual([{ pattern: 'data.mail_fact.*.thing.*', filter: { 'record.colour': 'red' } }]);
    expect(compileTriggerSugarEntry({ on: 'mail_fact', where: { colour: 'rose' } }, [], onThisServer)).toEqual([]);
  });

  it('is watched by a recipe too, which never names it: a recipe only hears it noted', () => {
    const entry = { on: 'mail_fact', fields: ['colour'], where: { state: 'uncorked' } };
    expect(validateRecipeEventTriggerEntry(entry)).toEqual([]);
    expect(recipeEventTriggerNotes(entry)).toEqual([
      "'where.state': no built-in kind of email has the state 'uncorked' — only a kind made on the owner’s server can start it",
      "'fields': no built-in kind of email has a variable 'colour' — only a kind made on the owner’s server can start it",
    ]);
    expect(validateRecipeEventTriggerEntry(entry, onThisServer)).toEqual([]);
  });
});
