import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';

import {
  COMMITMENT_EVIDENCE_BLOB_MAX_BYTES,
  COMMITMENT_EVIDENCE_DECLARABLE_KIND_SET,
  COMMITMENT_EVIDENCE_KIND_SET,
  COMMITMENT_EVIDENCE_RESERVED_KINDS,
  COMMITMENT_MAIL_EVIDENCE_SNIPPET_MAX,
  COMMITMENT_STATEMENT_MAX,
  CONNECTION_VENDOR_ENTITIES,
  RECUED_BUILTIN_SOURCE_ID,
  type CommitmentCrmFieldEvidence,
  type CommitmentEvidenceEntry,
  type CommitmentMailEvidence,
  type ExecutionSource,
  admitByOpRisk,
} from '@recued/contracts';
import { createWarehouseEventBus, type WarehouseEvent } from '@recued/warehouse-events';
import type { AuditEntry } from '@recued/storage';

import {
  COMMITMENT_COUNTERPARTY_CANDIDATE_CAP,
  COMMITMENT_EVIDENCE_CAPTURE_EVENT_KIND,
  COMMITMENT_EVIDENCE_PROPOSAL_RECIPE_ID,
  resolveCounterpartyFromContactEmails,
  type CommitmentEvidenceRuntime,
  type FireCommitmentEvidenceProposal,
  renderCommitmentStatement,
  wireCommitmentEvidenceCapture,
} from '../commitment-evidence-capture.js';
import {
  createEngagementStore,
  ensureEngagementSchema,
  type EngagementStore,
} from '../storage/engagement-store.js';
import {
  createCommitmentEvidenceLedger,
  type CommitmentEvidenceLedger,
} from '../storage/commitment-evidence-ledger.js';
import {
  WorkEntityValidationError,
  createWorkEntityStore,
  ensureWorkEntitySchema,
  type CommitmentWriteInput,
  type WorkEntityStore,
} from '../storage/work-entity-store.js';
import { createWorkEntityDispatchers } from '../work-entity-ingredients.js';
import { createWorkEntityResolver } from '../work-entity-resolver.js';
import {
  defaultIsReceptionOriginAnchor,
  defaultResolveInboxSource,
} from '../reception-inbox-handler.js';
import type { Checkpoint } from '@recued/contracts';

const NOW = 1_700_000_000_000;
const HUBSPOT_DEAL_SCOPE = 'connection.api.hubspot.deal';
const SALESFORCE_OPPORTUNITY_SCOPE = 'connection.api.salesforce.opportunity';
const HUBSPOT_CONTACT_SCOPE = 'connection.api.hubspot.contact';
const TARGET_ID = 'hubspot_deal_conn_42';

type FireMock = ReturnType<typeof vi.fn<FireCommitmentEvidenceProposal>>;
type ProposalRequest = Parameters<FireCommitmentEvidenceProposal>[0];

const reactiveSystemSource: ExecutionSource = {
  channel: 'reactive',
  actor: 'system',
  event_kind: 'commitment_evidence.capture',
  source_recipe: 'commitment-evidence-proposal',
};

const userSelfSource: ExecutionSource = {
  channel: 'user',
  actor: 'user_self',
  user_id: 'owner-1',
  client_token_id: 'client-1',
};

const flushAsync = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

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

const evidence = (
  overrides: Partial<CommitmentCrmFieldEvidence> = {},
): CommitmentEvidenceEntry => ({
  kind: 'crm_field',
  full_target_id: TARGET_ID,
  field: 'next_step',
  value: 'call Anna Friday',
  captured_at: NOW,
  ...overrides,
});

const malformedEvidence = (
  entry: Record<string, unknown>,
): readonly CommitmentEvidenceEntry[] => [entry as unknown as CommitmentEvidenceEntry];

/** The email-flagship (E0) `mail` evidence variant — the immutable
 *  snapshot the D-139 extraction engine's promise becomes at propose
 *  time. Point-in-time; `snippet` is a bounded paraphrase, never raw
 *  body. */
const mailEvidence = (
  overrides: Partial<CommitmentMailEvidence> = {},
): CommitmentMailEvidence => ({
  kind: 'mail',
  full_target_id: 'hubspot_email_conn_msg-7',
  source: 'engagement_email',
  actor_email: 'anna@acme.com',
  snippet: 'Anna will send the revised SOW by Friday.',
  confidence: 0.82,
  source_at: NOW - 1_000,
  captured_at: NOW,
  ...overrides,
});

const baseCommitmentInput = (
  overrides: Partial<CommitmentWriteInput> = {},
): CommitmentWriteInput => ({
  id: 'commitment-1',
  source_id: 'recued.commitment',
  direction: 'outbound',
  statement: 'Call Anna Friday',
  derivation: 'evidence_captured',
  ...overrides,
});

const makeDealEvent = (overrides: Partial<WarehouseEvent> = {}): WarehouseEvent => ({
  platform: HUBSPOT_DEAL_SCOPE,
  slug: 'hubspot',
  entity_type: 'deal',
  event_kind: 'updated',
  record_id: TARGET_ID,
  at: NOW,
  prev: { next_step: 'old' },
  record: { next_step: 'call Anna Friday' },
  changed_fields: ['next_step'],
  ...overrides,
});

