/** D-201 Slices 8J + 9AE-9BD — trusted built-in registration profile presets.
 *
 * Generic boot composition installs this one registry. Vendor connection
 * kinds, auth shapes, and existing behavioral adapters are isolated here as
 * trusted preset data while the addressable/scoped/singleton implementations
 * migrate onto reusable registration drivers. Packs, recipes, and owner input
 * cannot select a connection kind, vendor, auth projection, URL, or adapter.
 */

import type { ConnectionKind } from '@recued/contracts';
import { decodeAuthFromStorage } from './connection-handler.js';
import {
  createGitHubWebhookRegistrationAdapter,
} from './connections/providers/github-webhook-registration.js';
import {
  createPaddleWebhookRegistrationAdapter,
} from './connections/providers/paddle-webhook-registration.js';
import {
  createStripeWebhookRegistrationAdapter,
} from './connections/providers/stripe-webhook-registration.js';
import {
  createTelegramWebhookRegistrationAdapter,
} from './connections/providers/telegram-webhook-registration.js';
import type { ConnectionStoreSqlite } from './storage/connection-store.js';
import { resolveConnectionVendor } from './storage/connection-store.js';
import {
  WebhookIngressStoreError,
  type WebhookIngressStore,
} from './storage/webhook-ingress-store.js';
import {
  createWebhookRegistrationRuntimeRegistry,
  WebhookRegistrationAdapterError,
  type WebhookRegistrationRuntimeRegistry,
} from './webhook-registration-runtime.js';
import {
  webhookAsciiEventTypeProfilePreset,
  webhookAsciiIdentifierEventTypeProfilePreset,
  webhookBoundedAsciiCredentialProfilePreset,
  webhookBoundedPrefixRegistrationRemoteIdProfilePreset,
  webhookFixedPrefixRegistrationRemoteIdProfilePreset,
  webhookDotSegmentEventTypeProfilePreset,
  webhookFixedLengthAsciiCredentialProfilePreset,
  webhookLowercaseIdentifierEventTypeProfilePreset,
  webhookPositiveDecimalRegistrationRemoteIdProfilePreset,
  webhookPrefixedAsciiCredentialProfilePreset,
  webhookPrefixedPositiveDecimalRegistrationRemoteIdProfilePreset,
  webhookSegmentedAsciiCredentialProfilePreset,
} from './webhook-shared-profile-parser-presets.js';
import {
  createWebhookAsciiEventTypeParser,
} from './webhook-ascii-event-type-parser.js';
import {
  createWebhookBoundedPrefixProviderIdParser,
} from './webhook-bounded-prefix-provider-id-parser.js';
import {
  createWebhookBoundedAsciiTokenParser,
} from './webhook-bounded-ascii-token-parser.js';
import {
  createWebhookBoundedHttpsUrlParser,
} from './webhook-bounded-https-url-parser.js';
import {
  createWebhookBoundedHttpUrlParser,
} from './webhook-bounded-http-url-parser.js';
import {
  createWebhookHttpOrOpaqueDestinationParser,
} from './webhook-http-or-opaque-destination-parser.js';
import {
  createWebhookAsciiIdentifierParser,
} from './webhook-ascii-identifier-parser.js';
import {
  createWebhookDotSegmentEventTypeParser,
} from './webhook-dot-segment-event-type-parser.js';
import {
  createWebhookFixedPrefixProviderIdParser,
} from './webhook-fixed-prefix-provider-id-parser.js';
import {
  createWebhookFixedLengthAsciiTokenParser,
} from './webhook-fixed-length-ascii-token-parser.js';
import {
  createWebhookLowercaseIdentifierEventTypeParser,
} from './webhook-lowercase-identifier-event-type-parser.js';
import {
  createWebhookPositiveDecimalIdentifierParser,
} from './webhook-positive-decimal-identifier-parser.js';
import {
  createWebhookPrefixedPositiveDecimalIdCodec,
} from './webhook-prefixed-positive-decimal-id-codec.js';
import {
  createWebhookPrefixedAsciiTokenParser,
} from './webhook-prefixed-ascii-token-parser.js';
import {
  createWebhookSegmentedAsciiTokenParser,
} from './webhook-segmented-ascii-token-parser.js';
import {
  createWebhookAccountResourceRegistrationTargetNormalizer,
} from './webhook-account-resource-registration-target-normalizer.js';
import {
  webhookRegistrationTargetProfilePreset,
} from './webhook-registration-target-profile-presets.js';
import {
  createWebhookRegistrationJsonResponseReader,
} from './webhook-registration-json-response-reader.js';
import {
  webhookRegistrationResponseProfilePreset,
} from './webhook-registration-response-profile-presets.js';
import {
  createWebhookRegistrationIdempotencyKeyParser,
} from './webhook-registration-idempotency-key-parser.js';
import {
  webhookRegistrationIdempotencyKeyProfilePreset,
} from './webhook-registration-idempotency-key-profile-presets.js';
import {
  webhookEndpointProfilePreset,
} from './webhook-endpoint-profile-presets.js';
import {
  webhookRegistrationRemoteUrlProfilePreset,
} from './webhook-registration-remote-url-profile-presets.js';
import {
  webhookRegistrationDestinationProfilePreset,
} from './webhook-registration-destination-profile-presets.js';
import {
  createWebhookDecimalColonAsciiTokenParser,
} from './webhook-decimal-colon-ascii-token-parser.js';
import {
  webhookRegistrationConnectionTokenProfilePreset,
} from './webhook-registration-connection-token-profile-presets.js';
import {
  createWebhookEnvironmentMappedPrefixedAsciiTokenClassifier,
} from './webhook-environment-mapped-prefixed-ascii-token-classifier.js';
import {
  createWebhookEnvironmentMappedSegmentedAsciiTokenClassifier,
} from './webhook-environment-mapped-segmented-ascii-token-classifier.js';
import {
  webhookRegistrationEnvironmentTokenProfilePreset,
} from './webhook-registration-environment-token-profile-presets.js';
import {
  createWebhookPrefixSetPrintableAsciiTokenParser,
} from './webhook-prefix-set-printable-ascii-token-parser.js';
import {
  webhookRegistrationAccessTokenProfilePreset,
} from './webhook-registration-access-token-profile-presets.js';

