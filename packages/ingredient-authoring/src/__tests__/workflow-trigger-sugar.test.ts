/** Authoring-sugar compile-down — the decomposer's recipe-template trigger
 *  lowering (the G6 decomposer half).
 *
 *  Vendor-entity recipe-template rows mint the canonical `on:` subscriber
 *  form (created + changed) so compiled alerts become REAL bus
 *  subscribers; reception rows keep the `composition.reception_*`
 *  local-dispatch marker the D-173 drain seam resolves recipes by
 *  (becoming a live subscriber would double-fire the workflow with the
 *  thin doorbell payload); `scheduled-operate` keeps the
 *  `schedule.cron` marker (the cron substrate's vocabulary). */

import { describe, expect, it } from 'vitest';
import { decomposeComposition } from '../decomposer.js';
import type { CompositionIngredient, RecipeTemplateRow } from '../schema.js';

const composition = (
  recipeTemplate: RecipeTemplateRow,
  connection = 'acmecrm',
): CompositionIngredient => ({
  schema_version: 1,
  slug: 'acmecrm-deals',
  ingredients: [
    {
      slug: 'acmecrm-deals',
      kind: 'http',
      http: { base: 'https://api.example.test', connection },
    },
  ],
  operations: [
    {
      op: 'invoice.update',
      ingredient: 'acmecrm-deals',
      risk: 'write',
      approval: 'ask',
      bind: { kind: 'rest', method: 'PATCH', path_template: '/invoices/{id}' },
    },
    {
      op: 'invoice.read',
      ingredient: 'acmecrm-deals',
      risk: 'read',
      approval: 'never',
      bind: { kind: 'rest', method: 'GET', path_template: '/invoices/{id}' },
    },
  ],
  recipe_templates: [recipeTemplate],
});

