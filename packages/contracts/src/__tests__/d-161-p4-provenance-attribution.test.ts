/** D-161 Part B (P4) — provenance-honesty attribution contracts.
 *
 *  Covers the pure derivation in `provenance-attribution.ts`:
 *    - `renderProvenanceAttribution` — first-person (`user_self` / `system`
 *      / unstamped) → `undefined`; `anonymous` → a fixed visitor marker;
 *      `contracted_user` → an attributed agent assertion, with the label
 *      degrading gracefully as agent id / contract id are missing.
 *    - `agentIdFromSource` — only the `'mcp'` channel names "agent X".
 *    - `provenanceAttributionFromSource` — the rich convenience over an
 *      `ExecutionSource` + the commit's `contract_snapshot` (O-3: render,
 *      not store; the snapshot supplies the contract version).
 *    - `isProvenanceAttribution` — coherent `(kind, origin_actor)` narrowing.
 *
 *  Spec: D-161 § N.8 / A.7 / I-9 / I-10 / O-3.
 */

import { describe, expect, it } from 'vitest';

import {
  agentIdFromSource,
  isProvenanceAttribution,
  provenanceAttributionFromSource,
  renderProvenanceAttribution,
  type ContractSnapshot,
  type ExecutionSource,
  type ProvenanceAttribution,
} from '../index.js';

// ── fixtures ────────────────────────────────────────────────────
const MCP_AGENT: ExecutionSource = {
  channel: 'mcp',
  actor: 'contracted_user',
  agent_id: 'agent-7',
  tool_call_id: 'tc-1',
  mcp_token_id: 'mt-1',
  contract_id: 'contract-42',
};
const CHAT_AGENT: ExecutionSource = {
  channel: 'chat',
  actor: 'contracted_user',
  chat_session_id: 'cs-1',
  user_id: 'u1',
  contract_id: 'contract-99',
};
const RECEPTION_ANON: ExecutionSource = {
  channel: 'reception',
  actor: 'anonymous',
  reception_id: 'rcp-1',
};
const USER_SELF: ExecutionSource = {
  channel: 'user',
  actor: 'user_self',
  user_id: 'u1',
  client_token_id: 'ct-1',
};
const SYSTEM_CRON: ExecutionSource = {
  channel: 'schedule',
  actor: 'system',
  cron: '0 * * * *',
  source_recipe: 'r',
};

const SNAPSHOT: ContractSnapshot = {
  contract_id: 'contract-42',
  contract_version: 'v3',
  allowed_tools: ['mail-send'],
  approval_required: ['high'],
  scope_restrictions: ['data.mail'],
  resolved_at: 1_700_000_000_000,
};

// ────────────────────────────────────────────────────────────────
describe('D-161 P4 — renderProvenanceAttribution (first-person → undefined)', () => {
  it('user_self → undefined (the user, first-person; I-9 / I-10)', () => {
    expect(renderProvenanceAttribution({ origin_actor: 'user_self' })).toBeUndefined();
  });

  it('system → undefined (engine-internal, folded into the user feed)', () => {
    expect(renderProvenanceAttribution({ origin_actor: 'system' })).toBeUndefined();
  });

  it('undefined origin_actor → undefined (unstamped / pruned → system → first-person)', () => {
    expect(renderProvenanceAttribution({ origin_actor: undefined })).toBeUndefined();
  });

  it('a contract_id on a first-person row never conjures an attribution', () => {
    // Self-restricted user_self carries a contract_id but is still the
    // user's own — it must NOT become an "agent" attribution.
    expect(
      renderProvenanceAttribution({ origin_actor: 'user_self', contract_id: 'self-c' }),
    ).toBeUndefined();
  });
});

describe('D-161 P4 — renderProvenanceAttribution (anonymous → visitor)', () => {
  it('anonymous with no channel → the channel-NEUTRAL marker (claims nothing it cannot know)', () => {
    // D-209 #1 W3 — `anonymous` now spans two channels (reception + webhook), so a
    // column-only read (no channel) must not name either. The channel-aware
    // phrasings are rendered only when the read path supplies the channel.
    const a = renderProvenanceAttribution({ origin_actor: 'anonymous' });
    expect(a).toEqual({
      kind: 'visitor',
      origin_actor: 'anonymous',
      label: 'visitor-derived (anonymous)',
    });
  });

  it('anonymous + reception channel → the visitor phrasing', () => {
    const a = renderProvenanceAttribution({ origin_actor: 'anonymous', channel: 'reception' });
    expect(a?.label).toBe('visitor-derived (anonymous reception)');
  });

  it('anonymous + webhook channel → the vendor-event phrasing (D-209 #1 W3)', () => {
    const a = renderProvenanceAttribution({ origin_actor: 'anonymous', channel: 'webhook' });
    expect(a).toEqual({
      kind: 'visitor',
      origin_actor: 'anonymous',
      label: 'vendor-event-derived (anonymous webhook)',
    });
  });

  it('ignores any contract_id / agent_id on a visitor (anonymous is contract-less)', () => {
    const a = renderProvenanceAttribution({
      origin_actor: 'anonymous',
      contract_id: 'should-be-ignored',
      agent_id: 'should-be-ignored',
    });
    expect(a?.kind).toBe('visitor');
    expect(a?.contract_id).toBeUndefined();
    expect(a?.agent_id).toBeUndefined();
  });
});

