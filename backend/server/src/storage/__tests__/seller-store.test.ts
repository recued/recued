/** D-196 Seller Economy — local seller table store tests. */

import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { LLM_GATEWAY_PAID_ACK_VERSION } from '@recued/contracts';

import {
  SELLER_CUSTOMERS_TABLE,
  SELLER_CUSTOMER_USAGE_ROLLUPS_TABLE,
  SELLER_OFFERS_TABLE,
  SELLER_SETTINGS_TABLE,
  SELLER_TIERS_TABLE,
  SellerStoreConflictError,
  SellerStoreValidationError,
  createSellerStore,
  ensureSellerSchema,
  type SellerStore,
} from '../seller-store.js';

const NOW = 1_900_000_000_000;

let db: Database.Database;
let store: SellerStore;

const columns = (table: string): string[] =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[])
    .map((row) => row.name);

const indexes = (table: string): string[] =>
  (db.prepare(`PRAGMA index_list(${table})`).all() as { name: string }[])
    .map((row) => row.name);

const tierInput = (overrides: Partial<Parameters<SellerStore['upsertTier']>[0]> = {}) => ({
  tier_id: 'tier_basic',
  door_id: 'door_mcp',
  lifecycle_source: 'stripe' as const,
  entitlement_key: 'basic',
  display_name: 'Basic',
  template_contract_id: 'ct_template_basic',
  usage_policy_json: { tool_call: { period_limit: 1000 } },
  now: NOW,
  ...overrides,
});

const customerInput = (
  overrides: Partial<Parameters<SellerStore['upsertCustomer']>[0]> = {},
) => ({
  customer_id: 'cust_1',
  lifecycle_source: 'stripe' as const,
  source_customer_id: 'cus_1',
  door_id: 'door_mcp',
  tier_id: 'tier_basic',
  contract_id: 'ct_customer_1',
  access_state: 'active' as const,
  now: NOW,
  ...overrides,
});

beforeEach(() => {
  db = new Database(':memory:');
  store = createSellerStore(db);
});

describe('ensureSellerSchema', () => {
  it('creates the seller tables idempotently, including optional customer email', () => {
    ensureSellerSchema(db);

    expect(columns(SELLER_SETTINGS_TABLE)).toContain('default_grace_hours');
    expect(columns(SELLER_OFFERS_TABLE)).toEqual([
      'offer_id',
      'kind',
      'display_name',
      'description',
      'pricing_kind',
      'amount_minor',
      'currency',
      'fulfillment_recipe_id',
      'checkout_url',
      'fulfillment_config',
      'state',
      'created_by_recipe_id',
      'created_at',
      'updated_at',
    ]);
    expect(columns(SELLER_OFFERS_TABLE)).not.toEqual(
      expect.arrayContaining(['pack_slug', 'publisher', 'version']),
    );
    expect(columns(SELLER_TIERS_TABLE)).toContain('template_contract_id');
    expect(columns(SELLER_CUSTOMERS_TABLE)).toContain('email');
    expect(columns(SELLER_CUSTOMER_USAGE_ROLLUPS_TABLE)).toContain('usage_kind');
    expect(indexes(SELLER_CUSTOMERS_TABLE)).toContain('idx_seller_customers_email');
  });
});

describe('seller settings', () => {
  it('returns dormant defaults before a row exists, then persists explicit settings', () => {
    expect(store.getSettings()).toEqual({
      default_grace_hours: 72,
      sender_mail_instance_id: null,
      status_policy_json: {},
      email_policy_json: {},
      llm_gateway_paid_ack_at: null,
      llm_gateway_paid_ack_version: null,
      created_at: null,
      updated_at: null,
    });

    const settings = store.upsertSettings({
      default_grace_hours: 48,
      sender_mail_instance_id: 'mail_primary',
      status_policy_json: { past_due: 'grace' },
      email_policy_json: { payment_failed: { enabled: true } },
      now: NOW,
    });

    expect(settings).toEqual({
      default_grace_hours: 48,
      sender_mail_instance_id: 'mail_primary',
      status_policy_json: { past_due: 'grace' },
      email_policy_json: { payment_failed: { enabled: true } },
      // upsertSettings NEVER touches the acknowledgment — a routine settings edit
      // must not toggle it (D-196 §4.9 / I-7).
      llm_gateway_paid_ack_at: null,
      llm_gateway_paid_ack_version: null,
      created_at: NOW,
      updated_at: NOW,
    });
  });
});

