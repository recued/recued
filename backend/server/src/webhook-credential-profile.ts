/** D-201 Slice 8J — reusable exact credential-object profile engine.
 *
 * Profile presets provide field names and bounded value predicates. This engine
 * supplies the shared authority rule: no inherited, hidden, accessor-backed,
 * symbol, or extra field may accompany the credentials a mechanism consumes.
 */

export interface WebhookCredentialFieldPreset {
  key: string;
  validate(value: unknown): boolean;
}

export const validateExactWebhookCredentialShape = (
  credentials: Readonly<Record<string, string>>,
  fields: readonly WebhookCredentialFieldPreset[],
): boolean => {
  try {
    const prototype = Object.getPrototypeOf(credentials);
    if (prototype !== Object.prototype && prototype !== null) return false;
    const keys = Reflect.ownKeys(credentials);
    if (keys.length !== fields.length
      || fields.length === 0
      || new Set(fields.map((field) => field.key)).size !== fields.length) {
      return false;
    }
    for (const field of fields) {
      if (!keys.includes(field.key)) return false;
      const descriptor = Object.getOwnPropertyDescriptor(credentials, field.key);
      if (descriptor === undefined
        || descriptor.enumerable !== true
        || !('value' in descriptor)
        || !field.validate(descriptor.value)) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
};
