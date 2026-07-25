import { describe, expect, it } from 'vitest';

import {
  DNS_APPLY_MAX_SKEW_MS,
  DNS_APPLY_PATHS,
  signDnsApplyRequest,
  verifyDnsApplyRequest,
} from '../dns-apply-protocol.js';

const secret = 'test-apply-secret';
const path = DNS_APPLY_PATHS.rrsetApply;
const nowMs = 1_800_000_000_000;
const rawBody = JSON.stringify({
  hostname: 'alice.recued.cloud',
  type: 'A',
  value: '203.0.113.10',
  ttl: 300,
});

const sign = (overrides: { secret?: string; path?: string; timestampMs?: number; rawBody?: string } = {}) =>
  signDnsApplyRequest(
    overrides.secret ?? secret,
    overrides.path ?? path,
    overrides.timestampMs ?? nowMs,
    overrides.rawBody ?? rawBody,
  );

const verify = async (
  overrides: {
    secret?: string;
    path?: string;
    timestampHeader?: string | null;
    signatureHeader?: string | null;
    rawBody?: string;
    now?: number;
  } = {},
) =>
  verifyDnsApplyRequest({
    secret: overrides.secret ?? secret,
    path: overrides.path ?? path,
    timestampHeader:
      'timestampHeader' in overrides ? overrides.timestampHeader! : String(nowMs),
    signatureHeader:
      'signatureHeader' in overrides ? overrides.signatureHeader! : await sign(),
    rawBody: overrides.rawBody ?? rawBody,
    nowMs: overrides.now ?? nowMs,
  });

describe('dns apply protocol signing', () => {
  it('round-trips a signed request through verification', async () => {
    await expect(verify()).resolves.toBe('ok');
  });

  it('binds signatures to the request path', async () => {
    const signature = await sign({ path: DNS_APPLY_PATHS.rrsetApply });

    await expect(
      verify({
        path: DNS_APPLY_PATHS.rrsetRemove,
        signatureHeader: signature,
      }),
    ).resolves.toBe('bad_signature');
  });

  it('rejects a tampered body', async () => {
    const signature = await sign();

    await expect(
      verify({
        signatureHeader: signature,
        rawBody: rawBody.replace('203.0.113.10', '203.0.113.11'),
      }),
    ).resolves.toBe('bad_signature');
  });

  it('rejects a tampered timestamp', async () => {
    const signature = await sign({ timestampMs: nowMs });

    await expect(
      verify({
        timestampHeader: String(nowMs + 1),
        signatureHeader: signature,
      }),
    ).resolves.toBe('bad_signature');
  });

  it('rejects a signature made with the wrong secret', async () => {
    const signature = await sign({ secret: 'other-secret' });

    await expect(verify({ signatureHeader: signature })).resolves.toBe('bad_signature');
  });

  it('accepts timestamps exactly on both skew boundaries', async () => {
    const futureTimestamp = nowMs + DNS_APPLY_MAX_SKEW_MS;
    const pastTimestamp = nowMs - DNS_APPLY_MAX_SKEW_MS;

    await expect(
      verify({
        timestampHeader: String(futureTimestamp),
        signatureHeader: await sign({ timestampMs: futureTimestamp }),
      }),
    ).resolves.toBe('ok');
    await expect(
      verify({
        timestampHeader: String(pastTimestamp),
        signatureHeader: await sign({ timestampMs: pastTimestamp }),
      }),
    ).resolves.toBe('ok');
  });

  it('rejects timestamps just outside both skew boundaries', async () => {
    const futureTimestamp = nowMs + DNS_APPLY_MAX_SKEW_MS + 1;
    const pastTimestamp = nowMs - DNS_APPLY_MAX_SKEW_MS - 1;

    await expect(
      verify({
        timestampHeader: String(futureTimestamp),
        signatureHeader: await sign({ timestampMs: futureTimestamp }),
      }),
    ).resolves.toBe('stale_timestamp');
    await expect(
      verify({
        timestampHeader: String(pastTimestamp),
        signatureHeader: await sign({ timestampMs: pastTimestamp }),
      }),
    ).resolves.toBe('stale_timestamp');
  });

  const staleTimestampCases: Array<[string, string | null]> = [
    ['missing timestamp header', null],
    ['empty timestamp header', ''],
    ['non-numeric timestamp', 'not-a-number'],
    ['oversized timestamp', '1234567890123456'],
  ];

  for (const [name, timestampHeader] of staleTimestampCases) {
    it(`returns stale_timestamp for ${name}`, async () => {
      await expect(verify({ timestampHeader })).resolves.toBe('stale_timestamp');
    });
  }

  const badSignatureCases: Array<[string, string | null]> = [
    ['missing signature header', null],
    ['odd-length hex signature', 'abc'],
    ['non-hex signature', 'zz'],
    ['16-byte hex signature', '00'.repeat(16)],
    ['64-byte hex signature', '00'.repeat(64)],
  ];

  for (const [name, signatureHeader] of badSignatureCases) {
    it(`returns bad_signature for ${name}`, async () => {
      await expect(verify({ signatureHeader })).resolves.toBe('bad_signature');
    });
  }

  it('accepts uppercase hex signatures', async () => {
    const signature = (await sign()).toUpperCase();

    await expect(verify({ signatureHeader: signature })).resolves.toBe('ok');
  });
});
