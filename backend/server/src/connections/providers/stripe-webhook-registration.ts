/** D-201 Slices 6A + 9AI-9AJ + 9AP + 9AS + 9AT + 9AY + 9BB + 9BE + 9BI — bounded Stripe webhook-endpoint registration fixture.
 *
 * Stripe is the first proof because webhook endpoint objects have deterministic
 * create/retrieve/update/delete operations, return the signing secret only at
 * creation, and are isolated by the test/live API key used for the request.
 * The API origin and every path/form field below are trusted code constants;
 * recipes cannot provide an outbound request template.
 */

import type { WebhookEnvironment } from '@recued/contracts';
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
  WebhookRegistrationJsonResponseReader,
  WebhookRegistrationPendingResponse,
} from '../../webhook-registration-json-response-reader.js';
import type {
  WebhookRegistrationIdempotencyKeyParser,
} from '../../webhook-registration-idempotency-key-parser.js';
import type {
  WebhookBoundedPrefixProviderIdParser,
} from '../../webhook-bounded-prefix-provider-id-parser.js';
import type {
  WebhookAsciiEventTypeParser,
} from '../../webhook-ascii-event-type-parser.js';
import type {
  WebhookPrefixedAsciiTokenParser,
} from '../../webhook-prefixed-ascii-token-parser.js';
import type {
  WebhookBoundedHttpUrlParser,
} from '../../webhook-bounded-http-url-parser.js';
import type {
  WebhookEnvironmentMappedPrefixedAsciiTokenClassifier,
} from '../../webhook-environment-mapped-prefixed-ascii-token-classifier.js';
import {
  WEBHOOK_INGRESS_ID_PARSER,
} from '../../webhook-core-identity-parsers.js';
import {
  webhookAddressableCollectionRegistrationDriverPreset,
} from '../../webhook-registration-driver-profile-presets.js';

const STRIPE_API_ORIGIN = 'https://api.stripe.com';
const DEFAULT_STRIPE_TIMEOUT_MS = 10_000;

const STRIPE_REGISTRATION_DRIVER_PRESET =
  webhookAddressableCollectionRegistrationDriverPreset('stripe.event.v1');
if (STRIPE_REGISTRATION_DRIVER_PRESET === null) {
  throw new Error('Stripe addressable-collection driver preset is unavailable');
}

export interface StripeWebhookRegistrationConnection {
  api_key: string;
}

