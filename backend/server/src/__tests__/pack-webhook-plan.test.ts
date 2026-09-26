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
