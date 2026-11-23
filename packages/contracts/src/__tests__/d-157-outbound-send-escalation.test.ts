/** D-157 / D-158 outbound-send approval promise — kept since D-177 §N.15.6 (2026-11-10) by each
 *  op's own approval, with NO send named. The owner: *"(mail-send, mail-post, slack-post) should
 *  join the risk & approval setting so that it is uniformed"*, and *"that lays the foundation of
 *  the approval system unformly"*.
 *
 *  Until then the owner's chat took the `admin` ceiling, where a `write` relaxes, and a by-name
 *  lift (`liftOutboundSend`) re-raised these sends to `ask` for a person driving. Now the owner's
 *  chat and messenger chat take the `read` ceiling (`OWNER_CHAT_TRUST_CEILING`), as automation
 *  does, so a send asks there by its approval like every write — internal ones too — while what
 *  the owner runs from the app (`user`) relaxes, sends included. The send set survives only to
 *  name Recued's sends (the Reason line's words, `mail-send`'s attachment check).
 */

import { describe, expect, it } from 'vitest';

import {
  OUTBOUND_SEND_INGREDIENT_SLUGS,
  OWNER_CHAT_TRUST_CEILING,
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
// ⛔ `notification-send` LEFT this set 2026-08-20 (owner ruling) — it authors no
// recipient, so there is nothing for the lift to show. See
// `d-177-notification-send-is-not-a-send.test.ts`, which owns its negative pins.
const SENDS = [
  'mail-send',
  'mail-post',
  'slack-post',
  'connection-mcp-write',
  // D-210 §7 — the booking-visitor courtesy send. Recipient sealed + resolved
  // server-side, but delivery is still an irreversible external send.
  'notify-booking-visitor',
  // D-234 § 234.4o — `core.peer.ask`'s backing ingredient.
  'peer-ask',
] as const;

describe('D-157 outbound-send promise, kept by each op\'s approval (admitByOpRisk)', () => {
  it('the closed send set is exactly the six RECIPIENT-AUTHORING slugs', () => {
    // ⚠ The membership rule is "does the RECIPE author a destination?", NOT
    // "does a packet leave the machine" — `notification-send` does the latter
    // and not the former, which is why it is absent below.
    expect([...OUTBOUND_SEND_INGREDIENT_SLUGS].sort()).toEqual(
      [
        'connection-mcp-write',
        'mail-post',
        'mail-send',
        'notify-booking-visitor',
        // D-234 § 234.4o — a question on another server owner's SCREEN is an
        // irreversible outbound act too, and the owner was asked zero times for
        // it before this.
        'peer-ask',
        'slack-post',
      ],
    );
    for (const slug of SENDS) expect(isOutboundSendSlug(slug)).toBe(true);
    expect(isOutboundSendSlug('annotation-create')).toBe(false);
    expect(isOutboundSendSlug('mail-reader')).toBe(false);
    // The read sibling stays out — Tier-3 reads are pass-through (D-177 D7).
    expect(isOutboundSendSlug('connection-mcp-read')).toBe(false);
  });

  it('§5 — core- kernel aliases name the same sends', () => {
    expect(isOutboundSendSlug('core-mail-post')).toBe(true);
    expect(isOutboundSendSlug('core-slack-post')).toBe(true);
    expect(isOutboundSendSlug('core-notify-booking-visitor')).toBe(true);
    // A core- alias of a non-send slug is still not a send.
    expect(isOutboundSendSlug('core-ai-classify')).toBe(false);
  });

  it('the owner\'s chat and messenger chat take the same ceiling as automation; the app keeps the owner\'s', () => {
    expect(OWNER_CHAT_TRUST_CEILING).toBe('read');
    expect(resolveTrustCeiling(CHAT)).toBe('read');
    expect(resolveTrustCeiling(MESSENGER)).toBe('read');
    expect(resolveTrustCeiling(SCHEDULE)).toBe('read');
    expect(resolveTrustCeiling(USER)).toBe('admin');
  });

  it.each(SENDS)('"%s" asks in the owner\'s chat by its own approval, with no review lift', (slug) => {
    for (const source of [CHAT, MESSENGER]) {
      const decision = admit(slug, source);
      expect(decision.verdict).toBe('ask');
      if (decision.verdict !== 'ask') continue;
      // Risk tier preserved for audit — a send is a `write`, not reclassified.
      expect(decision.risk_tier).toBe('write');
      // Asked because its approval is `ask` and nothing relaxes it here: no lift marks it.
      expect(decision.authorization_provenance).toEqual({ pre_lift_approval: 'ask' });
      // ⛔ NO SEND NAMES ITS SLUG on the Reason line, which renders VERBATIM in the ask (owner,
      // 2026-10-19); it still says why in words.
      expect(decision.detail).not.toContain(slug);
      expect(decision.detail).toContain(
        slug === 'peer-ask' ? 'another server owner\'s screen' : 'someone outside this server');
    }
  });

  it.each(SENDS)('"%s" run by the owner from the app relaxes like every write: no name lifts it', (slug) => {
    expect(admit(slug, USER).verdict).toBe('admit');
  });

  it('a system actor\'s send follows its channel\'s ceiling: an admin-shell source admits', () => {
    expect(admit('mail-send', HOUSEKEEPING).verdict).toBe('admit');
  });

  it('D-209 §1.4 — a (schedule|reactive) system send HOLDS via the LOW ceiling', () => {
    for (const source of [SCHEDULE, REACTIVE]) {
      expect(admit('mail-send', source).verdict).toBe('ask');
    }
  });

  it('an internal write is no different: it asks in the chat and runs from the app', () => {
    expect(admit('annotation-create', CHAT, 'write').verdict).toBe('ask');
    expect(admit('annotation-create', USER, 'write').verdict).toBe('admit');
  });

  it('a read runs everywhere the owner is', () => {
    for (const source of [USER, CHAT, MESSENGER]) expect(admit('mail-reader', source, 'read').verdict).toBe('admit');
  });
});
