import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { VaultQuotaExceededError, type VaultStore } from '@recued/storage';
import {
  createServerVaultStore,
  loadVaultAsObject,
  listVaultPublishers,
} from '../server-vault.js';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
});

// ────────────────────────────────────────────────────────────────
// createServerVaultStore — DEK management
// ────────────────────────────────────────────────────────────────

describe('createServerVaultStore — DEK lifecycle', () => {
  it('generates a DEK on first call and persists it in server_dek', async () => {
    await createServerVaultStore(db);
    const row = db.prepare('SELECT id, key_base64, created_at FROM server_dek WHERE id = 1')
      .get() as { id: number; key_base64: string; created_at: number } | undefined;
    expect(row).toBeDefined();
    expect(row!.id).toBe(1);
    expect(typeof row!.key_base64).toBe('string');
    expect(row!.key_base64.length).toBeGreaterThan(0);
    expect(typeof row!.created_at).toBe('number');
  });

  it('reuses the existing DEK on subsequent calls — values survive reopen', async () => {
    const vault1 = await createServerVaultStore(db);
    await vault1.set('recued-core', 'hubspot_token', 'secret-123');

    // Same DB, new vault instance — should import the same DEK and decrypt.
    const vault2 = await createServerVaultStore(db);
    const value = await vault2.get('recued-core', 'hubspot_token');
    expect(value).toBe('secret-123');
  });

  it('rejects a second DEK row (PRIMARY KEY CHECK id=1)', async () => {
    await createServerVaultStore(db);
    expect(() =>
      db.prepare('INSERT INTO server_dek (id, key_base64, created_at) VALUES (?, ?, ?)')
        .run(2, 'other', Date.now()),
    ).toThrow();
  });
});

// ────────────────────────────────────────────────────────────────
// createServerVaultStore — roundtrip through VaultStore API
// ────────────────────────────────────────────────────────────────

describe('createServerVaultStore — VaultStore roundtrip', () => {
  it('encrypts set() and decrypts get()', async () => {
    const vault = await createServerVaultStore(db);
    await vault.set('recued-core', 'exa_key', 'plaintext-value');

    // Raw row in the underlying collection must NOT be plaintext.
    const raw = db.prepare('SELECT data FROM server_vault WHERE key = ?')
      .get('vault.recued-core.exa_key') as { data: string } | undefined;
    expect(raw).toBeDefined();
    expect(raw!.data).not.toContain('plaintext-value');

    expect(await vault.get('recued-core', 'exa_key')).toBe('plaintext-value');
  });

  it('has() reflects set/delete', async () => {
    const vault = await createServerVaultStore(db);
    expect(await vault.has('recued-core', 'k')).toBe(false);
    await vault.set('recued-core', 'k', 'v');
    expect(await vault.has('recued-core', 'k')).toBe(true);
    await vault.delete('recued-core', 'k');
    expect(await vault.has('recued-core', 'k')).toBe(false);
  });

  it('get() returns null for missing key', async () => {
    const vault = await createServerVaultStore(db);
    expect(await vault.get('recued-core', 'missing')).toBeNull();
  });

  it('listByPublisher() returns only entries under that scope', async () => {
    const vault = await createServerVaultStore(db);
    await vault.set('recued-core', 'a', 'A');
    await vault.set('recued-core', 'b', 'B');
    await vault.set('other-pub', 'c', 'C');

    const core = await vault.listByPublisher('recued-core');
    expect(core.map(e => e.key).sort()).toEqual(['a', 'b']);
    expect(core.find(e => e.key === 'a')?.value).toBe('A');

    const other = await vault.listByPublisher('other-pub');
    expect(other).toEqual([{ key: 'c', value: 'C' }]);
  });
});

// ────────────────────────────────────────────────────────────────
// loadVaultAsObject
// ────────────────────────────────────────────────────────────────

