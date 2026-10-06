/** A step's legacy `pii_fields` are hashed at dispatch, over the input as RESOLVED.
 *
 *  The engine used to hash the step's raw input, where a value is still a `{{ref}}`:
 *  - data reaching the step through a ref was never looked inside
 *    (`"llm.prompt": "{{step.ai_context}}"` sent `ai_context.deal_name` to the model
 *    in clear — `compute-deal-risk-hubspot`, `intelligence-deal-360-hubspot`);
 *  - a ref under a named key was itself swapped for the token, so the call got a
 *    token for the ref's TEXT and never the data.
 *  Here the input is resolved once, the named values are hashed, the adapter is
 *  called, and the real values go back into what it returns. */

import { describe, expect, it } from 'vitest';
import { resolveDeep, type IngredientKind, type IngredientManifest, type NamespaceStores } from '@recued/contracts';

import { createIngredientExecutor, type Adapter } from '../dispatch.js';
import type { ManifestLoader } from '../types.js';

const aiManifest: IngredientManifest = {
  slug: 'ai-prompt',
  name: 'Prompt',
  description: 'fixture',
  author: 'recued',
  kind: 'ai',
  category: 'ai',
  risk_tier: 'read',
  input: { 'llm.system_prompt': 'Be brief.' },
  output: {},
};

const stores = (): NamespaceStores => ({
  vault: {},
  config: { marker: 'LEAKED-VALUE' },
  context: {},
  meta: {},
  step: {
    ai_context: { deal_name: 'Acme Expansion', stage: 'negotiation', notes: 'call {{config.marker}} first' },
    deal: { name: 'Acme Expansion' },
  },
});

type Reply = (input: Record<string, unknown>) => unknown;

const dispatcher = (manifest: IngredientManifest, reply: Reply) => {
  const seen: Record<string, unknown>[] = [];
  const adapter: Adapter = async (call) => {
    seen.push(call.input);
    return reply(call.input);
  };
  const run = stores();
  const exec = createIngredientExecutor({
    manifestLoader: (async () => manifest) as ManifestLoader,
    kernelAdapter: adapter,
    adapterRegistry: { ai: adapter } as Partial<Record<IngredientKind, Adapter>> as never,
    resolveRefs: (o) => resolveDeep(o, run) as Record<string, unknown>,
  });
  return { seen, exec };
};

const prompt = (input: Record<string, unknown>) => input['llm.prompt'] as Record<string, unknown>;

describe('step pii_fields — hashed at dispatch, over the resolved input', () => {
  it('a value that arrives through a ref is hashed before the adapter sees it, and restored after', async () => {
    const { seen, exec } = dispatcher(aiManifest, (input) => ({ result: `${String(prompt(input).deal_name)} is at risk` }));

    const result = await exec('ai-prompt', { 'llm.prompt': '{{step.ai_context}}' }, undefined, { pii_fields: ['deal_name'] }, undefined);

    expect(seen).toEqual([{
      'llm.system_prompt': 'Be brief.',
      'llm.prompt': { deal_name: 'HASH_STEP_00000001', stage: 'negotiation', notes: 'call {{config.marker}} first' },
    }]);
    expect(result).toEqual({ result: 'Acme Expansion is at risk' });
  });

  it('⛔ a ref under a named key is resolved, then hashed: the restore gives back the DATA, never the ref text', async () => {
    const { seen, exec } = dispatcher(aiManifest, (input) => ({ result: prompt(input).deal_name }));

    const result = await exec(
      'ai-prompt', { 'llm.prompt': { deal_name: '{{step.deal.name}}', ask: 'summarize' } }, undefined,
      { pii_fields: ['deal_name'] }, undefined,
    );

    expect(prompt(seen[0]!)).toEqual({ deal_name: 'HASH_STEP_00000001', ask: 'summarize' });
    expect(result).toEqual({ result: 'Acme Expansion' });
  });

  it('⛔ the input is resolved ONCE: `{{…}}` text inside the data reaches the adapter as text', async () => {
    const { seen, exec } = dispatcher(aiManifest, () => ({ result: 'ok' }));
    await exec('ai-prompt', { 'llm.prompt': '{{step.ai_context}}' }, undefined, { pii_fields: ['deal_name'] }, undefined);
    expect(prompt(seen[0]!).notes).toBe('call {{config.marker}} first');
    expect(JSON.stringify(seen)).not.toContain('LEAKED-VALUE');
  });

  it('the result comes back structured, keys and nested values included', async () => {
    const { exec } = dispatcher(aiManifest, () => ({
      HASH_STEP_00000001: { owner: 'HASH_STEP_00000001', notes: ['about HASH_STEP_00000001'] },
    }));
    const result = await exec('ai-prompt', { 'llm.prompt': '{{step.ai_context}}' }, undefined, { pii_fields: ['deal_name'] }, undefined);
    expect(result).toEqual({ 'Acme Expansion': { owner: 'Acme Expansion', notes: ['about Acme Expansion'] } });
  });

  it('the same call hashes to the same request — a pre-approval compares the two', async () => {
    const { seen, exec } = dispatcher(aiManifest, () => ({ result: 'ok' }));
    const step = { 'llm.prompt': { deal_name: '{{step.deal.name}}', more: [{ deal_name: 'Globex' }] } };
    await exec('ai-prompt', step, undefined, { pii_fields: ['deal_name'] }, undefined);
    await exec('ai-prompt', step, undefined, { pii_fields: ['deal_name'] }, undefined);
    expect(seen[1]).toEqual(seen[0]);
    expect(prompt(seen[0]!)).toEqual({ deal_name: 'HASH_STEP_00000001', more: [{ deal_name: 'HASH_STEP_00000002' }] });
  });

  it('without pii_fields the adapter gets the resolved input and its answer comes back untouched', async () => {
    const answer = { result: 'HASH_STEP_00000001 stays as it is' };
    const { seen, exec } = dispatcher(aiManifest, () => answer);
    const result = await exec('ai-prompt', { 'llm.prompt': '{{step.ai_context}}' }, undefined, { pii_fields: [] }, undefined);
    expect(prompt(seen[0]!).deal_name).toBe('Acme Expansion');
    expect(result).toBe(answer);
  });

  // ⛔ The hash used to walk a list under a named key, so a mail's `to` went out whole.
  it('a list under a named key — a mail\'s `to` — is hashed item by item and restored', async () => {
    const { seen, exec } = dispatcher(aiManifest, (input) => ({ result: `Reply to ${(prompt(input).to as string[]).join(' and ')}` }));
    const result = await exec(
      'ai-prompt',
      { 'llm.prompt': { to: ['lee@acme.example', 'kim@acme.example'], subject: 'Renewal' } },
      undefined, { pii_fields: ['to'] }, undefined,
    );
    expect(prompt(seen[0]!)).toEqual({ to: ['HASH_STEP_00000001', 'HASH_STEP_00000002'], subject: 'Renewal' });
    expect(JSON.stringify(seen)).not.toContain('acme.example');
    expect(result).toEqual({ result: 'Reply to lee@acme.example and kim@acme.example' });
  });

  it('a kernel step still drops the placeholders it did not supply, after the hash', async () => {
    const kernel: IngredientManifest = {
      ...aiManifest, slug: 'note-write', kind: 'storage', category: 'data', risk_tier: 'write',
      input: { name: null, note: null },
    };
    const { seen, exec } = dispatcher(kernel, () => ({ saved: true }));
    await exec('note-write', { name: '{{step.deal.name}}' }, undefined, { pii_fields: ['name'] }, undefined);
    expect(seen).toEqual([{ name: 'HASH_STEP_00000001' }]);
  });
});
