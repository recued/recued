/** D-167 P2 — stamp + prefetch entity part + the N.10.2 gather alias.
 *
 *  P2 makes the entity-marker pipeline LIVE: the 3 chat projections stamp
 *  `__entity` (every tool-result record born marked), the prompt-cache prefetch
 *  contributes a STRUCTURED entity part instead of pre-rendered text, and the
 *  chat-egress gather aliases that payload ONCE per turn against the turn's
 *  shared session ledger before rendering — so the model sees the SAME alias for
 *  a contact in the prefetch block, the tool results, AND the user's own message
 *  (N.10.2 ②). Closes `recued-substrate-bench` task 41 (prefetch PII leak).
 *
 *  These tests exercise the producer side (real projections stamp), the gather
 *  alias helper + its shared-ledger consistency (the bench-41 property), the
 *  prefetch render round-trip, and the N.10.2 ② content pass over
 *  user_message/chat_tail. Resolver tag-COVERAGE over a contact.search egress
 *  packet lives in `d-167-shipped-canonical-pii-schemas.test.ts`; the model-bound
 *  `__entity` strip + byte-identity live in `d-167-p1-entity-marker-pii.test.ts`.
 *
 *  Spec: docs/d-160-n10-part-pii-pending-design.md §E.2 + §N.10.1/N.10.2.
 */

import {
  type AIOutput,
  type ChatDispatchContext,
  type EntityPrivacyTag,
  type IngredientManifest,
  type PiiAliasableData,
} from '@recued/contracts';
import { piiEgress } from '@recued/gateway';
import type { EntityPromptPart, PromptPart, TurnContext } from '@recued/middleware';
import {
  contributePrefetch,
  type PrefetchCandidate,
} from '@recued/middleware-prompt-cache';
import { describe, expect, it } from 'vitest';

import { CANONICAL_PII_ENTITY_PRIVACY_TAGS } from '../canonical-pii-schemas.js';
import { createMetaFieldPrivacyResolver } from '../meta-field-privacy-resolver.js';
import {
  aliasEntityPayloadForEgress,
  renderEntityPartsForEgress,
  wrapExecuteAiCallForPii,
  type PiiEgressPlan,
} from '../chat-pii-egress.js';
import {
  buildChatTier1Handlers,
  type ChatToolHandlerDeps,
} from '../chat-tool-handlers.js';
import type { ExecuteChatAiCall } from '../chat-orchestrator.js';

const MANIFEST = {} as IngredientManifest;

/** A resolver over the shipped contact/deal entity-marker tags (no operation
 *  schemas) — the entity-keyed path P2 drives, independent of the explicit
 *  CONTACT_SEARCH/DEAL_SEARCH paths (which P3 retires). */
const entityResolver = (tags: readonly EntityPrivacyTag[] = CANONICAL_PII_ENTITY_PRIVACY_TAGS) =>
  createMetaFieldPrivacyResolver({
    getEntitySchemas: () => [],
    getEntityPrivacyTags: () => tags,
  });

/** A `PiiEgressPlan` with a fresh single-session ledger + the given resolver. */
const makePlan = (resolver: piiEgress.FieldPrivacyResolver): PiiEgressPlan => ({
  active: true,
  ledger: piiEgress.createSessionLedgerStore().getOrCreate('s'),
  resolver,
  summary: { value: { mode: 'alias', scope_kind: 'session', counts: {} } },
});

/** Run a prompt through the model-bound wire seam; capture the egress prompt. */
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
    /* non-JSON — leave empty */
  }
  return { rawPrompt, packet };
};