const stripeEventTypePreset = webhookAsciiEventTypeProfilePreset(
  'stripe.event.v1',
);
if (stripeEventTypePreset === null) {
  throw new Error('Stripe registration event-type preset is unavailable');
}
const stripeRegistrationEventTypeParser = createWebhookAsciiEventTypeParser(
  stripeEventTypePreset.parser,
);

const stripeCredentialPreset = webhookPrefixedAsciiCredentialProfilePreset(
  'stripe.event.v1',
);
if (stripeCredentialPreset === null) {
  throw new Error('Stripe registration credential preset is unavailable');
}
const stripeRegistrationEndpointSecretParser =
  createWebhookPrefixedAsciiTokenParser(stripeCredentialPreset.parser);

const stripeRemoteIdPreset =
  webhookBoundedPrefixRegistrationRemoteIdProfilePreset('stripe.event.v1');
if (stripeRemoteIdPreset === null) {
  throw new Error('Stripe registration remote-id preset is unavailable');
}
const stripeRegistrationRemoteIdParser =
  createWebhookBoundedPrefixProviderIdParser(stripeRemoteIdPreset.parser);

const stripeIdempotencyKeyPreset =
  webhookRegistrationIdempotencyKeyProfilePreset('stripe.event.v1');
if (stripeIdempotencyKeyPreset === null) {
  throw new Error('Stripe registration idempotency-key preset is unavailable');
}
const stripeRegistrationIdempotencyKeyParser =
  createWebhookRegistrationIdempotencyKeyParser(
    stripeIdempotencyKeyPreset.parser,
  );

