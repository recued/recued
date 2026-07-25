/** D-164 P7 — mail from-count template family + intent-aware matcher.
 *
 *  The third real short-circuit class (after contact-attribute + calendar
 *  next-meeting), and the second reading a NON-contact warehouse collection:
 *  "how many emails from `<Name>`?" resolves to the precise count of mail
 *  records whose sender is the named contact — answered with ZERO LLM calls.
 *  The entity is resolved through the contact warehouse (the canonical
 *  cross-collection identity, shared with the other two classes); the mail
 *  count hangs off that resolved email in the probe's injected lookup.
 *
 *  Why a bespoke matcher (mirrors `./calendar-next-meeting.ts`): the
 *  slot-grammar library matches on slot multiset + locale alone and can't
 *  tell a count intent from a bare single-name mention. This module is the
 *  intent classifier for the from-count class — it composes with the other
 *  families via the gate's `composeShortCircuitFamilies` (each family's
 *  template carries a distinct hash, so the probe routes correctly).
 *
 *  Two-way 100% posture (design § 3 Invariant 5 / 7 — safe small gains):
 *  the matcher is a deliberately TIGHT WHITELIST anchored on BOTH ends, so
 *  no unconstrained region can hide an unmodeled modifier. It fires only
 *  when ALL hold:
 *    - exactly ONE `entity.name` slot (no `entity.email` / `date` / `time`
 *      — "emails from X since 2026-01-01" carries a `date` slot → a more
 *      specific request, pass through);
 *    - the prompt ENDS in the contiguous `<count-cue> <mail-noun> <middle?>
 *      from <Name>` phrase — the count-cue (`how many` / `number of` / …)
 *      directly followed by a mail-noun (`emails` / `mail` …) with NO
 *      modifier between them (rejects a FILTERED count like "how many
 *      UNREAD emails from X"), an OPTIONAL allowlisted middle (the
 *      first-person have/get scaffolding "do I have" / "have I gotten"),
 *      then `from <Name>` as the LAST content (rejects a trailing
 *      constraint / conjunction / possessive after the name);
 *    - everything BEFORE the cue is allowed interrogative / determiner /
 *      polite scaffolding (`ALLOWED_LEAD`); and
 *    - the prompt is not mail-mutation-shaped (`delete` / `archive` /
 *      `mark` / … — a write must reach the executor, never short-circuit
 *      as a read).
 *  Anything it doesn't recognise passes through to the LLM; an
 *  over-extracted name is then caught by the data-presence half of the
 *  gate (the contact won't resolve). A dropped real request is a
 *  recoverable cache miss; answering a CONSTRAINED / DIFFERENT-SUBJECT /
 *  DIFFERENT-INTENT question with the generic total is the cardinal sin
 *  (design § 3 Invariant 7).
 *
 *  `from`-only, sender-only by design. The count is over `from <Name>` —
 *  the SENDER. "emails TO X" (recipient) carries no `from <Name>` core →
 *  passes through. Read-state / content filters ("unread", "about budget")
 *  and partitive framings ("how many of my emails are from X") also pass
 *  through (a filtered or differently-shaped count the total can't answer).
 *
 *  Render-only by construction (design § 3 Invariant 1/2): the template is a
 *  `render_template` — `entity.query` (the warehouse read in the probe) +
 *  body interpolation, no `ai-*`, no mutations. English uses the
 *  probe-pluralized `{{count_phrase}}`; localized bodies use the grammar-
 *  neutral string `{{count}}`. `{{name}}` is the resolved display name.
 *
 *  PERSON-scoped answer (the load-bearing honesty design, v2). v1 counted the
 *  contact's ONE resolved canonical address and therefore NAMED it in the body
 *  ("… from Pat Lee (pat@x.com).") — a person can send from more than one
 *  address (a merged contact, an alias), so a person-named total over one
 *  address would have over-claimed completeness. v2 drops the address scope
 *  because the COUNT now covers EVERY address Recued links to the contact
 *  (the v1 header's stated precondition for dropping `{{email}}`):
 *    - the probe requires `ContactAttributeRow.emails` — the port's explicit
 *      completeness claim (canonical + D-138 merged-away tombstone addresses)
 *      — and DEFERS when the port can't make it;
 *    - a SECOND same-named contact Recued has NOT merged still defers via the
 *      shared unique-exact-contact rule (mail from an unlinked address creates
 *      its own contact row from the From header, so a same-named sender either
 *      merged into this contact — counted — or is a duplicate — defer);
 *    - what remains outside the set is mail from a DIFFERENTLY-NAMED sender
 *      record, which the question's name can't reach deterministically on any
 *      path — the same epistemic boundary the LLM's contact.search → mail
 *      count walk has.
 *  So "You have 2 emails from Pat Lee." is now scoped to exactly what the
 *  system can honestly claim about the PERSON. Do NOT re-introduce a
 *  single-address count behind this body — the probe's `emails` requirement
 *  is the guard.
 *
 *  See: D-164 § 3. */

