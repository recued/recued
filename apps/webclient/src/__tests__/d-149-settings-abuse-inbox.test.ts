/** D-149 § A.20.5 follow-on — Reception → Abuse
 *  Inbox subview renderer.
 *
 *  Covers the projection layer over `buildAbuseInbox` + the
 *  `reception.abuse_inbox.*` rpc trio: the signal-kind + rpc-error copy
 *  registries, the relative-time + window labels, the cluster-row +
 *  IP-block-entry projections, the full subview model, and the three
 *  dispatch builders. */

import { describe, expect, it } from 'vitest';
import {
  ABUSE_INBOX_SIGNAL_KINDS,
  abuseInboxBlockKey,
  type AbuseInboxRow,
  type AbuseInboxSummary,
  type ReceptionIpBlockEntry,
} from '@recued/contracts';
import {
  ABUSE_INBOX_ERROR_COPY,
  ABUSE_INBOX_RPC_ERROR_CODES,
  ABUSE_INBOX_SIGNAL_COPY,
  buildAbuseInboxBanIpDispatch,
  buildAbuseInboxBlockedEntryModel,
  buildAbuseInboxListDispatch,
  buildAbuseInboxRowModel,
  buildAbuseInboxSubviewModel,
  buildAbuseInboxUnbanIpDispatch,
  computeRelativeTimeLabel,
  computeWindowLabel,
} from '../reception/abuse-inbox.js';

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const NOW = 1_700_000_000_000;

// A 24-hex-char source-IP hash — long enough that the § A.16.7 8-char
// truncation is unambiguously a prefix, not the whole value.
const HASH = 'abcdef0123456789deadbeef';

const mkRow = (override: Partial<AbuseInboxRow> = {}): AbuseInboxRow => ({
  signal_kind: 'spam_burst',
  endpoint_id: 'ep-1',
  source_ip_hash: HASH,
  event_count: 5,
  first_seen_at: NOW - 3 * HOUR_MS,
  last_seen_at: NOW - 30 * MINUTE_MS,
  ip_blocked: false,
  ...override,
});

const mkSummary = (override: Partial<AbuseInboxSummary> = {}): AbuseInboxSummary => {
  const rows = override.rows ?? [];
  return {
    rows,
    total_signals: rows.length,
    window_start_at: NOW - 7 * DAY_MS,
    window_end_at: NOW,
    cluster_threshold: 3,
    ...override,
  };
};

const mkBlocked = (
  override: Partial<ReceptionIpBlockEntry> = {},
): ReceptionIpBlockEntry => ({
  endpoint_id: 'ep-1',
  source_ip_hash: HASH,
  blocked_at: NOW - 2 * DAY_MS,
  blocked_by_client_id: 'cli-admin',
  reason: 'sustained spam burst',
  ...override,
});

// ────────────────────────────────────────────────────────────────
// Copy registries
// ────────────────────────────────────────────────────────────────

describe('D-149 abuse-inbox — copy registries', () => {
  it('ABUSE_INBOX_SIGNAL_COPY covers every signal kind with non-empty copy', () => {
    for (const kind of ABUSE_INBOX_SIGNAL_KINDS) {
      const copy = ABUSE_INBOX_SIGNAL_COPY[kind];
      expect(copy.label).toBeTruthy();
      expect(copy.description).toBeTruthy();
      expect(copy.suggested_action).toBeTruthy();
    }
    expect(Object.keys(ABUSE_INBOX_SIGNAL_COPY)).toHaveLength(
      ABUSE_INBOX_SIGNAL_KINDS.length,
    );
  });

  it('ABUSE_INBOX_ERROR_COPY covers every closed-list rpc error code', () => {
    for (const code of ABUSE_INBOX_RPC_ERROR_CODES) {
      expect(ABUSE_INBOX_ERROR_COPY[code]).toBeTruthy();
    }
    expect(Object.keys(ABUSE_INBOX_ERROR_COPY)).toHaveLength(
      ABUSE_INBOX_RPC_ERROR_CODES.length,
    );
  });

  it('ABUSE_INBOX_RPC_ERROR_CODES is the three codes the rpc trio surfaces', () => {
    expect([...ABUSE_INBOX_RPC_ERROR_CODES].sort()).toEqual(
      ['bad_request', 'not_configured', 'permission_denied'],
    );
  });
});

// ────────────────────────────────────────────────────────────────
// computeRelativeTimeLabel
// ────────────────────────────────────────────────────────────────

