/** D-149 P12 § A.20.5 + § A.20.2 — Abuse Inbox rpc trio + the
 *  View-As-Visitor panel on `reception.endpoint.preview_draft`.
 *
 *  Covers:
 *    - `reception.abuse_inbox.list` aggregates server-wide access-log
 *      rows into clusters + returns the IP block list.
 *    - `list` still works when the IP block store is not wired (empty
 *      block list; clusters un-annotated).
 *    - `list` rejects bad args + requires a paired caller.
 *    - `ban_ip` blocks + emits a signed `reception.ip_blocked` audit
 *      row; idempotent re-ban emits no second row.
 *    - `unban_ip` removes + emits `reception.ip_unblocked`; idempotent.
 *    - `ban_ip` / `unban_ip` raise `not_configured` when the store is
 *      absent + require a paired caller + non-empty args.
 *    - `preview_draft` carries the `view_as_visitor` panel (synthetic:
 *      true). */

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import type { ActivityEntry, AuditLogStore } from '@recued/storage';
import { RpcError, abuseInboxBlockKey } from '@recued/contracts';
import { ensureReceptionSchema } from '../storage/reception-store.js';
import {
  createPublicEndpointRegistryStore,
  type PublicEndpointRegistryStore,
} from '../storage/public-endpoint-registry-store.js';
import {
  createReceptionIpBlockStore,
  type ReceptionIpBlockStore,
} from '../storage/reception-ip-block-store.js';
import {
  createPreviewHashStore,
  type PreviewHashStore,
} from '../ports/reception/preview-hash.js';
import { deriveReceptionPepper } from '../ports/reception/server-secret-pepper.js';
import {
  handleReceptionAbuseInboxBanIp,
  handleReceptionAbuseInboxList,
  handleReceptionAbuseInboxUnbanIp,
  handleReceptionEndpointPreviewDraft,
  type ReceptionBroadcastEvent,
  type ReceptionRpcDeps,
} from '../reception-rpc-handler.js';

const NOW = 1_700_000_000_000;
const CALLER = { instance_id: 'client_1' };

const buildAuditLog = (): { auditLog: AuditLogStore; rows: ActivityEntry[] } => {
  const rows: ActivityEntry[] = [];
  const auditLog = {
    append: async () => {},
    listRecent: async () => [],
    listByRecipe: async () => [],
    get: async () => null,
    clearOlderThan: async () => 0,
    clearByRecipe: async () => 0,
    exportAll: async () => ({ entries: [], activities: [] }),
    size: async () => 0,
    clearAll: async () => {},
    listActivities: async () => rows.slice(),
    exportActivities: async () => rows.slice(),
    clearOldestActivities: async () => 0,
    clearOldestEntries: async () => 0,
    countReserveEntries: async () => 0,
    countReserveActivities: async () => 0,
    logActivity: async (entry: ActivityEntry) => {
      rows.push(entry);
    },
  } as unknown as AuditLogStore;
  return { auditLog, rows };
};

const buildDeps = (
  opts: { withIpBlockStore?: boolean } = {},
): {
  deps: ReceptionRpcDeps;
  store: PublicEndpointRegistryStore;
  ipBlockStore: ReceptionIpBlockStore;
  rows: ActivityEntry[];
} => {
  const db = new Database(':memory:');
  ensureReceptionSchema(db);
  const store = createPublicEndpointRegistryStore(db);
  const ipBlockStore = createReceptionIpBlockStore(db);
  const previewStore: PreviewHashStore = createPreviewHashStore();
  const { auditLog, rows } = buildAuditLog();
  const deps: ReceptionRpcDeps = {
    getStore: () => store,
    getPreviewStore: () => previewStore,
    getPepper: () => deriveReceptionPepper(Buffer.alloc(32, 0xbd)),
    getShareBaseUrl: () => 'https://alice.recued.cloud',
    auditLog,
    broadcast: (_event: ReceptionBroadcastEvent) => {},
    now: () => NOW,
    ...(opts.withIpBlockStore === false ? {} : { getIpBlockStore: () => ipBlockStore }),
  };
  return { deps, store, ipBlockStore, rows };
};