import type { TemplateMatcher } from '../gate/index.js';
import type { RenderTemplate } from '../types.js';
import {
  escapeTemplateRegExp,
  hasMutationIntent,
  LOCALIZED_TAIL,
  normaliseTemplateText,
  resolveTemplateLocale,
  type SupportedLocale,
} from './locales.js';

/** The single render template for the mail from-count class. Keyed on one
 *  `entity.name` slot; the body references the probe-pluralized count phrase
 *  and the contact display name — person-scoped because the probe's count
 *  covers every linked address (the honesty design — see the file header).
 *  `template_hash` is a stable built-in id (ships with the binary, not
 *  fetched from recued.com) used for the family probe routing + audit
 *  correlation; bumped to `@v2` with the address-scope drop so audit rows
 *  distinguish the two answer semantics. */
export const MAIL_FROM_COUNT_TEMPLATE: RenderTemplate = {
  template_hash: 'recued/mail-from-count-by-name@v2',
  kind: 'render_template',
  slot_grammar: ['entity.name'],
  action_class: 'read',
  short_circuit_eligible: true,
  body: 'You have {{count_phrase}} from {{name}}.',
};

const localizedMailCountTemplate = (
  locale: Exclude<SupportedLocale, 'en'>,
  body: string,
): RenderTemplate => ({
  ...MAIL_FROM_COUNT_TEMPLATE,
  template_hash: `recued/mail-from-count-by-name-${locale}@v2`,
  body,
});

export const MAIL_FROM_COUNT_TEMPLATES_BY_LOCALE: Readonly<
  Record<SupportedLocale, RenderTemplate>
> = {
  en: MAIL_FROM_COUNT_TEMPLATE,
  de: localizedMailCountTemplate('de', 'Anzahl der E-Mails von {{name}}: {{count}}.'),
  es: localizedMailCountTemplate('es', 'Número de correos de {{name}}: {{count}}.'),
  fr: localizedMailCountTemplate('fr', 'Nombre d’e-mails de {{name}} : {{count}}.'),
  ja: localizedMailCountTemplate('ja', '{{name}}からのメール件数：{{count}}件。'),
  pt: localizedMailCountTemplate('pt', 'Número de e-mails de {{name}}: {{count}}.'),
  zh: localizedMailCountTemplate('zh', '来自{{name}}的邮件数量：{{count}}。'),
};

const matchesLocalizedMailCount = (
  locale: SupportedLocale,
  haystack: string,
  name: string,
): boolean => {
  if (locale === 'en') return false;
  const n = escapeTemplateRegExp(name);
  const t = LOCALIZED_TAIL;
  const pattern = locale === 'de'
    ? `^wie viele\\s+(?:e-?mails?|nachrichten)\\s+(?:habe ich\\s+)?von\\s+${n}${t}`
    : locale === 'es'
      ? `^[¿¡]?\\s*cu[aá]ntos?\\s+(?:correos?|mensajes?)\\s+(?:tengo\\s+)?de\\s+${n}${t}`
      : locale === 'fr'
        ? `^combien\\s+(?:d['’]|de\\s+)(?:e-?mails?|courriels?|messages?)\\s+(?:ai-je\\s+)?de\\s+${n}${t}`
        : locale === 'pt'
          ? `^quantos?\\s+(?:e-?mails?|mensagens?)\\s+(?:(?:eu\\s+)?tenho\\s+)?d[eo]\\s+${n}${t}`
          : locale === 'ja'
            ? `^${n}からの(?:メール|メッセージ)(?:は|が)?(?:何通|何件)(?:ありますか)?${t}`
            : `^(?:来自|从)${n}的(?:邮件|电子邮件|消息)(?:有)?(?:多少封|多少个|几封)${t}`;
  return new RegExp(pattern, 'u').test(haystack);
};

