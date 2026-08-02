/** D-149 P3 contracts ratchet — Public Reception registry + source-query
 *  allowlist + rate-limit substrate + rpc method-name closed list.
 *
 *  Acceptance per spec § A.3 + § Contract Tightening + § Must Hold I-3
 *  / I-10 / I-15:
 *
 *    - `RECEPTION_RPC_METHODS` matches the landed reserved method list.
 *    - Every rpc method appears in the `ServerRpcRegistry`-side
 *      `SERVER_RPC_METHODS` closed list (compile-time ratchet sanity).
 *    - `RECEPTION_HIGH_ASSURANCE_AUDIT_KINDS` is a subset of
 *      `HIGH_ASSURANCE_AUDIT_KINDS` so the audit-signing wrapper auto-
 *      signs every reception kind.
 *    - `SOURCE_QUERY_KINDS_PERMITTED_PER_PACKET_KIND` covers every
 *      reception packet kind + rejects the bare-string + vault-escape
 *      paths.
 *    - `RECEPTION_RATE_LIMIT_DEFAULTS` honors the per-kind windows the
 *      spec table mandates.
 *    - `RECEPTION_PER_KIND_EXPIRY_MAX_MS` matches the § N.4 closed list.
 *    - `MCP_RESERVED_RPC_PREFIXES` carries `reception.` (channel
 *      isolation — external AI agents must never drive the registry).
 *
 *  Test wiring per `feedback_grammar_consistency.md`: every assertion
 *  asserts a contract invariant the rpc handler downstream relies on.
 */

import { describe, expect, it } from 'vitest';
import {
  HIGH_ASSURANCE_AUDIT_KINDS,
  MCP_RESERVED_RPC_PREFIXES,
  RECEPTION_ACCESS_ACTIONS,
  RECEPTION_ACCESS_ACTION_SET,
  RECEPTION_ACCESS_OUTCOMES,
  RECEPTION_ACCESS_OUTCOME_SET,
  RECEPTION_ENDPOINT_KINDS,
  RECEPTION_ENDPOINT_KIND_TO_PACKET_KIND,
  RECEPTION_HIGH_ASSURANCE_AUDIT_KINDS,
  RECEPTION_PER_KIND_EXPIRY_MAX_MS,
  RECEPTION_RATE_BUCKET_KINDS,
  RECEPTION_RATE_LIMIT_DEFAULTS,
  RECEPTION_RPC_ERROR_CODES,
  RECEPTION_RPC_ERROR_CODE_SET,
  RECEPTION_RPC_METHODS,
  RECEPTION_RPC_METHOD_SET,
  SERVER_RPC_METHOD_SET,
  SOURCE_QUERY_KINDS,
  SOURCE_QUERY_KINDS_PERMITTED_PER_PACKET_KIND,
  SOURCE_QUERY_KIND_SET,
  isSourceQueryKind,
  isSourceQueryPermittedFor,
  parseSourceQueryRef,
} from '../index.js';

describe('D-149 P3 § A.3 — RECEPTION_RPC_METHODS closed list', () => {
  // D-207 slice 3c — 21, not 22. `reception.direct_checkout.recover` went with the legacy
  // coordinator that produced its only adapter; a surviving rpc would have always 503'd.
  it('lists the 21 reception.* rpc methods in spec order', () => {
    expect(RECEPTION_RPC_METHODS).toEqual([
      'reception.endpoints.list',
      'reception.endpoint.preview_draft',
      'reception.endpoint.create',
      'reception.endpoint.rotate_token',
      'reception.endpoint.enable',
      'reception.endpoint.disable',
      'reception.endpoint.revoke',
      'reception.endpoint.extend',
      'reception.endpoint.access_log',
      // D-200 Slice 6g.3 additions — current-source-derived pair authoring.
      'reception.intake_recipe_pair.get',
      'reception.intake_recipe_pair.bind',
      'reception.intake_recipe_pair.configure',
      'reception.intake_recipe_pair.clear',
      'reception.emergency_disable_all',
      // D-149 P4 additions — reception_page singleton config rpcs.
      'reception.page.get',
      'reception.page.upsert',
      // D-149 P12 additions — Abuse Inbox rpc trio.
      'reception.abuse_inbox.list',
      'reception.abuse_inbox.ban_ip',
      'reception.abuse_inbox.unban_ip',
      // D-149 follow-on § A.10 addition — Templates browser wire.
      'reception.template.list',
      // D-151 P2 addition — intent-first Compose proposal.
      'reception.compose.propose',
    ]);
  });

  it('RECEPTION_RPC_METHOD_SET covers every method', () => {
    for (const m of RECEPTION_RPC_METHODS) {
      expect(RECEPTION_RPC_METHOD_SET.has(m)).toBe(true);
    }
    expect(RECEPTION_RPC_METHOD_SET.size).toBe(RECEPTION_RPC_METHODS.length);
  });

  it('every reception.* rpc method appears in SERVER_RPC_METHODS', () => {
    for (const m of RECEPTION_RPC_METHODS) {
      expect(SERVER_RPC_METHOD_SET.has(m)).toBe(true);
    }
  });

  it('every reception endpoint kind binds to a packet kind', () => {
    for (const kind of RECEPTION_ENDPOINT_KINDS) {
      expect(RECEPTION_ENDPOINT_KIND_TO_PACKET_KIND[kind]).toMatch(/_packet$/);
    }
  });
});

