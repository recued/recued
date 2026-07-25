import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import {
  RECEPTION_RPC_METHODS,
  PAID_DOCUMENT_DIRECT_CHECKOUT_SELLER_ASSOCIATION_CONFIGURATION_VERSION,
  receptionPairBinding,
  type IntakeFormConfig,
  type PaidDocumentDirectCheckoutLegacyClaimConfiguration,
  type PaidDocumentDirectCheckoutSellerAssociationClaimConfiguration,
  type ContractDefinition,
  type ReceptionIntakeRecipePairClearInput,
  type ReceptionIntakeRecipePairView,
  type RecipeDefinition,
} from '@recued/contracts';
import type { ActivityEntry, AuditLogStore } from '@recued/storage';
import { createPreviewHashStore } from '../ports/reception/preview-hash.js';
import {
  handleReceptionIntakeRecipePairBind,
  handleReceptionIntakeRecipePairClear,
  handleReceptionIntakeRecipePairConfigure,
  handleReceptionIntakeRecipePairGet,
  makeReceptionHandlers,
  type ReceptionBroadcastEvent,
  type ReceptionRpcDeps,
} from '../reception-rpc-handler.js';
import { createRecipeStore, type RecipeStore } from '../recipe-store.js';
import type { ReceptionDoorBindDeps } from '../reception-door-bind.js';
import { createPublicEndpointRegistryStore } from '../storage/public-endpoint-registry-store.js';
import type { ContractDefinitionStore } from '../storage/contract-definition-store.js';
import type { ContractGrantEntryStore } from '../storage/contract-grant-entry-store.js';
import { createReceptionIntakeRecipePairStore } from '../storage/reception-intake-recipe-pair-store.js';
import { ensureReceptionSchema } from '../storage/reception-store.js';

/** D-210 R-2 slice 4 — a bind's view is now a union of a form arm and a scheduling arm, and
 *  only the form arm carries a claim configuration. Every bind in this file is an
 *  `intake_form` bind, so narrow in one place and say why rather than repeat the guard. */
const readyFormPair = (
  view: ReceptionIntakeRecipePairView,
): Extract<
  ReceptionIntakeRecipePairView,
  { readonly status: 'ready'; readonly pair_subject: 'form' }
> => {
  if (view.status !== 'ready' || view.pair_subject !== 'form') {
    throw new Error(`expected a ready FORM pair; got status=${view.status}`);
  }
  return view;
};

const NOW = 1_700_000_000_000;
const ENDPOINT_ID = 'ep-direct-checkout';
const FORM_DEFINITION_ID = 'research-brief-v1';
const RECIPE_ID = 'research-brief-checkout';
const CALLER = { instance_id: 'paired-owner-client' };

const formConfig = (
  overrides: Partial<IntakeFormConfig> = {},
): IntakeFormConfig => ({
  display_name: 'Commission one research brief',
  success_message: 'Request received.',
  form_definition: {
    form_definition_id: FORM_DEFINITION_ID,
    fields: [
      { name: 'product', type: 'text', label: 'Product', required: true },
      { name: 'amount_minor', type: 'number', label: 'Price', required: true },
      {
        name: 'currency',
        type: 'enum',
        label: 'Currency',
        required: true,
        values: ['usd', 'eur'],
      },
      { name: 'brief', type: 'textarea', label: 'Brief', required: true },
    ],
  },
  submission_processing_rule: {
    // D-210 A.8 slice 2b step 3 — a D-200 pair mints no destination entity: the
    // response row IS the paid deliverable. That used to be spelled as an
    // ABSENT target_kind; absent is no longer a value, so it is spelled
    // explicitly now. `reception-pair-binding` requires exactly this.
    target_kind: 'form_response',
    fields_to_include_in_target: [],
    fields_to_attach_as_metadata: [],
  },
  anti_spam: {
    honeypot_fields: [],
    rate_limit_per_ip: 5,
    require_proof_of_work: false,
    require_captcha: false,
  },
  required_visitor_fields: { email: 'required' },
  ...overrides,
});

const recipe = (overrides: Partial<RecipeDefinition> = {}): RecipeDefinition => ({
  recipe_id: RECIPE_ID,
  version: 3,
  ttl: 300,
  metadata: {
    name: 'Research brief checkout',
    description: 'Validates one intake into one checkout item.',
    author: 'local-author',
    supported_platforms: [],
  },
  variables: {},
  prefetch_steps: [],
  steps: [],
  output: { render: [] },
  ...overrides,
});

const directSubmitRecipe = (): RecipeDefinition => recipe({
  metadata: {
    name: 'Research brief checkout',
    description: 'Validates one intake into one checkout item.',
    author: 'local-author',
    supported_platforms: [],
    budget_ms: 500,
  },
  steps: [{
    id: 'intent',
    transform: 'coalesce',
    values: [{
      submission_id: '{{context.reception_submission.submission_id}}',
      product_name: 'One research brief',
      product_description: 'One reviewed PDF research brief',
      amount_minor: 12_500,
      currency: 'usd',
    }],
  }],
  output: { render: [{ type: 'text', source: 'step.intent' }] },
});

const claimConfiguration = (
  overrides: Partial<PaidDocumentDirectCheckoutLegacyClaimConfiguration> = {},
): PaidDocumentDirectCheckoutLegacyClaimConfiguration => ({
  version: 1,
  stripe_connection_name: 'stripe-primary',
  success_url: 'https://owner.example/checkout/success',
  cancel_url: 'https://owner.example/checkout/cancel',
  expiry_window_ms: 30 * 60 * 1_000,
  template_file_ref: `file:${'a'.repeat(32)}`,
  ...overrides,
});

const sellerAssociatedClaimConfiguration = (
  overrides: Partial<PaidDocumentDirectCheckoutSellerAssociationClaimConfiguration> = {},
): PaidDocumentDirectCheckoutSellerAssociationClaimConfiguration => ({
  ...claimConfiguration(),
  version: PAID_DOCUMENT_DIRECT_CHECKOUT_SELLER_ASSOCIATION_CONFIGURATION_VERSION,
  seller_offer_id: 'research-brief.fulfilled',
  ...overrides,
});

