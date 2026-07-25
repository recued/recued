import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createGitHubWebhookRegistrationAdapter,
  type GitHubWebhookRegistrationDeps,
} from '../connections/providers/github-webhook-registration.js';
import type { ManagedWebhookRegistrationContext } from '../webhook-registration-runtime.js';
import { createWebhookRegistrationRuntimeRegistry } from '../webhook-registration-runtime.js';
import { createWebhookIngressStore } from '../storage/webhook-ingress-store.js';
import { createWebhookManagedRegistrationService } from '../webhook-registration-reconciler.js';
import {
  createWebhookFixedLengthAsciiTokenParser,
} from '../webhook-fixed-length-ascii-token-parser.js';
import {
  createWebhookLowercaseIdentifierEventTypeParser,
} from '../webhook-lowercase-identifier-event-type-parser.js';
import {
  createWebhookAccountResourceRegistrationTargetNormalizer,
} from '../webhook-account-resource-registration-target-normalizer.js';
import {
  webhookRegistrationTargetProfilePreset,
} from '../webhook-registration-target-profile-presets.js';
import {
  createWebhookRegistrationJsonResponseReader,
} from '../webhook-registration-json-response-reader.js';
import {
  createWebhookRegistrationIdempotencyKeyParser,
} from '../webhook-registration-idempotency-key-parser.js';
import {
  createWebhookPositiveDecimalIdentifierParser,
} from '../webhook-positive-decimal-identifier-parser.js';
import {
  createWebhookBoundedHttpUrlParser,
} from '../webhook-bounded-http-url-parser.js';
import {
  webhookRegistrationIdempotencyKeyProfilePreset,
} from '../webhook-registration-idempotency-key-profile-presets.js';
import {
  webhookRegistrationResponseProfilePreset,
} from '../webhook-registration-response-profile-presets.js';
import {
  webhookRegistrationRemoteUrlProfilePreset,
} from '../webhook-registration-remote-url-profile-presets.js';
import {
  createWebhookPrefixSetPrintableAsciiTokenParser,
} from '../webhook-prefix-set-printable-ascii-token-parser.js';
import {
  webhookRegistrationAccessTokenProfilePreset,
} from '../webhook-registration-access-token-profile-presets.js';
import {
  webhookFixedLengthAsciiCredentialProfilePreset,
  webhookPositiveDecimalRegistrationRemoteIdProfilePreset,
} from '../webhook-shared-profile-parser-presets.js';

const SECRET = 'S'.repeat(43);
const ENDPOINT = 'https://hooks.example/v1/webhooks/opaquePublicId_0123456789abcdef';
const databases: Database.Database[] = [];

const githubTargetPreset = webhookRegistrationTargetProfilePreset(
  'github.webhook.v1',
);
if (githubTargetPreset === null) {
  throw new Error('GitHub registration-target test preset is unavailable');
}
const githubRegistrationTargetNormalizer =
  createWebhookAccountResourceRegistrationTargetNormalizer(
    githubTargetPreset.normalizer,
  );

const githubIdempotencyKeyPreset =
  webhookRegistrationIdempotencyKeyProfilePreset('github.webhook.v1');
if (githubIdempotencyKeyPreset === null) {
  throw new Error('GitHub registration idempotency-key test preset is unavailable');
}
const githubRegistrationIdempotencyKeyParser =
  createWebhookRegistrationIdempotencyKeyParser(
    githubIdempotencyKeyPreset.parser,
  );

const githubRemoteIdPreset =
  webhookPositiveDecimalRegistrationRemoteIdProfilePreset(
    'github.webhook.v1',
  );
if (githubRemoteIdPreset === null) {
  throw new Error('GitHub registration remote-id test preset is unavailable');
}
const githubRegistrationRemoteIdParser =
  createWebhookPositiveDecimalIdentifierParser(githubRemoteIdPreset.parser);

const githubResponsePreset = webhookRegistrationResponseProfilePreset(
  'github.webhook.v1',
);
if (githubResponsePreset === null) {
  throw new Error('GitHub registration-response test preset is unavailable');
}
const githubRegistrationResponseReader =
  createWebhookRegistrationJsonResponseReader(githubResponsePreset.reader);

const githubCredentialPreset = webhookFixedLengthAsciiCredentialProfilePreset(
  'github.webhook.v1',
);
if (githubCredentialPreset === null) {
  throw new Error('GitHub registration credential test preset is unavailable');
}
const githubRegistrationSecretParser =
  createWebhookFixedLengthAsciiTokenParser(githubCredentialPreset.parser);