const stripeResponsePreset = webhookRegistrationResponseProfilePreset(
  'stripe.event.v1',
);
if (stripeResponsePreset === null) {
  throw new Error('Stripe registration-response preset is unavailable');
}
const stripeRegistrationResponseReader =
  createWebhookRegistrationJsonResponseReader(stripeResponsePreset.reader);

const stripeRemoteUrlPreset = webhookRegistrationRemoteUrlProfilePreset(
  'stripe.event.v1',
);
if (stripeRemoteUrlPreset === null) {
  throw new Error('Stripe registration remote-URL preset is unavailable');
}
const stripeRegistrationRemoteUrlParser = createWebhookBoundedHttpUrlParser(
  stripeRemoteUrlPreset.parser,
);

const stripeEnvironmentTokenPreset =
  webhookRegistrationEnvironmentTokenProfilePreset('stripe.event.v1');
if (stripeEnvironmentTokenPreset === null
  || stripeEnvironmentTokenPreset.classifier.kind
    !== 'environment_mapped_prefixed_ascii_token.v1') {
  throw new Error('Stripe registration environment-token preset is unavailable');
}
const stripeRegistrationApiKeyClassifier =
  createWebhookEnvironmentMappedPrefixedAsciiTokenClassifier(
    stripeEnvironmentTokenPreset.classifier,
  );

const githubEventTypePreset = webhookLowercaseIdentifierEventTypeProfilePreset(
  'github.webhook.v1',
);
if (githubEventTypePreset === null) {
  throw new Error('GitHub registration event-type preset is unavailable');
}
const githubRegistrationEventTypeParser =
  createWebhookLowercaseIdentifierEventTypeParser(githubEventTypePreset.parser);

const githubCredentialPreset = webhookFixedLengthAsciiCredentialProfilePreset(
  'github.webhook.v1',
);
if (githubCredentialPreset === null) {
  throw new Error('GitHub registration credential preset is unavailable');
}
const githubRegistrationSecretParser =
  createWebhookFixedLengthAsciiTokenParser(githubCredentialPreset.parser);

const githubRemoteIdPreset =
  webhookPositiveDecimalRegistrationRemoteIdProfilePreset(
    'github.webhook.v1',
  );
if (githubRemoteIdPreset === null) {
  throw new Error('GitHub registration remote-id preset is unavailable');
}
const githubRegistrationRemoteIdParser =
  createWebhookPositiveDecimalIdentifierParser(githubRemoteIdPreset.parser);

const githubIdempotencyKeyPreset =
  webhookRegistrationIdempotencyKeyProfilePreset('github.webhook.v1');
if (githubIdempotencyKeyPreset === null) {
  throw new Error('GitHub registration idempotency-key preset is unavailable');
}
const githubRegistrationIdempotencyKeyParser =
  createWebhookRegistrationIdempotencyKeyParser(
    githubIdempotencyKeyPreset.parser,
  );

const githubTargetPreset = webhookRegistrationTargetProfilePreset(
  'github.webhook.v1',
);
if (githubTargetPreset === null) {
  throw new Error('GitHub registration-target preset is unavailable');
}
const githubRegistrationTargetNormalizer =
  createWebhookAccountResourceRegistrationTargetNormalizer(
    githubTargetPreset.normalizer,
  );

const githubResponsePreset = webhookRegistrationResponseProfilePreset(
  'github.webhook.v1',
);
if (githubResponsePreset === null) {
  throw new Error('GitHub registration-response preset is unavailable');
}
const githubRegistrationResponseReader =
  createWebhookRegistrationJsonResponseReader(githubResponsePreset.reader);

const githubRemoteUrlPreset = webhookRegistrationRemoteUrlProfilePreset(
  'github.webhook.v1',
);
if (githubRemoteUrlPreset === null) {
  throw new Error('GitHub registration remote-URL preset is unavailable');
}
const githubRegistrationRemoteUrlParser = createWebhookBoundedHttpUrlParser(
  githubRemoteUrlPreset.parser,
);

