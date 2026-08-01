import { describe, expect, it, vi } from 'vitest';
import type {
  IngredientManifest,
  RecordsExecutionBinding,
  RecordsSchemaSnapshot,
} from '@recued/contracts';

import { runCatalogOperation } from '../catalog-gateway.js';
import type { ExecutionContext } from '../types.js';

const owner = { publisher: 'verified-publisher', pack_slug: 'job-status-board' };
const schema: RecordsSchemaSnapshot = {
  decimal_scale: 4,
  entities: {
    job: {
      kind: 'job',
      fields: [
        { key: 'id', slot: 'pk', kind: 'id', required: true },
        { key: 'title', slot: 's1', kind: 'string', required: true },
      ],
    },
  },
};
const binding: RecordsExecutionBinding = {
  kind: 'core.records',
  action: 'get',
  entity: 'job',
  owner,
  pack_version: 2,
  storage_schema_hash: 'a'.repeat(64),
  declaration_hash: 'b'.repeat(64),
  operation_digest: 'c'.repeat(64),
};
const manifest: IngredientManifest = {
  slug: 'job-status-board',
  name: 'Job Status Board',
  description: 'Records canary',
  author: owner.publisher,
  kind: 'storage',
  version: 2,
  category: 'data',
  risk_tier: 'read',
  input: { operation: null, args: null },
  output: { result: 'result' },
  operations: {
    'job.get': {
      operation_id: `${owner.publisher}.${owner.pack_slug}.job.get`,
      risk_tier: 'read',
      approval: 'never',
      groups: ['job.read'],
    },
  },
  operation_groups: {
    'job.read': {
      group_id: 'job.read',
      operations: ['job.get'],
      risk_floor: 'read',
    },
  },
  surfaces: { records: { executes: { 'job.get': binding }, schema } },
};

const context = (overrides: Partial<ExecutionContext> = {}): ExecutionContext => ({
  stores: {} as ExecutionContext['stores'],
  ingredientExecutor: vi.fn(async () => {
    throw new Error('Records must not enter an adapter');
  }),
  execution_source: {
    channel: 'chat',
    actor: 'user_self',
    chat_session_id: 'chat-1',
    user_id: 'user-1',
    turn_id: 'turn-1',
  },
  recordsReachabilityResolver: () => true,
  recordsOperationExecutor: vi.fn(async ({ binding: received, args, principal }) => ({
    owner: received.owner,
    args,
    principal,
  })),
  ...overrides,
});

describe('D-221 Records catalog gateway', () => {
  it('keeps ordinary catalog policy/audit but dispatches to the local executor', async () => {
    const ctx = context();
    const result = await runCatalogOperation(
      ctx,
      manifest,
      manifest.slug,
      { operation: 'job.get', args: { id: 'job-1' } },
      '',
      undefined,
      undefined,
      undefined,
    );
    expect(result).toEqual({ owner, args: { id: 'job-1' }, principal: 'user_self' });
    expect(ctx.recordsOperationExecutor).toHaveBeenCalledOnce();
    expect(ctx.ingredientExecutor).not.toHaveBeenCalled();
  });

  it('fails closed without the Records reachability grant or local executor', async () => {
    await expect(runCatalogOperation(
      context({ recordsReachabilityResolver: () => false }),
      manifest,
      manifest.slug,
      { operation: 'job.get', args: { id: 'job-1' } },
      '',
      undefined,
      undefined,
      undefined,
    )).rejects.toThrow(/not granted|denied|disabled/i);

    await expect(runCatalogOperation(
      context({ recordsOperationExecutor: undefined }),
      manifest,
      manifest.slug,
      { operation: 'job.get', args: { id: 'job-1' } },
      '',
      undefined,
      undefined,
      undefined,
    )).rejects.toThrow(/no_records_executor/);
  });

  it('derives the contracted principal and rejects an unstamped surface', async () => {
    const seen: Array<string | null> = [];
    const ctx = context({
      execution_source: {
        channel: 'mcp',
        actor: 'contracted_user',
        contract_id: 'contract-live',
        mcp_token_id: 'token-1',
        agent_id: 'agent-1',
        tool_call_id: 'call-1',
      },
      recordsReachabilityResolver: (principal) => {
        seen.push(principal);
        return principal === 'contract-live';
      },
    });
    await runCatalogOperation(
      ctx,
      manifest,
      manifest.slug,
      { operation: 'job.get', args: { id: 'job-1' } },
      '',
      undefined,
      undefined,
      undefined,
    );
    expect(seen).toEqual(['contract-live']);

    const unstamped: IngredientManifest = structuredClone(manifest);
    unstamped.surfaces!.records!.executes['job.get'] = {
      kind: 'core.records',
      action: 'get',
      entity: 'job',
    };
    await expect(runCatalogOperation(
      ctx,
      unstamped,
      unstamped.slug,
      { operation: 'job.get', args: { id: 'job-1' } },
      '',
      undefined,
      undefined,
      undefined,
    )).rejects.toThrow(/not granted|denied|disabled/i);
  });

  it('treats host-owned reactive work as owner authority but not an anonymous contract-less fire', async () => {
    const reactive = context({
      execution_source: {
        channel: 'reactive',
        actor: 'system',
        event_kind: 'records.outbox',
        source_recipe: 'notify-job-progress',
      },
    });
    await expect(runCatalogOperation(
      reactive,
      manifest,
      manifest.slug,
      { operation: 'job.get', args: { id: 'job-1' } },
      '',
      undefined,
      undefined,
      undefined,
    )).resolves.toMatchObject({ principal: 'user_self' });

    const seen: Array<string | null> = [];
    const anonymous = context({
      execution_source: {
        channel: 'webhook',
        actor: 'anonymous',
        vendor: 'example',
        webhook_secret_id: 'hook-1',
      },
      recordsReachabilityResolver: (principal) => {
        seen.push(principal);
        return principal !== null;
      },
    });
    await expect(runCatalogOperation(
      anonymous,
      manifest,
      manifest.slug,
      { operation: 'job.get', args: { id: 'job-1' } },
      '',
      undefined,
      undefined,
      undefined,
    )).rejects.toThrow(/not granted|denied|disabled/i);
    expect(seen).toEqual([null]);
  });
});
