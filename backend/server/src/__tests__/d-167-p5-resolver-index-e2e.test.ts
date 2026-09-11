/** D-167 P5 — chat-PII resolver-index full-chain proof (real installed catalog-op).
 *
 *  Two existing suites each prove HALF of the retention chain, but neither
 *  crosses the seam between them:
 *    - `d-167-activation-chat-pii-wiring.test.ts` proves `composeChatOrchestrator`
 *      wires the REAL `createMetaFieldPrivacyResolverFromLocalManifestStore`, and
 *      that resolver tags a HAND-BUILT `reinvokePacket()` correctly — but its
 *      end-to-end composed turns only cover NO-TOOL turns, which never produce a
 *      `result` envelope for the resolver to tag.
 *    - `d-167-p5-s4-chat-pii-egress.test.ts` drives a REAL orchestrator tool loop
 *      (round 1 proposes a tool, the dispatch result re-enters egress on the
 *      reinvoke) — but with a STUB resolver that hard-codes its paths and ignores
 *      `tool_name` entirely.
 *
 *  This file is the missing full chain: a REAL installed catalog-op (a
 *  privacy-tagged entity schema persisted in the per-pair `local_manifest`
 *  table) drives the REAL production resolver, and a REAL `createChatOrchestrator`
 *  tool loop emits that catalog-op's `tool_name` — which the orchestrator stamps
 *  verbatim onto `prior_tool_calls[].tool_name` (`chat-turn-executor.ts:252`). The
 *  proof is that the AI-emitted name actually HITS the resolver index built by
 *  `operationKeysFor` (`meta-field-privacy-resolver.ts:139-158`), so the warehouse
 *  PII in the tool result is aliased before the reinvoke egress reaches the cloud
 *  LLM, and restored on the user-facing reply. Nothing here is hand-injected: the
 *  resolver is the exact constructor the composer wires, reading a real SQLite
 *  table; only the leaf AI + the tool's dispatch payload are stubbed (unavoidable
 *  without a live model / live HubSpot).
 */

import Database from 'better-sqlite3';
import { piiEgress } from '@recued/gateway';
import {
  type AIOutput,
  type EntitySchemaIngredientInput,
  type IngredientManifest,
  type InternalToolRegistry,
  type RecuedServerSignature,
  type ToolEntry,
} from '@recued/contracts';
import { describe, expect, it, vi, beforeAll, afterAll } from 'vitest';



import {
  createChatOrchestrator,
  type ExecuteChatAiCall,
} from '../chat-orchestrator.js';
import { createMetaFieldPrivacyResolverFromLocalManifestStore } from '../meta-field-privacy-resolver.js';
import { createLocalManifestStore } from '../ingredient-authoring/local-manifest-store.js';
import { createChatStore, ensureChatSchema } from '../storage/chat-store.js';

const NOW = Date.UTC(2031, 2, 3, 9, 0, 0);

const selfSignature: RecuedServerSignature = {
  server_kind: 'recued',
  version: '1.0.0',
  instance_id: 'inst-test',
};

// ── The installed privacy-tagged catalog (mirrors the D-165 / activation tests) ─
//
// A HubSpot connection catalog whose `contact.read` op returns a record with an
// `email` (tagged `email`) + `fullName` (tagged `name`) + `score` (untagged).
// The manifest carries the `operation_id` so the resolver index also keys on the
// fully-qualified `recued-core/hubspot.contact.read` form an MCP tool catalog
// would surface.

const catalogManifest = (slug = 'hubspot'): IngredientManifest => ({
  slug,
  version: 1,
  name: `${slug} catalog`,
  description: 'Test catalog.',
  author: 'recued-core',
  kind: 'connection',
  category: 'data',
  risk_tier: 'read',
  input: {},
  output: {},
  operations: {
    'contact.read': {
      operation_id: `recued-core/${slug}.contact.read`,
      risk_tier: 'read',
    },
  },
});