/** A `TurnContext` capturing contributed prompt parts (the prefetch hook). */
const makePromptCtx = (userText: string): { ctx: TurnContext; parts: PromptPart[] } => {
  const parts: PromptPart[] = [];
  const ctx = {
    session_id: 's',
    surface: 'chat',
    turn_index: 0,
    turn_id: 't',
    history: userText ? [{ role: 'user', text: userText }] : [],
    prompt: {
      contribute: (p: Record<string, unknown>) => parts.push({ source: 'prompt-cache', ...p } as PromptPart),
      parts: () => parts,
    },
    interjections: [],
    capacity: {},
    out: {},
    state: new Map<string, unknown>(),
    resolve: () => { throw new Error('prefetch must never resolve the turn'); },
  } as unknown as TurnContext;
  return { ctx, parts };
};

const fakeSearch = (out: readonly PrefetchCandidate[]) => () => out;

/** Minimal `ChatToolHandlerDeps` — every getter empty save the overrides. */
const depsStub = (overrides: Partial<ChatToolHandlerDeps> = {}): ChatToolHandlerDeps => {
  const deps: ChatToolHandlerDeps = {
    getContactStore: () => undefined,
    getCollectionRegistry: () => undefined,
    getAuditLog: () => undefined,
    getEnrichmentStore: () => undefined,
    getRecipeStore: () =>
      ({ ids: () => [], get: () => null, getStored: () => null, listStored: () => [] }) as never,
    getExecutorConfig: () => ({ manifests: { get: () => null } }) as never,
    getExecuteRecipe: () => undefined,
    // D-190 R2/R3 — the generic deal-source enumerator (the built-in CRM vendor set);
    // `deal.search` fans out over whatever this returns (no hardcoded vendor list).
    getBoundCrmMirrorSources: (crmAlias) =>
      crmAlias === 'deal'
        ? [
            { source_id: 'hubspot', scope: 'connection.api.hubspot.deal' },
            { source_id: 'salesforce', scope: 'connection.api.salesforce.opportunity' },
          ]
        : [],
    ...overrides,
  };
  // D-190 (generic reconciler MS3) — `deal.search` reads `getCrmRecordMirror().list`,
  // not the enrichment store. The deal fixtures here express data as a
  // `getEnrichmentStore().listScopeMeta` fake; `list` is a drop-in for `listScopeMeta`
  // (same `(scope, opts) -> rows` contract), so adapt it into the mirror getter when a
  // test doesn't stub the mirror. contact.search still reads the enrichment store directly.
  if (deps.getCrmRecordMirror === undefined) {
    deps.getCrmRecordMirror = () => {
      const es = deps.getEnrichmentStore() as
        | { listScopeMeta: (scope: string, opts?: unknown) => unknown }
        | undefined;
      return es
        ? ({ list: (scope: string, opts?: unknown) => es.listScopeMeta(scope, opts) } as never)
        : undefined;
    };
  }
  return deps;
};

const ctxInternal: ChatDispatchContext = {
  channel: 'internal_function_call',
  session_id: 'sess-1',
  turn_id: 'turn-1',
};

// ── E.2 — the gather alias + the shared-ledger property (closes bench 41) ──