/** Mutation / imperative verbs that turn a "emails from `<Name>`" prompt
 *  into a WRITE (delete / archive / mark / move / forward / …). A count
 *  question is inherently a read, so the cue + the lead/middle allowlists
 *  already reject most writes; this is defence in depth — a deterministic
 *  short-circuit must NEVER silently answer a write as a read (the action
 *  has to reach the executor — gateway / approval / audit, D-157). Any
 *  match → pass through. Word-boundaried; conservative (a false reject is
 *  just a pass-through, a false accept silently drops the user's write). */
const MAIL_MUTATION_RE =
  /\b(?:delete|deletes|deleting|archive|archives|archiving|trash|trashes|trashing|remove|removes|removing|mark|marks|marking|move|moves|moving|flag|flags|flagging|star|stars|starring|forward|forwards|forwarding|reply|replies|replying|send|sends|sending|draft|drafts|drafting|compose|composes|composing|unsubscribe|unsubscribes|unsubscribing|file|files|filing|label|labels|labeling|sort|sorts|sorting|clear|clears|clearing|snooze|snoozes|snoozing|mute|mutes|muting|block|blocks|blocking)\b/;

/** The COUNT cue — `how many` / `how much` / `number of` / `count of`. One
 *  is REQUIRED (not a bare "emails from X", which is a LIST request, not a
 *  count) and it must directly precede the mail-noun (no modifier between). */
const COUNT_CUE = String.raw`(?:how many|how much|number of|count of)`;

/** The mail-noun — `email(s)` / `e-mail(s)` / `mail(s)`. DELIBERATELY
 *  EXCLUDES `message(s)`: in a personal-data assistant "messages" is
 *  ambiguous (chat / SMS vs mail), and the count is over `data.mail` only —
 *  answering a chat-message question with a mail count is a wrong answer.
 *  Singular forms are admitted ("how much mail") but the cue+noun adjacency
 *  is what carries intent, not grammatical number. */
const MAIL_NOUN = String.raw`(?:e-?mails?|mails?)`;

/** Escape a slot value for literal inclusion in the core-phrase RegExp. */
const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Locate the canonical contiguous `<count-cue> <mail-noun> <middle?> from
 *  <name>` phrase, `$`-anchored, and return its start index + the raw middle
 *  region (between the noun and `from`), or `null`.
 *
 *  `$`-anchored so a TRAILING constraint ("... since Monday", "... and Bob",
 *  "... that are unread") fails the match; cue+noun contiguous so a type
 *  modifier BETWEEN them ("how many UNREAD emails") fails it too. The middle
 *  is captured (not baked in) so the caller can allowlist-validate it exactly
 *  like the lead — nothing unmodeled can hide in either region. Built
 *  per-call with the escaped, whitespace-collapsed name. */
const coreMailCountStart = (
  haystack: string,
  name: string,
): { readonly index: number; readonly middle: string } | null => {
  const m = new RegExp(
    `\\b${COUNT_CUE}\\s+${MAIL_NOUN}\\s+(.*?)\\bfrom\\s+${escapeRegExp(name)}\\s*[?.!,;:]*$`,
  ).exec(haystack);
  if (m === null) return null;
  return { index: m.index, middle: m[1] ?? '' };
};

/** Words allowed to PRECEDE the count cue — interrogative + auxiliary +
 *  determiner + polite scaffolding. The prompt's prefix (everything before
 *  `<count-cue>`) must consist ONLY of these. Front-anchoring the whitelist
 *  rejects a leading CONTENT phrase that reframes the question and a
 *  NON-OWNER subject at once. The cue tokens themselves (`how` / `many` /
 *  `much` / `number` / `count` / `of`) are DELIBERATELY ABSENT — they belong
 *  to the core phrase, so a cue token in the prefix means a second, unmodeled
 *  cue. `total` is admitted ("the total number of emails from X") because it
 *  qualifies the count's magnitude, not WHICH emails are counted. */
