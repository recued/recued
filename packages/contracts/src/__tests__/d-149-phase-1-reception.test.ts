/** D-149 P1 — Reception contracts.
 *
 *  Acceptance per spec § N.1 + § N.3 + § A.7 + § A.8 + § Must Hold:
 *   - 6 closed-list endpoint kinds; predicate accepts every member +
 *     rejects unknown / non-string input.
 *   - High-assurance audit kinds stay closed and disjoint from generic
 *     event names.
 *   - 8-table inventory matches the spec P1 line; tables are
 *     server-internal, never broadcast cross-cloud (D-097 / D-168).
 *   - Server Passport per_port `reception` row carries optional
 *     `enabled_endpoint_count` + `enabled_endpoint_kinds`; the other
 *     three roles leave them undefined; `support_redacted` projection
 *     strips both alongside `port`.
 *   - Reachability `ReceptionPortEntry` carries optional
 *     `reception_specific` block; recommendation-code closed list
 *     contains the three D-149 codes alongside the D-148 ten.
 */

import { describe, it, expect } from 'vitest';
import {
  RECEPTION_ENDPOINT_KINDS,
  RECEPTION_ENDPOINT_KIND_SET,
  isReceptionEndpointKind,
  RECEPTION_HIGH_ASSURANCE_AUDIT_KINDS,
  RECEPTION_HIGH_ASSURANCE_AUDIT_KIND_SET,
  isReceptionHighAssuranceAuditKind,
  RECEPTION_TABLES,
  RECEPTION_TABLE_SET,
  REACHABILITY_RECOMMENDATION_CODES,
  projectServerPassport,
  SERVER_PASSPORT_VERSION,
  type ReceptionEndpointKind,
  type ReceptionTableName,
  type ServerPassport,
  type ServerPassportSupportRedacted,
  type ReachabilityPathEntry,
  type ReachabilityReceptionSpecific,
  type ReachabilityRecommendationCode,
  KEY_CLASSES,
  totalRecord,
} from '../index.js';

describe('D-149 P1 — RECEPTION_ENDPOINT_KINDS closed list (§ N.1)', () => {
  const expected: ReadonlyArray<ReceptionEndpointKind> = [
    'reception_page',
    'scheduling_link',
    'intake_form',
    'drop_link',
    'approval_link',
    'status_link',
  ];

  it('lists exactly six kinds in spec order', () => {
    expect(RECEPTION_ENDPOINT_KINDS).toEqual(expected);
  });

  it('RECEPTION_ENDPOINT_KIND_SET contains every kind', () => {
    for (const kind of RECEPTION_ENDPOINT_KINDS) {
      expect(RECEPTION_ENDPOINT_KIND_SET.has(kind)).toBe(true);
    }
    expect(RECEPTION_ENDPOINT_KIND_SET.size).toBe(RECEPTION_ENDPOINT_KINDS.length);
  });

  it('isReceptionEndpointKind accepts every member + rejects unknown', () => {
    for (const kind of RECEPTION_ENDPOINT_KINDS) {
      expect(isReceptionEndpointKind(kind)).toBe(true);
    }
    expect(isReceptionEndpointKind('unknown_kind')).toBe(false);
    expect(isReceptionEndpointKind('')).toBe(false);
    expect(isReceptionEndpointKind(null)).toBe(false);
    expect(isReceptionEndpointKind(undefined)).toBe(false);
    expect(isReceptionEndpointKind(42)).toBe(false);
    expect(isReceptionEndpointKind({})).toBe(false);
  });
});

