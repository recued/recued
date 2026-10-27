/** Explicit, revocable authority for a schedule's narrow local writes. This is
 * independent of policy: denies and individual-review lifts remain binding. */
import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { RpcError, isRecordsExecutionBinding, kernelOpForBackingSlug, type ExecutionSource, type LocalAutomationHooks,
  type LocalAutomationReview, type LocalAutomationScope, type RecordsExecutionBinding } from '@recued/contracts';
import { canonicalJsonString, canonicalRecipeDefinition } from '@recued/recipes';
import { resourceReviewHash as hash } from './resource-review.js';
import type { ExecuteHandlerDeps } from './execute-handler.js';
import type { ScheduleHandlerDeps } from './schedule-handler.js';
import type { WorkEntityStore } from './storage/work-entity-store.js';
import { schedulePreapprovalMaterial } from './schedule-store.js';
import { dishPreapprovalMaterial } from './dish-store.js';
import { deriveRecipeCapability } from './derive-recipe-capability.js';
import { withScheduledLocalAuthority } from './scheduled-local-authority-context.js';
import { initializePreapprovalLifecycle, synchronizePreapprovalIdentity } from './storage/preapproval-lifecycle.js';
import { initializePreapprovalConnections, synchronizePreapprovalConnection } from './storage/preapproval-connections.js';

const TTL = 30 * 86_400_000, USES = 1000;
export const scheduledRecipeDigest = (recipe: Parameters<typeof canonicalRecipeDefinition>[0]): string =>
  createHash('sha256').update(canonicalJsonString(canonicalRecipeDefinition(recipe))).digest('hex');
const fail = (detail: string): never => { throw new RpcError('local_automation_unavailable', detail, 409); };
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const names = (value: unknown): value is string[] => Array.isArray(value) && value.length > 0 && value.length <= 30
  && value.every(key => typeof key === 'string' && /^[a-z][a-z0-9_]{0,63}$/u.test(key)) && new Set(value).size === value.length;
