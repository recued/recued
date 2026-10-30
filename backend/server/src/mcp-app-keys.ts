/** Contract keys Recued keeps for the AI apps that start `recued --mcp`.
 *
 *  ⛔⛔ AN APP THAT LOADS RECUED AS A PLUGIN HAS NO WAY TO HAND IT A KEY. An
 *  Agent Plugins 1.0 package may carry no secret in its MCP config, and an app
 *  may start the server with an environment of its own choosing: Codex 0.164
 *  passes PATH, HOME, PLUGIN_ROOT, PLUGIN_DATA and a few more, never
 *  RECUED_MCP_TOKEN, whatever the owner's shell or Codex's config says (verified
 *  2026-10-29). So the owner gives the key to Recued instead (`recued mcp-key
 *  set`), for one app or for every app, and `recued --mcp` looks it up.
 *
 *  An app is named by `--app <name>` in its config, else by the folder its
 *  plugin host gives the plugin (`PLUGIN_DATA`: one per installed plugin, kept
 *  across plugin updates, Agent Plugins 1.0 §9.1). Its own key comes first,
 *  then the key for every app, then nothing — D-228: no contract, no tools.
 *
 *  ⚠ A NAME IS NOT AN IDENTITY. Any program running as this user can start
 *  `recued --mcp` under any name. A saved key decides which contract each app is
 *  offered; it does not stop one local program posing as another, any more than
 *  a key in an app's config file did.
 *
 *  🔑 Only the key's id is stored. The bearer is used for nothing but finding
 *  its record, so the id is all a later start needs, and a copy of this table is
 *  no use at the HTTP door, which asks for the key itself.
 *
 *  Here, not in `cli-context/`: the `--mcp` profile may load only its own
 *  context module (`bin-router.test.ts`, the profile boundary). */

import { homedir } from 'node:os';
import { isAbsolute, resolve, sep } from 'node:path';
import type Database from 'better-sqlite3';
import { isMcpInboundTokenActive, type McpInboundTokenRecord } from '@recued/contracts';
import { getArg } from './cli/parse.js';
import { deriveMcpInboundTokenId } from './storage/chat-inbound-token-store.js';

/** The row for every app that has no key of its own. No app may take this name. */
export const EVERY_APP = '*';

export const MCP_APP_NAME_MAX_LENGTH = 1024;

// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTER = /[\x00-\x1f\x7f]/;

/** Why `raw` cannot name an app, or null when it can. */
export const mcpAppNameProblem = (raw: string): string | null => {
  const name = raw.trim();
  if (name.length === 0) return 'is empty';
  if (name === EVERY_APP) return 'is the name kept for every app';
  // An app that does not fill in the plugin's placeholders hands them over as written.
  if (name.includes('${')) return 'is a placeholder the app did not fill in';
  if (name.length > MCP_APP_NAME_MAX_LENGTH) return `is longer than ${MCP_APP_NAME_MAX_LENGTH} characters`;
  if (CONTROL_CHARACTER.test(name)) return 'contains a line break or another control character';
  return null;
};

/** One spelling per app: a folder, `~/…` included, becomes its absolute path;
 *  any other name is kept as given. `list` shows folders under the home folder
 *  as `~/…`, so a name copied from it reaches the same app. */
export const normalizeMcpAppName = (raw: string, home: string = homedir()): string => {
  const name = raw.trim();
  const expanded = name === '~' || name.startsWith('~/') || name.startsWith(`~${sep}`)
    ? `${home}${name.slice(1)}`
    : name;
  return isAbsolute(expanded) ? resolve(expanded) : expanded;
};

/** How an app is shown to the owner: a folder under the home folder as `~/…`. */
export const displayMcpAppName = (app: string, home: string = homedir()): string =>
  home.length > 1 && (app === home || app.startsWith(`${home}${sep}`))
    ? `~${app.slice(home.length)}`
    : app;

/** The app this `recued --mcp` was started for: `--app <name>`, else
 *  `PLUGIN_DATA`. `problem` says why a name that was given cannot be used. */
export const mcpAppOfStart = (
  args: string[],
  env: NodeJS.ProcessEnv,
): { app: string | null; problem: string | null } => {
  const given = getArg(args, 'app');
  const [raw, source] = given !== undefined ? [given, '--app'] : [env.PLUGIN_DATA, 'PLUGIN_DATA'];
  if (raw === undefined || raw.trim().length === 0) return { app: null, problem: null };
  const problem = mcpAppNameProblem(raw);
  return problem === null
    ? { app: normalizeMcpAppName(raw), problem: null }
    : { app: null, problem: `${source} ${problem}` };
};

export interface McpAppKeyRow {
  /** The app's name or folder, or `EVERY_APP`. */
  app: string;
  /** The saved contract key's id; null for an app that started with none saved. */
  token_id: string | null;
  saved_at: number | null;
  /** The last time this app started `recued --mcp`. Never set for `EVERY_APP`. */
  last_started_at: number | null;
}

export interface McpAppKeyStore {
  /** The key `app` is offered: its own, else the key for every app. */
  keyFor(app: string | null): { token_id: string; for: 'app' | 'every_app' } | null;
  /** Record that `app` started, so `recued mcp-key set` can offer it. */
  noteStarted(app: string, now: number): void;
  save(app: string, token_id: string, now: number): void;
  /** Remove `app`'s row: its key and its place in the list. True when there was one. */
  remove(app: string): boolean;
  /** The key for every app first, then the apps, the most recently started first. */
  list(): McpAppKeyRow[];
}

/** One row per app, each written by one statement, so apps starting at the same
 *  moment never overwrite each other's rows. */
