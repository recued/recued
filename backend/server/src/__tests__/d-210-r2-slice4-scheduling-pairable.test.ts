/** D-210 R-2 slice 4 — a `scheduling_link` endpoint is PAIRABLE.
 *
 *  This is the switch slice 3b was inert without. Until now `requireIntakeEndpoint` 409'd
 *  every non-`intake_form` kind out of the pair rpcs, so a booking page could never carry a
 *  door: the booking flow ran the pack's compiled recipe with no contract, no grants and no
 *  dish — everything D-207/D-209 built, structurally excluded by one RPC branch (D-210 §3).
 *
 *  The properties under test:
 *    - a booking page BINDS, mints a door, and persists a v3 (scheduling) binding,
 *    - the ready view carries `pair_subject: 'scheduling'` and NO claim configuration,
 *    - the digest subject is the owner's: editing `required_visitor_fields` stales the pair,
 *      editing a DURATION does not,
 *    - `get` and `clear` accept a booking page too — a bind you cannot see or undo is worse
 *      than no bind,
 *    - ⛔ `configure` still REFUSES it (a claim is an intake form's concept),
 *    - ⛔ a kind with no consumer is still refused — the rule is "something runs this pair",
 *      not "any endpoint".
 *
 *  Drives the REAL rpc handlers over an in-memory DB with the real stores + derivers. */

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import {
  receptionSchedulingPairBinding,
  RECEPTION_SCHEDULING_PAIR_REVISION_PREFIX,
  type ContractDefinition,
  type RecipeDefinition,
  type SchedulingLinkConfig,
} from '@recued/contracts';
import type { ActivityEntry, AuditLogStore } from '@recued/storage';
import {
  handleReceptionIntakeRecipePairBind,
  handleReceptionIntakeRecipePairClear,
  handleReceptionIntakeRecipePairConfigure,
  handleReceptionIntakeRecipePairGet,
  type ReceptionRpcDeps,
} from '../reception-rpc-handler.js';
import type { ReceptionDoorBindDeps } from '../reception-door-bind.js';
import { createPublicEndpointRegistryStore } from '../storage/public-endpoint-registry-store.js';
import type { ContractDefinitionStore } from '../storage/contract-definition-store.js';
import type { ContractGrantEntryStore } from '../storage/contract-grant-entry-store.js';
import { createReceptionIntakeRecipePairStore } from '../storage/reception-intake-recipe-pair-store.js';
import { ensureReceptionSchema } from '../storage/reception-store.js';
import type { RecipeStore } from '../recipe-store.js';

const NOW = 1_700_000_000_000;
const ENDPOINT_ID = 'ep-booking';
const RECIPE_ID = 'booking-handler';
const CALLER = { instance_id: 'owner-client' };

const VISITOR_FIELDS: SchedulingLinkConfig['required_visitor_fields'] = {
  name: 'required',
  email: 'required',
  topic: 'optional',
  phone: 'omit',
  notes: 'omit',
};

const schedulingConfig = (over: Partial<SchedulingLinkConfig> = {}): SchedulingLinkConfig => ({
  display_name: 'Mary Smith',
  duration_options_minutes: [30],
  available_window_definition: {
    tz: 'America/New_York',
    explicit_windows: [{ day_of_week: 1, start_minute: 0, end_minute: 1440 }],
  },
  required_visitor_fields: VISITOR_FIELDS,
  min_advance_notice_hours: 1,
  max_lead_time_days: 30,
  max_bookings_per_day: 0,
  on_booking: {
    create_calendar_event: true,
    create_commitment_entity: true,
  },
  ...over,
});

const recipe = (over: Partial<RecipeDefinition> = {}): RecipeDefinition => ({
  recipe_id: RECIPE_ID,
  version: 3,
  ttl: 300,
  metadata: {
    name: 'Booking handler',
    description: 'Handles a booking.',
    author: 'local-author',
    supported_platforms: [],
  },
  variables: {},
  prefetch_steps: [],
  steps: [],
  output: { render: [] },
  ...over,
} as unknown as RecipeDefinition);

