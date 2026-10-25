export const factName = (key: string): string => {
  const text = key.replaceAll('_', ' ');
  return text ? text[0]!.toLocaleUpperCase() + text.slice(1) : text;
};

/** Friendly input stays separate from the closed storage-key grammar. */
export const factKey = (name: string): string => {
  const key = name.normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase('en').trim().replace(/[^a-z0-9]+/gu, '_').replace(/^_+|_+$/gu, '');
  return key && /^[0-9]/u.test(key) ? `fact_${key}` : key;
};
