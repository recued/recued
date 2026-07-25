/** D-201 Slices 8K + 9AV + 9BH + 9BQ — closed raw-body HMAC-SHA256 mechanism engine.
 *
 * Trusted profile presets may choose only fixed versus credential-bound header
 * authority, one of two closed secret shapes, one of two code-owned lowercase
 * digest presentations, and deterministic overlap selection. The algorithm,
 * exact signed bytes, maximum active versions, and header safety policy are
 * code-fixed.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { MAX_ACTIVE_WEBHOOK_CREDENTIAL_VERSIONS } from '@recued/contracts';
import { WEBHOOK_CREDENTIAL_VERSION_PARSER } from './webhook-core-identity-parsers.js';
import { validateExactWebhookCredentialShape } from './webhook-credential-profile.js';
import {
  createWebhookFixedLengthAsciiTokenParser,
  type WebhookFixedLengthAsciiTokenParser,
  type WebhookFixedLengthAsciiTokenParserPreset,
} from './webhook-fixed-length-ascii-token-parser.js';
import type {
  RawWebhookRequest,
  WebhookProfileRuntimeContext,
} from './webhook-profile-runtime.js';

export type WebhookRawBodyHmacSecretShape =
  | 'nonempty_utf8_65536'
  | WebhookFixedLengthAsciiTokenParserPreset;

export type WebhookRawBodyHmacSignatureHeaderPreset =
  | Readonly<{ kind: 'fixed'; name: string }>
  | Readonly<{ kind: 'credential_field'; field: string }>;

export interface WebhookRawBodyHmacMechanismPreset {
  readonly kind: 'raw_body_hmac_sha256.v1';
  readonly secret_field: string;
  readonly secret_shape: WebhookRawBodyHmacSecretShape;
  readonly signature_header: WebhookRawBodyHmacSignatureHeaderPreset;
  readonly signature_format:
    | 'sha256_equals_lowerhex.v1'
    | 'lowerhex.v1';
  readonly matching_credential: 'first' | 'newest';
}

interface ResolvedWebhookRawBodyHmacCredential {
  readonly version: string;
  readonly created_at: number;
  readonly secret: string;
  readonly signature_header: string;
}

export type WebhookRawBodyHmacAuthentication =
  | Readonly<{
      ok: true;
      credential_version: string;
    }>
  | Readonly<{
      ok: false;
      reason: 'configuration_failed' | 'authentication_failed';
    }>;

export interface WebhookRawBodyHmacMechanism {
  readonly preset: WebhookRawBodyHmacMechanismPreset;
  validateCredentialShape(credentials: Readonly<Record<string, string>>): boolean;
  hasValidConfiguration(context: WebhookProfileRuntimeContext): boolean;
  authenticate(
    request: RawWebhookRequest,
    context: WebhookProfileRuntimeContext,
  ): WebhookRawBodyHmacAuthentication;
  sign(
    rawBody: Buffer,
    context: WebhookProfileRuntimeContext,
    preference: 'newest' | 'oldest',
  ): Readonly<{
    credential_version: string;
    header_name: string;
    header_value: string;
  }> | null;
}

const MAX_HEADER_NAME_BYTES = 128;
const MAX_SECRET_BYTES = 65_536;
const FIELD_KEY_RE = /^[a-z][a-z0-9_]{0,127}$/;
const HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const SHA256_EQUALS_SIGNATURE_RE = /^sha256=([0-9a-f]{64})$/;
const LOWERHEX_SIGNATURE_RE = /^([0-9a-f]{64})$/;
const FORBIDDEN_CONFIGURED_HEADERS = new Set([
  'connection',
  'expect',
  'host',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'via',
]);
const PRESET_KEYS = new Set([
  'kind',
  'secret_field',
  'secret_shape',
  'signature_header',
  'signature_format',
  'matching_credential',
]);

const isPlainRecord = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const exactDataRecord = (value: unknown, keys: ReadonlySet<string>): boolean => {
  if (!isPlainRecord(value)) return false;
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== keys.size
    || ownKeys.some((key) => typeof key !== 'string' || !keys.has(key))) {
    return false;
  }
  return ownKeys.every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined
      && descriptor.enumerable
      && 'value' in descriptor;
  });
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

const normalizedConfiguredHeader = (value: string): string | null => {
  if (value.length === 0
    || Buffer.byteLength(value, 'utf8') > MAX_HEADER_NAME_BYTES
    || !HEADER_NAME_RE.test(value)) {
    return null;
  }
  const normalized = value.toLowerCase();
  if (FORBIDDEN_CONFIGURED_HEADERS.has(normalized)
    || normalized.startsWith('content-')
    || normalized === 'forwarded'
    || normalized.startsWith('x-forwarded-')
    || normalized === 'x-real-ip') {
    return null;
  }
  return normalized;
};

const validSecret = (
  fixedLengthParser: WebhookFixedLengthAsciiTokenParser | null,
  value: unknown,
): value is string => fixedLengthParser === null
  ? typeof value === 'string'
    && value.length > 0
    && Buffer.byteLength(value, 'utf8') <= MAX_SECRET_BYTES
  : fixedLengthParser.parse(value) !== null;

const validCredentialVersion = (value: unknown): value is {
  version: string;
  created_at: number;
  credentials: Readonly<Record<string, string>>;
} => {
  if (!isPlainRecord(value)) return false;
  const version = ownDataValue(value, 'version');
  const createdAt = ownDataValue(value, 'created_at');
  const credentials = ownDataValue(value, 'credentials');
  return WEBHOOK_CREDENTIAL_VERSION_PARSER.parse(version).ok
    && Number.isSafeInteger(createdAt)
    && (createdAt as number) >= 0
    && isPlainRecord(credentials);
};

const exactHeaderValue = (
  request: RawWebhookRequest,
  name: string,
): string | null => {
  const values = request.headers.get(name);
  return values?.length === 1 && typeof values[0] === 'string'
    ? values[0]
    : null;
};

const parseSignature = (
  value: string | null,
  format: WebhookRawBodyHmacMechanismPreset['signature_format'],
): Buffer | null => {
  const expression = format === 'sha256_equals_lowerhex.v1'
    ? SHA256_EQUALS_SIGNATURE_RE
    : LOWERHEX_SIGNATURE_RE;
  const match = value === null ? null : expression.exec(value);
  return match === null ? null : Buffer.from(match[1]!, 'hex');
};

const formatSignature = (
  digest: string,
  format: WebhookRawBodyHmacMechanismPreset['signature_format'],
): string => format === 'sha256_equals_lowerhex.v1'
  ? `sha256=${digest}`
  : digest;

const selectWebhookRawBodyHmacCredential = (
  credentials: readonly ResolvedWebhookRawBodyHmacCredential[],
  preference: 'newest' | 'oldest',
): ResolvedWebhookRawBodyHmacCredential => {
  if (credentials.length === 0) {
    throw new Error('webhook raw-body HMAC: no credential to select');
  }
  return credentials.reduce((selected, candidate) => {
    const candidateWins = preference === 'newest'
      ? candidate.created_at > selected.created_at
        || (candidate.created_at === selected.created_at
          && Number(candidate.version) > Number(selected.version))
      : candidate.created_at < selected.created_at
        || (candidate.created_at === selected.created_at
          && Number(candidate.version) < Number(selected.version));
    return candidateWins ? candidate : selected;
  });
};

const validatePreset = (
  preset: WebhookRawBodyHmacMechanismPreset,
): WebhookFixedLengthAsciiTokenParser | null => {
  if (!exactDataRecord(preset, PRESET_KEYS)) {
    throw new Error('webhook raw-body HMAC: invalid trusted preset');
  }
  const header: unknown = preset.signature_header;
  if (!isPlainRecord(header)) {
    throw new Error('webhook raw-body HMAC: invalid trusted preset');
  }
  const headerKind = ownDataValue(header, 'kind');
  const headerKeys = headerKind === 'fixed'
    ? new Set(['kind', 'name'])
    : headerKind === 'credential_field'
      ? new Set(['kind', 'field'])
      : new Set<string>();
  let fixedLengthParser: WebhookFixedLengthAsciiTokenParser | null = null;
  if (preset.secret_shape !== 'nonempty_utf8_65536') {
    try {
      fixedLengthParser = createWebhookFixedLengthAsciiTokenParser(
        preset.secret_shape as WebhookFixedLengthAsciiTokenParserPreset,
      );
    } catch {
      throw new Error('webhook raw-body HMAC: invalid trusted preset');
    }
  }
  if (preset.kind !== 'raw_body_hmac_sha256.v1'
    || !FIELD_KEY_RE.test(preset.secret_field)
    || (preset.signature_format !== 'sha256_equals_lowerhex.v1'
      && preset.signature_format !== 'lowerhex.v1')
    || (preset.matching_credential !== 'first'
      && preset.matching_credential !== 'newest')
    || !exactDataRecord(header, headerKeys)
    || (headerKind === 'fixed'
      ? typeof header.name !== 'string'
        || normalizedConfiguredHeader(header.name) !== header.name
      : typeof header.field !== 'string'
        || !FIELD_KEY_RE.test(header.field)
        || header.field === preset.secret_field)) {
    throw new Error('webhook raw-body HMAC: invalid trusted preset');
  }
  return fixedLengthParser;
};

export const createWebhookRawBodyHmacMechanism = (
  input: WebhookRawBodyHmacMechanismPreset,
): WebhookRawBodyHmacMechanism => {
  const fixedLengthSecretParser = validatePreset(input);
  const signatureHeader = Object.freeze({ ...input.signature_header });
  const preset: WebhookRawBodyHmacMechanismPreset = Object.freeze({
    ...input,
    secret_shape: fixedLengthSecretParser?.preset ?? 'nonempty_utf8_65536',
    signature_header: signatureHeader,
  });
  const fields = preset.signature_header.kind === 'credential_field'
    ? [
        {
          key: preset.signature_header.field,
          validate: (value: unknown) => typeof value === 'string'
            && normalizedConfiguredHeader(value) !== null,
        },
        {
          key: preset.secret_field,
          validate: (value: unknown) => validSecret(fixedLengthSecretParser, value),
        },
      ]
    : [{
        key: preset.secret_field,
        validate: (value: unknown) => validSecret(fixedLengthSecretParser, value),
      }];

  const validateCredentialShape = (
    credentials: Readonly<Record<string, string>>,
  ): boolean => validateExactWebhookCredentialShape(credentials, fields);

  const resolveCredentials = (
    context: WebhookProfileRuntimeContext,
  ): readonly ResolvedWebhookRawBodyHmacCredential[] | null => {
    let versions: WebhookProfileRuntimeContext['credential_versions'];
    try {
      versions = context.credential_versions;
    } catch {
      return null;
    }
    try {
      if (!Array.isArray(versions)
        || versions.length === 0
        || versions.length > MAX_ACTIVE_WEBHOOK_CREDENTIAL_VERSIONS) {
        return null;
      }
      const resolved: ResolvedWebhookRawBodyHmacCredential[] = [];
      for (let index = 0; index < versions.length; index += 1) {
        if (!Object.prototype.hasOwnProperty.call(versions, index)) return null;
        const version = versions[index];
        if (!validCredentialVersion(version)
          || !validateCredentialShape(version.credentials)) {
          return null;
        }
        const secret = version.credentials[preset.secret_field]!;
        const headerName = preset.signature_header.kind === 'fixed'
          ? preset.signature_header.name
          : normalizedConfiguredHeader(
              version.credentials[preset.signature_header.field]!,
            );
        if (headerName === null) return null;
        resolved.push(Object.freeze({
          version: version.version,
          created_at: version.created_at,
          secret,
          signature_header: headerName,
        }));
      }
      return Object.freeze(resolved);
    } catch {
      // Runtime contexts are trusted core values, but malformed embedded/test
      // callers still fail as configuration rather than escaping the adapter.
      return null;
    }
  };

  return Object.freeze({
    preset,
    validateCredentialShape,
    hasValidConfiguration(context: WebhookProfileRuntimeContext): boolean {
      return resolveCredentials(context) !== null;
    },
    authenticate(
      request: RawWebhookRequest,
      context: WebhookProfileRuntimeContext,
    ): WebhookRawBodyHmacAuthentication {
      const credentials = resolveCredentials(context);
      if (credentials === null) {
        return Object.freeze({ ok: false, reason: 'configuration_failed' });
      }
      const matches = credentials.filter((credential) => {
        const presented = parseSignature(
          exactHeaderValue(request, credential.signature_header),
          preset.signature_format,
        );
        if (presented === null) return false;
        const expected = createHmac('sha256', credential.secret)
          .update(request.raw_body)
          .digest();
        try {
          return timingSafeEqual(expected, presented);
        } catch {
          return false;
        }
      });
      if (matches.length === 0) {
        return Object.freeze({ ok: false, reason: 'authentication_failed' });
      }
      return Object.freeze({
        ok: true,
        credential_version: (preset.matching_credential === 'first'
          ? matches[0]!
          : selectWebhookRawBodyHmacCredential(matches, 'newest')).version,
      });
    },
    sign(
      rawBody: Buffer,
      context: WebhookProfileRuntimeContext,
      preference: 'newest' | 'oldest',
    ) {
      if (preference !== 'newest' && preference !== 'oldest') return null;
      const credentials = resolveCredentials(context);
      if (credentials === null) return null;
      const credential = selectWebhookRawBodyHmacCredential(credentials, preference);
      const digest = createHmac('sha256', credential.secret)
        .update(rawBody)
        .digest('hex');
      return Object.freeze({
        credential_version: credential.version,
        header_name: credential.signature_header,
        header_value: formatSignature(digest, preset.signature_format),
      });
    },
  });
};
