import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..', '..', '..', '..');
const serveEntryPath = join(repoRoot, 'backend/server/src/serve-entry.ts');

describe('serve-entry shell ratchet', () => {
  it('keeps serve-entry as the base-context shell and post-base dispatcher', () => {
    const source = readFileSync(serveEntryPath, 'utf8');

    expect(source).toMatch(
      /import \{ composeBaseContext \} from ["']\.\/serve\/compose-base-context\.js["']/,
    );
    expect(source).toMatch(/await import\(["']@recued\/contracts["']\)/);
    expect(source).toMatch(/composeBaseContext\(inputArgs\)/);
    expect(source).toMatch(/bootTrace\.mark\('dispatch-start'\)/);
    expect(source).toMatch(
      /import\(["']\.\/serve\/start-post-storage-app-collection-execution-runtime\.js["']\)/,
    );
    expect(source).toMatch(/await startPostBaseStorageVaultRuntime\(\{/);
    expect(source).toMatch(/publishDbCleanup:\s*\(nextCleanup\) => \{/);
    expect(source).toMatch(/cleanup\(\)/);

    expect(source.match(/import\(["']\.\/serve\//g) ?? []).toHaveLength(1);
    expect(source).not.toMatch(/composition\/bin/);
    expect(source).not.toMatch(/backgroundServices/);
    expect(source).not.toMatch(/housekeepingSchedulerRegistry/);
    expect(source).not.toMatch(/schedulerRegistry/);
    expect(source).not.toMatch(
      /composeStorageContext|startPostStorageAppCollectionExecutionRuntime|composeAppContext|composeCollectionContext|composeExecutionContext|composeBootstrapCascadeContext|composeMaintenanceContext|composeServeLifecycle|startBootRecoveryAndAdapters|composeIngressRpcContext|composeClientSecurityContext|composeRpcContext|composeListeners|composeServeExposure|startPostListenerRuntime|wrapServePeerCache|startSchedulers|startHousekeepingStartup|startRetentionPruners|startDdnsUpdatePoller|logBootBanner|installShutdown/,
    );
  });
});
