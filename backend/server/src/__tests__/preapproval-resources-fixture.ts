/** Local SQLite and real host composition. No provider account or network IO. */
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createStorageGate } from '@recued/storage-gate';
import { createWarehouseEventBus } from '@recued/warehouse-events';
import { createAuditLogStore, createCheckpointStore, createCommitStore, type AuditEntry } from '@recued/storage';
import type { CanonicalEvent, Checkpoint, Commit, IngredientManifest, PreparePreapproval,
  PreapprovalDecisionRequest, RecipeDefinition, RecordsAction, RecordsExecutionBinding, RecordsSchemaSnapshot } from '@recued/contracts';
import { createManifestRegistry } from '../manifest-loader.js';
import { createRecipeStore } from '../recipe-store.js';
import { createDishStore } from '../dish-store.js';
import { createDishGroupStore } from '../dish-group-store.js';
import { createScheduleStore } from '../schedule-store.js';
import { createAutoRunSettingsStore, createCircuitBreakerStore } from '../auto-run-scheduler.js';
import { createEventTriggersStore } from '../triggers/store.js';
import { createContractStore, createContractScanFn } from '../storage/contract-store.js';
import { createContractDefinitionStore } from '../storage/contract-definition-store.js';
import { createContractGrantEntryStore } from '../storage/contract-grant-entry-store.js';
import { createConnectionCatalogBindingStore } from '../storage/connection-catalog-binding-store.js';
import { createConnectionStore } from '../storage/connection-store.js';
import { createClientTokenStore } from '../pairing/client-tokens.js';
import { createChatInboundTokenStore, ensureChatInboundTokenSchema } from '../storage/chat-inbound-token-store.js';
import { createOpAdmissionGate } from '../op-admission-gate.js';
import { createContractOverlayResolver } from '../policy-contract-overlay.js';
import { createApprovalResumeAuthorityResolver } from '../approval-resume-authority.js';
import { createPreapprovalStorage } from '../storage/preapproval-storage.js';
import { GATED_ACTION_TABLE, createGatedActionStore, createSqliteGatedActionChangeClock,
  createSqliteGatedActionCompareAndSet, type GatedActionRecord } from '../gated-action-store.js';
import { composePreapproval } from '../composition/bin/wire-preapproval.js';
import { handleExecute, type ExecuteHandlerDeps } from '../execute-handler.js';
import { createSQLiteCollection } from '../sqlite-collection.js';
import { createInMemoryConnectionOperationProfileStore } from '../connection-operation-profile.js';
import type { PreapprovalOrigin } from '../preapproval-model.js';
import { createAskStore, createNotificationBlock, createNotificationSettingsStore, createUiChannel,
  type NotificationSettings, type PendingAsk } from '@recued/notification';
import { KERNEL_MANIFESTS } from '../kernel-manifests.js';
import { createBlobStore } from '../storage/blob-store.js';
import { createInstanceStore } from '../collections/instance-store.js';
import { composeCalendarStack } from '../collections/calendar/compose.js';
import { createLocalCalendarAdapterFactory, LOCAL_CALENDAR_CAPS } from '../collections/calendar/local-provider.js';
import { createRecordsStore } from '../records/store.js';
import { createResourceReviewHooks } from '../resource-review.js';
import { createCollectionRegistry } from '../collections/registry.js';
import { createMailCollection } from '../collections/mail/mail-collection.js';
import { handleCollectionMailSend } from '../collections/collection-handler.js';
import type { MailProvider } from '../collections/mail/provider.js';
import { createInboundFileCollection } from '../collections/file/inbound-file-collection.js';
import { handleFileRead } from '../collections/file/file-read-handler.js';

export const resourceFixtureDisposers: (() => void | Promise<void>)[] = [];

/** How long a crash test gives its child: a writer process that builds this fixture and kills
 *  itself at the commit boundary (`runCrashWriter`). A writer takes about 1 s alone, 2 s when
 *  tsx's cache is empty, so the limit is only there to report a hang.
 *  ⚠ Each writer used to be a nested vitest run, which started vitest and transformed the
 *  fixture's ~1,000 source modules again in every case: 4.4 s a case alone, 14–27 s in a quiet
 *  sweep and about 50 s at load 15–18, where a 60 s limit ended 13 cases before their writers
 *  had written any state (`d660df789`, 2026-10-22). */
