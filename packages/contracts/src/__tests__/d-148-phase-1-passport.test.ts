/** D-148 P1 — Server Passport canonical-JSON + per-profile projection.
 *
 *  Acceptance per spec § P8:
 *   - canonicalJSONStringify is stable round-trip across two calls.
 *   - Stripping signature + canonicalJSON-stringifying the rest gives
 *     a stable signing payload.
 *   - support_redacted projection drops LAN URLs / per-client labels /
 *     pack list / per-vendor entity counts / fingerprints / last_rotated_at.
 *   - migration_full / enterprise_audit projections preserve full surface.
 */

import { describe, it, expect } from 'vitest';
import {
  canonicalJSONStringify,
  stripPassportSignature,
  canonicalPassportSigningPayload,
  projectServerPassport,
  SERVER_PASSPORT_VERSION,
  SERVER_PASSPORT_PROFILES,
  type ServerPassport,
  type ServerPassportSupportRedacted,
} from '../passport.js';

const sample_passport = (): ServerPassport => ({
  passport_version: SERVER_PASSPORT_VERSION,
  passport_id: 'passport-uuid-1',
  profile: 'enterprise_audit',
  exported_at: 1_700_000_000_000,
  exported_by_client_id: 'client-abc',
  reason: 'audit',
  identity: {
    server_public_key: 'SERVER_PUBLIC_KEY_BASE64',
    server_identity_fingerprint: 'sha256:aaa',
    publisher_id: 'pub-uuid',
    current_handle: 'alice',
    handle_history: [
      { handle: 'alice', reserved_at: 1_650_000_000_000 },
    ],
    publisher_identity_fingerprint: 'sha256:pub',
  },
  network: {
    lan_urls: ['192.168.1.42:8443', '10.0.0.5:8443'],
    ddns_handle: 'alice.recued.cloud',
    ddns_provider: 'recued.cloud',
    cert_fingerprint: 'sha256:cert',
    cert_expires_at: 1_710_000_000_000,
    derived_preset_label: 'lan_only',
    public_mcp_acknowledgement: { acknowledged: false },
    per_path: {
      health: { resolution: { lan: true, public: false } },
      ws: { resolution: { lan: true, public: false } },
      mcp: { resolution: { lan: true, public: false } },
      llm_gateway: { resolution: { lan: true, public: false } },
      webhooks: { resolution: { lan: false, public: false } },
      reception: { resolution: { lan: false, public: false } },
      oauth: { resolution: { lan: false, public: false } },
      ask: { resolution: { lan: false, public: false } },
      webclient: { resolution: { lan: true, public: false } },
    },
  },
  clients: [
    {
      client_id: 'client-1',
      client_kind: 'webclient',
      client_label: 'work laptop',
      paired_at: 1_690_000_000_000,
      last_seen_at: 1_700_000_000_000,
    },
    {
      client_id: 'client-2',
      client_kind: 'bridge',
      client_label: 'browser bridge',
      paired_at: 1_690_000_000_000,
    },
    {
      client_id: 'client-3',
      client_kind: 'cli',
      paired_at: 1_690_000_000_000,
    },
  ],
  capabilities: {
    software_version: '0.2.0',
    os: 'darwin',
    arch: 'arm64',
    storage_size_bytes: 2_048_000_000,
    ai_pool_configured: true,
    byok_slots_configured: 1,
    scheduled_recipes_count: 4,
    reactive_recipes_count: 12,
    installed_packs: ['personal-crm-foundation', 'sales-augmentation-hubspot'],
    connections: [
      { vendor: 'hubspot', entity_count: 200 },
      { vendor: 'salesforce', entity_count: 80 },
    ],
  },
  recovery: {
    backup_status: 'configured',
    last_backup_at: 1_695_000_000_000,
    backup_location: 's3://recued-backup-alice',
    filevault_recovery_key_status: 'present',
  },
  key_health: {
    master_dek: { status: 'healthy', last_rotated_at: 1_690_000_000_000 },
    sub_dek: { status: 'healthy' },
    server_identity_key: { status: 'healthy', last_rotated_at: 1_690_000_000_000 },
    publisher_identity_key: { status: 'healthy', last_rotated_at: 1_690_000_000_000 },
    tls_private_key: { status: 'healthy', last_rotated_at: 1_695_000_000_000 },
    webclient_token: { status: 'warning', expiry_warning: true },
    webhook_secret: { status: 'overdue' },
  },
  signature: 'SIGNATURE_BASE64',
});

