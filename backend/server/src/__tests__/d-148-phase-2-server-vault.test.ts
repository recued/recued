/** D-148 P2 — server_vault encrypted with sub_dek.vault.
 *
 *  Acceptance per spec § P2 + § A.2.3:
 *   - Vault store created with master_dek derives the same vault DEK
 *     deterministically across restarts.
 *   - Roundtrip: write → read returns plaintext.
 *   - On-disk row carries ciphertext (not plaintext).
 *   - Corrupting ciphertext fails decrypt cleanly.
 *   - Different master_dek → different vault DEK → cross-decrypt fails.
 *   - Legacy path (no master_dek) still works for backwards compat.
 *   - Independent: changing master_dek between boots fails decrypt
 *     (proves the derivation actually depends on the master_dek).
 */

import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServerVaultStore } from '../server-vault.js';
import { deriveSubDEK, randomBytes } from '@recued/crypto';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
});

afterEach(() => {
  db.close();
});

describe('D-148 P2 — server_vault sub_dek.vault path', () => {
  it('writes + reads with master_dek derivation', async () => {
    const master_dek = randomBytes(32);
    const vault = await createServerVaultStore(db, { master_dek });
    await vault.set('recued-core', 'hubspot.token', 'secret-bearer-1');
    expect(await vault.get('recued-core', 'hubspot.token')).toBe('secret-bearer-1');
  });

  it('survives restart when master_dek is the same', async () => {
    const master_dek = randomBytes(32);
    const vault1 = await createServerVaultStore(db, { master_dek });
    await vault1.set('recued-core', 'hubspot.token', 'secret-bearer-2');
    // Re-open the same SQLite DB with a fresh vault store + same
    // master_dek (simulates a reboot + the KeyManager unlock flow).
    const vault2 = await createServerVaultStore(db, { master_dek });
    expect(await vault2.get('recued-core', 'hubspot.token')).toBe('secret-bearer-2');
  });

  it('different master_dek fails to decrypt prior rows', async () => {
    const master_dek_a = randomBytes(32);
    const master_dek_b = randomBytes(32);
    const vault_a = await createServerVaultStore(db, { master_dek: master_dek_a });
    await vault_a.set('recued-core', 'hubspot.token', 'secret-under-master-A');
    // Open same DB with different master_dek — decrypt should fail.
    const vault_b = await createServerVaultStore(db, { master_dek: master_dek_b });
    await expect(vault_b.get('recued-core', 'hubspot.token')).rejects.toThrow();
  });

  it('on-disk row carries ciphertext, not plaintext', async () => {
    const master_dek = randomBytes(32);
    const vault = await createServerVaultStore(db, { master_dek });
    await vault.set('recued-core', 'leak-test', 'CANARY-PLAINTEXT-VALUE');
    // Read raw row directly from SQLite — should NOT contain the
    // canary string.
    const rows = db.prepare('SELECT key, data FROM server_vault').all() as Array<{
      key: string;
      data: string;
    }>;
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.data).not.toContain('CANARY-PLAINTEXT-VALUE');
    }
  });

  it('corrupting ciphertext fails decrypt cleanly', async () => {
    const master_dek = randomBytes(32);
    const vault = await createServerVaultStore(db, { master_dek });
    await vault.set('recued-core', 'k', 'val');
    // Tamper with the on-disk row.
    db.prepare('UPDATE server_vault SET data = ? WHERE key = ?').run(
      'eyJ0YW1wZXJlZCI6IHRydWV9', // base64 garbage
      'vault.recued-core.k',
    );
    await expect(vault.get('recued-core', 'k')).rejects.toThrow();
  });

  it('legacy path (no master_dek) still works for backwards compat', async () => {
    const vault = await createServerVaultStore(db);
    await vault.set('recued-core', 'legacy-key', 'legacy-secret');
    expect(await vault.get('recued-core', 'legacy-key')).toBe('legacy-secret');
  });
});

describe('D-148 P2 — sub_dek.vault deterministic derivation', () => {
  it('deriveSubDEK with the same master + domain produces the same key', () => {
    const master = randomBytes(32);
    const a = deriveSubDEK(master, 'vault');
    const b = deriveSubDEK(master, 'vault');
    expect(Array.from(a)).toEqual(Array.from(b));
    expect(a.length).toBe(32);
  });

  it('different domain salt produces different sub-DEK', () => {
    const master = randomBytes(32);
    const vault_dek = deriveSubDEK(master, 'vault');
    const audit_dek = deriveSubDEK(master, 'server-data');
    expect(Array.from(vault_dek)).not.toEqual(Array.from(audit_dek));
  });
});
