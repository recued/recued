/** D-164 P8 — contact has-email presence templates + intent-aware matcher.
 *
 *  A presence answer for "do I have `<Name>`'s email?" — the yes/no sibling
 *  of the P5 contact-attribute class. It fires on the PRESENCE-question
 *  framing ("do I have …", "is there an email for …", "do you have …") and
 *  renders "Yes, `<Name>`'s email address is `<email>`." when the warehouse
 *  holds a real email — or, when the local store provably is the complete
 *  contact view, the negative sibling "No, there's no email address on file
 *  for `<Name>`." via the family's bespoke probe
 *  (`createContactHasEmailProbe`; see the CRM-gated section below).
 *
 *  WHY a separate family from P5 (and registered BEFORE it). P5's matcher
 *  keys on the bare possessive `<Name>'s email` with ANY lead, so it already
 *  fires on "do I have `<Name>'s` email?" — but it renders the flat
 *  "`<Name>`'s email address is `<email>`." This family gives the
 *  presence-framed question its natural affirmative ("Yes, …") AND covers the
 *  NON-possessive phrasing P5 misses entirely ("do I have an email FOR
 *  `<Name>`?", "is there an email for `<Name>`?"). Registered FIRST so a
 *  presence question wins here; everything else ("what is `<Name>`'s email?",
 *  a bare "`<Name>`'s email?") has no presence cue, falls through, and P5
 *  answers it as before.
 *
 *  CRM-GATED "NO" (was YES-only). The "no" answer was originally DEFERRED
 *  outright: the short-circuit reads only the LOCAL contact warehouse, but
 *  the model's `contact.search` tool ALSO has HubSpot + Salesforce sources —
 *  a confident local "no" could contradict a CRM contact that does have the
 *  email. That hazard is COVERAGE-dependent, so the family's bespoke probe
 *  (`createContactHasEmailProbe`) now asserts the negative EXACTLY when the
 *  hazard provably can't exist: the injected `HasCrmContactSource` port
 *  reports no CRM-contact connection enrolled AND no platform contact-mirror
 *  rows present (mirrors outlive a disconnected connection, so the
 *  connection check alone is not enough) — i.e. the local store IS the
 *  complete contact view. Then a uniquely-resolved contact whose complete
 *  linked address set is provably EMPTY (`row.emails` present and `[]` —
 *  a mention-only stub after the backend `contactLookup` strips its
 *  placeholder; NOT a name-only tombstone sentinel, which carries no
 *  `emails` claim and so can never render the stale-identity "no") renders
 *  `CONTACT_HAS_NO_EMAIL_TEMPLATE` via the snapshot's
 *  `render_template_override` seam — the probe, not the lexical matcher,
 *  owns the yes/no split because only the probe sees the data; the family
 *  authorizes exactly this one canonical override object
 *  (`overrideTemplates`, composer-enforced fail-closed — a declared hash
 *  always renders the declared body). Any CRM coverage, any uncertainty (port
 *  throw, absent wiring, missing/non-empty address set), or an UNRESOLVED
 *  contact (absent — the LLM's "I don't have a contact named X" is the
 *  better answer; indistinguishable from ambiguous at the resolver) → pass
 *  through, exactly the old behavior. A wrong negative is never rendered:
 *  "no" requires unique resolution + an empty complete address set +
 *  provably complete local coverage.
 *
 *  Two-way 100% posture (design § 3 Invariant 5 / 7 — safe small gains): the
 *  matcher is a TIGHT both-ends-anchored WHITELIST (mirrors calendar / mail).
 *  It fires only when ALL hold:
 *    - exactly ONE `entity.name` slot;
 *    - the prompt ENDS in the contact's email reference — EITHER the
 *      possessive `<Name>'s email[ address][ on file]` OR the non-possessive
 *      `(an|the)? email[ address] for <Name>[ on file]` (no trailing content
 *      after);
 *    - everything BEFORE that reference is a PRESENCE QUESTION lead —
 *      interrogative / auxiliary / determiner scaffolding that (a) is
 *      `PRESENCE_LEAD_ALLOWED`-only and (b) OPENS with a PRESENCE VERB
 *      (`do`/`have`/`is`/…) — i.e. interrogative INVERSION, so a DECLARATIVE
 *      statement ("I have an email for `<Name>`.", "there is an email for
 *      `<Name>`.") is rejected (subject-first, not a question). The opener
 *      requirement + the deliberate ABSENCE of `what`/`how`/`where`/`who`/
 *      `which`/`tell` from the allowlist is what leaves "what is `<Name>`'s
 *      email?" (and every other non-presence framing) to P5;
 *    - the prompt is not contact-mutation-shaped (`change`/`set`/`add`/… an
 *      email — a write reaches the executor, never a read short-circuit).
 *  Anything else → `null` (pass through). A wrong "Yes, here's the email" for
 *  a non-presence question is the cardinal sin; a dropped real request is a
 *  recoverable cache miss (design § 3 Invariant 7).
 *
 *  Render-only by construction (design § 3 Invariant 1/2): a `render_template`
 *  — warehouse read in the probe + body interpolation, no `ai-*`, no
 *  mutations. `{{name}}` / `{{email}}` come from the probe snapshot.
 *
 *  See: docs/d-164-prompt-cache-consolidation-pending-design.md § 3. */

