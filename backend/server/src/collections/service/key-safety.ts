const PROTOTYPE_SENSITIVE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export const isPrototypeSensitiveKey = (key: unknown): key is string =>
  typeof key === 'string' && PROTOTYPE_SENSITIVE_KEYS.has(key);

export const setSafeKey = <T>(
  target: Record<string, T>,
  key: string,
  value: T,
): boolean => {
  if (isPrototypeSensitiveKey(key)) return false;
  target[key] = value;
  return true;
};

export const hasOwnSafe = (
  obj: Record<string, unknown>,
  key: string,
): boolean =>
  !isPrototypeSensitiveKey(key) &&
  Object.prototype.hasOwnProperty.call(obj, key);

export const ownSafe = (
  obj: Record<string, unknown>,
  key: string,
): unknown =>
  hasOwnSafe(obj, key) ? obj[key] : undefined;
