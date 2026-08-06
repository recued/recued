/** `request_signature` at the enrollment boundary — the gate, and the two
 *  refusals it has to make.
 *
 *  ## ⛔ Why a gate is needed at all
 *
 *  `VALID_AUTH_TYPES` is DERIVED from `CONNECTION_AUTH_TYPES`. That derivation is
 *  what keeps the vocabulary from drifting (D-218 § 8.1: three hand-kept copies,
 *  all typechecking while short) — but it also means a new member becomes
 *  enrollable on EVERY kind the instant it is added, with nothing asking whether
 *  that kind can use it.
 *
 *  Signing is an `api` concept. An `mcp` or `notification` row carrying a signing
 *  credential would enroll green and then fail on every use: neither adapter can
 *  sign, and both refuse unknown auth shapes at dispatch. That is the
 *  green-ready-and-mute class D-192 CORE #6 exists to kill, one auth type later,
 *  and enrollment is again the only place it can fail loudly.
 *
 *  ## ⚠ And the update path, for the reason the messenger gate records
 *
 *  A row that enrolls as `bearer` and is then PATCHED to the unusable shape gets
 *  to the same place through the back door, so the gate runs on both.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RpcError, type ConnectionAuth } from '@recued/contracts';

import {
  createConnectionStore,
  type ConnectionStoreSqlite,
} from '../storage/connection-store.js';
import {
  handleConnectionEnroll,
  handleConnectionRotateCredentials,
  handleConnectionUpdate,
} from '../connection-handler.js';

let dir: string;
let db: Database.Database;
let store: ConnectionStoreSqlite;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'req-sig-gate-'));
  db = new Database(join(dir, 'test.db'));
  db.pragma('journal_mode = WAL');
  store = createConnectionStore(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const SIGNING: ConnectionAuth = {
  type: 'request_signature',
  scheme: 'binance_hmac_sha256',
  api_key: 'pub',
  secret_key: 'sec',
};

const enroll = (
  kind: 'api' | 'mcp' | 'notification',
  auth: ConnectionAuth,
  extra: Record<string, unknown> = {},
): Promise<unknown> =>
  handleConnectionEnroll(
    { store },
    {
      name: `conn-${kind}`,
      kind,
      display_name: 'conn',
      config: { base_url: 'https://api.binance.com' },
      auth,
      ...extra,
    },
  );

describe('request_signature is an api-kind credential', () => {
  it('enrolls on api', async () => {
    await expect(enroll('api', SIGNING)).resolves.toBeDefined();
  });

  it('⛔ is refused on mcp — it would enroll green and fail on every call', async () => {
    const p = enroll('mcp', SIGNING, {
      subtype: 'sse',
      config: { endpoint: 'https://example.test/sse' },
    });
    await expect(p).rejects.toThrow(RpcError);
    await expect(p).rejects.toThrow(/only valid on an api connection/u);
  });

  it('⛔ is refused on notification, for the same reason', async () => {
    const p = enroll('notification', SIGNING, { subtype: 'email' });
    await expect(p).rejects.toThrow(RpcError);
    await expect(p).rejects.toThrow(/only valid on an api connection/u);
  });

  it('⚠ the plain update path is closed by a STRONGER gate, not by this one', async () => {
    // ⛔ Worth recording because the first version of this test asserted the
    // wrong mechanism and passed for the wrong reason. `update` refuses ANY
    // `patch.auth` from a normal caller — credentials may only change through
    // the rotation handler, which verifies them against the provider first. So
    // the back door the messenger gate had to close does not exist here, and a
    // kind check on this path can never be what fires.
    await enroll('mcp', { type: 'bearer', token: 't' }, {
      subtype: 'sse',
      config: { endpoint: 'https://example.test/sse' },
    });
    const p = handleConnectionUpdate(
      { store },
      { name: 'conn-mcp', kind: 'mcp', patch: { auth: SIGNING } },
    );
    await expect(p).rejects.toThrow(RpcError);
    await expect(p).rejects.toThrow(/Replacement credentials must be verified/u);
  });

  it('⛔ ROTATION is the reachable back door, and the gate covers it', async () => {
    // Credentials can only change through rotation, so this — not a plain
    // `update` — is where an existing row of the wrong kind could acquire a
    // signing credential. ⚠ The gate that fires is the one inside
    // `handleConnectionUpdate`, which rotation calls internally BEFORE any
    // provider contact; an extra check at the rotation entry was tried and
    // removed because no mutation could make it bite.
    await enroll('mcp', { type: 'bearer', token: 't' }, {
      subtype: 'sse',
      config: { endpoint: 'https://example.test/sse' },
    });
    const before = store.get('mcp', 'conn-mcp')!;
    const p = handleConnectionRotateCredentials(
      { store } as never,
      {
        attempt_id: 'rotation-attempt-test-0001',
        name: 'conn-mcp',
        kind: 'mcp',
        expected_updated_at: before.updated_at,
        patch: { auth: SIGNING },
      } as never,
    );
    await expect(p).rejects.toThrow(/only valid on an api connection/u);
    // and the stored row is untouched
    expect(store.get('mcp', 'conn-mcp')).toEqual(before);
  });

  it('does not over-reach — other auth types still enroll on mcp', async () => {
    // A gate that refused by KIND rather than by auth type would break every
    // existing mcp row. Pinned because that is the cheap way to get this wrong.
    await expect(enroll('mcp', { type: 'bearer', token: 't' }, {
      subtype: 'sse',
      config: { endpoint: 'https://example.test/sse' },
    })).resolves.toBeDefined();
  });
});

describe('the scheme must be one this build implements', () => {
  it('accepts the implemented scheme', async () => {
    await expect(enroll('api', SIGNING)).resolves.toBeDefined();
  });

  it('⛔ refuses an unknown scheme at enroll, not at first call', async () => {
    // An unknown name would enroll cleanly and then fail on every dispatch,
    // turning a typo into a dead connection instead of a rejected form.
    const p = enroll('api', {
      ...SIGNING, scheme: 'ed25519' as never,
    });
    await expect(p).rejects.toThrow(RpcError);
    await expect(p).rejects.toThrow(/auth\.scheme must be one of/u);
  });

  it('⛔ refuses a MISSING scheme', async () => {
    const { scheme: _drop, ...noScheme } = SIGNING as unknown as Record<string, unknown>;
    await expect(enroll('api', noScheme as unknown as ConnectionAuth))
      .rejects.toThrow(/auth\.scheme must be one of/u);
  });

  it('requires both halves of the key pair', async () => {
    for (const missing of ['api_key', 'secret_key'] as const) {
      const auth = { ...SIGNING } as Record<string, unknown>;
      delete auth[missing];
      await expect(
        enroll('api', auth as unknown as ConnectionAuth),
        missing,
      ).rejects.toThrow(new RegExp(missing, 'u'));
    }
  });
});
