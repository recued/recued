/**
 * Unit coverage for composeUpstreamMergeRpcDeps.
 *
 * Mock shapes are based on:
 * - backend/server/src/composition/bin/wire-upstream-merge-rpc-deps.ts
 * - backend/server/src/upstream-merge-handler.ts
 */

import { describe, expect, it, vi } from 'vitest';
import type {
  ApprovalRequest,
  ConnectionRecord,
  ConnectionRow,
  RiskTier,
  UpstreamMergeObjectType,
} from '@recued/contracts';
import type { ApprovalStore } from '../approval-handler.js';
import type {
  ComposeUpstreamMergeRpcDepsInput,
  UpstreamMergeRegistry,
} from '../composition/bin/wire-upstream-merge-rpc-deps.js';
import { composeUpstreamMergeRpcDeps } from '../composition/bin/wire-upstream-merge-rpc-deps.js';
import type { EventBus } from '../events/bus.js';
import type { ContactStore } from '../storage/contact-store.js';
import type { ConnectionStoreSqlite } from '../storage/connection-store.js';
import type { UpstreamMergeStore } from '../storage/upstream-merge-store.js';
import type {
  UpstreamMergeAuditEntry,
  UpstreamMergeRpcDeps,
} from '../upstream-merge-handler.js';

type ConnectionStoreMock = ConnectionStoreSqlite & {
  get: ReturnType<typeof vi.fn>;
};
type ApprovalStoreMock = ApprovalStore & {
  add: ReturnType<typeof vi.fn>;
  resolve: ReturnType<typeof vi.fn>;
};
type EventBusMock = EventBus & {
  emit: ReturnType<typeof vi.fn>;
};

const makeUpstreamMergeStore = (): UpstreamMergeStore =>
  ({ kind: 'upstream-merge-store' }) as unknown as UpstreamMergeStore;

const makeContactStore = (): ContactStore =>
  ({ kind: 'contact-store' }) as unknown as ContactStore;

const makeConnectionStore = (
  row: ConnectionRow | null = null,
): ConnectionStoreMock =>
  ({
    get: vi.fn(() => row),
  }) as unknown as ConnectionStoreMock;

const makeApprovalStore = (): ApprovalStoreMock =>
  ({
    add: vi.fn(),
    resolve: vi.fn(),
  }) as unknown as ApprovalStoreMock;

const makeEventBus = (): EventBusMock =>
  ({
    emit: vi.fn((event) => ({ ...event, cursor: 1 })),
  }) as unknown as EventBusMock;

const makeConnectionRow = (
  overrides: Partial<ConnectionRow> = {},
): ConnectionRow => ({
  pk: 'api:hubspot-main',
  kind: 'api',
  subtype: 'hubspot',
  name: 'hubspot-main',
  display_name: 'HubSpot Main',
  publisher_id: 'publisher-hubspot',
  config_json: JSON.stringify({
    base_url: 'https://api.hubapi.com',
    portal_id: 'portal-1',
  }),
  auth_ciphertext: JSON.stringify({
    type: 'oauth2_refresh',
    refresh_token: 'refresh-token',
    client_id: 'client-id',
    token_endpoint: 'https://auth.example/token',
    current_access_token: 'access-token',
    expires_at: 1_700_000_300_000,
  }),
  enrolled_at: 1_700_000_000_000,
  updated_at: 1_700_000_000_500,
  last_used_at: 1_700_000_001_000,
  health_json: JSON.stringify({
    status: 'ok',
    last_probed_at: 1_700_000_000_750,
    last_error: 'previous failure',
  }),
  ...overrides,
});

const makeApprovalRequest = (
  overrides: Partial<ApprovalRequest> = {},
): ApprovalRequest => ({
  request_id: 'approval-1',
  recipe_id: 'recipe-1',
  step_id: 'step-1',
  ingredient_slug: 'contact.merge',
  risk_tier: 'write',
  description: 'Merge duplicate contacts',
  resolved_input: { survivor_email: 'survivor@example.com' },
  timestamp: '2026-05-24T00:00:00.000Z',
  ...overrides,
});

const makeAuditEntry = (
  overrides: Partial<UpstreamMergeAuditEntry> = {},
): UpstreamMergeAuditEntry => ({
  outbox_id: 'outbox-1',
  approval_id: 'approval-1',
  transition: 'pending -> in_flight',
  state: 'in_flight',
  attempt: 1,
  vendor: 'hubspot',
  object_type: 'hubspot:contact',
  candidate_ids: ['vendor-contact-1', 'vendor-contact-2'],
  survivor_email: 'survivor@example.com',
  loser_emails: ['loser@example.com'],
  at: 1_700_000_002_000,
  ...overrides,
});

