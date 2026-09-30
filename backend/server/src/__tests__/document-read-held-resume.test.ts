/** An approved `document.read` reaches its caller only through the reader.
 *
 *  The reader's converter run holds when the caller's ceiling is below the
 *  converter's write risk (a delegated MCP token, or an owner policy that asks).
 *  The approval resumes it in the preflight resumer, whose two deliveries (the
 *  MCP action result and the owner-chat result row) carried the run's RAW
 *  response: the file's bytes as `bytes_b64`, with none of the reader's checks.
 *
 *  Real: the Tier-1 handler, the resumer, the MCP action store and the chat
 *  settle sink. Stubbed: the executor on both sides of the hold. */
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStorageGate } from '@recued/storage-gate';
import { hashRecipe } from '@recued/recipes';
import {
  buildAuditEntry,
  createAuditLogStore,
  createInMemoryCollection,
  type ActivityEntry,
  type AuditEntry,
  type AuditLogStore,
} from '@recued/storage';
import {
  parseGrantEntry,
  type ChatDispatchContext,
  type Checkpoint,
  type CollectionRecord,
  type IngredientManifest,
  type RecipeDefinition,
} from '@recued/contracts';

const handleExecuteMock = vi.hoisted(() => vi.fn());
vi.mock('../execute-handler.js', () => ({ handleExecute: handleExecuteMock }));

import { buildChatTier1Handlers, type ChatToolHandlerDeps } from '../chat-tool-handlers.js';
import { createChatRunSettledSink } from '../chat-run-settled-sink.js';
import { createCollectionRegistry } from '../collections/registry.js';
import { createCollectionTable } from '../collections/table.js';
import type { Collection } from '../collections/types.js';
import { documentReadRecipe } from '../document-read-tool.js';
import type { ExecuteHandlerDeps } from '../execute-handler.js';
import { createManifestRegistry } from '../manifest-loader.js';
import { createMcpActionStore, type McpActionRecord, type McpActionStore } from '../mcp-action-store.js';
import { createPreflightResumer, type PreflightRunSettled } from '../preflight-resumer.js';
import { createReadGrantChecker } from '../read-grant-checker.js';
import {
  RESUMED_RUN_FINISHER_TTL_MS,
  RESUMED_RUN_FINISHERS_MAX,
  registerResumedRunFinisher,
  takeResumedRunFinisher,
} from '../resumed-run-finishers.js';
import { createChatStore, ensureChatSchema } from '../storage/chat-store.js';
import { stampExecuteResponseAuditRun, type ExecuteRequest, type ExecuteResponse } from '../types.js';

const FILE_REF = 'file:11111111111111111111111111111111';
const MARKDOWN = '# Scope\nThe Friday deadline is withdrawn.';
const BYTES_B64 = Buffer.from(MARKDOWN).toString('base64');
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const fileRow = (hash = sha('original')): CollectionRecord => ({ record_id: FILE_REF, source_id: 'mail:seed:part-1',
  received_at: 1, modified_at: 1, size_bytes: 100, blob_hash: hash,
  hot_fields: { filename: 'specification.pdf', mime_type: 'application/pdf', content_hash: hash } });
const signature = { server_kind: 'recued' as const, version: '1', instance_id: 'test' };

const doorCtx: ChatDispatchContext = { channel: 'mcp_wire', mcp_token_id: 'door-token',
  execution_source: { channel: 'mcp', actor: 'contracted_user', agent_id: 'agent', tool_call_id: 'call-1', mcp_token_id: 'door-token', contract_id: 'door' },
  contract_snapshot: { contract_id: 'door', contract_version: 'v1', allowed_tools: [], approval_required: [], scope_restrictions: [], resolved_at: 1 } };
const ownerSource = { channel: 'chat' as const, actor: 'user_self' as const, chat_session_id: 'work-chat', turn_id: 'turn-1', user_id: 'local' };
const ownerCtx: ChatDispatchContext = { channel: 'internal_function_call', session_id: 'work-chat', turn_id: 'turn-1', execution_source: ownerSource };

const summary = (data: Record<string, unknown>): ExecuteResponse => ({ recipe_id: 'read-work-document', recipe_hash: 'hash', success: true,
  output: { render: [{ type: 'summary', data }], sidebar: [] }, steps: [], errors: [], duration_ms: 1 });
/** What the resumed converter run returns: the temp read's bytes. */
const converted = (): ExecuteResponse => summary({ bytes_b64: BYTES_B64 });
const pausedAgain = (): ExecuteResponse => ({ recipe_id: 'read-work-document', recipe_hash: 'hash', success: false, awaiting_approval: true,
  output: { render: [], sidebar: [] }, steps: [], errors: [], duration_ms: 1 });