describe('D-148 P1 — canonicalJSONStringify', () => {
  it('round-trips a simple object stably', () => {
    const obj = { a: 1, b: 'x', c: [1, 2, 3] };
    const a = canonicalJSONStringify(obj);
    const b = canonicalJSONStringify(obj);
    expect(a).toBe(b);
  });

  it('orders keys lexicographically at every nesting level', () => {
    const a = canonicalJSONStringify({ b: 1, a: 2 });
    expect(a).toBe('{"a":2,"b":1}');
    const b = canonicalJSONStringify({ z: { y: 1, x: 2 }, a: 3 });
    expect(b).toBe('{"a":3,"z":{"x":2,"y":1}}');
  });

  it('drops undefined values', () => {
    expect(canonicalJSONStringify({ a: undefined, b: 1 })).toBe('{"b":1}');
  });

  it('preserves null values', () => {
    expect(canonicalJSONStringify({ a: null })).toBe('{"a":null}');
  });

  it('handles arrays without sorting', () => {
    expect(canonicalJSONStringify([3, 1, 2])).toBe('[3,1,2]');
  });

  it('throws on non-finite numbers', () => {
    expect(() => canonicalJSONStringify({ a: Infinity })).toThrow();
    expect(() => canonicalJSONStringify({ a: NaN })).toThrow();
  });

  it('throws on bigint (no JSON encoding)', () => {
    expect(() => canonicalJSONStringify({ a: 1n })).toThrow();
  });
});

describe('D-148 P1 — passport signing payload stability', () => {
  it('strips signature for signing-payload computation', () => {
    const passport = sample_passport();
    const stripped = stripPassportSignature(passport);
    expect((stripped as { signature?: string }).signature).toBeUndefined();
  });

  it('canonicalPassportSigningPayload is stable round-trip', () => {
    const passport = sample_passport();
    const a = canonicalPassportSigningPayload(passport);
    const b = canonicalPassportSigningPayload(passport);
    expect(a).toBe(b);
  });

  it('canonicalPassportSigningPayload differs when content changes', () => {
    const a_passport = sample_passport();
    const b_passport = { ...sample_passport(), passport_id: 'different-uuid' };
    expect(canonicalPassportSigningPayload(a_passport))
      .not.toBe(canonicalPassportSigningPayload(b_passport));
  });
});

