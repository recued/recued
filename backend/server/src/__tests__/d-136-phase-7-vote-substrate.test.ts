/** D-136 P7 — Quality-vote substrate tests.
 *
 *  Vote substrate ships:
 *    - `data_enrichment_quality_vote` table extensions (`agent_session_id`,
 *      `agent_sub_path`, `routing`, `pinned_row_id`).
 *    - `EnrichmentStore.writeQualityVote` / `deleteQualityVote` /
 *      `getQualityVote` / `listQualityVotes` / `getById` API.
 *    - `enrichment.vote.write` + `enrichment.vote.delete` rpc handlers.
 *
 *  Vote → lifecycle queue routing per §A.11:
 *    - `'wrong' | 'stale'` → `lifecycle_action_pending = 'recompute'`
 *      on the target row (or `'discard'` when the topic's policy is
 *      TTL / historical).
 *    - `'corrected'` → write user-pinned row via `mode: 'pinned'` +
 *      `authored_by = 'system.user_correction.<vote_id>'`.
 *    - `'correct'` → reset `failure_attempt_count` on the row.
 *    - `'irrelevant'` → persist vote only.
 *
 *  Plus the source-vs-client validation matrix (handler-side):
 *    - `vote: 'corrected'` with `source: 'user_dismissal' | 'user_action'`
 *      hard-rejects (write-tier required).
 *
 *  Spec: D-136 §A.11 + §A.13.7. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { RpcError } from '@recued/contracts';

import {
  createEnrichmentStore,
  type EnrichmentStore,
} from '../storage/enrichment-store.js';
import {
  handleEnrichmentVoteDelete,
  handleEnrichmentVoteWrite,
} from '../enrichment-handler.js';

const NOW = 1_750_000_000_000;

let dir: string;
let db: Database.Database;
let store: EnrichmentStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd-136-p7-vote-'));
  db = new Database(join(dir, 'test.db'));
  store = createEnrichmentStore(db, { now: () => NOW });
});

afterEach(() => {
  store.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

// ────────────────────────────────────────────────────────────────
// Fixtures
// ────────────────────────────────────────────────────────────────

const PURPOSE = (
  override: Record<string, unknown> = {},
): { purpose: string; confidence: number } => ({
  purpose: 'inquiry',
  confidence: 0.7,
  ...override,
});

const writePurposeRow = (target_id = 'mail_1') =>
  store.upsert({
    topic: 'purpose',
    scope: 'mail',
    target_id,
    authored_by: 'system.housekeeping.purpose',
    value: PURPOSE(),
    event_at: NOW - 60_000,
  });

// ────────────────────────────────────────────────────────────────
// 1. Schema additions
// ────────────────────────────────────────────────────────────────

describe('vote table schema — agent_session_id + agent_sub_path + routing + pinned_row_id', () => {
  it('the four P7 columns are present on a fresh DB', () => {
    const cols = (
      db
        .prepare('PRAGMA table_info(data_enrichment_quality_vote)')
        .all() as { name: string }[]
    ).map((c) => c.name);
    expect(cols).toContain('agent_session_id');
    expect(cols).toContain('agent_sub_path');
    expect(cols).toContain('routing');
    expect(cols).toContain('pinned_row_id');
  });
});

// ────────────────────────────────────────────────────────────────
// 2. writeQualityVote — routing per vote kind
// ────────────────────────────────────────────────────────────────

describe('writeQualityVote — vote → lifecycle queue routing', () => {
  it('vote=wrong on a non-pinned row enqueues recompute + flips staleness to stale', () => {
    const row = writePurposeRow();
    expect(row.staleness_class).toBe('fresh');
    expect(row.lifecycle_action_pending).toBeNull();

    const out = store.writeQualityVote({
      topic: 'purpose',
      scope: 'mail',
      target_id: 'mail_1',
      enrichment_row_id: row._id,
      vote: 'wrong',
      source: 'user_action',
      voted_by_client_id: 'inst-laptop',
    });

    expect(out.routing).toBe('recompute');
    expect(out.pinned_row_id).toBeNull();
    expect(out.vote_id).toMatch(/^vote_/);

    const refreshed = store.getById(row._id)!;
    expect(refreshed.lifecycle_action_pending).toBe('recompute');
    expect(refreshed.staleness_class).toBe('stale');

    // The vote row records the routing decision so the audit trail
    // captures both the input + outcome.
    const stored = store.getQualityVote(out.vote_id)!;
    expect(stored.routing).toBe('recompute');
    expect(stored.vote).toBe('wrong');
    expect(stored.voted_by_client_id).toBe('inst-laptop');
  });

  it('vote=stale on a non-pinned row enqueues recompute (same path as wrong)', () => {
    const row = writePurposeRow();
    const out = store.writeQualityVote({
      topic: 'purpose',
      scope: 'mail',
      target_id: 'mail_1',
      enrichment_row_id: row._id,
      vote: 'stale',
      source: 'user_dismissal',
      voted_by_client_id: 'inst-laptop',
    });
    expect(out.routing).toBe('recompute');
  });

  it('vote=wrong on a pinned target collapses to noop (pin protection)', () => {
    // Manually write a pinned row via the upsert path (mimics what a
    // prior vote=corrected would have created).
    const pinned = store.upsert({
      topic: 'purpose',
      scope: 'mail',
      target_id: 'mail_2',
      authored_by: 'system.user_correction.vote_first',
      value: PURPOSE({ purpose: 'follow-up', confidence: 1 }),
      event_at: NOW - 30_000,
      mode: 'pinned',
    });
    expect(pinned.is_pinned).toBe(true);

    const out = store.writeQualityVote({
      topic: 'purpose',
      scope: 'mail',
      target_id: 'mail_2',
      enrichment_row_id: pinned._id,
      vote: 'wrong',
      source: 'user_action',
      voted_by_client_id: 'inst-laptop',
    });
    expect(out.routing).toBe('noop');

    const refreshed = store.getById(pinned._id)!;
    expect(refreshed.lifecycle_action_pending).toBeNull();
    expect(refreshed.staleness_class).toBe('fresh');
  });

  it('vote=correct resets failure_attempt_count + last_failure_reason', () => {
    const row = writePurposeRow();
    // Simulate an earlier failure path (P6 substrate).
    store.recordProducerFailure({
      topic: 'purpose',
      scope: 'mail',
      target_id: 'mail_1',
      authored_by: 'system.housekeeping.purpose',
      reason: 'transient_provider_error',
    });
    const failed = store.getById(row._id)!;
    expect(failed.failure_attempt_count).toBe(1);
    expect(failed.last_failure_reason).toBe('transient_provider_error');

    const out = store.writeQualityVote({
      topic: 'purpose',
      scope: 'mail',
      target_id: 'mail_1',
      enrichment_row_id: row._id,
      vote: 'correct',
      source: 'user_action',
      voted_by_client_id: 'inst-laptop',
    });
    expect(out.routing).toBe('failure_count_reset');

    const refreshed = store.getById(row._id)!;
    expect(refreshed.failure_attempt_count).toBe(0);
    expect(refreshed.last_failure_reason).toBeNull();
  });

  it('vote=irrelevant persists the vote without touching the target row', () => {
    const row = writePurposeRow();
    const before = store.getById(row._id)!;
    const out = store.writeQualityVote({
      topic: 'purpose',
      scope: 'mail',
      target_id: 'mail_1',
      enrichment_row_id: row._id,
      vote: 'irrelevant',
      source: 'user_dismissal',
      voted_by_client_id: 'inst-laptop',
    });
    expect(out.routing).toBe('noop');
    const after = store.getById(row._id)!;
    expect(after.staleness_class).toBe(before.staleness_class);
    expect(after.lifecycle_action_pending).toBe(before.lifecycle_action_pending);
    expect(store.getQualityVote(out.vote_id)).toBeTruthy();
  });

  it('vote=corrected writes a user-pinned row via mode:pinned', () => {
    const row = writePurposeRow();
    const out = store.writeQualityVote({
      topic: 'purpose',
      scope: 'mail',
      target_id: 'mail_1',
      enrichment_row_id: row._id,
      vote: 'corrected',
      source: 'explicit_correction',
      corrected_value: PURPOSE({ purpose: 'demo_request', confidence: 1 }),
      voted_by_client_id: 'inst-laptop',
    });
    expect(out.routing).toBe('pin_written');
    expect(out.pinned_row_id).toBeTruthy();
    expect(out.pinned_row_id).not.toBe(row._id);

    const pinned = store.getById(out.pinned_row_id!)!;
    expect(pinned.is_pinned).toBe(true);
    expect(pinned.authored_by).toBe(`system.user_correction.${out.vote_id}`);
    expect((pinned.value as { purpose: string }).purpose).toBe('demo_request');

    // Original row is untouched (NOT enqueued for recompute — pin
    // protection means subsequent housekeeping cycles see the pinned
    // chain head and skip).
    const original = store.getById(row._id)!;
    expect(original.lifecycle_action_pending).toBeNull();
  });

  it('vote=corrected without corrected_value rejects', () => {
    const row = writePurposeRow();
    expect(() =>
      store.writeQualityVote({
        topic: 'purpose',
        scope: 'mail',
        target_id: 'mail_1',
        enrichment_row_id: row._id,
        vote: 'corrected',
        source: 'explicit_correction',
        voted_by_client_id: 'inst-laptop',
      }),
    ).toThrow(/corrected_value/);
  });

  it('vote on unknown enrichment_row_id rejects', () => {
    expect(() =>
      store.writeQualityVote({
        topic: 'purpose',
        scope: 'mail',
        target_id: 'mail_1',
        enrichment_row_id: 'enr_does_not_exist',
        vote: 'wrong',
        source: 'user_action',
        voted_by_client_id: 'inst-laptop',
      }),
    ).toThrow(/enrichment_vote_row_unknown/);
  });

  it('vote topic mismatch (vote.topic != row.topic) rejects', () => {
    const row = writePurposeRow();
    expect(() =>
      store.writeQualityVote({
        topic: 'summary',
        scope: 'mail',
        target_id: 'mail_1',
        enrichment_row_id: row._id,
        vote: 'wrong',
        source: 'user_action',
        voted_by_client_id: 'inst-laptop',
      }),
    ).toThrow(/enrichment_vote_topic_mismatch/);
  });

  it('agent_session_id + agent_sub_path round-trip on the vote row', () => {
    const row = writePurposeRow();
    const out = store.writeQualityVote({
      topic: 'purpose',
      scope: 'mail',
      target_id: 'mail_1',
      enrichment_row_id: row._id,
      vote: 'wrong',
      source: 'agent_action',
      voted_by_client_id: 'mcp-agent',
      agent_session_id: 'sess_123',
      agent_sub_path: 'planner -> retriever -> ranker',
    });
    const stored = store.getQualityVote(out.vote_id)!;
    expect(stored.agent_session_id).toBe('sess_123');
    expect(stored.agent_sub_path).toBe('planner -> retriever -> ranker');
    expect(stored.source).toBe('agent_action');
  });
});

// ────────────────────────────────────────────────────────────────
// 3. deleteQualityVote — vote unwind + pinned-row tombstone
// ────────────────────────────────────────────────────────────────

describe('deleteQualityVote — vote unwind', () => {
  it('non-corrected vote: removes the vote row, no pin unwound', () => {
    const row = writePurposeRow();
    const out = store.writeQualityVote({
      topic: 'purpose',
      scope: 'mail',
      target_id: 'mail_1',
      enrichment_row_id: row._id,
      vote: 'wrong',
      source: 'user_action',
      voted_by_client_id: 'inst-laptop',
    });
    expect(store.getQualityVote(out.vote_id)).toBeTruthy();

    const del = store.deleteQualityVote(out.vote_id);
    expect(del.ok).toBe(true);
    expect(del.pin_unwound).toBe(false);
    expect(store.getQualityVote(out.vote_id)).toBeNull();
  });

  it('corrected vote: tombstones the pinned row + reports pin_unwound=true', () => {
    const row = writePurposeRow();
    const out = store.writeQualityVote({
      topic: 'purpose',
      scope: 'mail',
      target_id: 'mail_1',
      enrichment_row_id: row._id,
      vote: 'corrected',
      source: 'explicit_correction',
      corrected_value: PURPOSE({ purpose: 'demo_request', confidence: 1 }),
      voted_by_client_id: 'inst-laptop',
    });
    const pinnedId = out.pinned_row_id!;
    const beforeTombstone = store.getById(pinnedId)!;
    expect(beforeTombstone.tombstoned_at).toBeNull();

    const del = store.deleteQualityVote(out.vote_id);
    expect(del.pin_unwound).toBe(true);

    const afterTombstone = store.getById(pinnedId)!;
    expect(afterTombstone.tombstoned_at).toBe(NOW);
    expect(afterTombstone.tombstone_reason).toBe('user_discarded');
    expect(afterTombstone.staleness_class).toBe('expired');
    expect(afterTombstone.value).toBeNull();
    expect(afterTombstone.meta).toBeNull();
  });

  it('unknown vote_id is idempotent — returns ok with pin_unwound=false', () => {
    const del = store.deleteQualityVote('vote_does_not_exist');
    expect(del.ok).toBe(true);
    expect(del.pin_unwound).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────
// 4. listQualityVotes — Settings UI surface
// ────────────────────────────────────────────────────────────────

describe('listQualityVotes — filter shapes', () => {
  it('lists newest-first by default; filters by topic + vote kind', () => {
    const rowA = writePurposeRow('mail_a');
    const rowB = writePurposeRow('mail_b');

    store.writeQualityVote({
      topic: 'purpose',
      scope: 'mail',
      target_id: 'mail_a',
      enrichment_row_id: rowA._id,
      vote: 'wrong',
      source: 'user_action',
      voted_by_client_id: 'inst-laptop',
      voted_at: NOW - 1000,
    });
    store.writeQualityVote({
      topic: 'purpose',
      scope: 'mail',
      target_id: 'mail_b',
      enrichment_row_id: rowB._id,
      vote: 'correct',
      source: 'user_action',
      voted_by_client_id: 'inst-laptop',
      voted_at: NOW,
    });

    const all = store.listQualityVotes({ topic: 'purpose' });
    expect(all.length).toBe(2);
    expect(all[0]!.vote).toBe('correct');
    expect(all[1]!.vote).toBe('wrong');

    const wrongOnly = store.listQualityVotes({ topic: 'purpose', vote: 'wrong' });
    expect(wrongOnly.length).toBe(1);
    expect(wrongOnly[0]!.vote).toBe('wrong');
  });
});

// ────────────────────────────────────────────────────────────────
// 5. Handler — source-vs-client validation matrix
// ────────────────────────────────────────────────────────────────

describe('handleEnrichmentVoteWrite — source-vs-client validation', () => {
  it('vote=corrected with source=user_action rejects (write-tier required)', async () => {
    const row = writePurposeRow();
    await expect(
      handleEnrichmentVoteWrite(
        { store },
        {
          topic: 'purpose',
          scope: 'mail',
          target_id: 'mail_1',
          enrichment_row_id: row._id,
          vote: 'corrected',
          source: 'user_action',
          corrected_value: PURPOSE(),
        },
        'inst-laptop',
      ),
    ).rejects.toThrow(/explicit_correction.*agent_action/);
  });

  it('vote=corrected with source=explicit_correction succeeds', async () => {
    const row = writePurposeRow();
    const out = await handleEnrichmentVoteWrite(
      { store },
      {
        topic: 'purpose',
        scope: 'mail',
        target_id: 'mail_1',
        enrichment_row_id: row._id,
        vote: 'corrected',
        source: 'explicit_correction',
        corrected_value: PURPOSE({ purpose: 'demo_request', confidence: 1 }),
      },
      'inst-laptop',
    );
    expect(out.routing).toBe('pin_written');
    expect(out.pinned_row_id).toBeTruthy();
  });

  it('vote=corrected with source=agent_action requires transport=mcp (Codex review #3)', async () => {
    const row = writePurposeRow();
    // WS-rpc transport rejects agent_action — that's reserved for the
    // MCP channel where sub-agent identity is enforced at the dispatch
    // envelope. Without the gate, any paired client could fabricate
    // sub-agent identity and bypass the source-vs-client matrix.
    await expect(
      handleEnrichmentVoteWrite(
        { store },
        {
          topic: 'purpose',
          scope: 'mail',
          target_id: 'mail_1',
          enrichment_row_id: row._id,
          vote: 'corrected',
          source: 'agent_action',
          corrected_value: PURPOSE({ purpose: 'demo_request', confidence: 1 }),
          agent_session_id: 'sess_42',
          agent_sub_path: 'corrector',
        },
        'inst-laptop',
        'ws-rpc',
      ),
    ).rejects.toThrow(/agent_action.*MCP-channel/);

    // Same call via the mcp transport succeeds.
    const out = await handleEnrichmentVoteWrite(
      { store },
      {
        topic: 'purpose',
        scope: 'mail',
        target_id: 'mail_1',
        enrichment_row_id: row._id,
        vote: 'corrected',
        source: 'agent_action',
        corrected_value: PURPOSE({ purpose: 'demo_request', confidence: 1 }),
        agent_session_id: 'sess_42',
        agent_sub_path: 'corrector',
      },
      'mcp-agent',
      'mcp',
    );
    expect(out.routing).toBe('pin_written');
  });

  it('mcp transport requires source=agent_action (paired-client sources rejected)', async () => {
    const row = writePurposeRow();
    await expect(
      handleEnrichmentVoteWrite(
        { store },
        {
          topic: 'purpose',
          scope: 'mail',
          target_id: 'mail_1',
          enrichment_row_id: row._id,
          vote: 'wrong',
          source: 'user_action',
        },
        'mcp-agent',
        'mcp',
      ),
    ).rejects.toThrow(/MCP transport requires source='agent_action'/);
  });

  it('handler maps store row-unknown error to bad_request', async () => {
    await expect(
      handleEnrichmentVoteWrite(
        { store },
        {
          topic: 'purpose',
          scope: 'mail',
          target_id: 'mail_1',
          enrichment_row_id: 'enr_does_not_exist',
          vote: 'wrong',
          source: 'user_action',
        },
        'inst-laptop',
      ),
    ).rejects.toBeInstanceOf(RpcError);
  });

  it('handler rejects missing topic / row id with bad_request', async () => {
    await expect(
      handleEnrichmentVoteWrite(
        { store },
        {
          topic: '',
          enrichment_row_id: 'x',
          vote: 'wrong',
          source: 'user_action',
        },
        'inst-laptop',
      ),
    ).rejects.toThrow(/topic is required/);
  });

  it('vote.delete handler routes through to store', async () => {
    const row = writePurposeRow();
    const written = await handleEnrichmentVoteWrite(
      { store },
      {
        topic: 'purpose',
        scope: 'mail',
        target_id: 'mail_1',
        enrichment_row_id: row._id,
        vote: 'corrected',
        source: 'explicit_correction',
        corrected_value: PURPOSE({ purpose: 'demo_request', confidence: 1 }),
      },
      'inst-laptop',
    );
    const deleted = await handleEnrichmentVoteDelete(
      { store },
      { vote_id: written.vote_id },
    );
    expect(deleted.pin_unwound).toBe(true);
  });
});
