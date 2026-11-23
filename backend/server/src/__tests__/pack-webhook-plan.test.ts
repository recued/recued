/** D-295 — a pack that listens to webhooks can be installed and updated from
 *  Settings → Packs.
 *
 *  The install requires one owner-selected webhook per declared binding and
 *  refused every call without one; the dialog never asked, so the 14 bundled
 *  webhook packs could not be installed or updated from the Packs page at all.
 *  The install preview now carries the plan the dialog asks from, and an update
 *  that brings no choice keeps the webhooks the pack uses now. */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BULK_PACK_INSTALL_PERMISSION,
  D165_CONTRACT_SCHEMA,
  type BulkPackManifest,
  type PackWebhookRequirement,
  type WebhookIngressRecord,
} from '@recued/contracts';

import { handlePacksInstall, makePackInstallHandlers } from '../pack-install-handler.js';
import { planPackWebhookBindings } from '../pack-webhook-plan.js';
import { createRecipeStore } from '../recipe-store.js';
import { createContractStore } from '../storage/contract-store.js';
import {
  createWebhookConsumerStore,
  webhookIngressUnfit,
  type WebhookConsumerStore,
} from '../storage/webhook-consumer-store.js';
import { createWebhookIngressStore, type WebhookIngressStore } from '../storage/webhook-ingress-store.js';
import { createContractDefinitionStore } from '../storage/contract-definition-store.js';
import { createContractGrantEntryStore } from '../storage/contract-grant-entry-store.js';
import { webhookDoorState } from '../webhook-door-enroll.js';
import { OWNER_DOOR_CLOSE_REASON } from '../mint-door-contract.js';
import { recordsManifestReviewHash } from '../records/index.js';

const REQUIREMENT: PackWebhookRequirement = {
  binding: 'deliveries',
  profile_ids: ['generic.static-header-token.v1'],
  required_event_types: ['delivery'],
  registration_modes: ['manual'],
  environment_policy: 'any',
  decoded_payload_access: 'metadata_only',
  source_truth_policy: 'delivery_payload_allowed',
};

/** Only the fields the rule reads, plus identity. */
const ingress = (over: Partial<WebhookIngressRecord> = {}): WebhookIngressRecord => ({
  ingress_id: 'in-ok',
  display_name: 'Deliveries',
  profile_id: 'generic.static-header-token.v1',
  environment: 'test',
  paired_connection_id: null,
  registration_mode: 'manual',
  selected_event_types: ['delivery', 'refund'],
  intake_state: 'enabled',
  ...over,
} as WebhookIngressRecord);

describe('webhookIngressUnfit — the install\'s rule, shared with the dialog', () => {
  it('names the first reason, in the install\'s order', () => {
    expect(webhookIngressUnfit(ingress(), REQUIREMENT, [])).toBeNull();
    expect(webhookIngressUnfit(ingress({ intake_state: 'draft' as never }), REQUIREMENT, [])?.reason).toBe('not_enabled');
    expect(webhookIngressUnfit(ingress({ profile_id: 'stripe.event.v1' }), REQUIREMENT, [])?.reason).toBe('profile');
    expect(webhookIngressUnfit(ingress({ selected_event_types: ['refund'] }), REQUIREMENT, [])?.reason).toBe('required_events');
    expect(webhookIngressUnfit(ingress(), REQUIREMENT, [{ binding: 'deliveries', event_types: ['chargeback'] }])?.reason)
      .toBe('trigger_events');
    // Another binding's trigger events are not this one's.
    expect(webhookIngressUnfit(ingress(), REQUIREMENT, [{ binding: 'other', event_types: ['chargeback'] }])).toBeNull();
    expect(webhookIngressUnfit(ingress(), { ...REQUIREMENT, paired_connection_slot: 'acme' }, [])?.reason)
      .toBe('paired_connection');
  });
});

