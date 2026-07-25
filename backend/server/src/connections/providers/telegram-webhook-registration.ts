/** D-201 Slices 7G + 9AH + 9AM + 9AQ + 9AR + 9AW-9AX + 9BA + 9BE + 9BK — bounded Telegram singleton webhook registration adapter.
 *
 * Telegram exposes one webhook per bot rather than addressable endpoint rows.
 * Core therefore verifies the paired token with `getMe` and uses a bot-id-scoped
 * synthetic remote id. An exact opaque Recued URL is ownership evidence within
 * that bot; a different existing URL is an ambiguity and is never overwritten
 * or deleted.
 *
 * `getWebhookInfo` does not return `secret_token`. Initial create generates the
 * token and lets the reconciler commit it atomically with the synthetic remote
 * id. Later updates decrypt and resend that same active token, so a timeout or
 * crash cannot split remote authentication from the durable local credential.
 */

import { randomBytes } from 'node:crypto';

import {
  WebhookRegistrationAdapterError,
  type ManagedWebhookEndpointCreateResult,
  type ManagedWebhookEndpointMatch,
  type ManagedWebhookEndpointSnapshot,
  type ManagedWebhookRegistrationContext,
  type WebhookManagedEndpointRegistrationAdapter,
} from '../../webhook-registration-runtime.js';
import {
  createWebhookProviderSingletonRegistrationDriver,
  type WebhookProviderSingletonInspection,
  type WebhookProviderSingletonLifecycle,
} from '../../webhook-provider-singleton-registration-driver.js';
import {
  webhookProviderSingletonRegistrationDriverPreset,
} from '../../webhook-registration-driver-profile-presets.js';
import type {
  WebhookRegistrationJsonResponseReader,
  WebhookRegistrationPendingResponse,
} from '../../webhook-registration-json-response-reader.js';
import type {
  WebhookRegistrationIdempotencyKeyParser,
} from '../../webhook-registration-idempotency-key-parser.js';
import type {
  WebhookPrefixedPositiveDecimalIdCodec,
} from '../../webhook-prefixed-positive-decimal-id-codec.js';
import type {
  WebhookAsciiIdentifierParser,
} from '../../webhook-ascii-identifier-parser.js';
import type {
  WebhookBoundedAsciiTokenParser,
} from '../../webhook-bounded-ascii-token-parser.js';
import type {
  WebhookBoundedHttpsUrlParser,
} from '../../webhook-bounded-https-url-parser.js';
import type {
  WebhookDecimalColonAsciiTokenParser,
} from '../../webhook-decimal-colon-ascii-token-parser.js';
import {
  WEBHOOK_INGRESS_ID_PARSER,
} from '../../webhook-core-identity-parsers.js';

const TELEGRAM_API_ORIGIN = 'https://api.telegram.org';
const MAX_TELEGRAM_REMOTE_EVENT_TYPES = 128;
const DEFAULT_TELEGRAM_REGISTRATION_TIMEOUT_MS = 10_000;
const TELEGRAM_REGISTRATION_DRIVER_PRESET =
  webhookProviderSingletonRegistrationDriverPreset(
    'telegram.bot-webhook.v1',
  );
if (TELEGRAM_REGISTRATION_DRIVER_PRESET === null) {
  throw new Error('Telegram webhook registration driver preset is missing');
}

export interface TelegramWebhookRegistrationConnection {
  bot_token: string;
}