describe('D-167 P2 — aliasEntityPayloadForEgress (the N.10.2 gather alias)', () => {
  it('stamps the marker, aliases email/name/target_id, and seeds the shared ledger', () => {
    const plan = makePlan(entityResolver());
    // The producer payload carries NO marker — the gather stamps `part.entity`.
    const aliased = aliasEntityPayloadForEgress(
      [{ email: 'alice@acme.com', name: 'Alice Chen', target_id: 'alice@acme.com', kind: 'contact' }],
      'contact',
      plan,
    );
    const rec = aliased[0] as Record<string, unknown>;
    expect(rec['email']).toBe('m1@d1.invalid');
    expect(rec['name']).toBe('pii.Person1');
    // target_id IS the canonical email → same `(kind, value)` → same alias.
    expect(rec['target_id']).toBe('m1@d1.invalid');
    // `kind` is not PII — left intact for the render.
    expect(rec['kind']).toBe('contact');
    // The ledger now holds the alias the rest of the turn must reuse.
    expect(plan.ledger.byKindBaseAlias.size).toBeGreaterThan(0);
  });

  it('aliases a contact to the SAME value the tool-result seam does (shared ledger — the bench-41 property)', async () => {
    const plan = makePlan(entityResolver());
    // 1) The prefetch gather aliases the contact first (seeds the ledger).
    const pf = aliasEntityPayloadForEgress(
      [{ email: 'alice@acme.com', name: 'Alice Chen', target_id: 'alice@acme.com', kind: 'contact' }],
      'contact',
      plan,
    );
    // 2) A later contact.search tool result with the SAME contact hits the seam.
    const { packet } = await egress(
      plan,
      JSON.stringify({
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
      }),
    );
    const toolRecord = (
      packet.prior_tool_calls as Array<{ result: { candidates: Array<{ record: Record<string, string> }> } }>
    )[0]!.result.candidates[0]!.record;
    // The prefetch block + the tool result show the IDENTICAL alias — what makes
    // the rendered prefetch consistent with the rest of the turn (bench 41).
    expect(toolRecord.email).toBe((pf[0] as Record<string, unknown>)['email']);
    expect(toolRecord.name).toBe((pf[0] as Record<string, unknown>)['name']);
  });

  it('returns the raw payload on an inactive plan (external-egress surface, behaviour-preserving)', () => {
    const plan = { ...makePlan(entityResolver()), active: false };
    const payload = [{ email: 'a@b.com', name: 'A', target_id: 'a@b.com', kind: 'contact' }];
    expect(aliasEntityPayloadForEgress(payload, 'contact', plan)).toBe(payload);
  });

  it('returns the input on an empty payload (no-op)', () => {
    const plan = makePlan(entityResolver());
    const empty: readonly Record<string, unknown>[] = [];
    expect(aliasEntityPayloadForEgress(empty, 'contact', plan)).toBe(empty);
  });
});

// ── E.2/N.10.1 — the prefetch contributes a structured part, rendered aliased ──

describe('D-167 P2 — prefetch entity part renders aliased, never raw PII', () => {
  it('the gather aliases the contributed payload, then render shows only aliases', async () => {
    const { ctx, parts } = makePromptCtx('is Alice available');
    await contributePrefetch(ctx, {
      search: fakeSearch([{ ref: 'alice@acme.com', label: 'Alice Chen', kind: 'contact', score: 9 }]),
      minScore: 0,
    });
    const part = parts[0];
    expect(part?.role).toBe('entity');
    if (part === undefined || part.role !== 'entity') throw new Error('expected entity part');

    const plan = makePlan(entityResolver());
    const block = part.render(aliasEntityPayloadForEgress(part.payload, part.entity, plan));

    expect(block).toContain('pii.Person1');
    expect(block).toContain('m1@d1.invalid');
    expect(block).not.toContain('alice@acme.com');
    expect(block).not.toContain('Alice Chen');
    // The marker key never survives into the rendered text.
    expect(block).not.toContain('__entity');
  });

  it('preserves the ambiguity flag through gather aliasing so the aliased render splits blocks', async () => {
    const { ctx, parts } = makePromptCtx('which Sarah or Alice');
    await contributePrefetch(ctx, {
      search: fakeSearch([
        { ref: 'alice@acme.com', label: 'Alice Chen', kind: 'contact', score: 9 },
        { ref: 'sarah@acme.com', label: 'Sarah Adams', kind: 'contact', score: 1, ambiguous: true },
      ]),
      minScore: 0,
    });
    const part = parts[0];
    expect(part?.role).toBe('entity');
    if (part === undefined || part.role !== 'entity') throw new Error('expected entity part');

    const plan = makePlan(entityResolver());
    const aliasedPayload = aliasEntityPayloadForEgress(part.payload, part.entity, plan);
    expect('ambiguous' in (aliasedPayload[0] ?? {})).toBe(false);
    expect((aliasedPayload[1] as Record<string, unknown>)['ambiguous']).toBe(true);

    const block = part.render(aliasedPayload);
    const blocks = block.split('\n\n');
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toContain('speculative');
    expect(blocks[0]).toContain('pii.Person1');
    expect(blocks[0]).not.toContain('pii.Person2');
    expect(blocks[1]).toContain('Do NOT assume');
    expect(blocks[1]).toContain('ask the user to clarify');
    expect(blocks[1]).toContain('pii.Person2');
    expect(blocks[1]).not.toContain('pii.Person1');
    expect(block).not.toContain('alice@acme.com');
    expect(block).not.toContain('sarah@acme.com');
    expect(block).not.toContain('Alice Chen');
    expect(block).not.toContain('Sarah Adams');

    const gathered = renderEntityPartsForEgress([part], makePlan(entityResolver())).join('\n');
    expect(gathered).toContain('speculative');
    expect(gathered).toContain('Do NOT assume');
    expect(gathered).not.toContain('alice@acme.com');
    expect(gathered).not.toContain('Sarah Adams');
  });
});

