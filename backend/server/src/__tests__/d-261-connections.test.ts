import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { createConnectionStore, type ConnectionUpsert } from '../storage/connection-store.js';
import { synchronizePreapprovalConnection } from '../storage/preapproval-connections.js';
import { registerPreapprovalInvalidator } from '../storage/preapproval-lifecycle.js';
import { preparedPlan, repositoryFixture } from './d-261-fixtures.js';

const databases: Database.Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
const connection = (): ConnectionUpsert => ({ kind: 'api', name: 'crm', subtype: 'custom', display_name: 'CRM',
  config_json: JSON.stringify({ base_url: 'https://crm.example.test' }), auth_ciphertext: 'encrypted-token-a',
  enrolled_at: 10, updated_at: 10 });
const fixture = () => {
  const db = new Database(':memory:'); databases.push(db);
  const store = createConnectionStore(db);
  const { repository } = repositoryFixture(db);
  registerPreapprovalInvalidator(db, (kind, key, incarnation) => repository.invalidateDependency(kind, key, incarnation));
  store.upsert(connection());
  const pins = () => db.transaction(() => synchronizePreapprovalConnection(db, 'api', 'crm', store.get('api', 'crm'))).immediate();
  const prepare = async () => {
    const plan = preparedPlan(); plan.dependencies.push(...pins());
    return repository.prepare(plan, false);
  };
  return { db, store, repository, pins, prepare };
};

describe('D-261 enrolled connection lifecycle', () => {
  it('preserves a pending review across automatic credential refresh and health updates', async () => {
    const f = fixture(); const proposal = await f.prepare(); const before = f.pins();
    const readBeforeRefresh = f.store.get('api', 'crm')!;
    f.store.setHealth('api', 'crm', '{"healthy":true}');
    expect(f.store.persistRefreshedAuth!(readBeforeRefresh, 'encrypted-token-b', 20)).toBe(true);
    expect(f.store.get('api', 'crm')?.health_json).toBe('{"healthy":true}');
    expect(f.pins()).toEqual(before);
    expect((await f.repository.inspect(proposal.proposal_id)).execution_status).toBe('prepared');
    expect(JSON.stringify(before)).not.toContain('encrypted-token');
  });

  it.each(['credentials', 'route', 'delete'] as const)('seals a review on %s replacement', async action => {
    const f = fixture(); const proposal = await f.prepare(); const before = f.pins();
    const old = f.store.get('api', 'crm')!;
    if (action === 'delete') { f.store.delete('api', 'crm'); f.store.upsert(connection()); }
    else f.store.upsert({ ...connection(), ...(action === 'credentials' ? { auth_ciphertext: 'different-account' }
      : { config_json: '{"base_url":"https://other.example.test"}' }) });
    expect((await f.repository.inspect(proposal.proposal_id)).execution_status).toBe('invalidated');
    expect(f.pins()).not.toEqual(before);
    if (action !== 'delete') expect(f.store.persistRefreshedAuth!(old, 'late-refresh', 30)).toBe(false);
  });

  it('does not confuse a repeated name or identical credential after deletion with its old incarnation', async () => {
    const f = fixture(); const before = f.pins();
    f.store.delete('api', 'crm'); f.store.upsert(connection());
    expect(f.pins().every((pin, index) => pin.incarnation !== before[index]!.incarnation)).toBe(true);
  });
});