const recipeOf = (request: ExecuteRequest) => request.recipe as { steps: Array<{ id: string; args?: Record<string, unknown> }> };

let db: Database.Database;
let files: ReturnType<typeof createCollectionTable>;
let deps: ChatToolHandlerDeps;
let execute: ReturnType<typeof vi.fn<(request: ExecuteRequest) => Promise<ExecuteResponse>>>;
let allowed: Set<string>;
let conversions: number;
let auditLog: AuditLogStore;
let actions: McpActionStore;
let settled: PreflightRunSettled[];
let sinks: Promise<void>[];
let chatStore: ReturnType<typeof createChatStore>;

beforeEach(() => {
  db = new Database(':memory:');
  const registry = createCollectionRegistry();
  files = createCollectionTable({ db, platform: 'file', slug: 'received', ftsTextFor: () => '' });
  const collection: Collection = { platform: 'file', slug: 'received', get: files.get, list: files.list, search: files.search,
    upsert: files.upsert, delete: id => files.delete(id) !== null,
    gate: createStorageGate({ quota: 10000000, reservePct: 0, surface: 'test:file' }),
    health: () => ({ platform: 'file', slug: 'received', last_indexed_at: Date.now(), pending_queue_size: 0, error_count_24h: 0, state: 'idle' }),
    sync: { start: async () => {}, stop: async () => {} }, close: async () => {}, runRetention: async () => { throw new Error('No retention during reads'); },
  };
  registry.register(collection);
  files.upsert(fileRow());
  const manifests = createManifestRegistry('/nonexistent');
  for (const name of ['markitdown', 'docling']) {
    const manifest: IngredientManifest = { slug: `${name}-catalog`, name, description: 'Document conversion', author: 'recued-core',
      kind: 'connection', version: 1, category: 'data', risk_tier: 'write', input: {}, output: {},
      operations: { 'document.to_markdown': { operation_id: 'document.to_markdown', risk_tier: 'write', description: 'Convert document' } } };
    manifests.register(manifest);
  }
  allowed = new Set(['file']);
  conversions = 0;
  let runs = 0;
  execute = vi.fn(async (request: ExecuteRequest): Promise<ExecuteResponse> => {
    const [first] = recipeOf(request).steps;
    // The converter's write risk is above this caller's ceiling: the run holds.
    if (first?.id === 'convert') {
      conversions++;
      return stampExecuteResponseAuditRun(pausedAgain(), `run-doc-${++runs}`);
    }
    // A later read re-admits the source with the kernel's metadata-only read.
    if (first?.args?.metadata_only === true) {
      const file = files.get(FILE_REF);
      return summary({ record_id: file?.record_id, mime_type: file?.hot_fields.mime_type, filename: file?.hot_fields.filename,
        size_bytes: file?.size_bytes, blob_hash: file?.blob_hash });
    }
    throw new Error('No direct read in this suite');
  });
  const checker = () => createReadGrantChecker({ isGranted: (_id, entry, fallback) => {
    const parsed = parseGrantEntry(entry); return parsed.kind === 'collection' ? allowed.has(parsed.value) : fallback;
  } }, 'owner');
  deps = { getCollectionRegistry: () => registry, getContactStore: () => undefined, getAuditLog: () => undefined,
    getEnrichmentStore: () => undefined, getRecipeStore: () => { throw new Error('No stored recipe lookup'); },
    getExecutorConfig: () => ({ manifests }) as ReturnType<ChatToolHandlerDeps['getExecutorConfig']>,
    getExecuteRecipe: () => execute,
    documentPacks: () => ['markitdown', 'docling'].map(name => ({ segments: [name], value: { publisher: 'recued-core', ingredient_ids: [`${name}-catalog`] } })),
    getReadGrantResolver: () => ({ resolveForContract: checker, resolveForSource: checker }),
  };
  auditLog = createAuditLogStore(createInMemoryCollection<AuditEntry>(), createInMemoryCollection<ActivityEntry>());
  actions = createMcpActionStore(createInMemoryCollection<McpActionRecord>());
  ensureChatSchema(db);
  chatStore = createChatStore(db);
  chatStore.createSession({ id: 'work-chat', now: 1_000 });
  settled = [];
  sinks = [];
  handleExecuteMock.mockReset();
});
afterEach(() => db.close());

