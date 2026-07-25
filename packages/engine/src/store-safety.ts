const PROTOTYPE_SENSITIVE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export const isPrototypeSensitiveKey = (key: unknown): key is string =>
  typeof key === 'string' && PROTOTYPE_SENSITIVE_KEYS.has(key);

export const setNamespaceValue = (
  store: Record<string, unknown>,
  key: string,
  value: unknown,
): boolean => {
  if (isPrototypeSensitiveKey(key)) return false;
  store[key] = value;
  return true;
};

export const assignOwnSafe = (
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): void => {
  for (const [key, value] of Object.entries(source)) {
    setNamespaceValue(target, key, value);
  }
};

export const hasOwnSafe = (
  store: Record<string, unknown>,
  key: string,
): boolean =>
  !isPrototypeSensitiveKey(key) &&
  Object.prototype.hasOwnProperty.call(store, key);
