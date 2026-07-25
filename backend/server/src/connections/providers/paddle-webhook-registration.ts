/** D-201 Slices 8I + 9I + 9AG + 9AK + 9AO + 9AU + 9AZ + 9BD + 9BE + 9BI — bounded Paddle notification-setting registration.
 *
 * Paddle separates Sandbox and Live by API-key prefix and fixed API origin.
 * Every request path, header, method, and JSON field below is trusted code;
 * neither packs nor recipes can supply provider request authority. Slice 8J
 * composes this adapter only through the declared connection-bound managed
 * registration path.
 */

import {
  createWebhookAddressableCollectionRegistrationDriver,
} from '../../webhook-addressable-collection-registration-driver.js';
import {
  WebhookRegistrationAdapterError,
  type ManagedWebhookEndpointCreateResult,
  type ManagedWebhookEndpointMatch,
  type ManagedWebhookEndpointSnapshot,
  type ManagedWebhookRegistrationContext,
  type WebhookManagedEndpointRegistrationAdapter,
} from '../../webhook-registration-runtime.js';
import type {
  WebhookDotSegmentEventTypeParser,
} from '../../webhook-dot-segment-event-type-parser.js';
import type {
  WebhookRegistrationJsonResponseReader,
  WebhookRegistrationPendingResponse,
} from '../../webhook-registration-json-response-reader.js';
import type {
  WebhookRegistrationIdempotencyKeyParser,
} from '../../webhook-registration-idempotency-key-parser.js';
import type {
  WebhookFixedPrefixProviderIdParser,
} from '../../webhook-fixed-prefix-provider-id-parser.js';
import type {
  WebhookSegmentedAsciiTokenParser,
} from '../../webhook-segmented-ascii-token-parser.js';
import type {
  WebhookHttpOrOpaqueDestinationParser,
} from '../../webhook-http-or-opaque-destination-parser.js';
import type {
  WebhookEnvironmentMappedSegmentedAsciiTokenClassifier,
} from '../../webhook-environment-mapped-segmented-ascii-token-classifier.js';
import {
  WEBHOOK_INGRESS_ID_PARSER,
} from '../../webhook-core-identity-parsers.js';
import {
  webhookAddressableCollectionRegistrationDriverPreset,
} from '../../webhook-registration-driver-profile-presets.js';

const PADDLE_LIVE_API_ORIGIN = 'https://api.paddle.com';
const PADDLE_SANDBOX_API_ORIGIN = 'https://sandbox-api.paddle.com';
const PADDLE_API_VERSION = '1';
const PADDLE_NOTIFICATION_SETTINGS_PATH = '/notification-settings';
const MAX_PADDLE_REMOTE_EVENT_TYPES = 128;
const DEFAULT_PADDLE_REGISTRATION_TIMEOUT_MS = 10_000;

const PADDLE_REGISTRATION_DRIVER_PRESET =
  webhookAddressableCollectionRegistrationDriverPreset(
    'paddle.notification.v1',
  );
if (PADDLE_REGISTRATION_DRIVER_PRESET === null) {
  throw new Error('Paddle addressable-collection driver preset is unavailable');
}

export interface PaddleWebhookRegistrationConnection {
  api_key: string;
}

/** Locally committed state used to distinguish one Recued-owned destination
 * from another URL destination visible to the same account-wide API key. */
export interface PaddleWebhookRegistrationOwnership {
  remote_endpoint_id: string;
  confirmed_endpoint_url: string;
  endpoint_secret_key: string;
}

