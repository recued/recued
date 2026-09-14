/** D-148 § A.7.2 — `/mcp.public` acknowledgement modal renderer (W3.8).
 *
 *  AI-agent ingress (MCP) is a structurally riskier exposure class
 *  than human-WS / vendor-webhook — prompt-injection surface,
 *  per-pair token scoping, different rate-limit posture. The spec
 *  gates flipping `resolution.mcp.public === true` behind a free-text
 *  confirmation phrase: the user must type the literal string
 *  `enable public MCP`. A checkbox would normalize the gesture; the
 *  phrase keeps it deliberate.
 *
 *  This module is the modal renderer + the per-flow state machine.
 *  It does NOT fire the rpc; it shapes the payload and validates the
 *  typed phrase locally so the UI gives immediate feedback. The
 *  server is still authoritative (the same phrase-validator runs in
 *  the exposure state machine).
 *
 *  Modal kinds:
 *    - `acknowledge` — user is enabling public MCP; modal explains
 *      the risk + collects the phrase.
 *    - `revoke` — user is disabling a previously-acknowledged state;
 *      no phrase needed (demotion is always allowed per § A.7.2).
 *
 *  Modal states:
 *    - `idle` — modal closed
 *    - `open` — modal rendered; user is reading the explanation +
 *      typing the phrase
 *    - `submitting` — rpc in flight; submit button disabled
 *    - `error` — rpc rejected (e.g., phrase mismatch); user can
 *      correct + retry
 */

import {
  PUBLIC_MCP_ACKNOWLEDGEMENT_PHRASE,
  isAcknowledgementWellFormed,
  isValidPublicMcpAcknowledgementPhrase,
  type NetworkErrorCode,
  type PublicMcpAcknowledgement,
} from '@recued/contracts';
import { buildPublicMcpDispatch, type ExposurePublicMcpDispatch } from './exposure-surface.js';

/** Modal kind — distinguishes the enable flow (phrase required) from
 *  the revoke flow (no phrase). */
export type PublicMcpModalKind = 'acknowledge' | 'revoke';

/** Modal state — one discriminated value per UI phase. */
export type PublicMcpModalState =
  | { kind: 'idle' }
  | {
      kind: 'open';
      mode: PublicMcpModalKind;
      typed_phrase: string;
      /** True iff `typed_phrase` matches the canonical literal exactly
       *  (whitespace-insensitive at edges). Drives the submit button's
       *  enabled state. */
      phrase_valid: boolean;
    }
  | {
      kind: 'submitting';
      mode: PublicMcpModalKind;
      typed_phrase: string;
    }
  | {
      kind: 'error';
      mode: PublicMcpModalKind;
      typed_phrase: string;
      error: NetworkErrorCode;
    };

/** Modal copy. Bullet list mirrors the spec § A.7.2 flow (a-e). */
export const PUBLIC_MCP_MODAL_COPY = {
  acknowledge: {
    title: 'Let AI apps in from outside?',
    // ⛔⛔ THIS IS CONSENT COPY, SO A STALE MECHANISM HERE IS NOT DOC DRIFT —
    // the owner types an exact phrase on the strength of this explanation, and
    // a wrong description makes the informed half of informed consent false.
    //
    // What it used to say, and why each line went:
    //   · "AI agents … can read warehouse topics scoped to the granted MCP
    //     token" — the token binds a `contract_id`; the SCOPE lives on the
    //     contract, not the token.
    //   · "Per-pair MCP visibility tokens (D-137) gate which topics are
    //     exposed" — false since D-187. `read-grant-checker.ts:137`: a topic is
    //     read-granted by an explicit `enrichment.<topic>` grant row resolved
    //     AGAINST THE BOUND CONTRACT. The copy named the thing that replaced it.
    //
    // 🔑 And the framing correction underneath both: this switch decides
    // REACHABILITY (whether the MCP port binds beyond the LAN — D-148 P6 § A.7),
    // never authorization. Nothing in the dispatch path reads the
    // acknowledgement. Saying "agents reach MCP after acknowledgement" invited
    // exactly the misreading that this is an access grant.
    subtitle:
      'This opens the door beyond your own network. What an AI app may then do is '
      + 'set by its agreement, not by this switch.',
    bullets: [
      'AI apps anywhere can reach the door. Every single thing they ask for is still checked against '
        + 'their agreement: what they may do, and what they may read.',
      'There is a real risk here. Whatever an AI app reads can push it around, '
        + 'and its agreement is what limits how far that can go.',
      'Contract grants decide what is exposed: `enrichment.<topic>` per topic, '
        + '`data.<collection>` per collection, resolved against the bound contract.',
      'We suggest keeping this to your own network, unless you really need it open.',
    ],
    phrase_prompt: `Type "${PUBLIC_MCP_ACKNOWLEDGEMENT_PHRASE}" to confirm`,
    submit_label: 'I understand. Let AI apps in',
    cancel_label: 'Cancel, and keep it to my own network',
  },
  revoke: {
    title: 'Shut AI apps out again?',
    subtitle:
      'This forgets that you agreed, and shuts the door. You can always make things safer, with no fuss.',
    bullets: [
      'Recued writes down that you took your agreement back.',
      'AI apps from outside your network will be turned away at the door.',
      'You can agree again later by typing the phrase.',
    ],
    phrase_prompt: '',
    submit_label: 'Take my agreement back',
    cancel_label: 'Cancel, and leave it open',
  },
} as const;

