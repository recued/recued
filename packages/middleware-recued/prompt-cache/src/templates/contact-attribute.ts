/** D-164 P5 — contact-attribute template family + intent-aware matcher.
 *
 *  The first real short-circuit template class: single-slot contact
 *  attribute lookup — "what is `<Name>`'s email / phone?". This is the
 *  MVP firing path the bench's `21-prompt-cache-short-circuit` tripwire
 *  has been waiting to validate.
 *
 *  Why a bespoke matcher rather than the slot-grammar library
 *  (`./library.ts`). The library matches on slot-grammar multiset +
 *  locale ALONE — verb / intent classification is explicitly deferred
 *  there (P4f header). A `slot_grammar: ['entity.name']` template would
 *  therefore fire on EVERY single-name prompt ("tell me about Alice
 *  Bond", "who is Alice Bond") and couldn't tell an email request from a
 *  phone one. The gate header (`../gate/index.ts`) calls out that "verb /
 *  intent classification is the matcher's responsibility"; this module
 *  is that matcher for the contact-attribute class. It composes with the
 *  library later (a production matcher can try this class first, then
 *  fall through to the library pools).
 *
 *  Two-way 100% posture (design § 3 Invariant 5 / 7 — safe small gains):
 *  the matcher is deliberately TIGHT. For `email` / `phone` it fires only
 *  on the POSSESSIVE construction `<Name>'s <attribute>` — which anchors
 *  "asking for this contact's attribute" and rejects both the bare mention
 *  ("tell me about Alice Bond") and the pronoun phrasing ("... and tell
 *  me their email"). `company` is HELD to a stricter rule (see
 *  `matchesCompanyForm`): the word is POLYSEMOUS — "do you enjoy
 *  `<Name>`'s company?" means companionship, not employer — so the
 *  any-lead possessive path that is safe for email/phone would fire a
 *  wrong answer there; company fires only on fully-anchored question
 *  FORMS ("what is `<Name>`'s company?", "where does `<Name>` work?").
 *  Anything the matcher doesn't recognise passes through to the
 *  LLM; an over-extracted name is then caught by the data-presence half
 *  of the gate (the contact won't resolve). A dropped real request is a
 *  recoverable cache miss, never a wrong answer.
 *
 *  Render-only by construction (design § 3 Invariant 1/2): every template
 *  here is a `render_template` — `entity.query` (the warehouse read in
 *  the probe) + body interpolation, no `ai-*`, no mutations. The renderer
 *  is the shared `createTemplateRenderer` (`./index.ts`); a body
 *  placeholder the probe snapshot can't fill (e.g. a phone the contact
 *  lacks) throws → caught → `empty-render` pass-through, so a
 *  missing attribute degrades to the LLM rather than a half-rendered
 *  answer.
 *
 *  See: docs/d-164-prompt-cache-consolidation-pending-design.md § 3. */

import type { TemplateMatcher } from '../gate/index.js';
import type { RenderTemplate } from '../types.js';

/** The renderable contact attributes this family covers. Extend here +
 *  add a template below + a detector keyword to widen the class — and
 *  decide which matching rule the new attribute rides: the generic
 *  possessive path (only safe for an UNAMBIGUOUS attribute noun, like
 *  email/phone) or its own anchored forms (like company). */
export type ContactAttribute = 'email' | 'phone' | 'company';

/** The closed-list contact-attribute render templates. Each is a
 *  deterministic `render_template` keyed on a single `entity.name` slot;
 *  the body references only the display name + the one attribute, so the
 *  renderer declines (empty render → pass-through) when the probe
 *  snapshot lacks that attribute. `template_hash` is a stable built-in id
 *  (these ship with the binary, not fetched from recued.com), used for
 *  audit correlation + the renderer's error reporting. */
export const CONTACT_ATTRIBUTE_TEMPLATES: Readonly<
  Record<ContactAttribute, RenderTemplate>
