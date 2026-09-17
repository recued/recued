/** D-273 P1 — NAT-PMP wire format + client.
 *
 *  ⛔ ASSERTED AGAINST LITERAL BYTES, NOT ROUND-TRIPPED. An encoder and a decoder
 *  that share the same wrong field offsets round-trip perfectly and talk to no
 *  router on earth. The byte arrays below are read off RFC 6886 § 3.2-3.4 by
 *  hand; they are the only thing in this file that can catch a layout error. */

import { describe, expect, it, vi } from 'vitest';
import {
  createNatPmpClient,
  decodeExternalAddressResponse,
  decodeMapResponse,
  encodeExternalAddressRequest,
  encodeMapRequest,
  NatPmpError,
  type NatPmpSend,
} from '../network/nat-pmp.js';

describe('D-273 — NAT-PMP request encoding', () => {
  it('external-address request is the two bytes RFC 6886 § 3.2 specifies', () => {
    expect([...encodeExternalAddressRequest()]).toEqual([0, 0]);
  });

  it('⛔ a TCP map request, byte for byte', () => {
    // version 0 | opcode 2 (TCP) | reserved 0,0 | internal 443 (0x01BB)
    // | external 9443 (0x24E3) | lifetime 7200 (0x00001C20)
    //
    // ⛔⛔ THE TWO PORTS ARE DIFFERENT ON PURPOSE. This test first used 443 for
    // both, which made it BLIND to the exact defect it exists to catch: swapping
    // the internal and external offsets produced byte-identical output and the
    // assertion passed. A fixture whose fields share a value cannot tell those
    // fields apart.
    expect([...encodeMapRequest({
      protocol: 'tcp', internalPort: 443, externalPort: 9443, lifetimeSeconds: 7200,
    })]).toEqual([0, 2, 0, 0, 1, 187, 36, 227, 0, 0, 28, 32]);
  });

  it('⚠ UDP is a DIFFERENT OPCODE, and only that byte changes', () => {
    const tcp = [...encodeMapRequest({
      protocol: 'tcp', internalPort: 443, externalPort: 9443, lifetimeSeconds: 7200,
    })];
    const udp = [...encodeMapRequest({
      protocol: 'udp', internalPort: 443, externalPort: 9443, lifetimeSeconds: 7200,
    })];
    expect(udp[1]).toBe(1);
    expect(udp.slice(2)).toEqual(tcp.slice(2));
  });

  it('⛔ a DELETE forces the external port to 0, as § 3.4 requires', () => {
    // The caller passed 443; encoding it anyway would half-delete — the wire
    // rule is lifetime 0 AND external port 0, and a caller cannot be trusted to
    // remember the second half.
    expect([...encodeMapRequest({
      protocol: 'tcp', internalPort: 443, externalPort: 443, lifetimeSeconds: 0,
    })]).toEqual([0, 2, 0, 0, 1, 187, 0, 0, 0, 0, 0, 0]);
  });
});

describe('D-273 — NAT-PMP response decoding', () => {
  /** opcode 130 = TCP map response (2 + 128); epoch 3600; internal 443;
   *  external 9443 (0x24E3); lifetime 3600 (0x0E10). */
  const MAP_OK = Uint8Array.from([
    0, 130, 0, 0, 0, 0, 14, 16, 1, 187, 36, 227, 0, 0, 14, 16,
  ]);

  it('⛔⛔ returns the ASSIGNED external port, not the one we asked for', () => {
    // RFC 6886 § 3.3 lets the gateway pick a different port when the suggestion
    // is taken. A caller that assumes its own number publishes an address
    // nobody can reach — and the router reports a healthy mapping throughout.
    expect(decodeMapResponse(MAP_OK, 'tcp')).toEqual({
      internalPort: 443,
      externalPort: 9443,
      lifetimeSeconds: 3600,
      epochSeconds: 3600,
    });
  });

  it('⛔ and the GRANTED lifetime, which renewal must be timed off', () => {
    // 7200 requested, 600 granted. Timing refreshes off the request would let
    // the mapping lapse between them while every log line says it was renewed.
    const shortened = Uint8Array.from([
      0, 130, 0, 0, 0, 0, 14, 16, 1, 187, 1, 187, 0, 0, 2, 88,
    ]);
    expect(decodeMapResponse(shortened, 'tcp').lifetimeSeconds).toBe(600);
  });

  it('decodes the external address and its epoch', () => {
    expect(decodeExternalAddressResponse(
      Uint8Array.from([0, 128, 0, 0, 0, 0, 14, 16, 203, 0, 113, 7]),
    )).toEqual({ externalIp: '203.0.113.7', epochSeconds: 3600 });
  });

  it('⚠ CGNAT decodes as an ordinary address — naming it is the CALLER\'s job', () => {
    // 100.64/10 means the mapping will succeed and the address still will not be
    // reachable. The decoder reports what the gateway said; deciding that is bad
    // news belongs where `isCgnatIpv4` already lives.
    expect(decodeExternalAddressResponse(
      Uint8Array.from([0, 128, 0, 0, 0, 0, 0, 0, 100, 64, 1, 5]),
    ).externalIp).toBe('100.64.1.5');
  });

  it.each([
    [1, 'unsupported_version'],
    [2, 'not_authorized'],
    [3, 'network_failure'],
    [4, 'out_of_resources'],
    [5, 'unsupported_opcode'],
    [99, 'unknown'],
  ])('result code %i surfaces as `%s`', (raw, name) => {
    const msg = Uint8Array.from([0, 130, 0, raw, 0, 0, 0, 0, 1, 187, 1, 187, 0, 0, 0, 60]);
    expect(() => decodeMapResponse(msg, 'tcp'))
      .toThrow(expect.objectContaining({ code: name }) as Error);
  });

  it('⛔⛔ REFUSES a well-formed packet carrying the WRONG OPCODE', () => {
    // ⚠ MY FIRST VERSION OF THIS TEST PASSED FOR THE WRONG REASON. It used a real
    // 12-byte announcement, which the LENGTH check rejects before the opcode
    // check ever runs — so it asserted "refused" while leaving the opcode guard
    // completely unexercised. This one is 16 bytes: long enough to reach the
    // guard, so only the opcode can refuse it.
    const wrongOpcode = Uint8Array.from([
      0, 128, 0, 0, 0, 0, 14, 16, 1, 187, 1, 187, 0, 0, 14, 16,
    ]);
    expect(() => decodeMapResponse(wrongOpcode, 'tcp')).toThrow(/not a response to/);
  });

  it('⚠ an announcement IS indistinguishable from an external-address reply', () => {
    // Recorded rather than defended against, because the packets are identical
    // by design (§ 3.2.1) and the transport's source-address filter does not
    // separate them — an announcement comes FROM the gateway too.
    //
    // 🔑 IT IS HARMLESS HERE, AND ONLY HERE: both carry the same fact, so reading
    // an announcement as the answer to `externalAddress()` yields the current
    // external address, which is what was asked. A map response is 16 bytes with
    // its own opcode, so the ambiguity cannot reach one.
    const announcement = Uint8Array.from([0, 128, 0, 0, 0, 0, 14, 16, 203, 0, 113, 7]);
    expect(decodeExternalAddressResponse(announcement))
      .toEqual({ externalIp: '203.0.113.7', epochSeconds: 3600 });
  });

  it('⚠ refuses a TCP response to a UDP request and vice versa', () => {
    expect(() => decodeMapResponse(MAP_OK, 'udp')).toThrow(/not a response to/);
  });

  it('refuses a short datagram and a wrong version', () => {
    expect(() => decodeMapResponse(Uint8Array.from([0, 130, 0, 0]), 'tcp')).toThrow(/short/);
    expect(() => decodeExternalAddressResponse(
      Uint8Array.from([2, 128, 0, 0, 0, 0, 0, 0, 1, 2, 3, 4]),
    )).toThrow(/version/);
  });
});