// ── N.10.2 — renderEntityPartsForEgress gates the SPECULATIVE prefetch on the
//    plan being ACTIVE: aliased on a chat surface, DROPPED on external-egress ──

describe('D-167 N.10.2 — renderEntityPartsForEgress gates speculative prefetch on plan.active', () => {
  /** Contribute one prefetch candidate + return its `entity` parts (the
   *  orchestrator pre-filters to the prompt-cache source before the helper). */
  const prefetchParts = async (): Promise<readonly EntityPromptPart[]> => {
    const { ctx, parts } = makePromptCtx('is Alice available');
    await contributePrefetch(ctx, {
      search: fakeSearch([{ ref: 'alice@acme.com', label: 'Alice Chen', kind: 'contact', score: 9 }]),
      minScore: 0,
    });
    return parts.filter((p): p is EntityPromptPart => p.role === 'entity');
  };

  it('renders the prefetch block ALIASED on an active (chat) plan', async () => {
    const blocks = renderEntityPartsForEgress(await prefetchParts(), makePlan(entityResolver()));
    const text = blocks.join('\n');
    expect(text.length).toBeGreaterThan(0); // the prefetch did contribute
    expect(text).toContain('pii.Person1'); // aliased
    expect(text).not.toContain('alice@acme.com'); // raw email never egresses
    expect(text).not.toContain('Alice Chen'); // raw name never egresses
  });

  it('DROPS the speculative prefetch on an INACTIVE plan (external-egress, e.g. messenger) — never raw', async () => {
    const inactive = { ...makePlan(entityResolver()), active: false };
    const blocks = renderEntityPartsForEgress(await prefetchParts(), inactive);
    expect(blocks).toEqual([]); // omitted entirely, NOT rendered raw
    expect(blocks.join('\n')).not.toContain('alice@acme.com');
  });

  it('DROPS the prefetch when no plan is wired (PII unwired)', async () => {
    expect(renderEntityPartsForEgress(await prefetchParts(), undefined)).toEqual([]);
  });

  it('DROPS the prefetch on an ACTIVE plan with a NOOP resolver (aliasing ineffective → would render raw)', async () => {
    const noopPlan = makePlan(piiEgress.noopFieldPrivacyResolver);
    expect(noopPlan.active).toBe(true); // active, yet...
    expect(renderEntityPartsForEgress(await prefetchParts(), noopPlan)).toEqual([]); // ...dropped: no real aliasing
  });
});

// ── N.10.2 ② — the content pass over user_message / chat_tail (codex fold) ──

