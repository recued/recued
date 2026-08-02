/** Durable MCP async-action state.
 *
 * A preflight approval ends the running process and leaves a Checkpoint on disk.
 * MCP callers therefore cannot wait on the original `tools/call` promise. This
 * store gives that original invocation an opaque, token-bound address which
 * survives approval, restart, and any later approval gates in the same run.
 *
 * Privacy posture:
 * - original tool arguments are never copied here;
 * - the final agent-facing result is retained only for a bounded period;
 * - oversized/non-serializable results are replaced with an explicit omission
 *   receipt instead of growing the SQLite JSON table without bound.
 *
 * The store deliberately sits in the server package, not `@recued/storage`:
 * this is an MCP protocol projection over the generic Collection primitive,
 * not a cross-runtime domain contract. */

import { randomUUID } from 'node:crypto';
import type { Collection } from '@recued/storage';
import type Database from 'better-sqlite3';

export const MCP_ACTION_STATUS_TOOL_NAME = 'recued_actionStatus';
export const MCP_ACTION_NOTIFICATION_METHOD = 'notifications/recued/action-status';
export const MCP_ACTION_TABLE = 'mcp_async_actions';

/** Final results are a continuation aid, not an archive. */
export const MCP_ACTION_TERMINAL_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
/** Bounds one deferred result independently of provider/recipe output limits. */
export const MCP_ACTION_MAX_RESULT_BYTES = 1 * 1_024 * 1_024;

export type McpActionKind = 'recipe' | 'raw_op';
export type McpActionStatus =
  | 'awaiting_approval'
  | 'running'
  | 'completed'
  | 'denied'
  | 'failed'
  | 'cancelled'
  | 'in_doubt';

export type McpActionTerminalStatus = Extract<
  McpActionStatus,
  'completed' | 'denied' | 'failed' | 'cancelled' | 'in_doubt'
>;

const TERMINAL_STATUSES: ReadonlySet<McpActionStatus> = new Set([
  'completed',
  'denied',
  'failed',
  'cancelled',
  'in_doubt',
]);

export const isMcpActionTerminal = (
  status: McpActionStatus,
): status is McpActionTerminalStatus => TERMINAL_STATUSES.has(status);

export interface McpActionRecord {
  schema_version: 1;
  action_ref: string;
  /** The original invocation's durable run identity. Reused across re-gates. */
  run_id: string;
  /** Authenticated MCP token identity. Never the raw bearer. */
  principal_id: string;
  tool_name: string;
  kind: McpActionKind;
  status: McpActionStatus;
  status_message: string;
  /** One for the initial hold, incremented when the same run gates again. */
  approval_round: number;
  current_checkpoint_id?: string;
  created_at: number;
  updated_at: number;
  /** Monotonic even when several transitions share one millisecond. */
  revision: number;
  terminal_at?: number;
  expires_at?: number;
  /** Agent-facing result only; original arguments are never retained. */
  result?: unknown;
  result_omitted_reason?: 'size_limit' | 'not_serializable';
}

export interface McpActionPublicState {
  action_ref: string;
  run_id: string;
  tool_name: string;
  status: McpActionStatus;
  terminal: boolean;
  status_message: string;
  approval_round: number;
  created_at: number;
  updated_at: number;
  revision: number;
  result?: unknown;
  result_omitted_reason?: McpActionRecord['result_omitted_reason'];
}

export interface CreateHeldMcpActionInput {
  run_id: string;
  principal_id: string;
  tool_name: string;
  kind: McpActionKind;
  checkpoint_id?: string;
  status_message?: string;
}

export interface FinishMcpActionInput {
  status: McpActionTerminalStatus;
  result: unknown;
  status_message: string;
}

export type McpActionStoreEvent =
  | { kind: 'created'; record: McpActionRecord }
  | { kind: 'updated'; record: McpActionRecord };

export interface McpActionStore {
  createHeld(input: CreateHeldMcpActionInput): Promise<McpActionRecord>;
  getOwned(action_ref: string, principal_id: string): Promise<McpActionRecord | null>;
  getByRun(run_id: string): Promise<McpActionRecord | null>;
  listOwned(principal_id: string): Promise<McpActionRecord[]>;
  markRunning(run_id: string, status_message?: string): Promise<McpActionRecord | null>;
  markAwaiting(
    run_id: string,
    checkpoint_id: string | undefined,
    status_message?: string,
  ): Promise<McpActionRecord | null>;
  finish(run_id: string, input: FinishMcpActionInput): Promise<McpActionRecord | null>;
  subscribe(listener: (event: McpActionStoreEvent) => void): () => void;
}

