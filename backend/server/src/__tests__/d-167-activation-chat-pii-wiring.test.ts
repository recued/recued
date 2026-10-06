/** D-167 activation — the field-privacy resolver wired into the chat composer.
 *
 *  Three slices already exist:
 *    - D-165 proved `createMetaFieldPrivacyResolverFromLocalManifestStore` reads
 *      installed `MetaField.privacy` tags out of the `local_manifest` table.
 *    - D-167 P5 S4 (codex-1) proved the chat egress alias/restore mechanics —
 *      alias on egress, restore on display, tool-loop reinvoke re-aliasing —
 *      end-to-end through `createChatOrchestrator` with a HAND-INJECTED resolver.
 *
 *  This file proves the LAST seam — the activation: `composeChatOrchestrator`
 *  builds a REAL table-backed resolver from the per-pair `local_manifest` table
 *  and passes it to the orchestrator as `fieldPrivacyResolver` (in place of the
 *  `noopFieldPrivacyResolver` default the orchestrator falls back to). So an
 *  installed entity schema's privacy tags actually drive the egress alias pass,
 *  while an empty table round-trips byte-identical (the load-bearing no-op
 *  invariant — the chat suite must stay green).
 *
 *  Approach: capture the `fieldPrivacyResolver` the composer hands
 *  `createChatOrchestrator` (the activation is exactly "this is no longer
 *  undefined"), then drive it through the SAME gateway alias pass + the real
 *  `wrapExecuteAiCallForPii` seam the orchestrator uses — so the proof rides on
 *  the production resolver, not a stub. A final real composed turn (mocking only
 *  the leaf `executeLLM`) guards the integration end-to-end.
 */

import Database from 'better-sqlite3';
import { piiEgress } from '@recued/gateway';
import {
  type AIOutput,
  type EntitySchemaIngredientInput,
  type IngredientManifest,
  type WebChatTab,
} from '@recued/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { EventBus } from '../events/bus.js';
import type {
  ChatOrchestrator,
  ChatOrchestratorDeps,
  ExecuteChatAiCall,
} from '../chat-orchestrator.js';
import type { ComposeChatOrchestratorDeps } from '../composition/bin/wire-chat-orchestrator.js';
import {
  wrapExecuteAiCallForPii,
  type PiiEgressPlan,
} from '../chat-pii-egress.js';
import { createLocalManifestStore } from '../ingredient-authoring/local-manifest-store.js';

const NOW = Date.UTC(2031, 0, 15, 12, 0, 0);
const MANIFEST = {} as IngredientManifest;

type TestEventBus = EventBus & { emit: ReturnType<typeof vi.fn> };
type LateGetters = Pick<
  ComposeChatOrchestratorDeps,
  | 'getContactStore'
  | 'getCollectionRegistry'
  | 'getEnrichmentStore'
  | 'getConnectionStore'
  | 'getExecutorConfig'
  | 'getExecuteDeps'
  | 'getScheduleDeps'
>;

const cleanups: Array<() => void> = [];

const makeDb = (): Database.Database => {
  const db = new Database(':memory:');
  cleanups.push(() => db.close());
  return db;
};

const eventBus = (): TestEventBus =>
  ({
    cursor: vi.fn(() => 0),
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    emit: vi.fn((event: unknown) => ({ ...(event as Record<string, unknown>), cursor: 1 })),
    replay: vi.fn(() => []),
    subscriberCount: vi.fn(() => 0),
  }) as unknown as TestEventBus;

const emptyRecipeStore = () =>
  ({
    ids: vi.fn(() => []),
    get: vi.fn(() => null),
    getStored: vi.fn(() => null),
    listStored: vi.fn(() => []),
  }) as never;

const inertLateGetters = (): LateGetters => ({
  getContactStore: vi.fn(() => undefined),
  getCollectionRegistry: vi.fn(() => undefined),
  getEnrichmentStore: vi.fn(() => undefined),
  getConnectionStore: vi.fn(() => undefined),
  getExecutorConfig: vi.fn(() => undefined),
  getExecuteDeps: vi.fn(() => undefined),
  getScheduleDeps: vi.fn(() => undefined),
});

const buildDeps = (
  overrides: Partial<ComposeChatOrchestratorDeps> = {},
): ComposeChatOrchestratorDeps => ({
  db: overrides.db ?? makeDb(),
  keys: undefined,
  eventBus: overrides.eventBus ?? eventBus(),
  auditLog: undefined,
  serverInstanceId: 'server-test',
  recipeStore: emptyRecipeStore(),
  llmConfig: undefined,
  getLlmConfig: () => undefined,
  llmQuota: {} as never,
  llmAdapterRegistry: {} as never,
  emptyTabProbe: vi.fn(async () => new Set<WebChatTab>()),
  pairedInstances: undefined,
  ...inertLateGetters(),
  ...overrides,
});

