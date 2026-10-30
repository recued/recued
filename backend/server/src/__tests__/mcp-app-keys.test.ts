/** The contract key `recued --mcp` runs under when the app that starts it
 *  cannot pass one (`mcp-app-keys.ts`).
 *
 *  ⛔ The case this exists for: an app that loads Recued as a plugin starts the
 *  server with an environment of its own — Codex passes PLUGIN_DATA and a few
 *  basics, never RECUED_MCP_TOKEN — so the only key such an app can have is one
 *  the owner saved with `recued mcp-key set`, for it or for every app. */

import { homedir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import {
  EVERY_APP,
  createMcpAppKeyStore,
  displayMcpAppName,
  mcpAppNameProblem,
  mcpAppOfStart,
  normalizeMcpAppName,
  resolveStdioMcpKey,
} from '../mcp-app-keys.js';
import { createChatInboundTokenStore, ensureChatInboundTokenSchema } from '../storage/chat-inbound-token-store.js';

const CODEX = '/Users/ann/.codex/plugins/data/agent-plugins/06f2ff51';
const CURSOR = '/Users/ann/.cursor/plugins/data/recued';

const realm = () => {
  const db = new Database(':memory:');
  ensureChatInboundTokenSchema(db);
  const tokens = createChatInboundTokenStore(db);
  const appKeys = createMcpAppKeyStore(db);
  const issue = (label: string, bearer: string) => tokens.issueToken({
    value: { label, grants: { recued_listRecipes: true }, concurrency_tier: 3, chat_mode: null },
    now: 1,
    bearer_plaintext: bearer,
  }).record;
  const start = (env: NodeJS.ProcessEnv, args: string[] = ['--mcp'], now = 100) =>
    resolveStdioMcpKey({ args, env, now, tokens, appKeys });
  return { db, tokens, appKeys, issue, start };
};

describe('which key an app runs under', () => {
  it('⛔ an app with its own key gets it, and an app without one gets the key for every app', () => {
    const r = realm();
    const codex = r.issue('Codex', 'recued_codex_key');
    const personal = r.issue('Personal', 'recued_personal_key');
    r.appKeys.save(CODEX, codex.token_id, 10);
    r.appKeys.save(EVERY_APP, personal.token_id, 10);

    expect(r.start({ PLUGIN_DATA: CODEX })).toEqual({ record: expect.objectContaining({ label: 'Codex' }), notice: null });
    expect(r.start({ PLUGIN_DATA: CURSOR }).record?.label).toBe('Personal');
    // An app that names itself nowhere still gets the key for every app.
    expect(r.start({}).record?.label).toBe('Personal');
  });

  it('⛔ with no key anywhere it gets nothing, and is told how to save one', () => {
    const r = realm();
    const { record, notice } = r.start({ PLUGIN_DATA: CODEX });
    expect(record).toBeNull();
    expect(notice).toContain('no contract key is saved for this app');
    expect(notice).toContain(CODEX);
    expect(notice).toContain('recued mcp-key set');
    expect(notice).toContain('RECUED_MCP_TOKEN');
    expect(r.start({}).notice).toContain('no contract key was given');
  });

  it('a key the start was given wins over a saved one', () => {
    const r = realm();
    r.issue('Given', 'recued_given_key');
    const saved = r.issue('Saved', 'recued_saved_key');
    r.appKeys.save(CODEX, saved.token_id, 10);
    expect(r.start({ PLUGIN_DATA: CODEX, RECUED_MCP_TOKEN: 'recued_given_key' }).record?.label).toBe('Given');
    expect(r.start({ PLUGIN_DATA: CODEX }, ['--mcp', '--token', 'recued_given_key']).record?.label).toBe('Given');
  });

  it('⛔ a wrong key the start was given is refused, not swapped for a saved one', () => {
    const r = realm();
    const saved = r.issue('Saved', 'recued_saved_key');
    r.appKeys.save(EVERY_APP, saved.token_id, 10);
    const { record, notice } = r.start({ RECUED_MCP_TOKEN: 'recued_typo' });
    expect(record).toBeNull();
    expect(notice).toContain('was not recognised');
  });

  it('⛔ a revoked saved key says so, and the key for every app does not stand in for it', () => {
    const r = realm();
    const codex = r.issue('Codex', 'recued_codex_key');
    const personal = r.issue('Personal', 'recued_personal_key');
    r.appKeys.save(CODEX, codex.token_id, 10);
    r.appKeys.save(EVERY_APP, personal.token_id, 10);
    r.tokens.revokeToken({ token_id: codex.token_id, now: 50 });

    const { record, notice } = r.start({ PLUGIN_DATA: CODEX });
    // Returned so the server's own per-call check refuses it, never Personal.
    expect(record?.label).toBe('Codex');
    expect(notice).toContain('the contract key saved for this app was revoked');
  });

  it('a saved key that is gone from the server says so', () => {
    const r = realm();
    const codex = r.issue('Codex', 'recued_codex_key');
    r.appKeys.save(EVERY_APP, codex.token_id, 10);
    r.tokens.deleteToken(codex.token_id);
    const { record, notice } = r.start({ PLUGIN_DATA: CODEX });
    expect(record).toBeNull();
    expect(notice).toContain('the contract key saved for every app is no longer on this server');
  });

  it('a placeholder the app did not fill in names no app, and says it was ignored', () => {
    const r = realm();
    const personal = r.issue('Personal', 'recued_personal_key');
    r.appKeys.save(EVERY_APP, personal.token_id, 10);
    const { record, notice } = r.start({}, ['--mcp', '--app', '${PLUGIN_DATA}']);
    expect(record?.label).toBe('Personal');
    expect(notice).toBe('[recued mcp] ignored --app is a placeholder the app did not fill in.');
    expect(r.appKeys.list().map((row) => row.app)).toEqual([EVERY_APP]);
  });
});

describe('the apps Recued has seen', () => {
  it('records each start, and a start never touches a saved key', () => {
    const r = realm();
    const codex = r.issue('Codex', 'recued_codex_key');
    r.appKeys.save(CODEX, codex.token_id, 10);
    r.start({ PLUGIN_DATA: CODEX }, ['--mcp'], 200);
    r.start({}, ['--mcp', '--app', 'claude-code'], 300);
    // `--app` beats PLUGIN_DATA.
    r.start({ PLUGIN_DATA: CURSOR }, ['--mcp', '--app', 'claude-code'], 400);

    expect(r.appKeys.list()).toEqual([
      { app: 'claude-code', token_id: null, saved_at: null, last_started_at: 400 },
      { app: CODEX, token_id: codex.token_id, saved_at: 10, last_started_at: 200 },
    ]);
  });

  it('lists the key for every app first, and removes a row with its key', () => {
    const r = realm();
    const codex = r.issue('Codex', 'recued_codex_key');
    r.start({ PLUGIN_DATA: CODEX });
    r.appKeys.save(EVERY_APP, codex.token_id, 20);
    expect(r.appKeys.list()[0]?.app).toBe(EVERY_APP);

    expect(r.appKeys.remove(CODEX)).toBe(true);
    expect(r.appKeys.remove(CODEX)).toBe(false);
    expect(r.appKeys.keyFor(CODEX)).toEqual({ token_id: codex.token_id, for: 'every_app' });
    expect(r.appKeys.remove(EVERY_APP)).toBe(true);
    expect(r.appKeys.keyFor(CODEX)).toBeNull();
  });

  it('a start still gets its key when the database refuses the note', () => {
    const r = realm();
    const personal = r.issue('Personal', 'recued_personal_key');
    r.appKeys.save(EVERY_APP, personal.token_id, 10);
    const refusing = { ...r.appKeys, noteStarted: () => { throw new Error('SQLITE_BUSY'); } };
    expect(resolveStdioMcpKey({
      args: ['--mcp'], env: { PLUGIN_DATA: CODEX }, now: 1, tokens: r.tokens, appKeys: refusing,
    }).record?.label).toBe('Personal');
  });
});

describe('naming an app', () => {
  it('spells a folder one way, so a name copied from the list reaches the same app', () => {
    const home = homedir();
    const folder = join(home, '.codex', 'plugins', 'data', 'x');
    expect(displayMcpAppName(folder)).toBe(join('~', '.codex', 'plugins', 'data', 'x'));
    expect(normalizeMcpAppName(displayMcpAppName(folder))).toBe(folder);
    expect(normalizeMcpAppName(`${folder}/`)).toBe(folder);
    expect(normalizeMcpAppName('  claude-code ')).toBe('claude-code');
    expect(mcpAppOfStart([], { PLUGIN_DATA: `${folder}/` })).toEqual({ app: folder, problem: null });
    expect(mcpAppOfStart([], { PLUGIN_DATA: '  ' })).toEqual({ app: null, problem: null });
  });

  it('refuses a name that could not be an app', () => {
    expect(mcpAppNameProblem(EVERY_APP)).toBe('is the name kept for every app');
    expect(mcpAppNameProblem('claude\ncode')).toMatch(/line break/);
    expect(mcpAppNameProblem('x'.repeat(1025))).toMatch(/longer than 1024/);
    expect(mcpAppNameProblem('claude-code')).toBeNull();
  });
});
