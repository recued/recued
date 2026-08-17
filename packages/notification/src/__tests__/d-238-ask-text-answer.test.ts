/** D-238 — typed answers for a channel that cannot render buttons.
 *
 *  ⛔⛔ Most of this file asserts what the matcher REFUSES. That is deliberate:
 *  the failure available here is approving something the owner did not approve,
 *  and every refusal below is a specific way a "helpful" matcher would cause it.
 *  A suite that only proved `"approve"` works would pass against an
 *  implementation that also accepts `"yeah ok"` in an unrelated conversation. */

import { describe, expect, it } from 'vitest';

import {
  matchTextAnswer,
  normalizeAnswerText,
  renderAnswerHint,
  type OpenAsk,
} from '../ask-text-answer.js';

const APPROVE_DENY: OpenAsk = {
  ask_id: 'ask-1',
  options: [
    { id: 'approve', label: 'Approve' },
    { id: 'deny', label: 'Deny' },
  ],
};

const one = [APPROVE_DENY];

describe('normalizeAnswerText', () => {
  it('folds case, surrounding space, and trailing sentence punctuation', () => {
    expect(normalizeAnswerText('  Approve.  ')).toBe('approve');
    expect(normalizeAnswerText('DENY!')).toBe('deny');
    expect(normalizeAnswerText('Approve?')).toBe('approve');
  });

  it('collapses internal whitespace runs but does not remove words', () => {
    expect(normalizeAnswerText('send   it')).toBe('send it');
  });

  /** A LEADING character is not noise — `!approve` is a command shape this
   *  matcher does not claim, and silently accepting it would mean answering a
   *  message the owner may have aimed at some other bot in the chat. */
  it('leaves a leading marker alone', () => {
    expect(normalizeAnswerText('!approve')).toBe('!approve');
  });
});

describe('matchTextAnswer — what it accepts', () => {
  it('answers on the option label, typed alone', () => {
    expect(matchTextAnswer('Approve', one)).toEqual({
      kind: 'answer', ask_id: 'ask-1', option: 'approve',
    });
  });

  /** ⛔ Matching is on the LABEL; the id is what comes back. Here they happen to
   *  differ only in case, so the sibling refusal below is what proves the rule. */
  it('returns the option ID while matching on the label', () => {
    expect(matchTextAnswer('Deny', one)).toEqual({
      kind: 'answer', ask_id: 'ask-1', option: 'deny',
    });
  });

  /** ⛔ An internal id is rendered NOWHERE the owner can see. Accepting one means
   *  accepting a token they were never shown — and if an id were ever `yes` or
   *  `ok`, ordinary chatter would settle approvals through a door nobody knew
   *  existed. */
  it('refuses an internal option id that is not also a label', () => {
    const hidden: OpenAsk = {
      ask_id: 'ask-9',
      options: [
        { id: 'yes', label: 'Send the invoice' },
        { id: 'no', label: 'Hold it' },
      ],
    };
    expect(matchTextAnswer('yes', [hidden])).toEqual({ kind: 'ignored', reason: 'no_match' });
    expect(matchTextAnswer('no', [hidden])).toEqual({ kind: 'ignored', reason: 'no_match' });
    // The label still works, and still returns the id.
    expect(matchTextAnswer('Hold it', [hidden])).toEqual({
      kind: 'answer', ask_id: 'ask-9', option: 'no',
    });
  });

  it('answers on a 1-based position, the way a person answers a list', () => {
    expect(matchTextAnswer('1', one)).toEqual({
      kind: 'answer', ask_id: 'ask-1', option: 'approve',
    });
    expect(matchTextAnswer('2', one)).toEqual({
      kind: 'answer', ask_id: 'ask-1', option: 'deny',
    });
  });

  it('tolerates the punctuation a person actually types', () => {
    expect(matchTextAnswer('  approve.  ', one)).toMatchObject({ kind: 'answer' });
  });
});

describe('renderAnswerHint — what is SHOWN is what is ACCEPTED', () => {
  it('numbers the options, which is what earns positional matching', () => {
    expect(renderAnswerHint(APPROVE_DENY.options)).toBe('Reply with: 1 = Approve, 2 = Deny');
  });

  it('renders nothing for an ask with no options', () => {
    expect(renderAnswerHint([])).toBe('');
  });

  /** ⛔ THE INVARIANT, asserted in both directions. Every token the hint shows
   *  must be accepted, and the matcher must accept nothing the hint does not
   *  show. An unnumbered hint plus positional matching is exactly the defect
   *  this pairing exists to prevent. */
  it('every token it renders is accepted, and nothing else is', () => {
    const hint = renderAnswerHint(APPROVE_DENY.options);
    // Shown ⇒ accepted.
    for (const shown of ['1', '2', 'Approve', 'Deny']) {
      expect(hint).toContain(shown);
      expect(matchTextAnswer(shown, one)).toMatchObject({ kind: 'answer' });
    }
    // Not shown ⇒ refused. The ids happen to equal the lowercased labels here,
    // so the probe uses tokens that are genuinely absent from the line.
    for (const notShown of ['3', '0', 'yes', 'ok']) {
      expect(hint).not.toContain(notShown);
      expect(matchTextAnswer(notShown, one)).toMatchObject({ kind: 'ignored' });
    }
  });
});

