/** D-343 (the owner's day, 2026-11-14) — a task's new due date on its approval reads as the day and
 *  time on the owner's clock, under "Due", where it read "due_at: 16 Nov 2026, 17:00 UTC". */
import { describe, expect, it } from 'vitest';
import type { Checkpoint } from '@recued/contracts';
import { buildPreflightAsk } from '../preflight-reconciliation.js';

describe('D-343 — a due date on an approval', () => {
  it('reads as the day and time on the owner\'s clock', () => {
    const at = Date.parse('2026-11-15T17:00:00Z');
    const ask = buildPreflightAsk({ checkpoint: { checkpoint_id: 'c', run_id: 'r', step_state: {}, created_at: 1,
      raw_op: { tier1_tool: 'work.update', op_id: 'work.update', catalog_slug: 'recued:tier1', operation: 'work.update', connection_name: '',
        op_args: { kind: 'task', id: 't1', due_at: at }, risk_tier: 'write',
        execution_source: { channel: 'messenger', vendor: 'telegram', actor: 'user_self', chat_session_id: 's', turn_id: 't', user_id: 'o' } },
      preflight_context: { tool_slug: 'work.update', risk_tier: 'write',
        value_labels: { id: { t1: 'Call the plumber' }, due_at: { [String(at)]: 'Sun 15 Nov, 17:00' } } } } as unknown as Checkpoint,
      context: { raw_op: { op_id: 'work.update' }, tool_slug: 'work.update', risk_tier: 'write' } });
    expect(ask.message.plain!.text.split('\n').slice(0, 3)).toEqual(['The AI in your Telegram chat wants to change a task:', '  Call the plumber', '  Due: Sun 15 Nov, 17:00']);
    expect(ask.message.text).toContain('Due: Sun 15 Nov, 17:00');
    expect(ask.message.text).not.toContain('UTC');
  });
});

describe('D-343 — a due date with no name on the owner\'s clock', () => {
  it('keeps its key, which reads as a date', () => {
    const at = Date.parse('2026-11-15T17:00:00Z');
    const ask = buildPreflightAsk({ checkpoint: { checkpoint_id: 'c', run_id: 'r', step_state: {}, created_at: 1,
      raw_op: { tier1_tool: 'work.update', op_id: 'work.update', catalog_slug: 'recued:tier1', operation: 'work.update', connection_name: '',
        op_args: { kind: 'task', id: 't1', due_at: at }, risk_tier: 'write',
        execution_source: { channel: 'messenger', vendor: 'telegram', actor: 'user_self', chat_session_id: 's', turn_id: 't', user_id: 'o' } },
      preflight_context: { tool_slug: 'work.update', risk_tier: 'write' } } as unknown as Checkpoint,
      context: { raw_op: { op_id: 'work.update' }, tool_slug: 'work.update', risk_tier: 'write' } });
    expect(ask.message.text).not.toContain(String(at));
    expect(ask.message.text).toContain('due_at: 15 Nov 2026');
  });
});
