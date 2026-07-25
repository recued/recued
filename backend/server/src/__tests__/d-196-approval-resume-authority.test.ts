/** D-196 R2 — approval resume treats persisted snapshots as evidence only. */

import {
  LLM_GATEWAY_PAID_ACK_VERSION,
  type ExecutionSource,
  type IngredientManifest,
  type McpInboundTokenRecord,
  type SellerCustomer,
  type SellerSettings,
  type SellerTier,
} from '@recued/contracts';
import { describe, expect, it, vi } from 'vitest';

import {
  createApprovalResumeAuthorityResolver,
  type ApprovalResumeAuthorityResolverDeps,
} from '../approval-resume-authority.js';

const NOW = 1_800_000_000_000;
const TOKEN_ID = 'tok_customer_1';
const CONTRACT_ID = 'ct_customer_1';
const RECIPE_GRANT = 'seller/order-create';

const manifests = {
  slugs: () => ['mail-send', 'calendar-read'],
  get: (slug: string) => ({
    slug,
    kind: 'http',
    risk_tier: slug === 'mail-send' ? 'write' : 'read',
  } as unknown as IngredientManifest),
} as unknown as ApprovalResumeAuthorityResolverDeps['manifests'];

const token = (
  overrides: Partial<McpInboundTokenRecord> = {},
): McpInboundTokenRecord => ({
  token_id: TOKEN_ID,
  bearer_hash: 'a'.repeat(64),
  label: 'Customer door',
  created_at: NOW - 10_000,
  expires_at: NOW + 60_000,
  revoked_at: null,
  grants: {
    [RECIPE_GRANT]: true,
    'recued_ingredient_mail-send': true,
  },
  concurrency_tier: 3,
  chat_mode: null,
  contract_id: CONTRACT_ID,
  updated_at: NOW - 10_000,
  ...overrides,
});

const mcpSource = (
  overrides: Partial<Extract<ExecutionSource, { channel: 'mcp' }>> = {},
): Extract<ExecutionSource, { channel: 'mcp' }> => ({
  channel: 'mcp',
  actor: 'contracted_user',
  agent_id: 'agent-1',
  tool_call_id: 'call-1',
  mcp_token_id: TOKEN_ID,
  contract_id: CONTRACT_ID,
  ...overrides,
});

const llmSource = (): Extract<
  ExecutionSource,
  { channel: 'chat'; actor: 'contracted_user' }
> => ({
  channel: 'chat',
  actor: 'contracted_user',
  chat_session_id: `llm_gateway:${TOKEN_ID}:request-1`,
  user_id: 'customer-1',
  contract_id: CONTRACT_ID,
  turn_id: 'turn-1',
});

const overlay = (
  overrides: Partial<NonNullable<ApprovalResumeAuthorityResolverDeps['contractOverlay']>> = {},
): NonNullable<ApprovalResumeAuthorityResolverDeps['contractOverlay']> => ({
  isContractLive: vi.fn(() => true),
  permitsDoorType: vi.fn(() => true),
  resolveBoundContractKind: vi.fn((): 'standing' => 'standing'),
  resolveContractScopeRestrictions: vi.fn(() => ['data.contact.*']),
  ...overrides,
});

const settings = (): SellerSettings => ({
  default_grace_hours: 72,
  sender_mail_instance_id: null,
  status_policy_json: {},
  email_policy_json: {},
  llm_gateway_paid_ack_at: NOW,
  llm_gateway_paid_ack_version: LLM_GATEWAY_PAID_ACK_VERSION,
  created_at: NOW,
  updated_at: NOW,
});

const tier = (overrides: Partial<SellerTier> = {}): SellerTier => ({
  tier_id: 'tier_basic',
  door_id: 'door_mcp',
  lifecycle_source: 'stripe',
  entitlement_key: 'basic',
  display_name: 'Basic',
  template_contract_id: 'ct_template_basic',
  external_entitlement_id: null,
  usage_policy_json: {},
  pass_duration_seconds: null,
  customer_status_enabled_default: false,
  active: true,
  created_at: NOW,
  updated_at: NOW,
  ...overrides,
});

