/** D-238 — answering an ask by TYPING, for a channel that cannot render buttons.
 *
 *  The three answer surfaces that existed before this were a button press, the
 *  `/ask/<id>` landing form, and email's subject-tag reply. An office running
 *  Recued on its own LAN can reach none of them from Teams: `askAnswerLink` is
 *  refused for a private hostname BY DESIGN
 *  (`backend/server/src/ask-landing-answer-link.ts`), and Graph cannot deliver a
 *  card action to a poller. Typing the answer is what is left.
 *
 *  ⛔⛔ **THE FAILURE THIS MUST NOT HAVE IS APPROVING SOMETHING THE OWNER DID NOT
 *  APPROVE.** Everything below is biased that way, and several things a
 *  "helpful" matcher would obviously do are refused on purpose:
 *
 *   - **No synonyms.** `yes` / `ok` / `sure` / `👍` do NOT match an `Approve`
 *     option. They are the most common words in a chat and the owner is talking
 *     to a person in that chat too. A synonym list is how an unrelated "yeah ok"
 *     becomes an approval.
 *   - **No substring or fuzzy matching.** "I think we should approve this" is
 *     NOT an answer. Only the option itself, alone, is.
 *   - **No guessing between open asks.** Two asks open at once ⇒ refuse. There
 *     is no signal in a chat message saying which one it answers (Graph gives
 *     `replyToId` only for channel threads, never for a 1:1 chat), and picking
 *     the newer would silently approve the wrong thing.
 *   - **No answer on ambiguity.** A reply matching two options refuses rather
 *     than picking one.
 *
 *  Everything refused returns an `ignored` outcome with a reason, never an
 *  error: the channel is a CHAT, and the overwhelming majority of messages in it
 *  are people talking. Non-answers must pass through silently.
 *
 *  🔑 **What makes typing safe at all is that an option's LABEL is a word the
 *  owner has to choose to send on its own.** `Approve`, `Deny`, `Skip` — typed
 *  alone, that is an unambiguous act. Typed inside a sentence, it is
 *  conversation, and this returns `no_match`.
 *
 *  Spec: D-238 § 1 / § 5. */

import type { AskOption } from './types.js';

/** One ask this channel delivered and has not yet closed. */
export interface OpenAsk {
  readonly ask_id: string;
  readonly options: readonly AskOption[];
}

export type TextAnswerIgnoredReason =
  /** Nothing is awaiting an answer here — ordinary chatter. */
  | 'no_open_ask'
  /** More than one ask is open and a typed reply cannot say which it answers. */
  | 'ambiguous_ask'
  /** The text is not an option of the open ask — ordinary chatter. */
  | 'no_match'
  /** The text matches more than one option of the open ask. */
  | 'ambiguous_option';

export type TextAnswerOutcome =
  | { readonly kind: 'answer'; readonly ask_id: string; readonly option: string }
  | { readonly kind: 'ignored'; readonly reason: TextAnswerIgnoredReason };

/** Fold a typed reply to its comparable form.
 *
 *  Deliberately small: case, surrounding whitespace, internal whitespace runs,
 *  and trailing sentence punctuation. `Approve.` and `approve` are the same act;
 *  `approve it` is not, and stays different. Every rule here widens what counts
 *  as an answer, so each one is a decision rather than tidying. */
export const normalizeAnswerText = (raw: string): string =>
  raw
    .normalize('NFC')
    .trim()
    .replace(/\s+/gu, ' ')
    // Trailing punctuation only — a leading character is not noise, it is a
    // different message ("!approve" is a command shape we do not claim).
    .replace(/[.!?,;:]+$/u, '')
    .trim()
    .toLowerCase();

/** The prompt line an ask carries, and the ONLY vocabulary the matcher accepts.
 *
 *  ⛔⛔ **SHOWN AND ACCEPTED MUST BE ONE THING.** The first version of this
 *  printed an unnumbered `Reply with: Approve, Deny` while the matcher also
 *  accepted `1`, `2`, and the internal option IDs — so a bare `1` typed in
 *  conversation could settle an approval, and an id the owner had never seen
 *  could too. That contradicts the safety premise this module is built on: the
 *  owner must be able to look at the message and know exactly what would count
 *  as an answer. Numbering here is what earns positional matching.
 *
 *  ⇒ Anything this function does not render, `matchTextAnswer` must not accept.
 *  The sibling test asserts that in both directions. */
export const renderAnswerHint = (options: readonly AskOption[]): string =>
  options.length === 0
    ? ''
    : `Reply with: ${options.map((o, i) => `${i + 1} = ${o.label}`).join(', ')}`;

/** 1-based positional selection: `1` picks the first option.
 *
 *  Legitimate ONLY because `renderAnswerHint` numbers the options in the message
 *  itself. Bounded to the option count — an out-of-range number is `no_match`,
 *  never a clamp. */
const positionalIndex = (text: string, optionCount: number): number | null => {
  if (!/^[0-9]{1,2}$/u.test(text)) return null;
  const n = Number.parseInt(text, 10);
  return n >= 1 && n <= optionCount ? n - 1 : null;
};

/** Match a typed reply against the asks currently open on one channel.
 *
 *  ⚠ `open` is the set for THIS channel only. An ask delivered elsewhere is not
 *  answerable by typing here, and passing a wider set would let a reply in one
 *  conversation answer an ask the owner saw in another. */
export const matchTextAnswer = (
  rawText: string,
  open: readonly OpenAsk[],
): TextAnswerOutcome => {
  if (open.length === 0) return { kind: 'ignored', reason: 'no_open_ask' };
  // ⛔ Refuse rather than pick. See the header: nothing in a chat message says
  // which of two asks it answers.
  if (open.length > 1) return { kind: 'ignored', reason: 'ambiguous_ask' };

  const ask = open[0]!;
  const text = normalizeAnswerText(rawText);
  if (text.length === 0) return { kind: 'ignored', reason: 'no_match' };

  const byPosition = positionalIndex(text, ask.options.length);
  if (byPosition !== null) {
    return { kind: 'answer', ask_id: ask.ask_id, option: ask.options[byPosition]!.id };
  }

  // ⛔ LABELS ONLY — never the internal `id`. An id is not rendered anywhere the
  // owner can see, so accepting one means accepting a token they were never
  // shown; if an id happened to be `yes` or `ok`, ordinary chatter would settle
  // an approval through a door nobody knew existed. The id is what we RETURN,
  // never what we match.
  //
  // Collected rather than short-circuited so a collision REFUSES instead of
  // silently resolving to whichever option happened to be declared first.
  const hits = ask.options.filter((o) => normalizeAnswerText(o.label) === text);
  if (hits.length === 0) return { kind: 'ignored', reason: 'no_match' };
  if (hits.length > 1) return { kind: 'ignored', reason: 'ambiguous_option' };
  return { kind: 'answer', ask_id: ask.ask_id, option: hits[0]!.id };
};