describe('recipe-template trigger lowering (authoring sugar)', () => {
  it('vendor rows mint created + changed sugar entries carrying connection / fields / where', () => {
    const artifacts = decomposeComposition[1]!(composition({
      template: 'conditional-operate',
      trigger: { entity: 'invoice', field: 'status', value: 'overdue' },
      operation: 'invoice.update',
    }));
    const recipe = artifacts.recipes![0]!;
    expect(recipe.event_triggers).toEqual([
      {
        on: 'acmecrm.invoice.created',
        connection: 'acmecrm',
        fields: ['status'],
        where: { status: 'overdue' },
      },
      {
        on: 'acmecrm.invoice.changed',
        connection: 'acmecrm',
        fields: ['status'],
        where: { status: 'overdue' },
      },
    ]);
    expect(artifacts.warnings ?? []).toEqual([]);
  });

  it('a field-only vendor row mints fields without where; a bare row mints neither', () => {
    const fieldOnly = decomposeComposition[1]!(composition({
      template: 'notify-on-event',
      trigger: { entity: 'invoice', field: 'status' },
      operation: 'invoice.update',
    })).recipes![0]!;
    expect(fieldOnly.event_triggers).toEqual([
      { on: 'acmecrm.invoice.created', connection: 'acmecrm', fields: ['status'] },
      { on: 'acmecrm.invoice.changed', connection: 'acmecrm', fields: ['status'] },
    ]);

    const bare = decomposeComposition[1]!(composition({
      template: 'notify-on-event',
      trigger: { entity: 'invoice' },
      operation: 'invoice.update',
    })).recipes![0]!;
    expect(bare.event_triggers).toEqual([
      { on: 'acmecrm.invoice.created', connection: 'acmecrm' },
      { on: 'acmecrm.invoice.changed', connection: 'acmecrm' },
    ]);
  });

  it('the conditional-operate guard reads the vendor field under payload.record', () => {
    const recipe = decomposeComposition[1]!(composition({
      template: 'conditional-operate',
      trigger: { entity: 'invoice', field: 'status', value: 'overdue' },
      operation: 'invoice.update',
    })).recipes![0]!;
    const guard = recipe.steps[0] as unknown as {
      guard: { field: string; operator: string; value?: unknown };
    };
    expect(guard.guard).toEqual({
      field: '{{context.event.payload.record.status}}',
      operator: 'equal',
      value: 'overdue',
    });
  });

  it('EVERY reactive template guards a field-bearing vendor row (codex HIGH: the dispatch filter passes doorbell events, so an unguarded notify/ask would fire on every change)', () => {
    for (const template of ['notify-on-event', 'review-then-approve', 'escalate'] as const) {
      const recipe = decomposeComposition[1]!(composition({
        template,
        trigger: { entity: 'invoice', field: 'status', value: 'overdue' },
        operation: 'invoice.update',
      })).recipes![0]!;
      const first = recipe.steps[0] as unknown as { id: string; guard?: unknown };
      expect(first.id, template).toBe('condition');
      expect(first.guard, template).toEqual({
        field: '{{context.event.payload.record.status}}',
        operator: 'equal',
        value: 'overdue',
      });
    }
    // A field-less vendor row stays unguarded — there is no condition
    // to enforce.
    const bare = decomposeComposition[1]!(composition({
      template: 'notify-on-event',
      trigger: { entity: 'invoice' },
      operation: 'invoice.update',
    })).recipes![0]!;
    expect((bare.steps[0] as unknown as { id: string }).id).toBe('notify');
  });

  it('reception rows keep the composition.* marker (the drain seam resolves by it) and top-level guard refs', () => {
    const artifacts = decomposeComposition[1]!(composition({
      template: 'review-then-approve',
      trigger: { entity: 'reception_form_submission', field: 'processing_outcome', value: 'pending' },
      operation: 'invoice.update',
    }, 'reception'));
    const recipe = artifacts.recipes![0]!;
    expect(recipe.event_triggers).toEqual([
      {
        event: 'composition.reception_form_submission',
        filter: { processing_outcome: 'pending' },
      },
    ]);
    expect(artifacts.warnings ?? []).toEqual([]);
    // NO injected guard: the drain seam dispatches the projection as the
    // payload and enforces pending-ness itself — a guard on row state
    // the projection may not carry would wrongly skip the materialize.
    expect((recipe.steps[0] as unknown as { id: string }).id).toBe('approved_operation');

    const conditional = decomposeComposition[1]!(composition({
      template: 'conditional-operate',
      trigger: { entity: 'reception_form_submission', field: 'processing_outcome', value: 'pending' },
      operation: 'invoice.update',
    }, 'reception')).recipes![0]!;
    const guard = conditional.steps[0] as unknown as {
      guard: { field: string };
    };
    expect(guard.guard.field).toBe('{{context.event.payload.processing_outcome}}');
  });

  it('scheduled-operate keeps the schedule.cron marker', () => {
    const recipe = decomposeComposition[1]!(composition({
      template: 'scheduled-operate',
      trigger: { entity: 'invoice', cron: '0 9 * * *' },
      operation: 'invoice.update',
    })).recipes![0]!;
    expect(recipe.event_triggers).toEqual([
      { event: 'schedule.cron', filter: { cron: '0 9 * * *' } },
    ]);
  });

  it('a vendor id outside the strict scope grammar keeps the inert marker and raises a decompose warning', () => {
    const artifacts = decomposeComposition[1]!(composition({
      template: 'notify-on-event',
      trigger: { entity: 'invoice', field: 'status' },
      operation: 'invoice.update',
    }, 'my-acme-crm'));
    const recipe = artifacts.recipes![0]!;
    expect(recipe.event_triggers).toEqual([
      { event: 'composition.invoice', filter: { field: 'status' } },
    ]);
    expect(artifacts.warnings).toHaveLength(1);
    expect(artifacts.warnings![0]).toMatchObject({
      code: 'composition_workflow_trigger_not_reactive',
      path: 'recipe_templates',
    });
    expect(artifacts.warnings![0]!.message).toContain('my-acme-crm');
  });
});