export interface TelegramWebhookRegistrationDeps {
  connectionTokenParser: WebhookDecimalColonAsciiTokenParser;
  endpointParser: WebhookBoundedHttpsUrlParser;
  eventTypeParser: WebhookAsciiIdentifierParser;
  idempotencyKeyParser: WebhookRegistrationIdempotencyKeyParser;
  remoteIdCodec: WebhookPrefixedPositiveDecimalIdCodec;
  responseReader: WebhookRegistrationJsonResponseReader;
  secretParser: WebhookBoundedAsciiTokenParser;
  resolveConnection: (
    pairedConnectionId: string,
  ) => Promise<TelegramWebhookRegistrationConnection | null>;
  /** Used only for an update of a committed endpoint. Managed owner writes are
   * closed, so exactly one active generated secret must exist. */
  resolveActiveSecret: (ingressId: string) => Promise<string | null>;
  /** The last provider-confirmed URL. It authorizes moving an owned singleton
   * to a newly-derived canonical URL without overwriting an unrelated URL. */
  resolveConfirmedEndpoint: (ingressId: string) => string | null | Promise<string | null>;
  generateSecret?: () => string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const hasOwn = (value: object, key: PropertyKey): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

const validateContext = (
  context: ManagedWebhookRegistrationContext,
  endpointParser: WebhookBoundedHttpsUrlParser,
  eventTypeParser: WebhookAsciiIdentifierParser,
): void => {
  const { desired } = context;
  if (context.paired_connection_id.trim().length === 0
    || context.paired_connection_id.length > 256
    || WEBHOOK_INGRESS_ID_PARSER.parse(desired.ingress_id) === null
    || (desired.environment !== 'test'
      && desired.environment !== 'live'
      && desired.environment !== 'custom')
    || desired.registration_target !== null
    || endpointParser.parse(desired.endpoint_url) === null
    || desired.event_types.length < 1
    || desired.event_types.length > 64
    || new Set(desired.event_types).size !== desired.event_types.length
    || desired.event_types.some((eventType) =>
      eventTypeParser.parse(eventType) === null)) {
    throw new WebhookRegistrationAdapterError(
      'registration_input_invalid',
      'Telegram managed registration input is invalid',
    );
  }
};

const committedRemoteId = (
  remoteEndpointId: unknown,
  codec: WebhookPrefixedPositiveDecimalIdCodec,
): string => {
  const parsed = codec.parse(remoteEndpointId);
  if (parsed === null) {
    throw new WebhookRegistrationAdapterError(
      'upstream_response_invalid',
      'Telegram managed webhook id is invalid',
    );
  }
  return parsed;
};

const validateIdempotencyKey = (
  idempotencyKey: string,
  parser: WebhookRegistrationIdempotencyKeyParser,
): void => {
  if (parser.parse(idempotencyKey) === null) {
    throw new WebhookRegistrationAdapterError(
      'registration_input_invalid',
      'Telegram registration idempotency key is invalid',
    );
  }
};

const desiredSnapshot = (
  context: ManagedWebhookRegistrationContext,
  remoteEndpointId: string,
): ManagedWebhookEndpointSnapshot => ({
  remote_endpoint_id: remoteEndpointId,
  environment: context.desired.environment,
  endpoint_url: context.desired.endpoint_url,
  event_types: context.desired.event_types.slice(),
  enabled: true,
  correlation_valid: true,
});

const parseWebhookInfo = (
  value: unknown,
  context: ManagedWebhookRegistrationContext,
  remoteEndpointId: string,
  endpointParser: WebhookBoundedHttpsUrlParser,
  eventTypeParser: WebhookAsciiIdentifierParser,
): ManagedWebhookEndpointSnapshot | null => {
  if (!isRecord(value)
    || typeof value.url !== 'string'
    || typeof value.has_custom_certificate !== 'boolean'
    || !Number.isSafeInteger(value.pending_update_count)
    || (value.pending_update_count as number) < 0) {
    throw new WebhookRegistrationAdapterError(
      'upstream_response_invalid',
      'Telegram returned an invalid WebhookInfo object',
    );
  }
  const endpointUrl = value.url === '' ? '' : endpointParser.parse(value.url);
  if (endpointUrl === null) {
    throw new WebhookRegistrationAdapterError(
      'upstream_response_invalid',
      'Telegram returned an invalid webhook URL',
    );
  }
  const allowedUpdates = hasOwn(value, 'allowed_updates')
    ? value.allowed_updates
    : [];
  if (!Array.isArray(allowedUpdates)
    || allowedUpdates.length > MAX_TELEGRAM_REMOTE_EVENT_TYPES) {
    throw new WebhookRegistrationAdapterError(
      'upstream_response_invalid',
      'Telegram returned invalid allowed update types',
    );
  }
  const eventTypes: string[] = [];
  for (const eventType of allowedUpdates) {
    const parsed = eventTypeParser.parse(eventType);
    if (parsed === null) {
      throw new WebhookRegistrationAdapterError(
        'upstream_response_invalid',
        'Telegram returned invalid allowed update types',
      );
    }
    eventTypes.push(parsed);
  }
  if (new Set(eventTypes).size !== eventTypes.length) {
    throw new WebhookRegistrationAdapterError(
      'upstream_response_invalid',
      'Telegram returned invalid allowed update types',
    );
  }
  if (endpointUrl === '') return null;
  return {
    remote_endpoint_id: remoteEndpointId,
    environment: context.desired.environment,
    endpoint_url: endpointUrl,
    event_types: eventTypes,
    enabled: true,
    correlation_valid: endpointUrl === context.desired.endpoint_url,
  };
};

export const createTelegramWebhookRegistrationAdapter = (
  deps: TelegramWebhookRegistrationDeps,
): WebhookManagedEndpointRegistrationAdapter => {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TELEGRAM_REGISTRATION_TIMEOUT_MS;
  const generateSecret = deps.generateSecret
    ?? (() => randomBytes(32).toString('base64url'));
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) {
    throw new Error('Telegram webhook registration timeout must be in 100..60000ms');
  }
  const readBoundedText = (
    pending: WebhookRegistrationPendingResponse,
  ): Promise<string> => deps.responseReader.readText(pending);
  const parseJson = (
    pending: WebhookRegistrationPendingResponse,
  ): Promise<unknown> => deps.responseReader.readJson(pending);

