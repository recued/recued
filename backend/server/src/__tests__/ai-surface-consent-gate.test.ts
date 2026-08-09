/** A producer that spends tokens must say so, or every owner-consent
 *  control silently disengages at once.
 *
 *  ⛔ THE DEFECT. `buildEnrichmentProducerTask` derives
 *  `isAiSurface = producer.ai_surface !== undefined
 *                 && producer.estimate_per_record_tokens() > 0`
 *  — BOTH terms. `summary`, `purpose` and `action_items` each declared a
 *  positive estimate (600 / 250 / 400 tokens per record) and omitted
 *  `ai_surface`, so all three resolved to `isAiSurface === false` while calling
 *  `executeLLM`. Everything that protects the owner keys on that one flag:
 *
 *    - `resolveEnrichmentTrustDefault(topic, false)` returns `'auto'` rather
 *      than `'manual'`, and `isEligibleForIdleCycle` admits `'auto'` — so the
 *      producer ran AI on idle housekeeping cycles with NO owner action;
 *    - that same gate's pause check is `isAiSurface && isAiPaused(...)`, so the
 *      top-bar Pause-AI control did not stop them;
 *    - `enrichment-producer.ts` applies `wrapCtxWithForceLayer` only when
 *      `isAiSurface`, so the owner's `pool_policy` (`free_only` / `byok_only`)
 *      was not enforced for their calls either.
 *
 *  🔑 THE SUBSTRATE WAS RIGHT AND THE DECLARATION WAS WRONG. D-132's
 *  `assertEnrichmentTrustDefaults` already refuses a declared
 *  `default_trust_state: 'auto'` on an AI surface, and
 *  `resolveEnrichmentTrustDefault` already defaults an AI surface to
 *  `'manual'`. Both are keyed on `isAiSurface`, so a producer that fails to
 *  identify itself walks past all of it — the guard was load-bearing and
 *  unreachable.
 *
 *  ⚠ WHY THE OMISSION IS ASSERTED, NOT DEFAULTED. `ai_surface`'s own doc says
 *  "defaults treated as 'chat' for backward-compat", and each producer's header
 *  claimed a positive estimate made it "manual-only by construction". Neither
 *  matched the code. Quietly defaulting to `'chat'` would make the SAFE reading
 *  of a missing field depend on a comment; the failure it hides is "AI ran
 *  without being asked", so it throws at construction instead.
 *
 *  ⚠ Trust defaults are SYNTHESIZED per read, not persisted —
 *  `TrustStore.read` returns `synthesizeDefault(...)` when no row exists. So
 *  correcting the declaration fixes servers already running, not just fresh
 *  ones. An owner who explicitly wrote a trust row still wins, which is right. */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { resolveEnrichmentTrustDefault } from '@recued/contracts';

import { actionItemsProducer } from '../housekeeping/producers/action-items.js';
import { purposeProducer } from '../housekeeping/producers/purpose.js';
import { summaryProducer } from '../housekeeping/producers/summary.js';
import { roleProducer } from '../housekeeping/producers/role.js';

const PRODUCER_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../housekeeping/producers');

/** ⛔ READ THE FLAG THE BUILDER ACTUALLY PRODUCES, never a local copy of its
 *  expression. The first version of this file re-implemented
 *  `ai_surface !== undefined && estimate_per_record_tokens() > 0` here and
 *  asserted against THAT — so mutating the production derivation to
 *  `const isAiSurface = false` (reintroducing the defect for every producer at
 *  once) left all five cases GREEN. A test that carries its own copy of the
 *  rule proves the rule's shape and nothing about the wiring.
 *
 *  `buildEnrichmentProducerTask` sets `is_ai_surface` on the task from the
 *  production `const`, so building the real task is the only honest read. */
const builtAiSurface = async (producer: unknown): Promise<boolean> => {
  const { buildEnrichmentProducerTask } = await import('../housekeeping/enrichment-producer.js');
  const task = buildEnrichmentProducerTask({ producer } as never) as { is_ai_surface?: boolean };
  return task.is_ai_surface === true;
};

