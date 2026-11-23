/** D-335 slice B — typing and clicking on a web page ask, like a send.
 *
 *  The owner's ruling was that the AI may act on pages "with ASK when write". Until
 *  2026-11-10 the owner's chat took the `admin` ceiling, where a `write` relaxes, so a
 *  by-name lift re-raised these to ask. D-177 §N.15.6 removed it: the owner's chat now
 *  takes the `read` ceiling, so a browser write asks there by its own approval, as every
 *  op does, and runs when the owner runs it from the app. A contracted AI app asks
 *  through its low ceiling. The end-to-end hold, with the element named on the ask, is
 *  `backend/server/src/__tests__/held-browser-target.test.ts`. */

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

describe('D-335 — a browser write follows its approval: it asks in the owner\'s chat', () => {
  it('names the kernel browser writes, alias included, and keeps them apart from sends', () => {
    for (const slug of ['dom-write', 'dom-click', 'dom-open', 'core-dom-click']) expect(isBrowserActionSlug(slug), slug).toBe(true);
    expect(isBrowserActionSlug('dom-inspect')).toBe(false);
    expect(isOutboundSendSlug('dom-click')).toBe(false);
  });

  it('asks in the chat by its approval, with no review lift', () => {
    expect(resolveTrustCeiling(CHAT)).toBe('read');
    for (const slug of ['dom-write', 'dom-click', 'dom-open']) {
      const decision = admit(CHAT, slug);
      if (decision.verdict !== 'ask') throw new Error(`${slug}: expected ask, got ${decision.verdict}`);
      expect(decision.detail).toBe('This acts on a web page in your browser, signed in as you, so Recued asks you first.');
      expect(decision.authorization_provenance).toEqual({ pre_lift_approval: 'ask' });
    }
  });

  it('runs when the owner runs it from the app, like every write', () => {
    expect(resolveTrustCeiling(APP)).toBe('admin');
    for (const slug of ['dom-write', 'dom-click', 'dom-open']) expect(admit(APP, slug).verdict, slug).toBe('admit');
  });

  // Slice F lets the owner allow a site for a session; the ask must stay learnable.
  it('stays learnable: allow_session is offered in the chat', () => {
    const decision = admit(CHAT, 'dom-click');
    expect(resolveSessionGrantOffer({ channel: CHAT.channel, actor: CHAT.actor, risk_tier: 'write',
      pre_lift_approval: decision.authorization_provenance?.pre_lift_approval })).toBeDefined();
  });

  it('in the chat an owner\'s "never" does not silence it: a write is never below ask (D-209 §1.3)', () => {
    expect(admit(CHAT, 'dom-click', 'write', 'never').verdict).toBe('ask');
  });

  it('a read never asks, and a contracted AI app asks by its own ceiling', () => {
    expect(admit(CHAT, 'dom-inspect', 'read').verdict).toBe('admit');
    expect(admit(CHAT, 'dom-tabs', 'read').verdict).toBe('admit');
    expect(admit(APP_AI, 'dom-click').verdict).toBe('ask');
  });
});