const seedAccessLog = (
  store: PublicEndpointRegistryStore,
  rows: Array<{
    endpoint_id: string;
    source_ip_hash: string | null;
    outcome:
      | 'ok'
      | 'rejected'
      | 'rate_limited'
      | 'invalid_token'
      | 'capacity_full';
    accessed_at?: number;
    rejection_reason?: string;
  }>,
): void => {
  let i = 0;
  for (const r of rows) {
    store.appendAccessLog({
      id: `log_${i++}_${Math.random()}`,
      endpoint_id: r.endpoint_id,
      accessed_at: r.accessed_at ?? NOW - 1000,
      source_ip_hash: r.source_ip_hash,
      user_agent_hash: null,
      action_taken: 'view',
      outcome: r.outcome,
      url_path_redacted: `/reception/scheduling/${r.endpoint_id}`,
      metadata: r.rejection_reason ? { rejection_reason: r.rejection_reason } : {},
    });
  }
};

// ────────────────────────────────────────────────────────────────
// reception.abuse_inbox.list
// ────────────────────────────────────────────────────────────────

describe('D-149 P12 § A.20.5 — reception.abuse_inbox.list', () => {
  it('aggregates server-wide access-log rows into clusters', async () => {
    const { deps, store } = buildDeps();
    seedAccessLog(store, [
      ...Array.from({ length: 4 }, () => ({
        endpoint_id: 'ep_1' as const,
        source_ip_hash: 'ip_x',
        outcome: 'invalid_token' as const,
      })),
      { endpoint_id: 'ep_2', source_ip_hash: 'ip_y', outcome: 'ok' as const },
    ]);
    const result = await handleReceptionAbuseInboxList(deps, undefined, CALLER);
    expect(result.summary.rows).toHaveLength(1);
    expect(result.summary.rows[0]!.signal_kind).toBe('invalid_token_burst');
    expect(result.summary.rows[0]!.event_count).toBe(4);
  });

  it('returns + annotates the IP block list', async () => {
    const { deps, store, ipBlockStore } = buildDeps();
    seedAccessLog(
      store,
      Array.from({ length: 3 }, () => ({
        endpoint_id: 'ep_1' as const,
        source_ip_hash: 'ip_b',
        outcome: 'rate_limited' as const,
      })),
    );
    ipBlockStore.block({
      endpoint_id: 'ep_1',
      source_ip_hash: 'ip_b',
      blocked_at: NOW,
      blocked_by_client_id: 'client_1',
      reason: 'spam',
    });
    const result = await handleReceptionAbuseInboxList(deps, undefined, CALLER);
    expect(result.summary.rows[0]!.ip_blocked).toBe(true);
    expect(result.blocked).toHaveLength(1);
    expect(result.blocked[0]!.source_ip_hash).toBe('ip_b');
  });

  it('still aggregates with an empty block list when the IP block store is not wired', async () => {
    const { deps, store } = buildDeps({ withIpBlockStore: false });
    seedAccessLog(
      store,
      Array.from({ length: 3 }, () => ({
        endpoint_id: 'ep_1' as const,
        source_ip_hash: 'ip_c',
        outcome: 'rate_limited' as const,
      })),
    );
    const result = await handleReceptionAbuseInboxList(deps, undefined, CALLER);
    expect(result.summary.rows).toHaveLength(1);
    expect(result.summary.rows[0]!.ip_blocked).toBe(false);
    expect(result.blocked).toEqual([]);
  });

  it('rejects a non-finite since / non-positive limit / sub-1 cluster_threshold', async () => {
    const { deps } = buildDeps();
    await expect(
      handleReceptionAbuseInboxList(deps, { since: Number.NaN }, CALLER),
    ).rejects.toBeInstanceOf(RpcError);
    await expect(
      handleReceptionAbuseInboxList(deps, { limit: 0 }, CALLER),
    ).rejects.toBeInstanceOf(RpcError);
    await expect(
      handleReceptionAbuseInboxList(deps, { cluster_threshold: 0 }, CALLER),
    ).rejects.toBeInstanceOf(RpcError);
  });

  it('rejects a fractional limit (Codex P2 fold — a REAL bind would 500 in SQLite)', async () => {
    const { deps } = buildDeps();
    await expect(
      handleReceptionAbuseInboxList(deps, { limit: 1.5 }, CALLER),
    ).rejects.toBeInstanceOf(RpcError);
    // an integer limit is still accepted.
    await expect(
      handleReceptionAbuseInboxList(deps, { limit: 100 }, CALLER),
    ).resolves.toBeDefined();
  });

  it('requires a paired caller', async () => {
    const { deps } = buildDeps();
    await expect(
      handleReceptionAbuseInboxList(deps, undefined, { instance_id: null }),
    ).rejects.toThrow(/paired client/);
  });
});