const buildFixture = (input: {
  readonly config?: SchedulingLinkConfig;
  readonly endpoint_kind?: 'scheduling_link' | 'drop_link';
} = {}) => {
  const db = new Database(':memory:');
  ensureReceptionSchema(db);
  const realEndpoints = createPublicEndpointRegistryStore(db);
  const pairs = createReceptionIntakeRecipePairStore(db);
  const recipes = new Map<string, RecipeDefinition>();
  const rows: ActivityEntry[] = [];
  const kind = input.endpoint_kind ?? 'scheduling_link';
  const config = input.config ?? schedulingConfig();
  realEndpoints.create({
    endpoint_id: ENDPOINT_ID,
    kind,
    packet_declaration: kind === 'scheduling_link'
      ? {
          packet_kind: 'scheduling_link_packet',
          source_query_ref: { kind: 'data.calendar.combined' },
        }
      : {
          packet_kind: 'drop_link_packet',
          source_query_ref: { kind: 'reception_drop_config', drop_config_id: 'drop_1' },
        },
    bearer_secret_hmac: Buffer.alloc(32, 0x44),
    created_at: NOW - 1_000,
    created_by_client_id: CALLER.instance_id,
    expires_at: null,
    long_lived_acknowledged_at: NOW - 1_000,
    metadata: config as unknown as Readonly<Record<string, unknown>>,
  });

  // ⚠ The registry store has NO update method — an endpoint's config is written at create.
  // An earlier draft reached for `endpoints.updateMetadata?.(...)`, which optional-chained
  // into NOTHING: the config never changed, so the "a duration does not stale it" assertion
  // passed while proving nothing at all. Overriding the READ is the honest way to drive an
  // owner's config edit here. [[a_green_test_over_a_hollow_seam]]
  let currentConfig: unknown = config;
  const endpoints = {
    ...realEndpoints,
    findById: (id: string) => {
      const row = realEndpoints.findById(id);
      return row === null
        ? null
        : { ...row, metadata: currentConfig as Readonly<Record<string, unknown>> };
    },
  } as typeof realEndpoints;
  const setConfig = (next: unknown): void => { currentConfig = next; };

  const definitions = new Map<string, ContractDefinition>();
  let doorSeq = 0;
  const definitionStore = {
    get: (id: string) => definitions.get(id) ?? null,
    mint: (def: Omit<ContractDefinition, 'contract_id'>) => {
      doorSeq += 1;
      const contract_id = `door_${doorSeq}`;
      const full = { ...def, contract_id } as ContractDefinition;
      definitions.set(contract_id, full);
      return full;
    },
    revoke: () => true,
  } as unknown as ContractDefinitionStore;
  const grantEntryStore = {
    listForContract: () => [],
    replaceForContract: () => undefined,
  } as unknown as ContractGrantEntryStore;

  const doorBindDeps: ReceptionDoorBindDeps = {
    pairStore: pairs,
    definitionStore,
    grantEntryStore,
    now: () => NOW,
    resolveConfig: () => ({}),
  };

  const recipeStore = { get: (id: string) => recipes.get(id) ?? null } as RecipeStore;
  const deps = {
    getStore: () => endpoints,
    getIntakeRecipePairStore: () => pairs,
    getRecipeStore: () => recipeStore,
    getDoorBindDeps: () => doorBindDeps,
    auditLog: {
      logActivity: async (entry: ActivityEntry) => { rows.push(entry); },
    } as unknown as AuditLogStore,
    now: () => NOW,
    broadcast: () => undefined,
  } as unknown as ReceptionRpcDeps;

  return { deps, endpoints, pairs, recipes, rows, setConfig };
};

const bind = (deps: ReceptionRpcDeps, expected_updated_at: number | null = null) =>
  handleReceptionIntakeRecipePairBind(deps, {
    endpoint_id: ENDPOINT_ID,
    recipe_id: RECIPE_ID,
    expected_updated_at,
  }, CALLER);