describe('AI-surface consent gate', () => {
  it('⛔ every LLM-reaching producer in the tree declares `ai_surface`', () => {
    // The sweep that found this, kept as the guard. Reads SOURCE rather than a
    // registry export because there is no runtime list of producers to walk —
    // a new file that forgets the field is exactly the regression, and it would
    // be invisible to any check that only knows about the producers already
    // wired up.
    const offenders: string[] = [];
    const checked: string[] = [];
    for (const file of readdirSync(PRODUCER_DIR).filter((f) => f.endsWith('.ts'))) {
      if (file.startsWith('_')) continue;               // shared helpers, not producers
      const raw = readFileSync(join(PRODUCER_DIR, file), 'utf8');
      // Comments discuss AI freely; only code counts.
      const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, '');
      const reachesLlm = /kind:\s*'ai'/.test(code) || /executeLLM\(/.test(code);
      if (!reachesLlm) continue;
      checked.push(file);
      const declaresSurface = /\n\s{2}(?:ai_surface|is_ai_surface):/.test(code);
      if (!declaresSurface) offenders.push(file);
    }
    // A floor, so a glob that silently matches nothing cannot pass as clean.
    expect(checked.length, 'no LLM-reaching producers found — did the tree move?')
      .toBeGreaterThanOrEqual(10);
    expect(offenders, 'these call an LLM but declare no AI surface').toEqual([]);
  });

  it('⛔ the three that were wrong now resolve to `manual`, not `auto`', async () => {
    for (const p of [actionItemsProducer, purposeProducer, summaryProducer]) {
      const q = p as unknown as { topic: string; estimate_per_record_tokens: () => number };
      expect(q.estimate_per_record_tokens(), `${q.topic} must still cost tokens`)
        .toBeGreaterThan(0);
      // The flag the BUILDER derives — not a local re-implementation of it.
      const isAi = await builtAiSurface(p);
      expect(isAi, `${q.topic} derives isAiSurface through the builder`).toBe(true);
      expect(resolveEnrichmentTrustDefault(q.topic as never, isAi), q.topic).toBe('manual');
    }
    // The control: role was always correct, and must stay so.
    expect(await builtAiSurface(roleProducer), 'role').toBe(true);
  });

  it('⛔ KNOWN NEGATIVE: without the flag the SAME topics resolve to `auto`', () => {
    // Proves the assertions above discriminate — and states the defect's
    // consequence in one line. This is what the three topics did in production.
    for (const p of [actionItemsProducer, purposeProducer, summaryProducer]) {
      const q = p as unknown as { topic: string };
      expect(resolveEnrichmentTrustDefault(q.topic as never, false), q.topic).toBe('auto');
    }
    // ...and the control: a deterministic topic is legitimately 'auto'.
    expect(resolveEnrichmentTrustDefault('reply_patterns' as never, false)).toBe('auto');
  });

  it('⛔ a positive token estimate WITHOUT `ai_surface` is refused at construction', async () => {
    // The footgun removed rather than the instance patched: the next producer
    // cannot repeat this, because the pair is checked where it is derived.
    const { buildEnrichmentProducerTask } = await import('../housekeeping/enrichment-producer.js');
    const bad = { ...roleProducer } as Record<string, unknown>;
    delete bad.ai_surface;
    // ⚠ The builder takes an OPTIONS OBJECT, not a bare producer. Passing the
    // producer directly makes `opts.producer` undefined and throws
    // "Cannot read properties of undefined" — which `toThrow(/regex/)` would
    // happily report as a failure to match, not as a malformed call. Asserting
    // the specific code is what separates the two.
    expect(() => buildEnrichmentProducerTask({ producer: bad } as never))
      .toThrow(/enrichment_ai_surface_undeclared/);

    // ...and the same call with the field present gets PAST this check — so the
    // throw above is the flag, not the fixture being unbuildable in general.
    expect(() => buildEnrichmentProducerTask({ producer: roleProducer } as never))
      .not.toThrow(/enrichment_ai_surface_undeclared/);
  });

  it('a producer that spends NO tokens may omit `ai_surface`', async () => {
    // The permitting case. Deterministic producers are the majority and must
    // stay declaration-free — a rule that only ever refuses would be
    // indistinguishable from banning the field's absence outright. Driven
    // through the real builder, so it also proves the new assert does not fire.
    const deterministic = { ...roleProducer, estimate_per_record_tokens: () => 0 } as
      Record<string, unknown>;
    delete deterministic.ai_surface;
    expect(await builtAiSurface(deterministic)).toBe(false);
  });
});
