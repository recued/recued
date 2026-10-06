/**
 * D-316 amendment (2026-10-05) — the preapproval review builds the AI request with
 * the executor's own known-value matcher. At run time `beforeAiProvider` refuses
 * a request whose hash differs from the reviewed one, so a review built without
 * the match would refuse every reviewed run of a step that tags content.
 */
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import type { IngredientManifest } from '@recued/contracts';
import { createQuotaTracker } from '@recued/llm';
import { buildKnownValueIndex, type PiiKnownValueSource } from '@recued/transforms';

import { createPreapprovalAi } from '../preapproval-ai.js';
import type { ServerExecutorConfig } from '../server-executor.js';

const manifest: IngredientManifest = {
  slug: 'ai-classify',
  name: 'Classify',
  description: 'Classifier',
  author: 'recued',
  kind: 'ai',
  category: 'ai',
  risk_tier: 'read',
  input: {},
  output: {},
};

const source: PiiKnownValueSource = {
  nameOrgIndex: { index: buildKnownValueIndex([{ value: 'Dana Whitfield', kind: 'name' }]) },
  resolveIdentifiers: () => [],
  isDegraded: () => false,
};

const executorWith = (piiKnownValues?: ServerExecutorConfig['piiKnownValues']) => ({
  llmConfig: { slot_1: { provider: 'openai', model: 'gpt-fast', api_key: 'sk-test' } },
  llmQuota: createQuotaTracker(),
  ...(piiKnownValues ? { piiKnownValues } : {}),
}) as unknown as ServerExecutorConfig;

const call = {
  catalog: false,
  slug: 'ai-classify',
  manifest,
  path: ['steps', 0],
  input: {
    'llm.data': { thread: [{ user_id: 'U01MIRA2Q', text: 'Dana Whitfield is waiting on the addendum.' }] },
    'llm.categories': ['needs_reply', 'fyi'],
    'llm.pii_fields': { thread: 'content' },
  },
} as never;
const domain = { stage: 'prepare', admit: () => ({}) } as never;

const dbs: Database.Database[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
});
const reviewedRequest = (executor: ServerExecutorConfig): string => {
  const db = new Database(':memory:');
  dbs.push(db);
  const identity = createPreapprovalAi({ db, executor })(call, domain);
  return JSON.stringify((identity!.normalized_input as { reviewed_request: unknown }).reviewed_request);
};

describe('D-316 amendment — the reviewed AI request carries the executor\'s match', () => {
  it('the owner reviews the aliased request, the one the run will send', () => {
    const reviewed = reviewedRequest(executorWith(() => source));
    expect(reviewed).not.toContain('Dana Whitfield');
    expect(reviewed).toContain('pii.Person1');
    // The same build twice: what the run's hash check compares against.
    expect(reviewedRequest(executorWith(() => source))).toBe(reviewed);
  });

  it('without a matcher the review keeps the text, as the run would', () => {
    expect(reviewedRequest(executorWith())).toContain('Dana Whitfield');
  });
});