describe('D-148 P1 — projectServerPassport', () => {
  it('SERVER_PASSPORT_PROFILES enumerates the 3 known profiles', () => {
    expect(SERVER_PASSPORT_PROFILES.length).toBe(3);
    expect([...SERVER_PASSPORT_PROFILES].sort()).toEqual([
      'enterprise_audit',
      'migration_full',
      'support_redacted',
    ]);
  });

  it('migration_full preserves full passport (just sets profile)', () => {
    const full = sample_passport();
    const projection = projectServerPassport(full, 'migration_full');
    expect(projection.profile).toBe('migration_full');
    expect(projection).toMatchObject({
      identity: full.identity,
      network: full.network,
      clients: full.clients,
      capabilities: full.capabilities,
      recovery: full.recovery,
      key_health: full.key_health,
    });
  });

  it('enterprise_audit preserves full passport (just sets profile)', () => {
    const full = sample_passport();
    const projection = projectServerPassport(full, 'enterprise_audit');
    expect(projection.profile).toBe('enterprise_audit');
    expect((projection as ServerPassport).clients).toEqual(full.clients);
  });

  it('support_redacted hides LAN URLs', () => {
    const full = sample_passport();
    const projection = projectServerPassport(full, 'support_redacted') as Omit<
      ServerPassportSupportRedacted,
      'signature'
    >;
    expect((projection.network as { lan_urls?: unknown }).lan_urls).toBeUndefined();
  });

  it('support_redacted ships only per-path resolution bits (no Reception extras)', () => {
    const full = sample_passport();
    const projection = projectServerPassport(full, 'support_redacted') as Omit<
      ServerPassportSupportRedacted,
      'signature'
    >;
    expect(projection.network.per_path.ws).toEqual({
      resolution: { lan: true, public: false },
    });
    expect((projection.network.per_path.reception as { enabled_endpoint_count?: unknown })
      .enabled_endpoint_count).toBeUndefined();
    expect((projection.network.per_path.reception as { enabled_endpoint_kinds?: unknown })
      .enabled_endpoint_kinds).toBeUndefined();
  });

  it('support_redacted carries derived_preset_label + ack boolean (no free-text phrase)', () => {
    const full = sample_passport();
    const projection = projectServerPassport(full, 'support_redacted') as Omit<
      ServerPassportSupportRedacted,
      'signature'
    >;
    expect(projection.network.derived_preset_label).toBe('lan_only');
    expect(projection.network.public_mcp_acknowledged).toBe(false);
    expect(
      (projection.network as { public_mcp_acknowledgement?: unknown }).public_mcp_acknowledgement,
    ).toBeUndefined();
  });

  it('support_redacted coarsens clients to counts only', () => {
    const full = sample_passport();
    const projection = projectServerPassport(full, 'support_redacted') as Omit<
      ServerPassportSupportRedacted,
      'signature'
    >;
    expect(projection.clients).toEqual({
      bridge_count: 1,
      webclient_count: 1,
      cli_count: 1,
    });
  });

  it('support_redacted hides installed_packs list + per-vendor entity counts', () => {
    const full = sample_passport();
    const projection = projectServerPassport(full, 'support_redacted') as Omit<
      ServerPassportSupportRedacted,
      'signature'
    >;
    expect((projection.capabilities as { installed_packs?: unknown }).installed_packs)
      .toBeUndefined();
    expect(projection.capabilities.installed_pack_count).toBe(2);
    expect((projection.capabilities as { connections?: unknown }).connections)
      .toBeUndefined();
    // Codex P2 #1 fold — vendor-grouped connection counts replace
    // the bare `connection_count`. Spec § A.9 line 1051: "connection
    // count by vendor". Per-vendor entity counts explicitly stripped.
    expect(projection.capabilities.connections_by_vendor).toEqual([
      { vendor: 'hubspot', count: 1 },
      { vendor: 'salesforce', count: 1 },
    ]);
    expect((projection.capabilities as { storage_size_bytes?: unknown }).storage_size_bytes)
      .toBeUndefined();
    expect((projection.capabilities as { ai_pool_configured?: unknown }).ai_pool_configured)
      .toBeUndefined();
    expect((projection.capabilities as { byok_slots_configured?: unknown }).byok_slots_configured)
      .toBeUndefined();
  });

  it('support_redacted hides backup_location', () => {
    const full = sample_passport();
    const projection = projectServerPassport(full, 'support_redacted') as Omit<
      ServerPassportSupportRedacted,
      'signature'
    >;
    expect((projection.recovery as { backup_location?: unknown }).backup_location)
      .toBeUndefined();
    expect((projection.recovery as { last_backup_at?: unknown }).last_backup_at)
      .toBeUndefined();
  });

  it('support_redacted hides last_rotated_at + expiry_warning fingerprints', () => {
    const full = sample_passport();
    const projection = projectServerPassport(full, 'support_redacted') as Omit<
      ServerPassportSupportRedacted,
      'signature'
    >;
    for (const cls of Object.keys(projection.key_health)) {
      const entry = projection.key_health[cls as keyof typeof projection.key_health];
      expect(Object.keys(entry)).toEqual(['status']);
    }
  });

  it('support_redacted preserves identity fingerprint + cert fingerprint', () => {
    const full = sample_passport();
    const projection = projectServerPassport(full, 'support_redacted') as Omit<
      ServerPassportSupportRedacted,
      'signature'
    >;
    expect(projection.identity.server_identity_fingerprint).toBe(full.identity.server_identity_fingerprint);
    expect(projection.network.cert_fingerprint).toBe(full.network.cert_fingerprint);
  });
});

describe('D-148 P1 — passport profile signature commits to projection', () => {
  it('canonicalPassportSigningPayload differs across profiles', () => {
    const full = sample_passport();
    const support_redacted_payload = projectServerPassport(full, 'support_redacted');
    const migration_full_payload = projectServerPassport(full, 'migration_full');

    const a = canonicalJSONStringify(support_redacted_payload);
    const b = canonicalJSONStringify(migration_full_payload);
    expect(a).not.toBe(b);
  });

  it('Codex P1 #4 — projectServerPassport strips signature on every profile', () => {
    const full = sample_passport();
    for (const profile of ['support_redacted', 'enterprise_audit', 'migration_full'] as const) {
      const projection = projectServerPassport(full, profile);
      expect((projection as { signature?: unknown }).signature).toBeUndefined();
    }
  });

  it('Codex P1 #4 — re-spreading source signature into projection would fail this assertion', () => {
    // Regression check — if someone reverts the strip, this fires.
    const full = sample_passport();
    expect(full.signature).toBe('SIGNATURE_BASE64');
    const enterprise = projectServerPassport(full, 'enterprise_audit') as Record<string, unknown>;
    expect(enterprise.signature).toBeUndefined();
    const migration = projectServerPassport(full, 'migration_full') as Record<string, unknown>;
    expect(migration.signature).toBeUndefined();
  });
});
