/** D-115 Phase 1 — recipe validator additions for `auto_run` +
 *  `trigger_steps`. Locks the cross-field invariant (trigger_steps
 *  requires auto_run), structural shape checks for both fields, and
 *  namespace recognition for `{{trigger.*}}` refs.
 */

import { describe, it, expect } from 'vitest';
import { validateRecipe } from '../validate.js';
import type { RecipeDefinition } from '@recued/contracts';
import { AUTO_RUN_SERVER_FLOOR_MS } from '@recued/contracts';

// Reactive recipe used as a starting point — keeps test diffs small.
const baseReactive: RecipeDefinition = {
  recipe_id: 'reactive-page-watcher',
  version: 1,
  ttl: 60,
  metadata: {
    name: 'Reactive Page Watcher',
    description: 'Fires when a watched page changes. Sample reactive recipe.',
    author: 'recued',
    supported_platforms: ['server'],
    tags: ['reactive', 'web'],
  },
  variables: {},
  auto_run: { interval_ms: 60_000 },
  trigger_steps: [
    {
      id: 'page',
      ingredient: 'http-watcher',
      input: { target_url: 'https://example.com/pricing' },
    },
  ],
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

const codesOf = (result: { issues: Array<{ code: string }> }): string[] =>
  result.issues.map((i) => i.code);

describe('D-115 — known-good reactive recipe passes', () => {
  it('the reactive sample has zero errors', () => {
    const result = validateRecipe(baseReactive);
    const errors = result.issues.filter((i) => i.severity === 'error');
    if (errors.length > 0) {
      throw new Error('Sample should have zero errors:\n' +
        errors.map(e => `  [${e.code}] ${e.path}: ${e.message}`).join('\n'));
    }
    expect(result.valid).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────
// auto_run shape
// ────────────────────────────────────────────────────────────────

describe('auto_run shape', () => {
  it('non-object auto_run → auto_run_shape', () => {
    const recipe = { ...baseReactive, auto_run: 'every 60s' as unknown as never };
    expect(codesOf(validateRecipe(recipe))).toContain('auto_run_shape');
  });

  it('array auto_run → auto_run_shape', () => {
    const recipe = { ...baseReactive, auto_run: [] as unknown as never };
    expect(codesOf(validateRecipe(recipe))).toContain('auto_run_shape');
  });

  it('missing interval_ms → auto_run_interval_invalid', () => {
    const recipe = { ...baseReactive, auto_run: {} as unknown as never };
    expect(codesOf(validateRecipe(recipe))).toContain('auto_run_interval_invalid');
  });

  it('zero interval_ms → auto_run_interval_invalid', () => {
    const recipe = { ...baseReactive, auto_run: { interval_ms: 0 } };
    expect(codesOf(validateRecipe(recipe))).toContain('auto_run_interval_invalid');
  });

  it('negative interval_ms → auto_run_interval_invalid', () => {
    const recipe = { ...baseReactive, auto_run: { interval_ms: -100 } };
    expect(codesOf(validateRecipe(recipe))).toContain('auto_run_interval_invalid');
  });

  it('sub-floor interval_ms → auto_run_interval_below_floor (warn, not error)', () => {
    const recipe = { ...baseReactive, auto_run: { interval_ms: AUTO_RUN_SERVER_FLOOR_MS - 1 } };
    const result = validateRecipe(recipe);
    const codes = codesOf(result);
    expect(codes).toContain('auto_run_interval_below_floor');
    // Warn-only — still valid.
    expect(result.valid).toBe(true);
  });

  it('non-boolean dynamic → auto_run_dynamic_shape', () => {
    const recipe = {
      ...baseReactive,
      auto_run: { interval_ms: 60_000, dynamic: 'yes' as unknown as never },
    };
    expect(codesOf(validateRecipe(recipe))).toContain('auto_run_dynamic_shape');
  });

  it('accepts explicit default-disabled auto-run and rejects non-boolean defaults', () => {
    const disabled = {
      ...baseReactive,
      auto_run: { interval_ms: 60_000, default_enabled: false },
    };
    expect(validateRecipe(disabled).valid).toBe(true);

    const malformed = {
      ...baseReactive,
      auto_run: { interval_ms: 60_000, default_enabled: 'no' as unknown as boolean },
    };
    expect(codesOf(validateRecipe(malformed))).toContain('auto_run_default_enabled_shape');
  });
});

// ────────────────────────────────────────────────────────────────
// trigger_steps shape + cross-field invariant
// ────────────────────────────────────────────────────────────────

describe('trigger_steps cross-field invariant', () => {
  it('trigger_steps without auto_run → trigger_steps_without_auto_run', () => {
    const { auto_run: _omit, ...rest } = baseReactive;
    expect(codesOf(validateRecipe(rest))).toContain('trigger_steps_without_auto_run');
  });

  it('auto_run without trigger_steps is allowed (always-fire reactive recipe)', () => {
    const recipe = { ...baseReactive, trigger_steps: undefined };
    const result = validateRecipe(recipe);
    expect(codesOf(result)).not.toContain('trigger_steps_without_auto_run');
    expect(result.valid).toBe(true);
  });

  it('non-array trigger_steps → trigger_steps_shape', () => {
    const recipe = { ...baseReactive, trigger_steps: 'http-watcher' as unknown as never };
    expect(codesOf(validateRecipe(recipe))).toContain('trigger_steps_shape');
  });

  it('empty trigger_steps array → trigger_steps_empty (warn)', () => {
    const recipe = { ...baseReactive, trigger_steps: [] };
    const result = validateRecipe(recipe);
    expect(codesOf(result)).toContain('trigger_steps_empty');
    expect(result.valid).toBe(true);
  });
});

/** 2026-10-05 — the mail, file, calendar, webhook and recipe watchers were
 *  retired. A recipe naming one is refused here with what replaced it, where
 *  it used to pass this check and fail at install or dispatch as an unknown op. */
describe('a retired watcher is refused with its replacement', () => {
  it.each([
    [{ id: 'gate', op: 'core.watch.mail', args: { slug: 'work' } }, 'core.watch.mail', 'data.mail.{{config.mail_slug}}.*.created'],
    [{ id: 'gate', ingredient: 'file-watcher', input: { slug: 'scans' } }, 'file-watcher', 'data.file.{{config.file_slug}}.*.created'],
    [{ id: 'gate', op: 'core.watch.calendar', args: { slug: 'work', kind: 'starting_soon' } }, 'core.watch.calendar', 'core.watch.time-relative'],
    [{ id: 'gate', op: 'core.watch.webhook', args: { slug: 'stripe' } }, 'core.watch.webhook', 'webhook_triggers'],
    [{ id: 'gate', ingredient: 'recipe-watcher', input: { recipe_id: 'daily-digest' } }, 'recipe-watcher', 'run.<recipe_id>.*.failed'],
  ])('%j', (step, named, instead) => {
    const issue = validateRecipe({ ...baseReactive, trigger_steps: [step as never] }).issues
      .find((i) => i.code === 'watcher_retired');
    expect(issue).toMatchObject({ severity: 'error', path: 'trigger_steps[0]' });
    expect(issue!.message).toContain(`'${named}' was retired on 2026-10-05`);
    expect(issue!.message).toContain(instead);
  });

  it('the watchers that stay are not refused', () => {
    for (const op of ['core.watch.time', 'core.watch.time-relative', 'core.watch.http']) {
      const result = validateRecipe({ ...baseReactive, trigger_steps: [{ id: 'gate', op, args: {} } as never] });
      expect(codesOf(result)).not.toContain('watcher_retired');
    }
  });
});

describe('trigger_steps per-step shape', () => {
  it('non-object trigger step → trigger_step_shape', () => {
    const recipe = {
      ...baseReactive,
      trigger_steps: ['http-watcher' as unknown as never],
    };
    expect(codesOf(validateRecipe(recipe))).toContain('trigger_step_shape');
  });

  it('missing id on trigger step → trigger_step_id_required', () => {
    const recipe = {
      ...baseReactive,
      trigger_steps: [{ ingredient: 'http-watcher' } as unknown as never],
    };
    expect(codesOf(validateRecipe(recipe))).toContain('trigger_step_id_required');
  });

  it('no discriminator on trigger step → trigger_step_no_discriminator', () => {
    const recipe = {
      ...baseReactive,
      trigger_steps: [{ id: 'orphan' } as unknown as never],
    };
    expect(codesOf(validateRecipe(recipe))).toContain('trigger_step_no_discriminator');
  });

  it('multiple discriminators on trigger step → trigger_step_multi_discriminator', () => {
    const recipe = {
      ...baseReactive,
      trigger_steps: [{
        id: 'confused',
        transform: 'concat',
        ingredient: 'http-watcher',
      } as unknown as never],
    };
    expect(codesOf(validateRecipe(recipe))).toContain('trigger_step_multi_discriminator');
  });

  it('duplicate trigger step id collides with sequential step id', () => {
    // step.X and trigger.X share the id namespace for unambiguity —
    // a recipe with both can never be referenced cleanly.
    const recipe: RecipeDefinition = {
      ...baseReactive,
      trigger_steps: [{ id: 'noop', ingredient: 'http-watcher' }],
    };
    expect(codesOf(validateRecipe(recipe))).toContain('step_id_duplicate');
  });

  it('reserved id "trigger" on a step → step_id_reserved', () => {
    const recipe: RecipeDefinition = {
      ...baseReactive,
      steps: [
        ...baseReactive.steps,
        { id: 'trigger', transform: 'concat', values: ['x'] } as never,
      ],
    };
    expect(codesOf(validateRecipe(recipe))).toContain('step_id_reserved');
  });
});

// ────────────────────────────────────────────────────────────────
// {{trigger.*}} namespace recognition
// ────────────────────────────────────────────────────────────────

describe('{{trigger.*}} namespace', () => {
  it('refs to {{trigger.X.field}} are accepted (no unknown_namespace error)', () => {
    const recipe: RecipeDefinition = {
      ...baseReactive,
      steps: [
        {
          id: 'noop',
          transform: 'concat',
          values: ['{{trigger.mail.items}}'],
        } as never,
      ],
    };
    expect(codesOf(validateRecipe(recipe))).not.toContain('unknown_namespace');
  });
});

// D-124 Phase 1.3 — `{{context.event.payload.prev.*}}` is the wire
// shape recipes target on `updated` / `deleted` triggers. The
// validator inherited acceptance from the open `context.*` namespace,
// but the spec calls for explicit coverage so any future tightening
// of the namespace doesn't silently reject the new shape.
describe('{{context.event.payload.prev.*}} namespace (D-124)', () => {
  it('refs to context.event.payload.prev.<field> are accepted', () => {
    const recipe: RecipeDefinition = {
      ...baseReactive,
      steps: [
        {
          id: 'diff',
          transform: 'concat',
          values: [
            '{{context.event.payload.prev.start_at}}',
            '{{context.event.payload.prev.summary}}',
          ],
        } as never,
      ],
    };
    const issues = codesOf(validateRecipe(recipe));
    expect(issues).not.toContain('unknown_namespace');
    expect(issues).not.toContain('unknown_path');
  });

  it('refs to other context.event.payload fields stay accepted alongside prev', () => {
    const recipe: RecipeDefinition = {
      ...baseReactive,
      steps: [
        {
          id: 'diff',
          transform: 'concat',
          values: [
            '{{context.event.payload.record_id}}',
            '{{context.event.payload.prev.start_at}}',
            '{{context.event.kind}}',
          ],
        } as never,
      ],
    };
    expect(codesOf(validateRecipe(recipe))).not.toContain('unknown_namespace');
  });
});
