import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { createInstanceStore } from '../collections/instance-store.js';
import { createCollectionRegistry } from '../collections/registry.js';
import { createCollectionTable } from '../collections/table.js';
import { handleMailBodyRead } from '../mail-body-read-handler.js';
import { registerMcpReadonlyMailCollections } from '../mcp-readonly-mail-collections.js';
import { createBlobStore } from '../storage/blob-store.js';

describe('standalone MCP read-only mail registry', () => {
  it('reads the existing mirror without starting a provider or admitting mutations', async () => {
    const db = new Database(':memory:');
    const instances = createInstanceStore({ db, now: () => 100 });
    instances.upsert({
      platform: 'mail',
      slug: 'work',
      adapter_type: 'imap',
      config: { quota_bytes: 1024 * 1024 },
      caps: {
        read: 'yes',
        write: 'no',
        delete: 'no',
        watch: 'realtime',
        mirror: 'required',
        auth: 'oauth',
        path_style: 'uri',
      },
      auth_state: 'healthy',
      last_synced_at: 99,
    });
    const table = createCollectionTable({ db, platform: 'mail', slug: 'work' });
    table.upsert({
      record_id: 'mail:1',
      received_at: 10,
      modified_at: 10,
      size_bytes: 12,
      source_id: 'provider-1',
      hot_fields: {
        from: 'alice@example.com',
        subject: 'Need a reply',
        thread_id: 'thread-1',
      },
      body_inline: 'Please reply',
    });

    const registry = createCollectionRegistry();
    expect(registerMcpReadonlyMailCollections({ db, registry })).toBe(1);
    const collection = registry.get('mail', 'work');
    expect(collection?.get('mail:1')).toMatchObject({
      body_inline: 'Please reply',
      hot_fields: { subject: 'Need a reply' },
    });
    expect(collection?.list({
      platform: 'mail',
      slug: 'work',
      filters: { thread_id: 'thread-1' },
    })).toHaveLength(1);
    expect(collection?.health()).toMatchObject({
      state: 'idle',
      last_indexed_at: 99,
      auth_state: 'healthy',
    });
    expect(() => collection?.delete('mail:1')).toThrow('mcp_readonly_mail_collection');
    expect(collection?.get('mail:1')).not.toBeNull();

    await registry.dispose();
    db.close();
  });

  it('hydrates blob-backed mail bodies from the shared local CAS', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-readonly-mail-'));
    const db = new Database(join(dir, 'recued.db'));
    const blobs = createBlobStore(join(dir, 'blobs'));
    const registry = createCollectionRegistry();
    try {
      createInstanceStore({ db }).upsert({
        platform: 'mail',
        slug: 'work',
        adapter_type: 'imap',
        config: {},
        caps: {
          read: 'yes',
          write: 'no',
          delete: 'no',
          watch: 'realtime',
          mirror: 'required',
          auth: 'oauth',
          path_style: 'uri',
        },
        auth_state: 'healthy',
        last_synced_at: 0,
      });
      const body = 'Body materialized by the standalone MCP read profile.';
      const blob_hash = await blobs.put(Buffer.from(body));
      createCollectionTable({ db, platform: 'mail', slug: 'work' }).upsert({
        record_id: 'mail:blob',
        received_at: 10,
        modified_at: 10,
        size_bytes: Buffer.byteLength(body),
        source_id: 'provider-blob',
        hot_fields: { thread_id: 'thread-blob' },
        blob_hash,
      });

      registerMcpReadonlyMailCollections({ db, registry });
      await expect(handleMailBodyRead(
        { registry, blobs },
        { slug: 'work', record_id: 'mail:blob', max_chars: 1_000 },
      )).resolves.toMatchObject({ body, found: true, truncated: false });
    } finally {
      await registry.dispose();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
