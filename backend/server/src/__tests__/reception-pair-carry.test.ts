/** D-299 — a pack update keeps a Reception pair alive unless what it relies on changed.
 *
 *  A form pair pins the exact recipe it was bound to, so any update to that recipe (a bug
 *  fix to one step) left the public form refusing every visitor until the owner re-bound
 *  it. These tests bind a pair through the REAL bind rpc, change the recipe the way an
 *  update does, run the carry, and read the pair back through the REAL get rpc — the
 *  status the form's own consumer reads. The door is the real `bindReceptionDoor`, faked
 *  only at the contract store. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import {
  BULK_INSTALL_PACK_VERSION,
  BULK_PACK_INSTALL_PERMISSION,
  type ContractDefinition,
  type IntakeFormConfig,
  type RecipeDefinition,
} from '@recued/contracts';
import type { BulkPackInstallRecipe } from '@recued/marketplace';

import { writeFileSync } from 'node:fs';

import { installBulkPackOnServer } from '../install-bulk-pack-handler.js';
import { makePackInstallHandlers } from '../pack-install-handler.js';
import { createPreviewHashStore } from '../ports/reception/preview-hash.js';
import type { ReceptionDoorBindDeps } from '../reception-door-bind.js';
import {
  carryReceptionPairs,
  receptionPairParamsChanged,
  receptionPairsAtRisk,
  type ReceptionPairCarryDeps,
} from '../reception-pair-carry.js';
import {
  handleReceptionIntakeRecipePairBind,
  handleReceptionIntakeRecipePairGet,
  type ReceptionRpcDeps,
} from '../reception-rpc-handler.js';
import { createRecipeStore, type RecipeStore } from '../recipe-store.js';
import type { ContractDefinitionStore } from '../storage/contract-definition-store.js';
import type { ContractGrantEntryStore } from '../storage/contract-grant-entry-store.js';
import { createPublicEndpointRegistryStore } from '../storage/public-endpoint-registry-store.js';
import { createReceptionIntakeRecipePairStore } from '../storage/reception-intake-recipe-pair-store.js';
import { ensureReceptionSchema } from '../storage/reception-store.js';

const NOW = 1_700_000_000_000;
const ENDPOINT_ID = 'ep-lead-capture';
const FORM_ID = 'lead-capture-v1';
const RECIPE_ID = 'lead-capture-to-crm';
const CALLER = { instance_id: 'paired-owner-client' };

const formConfig = (): IntakeFormConfig => ({
  display_name: 'Get in touch',
  success_message: 'Thanks — we will be in touch.',
  form_definition: {
    form_definition_id: FORM_ID,
    fields: [
      { name: 'company', type: 'text', label: 'Company', required: true },
      { name: 'note', type: 'textarea', label: 'How can we help?', required: true },
    ],
  },
  submission_processing_rule: {
    target_kind: 'form_response',
    fields_to_include_in_target: [],
    fields_to_attach_as_metadata: [],
  },
  anti_spam: { honeypot_fields: [], rate_limit_per_ip: 5, require_proof_of_work: false, require_captcha: false },
  required_visitor_fields: { email: 'required' },
});

type Field = { name: string; type: string; required: boolean; note?: string };
const FIELDS: Field[] = [
  { name: 'company', type: 'text', required: true },
  { name: 'note', type: 'textarea', required: true },
];

const recipe = (opts: {
  version?: number; ops?: string[]; extra?: boolean; fields?: Field[];
  /** Steps as a pack ships them: bound to the catalog ingredient, as the install requires. */
  concrete?: boolean;
} = {}): RecipeDefinition => ({
  recipe_id: RECIPE_ID,
  version: opts.version ?? 1,
  ttl: 300,
  metadata: {
    name: 'Lead capture → CRM',
    description: 'Files a public enquiry as a CRM contact.',
    author: 'local-author',
    supported_platforms: [],
    requires_form_fields: opts.fields ?? FIELDS,
  },
  variables: { crm: { type: 'connection', label: 'CRM account', default: '' } },
  prefetch_steps: [],
  steps: [
    ...(opts.ops ?? ['create']).map((op) => opts.concrete
      ? { id: `do_${op}`, ingredient: 'crm-catalog', connection: '{{config.crm}}', input: { operation: `contact.${op}`, args: {} } }
      : { id: `do_${op}`, op: `core.crm.contact.${op}` }),
    // A bug fix: one more harmless step, nothing new it may do.
    ...(opts.extra ? [{ id: 'fixed', transform: 'default', value: 'x', fallback: '' }] : []),
  ],
  output: { render: [] },
} as unknown as RecipeDefinition);

