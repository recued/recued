import { hostname } from 'node:os';
import type Database from 'better-sqlite3';
import { getArg, getFlag, parsePositionals } from '../cli/parse.js';
import { resolveBindPort } from '../cli/resolve-bind-port.js';
import type { BootTrace } from '../cli/boot-trace.js';
import { cmdPair } from '../commands/pair.js';
import { createPairingManager, parsePairCodeTtl } from '../pairing.js';
import { createPairingStateStore } from '../pairing-state-store.js';
import { createRecoveryKeyCheckStore } from '../recovery-key-store.js';
import { openDatabase } from '../open-database.js';

export interface PairProfileOptions {
  args: string[];
  bootTrace?: BootTrace;
  env?: NodeJS.ProcessEnv;
  out?: (line: string) => void;
}

const ensurePairingManager = (db: Database.Database, codeTtlMs?: number) => {
  db.exec(`CREATE TABLE IF NOT EXISTS server_config (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  const row = db.prepare(`SELECT value FROM server_config WHERE key = 'realm_token'`).get() as
    | { value: string }
    | undefined;
  const pairing = createPairingManager({
    realmToken: row?.value,
    store: createPairingStateStore(db),
    // Omitted unless the caller passed --pair-code-ttl, so the refresh
    // INHERITS whatever window the running server was booted with rather than
    // silently dropping back to 15 minutes.
    ...(codeTtlMs !== undefined ? { codeTtlMs } : {}),
  });
  if (!row) {
    db.prepare(`INSERT OR REPLACE INTO server_config (key, value) VALUES ('realm_token', ?)`)
      .run(pairing.getRealmToken());
  }
  return pairing;
};

export async function runPairProfile(options: PairProfileOptions): Promise<void> {
  const env = options.env ?? process.env;
  const positionals = parsePositionals(options.args);
  const sub = positionals[1];
  if (sub && sub !== 'generate') {
    console.error(`Unknown subcommand 'pair ${sub}'. Try 'pair generate'.`);
    process.exitCode = 1;
    return;
  }

  const dbPath = getArg(options.args, 'db') ?? env.DB_PATH ?? './recued-server.db';
  const port = resolveBindPort({ args: options.args, env });
  const serverDisplayName = env.RECUED_SERVER_NAME ?? hostname() ?? 'recued';

  options.bootTrace?.markDbOpenAttempted('configured-db-path');
  const db = await openDatabase(dbPath);
  try {
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    options.bootTrace?.mark('db-opened');

    const ttlRaw = getArg(options.args, 'pair-code-ttl');
    let codeTtlMs: number | undefined;
    if (ttlRaw !== undefined) {
      codeTtlMs = parsePairCodeTtl(ttlRaw);
      if (codeTtlMs === undefined) {
        console.error(
          `Invalid --pair-code-ttl '${ttlRaw}'. Use a positive number with an optional unit: 900000, 30m, 12h, 7d.`,
        );
        process.exitCode = 1;
        return;
      }
    }
    const pairing = ensurePairingManager(db, codeTtlMs);
    const recoveryKeyCheck = createRecoveryKeyCheckStore(db);

    await cmdPair(
      {
        pairing,
        recoveryKeyCheck,
        enumerate: { configuredHostname: serverDisplayName, port },
      },
      {
        noUrlPrefill: getFlag(options.args, 'no-url-prefill'),
        ...(sub === 'generate' ? { subcommand: 'generate' as const } : {}),
        ...(options.out ? { out: options.out } : {}),
      },
    );
  } finally {
    db.close();
  }
}