describe('D-161 P4 — renderProvenanceAttribution (contracted_user → agent)', () => {
  it('full identity → "agent X, under contract Y, asserted this"', () => {
    const a = renderProvenanceAttribution({
      origin_actor: 'contracted_user',
      agent_id: 'agent-7',
      contract_id: 'contract-42',
      contract_version: 'v3',
    });
    expect(a).toEqual({
      kind: 'agent',
      origin_actor: 'contracted_user',
      agent_id: 'agent-7',
      contract_id: 'contract-42',
      contract_version: 'v3',
      label: 'agent agent-7, under contract contract-42, asserted this',
    });
  });

  it('agent_id only (no contract) → "agent X asserted this", no contract fields', () => {
    const a = renderProvenanceAttribution({
      origin_actor: 'contracted_user',
      agent_id: 'agent-7',
    });
    expect(a?.label).toBe('agent agent-7 asserted this');
    expect(a?.contract_id).toBeUndefined();
    expect(a?.contract_version).toBeUndefined();
  });

  it('contract only (no agent id) → "an agent, under contract Y, asserted this"', () => {
    const a = renderProvenanceAttribution({
      origin_actor: 'contracted_user',
      contract_id: 'contract-42',
    });
    expect(a?.label).toBe('an agent, under contract contract-42, asserted this');
    expect(a?.agent_id).toBeUndefined();
    expect(a?.contract_id).toBe('contract-42');
  });

  it('neither agent id nor contract → "an agent asserted this"', () => {
    const a = renderProvenanceAttribution({ origin_actor: 'contracted_user' });
    expect(a).toEqual({
      kind: 'agent',
      origin_actor: 'contracted_user',
      label: 'an agent asserted this',
    });
  });
});

describe('D-161 P4 — agentIdFromSource', () => {
  it('returns the MCP agent_id (the canonical "agent X")', () => {
    expect(agentIdFromSource(MCP_AGENT)).toBe('agent-7');
  });

  it('returns undefined for a contracted_user on a non-mcp channel', () => {
    expect(agentIdFromSource(CHAT_AGENT)).toBeUndefined();
    expect(
      agentIdFromSource({
        channel: 'messenger',
        actor: 'contracted_user',
        vendor: 'slack',
        from: 'bot',
        contract_id: 'c',
      }),
    ).toBeUndefined();
  });

  it('returns undefined for first-person + anonymous sources', () => {
    expect(agentIdFromSource(USER_SELF)).toBeUndefined();
    expect(agentIdFromSource(SYSTEM_CRON)).toBeUndefined();
    expect(agentIdFromSource(RECEPTION_ANON)).toBeUndefined();
  });
});

