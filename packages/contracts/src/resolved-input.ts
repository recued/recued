/** Host-only provenance for an input object obtained through a whole-value ref.
 * JSON cannot forge the symbol. It is omitted by enumeration and serialization,
 * and never grants authority or bypasses locked input filtering. */
const RESOLVED_FIELDS = Symbol('resolved-input-fields');
type MarkedInput = { [RESOLVED_FIELDS]?: ReadonlySet<string> };

export const markResolvedInput = (input: Record<string, unknown>): Record<string, unknown> => {
  const out = { ...input };
  Object.defineProperty(out, RESOLVED_FIELDS, { value: new Set(Object.keys(input)) });
  return out;
};

export const isResolvedInputField = (input: object, key: string): boolean =>
  (input as MarkedInput)[RESOLVED_FIELDS]?.has(key) === true;

/** Input filtering rebuilds the object, so copy only surviving field marks. */
export const copyResolvedInputFields = (input: object, target: Record<string, unknown>): void => {
  const fields = Object.keys(target).filter(key => isResolvedInputField(input, key));
  if (fields.length > 0) Object.defineProperty(target, RESOLVED_FIELDS, { value: new Set(fields) });
};
