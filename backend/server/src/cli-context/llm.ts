import Database from 'better-sqlite3';
import { FLAGS_WITH_VALUES, getArg } from '../cli/parse.js';
import type { BootTrace } from '../cli/boot-trace.js';
import { cmdLLM } from '../commands/llm.js';
import { createBundleStore } from '../bundle-store.js';
import { createKeyManager } from '../key-manager.js';
import { createLLMConfigManager } from '../llm-config.js';
import { resolveLLMConfigFromEnv } from '../llm-env.js';

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
  const dbPath = getArg(options.args, 'db') ?? env.DB_PATH ?? './recued-server.db';

  options.bootTrace?.markDbOpenAttempted('configured-db-path');
  const db = new Database(dbPath);
  try {
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    options.bootTrace?.mark('db-opened');

    const bundleStore = createBundleStore(db);
    const keys = createKeyManager({
      loadBundle: () => bundleStore.load(),
      saveBundle: (bundle) => bundleStore.save(bundle),
    });
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