import type { TemplateMatcher } from '../gate/index.js';
import type { RenderTemplate } from '../types.js';

/** The affirmative render template for the contact has-email class — the one
 *  the MATCHER returns. Keyed on one `entity.name` slot; the body affirms the
 *  email the probe snapshot supplies. The family's bespoke probe owns the
 *  yes/no split: email present → this body; email absent → the negative
 *  sibling below via `render_template_override` (CRM-gated) or pass-through.
 *  `template_hash` is a stable built-in id used for family probe routing +
 *  audit correlation. */
export const CONTACT_HAS_EMAIL_TEMPLATE: RenderTemplate = {
  template_hash: 'recued/contact-has-email-by-name@v1',
  kind: 'render_template',
  slot_grammar: ['entity.name'],
  action_class: 'read',
  short_circuit_eligible: true,
  body: "Yes, {{name}}'s email address is {{email}}.",
};

/** The negative sibling — rendered via the probe's
 *  `render_template_override` when the contact resolves uniquely, holds no
 *  real email, AND the `HasCrmContactSource` port proves the local store is
 *  the complete contact view (see the file header). The existential "there's
 *  no … on file" phrasing reads naturally under EVERY lead the matcher
 *  admits ("do I have …", "do you have …", "is there …", "have I got …"),
 *  and "on file" scopes the claim to what Recued holds — the deterministic
 *  path asserts record absence, not that no address exists in the world.
 *  Never returned by the matcher (the lexical layer can't see data); only
 *  the probe selects it, so it needs no entry in the family's
 *  `templateHashes` routing set. */
export const CONTACT_HAS_NO_EMAIL_TEMPLATE: RenderTemplate = {
  template_hash: 'recued/contact-has-no-email-by-name@v1',
  kind: 'render_template',
  slot_grammar: ['entity.name'],
  action_class: 'read',
  short_circuit_eligible: true,
  body: "No, there's no email address on file for {{name}}.",
};

/** Mutation / imperative verbs that turn a presence prompt into a WRITE
 *  ("add / set / change `<Name>`'s email …"). Any match → pass through (a
 *  write reaches the executor — gateway / approval / audit, D-157). The
 *  presence-lead allowlist already excludes these as lead tokens; this is
 *  defence in depth. Word-boundaried; conservative. */
const MUTATION_RE =
  /\b(?:change|changes|changing|set|sets|setting|update|updates|updating|edit|edits|editing|delete|deletes|deleting|remove|removes|removing|replace|replaces|replacing|add|adds|adding|correct|corrects|correcting|assign|assigns|assigning|clear|clears|clearing|save|saves|saving|store|stores|storing|forget|forgets|forgetting)\b/;

/** The attribute phrase — `email` / `e-mail`, optionally `… address`. */
const ATTR = String.raw`e-?mail(?:\s+address)?`;
/** Optional "on file / on record / saved / stored" tail after the attribute. */
const ON_FILE = String.raw`(?:\s+(?:on\s+file|on\s+record|saved|stored))?`;
/** Trailing whitespace + sentence punctuation, `$`-anchored. */
const TAIL = String.raw`\s*[?.!]*$`;

/** Escape a slot value for literal inclusion in the core-phrase RegExp. */
const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The start index of the contact's email reference ENDING the prompt, or
 *  `null`. Tries the possessive form first (`<name>'s email …$`), then the
 *  non-possessive `for`-form (`(an|the)? email … for <name>$`). `$`-anchored
 *  so a trailing constraint after the name fails the match; the returned index
 *  is the boundary the presence-lead check validates everything BEFORE.
 *  Handles both the straight (`'`) and curly (`’`) possessive apostrophe. */
