/** D-201 Slices 8E + 8F + 9Q + 9AE-9AF + 9AL + 9AN + 9AV + 9AY + 9BC + 9BE + 9BJ — bounded GitHub repository/organization webhook registration.
 *
 * GitHub exposes addressable hooks beneath a repository or organization target.
 * The target, API origin, paths, headers, and JSON bodies are closed trusted
 * code. An exact opaque Recued callback URL inside that pinned target is orphan
 * ownership evidence because GitHub hook objects have no custom correlation
 * metadata. The signing secret is generated locally, sent to GitHub, and
 * returned once to the reconciler for atomic encrypted persistence.
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
  createWebhookTargetScopedCollectionRegistrationDriver,
  type WebhookTargetScopedCollectionLifecycle,
  type WebhookTargetScopedCollectionSearchPageInput,
} from '../../webhook-target-scoped-collection-registration-driver.js';
import {
  webhookTargetScopedCollectionRegistrationDriverPreset,
} from '../../webhook-registration-driver-profile-presets.js';
import type {
  WebhookFixedLengthAsciiTokenParser,
} from '../../webhook-fixed-length-ascii-token-parser.js';
import type {
  WebhookLowercaseIdentifierEventTypeParser,
} from '../../webhook-lowercase-identifier-event-type-parser.js';
import type {
  WebhookAccountResourceRegistrationTargetNormalizer,
} from '../../webhook-account-resource-registration-target-normalizer.js';
import type {
  WebhookRegistrationJsonResponseReader,
  WebhookRegistrationPendingResponse,
} from '../../webhook-registration-json-response-reader.js';
import type {
  WebhookRegistrationIdempotencyKeyParser,
} from '../../webhook-registration-idempotency-key-parser.js';
import type {
  WebhookPositiveDecimalIdentifierParser,
} from '../../webhook-positive-decimal-identifier-parser.js';
import type {
  WebhookBoundedHttpUrlParser,
} from '../../webhook-bounded-http-url-parser.js';
import type {
  WebhookPrefixSetPrintableAsciiTokenParser,
} from '../../webhook-prefix-set-printable-ascii-token-parser.js';
import {
  WEBHOOK_INGRESS_ID_PARSER,
} from '../../webhook-core-identity-parsers.js';

const GITHUB_API_ORIGIN = 'https://api.github.com';
const GITHUB_API_VERSION = '2022-11-28';
const MAX_GITHUB_REMOTE_EVENT_TYPES = 128;
const DEFAULT_GITHUB_REGISTRATION_TIMEOUT_MS = 10_000;
const GITHUB_REGISTRATION_DRIVER_PRESET =
  webhookTargetScopedCollectionRegistrationDriverPreset('github.webhook.v1');
if (GITHUB_REGISTRATION_DRIVER_PRESET === null) {
  throw new Error('GitHub webhook registration driver preset is missing');
}

export interface GitHubWebhookRegistrationConnection {
  access_token: string;
  /** Organization-hook visibility differs between OAuth/app-created hooks and
   * user-created hooks. Restrict managed lifecycle to the user/PAT visibility
   * class so list/read absence remains meaningful across credential rotation. */
  credential_kind: 'personal_access_token';
}

