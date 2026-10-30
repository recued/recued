/** `recued mcp-key`, run in-process through `runMcpKey`, the function `bin.ts`
 *  calls for `mcp-key`, against a realm database on disk.
 *
 *  ⛔ What must hold whatever else changes: a key is saved only when it is a
 *  current contract key on THIS server, and the key itself is never printed. */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { runMcpKey, type McpKeyIo } from '../cli-context/mcp-key.js';
import { EVERY_APP, createMcpAppKeyStore, resolveStdioMcpKey } from '../mcp-app-keys.js';
import { createChatInboundTokenStore, ensureChatInboundTokenSchema } from '../storage/chat-inbound-token-store.js';

const PERSONAL = 'recued_personal_contract_key_for_tests';
const CODING = 'recued_coding_contract_key_for_tests';
const REVOKED = 'recued_revoked_contract_key_for_tests';
const CODEX = '/Users/ann/.codex/plugins/data/agent-plugins/06f2ff51';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** A realm holding three contract keys, one of them revoked. */
const seededRealm = (): { dir: string; dbPath: string } => {
  const dir = mkdtempSync(join(tmpdir(), 'cli-mcp-key-'));
  dirs.push(dir);
  const dbPath = join(dir, 'recued-server.db');
  const db = new Database(dbPath);
  try {
    ensureChatInboundTokenSchema(db);
    const tokens = createChatInboundTokenStore(db);
    for (const [label, bearer] of [['Personal', PERSONAL], ['Coding', CODING], ['Old', REVOKED]] as const) {
      tokens.issueToken({
        value: { label, grants: { recued_listRecipes: true }, concurrency_tier: 3, chat_mode: null },
        now: 1,
        bearer_plaintext: bearer,
      });
    }
    const old = tokens.listTokens().find((record) => record.label === 'Old');
    tokens.revokeToken({ token_id: old!.token_id, now: 2 });
  } finally { db.close(); }
  return { dir, dbPath };
};

const terminal = (options: { interactive?: boolean; answers?: string[]; secret?: string } = {}) => {
  const out: string[] = [];
  const err: string[] = [];
  const answers = [...(options.answers ?? [])];
  const io: McpKeyIo = {
    interactive: options.interactive ?? false,
    ask: async () => answers.shift() ?? '',
    askSecret: async () => options.secret ?? '',
    readFile: (path) => readFileSync(path, 'utf8'),
    out: (line) => { out.push(line); },
    err: (line) => { err.push(line); },
  };
  return { io, out, err, text: () => [...out, ...err].join('\n') };
};

const run = (dbPath: string, args: string[], t: ReturnType<typeof terminal>) =>
  runMcpKey({ args: ['mcp-key', ...args, '--db', dbPath], env: {}, io: t.io });

/** What `recued --mcp` would run under, started for `app`. */
const keyOf = (dbPath: string, env: NodeJS.ProcessEnv): string | null => {
  const db = new Database(dbPath);
  try {
    return resolveStdioMcpKey({
      args: ['--mcp'], env, now: 5,
      tokens: createChatInboundTokenStore(db), appKeys: createMcpAppKeyStore(db),
    }).record?.label ?? null;
  } finally { db.close(); }
};