describe('D-210 R-2 slice 4 — a booking page can carry a door', () => {
  it('binds, mints a door, and persists a v3 scheduling binding', async () => {
    const { deps, pairs, recipes } = buildFixture();
    const saved = recipe();
    recipes.set(RECIPE_ID, saved);
    const expected = receptionSchedulingPairBinding({
      required_visitor_fields: VISITOR_FIELDS,
      recipe: saved,
    });
    expect(expected).not.toBeNull();

    const created = await bind(deps);

    expect(created.outcome).toBe('created');
    expect(created.door.status).toBe('bound');
    // The pair row IS the `reception_id → contract_id` hop the drain resolves the door by.
    expect(pairs.findByEndpoint(ENDPOINT_ID)?.contract_id).toBe('door_1');
    // A REAL v3 binding — not a form pair that happens to sit on a booking endpoint.
    expect(pairs.findByEndpoint(ENDPOINT_ID)?.binding).toEqual(expected);
    expect(expected!.pair_revision.startsWith(RECEPTION_SCHEDULING_PAIR_REVISION_PREFIX))
      .toBe(true);
    // ⛔ A v3 carries no form id. A pair minted by something that thinks scheduling has a
    // form would be evidence of exactly the confusion slice 2 refused.
    expect(pairs.findByEndpoint(ENDPOINT_ID)?.binding)
      .not.toHaveProperty('form_definition_id');
  });

  it('the ready view names the scheduling subject and carries NO claim configuration', async () => {
    const { deps, recipes } = buildFixture();
    recipes.set(RECIPE_ID, recipe());
    await bind(deps);

    const view = await handleReceptionIntakeRecipePairGet(
      deps,
      { endpoint_id: ENDPOINT_ID },
      CALLER,
    );
    expect(view.status).toBe('ready');
    if (view.status !== 'ready') throw new Error('expected ready');
    expect(view.pair_subject).toBe('scheduling');
    // ⛔ A claim is a property of an intake form's FIELDS. A booking page has none, so the
    // view must not carry the field at all rather than carry an empty one.
    expect(view).not.toHaveProperty('claim_configuration_readiness');
    expect(view).not.toHaveProperty('claim_configuration_authoring');
  });

  it("the digest subject is the OWNER's: visitor fields stale the pair, a duration does not", async () => {
    const { deps, recipes, setConfig } = buildFixture();
    recipes.set(RECIPE_ID, recipe());
    await bind(deps);

    // A cosmetic edit — what the VISITOR sees, never what the recipe receives.
    setConfig(schedulingConfig({ duration_options_minutes: [30, 60] }));
    const afterDuration = await handleReceptionIntakeRecipePairGet(
      deps,
      { endpoint_id: ENDPOINT_ID },
      CALLER,
    );
    expect(afterDuration.status).toBe('ready');

    // Turning the phone field on changes what the paired recipe RECEIVES — the one edit the
    // owner ruled the digest exists to catch.
    setConfig(schedulingConfig({
      required_visitor_fields: { ...VISITOR_FIELDS, phone: 'required' },
    }));
    const afterFields = await handleReceptionIntakeRecipePairGet(
      deps,
      { endpoint_id: ENDPOINT_ID },
      CALLER,
    );
    expect(afterFields.status).toBe('stale');
  });

  it('clear accepts a booking page — a bind you cannot undo is worse than no bind', async () => {
    const { deps, pairs, recipes } = buildFixture();
    recipes.set(RECIPE_ID, recipe());
    const created = await bind(deps);
    if (created.pair.status !== 'ready') throw new Error('expected ready');

    const cleared = await handleReceptionIntakeRecipePairClear(deps, {
      endpoint_id: ENDPOINT_ID,
      expected_status: 'ready',
      expected_updated_at: created.pair.updated_at,
      expected_pair_revision: created.pair.binding.pair_revision,
    }, CALLER);
    expect(cleared.removed).toBe(true);
    expect(pairs.findByEndpoint(ENDPOINT_ID)).toBeNull();
  });
});

describe('D-210 R-2 slice 4 — what stays refused', () => {
  it('configure REFUSES a booking page: a claim is an intake form concept', async () => {
    const { deps, recipes } = buildFixture();
    recipes.set(RECIPE_ID, recipe());
    const created = await bind(deps);
    if (created.pair.status !== 'ready') throw new Error('expected ready');

    // ⛔ Widening the SHARED guard would have opened this rpc too — `configure` authors a
    // D-200 claim configuration, which is a property of a form's fields, not of pairing.
    await expect(handleReceptionIntakeRecipePairConfigure(deps, {
      endpoint_id: ENDPOINT_ID,
      expected_updated_at: created.pair.updated_at,
      expected_pair_revision: created.pair.binding.pair_revision,
      // A WELL-FORMED claim configuration: `configure` validates its args before it looks at
      // the endpoint, so junk here would prove only that junk is refused — never that the
      // kind guard held.
      configuration: {
        version: 1,
        stripe_connection_name: 'stripe-primary',
        success_url: 'https://owner.example/ok',
        cancel_url: 'https://owner.example/no',
        expiry_window_ms: 30 * 60 * 1_000,
        template_file_ref: `file:${'a'.repeat(32)}`,
      },
    } as never, CALLER)).rejects.toMatchObject({
      code: 'intake_recipe_pair_wrong_endpoint_kind',
      status: 409,
    });
  });

  it('a kind with NO consumer is still refused — the rule is "something runs this pair"', async () => {
    const { deps, recipes } = buildFixture({ endpoint_kind: 'drop_link' });
    recipes.set(RECIPE_ID, recipe());
    await expect(bind(deps)).rejects.toMatchObject({
      code: 'intake_recipe_pair_wrong_endpoint_kind',
      status: 409,
    });
  });

  it('an unparseable booking config refuses the bind rather than deriving a pair from it', async () => {
    const { deps, recipes } = buildFixture({
      config: { display_name: '' } as unknown as SchedulingLinkConfig,
    });
    recipes.set(RECIPE_ID, recipe());
    await expect(bind(deps)).rejects.toMatchObject({
      code: 'intake_recipe_pair_incompatible',
      status: 422,
    });
  });
});
