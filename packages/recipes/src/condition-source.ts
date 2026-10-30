export interface ConditionSourceToken { value: string; offset: number; length: number }
/** The canonical string-condition grammar uses whitespace tokens, with decoded UTF-16 positions. */
export const conditionStringParts = (text: string): { tokens: ConditionSourceToken[]; compound: boolean } => ({
  tokens: Array.from(text.matchAll(/\S+/g), match => ({ value: match[0], offset: match.index!, length: match[0].length })),
  compound: /\b(?:or|and)\b/i.test(text),
});
