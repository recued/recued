import { describe, expect, it } from 'vitest';
import type { RecipeDefinition } from '@recued/contracts';

import { recipeRequiredConnections } from '../recipes/required-connections.js';

const recipe = (partial: Partial<RecipeDefinition>): RecipeDefinition =>
  ({
    recipe_id: 'r',
    version: 1,
    ttl: 60,
    metadata: { name: 'R' },
    variables: {},
    prefetch_steps: [],
    steps: [],
    output: { sidebar: [] },
    ...partial,
  }) as RecipeDefinition;

const steps = (input: Record<string, unknown>): RecipeDefinition['steps'] =>
  [{ id: 's', ingredient: 'x', input }] as unknown as RecipeDefinition['steps'];

describe('recipeRequiredConnections', () => {
  it('returns [] when the recipe references no connection', () => {
    expect(recipeRequiredConnections(recipe({}))).toEqual([]);
  });

  it('extracts kind + name from a connection.* ref in a step', () => {
    const r = recipe({
      steps: steps({ to: '{{connection.notification.slack.channel_id}}' }),
    });
    expect(recipeRequiredConnections(r)).toEqual([
      { kind: 'notification', name: 'slack' },
    ]);
  });

  it('captures a read_connection_* permission as kind-null', () => {
    expect(
      recipeRequiredConnections(
        recipe({ requires: ['write_enrichment', 'read_connection_acme'] }),
      ),
    ).toEqual([{ kind: null, name: 'acme' }]);
  });

  it('upgrades a permission-only entry when a ref supplies the kind', () => {
    const r = recipe({
      requires: ['read_connection_hubspot'],
      steps: steps({ url: '{{connection.api.hubspot.base_url}}' }),
    });
    expect(recipeRequiredConnections(r)).toEqual([
      { kind: 'api', name: 'hubspot' },
    ]);
  });

  it('sorts by name and dedups multiple refs to one connection', () => {
    const r = recipe({
      steps: steps({
        u: '{{connection.api.zeta.base_url}}',
        v: '{{connection.api.zeta.token}}',
        w: '{{connection.mcp.alpha.endpoint}}',
      }),
    });
    expect(recipeRequiredConnections(r)).toEqual([
      { kind: 'mcp', name: 'alpha' },
      { kind: 'api', name: 'zeta' },
    ]);
  });

  it('keeps same-name connections of different kinds distinct (kind+name key)', () => {
    const r = recipe({
      steps: steps({
        a: '{{connection.api.default.base_url}}',
        b: '{{connection.mcp.default.endpoint}}',
      }),
    });
    // (kind, name) is the storage key — `api/default` and `mcp/default`
    // are two separate connections, so both must surface.
    expect(recipeRequiredConnections(r)).toEqual([
      { kind: 'api', name: 'default' },
      { kind: 'mcp', name: 'default' },
    ]);
  });

  it('ignores non-connection namespaces and malformed connection refs', () => {
    const r = recipe({
      steps: steps({
        a: '{{config.foo}}',
        b: '{{data.mail.x}}',
        c: '{{connection.api}}',
      }),
    });
    expect(recipeRequiredConnections(r)).toEqual([]);
  });
});
