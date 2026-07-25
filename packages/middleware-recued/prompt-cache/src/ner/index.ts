/** D-164 P4d — NER substrate public surface.
 *
 *  `extract(text, opts?) → ExtractionResult | null` composes the raw
 *  per-language extractor + the binary certainty gate. The deterministic
 *  gate (`../gate/`) calls this with either the user prompt or the
 *  referent-span text picked by the intention router (P4c) — NER
 *  itself is text-in / certain-slots-out and never reaches into ctx.
 *
 *  Locale selection:
 *    - `opts.locale` wins when supplied. The string is normalised to its
 *      lowercase BCP-47 primary tag (e.g., `en-US` → `en`).
 *    - Unknown locale falls back to English silently. The substrate's
 *      goal is "safe small wins" (design § 3 Invariant 7): the universal
 *      patterns (email / ISO date / 24-hour time) still fire under the
 *      English fallback, the only loss is locale-specific name shape.
 *    - No locale → English. English is the registered default.
 *
 *  Return contract:
 *    - `null` when the certainty gate accepts zero slots (the binary
 *      "pass through to LLM" signal — design § 3 Invariant 5).
 *    - `ExtractionResult` carries the surviving slots + the resolved
 *      locale tag for caller diagnostics.
 *
 *  See: docs/d-164-prompt-cache-consolidation-pending-design.md
 *  § 1 ner / § 3 the deterministic gate. */

import { extractRawSlots } from './extract.js';
import { gateExtraction, type SlotValue } from './confidence.js';
import { DE_RULES } from './languages/de.js';
import { EN_RULES } from './languages/en.js';
import { ES_RULES } from './languages/es.js';
import { FR_RULES } from './languages/fr.js';
import { JA_RULES } from './languages/ja.js';
import { PT_RULES } from './languages/pt.js';
import { ZH_RULES } from './languages/zh.js';

export { type SlotKind, type RawSlot, type LanguageRules } from './extract.js';
export { type SlotValue, gateOne, gateExtraction } from './confidence.js';

/** Registered locale → rule bundle. The map's key is the lowercase
 *  BCP-47 primary tag (`en`, `es`, `fr`, `de`, `ja`, `zh`, `pt`); the
 *  resolver normalises caller-supplied values before lookup. Order is
 *  documentation-only; the lookup is O(1). */
const LANGUAGE_REGISTRY: ReadonlyMap<string, typeof EN_RULES> = new Map([
  ['en', EN_RULES],
  ['es', ES_RULES],
  ['fr', FR_RULES],
  ['de', DE_RULES],
  ['ja', JA_RULES],
  ['zh', ZH_RULES],
  ['pt', PT_RULES],
]);

/** The English bundle doubles as the substrate's fallback. Importing
 *  it from `languages/en.js` keeps the dependency direction clean. */
const DEFAULT_LANGUAGE = EN_RULES;

/** Normalise a caller-supplied locale string to its lowercase primary
 *  tag. `en-US` / `en_US` / `EN` all collapse to `en`. */
const normaliseLocale = (raw: string): string => {
  if (raw.length === 0) return '';
  const lower = raw.toLowerCase();
  const dash = lower.indexOf('-');
  const underscore = lower.indexOf('_');
  if (dash === -1 && underscore === -1) return lower;
  const end = dash === -1
    ? underscore
    : underscore === -1
      ? dash
      : Math.min(dash, underscore);
  return lower.slice(0, end);
};

/** Resolve `opts.locale` against the registry. Returns the matched
 *  bundle or the English fallback. Pure / side-effect-free. */
const resolveLanguage = (locale: string | undefined): typeof EN_RULES => {
  if (locale === undefined) return DEFAULT_LANGUAGE;
  const primary = normaliseLocale(locale);
  if (primary.length === 0) return DEFAULT_LANGUAGE;
  return LANGUAGE_REGISTRY.get(primary) ?? DEFAULT_LANGUAGE;
};

/** Output of `extract` when the certainty gate accepts at least one
 *  slot. `slots` retains the order returned by the gate (regex
 *  discovery order: universal patterns first, language slots last).
 *  `locale` is the resolved primary tag — `'en'` whenever the
 *  fallback fired. */
export interface ExtractionResult {
  readonly slots: ReadonlyArray<SlotValue>;
  readonly locale: string;
}

/** Optional inputs to `extract`. */
export interface ExtractOptions {
  readonly locale?: string;
}

/** Run the NER substrate over `text`.
 *
 *  Steps:
 *    1. Pick the language rule bundle (caller locale → registry →
 *       English fallback).
 *    2. Collect raw spans (universal patterns + language patterns).
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
  const language = resolveLanguage(opts?.locale);
  const raws = extractRawSlots(text, language);
  const slots = gateExtraction(raws);
  if (slots.length === 0) return null;
  return { slots, locale: language.locale };
};
