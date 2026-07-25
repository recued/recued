/** D-148 P8 — Settings → Account → Passport renderer tests. */

import { describe, it, expect } from 'vitest';
import {
  buildPassportHistoryDisplay,
  evaluatePassportExport,
  findPassportProfileOption,
  inspectImportedPassport,
  PASSPORT_PROFILE_OPTIONS,
} from '../settings/passport.js';
import { SERVER_PASSPORT_VERSION, type ServerPassportProfile } from '@recued/contracts';

describe('D-148 P8 — passport profile picker', () => {
  it('exposes one option per profile', () => {
    const profiles = PASSPORT_PROFILE_OPTIONS.map((o) => o.profile);
    expect(profiles).toEqual(['support_redacted', 'enterprise_audit', 'migration_full']);
  });

  it('support_redacted requires no confirmation', () => {
    const opt = findPassportProfileOption('support_redacted');
    expect(opt?.requires_confirmation).toBe(false);
  });

  it('enterprise_audit and migration_full require confirmation', () => {
    expect(findPassportProfileOption('enterprise_audit')?.requires_confirmation).toBe(true);
    expect(findPassportProfileOption('migration_full')?.requires_confirmation).toBe(true);
  });

  it('migration_full names handle history in its exposure list', () => {
    const opt = findPassportProfileOption('migration_full');
    expect(opt?.exposes.some((e) => e.toLowerCase().includes('handle history'))).toBe(true);
  });
});

describe('D-148 P8 — evaluatePassportExport', () => {
  it('accepts support_redacted without confirmation', () => {
    const r = evaluatePassportExport({
      profile: 'support_redacted',
      user_confirmed: false,
    });
    expect(r.ok).toBe(true);
  });

  it('rejects enterprise_audit without confirmation', () => {
    const r = evaluatePassportExport({
      profile: 'enterprise_audit',
      user_confirmed: false,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBe('confirmation_required');
    }
  });

  it('accepts enterprise_audit with confirmation', () => {
    const r = evaluatePassportExport({
      profile: 'enterprise_audit',
      user_confirmed: true,
      reason: 'q3 audit',
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.options).toEqual({ profile: 'enterprise_audit', reason: 'q3 audit' });
    }
  });

  it('rejects unknown profile', () => {
    const r = evaluatePassportExport({
      profile: 'nope' as ServerPassportProfile,
      user_confirmed: true,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBe('profile_unknown');
    }
  });

  it('rejects reason > 1 KB', () => {
    const big = 'a'.repeat(2000);
    const r = evaluatePassportExport({
      profile: 'support_redacted',
      user_confirmed: false,
      reason: big,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBe('reason_too_long');
    }
  });
});

describe('D-148 P8 — inspectImportedPassport', () => {
  const buildMigration = () => ({
    passport_version: SERVER_PASSPORT_VERSION,
    profile: 'migration_full' as const,
    passport_id: 'pp-1',
    exported_at: 1_700_000_000_000,
    exported_by_client_id: 'cli',
    identity: {
      server_public_key: 'b64-pk',
      server_identity_fingerprint: 'sha256:srv',
      publisher_id: 'pub_1',
      current_handle: 'alice',
      handle_history: [{ handle: 'alice', reserved_at: 1_690_000_000_000 }],
      publisher_identity_fingerprint: 'sha256:pub',
    },
    network: {},
    clients: [],
    capabilities: {},
    recovery: {},
    key_health: {},
    signature: 'sig',
  });

  it('parses a well-formed migration_full payload', () => {
    const r = inspectImportedPassport(JSON.stringify(buildMigration()));
    expect(r.ok).toBe(true);
    expect(r.publisher_id).toBe('pub_1');
    expect(r.current_handle).toBe('alice');
    expect(r.handle_history_count).toBe(1);
    expect(r.signer_fingerprint).toBe('sha256:srv');
  });

  it('rejects invalid JSON', () => {
    const r = inspectImportedPassport('{nope');
    expect(r.ok).toBe(false);
    expect(r.error).toBe('invalid_json');
  });

  it('rejects unsupported passport_version', () => {
    const m = buildMigration();
    const r = inspectImportedPassport(JSON.stringify({ ...m, passport_version: '999' }));
    expect(r.ok).toBe(false);
    expect(r.error).toBe('unsupported_passport_version');
  });

  it('rejects non-migration profiles', () => {
    const m = buildMigration();
    const r = inspectImportedPassport(JSON.stringify({ ...m, profile: 'support_redacted' }));
    expect(r.ok).toBe(false);
    expect(r.error).toBe('profile_not_migration_full');
  });

  it('rejects malformed identity block', () => {
    const m = buildMigration();
    const r = inspectImportedPassport(
      JSON.stringify({ ...m, identity: { ...m.identity, publisher_id: undefined } }),
    );
    expect(r.ok).toBe(false);
    expect(r.error).toBe('identity_block_incomplete');
  });
});

describe('D-148 P8 — buildPassportHistoryDisplay', () => {
  it('sorts by exported_at descending', () => {
    const rows = buildPassportHistoryDisplay({
      rows: [
        {
          passport_id: 'pp-1',
          profile: 'support_redacted',
          exported_at: 1,
          exported_by_client_id: 'cli',
          signer_fingerprint: 'sha256:a',
        },
        {
          passport_id: 'pp-2',
          profile: 'enterprise_audit',
          exported_at: 3,
          exported_by_client_id: 'cli',
          signer_fingerprint: 'sha256:a',
        },
        {
          passport_id: 'pp-3',
          profile: 'migration_full',
          exported_at: 2,
          exported_by_client_id: 'cli',
          signer_fingerprint: 'sha256:b',
        },
      ],
      current_signer_fingerprint: 'sha256:a',
    });
    expect(rows.map((r) => r.passport_id)).toEqual(['pp-2', 'pp-3', 'pp-1']);
  });

  it('flags pre-rotation signers', () => {
    const rows = buildPassportHistoryDisplay({
      rows: [
        {
          passport_id: 'pp-old',
          profile: 'support_redacted',
          exported_at: 1,
          exported_by_client_id: 'cli',
          signer_fingerprint: 'sha256:OLD',
        },
        {
          passport_id: 'pp-new',
          profile: 'support_redacted',
          exported_at: 2,
          exported_by_client_id: 'cli',
          signer_fingerprint: 'sha256:NEW',
        },
      ],
      current_signer_fingerprint: 'sha256:NEW',
    });
    expect(rows[0]?.signer_pre_rotation).toBeUndefined();
    expect(rows[1]?.signer_pre_rotation).toBe(true);
  });

  it('does NOT flag pre_rotation when no current_signer_fingerprint provided', () => {
    const rows = buildPassportHistoryDisplay({
      rows: [
        {
          passport_id: 'pp',
          profile: 'support_redacted',
          exported_at: 1,
          exported_by_client_id: 'cli',
          signer_fingerprint: 'sha256:OLD',
        },
      ],
    });
    expect(rows[0]?.signer_pre_rotation).toBeUndefined();
  });
});