const contactSchema = (): EntitySchemaIngredientInput => ({
  ingredient_id: 'hubspot',
  wraps_vendor: 'hubspot',
  entity_id: 'contact',
  scope: 'connection.api.hubspot.contact',
  projection_mode: 'platform_reference',
  schema_mode: 'static',
  target_id: { fields: ['id'], template: 'contact_{id}' },
  meta_fields: [
    { key: 'email', type: 'string', source_path: 'properties.email', privacy: 'email' },
    { key: 'full_name', type: 'string', source_path: 'properties.fullName', privacy: 'name' },
    { key: 'score', type: 'number', source_path: 'properties.score' },
  ],
  source_operations: {
    read: { catalog: 'hubspot', operation: 'contact.read' },
  },
});

/** Install the privacy-tagged catalog into the per-pair `local_manifest` table
 *  the production resolver reads. */
const installContactSchema = (db: Database.Database): void => {
  createLocalManifestStore(db).put({
    manifest: catalogManifest(),
    entity_schemas: [contactSchema()],
  });
};

interface ToolLoopResult {
  readonly call: number;
  readonly reinvokeEgress: Record<string, unknown> | undefined;
  readonly dispatchArgs: readonly unknown[];
  readonly finalContent: string | undefined;
  readonly redactionSummary: { counts?: Record<string, number> } | undefined;
}

/** Drive a real 2-round chat tool loop through `createChatOrchestrator` using the
 *  REAL table-backed resolver. Round 1 the AI proposes `opts.toolName`; the tool
 *  dispatches `opts.dispatchResult`; the reinvoke egress + final reply are
 *  captured so a test can assert the alias→restore round-trip. */
const runResolverIndexToolLoop = async (opts: {
  readonly toolName: string;
  readonly dispatchResult: Record<string, unknown>;
  readonly reinvokeResponse: (priorResult: Record<string, unknown>) => string;
  readonly userMessage?: string;
  readonly install?: (db: Database.Database) => void;
}): Promise<ToolLoopResult> => {
  const db = new Database(':memory:');
  try {
    ensureChatSchema(db);
  // ⛔ Pin the brief OFF via the SETTER production uses — env is boot-critical only
  // (owner rule). This file's subject is not the brief; the fold would add a
  // call to the very dispatch/egress counts asserted here.
    const chatStore = createChatStore(db);
    chatStore.setRollingBriefEnabled(false);
    chatStore.createSession({ id: 'sess-1', now: NOW - 1_000 });

    // Install the catalog, then build the EXACT resolver `composeChatOrchestrator`
    // wires (`d-167-activation-chat-pii-wiring.test.ts` proves the composer hands
    // over this constructor) — reading the real `local_manifest` SQLite table.
    (opts.install ?? installContactSchema)(db);
    const resolver = createMetaFieldPrivacyResolverFromLocalManifestStore(
      createLocalManifestStore(db),
    );

    const captured: Array<Record<string, unknown>> = [];
    const dispatchArgs: unknown[] = [];
    const broadcasts: Array<Record<string, unknown>> = [];
    const auditRows: Array<{ action: string; detail?: string }> = [];

    const registry: InternalToolRegistry = {
      list: () => [],
      listByTier: () => [],
      getByName: (name) =>
        name === opts.toolName
          ? ({
              name,
              tier: 3,
              classification: 'read', // read → no plan-approval gate
              arg_schema: {},
              concurrency_safe: true,
            } as unknown as ToolEntry)
          : null,
      dispatch: vi.fn(async (_name: string, args: unknown) => {
        dispatchArgs.push(args);
        return { ok: true, result: opts.dispatchResult } as const;
      }),
      subscribeRefresh: () => () => undefined,
    };

    let call = 0;
    const executeAiCall = vi.fn<ExecuteChatAiCall>(async (_m, input) => {
      const packet = JSON.parse(String(input['llm.prompt'])) as Record<string, unknown>;
      captured.push(packet);
      call += 1;
      if (call === 1) {
        // Round 1: propose the catalog read (no PII in the args).
        return {
          body: {
            response: 'looking up',
            events: [],
            tool_calls: [{ tool: opts.toolName, args: { id: '123' } }],
          } satisfies AIOutput,
        };
      }
      // Reinvoke: synthesise over the (resolver-aliased) tool result — the model
      // only ever echoes whatever the egress packet actually carries.
      const prior = (packet.prior_tool_calls as Array<{ result?: Record<string, unknown> }>)?.[0]
        ?.result ?? {};
      return {
        body: {
          response: opts.reinvokeResponse(prior),
          events: [],
          tool_calls: [],
        } satisfies AIOutput,
      };
    });

    let idSeq = 0;
    const orchestrator = createChatOrchestrator({
      chatStore,
      registry,
      broadcast: { emit: (e) => broadcasts.push(e as Record<string, unknown>) },
      auditLog: {
        logActivity: vi.fn(async (entry: { action: string; detail?: string }) => {
          auditRows.push({ action: entry.action, detail: entry.detail });
        }),
      } as never,
      selfSignature,
      executeAiCall,
      piiLedgerStore: piiEgress.createSessionLedgerStore(),
      fieldPrivacyResolver: resolver,
      now: () => NOW,
      mintId: () => `id-${++idSeq}`,
    });

    await orchestrator.runTurn({
      session_id: 'sess-1',
      message: opts.userMessage ?? 'look up contact 123',
      picker_state: { current: 'self' },
    });

    const messageComplete = broadcasts.find((b) => b.kind === 'chat.message_complete');
    const assistantAudit = auditRows
      .filter((r) => r.action === 'chat_message_sent')
      .map((r) => JSON.parse(r.detail ?? '{}') as Record<string, unknown>)
      .find((d) => d.role === 'assistant');
    return {
      call,
      reinvokeEgress: captured[1],
      dispatchArgs,
      finalContent: (messageComplete?.final as { content?: string } | undefined)?.content,
      redactionSummary: assistantAudit?.redaction_summary as
        | { counts?: Record<string, number> }
        | undefined,
    };
  } finally {
    db.close();
  }
};