// ── The installed privacy-tagged catalog (mirrors the D-165 resolver test) ──

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
 *  the composer's resolver reads. */
const installContactSchema = (db: Database.Database): void => {
  createLocalManifestStore(db).put({
    manifest: catalogManifest(),
    entity_schemas: [contactSchema()],
  });
};

/** The shape of a tool-loop reinvoke egress packet — `prior_tool_calls[].result`
 *  is the warehouse-PII surface the resolver tags (a main turn carries no
 *  `result` envelope, so this is where aliasing fires). */
const reinvokePacket = () => ({
  prior_tool_calls: [
    {
      tool_name: 'recued-core/hubspot.contact.read',
      args: { email: 'arg-stays-untagged@example.com' },
      status: 'ok',
      result: { properties: { email: 'alice@acme.com', fullName: 'Alice Ada', score: 7 } },
    },
  ],
});

/** Compose the chat substrate against a freshly-spied `createChatOrchestrator`
 *  and return the `fieldPrivacyResolver` the composer actually passed it. */
const captureWiredResolver = async (
  deps: ComposeChatOrchestratorDeps,
): Promise<piiEgress.FieldPrivacyResolver | undefined> => {
  vi.resetModules();
  const stub: ChatOrchestrator = {
    runTurn: vi.fn(async () => ({ turn_id: 'stub' })),
    runMessengerTurn: vi.fn(async () => ({ turn_id: 'stub-messenger' })),
    sessionStore: { append: () => {}, history: () => [] },
    dispatch: { dispatchTool: vi.fn(async () => ({ ok: true as const, result: {} })) },
  };
  const createChatOrchestratorMock = vi.fn(
    (_deps: ChatOrchestratorDeps): ChatOrchestrator => stub,
  );
  vi.doMock('../chat-orchestrator.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../chat-orchestrator.js')>();
    return { ...actual, createChatOrchestrator: createChatOrchestratorMock };
  });
  const mod = await import('../composition/bin/wire-chat-orchestrator.js');
  mod.composeChatOrchestrator(deps);
  const passed = createChatOrchestratorMock.mock.calls[0]![0] as {
    fieldPrivacyResolver?: piiEgress.FieldPrivacyResolver;
  };
  return passed.fieldPrivacyResolver;
};

/** A `PiiEgressPlan` carrying the supplied resolver + a fresh ledger — the same
 *  shape `pii-protect` DECIDES, fed into the real `wrapExecuteAiCallForPii`. */
