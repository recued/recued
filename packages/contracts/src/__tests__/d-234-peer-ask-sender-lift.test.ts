/** D-234 § 234.4o — ONE LEARNABLE ASK ON THE SENDER, BOTH ROUTES.
 *
 *  The owner ruling: `core.peer.ask` must raise a LEARNABLE approval on the
 *  ASKER's side, on `via: 'direct'` AND `via: 'recipe'` alike. Before it, the
 *  owner was asked ZERO times on the direct road — an owner-initiated run is
 *  contract-less and takes the `admin` ceiling, which admits `write` outright —
 *  and on the recipe road the one prompt belonged to the § 232 carrier's send
 *  rather than to the op-step.
 *
 *  🔑🔑 THE ROUTE DOES NOT APPEAR IN THIS FILE, AND THAT IS THE FINDING. The
 *  first cut of § 234.4o carried an 85-line `via`-aware lift so the recipe road
 *  would not double-prompt. The real defect was one layer down: the carrier's
 *  nested run was dispatched SOURCE-LESS, so it had no trust ceiling to relax
 *  its `write` (hence a second prompt) and no session-grant cell to make that
 *  prompt learnable (hence the only unlearnable approval in the feature). Once
 *  the carrier inherits the declaring run's `execution_source` — which the § 232
 *  exchange-fire carrier always did — `peer-ask` is a plain member of the
 *  outbound-send set and the roads converge.
 *
 *  ⇒ **Reach for a resolved-ARG policy lift only after checking whether the
 *  thing it routes around is a defect one level down.** This one was.
 *
 *  ⚠ The pairing that keeps that honest lives in the two-server drive, not here:
 *  a unit test cannot see the carrier's source. 8k / 8k2 assert the per-road
 *  prompt COUNT, and 8k2 additionally asserts the recipe road's prompt is the
 *  op-step's and carries `allow_session`. */

import { describe, expect, it } from 'vitest';

import {
  OUTBOUND_SEND_INGREDIENT_SLUGS,
  admitByOpRisk,
  isOutboundSendSlug,
  normalizePeerAskVia,
  resolveSessionGrantOffer,
  resolveTrustCeiling,
} from '../index.js';
import type { ExecutionSource } from '../index.js';

/** The kernel ingredient backing `core.peer.ask` (`kernel-op-registry.ts`). */
const PEER_ASK_SLUG = 'peer-ask';

/** The attended owner running their own recipe — the one cell the lift fires in.
 *  Contract-less, so `resolveTrustCeiling` gives `admin` and a `write` op-risk
 *  RELAXES to admit: without the lift there is no prompt at all, which is
 *  precisely the state § 234.4o was ruled on. */
const OWNER: ExecutionSource = {
  channel: 'user',
  actor: 'user_self',
  user_id: 'u',
  client_token_id: 't',
};

/** The owner asking through their own AI — a SEEDED session-grant cell, which is
 *  where `allow_session` is actually offered. */
const CHAT: ExecutionSource = {
  channel: 'chat',
  actor: 'user_self',
  chat_session_id: 's',
  user_id: 'u',
};

/** A DELEGATED peer token — contracted ⇒ the LOW ceiling, where a `write`
 *  op-risk already resolves `ask` on its own. */
const PEER: ExecutionSource = {
  channel: 'mcp',
  actor: 'contracted_user',
  contract_id: 'ctr_alice',
  mcp_token_id: 'tok_alice',
} as unknown as ExecutionSource;

/** Unattended automation — the LOW ceiling by channel (D-209 §1.4). */
const SCHEDULE: ExecutionSource = {
  channel: 'schedule',
  actor: 'system',
  cron: '0 9 * * 1-5',
  source_recipe: 'nightly-review',
};

const admit = (source: ExecutionSource, slug = PEER_ASK_SLUG) =>
  admitByOpRisk({
    slug,
    // The real manifest tier for `peer-ask` (`kernel-manifests.ts`).
    risk_tier: 'write',
    ceiling: resolveTrustCeiling(source),
    source,
  });

describe('§ 234.4o — asking a peer is an outbound send', () => {
  it('`peer-ask` is a member of the closed outbound-send set, alias included', () => {
    expect(OUTBOUND_SEND_INGREDIENT_SLUGS.has(PEER_ASK_SLUG)).toBe(true);
    expect(isOutboundSendSlug(PEER_ASK_SLUG)).toBe(true);
    // §5 — a `core-` kernel alias is the SAME send and must lift identically, or
    // the alias is a road around the gate.
    expect(isOutboundSendSlug('core-peer-ask')).toBe(true);
  });

  it('the owner is asked — on a run that would otherwise admit silently', () => {
    const d = admit(OWNER);
    // ⚠ `AdmissionDecision` is a DISCRIMINATED UNION and `expect().toBe()` does
    // not narrow it, so this needs the guard rather than a cast. A whole-object
    // `as` would silence exactly the check that catches a verdict that came back
    // `admit` — the failure this test exists for.
    if (d.verdict !== 'ask') throw new Error(`expected ask, got ${d.verdict}`);
    expect(d.risk_tier).toBe('write');
    expect(d.authorization_provenance?.lift_reason).toBe('review_send');
  });

  it('⛔ and it says WHOSE SCREEN, not "outside your trust boundary"', () => {
    // Prose only — the policy is the send lift's, unchanged. But the generic
    // sentence describes a MACHINE boundary, and what the owner is being asked
    // about is an interruption of another PERSON. The distinction is the whole
    // reason peer-ask keeps its own `detail` branch instead of taking the
    // send-set default.
    const d = admit(OWNER);
    if (d.verdict !== 'ask') throw new Error('expected ask');
    expect(d.detail).toContain('another server owner\'s screen');
    expect(d.detail).not.toContain('outside your trust boundary');
    // …and a real send still gets the generic wording.
    const send = admit(OWNER, 'mail-send');
    if (send.verdict !== 'ask') throw new Error('expected ask');
    expect(send.detail).toContain('outside your trust boundary');
  });
});

