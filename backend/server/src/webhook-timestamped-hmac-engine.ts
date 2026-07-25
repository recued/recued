/** D-201 Slices 8L-8N + 9AT-9AU + 9BH — closed timestamped raw-body HMAC-SHA256 engine.
 *
 * Trusted presets select between bounded, code-backed header grammars while
 * the algorithm, accepted signing base, replay window, exact request bytes,
 * active-version bound, and configured-header safety policy remain fixed.
 * Profile wrappers retain only envelope projection and test-fixture behavior.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { MAX_ACTIVE_WEBHOOK_CREDENTIAL_VERSIONS } from '@recued/contracts';
import { WEBHOOK_CREDENTIAL_VERSION_PARSER } from './webhook-core-identity-parsers.js';
import { validateExactWebhookCredentialShape } from './webhook-credential-profile.js';
import {
  createWebhookPrefixedAsciiTokenParser,
  type WebhookPrefixedAsciiTokenParserPreset,
} from './webhook-prefixed-ascii-token-parser.js';
import {
  createWebhookSegmentedAsciiTokenParser,
  type WebhookSegmentedAsciiTokenParserPreset,
} from './webhook-segmented-ascii-token-parser.js';
import type {
  RawWebhookRequest,
  WebhookProfileRuntimeContext,
} from './webhook-profile-runtime.js';

export const WEBHOOK_TIMESTAMPED_HMAC_REPLAY_WINDOW_SECONDS = 5 * 60;

export type WebhookTimestampedHmacSecretShape =
  | Readonly<{
      kind: 'nonempty_utf8.v1';
      max_bytes: number;
    }>
  | WebhookPrefixedAsciiTokenParserPreset
  | WebhookSegmentedAsciiTokenParserPreset;

export type WebhookTimestampedHmacSignatureHeaderPreset =
  | Readonly<{ kind: 'fixed'; name: string }>
  | Readonly<{ kind: 'credential_field'; field: string }>;

export type WebhookTimestampedHmacTimestampSource =
  | Readonly<{ kind: 'signature_envelope' }>
  | Readonly<{ kind: 'fixed_header'; name: string }>;

export type WebhookTimestampedHmacSignatureEnvelope =
  | 'strict_ordered_comma_t_v1_lowerhex.v1'
  | 'extensible_comma_t_v1_hex.v1'
  | 'strict_semicolon_ts_h1_lowerhex.v1'
  | 'separate_decimal_timestamp_v0_lowerhex.v1';

export interface WebhookTimestampedHmacMechanismPreset {
  readonly kind: 'timestamped_hmac_sha256.v1';
  readonly secret_field: string;
  readonly secret_shape: WebhookTimestampedHmacSecretShape;
  readonly signature_header: WebhookTimestampedHmacSignatureHeaderPreset;
  readonly timestamp_source: WebhookTimestampedHmacTimestampSource;
  readonly signature_envelope: WebhookTimestampedHmacSignatureEnvelope;
  readonly signed_payload:
    | 'timestamp_dot_raw_body.v1'
    | 'timestamp_colon_raw_body.v1'
    | 'v0_colon_timestamp_colon_raw_body.v1';
  readonly replay_window_seconds: 5 | 300;
  readonly admission_order: 'clock_then_signature' | 'signature_then_clock';
  readonly matching_credential: 'first' | 'newest';
}

export type WebhookTimestampedHmacAuthentication =
  | Readonly<{
      ok: true;
      credential_version: string;
      timestamp_literal: string;
    }>
  | Readonly<{
      ok: false;
      reason: 'configuration_failed' | 'authentication_failed';
    }>;

export interface WebhookTimestampedHmacMechanism {
  readonly preset: WebhookTimestampedHmacMechanismPreset;
  validateCredentialShape(credentials: Readonly<Record<string, string>>): boolean;
  hasValidConfiguration(context: WebhookProfileRuntimeContext): boolean;
  authenticate(
    request: RawWebhookRequest,
    context: WebhookProfileRuntimeContext,
  ): WebhookTimestampedHmacAuthentication;
  sign(
    rawBody: Buffer,
    context: WebhookProfileRuntimeContext,
    preference: 'newest' | 'oldest',
  ): Readonly<{
    credential_version: string;
    timestamp_literal: string;
    header_name: string;
    header_value: string;
    timestamp_header: Readonly<{
      name: string;
      value: string;
    }> | null;
  }> | null;
}

interface ResolvedCredential {
  readonly version: string;
  readonly created_at: number;
  readonly secret: string;
  readonly signature_header: string;
}

interface ParsedSignature {
  readonly timestamp_literal: string;
  readonly timestamp_seconds: number;
  readonly signatures: readonly Buffer[];
}

const MAX_HEADER_NAME_BYTES = 128;
const MAX_SECRET_BYTES = 65_536;
const MAX_EXTENSIBLE_SIGNATURE_HEADER_BYTES = 8_192;
const MAX_SEPARATE_TIMESTAMP_HEADER_BYTES = 32;
const MAX_STRICT_SIGNATURES = 8;
const MAX_EXTENSIBLE_SIGNATURES = 16;
const FIELD_KEY_RE = /^[a-z][a-z0-9_]{0,127}$/;
const HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const PRESET_KEYS = new Set([
  'kind',
  'secret_field',
  'secret_shape',
  'signature_header',
  'timestamp_source',
  'signature_envelope',
  'signed_payload',
  'replay_window_seconds',
  'admission_order',
  'matching_credential',
]);
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

const validateSecretShape = (
  value: unknown,
): value is WebhookTimestampedHmacSecretShape => {
  if (!isPlainRecord(value)) return false;
  const kind = ownDataValue(value, 'kind');
  const maxBytes = ownDataValue(value, 'max_bytes');
  if (kind === 'nonempty_utf8.v1') {
    return exactDataRecord(value, new Set(['kind', 'max_bytes']))
      && Number.isSafeInteger(maxBytes)
      && (maxBytes as number) >= 1
      && (maxBytes as number) <= MAX_SECRET_BYTES;
  }
  if (kind === 'prefixed_ascii_token.v1') {
    try {
      createWebhookPrefixedAsciiTokenParser(
        value as unknown as WebhookPrefixedAsciiTokenParserPreset,
      );
      return true;
    } catch {
      return false;
    }
  }
  if (kind === 'segmented_ascii_token.v1') {
    try {
      createWebhookSegmentedAsciiTokenParser(
        value as unknown as WebhookSegmentedAsciiTokenParserPreset,
      );
      return true;
    } catch {
      return false;
    }
  }
  return false;
};

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

const parseStrictOrderedSignature = (
  value: string,
): ParsedSignature | null => {
  const parts = value.split(',');
  if (parts.length < 2 || parts.length > MAX_STRICT_SIGNATURES + 1) return null;
  const timestampPart = parts[0]!;
  if (!timestampPart.startsWith('t=')) return null;
  const timestampLiteral = timestampPart.slice(2);
  if (!/^[1-9][0-9]*$/.test(timestampLiteral)) return null;
  const signatures: Buffer[] = [];
  for (const part of parts.slice(1)) {
    if (!part.startsWith('v1=')) return null;
    const candidate = part.slice(3);
    if (!/^[0-9a-f]{64}$/.test(candidate)
      || signatures.length >= MAX_STRICT_SIGNATURES) {
      return null;
    }
    signatures.push(Buffer.from(candidate, 'hex'));
  }
  const timestampSeconds = Number(timestampLiteral);
  if (signatures.length === 0 || !Number.isSafeInteger(timestampSeconds)) return null;
  return {
    timestamp_literal: timestampLiteral,
    timestamp_seconds: timestampSeconds,
    signatures,
  };
};

const parseExtensibleSignature = (
  value: string,
): ParsedSignature | null => {
  if (Buffer.byteLength(value, 'utf8') > MAX_EXTENSIBLE_SIGNATURE_HEADER_BYTES) {
    return null;
  }
  let timestampLiteral: string | null = null;
  const signatures: Buffer[] = [];
  for (const rawPart of value.split(',')) {
    const part = rawPart.trim();
    const separator = part.indexOf('=');
    if (separator <= 0) continue;
    const key = part.slice(0, separator);
    const candidate = part.slice(separator + 1);
    if (key === 't') {
      if (!/^[1-9][0-9]*$/.test(candidate)
        || (timestampLiteral !== null && timestampLiteral !== candidate)) {
        return null;
      }
      timestampLiteral = candidate;
      continue;
    }
    if (key === 'v1') {
      if (signatures.length >= MAX_EXTENSIBLE_SIGNATURES
        || !/^[0-9a-fA-F]{64}$/.test(candidate)) {
        return null;
      }
      signatures.push(Buffer.from(candidate, 'hex'));
    }
  }
  if (timestampLiteral === null || signatures.length === 0) return null;
  const timestampSeconds = Number(timestampLiteral);
  if (!Number.isSafeInteger(timestampSeconds)) return null;
  return {
    timestamp_literal: timestampLiteral,
    timestamp_seconds: timestampSeconds,
    signatures,
  };
};

const parseStrictSemicolonSignature = (
  value: string,
): ParsedSignature | null => {
  if (value.length === 0
    || Buffer.byteLength(value, 'utf8') > MAX_EXTENSIBLE_SIGNATURE_HEADER_BYTES) {
    return null;
  }
  let timestampLiteral: string | null = null;
  const signatures: Buffer[] = [];
  for (const rawPart of value.split(';')) {
    const part = rawPart.trim();
    const separator = part.indexOf('=');
    if (part.length === 0
      || separator <= 0
      || separator === part.length - 1
      || part.indexOf('=', separator + 1) !== -1) {
      return null;
    }
    const key = part.slice(0, separator);
    const candidate = part.slice(separator + 1);
    if (!/^[A-Za-z0-9_]+$/.test(key)) return null;
    if (key === 'ts') {
      if (timestampLiteral !== null || !/^[1-9][0-9]*$/.test(candidate)) {
        return null;
      }
      timestampLiteral = candidate;
      continue;
    }
    if (key === 'h1') {
      if (signatures.length >= MAX_EXTENSIBLE_SIGNATURES
        || !/^[0-9a-f]{64}$/.test(candidate)) {
        return null;
      }
      signatures.push(Buffer.from(candidate, 'hex'));
    }
  }
  if (timestampLiteral === null || signatures.length === 0) return null;
  const timestampSeconds = Number(timestampLiteral);
  if (!Number.isSafeInteger(timestampSeconds)) return null;
  return {
    timestamp_literal: timestampLiteral,
    timestamp_seconds: timestampSeconds,
    signatures,
  };
};

const parseSeparateDecimalTimestampSignature = (
  timestampValue: string | null,
  signatureValue: string | null,
): ParsedSignature | null => {
  if (timestampValue === null
    || signatureValue === null
    || Buffer.byteLength(timestampValue, 'utf8')
      > MAX_SEPARATE_TIMESTAMP_HEADER_BYTES
    || !/^[0-9]+$/.test(timestampValue)
    || !/^v0=[0-9a-f]{64}$/.test(signatureValue)) {
    return null;
  }
  const timestampSeconds = Number(timestampValue);
  if (!Number.isSafeInteger(timestampSeconds)) return null;
  return {
    timestamp_literal: timestampValue,
    timestamp_seconds: timestampSeconds,
    signatures: [Buffer.from(signatureValue.slice(3), 'hex')],
  };
};

const parseSignature = (
  envelope: WebhookTimestampedHmacSignatureEnvelope,
  signatureValue: string | null,
  timestampValue: string | null,
): ParsedSignature | null => {
  if (envelope === 'separate_decimal_timestamp_v0_lowerhex.v1') {
    return parseSeparateDecimalTimestampSignature(
      timestampValue,
      signatureValue,
    );
  }
  if (signatureValue === null) return null;
  switch (envelope) {
    case 'strict_ordered_comma_t_v1_lowerhex.v1':
      return parseStrictOrderedSignature(signatureValue);
    case 'extensible_comma_t_v1_hex.v1':
      return parseExtensibleSignature(signatureValue);
    case 'strict_semicolon_ts_h1_lowerhex.v1':
      return parseStrictSemicolonSignature(signatureValue);
  }
};

const signingPrefix = (
  signedPayload: WebhookTimestampedHmacMechanismPreset['signed_payload'],
  timestampLiteral: string,
): string => {
  switch (signedPayload) {
    case 'timestamp_dot_raw_body.v1':
      return `${timestampLiteral}.`;
    case 'timestamp_colon_raw_body.v1':
      return `${timestampLiteral}:`;
    case 'v0_colon_timestamp_colon_raw_body.v1':
      return `v0:${timestampLiteral}:`;
  }
};

const formattedSignature = (
  envelope: WebhookTimestampedHmacSignatureEnvelope,
  timestampLiteral: string,
  digest: string,
): string => {
  switch (envelope) {
    case 'strict_semicolon_ts_h1_lowerhex.v1':
      return `ts=${timestampLiteral};h1=${digest}`;
    case 'separate_decimal_timestamp_v0_lowerhex.v1':
      return `v0=${digest}`;
    case 'strict_ordered_comma_t_v1_lowerhex.v1':
    case 'extensible_comma_t_v1_hex.v1':
      return `t=${timestampLiteral},v1=${digest}`;
  }
};

const selectCredential = (
  credentials: readonly ResolvedCredential[],
  preference: 'newest' | 'oldest',
): ResolvedCredential => {
  if (credentials.length === 0) {
    throw new Error('webhook timestamped HMAC: no credential to select');
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

const validatePreset = (preset: WebhookTimestampedHmacMechanismPreset): void => {
  if (!exactDataRecord(preset, PRESET_KEYS)) {
    throw new Error('webhook timestamped HMAC: invalid trusted preset');
  }
  const secretShape: unknown = preset.secret_shape;
  const header: unknown = preset.signature_header;
  const timestampSource: unknown = preset.timestamp_source;
  if (!isPlainRecord(header) || !isPlainRecord(timestampSource)) {
    throw new Error('webhook timestamped HMAC: invalid trusted preset');
  }
  const headerKind = ownDataValue(header, 'kind');
  const headerKeys = headerKind === 'fixed'
    ? new Set(['kind', 'name'])
    : headerKind === 'credential_field'
      ? new Set(['kind', 'field'])
      : new Set<string>();
  const timestampSourceKind = ownDataValue(timestampSource, 'kind');
  const timestampSourceKeys = timestampSourceKind === 'signature_envelope'
    ? new Set(['kind'])
    : timestampSourceKind === 'fixed_header'
      ? new Set(['kind', 'name'])
      : new Set<string>();
  const separateTimestampEnvelope =
    preset.signature_envelope === 'separate_decimal_timestamp_v0_lowerhex.v1';
  if (preset.kind !== 'timestamped_hmac_sha256.v1'
    || !FIELD_KEY_RE.test(preset.secret_field)
    || !validateSecretShape(secretShape)
    || (preset.signature_envelope !== 'strict_ordered_comma_t_v1_lowerhex.v1'
      && preset.signature_envelope !== 'extensible_comma_t_v1_hex.v1'
      && preset.signature_envelope !== 'strict_semicolon_ts_h1_lowerhex.v1'
      && preset.signature_envelope
        !== 'separate_decimal_timestamp_v0_lowerhex.v1')
    || (preset.signed_payload !== 'timestamp_dot_raw_body.v1'
      && preset.signed_payload !== 'timestamp_colon_raw_body.v1'
      && preset.signed_payload !== 'v0_colon_timestamp_colon_raw_body.v1')
    || (preset.replay_window_seconds !== 5
      && preset.replay_window_seconds !== WEBHOOK_TIMESTAMPED_HMAC_REPLAY_WINDOW_SECONDS)
    || (preset.admission_order !== 'clock_then_signature'
      && preset.admission_order !== 'signature_then_clock')
    || (preset.matching_credential !== 'first'
      && preset.matching_credential !== 'newest')
    || !exactDataRecord(header, headerKeys)
    || (headerKind === 'fixed'
      ? typeof header.name !== 'string'
        || normalizedConfiguredHeader(header.name) !== header.name
      : typeof header.field !== 'string'
        || !FIELD_KEY_RE.test(header.field)
        || header.field === preset.secret_field)
    || !exactDataRecord(timestampSource, timestampSourceKeys)
    || (timestampSourceKind === 'fixed_header'
      ? typeof timestampSource.name !== 'string'
        || normalizedConfiguredHeader(timestampSource.name)
          !== timestampSource.name
      : timestampSourceKind !== 'signature_envelope')
    || separateTimestampEnvelope !== (timestampSourceKind === 'fixed_header')
    || (timestampSourceKind === 'fixed_header'
      && headerKind === 'fixed'
      && timestampSource.name === header.name)) {
    throw new Error('webhook timestamped HMAC: invalid trusted preset');
  }
};

export const createWebhookTimestampedHmacMechanism = (
  input: WebhookTimestampedHmacMechanismPreset,
): WebhookTimestampedHmacMechanism => {
  validatePreset(input);
  const signatureHeader = Object.freeze({ ...input.signature_header });
  const timestampSource = Object.freeze({ ...input.timestamp_source });
  const structuredSecretParser =
    input.secret_shape.kind === 'prefixed_ascii_token.v1'
      ? createWebhookPrefixedAsciiTokenParser(input.secret_shape)
      : input.secret_shape.kind === 'segmented_ascii_token.v1'
        ? createWebhookSegmentedAsciiTokenParser(input.secret_shape)
        : null;
  const secretShape: WebhookTimestampedHmacSecretShape =
    structuredSecretParser?.preset
      ?? Object.freeze({ ...input.secret_shape });
  const preset: WebhookTimestampedHmacMechanismPreset = Object.freeze({
    ...input,
    secret_shape: secretShape,
    signature_header: signatureHeader,
    timestamp_source: timestampSource,
  });
  const validCredentialBoundSignatureHeader = (value: unknown): boolean => {
    if (typeof value !== 'string') return false;
    const normalized = normalizedConfiguredHeader(value);
    return normalized !== null
      && (preset.timestamp_source.kind !== 'fixed_header'
        || normalized !== preset.timestamp_source.name);
  };
  const validSecretValue = (value: unknown): value is string => {
    if (structuredSecretParser !== null) {
      return structuredSecretParser.parse(value) !== null;
    }
    return typeof value === 'string'
      && value.length > 0
      && secretShape.kind === 'nonempty_utf8.v1'
      && Buffer.byteLength(value, 'utf8') <= secretShape.max_bytes;
  };
  const fields = preset.signature_header.kind === 'credential_field'
    ? [
        {
          key: preset.signature_header.field,
          validate: validCredentialBoundSignatureHeader,
        },
        {
          key: preset.secret_field,
          validate: validSecretValue,
        },
      ]
    : [{
        key: preset.secret_field,
        validate: validSecretValue,
      }];

  const validateCredentialShape = (
    credentials: Readonly<Record<string, string>>,
  ): boolean => validateExactWebhookCredentialShape(credentials, fields);

  const resolveCredentials = (
    context: WebhookProfileRuntimeContext,
  ): readonly ResolvedCredential[] | null => {
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
      const resolved: ResolvedCredential[] = [];
      for (let index = 0; index < versions.length; index += 1) {
        if (!Object.prototype.hasOwnProperty.call(versions, index)) return null;
        const version = versions[index];
        if (!validCredentialVersion(version)
          || !validateCredentialShape(version.credentials)) {
          return null;
        }
        const headerName = preset.signature_header.kind === 'fixed'
          ? preset.signature_header.name
          : normalizedConfiguredHeader(
              version.credentials[preset.signature_header.field]!,
            );
        if (headerName === null
          || (preset.timestamp_source.kind === 'fixed_header'
            && headerName === preset.timestamp_source.name)) {
          return null;
        }
        resolved.push(Object.freeze({
          version: version.version,
          created_at: version.created_at,
          secret: version.credentials[preset.secret_field]!,
          signature_header: headerName,
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
    ): WebhookTimestampedHmacAuthentication {
      const credentials = resolveCredentials(context);
      if (credentials === null) {
        return Object.freeze({ ok: false, reason: 'configuration_failed' });
      }
      if (preset.admission_order === 'signature_then_clock'
        && credentials.every((credential) => {
          if (exactHeaderValue(request, credential.signature_header) === null) {
            return true;
          }
          return preset.timestamp_source.kind === 'fixed_header'
            && exactHeaderValue(request, preset.timestamp_source.name) === null;
        })) {
        return Object.freeze({ ok: false, reason: 'authentication_failed' });
      }
      let nowMilliseconds: number;
      try {
        nowMilliseconds = context.now();
      } catch {
        return Object.freeze({ ok: false, reason: 'configuration_failed' });
      }
      if (!Number.isSafeInteger(nowMilliseconds) || nowMilliseconds < 0) {
        return Object.freeze({ ok: false, reason: 'configuration_failed' });
      }
      const nowSeconds = Math.floor(nowMilliseconds / 1_000);
      if (!Number.isSafeInteger(nowSeconds)) {
        return Object.freeze({ ok: false, reason: 'configuration_failed' });
      }

      const parsedByHeader = new Map<string, ParsedSignature | null>();
      const matches: Array<{
        credential: ResolvedCredential;
        timestamp_literal: string;
      }> = [];
      for (const credential of credentials) {
        let parsed = parsedByHeader.get(credential.signature_header);
        if (parsed === undefined) {
          parsed = parseSignature(
            preset.signature_envelope,
            exactHeaderValue(request, credential.signature_header),
            preset.timestamp_source.kind === 'fixed_header'
              ? exactHeaderValue(request, preset.timestamp_source.name)
              : null,
          );
          parsedByHeader.set(credential.signature_header, parsed);
        }
        if (parsed === null
          || Math.abs(nowSeconds - parsed.timestamp_seconds)
            > preset.replay_window_seconds) {
          continue;
        }
        const expected = createHmac('sha256', credential.secret)
          .update(signingPrefix(preset.signed_payload, parsed.timestamp_literal))
          .update(request.raw_body)
          .digest();
        const matched = parsed.signatures.some((candidate) => {
          try {
            return timingSafeEqual(expected, candidate);
          } catch {
            return false;
          }
        });
        if (matched) {
          matches.push({
            credential,
            timestamp_literal: parsed.timestamp_literal,
          });
        }
      }
      if (matches.length === 0
        || new Set(matches.map((match) => match.timestamp_literal)).size !== 1) {
        return Object.freeze({ ok: false, reason: 'authentication_failed' });
      }
      const selected = preset.matching_credential === 'first'
        ? matches[0]!.credential
        : selectCredential(matches.map((match) => match.credential), 'newest');
      return Object.freeze({
        ok: true,
        credential_version: selected.version,
        timestamp_literal: matches[0]!.timestamp_literal,
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
      let nowMilliseconds: number;
      try {
        nowMilliseconds = context.now();
      } catch {
        return null;
      }
      if (!Number.isSafeInteger(nowMilliseconds) || nowMilliseconds < 1_000) {
        return null;
      }
      const timestampLiteral = String(Math.floor(nowMilliseconds / 1_000));
      if (!/^[1-9][0-9]*$/.test(timestampLiteral)) return null;
      const credential = selectCredential(credentials, preference);
      const digest = createHmac('sha256', credential.secret)
        .update(signingPrefix(preset.signed_payload, timestampLiteral))
        .update(rawBody)
        .digest('hex');
      return Object.freeze({
        credential_version: credential.version,
        timestamp_literal: timestampLiteral,
        header_name: credential.signature_header,
        header_value: formattedSignature(
          preset.signature_envelope,
          timestampLiteral,
          digest,
        ),
        timestamp_header: preset.timestamp_source.kind === 'fixed_header'
          ? Object.freeze({
              name: preset.timestamp_source.name,
              value: timestampLiteral,
            })
          : null,
      });
    },
  });
};