const githubAccessTokenPreset = webhookRegistrationAccessTokenProfilePreset(
  'github.webhook.v1',
);
if (githubAccessTokenPreset === null) {
  throw new Error('GitHub registration access-token preset is unavailable');
}
const githubRegistrationAccessTokenParser =
  createWebhookPrefixSetPrintableAsciiTokenParser(
    githubAccessTokenPreset.parser,
  );

const paddleEventTypePreset = webhookDotSegmentEventTypeProfilePreset(
  'paddle.notification.v1',
);
if (paddleEventTypePreset === null) {
  throw new Error('Paddle registration event-type preset is unavailable');
}
const paddleRegistrationEventTypeParser =
  createWebhookDotSegmentEventTypeParser(paddleEventTypePreset.parser);

const paddleCredentialPreset = webhookSegmentedAsciiCredentialProfilePreset(
  'paddle.notification.v1',
);
if (paddleCredentialPreset === null) {
  throw new Error('Paddle registration credential preset is unavailable');
}
const paddleRegistrationEndpointSecretParser =
  createWebhookSegmentedAsciiTokenParser(paddleCredentialPreset.parser);

const paddleEnvironmentTokenPreset =
  webhookRegistrationEnvironmentTokenProfilePreset(
    'paddle.notification.v1',
  );
if (paddleEnvironmentTokenPreset === null
  || paddleEnvironmentTokenPreset.classifier.kind
    !== 'environment_mapped_segmented_ascii_token.v1') {
  throw new Error('Paddle registration environment-token preset is unavailable');
}
const paddleRegistrationApiKeyClassifier =
  createWebhookEnvironmentMappedSegmentedAsciiTokenClassifier(
    paddleEnvironmentTokenPreset.classifier,
  );

const paddleRemoteIdPreset =
  webhookFixedPrefixRegistrationRemoteIdProfilePreset(
    'paddle.notification.v1',
  );
if (paddleRemoteIdPreset === null) {
  throw new Error('Paddle registration remote-id preset is unavailable');
}
const paddleRegistrationRemoteIdParser =
  createWebhookFixedPrefixProviderIdParser(paddleRemoteIdPreset.parser);

const paddleIdempotencyKeyPreset =
  webhookRegistrationIdempotencyKeyProfilePreset('paddle.notification.v1');
if (paddleIdempotencyKeyPreset === null) {
  throw new Error('Paddle registration idempotency-key preset is unavailable');
}
const paddleRegistrationIdempotencyKeyParser =
  createWebhookRegistrationIdempotencyKeyParser(
    paddleIdempotencyKeyPreset.parser,
  );

const paddleResponsePreset = webhookRegistrationResponseProfilePreset(
  'paddle.notification.v1',
);
if (paddleResponsePreset === null) {
  throw new Error('Paddle registration-response preset is unavailable');
}
const paddleRegistrationResponseReader =
  createWebhookRegistrationJsonResponseReader(paddleResponsePreset.reader);

const paddleDestinationPreset = webhookRegistrationDestinationProfilePreset(
  'paddle.notification.v1',
);
if (paddleDestinationPreset === null) {
  throw new Error('Paddle registration destination preset is unavailable');
}
const paddleRegistrationDestinationParser =
  createWebhookHttpOrOpaqueDestinationParser(paddleDestinationPreset.parser);

const telegramEventTypePreset = webhookAsciiIdentifierEventTypeProfilePreset(
  'telegram.bot-webhook.v1',
);
if (telegramEventTypePreset === null) {
  throw new Error('Telegram registration event-type preset is unavailable');
}
const telegramRegistrationEventTypeParser =
  createWebhookAsciiIdentifierParser(telegramEventTypePreset.parser);

const telegramCredentialPreset = webhookBoundedAsciiCredentialProfilePreset(
  'telegram.bot-webhook.v1',
);
if (telegramCredentialPreset === null) {
  throw new Error('Telegram registration credential preset is unavailable');
}
const telegramRegistrationSecretParser =
  createWebhookBoundedAsciiTokenParser(telegramCredentialPreset.parser);

