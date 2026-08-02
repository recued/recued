/** D-192 M4b — messenger message→commitment funnel wire. */

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MessageMatchPattern } from '@recued/contracts';
import { createWarehouseEventBus, type WarehouseEvent } from '@recued/warehouse-events';

import type { FireCommitmentEvidenceProposal } from '../commitment-evidence-capture.js';
import {
  createConnectionStore,
  type ConnectionStoreSqlite,
  type ConnectionUpsert,
} from '../storage/connection-store.js';
import { createContactStore, type ContactStore } from '../storage/contact-store.js';
import {
  createMessageCommitmentLedger,
  type MessageCommitmentLedger,
} from '../storage/message-commitment-ledger.js';
import {
  readMessengerMatchPatterns,
  wireMessengerCommitmentFunnel,
} from '../wire-messenger-commitment-funnel.js';

const NOW = 1_700_000_000_000;
const PATTERNS: readonly MessageMatchPattern[] = [{ kind: 'tag', value: 'commit' }];

type FireMock = ReturnType<typeof vi.fn<FireCommitmentEvidenceProposal>>;
type ProposalRequest = Parameters<FireCommitmentEvidenceProposal>[0];

const flushAsync = async (): Promise<void> => {
  // Drain the funnel's full async chain before asserting on the fire-and-forget
  // dispatch. M1b added a best-effort bot-token decode hop (ensureSenderLinked)
  // before the M3 resolve, so a fixed microtask count is no longer enough — a
  // macrotask boundary flushes every pending microtask in the chain.
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
};

const okFire = (): FireMock => vi.fn<FireCommitmentEvidenceProposal>(async () => undefined);

const firstProposal = (fire: FireMock): ProposalRequest => {
  expect(fire).toHaveBeenCalledTimes(1);
  const call = fire.mock.calls[0];
  if (call === undefined) throw new Error('expected proposal fire');
  return call[0];
};

const messengerEvent = (overrides: Partial<WarehouseEvent> = {}): WarehouseEvent => ({
  platform: 'messenger',
  slug: 'slack',
  entity_type: 'message',
  event_kind: 'created',
  record_id: 'm1',
  at: NOW,
  record: {
    from: 'U0ABC',
    text: 'ship it #commit',
    vendor: 'slack',
    connection_name: 'slack',
    media_count: 0,
  },
  ...overrides,
});

const slackConnection = (
  config_json: string,
  overrides: Partial<ConnectionUpsert> = {},
): ConnectionUpsert => ({
  name: 'slack',
  kind: 'notification',
  subtype: 'slack',
  display_name: 'Slack',
  config_json,
  auth_ciphertext: 'ciphertext',
  enrolled_at: NOW,
  updated_at: NOW,
  ...overrides,
});

const upsertSlackConnection = (
  store: ConnectionStoreSqlite,
  config: unknown,
  overrides: Partial<ConnectionUpsert> = {},
): void => {
  store.upsert(
    slackConnection(
      typeof config === 'string' ? config : JSON.stringify(config),
      overrides,
    ),
  );
};

interface WireHarness {
  bus: ReturnType<typeof createWarehouseEventBus>;
  store: ConnectionStoreSqlite;
  ledger: MessageCommitmentLedger;
  contacts: ContactStore;
  fire: FireMock;
  wire: (opts?: {
    getConnectionStore?: () => ConnectionStoreSqlite | undefined;
    getFire?: () => FireCommitmentEvidenceProposal | undefined;
    getLedger?: () => MessageCommitmentLedger | undefined;
    getContactStore?: () => ContactStore | undefined;
  }) => () => Promise<void>;
  close: () => void;
}

