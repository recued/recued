export type LiteralJsonCopy =
  | { ok: true; value: unknown }
  | { ok: false; issue: string };

/** Copy an own-property, acyclic JSON value without invoking accessors. The
 * fresh result is safe for subsequent ordinary property reads by the closed
 * canary/migration classifiers. */
export const copyLiteralJson = (
  value: unknown,
  path = '$',
  seen = new Set<object>(),
): LiteralJsonCopy => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return { ok: true, value };
  }
  if (typeof value === 'number') {
    return Number.isFinite(value)
      ? { ok: true, value: Object.is(value, -0) ? 0 : value }
      : { ok: false, issue: `${path} contains a non-finite number` };
  }
  if (typeof value !== 'object') return { ok: false, issue: `${path} is not literal JSON` };
  try {
    if (seen.has(value)) return { ok: false, issue: `${path} is cyclic` };
    seen.add(value);
    const proto = Object.getPrototypeOf(value);
    if (Array.isArray(value)) {
      if (proto !== Array.prototype) return { ok: false, issue: `${path} has an exotic array prototype` };
      const descriptors = Object.getOwnPropertyDescriptors(value);
      const extra = Reflect.ownKeys(descriptors).find((key) =>
        typeof key !== 'string' || (key !== 'length' && !/^(0|[1-9]\d*)$/.test(key)));
      if (extra !== undefined) return { ok: false, issue: `${path} has a non-index array property` };
      const length = Object.getOwnPropertyDescriptor(value, 'length')?.value;
      if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0) {
        return { ok: false, issue: `${path} has an invalid array length` };
      }
      const copy: unknown[] = [];
      for (let index = 0; index < length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || descriptor.get || descriptor.set || !('value' in descriptor)) {
          return { ok: false, issue: `${path}[${index}] is sparse or accessor-backed` };
        }
        const child = copyLiteralJson(descriptor.value, `${path}[${index}]`, seen);
        if (!child.ok) return child;
        copy.push(child.value);
      }
      seen.delete(value);
      return { ok: true, value: copy };
    }
    if (proto !== Object.prototype && proto !== null) {
      return { ok: false, issue: `${path} has an exotic object prototype` };
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const copy: Record<string, unknown> = {};
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key !== 'string' || ['__proto__', 'prototype', 'constructor'].includes(key)) {
        return { ok: false, issue: `${path} has an unsafe own-property key` };
      }
      const descriptor = descriptors[key]!;
      if (descriptor.get || descriptor.set || !('value' in descriptor)) {
        return { ok: false, issue: `${path}.${key} is accessor-backed` };
      }
      const child = copyLiteralJson(descriptor.value, `${path}.${key}`, seen);
      if (!child.ok) return child;
      Object.defineProperty(copy, key, {
        value: child.value,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    seen.delete(value);
    return { ok: true, value: copy };
  } catch {
    return { ok: false, issue: `${path} cannot be inspected as literal JSON` };
  }
};