const firstProposal = (fire: FireMock): ProposalRequest => {
  expect(fire).toHaveBeenCalledTimes(1);
  const call = fire.mock.calls[0];
  if (call === undefined) throw new Error('expected proposal fire');
  return call[0];
};

interface CaptureHarness {
  bus: ReturnType<typeof createWarehouseEventBus>;
  ledger: CommitmentEvidenceLedger;
  fire: FireMock;
  close: () => void;
}

const captureHarness = (opts: {
  fire?: FireMock;
  getRuntime?: () => CommitmentEvidenceRuntime | undefined;
} = {}): CaptureHarness => {
  const { db, close } = tempDb('d192-f1-ledger-');
  const bus = createWarehouseEventBus();
  const ledger = createCommitmentEvidenceLedger(db);
  const fire = opts.fire ?? vi.fn<FireCommitmentEvidenceProposal>(async () => undefined);
  const runtime: CommitmentEvidenceRuntime = {
    fire,
    resolveVendorRegistry: () => CONNECTION_VENDOR_ENTITIES,
  };
  const off = wireCommitmentEvidenceCapture({
    bus,
    getLedger: () => ledger,
    getRuntime: opts.getRuntime ?? ((): CommitmentEvidenceRuntime => runtime),
    now: () => NOW,
  });
  return {
    bus,
    ledger,
    fire,
    close: () => {
      off();
      close();
    },
  };
};

const registerCommitmentBuiltin = (store: WorkEntityStore): void => {
  const sourceId = RECUED_BUILTIN_SOURCE_ID('commitment');
  store.registerSource({
    id: sourceId,
    top_tier_kind: 'commitment',
    source_kind: 'builtin',
    source_label: 'Recued built-in commitment',
    write_capable: true,
    mcp_exposed: false,
    registered_at: NOW,
  });
  store.setDefaultSource('commitment', sourceId, NOW);
};

const mkAnchor = (execution_source: ExecutionSource | undefined): AuditEntry => ({
  run_id: 'run-1',
  recipe_id: 'recipe-1',
  recipe_hash: 'hash-1',
  started_at: NOW,
  finished_at: NOW,
  duration_ms: 0,
  commit_status: 'awaiting_approval',
  config_snapshot: {},
  errors: [],
  trigger_url: null,
  trigger_source: 'reactive',
  instance_id: null,
  execution_source,
  ask_id: 'ask-1',
  checkpoint_id: 'cp-1',
});

const mkCheckpoint = (): Checkpoint => ({
  checkpoint_id: 'cp-1',
  run_id: 'run-1',
  recipe_id: 'commitment-evidence-proposal',
  gated_step_id: 'propose_commitment',
  approved_target: {
    ingredient_slug: 'commitment-propose',
    operation_id: 'core.work-entity.commitment.propose',
  },
  step_state: {
    propose_commitment: {
      input: {
        statement: 'call Anna Friday',
        derivation: 'evidence_captured',
        top_tier_kind: 'commitment',
      },
    },
  },
  created_at: NOW,
});

describe('D-192 F1 commitment evidence approval lift', () => {
  it('lifts commitment-propose for system captures at the admin ceiling', () => {
    const verdict = admitByOpRisk({
      slug: 'commitment-propose',
      risk_tier: 'write',
      ceiling: 'admin',
      source: reactiveSystemSource,
    });

    expect(verdict.verdict).toBe('ask');
    if (verdict.verdict !== 'ask') throw new Error('expected ask verdict');
    expect(verdict.detail).toMatch(/review-then-approve/);
  });

  it('lifts the core commitment-propose alias identically', () => {
    const verdict = admitByOpRisk({
      slug: 'core-commitment-propose',
      risk_tier: 'write',
      ceiling: 'admin',
      source: reactiveSystemSource,
    });

    expect(verdict.verdict).toBe('ask');
    if (verdict.verdict !== 'ask') throw new Error('expected ask verdict');
    expect(verdict.detail).toMatch(/review-then-approve/);
  });

  it('does not lift plain commitment-create under owner automation trust', () => {
    const verdict = admitByOpRisk({
      slug: 'commitment-create',
      risk_tier: 'write',
      ceiling: 'admin',
      source: reactiveSystemSource,
    });

    expect(verdict).toEqual({
      verdict: 'admit',
      authorization_provenance: { pre_lift_approval: 'never' },
    });
  });

  it('keeps commitment-propose as ask for attended user_self dispatches', () => {
    const verdict = admitByOpRisk({
      slug: 'commitment-propose',
      risk_tier: 'write',
      ceiling: 'admin',
      source: userSelfSource,
    });

    expect(verdict.verdict).toBe('ask');
  });
});

