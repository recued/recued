/** A call that names an installed recipe is named by the recipe's name, from the call's start: its
 *  line read the tool's name ("used recued-core/control-device ✓", owner, 2026-11-13). The chat
 *  sends the name with the call's start, keeps it with the call, and keeps it on the call's record
 *  (Live control lists the call by it), through the real orchestrator and chat store. */

import { readFileSync } from 'node:fs';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import type { InternalToolRegistry, RecipeDefinition, ServerEvent, ToolEntry } from '@recued/contracts';

import { createChatOrchestrator } from '../chat-orchestrator.js';
import { createRecipeStore } from '../recipe-store.js';
import { recipeToolTitle } from '../recipe-tool-name.js';
import { createChatStore, ensureChatSchema } from '../storage/chat-store.js';

const signature = { server_kind: 'recued' as const, version: '1', instance_id: 'test' };
const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); });

const entry = (name: string, tier: 1 | 2, classification: ToolEntry['classification']): ToolEntry =>
  ({ name, tier, description: name, arg_schema: { type: 'object' }, topic_tags: [], classification, concurrency_safe: false });
const ENTRIES = [
  entry('recued-core/weekly-digest', 2, 'unknown'),
  entry('recipe.run', 1, 'unknown'),
  entry('mail.search', 1, 'read'),
  entry('recipe.schedule', 1, 'unknown'),
  entry('recipe.stop', 1, 'unknown'),
];
const CALLS = [
  { tool: 'recued-core/weekly-digest', args: {} },
  { tool: 'recipe.run', args: { recipe_id: 'recued-core/weekly-digest' } },
  // An inline recipe's name is the model's own.
  { tool: 'recipe.run', args: { recipe: { metadata: { name: 'Written by the model' } } } },
  { tool: 'mail.search', args: { query: 'rent' } },
  { tool: 'recipe.schedule', args: { recipe_id: 'recued-core/weekly-digest', mode: 'one_shot', run_at: '2026-11-14T09:00:00+00:00' } },
  { tool: 'recipe.stop', args: { recipe_id: 'recued-core/weekly-digest' } },
  // A stop by run names no recipe (`calledRecipeTitle`); the request gives the run id.
  { tool: 'recipe.stop', args: { run_id: 'run_1' } },
];

const turn = async (recipeTitle?: (recipe_ref: string) => string | undefined) => {
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
  const events: ServerEvent[] = [];
  let rounds = 0;
  const app = createChatOrchestrator({
    chatStore: store, registry, selfSignature: signature,
    broadcast: { emit: (event) => { events.push(event as ServerEvent); } },
    ...(recipeTitle !== undefined ? { recipeTitle } : {}),
    executeAiCall: async () => ++rounds === 1
      ? { body: { response: '', events: [], tool_calls: CALLS } }
      : { body: { response: 'Done.', events: [], tool_calls: [] } },
  });
  await app.runTurn({ session_id: 'session', message: 'Send the weekly digest, and stop run_1', picker_state: { current: 'self' } });
  const started = events.flatMap(event => event.kind === 'chat.tool_call_started' ? [event] : []);
  const messages = await store.listMessages('session');
  const answer = messages.find(message => message.role === 'assistant');
  const records = messages.flatMap(message => message.role === 'tool' && message.tool_call !== undefined
    && message.tool_call.message_id === message.id ? [message.tool_call] : []);
  return { started, kept: answer?.tool_calls ?? [], records };
};

const recipes = createRecipeStore('/nonexistent');
recipes.register({
  recipe_id: 'weekly-digest', version: 1, ttl: 60,
  metadata: { name: 'Weekly digest', description: 'A recipe.', author: 'recued-core', supported_platforms: [] },
  variables: {}, prefetch_steps: [], steps: [], output: { render: [] },
} as unknown as RecipeDefinition);
const titled = (recipe_ref: string) => recipeToolTitle(recipes, recipe_ref);
const NAMED = ['Weekly digest', 'Weekly digest', undefined, undefined, 'Weekly digest', 'Weekly digest', undefined];

describe('a call that names an installed recipe, by the recipe\'s name', () => {
  it('its start says the name, the answer keeps it with the call, and so does its record', async () => {
    const { started, kept, records } = await turn(titled);
    expect(started.map(event => event.tool_name)).toEqual(CALLS.map(call => call.tool));
    expect(started.map(event => event.recipe_name)).toEqual(NAMED);
    expect(kept.map(call => call.tool_name)).toEqual(CALLS.map(call => call.tool));
    expect(kept.map(call => call.recipe_name)).toEqual(NAMED);
    expect(records.map(record => record.tool_name)).toEqual(CALLS.map(call => call.tool));
    expect(records.map(record => record.recipe_name)).toEqual(NAMED);
  });

  it('a server with no recipe lookup names none, as before', async () => {
    const { started, kept, records } = await turn();
    expect(started).toHaveLength(CALLS.length);
    expect(records).toHaveLength(CALLS.length);
    for (const call of [...started, ...kept, ...records]) expect(call).not.toHaveProperty('recipe_name');
  });

  it('the server composes the chat with it, over its own recipe store', () => {
    const source = readFileSync(new URL('../composition/bin/wire-chat-orchestrator.ts', import.meta.url), 'utf8');
    expect(source).toContain('recipeTitle: (recipe_ref) => recipeToolTitle(recipeStore, recipe_ref)');
  });
});