const harness = (recipes?: { get(id: string): RecipeDefinition | null }) => {
  let clock = NOW;
  const now = () => (clock += 1);
  const db = new Database(':memory:');
  ensureReceptionSchema(db);
  const endpoints = createPublicEndpointRegistryStore(db);
  const pairs = createReceptionIntakeRecipePairStore(db);
  const saved = new Map<string, RecipeDefinition>();
  endpoints.create({
    endpoint_id: ENDPOINT_ID,
    kind: 'intake_form',
    packet_declaration: {
      packet_kind: 'intake_form_packet',
      source_query_ref: { kind: 'reception_form_definition', form_definition_id: FORM_ID },
    },
    bearer_secret_hmac: Buffer.alloc(32, 0x44),
    created_at: NOW - 1_000,
    created_by_client_id: CALLER.instance_id,
    expires_at: null,
    long_lived_acknowledged_at: NOW - 1_000,
    metadata: formConfig() as unknown as Readonly<Record<string, unknown>>,
  });
  const definitions = new Map<string, ContractDefinition>();
  let seq = 0;
  const door: ReceptionDoorBindDeps = {
    pairStore: pairs,
    definitionStore: {
      mint: (i: Record<string, unknown>) => {
        const d = { contract_id: `door_${++seq}`, minted_at: NOW, ...i } as unknown as ContractDefinition;
        definitions.set(d.contract_id, d);
        return d;
      },
      get: (id: string) => definitions.get(id) ?? null,
      revoke: (id: string) => {
        const d = definitions.get(id);
        if (!d) return null;
        const revoked = { ...d, revoked_at: NOW } as ContractDefinition;
        definitions.set(id, revoked);
        return revoked;
      },
    } as unknown as ContractDefinitionStore,
    grantEntryStore: { set: () => {} } as unknown as ContractGrantEntryStore,
    now,
    resolveConfig: () => ({ crm: 'crm-primary' }),
    resolveDoorRecipe: (input) => ({
      ok: true,
      recipe: {
        ...input,
        steps: input.steps.map((step) => 'op' in step && typeof step.op === 'string' && step.op.startsWith('core.crm.contact.')
          ? {
              id: step.id,
              ingredient: 'crm-catalog',
              connection: '{{config.crm}}',
              input: { operation: `contact.${step.op.slice('core.crm.contact.'.length)}`, args: {} },
            }
          : step),
      },
    }),
    resolveOp: (slug, operation) =>
      slug === 'crm-catalog' && operation.startsWith('contact.') ? [`core.crm.${operation}`] : [],
    resolveIngredientKind: () => 'connection',
  };
  const recipeStore = recipes ?? { get: (id: string) => saved.get(id) ?? null };
  const deps: ReceptionRpcDeps = {
    getStore: () => endpoints,
    getPreviewStore: () => createPreviewHashStore(),
    getPepper: () => Buffer.alloc(32, 0x55),
    getShareBaseUrl: () => 'https://owner.example',
    getIntakeRecipePairStore: () => pairs,
    getRecipeStore: () => recipeStore as RecipeStore,
    getDoorBindDeps: () => door,
    auditLog: { logActivity: async () => {} } as never,
    broadcast: () => {},
    now,
  };
  const carry: ReceptionPairCarryDeps = { endpoints, pairs, door, now };
  const bind = (opts: { standing?: boolean } = {}) =>
    handleReceptionIntakeRecipePairBind(deps, {
      endpoint_id: ENDPOINT_ID,
      recipe_id: RECIPE_ID,
      expected_updated_at: null,
      confirm_capability: true,
      ...(opts.standing ? { standing_closure: true } : {}),
    }, CALLER);
  const status = async () =>
    (await handleReceptionIntakeRecipePairGet(deps, { endpoint_id: ENDPOINT_ID }, CALLER)).status;
  return { db, endpoints, pairs, definitions, saved, carry, bind, status };
};