export interface PaddleWebhookRegistrationDeps {
  apiKeyClassifier: WebhookEnvironmentMappedSegmentedAsciiTokenClassifier;
  endpointSecretParser: WebhookSegmentedAsciiTokenParser;
  eventTypeParser: WebhookDotSegmentEventTypeParser;
  idempotencyKeyParser: WebhookRegistrationIdempotencyKeyParser;
  remoteIdParser: WebhookFixedPrefixProviderIdParser;
  destinationParser: WebhookHttpOrOpaqueDestinationParser;
  responseReader: WebhookRegistrationJsonResponseReader;
  resolveConnection: (
    pairedConnectionId: string,
  ) => Promise<PaddleWebhookRegistrationConnection | null>;
  resolveOwnership: (
    ingressId: string,
  ) => PaddleWebhookRegistrationOwnership | null
    | Promise<PaddleWebhookRegistrationOwnership | null>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

interface PinnedPaddleConnection {
  api_key: string;
  environment: 'test' | 'live';
  origin: string;
}

interface PaddleAddressableCollectionSearchSession {
  connection: PinnedPaddleConnection;
  ownership: PaddleWebhookRegistrationOwnership | null;
  seen_ids: Set<string>;
  seen_cursors: Set<string>;
  last_seen_id: string | null;
}

interface ParsedPaddleNotificationSetting {
  snapshot: ManagedWebhookEndpointSnapshot;
  description: string;
  type: string;
  api_version: number;
  include_sensitive_fields: boolean;
  traffic_source: 'all' | 'platform' | 'simulation';
  endpoint_secret_key: string;
}

interface ParsedPaddleList {
  settings: readonly ParsedPaddleNotificationSetting[];
  has_more: boolean;
  next: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const canonicalDesiredEndpoint = (
  value: unknown,
  destinationParser: WebhookHttpOrOpaqueDestinationParser,
): string | null => {
  const endpoint = destinationParser.parse(
    destinationParser.preset.http_url_discriminator,
    value,
  );
  if (endpoint === null) return null;
  const parsed = new URL(endpoint);
  return parsed.protocol === 'https:'
    && parsed.search.length === 0
    && parsed.hash.length === 0
    && parsed.href === endpoint
    ? endpoint
    : null;
};

const desiredDescription = (
  context: ManagedWebhookRegistrationContext,
): string => [
  'Recued managed webhook',
  'paddle.notification.v1',
  context.desired.environment,
  context.desired.ingress_id,
].join(' | ');

const desiredTrafficSource = (
  context: ManagedWebhookRegistrationContext,
): 'all' | 'platform' => context.desired.environment === 'test'
  ? 'all'
  : 'platform';

const validateContext = (
  context: ManagedWebhookRegistrationContext,
  eventTypeParser: WebhookDotSegmentEventTypeParser,
  destinationParser: WebhookHttpOrOpaqueDestinationParser,
): void => {
  const { desired } = context;
  if (context.paired_connection_id.trim().length === 0
    || context.paired_connection_id.length > 256
    || WEBHOOK_INGRESS_ID_PARSER.parse(desired.ingress_id) === null
    || (desired.environment !== 'test' && desired.environment !== 'live')
    || desired.registration_target !== null
    || canonicalDesiredEndpoint(desired.endpoint_url, destinationParser) === null
    || desired.event_types.length < 1
    || desired.event_types.length > 64
    || new Set(desired.event_types).size !== desired.event_types.length
    || desired.event_types.some(
      (eventType) => eventTypeParser.parse(eventType) === null,
    )
    || desiredDescription(context).length > 500) {
    throw new WebhookRegistrationAdapterError(
      'registration_input_invalid',
      'Paddle managed registration input is invalid',
    );
  }
};

const validateRemoteId = (
  remoteEndpointId: string,
  parser: WebhookFixedPrefixProviderIdParser,
): void => {
  if (parser.parse(remoteEndpointId) === null) {
    throw new WebhookRegistrationAdapterError(
      'upstream_response_invalid',
      'Paddle remote notification-setting id is invalid',
    );
  }
};

const validateIdempotencyKey = (
  idempotencyKey: string,
  parser: WebhookRegistrationIdempotencyKeyParser,
): void => {
  if (parser.parse(idempotencyKey) === null) {
    throw new WebhookRegistrationAdapterError(
      'registration_input_invalid',
      'Paddle registration idempotency key is invalid',
    );
  }
};

const sameEvents = (
  left: readonly string[],
  right: readonly string[],
): boolean => {
  if (left.length !== right.length) return false;
  const sortedLeft = left.slice().sort();
  const sortedRight = right.slice().sort();
  return sortedLeft.every((entry, index) => entry === sortedRight[index]);
};

const responseErrorCode = (
  response: Response,
): 'connection_auth_invalid' | 'upstream_unavailable' | 'upstream_rejected' => {
  if (response.status === 401 || response.status === 403) {
    return 'connection_auth_invalid';
  }
  if (response.status === 429 || response.status >= 500) {
    return 'upstream_unavailable';
  }
  return 'upstream_rejected';
};

const parseMeta = (value: unknown): Record<string, unknown> => {
  if (!isRecord(value)
    || typeof value.request_id !== 'string'
    || value.request_id.length === 0
    || value.request_id.length > 128) {
    throw new WebhookRegistrationAdapterError(
      'upstream_response_invalid',
      'Paddle returned invalid response metadata',
    );
  }
  return value;
};

const parseSubscribedEvents = (
  value: unknown,
  eventTypeParser: WebhookDotSegmentEventTypeParser,
): readonly string[] => {
  if (!Array.isArray(value)
    || value.length > MAX_PADDLE_REMOTE_EVENT_TYPES) {
    throw new WebhookRegistrationAdapterError(
      'upstream_response_invalid',
      'Paddle returned an invalid subscribed-event list',
    );
  }
  const eventTypes: string[] = [];
  for (const eventType of value) {
    if (!isRecord(eventType)) {
      throw new WebhookRegistrationAdapterError(
        'upstream_response_invalid',
        'Paddle returned an invalid subscribed-event object',
      );
    }
    const parsedEventType = eventTypeParser.parse(eventType.name);
    if (parsedEventType === null) {
      throw new WebhookRegistrationAdapterError(
        'upstream_response_invalid',
        'Paddle returned an invalid subscribed-event object',
      );
    }
    eventTypes.push(parsedEventType);
  }
  if (new Set(eventTypes).size !== eventTypes.length) {
    throw new WebhookRegistrationAdapterError(
      'upstream_response_invalid',
      'Paddle returned duplicate subscribed events',
    );
  }
  return eventTypes;
};

const parseNotificationSetting = (
  value: unknown,
  context: ManagedWebhookRegistrationContext,
  eventTypeParser: WebhookDotSegmentEventTypeParser,
  remoteIdParser: WebhookFixedPrefixProviderIdParser,
  endpointSecretParser: WebhookSegmentedAsciiTokenParser,
  destinationParser: WebhookHttpOrOpaqueDestinationParser,
): ParsedPaddleNotificationSetting => {
  if (!isRecord(value)) {
    throw new WebhookRegistrationAdapterError(
      'upstream_response_invalid',
      'Paddle returned an invalid notification-setting object',
    );
  }
  const remoteEndpointId = remoteIdParser.parse(value.id);
  if (remoteEndpointId === null
    || typeof value.description !== 'string'
    || value.description.length === 0
    || value.description.length > 500
    || (value.type !== destinationParser.preset.opaque_discriminator
      && value.type !== destinationParser.preset.http_url_discriminator)
    || typeof value.active !== 'boolean'
    || typeof value.api_version !== 'number'
    || !Number.isSafeInteger(value.api_version)
    || value.api_version < 1
    || typeof value.include_sensitive_fields !== 'boolean'
    || (value.traffic_source !== 'all'
      && value.traffic_source !== 'platform'
      && value.traffic_source !== 'simulation')) {
    throw new WebhookRegistrationAdapterError(
      'upstream_response_invalid',
      'Paddle returned an invalid notification-setting object',
    );
  }
  const endpointSecretKey = endpointSecretParser.parse(
    value.endpoint_secret_key,
  );
  if (endpointSecretKey === null) {
    throw new WebhookRegistrationAdapterError(
      'upstream_response_invalid',
      'Paddle returned an invalid notification-setting object',
    );
  }
  const destination = destinationParser.parse(
    value.type,
    value.destination,
  );
  if (destination === null) {
    throw new WebhookRegistrationAdapterError(
      'upstream_response_invalid',
      'Paddle returned an invalid notification destination',
    );
  }
  const eventTypes = parseSubscribedEvents(
    value.subscribed_events,
    eventTypeParser,
  );
  return {
    snapshot: {
      remote_endpoint_id: remoteEndpointId,
      environment: context.desired.environment,
      endpoint_url: destination,
      event_types: eventTypes,
      enabled: value.active,
      correlation_valid: false,
    },
    description: value.description,
    type: value.type,
    api_version: value.api_version,
    include_sensitive_fields: value.include_sensitive_fields,
    traffic_source: value.traffic_source,
    endpoint_secret_key: endpointSecretKey,
  };
};

const parseEntityEnvelope = (
  value: unknown,
  context: ManagedWebhookRegistrationContext,
  eventTypeParser: WebhookDotSegmentEventTypeParser,
  remoteIdParser: WebhookFixedPrefixProviderIdParser,
  endpointSecretParser: WebhookSegmentedAsciiTokenParser,
  destinationParser: WebhookHttpOrOpaqueDestinationParser,
): ParsedPaddleNotificationSetting => {
  if (!isRecord(value) || !Object.prototype.hasOwnProperty.call(value, 'data')) {
    throw new WebhookRegistrationAdapterError(
      'upstream_response_invalid',
      'Paddle returned an invalid notification-setting envelope',
    );
  }
  parseMeta(value.meta);
  return parseNotificationSetting(
    value.data,
    context,
    eventTypeParser,
    remoteIdParser,
    endpointSecretParser,
    destinationParser,
  );
};
const parseListEnvelope = (
  value: unknown,
  context: ManagedWebhookRegistrationContext,
  eventTypeParser: WebhookDotSegmentEventTypeParser,
  remoteIdParser: WebhookFixedPrefixProviderIdParser,
  endpointSecretParser: WebhookSegmentedAsciiTokenParser,
  destinationParser: WebhookHttpOrOpaqueDestinationParser,
  pageSize: number,
): ParsedPaddleList => {
  if (!isRecord(value)
    || !Array.isArray(value.data)
    || value.data.length > pageSize) {
    throw new WebhookRegistrationAdapterError(
      'upstream_response_invalid',
      'Paddle returned an invalid notification-setting list',
    );
  }
  const meta = parseMeta(value.meta);
  const pagination = meta.pagination;
  if (!isRecord(pagination)
    || typeof pagination.per_page !== 'number'
    || !Number.isSafeInteger(pagination.per_page)
    || pagination.per_page < 1
    || pagination.per_page > pageSize
    || typeof pagination.next !== 'string'
    || pagination.next.length === 0
    || pagination.next.length > 4_096
    || typeof pagination.has_more !== 'boolean'
    || (pagination.estimated_total !== undefined
      && (typeof pagination.estimated_total !== 'number'
        || !Number.isSafeInteger(pagination.estimated_total)
        || pagination.estimated_total < -1))) {
    throw new WebhookRegistrationAdapterError(
      'upstream_response_invalid',
      'Paddle returned invalid pagination metadata',
    );
  }
  return {
    settings: value.data.map((setting) =>
      parseNotificationSetting(
        setting,
        context,
        eventTypeParser,
        remoteIdParser,
        endpointSecretParser,
        destinationParser,
      )),
    has_more: pagination.has_more,
    next: pagination.next,
  };
};

const desiredConfigurationMatches = (
  parsed: ParsedPaddleNotificationSetting,
  context: ManagedWebhookRegistrationContext,
  destinationParser: WebhookHttpOrOpaqueDestinationParser,
): boolean => parsed.description === desiredDescription(context)
  && parsed.type === destinationParser.preset.http_url_discriminator
  && parsed.api_version === 1
  && !parsed.include_sensitive_fields
  && parsed.traffic_source === desiredTrafficSource(context)
  && parsed.snapshot.endpoint_url === context.desired.endpoint_url
  && parsed.snapshot.enabled
  && sameEvents(parsed.snapshot.event_types, context.desired.event_types);

const mutableSettingBody = (
  context: ManagedWebhookRegistrationContext,
): Readonly<Record<string, unknown>> => ({
  description: desiredDescription(context),
  destination: context.desired.endpoint_url,
  active: true,
  api_version: 1,
  include_sensitive_fields: false,
  subscribed_events: context.desired.event_types.slice(),
  traffic_source: desiredTrafficSource(context),
});

const createSettingBody = (
  context: ManagedWebhookRegistrationContext,
  destinationParser: WebhookHttpOrOpaqueDestinationParser,
): Readonly<Record<string, unknown>> => ({
  type: destinationParser.preset.http_url_discriminator,
  description: desiredDescription(context),
  destination: context.desired.endpoint_url,
  api_version: 1,
  include_sensitive_fields: false,
  subscribed_events: context.desired.event_types.slice(),
  traffic_source: desiredTrafficSource(context),
});

export const createPaddleWebhookRegistrationAdapter = (
  deps: PaddleWebhookRegistrationDeps,
): WebhookManagedEndpointRegistrationAdapter => {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_PADDLE_REGISTRATION_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) {
    throw new Error('Paddle webhook registration timeout must be in 100..60000ms');
  }
  const readBoundedText = (
    pending: WebhookRegistrationPendingResponse,
  ): Promise<string> => deps.responseReader.readText(pending);
  const parseJson = (
    pending: WebhookRegistrationPendingResponse,
  ): Promise<unknown> => deps.responseReader.readJson(pending);
  const validateRegistrationContext = (
    context: ManagedWebhookRegistrationContext,
  ): void => validateContext(
    context,
    deps.eventTypeParser,
    deps.destinationParser,
  );
  const parseEntityForProfile = (
    value: unknown,
    context: ManagedWebhookRegistrationContext,
  ): ParsedPaddleNotificationSetting => parseEntityEnvelope(
    value,
    context,
    deps.eventTypeParser,
    deps.remoteIdParser,
    deps.endpointSecretParser,
    deps.destinationParser,
  );
  const parseListForProfile = (
    value: unknown,
    context: ManagedWebhookRegistrationContext,
    pageSize: number,
  ): ParsedPaddleList => parseListEnvelope(
    value,
    context,
    deps.eventTypeParser,
    deps.remoteIdParser,
    deps.endpointSecretParser,
    deps.destinationParser,
    pageSize,
  );