describe('D-192 F1 commitment evidence capture producer', () => {
  it('unsubscribe closes admission and waits for an admitted proposal', async () => {
    const { db, close } = tempDb('d192-f1-drain-');
    const bus = createWarehouseEventBus();
    const ledger = createCommitmentEvidenceLedger(db);
    let releaseFire: (() => void) | undefined;
    const fire = vi.fn<FireCommitmentEvidenceProposal>(() =>
      new Promise<void>((resolve) => {
        releaseFire = resolve;
      }));
    const off = wireCommitmentEvidenceCapture({
      bus,
      getLedger: () => ledger,
      getRuntime: () => ({
        fire,
        resolveVendorRegistry: () => CONNECTION_VENDOR_ENTITIES,
      }),
      now: () => NOW,
    });
    try {
      bus.emit(makeDealEvent());
      expect(fire).toHaveBeenCalledTimes(1);

      let stopped = false;
      const firstStop = off();
      expect(off()).toBe(firstStop);
      const observed = firstStop.then(() => {
        stopped = true;
      });
      await Promise.resolve();
      expect(stopped).toBe(false);

      bus.emit(makeDealEvent({ record_id: 'deal-after-stop' }));
      expect(fire).toHaveBeenCalledTimes(1);
      if (releaseFire === undefined) throw new Error('proposal did not start');
      releaseFire();
      await observed;
    } finally {
      releaseFire?.();
      await off();
      close();
    }
  });

  it('fires one held proposal for a HubSpot deal next_step value_changed event', () => {
    const h = captureHarness();
    try {
      h.bus.emit(makeDealEvent());

      const request = firstProposal(h.fire);
      expect(request.execution_source).toEqual({
        channel: 'reactive',
        actor: 'system',
        source_recipe: COMMITMENT_EVIDENCE_PROPOSAL_RECIPE_ID,
        event_kind: COMMITMENT_EVIDENCE_CAPTURE_EVENT_KIND,
      });
      const firstStep = request.recipe.steps[0];
      expect(firstStep !== undefined && 'op' in firstStep ? firstStep.op : undefined)
        .toBe('core.work-entity.commitment.propose');
      expect(request.payload).toMatchObject({
        direction: 'outbound',
        statement: 'call Anna Friday',
        derivation: 'evidence_captured',
        promised_at: NOW,
        evidence_blob: [
          {
            kind: 'crm_field',
            full_target_id: TARGET_ID,
            field: 'next_step',
            value: 'call Anna Friday',
            prev_value: 'old',
            captured_at: NOW,
          },
        ],
      });
      expect(request.payload).not.toHaveProperty('promised_for_at');
    } finally {
      h.close();
    }
  });

  it('fires value_set without prev_value when the prior snapshot was present but empty', () => {
    const h = captureHarness();
    try {
      h.bus.emit(makeDealEvent({ prev: {}, record: { next_step: 'new step' } }));

      const request = firstProposal(h.fire);
      expect(request.payload.evidence_blob).toEqual([
        {
          kind: 'crm_field',
          full_target_id: TARGET_ID,
          field: 'next_step',
          value: 'new step',
          captured_at: NOW,
        },
      ]);
    } finally {
      h.close();
    }
  });

  it('suppresses non-capture folds and backfill-shaped events', () => {
    const h = captureHarness();
    try {
      h.bus.emit(makeDealEvent({ event_kind: 'created', prev: undefined }));
      h.bus.emit(makeDealEvent({ prev: undefined }));
      h.bus.emit(makeDealEvent({ prev: { next_step: 'old' }, record: {} }));
      h.bus.emit(makeDealEvent({ changed_fields: ['amount'], record: { next_step: 'call Anna Friday' } }));
      h.bus.emit(makeDealEvent({
        platform: HUBSPOT_CONTACT_SCOPE,
        entity_type: 'contact',
        record_id: 'hubspot_contact_conn_1',
      }));

      expect(h.fire).not.toHaveBeenCalled();
    } finally {
      h.close();
    }
  });

  it('deduplicates a same-value re-fold and proposes again for a different value', () => {
    const h = captureHarness();
    try {
      h.bus.emit(makeDealEvent());
      h.bus.emit(makeDealEvent());
      expect(h.fire).toHaveBeenCalledTimes(1);

      h.bus.emit(makeDealEvent({ record: { next_step: 'send renewal quote' } }));
      expect(h.fire).toHaveBeenCalledTimes(2);
    } finally {
      h.close();
    }
  });

  it('releases the ledger claim when proposal fire rejects, then persists it when fire resolves', async () => {
    const fire = vi.fn<FireCommitmentEvidenceProposal>()
      .mockRejectedValueOnce(new Error('dispatch failed'))
      .mockResolvedValue(undefined);
    const h = captureHarness({ fire });
    try {
      h.bus.emit(makeDealEvent());
      await flushAsync();
      expect(h.fire).toHaveBeenCalledTimes(1);
      expect(h.ledger.has({ full_target_id: TARGET_ID, field: 'next_step', value: 'call Anna Friday' }))
        .toBe(false);

      h.bus.emit(makeDealEvent());
      await flushAsync();
      expect(h.fire).toHaveBeenCalledTimes(2);
      expect(h.ledger.has({ full_target_id: TARGET_ID, field: 'next_step', value: 'call Anna Friday' }))
        .toBe(true);
    } finally {
      h.close();
    }
  });

  it('skips capture without claiming the ledger when runtime is absent', () => {
    const fire = vi.fn<FireCommitmentEvidenceProposal>(async () => undefined);
    const h = captureHarness({ fire, getRuntime: () => undefined });
    try {
      h.bus.emit(makeDealEvent());

      expect(h.fire).not.toHaveBeenCalled();
      expect(h.ledger.has({ full_target_id: TARGET_ID, field: 'next_step', value: 'call Anna Friday' }))
        .toBe(false);
    } finally {
      h.close();
    }
  });

  it('captures Salesforce Opportunity next_step via the crm_alias deal registry span', () => {
    const h = captureHarness();
    try {
      h.bus.emit(makeDealEvent({
        platform: SALESFORCE_OPPORTUNITY_SCOPE,
        slug: 'salesforce',
        entity_type: 'opportunity',
        record_id: 'salesforce_opportunity_conn_99',
      }));

      expect(h.fire).toHaveBeenCalledTimes(1);
      expect(firstProposal(h.fire).payload.evidence_blob).toEqual([
        {
          kind: 'crm_field',
          full_target_id: 'salesforce_opportunity_conn_99',
          field: 'next_step',
          value: 'call Anna Friday',
          prev_value: 'old',
          captured_at: NOW,
        },
      ]);
    } finally {
      h.close();
    }
  });
});

