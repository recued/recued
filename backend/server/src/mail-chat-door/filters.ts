/** D-318 step 4 — which emails in the chat mailbox are requests at all (§4.3,
 *  §4.7). These run where an email lands, in front of the proof: what they
 *  decline is never looked up in the owner's Sent record and never earns the
 *  owner a notice. An out-of-office reply to an answer, or a rule forwarding
 *  mail to the chat mailbox, would otherwise read as "someone else wrote
 *  this".
 *
 *  Spec: D-318 §4.3, §4.7, §8 step 4. */

/** A precedence a list server or an auto-responder stamps. */
const AUTOMATIC_PRECEDENCE = new Set(['auto_reply', 'bulk', 'list', 'junk']);

/** Why an email is automatic mail (§4.7, the first layer), or `null`. Read from
 *  the header map, which keeps each header's first value — the one the
 *  receiving server put on top. */
export const automaticMailSign = (
  headers: Readonly<Record<string, string>> | undefined,
): string | null => {
  const h = headers ?? {};
  // RFC 3834: anything but `no` was sent by a machine.
  const submitted = h['auto-submitted']?.split(';')[0]?.trim().toLowerCase();
  if (submitted !== undefined && submitted !== '' && submitted !== 'no') return 'auto-submitted';
  if (h['x-autoreply'] !== undefined || h['x-autorespond'] !== undefined) return 'x-autoreply';
  const precedence = h['precedence']?.trim().toLowerCase();
  if (precedence !== undefined && AUTOMATIC_PRECEDENCE.has(precedence)) return 'precedence';
  if (h['list-id'] !== undefined) return 'list-id';
  // A delivery or read report.
  if (h['content-type']?.trim().toLowerCase().startsWith('multipart/report')) return 'report';
  // The empty return path a bounce or an auto-responder sends from.
  if (h['return-path'] !== undefined && /^<\s*>$/.test(h['return-path'].trim())) return 'empty-return-path';
  return null;
};

/** `Re:` as mail clients write it in English and the common other languages.
 *  A forward's `Fwd:` / `FW:` is not one: forwarding is not asking. Nor is
 *  `VS:`, the Danish and Norwegian forward (videresendt), though Finnish writes
 *  it for a reply: read as a forward, a Finnish reply still continues its
 *  conversation through its references. */
const REPLY_PREFIX = /^\s*(?:re|aw|sv|antw|res)\s*(?:\[\d+\])?\s*:\s*/i;

/** A forward's prefix as mail clients write it: `Fwd:`, `FW:`, and German
 *  `WG:`, French `TR:`, Spanish `RV:`, Portuguese `Enc:`, Danish and
 *  Norwegian `VS:`, Dutch `Doorst:`, Swedish `VB:`. */
const FORWARD_PREFIX = /^\s*(?:fwd?|fw|wg|tr|rv|enc|vs|doorst|vb)\s*(?:\[\d+\])?\s*:/i;

/** Does a subject (past any `Re:`) begin with a forward's prefix? */
export const subjectForwards = (subject: string): boolean => FORWARD_PREFIX.test(withoutReplyPrefixes(subject));

/** Is the email itself a forward? Its subject begins with a forward's prefix,
 *  or with the `ask:` prefix and then one — the owner wrote it in front of the
 *  `Fwd:` their mail app wrote. A `Re: Fwd:` is not one: it answers a forward,
 *  and its quoted history is the conversation's. */
export const subjectIsForward = (subject: string, prefix: string | null): boolean => {
  const rest = subject.trimStart();
  if (FORWARD_PREFIX.test(rest)) return true;
  return prefix !== null && rest.toLowerCase().startsWith(prefix.toLowerCase())
    && FORWARD_PREFIX.test(rest.slice(prefix.length));
};

/** Does a subject begin with a reply's prefix? */
export const subjectReplies = (subject: string): boolean => REPLY_PREFIX.test(subject);

/** The subject without the reply prefixes in front of it. */
export const withoutReplyPrefixes = (subject: string): string => {
  let rest = subject;
  while (REPLY_PREFIX.test(rest)) rest = rest.replace(REPLY_PREFIX, '');
  return rest.trimStart();
};

/** Does the subject, past any `Re:`, begin with the `ask:` prefix? Case aside. */
export const subjectAsks = (subject: string, prefix: string): boolean =>
  withoutReplyPrefixes(subject).toLowerCase().startsWith(prefix.toLowerCase());

/** The subject without its reply prefixes and its `ask:` prefix: what was asked.
 *  `ask: lunch?` → `lunch?`; a subject without the prefix stays as it is. */
export const subjectWithoutAsk = (subject: string, prefix: string | null): string => {
  const rest = withoutReplyPrefixes(subject);
  if (prefix === null || !rest.toLowerCase().startsWith(prefix.toLowerCase())) return rest.trim();
  return rest.slice(prefix.length).trim();
};
