/** D-192 messenger flagship M4 — message evidence + proposal funnel. */

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  COMMITMENT_MESSAGE_EVIDENCE_SNIPPET_MAX,
  type CommitmentMessageEvidence,
  type MessageMatchPattern,
  type MessageProjection,
} from '@recued/contracts';

import {
  COMMITMENT_EVIDENCE_CAPTURE_EVENT_KIND,
  COMMITMENT_EVIDENCE_PROPOSAL_RECIPE_ID,
  type FireCommitmentEvidenceProposal,
} from '../commitment-evidence-capture.js';
import {
  composeMessageEvidence,
  resolveMessageCommitmentActor,
  runMessageCommitmentFunnel,
  type MessageCommitmentActorInput,
} from '../message-commitment-funnel.js';
import {
  createMessageCommitmentLedger,
  type MessageCommitmentLedger,
} from '../storage/message-commitment-ledger.js';

const NOW = 1_700_000_000_000;
const SENT_AT = 1_699_999_999_000;
const TEXT = "I'll ship the deck Thursday #commit";
const PATTERNS: readonly MessageMatchPattern[] = [{ kind: 'tag', value: 'commit' }];

type FireMock = ReturnType<typeof vi.fn<FireCommitmentEvidenceProposal>>;
type ProposalRequest = Parameters<FireCommitmentEvidenceProposal>[0];

const proj = (over: Partial<MessageProjection> = {}): MessageProjection => ({
  vendor: 'slack',
  sender: 'U0ABC',
  text: TEXT,
  sent_at: SENT_AT,
  ...over,
});

const expectedEvidence = (
  over: Partial<CommitmentMessageEvidence> = {},
): CommitmentMessageEvidence => ({
  kind: 'message',
  full_target_id: 'slack_m1',
  vendor: 'slack',
  actor_platform_id: 'U0ABC',
  snippet: TEXT,
  sent_at: SENT_AT,
  captured_at: NOW,
  ...over,
});

const okFire = (): FireMock => vi.fn<FireCommitmentEvidenceProposal>(async () => undefined);

const firstCall = (fire: FireMock): ProposalRequest => {
  const call = fire.mock.calls[0];
  if (call === undefined) throw new Error('expected a proposal fire');
  return call[0];
};

describe('D-192 M4 — message evidence composition', () => {
  it('composes a vendor-scoped message evidence snapshot', () => {
    const evidence = composeMessageEvidence({
      projection: proj(),
      message_id: 'm1',
      captured_at: NOW,
    });
    expect(evidence).toEqual<CommitmentMessageEvidence>(expectedEvidence());
    expect(evidence?.full_target_id).toBe('slack_m1');
    expect(evidence?.full_target_id.startsWith('slack_')).toBe(true);
    expect(evidence).not.toHaveProperty('vendor_url');
  });

  it('carries vendor_url only when the projection has a permalink', () => {
    expect(
      composeMessageEvidence({
        projection: proj({ permalink: 'https://slack.test/archives/C1/p1699999999000' }),
        message_id: 'm1',
        captured_at: NOW,
      }),
    ).toEqual<CommitmentMessageEvidence>(
      expectedEvidence({ vendor_url: 'https://slack.test/archives/C1/p1699999999000' }),
    );
    expect(
      composeMessageEvidence({
        projection: proj(),
        message_id: 'm1',
        captured_at: NOW,
      }),
    ).not.toHaveProperty('vendor_url');
  });

  it('trims and caps the snippet', () => {
    const evidence = composeMessageEvidence({
      projection: proj({ text: `  ${'x'.repeat(300)}  ` }),
      message_id: 'm1',
      captured_at: NOW,
    });
    expect(evidence?.snippet).toHaveLength(COMMITMENT_MESSAGE_EVIDENCE_SNIPPET_MAX);
    expect(evidence?.snippet.startsWith(' ')).toBe(false);
    expect(evidence?.snippet.endsWith(' ')).toBe(false);
  });

  it('falls back to captured_at when sent_at is NaN or absent', () => {
    expect(
      composeMessageEvidence({
        projection: proj({ sent_at: Number.NaN }),
        message_id: 'm1',
        captured_at: NOW,
      })?.sent_at,
    ).toBe(NOW);
    expect(
      composeMessageEvidence({
        projection: proj({ sent_at: undefined }),
        message_id: 'm1',
        captured_at: NOW,
      })?.sent_at,
    ).toBe(NOW);
  });

  const malformedEvidenceCases: ReadonlyArray<[
    string,
    { projection?: MessageProjection; message_id?: string },
  ]> = [
    ['message_id', { message_id: '' }],
    ['vendor', { projection: proj({ vendor: '' }) }],
    ['sender', { projection: proj({ sender: '' }) }],
    ['text empty', { projection: proj({ text: '' }) }],
    ['text blank', { projection: proj({ text: '   ' }) }],
  ];

  it.each(malformedEvidenceCases)('fails closed for malformed %s', (_label, over) => {
    expect(
      composeMessageEvidence({
        projection: over.projection ?? proj(),
        message_id: over.message_id ?? 'm1',
        captured_at: NOW,
      }),
    ).toBeUndefined();
  });
});

