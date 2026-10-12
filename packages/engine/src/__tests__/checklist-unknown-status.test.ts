/** A checklist row the engine cannot judge is unknown (`null`), shown with its
 *  `detail_null`: through the real engine, its real condition evaluator, and the
 *  step runner that hands the transform its conditions unresolved.
 *
 *  ⛔ Until 2026-10-11 no shipped `detail_null` ever showed. The transform waited for
 *  `evaluate` to return null, the engine's evaluator returns a boolean only, and the
 *  transform's own test stubbed `evaluate` to return null. A missing value was
 *  compared anyway and came out fine or a problem by accident: "Last activity  days
 *  ago", in green. And a row with no condition threw, failing its run. */

import { describe, expect, it } from 'vitest';
import type { RecipeDefinition } from '@recued/contracts';

import { executeRecipe } from '../execute.js';
import type { IngredientExecutor } from '../types.js';

/** These recipes call no ingredient. */
const noIngredients: IngredientExecutor = async (slug) => {
  throw new Error(`unexpected ingredient '${slug}'`);
};

const ITEMS = [
  {
    label: 'Last touch',
    issue: '{{context.days}} greater 14',
    detail_ok: 'Last activity {{context.days}} days ago',
    detail_issue: 'No contact for {{context.days}} days',
    detail_null: 'No activity timestamp found',
  },
  { label: 'Last touch, no detail_null', issue: '{{context.days}} greater 14', detail_ok: 'Last activity {{context.days}} days ago' },
  {
    label: 'Email',
    issue: '{{context.contact.email}} is_empty',
    detail_ok: 'Email: {{context.contact.email}}',
    detail_issue: 'No email address',
    detail_null: 'Email field unavailable',
  },
  {
    label: 'Pricing',
    issue: '{{context.extraction.pricing}} is_not_null',
    detail_ok: 'No pricing mentioned',
    detail_issue: 'Pricing: {{context.extraction.pricing}}',
    detail_null: 'Could not determine',
  },
  {
    label: 'Stale contacts',
    issue: '{{context.stale}} is_not_empty',
    detail_ok: 'All contacts engaged',
    detail_issue: 'Some contacts went quiet',
    detail_null: 'No contacts linked',
  },
  { label: 'Location', issue: '{{context.location}} is_empty', detail_ok: 'At {{context.location}}', detail_issue: 'No location on the event' },
  { label: 'Location, equal null', issue: '{{context.location}} equal null', detail_ok: 'Set', detail_issue: 'Missing' },
  { label: 'Opener', detail_ok: '{{context.opener}}', detail_null: 'No recent news found' },
  { label: 'Static', detail_ok: 'Always shown' },
];

const recipe: RecipeDefinition = {
  recipe_id: 'checklist-unknown-status',
  version: 1,
  ttl: 0,
  metadata: { name: 'Checklist unknown status', description: 'test', author: 'test', supported_platforms: [] },
  variables: {},
  prefetch_steps: [],
  steps: [{ id: 'checks', transform: 'to_checklist', title: 'Checks', items: ITEMS }],
  output: { render: [{ type: 'checklist', source: 'step.checks' }] },
} as unknown as RecipeDefinition;

const run = async (context: Record<string, unknown>) => {
  const result = await executeRecipe({
    recipe,
    stores: { vault: {}, config: {}, context, meta: {}, step: {} },
    ingredientExecutor: noIngredients,
  });
  expect(result.success, JSON.stringify(result.errors)).toBe(true);
  const checks = result.steps.find((step) => step.id === 'checks')?.result as {
    items: Array<{ label: string; status: string; detail?: unknown }>;
  };
  return Object.fromEntries(checks.items.map((item) => [item.label, { status: item.status, detail: item.detail }]));
};

describe('to_checklist through the engine — a row it cannot judge is unknown', () => {
  it('with nothing there: each row says so, or reports the absence it asks about', async () => {
    const rows = await run({});
    expect(rows).toEqual({
      'Last touch': { status: 'null', detail: 'No activity timestamp found' },
      // The status says it; detail_ok would read the missing value as a blank.
      'Last touch, no detail_null': { status: 'null', detail: undefined },
      'Email': { status: 'null', detail: 'Email field unavailable' },
      'Pricing': { status: 'null', detail: 'Could not determine' },
      'Stale contacts': { status: 'null', detail: 'No contacts linked' },
      // These ask whether the value is missing: it is, and that is the problem.
      'Location': { status: 'issue', detail: 'No location on the event' },
      'Location, equal null': { status: 'issue', detail: 'Missing' },
      'Opener': { status: 'null', detail: 'No recent news found' },
      'Static': { status: 'ok', detail: 'Always shown' },
    });
  });

  it("with the record read and its field empty, the field's test answers", async () => {
    const rows = await run({ contact: { email: null }, extraction: {}, stale: [] });
    expect(rows['Email']).toEqual({ status: 'issue', detail: 'No email address' });
    expect(rows['Pricing']).toEqual({ status: 'ok', detail: 'No pricing mentioned' });
    expect(rows['Stale contacts']).toEqual({ status: 'ok', detail: 'All contacts engaged' });
  });

  it('with the values there, each row is judged as before', async () => {
    const rows = await run({
      days: 3,
      contact: { email: 'ana@example.com' },
      extraction: { pricing: '$5k a seat' },
      stale: ['bo@example.com'],
      location: 'Room 1',
      opener: 'Ask about the launch',
    });
    expect(rows).toEqual({
      'Last touch': { status: 'ok', detail: 'Last activity 3 days ago' },
      'Last touch, no detail_null': { status: 'ok', detail: 'Last activity 3 days ago' },
      'Email': { status: 'ok', detail: 'Email: ana@example.com' },
      'Pricing': { status: 'issue', detail: 'Pricing: $5k a seat' },
      'Stale contacts': { status: 'issue', detail: 'Some contacts went quiet' },
      'Location': { status: 'ok', detail: 'At Room 1' },
      'Location, equal null': { status: 'ok', detail: 'Set' },
      'Opener': { status: 'ok', detail: 'Ask about the launch' },
      'Static': { status: 'ok', detail: 'Always shown' },
    });
    expect((await run({ days: 30 }))['Last touch']).toEqual({ status: 'issue', detail: 'No contact for 30 days' });
  });

  it("resolves a row's text once: a value holding braces is shown, not resolved", async () => {
    const rows = await run({ opener: 'Mention {{context.secret}}', secret: 'leaked' });
    expect(rows['Opener']).toEqual({ status: 'ok', detail: 'Mention {{context.secret}}' });
  });
});
