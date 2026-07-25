import { describe, expect, it } from 'vitest';
import type { IngredientManifest, OperationSpec } from '@recued/contracts';
import { validateIngredient } from '../validate.js';

const URL_BEARING_DECLARATION: OperationSpec['operation_bound_webhook'] = {
  binding: 'fixture_events',
  intent: 'attach',
  // @ts-expect-error D-201: callback URLs are not representable in the portable declaration.
  callback_url: 'https://attacker.invalid/callback',
};
void URL_BEARING_DECLARATION;

const manifest = (): IngredientManifest => ({
  slug: 'webhook-operation-fixture',
  name: 'Operation-bound fixture',
  description: 'D-201 Slice 6B3 catalog declaration fixture',
  author: 'recued-core',
  kind: 'connection',
  version: 1,
  category: 'action',
  risk_tier: 'read',
  input: {},
  output: {},
  operations: {
    'resource.create': {
      operation_id: 'recued-core.webhook-operation-fixture.resource.create',
      risk_tier: 'write',
      approval: 'never',
      cache_ttl_ms: 0,
      operation_bound_webhook: {
        binding: 'fixture_events',
        intent: 'attach',
      },
    },
  },
  surfaces: {
    api: {
      transport: 'rest',
      default_base_url: 'https://fixture.invalid',
      auth: { kind: 'none' },
      executes: {
        'resource.create': {
          kind: 'rest',
          method: 'POST',
          path_template: '/resources',
        },
      },
    },
  },
});

const operationBoundIssues = (value: IngredientManifest) =>
  validateIngredient(value).issues.filter((issue) =>
    issue.code === 'CATALOG_OPERATION_BOUND_WEBHOOK_INVALID');

describe('D-201 Slice 6B3 operation-bound catalog declaration', () => {
  it('accepts only a non-read REST operation naming a logical binding and intent', () => {
    expect(operationBoundIssues(manifest())).toEqual([]);
  });

  it('rejects request construction, reserved bindings, invalid intent, and read tier', () => {
    const requestConstruction = manifest();
    const requestOperation = requestConstruction.operations![
      'resource.create'
    ] as unknown as Record<string, unknown>;
    requestOperation.operation_bound_webhook = {
      binding: 'fixture_events',
      intent: 'attach',
      callback_url: 'https://attacker.invalid/callback',
    };
    expect(operationBoundIssues(requestConstruction)).toContainEqual(expect.objectContaining({
      path: 'operations.resource.create.operation_bound_webhook',
      message: expect.stringContaining('only binding and intent'),
    }));

    const malformed = manifest();
    const malformedOperation = malformed.operations![
      'resource.create'
    ] as unknown as Record<string, unknown>;
    malformedOperation.risk_tier = 'read';
    malformedOperation.operation_bound_webhook = {
      binding: 'constructor',
      intent: 'replace',
    };
    expect(operationBoundIssues(malformed)).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'operations.resource.create.operation_bound_webhook.binding' }),
      expect.objectContaining({ path: 'operations.resource.create.operation_bound_webhook.intent' }),
      expect.objectContaining({ message: expect.stringContaining('cannot be read-tier') }),
    ]));
  });

  it('rejects non-REST execution so callback injection never falls into a generic protocol', () => {
    const graphql = manifest() as IngredientManifest & {
      surfaces: { api: { executes: Record<string, Record<string, unknown>> } };
    };
    graphql.surfaces.api.executes['resource.create'] = {
      kind: 'graphql',
      operation_type: 'mutation',
      endpoint_path: '/graphql',
      query: 'mutation Create { create { id } }',
    };
    expect(operationBoundIssues(graphql)).toContainEqual(expect.objectContaining({
      message: expect.stringContaining('requires a REST execution binding'),
    }));
  });
});