const priorProperties = (
  egress: Record<string, unknown> | undefined,
): { email?: string; fullName?: string; score?: number } | undefined =>
  (egress?.prior_tool_calls as Array<{
    result?: { properties?: { email?: string; fullName?: string; score?: number } };
  }>)?.[0]?.result?.properties;

describe('D-167 P5 — chat-PII resolver-index full chain (real installed catalog-op)', () => {
  it('a real catalog-op tool_name hits the resolver index → aliases the tool result on reinvoke → restores on display', async () => {
    const result = await runResolverIndexToolLoop({
      // The fully-qualified operation_id a connection MCP catalog surfaces.
      toolName: 'recued-core/hubspot.contact.read',
      dispatchResult: { properties: { email: 'alice@acme.com', fullName: 'Alice Ada', score: 7 } },
      reinvokeResponse: (prior) => {
        const p = (prior as { properties?: { email?: string; fullName?: string } }).properties ?? {};
        return `found ${String(p.email)} (${String(p.fullName)})`;
      },
    });

    expect(result.call).toBe(2); // a real reinvoke happened

    // Dispatch acted on the real args (the args were not privacy-tagged).
    expect(result.dispatchArgs[0]).toEqual({ id: '123' });

    // Reinvoke egress: the catalog result's PII was aliased — the resolver index
    // matched the AI-emitted `tool_name` to the installed schema's tagged fields,
    // so the cloud LLM saw aliases, never the real identifiers.
    const prior = priorProperties(result.reinvokeEgress);
    expect(prior?.email).toBe('m1@d1.invalid');
    expect(prior?.fullName).toBe('pii.Person1');
    // The untagged numeric field rides through verbatim.
    expect(prior?.score).toBe(7);
    // Nowhere in the reinvoke egress does the raw PII survive.
    expect(JSON.stringify(result.reinvokeEgress)).not.toContain('alice@acme.com');
    expect(JSON.stringify(result.reinvokeEgress)).not.toContain('Alice Ada');

    // Display: the alias the model echoed is restored to the real value (the
    // pii-restore backstop) — the user reads real identifiers.
    expect(result.finalContent).toBe('found alice@acme.com (Alice Ada)');

    // Audit: the redaction summary counted exactly the email + name (the domain
    // side-effect entry does not add a count).
    expect(result.redactionSummary?.counts).toEqual({ email: 1, name: 1 });
  });

  // `operationKeysFor` (meta-field-privacy-resolver.ts:139-158) emits several key
  // forms for one source operation; an AI may emit any of them as the tool name.
  // Each must hit the index and alias the tool result on reinvoke.
  it.each([
    'recued-core/hubspot.contact.read', // operation_id (from the manifest)
    'hubspot.contact.read', //            catalog.operation / ingredient_id.operation
    'hubspot/contact.read', //            catalog/operation
    'contact.read', //                    bare operation key
  ])('the resolver index matches the catalog-op tool_name form "%s"', async (toolName) => {
    const result = await runResolverIndexToolLoop({
      toolName,
      dispatchResult: { properties: { email: 'alice@acme.com', fullName: 'Alice Ada', score: 7 } },
      reinvokeResponse: (prior) => {
        const p = (prior as { properties?: { email?: string } }).properties ?? {};
        return `ok ${String(p.email)}`;
      },
    });

    const prior = priorProperties(result.reinvokeEgress);
    expect(prior?.email).toBe('m1@d1.invalid'); // index hit → aliased
    expect(prior?.fullName).toBe('pii.Person1');
    expect(result.finalContent).toBe('ok alice@acme.com'); // restored on display
    expect(result.redactionSummary?.counts).toEqual({ email: 1, name: 1 });
  });

  it('an unrelated tool_name misses the index → the tool result rides through un-aliased', async () => {
    const result = await runResolverIndexToolLoop({
      // Not in the installed schema's `operationKeysFor` key set.
      toolName: 'crm.unrelated.fetch',
      dispatchResult: { properties: { email: 'alice@acme.com', fullName: 'Alice Ada', score: 7 } },
      reinvokeResponse: (prior) => {
        const p = (prior as { properties?: { email?: string } }).properties ?? {};
        return `raw ${String(p.email)}`;
      },
    });

    // Index miss → no tag → no alias. Nothing else in the turn is PII-tagged, so
    // the content pass has no ledger anchors either — the result is verbatim.
    const prior = priorProperties(result.reinvokeEgress);
    expect(prior?.email).toBe('alice@acme.com');
    expect(prior?.fullName).toBe('Alice Ada');
    expect(result.finalContent).toBe('raw alice@acme.com');
    expect(result.redactionSummary).toBeUndefined(); // zero counts → omitted
  });

  it('only the tagged fields alias — an uninstalled (empty) catalog leaves the result raw', async () => {
    const result = await runResolverIndexToolLoop({
      toolName: 'recued-core/hubspot.contact.read',
      dispatchResult: { properties: { email: 'alice@acme.com', fullName: 'Alice Ada', score: 7 } },
      reinvokeResponse: (prior) => {
        const p = (prior as { properties?: { email?: string } }).properties ?? {};
        return `none ${String(p.email)}`;
      },
      install: () => {}, // nothing installed → empty resolver index
    });

    // Same tool_name, but with no schema installed the index is empty, so the
    // matching name resolves to no tags — the no-op invariant holds end-to-end.
    const prior = priorProperties(result.reinvokeEgress);
    expect(prior?.email).toBe('alice@acme.com');
    expect(result.finalContent).toBe('none alice@acme.com');
    expect(result.redactionSummary).toBeUndefined();
  });
});
