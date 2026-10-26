/** Retrieval hints in class fields.settings and asset attributes. These never
 * change reminder rules, facts, or access permissions. */
export const ASSET_SEARCH_TERMS = 'search_terms';
const MAX_TERMS = 32;
const MAX_TERM_LENGTH = 80;
const MAX_TOTAL_LENGTH = 2048;

/** Text forms use comma/newline-separated terms; packs may supply an array.
 * null clears the optional metadata. Keep the same bounds for both writers. */
export const parseAssetSearchTerms = (value: unknown): string[] => {
  if (value == null) return [];
  if (typeof value === 'string' && value.length > MAX_TOTAL_LENGTH) throw new Error('Search keywords must use at most 2048 characters.');
  const parts = typeof value === 'string' ? value.split(/[,\n]/u) : value;
  if (!Array.isArray(parts) || parts.length > MAX_TERMS || parts.some(term => typeof term !== 'string')) {
    throw new Error('Use at most 32 search keywords, separated by commas.');
  }
  const terms = parts.map(term => (term as string).normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('en')).filter(Boolean);
  if (terms.some(term => term.length > MAX_TERM_LENGTH) || terms.reduce((sum, term) => sum + term.length, 0) > MAX_TOTAL_LENGTH) {
    throw new Error('Use search keywords of at most 80 characters each and 2048 characters in total.');
  }
  return [...new Set(terms)];
};

/** Historical or externally supplied invalid metadata must not break reads. */
export const assetSearchTerms = (value: unknown): string[] => {
  try { return parseAssetSearchTerms(value); } catch { return []; }
};
