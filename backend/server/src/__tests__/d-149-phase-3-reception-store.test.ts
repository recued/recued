/** D-149 P3 § A.3 — PublicEndpointRegistryStore CRUD ratchet.
 *
 *  Acceptance per spec § A.3 + § Must Hold I-1 / I-5 / I-10:
 *
 *    - `create` lands a row with `enabled = 0` (default-off baseline).
 *    - `enable` flips 0→1; idempotent re-enable returns `already_enabled`.
 *    - `disable` flips 1→0; idempotent re-disable returns `already_disabled`.
 *    - `revoke` stamps `revoked_at` + clears `enabled`; idempotent.
 *    - `extend` updates `expires_at` on live rows; rejected on revoked.
 *    - `rotateToken` replaces HMAC; rejected on revoked.
 *    - `emergencyDisableAll` flips every live `enabled=1` row to 0.
 *    - `verifyBearer` accepts the correct bearer; rejects revoked /
 *      expired / wrong-bearer.
 *    - Access log append + read (most-recent-first).
 *    - `list` honors kind / enabled / include_revoked filters.
 */

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import type { PacketDeclaration } from '@recued/contracts';
import { ensureReceptionSchema } from '../storage/reception-store.js';
import {
  createPublicEndpointRegistryStore,
  type PublicEndpointRegistryStore,
} from '../storage/public-endpoint-registry-store.js';
import { computeBearerHmac, deriveReceptionPepper } from '../ports/reception/server-secret-pepper.js';

const NOW = 1_700_000_000_000;
const PEPPER = deriveReceptionPepper(Buffer.alloc(32, 0xAA));

const makeStore = (): { store: PublicEndpointRegistryStore; db: Database.Database } => {
  const db = new Database(':memory:');
  ensureReceptionSchema(db);
  const store = createPublicEndpointRegistryStore(db);
  return { store, db };
};

const validPacketDeclaration = (): PacketDeclaration => ({
  packet_kind: 'scheduling_link_packet',
  source_query_ref: { kind: 'data.calendar.combined' },
});

const createRow = (
  store: PublicEndpointRegistryStore,
  endpoint_id = 'endpoint-001',
  secret = 'bearer-secret-001',
): void => {
  store.create({
    endpoint_id,
    kind: 'scheduling_link',
    packet_declaration: validPacketDeclaration(),
    bearer_secret_hmac: computeBearerHmac(secret, PEPPER),
    created_at: NOW,
    created_by_client_id: 'client-A',
    expires_at: NOW + 7 * 24 * 60 * 60 * 1000,
    long_lived_acknowledged_at: null,
    metadata: { description: 'unit test row' },
  });
};

describe('D-149 P3 § A.3 — create + default-off (Must Hold I-1)', () => {
  it('create lands a row with enabled=0', () => {
    const { store } = makeStore();
    createRow(store);
    const found = store.findById('endpoint-001');
    expect(found?.enabled).toBe(false);
  });

  it('fresh install has zero enabled endpoints (acceptance criterion)', () => {
    const { store } = makeStore();
    const rows = store.list({ enabled: true });
    expect(rows.length).toBe(0);
  });
});

describe('D-149 P3 § A.3 — enable / disable / revoke', () => {
  it('enable flips 0→1', () => {
    const { store } = makeStore();
    createRow(store);
    expect(store.enable('endpoint-001', NOW)).toBe('enabled');
    expect(store.findById('endpoint-001')?.enabled).toBe(true);
  });

  it('enable on enabled returns already_enabled', () => {
    const { store } = makeStore();
    createRow(store);
    store.enable('endpoint-001', NOW);
    expect(store.enable('endpoint-001', NOW)).toBe('already_enabled');
  });

  it('disable flips 1→0', () => {
    const { store } = makeStore();
    createRow(store);
    store.enable('endpoint-001', NOW);
    expect(store.disable('endpoint-001', NOW)).toBe('disabled');
    expect(store.findById('endpoint-001')?.enabled).toBe(false);
  });

  it('disable on disabled returns already_disabled', () => {
    const { store } = makeStore();
    createRow(store);
    expect(store.disable('endpoint-001', NOW)).toBe('already_disabled');
  });

  it('revoke stamps revoked_at + clears enabled', () => {
    const { store } = makeStore();
    createRow(store);
    store.enable('endpoint-001', NOW);
    expect(store.revoke({ endpoint_id: 'endpoint-001', now: NOW, reason: 'leak' })).toBe('revoked');
    const row = store.findById('endpoint-001');
    expect(row?.revoked_at).toBe(NOW);
    expect(row?.enabled).toBe(false);
    expect(row?.revocation_reason).toBe('leak');
  });

  it('revoke on revoked is idempotent', () => {
    const { store } = makeStore();
    createRow(store);
    store.revoke({ endpoint_id: 'endpoint-001', now: NOW, reason: 'leak' });
    expect(store.revoke({ endpoint_id: 'endpoint-001', now: NOW + 1, reason: 'leak-again' })).toBe(
      'already_revoked',
    );
  });

  it('enable on revoked returns already_revoked', () => {
    const { store } = makeStore();
    createRow(store);
    store.revoke({ endpoint_id: 'endpoint-001', now: NOW, reason: null });
    expect(store.enable('endpoint-001', NOW)).toBe('already_revoked');
  });

  it('not_found for missing endpoint', () => {
    const { store } = makeStore();
    expect(store.enable('missing', NOW)).toBe('not_found');
    expect(store.disable('missing', NOW)).toBe('not_found');
    expect(store.revoke({ endpoint_id: 'missing', now: NOW, reason: null })).toBe('not_found');
  });
});