describe('D-192 F1 commitment evidence store lane', () => {
  it('roundtrips a valid evidence_blob on writeCommitment/readCommitment', () => {
    const { db, close } = tempDb('d192-f1-store-');
    try {
      ensureWorkEntitySchema(db);
      const store = createWorkEntityStore(db);
      registerCommitmentBuiltin(store);
      const blob = [evidence({ prev_value: 'old' })];

      const written = store.writeCommitment(baseCommitmentInput({ evidence_blob: blob }), NOW);
      expect(written.evidence_blob).toEqual(blob);
      expect(store.readCommitment('commitment-1')?.evidence_blob).toEqual(blob);
    } finally {
      close();
    }
  });

  it('rejects malformed evidence_blob payloads', () => {
    const { db, close } = tempDb('d192-f1-store-');
    try {
      ensureWorkEntitySchema(db);
      const store = createWorkEntityStore(db);
      registerCommitmentBuiltin(store);
      const overCap = 'x'.repeat(COMMITMENT_EVIDENCE_BLOB_MAX_BYTES + 1);
      const cases: readonly CommitmentWriteInput[] = [
        baseCommitmentInput({ id: 'empty-array', evidence_blob: [] }),
        baseCommitmentInput({ id: 'bad-kind', evidence_blob: malformedEvidence({ ...evidence(), kind: 'bogus' }) }),
        baseCommitmentInput({ id: 'empty-target', evidence_blob: [evidence({ full_target_id: '' })] }),
        baseCommitmentInput({ id: 'empty-field', evidence_blob: [evidence({ field: '' })] }),
        baseCommitmentInput({ id: 'empty-value', evidence_blob: [evidence({ value: '' })] }),
        baseCommitmentInput({ id: 'bad-time', evidence_blob: [evidence({ captured_at: Number.POSITIVE_INFINITY })] }),
        baseCommitmentInput({ id: 'over-cap', evidence_blob: [evidence({ value: overCap })] }),
      ];

      for (const input of cases) {
        expect(() => store.writeCommitment(input, NOW)).toThrow(WorkEntityValidationError);
      }
    } finally {
      close();
    }
  });

  it('keeps evidence_blob first-write-wins across same-id rewrites', () => {
    const { db, close } = tempDb('d192-f1-store-');
    try {
      ensureWorkEntitySchema(db);
      const store = createWorkEntityStore(db);
      registerCommitmentBuiltin(store);
      const first = [evidence({ value: 'first', captured_at: NOW })];
      const second = [evidence({ value: 'second', captured_at: NOW + 1 })];

      store.writeCommitment(baseCommitmentInput({ id: 'stable-evidence', evidence_blob: first }), NOW);
      store.writeCommitment(baseCommitmentInput({
        id: 'stable-evidence',
        statement: 'Second text',
        evidence_blob: second,
      }), NOW + 1);
      expect(store.readCommitment('stable-evidence')?.evidence_blob).toEqual(first);

      store.writeCommitment(baseCommitmentInput({
        id: 'stable-evidence',
        statement: 'Third text',
      }), NOW + 2);
      expect(store.readCommitment('stable-evidence')?.evidence_blob).toEqual(first);
    } finally {
      close();
    }
  });

  it('enforces evidence/derivation pairing through the commitmentCreate ingredient', async () => {
    const { db, close } = tempDb('d192-f1-ingredient-');
    try {
      ensureWorkEntitySchema(db);
      const store = createWorkEntityStore(db);
      registerCommitmentBuiltin(store);
      const dispatchers = createWorkEntityDispatchers({
        store,
        resolver: createWorkEntityResolver(store),
        now: () => NOW,
      });

      await expect(dispatchers.commitmentCreate({
        direction: 'outbound',
        statement: 'Missing evidence',
        derivation: 'evidence_captured',
      })).rejects.toThrow(WorkEntityValidationError);

      await expect(dispatchers.commitmentCreate({
        direction: 'outbound',
        statement: 'Wrong derivation',
        derivation: 'user_declared',
        evidence_blob: [evidence()],
      })).rejects.toThrow(WorkEntityValidationError);

      const created = await dispatchers.commitmentCreate({
        direction: 'outbound',
        statement: 'Captured evidence',
        derivation: 'evidence_captured',
        evidence_blob: [evidence()],
      });
      expect(store.readCommitment(created.commitment.id)?.evidence_blob).toEqual([evidence()]);
    } finally {
      close();
    }
  });
});