export interface CreateMcpActionStoreOptions {
  now?: () => number;
  newActionRef?: () => string;
  maxResultBytes?: number;
  terminalRetentionMs?: number;
  /** Cross-process compare-and-set. Required by SQLite-backed compositions so
   * a polling MCP process cannot overwrite a terminal update from the server. */
  compareAndSet?: McpActionCompareAndSet;
}

export type McpActionCompareAndSet = (
  actionRef: string,
  expectedRevision: number,
  next: McpActionRecord,
) => Promise<boolean>;

/** One-statement CAS for the generic JSON table. The row's revision lives in
 * its JSON payload, so this preserves the one-table storage shape while making
 * state transitions safe between the main server and a separate stdio MCP
 * process. `createSQLiteCollection` must be called first to create the table. */
export const createSqliteMcpActionCompareAndSet = (
  db: Database.Database,
): McpActionCompareAndSet => {
  const update = db.prepare(`
    UPDATE ${MCP_ACTION_TABLE}
       SET data = ?
     WHERE key = ?
       AND json_extract(data, '$.revision') = ?
  `);
  return async (actionRef, expectedRevision, next) =>
    update.run(JSON.stringify(next), actionRef, expectedRevision).changes === 1;
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const ACTION_STATUSES: ReadonlySet<string> = new Set([
  'awaiting_approval',
  'running',
  'completed',
  'denied',
  'failed',
  'cancelled',
  'in_doubt',
]);

/** Narrow untrusted JSON read from the generic SQLite collection. */
export const isMcpActionRecord = (value: unknown): value is McpActionRecord => {
  if (!isPlainObject(value)) return false;
  const text = (key: string): boolean =>
    typeof value[key] === 'string' && (value[key] as string).length > 0;
  const finite = (key: string): boolean =>
    typeof value[key] === 'number' && Number.isFinite(value[key]);
  if (value.schema_version !== 1) return false;
  if (!text('action_ref') || !text('run_id') || !text('principal_id')) return false;
  if (!text('tool_name') || !text('status_message')) return false;
  if (value.kind !== 'recipe' && value.kind !== 'raw_op') return false;
  if (typeof value.status !== 'string' || !ACTION_STATUSES.has(value.status)) return false;
  if (!finite('created_at') || !finite('updated_at') || !finite('revision')) return false;
  if (!finite('approval_round')) return false;
  if ((value.revision as number) < 1 || (value.approval_round as number) < 1) return false;
  if (
    value.current_checkpoint_id !== undefined
    && (typeof value.current_checkpoint_id !== 'string' || value.current_checkpoint_id.length === 0)
  ) return false;
  for (const key of ['terminal_at', 'expires_at'] as const) {
    if (value[key] !== undefined && !finite(key)) return false;
  }
  if (
    value.result_omitted_reason !== undefined
    && value.result_omitted_reason !== 'size_limit'
    && value.result_omitted_reason !== 'not_serializable'
  ) return false;
  const terminal = isMcpActionTerminal(value.status as McpActionStatus);
  if (terminal !== (value.terminal_at !== undefined && value.expires_at !== undefined)) {
    return false;
  }
  return true;
};

export const projectMcpActionPublicState = (
  record: McpActionRecord,
  options: { includeResult?: boolean } = {},
): McpActionPublicState => ({
  action_ref: record.action_ref,
  run_id: record.run_id,
  tool_name: record.tool_name,
  status: record.status,
  terminal: isMcpActionTerminal(record.status),
  status_message: record.status_message,
  approval_round: record.approval_round,
  created_at: record.created_at,
  updated_at: record.updated_at,
  revision: record.revision,
  ...(options.includeResult !== false && isMcpActionTerminal(record.status)
    ? { result: record.result }
    : {}),
  ...(record.result_omitted_reason !== undefined
    ? { result_omitted_reason: record.result_omitted_reason }
    : {}),
});

interface RetainedResult {
  result: unknown;
  result_omitted_reason?: McpActionRecord['result_omitted_reason'];
}

const retainResult = (result: unknown, maxBytes: number): RetainedResult => {
  let json: string | undefined;
  try {
    json = JSON.stringify(result);
  } catch {
    return {
      result: {
        result_available: false,
        message: 'The action finished, but its deferred result was not serializable. Inspect Recued Logs for the run outcome.',
      },
      result_omitted_reason: 'not_serializable',
    };
  }
  if (json === undefined) {
    return {
      result: {
        result_available: false,
        message: 'The action finished, but its deferred result was not serializable. Inspect Recued Logs for the run outcome.',
      },
      result_omitted_reason: 'not_serializable',
    };
  }
  if (Buffer.byteLength(json, 'utf8') <= maxBytes) {
    // Persist the JSON value the MCP wire can actually reproduce, not a live
    // object reference that may later mutate or serialize differently.
    return { result: JSON.parse(json) as unknown };
  }
  return {
    result: {
      result_available: false,
      message: 'The action finished, but its deferred result exceeded the local retention limit. Inspect Recued Logs for the run outcome.',
    },
    result_omitted_reason: 'size_limit',
  };
};

/** Build a durable store over one generic Collection table. */
export const createMcpActionStore = (
  backing: Collection<McpActionRecord>,
  options: CreateMcpActionStoreOptions = {},
): McpActionStore => {
  const now = options.now ?? Date.now;
  const newActionRef = options.newActionRef
    ?? (() => `mcpact_${randomUUID().replaceAll('-', '')}`);
  const maxResultBytes = Math.max(1, Math.floor(
    options.maxResultBytes ?? MCP_ACTION_MAX_RESULT_BYTES,
  ));
  const terminalRetentionMs = Math.max(1, Math.floor(
    options.terminalRetentionMs ?? MCP_ACTION_TERMINAL_RETENTION_MS,
  ));
  const compareAndSet = options.compareAndSet;
  const listeners = new Set<(event: McpActionStoreEvent) => void>();
  // Serializes read-modify-write transitions inside one process. SQLite still
  // provides atomic row replacement across the stdio/server process boundary.
  let mutationTail: Promise<void> = Promise.resolve();

  const mutate = <T>(fn: () => Promise<T>): Promise<T> => {
    const result = mutationTail.then(fn, fn);
    mutationTail = result.then(() => undefined, () => undefined);
    return result;
  };

  const publish = (event: McpActionStoreEvent): void => {
    for (const listener of listeners) {
      try {
        listener(event);
      } catch {
        // Observers are wake-up hints. Persistence is the source of truth.
      }
    }
  };

  const live = async (record: McpActionRecord | null): Promise<McpActionRecord | null> => {
    if (record === null || !isMcpActionRecord(record)) return null;
    if (record.expires_at !== undefined && record.expires_at <= now()) {
      await backing.delete(record.action_ref);
      return null;
    }
    return record;
  };

  const allLive = async (): Promise<McpActionRecord[]> => {
    const rows = await backing.list();
    const out: McpActionRecord[] = [];
    for (const row of rows) {
      if (!isMcpActionRecord(row)) continue;
      if (row.expires_at !== undefined && row.expires_at <= now()) {
        await backing.delete(row.action_ref);
        continue;
      }
      out.push(row);
    }
    return out;
  };

  const findByRun = async (runId: string): Promise<McpActionRecord | null> => {
    if (runId.length === 0) return null;
    const matches = (await allLive())
      .filter((row) => row.run_id === runId)
      .sort((a, b) => b.created_at - a.created_at);
    return matches[0] ?? null;
  };

  const writeUpdate = async (
    existing: McpActionRecord,
    derivePatch: (
      current: McpActionRecord,
    ) => Partial<McpActionRecord> | null,
  ): Promise<McpActionRecord> => {
    let current = existing;
    // CAS contention should be tiny (one answer writer plus an occasional MCP
    // status reader). Bound retries so a damaged backing cannot spin forever.
    for (let attempt = 0; attempt < 16; attempt += 1) {
      if (isMcpActionTerminal(current.status)) return current;
      const patch = derivePatch(current);
      if (patch === null) return current;
      const updated: McpActionRecord = {
        ...current,
        ...patch,
        action_ref: current.action_ref,
        run_id: current.run_id,
        principal_id: current.principal_id,
        tool_name: current.tool_name,
        kind: current.kind,
        schema_version: 1,
        updated_at: Math.max(current.updated_at, now()),
        revision: current.revision + 1,
      };
      const won = compareAndSet === undefined
        ? (await backing.set(updated.action_ref, updated), true)
        : await compareAndSet(updated.action_ref, current.revision, updated);
      if (won) {
        publish({ kind: 'updated', record: updated });
        return updated;
      }
      const observed = await live(await backing.get(current.action_ref));
      if (observed === null) {
        throw new Error('MCP action disappeared during a state transition');
      }
      current = observed;
    }
    throw new Error('MCP action state transition exceeded its contention limit');
  };

  return {
    createHeld(input) {
      return mutate(async () => {
        if (
          input.run_id.length === 0
          || input.principal_id.length === 0
          || input.tool_name.length === 0
        ) {
          throw new Error('MCP action run, principal, and tool identities must be non-empty');
        }
        const existing = await findByRun(input.run_id);
        if (existing !== null) {
          if (existing.principal_id !== input.principal_id) {
            throw new Error('MCP action run identity is already bound to another principal');
          }
          if (isMcpActionTerminal(existing.status)) return existing;
          if (
            existing.status === 'awaiting_approval'
            && existing.current_checkpoint_id === input.checkpoint_id
          ) return existing;
          return writeUpdate(existing, (current) => {
            if (
              current.status === 'awaiting_approval'
              && current.current_checkpoint_id === input.checkpoint_id
            ) return null;
            return {
              status: 'awaiting_approval',
              status_message:
                input.status_message ?? 'Waiting for owner approval outside the MCP client.',
              approval_round:
                input.checkpoint_id !== undefined
                && current.current_checkpoint_id !== undefined
                && input.checkpoint_id !== current.current_checkpoint_id
                  ? current.approval_round + 1
                  : current.approval_round,
              ...(input.checkpoint_id !== undefined
                ? { current_checkpoint_id: input.checkpoint_id }
                : {}),
            };
          });
        }
        const at = now();
        const actionRef = newActionRef();
        if (actionRef.length === 0 || await backing.has(actionRef)) {
          throw new Error('MCP action reference generator returned an invalid or duplicate value');
        }
        const record: McpActionRecord = {
          schema_version: 1,
          action_ref: actionRef,
          run_id: input.run_id,
          principal_id: input.principal_id,
          tool_name: input.tool_name,
          kind: input.kind,
          status: 'awaiting_approval',
          status_message:
            input.status_message ?? 'Waiting for owner approval outside the MCP client.',
          approval_round: 1,
          ...(input.checkpoint_id !== undefined
            ? { current_checkpoint_id: input.checkpoint_id }
            : {}),
          created_at: at,
          updated_at: at,
          revision: 1,
        };
        await backing.set(record.action_ref, record);
        publish({ kind: 'created', record });
        return record;
      });
    },

    async getOwned(action_ref, principal_id) {
      if (action_ref.length === 0 || principal_id.length === 0) return null;
      const record = await live(await backing.get(action_ref));
      // Deliberately collapse unknown and wrong-principal to the same result.
      return record?.principal_id === principal_id ? record : null;
    },

    getByRun(run_id) {
      return findByRun(run_id);
    },

    async listOwned(principal_id) {
      if (principal_id.length === 0) return [];
      return (await allLive())
        .filter((record) => record.principal_id === principal_id)
        .sort((a, b) => a.created_at - b.created_at);
    },

    markRunning(run_id, status_message) {
      return mutate(async () => {
        const existing = await findByRun(run_id);
        if (existing === null || isMcpActionTerminal(existing.status)) return existing;
        if (existing.status === 'running') return existing;
        return writeUpdate(existing, (current) => current.status === 'running'
          ? null
          : {
              status: 'running',
              status_message: status_message ?? 'Owner approval received; Recued resumed the original action.',
            });
      });
    },

    markAwaiting(run_id, checkpoint_id, status_message) {
      return mutate(async () => {
        const existing = await findByRun(run_id);
        if (existing === null || isMcpActionTerminal(existing.status)) return existing;
        if (
          existing.status === 'awaiting_approval'
          && existing.current_checkpoint_id === checkpoint_id
        ) return existing;
        return writeUpdate(existing, (current) => {
          if (
            current.status === 'awaiting_approval'
            && current.current_checkpoint_id === checkpoint_id
          ) return null;
          return {
            status: 'awaiting_approval',
            status_message:
              status_message ?? 'The resumed action reached another owner-approval gate.',
            approval_round:
              checkpoint_id !== undefined
              && current.current_checkpoint_id !== undefined
              && checkpoint_id !== current.current_checkpoint_id
                ? current.approval_round + 1
                : current.approval_round,
            ...(checkpoint_id !== undefined
              ? { current_checkpoint_id: checkpoint_id }
              : {}),
          };
        });
      });
    },

    finish(run_id, input) {
      return mutate(async () => {
        const existing = await findByRun(run_id);
        if (existing === null || isMcpActionTerminal(existing.status)) return existing;
        return writeUpdate(existing, () => {
          const at = now();
          const retained = retainResult(input.result, maxResultBytes);
          return {
            status: input.status,
            status_message: input.status_message,
            terminal_at: at,
            expires_at: at + terminalRetentionMs,
            result: retained.result,
            ...(retained.result_omitted_reason !== undefined
              ? { result_omitted_reason: retained.result_omitted_reason }
              : {}),
          };
        });
      });
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
};
