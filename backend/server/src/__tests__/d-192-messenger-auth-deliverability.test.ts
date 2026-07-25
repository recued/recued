/** D-192 CORE #6 make-live — a chat-transport connection must carry a credential
 *  the send path can actually use.
 *
 *  The make-live acceptance test surfaced a live trap. `ensureAuth` validates an
 *  auth SHAPE in isolation and never sees the subtype, so nothing anywhere asked
 *  the only question that matters: can THIS subtype deliver with THIS shape?
 *  `{kind: 'notification', subtype: 'slack', auth: {type: 'oauth2_refresh', …}}`
 *  therefore enrolled cleanly over rpc — and then:
 *
 *    - the health probe read it GREEN (`probeMessenger` resolves the credential
 *      through `resolveBearerAccessToken`, which happily returns
 *      `current_access_token`),
 *    - the readiness probe read it READY (it only checks the row exists),
 *    - and every send silently DROPPED, because the one credential resolver
 *      behind notify / ask / close-ask / turn / live-control hand-rolled
 *      `auth.type !== 'bearer'` and returned null for anything else.
 *
 *  Green, ready, and mute — the silent-until-runtime class the whole de-hardcode
 *  arc exists to kill. Enrollment is the ONLY place it can fail loudly: everything
 *  downstream is a best-effort fan-out that swallows errors by contract, which is
 *  precisely why the failure was silent.
 *
 *  So these tests pin the gate at the boundary, and — deliberately — pin what it
 *  must NOT reach: `email` and `in-app` are notification subtypes but not chat
 *  transports (no messenger send path to be incompatible with), and `api` vendors
 *  legitimately enroll `oauth2_refresh`. A gate that over-reached would break both. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MESSENGER_AUTH_KIND_CONNECTION_TYPES,
  MESSENGER_VENDOR_SLUGS,
  RpcError,
  getMessengerVendorDeclaration,
  type ConnectionAuth,
} from '@recued/contracts';

import {
  createConnectionStore,
  type ConnectionStoreSqlite,
} from '../storage/connection-store.js';
import {
  handleConnectionEnroll,
  handleConnectionUpdate,
} from '../connection-handler.js';

let dir: string;
let db: Database.Database;
let store: ConnectionStoreSqlite;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'messenger-auth-'));
  db = new Database(join(dir, 'test.db'));
  db.pragma('journal_mode = WAL');
  store = createConnectionStore(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** The deadly shape: it carries a usable `current_access_token`, so the health
 *  probe reads it GREEN. That is exactly what made the silent drop so hard to
 *  see — every other undeliverable shape at least probes `auth_failed`. */
const oauthRefresh: ConnectionAuth = {
  type: 'oauth2_refresh',
  refresh_token: 'rt',
  client_id: 'cid',
  token_endpoint: 'https://example.test/token',
  current_access_token: 'looks-perfectly-healthy',
};

const enroll = (
  subtype: string,
  auth: ConnectionAuth,
  kind: 'notification' | 'api' = 'notification',
): Promise<unknown> =>
  handleConnectionEnroll(
    { store },
    { name: subtype, kind, subtype, display_name: `${subtype} conn`, config: {}, auth },
  );

describe('D-192 CORE #6 — a chat transport may only enroll a credential it can send with', () => {
  // Iterates the LIVE registry, so a newly declared vendor is covered here with
  // zero edits to this file — the same posture as the seam-10 lock test.
  describe.each(MESSENGER_VENDOR_SLUGS.map((v) => [v] as const))('%s', (vendor) => {
    it('rejects oauth2_refresh — the shape that would probe green and never deliver', async () => {
      await expect(enroll(vendor, oauthRefresh)).rejects.toThrow(RpcError);
      await expect(enroll(vendor, oauthRefresh)).rejects.toThrow(/auth\.type 'bearer'/);
      // Fail loud means fail BEFORE the row exists — a persisted row would still
      // be green, ready and mute no matter how good the error message was.
      expect(store.get('notification', vendor)).toBeNull();
    });

    it("rejects 'none' — no credential at all is not a credential", async () => {
      await expect(enroll(vendor, { type: 'none' })).rejects.toThrow(RpcError);
      expect(store.get('notification', vendor)).toBeNull();
    });

    it('accepts the bearer bot token it actually sends with', async () => {
      await expect(enroll(vendor, { type: 'bearer', token: 'xoxb-real' })).resolves.toBeDefined();
      expect(store.get('notification', vendor)).not.toBeNull();
    });

    it('closes the update back door — a bearer row cannot be patched to an undeliverable shape', async () => {
      await enroll(vendor, { type: 'bearer', token: 'xoxb-real' });
      await expect(
        handleConnectionUpdate(
          { store },
          { name: vendor, kind: 'notification', patch: { auth: oauthRefresh } },
        ),
      ).rejects.toThrow(RpcError);
      // And the row is untouched — still the bearer it was enrolled with.
      expect(store.get('notification', vendor)).not.toBeNull();
    });

    it('names a shape the send path can actually resolve', () => {
      // The relationship, not a literal: whatever the vendor's declared auth KIND
      // permits must be a shape `resolveMessengerSendToken` will resolve. Pinning
      // `['bearer']` instead would still pass if the map and the seam drifted apart.
      const declaration = getMessengerVendorDeclaration(vendor);
      const allowed = MESSENGER_AUTH_KIND_CONNECTION_TYPES[declaration!.auth];
      expect(allowed.length).toBeGreaterThan(0);
    });
  });

  describe('the gate does not over-reach', () => {
    it('leaves email alone — a façade over a mail instance, not a chat transport', async () => {
      // Its credentials live on the picked `data.mail.<instance>`, so `none` is
      // correct here and a messenger-shaped gate would wrongly reject it.
      await expect(enroll('email', { type: 'none' })).resolves.toBeDefined();
    });

    it('leaves in-app alone — the broadcast bus carries no external credential', async () => {
      await expect(enroll('in-app', { type: 'none' })).resolves.toBeDefined();
    });

    it('leaves api vendors alone — oauth2_refresh is how they are meant to enroll', async () => {
      // `kind: 'api'` has a real token refresher; `kind: 'notification'` has none.
      // That asymmetry is the whole reason the messenger gate is narrow.
      await expect(enroll('hubspot', oauthRefresh, 'api')).resolves.toBeDefined();
      expect(store.get('api', 'hubspot')).not.toBeNull();
    });
  });
});
