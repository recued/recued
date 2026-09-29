import { describe, expect, it } from 'vitest';
import type { RecipeDefinition } from '@recued/contracts';
import { deriveTier2ArgSchema } from '../chat-catalog.js';

// D-193 — a `type: 'datetime'` recipe variable must project into the chat
// tool schema as a JSON-Schema `date-time` string, so the model emits a
// stable ISO 8601 / RFC 3339 timestamp instead of guessing raw epoch-ms.

const props = (recipe: RecipeDefinition): Record<string, Record<string, unknown>> =>
  deriveTier2ArgSchema(recipe).properties as Record<string, Record<string, unknown>>;

describe('D-193 datetime variable → stable date-time arg schema', () => {
  it('projects a required datetime variable as { type: string, format: date-time }', () => {
    const recipe = {
      recipe_id: 'remind-me-of',
      variables: {
        remind_at: { label: 'Remind at', type: 'datetime', help: 'ISO 8601 with offset' },
      },
    } as unknown as RecipeDefinition;

    const schema = deriveTier2ArgSchema(recipe);
    expect(props(recipe).remind_at).toMatchObject({ type: 'string', format: 'date-time' });
    expect(props(recipe).remind_at.description).toBe('ISO 8601 with offset');
    // No `optional` / `default` ⇒ required.
    expect(schema.required).toContain('remind_at');
  });

  it('keeps an optional datetime out of the required set', () => {
    const recipe = {
      recipe_id: 'schedule-recipe',
      variables: {
        run_at: { label: 'Run at', type: 'datetime', optional: true, help: 'ISO 8601' },
      },
    } as unknown as RecipeDefinition;

    const schema = deriveTier2ArgSchema(recipe);
    expect(props(recipe).run_at).toMatchObject({ type: 'string', format: 'date-time' });
    expect((schema.required as string[] | undefined) ?? []).not.toContain('run_at');
  });
});

describe('a `date` variable → a JSON-Schema `date` string', () => {
  // A calendar DAY: `YYYY-MM-DD` is the whole value, so the model has no time
  // to invent and no zone to guess — the two ways a `date-time` goes wrong for
  // a target or due date.
  it('projects as { type: string, format: date }, and never as date-time', () => {
    const recipe = {
      recipe_id: 'initialize-federated-project',
      variables: {
        target_completion_at: { label: 'Target completion', type: 'date', optional: true },
      },
    } as unknown as RecipeDefinition;

    const schema = deriveTier2ArgSchema(recipe);
    expect(props(recipe).target_completion_at).toEqual({ type: 'string', format: 'date', description: 'Target completion' });
    expect((schema.required as string[] | undefined) ?? []).not.toContain('target_completion_at');
  });
});

