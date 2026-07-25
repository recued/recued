/** D-128 Phase 6 — permission-gate validator tests.
 *
 *  Three validator surfaces ship in this phase:
 *    1. `enrichment_write_permission_missing` — hard error when a
 *       recipe writes via `enrichment-upsert` without declaring
 *       `requires: ['write_enrichment']`.
 *    2. `read_connection_permission_missing` — soft warn when a recipe
 *       reads (or writes) a platform-reference scope without declaring
 *       any `read_connection_<connection_name>` slug. The runtime
 *       resolver is the authoritative gate; the validator surfaces a
 *       hint pointing at the convention.
 *    3. `requires_unknown` does NOT fire on `read_connection_*` slugs —
 *       the open-prefix family is recognised by `isConnectionReadPermission`. */

import { describe, expect, it } from 'vitest';
import {
  ENRICHMENT_WRITE_PERMISSION,
  CONNECTION_READ_PERMISSION_PREFIX,
  isConnectionReadPermission,
} from '@recued/contracts';
import type { RecipeDefinition } from '@recued/contracts';
import { validateRecipe } from '../validate.js';

// ────────────────────────────────────────────────────────────────
// Fixtures
// ────────────────────────────────────────────────────────────────

const base: RecipeDefinition = {
  recipe_id: 'd-128-p6-permissions',
  version: 1,
  ttl: 60,
  metadata: {
    name: 'D-128 P6 permissions',
    description: 'Recipe under test for the D-128 P6 permission-gate validator surfaces.',
    author: 'recued',
    supported_platforms: ['gmail'],
    tags: ['test'],
  },
  variables: {},
  prefetch_steps: [],
  steps: [{ id: 'noop', transform: 'concat', values: ['ok'] }],
  output: { sidebar: [{ type: 'summary', source: 'step.noop' }] },
};

const codes = (result: { issues: Array<{ code: string }> }): string[] =>
  result.issues.map((i) => i.code);

const errorCodes = (result: { issues: Array<{ code: string; severity: string }> }): string[] =>
  result.issues.filter((i) => i.severity === 'error').map((i) => i.code);

const messagesFor = (
  result: { issues: Array<{ code: string; message: string }> },
  code: string,
): string[] => result.issues.filter((i) => i.code === code).map((i) => i.message);

const enrichmentUpsertStep = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'write',
  ingredient: 'enrichment-upsert',
  input: {
    topic: 'contact_timeline_rollup',
    id: 'bob@x.com',
    value: { /* runtime-resolved */ },
  },
  ...overrides,
});

// ────────────────────────────────────────────────────────────────
// `write_enrichment` gate
// ────────────────────────────────────────────────────────────────

