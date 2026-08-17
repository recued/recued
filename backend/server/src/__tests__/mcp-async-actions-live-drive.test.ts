/** LIVE DRIVE for MCP approval continuations.
 *
 * This test deliberately crosses the process/storage seams that the unit tests
 * cannot prove:
 *
 *   JSON-RPC tools/call
 *     -> real MCP held-result projection
 *     -> real file-backed SQLite action/checkpoint/audit stores
 *     -> close the originating connection (process-style restart)
 *     -> boot the real `recued --mcp` stdio profile on that realm
 *     -> approve through the real PreflightResumer on another connection
 *     -> real cross-process notification poll
 *     -> JSON-RPC action-status query returns the exact retained result
 *
 * The recipe is intentionally local and side-effect free. The subject here is
 * the continuation protocol and its durable ownership, not a third-party API.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import type {
  ChatDispatchContext,
  ChatDispatchResult,
  Checkpoint,
  InternalToolRegistry,
  RecipeDefinition,
  ToolEntry,
} from '@recued/contracts';
import { hashRecipe } from '@recued/recipes';
import {
  buildAuditEntry,
  createAuditLogStore,
  createCheckpointStore,
  type ActivityEntry,
  type AuditEntry,
} from '@recued/storage';

import { ensureAuditIndexes } from '../audit-indexes.js';
import type { ExecuteHandlerDeps } from '../execute-handler.js';
import { createManifestRegistry } from '../manifest-loader.js';
import {
  MCP_ACTION_NOTIFICATION_METHOD,
  MCP_ACTION_STATUS_TOOL_NAME,
  MCP_ACTION_TABLE,
  createMcpActionStore,
  createSqliteMcpActionCompareAndSet,
  type McpActionRecord,
} from '../mcp-action-store.js';
import { createMcpHttpDispatch, type McpDeps } from '../mcp-server.js';
import { ensureCheckpointSchema } from '../memory-schema.js';
import { openDatabase } from '../open-database.js';
import { createPreflightResumer } from '../preflight-resumer.js';
import { createRecipeStore } from '../recipe-store.js';
import { createSQLiteCollection } from '../sqlite-collection.js';
import {
  createChatInboundTokenStore,
  deriveMcpInboundTokenId,
  ensureChatInboundTokenSchema,
} from '../storage/chat-inbound-token-store.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..', '..', '..', '..');
const binPath = join(repoRoot, 'backend/server/src/bin.ts');
const serverTsconfigPath = join(repoRoot, 'backend/server/tsconfig.json');

const BEARER = 'recued_mcp_async_action_live_drive_bearer';
const TOKEN_ID = deriveMcpInboundTokenId(BEARER);
const ACTION_REF = 'mcpact_live_drive';
const RUN_ID = 'run-mcp-live-drive';
const CHECKPOINT_ID = 'cp-mcp-live-drive';
const SECRET_ARGUMENT = 'must-not-land-in-mcp-action-storage';

const PROOF_RECIPE: RecipeDefinition = {
  recipe_id: 'mcp-live-drive-recipe',
  version: 1,
  ttl: 60,
  metadata: {
    name: 'MCP live-drive continuation',
    description: 'Side-effect-free receipt used to prove approval continuation',
    author: 'recued-test',
    supported_platforms: [],
  },
  variables: { receipt_id: 'receipt-not-yet-approved' },
  prefetch_steps: [],
  steps: [{
    id: 'approved_action',
    transform: 'template',
    template: 'approved provider receipt {{config.receipt_id}}',
  }],
  output: {
    sidebar: [{ type: 'text', source: 'step.approved_action' }],
  },
};

const HELD_TOOL: ToolEntry = {
  name: 'proof/send-and-continue',
  tier: 2,
  description: 'Live-drive approval continuation',
  arg_schema: { type: 'object', properties: {} },
  topic_tags: ['proof'],
  classification: 'write',
  concurrency_safe: false,
};

const CHECKPOINT: Checkpoint = {
  checkpoint_id: CHECKPOINT_ID,
  run_id: RUN_ID,
  recipe_id: PROOF_RECIPE.recipe_id,
  gated_step_id: 'approved_action',
  step_state: {},
  created_at: Date.now(),
};

const configureConnection = (db: Awaited<ReturnType<typeof openDatabase>>): void => {
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
};

const liveStores = (db: Awaited<ReturnType<typeof openDatabase>>) => {
  const auditLog = createAuditLogStore(
    createSQLiteCollection<AuditEntry>(db, 'audit_entries'),
    createSQLiteCollection<ActivityEntry>(db, 'audit_activities'),
  );
  ensureAuditIndexes(db);
  const checkpointStore = createCheckpointStore(
    createSQLiteCollection<Checkpoint>(db, 'checkpoints'),
  );
  ensureCheckpointSchema(db);
  const actionStore = createMcpActionStore(
    createSQLiteCollection<McpActionRecord>(db, MCP_ACTION_TABLE),
    {
      newActionRef: () => ACTION_REF,
      compareAndSet: createSqliteMcpActionCompareAndSet(db),
    },
  );
  return { actionStore, auditLog, checkpointStore };
};

const registry = (
  dispatch: (
    name: string,
    args: unknown,
    ctx: ChatDispatchContext,
  ) => Promise<ChatDispatchResult>,
): InternalToolRegistry => ({
  list: () => [HELD_TOOL],
  listByTier: (tier) => tier === 2 ? [HELD_TOOL] : [],
  getByName: (name) => name === HELD_TOOL.name ? HELD_TOOL : null,
  dispatch,
  subscribeRefresh: () => () => undefined,
});

interface SeedResult {
  held: Record<string, unknown>;
  awaiting: Record<string, unknown>;
  actionRowJson: string;
}

const seedHeldInvocation = async (dbPath: string): Promise<SeedResult> => {
  const db = await openDatabase(dbPath, { databaseKey: null });
  configureConnection(db);
  try {
    ensureChatInboundTokenSchema(db);
    createChatInboundTokenStore(db).issueToken({
      value: {
        label: 'MCP action live drive',
        grants: { [HELD_TOOL.name]: true },
        concurrency_tier: 3,
        chat_mode: null,
      },
      now: Date.now(),
      bearer_plaintext: BEARER,
    });

    const { actionStore, auditLog, checkpointStore } = liveStores(db);
    const deps: McpDeps = {
      recipeStore: createRecipeStore('/nonexistent'),
      executorConfig: { manifests: createManifestRegistry('/nonexistent') },
      baseVault: {},
      ownerAdmitAll: true,
      mcpTokenId: TOKEN_ID,
      mcpActionStore: actionStore,
      checkpointStore,
      auditLog,
      internalRegistry: registry(async () => {
        await checkpointStore.write(CHECKPOINT);
        await auditLog.append(buildAuditEntry({
          recipe_id: PROOF_RECIPE.recipe_id,
          recipe_hash: hashRecipe(PROOF_RECIPE),
          commit_status: 'awaiting_approval',
          duration_ms: 1,
          errors: [],
          config_snapshot: { receipt_id: 'receipt-live-1' },
          trigger_url: null,
          run_id: RUN_ID,
          checkpoint_id: CHECKPOINT_ID,
          now: Date.now(),
        }));
        return {
          ok: true,
          run_id: RUN_ID,
          run_held: { kind: 'approval' },
          result: {
            status: 'awaiting_approval',
            awaiting_approval: true,
            message: 'waiting for the owner',
          },
        };
      }),
    } as McpDeps;
    const dispatch = createMcpHttpDispatch(deps);

    const heldResponse = await dispatch({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: HELD_TOOL.name,
        arguments: {
          to: 'owner@example.invalid',
          body: SECRET_ARGUMENT,
        },
      },
    }) as { result: { structuredContent: Record<string, unknown> } };
    const awaitingResponse = await dispatch({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: MCP_ACTION_STATUS_TOOL_NAME,
        arguments: { action_ref: ACTION_REF },
      },
    }) as { result: { structuredContent: Record<string, unknown> } };
    const row = db.prepare(
      `SELECT data FROM ${MCP_ACTION_TABLE} WHERE key = ?`,
    ).get(ACTION_REF) as { data: string };

    return {
      held: heldResponse.result.structuredContent,
      awaiting: awaitingResponse.result.structuredContent,
      actionRowJson: row.data,
    };
  } finally {
    db.close();
  }
};

const settleApprovedInvocation = async (
  dbPath: string,
): Promise<{ action: McpActionRecord; anchor: AuditEntry }> => {
  // This is intentionally a second connection while the stdio MCP profile has
  // its own connection open: it models the server process receiving approval.
  const db = await openDatabase(dbPath, { databaseKey: null });
  configureConnection(db);
  try {
    const { actionStore, auditLog, checkpointStore } = liveStores(db);
    const recipeStore = createRecipeStore('/nonexistent');
    recipeStore.register(PROOF_RECIPE);
    const executeDeps = {
      recipeStore,
      executorConfig: { manifests: createManifestRegistry('/nonexistent') },
      baseVault: {},
      auditLog,
      checkpointStore,
      mcpActionStore: actionStore,
    } as ExecuteHandlerDeps;
    const checkpoint = await checkpointStore.get(CHECKPOINT_ID);
    if (checkpoint === null) throw new Error('live-drive checkpoint missing');

    const resumer = createPreflightResumer({
      getExecuteDeps: () => executeDeps,
      auditLog,
      mcpActionStore: actionStore,
    });
    await resumer.resumeRun(checkpoint, {
      recipe_id: PROOF_RECIPE.recipe_id,
      gated_step_id: 'approved_action',
      approved_at: Date.now(),
    });
    // The production notification answer leaf consumes the checkpoint after a
    // successful resumer return. Reproduce that final ownership step here.
    await checkpointStore.delete(CHECKPOINT_ID);

    const action = await actionStore.getOwned(ACTION_REF, TOKEN_ID);
    const anchor = await auditLog.get(RUN_ID);
    if (action === null || anchor === null) {
      throw new Error('live-drive terminal state missing');
    }
    return { action, anchor };
  } finally {
    db.close();
  }
};

type JsonObject = Record<string, unknown>;

interface StdioDriveResult {
  responses: JsonObject[];
  notifications: JsonObject[];
  stderr: string;
  timedOut: boolean;
  exitCode: number | null;
  settled?: Awaited<ReturnType<typeof settleApprovedInvocation>>;
}

let activeChild: ChildProcessWithoutNullStreams | undefined;
let tempDir: string | undefined;

const stopProcessGroup = (
  child: ChildProcessWithoutNullStreams | undefined,
  signal: NodeJS.Signals,
): void => {
  if (!child?.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try { child.kill(signal); } catch { /* already gone */ }
  }
};