describe('D-167 P2 — N.10.2 content pass aliases user_message/chat_tail vs a seeded ledger', () => {
  it('aliases a contact named in user_message on a prefetch-only first turn (no tool results)', async () => {
    const plan = makePlan(entityResolver());
    // The prefetch gather seeded the ledger; this turn has NO structural markers.
    aliasEntityPayloadForEgress(
      [{ email: 'alice@acme.com', name: 'Alice Chen', target_id: 'alice@acme.com', kind: 'contact' }],
      'contact',
      plan,
    );
    const { rawPrompt, packet } = await egress(
      plan,
      JSON.stringify({ user_message: 'is Alice Chen available?', chat_tail: [] }),
    );
    expect(packet.user_message).toBe('is pii.Person1 available?');
    expect(rawPrompt).not.toContain('Alice Chen');
  });

  it('aliases a contact named in chat_tail against the seeded ledger', async () => {
    const plan = makePlan(entityResolver());
    aliasEntityPayloadForEgress(
      [{ email: 'alice@acme.com', name: 'Alice Chen', target_id: 'alice@acme.com', kind: 'contact' }],
      'contact',
      plan,
    );
    const { rawPrompt, packet } = await egress(
      plan,
      JSON.stringify({ user_message: 'ping', chat_tail: [{ role: 'user', content: 'met Alice Chen yesterday' }] }),
    );
    const tail = packet.chat_tail as Array<{ content: string }>;
    expect(tail[0]!.content).toBe('met pii.Person1 yesterday');
    expect(rawPrompt).not.toContain('Alice Chen');
  });

  it('is BYTE-IDENTICAL when the ledger is empty (no prefetch / no tool result this session)', async () => {
    const plan = makePlan(piiEgress.noopFieldPrivacyResolver);
    const prompt = JSON.stringify({
      user_message: 'hi',
      chat_tail: [{ role: 'user', content: 'hello alice@acme.com' }],
    });
    const { rawPrompt } = await egress(plan, prompt);
    // Empty ledger → no content scan → the early path returns the input untouched.
    expect(rawPrompt).toBe(prompt);
  });
});

// ── E.2 retention — the REAL projections stamp the marker (producer side) ──

/** Collect every candidate-shaped record (carries a `target_id`) anywhere under
 *  a scope-search envelope — `candidates[].record` AND every confidence-shape
 *  re-embed under `envelope.shape.{top,alternatives,close,candidates}`. */
const candidateRecordsUnder = (node: unknown, out: Record<string, unknown>[]): void => {
  if (Array.isArray(node)) {
    node.forEach((el) => candidateRecordsUnder(el, out));
    return;
  }
  if (node !== null && typeof node === 'object') {
    const r = node as Record<string, unknown>;
    if (typeof r['target_id'] === 'string') out.push(r);
    for (const v of Object.values(r)) candidateRecordsUnder(v, out);
  }
};

