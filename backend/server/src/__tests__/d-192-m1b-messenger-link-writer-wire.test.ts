/** D-192 M1b — the messenger link-writer WIRE (end-to-end token decode).
 *
 *  Exercises the one path the writer/leaf unit tests can't: the wire's bot-token
 *  decode (`connection.notification.<vendor>` → bearer token) + leaf dispatch
 *  (`MESSENGER_PROFILE_EMAIL_LEAVES`) → `contactStore.linkPlatformId`, driven by
 *  a real inbound bus event. A first-seen matched Slack sender is resolved via
 *  a mocked `users.info` and linked, and the same run's proposal carries the
 *  counterparty; a missing-scope response leaves the sender opaque.
 *
 *  Spec: `docs/d-192-kinds-taxonomy.md` §3a (M-1). */

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createWarehouseEventBus, type WarehouseEvent } from '@recued/warehouse-events';

import type { FireCommitmentEvidenceProposal } from '../commitment-evidence-capture.js';
import { wireMessengerCommitmentFunnel } from '../wire-messenger-commitment-funnel.js';
import {
  createConnectionStore,
  type ConnectionStoreSqlite,
} from '../storage/connection-store.js';
import { createContactStore, type ContactStore } from '../storage/contact-store.js';
import {
  createMessageCommitmentLedger,
  type MessageCommitmentLedger,
} from '../storage/message-commitment-ledger.js';

const NOW = 1_700_000_000_000;

type FireMock = ReturnType<typeof vi.fn<FireCommitmentEvidenceProposal>>;
const okFire = (): FireMock => vi.fn<FireCommitmentEvidenceProposal>(async () => undefined);

/** A plaintext (no-vault) bearer auth blob — `decodeAuthFromStorage` with no
 *  key provider parses `base64(JSON)` directly, so the wire decodes the token
 *  without a KeyManager. */
const plaintextBearer = (token: string): string =>
  Buffer.from(JSON.stringify({ type: 'bearer', token })).toString('base64');

/** A fake `fetch` for the Slack `users.info` call. */
const usersInfoFetch = (env: unknown, ok = true, status = 200): typeof fetch =>
  vi.fn(async () => ({
    ok,
    status,
    statusText: ok ? 'OK' : 'error',
    json: async () => env,
  })) as unknown as typeof fetch;

const slackMessage = (overrides: Partial<WarehouseEvent> = {}): WarehouseEvent => ({
  platform: 'messenger',
  slug: 'slack',
  entity_type: 'message',
  event_kind: 'created',
  record_id: 'm1',
  at: NOW,
  record: { from: 'U0ABC', text: 'ship it #commit', vendor: 'slack', connection_name: 'slack', media_count: 0 },
  ...overrides,
});

interface Harness {
  bus: ReturnType<typeof createWarehouseEventBus>;
  store: ConnectionStoreSqlite;
  contacts: ContactStore;
  ledger: MessageCommitmentLedger;
  fire: FireMock;
  close: () => void;
}

const makeHarness = (): Harness => {
  const db = new Database(':memory:');
  const store = createConnectionStore(db);
  const contacts = createContactStore(db, { now: () => NOW });
  const ledger = createMessageCommitmentLedger(db);
  return { bus: createWarehouseEventBus(), store, contacts, ledger, fire: okFire(), close: () => db.close() };
};

const seedSlackConnection = (store: ConnectionStoreSqlite, token = 'xoxb-test'): void => {
  store.upsert({
    name: 'slack',
    kind: 'notification',
    subtype: 'slack',
    display_name: 'Slack',
    config_json: JSON.stringify({ channel_id: 'C1', match_patterns: [{ kind: 'tag', value: 'commit' }] }),
    auth_ciphertext: plaintextBearer(token),
    enrolled_at: NOW,
    updated_at: NOW,
  });
};