describe('matchTextAnswer — what it REFUSES, and why', () => {
  /** ⛔ The single most dangerous widening available. `yes` / `ok` / `sure` are
   *  the most common words in a chat, and the owner is talking to PEOPLE in the
   *  same conversation. A synonym list is how "yeah ok" becomes an approval. */
  it('refuses affirmations — no synonym list, ever', () => {
    for (const text of ['yes', 'y', 'ok', 'okay', 'sure', 'yep', 'do it', '👍']) {
      expect(matchTextAnswer(text, one)).toEqual({ kind: 'ignored', reason: 'no_match' });
    }
  });

  /** ⛔ The option word inside a sentence is CONVERSATION, not an act. This is
   *  what makes typing safe at all: the owner has to send the option alone. */
  it('refuses the option word embedded in a sentence', () => {
    for (const text of [
      'I think we should approve this',
      'approve it',
      'do not approve',
      'why would I deny that',
    ]) {
      expect(matchTextAnswer(text, one)).toEqual({ kind: 'ignored', reason: 'no_match' });
    }
  });

  /** ⛔ "do not approve" above is the one that matters most: a substring matcher
   *  reads it as APPROVE — the exact inversion of what was typed. Pinned
   *  separately so nobody relaxes the rule without meeting it. */
  it('never reads a NEGATED option as that option', () => {
    expect(matchTextAnswer('do not approve', one)).not.toMatchObject({ kind: 'answer' });
    expect(matchTextAnswer("don't approve", one)).not.toMatchObject({ kind: 'answer' });
  });

  it('refuses when nothing is open — the channel is mostly conversation', () => {
    expect(matchTextAnswer('approve', [])).toEqual({
      kind: 'ignored', reason: 'no_open_ask',
    });
  });

  /** ⛔ Two asks open, and a chat message carries no signal saying which it
   *  answers — Graph gives `replyToId` only for channel threads, never a 1:1
   *  chat. Picking the newer would silently approve the wrong thing. */
  it('refuses to guess between two open asks', () => {
    const two = [APPROVE_DENY, { ...APPROVE_DENY, ask_id: 'ask-2' }];
    expect(matchTextAnswer('approve', two)).toEqual({
      kind: 'ignored', reason: 'ambiguous_ask',
    });
  });

  it('refuses when the text matches two options rather than picking one', () => {
    const collide: OpenAsk = {
      ask_id: 'ask-3',
      options: [
        { id: 'send', label: 'Send' },
        // A different option whose LABEL collides with the first one's id.
        { id: 'resend', label: 'send' },
      ],
    };
    expect(matchTextAnswer('send', [collide])).toEqual({
      kind: 'ignored', reason: 'ambiguous_option',
    });
  });

  it('refuses an out-of-range position rather than clamping it', () => {
    expect(matchTextAnswer('3', one)).toEqual({ kind: 'ignored', reason: 'no_match' });
    expect(matchTextAnswer('0', one)).toEqual({ kind: 'ignored', reason: 'no_match' });
  });

  it('refuses empty and whitespace-only text', () => {
    expect(matchTextAnswer('   ', one)).toEqual({ kind: 'ignored', reason: 'no_match' });
  });

  /** ⛔ THE LOOP. Recued's own ask body is posted into the same chat and read
   *  back by the poll — and with a DELEGATED Graph credential it is
   *  indistinguishable from the owner's messages by sender. The ask body
   *  CONTAINS the option labels, so a substring matcher would answer its own
   *  question the instant it was asked. Exact-match-alone is what prevents it. */
  it('does not answer its own ask body read back off the wire', () => {
    const askBody = [
      'Recipe invoice-intake wants to run mail-send',
      '  to: dana@example.com',
      '',
      'Approve or Deny?',
      'https://recued.example.com/ask/ask-1',
    ].join('\n');
    expect(matchTextAnswer(askBody, one)).toEqual({ kind: 'ignored', reason: 'no_match' });
  });
});