describe('D-161 P4 — provenanceAttributionFromSource (source + contract_snapshot)', () => {
  it('undefined source → undefined (sync / pruned → first-person, coherent with origin_actor)', () => {
    expect(provenanceAttributionFromSource(undefined)).toBeUndefined();
    expect(provenanceAttributionFromSource(undefined, SNAPSHOT)).toBeUndefined();
  });

  it('first-person sources → undefined', () => {
    expect(provenanceAttributionFromSource(USER_SELF)).toBeUndefined();
    expect(provenanceAttributionFromSource(SYSTEM_CRON)).toBeUndefined();
  });

  it('mcp agent + snapshot → agent id from source, contract version from the snapshot (O-3)', () => {
    const a = provenanceAttributionFromSource(MCP_AGENT, SNAPSHOT);
    expect(a).toEqual({
      kind: 'agent',
      origin_actor: 'contracted_user',
      agent_id: 'agent-7',
      contract_id: 'contract-42',
      contract_version: 'v3',
      label: 'agent agent-7, under contract contract-42, asserted this',
    });
  });

  it('mcp agent without a snapshot → contract id from source, no version', () => {
    const a = provenanceAttributionFromSource(MCP_AGENT);
    expect(a?.agent_id).toBe('agent-7');
    expect(a?.contract_id).toBe('contract-42');
    expect(a?.contract_version).toBeUndefined();
  });

  it('chat contracted_user (no agent id) → contract from source, label names the contract alone', () => {
    const a = provenanceAttributionFromSource(CHAT_AGENT);
    expect(a?.kind).toBe('agent');
    expect(a?.agent_id).toBeUndefined();
    expect(a?.contract_id).toBe('contract-99');
    expect(a?.label).toBe('an agent, under contract contract-99, asserted this');
  });

  it('anonymous reception source → visitor', () => {
    expect(provenanceAttributionFromSource(RECEPTION_ANON)).toEqual({
      kind: 'visitor',
      origin_actor: 'anonymous',
      label: 'visitor-derived (anonymous reception)',
    });
  });

  it('anonymous webhook source → vendor-event-derived; the door contract_id never relabels it (D-209 #1 W3)', () => {
    expect(provenanceAttributionFromSource({
      channel: 'webhook',
      actor: 'anonymous',
      vendor: 'hubspot',
      webhook_secret_id: 'ing-1',
      contract_id: 'door-wh',
    })).toEqual({
      kind: 'visitor',
      origin_actor: 'anonymous',
      // The door is the OWNER's dispatch authority, not the vendor's identity —
      // the anonymous label never interpolates it.
      label: 'vendor-event-derived (anonymous webhook)',
    });
  });

  it('a snapshot for a DIFFERENT contract than the source neither relabels nor versions', () => {
    // The source is the sole truth for contract_id; the snapshot version is
    // attached only when it is a snapshot of THAT contract (provenance
    // honesty — a version from a divergent contract would mislabel the row).
    const divergent: ContractSnapshot = { ...SNAPSHOT, contract_id: 'contract-OTHER' };
    const a = provenanceAttributionFromSource(MCP_AGENT, divergent);
    expect(a?.contract_id).toBe('contract-42'); // the SOURCE's contract
    expect(a?.contract_version).toBeUndefined(); // snapshot is for another contract
  });
});

describe('D-161 P4 — isProvenanceAttribution', () => {
  const AGENT: ProvenanceAttribution = {
    kind: 'agent',
    origin_actor: 'contracted_user',
    agent_id: 'a',
    contract_id: 'c',
    contract_version: 'v1',
    label: 'agent a, under contract c, asserted this',
  };
  const VISITOR: ProvenanceAttribution = {
    kind: 'visitor',
    origin_actor: 'anonymous',
    label: 'visitor-derived (anonymous reception)',
  };

  it('accepts a well-formed agent + visitor', () => {
    expect(isProvenanceAttribution(AGENT)).toBe(true);
    expect(isProvenanceAttribution(VISITOR)).toBe(true);
    expect(isProvenanceAttribution({ kind: 'agent', origin_actor: 'contracted_user', label: 'x' })).toBe(true);
  });

  it('rejects non-objects + missing label', () => {
    expect(isProvenanceAttribution(null)).toBe(false);
    expect(isProvenanceAttribution('agent')).toBe(false);
    expect(isProvenanceAttribution([])).toBe(false);
    expect(isProvenanceAttribution({ kind: 'agent', origin_actor: 'contracted_user' })).toBe(false);
  });

  it('rejects an unknown kind or a first-person origin_actor', () => {
    expect(isProvenanceAttribution({ kind: 'user', origin_actor: 'contracted_user', label: 'x' })).toBe(false);
    expect(isProvenanceAttribution({ kind: 'agent', origin_actor: 'user_self', label: 'x' })).toBe(false);
    expect(isProvenanceAttribution({ kind: 'agent', origin_actor: 'system', label: 'x' })).toBe(false);
  });

  it('rejects an incoherent (kind, origin_actor) pairing', () => {
    expect(isProvenanceAttribution({ kind: 'agent', origin_actor: 'anonymous', label: 'x' })).toBe(false);
    expect(isProvenanceAttribution({ kind: 'visitor', origin_actor: 'contracted_user', label: 'x' })).toBe(false);
  });

  it('rejects non-string identity fields', () => {
    expect(isProvenanceAttribution({ ...AGENT, agent_id: 42 })).toBe(false);
    expect(isProvenanceAttribution({ ...AGENT, contract_id: {} })).toBe(false);
    expect(isProvenanceAttribution({ ...AGENT, contract_version: [] })).toBe(false);
  });
});
