/** D-234 § 234.4 — classifying a far door's reply to `sendPeerAnswerHome`.
 *
 *  ⛔⛔ THE DEFECT THIS REPLACES. The classification substring-matched `said` — our own
 *  `JSON.stringify` of the PEER'S response object — for `"accepted":true` and each refusal
 *  code. That search is depth-blind and field-blind, and `reason` is peer-supplied text
 *  (capped by `EXCHANGE_PEER_REASON_MAX` for exactly that reason). A peer whose reason
 *  merely QUOTED a code was read as a permanent refusal, and the owner's answered decision
 *  was DROPPED instead of retried — the losing direction.
 *
 *  ⚠ A2A v1.0 supplies the vocabulary: TERMINAL states (`COMPLETED` / `FAILED` /
 *  `CANCELED` / `REJECTED`) versus INTERRUPTED ones. Every declared refusal is terminal;
 *  an unrecognised reply is not.
 */

import { describe, expect, it } from 'vitest';

import {
  isPeerAnswerRefusal,
  PEER_ANSWER_REFUSALS,
  readPeerAnswerVerdict,
} from '../peer-answer-return.js';

describe('D-234 — a reply is read by FIELD, never by substring', () => {
  it('⛔⛔ PEER-SUPPLIED `reason` TEXT CANNOT FORGE A TERMINAL REFUSAL', () => {
    // THE regression. `{accepted:false, refusal:'unavailable', reason:'"not_solicited"'}`
    // serialises to a blob containing `"not_solicited"`, so the old check called it
    // permanent and threw the decision away. An unknown refusal must stay retryable.
    expect(readPeerAnswerVerdict({
      accepted: false, refusal: 'unavailable', reason: 'upstream said "not_solicited"',
    })).toEqual({ kind: 'unrecognised' });
  });

  it('⛔ AND CANNOT FORGE AN ACCEPTANCE', () => {
    expect(readPeerAnswerVerdict({
      accepted: false, refusal: 'wrong_peer', reason: 'expected {"accepted":true} earlier',
    })).toEqual({ kind: 'refused', refusal: 'wrong_peer' });
  });

  it('⛔ A NESTED `accepted` IS NOT THE VERDICT', () => {
    // The old match was depth-blind: any `"accepted":true` anywhere counted.
    expect(readPeerAnswerVerdict({ result: { accepted: true } })).toEqual({ kind: 'unrecognised' });
  });

  it('accepts only an exact `accepted === true`', () => {
    expect(readPeerAnswerVerdict({ accepted: true, resumed: true })).toEqual({ kind: 'accepted' });
    // ⛔ Truthy is not true — a `1` or a non-empty string would otherwise pass, which is
    // the same leniency this fix removes.
    for (const v of [1, 'true', {}, 'yes']) {
      expect(readPeerAnswerVerdict({ accepted: v }), String(v)).toEqual({ kind: 'unrecognised' });
    }
  });

  it('every DECLARED refusal is recognised, derived from the one list', () => {
    for (const refusal of PEER_ANSWER_REFUSALS) {
      expect(readPeerAnswerVerdict({ accepted: false, refusal }), refusal)
        .toEqual({ kind: 'refused', refusal });
    }
  });

  it('⛔⛔ AN UNKNOWN REFUSAL STAYS RETRYABLE — it must not be treated as terminal', () => {
    // A door that grew a new code, or a version skew. Treating it as permanent would
    // silently discard an owner decision that a later attempt could still deliver.
    expect(readPeerAnswerVerdict({ accepted: false, refusal: 'invented_later' }))
      .toEqual({ kind: 'unrecognised' });
  });

  it('a malformed or absent reply is unrecognised, not accepted', () => {
    for (const v of [null, undefined, 'ok', 42, []]) {
      expect(readPeerAnswerVerdict(v), String(v)).toEqual({ kind: 'unrecognised' });
    }
  });

  it('isPeerAnswerRefusal is exactly the declared set', () => {
    for (const r of PEER_ANSWER_REFUSALS) expect(isPeerAnswerRefusal(r)).toBe(true);
    for (const r of ['', 'accepted', 'not_solicited ', 'NOT_SOLICITED']) {
      expect(isPeerAnswerRefusal(r), r).toBe(false);
    }
  });
});
