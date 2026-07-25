import { describe, expect, it } from 'vitest';
import { validateRecipe } from '../validate.js';

const baseRecipe = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  recipe_id: 'd-153-agent-watcher-retirement',
  version: 1,
  ttl: 60,
  metadata: {
    name: 'D-153 agent watcher retirement',
    author: 'recued-core',
    description: 'Pins the retired agent watcher validator end-state for leftover recipes.',
    supported_platforms: [],
    tags: ['agent', 'watcher', 'retirement'],
  },
  variables: {},
  prefetch_steps: [],
  steps: [{ id: 'noop', transform: 'concat', values: ['ok'] }],
  output: { sidebar: [{ type: 'summary', source: 'step.noop' }] },
  ...overrides,
});

describe('D-153 P10 — agent-watcher retirement', () => {
  it('silently ignores a retired top-level agent_watcher field', () => {
    const result = validateRecipe(baseRecipe({ agent_watcher: true }));

    expect(result.valid).toBe(true);
  });

  it('warns on retired agent_watcher_install requires slug', () => {
    const result = validateRecipe(baseRecipe({ requires: ['agent_watcher_install'] }));
    const warning = result.issues.find((issue) => issue.code === 'requires_unknown');

    expect(result.valid).toBe(true);
    expect(warning).toMatchObject({
      severity: 'warn',
      path: 'requires[0]',
    });
    expect(warning?.message).toContain('agent_watcher_install');
  });
});
