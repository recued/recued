/** D-148 P4 — approval nonce store: issue + consume + replay. */

import { describe, expect, it } from 'vitest';
import { APPROVAL_NONCE_TTL_MS } from '@recued/contracts';
import { createApprovalNonceStore } from '../webclients/approval-nonce.js';

describe('D-148 P4 — approval nonce store', () => {
  it('issue → consume succeeds with matching tuple', () => {
    let now = 1_000;
    const store = createApprovalNonceStore({ now: () => now });
    const env = store.issue({
      approval_id: 'apr_1',
      responder_client_id: 'cli_1',
    });
    expect(env.nonce.length).toBeGreaterThan(0);
    expect(env.expires_at).toBe(1_000 + APPROVAL_NONCE_TTL_MS);
    const result = store.consume(
      {
        approval_id: 'apr_1',
        decision: 'allow_once',
        nonce: env.nonce,
        decided_at: now,
      },
      { responder_client_id: 'cli_1' },
    );
    expect(result).toEqual({ ok: true });
  });

  it('replay fails with approval_nonce_consumed', () => {
    const store = createApprovalNonceStore();
    const env = store.issue({ approval_id: 'apr_1', responder_client_id: 'cli_1' });
    const first = store.consume(
      { approval_id: 'apr_1', decision: 'deny', nonce: env.nonce, decided_at: 1 },
      { responder_client_id: 'cli_1' },
    );
    expect(first).toEqual({ ok: true });
    const replay = store.consume(
      { approval_id: 'apr_1', decision: 'deny', nonce: env.nonce, decided_at: 2 },
      { responder_client_id: 'cli_1' },
    );
    expect(replay).toEqual({ ok: false, error: 'approval_nonce_consumed' });
  });

  it('mismatched client returns approval_nonce_mismatched_client', () => {
    const store = createApprovalNonceStore();
    const env = store.issue({ approval_id: 'apr_1', responder_client_id: 'cli_1' });
    const r = store.consume(
      { approval_id: 'apr_1', decision: 'deny', nonce: env.nonce, decided_at: 1 },
      { responder_client_id: 'cli_OTHER' },
    );
    expect(r).toEqual({ ok: false, error: 'approval_nonce_mismatched_client' });
  });

  it('mismatched approval returns approval_nonce_mismatched_approval', () => {
    const store = createApprovalNonceStore();
    const env = store.issue({ approval_id: 'apr_1', responder_client_id: 'cli_1' });
    const r = store.consume(
      { approval_id: 'apr_OTHER', decision: 'deny', nonce: env.nonce, decided_at: 1 },
      { responder_client_id: 'cli_1' },
    );
    expect(r).toEqual({ ok: false, error: 'approval_nonce_mismatched_approval' });
  });

  it('unknown nonce returns approval_nonce_invalid', () => {
    const store = createApprovalNonceStore();
    const r = store.consume(
      { approval_id: 'apr_1', decision: 'deny', nonce: 'forged', decided_at: 1 },
      { responder_client_id: 'cli_1' },
    );
    expect(r).toEqual({ ok: false, error: 'approval_nonce_invalid' });
  });

  it('expired nonce returns approval_nonce_expired', () => {
    let now = 1_000;
    const store = createApprovalNonceStore({ now: () => now });
    const env = store.issue({ approval_id: 'apr_1', responder_client_id: 'cli_1' });
    now = env.expires_at + 1;
    const r = store.consume(
      { approval_id: 'apr_1', decision: 'deny', nonce: env.nonce, decided_at: now },
      { responder_client_id: 'cli_1' },
    );
    expect(r).toEqual({ ok: false, error: 'approval_nonce_expired' });
  });

  it('re-issue invalidates prior nonce for the same tuple', () => {
    const store = createApprovalNonceStore();
    const first = store.issue({ approval_id: 'apr_1', responder_client_id: 'cli_1' });
    const second = store.issue({ approval_id: 'apr_1', responder_client_id: 'cli_1' });
    expect(second.nonce).not.toBe(first.nonce);
    const r = store.consume(
      { approval_id: 'apr_1', decision: 'deny', nonce: first.nonce, decided_at: 1 },
      { responder_client_id: 'cli_1' },
    );
    expect(r).toEqual({ ok: false, error: 'approval_nonce_invalid' });
  });

  it('parallel approvals carry distinct nonces per tuple', () => {
    const store = createApprovalNonceStore();
    const a = store.issue({ approval_id: 'apr_1', responder_client_id: 'cli_A' });
    const b = store.issue({ approval_id: 'apr_1', responder_client_id: 'cli_B' });
    expect(a.nonce).not.toBe(b.nonce);
    // A's nonce can't resolve B (and vice versa).
    expect(
      store.consume(
        { approval_id: 'apr_1', decision: 'deny', nonce: a.nonce, decided_at: 1 },
        { responder_client_id: 'cli_B' },
      ),
    ).toEqual({ ok: false, error: 'approval_nonce_mismatched_client' });
  });

  it('list reports live envelopes only', () => {
    let now = 1_000;
    const store = createApprovalNonceStore({ now: () => now });
    store.issue({ approval_id: 'a', responder_client_id: 'c' });
    expect(store.list().length).toBe(1);
    now += APPROVAL_NONCE_TTL_MS + 1;
    // sweep happens on next issue/consume.
    store.issue({ approval_id: 'a2', responder_client_id: 'c' });
    expect(store.list().length).toBe(1);
  });

  it('clear empties the store', () => {
    const store = createApprovalNonceStore();
    store.issue({ approval_id: 'a', responder_client_id: 'c' });
    store.clear();
    expect(store.list()).toEqual([]);
  });

  it('Codex P3 #6 fold — tuple key length-prefix avoids `|` collision', () => {
    const store = createApprovalNonceStore();
    // Without length prefixing, `("a|b", "c")` and `("a", "b|c")`
    // would both serialize to the same key `a|b|c|`. With length
    // prefixes they are distinct, so a re-issue against one tuple
    // doesn't invalidate the other.
    const a = store.issue({ approval_id: 'a|b', responder_client_id: 'c' });
    const b = store.issue({ approval_id: 'a', responder_client_id: 'b|c' });
    expect(a.nonce).not.toBe(b.nonce);
    // Both nonces remain consumable independently.
    expect(
      store.consume(
        { approval_id: 'a|b', decision: 'deny', nonce: a.nonce, decided_at: 1 },
        { responder_client_id: 'c' },
      ),
    ).toEqual({ ok: true });
    expect(
      store.consume(
        { approval_id: 'a', decision: 'deny', nonce: b.nonce, decided_at: 1 },
        { responder_client_id: 'b|c' },
      ),
    ).toEqual({ ok: true });
  });
});