  const connectionByContext = new WeakMap<
    ManagedWebhookRegistrationContext,
    Promise<PinnedPaddleConnection>
  >();
  const ownershipByContext = new WeakMap<
    ManagedWebhookRegistrationContext,
    Promise<PaddleWebhookRegistrationOwnership | null>
  >();
  const pendingOwnershipByContext = new WeakMap<
    ManagedWebhookRegistrationContext,
    PaddleWebhookRegistrationOwnership
  >();

  const connectionFor = async (
    context: ManagedWebhookRegistrationContext,
  ): Promise<PinnedPaddleConnection> => {
    validateRegistrationContext(context);
    const cached = connectionByContext.get(context);
    if (cached) return cached;
    const resolved = (async (): Promise<PinnedPaddleConnection> => {
      let connection: PaddleWebhookRegistrationConnection | null;
      try {
        connection = await deps.resolveConnection(context.paired_connection_id);
      } catch (error) {
        if (error instanceof WebhookRegistrationAdapterError) throw error;
        throw new WebhookRegistrationAdapterError(
          'connection_unavailable',
          'Paddle connection could not be resolved',
        );
      }
      if (connection === null) {
        throw new WebhookRegistrationAdapterError(
          'connection_unavailable',
          'Paddle connection is not available',
        );
      }
      const classified = deps.apiKeyClassifier.classify(connection.api_key);
      if (classified === null) {
        throw new WebhookRegistrationAdapterError(
          'connection_auth_invalid',
          'Paddle managed registration requires a modern API key',
        );
      }
      const apiKey = classified.value;
      const environment = classified.environment;
      if (environment !== context.desired.environment) {
        throw new WebhookRegistrationAdapterError(
          'environment_mismatch',
          'Paddle API key environment does not match the ingress environment',
        );
      }
      return {
        api_key: apiKey,
        environment,
        origin: environment === 'test'
          ? PADDLE_SANDBOX_API_ORIGIN
          : PADDLE_LIVE_API_ORIGIN,
      };
    })();
    connectionByContext.set(context, resolved);
    return resolved;
  };

