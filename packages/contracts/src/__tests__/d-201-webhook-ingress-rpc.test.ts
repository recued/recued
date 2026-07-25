import { describe, expect, it } from 'vitest';
import {
  MCP_RESERVED_RPC_PREFIXES,
  MCP_TOOL_CATALOG,
} from '../mcp-tool-catalog.js';
import {
  SERVER_RPC_METHOD_SET,
  type ServerRpcRegistry,
} from '../rpc/server-registry.js';
import type { RpcRequest, RpcResponse } from '../rpc/types.js';
import type {
  WebhookDeliveryEventPayloadView,
  WebhookDeliveryEventSummaryView,
  WebhookIngressCredentialWriteRequest,
  WebhookIngressCredentialWriteResponse,
  WebhookIngressView,
} from '../webhook-profiles.js';

const METHODS = [
  'webhook.ingress.list',
  'webhook.ingress.get',
  'webhook.ingress.create',
  'webhook.ingress.update',
  'webhook.ingress.credentials.write',
  'webhook.ingress.credentials.retire',
  'webhook.ingress.manual.confirm',
  'webhook.ingress.registration.reconcile',
  'webhook.ingress.enable',
  'webhook.ingress.disable',
  'webhook.ingress.test.deliver',
  'webhook.ingress.retire',
  'webhook.delivery.list',
  'webhook.delivery.get',
  'webhook.delivery.event.get',
  'webhook.delivery.rejected.list',
  'webhook.delivery.retention.prune',
] as const satisfies readonly (keyof ServerRpcRegistry)[];

const LOCAL_RECIPE_METHODS = [
  'recipe.webhook.status',
  'recipe.webhook.arm',
  'recipe.webhook.disarm',
] as const satisfies readonly (keyof ServerRpcRegistry)[];

