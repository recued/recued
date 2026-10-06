/**
 * D-316 amendment (2026-10-05) — a recipe's `content` PII tag gets the chat's
 * known-value match, through the REAL composition: `composeExecutionContext`
 * builds the matcher over the app's own contact store and hands it to the
 * executor config, and `handleExecute` threads it into the run's engine context
 * — where a `pii-protect` step reads it.
 *
 * The engine restores aliases in a run's OUTPUT, so the output cannot show the
 * aliasing; a `fail_on` on the protect step does: it fails the run if the
 * contact's surname is still in the protected body.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createRuntimeConfigStore } from '@recued/config';
import type { RecipeDefinition } from '@recued/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createBootTrace } from '../cli/boot-trace.js';
import { handleExecute } from '../execute-handler.js';
import { createLLMConfigManager } from '../llm-config.js';
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
  const dir = mkdtempSync(join(tmpdir(), 'recued-d316-'));
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
  await app.keys!.init({ password: 'd-316-test-passphrase' });
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
    env: { RECUED_SERVER_NAME: 'D-316 Test Server' },
  });
  return { storage, app, context };
};

const recipe: RecipeDefinition = {
  recipe_id: 'd316-content-tag',
  version: 1,
  ttl: 0,
  metadata: { name: 'Content tag', description: 'protect then restore', author: 'test', supported_platforms: [] },
  variables: {},
  prefetch_steps: [],
  steps: [
    {
      id: 'protect',
      transform: 'pii-protect',
      data: '{{context.raw}}',
      fields: [{ path: 'body', kind: 'content' }],
      fail_on: '{{step.protect.aliased.body}} contains Whitfield',
    },
    {
      id: 'restore',
      transform: 'pii-restore',
      data: '{{step.protect.aliased}}',
      ledger_handle: '{{step.protect.ledger_handle}}',
    },
  ],
  output: { sidebar: [] },
};

const run = (server: Awaited<ReturnType<typeof composeServer>>) => handleExecute(server.context.executeDeps, {
  recipe,
  trigger_source: 'manual',
  context: { raw: { body: 'Dana Whitfield asked for the addendum.' } },
});

/** The owner's free model, answered at `LLM_BASE_URL` as an OpenAI-compatible
 *  endpoint would; returns the request bodies as they left the server. */
const LLM_BASE_URL = 'https://llm.example.test/v1';
const scriptModel = (server: Awaited<ReturnType<typeof composeServer>>): string[] => {
  const sent: string[] = [];
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url !== `${LLM_BASE_URL}/chat/completions`) {
      return new Response(JSON.stringify({ error: `unscripted ${url}` }), { status: 404 });
    }
    sent.push(typeof init?.body === 'string' ? init.body : '');
    const answer = { category: 'needs_reply', confidence: 0.9, reasoning: 'pii.Person1 is waiting' };
    return new Response(JSON.stringify({
      id: 'cmpl-1',
      object: 'chat.completion',
      model: 'test-model',
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(answer) } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  createLLMConfigManager(server.storage.db).upsertPoolEntry({
    id: 'free-1', type: 'api', provider: 'openai-compatible', model: 'test-model', api_key: 'k',
    base_url: LLM_BASE_URL, speed: 'quality', supports_json: true, enabled: true,
  });
  return sent;
};

const classifyStep = {
  id: 'triage',
  op: 'core.ai.classify',
  args: {
    'llm.data': '{{context.raw}}',
    'llm.categories': ['needs_reply', 'fyi'],
    'llm.pii_fields': { body: 'content' },
  },
};

describe('D-316 amendment — the composed server lends a recipe\'s content tag its known contacts', () => {
  it('a contact in the warehouse is hidden inside the tagged content', async () => {
    const server = await composeServer();
    try {
      expect(server.context.executorConfig.piiKnownValues).toEqual(expect.any(Function));
      server.app.contactStoreRef!.upsertManual({ email: 'dana@northwind.example', name: 'Dana Whitfield' });
      const response = await run(server);
      expect(response.errors).toEqual([]);
      expect(response.success).toBe(true);
    } finally {
      server.storage.db.close();
    }
  });

  it('an ai-* step\'s content-tagged `llm.pii_fields` reaches the model aliased — the server\'s own AI adapter', async () => {
    const server = await composeServer();
    try {
      const sent = scriptModel(server);
      server.app.contactStoreRef!.upsertManual({ email: 'dana@northwind.example', name: 'Dana Whitfield' });
      const response = await handleExecute(server.context.executeDeps, {
        recipe: { ...recipe, recipe_id: 'd316-content-tag-ai', steps: [classifyStep] },
        trigger_source: 'manual',
        context: { raw: { body: 'Dana Whitfield asked for the addendum.' } },
      });
      expect(response.errors).toEqual([]);
      expect(sent).toHaveLength(1);
      expect(sent[0]).not.toContain('Dana Whitfield');
      expect(sent[0]).toContain('pii.Person1');
    } finally {
      server.storage.db.close();
    }
  });

  // D-316 amendment (2026-10-06) — the matcher is built once per RUN, shared by
  // the engine context (`pii-protect`) and the AI adapter (`llm.pii_fields`), and
  // released when the run ends.
  it('one run builds the matcher once for its pii-protect and its AI step; the next run builds again', async () => {
    const server = await composeServer();
    try {
      const sent = scriptModel(server);
      const store = server.app.contactStoreRef!;
      store.upsertManual({ email: 'dana@northwind.example', name: 'Dana Whitfield' });
      const builds = vi.spyOn(store, 'listAllNamesAndCompanies');
      const twoTagged = {
        recipe: { ...recipe, recipe_id: 'd316-run-memo', steps: [...recipe.steps, classifyStep] },
        trigger_source: 'manual',
        context: { raw: { body: 'Dana Whitfield asked for the addendum.' } },
      };

      const first = await handleExecute(server.context.executeDeps, twoTagged);
      expect(first.errors).toEqual([]);
      expect(sent[0]).not.toContain('Dana Whitfield');
      expect(builds).toHaveBeenCalledTimes(1);
      expect(server.context.executorConfig.piiKnownValuesRuns!.size()).toBe(0);

      await handleExecute(server.context.executeDeps, twoTagged);
      expect(builds).toHaveBeenCalledTimes(2);
      expect(server.context.executorConfig.piiKnownValuesRuns!.size()).toBe(0);
    } finally {
      server.storage.db.close();
    }
  });

  it('the same run without that contact keeps the name — the match is the warehouse\'s, not a guess', async () => {
    const server = await composeServer();
    try {
      const response = await run(server);
      expect(response.success).toBe(false);
      expect(JSON.stringify(response.errors)).toContain('RECIPE_FAIL_ON_TRIGGERED');
    } finally {
      server.storage.db.close();
    }
  });
});