export interface StripeWebhookRegistrationDeps {
  apiKeyClassifier: WebhookEnvironmentMappedPrefixedAsciiTokenClassifier;
  endpointSecretParser: WebhookPrefixedAsciiTokenParser;
  eventTypeParser: WebhookAsciiEventTypeParser;
  idempotencyKeyParser: WebhookRegistrationIdempotencyKeyParser;
  remoteIdParser: WebhookBoundedPrefixProviderIdParser;
  remoteUrlParser: WebhookBoundedHttpUrlParser;
  responseReader: WebhookRegistrationJsonResponseReader;
  resolveConnection: (
    pairedConnectionId: string,
  ) => Promise<StripeWebhookRegistrationConnection | null>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

interface ParsedStripeEndpoint {
  snapshot: ManagedWebhookEndpointSnapshot;
  metadata: Readonly<Record<string, string>>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const validateContext = (
  context: ManagedWebhookRegistrationContext,
  eventTypeParser: WebhookAsciiEventTypeParser,
  remoteUrlParser: WebhookBoundedHttpUrlParser,
): void => {
  const { desired } = context;
  const endpoint = remoteUrlParser.parse(desired.endpoint_url);
  if (context.paired_connection_id.length === 0
    || context.paired_connection_id.length > 256
    || WEBHOOK_INGRESS_ID_PARSER.parse(desired.ingress_id) === null
    || (desired.environment !== 'test' && desired.environment !== 'live')
    || desired.registration_target !== null
    || endpoint === null
    || !endpoint.startsWith('https://')
    || desired.event_types.length < 1
    || desired.event_types.length > 64
    || desired.event_types.some((eventType) =>
      eventTypeParser.parse(eventType) === null)) {
    throw new WebhookRegistrationAdapterError(
      'registration_input_invalid',
      'Stripe managed registration input is invalid',
    );
  }
};

const parseMetadata = (value: unknown): Readonly<Record<string, string>> | null => {
  if (!isRecord(value)) return null;
  const metadata = Object.create(null) as Record<string, string>;
  for (const key of [
    'recued_ingress_id',
    'recued_profile_id',
    'recued_environment',
  ] as const) {
    const entry = Object.prototype.hasOwnProperty.call(value, key)
      ? value[key]
      : undefined;
    if (entry !== undefined) {
      if (typeof entry !== 'string' || entry.length > 500) return null;
      metadata[key] = entry;
    }
  }
  return metadata;
};

const parseStripeEndpoint = (
  value: unknown,
  expectedEnvironment: WebhookEnvironment,
  expectedIngressId: string,
  remoteIdParser: WebhookBoundedPrefixProviderIdParser,
  remoteUrlParser: WebhookBoundedHttpUrlParser,
): ParsedStripeEndpoint => {
  if (!isRecord(value)
    || value.object !== 'webhook_endpoint') {
    throw new WebhookRegistrationAdapterError(
      'upstream_response_invalid',
      'Stripe returned an invalid webhook endpoint object',
    );
  }
  const remoteEndpointId = remoteIdParser.parse(value.id);
  if (remoteEndpointId === null
    || typeof value.livemode !== 'boolean'
    || (value.status !== 'enabled' && value.status !== 'disabled')) {
    throw new WebhookRegistrationAdapterError(
      'upstream_response_invalid',
      'Stripe returned an invalid webhook endpoint object',
    );
  }
  const environment = value.livemode ? 'live' : 'test';
  if (expectedEnvironment !== environment) {
    throw new WebhookRegistrationAdapterError(
      'environment_mismatch',
      'Stripe webhook endpoint mode does not match the ingress environment',
    );
  }
  const endpointUrl = remoteUrlParser.parse(value.url);
  if (endpointUrl === null
    || !Array.isArray(value.enabled_events)
    || value.enabled_events.length === 0
    || value.enabled_events.length > 512
    || value.enabled_events.some((entry) =>
      typeof entry !== 'string' || entry.length === 0 || entry.length > 128)) {
    throw new WebhookRegistrationAdapterError(
      'upstream_response_invalid',
      'Stripe returned invalid webhook endpoint configuration',
    );
  }
  const metadata = parseMetadata(value.metadata);
  if (metadata === null) {
    throw new WebhookRegistrationAdapterError(
      'upstream_response_invalid',
      'Stripe returned invalid webhook endpoint metadata',
    );
  }
  return {
    snapshot: {
      remote_endpoint_id: remoteEndpointId,
      environment,
      endpoint_url: endpointUrl,
      event_types: (value.enabled_events as string[]).slice(),
      enabled: value.status === 'enabled',
      correlation_valid:
        metadata.recued_ingress_id === expectedIngressId
        && metadata.recued_profile_id === 'stripe.event.v1'
        && metadata.recued_environment === expectedEnvironment,
    },
    metadata,
  };
};

const desiredForm = (
  context: ManagedWebhookRegistrationContext,
): URLSearchParams => {
  const form = new URLSearchParams();
  form.set('url', context.desired.endpoint_url);
  for (const eventType of context.desired.event_types) {
    form.append('enabled_events[]', eventType);
  }
  form.set('description', 'Recued managed webhook ingress');
  form.set('metadata[recued_ingress_id]', context.desired.ingress_id);
  form.set('metadata[recued_profile_id]', 'stripe.event.v1');
  form.set('metadata[recued_environment]', context.desired.environment);
  return form;
};

export const createStripeWebhookRegistrationAdapter = (
  deps: StripeWebhookRegistrationDeps,
): WebhookManagedEndpointRegistrationAdapter => {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_STRIPE_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) {
    throw new Error('Stripe webhook registration timeout must be in 100..60000ms');
  }
  const readBoundedText = (
    pending: WebhookRegistrationPendingResponse,
  ): Promise<string> => deps.responseReader.readText(pending);
  const parseJson = (
    pending: WebhookRegistrationPendingResponse,
  ): Promise<unknown> => deps.responseReader.readJson(pending);

  const committedRemoteId = (value: unknown): string => {
    const parsed = deps.remoteIdParser.parse(value);
    if (parsed === null) {
      throw new WebhookRegistrationAdapterError(
        'upstream_response_invalid',
        'Stripe remote endpoint id is invalid',
      );
    }
    return parsed;
  };

  // One reconciliation context pins one decrypted connection credential across
  // list/create/read-back (or read/update/read-back). A concurrent connection
  // edit therefore cannot split one remote transaction sequence across two
  // Stripe accounts. Contexts are per-reconcile and weakly held.
  const connectionByContext = new WeakMap<
    ManagedWebhookRegistrationContext,
    Promise<StripeWebhookRegistrationConnection>
  >();

