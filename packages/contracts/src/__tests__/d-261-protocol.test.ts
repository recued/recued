import { describe, expect, it } from 'vitest';
import {
  parsePreparePreapproval, parsePreapprovalDecision, parsePreapprovalSelection,
  parsePreapprovalJson, parsePreapprovalList,
} from '../preapproval.js';
import { isReservedLocalRpc } from '../mcp-tool-catalog.js';

const request = () => ({ idempotency_key: 'request-1', subject: {
  kind: 'recipe', recipe_id: 'send-composed-mail', publisher_id: 'core', config: { to: ['alex@example.com'] },
}, activation: { kind: 'one_shot', run_at: 10_000, time_zone: 'America/Los_Angeles' },
decision_deadline: 9_000, dispatch_deadline: 15_000 });
const proposal_id = 'pap_11111111-1111-4111-8111-111111111111';

describe('D-261 closed public protocol', () => {
  it('parses concrete preparation without an authority input', () => {
    expect(parsePreparePreapproval(request())).toEqual(request());
    for (const key of ['approved', 'origin', 'contract_id', 'grant_id', 'approver', 'callback', 'members']) {
      expect(() => parsePreparePreapproval({ ...request(), [key]: true })).toThrow();
    }
  });
  it('rejects invalid timing, timezone, nested fields, and unresolved JSON', () => {
    expect(() => parsePreparePreapproval({ ...request(), decision_deadline: 11_000 })).toThrow();
    expect(() => parsePreparePreapproval({ ...request(), activation: { ...request().activation, time_zone: 'invalid/zone' } })).toThrow();
    expect(() => parsePreparePreapproval({ ...request(), subject: { ...request().subject, approved: true } })).toThrow();
    for (const value of [NaN, Infinity, undefined, () => true, new Date(), JSON.parse('{"__proto__":{"approved":true}}')]) {
      expect(() => parsePreapprovalJson(value)).toThrow();
    }
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
    expect(() => parsePreapprovalJson(cyclic)).toThrow();
  });
  it('requires a complete owner challenge response and server-issued selection IDs', () => {
    const decision = { proposal_id, expected_revision: 1, review_digest: `sha256:${'a'.repeat(64)}`,
      challenge: 'a'.repeat(43), decision: 'approve', request_id: 'response-1' };
    expect(parsePreapprovalDecision(decision).decision).toBe('approve');
    expect(() => parsePreapprovalDecision({ ...decision, responder: 'owner' })).toThrow();
    expect(() => parsePreapprovalDecision({ ...decision, decision: 'yes' })).toThrow();
    expect(() => parsePreapprovalDecision({ ...decision, challenge: 'ask-id' })).toThrow();
    expect(() => parsePreapprovalSelection({ proposal_id, expected_revision: 1, member_ids: ['mail.send'] })).toThrow();
    expect(() => parsePreapprovalList({ limit: 1000 })).toThrow();
    expect(() => parsePreapprovalList({ cursor: 'arbitrary-sql' })).toThrow();
  });
  it('reserves every owner method, including future verbs, from MCP', () => {
    for (const verb of ['prepare', 'review', 'decide', 'select', 'revoke', 'list', 'get', 'capabilities', 'future_verb']) {
      expect(isReservedLocalRpc(`preapproval.${verb}`)).toBe(true);
    }
  });
});