describe('seller llm_gateway paid acknowledgment (D-196 §4.9 / I-7)', () => {
  it('materializes the ack columns', () => {
    expect(columns(SELLER_SETTINGS_TABLE)).toContain('llm_gateway_paid_ack_at');
    expect(columns(SELLER_SETTINGS_TABLE)).toContain('llm_gateway_paid_ack_version');
  });

  it('stamps the timestamp + current terms version on a fresh server', () => {
    const before = store.getSettings();
    expect(before.llm_gateway_paid_ack_at).toBeNull();
    expect(before.llm_gateway_paid_ack_version).toBeNull();

    const acked = store.acknowledgeLlmGatewayPaid({ now: NOW });
    expect(acked.llm_gateway_paid_ack_at).toBe(NOW);
    expect(acked.llm_gateway_paid_ack_version).toBe(LLM_GATEWAY_PAID_ACK_VERSION);
    // Persisted, not just returned.
    expect(store.getSettings().llm_gateway_paid_ack_version).toBe(LLM_GATEWAY_PAID_ACK_VERSION);
  });

  it('preserves the acknowledgment across a later routine settings edit', () => {
    store.acknowledgeLlmGatewayPaid({ now: NOW });
    const edited = store.upsertSettings({
      default_grace_hours: 24,
      sender_mail_instance_id: 'mail_primary',
      now: NOW + 1_000,
    });
    // The grace edit landed…
    expect(edited.default_grace_hours).toBe(24);
    expect(edited.sender_mail_instance_id).toBe('mail_primary');
    // …and the acknowledgment rode through untouched.
    expect(edited.llm_gateway_paid_ack_at).toBe(NOW);
    expect(edited.llm_gateway_paid_ack_version).toBe(LLM_GATEWAY_PAID_ACK_VERSION);
  });

  it('preserves existing settings when acknowledging on top of a configured server', () => {
    store.upsertSettings({
      default_grace_hours: 48,
      sender_mail_instance_id: 'mail_primary',
      status_policy_json: { past_due: 'grace' },
      now: NOW,
    });
    const acked = store.acknowledgeLlmGatewayPaid({ now: NOW + 2_000 });
    // Acknowledging touches only the ack columns + updated_at.
    expect(acked.default_grace_hours).toBe(48);
    expect(acked.sender_mail_instance_id).toBe('mail_primary');
    expect(acked.status_policy_json).toEqual({ past_due: 'grace' });
    expect(acked.llm_gateway_paid_ack_at).toBe(NOW + 2_000);
    expect(acked.created_at).toBe(NOW);
    expect(acked.updated_at).toBe(NOW + 2_000);
  });

  it('re-acknowledging refreshes the timestamp (idempotent)', () => {
    store.acknowledgeLlmGatewayPaid({ now: NOW });
    const again = store.acknowledgeLlmGatewayPaid({ now: NOW + 5_000 });
    expect(again.llm_gateway_paid_ack_at).toBe(NOW + 5_000);
    expect(again.llm_gateway_paid_ack_version).toBe(LLM_GATEWAY_PAID_ACK_VERSION);
  });
});

