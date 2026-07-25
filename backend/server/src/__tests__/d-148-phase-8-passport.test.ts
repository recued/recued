/** D-148 P8 — Server Passport export substrate acceptance.
 *
 *  Covers spec § P8 acceptance lines 2180-2184 + 2192:
 *    - Passport export signature round-trip per profile
 *    - Profile binding via signature (substituted profile fails)
 *    - Canonical-JSON stability across versions
 *    - Support-redacted leaks no LAN URLs / no client labels / no
 *      pack list / no per-vendor entity counts / no fingerprints /
 *      no last_rotated_at
 *    - Export audit row
 *    - Passport import preserves publisher_id
 */

import { describe, it, expect } from 'vitest';
import {
  canonicalJSONStringify,
  SERVER_PASSPORT_PROFILES,
  SERVER_PASSPORT_VERSION,
  type KeyHealthBundle,
  type ServerCapabilityProfile,
  type ServerPassportClientEntry,
  type ServerPassportExportOptions,
  type ServerPassportIdentityBlock,
  type ServerPassportNetworkBlock,
  type ServerPassportProfile,
  type ServerPassportProjection,
  type ServerPassportRecoveryBlock,
} from '@recued/contracts';
import { generateEd25519Keypair, type Ed25519Keypair } from '../keys/index.js';
import {
  collectFullPassport,
  createInMemoryPassportHistoryStore,
  createPassportAuditEmitter,
  exportServerPassport,
  previewImportPassport,
  verifyServerPassport,
  type PassportAuditEmitter,
  type PassportBlockProviders,
} from '../passport/index.js';
import type { ActivityEntry } from '@recued/storage';

// ────────────────────────────────────────────────────────────────
// Fixtures
// ────────────────────────────────────────────────────────────────

const makeFixtureProviders = (
  identityKey: Ed25519Keypair,
  publisherKey: Ed25519Keypair,
  override?: {
    handle?: string;
    handle_history?: ServerPassportIdentityBlock['handle_history'];
  },
): PassportBlockProviders => {
  const identity: ServerPassportIdentityBlock = {
    server_public_key: identityKey.public_key_b64,
    server_identity_fingerprint: identityKey.public_key_fingerprint,
    publisher_id: 'pub_alice_42',
    current_handle: override?.handle ?? 'alice',
    handle_history: override?.handle_history ?? [
      { handle: 'alice', reserved_at: 1_700_000_000_000 },
    ],
    publisher_identity_fingerprint: publisherKey.public_key_fingerprint,
  };
  const network: ServerPassportNetworkBlock = {
    lan_urls: ['https://192.168.1.42:8443', 'https://10.0.0.5:8443'],
    ddns_handle: 'alice.recued.cloud',
    ddns_provider: 'recued.cloud',
    cert_fingerprint: 'sha256:abc123',
    cert_expires_at: 1_800_000_000_000,
    derived_preset_label: 'custom',
    public_mcp_acknowledgement: { acknowledged: false },
    per_path: {
      health: { resolution: { lan: true, public: false } },
      ws: { resolution: { lan: true, public: true } },
      mcp: { resolution: { lan: true, public: false } },
      llm_gateway: { resolution: { lan: true, public: false } },
      webhooks: { resolution: { lan: false, public: false } },
      reception: { resolution: { lan: false, public: false } },
      oauth: { resolution: { lan: false, public: false } },
      ask: { resolution: { lan: false, public: false } },
      webclient: { resolution: { lan: true, public: false } },
    },
  };
  const clients: ServerPassportClientEntry[] = [
    {
      client_id: 'br_1',
      client_kind: 'bridge',
      client_label: 'macbook-bridge',
      paired_at: 1_700_000_000_000,
      last_seen_at: 1_700_001_000_000,
    },
    {
      client_id: 'wc_1',
      client_kind: 'webclient',
      client_label: 'iphone',
      paired_at: 1_700_000_500_000,
      last_seen_at: 1_700_002_000_000,
    },
    {
      client_id: 'wc_2',
      client_kind: 'webclient',
      client_label: 'ipad',
      paired_at: 1_700_000_600_000,
    },
    {
      client_id: 'cli_1',
      client_kind: 'cli',
      paired_at: 1_700_000_700_000,
    },
  ];
  const capabilities: ServerCapabilityProfile = {
    software_version: 'recued@2026.5.7',
    os: 'darwin',
    arch: 'arm64',
    storage_size_bytes: 10_737_418_240,
    ai_pool_configured: true,
    byok_slots_configured: 2,
    scheduled_recipes_count: 12,
    reactive_recipes_count: 5,
    installed_packs: ['personal-crm-foundation', 'sales-augmentation-hubspot'],
    connections: [
      { vendor: 'hubspot', entity_count: 142 },
      { vendor: 'salesforce', entity_count: 87 },
      { vendor: 'hubspot', entity_count: 5 },
    ],
  };
  const recovery: ServerPassportRecoveryBlock = {
    backup_status: 'configured',
    last_backup_at: 1_700_000_900_000,
    backup_location: 's3://acme-backups/recued/',
    filevault_recovery_key_status: 'present',
  };
  const key_health: KeyHealthBundle = {
    master_dek: { status: 'healthy', last_rotated_at: 1_700_000_000_000 },
    sub_dek: { status: 'healthy' },
    server_identity_key: { status: 'healthy', last_rotated_at: 1_700_000_000_000 },
    publisher_identity_key: { status: 'warning', last_rotated_at: 1_650_000_000_000, expiry_warning: true },
    tls_private_key: { status: 'overdue', last_rotated_at: 1_600_000_000_000, expiry_warning: true },
    webclient_token: { status: 'healthy' },
    webhook_secret: { status: 'healthy' },
  };
  return {
    loadIdentity: () => identity,
    loadNetwork: () => network,
    loadClients: () => clients,
    loadCapabilities: () => capabilities,
    loadRecovery: () => recovery,
    loadKeyHealth: () => key_health,
  };
};

