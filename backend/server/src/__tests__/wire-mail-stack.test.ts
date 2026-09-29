import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

// `vi.mock` is hoisted; keep the mocked exports as `vi.fn`s so the
// composer's static named imports close over inspectable functions.
const mailMocks = vi.hoisted(() => {
  const stack = { tag: 'mail-stack' };
  return {
    stack,
    composeMailStack: vi.fn(() => stack),
    deriveContactsFromMail: vi.fn(() => []),
  };
});

vi.mock('../collections/mail/compose.js', () => ({
  composeMailStack: mailMocks.composeMailStack,
}));
vi.mock('../warehouse/contact-derive.js', () => ({
  deriveContactsFromMail: mailMocks.deriveContactsFromMail,
}));

import Database from 'better-sqlite3';
import type { StorageGate } from '@recued/storage-gate';
import type { ServerAccountStore } from '../account-store.js';
import type { GateRegistry } from '../storage-gates.js';
import type { ContactStore } from '../storage/contact-store.js';
import type { CanonicalMessage } from '../collections/mail/provider.js';
import type { MailUpsertContext } from '../collections/mail/mail-collection.js';
import { createMailFactStore, type MailFactStore } from '../storage/mail-fact-store.js';
import { createMailFactWriter } from '../mail-facts/fact-writer.js';
import type {
  ComposeMailStackOptions,
  MailAdapterBundle,
  MailStack,
  MailStackStorageDeps,
} from '../collections/mail/compose.js';
import { composeMailStack } from '../collections/mail/compose.js';
import { deriveContactsFromMail } from '../warehouse/contact-derive.js';
import {
  composeMailBoot,
  type ComposeMailStackBootDeps,
} from '../composition/bin/wire-mail-stack.js';

type ComposeCall = [
  Database.Database,
  MailStackStorageDeps,
  MailAdapterBundle,
  ComposeMailStackOptions,
];

type TestGateRegistry = GateRegistry & {
  get: ReturnType<typeof vi.fn>;
  register: ReturnType<typeof vi.fn>;
};

type TestAccountStore = ServerAccountStore & {
  get: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
  getAll: ReturnType<typeof vi.fn>;
  clear: ReturnType<typeof vi.fn>;
  totalBytes: ReturnType<typeof vi.fn>;
};

type TestContactStore = ContactStore & {
  observeBatch: ReturnType<typeof vi.fn>;
};

const sentinelStack = mailMocks.stack as unknown as MailStack;

const resetMailMocks = (): void => {
  vi.mocked(composeMailStack).mockReset();
  vi.mocked(composeMailStack).mockImplementation(() => sentinelStack);
  vi.mocked(deriveContactsFromMail).mockReset();
  vi.mocked(deriveContactsFromMail).mockReturnValue([]);
};

resetMailMocks();

afterEach(() => {
  try {
    vi.restoreAllMocks();
  } finally {
    resetMailMocks();
  }
});

const db = (): Database.Database =>
  ({ tag: 'db' }) as unknown as Database.Database;

const cacheBlobs = (): NonNullable<ComposeMailStackBootDeps['cacheBlobs']> =>
  ({
    put: vi.fn(),
    get: vi.fn(),
    delete: vi.fn(),
  }) as unknown as NonNullable<ComposeMailStackBootDeps['cacheBlobs']>;

const warehouseBus = (): ComposeMailStackBootDeps['warehouseBus'] =>
  ({ emit: vi.fn() }) as unknown as ComposeMailStackBootDeps['warehouseBus'];

const oauthConfig = (
  provider: 'gmail' | 'graph',
  clientId = `${provider}-client`,
) => ({
  tokenUrl: `https://${provider}.test/token`,
  clientId,
  clientSecret: `${provider}-secret`,
});

const makeGateRegistry = (
  options: {
    existing?: StorageGate;
    registered?: StorageGate;
  } = {},
): TestGateRegistry =>
  ({
    get: vi.fn(() => options.existing),
    register: vi.fn(() =>
      options.registered ?? ({ tag: 'registered-gate' } as unknown as StorageGate),
    ),
  }) as unknown as TestGateRegistry;

const makeAccountStore = (
  entries: Record<string, string> = {},
): TestAccountStore => ({
  get: vi.fn(async (key: string) => entries[key] ?? null),
  set: vi.fn(async (key: string, value: string) => {
    entries[key] = value;
  }),
  delete: vi.fn(async (key: string) => {
    delete entries[key];
  }),
  getAll: vi.fn(async () => ({ ...entries })),
  clear: vi.fn(async () => {
    for (const key of Object.keys(entries)) delete entries[key];
  }),
  totalBytes: vi.fn(async () => 0),
});