const githubRemoteUrlPreset = webhookRegistrationRemoteUrlProfilePreset(
  'github.webhook.v1',
);
if (githubRemoteUrlPreset === null) {
  throw new Error('GitHub registration remote-URL test preset is unavailable');
}
const githubRegistrationRemoteUrlParser = createWebhookBoundedHttpUrlParser(
  githubRemoteUrlPreset.parser,
);

const githubAccessTokenPreset = webhookRegistrationAccessTokenProfilePreset(
  'github.webhook.v1',
);
if (githubAccessTokenPreset === null) {
  throw new Error('GitHub registration access-token test preset is unavailable');
}
const githubRegistrationAccessTokenParser =
  createWebhookPrefixSetPrintableAsciiTokenParser(
    githubAccessTokenPreset.parser,
  );

afterEach(() => {
  while (databases.length > 0) databases.pop()!.close();
});

const repositoryContext: ManagedWebhookRegistrationContext = {
  paired_connection_id: 'github-api',
  desired: {
    ingress_id: 'whi_0123456789abcdef0123456789abcdef',
    environment: 'live',
    registration_target: { kind: 'repository', key: 'openai/example' },
    endpoint_url: ENDPOINT,
    event_types: ['issues', 'pull_request'],
  },
};

const organizationContext: ManagedWebhookRegistrationContext = {
  ...repositoryContext,
  desired: {
    ...repositoryContext.desired,
    registration_target: { kind: 'organization', key: 'openai' },
  },
};

const hook = (
  context: ManagedWebhookRegistrationContext,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  id: 123,
  name: 'web',
  type: context.desired.registration_target?.kind === 'organization'
    ? 'Organization'
    : 'Repository',
  active: true,
  events: context.desired.event_types,
  config: {
    url: context.desired.endpoint_url,
    content_type: 'json',
    insecure_ssl: '0',
  },
  ...overrides,
});

const json = (
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json', ...headers },
});

const makeAdapter = (overrides: Partial<GitHubWebhookRegistrationDeps> = {}) =>
  createGitHubWebhookRegistrationAdapter({
    accessTokenParser: githubRegistrationAccessTokenParser,
    eventTypeParser: createWebhookLowercaseIdentifierEventTypeParser({
      kind: 'lowercase_identifier_event_type.v1',
      max_characters: 128,
    }),
    idempotencyKeyParser: githubRegistrationIdempotencyKeyParser,
    remoteIdParser: githubRegistrationRemoteIdParser,
    remoteUrlParser: githubRegistrationRemoteUrlParser,
    registrationTargetNormalizer: githubRegistrationTargetNormalizer,
    responseReader: githubRegistrationResponseReader,
    secretParser: githubRegistrationSecretParser,
    resolveConnection: async () => ({
      access_token: 'github_pat_fixture-token',
      credential_kind: 'personal_access_token',
    }),
    resolveActiveSecret: async () => SECRET,
    resolveConfirmedEndpoint: async () => ENDPOINT,
    generateSecret: () => SECRET,
    ...overrides,
  });