const makeAuditEmitter = (): {
  emitter: PassportAuditEmitter;
  rows: ActivityEntry[];
} => {
  const rows: ActivityEntry[] = [];
  return {
    emitter: { log: (entry) => { rows.push({ ...entry }); } },
    rows,
  };
};

const exportFor = async (
  profile: ServerPassportProfile,
  identityKey: Ed25519Keypair,
  publisherKey: Ed25519Keypair,
  reason?: string,
): Promise<{ projection: ServerPassportProjection; audit: ActivityEntry[] }> => {
  const providers = makeFixtureProviders(identityKey, publisherKey);
  const { emitter, rows } = makeAuditEmitter();
  const opts: ServerPassportExportOptions = reason ? { profile, reason } : { profile };
  const projection = await exportServerPassport({
    providers,
    serverIdentity: identityKey,
    audit: emitter,
    exported_by_client_id: 'br_1',
    options: opts,
    now: () => 1_700_003_000_000,
    mintId: () => 'passport-id-fixed',
  });
  return { projection, audit: rows };
};

// ────────────────────────────────────────────────────────────────
// Round-trip per profile
// ────────────────────────────────────────────────────────────────

describe('D-148 P8 — passport export round-trip per profile', () => {
  it.each(SERVER_PASSPORT_PROFILES as ReadonlyArray<ServerPassportProfile>)(
    '%s: signature round-trips',
    async (profile) => {
      const ik = generateEd25519Keypair('server_identity_key');
      const pk = generateEd25519Keypair('publisher_identity_key');
      const { projection } = await exportFor(profile, ik, pk);
      expect(projection.profile).toBe(profile);
      const verify = verifyServerPassport(projection);
      expect(verify.ok).toBe(true);
    },
  );

  it.each(SERVER_PASSPORT_PROFILES as ReadonlyArray<ServerPassportProfile>)(
    '%s: tampered payload fails verification',
    async (profile) => {
      const ik = generateEd25519Keypair('server_identity_key');
      const pk = generateEd25519Keypair('publisher_identity_key');
      const { projection } = await exportFor(profile, ik, pk);
      const tampered = {
        ...projection,
        passport_id: 'evil-id-replaced',
      } as ServerPassportProjection;
      expect(verifyServerPassport(tampered).ok).toBe(false);
    },
  );

  it('tampered signature itself fails verification', async () => {
    const ik = generateEd25519Keypair('server_identity_key');
    const pk = generateEd25519Keypair('publisher_identity_key');
    const { projection } = await exportFor('migration_full', ik, pk);
    const munged = {
      ...projection,
      signature: projection.signature.replace(/[A-Za-z0-9+/=]/g, 'A'),
    } as ServerPassportProjection;
    expect(verifyServerPassport(munged).ok).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────
// Profile binding via signature
// ────────────────────────────────────────────────────────────────

describe('D-148 P8 — profile binding via signature', () => {
  it('substituting profile name without re-signing fails verification', async () => {
    const ik = generateEd25519Keypair('server_identity_key');
    const pk = generateEd25519Keypair('publisher_identity_key');
    const { projection } = await exportFor('support_redacted', ik, pk);
    const promoted = {
      ...projection,
      profile: 'migration_full',
    } as unknown as ServerPassportProjection;
    expect(verifyServerPassport(promoted).ok).toBe(false);
  });

  it('demoting profile name without re-signing fails verification', async () => {
    const ik = generateEd25519Keypair('server_identity_key');
    const pk = generateEd25519Keypair('publisher_identity_key');
    const { projection } = await exportFor('migration_full', ik, pk);
    const demoted = {
      ...projection,
      profile: 'support_redacted',
    } as unknown as ServerPassportProjection;
    expect(verifyServerPassport(demoted).ok).toBe(false);
  });

  it('passport with unknown profile fails verification', async () => {
    const ik = generateEd25519Keypair('server_identity_key');
    const pk = generateEd25519Keypair('publisher_identity_key');
    const { projection } = await exportFor('migration_full', ik, pk);
    const unknown = {
      ...projection,
      profile: 'something_else',
    } as unknown as ServerPassportProjection;
    expect(verifyServerPassport(unknown)).toEqual({
      ok: false,
      reason: 'profile_unknown',
    });
  });

  it('passport without signature fails verification', async () => {
    const ik = generateEd25519Keypair('server_identity_key');
    const pk = generateEd25519Keypair('publisher_identity_key');
    const { projection } = await exportFor('migration_full', ik, pk);
    const stripped = { ...projection, signature: '' } as ServerPassportProjection;
    expect(verifyServerPassport(stripped)).toEqual({
      ok: false,
      reason: 'signature_missing',
    });
  });
});

// ────────────────────────────────────────────────────────────────
// Canonical-JSON stability
// ────────────────────────────────────────────────────────────────

describe('D-148 P8 — canonical-JSON stability', () => {
  it('two exports of the same content produce byte-identical canonical JSON', async () => {
    const ik = generateEd25519Keypair('server_identity_key');
    const pk = generateEd25519Keypair('publisher_identity_key');
    const a = await exportFor('migration_full', ik, pk);
    const b = await exportFor('migration_full', ik, pk);
    const { signature: _sa, ...aPayload } = a.projection;
    const { signature: _sb, ...bPayload } = b.projection;
    expect(canonicalJSONStringify(aPayload)).toBe(canonicalJSONStringify(bPayload));
  });

  it('signatures over identical bytes verify against either passport copy', async () => {
    const ik = generateEd25519Keypair('server_identity_key');
    const pk = generateEd25519Keypair('publisher_identity_key');
    const a = await exportFor('migration_full', ik, pk);
    const b = await exportFor('migration_full', ik, pk);
    // Splicing a's signature onto b's payload (which is identical
    // bytes by the stability property above) should still verify.
    const splice = { ...b.projection, signature: a.projection.signature };
    expect(verifyServerPassport(splice).ok).toBe(true);
  });

  it('canonical key order is lexicographic at every level', async () => {
    const ik = generateEd25519Keypair('server_identity_key');
    const pk = generateEd25519Keypair('publisher_identity_key');
    const { projection } = await exportFor('migration_full', ik, pk);
    const { signature: _drop, ...payload } = projection;
    const canonical = canonicalJSONStringify(payload);
    // Top-level keys appear in lexicographic order; sample a few
    // adjacent pairs that must hold.
    const idxOf = (key: string) => canonical.indexOf(`"${key}"`);
    expect(idxOf('capabilities')).toBeLessThan(idxOf('clients'));
    expect(idxOf('clients')).toBeLessThan(idxOf('exported_at'));
    expect(idxOf('exported_at')).toBeLessThan(idxOf('exported_by_client_id'));
  });
});

// ────────────────────────────────────────────────────────────────
// Support-redacted leak audit
// ────────────────────────────────────────────────────────────────

describe('D-148 P8 — support_redacted leak audit', () => {
  it('does not include LAN URLs', async () => {
    const ik = generateEd25519Keypair('server_identity_key');
    const pk = generateEd25519Keypair('publisher_identity_key');
    const { projection } = await exportFor('support_redacted', ik, pk);
    expect(JSON.stringify(projection)).not.toContain('192.168.1.42');
    expect(JSON.stringify(projection)).not.toContain('10.0.0.5');
    // Network block carries cert + ddns_handle but NOT lan_urls.
    expect((projection.network as Record<string, unknown>).lan_urls).toBeUndefined();
  });

  it('does not include per-client labels', async () => {
    const ik = generateEd25519Keypair('server_identity_key');
    const pk = generateEd25519Keypair('publisher_identity_key');
    const { projection } = await exportFor('support_redacted', ik, pk);
    const json = JSON.stringify(projection);
    expect(json).not.toContain('macbook-bridge');
    expect(json).not.toContain('iphone');
    expect(json).not.toContain('ipad');
    // Clients projection becomes a count summary, not an array of
    // labelled entries.
    expect(Array.isArray(projection.clients)).toBe(false);
    expect(projection.clients).toMatchObject({
      bridge_count: 1,
      webclient_count: 2,
      cli_count: 1,
    });
  });

  it('does not include installed pack list', async () => {
    const ik = generateEd25519Keypair('server_identity_key');
    const pk = generateEd25519Keypair('publisher_identity_key');
    const { projection } = await exportFor('support_redacted', ik, pk);
    const json = JSON.stringify(projection);
    expect(json).not.toContain('personal-crm-foundation');
    expect(json).not.toContain('sales-augmentation-hubspot');
    expect(
      (projection.capabilities as unknown as Record<string, unknown>).installed_packs,
    ).toBeUndefined();
    expect(
      (projection.capabilities as unknown as Record<string, unknown>).installed_pack_count,
    ).toBe(2);
  });

  it('does not include per-vendor entity counts', async () => {
    const ik = generateEd25519Keypair('server_identity_key');
    const pk = generateEd25519Keypair('publisher_identity_key');
    const { projection } = await exportFor('support_redacted', ik, pk);
    // Capabilities surfaces vendor names + connection counts, NOT
    // per-vendor entity_count.
    const caps = projection.capabilities as unknown as Record<string, unknown>;
    expect(caps['connections_by_vendor']).toBeDefined();
    expect(JSON.stringify(caps)).not.toContain('"entity_count":142');
    expect(JSON.stringify(caps)).not.toContain('"entity_count":87');
  });

  it('does not include backup_location in recovery block', async () => {
    const ik = generateEd25519Keypair('server_identity_key');
    const pk = generateEd25519Keypair('publisher_identity_key');
    const { projection } = await exportFor('support_redacted', ik, pk);
    expect(JSON.stringify(projection)).not.toContain('s3://acme-backups');
    expect(
      (projection.recovery as unknown as Record<string, unknown>).backup_location,
    ).toBeUndefined();
  });

  it('does not include last_rotated_at in key health', async () => {
    const ik = generateEd25519Keypair('server_identity_key');
    const pk = generateEd25519Keypair('publisher_identity_key');
    const { projection } = await exportFor('support_redacted', ik, pk);
    for (const entry of Object.values(projection.key_health)) {
      expect((entry as Record<string, unknown>).last_rotated_at).toBeUndefined();
    }
  });

  it('migration_full DOES include all the redacted surfaces', async () => {
    const ik = generateEd25519Keypair('server_identity_key');
    const pk = generateEd25519Keypair('publisher_identity_key');
    const { projection } = await exportFor('migration_full', ik, pk);
    const json = JSON.stringify(projection);
    expect(json).toContain('192.168.1.42');
    expect(json).toContain('macbook-bridge');
    expect(json).toContain('personal-crm-foundation');
    expect(json).toContain('s3://acme-backups');
  });

  it('enterprise_audit includes the same surfaces as migration_full', async () => {
    const ik = generateEd25519Keypair('server_identity_key');
    const pk = generateEd25519Keypair('publisher_identity_key');
    const { projection } = await exportFor('enterprise_audit', ik, pk);
    const json = JSON.stringify(projection);
    expect(json).toContain('192.168.1.42');
    expect(json).toContain('macbook-bridge');
    expect(json).toContain('personal-crm-foundation');
  });
});

// ────────────────────────────────────────────────────────────────
// Audit row emission
// ────────────────────────────────────────────────────────────────

describe('D-148 P8 — audit row on every export', () => {
  it('emits one passport.exported row per export', async () => {
    const ik = generateEd25519Keypair('server_identity_key');
    const pk = generateEd25519Keypair('publisher_identity_key');
    const { audit } = await exportFor('support_redacted', ik, pk, 'support ticket #42');
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      action: 'passport.exported',
      target: 'passport-id-fixed',
    });
    expect(audit[0]?.detail).toContain('profile=support_redacted');
    expect(audit[0]?.detail).toContain('reason=support ticket #42');
  });

  it('replay export emits a second audit row with a fresh passport_id', async () => {
    const providers = (() => {
      const ik = generateEd25519Keypair('server_identity_key');
      const pk = generateEd25519Keypair('publisher_identity_key');
      return { providers: makeFixtureProviders(ik, pk), ik };
    })();
    const { emitter, rows } = makeAuditEmitter();
    const idCounter = (() => {
      let n = 0;
      return () => `passport-${++n}`;
    })();
    const exportOnce = async () =>
      exportServerPassport({
        providers: providers.providers,
        serverIdentity: providers.ik,
        audit: emitter,
        exported_by_client_id: 'br_1',
        options: { profile: 'support_redacted' },
        now: () => 1_700_000_000_000,
        mintId: idCounter,
      });
    await exportOnce();
    await exportOnce();
    expect(rows).toHaveLength(2);
    expect(rows[0]?.target).toBe('passport-1');
    expect(rows[1]?.target).toBe('passport-2');
  });

  it('history store appends one row per export when supplied', async () => {
    const ik = generateEd25519Keypair('server_identity_key');
    const pk = generateEd25519Keypair('publisher_identity_key');
    const providers = makeFixtureProviders(ik, pk);
    const { emitter } = makeAuditEmitter();
    const history = createInMemoryPassportHistoryStore();
    const idCounter = (() => {
      let n = 0;
      return () => `pp-${++n}`;
    })();
    await exportServerPassport({
      providers,
      serverIdentity: ik,
      audit: emitter,
      exported_by_client_id: 'br_1',
      options: { profile: 'enterprise_audit', reason: 'soc2-q2' },
      mintId: idCounter,
      history,
    });
    await exportServerPassport({
      providers,
      serverIdentity: ik,
      audit: emitter,
      exported_by_client_id: 'br_2',
      options: { profile: 'support_redacted' },
      mintId: idCounter,
      history,
    });
    const rows = await history.list();
    expect(rows).toHaveLength(2);
    // Most recent first per the store's contract.
    expect(rows[0]?.passport_id).toBe('pp-2');
    expect(rows[0]?.profile).toBe('support_redacted');
    expect(rows[1]?.profile).toBe('enterprise_audit');
    expect(rows[1]?.reason).toBe('soc2-q2');
  });
});

// ────────────────────────────────────────────────────────────────
// Migration import preserves publisher_id
// ────────────────────────────────────────────────────────────────

describe('D-148 P8 — migration import', () => {
  it('migration_full import preserves publisher_id + handle history', async () => {
    const ik = generateEd25519Keypair('server_identity_key');
    const pk = generateEd25519Keypair('publisher_identity_key');
    const providers = makeFixtureProviders(ik, pk, {
      handle: 'alice',
      handle_history: [
        { handle: 'alice-old', reserved_at: 1_650_000_000_000, released_at: 1_690_000_000_000 },
        { handle: 'alice', reserved_at: 1_690_000_000_000 },
      ],
    });
    const { emitter } = makeAuditEmitter();
    const projection = await exportServerPassport({
      providers,
      serverIdentity: ik,
      audit: emitter,
      exported_by_client_id: 'br_1',
      options: { profile: 'migration_full' },
    });
    const result = previewImportPassport(projection);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.publisher_id).toBe('pub_alice_42');
      expect(result.current_handle).toBe('alice');
      expect(result.handle_history).toHaveLength(2);
      expect(result.publisher_identity_fingerprint).toBe(pk.public_key_fingerprint);
    }
  });

  it('refuses to import support_redacted (cannot promote)', async () => {
    const ik = generateEd25519Keypair('server_identity_key');
    const pk = generateEd25519Keypair('publisher_identity_key');
    const { projection } = await exportFor('support_redacted', ik, pk);
    const result = previewImportPassport(projection);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('profile_not_migration_full');
    }
  });

  it('refuses to import enterprise_audit (different intent)', async () => {
    const ik = generateEd25519Keypair('server_identity_key');
    const pk = generateEd25519Keypair('publisher_identity_key');
    const { projection } = await exportFor('enterprise_audit', ik, pk);
    const result = previewImportPassport(projection);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('profile_not_migration_full');
    }
  });

  it('rejects tampered migration_full at import preview', async () => {
    const ik = generateEd25519Keypair('server_identity_key');
    const pk = generateEd25519Keypair('publisher_identity_key');
    const { projection } = await exportFor('migration_full', ik, pk);
    const tampered = {
      ...projection,
      identity: {
        ...projection.identity,
        publisher_id: 'evil_attacker',
      },
    } as ServerPassportProjection;
    const result = previewImportPassport(tampered);
    expect(result.ok).toBe(false);
  });

  it('rejects unsupported passport_version (correctness fold #7)', async () => {
    const ik = generateEd25519Keypair('server_identity_key');
    const pk = generateEd25519Keypair('publisher_identity_key');
    const { projection } = await exportFor('migration_full', ik, pk);
    const futureProjection = {
      ...projection,
      passport_version: '999',
    } as unknown as ServerPassportProjection;
    const result = previewImportPassport(futureProjection);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('unsupported_passport_version');
    }
  });
});

