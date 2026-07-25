/** D-196 S4 substrate — provider/kernel customer claim delivery. */

import Database from 'better-sqlite3';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  vi,
} from 'vitest';

import {
  CONTRACT_DEFINITION_SCOPE,
  type ContractDefinition,
} from '@recued/contracts';
import type { KernelDispatchers } from '@recued/ingredients';

import type { Collection } from '../collections/types.js';
import { createCollectionRegistry } from '../collections/registry.js';
import {
  composeExecutorConfig,
  type ComposeExecutorConfigDeps,
} from '../composition/bin/wire-executor-config.js';
import {
  createChatInboundTokenStore,
  ensureChatInboundTokenSchema,
  type ChatInboundTokenStore,
} from '../storage/chat-inbound-token-store.js';
import {
  createContractStore,
  type ContractStore,
} from '../storage/contract-store.js';
import {
  createSellerClaimStore,
  type SellerClaimStore,
} from '../storage/seller-claim-store.js';
import {
  createSellerStore,
  type SellerStore,
} from '../storage/seller-store.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const PUBLIC_BASE_URL = 'https://seller.example';

let db: Database.Database;
let now: number;
let contractStore: ContractStore;
let inboundTokenStore: ChatInboundTokenStore;
let sellerClaimStore: SellerClaimStore;
let sellerStore: SellerStore;

const putTemplate = (): void => {
  const template: ContractDefinition = {
    contract_id: 'ct_template_basic',
    minted_at: now - 1_000,
    minted_by: 'owner:test',
    display_name: 'Basic customer template',
    scope: { operation_ids: ['core.customer.status'] },
    door_types: ['mcp'],
    grant_kind: 'customer_template',
  };
  contractStore.put(
    CONTRACT_DEFINITION_SCOPE,
    [template.contract_id],
    template,
  );
};

const putTier = (lifecycle_source: 'manual' | 'stripe'): void => {
  sellerStore.upsertTier({
    tier_id: `tier_${lifecycle_source}_basic`,
    door_id: 'door_mcp',
    lifecycle_source,
    entitlement_key: 'basic',
    display_name: 'Basic',
    template_contract_id: 'ct_template_basic',
    usage_policy_json: {},
    now,
  });
};

interface TestMailSendInput {
  readonly to: readonly string[];
  readonly subject: string;
  readonly body_text: string;
}

interface TestMailSendOutput {
  readonly source_id: string;
  readonly message_id: string;
  readonly sent_at: number;
  readonly _id: null;
  readonly _collection: 'data.mail';
}

type SendClaimMail = Mock<
  (input: TestMailSendInput) => Promise<TestMailSendOutput>
>;
type KernelCustomerAccessIssueInput = Parameters<
  NonNullable<KernelDispatchers['customerAccessIssue']>
>[0];

const createMailRegistry = (
  send: SendClaimMail,
): ReturnType<typeof createCollectionRegistry> => {
  const registry = createCollectionRegistry();
  registry.register({
    platform: 'mail',
    slug: 'mail_primary',
    sendCapable: true,
    send,
  } as unknown as Collection);
  return registry;
};

const buildExecutor = async (input?: {
  readonly send?: SendClaimMail;
  readonly withPublicBaseUrl?: boolean;
}) => {
  const send = input?.send ?? vi.fn(async (
    _input: TestMailSendInput,
  ): Promise<TestMailSendOutput> => ({
    source_id: 'mail-source-1',
    message_id: 'message-1',
    sent_at: now + 10,
    _id: null,
    _collection: 'data.mail' as const,
  }));
  const registry = createMailRegistry(send);
  const deps = {
    manifests: {
      get: () => null,
      size: () => 0,
      slugs: () => [],
      register: () => undefined,
      unregister: () => false,
    },
    baseVault: {},
    llmQuota: {},
    cacheStore: undefined,
    cacheBlobs: undefined,
    serverInstanceId: 'server-test',
    watcherDispatcher: vi.fn(async () => ({ status: 'ok' })),
    collectionRegistry: registry,
    recipeStore: { get: () => null },
    getScheduleDeps: undefined,
    sellerStore,
    contractStore,
    inboundTokenStore,
    sellerClaimStore,
    ...(input?.withPublicBaseUrl === false
      ? {}
      : { getSellerPublicBaseUrl: () => PUBLIC_BASE_URL }),
    llmConfig: undefined,
    resolveLlmConfig: undefined,
    llmManager: undefined,
  } as unknown as ComposeExecutorConfigDeps;
  const config = await composeExecutorConfig(deps);
  const issue = config.kernelDispatchers?.customerAccessIssue;
  if (!issue) throw new Error('customer-access issue dispatcher was not composed');
  return { issue, registry, send };
};