const buildAuditLog = (): { auditLog: AuditLogStore; rows: ActivityEntry[] } => {
  const rows: ActivityEntry[] = [];
  return {
    rows,
    auditLog: {
      logActivity: async (entry: ActivityEntry) => {
        rows.push(entry);
      },
    } as unknown as AuditLogStore,
  };
};

const buildFixture = (input: {
  readonly config?: IntakeFormConfig;
  readonly source_form_definition_id?: string;
  readonly endpoint_kind?: 'intake_form' | 'scheduling_link' | 'drop_link';
  readonly persistent_recipe_store?: boolean;
} = {}) => {
  const db = new Database(':memory:');
  ensureReceptionSchema(db);
  const endpoints = createPublicEndpointRegistryStore(db);
  const pairs = createReceptionIntakeRecipePairStore(db);
  const recipes = new Map<string, RecipeDefinition>();
  const broadcasts: ReceptionBroadcastEvent[] = [];
  const { auditLog, rows } = buildAuditLog();
  let now = NOW;
  let recipeRead: (recipe_id: string) => RecipeDefinition | null =
    (recipe_id) => recipes.get(recipe_id) ?? null;
  const config = input.config ?? formConfig();
  const endpointKind = input.endpoint_kind ?? 'intake_form';
  endpoints.create({
    endpoint_id: ENDPOINT_ID,
    kind: endpointKind,
    packet_declaration: endpointKind === 'intake_form'
      ? {
          packet_kind: 'intake_form_packet',
          source_query_ref: {
            kind: 'reception_form_definition',
            form_definition_id:
              input.source_form_definition_id ?? FORM_DEFINITION_ID,
          },
        }
      : endpointKind === 'drop_link'
        ? {
            packet_kind: 'drop_link_packet',
            source_query_ref: {
              kind: 'reception_drop_config',
              drop_config_id: 'drop_unpairable',
            },
          }
        : {
            packet_kind: 'scheduling_link_packet',
            source_query_ref: { kind: 'data.calendar.combined' },
          },
    bearer_secret_hmac: Buffer.alloc(32, 0x44),
    created_at: NOW - 1_000,
    created_by_client_id: CALLER.instance_id,
    expires_at: null,
    long_lived_acknowledged_at: NOW - 1_000,
    metadata: config as unknown as Readonly<Record<string, unknown>>,
  });
  const recipeStore = input.persistent_recipe_store
    ? createRecipeStore('/definitely-not-a-real-d200-recipe-path', db)
    : {
        get: (recipe_id: string) => recipeRead(recipe_id),
      } as RecipeStore;
  // D-207 slice 1c — a server that CAN hang doors, which in production is every server that
  // has a pair store at all (the contract substrate and the pair store are composed
  // together). Without this seam `bind` refuses outright: a pair with no door contract runs
  // NOTHING on submit — an anonymous dispatch floors to `PUBLIC_CONTRACT_ID`, which grants
  // nothing — so saving one would leave a public form that looks live and hard-denies every
  // visitor. The contract stores are the real substrate's shape, faked at the IO boundary;
  // the mint/diff/consent logic under test is the real `bindReceptionDoor`.
  const definitions = new Map<string, ContractDefinition>();
  const doorGrants: string[] = [];
  let doorSeq = 0;
  const doorBindDeps: ReceptionDoorBindDeps = {
    pairStore: pairs,
    definitionStore: {
      mint: (i: Record<string, unknown>) => {
        const d = {
          contract_id: `door_${++doorSeq}`,
          status: 'active',
          minted_at: now,
          ...i,
        } as unknown as ContractDefinition;
        definitions.set(d.contract_id, d);
        return d;
      },
      get: (id: string) => definitions.get(id) ?? null,
      revoke: (id: string) => {
        const d = definitions.get(id);
        if (!d) return null;
        const revoked = { ...d, revoked_at: now } as ContractDefinition;
        definitions.set(id, revoked);
        return revoked;
      },
    } as unknown as ContractDefinitionStore,
    grantEntryStore: {
      set: (_contract: string, key: string) => { doorGrants.push(key); },
    } as unknown as ContractGrantEntryStore,
    now: () => now,
    resolveConfig: () => ({}),
  };

  const deps: ReceptionRpcDeps = {
    getStore: () => endpoints,
    getPreviewStore: () => createPreviewHashStore(),
    getPepper: () => Buffer.alloc(32, 0x55),
    getShareBaseUrl: () => 'https://owner.example',
    getIntakeRecipePairStore: () => pairs,
    getRecipeStore: () => recipeStore,
    getDoorBindDeps: () => doorBindDeps,
    auditLog,
    broadcast: (event) => broadcasts.push(event),
    now: () => now,
  };
  return {
    definitions,
    doorGrants,
    db,
    deps,
    endpoints,
    pairs,
    recipeStore,
    recipes,
    rows,
    broadcasts,
    setNow: (value: number) => {
      now = value;
    },
    setRecipeRead: (read: (recipe_id: string) => RecipeDefinition | null) => {
      recipeRead = read;
    },
  };
};

const bind = (
  deps: ReceptionRpcDeps,
  expected_updated_at: number | null = null,
) => handleReceptionIntakeRecipePairBind(deps, {
  endpoint_id: ENDPOINT_ID,
  recipe_id: RECIPE_ID,
  expected_updated_at,
}, CALLER);

const clearInputFromView = (
  view: ReceptionIntakeRecipePairView,
): ReceptionIntakeRecipePairClearInput => ({
  endpoint_id: view.endpoint_id,
  expected_status: view.status,
  expected_updated_at: view.updated_at,
  expected_pair_revision: view.binding?.pair_revision ?? null,
});