const makeContactStore = (
  networkDomains: Record<string, string[]> = {},
): TestContactStore =>
  ({
    observeBatch: vi.fn(() => 0),
    get: vi.fn((email: string) =>
      email in networkDomains ? { network_domain: networkDomains[email] } : null),
  }) as unknown as TestContactStore;

const buildDeps = (
  overrides: Partial<ComposeMailStackBootDeps> = {},
): ComposeMailStackBootDeps => ({
  db: db(),
  cacheBlobs: cacheBlobs(),
  warehouseBus: warehouseBus(),
  gateRegistry: makeGateRegistry(),
  resolveOAuthConfig: (provider) => oauthConfig(provider),
  ...overrides,
});

const lastComposeCall = (): ComposeCall => {
  const call = vi.mocked(composeMailStack).mock.calls.at(-1);
  if (!call) throw new Error('composeMailStack was not called');
  return call as ComposeCall;
};

const message = (): CanonicalMessage => ({
  source_id: 'msg-1',
  from: 'Ada Lovelace <ada@example.com>',
  to: ['Grace Hopper <grace@example.com>'],
  cc: [],
  subject: 'Planning',
  thread_id: 'thread-1',
  folder_or_label: 'INBOX',
  is_read: false,
  is_flagged: false,
  has_attachments: false,
  received_at: 1_700_000_000_000,
  body_text: 'Hello',
});

const upsertCtx = (over: Partial<MailUpsertContext> = {}): MailUpsertContext => ({
  slug: 'work',
  record_id: 'mail:1',
  account_email: 'me@owner.example',
  first_seen: true,
  backfill_complete: true,
  backfill_days: 30,
  attachments: [],
  ...over,
});

