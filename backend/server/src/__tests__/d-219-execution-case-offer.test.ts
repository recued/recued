/** D-219 slice 6b-ii — the owner-facing offer.
 *
 *  The recording rpc has existed since D-214 and nothing has ever offered the
 *  choice, so after slices 2–4 the corpus stays empty by design. These pin the
 *  decision and the raised payload; boot wiring is deferred, as with
 *  `pingReceptionInbox`.
 */

import { describe, expect, it } from 'vitest';

import {
  decideExecutionCaseOffer,
  offerExecutionCase,
  EXECUTION_CASE_OFFER_ASK_KIND,
  type RaiseExecutionCaseOfferAsk,
} from '../execution-case-offer.js';
import {
  deriveExecutionFlowPattern,
  type CaseSourceObservation,
} from '../execution-case-core.js';

const observation = (
  over: Partial<CaseSourceObservation> = {},
): CaseSourceObservation => ({
  observation_id: 'obs-1',
  report_id: 'report-1',
  root_request_id: 'root-1',
  session_id: 'session-1',
  root_request: 'send Wren the quarterly review and log it',
  governing_contract_id: 'owner',
  principal_key: 'user_self',
  compiler_version: 1,
  policy_fingerprint: 'policy-a',
  request_shape: {
    schema_version: 1,
    locale_candidates: ['en'],
    surface_terms: ['send', 'quarterly', 'review'],
    segmented_terms: ['send', 'quarterly', 'review'],
    entity_slots: [],
    intent_facets: ['send the quarterly review'],
    constraint_facets: ['send'],
    risk_facets: [],
  },
  flow_pattern: deriveExecutionFlowPattern([
    { tool_name: 'acme/invoice-book', risk_tier: 'write', tier: 2, round_index: 0 },
    { tool_name: 'acme/ledger-post', risk_tier: 'write', tier: 2, round_index: 1 },
    { tool_name: 'mail.send', risk_tier: 'write', tier: 2, round_index: 2 },
  ]),
  flow_basis: 'executed',
  outcome: {
    model_claim: 'fulfilled',
    authorization: 'allowed',
    execution: 'succeeded',
    verification: 'unavailable',
    feedback: 'unknown',
  },
  evidence_kinds: ['model_claim'],
  failure_codes: [],
  substantive_call_count: 2,
  span_closed: true,
  intent_drifted: false,
  consulted_case_keys: [],
  observed_at: 1_000,
  proposed: true,
  plan_accepted: true,
  plan_declined: false,
  executed: true,
  ...over,
});

const keyOf = (o: CaseSourceObservation): string => `key:${o.root_request_id}`;
const NONE: ReadonlySet<string> = new Set();

/** Records what was raised, so the payload can be asserted rather than assumed. */
const recorder = () => {
  const calls: Array<Parameters<RaiseExecutionCaseOfferAsk>> = [];
  const raise: RaiseExecutionCaseOfferAsk = async (...args) => {
    calls.push(args);
    return { ask_id: `ask-${calls.length}` };
  };
  return { calls, raise };
};