// ────────────────────────────────────────────────────────────────
// reception.abuse_inbox.ban_ip / unban_ip
// ────────────────────────────────────────────────────────────────

describe('D-149 P12 § A.20.5 — reception.abuse_inbox.ban_ip', () => {
  it('blocks the pair + emits a signed reception.ip_blocked audit row', async () => {
    const { deps, ipBlockStore, rows } = buildDeps();
    const result = await handleReceptionAbuseInboxBanIp(
      deps,
      { endpoint_id: 'ep_1', source_ip_hash: 'ip_x', reason: 'brute-force' },
      CALLER,
    );
    expect(result).toEqual({ ok: true, created: true });
    expect(ipBlockStore.isBlocked('ep_1', 'ip_x')).toBe(true);
    expect(rows.some((r) => r.action === 'reception.ip_blocked')).toBe(true);
  });

  it('an idempotent re-ban emits no second audit row', async () => {
    const { deps, rows } = buildDeps();
    const args = { endpoint_id: 'ep_1', source_ip_hash: 'ip_x' };
    await handleReceptionAbuseInboxBanIp(deps, args, CALLER);
    const second = await handleReceptionAbuseInboxBanIp(deps, args, CALLER);
    expect(second).toEqual({ ok: true, created: false });
    expect(rows.filter((r) => r.action === 'reception.ip_blocked')).toHaveLength(1);
  });

  it('banning two IPs on one endpoint in the same ms lands two distinct audit rows (Codex P2 fold)', async () => {
    // `now` is a fixed clock in buildDeps — both bans share the same
    // millisecond. Pre-fold the activity_id was `action-now-target` with
    // no source-ip discriminator, so the second row overwrote the first
    // in a store that preserves supplied ids. The id_suffix fold makes
    // each mutation's activity_id unique.
    const { deps, rows } = buildDeps();
    await handleReceptionAbuseInboxBanIp(
      deps,
      { endpoint_id: 'ep_1', source_ip_hash: 'ip_x' },
      CALLER,
    );
    await handleReceptionAbuseInboxBanIp(
      deps,
      { endpoint_id: 'ep_1', source_ip_hash: 'ip_y' },
      CALLER,
    );
    const blockedRows = rows.filter((r) => r.action === 'reception.ip_blocked');
    expect(blockedRows).toHaveLength(2);
    expect(blockedRows[0]!.activity_id).not.toBe(blockedRows[1]!.activity_id);
  });

  it('raises not_configured when the IP block store is not wired', async () => {
    const { deps } = buildDeps({ withIpBlockStore: false });
    await expect(
      handleReceptionAbuseInboxBanIp(
        deps,
        { endpoint_id: 'ep_1', source_ip_hash: 'ip_x' },
        CALLER,
      ),
    ).rejects.toMatchObject({ code: 'not_configured' });
  });

  it('requires a paired caller + non-empty endpoint_id / source_ip_hash', async () => {
    const { deps } = buildDeps();
    await expect(
      handleReceptionAbuseInboxBanIp(
        deps,
        { endpoint_id: 'ep_1', source_ip_hash: 'ip_x' },
        { instance_id: null },
      ),
    ).rejects.toThrow(/paired client/);
    await expect(
      handleReceptionAbuseInboxBanIp(
        deps,
        { endpoint_id: '', source_ip_hash: 'ip_x' },
        CALLER,
      ),
    ).rejects.toBeInstanceOf(RpcError);
    await expect(
      handleReceptionAbuseInboxBanIp(
        deps,
        { endpoint_id: 'ep_1', source_ip_hash: '' },
        CALLER,
      ),
    ).rejects.toBeInstanceOf(RpcError);
  });
});

