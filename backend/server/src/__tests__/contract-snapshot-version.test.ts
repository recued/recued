import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { ContractDefinition, ExecutionSource } from '@recued/contracts';
import { describe, expect, it } from 'vitest';

import {
  buildVersionedContractSnapshot,
  deriveContractSnapshotVersion,
  type ContractSnapshotAuthority,
} from '../contract-snapshot-version.js';
import { buildWebhookContractSnapshot } from '../webhook-contract-snapshot.js';

const BASE_AUTHORITY: ContractSnapshotAuthority = {
  contract_id: 'ct_door',
  allowed_tools: ['mail-send', 'calendar-write'],
  approval_required: ['admin'],
  scope_restrictions: ['data.calendar.*'],
  max_risk_without_approval: 'write',
};

describe('contract snapshot authority version', () => {
  it('is stable for equivalent set ordering and independent of dispatch time', () => {
    const first = buildVersionedContractSnapshot({
      ...BASE_AUTHORITY,
      allowed_tools: ['mail-send', 'calendar-write', 'mail-send'],
      resolved_at: 1_000,
    });
    const second = buildVersionedContractSnapshot({
      ...BASE_AUTHORITY,
      allowed_tools: ['calendar-write', 'mail-send'],
      approval_required: ['admin', 'admin'],
      resolved_at: 9_000,
    });

    expect(first.contract_version).toBe(second.contract_version);
    expect(first.contract_version).toMatch(/^authority-sha256-v1:[0-9a-f]{64}$/);
    expect(first.resolved_at).not.toBe(second.resolved_at);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.allowed_tools)).toBe(true);
  });

  it.each([
    ['contract id', { ...BASE_AUTHORITY, contract_id: 'ct_other' }],
    ['tool allowlist', { ...BASE_AUTHORITY, allowed_tools: ['mail-send'] }],
    ['approval tiers', { ...BASE_AUTHORITY, approval_required: [] }],
    ['scope fence', { ...BASE_AUTHORITY, scope_restrictions: ['data.mail.*'] }],
    ['trust ceiling', { ...BASE_AUTHORITY, max_risk_without_approval: 'admin' as const }],
  ])('changes when the resolved %s changes', (_label, changed) => {
    expect(deriveContractSnapshotVersion(changed))
      .not.toBe(deriveContractSnapshotVersion(BASE_AUTHORITY));
  });

  it('distinguishes an absent ceiling from an authored ceiling', () => {
    const { max_risk_without_approval: _omitted, ...withoutCeiling } = BASE_AUTHORITY;
    expect(deriveContractSnapshotVersion(withoutCeiling))
      .not.toBe(deriveContractSnapshotVersion(BASE_AUTHORITY));
  });
});

describe('webhook contract snapshot version', () => {
  it('changes when live door authority is re-resolved or revoked', () => {
    let definition: ContractDefinition = {
      contract_id: 'ct_webhook',
      minted_at: 1_000,
      minted_by: 'owner',
      display_name: 'Webhook door',
      scope: {
        channels: ['webhook'],
        actors: ['anonymous'],
        ingredient_ids: ['mail-send'],
        operation_ids: ['core.mail.send'],
      },
      door_types: ['webhook'],
      max_risk_without_approval: 'admin',
    };
    const source: ExecutionSource = {
      channel: 'webhook',
      actor: 'anonymous',
      vendor: 'stripe',
      webhook_secret_id: 'ingress-1',
      contract_id: definition.contract_id,
    };
    const deps = {
      definitionStore: {
        get: (contractId: string) =>
          contractId === definition.contract_id ? definition : null,
      },
      now: () => 2_000,
    };

    const initial = buildWebhookContractSnapshot(source, deps, 'deterministic_handler');
    definition = {
      ...definition,
      scope: {
        ...definition.scope,
        ingredient_ids: ['mail-send', 'calendar-write'],
      },
    };
    const widened = buildWebhookContractSnapshot(source, deps, 'deterministic_handler');
    definition = {
      ...definition,
      revoked_at: 1_999,
      revocation_reason: 'disabled',
    };
    const revoked = buildWebhookContractSnapshot(source, deps, 'deterministic_handler');

    expect(initial.allowed_tools).toEqual(['mail-send']);
    expect(widened.allowed_tools).toEqual(['mail-send', 'calendar-write']);
    expect(widened.contract_version).not.toBe(initial.contract_version);
    expect(revoked.allowed_tools).toEqual([]);
    expect(revoked.max_risk_without_approval).toBeUndefined();
    expect(revoked.contract_version).not.toBe(widened.contract_version);
  });
});

const SNAPSHOT_PRODUCERS = [
  'approval-resume-authority.ts',
  'mcp-server.ts',
  'ports/llm-gateway/handler.ts',
  'reception-contract-snapshot.ts',
  'webhook-contract-snapshot.ts',
] as const;

describe('contract snapshot producer ratchet', () => {
  for (const relativePath of SNAPSHOT_PRODUCERS) {
    it(`${relativePath} delegates versioning to the shared finalizer`, () => {
      const source = readFileSync(resolve(__dirname, '..', relativePath), 'utf8');
      expect(source).toMatch(/return buildVersionedContractSnapshot\(\{/);
      expect(source).not.toMatch(/STUB_CONTRACT_VERSION/);
      expect(source).not.toMatch(/contract_version\s*:\s*['"]v?1['"]/);
    });
  }
});