/** Install `before`, bind the pair, then change the recipe to `after` as an update does. */
const updated = async (before: RecipeDefinition, after: RecipeDefinition, opts: { standing?: boolean } = {}) => {
  const h = harness();
  h.saved.set(RECIPE_ID, before);
  await h.bind(opts);
  expect(await h.status()).toBe('ready');
  const doorBefore = h.pairs.findByEndpoint(ENDPOINT_ID)!.contract_id;
  const doorsMinted = h.definitions.size;
  const change = [{ recipe_id: RECIPE_ID, before, after }];
  const warned = receptionPairsAtRisk(change, h.carry);
  h.saved.set(RECIPE_ID, after);
  const outcomes = carryReceptionPairs(change, h.carry);
  return { h, warned, outcomes, doorBefore, doorsMinted };
};

describe('carryReceptionPairs — the pair an update may keep, and the one it may not', () => {
  it('⛔ a bug-fix update keeps the form taking submissions, behind the same door', async () => {
    const { h, warned, outcomes, doorBefore, doorsMinted } =
      await updated(recipe(), recipe({ version: 2, extra: true }));
    expect(warned).toEqual([]);
    expect(outcomes).toEqual([{ endpoint_id: ENDPOINT_ID, recipe_id: RECIPE_ID, outcome: 'carried' }]);
    expect(await h.status()).toBe('ready');
    expect(h.pairs.findByEndpoint(ENDPOINT_ID)!.contract_id).toBe(doorBefore);
    expect(h.definitions.size).toBe(doorsMinted);
  });

  it('a changed parameter stops it for the owner to re-enable — and the warning said so', async () => {
    const { h, warned, outcomes } = await updated(
      recipe(),
      recipe({ version: 2, fields: [...FIELDS, { name: 'phone', type: 'text', required: true }] }),
    );
    expect(warned).toEqual([{ endpoint_id: ENDPOINT_ID, name: 'Get in touch', recipe_id: RECIPE_ID, reason: 'params_changed' }]);
    expect(outcomes).toEqual([{ endpoint_id: ENDPOINT_ID, recipe_id: RECIPE_ID, outcome: 'params_changed' }]);
    expect(await h.status()).toBe('stale');
  });

  it('an author\'s note on a field is not a parameter', async () => {
    const { h, outcomes } = await updated(
      recipe(),
      recipe({ version: 2, fields: [{ ...FIELDS[0]!, note: 'Now explained.' }, FIELDS[1]!] }),
    );
    expect(outcomes.map((o) => o.outcome)).toEqual(['carried']);
    expect(await h.status()).toBe('ready');
  });

  it('⛔ a door that would need MORE authority waits for the owner: nothing minted, form stopped', async () => {
    const { h, warned, outcomes, doorBefore, doorsMinted } =
      await updated(recipe(), recipe({ version: 2, ops: ['create', 'update'] }));
    expect(warned.map((w) => w.reason)).toEqual(['needs_owner']);
    expect(outcomes.map((o) => o.outcome)).toEqual(['needs_owner']);
    expect(await h.status()).toBe('stale');
    expect(h.pairs.findByEndpoint(ENDPOINT_ID)!.contract_id).toBe(doorBefore);
    expect(h.definitions.size).toBe(doorsMinted);
  });

  it('a narrower door is re-minted without asking, and keeps the owner\'s standing approval', async () => {
    const { h, warned, outcomes, doorBefore } =
      await updated(recipe({ ops: ['create', 'update'] }), recipe({ version: 2, ops: ['create'] }), { standing: true });
    expect(warned).toEqual([]);
    expect(outcomes.map((o) => o.outcome)).toEqual(['carried']);
    expect(await h.status()).toBe('ready');
    const door = h.pairs.findByEndpoint(ENDPOINT_ID)!.contract_id!;
    expect(door).not.toBe(doorBefore);
    const policy = (h.definitions.get(door) as { door_execution_policy?: { standing_closure?: boolean } })
      .door_execution_policy;
    expect(policy?.standing_closure).toBe(true);
    expect(h.definitions.get(door)?.scope.operation_ids).toEqual(['core.crm.contact.create']);
  });

  it('a pair already stale before the update is the owner\'s to fix, and is left alone', async () => {
    const h = harness();
    h.saved.set(RECIPE_ID, recipe());
    await h.bind();
    const edited = recipe({ extra: true }); // changed without a re-bind
    h.saved.set(RECIPE_ID, edited);
    expect(await h.status()).toBe('stale');
    expect(carryReceptionPairs([{ recipe_id: RECIPE_ID, before: edited, after: recipe({ version: 2 }) }], h.carry))
      .toEqual([]);
  });

  it('a recipe the update leaves identical for this pair needs nothing', async () => {
    const h = harness();
    h.saved.set(RECIPE_ID, recipe());
    await h.bind();
    expect(carryReceptionPairs([{ recipe_id: RECIPE_ID, before: recipe(), after: recipe() }], h.carry)).toEqual([]);
  });

  it('with no door substrate, nothing is carried: a pair re-pinned behind an unchecked door is worse', async () => {
    const h = harness();
    h.saved.set(RECIPE_ID, recipe());
    await h.bind();
    const { door: _door, ...noDoor } = h.carry;
    const change = [{ recipe_id: RECIPE_ID, before: recipe(), after: recipe({ version: 2, extra: true }) }];
    expect(receptionPairsAtRisk(change, noDoor).map((w) => w.reason)).toEqual(['needs_owner']);
    expect(carryReceptionPairs(change, noDoor).map((o) => o.outcome)).toEqual(['needs_owner']);
  });
});

