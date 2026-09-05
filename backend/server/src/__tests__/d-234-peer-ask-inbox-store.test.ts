import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { createPeerAskInboxStore } from '../storage/peer-ask-inbox-store.js';

describe('PeerAskInboxStore', () => {
  it('accepts a concurrently completed additive migration by postcondition', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE peer_ask_inbox (
        peer_contract_id TEXT NOT NULL,
        exchange_ref TEXT NOT NULL,
        request_fingerprint TEXT NOT NULL,
        ask_id TEXT NOT NULL,
        state TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (peer_contract_id, exchange_ref)
      );
    `);
    const exec = db.exec.bind(db);
    let intercepted = false;
    const racingDb = new Proxy(db, {
      get(target, property) {
        if (property === 'exec') {
          return (sql: string) => {
            if (!intercepted && sql.includes('ADD COLUMN connection_name')) {
              intercepted = true;
              exec(sql);
              throw new Error('duplicate column name: connection_name');
            }
            return exec(sql);
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as Database.Database;

    const store = createPeerAskInboxStore(racingDb);
    expect(store.reserve({
      peer_contract_id: 'contract-1',
      exchange_ref: 'exchange-1',
      request_fingerprint: 'fingerprint-1',
      connection_name: 'peer-one',
      ask_id: 'ask-1',
      created_at: 1,
    })).toMatchObject({ kind: 'created' });
    expect(intercepted).toBe(true);
    db.close();
  });

  it('binds one authenticated exchange to one request and ask capability', () => {
    const store = createPeerAskInboxStore(new Database(':memory:'));
    const first = store.reserve({
      peer_contract_id: 'contract-1',
      exchange_ref: 'exchange-1',
      request_fingerprint: 'fingerprint-1',
      connection_name: 'peer-one',
      ask_id: 'ask-secret-1',
      created_at: 100,
    });
    const replay = store.reserve({
      peer_contract_id: 'contract-1',
      exchange_ref: 'exchange-1',
      request_fingerprint: 'fingerprint-1',
      connection_name: 'renamed-peer-one',
      ask_id: 'ask-must-not-replace',
      created_at: 200,
    });
    const conflict = store.reserve({
      peer_contract_id: 'contract-1',
      exchange_ref: 'exchange-1',
      request_fingerprint: 'fingerprint-2',
      connection_name: 'peer-one',
      ask_id: 'ask-secret-2',
      created_at: 300,
    });

    expect(first).toMatchObject({ kind: 'created', row: { ask_id: 'ask-secret-1' } });
    expect(replay).toMatchObject({
      kind: 'existing',
      row: { ask_id: 'ask-secret-1', connection_name: 'peer-one' },
    });
    expect(conflict).toMatchObject({ kind: 'conflict', row: { ask_id: 'ask-secret-1' } });
  });

  it('marks only the reserved ask capability raised and remains idempotent', () => {
    const store = createPeerAskInboxStore(new Database(':memory:'));
    store.reserve({
      peer_contract_id: 'contract-1',
      exchange_ref: 'exchange-1',
      request_fingerprint: 'fingerprint-1',
      connection_name: 'peer-one',
      ask_id: 'ask-secret-1',
      created_at: 100,
    });

    expect(store.markRaised('contract-1', 'exchange-1', 'wrong')).toBe('mismatch');
    expect(store.markRaised('contract-1', 'exchange-1', 'ask-secret-1')).toBe('marked');
    expect(store.markRaised('contract-1', 'exchange-1', 'ask-secret-1')).toBe('already');
    expect(store.get('contract-1', 'exchange-1')).toMatchObject({ state: 'raised' });
  });
});
