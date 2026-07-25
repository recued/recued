/** D-137 Trio #D follow-on — `memory.search` MCP-wire projection.
 *
 *  Trio #D wired the `InternalToolRegistry` through the MCP server so
 *  external agents see Tier 1 + Tier 2 tools through the same
 *  registry the chat orchestrator dispatches over. The Codex P1 fold
 *  added channel-aware gating for `enrichment.search` + `recipe.run`
 *  + Tier 2. Three other Tier 1 reads were noted as "may need similar
 *  attention" in the Trio #D handover; `memory.search` is the load-
 *  bearing one because `AuditEntry.config_snapshot` carries user-set
 *  variables that pre-vault BYOK flows route credentials through.
 *
 *  Projection chosen: mirror `data.timeline()`'s memory-source
 *  projection at `mcp/timeline.ts:246-263`. Both MCP read paths
 *  surface the same shape for the same row.
 *
 *  Drops on MCP wire:
 *    - `config_snapshot` — user-set recipe variables.
 *    - `errors[].{message,details,timestamp}` — free-form details
 *      surface filesystem paths + vendor response fragments.
 *
 *  Keeps verbatim: stable identifying / outcome / provenance fields
 *  + short `output_string` + backfill rollup + recipe-shape pointer.
 *
 *  Internal-channel dispatches (Mary's own chat) keep the full audit
 *  entry — Mary authored the config_snapshot, she sees it.
 */

import { describe, it, expect, vi } from 'vitest';
import type { AuditEntry } from '@recued/storage';
import type { ChatDispatchContext } from '@recued/contracts';
import {
  buildChatTier1Handlers,
  projectAuditEntryForMcp,
  type ChatToolHandlerDeps,
} from '../chat-tool-handlers.js';

// ────────────────────────────────────────────────────────────────
// Test fixtures
// ────────────────────────────────────────────────────────────────

const ctxMcp = (mcp_token_id = 'tok-1'): ChatDispatchContext => ({
  channel: 'mcp_wire',
  mcp_token_id,
});

const ctxInternal = (
  session_id = 'sess-1',
  turn_id = 'turn-1',
): ChatDispatchContext => ({
  channel: 'internal_function_call',
  session_id,
  turn_id,
});

const buildDepsStub = (
  overrides: Partial<ChatToolHandlerDeps> = {},
): ChatToolHandlerDeps => ({
  getContactStore: () => undefined,
  getCollectionRegistry: () => undefined,
  getAuditLog: () => undefined,
  getEnrichmentStore: () => undefined,
  getRecipeStore: () =>
    ({
      ids: () => [],
      get: () => null,
      getStored: () => null,
      listStored: () => [],
    }) as never,
  getExecutorConfig: () => ({ manifests: { get: () => null } }) as never,
  getExecuteRecipe: () => undefined,
  ...overrides,
});

/** Full audit entry fixture that exercises every projection drop +
 *  pass-through field. config_snapshot carries a synthetic BYOK-shaped
 *  key (deliberately sensitive); the error details / message carry a
 *  filesystem path + a vendor token shape. */
const buildFullAuditEntry = (recipe_id = 'recued-core/test'): AuditEntry => ({
  run_id: 'run-1',
  recipe_id,
  recipe_hash: 'fnv1a-abc123',
  started_at: 1_700_000_000_000,
  finished_at: 1_700_000_001_000,
  duration_ms: 1000,
  commit_status: 'failed',
  config_snapshot: {
    anthropic_api_key: 'sk-secret-byok-key',
    vip_filter: 'vip@*.example.com',
    threshold: 50_000,
  },
  errors: [
    {
      error_id: 'err-1',
      code: 'INGREDIENT_NOT_FOUND',
      message: 'detailed message with /private/path/to/file.json',
      severity: 'error',
      retryable: false,
      source: {
        recipe_id,
        step_id: 'step-1',
        ingredient_slug: 'foo-bar',
      },
      details: {
        path: '/private/path/to/file.json',
        vendor_token: 'bearer-leak-xyz',
      },
      timestamp: '2026-05-12T00:00:01.000Z',
    },
  ],
  trigger_url: 'https://app.example.com/x',
  trigger_source: 'manual',
  instance_id: 'inst-1',
  process_id: 'proc-1',
  output_string: 'completed with warnings',
  recipe_insight_id: 42,
  event_at: 1_699_999_900_000,
  run_mode: 'live',
  backfill: { missed_cycles: 3, last_run_at_before: 1_699_900_000_000 },
});