const providerIssue = (
  overrides: Partial<KernelCustomerAccessIssueInput> = {},
): KernelCustomerAccessIssueInput => ({
  lifecycle_source: 'stripe',
  door_id: 'door_mcp',
  source_customer_id: 'cus_1',
  entitlement_key: 'basic',
  email: 'buyer@example.com',
  current_period_end: now + DAY_MS,
  source_status: 'active',
  ...overrides,
});

beforeEach(() => {
  db = new Database(':memory:');
  now = Date.now();
  contractStore = createContractStore(db, { now: () => now });
  ensureChatInboundTokenSchema(db);
  inboundTokenStore = createChatInboundTokenStore(db);
  sellerStore = createSellerStore(db);
  sellerClaimStore = createSellerClaimStore(db);
  sellerStore.upsertSettings({
    sender_mail_instance_id: 'mail_primary',
    now,
  });
  putTemplate();
});

afterEach(() => {
  db.close();
});

describe('provider customer claim delivery', () => {
  it('returns only a one-time claim, sends it after commit, and never resends on issue replay', async () => {
    putTier('stripe');
    const transactionStates: boolean[] = [];
    const send = vi.fn(async (
      _input: TestMailSendInput,
    ): Promise<TestMailSendOutput> => {
      transactionStates.push(db.inTransaction);
      return {
        source_id: 'mail-source-1',
        message_id: 'message-1',
        sent_at: now + 10,
        _id: null,
        _collection: 'data.mail' as const,
      };
    });
    const { issue } = await buildExecutor({ send });

    const created = await issue(providerIssue());
    expect(created).toMatchObject({
      result: 'created',
      claim: {
        claim_url: expect.stringMatching(
          /^https:\/\/seller\.example\/reception\/claim\?t=recued_claim_/u,
        ),
        expires_at: expect.any(Number),
      },
      claim_email_delivery: {
        status: 'sent',
        message_id: 'message-1',
        sent_at: now + 10,
      },
      customer: {
        lifecycle_source: 'stripe',
        email: 'buyer@example.com',
        claim_email_sent_at: now + 10,
        claim_email_marker: expect.stringMatching(/^claim:seller_claim_/u),
      },
    });
    expect(created).not.toHaveProperty('issued_token');
    expect(send).toHaveBeenCalledTimes(1);
    expect(transactionStates).toEqual([false]);

    const claimUrl = new URL(created.claim!.claim_url);
    const claimSecret = claimUrl.searchParams.get('t');
    expect(claimSecret).not.toBeNull();
    const consumed = sellerClaimStore.consume(claimSecret!, now);
    expect(consumed.status).toBe('claimed');
    if (consumed.status !== 'claimed') throw new Error('claim was not consumable');
    expect(JSON.stringify(created)).not.toContain(consumed.payload.bearer_plaintext);
    expect(send.mock.calls[0]![0].body_text).not.toContain(
      consumed.payload.bearer_plaintext,
    );
    expect(send.mock.calls[0]![0]).toMatchObject({
      to: ['buyer@example.com'],
      subject: 'Your Recued access is ready',
    });

    const replay = await issue(providerIssue({
      current_period_end: now + 2 * DAY_MS,
      source_status: 'renewed',
    }));
    expect(replay).toMatchObject({
      result: 'extended',
      claim: null,
      claim_email_delivery: null,
    });
    expect(replay).not.toHaveProperty('issued_token');
    expect(send).toHaveBeenCalledTimes(1);
    expect(inboundTokenStore.listTokens()).toHaveLength(1);
  });

  it('commits provider access but durably reserves the claim when mail transport fails', async () => {
    putTier('stripe');
    const send = vi.fn(async (
      _input: TestMailSendInput,
    ): Promise<TestMailSendOutput> => {
      throw Object.assign(new Error('temporary SMTP failure'), {
        code: 'SMTP_TEMPORARY',
      });
    });
    const { issue } = await buildExecutor({ send });

    const created = await issue(providerIssue());
    expect(created).toMatchObject({
      result: 'created',
      claim: expect.objectContaining({ claim_url: expect.any(String) }),
      claim_email_delivery: {
        status: 'failed',
        error_code: 'SMTP_TEMPORARY',
      },
      customer: {
        claim_email_marker: expect.stringMatching(/^claim:seller_claim_/u),
        claim_email_sent_at: null,
      },
    });
    expect(sellerStore.listCustomers()).toHaveLength(1);
    expect(inboundTokenStore.listTokens()).toHaveLength(1);

    const replay = await issue(providerIssue({
      current_period_end: now + 2 * DAY_MS,
    }));
    expect(replay.claim_email_delivery).toBeNull();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('does not report rollback when the post-delivery customer refresh fails', async () => {
    putTier('stripe');
    const persistedSellerStore = sellerStore;
    let customerReads = 0;
    sellerStore = new Proxy(persistedSellerStore, {
      get(target, property, receiver) {
        if (property === 'getCustomer') {
          return (customerId: string) => {
            customerReads += 1;
            if (customerReads === 2) {
              throw new Error('transient post-commit customer read failed');
            }
            return target.getCustomer(customerId);
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const { issue, send } = await buildExecutor();

    const created = await issue(providerIssue());

    expect(created).toMatchObject({
      result: 'created',
      claim_email_delivery: {
        status: 'sent',
        message_id: 'message-1',
      },
    });
    expect(created.customer.claim_email_marker).toBeNull();
    expect(send).toHaveBeenCalledTimes(1);
    expect(customerReads).toBe(2);
    expect(persistedSellerStore.getCustomer(created.customer.customer_id))
      .toEqual(expect.objectContaining({
        claim_email_marker: expect.stringMatching(/^claim:seller_claim_/u),
        claim_email_sent_at: now + 10,
      }));
  });

  it('contains a hostile transport error object after commit', async () => {
    putTier('stripe');
    const hostileError = new Error('mail transport failed');
    Object.defineProperty(hostileError, 'code', {
      get() {
        throw new Error('hostile code getter');
      },
    });
    const send = vi.fn(async (
      _input: TestMailSendInput,
    ): Promise<TestMailSendOutput> => {
      throw hostileError;
    });
    const { issue } = await buildExecutor({ send });

    const created = await issue(providerIssue());

    expect(created).toMatchObject({
      result: 'created',
      claim_email_delivery: {
        status: 'failed',
        error_code: 'CLAIM_EMAIL_SEND_FAILED',
      },
      customer: {
        claim_email_marker: expect.stringMatching(/^claim:seller_claim_/u),
        claim_email_sent_at: null,
      },
    });
    expect(sellerStore.listCustomers()).toHaveLength(1);
    expect(inboundTokenStore.listTokens()).toHaveLength(1);
  });

  it('keeps manual-source kernel issue explicit while still hiding the bearer', async () => {
    putTier('manual');
    const { issue, send } = await buildExecutor();

    const created = await issue(providerIssue({
      lifecycle_source: 'manual',
      source_customer_id: 'manual_1',
      current_period_end: null,
    }));
    expect(created).toMatchObject({
      result: 'created',
      claim: expect.objectContaining({ claim_url: expect.any(String) }),
      claim_email_delivery: null,
    });
    expect(created).not.toHaveProperty('issued_token');
    expect(send).not.toHaveBeenCalled();
  });

  it('rolls back first issue when no public HTTPS claim origin is configured', async () => {
    putTier('stripe');
    const { issue, send } = await buildExecutor({
      withPublicBaseUrl: false,
    });

    await expect(issue(providerIssue())).rejects.toThrow(
      /one-time customer claims require/u,
    );
    expect(sellerStore.listCustomers()).toHaveLength(0);
    expect(inboundTokenStore.listTokens()).toHaveLength(0);
    expect(send).not.toHaveBeenCalled();
  });
});