describe('§ 234.4o — the ask is LEARNABLE', () => {
  it('carries `pre_lift_approval: never`, which is what session eligibility reads', () => {
    // 🔑 THE LIFT IS WHY IT IS LEARNABLE, NOT AN OBSTACLE TO IT. `mintRawOp` /
    // `mint` (`session-grant-resolver.ts`) refuse to absorb anything whose
    // PRE-LIFT approval was not `never` / `ask` — an `always` ruling can never
    // become repeatable. A lifted peer-ask records the relaxed `never`
    // underneath, so `allow_session` may absorb it like any other op-step.
    const d = admit(OWNER);
    expect(d.authorization_provenance?.pre_lift_approval).toBe('never');
  });

  it('`allow_session` is OFFERED on the seeded attended cells', () => {
    // ⛔ THE HALF THAT WAS MISSING BEFORE THIS RULING WAS NOT THE LIFT, IT WAS
    // THE OFFER — and it went missing structurally: `resolveSessionGrantOffer`
    // is gated on the run having an `executionSource` at all, and the carrier's
    // nested run had none. That is why the fix had to reach the carrier rather
    // than stopping at the lift.
    const d = admit(CHAT);
    const offer = resolveSessionGrantOffer({
      channel: CHAT.channel,
      actor: CHAT.actor,
      risk_tier: 'write',
      pre_lift_approval: d.authorization_provenance?.pre_lift_approval,
    });
    expect(offer).toBeDefined();
    // ⚠ NOT offered on `(user, user_self)` — that cell seeds no session-grant
    // defaults. Pre-existing and product-wide, asserted so it reads as a known
    // property rather than as this feature failing.
    expect(resolveSessionGrantOffer({
      channel: OWNER.channel,
      actor: OWNER.actor,
      risk_tier: 'write',
      pre_lift_approval: 'never',
    })).toBeUndefined();
  });

  it('⚠ `never_ask` is NOT offered, and an owner override does NOT survive — as for EVERY send', () => {
    // 🔑 THE HONEST HALF OF "LEARNABLE", PINNED SO IT CANNOT CHANGE BY ACCIDENT.
    // `admitByOpRisk` mints an override offer only at `effective_risk_tier ===
    // 'read'`, and every review lift fires on the RELAXED verdict regardless of
    // a stored owner override.
    //
    // ⛔ KEEPING IT THAT WAY IS THE POINT, NOT AN OVERSIGHT. A suppressible lift
    // means one settings row restores "zero prompts for a question put on
    // another person's screen" — the state this ruling changed. The assertion
    // pairs peer-ask WITH mail-send so the two can only move together: if a
    // later change makes sends override-suppressible, this goes red and the
    // decision gets made deliberately.
    for (const slug of [PEER_ASK_SLUG, 'mail-send']) {
      const d = admitByOpRisk({
        slug,
        risk_tier: 'write',
        ceiling: resolveTrustCeiling(OWNER),
        source: OWNER,
        owner_override: { approval: 'never' },
      });
      if (d.verdict !== 'ask') throw new Error(`${slug}: expected ask, got ${d.verdict}`);
      expect(d.owner_override_offer).toBeUndefined();
    }
  });
});

describe('§ 234.4o — every other actor is held by its CEILING, not by this lift', () => {
  it('a delegated peer token already asks (contracted LOW ceiling)', () => {
    // 8k3's fence against ask-chaining, restated at the unit boundary: a peer
    // relaying a question through this server wearing its identity is asked
    // about by the CEILING, so the lift adds nothing and must not be the thing
    // that holds it.
    expect(resolveTrustCeiling(PEER)).toBe('read');
    expect(admit(PEER).verdict).toBe('ask');
  });

  it('unattended automation asks by channel', () => {
    expect(admit(SCHEDULE).verdict).toBe('ask');
  });
});

describe('§ 234.4o — the `via` normalizer, which no longer gates anything', () => {
  it('⛔⛔ all three spellings of unset mean `direct`', () => {
    // The shape the MANIFEST MERGE actually delivers. `peer-ask`'s manifest
    // spells an unset input `null` and `mergeManifestStepInput` lays defaults
    // UNDER the step args, so an un-annotated `via` arrives as `null` — never as
    // a missing key. An unset `{{config.*}}` picker arrives as `''`. Each has
    // cost this arc a live defect.
    //
    // ⚠ IT NO LONGER FEEDS A POLICY GATE — § 234.4o's route-aware lift is gone —
    // so this pins the DISPATCHER's coercion only. Kept because the three
    // spellings are a property of the boundary, not of any one reader.
    for (const via of [undefined, null, '']) expect(normalizePeerAskVia(via)).toBe('direct');
    expect(normalizePeerAskVia('direct')).toBe('direct');
    expect(normalizePeerAskVia('recipe')).toBe('recipe');
    // Present-and-unknown is `undefined`, NOT coerced — `validatePeerAskSpec`
    // refuses it as `via_unknown` rather than sending down a road the author
    // did not choose.
    expect(normalizePeerAskVia('dircet')).toBeUndefined();
  });
});
