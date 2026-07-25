/** D-164 P6 — calendar next-meeting template family + intent-aware matcher.
 *
 *  The second real short-circuit class (after contact-attribute), and the
 *  first that reads a NON-contact warehouse collection: "when's my next
 *  meeting with `<Name>`?" resolves to the soonest FUTURE calendar event
 *  that lists the named contact as an attendee — answered with ZERO LLM
 *  calls. The entity is still resolved through the contact warehouse (the
 *  canonical cross-collection identity); the calendar read hangs off that
 *  contact's COMPLETE linked address set (canonical + merged-away, the
 *  `ContactAttributeRow.emails` completeness claim) in the probe's
 *  injected lookup — "next" is a superlative, so the minimum must range
 *  over every address the person could be invited under.
 *
 *  Why a bespoke matcher (mirrors `./contact-attribute.ts`): the
 *  slot-grammar library matches on slot multiset + locale alone and can't
 *  tell a calendar-next intent from a bare single-name mention. This
 *  module is the intent classifier for the calendar-next-meeting class —
 *  it composes with the contact-attribute matcher via the gate's
 *  `composeShortCircuitFamilies` (each family's templates carry distinct
 *  hashes, so the probe routes correctly).
 *
 *  Two-way 100% posture (design § 3 Invariant 5 / 7 — safe small gains):
 *  the matcher is deliberately TIGHT. It fires only when ALL hold:
 *    - exactly ONE `entity.name` slot (no `entity.email` / `date` / `time`
 *      — "meeting with X on 2026-07-08" carries a `date` slot → a more
 *      specific request, pass through);
 *    - the name is used in a `with <Name>` linkage (anchors "a meeting
 *      involving this person", and rejects the possessive `<Name>'s
 *      meeting` which is THEIR meeting, not necessarily with the owner);
 *    - a meeting-noun keyword is present (`meeting` / `call` / `sync` …);
 *    - an explicit NEXT cue is present (`next` / `upcoming` / `soonest`) —
 *      NOT bare `when`, so a past-tense "when WAS my meeting with X" never
 *      gets answered with a FUTURE event;
 *    - the prompt is not calendar-mutation-shaped (`schedule` / `cancel`
 *      / `reschedule` / `book` …) — a write must reach the executor
 *      (gateway / approval / audit, D-157), never short-circuit as a read.
 *  Anything it doesn't recognise passes through to the LLM; an
 *  over-extracted name is then caught by the data-presence half of the
 *  gate (the contact won't resolve, or has no future meeting). A dropped
 *  real request is a recoverable cache miss, never a wrong answer.
 *
 *  Render-only by construction (design § 3 Invariant 1/2): the template is
 *  a `render_template` — `entity.query` (the warehouse read in the probe)
 *  + body interpolation, no `ai-*`, no mutations. The `{{summary}}` /
 *  `{{when}}` placeholders are filled from the probe's frozen snapshot;
 *  the backend lookup pre-formats `when` (timezone-aware) so the renderer
 *  stays a pure string substitution.
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

/** The single render template for the calendar next-meeting class. Keyed
 *  on one `entity.name` slot; the body references the contact display
 *  name + the meeting summary + the resolved "when" string, all three
 *  supplied by the probe snapshot. `template_hash` is a stable built-in
 *  id (ships with the binary, not fetched from recued.com) used for the
 *  family probe routing + audit correlation. */
export const CALENDAR_NEXT_MEETING_TEMPLATE: RenderTemplate = {
  template_hash: 'recued/calendar-next-meeting-with@v1',
  kind: 'render_template',
  slot_grammar: ['entity.name'],
  action_class: 'read',
  short_circuit_eligible: true,
  body: 'Your next meeting with {{name}} is "{{summary}}" on {{when}}.',
};

const localizedCalendarTemplate = (
  locale: Exclude<SupportedLocale, 'en'>,
  body: string,
): RenderTemplate => ({
  ...CALENDAR_NEXT_MEETING_TEMPLATE,
  template_hash: `recued/calendar-next-meeting-with-${locale}@v1`,
  body,
});

export const CALENDAR_NEXT_MEETING_TEMPLATES_BY_LOCALE: Readonly<
  Record<SupportedLocale, RenderTemplate>
> = {
  en: CALENDAR_NEXT_MEETING_TEMPLATE,
  de: localizedCalendarTemplate(
    'de',
    'Ihre nächste Besprechung mit {{name}} ist „{{summary}}“ am {{when}}.',
  ),
  es: localizedCalendarTemplate(
    'es',
    'Tu próxima reunión con {{name}} es “{{summary}}” el {{when}}.',
  ),
  fr: localizedCalendarTemplate(
    'fr',
    'Votre prochaine réunion avec {{name}} est « {{summary}} » le {{when}}.',
  ),
  ja: localizedCalendarTemplate(
    'ja',
    '{{name}}との次の会議は「{{summary}}」で、日時は{{when}}です。',
  ),
  pt: localizedCalendarTemplate(
    'pt',
    'Sua próxima reunião com {{name}} é “{{summary}}” em {{when}}.',
  ),
  zh: localizedCalendarTemplate(
    'zh',
    '你与{{name}}的下次会议是“{{summary}}”，时间为{{when}}。',
  ),
};