const telegramConnectionTokenPreset =
  webhookRegistrationConnectionTokenProfilePreset('telegram.bot-webhook.v1');
if (telegramConnectionTokenPreset === null) {
  throw new Error('Telegram registration connection-token preset is unavailable');
}
const telegramRegistrationConnectionTokenParser =
  createWebhookDecimalColonAsciiTokenParser(telegramConnectionTokenPreset.parser);

const telegramEndpointPreset = webhookEndpointProfilePreset(
  'telegram.bot-webhook.v1',
);
if (telegramEndpointPreset === null) {
  throw new Error('Telegram endpoint profile preset is unavailable');
}
const telegramRegistrationEndpointParser = createWebhookBoundedHttpsUrlParser(
  telegramEndpointPreset.parser,
);

const telegramRemoteIdPreset =
  webhookPrefixedPositiveDecimalRegistrationRemoteIdProfilePreset(
    'telegram.bot-webhook.v1',
  );
if (telegramRemoteIdPreset === null) {
  throw new Error('Telegram registration remote-id preset is unavailable');
}
const telegramRegistrationRemoteIdCodec =
  createWebhookPrefixedPositiveDecimalIdCodec(telegramRemoteIdPreset.codec);

const telegramIdempotencyKeyPreset =
  webhookRegistrationIdempotencyKeyProfilePreset('telegram.bot-webhook.v1');
if (telegramIdempotencyKeyPreset === null) {
  throw new Error('Telegram registration idempotency-key preset is unavailable');
}
const telegramRegistrationIdempotencyKeyParser =
  createWebhookRegistrationIdempotencyKeyParser(
    telegramIdempotencyKeyPreset.parser,
  );

const telegramResponsePreset = webhookRegistrationResponseProfilePreset(
  'telegram.bot-webhook.v1',
);
if (telegramResponsePreset === null) {
  throw new Error('Telegram registration-response preset is unavailable');
}
const telegramRegistrationResponseReader =
  createWebhookRegistrationJsonResponseReader(telegramResponsePreset.reader);

export interface BuiltinWebhookRegistrationProfilePresetDeps {
  connectionStore: ConnectionStoreSqlite;
  ingressStore: WebhookIngressStore;
  connectionKeyProvider: () => Uint8Array | null;
}

interface ConnectionPreset {
  kind: ConnectionKind;
  vendor: string;
  label: string;
}

const resolvePresetAuth = async (
  deps: BuiltinWebhookRegistrationProfilePresetDeps,
  preset: ConnectionPreset,
  connectionId: string,
) => {
  const row = deps.connectionStore.get(preset.kind, connectionId);
  if (!row || resolveConnectionVendor(row) !== preset.vendor) return null;
  try {
    return await decodeAuthFromStorage(
      row.auth_ciphertext,
      { kind: row.kind, name: row.name },
      deps.connectionKeyProvider,
    );
  } catch {
    throw new WebhookRegistrationAdapterError(
      'connection_locked',
      `${preset.label} connection credential is unavailable while the vault is locked`,
    );
  }
};
const resolveSoleActiveSecret = async (
  deps: BuiltinWebhookRegistrationProfilePresetDeps,
  ingressId: string,
  field: string,
  label: string,
): Promise<string | null> => {
  let versions: Awaited<ReturnType<
    WebhookIngressStore['readActiveCredentialVersions']
  >> = [];
  try {
    versions = await deps.ingressStore.readActiveCredentialVersions(ingressId);
    if (versions.length !== 1) return null;
    const credentials = versions[0]!.credentials;
    return Object.keys(credentials).length === 1
      && typeof credentials[field] === 'string'
      ? credentials[field]!
      : null;
  } catch (error) {
    if (error instanceof WebhookIngressStoreError && error.code === 'conflict') {
      throw new WebhookRegistrationAdapterError(
        'connection_unavailable',
        `${label} webhook credential changed while it was being resolved`,
      );
    }
    if (error instanceof WebhookIngressStoreError && error.code !== 'locked') {
      throw new WebhookRegistrationAdapterError(
        'registration_input_invalid',
        `${label} webhook credential state is invalid`,
      );
    }
    throw new WebhookRegistrationAdapterError(
      'connection_locked',
      `${label} webhook credential is unavailable while the vault is locked`,
    );
  } finally {
    // The adapter still needs the extracted immutable string, but the decrypted
    // record and every rejected overlap candidate can be overwritten now.
    for (const version of versions) {
      for (const key of Object.keys(version.credentials)) {
        try {
          (version.credentials as Record<string, string>)[key] = '';
        } catch {
          // The production store returns mutable null-prototype records. Keep
          // custom/frozen store implementations fail-safe without masking the
          // registration result.
        }
      }
    }
  }
};