describe('recued mcp-key set', () => {
  it('⛔ saves a key for every app from stdin, and never prints it', async () => {
    const { dbPath } = seededRealm();
    const t = terminal({ secret: `${PERSONAL}\n` });
    expect(await run(dbPath, ['set', '--all'], t)).toBe(0);
    expect(t.out).toContain('Saved. Every app without a key of its own now uses contract "Personal".');
    expect(t.out.join('\n')).toContain('any program on this computer');
    expect(t.text()).not.toContain(PERSONAL);
    expect(keyOf(dbPath, { PLUGIN_DATA: CODEX })).toBe('Personal');
  });

  it('saves a key for one app from a file, and that app alone uses it', async () => {
    const { dir, dbPath } = seededRealm();
    const file = join(dir, 'key.txt');
    writeFileSync(file, `${CODING}\n`);
    const t = terminal();
    expect(await run(dbPath, ['set', '--app', 'claude-code', '--key-file', file], t)).toBe(0);
    expect(t.out).toContain('Saved. claude-code now uses contract "Coding".');
    expect(t.text()).not.toContain(CODING);
    expect(keyOf(dbPath, {})).toBeNull();
    const db = new Database(dbPath);
    try {
      expect(createMcpAppKeyStore(db).keyFor('claude-code')).toMatchObject({ for: 'app' });
    } finally { db.close(); }
  });

  it('offers the apps that have started, by number, when run at a terminal', async () => {
    const { dbPath } = seededRealm();
    keyOf(dbPath, { PLUGIN_DATA: CODEX }); // Codex starts once, with no key.
    const t = terminal({ interactive: true, answers: ['2'], secret: CODING });
    expect(await run(dbPath, ['set'], t)).toBe(0);
    expect(t.err).toContain('Which app should use this key?');
    expect(t.err).toContain('  1. Every app without a key of its own');
    expect(t.err.find((line) => line.startsWith('  2. '))).toContain(`${CODEX}  (no key of its own; last started `);
    expect(keyOf(dbPath, { PLUGIN_DATA: CODEX })).toBe('Coding');
    expect(keyOf(dbPath, {})).toBeNull();
  });

  it('⛔ refuses a key that is not a current contract key on this server, and saves nothing', async () => {
    const { dbPath } = seededRealm();
    const unknown = terminal({ secret: 'recued_not_a_key_here' });
    expect(await run(dbPath, ['set', '--all'], unknown)).toBe(1);
    expect(unknown.err[0]).toBe(`That is not a contract key on this server (${dbPath}). Copy it from the Contracts page of the web app.`);

    const wrongKind = terminal({ secret: 'apple banana cherry' });
    expect(await run(dbPath, ['set', '--all'], wrongKind)).toBe(1);
    expect(wrongKind.err[0]).toContain('A contract key starts with "recued_".');

    const revoked = terminal({ secret: REVOKED });
    expect(await run(dbPath, ['set', '--all'], revoked)).toBe(1);
    expect(revoked.err[0]).toBe('That key, for contract "Old", was revoked. Copy a current one from the Contracts page of the web app.');

    for (const t of [unknown, wrongKind, revoked]) expect(t.text()).not.toMatch(/recued_not_a_key_here|apple banana|recued_revoked/);
    expect(keyOf(dbPath, {})).toBeNull();
  });

  it('asks which app when it cannot ask, and refuses a file holding more than the key', async () => {
    const { dir, dbPath } = seededRealm();
    const piped = terminal({ secret: PERSONAL });
    expect(await run(dbPath, ['set'], piped)).toBe(1);
    expect(piped.err[0]).toMatch(/^Say which app: --app <name>, or --all/);

    const both = terminal({ secret: PERSONAL });
    expect(await run(dbPath, ['set', '--all', '--app', 'x'], both)).toBe(1);
    expect(both.err[0]).toBe('Give --app or --all, not both.');

    const file = join(dir, 'notes.txt');
    writeFileSync(file, `my key:\n${PERSONAL}\n`);
    const twoLines = terminal();
    expect(await run(dbPath, ['set', '--all', '--key-file', file], twoLines)).toBe(1);
    expect(twoLines.err[0]).toBe(`${file} should hold the key alone, on one line.`);
    expect(twoLines.text()).not.toContain(PERSONAL);

    const empty = terminal({ secret: '   ' });
    expect(await run(dbPath, ['set', '--all'], empty)).toBe(1);
    expect(empty.err[0]).toBe('No key was given.');
  });

  it('never creates a realm', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-mcp-key-none-'));
    dirs.push(dir);
    const dbPath = join(dir, 'recued-server.db');
    const t = terminal({ secret: PERSONAL });
    expect(await run(dbPath, ['set', '--all'], t)).toBe(1);
    expect(t.err[0]).toBe(`There is no Recued database at ${dbPath}. Run this on the computer Recued runs on, or pass --db <file>.`);
  });
});

describe('recued mcp-key list and clear', () => {
  it('lists the key for every app and each app with its contract', async () => {
    const { dbPath } = seededRealm();
    keyOf(dbPath, { PLUGIN_DATA: CODEX });
    await run(dbPath, ['set', '--all'], terminal({ secret: PERSONAL }));
    await run(dbPath, ['set', '--app', 'claude-code'], terminal({ secret: CODING }));

    const t = terminal();
    expect(await run(dbPath, ['list'], t)).toBe(0);
    expect(t.out[0]).toMatch(/^Every app: contract "Personal", saved \d{4}-\d\d-\d\d \d\d:\d\d\.$/);
    expect(t.out).toContain('Apps that have started "recued --mcp":');
    expect(t.out).toContain(`  ${CODEX}`);
    expect(t.out).toContain('  claude-code');
    expect(t.out.find((line) => line.includes('contract "Coding"'))).toMatch(/last started never$/);
    expect(t.text()).not.toMatch(/recued_personal|recued_coding/);
  });

  it('removes one app, or the key for every app', async () => {
    const { dbPath } = seededRealm();
    await run(dbPath, ['set', '--all'], terminal({ secret: PERSONAL }));
    await run(dbPath, ['set', '--app', 'claude-code'], terminal({ secret: CODING }));

    const one = terminal();
    expect(await run(dbPath, ['clear', '--app', 'claude-code'], one)).toBe(0);
    expect(one.out[0]).toBe('Removed claude-code and its key. It is listed again the next time it starts "recued --mcp".');
    expect(keyOf(dbPath, { PLUGIN_DATA: 'claude-code' })).toBe('Personal');

    const picked = terminal({ interactive: true, answers: ['1'] });
    expect(await run(dbPath, ['clear'], picked)).toBe(0);
    expect(picked.err).toContain('  1. Every app: contract "Personal"');
    expect(picked.out[0]).toBe('Removed the key for every app. An app without a key of its own is now offered no tools.');
    expect(keyOf(dbPath, {})).toBeNull();

    const nothing = terminal({ interactive: true });
    expect(await run(dbPath, ['clear'], nothing)).toBe(1);
    expect(nothing.err[0]).toBe('There is no saved key to remove.');
  });

  it('prints its usage with no verb, and refuses an unknown one', async () => {
    const { dbPath } = seededRealm();
    const bare = terminal();
    expect(await run(dbPath, [], bare)).toBe(0);
    expect(bare.err[0]).toBe('Usage:');
    const unknown = terminal();
    expect(await run(dbPath, ['show'], unknown)).toBe(1);
    expect(unknown.err[0]).toBe('Usage:');
  });
});

it('the row kept for every app is not an app anyone can name', async () => {
  const { dbPath } = seededRealm();
  const t = terminal({ secret: PERSONAL });
  expect(await run(dbPath, ['set', '--app', EVERY_APP], t)).toBe(1);
  expect(t.err[0]).toBe('--app is the name kept for every app.');
});
