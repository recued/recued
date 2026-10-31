/** D-335 slice B — typing and clicking on a web page ask, like a send.
 *
 *  The owner's ruling was that the AI may act on pages "with ASK when write".
 *  The owner's own chat is contract-less, so it takes the `admin` ceiling, and
 *  there a `write` op relaxes to admit: before this lift a toolkit click driven
 *  by the owner's chat ran with no ask at all. A contracted AI app already
 *  asked, through its low ceiling. The end-to-end hold, with the element named
 *  on the ask, is `backend/server/src/__tests__/held-browser-target.test.ts`. */

import { describe, expect, it } from 'vitest';

import {
  admitByOpRisk,
  isBrowserActionSlug,
  isOutboundSendSlug,
  resolveSessionGrantOffer,
  resolveTrustCeiling,
} from '../index.js';
import type { ExecutionSource, RiskTier } from '../index.js';

const CHAT: ExecutionSource = { channel: 'chat', actor: 'user_self', chat_session_id: 's', user_id: 'u' };
const APP: ExecutionSource = { channel: 'user', actor: 'user_self', user_id: 'u', client_token_id: 't' };
const APP_AI: ExecutionSource = {
  channel: 'mcp', actor: 'contracted_user', contract_id: 'ctr_app', mcp_token_id: 'tok_app',
} as unknown as ExecutionSource;

const admit = (source: ExecutionSource, slug: string, risk_tier: RiskTier = 'write', approval?: 'never') =>
  admitByOpRisk({ slug, risk_tier, ceiling: resolveTrustCeiling(source), source,
    ...(approval !== undefined ? { owner_override: { approval } } : {}) });

describe('D-335 — a browser write asks, wherever the owner drives it from', () => {
  it('names the kernel browser writes, alias included, and keeps them apart from sends', () => {
    for (const slug of ['dom-write', 'dom-click', 'dom-open', 'core-dom-click']) expect(isBrowserActionSlug(slug), slug).toBe(true);
    expect(isBrowserActionSlug('dom-inspect')).toBe(false);
    expect(isOutboundSendSlug('dom-click')).toBe(false);
  });

  it.each([['the chat', CHAT], ['the app', APP]] as const)('asks in %s, where the owner ceiling would admit it', (_label, source) => {
    expect(resolveTrustCeiling(source)).toBe('admin');
    for (const slug of ['dom-write', 'dom-click', 'dom-open']) {
      const decision = admit(source, slug);
      if (decision.verdict !== 'ask') throw new Error(`${slug}: expected ask, got ${decision.verdict}`);
      expect(decision.detail).toBe('This acts on a web page in your browser, signed in as you, so Recued always asks you first.');
      expect(decision.authorization_provenance?.lift_reason).toBe('review_send');
    }
  });

  // Slice F lets the owner allow a site for a session; the ask must stay learnable.
  it('stays learnable: allow_session is offered in the chat', () => {
    const decision = admit(CHAT, 'dom-click');
    expect(resolveSessionGrantOffer({ channel: CHAT.channel, actor: CHAT.actor, risk_tier: 'write',
      pre_lift_approval: decision.authorization_provenance?.pre_lift_approval })).toBeDefined();
  });

  it('an owner override does not silence it, as it does not silence a send', () => {
    expect(admit(APP, 'dom-click', 'write', 'never').verdict).toBe('ask');
  });

  it('a read never asks, and a contracted AI app asks by its own ceiling', () => {
    expect(admit(CHAT, 'dom-inspect', 'read').verdict).toBe('admit');
    expect(admit(CHAT, 'dom-tabs', 'read').verdict).toBe('admit');
    expect(admit(APP_AI, 'dom-click').verdict).toBe('ask');
  });
});