describe('receptionPairParamsChanged', () => {
  it('reads the named answers and their order-free shape, and whether they are declared at all', () => {
    expect(receptionPairParamsChanged(recipe(), recipe({ fields: [...FIELDS].reverse() }))).toBe(false);
    expect(receptionPairParamsChanged(recipe(), recipe({ fields: [FIELDS[0]!, { ...FIELDS[1]!, required: false }] }))).toBe(true);
    expect(receptionPairParamsChanged(recipe(), recipe({ fields: [FIELDS[0]!, { ...FIELDS[1]!, type: 'text' }] }))).toBe(true);
    const undeclared = recipe();
    delete (undeclared.metadata as { requires_form_fields?: unknown }).requires_form_fields;
    expect(receptionPairParamsChanged(undeclared, recipe({ fields: [] }))).toBe(true);
  });
});

describe('the pack install carries the pair once the update commits', () => {
  it('⛔ an update through installBulkPackOnServer keeps the form taking submissions', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'reception-pair-carry-'));
    const db = new Database(':memory:');
    try {
      const recipeStore = createRecipeStore(dir, db);
      const h = harness(recipeStore);
      const row = (r: RecipeDefinition): BulkPackInstallRecipe => ({
        slug: RECIPE_ID,
        pinned_version: r.version,
        recipe: { recipe_id: RECIPE_ID, publisher_id: 'recued-core', version: r.version, recipe_hash: `h${r.version}`, recipe: r },
      });
      const input = (r: RecipeDefinition) => ({
        manifest_version: BULK_INSTALL_PACK_VERSION,
        pack_slug: 'lead-pack',
        publisher: 'recued-core',
        requires: [BULK_PACK_INSTALL_PERMISSION],
        recipes: [row(r)],
        ready: true,
      });
      const perms = new Set([BULK_PACK_INSTALL_PERMISSION]);
      const first = await installBulkPackOnServer(input(recipe({ concrete: true })) as never, perms, { recipeStore });
      expect(first.failure ?? null).toBeNull();
      await h.bind();
      expect(await h.status()).toBe('ready');
      const result = await installBulkPackOnServer(
        input(recipe({ version: 2, extra: true, concrete: true })) as never,
        perms,
        { recipeStore, receptionPairs: h.carry },
      );
      expect(result.ok).toBe(true);
      expect(recipeStore.get(RECIPE_ID)?.version).toBe(2);
      expect(await h.status()).toBe('ready');
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('packs.install_preview names the form an update would stop, before anything is installed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'reception-pair-preview-'));
    const db = new Database(':memory:');
    try {
      // The update, as it ships in the bundle: a new required answer. Written before the
      // store is created, which reads the bundle once.
      writeFileSync(join(dir, `${RECIPE_ID}.json`), JSON.stringify(recipe({
        version: 2, concrete: true, fields: [...FIELDS, { name: 'phone', type: 'text', required: true }],
      })));
      const recipeStore = createRecipeStore(dir, db);
      const h = harness(recipeStore);
      const installed = recipe({ concrete: true });
      const perms = new Set([BULK_PACK_INSTALL_PERMISSION]);
      await installBulkPackOnServer({
        manifest_version: BULK_INSTALL_PACK_VERSION,
        pack_slug: 'lead-pack',
        publisher: 'recued-core',
        requires: [BULK_PACK_INSTALL_PERMISSION],
        recipes: [{
          slug: RECIPE_ID,
          pinned_version: 1,
          recipe: { recipe_id: RECIPE_ID, publisher_id: 'recued-core', version: 1, recipe_hash: 'h1', recipe: installed },
        }],
        ready: true,
      } as never, perms, { recipeStore });
      await h.bind();
      expect(await h.status()).toBe('ready');
      const handlers = makePackInstallHandlers({ recipeStore, getReceptionPairs: () => h.carry })!.handlers;
      const result = await handlers['packs.install_preview']!({
        manifest: {
          manifest_version: 1,
          slug: 'lead-pack',
          publisher: 'recued-core',
          name: 'Lead pack',
          description: 'x',
          version: 2,
          recipes: [{ slug: RECIPE_ID, version: 2 }],
          requires: [BULK_PACK_INSTALL_PERMISSION],
          tags: [],
        },
      } as never, undefined as never) as { receptions_switched_off?: unknown };
      expect(result.receptions_switched_off).toEqual([
        { endpoint_id: ENDPOINT_ID, name: 'Get in touch', reason: 'params_changed' },
      ]);
      expect(await h.status()).toBe('ready'); // a preview writes nothing
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('⛔ packs.install carries it: the update through the handler keeps the form taking submissions', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'reception-pair-install-'));
    const db = new Database(':memory:');
    try {
      writeFileSync(join(dir, `${RECIPE_ID}.json`), JSON.stringify(recipe({ version: 2, concrete: true, extra: true })));
      const recipeStore = createRecipeStore(dir, db);
      const h = harness(recipeStore);
      await installBulkPackOnServer({
        manifest_version: BULK_INSTALL_PACK_VERSION,
        pack_slug: 'lead-pack',
        publisher: 'recued-core',
        requires: [BULK_PACK_INSTALL_PERMISSION],
        recipes: [{
          slug: RECIPE_ID,
          pinned_version: 1,
          recipe: { recipe_id: RECIPE_ID, publisher_id: 'recued-core', version: 1, recipe_hash: 'h1', recipe: recipe({ concrete: true }) },
        }],
        ready: true,
      } as never, new Set([BULK_PACK_INSTALL_PERMISSION]), { recipeStore });
      await h.bind();
      const handlers = makePackInstallHandlers({ recipeStore, getReceptionPairs: () => h.carry })!.handlers;
      const result = await handlers['packs.install']!({
        granted_permissions: [BULK_PACK_INSTALL_PERMISSION],
        manifest: {
          manifest_version: 1,
          slug: 'lead-pack',
          publisher: 'recued-core',
          name: 'Lead pack',
          description: 'x',
          version: 2,
          recipes: [{ slug: RECIPE_ID, version: 2 }],
          requires: [BULK_PACK_INSTALL_PERMISSION],
          tags: [],
        },
      } as never, undefined as never) as { ok?: boolean; failure?: unknown };
      expect(result.failure ?? null).toBeNull();
      expect(recipeStore.get(RECIPE_ID)?.version).toBe(2);
      expect(await h.status()).toBe('ready');
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
