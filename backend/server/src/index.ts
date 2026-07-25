/** @recued/server — headless recipe engine.
 *
 *  Execution plane only. Pairs with a Recued extension (control plane)
 *  for recipes, credentials, and LLM config. Exposes two surfaces:
 *
 *    HTTP   — POST /execute, GET /health (extension-directed)
 *    MCP    — stdio JSON-RPC (local MCP clients: Claude Desktop, Cursor)
 *
 *  No outbound heartbeat. Slack/scheduled commands hit the extension's
 *  heartbeat first; the extension delegates to this server via the WS
 *  when the user picks a server instance as the execution target.
 *
 *  For end-to-end tests: spin up a random-port server with
 *  `startServer(0)`, point the extension at `http://localhost:{port}`,
 *  tear down with `server.close()`.
 */

export {
  startServer,
  createServerHandlerSet,
  SERVER_LEGACY_PATH_ALIASES,
  type ServerHandlerSet,
  type ServerConfig,
  type RunningServer,
} from './server.js';

// Execution — manifest registry, recipe store, executor, HTTP handler
export { createManifestRegistry, asManifestLoader, type ManifestRegistry } from './manifest-loader.js';
export { createRecipeStore, type RecipeStore } from './recipe-store.js';
export {
  createServerExecutor,
  createBoundExecutor,
  createNamespaceStores,
  resolveLLMConfigFromEnv,
  resolveVaultFromEnv,
  loadVaultFile,
  mergeVault,
  type ServerExecutorConfig,
} from './server-executor.js';
export { handleExecute, type ExecuteHandlerDeps } from './execute-handler.js';

// MCP stdio tool server
export { startMCPServer } from './mcp-server.js';

// Daemon lifecycle
export { daemonStart, daemonStop, daemonStatus, daemonRestart } from './daemon.js';

// SQLite helpers (audit log, vault, LLM config all use these)
export { createSQLiteCollection } from './sqlite-collection.js';

// Schedule store + loop + REST handlers — instance-autonomous scheduling
export { createScheduleStore, type ScheduleStore } from './schedule-store.js';
export { createScheduler, type SchedulerHandle, type SchedulerConfig } from './scheduler.js';
export {
  listSchedules, createSchedule, updateSchedule, deleteSchedule,
  type ScheduleHandlerDeps,
} from './schedule-handler.js';

// D-179 P1 — dishes (execution instances) + per-dish continuity
export { createDishStore, type DishStore } from './dish-store.js';
export { createDishContextStore, type DishContextStore } from './dish-context-store.js';
export {
  listDishes, createDish, updateDish, deleteDish,
  listDishGroups, createDishGroup, updateDishGroup, deleteDishGroup,
  type DishHandlerDeps,
} from './dish-handler.js';
// D-179 P3 — dish groups (workflow containers)
export { createDishGroupStore, type DishGroupStore } from './dish-group-store.js';
// D-179 P4 — run-outcome bus events
export {
  emitRunOutcome, originTriggerIdFromContext, type RunOutcomeInput,
} from './run-outcome-events.js';

// Vault (populated via pair-sync from extension)
export { createServerVaultStore, loadVaultAsObject, listVaultPublishers } from './server-vault.js';

// Account namespace (D-100; populated via sync from cloud or pair-relay from ext)
export {
  createServerAccountStore,
  type ServerAccountStore,
  type CreateServerAccountStoreOptions,
} from './account-store.js';

// WebSocket — pairing, pair-sync, chat delegation
export { attachWebSocket, type WsServerHandle, type WsClient } from './ws-server.js';
export { createPairingManager, type PairingManager, type PairingState, type PairingConfig } from './pairing.js';
export {
  createPairedInstancesStore,
  type PairedInstancesStore,
  type PairedInstance,
} from './paired-instances-store.js';

export {
  createRecoveryKeyCheckStore,
  type RecoveryKeyCheckStore,
} from './recovery-key-store.js';
export {
  processRecoveryKey,
  type ProcessRecoveryKeyResult,
} from './recovery-key-processor.js';

// LLM config (populated via pair-sync from extension)
export { createLLMConfigManager, type LLMConfigManager } from './llm-config.js';

// Console formatting (CLI + MCP reuse this)
export { formatResult, printResult } from './console-output.js';

// Types
export type {
  RealmId,
  HandlerResult,
  ExecuteRequest,
  ExecuteResponse,
  StoredRecipe,
} from './types.js';
