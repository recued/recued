/** D-167 B4 commonness filter — the lexicon and its predicates live in
 *  `@recued/contracts` (`common-words.ts`) since 2026-10-24, so the content pass in
 *  `@recued/transforms` applies the same gate in prose. Re-exported here so the
 *  prefetch's imports and this package's public API are unchanged. */
export {
  COMMON_SINGLE_TOKEN_WORDS,
  PROSE_FUNCTION_WORDS,
  isCommonSingleTokenWord,
  isProseFunctionWord,
  shouldSeedEntityValue,
} from '@recued/contracts';