describe('D-192 email flagship — mail evidence entry (E0)', () => {
  it('roundtrips a mail evidence_blob on writeCommitment/readCommitment', () => {
    const { db, close } = tempDb('d192-mail-store-');
    try {
      ensureWorkEntitySchema(db);
      const store = createWorkEntityStore(db);
      registerCommitmentBuiltin(store);
      const blob = [mailEvidence({ vendor_url: 'https://app.hubspot.com/contacts/1/email/7' })];

      const written = store.writeCommitment(baseCommitmentInput({ id: 'mail-1', evidence_blob: blob }), NOW);
      expect(written.evidence_blob).toEqual(blob);
      expect(store.readCommitment('mail-1')?.evidence_blob).toEqual(blob);
    } finally {
      close();
    }
  });

  it('roundtrips a mixed crm_field + mail evidence_blob', () => {
    const { db, close } = tempDb('d192-mail-store-');
    try {
      ensureWorkEntitySchema(db);
      const store = createWorkEntityStore(db);
      registerCommitmentBuiltin(store);
      const blob = [evidence({ prev_value: 'old' }), mailEvidence()];

      store.writeCommitment(baseCommitmentInput({ id: 'mixed-1', evidence_blob: blob }), NOW);
      expect(store.readCommitment('mixed-1')?.evidence_blob).toEqual(blob);
    } finally {
      close();
    }
  });

  it('rejects malformed mail evidence entries', () => {
    const { db, close } = tempDb('d192-mail-store-');
    try {
      ensureWorkEntitySchema(db);
      const store = createWorkEntityStore(db);
      registerCommitmentBuiltin(store);
      const longEmail = `${'a'.repeat(250)}@x.com`; // > 254 chars
      const cases: readonly CommitmentWriteInput[] = [
        // source family gates (attachment is excluded at v1; unknown rejected)
        baseCommitmentInput({ id: 'src-attachment', evidence_blob: malformedEvidence({ ...mailEvidence(), source: 'attachment' }) }),
        baseCommitmentInput({ id: 'src-bogus', evidence_blob: malformedEvidence({ ...mailEvidence(), source: 'bogus' }) }),
        // actor_email shape guard
        baseCommitmentInput({ id: 'actor-empty', evidence_blob: [mailEvidence({ actor_email: '' })] }),
        baseCommitmentInput({ id: 'actor-no-at', evidence_blob: [mailEvidence({ actor_email: 'annaacme.com' })] }),
        baseCommitmentInput({ id: 'actor-space', evidence_blob: [mailEvidence({ actor_email: 'anna @acme.com' })] }),
        baseCommitmentInput({ id: 'actor-long', evidence_blob: [mailEvidence({ actor_email: longEmail })] }),
        // snippet bounds
        baseCommitmentInput({ id: 'snippet-empty', evidence_blob: [mailEvidence({ snippet: '' })] }),
        baseCommitmentInput({ id: 'snippet-long', evidence_blob: [mailEvidence({ snippet: 'x'.repeat(COMMITMENT_MAIL_EVIDENCE_SNIPPET_MAX + 1) })] }),
        // confidence range
        baseCommitmentInput({ id: 'conf-low', evidence_blob: [mailEvidence({ confidence: -0.01 })] }),
        baseCommitmentInput({ id: 'conf-high', evidence_blob: [mailEvidence({ confidence: 1.01 })] }),
        baseCommitmentInput({ id: 'conf-nan', evidence_blob: [mailEvidence({ confidence: Number.NaN })] }),
        // source_at + common fields
        baseCommitmentInput({ id: 'src-at-bad', evidence_blob: [mailEvidence({ source_at: Number.POSITIVE_INFINITY })] }),
        baseCommitmentInput({ id: 'mail-empty-target', evidence_blob: [mailEvidence({ full_target_id: '' })] }),
        baseCommitmentInput({ id: 'mail-bad-time', evidence_blob: [mailEvidence({ captured_at: Number.NaN })] }),
      ];

      for (const input of cases) {
        expect(() => store.writeCommitment(input, NOW), `expected ${input.id} to reject`).toThrow(WorkEntityValidationError);
      }
    } finally {
      close();
    }
  });

  it('refuses an over-cap mail evidence_blob (8 KiB serialized ceiling)', () => {
    const { db, close } = tempDb('d192-mail-store-');
    try {
      ensureWorkEntitySchema(db);
      const store = createWorkEntityStore(db);
      registerCommitmentBuiltin(store);
      // The snippet is capped at 200 chars, so oversize via the
      // uncapped vendor_url slot to prove the serialized-blob ceiling
      // applies to the mail variant too.
      const overCap = [mailEvidence({ vendor_url: 'x'.repeat(COMMITMENT_EVIDENCE_BLOB_MAX_BYTES + 1) })];
      expect(() => store.writeCommitment(baseCommitmentInput({ id: 'mail-over-cap', evidence_blob: overCap }), NOW))
        .toThrow(WorkEntityValidationError);
    } finally {
      close();
    }
  });

  it('mints an evidence_captured commitment bound to mail evidence', async () => {
    const { db, close } = tempDb('d192-mail-ingredient-');
    try {
      ensureWorkEntitySchema(db);
      const store = createWorkEntityStore(db);
      registerCommitmentBuiltin(store);
      const dispatchers = createWorkEntityDispatchers({
        store,
        resolver: createWorkEntityResolver(store),
        now: () => NOW,
      });

      const created = await dispatchers.commitmentCreate({
        direction: 'inbound',
        statement: 'Anna will send the revised SOW by Friday.',
        derivation: 'evidence_captured',
        counterparty_contact_id: 'anna@acme.com',
        evidence_blob: [mailEvidence()],
      });
      expect(store.readCommitment(created.commitment.id)?.evidence_blob).toEqual([mailEvidence()]);
    } finally {
      close();
    }
  });

  it('marks mail + message as live entry kinds but not manifest-declarable kinds', () => {
    expect(COMMITMENT_EVIDENCE_KIND_SET.has('mail')).toBe(true);
    expect(COMMITMENT_EVIDENCE_KIND_SET.has('message')).toBe(true);
    expect(COMMITMENT_EVIDENCE_DECLARABLE_KIND_SET.has('mail')).toBe(false);
    expect(COMMITMENT_EVIDENCE_DECLARABLE_KIND_SET.has('message')).toBe(false);
    expect(COMMITMENT_EVIDENCE_DECLARABLE_KIND_SET.has('crm_field')).toBe(true);
    // `mail` + `message` graduated (email + messenger flagships). No kind
    // is reserved: `file` is a SOURCE entity, not evidence (F-1=A
    // superseded, kinds-taxonomy § 3b).
    expect([...COMMITMENT_EVIDENCE_RESERVED_KINDS]).toEqual([]);
  });
});

