import { describe, expect, it } from 'vitest';
import type { ConnectionRow } from '@recued/contracts';
import Database from 'better-sqlite3';
import { createConnectionStore } from '../storage/connection-store.js';
import { connectionIdentity, connectionRevision, connectionRevisionGuard } from '../connection-revision.js';
import { resumeReviewedParent, type ExecuteHandlerDeps } from '../execute-handler.js';

const row: ConnectionRow = { pk: 'api:sales', kind: 'api', name: 'sales', display_name: 'Sales',
  config_json: '{"vendor":"hubspot"}', auth_ciphertext: 'encrypted-fixture', enrolled_at: 1, updated_at: 1 };
const revision = connectionRevision(connectionIdentity(row))!;

describe('page account revisions', () => {
  it('excludes presentation and routine health/use changes', () => {
    expect(revision).toMatch(/^[a-f0-9]{64}$/);
    expect(connectionRevision(connectionIdentity({ ...row, display_name: 'Renamed', health_json: '{}',
      last_used_at: 10, updated_at: 20 }))).toBe(revision);
  });

  it.each<Partial<ConnectionRow>>([
    { enrolled_at: 2 }, { auth_ciphertext: 'replacement' }, { config_json: '{"vendor":"salesforce"}' },
    { subtype: 'changed' }, { subresource_path: '/other' }, { granted_scopes_json: '["read"]' },
  ])('invalidates changed enrollment, credentials, endpoint or scope: %j', change => {
    expect(connectionRevision(connectionIdentity({ ...row, ...change }))).not.toBe(revision);
  });

  it('checks live rows on every invocation and refuses deleted accounts', () => {
    let current: ConnectionRow | undefined = row;
    const check = connectionRevisionGuard({ sales: revision }, () => current)!;
    expect(check).not.toThrow();
    current = { ...row, enrolled_at: 2 };
    expect(check).toThrow(expect.objectContaining({ code: 'connection_changed' }));
    current = undefined;
    expect(check).toThrow(expect.objectContaining({ code: 'connection_changed' }));
    expect(connectionRevisionGuard(undefined, () => current)).toBeUndefined();
  });

  it('keeps trusted token renewal on the same account revision while replacement changes it', () => {
    const db = new Database(':memory:');
    try {
      const store = createConnectionStore(db);
      store.upsert(row);
      const currentRevision = () => connectionRevision(connectionIdentity(store.get('api', row.name), store.getAuthSourceId?.('api', row.name)));
      const before = currentRevision();
      expect(store.persistRefreshedAuth?.(row, 'renewed-token', 2)).toBe(true);
      expect(currentRevision()).toBe(before);
      store.upsert({ ...store.get('api', row.name)!, auth_ciphertext: 'replacement-token', updated_at: 3 });
      expect(currentRevision()).not.toBe(before);
    } finally { db.close(); }
  });

  it('retains the account fence when a reviewed parent continues after its child', async () => {
    const deps = {
      auditLog: { get: async () => ({ checkpoint_id: 'paused', commit_status: 'awaiting_approval', connection_revisions: { sales: revision } }) },
      connectionStore: { get: () => ({ ...row, enrolled_at: 2 }) },
      preapprovalRuntime: { resolveOrigin: () => ({}), execute: async (_handle: unknown, run: () => Promise<unknown>) => run() },
    } as unknown as ExecuteHandlerDeps;
    await expect(resumeReviewedParent(deps, {
      run_id: 'parent', handle: {}, config: {}, snapshot: { recipe_id: 'parent', invocation_path: [] },
      plan: { origin: { source: { channel: 'chat', actor: 'user_self', chat_session_id: 'test', user_id: 'owner' } } },
    } as never, { checkpoint_id: 'paused', run_id: 'parent', recipe_id: 'parent',
      gated_step_id: 'child', step_state: {}, created_at: 1 }))
      .rejects.toMatchObject({ code: 'connection_changed' });
  });

  it.each([null, [], 'revision', { sales: 1 }, { sales: 'bad' }, { bad_name: revision }])(
    'rejects malformed expectations: %j', value => {
      expect(() => connectionRevisionGuard(value, () => row)).toThrow(expect.objectContaining({ code: 'bad_request' }));
    });
});
