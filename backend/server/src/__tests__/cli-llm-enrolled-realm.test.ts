/** `recued llm` on a paired server.
 *
 *  Pairing enrolls the realm: the database is encrypted, and the AI keys the web
 *  app saves are sealed under the realm's `server-data` key. The serve path and
 *  `recued --mcp` unlock that key from the key file. `recued llm` opened only the
 *  legacy bundle, so on a paired server it held no key at all: `llm show` threw on
 *  every key Settings had saved, and `llm set-slot` stored the new key in plain
 *  text (2026-10-09).
 *
 *  Each realm here is enrolled by the real path, and the CLI runs in-process
 *  through `runLlmProfile`, the function `bin.ts` calls for `llm`. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { generateRecoveryKey } from '@recued/crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { runLlmProfile } from '../cli-context/llm.js';
import { bootServerIdentity } from '../identity/boot.js';
import { createKeyManager } from '../key-manager.js';
import { createLLMConfigManager } from '../llm-config.js';
import { openDatabase } from '../open-database.js';
import { createServerBundleStore } from '../server-bundle-store.js';
import { enrollServerVaultFromRecoveryKey } from '../server-vault-enrollment.js';

const SAVED_KEY = 'sk-saved-by-settings';
const PASSPHRASE = 'a long passphrase for the test realm';

/** The key file records the Argon2id cost it was sealed with, and every
 *  reader — the CLI under test included — derives with the recorded one. At
 *  the production cost the passphrase case took 25 s in a green sweep and
 *  timed out at 30 s in the next one (2026-10-09); the cost has nothing to do
 *  with whether the CLI reads the passphrase from the environment it is given. */
const FAST_ARGON2 = { t: 1, m: 8, p: 1 };

const dirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** A realm paired the way the web app pairs it, holding a slot-1 key saved the
 *  way Settings saves one: under the unlocked `server-data` key. */
const pairedRealmWithASavedKey = async (passphrase: string | null): Promise<string> => {
  const dir = mkdtempSync(join(tmpdir(), 'cli-llm-enrolled-'));
  dirs.push(dir);
  const dbPath = join(dir, 'recued-server.db');
  const db = await openDatabase(dbPath, { databaseKey: null });
  try {
    db.pragma('journal_mode = WAL');
    const identity = await bootServerIdentity({ dbPath, passphrase, argon2_params: FAST_ARGON2 });
    const serverBundleStore = createServerBundleStore(dbPath);
    const keys = createKeyManager({
      loadBundle: () => null,
      saveBundle: () => {},
      loadServerBundle: () => serverBundleStore.load(),
      saveServerBundle: (bundle) => serverBundleStore.save(bundle),
    });
    await enrollServerVaultFromRecoveryKey({
      keys,
      keyStore: identity.keyStore,
      recoveryKey: generateRecoveryKey().mnemonic,
      database: db,
    });
    createLLMConfigManager(db, { getEncryptionKey: keys.keyProvider('server-data') })
      .setSlot1({ provider: 'openai', model: 'gpt-saved-by-settings', api_key: SAVED_KEY });
  } finally {
    db.close();
  }
  return dbPath;
};

/** Run `recued llm <args>` against `dbPath`; returns what it printed. */
const llm = async (dbPath: string, env: NodeJS.ProcessEnv, ...args: string[]): Promise<string> => {
  const printed: string[] = [];
  const log = vi.spyOn(console, 'log').mockImplementation((...parts: unknown[]) => {
    printed.push(parts.join(' '));
  });
  try {
    await runLlmProfile({ args: ['--db', dbPath, 'llm', ...args], env });
  } finally {
    log.mockRestore();
  }
  return printed.join('\n');
};

/** The stored value of a slot's API key, read straight from the table. */
const storedApiKey = async (dbPath: string, env: NodeJS.ProcessEnv, slot: string): Promise<string> => {
  const db = await openDatabase(dbPath, { keyEnvironment: env });
  try {
    return db.prepare('SELECT value FROM llm_config WHERE key = ?').pluck().get(`${slot}.api_key`) as string;
  } finally {
    db.close();
  }
};

describe('`recued llm` on a paired server', () => {
  it('`show` reads the keys Settings saved, and redacts them', async () => {
    const dbPath = await pairedRealmWithASavedKey(null);
    const shown = await llm(dbPath, {}, 'show');
    expect(shown).toContain('gpt-saved-by-settings');
    expect(shown).not.toContain(SAVED_KEY);
    expect(await llm(dbPath, {}, 'show', '--reveal-keys')).toContain(SAVED_KEY);
  });

  it('`set-slot` stores the new key encrypted, the way Settings does', async () => {
    const dbPath = await pairedRealmWithASavedKey(null);
    await llm(dbPath, {}, 'set-slot', 'slot_2', '--provider', 'openai', '--model', 'gpt-set-by-cli', '--api-key', 'sk-set-by-cli');
    const stored = await storedApiKey(dbPath, {}, 'slot_2');
    expect(stored.startsWith('enc:v1:')).toBe(true);
    expect(stored).not.toContain('sk-set-by-cli');
    expect(await llm(dbPath, {}, 'show', '--reveal-keys')).toContain('sk-set-by-cli');
  });

  it('a server never paired still takes a slot: it has no key to seal under yet', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-llm-unpaired-'));
    dirs.push(dir);
    const dbPath = join(dir, 'recued-server.db');
    await llm(dbPath, {}, 'set-slot', 'slot_1', '--provider', 'openai', '--model', 'gpt-unpaired', '--api-key', 'sk-unpaired');
    expect(await llm(dbPath, {}, 'show', '--reveal-keys')).toContain('sk-unpaired');
  });

  it('a key file sealed with a passphrase opens with RECUED_IDENTITY_PASSPHRASE from the environment it is given', async () => {
    const dbPath = await pairedRealmWithASavedKey(PASSPHRASE);
    // The control: without the passphrase the same file does not open, so the
    // cases below prove the CLI read it rather than that nothing was sealed.
    await expect(llm(dbPath, {}, 'show', '--reveal-keys')).rejects.toThrow(
      /is sealed with a passphrase, and RECUED_IDENTITY_PASSPHRASE is not set/,
    );
    const env = { RECUED_IDENTITY_PASSPHRASE: PASSPHRASE };
    expect(await llm(dbPath, env, 'show', '--reveal-keys')).toContain(SAVED_KEY);
    await llm(dbPath, env, 'set-slot', 'slot_2', '--provider', 'openai', '--model', 'gpt-set-by-cli', '--api-key', 'sk-set-by-cli');
    expect((await storedApiKey(dbPath, env, 'slot_2')).startsWith('enc:v1:')).toBe(true);
  });
});
