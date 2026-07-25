/** D-157 — outbound-send preflight, end to end through the gateway probe.
 *
 *  Pins the actual Gap-F closure: a user-driven outbound send now produces an
 *  `'ask'` verdict at the per-call dispatch probe (`evaluatePreflightAdmission`),
 *  and `raiseOnAsk` throws `PreflightRequiredSignal` — the engine catch that
 *  checkpoints + pops the D-157 approval. An admin-shell `system` send (housekeeping /
 *  webhook door) and a user-driven internal write stay `'admit'` (no preflight). D-209
 *  §1.4: a `schedule`/`reactive` system send now HOLDS via the LOW `read` ceiling (it
 *  fails closed), so unattended automation IS gated — routine warehouse writes are not.
 */

import { PreflightRequiredSignal } from '@recued/contracts';
import type { ExecutionSource } from '@recued/contracts';
import { describe, expect, it } from 'vitest';

import { evaluatePreflightAdmission, raiseOnAsk, type PreflightTool } from '../preflight-gate.js';

const USER: ExecutionSource = {
  channel: 'user',
  actor: 'user_self',
  user_id: 'u',
  client_token_id: 't',
};
const SCHEDULE: ExecutionSource = {
  channel: 'schedule',
  actor: 'system',
  cron: '0 9 * * *',
  source_recipe: 'daily-digest',
};
// D-209 §1.4 — an admin-shell system source (housekeeping; webhook resolves the same):
// KEEPS the `admin` ceiling, so a send admits with no preflight — the lift is system-exempt.
const HOUSEKEEPING: ExecutionSource = {
  channel: 'housekeeping',
  actor: 'system',
  cycle_id: 'cyc',
  task: 'maintenance',
  visible_to_user: false,
};

const MAIL_SEND: PreflightTool = { slug: 'mail-send', kind: 'storage', risk_tier: 'write' };

describe('D-157 outbound-send preflight (gateway)', () => {
  it('a user-driven mail-send → ask → raiseOnAsk throws PreflightRequiredSignal', () => {
    const decision = evaluatePreflightAdmission({ source: USER, tool: MAIL_SEND });
    expect(decision.verdict).toBe('ask');
    expect(() => raiseOnAsk(decision, { slug: 'mail-send' })).toThrow(PreflightRequiredSignal);
  });

  it('an admin-shell (system) mail-send → admit → no preflight (lift is system-exempt)', () => {
    const decision = evaluatePreflightAdmission({ source: HOUSEKEEPING, tool: MAIL_SEND });
    expect(decision.verdict).toBe('admit');
    expect(() => raiseOnAsk(decision, { slug: 'mail-send' })).not.toThrow();
  });

  it('D-209 §1.4 — a scheduled (system) mail-send now HOLDS via the LOW ceiling → ask → preflight', () => {
    // Unattended owner automation fails closed to `read`; the send surfaces via the
    // ceiling (write > read), not the lift. Silence is earned via the D-177 learner.
    const decision = evaluatePreflightAdmission({ source: SCHEDULE, tool: MAIL_SEND });
    expect(decision.verdict).toBe('ask');
    expect(() => raiseOnAsk(decision, { slug: 'mail-send' })).toThrow(PreflightRequiredSignal);
  });

  it('a user-driven internal write (data-annotate) → admit → no preflight', () => {
    const decision = evaluatePreflightAdmission({
      source: USER,
      tool: { slug: 'data-annotate', kind: 'storage', risk_tier: 'write' },
    });
    expect(decision.verdict).toBe('admit');
  });
});