describe('D-219 slice 6b-ii — asking the owner', () => {
  it('asks about a fresh candidate, offering only verdicts that would file', () => {
    const d = decideExecutionCaseOffer(observation(), NONE, keyOf);
    expect(d.ask).toBe(true);
    // Two DISTINCT calls, outcome consistent with acceptance → all four.
    expect(d.verdicts).toEqual(['accepted', 'corrected', 'rejected', 'undone']);
  });

  it('does NOT ask when a case already covers the shape', () => {
    // The rate limiter, and it is principled rather than a cadence: answering
    // again changes nothing, so the interruption buys nothing.
    const o = observation();
    const d = decideExecutionCaseOffer(o, new Set([keyOf(o)]), keyOf);
    expect(d.ask).toBe(false);
    expect(d.reason).toBe('already_covered');
    // ⚠ …and the verdicts are still reported. "Already covered" is a different
    // fact from "not worth asking about", and a diagnostic must tell them apart.
    expect(d.verdicts.length).toBeGreaterThan(0);
  });

  it('does NOT ask about a turn the substrate would refuse to learn from', () => {
    // Every D-219 exclusion reaches here through one predicate rather than being
    // restated: a breakage is not a lesson, a repeat is a retry, one call is not
    // a procedure.
    for (const [label, over] of [
      ['a breakage', { evidence_kinds: ['execution_failure'] as never }],
      ['a denial', { evidence_kinds: ['gateway_denial'] as never }],
      ['a single call', {
        substantive_call_count: 1,
        flow_pattern: deriveExecutionFlowPattern([
          { tool_name: 'acme/invoice-book', risk_tier: 'write', tier: 2, round_index: 0 },
        ]),
      }],
      ['a repeated tool', {
        flow_pattern: deriveExecutionFlowPattern([
          { tool_name: 'acme/ledger-post', risk_tier: 'write', tier: 2, round_index: 1 },
          { tool_name: 'mail.send', risk_tier: 'write', tier: 2, round_index: 2 },
        ]),
      }],
      ['an unclosed span', { span_closed: false }],
    ] as Array<[string, Partial<CaseSourceObservation>]>) {
      const d = decideExecutionCaseOffer(observation(over), NONE, keyOf);
      expect(d.ask, `${label} should not be asked about`).toBe(false);
      expect(d.reason).toBe('not_a_candidate');
    }
  });

  it('DOES ask about a chain that repeats `tools.search` — discovery is not a retry', () => {
    // Amendment 2026-08-18. Under the shipped catalog default (`lean-core` on
    // every source) a recipe entry is absent from the packet entirely, so the
    // ONLY route to a second Tier-2 recipe is a second `tools.search`. Counting
    // that as a repeat made the gate contradict the catalog mode: the deeper the
    // procedure, the more certainly it was excluded — and depth is what V22 asks
    // for.
    const d = decideExecutionCaseOffer(
      observation({
        // The realistic lean-core shape: one discovery per recipe the model
        // did not already know. THREE distinct non-core rounds, which is what
        // `EXECUTION_CASE_MIN_DISTINCT_ROUNDS` asks for — and three
        // `tools.search` calls, which is what used to refuse it.
        flow_pattern: deriveExecutionFlowPattern([
          { tool_name: 'tools.search', risk_tier: 'read', tier: 1, round_index: 0 },
          { tool_name: 'acme/list-buildings', risk_tier: 'read', tier: 2, round_index: 1 },
          { tool_name: 'tools.search', risk_tier: 'read', tier: 1, round_index: 2 },
          { tool_name: 'acme/add-unit', risk_tier: 'write', tier: 2, round_index: 3 },
          { tool_name: 'tools.search', risk_tier: 'read', tier: 1, round_index: 4 },
          { tool_name: 'acme/open-rental-contract', risk_tier: 'write', tier: 2, round_index: 5 },
        ]),
      }),
      NONE,
      keyOf,
    );
    expect(d.ask, 'a thrice-discovered three-recipe chain should still be offerable').toBe(true);
  });

  it('⛔ the exemption is BY NAME — a repeated data search is still a retry', () => {
    // The mutation-killer for the test above. `[mail.search, send, mail.search,
    // send]` is the shape slice 8 measured and refused; exempting Tier 1 as a
    // CLASS rather than `tools.search` by name would re-admit it, and this test
    // is the only thing standing between those two one-line implementations.
    const d = decideExecutionCaseOffer(
      observation({
        flow_pattern: deriveExecutionFlowPattern([
          { tool_name: 'mail.search', risk_tier: 'read', tier: 1, round_index: 0 },
          { tool_name: 'acme/ledger-post', risk_tier: 'write', tier: 2, round_index: 1 },
          { tool_name: 'mail.search', risk_tier: 'read', tier: 1, round_index: 2 },
        ]),
      }),
      NONE,
      keyOf,
    );
    expect(d.ask, 'a repeated DATA search is still floundering').toBe(false);
    expect(d.reason).toBe('not_a_candidate');
  });

  it('⛔ never quotes the request back — the ask can reach Slack or Telegram', async () => {
    // `root_request` is raw owner text and a notification channel may be remote.
    // The turn is identified by what it DID — a closed vocabulary of tool names.
    const r = recorder();
    const o = observation({
      root_request: 'email dominic@example.com the salary review for Wren',
    });
    await offerExecutionCase(r.raise, o, decideExecutionCaseOffer(o, NONE, keyOf), 'turn-1');
    const raised = JSON.stringify(r.calls[0]);
    expect(raised).not.toContain('@');
    expect(raised).not.toContain('salary');
    expect(raised).not.toContain('Wren');
  });

  it('raises one ask carrying the offered verdicts as options', async () => {
    const r = recorder();
    const o = observation();
    const id = await offerExecutionCase(r.raise, o, decideExecutionCaseOffer(o, NONE, keyOf), 'turn-1');
    expect(id).toEqual({ ask_id: 'ask-1' });
    expect(r.calls).toHaveLength(1);
    const [message, options, handler] = r.calls[0]!;
    expect(message.title).toBe('Worth remembering?');
    expect(options.map((x) => x.id))
      .toEqual(['accepted', 'corrected', 'rejected', 'undone']);
    // Every option is LABELLED — an id rendered raw would read as machinery.
    for (const option of options) expect(option.label.length).toBeGreaterThan(0);
    expect(handler.kind).toBe(EXECUTION_CASE_OFFER_ASK_KIND);
    expect(handler.payload).toMatchObject({
      session_id: 'session-1',
      observation_id: 'obs-1',
      // ⚠ D-219 slice 9c — the TURN, asserted because the whole answer route
      // depends on it: `chat.execution.feedback` names an anchored turn and
      // resolves the span root itself, so an ask raised without one is an ask
      // whose answer can never be recorded.
      turn_id: 'turn-1',
    });
  });

  it('raises NOTHING when the decision said no', async () => {
    // So a caller can hand every closed turn here without pre-filtering, and the
    // decision stays the single place the policy lives.
    const r = recorder();
    const o = observation({ span_closed: false });
    const id = await offerExecutionCase(r.raise, o, decideExecutionCaseOffer(o, NONE, keyOf), 'turn-1');
    expect(id).toBeNull();
    expect(r.calls).toHaveLength(0);
  });
});