describe('seller offers', () => {
  it('idempotently establishes a core-owned draft without pack identity', () => {
    const first = store.ensureOffer({
      offer_id: 'paid-document.outcome',
      kind: 'document',
      display_name: 'Paid document',
      description: 'Prepare and deliver an approved document.',
      pricing_kind: 'fixed',
      amount_minor: 12_500,
      currency: 'usd',
      fulfillment_recipe_id: 'paid-document-origin',
      created_by_recipe_id: 'paid-document-setup',
      now: NOW,
    });
    const replay = store.ensureOffer({
      offer_id: 'paid-document.outcome',
      kind: 'document',
      display_name: 'Paid document',
      description: 'Prepare and deliver an approved document.',
      pricing_kind: 'fixed',
      amount_minor: 12_500,
      currency: 'USD',
      fulfillment_recipe_id: 'paid-document-origin',
      created_by_recipe_id: 'another-recipe',
      now: NOW + 1_000,
    });

    expect(first).toMatchObject({
      result: 'created',
      offer: {
        offer_id: 'paid-document.outcome',
        state: 'draft',
        currency: 'USD',
        created_by_recipe_id: 'paid-document-setup',
        created_at: NOW,
        updated_at: NOW,
      },
    });
    expect(replay).toEqual({ result: 'existing', offer: first.offer });
    expect(store.getOffer('paid-document.outcome')).toEqual(first.offer);
  });

  // D-196 1d — the non-secret generic fulfillment_config on the offer.
  it('round-trips a fulfillment_config and conflicts on a changed one', () => {
    const created = store.ensureOffer({
      offer_id: 'day-pass.access',
      kind: 'access',
      display_name: 'Day pass',
      pricing_kind: 'fixed',
      amount_minor: 500,
      currency: 'USD',
      fulfillment_config: { entitlement_key: 'day-pass', note: 'ok' },
      created_by_recipe_id: 'pass-setup',
      now: NOW,
    });
    // Stored + parsed back as an object (not the raw string).
    expect(created.offer.fulfillment_config).toEqual({
      entitlement_key: 'day-pass',
      note: 'ok',
    });
    expect(store.getOffer('day-pass.access')?.fulfillment_config).toEqual({
      entitlement_key: 'day-pass',
      note: 'ok',
    });

    // Same definition (incl. config) => idempotent existing.
    const replay = store.ensureOffer({
      offer_id: 'day-pass.access',
      kind: 'access',
      display_name: 'Day pass',
      pricing_kind: 'fixed',
      amount_minor: 500,
      currency: 'USD',
      fulfillment_config: { entitlement_key: 'day-pass', note: 'ok' },
      now: NOW + 1_000,
    });
    expect(replay.result).toBe('existing');

    // A changed config must conflict, never silently hand back the stale one.
    expect(() =>
      store.ensureOffer({
        offer_id: 'day-pass.access',
        kind: 'access',
        display_name: 'Day pass',
        pricing_kind: 'fixed',
        amount_minor: 500,
        currency: 'USD',
        fulfillment_config: { entitlement_key: 'week-pass' },
        now: NOW + 2_000,
      }),
    ).toThrow(SellerStoreConflictError);
  });

  it('rejects a non-object fulfillment_config', () => {
    expect(() =>
      store.ensureOffer({
        offer_id: 'bad.config',
        kind: 'access',
        display_name: 'Bad',
        pricing_kind: 'free',
        // @ts-expect-error — a recipe could send a non-object at runtime.
        fulfillment_config: ['not', 'an', 'object'],
        now: NOW,
      }),
    ).toThrow(SellerStoreValidationError);
  });

  it('attaches only the creator recipe as one immutable fulfillment target', () => {
    const created = store.ensureOffer({
      offer_id: 'paid-document.outcome',
      kind: 'document',
      display_name: 'Paid document',
      pricing_kind: 'fixed',
      amount_minor: 12_500,
      currency: 'USD',
      created_by_recipe_id: 'local-paid-document-origin',
      now: NOW,
    });

    const attached = store.attachOfferFulfillmentRecipe({
      offer_id: created.offer.offer_id,
      recipe_id: 'local-paid-document-origin',
      now: NOW,
    });
    const replay = store.attachOfferFulfillmentRecipe({
      offer_id: created.offer.offer_id,
      recipe_id: 'local-paid-document-origin',
      now: NOW + 10,
    });

    expect(attached).toMatchObject({
      result: 'updated',
      offer: {
        fulfillment_recipe_id: 'local-paid-document-origin',
        created_by_recipe_id: 'local-paid-document-origin',
        updated_at: NOW + 1,
      },
    });
    expect(replay).toEqual({ result: 'unchanged', offer: attached.offer });
    expect(() => store.attachOfferFulfillmentRecipe({
      offer_id: created.offer.offer_id,
      recipe_id: 'other-recipe',
      now: NOW + 20,
    })).toThrow(SellerStoreConflictError);
    const archived = store.transitionOfferState({
      offer_id: created.offer.offer_id,
      expected_state: 'draft',
      expected_updated_at: attached.offer.updated_at,
      next_state: 'archived',
      now: NOW + 25,
    });
    expect(store.attachOfferFulfillmentRecipe({
      offer_id: created.offer.offer_id,
      recipe_id: 'local-paid-document-origin',
      now: NOW + 26,
    })).toEqual({ result: 'unchanged', offer: archived.offer });

    const differentlyLinked = store.ensureOffer({
      offer_id: 'paid-document.already-linked',
      kind: 'document',
      display_name: 'Already linked paid document',
      pricing_kind: 'fixed',
      amount_minor: 12_500,
      currency: 'USD',
      fulfillment_recipe_id: 'different-target',
      created_by_recipe_id: 'local-paid-document-origin',
      now: NOW + 30,
    });
    expect(() => store.attachOfferFulfillmentRecipe({
      offer_id: differentlyLinked.offer.offer_id,
      recipe_id: 'local-paid-document-origin',
      now: NOW + 40,
    })).toThrow(SellerStoreConflictError);
  });

  it('refuses to attach a fulfillment target after terminal archive', () => {
    const created = store.ensureOffer({
      offer_id: 'archived-outcome',
      kind: 'document',
      display_name: 'Archived outcome',
      pricing_kind: 'unspecified',
      created_by_recipe_id: 'local-origin',
      now: NOW,
    });
    store.transitionOfferState({
      offer_id: created.offer.offer_id,
      expected_state: 'draft',
      expected_updated_at: NOW,
      next_state: 'archived',
      now: NOW + 1,
    });

    expect(() => store.attachOfferFulfillmentRecipe({
      offer_id: created.offer.offer_id,
      recipe_id: 'local-origin',
      now: NOW + 2,
    })).toThrow(SellerStoreConflictError);
  });

  it('preserves a concurrently advanced owner-state row token', () => {
    const raceDb = new Database(':memory:');
    let beforeAttachUpdate: (() => void) | null = null;
    const instrumentedDb = new Proxy(raceDb, {
      get(target, property) {
        if (property === 'prepare') {
          return (source: string) => {
            const statement = target.prepare(source);
            if (!source.includes('SET fulfillment_recipe_id = @recipe_id')) {
              return statement;
            }
            return new Proxy(statement, {
              get(statementTarget, statementProperty) {
                if (statementProperty === 'run') {
                  return (parameters: unknown) => {
                    const hook = beforeAttachUpdate;
                    beforeAttachUpdate = null;
                    hook?.();
                    return statementTarget.run(parameters as never);
                  };
                }
                const value = Reflect.get(
                  statementTarget,
                  statementProperty,
                  statementTarget,
                );
                return typeof value === 'function'
                  ? value.bind(statementTarget)
                  : value;
              },
            });
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as Database.Database;
    const raceStore = createSellerStore(instrumentedDb);
    const created = raceStore.ensureOffer({
      offer_id: 'owner-transition-race',
      kind: 'document',
      display_name: 'Owner transition race',
      pricing_kind: 'unspecified',
      created_by_recipe_id: 'local-origin',
      now: NOW,
    });
    beforeAttachUpdate = () => {
      raceDb.prepare(`
        UPDATE ${SELLER_OFFERS_TABLE}
           SET state = 'active', updated_at = ?
         WHERE offer_id = ?
      `).run(NOW + 10, created.offer.offer_id);
    };

    expect(() => raceStore.attachOfferFulfillmentRecipe({
      offer_id: created.offer.offer_id,
      recipe_id: 'local-origin',
      now: NOW + 1,
    })).toThrow(SellerStoreConflictError);
    expect(raceStore.getOffer(created.offer.offer_id)).toMatchObject({
      state: 'active',
      fulfillment_recipe_id: null,
      updated_at: NOW + 10,
    });
  });

  it('fails closed on definition drift and validates fixed versus unspecified pricing', () => {
    store.ensureOffer({
      offer_id: 'paid-document.outcome',
      kind: 'document',
      display_name: 'Paid document',
      pricing_kind: 'unspecified',
      fulfillment_recipe_id: 'paid-document-origin',
      now: NOW,
    });

    expect(() => store.ensureOffer({
      offer_id: 'paid-document.outcome',
      kind: 'document',
      display_name: 'Renamed by replay',
      pricing_kind: 'unspecified',
      fulfillment_recipe_id: 'paid-document-origin',
      now: NOW + 1,
    })).toThrow(SellerStoreConflictError);
    expect(() => store.ensureOffer({
      offer_id: 'missing-price',
      kind: 'document',
      display_name: 'Missing price',
      pricing_kind: 'fixed',
      currency: 'USD',
      now: NOW,
    })).toThrow(SellerStoreValidationError);
    expect(() => store.ensureOffer({
      offer_id: 'unexpected-price',
      kind: 'document',
      display_name: 'Unexpected price',
      pricing_kind: 'unspecified',
      amount_minor: 100,
      now: NOW,
    })).toThrow(SellerStoreValidationError);
    expect(() => store.ensureOffer({
      offer_id: 'unsafe-price',
      kind: 'document',
      display_name: 'Unsafe price',
      pricing_kind: 'fixed',
      amount_minor: Number.MAX_SAFE_INTEGER + 1,
      currency: 'USD',
      now: NOW,
    })).toThrow(SellerStoreValidationError);
  });

  it('lists offers deterministically through closed kind and state filters', () => {
    store.ensureOffer({
      offer_id: 'older',
      kind: 'document',
      display_name: 'Older',
      pricing_kind: 'unspecified',
      now: NOW,
    });
    store.ensureOffer({
      offer_id: 'newer',
      kind: 'document',
      display_name: 'Newer',
      pricing_kind: 'unspecified',
      now: NOW + 1,
    });

    expect(store.listOffers({
      kind: 'document',
      state: 'draft',
    }).map((offer) => offer.offer_id)).toEqual(['newer', 'older']);
  });

  it('transitions offer state optimistically without letting ensure reset owner state', () => {
    const created = store.ensureOffer({
      offer_id: 'paid-document.outcome',
      kind: 'document',
      display_name: 'Paid document',
      pricing_kind: 'fixed',
      amount_minor: 12_500,
      currency: 'USD',
      now: NOW,
    });

    const activated = store.transitionOfferState({
      offer_id: 'paid-document.outcome',
      expected_state: 'draft',
      expected_updated_at: NOW,
      next_state: 'active',
      now: NOW,
    });
    const replay = store.transitionOfferState({
      offer_id: 'paid-document.outcome',
      expected_state: 'draft',
      expected_updated_at: NOW,
      next_state: 'active',
      now: NOW + 2,
    });
    const ensured = store.ensureOffer({
      offer_id: 'paid-document.outcome',
      kind: 'document',
      display_name: 'Paid document',
      pricing_kind: 'fixed',
      amount_minor: 12_500,
      currency: 'usd',
      created_by_recipe_id: 'later-recipe-run',
      now: NOW + 3,
    });

    expect(activated).toMatchObject({
      result: 'updated',
      offer: { state: 'active', updated_at: NOW + 1 },
    });
    expect(replay).toEqual({ result: 'unchanged', offer: activated.offer });
    expect(ensured).toEqual({ result: 'existing', offer: activated.offer });
    expect(created.offer.created_by_recipe_id).toBeNull();
    expect(store.listOffers({ state: 'active' })).toEqual([activated.offer]);
    expect(store.listOffers({ state: 'draft' })).toEqual([]);
  });

  it('enforces the closed transition graph, optimistic state token, and terminal archive', () => {
    store.ensureOffer({
      offer_id: 'paid-document.outcome',
      kind: 'document',
      display_name: 'Paid document',
      pricing_kind: 'unspecified',
      now: NOW,
    });

    expect(() => store.transitionOfferState({
      offer_id: 'paid-document.outcome',
      expected_state: 'draft',
      expected_updated_at: NOW,
      next_state: 'paused',
      now: NOW + 1,
    })).toThrow(SellerStoreValidationError);
    expect(store.getOffer('paid-document.outcome')?.state).toBe('draft');

    store.transitionOfferState({
      offer_id: 'paid-document.outcome',
      expected_state: 'draft',
      expected_updated_at: NOW,
      next_state: 'active',
      now: NOW + 2,
    });
    expect(() => store.transitionOfferState({
      offer_id: 'paid-document.outcome',
      expected_state: 'draft',
      expected_updated_at: NOW,
      next_state: 'archived',
      now: NOW + 3,
    })).toThrow(SellerStoreConflictError);
    store.transitionOfferState({
      offer_id: 'paid-document.outcome',
      expected_state: 'active',
      expected_updated_at: NOW + 2,
      next_state: 'paused',
      now: NOW + 4,
    });
    store.transitionOfferState({
      offer_id: 'paid-document.outcome',
      expected_state: 'paused',
      expected_updated_at: NOW + 4,
      next_state: 'active',
      now: NOW + 5,
    });
    expect(() => store.transitionOfferState({
      offer_id: 'paid-document.outcome',
      expected_state: 'active',
      expected_updated_at: NOW + 2,
      next_state: 'paused',
      now: NOW + 6,
    })).toThrow(/expected updated_at/);
    const archived = store.transitionOfferState({
      offer_id: 'paid-document.outcome',
      expected_state: 'active',
      expected_updated_at: NOW + 5,
      next_state: 'archived',
      now: NOW + 7,
    });

    expect(archived.offer.state).toBe('archived');
    expect(() => store.transitionOfferState({
      offer_id: 'paid-document.outcome',
      expected_state: 'archived',
      expected_updated_at: NOW + 7,
      next_state: 'active',
      now: NOW + 8,
    })).toThrow(SellerStoreValidationError);
    expect(() => store.transitionOfferState({
      offer_id: 'missing',
      expected_state: 'draft',
      expected_updated_at: NOW,
      next_state: 'active',
      now: NOW + 9,
    })).toThrow(SellerStoreValidationError);
  });
});

describe('seller tiers', () => {
  it('upserts by source-qualified tier and preserves the original tier_id', () => {
    const first = store.upsertTier(tierInput());
    const second = store.upsertTier(tierInput({
      tier_id: 'tier_new_candidate',
      display_name: 'Basic renamed',
      now: NOW + 1000,
    }));

    expect(second.tier_id).toBe(first.tier_id);
    expect(second.display_name).toBe('Basic renamed');
    expect(second.created_at).toBe(NOW);
    expect(second.updated_at).toBe(NOW + 1000);
    expect(store.findTier({
      door_id: 'door_mcp',
      lifecycle_source: 'stripe',
      entitlement_key: 'basic',
    })?.tier_id).toBe('tier_basic');
  });

  it('preserves omitted mutable fields and does not reactivate an inactive tier', () => {
    store.upsertTier(tierInput({
      external_entitlement_id: 'price_basic',
      pass_duration_seconds: 3600,
      customer_status_enabled_default: true,
      active: false,
    }));

    const patched = store.upsertTier({
      tier_id: 'tier_basic',
      door_id: 'door_mcp',
      lifecycle_source: 'stripe',
      entitlement_key: 'basic',
      now: NOW + 1000,
    });

    expect(patched).toMatchObject({
      display_name: 'Basic',
      template_contract_id: 'ct_template_basic',
      external_entitlement_id: 'price_basic',
      usage_policy_json: { tool_call: { period_limit: 1000 } },
      pass_duration_seconds: 3600,
      customer_status_enabled_default: true,
      active: false,
      created_at: NOW,
      updated_at: NOW + 1000,
    });
  });

  it('rejects tier identity rehoming and requires mutable fields on create', () => {
    const original = store.upsertTier(tierInput());

    expect(() => store.upsertTier(tierInput({
      door_id: 'door_other',
      entitlement_key: 'other',
      now: NOW + 1,
    }))).toThrow(SellerStoreConflictError);
    expect(() => store.upsertTier(tierInput({
      lifecycle_source: 'manual',
      entitlement_key: 'manual-basic',
      now: NOW + 2,
    }))).toThrow(SellerStoreConflictError);
    expect(() => store.upsertTier(tierInput({
      entitlement_key: 'pro',
      now: NOW + 3,
    }))).toThrow(SellerStoreConflictError);
    expect(store.getTier('tier_basic')).toEqual(original);

    expect(() => store.upsertTier({
      tier_id: 'tier_missing_fields',
      door_id: 'door_mcp',
      lifecycle_source: 'stripe',
      entitlement_key: 'missing',
      now: NOW,
    })).toThrow(SellerStoreValidationError);
  });
});

describe('seller customers', () => {
  it('requires customer tiers to exist and match the same source and door', () => {
    expect(() => store.upsertCustomer(customerInput()))
      .toThrow(SellerStoreValidationError);

    store.upsertTier(tierInput({ lifecycle_source: 'manual' }));

    expect(() => store.upsertCustomer(customerInput()))
      .toThrow(SellerStoreValidationError);
  });

  it('stores email as nullable and source-qualified, never as the identity key', () => {
    store.upsertTier(tierInput());
    const noEmail = store.upsertCustomer(customerInput());

    expect(noEmail.email).toBeNull();
    expect(store.findCustomerBySource({
      lifecycle_source: 'stripe',
      source_customer_id: 'cus_1',
      door_id: 'door_mcp',
    })?.customer_id).toBe('cust_1');

    const withEmail = store.upsertCustomer(customerInput({
      customer_id: 'cust_1',
      email: ' Buyer@Example.COM ',
      source_status: 'active',
      inbound_token_id: 'tok_1',
      now: NOW + 1000,
    }));

    expect(withEmail.customer_id).toBe('cust_1');
    expect(withEmail.email).toBe('buyer@example.com');
    expect(withEmail.inbound_token_id).toBe('tok_1');
    expect(withEmail.created_at).toBe(NOW);

    const omittedEmailUpdate = store.upsertCustomer(customerInput({
      customer_id: 'cust_1',
      source_status: 'past_due',
      now: NOW + 2000,
    }));
    expect(omittedEmailUpdate.email).toBe('buyer@example.com');
    expect(omittedEmailUpdate.source_status).toBe('past_due');
    expect(omittedEmailUpdate.inbound_token_id).toBe('tok_1');

    const clearedEmail = store.upsertCustomer(customerInput({
      email: null,
      now: NOW + 3000,
    }));
    expect(clearedEmail.email).toBeNull();
  });

  it('keeps local customer ids and source-qualified identity immutable', () => {
    store.upsertTier(tierInput());
    store.upsertTier(tierInput({
      tier_id: 'tier_manual',
      lifecycle_source: 'manual',
      entitlement_key: 'manual-basic',
    }));
    store.upsertTier(tierInput({
      tier_id: 'tier_other_door',
      door_id: 'door_other',
      entitlement_key: 'other-door',
    }));
    const original = store.upsertCustomer(customerInput());

    expect(() =>
      store.upsertCustomer(customerInput({
        customer_id: 'cust_replacement',
        now: NOW + 1,
      })),
    ).toThrow(SellerStoreConflictError);
    expect(() =>
      store.upsertCustomer(customerInput({
        source_customer_id: 'cus_rehomed',
        now: NOW + 2,
      })),
    ).toThrow(SellerStoreConflictError);
    expect(() =>
      store.upsertCustomer(customerInput({
        lifecycle_source: 'manual',
        tier_id: 'tier_manual',
        now: NOW + 3,
      })),
    ).toThrow(SellerStoreConflictError);
    expect(() =>
      store.upsertCustomer(customerInput({
        door_id: 'door_other',
        tier_id: 'tier_other_door',
        now: NOW + 4,
      })),
    ).toThrow(SellerStoreConflictError);

    expect(store.getCustomer('cust_1')).toEqual(original);
    expect(store.getCustomer('cust_replacement')).toBeNull();
    expect(store.findCustomerBySource({
      lifecycle_source: 'stripe',
      source_customer_id: 'cus_rehomed',
      door_id: 'door_mcp',
    })).toBeNull();
  });

  it('allows one email to appear on multiple source-qualified customers', () => {
    store.upsertTier(tierInput());
    store.upsertTier(tierInput({
      tier_id: 'tier_manual',
      lifecycle_source: 'manual',
      entitlement_key: 'manual-basic',
      now: NOW + 1,
    }));
    store.upsertCustomer(customerInput({ customer_id: 'cust_a', email: 'shared@example.com' }));
    store.upsertCustomer(customerInput({
      customer_id: 'cust_b',
      source_customer_id: 'manual_1',
      lifecycle_source: 'manual',
      tier_id: 'tier_manual',
      email: 'shared@example.com',
      now: NOW + 2,
    }));

    expect(store.listCustomers({ email: 'SHARED@example.com' }).map((row) => row.customer_id))
      .toEqual(['cust_b', 'cust_a']);
    expect(() => store.listCustomers({ email: '   ' }))
      .toThrow(SellerStoreValidationError);
  });

  it('filters customers by bound contract id', () => {
    store.upsertTier(tierInput());
    store.upsertCustomer(customerInput({
      customer_id: 'cust_a',
      source_customer_id: 'cus_a',
      contract_id: 'ct_customer_a',
      now: NOW,
    }));
    store.upsertCustomer(customerInput({
      customer_id: 'cust_b',
      source_customer_id: 'cus_b',
      contract_id: 'ct_customer_b',
      now: NOW + 1,
    }));

    expect(store.listCustomers({ contract_id: 'ct_customer_b' }).map((row) => row.customer_id))
      .toEqual(['cust_b']);
  });

  it('atomically reserves and completes one durable claim-email delivery', () => {
    store.upsertTier(tierInput());
    store.upsertCustomer(customerInput());

    expect(store.reserveClaimEmailDelivery({
      customer_id: 'cust_1',
      marker: 'claim:claim_1',
      now: NOW + 1,
    })).toBe(true);
    expect(store.getCustomer('cust_1')).toMatchObject({
      claim_email_marker: 'claim:claim_1',
      claim_email_sent_at: null,
      updated_at: NOW + 1,
    });

    expect(store.reserveClaimEmailDelivery({
      customer_id: 'cust_1',
      marker: 'claim:claim_1',
      now: NOW + 2,
    })).toBe(false);
    expect(store.markClaimEmailDeliverySent({
      customer_id: 'cust_1',
      marker: 'claim:wrong',
      sent_at: NOW + 3,
      now: NOW + 3,
    })).toBe(false);
    expect(store.markClaimEmailDeliverySent({
      customer_id: 'cust_1',
      marker: 'claim:claim_1',
      sent_at: NOW + 4,
      now: NOW + 5,
    })).toBe(true);
    expect(store.getCustomer('cust_1')).toMatchObject({
      claim_email_marker: 'claim:claim_1',
      claim_email_sent_at: NOW + 4,
      updated_at: NOW + 5,
    });
    expect(store.markClaimEmailDeliverySent({
      customer_id: 'cust_1',
      marker: 'claim:claim_1',
      sent_at: NOW + 6,
      now: NOW + 6,
    })).toBe(false);
  });

  it('never creates a customer while reserving a missing claim-email slot', () => {
    expect(store.reserveClaimEmailDelivery({
      customer_id: 'missing',
      marker: 'claim:claim_1',
      now: NOW,
    })).toBe(false);
    expect(store.listCustomers()).toEqual([]);
  });

  it('rejects malformed claim-email transition timestamps', () => {
    store.upsertTier(tierInput());
    store.upsertCustomer(customerInput());

    expect(() => store.reserveClaimEmailDelivery({
      customer_id: 'cust_1',
      marker: 'claim:claim_1',
      now: Number.NaN,
    })).toThrow(SellerStoreValidationError);
    expect(store.getCustomer('cust_1')).toMatchObject({
      claim_email_marker: null,
      claim_email_sent_at: null,
    });
    expect(() => store.markClaimEmailDeliverySent({
      customer_id: 'cust_1',
      marker: 'claim:claim_1',
      sent_at: -1,
      now: NOW,
    })).toThrow(SellerStoreValidationError);
  });
});

describe('seller customer usage rollups', () => {
  it('increments compact usage counters by usage kind and period', () => {
    const first = store.recordUsage({
      contract_id: 'ct_customer_1',
      usage_kind: 'tool_call',
      period_granularity: 'month',
      period_start: NOW,
      units: 2,
      now: NOW,
    });
    const second = store.recordUsage({
      contract_id: 'ct_customer_1',
      usage_kind: 'tool_call',
      period_granularity: 'month',
      period_start: NOW,
      units: 3,
      now: NOW + 1000,
    });

    expect(first.units).toBe(2);
    expect(second.units).toBe(5);
    expect(second.created_at).toBe(NOW);
    expect(second.updated_at).toBe(NOW + 1000);
    expect(store.getUsageRollup({
      contract_id: 'ct_customer_1',
      usage_kind: 'tool_call',
      period_granularity: 'month',
      period_start: NOW,
    })?.units).toBe(5);
  });

  it('rejects invalid usage increments before SQLite constraints fire', () => {
    expect(() =>
      store.recordUsage({
        contract_id: 'ct_customer_1',
        usage_kind: 'tool_call',
        period_granularity: 'month',
        period_start: NOW,
        units: 0,
        now: NOW,
      }),
    ).toThrow(SellerStoreValidationError);
  });
});
