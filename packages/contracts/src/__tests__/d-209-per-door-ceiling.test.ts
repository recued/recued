/** D-209 #1 — the PER-DOOR stage-trust ceiling.
 *
 *  `ContractSnapshot` gained an optional authored `max_risk_without_approval`,
 *  and `resolveTrustCeiling` reads it in preference to the flat
 *  `CONTRACTED_DEFAULT_TRUST_CEILING` — but ONLY when the snapshot is the
 *  source's OWN door (contract_id match), and NEVER for an `anonymous`
 *  (human-facing reception) source: the rev-5 F3 rule — raising the ceiling
 *  turns a qualifying `ask` straight into `admit`, skipping the taint check,
 *  so a public form's trust is pinned by the READER, not by mint convention. */

import { describe, expect, it } from 'vitest';

import {
  CONTRACTED_DEFAULT_TRUST_CEILING,
  CONTRACT_LESS_TRUST_CEILING,
  STDIO_MCP_TOKEN_ID,
  isContractSnapshot,
  resolveTrustCeiling,
} from '../index.js';
import type { ContractSnapshot, ExecutionSource } from '../index.js';

const CHAT_CONTRACTED: ExecutionSource = {
  channel: 'chat',
  actor: 'contracted_user',
  chat_session_id: 's',
  user_id: 'u',
  contract_id: 'c1',
};

const MCP_BOUND_DOOR: ExecutionSource = {
  channel: 'mcp',
  actor: 'contracted_user',
  agent_id: 'a',
  tool_call_id: 'tc',
  mcp_token_id: 'tok-door',
  contract_id: 'c1',
};

const MCP_OWNER_STDIO: ExecutionSource = {
  channel: 'mcp',
  actor: 'contracted_user',
  agent_id: STDIO_MCP_TOKEN_ID,
  tool_call_id: 'tc',
  mcp_token_id: STDIO_MCP_TOKEN_ID,
  contract_id: STDIO_MCP_TOKEN_ID,
};

const RECEPTION_ANON: ExecutionSource = {
  channel: 'reception',
  actor: 'anonymous',
  reception_id: 'ep-1',
  contract_id: 'door-1',
};

const snapshotFor = (
  contract_id: string,
  ceiling?: ContractSnapshot['max_risk_without_approval'],
): ContractSnapshot => ({
  contract_id,
  contract_version: 'v1',
  allowed_tools: ['pub/cat'],
  approval_required: [],
  scope_restrictions: [],
  resolved_at: 1_000,
  ...(ceiling === undefined ? {} : { max_risk_without_approval: ceiling }),
});

