import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import {
  COMMITMENT_EVIDENCE_BLOB_MAX_BYTES,
  COMMITMENT_MESSAGE_EVIDENCE_SNIPPET_MAX,
  RECUED_BUILTIN_SOURCE_ID,
  type CommitmentEvidenceEntry,
  type CommitmentMessageEvidence,
} from '@recued/contracts';

import {
  WorkEntityValidationError,
  createWorkEntityStore,
  ensureWorkEntitySchema,
  type CommitmentWriteInput,
  type WorkEntityStore,
} from '../storage/work-entity-store.js';
import { createWorkEntityDispatchers } from '../work-entity-ingredients.js';
import { createWorkEntityResolver } from '../work-entity-resolver.js';

const NOW = 1_700_000_000_000;

const tempDb = (prefix: string): { db: Database.Database; close: () => void } => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const db = new Database(join(dir, 'test.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return {
    db,
    close: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
};

const messageEvidence = (
  overrides: Partial<CommitmentMessageEvidence> = {},
): CommitmentMessageEvidence => ({
  kind: 'message',
  full_target_id: 'slack_C123_msg-7',
  vendor: 'slack',
  actor_platform_id: 'U0ABC',
  snippet: "I'll ship the deck by Thursday.",
  sent_at: NOW - 1_000,
  captured_at: NOW,
  ...overrides,
});

const malformedEvidence = (
  entry: Record<string, unknown>,
): readonly CommitmentEvidenceEntry[] => [entry as unknown as CommitmentEvidenceEntry];

const baseCommitmentInput = (
  overrides: Partial<CommitmentWriteInput> = {},
): CommitmentWriteInput => ({
  id: 'commitment-1',
  source_id: 'recued.commitment',
  direction: 'outbound',
  statement: 'Ship the deck by Thursday',
  derivation: 'evidence_captured',
  ...overrides,
});

const registerCommitmentBuiltin = (store: WorkEntityStore): void => {
  const sourceId = RECUED_BUILTIN_SOURCE_ID('commitment');
  store.registerSource({
    id: sourceId,
    top_tier_kind: 'commitment',
    source_kind: 'builtin',
    source_label: 'Recued built-in commitment',
    write_capable: true,
    registered_at: NOW,
  });
};

describe('D-192 messenger flagship — message evidence entry (M0)', () => {
  it('mints an evidence_captured commitment bound to minimal message evidence', async () => {
    const { db, close } = tempDb('d192-message-ingredient-');
    try {
      ensureWorkEntitySchema(db);
      const store = createWorkEntityStore(db);
      registerCommitmentBuiltin(store);
      const dispatchers = createWorkEntityDispatchers({
        store,
        resolver: createWorkEntityResolver(store),
        now: () => NOW,
      });

      const blob = [messageEvidence()];
      const created = await dispatchers.commitmentCreate({
        direction: 'inbound',
        statement: 'Ship the deck by Thursday',
        derivation: 'evidence_captured',
        evidence_blob: blob,
      });
      expect(store.readCommitment(created.commitment.id)?.evidence_blob).toEqual(blob);
    } finally {
      close();
    }
  });

  it('roundtrips fully-populated message evidence optional fields', async () => {
    const { db, close } = tempDb('d192-message-ingredient-');
    try {
      ensureWorkEntitySchema(db);
      const store = createWorkEntityStore(db);
      registerCommitmentBuiltin(store);
      const dispatchers = createWorkEntityDispatchers({
        store,
        resolver: createWorkEntityResolver(store),
        now: () => NOW,
      });

      const blob = [
        messageEvidence({
          actor_contact_id: 'anna@acme.com',
          confidence: 0.9,
          vendor_url: 'https://slack.com/archives/C123/p1',
        }),
      ];
      const created = await dispatchers.commitmentCreate({
        direction: 'inbound',
        statement: 'Ship the deck by Thursday',
        derivation: 'evidence_captured',
        counterparty_contact_id: 'anna@acme.com',
        evidence_blob: blob,
      });
      expect(store.readCommitment(created.commitment.id)?.evidence_blob).toEqual(blob);
    } finally {
      close();
    }
  });

  it('rejects malformed message evidence entries', () => {
    const { db, close } = tempDb('d192-message-store-');
    try {
      ensureWorkEntitySchema(db);
      const store = createWorkEntityStore(db);
      registerCommitmentBuiltin(store);
      const cases: readonly CommitmentWriteInput[] = [
        baseCommitmentInput({ id: 'vendor-empty', evidence_blob: [messageEvidence({ vendor: '' })] }),
        baseCommitmentInput({ id: 'vendor-non-string', evidence_blob: malformedEvidence({ ...messageEvidence(), vendor: 42 }) }),
        baseCommitmentInput({ id: 'actor-platform-empty', evidence_blob: [messageEvidence({ actor_platform_id: '' })] }),
        baseCommitmentInput({ id: 'actor-platform-non-string', evidence_blob: malformedEvidence({ ...messageEvidence(), actor_platform_id: 42 }) }),
        baseCommitmentInput({ id: 'actor-contact-empty', evidence_blob: [messageEvidence({ actor_contact_id: '' })] }),
        baseCommitmentInput({ id: 'actor-contact-non-string', evidence_blob: malformedEvidence({ ...messageEvidence(), actor_contact_id: 42 }) }),
        baseCommitmentInput({ id: 'snippet-empty', evidence_blob: [messageEvidence({ snippet: '' })] }),
        baseCommitmentInput({ id: 'snippet-long', evidence_blob: [messageEvidence({ snippet: 'x'.repeat(COMMITMENT_MESSAGE_EVIDENCE_SNIPPET_MAX + 1) })] }),
        baseCommitmentInput({ id: 'sent-at-infinity', evidence_blob: [messageEvidence({ sent_at: Number.POSITIVE_INFINITY })] }),
        baseCommitmentInput({ id: 'sent-at-nan', evidence_blob: [messageEvidence({ sent_at: Number.NaN })] }),
        baseCommitmentInput({ id: 'sent-at-non-number', evidence_blob: malformedEvidence({ ...messageEvidence(), sent_at: 'bad' }) }),
        baseCommitmentInput({ id: 'confidence-low', evidence_blob: [messageEvidence({ confidence: -0.01 })] }),
        baseCommitmentInput({ id: 'confidence-high', evidence_blob: [messageEvidence({ confidence: 1.01 })] }),
        baseCommitmentInput({ id: 'confidence-nan', evidence_blob: [messageEvidence({ confidence: Number.NaN })] }),
        baseCommitmentInput({ id: 'message-empty-target', evidence_blob: [messageEvidence({ full_target_id: '' })] }),
        baseCommitmentInput({ id: 'message-bad-time', evidence_blob: [messageEvidence({ captured_at: Number.NaN })] }),
      ];

      for (const input of cases) {
        expect(() => store.writeCommitment(input, NOW), `expected ${input.id} to reject`).toThrow(WorkEntityValidationError);
      }
    } finally {
      close();
    }
  });

  it('refuses an over-cap message evidence_blob (8 KiB serialized ceiling)', () => {
    const { db, close } = tempDb('d192-message-store-');
    try {
      ensureWorkEntitySchema(db);
      const store = createWorkEntityStore(db);
      registerCommitmentBuiltin(store);
      // The snippet is capped at 200 chars, so oversize via the
      // uncapped vendor_url slot to prove the serialized-blob ceiling
      // applies to the message variant too.
      const overCap = [messageEvidence({ vendor_url: 'x'.repeat(COMMITMENT_EVIDENCE_BLOB_MAX_BYTES + 1) })];
      expect(() => store.writeCommitment(baseCommitmentInput({ id: 'message-over-cap', evidence_blob: overCap }), NOW))
        .toThrow(WorkEntityValidationError);
    } finally {
      close();
    }
  });

  it('roundtrips a mixed crm_field + message evidence_blob', async () => {
    const { db, close } = tempDb('d192-message-ingredient-');
    try {
      ensureWorkEntitySchema(db);
      const store = createWorkEntityStore(db);
      registerCommitmentBuiltin(store);
      const dispatchers = createWorkEntityDispatchers({
        store,
        resolver: createWorkEntityResolver(store),
        now: () => NOW,
      });
      const blob: readonly CommitmentEvidenceEntry[] = [
        {
          kind: 'crm_field',
          full_target_id: 'hubspot_deal_conn_42',
          field: 'next_step',
          value: 'call Anna',
          captured_at: NOW,
        },
        messageEvidence(),
      ];

      const created = await dispatchers.commitmentCreate({
        direction: 'outbound',
        statement: 'Ship the deck by Thursday',
        derivation: 'evidence_captured',
        evidence_blob: blob,
      });
      expect(store.readCommitment(created.commitment.id)?.evidence_blob).toEqual(blob);
    } finally {
      close();
    }
  });
});