const makeHarness = (): WireHarness => {
  const db = new Database(':memory:');
  const bus = createWarehouseEventBus();
  const store = createConnectionStore(db);
  const ledger = createMessageCommitmentLedger(db);
  const contacts = createContactStore(db, { now: () => NOW });
  const fire = okFire();
  return {
    bus,
    store,
    ledger,
    contacts,
    fire,
    // Default `getContactStore` to the (empty) real store — no seeded link ⇒
    // the M3 resolver fails closed exactly as pre-M3, so the existing wire
    // tests are unaffected; the M3 test seeds a link into `h.contacts`.
    wire: (opts = {}) => wireMessengerCommitmentFunnel({
      bus,
      getConnectionStore: opts.getConnectionStore ?? (() => store),
      getFire: opts.getFire ?? (() => fire),
      getLedger: opts.getLedger ?? (() => ledger),
      getContactStore: opts.getContactStore ?? (() => contacts),
      now: () => NOW,
    }),
    close: () => {
      db.close();
    },
  };
};

describe('D-192 M4b — readMessengerMatchPatterns', () => {
  let db: Database.Database;
  let store: ConnectionStoreSqlite;

  beforeEach(() => {
    db = new Database(':memory:');
    store = createConnectionStore(db);
  });

  afterEach(() => {
    db.close();
  });

  it('returns [] for missing store, unknown connection, malformed JSON, and non-array pattern fields', () => {
    expect(readMessengerMatchPatterns(undefined, 'slack')).toEqual([]);
    expect(readMessengerMatchPatterns(store, 'slack')).toEqual([]);

    upsertSlackConnection(store, '{bad');
    expect(readMessengerMatchPatterns(store, 'slack')).toEqual([]);

    upsertSlackConnection(store, {});
    expect(readMessengerMatchPatterns(store, 'slack')).toEqual([]);

    upsertSlackConnection(store, { match_patterns: 'commit' });
    expect(readMessengerMatchPatterns(store, 'slack')).toEqual([]);
  });

  it('returns the valid pattern array from config_json.match_patterns', () => {
    upsertSlackConnection(store, { match_patterns: PATTERNS });

    expect(readMessengerMatchPatterns(store, 'slack')).toEqual(PATTERNS);
  });
});

