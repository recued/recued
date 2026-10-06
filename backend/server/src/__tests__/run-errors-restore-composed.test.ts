/**
 * A failed run's errors leave it restored, through the REAL composition:
 * `handleExecute` → engine → kernel adapter, read back as the response a chat turn,
 * an MCP agent and the owner's run view receive (`steps[].error` included).
 *
 * `timeline-read` quotes the entity it was given when the reference is malformed. A
 * recipe that hands it a `pii-protect` alias (no `pii-restore` first) used to get
 * "got: m1@d1.invalid" back — an alias this run's ledger minted and nobody outside
 * the run can read.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createRuntimeConfigStore } from '@recued/config';
import type { RecipeDefinition } from '@recued/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { wrapRecipeRunResult } from '../chat-tool-handlers.js';
import { createBootTrace } from '../cli/boot-trace.js';
import { handleExecute } from '../execute-handler.js';
import { composeAppContext } from '../serve/compose-app-context.js';
import { composeCollectionContext } from '../serve/compose-collection-context.js';
import {
  composeExecutionContext,
  createExecutionLateBoundRefs,
} from '../serve/compose-execution-context.js';
import { composeStorageContext } from '../serve/compose-storage-context.js';

const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const composeServer = async () => {
  const dir = mkdtempSync(join(tmpdir(), 'recued-run-errors-'));
  dirs.push(dir);
  const dbPath = join(dir, 'server.db');
  const runtimeConfig = createRuntimeConfigStore({});
  const storage = await composeStorageContext({
    dbPath,
    bootTrace: createBootTrace({ entrypoint: 'serve-entry', profile: 'serve', command: 'serve', env: {} }),
    runtimeConfig,
    vaultQuotas: { perPublisherBytes: 1_000_000, totalBytes: 5_000_000 },
  });
  const lateBound = createExecutionLateBoundRefs();
  const app = composeAppContext({
    db: storage.db,
    dbPath,
    envLlmConfig: storage.envLlmConfig,
    gateRegistry: storage.gateRegistry,
    auditLog: storage.auditLog,
    eventBus: storage.eventBus,
    serverInstanceId: storage.serverInstanceId,
    recipeStore: storage.recipeStore,
    pairedInstances: storage.pairedInstances,
    workEntityStore: storage.workEntityStoreRef,
    chatLateBound: lateBound,
  });
  // D-212 — the AI adapter's response cache is sealed; the server needs an unlocked vault.
  await app.keys!.init({ password: 'run-errors-passphrase' });
  const collection = composeCollectionContext({
    db: storage.db,
    dbPath,
    runtimeConfig,
    manifests: storage.manifests,
    baseVault: storage.baseVault,
    auditLog: storage.auditLog,
    cacheBlobs: app.cacheBlobs,
    warehouseBus: app.warehouseBus,
    contactStore: app.contactStoreRef,
    mailFactStore: storage.mailFactStoreRef,
    gateRegistry: storage.gateRegistry,
    accountStore: storage.accountStore,
    eventBus: storage.eventBus,
    keys: app.keys,
    connectionStore: app.connectionStoreRef,
    workEntityStore: storage.workEntityStoreRef,
    enrichmentCascade: app.enrichmentCascadeRef,
  });
  const context = await composeExecutionContext({
    storage,
    app,
    collection,
    baseVault: storage.baseVault,
    lateBound,
    env: { RECUED_SERVER_NAME: 'Run Errors Test Server' },
  });
  return { storage, app, context };
};

const recipe = {
  recipe_id: 'run-errors-restore',
  version: 1,
  ttl: 0,
  metadata: { name: 'Timeline of a sender', description: 'an alias handed to a step that quotes it', author: 'test', supported_platforms: [] },
  variables: {},
  prefetch_steps: [],
  steps: [
    { id: 'protect', transform: 'pii-protect', data: '{{context.raw}}', fields: [{ path: 'from', kind: 'email' }] },
    { id: 'timeline', ingredient: 'timeline-read', input: { entity: '{{step.protect.aliased.from}}' } },
  ],
  output: { sidebar: [] },
} as unknown as RecipeDefinition;

describe('a failed run\'s errors are restored before the host hands them on', () => {
  it('the error quoting the alias carries the real address, in errors and on the step', async () => {
    const server = await composeServer();
    try {
      const response = await handleExecute(server.context.executeDeps, {
        recipe,
        trigger_source: 'manual',
        context: { raw: { from: 'dana@northwind.example' } },
      });
      expect(response.success).toBe(false);
      const expected = "timeline-read: entity must be '<collection>:<id>' (got: dana@northwind.example)";
      expect(response.errors.map((e) => (e as { message: string }).message)).toContain(expected);
      expect((response.steps.find((s) => s.id === 'timeline')?.error as { message?: string })?.message).toBe(expected);
      // What a chat turn receives: the same restored text, never the run's alias.
      const chat = JSON.stringify(wrapRecipeRunResult(response));
      expect(chat).toContain('dana@northwind.example');
      expect(chat).not.toContain('m1@d1.invalid');
    } finally {
      server.storage.db.close();
    }
  });
});
