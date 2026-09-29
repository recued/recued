/** Authoring sugar — `event_triggers` entry validation in the recipe
 *  validator. The grammar itself lives in @recued/contracts
 *  (`validateRecipeEventTriggerEntry`, exhaustively covered there);
 *  this suite locks the WIRING — both forms accepted on a real recipe,
 *  per-entry error paths, and the shipped raw corpus staying green. */

import { describe, it, expect } from 'vitest';
import { validateRecipe } from '../validate.js';
import type { RecipeDefinition } from '@recued/contracts';

const base: RecipeDefinition = {
  recipe_id: 'stalling-deal-alert',
  version: 1,
  ttl: 60,
  metadata: {
    name: 'Stalling Deal Alert',
    description: 'Fires when a watched deal changes. Sample reactive recipe.',
    author: 'recued',
    supported_platforms: ['server'],
    tags: ['reactive', 'crm'],
  },
  variables: {},
  prefetch_steps: [],
  steps: [
    {
      id: 'noop',
      transform: 'concat',
      values: ['fired'],
    },
  ],
  output: { sidebar: [{ type: 'summary', source: 'step.noop' }] },
};

const withTriggers = (event_triggers: unknown): unknown => ({
  ...base,
  event_triggers,
});

const errorCodes = (input: unknown): string[] =>
  validateRecipe(input).issues.filter((i) => i.severity === 'error').map((i) => i.code);

describe('event_triggers validation wiring', () => {
  it('accepts the shipped raw form and the canonical sugar forms', () => {
    const result = validateRecipe(withTriggers([
      { event: 'data.connection.api.hubspot.deal.**.updated' },
      { event: 'data.mail.**.created', filter: { 'record.folder': 'inbox' } },
      { on: 'deal.changed', fields: ['stage'], where: { id: 'deal_1' } },
      { on: 'acmecrm.invoice.created', connection: 'acmecrm' },
      { on: 'message.received', connection: 'slack' },
      { on: 'reception.request', where: { kind: 'intake_form' } },
      { on: 'form_response.accepted', where: { form_definition_id: 'client-intake' } },
    ]));
    expect(result.issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it('accepts the event-bound accepted-response reader as a kernel prefetch op', () => {
    const result = validateRecipe({
      ...base,
      event_triggers: [{
        on: 'form_response.accepted',
        where: { form_definition_id: 'client-intake' },
      }],
      prefetch_steps: [{
        id: 'form_response',
        op: 'core.data.form-response.get',
        args: { submission_id: '{{context.event.payload.record_id}}' },
      }],
    });

    expect(result.issues.filter((issue) => issue.severity === 'error')).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it('rejects a non-array field and malformed entries with per-entry paths', () => {
    expect(errorCodes(withTriggers('nope'))).toContain('event_triggers_shape');

    const result = validateRecipe(withTriggers([
      { on: 'deal.updated' },                       // bad verb
      { event: 'a.b', on: 'deal.changed' },         // both forms
      { on: 'deal.changed', where: { stage: '{{config.s}}' } }, // ref in where
      { on: 'form_response.accepted', where: { form_defintion_id: 'typo' } },
    ]));
    const entryIssues = result.issues.filter((i) => i.code === 'event_trigger_entry_invalid');
    expect(entryIssues.map((i) => i.path)).toEqual([
      'event_triggers[0]',
      'event_triggers[1]',
      'event_triggers[2]',
      'event_triggers[3]',
    ]);
    expect(result.valid).toBe(false);
  });

  it('compiled workflow markers (composition.* / schedule.cron) validate as raw entries', () => {
    expect(errorCodes(withTriggers([
      { event: 'composition.reception_form_submission', filter: { processing_outcome: 'pending' } },
      { event: 'schedule.cron', filter: { cron: '0 9 * * *' } },
    ]))).toEqual([]);
  });

  // D-315 §5.1 — a mail-fact trigger watches variables, whatever kind of email
  // has them (ruling 42). What no built-in kind has is a warning, not an
  // error: a kind the owner makes on their server may have it.
  it('warns, and does not refuse, a mail-fact trigger watching what no built-in kind has', () => {
    const result = validateRecipe(withTriggers([{ on: 'mail_fact', fields: ['state'], where: { vintage: '2019' } }]));
    expect(result.valid).toBe(true);
    expect(result.issues.filter((issue) => issue.code === 'event_trigger_mail_fact_unknown')).toEqual([{
      severity: 'warn',
      code: 'event_trigger_mail_fact_unknown',
      path: 'event_triggers[0]',
      message: "'where.vintage': no built-in kind of email has a variable 'vintage' — only a kind made on the owner’s server can start it",
    }]);
    expect(validateRecipe(withTriggers([{ on: 'mail_fact', fields: ['state'], where: { state: 'delivered' } }])).issues
      .filter((issue) => issue.path.startsWith('event_triggers'))).toEqual([]);
    // On one kind it is checked exactly; a kind made on a server is noted.
    expect(errorCodes(withTriggers([{ on: 'mail_fact.shipment', fields: ['state'] }]))).toEqual([]);
    expect(validateRecipe(withTriggers([{ on: 'mail_fact.custom_wine_club' }])).issues
      .filter((issue) => issue.code === 'event_trigger_mail_fact_unknown').map((issue) => issue.severity)).toEqual(['warn']);
    // A key that is no part of one is an error, not ignored.
    expect(errorCodes(withTriggers([{ on: 'mail_fact', typ: 'shipment' }]))).toEqual(['event_trigger_entry_invalid']);
  });
});