describe('D-200 Slice 6g.3 owner intake/recipe pair authoring', () => {
  it('registers every reserved Reception method and dispatches bind through the live slice', async () => {
    const { deps, recipes } = buildFixture();
    recipes.set(RECIPE_ID, recipe());
    const slice = makeReceptionHandlers(deps);

    expect(slice?.methods).toEqual(RECEPTION_RPC_METHODS);
    if (!slice) throw new Error('Reception handler slice was not composed');
    const bindHandler = slice.handlers['reception.intake_recipe_pair.bind'];
    await expect(bindHandler(
      {
        endpoint_id: ENDPOINT_ID,
        recipe_id: RECIPE_ID,
        expected_updated_at: null,
      },
      CALLER as Parameters<typeof bindHandler>[1],
    )).resolves.toMatchObject({ outcome: 'created', pair: { status: 'ready' } });
  });

  it('keeps get, bind, configure, and clear behind the paired-client boundary', async () => {
    const { deps } = buildFixture();
    await expect(handleReceptionIntakeRecipePairGet(
      deps,
      { endpoint_id: ENDPOINT_ID },
      undefined,
    )).rejects.toThrow(/requires a paired client/);
    await expect(handleReceptionIntakeRecipePairBind(
      deps,
      {
        endpoint_id: ENDPOINT_ID,
        recipe_id: RECIPE_ID,
        expected_updated_at: null,
      },
      undefined,
    )).rejects.toThrow(/requires a paired client/);
    await expect(handleReceptionIntakeRecipePairConfigure(
      deps,
      {
        endpoint_id: ENDPOINT_ID,
        expected_updated_at: NOW,
        expected_pair_revision: `d200-pair-v1-${'a'.repeat(64)}`,
        configuration: claimConfiguration(),
      },
      undefined,
    )).rejects.toThrow(/requires a paired client/);
    await expect(handleReceptionIntakeRecipePairClear(
      deps,
      {
        endpoint_id: ENDPOINT_ID,
        expected_status: 'unpaired',
        expected_updated_at: null,
        expected_pair_revision: null,
      },
      undefined,
    )).rejects.toThrow(/requires a paired client/);
  });

  it.each([
    ['pair_binding', { pair_binding: { caller: 'authority' } }],
    ['pair_revision', { pair_revision: `d200-pair-v1-${'a'.repeat(64)}` }],
    ['seller_offer_id', { seller_offer_id: 'offer-1' }],
    ['pack_slug', { pack_slug: 'paid-document-pack' }],
    ['publisher_id', { publisher_id: 'publisher-1' }],
    ['recipe_version', { recipe_version: 99 }],
    ['field_mapping', { field_mapping: { amount_minor: 'price' } }],
    ['amount_minor', { amount_minor: 50_000 }],
  ])('rejects caller-supplied %s authority before a row write', async (_key, extra) => {
    const { deps, pairs, recipes, rows, broadcasts } = buildFixture();
    recipes.set(RECIPE_ID, recipe());
    await expect(handleReceptionIntakeRecipePairBind(deps, {
      endpoint_id: ENDPOINT_ID,
      recipe_id: RECIPE_ID,
      expected_updated_at: null,
      ...extra,
    } as never, CALLER)).rejects.toMatchObject({
      code: 'intake_recipe_pair_invalid',
      status: 400,
    });
    expect(pairs.findByEndpoint(ENDPOINT_ID)).toBeNull();
    expect(rows).toHaveLength(0);
    expect(broadcasts).toHaveLength(0);
  });

  it.each([
    ['missing observation', { endpoint_id: ENDPOINT_ID }],
    ['unknown status', {
      endpoint_id: ENDPOINT_ID,
      expected_status: 'unknown',
      expected_updated_at: NOW,
      expected_pair_revision: `d200-pair-v1-${'a'.repeat(64)}`,
    }],
    ['ready without locators', {
      endpoint_id: ENDPOINT_ID,
      expected_status: 'ready',
      expected_updated_at: null,
      expected_pair_revision: null,
    }],
    ['unpaired with locators', {
      endpoint_id: ENDPOINT_ID,
      expected_status: 'unpaired',
      expected_updated_at: NOW,
      expected_pair_revision: `d200-pair-v1-${'a'.repeat(64)}`,
    }],
    ['mixed stale locators', {
      endpoint_id: ENDPOINT_ID,
      expected_status: 'stale',
      expected_updated_at: NOW,
      expected_pair_revision: null,
    }],
    ['malformed revision', {
      endpoint_id: ENDPOINT_ID,
      expected_status: 'stale',
      expected_updated_at: NOW,
      expected_pair_revision: 'caller-shaped',
    }],
  ])('rejects a clear with %s', async (_label, input) => {
    const { deps, pairs, recipes } = buildFixture();
    recipes.set(RECIPE_ID, recipe());
    const created = await bind(deps);

    await expect(handleReceptionIntakeRecipePairClear(
      deps,
      input as never,
      CALLER,
    )).rejects.toMatchObject({
      code: 'intake_recipe_pair_invalid',
      status: 400,
    });
    expect(pairs.findByEndpoint(ENDPOINT_ID)?.binding).toEqual(created.pair.binding);
  });

  it('derives and persists a standalone saved recipe without Seller, pack, or publisher identity', async () => {
    const { deps, endpoints, pairs, recipes, rows, broadcasts } = buildFixture();
    const savedRecipe = recipe();
    recipes.set(RECIPE_ID, savedRecipe);
    const expected = receptionPairBinding({
      form_config: formConfig(),
      recipe: savedRecipe,
      seller_offer_id: null,
    });

    const created = await bind(deps);

    expect(created).toEqual({
      outcome: 'created',
      // D-207 slice 1c — the pair now carries the DOOR that gates its public form. This
      // recipe dispatches no ops, so its closure is empty: nothing to consent to, and the
      // door is minted straight away. An empty closure is NOT a wildcard — reception doors
      // are deny-by-default (`usesExplicitOnlyGrantDefaults`), so this door grants nothing.
      door: {
        status: 'bound',
        contract_id: 'door_1',
        operation_ids: [],
        unchanged: false,
      },
      pair: {
        endpoint_id: ENDPOINT_ID,
        status: 'ready',
        // D-210 R-2 slice 4 — the ready view names the SUBJECT it was derived from, so a
        // reader can tell a form pair (which owes a claim configuration) from a scheduling
        // one (which has no claim to owe). Derived at the view constructor from the
        // binding's own version, never passed in beside it.
        pair_subject: 'form',
        binding: expected,
        claim_configuration_readiness: {
          status: 'blocked',
          configuration: null,
          blockers: ['claim_configuration_missing'],
        },
        claim_configuration_authoring: { status: 'unavailable' },
        created_at: NOW,
        updated_at: NOW,
      },
    });
    expect(pairs.findByEndpoint(ENDPOINT_ID)?.binding).toEqual(expected);
    expect(created.pair.binding).not.toHaveProperty('seller_offer_id');
    expect(created.pair.binding).not.toHaveProperty('pack_slug');
    expect(created.pair.binding).not.toHaveProperty('publisher_id');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'reception.intake_recipe_pair.bound',
      target: ENDPOINT_ID,
      reserve: true,
    });
    expect(broadcasts).toEqual([{
      kind: 'reception.endpoint_changed',
      op: 'pair_bind',
      endpoint_id: ENDPOINT_ID,
    }]);
    expect(endpoints.findById(ENDPOINT_ID)?.audit_count).toBe(1);
    await expect(handleReceptionIntakeRecipePairGet(
      deps,
      { endpoint_id: ENDPOINT_ID },
      CALLER,
    )).resolves.toEqual(created.pair);
  });

  it('treats an exact replay as unchanged even with the original null observation token', async () => {
    const { deps, pairs, recipes, rows, broadcasts, setNow } = buildFixture();
    recipes.set(RECIPE_ID, recipe());
    const created = await bind(deps);
    setNow(NOW + 10_000);

    const replay = await bind(deps, null);

    expect(replay.outcome).toBe('unchanged');
    expect(replay.pair.updated_at).toBe(created.pair.updated_at);
    expect(pairs.findByEndpoint(ENDPOINT_ID)?.updated_at).toBe(NOW);
    expect(rows).toHaveLength(1);
    expect(broadcasts).toHaveLength(1);
  });

  it('updates with the exact observed token, advances a same-clock row, and rejects a stale writer', async () => {
    const { deps, pairs, recipes, rows, broadcasts } = buildFixture();
    recipes.set(RECIPE_ID, recipe());
    const created = await bind(deps);
    recipes.set(RECIPE_ID, recipe({ ttl: 301 }));

    const updated = await bind(deps, created.pair.updated_at);

    expect(updated.outcome).toBe('updated');
    expect(updated.pair.created_at).toBe(NOW);
    expect(updated.pair.updated_at).toBe(NOW + 1);
    const revisionAfterUpdate = updated.pair.binding?.pair_revision;
    recipes.set(RECIPE_ID, recipe({ ttl: 302 }));
    await expect(bind(deps, created.pair.updated_at)).rejects.toMatchObject({
      code: 'intake_recipe_pair_conflict',
      status: 409,
      details: { current_updated_at: NOW + 1 },
    });
    expect(pairs.findByEndpoint(ENDPOINT_ID)?.binding.pair_revision)
      .toBe(revisionAfterUpdate);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.activity_id)).size).toBe(2);
    expect(broadcasts.flatMap((event) =>
      event.kind === 'reception.endpoint_changed' ? [event.op] : [],
    )).toEqual(['pair_bind', 'pair_bind']);
  });

  it('re-proves pair authority after asynchronous template readiness I/O', async () => {
    const { deps, pairs, recipes, rows, broadcasts } = buildFixture();
    const templateRef = `file:${'a'.repeat(32)}`;
    const templateBytes = Buffer.from('# Exact template', 'utf8');
    const templateHash = createHash('sha256').update(templateBytes).digest('hex');
    const configured = recipe({
      metadata: {
        ...recipe().metadata,
        paid_document_direct_checkout: {
          version: 1,
          stripe_connection_name: 'stripe-primary',
          success_url: 'https://owner.example/checkout/success',
          cancel_url: 'https://owner.example/checkout/cancel',
          expiry_window_ms: 30 * 60 * 1_000,
          template_file_ref: templateRef,
        },
      },
    });
    recipes.set(RECIPE_ID, configured);
    let announceRead = (): void => {};
    const readStarted = new Promise<void>((resolve) => {
      announceRead = resolve;
    });
    let releaseRead = (): void => {};
    const readReleased = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    Object.assign(deps, {
      getConnectionStore: () => ({
        get: () => ({
          kind: 'api',
          name: 'stripe-primary',
          config_json: JSON.stringify({ vendor: 'stripe' }),
          subtype: 'stripe',
        }),
      }),
      getInboundFileCollection: () => ({
        get: () => ({
          record_id: templateRef,
          size_bytes: templateBytes.length,
          blob_hash: templateHash,
          hot_fields: {
            filename: 'exact.md',
            mime_type: 'text/markdown',
            size: templateBytes.length,
            content_hash: templateHash,
          },
          storage_ref: { kind: 'cas', blob_hash: templateHash },
        }),
        readBytes: async () => {
          announceRead();
          await readReleased;
          return {
            bytes: templateBytes,
            mime_type: 'text/markdown',
            filename: 'exact.md',
          };
        },
      }),
    });

    const pendingBind = bind(deps);
    await readStarted;
    recipes.set(RECIPE_ID, { ...configured, ttl: configured.ttl + 1 });
    releaseRead();

    await expect(pendingBind).rejects.toMatchObject({
      code: 'intake_recipe_pair_conflict',
      status: 409,
    });
    expect(pairs.findByEndpoint(ENDPOINT_ID)).not.toBeNull();
    expect(rows).toHaveLength(1);
    expect(broadcasts).toHaveLength(1);
    await expect(handleReceptionIntakeRecipePairGet(
      deps,
      { endpoint_id: ENDPOINT_ID },
      CALLER,
    )).resolves.toMatchObject({ status: 'stale' });
  });

  it('refuses clock exhaustion without corrupting or replacing the durable pair', async () => {
    const { deps, pairs, recipes, rows, broadcasts } = buildFixture();
    const originalRecipe = recipe();
    const originalBinding = receptionPairBinding({
      form_config: formConfig(),
      recipe: originalRecipe,
      seller_offer_id: null,
    });
    if (!originalBinding) throw new Error('test pair binding was not derived');
    pairs.upsert({
      endpoint_id: ENDPOINT_ID,
      binding: originalBinding,
      now: Number.MAX_SAFE_INTEGER,
    });
    recipes.set(RECIPE_ID, recipe({ ttl: 301 }));

    await expect(bind(deps, Number.MAX_SAFE_INTEGER)).rejects.toMatchObject({
      code: 'intake_recipe_pair_invalid',
      status: 409,
    });
    expect(pairs.findByEndpoint(ENDPOINT_ID)).toMatchObject({
      binding: originalBinding,
      updated_at: Number.MAX_SAFE_INTEGER,
    });
    expect(rows).toHaveLength(0);
    expect(broadcasts).toHaveLength(0);
  });

  it('fails before storage on missing, invalid, or pair-incompatible saved sources', async () => {
    const { deps, pairs, recipes, setRecipeRead } = buildFixture();
    await expect(bind(deps)).rejects.toMatchObject({
      code: 'intake_recipe_pair_recipe_not_found',
      status: 404,
    });

    recipes.set(RECIPE_ID, recipe({
      metadata: { name: '' } as RecipeDefinition['metadata'],
    }));
    await expect(bind(deps)).rejects.toMatchObject({
      code: 'intake_recipe_pair_recipe_invalid',
      status: 422,
    });

    recipes.set(RECIPE_ID, recipe({ recipe_id: 'different-saved-recipe' }));
    await expect(bind(deps)).rejects.toMatchObject({
      code: 'intake_recipe_pair_recipe_invalid',
      status: 422,
    });

    setRecipeRead(() => {
      throw new Error('corrupt saved bytes');
    });
    await expect(bind(deps)).rejects.toMatchObject({
      code: 'intake_recipe_pair_recipe_invalid',
      status: 422,
    });
    expect(pairs.findByEndpoint(ENDPOINT_ID)).toBeNull();

    const incompatible = buildFixture({
      config: formConfig({ required_visitor_fields: { email: 'optional' } }),
    });
    incompatible.recipes.set(RECIPE_ID, recipe());
    await expect(bind(incompatible.deps)).rejects.toMatchObject({
      code: 'intake_recipe_pair_incompatible',
      status: 422,
    });
    expect(incompatible.pairs.findByEndpoint(ENDPOINT_ID)).toBeNull();
  });

  it('rejects missing, wrong-kind, revoked, and form-source-drifted endpoints', async () => {
    const missing = buildFixture();
    missing.recipes.set(RECIPE_ID, recipe());
    await expect(handleReceptionIntakeRecipePairBind(missing.deps, {
      endpoint_id: 'ep-missing',
      recipe_id: RECIPE_ID,
      expected_updated_at: null,
    }, CALLER)).rejects.toMatchObject({ code: 'endpoint_not_found', status: 404 });

    // D-210 R-2 slice 4 — `scheduling_link` is NO LONGER a wrong kind: the booking drain
    // runs its pair, so it binds (proved in `d-210-r2-slice4-scheduling-pairable.test.ts`).
    // The refusal now keys on whether anything would RUN the pair, so a kind with no
    // consumer is what must still be refused — otherwise the bind saves a row nothing reads.
    const wrongKind = buildFixture({ endpoint_kind: 'drop_link' });
    wrongKind.recipes.set(RECIPE_ID, recipe());
    await expect(bind(wrongKind.deps)).rejects.toMatchObject({
      code: 'intake_recipe_pair_wrong_endpoint_kind',
      status: 409,
    });

    const revoked = buildFixture();
    revoked.recipes.set(RECIPE_ID, recipe());
    revoked.endpoints.revoke({ endpoint_id: ENDPOINT_ID, now: NOW, reason: null });
    await expect(bind(revoked.deps)).rejects.toMatchObject({
      code: 'endpoint_already_revoked',
      status: 409,
    });

    const drifted = buildFixture({ source_form_definition_id: 'other-form' });
    drifted.recipes.set(RECIPE_ID, recipe());
    await expect(bind(drifted.deps)).rejects.toMatchObject({
      code: 'intake_recipe_pair_incompatible',
      status: 422,
    });

    const wrongPacket = buildFixture();
    wrongPacket.recipes.set(RECIPE_ID, recipe());
    wrongPacket.db.prepare(`
      UPDATE public_endpoint_registry SET packet_declaration = ?
      WHERE endpoint_id = ?
    `).run(JSON.stringify({
      packet_kind: 'scheduling_link_packet',
      source_query_ref: {
        kind: 'reception_form_definition',
        form_definition_id: FORM_DEFINITION_ID,
      },
    }), ENDPOINT_ID);
    await expect(bind(wrongPacket.deps)).rejects.toMatchObject({
      code: 'intake_recipe_pair_incompatible',
      status: 422,
    });
  });

  it('reports valid source drift as stale and corrupt stored bytes as non-authoritative stale', async () => {
    const { db, deps, recipes } = buildFixture();
    recipes.set(RECIPE_ID, recipe());
    const created = await bind(deps);
    recipes.set(RECIPE_ID, recipe({ ttl: 301 }));

    await expect(handleReceptionIntakeRecipePairGet(
      deps,
      { endpoint_id: ENDPOINT_ID },
      CALLER,
    )).resolves.toEqual({
      endpoint_id: ENDPOINT_ID,
      status: 'stale',
      binding: created.pair.binding,
      created_at: created.pair.created_at,
      updated_at: created.pair.updated_at,
    });

    recipes.delete(RECIPE_ID);
    await expect(handleReceptionIntakeRecipePairGet(
      deps,
      { endpoint_id: ENDPOINT_ID },
      CALLER,
    )).resolves.toEqual({
      endpoint_id: ENDPOINT_ID,
      status: 'stale',
      binding: created.pair.binding,
      created_at: created.pair.created_at,
      updated_at: created.pair.updated_at,
    });

    db.prepare(`
      UPDATE reception_intake_recipe_pair SET binding_blob = 'not-json'
      WHERE endpoint_id = ?
    `).run(ENDPOINT_ID);
    await expect(handleReceptionIntakeRecipePairGet(
      deps,
      { endpoint_id: ENDPOINT_ID },
      CALLER,
    )).resolves.toEqual({
      endpoint_id: ENDPOINT_ID,
      status: 'stale',
      binding: null,
      created_at: null,
      updated_at: null,
    });
  });

  it('clears idempotently, audits only the real mutation, and recovers corrupt rows', async () => {
    const { db, deps, pairs, recipes, rows, broadcasts } = buildFixture();
    recipes.set(RECIPE_ID, recipe());
    await bind(deps);
    db.prepare(`
      UPDATE reception_intake_recipe_pair SET binding_blob = 'not-json'
      WHERE endpoint_id = ?
    `).run(ENDPOINT_ID);

    await expect(bind(deps, NOW)).rejects.toMatchObject({
      code: 'intake_recipe_pair_stored_invalid',
      status: 409,
    });

    const corruptView = await handleReceptionIntakeRecipePairGet(
      deps,
      { endpoint_id: ENDPOINT_ID },
      CALLER,
    );
    expect(corruptView).toMatchObject({ status: 'stale', binding: null });
    const clearInput = clearInputFromView(corruptView);

    await expect(handleReceptionIntakeRecipePairClear(
      deps,
      clearInput,
      CALLER,
    )).resolves.toEqual({ removed: true });
    await expect(handleReceptionIntakeRecipePairClear(
      deps,
      clearInput,
      CALLER,
    )).resolves.toEqual({ removed: false });
    expect(pairs.findByEndpoint(ENDPOINT_ID)).toBeNull();
    expect(rows.map((row) => row.action)).toEqual([
      'reception.intake_recipe_pair.bound',
      'reception.intake_recipe_pair.cleared',
    ]);
    // D-207 slice 1c — a CORRUPT pair row still had a live door, and the clear shuts it.
    // The contract id is its own column, readable even when the binding blob is garbage
    // (`readContractId`), so recovering a broken row revokes the public's grants instead of
    // orphaning them. `findByEndpoint` would have thrown here and taken the recovery with it.
    expect(rows[1]?.detail).toBe('removed=true, stored_invalid=true, door_retired=true');
    expect(broadcasts.flatMap((event) =>
      event.kind === 'reception.endpoint_changed' ? [event.op] : [],
    )).toEqual(['pair_bind', 'pair_clear']);
    await expect(handleReceptionIntakeRecipePairGet(
      deps,
      { endpoint_id: ENDPOINT_ID },
      CALLER,
    )).resolves.toMatchObject({ status: 'unpaired', binding: null });
  });

  it('conflicts instead of clearing a concurrently rebound pair and records the cleared locator', async () => {
    const { deps, pairs, recipes, rows, broadcasts } = buildFixture();
    recipes.set(RECIPE_ID, recipe());
    const first = await bind(deps);
    const staleClear = clearInputFromView(first.pair);
    recipes.set(RECIPE_ID, recipe({ ttl: 301 }));
    const rebound = await bind(deps, first.pair.updated_at);

    await expect(handleReceptionIntakeRecipePairClear(
      deps,
      staleClear,
      CALLER,
    )).rejects.toMatchObject({
      code: 'intake_recipe_pair_conflict',
      status: 409,
      details: {
        current_updated_at: rebound.pair.updated_at,
        current_pair_revision: rebound.pair.binding.pair_revision,
        current_invalid: false,
      },
    });
    expect(pairs.findByEndpoint(ENDPOINT_ID)?.binding)
      .toEqual(rebound.pair.binding);
    expect(rows.map((row) => row.action)).toEqual([
      'reception.intake_recipe_pair.bound',
      'reception.intake_recipe_pair.bound',
    ]);
    expect(broadcasts.flatMap((event) =>
      event.kind === 'reception.endpoint_changed' ? [event.op] : [],
    )).toEqual(['pair_bind', 'pair_bind']);

    await expect(handleReceptionIntakeRecipePairClear(
      deps,
      clearInputFromView(rebound.pair),
      CALLER,
    )).resolves.toEqual({ removed: true });
    expect(rows[2]).toMatchObject({
      action: 'reception.intake_recipe_pair.cleared',
      // D-207 slice 1c — clearing a pair also RETIRES its door. The audit says so: the
      // public losing its grants is the whole point of the clear, not a side effect.
      detail: `removed=true, recipe_id=${RECIPE_ID}, recipe_version=3, pair_revision=${rebound.pair.binding.pair_revision}, door_retired=true`,
    });

    const reboundAgain = await bind(deps, null);
    await expect(handleReceptionIntakeRecipePairClear(
      deps,
      clearInputFromView(reboundAgain.pair),
      CALLER,
    )).resolves.toEqual({ removed: true });
    const clearRows = rows.filter(
      (row) => row.action === 'reception.intake_recipe_pair.cleared',
    );
    expect(clearRows).toHaveLength(2);
    expect(new Set(clearRows.map((row) => row.activity_id)).size).toBe(2);
  });

  it('does not let an unpaired observation become corrupt-row clear authority', async () => {
    const { db, deps, recipes } = buildFixture();
    const unpaired = await handleReceptionIntakeRecipePairGet(
      deps,
      { endpoint_id: ENDPOINT_ID },
      CALLER,
    );
    expect(unpaired.status).toBe('unpaired');
    recipes.set(RECIPE_ID, recipe());
    await bind(deps);
    db.prepare(`
      UPDATE reception_intake_recipe_pair SET binding_blob = 'not-json'
      WHERE endpoint_id = ?
    `).run(ENDPOINT_ID);

    await expect(handleReceptionIntakeRecipePairClear(
      deps,
      clearInputFromView(unpaired),
      CALLER,
    )).rejects.toMatchObject({
      code: 'intake_recipe_pair_conflict',
      status: 409,
      details: { current_invalid: true },
    });
    expect(db.prepare(`
      SELECT binding_blob FROM reception_intake_recipe_pair WHERE endpoint_id = ?
    `).get(ENDPOINT_ID)).toEqual({ binding_blob: 'not-json' });
  });

  it('normalizes legacy recipe output on a clone without mutating RecipeStore state', async () => {
    const { deps, recipes } = buildFixture();
    const legacy = recipe({
      output: { sidebar: [] },
    });
    recipes.set(RECIPE_ID, legacy);

    const result = await bind(deps);

    expect(result.pair.status).toBe('ready');
    expect(legacy.output).toEqual({ sidebar: [] });
    await expect(handleReceptionIntakeRecipePairGet(
      deps,
      { endpoint_id: ENDPOINT_ID },
      CALLER,
    )).resolves.toMatchObject({ status: 'ready' });
    expect(legacy.output).toEqual({ sidebar: [] });
  });

  it('CAS-writes only claim configuration on an exact editable local recipe and leaves the pair stale for explicit rebind', async () => {
    const {
      deps,
      endpoints,
      pairs,
      recipeStore,
      rows,
      broadcasts,
    } = buildFixture({ persistent_recipe_store: true });
    const savedRecipe = directSubmitRecipe();
    recipeStore.save(savedRecipe, 'local-owner', 'inline', NOW - 5_000);
    const created = await bind(deps);
    const targetConfiguration = sellerAssociatedClaimConfiguration();
    expect(readyFormPair(created.pair).claim_configuration_authoring).toEqual({ status: 'editable' });
    endpoints.create({
      endpoint_id: 'ep-second-pair',
      kind: 'intake_form',
      packet_declaration: {
        packet_kind: 'intake_form_packet',
        source_query_ref: {
          kind: 'reception_form_definition',
          form_definition_id: FORM_DEFINITION_ID,
        },
      },
      bearer_secret_hmac: Buffer.alloc(32, 0x66),
      created_at: NOW - 500,
      created_by_client_id: CALLER.instance_id,
      expires_at: null,
      long_lived_acknowledged_at: NOW - 500,
      metadata: formConfig() as unknown as Readonly<Record<string, unknown>>,
    });
    pairs.upsert({
      endpoint_id: 'ep-second-pair',
      binding: created.pair.binding,
      now: NOW,
    });
    const before = recipeStore.getStored(RECIPE_ID);

    const configured = await handleReceptionIntakeRecipePairConfigure(deps, {
      endpoint_id: ENDPOINT_ID,
      expected_updated_at: created.pair.updated_at,
      expected_pair_revision: created.pair.binding.pair_revision,
      configuration: targetConfiguration,
    }, CALLER);

    expect(configured).toEqual({
      outcome: 'updated',
      recipe_id: RECIPE_ID,
      pair_requires_rebind: true,
    });
    const after = recipeStore.getStored(RECIPE_ID);
    expect(after).toMatchObject({
      publisher_id: before?.publisher_id,
      source: before?.source,
      installed_at: before?.installed_at,
      pack_slug: null,
      version: savedRecipe.version,
    });
    const afterRecipe = JSON.parse(after?.recipe_json ?? 'null') as RecipeDefinition;
    expect(afterRecipe).toEqual({
      ...savedRecipe,
      metadata: {
        ...savedRecipe.metadata,
        paid_document_direct_checkout: targetConfiguration,
      },
    });
    expect(pairs.findByEndpoint(ENDPOINT_ID)?.binding).toEqual(created.pair.binding);
    await expect(handleReceptionIntakeRecipePairGet(
      deps,
      { endpoint_id: ENDPOINT_ID },
      CALLER,
    )).resolves.toEqual({
      endpoint_id: ENDPOINT_ID,
      status: 'stale',
      binding: created.pair.binding,
      created_at: created.pair.created_at,
      updated_at: created.pair.updated_at,
    });
    expect(rows.map((row) => row.action)).toEqual([
      'reception.intake_recipe_pair.bound',
      'reception.intake_recipe_pair.configured',
    ]);
    expect(rows[1]?.detail).toMatch(
      /^recipe_id=research-brief-checkout, prior_recipe_hash=[0-9a-f]{8}, recipe_hash=[0-9a-f]{8}, affected_pair_count=2$/,
    );
    expect(rows[1]?.detail).not.toContain('stripe-primary');
    expect(rows[1]?.detail).not.toContain('owner.example');
    expect(rows[1]?.detail).not.toContain('research-brief.fulfilled');
    expect(broadcasts.flatMap((event) =>
      event.kind === 'reception.endpoint_changed' ? [event.op] : [],
    )).toEqual(['pair_bind', 'pair_configure', 'pair_configure']);
    expect(broadcasts.at(-1)).toEqual({
      kind: 'reception.endpoint_changed',
      op: 'pair_configure',
      endpoint_id: 'ep-second-pair',
    });
    expect(endpoints.findById(ENDPOINT_ID)?.audit_count).toBe(2);

    const rebound = await bind(deps, created.pair.updated_at);
    expect(rebound).toMatchObject({
      outcome: 'updated',
      pair: {
        status: 'ready',
        claim_configuration_authoring: { status: 'editable' },
        claim_configuration_readiness: {
          status: 'blocked',
          configuration: targetConfiguration,
        },
      },
    });
    expect(rebound.pair.binding).toMatchObject({
      version: 2,
      seller_offer_id: 'research-brief.fulfilled',
    });
    expect(rebound.pair.binding.pair_revision).toMatch(/^d200-pair-v2-[a-f0-9]{64}$/);
    expect(rebound.pair.binding.pair_revision).not.toBe(
      created.pair.binding.pair_revision,
    );
  });

  it('treats an exact configuration replay as unchanged without audit, broadcast, or rebind churn', async () => {
    const { deps, recipeStore, rows, broadcasts } = buildFixture({
      persistent_recipe_store: true,
    });
    const configuredRecipe = directSubmitRecipe();
    configuredRecipe.metadata = {
      ...configuredRecipe.metadata,
      paid_document_direct_checkout: claimConfiguration(),
    };
    recipeStore.save(configuredRecipe, 'local-owner', 'inline', NOW - 1_000);
    const created = await bind(deps);
    const auditCount = rows.length;
    const broadcastCount = broadcasts.length;
    const recipeJson = recipeStore.getStored(RECIPE_ID)?.recipe_json;

    await expect(handleReceptionIntakeRecipePairConfigure(deps, {
      endpoint_id: ENDPOINT_ID,
      expected_updated_at: created.pair.updated_at,
      expected_pair_revision: created.pair.binding.pair_revision,
      configuration: claimConfiguration(),
    }, CALLER)).resolves.toEqual({
      outcome: 'unchanged',
      recipe_id: RECIPE_ID,
      pair_requires_rebind: false,
    });

    expect(recipeStore.getStored(RECIPE_ID)?.recipe_json).toBe(recipeJson);
    expect(rows).toHaveLength(auditCount);
    expect(broadcasts).toHaveLength(broadcastCount);
    await expect(handleReceptionIntakeRecipePairGet(
      deps,
      { endpoint_id: ENDPOINT_ID },
      CALLER,
    )).resolves.toMatchObject({ status: 'ready' });
  });

  it('projects pack ownership as fork-required and never clears provenance through configuration', async () => {
    const { deps, recipeStore, rows, broadcasts } = buildFixture({
      persistent_recipe_store: true,
    });
    const savedRecipe = directSubmitRecipe();
    recipeStore.save(savedRecipe, 'pack-publisher', 'pair-sync', NOW - 1_000, 'pack-owned');
    const created = await bind(deps);
    expect(readyFormPair(created.pair).claim_configuration_authoring).toEqual({
      status: 'fork_required',
    });

    await expect(handleReceptionIntakeRecipePairConfigure(deps, {
      endpoint_id: ENDPOINT_ID,
      expected_updated_at: created.pair.updated_at,
      expected_pair_revision: created.pair.binding.pair_revision,
      configuration: claimConfiguration(),
    }, CALLER)).rejects.toMatchObject({
      code: 'intake_recipe_pair_recipe_not_editable',
      status: 409,
    });
    expect(recipeStore.getStored(RECIPE_ID)).toMatchObject({
      publisher_id: 'pack-publisher',
      pack_slug: 'pack-owned',
      recipe_json: JSON.stringify(savedRecipe),
    });
    expect(rows.map((row) => row.action)).toEqual([
      'reception.intake_recipe_pair.bound',
    ]);
    expect(broadcasts).toHaveLength(1);
  });

  it.each([
    ['full recipe', { recipe: directSubmitRecipe() }],
    ['recipe id', { recipe_id: RECIPE_ID }],
    ['pack authority', { pack_slug: 'pack-owned' }],
    ['publisher authority', { publisher_id: 'publisher' }],
    ['commerce terms', { amount_minor: 99_999, currency: 'usd' }],
  ])('rejects configure caller-supplied %s before touching the recipe', async (_label, extra) => {
    const { deps, recipeStore, rows, broadcasts } = buildFixture({
      persistent_recipe_store: true,
    });
    recipeStore.save(directSubmitRecipe(), 'local-owner', 'inline', NOW - 1_000);
    const created = await bind(deps);
    const before = recipeStore.getStored(RECIPE_ID)?.recipe_json;

    await expect(handleReceptionIntakeRecipePairConfigure(deps, {
      endpoint_id: ENDPOINT_ID,
      expected_updated_at: created.pair.updated_at,
      expected_pair_revision: created.pair.binding.pair_revision,
      configuration: claimConfiguration(),
      ...extra,
    } as never, CALLER)).rejects.toMatchObject({
      code: 'intake_recipe_pair_invalid',
      status: 400,
    });
    expect(recipeStore.getStored(RECIPE_ID)?.recipe_json).toBe(before);
    expect(rows).toHaveLength(1);
    expect(broadcasts).toHaveLength(1);
  });

  it('rejects stale pair observations and malformed configuration before a local write', async () => {
    const { deps, recipeStore, rows, broadcasts } = buildFixture({
      persistent_recipe_store: true,
    });
    recipeStore.save(directSubmitRecipe(), 'local-owner', 'inline', NOW - 1_000);
    const created = await bind(deps);
    const before = recipeStore.getStored(RECIPE_ID)?.recipe_json;

    await expect(handleReceptionIntakeRecipePairConfigure(deps, {
      endpoint_id: ENDPOINT_ID,
      expected_updated_at: created.pair.updated_at,
      expected_pair_revision: `d200-pair-v1-${'b'.repeat(64)}`,
      configuration: claimConfiguration(),
    }, CALLER)).rejects.toMatchObject({
      code: 'intake_recipe_pair_conflict',
      status: 409,
    });
    await expect(handleReceptionIntakeRecipePairConfigure(deps, {
      endpoint_id: ENDPOINT_ID,
      expected_updated_at: created.pair.updated_at,
      expected_pair_revision: created.pair.binding.pair_revision,
      configuration: {
        ...claimConfiguration(),
        success_url: 'http://not-https.example',
      },
    }, CALLER)).rejects.toMatchObject({
      code: 'intake_recipe_pair_invalid',
      status: 400,
    });
    expect(recipeStore.getStored(RECIPE_ID)?.recipe_json).toBe(before);
    expect(rows).toHaveLength(1);
    expect(broadcasts).toHaveLength(1);
  });

  it('refuses an observed pair after its effective local recipe source drifts', async () => {
    const { deps, recipeStore, rows, broadcasts } = buildFixture({
      persistent_recipe_store: true,
    });
    const original = directSubmitRecipe();
    recipeStore.save(original, 'local-owner', 'inline', NOW - 1_000);
    const created = await bind(deps);
    const drifted = { ...original, ttl: original.ttl + 1 };
    recipeStore.save(drifted, 'local-owner', 'inline', NOW);

    await expect(handleReceptionIntakeRecipePairConfigure(deps, {
      endpoint_id: ENDPOINT_ID,
      expected_updated_at: created.pair.updated_at,
      expected_pair_revision: created.pair.binding.pair_revision,
      configuration: claimConfiguration(),
    }, CALLER)).rejects.toMatchObject({
      code: 'intake_recipe_pair_conflict',
      status: 409,
    });
    expect(recipeStore.get(RECIPE_ID)).toEqual(drifted);
    expect(recipeStore.get(RECIPE_ID)?.metadata).not.toHaveProperty(
      'paid_document_direct_checkout',
    );
    expect(rows.map((row) => row.action)).toEqual([
      'reception.intake_recipe_pair.bound',
    ]);
    expect(broadcasts).toHaveLength(1);
  });
});
