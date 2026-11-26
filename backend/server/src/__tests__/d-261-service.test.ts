import Database from 'better-sqlite3';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStorageGate } from '@recued/storage-gate';
import { createWarehouseEventBus, type WarehouseEvent } from '@recued/warehouse-events';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { createInternalToolRegistry } from '@recued/middleware/internal-tool-registry/index.js';
import { createAuditLogStore, createCheckpointStore, createCommitStore, type AuditEntry } from '@recued/storage';
import type { Checkpoint, Commit } from '@recued/contracts';
import { RpcError, isMcpInboundTokenToolAuthorized, opGrantEntry, preapprovalChildPath, type MailDraft } from '@recued/contracts';
import type { IngredientManifest, PreparePreapproval, PreapprovalDecisionRequest, PreapprovalInspection, PreapprovalReview, RecipeDefinition } from '@recued/contracts';
import { createManifestRegistry } from '../manifest-loader.js';
import { createRecipeStore } from '../recipe-store.js';
import { createDishStore } from '../dish-store.js';
import { createDishGroupStore } from '../dish-group-store.js';
import { createScheduleStore } from '../schedule-store.js';
import { createAutoRunSettingsStore, createCircuitBreakerStore, createServerAutoRunScheduler } from '../auto-run-scheduler.js';
import { createEventTriggersStore } from '../triggers/store.js';
import { composeEventTriggers } from '../composition/bin/wire-event-triggers.js';
import { createContractStore, createContractScanFn } from '../storage/contract-store.js';
import { createContractDefinitionStore } from '../storage/contract-definition-store.js';
import { createContractGrantEntryStore } from '../storage/contract-grant-entry-store.js';
import { createConnectionCatalogBindingStore } from '../storage/connection-catalog-binding-store.js';
import { createConnectionStore } from '../storage/connection-store.js';
import { createClientTokenStore } from '../pairing/client-tokens.js';
import { createOpAdmissionGate } from '../op-admission-gate.js';
import { createContractOverlayResolver } from '../policy-contract-overlay.js';
import { createApprovalResumeAuthorityResolver } from '../approval-resume-authority.js';
import { createPreapprovalOriginAuthority } from '../preapproval-origin-authority.js';
import { createPreapprovalStorage } from '../storage/preapproval-storage.js';
// D-201 Slice 10AZ — the answers the restart harnesses' runtime gives an ordinary run.
import { ORDINARY_RUN_PREAPPROVAL_ANSWERS } from './ordinary-run-preapproval-runtime.js';
import { GATED_ACTION_TABLE, createGatedActionStore, createSqliteGatedActionChangeClock, createSqliteGatedActionCompareAndSet, type GatedActionRecord } from '../gated-action-store.js';
import { createPreapprovalActivations } from '../storage/preapproval-activations.js';
import { createPreapprovalService } from '../preapproval-service.js';
import { createPreapprovalExecutionRuntime } from '../preapproval-execution.js';
import { createPreapprovalDriver } from '../preapproval-driver.js';
import { createScheduler } from '../scheduler.js';
import { handleExecute, type ExecuteHandlerDeps } from '../execute-handler.js';
import { createPreflightResumer } from '../preflight-resumer.js';
import { createSQLiteCollection } from '../sqlite-collection.js';
import { wireCatalogOperationProfiles } from '../connection-operation-profile-boot.js';
import { createInMemoryConnectionOperationProfileStore } from '../connection-operation-profile.js';
import type { PreapprovalOrigin } from '../preapproval-model.js';
import { composePreapproval } from '../composition/bin/wire-preapproval.js';
import { createAskStore, createNotificationBlock, createNotificationSettingsStore, createUiChannel,
  type NotificationSettings, type PendingAsk } from '@recued/notification';
import { startServer } from '../server.js';
import { WebSocket, WebSocketServer } from 'ws';
import { createWsConnect } from '../mcp-ws-connector.js';
import { createStdioSpawn } from '../mcp-stdio-spawner.js';
import type { StdioClientHandle } from '@recued/ingredients';
import { createCliReachabilityResolver, createCliReachabilityStore } from '../storage/cli-reachability-store.js';
import { KERNEL_MANIFESTS } from '../kernel-manifests.js';
import { createMcpHttpDispatch } from '../mcp-server.js';
import { createChatInboundTokenStore, ensureChatInboundTokenSchema } from '../storage/chat-inbound-token-store.js';
import { fixtureRecipe } from './d-261-fixtures.js';
import { createBlobStore } from '../storage/blob-store.js';
import { createCollectionRegistry } from '../collections/registry.js';
import { createInstanceStore } from '../collections/instance-store.js';
import { createInboundFileCollection } from '../collections/file/inbound-file-collection.js';
import { createMailCollection } from '../collections/mail/mail-collection.js';
import type { MailProvider, OutgoingMessage } from '../collections/mail/provider.js';
import { handleCollectionMailSend } from '../collections/collection-handler.js';
import { handleFileRead } from '../collections/file/file-read-handler.js';
import { listCollectionReferencedBlobHashes } from '../storage/collection-blob-refs.js';
import { createCollectionTable } from '../collections/table.js';
import { GATED_ACTION_TERMINAL_RETENTION_MS } from '../gated-action-store.js';
import { createLLMConfigManager } from '../llm-config.js';
import { createQuotaTracker, endpointFingerprint, hydrateEndpointCapabilities } from '@recued/llm';
import { createBridgeRegistry } from '../bridges/registry.js';
import { describeBridgeDomCall } from '../bridges/dom-adapter.js';
import { createReviewedBrowserFixture } from './d-261-browser-fixture.js';
import type { BridgeCommand, BridgeCapabilityProfile } from '@recued/contracts';
import { primitiveGrantEntry, recipeGrantEntry, OWNER_CONTRACT_ID } from '@recued/contracts';
import { createChatStore, ensureChatSchema } from '../storage/chat-store.js';
import { buildChatToolRegistryInputs } from '../chat-tool-handlers.js';
import { createChatOrchestrator, type BroadcastChatEvent } from '../chat-orchestrator.js';
import { planApproval } from '@recued/gateway';
import { dispatchPeerAsk } from '../peer-ask-dispatch.js';
import { createPeerAnswerStore } from '../storage/peer-answer-store.js';
import { createPeerAskOutboxStore } from '../storage/peer-ask-outbox-store.js';
import { resumePeerHold } from '../peer-hold-resumer.js';
import { receiveAnswer } from '../peer-answer-return.js';
import { PEER_RECEIVE_ASK_TOOL } from '../peer-receive-ask-recipe.js';

const databases: Database.Database[] = [];
const servers: Server[] = [];
const mcpSockets: WebSocketServer[] = [];
const mcpProcesses: StdioClientHandle[] = [];
const directories: string[] = [];
const ownerRpc = <T>(socket: WebSocket, method: string, args: unknown = {}): Promise<T> => new Promise((resolve, reject) => {
  const request_id = randomUUID();
  const timeout = setTimeout(() => { socket.off('message', receive); reject(new Error('Owner RPC timed out')); }, 5_000);
  const receive = (bytes: import('ws').RawData) => {
    const reply = JSON.parse(bytes.toString()) as { request_id?: string; result?: T; error?: { code: string; message: string } };
    if (reply.request_id !== request_id) return;
    clearTimeout(timeout); socket.off('message', receive);
    if (reply.error) reject(new Error(reply.error.code + ': ' + reply.error.message));
    else resolve(reply.result as T);
  };
  socket.on('message', receive); socket.send(JSON.stringify({ type: 'rpc', request_id, method, args }));
});
afterEach(async () => {
  for (const process of mcpProcesses.splice(0)) process.close();
  for (const server of mcpSockets.splice(0)) {
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  for (const db of databases.splice(0)) db.close();
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const catalog: IngredientManifest = { slug: 'review-catalog', name: 'CRM', description: 'Reviewed CRM calls', author: 'test',
  kind: 'connection', category: 'data', risk_tier: 'read', input: {}, output: {},
  operations: { 'item.write': { operation_id: 'test/catalog.item.write', risk_tier: 'write', approval: 'ask', groups: [] } },
  surfaces: { api: { transport: 'rest', default_base_url: 'https://crm.example.test/v1', auth: { kind: 'none' }, executes: {
    'item.write': { kind: 'rest', method: 'POST', path_template: '/items/{{id}}', static_body: { reviewed: 'yes' } },
  } } },
};
const mcpCatalog: IngredientManifest = { ...catalog, slug: 'review-mcp', name: 'MCP workspace',
  operations: { 'item.write': { operation_id: 'test/mcp.item.write', risk_tier: 'write', approval: 'ask', groups: [] } },
  surfaces: { api: { transport: 'mcp', default_base_url: '', auth: { kind: 'none' },
    executes: { 'item.write': { kind: 'mcp', tool: 'item.create' } } } } };
const fixture = async (approval: 'ask' | 'never' = 'ask', holdFirst = false, productionComposition = false, withMail = false,
  withMcp: boolean | 'websocket' | 'stdio' = false, withCli = false, withAi = false) => {
  const provider = { dropResponse: false, rejectJson: false,
    watch: { qualifies: false, count: 0, beforeRespond: undefined as (() => Promise<void>) | undefined } };
  const received: Array<{ url: string; method: string; body: unknown }> = [];
  const aiReceived: Record<string, unknown>[] = [];
  const uploads: Array<{ bytes: Buffer; content_type: string | undefined }> = [];
  const mcpReceived: Array<{ method: string; params: Record<string, unknown> }> = [];
  const mcpResponse = (body: { id: number; method: string; params?: { name?: string } }) => ({ jsonrpc: '2.0', id: body.id,
    result: body.method === 'server/discover' ? { supportedVersions: ['2026-07-28'], capabilities: { tools: {} } }
      : body.params?.name === PEER_RECEIVE_ASK_TOOL ? { structuredContent: { accepted: true, ask_id: 'controlled-peer-question' } }
      : { content: [{ type: 'text', text: '{"created":true}' }] } });
  const processDir = withMcp === 'stdio' || withCli ? mkdtempSync(join(tmpdir(), 'd261-process-')) : null;
  if (processDir) directories.push(processDir);
  const processFiles = processDir ? { mcp: join(processDir, 'mcp.mjs'), mcp_log: join(processDir, 'mcp.jsonl'),
    cli: join(processDir, 'cli.mjs'), cli_log: join(processDir, 'cli.txt') } : null;
  if (processFiles) {
    writeFileSync(processFiles.mcp, `import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
createInterface({ input: process.stdin }).on('line', line => {
  const body = JSON.parse(line); appendFileSync(process.argv[2], line + '\\n');
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: body.id,
    result: body.method === 'server/discover' ? { supportedVersions: ['2026-07-28'], capabilities: { tools: {} } }
      : { content: [{ type: 'text', text: '{"created":true}' }] } }) + '\\n');
});`);
    writeFileSync(processFiles.cli, `import { appendFileSync, existsSync } from 'node:fs';
appendFileSync(process.argv[2], process.argv[3] + '\\n');
if (existsSync(process.argv[2] + '.fail')) process.exit(1); process.stdout.write('completed');`);
  }
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks);
    if (request.url === '/v1/upload') {
      uploads.push({ bytes: raw, content_type: request.headers['content-type'] });
      if (provider.dropResponse) { response.destroy(); return; }
      response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"uploaded":true}'); return;
    }
    if (request.url === '/v1/watch') {
      provider.watch.count++;
      await provider.watch.beforeRespond?.();
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ should_run: provider.watch.qualifies })); return;
    }
    const body = raw.length ? JSON.parse(raw.toString()) : null;
    if (request.url === '/v1/chat/completions') {
      aiReceived.push(body);
      if (provider.dropResponse) { response.destroy(); return; }
      if (provider.rejectJson) {
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'response_format json_object is not supported' } })); return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ summary: 'Reviewed result', key_points: ['Pinned input'] }) },
        finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 } })); return;
    }
    if (request.url === '/mcp') {
      mcpReceived.push(body);
      if (provider.dropResponse && body.method === 'tools/call') { response.destroy(); return; }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(mcpResponse(body)));
      return;
    }
    received.push({ url: request.url!, method: request.method!, body });
    if (provider.dropResponse) { response.destroy(); return; }
    response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"ok":true}');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); servers.push(server);
  if (withMcp === 'websocket') {
    const ws = new WebSocketServer({ server, path: '/mcp' }); mcpSockets.push(ws);
    ws.on('connection', socket => socket.on('message', bytes => {
      const body = JSON.parse(bytes.toString()); mcpReceived.push(body);
      socket.send(JSON.stringify(mcpResponse(body)));
    }));
  }
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No test HTTP listener');
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;
  const clock = { now: Date.now() }; const now = () => clock.now;
  const db = new Database(':memory:'); databases.push(db);
  const storage = createPreapprovalStorage(db, createSqliteGatedActionChangeClock(db), () => new Uint8Array(32).fill(5), { now });
  const recipes = createRecipeStore('/no-community', db);
  const sources = { db, recipes, schedules: createScheduleStore(db), autoRun: createAutoRunSettingsStore(db),
    triggers: createEventTriggersStore(db), dishes: createDishStore(db), groups: createDishGroupStore(db) };
  const manifests = createManifestRegistry('/no-community', db); manifests.register({ ...catalog,
    operations: { 'item.write': { ...catalog.operations!['item.write']!, approval },
      ...(holdFirst ? { 'item.confirm': { ...catalog.operations!['item.write']!, operation_id: 'test/catalog.item.confirm', approval: 'always' as const } } : {}) },
    ...(holdFirst ? { surfaces: { api: { ...catalog.surfaces!.api!, executes: {
      ...catalog.surfaces!.api!.executes, 'item.confirm': catalog.surfaces!.api!.executes['item.write']!,
    } } } } : {}),
  });
  const contracts = createContractStore(db);
  const llm = createLLMConfigManager(db);
  const llmQuota = createQuotaTracker();
  if (withAi) {
    llm.setSlot1({ provider: 'openai-compatible', model: 'reviewed-model', api_key: 'test-owner-secret',
      base_url: baseUrl, speed: 'quality', supports_json: true, modalities: { image: true, document: true, audio: true } });
    for (const slug of ['ai-summarize', 'ai-prompt']) {
      manifests.register(KERNEL_MANIFESTS.find(manifest => manifest.slug === slug)!);
      contracts.put('owner_operation', [slug, slug], { approval: 'ask', op_hash: `review-${slug}` });
    }
  }
  const cliReach = createCliReachabilityStore(contracts);
  if (withCli) {
    cliReach.allow('user_self', 'review-cli', 'item.write', now());
    manifests.register({ ...catalog, slug: 'review-cli', name: 'Reviewed local tool',
      operations: { 'item.write': { operation_id: 'test/cli.item.write', risk_tier: 'write', approval: 'ask', groups: [] } },
      surfaces: { connector: {
        runtime: { transport: 'stdio', wire_protocol: 'cli_invocation', package_ref: 'system_binary:node', entry_point: 'node', expected_protocol_version: 1 },
        lifecycle: { auth: { method: 'none' }, connect: { idempotent: true, startup_timeout_ms: 5000 },
          invoke: { default_method_timeout_ms: 5000 }, disconnect: { graceful_shutdown_timeout_ms: 1000 },
          reconnect_policy: 'manual_only', persistent_connection: false, idle_disconnect_ms: 0 },
        executes: { 'item.write': { kind: 'cli_invocation', argv_template: [process.execPath, processFiles!.cli, processFiles!.cli_log, '{message}'],
          shape: 'text', exit_code_handling: 'zero_is_success' } },
      } } });
  }
  const definitionStore = createContractDefinitionStore(contracts);
  const grantEntryStore = createContractGrantEntryStore(contracts);
  const opAdmissionGate = createOpAdmissionGate({ definitionStore, grantEntryStore });
  const contractOverlay = createContractOverlayResolver({ definitionStore, grantEntryStore });
  const connections = createConnectionStore(db);
  connections.upsert({ kind: 'api', name: 'crm', display_name: 'Reviewed CRM account', enrolled_at: 1, updated_at: 1,
    auth_ciphertext: 'opaque-encrypted-credential', config_json: JSON.stringify({ base_url: baseUrl }) });
  const bindings = createConnectionCatalogBindingStore(contracts); bindings.bind('crm', catalog.slug, 'test-pack');
  if (withMcp) {
    manifests.register(mcpCatalog);
    connections.upsert({ kind: 'mcp', name: 'workspace', display_name: 'Reviewed MCP account', enrolled_at: 1, updated_at: 1,
      auth_ciphertext: 'opaque-mcp-credential', subtype: withMcp === 'stdio' ? 'stdio' : withMcp === 'websocket' ? 'websocket' : 'sse',
      config_json: JSON.stringify(withMcp === 'stdio' ? { command: process.execPath, args: [processFiles!.mcp, processFiles!.mcp_log] }
        : { endpoint: `${withMcp === 'websocket' ? 'ws' : 'http'}://127.0.0.1:${address.port}/mcp` }),
      health_json: JSON.stringify({ status: 'ok', tools: ['item.create'],
        mcp_tool_schemas: { 'item.create': { type: 'object', properties: { title: { type: 'string' } } } } }) });
    bindings.bind('workspace', mcpCatalog.slug, 'test-mcp-pack');
  }
  const clients = createClientTokenStore(db, { argon2_params: { t: 1, m: 8, p: 1 } });
  ensureChatInboundTokenSchema(db);
  const inbound = createChatInboundTokenStore(db);
  const token = await clients.issue({ client_kind: 'webclient', metadata: { instance_id: 'browser' } });
  const origin: PreapprovalOrigin = { mode: 'owner', owner_id: 'realm', entry: 'owner_ui', credential_id: token.token_id,
    credential_label: null, entry_tool_grants: [], recipe_grant_key: null, display_name: 'You',
    source: { channel: 'user', actor: 'user_self', user_id: 'realm', client_token_id: token.token_id } };
  const resumeAuthority = createApprovalResumeAuthorityResolver({ manifests, clientTokens: clients,
    inboundTokenStore: inbound, contractOverlay, opAdmissionGate, now });
  const authority = createPreapprovalOriginAuthority({ realm: 'realm', clientTokens: clients, connections, opAdmissionGate, resumeAuthority });
  const activations = createPreapprovalActivations({ ...sources, circuits: createCircuitBreakerStore(db), now });
  const recipe: RecipeDefinition = { ...fixtureRecipe, metadata: { ...fixtureRecipe.metadata, description: 'Create the two reviewed CRM items.' },
    variables: { crm_connection: { type: 'text', label: 'CRM connection', default: 'crm' } },
    steps: ['a', 'b'].map(id => ({ id,
    ingredient: catalog.slug, connection: '{{config.crm_connection}}', input: { operation: holdFirst && id === 'a' ? 'item.confirm' : 'item.write',
      // ⚠ TWO SEPARATE PROPERTIES, AND THEY USED TO SHARE ONE VEHICLE.
      // `item.confirm` carries `approval: 'always'`, which is what makes it ASK
      // at run time — that is unchanged and is what these hold scenarios need.
      // It ALSO used to be why the call was UNCOVERED at review time, and that
      // half stopped being true on 2026-09-06 when `always` became eligible:
      // the op is now a reviewable member, so nothing held and every
      // `nested_hold` case silently became a covered-path test. The unresolved
      // `{{step.*}}` reference restores the uncovered half on its own terms —
      // an argument that does not exist until an earlier step runs cannot be
      // frozen, whatever its approval intent.
      // `context.event` is engine-injected at fire time and absent at review,
      // so it parses cleanly and cannot be frozen — an uncovered reason that
      // owes nothing to approval intent, and adds no extra dispatch.
      args: { id, 'body.message': `Reviewed ${id}`,
        ...(holdFirst && id === 'a' ? { deferred: '{{context.event.payload.id}}' } : {}) } } })) };
  if (withMcp) {
    recipe.variables!.mcp_connection = { type: 'text', label: 'MCP connection', default: 'workspace' };
    recipe.steps.splice(1, 0, { id: 'mcp', ingredient: mcpCatalog.slug, connection: '{{config.mcp_connection}}',
      input: { operation: 'item.write', args: { title: 'Reviewed item' } } });
  }
  if (withCli) recipe.steps.splice(1, 0, { id: 'cli', ingredient: 'review-cli',
    input: { operation: 'item.write', args: { message: 'Reviewed CLI write' } } });
  if (withAi) recipe.steps.splice(1, 0, { id: 'ai', ingredient: 'ai-summarize',
    input: { 'llm.data': 'The reviewed quarterly report.' } });
  recipes.save(recipe, 'core', 'inline');
  const profiles = { connectionStore: connections, getManifest: (slug: string) => manifests.get(slug), connectionCatalogBindingStore: bindings };
  const profileStore = createInMemoryConnectionOperationProfileStore();
  wireCatalogOperationProfiles({ ...profiles, profileStore });
  const execution: ExecuteHandlerDeps = { recipeStore: recipes, baseVault: {}, executorConfig: { manifests, connectionStore: connections,
    ...(withAi ? { resolveLlmConfig: () => llm.getConfig(), llmQuota } : {}),
    connectionApi: { decodeAuth: async () => ({ type: 'none' }), persistAuth: async () => {} },
    ...(withMcp ? { connectionMcp: { decodeAuth: async () => ({ type: 'none' as const }), persistAuth: async () => {}, wsConnect: createWsConnect(),
      spawnStdioMcp: async (spec, options) => { const child = await createStdioSpawn()(spec, options); mcpProcesses.push(child); return child; } } } : {}) },
    ...(withCli ? { cliReachabilityResolver: createCliReachabilityResolver(cliReach) } : {}),
    connectionStore: connections, connectionOperationProfiles: profileStore,
    // D-319 — as production: an auto-run timer fires as its dish.
    dishStore: sources.dishes,
    commitStore: createCommitStore(createSQLiteCollection<Commit>(db, 'commits')),
    auditLog: createAuditLogStore(createSQLiteCollection<AuditEntry>(db, 'audit_log')),
    checkpointStore: createCheckpointStore(createSQLiteCollection<Checkpoint>(db, 'checkpoints')),
    approvalResumeAuthority: resumeAuthority,
    gatedActionStore: createGatedActionStore(createSQLiteCollection<GatedActionRecord>(db, GATED_ACTION_TABLE), {
      compareAndSet: createSqliteGatedActionCompareAndSet(db), nextChangeSeq: createSqliteGatedActionChangeClock(db).nextChangeSeq,
    }),
    opAdmissionGate, contractOverlay, contractScan: createContractScanFn(contracts) };
  let runnerReady = true;
  const mail = withMail ? (() => {
    const dir = mkdtempSync(join(tmpdir(), 'd261-mail-')); directories.push(dir);
    const blobs = createBlobStore(join(dir, 'blobs'), { getEncryptionKey: () => new Uint8Array(32).fill(4) });
    const getBytes = vi.spyOn(blobs, 'get');
    const registry = createCollectionRegistry(); const instances = createInstanceStore({ db, now });
    const bus = createWarehouseEventBus();
    const fileCollection = createInboundFileCollection({ db, blobs, bus, slug: 'received',
      gate: createStorageGate({ quota: 20_000_000, reservePct: 10, surface: 'collection:file:received' }) });
    registry.register(fileCollection);
    const sent: OutgoingMessage[] = []; const behavior = { uncertain: false };
    const provider: MailProvider = { kind: 'imap', slug: 'work', sendCapable: true, mutationCapable: false,
      accountEmail: 'owner@example.test', async connect() {}, async initialScan() {}, async startSync() { return async () => {}; },
      async close() {}, health: () => ({ last_successful_sync_at: 0, error_count_24h: 0, pending_queue_size: 0 }),
      async send(message) { sent.push(structuredClone(message)); if (behavior.uncertain) throw new Error('SMTP acknowledgement lost');
        return { source_id: 'sent-1', message_id: '<sent-1@example.test>', sent_at: now() }; } };
    const collection = createMailCollection({ db, blobs, bus, slug: 'work', provider,
      gate: createStorageGate({ quota: 20_000_000, reservePct: 10, surface: 'collection:mail:work' }),
      config: () => ({ quota_bytes: 20_000_000, backfill_days: 1, retention_days: 30 }),
      auditLog: execution.auditLog, fileReadDeps: () => ({ registry, blobs, auditLog: execution.auditLog }) });
    registry.register(collection);
    instances.upsert({ platform: 'mail', slug: 'work', adapter_type: 'imap', config: { account_email: provider.accountEmail },
      caps: { read: 'yes', write: 'no', delete: 'no', watch: 'realtime', mirror: 'required', auth: 'keys', path_style: 'uri' },
      auth_state: 'healthy', last_synced_at: null });
    for (const slug of ['mail-send', 'data-file-read', 'mail-draft-create', 'mail-draft-read', 'mail-draft-update', 'mail-draft-delete']) {
      manifests.register(KERNEL_MANIFESTS.find(row => row.slug === slug)!);
    }
    return { blobs, getBytes, registry, instances, fileCollection, collection, sent, behavior };
  })() : null;
  const block = createNotificationBlock({
    askStore: createAskStore(createSQLiteCollection<PendingAsk>(db, 'pending_asks')),
    settingsStore: createNotificationSettingsStore(createSQLiteCollection<NotificationSettings>(db, 'notification_settings')),
    channels: [createUiChannel({ busSink: () => {} })], now,
  });
  const composed = productionComposition ? composePreapproval({ ownerId: 'realm', storage, sources,
    circuits: createCircuitBreakerStore(db), execution, profiles, clientTokens: clients,
    definitions: definitionStore, inboundTokens: inbound, notifications: block, reviewLink: id => `https://owner.example/#approvals/preapproval/${id}`, now,
    serverTimeZone: () => undefined, ...(mail ? { mail } : {}) }) : null;
  const service = composed?.service ?? createPreapprovalService({ storage, sources, activations, authority, now, execution, profiles,
    // Actual runtime/driver/HTTP composition. Server boot, all transport
    // families and attachment providers have separate acceptance obligations.
    executionCapabilities: () => ({ activation_kinds: runnerReady ? ['one_shot'] : [],
      bindings: runnerReady ? [{ family: 'http', identity_version: 1 }] : [], child_calls: [], decision_channels: ['webclient'] }),
  });
  const runtime = composed?.runtime ?? createPreapprovalExecutionRuntime({ storage, service }); execution.preapprovalRuntime = runtime;
  execution.preapprovalDriver ??= createPreapprovalDriver({ storage, activations, runtime, execution });
  if (productionComposition) {
    manifests.register(KERNEL_MANIFESTS.find(manifest => manifest.slug === 'preapproval-request')!);
    execution.executorConfig.kernelDispatchers = { preapprovalRequest: (request, meta) => execution.preapprovalRequest!(request, meta),
      mailDraft: (method, input, meta) => execution.mailDraft!(method, input, meta),
      ...(mail ? { mailSend: input => handleCollectionMailSend({ registry: mail.registry }, input),
        dataFileRead: input => handleFileRead({ registry: mail.registry, blobs: mail.blobs, auditLog: execution.auditLog }, input) } : {}) };
  }
  await storage.recover();
  const request = (): PreparePreapproval => ({ idempotency_key: randomUUID(),
    subject: { kind: 'recipe', recipe_id: recipe.recipe_id, publisher_id: 'core', config: {} },
    activation: { kind: 'one_shot', run_at: now() + 60_000, time_zone: 'UTC' },
    decision_deadline: now() + 30_000, dispatch_deadline: now() + 120_000 });
  const responder = { channel: 'webclient' as const, key: token.token_id };
  const decision = async (proposal_id: string): Promise<PreapprovalDecisionRequest> => {
    const review = await storage.repository.review(proposal_id, responder);
    return { proposal_id, expected_revision: review.revision, review_digest: review.review_digest,
      challenge: review.challenge, decision: 'approve', request_id: randomUUID() };
  };
  return { db, storage, service, request, origin, responder, decision, sources, connections, bindings, runtime, execution, clock, received, provider,
    processFiles, cliReach, llm, llmQuota, aiReceived, uploads, profiles, profileStore,
    get mcpReceived() { return processFiles && withMcp === 'stdio' && existsSync(processFiles.mcp_log)
      ? readFileSync(processFiles.mcp_log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) as typeof mcpReceived : mcpReceived; },
    composed, clients, token, block, inbound, contracts, definitions: definitionStore, grants: grantEntryStore, mail,
    disableRunner() { runnerReady = false; } };
};