> = {
  email: {
    template_hash: 'recued/contact-email-by-name@v1',
    kind: 'render_template',
    slot_grammar: ['entity.name'],
    action_class: 'read',
    short_circuit_eligible: true,
    body: "{{name}}'s email address is {{email}}.",
  },
  phone: {
    template_hash: 'recued/contact-phone-by-name@v1',
    kind: 'render_template',
    slot_grammar: ['entity.name'],
    action_class: 'read',
    short_circuit_eligible: true,
    body: "{{name}}'s phone number is {{phone}}.",
  },
  company: {
    template_hash: 'recued/contact-company-by-name@v1',
    kind: 'render_template',
    slot_grammar: ['entity.name'],
    action_class: 'read',
    short_circuit_eligible: true,
    // "works at" answers both surface forms naturally ("what's their
    // company?" / "where do they work?"). Present tense matches the
    // store's semantics: `company` is the contact's CURRENT employer
    // (vendor_meta / manual / inferred — D-138), not an employment
    // history.
    body: '{{name}} works at {{company}}.',
  },
};

/** Mutation / imperative verbs that turn a possessive-attribute prompt into a
 *  WRITE request ("change / set / delete `<Name>`'s email …"). The
 *  possessive-attribute pattern fits a write just as well as a read, but a
 *  deterministic short-circuit must NEVER silently answer a write as a read —
 *  a mutation has to reach the executor (gateway / approval / audit, D-157).
 *  Any match → pass through. Word-boundaried; conservative (a false reject is
 *  just a pass-through, a false accept silently drops the user's write). */
const MUTATION_RE =
  /\b(?:change|changes|changing|set|sets|setting|update|updates|updating|edit|edits|editing|modify|modifies|modifying|delete|deletes|deleting|remove|removes|removing|replace|replaces|replacing|rename|renames|renaming|clear|clears|clearing|reset|resets|resetting|correct|corrects|correcting|assign|assigns|assigning)\b/;

/** Word-boundaried attribute detectors. Tight by design (Invariant 5):
 *  only forms that UNAMBIGUOUSLY name a renderable contact attribute.
 *    - `number` alone is excluded (account / invoice collision).
 *    - bare `mail` is excluded (mailing-address collision); `e-mail` /
 *      `email` only.
 *  Add a row to widen, but keep each form unambiguous — a false fire is
 *  a wrong answer, a miss is just a pass-through. */
const EMAIL_RE = /\b(?:e-?mail)\b/;
const PHONE_RE = /\b(?:phone|cell|mobile)\b/;
/** Company keywords participate in the MULTI-attribute defer only — they
 *  never fire the company template via the generic possessive path (see
 *  `detectAttribute` / `matchesCompanyForm`). Including `work` here makes
 *  a QUALIFIED attribute defer: "`<Name>`'s work email" / "company phone"
 *  asks for a *specific* address the flat snapshot can't distinguish from
 *  the stored one, so answering the stored value would be a guess. */
const COMPANY_RE = /\b(?:company|employer|work)\b/;

/** WHOLE-REMAINDER attribute forms — the post-possessive remainder must
 *  be EXACTLY the attribute (plus an optional `address` / `number`
 *  qualifier) and sentence punctuation, anchored at BOTH ends. The
 *  `$`-anchor separates an attribute LOOKUP ("what is `<Name>`'s
 *  email?") from a yes/no PREDICATE about the attribute ("is `<Name>`'s
 *  email valid?" leaves a trailing word and passes through). The
 *  `^`-anchor rejects a LEADING word between the possessive and the
 *  attribute: "`<Name>`'s BOSS email" / "MANAGER phone" re-target the
 *  attribute to a different entity with no apostrophe for the chained-
 *  possessive guard to catch, and "OLD email" asks for a value the
 *  store doesn't hold — both previously rendered `<Name>`'s own stored
 *  attribute (codex fold, found via the P11 list-anaphora review but
 *  live on the DIRECT path too: "what is Pat Lee's boss email?"). A
 *  legitimate lookup's remainder carries nothing but the attribute form
 *  by construction. The unanchored `*_RE` above still drive the
 *  multi-attribute defer (so "email and phone" is detected as BOTH and
 *  deferred). */
const EMAIL_REMAINDER_RE = /^\s*(?:e-?mail)(?:\s+address)?\s*[?.!]*$/;
const PHONE_REMAINDER_RE = /^\s*(?:phone|cell|mobile)(?:\s+number)?\s*[?.!]*$/;