describe('planPackWebhookBindings', () => {
  const pack = (slug: string, requirements: PackWebhookRequirement[]): BulkPackManifest => ({
    manifest_version: 1,
    slug,
    publisher: 'recued-core',
    name: `${slug} name`,
    description: 'x',
    version: 1,
    recipes: [],
    requires: [BULK_PACK_INSTALL_PERMISSION],
    tags: [],
    webhook_requirements: requirements,
  } as BulkPackManifest);

  it('offers exactly the webhooks that fit, by name; asks for every event the recipes trigger on too', () => {
    const plan = planPackWebhookBindings({
      manifests: [pack('hooks', [REQUIREMENT]), pack('quiet', [])],
      triggersFor: () => [{ binding: 'deliveries', event_types: ['refund'] }],
      ingresses: [
        ingress({ ingress_id: 'in-z', display_name: 'Zeta' }),
        ingress({ ingress_id: 'in-a', display_name: 'Alpha' }),
        ingress({ ingress_id: 'in-off', display_name: 'Off', intake_state: 'draft' as never }),
        ingress({ ingress_id: 'in-no-refund', display_name: 'No refunds', selected_event_types: ['delivery'] }),
      ],
      currentFor: () => new Map(),
    });
    expect(plan).toEqual([{
      pack_slug: 'hooks',
      pack_name: 'hooks name',
      binding: 'deliveries',
      vendor: expect.any(String),
      event_types: ['delivery', 'refund'],
      candidates: [
        { ingress_id: 'in-a', display_name: 'Alpha' },
        { ingress_id: 'in-z', display_name: 'Zeta' },
      ],
    }]);
  });

  it('an update says which webhook it uses now — and when that one no longer fits', () => {
    const run = (current: string) => planPackWebhookBindings({
      manifests: [pack('hooks', [REQUIREMENT])],
      triggersFor: () => [],
      ingresses: [ingress(), ingress({ ingress_id: 'in-off', display_name: 'Off', intake_state: 'draft' as never })],
      currentFor: () => new Map([['deliveries', current]]),
    })[0]!.current;
    expect(run('in-ok')).toEqual({ ingress_id: 'in-ok', display_name: 'Deliveries', fits: true });
    expect(run('in-off')).toEqual({ ingress_id: 'in-off', display_name: 'Off', fits: false });
    expect(run('in-gone')).toEqual({ ingress_id: 'in-gone', display_name: 'in-gone', fits: false });
  });
});

