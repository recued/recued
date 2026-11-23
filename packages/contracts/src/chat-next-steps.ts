/** D-404 slice B1 (2026-11-18) — the steps under a chat answer that can land (a pack or a recipe
 *  installed, a thing added in Yours), and which of them have. The owner's ruling (P2): once a step
 *  lands, the row under the answer offers "Ask again", which sends the request again. Nothing
 *  continues on its own.
 *
 *  A step is named here by what it leads to, never by its words: the server answers "has it landed"
 *  from what it holds (its installed packs and recipes, the owner's things by type), the same facts
 *  the step was offered from. */
import type { ChatMessage } from './chat.js';
import { chatFixesOf, isChatSetupFeature } from './chat-fixes.js';
import { installOffersOf } from './install-offers.js';

/** A step that lands: a pack (its slug) or a recipe (its id) installed, a thing of a type (its
 *  type id, or any type of the same name) in Yours, or (D-405 slice 2) one of the owner's core
 *  features connected (its lane id: `mail`, `calendar`, `file`). */
export interface ChatNextStepRef {
  readonly kind: 'pack' | 'recipe' | 'thing' | 'feature';
  readonly id: string;
}

/** At most this many in one question: a few answers' worth (each holds at most seven). */
export const CHAT_NEXT_STEPS_LIMIT = 24;

/** A slug, a recipe id or a type id: the shapes an offer and a `thing` fix carry. */
const STEP_ID_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/u;

/** One key per step, for a set of the ones that landed. */
export const chatNextStepKey = (ref: ChatNextStepRef): string => `${ref.kind}:${ref.id}`;

/** The steps `value` holds, each checked (a known kind, an id an offer or a type can have), each
 *  once, at most {@link CHAT_NEXT_STEPS_LIMIT}. One reader for the question and its answer. */
export const chatNextStepRefsOf = (value: unknown): ChatNextStepRef[] => {
  if (!Array.isArray(value)) return [];
  const out: ChatNextStepRef[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (out.length >= CHAT_NEXT_STEPS_LIMIT) break;
    if (raw === null || typeof raw !== 'object') continue;
    const row = raw as { kind?: unknown; id?: unknown };
    if ((row.kind !== 'pack' && row.kind !== 'recipe' && row.kind !== 'thing' && row.kind !== 'feature')
      || typeof row.id !== 'string' || !STEP_ID_RE.test(row.id)) continue;
    if (row.kind === 'feature' && !isChatSetupFeature(row.id)) continue;
    const ref: ChatNextStepRef = { kind: row.kind, id: row.id };
    const key = chatNextStepKey(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ref);
  }
  return out;
};

/** The steps under an answer that can land: its install offers, its things to add, and its features to
 *  connect. A fix of a run's need or a switch is not one: it is done in place ("Turn it on"), or on its
 *  own page. */
export const chatNextStepsOfMessage = (
  message: Pick<ChatMessage, 'role' | 'install_offers' | 'fixes'>,
): ChatNextStepRef[] => message.role !== 'assistant' ? [] : chatNextStepRefsOf([
  ...installOffersOf(message.install_offers).map((offer) => ({ kind: offer.kind, id: offer.slug })),
  ...chatFixesOf(message.fixes).flatMap((fix) => (fix.kind === 'thing' ? [{ kind: 'thing', id: fix.type_id }]
    : fix.kind === 'feature' ? [{ kind: 'feature', id: fix.feature }] : [])),
]);