describe('D-149 abuse-inbox — computeRelativeTimeLabel', () => {
  it('sub-minute elapsed ⇒ "just now"', () => {
    expect(computeRelativeTimeLabel(NOW - 30 * 1000, NOW)).toBe('just now');
    expect(computeRelativeTimeLabel(NOW, NOW)).toBe('just now');
  });

  it('minutes — singular + plural', () => {
    expect(computeRelativeTimeLabel(NOW - MINUTE_MS, NOW)).toBe('1 minute ago');
    expect(computeRelativeTimeLabel(NOW - 5 * MINUTE_MS, NOW)).toBe('5 minutes ago');
  });

  it('hours — singular + plural', () => {
    expect(computeRelativeTimeLabel(NOW - HOUR_MS, NOW)).toBe('1 hour ago');
    expect(computeRelativeTimeLabel(NOW - 3 * HOUR_MS, NOW)).toBe('3 hours ago');
  });

  it('days — singular + plural', () => {
    expect(computeRelativeTimeLabel(NOW - DAY_MS, NOW)).toBe('1 day ago');
    expect(computeRelativeTimeLabel(NOW - 6 * DAY_MS, NOW)).toBe('6 days ago');
  });

  it('a future timestamp (clock skew) clamps to "just now" — never a negative duration', () => {
    expect(computeRelativeTimeLabel(NOW + 5000, NOW)).toBe('just now');
    expect(computeRelativeTimeLabel(NOW + DAY_MS, NOW)).toBe('just now');
  });
});

// ────────────────────────────────────────────────────────────────
// computeWindowLabel
// ────────────────────────────────────────────────────────────────

describe('D-149 abuse-inbox — computeWindowLabel', () => {
  it('the 7-day rpc default ⇒ "Last 7 days"', () => {
    expect(computeWindowLabel(NOW - 7 * DAY_MS, NOW)).toBe('Last 7 days');
  });

  it('days — singular + plural', () => {
    expect(computeWindowLabel(NOW - DAY_MS, NOW)).toBe('Last 1 day');
    expect(computeWindowLabel(NOW - 30 * DAY_MS, NOW)).toBe('Last 30 days');
  });

  it('sub-day spans ⇒ hours', () => {
    expect(computeWindowLabel(NOW - HOUR_MS, NOW)).toBe('Last 1 hour');
    expect(computeWindowLabel(NOW - 6 * HOUR_MS, NOW)).toBe('Last 6 hours');
  });

  it('sub-hour spans ⇒ minutes', () => {
    expect(computeWindowLabel(NOW - 30 * MINUTE_MS, NOW)).toBe('Last 30 minutes');
    expect(computeWindowLabel(NOW - MINUTE_MS, NOW)).toBe('Last 1 minute');
  });

  it('rounds the span to the nearest day', () => {
    // 7 days + 3 hours ⇒ rounds back to 7.
    expect(computeWindowLabel(NOW - (7 * DAY_MS + 3 * HOUR_MS), NOW)).toBe('Last 7 days');
  });

  it('a non-positive span falls back to a neutral phrase', () => {
    expect(computeWindowLabel(NOW, NOW)).toBe('the selected window');
    expect(computeWindowLabel(NOW, NOW - 1000)).toBe('the selected window');
  });
});

// ────────────────────────────────────────────────────────────────
// buildAbuseInboxRowModel
// ────────────────────────────────────────────────────────────────