const contactHasEmailCoreStart = (haystack: string, name: string): number | null => {
  const esc = escapeRegExp(name);
  const possessive = new RegExp(`\\b${esc}['’]s\\s+${ATTR}${ON_FILE}${TAIL}`).exec(haystack);
  if (possessive !== null) return possessive.index;
  const forForm = new RegExp(
    `(?:\\ban?\\s+|\\bthe\\s+)?\\b${ATTR}\\s+for\\s+${esc}${ON_FILE}${TAIL}`,
  ).exec(haystack);
  if (forForm !== null) return forForm.index;
  return null;
};

/** Presence VERBS — the lead must OPEN with one of these (interrogative
 *  inversion), so the family fires only on a genuine presence/possession
 *  QUESTION ("DO I have …", "IS there …", "HAVE I got …") and not on a
 *  declarative STATEMENT ("I have an email for …", "there is an email for …")
 *  nor a bare attribute reference. A question inverts the auxiliary to the
 *  front; a statement keeps the subject first. (A copula `is/are/was/were` as
 *  the FIRST token is itself an inversion — "is there …" / "is `<Name>`'s
 *  email …?" — the declarative copular form puts the subject first and is
 *  rejected by the opener check or, mid-sentence, by the `$`-anchored core.) */
const PRESENCE_VERBS: ReadonlySet<string> = new Set([
  'do', 'does', 'did', 'have', 'has', 'had', 'got', 'gotten', 'is', 'are', 'was', 'were',
]);

/** Words allowed in the lead (everything before the email reference). The
 *  presence verbs PLUS first-person subjects + the existential `there` +
 *  quantity/determiner scaffolding. DELIBERATELY EXCLUDES the content
 *  interrogatives `what` / `how` / `where` / `who` / `which` and request verbs
 *  `tell` / `show` — that exclusion is what leaves "what is `<Name>`'s email?"
 *  (and similar non-presence framings) to the P5 contact-attribute family. */
const PRESENCE_LEAD_ALLOWED: ReadonlySet<string> = new Set([
  ...PRESENCE_VERBS,
  'i', 'we', 'you', 'there', 'any', 'still', 'already', 'a', 'an', 'the',
]);

/** True iff the lead is a genuine PRESENCE QUESTION opener: non-empty,
 *  `PRESENCE_LEAD_ALLOWED`-only, AND it OPENS with a presence verb
 *  (interrogative inversion). The opener requirement is load-bearing: a
 *  DECLARATIVE statement ("I have an email for `<Name>`.", "we have …",
 *  "you have …", "there is …") keeps the subject first and is NOT a question —
 *  firing "Yes, here's the email" on a statement would be a wrong answer. Only
 *  the inverted, auxiliary-first forms ("DO I have …", "HAVE I got …",
 *  "IS there …") fire. An empty lead (a bare "`<Name>`'s email?") is likewise
 *  not a presence question → false → falls through to P5. */
const leadIsPresence = (prefix: string): boolean => {
  const trimmed = prefix.trim();
  if (trimmed.length === 0) return false;
  const tokens = trimmed.split(' ');
  if (!tokens.every((t) => PRESENCE_LEAD_ALLOWED.has(t))) return false;
  return PRESENCE_VERBS.has(tokens[0]!);
};

/** The contact has-email `TemplateMatcher`. Fires only when the prompt is a
 *  presence question about a contact's email, bounded on BOTH ends:
 *    - the FULL extracted slot grammar is EXACTLY ONE `entity.name`;
 *    - it is not contact-mutation-shaped (defence in depth);
 *    - it ENDS in the contact's email reference (possessive or `for`-form,
 *      no trailing content); and
 *    - everything BEFORE it is a presence lead (allowlist-only + ≥1 presence
 *      verb) — which excludes "what is …" and every non-presence framing.
 *  Anything else → `null` (pass through). Whitespace is collapsed + lower-cased
 *  on both sides; the match is purely lexical (the warehouse read is the
 *  probe's job). */
export const matchContactHasEmailTemplate: TemplateMatcher = ({ text, slots }) => {
  if (slots.length !== 1) return null;
  const name = slots[0]!;
  if (name.kind !== 'entity.name') return null;
  const haystack = text.toLowerCase().replace(/\s+/g, ' ');
  if (MUTATION_RE.test(haystack)) return null;
  const needleName = name.value.toLowerCase().replace(/\s+/g, ' ');
  if (needleName.length === 0) return null;
  const coreStart = contactHasEmailCoreStart(haystack, needleName);
  if (coreStart === null) return null;
  if (!leadIsPresence(haystack.slice(0, coreStart))) return null;
  return CONTACT_HAS_EMAIL_TEMPLATE;
};