describe('D-167 P2 — scope-search results are born marked (real projections, retention)', () => {
  it('contact.search marks every candidate AND every confidence-shape re-embed; the chain aliases + strips', async () => {
    const handlers = buildChatTier1Handlers(
      depsStub({
        getContactStore: () =>
          ({
            // Two contacts → the confidence shape populates more than just `top`,
            // so the re-embed slots (alternatives/close/candidates) are exercised.
            list: () => [
              { _id: 'alice@acme.com', email: 'alice@acme.com', name: 'Alice Chen' },
              { _id: 'alex@acme.com', email: 'alex@acme.com', name: 'Alex Chen' },
            ],
            get: () => null,
          }) as never,
      }),
    );
    const result = await handlers['contact.search']!({ query: 'Chen', limit: 5 }, ctxInternal);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('contact.search failed');

    const envelope = result.result as { candidates: Array<{ record: Record<string, unknown> }> };
    expect(envelope.candidates.length).toBeGreaterThan(0);
    // Retention: EVERY record the envelope carries — candidates + every
    // confidence-shape re-embed — is born marked. A missing projection stamp or
    // a broken re-embed would surface here (the invariant P3 retirement gates on).
    const records: Record<string, unknown>[] = [];
    candidateRecordsUnder(result.result, records);
    expect(records.length).toBeGreaterThanOrEqual(envelope.candidates.length);
    for (const rec of records) expect(rec['__entity']).toBe('contact');

    // End-to-end: the marked result drives aliasing + the strip removes the
    // marker — no raw PII and no `__entity` reaches the model.
    const { rawPrompt } = await egress(
      makePlan(entityResolver()),
      JSON.stringify({ prior_tool_calls: [{ tool_name: 'contact.search', result: result.result }] }),
    );
    expect(rawPrompt).not.toContain('__entity');
    expect(rawPrompt).not.toContain('alice@acme.com');
    expect(rawPrompt).not.toContain('Alice Chen');
    expect(rawPrompt).toContain('m1@d1.invalid');
  });

  it('deal.search marks every candidate `__entity:deal`; the chain aliases owner + strips', async () => {
    const handlers = buildChatTier1Handlers(
      depsStub({
        getEnrichmentStore: () =>
          ({
            listScopeMeta: (scope: string) =>
              scope === 'connection.api.hubspot.deal'
                ? [
                    {
                      target_id: 'hubspot_deal_42',
                      meta: { name: 'Acme Renewal Q3', owner: 'dana@acme.com', stage: 'open' },
                    },
                  ]
                : [],
          }) as never,
      }),
    );
    const result = await handlers['deal.search']!({ query: 'Acme', limit: 5 }, ctxInternal);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('deal.search failed');

    const records: Record<string, unknown>[] = [];
    candidateRecordsUnder(result.result, records);
    expect(records.length).toBeGreaterThan(0);
    // The REAL projectPlatformDeal stamped every deal record.
    for (const rec of records) expect(rec['__entity']).toBe('deal');

    // Owner (the only deal PII) is aliased; the title + vendor id stay intact;
    // no marker reaches the model.
    const { rawPrompt } = await egress(
      makePlan(entityResolver()),
      JSON.stringify({ prior_tool_calls: [{ tool_name: 'deal.search', result: result.result }] }),
    );
    expect(rawPrompt).not.toContain('__entity');
    expect(rawPrompt).not.toContain('dana@acme.com');
    // The deal TITLE is NOT PII — it must survive (aliasing it would corrupt the
    // agent's reasoning).
    expect(rawPrompt).toContain('Acme Renewal Q3');
  });
});

// ── B4 — the prefetch's company field seeds + aliases as an `org` value ──

describe('D-167 B4 — prefetch company seeds + aliases as an org', () => {
  it('the gather aliases the contact `company` field to a pii.Org surface', () => {
    const plan = makePlan(entityResolver());
    const aliased = aliasEntityPayloadForEgress(
      [{ email: 'rae@acme.com', name: 'Rae Kim', target_id: 'rae@acme.com', kind: 'contact', company: 'Datadog' }],
      'contact',
      plan,
    );
    const rec = aliased[0] as Record<string, unknown>;
    expect(rec['company']).toBe('pii.Org1');     // org alias surface
    expect(rec['name']).toBe('pii.Person1');     // name still aliases
    expect(plan.summary.value.counts.org).toBe(1);
  });

  it('aliases a contact company named in user_message against the seeded ledger', async () => {
    const plan = makePlan(entityResolver());
    // The prefetch gather seeds email/name/company (Datadog distinctive → seeded).
    aliasEntityPayloadForEgress(
      [{ email: 'rae@acme.com', name: 'Rae Kim', target_id: 'rae@acme.com', kind: 'contact', company: 'Datadog' }],
      'contact',
      plan,
    );
    const { rawPrompt, packet } = await egress(
      plan,
      JSON.stringify({ user_message: 'how is the Datadog account tracking?', chat_tail: [] }),
    );
    expect(packet.user_message).toBe('how is the pii.Org1 account tracking?');
    expect(rawPrompt).not.toContain('Datadog');
  });

  it('end-to-end: a candidate company rides through contributePrefetch → gather as org', async () => {
    const { ctx, parts } = makePromptCtx('the renewal');
    await contributePrefetch(ctx, {
      search: fakeSearch([
        { ref: 'rae@acme.com', label: 'Rae Kim', kind: 'contact', score: 9, company: 'Datadog' },
      ]),
      minScore: 0,
    });
    const part = parts[0];
    if (part === undefined || part.role !== 'entity') throw new Error('expected entity part');
    const aliased = aliasEntityPayloadForEgress(part.payload, part.entity, makePlan(entityResolver()));
    expect((aliased[0] as Record<string, unknown>)['company']).toBe('pii.Org1');
  });
});