describe('⛔ through the real install: preview → choose → install → update with no choice', () => {
  const SECRET_KEY = new Uint8Array(32).fill(53);
  let db: Database.Database;
  let dirs: string[];
  let ingressStore: WebhookIngressStore;
  let consumerStore: WebhookConsumerStore;
  let deps: Parameters<typeof handlePacksInstall>[0];
  let ingressId: string;

  const manifest = (slug: string): BulkPackManifest => ({
    manifest_version: 1,
    slug,
    publisher: 'recued-core',
    name: 'Deliveries pack',
    description: 'Acts on deliveries.',
    version: 1,
    recipes: [{ slug: 'on-delivery', version: 1 }],
    requires: [BULK_PACK_INSTALL_PERMISSION],
    tags: [],
    webhook_requirements: [REQUIREMENT],
  } as BulkPackManifest);

  beforeEach(async () => {
    db = new Database(':memory:');
    let stamp = 2_099_999_999_999;
    const recipesDir = mkdtempSync(join(tmpdir(), 'webhook-plan-recipes-'));
    const packDir = mkdtempSync(join(tmpdir(), 'webhook-plan-packs-'));
    dirs = [recipesDir, packDir];
    writeFileSync(join(recipesDir, 'on-delivery.json'), JSON.stringify({
      recipe_id: 'on-delivery',
      version: 1,
      ttl: 60,
      metadata: {
        name: 'On delivery',
        description: 'D-295 fixture',
        author: 'recued-core',
        supported_platforms: [],
        tags: [],
        recipe_bundle: 'recued-core/deliveries-pack',
      },
      variables: {},
      prefetch_steps: [],
      steps: [{ id: 'seen', transform: 'compare', left: 'x', operator: 'is_not_empty' }],
      output: { sidebar: [] },
      webhook_triggers: [{ binding: 'deliveries', event_types: ['delivery'] }],
    }));
    for (const slug of ['deliveries-pack', 'fresh-pack']) {
      writeFileSync(join(packDir, `${slug}.json`), JSON.stringify(manifest(slug)));
    }
    ingressStore = createWebhookIngressStore(db, { now: () => stamp, getEncryptionKey: () => SECRET_KEY });
    const created = ingressStore.create({
      display_name: 'Deliveries',
      profile_id: 'generic.static-header-token.v1',
      environment: 'test',
      paired_connection_id: null,
      registration_mode: 'manual',
      selected_event_types: ['delivery'],
    });
    await ingressStore.writeCredentialVersion(created.ingress_id, { header_name: 'x-token', header_token: 'token' });
    db.prepare(`UPDATE webhook_ingresses SET intake_state = 'enabled', registration_state = 'registered', enabled_at = ?
      WHERE ingress_id = ?`).run(stamp, created.ingress_id);
    ingressId = created.ingress_id;
    // One more that does not fit: never enabled.
    ingressStore.create({
      display_name: 'Not enabled yet',
      profile_id: 'generic.static-header-token.v1',
      environment: 'test',
      paired_connection_id: null,
      registration_mode: 'manual',
      selected_event_types: ['delivery'],
    });
    consumerStore = createWebhookConsumerStore(db, { ingressStore, now: () => ++stamp });
    const contractStore = createContractStore(db, { now: () => ++stamp });
    contractStore.seedSchema(D165_CONTRACT_SCHEMA);
    deps = {
      recipeStore: createRecipeStore(recipesDir, db),
      packDir,
      contractStore,
      webhookConsumerStore: consumerStore,
      webhookIngressStore: ingressStore,
      now: () => ++stamp,
    };
  });
  afterEach(() => {
    db.close();
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  const preview = async (slug: string) =>
    (await makePackInstallHandlers(deps)!.handlers['packs.install_preview']!(
      { manifest: manifest(slug) } as never,
      undefined as never,
    )) as { webhook_plan?: Array<{ candidates: unknown[]; current?: unknown; event_types: unknown }> };
  const install = (slug: string, choices: Record<string, unknown> = {}) =>
    handlePacksInstall(deps, { manifest: manifest(slug), granted_permissions: [BULK_PACK_INSTALL_PERMISSION], ...choices });
  const boundTo = (slug: string) =>
    consumerStore.listBindings({ consumer_kind: 'pack_install', consumer_id: slug })
      .map((binding) => `${binding.logical_binding}→${binding.ingress_id}`);

  it('the preview offers the webhooks that fit; after the install it names the one in use; an update keeps it', async () => {
    const first = await preview('deliveries-pack');
    expect(first.webhook_plan).toHaveLength(1);
    expect(first.webhook_plan![0]!.candidates).toEqual([{ ingress_id: ingressId, display_name: 'Deliveries' }]);
    expect(first.webhook_plan![0]!.current).toBeUndefined();

    const installed = await install('deliveries-pack', {
      webhook_bindings: [{ pack_slug: 'deliveries-pack', binding: 'deliveries', ingress_id: ingressId }],
    });
    expect(installed.result.ok, JSON.stringify(installed.result.failure ?? null)).toBe(true);
    expect((await preview('deliveries-pack')).webhook_plan![0]!.current)
      .toEqual({ ingress_id: ingressId, display_name: 'Deliveries', fits: true });

    // ⛔ The update brings no webhook choice at all — it used to be refused.
    const updated = await install('deliveries-pack');
    expect(updated.result.ok, JSON.stringify(updated.result.failure ?? null)).toBe(true);
    expect(boundTo('deliveries-pack')).toEqual([`deliveries→${ingressId}`]);
  });

  it('a first install still needs the owner\'s choice — there is nothing to carry', async () => {
    const { result } = await install('fresh-pack');
    expect(result.ok).toBe(false);
    expect(result.failure?.message).toMatch(/owner-selected ingress for every webhook binding/);
  });
});

// D-201 Slice 10AF (10AE finding 17; the owner's ruling of 2026-11-20) — an
// owner who edits a pack publishes it under their own name, and an unattended
// server must keep taking such updates: never refused, never opened silently.
// The preview raises each webhook door's switch, set to the state the owner
// left it in, and the install carries the answer.
describe('D-201 Slice 10AF — through the real install: an update from another publisher raises each door\'s switch', () => {
  const SECRET_KEY = new Uint8Array(32).fill(59);
  let db: Database.Database;
  let dirs: string[];
  let recipesDir: string;
  let deps: Parameters<typeof handlePacksInstall>[0];
  let consumerStore: WebhookConsumerStore;
  let definitionStore: ReturnType<typeof createContractDefinitionStore>;
  let ingressId: string;
  let stamp: number;

  const SLUG = 'deliveries-pack';
  const EDITOR = 'an-owner-who-edited-it';
  const recipeBy = (publisher: string) => ({
    recipe_id: 'on-delivery',
    version: 1,
    ttl: 60,
    metadata: {
      name: 'On delivery',
      description: 'D-201 Slice 10AF fixture',
      author: publisher,
      supported_platforms: [],
      tags: [],
      recipe_bundle: `${publisher}/${SLUG}`,
    },
    variables: {},
    prefetch_steps: [],
    steps: [{ id: 'seen', transform: 'compare', left: 'x', operator: 'is_not_empty' }],
    output: { sidebar: [] },
    webhook_triggers: [{ binding: 'deliveries', event_types: ['delivery'] }],
  });
  const manifestBy = (publisher: string, version: number): BulkPackManifest => ({
    manifest_version: 1,
    slug: SLUG,
    publisher,
    name: 'Deliveries pack',
    description: 'Acts on deliveries.',
    version,
    recipes: [{ slug: 'on-delivery', version: 1 }],
    requires: [BULK_PACK_INSTALL_PERMISSION],
    tags: [],
    webhook_requirements: [REQUIREMENT],
  } as BulkPackManifest);
  /** The pack as its publisher ships it: its recipe names that publisher's
   *  bundle. The store reads its bundled recipes when made, so it is made again
   *  over the same database, which keeps what was installed. */
  const shipBy = (publisher: string): void => {
    writeFileSync(join(recipesDir, 'on-delivery.json'), JSON.stringify(recipeBy(publisher)));
    deps = { ...deps, recipeStore: createRecipeStore(recipesDir, db) };
  };
  const installBy = (publisher: string, version: number, extra: Record<string, unknown> = {}) => {
    shipBy(publisher);
    return handlePacksInstall(deps, {
      manifest: manifestBy(publisher, version),
      granted_permissions: [BULK_PACK_INSTALL_PERMISSION],
      webhook_bindings: [{ pack_slug: SLUG, binding: 'deliveries', ingress_id: ingressId }],
      ...extra,
    });
  };
  const doorFor = (publisher: string) =>
    consumerStore.doorContractIdForRecipe('pack_install', SLUG, 'on-delivery', publisher);

  beforeEach(async () => {
    db = new Database(':memory:');
    stamp = 2_099_999_999_999;
    recipesDir = mkdtempSync(join(tmpdir(), 'webhook-doors-recipes-'));
    const packDir = mkdtempSync(join(tmpdir(), 'webhook-doors-packs-'));
    dirs = [recipesDir, packDir];
    const ingressStore = createWebhookIngressStore(db, { now: () => stamp, getEncryptionKey: () => SECRET_KEY });
    const created = ingressStore.create({
      display_name: 'Deliveries',
      profile_id: 'generic.static-header-token.v1',
      environment: 'test',
      paired_connection_id: null,
      registration_mode: 'manual',
      selected_event_types: ['delivery'],
    });
    await ingressStore.writeCredentialVersion(created.ingress_id, { header_name: 'x-token', header_token: 'token' });
    db.prepare(`UPDATE webhook_ingresses SET intake_state = 'enabled', registration_state = 'registered', enabled_at = ?
      WHERE ingress_id = ?`).run(stamp, created.ingress_id);
    ingressId = created.ingress_id;
    consumerStore = createWebhookConsumerStore(db, { ingressStore, now: () => ++stamp });
    const contractStore = createContractStore(db, { now: () => ++stamp });
    contractStore.seedSchema(D165_CONTRACT_SCHEMA);
    definitionStore = createContractDefinitionStore(contractStore);
    deps = {
      recipeStore: createRecipeStore(recipesDir, db),
      packDir,
      contractStore,
      webhookConsumerStore: consumerStore,
      webhookIngressStore: ingressStore,
      webhookDoor: {
        definitionStore,
        grantEntryStore: createContractGrantEntryStore(contractStore),
        consumerStore,
        now: () => ++stamp,
        resolveConfig: () => undefined,
      },
      now: () => ++stamp,
    };
  });
  afterEach(() => {
    db.close();
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  const preview = async (publisher: string, version: number) => {
    shipBy(publisher);
    return (await makePackInstallHandlers(deps)!.handlers['packs.install_preview']!(
      { manifest: manifestBy(publisher, version) } as never,
      undefined as never,
    )) as { webhook_publisher_changes?: unknown };
  };

  it("the preview raises the switch at the state the owner left it in, and the owner's answer decides", async () => {
    const first = await installBy('recued-core', 1);
    expect(first.result.ok, JSON.stringify(first.result.failure ?? null)).toBe(true);
    const door = doorFor('recued-core')!;
    expect(door).not.toBeNull();
    // The same publisher raises nothing.
    expect((await preview('recued-core', 2)).webhook_publisher_changes).toBeUndefined();
    definitionStore.revoke(door, 'Revoked from Settings');
    expect((await preview(EDITOR, 2)).webhook_publisher_changes).toEqual([{
      pack_slug: SLUG,
      recipe_id: 'on-delivery',
      name: 'On delivery',
      from_publisher: 'recued-core',
      door: 'closed',
    }]);
    const answered = await installBy(EDITOR, 2, {
      webhook_door_choices: [{ pack_slug: SLUG, recipe_id: 'on-delivery', door: 'open' }],
    });
    expect(answered.result.ok, JSON.stringify(answered.result.failure ?? null)).toBe(true);
    expect(webhookDoorState(definitionStore, doorFor(EDITOR), ++stamp)).toBe('live');
  });

  // D-201 Slice 10AJ (10AI finding 1) — an answer already given for this
  // version, kept until its door is made: the switch shows it.
  it('the preview shows an answer kept for this version', async () => {
    expect((await installBy('recued-core', 1)).result.ok).toBe(true);
    db.prepare(`INSERT INTO webhook_recipe_door_answers
      (consumer_kind, consumer_id, recipe_id, publisher_id, door, answered_at)
      VALUES ('pack_install', ?, 'on-delivery', ?, 'closed', 1)`).run(SLUG, EDITOR);
    expect((await preview(EDITOR, 2)).webhook_publisher_changes)
      .toEqual([expect.objectContaining({ recipe_id: 'on-delivery', door: 'closed' })]);
    // D-201 Slice 10AO (10AM finding 1) — and to a third publisher's version,
    // as the card shows it, whatever the publisher it was given for.
    expect((await preview('a-third-publisher', 3)).webhook_publisher_changes)
      .toEqual([expect.objectContaining({ recipe_id: 'on-delivery', door: 'closed' })]);
  });

  // D-201 Slice 10AO (10AM finding 1) — through the real install RPC and its
  // preview: an answer an update left, its stamp meeting a busy database, is
  // done once a door is made, so the preview and the next update read the door
  // as the owner closed it since.
  it('an answer an update left is done once a door is made: the preview and the next update read the door the owner left', async () => {
    expect((await installBy('recued-core', 1)).result.ok).toBe(true);
    const real = deps;
    const busy = {
      ...consumerStore,
      stampTriggerContracts: () => {
        throw Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
      },
    } as WebhookConsumerStore;
    deps = { ...deps, webhookConsumerStore: busy, webhookDoor: { ...deps.webhookDoor!, consumerStore: busy } };
    const answered = await installBy(EDITOR, 2, {
      webhook_door_choices: [{ pack_slug: SLUG, recipe_id: 'on-delivery', door: 'open' }],
    });
    deps = { ...real, recipeStore: deps.recipeStore };
    expect(answered.result.ok, JSON.stringify(answered.result.failure ?? null)).toBe(true);
    expect(doorFor(EDITOR)).toBeNull();
    // Back to the first publisher: its door made, open as answered.
    expect((await installBy('recued-core', 3)).result.ok).toBe(true);
    expect(webhookDoorState(definitionStore, doorFor('recued-core'), ++stamp)).toBe('live');
    // The owner closes it.
    definitionStore.revoke(doorFor('recued-core')!, OWNER_DOOR_CLOSE_REASON);
    // Before 10AO the preview showed the answer left behind, open, and the
    // update opened the door.
    expect((await preview(EDITOR, 4)).webhook_publisher_changes)
      .toEqual([expect.objectContaining({ recipe_id: 'on-delivery', door: 'closed' })]);
    expect((await installBy(EDITOR, 4)).result.ok).toBe(true);
    expect(webhookDoorState(definitionStore, doorFor(EDITOR), ++stamp)).toBe('closed');
  });

  it('without an answer, the door keeps the state the owner left it in', async () => {
    expect((await installBy('recued-core', 1)).result.ok).toBe(true);
    definitionStore.revoke(doorFor('recued-core')!, 'Revoked from Settings');
    const unanswered = await installBy(EDITOR, 2);
    expect(unanswered.result.ok, JSON.stringify(unanswered.result.failure ?? null)).toBe(true);
    expect(webhookDoorState(definitionStore, doorFor(EDITOR), ++stamp)).toBe('closed');
  });

  // D-201 Slice 10AJ (10AI finding 5) — the marketplace's install, by slug, is
  // the path an owner-edited pack arrives by, and a pack can bring another in:
  // both carry the owner's answers, which no test pinned.
  const ANSWER = [{ pack_slug: SLUG, recipe_id: 'on-delivery', door: 'closed' as const }];
  it('the marketplace install, by slug, carries the answers', async () => {
    expect((await installBy('recued-core', 1)).result.ok).toBe(true);
    shipBy(EDITOR);
    const outcome = await makePackInstallHandlers({
      ...deps,
      // The marketplace serves the edited pack and its recipe.
      marketplaceFetch: (async (url: string | URL | Request) => {
        const path = String(url);
        if (path.endsWith(`/packs/${SLUG}.json`)) return new Response(JSON.stringify(manifestBy(EDITOR, 2)), { status: 200 });
        if (path.endsWith('/recipes/on-delivery.json')) {
          return new Response(JSON.stringify({
            recipe_id: 'on-delivery',
            publisher_id: EDITOR,
            version: 1,
            recipe: recipeBy(EDITOR),
          }), { status: 200 });
        }
        return new Response('not found', { status: 404 });
      }) as typeof fetch,
    })!.handlers['packs.installBySlug']!({
      slug: SLUG,
      granted_permissions: [BULK_PACK_INSTALL_PERMISSION],
      // An update by slug names the manifest the owner reviewed.
      expected_manifest_hash: recordsManifestReviewHash(manifestBy(EDITOR, 2)),
      webhook_bindings: [{ pack_slug: SLUG, binding: 'deliveries', ingress_id: ingressId }],
      webhook_door_choices: ANSWER,
    } as never, {} as never) as { result: { ok: boolean; failure?: unknown } };
    expect(outcome.result.ok, JSON.stringify(outcome.result.failure ?? null)).toBe(true);
    expect(webhookDoorState(definitionStore, doorFor(EDITOR), ++stamp)).toBe('closed');
  });

  it('a pack that brings this one in carries the answers to it', async () => {
    expect((await installBy('recued-core', 1)).result.ok).toBe(true);
    // The pack that brings it in, with a recipe of its own.
    writeFileSync(join(recipesDir, 'brings-note.json'), JSON.stringify({
      ...recipeBy(EDITOR),
      recipe_id: 'brings-note',
      metadata: { ...recipeBy(EDITOR).metadata, name: 'Brings note', recipe_bundle: `${EDITOR}/brings-deliveries` },
      webhook_triggers: undefined,
    }));
    shipBy(EDITOR);
    const outcome = await handlePacksInstall({
      ...deps,
      resolveDependencyManifest: (slug: string) => (slug === SLUG ? manifestBy(EDITOR, 2) : null),
    }, {
      manifest: {
        manifest_version: 1,
        slug: 'brings-deliveries',
        publisher: EDITOR,
        name: 'Brings deliveries',
        description: 'Brings the deliveries pack in.',
        version: 1,
        recipes: [{ slug: 'brings-note', version: 1 }],
        requires: [BULK_PACK_INSTALL_PERMISSION],
        tags: [],
        dependencies: [{ type: 'pack', slug: SLUG, min_version: 2 }],
      } as unknown as BulkPackManifest,
      granted_permissions: [BULK_PACK_INSTALL_PERMISSION],
      webhook_bindings: [{ pack_slug: SLUG, binding: 'deliveries', ingress_id: ingressId }],
      webhook_door_choices: ANSWER,
    });
    expect(outcome.result.ok, JSON.stringify(outcome.result.failure ?? null)).toBe(true);
    expect(webhookDoorState(definitionStore, doorFor(EDITOR), ++stamp)).toBe('closed');
  });

  it('a malformed answer is refused before anything is written, never read as "as it was left"', async () => {
    expect((await installBy('recued-core', 1)).result.ok).toBe(true);
    for (const choices of [
      'open',
      [{ pack_slug: SLUG, recipe_id: 'on-delivery', door: 'ajar' }],
      [{ pack_slug: SLUG, recipe_id: 'on-delivery' }],
      [
        { pack_slug: SLUG, recipe_id: 'on-delivery', door: 'open' },
        { pack_slug: SLUG, recipe_id: 'on-delivery', door: 'closed' },
      ],
    ]) {
      await expect(installBy(EDITOR, 2, { webhook_door_choices: choices }), JSON.stringify(choices))
        .rejects.toMatchObject({ code: 'bad_request' });
    }
    expect(doorFor(EDITOR)).toBeNull();
  });
});
