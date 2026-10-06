/**
 * Every prompt input a contracted AI manifest declares must reach the prompt.
 *
 * ⛔ `ai-extract` accepted `llm.context` and never read it. Four housekeeping
 * producers (`role`, `company`, `related_threads`, `topic_cluster`) and the shipped
 * `deal-handoff-brief-hubspot` steered extraction with text the model never saw —
 * two of them described in it the very shape they parse. No test noticed: a stub
 * model answers whatever it is asked, so only the prompt itself can show the gap.
 */
import { buildContractedPrompt, isContractedSlug } from '@recued/llm';
import { describe, expect, it } from 'vitest';

import { KERNEL_MANIFESTS } from '../kernel-manifests.js';

/** These decide how the call is made (model slot, batch mode), not what it says. */
const ROUTING_KEYS = new Set(['llm.model_hint', 'llm.id_field']);
const LIST_KEYS = new Set(['llm.categories', 'llm.fields', 'llm.criteria', 'llm.dimensions']);
const marker = (key: string): string => `MARK_${key.slice('llm.'.length).toUpperCase()}`;
const valueFor = (key: string): unknown =>
  key === 'llm.max_length' ? 987 : LIST_KEYS.has(key) ? [marker(key)] : marker(key);
const shownAs = (key: string): string => (key === 'llm.max_length' ? '987' : marker(key));

const contracted = KERNEL_MANIFESTS.filter((m) => isContractedSlug(m.slug));

describe('every prompt input a contracted AI manifest declares reaches the prompt', () => {
  it('covers every contracted function, bare and core-', () => {
    expect(contracted.length).toBe(18);
  });

  for (const manifest of contracted) {
    it(`${manifest.slug}: each declared input shows in the prompt, and the prompt reads nothing undeclared`, () => {
      const declared = Object.keys(manifest.input ?? {});
      const keys = declared.filter((key) => key.startsWith('llm.') && !ROUTING_KEYS.has(key));
      const read = new Set<string>();
      const input = new Proxy(Object.fromEntries(keys.map((key) => [key, valueFor(key)])), {
        get: (target, key) => {
          if (typeof key === 'string') read.add(key);
          return target[key as string];
        },
      });
      const prompt = buildContractedPrompt(manifest.slug, input).map((m) => m.content).join('\n');
      expect(keys.filter((key) => !prompt.includes(shownAs(key)))).toEqual([]);
      // The converse: an input the builder reads must be one the manifest declares,
      // or nothing tells an author it exists. (The batch switch reads `llm.id_field`
      // for every slug, `ai-compare` included.)
      expect([...read].filter(
        (key) => key.startsWith('llm.') && !ROUTING_KEYS.has(key) && !declared.includes(key),
      )).toEqual([]);
    });
  }
});
