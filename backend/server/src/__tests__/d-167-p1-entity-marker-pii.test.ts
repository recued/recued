/** D-167 P1 — E.1 resolver entity-keying + the model-bound `__entity` strip.
 *
 *  P1 teaches the resolver to tag PII by an inline `__entity` marker (decoupled
 *  from `source_operations`) and pins the strip that removes the marker before a
 *  packet reaches the model. NO producer stamps markers yet, so production stays
 *  byte-identical (the 154 existing D-167 tests prove it) — these tests INJECT
 *  the entity tags / markers directly to exercise the new mechanics:
 *
 *    (a) a `__entity:'contact'` record resolves to the bare contact field tags
 *        rooted at its path; an unmarked record resolves to nothing new;
 *    (b) the model-bound `llm.prompt` carries NO `__entity` key after egress
 *        (the hard egress invariant, on BOTH the alias path and the no-field
 *        early path), while real values are still aliased;
 *    (c) byte-identity: an empty entity index / a no-marker packet leaves
 *        resolution + the egress prompt unchanged.
 *
 *  Spec: D-160 §E.1 + §"Hard invariants".
 */

import {
  type AIOutput,
  type EntityPrivacyTag,
  type EntitySchemaIngredientInput,
  type IngredientManifest,
  type PiiAliasableData,
} from '@recued/contracts';
import { piiEgress } from '@recued/gateway';
import { describe, expect, it } from 'vitest';

import { CANONICAL_PII_ENTITY_PRIVACY_TAGS } from '../canonical-pii-schemas.js';
import { createMetaFieldPrivacyResolver } from '../meta-field-privacy-resolver.js';
import {
  wrapExecuteAiCallForPii,
  type PiiEgressPlan,
} from '../chat-pii-egress.js';
import type { ExecuteChatAiCall } from '../chat-orchestrator.js';

const MANIFEST = {} as IngredientManifest;

/** The bare contact/deal markers P2 will stamp. */
const ENTITY_TAGS = CANONICAL_PII_ENTITY_PRIVACY_TAGS;

/** A resolver over a given entity-tag set (no operation schemas). */
const entityResolver = (tags: readonly EntityPrivacyTag[] = ENTITY_TAGS) =>
  createMetaFieldPrivacyResolver({
    getEntitySchemas: () => [],
    getEntityPrivacyTags: () => tags,
  });

const hasTag = (
  tags: readonly { path: string; kind: string }[],
  path: string,
  kind: string,
): boolean => tags.some((t) => t.path === path && t.kind === kind);

/** True if any object anywhere under `value` still carries an `__entity` key. */
const hasEntityMarkerAnywhere = (value: unknown): boolean => {
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(hasEntityMarkerAnywhere);
  const record = value as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(record, '__entity')) return true;
  return Object.values(record).some(hasEntityMarkerAnywhere);
};

/** A `PiiEgressPlan` with a fresh single-session ledger + the given resolver. */
const makePlan = (resolver: piiEgress.FieldPrivacyResolver): PiiEgressPlan => ({
  active: true,
  ledger: piiEgress.createSessionLedgerStore().getOrCreate('s'),
  resolver,
  summary: { value: { mode: 'alias', scope_kind: 'session', counts: {} } },
});

/** Run a prompt through the wire seam and capture the model-bound `llm.prompt`. */
const egress = async (
  plan: PiiEgressPlan,
  prompt: string,
): Promise<{ rawPrompt: string; packet: Record<string, unknown> }> => {
  let rawPrompt = '';
  const real: ExecuteChatAiCall = async (_m, input) => {
    rawPrompt = String(input['llm.prompt']);
    return { body: { response: 'ok', events: [], tool_calls: [] } satisfies AIOutput };
  };
  await wrapExecuteAiCallForPii(real, plan)(MANIFEST, { 'llm.prompt': prompt });
  let packet: Record<string, unknown> = {};
  try {
    packet = JSON.parse(rawPrompt) as Record<string, unknown>;
  } catch {
    /* non-JSON prompt — leave packet empty */
  }
  return { rawPrompt, packet };
};