  // A reconciliation context pins one decrypted bot token across its complete
  // find/create/read or read/update/read sequence.
  const connectionByContext = new WeakMap<
    ManagedWebhookRegistrationContext,
    Promise<TelegramWebhookRegistrationConnection>
  >();

  const connectionFor = async (
    context: ManagedWebhookRegistrationContext,
  ): Promise<TelegramWebhookRegistrationConnection> => {
    validateContext(context, deps.endpointParser, deps.eventTypeParser);
    const cached = connectionByContext.get(context);
    if (cached) return cached;
    const resolved = (async (): Promise<TelegramWebhookRegistrationConnection> => {
      let connection: TelegramWebhookRegistrationConnection | null;
      try {
        connection = await deps.resolveConnection(context.paired_connection_id);
      } catch (error) {
        if (error instanceof WebhookRegistrationAdapterError) throw error;
        throw new WebhookRegistrationAdapterError(
          'connection_unavailable',
          'Telegram bot connection could not be resolved',
        );
      }
      if (connection === null) {
        throw new WebhookRegistrationAdapterError(
          'connection_unavailable',
          'Telegram bot connection is not available',
        );
      }
      const botToken = deps.connectionTokenParser.parse(connection.bot_token);
      if (botToken === null) {
        throw new WebhookRegistrationAdapterError(
          'connection_auth_invalid',
          'Telegram managed registration requires a valid bot token',
        );
      }
      return { bot_token: botToken };
    })();
    connectionByContext.set(context, resolved);
    return resolved;
  };

