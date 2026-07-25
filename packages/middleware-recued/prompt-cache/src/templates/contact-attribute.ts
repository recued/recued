/** D-164 P5 — contact-attribute template family + intent-aware matcher.
 *
 *  The first real short-circuit template class: single-slot contact
 *  attribute lookup — "what is `<Name>`'s email / phone / company / job
 *  title / birthday?". This is the
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
 *  me their email"). `company`, `title`, and `birthday` are HELD to
 *  stricter rules: the words are polysemous or commonly embedded in
 *  write/reminder requests — "do you enjoy
 *  `<Name>`'s company?" means companionship, not employer — so the
 *  any-lead possessive path that is safe for email/phone would fire a
 *  wrong answer there; these fields fire only on fully-anchored question
 *  FORMS. Birthday values are absolute calendar dates, never relative-time
 *  calculations.
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

/** The renderable contact attributes this family covers. Extend here +
 *  add a template below + a detector keyword to widen the class — and
 *  decide which matching rule the new attribute rides: the generic
 *  possessive path (only safe for an UNAMBIGUOUS attribute noun, like
 *  email/phone) or its own anchored forms (like company). */
export type ContactAttribute = 'email' | 'phone' | 'company' | 'title' | 'birthday';

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
  title: {
    template_hash: 'recued/contact-title-by-name@v1',
    kind: 'render_template',
    slot_grammar: ['entity.name'],
    action_class: 'read',
    short_circuit_eligible: true,
    body: "{{name}}'s job title is {{title}}.",
  },
  birthday: {
    template_hash: 'recued/contact-birthday-by-name@v1',
    kind: 'render_template',
    slot_grammar: ['entity.name'],
    action_class: 'read',
    short_circuit_eligible: true,
    // A birthday is a calendar date, not an instant. Reporting the stored
    // ISO/yearless value needs no user clock or timezone inference.
    body: "{{name}}'s birthday is {{birthday}}.",
  },
};

type ContactAttributeTemplates = Readonly<Record<ContactAttribute, RenderTemplate>>;

const localizedContactTemplates = (
  locale: Exclude<SupportedLocale, 'en'>,
  bodies: Readonly<Record<ContactAttribute, string>>,
): ContactAttributeTemplates => ({
  email: {
    ...CONTACT_ATTRIBUTE_TEMPLATES.email,
    template_hash: `recued/contact-email-by-name-${locale}@v1`,
    body: bodies.email,
  },
  phone: {
    ...CONTACT_ATTRIBUTE_TEMPLATES.phone,
    template_hash: `recued/contact-phone-by-name-${locale}@v1`,
    body: bodies.phone,
  },
  company: {
    ...CONTACT_ATTRIBUTE_TEMPLATES.company,
    template_hash: `recued/contact-company-by-name-${locale}@v1`,
    body: bodies.company,
  },
  title: {
    ...CONTACT_ATTRIBUTE_TEMPLATES.title,
    template_hash: `recued/contact-title-by-name-${locale}@v1`,
    body: bodies.title,
  },
  birthday: {
    ...CONTACT_ATTRIBUTE_TEMPLATES.birthday,
    template_hash: `recued/contact-birthday-by-name-${locale}@v1`,
    body: bodies.birthday,
  },
});

/** Locale-specific sibling bodies. The English constants above remain stable
 * for compatibility; every other locale gets a distinct auditable hash. */
export const CONTACT_ATTRIBUTE_TEMPLATES_BY_LOCALE: Readonly<
  Record<SupportedLocale, ContactAttributeTemplates>
> = {
  en: CONTACT_ATTRIBUTE_TEMPLATES,
  de: localizedContactTemplates('de', {
    email: 'Die E-Mail-Adresse von {{name}} ist {{email}}.',
    phone: 'Die Telefonnummer von {{name}} ist {{phone}}.',
    company: '{{name}} arbeitet bei {{company}}.',
    title: 'Die Berufsbezeichnung von {{name}} ist {{title}}.',
    birthday: 'Der Geburtstag von {{name}} ist {{birthday}}.',
  }),
  es: localizedContactTemplates('es', {
    email: 'El correo electrónico de {{name}} es {{email}}.',
    phone: 'El teléfono de {{name}} es {{phone}}.',
    company: '{{name}} trabaja en {{company}}.',
    title: 'El cargo de {{name}} es {{title}}.',
    birthday: 'El cumpleaños de {{name}} es {{birthday}}.',
  }),
  fr: localizedContactTemplates('fr', {
    email: 'L’adresse e-mail de {{name}} est {{email}}.',
    phone: 'Le numéro de téléphone de {{name}} est {{phone}}.',
    company: '{{name}} travaille chez {{company}}.',
    title: 'Le poste de {{name}} est {{title}}.',
    birthday: 'La date d’anniversaire de {{name}} est {{birthday}}.',
  }),
  ja: localizedContactTemplates('ja', {
    email: '{{name}}のメールアドレスは{{email}}です。',
    phone: '{{name}}の電話番号は{{phone}}です。',
    company: '{{name}}の勤務先は{{company}}です。',
    title: '{{name}}の役職は{{title}}です。',
    birthday: '{{name}}の誕生日は{{birthday}}です。',
  }),
  pt: localizedContactTemplates('pt', {
    email: 'O e-mail de {{name}} é {{email}}.',
    phone: 'O telefone de {{name}} é {{phone}}.',
    company: '{{name}} trabalha na {{company}}.',
    title: 'O cargo de {{name}} é {{title}}.',
    birthday: 'O aniversário de {{name}} é {{birthday}}.',
  }),
  zh: localizedContactTemplates('zh', {
    email: '{{name}}的电子邮件地址是{{email}}。',
    phone: '{{name}}的电话号码是{{phone}}。',
    company: '{{name}}就职于{{company}}。',
    title: '{{name}}的职位是{{title}}。',
    birthday: '{{name}}的生日是{{birthday}}。',
  }),
};

