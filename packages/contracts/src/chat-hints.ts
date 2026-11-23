/** D-405 slice 3 (2026-11-19) — "Not now" on a hint under a chat answer. The owner's ruling (P3): a
 *  hint is never noise, and "Not now" on one is remembered per hint for a while.
 *
 *  A hint is what Recued offers that nobody asked for: a thing to add ("Add a Passport"), a pack's
 *  setup ("Set up Body signals from Apple Health"), a feature to connect ("Connect your mail"), a pack
 *  or a recipe to get ("Get Rental Book"). Not a fix for a call that failed (a switch, a run's need):
 *  that answers the request itself.
 *
 *  🔑 ONE KEY PER HINT, WHEREVER IT COMES FROM. The owner's message (D-405), the model's search of
 *  their things (D-404), a capability search or a run that needed a pack (D-323) each offer the same
 *  hint under the same key, so "Not now" holds against all of them, and the server leaves the hint out
 *  of what the model reads too (a sentence about a link the owner no longer sees would be false). */
import type { ChatFix } from './chat-fixes.js';
import type { InstallOffer } from './install-offers.js';

/** How long "Not now" holds: a hint the owner set aside comes back after this, not tomorrow. */
export const CHAT_HINT_NOT_NOW_DAYS = 30;
export const CHAT_HINT_NOT_NOW_MS = CHAT_HINT_NOT_NOW_DAYS * 24 * 60 * 60 * 1000;

/** What the owner saw, kept so a list of hidden hints can name each: cut to this many characters. */
export const CHAT_HINT_LABEL_MAX = 160;

/** At most this many in one list of hidden hints: more is a list nobody reads. */
export const CHAT_HINTS_NOT_NOW_LIMIT = 200;

const KEY_RE = /^(?:thing:[a-z][a-z0-9_]{0,127}|source:[a-z0-9][a-z0-9._-]{0,127}|feature:(?:mail|calendar|file)|offer:(?:pack|recipe):[a-z0-9][a-z0-9._-]{0,127})$/u;

/** A key a hint can have. */
export const isChatHintKey = (value: unknown): value is string => typeof value === 'string' && KEY_RE.test(value);

/** The key of a fix that is a hint; null for one that is not (a switch, a run's need). */
export const chatHintKeyOfFix = (fix: ChatFix): string | null =>
  fix.kind === 'thing' ? `thing:${fix.type_id}`
    : fix.kind === 'source' ? `source:${fix.pack_slug}`
      : fix.kind === 'feature' ? `feature:${fix.feature}`
        : null;

/** The key of an offer to get a pack or a recipe. */
export const chatHintKeyOfOffer = (offer: Pick<InstallOffer, 'kind' | 'slug'>): string => `offer:${offer.kind}:${offer.slug}`;

/** A hint the owner said "Not now" to: its key, what they saw, and when it comes back (ms). */
export interface ChatHintNotNow {
  readonly key: string;
  readonly label: string;
  readonly until: number;
}

/** The hints `value` holds, each checked, each once, at most {@link CHAT_HINTS_NOT_NOW_LIMIT}: what the
 *  app reads back from `chat.hints.list` and `chat.hints.not_now`. */
export const chatHintsNotNowOf = (value: unknown): ChatHintNotNow[] => {
  if (!Array.isArray(value)) return [];
  const out: ChatHintNotNow[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (out.length >= CHAT_HINTS_NOT_NOW_LIMIT) break;
    if (raw === null || typeof raw !== 'object') continue;
    const row = raw as { key?: unknown; label?: unknown; until?: unknown };
    const label = typeof row.label === 'string' ? row.label.trim().slice(0, CHAT_HINT_LABEL_MAX) : '';
    if (!isChatHintKey(row.key) || label.length === 0 || typeof row.until !== 'number' || !Number.isFinite(row.until)) continue;
    if (seen.has(row.key)) continue;
    seen.add(row.key);
    out.push({ key: row.key, label, until: row.until });
  }
  return out;
};