const scopeOf = (raw: unknown): LocalAutomationScope => {
  if (!object(raw) || typeof raw.catalog !== 'string' || typeof raw.entity !== 'string'
    || typeof raw.connection_slot !== 'string' || typeof raw.connection_field !== 'string' || !names(raw.mutable_fields)
    || raw.mutable_fields.includes('id') || raw.mutable_fields.includes(raw.connection_field)
    || (raw.filters !== undefined && (!object(raw.filters) || Object.values(raw.filters).some(value => typeof value !== 'string')))) {
    return fail('This recipe does not describe a supported local write scope.');
  }
  if (raw.asset !== undefined && (!object(raw.asset) || typeof raw.asset.id_field !== 'string'
    || raw.mutable_fields.includes(raw.asset.id_field) || !names(raw.asset.date_fields)
    || typeof raw.asset.source_ref_prefix !== 'string' || !raw.asset.source_ref_prefix || raw.asset.source_ref_prefix.length > 100)) {
    return fail('The asset mapping is not bounded to existing assets and named date fields.');
  }
  return raw as unknown as LocalAutomationScope;
};
type Grant = { schedule_id: string; grant_id: string; basis_hash: string; expires_at: number; uses_remaining: number; revoked_at: number | null };
export const createScheduledLocalAuthority = (deps: {
  db: Database.Database;
  execution: { recipeStore: Pick<ExecuteHandlerDeps['recipeStore'], 'get' | 'getStored'>;
    dishStore: Pick<NonNullable<ExecuteHandlerDeps['dishStore']>, 'get'>;
    connectionStore: Pick<NonNullable<ExecuteHandlerDeps['connectionStore']>, 'get'>;
    recordsStore: NonNullable<ExecuteHandlerDeps['recordsStore']>;
    executorConfig: { manifests: Pick<ExecuteHandlerDeps['executorConfig']['manifests'], 'get'> } };
  schedules: ScheduleHandlerDeps['store']; assets: WorkEntityStore; now?: () => number;
  catalogForPack(ref: string): string | undefined;
}) => {
  const { db, execution } = deps, now = deps.now ?? Date.now;
  initializePreapprovalLifecycle(db);
  initializePreapprovalConnections(db);
  db.exec(`CREATE TABLE IF NOT EXISTS scheduled_local_authorizations (
    schedule_id TEXT PRIMARY KEY, grant_id TEXT NOT NULL, basis_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, uses_remaining INTEGER NOT NULL, revoked_at INTEGER
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS scheduled_local_authorization_events (
    event_id TEXT PRIMARY KEY, schedule_id TEXT NOT NULL, grant_id TEXT NOT NULL,
    action TEXT NOT NULL, at INTEGER NOT NULL, detail_json TEXT NOT NULL
  )`);
  const event = (scheduleId: string, grantId: string, action: string, detail: unknown) => db.prepare(
    'INSERT INTO scheduled_local_authorization_events VALUES(?,?,?,?,?,?)').run(randomUUID(), scheduleId, grantId, action, now(), JSON.stringify(detail));
  const challenges = new Map<string, { actor: string; schedule_id: string; basis: string; until: number }>();
  const grant = (id: string) => db.prepare('SELECT * FROM scheduled_local_authorizations WHERE schedule_id=?').get(id) as Grant | undefined;
  const live = (row: Grant | undefined): row is Grant => !!row && row.revoked_at === null && row.expires_at > now() && row.uses_remaining > 0;
  const basis = (id: string) => {
    const schedule = deps.schedules.get(id);
    if (!schedule || !schedule.dish_id || !schedule.enabled || schedule.mode !== 'recurring') return fail('Choose an enabled recurring schedule with its own saved dish.');
    const dish = execution.dishStore?.get(schedule.dish_id), recipe = execution.recipeStore.get(schedule.recipe_id);
    const stored = execution.recipeStore.getStored(schedule.recipe_id);
    if (!dish?.enabled || !recipe || dish.recipe_id !== schedule.recipe_id || stored?.publisher_id !== schedule.publisher_id
      || dish.publisher_id !== schedule.publisher_id) return fail('The schedule needs its original installed recipe and enabled dish.');
    // Group overlays and arbitrary context can introduce bindings outside this
    // initial scope. Refuse rather than approximate the run's effective settings.
    if (dish.group_id) return fail('Use a dish without shared group settings for local write authorization.');
    if (Object.keys(recipe.variables ?? {}).length || Object.keys(dish.config_overlay).length) {
      return fail('Local write authorization currently supports recipes without configurable inputs. Keep parameters in reviewed source links, or use ordinary approvals.');
    }
    const scope = scopeOf(recipe.metadata.local_automation);
    const capability = deriveRecipeCapability(recipe, { kernelStepOps: true });
    if (!capability.ok) return fail('The recipe’s complete operation scope cannot be resolved for local authorization.');
    const operationDefinitions = capability.capability.ingredient_ids.map(slug => {
      const definition = execution.executorConfig.manifests.get(slug);
      if (!definition && !kernelOpForBackingSlug(slug)) return fail('A recipe operation is no longer installed.');
      return { slug, definition: definition ?? null };
    });
    const connection = dish.connections?.[scope.connection_slot];
    if (!connection) return fail('Save an explicit connection for this schedule’s dish before reviewing local writes.');
    const route = execution.connectionStore?.get('api', connection);
    if (!route) return fail('The selected API connection is no longer enrolled.');
    const catalog = deps.catalogForPack(scope.catalog);
    const manifest = catalog ? execution.executorConfig.manifests.get(catalog) : null;
    if (!manifest || !manifest.surfaces?.records || !execution.recordsStore) return fail('The declared Records catalog is unavailable.');
    const bindings = Object.entries(manifest.surfaces.records.executes ?? {}).filter((entry): entry is [string, RecordsExecutionBinding] =>
      isRecordsExecutionBinding(entry[1]) && entry[1].entity === scope.entity && entry[1].action === 'update');
    if (!bindings.length) return fail('The declared entity has no supported update operation.');
    const binding = bindings[0]![1];
    if (!isRecordsExecutionBinding(binding)) return fail('The Records binding is unavailable.');
    const namespace = execution.recordsStore.getNamespaceState(binding.owner);
    if (namespace?.state !== 'ready') return fail('The Records namespace is not ready.');
    const namespaceView = execution.recordsStore.getNamespace(binding.owner)!;
    const namespaceIdentity = { activation_generation: namespaceView.activation_generation,
      state_generation: namespaceView.state_generation, artifact_digest: namespaceView.artifact_digest };
    const result = execution.recordsStore.ownerSearch({ owner: binding.owner, entity: scope.entity,
      filters: { ...scope.filters, [scope.connection_field]: connection }, limit: 200 });
    if (result.next_cursor || result.records.length === 0) return fail('Review between one and two hundred existing source links. Complete the first import before authorizing updates.');
    const records = result.records.sort((a, b) => a.id.localeCompare(b.id)).map(record => {
      const snapshot = execution.recordsStore!.reviewSnapshot(binding.owner, scope.entity, record.id);
      if (!snapshot) return fail('A source link changed during review.');
      const values = Object.fromEntries(Object.entries(record).filter(([key]) => key !== '_record' && !scope.mutable_fields.includes(key)));
      const assetId = scope.asset ? record[scope.asset.id_field] : undefined;
      const asset = typeof assetId === 'string' && assetId ? deps.assets.readAsset(assetId) : null;
      if (scope.asset && (!asset || asset.deleted_at != null || asset.sync_state !== 'live' || !['active', 'lent'].includes(asset.status))) return fail('Import every selected source link into an active existing asset before authorizing its recurring updates.');
      return { id: record.id, incarnation: snapshot.incarnation, values,
        ...(asset ? { asset_id: asset.id, asset_identity: { created_at: asset.created_at, source_id: asset.source_id, class_id: asset.class_id } } : {}) };
    });
    const pins = [synchronizePreapprovalIdentity(db, 'next_schedule', id, schedulePreapprovalMaterial(schedule)),
      synchronizePreapprovalIdentity(db, 'dish', dish.dish_id, dishPreapprovalMaterial(dish)),
      ...synchronizePreapprovalConnection(db, 'api', connection, route)].map(pin => pin && ({
        kind: pin.kind, key: pin.key, incarnation: pin.incarnation, revision: pin.revision, content_hash: pin.content_hash,
      }));
    const recipeIdentity = db.prepare(`SELECT kind,key,incarnation,revision,content_hash
      FROM preapproval_resource_identity WHERE kind='recipe' AND key=? AND present=1`).get(recipe.recipe_id);
    if (!recipeIdentity) return fail('The installed recipe has no durable identity. Install it again before reviewing local writes.');
    const lineage = db.prepare("SELECT 1 FROM sqlite_master WHERE name='preapproval_state'").get()
      ? db.prepare('SELECT lineage FROM preapproval_state WHERE singleton=1').pluck().get() : null;
    const recipeHash = scheduledRecipeDigest(recipe);
    return { schedule, dish, recipe, recipeHash, scope, catalog, connection, bindings, records,
      digest: hash({ schema: 1, lineage, pins, recipeIdentity, recipeHash, manifest, operationDefinitions, namespace,
        namespaceIdentity, records, scope }) };
  };
  const readReview = (id: string, actor: string): LocalAutomationReview => db.transaction(() => {
    const existing = grant(id);
    let value: ReturnType<typeof basis>;
    try { value = basis(id); }
    catch (error) {
      return { schedule_id: id, supported: false, reason: error instanceof Error ? error.message : 'Local write review is unavailable.',
        ...(existing && existing.revoked_at === null ? { authorization: { expires_at: existing.expires_at, uses_remaining: existing.uses_remaining, current: false } } : {}) };
    }
    for (const [key, item] of challenges) if (item.until <= now()) challenges.delete(key);
    if (challenges.size >= 200) challenges.delete(challenges.keys().next().value!);
    const review_id = randomUUID(); challenges.set(review_id, { actor, schedule_id: id, basis: value.digest, until: now() + 300_000 });
    return { schedule_id: id, supported: true, recipe_name: value.recipe.metadata.name, review_id,
      connection: value.connection, records: value.records.map(({ id: recordId, values, asset_id }) => ({ id: recordId, values, ...(asset_id ? { asset_id } : {}) })),
      record_fields: value.scope.mutable_fields, asset_fields: value.scope.asset?.date_fields.map(field => 'dates.' + field) ?? [],
      ...(existing && existing.revoked_at === null ? { authorization: { expires_at: existing.expires_at, uses_remaining: existing.uses_remaining,
        current: live(existing) && existing.basis_hash === value.digest } } : {}) };
  }).immediate();
  const permits = new WeakMap<object, { grantId: string; scheduleId: string; digest: string; slug: string;
    input: Record<string, unknown>; input_hash: string }>();
  return {
    review: readReview,
    authorize(id: string, reviewId: string, actor: string): LocalAutomationReview {
      db.transaction(() => {
        const challenge = challenges.get(reviewId);
        if (!challenge || challenge.actor !== actor || challenge.schedule_id !== id || challenge.until <= now()) return fail('Open a fresh review in this paired client before authorizing local writes.');
        let value: ReturnType<typeof basis>;
        try { value = basis(id); } catch { return fail('The schedule, connection or source mappings changed. Open a fresh review.'); }
        if (challenge.basis !== value.digest) return fail('The schedule, connection or source mappings changed. Open a fresh review.');
        const grantId = randomUUID();
        db.prepare(`INSERT INTO scheduled_local_authorizations VALUES(?,?,?,?,?,?,NULL)
          ON CONFLICT(schedule_id) DO UPDATE SET grant_id=excluded.grant_id,basis_hash=excluded.basis_hash,
          created_at=excluded.created_at,expires_at=excluded.expires_at,uses_remaining=excluded.uses_remaining,revoked_at=NULL`)
          .run(id, grantId, value.digest, now(), now() + TTL, USES);
        event(id, grantId, 'authorized', { actor, basis_hash: value.digest, expires_at: now() + TTL, max_uses: USES });
        challenges.delete(reviewId);
      }).immediate();
      return readReview(id, actor);
    },
    revoke(id: string): void {
      db.transaction(() => {
        const existing = grant(id);
        db.prepare('UPDATE scheduled_local_authorizations SET revoked_at=COALESCE(revoked_at,?) WHERE schedule_id=?').run(now(), id);
        if (existing && existing.revoked_at === null) event(id, existing.grant_id, 'revoked', {});
      }).immediate();
      for (const [key, challenge] of challenges) if (challenge.schedule_id === id) challenges.delete(key);
    },
    forRun(run: { source?: ExecutionSource; dish_id?: string; recipe_hash: string; connections: Readonly<Record<string, string>>; run_id?: string;
      validate?(slug: string, input: Record<string, unknown>): void }): LocalAutomationHooks | undefined {
      const source = run.source;
      if (source?.channel !== 'schedule' || source.actor !== 'system' || source.contract_id !== undefined || !source.schedule_id) return undefined;
      const id = source.schedule_id;
      return {
        authorize(call) {
          if (call.risk_tier !== 'write' || call.provenance.lift_reason || call.provenance.pre_lift_approval === 'always') return undefined;
          try { return db.transaction(() => {
            const existing = grant(id); if (!live(existing)) return undefined;
            const value = basis(id);
            if (existing.basis_hash !== value.digest || run.recipe_hash !== value.recipeHash || run.dish_id !== value.dish.dish_id
              || source.source_recipe !== value.recipe.recipe_id || source.cron !== value.schedule.cron_expression
              || hash(run.connections) !== hash(value.dish.connections)) return undefined;
            const input = call.input;
            let covered = false;
            if (call.slug === value.catalog && typeof input.operation === 'string' && object(input.args)) {
              const binding = value.bindings.find(([key]) => key === input.operation)?.[1];
              const args = input.args;
              const record = value.records.find(row => row.id === args.id);
              if (binding && record && object(args.set) && (args.unset == null || Array.isArray(args.unset))) {
                const current = execution.recordsStore!.ownerGet(binding.owner, value.scope.entity, record.id)!;
                covered = Object.entries(args.set).every(([key, next]) => value.scope.mutable_fields.includes(key) || hash(next) === hash(current[key] ?? null))
                  && (args.unset == null || (args.unset as unknown[]).every(key => typeof key === 'string' && value.scope.mutable_fields.includes(key)));
              }
            } else if (call.slug === 'asset-update' && value.scope.asset) {
              const mapping = value.scope.asset, record = value.records.find(row => row.asset_id === input.id);
              covered = !!record && Object.keys(input).every(key => ['id', 'dates', 'source'].includes(key)) && object(input.dates)
                && Object.keys(input.dates).length > 0 && Object.keys(input.dates).every(field => mapping.date_fields.includes(field))
                && hash(input.source) === hash({ kind: 'extracted', ref: mapping.source_ref_prefix + record.id });
            }
            if (!covered) return undefined;
            const permit = {}; permits.set(permit, { grantId: existing.grant_id, scheduleId: id, digest: value.digest,
              slug: call.slug, input: structuredClone(call.input), input_hash: hash(call.input) }); return permit;
          }).immediate(); } catch { return undefined; }
        },
        run(permit, effect) {
          const approved = permits.get(permit); if (!approved) return fail('The local write has no host authorization.');
          permits.delete(permit);
          let consumed = false;
          return withScheduledLocalAuthority(actualDb => {
            if (actualDb !== db || !db.inTransaction) return fail('Local authorization requires the same realm mutation transaction.');
            if (consumed) return;
            run.validate?.(approved.slug, approved.input);
            const current = grant(id);
            if (!live(current) || current.grant_id !== approved.grantId || current.basis_hash !== approved.digest
              || basis(id).digest !== approved.digest) return fail('Local write authorization expired, was revoked or its mappings changed.');
            const changed = db.prepare(`UPDATE scheduled_local_authorizations SET uses_remaining=uses_remaining-1
              WHERE schedule_id=? AND grant_id=? AND revoked_at IS NULL AND expires_at>? AND uses_remaining>0`).run(id, approved.grantId, now());
            if (!changed.changes) return fail('Local write authorization is no longer active.');
            event(id, approved.grantId, 'used', { run_id: run.run_id ?? null, ingredient: approved.slug, input_hash: approved.input_hash });
            consumed = true;
          }, effect);
        },
      };
    },
  };
};
export type ScheduledLocalAuthority = ReturnType<typeof createScheduledLocalAuthority>;
