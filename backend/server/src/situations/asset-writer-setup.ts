import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { canonicalJSONStringify, RpcError, HOME_ASSISTANT_WRITER_SETUP as definition, type Asset, type AssetWriterReview,
  type AssetWriterSelection, type AssetWriterSetupChange, type AssetWriterSetupRead, type AssetWriterSetupReadRequest, type AssetWriterSetupStatus,
  type AssetWriterDeliveryOutcome, type ExecutionSource } from '@recued/contracts';
import { canonicalJsonString, canonicalRecipeDefinition, lowerOpStepRecipe } from '@recued/recipes';
import type { WorkEntityStore } from '../storage/work-entity-store.js';
import type { RecipeStore } from '../recipe-store.js';
import { createDish, updateDish, type DishHandlerDeps } from '../dish-handler.js';
import { createSchedule, updateSchedule, type ScheduleHandlerDeps } from '../schedule-handler.js';
import { commitLocalTransaction } from '../local-transaction.js';
import { EXECUTE_RESPONSE_AUDIT_RUN_ID, type ExecuteRequest, type ExecuteResponse } from '../types.js';
import type { HouseholdHomeAssistant } from './household-home-assistant.js';
import { mergeRecipeConfigLayers } from '../recipe-effective-config.js';

const digest = (value: unknown) => createHash('sha256').update(canonicalJSONStringify({ value: value ?? null })).digest('hex');
const INTERVALS = new Map([[5, '*/5 * * * *'], [15, '*/15 * * * *'], [30, '*/30 * * * *'], [60, '0 * * * *']]);
interface Setup {
  id: string; revision: number; request_id: string; review: AssetWriterReview;
  dish_id: string; schedule_id: string; binding_id: string; config: Record<string, unknown>; desired: boolean;
  verified?: boolean;
  last_run_id?: string;
  last_run?: NonNullable<AssetWriterSetupStatus['last_run']>;
}
export interface AssetWriterRuntime {
  dishes: DishHandlerDeps;
  schedules: ScheduleHandlerDeps;
  execute(request: ExecuteRequest): Promise<ExecuteResponse>;
}
export const createAssetWriterSetup = (deps: AssetWriterRuntime & {
  db: Database.Database; work: WorkEntityStore; recipes: RecipeStore;
  source: Pick<HouseholdHomeAssistant, 'writerConnections' | 'writerSources'>;
  isVaultUnlocked?(): boolean; now?(): number;
}) => {
  if ([deps.recipes.realmDatabase, deps.dishes.store.realmDatabase, deps.schedules.store.realmDatabase].some(db => db !== deps.db)) throw new Error('Writer setup stores must share the realm database');
  const now = deps.now ?? Date.now;
  deps.db.exec(`CREATE TABLE IF NOT EXISTS asset_writer_setup(id TEXT PRIMARY KEY, asset_id TEXT NOT NULL, dish_id TEXT NOT NULL UNIQUE, value TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS asset_writer_setup_asset ON asset_writer_setup(asset_id);
    CREATE INDEX IF NOT EXISTS asset_writer_setup_binding ON asset_writer_setup(json_extract(value,'$.binding_id'));`);
  const pending = new Map<string, Promise<AssetWriterSetupStatus>>();
  const get = (id: string): Setup | undefined => {
    const row = deps.db.prepare('SELECT value FROM asset_writer_setup WHERE id=?').get(id) as { value: string } | undefined;
    return row && JSON.parse(row.value) as Setup;
  };
  const save = (row: Setup) => deps.db.prepare('INSERT INTO asset_writer_setup(id,asset_id,dish_id,value) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET dish_id=excluded.dish_id,value=excluded.value')
    .run(row.id, row.review.selection.asset_id, row.dish_id, JSON.stringify(row));
  // Retired managed adapters must not leave their private schedules running.
  // Keep their history and assets; the installed pack can reconnect them through
  // its own recipes without the core retaining a provider-specific adapter.
  for (const stored of deps.db.prepare('SELECT value FROM asset_writer_setup').all() as { value: string }[]) {
    const row = JSON.parse(stored.value) as Setup;
    if (row.review.selection.definition_id === definition.id) continue;
    const dish = deps.dishes.store.get(row.dish_id); const schedule = deps.schedules.store.get(row.schedule_id);
    const binding = deps.work.listAssetObservationBindings(row.review.selection.asset_id).find(value => value.id === row.binding_id);
    if (!row.desired && !dish?.enabled && !schedule?.enabled && !binding?.enabled) continue;
    commitLocalTransaction(deps.db, () => {
      if (schedule) updateSchedule(deps.schedules, row.schedule_id, { enabled: false });
      if (dish) updateDish(deps.dishes, row.dish_id, { enabled: false });
      if (binding) deps.work.bindAssetObservations({ ...binding, enabled: false });
      row.desired = false; row.revision++; save(row);
    });
  }
  const idFor = (asset_id: string) => `aws_${digest([asset_id, definition.id]).slice(0, 32)}`;
  const asset = (id: string, active = true): Asset => {
    if (deps.isVaultUnlocked?.() === false) throw new Error('Unlock the vault to set up automatic updates');
    const row = deps.work.readAsset(id);
    if (!row || row.deleted_at != null || active && !['active', 'lent'].includes(row.status) || row.sync_state !== 'live') throw new Error('Choose an active local asset');
    return row;
  };
  const compatible = (row: Asset) => Object.keys(definition.fields).filter(path => {
    const [group, key] = path.split('.') as ['readings' | 'observations', string]; return Object.hasOwn(row[group], key);
  });
  const recipe = () => {
    const stored = deps.recipes.getStored(definition.recipe_id); const current = deps.recipes.get(definition.recipe_id);
    if (!stored || !current) throw new Error('Install the Home Assistant pack before setting up device updates');
    const bundled = deps.recipes.getBundled(definition.recipe_id);
    const hash = createHash('sha256').update(canonicalJsonString(canonicalRecipeDefinition(current))).digest('hex');
    // Pack installation lowers authored operations into engine ingredients.
    // Both representations must match this exact supported bundled recipe.
    const supported = bundled ? [bundled, lowerOpStepRecipe(bundled, new Map([[`recued-core.${definition.connection_slot}`, {
      catalog_slug: definition.connection_slot, operations: new Set(['state.read', 'history.list', 'logbook.list']),
    }]]))] : [];
    if (hash !== createHash('sha256').update(canonicalJsonString(canonicalRecipeDefinition(JSON.parse(stored.recipe_json)))).digest('hex')
      || stored.publisher_id !== 'recued-core'
      || !supported.some(value => hash === createHash('sha256').update(canonicalJsonString(canonicalRecipeDefinition(value))).digest('hex'))
      || [definition.asset_variable, definition.binding_variable, definition.source_variable, ...Object.values(definition.fields)].some(key => !current.variables?.[key])) throw new Error(`Update the installed Home Assistant pack to its supported version to use guided setup`);
    return { hash, publisher: stored.publisher_id };
  };
  const material = (selection: AssetWriterSelection, hash: string, revision: number) => ({ selection, hash, revision,
    asset: (() => { const current = asset(selection.asset_id); return { id: current.id, name: current.name, status: current.status,
      fields: selection.fields.map(path => { const [group, key] = path.split('.') as ['readings' | 'observations', string];
        return [path, current[group][key] ?? null, current.field_sources[path] ?? null, current.automatic_updates?.[path] ?? null]; }), settings: current.settings }; })() });
  const checkedSelection = (input: AssetWriterSelection): AssetWriterSelection => {
    if (!input || input.definition_id !== definition.id || typeof input.asset_id !== 'string' || typeof input.source_id !== 'string'
      || !INTERVALS.has(input.interval_minutes) || !Array.isArray(input.fields) || !input.fields.length
      || input.fields.length > Object.keys(definition.fields).length || new Set(input.fields).size !== input.fields.length) throw new Error('Choose a source, fields and update frequency');
    const allowed = compatible(asset(input.asset_id));
    if (input.fields.some(path => !allowed.includes(path))) throw new Error('Choose only fields this source can update on this asset');
    const connection = deps.source.writerConnections().find(row => row.name === input.connection?.name && row.enrolled_at === input.connection.enrolled_at && row.revision === input.connection.revision);
    if (!connection) throw new Error('The selected connection changed. Choose it again.');
    return { asset_id: input.asset_id, definition_id: definition.id, connection, source_id: input.source_id,
      fields: [...input.fields].sort(), interval_minutes: input.interval_minutes };
  };
  const issue = (row: Setup): string | undefined => {
    try {
      checkedSelection(row.review.selection);
      if (recipe().hash !== row.review.recipe_hash) return 'The recipe changed. Review this setup again.';
      const dish = deps.dishes.store.get(row.dish_id); const schedule = deps.schedules.store.get(row.schedule_id);
      if (!dish || !schedule || dish.recipe_id !== definition.recipe_id || dish.group_id
        || digest(dish.config_overlay) !== digest(row.config) || digest(dish.connections) !== digest({ [definition.connection_slot]: row.review.selection.connection.name })
        || schedule.dish_id !== dish.dish_id || schedule.recipe_id !== definition.recipe_id || schedule.cron_expression !== INTERVALS.get(row.review.selection.interval_minutes)) return 'The saved automation changed. Review this setup again.';
      const binding = deps.work.listAssetObservationBindings(row.review.selection.asset_id).find(value => value.id === row.binding_id);
      if (!binding?.enabled || binding.recipe_hash !== row.review.recipe_hash || digest(binding.fields) !== digest(row.review.selection.fields)) return 'The writer permission changed. Review this setup again.';
    } catch (error) { return error instanceof Error ? error.message : 'Review this setup again.'; }
  };
  const status = (row: Setup): AssetWriterSetupStatus => {
    const schedule = deps.schedules.store.get(row.schedule_id); const dish = deps.dishes.store.get(row.dish_id); const problem = issue(row);
    const currentRun = pending.has(row.id);
    const last = row.last_run?.outcome === 'running' && !currentRun ? { ...row.last_run, outcome: 'unknown' as const,
      message: 'The check was interrupted. Inspect the field receipts before running again.' } : row.last_run;
    const scheduledRun = schedule?.last_run_at && schedule.last_run_at > (last?.at ?? 0)
      ? { at: schedule.last_run_at, outcome: schedule.last_status === 'success' ? 'succeeded' as const
        : schedule.last_status === 'error' ? 'failed' as const : schedule.last_status === 'skipped' ? 'skipped' as const : 'unknown' as const,
        ...(schedule.last_error ? { message: schedule.last_error } : {}) } : undefined;
    return { id: row.id, revision: row.revision, name: definition.name, source_name: row.review.source.name,
      connection_label: row.review.selection.connection.label, selection: row.review.selection,
      fields: row.review.selection.fields, interval_minutes: row.review.selection.interval_minutes,
      state: problem ? 'needs_review' : currentRun ? 'running' : schedule?.enabled && dish?.enabled ? 'scheduled' : 'paused',
      scheduled: !!schedule?.enabled && !!dish?.enabled,
      can_resume: !!row.verified && !problem,
      ...(problem ? { issue: problem } : {}), ...(schedule?.enabled && dish?.enabled && schedule.next_run_at ? { next_run_at: schedule.next_run_at } : {}),
      ...((scheduledRun ?? last) ? { last_run: scheduledRun ?? last } : {}),
      deliveries: row.review.selection.fields.map(path => {
        const receipt = deps.db.prepare('SELECT at,observation_at,outcome,accepted_at,accepted_observation_at FROM asset_observation_delivery WHERE binding_id=? AND path=?')
          .get(row.binding_id, path) as { at: number; observation_at: number; outcome: AssetWriterDeliveryOutcome; accepted_at: number | null; accepted_observation_at: number | null } | undefined;
        return { path, delivery: receipt ? { status: 'recorded' as const,
          last_submission: { at: receipt.at, observation_at: receipt.observation_at, outcome: receipt.outcome },
          ...(receipt.accepted_at != null && receipt.accepted_observation_at != null ? { last_accepted: { at: receipt.accepted_at, observation_at: receipt.accepted_observation_at } } : {}) }
          : { status: 'no_receipt' as const } };
      }) };
  };
  const run = (row: Setup, owner: ExecutionSource, enable: boolean): Promise<AssetWriterSetupStatus> => {
    if (pending.has(row.id)) return pending.get(row.id)!;
    const problem = issue(row); if (problem) throw new Error(problem);
    const version = row.revision;
    row.last_run = { at: now(), outcome: 'running' }; delete row.last_run_id; save(row);
    // Defer execution until the promise is registered; a replay never starts another check.
    const operation = Promise.resolve().then(async () => {
      let outcome: NonNullable<Setup['last_run']>;
      let runId: string | undefined;
      try {
        const result = await deps.execute({ recipe_id: definition.recipe_id, dish_id: row.dish_id,
          trigger_source: 'manual', execution_source: owner });
        runId = result[EXECUTE_RESPONSE_AUDIT_RUN_ID];
        const hasReceipt = !!deps.db.prepare('SELECT 1 FROM asset_observation_delivery WHERE binding_id=? AND run_id=? LIMIT 1')
          .get(row.binding_id, result[EXECUTE_RESPONSE_AUDIT_RUN_ID] ?? '');
        const completed = result.success && !result.awaiting_approval && !result.awaiting_peer && !result.trigger_skipped;
        outcome = { at: now(), outcome: result.awaiting_approval || result.awaiting_peer ? 'waiting' : result.trigger_skipped ? 'skipped' : completed ? 'succeeded' : 'failed',
          ...(result.awaiting_approval ? { message: 'This check is waiting for approval. Its schedule remains paused. Review it in Approvals.' }
            : result.awaiting_peer ? { message: 'This check is waiting for another service. Its schedule remains paused.' }
            : result.trigger_skipped ? { message: 'This check was skipped. Its schedule remains paused.' }
            : !completed ? { message: 'The check did not finish successfully. Review its run in Runs.' }
            : !hasReceipt ? { message: 'The check finished without a field submission. Conditions may still be unknown or waiting to settle.' } : {}) };
      } catch { outcome = { at: now(), outcome: 'unknown', message: 'The check could not be confirmed. Inspect the field receipts and Runs before trying again.' }; }
      const current = get(row.id)!;
      current.last_run = outcome;
      if (runId) current.last_run_id = runId; else delete current.last_run_id;
      if (outcome.outcome === 'succeeded') current.verified = true;
      if (enable && current.revision === version && current.desired && outcome.outcome === 'succeeded' && !issue(current)) {
        try { updateSchedule(deps.schedules, current.schedule_id, { enabled: true }); }
        catch { outcome.message = 'The first check finished, but the schedule could not start. Review setup before resuming.'; }
      }
      save(current); return current;
    }).then(current => { pending.delete(row.id); return status(current); }, error => { pending.delete(row.id); throw error; });
    pending.set(row.id, operation); return operation;
  };
  return {
    async read(input: AssetWriterSetupReadRequest): Promise<AssetWriterSetupRead> {
      if (input.definition_id !== undefined && input.definition_id !== definition.id) throw new Error('Choose a supported automatic source');
      const current = asset(input.asset_id, false); let available = true; try { recipe(); } catch { available = false; }
      const rows = deps.db.prepare('SELECT value FROM asset_writer_setup WHERE asset_id=?').all(input.asset_id) as { value: string }[];
      const activeRows = rows.filter(saved => (JSON.parse(saved.value) as Setup).review.selection.definition_id === definition.id);
      // A parked check can settle later through Approvals. Consult its exact
      // private audit anchor, never infer whole-run success from a field receipt.
      for (const saved of activeRows) {
        const row = JSON.parse(saved.value) as Setup;
        if (!row.last_run_id || !['waiting', 'unknown'].includes(row.last_run?.outcome ?? '') || !deps.dishes.auditLog) continue;
        try {
          const entry = await deps.dishes.auditLog.get(row.last_run_id);
          asset(input.asset_id, false); const latest = get(row.id);
          if (!latest || latest.revision !== row.revision || latest.last_run_id !== row.last_run_id
            || latest.last_run?.outcome !== row.last_run?.outcome || latest.last_run?.at !== row.last_run?.at) continue;
          if (!entry || entry.commit_status === 'in_doubt') {
            latest.last_run = { at: latest.last_run!.at, outcome: 'unknown', message: 'The execution outcome cannot be confirmed. Check field receipts and Runs before trying again.' }; save(latest); continue;
          }
          if (entry.dish_id !== row.dish_id) continue;
          if (entry.commit_status === 'succeeded') { latest.verified = true; latest.last_run = { at: latest.last_run!.at,
            outcome: 'succeeded', message: 'The reviewed check finished. Resume scheduled updates when ready.' }; save(latest); }
          else if (['failed', 'cancelled', 'killed', 'obsolete'].includes(entry.commit_status)) {
            latest.last_run = { at: latest.last_run!.at, outcome: 'failed', message: 'The reviewed check ended without success. Its schedule remains paused.' }; save(latest);
          }
        } catch { /* A missing audit read cannot establish completion. */ }
      }
      asset(input.asset_id, false);
      return { definitions: [{ id: definition.id, name: definition.name, fields: compatible(current), available }],
        connections: deps.source.writerConnections(), ...(input.connection ? await deps.source.writerSources(input.connection) : {}),
        setups: activeRows.flatMap(saved => { const row = get((JSON.parse(saved.value) as Setup).id); return row ? [status(row)] : []; }) };
    },
    async preview(input: AssetWriterSelection): Promise<AssetWriterReview> {
      const selection = checkedSelection(input); const installed = recipe(); const previous = get(idFor(selection.asset_id));
      const before = digest(material(selection, installed.hash, previous?.revision ?? 0));
      const source = (await deps.source.writerSources(selection.connection)).sources.find(row => row.id === selection.source_id);
      if (!source || selection.fields.some(field => !source.fields.includes(field))) throw new Error('Choose a compatible device and fields');
      const review_hash = digest(material(checkedSelection(selection), recipe().hash, get(idFor(selection.asset_id))?.revision ?? 0));
      if (review_hash !== before) throw new Error('The asset, source or recipe changed during review. Preview it again.');
      return { selection, recipe_hash: installed.hash, review_hash, setup_revision: previous?.revision ?? 0, source, asset_name: asset(selection.asset_id).name };
    },
    async change(input: AssetWriterSetupChange, owner: ExecutionSource): Promise<AssetWriterSetupStatus> {
      if (input?.action === 'configure') {
        if (typeof input.request_id !== 'string' || !/^[a-zA-Z0-9_-]{8,100}$/u.test(input.request_id) || !input.review) throw new Error('A setup request id and review are required');
        const review = input.review; const selection = checkedSelection(review.selection); const id = idFor(selection.asset_id); const prior = get(id);
        if (prior?.request_id === input.request_id) {
          if (digest(prior.review.selection) !== digest(selection) || prior.review.review_hash !== review.review_hash) throw new Error('This request id belongs to a different review');
          return status(prior);
        }
        if (pending.has(id)) throw new Error('A check is still running. Wait for its result before changing setup.');
        const installed = recipe(); const revision = prior?.revision ?? 0;
        if (review.recipe_hash !== installed.hash || review.setup_revision !== revision
          || review.review_hash !== digest(material(selection, installed.hash, revision))) throw new Error('This setup changed. Preview and approve it again.');
        // Re-read the chosen device, then recheck every local review fence after the await.
        const source = (await deps.source.writerSources(selection.connection)).sources.find(value => value.id === selection.source_id);
        if (!source || selection.fields.some(field => !source.fields.includes(field))) throw new Error('Review the selected device again');
        const afterRead = get(id);
        if (afterRead?.request_id === input.request_id) {
          if (digest(afterRead.review.selection) !== digest(selection) || afterRead.review.review_hash !== review.review_hash) throw new Error('This request id belongs to a different review');
          return status(afterRead);
        }
        if (pending.has(id) || (afterRead?.revision ?? 0) !== revision || recipe().hash !== installed.hash
          || review.review_hash !== digest(material(checkedSelection(selection), installed.hash, revision))) throw new Error('This setup changed. Preview and approve it again.');
        const binding_id = `binding-${digest([id, revision + 1, installed.hash])}`;
        const config = { [definition.asset_variable]: selection.asset_id, [definition.binding_variable]: binding_id,
          [definition.source_variable]: selection.source_id, ...Object.fromEntries(Object.entries(definition.fields).map(([path, key]) => [key, selection.fields.includes(path)])) };
        const next = commitLocalTransaction(deps.db, () => {
          if (prior) { updateSchedule(deps.schedules, prior.schedule_id, { enabled: false }); updateDish(deps.dishes, prior.dish_id, { enabled: false });
            const old = deps.work.listAssetObservationBindings(selection.asset_id).find(binding => binding.id === prior.binding_id); if (old) deps.work.bindAssetObservations({ ...old, enabled: false }); }
          const dishSettings = { name: `${asset(selection.asset_id).name} · ${source.name}`, config_overlay: config,
            connections: { [definition.connection_slot]: selection.connection.name }, enabled: true };
          const dish = prior ? updateDish(deps.dishes, prior.dish_id, dishSettings).dish
            : createDish(deps.dishes, { ...dishSettings, recipe_id: definition.recipe_id, publisher_id: installed.publisher }, { switchOn: false }).dish;
          const schedule = prior ? updateSchedule(deps.schedules, prior.schedule_id, { cron_expression: INTERVALS.get(selection.interval_minutes), enabled: false }).schedule
            : createSchedule({ ...deps.schedules, recipeStore: deps.recipes }, { recipe_id: definition.recipe_id,
              publisher_id: installed.publisher, dish_id: dish.dish_id, cron_expression: INTERVALS.get(selection.interval_minutes), enabled: false }).schedule;
          deps.work.bindAssetObservations({ id: binding_id, asset_id: selection.asset_id, actor_ref: `recipe:${definition.recipe_id}`,
            source_ref: `recipe:${installed.publisher}/${definition.recipe_id}#${installed.hash}/${id}/${revision + 1}`, recipe_hash: installed.hash, fields: selection.fields, enabled: true });
          const savedReview: AssetWriterReview = { selection, source, recipe_hash: installed.hash, review_hash: review.review_hash,
            setup_revision: revision, asset_name: asset(selection.asset_id).name };
          const row: Setup = { id, revision: revision + 1, request_id: input.request_id, review: savedReview,
            dish_id: dish.dish_id, schedule_id: schedule.schedule_id, binding_id, config, desired: true };
          save(row); return row;
        });
        return run(next, owner, true);
      }
      if (!input || !['run', 'pause', 'resume'].includes(input.action)) throw new Error('Choose a supported update action');
      asset(input.asset_id, input.action !== 'pause'); const row = get(input.setup_id);
      if (!row || row.review.selection.asset_id !== input.asset_id || row.revision !== input.revision) throw new Error('This setup changed. Refresh it before continuing.');
      if (input.action === 'run') {
        if (row.last_run?.outcome === 'waiting') throw new Error('Finish or decline the waiting check in Approvals, then refresh status before running again.');
        return run(row, owner, false);
      }
      if (input.action === 'resume') { const problem = issue(row); if (problem) throw new Error(problem);
        if (!row.verified) throw new Error('Run a successful check before starting this schedule.'); }
      commitLocalTransaction(deps.db, () => {
        if (deps.dishes.store.get(row.dish_id)) updateDish(deps.dishes, row.dish_id, { enabled: input.action === 'resume' });
        if (deps.schedules.store.get(row.schedule_id)) updateSchedule(deps.schedules, row.schedule_id, { enabled: input.action === 'resume' });
        row.desired = input.action === 'resume'; row.revision++; save(row);
      });
      return status(row);
    },
    /** Every entry to execute (including schedules and the generic Run dialog) pins
     * this setup's account and refuses edits that would move its approved source. */
    prepareRun(request: ExecuteRequest): ExecuteRequest {
      const inlineId = request.recipe && typeof request.recipe === 'object' ? (request.recipe as { recipe_id?: unknown }).recipe_id : undefined;
      const recipeId = request.recipe ? (typeof inlineId === 'string' ? inlineId : undefined) : request.recipe_id;
      if (recipeId !== definition.recipe_id) return request;
      const dish = request.dish_id ? deps.dishes.store.get(request.dish_id) : deps.dishes.store.getDefault(recipeId);
      const effective = mergeRecipeConfigLayers({ ...(request.config ? { requested: request.config } : {}),
        ...(dish ? request.dish_id ? { bound_dish: { config_overlay: dish.config_overlay,
          ...(dish.group_id ? { group_overlay: deps.dishes.groupStore?.get(dish.group_id)?.config_overlay ?? {} } : {}) } }
          : { install: dish.config_overlay } : {}) });
      const binding = effective[definition.binding_variable];
      const protectedBinding = typeof binding === 'string'
        ? deps.db.prepare("SELECT dish_id FROM asset_writer_setup WHERE json_extract(value,'$.binding_id')=?").get(binding) as { dish_id: string } | undefined : undefined;
      if (protectedBinding && protectedBinding.dish_id !== dish?.dish_id) throw new RpcError('conflict', 'Run this source through its reviewed setup in Yours.', 409);
      if (!dish) return request;
      const stored = deps.db.prepare('SELECT value FROM asset_writer_setup WHERE dish_id=?').get(dish.dish_id) as { value: string } | undefined;
      if (!stored) return request;
      const row = JSON.parse(stored.value) as Setup; const problem = issue(row);
      if (problem) throw new RpcError('conflict', problem, 409);
      if (request.recipe || request.recipe_id !== definition.recipe_id || Object.entries(request.config ?? {}).some(([key, value]) => digest(value) !== digest(row.config[key]))
        || Object.entries(request.connections ?? {}).some(([slot, name]) => slot !== definition.connection_slot || name !== row.review.selection.connection.name)
        || request.connection_revisions?.[row.review.selection.connection.name] !== undefined
          && request.connection_revisions[row.review.selection.connection.name] !== row.review.selection.connection.revision) throw new RpcError('conflict', 'Review source or setting changes in Yours before running this automation', 409);
      // A run without a dish id still consumes its main dish's settings. Freeze
      // those inputs now so a later dish edit cannot move an admitted check.
      return { ...request, config: { ...row.config, ...request.config },
        connections: { [definition.connection_slot]: row.review.selection.connection.name },
        connection_revisions: { ...request.connection_revisions, [row.review.selection.connection.name]: row.review.selection.connection.revision } };
    },
    async stop() { await Promise.allSettled([...pending.values()]); },
  };
};
export type AssetWriterSetup = ReturnType<typeof createAssetWriterSetup>;