describe('loadVaultAsObject', () => {
  it('groups decrypted values by publisher', async () => {
    const vault = await createServerVaultStore(db);
    await vault.set('recued-core', 'hubspot_token', 'hs-1');
    await vault.set('recued-core', 'exa_key', 'ex-1');
    await vault.set('third-party', 'api_key', 'tp-1');

    const out = await loadVaultAsObject(vault, ['recued-core', 'third-party']);
    expect(out).toEqual({
      'recued-core': { hubspot_token: 'hs-1', exa_key: 'ex-1' },
      'third-party': { api_key: 'tp-1' },
    });
  });

  it('omits publishers that have no entries', async () => {
    const vault = await createServerVaultStore(db);
    await vault.set('recued-core', 'k', 'v');

    const out = await loadVaultAsObject(vault, ['recued-core', 'empty-pub']);
    expect(Object.keys(out)).toEqual(['recued-core']);
    expect('empty-pub' in out).toBe(false);
  });

  it('returns an empty object when no publishers are requested', async () => {
    const vault = await createServerVaultStore(db);
    await vault.set('recued-core', 'k', 'v');
    expect(await loadVaultAsObject(vault, [])).toEqual({});
  });

  it('returns an empty object when vault is empty', async () => {
    const vault = await createServerVaultStore(db);
    expect(await loadVaultAsObject(vault, ['recued-core'])).toEqual({});
  });

  it('drops prototype-sensitive publisher and key names', async () => {
    const proto = Object.prototype as Record<string, unknown>;
    delete proto.vaultPolluted;
    const fakeVault = {
      listByPublisher: async (pub: string) => {
        if (pub === '__proto__') return [{ key: 'vaultPolluted', value: 'yes' }];
        if (pub === 'recued-core') {
          return [
            { key: '__proto__', value: 'bad' },
            { key: 'constructor', value: 'bad' },
            { key: 'safe_key', value: 'ok' },
          ];
        }
        return [];
      },
    } as unknown as VaultStore;

    const out = await loadVaultAsObject(fakeVault, ['__proto__', 'recued-core']);
    const polluted = Object.prototype.hasOwnProperty.call(proto, 'vaultPolluted');
    delete proto.vaultPolluted;

    expect(polluted).toBe(false);
    expect(out).toEqual({ 'recued-core': { safe_key: 'ok' } });
  });
});

// ────────────────────────────────────────────────────────────────
// listVaultPublishers
// ────────────────────────────────────────────────────────────────

describe('listVaultPublishers', () => {
  it('returns empty when no vault rows exist', async () => {
    await createServerVaultStore(db); // ensures server_vault table exists
    expect(await listVaultPublishers(db)).toEqual([]);
  });

  it('deduplicates publishers across multiple keys', async () => {
    const vault = await createServerVaultStore(db);
    await vault.set('recued-core', 'a', '1');
    await vault.set('recued-core', 'b', '2');
    await vault.set('other', 'x', '3');

    const pubs = await listVaultPublishers(db);
    expect(pubs.sort()).toEqual(['other', 'recued-core']);
  });

  it('ignores rows whose key does not match the vault.{publisher}.{key} shape', async () => {
    const vault = await createServerVaultStore(db);
    await vault.set('recued-core', 'a', '1');

    // Poke an unexpected key directly — the extractor should skip it.
    db.prepare('INSERT INTO server_vault (key, data) VALUES (?, ?)')
      .run('weird-shape', '{"noise": true}');
    db.prepare('INSERT INTO server_vault (key, data) VALUES (?, ?)')
      .run('other.not-vault.x', '{"noise": true}');

    expect(await listVaultPublishers(db)).toEqual(['recued-core']);
  });

  it('ignores prototype-sensitive publisher segments', async () => {
    await createServerVaultStore(db); // ensures table exists
    db.prepare('INSERT INTO server_vault (key, data) VALUES (?, ?)')
      .run('vault.__proto__.token', '{"noise": true}');
    db.prepare('INSERT INTO server_vault (key, data) VALUES (?, ?)')
      .run('vault.constructor.token', '{"noise": true}');
    db.prepare('INSERT INTO server_vault (key, data) VALUES (?, ?)')
      .run('vault.recued-core.token', '{"noise": true}');

    expect(await listVaultPublishers(db)).toEqual(['recued-core']);
  });

  it('keeps only the publisher segment (parts[1]) of deeply nested keys', async () => {
    const vault = await createServerVaultStore(db);
    await vault.set('recued-core', 'nested.path.key', 'v'); // scopedVaultKey uses simple concat
    const pubs = await listVaultPublishers(db);
    expect(pubs).toEqual(['recued-core']);
  });
});

// ────────────────────────────────────────────────────────────────
// D-103 Phase A: quota pass-through
// ────────────────────────────────────────────────────────────────

describe('createServerVaultStore — quotas', () => {
  it('passes per-publisher + total caps through to the underlying VaultStore', async () => {
    const vault = await createServerVaultStore(db, {
      quotas: { perPublisherBytes: 50, totalBytes: 1000 },
    });
    await vault.set('recued-core', 'a', 'x'.repeat(40));
    await expect(vault.set('recued-core', 'b', 'y'.repeat(40)))
      .rejects.toBeInstanceOf(VaultQuotaExceededError);
  });

  it('without quotas, arbitrary sizes are accepted', async () => {
    const vault = await createServerVaultStore(db);
    await vault.set('recued-core', 'big', 'x'.repeat(10_000));
    expect(await vault.get('recued-core', 'big')).toHaveLength(10_000);
  });
});
