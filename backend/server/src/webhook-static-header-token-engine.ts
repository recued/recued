/** D-201 Slices 9X + 9AW + 9BH — closed static header-token mechanism engine.
 *
 * Trusted presets select fixed versus credential-bound header authority, one
 * of two bounded token grammars, and deterministic overlap selection. Exact
 * header multiplicity, constant-time comparison, active-version bounds, and
 * configured-header safety are code-fixed. No profile id or vendor branch is
 * present here.
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import { MAX_ACTIVE_WEBHOOK_CREDENTIAL_VERSIONS } from '@recued/contracts';
import { WEBHOOK_CREDENTIAL_VERSION_PARSER } from './webhook-core-identity-parsers.js';
import { validateExactWebhookCredentialShape } from './webhook-credential-profile.js';
import {
  createWebhookBoundedAsciiTokenParser,
  type WebhookBoundedAsciiTokenParser,
  type WebhookBoundedAsciiTokenParserPreset,
} from './webhook-bounded-ascii-token-parser.js';
import type {
  RawWebhookRequest,
  WebhookProfileRuntimeContext,
} from './webhook-profile-runtime.js';

export type WebhookStaticHeaderTokenShape =
  | 'trimmed_printable_ascii_8192.v1'
  | WebhookBoundedAsciiTokenParserPreset;

export type WebhookStaticHeaderTokenHeaderPreset =
  | Readonly<{ kind: 'fixed'; name: string }>
  | Readonly<{ kind: 'credential_field'; field: string }>;

export interface WebhookStaticHeaderTokenMechanismPreset {
  readonly kind: 'static_header_token.v1';
  readonly token_field: string;
  readonly token_shape: WebhookStaticHeaderTokenShape;
  readonly token_header: WebhookStaticHeaderTokenHeaderPreset;
  readonly matching_credential: 'first' | 'newest';
}

export type WebhookStaticHeaderTokenAuthentication =
  | Readonly<{ ok: true; credential_version: string }>
  | Readonly<{
      ok: false;
      reason: 'configuration_failed' | 'authentication_failed';
    }>;

export interface WebhookStaticHeaderTokenMechanism {
  readonly preset: WebhookStaticHeaderTokenMechanismPreset;
  validateCredentialShape(credentials: Readonly<Record<string, string>>): boolean;
  hasValidConfiguration(context: WebhookProfileRuntimeContext): boolean;
  authenticate(
    request: RawWebhookRequest,
    context: WebhookProfileRuntimeContext,
  ): WebhookStaticHeaderTokenAuthentication;
  buildPresentation(
    context: WebhookProfileRuntimeContext,
    preference: 'newest' | 'oldest',
  ): Readonly<{
    credential_version: string;
    header_name: string;
    header_value: string;
  }> | null;
}

interface ResolvedStaticHeaderTokenCredential {
  readonly version: string;
  readonly created_at: number;
  readonly token: string;
  readonly header_name: string;
}

const MAX_HEADER_NAME_BYTES = 128;
const MAX_GENERIC_TOKEN_BYTES = 8_192;
const FIELD_KEY_RE = /^[a-z][a-z0-9_]{0,127}$/;
const HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const PRINTABLE_ASCII_RE = /^[\x20-\x7e]+$/;
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
  'token_field',
  'token_shape',
  'token_header',
  'matching_credential',
]);

const isPlainRecord = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const exactDataValues = (
  value: unknown,
  keys: ReadonlySet<string>,
): Readonly<Record<string, unknown>> | null => {
  try {
    if (!isPlainRecord(value)) return null;
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length !== keys.size
      || ownKeys.some((key) => typeof key !== 'string' || !keys.has(key))) {
      return null;
    }
    const fields = Object.create(null) as Record<string, unknown>;
    for (const key of ownKeys) {
      if (typeof key !== 'string') return null;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined
        || !descriptor.enumerable
        || !('value' in descriptor)) {
        return null;
      }
      fields[key] = descriptor.value;
    }
    return fields;
  } catch {
    return null;
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

const validToken = (
  boundedTokenParser: WebhookBoundedAsciiTokenParser | null,
  value: unknown,
): value is string => boundedTokenParser === null
  ? typeof value === 'string'
    && value.trim() === value
    && Buffer.byteLength(value, 'utf8') <= MAX_GENERIC_TOKEN_BYTES
    && PRINTABLE_ASCII_RE.test(value)
  : boundedTokenParser.parse(value) !== null;

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

const constantTimeEqual = (left: string, right: string): boolean => {
  try {
    const leftDigest = createHash('sha256').update(left, 'utf8').digest();
    const rightDigest = createHash('sha256').update(right, 'utf8').digest();
    return timingSafeEqual(leftDigest, rightDigest);
  } catch {
    return false;
  }
};

const selectCredential = (
  credentials: readonly ResolvedStaticHeaderTokenCredential[],
  preference: 'newest' | 'oldest',
): ResolvedStaticHeaderTokenCredential => {
  if (credentials.length === 0) {
    throw new Error('webhook static header token: no credential to select');
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

interface CompiledStaticHeaderTokenPreset {
  readonly preset: WebhookStaticHeaderTokenMechanismPreset;
  readonly boundedTokenParser: WebhookBoundedAsciiTokenParser | null;
}

const compilePreset = (
  input: WebhookStaticHeaderTokenMechanismPreset,
): CompiledStaticHeaderTokenPreset => {
  const fields = exactDataValues(input, PRESET_KEYS);
  const header = fields?.token_header;
  const headerKind = isPlainRecord(header)
    ? ownDataValue(header, 'kind')
    : undefined;
  const headerKeys = headerKind === 'fixed'
    ? new Set(['kind', 'name'])
    : headerKind === 'credential_field'
      ? new Set(['kind', 'field'])
      : new Set<string>();
  const headerFields = exactDataValues(header, headerKeys);
  const boundedTokenParser = fields !== null
    && fields.token_shape !== 'trimmed_printable_ascii_8192.v1'
    ? createWebhookBoundedAsciiTokenParser(
        fields.token_shape as WebhookBoundedAsciiTokenParserPreset,
      )
    : null;
  if (fields === null
    || fields.kind !== 'static_header_token.v1'
    || typeof fields.token_field !== 'string'
    || !FIELD_KEY_RE.test(fields.token_field)
    || (fields.matching_credential !== 'first'
      && fields.matching_credential !== 'newest')
    || headerFields === null
    || (headerKind === 'fixed'
      ? typeof headerFields.name !== 'string'
        || normalizedConfiguredHeader(headerFields.name) !== headerFields.name
      : typeof headerFields.field !== 'string'
        || !FIELD_KEY_RE.test(headerFields.field)
        || headerFields.field === fields.token_field)) {
    throw new Error('webhook static header token: invalid trusted preset');
  }
  const tokenHeader: WebhookStaticHeaderTokenHeaderPreset = headerKind === 'fixed'
    ? Object.freeze({ kind: 'fixed', name: headerFields.name as string })
    : Object.freeze({
        kind: 'credential_field',
        field: headerFields.field as string,
      });
  const preset: WebhookStaticHeaderTokenMechanismPreset = Object.freeze({
    kind: 'static_header_token.v1',
    token_field: fields.token_field,
    token_shape: boundedTokenParser?.preset
      ?? 'trimmed_printable_ascii_8192.v1',
    token_header: tokenHeader,
    matching_credential: fields.matching_credential,
  });
  return Object.freeze({ preset, boundedTokenParser });
};

export const createWebhookStaticHeaderTokenMechanism = (
  input: WebhookStaticHeaderTokenMechanismPreset,
): WebhookStaticHeaderTokenMechanism => {
  let compiled: CompiledStaticHeaderTokenPreset;
  try {
    compiled = compilePreset(input);
  } catch {
    throw new Error('webhook static header token: invalid trusted preset');
  }
  const { preset, boundedTokenParser } = compiled;
  const fields = preset.token_header.kind === 'credential_field'
    ? [{
        key: preset.token_header.field,
        validate: (value: unknown) => typeof value === 'string'
          && normalizedConfiguredHeader(value) !== null,
      }, {
        key: preset.token_field,
        validate: (value: unknown) => validToken(boundedTokenParser, value),
      }]
    : [{
        key: preset.token_field,
        validate: (value: unknown) => validToken(boundedTokenParser, value),
      }];

  const validateCredentialShape = (
    credentials: Readonly<Record<string, string>>,
  ): boolean => validateExactWebhookCredentialShape(credentials, fields);

  const resolveCredentials = (
    context: WebhookProfileRuntimeContext,
  ): readonly ResolvedStaticHeaderTokenCredential[] | null => {
    try {
      const versions = context.credential_versions;
      if (!Array.isArray(versions)
        || versions.length === 0
        || versions.length > MAX_ACTIVE_WEBHOOK_CREDENTIAL_VERSIONS) {
        return null;
      }
      const resolved: ResolvedStaticHeaderTokenCredential[] = [];
      for (let index = 0; index < versions.length; index += 1) {
        if (!Object.prototype.hasOwnProperty.call(versions, index)) return null;
        const version = versions[index];
        if (!validCredentialVersion(version)
          || !validateCredentialShape(version.credentials)) {
          return null;
        }
        const headerName = preset.token_header.kind === 'fixed'
          ? preset.token_header.name
          : normalizedConfiguredHeader(
              version.credentials[preset.token_header.field]!,
            );
        if (headerName === null) return null;
        resolved.push(Object.freeze({
          version: version.version,
          created_at: version.created_at,
          token: version.credentials[preset.token_field]!,
          header_name: headerName,
        }));
      }
      return Object.freeze(resolved);
    } catch {
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
    ): WebhookStaticHeaderTokenAuthentication {
      const credentials = resolveCredentials(context);
      if (credentials === null) {
        return Object.freeze({ ok: false, reason: 'configuration_failed' });
      }
      const matches = credentials.filter((credential) => {
        const presented = exactHeaderValue(request, credential.header_name);
        return validToken(boundedTokenParser, presented)
          && constantTimeEqual(presented, credential.token);
      });
      if (matches.length === 0) {
        return Object.freeze({ ok: false, reason: 'authentication_failed' });
      }
      return Object.freeze({
        ok: true,
        credential_version: (preset.matching_credential === 'first'
          ? matches[0]!
          : selectCredential(matches, 'newest')).version,
      });
    },
    buildPresentation(
      context: WebhookProfileRuntimeContext,
      preference: 'newest' | 'oldest',
    ) {
      if (preference !== 'newest' && preference !== 'oldest') return null;
      const credentials = resolveCredentials(context);
      if (credentials === null) return null;
      const credential = selectCredential(credentials, preference);
      return Object.freeze({
        credential_version: credential.version,
        header_name: credential.header_name,
        header_value: credential.token,
      });
    },
  });
};
