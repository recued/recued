import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { isChatToolCallRecord, type ChatToolCallRecord } from '@recued/contracts';
import type { AppendMessageInput } from './chat-store.js';

// Shared by all chat-store adapters in this server process. Opening another
// adapter is not a restart. No old call is ever resumed by this read model.
const PROCESS_ID = randomUUID();
export type StoredChatToolCall = ChatToolCallRecord & { process_id: string };
export interface ChatToolCallSettlement {
  message_id: string;
  state: 'succeeded' | 'failed' | 'interrupted';
}

const storedCall = (metadata: string | null): StoredChatToolCall | undefined => {
  try {
    const value = JSON.parse(metadata ?? '{}').tool_call as StoredChatToolCall | undefined;
    if (!isChatToolCallRecord(value) || typeof value.process_id !== 'string') {
      return undefined;
    }
    return value;
  } catch { return undefined; }
};

export const chatToolCallFromMetadata = (
  metadata: string | null,
  processId: string = PROCESS_ID,
): ChatToolCallRecord | undefined => {
  const value = storedCall(metadata);
  if (!value) return undefined;
  const { process_id, ...record } = value;
  return {
    ...record,
    state: record.state === 'running' && process_id !== processId
      ? 'interrupted' : record.state,
  };
};

/** Called inside the result row's INSERT transaction. A crash cannot leave a
 * durable result alongside an apparently still-running dispatch. */
export const settleChatToolCall = (
  db: Database.Database,
  session_id: string,
  settlement: ChatToolCallSettlement,
  ts: number,
): void => {
  db.prepare(`UPDATE chat_messages
    SET metadata_blob = json_set(metadata_blob,
      '$.tool_call.state', @state, '$.tool_call.updated_at',
      MAX(@ts, COALESCE(json_extract(metadata_blob, '$.tool_call.updated_at'), @ts)))
    WHERE message_id = @message_id AND session_id = @session_id
      AND role = 'tool' AND json_valid(metadata_blob)
      AND json_extract(metadata_blob, '$.tool_call.state') IN ('running', 'held', 'interrupted')
  `).run({ ...settlement, session_id, ts });
};

export interface ChatToolCallTracker {
  get(message_id: string): ChatToolCallRecord | undefined;
  bind(message_id: string, run_id: string, recipe_id?: string): void;
  progress(message_id: string, run_id: string, at: number, stalled: boolean): boolean;
  hold(message_id: string): void;
  interrupt(message_id: string, includeHeld?: boolean): void;
  list(session_id?: string): ChatToolCallRecord[];
  findByRun(session_id: string, run_id: string): string[];
  /** Called only when an existing authorized continuation actually dispatches. */
  resumeRun(session_id: string, run_id: string): string[];
  dismiss(session_id: string, message_id: string): boolean;
}
export interface ChatToolCallStore extends ChatToolCallTracker {
  start(input: AppendMessageInput & { turn_id: string; tool_name: string }): Promise<string>;
}