/** Classify the post-possessive text into a single attribute, or `null`
 *  to pass through. When MORE THAN ONE attribute keyword appears ("their
 *  email and phone", "their company email"), the user wants more than one
 *  attribute — or a QUALIFIED one ("company email" = the work address,
 *  which the flat snapshot can't distinguish from the stored email) — so
 *  we defer to the LLM (return null) rather than answer half the question
 *  or guess. A single attribute fires only when it IS the whole remainder
 *  (the question is an attribute lookup — not a predicate about the
 *  attribute, not a re-targeted "boss email" — see `*_REMAINDER_RE`).
 *  `company` ALONE never fires here: the word is
 *  polysemous (companionship), so the company template is reachable only
 *  through the fully-anchored forms in `matchesCompanyForm`. */
const detectAttribute = (text: string): ContactAttribute | null => {
  const hasEmail = EMAIL_RE.test(text);
  const hasPhone = PHONE_RE.test(text);
  const hasCompany = COMPANY_RE.test(text);
  const detected = [hasEmail, hasPhone, hasCompany].filter(Boolean).length;
  if (detected !== 1) return null;
  if (hasEmail) return EMAIL_REMAINDER_RE.test(text) ? 'email' : null;
  if (hasPhone) return PHONE_REMAINDER_RE.test(text) ? 'phone' : null;
  return null; // company: form-anchored only, never via the generic path
};

/** Escape a slot value for literal inclusion in a form RegExp. */
const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Leading military/naval rank titles that flip the POSSESSIVE company
 *  reading from employer to UNIT — "Captain `<Name>`'s company" plausibly
 *  means her company of soldiers, not her employer (codex review fold).
 *  Only reachable when the rank is part of the extracted/stored name
 *  ITSELF (an intervening title between the lead and the name already
 *  fails the `^what is <name>` anchor), and only the possessive form is
 *  guarded — the work-forms ("where does `<Name>` work?") read as
 *  employment regardless of rank. Leading-token only: a contact merely
 *  SURNAMED Captain ("Alice Captain") doesn't trigger. A false reject is
 *  a recoverable pass-through (design § 3 Invariant 7). */
const LEADING_RANK_RE =
  /^(?:captain|colonel|major|general|lieutenant|sergeant|corporal|private|admiral|commander|commodore|brigadier)\b/;

/** The company noun inside the anchored forms — `company` / `employer`. */
const COMPANY_NOUN = String.raw`(?:company|employer)`;
/** Trailing whitespace + sentence punctuation, `$`-anchored. */
const COMPANY_TAIL = String.raw`\s*[?.!]*$`;

/** WHOLE-PROMPT anchored question forms for the `company` attribute. The
 *  attribute noun is polysemous — "do you enjoy `<Name>`'s company?" /
 *  "I was in `<Name>`'s company" mean companionship — so company must NOT
 *  ride the generic any-lead possessive path that is safe for email/phone
 *  (where firing on "do you enjoy X's company?" would render "X works at
 *  Acme." — a wrong answer). Instead the ENTIRE prompt must be one of the
 *  unambiguous employer questions (`^…$`-anchored, both ends by
 *  construction):
 *    - "what is / what's `<Name>`'s company|employer?"
 *    - "where does `<Name>` work?"  (a trailing word fails the anchor, so
 *      "where does `<Name>` work OUT?" — exercise — passes through)
 *    - "what|which company|employer does `<Name>` work for|at?"
 *  Deliberately ABSENT: "who does `<Name>` work for?" (reads as the
 *  manager/boss at least as often as the employer — answering "works at
 *  Acme" to a who-question is a wrong answer), past-tense forms ("what
 *  WAS …", "where DID … work" — the store holds the CURRENT employer,
 *  not history), and adverb variants ("where does X currently work?" —
 *  a recoverable miss, v1 keeps the list minimal). The possessive form is
 *  additionally guarded by `LEADING_RANK_RE`: a rank-titled name flips
 *  "X's company" to the military-unit reading, so it defers. */
const matchesCompanyForm = (haystack: string, name: string): boolean => {
  const esc = escapeRegExp(name);
  return (
    (!LEADING_RANK_RE.test(name)
      && new RegExp(`^what(?:['’]s|s| is)\\s+${esc}['’]s\\s+${COMPANY_NOUN}${COMPANY_TAIL}`).test(
        haystack,
      ))
    || new RegExp(`^where does\\s+${esc}\\s+work${COMPANY_TAIL}`).test(haystack)
    || new RegExp(
      `^(?:what|which)\\s+${COMPANY_NOUN}\\s+does\\s+${esc}\\s+work\\s+(?:for|at)${COMPANY_TAIL}`,
    ).test(haystack)
  );
};