// ── B3 — boundary kind-derivation: a contact.search alias self-routes to its
//    field BEFORE restore (D6), so the restored bare value lands in the right
//    column instead of a blind name search. Driven through the real wire seam. ──

describe('D-167 B3 — contact.search args self-route by alias kind at the boundary', () => {
  /** Seed the ledger (Rae Kim / rae@acme.com / Datadog) then run a model result
   *  whose tool_calls carry `args` through the restore seam; return the restored
   *  contact.search args. */
  const routeAndRestore = async (
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> => {
    const plan = makePlan(entityResolver());
    // Seed: pii.Person1 = Rae Kim (name), pii.Org1 = Datadog (org), m1@d1.invalid = email.
    aliasEntityPayloadForEgress(
      [{ email: 'rae@acme.com', name: 'Rae Kim', target_id: 'rae@acme.com', kind: 'contact', company: 'Datadog' }],
      'contact',
      plan,
    );
    const real: ExecuteChatAiCall = async () => ({
      body: { response: '', events: [], tool_calls: [{ tool: 'contact.search', args }] } satisfies AIOutput,
    });
    const restored = await wrapExecuteAiCallForPii(real, plan)(MANIFEST, { 'llm.prompt': '{}' });
    const calls = (restored.body as AIOutput).tool_calls as unknown as Array<{ args: Record<string, unknown> }>;
    return calls[0]!.args;
  };

  it('an ORG alias in `query` routes to `company` and restores to the real org', async () => {
    // Without B3: query "pii.Org1" → restored "Datadog" → blind NAME search (miss).
    expect(await routeAndRestore({ query: 'pii.Org1' })).toEqual({ company: 'Datadog' });
  });

  it('a NAME alias in `query` STAYS in `query` (name column is correct) + restores', async () => {
    expect(await routeAndRestore({ query: 'pii.Person1' })).toEqual({ query: 'Rae Kim' });
  });

  it('an EMAIL composite alias in `query` routes to `email` + restores', async () => {
    expect(await routeAndRestore({ query: 'm1@d1.invalid' })).toEqual({ email: 'rae@acme.com' });
  });

  it('a case-mutated org alias still self-routes (matches restore case-insensitivity)', async () => {
    expect(await routeAndRestore({ query: 'pii.org1' })).toEqual({ company: 'Datadog' });
  });

  it('a RAW (non-alias) query is left untouched — never re-routed', async () => {
    // "Globex" is not a ledger alias shape → not routed, not restored.
    expect(await routeAndRestore({ query: 'Globex' })).toEqual({ query: 'Globex' });
  });

  it('FAIL-SAFE: an org alias in query is NOT moved when `company` is already set', async () => {
    // Target occupied → no move; query restores in place (a name search that
    // misses, never a wrong match or a clobbered company arg).
    const out = await routeAndRestore({ query: 'pii.Org1', company: 'Initech' });
    expect(out).toEqual({ query: 'Datadog', company: 'Initech' });
  });
});

// ── Single-seam prefetch — the prefetch entity parts thread through the
//    wrapper's `entityParts` and alias at the WIRE SEAM (not an eager
//    orchestrator gather). One PII enforcement point: the prefetch seeds the
//    shared ledger BEFORE the user_message scan, so a contact renders to ONE
//    alias everywhere (closes the redundant-second-alias race), and an inactive
//    plan drops the speculative pull raw-free. ──

describe('D-167 — prefetch aliased at the single seam (entityParts via the wrapper)', () => {
  /** The prompt-cache producer's structured `entity` parts for one contact. */
  const prefetchPartsFor = async (
    ref: string,
    label: string,
  ): Promise<readonly EntityPromptPart[]> => {
    const { ctx, parts } = makePromptCtx('look this up');
    await contributePrefetch(ctx, {
      search: fakeSearch([{ ref, label, kind: 'contact', score: 9 }]),
      minScore: 0,
    });
    return parts.filter((p): p is EntityPromptPart => p.role === 'entity');
  };

  /** Run a packet through the wire seam WITH threaded entity parts; return the
   *  model-bound prompt string the executor actually received. */
  const seamWithParts = async (
    plan: PiiEgressPlan,
    entityParts: readonly EntityPromptPart[],
    packet: Record<string, unknown>,
  ): Promise<string> => {
    let sent = '';
    const real: ExecuteChatAiCall = async (_m, input) => {
      sent = String(input['llm.prompt']);
      return { body: { response: 'ok', events: [], tool_calls: [] } satisfies AIOutput };
    };
    await wrapExecuteAiCallForPii(real, plan, undefined, entityParts)(MANIFEST, {
      'llm.prompt': JSON.stringify(packet),
    });
    return sent;
  };

  it('injects + aliases the prefetch at the seam, and a user_message mention of the SAME contact reuses the SAME alias (one ledger pass, no redundant second alias)', async () => {
    const entityParts = await prefetchPartsFor('alice@acme.com', 'Alice Chen');
    const plan = makePlan(entityResolver());
    const sent = await seamWithParts(plan, entityParts, {
      user_message: 'please loop in Alice Chen',
    });
    const packet = JSON.parse(sent) as Record<string, unknown>;
    // The prefetch block is present + aliased (raw name absent).
    const block = (packet.prefetch_context as string[]).join('\n');
    expect(block).toContain('pii.Person1');
    expect(block).not.toContain('Alice Chen');
    // The SAME contact in the user_message reuses the SAME alias — the prefetch
    // seeded the shared ledger BEFORE the user_message scan (one contact = one
    // alias everywhere, which the old eager-gather second pass could not promise).
    expect(packet.user_message).toBe('please loop in pii.Person1');
    // No raw warehouse PII anywhere in the model-bound packet.
    expect(sent).not.toContain('alice@acme.com');
    expect(sent).not.toContain('Alice Chen');
    // Exactly ONE name alias — the bug this closes was a redundant `pii.Person2`
    // for the SAME contact across two separate alias passes.
    expect(plan.ledger.byKindBaseAlias.has('name::pii.Person2')).toBe(false);
  });

  it('SAFETY: an inactive plan returns the raw executor → the prefetch is never injected (no raw warehouse PII egresses)', async () => {
    const entityParts = await prefetchPartsFor('alice@acme.com', 'Alice Chen');
    const plan = { ...makePlan(entityResolver()), active: false };
    let sent = '';
    const real: ExecuteChatAiCall = async (_m, input) => {
      sent = String(input['llm.prompt']);
      return { body: { response: 'ok', events: [], tool_calls: [] } satisfies AIOutput };
    };
    const wrapped = wrapExecuteAiCallForPii(real, plan, undefined, entityParts);
    // Inactive plan → the wrapper IS the raw executor; the aliasing seam never runs.
    expect(wrapped).toBe(real);
    await wrapped(MANIFEST, { 'llm.prompt': JSON.stringify({ user_message: 'hi' }) });
    const packet = JSON.parse(sent) as Record<string, unknown>;
    // The speculative prefetch is dropped — never injected, never leaked raw.
    expect(packet.prefetch_context).toBeUndefined();
    expect(sent).not.toContain('alice@acme.com');
    expect(sent).not.toContain('Alice Chen');
  });
});