export const createChatToolCallTracker = (
  db: Database.Database,
  processId: string = PROCESS_ID,
): ChatToolCallTracker => {
  // Existing metadata is enough; no new job table or column migration.
  db.exec(`CREATE INDEX IF NOT EXISTS idx_chat_tool_call_state
    ON chat_messages(json_extract(metadata_blob, '$.tool_call.state'), ts)
    WHERE role = 'tool' AND json_valid(metadata_blob)`);
  const get = db.prepare(`SELECT metadata_blob FROM chat_messages
    WHERE message_id = ? AND role = 'tool'`);
  const read = (id: string): StoredChatToolCall | undefined => {
    const row = get.get(id) as { metadata_blob: string | null } | undefined;
    return storedCall(row?.metadata_blob ?? null);
  };
  const update = db.prepare(`UPDATE chat_messages
    SET metadata_blob = json_set(metadata_blob, '$.tool_call', json(@call)),
        pair_id = @pair_id
    WHERE message_id = @message_id AND role = 'tool'
      AND json_extract(metadata_blob, '$.tool_call') = @previous`);
  const write = (previous: StoredChatToolCall, call: StoredChatToolCall): boolean => {
    return update.run({ message_id: call.message_id, pair_id: call.run_id ?? call.message_id,
      previous: JSON.stringify(previous), call: JSON.stringify(call) }).changes > 0;
  };
  return {
    get(message_id) {
      const row = get.get(message_id) as { metadata_blob: string | null } | undefined;
      return chatToolCallFromMetadata(row?.metadata_blob ?? null, processId);
    },
    bind(message_id, run_id, recipe_id) {
      const call = read(message_id);
      if (!call || call.process_id !== processId || call.state !== 'running') return;
      if (call.run_id !== undefined && call.run_id !== run_id) return;
      write(call, { ...call, run_id, ...(recipe_id !== undefined ? { recipe_id } : {}) });
    },
    progress(message_id, run_id, at, stalled) {
      const call = read(message_id);
      if (!call || call.process_id !== processId || call.state !== 'running'
        || call.run_id !== run_id || !Number.isFinite(at)) return false;
      if (at < call.updated_at) return false;
      // Coalesce heartbeat/output activity to at most one write per second;
      // the first observation and changes to stalled state are immediate.
      if (call.last_signal_at !== undefined && at - call.updated_at < 1_000
        && Boolean(call.stalled) === stalled) return false;
      return write(call, { ...call, updated_at: Math.max(at, call.updated_at),
        ...(stalled ? {} : { last_signal_at: at }), stalled });
    },
    hold(message_id) {
      const call = read(message_id);
      if (!call || call.process_id !== processId || call.state !== 'running') return;
      write(call, { ...call, state: 'held', updated_at: Math.max(Date.now(), call.updated_at) });
    },
    interrupt(message_id, includeHeld = false) {
      const call = read(message_id);
      if (!call || !(call.process_id === processId && call.state === 'running'
        || includeHeld && call.state === 'held')) return;
      write(call, { ...call, state: 'interrupted', process_id: processId,
        updated_at: Math.max(Date.now(), call.updated_at) });
    },
    list(session_id) {
      const rows = db.prepare(`SELECT metadata_blob FROM chat_messages
        WHERE role = 'tool' AND json_valid(metadata_blob)
          AND json_extract(metadata_blob, '$.tool_call.state') IN ('running', 'held', 'interrupted')
          AND json_extract(metadata_blob, '$.tool_call.reviewed_at') IS NULL
          AND recall_eligibility = 'chat:owner_authenticated'
          AND recall_contract_id IS NULL
          AND (@session_id IS NULL OR session_id = @session_id)
        ORDER BY ts, message_id`).all({ session_id: session_id ?? null }) as
          Array<{ metadata_blob: string }>;
      return rows.flatMap(row => {
        const call = chatToolCallFromMetadata(row.metadata_blob, processId);
        return call ? [call] : [];
      });
    },
    findByRun(session_id, run_id) {
      return (db.prepare(`SELECT message_id FROM chat_messages
        WHERE session_id = @session_id AND pair_id = @run_id
          AND role = 'tool' AND json_valid(metadata_blob)
          AND json_extract(metadata_blob, '$.tool_call.state') IN ('running', 'held', 'interrupted')
      `).all({ session_id, run_id }) as Array<{ message_id: string }>).map(row => row.message_id);
    },
    resumeRun(session_id, run_id) {
      return this.list(session_id).flatMap(call => {
        if (call.state !== 'held' || call.run_id !== run_id) return [];
        const prior = read(call.message_id);
        if (!prior) return [];
        return write(prior, { ...prior, state: 'running', process_id: processId,
          updated_at: Math.max(Date.now(), prior.updated_at), stalled: false })
          ? [call.message_id] : [];
      });
    },
    dismiss(session_id, message_id) {
      const call = this.list(session_id).find(row => row.message_id === message_id);
      if (call?.state !== 'interrupted') return false;
      const stored = read(message_id);
      if (!stored) return false;
      return write(stored, { ...stored, state: 'interrupted', reviewed_at: Date.now() });
    },
  };
};

export const createChatToolCallStore = (
  db: Database.Database,
  append: (input: AppendMessageInput) => Promise<unknown>,
  processId: string = PROCESS_ID,
): ChatToolCallStore => ({
  ...createChatToolCallTracker(db, processId),
  async start(input) {
    const ts = input.ts ?? Date.now();
    await append({ ...input, role: 'tool', pair_id: input.id, tool_call: {
      message_id: input.id, session_id: input.session_id, turn_id: input.turn_id,
      tool_name: input.tool_name, state: 'running', started_at: ts, updated_at: ts,
      process_id: processId,
    } });
    return input.id;
  },
});
