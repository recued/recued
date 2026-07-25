import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

import {
  receptionIntakeRecipePairClaimConfigurationReadiness,
  type ReceptionRpcDeps,
} from '../reception-rpc-handler.js';

const TEMPLATE_REF = `file:${'a'.repeat(32)}`;
const TEMPLATE_BYTES = Buffer.from('# Brief\n\n{{response.brief}}\n', 'utf8');
const TEMPLATE_HASH = createHash('sha256').update(TEMPLATE_BYTES).digest('hex');
const CONFIGURATION = {
  version: 1 as const,
  stripe_connection_name: 'stripe-primary',
  success_url: 'https://owner.example/checkout/success',
  cancel_url: 'https://owner.example/checkout/cancel',
  expiry_window_ms: 30 * 60 * 1_000,
  template_file_ref: TEMPLATE_REF,
};
const SELLER_OFFER_ID = 'research-brief.fulfilled';
const RECIPE_ID = 'research-brief-checkout';
const SELLER_CONFIGURATION = {
  ...CONFIGURATION,
  version: 2 as const,
  seller_offer_id: SELLER_OFFER_ID,
};

const configuredRecipe = () => ({
  metadata: {
    paid_document_direct_checkout: { ...CONFIGURATION },
  },
});

const sellerConfiguredRecipe = () => ({
  recipe_id: RECIPE_ID,
  metadata: {
    paid_document_direct_checkout: { ...SELLER_CONFIGURATION },
  },
});

const stripeConnection = (vendor = 'stripe') => ({
  pk: 'api:stripe-primary',
  kind: 'api',
  name: 'stripe-primary',
  display_name: 'Stripe primary',
  config_json: JSON.stringify({ vendor }),
  auth_ciphertext: 'enrolled-ciphertext',
  enrolled_at: 1,
  updated_at: 1,
});

const templateRecord = (overrides: Record<string, unknown> = {}) => ({
  record_id: TEMPLATE_REF,
  received_at: 1,
  modified_at: 1,
  source_id: 'owner-template',
  size_bytes: TEMPLATE_BYTES.length,
  blob_hash: TEMPLATE_HASH,
  hot_fields: {
    filename: 'brief.md',
    mime_type: 'text/markdown',
    size: TEMPLATE_BYTES.length,
    content_hash: TEMPLATE_HASH,
    origin: 'webclient_upload',
    scan_status: 'unscanned',
    media_class: 'document',
  },
  storage_ref: { kind: 'cas', blob_hash: TEMPLATE_HASH },
  ...overrides,
});

const sellerOffer = (overrides: Record<string, unknown> = {}) => ({
  offer_id: SELLER_OFFER_ID,
  kind: 'document' as const,
  display_name: 'One research brief',
  description: 'One reviewed PDF research brief',
  pricing_kind: 'fixed' as const,
  amount_minor: 12_500,
  currency: 'USD',
  fulfillment_recipe_id: RECIPE_ID,
  checkout_url: null,
  // D-196.1d-p1 (20cc8e936) — `SELLER_OFFER_SOURCE_KEYS` is an EXACT key-set
  // match (hasOnlyDataKeys), so a fixture missing this key fails the source
  // shape and surfaces as `seller_offer_source_mismatch`, masking the recipe
  // check behind it. Same one-line fix the sibling suite already took.
  fulfillment_config: null,
  state: 'active' as const,
  created_by_recipe_id: 'registration-recipe',
  created_at: 10,
  updated_at: 11,
  ...overrides,
});

const sourceDeps = (input: {
  connection?: ReturnType<typeof stripeConnection> | null;
  record?: ReturnType<typeof templateRecord> | null;
  bytes?: Buffer;
  readError?: Error;
  connectionGet?: ReturnType<typeof vi.fn>;
  recordGet?: ReturnType<typeof vi.fn>;
  readTemplateBytes?: ReturnType<typeof vi.fn>;
} = {}): Pick<
  ReceptionRpcDeps,
  'getConnectionStore' | 'getInboundFileCollection'
> => ({
  getConnectionStore: () => ({
    get: (input.connectionGet ?? vi.fn(() => input.connection === undefined
      ? stripeConnection()
      : input.connection)) as never,
  }),
  getInboundFileCollection: () => ({
    get: (input.recordGet ?? vi.fn(() => input.record === undefined
      ? templateRecord()
      : input.record)) as never,
    readBytes: (input.readTemplateBytes ?? vi.fn(async () => {
      if (input.readError) throw input.readError;
      return {
        bytes: input.bytes ?? TEMPLATE_BYTES,
        mime_type: 'text/markdown',
        filename: 'brief.md',
      };
    })) as never,
  }),
});