describe('D-167 P1 — E.1 entity-marker resolution', () => {
  it('tags a `__entity:contact` record with the bare contact fields rooted at its path', () => {
    const resolver = entityResolver();
    const packet = {
      prior_tool_calls: [
        {
          tool_name: 'contact.search',
          result: {
            candidates: [
              { record: { __entity: 'contact', email: 'alice@acme.com', name: 'Alice Chen', target_id: 'alice@acme.com' } },
            ],
          },
        },
      ],
    } as unknown as PiiAliasableData;

    const tags = resolver(packet);
    const base = 'prior_tool_calls.0.result.candidates.0.record';
    expect(hasTag(tags, `${base}.email`, 'email')).toBe(true);
    expect(hasTag(tags, `${base}.name`, 'name')).toBe(true);
    // `target_id` is the canonical email for local contacts — tagged `email`.
    expect(hasTag(tags, `${base}.target_id`, 'email')).toBe(true);
    // The marker key itself is never tagged.
    expect(tags.some((t) => t.path.endsWith('__entity'))).toBe(false);
  });

  it('resolves nothing new for an UNMARKED record (byte-identical to no entity walk)', () => {
    const resolver = entityResolver();
    const packet = {
      prior_tool_calls: [
        { tool_name: 'contact.search', result: { candidates: [{ record: { email: 'alice@acme.com', name: 'Alice Chen' } }] } },
      ],
    } as unknown as PiiAliasableData;
    // No `__entity` marker anywhere → the entity walk emits nothing, and no
    // operation schemas are wired → the whole resolve is empty.
    expect(resolver(packet)).toEqual([]);
  });

  it('resolves nothing for an UNKNOWN `__entity` value not in the index', () => {
    const resolver = entityResolver();
    const packet = { record: { __entity: 'invoice', email: 'x@y.com' } } as unknown as PiiAliasableData;
    expect(resolver(packet)).toEqual([]);
  });

  it('is a no-op when NO entity tags are wired (empty index) even with a marker present', () => {
    const resolver = entityResolver([]);
    const packet = { record: { __entity: 'contact', email: 'x@y.com' } } as unknown as PiiAliasableData;
    expect(resolver(packet)).toEqual([]);
  });

  it('tags a deal `owner` but NOT the title or vendor target_id', () => {
    const resolver = entityResolver();
    const packet = {
      record: { __entity: 'deal', name: 'Acme Renewal Q3', target_id: 'hubspot_deal_42', owner: 'dana@acme.com', amount: 5000 },
    } as unknown as PiiAliasableData;
    const tags = resolver(packet);
    expect(hasTag(tags, 'record.owner', 'email')).toBe(true);
    expect(tags.some((t) => t.path === 'record.name')).toBe(false);
    expect(tags.some((t) => t.path === 'record.target_id')).toBe(false);
  });

  it('tags an account `owner` but NOT the company name / domain / vendor target_id', () => {
    const resolver = entityResolver();
    const packet = {
      record: {
        __entity: 'account', name: 'Acme Inc', target_id: 'hubspot_company_acme-hubspot_a1',
        domain: 'acme.com', owner: 'rep@acme.com', industry: 'Software',
      },
    } as unknown as PiiAliasableData;
    const tags = resolver(packet);
    expect(hasTag(tags, 'record.owner', 'email')).toBe(true);
    expect(tags.some((t) => t.path === 'record.name')).toBe(false);
    expect(tags.some((t) => t.path === 'record.domain')).toBe(false);
    expect(tags.some((t) => t.path === 'record.target_id')).toBe(false);
  });

  it('emits tags for a by-ref re-embedded record at EVERY path (DAG ok, no global-visited starvation)', () => {
    const resolver = entityResolver();
    const rec = { __entity: 'contact', email: 'x@y.com' };
    // The same object reference under two keys — the confidence-shape re-embed shape.
    const packet = { top: rec, alt: rec } as unknown as PiiAliasableData;
    const tags = resolver(packet);
    expect(hasTag(tags, 'top.email', 'email')).toBe(true);
    expect(hasTag(tags, 'alt.email', 'email')).toBe(true);
  });

  it('does not hang on a self-referential cycle (DFS-ancestor cycle guard)', () => {
    const resolver = entityResolver();
    const node: Record<string, unknown> = { __entity: 'contact', email: 'x@y.com' };
    node.self = node; // cycle
    const tags = resolver({ root: node } as unknown as PiiAliasableData);
    // The marked record is tagged once at its real path; the cycle is cut.
    expect(hasTag(tags, 'root.email', 'email')).toBe(true);
  });

  it('does not descend prototype-unsafe keys', () => {
    const resolver = entityResolver();
    // A `__proto__` OWN key (raw JSON, not an object literal) carrying a marker
    // must not be walked into.
    const packet = JSON.parse(
      '{"safe":{"__entity":"contact","email":"a@b.com"},"__proto__":{"__entity":"contact","email":"evil@x.com"}}',
    ) as PiiAliasableData;
    const tags = resolver(packet);
    expect(hasTag(tags, 'safe.email', 'email')).toBe(true);
    expect(tags.some((t) => t.path.includes('__proto__'))).toBe(false);
    expect(tags.some((t) => t.path.includes('evil'))).toBe(false);
  });

  it('DEDUPS a `(path, kind)` produced by BOTH an explicit operation path and the marker (P2 overlap safety)', () => {
    // A `contact.search`-style operation schema tagging `candidates[].record.email`
    // AND a `__entity:contact` marker on the same record both resolve to the SAME
    // full path — the shared `seen` set collapses them so P2 (markers + explicit
    // paths coexisting) never double-aliases.
    const searchSchema: EntitySchemaIngredientInput = {
      ingredient_id: 'x',
      entity_id: 'contact',
      scope: 'data.entity.contact_search',
      projection_mode: 'contributing_source',
      schema_mode: 'static',
      target_id: { fields: ['email'], template: '{email}' },
      meta_fields: [
        { key: 'candidate_email', type: 'string', source_path: 'candidates[].record.email', privacy: 'email' },
      ],
      source_operations: { search: { catalog: 'x', operation: 'contact.search' } },
    };
    const resolver = createMetaFieldPrivacyResolver({
      getEntitySchemas: () => [searchSchema],
      getEntityPrivacyTags: () => ENTITY_TAGS,
    });
    const packet = {
      prior_tool_calls: [
        {
          tool_name: 'contact.search',
          result: { candidates: [{ record: { __entity: 'contact', email: 'a@b.com' } }] },
        },
      ],
    } as unknown as PiiAliasableData;
    const tags = resolver(packet);
    const path = 'prior_tool_calls.0.result.candidates.0.record.email';
    expect(tags.filter((t) => t.path === path && t.kind === 'email')).toHaveLength(1);
  });

  it('declares contact (email/name/target_id/phone/company) + deal (owner) + account (owner) in the shipped tag set', () => {
    const contact = ENTITY_TAGS.find((t) => t.entity_id === 'contact');
    const deal = ENTITY_TAGS.find((t) => t.entity_id === 'deal');
    const account = ENTITY_TAGS.find((t) => t.entity_id === 'account');
    // `phone` + `company` (D-167 B4) ride only on the prefetch's resolved payload
    // (contact.search results surface neither); tagging each seeds the turn ledger
    // so a user-typed known phone / org is aliased by the D-167 P4 user-message
    // pass. The `company → org` tag is a no-op for every other contact-marked
    // record (chat projections carry no `company`).
    expect(contact?.fields.map((f) => `${f.path}:${f.kind}`).sort()).toEqual([
      'company:org',
      'email:email',
      'name:name',
      'phone:phone',
      'target_id:email',
    ]);
    expect(deal?.fields.map((f) => `${f.path}:${f.kind}`)).toEqual(['owner:email']);
    expect(account?.fields.map((f) => `${f.path}:${f.kind}`)).toEqual(['owner:email']);
  });
});