describe('D-128 P6 — write_enrichment permission gate', () => {
  it('exposes the permission slug constant', () => {
    expect(ENRICHMENT_WRITE_PERMISSION).toBe('write_enrichment');
  });

  it('hard-errors when enrichment-upsert appears without write_enrichment', () => {
    const recipe: RecipeDefinition = {
      ...base,
      steps: [
        enrichmentUpsertStep() as RecipeDefinition['steps'][number],
      ],
    };
    const result = validateRecipe(recipe);
    expect(errorCodes(result)).toContain('enrichment_write_permission_missing');
    expect(result.valid).toBe(false);
  });

  it('passes when write_enrichment is declared in requires', () => {
    const recipe: RecipeDefinition = {
      ...base,
      requires: ['write_enrichment'],
      steps: [
        enrichmentUpsertStep() as RecipeDefinition['steps'][number],
      ],
    };
    const result = validateRecipe(recipe);
    expect(errorCodes(result)).not.toContain('enrichment_write_permission_missing');
  });

  it('fires once per recipe regardless of enrichment-upsert step count', () => {
    const recipe: RecipeDefinition = {
      ...base,
      steps: [
        enrichmentUpsertStep({ id: 'a' }) as RecipeDefinition['steps'][number],
        enrichmentUpsertStep({ id: 'b' }) as RecipeDefinition['steps'][number],
        enrichmentUpsertStep({ id: 'c' }) as RecipeDefinition['steps'][number],
      ],
    };
    const result = validateRecipe(recipe);
    const fires = result.issues.filter((i) => i.code === 'enrichment_write_permission_missing');
    expect(fires).toHaveLength(1);
  });

  it('fires across all step phases (prefetch / sequential / trigger)', () => {
    const recipe: RecipeDefinition = {
      ...base,
      auto_run: { interval_ms: 60_000 },
      trigger_steps: [enrichmentUpsertStep({ id: 'tr' }) as RecipeDefinition['steps'][number]],
      prefetch_steps: [],
      steps: [{ id: 'noop', transform: 'concat', values: ['ok'] }],
    };
    const result = validateRecipe(recipe);
    expect(errorCodes(result)).toContain('enrichment_write_permission_missing');
  });

  it('does not fire when no enrichment-upsert step exists', () => {
    const result = validateRecipe(base);
    expect(codes(result)).not.toContain('enrichment_write_permission_missing');
  });

  it('points at the first enrichment-upsert step in the error message', () => {
    const recipe: RecipeDefinition = {
      ...base,
      steps: [
        { id: 'plain', transform: 'concat', values: ['x'] },
        enrichmentUpsertStep({ id: 'first_write' }) as RecipeDefinition['steps'][number],
        enrichmentUpsertStep({ id: 'second_write' }) as RecipeDefinition['steps'][number],
      ],
    };
    const result = validateRecipe(recipe);
    const msgs = messagesFor(result, 'enrichment_write_permission_missing');
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toContain('steps[1]');
    expect(msgs[0]).toContain('write_enrichment');
  });
});

// ────────────────────────────────────────────────────────────────
// `read_connection_*` permission family
// ────────────────────────────────────────────────────────────────

describe('D-128 P6 — read_connection_* permission family', () => {
  it('exposes the prefix constant + recognition helper', () => {
    expect(CONNECTION_READ_PERMISSION_PREFIX).toBe('read_connection_');
    expect(isConnectionReadPermission('read_connection_acme_hubspot')).toBe(true);
    expect(isConnectionReadPermission('read_connection_x')).toBe(true);
    expect(isConnectionReadPermission('read_connection_')).toBe(false); // bare prefix invalid
    expect(isConnectionReadPermission('read_memory')).toBe(false);
    expect(isConnectionReadPermission('write_enrichment')).toBe(false);
  });

  it('accepts read_connection_<name> slugs without warning', () => {
    const recipe: RecipeDefinition = {
      ...base,
      requires: ['read_connection_acme_hubspot'],
    };
    const result = validateRecipe(recipe);
    const unknownFires = result.issues.filter((i) => i.code === 'requires_unknown');
    expect(unknownFires).toHaveLength(0);
  });

  it('still warns on unknown permission slugs that are NOT read_connection_*', () => {
    const recipe: RecipeDefinition = {
      ...base,
      requires: ['read_some_other_thing'],
    };
    const result = validateRecipe(recipe);
    expect(codes(result)).toContain('requires_unknown');
    const msg = messagesFor(result, 'requires_unknown')[0]!;
    expect(msg).toContain("read_connection_<connection_name>");
  });
});

// ────────────────────────────────────────────────────────────────
// Platform-reference scope read hint
// ────────────────────────────────────────────────────────────────