const matchesLocalizedCalendar = (
  locale: SupportedLocale,
  haystack: string,
  name: string,
): boolean => {
  if (locale === 'en') return false;
  const n = escapeTemplateRegExp(name);
  const t = LOCALIZED_TAIL;
  const pattern = locale === 'de'
    ? `^(?:wann ist\\s+)?(?:meine?\\s+)?n[aä]chste\\s+(?:besprechung|termin|meeting)\\s+mit\\s+${n}${t}`
    : locale === 'es'
      ? `^[¿¡]?\\s*(?:cu[aá]ndo es\\s+)?(?:mi\\s+)?pr[oó]xima\\s+(?:reuni[oó]n|llamada|cita)\\s+con\\s+${n}${t}`
      : locale === 'fr'
        ? `^(?:quand est\\s+)?(?:ma\\s+)?prochaine\\s+(?:r[eé]union|visio|appel)\\s+avec\\s+${n}${t}`
        : locale === 'pt'
          ? `^(?:quando [eé]\\s+)?(?:(?:a )?minha\\s+)?pr[oó]xima\\s+(?:reuni[aã]o|chamada|consulta)\\s+com\\s+${n}${t}`
          : locale === 'ja'
            ? `^${n}との(?:次|今度)の(?:会議|ミーティング|通話|予定)(?:は)?いつ(?:ですか)?${t}`
            : `^(?:与|和)${n}的?(?:下次|下一次|最近的)(?:会议|通话|会面)(?:是)?(?:什么时候|何时)${t}`;
  return new RegExp(pattern, 'u').test(haystack);
};

/** Mutation / imperative verbs that turn a "meeting with `<Name>`" prompt
 *  into a WRITE — both calendar-specific actions (schedule / cancel /
 *  reschedule / book / invite / RSVP …) AND the general edit verbs a write
 *  shares with the contact-attribute class (change / update / edit /
 *  modify / set / move / postpone …). A deterministic short-circuit must
 *  NEVER silently answer a write as a read — the action has to reach the
 *  executor (gateway / approval / audit, D-157). Any match → pass through.
 *  Word-boundaried; conservative (a false reject is just a pass-through, a
 *  false accept silently drops the user's write). */
const CALENDAR_MUTATION_RE =
  /\b(?:schedule|schedules|scheduling|reschedule|reschedules|rescheduling|cancel|cancels|cancelling|canceling|book|books|booking|move|moves|moving|set up|sets up|setting up|set-up|setup|arrange|arranges|arranging|invite|invites|inviting|create|creates|creating|add|adds|adding|decline|declines|declining|rsvp|delete|deletes|deleting|remove|removes|removing|change|changes|changing|update|updates|updating|edit|edits|editing|modify|modifies|modifying|set|sets|setting|replace|replaces|replacing|rename|renames|renaming|clear|clears|clearing|reset|resets|resetting|postpone|postpones|postponing|push|pushes|pushing|shift|shifts|shifting)\b/;

/** The WHITELIST of the unconstrained next-meeting utterance: the gate
 *  fires only on the canonical contiguous shape `<next-cue> <meeting-noun>
 *  with <Name>` ENDING the prompt — no words between the cue, the noun, and
 *  the counterpart. This is deliberately a whitelist (not a blacklist of bad
 *  forms): the English NER drops single-token names / weekdays / common
 *  nouns, so a CONSTRAINED question ("next BUDGET meeting with Pat Lee",
 *  "next meeting with Pat Lee on Tuesday", "... and Bob") still carries the
 *  lone `Pat Lee` slot. Requiring the cue + noun + counterpart to be
 *  ADJACENT and the counterpart to be TRAILING rejects every such modifier
 *  (a type word between cue and noun, a constraint between noun and "with",
 *  a trailing clause / conjunction / possessive after the name). Answering a
 *  constrained question with the generic next meeting is a WRONG answer; a
 *  dropped real request is a recoverable cache miss (design § 3 Invariant 7).
 *
 *    - `<next-cue>` — `next` / `upcoming` / `soonest`. Required (not bare
 *      "when") so a past-tense "when WAS my meeting with X" never resolves to
 *      a FUTURE event.
 *    - `<meeting-noun>` — `meeting` / `call` / `sync` / `catch-up` / `1:1` /
 *      `appointment`, plus the verb `meet` ("when do I next meet with X").
 *    - `with <Name>` — the counterpart, the LAST content token (only
 *      whitespace / sentence punctuation may follow). */
const NEXT_CUE = String.raw`(?:next|upcoming|soonest)`;
// SINGULAR forms only — the template answers ONE meeting ("Your next meeting
// …"), so a PLURAL question ("what are my upcoming MEETINGS with X?") must NOT
// fire (it asks for the whole list). A trailing `s` on the noun, or the plural
// auxiliary `are` in the lead, keeps such a prompt out of the match.
const MEETING_NOUN = String.raw`(?:meeting|meet|call|sync|catch[- ]?up|1:1|appointment)`;

