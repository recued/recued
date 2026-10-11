import { FLAGS_WITH_VALUES, getArg } from '../cli/parse.js';
import type { BootTrace } from '../cli/boot-trace.js';
import { openDatabase } from '../open-database.js';
import { cmdLLM } from '../commands/llm.js';
import { createBundleStore } from '../bundle-store.js';
import { resolveIdentityKeysPath } from '../identity/boot.js';
import { readIdentityPassphrase } from '../identity/passphrase-env.js';
import { createKeyManager } from '../key-manager.js';
import { createFileServerKeyStore } from '../keys/file-store.js';
import { createLLMConfigManager } from '../llm-config.js';
import { resolveLLMConfigFromEnv } from '../llm-env.js';
import { resolveRealmDbPath } from '../realm-db-path.js';
import { createServerBundleStore } from '../server-bundle-store.js';
import { autoUnlockServerVaultFromKeyfile } from '../server-vault-enrollment.js';

export interface LlmProfileOptions {
  args: string[];
  bootTrace?: BootTrace;
  env?: NodeJS.ProcessEnv;
}

const llmCommandArgs = (args: string[]): string[] => {
  const out: string[] = [];
  let seenLlm = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (FLAGS_WITH_VALUES.has(arg)) {
      i++;
      continue;
    }
    if (!seenLlm) {
      if (arg.startsWith('--')) continue;
      seenLlm = arg === 'llm';
      continue;
    }
    out.push(arg);
  }
  return out;
};

export async function runLlmProfile(options: LlmProfileOptions): Promise<void> {
  const env = options.env ?? process.env;
  const dbPath = resolveRealmDbPath(getArg(options.args, 'db') ?? env.DB_PATH);

  options.bootTrace?.markDbOpenAttempted('configured-db-path');
  const db = await openDatabase(dbPath, { keyEnvironment: env });
  try {
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    options.bootTrace?.mark('db-opened');

    // A paired realm seals its AI keys under `server-data`, which the key file
    // unlocks, so open the keys the way `serve` and `recued --mcp` do. With only
    // the legacy bundle this CLI held no key on a paired server: `show` threw on
    // every key Settings had saved, and `set-slot` stored the new one in plain
    // text (2026-10-09, cli-llm-enrolled-realm.test.ts).
    const bundleStore = createBundleStore(db);
    const serverBundleStore = createServerBundleStore(dbPath);
    const initialServerBundle = serverBundleStore.load();
    const keys = createKeyManager({
      loadBundle: () => bundleStore.load(),
      saveBundle: (bundle) => bundleStore.save(bundle),
      loadServerBundle: () => serverBundleStore.load(),
      initialServerBundle,
      saveServerBundle: (bundle) => serverBundleStore.save(bundle),
    });
    if (initialServerBundle) {
      const passphrase = readIdentityPassphrase(env);
      const keyStore = await createFileServerKeyStore({
        filePath: resolveIdentityKeysPath(dbPath),
        ...(passphrase ? { passphrase } : {}),
      });
      await autoUnlockServerVaultFromKeyfile({ keys, keyStore });
    }
    // Gated on the state, unlike the serve path, because nothing pairs during
    // this short process: 'uninitialized' here is a realm never paired, which
    // has no key to seal under and keeps storing plaintext as it always has.
    const getEncryptionKey = keys.state() !== 'uninitialized'
      ? keys.keyProvider('server-data')
      : undefined;
    const llmManager = createLLMConfigManager(db, {
      envConfig: resolveLLMConfigFromEnv(env),
      getEncryptionKey,
    });

    cmdLLM({ llmManager }, llmCommandArgs(options.args));
  } finally {
    db.close();
  }
}
