/** D-234 § 234.2 — unsolicited faces the ceiling; solicited is admitted by our
 *  own record of having solicited it.
 *
 *  Pure rule only. Whether anything CALLS it is proven in the semi-live and the
 *  two-server drive — a rule tested alone says nothing about reachability, which
 *  this arc has now been caught by five times.
 */
import { describe, expect, it } from 'vitest';
import { isSolicitedReply, type ExchangeCorrelationRow } from '../source-primitive.js';

const PEER = 'ct_peer_alice';
const LANDING = 'peer-appointment-reply';

/** A run WE made when we opened the exchange — no contract id, because it was
 *  ours, and carrying the wire-name callback we declared. */
const ours = (over: Partial<ExchangeCorrelationRow> = {}): ExchangeCorrelationRow => ({
  recipe_id: 'request-peer-appointment',
  callback_op: `recued-core/${LANDING}`,
  expected_contract_id: PEER,
  ...over,
});

/** A run THEY caused — carries the calling peer's contract. */
const theirs = (over: Partial<ExchangeCorrelationRow> = {}): ExchangeCorrelationRow => ({
  recipe_id: 'peer-request-appointment',
  contract_id: PEER,
  ...over,
});

const ask = (rows: ExchangeCorrelationRow[], recipe_id = LANDING): boolean =>
  isSolicitedReply(rows, { recipe_id, caller_contract_id: PEER });

describe('D-234 § 234.2 — a reply we asked for', () => {
  it('✅ admits the callback we named, on an exchange we opened', () => {
    expect(ask([ours()])).toBe(true);
  });

  it('⛔ a ref we never opened admits nothing', () => {
    // The peer's ref is a LOOKUP KEY, never a credential — it is caller-supplied
    // by design so it can round-trip. Authority comes from our own rows.
    expect(ask([])).toBe(false);
  });

  it("⛔⛔ their own inbound run is not evidence that WE solicited them", () => {
    /** Without this, a peer who merely called us once could later cite their own
     *  run under the ref as proof we asked — bootstrapping themselves past the
     *  ceiling with nothing but their own traffic. */
    expect(ask([theirs({ callback_op: `recued-core/${LANDING}` })])).toBe(false);
  });

  it('⛔⛔ an exchange addressed to another peer does not admit this caller', () => {
    expect(ask([ours({ expected_contract_id: 'ct_peer_bob' })])).toBe(false);
    expect(ask([ours({ expected_contract_id: undefined })])).toBe(false);
  });

  it('⛔⛔ a ref alone does NOT admit any recipe they can reach', () => {
    /** THE REASON `exchange_callback_op` IS STAMPED. A ref says "this
     *  conversation exists"; it does not say "and this is where I told you to
     *  answer". Without the callback check, a peer holding any ref we opened
     *  could skip the entry ask for every recipe their contract reaches. */
    expect(ask([ours({ callback_op: undefined })])).toBe(false);
    expect(ask([ours()], 'some-other-recipe-they-can-reach')).toBe(false);
  });

  it('⛔ one solicitation admits ONE reply — a replay faces the ceiling', () => {
    expect(ask([ours(), { recipe_id: LANDING, contract_id: PEER }])).toBe(false);
  });

  it('✅ accepts either spelling of the callback — wire name or bare id', () => {
    /** The stamp is the WIRE NAME a recipe authors; audit rows carry the bare id.
     *  Comparing them raw silently answers "no" for a correct reply — the same
     *  normalization `deriveExchangeStatus` needed, for the same reason. */
    expect(ask([ours({ callback_op: `recued-core/${LANDING}` })])).toBe(true);
    expect(ask([ours({ callback_op: LANDING })])).toBe(true);
  });

  it('✅ our run mixed with theirs still correlates', () => {
    // The ordinary shape: both servers file under one ref.
    expect(ask([theirs(), ours()])).toBe(true);
  });
});
