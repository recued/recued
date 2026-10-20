import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { RecipeDefinition, RecipeRegressionSuite, RecipeRegressionSave } from '@recued/contracts';
import { createRecipeRegressionStore } from '../storage/recipe-regression-store.js';
import { createPreapprovalCodec } from '../storage/preapproval-codec.js';
import { createClientTokenStore } from '../pairing/client-tokens.js';
export const regressionRecipe = (): RecipeDefinition => ({ recipe_id: 'regression-test',version: 1,ttl: 0,
  metadata: { name: 'Regression',description: 'Fixture comparisons.',author: 'owner',supported_platforms: [] },variables: { rows: null },
  prefetch_steps: [],steps: [{ id: 'count',transform: 'count',input: '{{config.rows}}' }],output: { render: [] } });
export const regressionSuite = (): RecipeRegressionSuite => ({ title: 'Private test suite',baseline: regressionRecipe(),cases: [
  { id: 'empty',name: 'Empty rows',sample: { config: { rows: [] } },assertions: [
    { kind: 'run_status',expected: 'passed' },{ kind: 'value',phase: 'sequential',step_id: 'count',field: 'output',path: [],expected: 0 },
  ] },
] });
export const regressionRequest = (expected_revision = 0): RecipeRegressionSave => ({ recipe_id: 'regression-test',
  expected_revision,request_id: randomUUID(),suite: regressionSuite() });
export const regressionFixture = (filename = ':memory:') => {
  const db = new Database(filename), state = { locked: false }, codec = createPreapprovalCodec(() => state.locked ? null : new Uint8Array(32).fill(7));
  const clients = createClientTokenStore(db,{ argon2_params: { t: 1,m: 8,p: 1 } });
  const store = createRecipeRegressionStore(db,codec);
  return { db,state,codec,clients,store,close: () => { if (db.open) db.close(); } };
};
