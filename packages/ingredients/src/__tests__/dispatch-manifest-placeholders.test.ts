/** A manifest's `null` is a placeholder, and a kernel step never receives one
 *  the caller did not write.
 *
 *  Manifests declare optional inputs as `null` ("exists, no default"), and
 *  `mergeManifestStepInput` spreads them under the step's args, so an input the
 *  caller OMITTED reached the handler as `null`. The 2026-09-24 audit of every
 *  kernel step found handlers reading that `null` as a value:
 *  - paid passes became permanent;
 *  - plan changes were refused;
 *  - calendars read empty;
 *  - project and work-entity steps threw;
 *  - booking slots were wiped.
 *
 *  These cases pin the rule at the one place both halves are known: what the
 *  kernel adapter receives, what it must still receive, and what the provider
 *  adapters must go on receiving unchanged. */

import { describe, expect, it } from 'vitest';
import type { IngredientKind, IngredientManifest } from '@recued/contracts';

import { createIngredientExecutor, withoutManifestPlaceholders, type Adapter } from '../dispatch.js';
import type { ManifestLoader } from '../types.js';

const manifest = (overrides: Partial<IngredientManifest>): IngredientManifest => ({
  slug: 'grant-pass',
  name: 'Grant a pass',
  description: 'fixture',
  author: 'recued',
  kind: 'storage',
  category: 'data',
  risk_tier: 'write',
  // `tier` is required (no default); `period_end` and `email` are optional, and
  // null is the manifest's placeholder for "no default"; `channel` has a real default.
  input: { tier: null, period_end: null, email: null, channel: 'in_app' },
  output: {},
  ...overrides,
});

const run = async (m: IngredientManifest, step: Record<string, unknown>, resolveRefs?: (o: Record<string, unknown>) => Record<string, unknown>) => {
  const seen: Array<{ slot: string; input: Record<string, unknown> }> = [];
  const spy = (slot: string): Adapter => async (call) => { seen.push({ slot, input: call.input }); return {}; };
  const loader: ManifestLoader = async () => m;
  const exec = createIngredientExecutor({
    manifestLoader: loader,
    kernelAdapter: spy('kernel'),
    adapterRegistry: { ai: spy('ai'), connection: spy('connection'), dom: spy('dom') } as Partial<Record<IngredientKind, Adapter>> as never,
    ...(resolveRefs ? { resolveRefs } : {}),
  });
  await exec(m.slug, step, undefined, undefined, undefined);
  return seen[0]!;
};

describe('a kernel step never receives a placeholder null', () => {
  it('⛔ an omitted optional input is ABSENT, not null — a real default still applies', async () => {
    const { slot, input } = await run(manifest({}), { tier: 'monthly' });
    expect(slot).toBe('kernel');
    expect(input).toEqual({ tier: 'monthly', channel: 'in_app' });
    expect('period_end' in input).toBe(false);
  });

  it('⛔ a null the CALLER writes is theirs, and arrives (seller period_end: open-ended)', async () => {
    const { input } = await run(manifest({}), { tier: 'monthly', period_end: null });
    expect(input).toEqual({ tier: 'monthly', period_end: null, channel: 'in_app' });
  });

  it('a step value that resolves to null is the caller\'s too, and stays', async () => {
    const { input } = await run(
      manifest({}),
      { tier: 'monthly', email: '{{config.email}}' },
      (o) => ({ ...o, email: o.email === '{{config.email}}' ? null : o.email }),
    );
    expect(input).toEqual({ tier: 'monthly', email: null, channel: 'in_app' });
  });

  it('a required input the caller omits is absent too, and the handler refuses it as before', async () => {
    const { input } = await run(manifest({}), {});
    expect(input).toEqual({ channel: 'in_app' });
  });
});

describe('the provider adapters receive exactly what they did', () => {
  // A pre-approval checks that each provider call's input hashes EXACTLY to the one
  // it reviewed, which was built with the placeholders (`validateProvider`).
  for (const kind of ['ai', 'connection', 'dom'] as const) {
    it(`${kind}: the placeholders still arrive`, async () => {
      const { slot, input } = await run(manifest({ kind, input: { 'llm.data': null, 'llm.focus': null } }), { 'llm.data': 'x' });
      expect(slot).toBe(kind);
      expect(input).toEqual({ 'llm.data': 'x', 'llm.focus': null });
    });
  }
});

describe('withoutManifestPlaceholders', () => {
  it('returns the same object when there is nothing to drop', () => {
    const input = { tier: 'monthly', channel: 'in_app' };
    expect(withoutManifestPlaceholders(input, { tier: null, channel: 'in_app' }, { tier: 'monthly' })).toBe(input);
  });

  it('keeps a key the manifest does not declare, even when null', () => {
    expect(withoutManifestPlaceholders({ extra: null }, { tier: null }, { extra: null })).toEqual({ extra: null });
  });
});