const customer = (overrides: Partial<SellerCustomer> = {}): SellerCustomer => ({
  customer_id: 'customer-1',
  lifecycle_source: 'stripe',
  source_customer_id: 'cus_1',
  door_id: 'door_mcp',
  email: null,
  tier_id: 'tier_basic',
  contract_id: CONTRACT_ID,
  inbound_token_id: TOKEN_ID,
  mcp_token_id: TOKEN_ID,
  external_subscription_id: null,
  source_status: 'active',
  current_period_end: NOW + 60_000,
  grace_until: NOW + 120_000,
  access_state: 'active',
  claim_email_sent_at: null,
  claim_email_marker: null,
  status_email_sent_at: null,
  status_email_marker: null,
  created_at: NOW,
  updated_at: NOW,
  ...overrides,
});

const createResolver = (input: {
  current?: McpInboundTokenRecord | null;
  contractOverlay?: ApprovalResumeAuthorityResolverDeps['contractOverlay'];
  sellerStore?: ApprovalResumeAuthorityResolverDeps['sellerStore'];
  opAdmissionGate?: ApprovalResumeAuthorityResolverDeps['opAdmissionGate'];
  routeReady?: () => boolean;
} = {}) => {
  const current = input.current === undefined ? token() : input.current;
  return createApprovalResumeAuthorityResolver({
    manifests,
    inboundTokenStore: {
      getTokenById: vi.fn((id: string) => id === TOKEN_ID ? current : null),
    },
    contractOverlay: input.contractOverlay ?? overlay(),
    ...(input.sellerStore ? { sellerStore: input.sellerStore } : {}),
    ...(input.opAdmissionGate ? { opAdmissionGate: input.opAdmissionGate } : {}),
    ...(input.routeReady ? { isLlmGatewayRouteReady: input.routeReady } : {}),
    now: () => NOW,
  });
};