describe('D-149 P3 § A.3 — extend / rotateToken', () => {
  it('extend updates expires_at', () => {
    const { store } = makeStore();
    createRow(store);
    const target = NOW + 14 * 24 * 60 * 60 * 1000;
    expect(store.extend({ endpoint_id: 'endpoint-001', new_expires_at: target, now: NOW })).toBe(
      'extended',
    );
    expect(store.findById('endpoint-001')?.expires_at).toBe(target);
  });

  it('extend to null stamps long_lived_acknowledged_at', () => {
    const { store } = makeStore();
    createRow(store);
    store.extend({ endpoint_id: 'endpoint-001', new_expires_at: null, now: NOW });
    const row = store.findById('endpoint-001');
    expect(row?.expires_at).toBeNull();
    expect(row?.long_lived_acknowledged_at).toBe(NOW);
  });

  it('rotateToken on revoked rejects', () => {
    const { store } = makeStore();
    createRow(store);
    store.revoke({ endpoint_id: 'endpoint-001', now: NOW, reason: null });
    const newHmac = computeBearerHmac('new-secret', PEPPER);
    expect(
      store.rotateToken({ endpoint_id: 'endpoint-001', new_bearer_secret_hmac: newHmac, now: NOW }),
    ).toBe('already_revoked');
  });

  it('rotateToken replaces HMAC; new bearer verifies + old rejects', () => {
    const { store } = makeStore();
    createRow(store, 'endpoint-001', 'bearer-001');
    store.enable('endpoint-001', NOW);
    const newSecret = 'bearer-002';
    const newHmac = computeBearerHmac(newSecret, PEPPER);
    expect(
      store.rotateToken({ endpoint_id: 'endpoint-001', new_bearer_secret_hmac: newHmac, now: NOW }),
    ).toBe('rotated');
    const oldVerify = store.verifyBearer({
      endpoint_id: 'endpoint-001',
      submitted_secret: 'bearer-001',
      pepper: PEPPER,
      now: NOW,
    });
    expect(oldVerify.kind).toBe('invalid_token');
    const newVerify = store.verifyBearer({
      endpoint_id: 'endpoint-001',
      submitted_secret: newSecret,
      pepper: PEPPER,
      now: NOW,
    });
    expect(newVerify.kind).toBe('ok');
  });
});

describe('D-149 P3 § A.3 — emergencyDisableAll', () => {
  it('flips every enabled row to disabled', () => {
    const { store } = makeStore();
    for (let i = 0; i < 3; i++) createRow(store, `endpoint-${i}`, `secret-${i}`);
    for (let i = 0; i < 3; i++) store.enable(`endpoint-${i}`, NOW);
    const count = store.emergencyDisableAll(NOW);
    expect(count).toBe(3);
    for (let i = 0; i < 3; i++) {
      expect(store.findById(`endpoint-${i}`)?.enabled).toBe(false);
    }
  });

  it('revoked rows are not counted', () => {
    const { store } = makeStore();
    createRow(store, 'endpoint-a');
    createRow(store, 'endpoint-b');
    store.enable('endpoint-a', NOW);
    store.revoke({ endpoint_id: 'endpoint-b', now: NOW, reason: null });
    expect(store.emergencyDisableAll(NOW)).toBe(1);
  });
});

