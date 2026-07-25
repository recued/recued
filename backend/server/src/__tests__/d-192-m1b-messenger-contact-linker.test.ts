/** D-192 M1b — the declaration-driven messenger→contact link WRITER.
 *
 *  Locks `ensureMessengerSenderLinked` (the vendor-agnostic, declaration-gated,
 *  fail-open writer), the `MESSENGER_PROFILE_EMAIL_LEAVES` adapter registry, and
 *  the funnel integration: `runMessageCommitmentFunnel` awaits `ensureSenderLinked`
 *  BEFORE the M3 resolve, so a first-time matched sender links + resolves in one
 *  pass, and a throwing writer never blocks the proposal.
 *
 *  Spec: `docs/d-192-kinds-taxonomy.md` §3a (M-1). */

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ensureMessengerSenderLinked,
  MESSENGER_PROFILE_EMAIL_LEAVES,
  type MessengerPlatformLinkWrite,
} from '../messenger-contact-linker.js';
import {
  createMessageCommitmentLedger,
  type MessageCommitmentLedger,
} from '../storage/message-commitment-ledger.js';
import { runMessageCommitmentFunnel } from '../message-commitment-funnel.js';
import type { FireCommitmentEvidenceProposal } from '../commitment-evidence-capture.js';

const NOW = 1_700_000_000_000;
// D-192 slice 4 — the receiving messenger connection stamped on the link.
const CONN = 'my-slack';

type FireMock = ReturnType<typeof vi.fn<FireCommitmentEvidenceProposal>>;
const okFire = (): FireMock => vi.fn<FireCommitmentEvidenceProposal>(async () => undefined);

// ────────────────────────────────────────────────────────────────
// The writer
// ────────────────────────────────────────────────────────────────

interface LinkerHarness {
  linkPlatformId: ReturnType<typeof vi.fn<(input: MessengerPlatformLinkWrite) => void>>;
  lookupPlatformLink: ReturnType<typeof vi.fn<(v: string, p: string) => string | null | undefined>>;
  fetchProfileEmail: ReturnType<typeof vi.fn<(v: string, p: string) => Promise<string | null>>>;
}

const harness = (over: Partial<LinkerHarness> = {}): LinkerHarness => ({
  linkPlatformId: vi.fn<(input: MessengerPlatformLinkWrite) => void>(),
  lookupPlatformLink: vi.fn<(v: string, p: string) => string | null | undefined>(() => null),
  fetchProfileEmail: vi.fn<(v: string, p: string) => Promise<string | null>>(async () => 'a@b.test'),
  ...over,
});

const run = (h: LinkerHarness, vendor: string, platform_id: string): Promise<void> =>
  ensureMessengerSenderLinked(
    {
      lookupPlatformLink: h.lookupPlatformLink,
      linkPlatformId: h.linkPlatformId,
      fetchProfileEmail: h.fetchProfileEmail,
      now: () => NOW,
    },
    { vendor, platform_id, connection_name: CONN },
  );

describe('D-192 M1b — ensureMessengerSenderLinked', () => {
  it('links a first-seen Slack sender (fetch → canonical link write)', async () => {
    const h = harness({
      fetchProfileEmail: vi.fn(async () => '  Alice@Acme.test '),
    });
    await run(h, 'slack', 'U0ABC');
    expect(h.fetchProfileEmail).toHaveBeenCalledWith('slack', 'U0ABC');
    expect(h.linkPlatformId).toHaveBeenCalledTimes(1);
    expect(h.linkPlatformId).toHaveBeenCalledWith({
      canonical_email: 'alice@acme.test', // lowercased + trimmed
      vendor: 'slack',
      platform_id: 'U0ABC',
      state: 'auto',
      linked_by: 'messenger:slack',
      linked_at: NOW,
      connection_name: CONN, // D-192 slice 4 — stamped for connection-precise retract
    });
  });

  it('skips the fetch entirely for an already-linked sender', async () => {
    const h = harness({ lookupPlatformLink: vi.fn(() => 'known@acme.test') });
    await run(h, 'slack', 'U0ABC');
    expect(h.fetchProfileEmail).not.toHaveBeenCalled();
    expect(h.linkPlatformId).not.toHaveBeenCalled();
  });

  it('is a structural no-op for a `none` vendor (Telegram exposes no email)', async () => {
    const h = harness();
    await run(h, 'telegram', '12345');
    expect(h.fetchProfileEmail).not.toHaveBeenCalled();
    expect(h.linkPlatformId).not.toHaveBeenCalled();
  });

  it('no-ops for an undeclared vendor', async () => {
    const h = harness();
    await run(h, 'whatsapp', 'W1');
    expect(h.fetchProfileEmail).not.toHaveBeenCalled();
    expect(h.linkPlatformId).not.toHaveBeenCalled();
  });

  it('no-ops when no fetchProfileEmail dep is supplied', async () => {
    const linkPlatformId = vi.fn<(input: MessengerPlatformLinkWrite) => void>();
    await ensureMessengerSenderLinked(
      { lookupPlatformLink: () => null, linkPlatformId, now: () => NOW },
      { vendor: 'slack', platform_id: 'U0ABC', connection_name: CONN },
    );
    expect(linkPlatformId).not.toHaveBeenCalled();
  });

  it('writes no link when the profile fetch returns null', async () => {
    const h = harness({ fetchProfileEmail: vi.fn(async () => null) });
    await run(h, 'slack', 'U0ABC');
    expect(h.linkPlatformId).not.toHaveBeenCalled();
  });

  it('fails open when the profile fetch throws', async () => {
    const h = harness({
      fetchProfileEmail: vi.fn(async () => {
        throw new Error('boom');
      }),
    });
    await expect(run(h, 'slack', 'U0ABC')).resolves.toBeUndefined();
    expect(h.linkPlatformId).not.toHaveBeenCalled();
  });

  it('fails open (no fetch, no link) when the link lookup throws', async () => {
    const h = harness({
      lookupPlatformLink: vi.fn(() => {
        throw new Error('corrupt store');
      }),
    });
    await run(h, 'slack', 'U0ABC');
    expect(h.fetchProfileEmail).not.toHaveBeenCalled();
    expect(h.linkPlatformId).not.toHaveBeenCalled();
  });

  it('swallows a link-write failure (best-effort)', async () => {
    const h = harness({
      linkPlatformId: vi.fn(() => {
        throw new Error('db closed');
      }),
    });
    await expect(run(h, 'slack', 'U0ABC')).resolves.toBeUndefined();
  });

  it('no-ops on a blank vendor / platform_id', async () => {
    const h = harness();
    await run(h, '  ', 'U0ABC');
    await run(h, 'slack', '   ');
    expect(h.fetchProfileEmail).not.toHaveBeenCalled();
    expect(h.linkPlatformId).not.toHaveBeenCalled();
  });

  it('writes no link when the fetched email is blank', async () => {
    const h = harness({ fetchProfileEmail: vi.fn(async () => '   ') });
    await run(h, 'slack', 'U0ABC');
    expect(h.linkPlatformId).not.toHaveBeenCalled();
  });

  it('honours a getDeclaration override', async () => {
    const linkPlatformId = vi.fn<(input: MessengerPlatformLinkWrite) => void>();
    await ensureMessengerSenderLinked(
      {
        lookupPlatformLink: () => null,
        linkPlatformId,
        fetchProfileEmail: async () => 'x@y.test',
        getDeclaration: () => null, // treat every vendor as undeclared
        now: () => NOW,
      },
      { vendor: 'slack', platform_id: 'U0ABC', connection_name: CONN },
    );
    expect(linkPlatformId).not.toHaveBeenCalled();
  });
});