describe('createApprovalResumeAuthorityResolver', () => {
  it('rebuilds allowed tools and the collection fence from live stores', () => {
    const liveOverlay = overlay({
      resolveContractScopeRestrictions: vi.fn(() => ['data.calendar.*']),
    });
    const resolver = createResolver({ contractOverlay: liveOverlay });

    const result = resolver.resolve({
      execution_source: mcpSource(),
      required_bearer_tool_names: [RECIPE_GRANT],
    });

    expect(result.admitted).toBe(true);
    if (!result.admitted) return;
    expect(result.contract_snapshot).toMatchObject({
      contract_id: CONTRACT_ID,
      contract_version: '1',
      allowed_tools: ['mail-send'],
      approval_required: [],
      scope_restrictions: ['data.calendar.*'],
      resolved_at: NOW,
    });
    expect(liveOverlay.resolveContractScopeRestrictions).toHaveBeenCalledWith(
      mcpSource(),
    );
  });

  it('denies a revoked bearer instead of replaying its snapshot', () => {
    const result = createResolver({
      current: token({ revoked_at: NOW - 1 }),
    }).resolve({
      execution_source: mcpSource(),
      required_bearer_tool_names: [RECIPE_GRANT],
    });

    expect(result).toMatchObject({ admitted: false, reason: 'bearer_inactive' });
  });

  it('denies token-to-contract rebinding while the approval is held', () => {
    const result = createResolver({
      current: token({ contract_id: 'ct_different' }),
    }).resolve({
      execution_source: mcpSource(),
      required_bearer_tool_names: [RECIPE_GRANT],
    });

    expect(result).toMatchObject({
      admitted: false,
      reason: 'bearer_binding_changed',
    });
  });

  it('rechecks a canonical CLI bearer instead of treating its old source as authority', () => {
    const resolver = createApprovalResumeAuthorityResolver({
      manifests,
      inboundTokenStore: { getTokenById: vi.fn(() => null) },
      clientTokens: {
        get: vi.fn(() => ({
          token_id: 'cli-token-1',
          client_kind: 'cli' as const,
          client_label: null,
          issued_at: NOW - 10_000,
          last_used_at: null,
          revoked_at: NOW - 1,
          revocation_reason: 'rotated',
          metadata: null,
        })),
      },
      now: () => NOW,
    });

    const result = resolver.resolve({
      execution_source: mcpSource({
        mcp_token_id: 'cli-token-1',
        contract_id: 'cli-token-1',
      }),
    });

    expect(result).toMatchObject({ admitted: false, reason: 'bearer_inactive' });
  });

  it('denies when the exact raw-op wire grant was revoked', () => {
    const rawWireName = 'recued_op_recued-core.hubspot-pack.deal.create';
    const result = createResolver({
      current: token({ grants: { [RECIPE_GRANT]: true, [rawWireName]: false } }),
    }).resolve({
      execution_source: mcpSource(),
      required_bearer_tool_names: [rawWireName],
    });

    expect(result).toMatchObject({
      admitted: false,
      reason: 'bearer_grant_revoked',
    });
  });

  it('fails closed when an inbound-bearer caller omits top-level grant identity', () => {
    const result = createResolver().resolve({
      execution_source: mcpSource(),
    });

    expect(result).toMatchObject({
      admitted: false,
      reason: 'bearer_grant_revoked',
    });
  });

  it('uses the live contract raw-op grant for a Seller customer instance', () => {
    const rawOpId = 'recued-core.hubspot-pack.deal.create';
    const rawWireName = `recued_op_${rawOpId}`;
    const sellerStore = {
      getSettings: vi.fn(settings),
      getTier: vi.fn(() => tier()),
      listCustomers: vi.fn(() => [customer()]),
    };
    const isOpGranted = vi.fn(() => true);
    const admitted = createResolver({
      current: token({ grants: {} }),
      contractOverlay: overlay({
        resolveBoundContractKind: vi.fn((): 'customer_instance' => 'customer_instance'),
      }),
      sellerStore,
      opAdmissionGate: { isOpGranted },
    }).resolve({
      execution_source: mcpSource(),
      required_bearer_tool_names: [rawWireName],
      required_raw_op_id: rawOpId,
    });

    expect(admitted).toMatchObject({ admitted: true });
    expect(isOpGranted).toHaveBeenCalledWith(mcpSource(), rawOpId);

    const denied = createResolver({
      current: token({ grants: { [rawWireName]: true } }),
      contractOverlay: overlay({
        resolveBoundContractKind: vi.fn((): 'customer_instance' => 'customer_instance'),
      }),
      sellerStore,
      opAdmissionGate: { isOpGranted: vi.fn(() => false) },
    }).resolve({
      execution_source: mcpSource(),
      required_bearer_tool_names: [rawWireName],
      required_raw_op_id: rawOpId,
    });

    expect(denied).toMatchObject({
      admitted: false,
      reason: 'contract_grant_revoked',
    });
  });

  it('re-reads the exact Seller pairing and active tier', () => {
    const sellerStore = {
      getSettings: vi.fn(settings),
      getTier: vi.fn(() => tier({ active: false })),
      listCustomers: vi.fn(() => [customer()]),
    };
    const result = createResolver({
      contractOverlay: overlay({
        resolveBoundContractKind: vi.fn((): 'customer_instance' => 'customer_instance'),
      }),
      sellerStore,
    }).resolve({
      execution_source: mcpSource(),
      required_bearer_tool_names: [RECIPE_GRANT],
    });

    expect(sellerStore.listCustomers).toHaveBeenCalledWith({
      contract_id: CONTRACT_ID,
    });
    expect(result).toMatchObject({
      admitted: false,
      reason: 'seller_access_denied',
    });
  });

  it('fails closed when the freshly resolved tool-call usage policy is invalid', () => {
    const sellerStore = {
      getSettings: vi.fn(settings),
      getTier: vi.fn(() => tier({ usage_policy_json: { tool_call: 'invalid' } })),
      listCustomers: vi.fn(() => [customer()]),
    };
    const result = createResolver({
      contractOverlay: overlay({
        resolveBoundContractKind: vi.fn((): 'customer_instance' => 'customer_instance'),
      }),
      sellerStore,
    }).resolve({
      execution_source: mcpSource(),
      required_bearer_tool_names: [RECIPE_GRANT],
    });

    expect(result).toMatchObject({
      admitted: false,
      reason: 'seller_usage_policy_invalid',
    });
  });

  it('rechecks the live LLM route before an llm_gateway approval can act', () => {
    const missingRoute = createResolver({ routeReady: () => false }).resolve({
      execution_source: llmSource(),
      required_bearer_tool_names: [RECIPE_GRANT],
    });
    expect(missingRoute).toMatchObject({
      admitted: false,
      reason: 'route_unavailable',
    });

    const liveRoute = createResolver({ routeReady: () => true }).resolve({
      execution_source: llmSource(),
      required_bearer_tool_names: [RECIPE_GRANT],
    });
    expect(liveRoute).toMatchObject({ admitted: true });
  });
});