describe('D-149 P3 § N.3 — RECEPTION_HIGH_ASSURANCE_AUDIT_KINDS ⊆ HIGH_ASSURANCE_AUDIT_KINDS', () => {
  it('every reception high-assurance kind is in the audit-signing closed list', () => {
    for (const kind of RECEPTION_HIGH_ASSURANCE_AUDIT_KINDS) {
      expect(HIGH_ASSURANCE_AUDIT_KINDS.has(kind)).toBe(true);
    }
  });

  it('the closed list has 19 kinds after D-200 pair configuration authoring', () => {
    expect(RECEPTION_HIGH_ASSURANCE_AUDIT_KINDS.length).toBe(19);
  });
});

describe('D-149 P3 § Must Hold I-3 — MCP channel isolation for reception.*', () => {
  it("MCP_RESERVED_RPC_PREFIXES carries 'reception.'", () => {
    expect(MCP_RESERVED_RPC_PREFIXES).toContain('reception.');
  });

  it("every reception.* rpc starts with the reserved prefix", () => {
    for (const m of RECEPTION_RPC_METHODS) {
      expect(m.startsWith('reception.')).toBe(true);
    }
  });
});

describe('D-149 P3 § A.4 — source_query_ref allowlist', () => {
  it('SOURCE_QUERY_KINDS has 12 closed-list entries', () => {
    expect(SOURCE_QUERY_KINDS.length).toBe(12);
    expect(SOURCE_QUERY_KIND_SET.size).toBe(SOURCE_QUERY_KINDS.length);
  });

  it('every reception packet kind has a permitted source-query set', () => {
    expect(SOURCE_QUERY_KINDS_PERMITTED_PER_PACKET_KIND.reception_page_packet).toEqual([
      'reception_page_config',
    ]);
    expect(SOURCE_QUERY_KINDS_PERMITTED_PER_PACKET_KIND.scheduling_link_packet).toEqual([
      'data.calendar.combined',
    ]);
    expect(SOURCE_QUERY_KINDS_PERMITTED_PER_PACKET_KIND.intake_form_packet).toEqual([
      'reception_form_definition',
    ]);
    expect(SOURCE_QUERY_KINDS_PERMITTED_PER_PACKET_KIND.drop_link_packet).toEqual([
      'reception_drop_config',
    ]);
    expect(SOURCE_QUERY_KINDS_PERMITTED_PER_PACKET_KIND.approval_link_packet).toEqual([
      'reception_approval_intent',
    ]);
    expect(SOURCE_QUERY_KINDS_PERMITTED_PER_PACKET_KIND.status_link_packet).toEqual([
      'data.task',
      'data.note',
      'data.commitment',
      'data.project',
      'data.event',
      'data.packing_list',
      'data.itinerary',
    ]);
  });

  it('parseSourceQueryRef accepts a valid scheduling source-query', () => {
    const res = parseSourceQueryRef({ kind: 'data.calendar.combined' });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.kind).toBe('data.calendar.combined');
  });

  it('parseSourceQueryRef rejects unknown kind (no vault escape hatch)', () => {
    const res = parseSourceQueryRef({ kind: 'vault.api_keys' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('source_query_unknown_kind');
  });

  it('parseSourceQueryRef rejects bare strings (no `string` escape hatch)', () => {
    const res = parseSourceQueryRef('data.calendar.combined');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('source_query_not_object');
  });

  it('parseSourceQueryRef rejects missing id field for keyed kinds', () => {
    const res = parseSourceQueryRef({ kind: 'reception_form_definition' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('source_query_missing_id_field');
  });

  it('isSourceQueryPermittedFor rejects vault escape against a permitted kind', () => {
    const res = parseSourceQueryRef({ kind: 'reception_page_config' });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(isSourceQueryPermittedFor('scheduling_link_packet', res.value)).toBe(false);
    }
  });

  it('isSourceQueryKind closed-list reject', () => {
    expect(isSourceQueryKind('data.memory.*')).toBe(false);
    expect(isSourceQueryKind('vault.api_keys')).toBe(false);
    expect(isSourceQueryKind('connection.api.hubspot.deal')).toBe(false);
  });
});

describe('D-149 P3 § Contract Tightening — RECEPTION_RATE_LIMIT_DEFAULTS', () => {
  it('per_ip_global default = 60 req / 60s', () => {
    expect(RECEPTION_RATE_LIMIT_DEFAULTS.per_ip_global).toEqual({
      window_ms: 60_000,
      max_requests: 60,
    });
  });

  it('per-kind windows match the spec table', () => {
    expect(
      RECEPTION_RATE_LIMIT_DEFAULTS.per_endpoint_kind.intake_form,
    ).toEqual({ window_ms: 3_600_000, max_requests: 60 });
    expect(
      RECEPTION_RATE_LIMIT_DEFAULTS.per_endpoint_kind.drop_link,
    ).toEqual({ window_ms: 3_600_000, max_requests: 5 });
    expect(
      RECEPTION_RATE_LIMIT_DEFAULTS.per_endpoint_kind.status_link,
    ).toEqual({ window_ms: 60_000, max_requests: 60 });
  });

  it('reception_page daily cap is uncapped (POSITIVE_INFINITY)', () => {
    expect(
      RECEPTION_RATE_LIMIT_DEFAULTS.per_endpoint_daily_cap.reception_page,
    ).toBe(Number.POSITIVE_INFINITY);
  });

  it('RECEPTION_RATE_BUCKET_KINDS lists the 3 closed-list bucket kinds', () => {
    expect(RECEPTION_RATE_BUCKET_KINDS).toEqual([
      'per_ip_global',
      'per_ip_per_endpoint',
      'per_endpoint_daily_cap',
    ]);
  });
});

describe('D-149 P3 § N.4 — RECEPTION_PER_KIND_EXPIRY_MAX_MS', () => {
  it('drop_link + approval_link cap at 30 days', () => {
    expect(RECEPTION_PER_KIND_EXPIRY_MAX_MS.drop_link).toBe(30 * 24 * 60 * 60 * 1000);
    expect(RECEPTION_PER_KIND_EXPIRY_MAX_MS.approval_link).toBe(30 * 24 * 60 * 60 * 1000);
  });

  it('status_link caps at 90 days', () => {
    expect(RECEPTION_PER_KIND_EXPIRY_MAX_MS.status_link).toBe(90 * 24 * 60 * 60 * 1000);
  });

  it('reception_page / scheduling / intake_form permit null long-lived', () => {
    expect(RECEPTION_PER_KIND_EXPIRY_MAX_MS.reception_page).toBeNull();
    expect(RECEPTION_PER_KIND_EXPIRY_MAX_MS.scheduling_link).toBeNull();
    expect(RECEPTION_PER_KIND_EXPIRY_MAX_MS.intake_form).toBeNull();
  });
});

describe('D-149 P3 § A.16 — RECEPTION_ACCESS_ACTIONS + OUTCOMES', () => {
  it('actions closed list has the 9 spec values', () => {
    expect(RECEPTION_ACCESS_ACTIONS).toEqual([
      'view',
      'submit',
      'upload',
      'approve',
      'reject',
      'expired',
      'invalid_token',
      'rate_limited',
      'revoked',
    ]);
    expect(RECEPTION_ACCESS_ACTION_SET.size).toBe(9);
  });

  it('outcomes closed list has the 7 spec values', () => {
    expect(RECEPTION_ACCESS_OUTCOMES).toEqual([
      'ok',
      'rejected',
      'rate_limited',
      'expired',
      'invalid_token',
      'revoked',
      'capacity_full',
    ]);
    expect(RECEPTION_ACCESS_OUTCOME_SET.size).toBe(7);
  });
});

describe('D-149 P3 — RECEPTION_RPC_ERROR_CODES closed list', () => {
  it('lists the closed-list rpc error codes including D-151 compose proposal errors', () => {
    expect(RECEPTION_RPC_ERROR_CODES.length).toBeGreaterThanOrEqual(26);
    expect(RECEPTION_RPC_ERROR_CODE_SET.size).toBe(RECEPTION_RPC_ERROR_CODES.length);
    expect(RECEPTION_RPC_ERROR_CODE_SET.has('compose_intent_invalid')).toBe(true);
    expect(RECEPTION_RPC_ERROR_CODE_SET.has('compose_ai_unavailable')).toBe(true);
    expect(RECEPTION_RPC_ERROR_CODE_SET.has('compose_proposal_invalid')).toBe(true);
    expect(RECEPTION_RPC_ERROR_CODE_SET.has('compose_compile_error')).toBe(true);
  });

  it('every code is kebab/underscore-cased + lowercase', () => {
    for (const code of RECEPTION_RPC_ERROR_CODES) {
      expect(code).toMatch(/^[a-z_.]+$/);
    }
  });
});
