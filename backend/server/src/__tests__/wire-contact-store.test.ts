import Database from 'better-sqlite3';
import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { createWarehouseEventBus } from '@recued/warehouse-events';

// `vi.mock` is hoisted; the factories below wrap each named export in
// a `vi.fn` that delegates to the real implementation. The composer's
// static `import { detectInlineMergeCandidates }` /
// `import { backfillContacts }` bindings then resolve to the wrapped
// functions, so per-test `mockImplementationOnce` / `mockRejectedValueOnce`
// overrides actually intercept the composer's call site. Without this,
// `vi.spyOn(namespace, name)` would replace the namespace property but
// miss the closed named-import binding the composer holds.
vi.mock('../storage/contact-store.js', async () => {
  const actual = await vi.importActual<
    typeof import('../storage/contact-store.js')
  >('../storage/contact-store.js');
  return {
    ...actual,
    detectInlineMergeCandidates: vi.fn(actual.detectInlineMergeCandidates),
  };
});
vi.mock('../warehouse/contact-backfill.js', async () => {
  const actual = await vi.importActual<
    typeof import('../warehouse/contact-backfill.js')
  >('../warehouse/contact-backfill.js');
  return {
    ...actual,
    backfillContacts: vi.fn(actual.backfillContacts),
  };
});

import type { EventBus } from '../events/bus.js';
import type { CascadeEngine } from '../storage/enrichment-cascade.js';
import { backfillContacts } from '../warehouse/contact-backfill.js';
import { detectInlineMergeCandidates } from '../storage/contact-store.js';
import { composeContactStore } from '../composition/bin/wire-contact-store.js';

type TestEventBus = EventBus & { emit: ReturnType<typeof vi.fn> };

const dbs: Database.Database[] = [];

const makeDb = (): Database.Database => {
  const db = new Database(':memory:');
  dbs.push(db);
  return db;
};

const eventBus = (
  emit: ReturnType<typeof vi.fn> = vi.fn((event: unknown) => ({
    ...(event as Record<string, unknown>),
    cursor: 1,
  })),
): TestEventBus => ({ emit }) as unknown as TestEventBus;

// `skipped` is part of BackfillResult: on a healthy second boot it equals
// `tables` while `processed` is 0, which is the progress assertion rather than
// a log line. A fixture missing it would type-error rather than silently drift.
const backfillResult = {
  mail: { tables: 0, processed: 0, observed: 0, skipped: 0 },
  calendar: { tables: 0, processed: 0, observed: 0, skipped: 0 },
};

const composeWithDb = (
  overrides: Partial<Parameters<typeof composeContactStore>[0]> = {},
) =>
  composeContactStore({
    db: makeDb(),
    warehouseBus: createWarehouseEventBus(),
    eventBus: eventBus(),
    ...overrides,
  });

const flushMicrotasks = async (): Promise<void> => {
  await Promise.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
};

const upsertMergeEligiblePair = (
  store: NonNullable<ReturnType<typeof composeContactStore>['contactStore']>,
): void => {
  store.upsertManual(
    {
      email: 'bob.smith.one@example.com',
      name: 'Bob Smith',
      phone: '+14155550100',
    },
    1_000,
  );
  store.upsertManual(
    {
      email: 'robert.smith.two@example.com',
      name: 'Robert Smith',
      phone: '+14155550100',
    },
    1_100,
  );
};

afterEach(() => {
  // Restore mocks first so a db.close() throw can't bleed module-level
  // spy state into the next test. `restoreAllMocks` also reinstates the
  // delegating impls registered by the top-level `vi.mock` factories.
  try {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  } finally {
    for (const db of dbs.splice(0)) {
      if (db.open) db.close();
    }
  }
});