describe('D-261 production preparation and owner-decision service', () => {
  // D-201 Slice 10AZ (10AW finding 1) — what the production runtime answers a
  // run with no pre-approval. The restart keeps read `resume`'s answer, and the
  // harnesses that drive them wire a runtime giving these answers
  // (`ordinary-run-preapproval-runtime.ts`): with none wired, `resume` read as
  // `undefined` there and `null` on a server, and the keeps ran only in tests.
  it('answers a run with no pre-approval as the ordinary-run runtime harnesses wire', async () => {
    const f = await fixture('ask', false, true);
    const checkpoint = { checkpoint_id: 'cp-ordinary', run_id: 'run-ordinary', recipe_id: 'ordinary-recipe',
      gated_step_id: 'write', step_state: {}, created_at: 1 } as unknown as Checkpoint;
    expect(Object.keys(ORDINARY_RUN_PREAPPROVAL_ANSWERS).sort())
      .toEqual(['assertEntry', 'canPublishCheckpoint', 'cancelCheckpoint', 'recordDispatchUse', 'resume']);
    expect(await f.runtime.resume(checkpoint)).toBe(await ORDINARY_RUN_PREAPPROVAL_ANSWERS.resume());
    expect(await f.runtime.resume(checkpoint)).toBeNull();
    expect(await f.runtime.assertEntry('run-ordinary')).toBe(await ORDINARY_RUN_PREAPPROVAL_ANSWERS.assertEntry());
    expect(f.runtime.canPublishCheckpoint('cp-ordinary')).toBe(ORDINARY_RUN_PREAPPROVAL_ANSWERS.canPublishCheckpoint());
    expect(f.runtime.recordDispatchUse({ channel: 'webhook' } as never, 'mail-send', {} as never))
      .toBe(ORDINARY_RUN_PREAPPROVAL_ANSWERS.recordDispatchUse());
    expect(f.runtime.cancelCheckpoint(checkpoint)).toBe(ORDINARY_RUN_PREAPPROVAL_ANSWERS.cancelCheckpoint());
  });

  it('refuses post-run exchange delivery before storing or dispatching a review', async () => {
    const f = await fixture('ask', false, true);
    const recipe = f.sources.recipes.get(fixtureRecipe.recipe_id)!;
    recipe.output = { exchange: { ref: 'reviewed-exchange', deliver_to: 'core/future-answer' } };
    f.sources.recipes.save(recipe, 'core', 'inline');
    await expect(f.service.prepare(f.request(), f.origin)).rejects.toThrow(/Post-run exchange delivery/);
    expect(f.db.prepare('SELECT count(*) AS count FROM preapproval_proposals').get()).toEqual({ count: 0 });
    expect(f.received).toEqual([]); expect(await f.block.listOpenAsks()).toEqual([]);
  });

  it('retains the original nested run through a real peer hold, authenticated answer and parent continuation', async () => {
    const f = await fixture('ask', false, true, false, true);
    const answers = createPeerAnswerStore(f.db); const outbox = createPeerAskOutboxStore(f.db);
    const peerConnection = f.connections.get('mcp', 'workspace')!;
    const health = JSON.parse(peerConnection.health_json!);
    health.tools.push(PEER_RECEIVE_ASK_TOOL);
    health.mcp_tool_schemas[PEER_RECEIVE_ASK_TOOL] = { type: 'object', additionalProperties: true };
    f.connections.upsert({ ...peerConnection, health_json: JSON.stringify(health) });
    f.execution.db = f.db; f.execution.peerAskOutbox = outbox; f.execution.preflightNotifier = f.block;
    f.execution.executorConfig.kernelDispatchers!.peerAsk = async (input, meta) => dispatchPeerAsk(input,
      { answers, run_id: meta?.run_id ?? '', step_id: meta?.step_id ?? '' });
    for (const slug of ['peer-ask', 'connection']) f.execution.executorConfig.manifests.register(KERNEL_MANIFESTS.find(row => row.slug === slug)!);
    const child: RecipeDefinition = { ...f.sources.recipes.get(fixtureRecipe.recipe_id)!, recipe_id: 'reviewed-peer-child', steps: [
      { id: 'question', ingredient: 'peer-ask', input: { connection: 'workspace', label: 'review:fixture',
        question: 'May this controlled fixture continue?', options: [{ id: 'yes', label: 'Continue' }], via: 'direct' } },
      { id: 'write', ingredient: catalog.slug, connection: 'crm', input: { operation: 'item.write', args: { id: 'child' } } },
    ] };
    f.sources.recipes.save(child, 'core', 'inline');
    f.execution.executorConfig.manifests.register({ ...mcpCatalog, slug: 'peer-child-route', surfaces: { api: {
      ...mcpCatalog.surfaces!.api!, executes: { 'item.write': { kind: 'mcp', tool: 'core/reviewed-peer-child' } },
    } } });
    f.sources.recipes.save({ ...f.sources.recipes.get(fixtureRecipe.recipe_id)!, steps: [
      { id: 'nested', ingredient: 'peer-child-route', input: { operation: 'item.write', args: {} } },
      { id: 'after', ingredient: catalog.slug, connection: 'crm', input: { operation: 'item.write', args: { id: 'after' } } },
    ] }, 'core', 'inline');
    const pending = await f.service.prepare(f.request(), f.origin);
    expect(pending.coverage).toBe('partial');
    await f.storage.repository.decide(await f.decision(pending.proposal_id), f.responder);
    f.clock.now += 60_001; await f.execution.preapprovalDriver!.tickSchedules(f.clock.now);
    const loadLeaf = () => (f.db.prepare('SELECT data FROM checkpoints').all() as Array<{ data: string }>).map(row => JSON.parse(row.data) as Checkpoint)
      .find(checkpoint => f.storage.repository.canPublishCheckpoint(checkpoint.checkpoint_id))!;
    const approval = loadLeaf(); expect(approval?.gated_step_id).toBe('question');
    await createPreflightResumer({ getExecuteDeps: () => f.execution, auditLog: f.execution.auditLog!,
      gatedActionStore: f.execution.gatedActionStore }).resumeRun(approval, { recipe_id: child.recipe_id, gated_step_id: 'question' });
    const peer = loadLeaf(); expect(peer?.run_id).toBe(approval.run_id);
    expect((await f.execution.auditLog!.get(peer.run_id))?.commit_status).toBe('awaiting_peer');
    const journal = (f.db.prepare('SELECT exchange_ref FROM peer_ask_outbox').get() as { exchange_ref: string });
    expect(outbox.getDelivery(journal.exchange_ref)).toMatchObject({ run_id: peer.run_id, checkpoint_id: peer.checkpoint_id });
    expect(f.mcpReceived.filter(call => call.params?.name === PEER_RECEIVE_ASK_TOOL)).toHaveLength(1);
    expect(f.received).toHaveLength(0);
    f.execution.preapprovalRuntime = createPreapprovalExecutionRuntime({ storage: f.storage, service: f.service });
    const answerDeps = { outbox, answers, contractForConnection: (connection: string) => connection === 'workspace' ? 'controlled-peer' : undefined,
      gatedActions: f.execution.gatedActionStore, resume: async (target: { run_id: string; gated_step_id: string; exchange_ref: string }) => {
        await resumePeerHold(target, { getExecuteDeps: () => f.execution, auditLog: f.execution.auditLog!, checkpoints: f.execution.checkpointStore!, outbox });
      } };
    await expect(receiveAnswer({ peer_contract_id: 'wrong-peer', exchange_ref: journal.exchange_ref,
      raw: { answered: true, option: 'yes', at: Date.now() } }, answerDeps)).resolves.toMatchObject({ accepted: false, refusal: 'wrong_peer' });
    await expect(receiveAnswer({ peer_contract_id: 'controlled-peer', exchange_ref: journal.exchange_ref,
      raw: { answered: true, option: 'yes', at: Date.now() } }, answerDeps)).resolves.toMatchObject({ accepted: true, resumed: true });
    expect((await f.storage.repository.inspect(pending.proposal_id)).execution_status,
      JSON.stringify(f.db.prepare('SELECT data FROM audit_log').all())).toBe('succeeded');
    expect(f.received.map(row => row.url)).toEqual(['/v1/items/child', '/v1/items/after']);
    await f.execution.preapprovalDriver!.tickSchedules(f.clock.now);
    expect(f.received).toHaveLength(2);
  });
  it.each(['tier1', 'tier2', 'request_policy'] as const)('Chat requests one protected review through its actual recipe/tool path: %s', async scenario => {
    const f = await fixture('ask', false, true);
    ensureChatSchema(f.db); const chatStore = createChatStore(f.db);
    const sessionId = randomUUID(); chatStore.createSession({ id: sessionId, now: f.clock.now });
    const request = f.request();
    const carrier: RecipeDefinition = { ...fixtureRecipe, recipe_id: 'chat-request-review',
      metadata: { ...fixtureRecipe.metadata, name: 'Request a future execution review', description: 'Ask the owner to review one future CRM execution.' },
      steps: [{ id: 'request', ingredient: 'preapproval-request', input: { ...request } }] };
    if (scenario === 'tier2') f.sources.recipes.save(carrier, 'core', 'inline');
    for (const id of [carrier.recipe_id, fixtureRecipe.recipe_id]) f.grants.set(OWNER_CONTRACT_ID, recipeGrantEntry('core', id), true, f.clock.now);
    if (scenario === 'request_policy') f.contracts.put('owner_operation', ['preapproval-request', 'preapproval-request'],
      { approval: 'always', op_hash: 'owner-request-policy' });
    const inputs = buildChatToolRegistryInputs({ getContactStore: () => undefined, getCollectionRegistry: () => undefined,
      getAuditLog: () => f.execution.auditLog, getEnrichmentStore: () => undefined,
      getRecipeStore: () => f.sources.recipes, getExecutorConfig: () => f.execution.executorConfig,
      getExecuteRecipe: () => request => handleExecute(f.execution, request), getOpAdmissionGate: () => f.execution.opAdmissionGate });
    const registry = createInternalToolRegistry({ ...inputs,
      admitTier1: (name, ctx) => !!ctx.execution_source && f.execution.opAdmissionGate!.isOpGranted(ctx.execution_source, primitiveGrantEntry(name)),
      admitTier2: (name, ctx) => inputs.tier2GrantFilter(ctx.execution_source)(name) });
    const plans = planApproval.createPlanApprovalStore(); const events: BroadcastChatEvent[] = [];
    const chat = createChatOrchestrator({ chatStore, registry, planApprovalStore: plans,
      broadcast: { emit: event => { events.push(event); } }, auditLog: f.execution.auditLog!,
      selfSignature: { server_kind: 'recued', version: '1', instance_id: 'd261-chat' }, now: () => f.clock.now });
    const dispatched = await chat.dispatch.dispatchTool({ session_id: sessionId, turn_id: 'drafting-turn', picker_target: 'self',
      tool_name: scenario === 'tier2' ? `core/${carrier.recipe_id}` : 'recipe.run',
      arg_values: scenario === 'tier2' ? {} : { recipe: carrier } });
    expect(plans.listPending(sessionId)).toEqual([]);
    expect(events.some(event => event.kind === 'chat.plan_proposed')).toBe(false);
    if (scenario === 'request_policy') {
      expect(JSON.stringify(dispatched)).toContain('preapproval_request_policy_conflict');
      expect(await f.block.listOpenAsks()).toHaveLength(0);
      expect(f.db.prepare('SELECT count(*) AS count FROM preapproval_proposals').get()).toEqual({ count: 0 }); return;
    }
    expect(dispatched.ok, JSON.stringify(dispatched)).toBe(true);
    const asks = await f.block.listOpenAsks(); expect(asks, JSON.stringify(dispatched)).toHaveLength(1);
    const proposalId = asks[0]!.handler_payload.proposal_id as string;
    const inspection = await f.storage.repository.inspect(proposalId);
    const plan = await f.storage.repository.loadExecution(inspection.future_execution_ref);
    expect(plan.origin).toMatchObject({ mode: 'owner', owner_id: 'realm', entry: 'kernel',
      source: { channel: 'chat', actor: 'user_self', chat_session_id: sessionId } });
    expect(f.received).toHaveLength(0);
    // Ending the drafting session grants nothing and does not erase the review.
    expect(chatStore.deleteSession(sessionId)).toBe(true);
    await f.storage.repository.decide(await f.decision(proposalId), f.responder);
    f.clock.now = plan.target.due_at!;
    await createScheduler({ store: f.sources.schedules, executeDeps: f.execution, now: () => f.clock.now }).tick();
    expect((await f.storage.repository.inspect(proposalId)).execution_status).toBe('succeeded');
    expect(f.received).toHaveLength(2);
  });
  /** ⛔⛔ MEMOISED ON THE PROMISE, NOT ON THE RESOLVED VALUE — and that is the
   *  whole point. The previous form was `if (shared === undefined) shared =
   *  await create(...)`, which caches only once the start SUCCEEDS. A vitest
   *  timeout rejects the TEST but never cancels the work, so a killed or merely
   *  slow first start left `undefined` in place, the next test launched a SECOND
   *  Chrome, and both cold starts got paid. Measured: two tests burned 78s of
   *  test time — a full extra MV3 cold start — on a machine where all 144 run in
   *  78s. `afterAll` then closed only whichever assignment landed last.
   *
   *  ⚠ A FAILED START IS NOW SHARED TOO, deliberately. Every later caller awaits
   *  the same rejected promise and fails immediately with the fixture's own
   *  named error, instead of each retrying a multi-minute start. Fail once and
   *  say why; do not re-pay a cold start twelve times to learn the same thing. */
  let browserPromise: Promise<Awaited<ReturnType<typeof createReviewedBrowserFixture>>> | undefined;

  /** One browser for the whole file. First caller starts it; everyone after
   *  awaits that same start and resets it to their own page. */
  const sharedBrowserFor = async (url: string) => {
    if (browserPromise === undefined) {
      browserPromise = createReviewedBrowserFixture(url);
      return await browserPromise;
    }
    const shared = await browserPromise;
    await shared.reset(url);
    return shared;
  };

  /** ⛔ THE COLD START IS PAID HERE, not by whichever test happens to run first.
   *  It used to be charged to the `PRISTINE` test below, which made that test
   *  the fixture's initialiser as a side effect — so a slow Chrome failed the
   *  one test whose subject is `reset`, naming the wrong thing. `about:blank`
   *  because no test's page server exists yet; every test resets to its own. */
  //
  // ⚠ 240s FOR THE SAME REASON THE SCENARIOS BELOW CARRY IT — `workerReady`
  // bounds the service-worker wait at 180s with a NAMED error, and an outer
  // bound under that kills the hook before the inner one can speak.
  //
  // ⛔ THE ORDERING RULE WAS ALREADY KNOWN HERE AND STILL BROKE, which is the
  // part worth keeping. The twelve scenarios below were given 240s and a comment
  // spelling out "240s > 180s". The `PRISTINE` test was added later as the guard
  // for the shared browser, WITHOUT that bound — and because it runs first, the
  // cold start migrated into the one test that lacked it. Every failure then
  // arrived as a bare `Test timed out in 30000ms` naming nothing, from a file
  // that had the rule written down twice. ⇒ A per-test bound protects the test
  // it is attached to, not the COST, and the cost moves. Paying it in a hook is
  // what stops it moving again.
  beforeAll(async () => { await sharedBrowserFor('about:blank'); }, 240_000);

  it('⛔⛔ reset() leaves a PRISTINE browser — sharing is only safe if it does', async () => {
    // The risk I introduced by sharing one browser across twelve scenarios: a
    // scenario passing or failing on a PREVIOUS one's leavings, which fails
    // silently and in the wrong place. `documents()` is the sharp edge — it
    // enumerates open tabs scoped to 127.0.0.1/*, and feeds the capability
    // profile, so one leftover tab is inventoried as if it belonged here.
    const server = createServer((_q, r) => { r.writeHead(200, { 'content-type': 'text/html' }); r.end('<html></html>'); });
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('no port');
    const url = `http://127.0.0.1:${addr.port}/reset-probe`;

    const shared = await sharedBrowserFor(url);

    // Dirty it the way the scenarios do: an extra tab.
    const extra = await shared.browser.newPage();
    await extra.goto(url);
    expect((await shared.documents()).length).toBeGreaterThan(1);
    const window = (await shared.tabs())[0]!.window_id;

    await shared.reset(url);
    expect(await shared.documents()).toHaveLength(1);
    expect(await shared.tabs()).toEqual([{ url, active: true, window_id: window }]);
  });

  it('background navigation that never finishes fails at the fixture boundary', async () => {
    let pending: import('node:http').ServerResponse | undefined;
    const server = createServer((_q, response) => {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.write('<!doctype html><title>Still loading</title>');
      pending = response;
    });
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('no port');
    const shared = await sharedBrowserFor('about:blank');
    try {
      // A deadline of its own: the boundary is the same at any deadline, and this test need
      // not wait out the 30 s the fixture allows a loaded machine, nor change when that does.
      await expect(shared.openBackground(`http://127.0.0.1:${addr.port}/pending`, { deadlineMs: 1_000 }))
        .rejects.toThrow('d261: background tab did not finish within 1000ms (status: loading;');
    } finally { pending?.end('</html>'); }
  });
  afterAll(async () => {
    // `.catch` because a failed start leaves a REJECTED promise here, and a
    // teardown must not turn that into a second, less informative failure.
    const shared = await browserPromise?.catch(() => undefined);
    await shared?.close();
    browserPromise = undefined;
    // 120s, not the global 30s: `close()` kills Chrome and removes an ~8MB
    // profile dir, and on the loaded machine that produced this bug even that
    // overran 30s. Teardown failing is how a leaked browser is born.
  }, 120_000);

  it.each(['send', 'repeated', 'contract_last_use', 'document_changed', 'closed', 'pair_revoked', 'navigate_at_wire',
    'revoke_at_wire', 'selector_changed', 'uncertain', 'protected_owner_ui', 'ambiguous'] as const)(
    'one owner review reaches the actual browser through the server bridge WS: %s', async scenario => {
      const f = await fixture('ask', false, true);
      const pageServer = createServer((_request, response) => {
        response.writeHead(200, { 'content-type': 'text/html' });
        response.end('<!doctype html><html><body><input id="draft"><button id="send">Send</button><div id="sent" data-count="0"></div><script>document.querySelector("#send").onclick=()=>{const sent=document.querySelector("#sent");sent.textContent=document.querySelector("#draft").value;sent.dataset.count=String(Number(sent.dataset.count)+1)}</script></body></html>');
      });
      servers.push(pageServer); await new Promise<void>(resolve => pageServer.listen(0, '127.0.0.1', resolve));
      const address = pageServer.address(); if (!address || typeof address === 'string') throw new Error('No browser fixture port');
      const url = `http://127.0.0.1:${address.port}/draft`;
      // ⛔⛔ ONE BROWSER FOR ALL TWELVE SCENARIOS (D-269 REV 32). Each launch pays
      // Chrome's MV3 service-worker cold start, which measured 0.6s alone and up
      // to 415s under full-suite load — twelve of those was the entire cost of
      // this file and the reason a random scenario blew its timeout. `reset`
      // restores a pristine browser between scenarios; see the fixture for what
      // "pristine" has to mean.
      const browser = await sharedBrowserFor(url);
      const bridgeRegistry = createBridgeRegistry();
      const bridgeToken = await f.clients.issue({ client_kind: 'bridge', metadata: { instance_id: 'review-browser' } });
      const server = await startServer(0, { clientTokens: f.clients, preapprovalDeps: f.composed!.handlers,
        bridgeRegistry, bridgeCapabilityDeps: { registry: bridgeRegistry } });
      f.execution.executorConfig.bridgeDispatcherRef = () => server.wsServer.bridgeDispatcher;
      const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, { headers: { Authorization: `Bearer ${f.token.token_id}.${f.token.bearer}` } });
      const bridge = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, { headers: { Authorization: `Bearer ${bridgeToken.token_id}.${bridgeToken.bearer}` } });
      const commands: BridgeCommand[] = []; const bridgeErrors: unknown[] = [];
      bridge.on('message', bytes => {
        const frame = JSON.parse(bytes.toString()) as { kind?: string; command?: BridgeCommand };
        if (frame.kind !== 'command' || !frame.command) return;
        const command = frame.command; commands.push(command);
        void browser.command(command).then(({ result }) => {
          if (scenario === 'uncertain') result = { ...result, status: 'error', outputs: {}, error: { code: 'unknown', message: 'Browser failed after actuation.' } };
          bridge.send(JSON.stringify({ kind: 'result', result }));
        }).catch(error => {
          bridgeErrors.push(error instanceof Error ? error.message : String(error));
          bridge.send(JSON.stringify({ kind: 'result', result: { command_id: command.command_id,
            status: 'error', error: { code: 'unknown', message: 'Controlled browser failed.' },
            bridge_version: '1', elapsed_ms: 1 } }));
        });
      });
      try {
        await Promise.all([socket, bridge].map(client => new Promise<void>((resolve, reject) => {
          client.once('open', resolve); client.once('error', reject);
        })));
        const target = `http://127.0.0.1:${address.port}/*`;
        const manifest = KERNEL_MANIFESTS.find(row => row.slug === 'dom-write')!;
        f.execution.executorConfig.manifests.register(manifest);
        f.contracts.put('owner_operation', ['dom-write', 'dom-write'], { approval: 'ask', op_hash: 'review-dom' });
        const input = { target, selector: '#draft', value: 'The reviewed browser message', submit_selector: '#send' };
        const ingredient = describeBridgeDomCall(manifest, { slug: manifest.slug, input, output: manifest.output }).ingredient;
        await browser.grant(ingredient);
        const recipe = f.sources.recipes.get(fixtureRecipe.recipe_id)!;
        recipe.steps.splice(1, 0, { id: 'dom', ingredient: manifest.slug, input,
          ...(scenario === 'repeated' ? { foreach: '{{config.copies}}' } : {}) });
        if (scenario === 'repeated') recipe.variables!.copies = null;
        f.sources.recipes.save(recipe, 'core', 'inline');
        if (scenario === 'ambiguous') { const duplicate = await browser.browser.newPage(); await duplicate.goto(url); }
        const profile = async (): Promise<BridgeCapabilityProfile> => ({ software_version: '1', chrome_version: '120',
          permissions_granted: ['tabs', 'scripting'], granted_origins: [target], offscreen_supported: false, alarms_supported: true,
          dom_documents: { version: 1, documents: await browser.documents() } });
        await ownerRpc(bridge, 'bridge.capabilityProfile.push', { profile: await profile() });
        expect(bridgeRegistry.get(bridgeToken.token_id)?.capabilities.dom_documents).toBeUndefined();
        let contractId: string | undefined;
        let proposal: { proposal_id: string };
        if (scenario === 'contract_last_use') {
          const request = f.request(); const entry = 'recued_ingredient_preapproval-request';
          const def = f.definitions.mint({ minted_by: 'owner', display_name: 'Browser assistant', max_uses: 4,
            door_types: ['mcp'], scope: { channels: ['mcp'], actors: ['contracted_user'], connection_names: [],
              operation_ids: ['core.preapproval.request', 'core.schedule.recipe', 'core.dom.write', 'test/catalog.item.write'] } });
          contractId = def.contract_id;
          for (const op of ['core.preapproval.request', 'core.schedule.recipe']) f.grants.set(contractId, opGrantEntry(op), true, f.clock.now);
          const issued = f.inbound.issueToken({ value: { label: 'Browser assistant', grants: {
            [entry]: true, [`core/${fixtureRecipe.recipe_id}`]: true }, concurrency_tier: 3, chat_mode: null, contract_id: contractId }, now: f.clock.now });
          const dispatch = createMcpHttpDispatch({ ...f.execution, mcpTokenId: issued.record.token_id,
            boundContractId: contractId, boundContractActive: true,
            inboundTokenAuthorize: name => isMcpInboundTokenToolAuthorized(f.inbound.getTokenById(issued.record.token_id)!, name, f.clock.now) });
          const response = await dispatch({ jsonrpc: '2.0', id: 'review-browser', method: 'tools/call',
            params: { name: entry, arguments: request } });
          const result = response as { result?: { isError?: boolean; content: Array<{ type: string; text: string }> }; error?: unknown };
          expect(result.error).toBeUndefined();
          expect(result.result?.isError, JSON.stringify(result)).not.toBe(true);
          const asks = await f.block.listOpenAsks(); expect(asks).toHaveLength(1);
          proposal = { proposal_id: asks[0]!.handler_payload.proposal_id as string };
        } else {
          const request = f.request();
          if (scenario === 'repeated' && request.subject.kind === 'recipe') request.subject.config.copies = [1, 1];
          proposal = await ownerRpc<{ proposal_id: string }>(socket, 'preapproval.prepare', request);
        }
        const review = await ownerRpc<PreapprovalReview>(socket, 'preapproval.review', { proposal_id: proposal.proposal_id });
        expect(commands).toHaveLength(0);
        if (scenario === 'ambiguous') {
          expect(review.coverage).toBe('partial'); expect(review.uncovered.some(row => row.reason.includes('ambiguous'))).toBe(true); return;
        }
        expect(review.coverage, JSON.stringify(review.uncovered)).toBe('complete');
        expect(review.members.map(member => member.family)).toEqual(scenario === 'repeated' ? ['http', 'dom', 'dom', 'http'] : ['http', 'dom', 'http']);
        await ownerRpc(socket, 'preapproval.decide', { proposal_id: proposal.proposal_id, expected_revision: review.revision,
          review_digest: review.review_digest, challenge: review.challenge, decision: 'approve', request_id: randomUUID() });
        if (scenario === 'document_changed') { await browser.page.reload(); await ownerRpc(bridge, 'bridge.capabilityProfile.push', { profile: await profile() }); }
        if (scenario === 'closed') { await browser.page.close(); await ownerRpc(bridge, 'bridge.capabilityProfile.push', { profile: await profile() }); }
        if (scenario === 'pair_revoked') f.clients.revoke(bridgeToken.token_id, 'Owner removed browser', f.clock.now);
        if (scenario === 'selector_changed') {
          (recipe.steps[1] as { input: Record<string, unknown> }).input.selector = '#send'; f.sources.recipes.save(recipe, 'core', 'inline');
        }
        if (scenario === 'protected_owner_ui') await browser.page.evaluate(() => document.documentElement.setAttribute('data-recued-owner-surface', ''));
        if (scenario === 'navigate_at_wire' || scenario === 'revoke_at_wire') {
          const dispatch = server.wsServer.bridgeDispatcher!.dispatch.bind(server.wsServer.bridgeDispatcher);
          vi.spyOn(server.wsServer.bridgeDispatcher!, 'dispatch').mockImplementationOnce(async (request, reviewed) => {
            if (scenario === 'navigate_at_wire') await browser.page.reload();
            else f.clients.revoke(bridgeToken.token_id, 'Owner removed browser at wire entry', f.clock.now);
            return dispatch(request, reviewed);
          });
        }
        const plan = await f.storage.repository.loadExecution(review.future_execution_ref); f.clock.now = plan.target.due_at!;
        const scheduler = createScheduler({ store: f.sources.schedules, executeDeps: f.execution, now: () => f.clock.now });
        await scheduler.tick(); await scheduler.tick();
        const status = await f.storage.repository.inspect(proposal.proposal_id);
        expect(bridgeErrors).toEqual([]);
        const success = ['send', 'repeated', 'contract_last_use'].includes(scenario);
        const invalidated = ['document_changed', 'closed', 'pair_revoked', 'selector_changed'].includes(scenario);
        expect(status.execution_status, JSON.stringify(status)).toBe(success ? 'succeeded' : invalidated ? 'invalidated' : scenario === 'revoke_at_wire' ? 'partial' : 'in_doubt');
        expect(commands).toHaveLength(success ? scenario === 'repeated' ? 4 : 2 : invalidated || scenario === 'revoke_at_wire' ? 0 : 1);
        expect(f.received).toHaveLength(success ? 2 : invalidated ? 0 : 1);
        if (scenario !== 'closed') {
          expect(await browser.page.locator('#sent').textContent()).toBe(success ? input.value : '');
          expect(await browser.page.locator('#sent').getAttribute('data-count')).toBe(success ? scenario === 'repeated' ? '2' : '1' : '0');
          expect(await browser.page.locator('#draft').inputValue()).toBe(success || scenario === 'uncertain' ? input.value : '');
        }
        if (success) {
          const member = status.members.find(row => row.op_id === 'core.dom.write')!;
          expect(member.commit_id).toBeTruthy(); expect(member.action_ref).toBeTruthy();
          expect(commands.every(command => command.recipe_run_id === member.run_id)).toBe(true);
          expect(new Set(commands.map(command => command.idempotency_key)).size).toBe(scenario === 'repeated' ? 4 : 2);
          if (contractId) {
            expect(f.definitions.get(contractId)?.uses_remaining).toBe(0);
            const commit = await f.execution.commitStore!.get(member.commit_id!);
            expect(commit?.source).toMatchObject({ channel: 'mcp', actor: 'contracted_user', contract_id: contractId });
          }
        }
        if (scenario === 'protected_owner_ui') {
          const { reviewed_document: _pin, ...ordinary } = commands[0]!;
          const result = await browser.ordinaryCommand({ ...ordinary, command_id: randomUUID(), idempotency_key: randomUUID() });
          expect(result.result.status).toBe('error');
          expect(await browser.page.locator('#draft').inputValue()).toBe('');
        }
        expect(await f.block.listOpenAsks()).toHaveLength(0);
      // ⚠ The browser is NOT closed here any more — it is shared, and `afterAll`
      // owns its lifetime. Closing it per scenario is what made this expensive.
      } finally { socket.terminate(); bridge.terminate(); await server.close(); }
        // ⚠ RAISED FOR FULL-SUITE CONTENTION (D-269 REV 26), not because the work
    // grew. Alone this file is comfortably inside the old bound; under a bare
    // `vitest run` (3,717 files) it is competing for CPU with the whole tree,
    // and the release runs EXACTLY that suite in the exported projection —
    // so a timeout here fails a release while the code is fine.
    // ⚠ TWELVE scenarios, each launching a REAL Chromium via Playwright and
    // esbuild-ing an extension. This is the most expensive fixture in the tree.
    // ⚠ 240s LOOKS OVERSIZED NOW AND MUST STAY. Since REV 32 the scenarios share
    // one browser, so they run in ~1–2s each and the file costs ~28s instead of
    // 517s. But the FIRST scenario still pays Chrome's MV3 cold start, and
    // `workerReady` bounds that at 180s with a NAMED error. ⛔ This bound has to
    // stay ABOVE it, or a starved worker surfaces as a bare vitest timeout
    // carrying no cause — the same ordering mistake `d-261-boot` and
    // `bin-router` each documented after making it. 240s > 180s.
  }, 240_000);
  it.each(['single', 'repeated', 'parallel_prefetch', 'nested_hold', 'nested_hold_recreated', 'nested_hold_revoke',
    'nested_hold_twice', 'nested_hold_deep', 'nested_hold_parallel', 'nested_hold_result_recovery', 'nested_hold_result_revoke',
    'nested_hold_dynamic', 'nested_hold_dynamic_recreated', 'nested_hold_dynamic_changed', 'nested_hold_dynamic_revoke',
    'nested_hold_dynamic_egress_cancel', 'nested_hold_dynamic_egress_deadline'] as const)('runs reviewed local recipes through the real catalog and scheduler: %s', async scenario => {
    const held = scenario.startsWith('nested_hold');
    const dynamic = scenario.includes('dynamic');
    const f = await fixture('ask', held, true);
    const child: RecipeDefinition = { ...f.sources.recipes.get(fixtureRecipe.recipe_id)!, recipe_id: 'reviewed-child' };
    if (dynamic) child.variables = { ...child.variables, observed: null };
    if (scenario === 'nested_hold_twice' || dynamic) child.steps[1] = { id: 'b', ingredient: catalog.slug, connection: '{{config.crm_connection}}',
      input: { operation: 'item.confirm', args: { id: 'b' } } };
    if (scenario === 'parallel_prefetch') {
      child.prefetch_steps = ['a', 'b'].map(id => ({ id, ingredient: catalog.slug, connection: '{{config.crm_connection}}',
        input: { operation: 'item.write', args: { id, 'body.message': `Reviewed ${id}` } } }));
      child.steps = [];
    }
    f.sources.recipes.save(child, 'core', 'inline');
    f.execution.executorConfig.manifests.register({ ...mcpCatalog, slug: 'local-review', name: 'Reviewed child',
      surfaces: { api: { ...mcpCatalog.surfaces!.api!, executes: {
        'item.write': { kind: 'mcp', tool: 'core/reviewed-child' },
      } } } });
    const root = f.sources.recipes.get(fixtureRecipe.recipe_id)!;
    root.steps = (scenario === 'repeated' ? ['first', 'second'] : ['first']).map(id => ({ id,
      ingredient: 'local-review', input: { operation: 'item.write', args: {} } }));
    if (held) {
      f.execution.preflightNotifier = f.block;
      root.steps.unshift({ id: 'before', ingredient: catalog.slug, connection: '{{config.crm_connection}}',
        input: { operation: 'item.write', args: { id: 'before' } } });
      root.steps.push({ id: 'after', ingredient: catalog.slug, connection: '{{config.crm_connection}}',
        input: { operation: 'item.write', args: { id: 'after' } } });
    }
    if (dynamic) root.steps[1] = { id: 'first', ingredient: 'local-review',
      input: { operation: 'item.write', args: { observed: '{{step.before}}' } } };
    if (scenario === 'nested_hold_deep') {
      f.sources.recipes.save({ ...child, recipe_id: 'reviewed-middle', steps: [{ id: 'nested', ingredient: 'local-review',
        input: { operation: 'item.write', args: {} } }] }, 'core', 'inline');
      f.execution.executorConfig.manifests.register({ ...mcpCatalog, slug: 'local-middle', name: 'Reviewed middle',
        surfaces: { api: { ...mcpCatalog.surfaces!.api!, executes: {
          'item.write': { kind: 'mcp', tool: 'core/reviewed-middle' },
        } } } });
      root.steps[1] = { id: 'first', ingredient: 'local-middle', input: { operation: 'item.write', args: {} } };
    }
    if (scenario === 'nested_hold_parallel') {
      root.prefetch_steps = [{ id: 'before', ingredient: catalog.slug, connection: '{{config.crm_connection}}',
        input: { operation: 'item.write', args: { id: 'before' } } }, ...['first', 'second'].map(id => ({ id,
        ingredient: 'local-review', input: { operation: 'item.write', args: {} } }))];
      root.steps = [root.steps[2]!];
    }
    f.sources.recipes.save(root, 'core', 'inline');
    const proposal = await f.service.prepare(f.request(), f.origin);
    const inspection = await f.storage.repository.inspect(proposal.proposal_id);
    expect(inspection.coverage).toBe(held ? 'partial' : 'complete');
    if (dynamic) {
      expect(inspection.members).toHaveLength(2);
      const prepared = await f.storage.repository.loadExecution(proposal.future_execution_ref);
      expect(prepared.recipe_snapshots).toHaveLength(1);
      expect(prepared.uncovered.some(call => call.subtree && call.invocation_path.some(segment => segment.kind === 'step' && segment.step_id === 'first'))).toBe(true);
    }
    await f.storage.repository.decide(await f.decision(proposal.proposal_id), f.responder);
    f.clock.now += 60_001;
    await f.execution.preapprovalDriver!.tickSchedules(f.clock.now);
    if (held) {
      expect((await f.storage.repository.inspect(proposal.proposal_id)).execution_status,
        JSON.stringify(f.db.prepare('SELECT data FROM audit_log').all())).toBe('held');
      expect(f.received.map(call => call.url)).toEqual(['/v1/items/before']);
      const checkpoints = (f.db.prepare('SELECT data FROM checkpoints').all() as Array<{ data: string }>)
        .map(row => JSON.parse(row.data) as Checkpoint);
      expect(checkpoints).toHaveLength(['nested_hold_deep', 'nested_hold_parallel'].includes(scenario) ? 3 : 2);
      const leaf = checkpoints.find(checkpoint => f.storage.repository.canPublishCheckpoint(checkpoint.checkpoint_id))!;
      expect(leaf.recipe_id).toBe('reviewed-child');
      expect(checkpoints.some(checkpoint => checkpoint.preapproval_nested_wait?.child_run_id === leaf.run_id)).toBe(true);
      const asks = (f.db.prepare('SELECT data FROM pending_asks').all() as Array<{ data: string }>).map(row => JSON.parse(row.data) as PendingAsk)
        .filter(ask => ask.handler_kind === 'gateway.preflight');
      expect(asks).toHaveLength(1);
      expect(asks[0]!.handler_payload.checkpoint_id).toBe(leaf.checkpoint_id);
      if (dynamic) {
        expect(f.db.prepare('SELECT count(*) AS count FROM preapproval_ordinary_recipes').get()).toEqual({ count: 1 });
        expect((await f.storage.repository.loadExecution(proposal.future_execution_ref)).recipe_snapshots).toHaveLength(1);
      }
      if (scenario.endsWith('recreated')) f.execution.preapprovalRuntime = createPreapprovalExecutionRuntime({ storage: f.storage, service: f.service });
      if (scenario === 'nested_hold_revoke' || scenario === 'nested_hold_dynamic_revoke') {
        const current = await f.storage.repository.inspect(proposal.proposal_id);
        await f.storage.repository.revoke({ grant_id: current.grant!.grant_id, expected_revision: current.grant!.revision,
          request_id: randomUUID() }, f.responder);
      }
      const resumer = createPreflightResumer({ getExecuteDeps: () => f.execution,
        auditLog: f.execution.auditLog!, gatedActionStore: f.execution.gatedActionStore });
      if (scenario === 'nested_hold_dynamic_changed') {
        child.metadata.name = 'Changed after the ordinary child paused';
        f.sources.recipes.save(child, 'core', 'inline');
        await resumer.resumeRun(leaf, { recipe_id: leaf.recipe_id!, gated_step_id: leaf.gated_step_id! });
        expect((await f.storage.repository.inspect(proposal.proposal_id)).execution_status).toBe('partial');
        await f.composed!.outbox.drain();
        expect((await f.block.listOpenAsks()).filter(ask => ask.handler_kind === 'gateway.preflight')).toHaveLength(0);
        expect(f.received.map(call => call.url)).toEqual(['/v1/items/before']); return;
      }
      if (scenario === 'nested_hold_revoke' || scenario === 'nested_hold_dynamic_revoke') {
        await expect(resumer.resumeRun(leaf, { recipe_id: leaf.recipe_id!, gated_step_id: leaf.gated_step_id! })).rejects.toMatchObject({ code: 'preapproval_already_claimed' });
        await f.composed!.outbox.drain();
        expect((await f.block.listOpenAsks()).filter(ask => ask.handler_kind === 'gateway.preflight')).toHaveLength(0);
        expect(await f.execution.gatedActionStore!.getByCheckpoint(leaf.checkpoint_id)).toMatchObject({ status: 'cancelled' });
        expect(f.received.map(call => call.url)).toEqual(['/v1/items/before']);
        return;
      }
      const deferredParent = scenario.startsWith('nested_hold_result')
        ? vi.spyOn(f.storage.repository, 'resumeNestedParent').mockRejectedValueOnce(new RpcError('preapproval_already_claimed', 'The local continuation callback was lost.', 409)) : null;
      if (scenario.includes('dynamic_egress')) f.execution.executorConfig.connectionApi!.beforeRequest = async () => {
        if (scenario.endsWith('deadline')) f.clock.now = (await f.storage.repository.loadExecution(proposal.future_execution_ref)).request.dispatch_deadline;
        else {
          const current = await f.storage.repository.inspect(proposal.proposal_id);
          await f.storage.repository.revoke({ grant_id: current.grant!.grant_id, expected_revision: current.grant!.revision,
            request_id: randomUUID() }, f.responder);
        }
      };
      await resumer.resumeRun(leaf, { recipe_id: leaf.recipe_id!, gated_step_id: leaf.gated_step_id! });
      if (scenario.includes('dynamic_egress')) {
        expect(f.received.map(call => call.url)).toEqual(['/v1/items/before']);
        expect((await f.storage.repository.inspect(proposal.proposal_id)).execution_status).toBe('partial');
        return;
      }
      if (deferredParent) {
        deferredParent.mockRestore();
        expect(f.received.map(call => call.url)).toEqual(['/v1/items/before', '/v1/items/a', '/v1/items/b']);
        expect(f.storage.repository.pendingNestedParents()).toHaveLength(1);
        if (scenario === 'nested_hold_result_revoke') {
          const current = await f.storage.repository.inspect(proposal.proposal_id);
          await f.storage.repository.revoke({ grant_id: current.grant!.grant_id, expected_revision: current.grant!.revision,
            request_id: randomUUID() }, f.responder);
        }
        const runtime = createPreapprovalExecutionRuntime({ storage: f.storage, service: f.service });
        f.execution.preapprovalRuntime = runtime;
        const activations = createPreapprovalActivations({ ...f.sources, circuits: createCircuitBreakerStore(f.db), now: () => f.clock.now });
        const drivers = [0, 1].map(() => createPreapprovalDriver({ storage: f.storage, activations, runtime, execution: f.execution }));
        f.execution.preapprovalDriver = drivers[0]!;
        await Promise.all(drivers.map(driver => driver.tickSchedules(f.clock.now)));
        expect(f.storage.repository.pendingNestedParents()).toHaveLength(0);
        if (scenario === 'nested_hold_result_revoke') {
          expect(f.received).toHaveLength(3); return;
        }
      }
      if (scenario === 'nested_hold_twice' || scenario === 'nested_hold_parallel' || dynamic) {
        expect((await f.storage.repository.inspect(proposal.proposal_id)).execution_status).toBe('held');
        const next = (f.db.prepare('SELECT data FROM checkpoints').all() as Array<{ data: string }>).map(row => JSON.parse(row.data) as Checkpoint)
          .find(checkpoint => f.storage.repository.canPublishCheckpoint(checkpoint.checkpoint_id))!;
        expect(next.checkpoint_id).not.toBe(leaf.checkpoint_id);
        await resumer.resumeRun(next, { recipe_id: next.recipe_id!, gated_step_id: next.gated_step_id! });
      }
    }
    const done = await f.storage.repository.inspect(proposal.proposal_id);
    expect(done.execution_status, JSON.stringify({ members: done.members, audit: f.db.prepare('SELECT data FROM audit_log').all() })).toBe('succeeded');
    expect(f.received).toHaveLength(scenario === 'nested_hold_parallel' ? 6 : scenario === 'repeated' || held ? 4 : 2);
    expect(done.members.every(member => member.status === 'succeeded')).toBe(true);
    const links = f.db.prepare('SELECT * FROM preapproval_run_links').all() as Array<{ run_id: string; root_run_id: string; parent_run_id: string }>;
    expect(links).toHaveLength(['repeated', 'nested_hold_deep', 'nested_hold_parallel'].includes(scenario) ? 2 : 1);
    expect(new Set(links.map(link => link.run_id)).size).toBe(links.length);
    expect(links.every(link => link.run_id !== link.root_run_id
      && (link.parent_run_id === link.root_run_id || links.some(parent => parent.run_id === link.parent_run_id)))).toBe(true);
    await f.execution.preapprovalDriver!.tickSchedules(f.clock.now);
    expect(f.received).toHaveLength(scenario === 'nested_hold_parallel' ? 6 : scenario === 'repeated' || held ? 4 : 2);
  });

  it.each(['fire', 'two_dispatchers', 'old_queued_event', 'restart_queue', 'destroy_before_claim', 'revoke_before_claim',
    'expired_before_claim', 'changed_filter', 'held', 'guard_skips', 'dynamic_event', 'dynamic_event_hold', 'oversized_event',
    'restart_refused'] as const)(
    'binds the first post-acceptance warehouse event through the actual trigger composer: %s', async scenario => {
      const f = await fixture('ask', scenario === 'held' || scenario === 'dynamic_event_hold', true);
      if (scenario === 'guard_skips') {
        const original = f.execution.executorConfig.manifests.get(catalog.slug)!;
        f.execution.executorConfig.manifests.register({ ...original, operations: { ...original.operations,
          'item.watch': { operation_id: 'test/catalog.item.watch', risk_tier: 'read', approval: 'ask', groups: [] },
        }, surfaces: { api: { ...original.surfaces!.api!, executes: { ...original.surfaces!.api!.executes,
          'item.watch': { kind: 'rest', method: 'GET', path_template: '/watch' },
        } } } });
        const recipe = f.sources.recipes.get(fixtureRecipe.recipe_id)!;
        f.sources.recipes.save({ ...recipe, auto_run: { interval_ms: 60_000, default_enabled: false }, trigger_steps: [{ id: 'watch', ingredient: catalog.slug,
          connection: '{{config.crm_connection}}', input: { operation: 'item.watch', args: {} },
          output: { 'result.should_run': 'should_run' } }] }, 'core', 'inline');
        wireCatalogOperationProfiles({ ...f.profiles, profileStore: f.profileStore });
      }
      if (scenario.startsWith('dynamic_event')) {
        const recipe = f.sources.recipes.get(fixtureRecipe.recipe_id)!;
        recipe.steps[0] = { id: 'a', ingredient: catalog.slug, connection: '{{config.crm_connection}}',
          input: { operation: scenario === 'dynamic_event_hold' ? 'item.confirm' : 'item.write', args: { id: '{{context.event.payload.record.id}}',
            'body.message': '{{context.event.payload.record.body}}' } } };
        f.sources.recipes.save(recipe, 'core', 'inline');
      }
      const triggerId = 'reviewed-trigger';
      f.sources.triggers.create({ trigger_id: triggerId, recipe_id: fixtureRecipe.recipe_id, publisher_id: 'core',
        pattern: 'data.test.live.item.updated', enabled: scenario === 'old_queued_event', created_at: f.clock.now,
        filter: { 'record.stage': 'ready' } });
      const bus = createWarehouseEventBus();
      const compose = () => composeEventTriggers({ db: f.db, warehouseBus: bus, executeDeps: f.execution,
        auditLog: f.execution.auditLog, eventBus: undefined, localManifestStore: undefined })!;
      const dispatchers = [compose()];
      if (scenario === 'two_dispatchers') dispatchers.push(compose());
      const driver = f.execution.preapprovalDriver!;
      const server = await startServer(0, { clientTokens: f.clients, preapprovalDeps: f.composed!.handlers });
      const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, { headers: { Authorization: `Bearer ${f.token.token_id}.${f.token.bearer}` } });
      let release: (() => void) | undefined;
      let delayed: Promise<void> | undefined;
      try {
        await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
        const request = f.request(); request.activation = { kind: 'next_trigger', trigger_id: triggerId, expected_revision: 1 };
        const { proposal_id } = await ownerRpc<{ proposal_id: string }>(socket, 'preapproval.prepare', request);
        const review = await ownerRpc<PreapprovalReview>(socket, 'preapproval.review', { proposal_id });
        expect(review.coverage, JSON.stringify(review.uncovered)).toBe(scenario === 'held' || scenario.startsWith('dynamic_event') ? 'partial' : 'complete');
        const event: WarehouseEvent = { platform: 'test', slug: 'live', entity_type: 'item', event_kind: 'updated',
          record_id: 'source-1', at: f.clock.now, record: { stage: 'ready', id: 'unreviewed-target', body: 'Unreviewed event content' },
          prev: { stage: 'draft' }, changed_fields: ['stage'] };
        const original = driver.executeTrigger.bind(driver);
        if (scenario === 'old_queued_event') {
          delayed = new Promise<void>(resolve => { release = resolve; });
          vi.spyOn(driver, 'executeTrigger').mockImplementationOnce(async (...args) => { await delayed; return original(...args); });
          bus.emit(event);
          expect(f.db.prepare('SELECT * FROM preapproval_trigger_ingress').all()).toHaveLength(1);
        }
        await ownerRpc(socket, 'preapproval.decide', { proposal_id, expected_revision: review.revision,
          review_digest: review.review_digest, challenge: review.challenge, decision: 'approve', request_id: randomUUID() });
        expect(f.sources.triggers.get(triggerId)?.enabled).toBe(false);
        if (scenario === 'old_queued_event') {
          release!(); await Promise.all(dispatchers.map(item => item.dispatcher.drained()));
          expect(f.received).toHaveLength(0);
          expect((await f.storage.repository.inspect(proposal_id)).execution_status).toBe('active');
          // Exact replay is still older than acceptance, even as a new object.
          bus.emit(structuredClone(event)); await dispatchers[0]!.dispatcher.drained();
          expect(f.received).toHaveLength(0); event.at += 1;
        }
        if (scenario === 'destroy_before_claim' || scenario === 'revoke_before_claim' || scenario === 'expired_before_claim') {
          vi.spyOn(driver, 'executeTrigger').mockImplementationOnce(async (...args) => {
            if (scenario === 'destroy_before_claim') {
              f.sources.triggers.remove(triggerId);
              f.sources.triggers.create({ trigger_id: triggerId, recipe_id: fixtureRecipe.recipe_id, publisher_id: 'core',
                pattern: 'data.test.live.item.updated', enabled: false, created_at: f.clock.now });
            } else if (scenario === 'revoke_before_claim') {
              const current = await f.storage.repository.inspect(proposal_id);
              await ownerRpc(socket, 'preapproval.revoke', { grant_id: current.grant!.grant_id,
                expected_revision: current.grant!.revision, request_id: randomUUID() });
            } else { f.clock.now = request.dispatch_deadline; f.storage.repository.expire(); }
            return original(...args);
          });
        }
        // Non-matching events cannot reserve the first qualifying slot.
        bus.emit({ ...event, record_id: 'ignored', record: { stage: 'draft' } });
        expect(f.storage.triggerIngress.get(review.future_execution_ref)).toBeUndefined();
        if (scenario === 'oversized_event') event.record!.body = 'x'.repeat(f.service.capabilities().limits.plan_bytes + 1);
        if (scenario === 'changed_filter') f.sources.triggers.update(triggerId, { pattern: 'data.test.live.other.updated' });
        // D-261 amendment 2026-10-26 — the drain begins in the instant after the
        // claim, so the run's own entry check refuses it.
        let refusing = scenario === 'restart_refused';
        if (refusing) f.execution.isDraining = () => refusing && (f.db.prepare('SELECT state FROM preapproval_executions WHERE future_ref=?')
          .get(review.future_execution_ref) as { state: string }).state === 'running';
        if (scenario === 'restart_queue') {
          // The bus ingress is durable before queue execution. Recreate both
          // private runtimes and recover through the real schedule pump.
          expect(driver.captureTrigger(f.sources.triggers.get(triggerId)!, event)).not.toBeNull();
          const runtime = createPreapprovalExecutionRuntime({ storage: f.storage, service: f.service });
          f.execution.preapprovalRuntime = runtime;
          f.execution.preapprovalDriver = createPreapprovalDriver({ storage: f.storage, runtime, execution: f.execution,
            activations: createPreapprovalActivations({ ...f.sources, circuits: createCircuitBreakerStore(f.db), now: () => f.clock.now }),
            settleRecovered: dispatchers[0]!.settleRecovered });
          event.record!.body = 'Changed after ingress';
          const scheduler = createScheduler({ store: f.sources.schedules, executeDeps: f.execution, now: () => f.clock.now });
          await scheduler.tick();
        } else {
          bus.emit(event);
          await Promise.all(dispatchers.map(item => item.dispatcher.drained()));
        }
        if (scenario === 'restart_refused') {
          // Handed back, and the event is still this approval's: after the
          // restart the recovery clock runs it, once.
          expect((await f.storage.repository.inspect(proposal_id)).execution_status).toBe('active');
          expect(f.received).toHaveLength(0);
          refusing = false;
          await f.execution.preapprovalDriver!.tickTriggers();
          expect((await f.storage.repository.inspect(proposal_id)).execution_status).toBe('succeeded');
          expect(f.received.map(call => call.url)).toEqual(['/v1/items/a', '/v1/items/b']);
          expect(f.db.prepare('SELECT * FROM preapproval_trigger_candidates').all()).toHaveLength(1);
          expect(f.db.prepare('SELECT COUNT(*) AS n FROM preapproval_occurrences WHERE future_ref=?')
            .get(review.future_execution_ref)).toEqual({ n: 1 });
          return;
        }
        if (scenario === 'held' || scenario === 'dynamic_event_hold') {
          expect((await f.storage.repository.inspect(proposal_id)).execution_status).toBe('held');
          expect(f.received).toHaveLength(0);
          const checkpoint = (f.db.prepare('SELECT data FROM checkpoints').all() as Array<{ data: string }>)
            .map(row => JSON.parse(row.data) as Checkpoint)[0]!;
          const resumer = createPreflightResumer({ getExecuteDeps: () => f.execution,
            auditLog: f.execution.auditLog!, gatedActionStore: f.execution.gatedActionStore });
          await resumer.resumeRun(checkpoint, { recipe_id: fixtureRecipe.recipe_id, gated_step_id: checkpoint.gated_step_id! });
          await f.composed!.outbox.drain();
        }
        const state = await f.storage.repository.inspect(proposal_id);
        if (scenario === 'oversized_event') {
          expect(state).toMatchObject({ execution_status: 'invalidated', status_reason: 'preapproval_limit_exceeded' });
          expect(f.storage.triggerIngress.get(review.future_execution_ref)).toBeUndefined();
        }
        const success = ['fire', 'two_dispatchers', 'old_queued_event', 'restart_queue', 'held', 'dynamic_event', 'dynamic_event_hold'].includes(scenario);
        expect(f.received.map(call => call.url), JSON.stringify(state)).toEqual(success
          ? [scenario.startsWith('dynamic_event') ? '/v1/items/unreviewed-target' : '/v1/items/a', '/v1/items/b'] : []);
        if (success) {
          expect(state.execution_status).toBe('succeeded');
          expect(state.members.every(member => member.status === 'succeeded')).toBe(true);
          if (scenario.startsWith('dynamic_event')) expect(state.members).toHaveLength(1);
          expect(f.db.prepare('SELECT * FROM preapproval_trigger_candidates').all()).toHaveLength(1);
          const stored = await f.storage.triggerIngress.read(review.future_execution_ref);
          expect(stored.event.record!.body).toBe('Unreviewed event content');
          expect(JSON.stringify(f.db.prepare('SELECT * FROM preapproval_trigger_candidates').all())).not.toContain('Unreviewed event content');
          const source = (f.db.prepare('SELECT data FROM commits').all() as Array<{ data: string }>)
            .map(row => JSON.parse(row.data) as Commit).filter(row => row.correlation_id === review.future_execution_ref);
          expect(source.length).toBeGreaterThan(0); expect(source.every(row => row.source?.actor === 'user_self')).toBe(true);
          // D-315 §6.4 — a run the recovery clock started is on the dispatcher's
          // books like a queued one: its `trigger_fired` names the run.
          const firedEntries = (await f.execution.auditLog!.listActivities()).filter(entry => entry.action === 'trigger_fired');
          expect(firedEntries).toMatchObject([{ target: `${triggerId}|source-1`,
            detail: scenario === 'held' || scenario === 'dynamic_event_hold' ? 'held' : 'completed', run_id: expect.any(String) }]);
          const before = f.received.length;
          bus.emit(stored.event); await Promise.all(dispatchers.map(item => item.dispatcher.drained()));
          await f.execution.preapprovalDriver!.tickTriggers(); expect(f.received).toHaveLength(before);
        } else if (scenario === 'guard_skips') {
          expect(f.provider.watch.count).toBe(1);
          expect(state.members.map(member => member.status)).toEqual(['succeeded', 'skipped', 'skipped']);
          expect(state.execution_status).toBe('succeeded');
          f.provider.watch.qualifies = true;
          bus.emit({ ...event, at: event.at + 1 }); await dispatchers[0]!.dispatcher.drained();
          expect(f.provider.watch.count).toBe(1); expect(f.received).toHaveLength(0);
        } else expect(['invalidated', 'cancelled', 'expired']).toContain(state.execution_status);
      } finally {
        release?.(); await Promise.all(dispatchers.map(item => item.dispatcher.drained()));
        for (const item of dispatchers) item.dispatcher.dispose(); bus.dispose(); socket.terminate(); await server.close();
      }
    }, 20_000);
  it.each(['skip_then_fire', 'no_watch', 'revoke_during_poll', 'destroy_during_poll', 'expired_during_poll', 'disabled_during_poll',
    'race', 'credential_revoked', 'watch_hold', 'watch_hold_runtime_recreated', 'watch_hold_revoke', 'prefetch_hold'] as const)(
    'claims an automatic run after ordinary qualification and before actual prefetch: %s', async scenario => {
      const f = await fixture('ask', false, true);
      const original = f.execution.executorConfig.manifests.get(catalog.slug)!;
      f.execution.executorConfig.manifests.register({ ...original, operations: { ...original.operations,
        'item.watch': { operation_id: 'test/catalog.item.watch', risk_tier: 'read', approval: scenario.startsWith('watch_hold') ? 'always' : 'never', groups: [] },
        'item.read': { operation_id: 'test/catalog.item.read', risk_tier: 'read', approval: scenario === 'prefetch_hold' ? 'always' : 'ask', groups: [] },
      }, surfaces: { api: { ...original.surfaces!.api!, executes: { ...original.surfaces!.api!.executes,
        'item.watch': { kind: 'rest', method: 'GET', path_template: '/watch' },
        'item.read': { kind: 'rest', method: 'GET', path_template: '/prefetch' },
      } } } });
      const recipe = f.sources.recipes.get(fixtureRecipe.recipe_id)!;
      f.sources.recipes.save({ ...recipe, auto_run: { interval_ms: 60_000, default_enabled: false },
        ...(scenario === 'no_watch' ? {} : { trigger_steps: [{ id: 'watch', ingredient: catalog.slug,
          connection: '{{config.crm_connection}}', input: { operation: 'item.watch', args: {} }, output: { 'result.should_run': 'should_run' } }] }),
        // `prefetch_hold` keeps `approval: 'always'` on `item.read` so the ordinary
        // gate still asks — but since `always` became eligible (2026-09-06) that
        // no longer leaves the call UNCOVERED, and this scenario needs both. The
        // deferred `context.event` reference supplies the uncovered half on its
        // own terms; without it the case silently became a covered-path test.
        prefetch_steps: [{ id: 'prefetch', ingredient: catalog.slug, connection: '{{config.crm_connection}}',
          input: { operation: 'item.read',
            args: scenario === 'prefetch_hold' ? { deferred: '{{context.event.payload.id}}' } : {} } }],
      }, 'core', 'inline');
      wireCatalogOperationProfiles({ ...f.profiles, profileStore: f.profileStore });
      // D-319 — the recipe switched on as one dish, its timer off: a reviewed
      // next run is what starts it.
      f.sources.dishes.set({ dish_id: 'dsh_auto', recipe_id: recipe.recipe_id, publisher_id: 'core', name: '', is_default: true,
        config_overlay: {}, enabled: true, created_at: 1 });
      f.sources.autoRun.setEnabled('dsh_auto', recipe.recipe_id, false);
      const request = f.request(); request.activation = { kind: 'next_auto_run', recipe_id: recipe.recipe_id,
        publisher_id: 'core', dish_id: 'dsh_auto', expected_revision: 1 };
      const { proposal_id } = await f.service.prepare(request, f.origin);
      const review = await f.storage.repository.review(proposal_id, f.responder);
      expect(review.coverage, JSON.stringify(review.uncovered)).toBe(scenario === 'prefetch_hold' ? 'partial' : 'complete');
      // ⚠ `prefetch_hold`'s read is deliberately uncovered, so it is NOT a
      // member — the two writes are. Every other scenario freezes all three.
      expect(review.members.map(member => member.op_id)).toEqual(
        scenario === 'prefetch_hold'
          ? ['test/catalog.item.write', 'test/catalog.item.write']
          : ['test/catalog.item.read', 'test/catalog.item.write', 'test/catalog.item.write'],
      );
      expect(f.provider.watch.count).toBe(0); expect(f.received).toHaveLength(0);
      await f.storage.repository.decide(await f.decision(proposal_id), f.responder);
      expect(f.sources.autoRun.isEnabled('dsh_auto')).toBe(false);
      const scheduler = createServerAutoRunScheduler({ recipeStore: f.sources.recipes, executeDeps: f.execution,
        settingsStore: f.sources.autoRun, circuitStore: createCircuitBreakerStore(f.db), now: () => f.clock.now });
      const executed = vi.spyOn(f.execution.preapprovalDriver!, 'executeAutoRun');
      await scheduler.refreshRoster();
      expect(scheduler.roster.has('dsh_auto')).toBe(true);
      if (scenario === 'skip_then_fire') {
        await scheduler.tick(); f.clock.now += 60_000; await scheduler.tick();
        expect(f.provider.watch.count).toBe(2); expect(f.received).toHaveLength(0);
        const still = await f.storage.repository.inspect(proposal_id);
        expect(still.execution_status).toBe('active');
        expect(still.members.every(member => member.status === 'available')).toBe(true);
        f.clock.now += 1; // remain inside the reviewed dispatch window
      }
      f.provider.watch.qualifies = true;
      if (scenario === 'credential_revoked') f.clients.revoke(f.token.token_id, 'owner');
      if (scenario === 'revoke_during_poll') f.provider.watch.beforeRespond = async () => {
        const current = await f.storage.repository.inspect(proposal_id);
        await f.storage.repository.revoke({ grant_id: current.grant!.grant_id,
          expected_revision: current.grant!.revision, request_id: randomUUID() }, f.responder);
      };
      if (scenario === 'destroy_during_poll') f.provider.watch.beforeRespond = async () => { f.sources.recipes.delete(recipe.recipe_id); };
      if (scenario === 'expired_during_poll') f.provider.watch.beforeRespond = async () => { f.clock.now = request.dispatch_deadline; };
      if (scenario === 'disabled_during_poll') f.provider.watch.beforeRespond = async () => { f.sources.autoRun.setEnabled('dsh_auto', recipe.recipe_id, false); };
      if (scenario === 'race') {
        let release!: () => void; const both = new Promise<void>(resolve => { release = resolve; });
        f.provider.watch.beforeRespond = async () => { if (f.provider.watch.count === 2) release(); await both; };
        const poll = { recipe_id: recipe.recipe_id, dish_id: 'dsh_auto', trigger_source: 'auto_run' as const };
        await Promise.allSettled([f.execution.preapprovalDriver!.executeAutoRun(poll, false),
          f.execution.preapprovalDriver!.executeAutoRun(poll, false)]);
      } else {
        // Due scheduling is an actual server roster/tick, including the
        // parked-row projection and the fire-time eligibility recheck.
        scheduler.roster.get('dsh_auto')!.next_run_at = f.clock.now;
        await scheduler.tick();
      }
      if (scenario.startsWith('watch_hold') || scenario === 'prefetch_hold') {
        const cp = (f.db.prepare('SELECT data FROM checkpoints').all() as Array<{ data: string }>).map(row => JSON.parse(row.data) as Checkpoint)[0];
        expect(cp, JSON.stringify(await Promise.allSettled(executed.mock.results.map(result => result.value)))).toBeDefined();
        expect(cp).toMatchObject({ gated_step_id: scenario === 'prefetch_hold' ? 'prefetch' : 'watch',
          execution_phase: scenario === 'prefetch_hold' ? 'prefetch' : 'trigger' });
        if (scenario === 'prefetch_hold') {
          expect(cp!.preapproval_execution_ref).toBe(review.future_execution_ref);
          expect((await f.storage.repository.inspect(proposal_id)).execution_status).toBe('held');
        } else {
          expect(cp!.preapproval_candidate_ref).toMatch(/^papoll_/);
          expect(cp!.preapproval_execution_ref).toBeUndefined();
          expect((await f.storage.repository.inspect(proposal_id)).execution_status).toBe('active');
          expect(f.provider.watch.count).toBe(0);
          await expect(handleExecute(f.execution, { recipe_id: recipe.recipe_id, config: { crm_connection: 'crm' }, execution_source: f.origin.source },
            { run_id: cp!.run_id })).rejects.toMatchObject({ code: 'preapproval_stale' });
          await expect(f.runtime.resume({ ...cp!, step_state: { injected: true } })).rejects.toMatchObject({ code: 'preapproval_stale' });
        }
        if (scenario === 'watch_hold_runtime_recreated') {
          f.execution.preapprovalRuntime = createPreapprovalExecutionRuntime({ storage: f.storage, service: f.service });
          f.execution.preapprovalDriver = createPreapprovalDriver({ storage: f.storage, execution: f.execution,
            runtime: f.execution.preapprovalRuntime, activations: createPreapprovalActivations({ ...f.sources, circuits: createCircuitBreakerStore(f.db), now: () => f.clock.now }) });
        }
        if (scenario === 'watch_hold_revoke') {
          const current = await f.storage.repository.inspect(proposal_id);
          await f.storage.repository.revoke({ grant_id: current.grant!.grant_id, expected_revision: current.grant!.revision, request_id: randomUUID() }, f.responder);
        }
        const resumer = createPreflightResumer({ getExecuteDeps: () => f.execution,
          auditLog: f.execution.auditLog!, gatedActionStore: f.execution.gatedActionStore });
        if (scenario === 'watch_hold_revoke') {
          await expect(resumer.resumeRun(cp!, { recipe_id: recipe.recipe_id, gated_step_id: cp!.gated_step_id! }))
            .rejects.toMatchObject({ code: 'preapproval_cancelled' });
          expect(f.provider.watch.count).toBe(0);
        } else {
          await resumer.resumeRun(cp!, { recipe_id: recipe.recipe_id, gated_step_id: cp!.gated_step_id! });
          await resumer.resumeRun(cp!, { recipe_id: recipe.recipe_id, gated_step_id: cp!.gated_step_id! });
        }
      }
      const status = await f.storage.repository.inspect(proposal_id);
      const success = ['skip_then_fire', 'no_watch', 'race', 'watch_hold', 'watch_hold_runtime_recreated', 'prefetch_hold'].includes(scenario);
      const results = (await Promise.allSettled(executed.mock.results.map(result => result.value)))
        .map(result => result.status === 'rejected' ? { ...result, reason: String(result.reason), stack: result.reason.stack } : result);
      expect(f.received, JSON.stringify({ status: status.execution_status, members: status.members, results })).toHaveLength(success ? 3 : 0);
      expect(status.execution_status).toBe(success ? 'succeeded' : ['revoke_during_poll', 'watch_hold_revoke'].includes(scenario) ? 'cancelled'
        : scenario === 'expired_during_poll' ? 'expired' : 'invalidated');
      expect(f.received.map(call => call.url)).toEqual(success ? ['/v1/prefetch', '/v1/items/a', '/v1/items/b'] : []);
      // D-319 — the reviewed run is its dish's run: the dish's history has it.
      if (['skip_then_fire', 'no_watch', 'race'].includes(scenario)) {
        expect((await f.execution.auditLog!.listByDish('dsh_auto', 10)).length).toBeGreaterThan(0);
      }
      const commits = (f.db.prepare('SELECT data FROM commits').all() as Array<{ data: string }>).map(row => JSON.parse(row.data) as Commit);
      expect(commits.every(commit => commit.source.channel === 'user'), JSON.stringify(commits)).toBe(true);
      expect(await f.block.listOpenAsks()).toHaveLength(0);
      f.clock.now += 60_000; await scheduler.tick();
      expect(f.received).toHaveLength(success ? 3 : 0);
    }, 20_000);

  it('D-319 — an automatic run names the dish whose timer fired, or the driver refuses it', async () => {
    const f = await fixture('never', false, true);
    await expect(f.execution.preapprovalDriver!.executeAutoRun(
      { recipe_id: fixtureRecipe.recipe_id, trigger_source: 'auto_run' }, true))
      .rejects.toMatchObject({ code: 'preapproval_stale', message: 'An automatic run requires the dish whose timer fired.' });
  });

  it.each(['qualifies_before_decision', 'old_poll_after_decision', 'disarmed_timer', 'ordinary_hold_then_accept'] as const)(
    'fences ordinary automatic polls against owner review and stale timers: %s', async scenario => {
      const f = await fixture('never', false, true);
      const original = f.execution.executorConfig.manifests.get(catalog.slug)!;
      f.execution.executorConfig.manifests.register({ ...original, operations: {
        'item.watch': { operation_id: 'test/catalog.item.watch', risk_tier: 'read', approval: scenario === 'ordinary_hold_then_accept' ? 'always' : 'never', groups: [] },
        'item.read': { operation_id: 'test/catalog.item.read', risk_tier: 'read', approval: 'never', groups: [] },
      }, surfaces: { api: { ...original.surfaces!.api!, executes: {
        'item.watch': { kind: 'rest', method: 'GET', path_template: '/watch' },
        'item.read': { kind: 'rest', method: 'GET', path_template: '/prefetch' },
      } } } });
      const recipe = f.sources.recipes.get(fixtureRecipe.recipe_id)!;
      f.sources.recipes.save({ ...recipe, auto_run: { interval_ms: 60_000 },
        trigger_steps: [{ id: 'watch', ingredient: catalog.slug, connection: '{{config.crm_connection}}',
          input: { operation: 'item.watch', args: {} }, output: { 'result.should_run': 'should_run' } }],
        steps: [{ id: 'read', ingredient: catalog.slug, connection: '{{config.crm_connection}}', input: { operation: 'item.read', args: {} } }],
      }, 'core', 'inline');
      wireCatalogOperationProfiles({ ...f.profiles, profileStore: f.profileStore });
      // D-319 — the recipe switched on as one dish, its timer on.
      f.sources.dishes.set({ dish_id: 'dsh_auto', recipe_id: recipe.recipe_id, publisher_id: 'core', name: '', is_default: true,
        config_overlay: {}, enabled: true, created_at: 1 });
      f.sources.autoRun.setEnabled('dsh_auto', recipe.recipe_id, true);
      const request = f.request(); request.activation = { kind: 'next_auto_run', recipe_id: recipe.recipe_id,
        publisher_id: 'core', dish_id: 'dsh_auto', expected_revision: 1 };
      const { proposal_id } = await f.service.prepare(request, f.origin);
      const approve = await f.decision(proposal_id);
      const scheduler = createServerAutoRunScheduler({ recipeStore: f.sources.recipes, executeDeps: f.execution,
        settingsStore: f.sources.autoRun, circuitStore: createCircuitBreakerStore(f.db), now: () => f.clock.now });
      await scheduler.refreshRoster(); f.provider.watch.qualifies = true;
      if (scenario === 'old_poll_after_decision') f.provider.watch.beforeRespond = async () => {
        await f.storage.repository.decide(approve, f.responder);
      };
      if (scenario === 'disarmed_timer') f.sources.autoRun.setEnabled('dsh_auto', recipe.recipe_id, false);
      await scheduler.tick();
      expect(f.provider.watch.count).toBe(scenario === 'disarmed_timer' || scenario === 'ordinary_hold_then_accept' ? 0 : 1);
      if (scenario === 'ordinary_hold_then_accept') {
        const cp = (f.db.prepare('SELECT data FROM checkpoints').all() as Array<{ data: string }>).map(row => JSON.parse(row.data) as Checkpoint)[0]!;
        expect(cp).toMatchObject({ execution_phase: 'trigger',
          auto_run_qualification: { recipe_id: recipe.recipe_id, dish_id: 'dsh_auto', qualifying_sequence: 0 } });
        await f.storage.repository.decide(approve, f.responder);
        const resumer = createPreflightResumer({ getExecuteDeps: () => f.execution,
          auditLog: f.execution.auditLog!, gatedActionStore: f.execution.gatedActionStore });
        await resumer.resumeRun(cp, { recipe_id: recipe.recipe_id, gated_step_id: cp.gated_step_id! });
        const audit = (f.db.prepare('SELECT data FROM audit_log').all() as Array<{ data: string }>).map(row => JSON.parse(row.data));
        expect(f.provider.watch.count, JSON.stringify(audit)).toBe(1); expect(f.received).toHaveLength(0);
        expect(JSON.stringify(audit)).toContain('The automation changed.');
        expect((await f.storage.repository.inspect(proposal_id)).execution_status).toBe('active');
      }
      if (scenario === 'qualifies_before_decision') {
        expect(f.received).toHaveLength(1);
        await expect(f.storage.repository.decide(approve, f.responder)).rejects.toMatchObject({ code: 'preapproval_stale' });
      } else {
        expect(f.received).toHaveLength(0);
        if (scenario === 'old_poll_after_decision') {
          expect((await f.storage.repository.inspect(proposal_id)).execution_status).toBe('active');
          expect(createCircuitBreakerStore(f.db).get('dsh_auto')).toMatchObject({
            consecutive_failures: 0, auto_disabled: false,
          });
          f.provider.watch.beforeRespond = undefined;
          await scheduler.refreshRoster(); scheduler.roster.get('dsh_auto')!.next_run_at = f.clock.now;
          await scheduler.tick();
          expect(f.received).toHaveLength(1);
          expect((await f.storage.repository.inspect(proposal_id)).execution_status).toBe('succeeded');
          expect(f.sources.autoRun.isEnabled('dsh_auto')).toBe(true);
        }
      }
    });

  it.each(['binary', 'multipart', 'contract_binary', 'contract_denied', 'contract_last_use', 'changed_binding', 'changed_connection', 'account_at_egress', 'missing_bytes', 'read_always', 'uncertain'] as const)(
    'one owner review covers the actual catalog HTTP upload and its immutable file read: %s', async scenario => {
      const f = await fixture('ask', false, true, true); const mail = f.mail!;
      const bytes = Buffer.from('Reviewed upload bytes.');
      const file = await mail.fileCollection.ingest({ bytes, filename: 'reviewed.txt', mime_type: 'text/plain', origin: 'mail_attachment', source_id: 'upload-file' });
      const manifests = f.execution.executorConfig.manifests;
      const original = manifests.get(catalog.slug)!;
      const upload: IngredientManifest = { ...original, operations: { ...original.operations,
        'file.upload': { operation_id: 'test/catalog.file.upload', risk_tier: 'write', approval: 'ask', groups: [] } },
      surfaces: { api: { ...original.surfaces!.api!, executes: { ...original.surfaces!.api!.executes,
        'file.upload': { kind: 'rest', method: 'POST', path_template: '/upload',
          upload: scenario === 'multipart' ? { kind: 'multipart', arg: 'upload_ref', field: 'attachment', max_bytes: 1000 }
            : { kind: 'binary', arg: 'upload_ref', max_bytes: 1000 } },
      } } } };
      manifests.register(upload); wireCatalogOperationProfiles({ ...f.profiles, profileStore: f.profileStore });
      createContractStore(f.db).put('owner_operation', ['data-file-read', 'data-file-read'], { approval: 'ask', op_hash: 'read-ask' });
      const stored = f.sources.recipes.get(fixtureRecipe.recipe_id)!;
      f.sources.recipes.save({ ...stored, steps: [{ id: 'upload', ingredient: catalog.slug, connection: '{{config.crm_connection}}',
        input: { operation: 'file.upload', args: { upload_ref: file.record_id, ...(scenario === 'multipart' ? { 'body.caption': 'Reviewed caption' } : {}) } } }, stored.steps[0]!] }, 'core', 'inline');
      const request = f.request();
      let contractId: string | null = null;
      if (scenario.startsWith('contract_')) {
        const entry = 'recued_ingredient_preapproval-request';
        const def = f.definitions.mint({ minted_by: 'owner', display_name: 'Upload assistant', door_types: ['mcp'],
          ...(scenario === 'contract_last_use' ? { max_uses: 4 } : {}),
          scope: { channels: ['mcp'], actors: ['contracted_user'], operation_ids: ['core.preapproval.request', 'core.schedule.recipe',
            'core.storage.data-file-read', 'test/catalog.file.upload', 'test/catalog.item.write'] } });
        contractId = def.contract_id;
        for (const op of ['core.preapproval.request', 'core.schedule.recipe', 'core.storage.data-file-read']) f.grants.set(def.contract_id, opGrantEntry(op), true, f.clock.now);
        const issued = f.inbound.issueToken({ value: { label: 'Upload MCP client', grants: { [entry]: true, [`core/${fixtureRecipe.recipe_id}`]: true },
          concurrency_tier: 3, chat_mode: null, contract_id: def.contract_id }, now: f.clock.now });
        const dispatch = createMcpHttpDispatch({ ...f.execution, mcpTokenId: issued.record.token_id, boundContractId: def.contract_id,
          boundContractActive: true, inboundTokenAuthorize: name => isMcpInboundTokenToolAuthorized(f.inbound.getTokenById(issued.record.token_id)!, name, f.clock.now) });
        await dispatch({ jsonrpc: '2.0', id: 'review-upload', method: 'tools/call', params: { name: entry, arguments: request } });
      } else {
        const response = await handleExecute(f.execution, { recipe: { ...fixtureRecipe, recipe_id: 'ask-upload-review',
        metadata: { ...fixtureRecipe.metadata, description: 'Ask for one review of the file upload and HTTP operation.' },
        steps: [{ id: 'review', ingredient: 'preapproval-request', input: { ...request } }] }, execution_source: f.origin.source });
        expect(response.success, JSON.stringify(response)).toBe(true);
      }
      const asks = await f.block.listOpenAsks(); expect(asks).toHaveLength(1);
      const proposal_id = asks[0]!.handler_payload.proposal_id as string;
      const server = await startServer(0, { clientTokens: f.clients, preapprovalDeps: f.composed!.handlers });
      const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, { headers: { Authorization: `Bearer ${f.token.token_id}.${f.token.bearer}` } });
      try {
        await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
        const review = await ownerRpc<PreapprovalReview>(socket, 'preapproval.review', { proposal_id });
        expect(review.coverage, JSON.stringify(review.uncovered)).toBe('complete');
        expect(review.members.map(member => member.family)).toEqual(['http', 'kernel', 'http']);
        expect(review.members[0]!.required_child_ids).toEqual([review.members[1]!.member_id]);
        expect(mail.getBytes).not.toHaveBeenCalled(); expect(f.uploads).toHaveLength(0);
        await ownerRpc(socket, 'preapproval.decide', { proposal_id, expected_revision: review.revision,
          review_digest: review.review_digest, challenge: review.challenge, decision: 'approve', request_id: randomUUID() });
        expect(mail.fileCollection.delete(file.record_id)).toBe(true);
        if (scenario === 'changed_binding') manifests.register({ ...upload,
          surfaces: { api: { ...upload.surfaces!.api!, executes: { ...upload.surfaces!.api!.executes,
            'file.upload': { kind: 'rest', method: 'POST', path_template: '/different', upload: { kind: 'binary', arg: 'upload_ref', max_bytes: 1000 } } } } } });
        if (scenario === 'changed_connection') f.connections.upsert({ ...f.connections.get('api', 'crm')!, auth_ciphertext: 'replacement-account' });
        if (scenario === 'read_always') createContractStore(f.db).put('owner_operation', ['data-file-read', 'data-file-read'], { approval: 'always', op_hash: 'read-always' });
        if (scenario === 'contract_denied') f.grants.set(contractId!, opGrantEntry('core.storage.data-file-read'), false, f.clock.now);
        if (scenario === 'account_at_egress') f.execution.executorConfig.connectionApi!.beforeRequest = async () => {
          const old = f.connections.get('api', 'crm')!;
          f.connections.upsert({ ...old, auth_ciphertext: 'another-account' }); f.connections.upsert(old);
        };
        if (scenario === 'missing_bytes') await mail.blobs.delete(file.blob_hash!);
        if (scenario === 'uncertain') f.provider.dropResponse = true;
        const plan = await f.storage.repository.loadExecution(review.future_execution_ref); f.clock.now = plan.target.due_at!;
        const scheduler = createScheduler({ store: f.sources.schedules, executeDeps: f.execution, now: () => f.clock.now });
        await scheduler.tick(); await scheduler.tick();
        const status = await f.storage.repository.inspect(proposal_id);
        const success = ['binary', 'multipart', 'contract_binary', 'contract_last_use'].includes(scenario);
        expect(f.uploads, JSON.stringify({ state: status.execution_status, members: status.members })).toHaveLength(success || scenario === 'uncertain' ? 1 : 0);
        if (success && scenario !== 'multipart') { expect(f.uploads[0]!.bytes).toEqual(bytes); expect(f.uploads[0]!.content_type).toBe('text/plain'); }
        if (scenario === 'multipart') {
          expect(f.uploads[0]!.content_type).toMatch(/^multipart\/form-data; boundary=/);
          const body = f.uploads[0]!.bytes.toString();
          expect(body).toContain('name="attachment"; filename="reviewed.txt"');
          expect(body).toContain(bytes.toString()); expect(body).toContain('Reviewed caption');
        }
        expect(f.received).toHaveLength(success ? 1 : 0);
        expect(status.execution_status).toBe(success ? 'succeeded' : scenario === 'uncertain' ? 'in_doubt'
          : scenario === 'missing_bytes' ? 'failed' : scenario === 'account_at_egress' ? 'partial' : 'invalidated');
        if (success) { expect(status.members[1]!.status).toBe('succeeded'); expect(status.members[1]!.commit_id).toBeTruthy(); }
        if (scenario === 'read_always' || scenario === 'contract_denied') expect(mail.getBytes).not.toHaveBeenCalled();
        if (contractId && success) {
          if (scenario === 'contract_last_use') expect(f.definitions.get(contractId)?.uses_remaining).toBe(0);
          const ids = new Set(status.members.map(member => member.commit_id));
          const commits = (f.db.prepare('SELECT data FROM commits').all() as Array<{ data: string }>).map(row => JSON.parse(row.data) as Commit)
            .filter(commit => ids.has(commit.commit_id));
          expect(commits).toHaveLength(3);
          expect(commits.every(commit => commit.contract_snapshot?.contract_id === contractId && commit.source.actor === 'contracted_user')).toBe(true);
        }
        expect(mail.sent).toEqual([]); expect(await f.block.listOpenAsks()).toHaveLength(0);
        expect(f.storage.repository.listPrompts(proposal_id)).toHaveLength(1);
      } finally { socket.terminate(); await server.close(); }
    });
  it.each(['run', 'file', 'file_always', 'contract_file', 'contract_file_last_use', 'contract_file_denied', 'missing_file_bytes', 'changed_model', 'restored_model', 'recreated_source', 'source_at_egress', 'same_source', 'another_slot', 'known_protocol', 'protocol_fallback', 'uncertain', 'pii_fields'] as const)(
    'one owner decision covers HTTP and the actual AI provider request with required file reads: %s', async scenario => {
      const fileBacked = ['file', 'file_always', 'contract_file', 'contract_file_last_use', 'contract_file_denied', 'missing_file_bytes'].includes(scenario);
      const f = await fixture('ask', false, true, fileBacked, false, false, true);
      if (scenario === 'known_protocol') hydrateEndpointCapabilities([{ fingerprint: endpointFingerprint(f.llm.getConfig().slot_1!),
        json_mode_unsupported: true, system_role_unsupported: true }]);
      let file: Awaited<ReturnType<NonNullable<typeof f.mail>['fileCollection']['ingest']>> | undefined;
      const bytes = Buffer.from('Reviewed document content.');
      if (fileBacked) {
        file = await f.mail!.fileCollection.ingest({ bytes, filename: 'review.pdf', mime_type: 'application/pdf', origin: 'mail_attachment', source_id: 'ai-file' });
        createContractStore(f.db).put('owner_operation', ['data-file-read', 'data-file-read'], { approval: 'ask', op_hash: 'read-ask' });
        const recipe = f.sources.recipes.get(fixtureRecipe.recipe_id)!;
        f.sources.recipes.save({ ...recipe, steps: recipe.steps.map(step => step.id === 'ai'
          ? { ...step, input: { 'llm.data': { file_ref: file!.record_id } } } : step) }, 'core', 'inline');
      }
      // A step's `pii_fields` are hashed by the dispatch, so the review must build the
      // request with the same per-call tokens or the run refuses at the provider.
      if (scenario === 'pii_fields') {
        const recipe = f.sources.recipes.get(fixtureRecipe.recipe_id)!;
        f.sources.recipes.save({ ...recipe, steps: recipe.steps.map(step => step.id === 'ai'
          ? { ...step, input: { 'llm.data': { author: 'Dana Whitfield', report: 'The reviewed quarterly report.' } }, pii_fields: ['author'] }
          : step) }, 'core', 'inline');
      }
      const server = await startServer(0, { clientTokens: f.clients, preapprovalDeps: f.composed!.handlers });
      const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, { headers: { Authorization: `Bearer ${f.token.token_id}.${f.token.bearer}` } });
      try {
        await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
        const request = f.request();
        let contractId: string | null = null;
        if (scenario.startsWith('contract_')) {
          const entry = 'recued_ingredient_preapproval-request';
          const def = f.definitions.mint({ minted_by: 'owner', display_name: 'Document assistant', door_types: ['mcp'],
            ...(scenario === 'contract_file_last_use' ? { max_uses: 5 } : {}),
            scope: { channels: ['mcp'], actors: ['contracted_user'], operation_ids: ['core.preapproval.request', 'core.schedule.recipe',
              'ai-summarize', 'core.storage.data-file-read', 'test/catalog.item.write'] } });
          contractId = def.contract_id;
          for (const op of ['core.preapproval.request', 'core.schedule.recipe', 'core.storage.data-file-read']) f.grants.set(def.contract_id, opGrantEntry(op), true, f.clock.now);
          const issued = f.inbound.issueToken({ value: { label: 'Document MCP client', grants: { [entry]: true, [`core/${fixtureRecipe.recipe_id}`]: true },
            concurrency_tier: 3, chat_mode: null, contract_id: def.contract_id }, now: f.clock.now });
          const dispatch = createMcpHttpDispatch({ ...f.execution, mcpTokenId: issued.record.token_id, boundContractId: def.contract_id,
            boundContractActive: true, inboundTokenAuthorize: name => isMcpInboundTokenToolAuthorized(f.inbound.getTokenById(issued.record.token_id)!, name, f.clock.now) });
          await dispatch({ jsonrpc: '2.0', id: 'review-ai', method: 'tools/call', params: { name: entry, arguments: request } });
        } else {
          const response = await handleExecute(f.execution, { recipe: { ...fixtureRecipe, recipe_id: 'ask-ai-review',
          metadata: { ...fixtureRecipe.metadata, description: 'Request one owner review for HTTP and AI.' },
          steps: [{ id: 'review', ingredient: 'preapproval-request', input: { ...request } }] }, execution_source: f.origin.source });
          expect(response.success, JSON.stringify(response)).toBe(true);
        }
        const asks = await f.block.listOpenAsks(); expect(asks).toHaveLength(1);
        const proposal_id = asks[0]!.handler_payload.proposal_id as string;
        const review = await ownerRpc<PreapprovalReview>(socket, 'preapproval.review', { proposal_id });
        expect(review.coverage, JSON.stringify(review.uncovered)).toBe('complete');
        expect(review.members.map(member => member.family)).toEqual(fileBacked ? ['http', 'ai', 'kernel', 'http'] : ['http', 'ai', 'http']);
        expect(JSON.stringify(review)).not.toContain('test-owner-secret');
        expect(JSON.stringify(review.members[1]!.arguments)).toContain('reviewed-model');
        expect(f.aiReceived).toHaveLength(0); expect(f.received).toHaveLength(0);
        if (fileBacked) expect(f.mail!.getBytes).not.toHaveBeenCalled();
        await ownerRpc(socket, 'preapproval.decide', { proposal_id, expected_revision: review.revision,
          review_digest: review.review_digest, challenge: review.challenge, decision: 'approve', request_id: randomUUID() });
        const slot = f.llm.getConfig().slot_1!;
        if (file) expect(f.mail!.fileCollection.delete(file.record_id)).toBe(true);
        if (scenario === 'changed_model' || scenario === 'restored_model') f.llm.setSlot1({ ...slot, model: 'unreviewed-model' });
        if (scenario === 'recreated_source') f.llm.setSlot1(null);
        if (scenario === 'restored_model' || scenario === 'recreated_source') f.llm.setSlot1(slot);
        if (scenario === 'file_always') createContractStore(f.db).put('owner_operation', ['data-file-read', 'data-file-read'], { approval: 'always', op_hash: 'read-always' });
        if (scenario === 'contract_file_denied') f.grants.set(contractId!, opGrantEntry('core.storage.data-file-read'), false, f.clock.now);
        if (scenario === 'missing_file_bytes') await f.mail!.blobs.delete(file!.blob_hash!);
        if (scenario === 'source_at_egress') vi.spyOn(f.llmQuota, 'registerRequest').mockImplementation(() => {
          f.llm.setSlot1({ ...slot, api_key: 'another-account' }); f.llm.setSlot1(slot);
        });
        if (scenario === 'another_slot') { f.llm.setSlot2({ ...slot, model: 'another-model' }); f.llmQuota.advanceCursor('byok:quality'); }
        if (scenario === 'same_source') { f.llm.setSlot1({ ...slot, api_key: '' }); f.llm.addUsage(42); }
        if (scenario === 'protocol_fallback') f.provider.rejectJson = true;
        if (scenario === 'uncertain') vi.spyOn(f.llmQuota, 'registerRequest').mockImplementation(() => { f.provider.dropResponse = true; });
        const plan = await f.storage.repository.loadExecution(review.future_execution_ref);
        f.clock.now = plan.target.due_at!;
        const scheduler = createScheduler({ store: f.sources.schedules, executeDeps: f.execution, now: () => f.clock.now });
        await scheduler.tick(); await scheduler.tick();
        const status = await f.storage.repository.inspect(proposal_id);
        const success = ['run', 'file', 'contract_file', 'contract_file_last_use', 'another_slot', 'same_source', 'known_protocol', 'pii_fields'].includes(scenario);
        const attempted = success || scenario === 'protocol_fallback' || scenario === 'uncertain';
        expect(f.aiReceived, JSON.stringify({ status: status.execution_status, members: status.members })).toHaveLength(attempted ? 1 : 0);
        if (attempted) expect(f.aiReceived[0]!.model).toBe('reviewed-model');
        if (success && fileBacked) {
          expect(JSON.stringify(f.aiReceived[0])).toContain(bytes.toString('base64'));
          expect(f.mail!.getBytes).toHaveBeenCalledTimes(1);
          expect(status.members[2]).toMatchObject({ status: 'succeeded' });
          expect(status.members[2]!.commit_id).toBeTruthy();
        }
        if (scenario === 'pii_fields') {
          expect(JSON.stringify(review.members[1]!.arguments)).toContain('HASH_STEP_00000001');
          expect(JSON.stringify(review.members[1]!.arguments)).not.toContain('Dana Whitfield');
          expect(JSON.stringify(f.aiReceived[0])).toContain('HASH_STEP_00000001');
          expect(JSON.stringify(f.aiReceived[0])).not.toContain('Dana Whitfield');
        }
        if (scenario === 'known_protocol') {
          expect(f.aiReceived[0]!.response_format).toBeUndefined();
          expect((f.aiReceived[0]!.messages as Array<{ role: string }>).some(message => message.role === 'system')).toBe(false);
        }
        if (contractId && success) {
          if (scenario === 'contract_file_last_use') expect(f.definitions.get(contractId)?.uses_remaining).toBe(0);
          const ids = new Set(status.members.map(member => member.commit_id));
          const commits = (f.db.prepare('SELECT data FROM commits').all() as Array<{ data: string }>).map(row => JSON.parse(row.data) as Commit)
            .filter(commit => ids.has(commit.commit_id));
          expect(commits).toHaveLength(4);
          expect(commits.every(commit => commit.contract_snapshot?.contract_id === contractId && commit.source.actor === 'contracted_user')).toBe(true);
        }
        if (scenario === 'file_always' || scenario === 'contract_file_denied') expect(f.mail!.getBytes).not.toHaveBeenCalled();
        const invalidatedBeforeDispatch = ['changed_model', 'restored_model', 'recreated_source', 'file_always', 'contract_file_denied'].includes(scenario);
        expect(status.execution_status).toBe(success ? 'succeeded' : scenario === 'uncertain' || scenario === 'protocol_fallback' ? 'in_doubt'
          : invalidatedBeforeDispatch ? 'invalidated' : 'partial');
        expect(f.received).toHaveLength(success ? 2 : invalidatedBeforeDispatch ? 0 : 1);
        expect(f.storage.repository.listPrompts(proposal_id)).toHaveLength(1);
        expect(await f.block.listOpenAsks()).toHaveLength(0);
      } finally { socket.terminate(); await server.close(); }
    });
  it.each(['run', 'changed_script', 'recreated_script', 'reach_revoked', 'reach_regranted', 'uncertain'] as const)(
    'the same owner review pins and dispatches a real local CLI process: %s', async scenario => {
      const f = await fixture('ask', false, true, false, false, true);
      const server = await startServer(0, { clientTokens: f.clients, preapprovalDeps: f.composed!.handlers });
      const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, { headers: { Authorization: `Bearer ${f.token.token_id}.${f.token.bearer}` } });
      try {
        await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
        const proposal = await ownerRpc<{ proposal_id: string }>(socket, 'preapproval.prepare', f.request());
        const review = await ownerRpc<PreapprovalReview>(socket, 'preapproval.review', { proposal_id: proposal.proposal_id });
        expect(review.coverage, JSON.stringify(review.uncovered)).toBe('complete');
        expect(review.members.map(member => member.family)).toEqual(['http', 'cli', 'http']);
        expect(existsSync(f.processFiles!.cli_log)).toBe(false);
        await ownerRpc(socket, 'preapproval.decide', { proposal_id: proposal.proposal_id, expected_revision: review.revision,
          review_digest: review.review_digest, challenge: review.challenge, decision: 'approve', request_id: randomUUID() });
        if (scenario === 'changed_script') writeFileSync(f.processFiles!.cli, readFileSync(f.processFiles!.cli, 'utf8') + '\n// changed');
        if (scenario === 'recreated_script') {
          const bytes = readFileSync(f.processFiles!.cli); rmSync(f.processFiles!.cli); writeFileSync(f.processFiles!.cli, bytes);
        }
        if (scenario === 'reach_revoked' || scenario === 'reach_regranted') f.cliReach.deny('user_self', 'review-cli', 'item.write');
        if (scenario === 'reach_regranted') f.cliReach.allow('user_self', 'review-cli', 'item.write', f.clock.now);
        if (scenario === 'uncertain') writeFileSync(f.processFiles!.cli_log + '.fail', 'provider fails after its write');
        const plan = await f.storage.repository.loadExecution(review.future_execution_ref);
        f.clock.now = plan.target.due_at!;
        const scheduler = createScheduler({ store: f.sources.schedules, executeDeps: f.execution, now: () => f.clock.now });
        await scheduler.tick(); await scheduler.tick();
        const status = await f.storage.repository.inspect(proposal.proposal_id);
        if (scenario === 'run' || scenario === 'uncertain') {
          expect(existsSync(f.processFiles!.cli_log), JSON.stringify(status)).toBe(true);
          expect(readFileSync(f.processFiles!.cli_log, 'utf8')).toBe('Reviewed CLI write\n');
          expect(status.execution_status).toBe(scenario === 'run' ? 'succeeded' : 'in_doubt');
          const receipt = status.members.find(member => member.op_id === 'test/cli.item.write')!;
          expect(receipt.commit_id).toBeTruthy(); expect(receipt.action_ref).toBeTruthy();
          expect(receipt.status).toBe(scenario === 'run' ? 'succeeded' : 'in_doubt');
          expect(f.received.map(call => call.url)).toEqual(scenario === 'run' ? ['/v1/items/a', '/v1/items/b'] : ['/v1/items/a']);
        } else {
          expect(existsSync(f.processFiles!.cli_log)).toBe(false); expect(f.received).toEqual([]);
          expect(status.execution_status).toBe('invalidated');
        }
        expect(await f.block.listOpenAsks()).toHaveLength(0);
      } finally { socket.terminate(); await server.close(); }
    });
  it.each(['send', 'send_websocket', 'send_stdio', 'stdio_changed_script', 'schema_before', 'schema_at_egress', 'account_at_egress', 'revoke_at_egress', 'uncertain'] as const)(
    'one protected owner decision covers actual HTTP and MCP dispatch: %s', async scenario => {
      const f = await fixture('ask', false, true, false, scenario === 'send_websocket' ? 'websocket'
        : scenario === 'send_stdio' || scenario === 'stdio_changed_script' ? 'stdio' : true);
      const successful = scenario === 'send' || scenario === 'send_websocket' || scenario === 'send_stdio';
      const request = f.request();
      const result = await handleExecute(f.execution, { recipe: { ...fixtureRecipe, recipe_id: 'request-mcp-group',
        metadata: { ...fixtureRecipe.metadata, description: 'Ask the owner to review the combined HTTP and MCP execution.' },
        steps: [{ id: 'review', ingredient: 'preapproval-request', input: { ...request } }] },
      execution_source: f.origin.source });
      expect(result.success, JSON.stringify(result)).toBe(true);
      const asks = await f.block.listOpenAsks(); expect(asks).toHaveLength(1);
      const proposal_id = asks[0]!.handler_payload.proposal_id as string;
      const server = await startServer(0, { clientTokens: f.clients, preapprovalDeps: f.composed!.handlers });
      const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, { headers: { Authorization: `Bearer ${f.token.token_id}.${f.token.bearer}` } });
      try {
        await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
        const review = await ownerRpc<PreapprovalReview>(socket, 'preapproval.review', { proposal_id });
        expect(review.members).toHaveLength(3);
        expect(review.coverage).toBe('complete');
        expect(f.mcpReceived).toHaveLength(0); expect(f.received).toHaveLength(0);
        await ownerRpc(socket, 'preapproval.decide', { proposal_id, expected_revision: review.revision,
          review_digest: review.review_digest, challenge: review.challenge, decision: 'approve', request_id: randomUUID() });
        const row = f.connections.get('mcp', 'workspace')!;
        const changeSchema = () => {
          f.connections.setHealth('mcp', 'workspace', JSON.stringify({ status: 'ok', tools: ['item.create'],
            mcp_tool_schemas: { 'item.create': { type: 'object', properties: { another: { type: 'string' } } } } }));
          f.connections.setHealth('mcp', 'workspace', row.health_json!); // Identical restoration cannot revive it.
        };
        if (scenario === 'schema_before') changeSchema();
        if (scenario === 'stdio_changed_script') {
          const old = readFileSync(f.processFiles!.mcp); rmSync(f.processFiles!.mcp); writeFileSync(f.processFiles!.mcp, old);
        }
        else f.execution.executorConfig.connectionMcp!.beforeRequest = async () => {
          if (scenario === 'schema_at_egress') changeSchema();
          if (scenario === 'account_at_egress') f.connections.upsert({ ...row, auth_ciphertext: 'a-different-account' });
          if (scenario === 'revoke_at_egress') {
            const current = await ownerRpc<PreapprovalInspection>(socket, 'preapproval.get', { proposal_id });
            await ownerRpc(socket, 'preapproval.revoke', { grant_id: current.grant!.grant_id,
              expected_revision: current.grant!.revision, request_id: randomUUID() });
          }
          if (successful) {
            f.connections.setHealth('mcp', 'workspace', JSON.stringify({ ...JSON.parse(row.health_json!), last_probed_at: f.clock.now }));
            expect(f.connections.persistRefreshedAuth!(row, 'refreshed-same-account', f.clock.now)).toBe(true);
          }
          if (scenario === 'uncertain') f.provider.dropResponse = true;
        };
        const plan = await f.storage.repository.loadExecution(review.future_execution_ref);
        f.clock.now = plan.target.due_at!;
        const scheduler = createScheduler({ store: f.sources.schedules, executeDeps: f.execution, now: () => f.clock.now });
        await scheduler.tick(); await scheduler.tick();
        const status = await f.storage.repository.inspect(proposal_id);
        const calls = f.mcpReceived.filter(call => call.method === 'tools/call');
        expect(calls).toHaveLength(successful || scenario === 'uncertain' ? 1 : 0);
        if (successful) {
          expect(calls[0]!.params).toMatchObject({ name: 'item.create', arguments: { title: 'Reviewed item' } });
          expect(status.execution_status).toBe('succeeded');
          expect(f.received.map(call => call.url)).toEqual(['/v1/items/a', '/v1/items/b']);
        } else {
          expect(status.execution_status).not.toBe('succeeded');
          expect(f.received.map(call => call.url)).toEqual(scenario === 'schema_before' || scenario === 'stdio_changed_script' ? [] : ['/v1/items/a']);
          if (scenario === 'uncertain') expect(status.execution_status).toBe('in_doubt');
          else if (scenario !== 'schema_before' && scenario !== 'stdio_changed_script') expect(status.members.find(member => member.op_id === 'test/mcp.item.write')?.status).toBe('failed');
        }
        expect(f.storage.repository.listPrompts(proposal_id)).toHaveLength(1);
        expect(await f.block.listOpenAsks()).toHaveLength(0);
      } finally { socket.terminate(); await server.close(); }
    });
  it.each(['owner', 'contract', 'changed'] as const)('saved draft uses the installed carrier, one review and independent ownership: %s', async actor => {
    const f = await fixture('ask', false, true, true); const mail = f.mail!;
    const carrier = JSON.parse(readFileSync('community/recipes/send-composed-mail.json', 'utf8')) as RecipeDefinition;
    f.sources.recipes.save(carrier, 'recued-core', 'inline');
    const file = await mail.fileCollection.ingest({ bytes: Buffer.from('frozen'), filename: 'frozen.txt', mime_type: 'text/plain', origin: 'mail_attachment', source_id: 'draft' });
    const content = { sender_mail_instance: 'work', to: ['client@example.test'], cc: ['copy@example.test'], bcc: ['archive@example.test'],
      subject: 'Saved report', body: '<p>The complete report.</p>', body_format: 'html', in_reply_to: '<prior@example.test>',
      references: ['<prior@example.test>'], reply_to: 'replies@example.test', attachments: [file.record_id] };
    const server = await startServer(0, { clientTokens: f.clients, preapprovalDeps: f.composed!.handlers });
    const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, { headers: { Authorization: `Bearer ${f.token.token_id}.${f.token.bearer}` } });
    try {
      await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
      let dispatch: ReturnType<typeof createMcpHttpDispatch> | undefined; let contractId: string | null = null;
      if (actor === 'contract') {
        const def = f.definitions.mint({ minted_by: 'owner', display_name: 'Draft assistant', door_types: ['mcp'],
          scope: { channels: ['mcp'], actors: ['contracted_user'], operation_ids: ['core.mail.draft.create', 'core.mail.draft.read',
            'core.preapproval.request', 'core.schedule.recipe', 'core.storage.data-file-read', 'core.mail.send'] } });
        contractId = def.contract_id;
        for (const op of ['core.mail.draft.create', 'core.mail.draft.read', 'core.preapproval.request', 'core.schedule.recipe', 'core.storage.data-file-read']) {
          f.grants.set(contractId, opGrantEntry(op), true, f.clock.now);
        }
        const issued = f.inbound.issueToken({ value: { label: 'Draft client', grants: { 'recued_ingredient_mail-draft-create': true,
          'recued_ingredient_mail-draft-read': true, 'recued_ingredient_preapproval-request': true,
          'recued-core/send-composed-mail': true }, concurrency_tier: 3, chat_mode: null, contract_id: contractId }, now: f.clock.now });
        dispatch = createMcpHttpDispatch({ ...f.execution, mcpTokenId: issued.record.token_id, boundContractId: contractId,
          boundContractActive: true, inboundTokenAuthorize: name => isMcpInboundTokenToolAuthorized(f.inbound.getTokenById(issued.record.token_id)!, name, f.clock.now) });
        const response = await dispatch({ jsonrpc: '2.0', id: 'save', method: 'tools/call', params: { name: 'recued_ingredient_mail-draft-create',
          arguments: { idempotency_key: 'save-draft', content } } });
        // Saving is an ordinary governed local write. A low-ceiling contract
        // still needs its normal approval before the later future-send review.
        const row = f.db.prepare('SELECT data FROM checkpoints').get() as { data: string } | undefined;
        expect(row, JSON.stringify(response)).toBeDefined(); const checkpoint = JSON.parse(row!.data) as Checkpoint;
        const resumer = createPreflightResumer({ getExecuteDeps: () => f.execution, auditLog: f.execution.auditLog!,
          gatedActionStore: f.execution.gatedActionStore });
        await resumer.resumeRun(checkpoint, { recipe_id: checkpoint.recipe_id, gated_step_id: checkpoint.gated_step_id });
        expect(f.db.prepare('SELECT count(*) AS count FROM mail_drafts WHERE deleted_at IS NULL').get(), JSON.stringify(response)).toEqual({ count: 1 });
      } else await ownerRpc<MailDraft>(socket, 'mail.drafts.create', { idempotency_key: 'save-draft', content });
      const listed = await ownerRpc<{ drafts: MailDraft[] }>(socket, 'mail.drafts.list'); expect(listed.drafts).toHaveLength(1);
      const draft = await ownerRpc<MailDraft>(socket, 'mail.drafts.get', { draft_id: listed.drafts[0]!.draft_id });
      expect(draft.origin_contract_id).toBe(contractId); expect(draft.content).toEqual(content);
      expect(mail.getBytes).not.toHaveBeenCalled(); expect(mail.sent).toEqual([]);
      createContractStore(f.db).put('owner_operation', ['data-file-read', 'data-file-read'], { approval: 'ask', op_hash: 'read-ask' });
      const request: PreparePreapproval = { ...f.request(), subject: { kind: 'mail_draft', draft_id: draft.draft_id, draft_revision: draft.revision } };
      const pending = dispatch ? await (async () => {
        const response = await dispatch!({ jsonrpc: '2.0', id: 'review', method: 'tools/call', params: { name: 'recued_ingredient_preapproval-request', arguments: request } });
        const asks = await f.block.listOpenAsks(); expect(asks, JSON.stringify(response)).toHaveLength(1);
        return f.storage.repository.inspect(asks[0]!.handler_payload.proposal_id as string);
      })() : await ownerRpc<import('@recued/contracts').PreapprovalResult>(socket, 'preapproval.prepare', request);
      expect(pending).toMatchObject({ coverage: 'complete', eligible_members: 2 });
      expect(mail.getBytes).not.toHaveBeenCalled();
      const decision = await f.decision(pending.proposal_id);
      if (actor === 'changed') {
        await ownerRpc(socket, 'mail.drafts.update', { draft_id: draft.draft_id, expected_revision: draft.revision, content: { ...content, body: 'Changed' } });
        await expect(ownerRpc(socket, 'preapproval.decide', decision)).rejects.toThrow('preapproval_');
        expect((await f.storage.repository.inspect(pending.proposal_id)).execution_status).toBe('invalidated');
        expect(mail.sent).toEqual([]);
      } else {
        await ownerRpc(socket, 'preapproval.decide', decision);
        await ownerRpc(socket, 'mail.drafts.delete', { draft_id: draft.draft_id, expected_revision: draft.revision });
        mail.fileCollection.delete(file.record_id);
        f.clock.now = request.activation.kind === 'one_shot' ? request.activation.run_at : 0;
        const scheduler = createScheduler({ store: f.sources.schedules, executeDeps: f.execution, now: () => f.clock.now });
        await scheduler.tick(); await scheduler.tick();
        const status = await f.storage.repository.inspect(pending.proposal_id);
        expect(status.execution_status, JSON.stringify(status)).toBe('succeeded');
        expect(mail.sent).toHaveLength(1);
        expect(mail.sent[0]).toMatchObject({ to: content.to, cc: content.cc, bcc: content.bcc, body_html: content.body,
          reply_to: content.reply_to, in_reply_to: content.in_reply_to, references: content.references,
          attachments: [{ filename: 'frozen.txt', bytes_b64: Buffer.from('frozen').toString('base64') }] });
        expect(mail.getBytes).toHaveBeenCalledTimes(1); expect(await f.block.listOpenAsks()).toHaveLength(0);
      }
    } finally { socket.terminate(); await server.close(); }
  });
  it.each(['send', 'uncertain', 'missing_bytes', 'deny_read', 'contract_send', 'contract_send_last_use', 'contract_deny_read'] as const)(
    'one group covers actual mail, required attachment read and HTTP after independent source deletion: %s', async action => {
      const f = await fixture('ask', false, true, true); const mail = f.mail!;
      const fault = action === 'contract_send_last_use' ? 'send' : action.replace('contract_', '');
      const bytes = Buffer.from('Reviewed attachment bytes\n');
      const file = await mail.fileCollection.ingest({ bytes, filename: 'report.txt', mime_type: 'text/plain', origin: 'mail_attachment', source_id: 'file-1' });
      createContractStore(f.db).put('owner_operation', ['data-file-read', 'data-file-read'], { approval: 'ask', op_hash: 'read-ask' });
      const stored = f.sources.recipes.get(fixtureRecipe.recipe_id)!;
      f.sources.recipes.save({ ...stored, steps: [
        { id: 'send', ingredient: 'mail-send', input: { sender_mail_instance: 'work', to: ['client@example.test'], cc: ['copy@example.test'],
          bcc: ['archive@example.test'], subject: 'Reviewed report', body: 'The complete reviewed message.', body_format: 'text',
          in_reply_to: '<prior@example.test>', references: ['<thread@example.test>', '<prior@example.test>'], attachments: [file.record_id] } },
        stored.steps[0]!,
      ] }, 'core', 'inline');
      let contractId: string | null = null;
      const request = f.request();
      const proposal = action.startsWith('contract_') ? await (async () => {
        const entry = 'recued_ingredient_preapproval-request';
        const target = `core/${fixtureRecipe.recipe_id}`;
        const def = f.definitions.mint({ minted_by: 'owner', display_name: 'Mail assistant', door_types: ['mcp'],
          ...(action === 'contract_send_last_use' ? { max_uses: 4 } : {}),
          scope: { channels: ['mcp'], actors: ['contracted_user'], operation_ids: ['core.preapproval.request', 'core.schedule.recipe',
            'core.mail.send', 'core.storage.data-file-read', 'test/catalog.item.write'] } });
        contractId = def.contract_id;
        for (const op of ['core.preapproval.request', 'core.schedule.recipe', 'core.storage.data-file-read']) {
          f.grants.set(def.contract_id, opGrantEntry(op), true, f.clock.now);
        }
        const issued = f.inbound.issueToken({ value: { label: 'Mail MCP client', grants: { [entry]: true, [target]: true },
          concurrency_tier: 3, chat_mode: null, contract_id: def.contract_id }, now: f.clock.now });
        const dispatch = createMcpHttpDispatch({ ...f.execution, mcpTokenId: issued.record.token_id, boundContractId: def.contract_id,
          boundContractActive: true, inboundTokenAuthorize: name => isMcpInboundTokenToolAuthorized(f.inbound.getTokenById(issued.record.token_id)!, name, f.clock.now) });
        const response = await dispatch({ jsonrpc: '2.0', id: 'review-mail', method: 'tools/call', params: { name: entry, arguments: request } });
        const asks = await f.block.listOpenAsks(); expect(asks, JSON.stringify(response)).toHaveLength(1);
        return f.storage.repository.inspect(asks[0]!.handler_payload.proposal_id as string);
      })() : await f.service.prepare(request, f.origin);
      expect(proposal).toMatchObject({ coverage: 'complete', eligible_members: 3, uncovered_calls: 0 });
      expect(mail.getBytes).not.toHaveBeenCalled(); expect(mail.sent).toEqual([]);
      const review = await f.storage.repository.review(proposal.proposal_id, f.responder);
      expect(review.members.map(member => member.op_id)).toEqual(['core.mail.send', 'core.storage.data-file-read', 'test/catalog.item.write']);
      expect(review.members[0]!.required_child_ids).toEqual([review.members[1]!.member_id]);
      expect(review.members[1]!.detail).toContain('text/plain');
      await f.storage.repository.decide({ proposal_id: review.proposal_id, expected_revision: review.revision, review_digest: review.review_digest,
        challenge: review.challenge, decision: 'approve', request_id: randomUUID() }, f.responder);
      expect(mail.fileCollection.delete(file.record_id)).toBe(true);
      expect(listCollectionReferencedBlobHashes(f.db).has(file.blob_hash!)).toBe(true);
      expect((await f.storage.repository.inspect(proposal.proposal_id)).execution_status).toBe('active');
      if (fault === 'uncertain') mail.behavior.uncertain = true;
      if (fault === 'missing_bytes') await mail.blobs.delete(file.blob_hash!);
      if (fault === 'deny_read') {
        if (contractId) f.grants.set(contractId, opGrantEntry('core.storage.data-file-read'), false, f.clock.now);
        else createContractStore(f.db).put('owner_operation', ['data-file-read', 'data-file-read'], { approval: 'always', op_hash: 'read-always' });
      }
      const plan = await f.storage.repository.loadExecution(proposal.future_execution_ref); f.clock.now = plan.target.due_at!;
      const scheduler = createScheduler({ store: f.sources.schedules, executeDeps: f.execution, now: () => f.clock.now });
      await scheduler.tick(); await scheduler.tick();
      const inspection = await f.storage.repository.inspect(proposal.proposal_id);
      expect(mail.sent, JSON.stringify({ state: inspection.execution_status, members: inspection.members })).toHaveLength(fault === 'send' || fault === 'uncertain' ? 1 : 0);
      expect(f.received).toHaveLength(fault === 'send' ? 1 : 0);
      expect(mail.getBytes).toHaveBeenCalledTimes(fault === 'deny_read' ? 0 : 1);
      expect(await f.block.listOpenAsks()).toHaveLength(0);
      if (fault === 'send' || fault === 'uncertain') {
        expect(mail.sent[0]).toMatchObject({ to: ['client@example.test'], cc: ['copy@example.test'], bcc: ['archive@example.test'],
          body_text: 'The complete reviewed message.', subject: 'Reviewed report', in_reply_to: '<prior@example.test>',
          references: ['<thread@example.test>', '<prior@example.test>'], attachments: [{ filename: 'report.txt', mime_type: 'text/plain',
            bytes_b64: bytes.toString('base64'), size_bytes: bytes.length }] });
        expect(inspection.members[1]!.status).toBe('succeeded');
      }
      if (contractId && fault === 'send') {
        if (action === 'contract_send_last_use') expect(f.definitions.get(contractId)?.uses_remaining).toBe(0);
        const ids = new Set(inspection.members.map(member => member.commit_id));
        const commits = (f.db.prepare('SELECT data FROM commits').all() as Array<{ data: string }>).map(row => JSON.parse(row.data) as Commit)
          .filter(commit => ids.has(commit.commit_id));
        expect(commits).toHaveLength(3);
        expect(commits.every(commit => commit.contract_snapshot?.contract_id === contractId && commit.source.actor === 'contracted_user')).toBe(true);
      }
      expect(inspection.execution_status).toBe(fault === 'send' ? 'succeeded' : fault === 'uncertain' ? 'in_doubt'
        : fault === 'deny_read' ? 'invalidated' : 'failed');
      if (fault === 'send' || fault === 'uncertain') {
        f.clock.now += GATED_ACTION_TERMINAL_RETENTION_MS + 1;
        await f.composed!.outbox.drain();
        expect(listCollectionReferencedBlobHashes(f.db).has(file.blob_hash!)).toBe(fault === 'uncertain');
        const retained = await f.storage.repository.inspect(proposal.proposal_id);
        expect(!!retained.retired_review).toBe(fault === 'send');
      }
    });
  it('a table-level file deletion and identical re-ingest cannot revive a pending file review', async () => {
    const f = await fixture('ask', false, true, true); const mail = f.mail!;
    const input = { bytes: Buffer.from('same bytes'), filename: 'same.txt', mime_type: 'text/plain',
      origin: 'mail_attachment' as const, source_id: 'same-source' };
    const file = await mail.fileCollection.ingest(input);
    f.sources.recipes.save({ ...f.sources.recipes.get(fixtureRecipe.recipe_id)!, steps: [{ id: 'read', ingredient: 'data-file-read',
      input: { record_id: file.record_id, metadata_only: true } }] }, 'core', 'inline');
    const pending = await f.service.prepare(f.request(), f.origin);
    const decision = await f.decision(pending.proposal_id);
    // The lower-level path used by retention/eviction bypasses the wrapper's
    // delete callback. The table trigger must still tombstone the incarnation.
    createCollectionTable({ db: f.db, platform: 'file', slug: 'received' }).delete(file.record_id);
    expect((await mail.fileCollection.ingest(input)).record_id).toBe(file.record_id);
    await expect(f.storage.repository.decide(decision, f.responder)).rejects.toMatchObject({ code: 'preapproval_stale' });
    expect(mail.getBytes).not.toHaveBeenCalled(); expect(mail.sent).toEqual([]);
    expect(f.db.prepare('SELECT count(*) AS count FROM collection_preapproval_blobs').get()).toEqual({ count: 0 });
  });
  it.each(['fire', 'last_use', 'budget_short', 'revoke_entry', 'revoke_target', 'regrant_entry', 'rebind_then_restore', 'revoke_contract',
    'nested', 'nested_last_use', 'nested_revoke_child'] as const)(
    'an MCP contract requests one review under its exact entry and target recipe grants: %s', async action => {
      const f = await fixture('ask', false, true);
      const nestedCase = action.startsWith('nested');
      if (nestedCase) {
        const root = f.sources.recipes.get(fixtureRecipe.recipe_id)!;
        f.sources.recipes.save({ ...root, recipe_id: 'reviewed-child' }, 'core', 'inline');
        f.execution.executorConfig.manifests.register({ ...mcpCatalog, slug: 'local-review', name: 'Reviewed child',
          surfaces: { api: { ...mcpCatalog.surfaces!.api!, executes: {
            'item.write': { kind: 'mcp', tool: 'core/reviewed-child' },
          } } } });
        root.steps = [{ id: 'nested', ingredient: 'local-review', input: { operation: 'item.write', args: {} } }, root.steps[1]!];
        f.sources.recipes.save(root, 'core', 'inline');
      }
      const request = f.request();
      if (request.subject.kind !== 'recipe') throw new Error('Expected recipe request');
      const entry = 'recued_ingredient_preapproval-request';
      const target = `core/${request.subject.recipe_id}`;
      const def = f.definitions.mint({ minted_by: 'owner', display_name: 'Scheduling assistant',
        ...(action === 'last_use' ? { max_uses: 2 } : action === 'nested_last_use' ? { max_uses: 5 } : action === 'budget_short' ? { max_uses: 1 } : {}),
        door_types: ['mcp'], scope: { channels: ['mcp'], actors: ['contracted_user'], connection_names: nestedCase ? [] : ['crm'],
          operation_ids: ['core.preapproval.request', 'core.schedule.recipe', 'test/catalog.item.write', 'test/mcp.item.write'] } });
      for (const op of ['core.preapproval.request', 'core.schedule.recipe']) {
        f.grants.set(def.contract_id, opGrantEntry(op), true, f.clock.now);
      }
      const issued = f.inbound.issueToken({ value: { label: 'Scheduler client', grants: { [entry]: true, [target]: true,
        ...(nestedCase ? { 'core/reviewed-child': true } : {}) },
        concurrency_tier: 3, chat_mode: null, contract_id: def.contract_id }, now: f.clock.now });
      const dispatch = createMcpHttpDispatch({ ...f.execution, mcpTokenId: issued.record.token_id,
        boundContractId: def.contract_id, boundContractActive: true,
        inboundTokenAuthorize: name => isMcpInboundTokenToolAuthorized(f.inbound.getTokenById(issued.record.token_id)!, name, f.clock.now) });
      const response = await dispatch({ jsonrpc: '2.0', id: 'review', method: 'tools/call',
        params: { name: entry, arguments: request } }) as { result: { isError?: boolean; content: Array<{ text: string }> } };
      expect(response.result.isError, JSON.stringify(response)).not.toBe(true);
      const asks = await f.block.listOpenAsks(); expect(asks, JSON.stringify(response)).toHaveLength(1);
      const proposal_id = asks[0]!.handler_payload.proposal_id as string;
      const review = await f.storage.repository.review(proposal_id, f.responder);
      expect(review.coverage).toBe('complete');
      const plan = await f.storage.repository.loadExecution(review.future_execution_ref);
      expect(plan.members.every(member => member.pre_lift_approval === 'ask')).toBe(true);
      if (action === 'fire') {
        const root = plan.recipe_snapshots[0]!;
        const child = { ...f.sources.recipes.get(root.recipe_id)!, recipe_id: 'nested-child' };
        f.sources.recipes.save(child, 'core', 'inline');
        const childPath = [...preapprovalChildPath(plan.members[0]!.invocation_path, 'recipe', 0),
          { kind: 'recipe' as const, recipe_id: child.recipe_id, publisher_id: 'core', definition_hash: root.definition_hash }];
        const description = () => f.service.preparation(plan.request, plan.target, plan).describe({
          manifest: catalog, slug: catalog.slug, input: { operation: 'item.write', args: plan.members[0]!.input }, output: plan.members[0]!.output,
          catalog: true, connection_name: 'crm', origin: plan.origin,
          recipe: { ...root, recipe_id: child.recipe_id, definition: child, invocation_path: childPath },
          path: [...childPath, { kind: 'step', phase: 'sequential', step_id: 'a' }],
        });
        const denied = description(); expect(denied.kind, JSON.stringify(denied)).toBe('resolved');
        if (denied.kind === 'resolved') expect(denied.call.review.ineligible_reason).toContain('is not available for this contract.');
        // Authorizing the child itself is distinct from granting its caller.
        f.inbound.updateTokenGrants({ token_id: issued.record.token_id,
          grants: { [entry]: true, [target]: true, 'core/nested-child': true }, now: f.clock.now });
        const allowed = description(); expect(allowed.kind).toBe('resolved');
        if (allowed.kind === 'resolved') expect(allowed.call.review.ineligible_reason).toBeNull();
      }
      expect(plan.origin).toMatchObject({ mode: 'contract', contract_id: def.contract_id,
        entry_tool_grants: [entry], target_recipe_grant_key: target, display_name: 'Scheduling assistant' });
      expect(f.received).toHaveLength(0);
      await f.storage.repository.decide(await f.decision(proposal_id), f.responder);
      if (action === 'nested_revoke_child') f.inbound.updateTokenGrants({ token_id: issued.record.token_id,
        grants: { [entry]: true, [target]: true, 'core/reviewed-child': false }, now: f.clock.now });
      if (action === 'revoke_contract') f.definitions.revoke(def.contract_id, 'Owner stopped scheduling');
      else if (action.startsWith('revoke_')) f.inbound.updateTokenGrants({ token_id: issued.record.token_id,
        grants: { [entry]: action !== 'revoke_entry', [target]: action !== 'revoke_target' }, now: f.clock.now });
      else if (action === 'regrant_entry') {
        f.inbound.updateTokenGrants({ token_id: issued.record.token_id, grants: { [entry]: false, [target]: true }, now: f.clock.now });
        f.inbound.updateTokenGrants({ token_id: issued.record.token_id, grants: { [entry]: true, [target]: true }, now: f.clock.now });
      } else if (action === 'rebind_then_restore') {
        f.inbound.updateTokenContract({ token_id: issued.record.token_id, contract_id: null, now: f.clock.now });
        f.inbound.updateTokenContract({ token_id: issued.record.token_id, contract_id: def.contract_id, now: f.clock.now });
      }
      f.clock.now = plan.target.due_at!;
      const scheduler = createScheduler({ store: f.sources.schedules, executeDeps: f.execution, now: () => f.clock.now });
      await scheduler.tick(); await scheduler.tick();
      const nestedSuccess = action === 'nested' || action === 'nested_last_use';
      expect(f.received, JSON.stringify({ members: (await f.storage.repository.inspect(proposal_id)).members,
        audit: f.db.prepare('SELECT data FROM audit_log').all() })).toHaveLength(nestedSuccess ? 3 : action === 'fire' || action === 'last_use' ? 2 : action === 'budget_short' ? 1 : 0);
      if (action === 'last_use' || action === 'budget_short' || action === 'nested_last_use') expect(f.definitions.get(def.contract_id)?.uses_remaining).toBe(0);
      if (action === 'fire' || action === 'last_use' || nestedSuccess) {
        expect(await f.storage.repository.inspect(proposal_id)).toMatchObject({ execution_status: 'succeeded' });
        const commits = (f.db.prepare('SELECT data FROM commits').all() as Array<{ data: string }>)
          .map(row => JSON.parse(row.data) as Commit).filter(row => row.ingredient === catalog.slug);
        expect(commits).toHaveLength(nestedSuccess ? 3 : 2);
        expect(commits.every(row => row.source.actor === 'contracted_user'
          && row.contract_snapshot?.contract_id === def.contract_id)).toBe(true);
        if (nestedSuccess) {
          const link = f.db.prepare('SELECT run_id,root_run_id FROM preapproval_run_links').get() as { run_id: string; root_run_id: string };
          expect(commits.filter(commit => commit.request_id === link.run_id)).toHaveLength(2);
          expect(commits.filter(commit => commit.request_id === link.root_run_id)).toHaveLength(1);
        }
      } else expect((await f.storage.repository.inspect(proposal_id)).execution_status).toBe(action === 'budget_short' ? 'partial' : 'invalidated');
    });
  it('retains the original MCP entry and requesting recipe through a real approval hold before requesting future review', async () => {
    const f = await fixture('ask', true, true); const request = f.request();
    if (request.subject.kind !== 'recipe') throw new Error('Expected recipe request');
    const requester: RecipeDefinition = { ...fixtureRecipe, recipe_id: 'request-after-review',
      metadata: { ...fixtureRecipe.metadata, description: 'Review the current action, then ask about a future execution.' },
      variables: { crm_connection: { type: 'text', label: 'CRM connection', default: 'crm' } },
      steps: [{ id: 'confirm', ingredient: catalog.slug, connection: '{{config.crm_connection}}',
        input: { operation: 'item.confirm', args: { id: 'current' } } },
      { id: 'future', ingredient: 'preapproval-request', input: { ...request } }] };
    f.sources.recipes.save(requester, 'core', 'inline');
    const def = f.definitions.mint({ minted_by: 'owner', display_name: 'Scheduling assistant', door_types: ['mcp'],
      scope: { channels: ['mcp'], actors: ['contracted_user'], connection_names: ['crm'] } });
    for (const op of ['core.preapproval.request', 'core.schedule.recipe']) f.grants.set(def.contract_id, opGrantEntry(op), true, f.clock.now);
    const requestingGrant = `core/${requester.recipe_id}`;
    const issued = f.inbound.issueToken({ value: { label: 'Scheduling client',
      grants: { recued_runRecipe: true, [requestingGrant]: true, [`core/${request.subject.recipe_id}`]: true },
      concurrency_tier: 3, chat_mode: null, contract_id: def.contract_id }, now: f.clock.now });
    const dispatch = createMcpHttpDispatch({ ...f.execution, mcpTokenId: issued.record.token_id,
      boundContractId: def.contract_id, boundContractActive: true,
      internalRegistry: createInternalToolRegistry({ tier2Source: { listRecipes: () => [{ recipe_id: requester.recipe_id,
        recipe: requester, publisher_id: 'core', user_authored: true }] },
        manifestLookup: slug => f.execution.executorConfig.manifests.get(slug)?.kind ?? null }),
      inboundTokenAuthorize: name => isMcpInboundTokenToolAuthorized(f.inbound.getTokenById(issued.record.token_id)!, name, f.clock.now) });
    const response = await dispatch({ jsonrpc: '2.0', id: 'held-request', method: 'tools/call',
      params: { name: 'recued_runRecipe', arguments: { recipe_id: requester.recipe_id } } });
    expect(f.received).toHaveLength(0);
    expect(await f.block.listOpenAsks()).toHaveLength(0);
    const row = f.db.prepare('SELECT data FROM checkpoints').get() as { data: string } | undefined;
    expect(row, JSON.stringify(response)).toBeDefined();
    const checkpoint = JSON.parse(row!.data) as Checkpoint;
    expect(checkpoint.entry_tool_name).toBe('recued_runRecipe');
    const resumer = createPreflightResumer({ getExecuteDeps: () => f.execution,
      auditLog: f.execution.auditLog!, gatedActionStore: f.execution.gatedActionStore });
    await resumer.resumeRun(checkpoint, { recipe_id: requester.recipe_id, gated_step_id: 'confirm' });
    expect(f.received.map(call => call.url)).toEqual(['/v1/items/current']);
    const asks = await f.block.listOpenAsks(); expect(asks).toHaveLength(1);
    const review = await f.storage.repository.review(asks[0]!.handler_payload.proposal_id as string, f.responder);
    const plan = await f.storage.repository.loadExecution(review.future_execution_ref);
    expect(plan.origin).toMatchObject({ entry_tool_grants: ['recued_runRecipe'], recipe_grant_key: requestingGrant,
      target_recipe_grant_key: `core/${request.subject.recipe_id}`, contract_id: def.contract_id });
  });
  it('converges simultaneous retries without creating orphan one-shot identities and preserves the stored proposal after later edits', async () => {
    const f = await fixture(); const request = f.request();
    const [first, retry] = await Promise.all([f.service.prepare(request, f.origin), f.service.prepare(request, f.origin)]);
    expect(retry).toEqual(first);
    expect(f.db.prepare("SELECT COUNT(*) AS count FROM preapproval_resource_identity WHERE kind='one_shot'").get()).toEqual({ count: 0 });
    expect(f.db.prepare('SELECT COUNT(*) AS count FROM preapproval_proposals').get()).toEqual({ count: 1 });
    await f.storage.repository.decide(await f.decision(first.proposal_id), f.responder);
    expect(f.db.prepare("SELECT COUNT(*) AS count FROM preapproval_resource_identity WHERE kind='one_shot'").get()).toEqual({ count: 1 });
    if (request.subject.kind !== 'recipe') throw new Error('Expected recipe request');
    const recipe = f.sources.recipes.get(request.subject.recipe_id)!;
    f.sources.recipes.save({ ...recipe, version: recipe.version + 1 }, 'core', 'inline');
    // Identity is the property — the same proposal, no second one-shot identity
    // (the count below). The replay reports what creation reported and never the
    // decision; the real terminal state is `inspect`'s to give, on the next line.
    expect(await f.service.prepare(request, f.origin))
      .toMatchObject({ proposal_id: first.proposal_id, status: 'awaiting_owner' });
    expect(await f.storage.repository.inspect(first.proposal_id)).toMatchObject({ execution_status: 'invalidated' });
    await expect(f.service.prepare({ ...request, dispatch_deadline: request.dispatch_deadline + 1 }, f.origin))
      .rejects.toMatchObject({ code: 'preapproval_idempotency_conflict' });
    expect(f.db.prepare("SELECT COUNT(*) AS count FROM preapproval_resource_identity WHERE kind='one_shot'").get()).toEqual({ count: 1 });
  });
  it('refuses an approval rule on the request op without asking for permission to ask', async () => {
    const f = await fixture('ask', false, true);
    createContractStore(f.db).put('owner_operation', ['preapproval-request', 'preapproval-request'],
      { approval: 'always', op_hash: 'review-request-policy' });
    const requestingRecipe: RecipeDefinition = { ...fixtureRecipe, recipe_id: 'ask-for-future',
      metadata: { ...fixtureRecipe.metadata, description: 'Request owner review.' },
      steps: [{ id: 'review', ingredient: 'preapproval-request', input: { ...f.request() } }] };
    const result = await handleExecute(f.execution, { recipe: requestingRecipe, execution_source: f.origin.source });
    expect(result.success).toBe(false);
    expect(result.awaiting_approval).toBeUndefined();
    expect(result.errors).toEqual([expect.objectContaining({ code: 'preapproval_request_policy_conflict' })]);
    expect(await f.block.listOpenAsks()).toHaveLength(0);
    expect(f.db.prepare('SELECT COUNT(*) AS count FROM preapproval_proposals').get()).toEqual({ count: 0 });
  });
  it('routes a kernel request into one protected owner ask, accepts the real webclient decision, then schedules the reviewed HTTP group', async () => {
    const f = await fixture('ask', false, true);
    const request = f.request();
    const requestingRecipe: RecipeDefinition = { ...fixtureRecipe, recipe_id: 'ask-for-future',
      metadata: { ...fixtureRecipe.metadata, description: 'Ask the owner to review the future execution.' },
      steps: [{ id: 'review', ingredient: 'preapproval-request', input: { ...request } }] };
    const source = { channel: 'chat' as const, actor: 'user_self' as const, user_id: 'realm', chat_session_id: 'chat-1' };
    for (let attempt = 0; attempt < 2; attempt++) {
      const prepared = await handleExecute(f.execution, { recipe: requestingRecipe, execution_source: source });
      expect(prepared.success, JSON.stringify(prepared)).toBe(true);
    }
    const asks = await f.block.listOpenAsks();
    expect(asks).toHaveLength(1);
    expect(f.received).toHaveLength(0);
    expect(f.sources.schedules.list()).toEqual([]);
    const proposal_id = asks[0]!.handler_payload.proposal_id as string;
    expect(proposal_id).toMatch(/^pap_/);
    const server = await startServer(0, { clientTokens: f.clients, preapprovalDeps: f.composed!.handlers });
    const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, { headers: {
      Authorization: `Bearer ${f.token.token_id}.${f.token.bearer}`,
    } });
    try {
      await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
      const review = await ownerRpc<PreapprovalReview>(socket, 'preapproval.review', { proposal_id });
      expect(review.members).toHaveLength(2);
      await ownerRpc(socket, 'preapproval.decide', { proposal_id, expected_revision: review.revision,
        review_digest: review.review_digest, challenge: review.challenge, decision: 'approve', request_id: randomUUID() });
      await f.composed!.outbox.drain();
      expect(await f.block.listOpenAsks()).toHaveLength(0);
      const plan = await f.storage.repository.loadExecution(review.future_execution_ref);
      expect(JSON.stringify(plan)).not.toContain(f.token.bearer);
      expect(plan.origin.source).toEqual(source);
      f.clock.now = plan.target.due_at!;
      const scheduler = createScheduler({ store: f.sources.schedules, executeDeps: f.execution, now: () => f.clock.now });
      expect(await scheduler.tick()).toEqual([plan.target.key]);
      expect(f.received.map(call => call.url)).toEqual(['/v1/items/a', '/v1/items/b']);
      expect(await f.storage.repository.inspect(proposal_id)).toMatchObject({ execution_status: 'succeeded' });
      expect(f.storage.repository.listPrompts(proposal_id)).toHaveLength(1);
    } finally { socket.terminate(); await server.close(); }
  });
  it('fires a parked one-shot through two competing actual schedulers once, retaining the original source', async () => {
    const f = await fixture(); const result = await f.service.prepare(f.request(), f.origin);
    await f.storage.repository.decide(await f.decision(result.proposal_id), f.responder);
    const plan = await f.storage.repository.loadExecution(result.future_execution_ref);
    const schedulers = [1, 2].map(() => createScheduler({ store: f.sources.schedules, executeDeps: f.execution, now: () => f.clock.now }));
    expect(f.sources.schedules.get(plan.target.key)?.enabled).toBe(false);
    await schedulers[0]!.tick(); expect(f.received).toHaveLength(0);
    f.clock.now = plan.target.due_at!;
    const fired = await Promise.all(schedulers.map(scheduler => scheduler.tick()));
    expect(fired.flat()).toEqual([plan.target.key]);
    expect(f.received.map(call => call.url)).toEqual(['/v1/items/a', '/v1/items/b']);
    const inspection = await f.storage.repository.inspect(result.proposal_id);
    expect(inspection).toMatchObject({ execution_status: 'succeeded' });
    expect(inspection.reviewed?.members).toHaveLength(2);
    expect(inspection.reviewed).not.toHaveProperty('challenge');
    expect(inspection.reviewed).not.toHaveProperty('challenge_expires_at');
    expect((await f.storage.repository.list('', 25)).proposals[0]).not.toHaveProperty('reviewed');
    expect(f.sources.schedules.get(plan.target.key)).toMatchObject({ enabled: false, next_run_at: null,
      last_run_at: plan.target.due_at, last_status: 'success' });
    const commits = (f.db.prepare('SELECT data FROM commits').all() as Array<{ data: string }>)
      .map(row => JSON.parse(row.data) as Commit);
    expect(commits).toHaveLength(2);
    expect(commits.every(commit => JSON.stringify(commit.source) === JSON.stringify(f.origin.source))).toBe(true);
    await schedulers[0]!.tick(); expect(f.received).toHaveLength(2);
  });
  it('⛔ a draining server claims no reviewed one-shot: it stays due, and the next boot runs it once', async () => {
    // A claim is durable: one spent on a run the restart refuses is finished
    // `failed` and retired, and the owner's approval with it.
    const f = await fixture(); const result = await f.service.prepare(f.request(), f.origin);
    await f.storage.repository.decide(await f.decision(result.proposal_id), f.responder);
    const plan = await f.storage.repository.loadExecution(result.future_execution_ref);
    f.clock.now = plan.target.due_at!;
    let draining = true;
    f.execution.isDraining = () => draining;
    expect(await f.execution.preapprovalDriver!.tickSchedules(f.clock.now)).toEqual([]);
    expect(f.received).toHaveLength(0);
    expect((await f.storage.repository.inspect(result.proposal_id)).execution_status).not.toBe('failed');

    // The restart is over.
    draining = false;
    const scheduler = createScheduler({ store: f.sources.schedules, executeDeps: f.execution, now: () => f.clock.now });
    expect(await scheduler.tick()).toEqual([plan.target.key]);
    expect(f.received.map(call => call.url)).toEqual(['/v1/items/a', '/v1/items/b']);
    expect(await f.storage.repository.inspect(result.proposal_id)).toMatchObject({ execution_status: 'succeeded' });
  });
  it('⛔ claims no reviewed one-shot when the drain begins after the sweep started', async () => {
    // A sweep resumes parents and recovers triggers, whole recipe runs, before
    // it reaches the schedules: a drain can begin in between. Asked only at
    // the sweep's start, the claim was taken and the refused run failed it.
    const f = await fixture(); const result = await f.service.prepare(f.request(), f.origin);
    await f.storage.repository.decide(await f.decision(result.proposal_id), f.responder);
    const plan = await f.storage.repository.loadExecution(result.future_execution_ref);
    f.clock.now = plan.target.due_at!;
    let asked = 0;
    let restarting = true;
    // Not draining when the sweep starts; draining from the next check on.
    f.execution.isDraining = () => restarting && ++asked > 1;
    expect(await f.execution.preapprovalDriver!.tickSchedules(f.clock.now)).toEqual([]);
    expect(f.received).toHaveLength(0);
    expect((await f.storage.repository.inspect(result.proposal_id)).execution_status).not.toBe('failed');

    restarting = false;
    const scheduler = createScheduler({ store: f.sources.schedules, executeDeps: f.execution, now: () => f.clock.now });
    expect(await scheduler.tick()).toEqual([plan.target.key]);
    expect(await f.storage.repository.inspect(result.proposal_id)).toMatchObject({ execution_status: 'succeeded' });
  });
  // D-261 amendment 2026-10-26 (owner: "auto re-arm if nothing was sent").
  // Until then a claim the restart refused, or a run it stopped before any
  // reviewed call, was finished failed: the approval was used up for nothing.
  it('⛔ hands back a reviewed one-shot the restart refused after its claim, and the next boot runs it once', async () => {
    const f = await fixture(); const result = await f.service.prepare(f.request(), f.origin);
    await f.storage.repository.decide(await f.decision(result.proposal_id), f.responder);
    const plan = await f.storage.repository.loadExecution(result.future_execution_ref);
    f.clock.now = plan.target.due_at!;
    const state = (): string => (f.db.prepare('SELECT state FROM preapproval_executions WHERE future_ref=?')
      .get(result.future_execution_ref) as { state: string }).state;
    let restarting = true;
    // The drain begins in the instant after the claim, so the run's own entry
    // check is the one that refuses it.
    f.execution.isDraining = () => restarting && state() === 'running';
    expect(await f.execution.preapprovalDriver!.tickSchedules(f.clock.now)).toEqual([]);
    expect(f.received).toHaveLength(0);
    expect(state()).toBe('active');

    restarting = false;
    const scheduler = createScheduler({ store: f.sources.schedules, executeDeps: f.execution, now: () => f.clock.now });
    expect(await scheduler.tick()).toEqual([plan.target.key]);
    expect(f.received.map(call => call.url)).toEqual(['/v1/items/a', '/v1/items/b']);
    expect(await f.storage.repository.inspect(result.proposal_id)).toMatchObject({ execution_status: 'succeeded' });
    // One occurrence, selected once: the second claim reused the first's.
    expect(f.db.prepare(`SELECT COUNT(*) AS n FROM preapproval_occurrences WHERE future_ref=? AND occurrence_key=?`)
      .get(result.future_execution_ref, `due:${plan.target.due_at}`)).toEqual({ n: 1 });
  });
  it.each([
    { stopping: true, expected: 'active' },
    { stopping: false, expected: 'failed' },
  ] as const)('⛔ a reviewed run killed before it sent anything is handed back only by a restart (stopping=$stopping)', async ({ stopping, expected }) => {
    const f = await fixture(); const result = await f.service.prepare(f.request(), f.origin);
    await f.storage.repository.decide(await f.decision(result.proposal_id), f.responder);
    const plan = await f.storage.repository.loadExecution(result.future_execution_ref);
    f.clock.now = plan.target.due_at!;
    const runtime = createPreapprovalExecutionRuntime({ storage: f.storage, service: f.service, isStopping: () => stopping });
    const claimed = await runtime.claim({ future_execution_ref: result.future_execution_ref,
      occurrence_key: `due:${f.clock.now}`, occurrence_sequence: plan.target.qualifying_sequence + 1 });
    // The engine's answer for a run the drain killed (`killAll`) before its
    // first reviewed call; an owner's kill reads the same.
    const killed = await runtime.execute(claimed.handle, async () => ({
      recipe_id: plan.recipe.recipe_id, recipe_hash: 'killed', success: false,
      output: { render: [], sidebar: [] }, steps: [], duration_ms: 1, validation_issues: [],
      errors: [{ code: 'run_killed', message: 'The run was stopped.' }], run_terminated: 'killed' as const,
    }), async () => { throw new Error('no parent'); });
    expect(killed.run_terminated).toBe('killed');
    expect(f.received).toHaveLength(0);
    expect((f.db.prepare('SELECT state FROM preapproval_executions WHERE future_ref=?')
      .get(result.future_execution_ref) as { state: string }).state).toBe(expected);
    if (!stopping) return;
    // After the restart the same occurrence runs once.
    const scheduler = createScheduler({ store: f.sources.schedules, executeDeps: f.execution, now: () => f.clock.now });
    expect(await scheduler.tick()).toEqual([plan.target.key]);
    expect(f.received.map(call => call.url)).toEqual(['/v1/items/a', '/v1/items/b']);
    expect(await f.storage.repository.inspect(result.proposal_id)).toMatchObject({ execution_status: 'succeeded' });
  });
  it('expires a missed scheduled window without provider dispatch or ordinary fallback', async () => {
    const f = await fixture(); const result = await f.service.prepare(f.request(), f.origin);
    await f.storage.repository.decide(await f.decision(result.proposal_id), f.responder);
    const plan = await f.storage.repository.loadExecution(result.future_execution_ref);
    f.clock.now = plan.request.dispatch_deadline;
    const scheduler = createScheduler({ store: f.sources.schedules, executeDeps: f.execution, now: () => f.clock.now });
    expect(await scheduler.tick()).toEqual([]);
    expect(f.received).toHaveLength(0);
    expect(await f.storage.repository.inspect(result.proposal_id)).toMatchObject({ execution_status: 'expired' });
    expect(f.sources.schedules.get(plan.target.key)).toMatchObject({ enabled: false, next_run_at: null, last_run_at: null });
  });
  it('preserves the group across an uncovered call through the actual checkpoint writer and approval resumer', async () => {
    const f = await fixture('ask', true); const result = await f.service.prepare(f.request(), f.origin);
    const plan = await f.storage.repository.loadExecution(result.future_execution_ref);
    // `holdFirst` leaves the confirm step uncovered, so exactly one member is
    // offerable — the covered write. Selecting it leaves the uncovered call to
    // its ordinary gate, which is the hold this scenario drives. Pinned as a
    // length rather than an index so a coverage change fails loudly here rather
    // than silently selecting a different call.
    expect(plan.members).toHaveLength(1);
    await f.storage.repository.select({ proposal_id: result.proposal_id, expected_revision: result.revision,
      member_ids: [plan.members[0]!.member_id] }, f.responder);
    await f.storage.repository.decide(await f.decision(result.proposal_id), f.responder);
    f.clock.now = plan.target.due_at!;
    const claimed = await f.runtime.claim({ future_execution_ref: result.future_execution_ref,
      occurrence_key: `due:${f.clock.now}`, occurrence_sequence: 1 });
    const held = await handleExecute(f.execution, { recipe_id: plan.recipe.recipe_id,
      config: plan.recipe_snapshots[0]!.effective_config, execution_source: plan.origin.source },
    { run_id: claimed.run_id, preapproval_run: claimed.handle });
    expect(held, JSON.stringify(held)).toMatchObject({ success: false, awaiting_approval: true });
    expect(f.received).toHaveLength(0);
    const checkpoint = (await f.execution.checkpointStore!.listByRun(claimed.run_id))[0]!;
    expect(checkpoint).toMatchObject({ preapproval_execution_ref: result.future_execution_ref, gated_step_id: 'a' });
    expect(await f.storage.repository.inspect(result.proposal_id)).toMatchObject({ execution_status: 'held' });
    // The real answer path reacquires the private handle. An ordinary legacy
    // re-entry under the same run id cannot inherit the remaining group.
    await expect(handleExecute(f.execution, { recipe_id: plan.recipe.recipe_id, execution_source: plan.origin.source },
      { run_id: claimed.run_id })).rejects.toMatchObject({ code: 'preapproval_stale' });
    const resumer = createPreflightResumer({ getExecuteDeps: () => f.execution,
      auditLog: f.execution.auditLog!, gatedActionStore: f.execution.gatedActionStore });
    await resumer.resumeRun(checkpoint, { recipe_id: plan.recipe.recipe_id, gated_step_id: 'a' });
    expect(f.received.map(call => call.url)).toEqual(['/v1/items/a', '/v1/items/b']);
    const finished = await f.storage.repository.inspect(result.proposal_id);
    expect(finished).toMatchObject({ execution_status: 'succeeded', members: [{ status: 'succeeded' }] });
    await resumer.resumeRun(checkpoint, { recipe_id: plan.recipe.recipe_id, gated_step_id: 'a' });
    expect(f.received).toHaveLength(2);
    await expect(f.runtime.resume(checkpoint)).rejects.toMatchObject({ code: 'preapproval_already_claimed' });
  });
  it.each(['ask', 'never'] as const)('consumes reviewed HTTP members with declared %s policy through handleExecute and both real gateways', async approval => {
    const f = await fixture(approval); const result = await f.service.prepare(f.request(), f.origin);
    await f.storage.repository.decide(await f.decision(result.proposal_id), f.responder);
    const plan = await f.storage.repository.loadExecution(result.future_execution_ref);
    f.clock.now = plan.target.due_at!;
    const claimed = await f.runtime.claim({ future_execution_ref: result.future_execution_ref,
      occurrence_key: `due:${f.clock.now}`, occurrence_sequence: plan.target.qualifying_sequence + 1 });
    const output = await handleExecute(f.execution, { recipe_id: plan.recipe.recipe_id,
      config: plan.recipe_snapshots[0]!.effective_config, execution_source: plan.origin.source },
    { run_id: claimed.run_id, preapproval_run: claimed.handle });
    expect(output.success, JSON.stringify(output)).toBe(true);
    expect(f.received).toEqual(['a', 'b'].map(id => ({ url: `/v1/items/${id}`, method: 'POST',
      body: { message: `Reviewed ${id}`, reviewed: 'yes' } })));
    await expect(f.runtime.finish(claimed.handle, 'succeeded')).resolves.toBe('succeeded');
    const inspection = await f.storage.repository.inspect(result.proposal_id);
    expect(inspection.members.map(member => member.status)).toEqual(['succeeded', 'succeeded']);
    const commits = f.db.prepare('SELECT data FROM commits').all() as Array<{ data: string }>;
    expect(commits).toHaveLength(2);
    for (const row of commits) expect(JSON.parse(row.data)).toMatchObject({ status: 'succeeded', args: {},
      request_id: claimed.run_id, preapproval: { future_execution_ref: result.future_execution_ref } });
    await expect(handleExecute(f.execution, { recipe_id: plan.recipe.recipe_id,
      config: plan.recipe_snapshots[0]!.effective_config, execution_source: plan.origin.source },
    { run_id: claimed.run_id, preapproval_run: {} })).rejects.toMatchObject({ code: 'preapproval_stale' });
    expect(f.received).toHaveLength(2);
  });
  it('records a lost HTTP write response as uncertain and prevents the second effect or a replay', async () => {
    const f = await fixture(); const result = await f.service.prepare(f.request(), f.origin);
    await f.storage.repository.decide(await f.decision(result.proposal_id), f.responder);
    const plan = await f.storage.repository.loadExecution(result.future_execution_ref);
    f.clock.now = plan.target.due_at!; f.provider.dropResponse = true;
    const candidate = { future_execution_ref: result.future_execution_ref,
      occurrence_key: `due:${f.clock.now}`, occurrence_sequence: plan.target.qualifying_sequence + 1 };
    const claimed = await f.runtime.claim(candidate);
    const output = await handleExecute(f.execution, { recipe_id: plan.recipe.recipe_id,
      config: plan.recipe_snapshots[0]!.effective_config, execution_source: plan.origin.source },
    { run_id: claimed.run_id, preapproval_run: claimed.handle });
    expect(output.success).toBe(false);
    expect(await f.runtime.finish(claimed.handle, 'failed'), JSON.stringify({ output,
      inspection: await f.storage.repository.inspect(result.proposal_id) })).toBe('in_doubt');
    const inspection = await f.storage.repository.inspect(result.proposal_id);
    expect(inspection.execution_status).toBe('in_doubt');
    expect(inspection.members[0]?.status).toBe('in_doubt');
    expect(f.received).toHaveLength(1);
    expect(f.sources.schedules.get(plan.target.key)?.enabled).toBe(false);
    await expect(f.runtime.claim(candidate)).rejects.toBeDefined();
    expect(f.received).toHaveLength(1);
  });
  it('reviews two catalog effects once, using actual stores, policies and activation transaction', async () => {
    const f = await fixture();
    const result = await f.service.prepare(f.request(), f.origin);
    expect(result).toMatchObject({ coverage: 'complete', eligible_members: 2, uncovered_calls: 0 });
    const plan = await f.storage.repository.loadExecution(result.future_execution_ref);
    expect(plan.members.map(member => member.input)).toEqual([
      { id: 'a', 'body.message': 'Reviewed a' }, { id: 'b', 'body.message': 'Reviewed b' },
    ]);
    expect(plan.members.every(member => member.resources.length === 2)).toBe(true);
    expect(JSON.stringify(plan)).not.toContain('opaque-encrypted-credential');
    await expect(f.storage.repository.decide(await f.decision(result.proposal_id), f.responder))
      .resolves.toMatchObject({ decision: 'approve', execution_status: 'active' });
    expect(f.db.prepare('SELECT * FROM preapproval_decisions').all()).toHaveLength(1);
    expect(f.db.prepare('SELECT * FROM preapproval_grants').all()).toHaveLength(1);
    expect(f.db.prepare('SELECT * FROM preapproval_members').all()).toHaveLength(2);
    expect(f.sources.schedules.get(plan.target.key)?.enabled).toBe(false);
  });

  it('invalidates at the catalog-binding writer even if an identical binding is restored before a late decision', async () => {
    const f = await fixture(); const result = await f.service.prepare(f.request(), f.origin);
    const input = await f.decision(result.proposal_id);
    f.bindings.removeForPack('test-pack');
    f.bindings.bind('crm', catalog.slug, 'test-pack');
    expect((await f.storage.repository.inspect(result.proposal_id)).execution_status).toBe('invalidated');
    await expect(f.storage.repository.decide(input, f.responder)).rejects.toMatchObject({ code: 'preapproval_invalid_proof' });
    expect(f.db.prepare('SELECT * FROM preapproval_grants').all()).toHaveLength(0);
  });

  it.each(['remove_restore', 'edit_restore'] as const)('invalidates an installed manifest generation before dispatch: %s', async action => {
    const f = await fixture('ask', false, true);
    const result = await f.service.prepare(f.request(), f.origin);
    await f.storage.repository.decide(await f.decision(result.proposal_id), f.responder);
    const registry = f.execution.executorConfig.manifests;
    const original = structuredClone(registry.get(catalog.slug)!);
    if (action === 'remove_restore') registry.unregister(catalog.slug);
    else registry.register({ ...original, description: 'Replacement operation definition' });
    registry.register(original);
    expect((await f.storage.repository.inspect(result.proposal_id)).execution_status).toBe('invalidated');
    f.clock.now += 60_001;
    await f.execution.preapprovalDriver!.tickSchedules(f.clock.now);
    expect(f.received).toHaveLength(0);
  });

  it('does not advertise or prepare an activation merely because its identity resolver exists', async () => {
    const f = await fixture(); f.disableRunner();
    expect(f.service.capabilities().activation_kinds).toEqual([]);
    await expect(f.service.prepare(f.request(), f.origin)).rejects.toMatchObject({ code: 'preapproval_unsupported' });
  });
  it('refuses a saved recipe that strict execution would reject before any provider call', async () => {
    const f = await fixture(); const recipe = f.sources.recipes.get(fixtureRecipe.recipe_id)!;
    f.sources.recipes.save({ ...recipe, metadata: { ...recipe.metadata, description: '' } }, 'core', 'inline');
    await expect(f.service.prepare(f.request(), f.origin)).rejects.toMatchObject({ code: 'preapproval_unresolved' });
    expect(f.db.prepare('SELECT * FROM preapproval_proposals').all()).toHaveLength(0);
    expect(f.received).toHaveLength(0);
  });
});