describe('D-192 M1b — MESSENGER_PROFILE_EMAIL_LEAVES', () => {
  it('declares a Slack leaf and no Telegram leaf', () => {
    expect(typeof MESSENGER_PROFILE_EMAIL_LEAVES.slack).toBe('function');
    expect(MESSENGER_PROFILE_EMAIL_LEAVES.telegram).toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────────
// Funnel integration — ensureSenderLinked runs BEFORE the M3 resolve
// ────────────────────────────────────────────────────────────────

describe('D-192 M1b — funnel ensureSenderLinked ordering', () => {
  let db: Database.Database;
  let ledger: MessageCommitmentLedger;

  beforeEach(() => {
    db = new Database(':memory:');
    ledger = createMessageCommitmentLedger(db);
  });
  afterEach(() => db.close());

  const matchingInput = {
    projection: { vendor: 'slack', sender: 'U0ABC', text: 'ship it #commit', sent_at: NOW },
    patterns: [{ kind: 'tag', value: 'commit' }] as const,
    message_id: 'm1',
  };

  it('links the sender first, so the SAME message resolves the counterparty', async () => {
    // A shared link table the writer populates and the M3 resolver reads.
    const links = new Map<string, string>();
    const fire = okFire();
    await runMessageCommitmentFunnel(
      {
        getFire: () => fire,
        ledger,
        lookupPlatformLink: (v, p) => links.get(`${v}:${p}`) ?? null,
        resolveCanonical: (email) => email,
        ensureSenderLinked: async (v, p) => {
          links.set(`${v}:${p}`, 'alice@acme.test');
        },
        now: () => NOW,
      },
      matchingInput,
    );
    expect(fire).toHaveBeenCalledTimes(1);
    const payload = fire.mock.calls[0]?.[0].payload as Record<string, unknown>;
    expect(payload.counterparty_contact_id).toBe('alice@acme.test');
  });

  it('still proposes when ensureSenderLinked throws (guarded, fail-open)', async () => {
    const fire = okFire();
    const { outcome } = await runMessageCommitmentFunnel(
      {
        getFire: () => fire,
        ledger,
        lookupPlatformLink: () => null,
        resolveCanonical: (email) => email,
        ensureSenderLinked: async () => {
          throw new Error('writer blew up');
        },
        now: () => NOW,
      },
      matchingInput,
    );
    expect(outcome).toBe('proposed');
    expect(fire).toHaveBeenCalledTimes(1);
    // Unlinked sender ⇒ counterparty omitted (owner fills at approval).
    const payload = fire.mock.calls[0]?.[0].payload as Record<string, unknown>;
    expect(payload.counterparty_contact_id).toBeUndefined();
  });

  it('does not invoke ensureSenderLinked when the message does not match', async () => {
    const ensureSenderLinked = vi.fn(async () => undefined);
    const fire = okFire();
    const { outcome } = await runMessageCommitmentFunnel(
      { getFire: () => fire, ledger, ensureSenderLinked, now: () => NOW },
      { ...matchingInput, projection: { ...matchingInput.projection, text: 'no tags here' } },
    );
    expect(outcome).toBe('no_match');
    expect(ensureSenderLinked).not.toHaveBeenCalled();
  });
});