  const connectionFor = async (
    context: ManagedWebhookRegistrationContext,
  ): Promise<StripeWebhookRegistrationConnection> => {
    validateContext(context, deps.eventTypeParser, deps.remoteUrlParser);
    const cached = connectionByContext.get(context);
    if (cached) return cached;
    const resolved = (async (): Promise<StripeWebhookRegistrationConnection> => {
      let connection: StripeWebhookRegistrationConnection | null;
      try {
        connection = await deps.resolveConnection(context.paired_connection_id);
      } catch (error) {
        if (error instanceof WebhookRegistrationAdapterError) throw error;
        throw new WebhookRegistrationAdapterError(
          'connection_unavailable',
          'Stripe connection could not be resolved',
        );
      }
      if (connection === null) {
        throw new WebhookRegistrationAdapterError(
          'connection_unavailable',
          'Stripe connection is not available',
        );
      }
      const classified = deps.apiKeyClassifier.classify(connection.api_key);
      if (classified === null) {
        throw new WebhookRegistrationAdapterError(
          'connection_auth_invalid',
          'Stripe connection does not contain a test or live secret/restricted key',
        );
      }
      if (context.desired.environment !== classified.environment) {
        throw new WebhookRegistrationAdapterError(
          'environment_mismatch',
          'Stripe API key mode does not match the ingress environment',
        );
      }
      return { api_key: classified.value };
    })();
    connectionByContext.set(context, resolved);
    return resolved;
  };

  const request = async (
    context: ManagedWebhookRegistrationContext,
    pathAndQuery: string,
    init: {
      method: 'GET' | 'POST' | 'DELETE';
      form?: URLSearchParams;
      idempotencyKey?: string;
    },
  ): Promise<WebhookRegistrationPendingResponse> => {
    const connection = await connectionFor(context);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const headers = new Headers({
        Accept: 'application/json',
        Authorization: `Basic ${Buffer.from(`${connection.api_key}:`, 'utf8').toString('base64')}`,
      });
      if (init.form) {
        headers.set('Content-Type', 'application/x-www-form-urlencoded');
      }
      if (init.idempotencyKey) {
        headers.set('Idempotency-Key', init.idempotencyKey);
      }
      const response = await fetchImpl(`${STRIPE_API_ORIGIN}${pathAndQuery}`, {
        method: init.method,
        headers,
        ...(init.form ? { body: init.form.toString() } : {}),
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
        'Stripe webhook registration request did not complete',
      );
    }
  };

  const requireSuccess = async (
    pending: WebhookRegistrationPendingResponse,
  ): Promise<unknown> => {
    if (!pending.response.ok) {
      // Drain only a bounded amount so a pooled connection can be reused; the
      // body is deliberately excluded from errors because it is not a trusted
      // or secret-safe owner projection.
      await readBoundedText(pending);
      throw new WebhookRegistrationAdapterError(
        pending.response.status === 429 || pending.response.status >= 500
          ? 'upstream_unavailable'
          : 'upstream_rejected',
        `Stripe webhook registration returned HTTP ${pending.response.status}`,
      );
    }
    return parseJson(pending);
  };

  const read = async (
    context: ManagedWebhookRegistrationContext,
    remoteEndpointId: string,
  ): Promise<ManagedWebhookEndpointSnapshot | null> => {
    const parsedRemoteEndpointId = committedRemoteId(remoteEndpointId);
    const response = await request(
      context,
      `/v1/webhook_endpoints/${encodeURIComponent(parsedRemoteEndpointId)}`,
      { method: 'GET' },
    );
    if (response.response.status === 404) {
      await readBoundedText(response);
      return null;
    }
    const parsed = parseStripeEndpoint(
      await requireSuccess(response),
      context.desired.environment,
      context.desired.ingress_id,
      deps.remoteIdParser,
      deps.remoteUrlParser,
    ).snapshot;
    if (parsed.remote_endpoint_id !== parsedRemoteEndpointId) {
      throw new WebhookRegistrationAdapterError(
        'upstream_response_invalid',
        'Stripe retrieve response endpoint id did not match the request',
      );
    }
    return parsed;
  };

