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
 *
 * D-201 Slice 10G — Telegram does not refuse an update name it does not know:
 * its Bot API lowercases each name, skips the ones it does not know, and falls
 * back to its default set when it knows none (`get_allowed_update_types` in
 * telegram-bot-api's `Client.cpp`), and `getWebhookInfo` then lists no
 * `allowed_updates`. So every set reads back what Telegram kept. A skipped name
 * is reported by name (`event_types_unknown`), and a create that reported one
 * removes the webhook it set first: Telegram never keeps a secret Recued did
 * not store.
 *
 * D-201 Slice 10K — that removal, like `delete`, removes only a webhook at this
 * ingress's URL: another ingress may have set the bot's one webhook in between.
 * D-201 Slice 10O (10L finding 13) — it reads, then deletes, so a set landing
 * between the two is still removed: the window is narrowed, not closed (the
 * Bot API server's one-second limit on sets makes it narrower still).
 * An update whose names Telegram knew none of fell back to Telegram's default
 * set under the held secret, so every update type would arrive: the webhook is
 * put back to the URL and names it held before.
 *
 * D-201 Slice 10O (10L finding 5) — the Bot API server takes one `setWebhook`
 * with a URL a second (`next_allowed_set_webhook_time_` in `Client.cpp`) and
 * answers a second with 429 and `retry_after`, which the put-back always is: a
 * set waits that out once and goes again. A put-back that still fails says the
 * bot may now send every update type, and the reconciler stores that too.
 * `custom_event` and `custom_query` are refused before any request: Telegram
 * holds them but never lists them, so a webhook given one can never be
 * confirmed.
 */

import { randomBytes } from 'node:crypto';
import { webhookProfile } from '@recued/contracts';

import {
  assertDesiredEventTypesAdmitted,
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
  WebhookLowercaseIdentifierEventTypeParser,
} from '../../webhook-lowercase-identifier-event-type-parser.js';
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
/** D-201 Slices 10G + 10K — what Telegram sends a webhook whose
 *  `allowed_updates` it does not list: its default, every update type but
 *  `chat_member`, `message_reaction` and `message_reaction_count`. Taken from
 *  the Bot API server's source (telegram-bot-api `Client.h`'s `UpdateType` and
 *  `DEFAULT_ALLOWED_UPDATE_TYPES`, `Client.cpp`'s `get_update_type_name`), in
 *  its order, less `custom_event` and `custom_query`: that default holds them
 *  too, but getWebhookInfo never lists them, so no public name stands for them.
 *  getWebhookInfo leaves the list out only when a webhook's set is exactly that
 *  default, as it is after names Telegram knew none of. A webhook given these
 *  26 names is listed explicitly, since its set lacks the two hidden ones. Before
 *  10K this list had 20 names and lagged the server by six. A type Telegram adds
 *  later is missing here until this list learns it: an unlisted default then
 *  reads back without it, so a webhook on the default does not line up. */
const TELEGRAM_DEFAULT_ALLOWED_UPDATES: readonly string[] = Object.freeze([
  'message',
  'edited_message',
  'channel_post',
  'edited_channel_post',
  'inline_query',
  'chosen_inline_result',
  'callback_query',
  'shipping_query',
  'pre_checkout_query',
  'poll',
  'poll_answer',
  'my_chat_member',
  'chat_join_request',
  'chat_boost',
  'removed_chat_boost',
  'business_connection',
  'business_message',
  'edited_business_message',
  'deleted_business_messages',
  'purchased_paid_media',
  'managed_bot',
  'guest_message',
  'subscription',
  'stopped_message_generation',
  'widget_query',
  'shared_widget_query',
]);
const MAX_TELEGRAM_REMOTE_EVENT_TYPES = 128;
const DEFAULT_TELEGRAM_REGISTRATION_TIMEOUT_MS = 10_000;
/** D-201 Slice 10O — the update kinds Telegram holds but `getWebhookInfo` never
 *  lists (telegram-bot-api `Client.cpp`, `JsonUpdateTypes`): a webhook given
 *  one can never read back as given, so it is refused before any request. */
const TELEGRAM_UNLISTED_UPDATE_TYPES: readonly string[] = (() => {
  // D-201 Slice 10T — from the profile, which Settings reads too.
  const catalog = webhookProfile('telegram.bot-webhook.v1')?.event_types;
  return Object.freeze([...(catalog?.kind === 'open' ? catalog.never_listed ?? [] : [])]);
})();
/** D-201 Slice 10O — the longest `retry_after` a set waits out: the server's
 *  limit on sets is one second; a longer answer is a flood limit, reported. */
const MAX_TELEGRAM_RETRY_AFTER_SECONDS = 5;

/** D-201 Slice 10T (10Q finding 8) — the bot's webhook changed between this
 *  adapter's set and the put-back's retry: another party's, which a put-back
 *  would replace. Nothing more is changed. */
class TelegramWebhookChangedError extends WebhookRegistrationAdapterError {
  constructor() {
    super(
      'upstream_rejected',
      'Telegram bot webhook changed while its update names were being put back; nothing more was changed',
    );
    this.name = 'TelegramWebhookChangedError';
  }
}

/** D-201 Slice 10O — a call Telegram turned away for now (HTTP 429), with the
 *  seconds it asked for (`parameters.retry_after`). */
class TelegramRetryAfterError extends WebhookRegistrationAdapterError {
  constructor(readonly retry_after_seconds: number) {
    super('upstream_unavailable', 'Telegram asked to wait before another webhook change');
    this.name = 'TelegramRetryAfterError';
  }
}

/** The seconds a 429 asked for, from its Bot API envelope, when it names a
 *  positive whole number of them. */
const retryAfterSecondsOf = (body: unknown): number | null => {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return null;
  const parameters = (body as { parameters?: unknown }).parameters;
  if (parameters === null || typeof parameters !== 'object' || Array.isArray(parameters)) return null;
  const seconds = (parameters as { retry_after?: unknown }).retry_after;
  return typeof seconds === 'number' && Number.isSafeInteger(seconds) && seconds > 0 ? seconds : null;
};
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
  eventTypeParser: WebhookLowercaseIdentifierEventTypeParser;
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
  /** D-201 Slice 10O — how a set waits out Telegram's `retry_after`. */
  sleep?: (ms: number) => Promise<void>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const hasOwn = (value: object, key: PropertyKey): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

/** Everything but the event names, which are checked where they are sent
 *  (create, update): cleanup never depends on them (Slice 10G). */
const validateContext = (
  context: ManagedWebhookRegistrationContext,
  endpointParser: WebhookBoundedHttpsUrlParser,
): void => {
  const { desired } = context;
  if (context.paired_connection_id.trim().length === 0
    || context.paired_connection_id.length > 256
    || WEBHOOK_INGRESS_ID_PARSER.parse(desired.ingress_id) === null
    || (desired.environment !== 'test'
      && desired.environment !== 'live'
      && desired.environment !== 'custom')
    || desired.registration_target !== null
    || endpointParser.parse(desired.endpoint_url) === null) {
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

/** D-201 Slice 10BB (10AY finding 7) — the settings of the bot's webhook a set
 *  sent without them resets: `max_connections` back to 40, `ip_address` to the
 *  one DNS gives, a self-signed certificate dropped (the Bot API's documented
 *  defaults). `max_connections` is sent back as Telegram reports it; a
 *  certificate cannot be, for Recued holds none. A value Telegram reports
 *  that is not one it takes is left out, as before.
 *
 *  D-201 Slice 10BG (10BF finding 2) — `ip_address` is never sent back.
 *  Telegram reports the address in use, the one DNS gave too, and `setWebhook`
 *  takes one as fixed: sent back, it pinned the webhook to the address Telegram
 *  last resolved, so once the server's address changed, nothing arrived and
 *  nothing was refused. Recued cannot tell a fixed address from a resolved one,
 *  so any set it makes resets an address the owner fixed at Telegram. */
interface TelegramWebhookHeldSettings {
  readonly max_connections?: number;
  readonly custom_certificate: boolean;
}

const heldWebhookSettings = (value: unknown): TelegramWebhookHeldSettings => {
  if (!isRecord(value)) return { custom_certificate: false };
  const maxConnections = value.max_connections;
  return {
    ...(Number.isSafeInteger(maxConnections) && (maxConnections as number) >= 1 && (maxConnections as number) <= 100
      ? { max_connections: maxConnections as number }
      : {}),
    custom_certificate: value.has_custom_certificate === true,
  };
};

const parseWebhookInfo = (
  value: unknown,
  context: ManagedWebhookRegistrationContext,
  remoteEndpointId: string,
  endpointParser: WebhookBoundedHttpsUrlParser,
  eventTypeParser: WebhookLowercaseIdentifierEventTypeParser,
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
    : TELEGRAM_DEFAULT_ALLOWED_UPDATES;
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
    // D-201 Slice 10BQ (10BM finding 15) — a certificate set at Telegram, which
    // no set from Recued can send back.
    ...(value.has_custom_certificate === true ? { holds_unsendable: true as const } : {}),
  };
};

export const createTelegramWebhookRegistrationAdapter = (
  deps: TelegramWebhookRegistrationDeps,
): WebhookManagedEndpointRegistrationAdapter => {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TELEGRAM_REGISTRATION_TIMEOUT_MS;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  }));
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
    validateContext(context, deps.endpointParser);
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
      if (pending.response.status === 429) {
        // D-201 Slice 10O — the wait Telegram asked for, read through the same
        // bounded reader, kept for a set to honour.
        let seconds: number | null = null;
        try {
          seconds = retryAfterSecondsOf(await parseJson(pending));
        } catch {
          // Not a Bot API envelope: an ordinary failure below.
        }
        if (seconds !== null) throw new TelegramRetryAfterError(seconds);
      } else {
        await readBoundedText(pending);
      }
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
      const seconds = code === 429 ? retryAfterSecondsOf(body) : null;
      if (seconds !== null) throw new TelegramRetryAfterError(seconds);
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

  /** What the bot holds, and (D-201 Slice 10T, 10Q finding 7) whether that is
   *  Telegram's default set: a WebhookInfo naming no `allowed_updates`, which
   *  reads back as the default's names. D-201 Slice 10Z (10V finding 24) — an
   *  empty list is not the default: the Bot API server lists one only for a
   *  set made of the kinds it never lists (`custom_event`, `custom_query`). */
  const readWebhookInfo = async (
    context: ManagedWebhookRegistrationContext,
  ): Promise<{
    snapshot: ManagedWebhookEndpointSnapshot | null;
    on_default: boolean;
    /** D-201 Slice 10BB (10AY finding 7) — what a set of the secret alone must
     *  keep, or cannot. */
    held: TelegramWebhookHeldSettings;
  }> => {
    const remoteEndpointId = await remoteIdFor(context);
    const raw = await call(context, 'getWebhookInfo');
    return {
      snapshot: parseWebhookInfo(raw, context, remoteEndpointId, deps.endpointParser, deps.eventTypeParser),
      on_default: isRecord(raw) && !hasOwn(raw, 'allowed_updates'),
      held: heldWebhookSettings(raw),
    };
  };

  const readCurrent = async (
    context: ManagedWebhookRegistrationContext,
  ): Promise<ManagedWebhookEndpointSnapshot | null> => (await readWebhookInfo(context)).snapshot;

  const setDesired = async (
    context: ManagedWebhookRegistrationContext,
    secretToken: string,
    /** The URL and names to set: the desired ones, or (D-201 Slice 10K) what
     *  the bot held before, for the put-back after names Telegram knew none of.
     *  D-201 Slice 10AU (10AS finding 6) — no names for the secret alone:
     *  `allowed_updates` not sent, Telegram keeps the ones it has ("If not
     *  specified, the previous setting will be used", its Bot API). */
    target: {
      endpoint_url: string;
      event_types?: readonly string[];
      /** D-201 Slice 10BB (10AY finding 7) — the bot's connection limit, sent
       *  back so a set keeps it. D-201 Slice 10BG — never its address. */
      max_connections?: number;
    },
    /** D-201 Slice 10T (10Q finding 8) — what must still hold before a set the
     *  server's limit refused goes again: the check made before the first set.
     *  The refused set changed nothing, so another party's set in that second
     *  would otherwise be replaced. Required, so no set retries unchecked. */
    stillMayRetry: () => Promise<void>,
  ): Promise<void> => {
    const parsedSecretToken = deps.secretParser.parse(secretToken);
    if (parsedSecretToken === null) {
      throw new WebhookRegistrationAdapterError(
        'registration_input_invalid',
        'Telegram managed webhook secret is invalid',
      );
    }
    const body = {
      url: target.endpoint_url,
      ...(target.event_types === undefined ? {} : { allowed_updates: target.event_types.slice() }),
      ...(target.max_connections === undefined ? {} : { max_connections: target.max_connections }),
      secret_token: parsedSecretToken,
      drop_pending_updates: false,
    };
    let result: unknown;
    try {
      result = await call(context, 'setWebhook', body);
    } catch (error) {
      // D-201 Slice 10O (10L finding 5) — the server takes one set with a URL a
      // second, and a put-back follows a set at once: wait out what it asked
      // for, once, and go again.
      if (!(error instanceof TelegramRetryAfterError)
        || error.retry_after_seconds > MAX_TELEGRAM_RETRY_AFTER_SECONDS) throw error;
      await sleep(error.retry_after_seconds * 1_000);
      await stillMayRetry();
      result = await call(context, 'setWebhook', body);
    }
    if (result !== true) {
      throw new WebhookRegistrationAdapterError(
        'upstream_response_invalid',
        'Telegram setWebhook returned an invalid result',
      );
    }
  };

  /** The desired names Telegram did not keep, read back after a set. Only a
   *  read-back of this webhook can say; any other answer (no webhook, another
   *  URL) is the reconciler's own read-back to judge. */
  const namesTelegramSkipped = async (
    context: ManagedWebhookRegistrationContext,
  ): Promise<string[]> => {
    const current = await readCurrent(context);
    if (current === null || current.endpoint_url !== context.desired.endpoint_url) return [];
    return context.desired.event_types.filter((eventType) =>
      !current.event_types.includes(eventType));
  };

  /** D-201 Slice 10O (10L finding 15) — names Telegram holds but never lists:
   *  set, they could never read back as given, so they are refused, by name,
   *  before any request. */
  const refuseUnlistedNames = (context: ManagedWebhookRegistrationContext): void => {
    const unlisted = context.desired.event_types.filter((eventType) =>
      TELEGRAM_UNLISTED_UPDATE_TYPES.includes(eventType));
    if (unlisted.length === 0) return;
    throw new WebhookRegistrationAdapterError(
      'event_types_unknown',
      `Telegram never lists ${unlisted.length === 1 ? 'the update name' : 'the update names'} ${unlisted.join(', ')}, so a webhook set with ${unlisted.length === 1 ? 'it' : 'them'} could never be confirmed`,
      unlisted,
    );
  };

  const skippedNamesError = (skipped: readonly string[]): WebhookRegistrationAdapterError =>
    new WebhookRegistrationAdapterError(
      'event_types_unknown',
      `Telegram does not know ${skipped.length === 1 ? 'the update name' : 'the update names'} ${skipped.join(', ')}`,
      skipped,
    );

  /** Undo a create that cannot stand. Best effort: if Telegram cannot be
   *  reached now, the reconciler's next pass finds the webhook by its URL and
   *  removes it before it sets one again. D-201 Slice 10K (10H finding 15) —
   *  only a webhook at this ingress's URL, as `delete` checks: this removed
   *  whatever the bot held, even one another ingress had just set. */
  /** Remove a webhook a create set and could not keep. D-201 Slice 10AD (10AA
   *  finding 29) — says whether nothing it set stands now. */
  const removeUnstoredWebhook = async (
    context: ManagedWebhookRegistrationContext,
  ): Promise<boolean> => {
    try {
      const current = await readCurrent(context);
      if (current === null || current.endpoint_url !== context.desired.endpoint_url) return true;
      // D-201 Slice 10AH (10AE finding 21) — only `true` removed it, as
      // `delete` checks: any other answer settled a create while its webhook
      // stood.
      return await call(context, 'deleteWebhook', { drop_pending_updates: false }) === true;
    } catch {
      return false;
    }
  };

  /** D-201 Slice 10AD (10AA finding 29) — the set landed and could not be
   *  removed: the create is not refused outright but may stand, so its record
   *  stays for the sweep. A 4xx read-back with a failed undo settled it as
   *  refused while the webhook stood. */
  const setButStanding = (cause: unknown): WebhookRegistrationAdapterError => new WebhookRegistrationAdapterError(
    'upstream_unavailable',
    `Telegram webhook was set and could not be removed after: ${cause instanceof Error ? cause.message : String(cause)}`,
  );

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

  /** D-201 Slice 10AU (10AS finding 6) — the bot's secret alone: its webhook
   *  set again at the URL it holds now, with the secret this webhook holds and
   *  no `allowed_updates`, which Telegram then keeps as they are. `update` sets
   *  Recued's names too, putting back names set there since. Pending updates
   *  stay, and a bot pointed elsewhere is never set, as `update` checks. */
  const setSecret = async (
    context: ManagedWebhookRegistrationContext,
    remoteEndpointId: string,
  ): Promise<ManagedWebhookEndpointSnapshot | null> => {
    const parsedRemoteEndpointId = committedRemoteId(
      remoteEndpointId,
      deps.remoteIdCodec,
    );
    if (await remoteIdFor(context) !== parsedRemoteEndpointId) {
      throw new WebhookRegistrationAdapterError(
        'upstream_rejected',
        'Telegram paired bot identity does not match the committed webhook; its secret was not set',
      );
    }
    const info = await readWebhookInfo(context);
    const current = info.snapshot;
    if (current === null) return null;
    const confirmedEndpoint = await confirmedEndpointFor(context);
    const ours = (endpoint: ManagedWebhookEndpointSnapshot | null): boolean => endpoint !== null
      && (endpoint.endpoint_url === context.desired.endpoint_url
        || endpoint.endpoint_url === confirmedEndpoint);
    const notOurs = (): WebhookRegistrationAdapterError => new WebhookRegistrationAdapterError(
      'upstream_rejected',
      'Telegram bot webhook ownership could not be confirmed; its secret was not set',
    );
    if (!ours(current)) throw notOurs();
    // D-201 Slice 10BB (10AY finding 7) — a certificate set at Telegram cannot
    // be sent back, and a set without it drops it (the Bot API's documented
    // default): not set, rather than set without saying so. D-201 Slice 10BG
    // (10BF finding 13) — under its own code, so the card says so: it reached
    // only the log, and the card's advice dropped the certificate.
    if (info.held.custom_certificate) {
      throw new WebhookRegistrationAdapterError(
        'certificate_unheld',
        'Telegram bot webhook uses a certificate Recued does not hold, which setting it again would drop; '
          + 'its secret was not set',
      );
    }
    // And its connection limit, sent back as it reports it; never its address.
    await setDesired(context, await activeSecretFor(context), {
      endpoint_url: current.endpoint_url,
      ...(info.held.max_connections !== undefined ? { max_connections: info.held.max_connections } : {}),
    }, async () => {
      if (!ours(await readCurrent(context))) throw notOurs();
    });
    return readCurrent(context);
  };

  const driver = createWebhookProviderSingletonRegistrationDriver(
    TELEGRAM_REGISTRATION_DRIVER_PRESET,
    {
      inspect,
      async create(
        context,
        idempotencyKey,
        lifecycle: WebhookProviderSingletonLifecycle,
      ): Promise<ManagedWebhookEndpointCreateResult> {
        validateIdempotencyKey(idempotencyKey, deps.idempotencyKeyParser);
        assertDesiredEventTypesAdmitted(context, deps.eventTypeParser, 'Telegram');
        refuseUnlistedNames(context);
        // `setWebhook` replaces the singleton. Re-read immediately before the
        // mutation so an existing manual/legacy URL is never intentionally
        // overwritten, even if it appeared after the coordinator's search.
        // D-201 Slice 10T (10Q finding 8) — and again before a retry.
        const stillEmpty = async (): Promise<void> => {
          if ((await lifecycle.find()).length > 0) {
            throw new WebhookRegistrationAdapterError(
              'upstream_rejected',
              'Telegram bot already has a webhook; no endpoint was changed',
            );
          }
        };
        await stillEmpty();
        const secret = deps.secretParser.parse(generateSecret());
        if (secret === null) {
          throw new WebhookRegistrationAdapterError(
            'registration_input_invalid',
            'Telegram managed webhook secret generation failed',
          );
        }
        await setDesired(context, secret, context.desired, stillEmpty);
        let skipped: string[];
        try {
          skipped = await namesTelegramSkipped(context);
        } catch (error) {
          if (!(await removeUnstoredWebhook(context))) throw setButStanding(error);
          throw error;
        }
        if (skipped.length > 0) {
          // D-201 Slice 10AH (10AE finding 7) — named whether or not the undo
          // worked: an unknown-names error already counts as one that may have
          // landed (`createMayHaveLanded`), so its record stays for the sweep
          // either way. Wrapped as set-but-standing, Settings showed the bare
          // unconfirmed code and the RPC no names.
          await removeUnstoredWebhook(context);
          throw skippedNamesError(skipped);
        }
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
        assertDesiredEventTypesAdmitted(context, deps.eventTypeParser, 'Telegram');
        refuseUnlistedNames(context);
        const currentRemoteId = await remoteIdFor(context);
        if (currentRemoteId !== parsedRemoteEndpointId) {
          throw new WebhookRegistrationAdapterError(
            'upstream_rejected',
            'Telegram paired bot identity does not match the committed webhook; no endpoint was changed',
          );
        }
        const { snapshot: current, on_default: wasOnDefault, held } = await readWebhookInfo(context);
        const confirmedEndpoint = await confirmedEndpointFor(context);
        const ours = (endpoint: ManagedWebhookEndpointSnapshot | null): boolean => endpoint !== null
          && (endpoint.endpoint_url === context.desired.endpoint_url
            || endpoint.endpoint_url === confirmedEndpoint);
        const notOurs = (): WebhookRegistrationAdapterError => new WebhookRegistrationAdapterError(
          'upstream_rejected',
          'Telegram bot webhook ownership could not be confirmed; no endpoint was changed',
        );
        if (current === null || !ours(current)) throw notOurs();
        // D-201 Slice 10BQ (10BM finding 15) — a certificate set at Telegram, as
        // the set again refuses it: this set would drop it. The owner's "Line the
        // address up again" took this road and dropped it, beside words saying
        // Recued did not set the webhook again over that certificate.
        if (held.custom_certificate) {
          throw new WebhookRegistrationAdapterError(
            'certificate_unheld',
            'Telegram bot webhook uses a certificate Recued does not hold, which changing it would drop; '
              + 'no endpoint was changed',
          );
        }
        // The secret resent is the one Recued holds, so a skipped name leaves
        // Telegram sending the names it knows, under that secret.
        const activeSecret = await activeSecretFor(context);
        // D-201 Slice 10BG (10BF finding 13) — the bot's connection limit kept,
        // as the set again keeps it. An address the owner fixed at Telegram is
        // reset by this set, as by any Recued makes; a certificate set there
        // refuses it (above, since 10BQ).
        const kept = held.max_connections !== undefined ? { max_connections: held.max_connections } : {};
        // D-201 Slice 10T (10Q finding 8) — still this webhook before a retry.
        await setDesired(context, activeSecret, { ...context.desired, ...kept }, async () => {
          if (!ours(await readCurrent(context))) throw notOurs();
        });
        const skipped = await namesTelegramSkipped(context);
        if (skipped.length > 0
          && skipped.length === context.desired.event_types.length
          && wasOnDefault) {
          // D-201 Slice 10T (10Q finding 7) — it was on Telegram's default
          // before this update, which reads back as the default's names:
          // "putting back" those named them all and reported a restore, and
          // the warning that it may send every update type was lost. It stays
          // on its default, and says so every pass that finds it there.
          throw new WebhookRegistrationAdapterError(
            'event_types_unknown',
            `Telegram does not know ${skipped.length === 1 ? 'the update name' : 'any of the update names'} ${skipped.join(', ')}; `
              + 'it was on its default set already, so it may send every update type',
            skipped,
            // D-201 Slice 10Z (10V finding 25) — nothing was put back.
            { left_on_default: true, was_on_default: true },
          );
        }
        if (skipped.length > 0
          && skipped.length === context.desired.event_types.length) {
          // D-201 Slice 10K (10H finding 16) — Telegram knew none of them and
          // fell back to its default set: every update type would arrive under
          // the held secret. Put back the URL and names it held before.
          let restored = false;
          // D-201 Slice 10Z (10V finding 24) — a set made only of the kinds
          // Telegram never lists reads back as no names, and cannot be put
          // back: sent as no names, Telegram takes its default, which read back
          // as a restore. It stays on the default, and says it could not be.
          if (current.event_types.length > 0) {
            try {
              await setDesired(context, activeSecret, {
                endpoint_url: current.endpoint_url,
                event_types: current.event_types,
                ...kept,
              }, async () => {
                // D-201 Slice 10T (10Q finding 8) — still the webhook this
                // update set before the put-back's retry: another party's set
                // in that second is not replaced.
                const now = await readCurrent(context);
                if (now === null || now.endpoint_url !== context.desired.endpoint_url) {
                  throw new TelegramWebhookChangedError();
                }
              });
              restored = true;
            } catch (error) {
              if (error instanceof TelegramWebhookChangedError) throw error;
              // Reported below: the next pass reads what Telegram holds.
            }
          }
          throw new WebhookRegistrationAdapterError(
            'event_types_unknown',
            `Telegram does not know ${skipped.length === 1 ? 'the update name' : 'any of the update names'} ${skipped.join(', ')}; `
              + (restored
                ? 'it was put back to the updates it had'
                : 'it could not be put back to the updates it had, so it may now send every update type'),
            skipped,
            // D-201 Slice 10O — stored too, so Settings says it long after.
            restored ? {} : { left_on_default: true },
          );
        }
        if (skipped.length > 0) throw skippedNamesError(skipped);
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
  return Object.freeze({ ...driver, setSecret });
};