/** The resumer as composed: live authority re-resolution admits the door, and
 *  every settle reaches the real chat sink. */
const resumer = () => {
  const sink = createChatRunSettledSink(chatStore, signature, { emit: vi.fn() });
  const executeDeps = {
    recipeStore: { get: () => null },
    executorConfig: { manifests: createManifestRegistry('/nonexistent') },
    baseVault: {},
    mcpActionStore: actions,
    approvalResumeAuthority: { resolve: () => ({ admitted: true, execution_source: doorCtx.execution_source!, contract_snapshot: doorCtx.contract_snapshot! }) },
  } as unknown as ExecuteHandlerDeps;
  return createPreflightResumer({ auditLog, getExecuteDeps: () => executeDeps,
    onRunSettled: (run) => { settled.push(run); sinks.push(sink(run)); } });
};

/** What the execute handler durably wrote when the reader's run held: the
 *  awaiting anchor, and the checkpoint carrying the inline recipe it ran. */
const pauseRecorded = async (request: ExecuteRequest, runId: string, checkpointId = `checkpoint-${runId}`): Promise<Checkpoint> => {
  const recipe = request.recipe as RecipeDefinition;
  await auditLog.append(buildAuditEntry({ recipe_id: recipe.recipe_id, recipe_hash: hashRecipe(recipe), commit_status: 'awaiting_approval',
    duration_ms: 1, errors: [], config_snapshot: request.config ?? {}, trigger_url: null, trigger_source: request.trigger_source ?? null,
    run_id: runId, now: Date.now(), ...(request.execution_source ? { execution_source: request.execution_source } : {}),
    ...(request.contract_snapshot ? { contract_snapshot: request.contract_snapshot } : {}), checkpoint_id: checkpointId }));
  return { checkpoint_id: checkpointId, run_id: runId, recipe_id: recipe.recipe_id,
    recipe_snapshot: recipe as unknown as Record<string, unknown>, gated_step_id: 'convert', step_state: {}, created_at: Date.now() };
};
const approve = { recipe_id: 'read-work-document', gated_step_id: 'convert', tool_slug: 'markitdown-catalog', risk_tier: 'write' };

/** A held door read: the caller's answer, and the durable pause and action. */
const holdDoorRead = async (read: ReturnType<typeof buildChatTier1Handlers>['document.read']) => {
  const held = await read!({ file_ref: FILE_REF }, doorCtx);
  expect(held).toMatchObject({ ok: true, run_held: { kind: 'approval' }, run_id: expect.any(String) });
  const runId = (held as { run_id: string }).run_id;
  const checkpoint = await pauseRecorded(execute.mock.calls.at(-1)![0], runId);
  await actions.createHeld({ run_id: runId, principal_id: 'door-token', tool_name: 'document.read', kind: 'recipe',
    checkpoint_id: checkpoint.checkpoint_id });
  return { runId, checkpoint };
};

/** A held owner-chat read, with its durable call bound to the run. */
const holdOwnerRead = async (read: ReturnType<typeof buildChatTier1Handlers>['document.read']) => {
  const held = await read!({ file_ref: FILE_REF }, ownerCtx);
  const runId = (held as { run_id: string }).run_id;
  await chatStore.toolCalls!.start({ id: 'call-owner', session_id: 'work-chat', turn_id: 'turn-1', role: 'tool', tool_name: 'document.read',
    content: `document.read(${JSON.stringify({ file_ref: FILE_REF })})`, target_server: 'self',
    picker_at_send: { display_name: 'self', signature }, model_used: { provider: 'recued', model_id: 'tool-call' },
    execution_source: ownerSource, ts: 1_000 });
  chatStore.toolCalls!.bind('call-owner', runId);
  chatStore.toolCalls!.hold('call-owner');
  return { runId, checkpoint: await pauseRecorded(execute.mock.calls.at(-1)![0], runId) };
};

const chatRow = async (id: string) => {
  await Promise.all(sinks);
  return (await chatStore.listMessages('work-chat')).find(row => row.id === id);
};