describe('D-128 P6 — read_connection_permission_missing hint (reads)', () => {
  it('warns when a recipe reads a platform-reference scope without read_connection_*', () => {
    const recipe: RecipeDefinition = {
      ...base,
      steps: [
        {
          id: 'noop',
          transform: 'concat',
          values: [
            'risk: {{data.enrichment.connection.api.hubspot.deal.hubspot_deal_47291.deal_health_score.score}}',
          ],
        },
      ],
    };
    const result = validateRecipe(recipe);
    expect(codes(result)).toContain('read_connection_permission_missing');
    const msg = messagesFor(result, 'read_connection_permission_missing')[0]!;
    expect(msg).toContain("'connection.api.hubspot.deal'");
    expect(msg).toContain('hubspot');
    // Soft warn — recipe is still valid.
    expect(result.valid).toBe(true);
  });

  it('does NOT fire when the recipe declares any read_connection_<name> slug', () => {
    const recipe: RecipeDefinition = {
      ...base,
      requires: ['read_connection_acme_hubspot'],
      steps: [
        {
          id: 'read_score',
          transform: 'concat',
          values: [
            'risk: {{data.enrichment.connection.api.hubspot.deal.hubspot_deal_47291.deal_health_score.score}}',
          ],
        },
      ],
    };
    const result = validateRecipe(recipe);
    expect(codes(result)).not.toContain('read_connection_permission_missing');
  });

  it('does NOT fire on closed-list scope reads (mail / contact / calendar / file)', () => {
    const recipe: RecipeDefinition = {
      ...base,
      steps: [
        {
          id: 'read_rollup',
          transform: 'concat',
          values: [
            'rollup: {{data.enrichment.contact.bob@x.com.contact_timeline_rollup}}',
          ],
        },
      ],
    };
    const result = validateRecipe(recipe);
    expect(codes(result)).not.toContain('read_connection_permission_missing');
  });

  it('lists each unique platform-reference scope touched by the recipe', () => {
    const recipe: RecipeDefinition = {
      ...base,
      steps: [
        {
          id: 'read_health',
          transform: 'concat',
          values: [
            '{{data.enrichment.connection.api.hubspot.deal.d1.deal_health_score.score}}',
            '{{data.enrichment.connection.api.salesforce.opportunity.o1.deal_health_score.score}}',
          ],
        },
      ],
    };
    const result = validateRecipe(recipe);
    const msg = messagesFor(result, 'read_connection_permission_missing')[0]!;
    expect(msg).toContain("'connection.api.hubspot.deal'");
    expect(msg).toContain("'connection.api.salesforce.opportunity'");
    // Multi-vendor recipes drop the bare-vendor mention from the
    // "<vendor> connection name" parenthetical because ambiguity wins.
    expect(msg).toContain('connection name at install');
  });
});

// ────────────────────────────────────────────────────────────────
// Platform-reference scope write hint
// ────────────────────────────────────────────────────────────────

describe('D-128 P6 — read_connection_permission_missing hint (writes)', () => {
  it('warns when enrichment-upsert writes a platform-reference scope without read_connection_*', () => {
    const recipe: RecipeDefinition = {
      ...base,
      requires: ['write_enrichment'],
      steps: [
        {
          id: 'write_score',
          ingredient: 'enrichment-upsert',
          input: {
            topic: 'deal_health_score',
            scope: 'connection.api.hubspot.deal',
            id: 'hubspot_deal_47291',
            value: { score: 78, signals: [], reasoning: '' },
            authored_by_recipe_id: 'r',
          },
          // Top-level scope as well — validator probes both surfaces.
          scope: 'connection.api.hubspot.deal',
        } as RecipeDefinition['steps'][number],
      ],
    };
    const result = validateRecipe(recipe);
    expect(codes(result)).toContain('read_connection_permission_missing');
  });

  it('does NOT fire when the write step uses a closed-list scope', () => {
    const recipe: RecipeDefinition = {
      ...base,
      requires: ['write_enrichment'],
      steps: [
        enrichmentUpsertStep({
          id: 'w',
          scope: 'contact',
        }) as RecipeDefinition['steps'][number],
      ],
    };
    const result = validateRecipe(recipe);
    expect(codes(result)).not.toContain('read_connection_permission_missing');
  });

  it('does NOT fire when the recipe declares any read_connection_<name> slug', () => {
    const recipe: RecipeDefinition = {
      ...base,
      requires: ['write_enrichment', 'read_connection_acme_hubspot'],
      steps: [
        enrichmentUpsertStep({
          id: 'w',
          scope: 'connection.api.hubspot.deal',
          input: {
            topic: 'deal_health_score',
            id: 'd1',
            value: { score: 78, signals: [], reasoning: '' },
            authored_by_recipe_id: 'r',
          },
        }) as RecipeDefinition['steps'][number],
      ],
    };
    const result = validateRecipe(recipe);
    expect(codes(result)).not.toContain('read_connection_permission_missing');
  });
});
