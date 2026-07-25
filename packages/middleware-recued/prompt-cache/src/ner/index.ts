/** D-164 P4d — NER substrate public surface.
 *
 *  `extract(text, opts?) → ExtractionResult | null` composes the raw
 *  per-language extractor + the binary certainty gate. The deterministic
 *  gate (`../gate/`) calls this with either the user prompt or the
 *  referent-span text picked by the intention router (P4c) — NER
 *  itself is text-in / certain-slots-out and never reaches into ctx.
 *
 *  Language ladder:
 *    - a supported explicit `opts.locale` is the strongest primary-locale
 *      signal (normalised to its BCP-47 primary tag);
 *    - otherwise intent-bearing lexical cues select the response/template
 *      locale, script and orthography add extraction candidates, and English
 *      is the final fallback;
 *    - every evidenced candidate bundle runs and spans are deduplicated, so a
 *      mixed prompt is never forced through a single whole-sentence language.
 *
 *  Return contract:
 *    - `null` when the certainty gate accepts zero slots (the binary
 *      "pass through to LLM" signal — design § 3 Invariant 5).
 *    - `ExtractionResult` carries surviving slots, the primary locale, and
 *      the ordered candidate ladder for caller diagnostics/template matching.
 *
 *  See: D-164
 *  § 1 ner / § 3 the deterministic gate. */

import { extractUniversalRawSlots, type RawSlot } from './extract.js';
import { gateExtraction, type SlotValue } from './confidence.js';
import {
  detectLanguages,
  type SupportedLocale,
} from './language-detection.js';
import { DE_RULES } from './languages/de.js';
import { EN_RULES } from './languages/en.js';
import { ES_RULES } from './languages/es.js';
import { FR_RULES } from './languages/fr.js';
import { JA_RULES } from './languages/ja.js';
import { PT_RULES } from './languages/pt.js';
import { ZH_RULES } from './languages/zh.js';
import {
  extractKnownNameSlots,
  type KnownEntityNameProposal,
} from './known-names.js';

export {
  type EntityReferenceEvidence,
  type SlotKind,
  type RawSlot,
  type LanguageRules,
} from './extract.js';
export { type SlotValue, gateOne, gateExtraction } from './confidence.js';
export {
  isKnownEntityNameProposal,
  type KnownEntityNameCandidate,
  type KnownEntityNameProposal,
  type KnownEntityReferenceEvidence,
} from './known-names.js';

/** Registered lowercase BCP-47 primary tag → rule bundle. Detection orders
 * candidates; registry insertion order has no semantic meaning. */
const LANGUAGE_REGISTRY: ReadonlyMap<SupportedLocale, typeof EN_RULES> = new Map([
  ['en', EN_RULES],
  ['es', ES_RULES],
  ['fr', FR_RULES],
  ['de', DE_RULES],
  ['ja', JA_RULES],
  ['zh', ZH_RULES],
  ['pt', PT_RULES],
]);

/** Output of `extract` when the certainty gate accepts at least one
 *  slot. `slots` retains the order returned by the gate (regex
 *  discovery order: universal patterns first, language slots last).
 *  `locale` is the primary intent/template language. */
export interface ExtractionResult {
  readonly slots: ReadonlyArray<SlotValue>;
  readonly locale: SupportedLocale;
  /** Ordered evidence ladder. The first item is always `locale`; later
   * candidates may contribute entity spans in a mixed-language prompt. */
  readonly localeCandidates: ReadonlyArray<SupportedLocale>;
}

/** Optional inputs to `extract`. */
export interface ExtractOptions {
  readonly locale?: string;
  /** Canonical display names proposed by a deterministic caller-owned index.
   *  Only exact occurrences are recovered; candidates that do not occur in the
   *  text are inert. Identity + uniqueness remain the data probe's job. */
  readonly knownNames?: readonly KnownEntityNameProposal[];
}

const normaliseNameIdentity = (slot: RawSlot): string =>
  `${(slot.canonicalValue ?? slot.raw)
    .normalize('NFC')
    .trim()
    .replace(/\s+/gu, ' ')
    .toLowerCase()}\0${slot.referenceKey ?? ''}\0${slot.referenceEvidence ?? ''}`;