// ────────────────────────────────────────────────────────────────
// Pure projection
// ────────────────────────────────────────────────────────────────

describe('D-137 Trio #D follow-on — projectAuditEntryForMcp', () => {
  it('drops config_snapshot wholesale', () => {
    const entry = buildFullAuditEntry();
    const projected = projectAuditEntryForMcp(entry);
    expect('config_snapshot' in projected).toBe(false);
  });

  it('keeps stable identifying + outcome + provenance fields verbatim', () => {
    const entry = buildFullAuditEntry();
    const projected = projectAuditEntryForMcp(entry);
    expect(projected.run_id).toBe(entry.run_id);
    expect(projected.recipe_id).toBe(entry.recipe_id);
    expect(projected.recipe_hash).toBe(entry.recipe_hash);
    expect(projected.started_at).toBe(entry.started_at);
    expect(projected.finished_at).toBe(entry.finished_at);
    expect(projected.duration_ms).toBe(entry.duration_ms);
    expect(projected.commit_status).toBe(entry.commit_status);
    expect(projected.trigger_url).toBe(entry.trigger_url);
    expect(projected.trigger_source).toBe(entry.trigger_source);
    expect(projected.instance_id).toBe(entry.instance_id);
    expect(projected.process_id).toBe(entry.process_id);
    expect(projected.output_string).toBe(entry.output_string);
    expect(projected.recipe_insight_id).toBe(entry.recipe_insight_id);
    expect(projected.event_at).toBe(entry.event_at);
    expect(projected.run_mode).toBe(entry.run_mode);
    expect(projected.backfill).toEqual(entry.backfill);
  });

  it('projects errors[] to closed enum only — message/details/timestamp dropped', () => {
    const entry = buildFullAuditEntry();
    const projected = projectAuditEntryForMcp(entry);
    expect(projected.errors).toHaveLength(1);
    const err = projected.errors[0]!;
    expect(err.error_id).toBe('err-1');
    expect(err.code).toBe('INGREDIENT_NOT_FOUND');
    expect(err.severity).toBe('error');
    expect(err.retryable).toBe(false);
    expect(err.source).toEqual({
      recipe_id: entry.recipe_id,
      step_id: 'step-1',
      ingredient_slug: 'foo-bar',
    });
    expect('message' in (err as object)).toBe(false);
    expect('details' in (err as object)).toBe(false);
    expect('timestamp' in (err as object)).toBe(false);
  });

  it('verifies no sensitive payload leaks through projected entry', () => {
    const entry = buildFullAuditEntry();
    const projected = projectAuditEntryForMcp(entry);
    const json = JSON.stringify(projected);
    // The synthetic BYOK key, vendor token, and filesystem path must
    // not appear anywhere in the projection. These three strings cover
    // the three drop categories (config_snapshot / error.details /
    // error.message).
    expect(json).not.toContain('sk-secret-byok-key');
    expect(json).not.toContain('bearer-leak-xyz');
    expect(json).not.toContain('/private/path/to/file.json');
  });

  it('does NOT mutate the input entry (pure function)', () => {
    const entry = buildFullAuditEntry();
    const snapshot = JSON.stringify(entry);
    projectAuditEntryForMcp(entry);
    expect(JSON.stringify(entry)).toBe(snapshot);
  });
});

// ────────────────────────────────────────────────────────────────
// D-153 follow-on — allow-list closes the rest-spread leak that
// would have surfaced every new commit-substrate field on the MCP
// wire by default. The projection now Picks an enumerated key set;
// any new AuditEntry field stays internal until added by name.
// ────────────────────────────────────────────────────────────────

