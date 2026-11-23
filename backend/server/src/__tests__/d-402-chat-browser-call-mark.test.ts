/** D-402 slice A4 — a call of the owner's chat that ran a recipe acting in a web page is marked on
 *  its answer (`ChatToolCall.browser`), so the answer offers "Make a recipe": a browser recipe's own
 *  tool, `recipe.run` naming one or carrying one inline. Through the real orchestrator and chat store. */

import { readFileSync } from 'node:fs';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import type { InternalToolRegistry, RecipeDefinition, ToolEntry } from '@recued/contracts';

import { createChatOrchestrator } from '../chat-orchestrator.js';
import { createRecipeStore } from '../recipe-store.js';
import { recipeToolActsInBrowser } from '../recipe-tool-name.js';
import { createChatStore, ensureChatSchema } from '../storage/chat-store.js';

const signature = { server_kind: 'recued' as const, version: '1', instance_id: 'test' };
const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); });

const entry = (name: string, tier: 1 | 2, classification: ToolEntry['classification']): ToolEntry =>
  ({ name, tier, description: name, arg_schema: { type: 'object' }, topic_tags: [], classification, concurrency_safe: false });
const ENTRIES = [
  entry('recued-core/inspect-web-page', 2, 'read'),
  entry('recued-core/weekly-digest', 2, 'unknown'),
  entry('recipe.run', 1, 'unknown'),
  entry('recipe.schedule', 1, 'unknown'),
  entry('mail.search', 1, 'read'),
];
const CALLS = [
  { tool: 'recued-core/inspect-web-page', args: { page: 'bridge:work:7:D1' } },
  { tool: 'recued-core/weekly-digest', args: {} },
  { tool: 'recipe.run', args: { recipe_id: 'recued-core/inspect-web-page' } },
  { tool: 'recipe.run', args: { recipe: { steps: [{ id: 'act', op: 'core.dom.act', inputs: {} }] } } },
  { tool: 'recipe.run', args: { recipe: { steps: [{ id: 'sum', transform: 'sum', inputs: {} }] } } },
  // Scheduling one runs nothing now.
  { tool: 'recipe.schedule', args: { recipe_id: 'recued-core/inspect-web-page', mode: 'one_shot', run_at: '2026-11-18T09:00:00+00:00' } },
  { tool: 'mail.search', args: { query: 'rent' } },
];
const MARKED = [true, undefined, true, true, undefined, undefined, undefined];

const recipes = createRecipeStore('/nonexistent');
const recipe = (recipe_id: string, steps: unknown[]): RecipeDefinition => ({
  recipe_id, version: 1, ttl: 60,
  metadata: { name: recipe_id, description: 'A recipe.', author: 'recued-core', supported_platforms: [] },
  variables: {}, prefetch_steps: [], steps, output: { render: [] },
} as unknown as RecipeDefinition);
recipes.register(recipe('inspect-web-page', [{ id: 'read', op: 'core.dom.inspect', inputs: {} }]));
recipes.register(recipe('weekly-digest', [{ id: 'sum', transform: 'sum', inputs: {} }]));
const actsInBrowser = (recipe_ref: string) => recipeToolActsInBrowser(recipes, recipe_ref);

const turn = async (recipeActsInBrowser?: (recipe_ref: string) => boolean) => {
  const db = new Database(':memory:');
  cleanup.push(() => db.close());
  ensureChatSchema(db);
  const store = createChatStore(db);
  store.createSession({ id: 'session', now: 1_000 });
  const registry: InternalToolRegistry = {
    list: () => ENTRIES, listByTier: tier => ENTRIES.filter(e => e.tier === tier),
    getByName: name => ENTRIES.find(e => e.name === name) ?? null,
    subscribeRefresh: () => () => {}, dispatch: async () => ({ ok: true, result: { done: true } }),
  };
  let rounds = 0;
  const app = createChatOrchestrator({
    chatStore: store, registry, selfSignature: signature,
    broadcast: { emit: () => {} },
    ...(recipeActsInBrowser !== undefined ? { recipeActsInBrowser } : {}),
    executeAiCall: async () => ++rounds === 1
      ? { body: { response: '', events: [], tool_calls: CALLS } }
      : { body: { response: 'Done.', events: [], tool_calls: [] } },
  });
  await app.runTurn({ session_id: 'session', message: 'Read the orders page', picker_state: { current: 'self' } });
  const messages = await store.listMessages('session');
  return messages.find(message => message.role === 'assistant')?.tool_calls ?? [];
};

describe('D-402 slice A4 — an answer marks the calls that worked in a web page', () => {
  it('marks a browser recipe\'s own tool, and recipe.run naming one or carrying one inline', async () => {
    const kept = await turn(actsInBrowser);
    expect(kept.map(call => call.tool_name)).toEqual(CALLS.map(call => call.tool));
    expect(kept.map(call => call.browser)).toEqual(MARKED);
  });

  it('a chat with no lookup wired marks none, as before', async () => {
    for (const call of await turn()) expect(call).not.toHaveProperty('browser');
  });

  it('the server composes the owner\'s chat with it, over its own recipe store', () => {
    const source = readFileSync(new URL('../composition/bin/wire-chat-orchestrator.ts', import.meta.url), 'utf8');
    expect(source).toContain('recipeActsInBrowser: (recipe_ref) => recipeToolActsInBrowser(recipeStore, recipe_ref)');
  });
});