describe('D-149 P1 — RECEPTION_HIGH_ASSURANCE_AUDIT_KINDS closed list (§ N.3)', () => {
  it('contains the canonical mutation + lifecycle kinds', () => {
    // Closed-list spec line 47-52: every mutation + revocation + drop
    // receipt + approval consumption + form submission + listener
    // lifecycle kind. Three Pass-3 / D-151 additions: endpoint.created,
    // endpoint.token_rotated, reception.emergency_disabled.
    const required = [
      'endpoint.created',
      'endpoint.enabled',
      'endpoint.disabled',
      'endpoint.revoked',
      'endpoint.extended',
      'endpoint.expired',
      'endpoint.token_rotated',
      'form_submission.received',
      'drop_blob.received',
      'approval_intent.consumed',
      'reception.listener.started',
      'reception.listener.stopped',
      'reception.emergency_disabled',
      // D-149 P4 addition — singleton config upsert (Mary editing the
      // front-door page is a high-assurance event server-wide).
      'reception_page.config_updated',
      // D-200 Slice 6g.3 additions — owner-authored intake/recipe pair
      // mutations are signed; read and idempotent no-op calls are not.
      'reception.intake_recipe_pair.bound',
      'reception.intake_recipe_pair.configured',
      'reception.intake_recipe_pair.cleared',
      // D-149 P12 addition — Abuse Inbox IP ban / unban (each mutates
      // the per-server block list the path-listener enforces).
      'reception.ip_blocked',
      'reception.ip_unblocked',
    ];
    expect(RECEPTION_HIGH_ASSURANCE_AUDIT_KINDS).toEqual(required);
  });

  it('predicate + set are mutually consistent', () => {
    for (const kind of RECEPTION_HIGH_ASSURANCE_AUDIT_KINDS) {
      expect(RECEPTION_HIGH_ASSURANCE_AUDIT_KIND_SET.has(kind)).toBe(true);
      expect(isReceptionHighAssuranceAuditKind(kind)).toBe(true);
    }
    // Routine reads must NEVER be classified high-assurance per § N.3
    // (auto-refresh polls + token-rejected responses go to operational
    // log only). Spot-check the rejection.
    expect(isReceptionHighAssuranceAuditKind('endpoint.viewed')).toBe(false);
    expect(isReceptionHighAssuranceAuditKind('endpoint.preview_draft')).toBe(false);
    expect(isReceptionHighAssuranceAuditKind('rate_limited')).toBe(false);
  });
});

describe('D-149 P1 — RECEPTION_TABLES inventory', () => {
  // D-149 P3 § Contract Tightening — the ninth `reception_rate_limiter`
  // table joins at P3 alongside the rpc surface + the in-memory token
  // bucket primary path. D-149 P12 § A.20.5 adds the tenth
  // `reception_ip_block_list` table for the Abuse Inbox per-server IP
  // block list. D-200 Slice 6g.2 adds the eleventh pair-registry table.
  // The contract list grows from eight (P1) → nine (P3) → ten (P12) →
  // eleven (D-200) — then BACK to ten: D-210 A.8 slice 4c dropped
  // `reception_booking_request` once slice 4b-ii had moved every booking into
  // `reception_form_submission`, leaving it with no writer and no reader.
  //
  // ⚠ This list is exact-equality and it is SUPPOSED to fire on a drop. It
  // fires on an ADD too — that is the ratchet working, not a nuisance.
  const expected: ReadonlyArray<ReceptionTableName> = [
    'public_endpoint_registry',
    'public_endpoint_access_log',
    'reception_form_definition',
    'reception_intake_recipe_pair',
    'reception_form_submission',
    'reception_drop_blob_metadata',
    'reception_approval_intent',
    'reception_status_projection',
    'reception_rate_limiter',
    'reception_ip_block_list',
    // D-240 slice 3b — the endpoint → LOOKUP-recipe binding.
    'reception_lookup_recipe_pair',
  ];

  it('lists exactly eleven tables in spec order (D-210 A.8 slice 4c drops the booking table)', () => {
    expect(RECEPTION_TABLES).toEqual(expected);
  });

  it('RECEPTION_TABLE_SET contains every table', () => {
    for (const table of RECEPTION_TABLES) {
      expect(RECEPTION_TABLE_SET.has(table)).toBe(true);
    }
    expect(RECEPTION_TABLE_SET.size).toBe(RECEPTION_TABLES.length);
  });
});

