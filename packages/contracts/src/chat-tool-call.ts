/** Durable chat tool-call display state. This is evidence, never retry authority
 * or a replacement for a live process handle. Arguments/results remain in the
 * encrypted, paired chat messages. */
export interface ChatToolCallRecord {
  message_id: string;
  session_id: string;
  turn_id: string;
  tool_name: string;
  run_id?: string;
  recipe_id?: string;
  state: 'running' | 'held' | 'succeeded' | 'failed' | 'interrupted';
  started_at: number;
  updated_at: number;
  last_signal_at?: number;
  stalled?: boolean;
  reviewed_at?: number;
}

export const isChatToolCallRecord = (value: unknown): value is ChatToolCallRecord => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return ['message_id', 'session_id', 'turn_id', 'tool_name'].every(key =>
    typeof row[key] === 'string' && row[key].length > 0)
    && typeof row.state === 'string'
    && ['running', 'held', 'succeeded', 'failed', 'interrupted'].includes(row.state)
    && ['started_at', 'updated_at'].every(key => typeof row[key] === 'number' && Number.isFinite(row[key]))
    && ['run_id', 'recipe_id'].every(key => row[key] === undefined || typeof row[key] === 'string')
    && ['last_signal_at', 'reviewed_at'].every(key => row[key] === undefined
      || typeof row[key] === 'number' && Number.isFinite(row[key]))
    && (row.stalled === undefined || typeof row.stalled === 'boolean');
};
