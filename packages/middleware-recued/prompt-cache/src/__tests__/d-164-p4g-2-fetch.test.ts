import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SessionEntry } from '@recued/chat';
import type { TurnContext } from '@recued/middleware';

import {
  runGate,
  type DataPresenceProbe,
  type DataSnapshot,
  type GateDeps,
} from '../index';
import type { SlotValue } from '../ner/index';
import {
  BundleFetchError,
  BundlePoolError,
  computeBundleEntryHash,
  createHttpBundleFetcher,
  createTemplateLibrary,
  createTemplateRenderer,
  loadBundlePool,
  parseBundleManifest,
  type BundleEntryInput,
  type BundleFetchErrorReason,
  type BundleFetcher,
  type HttpClient,
} from '../templates/index';
import type { RenderTemplate, SlotName } from '../types';

interface MakeRenderTemplateOptions {
  readonly body?: string;
  readonly locale?: string;
  readonly slot_grammar?: ReadonlyArray<SlotName>;
  readonly template_hash?: string;
}

const makeRenderTemplate = (
  opts: MakeRenderTemplateOptions = {},
): RenderTemplate => {
  const body = opts.body ?? 'Hello {{contact.name}}';
  const locale = opts.locale ?? 'en';
  const slotGrammar = [...(opts.slot_grammar ?? [])];
  return {
    template_hash: opts.template_hash ?? computeBundleEntryHash({
      body,
      locale,
      slot_grammar: slotGrammar,
    }),
    kind: 'render_template',
    slot_grammar: slotGrammar,
    action_class: 'read',
    short_circuit_eligible: true,
    body,
  };
};

const makeBundleEntry = (
  opts: MakeRenderTemplateOptions = {},
): BundleEntryInput => {
  const locale = opts.locale ?? 'en';
  return {
    template: makeRenderTemplate({ ...opts, locale }),
    locale,
  };
};

const makeManifest = (
  entries: ReadonlyArray<BundleEntryInput> = [makeBundleEntry()],
  version = '2026-05-25-001',
) => ({
  version,
  entries,
});

const makeResponse = (
  raw: unknown,
  overrides: Partial<Pick<Response, 'ok' | 'status' | 'statusText'>> = {},
): Response => ({
  ok: overrides.ok ?? true,
  status: overrides.status ?? 200,
  statusText: overrides.statusText ?? 'OK',
  json: vi.fn(async () => raw),
} as unknown as Response);

const makeRejectingJsonResponse = (err: unknown): Response => ({
  ok: true,
  status: 200,
  statusText: 'OK',
  json: vi.fn(async () => {
    throw err;
  }),
} as unknown as Response);

const expectSyncBundleFetchError = (
  run: () => unknown,
  reason: BundleFetchErrorReason,
): BundleFetchError => {
  try {
    run();
  } catch (err) {
    expect(err).toBeInstanceOf(BundleFetchError);
    const error = err as BundleFetchError;
    expect(error.reason).toBe(reason);
    return error;
  }
  throw new Error(`expected BundleFetchError ${reason}`);
};

const expectAsyncBundleFetchError = async (
  run: () => Promise<unknown>,
  reason: BundleFetchErrorReason,
): Promise<BundleFetchError> => {
  try {
    await run();
  } catch (err) {
    expect(err).toBeInstanceOf(BundleFetchError);
    const error = err as BundleFetchError;
    expect(error.reason).toBe(reason);
    return error;
  }
  throw new Error(`expected BundleFetchError ${reason}`);
};

const requireFirst = <T>(items: ReadonlyArray<T>): T => {
  const first = items[0];
  if (first === undefined) throw new Error('expected first item');
  return first;
};

const stringifyForDetail = (value: unknown): string => (
  JSON.stringify(value) ?? 'undefined'
);

const makeSlot = (
  kind: SlotName,
  value: string = kind,
  position = 0,
): SlotValue => ({
  kind,
  value,
  raw: value,
  position,
});

const makeSessionEntry = (
  role: SessionEntry['role'],
  text: string,
  ts = 0,
): SessionEntry => ({
  session_id: 's',
  surface: 'chat',
  role,
  text,
  ts,
});