const planWith = (resolver: piiEgress.FieldPrivacyResolver): PiiEgressPlan => ({
  active: true,
  ledger: piiEgress.createSessionLedgerStore().getOrCreate('sess-1'),
  resolver,
  summary: { value: { mode: 'alias', scope_kind: 'session', counts: {} } },
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.doUnmock('../chat-orchestrator.js');
  vi.doUnmock('@recued/llm');
  vi.resetModules();
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

describe('D-167 activation — composeChatOrchestrator wires the table-backed resolver', () => {
  it('passes a real (non-noop) field-privacy resolver derived from the local_manifest table', async () => {
    const db = makeDb();
    installContactSchema(db);

    const resolver = await captureWiredResolver(buildDeps({ db }));

    // The activation: the composer NO LONGER leaves `fieldPrivacyResolver`
    // undefined (which made the orchestrator fall back to the noop). It hands
    // over a real resolver — and not the noop sentinel.
    expect(resolver).toBeDefined();
    expect(resolver).not.toBe(piiEgress.noopFieldPrivacyResolver);

    // …and that resolver reads the installed schema's privacy tags off a real
    // egress packet (the `read` operation maps to `recued-core/hubspot.contact.read`).
    const tags = resolver!(reinvokePacket());
    expect(tags).toEqual(expect.arrayContaining([
      { path: 'prior_tool_calls.0.result.properties.email', kind: 'email' },
      { path: 'prior_tool_calls.0.result.properties.fullName', kind: 'name' },
    ]));
    // Untagged fields stay untagged: `score` has no `privacy`, and the tool-call
    // ARG email is outside the schema's response mapping.
    expect(tags).not.toEqual(expect.arrayContaining([
      { path: 'prior_tool_calls.0.result.properties.score', kind: 'number' },
      { path: 'prior_tool_calls.0.args.email', kind: 'email' },
    ]));
  });

  it('the wired resolver aliases the egress packet and restores the display value (gateway pass)', async () => {
    const db = makeDb();
    installContactSchema(db);
    const resolver = await captureWiredResolver(buildDeps({ db }));
    expect(resolver).toBeDefined();

    // Drive the SAME gateway alias pass the wire seam runs, using the composer's
    // own resolver: the warehouse PII never leaves in the clear…
    const ledger = piiEgress.createSessionLedgerStore().getOrCreate('sess-1');
    const packet = reinvokePacket();
    const { aliased, summary } = piiEgress.aliasPacketForEgress({
      ledger,
      packet,
      resolver: resolver!,
    });
    const out = aliased as ReturnType<typeof reinvokePacket>;
    expect(out.prior_tool_calls[0]!.result.properties.email).toBe('m1@d1.invalid');
    expect(out.prior_tool_calls[0]!.result.properties.fullName).toBe('pii.Person1');
    // The untagged arg + numeric field ride through verbatim.
    expect(out.prior_tool_calls[0]!.args.email).toBe('arg-stays-untagged@example.com');
    expect(out.prior_tool_calls[0]!.result.properties.score).toBe(7);
    expect(summary.counts).toEqual({ email: 1, name: 1 });

    // …and the user-facing surface is fully restored — the alias the model would
    // echo maps back to the real value (the `pii-restore` backstop).
    expect(piiEgress.restoreForDisplay(ledger, 'emailing m1@d1.invalid for pii.Person1')).toBe(
      'emailing alice@acme.com for Alice Ada',
    );
  });

  it('the wired resolver content-scans chat user_message against tagged prior results', async () => {
    const db = makeDb();
    installContactSchema(db);
    const resolver = await captureWiredResolver(buildDeps({ db }));
    expect(resolver).toBeDefined();

    let seenPacket: Record<string, unknown> = {};
    const real: ExecuteChatAiCall = async (_m, input) => {
      seenPacket = JSON.parse(String(input['llm.prompt'])) as Record<string, unknown>;
      return {
        body: {
          response: `reply ${String(seenPacket.user_message)}`,
          events: [],
          tool_calls: [],
        } satisfies AIOutput,
      };
    };
    const wrapped = wrapExecuteAiCallForPii(real, planWith(resolver!));
    const result = await wrapped(MANIFEST, {
      'llm.prompt': JSON.stringify({
        ...reinvokePacket(),
        user_message: 'ask Alice Ada at alice@acme.com',
      }),
    });

    const prior = (seenPacket.prior_tool_calls as Array<{
      result?: { properties?: { email?: string; fullName?: string } };
    }>)[0]?.result?.properties;
    expect(prior?.email).toBe('m1@d1.invalid');
    expect(prior?.fullName).toBe('pii.Person1');
    expect(seenPacket.user_message).toBe('ask pii.Person1 at m1@d1.invalid');
    expect((result.body as AIOutput).response).toBe(
      'reply ask Alice Ada at alice@acme.com',
    );
  });

  it('an empty local_manifest still wires a real resolver — default-on tags shipped CRM tools; no-op for uncovered tools', async () => {
    const db = makeDb(); // no install → empty table

    const resolver = await captureWiredResolver(buildDeps({ db }));

    // The seam is still LIVE — the composer always supplies a real table-backed
    // resolver (never the noop sentinel).
    expect(resolver).toBeDefined();
    expect(resolver).not.toBe(piiEgress.noopFieldPrivacyResolver);

    // D-167 default-on: with an EMPTY local_manifest the composer still unions the
    // shipped canonical/CRM schemas (+ the built-in catalog operation-id manifest
    // fallback), so a known CRM contact read is tagged OUT OF THE BOX — the
    // `recued-core/hubspot.contact.read` tool name hits the shipped HubSpot schema.
    expect(resolver!(reinvokePacket())).toEqual(expect.arrayContaining([
      { path: 'prior_tool_calls.0.result.properties.email', kind: 'email' },
    ]));

    // The no-op invariant still holds for a tool NO shipped schema covers: it tags
    // nothing, and through the real wrap seam the egress prompt round-trips
    // byte-identical (`aliasChatAiInput` short-circuits on an empty tag list).
    const unrelatedPacket = () => ({
      prior_tool_calls: [
        {
          tool_name: 'crm.unrelated.fetch',
          status: 'ok',
          result: { properties: { email: 'alice@acme.com' } },
        },
      ],
    });
    expect(resolver!(unrelatedPacket())).toEqual([]);

    const original = JSON.stringify(unrelatedPacket());
    let seen = '';
    const real: ExecuteChatAiCall = async (_m, input) => {
      seen = String(input['llm.prompt']);
      return { body: { response: 'ok', events: [], tool_calls: [] } satisfies AIOutput };
    };
    await wrapExecuteAiCallForPii(real, planWith(resolver!))(MANIFEST, {
      'llm.prompt': original,
    });
    expect(seen).toBe(original);
  });
});

// ── End-to-end: a real composed turn (mocking only the leaf executeLLM) ─────

interface ComposedTurnResult {
  readonly egressPacket: Record<string, unknown>;
  readonly finalContent: string | undefined;
  readonly assistantAudit: Record<string, unknown> | undefined;
}

const runComposedTurn = async (opts: {
  install?: (db: Database.Database) => void;
  userMessage: string;
  aiResponse: (egress: Record<string, unknown>) => string;
}): Promise<ComposedTurnResult> => {
  const db = makeDb();
  opts.install?.(db);

  vi.resetModules();
  let egressPacket: Record<string, unknown> = {};
  const executeLLMMock = vi.fn(async (_m: unknown, input: Record<string, unknown>) => {
    egressPacket = JSON.parse(String(input['llm.prompt'])) as Record<string, unknown>;
    return {
      response: opts.aiResponse(egressPacket),
      events: [],
      tool_calls: [],
    } satisfies AIOutput;
  });
  vi.doMock('@recued/llm', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@recued/llm')>();
    return { ...actual, executeLLM: executeLLMMock };
  });
  const mod = await import('../composition/bin/wire-chat-orchestrator.js');

  const bus = eventBus();
  const auditRows: Array<{ action: string; detail?: string }> = [];
  const bundle = mod.composeChatOrchestrator(
    buildDeps({
      db,
      eventBus: bus,
      // Truthy so the composer's `executeChatAiCall` closure proceeds to the
      // (mocked) `executeLLM` rather than throwing `AI_LLM_UNAVAILABLE`.
      // D-174 R28 — the closure resolves config via `getLlmConfig()` (live),
      // not the boot `llmConfig`, so stub that truthy too (else it throws
      // before the mocked `executeLLM` is reached).
      llmConfig: {} as never,
      getLlmConfig: () => ({}) as never,
      auditLog: {
        logActivity: vi.fn(async (entry: { action: string; detail?: string }) => {
          auditRows.push({ action: entry.action, detail: entry.detail });
        }),
      } as never,
    }),
  );
  bundle.chatStore.createSession({ id: 'sess-1', now: NOW - 1_000 });

  await bundle.orchestrator.runTurn({
    session_id: 'sess-1',
    message: opts.userMessage,
    picker_state: { current: 'self' },
  });

  const events = bus.emit.mock.calls.map(([event]) => event as Record<string, unknown>);
  const messageComplete = events.find((e) => e.kind === 'chat.message_complete');
  const assistantAudit = auditRows
    .filter((r) => r.action === 'chat_message_sent')
    .map((r) => JSON.parse(r.detail ?? '{}') as Record<string, unknown>)
    .find((d) => d.role === 'assistant');
  return {
    egressPacket,
    finalContent: (messageComplete?.final as { content?: string } | undefined)?.content,
    assistantAudit,
  };
};

describe('D-167 activation — a real composed turn is behavior-preserving (empty table)', () => {
  it('round-trips a no-tool turn unchanged when nothing privacy-tagged is installed', async () => {
    const result = await runComposedTurn({
      userMessage: 'contact alice@acme.com',
      aiResponse: () => 'done',
    });

    // Egress carries the real message verbatim (the composed resolver tagged
    // nothing — a main turn has no `result` envelope, and the table is empty).
    expect(result.egressPacket.user_message).toBe('contact alice@acme.com');
    // The user-facing reply is unchanged, and no redaction summary is stamped.
    expect(result.finalContent).toBe('done');
    expect(result.assistantAudit).toBeDefined();
    expect(result.assistantAudit).not.toHaveProperty('redaction_summary');
  });

  it('installing a privacy-tagged schema does not alter a turn that reads no warehouse data', async () => {
    // The resolver is wired and LIVE, but a no-tool turn never produces a
    // `result` envelope for it to tag — so the egress + reply still round-trip
    // unchanged. (The positive alias path fires on the tool-loop reinvoke, which
    // the D-167 P5 S4 suite proves end-to-end through the orchestrator.)
    const result = await runComposedTurn({
      install: installContactSchema,
      userMessage: 'just say hi',
      aiResponse: () => 'hi',
    });

    expect(result.egressPacket.user_message).toBe('just say hi');
    expect(result.finalContent).toBe('hi');
    expect(result.assistantAudit).not.toHaveProperty('redaction_summary');
  });
});