export interface GitHubWebhookRegistrationDeps {
  accessTokenParser: WebhookPrefixSetPrintableAsciiTokenParser;
  eventTypeParser: WebhookLowercaseIdentifierEventTypeParser;
  idempotencyKeyParser: WebhookRegistrationIdempotencyKeyParser;
  remoteIdParser: WebhookPositiveDecimalIdentifierParser;
  remoteUrlParser: WebhookBoundedHttpUrlParser;
  registrationTargetNormalizer: WebhookAccountResourceRegistrationTargetNormalizer;
  responseReader: WebhookRegistrationJsonResponseReader;
  secretParser: WebhookFixedLengthAsciiTokenParser;
  resolveConnection: (
    pairedConnectionId: string,
  ) => Promise<GitHubWebhookRegistrationConnection | null>;
  /** Updates must resend the same secret: GitHub removes an existing secret
   * when a full hook update omits it. */
  resolveActiveSecret: (ingressId: string) => Promise<string | null>;
  /** Authorizes moving a committed hook from the last canonical callback URL
   * to a newly-derived one without overwriting a foreign hook id. */
  resolveConfirmedEndpoint: (ingressId: string) => string | null | Promise<string | null>;
  generateSecret?: () => string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

interface GitHubTargetScope {
  base_path: string;
  expected_type: 'Repository' | 'Organization';
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const canonicalDesiredEndpoint = (
  value: unknown,
  remoteUrlParser: WebhookBoundedHttpUrlParser,
): string | null => {
  const endpoint = remoteUrlParser.parse(value);
  if (endpoint === null) return null;
  const parsed = new URL(endpoint);
  return parsed.protocol === 'https:'
    && parsed.search.length === 0
    && parsed.hash.length === 0
    && parsed.href === endpoint
    ? endpoint
    : null;
};

const targetScope = (
  context: ManagedWebhookRegistrationContext,
  registrationTargetNormalizer: WebhookAccountResourceRegistrationTargetNormalizer,
): GitHubTargetScope => {
  const target = registrationTargetNormalizer.normalize(
    context.desired.registration_target,
  );
  if (target === null
    || target.kind !== context.desired.registration_target?.kind
    || target.key !== context.desired.registration_target.key) {
    throw new WebhookRegistrationAdapterError(
      'registration_input_invalid',
      'GitHub managed registration target is invalid or noncanonical',
    );
  }
  if (target.kind === registrationTargetNormalizer.preset.account_kind) {
    return {
      base_path: `/orgs/${encodeURIComponent(target.key)}/hooks`,
      expected_type: 'Organization',
    };
  }
  if (target.kind !== registrationTargetNormalizer.preset.resource_kind) {
    throw new WebhookRegistrationAdapterError(
      'registration_input_invalid',
      'GitHub managed registration target kind is invalid',
    );
  }
  const separator = target.key.indexOf('/');
  const owner = target.key.slice(0, separator);
  const repository = target.key.slice(separator + 1);
  return {
    base_path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/hooks`,
    expected_type: 'Repository',
  };
};

const validateContext = (
  context: ManagedWebhookRegistrationContext,
  eventTypeParser: WebhookLowercaseIdentifierEventTypeParser,
  remoteUrlParser: WebhookBoundedHttpUrlParser,
  registrationTargetNormalizer: WebhookAccountResourceRegistrationTargetNormalizer,
): GitHubTargetScope => {
  const scope = targetScope(context, registrationTargetNormalizer);
  const desired = context.desired;
  if (context.paired_connection_id.trim().length === 0
    || context.paired_connection_id.length > 256
    || WEBHOOK_INGRESS_ID_PARSER.parse(desired.ingress_id) === null
    || (desired.environment !== 'test'
      && desired.environment !== 'live'
      && desired.environment !== 'custom')
    || canonicalDesiredEndpoint(desired.endpoint_url, remoteUrlParser) === null
    || desired.event_types.length < 1
    || desired.event_types.length > 64
    || new Set(desired.event_types).size !== desired.event_types.length
    || desired.event_types.some((eventType) =>
      eventTypeParser.parse(eventType) === null)) {
    throw new WebhookRegistrationAdapterError(
      'registration_input_invalid',
      'GitHub managed registration input is invalid',
    );
  }
  return scope;
};

const validateRemoteId = (
  remoteEndpointId: string,
  parser: WebhookPositiveDecimalIdentifierParser,
): void => {
  if (parser.parse(remoteEndpointId) === null) {
    throw new WebhookRegistrationAdapterError(
      'upstream_response_invalid',
      'GitHub remote webhook id is invalid',
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
      'GitHub registration idempotency key is invalid',
    );
  }
};

const responseErrorCode = (
  response: Response,
): 'connection_auth_invalid' | 'upstream_unavailable' | 'upstream_rejected' => {
  if (response.status === 401) return 'connection_auth_invalid';
  if (response.status === 429
    || response.status >= 500
    || (response.status === 403
      && (response.headers.has('retry-after')
        || response.headers.get('x-ratelimit-remaining') === '0'))) {
    return 'upstream_unavailable';
  }
  return 'upstream_rejected';
};

const parseGitHubHook = (
  value: unknown,
  context: ManagedWebhookRegistrationContext,
  scope: GitHubTargetScope,
  eventTypeParser: WebhookLowercaseIdentifierEventTypeParser,
  remoteIdParser: WebhookPositiveDecimalIdentifierParser,
  remoteUrlParser: WebhookBoundedHttpUrlParser,
): ManagedWebhookEndpointSnapshot | null => {
  if (!isRecord(value)) {
    throw new WebhookRegistrationAdapterError(
      'upstream_response_invalid',
      'GitHub returned an invalid webhook object',
    );
  }
  const remoteEndpointId = typeof value.id === 'number'
    && Number.isSafeInteger(value.id)
    && value.id > 0
    ? remoteIdParser.parse(String(value.id))
    : null;
  if (remoteEndpointId === null
    || typeof value.name !== 'string'
    || value.name.length === 0
    || value.name.length > 64) {
    throw new WebhookRegistrationAdapterError(
      'upstream_response_invalid',
      'GitHub returned an invalid webhook object',
    );
  }
  // Legacy service hooks can appear in an exhaustive target list. They do not
  // have the `web` config shape and can never correlate to a Recued endpoint.
  if (value.name !== 'web') return null;
  if (value.type !== scope.expected_type
    || typeof value.active !== 'boolean'
    || !Array.isArray(value.events)
    || value.events.length === 0
    || value.events.length > MAX_GITHUB_REMOTE_EVENT_TYPES
    || value.events.some((eventType) =>
      eventType !== '*' && eventTypeParser.parse(eventType) === null)
    || new Set(value.events).size !== value.events.length
    || !isRecord(value.config)) {
    throw new WebhookRegistrationAdapterError(
      'upstream_response_invalid',
      'GitHub returned invalid webhook configuration',
    );
  }
  const endpointUrl = remoteUrlParser.parse(value.config.url);
  const contentType = value.config.content_type;
  const insecureSsl = value.config.insecure_ssl;
  if (endpointUrl === null
    || typeof contentType !== 'string'
    || contentType.length === 0
    || contentType.length > 32
    || (insecureSsl !== undefined
      && insecureSsl !== 0
      && insecureSsl !== 1
      && insecureSsl !== '0'
      && insecureSsl !== '1')) {
    throw new WebhookRegistrationAdapterError(
      'upstream_response_invalid',
      'GitHub returned invalid webhook delivery configuration',
    );
  }
  return {
    remote_endpoint_id: remoteEndpointId,
    environment: context.desired.environment,
    endpoint_url: endpointUrl,
    event_types: (value.events as string[]).slice(),
    enabled: value.active,
    correlation_valid: contentType === 'json'
      && (insecureSsl === undefined || insecureSsl === 0 || insecureSsl === '0'),
  };
};

const legacyServiceCollision = (
  value: unknown,
  context: ManagedWebhookRegistrationContext,
  remoteIdParser: WebhookPositiveDecimalIdentifierParser,
  remoteUrlParser: WebhookBoundedHttpUrlParser,
): ManagedWebhookEndpointSnapshot | null => {
  if (!isRecord(value)) return null;
  const remoteEndpointId = typeof value.id === 'number'
    && Number.isSafeInteger(value.id)
    && value.id > 0
    ? remoteIdParser.parse(String(value.id))
    : null;
  if (value.name === 'web'
    || remoteEndpointId === null
    || !isRecord(value.config)) {
    return null;
  }
  const endpointUrl = remoteUrlParser.parse(value.config.url);
  if (endpointUrl !== context.desired.endpoint_url) return null;
  return {
    remote_endpoint_id: remoteEndpointId,
    environment: context.desired.environment,
    endpoint_url: endpointUrl,
    event_types: [],
    enabled: false,
    correlation_valid: false,
  };
};

const mutableHookBody = (
  context: ManagedWebhookRegistrationContext,
  secret: string,
): Readonly<Record<string, unknown>> => ({
  active: true,
  events: context.desired.event_types.slice(),
  config: {
    url: context.desired.endpoint_url,
    content_type: 'json',
    secret,
    insecure_ssl: '0',
  },
});

const createHookBody = (
  context: ManagedWebhookRegistrationContext,
  secret: string,
): Readonly<Record<string, unknown>> => ({
  name: 'web',
  ...mutableHookBody(context, secret),
});

export const createGitHubWebhookRegistrationAdapter = (
  deps: GitHubWebhookRegistrationDeps,
): WebhookManagedEndpointRegistrationAdapter => {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_GITHUB_REGISTRATION_TIMEOUT_MS;
  const generateSecret = deps.generateSecret
    ?? (() => randomBytes(32).toString('base64url'));
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) {
    throw new Error('GitHub webhook registration timeout must be in 100..60000ms');
  }
  const readBoundedText = (
    pending: WebhookRegistrationPendingResponse,
  ): Promise<string> => deps.responseReader.readText(pending);
  const parseJson = (
    pending: WebhookRegistrationPendingResponse,
  ): Promise<unknown> => deps.responseReader.readJson(pending);

  const connectionByContext = new WeakMap<
    ManagedWebhookRegistrationContext,
    Promise<GitHubWebhookRegistrationConnection>
  >();

  const connectionFor = async (
    context: ManagedWebhookRegistrationContext,
  ): Promise<GitHubWebhookRegistrationConnection> => {
    validateContext(
      context,
      deps.eventTypeParser,
      deps.remoteUrlParser,
      deps.registrationTargetNormalizer,
    );
    const cached = connectionByContext.get(context);
    if (cached) return cached;
    const resolved = (async (): Promise<GitHubWebhookRegistrationConnection> => {
      let connection: GitHubWebhookRegistrationConnection | null;
      try {
        connection = await deps.resolveConnection(context.paired_connection_id);
      } catch (error) {
        if (error instanceof WebhookRegistrationAdapterError) throw error;
        throw new WebhookRegistrationAdapterError(
          'connection_unavailable',
          'GitHub connection could not be resolved',
        );
      }
      if (connection === null) {
        throw new WebhookRegistrationAdapterError(
          'connection_unavailable',
          'GitHub connection is not available',
        );
      }
      const accessToken = deps.accessTokenParser.parse(connection.access_token);
      if (accessToken === null) {
        throw new WebhookRegistrationAdapterError(
          'connection_auth_invalid',
          'GitHub managed registration requires a personal access token',
        );
      }
      const credentialKind = connection.credential_kind;
      if (credentialKind !== 'personal_access_token') {
        throw new WebhookRegistrationAdapterError(
          'connection_auth_invalid',
          'GitHub managed registration requires a personal access token',
        );
      }
      return {
        access_token: accessToken,
        credential_kind: credentialKind,
      };
    })();
    connectionByContext.set(context, resolved);
    return resolved;
  };

  const request = async (
    context: ManagedWebhookRegistrationContext,
    pathAndQuery: string,
    init: {
      method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
      body?: Readonly<Record<string, unknown>>;
    },
  ): Promise<WebhookRegistrationPendingResponse> => {
    const connection = await connectionFor(context);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const headers = new Headers({
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${connection.access_token}`,
        'User-Agent': 'recued-webhook-registration',
        'X-GitHub-Api-Version': GITHUB_API_VERSION,
      });
      if (init.body !== undefined) {
        headers.set('Content-Type', 'application/json; charset=utf-8');
      }
      const response = await fetchImpl(`${GITHUB_API_ORIGIN}${pathAndQuery}`, {
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
        'GitHub webhook registration request did not complete',
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
          `GitHub webhook registration returned unexpected HTTP ${pending.response.status}`,
        );
      }
      throw new WebhookRegistrationAdapterError(
        responseErrorCode(pending.response),
        `GitHub webhook registration returned HTTP ${pending.response.status}`,
      );
    }
    return parseJson(pending);
  };

  /** GitHub deliberately uses 404 for both absence and inaccessible private
   * resources. A successful target-level list proves the paired token can see
   * the target before a hook-level 404 is accepted as endpoint absence. */
  const confirmTargetReadable = async (
    context: ManagedWebhookRegistrationContext,
    scope: GitHubTargetScope,
  ): Promise<void> => {
    const query = new URLSearchParams({ per_page: '1', page: '1' });
    const response = await request(
      context,
      `${scope.base_path}?${query.toString()}`,
      { method: 'GET' },
    );
    const body = await requireJsonStatus(response, 200);
    if (!Array.isArray(body) || body.length > 1) {
      throw new WebhookRegistrationAdapterError(
        'upstream_response_invalid',
        'GitHub returned an invalid webhook visibility probe',
      );
    }
  };

  const read = async (
    context: ManagedWebhookRegistrationContext,
    remoteEndpointId: string,
  ): Promise<ManagedWebhookEndpointSnapshot | null> => {
    validateRemoteId(remoteEndpointId, deps.remoteIdParser);
    const scope = validateContext(
      context,
      deps.eventTypeParser,
      deps.remoteUrlParser,
      deps.registrationTargetNormalizer,
    );
    const response = await request(
      context,
      `${scope.base_path}/${encodeURIComponent(remoteEndpointId)}`,
      { method: 'GET' },
    );
    if (response.response.status === 404) {
      await readBoundedText(response);
      await confirmTargetReadable(context, scope);
      return null;
    }
    const parsed = parseGitHubHook(
      await requireJsonStatus(response, 200),
      context,
      scope,
      deps.eventTypeParser,
      deps.remoteIdParser,
      deps.remoteUrlParser,
    );
    if (parsed === null || parsed.remote_endpoint_id !== remoteEndpointId) {
      throw new WebhookRegistrationAdapterError(
        'upstream_response_invalid',
        'GitHub retrieve response webhook id did not match the request',
      );
    }
    return parsed;
  };

  const prepareSearch = (
    context: ManagedWebhookRegistrationContext,
  ): GitHubTargetScope => validateContext(
    context,
    deps.eventTypeParser,
    deps.remoteUrlParser,
    deps.registrationTargetNormalizer,
  );

  const readSearchPage = async (
    context: ManagedWebhookRegistrationContext,
    scope: GitHubTargetScope,
    page: WebhookTargetScopedCollectionSearchPageInput,
  ): Promise<{
    matches: readonly ManagedWebhookEndpointMatch[];
    has_more: boolean;
  }> => {
    const query = new URLSearchParams({
      per_page: String(page.page_size),
      page: String(page.page_number),
    });
    const response = await request(
      context,
      `${scope.base_path}?${query.toString()}`,
      { method: 'GET' },
    );
    const body = await requireJsonStatus(response, 200);
    if (!Array.isArray(body) || body.length > page.page_size) {
      throw new WebhookRegistrationAdapterError(
        'upstream_response_invalid',
        'GitHub returned an invalid webhook list',
      );
    }
    const matches: ManagedWebhookEndpointMatch[] = [];
    for (const value of body) {
      const endpoint = parseGitHubHook(
        value,
        context,
        scope,
        deps.eventTypeParser,
        deps.remoteIdParser,
        deps.remoteUrlParser,
      );
      if (endpoint?.endpoint_url === context.desired.endpoint_url) {
        matches.push({ endpoint, correlation: 'owned' });
        continue;
      }
      const collision = legacyServiceCollision(
        value,
        context,
        deps.remoteIdParser,
        deps.remoteUrlParser,
      );
      if (collision !== null) {
        matches.push({ endpoint: collision, correlation: 'metadata_conflict' });
      }
    }
    return {
      matches,
      has_more: body.length === page.page_size,
    };
  };

  const activeSecretByContext = new WeakMap<
    ManagedWebhookRegistrationContext,
    Promise<string>
  >();
  const activeSecretFor = async (
    context: ManagedWebhookRegistrationContext,
  ): Promise<string> => {
    const cached = activeSecretByContext.get(context);
    if (cached) return cached;
    const resolved = (async (): Promise<string> => {
      let secret: string | null;
      try {
        secret = await deps.resolveActiveSecret(context.desired.ingress_id);
      } catch (error) {
        if (error instanceof WebhookRegistrationAdapterError) throw error;
        throw new WebhookRegistrationAdapterError(
          'connection_unavailable',
          'GitHub managed webhook credential could not be resolved',
        );
      }
      const parsedSecret = deps.secretParser.parse(secret);
      if (parsedSecret === null) {
        throw new WebhookRegistrationAdapterError(
          'registration_input_invalid',
          'GitHub managed webhook has no valid active secret',
        );
      }
      return parsedSecret;
    })();
    activeSecretByContext.set(context, resolved);
    return resolved;
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
        'GitHub managed webhook state could not be resolved',
      );
    }
    return endpoint === null
      ? null
      : canonicalDesiredEndpoint(endpoint, deps.remoteUrlParser);
  };

  return createWebhookTargetScopedCollectionRegistrationDriver<GitHubTargetScope>(
    GITHUB_REGISTRATION_DRIVER_PRESET,
    {
      prepareSearch,
      readSearchPage,
      async create(
        context,
        idempotencyKey,
        lifecycle: WebhookTargetScopedCollectionLifecycle,
      ): Promise<ManagedWebhookEndpointCreateResult> {
        validateIdempotencyKey(idempotencyKey, deps.idempotencyKeyParser);
        const scope = validateContext(
          context,
          deps.eventTypeParser,
          deps.remoteUrlParser,
          deps.registrationTargetNormalizer,
        );
        // GitHub does not expose an idempotency header or custom hook metadata.
        // Re-run the exhaustive exact-URL search immediately before mutation;
        // crash recovery finds and removes an uncommitted exact-target orphan.
        if ((await lifecycle.find()).length > 0) {
          throw new WebhookRegistrationAdapterError(
            'upstream_rejected',
            'GitHub target already has a webhook for this ingress; no endpoint was changed',
          );
        }
        const secret = deps.secretParser.parse(generateSecret());
        if (secret === null) {
          throw new WebhookRegistrationAdapterError(
            'registration_input_invalid',
            'GitHub managed webhook secret generation failed',
          );
        }
        const response = await request(context, scope.base_path, {
          method: 'POST',
          body: createHookBody(context, secret),
        });
        const endpoint = parseGitHubHook(
          await requireJsonStatus(response, 201),
          context,
          scope,
          deps.eventTypeParser,
          deps.remoteIdParser,
          deps.remoteUrlParser,
        );
        if (endpoint === null) {
          throw new WebhookRegistrationAdapterError(
            'upstream_response_invalid',
            'GitHub create response did not contain a web hook',
          );
        }
        return {
          endpoint,
          credential_result: { webhook_secret: secret },
        };
      },
      read,
      async update(context, remoteEndpointId, idempotencyKey) {
        validateRemoteId(remoteEndpointId, deps.remoteIdParser);
        validateIdempotencyKey(idempotencyKey, deps.idempotencyKeyParser);
        const scope = validateContext(
          context,
          deps.eventTypeParser,
          deps.remoteUrlParser,
          deps.registrationTargetNormalizer,
        );
        const current = await read(context, remoteEndpointId);
        const confirmedEndpoint = await confirmedEndpointFor(context);
        if (current === null
          || (current.endpoint_url !== context.desired.endpoint_url
            && current.endpoint_url !== confirmedEndpoint)) {
          throw new WebhookRegistrationAdapterError(
            'upstream_rejected',
            'GitHub webhook ownership could not be confirmed; no endpoint was changed',
          );
        }
        const response = await request(
          context,
          `${scope.base_path}/${encodeURIComponent(remoteEndpointId)}`,
          {
            method: 'PATCH',
            body: mutableHookBody(context, await activeSecretFor(context)),
          },
        );
        const endpoint = parseGitHubHook(
          await requireJsonStatus(response, 200),
          context,
          scope,
          deps.eventTypeParser,
          deps.remoteIdParser,
          deps.remoteUrlParser,
        );
        if (endpoint === null
          || endpoint.remote_endpoint_id !== remoteEndpointId) {
          throw new WebhookRegistrationAdapterError(
            'upstream_response_invalid',
            'GitHub update response webhook id did not match the request',
          );
        }
        return endpoint;
      },
      async delete(context, remoteEndpointId): Promise<void> {
        validateRemoteId(remoteEndpointId, deps.remoteIdParser);
        const scope = validateContext(
          context,
          deps.eventTypeParser,
          deps.remoteUrlParser,
          deps.registrationTargetNormalizer,
        );
        const current = await read(context, remoteEndpointId);
        if (current === null) return;
        if (current.endpoint_url !== context.desired.endpoint_url) {
          throw new WebhookRegistrationAdapterError(
            'upstream_rejected',
            'GitHub webhook ownership could not be confirmed; no endpoint was deleted',
          );
        }
        const response = await request(
          context,
          `${scope.base_path}/${encodeURIComponent(remoteEndpointId)}`,
          { method: 'DELETE' },
        );
        if (response.response.status === 404) {
          await readBoundedText(response);
          if (await read(context, remoteEndpointId) !== null) {
            throw new WebhookRegistrationAdapterError(
              'upstream_response_invalid',
              'GitHub webhook still existed after a not-found deletion response',
            );
          }
          return;
        }
        const text = await readBoundedText(response);
        if (!response.response.ok) {
          throw new WebhookRegistrationAdapterError(
            responseErrorCode(response.response),
            `GitHub webhook deletion returned HTTP ${response.response.status}`,
          );
        }
        if (response.response.status !== 204 || text.length !== 0) {
          throw new WebhookRegistrationAdapterError(
            'upstream_response_invalid',
            'GitHub webhook deletion returned an invalid response',
          );
        }
      },
    },
  );
};
