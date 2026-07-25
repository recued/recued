/** D-187 policy-matrix retirement (slice 4) — the op-risk × stage-trust APPROVAL bridge
 *  (`op-risk-admission.ts`): `resolveTrustCeiling`, `admitContractToolAccess`,
 *  `admitByOpRisk` (base → ceiling RELAX → outbound-send LIFT → AdmissionDecision).
 *
 *  This is the dedicated unit pin for the bridge the four matrix chokepoints call. The
 *  chokepoint INTEGRATION (preflight-gate / policy-gate / chat-prompt-cache / mcp-server)
 *  is covered by their own suites; this locks the pure substrate decisions:
 *    - the contract-less (`admin`) vs contracted (LOW `read`) ceiling split;
 *    - reads never-class (admit under any ceiling); writes/admin RELAX-or-ask;
 *      destructive always-ask (the floor trust can't cross);
 *    - the per-tool ACCESS allowlist deny (the wildcard-door real gate);
 *    - the user_self-scoped outbound-send lift (system + contracted exempt). */

import { describe, expect, it } from 'vitest';

import {
  CONTRACT_LESS_TRUST_CEILING,
  CONTRACTED_DEFAULT_TRUST_CEILING,
  STDIO_MCP_TOKEN_ID,
  admitByOpRisk,
  admitContractToolAccess,
  isOutboundSendSlug,
  resolveTrustCeiling,
} from '../index.js';
import type { ContractSnapshot, ExecutionSource, RiskTier } from '../index.js';

// ── Sources spanning the contract-less / contracted split ──
const USER: ExecutionSource = {
  channel: 'user',
  actor: 'user_self',
  user_id: 'u',
  client_token_id: 't',
};
const CHAT_OWNER: ExecutionSource = {
  channel: 'chat',
  actor: 'user_self',
  chat_session_id: 's',
  user_id: 'u',
};
const SCHEDULE: ExecutionSource = {
  channel: 'schedule',
  actor: 'system',
  cron: '0 9 * * *',
  source_recipe: 'r',
};
// D-209 §1.4 — a system source that KEEPS the `admin` ceiling: housekeeping (the server's
// own maintenance, outside the user-approval model; webhook doors resolve the same way).
// A `schedule`/`reactive` system source now FAILS CLOSED to `read` instead.
const HOUSEKEEPING: ExecutionSource = {
  channel: 'housekeeping',
  actor: 'system',
  cycle_id: 'cyc',
  task: 'maintenance',
  visible_to_user: false,
};
const CHAT_CONTRACTED: ExecutionSource = {
  channel: 'chat',
  actor: 'contracted_user',
  chat_session_id: 's',
  user_id: 'u',
  contract_id: 'c1',
};
// A BOUND mcp door — an inbound bearer (real `mcp_token_id` ≠ the owner sentinel) bound
// to a minted contract. Contracted LOW.
const MCP_BOUND_DOOR: ExecutionSource = {
  channel: 'mcp',
  actor: 'contracted_user',
  agent_id: 'a',
  tool_call_id: 'tc',
  mcp_token_id: 'tok-door',
  contract_id: 'c1',
};
// An UNBOUND inbound door — an inbound bearer (real `mcp_token_id`) with NO bound contract,
// so `buildMcpExecutionSource` synthesizes `contract_id = mcp_token_id`. It is STILL a
// delegated door → contracted LOW (codex slice-4 HIGH#2: must NOT get owner trust).
const MCP_UNBOUND_DOOR: ExecutionSource = {
  channel: 'mcp',
  actor: 'contracted_user',
  agent_id: 'a',
  tool_call_id: 'tc',
  mcp_token_id: 'tok-door',
  contract_id: 'tok-door',
};
// The owner's OWN stdio/CLI client — the one mcp source that lacks a bearer, so its
// `mcp_token_id` is the reserved owner sentinel. Contract-less owner `admin`.
const MCP_OWNER_STDIO: ExecutionSource = {
  channel: 'mcp',
  actor: 'contracted_user',
  agent_id: STDIO_MCP_TOKEN_ID,
  tool_call_id: 'tc',
  mcp_token_id: STDIO_MCP_TOKEN_ID,
  contract_id: STDIO_MCP_TOKEN_ID,
};
/** A self-restricted owner — `user_self` carrying a `contract_id` (D-161 N.4); it IS
 *  contracted for trust purposes. */
