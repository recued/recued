/** D-153 P1 — commit-substrate identity (D-145 engine-wiring).
 *
 *  Unit coverage for the two engine primitives:
 *   - `deriveChannelSessionId` — pure per-channel projection of an
 *     `ExecutionSource` onto its channel-owned session boundary.
 *   - `createCorrelationTracker` — the deterministic ~1-min
 *     intent-burst heuristic.
 *
 *  The engine-side integration — `execute-handler.ts` stamping these
 *  onto audit/commit rows — is covered by
 *  `backend/server/src/__tests__/d-153-phase-1-engine-wiring.test.ts`.
 */

import { describe, it, expect } from 'vitest';
import type { ExecutionSource } from '@recued/contracts';

import {
  deriveChannelSessionId,
  createCorrelationTracker,
  CORRELATION_WINDOW_MS,
} from '../commit-identity.js';

// ────────────────────────────────────────────────────────────────
// deriveChannelSessionId — pure per-channel projection
// ────────────────────────────────────────────────────────────────

describe('deriveChannelSessionId', () => {
  it('projects the user channel onto its client token', () => {
    const source: ExecutionSource = {
      channel: 'user',
      actor: 'user_self',
      user_id: 'u1',
      client_token_id: 'tok-9',
    };
    expect(deriveChannelSessionId(source)).toBe('user:tok-9');
  });

  it('projects the chat channel onto its chat session', () => {
    expect(
      deriveChannelSessionId({
        channel: 'chat',
        actor: 'user_self',
        chat_session_id: 'sess-7',
        user_id: 'u1',
      }),
    ).toBe('chat:sess-7');
  });

  it('projects the mcp channel onto its token lifetime', () => {
    expect(
      deriveChannelSessionId({
        channel: 'mcp',
        actor: 'contracted_user',
        agent_id: 'a1',
        tool_call_id: 'tc1',
        mcp_token_id: 'tok-mcp',
        contract_id: 'c1',
      }),
    ).toBe('mcp:tok-mcp');
  });

  it('projects the messenger channel onto vendor + sender', () => {
    expect(
      deriveChannelSessionId({
        channel: 'messenger',
        actor: 'user_self',
        vendor: 'slack',
        from: 'U123',
      }),
    ).toBe('messenger:slack:U123');
  });

  it('projects reception onto reception_id, appending visitor_id when present', () => {
    expect(
      deriveChannelSessionId({
        channel: 'reception',
        actor: 'anonymous',
        reception_id: 'recp-1',
      }),
    ).toBe('reception:recp-1');
    expect(
      deriveChannelSessionId({
        channel: 'reception',
        actor: 'contracted_user',
        reception_id: 'recp-1',
        visitor_id: 'v-9',
        contract_id: 'c1',
      }),
    ).toBe('reception:recp-1:v-9');
  });

  it('projects webhook onto its registered secret id (actor-agnostic — D-209 #1 W3 anonymous door)', () => {
    expect(
      deriveChannelSessionId({
        channel: 'webhook',
        actor: 'anonymous',
        vendor: 'stripe',
        webhook_secret_id: 'whsec-1',
      }),
    ).toBe('webhook:whsec-1');
  });

  it('projects schedule + reactive onto their source recipe', () => {
    expect(
      deriveChannelSessionId({
        channel: 'schedule',
        actor: 'system',
        cron: '0 9 * * *',
        source_recipe: 'daily-briefing',
      }),
    ).toBe('schedule:daily-briefing');
    expect(
      deriveChannelSessionId({
        channel: 'reactive',
        actor: 'system',
        event_kind: 'mail_arrived',
        source_recipe: 'triage-inbox',
      }),
    ).toBe('reactive:triage-inbox');
  });

  it('projects housekeeping onto its cycle id', () => {
    expect(
      deriveChannelSessionId({
        channel: 'housekeeping',
        actor: 'system',
        cycle_id: 'cycle-42',
        task: 'audit-compaction',
        visible_to_user: false,
      }),
    ).toBe('housekeeping:cycle-42');
  });

  it('channel-prefixes so identical raw ids in different channels never collide', () => {
    // A `schedule` source keyed on a short human recipe slug and a
    // `chat` session keyed on the same literal string must not share a
    // `channel_session_id` — the prefix keeps the tier-query unambiguous.
    const chat = deriveChannelSessionId({
      channel: 'chat',
      actor: 'user_self',
      chat_session_id: 'shared-id',
      user_id: 'u1',
    });
    const schedule = deriveChannelSessionId({
      channel: 'schedule',
      actor: 'system',
      cron: '* * * * *',
      source_recipe: 'shared-id',
    });
    expect(chat).not.toBe(schedule);
    expect(chat).toBe('chat:shared-id');
    expect(schedule).toBe('schedule:shared-id');
  });
});