export const createBuiltinWebhookRegistrationProfileRegistry = (
  deps: BuiltinWebhookRegistrationProfilePresetDeps,
): WebhookRegistrationRuntimeRegistry => {
  const stripeConnection = Object.freeze({
    kind: 'api',
    vendor: 'stripe',
    label: 'Stripe',
  } as const);
  const telegramConnection = Object.freeze({
    kind: 'notification',
    vendor: 'telegram',
    label: 'Telegram bot',
  } as const);
  const githubConnection = Object.freeze({
    kind: 'api',
    vendor: 'github',
    label: 'GitHub',
  } as const);
  const paddleConnection = Object.freeze({
    kind: 'api',
    vendor: 'paddle',
    label: 'Paddle',
  } as const);

  return createWebhookRegistrationRuntimeRegistry([
    createStripeWebhookRegistrationAdapter({
      apiKeyClassifier: stripeRegistrationApiKeyClassifier,
      endpointSecretParser: stripeRegistrationEndpointSecretParser,
      eventTypeParser: stripeRegistrationEventTypeParser,
      idempotencyKeyParser: stripeRegistrationIdempotencyKeyParser,
      remoteIdParser: stripeRegistrationRemoteIdParser,
      remoteUrlParser: stripeRegistrationRemoteUrlParser,
      responseReader: stripeRegistrationResponseReader,
      resolveConnection: async (connectionId) => {
        const auth = await resolvePresetAuth(deps, stripeConnection, connectionId);
        if (auth === null) return null;
        if (auth.type !== 'basic'
          || typeof auth.username !== 'string'
          || auth.username.length === 0) {
          throw new WebhookRegistrationAdapterError(
            'connection_auth_invalid',
            'Stripe managed registration requires a Basic-auth API key connection',
          );
        }
        return { api_key: auth.username };
      },
    }),
    createTelegramWebhookRegistrationAdapter({
      connectionTokenParser: telegramRegistrationConnectionTokenParser,
      endpointParser: telegramRegistrationEndpointParser,
      eventTypeParser: telegramRegistrationEventTypeParser,
      idempotencyKeyParser: telegramRegistrationIdempotencyKeyParser,
      remoteIdCodec: telegramRegistrationRemoteIdCodec,
      responseReader: telegramRegistrationResponseReader,
      secretParser: telegramRegistrationSecretParser,
      resolveConnection: async (connectionId) => {
        const auth = await resolvePresetAuth(deps, telegramConnection, connectionId);
        if (auth === null) return null;
        if (auth.type !== 'bearer'
          || typeof auth.token !== 'string'
          || auth.token.length === 0) {
          throw new WebhookRegistrationAdapterError(
            'connection_auth_invalid',
            'Telegram managed registration requires a bearer bot-token connection',
          );
        }
        return { bot_token: auth.token };
      },
      resolveActiveSecret: (ingressId) => resolveSoleActiveSecret(
        deps,
        ingressId,
        telegramCredentialPreset.credential_field,
        'Telegram',
      ),
      resolveConfirmedEndpoint: (ingressId) =>
        deps.ingressStore.get(ingressId)?.confirmed_endpoint_url ?? null,
    }),
    createGitHubWebhookRegistrationAdapter({
      accessTokenParser: githubRegistrationAccessTokenParser,
      eventTypeParser: githubRegistrationEventTypeParser,
      idempotencyKeyParser: githubRegistrationIdempotencyKeyParser,
      remoteIdParser: githubRegistrationRemoteIdParser,
      remoteUrlParser: githubRegistrationRemoteUrlParser,
      registrationTargetNormalizer: githubRegistrationTargetNormalizer,
      responseReader: githubRegistrationResponseReader,
      secretParser: githubRegistrationSecretParser,
      resolveConnection: async (connectionId) => {
        const auth = await resolvePresetAuth(deps, githubConnection, connectionId);
        if (auth === null) return null;
        const accessToken = auth.type === 'bearer'
          ? githubRegistrationAccessTokenParser.parse(auth.token)
          : null;
        if (accessToken === null) {
          throw new WebhookRegistrationAdapterError(
            'connection_auth_invalid',
            'GitHub managed registration requires a personal access token connection',
          );
        }
        return {
          access_token: accessToken,
          credential_kind: 'personal_access_token',
        };
      },
      resolveActiveSecret: (ingressId) => resolveSoleActiveSecret(
        deps,
        ingressId,
        githubCredentialPreset.credential_field,
        'GitHub',
      ),
      resolveConfirmedEndpoint: (ingressId) =>
        deps.ingressStore.get(ingressId)?.confirmed_endpoint_url ?? null,
    }),
    createPaddleWebhookRegistrationAdapter({
      apiKeyClassifier: paddleRegistrationApiKeyClassifier,
      destinationParser: paddleRegistrationDestinationParser,
      endpointSecretParser: paddleRegistrationEndpointSecretParser,
      eventTypeParser: paddleRegistrationEventTypeParser,
      idempotencyKeyParser: paddleRegistrationIdempotencyKeyParser,
      remoteIdParser: paddleRegistrationRemoteIdParser,
      responseReader: paddleRegistrationResponseReader,
      resolveConnection: async (connectionId) => {
        const auth = await resolvePresetAuth(deps, paddleConnection, connectionId);
        if (auth === null) return null;
        const apiKey = auth.type === 'bearer'
          ? paddleRegistrationApiKeyClassifier.classify(auth.token)?.value
          : undefined;
        if (apiKey === undefined) {
          throw new WebhookRegistrationAdapterError(
            'connection_auth_invalid',
            'Paddle managed registration requires a modern API-key bearer connection',
          );
        }
        return { api_key: apiKey };
      },
      resolveOwnership: async (ingressId) => {
        const ingress = deps.ingressStore.get(ingressId);
        if (!ingress) return null;
        if (ingress.remote_endpoint_id === null) {
          if (ingress.confirmed_endpoint_url !== null
            || deps.ingressStore.listCredentialVersions(ingressId)
              .some((version) => version.active)) {
            throw new WebhookRegistrationAdapterError(
              'registration_input_invalid',
              'Paddle managed webhook ownership state is incomplete',
            );
          }
          return null;
        }
        if (ingress.confirmed_endpoint_url === null) {
          throw new WebhookRegistrationAdapterError(
            'registration_input_invalid',
            'Paddle managed webhook ownership state is incomplete',
          );
        }
        const endpointSecret = await resolveSoleActiveSecret(
          deps,
          ingressId,
          'endpoint_secret_key',
          'Paddle',
        );
        if (endpointSecret === null) {
          throw new WebhookRegistrationAdapterError(
            'registration_input_invalid',
            'Paddle managed webhook requires one active endpoint secret',
          );
        }
        return {
          remote_endpoint_id: ingress.remote_endpoint_id,
          confirmed_endpoint_url: ingress.confirmed_endpoint_url,
          endpoint_secret_key: endpointSecret,
        };
      },
    }),
  ]);
};
