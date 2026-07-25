/** Shared address-parsing helpers for contact-scope producers.
 *
 *  Lifted from A.6 / A.7 / A.8 (`behavioral_signature` / `reply_patterns` /
 *  `attendee_patterns`) — three callers using the same shape was the
 *  trigger to extract per the codebase convention (one prior data point:
 *  `_mail-body.ts` extracted at A.1's third caller).
 *
 *  All three producers normalise mail-header / calendar-attendee values
 *  the same way: parse the RFC-5322 wrapper (`Bob Smith <bob@x.com>`,
 *  `bob@x.com (Bob)`, etc.) into a canonical email, drop unparseable
 *  inputs, and build a Set for membership checks. Centralising means
 *  display-name handling stays consistent across producers — and the
 *  earlier A.6 bug (using `canonicalizeEmail` directly, which doesn't
 *  strip display-name wrappers) gets fixed in one place if it ever
 *  resurfaces.
 *
 *  Future signature-parse producers (A.10 `company`, A.11 `role`) will
 *  also read mail headers + calendar attendees and benefit from the
 *  same shape; that's the explicit motivation for extracting now
 *  rather than at A.10. */

import { parseAddress } from '@recued/contracts';

/** Extract a canonical email from a single hot-field value. Handles
 *  the three RFC-5322 wrapper shapes mail headers carry —
 *  `Bob Smith <bob@x.com>`, `bob@x.com (Bob Smith)`,
 *  `"Last, First" <a@b>` — via `parseAddress`. Returns the empty
 *  string for non-strings or unparseable inputs so callers can filter
 *  empties before set membership checks.
 *
 *  Important: prefer this over `canonicalizeEmail` from contracts.
 *  `canonicalizeEmail` only handles bare emails or `<email>` shapes;
 *  it returns the wrong thing for `Name <email>` because it lower-
 *  cases the whole string rather than parsing out the address. */
export const canonicalOne = (value: unknown): string => {
  if (typeof value !== 'string' || value.length === 0) return '';
  const parsed = parseAddress(value);
  return parsed ? parsed.email : '';
};

/** Project an address-shaped hot-field value into a Set of canonical
 *  emails. Handles all three forms producers encounter:
 *
 *    - `string`         — single address (e.g. mail `from` header)
 *    - `string[]`       — list of addresses (mail `to` / `cc`,
 *                         simple calendar `attendees`)
 *    - `{email}[]`      — calendar `attendees` from gcal/graph
 *                         providers that emit attendee objects with
 *                         `{email, response_status, ...}`
 *
 *  Producers care about set-membership, not display name or order, so
 *  the function builds into a caller-supplied Set rather than
 *  returning a list. Empty / unparseable entries are silently dropped. */
export const collectAddresses = (value: unknown, into: Set<string>): void => {
  if (value == null) return;
  if (typeof value === 'string') {
    const e = canonicalOne(value);
    if (e) into.add(e);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === 'string') {
        const e = canonicalOne(item);
        if (e) into.add(e);
      } else if (item && typeof item === 'object') {
        const candidate = (item as { email?: unknown }).email;
        const e = canonicalOne(candidate);
        if (e) into.add(e);
      }
    }
  }
};