describe('composeMailBoot', () => {
  it('returns undefined and skips composeMailStack when db is undefined', () => {
    const stack = composeMailBoot(buildDeps({ db: undefined }));

    expect(stack).toBeUndefined();
    expect(composeMailStack).not.toHaveBeenCalled();
  });

  it('returns undefined and skips composeMailStack when cacheBlobs is undefined', () => {
    const stack = composeMailBoot(buildDeps({ cacheBlobs: undefined }));

    expect(stack).toBeUndefined();
    expect(composeMailStack).not.toHaveBeenCalled();
  });

  it('returns the composeMailStack result and passes db, storage, bundle, and options', () => {
    const deps = buildDeps();

    const stack = composeMailBoot(deps);

    expect(stack).toBe(sentinelStack);
    expect(composeMailStack).toHaveBeenCalledTimes(1);
    expect(vi.mocked(composeMailStack).mock.calls[0]).toHaveLength(4);
    const [dbArg, storage, bundle, options] = lastComposeCall();
    expect(dbArg).toBe(deps.db);
    expect(storage.blobs).toBe(deps.cacheBlobs);
    expect(storage.bus).toBe(deps.warehouseBus);
    expect(storage.getGate).toEqual(expect.any(Function));
    expect(bundle.oauthConfig).toEqual(expect.any(Function));
    expect(options.log).toEqual(expect.any(Function));
  });

  it('forwards isVaultUnlocked into the mail stack bundle (poll-loop vault gate)', () => {
    const predicate = () => false;

    composeMailBoot(buildDeps({ isVaultUnlocked: predicate }));

    const [, , bundle] = lastComposeCall();
    expect(bundle.isVaultUnlocked).toBe(predicate);
  });

  /** ⛔⛔ REGRESSION PIN — this field rode in the WRONG ARGUMENT for as long as
   *  it existed. `runStartLive` reads `bundle.getCollectionRegistry?.()`, but
   *  the wiring spread it into `storage`, so the getter was always undefined,
   *  `?.()` swallowed it, and a mail account enrolled at RUNTIME never joined the
   *  shared registry — every send answered MAIL_INSTANCE_NOT_FOUND until the
   *  server was restarted.
   *
   *  ⛔⛔ THE COMPILER COULD NOT HELP: `...(x ? { x } : {})` is a SPREAD, and
   *  spreads are exempt from the excess-property check. Written plainly as
   *  `getCollectionRegistry,` it is a TS2353 error. Verified both ways.
   *
   *  ⛔⛔ NEITHER COULD THE OTHER TESTS. `registry-lifecycle-on-enroll.test.ts`
   *  hand-builds its own `composeMailStack` call and puts the getter in the
   *  correct third argument — so it proved the COMPONENT honours the getter
   *  while production never DELIVERED it. And this file asserts arg placement
   *  field-by-field, which is blind to whichever field nobody listed.
   *  ⇒ assert the SIDE it lands on, not merely that it was forwarded. */
  it('⛔ puts getCollectionRegistry on the BUNDLE, not storage — runStartLive reads it there', () => {
    const registry = {} as never;
    const getCollectionRegistry = () => registry;

    composeMailBoot(buildDeps({ getCollectionRegistry }));

    const [, storage, bundle] = lastComposeCall();
    expect(bundle.getCollectionRegistry).toBe(getCollectionRegistry);
    // The half that actually failed: present, but on the object nobody reads.
    expect(Object.hasOwn(storage, 'getCollectionRegistry')).toBe(false);
  });

  it('omits getCollectionRegistry from the bundle when not passed', () => {
    composeMailBoot(buildDeps());

    const [, , bundle] = lastComposeCall();
    expect(Object.hasOwn(bundle, 'getCollectionRegistry')).toBe(false);
  });

  it('omits isVaultUnlocked from the bundle when not passed', () => {
    composeMailBoot(buildDeps());

    const [, , bundle] = lastComposeCall();
    expect(Object.hasOwn(bundle, 'isVaultUnlocked')).toBe(false);
  });

  it('omits auditLog from storage when auditLog is not passed', () => {
    composeMailBoot(buildDeps());

    const [, storage] = lastComposeCall();
    expect(Object.hasOwn(storage, 'auditLog')).toBe(false);
  });

  it('threads auditLog through storage when auditLog is passed', () => {
    const auditLog = { emit: vi.fn() } as unknown as ComposeMailStackBootDeps['auditLog'];

    composeMailBoot(buildDeps({ auditLog }));

    const [, storage] = lastComposeCall();
    expect(storage.auditLog).toBe(auditLog);
  });

  it('omits onMessageUpserted from storage when contactStore is not passed', () => {
    composeMailBoot(buildDeps());

    const [, storage] = lastComposeCall();
    expect(Object.hasOwn(storage, 'onMessageUpserted')).toBe(false);
  });

  it('wires onMessageUpserted to derive and observe non-empty contact observations', () => {
    const contactStore = makeContactStore();
    const observations = [
      {
        email: 'ada@example.com',
        source: 'email_from',
        event_at: 1_700_000_000_000,
      },
    ] as ReturnType<typeof deriveContactsFromMail>;
    vi.mocked(deriveContactsFromMail).mockReturnValueOnce(observations);

    composeMailBoot(buildDeps({ contactStore }));
    const [, storage] = lastComposeCall();
    const msg = message();
    storage.onMessageUpserted?.(msg, upsertCtx());

    expect(deriveContactsFromMail).toHaveBeenCalledTimes(1);
    expect(deriveContactsFromMail).toHaveBeenCalledWith(msg);
    expect(contactStore.observeBatch).toHaveBeenCalledTimes(1);
    expect(contactStore.observeBatch).toHaveBeenCalledWith(observations);
  });

  it('does not observe contacts when derivation returns no observations', () => {
    const contactStore = makeContactStore();
    vi.mocked(deriveContactsFromMail).mockReturnValueOnce([]);

    composeMailBoot(buildDeps({ contactStore }));
    const [, storage] = lastComposeCall();
    storage.onMessageUpserted?.(message(), upsertCtx());

    expect(contactStore.observeBatch).not.toHaveBeenCalled();
  });

  it('registers and returns a mail storage gate when one is missing', () => {
    const registeredGate = { tag: 'registered' } as unknown as StorageGate;
    const gateRegistry = makeGateRegistry({ registered: registeredGate });

    composeMailBoot(buildDeps({ gateRegistry }));
    const [, storage] = lastComposeCall();
    const gate = storage.getGate('work');

    expect(gateRegistry.get).toHaveBeenCalledWith('collection:mail:work');
    expect(gateRegistry.register).toHaveBeenCalledTimes(1);
    expect(gateRegistry.register).toHaveBeenCalledWith(
      'collection:mail:work',
      {
        quota: 512 * 1024 * 1024,
        reservePct: 10,
        initialUsage: 0,
      },
    );
    expect(gate).toBe(registeredGate);
  });

  it('returns an existing mail storage gate without registering', () => {
    const existingGate = { tag: 'existing' } as unknown as StorageGate;
    const gateRegistry = makeGateRegistry({ existing: existingGate });

    composeMailBoot(buildDeps({ gateRegistry }));
    const [, storage] = lastComposeCall();
    const gate = storage.getGate('work');

    expect(gate).toBe(existingGate);
    expect(gateRegistry.register).not.toHaveBeenCalled();
  });

  it('throws from getGate when gateRegistry is unavailable', () => {
    composeMailBoot(buildDeps({ gateRegistry: undefined }));
    const [, storage] = lastComposeCall();

    expect(() => storage.getGate('work')).toThrow(
      'mailStack: gateRegistry not available',
    );
  });

  it('omits bundle accountStore when accountStore is undefined', () => {
    composeMailBoot(buildDeps({ accountStore: undefined }));

    const [, , bundle] = lastComposeCall();
    expect(Object.hasOwn(bundle, 'accountStore')).toBe(false);
  });

  it('adds bundle accountStore as a fresh double that delegates to the real accountStore', async () => {
    const accountStore = makeAccountStore({ k: 'real' });

    composeMailBoot(buildDeps({ accountStore }));

    const [, , bundle] = lastComposeCall();
    const accountStoreDouble = bundle.accountStore;
    expect(accountStoreDouble).toBeDefined();
    expect(accountStoreDouble).not.toBe(accountStore);
    if (!accountStoreDouble) throw new Error('bundle.accountStore was not wired');
    await expect(accountStoreDouble.get('k')).resolves.toBe('real');
    await expect(accountStoreDouble.getAll?.()).resolves.toEqual({ k: 'real' });
    expect(accountStore.get).toHaveBeenCalledTimes(1);
    expect(accountStore.get).toHaveBeenCalledWith('k');
    expect(accountStore.getAll).toHaveBeenCalledTimes(1);
  });

  it('bundle oauthConfig delegates to the injected per-use resolver', () => {
    composeMailBoot(buildDeps());
    let [, , bundle] = lastComposeCall();
    expect(bundle.oauthConfig?.('gmail')).toMatchObject({ clientId: 'gmail-client' });
    expect(bundle.oauthConfig?.('graph')).toMatchObject({ clientId: 'graph-client' });

    // A resolver returning null (not configured) surfaces as null.
    resetMailMocks();
    composeMailBoot(buildDeps({ resolveOAuthConfig: () => null }));
    [, , bundle] = lastComposeCall();
    expect(bundle.oauthConfig?.('gmail')).toBeNull();
    expect(bundle.oauthConfig?.('graph')).toBeNull();
  });

  it('passes a log option that routes error to console.error and info to console.log', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    composeMailBoot(buildDeps());
    const [, , , options] = lastComposeCall();
    options.log?.('error', 'boom', { x: 1 });
    options.log?.('info', 'hi', undefined);

    expect(errorSpy).toHaveBeenCalledWith('[mail-stack] boom', { x: 1 });
    expect(logSpy).toHaveBeenCalledWith('[mail-stack] hi', '');
  });
});