  const storedOwnershipFor = async (
    context: ManagedWebhookRegistrationContext,
  ): Promise<PaddleWebhookRegistrationOwnership | null> => {
    validateRegistrationContext(context);
    const cached = ownershipByContext.get(context);
    if (cached) return cached;
    const resolved = (async (): Promise<PaddleWebhookRegistrationOwnership | null> => {
      let ownership: PaddleWebhookRegistrationOwnership | null;
      try {
        ownership = await deps.resolveOwnership(context.desired.ingress_id);
      } catch (error) {
        if (error instanceof WebhookRegistrationAdapterError) throw error;
        throw new WebhookRegistrationAdapterError(
          'connection_unavailable',
          'Paddle managed webhook state could not be resolved',
        );
      }
      if (ownership === null) return null;
      const remoteEndpointId = deps.remoteIdParser.parse(
        ownership.remote_endpoint_id,
      );
      if (remoteEndpointId === null
        || canonicalDesiredEndpoint(
          ownership.confirmed_endpoint_url,
          deps.destinationParser,
        ) === null) {
        throw new WebhookRegistrationAdapterError(
          'registration_input_invalid',
          'Paddle managed webhook ownership state is invalid',
        );
      }
      const endpointSecretKey = deps.endpointSecretParser.parse(
        ownership.endpoint_secret_key,
      );
      if (endpointSecretKey === null) {
        throw new WebhookRegistrationAdapterError(
          'registration_input_invalid',
          'Paddle managed webhook ownership state is invalid',
        );
      }
      return Object.freeze({
        remote_endpoint_id: remoteEndpointId,
        confirmed_endpoint_url: ownership.confirmed_endpoint_url,
        endpoint_secret_key: endpointSecretKey,
      });
    })();
    ownershipByContext.set(context, resolved);
    return resolved;
  };