describe('D-273 — the client', () => {
  const okMap = Uint8Array.from([0, 130, 0, 0, 0, 0, 14, 16, 1, 187, 1, 187, 0, 0, 14, 16]);
  const mk = (send: NatPmpSend, attempts = [10, 10, 10]) =>
    createNatPmpClient({ gateway: '192.168.1.1', send, attemptTimeoutsMs: attempts });

  it('⛔ retries SILENCE but never a result code', async () => {
    // `not_authorized` means the owner switched the feature off. Asking twice
    // more says the same thing three times and spends the reader's wait on it.
    const refused = Uint8Array.from([
      0, 130, 0, 2, 0, 0, 0, 0, 1, 187, 0, 0, 0, 0, 0, 0,
    ]);
    const send = vi.fn<NatPmpSend>(async () => refused);
    await expect(mk(send).map({
      protocol: 'tcp', internalPort: 443, externalPort: 443, lifetimeSeconds: 3600,
    })).rejects.toThrow(NatPmpError);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('⚠ but a silent gateway IS retried, to the configured bound', async () => {
    const send = vi.fn<NatPmpSend>(async () => { throw new Error('nat-pmp: timeout'); });
    await expect(mk(send).externalAddress()).rejects.toThrow(/timeout/);
    expect(send).toHaveBeenCalledTimes(3);
  });

  it('succeeds on a later attempt without reporting the earlier silence', async () => {
    let n = 0;
    const send = vi.fn<NatPmpSend>(async () => {
      n += 1;
      if (n < 3) throw new Error('nat-pmp: timeout');
      return okMap;
    });
    await expect(mk(send).map({
      protocol: 'tcp', internalPort: 443, externalPort: 443, lifetimeSeconds: 3600,
    })).resolves.toMatchObject({ externalPort: 443 });
  });

  it('⛔ `map()` REFUSES a zero lifetime rather than silently deleting', async () => {
    // Zero IS the delete operation on the wire, so a caller that mis-computed a
    // lease would tear its own mapping down and see a success.
    const send = vi.fn<NatPmpSend>(async () => okMap);
    await expect(mk(send).map({
      protocol: 'tcp', internalPort: 443, externalPort: 443, lifetimeSeconds: 0,
    })).rejects.toThrow(/use unmap/);
    expect(send).not.toHaveBeenCalled();
  });

  it('⛔ refuses a response about a DIFFERENT internal port', async () => {
    // Two things on one host can both be talking to the gateway.
    const otherPort = Uint8Array.from([
      0, 130, 0, 0, 0, 0, 14, 16, 31, 144, 31, 144, 0, 0, 14, 16,
    ]);
    const send = vi.fn<NatPmpSend>(async () => otherPort);
    await expect(mk(send).map({
      protocol: 'tcp', internalPort: 443, externalPort: 443, lifetimeSeconds: 3600,
    })).rejects.toThrow(/internal port/);
  });

  it('`unmap` sends the delete encoding', async () => {
    const sent: number[][] = [];
    const send = vi.fn<NatPmpSend>(async (payload) => {
      sent.push([...payload]);
      return Uint8Array.from([0, 130, 0, 0, 0, 0, 14, 16, 1, 187, 0, 0, 0, 0, 0, 0]);
    });
    await mk(send).unmap({ protocol: 'tcp', internalPort: 443 });
    expect(sent[0]).toEqual([0, 2, 0, 0, 1, 187, 0, 0, 0, 0, 0, 0]);
  });
});
