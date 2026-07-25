/** Deterministic known-name span recovery.
 *
 *  Typography-only NER deliberately cannot call a lowercase `sarah`, a
 *  single-token `May`, or an initialed/compound `J. Robert Oppenheimer` a person
 *  with 100% certainty. A caller may, however, supply display names proposed by
 *  its own local entity index. This module accepts only an exact occurrence of
 *  one of those proposed values, preserving the prompt span while carrying the
 *  proposed canonical display name into the downstream unique-contact probe.
 *
 *  This is candidate recovery, not identity resolution: multiple spans survive,
 *  and the gate still requires a strict intent-template match plus a unique exact
 *  warehouse row before it renders anything. */

import type { EntityReferenceEvidence, RawSlot } from './extract.js';

/** Exact contact-reference evidence the backend may propose. Every member is
 *  deterministic and already resolved to one local contact before NER sees it. */
export type KnownEntityReferenceEvidence = EntityReferenceEvidence;

/** A caller-proved contact reference. `surface` is the exact user-authored
 *  identifier/alias to bind; `canonicalValue` is the contact's display name;
 *  `referenceKey` is an opaque warehouse identity re-checked by the probe. */
export interface KnownEntityNameCandidate {
  readonly surface: string;
  readonly canonicalValue: string;
  readonly referenceKey: string;
  readonly evidence: KnownEntityReferenceEvidence;
}

/** Backward-compatible proposal vocabulary: display-name strings retain the
 *  existing contextual-name path; structured members add exact references. */
export type KnownEntityNameProposal = string | KnownEntityNameCandidate;

/** Runtime guard used at the gate boundary. A malformed structured proposal
 * disables contextual recovery for the turn instead of being partially
 * interpreted. Length/content limits remain in the extractor. */
export const isKnownEntityNameProposal = (
  value: unknown,
): value is KnownEntityNameProposal => {
  if (typeof value === 'string') return true;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const candidate = value as Partial<KnownEntityNameCandidate>;
  return typeof candidate.surface === 'string'
    && typeof candidate.canonicalValue === 'string'
    && typeof candidate.referenceKey === 'string'
    && isReferenceEvidence(candidate.evidence);
};

/** Escape a string for literal inclusion in a regular expression. */
const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A small canonical-normalisation view with a map back to original UTF-16
 *  offsets. Grouping a starter with its following combining marks is enough to
 *  preserve the Latin-name cases this seam widens (NFC/NFD accents). Deliberately
 *  NFC, not NFKC: the contact FTS index proves canonical accent equivalence but
 *  does not promise every compatibility spelling shares one retrieval key. */
const normaliseWithOffsetMap = (
  text: string,
): {
  readonly text: string;
  readonly starts: readonly number[];
  readonly ends: readonly number[];
} => {
  let normalised = '';
  const starts: number[] = [];
  const ends: number[] = [];
  const cluster = /\P{M}\p{M}*|\p{M}+/gu;
  let match: RegExpExecArray | null = cluster.exec(text);
  while (match !== null) {
    const originalStart = match.index;
    const originalEnd = originalStart + match[0].length;
    const value = match[0].normalize('NFC');
    normalised += value;
    for (let i = 0; i < value.length; i++) {
      starts.push(originalStart);
      ends.push(originalEnd);
    }
    if (match.index === cluster.lastIndex) cluster.lastIndex += 1;
    match = cluster.exec(text);
  }
  return { text: normalised, starts, ends };
};

const codePointBefore = (text: string, position: number): string | undefined => {
  if (position <= 0) return undefined;
  const prefix = text.slice(0, position);
  const match = /.$/u.exec(prefix);
  return match?.[0];
};

const codePointAt = (text: string, position: number): string | undefined =>
  position < text.length ? /^./u.exec(text.slice(position))?.[0] : undefined;