describe('D-192 M4 — message commitment funnel', () => {
  let db: Database.Database;
  let ledger: MessageCommitmentLedger;

  beforeEach(() => {
    db = new Database(':memory:');
    ledger = createMessageCommitmentLedger(db);
  });

  afterEach(() => {
    db.close();
  });

  it('fires one held proposal with the F1 provenance and message evidence payload', async () => {
    const fire = okFire();
    const result = await runMessageCommitmentFunnel(
      { getFire: () => fire, ledger, now: () => NOW },
      { projection: proj(), patterns: PATTERNS, message_id: 'm1' },
    );
    expect(result).toEqual({ outcome: 'proposed' });
    expect(fire).toHaveBeenCalledTimes(1);

    const req = firstCall(fire);
    expect(req.recipe.recipe_id).toBe(COMMITMENT_EVIDENCE_PROPOSAL_RECIPE_ID);
    expect(req.execution_source).toEqual({
      channel: 'reactive',
      actor: 'system',
      event_kind: COMMITMENT_EVIDENCE_CAPTURE_EVENT_KIND,
      source_recipe: COMMITMENT_EVIDENCE_PROPOSAL_RECIPE_ID,
    });
    expect(req.payload).toEqual({
      direction: 'inbound',
      statement: TEXT,
      derivation: 'evidence_captured',
      promised_at: SENT_AT,
      evidence_blob: [expectedEvidence()],
    });
    expect(req.run_id).toBe(`message-commitment-slack_m1-${NOW}`);
  });

  it('dedups a re-run of the same vendor-scoped message id', async () => {
    const fire = okFire();
    const deps = { getFire: () => fire, ledger, now: () => NOW };

    expect(await runMessageCommitmentFunnel(deps, {
      projection: proj(),
      patterns: PATTERNS,
      message_id: 'm1',
    })).toEqual({ outcome: 'proposed' });
    expect(await runMessageCommitmentFunnel(deps, {
      projection: proj(),
      patterns: PATTERNS,
      message_id: 'm1',
    })).toEqual({ outcome: 'duplicate' });
    expect(fire).toHaveBeenCalledTimes(1);
    expect(ledger.has('slack_m1')).toBe(true);
  });

  it('scopes native message ids by vendor, so cross-vendor ids both propose', async () => {
    const fire = okFire();
    const deps = { getFire: () => fire, ledger, now: () => NOW };

    expect(await runMessageCommitmentFunnel(deps, {
      projection: proj({ vendor: 'slack' }),
      patterns: PATTERNS,
      message_id: 'm1',
    })).toEqual({ outcome: 'proposed' });
    expect(await runMessageCommitmentFunnel(deps, {
      projection: proj({ vendor: 'telegram' }),
      patterns: PATTERNS,
      message_id: 'm1',
    })).toEqual({ outcome: 'proposed' });

    expect(fire).toHaveBeenCalledTimes(2);
    expect(ledger.has('slack_m1')).toBe(true);
    expect(ledger.has('telegram_m1')).toBe(true);
    expect(firstCall(fire).payload).toEqual({
      direction: 'inbound',
      statement: TEXT,
      derivation: 'evidence_captured',
      promised_at: SENT_AT,
      evidence_blob: [expectedEvidence()],
    });
    expect(fire.mock.calls[1]![0].payload).toEqual({
      direction: 'inbound',
      statement: TEXT,
      derivation: 'evidence_captured',
      promised_at: SENT_AT,
      evidence_blob: [expectedEvidence({ full_target_id: 'telegram_m1', vendor: 'telegram' })],
    });
  });

  it('returns no_match without claiming when no pattern matches', async () => {
    const fire = okFire();
    expect(await runMessageCommitmentFunnel(
      { getFire: () => fire, ledger, now: () => NOW },
      { projection: proj({ text: 'just chatting' }), patterns: PATTERNS, message_id: 'm1' },
    )).toEqual({ outcome: 'no_match' });
    expect(fire).not.toHaveBeenCalled();
    expect(ledger.has('slack_m1')).toBe(false);
  });

  it('returns runtime_unavailable without claiming when fire is absent', async () => {
    expect(await runMessageCommitmentFunnel(
      { getFire: () => undefined, ledger, now: () => NOW },
      { projection: proj(), patterns: PATTERNS, message_id: 'm1' },
    )).toEqual({ outcome: 'runtime_unavailable' });
    expect(ledger.has('slack_m1')).toBe(false);
  });

  it('returns no_evidence without claiming when structured tags match but text is blank', async () => {
    const fire = okFire();
    expect(await runMessageCommitmentFunnel(
      { getFire: () => fire, ledger, now: () => NOW },
      { projection: proj({ text: '   ', tags: ['commit'] }), patterns: PATTERNS, message_id: 'm1' },
    )).toEqual({ outcome: 'no_evidence' });
    expect(fire).not.toHaveBeenCalled();
    expect(ledger.has('slack_m1')).toBe(false);
  });

  it.each([
    ['vendor', proj({ vendor: '' }), 'm1', 'slack_m1'],
    ['sender', proj({ sender: '' }), 'm1', 'slack_m1'],
    ['message_id', proj(), '', 'slack_'],
  ] as const)('returns no_evidence without claiming or firing for malformed %s', async (
    _label,
    projection,
    message_id,
    ledgerKey,
  ) => {
    const fire = okFire();
    expect(await runMessageCommitmentFunnel(
      { getFire: () => fire, ledger, now: () => NOW },
      { projection, patterns: PATTERNS, message_id },
    )).toEqual({ outcome: 'no_evidence' });
    expect(fire).not.toHaveBeenCalled();
    expect(ledger.has(ledgerKey)).toBe(false);
  });

  it('releases the claim when dispatch fails so a later redelivery proposes', async () => {
    const throwing = vi.fn<FireCommitmentEvidenceProposal>(async () => {
      throw new Error('pre-hold failure');
    });
    expect(await runMessageCommitmentFunnel(
      { getFire: () => throwing, ledger, now: () => NOW },
      { projection: proj(), patterns: PATTERNS, message_id: 'm1' },
    )).toEqual({ outcome: 'dispatch_failed' });
    expect(ledger.has('slack_m1')).toBe(false);

    const fire = okFire();
    expect(await runMessageCommitmentFunnel(
      { getFire: () => fire, ledger, now: () => NOW },
      { projection: proj(), patterns: PATTERNS, message_id: 'm1' },
    )).toEqual({ outcome: 'proposed' });
    expect(fire).toHaveBeenCalledTimes(1);
  });

  it('guards release failures and still returns dispatch_failed', async () => {
    const throwing = vi.fn<FireCommitmentEvidenceProposal>(async () => {
      throw new Error('pre-hold failure');
    });
    const guardedLedger: MessageCommitmentLedger = {
      tryClaim: ledger.tryClaim.bind(ledger),
      has: ledger.has.bind(ledger),
      release: () => {
        throw new Error('release failed');
      },
    };

    await expect(runMessageCommitmentFunnel(
      { getFire: () => throwing, ledger: guardedLedger, now: () => NOW },
      { projection: proj(), patterns: PATTERNS, message_id: 'm1' },
    )).resolves.toEqual({ outcome: 'dispatch_failed' });
  });

  it('uses captured_at for sent_at when the projection send time is NaN', async () => {
    const fire = okFire();
    expect(await runMessageCommitmentFunnel(
      { getFire: () => fire, ledger, now: () => NOW },
      { projection: proj({ sent_at: Number.NaN }), patterns: PATTERNS, message_id: 'm1' },
    )).toEqual({ outcome: 'proposed' });
    expect(firstCall(fire).payload).toEqual({
      direction: 'inbound',
      statement: TEXT,
      derivation: 'evidence_captured',
      promised_at: NOW,
      evidence_blob: [expectedEvidence({ sent_at: NOW })],
    });
  });
});