export const createMcpAppKeyStore = (db: Database.Database): McpAppKeyStore => {
  db.exec(`CREATE TABLE IF NOT EXISTS mcp_app_keys (
    app             TEXT PRIMARY KEY,
    token_id        TEXT,
    saved_at        INTEGER,
    last_started_at INTEGER
  )`);
  const keyStmt = db.prepare(`SELECT token_id FROM mcp_app_keys WHERE app = ? AND token_id IS NOT NULL`);
  const startedStmt = db.prepare(`INSERT INTO mcp_app_keys (app, last_started_at) VALUES (?, ?)
    ON CONFLICT (app) DO UPDATE SET last_started_at = excluded.last_started_at`);
  const saveStmt = db.prepare(`INSERT INTO mcp_app_keys (app, token_id, saved_at) VALUES (?, ?, ?)
    ON CONFLICT (app) DO UPDATE SET token_id = excluded.token_id, saved_at = excluded.saved_at`);
  const removeStmt = db.prepare(`DELETE FROM mcp_app_keys WHERE app = ?`);
  const listStmt = db.prepare(`SELECT app, token_id, saved_at, last_started_at FROM mcp_app_keys
    ORDER BY app = '${EVERY_APP}' DESC, last_started_at DESC, app`);
  const tokenOf = (app: string): string | null =>
    (keyStmt.get(app) as { token_id: string } | undefined)?.token_id ?? null;
  return {
    keyFor(app) {
      const own = app === null ? null : tokenOf(app);
      if (own !== null) return { token_id: own, for: 'app' };
      const every = tokenOf(EVERY_APP);
      return every === null ? null : { token_id: every, for: 'every_app' };
    },
    noteStarted(app, now) {
      startedStmt.run(app, now);
    },
    save(app, token_id, now) {
      saveStmt.run(app, token_id, now);
    },
    remove(app) {
      return removeStmt.run(app).changes > 0;
    },
    list() {
      return listStmt.all() as McpAppKeyRow[];
    },
  };
};

export interface StdioMcpKey {
  /** The contract key this start runs under, or null for none (no tools). A
   *  revoked key is returned too: the server re-checks it on every call. */
  record: McpInboundTokenRecord | null;
  /** What to print on stderr when the start has no usable key or was given an
   *  app name it cannot use, saying what to do. Null when there is nothing to say. */
  notice: string | null;
}

const SAVE_ONE = 'Save one with "recued mcp-key set", or pass --token <key> or set RECUED_MCP_TOKEN; '
  + 'contract keys are on the Contracts page of the web app.';

type TokenLookup = { getTokenById(token_id: string): McpInboundTokenRecord | null };

const keyOfStart = (
  input: { args: string[]; env: NodeJS.ProcessEnv; now: number; tokens: TokenLookup; appKeys: McpAppKeyStore },
  app: string | null,
): StdioMcpKey => {
  const bearer = getArg(input.args, 'token') ?? input.env.RECUED_MCP_TOKEN;
  if (bearer !== undefined && bearer.length > 0) {
    const record = input.tokens.getTokenById(deriveMcpInboundTokenId(bearer));
    if (record === null) {
      return {
        record: null,
        notice: '[recued mcp] the supplied key was not recognised — no tools will be offered. '
          + 'Check it on the Contracts page of the web app.',
      };
    }
    return {
      record,
      notice: isMcpInboundTokenActive(record, input.now) ? null
        : '[recued mcp] the supplied key was revoked, so no tools will be offered. '
          + 'Copy a current key from the Contracts page of the web app.',
    };
  }

  const saved = input.appKeys.keyFor(app);
  if (saved === null) {
    const which = app === null
      ? 'no contract key was given'
      : `no contract key is saved for this app (${displayMcpAppName(app)})`;
    return { record: null, notice: `[recued mcp] ${which}, so no tools will be offered. ${SAVE_ONE}` };
  }
  const forWhom = saved.for === 'app' ? 'this app' : 'every app';
  const record = input.tokens.getTokenById(saved.token_id);
  if (record === null) {
    return {
      record: null,
      notice: `[recued mcp] the contract key saved for ${forWhom} is no longer on this server, `
        + `so no tools will be offered. ${SAVE_ONE}`,
    };
  }
  return {
    record,
    // ⚠ No fallback to the key for every app when this app's own key is
    // revoked: the owner chose a key for this app, and a wider one standing in
    // for it unasked would be a grant nobody made.
    notice: isMcpInboundTokenActive(record, input.now) ? null
      : `[recued mcp] the contract key saved for ${forWhom} was revoked, so no tools will be offered. ${SAVE_ONE}`,
  };
};

/** Which contract key `recued --mcp` runs under: `--token`, `RECUED_MCP_TOKEN`,
 *  the key saved for this app, the key saved for every app, or none. A key the
 *  start was given is never swapped for a saved one: a wrong key says so. */
export const resolveStdioMcpKey = (input: {
  args: string[];
  env: NodeJS.ProcessEnv;
  now: number;
  tokens: TokenLookup;
  appKeys: McpAppKeyStore;
}): StdioMcpKey => {
  const { app, problem } = mcpAppOfStart(input.args, input.env);
  if (app !== null) {
    // Only so `recued mcp-key set` can offer this app. A busy database must not
    // cost the app its tools.
    try { input.appKeys.noteStarted(app, input.now); } catch { /* listed on a later start */ }
  }
  const chosen = keyOfStart(input, app);
  const notices = [chosen.notice, problem === null ? null : `[recued mcp] ignored ${problem}.`]
    .filter((notice): notice is string => notice !== null);
  return { record: chosen.record, notice: notices.length > 0 ? notices.join('\n') : null };
};
