/** D-192 CRM escalation admission seam.
 *
 *  This suite pins channel posture for the S3 CRM live-escalation leg:
 *  every refusal is zero-invoke and silently keeps the mirror, every result
 *  keeps an honest crm_freshness.filter_applied value, and admitted fetches
 *  thread the caller origin through to the live CRM reader. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  ChatDispatchContext,
  ContractSnapshot,
  EnrichmentScope,
  ExecutionSource,
  IngredientManifest,
} from '@recued/contracts';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  buildChatTier1Handlers,
  type ChatToolHandlerDeps,
} from '../chat-tool-handlers.js';
import type { EscalationOrigin } from '../escalation-admission.js';
import type { OpAdmissionGate } from '../op-admission-gate.js';
import {
  createEnrichmentStore,
  type EnrichmentStore,
} from '../storage/enrichment-store.js';
import {
  createCrmRecordMirrorStore,
  ensureCrmRecordMirrorSchema,
  type CrmRecordMirrorStore,
} from '../storage/crm-record-mirror-store.js';

const DEAL_SCOPE = 'connection.api.hubspot.deal' as EnrichmentScope;
const CONNECTION_NAME = 'acme-hubspot';
const CATALOG_SLUG = 'hubspot-catalog';
const OPERATION_ID = 'recued-core/hubspot.deal.search';
const MIRROR_TARGET_ID = `hubspot_deal_${CONNECTION_NAME}_mirror`;
const LIVE_TARGET_ID = `hubspot_deal_${CONNECTION_NAME}_live1`;
const QUERY = 'Escalation';

type Gate = Pick<
  OpAdmissionGate,
  'isFrozenByPause' | 'isOpGranted' | 'isOwnerRecipeGranted' | 'isOwnerGoverned'
>;
type LiveInput = Parameters<NonNullable<ChatToolHandlerDeps['getCrmLiveRecords']>>[0];
type EscalationBinding = NonNullable<
  ReturnType<NonNullable<ChatToolHandlerDeps['getCrmEscalationBinding']>>
>;

interface DealSearchResult {
  candidates: Array<{
    source: string;
    record: {
      target_id: string;
      name?: string;
      close_state?: string;
    };
  }>;
  crm_freshness: Array<{
    connection_name: string;
    vendor: string;
    entity: string;
    synced_at: number | null;
    filter_applied?: 'local' | 'server';
  }>;
}

interface Harness {
  deps: ChatToolHandlerDeps;
  liveCalls: LiveInput[];
  bindingLookups: string[];
}

interface HarnessOptions {
  syncedAt: number | null;
  live?: Map<string, Record<string, unknown>> | null;
  binding?: EscalationBinding | null;
  gate?: Gate;
  gateGetter?: 'present' | 'absent' | 'undefined';
}

let dir: string;
let db: Database.Database;
let enrichmentStore: EnrichmentStore;
let mirror: CrmRecordMirrorStore;

const manifestFixture: IngredientManifest = {
  slug: CATALOG_SLUG,
  name: 'HubSpot catalog',
  description: 'Test catalog backing deal.search live escalation',
  author: 'recued',
  kind: 'connection',
  category: 'data',
  risk_tier: 'read',
  input: {},
  output: {},
  operations: {
    'deal.search': {
      operation_id: OPERATION_ID,
      description: 'Search deals',
      risk_tier: 'read',
    },
  },
};

const defaultBinding: EscalationBinding = {
  catalogSlug: CATALOG_SLUG,
  manifest: manifestFixture,
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd192-crm-escalation-'));
  db = new Database(join(dir, 'test.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  enrichmentStore = createEnrichmentStore(db);
  ensureCrmRecordMirrorSchema(db);
  mirror = createCrmRecordMirrorStore(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const permissiveGate = (overrides: Partial<Gate> = {}): Gate => ({
  isFrozenByPause: () => false,
  isOpGranted: () => true,
  // D-247 — these suites drive an MCP DOOR. `isOwnerGoverned: false` is the
  // production answer for one, not a convenience stub: a door's recipe
  // authority is its inbound token, never the owner's contract.
  isOwnerGoverned: () => false,
  isOwnerRecipeGranted: () => false,
  ...overrides,
});

const mcpSource = (
  toolCallId: string = 'call-crm',
): Extract<ExecutionSource, { channel: 'mcp' }> => ({
  channel: 'mcp',
  actor: 'contracted_user',
  agent_id: 'agent-crm',
  tool_call_id: toolCallId,
  mcp_token_id: 'token-crm',
  contract_id: 'contract-crm',
});

const chatSource = (): Extract<
  ExecutionSource,
  { channel: 'chat'; actor: 'user_self' }
> => ({
  channel: 'chat',
  actor: 'user_self',
  chat_session_id: 'sess-crm',
  user_id: 'local',
  turn_id: 'turn-crm',
});

const snapshot = (
  allowedTools: readonly string[],
  scopeRestrictions: readonly string[] = [],
): ContractSnapshot => ({
  contract_id: 'contract-crm',
  contract_version: 'v1',
  allowed_tools: allowedTools,
  approval_required: [],
  scope_restrictions: scopeRestrictions,
  resolved_at: 1_700_000_000_000,
});

const mcpCtx = (
  source: Extract<ExecutionSource, { channel: 'mcp' }>,
  contractSnapshot?: ContractSnapshot,
): ChatDispatchContext => ({
  channel: 'mcp_wire',
  mcp_token_id: 'token-crm',
  execution_source: source,
  ...(contractSnapshot !== undefined ? { contract_snapshot: contractSnapshot } : {}),
});

const ownerCtx = (
  source?: Extract<ExecutionSource, { channel: 'chat'; actor: 'user_self' }>,
): ChatDispatchContext => ({
  channel: 'internal_function_call',
  session_id: 'sess-crm',
  turn_id: 'turn-crm',
  ...(source !== undefined ? { execution_source: source } : {}),
});

const liveRecords = (): Map<string, Record<string, unknown>> =>
  new Map([
    [
      'live1',
      {
        snapshot_at: 2,
        snapshot_hash: 'live-hash',
        name: 'Live Escalation deal',
        close_state: 'open',
      },
    ],
  ]);

const seedMirrorDeal = (): void => {
  mirror.upsert({
    scope: DEAL_SCOPE,
    target_id: MIRROR_TARGET_ID,
    now: 1,
    meta: {
      snapshot_at: 1,
      snapshot_hash: 'mirror-hash',
      name: 'Mirror Escalation deal',
      close_state: 'open',
    },
  });
};

const buildDeps = (opts: HarnessOptions): Harness => {
  const live = opts.live === undefined ? liveRecords() : opts.live;
  const binding = opts.binding === undefined ? defaultBinding : opts.binding;
  const liveCalls: LiveInput[] = [];
  const bindingLookups: string[] = [];
  const gateGetter = opts.gateGetter ?? 'present';

  const deps: ChatToolHandlerDeps = {
    getContactStore: () => undefined,
    getCollectionRegistry: () => undefined,
    getAuditLog: () => undefined,
    getEnrichmentStore: () => enrichmentStore,
    getCrmRecordMirror: () => mirror,
    getRecipeStore: () =>
      ({ ids: () => [], get: () => null, getStored: () => null, listStored: () => [] }) as never,
    getExecutorConfig: () => ({ manifests: { get: () => null } }) as never,
    getExecuteRecipe: () => undefined,
    getBoundCrmMirrorSources: (crmAlias) =>
      crmAlias === 'deal' ? [{ source_id: 'hubspot', scope: DEAL_SCOPE }] : [],
    getCrmConnectionFreshness: (crmAlias) =>
      crmAlias === 'deal'
        ? [
            {
              connection_name: CONNECTION_NAME,
              vendor: 'hubspot',
              entity: 'deal',
              synced_at: opts.syncedAt,
            },
          ]
        : [],
    getCrmLiveRecords: async (input) => {
      liveCalls.push(input);
      return live;
    },
    getCrmEscalationBinding: (connectionName) => {
      bindingLookups.push(connectionName);
      return binding;
    },
  };

  if (gateGetter === 'present') {
    deps.getOpAdmissionGate = () => opts.gate ?? permissiveGate();
  } else if (gateGetter === 'undefined') {
    deps.getOpAdmissionGate = () => undefined;
  }

  return { deps, liveCalls, bindingLookups };
};

const runDealSearch = async (
  deps: ChatToolHandlerDeps,
  ctx: ChatDispatchContext,
): Promise<DealSearchResult> => {
  const handler = buildChatTier1Handlers(deps)['deal.search'];
  if (handler === undefined) throw new Error('missing deal.search handler');
  const result = await handler({ query: QUERY, limit: 10 }, ctx);
  if (!result.ok) {
    throw new Error(`expected ok deal.search result, got ${result.reason}: ${result.detail ?? ''}`);
  }
  return result.result as DealSearchResult;
};

const candidateIds = (result: DealSearchResult): string[] =>
  result.candidates.map((candidate) => candidate.record.target_id);

const expectFreshnessFilter = (
  result: DealSearchResult,
  filter: 'local' | 'server',
): void => {
  expect(result.crm_freshness).toHaveLength(1);
  expect(result.crm_freshness[0]?.filter_applied).toBe(filter);
};

describe('D-192 CRM escalation admission seam', () => {
  it('ADMITS external mcp_wire when the contract allows the backing catalog slug', async () => {
    seedMirrorDeal();
    const source = mcpSource('call-admitted');
    const harness = buildDeps({ syncedAt: null });

    const result = await runDealSearch(
      harness.deps,
      mcpCtx(source, snapshot([CATALOG_SLUG])),
    );

    expect(harness.liveCalls).toHaveLength(1);
    expect(candidateIds(result)).toEqual([LIVE_TARGET_ID]);
    expectFreshnessFilter(result, 'server');
    const origin = harness.liveCalls[0]?.origin as EscalationOrigin | undefined;
    expect(origin?.execution_source).toBe(source);
    expect(origin?.trigger_source).toBe('mcp');
    expect(origin?.correlation_id).toBe(source.tool_call_id);
  });

  it('DENIES external mcp_wire when the backing catalog slug is not in the contract', async () => {
    seedMirrorDeal();
    const harness = buildDeps({ syncedAt: null });

    const result = await runDealSearch(
      harness.deps,
      mcpCtx(mcpSource('call-tool-denied'), snapshot(['some-other-tool'])),
    );

    expect(harness.liveCalls).toHaveLength(0);
    expect(candidateIds(result)).toEqual([MIRROR_TARGET_ID]);
    expectFreshnessFilter(result, 'local');
  });

  it('DENIES external mcp_wire when the door scope fence excludes connection.api', async () => {
    seedMirrorDeal();
    const harness = buildDeps({ syncedAt: null });

    const result = await runDealSearch(
      harness.deps,
      mcpCtx(mcpSource('call-scope-denied'), snapshot([CATALOG_SLUG], ['data.contact'])),
    );

    expect(harness.liveCalls).toHaveLength(0);
    expect(candidateIds(result)).toEqual([MIRROR_TARGET_ID]);
    expectFreshnessFilter(result, 'local');
  });

  it('DENIES external mcp_wire when the source has no paired contract snapshot', async () => {
    seedMirrorDeal();
    const harness = buildDeps({ syncedAt: null });

    const result = await runDealSearch(
      harness.deps,
      mcpCtx(mcpSource('call-missing-snapshot')),
    );

    expect(harness.liveCalls).toHaveLength(0);
    expect(candidateIds(result)).toEqual([MIRROR_TARGET_ID]);
    expectFreshnessFilter(result, 'local');
  });

  it('DENIES external mcp_wire when the op-admission gate is absent', async () => {
    seedMirrorDeal();
    const harness = buildDeps({ syncedAt: null, gateGetter: 'absent' });

    const result = await runDealSearch(
      harness.deps,
      mcpCtx(mcpSource('call-missing-gate'), snapshot([CATALOG_SLUG])),
    );

    expect(harness.liveCalls).toHaveLength(0);
    expect(candidateIds(result)).toEqual([MIRROR_TARGET_ID]);
    expectFreshnessFilter(result, 'local');
  });

  it('DENIES external mcp_wire when the CRM escalation binding is unresolvable', async () => {
    seedMirrorDeal();
    const harness = buildDeps({ syncedAt: null, binding: null });

    const result = await runDealSearch(
      harness.deps,
      mcpCtx(mcpSource('call-unbound'), snapshot([CATALOG_SLUG])),
    );

    expect(harness.liveCalls).toHaveLength(0);
    expect(candidateIds(result)).toEqual([MIRROR_TARGET_ID]);
    expectFreshnessFilter(result, 'local');
  });

  it('ADMITS owner chat with no execution_source under the pre-seam ungated posture', async () => {
    seedMirrorDeal();
    const harness = buildDeps({ syncedAt: null });

    const result = await runDealSearch(harness.deps, ownerCtx());

    expect(harness.liveCalls).toHaveLength(1);
    expect(candidateIds(result)).toEqual([LIVE_TARGET_ID]);
    expectFreshnessFilter(result, 'server');
    expect(harness.liveCalls[0]?.origin).toEqual({ trigger_source: 'chat' });
  });

  it('DENIES owner chat with a source when the D-188 pause gate is frozen', async () => {
    seedMirrorDeal();
    const source = chatSource();
    const frozenSources: ExecutionSource[] = [];
    const harness = buildDeps({
      syncedAt: null,
      gate: permissiveGate({
        isFrozenByPause: (judgedSource) => {
          frozenSources.push(judgedSource);
          return true;
        },
      }),
    });

    const result = await runDealSearch(harness.deps, ownerCtx(source));

    expect(harness.liveCalls).toHaveLength(0);
    expect(candidateIds(result)).toEqual([MIRROR_TARGET_ID]);
    expectFreshnessFilter(result, 'local');
    expect(frozenSources).toEqual([source]);
  });

  it('DENIES owner chat with a source when the declared operation_id is revoked', async () => {
    seedMirrorDeal();
    const judgedOps: Array<string | undefined> = [];
    const harness = buildDeps({
      syncedAt: null,
      gate: permissiveGate({
        isOpGranted: (_source, opId) => {
          judgedOps.push(opId);
          return false;
        },
      }),
    });

    const result = await runDealSearch(harness.deps, ownerCtx(chatSource()));

    expect(harness.liveCalls).toHaveLength(0);
    expect(candidateIds(result)).toEqual([MIRROR_TARGET_ID]);
    expectFreshnessFilter(result, 'local');
    expect(judgedOps).toEqual([OPERATION_ID]);
  });

  it('ADMITS owner chat when the CRM escalation binding is unresolvable', async () => {
    seedMirrorDeal();
    const harness = buildDeps({ syncedAt: null, binding: null });

    const result = await runDealSearch(harness.deps, ownerCtx(chatSource()));

    expect(harness.liveCalls).toHaveLength(1);
    expect(candidateIds(result)).toEqual([LIVE_TARGET_ID]);
    expectFreshnessFilter(result, 'server');
  });

  it('does not judge admission or fetch live records for a fresh connection hit', async () => {
    seedMirrorDeal();
    const harness = buildDeps({ syncedAt: Date.now() });

    const result = await runDealSearch(harness.deps, ownerCtx(chatSource()));

    expect(harness.liveCalls).toHaveLength(0);
    expect(harness.bindingLookups).toHaveLength(0);
    expect(candidateIds(result)).toEqual([MIRROR_TARGET_ID]);
    expectFreshnessFilter(result, 'local');
  });
});