const SELF_RESTRICTED: ExecutionSource = {
  channel: 'user',
  actor: 'user_self',
  user_id: 'u',
  client_token_id: 't',
  contract_id: 'self',
};

const opRisk = (slug: string, risk_tier: RiskTier, source: ExecutionSource) =>
  admitByOpRisk({ slug, risk_tier, ceiling: resolveTrustCeiling(source), source });

const snapshot = (allowed_tools: readonly string[]): ContractSnapshot => ({
  contract_id: 'c1',
  contract_version: '1',
  allowed_tools,
  approval_required: [],
  scope_restrictions: [],
  resolved_at: 0,
});

describe('D-187 slice 4 — resolveTrustCeiling', () => {
  it('contract-less OWNER-DIRECT + admin-shell sources resolve the admin ceiling', () => {
    expect(CONTRACT_LESS_TRUST_CEILING).toBe('admin');
    // D-209 §1.4 — the owner acting DIRECTLY (HID / owner chat) and the admin-shell system
    // channels (webhook door / housekeeping maintenance) take `admin`. Owner AUTOMATION
    // (schedule/reactive) no longer does — it fails closed below.
    for (const s of [USER, CHAT_OWNER, HOUSEKEEPING]) {
      expect(resolveTrustCeiling(s)).toBe('admin');
    }
  });

  it('a contract-less system SCHEDULE/REACTIVE source fails closed to the LOW read ceiling (D-209 §1.4 — unattended owner automation HOLDS its writes for review)', () => {
    expect(resolveTrustCeiling(SCHEDULE)).toBe('read');
  });

  it('contracted sources (bound + UNBOUND mcp doors + a self-restricted user_self) resolve the LOW default', () => {
    expect(CONTRACTED_DEFAULT_TRUST_CEILING).toBe('read');
    // MCP_UNBOUND_DOOR is the codex slice-4 HIGH#2 regression case: a delegated inbound
    // door with no bound contract must STILL be LOW (not owner-admin).
    for (const s of [CHAT_CONTRACTED, MCP_BOUND_DOOR, MCP_UNBOUND_DOOR, SELF_RESTRICTED]) {
      expect(resolveTrustCeiling(s)).toBe('read');
    }
  });

  it('the owner stdio/CLI mcp client (mcp_token_id === STDIO_MCP_TOKEN_ID) resolves the contract-less admin ceiling', () => {
    // Only the owner's OWN client lacks a bearer → the reserved owner-token sentinel. It
    // must NOT be forced LOW like a delegated door; its writes admit. Source-derived, so
    // every mcp path (direct + recipe + raw-op) agrees.
    expect(resolveTrustCeiling(MCP_OWNER_STDIO)).toBe('admin');
    expect(opRisk('some-writer', 'write', MCP_OWNER_STDIO).verdict).toBe('admit');
  });
});