// ────────────────────────────────────────────────────────────────
// createCorrelationTracker — the ~1-min intent-burst heuristic
// ────────────────────────────────────────────────────────────────

/** A deterministic, monotonically-increasing id generator so the
 *  heuristic's reuse / mint decisions are observable without UUIDs. */
const seqGen = (): (() => string) => {
  let n = 0;
  return () => `corr-${(n += 1)}`;
};

describe('createCorrelationTracker', () => {
  it('reuses the correlation id for dispatches inside the window', () => {
    const tracker = createCorrelationTracker({ genId: seqGen() });
    const first = tracker.assign('chat:s1', 1_000);
    const second = tracker.assign('chat:s1', 1_000 + CORRELATION_WINDOW_MS - 1);
    expect(first).toBe('corr-1');
    expect(second).toBe('corr-1');
  });

  it('mints a fresh correlation id at or beyond the window boundary', () => {
    const tracker = createCorrelationTracker({ genId: seqGen() });
    const first = tracker.assign('chat:s1', 1_000);
    const atBoundary = tracker.assign('chat:s1', 1_000 + CORRELATION_WINDOW_MS);
    expect(first).toBe('corr-1');
    expect(atBoundary).toBe('corr-2');
  });

  it('slides the window from the most recent dispatch, not the burst start', () => {
    const tracker = createCorrelationTracker({ genId: seqGen() });
    tracker.assign('chat:s1', 0);
    // 40s after the burst start — within window; reuses, and advances
    // the session's last-dispatch clock to 40s.
    expect(tracker.assign('chat:s1', 40_000)).toBe('corr-1');
    // 70s after the burst start but only 30s after the last dispatch
    // — still inside the sliding window.
    expect(tracker.assign('chat:s1', 70_000)).toBe('corr-1');
    // 70s after the last dispatch — a fresh burst.
    expect(tracker.assign('chat:s1', 140_001)).toBe('corr-2');
  });

  it('tracks each channel session independently', () => {
    const tracker = createCorrelationTracker({ genId: seqGen() });
    expect(tracker.assign('chat:s1', 1_000)).toBe('corr-1');
    expect(tracker.assign('chat:s2', 1_000)).toBe('corr-2');
    // Each session keeps reusing its own id within its own window.
    expect(tracker.assign('chat:s1', 2_000)).toBe('corr-1');
    expect(tracker.assign('chat:s2', 2_000)).toBe('corr-2');
  });

  it('reset() drops all tracked state', () => {
    const tracker = createCorrelationTracker({ genId: seqGen() });
    expect(tracker.assign('chat:s1', 1_000)).toBe('corr-1');
    tracker.reset();
    // After reset the session is unknown — mints fresh even though the
    // dispatch is well inside the window.
    expect(tracker.assign('chat:s1', 1_500)).toBe('corr-2');
  });

  it('defaults to a corr-prefixed unique id when no genId is injected', () => {
    const tracker = createCorrelationTracker();
    const a = tracker.assign('chat:s1', 1_000);
    const b = tracker.assign('chat:s2', 1_000);
    expect(a).toMatch(/^corr-/);
    expect(b).toMatch(/^corr-/);
    expect(a).not.toBe(b);
  });
});