describe('composeContactStore', () => {
  it('returns all undefined bundle fields when db is undefined', () => {
    const bundle = composeContactStore({
      db: undefined,
      warehouseBus: createWarehouseEventBus(),
      eventBus: eventBus(),
    });

    expect(bundle).toEqual({
      contactStore: undefined,
      remergePromptStore: undefined,
      contactMergeCycleObserver: undefined,
      upstreamMergeStore: undefined,
      backfillDone: undefined,
    });
  });

  it('populates all bundle fields when db is present', () => {
    const bundle = composeWithDb();

    expect(bundle.contactStore).toBeDefined();
    expect(bundle.remergePromptStore).toBeDefined();
    expect(bundle.contactMergeCycleObserver).toBeDefined();
    expect(bundle.upstreamMergeStore).toBeDefined();
    expect(bundle.backfillDone).toBeInstanceOf(Promise);
  });

  it('delete succeeds when enrichmentCascade is omitted', () => {
    // The composer's `onDelete` is conditionally spread — when
    // `enrichmentCascade` is absent the store is constructed WITHOUT
    // an `onDelete` callback at all. The honest assertion is that
    // `delete()` still returns `true`; we cannot directly observe a
    // not-wired callback because the store doesn't expose its option
    // set post-construction. Regression target: accidentally making
    // `enrichmentCascade` required.
    const bundle = composeWithDb();
    const email = 'no-cascade@example.com';

    bundle.contactStore?.upsertManual({ email, name: 'No Cascade' }, 1_000);
    expect(bundle.contactStore?.delete(email)).toBe(true);
  });

  it('wires onDelete when enrichmentCascade is passed', () => {
    const cascadeForSourceDelete = vi.fn();
    const cascade = {
      cascadeForSourceDelete,
    } as unknown as CascadeEngine;
    const bundle = composeWithDb({ enrichmentCascade: cascade });
    const email = 'cascade@example.com';

    bundle.contactStore?.upsertManual({ email, name: 'Cascade Contact' }, 1_000);
    expect(bundle.contactStore?.delete(email)).toBe(true);

    expect(cascadeForSourceDelete).toHaveBeenCalledTimes(1);
    expect(cascadeForSourceDelete).toHaveBeenCalledWith('contact', email);
  });

  it('does not emit a merge_candidate event for an upsert with no merge sibling', () => {
    const emit = vi.fn((event: unknown) => ({
      ...(event as Record<string, unknown>),
      cursor: 1,
    }));
    const bundle = composeWithDb({ eventBus: eventBus(emit) });

    bundle.contactStore?.upsertManual(
      {
        email: 'solo@example.com',
        name: 'Solo Person',
        phone: '+14155550101',
      },
      1_000,
    );

    expect(emit).not.toHaveBeenCalledWith(expect.objectContaining({
      kind: 'merge_candidate',
    }));
  });

  it('emits merge_candidate inserted for an inline merge candidate', () => {
    const emit = vi.fn((event: unknown) => ({
      ...(event as Record<string, unknown>),
      cursor: 1,
    }));
    const bundle = composeWithDb({ eventBus: eventBus(emit) });

    upsertMergeEligiblePair(bundle.contactStore!);

    expect(emit).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'merge_candidate',
      subkind: 'inserted',
      candidate_id: expect.any(String),
      pair_key: 'bob.smith.one@example.com|robert.smith.two@example.com',
    }));
  });

  it('swallows detectInlineMergeCandidates errors from onContactUpserted', () => {
    const detectMock = vi.mocked(detectInlineMergeCandidates);
    detectMock.mockImplementationOnce(() => {
      throw new Error('detector failed');
    });
    const bundle = composeWithDb();

    expect(() =>
      bundle.contactStore?.upsertManual(
        {
          email: 'detector-error@example.com',
          name: 'Detector Error',
        },
        1_000,
      ),
    ).not.toThrow();
    expect(detectMock).toHaveBeenCalledTimes(1);
  });

  it('swallows eventBus.emit errors after an inline merge-candidate emit attempt', () => {
    const emit = vi.fn(() => {
      throw new Error('bus failed');
    });
    const bundle = composeWithDb({ eventBus: eventBus(emit) });

    expect(() => upsertMergeEligiblePair(bundle.contactStore!)).not.toThrow();
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'merge_candidate',
      subkind: 'inserted',
      candidate_id: expect.any(String),
      pair_key: 'bob.smith.one@example.com|robert.smith.two@example.com',
    }));
  });

  it('does not buffer platform-link changes outside an active cycle', () => {
    const bundle = composeWithDb();
    const store = bundle.contactStore!;

    store.upsertManual({ email: 'outside-cycle@example.com', name: 'Outside Cycle' }, 1_000);
    store.linkPlatformId({
      canonical_email: 'outside-cycle@example.com',
      vendor: 'hubspot',
      platform_id: 'hs-outside',
      state: 'auto',
      linked_at: 1_100,
      linked_by: 'reconciler:hubspot',
    });

    expect(bundle.contactMergeCycleObserver?.pendingChangesSnapshot()).toEqual([]);
  });

  it('buffers platform-link changes inside an active cycle', () => {
    const bundle = composeWithDb();
    const store = bundle.contactStore!;

    store.upsertManual({ email: 'inside-cycle@example.com', name: 'Inside Cycle' }, 1_000);
    bundle.contactMergeCycleObserver?.beginCycle();
    store.linkPlatformId({
      canonical_email: 'inside-cycle@example.com',
      vendor: 'hubspot',
      platform_id: 'hs-inside',
      state: 'auto',
      linked_at: 1_100,
      linked_by: 'reconciler:hubspot',
    });

    expect(bundle.contactMergeCycleObserver?.pendingChangesSnapshot()).toEqual([
      {
        kind: 'added',
        canonical_email: 'inside-cycle@example.com',
        vendor: 'hubspot',
        platform_id: 'hs-inside',
      },
    ]);
  });

  it('runs backfillContacts at compose time', async () => {
    const backfillMock = vi.mocked(backfillContacts);
    backfillMock.mockResolvedValueOnce(backfillResult);

    const bundle = composeWithDb();
    await flushMicrotasks();

    expect(backfillMock).toHaveBeenCalledTimes(1);
    expect(backfillMock).toHaveBeenCalledWith(
      expect.any(Database),
      bundle.contactStore,
    );
    await expect(bundle.backfillDone).resolves.toBeUndefined();
  });

  it('surfaces backfill settlement for the shutdown drain', async () => {
    const backfillMock = vi.mocked(backfillContacts);
    let releaseBackfill!: () => void;
    backfillMock.mockImplementationOnce(() =>
      new Promise((resolve) => {
        releaseBackfill = () => resolve(backfillResult);
      }));

    const bundle = composeWithDb();
    let settled = false;
    const observed = bundle.backfillDone!.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    releaseBackfill();
    await observed;
    expect(settled).toBe(true);
  });

  it('swallows backfillContacts rejections without unhandled rejection', async () => {
    const unhandledRejection = vi.fn();
    process.once('unhandledRejection', unhandledRejection);
    const backfillMock = vi.mocked(backfillContacts);
    backfillMock.mockRejectedValueOnce(new Error('boom'));

    try {
      let bundle: ReturnType<typeof composeContactStore> | undefined;
      expect(() => {
        bundle = composeWithDb();
      }).not.toThrow();
      await flushMicrotasks();

      expect(backfillMock).toHaveBeenCalledTimes(1);
      expect(unhandledRejection).not.toHaveBeenCalled();
      await expect(bundle?.backfillDone).resolves.toBeUndefined();
    } finally {
      process.removeListener('unhandledRejection', unhandledRejection);
    }
  });
});