  const request = async (
    context: ManagedWebhookRegistrationContext,
    methodName: 'getMe' | 'getWebhookInfo' | 'setWebhook' | 'deleteWebhook',
    body?: Readonly<Record<string, unknown>>,
  ): Promise<WebhookRegistrationPendingResponse> => {
    const connection = await connectionFor(context);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const headers = new Headers({ Accept: 'application/json' });
      if (body !== undefined) headers.set('Content-Type', 'application/json; charset=utf-8');
      const response = await fetchImpl(
        `${TELEGRAM_API_ORIGIN}/bot${encodeURIComponent(connection.bot_token)}/${methodName}`,
        {
          method: body === undefined ? 'GET' : 'POST',
          headers,
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
          redirect: 'error',
          cache: 'no-store',
          credentials: 'omit',
          referrerPolicy: 'no-referrer',
          signal: controller.signal,
        },
      );
      let finished = false;
      return {
        response,
        finish: () => {
          if (finished) return;
          finished = true;
          clearTimeout(timeout);
        },
      };
    } catch {
      clearTimeout(timeout);
      throw new WebhookRegistrationAdapterError(
        'upstream_unavailable',
        'Telegram webhook registration request did not complete',
      );
    }
  };

  const requireResult = async (
    pending: WebhookRegistrationPendingResponse,
  ): Promise<unknown> => {
    if (!pending.response.ok) {
      await readBoundedText(pending);
      throw new WebhookRegistrationAdapterError(
        pending.response.status === 429 || pending.response.status >= 500
          ? 'upstream_unavailable'
          : 'upstream_rejected',
        `Telegram webhook registration returned HTTP ${pending.response.status}`,
      );
    }
    const body = await parseJson(pending);
    if (!isRecord(body)) {
      throw new WebhookRegistrationAdapterError(
        'upstream_response_invalid',
        'Telegram webhook registration returned an invalid response envelope',
      );
    }
    if (body.ok !== true) {
      const code = typeof body.error_code === 'number' ? body.error_code : null;
      throw new WebhookRegistrationAdapterError(
        code === 429 || (code !== null && code >= 500)
          ? 'upstream_unavailable'
          : 'upstream_rejected',
        'Telegram webhook registration was rejected',
      );
    }
    if (!hasOwn(body, 'result')) {
      throw new WebhookRegistrationAdapterError(
        'upstream_response_invalid',
        'Telegram webhook registration response omitted its result',
      );
    }
    return body.result;
  };

  const call = async (
    context: ManagedWebhookRegistrationContext,
    methodName: 'getMe' | 'getWebhookInfo' | 'setWebhook' | 'deleteWebhook',
    body?: Readonly<Record<string, unknown>>,
  ): Promise<unknown> => requireResult(await request(context, methodName, body));

  // A token can be rotated between local reads. Pin the provider-verified bot
  // identity beside the pinned token for this reconciliation context.
  const remoteIdByContext = new WeakMap<
    ManagedWebhookRegistrationContext,
    Promise<string>
  >();

  const remoteIdFor = async (
    context: ManagedWebhookRegistrationContext,
  ): Promise<string> => {
    const cached = remoteIdByContext.get(context);
    if (cached) return cached;
    const resolved = (async (): Promise<string> => {
      const result = await call(context, 'getMe');
      if (!isRecord(result)
        || result.is_bot !== true
        || typeof result.id !== 'number'
        || !Number.isSafeInteger(result.id)
        || result.id <= 0) {
        throw new WebhookRegistrationAdapterError(
          'upstream_response_invalid',
          'Telegram getMe returned an invalid bot identity',
        );
      }
      const remoteEndpointId = deps.remoteIdCodec.format(String(result.id));
      if (remoteEndpointId === null) {
        throw new WebhookRegistrationAdapterError(
          'upstream_response_invalid',
          'Telegram getMe returned an invalid bot identity',
        );
      }
      return remoteEndpointId;
    })();
    remoteIdByContext.set(context, resolved);
    return resolved;
  };

  const readCurrent = async (
    context: ManagedWebhookRegistrationContext,
  ): Promise<ManagedWebhookEndpointSnapshot | null> => {
    const remoteEndpointId = await remoteIdFor(context);
    return parseWebhookInfo(
      await call(context, 'getWebhookInfo'),
      context,
      remoteEndpointId,
      deps.endpointParser,
      deps.eventTypeParser,
    );
  };

  const setDesired = async (
    context: ManagedWebhookRegistrationContext,
    secretToken: string,
  ): Promise<void> => {
    const parsedSecretToken = deps.secretParser.parse(secretToken);
    if (parsedSecretToken === null) {
      throw new WebhookRegistrationAdapterError(
        'registration_input_invalid',
        'Telegram managed webhook secret is invalid',
      );
    }
    const result = await call(context, 'setWebhook', {
      url: context.desired.endpoint_url,
      allowed_updates: context.desired.event_types.slice(),
      secret_token: parsedSecretToken,
      drop_pending_updates: false,
    });
    if (result !== true) {
      throw new WebhookRegistrationAdapterError(
        'upstream_response_invalid',
        'Telegram setWebhook returned an invalid result',
      );
    }
  };

  const activeSecretFor = async (
    context: ManagedWebhookRegistrationContext,
  ): Promise<string> => {
    let secret: string | null;
    try {
      secret = await deps.resolveActiveSecret(context.desired.ingress_id);
    } catch (error) {
      if (error instanceof WebhookRegistrationAdapterError) throw error;
      throw new WebhookRegistrationAdapterError(
        'connection_unavailable',
        'Telegram managed webhook credential could not be resolved',
      );
    }
    const parsedSecret = deps.secretParser.parse(secret);
    if (parsedSecret === null) {
      throw new WebhookRegistrationAdapterError(
        'registration_input_invalid',
        'Telegram managed webhook has no valid active secret',
      );
    }
    return parsedSecret;
  };

  const confirmedEndpointFor = async (
    context: ManagedWebhookRegistrationContext,
  ): Promise<string | null> => {
    let endpoint: string | null;
    try {
      endpoint = await deps.resolveConfirmedEndpoint(context.desired.ingress_id);
    } catch (error) {
      if (error instanceof WebhookRegistrationAdapterError) throw error;
      throw new WebhookRegistrationAdapterError(
        'connection_unavailable',
        'Telegram managed webhook state could not be resolved',
      );
    }
    return endpoint === null ? null : deps.endpointParser.parse(endpoint);
  };

  const inspect = async (
    context: ManagedWebhookRegistrationContext,
  ): Promise<WebhookProviderSingletonInspection> => {
    const current = await readCurrent(context);
    const matches: ManagedWebhookEndpointMatch[] = current === null
      ? []
      : [{
        endpoint: current,
        correlation: current.correlation_valid
          ? 'owned'
          : 'metadata_conflict',
      }];
    return { matches };
  };

  return createWebhookProviderSingletonRegistrationDriver(
    TELEGRAM_REGISTRATION_DRIVER_PRESET,
    {
      inspect,
      async create(
        context,
        idempotencyKey,
        lifecycle: WebhookProviderSingletonLifecycle,
      ): Promise<ManagedWebhookEndpointCreateResult> {
        validateIdempotencyKey(idempotencyKey, deps.idempotencyKeyParser);
        // `setWebhook` replaces the singleton. Re-read immediately before the
        // mutation so an existing manual/legacy URL is never intentionally
        // overwritten, even if it appeared after the coordinator's search.
        if ((await lifecycle.find()).length > 0) {
          throw new WebhookRegistrationAdapterError(
            'upstream_rejected',
            'Telegram bot already has a webhook; no endpoint was changed',
          );
        }
        const secret = deps.secretParser.parse(generateSecret());
        if (secret === null) {
          throw new WebhookRegistrationAdapterError(
            'registration_input_invalid',
            'Telegram managed webhook secret generation failed',
          );
        }
        await setDesired(context, secret);
        return {
          endpoint: desiredSnapshot(context, await remoteIdFor(context)),
          credential_result: { secret_token: secret },
        };
      },
      async read(context, remoteEndpointId) {
        const parsedRemoteEndpointId = committedRemoteId(
          remoteEndpointId,
          deps.remoteIdCodec,
        );
        if (await remoteIdFor(context) !== parsedRemoteEndpointId) return null;
        return readCurrent(context);
      },
      async update(context, remoteEndpointId, idempotencyKey) {
        const parsedRemoteEndpointId = committedRemoteId(
          remoteEndpointId,
          deps.remoteIdCodec,
        );
        validateIdempotencyKey(idempotencyKey, deps.idempotencyKeyParser);
        const currentRemoteId = await remoteIdFor(context);
        if (currentRemoteId !== parsedRemoteEndpointId) {
          throw new WebhookRegistrationAdapterError(
            'upstream_rejected',
            'Telegram paired bot identity does not match the committed webhook; no endpoint was changed',
          );
        }
        const current = await readCurrent(context);
        const confirmedEndpoint = await confirmedEndpointFor(context);
        if (current === null
          || (current.endpoint_url !== context.desired.endpoint_url
            && current.endpoint_url !== confirmedEndpoint)) {
          throw new WebhookRegistrationAdapterError(
            'upstream_rejected',
            'Telegram bot webhook ownership could not be confirmed; no endpoint was changed',
          );
        }
        await setDesired(context, await activeSecretFor(context));
        return desiredSnapshot(context, currentRemoteId);
      },
      async delete(context, remoteEndpointId): Promise<void> {
        const parsedRemoteEndpointId = committedRemoteId(
          remoteEndpointId,
          deps.remoteIdCodec,
        );
        if (await remoteIdFor(context) !== parsedRemoteEndpointId) {
          throw new WebhookRegistrationAdapterError(
            'upstream_rejected',
            'Telegram paired bot identity does not match the committed webhook; no endpoint was deleted',
          );
        }
        const current = await readCurrent(context);
        if (current === null) return;
        if (current.endpoint_url !== context.desired.endpoint_url) {
          throw new WebhookRegistrationAdapterError(
            'upstream_rejected',
            'Telegram bot webhook ownership could not be confirmed; no endpoint was deleted',
          );
        }
        const result = await call(context, 'deleteWebhook', {
          drop_pending_updates: false,
        });
        if (result !== true) {
          throw new WebhookRegistrationAdapterError(
            'upstream_response_invalid',
            'Telegram deleteWebhook returned an invalid result',
          );
        }
      },
    },
  );
};