/** Run the NER substrate over `text`.
 *
 *  Steps:
 *    1. Detect a primary intent locale and an ordered evidence ladder.
 *    2. Collect universal spans once, then merge every candidate bundle.
 *    3. Apply the certainty gate.
 *    4. Return `null` when zero slots survive, otherwise the result
 *       envelope.
 *
 *  Idempotent / pure: same inputs → same output. The function does
 *  not memoise — callers running it once per turn don't need a cache. */
export const extract = (
  text: string,
  opts?: ExtractOptions,
): ExtractionResult | null => {
  const detection = detectLanguages(text, opts?.locale);
  const raws: RawSlot[] = [...extractUniversalRawSlots(text)];
  const seen = new Set(raws.map((slot) => `${slot.kind}\0${slot.position}\0${slot.raw}`));
  for (const locale of detection.localeCandidates) {
    const language = LANGUAGE_REGISTRY.get(locale);
    if (language === undefined) continue;
    for (const slot of language.extract(text)) {
      const key = `${slot.kind}\0${slot.position}\0${slot.raw}`;
      if (seen.has(key)) continue;
      seen.add(key);
      raws.push(slot);
    }
  }
  for (const slot of extractKnownNameSlots(text, opts?.knownNames ?? [])) {
    const key = `${slot.kind}\0${slot.position}\0${slot.raw}\0${slot.canonicalValue ?? ''}\0${slot.referenceKey ?? ''}\0${slot.referenceEvidence ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    raws.push(slot);
  }
  // An exact email reference is first emitted by the universal extractor as
  // `entity.email`, then independently proven by the caller as the contact's
  // `entity.name` reference over the SAME span. Keep the stronger identity-
  // bound slot only. Non-resolving addresses retain their ordinary email slot,
  // preserving write/multi-intent guards everywhere else.
  const referenceEmailSpans = new Set(
    raws
      .filter((slot) => slot.kind === 'entity.name' && slot.referenceKey !== undefined)
      .map((slot) => `${slot.position}\0${slot.raw.length}`),
  );
  const withoutBoundEmails = raws.filter((slot) =>
    slot.kind !== 'entity.email'
    || !referenceEmailSpans.has(`${slot.position}\0${slot.raw.length}`));
  // Script-overlap can make two bundles describe the same name at different
  // granularity (for example Japanese `山田 太郎` and Chinese `山田`). Keep
  // the containing span; genuinely separate names do not overlap and survive
  // for the downstream exactly-one-name guard to reject as ambiguous.
  const consolidated = withoutBoundEmails.filter((slot, slotIndex) => {
    if (slot.kind !== 'entity.name') return true;
    const end = slot.position + slot.raw.length;
    return !withoutBoundEmails.some((other, otherIndex) => {
      if (other.kind !== 'entity.name' || other === slot) return false;
      const contains = other.position <= slot.position
        && other.position + other.raw.length >= end;
      if (!contains) return false;
      if (other.raw.length > slot.raw.length) return true;
      if (other.position !== slot.position || other.raw.length !== slot.raw.length) return false;
      // A contextual candidate for the exact same span supersedes a typography-
      // inferred slot because it carries the warehouse's canonical value. Exact
      // semantic duplicates then collapse stably to their first occurrence.
      const otherCanonical = other.canonicalValue !== undefined;
      const slotCanonical = slot.canonicalValue !== undefined;
      if (otherCanonical !== slotCanonical) return otherCanonical;
      // If a confidence-1 identifier/alias and the contextual display-name
      // index attest the SAME canonical contact over the SAME bytes, retain
      // the opaque-keyed form. Keeping both would manufacture a two-name
      // ambiguity merely because a user's exact alias equals the display name.
      const sameCanonical = (other.canonicalValue ?? other.raw)
        .normalize('NFC').trim().replace(/\s+/gu, ' ').toLowerCase()
        === (slot.canonicalValue ?? slot.raw)
          .normalize('NFC').trim().replace(/\s+/gu, ' ').toLowerCase();
      if (
        sameCanonical
        && (other.referenceKey === undefined) !== (slot.referenceKey === undefined)
      ) return other.referenceKey !== undefined;
      return normaliseNameIdentity(other) === normaliseNameIdentity(slot)
        && otherIndex < slotIndex;
    });
  });
  const slots = gateExtraction(consolidated);
  if (slots.length === 0) return null;
  return {
    slots,
    locale: detection.locale,
    localeCandidates: detection.localeCandidates,
  };
};

export {
  detectLanguages,
  type LanguageDetection,
  type SupportedLocale,
} from './language-detection.js';