describe('D-187 slice 4 — admitByOpRisk op-risk × stage-trust', () => {
  it('a read admits under EVERY source (never-class — the ceiling cannot escalate it)', () => {
    for (const s of [USER, SCHEDULE, CHAT_CONTRACTED, MCP_BOUND_DOOR, MCP_UNBOUND_DOOR, MCP_OWNER_STDIO, SELF_RESTRICTED]) {
      expect(opRisk('some-reader', 'read', s).verdict).toBe('admit');
    }
  });

  it('a write/admin op ADMITS at the admin ceiling (owner-direct / admin-shell) but ASKS at the LOW ceiling (automation / contracted)', () => {
    // Owner-direct + admin-shell → admin ceiling → write + admin run silent.
    expect(opRisk('data-annotate', 'write', USER).verdict).toBe('admit');
    expect(opRisk('admin-op', 'admin', USER).verdict).toBe('admit');
    expect(opRisk('admin-op', 'admin', HOUSEKEEPING).verdict).toBe('admit');
    // D-209 §1.4 — unattended owner AUTOMATION (schedule/reactive) now fails closed to the
    // LOW ceiling → its write + admin ops SURFACE for review (silence earned via the D-177
    // learner, never by default).
    expect(opRisk('data-annotate', 'write', SCHEDULE).verdict).toBe('ask');
    expect(opRisk('admin-op', 'admin', SCHEDULE).verdict).toBe('ask');
    // Contracted → LOW ceiling → write + admin SURFACE (ask). This is "AI writes surface".
    expect(opRisk('data-annotate', 'write', CHAT_CONTRACTED).verdict).toBe('ask');
    expect(opRisk('admin-op', 'admin', MCP_BOUND_DOOR).verdict).toBe('ask');
    expect(opRisk('data-annotate', 'write', MCP_UNBOUND_DOOR).verdict).toBe('ask');
    expect(opRisk('data-annotate', 'write', SELF_RESTRICTED).verdict).toBe('ask');
  });

  it('a destructive op ALWAYS asks — the always-floor, even at the admin ceiling', () => {
    for (const s of [USER, SCHEDULE, CHAT_CONTRACTED, MCP_BOUND_DOOR, MCP_OWNER_STDIO]) {
      const d = opRisk('nuke', 'destructive', s);
      expect(d.verdict).toBe('ask');
      if (d.verdict === 'ask') expect(d.risk_tier).toBe('destructive');
    }
  });

  it('an ask carries the effective_risk_tier verbatim (audit-honest, not reclassified)', () => {
    const d = opRisk('data-annotate', 'write', MCP_BOUND_DOOR);
    expect(d.verdict).toBe('ask');
    if (d.verdict === 'ask') expect(d.risk_tier).toBe('write');
  });
});

describe('D-187 slice 4 — outbound-send LIFT (user_self-scoped)', () => {
  it('lifts an outbound send to ask at a contract-less user_self cell (admin ceiling would otherwise admit)', () => {
    // mail-send is `write`; at the admin ceiling it would relax to admit — the lift
    // re-raises it so the send surfaces for approval (the user reviews the recipient).
    const d = opRisk('mail-send', 'write', USER);
    expect(d.verdict).toBe('ask');
    if (d.verdict === 'ask') {
      expect(d.risk_tier).toBe('write');
      expect(d.detail).toContain('mail-send');
    }
  });

  it('does NOT lift an outbound send for a system actor — the lift is user_self-scoped (a system source at the admin ceiling admits)', () => {
    // The outbound-send LIFT fires only for `user_self`. A system source at the admin
    // ceiling (housekeeping / webhook door) therefore admits the send — the lift never
    // raises it.
    expect(opRisk('mail-send', 'write', HOUSEKEEPING).verdict).toBe('admit');
    // D-209 §1.4 — a `schedule`/`reactive` system source now holds the send via the LOW
    // CEILING (write > read), NOT the lift. Same surfaced outcome, different mechanism.
    expect(opRisk('mail-send', 'write', SCHEDULE).verdict).toBe('ask');
  });

  it('does NOT separately lift for a contracted actor — the LOW ceiling already surfaces the write', () => {
    // It asks, but via the ceiling (write > read), NOT the user_self-scoped lift.
    expect(opRisk('mail-send', 'write', MCP_BOUND_DOOR).verdict).toBe('ask');
  });

  it('does NOT lift a non-send internal write at user_self (admin ceiling admits it)', () => {
    expect(opRisk('data-annotate', 'write', USER).verdict).toBe('admit');
  });

  it('isOutboundSendSlug covers the closed set + the core- kernel alias, not internal writes', () => {
    expect(isOutboundSendSlug('mail-send')).toBe(true);
    expect(isOutboundSendSlug('connection-mcp-write')).toBe(true);
    expect(isOutboundSendSlug('core-slack-post')).toBe(true);
    expect(isOutboundSendSlug('connection-mcp-read')).toBe(false);
    expect(isOutboundSendSlug('data-annotate')).toBe(false);
  });
});

