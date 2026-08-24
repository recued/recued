/** `core.notification.send` is `read` and is NOT an outbound send (owner ruling
 *  2026-08-20).
 *
 *  🔑 THE RULE THE SET ACTUALLY ENCODES IS "DOES THE RECIPE AUTHOR A
 *  DESTINATION?" — not "does a packet leave the machine". Every remaining
 *  member takes a per-call target the owner needs to see before it goes
 *  (`mail-send`'s `to`, `slack-post`'s channel, `peer-ask`'s target server),
 *  and the lift exists to render exactly that. The notification op's input is
 *  `{channels, text, title, link_url}`: no address, no target. `channels` only
 *  NARROWS to endpoints the owner already enrolled and switched on, and the
 *  sole reader is the owner. There is nothing for a recipient review to show.
 *
 *  ⛔ AND THE GATE COST MORE THAN IT PROTECTED. The approval prompt is itself a
 *  notification, on the same channels, to the same person — so the owner got
 *  "recipe A wants to send you a notification, allow?" and then "recipe A: xxx".
 *  Two interruptions where the gate was meant to save one, the first carrying
 *  nothing the second lacks. A gate whose prompt costs what it protects trains
 *  approval-without-reading, which is a security LOSS.
 *
 *  This is the recipe-surface half of a ruling the RPC surface already had:
 *  D-177 N.12 kept `notification.send` a wire method on the same reasoning
 *  ("carries NO recipient … not a trust-bypass", `notification-handler.ts`).
 *  The two surfaces disagreed until now.
 */

import { describe, expect, it } from 'vitest';
import {
  KERNEL_OP_REGISTRY,
  OUTBOUND_SEND_INGREDIENT_SLUGS,
  admitByOpRisk,
  isOutboundSendSlug,
  resolveTrustCeiling,
  type ExecutionSource,
} from '../index.js';

const SLUG = 'core-notification-send';

const ownerWebclient: ExecutionSource = {
  channel: 'user', actor: 'user_self', user_id: 'local', client_token_id: 'tok',
} as ExecutionSource;
const ownerChat: ExecutionSource = {
  channel: 'chat', actor: 'user_self', chat_session_id: 's1', user_id: 'local',
} as ExecutionSource;
const cron: ExecutionSource = {
  channel: 'schedule', actor: 'system', cron: '0 9 * * *', source_recipe: 'nightly-digest',
} as ExecutionSource;
const autoRun: ExecutionSource = {
  channel: 'reactive', actor: 'system', event_kind: 'auto_run_tick', source_recipe: 'inbox-digest',
} as ExecutionSource;
const delegatedDoor: ExecutionSource = {
  channel: 'mcp', actor: 'contracted_user', agent_id: 'a', tool_call_id: 'c',
  mcp_token_id: 'http_door_token', contract_id: 'http_door_token',
} as ExecutionSource;

const verdictFor = (source: ExecutionSource, slug = SLUG, risk_tier = 'read' as const) =>
  admitByOpRisk({
    slug, risk_tier, ceiling: resolveTrustCeiling(source), source,
  }).verdict;

describe('the tier and the set, at their two declaration sites', () => {
  it('the kernel op is `read`', () => {
    const entry = KERNEL_OP_REGISTRY.find((e) => e.op === 'core.notification.send');
    expect(entry?.risk).toBe('read');
  });

  it('neither the bare slug nor its core- alias is an outbound send', () => {
    // ⚠ BOTH, deliberately. `isOutboundSendSlug` strips the `core-` prefix
    // before the membership test precisely so an alias cannot diverge from its
    // bare slug — a check on one proves nothing about the other.
    expect(OUTBOUND_SEND_INGREDIENT_SLUGS.has('notification-send')).toBe(false);
    expect(isOutboundSendSlug('notification-send')).toBe(false);
    expect(isOutboundSendSlug('core-notification-send')).toBe(false);
  });

  it('the slugs that DO author a recipient are untouched', () => {
    // The removal must not have widened into its neighbours.
    for (const slug of [
      'mail-send', 'mail-post', 'slack-post',
      'notify-booking-visitor', 'connection-mcp-write', 'peer-ask',
    ]) {
      expect(isOutboundSendSlug(slug), slug).toBe(true);
    }
  });
});

describe('no owner is ever asked for permission to notify that same owner', () => {
  it.each([
    ['owner webclient', ownerWebclient],
    ['owner chat', ownerChat],
    ['cron', cron],
    ['auto_run', autoRun],
  ] as const)('%s admits', (_name, source) => {
    expect(verdictFor(source)).toBe('admit');
  });

  it('⛔ BOTH HALVES ARE LOAD-BEARING — either alone leaves the defect', () => {
    // This is the assertion that stops someone "simplifying" the change back to
    // one edit. The lift is `user_self`-scoped and the ceiling is actor-scoped,
    // so the two halves fix DISJOINT cells and neither is redundant.
    //
    // Half A only (retier to `read`, still in the send set): the lift re-raises
    // it, so the ATTENDED owner is still asked — the double-notification the
    // ruling was about survives on webclient and chat.
    expect(
      admitByOpRisk({
        slug: 'mail-send', // a stand-in that IS still in the set
        risk_tier: 'read',
        ceiling: resolveTrustCeiling(ownerWebclient),
        source: ownerWebclient,
      }).verdict,
    ).toBe('ask');

    // Half B only (de-list, still `write`): the attended owner is freed, but a
    // contract-free `system` dispatch sits on the LOW `read` ceiling, so every
    // scheduled digest still holds — the case that hurts most.
    expect(verdictFor(cron, 'annotation-upsert', 'write' as never)).toBe('ask');
  });
});

describe('⚠ the consequence, pinned rather than discovered later', () => {
  it('a DELEGATED door granted this op also notifies without a per-call ask', () => {
    // `read` is never-class, so no ceiling gates it — including the LOW ceiling
    // a delegated door takes. STATED, NOT OVERLOOKED: the authorization for
    // this op is the endpoint SETUP, and there is nothing per-call to review
    // even for a door. Two fences still stand in front of it — Layer-1 access
    // requires the owner to have granted `core.notification.send` on that
    // door's contract, and `permission: notification_send` gates the install.
    //
    // ⇒ If a door must not be able to ring the owner's phone, REVOKE THE OP ON
    // THAT DOOR. Do not re-tier the op: that would put the double-notification
    // back on every recipe, which is the thing this ruling removed.
    expect(verdictFor(delegatedDoor)).toBe('admit');
  });

  it('and the tier is not more permissive than ops that already ship `read`', () => {
    // Calibration, so "read is too loose" can be argued against something real:
    // `core.ai.*` is `read` today and ships the owner's data to an EXTERNAL LLM
    // provider. A message to the owner's own enrolled Slack is strictly less
    // exposure than that.
    const ai = KERNEL_OP_REGISTRY.find((e) => e.op === 'core.ai.generate');
    expect(ai?.risk).toBe('read');
  });
});
