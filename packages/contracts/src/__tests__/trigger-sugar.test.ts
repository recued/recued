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
  matchesTriggerDispatchFilter,
  parseTriggerOn,
  validateRecipeEventTriggerEntry,
  whereToDispatchFilter,
} from '../trigger-sugar.js';

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