describe('D-192 F1 commitment evidence inbox origin filter', () => {
  it('accepts exact commitment-evidence provenance and rejects substring impostors', () => {
    const sourceRecipeAnchor = mkAnchor({
      channel: 'reactive',
      actor: 'system',
      source_recipe: COMMITMENT_EVIDENCE_PROPOSAL_RECIPE_ID,
      event_kind: 'other.event',
    });
    const eventKindAnchor = mkAnchor({
      channel: 'reactive',
      actor: 'system',
      source_recipe: 'other-recipe',
      event_kind: COMMITMENT_EVIDENCE_CAPTURE_EVENT_KIND,
    });
    const impostorAnchor = mkAnchor({
      channel: 'reactive',
      actor: 'system',
      source_recipe: 'my-commitment-evidence-notes',
      event_kind: 'notes.updated',
    });

    expect(defaultIsReceptionOriginAnchor(sourceRecipeAnchor)).toBe(true);
    expect(defaultIsReceptionOriginAnchor(eventKindAnchor)).toBe(true);
    expect(defaultIsReceptionOriginAnchor(impostorAnchor)).toBe(false);
  });

  it('keeps reception tokens accepted and resolves commitment-evidence holds as vendor-origin', () => {
    const receptionAnchor = mkAnchor({
      channel: 'reactive',
      actor: 'system',
      source_recipe: 'recued-core/reception-intake-incoming',
      event_kind: 'reception.intake_form.submitted',
    });
    const evidenceAnchor = mkAnchor({
      channel: 'reactive',
      actor: 'system',
      source_recipe: COMMITMENT_EVIDENCE_PROPOSAL_RECIPE_ID,
      event_kind: COMMITMENT_EVIDENCE_CAPTURE_EVENT_KIND,
    });

    expect(defaultIsReceptionOriginAnchor(receptionAnchor)).toBe(true);
    expect(defaultResolveInboxSource({ anchor: evidenceAnchor, checkpoint: mkCheckpoint() })).toMatchObject({
      source: { kind: 'vendor', record_ref: 'cp-1' },
      preview: { title: 'Captured commitment proposal' },
      proposed_action: 'Create the commitment (evidence-captured) as edited',
    });
  });
});

describe('D-192 F1 commitment statement rendering', () => {
  it('renders the field_value placeholder and clamps rendered statements', () => {
    expect(renderCommitmentStatement('{{field_value}}', 'call Anna Friday'))
      .toBe('call Anna Friday');

    const rendered = renderCommitmentStatement('{{field_value}}', 'x'.repeat(COMMITMENT_STATEMENT_MAX + 50));
    expect(rendered).toHaveLength(COMMITMENT_STATEMENT_MAX);
  });
});

// ────────────────────────────────────────────────────────────────
// D-192 F1 counterparty resolution (`record_contact_edges` seam)
// ────────────────────────────────────────────────────────────────

