/** The main turn's copy of the request records keeps a read's call and drops its result, which the turn's
 *  prior_tool_calls already hold (2026-11-18). Measured before: a large read came first within the records' byte limit
 *  and left no room for the approval states, which are added last. */
import { expect, it } from 'vitest';
import type { InternalToolRegistry, ToolEntry } from '@recued/contracts';
import { boundRequestEvidence, readerRequestRecords, withoutCurrentReadResults, type RequestExecutionEvidence } from '../chat-request-evidence.js';

const tool = (name: string, classification: 'read' | 'write'): ToolEntry => ({ name, tier: 1, description: name, classification,
  arg_schema: { type: 'object', properties: {}, additionalProperties: true }, topic_tags: ['fixture'], concurrency_safe: classification === 'read' });
const tools = [tool('files.read', 'read'), tool('mail.send', 'write')];
const registry: Pick<InternalToolRegistry, 'getByName'> = { getByName: (n) => tools.find((t) => t.name === n) ?? null };
const request = { request_id: 't2', message_id: 'm2', text: 'Read the contract, then send it.', received_at: 2 };
const receipt = (tool_name: string, result: unknown) => ({ invocation_id: `i-${tool_name}`, completed_for_request_id: 't2', tool_name,
  args: { name: 'contract' }, result, started_at: 3, completed_at: 4 });
const CONTRACT = 'Clause 7. The notice period is 45 days. '.repeat(500);
const evidence: RequestExecutionEvidence = {
  current_request: request,
  successful_calls_for_current_request: [receipt('files.read', { text: CONTRACT }), receipt('mail.send', { sent: true, message_id: 'x-1' }),
    receipt('unregistered.tool', { value: 1 })],
  earlier_requests: [], successful_actions_for_earlier_requests: [], recorded_assistant_replies: [],
  pending_approvals: { observation: 'available', observed_at: 5, scope: 'same_session_registered_tools', incomplete: false,
    plans: [{ plan_id: 'p-1', proposed_for_request_id: 't1', tool_name: 'calendar.rename', args: { event_id: 'EVENT-7', title: 'Review' },
      approval_status: 'awaiting_user_approval', execution_on_approval: 'host_resume',
      effect_confirmation: 'not_established_by_pending_approval', created_at: 1 }] },
};

it('a read keeps its call and drops its result; a write and an unknown tool keep theirs', () => {
  const [read, write, unknown] = withoutCurrentReadResults(evidence, registry).successful_calls_for_current_request;
  expect(read).toEqual({ invocation_id: 'i-files.read', completed_for_request_id: 't2', tool_name: 'files.read', args: { name: 'contract' },
    started_at: 3, completed_at: 4 });
  expect(write?.result).toEqual({ sent: true, message_id: 'x-1' });
  expect(unknown?.result).toEqual({ value: 1 });
  // The brief's own records are built from the unchanged evidence.
  expect(evidence.successful_calls_for_current_request[0]?.result).toEqual({ text: CONTRACT });
});

it('reads that fill the records\' byte limit no longer leave the pending approval out', () => {
  const limit = 8_000; // a learned window of 16,000 estimated tokens: the records may take half, in bytes
  // Three reads that each fit and together fill the limit (about 7,850 of 8,000 bytes); the approval states, added
  // last, need about 470 more.
  const page = (n: number) => receipt('files.read', { text: `Page ${String(n)}. ` + 'Clause text. '.repeat(180) });
  const filled: RequestExecutionEvidence = { ...evidence, successful_calls_for_current_request: [page(1), page(2), page(3)] };
  const before = boundRequestEvidence(filled, false, limit)!;
  expect(before.successful_calls_for_current_request).toHaveLength(3);
  expect(before.pending_approvals).toBeUndefined();
  expect(before.coverage?.incomplete).toBe(true);
  const after = boundRequestEvidence(withoutCurrentReadResults(filled, registry), false, limit)!;
  expect(after.pending_approvals?.plans.map((p) => p.plan_id)).toEqual(['p-1']);
  expect(after.successful_calls_for_current_request).toHaveLength(3);
  expect(after.coverage?.incomplete).toBe(false);
});

it('a read larger than the limit keeps its receipt, where before the whole receipt was dropped', () => {
  const before = boundRequestEvidence(evidence, false, 8_000)!;
  expect(before.successful_calls_for_current_request.map((r) => r.tool_name)).toEqual(['mail.send', 'unregistered.tool']);
  const after = boundRequestEvidence(withoutCurrentReadResults(evidence, registry), false, 8_000)!;
  expect(after.successful_calls_for_current_request.map((r) => r.tool_name)).toEqual(['files.read', 'mail.send', 'unregistered.tool']);
  expect(after.pending_approvals?.plans).toHaveLength(1);
});

// ── The reader's copy (2026-11-19; the owner's "3"): earlier replies, complete coverage and every empty list or
//    state are left out; what holds something, or could not be read, stays, with the current request beside it
//    (without it the model re-read a record it had just read: see `readerRequestRecords`).
it('leaves out what the reader already has or what holds nothing', () => {
  const reply = { request_id: 't1', message_id: 'a1', text: 'Renamed.', recorded_at: 2 };
  const earlier = { request_id: 't1', message_id: 'm1', text: 'Rename EVENT-7 to Review.', received_at: 1 };
  const cancelled = { observation: 'available', observed_at: 5, scope: 'same_session_cancelled', incomplete: false,
    plans: [{ plan_id: 'p-2' }] } as never;
  const unavailable = { observation: 'unavailable', observed_at: 5, scope: 'same_session_approved_not_dispatched',
    incomplete: true, actions: [] } as never;
  const full: RequestExecutionEvidence = { ...evidence, earlier_requests: [earlier], recorded_assistant_replies: [reply],
    successful_calls_for_current_request: [], coverage: { scope: 'selected_same_session_requests', incomplete: false },
    pending_approvals: { ...evidence.pending_approvals!, plans: [] }, cancelled_approvals: cancelled, approved_actions: unavailable };
  expect(readerRequestRecords(full)).toEqual({ current_request: request, earlier_requests: [earlier],
    cancelled_approvals: cancelled, approved_actions: unavailable });
  expect(readerRequestRecords({ ...full, coverage: { scope: 'selected_same_session_requests', incomplete: true } }))
    .toHaveProperty('coverage', { scope: 'selected_same_session_requests', incomplete: true });
  expect(readerRequestRecords({ current_request: request, successful_calls_for_current_request: [], earlier_requests: [],
    successful_actions_for_earlier_requests: [], recorded_assistant_replies: [] })).toBeUndefined();
});