describe('D-192 M4b — wireMessengerCommitmentFunnel', () => {
  it('unsubscribe closes admission and waits for an admitted proposal', async () => {
    const h = makeHarness();
    let releaseFire: (() => void) | undefined;
    const fire = vi.fn<FireCommitmentEvidenceProposal>(() =>
      new Promise<void>((resolve) => {
        releaseFire = resolve;
      }));
    const off = h.wire({ getFire: () => fire });
    try {
      upsertSlackConnection(h.store, { match_patterns: PATTERNS });
      h.bus.emit(messengerEvent());
      await flushAsync();
      expect(fire).toHaveBeenCalledTimes(1);

      let stopped = false;
      const firstStop = off();
      expect(off()).toBe(firstStop);
      const observed = firstStop.then(() => {
        stopped = true;
      });
      await Promise.resolve();
      expect(stopped).toBe(false);

      h.bus.emit(messengerEvent({ record_id: 'm2' }));
      expect(fire).toHaveBeenCalledTimes(1);
      if (releaseFire === undefined) throw new Error('proposal did not start');
      releaseFire();
      await observed;
    } finally {
      releaseFire?.();
      await off();
      h.close();
    }
  });

  it('fires one held proposal for a matching messenger message', async () => {
    const h = makeHarness();
    const off = h.wire();
    try {
      upsertSlackConnection(h.store, { match_patterns: PATTERNS });

      h.bus.emit(messengerEvent());
      await flushAsync();

      const req = firstProposal(h.fire);
      expect(req.payload.direction).toBe('inbound');
      expect(req.payload.derivation).toBe('evidence_captured');
      expect(req.payload.evidence_blob).toEqual([
        {
          kind: 'message',
          full_target_id: 'slack_m1',
          vendor: 'slack',
          actor_platform_id: 'U0ABC',
          snippet: 'ship it #commit',
          sent_at: NOW,
          captured_at: NOW,
        },
      ]);
    } finally {
      off();
      h.close();
    }
  });

  it.each([
    ['non-messenger event', messengerEvent({ platform: 'mail' })],
    ['non-message entity', messengerEvent({ entity_type: 'note' })],
    ['non-created event', messengerEvent({ event_kind: 'updated' })],
  ] as const)('does not fire for %s', async (_label, event) => {
    const h = makeHarness();
    const off = h.wire();
    try {
      upsertSlackConnection(h.store, { match_patterns: PATTERNS });

      h.bus.emit(event);
      await flushAsync();

      expect(h.fire).not.toHaveBeenCalled();
    } finally {
      off();
      h.close();
    }
  });

  it('does not fire when the connection has no match patterns', async () => {
    const h = makeHarness();
    const off = h.wire();
    try {
      upsertSlackConnection(h.store, {});

      h.bus.emit(messengerEvent());
      await flushAsync();

      expect(h.fire).not.toHaveBeenCalled();
    } finally {
      off();
      h.close();
    }
  });

  it('does not fire when message text does not match the declared patterns', async () => {
    const h = makeHarness();
    const off = h.wire();
    try {
      upsertSlackConnection(h.store, { match_patterns: PATTERNS });

      h.bus.emit(messengerEvent({
        record: {
          from: 'U0ABC',
          text: 'just chatting',
          vendor: 'slack',
          connection_name: 'slack',
          media_count: 0,
        },
      }));
      await flushAsync();

      expect(h.fire).not.toHaveBeenCalled();
    } finally {
      off();
      h.close();
    }
  });

  it.each([
    ['text', {
      from: 'U0ABC',
      vendor: 'slack',
      connection_name: 'slack',
      media_count: 0,
    }],
    ['from', {
      text: 'ship it #commit',
      vendor: 'slack',
      connection_name: 'slack',
      media_count: 0,
    }],
    ['vendor', {
      from: 'U0ABC',
      text: 'ship it #commit',
      connection_name: 'slack',
      media_count: 0,
    }],
    ['connection_name', {
      from: 'U0ABC',
      text: 'ship it #commit',
      vendor: 'slack',
      media_count: 0,
    }],
  ] as const)('does not fire when record is missing %s', async (_label, record) => {
    const h = makeHarness();
    const off = h.wire();
    try {
      upsertSlackConnection(h.store, { match_patterns: PATTERNS });

      h.bus.emit(messengerEvent({ record }));
      await flushAsync();

      expect(h.fire).not.toHaveBeenCalled();
    } finally {
      off();
      h.close();
    }
  });

  it('does not fire when the message ledger is unavailable', async () => {
    const h = makeHarness();
    const off = h.wire({ getLedger: () => undefined });
    try {
      upsertSlackConnection(h.store, { match_patterns: PATTERNS });

      h.bus.emit(messengerEvent());
      await flushAsync();

      expect(h.fire).not.toHaveBeenCalled();
    } finally {
      off();
      h.close();
    }
  });

  it('does not fire when the connection store is unavailable', async () => {
    const h = makeHarness();
    const off = h.wire({ getConnectionStore: () => undefined });
    try {
      upsertSlackConnection(h.store, { match_patterns: PATTERNS });

      h.bus.emit(messengerEvent());
      await flushAsync();

      expect(h.fire).not.toHaveBeenCalled();
    } finally {
      off();
      h.close();
    }
  });

  it('does not claim the ledger when fire is unavailable', async () => {
    const h = makeHarness();
    const off = h.wire({ getFire: () => undefined });
    try {
      upsertSlackConnection(h.store, { match_patterns: PATTERNS });

      h.bus.emit(messengerEvent());
      await flushAsync();

      expect(h.fire).not.toHaveBeenCalled();
      expect(h.ledger.has('slack_m1')).toBe(false);
    } finally {
      off();
      h.close();
    }
  });

  it('deduplicates the same matching message through the real ledger', async () => {
    const h = makeHarness();
    const off = h.wire();
    try {
      upsertSlackConnection(h.store, { match_patterns: PATTERNS });

      h.bus.emit(messengerEvent());
      h.bus.emit(messengerEvent());
      await flushAsync();

      expect(h.fire).toHaveBeenCalledTimes(1);
      expect(h.ledger.has('slack_m1')).toBe(true);
    } finally {
      off();
      h.close();
    }
  });

  it('detaches the bus subscription', async () => {
    const h = makeHarness();
    const off = h.wire();
    try {
      upsertSlackConnection(h.store, { match_patterns: PATTERNS });
      off();

      h.bus.emit(messengerEvent());
      await flushAsync();

      expect(h.fire).not.toHaveBeenCalled();
    } finally {
      h.close();
    }
  });

  it('skips poisoned pattern members and still fires for a later valid pattern', async () => {
    const h = makeHarness();
    const off = h.wire();
    try {
      upsertSlackConnection(h.store, {
        match_patterns: [null, { kind: 'tag', value: 'commit' }],
      });

      h.bus.emit(messengerEvent());
      await flushAsync();

      expect(h.fire).toHaveBeenCalledTimes(1);
    } finally {
      off();
      h.close();
    }
  });
});