describe('an approved document.read', () => {
  it('reaches the MCP caller as a reading, and the next read is served from that conversion without a second hold', async () => {
    const read = buildChatTier1Handlers(deps)['document.read'];
    const { runId, checkpoint } = await holdDoorRead(read);
    handleExecuteMock.mockResolvedValueOnce(converted());

    await resumer().resumeRun(checkpoint, approve);

    const action = await actions.getByRun(runId);
    expect(action).toMatchObject({ status: 'completed', result: { status: 'read', file_ref: FILE_REF, content_hash: sha('original'),
      body: MARKDOWN, offset: 0, next_offset: null, converter: 'markitdown', cached: false,
      read_version: expect.stringMatching(/^[0-9a-f]{64}$/) } });
    expect(JSON.stringify(action)).not.toContain('bytes_b64');
    expect(JSON.stringify(action)).not.toContain(BYTES_B64);

    const next = await read!({ file_ref: FILE_REF }, { ...doorCtx,
      execution_source: { ...doorCtx.execution_source!, tool_call_id: 'call-2' } as ChatDispatchContext['execution_source'] });
    expect(next).toMatchObject({ ok: true, result: { status: 'read', cached: true, body: MARKDOWN,
      read_version: (action!.result as { read_version: string }).read_version } });
    expect(next).not.toHaveProperty('run_held');
    expect(conversions).toBe(1);
    expect(recipeOf(execute.mock.calls.at(-1)![0]).steps.map(step => step.id)).toEqual(['read']);
  });

  it("applies the reader's checks at approval time: a revoked file grant or a changed source returns no content", async () => {
    const read = buildChatTier1Handlers(deps)['document.read'];
    const revoked = await holdDoorRead(read);
    allowed.delete('file');
    handleExecuteMock.mockResolvedValueOnce(converted());
    await resumer().resumeRun(revoked.checkpoint, approve);
    const denied = await actions.getByRun(revoked.runId);
    expect(denied?.result).toMatchObject({ status: 'unavailable' });
    expect(JSON.stringify(denied)).not.toContain(BYTES_B64);
    expect(JSON.stringify(denied)).not.toContain('Friday deadline');

    allowed.add('file');
    const replaced = await holdDoorRead(read);
    files.upsert(fileRow(sha('replacement')));
    handleExecuteMock.mockResolvedValueOnce(converted());
    await resumer().resumeRun(replaced.checkpoint, approve);
    const changed = await actions.getByRun(replaced.runId);
    expect(changed?.result).toMatchObject({ status: 'changed' });
    expect(JSON.stringify(changed)).not.toContain('Friday deadline');
  });

  it('keeps its finisher when the resumed run pauses again, and finishes on the resume that ends it', async () => {
    const read = buildChatTier1Handlers(deps)['document.read'];
    const { runId, checkpoint } = await holdDoorRead(read);
    handleExecuteMock.mockImplementationOnce(async () => {
      await pauseRecorded(execute.mock.calls.at(-1)![0], runId, 'checkpoint-second-gate');
      return pausedAgain();
    });
    await resumer().resumeRun(checkpoint, approve);
    expect(await actions.getByRun(runId)).toMatchObject({ status: 'awaiting_approval', approval_round: 2 });

    handleExecuteMock.mockResolvedValueOnce(converted());
    await resumer().resumeRun({ ...checkpoint, checkpoint_id: 'checkpoint-second-gate' }, approve);
    expect(await actions.getByRun(runId)).toMatchObject({ status: 'completed', result: { status: 'read', body: MARKDOWN } });
  });

  it('closes the owner-chat call with the reading, not the bytes', async () => {
    const read = buildChatTier1Handlers(deps)['document.read'];
    const { runId, checkpoint } = await holdOwnerRead(read);
    handleExecuteMock.mockResolvedValueOnce(converted());

    await resumer().resumeRun(checkpoint, approve);

    const row = await chatRow(`settle:${runId}`);
    expect(row?.content).toMatch(/^document\.read: /u);
    expect(row?.content).toContain('"status":"read"');
    expect(row?.content).toContain('The Friday deadline is withdrawn.');
    expect(row?.content).not.toContain('bytes_b64');
    expect(row?.content).not.toContain(BYTES_B64);
    // Judged as the inline call is: a reading closes the call as succeeded.
    expect((await chatRow('call-owner'))?.tool_call?.state).toBe('succeeded');
    expect(chatStore.toolCalls!.list()).toEqual([]);
  });
});