const wire = (h: Harness, fetchImpl: typeof fetch): (() => void) =>
  wireMessengerCommitmentFunnel({
    bus: h.bus,
    getConnectionStore: () => h.store,
    getFire: () => h.fire,
    getLedger: () => h.ledger,
    getContactStore: () => h.contacts,
    // keys omitted — the plaintext bearer blob decodes without a KeyManager.
    fetchImpl,
    now: () => NOW,
  });

describe('D-192 M1b — messenger link-writer wire', () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });
  afterEach(() => h.close());

  it('resolves + links a first-seen Slack sender, and the same run carries the counterparty', async () => {
    seedSlackConnection(h.store);
    const off = wire(h, usersInfoFetch({ ok: true, user: { profile: { email: 'Alice@Acme.test' } } }));

    h.bus.emit(slackMessage());
    await vi.waitFor(() => expect(h.fire).toHaveBeenCalledTimes(1));

    // The link was written (lowercased canonical) …
    expect(h.contacts.lookupPlatformLink('slack', 'U0ABC')).toBe('alice@acme.test');
    // … and the SAME run's proposal resolved the counterparty from it.
    const payload = h.fire.mock.calls[0]?.[0].payload as Record<string, unknown>;
    expect(payload.counterparty_contact_id).toBe('alice@acme.test');
    off();
  });

  it('leaves the sender opaque on a missing_scope response (fail-soft, no link)', async () => {
    seedSlackConnection(h.store);
    const off = wire(h, usersInfoFetch({ ok: false, error: 'missing_scope' }));

    h.bus.emit(slackMessage());
    await vi.waitFor(() => expect(h.fire).toHaveBeenCalledTimes(1));

    expect(h.contacts.lookupPlatformLink('slack', 'U0ABC')).toBeNull();
    const payload = h.fire.mock.calls[0]?.[0].payload as Record<string, unknown>;
    expect(payload.counterparty_contact_id).toBeUndefined();
    off();
  });

  it('does not fetch a profile for an already-linked sender', async () => {
    seedSlackConnection(h.store);
    h.contacts.linkPlatformId({
      canonical_email: 'known@acme.test',
      vendor: 'slack',
      platform_id: 'U0ABC',
      state: 'confirmed',
      linked_at: NOW,
      linked_by: 'user:known@acme.test',
    });
    const fetchImpl = usersInfoFetch({ ok: true, user: { profile: { email: 'other@acme.test' } } });
    const off = wire(h, fetchImpl);

    h.bus.emit(slackMessage());
    await vi.waitFor(() => expect(h.fire).toHaveBeenCalledTimes(1));

    // No profile fetch, and the pre-existing link is preserved + resolved.
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(h.contacts.lookupPlatformLink('slack', 'U0ABC')).toBe('known@acme.test');
    const payload = h.fire.mock.calls[0]?.[0].payload as Record<string, unknown>;
    expect(payload.counterparty_contact_id).toBe('known@acme.test');
    off();
  });

  it('writes no link when the vendor row has no decodable bot token', async () => {
    // Seed the connection with match patterns but a malformed (non-bearer) auth
    // blob → the token resolve fails → the writer no-ops.
    h.store.upsert({
      name: 'slack',
      kind: 'notification',
      subtype: 'slack',
      display_name: 'Slack',
      config_json: JSON.stringify({ channel_id: 'C1', match_patterns: [{ kind: 'tag', value: 'commit' }] }),
      auth_ciphertext: Buffer.from(JSON.stringify({ type: 'oauth2_refresh' })).toString('base64'),
      enrolled_at: NOW,
      updated_at: NOW,
    });
    const fetchImpl = usersInfoFetch({ ok: true, user: { profile: { email: 'x@y.test' } } });
    const off = wire(h, fetchImpl);

    h.bus.emit(slackMessage());
    await vi.waitFor(() => expect(h.fire).toHaveBeenCalledTimes(1));

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(h.contacts.lookupPlatformLink('slack', 'U0ABC')).toBeNull();
    off();
  });
});
