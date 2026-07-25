/** D-122 Phase 4 — bulk-pack flow orchestrator (post-runs_on rip).
 *
 *  These tests cover the orchestrator's seams:
 *    - Happy path → install → audit completed
 *    - Cancel pathway
 *    - pack_not_found pathway
 *    - install failure → audit failed
 *    - Input shape forwarded to engine
 *
 *  The pre-rip "Backfill kickoff" path (skip_backfill toggle, BYOK
 *  acceleration toggle, backfill_seeded counter) was retired with the
 *  scheduler — DialogOutcome is now `install | cancel`, installPack
 *  takes only the input, no per-entry backfill_seeded.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  BULK_INSTALL_PACK_VERSION,
  BULK_PACK_INSTALL_PERMISSION,
  type BulkPackManifest,
} from '@recued/contracts';
import type {
  BulkPackInstallInput,
  BulkPackInstallResult,
} from '@recued/marketplace';
import {
  runBulkPackInstall,
  type BulkPackFlowAdapters,
  type DialogOutcome,
  type PackAuditEvent,
  type PackCostEstimate,
  type PackResolution,
} from '../install/bulk-pack-flow.js';

const baseManifest: BulkPackManifest = {
  manifest_version: BULK_INSTALL_PACK_VERSION,
  slug: 'personal-crm-foundation',
  publisher: 'recued-core',
  name: 'Personal CRM Foundation',
  description: 'Alert pack with three silent producers.',
  version: 1,
  recipes: [{ slug: 'a', version: 1 }, { slug: 'b', version: 1 }],
  requires: [BULK_PACK_INSTALL_PERMISSION],
  tags: ['pack:personal-crm', 'alerts'],
};

const baseResolution: PackResolution = {
  manifest: baseManifest,
  ready: true,
  recipes: [
    {
      slug: 'a',
      pinned_version: 1,
      recipe: {
        recipe_id: 'a',
        publisher_id: 'recued-core',
        version: 1,
        recipe_hash: 'a',
        recipe: { recipe_id: 'a' } as never,
      },
    },
    {
      slug: 'b',
      pinned_version: 1,
      recipe: {
        recipe_id: 'b',
        publisher_id: 'recued-core',
        version: 1,
        recipe_hash: 'b',
        recipe: { recipe_id: 'b' } as never,
      },
    },
  ],
};

const baseEstimate: PackCostEstimate = {
  per_recipe: [
    { slug: 'a', daily_fires: 9, daily_tokens: 9 * 800 },
    { slug: 'b', daily_fires: 3, daily_tokens: 3 * 1200 },
  ],
  total_daily_fires: 12,
  total_daily_tokens: 9 * 800 + 3 * 1200,
  free_pool_consumption_pct: 1.08,
  byok_dollars_per_day: null,
};

const okResult = (): BulkPackInstallResult => ({
  ok: true,
  installed: [
    { slug: 'a', publisher_id: 'recued-core', version: 1, fresh_install: true },
    { slug: 'b', publisher_id: 'recued-core', version: 1, fresh_install: true },
  ],
  rolled_back: [],
});

const buildAdapters = (
  overrides: Partial<BulkPackFlowAdapters> = {},
  outcome: DialogOutcome = { kind: 'install' },
  installResult: BulkPackInstallResult = okResult(),
): {
  adapters: BulkPackFlowAdapters;
  capturedInput: { value?: BulkPackInstallInput };
  auditEvents: PackAuditEvent[];
} => {
  const captured: { value?: BulkPackInstallInput } = {};
  const auditEvents: PackAuditEvent[] = [];
  const adapters: BulkPackFlowAdapters = {
    fetchPack: vi.fn(async () => baseManifest),
    resolvePack: vi.fn(async () => baseResolution),
    estimateCost: vi.fn(async () => baseEstimate),
    presentDialog: vi.fn(async () => outcome),
    installPack: vi.fn(async (input) => {
      captured.value = input;
      return installResult;
    }),
    emitAudit: (event) => { auditEvents.push(event); },
    ...overrides,
  };
  return { adapters, capturedInput: captured, auditEvents };
};

describe('D-122 Phase 4 — runBulkPackInstall happy path', () => {
  it('installs and emits pack_install_completed', async () => {
    const { adapters, auditEvents } = buildAdapters();
    const result = await runBulkPackInstall('personal-crm-foundation', adapters);
    expect(result.kind).toBe('installed');
    const completed = auditEvents.find((e) => e.kind === 'pack_install_completed');
    expect(completed).toBeDefined();
    if (completed?.kind === 'pack_install_completed') {
      expect(completed.installed_recipe_count).toBe(2);
    }
  });

  it('emits pack_install_started + completed audit events in order', async () => {
    const { adapters, auditEvents } = buildAdapters();
    await runBulkPackInstall('any', adapters);
    const kinds = auditEvents.map((e) => e.kind);
    expect(kinds).toEqual(['pack_install_started', 'pack_install_completed']);
  });
});

describe('D-122 Phase 4 — runBulkPackInstall cancellation + failure', () => {
  it('returns kind=cancelled and skips installPack when user cancels', async () => {
    const { adapters, capturedInput, auditEvents } = buildAdapters({}, { kind: 'cancel' });
    const result = await runBulkPackInstall('any', adapters);
    expect(result.kind).toBe('cancelled');
    expect(capturedInput.value).toBeUndefined();
    expect(auditEvents.some((e) => e.kind === 'pack_install_cancelled')).toBe(true);
  });

  it('returns kind=pack_not_found when fetchPack returns null', async () => {
    const { adapters } = buildAdapters({
      fetchPack: vi.fn(async () => null),
    });
    const result = await runBulkPackInstall('does-not-exist', adapters);
    expect(result.kind).toBe('pack_not_found');
  });

  it('returns kind=failed and emits failure audit when installPack returns ok=false', async () => {
    const failureResult: BulkPackInstallResult = {
      ok: false,
      installed: [],
      rolled_back: [],
      failure: { code: 'validator_rejected', message: 'recipe a invalid', failed_at: { slug: 'a', version: 1 } },
    };
    const { adapters, auditEvents } = buildAdapters({}, undefined, failureResult);
    const result = await runBulkPackInstall('any', adapters);
    expect(result.kind).toBe('failed');
    if (result.kind === 'failed') {
      expect(result.reason).toContain('recipe a invalid');
    }
    const failed = auditEvents.find((e) => e.kind === 'pack_install_failed');
    expect(failed).toBeDefined();
    if (failed?.kind === 'pack_install_failed') {
      expect(failed.failed_at_slug).toBe('a');
    }
  });
});

describe('D-122 Phase 4 — runBulkPackInstall input shape', () => {
  it('forwards the manifest fields + resolved recipes verbatim', async () => {
    const { adapters, capturedInput } = buildAdapters();
    await runBulkPackInstall('personal-crm-foundation', adapters);
    expect(capturedInput.value).toMatchObject({
      manifest_version: BULK_INSTALL_PACK_VERSION,
      pack_slug: 'personal-crm-foundation',
      publisher: 'recued-core',
      requires: [BULK_PACK_INSTALL_PERMISSION],
      ready: true,
    });
    expect(capturedInput.value?.recipes).toHaveLength(2);
  });

  it('D-201 forwards webhook requirements into the install preflight', async () => {
    const webhook_requirements = [{
      binding: 'billing_events',
      profile_ids: ['stripe.event.v1'] as const,
      paired_connection_slot: 'stripe',
      required_event_types: ['invoice.paid'],
      registration_modes: ['manual'] as const,
      environment_policy: 'match_connection' as const,
      decoded_payload_access: 'scoped_read' as const,
      source_truth_policy: 'provider_readback_required' as const,
    }];
    const manifest: BulkPackManifest = { ...baseManifest, webhook_requirements };
    const { adapters, capturedInput } = buildAdapters({
      fetchPack: vi.fn(async () => manifest),
      resolvePack: vi.fn(async () => ({ ...baseResolution, manifest })),
    });

    await runBulkPackInstall('personal-crm-foundation', adapters);
    expect(capturedInput.value?.webhook_requirements).toEqual(webhook_requirements);
  });
});