describe('D-167 P1 — `__entity` strip at the model-bound seam (hard egress invariant)', () => {
  it('removes every `__entity` key from the model-bound prompt while aliasing real values', async () => {
    const plan = makePlan(entityResolver());
    const prompt = JSON.stringify({
      user_message: 'find Alice',
      prior_tool_calls: [
        {
          tool_name: 'contact.search',
          result: {
            candidates: [
              { record: { __entity: 'contact', email: 'alice@acme.com', name: 'Alice Chen', target_id: 'alice@acme.com' } },
              { record: { __entity: 'contact', email: 'bob@acme.com', name: 'Bob Ng', target_id: 'bob@acme.com' } },
            ],
          },
        },
      ],
    });
    const { rawPrompt, packet } = await egress(plan, prompt);

    // (1) The hard invariant — no `__entity` reaches the model, structurally OR
    // textually.
    expect(hasEntityMarkerAnywhere(packet)).toBe(false);
    expect(rawPrompt).not.toContain('__entity');

    // (2) The marked records were still aliased (the strip runs AFTER aliasing).
    const record = (
      packet.prior_tool_calls as Array<{
        result: { candidates: Array<{ record: { email: string; name: string; target_id: string } }> };
      }>
    )[0]!.result.candidates[0]!.record;
    expect(record.email).toBe('m1@d1.invalid');
    expect(record.name).toBe('pii.Person1');
    expect(record.target_id).toBe('m1@d1.invalid');
    expect(rawPrompt).not.toContain('alice@acme.com');
    expect(rawPrompt).not.toContain('Alice Chen');
  });

  it('strips a marker on the NO-FIELD early path too (noop resolver, defence in depth)', async () => {
    // The noop resolver tags nothing → `aliasChatAiInput` takes the early path;
    // a marker stamped by a producer whose entity is not (yet) recognized must
    // STILL be stripped before egress.
    const plan = makePlan(piiEgress.noopFieldPrivacyResolver);
    const prompt = JSON.stringify({
      user_message: 'hi',
      prior_tool_calls: [{ result: { candidates: [{ record: { __entity: 'contact', email: 'a@b.com' } }] } }],
    });
    const { rawPrompt, packet } = await egress(plan, prompt);
    expect(hasEntityMarkerAnywhere(packet)).toBe(false);
    expect(rawPrompt).not.toContain('__entity');
    // The email is NOT aliased on this path (noop resolver) — the early strip is
    // marker-removal only, not aliasing.
    expect(rawPrompt).toContain('a@b.com');
  });

  it('strips a DEEPLY nested marker (no depth-bound escape — codex P2 regression)', async () => {
    // A marker nested far deeper than any real stamp must STILL be removed — the
    // strip is iterative + unbounded, fail-closed. The noop resolver forces the
    // no-field early path, which is exactly where a missed-strip would have sent
    // the original prompt (marker intact) to the model.
    const plan = makePlan(piiEgress.noopFieldPrivacyResolver);
    let node: Record<string, unknown> = { __entity: 'contact', email: 'deep@x.com' };
    for (let i = 0; i < 120; i += 1) node = { nested: node };
    const prompt = JSON.stringify({ user_message: 'hi', tree: node });
    const { rawPrompt, packet } = await egress(plan, prompt);
    expect(rawPrompt).not.toContain('__entity');
    expect(hasEntityMarkerAnywhere(packet)).toBe(false);
  });

  it('returns the prompt BYTE-IDENTICAL with the noop resolver and no markers present', async () => {
    const plan = makePlan(piiEgress.noopFieldPrivacyResolver);
    const prompt = JSON.stringify({
      user_message: 'ping',
      chat_tail: [{ role: 'user', content: 'hi alice@acme.com' }],
      prior_tool_calls: [{ result: { candidates: [{ record: { email: 'a@b.com' } }] } }],
    });
    const { rawPrompt } = await egress(plan, prompt);
    // No tagged field AND no marker → the original input string is returned
    // untouched (no parse→re-serialize), the load-bearing byte-identity invariant.
    expect(rawPrompt).toBe(prompt);
  });

  it('preserves prototype-unsafe keys byte-identical on the no-marker noop path', async () => {
    const plan = makePlan(piiEgress.noopFieldPrivacyResolver);
    const prompt =
      '{"user_message":"hi","prior_tool_calls":[{"result":{"constructor":"x","__proto__":"y","safe":1}}]}';
    const { rawPrompt } = await egress(plan, prompt);
    expect(rawPrompt).toBe(prompt);
  });
});