const makeInput = (
  overrides: Partial<ComposeUpstreamMergeRpcDepsInput> = {},
): ComposeUpstreamMergeRpcDepsInput => ({
  upstreamMergeStore: makeUpstreamMergeStore(),
  contactStore: makeContactStore(),
  connectionStore: makeConnectionStore(),
  existingRegistry: undefined,
  approvalStore: makeApprovalStore(),
  eventBus: makeEventBus(),
  serverInstanceId: 'server-a',
  ...overrides,
});

const composeHarness = (
  overrides: Partial<ComposeUpstreamMergeRpcDepsInput> = {},
): {
  input: ComposeUpstreamMergeRpcDepsInput;
  deps: UpstreamMergeRpcDeps;
  vendorMergers: UpstreamMergeRegistry;
} => {
  const input = makeInput(overrides);
  const bundle = composeUpstreamMergeRpcDeps(input);
  if (!bundle.upstreamMergeDeps || !bundle.vendorMergers) {
    throw new Error('expected configured upstream merge deps');
  }
  return {
    input,
    deps: bundle.upstreamMergeDeps,
    vendorMergers: bundle.vendorMergers,
  };
};

const getApprovalSink = (
  deps: UpstreamMergeRpcDeps,
): NonNullable<UpstreamMergeRpcDeps['approvalSink']> => {
  if (!deps.approvalSink) throw new Error('approvalSink missing');
  return deps.approvalSink;
};

const getAudit = (
  deps: UpstreamMergeRpcDeps,
): NonNullable<UpstreamMergeRpcDeps['audit']> => {
  if (!deps.audit) throw new Error('audit missing');
  return deps.audit;
};

const lastAddedApproval = (
  approvalStore: ApprovalStoreMock,
): Parameters<ApprovalStore['add']>[0] => {
  const call = approvalStore.add.mock.calls.at(-1);
  if (!call) throw new Error('approvalStore.add was not called');
  return call[0] as Parameters<ApprovalStore['add']>[0];
};