describe('D-153 follow-on — projectAuditEntryForMcp drops commit-substrate fields', () => {
  /** Audit entry populated with every D-153 P1 commit-substrate
   *  field. Each id uses a distinct, distinctive substring so the
   *  JSON scan below cannot collide with other payload content. */
  const buildD153AuditEntry = (): AuditEntry => ({
    ...buildFullAuditEntry(),
    commit_kind: 'action',
    channel_session_id: 'chan-leak-vector-aaaa',
    cognition_session_id: 'cog-leak-vector-bbbb',
    correlation_id: 'corr-leak-vector-cccc',
    idempotency_key: 'idem-leak-vector-dddd',
    predecessor_commit_id: 'prev-leak-vector-eeee',
    contract_snapshot: {
      contract_id: 'contract-leak-vector-ffff',
      contract_version: '1',
      allowed_tools: ['recipe.run', 'mail.send'],
      approval_required: ['risky'],
      scope_restrictions: ['data.calendar', 'connection.api.hubspot'],
      resolved_at: 1_700_000_000_500,
    },
  });

  it('drops every D-153 commit-substrate field from the MCP projection', () => {
    const entry = buildD153AuditEntry();
    const projected = projectAuditEntryForMcp(entry);
    // Property-presence checks — these are the seven D-153 fields
    // that the previous rest-spread `Omit<..., 'config_snapshot' |
    // 'steps' | 'errors'>` projection would have surfaced verbatim.
    expect('commit_kind' in projected).toBe(false);
    expect('channel_session_id' in projected).toBe(false);
    expect('cognition_session_id' in projected).toBe(false);
    expect('correlation_id' in projected).toBe(false);
    expect('idempotency_key' in projected).toBe(false);
    expect('predecessor_commit_id' in projected).toBe(false);
    expect('contract_snapshot' in projected).toBe(false);
  });

  it('no D-153 id / contract value appears anywhere in the serialised projection', () => {
    const entry = buildD153AuditEntry();
    const projected = projectAuditEntryForMcp(entry);
    const json = JSON.stringify(projected);
    // Substring scan — catches accidental leaks through nested
    // placement (e.g., contract_snapshot.allowed_tools accidentally
    // surfaced inside errors[]).
    expect(json).not.toContain('chan-leak-vector-aaaa');
    expect(json).not.toContain('cog-leak-vector-bbbb');
    expect(json).not.toContain('corr-leak-vector-cccc');
    expect(json).not.toContain('idem-leak-vector-dddd');
    expect(json).not.toContain('prev-leak-vector-eeee');
    expect(json).not.toContain('contract-leak-vector-ffff');
  });

  it('allow-listed fields still surface verbatim alongside the new drops', () => {
    const entry = buildD153AuditEntry();
    const projected = projectAuditEntryForMcp(entry);
    // Spot-check that the drop didn't widen accidentally.
    expect(projected.run_id).toBe(entry.run_id);
    expect(projected.commit_status).toBe(entry.commit_status);
    expect(projected.event_at).toBe(entry.event_at);
    expect(projected.run_mode).toBe(entry.run_mode);
    expect(projected.recipe_insight_id).toBe(entry.recipe_insight_id);
  });
});

// ────────────────────────────────────────────────────────────────
// RETIRED — `memory.search` channel-aware dispatch (4 tests)
//
// `memory.search` no longer reads the audit log at all: the audit half was
// removed (it bypassed `core.memory.audit.read` — the grant the MCP door DOES
// enforce — and, being recency-dumped rather than matched, crowded the body
// budget with the noisiest feed). It is now pool-only recall, so there is no
// `entries[]` and no `mcp_wire` audit projection to dispatch.
//
// `projectAuditEntryForMcp` itself is KEPT + still covered by the two describes
// above (MCP-safe projection: drops `config_snapshot`, drops D-153 commit
// fields, leaks no payload) and by `d-145-slice-3b-4-audit-steps-retired`. A
// future owner-only `runs.search` is its next consumer.
//
// New `memory.search` behavior is covered by `d-198-memory-search-recall.test.ts`.
// ────────────────────────────────────────────────────────────────