describe('D-209 #1 — resolveTrustCeiling reads the door snapshot ceiling', () => {
  // Non-vacuity: the raised value must actually DIFFER from the default this
  // suite claims to override.
  it('the fixture raise is a real raise', () => {
    expect(CONTRACTED_DEFAULT_TRUST_CEILING).toBe('read');
    expect(CONTRACT_LESS_TRUST_CEILING).toBe('admin');
  });

  // ⛔ THE D-209 #1 AMENDMENT (owner-ratified 2026-07-17) — INVERTED from D-209 #1,
  // deliberately. This test previously asserted the OPPOSITE ("a contracted dispatch
  // takes its own door's authored ceiling" → admin / write / admin). The amendment
  // narrows the authored ceiling to the `(webhook, anonymous)` carve-out ALONE: every
  // door reached here has
  // a MODEL in the decision loop, and a raised ceiling there skips the taint check and
  // reduces to "let attacker-influenced text write silently". The W3 describe-block
  // below is the ONLY door that still raises — it is the negative pin for this one.
  //
  // Behaviour-preserving when it landed: nothing AUTHORED a ceiling on a contracted
  // door (`mint-door-contract.ts` profiles = reception[none] + webhook['admin'] only;
  // no UI authoring path; the llm_gateway snapshot builder never read the field). This
  // pin closes the trapdoor BEFORE a producer exists, not after.
  it('⛔ a contracted (model-door) dispatch is PINNED — its own door cannot raise it', () => {
    expect(resolveTrustCeiling(CHAT_CONTRACTED, snapshotFor('c1', 'admin')))
      .toBe(CONTRACTED_DEFAULT_TRUST_CEILING);
    expect(resolveTrustCeiling(CHAT_CONTRACTED, snapshotFor('c1', 'write')))
      .toBe(CONTRACTED_DEFAULT_TRUST_CEILING);
    // The mcp TOOLS door: a tool call is not prose, but its CALLER is an agent — the
    // decision to call was a model's. Same pin, same reason (owner: "the logic is
    // universal"). Its friction relief is the SEEDED `(mcp, contracted_user)` session
    // grant — bounded by TTL + uses + tier — never an unbounded authored ceiling.
    expect(resolveTrustCeiling(MCP_BOUND_DOOR, snapshotFor('c1', 'admin')))
      .toBe(CONTRACTED_DEFAULT_TRUST_CEILING);
  });

  it('a snapshot for ANOTHER contract never raises this dispatch', () => {
    expect(resolveTrustCeiling(CHAT_CONTRACTED, snapshotFor('other', 'admin')))
      .toBe(CONTRACTED_DEFAULT_TRUST_CEILING);
    expect(resolveTrustCeiling(MCP_BOUND_DOOR, snapshotFor('tok-door', 'admin')))
      .toBe(CONTRACTED_DEFAULT_TRUST_CEILING);
  });

  it('a snapshot without the field keeps the flat contracted default', () => {
    expect(resolveTrustCeiling(CHAT_CONTRACTED, snapshotFor('c1')))
      .toBe(CONTRACTED_DEFAULT_TRUST_CEILING);
    expect(resolveTrustCeiling(CHAT_CONTRACTED))
      .toBe(CONTRACTED_DEFAULT_TRUST_CEILING);
  });

  it('⛔ an anonymous (reception) source is PINNED — even its own door cannot raise it', () => {
    // The F3 rule: a raised ceiling skips the taint check, and a public form's
    // inputs are exactly the prompt-injection surface that check exists for.
    expect(resolveTrustCeiling(RECEPTION_ANON, snapshotFor('door-1', 'admin')))
      .toBe(CONTRACTED_DEFAULT_TRUST_CEILING);
    expect(resolveTrustCeiling(RECEPTION_ANON, snapshotFor('door-1', 'write')))
      .toBe(CONTRACTED_DEFAULT_TRUST_CEILING);
  });

  describe('W3 — the (webhook, anonymous) door carve-out', () => {
    const WEBHOOK_DOOR: ExecutionSource = {
      channel: 'webhook',
      actor: 'anonymous',
      vendor: 'hubspot',
      webhook_secret_id: 'ing-1',
      contract_id: 'door-wh',
    };

    it('a webhook dispatch takes its own door\'s authored ceiling (two-sided enrollment IS the approval)', () => {
      expect(resolveTrustCeiling(WEBHOOK_DOOR, snapshotFor('door-wh', 'admin')))
        .toBe('admin');
    });

    it('fails closed without the door: no snapshot / mismatched door / unstamped source → LOW', () => {
      expect(resolveTrustCeiling(WEBHOOK_DOOR))
        .toBe(CONTRACTED_DEFAULT_TRUST_CEILING);
      expect(resolveTrustCeiling(WEBHOOK_DOOR, snapshotFor('other-door', 'admin')))
        .toBe(CONTRACTED_DEFAULT_TRUST_CEILING);
      const doorless: ExecutionSource = {
        channel: 'webhook',
        actor: 'anonymous',
        vendor: 'hubspot',
        webhook_secret_id: 'ing-1',
      };
      expect(resolveTrustCeiling(doorless, snapshotFor('door-wh', 'admin')))
        .toBe(CONTRACTED_DEFAULT_TRUST_CEILING);
    });

    it('⛔ the flat webhook→admin interim branch is DEAD: only the door raises a webhook dispatch', () => {
      // A dead/unminted door leaves the snapshot ceiling absent → LOW; nothing
      // about the CHANNEL alone confers admin any more.
      expect(resolveTrustCeiling(WEBHOOK_DOOR, snapshotFor('door-wh')))
        .toBe(CONTRACTED_DEFAULT_TRUST_CEILING);
    });
  });

  it('the owner stdio client stays contract-less admin, snapshot or not', () => {
    expect(resolveTrustCeiling(MCP_OWNER_STDIO, snapshotFor(STDIO_MCP_TOKEN_ID, 'read')))
      .toBe(CONTRACT_LESS_TRUST_CEILING);
  });
});

describe('D-209 #1 — isContractSnapshot admits the optional ceiling field', () => {
  it('accepts every TrustCeiling value and absence', () => {
    expect(isContractSnapshot(snapshotFor('c1'))).toBe(true);
    for (const ceiling of ['none', 'read', 'write', 'admin'] as const) {
      expect(isContractSnapshot(snapshotFor('c1', ceiling))).toBe(true);
    }
  });

  it('rejects a value outside the ceiling vocabulary', () => {
    for (const bad of ['destructive', '', 1, null, {}]) {
      expect(isContractSnapshot({
        ...snapshotFor('c1'),
        max_risk_without_approval: bad,
      })).toBe(false);
    }
  });
});