describe('D-192 F1 counterparty decision (pure)', () => {
  const identity = (email: string): string => email;

  it('returns undefined when no contact candidates were surfaced', () => {
    expect(resolveCounterpartyFromContactEmails([], identity)).toBeUndefined();
  });

  it('returns the single distinct counterparty', () => {
    expect(resolveCounterpartyFromContactEmails(['anna@acme.com'], identity))
      .toBe('anna@acme.com');
  });

  it('collapses several raw emails that merge into one survivor to that survivor', () => {
    // anna.old@acme.com and anna@acme.com both redirect to the survivor.
    const survivorOf: Record<string, string> = {
      'anna.old@acme.com': 'anna@acme.com',
      'anna@acme.com': 'anna@acme.com',
    };
    expect(
      resolveCounterpartyFromContactEmails(
        ['anna.old@acme.com', 'anna@acme.com'],
        (e) => survivorOf[e] ?? e,
      ),
    ).toBe('anna@acme.com');
  });

  it('returns undefined when the deal spans two distinct counterparties', () => {
    expect(
      resolveCounterpartyFromContactEmails(['anna@acme.com', 'bob@other.com'], identity),
    ).toBeUndefined();
  });

  it('fails closed when a candidate forward-resolve throws (corrupt redirect)', () => {
    // Can no longer prove exactly one distinct counterparty — empty is
    // the honest default even though the resolvable remainder is single.
    const resolve = (e: string): string => {
      if (e === 'cycle@acme.com') throw new Error('contact_redirect_cycle');
      return e;
    };
    expect(
      resolveCounterpartyFromContactEmails(['cycle@acme.com', 'anna@acme.com'], resolve),
    ).toBeUndefined();
  });

  it('fails closed when a candidate forward-resolves to an empty string', () => {
    const resolve = (e: string): string => (e === 'ghost@acme.com' ? '' : e);
    expect(
      resolveCounterpartyFromContactEmails(['ghost@acme.com', 'anna@acme.com'], resolve),
    ).toBeUndefined();
  });

  it('fails closed on a truncated candidate set (> cap), even if all seen collapse to one', () => {
    // cap=2, three candidates → truncation detected → undefined, so a
    // deal with more raw contacts than the cap never confidently guesses.
    expect(
      resolveCounterpartyFromContactEmails(
        ['a@acme.com', 'a@acme.com', 'a@acme.com'],
        identity,
        2,
      ),
    ).toBeUndefined();
  });
});

describe('D-192 F1 deal→contact engagement-edge query', () => {
  const CONN = 'conn';
  const OTHER_DEAL = 'hubspot_deal_conn_99';

  const withStore = (fn: (store: EngagementStore) => void): void => {
    const { db, close } = tempDb('d192-f1-counterparty-');
    try {
      ensureEngagementSchema(db);
      fn(createEngagementStore(db));
    } finally {
      close();
    }
  };

  /** Upsert a `data.contact` (email-keyed) contact edge — the D-138
   *  identity resolution runs the target through `resolveContactRedirect`
   *  (identity callback here, no merge). */
  const contactEdge = (
    store: EngagementStore,
    engagement: string,
    email: string,
  ): void => {
    store.upsertEdge({
      connection_id: CONN,
      engagement_target_id: engagement,
      edge_type: 'contact',
      target_kind: 'data.contact',
      target_id: email,
      created_at: NOW,
      resolveContactRedirect: () => null,
    });
  };

  const dealEdge = (
    store: EngagementStore,
    engagement: string,
    deal: string,
  ): void => {
    store.upsertEdge({
      connection_id: CONN,
      engagement_target_id: engagement,
      edge_type: 'deal',
      target_kind: 'connection.api',
      target_id: deal,
      created_at: NOW,
    });
  };

  it('returns the distinct email contacts co-appearing on the deal engagements', () => {
    withStore((store) => {
      // eng_1 + eng_2 both touch the target deal; anna is on both, charlie on eng_2.
      dealEdge(store, 'eng_1', TARGET_ID);
      contactEdge(store, 'eng_1', 'anna@acme.com');
      dealEdge(store, 'eng_2', TARGET_ID);
      contactEdge(store, 'eng_2', 'anna@acme.com');
      contactEdge(store, 'eng_2', 'charlie@acme.com');
      // eng_3 touches a DIFFERENT deal — bob must not appear for the target.
      dealEdge(store, 'eng_3', OTHER_DEAL);
      contactEdge(store, 'eng_3', 'bob@other.com');

      expect(store.listDealCounterpartyContactEmails(TARGET_ID, COMMITMENT_COUNTERPARTY_CANDIDATE_CAP))
        .toEqual(['anna@acme.com', 'charlie@acme.com']);
      expect(store.listDealCounterpartyContactEmails(OTHER_DEAL, COMMITMENT_COUNTERPARTY_CANDIDATE_CAP))
        .toEqual(['bob@other.com']);
    });
  });

  it('excludes connection.api (Salesforce platform-id) contact edges', () => {
    withStore((store) => {
      dealEdge(store, 'eng_1', TARGET_ID);
      // A Salesforce platform-id contact edge — edge_type 'contact' but
      // keyed on connection.api, not an email. Must be excluded (no
      // un-resolvable vendor id may become a counterparty).
      store.upsertEdge({
        connection_id: CONN,
        engagement_target_id: 'eng_1',
        edge_type: 'contact',
        target_kind: 'connection.api',
        target_id: 'salesforce_contact_conn_003abc',
        created_at: NOW,
      });

      expect(store.listDealCounterpartyContactEmails(TARGET_ID, COMMITMENT_COUNTERPARTY_CANDIDATE_CAP))
        .toEqual([]);
    });
  });

  it('excludes tombstoned deal and contact edges', () => {
    withStore((store) => {
      dealEdge(store, 'eng_1', TARGET_ID);
      contactEdge(store, 'eng_1', 'anna@acme.com');
      dealEdge(store, 'eng_2', TARGET_ID);
      contactEdge(store, 'eng_2', 'charlie@acme.com');

      // Tombstone anna's contact edge → she drops out.
      store.tombstoneEdge({
        connection_id: CONN,
        engagement_target_id: 'eng_1',
        edge_type: 'contact',
        target_id: 'anna@acme.com',
        deleted_at: NOW + 1,
      });
      // Tombstone eng_2's DEAL edge → charlie's engagement no longer links the deal.
      store.tombstoneEdge({
        connection_id: CONN,
        engagement_target_id: 'eng_2',
        edge_type: 'deal',
        target_id: TARGET_ID,
        deleted_at: NOW + 1,
      });

      expect(store.listDealCounterpartyContactEmails(TARGET_ID, COMMITMENT_COUNTERPARTY_CANDIDATE_CAP))
        .toEqual([]);
    });
  });

  it('honors the candidate cap', () => {
    withStore((store) => {
      dealEdge(store, 'eng_1', TARGET_ID);
      contactEdge(store, 'eng_1', 'a@acme.com');
      contactEdge(store, 'eng_1', 'b@acme.com');
      contactEdge(store, 'eng_1', 'c@acme.com');

      expect(store.listDealCounterpartyContactEmails(TARGET_ID, 2)).toHaveLength(2);
    });
  });

  it('returns an empty list for an unknown deal', () => {
    withStore((store) => {
      expect(store.listDealCounterpartyContactEmails('hubspot_deal_conn_unknown', COMMITMENT_COUNTERPARTY_CANDIDATE_CAP))
        .toEqual([]);
    });
  });
});