// ────────────────────────────────────────────────────────────────
// M3 — the messenger→contact linker, end to end over the bus
// ────────────────────────────────────────────────────────────────

describe('D-192 M3 — messenger→contact linker (wire)', () => {
  const SENDER_EMAIL = 'sender@acme.test';

  // Seed a contact + a (slack, U0ABC) → sender@acme.test platform link, so
  // the M3 resolver maps the inbound sender to its canonical contact.
  const seedLink = (h: WireHarness): void => {
    h.contacts.observe({
      email: SENDER_EMAIL,
      name: 'Dana Sender',
      source: 'email_from',
      event_at: NOW,
    });
    h.contacts.linkPlatformId({
      canonical_email: SENDER_EMAIL,
      vendor: 'slack',
      platform_id: 'U0ABC',
      state: 'confirmed',
      linked_at: NOW,
      linked_by: 'test',
    });
  };

  it('resolves the sender: fills actor_contact_id + counterparty_contact_id', async () => {
    const h = makeHarness();
    const off = h.wire();
    try {
      upsertSlackConnection(h.store, { match_patterns: PATTERNS });
      seedLink(h);

      h.bus.emit(messengerEvent());
      await flushAsync();

      const req = firstProposal(h.fire);
      expect(req.payload.counterparty_contact_id).toBe(SENDER_EMAIL);
      expect(req.payload.evidence_blob).toEqual([
        {
          kind: 'message',
          full_target_id: 'slack_m1',
          vendor: 'slack',
          actor_platform_id: 'U0ABC',
          actor_contact_id: SENDER_EMAIL,
          snippet: 'ship it #commit',
          sent_at: NOW,
          captured_at: NOW,
        },
      ]);
    } finally {
      off();
      h.close();
    }
  });

  it('leaves the sender opaque when no (vendor, platform_id) link exists', async () => {
    const h = makeHarness();
    const off = h.wire();
    try {
      upsertSlackConnection(h.store, { match_patterns: PATTERNS });
      // no seedLink — the sender is unlinked; the owner fills at approval

      h.bus.emit(messengerEvent());
      await flushAsync();

      const req = firstProposal(h.fire);
      expect(req.payload).not.toHaveProperty('counterparty_contact_id');
      expect((req.payload.evidence_blob as readonly unknown[])[0]).not.toHaveProperty(
        'actor_contact_id',
      );
    } finally {
      off();
      h.close();
    }
  });

  it('does not resolve when the contact store is not wired (dbless posture)', async () => {
    const h = makeHarness();
    const off = h.wire({ getContactStore: () => undefined });
    try {
      upsertSlackConnection(h.store, { match_patterns: PATTERNS });
      seedLink(h); // the link exists, but the store is not handed to the funnel

      h.bus.emit(messengerEvent());
      await flushAsync();

      const req = firstProposal(h.fire);
      expect(req.payload).not.toHaveProperty('counterparty_contact_id');
    } finally {
      off();
      h.close();
    }
  });
});
