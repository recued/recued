/** `recued mcp-key` — the contract key each AI app's `recued --mcp` runs under.
 *
 *    mcp-key list
 *    mcp-key set [--app <name> | --all] [--key-file <path>]
 *    mcp-key clear (--app <name> | --all)
 *
 *  An app that loads Recued as a plugin cannot pass a key (`mcp-app-keys.ts`),
 *  so the owner saves one here: for one app, for every app, or both. Which app
 *  is which comes from the apps that have started `recued --mcp` on this
 *  computer, so `set` and `clear` offer them by number.
 *
 *  ⛔ THE KEY IS NEVER A FLAG VALUE AND NEVER PRINTED. A command line is visible
 *  to every process on the computer (`ps`) and lands in shell history, so the
 *  key is pasted at a hidden prompt, piped on stdin, or read from a file. Before
 *  it is saved it must be a current contract key on THIS server: a mistyped or
 *  revoked key is refused here, not discovered later as an app with no tools. */

import { existsSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import type Database from 'better-sqlite3';
import { MCP_INBOUND_TOKEN_PREFIX } from '@recued/contracts';
import { getArg, getFlag, parsePositionals } from '../cli/parse.js';
import type { BootTrace } from '../cli/boot-trace.js';
import { promptSecret } from '../cli/password-prompt.js';
import {
  EVERY_APP,
  createMcpAppKeyStore,
  displayMcpAppName,
  mcpAppNameProblem,
  normalizeMcpAppName,
  type McpAppKeyRow,
} from '../mcp-app-keys.js';
import { openApplicationDatabase } from '../open-application-database.js';
import { runningAsPackagedBinary } from '../packaged-binary.js';
import { resolveRealmDbPath } from '../realm-db-path.js';
import {
  createChatInboundTokenStore,
  deriveMcpInboundTokenId,
  ensureChatInboundTokenSchema,
  type ChatInboundTokenStore,
} from '../storage/chat-inbound-token-store.js';
import { updateLeasePathForInstall } from '../update/install-paths.js';
import { mcpLeaseHolder } from '../update/mcp-step-aside.js';

/** The terminal, replaceable in tests. */
export interface McpKeyIo {
  /** True when someone can answer a question: stdin is a terminal. */
  interactive: boolean;
  /** Ask a question; the answer shows as it is typed. */
  ask(question: string): Promise<string>;
  /** Ask for the key; it does not show. Reads one line when stdin is piped. */
  askSecret(label: string): Promise<string>;
  readFile(path: string): string;
  out(line: string): void;
  err(line: string): void;
}

export interface McpKeyProfileOptions {
  args: string[];
  bootTrace?: BootTrace;
  env?: NodeJS.ProcessEnv;
  io?: McpKeyIo;
  now?: () => number;
}

const terminalIo = (): McpKeyIo => ({
  interactive: process.stdin.isTTY === true,
  ask: (question) => new Promise((resolve) => {
    // The question goes to stderr, like the key prompt, so stdout holds answers only.
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  }),
  askSecret: promptSecret,
  readFile: (path) => readFileSync(path, 'utf8'),
  out: (line) => { console.log(line); },
  err: (line) => { console.error(line); },
});

const USAGE = [
  'Usage:',
  '  recued mcp-key list                                   Show the contract key each AI app uses',
  '  recued mcp-key set [--app <name> | --all] [--key-file <path>]',
  '                                                        Save a contract key for one app, or for every app',
  '  recued mcp-key clear (--app <name> | --all)           Remove a saved key',
  '',
  'An AI app that starts "recued --mcp" uses the key saved for it, else the key saved for',
  'every app, else none, and is then offered no tools. Contract keys are on the Contracts',
  'page of the web app. "set" asks for the key without showing it, or reads it from',
  '--key-file or from stdin.',
];

const when = (ms: number | null): string => {
  if (ms === null) return 'never';
  const d = new Date(ms);
  const two = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
};

type TokenReader = Pick<ChatInboundTokenStore, 'getTokenById' | 'verifyBearer'>;

/** The saved key in the owner's words: its contract's name, and whether it still works. */
const keyInWords = (tokens: TokenReader, token_id: string): string => {
  const record = tokens.getTokenById(token_id);
  if (record === null) return 'a key that is no longer on this server';
  return record.revoked_at !== null ? `contract "${record.label}" (revoked)` : `contract "${record.label}"`;
};

class McpKeyRefusal extends Error {}

interface Ctx {
  args: string[];
  io: McpKeyIo;
  now: () => number;
  dbPath: string;
  appKeys: ReturnType<typeof createMcpAppKeyStore>;
  tokens: TokenReader;
}

/** `--app` / `--all`, or the owner's pick from a numbered list when neither is given. */
const chooseApp = async (
  ctx: Ctx,
  rows: McpAppKeyRow[],
  question: string,
  everyAppLine: string | null,
  /** `set` only: say how an app gets into the list when none is in it yet. */
  explainEmptyList = false,
): Promise<string> => {
  const all = getFlag(ctx.args, 'all');
  const given = getArg(ctx.args, 'app');
  if (all && given !== undefined) throw new McpKeyRefusal('Give --app or --all, not both.');
  if (all) return EVERY_APP;
  if (given !== undefined) {
    const problem = mcpAppNameProblem(given);
    if (problem !== null) throw new McpKeyRefusal(`--app ${problem}.`);
    return normalizeMcpAppName(given);
  }
  if (!ctx.io.interactive) {
    throw new McpKeyRefusal('Say which app: --app <name>, or --all for every app. "recued mcp-key list" shows the apps.');
  }
  const choices: Array<{ app: string; line: string }> = [];
  if (everyAppLine !== null) choices.push({ app: EVERY_APP, line: everyAppLine });
  for (const row of rows) {
    if (row.app === EVERY_APP) continue;
    const key = row.token_id === null ? 'no key of its own' : keyInWords(ctx.tokens, row.token_id);
    choices.push({ app: row.app, line: `${displayMcpAppName(row.app)}  (${key}; last started ${when(row.last_started_at)})` });
  }
  if (choices.length === 0) throw new McpKeyRefusal('There is no saved key to remove.');
  ctx.io.err(question);
  choices.forEach((choice, i) => { ctx.io.err(`  ${i + 1}. ${choice.line}`); });
  if (explainEmptyList && choices.every((choice) => choice.app === EVERY_APP)) {
    ctx.io.err('An app is listed here once it has started "recued --mcp". To name one yourself, pass --app <name>.');
  }
  const answer = (await ctx.io.ask('Number: ')).trim();
  const picked = /^\d+$/.test(answer) ? choices[Number(answer) - 1] : undefined;
  if (picked === undefined) throw new McpKeyRefusal(`"${answer}" is not one of the numbers above.`);
  return picked.app;
};

const runList = (ctx: Ctx): void => {
  const rows = ctx.appKeys.list();
  const every = rows.find((row) => row.app === EVERY_APP);
  const apps = rows.filter((row) => row.app !== EVERY_APP);
  ctx.io.out(every?.token_id
    ? `Every app: ${keyInWords(ctx.tokens, every.token_id)}, saved ${when(every.saved_at)}.`
    : 'Every app: no key saved.');
  ctx.io.out('');
  if (apps.length === 0) {
    ctx.io.out('No app has started "recued --mcp" on this computer yet.');
  } else {
    ctx.io.out('Apps that have started "recued --mcp":');
    for (const row of apps) {
      const key = row.token_id === null ? 'no key of its own' : `${keyInWords(ctx.tokens, row.token_id)}, saved ${when(row.saved_at)}`;
      ctx.io.out(`  ${displayMcpAppName(row.app)}`);
      ctx.io.out(`    ${key}; last started ${when(row.last_started_at)}`);
    }
  }
  ctx.io.out('');
  ctx.io.out('An app with no key of its own uses the key for every app; with neither, it is offered no tools.');
};

const readKey = async (ctx: Ctx): Promise<string> => {
  const file = getArg(ctx.args, 'key-file');
  let key: string;
  if (file !== undefined) {
    try {
      key = ctx.io.readFile(file).trim();
    } catch (error) {
      throw new McpKeyRefusal(`Could not read ${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (/\s/.test(key)) throw new McpKeyRefusal(`${file} should hold the key alone, on one line.`);
  } else {
    key = (await ctx.io.askSecret('Contract key (not shown): ')).trim();
  }
  if (key.length === 0) throw new McpKeyRefusal('No key was given.');
  return key;
};

const runSet = async (ctx: Ctx): Promise<void> => {
  const app = await chooseApp(ctx, ctx.appKeys.list(), 'Which app should use this key?',
    'Every app without a key of its own', true);
  const key = await readKey(ctx);
  const record = ctx.tokens.verifyBearer({ bearer: key, now: ctx.now() });
  if (record === null) {
    const found = ctx.tokens.getTokenById(deriveMcpInboundTokenId(key));
    if (found !== null && found.revoked_at !== null) {
      throw new McpKeyRefusal(`That key, for contract "${found.label}", was revoked. `
        + 'Copy a current one from the Contracts page of the web app.');
    }
    throw new McpKeyRefusal(`That is not a contract key on this server (${ctx.dbPath}). `
      + (key.startsWith(MCP_INBOUND_TOKEN_PREFIX) ? '' : `A contract key starts with "${MCP_INBOUND_TOKEN_PREFIX}". `)
      + 'Copy it from the Contracts page of the web app.');
  }
  ctx.appKeys.save(app, record.token_id, ctx.now());
  if (app === EVERY_APP) {
    ctx.io.out(`Saved. Every app without a key of its own now uses contract "${record.label}".`);
    ctx.io.out('That includes any program on this computer that starts "recued --mcp".');
  } else {
    ctx.io.out(`Saved. ${displayMcpAppName(app)} now uses contract "${record.label}".`);
  }
  ctx.io.out('Restart the app, or its Recued connection, to load the tools.');
};

const runClear = async (ctx: Ctx): Promise<void> => {
  const rows = ctx.appKeys.list().filter((row) => row.token_id !== null);
  const every = rows.find((row) => row.app === EVERY_APP);
  const app = await chooseApp(ctx, rows, 'Which saved key should be removed?',
    every?.token_id ? `Every app: ${keyInWords(ctx.tokens, every.token_id)}` : null);
  const removed = ctx.appKeys.remove(app);
  if (app === EVERY_APP) {
    ctx.io.out(removed
      ? 'Removed the key for every app. An app without a key of its own is now offered no tools.'
      : 'No key was saved for every app.');
  } else {
    ctx.io.out(removed
      ? `Removed ${displayMcpAppName(app)} and its key. It is listed again the next time it starts "recued --mcp".`
      : `${displayMcpAppName(app)} has no saved key.`);
  }
};

/** Runs one `recued mcp-key` command. Returns the exit code. */
export async function runMcpKey(options: McpKeyProfileOptions): Promise<number> {
  const env = options.env ?? process.env;
  const io = options.io ?? terminalIo();
  const verb = parsePositionals(options.args)[1];
  if (verb !== 'list' && verb !== 'set' && verb !== 'clear') {
    for (const line of USAGE) io.err(line);
    return verb === undefined ? 0 : 1;
  }

  // Never create a realm: a missing database means this is not the computer
  // Recued runs on, or `--db` names the wrong file.
  const dbPath = resolveRealmDbPath(getArg(options.args, 'db') ?? env.DB_PATH, { note: () => {}, mkdir: () => {} });
  if (!existsSync(dbPath)) {
    io.err(`There is no Recued database at ${dbPath}. Run this on the computer Recued runs on, or pass --db <file>.`);
    return 1;
  }
  // An update, a rollback or a server's boot needs the database alone (`update/mcp-step-aside.ts`).
  const busy = mcpLeaseHolder(updateLeasePathForInstall(env, runningAsPackagedBinary));
  if (busy !== null) {
    io.err(`Recued is updating or rolling back right now (${busy.operation}, pid ${busy.pid}). Run this again in a moment.`);
    return 1;
  }

  options.bootTrace?.markDbOpenAttempted('configured-db-path');
  const db: Database.Database = await openApplicationDatabase({ dbPath, env });
  try {
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    options.bootTrace?.mark('db-opened');
    // A realm whose server never made a contract key has no table for them yet.
    ensureChatInboundTokenSchema(db);
    const ctx: Ctx = {
      args: options.args,
      io,
      now: options.now ?? Date.now,
      dbPath,
      appKeys: createMcpAppKeyStore(db),
      tokens: createChatInboundTokenStore(db),
    };
    if (verb === 'list') runList(ctx);
    else if (verb === 'set') await runSet(ctx);
    else await runClear(ctx);
    return 0;
  } catch (error) {
    if (!(error instanceof McpKeyRefusal)) throw error;
    io.err(error.message);
    return 1;
  } finally {
    db.close();
  }
}

export async function runMcpKeyProfile(options: McpKeyProfileOptions): Promise<void> {
  const code = await runMcpKey(options);
  if (code !== 0) process.exitCode = code;
}