describe('an approved document.read whose finisher is gone (a restart between the hold and the approval)', () => {
  it('delivers no bytes to the MCP caller, only the instruction to read again', async () => {
    const { runId, checkpoint } = await holdDoorRead(buildChatTier1Handlers(deps)['document.read']);
    expect(takeResumedRunFinisher(runId)).toBeDefined();
    handleExecuteMock.mockResolvedValueOnce(converted());

    await resumer().resumeRun(checkpoint, approve);

    const action = await actions.getByRun(runId);
    expect(action).toMatchObject({ status: 'completed', result: { status: 'converted', file_ref: FILE_REF,
      hint: expect.stringContaining('Call document.read again with the same file_ref') } });
    expect(JSON.stringify(action)).not.toContain('bytes_b64');
    expect(JSON.stringify(action)).not.toContain(BYTES_B64);
  });

  it('writes no bytes into the owner-chat settle row', async () => {
    const { runId, checkpoint } = await holdOwnerRead(buildChatTier1Handlers(deps)['document.read']);
    expect(takeResumedRunFinisher(runId)).toBeDefined();
    handleExecuteMock.mockResolvedValueOnce(converted());

    await resumer().resumeRun(checkpoint, approve);

    const row = await chatRow(`settle:${runId}`);
    expect(row?.content).toContain('"status":"converted"');
    expect(row?.content).not.toContain('bytes_b64');
    expect(row?.content).not.toContain(BYTES_B64);
    expect(settled.map(run => JSON.stringify(run.result)).join()).not.toContain(BYTES_B64);
  });
});

describe('any other resumed recipe', () => {
  it('is delivered exactly as before, and leaves a held read\'s finisher in place', async () => {
    const pending = { tool_name: 'document.read', finish: vi.fn() };
    registerResumedRunFinisher('run-doc-pending', pending);
    // An installed recipe sharing the reader's id is not the reader: no inline snapshot.
    const cases: Array<[string, RecipeDefinition, boolean]> = [
      ['run-other-inline', { ...documentReadRecipe('markitdown'), recipe_id: 'other-inline' }, true],
      ['run-stored-lookalike', documentReadRecipe('markitdown'), false],
    ];
    for (const [runId, recipe, inline] of cases) {
      const request: ExecuteRequest = { recipe, config: { source: FILE_REF }, trigger_source: 'mcp',
        execution_source: doorCtx.execution_source!, contract_snapshot: doorCtx.contract_snapshot! };
      const checkpoint = await pauseRecorded(request, runId);
      await actions.createHeld({ run_id: runId, principal_id: 'door-token', tool_name: 'recipe.run', kind: 'recipe',
        checkpoint_id: checkpoint.checkpoint_id });
      const response = { ...converted(), recipe_id: recipe.recipe_id };
      handleExecuteMock.mockResolvedValueOnce(response);

      await resumer().resumeRun(inline ? checkpoint : { ...checkpoint, recipe_snapshot: undefined }, approve);

      expect((await actions.getByRun(runId))?.result).toEqual(JSON.parse(JSON.stringify(response)));
      expect(settled.at(-1)).toMatchObject({ run_id: runId, tool_name: recipe.recipe_id, result: response });
      expect(settled.at(-1)).not.toHaveProperty('state');
    }
    expect(pending.finish).not.toHaveBeenCalled();
    expect(takeResumedRunFinisher('run-doc-pending')).toBe(pending);
  });
});

describe('the resumed-run finisher registry', () => {
  const finisher = { tool_name: 'document.read', finish: async () => ({ ok: true as const, result: {} }) };
  // The registry is process state shared with the tests above: time runs
  // forward from the real clock, as it does for every entry they register.
  const now = Date.now();

  it('hands a finisher out once', () => {
    registerResumedRunFinisher('run-once', finisher, now);
    expect(takeResumedRunFinisher('run-once', now + 1)).toBe(finisher);
    expect(takeResumedRunFinisher('run-once', now + 2)).toBeUndefined();
  });

  it('forgets a finisher older than its age bound, even behind a newer-stamped one (a clock step back)', () => {
    registerResumedRunFinisher('run-kept', finisher, now + RESUMED_RUN_FINISHER_TTL_MS);
    registerResumedRunFinisher('run-old', finisher, now);
    expect(takeResumedRunFinisher('run-old', now + RESUMED_RUN_FINISHER_TTL_MS)).toBeUndefined();
    expect(takeResumedRunFinisher('run-kept', now + RESUMED_RUN_FINISHER_TTL_MS)).toBe(finisher);
  });

  it('keeps only the newest finishers past its count bound', () => {
    for (let i = 0; i <= RESUMED_RUN_FINISHERS_MAX; i++) registerResumedRunFinisher(`run-${i}`, finisher, now + i);
    expect(takeResumedRunFinisher('run-0', now + 100)).toBeUndefined();
    expect(takeResumedRunFinisher('run-1', now + 100)).toBe(finisher);
    expect(takeResumedRunFinisher(`run-${RESUMED_RUN_FINISHERS_MAX}`, now + 100)).toBe(finisher);
  });
});