describe('D-187 slice 4 — admitContractToolAccess (the per-tool allowlist, wildcard-door gate)', () => {
  it('contract-free (no snapshot) is ungated — returns null', () => {
    expect(admitContractToolAccess(null, 'anything')).toBeNull();
    expect(admitContractToolAccess(undefined, 'anything')).toBeNull();
  });

  it('a granted tool returns null; an un-granted tool denies tool_not_in_contract', () => {
    const snap = snapshot(['mail-send']);
    expect(admitContractToolAccess(snap, 'mail-send')).toBeNull();
    const deny = admitContractToolAccess(snap, 'data-file-read');
    expect(deny).not.toBeNull();
    if (deny && deny.verdict === 'deny') {
      expect(deny.code).toBe('tool_not_in_contract');
      expect(deny.detail).toContain('data-file-read');
    }
  });
});

// ════════════════════════════════════════════════════════════════
// D-207 slice 1 — the ANONYMOUS floor
// ════════════════════════════════════════════════════════════════

/** The public reception visitor. Carries NO `contract_id` (the `(reception,
 *  anonymous)` ExecutionSource variant has no such field), which is exactly why
 *  `executionSourceHasContract` used to read it as contract-less → OWNER `admin`.
 *  This is the source `paid-document-direct-checkout-stripe-provider.ts:109`
 *  actually constructs and dispatches a Stripe `write` op with. */
const RECEPTION_ANON: ExecutionSource = {
  channel: 'reception',
  actor: 'anonymous',
  reception_id: 'sub_1',
};

describe('D-207 slice 1 — an anonymous reception visitor can never take the owner ceiling', () => {
  it('resolveTrustCeiling pins `anonymous` to the CONTRACTED LOW ceiling, not contract-less admin', () => {
    // The regression: absence of a contract_id means "not yet bound to a door",
    // NOT "the owner". Pre-fix this returned CONTRACT_LESS_TRUST_CEILING ('admin').
    expect(resolveTrustCeiling(RECEPTION_ANON)).toBe(CONTRACTED_DEFAULT_TRUST_CEILING);
    expect(resolveTrustCeiling(RECEPTION_ANON)).not.toBe(CONTRACT_LESS_TRUST_CEILING);
  });

  it('a write op from an anonymous visitor SURFACES (ask) instead of relaxing to admit', () => {
    const decision = admitByOpRisk({
      slug: 'http-request',
      risk_tier: 'write' satisfies RiskTier,
      ceiling: resolveTrustCeiling(RECEPTION_ANON),
      source: RECEPTION_ANON,
    });
    // Pre-fix: ceiling 'admin' RELAXED this write to `admit` — silent, no owner ask.
    expect(decision.verdict).not.toBe('admit');
  });

  it('an admin-tier op from an anonymous visitor also surfaces', () => {
    const decision = admitByOpRisk({
      slug: 'http-request',
      risk_tier: 'admin' satisfies RiskTier,
      ceiling: resolveTrustCeiling(RECEPTION_ANON),
      source: RECEPTION_ANON,
    });
    expect(decision.verdict).not.toBe('admit');
  });

  it('reads still admit — the floor governs write+ only, never over-tightening', () => {
    const decision = admitByOpRisk({
      slug: 'http-request',
      risk_tier: 'read' satisfies RiskTier,
      ceiling: resolveTrustCeiling(RECEPTION_ANON),
      source: RECEPTION_ANON,
    });
    expect(decision.verdict).toBe('admit');
  });

  it('the outbound-send backstop does not save us — it is scoped to user_self, so the CEILING must', () => {
    // `liftOutboundSend` returns early on `source.actor !== 'user_self'`. So for an
    // anonymous visitor an outbound send is protected ONLY by the trust ceiling. If the
    // ceiling ever regresses to 'admin', this send goes out silently.
    expect(isOutboundSendSlug('mail-send')).toBe(true);
    const decision = admitByOpRisk({
      slug: 'mail-send',
      risk_tier: 'write' satisfies RiskTier,
      ceiling: resolveTrustCeiling(RECEPTION_ANON),
      source: RECEPTION_ANON,
    });
    expect(decision.verdict).not.toBe('admit');
  });

  it('the owner is unaffected — a contract-less owner dispatch keeps the admin ceiling', () => {
    expect(resolveTrustCeiling(USER)).toBe(CONTRACT_LESS_TRUST_CEILING);
    expect(resolveTrustCeiling(CHAT_OWNER)).toBe(CONTRACT_LESS_TRUST_CEILING);
  });
});
