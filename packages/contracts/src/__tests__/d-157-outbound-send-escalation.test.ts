/** D-157 / D-158 outbound-send approval promise — now enforced through the D-187
 *  slice-4 op-risk path (`admitByOpRisk`), where the matrix-coupled
 *  `escalateOutboundSend` relocated to the actor-scoped `liftOutboundSend`.
 *
 *  Plain `write`-tier outbound sends (`mail-send` / `mail-post` / `slack-post` /
 *  `notification-send` / `connection-mcp-write`) RELAX to admit at the `admin` ceiling
 *  (owner-direct HID/chat, or an admin-shell system source — housekeeping / webhook door)
 *  — so an AI or recipe could email / Slack someone on the user's behalf with no prompt —
 *  unless the lift re-raises them to `'ask'` at the attended `user_self` cells, routing
 *  them through the D-157 preflight gate. The lift stays deliberately actor-scoped: it
 *  never fires for a `system` actor, and every internal write / `read` is left admit.
 *
 *  D-209 §1.4 note: a `schedule`/`reactive` system send no longer admits — that source
 *  now fails closed to the LOW `read` ceiling and HOLDS the send via the CEILING (not the
 *  lift). The lift's actor-scoping is unchanged; only the automation ceiling moved.
 */

import { describe, expect, it } from 'vitest';

import {
  OUTBOUND_SEND_INGREDIENT_SLUGS,
  admitByOpRisk,
  isOutboundSendSlug,
  resolveTrustCeiling,
} from '../index.js';
import type { ExecutionSource, RiskTier } from '../index.js';

// ── Sources at the cells the lift cares about. Owner-direct (user/chat/messenger
// user_self) + admin-shell system (housekeeping) → `admin` ceiling; a schedule/reactive
// system source → the LOW `read` ceiling (D-209 §1.4). ──
const USER: ExecutionSource = {
  channel: 'user',
  actor: 'user_self',
  user_id: 'u',
  client_token_id: 't',
};
const CHAT: ExecutionSource = {
  channel: 'chat',
  actor: 'user_self',
  chat_session_id: 's',
  user_id: 'u',
};
const MESSENGER: ExecutionSource = {
  channel: 'messenger',
  actor: 'user_self',
  vendor: 'slack',
  from: 'U123',
};
const SCHEDULE: ExecutionSource = {
  channel: 'schedule',
  actor: 'system',
  cron: '0 9 * * 1-5',
  source_recipe: 'daily-digest',
};
const REACTIVE: ExecutionSource = {
  channel: 'reactive',
  actor: 'system',
  event_kind: 'mail.created',
  source_recipe: 'auto-reply',
};
// D-209 §1.4 — an admin-shell SYSTEM source (housekeeping; a webhook door resolves the
// same). Unlike schedule/reactive it KEEPS the `admin` ceiling, so a send admits there —
// which is what still proves the lift is system-exempt (it never re-raises a system send).
const HOUSEKEEPING: ExecutionSource = {
  channel: 'housekeeping',
  actor: 'system',
  cycle_id: 'cyc',
  task: 'maintenance',
  visible_to_user: false,
};

/** The op-risk admission for a simple-form dispatch at `source`, contract-less (the
 *  ceiling is the owner/automation global `admin`, resolved through the real
 *  `resolveTrustCeiling` path). */
const admit = (slug: string, source: ExecutionSource, risk_tier: RiskTier = 'write') =>
  admitByOpRisk({
    slug,
    risk_tier,
    ceiling: resolveTrustCeiling(source),
    source,
  });

// D-177 P2b adds `connection-mcp-write`: a WRITE-classified tool on an enrolled MCP
// connection is an external side-effect like the four communication sends.
const SENDS = [
  'mail-send',
  'mail-post',
  'slack-post',
  'notification-send',
  'connection-mcp-write',
  // D-210 §7 — the booking-visitor courtesy send. Recipient sealed + resolved
  // server-side, but delivery is still an irreversible external send.
  'notify-booking-visitor',
] as const;

describe('D-157 outbound-send promise via D-187 op-risk lift (admitByOpRisk)', () => {
  it('the closed send set is exactly the six external-side-effect slugs', () => {
    expect([...OUTBOUND_SEND_INGREDIENT_SLUGS].sort()).toEqual(
      [
        'connection-mcp-write',
        'mail-post',
        'mail-send',
        'notification-send',
        'notify-booking-visitor',
        'slack-post',
      ],
    );
    for (const slug of SENDS) expect(isOutboundSendSlug(slug)).toBe(true);
    expect(isOutboundSendSlug('data-annotate')).toBe(false);
    expect(isOutboundSendSlug('mail-reader')).toBe(false);
    // The read sibling stays out — Tier-3 reads are pass-through (D-177 D7).
    expect(isOutboundSendSlug('connection-mcp-read')).toBe(false);
  });

  it('§5 — core- kernel aliases of the send slugs lift identically', () => {
    // A published recipe must not reach an outbound send via the core alias that
    // bypasses the preflight lift its bare slug triggers.
    expect(isOutboundSendSlug('core-mail-post')).toBe(true);
    expect(isOutboundSendSlug('core-slack-post')).toBe(true);
    expect(isOutboundSendSlug('core-notify-booking-visitor')).toBe(true);
    expect(isOutboundSendSlug('core-notification-send')).toBe(true);
    // A core- alias of a non-send slug is still not a send.
    expect(isOutboundSendSlug('core-ai-classify')).toBe(false);
  });

  it.each(SENDS)('lifts "%s" to ask at (user, user_self)', (slug) => {
    const decision = admit(slug, USER);
    expect(decision.verdict).toBe('ask');
    if (decision.verdict === 'ask') {
      // Risk tier preserved for audit — a send is a `write`, not reclassified.
      expect(decision.risk_tier).toBe('write');
      expect(decision.detail).toContain(slug);
    }
  });

  it('lifts a send to ask at (chat, user_self) and (messenger, user_self)', () => {
    for (const source of [CHAT, MESSENGER]) {
      expect(admit('mail-send', source).verdict).toBe('ask');
    }
  });

  it('does NOT lift a send for a system actor — the lift is actor-scoped (an admin-shell system source admits)', () => {
    // The lift is exempt for `system`, so at the admin ceiling (housekeeping / webhook
    // door) the write send relaxes to admit — the lift never re-raises it.
    expect(admit('mail-send', HOUSEKEEPING).verdict).toBe('admit');
  });

  it('D-209 §1.4 — a (schedule|reactive) system send HOLDS via the LOW ceiling, not the lift', () => {
    // Unattended owner automation now fails closed to the `read` ceiling, so the write
    // send surfaces (write > read) — a different mechanism than the user_self-scoped lift,
    // same surfaced outcome. Silence is earned via the D-177 learner, never by default.
    for (const source of [SCHEDULE, REACTIVE]) {
      expect(admit('mail-send', source).verdict).toBe('ask');
    }
  });

  it('does NOT lift an internal write (non-send) at (user, user_self)', () => {
    // `data-annotate` is `risk_tier: 'write'` like the sends, but it is not an
    // external send — the admin ceiling relaxes it to admit and it must stay silent.
    expect(admit('data-annotate', USER, 'write').verdict).toBe('admit');
  });

  it('does NOT lift a read at (user, user_self)', () => {
    expect(admit('mail-reader', USER, 'read').verdict).toBe('admit');
  });
});