// ────────────────────────────────────────────────────────────────
// Versioning sanity check
// ────────────────────────────────────────────────────────────────

describe('D-148 P8 — passport version', () => {
  it('every export carries the substrate-fixed version', async () => {
    const ik = generateEd25519Keypair('server_identity_key');
    const pk = generateEd25519Keypair('publisher_identity_key');
    for (const profile of SERVER_PASSPORT_PROFILES) {
      const { projection } = await exportFor(profile, ik, pk);
      expect(projection.passport_version).toBe(SERVER_PASSPORT_VERSION);
    }
  });
});

// ────────────────────────────────────────────────────────────────
// collectFullPassport unit
// ────────────────────────────────────────────────────────────────

describe('D-148 P8 — collectFullPassport', () => {
  it('populates all six blocks from the providers', async () => {
    const ik = generateEd25519Keypair('server_identity_key');
    const pk = generateEd25519Keypair('publisher_identity_key');
    const providers = makeFixtureProviders(ik, pk);
    const collected = await collectFullPassport({
      providers,
      exported_by_client_id: 'br_1',
      now: () => 1_700_000_000_000,
      mintId: () => 'pp-fixed',
    });
    expect(collected.passport_id).toBe('pp-fixed');
    expect(collected.exported_at).toBe(1_700_000_000_000);
    expect(collected.identity.publisher_id).toBe('pub_alice_42');
    expect(collected.network.derived_preset_label).toBe('custom');
    expect(collected.network.per_path.ws.resolution).toEqual({ lan: true, public: true });
    expect(collected.clients).toHaveLength(4);
    expect(collected.capabilities.installed_packs).toEqual([
      'personal-crm-foundation',
      'sales-augmentation-hubspot',
    ]);
    expect(collected.recovery.backup_status).toBe('configured');
    expect(collected.key_health.master_dek?.status).toBe('healthy');
  });

  it('createPassportAuditEmitter wires logActivity through', async () => {
    const calls: ActivityEntry[] = [];
    const fakeStore = {
      logActivity: async (e: ActivityEntry) => {
        calls.push({ ...e });
      },
    };
    const emitter = createPassportAuditEmitter(
      fakeStore as unknown as Parameters<typeof createPassportAuditEmitter>[0],
    );
    await emitter.log({
      activity_id: '',
      timestamp: 1,
      action: 'passport.exported',
      target: 'pp-1',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.action).toBe('passport.exported');
  });
});
