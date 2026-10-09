/**
 * A step's legacy `pii_fields`, through the REAL composition: `handleExecute` →
 * commit Gateway → cache wrapper → bound executor → the server's own AI adapter,
 * with the model answered over `fetch`.
 *
 * The shape is the shipped one (`compute-deal-risk-hubspot`'s `ai_narrative`): a
 * `pick` builds the context, the AI step reads it through ONE ref, and
 * `pii_fields` names a key inside it. The engine used to hash the step's raw
 * input, where `llm.prompt` is still the string `{{step.ai_context}}` — nothing to
 * look inside — so the deal name went to the model in clear.
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
import { unlockServerVault } from './helpers/unlocked-vault.js';

const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const composeServer = async () => {
  const dir = mkdtempSync(join(tmpdir(), 'recued-step-pii-'));
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
  await unlockServerVault(app.keys!);
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
    env: { RECUED_SERVER_NAME: 'Step PII Test Server' },
  });
  return { storage, app, context };
};

/** The owner's free model at `LLM_BASE_URL`, answering with the first hash token
 *  it was sent; returns the request bodies as they left the server. */
const LLM_BASE_URL = 'https://llm.example.test/v1';
const scriptModel = (server: Awaited<ReturnType<typeof composeServer>>): string[] => {
  const sent: string[] = [];
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url !== `${LLM_BASE_URL}/chat/completions`) {
      return new Response(JSON.stringify({ error: `unscripted ${url}` }), { status: 404 });
    }
    const body = typeof init?.body === 'string' ? init.body : '';
    sent.push(body);
    const token = /HASH_STEP_[0-9a-f]{8}/.exec(body)?.[0] ?? 'nobody';
    return new Response(JSON.stringify({
      id: 'cmpl-1',
      object: 'chat.completion',
      model: 'test-model',
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: `${token} is at risk.` } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  createLLMConfigManager(server.storage.db).upsertPoolEntry({
    id: 'free-1', type: 'api', provider: 'openai-compatible', model: 'test-model', api_key: 'k',
    base_url: LLM_BASE_URL, speed: 'quality', supports_json: true, enabled: true,
  });
  return sent;
};

const recipe: RecipeDefinition = {
  recipe_id: 'step-pii-fields',
  version: 1,
  ttl: 0,
  metadata: { name: 'Deal narrative', description: 'pii_fields behind a ref', author: 'test', supported_platforms: [] },
  variables: {},
  prefetch_steps: [],
  steps: [
    {
      id: 'ai_context',
      transform: 'pick',
      source: { deal_name: '{{context.deal.name}}', stage: '{{context.deal.stage}}', notes: '{{context.deal.notes}}' },
    },
    {
      id: 'ai_narrative',
      op: 'core.ai.prompt',
      args: { 'llm.system_prompt': 'Write one line about the deal.', 'llm.prompt': '{{step.ai_context}}' },
      pii_fields: ['deal_name'],
    },
  ],
  output: { render: [{ type: 'text', source: 'step.ai_narrative' }] },
} as unknown as RecipeDefinition;

const runFor = (server: Awaited<ReturnType<typeof composeServer>>, name: string) => handleExecute(server.context.executeDeps, {
  recipe,
  trigger_source: 'manual',
  context: {
    deal: { name, stage: 'negotiation', notes: 'call {{context.secret}} first' },
    secret: 'LEAKED-VALUE',
  },
});

describe('step pii_fields — the composed server hashes the value a ref brings in', () => {
  it('the model never sees the deal name; the step\'s result names it', async () => {
    const server = await composeServer();
    try {
      const sent = scriptModel(server);
      const response = await runFor(server, 'Acme Expansion');
      expect(response.errors).toEqual([]);
      expect(sent).toHaveLength(1);
      expect(sent[0]).not.toContain('Acme Expansion');
      expect(sent[0]).toContain('HASH_STEP_00000001');
      // Resolved once: text inside the data that looks like a ref stays text.
      expect(sent[0]).toContain('{{context.secret}}');
      expect(sent[0]).not.toContain('LEAKED-VALUE');
      const rendered = JSON.stringify(response.output.render[0]?.data);
      expect(rendered).toContain('Acme Expansion is at risk.');
      expect(rendered).not.toContain('HASH_STEP_');
    } finally {
      server.storage.db.close();
    }
  });

  it('two runs over different deals each ask the model and each get their own name back', async () => {
    const server = await composeServer();
    try {
      const sent = scriptModel(server);
      const first = await runFor(server, 'Acme Expansion');
      const second = await runFor(server, 'Globex Renewal');
      expect(sent).toHaveLength(2);
      expect(JSON.stringify(first.output.render[0]?.data)).toContain('Acme Expansion is at risk.');
      expect(JSON.stringify(second.output.render[0]?.data)).toContain('Globex Renewal is at risk.');
      expect(sent.join('\n')).not.toMatch(/Acme Expansion|Globex Renewal/);
    } finally {
      server.storage.db.close();
    }
  });
});