const driveRealStdioProfile = (dbPath: string): Promise<StdioDriveResult> =>
  new Promise((resolvePromise) => {
    const child = spawn(
      'npx',
      [
        '--no-install',
        'tsx',
        binPath,
        '--mcp',
        '--db',
        dbPath,
        '--token',
        BEARER,
      ],
      {
        cwd: repoRoot,
        detached: true,
        env: {
          ...process.env,
          TSX_TSCONFIG_PATH: serverTsconfigPath,
          RECUED_BOOT_TRACE: '1',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    activeChild = child;

    const responses: JsonObject[] = [];
    const notifications: JsonObject[] = [];
    let stderr = '';
    let stdoutBuffer = '';
    let timedOut = false;
    let settling = false;
    let settleTask: Promise<void> | undefined;
    let terminalQuerySent = false;
    let settled: Awaited<ReturnType<typeof settleApprovedInvocation>> | undefined;
    let finished = false;

    const send = (message: JsonObject): void => {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    };
    const finish = (exitCode: number | null): void => {
      if (finished) return;
      finished = true;
      activeChild = undefined;
      resolvePromise({
        responses,
        notifications,
        stderr,
        timedOut,
        exitCode,
        ...(settled !== undefined ? { settled } : {}),
      });
    };
    const settle = async (): Promise<void> => {
      if (settling) return;
      settling = true;
      try {
        settled = await settleApprovedInvocation(dbPath);
      } catch (error) {
        stderr += `\n[live-drive parent] ${error instanceof Error ? error.stack : String(error)}`;
        stopProcessGroup(child, 'SIGTERM');
      }
    };
    const consumeMessage = (message: JsonObject): void => {
      if (Object.prototype.hasOwnProperty.call(message, 'id')) responses.push(message);
      else if (typeof message.method === 'string') notifications.push(message);

      if (message.id === 1) {
        send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
        send({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: {
            name: MCP_ACTION_STATUS_TOOL_NAME,
            arguments: { action_ref: ACTION_REF },
          },
        });
        return;
      }
      if (message.id === 2) {
        settleTask ??= settle();
        return;
      }
      if (
        message.method === MCP_ACTION_NOTIFICATION_METHOD
        && (message.params as { action_ref?: unknown; terminal?: unknown } | undefined)
          ?.action_ref === ACTION_REF
        && (message.params as { terminal?: unknown }).terminal === true
        && !terminalQuerySent
      ) {
        terminalQuerySent = true;
        send({
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: {
            name: MCP_ACTION_STATUS_TOOL_NAME,
            arguments: { action_ref: ACTION_REF },
          },
        });
        return;
      }
      if (message.id === 3) child.stdin.end();
    };

    const timeout = setTimeout(() => {
      timedOut = true;
      child.stdin.end();
      stopProcessGroup(child, 'SIGTERM');
    }, 30_000);
    const forceStop = setTimeout(() => {
      stopProcessGroup(child, 'SIGKILL');
    }, 33_000);
    forceStop.unref();

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdoutBuffer += chunk;
      for (;;) {
        const newline = stdoutBuffer.indexOf('\n');
        if (newline < 0) break;
        const line = stdoutBuffer.slice(0, newline).trim();
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        if (!line) continue;
        try {
          consumeMessage(JSON.parse(line) as JsonObject);
        } catch {
          stderr += `\n[live-drive non-json stdout] ${line}`;
        }
      }
    });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.once('spawn', () => {
      send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    });
    child.once('error', (error) => {
      stderr += error instanceof Error ? error.stack ?? error.message : String(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timeout);
      clearTimeout(forceStop);
      void (settleTask ?? Promise.resolve()).finally(() => { finish(code); });
    });
  });

afterEach(() => {
  stopProcessGroup(activeChild, 'SIGKILL');
  activeChild = undefined;
  if (tempDir !== undefined) rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

describe('MCP async actions — live SQLite + real stdio profile', () => {
  it('survives restart, notifies across connections, and returns the exact resumed result', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'recued-mcp-action-live-drive-'));
    const dbPath = join(tempDir, 'server.db');

    const seeded = await seedHeldInvocation(dbPath);
    expect(seeded.held).toMatchObject({
      status: 'awaiting_approval',
      action_ref: ACTION_REF,
      action_status: 'awaiting_approval',
      action_query_tool: MCP_ACTION_STATUS_TOOL_NAME,
    });
    expect(seeded.awaiting).toMatchObject({
      action_ref: ACTION_REF,
      status: 'awaiting_approval',
      terminal: false,
    });
    expect(seeded.actionRowJson).not.toContain(SECRET_ARGUMENT);
    expect(seeded.actionRowJson).not.toContain('owner@example.invalid');

    const drive = await driveRealStdioProfile(dbPath);
    expect(drive.timedOut, drive.stderr).toBe(false);
    expect(drive.exitCode, drive.stderr).toBe(0);
    expect(drive.stderr).not.toContain('the supplied token was not recognised');

    const initialized = drive.responses.find((message) => message.id === 1) as
      | { result?: { capabilities?: { experimental?: Record<string, JsonObject> } } }
      | undefined;
    expect(initialized?.result?.capabilities?.experimental?.['com.recued/async-actions'])
      .toMatchObject({
        queryTool: MCP_ACTION_STATUS_TOOL_NAME,
        notificationMethod: MCP_ACTION_NOTIFICATION_METHOD,
      });

    const awaiting = drive.responses.find((message) => message.id === 2) as
      | { result?: { structuredContent?: Record<string, unknown> } }
      | undefined;
    expect(awaiting?.result?.structuredContent).toMatchObject({
      action_ref: ACTION_REF,
      status: 'awaiting_approval',
      terminal: false,
    });

    const terminalNotification = drive.notifications.find((message) =>
      message.method === MCP_ACTION_NOTIFICATION_METHOD
      && (message.params as { action_ref?: unknown } | undefined)?.action_ref === ACTION_REF
      && (message.params as { terminal?: unknown } | undefined)?.terminal === true
    );
    expect(
      terminalNotification,
      JSON.stringify({ settled: drive.settled, stderr: drive.stderr }, null, 2),
    ).toMatchObject({
      method: MCP_ACTION_NOTIFICATION_METHOD,
      params: {
        action_ref: ACTION_REF,
        status: 'completed',
        terminal: true,
        query_tool: MCP_ACTION_STATUS_TOOL_NAME,
      },
    });
    expect(terminalNotification?.params).not.toHaveProperty('result');

    const terminal = drive.responses.find((message) => message.id === 3) as
      | { result?: { structuredContent?: Record<string, unknown> } }
      | undefined;
    expect(drive.settled?.action).toMatchObject({
      action_ref: ACTION_REF,
      status: 'completed',
    });
    expect(drive.settled?.anchor.commit_status).toBe('succeeded');
    expect(terminal?.result?.structuredContent).toMatchObject({
      action_ref: ACTION_REF,
      status: 'completed',
      terminal: true,
    });
    expect(terminal?.result?.structuredContent?.result).toEqual(
      drive.settled?.action.result,
    );
    expect(terminal?.result?.structuredContent?.result).toMatchObject({
      recipe_id: PROOF_RECIPE.recipe_id,
      success: true,
    });

    const verifyDb = await openDatabase(dbPath, { databaseKey: null });
    configureConnection(verifyDb);
    try {
      const { actionStore, checkpointStore } = liveStores(verifyDb);
      expect(await checkpointStore.get(CHECKPOINT_ID)).toBeNull();
      expect(await actionStore.getOwned(ACTION_REF, 'different-token')).toBeNull();
      expect(await actionStore.getOwned(ACTION_REF, TOKEN_ID)).toMatchObject({
        status: 'completed',
        revision: 3,
      });
    } finally {
      verifyDb.close();
    }
  }, 45_000);
});
