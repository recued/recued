/** D-232 § 24 — retry is the one part that can cause harm by working. */
import { describe, expect, it } from 'vitest';
import {
  planExchangeRetry, EXCHANGE_RETRY_BASE_MS, type ExchangeRetryRow,
} from '../source-primitive.js';

const CB = 'peer-project-update-reply';
const T = 1_000_000_000;
const classify = (errors: readonly unknown[]) => {
  const code = String((errors[0] as { code?: string } | undefined)?.code ?? '');
  return {
    kind: (code === 'NETWORK_ERROR' ? 'unavailable'
      : code === 'MCP_TOOL_ERROR' ? 'error'
      : code === 'DENIED' ? 'policy' : 'error') as never,
    reason: code,
  };
};
const carrier = (at: number, code: string, config?: Record<string, unknown>): ExchangeRetryRow =>
  ({ recipe_id: 'run-ingredient', status: 'failed', at, errors: [{ code }],
     config: config ?? { tool: 'x', args: { a: 1 } } });
const ok = (recipe_id: string, at: number): ExchangeRetryRow =>
  ({ recipe_id, status: 'succeeded', at });

const plan = (rows: ExchangeRetryRow[], now: number) =>
  planExchangeRetry('r', rows, CB, classify, now);

describe('D-232 § 24 — when NOT to retry', () => {
  it('⛔ never retries a REFUSAL — only `unavailable` is retryable', () => {
    // `policy` needs the OWNER, not another attempt. Knocking again is useless
    // and indistinguishable from probing.
    const out = plan([carrier(T, 'DENIED')], T + 1e9);
    expect(out.retry).toBe(false);
  });

  it('⛔⛔ never retries an `error` — it may ALREADY HAVE COMMITTED', () => {
    /** `ACTION_DELIVERY_UNCERTAIN` lives in this bucket: the write may have
     *  landed and only the acknowledgement was lost. An automatic retry there
     *  duplicates it, which for a money movement is the expensive direction. */
    const out = plan([carrier(T, 'MCP_TOOL_ERROR')], T + 1e9);
    expect(out.retry).toBe(false);
  });

  it('⛔⛔⛔ § 30 — NEVER retries because THEIR reply failed, even on `unavailable`', () => {
    /** THE INPUT THAT WOULD FIRE IF THE FENCE WERE GONE, which is the only kind
     *  worth asserting on a guard. The peer took our message and reported that
     *  their ANSWER could not leave — `unavailable`, the one retryable kind. If
     *  § 30 had reused `undeliverable` for that state, this plan would come back
     *  `retry: true` and re-send OUR ask: it would not fix their outbound route,
     *  and it would make them run their receiver a second time on one request.
     *
     *  🔑 NO GUARD WAS ADDED TO `planExchangeRetry` FOR THIS. The refusal comes
     *  from naming the state honestly — the letter WAS delivered, so it is not
     *  `undeliverable` — and the existing status check then covers it for free.
     *  That is why the reason string is asserted too: it must be the existing
     *  branch talking, not a new one bolted on. */
    const out = plan([
      { recipe_id: 'run-ingredient', status: 'succeeded', at: T,
        config: { tool: 'x', args: { a: 1 } } },
      { recipe_id: 'request-peer-project-update', status: 'succeeded', at: T,
        peer_ack: { ref: 'r', accepted: false, kind: 'unavailable', retrying: true } },
    ], T + 1e9);
    expect(out.retry).toBe(false);
    expect(out.retry === false && out.reason).toContain('unanswerable');
  });

  it('⛔ never retries once ANSWERED, even if a carrier failed', () => {
    /** An answer after a failed carrier means an EARLIER attempt landed.
     *  Re-sending would ask the peer to act twice on one request. */
    const out = plan([carrier(T, 'NETWORK_ERROR'), ok(CB, T + 10)], T + 1e9);
    expect(out.retry).toBe(false);
  });

  it('⛔ stops at the ceiling — a peer down for a week is not knocked on forever', () => {
    const rows = [0, 1, 2, 3].map((i) => carrier(T + i * 1e6, 'NETWORK_ERROR'));
    expect(plan(rows, T + 1e9).retry).toBe(false);
  });

  it('⛔ respects backoff, measured from the LAST attempt', () => {
    const rows = [carrier(T, 'NETWORK_ERROR'), carrier(T + 5_000, 'NETWORK_ERROR')];
    // 2 attempts → wait 2× base from the SECOND, not the first.
    expect(plan(rows, T + 5_000 + EXCHANGE_RETRY_BASE_MS).retry).toBe(false);
    expect(plan(rows, T + 5_000 + EXCHANGE_RETRY_BASE_MS * 2 + 1).retry).toBe(true);
  });

  it('⛔ refuses when the failed attempt recorded no args to re-send', () => {
    // Sending something rebuilt from elsewhere, under a ref the peer may already
    // have seen, is worse than not retrying.
    const out = plan([{ ...carrier(T, 'NETWORK_ERROR'), config: {} }], T + 1e9);
    expect(out.retry).toBe(false);
  });
});

describe('D-232 § 24 — when to retry', () => {
  it('an unreachable peer, past backoff, under the ceiling', () => {
    const out = plan([carrier(T, 'NETWORK_ERROR', { tool: 'peer-apply', args: { id: 'p1' } })],
                     T + EXCHANGE_RETRY_BASE_MS + 1);
    expect(out.retry).toBe(true);
    if (out.retry) {
      expect(out.attempt).toBe(2);
      // 🔑 The payload is the one that FAILED — a retry re-sends what was sent.
      expect(out.args).toEqual({ tool: 'peer-apply', args: { id: 'p1' } });
    }
  });
});