  const effectiveOwnershipFor = async (
    context: ManagedWebhookRegistrationContext,
  ): Promise<PaddleWebhookRegistrationOwnership | null> =>
    pendingOwnershipByContext.get(context) ?? storedOwnershipFor(context);

  const request = async (
    context: ManagedWebhookRegistrationContext,
    pathAndQuery: string,
    init: {
      method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
      body?: Readonly<Record<string, unknown>>;
      skipCount?: boolean;
    },
  ): Promise<WebhookRegistrationPendingResponse> => {
    const connection = await connectionFor(context);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const headers = new Headers({
        Accept: 'application/json',
        Authorization: `Bearer ${connection.api_key}`,
        'Paddle-Version': PADDLE_API_VERSION,
      });
      if (init.body !== undefined) {
        headers.set('Content-Type', 'application/json; charset=utf-8');
      }
      if (init.skipCount) headers.set('Skip-Count', 'true');
      const response = await fetchImpl(`${connection.origin}${pathAndQuery}`, {
        method: init.method,
        headers,
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
        redirect: 'error',
        cache: 'no-store',
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        signal: controller.signal,
      });
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
        'Paddle webhook registration request did not complete',
      );
    }
  };

  const requireJsonStatus = async (
    pending: WebhookRegistrationPendingResponse,
    expectedStatus: 200 | 201,
  ): Promise<unknown> => {
    if (pending.response.status !== expectedStatus) {
      await readBoundedText(pending);
      if (pending.response.ok) {
        throw new WebhookRegistrationAdapterError(
          'upstream_response_invalid',
          `Paddle webhook registration returned unexpected HTTP ${pending.response.status}`,
        );
      }
      throw new WebhookRegistrationAdapterError(
        responseErrorCode(pending.response),
        `Paddle webhook registration returned HTTP ${pending.response.status}`,
      );
    }
    return parseJson(pending);
  };

  const correlatedSnapshot = async (
    context: ManagedWebhookRegistrationContext,
    parsed: ParsedPaddleNotificationSetting,
  ): Promise<ManagedWebhookEndpointSnapshot> => {
    const ownership = await effectiveOwnershipFor(context);
    const ownershipValid = ownership === null
      ? parsed.description === desiredDescription(context)
        && parsed.type === deps.destinationParser.preset.http_url_discriminator
        && parsed.snapshot.endpoint_url === context.desired.endpoint_url
      : parsed.snapshot.remote_endpoint_id === ownership.remote_endpoint_id
        && parsed.endpoint_secret_key === ownership.endpoint_secret_key
        && (parsed.snapshot.endpoint_url === context.desired.endpoint_url
          || parsed.snapshot.endpoint_url === ownership.confirmed_endpoint_url);
    return {
      ...parsed.snapshot,
      correlation_valid: ownershipValid
        && parsed.description === desiredDescription(context)
        && parsed.type === deps.destinationParser.preset.http_url_discriminator
        && parsed.api_version === 1
        && !parsed.include_sensitive_fields
        && parsed.traffic_source === desiredTrafficSource(context),
    };
  };

  const readParsed = async (
    context: ManagedWebhookRegistrationContext,
    remoteEndpointId: string,
  ): Promise<ParsedPaddleNotificationSetting | null> => {
    validateRemoteId(remoteEndpointId, deps.remoteIdParser);
    validateRegistrationContext(context);
    const response = await request(
      context,
      `${PADDLE_NOTIFICATION_SETTINGS_PATH}/${encodeURIComponent(remoteEndpointId)}`,
      { method: 'GET' },
    );
    if (response.response.status === 404) {
      await readBoundedText(response);
      return null;
    }
    const parsed = parseEntityForProfile(
      await requireJsonStatus(response, 200),
      context,
    );
    if (parsed.snapshot.remote_endpoint_id !== remoteEndpointId) {
      throw new WebhookRegistrationAdapterError(
        'upstream_response_invalid',
        'Paddle retrieve response notification-setting id did not match the request',
      );
    }
    return parsed;
  };

  const read = async (
    context: ManagedWebhookRegistrationContext,
    remoteEndpointId: string,
  ): Promise<ManagedWebhookEndpointSnapshot | null> => {
    // Pin local ownership before the provider read so one authorization
    // decision cannot straddle a concurrent local state change.
    await effectiveOwnershipFor(context);
    const parsed = await readParsed(context, remoteEndpointId);
    return parsed === null ? null : correlatedSnapshot(context, parsed);
  };

  const checkedNextCursor = (
    next: string,
    origin: string,
    expectedLastId: string,
    pageSize: number,
  ): string => {
    let parsed: URL;
    try {
      parsed = new URL(next);
    } catch {
      throw new WebhookRegistrationAdapterError(
        'upstream_response_invalid',
        'Paddle returned an invalid pagination URL',
      );
    }
    const allowedKeys = new Set(['after', 'order_by', 'per_page']);
    const entries = [...parsed.searchParams.entries()];
    if (parsed.origin !== origin
      || parsed.pathname !== PADDLE_NOTIFICATION_SETTINGS_PATH
      || parsed.username.length !== 0
      || parsed.password.length !== 0
      || parsed.hash.length !== 0
      || entries.some(([key]) => !allowedKeys.has(key))
      || entries.filter(([key]) => key === 'after').length !== 1
      || entries.filter(([key]) => key === 'order_by').length > 1
      || entries.filter(([key]) => key === 'per_page').length > 1
      || parsed.searchParams.get('after') !== expectedLastId
      || (parsed.searchParams.has('order_by')
        && parsed.searchParams.get('order_by') !== 'id[ASC]')
      || (parsed.searchParams.has('per_page')
        && parsed.searchParams.get('per_page') !== String(pageSize))) {
      throw new WebhookRegistrationAdapterError(
        'upstream_response_invalid',
        'Paddle returned unsafe pagination authority',
      );
    }
    return expectedLastId;
  };

  return createWebhookAddressableCollectionRegistrationDriver<PaddleAddressableCollectionSearchSession>(
    PADDLE_REGISTRATION_DRIVER_PRESET,
    {
      async prepareSearch(context) {
        validateRegistrationContext(context);
        return {
          connection: await connectionFor(context),
          ownership: await effectiveOwnershipFor(context),
          seen_ids: new Set<string>(),
          seen_cursors: new Set<string>(),
          last_seen_id: null,
        };
      },
      async readSearchPage(context, session, page) {
        const matches: ManagedWebhookEndpointMatch[] = [];
        const query = new URLSearchParams({
          per_page: String(page.page_size),
          order_by: 'id[ASC]',
        });
        if (page.after !== null) query.set('after', page.after);
        const response = await request(
          context,
          `${PADDLE_NOTIFICATION_SETTINGS_PATH}?${query.toString()}`,
          { method: 'GET', skipCount: true },
        );
        const parsed = parseListForProfile(
          await requireJsonStatus(response, 200),
          context,
          page.page_size,
        );
        for (const setting of parsed.settings) {
          const id = setting.snapshot.remote_endpoint_id;
          if (session.seen_ids.has(id)) {
            throw new WebhookRegistrationAdapterError(
              'upstream_response_invalid',
              'Paddle returned a duplicate notification-setting id',
            );
          }
          if (session.last_seen_id !== null && id <= session.last_seen_id) {
            throw new WebhookRegistrationAdapterError(
              'upstream_response_invalid',
              'Paddle returned notification settings outside ascending id order',
            );
          }
          session.seen_ids.add(id);
          session.last_seen_id = id;
          const descriptionMatch =
            setting.description === desiredDescription(context);
          const desiredUrlMatch =
            setting.type ===
              deps.destinationParser.preset.http_url_discriminator &&
            setting.snapshot.endpoint_url === context.desired.endpoint_url;
          const ownerIdMatch =
            session.ownership !== null &&
            id === session.ownership.remote_endpoint_id;
          const ownerProof =
            ownerIdMatch &&
            setting.endpoint_secret_key ===
              session.ownership?.endpoint_secret_key;
          const ownerUrlMatch =
            ownerIdMatch &&
            (desiredUrlMatch ||
              setting.snapshot.endpoint_url ===
                session.ownership?.confirmed_endpoint_url);
          let correlation: ManagedWebhookEndpointMatch['correlation'] | null =
            null;
          if (
            session.ownership === null &&
            descriptionMatch &&
            desiredUrlMatch
          ) {
            correlation = 'owned';
          } else if (
            ownerProof &&
            ownerUrlMatch &&
            setting.type ===
              deps.destinationParser.preset.http_url_discriminator
          ) {
            correlation = 'owned';
          } else if (descriptionMatch || ownerIdMatch) {
            correlation = 'metadata_conflict';
          } else if (desiredUrlMatch) {
            correlation = 'url_only';
          }
          if (correlation !== null) {
            matches.push({
              endpoint: await correlatedSnapshot(context, setting),
              correlation,
            });
          }
        }
        if (!parsed.has_more) return { matches, next_after: null };
        const last = parsed.settings.at(-1)?.snapshot.remote_endpoint_id;
        if (last === undefined) {
          throw new WebhookRegistrationAdapterError(
            'upstream_response_invalid',
            'Paddle returned an empty page with more results',
          );
        }
        const nextAfter = checkedNextCursor(
          parsed.next,
          session.connection.origin,
          last,
          page.page_size,
        );
        if (session.seen_cursors.has(nextAfter)) {
          throw new WebhookRegistrationAdapterError(
            'upstream_response_invalid',
            'Paddle repeated a notification-setting cursor',
          );
        }
        session.seen_cursors.add(nextAfter);
        return { matches, next_after: nextAfter };
      },
      async create(
        context,
        idempotencyKey,
        lifecycle,
      ): Promise<ManagedWebhookEndpointCreateResult> {
        validateIdempotencyKey(idempotencyKey, deps.idempotencyKeyParser);
        validateRegistrationContext(context);
        if (pendingOwnershipByContext.has(context)) {
          throw new WebhookRegistrationAdapterError(
            'registration_input_invalid',
            'Paddle managed webhook was already created in this reconciliation context',
          );
        }
        if ((await lifecycle.find()).length > 0) {
          throw new WebhookRegistrationAdapterError(
            'upstream_rejected',
            'Paddle already has a notification destination for this ingress; no endpoint was changed',
          );
        }
        if ((await storedOwnershipFor(context)) !== null) {
          throw new WebhookRegistrationAdapterError(
            'registration_input_invalid',
            'Paddle managed webhook already has committed ownership state',
          );
        }
        const response = await request(
          context,
          PADDLE_NOTIFICATION_SETTINGS_PATH,
          {
            method: 'POST',
            body: createSettingBody(context, deps.destinationParser),
          },
        );
        const parsed = parseEntityForProfile(
          await requireJsonStatus(response, 201),
          context,
        );
        if (
          !desiredConfigurationMatches(parsed, context, deps.destinationParser)
        ) {
          throw new WebhookRegistrationAdapterError(
            'upstream_response_invalid',
            'Paddle create response did not match the requested notification destination',
          );
        }
        pendingOwnershipByContext.set(context, {
          remote_endpoint_id: parsed.snapshot.remote_endpoint_id,
          confirmed_endpoint_url: context.desired.endpoint_url,
          endpoint_secret_key: parsed.endpoint_secret_key,
        });
        return {
          endpoint: await correlatedSnapshot(context, parsed),
          credential_result: {
            endpoint_secret_key: parsed.endpoint_secret_key,
          },
        };
      },
      read,
      async update(context, remoteEndpointId, idempotencyKey) {
        validateRemoteId(remoteEndpointId, deps.remoteIdParser);
        validateIdempotencyKey(idempotencyKey, deps.idempotencyKeyParser);
        validateRegistrationContext(context);
        const ownership = await effectiveOwnershipFor(context);
        const current = await readParsed(context, remoteEndpointId);
        if (
          current === null ||
          ownership === null ||
          ownership.remote_endpoint_id !== remoteEndpointId ||
          current.endpoint_secret_key !== ownership.endpoint_secret_key ||
          current.type !==
            deps.destinationParser.preset.http_url_discriminator ||
          (current.snapshot.endpoint_url !== context.desired.endpoint_url &&
            current.snapshot.endpoint_url !== ownership.confirmed_endpoint_url)
        ) {
          throw new WebhookRegistrationAdapterError(
            'upstream_rejected',
            'Paddle notification destination ownership could not be confirmed; no endpoint was changed',
          );
        }
        const response = await request(
          context,
          `${PADDLE_NOTIFICATION_SETTINGS_PATH}/${encodeURIComponent(remoteEndpointId)}`,
          { method: 'PATCH', body: mutableSettingBody(context) },
        );
        const updated = parseEntityForProfile(
          await requireJsonStatus(response, 200),
          context,
        );
        if (
          updated.snapshot.remote_endpoint_id !== remoteEndpointId ||
          updated.endpoint_secret_key !== ownership.endpoint_secret_key ||
          !desiredConfigurationMatches(updated, context, deps.destinationParser)
        ) {
          throw new WebhookRegistrationAdapterError(
            'upstream_response_invalid',
            'Paddle update response did not match the requested notification destination',
          );
        }
        return correlatedSnapshot(context, updated);
      },
      async delete(context, remoteEndpointId): Promise<void> {
        validateRemoteId(remoteEndpointId, deps.remoteIdParser);
        validateRegistrationContext(context);
        const ownership = await effectiveOwnershipFor(context);
        const current = await readParsed(context, remoteEndpointId);
        if (current === null) return;
        const committedAuthority =
          ownership !== null &&
          ownership.remote_endpoint_id === remoteEndpointId &&
          current.endpoint_secret_key === ownership.endpoint_secret_key &&
          current.type ===
            deps.destinationParser.preset.http_url_discriminator &&
          (current.snapshot.endpoint_url === context.desired.endpoint_url ||
            current.snapshot.endpoint_url === ownership.confirmed_endpoint_url);
        const orphanAuthority =
          ownership === null &&
          current.description === desiredDescription(context) &&
          current.type ===
            deps.destinationParser.preset.http_url_discriminator &&
          current.snapshot.endpoint_url === context.desired.endpoint_url;
        if (!committedAuthority && !orphanAuthority) {
          throw new WebhookRegistrationAdapterError(
            'upstream_rejected',
            'Paddle notification destination ownership could not be confirmed; no endpoint was deleted',
          );
        }
        const response = await request(
          context,
          `${PADDLE_NOTIFICATION_SETTINGS_PATH}/${encodeURIComponent(remoteEndpointId)}`,
          { method: 'DELETE' },
        );
        if (response.response.status === 404) {
          await readBoundedText(response);
          return;
        }
        const text = await readBoundedText(response);
        if (!response.response.ok) {
          throw new WebhookRegistrationAdapterError(
            responseErrorCode(response.response),
            `Paddle notification-setting deletion returned HTTP ${response.response.status}`,
          );
        }
        if (response.response.status !== 204 || text.length !== 0) {
          throw new WebhookRegistrationAdapterError(
            'upstream_response_invalid',
            'Paddle notification-setting deletion returned an invalid response',
          );
        }
      },
    },
  );
};