  return createWebhookAddressableCollectionRegistrationDriver<null>(
    STRIPE_REGISTRATION_DRIVER_PRESET,
    {
      prepareSearch: () => null,
      async readSearchPage(context, _session, page) {
        const matches: ManagedWebhookEndpointMatch[] = [];
        const query = new URLSearchParams({ limit: String(page.page_size) });
        if (page.after !== null) query.set('starting_after', page.after);
        const response = await request(
          context,
          `/v1/webhook_endpoints?${query.toString()}`,
          { method: 'GET' },
        );
        const body = await requireSuccess(response);
        if (
          !isRecord(body) ||
          body.object !== 'list' ||
          !Array.isArray(body.data) ||
          body.data.length > page.page_size ||
          typeof body.has_more !== 'boolean'
        ) {
          throw new WebhookRegistrationAdapterError(
            'upstream_response_invalid',
            'Stripe returned an invalid webhook endpoint list',
          );
        }
        const parsed = body.data.map((entry) =>
          parseStripeEndpoint(
            entry,
            context.desired.environment,
            context.desired.ingress_id,
            deps.remoteIdParser,
            deps.remoteUrlParser,
          ),
        );
        for (const endpoint of parsed) {
          const ingressMetadataMatch =
            endpoint.metadata.recued_ingress_id === context.desired.ingress_id;
          const owned =
            ingressMetadataMatch && endpoint.snapshot.correlation_valid;
          const sameUrl =
            endpoint.snapshot.endpoint_url === context.desired.endpoint_url;
          if (owned || ingressMetadataMatch || sameUrl) {
            matches.push({
              endpoint: endpoint.snapshot,
              correlation: owned
                ? 'owned'
                : ingressMetadataMatch
                  ? 'metadata_conflict'
                  : 'url_only',
            });
          }
        }
        let nextAfter: string | null = null;
        if (body.has_more) {
          nextAfter = parsed.at(-1)?.snapshot.remote_endpoint_id ?? null;
          if (nextAfter === null) {
            throw new WebhookRegistrationAdapterError(
              'upstream_response_invalid',
              'Stripe returned an empty paginated webhook endpoint list',
            );
          }
        }
        return { matches, next_after: nextAfter };
      },
      async create(
        context,
        idempotencyKey,
      ): Promise<ManagedWebhookEndpointCreateResult> {
        if (deps.idempotencyKeyParser.parse(idempotencyKey) === null) {
          throw new WebhookRegistrationAdapterError(
            'registration_input_invalid',
            'Stripe create idempotency key is invalid',
          );
        }
        const response = await request(context, '/v1/webhook_endpoints', {
          method: 'POST',
          form: desiredForm(context),
          idempotencyKey,
        });
        const body = await requireSuccess(response);
        const parsed = parseStripeEndpoint(
          body,
          context.desired.environment,
          context.desired.ingress_id,
          deps.remoteIdParser,
          deps.remoteUrlParser,
        );
        const secret = deps.endpointSecretParser.parse(
          isRecord(body) ? body.secret : undefined,
        );
        if (secret === null) {
          throw new WebhookRegistrationAdapterError(
            'upstream_response_invalid',
            'Stripe create response omitted the one-time endpoint secret',
          );
        }
        return {
          endpoint: parsed.snapshot,
          credential_result: { endpoint_secret: secret },
        };
      },
      read,
      async update(context, remoteEndpointId, idempotencyKey) {
        if (deps.idempotencyKeyParser.parse(idempotencyKey) === null) {
          throw new WebhookRegistrationAdapterError(
            'registration_input_invalid',
            'Stripe update idempotency key is invalid',
          );
        }
        const parsedRemoteEndpointId = committedRemoteId(remoteEndpointId);
        const form = desiredForm(context);
        form.set('disabled', 'false');
        const response = await request(
          context,
          `/v1/webhook_endpoints/${encodeURIComponent(parsedRemoteEndpointId)}`,
          { method: 'POST', form, idempotencyKey },
        );
        const parsed = parseStripeEndpoint(
          await requireSuccess(response),
          context.desired.environment,
          context.desired.ingress_id,
          deps.remoteIdParser,
          deps.remoteUrlParser,
        ).snapshot;
        if (parsed.remote_endpoint_id !== parsedRemoteEndpointId) {
          throw new WebhookRegistrationAdapterError(
            'upstream_response_invalid',
            'Stripe update response endpoint id did not match the request',
          );
        }
        return parsed;
      },
      async delete(context, remoteEndpointId): Promise<void> {
        const parsedRemoteEndpointId = committedRemoteId(remoteEndpointId);
        const response = await request(
          context,
          `/v1/webhook_endpoints/${encodeURIComponent(parsedRemoteEndpointId)}`,
          { method: 'DELETE' },
        );
        if (response.response.status === 404) {
          await readBoundedText(response);
          return;
        }
        const body = await requireSuccess(response);
        if (
          !isRecord(body) ||
          body.object !== 'webhook_endpoint' ||
          body.deleted !== true ||
          deps.remoteIdParser.parse(body.id) !== parsedRemoteEndpointId
        ) {
          throw new WebhookRegistrationAdapterError(
            'upstream_response_invalid',
            'Stripe returned an invalid webhook endpoint deletion result',
          );
        }
      },
    },
  );
};