describe('composeUpstreamMergeRpcDeps', () => {
  it('returns undefined deps and registry when upstreamMergeStore is missing', () => {
    const bundle = composeUpstreamMergeRpcDeps(makeInput({
      upstreamMergeStore: undefined,
    }));

    expect(bundle).toEqual({
      upstreamMergeDeps: undefined,
      vendorMergers: undefined,
    });
  });

  it('returns undefined deps and registry when contactStore is missing', () => {
    const bundle = composeUpstreamMergeRpcDeps(makeInput({
      contactStore: undefined,
    }));

    expect(bundle).toEqual({
      upstreamMergeDeps: undefined,
      vendorMergers: undefined,
    });
  });

  it('returns undefined deps and registry when connectionStore is missing', () => {
    const bundle = composeUpstreamMergeRpcDeps(makeInput({
      connectionStore: undefined,
    }));

    expect(bundle).toEqual({
      upstreamMergeDeps: undefined,
      vendorMergers: undefined,
    });
  });

  it('mints a fresh empty registry when no existing registry is supplied', () => {
    const { deps, vendorMergers } = composeHarness();

    expect(vendorMergers).toBeInstanceOf(Map);
    expect(vendorMergers.size).toBe(0);
    expect(deps.vendorMergers).toBe(vendorMergers);
  });

  it('reuses the existing registry instance when supplied', () => {
    const existingRegistry = new Map<UpstreamMergeObjectType, never>() as UpstreamMergeRegistry;
    const { deps, vendorMergers } = composeHarness({
      existingRegistry,
    });

    expect(vendorMergers).toBe(existingRegistry);
    expect(deps.vendorMergers).toBe(existingRegistry);
  });

  it('vendorConnectionLookup returns null when the row is missing', () => {
    const connectionStore = makeConnectionStore(null);
    const { deps } = composeHarness({ connectionStore });

    expect(deps.vendorConnectionLookup('hubspot', 'hubspot-main')).toBeNull();
    expect(connectionStore.get).toHaveBeenCalledWith('api', 'hubspot-main');
  });

  it('vendorConnectionLookup returns null when the row subtype does not match the vendor', () => {
    const connectionStore = makeConnectionStore(makeConnectionRow({
      subtype: 'salesforce',
    }));
    const { deps } = composeHarness({ connectionStore });

    expect(deps.vendorConnectionLookup('hubspot', 'hubspot-main')).toBeNull();
  });

  it('vendorConnectionLookup returns the full connection record with parsed config, auth, and health', () => {
    const row = makeConnectionRow();
    const connectionStore = makeConnectionStore(row);
    const { deps } = composeHarness({ connectionStore });

    const record = deps.vendorConnectionLookup('hubspot', 'hubspot-main');

    expect(record).toEqual({
      kind: 'api',
      subtype: 'hubspot',
      name: 'hubspot-main',
      display_name: 'HubSpot Main',
      publisher_id: 'publisher-hubspot',
      config: {
        base_url: 'https://api.hubapi.com',
        portal_id: 'portal-1',
      },
      auth: {
        type: 'oauth2_refresh',
        refresh_token: 'refresh-token',
        client_id: 'client-id',
        token_endpoint: 'https://auth.example/token',
        current_access_token: 'access-token',
        expires_at: 1_700_000_300_000,
      },
      enrolled_at: 1_700_000_000_000,
      updated_at: 1_700_000_000_500,
      last_used_at: 1_700_000_001_000,
      health: {
        status: 'ok',
        last_probed_at: 1_700_000_000_750,
        last_error: 'previous failure',
      },
    } satisfies ConnectionRecord);
  });

  it('vendorConnectionLookup falls back to none auth for opaque auth ciphertext and still returns the record', () => {
    const connectionStore = makeConnectionStore(makeConnectionRow({
      auth_ciphertext: 'vault:v1:opaque-ciphertext',
    }));
    const { deps } = composeHarness({ connectionStore });

    const record = deps.vendorConnectionLookup('hubspot', 'hubspot-main');

    expect(record).toMatchObject({
      name: 'hubspot-main',
      auth: { type: 'none' },
    });
  });

  it('vendorConnectionLookup returns null when config_json is malformed', () => {
    const connectionStore = makeConnectionStore(makeConnectionRow({
      config_json: '{not-json',
    }));
    const { deps } = composeHarness({ connectionStore });

    expect(deps.vendorConnectionLookup('hubspot', 'hubspot-main')).toBeNull();
  });

  it('vendorConnectionLookup derives unknown health from updated_at when health_json is absent', () => {
    const connectionStore = makeConnectionStore(makeConnectionRow({
      health_json: undefined,
      updated_at: 1_700_000_123_456,
    }));
    const { deps } = composeHarness({ connectionStore });

    const record = deps.vendorConnectionLookup('hubspot', 'hubspot-main');

    expect(record?.health).toEqual({
      status: 'unknown',
      last_probed_at: 1_700_000_123_456,
    });
  });

  it('vendorConnectionLookup includes last_used_at when it is numeric', () => {
    const connectionStore = makeConnectionStore(makeConnectionRow({
      last_used_at: 1_700_000_111_222,
    }));
    const { deps } = composeHarness({ connectionStore });

    const record = deps.vendorConnectionLookup('hubspot', 'hubspot-main');

    expect(record).toMatchObject({
      last_used_at: 1_700_000_111_222,
    });
  });

  it('vendorConnectionLookup omits last_used_at when it is null', () => {
    const connectionStore = makeConnectionStore(makeConnectionRow({
      last_used_at: null as unknown as number,
    }));
    const { deps } = composeHarness({ connectionStore });

    const record = deps.vendorConnectionLookup('hubspot', 'hubspot-main');

    expect(record).not.toHaveProperty('last_used_at');
  });

  it('vendorConnectionLookup omits last_used_at when it is undefined', () => {
    const connectionStore = makeConnectionStore(makeConnectionRow({
      last_used_at: undefined,
    }));
    const { deps } = composeHarness({ connectionStore });

    const record = deps.vendorConnectionLookup('hubspot', 'hubspot-main');

    expect(record).not.toHaveProperty('last_used_at');
  });

  it.each([
    { inputTier: 'destructive' as RiskTier, expectedTier: 'destructive' },
    { inputTier: 'admin' as RiskTier, expectedTier: 'admin' },
    { inputTier: 'write' as RiskTier, expectedTier: 'write' },
    {
      inputTier: undefined as unknown as RiskTier,
      expectedTier: 'write',
    },
  ])(
    'approvalSink.addPending maps $inputTier risk to $expectedTier',
    ({ inputTier, expectedTier }) => {
      const approvalStore = makeApprovalStore();
      const { deps } = composeHarness({ approvalStore });
      const sink = getApprovalSink(deps);
      const request = makeApprovalRequest({
        request_id: `approval-${expectedTier}`,
        risk_tier: inputTier,
      });

      const approvalId = sink.addPending({
        request,
        outbox_id: 'outbox-1',
      });

      expect(approvalId).toBe(request.request_id);
      expect(lastAddedApproval(approvalStore)).toMatchObject({
        approval_id: request.request_id,
        risk_tier: expectedTier,
      });
    },
  );

  it('approvalSink.addPending falls back to recued-server when serverInstanceId is undefined', () => {
    const approvalStore = makeApprovalStore();
    const { deps } = composeHarness({
      approvalStore,
      serverInstanceId: undefined,
    });
    const sink = getApprovalSink(deps);

    sink.addPending({
      request: makeApprovalRequest(),
      outbox_id: 'outbox-1',
    });

    expect(lastAddedApproval(approvalStore)).toMatchObject({
      initiator_instance: 'recued-server',
    });
  });

  it('approvalSink.addPending passes the approval request fields through to approvalStore.add', () => {
    const approvalStore = makeApprovalStore();
    const { deps } = composeHarness({
      approvalStore,
      serverInstanceId: 'server-b',
    });
    const sink = getApprovalSink(deps);

    sink.addPending({
      request: makeApprovalRequest({
        request_id: 'approval-fields',
        recipe_id: 'recipe-fields',
        step_id: 'step-fields',
        ingredient_slug: 'hubspot.merge',
        description: 'Merge HubSpot contacts',
        resolved_input: { candidate_ids: ['a', 'b'] },
      }),
      outbox_id: 'outbox-1',
    });

    expect(lastAddedApproval(approvalStore)).toMatchObject({
      approval_id: 'approval-fields',
      initiator_instance: 'server-b',
      recipe_id: 'recipe-fields',
      step_id: 'step-fields',
      ingredient_slug: 'hubspot.merge',
      risk_tier: 'write',
      description: 'Merge HubSpot contacts',
      resolved_input: { candidate_ids: ['a', 'b'] },
      timeout_at: 0,
      created_at: expect.any(Number),
    });
  });

  it('approvalSink.addPending swallows approvalStore.add throws and still returns request_id', () => {
    const approvalStore = makeApprovalStore();
    approvalStore.add.mockImplementation(() => {
      throw new Error('add failed');
    });
    const { deps } = composeHarness({ approvalStore });
    const sink = getApprovalSink(deps);
    const request = makeApprovalRequest({ request_id: 'approval-throw' });

    expect(() => sink.addPending({
      request,
      outbox_id: 'outbox-1',
    })).not.toThrow();
    expect(sink.addPending({
      request,
      outbox_id: 'outbox-1',
    })).toBe('approval-throw');
  });

  it('approvalSink.markResolved passes approval id, decision, and server instance to approvalStore.resolve', () => {
    const approvalStore = makeApprovalStore();
    const { deps } = composeHarness({
      approvalStore,
      serverInstanceId: 'server-c',
    });
    const sink = getApprovalSink(deps);

    sink.markResolved('approval-1', 'approve');

    expect(approvalStore.resolve).toHaveBeenCalledWith(
      'approval-1',
      'approve',
      'server-c',
    );
  });

  it('approvalSink.markResolved falls back to recued-server when serverInstanceId is undefined', () => {
    const approvalStore = makeApprovalStore();
    const { deps } = composeHarness({
      approvalStore,
      serverInstanceId: undefined,
    });
    const sink = getApprovalSink(deps);

    sink.markResolved('approval-1', 'reject');

    expect(approvalStore.resolve).toHaveBeenCalledWith(
      'approval-1',
      'reject',
      'recued-server',
    );
  });

  it('approvalSink.markResolved swallows approvalStore.resolve throws', () => {
    const approvalStore = makeApprovalStore();
    approvalStore.resolve.mockImplementation(() => {
      throw new Error('resolve failed');
    });
    const { deps } = composeHarness({ approvalStore });
    const sink = getApprovalSink(deps);

    expect(() => sink.markResolved('approval-1', 'approve')).not.toThrow();
  });

  it('audit emits the expected memory audit server event', () => {
    const eventBus = makeEventBus();
    const { deps } = composeHarness({ eventBus });
    const audit = getAudit(deps);

    audit(makeAuditEntry({
      outbox_id: 'outbox-99',
      transition: 'committed',
      at: 1_700_000_333_444,
    }));

    expect(eventBus.emit).toHaveBeenCalledWith({
      kind: 'memory',
      subkind: 'audit',
      id: 'upstream_merge:outbox-99:committed:1700000333444',
    });
  });

  it('audit swallows eventBus.emit throws', () => {
    const eventBus = makeEventBus();
    eventBus.emit.mockImplementation(() => {
      throw new Error('emit failed');
    });
    const { deps } = composeHarness({ eventBus });
    const audit = getAudit(deps);

    expect(() => audit(makeAuditEntry())).not.toThrow();
  });

  it('passes store, contactStore, and eventBus references through directly', () => {
    const upstreamMergeStore = makeUpstreamMergeStore();
    const contactStore = makeContactStore();
    const eventBus = makeEventBus();
    const { deps } = composeHarness({
      upstreamMergeStore,
      contactStore,
      eventBus,
    });

    expect(deps.store).toBe(upstreamMergeStore);
    expect(deps.contactStore).toBe(contactStore);
    expect(deps.eventBus).toBe(eventBus);
  });
});