describe('D-149 abuse-inbox — buildAbuseInboxRowModel', () => {
  it('resolves the signal copy for every signal kind', () => {
    for (const kind of ABUSE_INBOX_SIGNAL_KINDS) {
      const model = buildAbuseInboxRowModel(mkRow({ signal_kind: kind }), NOW);
      expect(model.signal_kind).toBe(kind);
      expect(model.signal_label).toBe(ABUSE_INBOX_SIGNAL_COPY[kind].label);
      expect(model.signal_description).toBeTruthy();
      expect(model.suggested_action).toBeTruthy();
    }
  });

  it('truncates the source-IP hash to the § A.16.7 8-char prefix + carries the full value', () => {
    const model = buildAbuseInboxRowModel(mkRow(), NOW);
    expect(model.source_ip_hash).toBe(HASH);
    expect(model.source_ip_hash_prefix).toBe('abcdef01');
    expect(model.source_ip_hash_prefix).toHaveLength(8);
  });

  it('labels the first / last-seen stamps as relative time', () => {
    const model = buildAbuseInboxRowModel(
      mkRow({ first_seen_at: NOW - 3 * HOUR_MS, last_seen_at: NOW - 30 * MINUTE_MS }),
      NOW,
    );
    expect(model.first_seen_at).toBe(NOW - 3 * HOUR_MS);
    expect(model.first_seen_label).toBe('3 hours ago');
    expect(model.last_seen_at).toBe(NOW - 30 * MINUTE_MS);
    expect(model.last_seen_label).toBe('30 minutes ago');
  });

  it('carries event_count + ip_blocked through, and the block_key via abuseInboxBlockKey', () => {
    const model = buildAbuseInboxRowModel(
      mkRow({ event_count: 42, ip_blocked: true }),
      NOW,
    );
    expect(model.event_count).toBe(42);
    expect(model.ip_blocked).toBe(true);
    expect(model.block_key).toBe(abuseInboxBlockKey('ep-1', HASH));
  });

  it('a not-blocked row reports ip_blocked false', () => {
    expect(buildAbuseInboxRowModel(mkRow({ ip_blocked: false }), NOW).ip_blocked).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────
// buildAbuseInboxBlockedEntryModel
// ────────────────────────────────────────────────────────────────

describe('D-149 abuse-inbox — buildAbuseInboxBlockedEntryModel', () => {
  it('projects an IP-block entry with a truncated prefix + relative blocked-at label', () => {
    const model = buildAbuseInboxBlockedEntryModel(mkBlocked(), NOW);
    expect(model.endpoint_id).toBe('ep-1');
    expect(model.source_ip_hash).toBe(HASH);
    expect(model.source_ip_hash_prefix).toBe('abcdef01');
    expect(model.blocked_at).toBe(NOW - 2 * DAY_MS);
    expect(model.blocked_at_label).toBe('2 days ago');
    expect(model.blocked_by_client_id).toBe('cli-admin');
    expect(model.block_key).toBe(abuseInboxBlockKey('ep-1', HASH));
  });

  it('carries the reason through — non-null and null', () => {
    expect(buildAbuseInboxBlockedEntryModel(mkBlocked({ reason: 'brute force' }), NOW).reason).toBe(
      'brute force',
    );
    expect(buildAbuseInboxBlockedEntryModel(mkBlocked({ reason: null }), NOW).reason).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────
// buildAbuseInboxSubviewModel
// ────────────────────────────────────────────────────────────────

describe('D-149 abuse-inbox — buildAbuseInboxSubviewModel', () => {
  it('an empty summary + empty block list ⇒ is_empty, zero counts, default window label', () => {
    const model = buildAbuseInboxSubviewModel({ summary: mkSummary(), blocked: [], now: NOW });
    expect(model.header.total_signals).toBe(0);
    expect(model.header.is_empty).toBe(true);
    expect(model.header.window_label).toBe('Last 7 days');
    expect(model.header.cluster_threshold).toBe(3);
    expect(model.header.threshold_explanation).toContain('3');
    expect(model.header.blocked_count).toBe(0);
    expect(model.rows).toEqual([]);
    expect(model.blocked_entries).toEqual([]);
  });

  it('projects every cluster row, preserving the summary row order', () => {
    const rows = [
      mkRow({ signal_kind: 'spam_burst', endpoint_id: 'ep-a' }),
      mkRow({ signal_kind: 'mime_rejection', endpoint_id: 'ep-b' }),
      mkRow({ signal_kind: 'invalid_token_burst', endpoint_id: 'ep-c' }),
    ];
    const model = buildAbuseInboxSubviewModel({
      summary: mkSummary({ rows }),
      blocked: [],
      now: NOW,
    });
    expect(model.header.is_empty).toBe(false);
    expect(model.header.total_signals).toBe(3);
    expect(model.rows.map((r) => r.signal_kind)).toEqual([
      'spam_burst',
      'mime_rejection',
      'invalid_token_burst',
    ]);
    expect(model.rows.map((r) => r.endpoint_id)).toEqual(['ep-a', 'ep-b', 'ep-c']);
  });

  it('zero clusters but a non-empty block list ⇒ is_empty true, blocked_count > 0 (ban worked, traffic stopped)', () => {
    const model = buildAbuseInboxSubviewModel({
      summary: mkSummary({ rows: [] }),
      blocked: [mkBlocked({ source_ip_hash: 'aaaa1111bbbb2222' }), mkBlocked({ source_ip_hash: 'cccc3333dddd4444' })],
      now: NOW,
    });
    expect(model.header.is_empty).toBe(true);
    expect(model.header.total_signals).toBe(0);
    expect(model.header.blocked_count).toBe(2);
    expect(model.blocked_entries).toHaveLength(2);
    expect(model.blocked_entries[0]!.source_ip_hash_prefix).toBe('aaaa1111');
  });

  it('a custom cluster threshold flows into the header + its explanation', () => {
    const model = buildAbuseInboxSubviewModel({
      summary: mkSummary({ cluster_threshold: 10 }),
      blocked: [],
      now: NOW,
    });
    expect(model.header.cluster_threshold).toBe(10);
    expect(model.header.threshold_explanation).toContain('10');
  });

  it('derives the window label from the actual summary span, not the 7-day default', () => {
    const model = buildAbuseInboxSubviewModel({
      summary: mkSummary({ window_start_at: NOW - 6 * HOUR_MS, window_end_at: NOW }),
      blocked: [],
      now: NOW,
    });
    expect(model.header.window_label).toBe('Last 6 hours');
    expect(model.header.window_start_at).toBe(NOW - 6 * HOUR_MS);
    expect(model.header.window_end_at).toBe(NOW);
  });

  it('passes `now` through to the row + blocked-entry relative labels', () => {
    const model = buildAbuseInboxSubviewModel({
      summary: mkSummary({ rows: [mkRow({ last_seen_at: NOW - HOUR_MS })] }),
      blocked: [mkBlocked({ blocked_at: NOW - DAY_MS })],
      now: NOW,
    });
    expect(model.rows[0]!.last_seen_label).toBe('1 hour ago');
    expect(model.blocked_entries[0]!.blocked_at_label).toBe('1 day ago');
  });
});

// ────────────────────────────────────────────────────────────────
// Dispatch builders
// ────────────────────────────────────────────────────────────────

describe('D-149 abuse-inbox — dispatch builders', () => {
  it('buildAbuseInboxListDispatch with no args ⇒ just the op (server fills the defaults)', () => {
    const d = buildAbuseInboxListDispatch({});
    expect(d).toEqual({ op: 'reception.abuse_inbox.list' });
    expect('since' in d).toBe(false);
    expect('limit' in d).toBe(false);
    expect('cluster_threshold' in d).toBe(false);
  });

  it('buildAbuseInboxListDispatch includes only the supplied optional fields', () => {
    expect(buildAbuseInboxListDispatch({ limit: 50 })).toEqual({
      op: 'reception.abuse_inbox.list',
      limit: 50,
    });
    expect(
      buildAbuseInboxListDispatch({ since: 123, limit: 50, cluster_threshold: 5 }),
    ).toEqual({
      op: 'reception.abuse_inbox.list',
      since: 123,
      limit: 50,
      cluster_threshold: 5,
    });
  });

  it('buildAbuseInboxBanIpDispatch omits reason when undefined, includes it when supplied', () => {
    expect(
      buildAbuseInboxBanIpDispatch({ endpoint_id: 'ep-1', source_ip_hash: HASH }),
    ).toEqual({
      op: 'reception.abuse_inbox.ban_ip',
      endpoint_id: 'ep-1',
      source_ip_hash: HASH,
    });
    const withReason = buildAbuseInboxBanIpDispatch({
      endpoint_id: 'ep-1',
      source_ip_hash: HASH,
      reason: 'sustained spam burst',
    });
    expect(withReason).toEqual({
      op: 'reception.abuse_inbox.ban_ip',
      endpoint_id: 'ep-1',
      source_ip_hash: HASH,
      reason: 'sustained spam burst',
    });
  });

  it('buildAbuseInboxUnbanIpDispatch shapes the exact unban payload', () => {
    expect(
      buildAbuseInboxUnbanIpDispatch({ endpoint_id: 'ep-1', source_ip_hash: HASH }),
    ).toEqual({
      op: 'reception.abuse_inbox.unban_ip',
      endpoint_id: 'ep-1',
      source_ip_hash: HASH,
    });
  });

  it('a row model feeds a ban dispatch directly — endpoint_id + source_ip_hash line up', () => {
    const row = buildAbuseInboxRowModel(mkRow({ endpoint_id: 'ep-9' }), NOW);
    const ban = buildAbuseInboxBanIpDispatch({
      endpoint_id: row.endpoint_id,
      source_ip_hash: row.source_ip_hash,
    });
    expect(ban.endpoint_id).toBe('ep-9');
    expect(ban.source_ip_hash).toBe(HASH);
    expect(abuseInboxBlockKey(ban.endpoint_id, ban.source_ip_hash)).toBe(row.block_key);
  });
});