describe('D-149 P3 § A.3 — verifyBearer (Must Hold I-10)', () => {
  it('accepts the correct bearer on an enabled row', () => {
    const { store } = makeStore();
    createRow(store, 'endpoint-001', 'bearer-XYZ');
    store.enable('endpoint-001', NOW);
    const res = store.verifyBearer({
      endpoint_id: 'endpoint-001',
      submitted_secret: 'bearer-XYZ',
      pepper: PEPPER,
      now: NOW,
    });
    expect(res.kind).toBe('ok');
  });

  it('rejects the wrong bearer', () => {
    const { store } = makeStore();
    createRow(store, 'endpoint-001', 'bearer-XYZ');
    store.enable('endpoint-001', NOW);
    const res = store.verifyBearer({
      endpoint_id: 'endpoint-001',
      submitted_secret: 'wrong',
      pepper: PEPPER,
      now: NOW,
    });
    expect(res.kind).toBe('invalid_token');
  });

  it('rejects on revoked row', () => {
    const { store } = makeStore();
    createRow(store, 'endpoint-001', 'bearer-XYZ');
    store.revoke({ endpoint_id: 'endpoint-001', now: NOW, reason: null });
    const res = store.verifyBearer({
      endpoint_id: 'endpoint-001',
      submitted_secret: 'bearer-XYZ',
      pepper: PEPPER,
      now: NOW + 1,
    });
    expect(res.kind).toBe('revoked');
  });

  it('rejects on expired row', () => {
    const { store } = makeStore();
    createRow(store, 'endpoint-001', 'bearer-XYZ');
    store.enable('endpoint-001', NOW);
    const future = NOW + 30 * 24 * 60 * 60 * 1000;
    const res = store.verifyBearer({
      endpoint_id: 'endpoint-001',
      submitted_secret: 'bearer-XYZ',
      pepper: PEPPER,
      now: future,
    });
    expect(res.kind).toBe('expired');
  });

  it('rejects on disabled row', () => {
    const { store } = makeStore();
    createRow(store, 'endpoint-001', 'bearer-XYZ');
    const res = store.verifyBearer({
      endpoint_id: 'endpoint-001',
      submitted_secret: 'bearer-XYZ',
      pepper: PEPPER,
      now: NOW,
    });
    expect(res.kind).toBe('invalid_token');
  });

  it('cross-endpoint reuse — token for endpoint A presented at endpoint B fails (Must Hold I-10)', () => {
    const { store } = makeStore();
    createRow(store, 'endpoint-A', 'bearer-A');
    createRow(store, 'endpoint-B', 'bearer-B');
    store.enable('endpoint-A', NOW);
    store.enable('endpoint-B', NOW);
    const res = store.verifyBearer({
      endpoint_id: 'endpoint-B',
      submitted_secret: 'bearer-A',
      pepper: PEPPER,
      now: NOW,
    });
    expect(res.kind).toBe('invalid_token');
  });
});

describe('D-149 P3 § A.3 — list filters', () => {
  it('filters by kind', () => {
    const { store, db } = makeStore();
    createRow(store, 'endpoint-A');
    db.prepare(
      `INSERT INTO public_endpoint_registry
        (endpoint_id, kind, packet_declaration, bearer_secret_hmac, created_at,
         created_by_client_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('endpoint-B', 'intake_form', '{}', Buffer.alloc(32), NOW, 'client-X');
    const sched = store.list({ kind: 'scheduling_link' });
    expect(sched.length).toBe(1);
    const intake = store.list({ kind: 'intake_form' });
    expect(intake.length).toBe(1);
  });

  it('include_revoked toggles the WHERE clause', () => {
    const { store } = makeStore();
    createRow(store, 'endpoint-A');
    createRow(store, 'endpoint-B');
    store.revoke({ endpoint_id: 'endpoint-B', now: NOW, reason: null });
    expect(store.list({}).length).toBe(1);
    expect(store.list({ include_revoked: true }).length).toBe(2);
  });
});

describe('D-149 P3 § A.3 — access log', () => {
  it('appends + reads most-recent-first', () => {
    const { store } = makeStore();
    createRow(store, 'endpoint-001');
    store.appendAccessLog({
      id: 'log-1',
      endpoint_id: 'endpoint-001',
      accessed_at: NOW + 100,
      source_ip_hash: 'hash-a',
      user_agent_hash: null,
      action_taken: 'view',
      outcome: 'ok',
      url_path_redacted: '/reception/scheduling/endpoint-001',
      metadata: {},
    });
    store.appendAccessLog({
      id: 'log-2',
      endpoint_id: 'endpoint-001',
      accessed_at: NOW + 200,
      source_ip_hash: 'hash-a',
      user_agent_hash: null,
      action_taken: 'view',
      outcome: 'ok',
      url_path_redacted: '/reception/scheduling/endpoint-001',
      metadata: {},
    });
    const entries = store.readAccessLog({ endpoint_id: 'endpoint-001' });
    expect(entries.length).toBe(2);
    expect(entries[0]!.id).toBe('log-2');
    expect(entries[1]!.id).toBe('log-1');
  });

  it('filters by since', () => {
    const { store } = makeStore();
    createRow(store, 'endpoint-001');
    store.appendAccessLog({
      id: 'log-1',
      endpoint_id: 'endpoint-001',
      accessed_at: NOW + 100,
      source_ip_hash: null,
      user_agent_hash: null,
      action_taken: 'view',
      outcome: 'ok',
      url_path_redacted: '/x',
      metadata: {},
    });
    store.appendAccessLog({
      id: 'log-2',
      endpoint_id: 'endpoint-001',
      accessed_at: NOW + 200,
      source_ip_hash: null,
      user_agent_hash: null,
      action_taken: 'view',
      outcome: 'ok',
      url_path_redacted: '/x',
      metadata: {},
    });
    const entries = store.readAccessLog({ endpoint_id: 'endpoint-001', since: NOW + 150 });
    expect(entries.length).toBe(1);
    expect(entries[0]!.id).toBe('log-2');
  });
});