const LATIN = /\p{Script_Extensions=Latin}/u;
const LATIN_CONTINUATION = /[\p{Script_Extensions=Latin}\p{M}\p{N}_]/u;
const NAME_JOINER = /[-‐‑‒–—'’]/u;
const KNOWN_NAME_MAX_LENGTH = 256;
const KNOWN_NAME_CANDIDATE_LIMIT = 1_000;
const REFERENCE_KEY_MAX_LENGTH = 256;
const EMAIL_CONTINUATION = /[A-Za-z0-9._%+@-]/u;
const DIGIT = /\d/u;

function isReferenceEvidence(value: unknown): value is KnownEntityReferenceEvidence {
  return (
  value === 'email'
  || value === 'e164-phone'
  || value === 'chat-alias'
  || value === 'platform-id'
  );
}

/** Words that may sit immediately before the name in one of the registered
 *  deterministic read grammars. This closes the suffix trap: a stored `Bond`
 *  must not resolve lowercase `alice bond's email`, nor stored `Bond Smith`
 *  resolve `alice bond smith's email`. New grammar may add a word here; omission
 *  is only a cache miss. Keep ambiguous modal/name words (`will`, `may`, `can`)
 *  out—the ordinary multiword candidate still works after them when it is the
 *  full stored name, while suffix recovery must tilt toward refusal. */
const CERTAIN_NAME_LEFT_CONTEXT_WORDS: ReadonlySet<string> = new Set([
  // English anchored/prepositional forms.
  'is', 'are', 'was', 'were', 'about', 'for', 'from', 'with', 'of', 'to',
  'have', 'has', 'had', 'got', 'me', 'us', 'tell', 'show', 'give', 'get',
  'find', 'know', 'please', 'does', 'did', 'and', 'or',
  "what's", 'what’s', 'whats',
  // German.
  'von', 'mit', 'arbeitet', 'ist', 'mir', 'sag', 'zeige', 'bitte', 'und', 'oder',
  // Spanish.
  'de', 'del', 'con', 'trabaja', 'es', 'dime', 'muéstrame', 'muestrame', 'y', 'o',
  // French.
  'avec', 'travaille', 'est', 'dis-moi', 'montre-moi', 'et', 'ou',
  // Portuguese.
  'do', 'da', 'dos', 'das', 'com', 'trabalha', 'é', 'diga-me', 'mostre-me', 'e',
]);

const hasCertainLeftContext = (text: string, start: number): boolean => {
  if (start === 0) return true;
  const prefix = text.slice(0, start).normalize('NFC').toLowerCase();
  const previous = /([\p{Script_Extensions=Latin}\p{M}'’-]+)\s+$/u.exec(prefix)?.[1];
  return previous === undefined || CERTAIN_NAME_LEFT_CONTEXT_WORDS.has(previous);
};

/** A known Latin name may touch Japanese/Chinese grammar (`Alice Bondの…`,
 *  `Alice Bond的…`) but must not be a substring of a longer Latin token or name
 *  atom. Quotes/dashes are accepted as punctuation unless a Latin/number unit on
 *  the other side proves they are joining the candidate to another atom. */
const hasCertainLatinBoundaries = (
  text: string,
  start: number,
  end: number,
): boolean => {
  const before = codePointBefore(text, start);
  if (before !== undefined && LATIN_CONTINUATION.test(before)) return false;
  if (before !== undefined && NAME_JOINER.test(before)) {
    const beforeJoiner = codePointBefore(text, start - before.length);
    if (beforeJoiner !== undefined && LATIN_CONTINUATION.test(beforeJoiner)) return false;
  }

  const after = codePointAt(text, end);
  if (after === undefined) return true;
  if (LATIN_CONTINUATION.test(after)) return false;
  if (!NAME_JOINER.test(after)) return true;

  const afterJoiner = codePointAt(text, end + after.length);
  if (afterJoiner === undefined || !LATIN_CONTINUATION.test(afterJoiner)) return true;
  // A possessive clitic is grammar, not another name atom. Accept `'s` only
  // when it ends there (or is followed by non-Latin punctuation/whitespace).
  if (after === "'" || after === '’') {
    if (afterJoiner === 's' || afterJoiner === 'S') {
      const afterS = codePointAt(text, end + after.length + afterJoiner.length);
      return afterS === undefined || !LATIN_CONTINUATION.test(afterS);
    }
  }
  return false;
};

/** Structured references carry stronger, type-specific boundary rules than a
 * display-name proposal. Exact email and phone runs cannot be suffixes of a
 * larger identifier; aliases retain the conservative name-atom + left-context
 * rules; platform-qualified references are one complete Latin phrase. */
const hasCertainReferenceBoundaries = (
  text: string,
  start: number,
  end: number,
  evidence: KnownEntityReferenceEvidence,
): boolean => {
  const before = codePointBefore(text, start);
  const after = codePointAt(text, end);
  if (evidence === 'email') {
    return (before === undefined || !EMAIL_CONTINUATION.test(before))
      && (after === undefined || !EMAIL_CONTINUATION.test(after));
  }
  if (evidence === 'e164-phone') {
    return (before === undefined || (before !== '+' && !DIGIT.test(before)))
      && (after === undefined || !DIGIT.test(after));
  }
  return hasCertainLeftContext(text, start)
    && hasCertainLatinBoundaries(text, start, end);
};

/** Recover exact, case-insensitive Latin-name occurrences from caller-proposed
 *  canonical display names. Whitespace is flexible and matching happens over an
 *  NFC view; returned offsets and `raw` always point into the original prompt. */
export const extractKnownNameSlots = (
  text: string,
  knownNames: readonly KnownEntityNameProposal[],
): ReadonlyArray<RawSlot> => {
  if (
    text.length === 0
    || knownNames.length === 0
    || knownNames.length > KNOWN_NAME_CANDIDATE_LIMIT
  ) return [];
  const view = normaliseWithOffsetMap(text);
  const slots: RawSlot[] = [];
  const seenCandidates = new Set<string>();

  for (const proposed of knownNames) {
    if (!isKnownEntityNameProposal(proposed)) continue;
    const structured = typeof proposed === 'string' ? null : proposed;
    const canonicalValue = typeof proposed === 'string'
      ? proposed.trim()
      : structured!.canonicalValue.trim();
    const surface = typeof proposed === 'string'
      ? canonicalValue
      : structured!.surface.trim();
    const referenceKey = structured?.referenceKey.trim();
    const evidence = structured?.evidence;
    if (
      canonicalValue.length === 0
      || canonicalValue.length > KNOWN_NAME_MAX_LENGTH
      || surface.length === 0
      || surface.length > KNOWN_NAME_MAX_LENGTH
      || (structured !== null && (
        referenceKey === undefined
        || referenceKey.length === 0
        || referenceKey.length > REFERENCE_KEY_MAX_LENGTH
        || !isReferenceEvidence(evidence)
      ))
    ) continue;
    const candidateIdentity = `${surface.normalize('NFC').toLowerCase()}\0${canonicalValue.normalize('NFC').toLowerCase()}\0${referenceKey ?? ''}\0${evidence ?? 'name'}`;
    if (seenCandidates.has(candidateIdentity)) continue;
    seenCandidates.add(candidateIdentity);

    const normalisedName = surface.normalize('NFC').trim();
    // The registered CJK language bundles already own CJK name grammar. This
    // recovery seam deliberately widens Latin names—including Latin names inside
    // CJK requests—without inventing boundary rules for unsupported scripts.
    if (structured === null && !LATIN.test(normalisedName)) continue;
    // Exact aliases/platform identifiers use the audited Latin boundary
    // discipline. Email/phone surfaces have their own typed boundaries and may
    // resolve a contact whose canonical display name uses any script.
    if (
      structured !== null
      && (evidence === 'chat-alias' || evidence === 'platform-id')
      && !LATIN.test(normalisedName)
    ) continue;
    const atoms = normalisedName.split(/\s+/u).filter((atom) => atom.length > 0);
    if (atoms.length === 0) continue;
    const pattern = atoms.map(escapeRegExp).join('\\s+');
    const regex = new RegExp(pattern, 'giu');
    let match: RegExpExecArray | null = regex.exec(view.text);
    while (match !== null) {
      const normalisedStart = match.index;
      const normalisedEnd = normalisedStart + match[0].length;
      const start = view.starts[normalisedStart];
      const end = view.ends[normalisedEnd - 1];
      // Do not accept a match that begins/ends inside one source code point's
      // normalization expansion: its mapped `raw` would be a larger value
      // than the candidate actually matched.
      const startsOnSourceBoundary = normalisedStart === 0
        || view.starts[normalisedStart - 1] !== start;
      const endsOnSourceBoundary = normalisedEnd === view.text.length
        || view.ends[normalisedEnd] !== end;
      if (
        start !== undefined
        && end !== undefined
        && startsOnSourceBoundary
        && endsOnSourceBoundary
        && (structured === null
          ? hasCertainLeftContext(text, start)
            && hasCertainLatinBoundaries(text, start, end)
          : hasCertainReferenceBoundaries(text, start, end, evidence!))
      ) {
        slots.push({
          kind: 'entity.name',
          raw: text.slice(start, end),
          position: start,
          canonicalValue,
          ...(referenceKey !== undefined ? { referenceKey } : {}),
          ...(evidence !== undefined ? { referenceEvidence: evidence } : {}),
        });
      }
      if (match.index === regex.lastIndex) regex.lastIndex += 1;
      match = regex.exec(view.text);
    }
  }
  return slots;
};