/** Escape a slot value for literal inclusion in the core-phrase RegExp. */
const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The start index of the canonical contiguous `<cue> <noun> with <name>`
 *  phrase, or `null`. `$`-anchored so a TRAILING constraint ("on Tuesday",
 *  "and Bob") fails the match; contiguous so a type modifier BETWEEN the cue
 *  and the noun ("budget meeting") fails it too. The returned index is the
 *  boundary the lead-allowlist check uses to validate everything BEFORE the
 *  core. Built per-call with the escaped, whitespace-collapsed name. */
const coreNextMeetingStart = (haystack: string, name: string): number | null => {
  const m = new RegExp(
    `\\b${NEXT_CUE}\\s+${MEETING_NOUN}\\s+with\\s+${escapeRegExp(name)}\\s*[?.!,;:]*$`,
  ).exec(haystack);
  return m === null ? null : m.index;
};

/** Words allowed to PRECEDE the core phrase — interrogative + auxiliary +
 *  owner-determiner + polite read-verb scaffolding. The prompt's prefix
 *  (everything before `<cue> <meeting-noun> with <name>`) must consist ONLY
 *  of these. Front-anchoring the whitelist this way rejects three wrong-answer
 *  classes at once:
 *    - a leading CONTENT phrase that reframes the question away from "when"
 *      ("what's the AGENDA for …", "WHERE is …", "WHO's coming to …", "how
 *      LONG is …") carries a word not in this set;
 *    - a NON-OWNER subject ("Sarah's …", "her …", "the team's …", "clients'
 *      …") sits in the prefix and is likewise not in this set; and
 *    - a DUPLICATE temporal cue ("my next NEXT meeting with X" asks for the
 *      meeting AFTER the immediate next) — the cue tokens (`next` / `upcoming`
 *      / `soonest`) belong to the core phrase, so they are DELIBERATELY ABSENT
 *      here; a cue in the prefix means a second, unmodeled cue.
 *  All three pass through to the LLM. The common interrogative contractions
 *  ("when's" / "what's" / "time's") are members; possessive subjects, cue
 *  duplicates, and location/agenda interrogatives ("where's" / "who's") are
 *  not. */
const ALLOWED_LEAD: ReadonlySet<string> = new Set([
  'when', "when's", 'whens', 'what', "what's", 'whats', 'is', "'s",
  'will', 'do', 'does', 'i', 'time', "time's", 'my', 'the', 'a', 'an',
  'please', 'can', 'could', 'would', 'you', 'tell', 'me', 'show', 'give',
  'us', 'find', 'get', 'list', 'see', 'know',
]);
const leadIsAllowed = (prefix: string): boolean => {
  const trimmed = prefix.trim();
  if (trimmed.length === 0) return true;
  return trimmed.split(' ').every((token) => ALLOWED_LEAD.has(token));
};

/** The calendar next-meeting `TemplateMatcher`. Fires only when the prompt is
 *  EXACTLY the canonical time question, bounded on BOTH ends:
 *    - the FULL extracted slot grammar is EXACTLY ONE `entity.name`;
 *    - it is not calendar-mutation-shaped (defence in depth — a write verb is
 *      also a non-allowed lead);
 *    - it ENDS in the contiguous `<next-cue> <meeting-noun> with <Name>`
 *      phrase (no type modifier inside, no trailing constraint after); and
 *    - everything BEFORE that phrase is allowed interrogative / determiner /
 *      polite scaffolding (no content reframe like "agenda for", no non-owner
 *      subject like "Sarah's" / "her").
 *  Anything else → `null` (pass through to the LLM). Start + end anchoring
 *  leaves no unconstrained region for an unmodeled modifier to hide in —
 *  answering a CONSTRAINED / DIFFERENT-SUBJECT / DIFFERENT-INTENT question
 *  with the generic next-meeting time is the cardinal sin; a dropped real
 *  request is a recoverable cache miss (design § 3 Invariant 7).
 *
 *  Whitespace is collapsed + lower-cased on both sides so a double-spaced or
 *  differently-cased prompt still matches the NER slot value. The match is
 *  purely lexical — no warehouse read here (that's the probe). */
export const matchCalendarNextMeetingTemplate: TemplateMatcher = ({ text, slots, locale }) => {
  if (slots.length !== 1) return null;
  const name = slots[0]!;
  if (name.kind !== 'entity.name') return null;
  const templateLocale = resolveTemplateLocale(locale);
  const haystack = normaliseTemplateText(text);
  if (hasMutationIntent(haystack) || CALENDAR_MUTATION_RE.test(haystack)) return null;
  const needleName = normaliseTemplateText(name.raw);
  if (needleName.length === 0) return null;
  const coreStart = coreNextMeetingStart(haystack, needleName);
  if (coreStart !== null && leadIsAllowed(haystack.slice(0, coreStart))) {
    return CALENDAR_NEXT_MEETING_TEMPLATES_BY_LOCALE[templateLocale];
  }
  if (matchesLocalizedCalendar(templateLocale, haystack, needleName)) {
    return CALENDAR_NEXT_MEETING_TEMPLATES_BY_LOCALE[templateLocale];
  }
  return null;
};
