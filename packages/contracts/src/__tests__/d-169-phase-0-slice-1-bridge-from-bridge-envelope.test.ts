/** D-169 P0 Slice 1 — bridge → server wire envelope contract test.
 *
 *  Asserts `BridgeFromBridgeWireEnvelope` is exported + carries the
 *  `result` variant. The bridge SW boot's `sendBridgeResult` (in
 *  `apps/bridge/src/boot/service-worker-bootstrap.ts`) is the
 *  producer; future server-side WS inbound routing is the consumer.
 *  This test pins the type at the contract layer so neither side can
 *  drift unilaterally.
 */

import { describe, it, expect } from 'vitest';
import type {
  BridgeFromBridgeWireEnvelope,
  BridgeResult,
} from '../bridge.js';

const sampleResult: BridgeResult = {
  command_id: 'cmd-1',
  status: 'ok',
  outputs: { text: 'hello' },
  duration_ms: 12,
  bridge_version: '0.0.1',
  idempotency_key_seen: false,
};

describe('D-169 P0 Slice 1 — BridgeFromBridgeWireEnvelope', () => {
  it('the `result` variant carries a BridgeResult', () => {
    const envelope: BridgeFromBridgeWireEnvelope = {
      kind: 'result',
      result: sampleResult,
    };
    expect(envelope.kind).toBe('result');
    expect(envelope.result.command_id).toBe('cmd-1');
  });

  it('round-trips through JSON without loss', () => {
    const envelope: BridgeFromBridgeWireEnvelope = {
      kind: 'result',
      result: sampleResult,
    };
    const decoded = JSON.parse(JSON.stringify(envelope)) as BridgeFromBridgeWireEnvelope;
    expect(decoded.kind).toBe('result');
    if (decoded.kind === 'result') {
      expect(decoded.result.command_id).toBe(sampleResult.command_id);
      expect(decoded.result.status).toBe(sampleResult.status);
      expect(decoded.result.outputs).toEqual(sampleResult.outputs);
    }
  });

  it('discriminated union narrows cleanly via `kind`', () => {
    const envelope: BridgeFromBridgeWireEnvelope = {
      kind: 'result',
      result: sampleResult,
    };
    // Type-narrowing — compile-time check, the test asserts runtime
    // discrimination as well.
    if (envelope.kind === 'result') {
      const r: BridgeResult = envelope.result;
      expect(r.status).toBe('ok');
    } else {
      throw new Error('expected result variant');
    }
  });
});