describe('D-200 Slice 6g.10 claim-configuration readiness', () => {
  it('source-proves the exact Stripe row and durable template bytes without authorizing provider work', async () => {
    const connectionGet = vi.fn(() => stripeConnection());
    const recordGet = vi.fn(() => templateRecord());
    const readTemplateBytes = vi.fn(async () => ({
      bytes: TEMPLATE_BYTES,
      mime_type: 'text/markdown',
      filename: 'brief.md',
    }));
    await expect(receptionIntakeRecipePairClaimConfigurationReadiness(
      sourceDeps({ connectionGet, recordGet, readTemplateBytes }),
      configuredRecipe(),
    )).resolves.toEqual({
      status: 'ready',
      configuration: CONFIGURATION,
      blockers: [],
    });
    expect(connectionGet).toHaveBeenCalledTimes(2);
    expect(connectionGet).toHaveBeenNthCalledWith(1, 'api', 'stripe-primary');
    expect(connectionGet).toHaveBeenNthCalledWith(2, 'api', 'stripe-primary');
    expect(recordGet).toHaveBeenCalledTimes(2);
    expect(recordGet).toHaveBeenNthCalledWith(1, TEMPLATE_REF);
    expect(recordGet).toHaveBeenNthCalledWith(2, TEMPLATE_REF);
    expect(readTemplateBytes).toHaveBeenCalledOnce();
    expect(readTemplateBytes).toHaveBeenCalledWith(TEMPLATE_REF);
  });

  it('adds the exact core Seller row and recipe route to v2 owner readiness', async () => {
    const getOffer = vi.fn(() => sellerOffer());
    await expect(receptionIntakeRecipePairClaimConfigurationReadiness({
      ...sourceDeps(),
      getSellerOfferStore: () => ({ getOffer: getOffer as never }),
    }, sellerConfiguredRecipe())).resolves.toEqual({
      status: 'ready',
      configuration: SELLER_CONFIGURATION,
      blockers: [],
    });
    expect(getOffer).toHaveBeenCalledOnce();
    expect(getOffer).toHaveBeenCalledWith(SELLER_OFFER_ID);
  });

  it('keeps v1 readiness independent from core Seller composition', async () => {
    const getSellerOfferStore = vi.fn(() => ({ getOffer: vi.fn() as never }));
    await expect(receptionIntakeRecipePairClaimConfigurationReadiness({
      ...sourceDeps(),
      getSellerOfferStore,
    }, configuredRecipe())).resolves.toMatchObject({ status: 'ready' });
    expect(getSellerOfferStore).not.toHaveBeenCalled();
  });

  it.each([
    ['seller_offer_missing', null],
    ['seller_offer_source_mismatch', sellerOffer({ offer_id: 'other-offer' })],
    ['seller_offer_recipe_mismatch', sellerOffer({
      created_by_recipe_id: 'other-creator',
      fulfillment_recipe_id: 'other-fulfillment',
    })],
  ] as const)('fails v2 readiness closed with %s', async (blocker, source) => {
    await expect(receptionIntakeRecipePairClaimConfigurationReadiness({
      ...sourceDeps(),
      getSellerOfferStore: () => ({ getOffer: vi.fn(() => source) as never }),
    }, sellerConfiguredRecipe())).resolves.toEqual({
      status: 'blocked',
      configuration: SELLER_CONFIGURATION,
      blockers: [blocker],
    });
  });

  it('reports unavailable core Seller composition only for a v2 association', async () => {
    await expect(receptionIntakeRecipePairClaimConfigurationReadiness(
      sourceDeps(),
      sellerConfiguredRecipe(),
    )).resolves.toEqual({
      status: 'blocked',
      configuration: SELLER_CONFIGURATION,
      blockers: ['seller_offer_lookup_unavailable'],
    });
  });

  it('keeps missing recipe configuration distinct and does not inspect unrelated inventories', async () => {
    const getConnectionStore = vi.fn();
    const getInboundFileCollection = vi.fn();
    const getSellerOfferStore = vi.fn();

    await expect(receptionIntakeRecipePairClaimConfigurationReadiness({
      getConnectionStore,
      getInboundFileCollection,
      getSellerOfferStore,
    }, { metadata: {} })).resolves.toEqual({
      status: 'blocked',
      configuration: null,
      blockers: ['claim_configuration_missing'],
    });
    expect(getConnectionStore).not.toHaveBeenCalled();
    expect(getInboundFileCollection).not.toHaveBeenCalled();
    expect(getSellerOfferStore).not.toHaveBeenCalled();
  });

  it('fails closed when production source lookups are not composed', async () => {
    await expect(receptionIntakeRecipePairClaimConfigurationReadiness(
      {},
      configuredRecipe(),
    )).resolves.toEqual({
      status: 'blocked',
      configuration: CONFIGURATION,
      blockers: [
        'stripe_connection_lookup_unavailable',
        'template_lookup_unavailable',
      ],
    });
  });

  it('distinguishes a missing exact connection and template from syntactic configuration validity', async () => {
    await expect(receptionIntakeRecipePairClaimConfigurationReadiness(
      sourceDeps({ connection: null, record: null }),
      configuredRecipe(),
    )).resolves.toEqual({
      status: 'blocked',
      configuration: CONFIGURATION,
      blockers: ['stripe_connection_missing', 'template_missing'],
    });
  });

  it('rejects a same-name non-Stripe connection and a remote-backed local record id', async () => {
    const remoteRecord = templateRecord({
      storage_ref: { kind: 'remote', provider: 'drive', remote_id: 'template-1' },
    });
    await expect(receptionIntakeRecipePairClaimConfigurationReadiness(
      sourceDeps({ connection: stripeConnection('github'), record: remoteRecord }),
      configuredRecipe(),
    )).resolves.toEqual({
      status: 'blocked',
      configuration: CONFIGURATION,
      blockers: ['stripe_connection_not_stripe', 'template_not_local'],
    });
  });

  it('rejects mismatched returned identities and malformed durable file metadata as closed blockers', async () => {
    const wrongConnection = {
      ...stripeConnection(),
      name: 'stripe-secondary',
    };
    await expect(receptionIntakeRecipePairClaimConfigurationReadiness(
      sourceDeps({ connection: wrongConnection }),
      configuredRecipe(),
    )).resolves.toMatchObject({
      status: 'blocked',
      blockers: ['stripe_connection_source_mismatch'],
    });

    const readTemplateBytes = vi.fn();
    const wrongRecord = templateRecord({ record_id: `file:${'b'.repeat(32)}` });
    await expect(receptionIntakeRecipePairClaimConfigurationReadiness(
      sourceDeps({ record: wrongRecord, readTemplateBytes }),
      configuredRecipe(),
    )).resolves.toMatchObject({
      status: 'blocked',
      blockers: ['template_source_mismatch'],
    });
    expect(readTemplateBytes).not.toHaveBeenCalled();

    const malformedRecord = templateRecord({ hot_fields: null });
    await expect(receptionIntakeRecipePairClaimConfigurationReadiness(
      sourceDeps({ record: malformedRecord, readTemplateBytes }),
      configuredRecipe(),
    )).resolves.toMatchObject({
      status: 'blocked',
      blockers: ['template_source_mismatch'],
    });
    expect(readTemplateBytes).not.toHaveBeenCalled();
  });

  it('rechecks connection and same-ref template authority after CAS I/O yields', async () => {
    const replacementBytes = Buffer.from('# Replacement template', 'utf8');
    const replacementHash = createHash('sha256').update(replacementBytes).digest('hex');
    const replacementRecord = templateRecord({
      size_bytes: replacementBytes.length,
      blob_hash: replacementHash,
      hot_fields: {
        filename: 'replacement.md',
        mime_type: 'text/markdown',
        size: replacementBytes.length,
        content_hash: replacementHash,
        origin: 'webclient_upload',
        scan_status: 'unscanned',
        media_class: 'document',
      },
      storage_ref: { kind: 'cas', blob_hash: replacementHash },
    });
    let connection: ReturnType<typeof stripeConnection> | null = stripeConnection();
    let record = templateRecord();
    const connectionGet = vi.fn(() => connection);
    const recordGet = vi.fn(() => record);
    const readTemplateBytes = vi.fn(async () => {
      connection = null;
      record = replacementRecord;
      return {
        bytes: TEMPLATE_BYTES,
        mime_type: 'text/markdown',
        filename: 'brief.md',
      };
    });

    await expect(receptionIntakeRecipePairClaimConfigurationReadiness(
      sourceDeps({ connectionGet, recordGet, readTemplateBytes }),
      configuredRecipe(),
    )).resolves.toEqual({
      status: 'blocked',
      configuration: CONFIGURATION,
      blockers: ['template_source_mismatch', 'stripe_connection_missing'],
    });
    expect(connectionGet).toHaveBeenCalledTimes(2);
    expect(recordGet).toHaveBeenCalledTimes(2);
  });

  it('reports the hard template MIME and byte ceilings before an oversized CAS read', async () => {
    const oversized = 1_024 * 1_024 + 1;
    const record = templateRecord({
      size_bytes: oversized,
      hot_fields: {
        filename: 'brief.pdf',
        mime_type: 'application/pdf',
        size: oversized,
        content_hash: TEMPLATE_HASH,
        origin: 'webclient_upload',
        scan_status: 'unscanned',
        media_class: 'document',
      },
    });
    await expect(receptionIntakeRecipePairClaimConfigurationReadiness(
      sourceDeps({ record }),
      configuredRecipe(),
    )).resolves.toEqual({
      status: 'blocked',
      configuration: CONFIGURATION,
      blockers: ['template_too_large', 'template_mime_unsupported'],
    });
  });

  it('detects unreadable and byte/hash-divergent template sources', async () => {
    const unreadable = await receptionIntakeRecipePairClaimConfigurationReadiness(
      sourceDeps({ readError: new Error('CAS missing') }),
      configuredRecipe(),
    );
    expect(unreadable).toMatchObject({
      status: 'blocked',
      blockers: ['template_unreadable'],
    });

    const divergent = await receptionIntakeRecipePairClaimConfigurationReadiness(
      sourceDeps({ bytes: Buffer.from('different bytes', 'utf8') }),
      configuredRecipe(),
    );
    expect(divergent).toMatchObject({
      status: 'blocked',
      blockers: ['template_source_mismatch'],
    });
  });
});
