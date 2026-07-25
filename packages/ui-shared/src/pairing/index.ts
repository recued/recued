/** D-212 tail #6 — shared `/auth/pair` error presentation.
 *
 *  One vocabulary for every pairing client (webclient + Bridge popup),
 *  replacing the two hand-copied lists that had each fallen four codes
 *  behind the server. See `pair-error-copy.ts` for why the FALLBACK, not
 *  the list, is what makes this safe. */

export {
  PAIR_SERVER_ERROR_COPY,
  PAIR_SERVER_MESSAGE_MAX_CHARS,
  PAIR_SERVER_REFUSED_COPY,
  PAIR_SERVER_SAID_LABEL,
  describePairServerError,
  hasPairServerErrorCopy,
  sanitizeServerMessage,
} from './pair-error-copy.js';
export type {
  PairServerErrorCode,
  PairServerErrorPresentation,
} from './pair-error-copy.js';
