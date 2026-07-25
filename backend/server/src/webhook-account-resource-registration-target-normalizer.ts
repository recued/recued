/** D-201 Slice 9AE — neutral account/resource registration-target normalization.
 *
 * This closed engine admits either one account-like scope or one resource
 * nested directly beneath an account. Trusted preset data supplies only the
 * two target-kind labels. Exact object authority, the two code-backed key
 * grammars, single-separator structure, lowercase canonicalization, and bounds
 * remain fixed in code. There is no profile id, vendor branch, URL/path
 * template, regex input, callback, or provider request authority.
 */

import {
  MAX_WEBHOOK_REGISTRATION_TARGET_KEY_LENGTH,
  MAX_WEBHOOK_REGISTRATION_TARGET_KIND_LENGTH,
  type WebhookRegistrationTarget,
} from '@recued/contracts';

export interface WebhookAccountResourceRegistrationTargetNormalizerPreset {
  readonly kind: 'account_or_account_resource.v1';
  readonly account_kind: string;
  readonly resource_kind: string;
}

export interface WebhookAccountResourceRegistrationTargetNormalizer {
  readonly preset: WebhookAccountResourceRegistrationTargetNormalizerPreset;
  normalize(value: unknown): WebhookRegistrationTarget | null;
}

const PRESET_KEYS = new Set(['kind', 'account_kind', 'resource_kind']);
const TARGET_KEYS = new Set(['kind', 'key']);
const TARGET_KIND_RE = /^[a-z][a-z0-9_-]{0,63}$/;
const ACCOUNT_KEY_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const RESOURCE_KEY_RE = /^[A-Za-z0-9._-]{1,100}$/;
const ALPHANUMERIC_RE = /[A-Za-z0-9]/;

const isPlainRecord = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const exactOwnDataRecord = (
  value: unknown,
  keys: ReadonlySet<string>,
): value is Record<string, unknown> => {
  try {
    if (!isPlainRecord(value)) return false;
    const ownKeys = Reflect.ownKeys(value);
    return ownKeys.length === keys.size
      && ownKeys.every((key) => {
        if (typeof key !== 'string' || !keys.has(key)) return false;
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return descriptor !== undefined
          && descriptor.enumerable
          && 'value' in descriptor;
      });
  } catch {
    return false;
  }
};

const ownDataValue = (
  value: Record<string, unknown>,
  key: string,
): unknown => {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined && descriptor.enumerable && 'value' in descriptor
    ? descriptor.value
    : undefined;
};

const validTargetKind = (value: unknown): value is string =>
  typeof value === 'string'
  && value.length <= MAX_WEBHOOK_REGISTRATION_TARGET_KIND_LENGTH
  && TARGET_KIND_RE.test(value);

export const createWebhookAccountResourceRegistrationTargetNormalizer = (
  presetInput: WebhookAccountResourceRegistrationTargetNormalizerPreset,
): WebhookAccountResourceRegistrationTargetNormalizer => {
  if (!exactOwnDataRecord(presetInput, PRESET_KEYS)) {
    throw new Error(
      'webhook account/resource registration target: invalid trusted preset',
    );
  }
  const kind = ownDataValue(presetInput, 'kind');
  const accountKind = ownDataValue(presetInput, 'account_kind');
  const resourceKind = ownDataValue(presetInput, 'resource_kind');
  if (kind !== 'account_or_account_resource.v1'
    || !validTargetKind(accountKind)
    || !validTargetKind(resourceKind)
    || accountKind === resourceKind) {
    throw new Error(
      'webhook account/resource registration target: invalid trusted preset',
    );
  }
  const preset = Object.freeze({
    kind,
    account_kind: accountKind,
    resource_kind: resourceKind,
  });

  return Object.freeze({
    preset,
    normalize(value: unknown): WebhookRegistrationTarget | null {
      try {
        if (!exactOwnDataRecord(value, TARGET_KEYS)) return null;
        const targetKind = ownDataValue(value, 'kind');
        const key = ownDataValue(value, 'key');
        if (typeof targetKind !== 'string'
          || typeof key !== 'string'
          || key.length === 0
          || Buffer.byteLength(key, 'utf8')
            > MAX_WEBHOOK_REGISTRATION_TARGET_KEY_LENGTH) {
          return null;
        }
        if (targetKind === preset.account_kind) {
          return ACCOUNT_KEY_RE.test(key)
            ? Object.freeze({ kind: targetKind, key: key.toLowerCase() })
            : null;
        }
        if (targetKind !== preset.resource_kind) return null;
        const separator = key.indexOf('/');
        if (separator <= 0 || separator !== key.lastIndexOf('/')) return null;
        const account = key.slice(0, separator);
        const resource = key.slice(separator + 1);
        return ACCOUNT_KEY_RE.test(account)
          && RESOURCE_KEY_RE.test(resource)
          && ALPHANUMERIC_RE.test(resource)
          ? Object.freeze({
              kind: targetKind,
              key: `${account.toLowerCase()}/${resource.toLowerCase()}`,
            })
          : null;
      } catch {
        return null;
      }
    },
  });
};