describe('composeMailBoot — mail facts (D-315)', () => {
  let factDb: Database.Database | undefined;
  afterEach(() => {
    factDb?.close();
    factDb = undefined;
  });

  /** The composition's writer over a store, emitting on `bus`. */
  const writerOver = (store: MailFactStore, bus: ComposeMailStackBootDeps['warehouseBus']) =>
    createMailFactWriter({ store, emit: (event) => bus.emit(event), now: () => Date.now() });

  const factStore = (): MailFactStore => {
    factDb = new Database(':memory:');
    const store = createMailFactStore(factDb);
    store.createTemplate({
      definition: {
        name: 'UPS',
        type: 'shipment',
        entrance: {
          conditions: [{ field: 'from', op: 'domain_is', value: 'ups.com' }],
          variables: ['tracking_number'],
        },
        rules: [
          { target: { variable: 'carrier' }, source: 'from_name', find: { kind: 'constant', value: 'UPS' } },
          {
            target: { variable: 'tracking_number' },
            source: 'body',
            find: { kind: 'after_label', label: 'Tracking Number:' },
          },
        ],
        html: false,
        ai: { enabled: false },
      },
      origin: { kind: 'owner' },
    });
    return store;
  };

  const upsMessage = (over: Partial<CanonicalMessage> = {}): CanonicalMessage => ({
    ...message(),
    from: 'pkginfo@ups.com',
    from_name: 'UPS',
    subject: 'UPS Update: On the way',
    body_text: 'Tracking Number: 1Z0000000000000001\n',
    received_at: Date.now(),
    ...over,
  });

  it('wires no fact hooks without a fact store', () => {
    composeMailBoot(buildDeps());
    const [, storage] = lastComposeCall();
    expect(Object.hasOwn(storage, 'onRecordsRemoved')).toBe(false);
    expect(Object.hasOwn(storage, 'onRecordRekeyed')).toBe(false);
  });

  it('reads a new message for facts and emits the thing on the warehouse bus', () => {
    const mailFactStore = factStore();
    const bus = warehouseBus();
    composeMailBoot(buildDeps({ mailFactWriter: writerOver(mailFactStore, bus), warehouseBus: bus }));
    const [, storage] = lastComposeCall();

    storage.onMessageUpserted?.(upsMessage(), upsertCtx());

    expect(mailFactStore.listFacts()).toHaveLength(1);
    expect(vi.mocked(bus.emit)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(bus.emit).mock.calls[0]?.[0]).toMatchObject({
      platform: 'mail_fact',
      slug: 'shipment',
      event_kind: 'created',
    });
  });

  it('stores past mail silently: a first backfill, or a date outside the window', () => {
    const mailFactStore = factStore();
    const bus = warehouseBus();
    composeMailBoot(buildDeps({ mailFactWriter: writerOver(mailFactStore, bus), warehouseBus: bus }));
    const [, storage] = lastComposeCall();

    storage.onMessageUpserted?.(upsMessage(), upsertCtx({ record_id: 'mail:1', backfill_complete: false }));
    storage.onMessageUpserted?.(
      upsMessage({ body_text: 'Tracking Number: 1Z0000000000000002\n', received_at: Date.now() - 90 * 86_400_000 }),
      upsertCtx({ record_id: 'mail:2' }),
    );

    expect(mailFactStore.listFacts()).toHaveLength(2);
    expect(vi.mocked(bus.emit)).not.toHaveBeenCalled();
  });

  it('skips mail Recued itself sent, and drafts', () => {
    const mailFactStore = factStore();
    composeMailBoot(buildDeps({ mailFactWriter: writerOver(mailFactStore, warehouseBus()) }));
    const [, storage] = lastComposeCall();

    storage.onMessageUpserted?.(upsMessage({ reconciliation_id: 'rcd_0123456789abcdef' }), upsertCtx());
    storage.onMessageUpserted?.(upsMessage({ direction: 'draft' }), upsertCtx({ record_id: 'mail:2' }));

    expect(mailFactStore.listFacts()).toEqual([]);
  });

  it('takes a message’s facts along when it is removed or moved', () => {
    const mailFactStore = factStore();
    composeMailBoot(buildDeps({ mailFactWriter: writerOver(mailFactStore, warehouseBus()) }));
    const [, storage] = lastComposeCall();
    storage.onMessageUpserted?.(upsMessage(), upsertCtx({ record_id: 'mail:1' }));

    storage.onRecordRekeyed?.('work', 'mail:1', 'mail:9');
    expect(mailFactStore.factsForEmail({ slug: 'work', record_id: 'mail:9' })).toHaveLength(1);

    storage.onRecordsRemoved?.('work', ['mail:9']);
    expect(mailFactStore.listFacts()).toEqual([]);
    expect(mailFactStore.listThings()).toEqual([]);
  });

  it('reads the sender’s relationships from the contact store', () => {
    const mailFactStore = factStore();
    mailFactStore.createTemplate({
      definition: {
        name: 'Work requests',
        type: 'owner_request',
        entrance: { conditions: [{ field: 'relationship', op: 'is', value: 'work' }], variables: [] },
        rules: [],
        html: false,
        ai: { enabled: false },
      },
      origin: { kind: 'owner' },
    });
    const contactStore = makeContactStore({ 'pkginfo@ups.com': ['work'] });
    composeMailBoot(buildDeps({ mailFactWriter: writerOver(mailFactStore, warehouseBus()), contactStore }));
    const [, storage] = lastComposeCall();

    storage.onMessageUpserted?.(upsMessage(), upsertCtx());

    expect(mailFactStore.listFacts().map((fact) => fact.type).sort()).toEqual(['owner_request', 'shipment']);
  });

  it('still reads a message for facts when the contact hook throws, then reports the error', () => {
    const mailFactStore = factStore();
    const contactStore = makeContactStore();
    vi.mocked(deriveContactsFromMail).mockImplementationOnce(() => {
      throw new Error('contact store locked');
    });
    composeMailBoot(buildDeps({ mailFactWriter: writerOver(mailFactStore, warehouseBus()), contactStore }));
    const [, storage] = lastComposeCall();

    expect(() => storage.onMessageUpserted?.(upsMessage(), upsertCtx())).toThrow('contact store locked');
    expect(mailFactStore.listFacts()).toHaveLength(1);
  });
});
