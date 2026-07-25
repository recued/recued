/** Phase 3 contract additions: `event_triggers` on RecipeDefinition
 *  + EVENT_TRIGGER_BACKPRESSURE error code.
 */
import { describe, expect, it } from 'vitest';
import {
  ERR,
  type RecipeDefinition,
  type RecipeErrorCode,
  type RecipeEventTrigger,
} from '../index.js';

describe('Phase 3 — EVENT_TRIGGER_BACKPRESSURE error code', () => {
  it('ERR has a severity entry', () => {
    const code: RecipeErrorCode = 'EVENT_TRIGGER_BACKPRESSURE';
    expect(ERR[code]).toMatch(/^(fatal|error|warn)$/);
  });

  it('is `warn` — back-pressure is a soft signal, not a terminal error', () => {
    // The producer should slow down or the recipe's filter should
    // widen; the runtime keeps working. Warn fits the audit-only
    // semantic.
    expect(ERR.EVENT_TRIGGER_BACKPRESSURE).toBe('warn');
  });
});

describe('Phase 3 — RecipeEventTrigger shape', () => {
  it('accepts a pattern-only trigger', () => {
    const t: RecipeEventTrigger = { event: 'data.email.arrived' };
    expect(t.event).toBe('data.email.arrived');
    expect(t.filter).toBeUndefined();
  });

  it('accepts a pattern + filter trigger', () => {
    const t: RecipeEventTrigger = {
      event: 'data.email.arrived',
      filter: {
        folder: 'INBOX',
        'from.domain': 'acme.com',
      },
    };
    expect(t.filter?.folder).toBe('INBOX');
  });

  it('plugs into RecipeDefinition.event_triggers as an optional array', () => {
    const recipe: RecipeDefinition = {
      recipe_id: 'notify-urgent-email-gmail',
      version: 1,
      ttl: 60,
      metadata: {
        name: 'Notify urgent emails',
        description: 'fire when an urgent email arrives',
        author: 'recued',
        supported_platforms: ['gmail'],
      },
      variables: {},
      prefetch_steps: [],
      steps: [],
      output: { sidebar: [] },
      event_triggers: [
        {
          event: 'data.email.arrived',
          filter: { folder: 'INBOX' },
        },
      ],
    };
    expect(recipe.event_triggers?.[0].event).toBe('data.email.arrived');
  });
});
