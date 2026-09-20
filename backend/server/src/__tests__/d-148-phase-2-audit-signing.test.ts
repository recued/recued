/** D-148 P2 — high-assurance audit signing.
 *
 *  Acceptance per spec § P2 + § A.2.5:
 *   - Emit `key_rotation` audit row → signature populated.
 *   - Verifier reads + verifies the signature against the server
 *     public key.
 *   - Tampered row fails verify.
 *   - Non-high-assurance rows pass through unchanged (no signature).
 *   - Signing wrapper picks up the *current* server identity at each
 *     call (so post-rotation writes use the new key).
 *   - Verifier surfaces the failure reason in a closed taxonomy.
 *   - HIGH_ASSURANCE_AUDIT_KINDS rows that are missing a signature
 *     are flagged as tampered.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  createAuditLogStore,
  createInMemoryCollection,
  type ActivityEntry,
  type AuditEntry,
  type AuditLogStore,
} from '@recued/storage';
import {
  signActivityEntry,
  verifyActivityEntry,
  isActivityEntryTampered,
  createSigningAuditLog,
} from '../audit/signing.js';
import { generateEd25519Keypair } from '../keys/index.js';
import { createServerIdentity } from '../identity/index.js';
import { createInMemoryServerKeyStore } from '../keys/index.js';

const makeBasicLog = (): AuditLogStore =>
  createAuditLogStore(
    createInMemoryCollection<AuditEntry>(),
    createInMemoryCollection<ActivityEntry>(),
  );

const baseEntry = (action: string): ActivityEntry => ({
  activity_id: `act-${action}-${Math.random().toString(36).slice(2, 8)}`,
  timestamp: 1_700_000_000_000,
  action: action as ActivityEntry['action'],
  target: 'system',
  detail: `kind=${action}`,
});

describe('D-148 P2 — signActivityEntry + verifyActivityEntry round-trip', () => {
  it('signs + verifies a key_rotation row', () => {
    const server_identity = generateEd25519Keypair('server_identity_key');
    const entry = baseEntry('key_rotation');
    const signed = signActivityEntry(entry, server_identity);
    expect(typeof signed.signature).toBe('string');
    expect(signed.signature!.length).toBeGreaterThan(0);
    // Codex P1 #1 fold — signer fingerprint is recorded.
    expect(signed.signer_fingerprint).toBe(server_identity.public_key_fingerprint);
    const result = verifyActivityEntry(signed, server_identity.public_key_b64);
    expect(result.ok).toBe(true);
  });

  it('⛔⛔ a LEGACY row — signed, no signer_fingerprint — still verifies', () => {
    // ⚠ FOUND BY MUTATION (2026-09-18). `stripSignatureFields` early-returns
    // only when BOTH fields are absent; flipping that `&&` to `||` survived
    // every test, because no fixture has one without the other.
    //
    // ⛔ THE MODULE'S OWN COMMENT SAYS THESE ROWS EXIST: "rows signed before
    // fingerprint recording landed have no fingerprint". Under the mutant such
    // a row is handed to the verifier UNSTRIPPED — signature included in its
    // own signed bytes — so it can never verify. Every high-assurance row
    // written before that field landed would read as TAMPERED, which is the
    // worst possible false positive for an audit trail: it accuses the record
    // of exactly what it exists to disprove.
    const server_identity = generateEd25519Keypair('server_identity_key');
    const signed = signActivityEntry(baseEntry('pair_revoke'), server_identity);
    const { signer_fingerprint: _dropped, ...legacy } = signed;
    expect(legacy.signature).toBeDefined();
    expect('signer_fingerprint' in legacy).toBe(false);

    // The single-key resolver is the documented fallback for exactly this row.
    const result = verifyActivityEntry(legacy as ActivityEntry, server_identity.public_key_b64);
    expect(result.ok, 'a pre-fingerprint row was reported as unverifiable').toBe(true);
  });

  it('⚠ and an unsigned row carrying a stray fingerprint signs the same way', () => {
    // The other half of the `&&`: a row with a fingerprint but no signature
    // must still have that fingerprint stripped before signing, or the
    // signature commits to a fingerprint of the key about to sign it — the
    // circularity the strip exists to prevent.
    const server_identity = generateEd25519Keypair('server_identity_key');
    const withStray = {
      ...baseEntry('pair_revoke'),
      signer_fingerprint: 'sha256:stale',
    } as ActivityEntry;
    const signed = signActivityEntry(withStray, server_identity);
    expect(signed.signer_fingerprint).toBe(server_identity.public_key_fingerprint);
    expect(verifyActivityEntry(signed, server_identity.public_key_b64).ok).toBe(true);
  });

  it('verify fails when row is tampered', () => {
    const server_identity = generateEd25519Keypair('server_identity_key');
    const entry = baseEntry('key_rotation');
    const signed = signActivityEntry(entry, server_identity);
    const tampered: ActivityEntry = { ...signed, target: 'attacker-substituted-target' };
    const result = verifyActivityEntry(tampered, server_identity.public_key_b64);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('signature_invalid');
  });

  it('verify fails when signature missing', () => {
    const entry = baseEntry('key_rotation');
    const result = verifyActivityEntry(entry, 'pubkey-base64');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('signature_missing');
  });

  it('verify fails when signature malformed', () => {
    const server_identity = generateEd25519Keypair('server_identity_key');
    const entry = { ...baseEntry('key_rotation'), signature: '' };
    const result = verifyActivityEntry(entry, server_identity.public_key_b64);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('signature_malformed');
  });

  it('verify fails on empty pubkey', () => {
    const server_identity = generateEd25519Keypair('server_identity_key');
    const entry = signActivityEntry(baseEntry('key_rotation'), server_identity);
    const result = verifyActivityEntry(entry, '');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('public_key_malformed');
  });

  it('different server identity fails verify', () => {
    const a = generateEd25519Keypair('server_identity_key');
    const b = generateEd25519Keypair('server_identity_key');
    const entry = signActivityEntry(baseEntry('key_rotation'), a);
    const result = verifyActivityEntry(entry, b.public_key_b64);
    expect(result.ok).toBe(false);
  });

  it('signature stripping is idempotent — re-sign produces same bytes', () => {
    const server_identity = generateEd25519Keypair('server_identity_key');
    const entry = baseEntry('key_rotation');
    const a = signActivityEntry(entry, server_identity);
    const b = signActivityEntry(a, server_identity); // re-sign already-signed
    // Same signature bytes since the canonical-stripped entry is identical.
    expect(b.signature).toBe(a.signature);
    expect(b.signer_fingerprint).toBe(a.signer_fingerprint);
  });

  it('Codex P1 #1 fold — rotation-aware verify via PublicKeyResolver function', () => {
    // Two server identities — sign with the first, rotate to the
    // second, verify the original row via a key-history resolver.
    const v1 = generateEd25519Keypair('server_identity_key');
    const v2 = generateEd25519Keypair('server_identity_key');
    const entry_signed_by_v1 = signActivityEntry(baseEntry('key_rotation'), v1);
    expect(entry_signed_by_v1.signer_fingerprint).toBe(v1.public_key_fingerprint);
    // Single-key resolver = current key only. v2 fails because the
    // row was signed by v1.
    expect(verifyActivityEntry(entry_signed_by_v1, v2.public_key_b64).ok).toBe(false);
    // Rotation-aware resolver knows about both. Looks up by
    // fingerprint + finds v1 → verifies.
    const history: Record<string, string> = {
      [v1.public_key_fingerprint]: v1.public_key_b64,
      [v2.public_key_fingerprint]: v2.public_key_b64,
    };
    const result = verifyActivityEntry(
      entry_signed_by_v1,
      (fp) => history[fp] ?? null,
    );
    expect(result.ok).toBe(true);
  });

  it('Codex P1 #1 fold — resolver returning null surfaces signer_fingerprint_unknown', () => {
    const v1 = generateEd25519Keypair('server_identity_key');
    const entry = signActivityEntry(baseEntry('key_rotation'), v1);
    const result = verifyActivityEntry(entry, () => null);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('signer_fingerprint_unknown');
  });

  it('Codex P1 #1 fold — resolver path on unsigned row surfaces signature_missing', () => {
    const entry = baseEntry('key_rotation'); // no signature
    const result = verifyActivityEntry(entry, () => 'pubkey-b64');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('signature_missing');
  });

  it('Codex P1 #1 fold — resolver path on row with no fingerprint surfaces signer_fingerprint_unknown', () => {
    // Row has signature but no fingerprint (legacy / untrusted).
    const v1 = generateEd25519Keypair('server_identity_key');
    const entry = signActivityEntry(baseEntry('key_rotation'), v1);
    const stripped = { ...entry };
    delete (stripped as Partial<typeof stripped>).signer_fingerprint;
    const result = verifyActivityEntry(stripped, () => 'whatever');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('signer_fingerprint_unknown');
  });
});

describe('D-148 P2 — isActivityEntryTampered', () => {
  it('flags a high-assurance row missing its signature', () => {
    const server_identity = generateEd25519Keypair('server_identity_key');
    const entry = baseEntry('key_rotation'); // no signature
    expect(isActivityEntryTampered(entry, server_identity.public_key_b64)).toBe(true);
  });

  it('returns false for non-high-assurance rows (no signature required)', () => {
    const server_identity = generateEd25519Keypair('server_identity_key');
    const entry = baseEntry('install'); // not in HIGH_ASSURANCE_AUDIT_KINDS
    expect(isActivityEntryTampered(entry, server_identity.public_key_b64)).toBe(false);
  });

  it('returns false for a properly-signed high-assurance row', () => {
    const server_identity = generateEd25519Keypair('server_identity_key');
    const entry = signActivityEntry(baseEntry('key_rotation'), server_identity);
    expect(isActivityEntryTampered(entry, server_identity.public_key_b64)).toBe(false);
  });

  it('flags a high-assurance row signed with the wrong key', () => {
    const a = generateEd25519Keypair('server_identity_key');
    const b = generateEd25519Keypair('server_identity_key');
    const entry = signActivityEntry(baseEntry('key_rotation'), a);
    expect(isActivityEntryTampered(entry, b.public_key_b64)).toBe(true);
  });
});

describe('D-148 P2 — createSigningAuditLog wrapper', () => {
  it('signs HIGH_ASSURANCE rows + leaves others unchanged', async () => {
    const underlying = makeBasicLog();
    const server_identity = generateEd25519Keypair('server_identity_key');
    const wrapped = createSigningAuditLog(underlying, {
      getServerIdentity: () => server_identity,
    });
    await wrapped.logActivity(baseEntry('key_rotation'));
    await wrapped.logActivity(baseEntry('install'));
    const rows = await underlying.listActivities();
    const ks = rows.find((r) => r.action === 'key_rotation');
    const inst = rows.find((r) => r.action === 'install');
    expect(ks?.signature).toBeTruthy();
    expect(inst?.signature).toBeUndefined();
  });

  it('signed row verifies against the server public key', async () => {
    const underlying = makeBasicLog();
    const server_identity = generateEd25519Keypair('server_identity_key');
    const wrapped = createSigningAuditLog(underlying, {
      getServerIdentity: () => server_identity,
    });
    await wrapped.logActivity(baseEntry('exposure_path_resolution_change'));
    const rows = await underlying.listActivities();
    const row = rows.find((r) => r.action === 'exposure_path_resolution_change');
    expect(row).toBeDefined();
    expect(verifyActivityEntry(row!, server_identity.public_key_b64).ok).toBe(true);
  });

  it('post-rotation writes use the new key', async () => {
    const store = createInMemoryServerKeyStore();
    const id = createServerIdentity({ store });
    const underlying = makeBasicLog();
    const wrapped = createSigningAuditLog(underlying, {
      getServerIdentity: () => id.serverIdentityKey(),
    });
    await wrapped.logActivity(baseEntry('key_rotation'));
    const before = id.serverIdentityKey().public_key_b64;
    await id.rotateServerIdentity();
    const after = id.serverIdentityKey().public_key_b64;
    expect(after).not.toBe(before);
    await wrapped.logActivity(baseEntry('handle_change'));
    const rows = await underlying.listActivities();
    const pre = rows.find((r) => r.action === 'key_rotation');
    const post = rows.find((r) => r.action === 'handle_change');
    expect(verifyActivityEntry(pre!, before).ok).toBe(true);
    expect(verifyActivityEntry(pre!, after).ok).toBe(false);
    expect(verifyActivityEntry(post!, after).ok).toBe(true);
    expect(verifyActivityEntry(post!, before).ok).toBe(false);
  });

  it('passthrough methods unchanged', async () => {
    const underlying = makeBasicLog();
    const server_identity = generateEd25519Keypair('server_identity_key');
    const wrapped = createSigningAuditLog(underlying, {
      getServerIdentity: () => server_identity,
    });
    // Smoke test pass-through.
    await wrapped.logActivity(baseEntry('install'));
    expect((await wrapped.listActivities()).length).toBe(1);
    expect(await wrapped.size()).toBe(0); // append() not called
  });

  it('shouldSign override narrows the predicate', async () => {
    const underlying = makeBasicLog();
    const server_identity = generateEd25519Keypair('server_identity_key');
    const wrapped = createSigningAuditLog(underlying, {
      getServerIdentity: () => server_identity,
      shouldSign: (action) => action === 'key_rotation', // only sign rotations
    });
    await wrapped.logActivity(baseEntry('key_rotation'));
    await wrapped.logActivity(baseEntry('exposure_path_resolution_change'));
    const rows = await underlying.listActivities();
    expect(rows.find((r) => r.action === 'key_rotation')?.signature).toBeTruthy();
    expect(rows.find((r) => r.action === 'exposure_path_resolution_change')?.signature)
      .toBeUndefined();
  });

  it('logActivity is invoked exactly once per call (no double-write)', async () => {
    const underlying = makeBasicLog();
    const spy = vi.spyOn(underlying, 'logActivity');
    const server_identity = generateEd25519Keypair('server_identity_key');
    const wrapped = createSigningAuditLog(underlying, {
      getServerIdentity: () => server_identity,
    });
    await wrapped.logActivity(baseEntry('key_rotation'));
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('D-153 follow-on — listBy* pass-throughs forward the axis arg', async () => {
    // Codex review found the wrapper dropped the new third positional
    // `axis` parameter on the three D-153 tier-scope listBy* methods,
    // so production callers (which always wrap the underlying store
    // via createSigningAuditLog) reached storage as `axis=undefined`
    // and got ingestion-axis ordering regardless of the rpc-level
    // axis arg. This test pins the pass-through behaviour explicitly.
    const underlying = makeBasicLog();
    const ch = vi.spyOn(underlying, 'listByChannelSession');
    const cog = vi.spyOn(underlying, 'listByCognitionSession');
    const corr = vi.spyOn(underlying, 'listByCorrelation');
    const server_identity = generateEd25519Keypair('server_identity_key');
    const wrapped = createSigningAuditLog(underlying, {
      getServerIdentity: () => server_identity,
    });
    await wrapped.listByChannelSession('ch-1', 5, 'event');
    await wrapped.listByCognitionSession('cog-1', 7, 'ingestion');
    await wrapped.listByCorrelation('corr-1', 9, 'event');
    expect(ch).toHaveBeenCalledWith('ch-1', 5, 'event');
    expect(cog).toHaveBeenCalledWith('cog-1', 7, 'ingestion');
    expect(corr).toHaveBeenCalledWith('corr-1', 9, 'event');
  });
});

describe('D-148 P2 — high-assurance row reserve discipline (auto-classified)', () => {
  it('key_rotation rows are reserve-classified by RESERVE_ACTIONS', async () => {
    const underlying = makeBasicLog();
    const server_identity = generateEd25519Keypair('server_identity_key');
    const wrapped = createSigningAuditLog(underlying, {
      getServerIdentity: () => server_identity,
    });
    await wrapped.logActivity(baseEntry('key_rotation'));
    const rows = await underlying.listActivities();
    expect(rows[0]!.reserve).toBe(true);
  });

  it('all 9 high-assurance kinds reserve-classified (W3.5 swaps exposure_profile_change for the per-path kinds)', async () => {
    const underlying = makeBasicLog();
    const server_identity = generateEd25519Keypair('server_identity_key');
    const wrapped = createSigningAuditLog(underlying, {
      getServerIdentity: () => server_identity,
    });
    const kinds = [
      'key_rotation',
      'exposure_path_resolution_change',
      'exposure_preset_apply',
      'handle_change',
      'pair_revoke',
      'cert_renewal',
      'passport.exported',
      'public_mcp_acknowledged',
      'public_mcp_revoked',
    ];
    for (const k of kinds) {
      await wrapped.logActivity(baseEntry(k));
    }
    const rows = await underlying.listActivities();
    for (const row of rows) {
      expect(row.reserve).toBe(true);
    }
  });
});