describe('D-201 Slices 8E + 8F + 9Q + 9AE-9AF + 9AL + 9AN + 9AV + 9AY + 9BC GitHub managed webhook registration adapter', () => {
  it('pins one token parse and credential-kind read before using Bearer authority', async () => {
    const compiled = createWebhookPrefixSetPrintableAsciiTokenParser({
      kind: 'prefix_set_printable_ascii_token.v1',
      max_bytes: 64,
      prefixes: ['fixture_pat_'],
    });
    const parse = vi.fn(() => 'fixture_pat_CLEAN');
    let tokenReads = 0;
    let credentialKindReads = 0;
    const connection = Object.create(null) as {
      access_token: string;
      credential_kind: 'personal_access_token';
    };
    Object.defineProperties(connection, {
      access_token: {
        enumerable: true,
        get() {
          tokenReads += 1;
          return tokenReads === 1 ? 'fixture_pat_RAW' : 'fixture_pat_BAD';
        },
      },
      credential_kind: {
        enumerable: true,
        get() {
          credentialKindReads += 1;
          return credentialKindReads === 1
            ? 'personal_access_token'
            : 'oauth';
        },
      },
    });
    const fetchImpl = vi.fn(async (
      _url: string | URL | Request,
      _init?: RequestInit,
    ) => json([]));
    const adapter = makeAdapter({
      accessTokenParser: { preset: compiled.preset, parse },
      fetchImpl,
      resolveConnection: async () => connection,
    });

    await expect(adapter.find(repositoryContext)).resolves.toEqual([]);
    await expect(adapter.find(repositoryContext)).resolves.toEqual([]);
    expect(tokenReads).toBe(1);
    expect(credentialKindReads).toBe(1);
    expect(parse).toHaveBeenCalledTimes(1);
    expect(parse).toHaveBeenCalledWith('fixture_pat_RAW');
    for (const [, init] of fetchImpl.mock.calls) {
      expect((init?.headers as Headers).get('Authorization'))
        .toBe('Bearer fixture_pat_CLEAN');
    }
  });

  it('rejects non-primitive resolved access tokens before provider I/O', async () => {
    const fetchImpl = vi.fn();
    const adapter = makeAdapter({
      fetchImpl,
      resolveConnection: async () => ({
        access_token: new String('github_pat_fixture-token') as unknown as string,
        credential_kind: 'personal_access_token',
      }),
    });

    await expect(adapter.find(repositoryContext)).rejects.toMatchObject({
      code: 'connection_auth_invalid',
      message: 'GitHub managed registration requires a personal access token',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('uses one injected event-type parser for desired and remote event sets', async () => {
    const eventTypeParser = createWebhookLowercaseIdentifierEventTypeParser({
      kind: 'lowercase_identifier_event_type.v1',
      max_characters: 6,
    });
    const fetchImpl = vi.fn(async () => json([hook(repositoryContext, {
      events: ['pull_request'],
    })]));
    const adapter = makeAdapter({ eventTypeParser, fetchImpl });

    await expect(adapter.find(repositoryContext)).rejects.toMatchObject({
      code: 'registration_input_invalid',
    });
    expect(fetchImpl).not.toHaveBeenCalled();

    const narrowContext: ManagedWebhookRegistrationContext = {
      ...repositoryContext,
      desired: {
        ...repositoryContext.desired,
        event_types: ['issues'],
      },
    };
    await expect(adapter.find(narrowContext)).rejects.toMatchObject({
      code: 'upstream_response_invalid',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('uses one injected remote-URL parser for desired and provider URLs', async () => {
    const remoteUrl = 'http://legacy.example/hook?query=1#fragment';
    const compiled = createWebhookBoundedHttpUrlParser(
      githubRemoteUrlPreset.parser,
    );
    const parse = vi.fn(compiled.parse);
    const fetchImpl = vi.fn(async () => json([hook(repositoryContext, {
      config: {
        url: remoteUrl,
        content_type: 'json',
        insecure_ssl: '0',
      },
    })]));
    const adapter = makeAdapter({
      fetchImpl,
      remoteUrlParser: { preset: compiled.preset, parse },
    });

    await expect(adapter.find(repositoryContext)).resolves.toEqual([]);
    expect(parse.mock.calls).toEqual([
      [repositoryContext.desired.endpoint_url],
      [repositoryContext.desired.endpoint_url],
      [remoteUrl],
    ]);
  });

  it('uses the injected closed target normalizer before any provider I/O', async () => {
    const incompatibleDelegate =
      createWebhookAccountResourceRegistrationTargetNormalizer({
        kind: 'account_or_account_resource.v1',
        account_kind: 'workspace',
        resource_kind: 'project',
      });
    const normalize = vi.fn(incompatibleDelegate.normalize);
    const incompatibleNormalizer = {
      preset: incompatibleDelegate.preset,
      normalize,
    };
    const fetchImpl = vi.fn();
    const adapter = makeAdapter({
      registrationTargetNormalizer: incompatibleNormalizer,
      fetchImpl,
    });

    await expect(adapter.find(repositoryContext)).rejects.toMatchObject({
      code: 'registration_input_invalid',
    });
    expect(normalize).toHaveBeenCalledWith(
      repositoryContext.desired.registration_target,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('uses the injected idempotency-key parser for create and update', async () => {
    const idempotencyKeyParser =
      createWebhookRegistrationIdempotencyKeyParser({
        kind: 'ascii_registration_idempotency_key.v1',
        max_characters: 1,
      });
    const fetchImpl = vi.fn();
    const adapter = makeAdapter({ idempotencyKeyParser, fetchImpl });

    await expect(adapter.create(repositoryContext, 'ab')).rejects.toMatchObject({
      code: 'registration_input_invalid',
      message: 'GitHub registration idempotency key is invalid',
    });
    await expect(adapter.update(
      repositoryContext,
      '123',
      'ab',
    )).rejects.toMatchObject({
      code: 'registration_input_invalid',
      message: 'GitHub registration idempotency key is invalid',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('fails closed instead of regex-coercing non-string idempotency values', async () => {
    const fetchImpl = vi.fn();
    const resolveConnection = vi.fn(async () => ({
      access_token: 'github_pat_fixture-token',
      credential_kind: 'personal_access_token' as const,
    }));
    const resolveActiveSecret = vi.fn(async () => SECRET);
    const resolveConfirmedEndpoint = vi.fn(async () => ENDPOINT);
    const generateSecret = vi.fn(() => SECRET);
    const adapter = makeAdapter({
      fetchImpl,
      generateSecret,
      resolveActiveSecret,
      resolveConfirmedEndpoint,
      resolveConnection,
    });

    await expect(adapter.create(
      repositoryContext,
      null as never,
    )).rejects.toMatchObject({
      code: 'registration_input_invalid',
      message: 'GitHub registration idempotency key is invalid',
    });
    await expect(adapter.update(
      repositoryContext,
      '123',
      1 as never,
    )).rejects.toMatchObject({
      code: 'registration_input_invalid',
      message: 'GitHub registration idempotency key is invalid',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(generateSecret).not.toHaveBeenCalled();
    expect(resolveActiveSecret).not.toHaveBeenCalled();
    expect(resolveConfirmedEndpoint).not.toHaveBeenCalled();
    expect(resolveConnection).not.toHaveBeenCalled();
  });

  it('uses the injected remote-id parser for provider results and committed ids', async () => {
    const remoteIdParser = createWebhookPositiveDecimalIdentifierParser({
      kind: 'positive_decimal_identifier.v1',
      max_digits: 2,
    });
    const fetchImpl = vi.fn(async () => json([hook(repositoryContext)]));
    const adapter = makeAdapter({ fetchImpl, remoteIdParser });

    await expect(adapter.find(repositoryContext)).rejects.toMatchObject({
      code: 'upstream_response_invalid',
      message: 'GitHub returned an invalid webhook object',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    fetchImpl.mockClear();

    for (const invoke of [
      () => adapter.read(repositoryContext, '123'),
      () => adapter.update(
        repositoryContext,
        '123',
        'recued-d201-update-key',
      ),
      () => adapter.delete(repositoryContext, '123'),
    ]) {
      await expect(invoke()).rejects.toMatchObject({
        code: 'upstream_response_invalid',
        message: 'GitHub remote webhook id is invalid',
      });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('fails closed instead of regex-coercing non-string remote ids', async () => {
    const fetchImpl = vi.fn();
    const resolveConnection = vi.fn(async () => ({
      access_token: 'github_pat_fixture-token',
      credential_kind: 'personal_access_token' as const,
    }));
    const resolveActiveSecret = vi.fn(async () => SECRET);
    const resolveConfirmedEndpoint = vi.fn(async () => ENDPOINT);
    const normalize = vi.fn(githubRegistrationTargetNormalizer.normalize);
    const registrationTargetNormalizer = {
      preset: githubRegistrationTargetNormalizer.preset,
      normalize,
    };
    const adapter = makeAdapter({
      fetchImpl,
      registrationTargetNormalizer,
      resolveActiveSecret,
      resolveConfirmedEndpoint,
      resolveConnection,
    });

    for (const invoke of [
      () => adapter.read(repositoryContext, 1 as never),
      () => adapter.update(
        repositoryContext,
        new String('1') as never,
        'recued-d201-update-key',
      ),
      () => adapter.delete(repositoryContext, null as never),
    ]) {
      await expect(invoke()).rejects.toMatchObject({
        code: 'upstream_response_invalid',
        message: 'GitHub remote webhook id is invalid',
      });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(normalize).not.toHaveBeenCalled();
    expect(resolveActiveSecret).not.toHaveBeenCalled();
    expect(resolveConfirmedEndpoint).not.toHaveBeenCalled();
    expect(resolveConnection).not.toHaveBeenCalled();
  });

  it('maps injected account/resource roles onto the closed provider scopes', async () => {
    const registrationTargetNormalizer =
      createWebhookAccountResourceRegistrationTargetNormalizer({
        kind: 'account_or_account_resource.v1',
        account_kind: 'workspace',
        resource_kind: 'project',
      });
    const fetchImpl = vi.fn(async (
      _input: string | URL | Request,
      _init?: RequestInit,
    ) => json([]));
    const adapter = makeAdapter({ registrationTargetNormalizer, fetchImpl });
    const projectContext: ManagedWebhookRegistrationContext = {
      ...repositoryContext,
      desired: {
        ...repositoryContext.desired,
        registration_target: { kind: 'project', key: 'openai/example' },
      },
    };
    const workspaceContext: ManagedWebhookRegistrationContext = {
      ...repositoryContext,
      desired: {
        ...repositoryContext.desired,
        registration_target: { kind: 'workspace', key: 'openai' },
      },
    };

    await expect(adapter.find(projectContext)).resolves.toEqual([]);
    await expect(adapter.find(workspaceContext)).resolves.toEqual([]);
    expect(String(fetchImpl.mock.calls[0]![0])).toBe(
      'https://api.github.com/repos/openai/example/hooks?per_page=100&page=1',
    );
    expect(String(fetchImpl.mock.calls[1]![0])).toBe(
      'https://api.github.com/orgs/openai/hooks?per_page=100&page=1',
    );
  });

  it('creates a repository hook with only closed GitHub fields and returns the generated secret', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(json([]))
      .mockResolvedValueOnce(json(hook(repositoryContext), 201));
    const adapter = makeAdapter({ fetchImpl });

    await expect(adapter.create(
      repositoryContext,
      'recued-d201-create-key',
    )).resolves.toEqual({
      endpoint: {
        remote_endpoint_id: '123',
        environment: 'live',
        endpoint_url: ENDPOINT,
        event_types: ['issues', 'pull_request'],
        enabled: true,
        correlation_valid: true,
      },
      credential_result: { webhook_secret: SECRET },
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(String(fetchImpl.mock.calls[0]![0])).toBe(
      'https://api.github.com/repos/openai/example/hooks?per_page=100&page=1',
    );
    const [url, init] = fetchImpl.mock.calls[1]!;
    expect(String(url)).toBe('https://api.github.com/repos/openai/example/hooks');
    expect(init?.method).toBe('POST');
    expect(init?.redirect).toBe('error');
    expect(init?.credentials).toBe('omit');
    const headers = init?.headers as Headers;
    expect(headers.get('Authorization')).toBe('Bearer github_pat_fixture-token');
    expect(headers.get('X-GitHub-Api-Version')).toBe('2022-11-28');
    expect(headers.has('Idempotency-Key')).toBe(false);
    expect(JSON.parse(String(init?.body))).toEqual({
      name: 'web',
      active: true,
      events: ['issues', 'pull_request'],
      config: {
        url: ENDPOINT,
        content_type: 'json',
        secret: SECRET,
        insecure_ssl: '0',
      },
    });
  });

  it('uses organization-scoped paths and re-sends the active secret on full update', async () => {
    const oldEndpoint = 'https://old.example/v1/webhooks/opaquePublicId_0123456789abcdef';
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(json(hook(organizationContext, {
        config: {
          url: oldEndpoint,
          content_type: 'json',
          insecure_ssl: '0',
        },
      })))
      .mockResolvedValueOnce(json(hook(organizationContext)));
    const resolveActiveSecret = vi.fn(async () => SECRET);
    const adapter = makeAdapter({
      fetchImpl,
      resolveActiveSecret,
      resolveConfirmedEndpoint: async () => oldEndpoint,
    });

    await expect(adapter.update(
      organizationContext,
      '123',
      'recued-d201-update-key',
    )).resolves.toMatchObject({
      remote_endpoint_id: '123',
      endpoint_url: ENDPOINT,
      correlation_valid: true,
    });
    expect(String(fetchImpl.mock.calls[0]![0])).toBe(
      'https://api.github.com/orgs/openai/hooks/123',
    );
    const [url, init] = fetchImpl.mock.calls[1]!;
    expect(String(url)).toBe('https://api.github.com/orgs/openai/hooks/123');
    expect(init?.method).toBe('PATCH');
    expect((init?.headers as Headers).has('Idempotency-Key')).toBe(false);
    expect(JSON.parse(String(init?.body))).toEqual({
      active: true,
      events: ['issues', 'pull_request'],
      config: {
        url: ENDPOINT,
        content_type: 'json',
        secret: SECRET,
        insecure_ssl: '0',
      },
    });
    expect(resolveActiveSecret).toHaveBeenCalledWith(
      repositoryContext.desired.ingress_id,
    );
  });

  it('uses one injected credential parser for generated create and active update secrets', async () => {
    const customSecret = 'Ab_1';
    const compiled = createWebhookFixedLengthAsciiTokenParser({
      kind: 'fixed_length_ascii_token.v1',
      characters: customSecret.length,
    });
    const parse = vi.fn(compiled.parse);
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(json([]))
      .mockResolvedValueOnce(json(hook(repositoryContext), 201))
      .mockResolvedValueOnce(json(hook(repositoryContext)))
      .mockResolvedValueOnce(json(hook(repositoryContext)));
    const adapter = makeAdapter({
      fetchImpl,
      generateSecret: () => customSecret,
      resolveActiveSecret: async () => customSecret,
      secretParser: { preset: compiled.preset, parse },
    });

    await expect(adapter.create(
      repositoryContext,
      'recued-d201-create-key',
    )).resolves.toMatchObject({
      credential_result: { webhook_secret: customSecret },
    });
    await expect(adapter.update(
      repositoryContext,
      '123',
      'recued-d201-update-key',
    )).resolves.toMatchObject({ remote_endpoint_id: '123' });

    expect(parse.mock.calls).toEqual([[customSecret], [customSecret]]);
    expect(JSON.parse(String(fetchImpl.mock.calls[1]![1]?.body)))
      .toMatchObject({ config: { secret: customSecret } });
    expect(JSON.parse(String(fetchImpl.mock.calls[3]![1]?.body)))
      .toMatchObject({ config: { secret: customSecret } });
  });

  it('lists every bounded page and treats exact target plus opaque URL as owned', async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => hook(
      repositoryContext,
      {
        id: index + 1,
        config: {
          url: `https://unrelated.example/hooks/${index + 1}`,
          content_type: 'json',
          insecure_ssl: '0',
        },
      },
    ));
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(json(firstPage))
      .mockResolvedValueOnce(json([
        hook(repositoryContext, {
          id: 501,
          active: false,
          events: ['*'],
          config: {
            url: ENDPOINT,
            content_type: 'form',
            insecure_ssl: '1',
          },
        }),
        { id: 502, name: 'legacy-service' },
      ]));
    const adapter = makeAdapter({ fetchImpl });

    await expect(adapter.find(repositoryContext)).resolves.toEqual([{
      correlation: 'owned',
      endpoint: {
        remote_endpoint_id: '501',
        environment: 'live',
        endpoint_url: ENDPOINT,
        event_types: ['*'],
        enabled: false,
        correlation_valid: false,
      },
    }]);
    expect(String(fetchImpl.mock.calls[1]![0])).toContain('page=2');
  });

  it('fails closed when exhaustive target search exceeds its page bound', async () => {
    const fullPage = Array.from({ length: 100 }, (_, index) => hook(
      repositoryContext,
      {
        id: index + 1,
        config: {
          url: `https://unrelated.example/hooks/${index + 1}`,
          content_type: 'json',
        },
      },
    ));
    const fetchImpl = vi.fn(async () => json(fullPage));
    const adapter = makeAdapter({ fetchImpl });

    await expect(adapter.find(repositoryContext)).rejects.toMatchObject({
      code: 'search_incomplete',
      message: 'GitHub webhook search exceeded its bounded page limit',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(10);
  });

  it('treats an exact-URL legacy service hook as collision evidence only', async () => {
    const fetchImpl = vi.fn(async () => json([{
      id: 77,
      name: 'legacy-service',
      config: { url: ENDPOINT },
    }]));
    const adapter = makeAdapter({ fetchImpl });

    await expect(adapter.find(repositoryContext)).resolves.toEqual([{
      correlation: 'metadata_conflict',
      endpoint: {
        remote_endpoint_id: '77',
        environment: 'live',
        endpoint_url: ENDPOINT,
        event_types: [],
        enabled: false,
        correlation_valid: false,
      },
    }]);
  });

  it('refuses create when the immediate pre-mutation search sees an exact hook', async () => {
    const fetchImpl = vi.fn(async () => json([hook(repositoryContext)]));
    const adapter = makeAdapter({ fetchImpl });

    await expect(adapter.create(
      repositoryContext,
      'recued-d201-create-key',
    )).rejects.toMatchObject({ code: 'upstream_rejected' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('does not update or resolve a secret when the committed id points at a foreign URL', async () => {
    const fetchImpl = vi.fn(async () => json(hook(repositoryContext, {
      config: {
        url: 'https://attacker.example/hook',
        content_type: 'json',
        insecure_ssl: '0',
      },
    })));
    const resolveActiveSecret = vi.fn(async () => SECRET);
    const adapter = makeAdapter({
      fetchImpl,
      resolveActiveSecret,
      resolveConfirmedEndpoint: async () => 'https://old.example/expected-hook',
    });

    await expect(adapter.update(
      repositoryContext,
      '123',
      'recued-d201-update-key',
    )).rejects.toMatchObject({ code: 'upstream_rejected' });
    expect(resolveActiveSecret).not.toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('deletes only an exact target-scoped URL and accepts confirmed absence', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(json(hook(repositoryContext)))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const adapter = makeAdapter({ fetchImpl });

    await expect(adapter.delete(repositoryContext, '123')).resolves.toBeUndefined();
    expect(String(fetchImpl.mock.calls[1]![0])).toBe(
      'https://api.github.com/repos/openai/example/hooks/123',
    );
    expect(fetchImpl.mock.calls[1]![1]?.method).toBe('DELETE');

    const absentFetch = vi.fn()
      .mockResolvedValueOnce(json({ message: 'Not Found' }, 404))
      .mockResolvedValueOnce(json([]));
    const absent = makeAdapter({ fetchImpl: absentFetch });
    await expect(absent.delete(repositoryContext, '123')).resolves.toBeUndefined();
    expect(absentFetch).toHaveBeenCalledTimes(2);

    const racedDeleteFetch = vi.fn()
      .mockResolvedValueOnce(json(hook(repositoryContext)))
      .mockResolvedValueOnce(json({ message: 'Not Found' }, 404))
      .mockResolvedValueOnce(json({ message: 'Not Found' }, 404))
      .mockResolvedValueOnce(json([]));
    const racedDelete = makeAdapter({ fetchImpl: racedDeleteFetch });
    await expect(racedDelete.delete(repositoryContext, '123'))
      .resolves.toBeUndefined();
    expect(racedDeleteFetch).toHaveBeenCalledTimes(4);
  });

  it('does not confuse a permission-hidden GitHub 404 with confirmed absence', async () => {
    const fetchImpl = vi.fn(async () => json({ message: 'Not Found' }, 404));
    const adapter = makeAdapter({ fetchImpl });

    await expect(adapter.read(repositoryContext, '123')).rejects.toMatchObject({
      code: 'upstream_rejected',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('refuses deletion when the target-scoped id no longer has the expected URL', async () => {
    const fetchImpl = vi.fn(async () => json(hook(repositoryContext, {
      config: {
        url: 'https://attacker.example/hook',
        content_type: 'json',
        insecure_ssl: '0',
      },
    })));
    const adapter = makeAdapter({ fetchImpl });

    await expect(adapter.delete(repositoryContext, '123')).rejects.toMatchObject({
      code: 'upstream_rejected',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([
    [401, {}, 'connection_auth_invalid'],
    [403, { 'X-RateLimit-Remaining': '0' }, 'upstream_unavailable'],
    [422, {}, 'upstream_rejected'],
    [503, {}, 'upstream_unavailable'],
  ] as const)('normalizes HTTP %s without surfacing provider bodies', async (
    status,
    headers,
    code,
  ) => {
    const fetchImpl = vi.fn(async () => json({ secret: 'must-not-surface' }, status, headers));
    const adapter = makeAdapter({ fetchImpl });
    const error = await adapter.find(repositoryContext).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code });
    expect(String((error as Error).message)).not.toContain('must-not-surface');
  });

  it('rejects undocumented successful statuses before interpreting valid bodies', async () => {
    const partialList = makeAdapter({
      fetchImpl: async () => json([], 206),
    });
    await expect(partialList.find(repositoryContext)).rejects.toMatchObject({
      code: 'upstream_response_invalid',
    });

    const wrongCreateStatus = makeAdapter({
      fetchImpl: vi.fn()
        .mockResolvedValueOnce(json([]))
        .mockResolvedValueOnce(json(hook(repositoryContext), 200)),
    });
    await expect(wrongCreateStatus.create(
      repositoryContext,
      'recued-d201-create-key',
    )).rejects.toMatchObject({ code: 'upstream_response_invalid' });
  });

  it('rejects noncanonical targets and invalid generated secrets before mutation', async () => {
    const resolveConnection = vi.fn(async () => ({
      access_token: 'github_pat_fixture-token',
      credential_kind: 'personal_access_token' as const,
    }));
    const fetchImpl = vi.fn(async () => json([]));
    const adapter = makeAdapter({
      resolveConnection,
      fetchImpl,
      generateSecret: () => 'not-a-generated-secret',
    });
    const noncanonical: ManagedWebhookRegistrationContext = {
      ...repositoryContext,
      desired: {
        ...repositoryContext.desired,
        registration_target: { kind: 'repository', key: 'OpenAI/Example' },
      },
    };

    await expect(adapter.find(noncanonical)).rejects.toMatchObject({
      code: 'registration_input_invalid',
    });
    expect(resolveConnection).not.toHaveBeenCalled();

    await expect(adapter.create(
      repositoryContext,
      'recued-d201-create-key',
    )).rejects.toMatchObject({ code: 'registration_input_invalid' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('rejects a bearer resolver that cannot attest personal-token hook visibility', async () => {
    const fetchImpl = vi.fn(async () => json([]));
    const adapter = makeAdapter({
      resolveConnection: async () => ({
        access_token: 'gho_oauth-token-fixture',
        credential_kind: 'oauth' as never,
      }),
      fetchImpl,
    });

    await expect(adapter.find(repositoryContext)).rejects.toMatchObject({
      code: 'connection_auth_invalid',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects an OAuth-prefixed bearer even if a resolver mislabels it as personal', async () => {
    const fetchImpl = vi.fn(async () => json([]));
    const adapter = makeAdapter({
      resolveConnection: async () => ({
        access_token: 'gho_oauth-token-fixture',
        credential_kind: 'personal_access_token',
      }),
      fetchImpl,
    });

    await expect(adapter.find(repositoryContext)).rejects.toMatchObject({
      code: 'connection_auth_invalid',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('uses the injected bounded response reader for provider bodies', async () => {
    const responseReader = createWebhookRegistrationJsonResponseReader({
      kind: 'bounded_json_response.v1',
      max_bytes: 1,
      error_label: 'Injected registration fixture',
    });
    const fetchImpl = vi.fn(async () => new Response('[]'));
    const adapter = makeAdapter({ responseReader, fetchImpl });

    await expect(adapter.find(repositoryContext)).rejects.toMatchObject({
      code: 'upstream_response_too_large',
      message: 'Injected registration fixture response exceeded the size limit',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('bounds and fatally decodes response JSON before parsing hook identities', async () => {
    const oversized = makeAdapter({
      fetchImpl: async () => new Response('x'.repeat(512 * 1024 + 1)),
    });
    await expect(oversized.find(repositoryContext)).rejects.toMatchObject({
      code: 'upstream_response_too_large',
    });

    const invalidUtf8 = makeAdapter({
      fetchImpl: async () => new Response(new Uint8Array([0xff])),
    });
    await expect(invalidUtf8.find(repositoryContext)).rejects.toMatchObject({
      code: 'upstream_response_invalid',
      message: 'GitHub webhook registration returned invalid UTF-8',
    });

    const malformedJson = makeAdapter({
      fetchImpl: async () => new Response('{"hooks":'),
    });
    await expect(malformedJson.find(repositoryContext)).rejects.toMatchObject({
      code: 'upstream_response_invalid',
      message: 'GitHub webhook registration returned malformed JSON',
    });

    const malformed = makeAdapter({
      fetchImpl: async () => json([{ ...hook(repositoryContext), id: 1.5 }]),
    });
    await expect(malformed.find(repositoryContext)).rejects.toMatchObject({
      code: 'upstream_response_invalid',
    });
  });

  it('commits the generated secret only after generic reconciler read-back', async () => {
    const db = new Database(':memory:');
    databases.push(db);
    const store = createWebhookIngressStore(db, {
      getEncryptionKey: () => new Uint8Array(32).fill(9),
      newIngressId: () => repositoryContext.desired.ingress_id,
      newPublicId: () => 'opaquePublicId_0123456789abcdef',
      newCredentialSetRef: () => 'whc_0123456789abcdef0123456789abcdef',
    });
    const ingress = store.create({
      display_name: 'Managed GitHub repository events',
      profile_id: 'github.webhook.v1',
      environment: 'live',
      paired_connection_id: 'github-api',
      registration_target: { kind: 'repository', key: 'openai/example' },
      registration_mode: 'managed_endpoint',
      selected_event_types: ['issues', 'pull_request'],
    });
    const fetchImpl = vi.fn(async (
      url: string | URL | Request,
      init?: RequestInit,
    ) => {
      if (String(url).includes('?')) return json([]);
      if (init?.method === 'POST') return json(hook(repositoryContext), 201);
      return json(hook(repositoryContext));
    });
    const adapter = makeAdapter({ fetchImpl });
    const service = createWebhookManagedRegistrationService({
      store,
      adapters: createWebhookRegistrationRuntimeRegistry([adapter]),
      resolveCanonicalEndpoint: () => ENDPOINT,
    });

    await expect(service.reconcile(ingress.ingress_id)).resolves.toMatchObject({
      remote_endpoint_id: '123',
      registration_state: 'registered',
      intake_state: 'ready',
    });
    await expect(store.readActiveCredentialVersions(ingress.ingress_id))
      .resolves.toEqual([expect.objectContaining({
        credentials: { webhook_secret: SECRET },
      })]);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });
});