describe('D-201 Slices 1 / 5A / 5B2B / 6B2 ingress RPC contract', () => {
  it('pins every lifecycle method in the exhaustive server method set', () => {
    for (const method of METHODS) expect(SERVER_RPC_METHOD_SET.has(method)).toBe(true);
    expect(SERVER_RPC_METHOD_SET.has('webhook.ingress.enable')).toBe(true);
    expect(SERVER_RPC_METHOD_SET.has('webhook.ingress.register')).toBe(false);
    const reconcile: RpcRequest<
      ServerRpcRegistry,
      'webhook.ingress.registration.reconcile'
    > = { ingress_id: 'whi_0123456789abcdef0123456789abcdef' };
    expect(Object.keys(reconcile)).toEqual(['ingress_id']);
    const cutover: RpcRequest<
      ServerRpcRegistry,
      'webhook.ingress.registration.reconcile'
    > = {
      ingress_id: 'whi_0123456789abcdef0123456789abcdef',
      paired_connection_id: 'stripe-live-rotated',
    };
    expect(Object.keys(cutover)).toEqual(['ingress_id', 'paired_connection_id']);
    expect(cutover).not.toHaveProperty('remote_endpoint_id');
    expect(cutover).not.toHaveProperty('endpoint_url');
  });

  it('reserves the entire webhook control-plane namespace out of MCP', () => {
    expect(MCP_RESERVED_RPC_PREFIXES).toContain('webhook.');
    expect(MCP_TOOL_CATALOG.some((tool) => tool.startsWith('webhook.')))
      .toBe(false);
  });

  it('keeps local recipe arming on the owner-only Kitchen RPC surface', () => {
    for (const method of LOCAL_RECIPE_METHODS) {
      expect(SERVER_RPC_METHOD_SET.has(method)).toBe(true);
    }
    expect(MCP_RESERVED_RPC_PREFIXES).toContain('recipe.');
    expect(MCP_TOOL_CATALOG.some((tool) => tool.startsWith('recipe.webhook.')))
      .toBe(false);
    const save: RpcRequest<ServerRpcRegistry, 'recipe.save'> = {
      recipe: {} as never,
      webhook_bindings: [{ binding: 'generic_delivery', ingress_id: 'whi_owner' }],
    };
    expect(save.webhook_bindings).toHaveLength(1);
  });

  it('keeps credential values on the write request and one-time generated response only', () => {
    const request: RpcRequest<ServerRpcRegistry, 'webhook.ingress.credentials.write'> = {
      ingress_id: 'whi_0123456789abcdef0123456789abcdef',
      credentials: { endpoint_secret: 'write-only' },
    } satisfies WebhookIngressCredentialWriteRequest;
    const view = {
      ingress_id: request.ingress_id,
      public_id: 'opaquePublicId_0123456789abcdef',
      display_name: 'Stripe',
      profile_id: 'stripe.event.v1',
      environment: 'live',
      paired_connection_id: null,
      registration_target: null,
      registration_mode: 'manual',
      endpoint_url: 'https://hooks.example/v1/webhooks/opaquePublicId_0123456789abcdef',
      remote_endpoint_id: null,
      selected_event_types: ['invoice.paid'],
      registration_state: 'manual_pending',
      intake_state: 'verification_pending',
      configured_fields: ['endpoint_secret'],
      missing_required_fields: [],
      active_credential_versions: [{
        version: '1',
        created_at: 1,
        retired_at: null,
        last_verified_at: null,
      }],
      readiness: {
        credentials_complete: true,
        registration_complete: false,
        registration_endpoint_matches: false,
        event_selection_complete: true,
        local_configuration_complete: false,
        profile_runtime_available: true,
        paired_connection_available: true,
        listener_available: true,
        public_url_available: true,
        public_reachability_enabled: true,
        tls_ready: true,
        clock_ready: true,
        test_delivery_supported: false,
        vault_unlocked: true,
        server_unpaused: true,
        can_enable: false,
        blockers: ['registration_incomplete'],
      },
      health: {
        status: 'pending',
        test_observed_at: null,
        last_delivery_at: null,
        last_error_code: null,
      },
      enabled_at: null,
      created_at: 1,
      updated_at: 2,
    } satisfies WebhookIngressView;
    const response: RpcResponse<ServerRpcRegistry, 'webhook.ingress.credentials.write'> = {
      ingress: view,
      credential_version: {
        version: '1',
        created_at: 2,
        retired_at: null,
        last_verified_at: null,
      },
    } satisfies WebhookIngressCredentialWriteResponse;
    expect(response.ingress).not.toHaveProperty('credential_set_ref');
    expect(response.ingress).not.toHaveProperty('credentials');
  });

  it('makes retained payload presence and expiry one consistent discriminated state', () => {
    const base = {
      event_id: 'whe_0123456789abcdef0123456789abcdef',
      delivery_id: 'whd_0123456789abcdef0123456789abcdef',
      ingress_id: 'whi_0123456789abcdef0123456789abcdef',
      event_index: 0,
      provider_event_id: null,
      provider_resource_id: null,
      provider_event_type: 'delivery',
      provider_occurred_at: null,
      selected_for_dispatch: false,
      dispatch_state: 'ignored' as const,
      metadata_expires_at: 3,
    };
    const retained = {
      ...base,
      payload_retained: true as const,
      payload_expires_at: 2,
    } satisfies WebhookDeliveryEventSummaryView;
    const expired = {
      ...base,
      payload_retained: false as const,
      payload_expires_at: null,
    } satisfies WebhookDeliveryEventSummaryView;
    const payloads: WebhookDeliveryEventPayloadView[] = [
      { event: retained, payload_retained: true, payload: null },
      { event: expired, payload_retained: false },
    ];
    expect(payloads.map((entry) => entry.payload_retained)).toEqual([true, false]);

    // @ts-expect-error a retained summary cannot omit its physical-row expiry
    const invalidSummary: WebhookDeliveryEventSummaryView = {
      ...base,
      payload_retained: true,
      payload_expires_at: null,
    };
    // @ts-expect-error an outer expired result cannot carry a retained summary
    const invalidPayload: WebhookDeliveryEventPayloadView = {
      event: retained,
      payload_retained: false,
    };
    expect([invalidSummary, invalidPayload]).toHaveLength(2);
  });
});
