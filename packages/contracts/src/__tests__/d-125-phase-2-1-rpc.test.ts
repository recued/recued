/** D-125 Phase 2.1 — connection rpc registry tests.
 *
 *  Substrate-only: confirms the five `collection.connection.*`
 *  methods land in `SERVER_RPC_METHODS` + the keyof typing aligns
 *  with `ServerRpcRegistry`. The handler-side end-to-end coverage
 *  lives at `backend/server/src/__tests__/d-125-phase-2-1-
 *  connection-handler.test.ts`. */

import { describe, expect, it } from 'vitest';
import {
  SERVER_RPC_METHODS,
  SERVER_RPC_METHOD_SET,
  type ServerRpcRegistry,
} from '../index.js';

describe('D-125 P2.1 — collection.connection.* method registry', () => {
  const expected: Array<keyof ServerRpcRegistry> = [
    'collection.connection.list',
    'collection.connection.enroll',
    'collection.connection.update',
    'collection.connection.delete',
    'collection.connection.probe',
  ];

  it.each(expected)('registers %s in SERVER_RPC_METHODS', (method) => {
    expect((SERVER_RPC_METHODS as readonly string[]).includes(method)).toBe(true);
  });

  it.each(expected)('exposes %s in SERVER_RPC_METHOD_SET', (method) => {
    expect(SERVER_RPC_METHOD_SET.has(method)).toBe(true);
  });

  it('preserves the existing rpc surface (regression check)', () => {
    // A single sentinel from each pre-existing family. Catches an
    // accidental SERVER_RPC_METHODS rewrite that loses prior rows.
    expect(SERVER_RPC_METHOD_SET.has('contact.upsert')).toBe(true);
    expect(SERVER_RPC_METHOD_SET.has('collection.list')).toBe(true);
    expect(SERVER_RPC_METHOD_SET.has('collection.service.enroll')).toBe(true);
    expect(SERVER_RPC_METHOD_SET.has('annotation.write')).toBe(true);
    expect(SERVER_RPC_METHOD_SET.has('enrichment.upsert')).toBe(true);
  });

  it('does not register a rpc for retired/non-existent methods', () => {
    // Defensive — catches a typo that would create an unhandled
    // method name (future proofing the registry against
    // `collection.connection.subscribe` etc. that aren't in P2.1).
    expect(SERVER_RPC_METHOD_SET.has('collection.connection.subscribe')).toBe(false);
    expect(SERVER_RPC_METHOD_SET.has('collection.connection.invoke')).toBe(false);
  });
});