/** A SECOND possessive in the post-possessive remainder means the
 *  attribute belongs to a DIFFERENT entity than the named contact —
 *  "`<Name>`'s BOSS'S email" asks for the boss's address, "`<Name>`'s
 *  email's domain" asks about the address itself. The flat possessive
 *  grammar cannot represent the chain, so the remainder must contain NO
 *  apostrophe at all: a legitimate single-possessive lookup's remainder
 *  is only `<attribute> [address|number] <punctuation>` (apostrophe-free
 *  by construction), while ANY apostrophe marks a clitic (`boss's`), a
 *  ZERO-S possessive (`boss'` — the round-2 codex catch a `'s`-only
 *  pattern missed), or a contraction that wasn't firing anyway. Both
 *  apostrophe glyphs. (Codex fold: rendering "`<Name>`'s email address
 *  is …" to "what is `<Name>`'s boss's email?" was a wrong answer on the
 *  DIRECT path already; the P9 anaphora rewrite would have inherited it
 *  via "what is her boss's email?".) */
const CHAINED_POSSESSIVE_RE = /['’]/;

/** Locate the user's POSSESSIVE reference to the named contact. Returns
 *  the index in `haystack` immediately AFTER the possessive clitic, or
 *  `null` when the name isn't used possessively. Handles both the
 *  straight (`'`) and curly (`’`) apostrophe. The caller searches the
 *  remainder for the attribute keyword, so the possessive both anchors
 *  intent AND scopes the keyword search to text that follows the name. */
const possessiveEnd = (haystack: string, name: string): number | null => {
  for (const clitic of ["'s", '’s']) {
    const needle = name + clitic;
    const idx = haystack.indexOf(needle);
    if (idx !== -1) return idx + needle.length;
  }
  return null;
};

/** The contact-attribute `TemplateMatcher`. Fires only when:
 *    1. The FULL extracted slot grammar is EXACTLY ONE `entity.name` — no
 *       second name (ambiguous), no `entity.email` / `date` / `time` slot.
 *       An extra slot signals a different request shape: e.g. a write
 *       "change `<Name>`'s email to a@b.com" carries an `entity.email` slot,
 *       which must NOT be answered as a read. This mirrors the slot-grammar
 *       multiset-equality contract (design § 3 Invariant 4).
 *    2. The prompt is not mutation/imperative-shaped (`MUTATION_RE`) — a write
 *       must reach the executor, never short-circuit as a read.
 *    3. EITHER the name is used POSSESSIVELY (`<Name>'s …`) and a single
 *       recognised attribute keyword follows the possessive (the email /
 *       phone path), OR the whole prompt is one of the anchored company
 *       question forms (`matchesCompanyForm` — company is polysemous, so
 *       it never rides the generic possessive path).
 *  Otherwise `null` → the gate passes through to the LLM.
 *
 *  Whitespace is collapsed + lower-cased on both sides so a double-spaced
 *  or differently-cased prompt still matches the NER slot value. The
 *  match is purely lexical — no warehouse read here (that's the probe). */
export const matchContactAttributeTemplate: TemplateMatcher = ({ text, slots }) => {
  if (slots.length !== 1) return null;
  const name = slots[0]!;
  if (name.kind !== 'entity.name') return null;
  const haystack = text.toLowerCase().replace(/\s+/g, ' ');
  if (MUTATION_RE.test(haystack)) return null;
  const needleName = name.value.toLowerCase().replace(/\s+/g, ' ');
  if (needleName.length === 0) return null;
  const after = possessiveEnd(haystack, needleName);
  if (after !== null) {
    const remainder = haystack.slice(after);
    // A chained possessive re-targets the attribute to ANOTHER entity
    // ("<Name>'s boss's email") — defer rather than answer for <Name>.
    if (!CHAINED_POSSESSIVE_RE.test(remainder)) {
      const attribute = detectAttribute(remainder);
      if (attribute !== null) return CONTACT_ATTRIBUTE_TEMPLATES[attribute];
    }
  }
  if (matchesCompanyForm(haystack, needleName)) return CONTACT_ATTRIBUTE_TEMPLATES.company;
  return null;
};
