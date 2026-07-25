/** D-136 P7 Codex review fixes — regression tests.
 *
 *  Six findings folded back into P7.A + P7.B:
 *    [P1 #1] Topic-reset paired-client + write-tier gate.
 *    [P1 #2] Reset rows eligible for re-derive (listStaleRowsForReDerive
 *            widens to include tombstoned-with-LAP=recompute; updates
 *            clear tombstoned_at on successful re-derive).
 *    [P2 #3] Vote agent_action source requires MCP transport (WS-rpc
 *            rejects).
 *    [P2 #4] Corrected vote scope / target_id must match the fetched
 *            row.
 *    [P2 #5] Corrected votes rejected on derived-entity topics.
 *    [P2 #6] Vote table FK ON DELETE CASCADE so existing hard-delete
 *            paths don't fail with FOREIGN KEY constraint violations.
 *
 *  P1 gate tests (#1) live in `d-136-phase-7-topic-reset.test.ts`'s
 *  caller-permission describe block; the rest concentrate here. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createEnrichmentStore,
  type EnrichmentStore,
} from '../storage/enrichment-store.js';
import { handleEnrichmentVoteWrite } from '../enrichment-handler.js';

const NOW = 1_750_000_000_000;

let dir: string;
let db: Database.Database;
let store: EnrichmentStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd-136-p7-codex-'));
  db = new Database(join(dir, 'test.db'));
  store = createEnrichmentStore(db, { now: () => NOW });
});

afterEach(() => {
  store.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const PURPOSE = (override: Record<string, unknown> = {}) => ({
  purpose: 'inquiry' as const,
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
// [P1 #2] Reset rows eligible for re-derive
// ────────────────────────────────────────────────────────────────

describe('[P1 #2] reset rows eligible for re-derive', () => {
  it('listStaleRowsForReDerive returns tombstoned rows when LAP=recompute', () => {
    const r = writePurposeRow();
    // Reset path: tombstone + LAP=recompute (mimics
    // tombstoneAndEnqueueRecomputeByTopic).
    store.tombstoneRowIds([r._id], 'user_discarded');
    db.prepare(
      `UPDATE data_enrichment SET lifecycle_action_pending='recompute',
                                    staleness_class='expired'
        WHERE _id = ?`,
    ).run(r._id);

    const eligible = store.listStaleRowsForReDerive({
      topic: 'purpose',
      scope: 'mail',
      authored_by: 'system.housekeeping.purpose',
      now: NOW,
      limit: 50,
    });
    expect(eligible.length).toBe(1);
    expect(eligible[0]!._id).toBe(r._id);
    expect(eligible[0]!.tombstoned_at).toBe(NOW);
    expect(eligible[0]!.lifecycle_action_pending).toBe('recompute');
  });

  it('listStaleRowsForReDerive still skips tombstoned rows when LAP != recompute (cascade-driven)', () => {
    const r = writePurposeRow();
    // Cascade-driven tombstone: LAP cleared (the P5b tombstone path
    // does this), staleness=expired. The drain doesn't re-derive
    // these — they're terminally gone.
    store.tombstoneRowIds([r._id], 'cascade_delete');
    expect(store.getById(r._id)!.lifecycle_action_pending).toBeNull();

    const eligible = store.listStaleRowsForReDerive({
      topic: 'purpose',
      scope: 'mail',
      authored_by: 'system.housekeeping.purpose',
      now: NOW,
      limit: 50,
    });
    expect(eligible.length).toBe(0);
  });

  it('successful re-derive (upsert) clears tombstoned_at + tombstone_reason on the row', () => {
    const r = writePurposeRow();
    store.tombstoneRowIds([r._id], 'user_discarded');
    db.prepare(
      `UPDATE data_enrichment SET lifecycle_action_pending='recompute',
                                    staleness_class='expired'
        WHERE _id = ?`,
    ).run(r._id);
    expect(store.getById(r._id)!.tombstoned_at).toBe(NOW);

    // Re-derive simulates the producer harness picking up the row
    // and writing a fresh value — the upsert path must clear the
    // tombstone metadata.
    store.upsert({
      topic: 'purpose',
      scope: 'mail',
      target_id: 'mail_1',
      authored_by: 'system.housekeeping.purpose',
      value: PURPOSE({ purpose: 'demo_request', confidence: 0.9 }),
      event_at: NOW - 1_000,
    });

    const refreshed = store.getById(r._id)!;
    expect(refreshed.tombstoned_at).toBeNull();
    expect(refreshed.tombstone_reason).toBeNull();
    expect(refreshed.staleness_class).toBe('fresh');
    expect(refreshed.lifecycle_action_pending).toBeNull();
    expect(refreshed.failure_attempt_count).toBe(0);
    expect((refreshed.value as { purpose: string }).purpose).toBe('demo_request');
  });
});

// ────────────────────────────────────────────────────────────────
// [P2 #3] WS-rpc transport rejects agent_action
// ────────────────────────────────────────────────────────────────

describe('[P2 #3] vote transport gate', () => {
  it('WS-rpc rejects source=agent_action with permission_denied', async () => {
    const r = writePurposeRow();
    await expect(
      handleEnrichmentVoteWrite(
        { store },
        {
          topic: 'purpose',
          enrichment_row_id: r._id,
          vote: 'wrong',
          source: 'agent_action',
        },
        'inst-laptop',
        'ws-rpc',
      ),
    ).rejects.toThrow(/agent_action.*MCP-channel/);
  });

  it('mcp transport rejects paired-client sources with permission_denied', async () => {
    const r = writePurposeRow();
    for (const source of [
      'user_dismissal',
      'user_action',
      'explicit_correction',
    ] as const) {
      await expect(
        handleEnrichmentVoteWrite(
          { store },
          {
            topic: 'purpose',
            enrichment_row_id: r._id,
            vote: source === 'explicit_correction' ? 'corrected' : 'wrong',
            source,
            ...(source === 'explicit_correction'
              ? { corrected_value: PURPOSE({ purpose: 'demo_request' }) }
              : {}),
          },
          'mcp-agent',
          'mcp',
        ),
      ).rejects.toThrow(/MCP transport requires source='agent_action'/);
    }
  });

  it('default transport is ws-rpc when not explicitly passed', async () => {
    const r = writePurposeRow();
    await expect(
      handleEnrichmentVoteWrite(
        { store },
        {
          topic: 'purpose',
          enrichment_row_id: r._id,
          vote: 'wrong',
          source: 'agent_action',
        },
        'inst-laptop',
        // transport omitted — default 'ws-rpc' triggers the gate.
      ),
    ).rejects.toThrow(/agent_action.*MCP-channel/);
  });
});

// ────────────────────────────────────────────────────────────────
// [P2 #4] Corrected-vote scope/target_id mismatch
// ────────────────────────────────────────────────────────────────

describe('[P2 #4] corrected-vote identity gate', () => {
  it('rejects when caller scope mismatches the fetched row', () => {
    const r = writePurposeRow();
    expect(() =>
      store.writeQualityVote({
        topic: 'purpose',
        // Wrong scope vs the row's actual ('mail').
        scope: 'contact',
        target_id: 'mail_1',
        enrichment_row_id: r._id,
        vote: 'corrected',
        source: 'explicit_correction',
        corrected_value: PURPOSE({ purpose: 'demo_request' }),
        voted_by_client_id: 'inst-laptop',
      }),
    ).toThrow(/enrichment_vote_scope_mismatch/);
  });

  it('rejects when caller target_id mismatches the fetched row', () => {
    const r = writePurposeRow();
    expect(() =>
      store.writeQualityVote({
        topic: 'purpose',
        scope: 'mail',
        // Wrong target_id vs the row's actual ('mail_1').
        target_id: 'mail_999',
        enrichment_row_id: r._id,
        vote: 'corrected',
        source: 'explicit_correction',
        corrected_value: PURPOSE({ purpose: 'demo_request' }),
        voted_by_client_id: 'inst-laptop',
      }),
    ).toThrow(/enrichment_vote_target_id_mismatch/);
  });

  it('mismatch-rejection applies to non-corrected votes too (defense-in-depth)', () => {
    const r = writePurposeRow();
    expect(() =>
      store.writeQualityVote({
        topic: 'purpose',
        scope: 'contact',
        target_id: 'mail_1',
        enrichment_row_id: r._id,
        vote: 'wrong',
        source: 'user_action',
        voted_by_client_id: 'inst-laptop',
      }),
    ).toThrow(/enrichment_vote_scope_mismatch/);
  });

  it('omitting scope/target_id (rely on FK lookup) accepts the vote', () => {
    const r = writePurposeRow();
    const out = store.writeQualityVote({
      topic: 'purpose',
      // No scope / target_id — fetched row's identity is the source of truth.
      enrichment_row_id: r._id,
      vote: 'wrong',
      source: 'user_action',
      voted_by_client_id: 'inst-laptop',
    });
    expect(out.routing).toBe('recompute');
  });
});

// ────────────────────────────────────────────────────────────────
// [P2 #5] Corrected votes rejected on derived-entity topics
// ────────────────────────────────────────────────────────────────

describe('[P2 #5] corrected-vote derived-entity reject', () => {
  it('rejects corrected vote on a derived-entity topic (topic_cluster)', () => {
    // Write a topic_cluster derived-entity row so the FK reference
    // resolves cleanly.
    const r = store.upsert({
      topic: 'topic_cluster',
      derived_entity_id: 'cluster_123',
      authored_by: 'system.housekeeping.topic_cluster',
      value: {
        topic_name: 'pricing-discussions',
        summary: 'A few threads about pricing tiers.',
        members: ['mail_1', 'mail_2'],
        thread_ids: ['thread_1'],
        theme_tokens: ['pricing'],
        thread_count: 1,
        ai_invoked: false,
        computed_at: NOW,
        window_ms: 86_400_000,
      },
      event_at: NOW,
    });

    expect(() =>
      store.writeQualityVote({
        topic: 'topic_cluster',
        enrichment_row_id: r._id,
        vote: 'corrected',
        source: 'explicit_correction',
        corrected_value: {
          topic_name: 'sales',
          summary: 'corrected',
          members: ['mail_1'],
          thread_ids: ['thread_1'],
          theme_tokens: ['sales'],
          thread_count: 1,
          ai_invoked: false,
          computed_at: NOW,
          window_ms: 86_400_000,
        },
        voted_by_client_id: 'inst-laptop',
      }),
    ).toThrow(/enrichment_vote_corrected_unsupported_for_derived/);
  });

  it('non-corrected votes on derived-entity topics still work', () => {
    const r = store.upsert({
      topic: 'topic_cluster',
      derived_entity_id: 'cluster_456',
      authored_by: 'system.housekeeping.topic_cluster',
      value: {
        topic_name: 'support-questions',
        summary: 'Customers asking for support.',
        members: ['mail_3'],
        thread_ids: ['thread_2'],
        theme_tokens: ['support'],
        thread_count: 1,
        ai_invoked: false,
        computed_at: NOW,
        window_ms: 86_400_000,
      },
      event_at: NOW,
    });
    // 'wrong' on a derived-entity historical-policy topic routes to
    // 'discard' (recompute would corrupt the chain). Pinned-target
    // protection doesn't kick in (this row isn't pinned).
    const out = store.writeQualityVote({
      topic: 'topic_cluster',
      enrichment_row_id: r._id,
      vote: 'wrong',
      source: 'user_action',
      voted_by_client_id: 'inst-laptop',
    });
    expect(['recompute', 'discard']).toContain(out.routing);
  });
});

// ────────────────────────────────────────────────────────────────
// [P2 #6] Vote table FK ON DELETE CASCADE
// ────────────────────────────────────────────────────────────────

describe('[P2 #6] vote table FK on-delete cascade', () => {
  it('deleting an enrichment row cascades the votes that reference it', () => {
    const r = writePurposeRow();
    const out = store.writeQualityVote({
      topic: 'purpose',
      enrichment_row_id: r._id,
      vote: 'wrong',
      source: 'user_action',
      voted_by_client_id: 'inst-laptop',
    });
    expect(store.getQualityVote(out.vote_id)).toBeTruthy();

    store.deleteById(r._id);
    expect(store.getQualityVote(out.vote_id)).toBeNull();
  });

  it('reset(topic) hard-delete succeeds even with vote rows in flight', () => {
    const r = writePurposeRow();
    store.writeQualityVote({
      topic: 'purpose',
      enrichment_row_id: r._id,
      vote: 'wrong',
      source: 'user_action',
      voted_by_client_id: 'inst-laptop',
    });
    // Without ON DELETE CASCADE this would throw "FOREIGN KEY constraint
    // failed" because the vote table FK has no ON DELETE clause and
    // defaults to NO ACTION.
    const removed = store.reset('purpose');
    expect(removed).toBe(1);
  });

  it('deleteForSource cascade clears votes alongside enrichment rows', () => {
    const r = writePurposeRow('mail_for_source');
    store.writeQualityVote({
      topic: 'purpose',
      enrichment_row_id: r._id,
      vote: 'irrelevant',
      source: 'user_dismissal',
      voted_by_client_id: 'inst-laptop',
    });
    const removed = store.deleteForSource('mail', 'mail_for_source');
    expect(removed).toBeGreaterThan(0);
    // Vote table cascade — vote row is gone too.
    expect(store.listQualityVotes({ topic: 'purpose' })).toHaveLength(0);
  });
});

// ────────────────────────────────────────────────────────────────
// End-to-end: reset + re-derive cycle
// ────────────────────────────────────────────────────────────────

describe('end-to-end — reset confirms then producer re-derives clean state', () => {
  it('reset tombstones, listStaleRowsForReDerive picks up, upsert re-derives + clears tombstone', () => {
    const r = writePurposeRow();
    expect(store.getById(r._id)!.value).toEqual(PURPOSE());

    // Reset: tombstone + LAP=recompute (the public surface).
    const reset = store.tombstoneAndEnqueueRecomputeByTopic({
      topic: 'purpose',
      scope_filter: 'mail',
    });
    expect(reset.rows_tombstoned).toBe(1);
    expect(reset.rows_recompute_enqueued).toBe(1);

    // Stale-sweep eligibility: tombstoned + LAP=recompute now passes.
    const eligible = store.listStaleRowsForReDerive({
      topic: 'purpose',
      scope: 'mail',
      authored_by: 'system.housekeeping.purpose',
      now: NOW,
      limit: 50,
    });
    expect(eligible.length).toBe(1);

    // Producer re-derives — upsert clears the tombstone.
    store.upsert({
      topic: 'purpose',
      scope: 'mail',
      target_id: 'mail_1',
      authored_by: 'system.housekeeping.purpose',
      value: PURPOSE({ purpose: 'demo_request', confidence: 0.95 }),
      event_at: NOW - 1_000,
    });

    const final = store.getById(r._id)!;
    expect(final.tombstoned_at).toBeNull();
    expect(final.tombstone_reason).toBeNull();
    expect(final.staleness_class).toBe('fresh');
    expect(final.lifecycle_action_pending).toBeNull();
    expect((final.value as { purpose: string }).purpose).toBe('demo_request');
  });
});