describe('D-149 P12 § A.20.5 — reception.abuse_inbox.unban_ip', () => {
  it('removes the ban + emits a signed reception.ip_unblocked audit row', async () => {
    const { deps, ipBlockStore, rows } = buildDeps();
    ipBlockStore.block({
      endpoint_id: 'ep_1',
      source_ip_hash: 'ip_x',
      blocked_at: NOW,
      blocked_by_client_id: 'client_1',
      reason: null,
    });
    const result = await handleReceptionAbuseInboxUnbanIp(
      deps,
      { endpoint_id: 'ep_1', source_ip_hash: 'ip_x' },
      CALLER,
    );
    expect(result).toEqual({ ok: true, removed: true });
    expect(ipBlockStore.isBlocked('ep_1', 'ip_x')).toBe(false);
    expect(rows.some((r) => r.action === 'reception.ip_unblocked')).toBe(true);
  });

  it('an idempotent unban (pair not on the list) emits no audit row', async () => {
    const { deps, rows } = buildDeps();
    const result = await handleReceptionAbuseInboxUnbanIp(
      deps,
      { endpoint_id: 'ep_1', source_ip_hash: 'ip_never' },
      CALLER,
    );
    expect(result).toEqual({ ok: true, removed: false });
    expect(rows.some((r) => r.action === 'reception.ip_unblocked')).toBe(false);
  });

  it('raises not_configured when the IP block store is not wired', async () => {
    const { deps } = buildDeps({ withIpBlockStore: false });
    await expect(
      handleReceptionAbuseInboxUnbanIp(
        deps,
        { endpoint_id: 'ep_1', source_ip_hash: 'ip_x' },
        CALLER,
      ),
    ).rejects.toMatchObject({ code: 'not_configured' });
  });
});

// ────────────────────────────────────────────────────────────────
// reception.endpoint.preview_draft — View-As-Visitor panel
// ────────────────────────────────────────────────────────────────

describe('D-149 P12 § A.20.2 — preview_draft carries the View-As-Visitor panel', () => {
  it('attaches a synthetic: true panel to the preview result', async () => {
    const { deps } = buildDeps();
    const result = await handleReceptionEndpointPreviewDraft(
      deps,
      {
        kind: 'reception_page',
        packet_declaration: {
          packet_kind: 'reception_page_packet',
          source_query_ref: { kind: 'reception_page_config' },
        },
      },
      CALLER,
    );
    expect(result.view_as_visitor).toBeDefined();
    expect(result.view_as_visitor!.synthetic).toBe(true);
    expect(result.view_as_visitor!.endpoint_kind).toBe('reception_page');
    expect(result.view_as_visitor!.token_mode).toBe('tokenless_singleton');
    // visible fields on the panel match the preview's visible_fields list.
    expect(result.view_as_visitor!.visible_fields).toEqual(result.visible_fields);
    // the panel carries a privacy-invariant compliance summary.
    expect(result.view_as_visitor!.privacy_invariant_summary.length).toBeGreaterThan(0);
  });

  // The block-key encoding is exercised by the store + listener suites;
  // this is a guard so a future refactor of the rpc-side import keeps
  // the helper reachable from this surface.
  it('abuseInboxBlockKey is importable + collision-safe at the rpc surface', () => {
    expect(abuseInboxBlockKey('ep_1', 'h')).not.toBe(abuseInboxBlockKey('ep_1 h', ''));
  });
});
