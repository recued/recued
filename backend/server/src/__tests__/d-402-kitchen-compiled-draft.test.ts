/** D-402 slice A3 — a draft Recued compiled is Recued's: kept under its own origin with its notes and
 *  what it was made from, listed for the owner by where it came from, and out of every AI app's reach,
 *  so an app cannot change a draft before the owner reviews it (D-402 §3.3). */
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { kitchenCompiledOrigin, KITCHEN_DRAFT_MAX_NOTES, KITCHEN_OWNER_ORIGIN, type ExecutionSource } from '@recued/contracts';
import { createKitchenDraftStore, describeKitchenDraftOrigin } from '../kitchen-draft-store.js';
import { createKitchenDraftAccess } from '../kitchen-draft-service.js';

const databases: Database.Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
const open = () => { const db = new Database(':memory:'); databases.push(db); return db; };
const recipe = readFileSync(new URL('../../../../community/recipes/send-composed-mail.json', import.meta.url), 'utf8');
const fromChat = { kind: 'chat_request' as const, session_id: 'chat-1', turn_id: 'turn-1' };
const fromJob = { kind: 'ai_app_job' as const, job_id: 'job-1' };
const app: ExecutionSource = { channel: 'mcp', actor: 'contracted_user', agent_id: 'editor',
  tool_call_id: 'call', mcp_token_id: 'token-a', contract_id: 'contract-a' };

describe('D-402 slice A3 — a compiled draft is Recued\'s', () => {
  it('keeps its notes and what it was made from, and the owner sees both and where it came from', () => {
    const store = createKitchenDraftStore(open());
    const notes = ['Step 2 has no selector: fill it in.', 'Asked for at each run: the search'];
    const made = store.createCompiled({ origin: kitchenCompiledOrigin(fromChat), kind: 'recipe', source: recipe, notes,
      made_from: fromChat });
    expect(made).toMatchObject({ kind: 'recipe', revision: 1, notes, made_from: fromChat, validation: { valid: true } });
    expect(store.get(made.draft_id)).toMatchObject({ notes, made_from: fromChat });
    expect(store.listAll().find((item) => item.draft_id === made.draft_id)).toMatchObject({ from: 'your chat' });
    // The owner's own edit keeps them.
    const edited = store.update(made.draft_id, 1, recipe, undefined);
    expect(edited).toMatchObject({ revision: 2, notes, made_from: fromChat });
  });

  it('names an AI app\'s job by its key\'s label', () => {
    expect(describeKitchenDraftOrigin(kitchenCompiledOrigin(fromJob, 'token-a'), (token) => (token === 'token-a' ? 'Claude Desktop' : undefined)))
      .toBe('Claude Desktop');
    expect(describeKitchenDraftOrigin(kitchenCompiledOrigin(fromJob, 'token-z'))).toBe('an AI app');
  });

  it('is out of the AI app\'s reach: not listed, read or changed through its own Kitchen calls', async () => {
    const store = createKitchenDraftStore(open());
    const made = store.createCompiled({ origin: kitchenCompiledOrigin(fromJob, 'token-a'), kind: 'recipe', source: recipe,
      notes: [], made_from: fromJob });
    const access = createKitchenDraftAccess({ store, gate: { isOpGranted: () => true, isFrozenByPause: () => false } });
    const meta = { execution_source: app, step_id: 'kitchen', recipe_id: 'kitchen' } as never;
    expect(await access('list', {}, meta)).toEqual({ drafts: [] });
    await expect(access('get', { draft_id: made.draft_id }, meta)).rejects.toMatchObject({ code: 'not_found' });
    await expect(access('update', { draft_id: made.draft_id, expected_revision: 1, source: '{}' }, meta))
      .rejects.toMatchObject({ code: 'not_found' });
    expect(store.get(made.draft_id)).toMatchObject({ revision: 1, source: recipe });
  });

  it('refuses an origin that is not Recued\'s, and notes past their bound', () => {
    const store = createKitchenDraftStore(open());
    expect(() => store.createCompiled({ origin: KITCHEN_OWNER_ORIGIN, kind: 'recipe', source: recipe, notes: [],
      made_from: fromChat })).toThrow(/Only Recued/);
    expect(() => store.createCompiled({ origin: kitchenCompiledOrigin(fromChat), kind: 'recipe', source: recipe,
      notes: Array.from({ length: KITCHEN_DRAFT_MAX_NOTES + 1 }, () => 'note'), made_from: fromChat })).toThrow(/at most/);
  });

  it('adds its columns to a table written before them, whose drafts read as before', () => {
    const db = open();
    db.exec(`CREATE TABLE kitchen_import_draft (
      draft_id TEXT PRIMARY KEY, origin TEXT NOT NULL, request_id TEXT NOT NULL,
      request_hash TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL,
      source TEXT NOT NULL, source_hash TEXT NOT NULL, revision INTEGER NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, receipt_json TEXT NOT NULL,
      UNIQUE(origin, request_id))`);
    db.prepare(`INSERT INTO kitchen_import_draft VALUES ('old', 'kitchen', 'r', 'h', 'recipe', 'Old', ?, 's', 1, 1, 1, '{}')`).run(recipe);
    const store = createKitchenDraftStore(db);
    const old = store.get('old');
    expect(old).toMatchObject({ draft_id: 'old', revision: 1 });
    expect(old).not.toHaveProperty('notes');
    expect(old).not.toHaveProperty('made_from');
    const made = store.createCompiled({ origin: kitchenCompiledOrigin(fromChat), kind: 'recipe', source: recipe,
      notes: ['n'], made_from: fromChat });
    expect(store.get(made.draft_id)).toMatchObject({ notes: ['n'] });
  });
});

describe('D-402 slice E4c — a compiled draft that is changes to a saved recipe', () => {
  it('keeps its base, is that recipe\'s one item of changes, and refuses a second of any origin', () => {
    const store = createKitchenDraftStore(open());
    const base = { recipe_id: 'buy-lamp', version: 3 };
    const made = store.createCompiled({ origin: kitchenCompiledOrigin(fromChat), kind: 'recipe', source: recipe, notes: ['A way added.'],
      made_from: fromChat, base });
    expect(made).toMatchObject({ base, notes: ['A way added.'], made_from: fromChat });
    expect(store.listAll().find((item) => item.draft_id === made.draft_id)).toMatchObject({ base, from: 'your chat' });
    // A second from the chat, or the owner's own edit, would leave two items for one recipe.
    expect(() => store.createCompiled({ origin: kitchenCompiledOrigin(fromChat), kind: 'recipe', source: recipe, notes: [],
      made_from: fromChat, base })).toThrow(/already in progress/u);
    expect(() => store.create('recipe', recipe, base)).toThrow(/already in progress/u);
    // Another recipe is its own item; a pack keeps no changes to a saved recipe.
    expect(store.createCompiled({ origin: kitchenCompiledOrigin(fromChat), kind: 'recipe', source: recipe, notes: [],
      made_from: fromChat, base: { recipe_id: 'other', version: 1 } })).toMatchObject({ base: { recipe_id: 'other' } });
    expect(() => store.createCompiled({ origin: kitchenCompiledOrigin(fromChat), kind: 'pack', source: recipe, notes: [],
      made_from: fromChat, base: { recipe_id: 'pack-base', version: 1 } })).toThrow(/Only a recipe keeps changes/u);
    // Discarded, the recipe takes changes again.
    store.discard(made.draft_id, made.revision);
    expect(store.create('recipe', recipe, base)).toMatchObject({ base });
  });
});