describe('D-192 F1 counterparty resolver wiring (store + producer)', () => {
  const CONN = 'conn';

  /** Build the same closure compose-app-context hands the runtime:
   *  the engagement-edge query → the pure decision over a canonical
   *  resolver. */
  const buildResolver = (
    store: EngagementStore,
    resolveCanonical: (email: string) => string,
  ) => (full_target_id: string): string | undefined => {
    // Mirror compose-app-context: fetch cap + 1 for truncation detection.
    const emails = store.listDealCounterpartyContactEmails(
      full_target_id,
      COMMITMENT_COUNTERPARTY_CANDIDATE_CAP + 1,
    );
    if (emails.length === 0) return undefined;
    return resolveCounterpartyFromContactEmails(emails, resolveCanonical);
  };

  const seedDealWithContact = (store: EngagementStore, deal: string, email: string): void => {
    store.upsertEdge({
      connection_id: CONN,
      engagement_target_id: 'eng_1',
      edge_type: 'deal',
      target_kind: 'connection.api',
      target_id: deal,
      created_at: NOW,
    });
    store.upsertEdge({
      connection_id: CONN,
      engagement_target_id: 'eng_1',
      edge_type: 'contact',
      target_kind: 'data.contact',
      target_id: email,
      created_at: NOW,
      resolveContactRedirect: () => null,
    });
  };

  it('threads the resolved counterparty into the held proposal payload', () => {
    const { db, close } = tempDb('d192-f1-wire-');
    try {
      ensureEngagementSchema(db);
      const store = createEngagementStore(db);
      seedDealWithContact(store, TARGET_ID, 'anna@acme.com');

      const fire = vi.fn<FireCommitmentEvidenceProposal>(async () => undefined);
      const runtime: CommitmentEvidenceRuntime = {
        fire,
        resolveVendorRegistry: () => CONNECTION_VENDOR_ENTITIES,
        resolveCounterpartyContactId: buildResolver(store, (e) => e),
      };
      const h = captureHarness({ fire, getRuntime: () => runtime });
      try {
        h.bus.emit(makeDealEvent());
        expect(firstProposal(fire).payload).toMatchObject({
          counterparty_contact_id: 'anna@acme.com',
        });
      } finally {
        h.close();
      }
    } finally {
      close();
    }
  });

  it('omits counterparty_contact_id when the deal has no resolvable contact', () => {
    const { db, close } = tempDb('d192-f1-wire-empty-');
    try {
      ensureEngagementSchema(db);
      const store = createEngagementStore(db);
      // A deal edge with no contact edge → resolver returns undefined.
      store.upsertEdge({
        connection_id: CONN,
        engagement_target_id: 'eng_1',
        edge_type: 'deal',
        target_kind: 'connection.api',
        target_id: TARGET_ID,
        created_at: NOW,
      });

      const fire = vi.fn<FireCommitmentEvidenceProposal>(async () => undefined);
      const runtime: CommitmentEvidenceRuntime = {
        fire,
        resolveVendorRegistry: () => CONNECTION_VENDOR_ENTITIES,
        resolveCounterpartyContactId: buildResolver(store, (e) => e),
      };
      const h = captureHarness({ fire, getRuntime: () => runtime });
      try {
        h.bus.emit(makeDealEvent());
        expect(firstProposal(fire).payload).not.toHaveProperty('counterparty_contact_id');
      } finally {
        h.close();
      }
    } finally {
      close();
    }
  });
});