const makeTurnContext = (history: readonly SessionEntry[]) => {
  const resolve = vi.fn();
  const ctx = {
    history,
    prompt: {
      contribute: vi.fn(),
      parts: () => [],
    },
    resolve,
    state: new Map<string, unknown>(),
  } as unknown as TurnContext;

  return { ctx, resolve };
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('D-164 P4g-2 parseBundleManifest', () => {
  it('returns a typed manifest with version and entries preserved', () => {
    const entry = makeBundleEntry({
      body: 'Email {{contact.email}}',
      slot_grammar: ['entity.email'],
    });

    const manifest = parseBundleManifest(makeManifest([entry], 'v1'));

    expect(manifest).toEqual({ version: 'v1', entries: [entry] });
    expect(requireFirst(manifest.entries).template).toBe(entry.template);
  });

  it.each([
    ['string', 'not an object'],
    ['number', 123],
    ['null', null],
    ['array', []],
  ] as const)('rejects a non-object manifest root: %s', (_name, raw) => {
    const error = expectSyncBundleFetchError(
      () => parseBundleManifest(raw),
      'schema_invalid',
    );

    expect(error.detail).toContain('manifest root');
    expect(error.detail).toContain('object');
  });

  it.each([
    ['missing', undefined, { entries: [] }],
    ['empty', '', { version: '', entries: [] }],
    ['number', 123, { version: 123, entries: [] }],
    ['null', null, { version: null, entries: [] }],
  ] as const)('rejects an invalid version: %s', (_name, value, raw) => {
    const error = expectSyncBundleFetchError(
      () => parseBundleManifest(raw),
      'schema_invalid',
    );

    expect(error.detail).toContain('manifest.version');
    expect(error.detail).toContain(stringifyForDetail(value));
  });

  it('escapes caller-supplied version values in schema error details', () => {
    const forgedVersion = ['forged"\n[99]"forged'];

    const error = expectSyncBundleFetchError(
      () => parseBundleManifest({ version: forgedVersion, entries: [] }),
      'schema_invalid',
    );

    expect(error.detail).not.toContain('\n');
    expect(error.detail).toContain(JSON.stringify(forgedVersion));
  });

  it.each([
    ['missing', { version: 'v1' }],
    ['object', { version: 'v1', entries: {} }],
    ['string', { version: 'v1', entries: 'entries' }],
  ] as const)('rejects invalid entries: %s', (_name, raw) => {
    const error = expectSyncBundleFetchError(
      () => parseBundleManifest(raw),
      'schema_invalid',
    );

    expect(error.detail).toContain('manifest.entries');
    expect(error.detail).toContain('array');
  });

  it.each([
    ['string', 'entry'],
    ['array', []],
    ['null', null],
  ] as const)('rejects a non-object entry: %s', (_name, entry) => {
    const error = expectSyncBundleFetchError(
      () => parseBundleManifest({
        version: 'v1',
        entries: [makeBundleEntry(), entry],
      }),
      'schema_invalid',
    );

    expect(error.detail).toContain('manifest.entries[1]');
    expect(error.detail).toContain('object');
  });

  it.each([
    ['string', 'template'],
    ['null', null],
  ] as const)('rejects a non-object template: %s', (_name, template) => {
    const error = expectSyncBundleFetchError(
      () => parseBundleManifest({
        version: 'v1',
        entries: [{ template, locale: 'en' }],
      }),
      'schema_invalid',
    );

    expect(error.detail).toContain('manifest.entries[0].template');
    expect(error.detail).toContain('object');
  });

  it.each([
    ['missing', undefined, { template: {} }],
    ['empty', '', { template: {}, locale: '' }],
    ['number', 123, { template: {}, locale: 123 }],
    ['null', null, { template: {}, locale: null }],
  ] as const)('rejects an invalid locale: %s', (_name, value, entry) => {
    const error = expectSyncBundleFetchError(
      () => parseBundleManifest({ version: 'v1', entries: [entry] }),
      'schema_invalid',
    );

    expect(error.detail).toContain('manifest.entries[0].locale');
    expect(error.detail).toContain(stringifyForDetail(value));
  });

  it('wraps throwing template property access as schema_invalid', () => {
    const error = expectSyncBundleFetchError(
      () => parseBundleManifest({
        version: 'v1',
        entries: [{
          get template(): never {
            throw new Error('template getter exploded');
          },
          locale: 'en',
        }],
      }),
      'schema_invalid',
    );

    expect(error.detail).toContain('property access threw');
    expect(error.detail).toContain('template getter exploded');
  });

  it('wraps throwing locale property access as schema_invalid', () => {
    const error = expectSyncBundleFetchError(
      () => parseBundleManifest({
        version: 'v1',
        entries: [{
          template: {},
          get locale(): never {
            throw new Error('locale getter exploded');
          },
        }],
      }),
      'schema_invalid',
    );

    expect(error.detail).toContain('property access threw');
    expect(error.detail).toContain('locale getter exploded');
  });

  it('throws on the first bad entry without processing later entries', () => {
    const error = expectSyncBundleFetchError(
      () => parseBundleManifest({
        version: 'v1',
        entries: [
          { template: 'not an object', locale: 'en' },
          {
            get template(): never {
              throw new Error('second entry was processed');
            },
            locale: 'en',
          },
        ],
      }),
      'schema_invalid',
    );

    expect(error.detail).toContain('manifest.entries[0].template');
    expect(error.detail).not.toContain('second entry was processed');
  });

  it('does not deep-validate template shape', () => {
    const template = { random: true };

    const manifest = parseBundleManifest({
      version: 'v1',
      entries: [{ template, locale: 'en' }],
    });

    expect(requireFirst(manifest.entries).template).toBe(template);
  });

  it('accepts an empty entries array', () => {
    expect(parseBundleManifest({ version: 'v1', entries: [] })).toEqual({
      version: 'v1',
      entries: [],
    });
  });
});

describe('D-164 P4g-2 createHttpBundleFetcher', () => {
  it('constructs for an HTTPS manifest URL', () => {
    expect(() => createHttpBundleFetcher({
      url: 'https://example.com/manifest.json',
      httpClient: vi.fn<HttpClient>(),
    })).not.toThrow();
  });

  it('rejects an HTTP manifest URL', () => {
    const error = expectSyncBundleFetchError(
      () => createHttpBundleFetcher({
        url: 'http://example.com/manifest.json',
        httpClient: vi.fn<HttpClient>(),
      }),
      'network_error',
    );

    expect(error.detail).toContain('"http:"');
  });

  it('rejects a file manifest URL', () => {
    const error = expectSyncBundleFetchError(
      () => createHttpBundleFetcher({
        url: 'file:///etc/passwd',
        httpClient: vi.fn<HttpClient>(),
      }),
      'network_error',
    );

    expect(error.detail).toContain('"file:"');
  });

  it('rejects an invalid manifest URL with the original input', () => {
    const input = 'not-a-url';

    const error = expectSyncBundleFetchError(
      () => createHttpBundleFetcher({
        url: input,
        httpClient: vi.fn<HttpClient>(),
      }),
      'network_error',
    );

    expect(error.detail).toContain(JSON.stringify(input));
    expect(error.detail).toContain('Invalid URL');
  });

  it('canonicalizes the URL before issuing GET', async () => {
    const input = 'https://example.com/a/../manifest.json?space=a b';
    const httpClient = vi.fn<HttpClient>()
      .mockResolvedValue(makeResponse(makeManifest([], 'v1')));
    const fetcher = createHttpBundleFetcher({ url: input, httpClient });

    await fetcher.fetchManifest();

    expect(httpClient).toHaveBeenCalledWith(new URL(input).href);
  });

  it('uses an injected httpClient and returns its parsed manifest', async () => {
    const entry = makeBundleEntry({
      body: 'Name {{contact.name}}',
      slot_grammar: ['entity.name'],
    });
    const raw = makeManifest([entry], 'v1');
    const httpClient = vi.fn<HttpClient>().mockResolvedValue(makeResponse(raw));
    const fetcher = createHttpBundleFetcher({
      url: 'https://example.com/manifest.json',
      httpClient,
    });

    await expect(fetcher.fetchManifest()).resolves.toEqual(raw);
    expect(httpClient).toHaveBeenCalledTimes(1);
  });

  it('throws when no httpClient or global fetch is available', () => {
    vi.stubGlobal('fetch', undefined);

    const error = expectSyncBundleFetchError(
      () => createHttpBundleFetcher({ url: 'https://example.com/manifest.json' }),
      'network_error',
    );

    expect(error.detail).toContain('no fetch implementation available');
  });

  it('wraps Error rejections as network_error with the URL and message', async () => {
    const url = 'https://example.com/manifest.json';
    const httpClient = vi.fn<HttpClient>()
      .mockRejectedValue(new Error('socket reset'));
    const fetcher = createHttpBundleFetcher({ url, httpClient });

    const error = await expectAsyncBundleFetchError(
      () => fetcher.fetchManifest(),
      'network_error',
    );

    expect(error.detail).toContain(`GET ${JSON.stringify(url)}`);
    expect(error.detail).toContain('socket reset');
  });

  it('wraps non-Error rejections as network_error', async () => {
    const httpClient = vi.fn<HttpClient>().mockRejectedValue('offline');
    const fetcher = createHttpBundleFetcher({
      url: 'https://example.com/manifest.json',
      httpClient,
    });

    const error = await expectAsyncBundleFetchError(
      () => fetcher.fetchManifest(),
      'network_error',
    );

    expect(error.detail).toContain('offline');
  });

  it('throws http_error for a 404 response', async () => {
    const httpClient = vi.fn<HttpClient>().mockResolvedValue(makeResponse(
      { nope: true },
      { ok: false, status: 404, statusText: 'Not Found' },
    ));
    const fetcher = createHttpBundleFetcher({
      url: 'https://example.com/manifest.json',
      httpClient,
    });

    const error = await expectAsyncBundleFetchError(
      () => fetcher.fetchManifest(),
      'http_error',
    );

    expect(error.status).toBe(404);
    expect(error.detail).toContain('404');
    expect(error.detail).toContain(JSON.stringify('Not Found'));
  });

  it('throws http_error for a 500 response', async () => {
    const httpClient = vi.fn<HttpClient>().mockResolvedValue(makeResponse(
      { nope: true },
      { ok: false, status: 500, statusText: 'Internal Server Error' },
    ));
    const fetcher = createHttpBundleFetcher({
      url: 'https://example.com/manifest.json',
      httpClient,
    });

    const error = await expectAsyncBundleFetchError(
      () => fetcher.fetchManifest(),
      'http_error',
    );

    expect(error.status).toBe(500);
    expect(error.detail).toContain('500');
    expect(error.detail).toContain(JSON.stringify('Internal Server Error'));
  });

  it('wraps response JSON failures as parse_error', async () => {
    const httpClient = vi.fn<HttpClient>()
      .mockResolvedValue(makeRejectingJsonResponse(new SyntaxError('bad json')));
    const fetcher = createHttpBundleFetcher({
      url: 'https://example.com/manifest.json',
      httpClient,
    });

    const error = await expectAsyncBundleFetchError(
      () => fetcher.fetchManifest(),
      'parse_error',
    );

    expect(error.detail).toContain('manifest body is not valid JSON');
    expect(error.detail).toContain('bad json');
  });

  it('bubbles schema_invalid from parsed JSON validation', async () => {
    const httpClient = vi.fn<HttpClient>()
      .mockResolvedValue(makeResponse({ version: 'v1' }));
    const fetcher = createHttpBundleFetcher({
      url: 'https://example.com/manifest.json',
      httpClient,
    });

    const error = await expectAsyncBundleFetchError(
      () => fetcher.fetchManifest(),
      'schema_invalid',
    );

    expect(error.detail).toContain('manifest.entries');
  });

  it('is stateless and issues a fresh GET on each fetchManifest call', async () => {
    const httpClient = vi.fn<HttpClient>()
      .mockResolvedValue(makeResponse(makeManifest([], 'v1')));
    const fetcher = createHttpBundleFetcher({
      url: 'https://example.com/manifest.json',
      httpClient,
    });

    await fetcher.fetchManifest();
    await fetcher.fetchManifest();

    expect(httpClient).toHaveBeenCalledTimes(2);
  });

  it('escapes statusText in http_error details', async () => {
    const statusText = 'Not Found\n  [99] forged';
    const httpClient = vi.fn<HttpClient>().mockResolvedValue(makeResponse(
      { nope: true },
      { ok: false, status: 404, statusText },
    ));
    const fetcher = createHttpBundleFetcher({
      url: 'https://example.com/manifest.json',
      httpClient,
    });

    const error = await expectAsyncBundleFetchError(
      () => fetcher.fetchManifest(),
      'http_error',
    );

    expect(error.detail).not.toContain('\n');
    expect(error.detail).toContain(JSON.stringify(statusText));
  });
});

describe('D-164 P4g-2 loadBundlePool', () => {
  it('loads a valid manifest into a bundle TemplatePool', async () => {
    const entry = makeBundleEntry({
      body: 'Email {{contact.email}}',
      slot_grammar: ['entity.email'],
    });
    const fetchManifest = vi.fn(async () => makeManifest([entry], 'v1'));
    const fetcher: BundleFetcher = { fetchManifest };

    const pool = await loadBundlePool({ fetcher });

    expect(fetchManifest).toHaveBeenCalledTimes(1);
    expect(pool.name).toBe('bundle');
    expect(pool.list()).toEqual([entry]);
  });

  it('rethrows a BundleFetchError from the fetcher unchanged', async () => {
    const fetchError = new BundleFetchError({
      reason: 'network_error',
      detail: 'offline',
    });
    const fetcher: BundleFetcher = {
      fetchManifest: vi.fn(async () => {
        throw fetchError;
      }),
    };

    await expect(loadBundlePool({ fetcher })).rejects.toBe(fetchError);
  });

  it('throws BundlePoolError when fetched entries fail deep validation', async () => {
    const entry = makeBundleEntry({
      body: 'Email {{contact.email}}',
      slot_grammar: ['entity.email'],
      template_hash: 'bad-hash',
    });
    const fetcher: BundleFetcher = {
      fetchManifest: vi.fn(async () => makeManifest([entry], 'v1')),
    };

    try {
      await loadBundlePool({ fetcher });
    } catch (err) {
      expect(err).toBeInstanceOf(BundlePoolError);
      expect(err).not.toBeInstanceOf(BundleFetchError);
      const error = err as BundlePoolError;
      expect(error.failures).toMatchObject([{
        index: 0,
        reason: 'hash_mismatch',
      }]);
      return;
    }
    throw new Error('expected BundlePoolError');
  });

  it('preserves bundle pool deep-freeze behavior', async () => {
    const fetcher: BundleFetcher = {
      fetchManifest: vi.fn(async () => makeManifest([
        makeBundleEntry({
          body: 'Email {{contact.email}}',
          slot_grammar: ['entity.email'],
        }),
      ], 'v1')),
    };

    const pool = await loadBundlePool({ fetcher });
    const list = pool.list();
    const first = requireFirst(list);

    expect(Object.isFrozen(list)).toBe(true);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.template)).toBe(true);
    expect(Object.isFrozen(first.template.slot_grammar)).toBe(true);
  });

  it('supports an end-to-end gate short-circuit from a fetched bundle', async () => {
    const fetchManifest = vi.fn(async () => makeManifest([
      makeBundleEntry({
        body: 'Alice email is {{contact.email}}',
        slot_grammar: ['entity.email'],
      }),
    ], 'v1'));
    const pool = await loadBundlePool({ fetcher: { fetchManifest } });
    const library = createTemplateLibrary({ pools: [pool] });
    const snapshot: DataSnapshot = Object.freeze({
      data: Object.freeze({
        contact: Object.freeze({
          email: 'alice@example.com',
        }),
      }),
    });
    const probeData = vi.fn<DataPresenceProbe>(() => snapshot);
    const deps: GateDeps = {
      matchTemplate: (query) => library.match(query),
      probeData,
      renderTemplate: createTemplateRenderer(),
    };
    const { ctx, resolve } = makeTurnContext([
      makeSessionEntry('user', 'email alice@example.com', 1),
    ]);

    await expect(runGate(ctx, deps)).resolves.toEqual({
      kind: 'short-circuit',
      text: 'Alice email is alice@example.com',
    });
    expect(fetchManifest).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith('Alice email is alice@example.com');
    expect(probeData).toHaveBeenCalledWith({
      template: requireFirst(pool.list()).template,
      slots: [makeSlot('entity.email', 'alice@example.com', 6)],
      locale: 'en',
    });
  });

  it('loads an empty manifest as an empty bundle pool', async () => {
    const fetcher: BundleFetcher = {
      fetchManifest: vi.fn(async () => makeManifest([], 'empty')),
    };

    const pool = await loadBundlePool({ fetcher });

    expect(pool.name).toBe('bundle');
    expect(pool.list()).toEqual([]);
  });
});

describe('D-164 P4g-2 BundleFetchError', () => {
  it('uses the stable BundleFetchError name', () => {
    const error = new BundleFetchError({
      reason: 'network_error',
      detail: 'offline',
    });

    expect(error.name).toBe('BundleFetchError');
  });

  it('includes the reason and detail in its message', () => {
    const error = new BundleFetchError({
      reason: 'parse_error',
      detail: 'bad json',
    });

    expect(error.message).toContain('parse_error');
    expect(error.message).toContain('bad json');
  });

  it('only carries status for http_error instances', () => {
    const networkError = new BundleFetchError({
      reason: 'network_error',
      detail: 'offline',
    });
    const httpError = new BundleFetchError({
      reason: 'http_error',
      detail: 'GET failed',
      status: 503,
    });

    expect(networkError.status).toBeUndefined();
    expect(Object.hasOwn(networkError, 'status')).toBe(false);
    expect(httpError.status).toBe(503);
    expect(Object.hasOwn(httpError, 'status')).toBe(true);
  });
});