export const openPublicMcpModal = (mode: PublicMcpModalKind): PublicMcpModalState => ({
  kind: 'open',
  mode,
  typed_phrase: '',
  phrase_valid: mode === 'revoke',
});

/** Type a character (or paste a longer string) into the phrase field.
 *  Recomputes `phrase_valid` against the canonical literal.
 *
 *  Codex W3.8 P2 #2 fold — typing on `'error'` transitions back to
 *  `'open'` so the user can correct a rejected phrase without
 *  re-opening the modal. The substrate's `failPublicMcpModal` parks
 *  the state in `'error'` after an rpc rejection; without this branch
 *  the field would become read-only + `submitPublicMcpModal` would
 *  reject the retry, dead-ending the documented retry path. */
export const typePublicMcpPhrase = (
  state: PublicMcpModalState,
  next_phrase: string,
): PublicMcpModalState => {
  if (state.kind !== 'open' && state.kind !== 'error') return state;
  if (state.mode === 'revoke') {
    return {
      kind: 'open',
      mode: state.mode,
      typed_phrase: next_phrase,
      phrase_valid: true,
    };
  }
  return {
    kind: 'open',
    mode: state.mode,
    typed_phrase: next_phrase,
    phrase_valid: isValidPublicMcpAcknowledgementPhrase(next_phrase),
  };
};

export const closePublicMcpModal = (): PublicMcpModalState => ({ kind: 'idle' });

/** Submit attempt — produces either the dispatch + the next state OR
 *  a local-error result (e.g. typed phrase still invalid). Surfacing
 *  the local error keeps the rpc round-trip short-circuited. */
export type PublicMcpSubmitOutcome =
  | {
      ok: true;
      dispatch: ExposurePublicMcpDispatch;
      next: PublicMcpModalState;
    }
  | { ok: false; error: 'phrase_required' | 'phrase_mismatch' };

export const submitPublicMcpModal = (
  state: PublicMcpModalState,
  args: { reason?: string } = {},
): PublicMcpSubmitOutcome => {
  if (state.kind !== 'open') {
    return { ok: false, error: 'phrase_required' };
  }
  if (state.mode === 'acknowledge') {
    if (state.typed_phrase.trim().length === 0) {
      return { ok: false, error: 'phrase_required' };
    }
    if (!state.phrase_valid) {
      return { ok: false, error: 'phrase_mismatch' };
    }
    const dispatch = buildPublicMcpDispatch({
      acknowledge: true,
      free_text_confirmation: state.typed_phrase,
      ...(args.reason !== undefined ? { reason: args.reason } : {}),
    });
    return {
      ok: true,
      dispatch,
      next: { kind: 'submitting', mode: state.mode, typed_phrase: state.typed_phrase },
    };
  }
  const dispatch = buildPublicMcpDispatch({
    acknowledge: false,
    ...(args.reason !== undefined ? { reason: args.reason } : {}),
  });
  return {
    ok: true,
    dispatch,
    next: { kind: 'submitting', mode: state.mode, typed_phrase: state.typed_phrase },
  };
};

/** Move the modal into the error state after an rpc rejection. */
export const failPublicMcpModal = (
  state: PublicMcpModalState,
  error: NetworkErrorCode,
): PublicMcpModalState => {
  if (state.kind !== 'submitting' && state.kind !== 'open') return state;
  return {
    kind: 'error',
    mode: state.mode,
    typed_phrase: state.typed_phrase,
    error,
  };
};

/** True iff the live `PublicMcpAcknowledgement` is currently valid (per
 *  the contracts predicate). Used by the page-shell to pick which
 *  modal mode to open on the "Manage public MCP" button. */
export const isPublicMcpAcknowledgementActive = (
  ack: PublicMcpAcknowledgement,
): boolean => ack.acknowledged && isAcknowledgementWellFormed(ack);

export { PUBLIC_MCP_ACKNOWLEDGEMENT_PHRASE };
