/** D-201 Slice 0 — recipe validator wiring for local requirements and
 * binding-aware webhook triggers. */

import { describe, expect, it } from 'vitest';
import type { RecipeDefinition } from '@recued/contracts';
import { validateRecipe } from '../validate.js';

const base: RecipeDefinition = {
  recipe_id: 'stripe-webhook-consumer',
  version: 1,
  ttl: 60,
  metadata: {
    name: 'Stripe webhook consumer',
    description: 'D-201 trigger fixture',
    author: 'recued',
    supported_platforms: ['server'],
  },
  variables: {},
  prefetch_steps: [],
  steps: [{ id: 'result', transform: 'concat', values: ['ok'] }],
  output: { render: [{ type: 'text', source: 'step.result' }] },
};

const localRequirement = {
  binding: 'billing_events',
  profile_ids: ['stripe.event.v1'] as const,
  paired_connection_slot: 'stripe',
  required_event_types: ['invoice.paid'],
  optional_event_types: ['invoice.payment_failed'],
  registration_modes: ['manual'] as const,
  environment_policy: 'match_connection' as const,
  decoded_payload_access: 'scoped_read' as const,
  source_truth_policy: 'provider_readback_required' as const,
};

describe('D-201 recipe webhook declarations', () => {
  it('accepts a standalone local requirement and strict trigger', () => {
    const result = validateRecipe({
      ...base,
      webhook_requirements: [localRequirement],
      webhook_triggers: [{
        binding: 'billing_events',
        event_types: ['invoice.paid'],
      }],
    });
    expect(result.valid).toBe(true);
    expect(result.issues.filter((issue) => issue.severity === 'error')).toEqual([]);
  });

  it('accepts a shape-valid pack-owned trigger without duplicating the pack requirement', () => {
    const result = validateRecipe({
      ...base,
      metadata: {
        ...base.metadata,
        recipe_bundle: 'recued-core/stripe-workflows',
      },
      webhook_triggers: [{
        binding: 'billing_events',
        event_types: ['invoice.paid'],
      }],
    });
    expect(result.valid).toBe(true);
  });

  it('rejects a dangling standalone trigger with neither local requirements nor an owning pack', () => {
    const result = validateRecipe({
      ...base,
      webhook_triggers: [{
        binding: 'billing_events',
        event_types: ['invoice.paid'],
      }],
    });
    expect(result.issues).toContainEqual(expect.objectContaining({
      severity: 'error',
      code: 'webhook_requirements_required',
      path: 'webhook_requirements',
    }));
  });

  it('rejects malformed declarations with precise nested paths', () => {
    const result = validateRecipe({
      ...base,
      webhook_requirements: 'not-an-array',
      webhook_triggers: [{
        binding: 'Billing Events',
        event_types: [],
        filter: { amount: 10 },
      }],
    });
    expect(result.issues.filter((issue) => issue.severity === 'error')).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'webhook_requirements_shape', path: 'webhook_requirements' }),
      expect.objectContaining({ code: 'webhook_trigger_entry_invalid', path: 'webhook_triggers[0].binding' }),
      expect.objectContaining({ code: 'webhook_trigger_entry_invalid', path: 'webhook_triggers[0].event_types' }),
      expect.objectContaining({ code: 'webhook_trigger_entry_invalid', path: 'webhook_triggers[0].filter' }),
    ]));
  });

  it('fails closed on an unknown local binding and undeclared event type', () => {
    const result = validateRecipe({
      ...base,
      webhook_requirements: [localRequirement],
      webhook_triggers: [
        { binding: 'other_events', event_types: ['invoice.paid'] },
        { binding: 'billing_events', event_types: ['charge.refunded'] },
      ],
    });
    expect(result.issues.filter((issue) => issue.severity === 'error')).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'webhook_trigger_binding_unknown',
        path: 'webhook_triggers[0].binding',
      }),
      expect.objectContaining({
        code: 'webhook_trigger_event_undeclared',
        path: 'webhook_triggers[1].event_types[0]',
      }),
    ]));
  });

  it('rejects duplicate binding/event subscriptions across trigger entries', () => {
    const result = validateRecipe({
      ...base,
      webhook_requirements: [localRequirement],
      webhook_triggers: [
        { binding: 'billing_events', event_types: ['invoice.paid'] },
        { binding: 'billing_events', event_types: ['invoice.paid'] },
      ],
    });
    expect(result.issues).toContainEqual(expect.objectContaining({
      severity: 'error',
      code: 'webhook_trigger_entry_invalid',
      path: 'webhook_triggers[1].event_types[0]',
    }));
  });
});
