/** D-320 phase 3 (ruling 18) — `metadata.retired_connections`: an old connection
 *  setting's name, and the slot whose connection it named. The validator's half;
 *  the run's is `backend/server/src/__tests__/d-320-retired-connections.test.ts`. */

import { describe, expect, it } from 'vitest';
import { retiredConnectionsOf } from '@recued/contracts';

import { validateRecipe } from '../validate.js';

const recipe = (metadata: Record<string, unknown>, variables: Record<string, unknown> = {}): Record<string, unknown> => ({
  recipe_id: 'read-the-deal',
  version: 2,
  metadata: { name: 'Read the deal', description: 'One HubSpot read.', author: 'recued-core', tags: [], ...metadata },
  variables,
  prefetch_steps: [],
  steps: [{ id: 'deal', op: 'recued-core.hubspot.deal.read', args: { deal_id: '9001' } }],
  output: { render: [] },
});

/** Only this rule's issues: the rest of the recipe is not what is under test. */
const issues = (r: Record<string, unknown>) =>
  validateRecipe(r).issues
    .filter((issue) => issue.code.startsWith('retired_connection'))
    .map((issue) => [issue.code, issue.path]);

describe('D-320 ruling 18 — retired_connections', () => {
  it('maps an old setting name to the slot it named', () => {
    expect(issues(recipe({ retired_connections: { crm: 'hubspot', sec_www: 'sec_edgar_www' } }))).toEqual([]);
    expect(issues(recipe({}))).toEqual([]);
  });

  it.each<[string, unknown, Record<string, unknown>, Array<[string, string]>]>([
    ['not a map', ['crm'], {}, [['retired_connections_shape', 'metadata.retired_connections']]],
    ['a name no setting could have', { 'old-crm': 'hubspot' }, {}, [['retired_connections_shape', 'metadata.retired_connections.old-crm']]],
    ['an empty slot', { crm: ' ' }, {}, [['retired_connections_shape', 'metadata.retired_connections.crm']]],
    ['⛔ a name still declared: a run would read its value twice', { crm: 'hubspot' },
      { crm: { label: 'CRM', type: 'string' } }, [['retired_connection_declared', 'metadata.retired_connections.crm']]],
  ])('refuses %s', (_name, map, variables, expected) => {
    expect(issues(recipe({ retired_connections: map }, variables))).toEqual(expected);
  });

  it('is read back with only its well-formed entries', () => {
    expect(retiredConnectionsOf({ metadata: { retired_connections: { crm: 'hubspot', 'bad-name': 'x', wolfram: '' } } }))
      .toEqual({ crm: 'hubspot' });
    expect(retiredConnectionsOf({ metadata: { retired_connections: ['crm'] } })).toEqual({});
    expect(retiredConnectionsOf({})).toEqual({});
  });
});