export const CRASH_WRITER_LIMIT_MS = 180_000;
/** A crash case's own timeout: the child's limit, then reopening and checking what it left. */
export const CRASH_CASE_TIMEOUT_MS = CRASH_WRITER_LIMIT_MS + 60_000;

const root = resolve(import.meta.dirname, '../../../..');

/** Runs a crash test's writer module in a process of its own: tsx loads it against the package
 *  sources, as vitest does, and `request` is its input. Resolves once that process is gone. A
 *  writer kills itself with SIGKILL at its crash point, so the signal is what says it got there;
 *  what it printed is kept in `<dir>/expected-crash.log`. */
export const runCrashWriter = async (writer: URL, dir: string, request: object) => {
  const input = join(dir, 'request.json'); writeFileSync(input, JSON.stringify(request));
  const child = spawn(process.execPath, ['--import', pathToFileURL(join(root, 'node_modules/tsx/dist/loader.mjs')).href,
    fileURLToPath(writer), input],
  { cwd: root, env: { ...process.env, TSX_TSCONFIG_PATH: join(root, 'tsconfig.test.json') }, stdio: ['ignore', 'pipe', 'pipe'] });
  let trace = ''; child.stdout.on('data', bytes => { trace += String(bytes); }); child.stderr.on('data', bytes => { trace += String(bytes); });
  let stopped = false;
  const timer = setTimeout(() => { stopped = true; child.kill('SIGKILL'); }, CRASH_WRITER_LIMIT_MS);
  const signal = await new Promise<NodeJS.Signals | null>((done, reject) => {
    child.once('error', reject); child.once('close', (_code, signal) => done(signal));
  });
  clearTimeout(timer); writeFileSync(join(dir, 'expected-crash.log'), trace);
  return { stopped, signal, trace };
};

/** A writer module's entry. When this process was started on `moduleUrl`, runs `write` on the
 *  request its test passed. A writer that returns or throws instead of dying disposes of its
 *  fixtures, as a test's afterEach would, and exits with the error. */
export const crashWriterMain = async <Request>(moduleUrl: string, write: (request: Request) => Promise<void>) => {
  if (!process.argv[1] || realpathSync(process.argv[1]) !== realpathSync(fileURLToPath(moduleUrl))) return;
  try { await write(JSON.parse(readFileSync(process.argv[2]!, 'utf8')) as Request); } finally {
    for (const dispose of resourceFixtureDisposers.splice(0).reverse()) await dispose();
  }
};

const owner = { publisher: 'core', pack_slug: 'reviewed-notes' };
const binding = (action: RecordsAction): RecordsExecutionBinding => ({ kind: 'core.records', action,
  entity: 'note', owner, pack_version: 1, storage_schema_hash: 'a'.repeat(64), declaration_hash: 'b'.repeat(64), operation_digest: action });
const bindings = { create: binding('create'), update: binding('update'), delete: binding('delete'), upsert: binding('upsert'),
  batch: { ...binding('batch'), allow: (['create', 'update', 'upsert', 'delete'] as const).map(action => ({ entity: 'note', action })) } };
const schema: RecordsSchemaSnapshot = { decimal_scale: 4, entities: { note: { kind: 'note', fields: [
  { key: 'id', kind: 'id', slot: 'pk', required: true }, { key: 'title', kind: 'string', slot: 's1', required: true },
] } } };
export const recordsManifest: IngredientManifest = { slug: owner.pack_slug, name: 'Reviewed notes', description: 'Reviewed notes',
  author: owner.publisher, kind: 'storage', version: 1, category: 'data', risk_tier: 'read', input: { operation: null, args: null }, output: { result: 'result' },
  operations: Object.fromEntries(Object.keys(bindings).map(action => [action, { operation_id: 'fixture.note.' + action,
    risk_tier: action === 'delete' || action === 'batch' ? 'destructive' : 'write', approval: 'always', groups: ['notes.write'] }])),
  operation_groups: { 'notes.write': { group_id: 'notes.write', operations: Object.keys(bindings), risk_floor: 'write' } },
  surfaces: { records: { executes: bindings, schema } } };