describe('D-148 W3.7 — RECEPTION_DEFAULT_PORT retired (path-mount swap)', () => {
  it('is not exported from the contracts barrel — reception no longer binds its own port', async () => {
    const mod = (await import('../index.js')) as unknown as Record<string, unknown>;
    expect(mod.RECEPTION_DEFAULT_PORT).toBeUndefined();
  });

  it('the reception submodule no longer exports the legacy port constant', async () => {
    const mod = (await import('../reception.js')) as unknown as Record<string, unknown>;
    expect(mod.RECEPTION_DEFAULT_PORT).toBeUndefined();
  });
});

const sample_passport_with_reception_extras = (): ServerPassport => ({
  passport_version: SERVER_PASSPORT_VERSION,
  passport_id: 'passport-uuid-149',
  profile: 'enterprise_audit',
  exported_at: 1_700_000_000_000,
  exported_by_client_id: 'client-149',
  identity: {
    server_public_key: 'KEY',
    server_identity_fingerprint: 'sha256:id',
    publisher_id: 'pub',
    current_handle: 'alice',
    handle_history: [],
    publisher_identity_fingerprint: 'sha256:pub',
  },
  network: {
    lan_urls: ['192.168.1.10:8443'],
    cert_fingerprint: 'sha256:cert',
    cert_expires_at: 1_710_000_000_000,
    derived_preset_label: 'custom',
    public_mcp_acknowledgement: { acknowledged: false },
    per_path: {
      health: { resolution: { lan: true, public: true } },
      ws: { resolution: { lan: true, public: true } },
      mcp: { resolution: { lan: true, public: false } },
      llm_gateway: { resolution: { lan: true, public: true } },
      webhooks: { resolution: { lan: true, public: true } },
      reception: {
        resolution: { lan: true, public: true },
        enabled_endpoint_count: 3,
        enabled_endpoint_kinds: ['scheduling_link', 'intake_form', 'drop_link'],
      },
      oauth: { resolution: { lan: false, public: false } },
      ask: { resolution: { lan: false, public: false } },
      webclient: { resolution: { lan: true, public: false } },
    },
  },
  clients: [],
  capabilities: {
    software_version: '0.2.0',
    os: 'linux',
    arch: 'x64',
    storage_size_bytes: 0,
    ai_pool_configured: false,
    byok_slots_configured: 0,
    scheduled_recipes_count: 0,
    reactive_recipes_count: 0,
    installed_packs: [],
    connections: [],
  },
  recovery: {
    backup_status: 'configured',
    filevault_recovery_key_status: 'present',
  },
  // ⛔ NOT `{} as ServerPassport['key_health']`. That cast asserted a bundle with
  // EVERY key class while supplying none, so any consumer that walks KEY_CLASSES
  // crashed on this fixture — which is exactly what happened when the redacted
  // projection was converted to a total build. Production's `loadKeyHealth`
  // returns all seven; a fixture that claims the type owes the same.
  key_health: totalRecord(KEY_CLASSES, () => ({ status: 'healthy' as const })),
  signature: 'SIG',
});

