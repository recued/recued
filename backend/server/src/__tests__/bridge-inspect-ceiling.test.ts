/** D-335 slice P — the most one Bridge read answers (`BRIDGE_INSPECT_CEILING_CHARS`) is set by what
 *  one message to the server can carry: the rpc socket the Bridge answers on refuses a frame past
 *  `RPC_WS_MAX_PAYLOAD_BYTES` and closes the connection. Lower that, or raise the ceiling, and a
 *  read the server asked for would drop the Bridge instead of answering: this pins the two together
 *  with the costliest answer the ceiling allows, each character a control character JSON writes as
 *  six bytes. */
import { describe, expect, it } from 'vitest';
import { BRIDGE_INSPECT_CEILING_CHARS, type BridgeFromBridgeWireEnvelope } from '@recued/contracts';

import { RPC_WS_MAX_PAYLOAD_BYTES } from '../ws-server.js';

describe('D-335 slice P — a Bridge read as large as it may be fits one message to the server', () => {
  it('the costliest answer under the ceiling is smaller than the socket takes', () => {
    const envelope: BridgeFromBridgeWireEnvelope = { kind: 'result', result: { command_id: 'c'.repeat(36), status: 'ok',
      duration_ms: 1, bridge_version: '0.0.8', idempotency_key_seen: false, outputs: {
        page: `${'9'.repeat(10)}:${'D'.repeat(32)}`, url: `https://${'u'.repeat(1_990)}`, title: 't'.repeat(2_000),
        html: '\u0001'.repeat(BRIDGE_INSPECT_CEILING_CHARS), truncated: true } } };
    const bytes = Buffer.byteLength(JSON.stringify(envelope), 'utf8');
    expect(bytes).toBeGreaterThan(BRIDGE_INSPECT_CEILING_CHARS * 6);
    expect(bytes).toBeLessThan(RPC_WS_MAX_PAYLOAD_BYTES);
  });
});