const ALLOWED_LEAD: ReadonlySet<string> = new Set([
  'so', 'ok', 'okay', 'hey', 'and', 'also', 'well', 'just',
  'please', 'can', 'could', 'would', 'will', 'you', 'tell', 'me',
  'show', 'give', 'us', 'find', 'get', 'list', 'see', 'know',
  'do', 'does', 'i', 'we', 'what', "what's", 'whats', 'is', "'s",
  'the', 'a', 'an', 'total',
]);
const leadIsAllowed = (prefix: string): boolean => {
  const trimmed = prefix.trim();
  if (trimmed.length === 0) return true;
  return trimmed.split(' ').every((token) => ALLOWED_LEAD.has(token));
};

/** Words allowed in the MIDDLE region (between the mail-noun and `from`) —
 *  FIRST-PERSON have/get scaffolding only: auxiliaries, the first-person
 *  subject (`i` / `we`), and receive-verbs. The region may be empty ("emails
 *  from X"). DELIBERATELY EXCLUDES:
 *    - third-person / non-owner subjects (`she` / `he` / `they` / `you` /
 *      `her` / `him`) — "how many emails does SHE have from X" is HER count,
 *      not the owner's;
 *    - read-state verbs (`read` / `seen`) — "emails I've READ from X" is a
 *      read-state-FILTERED count, not the total;
 *    - content / filter words (`unread` / `about` / `regarding` / `new` / …)
 *      — likewise a filtered count the total can't answer.
 *  All pass through to the LLM. Keeping this region an allowlist (like the
 *  lead) is the load-bearing correctness design — the count is the TOTAL
 *  from the sender, so any subject/state/content qualifier must drop the
 *  short-circuit, never silently narrow it. */
const ALLOWED_MIDDLE: ReadonlySet<string> = new Set([
  'do', 'does', 'did', 'have', 'has', 'had', 'i', 'we',
  'got', 'get', 'gotten', 'receive', 'received',
  'are', 'is', 'was', 'were', 'been', 'there', 'ever',
  "i've", "we've",
]);
const middleIsAllowed = (middle: string): boolean => {
  const trimmed = middle.trim();
  if (trimmed.length === 0) return true;
  return trimmed.split(' ').every((token) => ALLOWED_MIDDLE.has(token));
};

/** The mail from-count `TemplateMatcher`. Fires only when the prompt is
 *  EXACTLY the canonical count question, bounded on BOTH ends:
 *    - the FULL extracted slot grammar is EXACTLY ONE `entity.name`;
 *    - it is not mail-mutation-shaped (defence in depth — a write verb is
 *      also a non-allowed lead / middle token);
 *    - it ENDS in the contiguous `<count-cue> <mail-noun> <middle?> from
 *      <Name>` phrase (no modifier between cue and noun, no trailing
 *      constraint after the name);
 *    - everything BEFORE the cue is allowed interrogative / determiner /
 *      polite scaffolding (no content reframe, no non-owner subject); and
 *    - the middle region (between noun and `from`) is allowed first-person
 *      have/get scaffolding only (no third-person subject, no read-state /
 *      content filter).
 *  Anything else → `null` (pass through to the LLM). Start + end anchoring +
 *  the two allowlisted regions leave no unconstrained region for an unmodeled
 *  modifier to hide in — answering a CONSTRAINED / DIFFERENT question with
 *  the generic total is the cardinal sin (design § 3 Invariant 7).
 *
 *  Whitespace is collapsed + lower-cased on both sides so a double-spaced or
 *  differently-cased prompt still matches the NER slot value. The match is
 *  purely lexical — no warehouse read here (that's the probe). */
export const matchMailFromCountTemplate: TemplateMatcher = ({ text, slots, locale }) => {
  if (slots.length !== 1) return null;
  const name = slots[0]!;
  if (name.kind !== 'entity.name') return null;
  const templateLocale = resolveTemplateLocale(locale);
  const haystack = normaliseTemplateText(text);
  if (hasMutationIntent(haystack) || MAIL_MUTATION_RE.test(haystack)) return null;
  const needleName = normaliseTemplateText(name.raw);
  if (needleName.length === 0) return null;
  const core = coreMailCountStart(haystack, needleName);
  if (
    core !== null
    && leadIsAllowed(haystack.slice(0, core.index))
    && middleIsAllowed(core.middle)
  ) {
    return MAIL_FROM_COUNT_TEMPLATES_BY_LOCALE[templateLocale];
  }
  if (matchesLocalizedMailCount(templateLocale, haystack, needleName)) {
    return MAIL_FROM_COUNT_TEMPLATES_BY_LOCALE[templateLocale];
  }
  return null;
};