describe('D-149 P1 — Server Passport per_path.reception extras (§ A.7; path-routed)', () => {
  it('reception entry carries enabled_endpoint_count + enabled_endpoint_kinds + lan/public resolution', () => {
    const p = sample_passport_with_reception_extras();
    expect(p.network.per_path.reception.resolution).toEqual({ lan: true, public: true });
    expect(p.network.per_path.reception.enabled_endpoint_count).toBe(3);
    expect(p.network.per_path.reception.enabled_endpoint_kinds).toEqual([
      'scheduling_link',
      'intake_form',
      'drop_link',
    ]);
  });

  it('non-reception per_path entries leave the extras undefined', () => {
    const p = sample_passport_with_reception_extras();
    for (const role of ['health', 'ws', 'mcp', 'webhooks'] as const) {
      expect(p.network.per_path[role].enabled_endpoint_count).toBeUndefined();
      expect(p.network.per_path[role].enabled_endpoint_kinds).toBeUndefined();
    }
  });

  it('support_redacted projection strips Reception extras + leaves only the resolution bits', () => {
    const p = sample_passport_with_reception_extras();
    const projection = projectServerPassport(p, 'support_redacted') as Omit<
      ServerPassportSupportRedacted,
      'signature'
    >;
    for (const role of ['health', 'ws', 'mcp', 'webhooks', 'reception'] as const) {
      const entry = projection.network.per_path[role] as {
        resolution: { lan: boolean; public: boolean };
        enabled_endpoint_count?: number;
        enabled_endpoint_kinds?: ReadonlyArray<unknown>;
      };
      expect(entry.resolution).toBeDefined();
      expect(entry.enabled_endpoint_count).toBeUndefined();
      expect(entry.enabled_endpoint_kinds).toBeUndefined();
    }
    expect(projection.network.per_path.reception.resolution.public).toBe(true);
  });

  it('enterprise_audit projection preserves resolution + extras', () => {
    const p = sample_passport_with_reception_extras();
    const projection = projectServerPassport(p, 'enterprise_audit') as Omit<
      ServerPassport,
      'signature'
    >;
    expect(projection.network.per_path.reception.resolution).toEqual({ lan: true, public: true });
    expect(projection.network.per_path.reception.enabled_endpoint_count).toBe(3);
    expect(projection.network.per_path.reception.enabled_endpoint_kinds).toEqual([
      'scheduling_link',
      'intake_form',
      'drop_link',
    ]);
  });

  it('migration_full projection preserves resolution + extras', () => {
    const p = sample_passport_with_reception_extras();
    const projection = projectServerPassport(p, 'migration_full') as Omit<
      ServerPassport,
      'signature'
    >;
    expect(projection.network.per_path.reception.enabled_endpoint_count).toBe(3);
    expect(projection.network.per_path.reception.enabled_endpoint_kinds).toEqual([
      'scheduling_link',
      'intake_form',
      'drop_link',
    ]);
  });
});

describe('D-149 P1 — Reachability Doctor reception extensions (§ A.8)', () => {
  it('REACHABILITY_RECOMMENDATION_CODES contains the three D-149 codes', () => {
    const codes: ReadonlyArray<ReachabilityRecommendationCode> = REACHABILITY_RECOMMENDATION_CODES;
    expect(codes).toContain('reception_listener_silent');
    expect(codes).toContain('reception_endpoint_unreachable');
    expect(codes).toContain('reception_cert_san_missing_hostname');
  });

  it('REACHABILITY_RECOMMENDATION_CODES preserves the D-148 ten in its prefix (post W3.5 renames)', () => {
    const d148 = [
      'tls_renewal_overdue',
      'tls_renewal_imminent',
      'ddns_ip_mismatch',
      'webhook_inbound_silent',
      'webhook_hmac_failure',
      'bridge_offline',
      'cert_fingerprint_mismatch',
      'path_unreachable_from_cloud',
      'nat_traversal_required',
      'exposure_resolution_inconsistent',
    ];
    for (const code of d148) {
      expect(REACHABILITY_RECOMMENDATION_CODES).toContain(code);
    }
  });

  it('ReachabilityPathEntry accepts optional reception_specific on reception role', () => {
    const reception_specific: ReachabilityReceptionSpecific = {
      enabled_endpoint_count: 2,
      last_endpoint_health_check: 'all_passed',
      cert_san_includes_reception_hostname: true,
    };
    const entry: ReachabilityPathEntry = {
      role: 'reception',
      lan_listening: true,
      public_listening: true,
      handshake_test: { passed: true, ms: 12 },
      reception_specific,
    };
    expect(entry.reception_specific).toBeDefined();
    expect(entry.reception_specific?.enabled_endpoint_count).toBe(2);
    expect(entry.reception_specific?.last_endpoint_health_check).toBe('all_passed');
    expect(entry.reception_specific?.cert_san_includes_reception_hostname).toBe(true);
  });

  it('ReachabilityPathEntry leaves reception_specific undefined on non-reception roles', () => {
    const entry: ReachabilityPathEntry = {
      role: 'ws',
      lan_listening: true,
      public_listening: true,
      handshake_test: { passed: true, ms: 8 },
    };
    expect(entry.reception_specific).toBeUndefined();
  });
});