const matchLocalizedContactAttribute = (
  locale: SupportedLocale,
  haystack: string,
  name: string,
): ContactAttribute | null => {
  if (locale === 'en') return null;
  const n = escapeTemplateRegExp(name);
  const t = LOCALIZED_TAIL;
  const patterns: ReadonlyArray<readonly [ContactAttribute, RegExp]> = locale === 'de'
    ? [
      ['email', new RegExp(`^(?:was ist|wie lautet)\\s+(?:die\\s+)?e-?mail-?adresse\\s+von\\s+${n}${t}`, 'u')],
      ['phone', new RegExp(`^(?:was ist|wie lautet)\\s+(?:die\\s+)?telefonnummer\\s+von\\s+${n}${t}`, 'u')],
      ['company', new RegExp(`^wo arbeitet\\s+${n}${t}`, 'u')],
      ['title', new RegExp(`^(?:was ist|wie lautet)\\s+(?:die\\s+)?berufsbezeichnung\\s+von\\s+${n}${t}`, 'u')],
      ['birthday', new RegExp(`^wann hat\\s+${n}\\s+geburtstag${t}`, 'u')],
    ]
    : locale === 'es'
      ? [
        ['email', new RegExp(`^[¿¡]?\\s*(?:cu[aá]l es|dime)\\s+(?:el\\s+)?(?:correo electr[oó]nico|correo|e-?mail)\\s+de\\s+${n}${t}`, 'u')],
        ['phone', new RegExp(`^[¿¡]?\\s*(?:cu[aá]l es|dime)\\s+(?:el\\s+)?(?:tel[eé]fono|n[uú]mero de tel[eé]fono)\\s+de\\s+${n}${t}`, 'u')],
        ['company', new RegExp(`^[¿¡]?\\s*d[oó]nde trabaja\\s+${n}${t}`, 'u')],
        ['title', new RegExp(`^[¿¡]?\\s*cu[aá]l es\\s+(?:el\\s+)?cargo\\s+de\\s+${n}${t}`, 'u')],
        ['birthday', new RegExp(`^[¿¡]?\\s*cu[aá]ndo es\\s+(?:el\\s+)?cumplea[nñ]os\\s+de\\s+${n}${t}`, 'u')],
      ]
      : locale === 'fr'
        ? [
          ['email', new RegExp(`^quelle est\\s+(?:l['’]adresse\\s+e-?mail|le courriel)\\s+de\\s+${n}${t}`, 'u')],
          ['phone', new RegExp(`^quel est\\s+(?:le\\s+)?(?:num[eé]ro de )?t[eé]l[eé]phone\\s+de\\s+${n}${t}`, 'u')],
          ['company', new RegExp(`^o[uù] travaille\\s+${n}${t}`, 'u')],
          ['title', new RegExp(`^quel est\\s+(?:le\\s+)?poste\\s+de\\s+${n}${t}`, 'u')],
          ['birthday', new RegExp(`^quand est\\s+l['’]anniversaire\\s+de\\s+${n}${t}`, 'u')],
        ]
        : locale === 'pt'
          ? [
            ['email', new RegExp(`^qual [eé]\\s+(?:o\\s+)?e-?mail\\s+d[eo]\\s+${n}${t}`, 'u')],
            ['phone', new RegExp(`^qual [eé]\\s+(?:o\\s+)?(?:telefone|n[uú]mero de telefone)\\s+d[eo]\\s+${n}${t}`, 'u')],
            ['company', new RegExp(`^onde trabalha\\s+${n}${t}`, 'u')],
            ['title', new RegExp(`^qual [eé]\\s+(?:o\\s+)?cargo\\s+d[eo]\\s+${n}${t}`, 'u')],
            ['birthday', new RegExp(`^quando [eé]\\s+(?:o\\s+)?anivers[aá]rio\\s+d[eo]\\s+${n}${t}`, 'u')],
          ]
          : locale === 'ja'
            ? [
              ['email', new RegExp(`^${n}のメール(?:アドレス)?(?:は|を)?(?:何ですか|教えて|確認して)?${t}`, 'u')],
              ['phone', new RegExp(`^${n}の電話番号(?:は|を)?(?:何ですか|教えて|確認して)?${t}`, 'u')],
              ['company', new RegExp(`^${n}の(?:勤務先|会社)(?:は|を)?(?:どこですか|教えて|確認して)?${t}`, 'u')],
              ['title', new RegExp(`^${n}の役職(?:は|を)?(?:何ですか|教えて|確認して)?${t}`, 'u')],
              ['birthday', new RegExp(`^${n}の誕生日(?:は|を)?(?:いつですか|教えて|確認して)?${t}`, 'u')],
            ]
            : [
              ['email', new RegExp(`^(?:请问)?${n}的(?:邮箱|电子邮件地址?)(?:是)?(?:什么|多少)?${t}`, 'u')],
              ['phone', new RegExp(`^(?:请问)?${n}的(?:电话号码|手机号)(?:是)?(?:什么|多少)?${t}`, 'u')],
              ['company', new RegExp(`^(?:请问)?${n}的(?:公司|雇主)(?:是)?(?:什么|哪家)?${t}`, 'u')],
              ['title', new RegExp(`^(?:请问)?${n}的(?:职位|职务)(?:是)?什么${t}`, 'u')],
              ['birthday', new RegExp(`^(?:请问)?${n}的生日(?:是)?(?:什么时候|哪天)${t}`, 'u')],
            ];
  return patterns.find(([, pattern]) => pattern.test(haystack))?.[0] ?? null;
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

/** The two added personal fields deliberately do not ride the permissive
 * possessive keyword path. Bare `title` is polysemous and birthdays are often
 * embedded in reminder/write requests, so both require a whole-prompt read
 * question. A calendar birthday is absolute date data; no current-time or
 * timezone context is consulted. */
const matchEnglishTitleOrBirthday = (
  haystack: string,
  name: string,
): Extract<ContactAttribute, 'title' | 'birthday'> | null => {
  const esc = escapeRegExp(name);
  const tail = String.raw`\s*[?.!]*$`;
  if (
    new RegExp(`^what(?:['’]s| is)\\s+${esc}['’]s\\s+job\\s+title${tail}`).test(haystack)
    || new RegExp(`^what\\s+job\\s+title\\s+does\\s+${esc}\\s+have${tail}`).test(haystack)
  ) return 'title';
  if (
    new RegExp(`^when\\s+is\\s+${esc}['’]s\\s+birthday${tail}`).test(haystack)
    || new RegExp(`^what(?:['’]s| is)\\s+${esc}['’]s\\s+birthday${tail}`).test(haystack)
    || new RegExp(`^what(?:['’]s| is)\\s+${esc}['’]s\\s+date\\s+of\\s+birth${tail}`).test(haystack)
  ) return 'birthday';
  return null;
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

/** The possessive attribute core used to admit ANY leading text. That let a
 * second request hide before an otherwise-valid tail ("how many emails? what
 * is Pat's email?") and short-circuit the turn with only the last answer.
 * Keep bare/polite/code-switched forms and harmless comma/colon discourse
 * preludes, but require the final segment to be read-question scaffolding and
 * reject any earlier query or completed sentence. */
const POSSESSIVE_LEAD_WORDS: ReadonlySet<string> = new Set([
  // English
  'what', "what's", 'what’s', 'whats', 'about', 'is', 'are', 'do', 'does', 'have',
  'has', 'got', 'i', 'we', 'you', 'the', 'please', 'can', 'could', 'would',
  'will', 'tell', 'show', 'give', 'get', 'find', 'know', 'me', 'us',
  // German / Spanish / French / Portuguese code-switch scaffolding
  'was', 'ist', 'wie', 'lautet', 'sag', 'mir', 'zeige', 'bitte',
  'cuál', 'cual', 'es', 'dime', 'muéstrame', 'muestrame', 'por', 'favor',
  'quel', 'quelle', 'est', 'dis-moi', 'montre-moi', "s'il", 's’il', 'vous',
  'plaît', 'plait', 'qual', 'é', 'diga-me', 'mostre-me',
  // CJK code-switch scaffolding remains a single token.
  '教えて', '確認して', '请问', '告诉我',
]);

const POSSESSIVE_LEAD_OPENERS: ReadonlySet<string> = new Set([
  'what', "what's", 'what’s', 'whats', 'is', 'are', 'do', 'does', 'have',
  'has', 'please', 'can', 'could', 'would', 'will', 'tell', 'show', 'give',
  'get', 'find', 'was', 'wie', 'sag', 'zeige', 'bitte', 'cuál', 'cual',
  'dime', 'muéstrame', 'muestrame', 'quel', 'quelle', 'dis-moi',
  'montre-moi', 'qual', 'diga-me', 'mostre-me', '教えて', '確認して', '请问',
  '告诉我',
]);

const LATIN_QUERY_IN_PRELUDE_RE = /(?<!\p{L})(?:what|when|where|who|why|how|tell|show|give|find|search|list|do|does|did|can|could|would|will|e-?mails?|phone|meeting|wie|wann|was|wo|nachrichten|besprechung|cu[aá]ntos?|cu[aá]l|d[oó]nde|dime|muestra|correos?|mensajes?|reuni[oó]n|combien|quel(?:le)?|quand|dis-moi|montre|courriels?|r[eé]union|quantos?|qual|quando|onde|mostre|mensagens?|reuni[aã]o)(?!\p{L})/iu;
const CJK_QUERY_IN_PRELUDE_RE = /(?:何通|何件|メール|メッセージ|会議|電話番号|多少封|多少个|几封|邮件|消息|会议|邮箱|电子邮件)/u;

const possessiveLeadIsAllowed = (prefix: string): boolean => {
  // A completed earlier sentence/question is always another clause, never a
  // harmless lead into this one attribute lookup.
  if (/[?!.。？！]/u.test(prefix)) return false;
  const segments = prefix.split(/[,;:]/u);
  const trimmed = (segments.pop() ?? '').trim().replace(/^[¿¡]\s*/u, '');
  const prelude = segments.join(' ');
  if (LATIN_QUERY_IN_PRELUDE_RE.test(prelude) || CJK_QUERY_IN_PRELUDE_RE.test(prelude)) {
    return false;
  }
  if (trimmed.length === 0) return true;
  const tokens = trimmed.split(' ');
  return POSSESSIVE_LEAD_OPENERS.has(tokens[0]!)
    && tokens.every((token) => POSSESSIVE_LEAD_WORDS.has(token));
};

interface PossessiveReference {
  readonly start: number;
  readonly end: number;
}

/** Locate the user's POSSESSIVE reference to the named contact. Returns its
 * start plus the index immediately AFTER the possessive clitic, or `null`
 * when the name isn't used possessively. Handles straight/curly apostrophes.
 * The caller validates the complete lead and searches only the remainder. */
const possessiveReference = (haystack: string, name: string): PossessiveReference | null => {
  for (const clitic of ["'s", '’s']) {
    const needle = name + clitic;
    const idx = haystack.indexOf(needle);
    if (idx !== -1) return { start: idx, end: idx + needle.length };
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
export const matchContactAttributeTemplate: TemplateMatcher = ({ text, slots, locale }) => {
  if (slots.length !== 1) return null;
  const name = slots[0]!;
  if (name.kind !== 'entity.name') return null;
  const templateLocale = resolveTemplateLocale(locale);
  const templates = CONTACT_ATTRIBUTE_TEMPLATES_BY_LOCALE[templateLocale];
  const haystack = normaliseTemplateText(text);
  if (hasMutationIntent(haystack) || MUTATION_RE.test(haystack)) return null;
  // Match the USER'S surface (`raw`), not the canonical warehouse display
  // name (`value`). Exact identifier/alias proposals intentionally carry a
  // different canonical value for the probe while the grammar still contains
  // the typed email/phone/alias span.
  const needleName = normaliseTemplateText(name.raw);
  if (needleName.length === 0) return null;
  const possessive = possessiveReference(haystack, needleName);
  if (possessive !== null && possessiveLeadIsAllowed(haystack.slice(0, possessive.start))) {
    const remainder = haystack.slice(possessive.end);
    // A chained possessive re-targets the attribute to ANOTHER entity
    // ("<Name>'s boss's email") — defer rather than answer for <Name>.
    if (!CHAINED_POSSESSIVE_RE.test(remainder)) {
      const attribute = detectAttribute(remainder);
      if (attribute !== null) return templates[attribute];
    }
  }
  if (matchesCompanyForm(haystack, needleName)) return templates.company;
  const sensitive = templateLocale === 'en'
    ? matchEnglishTitleOrBirthday(haystack, needleName)
    : null;
  if (sensitive !== null) return templates[sensitive];
  const localized = matchLocalizedContactAttribute(templateLocale, haystack, needleName);
  if (localized !== null) return templates[localized];
  return null;
};