describe('D-192 M4 — message commitment ledger', () => {
  let db: Database.Database;
  let ledger: MessageCommitmentLedger;

  beforeEach(() => {
    db = new Database(':memory:');
    ledger = createMessageCommitmentLedger(db);
  });

  afterEach(() => {
    db.close();
  });

  it('claims once, dedups, releases, and probes state', () => {
    const input = { message_id: 'slack_m1', vendor: 'slack' };
    expect(ledger.has('slack_m1')).toBe(false);
    expect(ledger.tryClaim(input, NOW)).toBe(true);
    expect(ledger.has('slack_m1')).toBe(true);
    expect(ledger.tryClaim(input, NOW)).toBe(false);
    ledger.release('slack_m1');
    expect(ledger.has('slack_m1')).toBe(false);
    expect(ledger.tryClaim(input, NOW)).toBe(true);
    expect(ledger.has('slack_m1')).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────
// M3 — the messenger→contact resolver
// ────────────────────────────────────────────────────────────────

const LINKED_EMAIL = 'sender@acme.test';

describe('D-192 M3 — resolveMessageCommitmentActor', () => {
  it('resolves (vendor, platform_id) → canonical contact via lookup + canonical', () => {
    const lookupPlatformLink = vi.fn((_v: string, _p: string): string | null => LINKED_EMAIL);
    const resolveCanonical = vi.fn((_e: string): string | undefined => LINKED_EMAIL);
    expect(
      resolveMessageCommitmentActor({
        vendor: 'slack',
        actor_platform_id: 'U0ABC',
        lookupPlatformLink,
        resolveCanonical,
      }),
    ).toEqual({ actor_contact_id: LINKED_EMAIL });
    expect(lookupPlatformLink).toHaveBeenCalledWith('slack', 'U0ABC');
    expect(resolveCanonical).toHaveBeenCalledWith(LINKED_EMAIL);
  });

  it('forward-resolves the linked email through a merge to the survivor', () => {
    expect(
      resolveMessageCommitmentActor({
        vendor: 'slack',
        actor_platform_id: 'U0ABC',
        lookupPlatformLink: () => 'loser@acme.test',
        resolveCanonical: (e) => (e === 'loser@acme.test' ? 'survivor@acme.test' : e),
      }),
    ).toEqual({ actor_contact_id: 'survivor@acme.test' });
  });

  it('trims vendor and platform_id before the link lookup', () => {
    const lookupPlatformLink = vi.fn((_v: string, _p: string): string | null => LINKED_EMAIL);
    resolveMessageCommitmentActor({
      vendor: '  slack  ',
      actor_platform_id: '  U0ABC  ',
      lookupPlatformLink,
      resolveCanonical: () => LINKED_EMAIL,
    });
    expect(lookupPlatformLink).toHaveBeenCalledWith('slack', 'U0ABC');
  });

  const unresolvedCases: ReadonlyArray<[string, Partial<MessageCommitmentActorInput>]> = [
    ['missing lookup dep', { lookupPlatformLink: undefined, resolveCanonical: () => LINKED_EMAIL }],
    ['missing canonical dep', { lookupPlatformLink: () => LINKED_EMAIL, resolveCanonical: undefined }],
    ['blank vendor', { vendor: '  ', lookupPlatformLink: () => LINKED_EMAIL, resolveCanonical: () => LINKED_EMAIL }],
    ['blank platform_id', { actor_platform_id: '   ', lookupPlatformLink: () => LINKED_EMAIL, resolveCanonical: () => LINKED_EMAIL }],
    ['no link (null)', { lookupPlatformLink: () => null, resolveCanonical: () => LINKED_EMAIL }],
    ['no link (undefined)', { lookupPlatformLink: () => undefined, resolveCanonical: () => LINKED_EMAIL }],
    ['no link (empty)', { lookupPlatformLink: () => '', resolveCanonical: () => LINKED_EMAIL }],
    ['canonical empty', { lookupPlatformLink: () => LINKED_EMAIL, resolveCanonical: () => '' }],
    ['canonical undefined', { lookupPlatformLink: () => LINKED_EMAIL, resolveCanonical: () => undefined }],
    ['lookup throws', { lookupPlatformLink: () => { throw new Error('corrupt store'); }, resolveCanonical: () => LINKED_EMAIL }],
    ['canonical throws', { lookupPlatformLink: () => LINKED_EMAIL, resolveCanonical: () => { throw new Error('merge cycle'); } }],
  ];

  it.each(unresolvedCases)('fails closed for %s', (_label, over) => {
    expect(
      resolveMessageCommitmentActor({
        vendor: 'slack',
        actor_platform_id: 'U0ABC',
        ...over,
      }),
    ).toEqual({});
  });
});

describe('D-192 M3 — composeMessageEvidence attaches the resolved contact', () => {
  it('attaches actor_contact_id when provided', () => {
    expect(
      composeMessageEvidence({
        projection: proj(),
        message_id: 'm1',
        captured_at: NOW,
        actor_contact_id: LINKED_EMAIL,
      }),
    ).toEqual<CommitmentMessageEvidence>(expectedEvidence({ actor_contact_id: LINKED_EMAIL }));
  });

  it('omits actor_contact_id when absent or blank', () => {
    expect(
      composeMessageEvidence({ projection: proj(), message_id: 'm1', captured_at: NOW }),
    ).not.toHaveProperty('actor_contact_id');
    expect(
      composeMessageEvidence({
        projection: proj(),
        message_id: 'm1',
        captured_at: NOW,
        actor_contact_id: '   ',
      }),
    ).not.toHaveProperty('actor_contact_id');
  });
});

describe('D-192 M3 — funnel fills the resolved sender contact', () => {
  let db: Database.Database;
  let ledger: MessageCommitmentLedger;

  beforeEach(() => {
    db = new Database(':memory:');
    ledger = createMessageCommitmentLedger(db);
  });

  afterEach(() => {
    db.close();
  });

  it('sets actor_contact_id on the evidence and counterparty_contact_id on the payload', async () => {
    const fire = okFire();
    const result = await runMessageCommitmentFunnel(
      {
        getFire: () => fire,
        ledger,
        now: () => NOW,
        lookupPlatformLink: (v, p) => (v === 'slack' && p === 'U0ABC' ? LINKED_EMAIL : null),
        resolveCanonical: (e) => e,
      },
      { projection: proj(), patterns: PATTERNS, message_id: 'm1' },
    );
    expect(result).toEqual({ outcome: 'proposed' });
    expect(firstCall(fire).payload).toEqual({
      direction: 'inbound',
      statement: TEXT,
      derivation: 'evidence_captured',
      promised_at: SENT_AT,
      evidence_blob: [expectedEvidence({ actor_contact_id: LINKED_EMAIL })],
      counterparty_contact_id: LINKED_EMAIL,
    });
  });

  it('omits both when the sender is unlinked (owner fills at approval)', async () => {
    const fire = okFire();
    await runMessageCommitmentFunnel(
      {
        getFire: () => fire,
        ledger,
        now: () => NOW,
        lookupPlatformLink: () => null,
        resolveCanonical: (e) => e,
      },
      { projection: proj(), patterns: PATTERNS, message_id: 'm1' },
    );
    const req = firstCall(fire);
    expect(req.payload).not.toHaveProperty('counterparty_contact_id');
    expect(req.payload.evidence_blob).toEqual([expectedEvidence()]);
  });
});
