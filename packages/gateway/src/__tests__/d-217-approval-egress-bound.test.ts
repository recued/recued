/** D-217 § 6.1 — the approval surface states the AMPLIFICATION BOUND.
 *
 *  ⛔ **Every other gated call in this system is one approval buying one
 *  request.** A chunked upload is one approval buying up to 103, and the ask
 *  that asks for it reads identically either way: *"Recipe r wants to run
 *  x-media.upload on x-media"*. The owner's "yes" means something materially
 *  different in the two cases, so an ask that does not say which is asking for
 *  consent to something it did not describe.
 *
 *  ⚠ It is not enough that the numbers exist in `args_preview` — that is raw
 *  resolved JSON, and a reader should not have to find `__cu_walk.count` in it
 *  to learn the blast radius. These tests assert the BODY, which is what a
 *  person actually reads.
 *
 *  Spec: D-217 § 6.1, § 8b.
 */

import { describe, it, expect } from 'vitest';
import type { Checkpoint } from '@recued/contracts';
import {
  buildPreflightAsk,
  type PreflightAskContext,
} from '../preflight-reconciliation.js';

const NOW = Date.parse('2026-07-26T12:00:00.000Z');

const checkpoint = (): Checkpoint => ({
  checkpoint_id: 'checkpoint-1',
  run_id: 'run-1',
  recipe_id: 'post-the-video',
  gated_step_id: 'upload',
  step_state: {},
  created_at: NOW,
});

const askContext = (
  overrides: Partial<PreflightAskContext> = {},
): PreflightAskContext => ({
  recipe_id: 'post-the-video',
  gated_step_id: 'upload',
  tool_slug: 'x-media.upload',
  connection_name: 'x-media',
  risk_tier: 'write',
  ...overrides,
});

const bodyFor = (overrides: Partial<PreflightAskContext> = {}): string =>
  buildPreflightAsk({ checkpoint: checkpoint(), context: askContext(overrides) })
    .message.text;

describe('D-217 § 6.1 — one approval, N requests, and the owner is told', () => {
  it('states the request count and the size in the ask body', async () => {
    const text = bodyFor({ egress_bound: { requests: 20, total_bytes: 100 * 1024 * 1024 } });
    expect(text).toContain('This one approval covers up to 20 requests, sending 100 MB off this machine.');
  });

  it('says nothing at all on an ordinary single-request hold', async () => {
    // ⚠ The absence matters as much as the presence: a line on every ask would
    // be noise the reader learns to skip, and the one time it carries a real
    // multiplier is the time they need to read it.
    const text = bodyFor();
    expect(text).not.toContain('This one approval covers');
    expect(text).not.toContain('off this machine');
  });

  it('agrees with itself grammatically at one request', async () => {
    const text = bodyFor({ egress_bound: { requests: 1, total_bytes: 4096 } });
    expect(text).toContain('covers up to 1 request, sending 4 KB');
    expect(text).not.toContain('1 requests');
  });

  it('⛔ puts the bound BEFORE the question the buttons answer', async () => {
    // A reader who has to scroll back past the question to find the evidence is
    // a reader who stops reading the evidence — the same ordering rule the
    // open-grant block was moved for.
    const text = bodyFor({ egress_bound: { requests: 103, total_bytes: 512 * 1024 * 1024 } });
    expect(text.indexOf('This one approval covers')).toBeGreaterThan(-1);
    expect(text.indexOf('This one approval covers')).toBeLessThan(text.indexOf('Approve?'));
  });

  it('keeps the bound when a policy reason is also rendered', async () => {
    // Two independent claims from two authorities; neither may swallow the other.
    const text = bodyFor({
      reason: 'operation is write-tier',
      egress_bound: { requests: 7, total_bytes: 1024 },
    });
    expect(text).toContain('covers up to 7 requests');
    expect(text).toContain('Reason: operation is write-tier');
  });
});

describe('D-217 § 6.1 — the size is rendered, not left as arithmetic', () => {
  it.each([
    [0, '0 bytes'],
    [512, '512 bytes'],
    [1024, '1 KB'],
    [1536, '1.5 KB'],
    [5 * 1024 * 1024, '5 MB'],
    [512 * 1024 * 1024, '512 MB'],
    [1024 * 1024 * 1024, '1 GB'],
    [1610612736, '1.5 GB'],
  ])('renders %i bytes as %s', async (bytes, expected) => {
    // ⚠ `104857600` is a number the reader has to do arithmetic on before it
    // means anything. An approval surface that makes the owner compute the
    // blast radius has not stated it.
    const text = bodyFor({ egress_bound: { requests: 2, total_bytes: bytes } });
    expect(text).toContain(`sending ${expected} off this machine`);
  });

  it('never renders a trailing .0 on a whole size', async () => {
    const text = bodyFor({ egress_bound: { requests: 2, total_bytes: 25 * 1024 * 1024 } });
    expect(text).toContain('25 MB');
    expect(text).not.toContain('25.0 MB');
  });

  it('uses BINARY units, so the stated bound matches the enforced one', async () => {
    // The ceiling is 512 MiB. Calling that "537 MB" to match marketing decimals
    // would misreport the actual limit on the one surface that has to be exact.
    const text = bodyFor({ egress_bound: { requests: 103, total_bytes: 512 * 1024 * 1024 } });
    expect(text).toContain('512 MB');
    expect(text).not.toContain('537');
  });
});