export const recordStep = (id: string, row = id): RecipeDefinition['steps'][number] => ({ id, ingredient: recordsManifest.slug,
  input: { operation: 'update', args: { id: row, expected_version: 1, expected_revision: 0, set: { title: 'Reviewed ' + row } } } });
export const calendarStep = (id = 'meeting'): RecipeDefinition['steps'][number] => ({ id: 'calendar_' + id, ingredient: 'calendar-update',
  input: { slug: 'local', source_id: id, patch: { summary: 'Reviewed meeting' } } });

export const resourceFixture = async (previous?: { dir: string; clock: { now: number };
  token: Awaited<ReturnType<ReturnType<typeof createClientTokenStore>['issue']>> }, options: {
    mailProvider?: MailProvider; spies?: Pick<typeof import('vitest').vi, 'fn' | 'spyOn'>;
  } = {}) => {
  const vi = options.spies ?? (await import('vitest')).vi;
  const dir = previous?.dir ?? mkdtempSync(join(tmpdir(), 'recued-preapproval-resources-fixture-'));
  if (!previous) resourceFixtureDisposers.push(() => rmSync(dir, { recursive: true, force: true }));
  const clock = previous?.clock ?? { now: Date.now() }; const now = () => clock.now;
  const db = new Database(join(dir, 'realm.sqlite'));
  const storage = createPreapprovalStorage(db, createSqliteGatedActionChangeClock(db), () => new Uint8Array(32).fill(5), { now });
  const recipes = createRecipeStore('/no-community', db);
  const sources = { db, recipes, schedules: createScheduleStore(db), autoRun: createAutoRunSettingsStore(db),
    triggers: createEventTriggersStore(db), dishes: createDishStore(db), groups: createDishGroupStore(db) };
  const manifests = createManifestRegistry('/no-community', db);
  manifests.register(recordsManifest);
  for (const slug of ['calendar-update', 'calendar-delete']) manifests.register(KERNEL_MANIFESTS.find(row => row.slug === slug)!);
  const contracts = createContractStore(db);
  const definitions = createContractDefinitionStore(contracts);
  const grants = createContractGrantEntryStore(contracts);
  const opAdmissionGate = createOpAdmissionGate({ definitionStore: definitions, grantEntryStore: grants });
  const contractOverlay = createContractOverlayResolver({ definitionStore: definitions, grantEntryStore: grants });
  const connections = createConnectionStore(db);
  const clients = createClientTokenStore(db, { argon2_params: { t: 1, m: 8, p: 1 } });
  ensureChatInboundTokenSchema(db); const inbound = createChatInboundTokenStore(db);
  const token = previous?.token ?? await clients.issue({ client_kind: 'webclient', metadata: { instance_id: 'browser' } });
  const origin: PreapprovalOrigin = { mode: 'owner', owner_id: 'realm', entry: 'owner_ui', credential_id: token.token_id,
    credential_label: null, entry_tool_grants: [], recipe_grant_key: null, display_name: 'You',
    source: { channel: 'user', actor: 'user_self', user_id: 'realm', client_token_id: token.token_id } };
  const resumeAuthority = createApprovalResumeAuthorityResolver({ manifests, clientTokens: clients, inboundTokenStore: inbound,
    contractOverlay, opAdmissionGate, now });
  const changed = vi.fn(); const records = createRecordsStore(db, { now, onChange: changed });
  if (!records.getNamespace(owner)) {
    records.installNamespace({ owner, version: 1, storage_schema_hash: 'a'.repeat(64), declaration_hash: 'b'.repeat(64),
      artifact_digest: 'fixture', schema, bindings });
    for (const id of ['a', 'b']) records.execute({ binding: bindings.create, principal: 'owner', args: { id, values: { title: id } } });
    contracts.put('grant', [recordsManifest.slug, recordsManifest.slug, recordsManifest.slug, 'notes.write'], { allowed: true });
  }
  const bus = createWarehouseEventBus(); const instances = createInstanceStore({ db, now });
  const blobs = createBlobStore(join(dir, 'blobs'), { getEncryptionKey: () => new Uint8Array(32).fill(4) });
  if (!instances.get('calendar', 'local')) instances.upsert({ platform: 'calendar', slug: 'local', adapter_type: 'local', config: {},
    caps: LOCAL_CALENDAR_CAPS, auth_state: 'healthy', last_synced_at: null });
  let stack: ReturnType<typeof composeCalendarStack>;
  const calendarGate = createStorageGate({ quota: 1_000_000,reservePct: 0,surface: 'calendar-fixture' });
  stack = composeCalendarStack(db, { blobs, bus,
    getGate: () => calendarGate },
  { now, factories: [createLocalCalendarAdapterFactory({ now,
    readEvent: (_slug, id) => stack.listLive()[0]?.table.get(id)?.event ?? null })] });
  await stack.startAll(); const calendar = stack.listLive()[0]!;
  if (!previous && !calendar.table.get('meeting')) {
    const event: CanonicalEvent = { source_id: 'meeting', calendar_id: 'local', ical_uid: 'meeting@local', summary: 'Original meeting',
      start_at: now(), end_at: now() + 3600_000, timezone: 'UTC', is_all_day: false, status: 'confirmed', created_at: now(), updated_at: now() };
    calendar.table.upsert({ event, size_bytes: 0 });
  }
  const calendarUpdates = vi.spyOn(calendar.provider, 'updateEvent');
  const calendarDeletes = vi.spyOn(calendar.provider, 'deleteEvent');
  const profiles = { connectionStore: connections, getManifest: (slug: string) => manifests.get(slug),
    connectionCatalogBindingStore: createConnectionCatalogBindingStore(contracts) };
  const execution: ExecuteHandlerDeps = { recipeStore: recipes, baseVault: {}, recordsStore: records,
    executorConfig: { manifests, prepareLocalCalendarUpdate: input => stack.prepareLocalUpdate(input as Parameters<typeof stack.prepareLocalUpdate>[0]),
      resourceReview: createResourceReviewHooks({ manifest: slug => manifests.get(slug) ?? undefined,
      calendar: stack.reviewMutation, records, now }), kernelDispatchers: stack.kernelDispatchers },
    connectionStore: connections, connectionOperationProfiles: createInMemoryConnectionOperationProfileStore(),
    dishStore: sources.dishes, commitStore: createCommitStore(createSQLiteCollection<Commit>(db, 'commits')),
    auditLog: createAuditLogStore(createSQLiteCollection<AuditEntry>(db, 'audit_log')),
    checkpointStore: createCheckpointStore(createSQLiteCollection<Checkpoint>(db, 'checkpoints')),
    approvalResumeAuthority: resumeAuthority,
    gatedActionStore: createGatedActionStore(createSQLiteCollection<GatedActionRecord>(db, GATED_ACTION_TABLE), {
      compareAndSet: createSqliteGatedActionCompareAndSet(db), nextChangeSeq: createSqliteGatedActionChangeClock(db).nextChangeSeq }),
    opAdmissionGate, contractOverlay, contractScan: createContractScanFn(contracts) };
  const mail = options.mailProvider ? (() => {
    const registry = createCollectionRegistry(), provider = options.mailProvider;
    const fileCollection = createInboundFileCollection({ db, blobs, bus, slug: 'received',
      gate: createStorageGate({ quota: 20_000_000, reservePct: 0, surface: 'file-fixture' }) });
    registry.register(fileCollection);
    const collection = createMailCollection({ db, blobs, bus, slug: 'work', provider, now,
      gate: createStorageGate({ quota: 20_000_000, reservePct: 0, surface: 'mail-fixture' }),
      config: () => ({ quota_bytes: 20_000_000, backfill_days: 1, retention_days: 30 }),
      fileReadDeps: () => ({ registry, blobs, auditLog: execution.auditLog }) });
    registry.register(collection);
    if (!instances.get('mail', 'work')) instances.upsert({ platform: 'mail', slug: 'work', adapter_type: 'imap', config: { account_email: provider.accountEmail },
      caps: { read: 'yes', write: 'no', delete: 'no', watch: 'realtime', mirror: 'required', auth: 'keys', path_style: 'uri' },
      auth_state: 'healthy', last_synced_at: null });
    for (const slug of ['mail-send', 'mail-sent-reconcile', 'email-list', 'email-get', 'data-file-read']) manifests.register(KERNEL_MANIFESTS.find(row => row.slug === slug)!);
    execution.executorConfig.kernelDispatchers = { ...execution.executorConfig.kernelDispatchers,
      mailSend: input => handleCollectionMailSend({ registry }, input), dataFileRead: input => handleFileRead({ registry, blobs }, input) };
    return { registry, instances, blobs, collection, fileCollection };
  })() : undefined;
  const block = createNotificationBlock({ askStore: createAskStore(createSQLiteCollection<PendingAsk>(db, 'pending_asks')),
    settingsStore: createNotificationSettingsStore(createSQLiteCollection<NotificationSettings>(db, 'notification_settings')),
    channels: [createUiChannel({ busSink: () => {} })], now });
  const composed = composePreapproval({ ownerId: 'realm', storage, sources, circuits: createCircuitBreakerStore(db), execution,
    profiles, clientTokens: clients, definitions, inboundTokens: inbound, notifications: block,
    ...(mail ? { mail } : {}),
    reviewLink: id => 'https://owner.example/#approvals/preapproval/' + id, now });
  await storage.recover();
  const recipe: RecipeDefinition = { recipe_id: 'reviewed-resources', version: 1, ttl: 300,
    metadata: { name: 'Reviewed resource changes', description: 'Apply reviewed changes.', author: 'core', supported_platforms: [] },
    variables: {}, prefetch_steps: [], steps: [recordStep('a'), calendarStep(), recordStep('b')], output: { sidebar: [] } };
  if (!recipes.get(recipe.recipe_id)) recipes.save(recipe, 'core', 'inline');
  const request = (): PreparePreapproval => ({ idempotency_key: randomUUID(),
    subject: { kind: 'recipe', recipe_id: recipe.recipe_id, publisher_id: 'core', config: {} },
    activation: { kind: 'one_shot', run_at: now() + 60_000, time_zone: 'UTC' }, decision_deadline: now() + 30_000, dispatch_deadline: now() + 120_000 });
  const responder = { channel: 'webclient' as const, key: token.token_id };
  const decision = async (proposal_id: string): Promise<PreapprovalDecisionRequest> => {
    const review = await storage.repository.review(proposal_id, responder);
    return { proposal_id, expected_revision: review.revision, review_digest: review.review_digest,
      challenge: review.challenge, decision: 'approve', request_id: randomUUID() };
  };
  const run = async (futureRef: string) => {
    const plan = await storage.repository.loadExecution(futureRef); clock.now = plan.target.due_at!;
    const claimed = await composed.runtime.claim({ future_execution_ref: futureRef, occurrence_key: 'due:' + clock.now, occurrence_sequence: 1 });
    return handleExecute(execution, { recipe_id: recipe.recipe_id, config: plan.recipe_snapshots[0]!.effective_config,
      execution_source: plan.origin.source, ...composed.service.resolveOrigin(plan.origin) },
    { run_id: claimed.run_id, preapproval_run: claimed.handle });
  };
  let closed = false;
  const close = async () => { if (closed) return; closed = true; await stack.disposeAll(); bus.dispose(); db.close(); };
  resourceFixtureDisposers.push(close);
  changed.mockClear();
  return { db, dir, clock, token, storage, service: composed.service, runtime: composed.runtime, execution, sources, contracts, definitions, clients, grants, inbound,
    composed, block, manifests, records, bindings, schema, owner, calendar, calendarUpdates, calendarDeletes, calendarGate, bus, changed, origin, responder, recipe, request, decision, run, mail,
    row: (id: string) => records.ownerGet(owner, 'note', id),
    save: (steps: RecipeDefinition['steps']) => { recipe.steps = steps; recipes.save(recipe, 'core', 'inline'); },
    close, reopen: async () => { await close(); return resourceFixture({ dir, clock, token }, options); } };
};
