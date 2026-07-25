/** D-177 N.11 rule 1 — stored-cleanliness gate coverage. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  computeOpenProjection,
  isOpenProjectionRefusal,
  isUserCleanStoredRow,
  isWellFormedOpenProjection,
  type ComputeOpenProjectionArgs,
  type OpenProjectionComputation,
  type StoredRowProvenance,
} from '@recued/contracts';

import { createStoredRowOriginResolver } from '../stored-root-origin.js';
import { createBlobStore } from '../storage/blob-store.js';
import {
  createAnnotationStore,
  type AnnotationStore,
} from '../storage/annotation-store.js';
import {
  createContactStore,
  type ContactStore,
} from '../storage/contact-store.js';

let dir: string;
let db: Database.Database;
let contactStore: ContactStore;
let annotationStore: AnnotationStore;
let now: number;
let idCounter: number;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd-177-rule1-stored-'));
  db = new Database(join(dir, 'test.db'));
  db.pragma('journal_mode = WAL');
  contactStore = createContactStore(db);
  const blobs = createBlobStore(join(dir, 'blobs'));
  now = 1_000_000;
  idCounter = 0;
  annotationStore = createAnnotationStore({
    db,
    blobs,
    now: () => now,
    newId: () => `annotation-${++idCounter}`,
  });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

type UnsafeStoredRowProvenance = {
  origin_actor: string;
  origin_contract_id?: string;
  origin_surface?: string;
};

const storedRow = (row: UnsafeStoredRowProvenance): StoredRowProvenance =>
  row as StoredRowProvenance;

const cleanFacets: StoredRowProvenance = {
  origin_actor: 'user_self',
  origin_surface: 'client_rpc',
};

const engineSurfaceFacets: StoredRowProvenance = {
  origin_actor: 'user_self',
  origin_surface: 'engine',
};

const AUTHORITY_REF =
  'data.contact.jane.doe@example.com.annotations.preferred_channel';
const AUTHORITY_TEMPLATE = `{{${AUTHORITY_REF}}}`;
const AUTHORITY_VALUE = 'sms:+15551234567';
const minimalRecipe = {
  steps: [
    {
      id: 'send',
      ingredient: 'mail.send',
      input: { to: AUTHORITY_TEMPLATE },
    },
  ],
} as const;

const normalizeRef = (ref: string): string =>
  ref.replace(/^\{\{\s*/, '').replace(/\s*\}\}$/, '').trim();

const resolveTemplateValue = (
  value: unknown,
  valuesByRef: ReadonlyMap<string, unknown>,
): unknown => {
  if (typeof value !== 'string') return value;
  const whole = value.match(/^\{\{\s*([^}]+)\s*\}\}$/);
  if (whole !== null) return valuesByRef.get(whole[1]!.trim());
  return value.replace(/\{\{([^}]+)\}\}/g, (_match, ref: string) =>
    String(valuesByRef.get(ref.trim())),
  );
};

const computeProjection = (opts: {
  readonly ref?: string;
  readonly valuesByRef?: ReadonlyMap<string, unknown>;
  readonly resolveStoredRowOrigin?: NonNullable<
    ComputeOpenProjectionArgs['resolveStoredRowOrigin']
  >;
} = {}) => {
  const ref = opts.ref ?? AUTHORITY_REF;
  const valuesByRef = opts.valuesByRef ?? new Map([[ref, AUTHORITY_VALUE]]);
  const input: ComputeOpenProjectionArgs = {
    mergedArgs: { to: `{{${ref}}}` },
    authorityPaths: ['to'],
    steps: minimalRecipe.steps,
    gatedStepId: 'send',
    resolveRootValue: (rootRef) => valuesByRef.get(normalizeRef(rootRef)),
    resolveArgValue: (unresolvedValue) =>
      resolveTemplateValue(unresolvedValue, valuesByRef),
    getIngredientKind: () => undefined,
    ...(opts.resolveStoredRowOrigin !== undefined
      ? { resolveStoredRowOrigin: opts.resolveStoredRowOrigin }
      : {}),
  };
  return computeOpenProjection(input);
};

const expectProjection = (
  result: ReturnType<typeof computeOpenProjection>,
): OpenProjectionComputation => {
  expect(isOpenProjectionRefusal(result)).toBe(false);
  if (isOpenProjectionRefusal(result)) throw new Error(result.refused);
  return result;
};

describe('isUserCleanStoredRow predicate table', () => {
  it.each([
    [
      'user_self + client_rpc + no contract_id',
      storedRow({ origin_actor: 'user_self', origin_surface: 'client_rpc' }),
      true,
    ],
    [
      'origin_actor = engine',
      storedRow({ origin_actor: 'engine', origin_surface: 'client_rpc' }),
      false,
    ],
    [
      'origin_actor = system',
      storedRow({ origin_actor: 'system', origin_surface: 'client_rpc' }),
      false,
    ],
    [
      'origin_actor = anonymous',
      storedRow({ origin_actor: 'anonymous', origin_surface: 'client_rpc' }),
      false,
    ],
    [
      'origin_actor = contracted_user',
      storedRow({ origin_actor: 'contracted_user', origin_surface: 'client_rpc' }),
      false,
    ],
    [
      'origin_surface = engine',
      storedRow({ origin_actor: 'user_self', origin_surface: 'engine' }),
      false,
    ],
    [
      'origin_surface = system',
      storedRow({ origin_actor: 'user_self', origin_surface: 'system' }),
      false,
    ],
    [
      'origin_surface missing/undefined',
      storedRow({ origin_actor: 'user_self' }),
      false,
    ],
    [
      'contract_id present (origin_contract_id non-null)',
      storedRow({
        origin_actor: 'user_self',
        origin_surface: 'client_rpc',
        origin_contract_id: 'contract-1',
      }),
      false,
    ],
  ])('%s -> %s', (_label, row, expected) => {
    expect(isUserCleanStoredRow(row)).toBe(expected);
  });
});

describe('createStoredRowOriginResolver over REAL contact + annotation stores', () => {
  const resolver = () =>
    createStoredRowOriginResolver({ contactStore, annotationStore });

  it('resolves dotted-email contact refs through the longest existing contact prefix', () => {
    contactStore.upsertManual(
      {
        email: 'jane.doe@example.com',
        name: 'Jane Doe',
        phone: '+15551234567',
      },
      1_000,
      { origin_actor: 'user_self', origin_surface: 'client_rpc' },
    );

    expect(resolver()('data.contact.jane.doe@example.com.phone')).toEqual(
      cleanFacets,
    );
  });

  it('uses the longest-prefix shadow contact row instead of a shorter clean row', () => {
    contactStore.upsertManual(
      {
        email: 'jane.doe@example.com',
        name: 'Jane Doe',
        phone: '+15551234567',
      },
      1_000,
      { origin_actor: 'user_self', origin_surface: 'client_rpc' },
    );
    contactStore.upsertManual(
      {
        email: 'jane.doe@example.com.phone',
        name: 'Shadow Jane',
      },
      2_000,
      {
        origin_actor: 'contracted_user',
        origin_contract_id: 'contract-shadow',
        origin_surface: 'engine',
      },
    );

    expect(resolver()('data.contact.jane.doe@example.com.phone')).toEqual({
      origin_actor: 'contracted_user',
      origin_contract_id: 'contract-shadow',
      origin_surface: 'engine',
    });
  });

  it('returns undefined for a no-such-contact ref', () => {
    expect(resolver()('data.contact.missing@example.com.phone')).toBeUndefined();
  });

  it('returns undefined for a non-data ref', () => {
    expect(resolver()('step.foo')).toBeUndefined();
  });

  it('returns undefined for data.shared refs', () => {
    expect(resolver()('data.shared.x.y')).toBeUndefined();
  });

  it('returns undefined when the ref still contains a template marker', () => {
    expect(resolver()('data.contact.{{config.email}}.phone')).toBeUndefined();
  });

  it('returns undefined for refs with a prototype-sensitive segment', () => {
    expect(resolver()('data.contact.__proto__.phone')).toBeUndefined();
  });

  it('resolves annotation-key refs to the latest row facets', async () => {
    now = 1_000;
    await annotationStore.annotate({
      target_collection: 'contact',
      target_id: 'jane.doe@example.com',
      key: 'preferred_channel',
      value: 'email',
      authored_by_recipe_id: 'recipe-1',
      source_record_hash: 'source-1',
      recipe_hash: 'recipe-hash-1',
      origin_actor: 'user_self',
      origin_surface: 'client_rpc',
    });
    now = 2_000;
    await annotationStore.annotate({
      target_collection: 'contact',
      target_id: 'jane.doe@example.com',
      key: 'preferred_channel',
      value: 'sms',
      authored_by_recipe_id: 'recipe-2',
      source_record_hash: 'source-2',
      recipe_hash: 'recipe-hash-2',
      origin_actor: 'contracted_user',
      origin_contract_id: 'contract-2',
      origin_surface: 'engine',
    });

    expect(
      resolver()(
        'data.contact.jane.doe@example.com.annotations.preferred_channel',
      ),
    ).toEqual({
      origin_actor: 'contracted_user',
      origin_contract_id: 'contract-2',
      origin_surface: 'engine',
    });
  });

  it('returns undefined for a bare annotations group ref', () => {
    expect(
      resolver()('data.contact.jane.doe@example.com.annotations'),
    ).toBeUndefined();
  });

  it('returns undefined for links role refs', () => {
    expect(
      resolver()('data.contact.jane.doe@example.com.links.manager'),
    ).toBeUndefined();
  });

  it('returns undefined for deep annotations key subpaths (no contact-arm fall-through)', () => {
    // A deep subpath misses the right-anchored annotation grammar; the
    // resolver must NOT fall through to the contact prefix search and
    // return the (clean) contact row's facets — the value such a ref can
    // resolve at runtime is the ANNOTATION's subfield, possibly
    // agent-written. Codex test-round fold.
    contactStore.upsertManual(
      { email: 'jane.doe@example.com', name: 'Jane Doe' },
      1_000,
      { origin_actor: 'user_self', origin_surface: 'client_rpc' },
    );
    expect(
      resolver()(
        'data.contact.jane.doe@example.com.annotations.preferred_channel.sub',
      ),
    ).toBeUndefined();
    // Same guard for deep link subpaths.
    expect(
      resolver()('data.contact.jane.doe@example.com.links.manager.0.to_id'),
    ).toBeUndefined();
  });

  it('returns undefined for latestAnnotationProvenance ties with different facets', async () => {
    now = 3_000;
    await annotationStore.annotate({
      target_collection: 'contact',
      target_id: 'jane.doe@example.com',
      key: 'preferred_channel',
      value: 'email',
      authored_by_recipe_id: 'recipe-1',
      source_record_hash: 'source-1',
      recipe_hash: 'recipe-hash-1',
      origin_actor: 'user_self',
      origin_surface: 'client_rpc',
    });
    await annotationStore.annotate({
      target_collection: 'contact',
      target_id: 'jane.doe@example.com',
      key: 'preferred_channel',
      value: 'sms',
      authored_by_recipe_id: 'recipe-2',
      source_record_hash: 'source-2',
      recipe_hash: 'recipe-hash-2',
      origin_actor: 'contracted_user',
      origin_contract_id: 'contract-2',
      origin_surface: 'engine',
    });

    expect(
      annotationStore.latestAnnotationProvenance(
        'contact',
        'jane.doe@example.com',
        'preferred_channel',
      ),
    ).toBeUndefined();
  });

  it('returns facets for latestAnnotationProvenance ties with matching facets', async () => {
    now = 4_000;
    await annotationStore.annotate({
      target_collection: 'contact',
      target_id: 'jane.doe@example.com',
      key: 'preferred_channel',
      value: 'email',
      authored_by_recipe_id: 'recipe-1',
      source_record_hash: 'source-1',
      recipe_hash: 'recipe-hash-1',
      origin_actor: 'user_self',
      origin_surface: 'client_rpc',
    });
    await annotationStore.annotate({
      target_collection: 'contact',
      target_id: 'jane.doe@example.com',
      key: 'preferred_channel',
      value: 'sms',
      authored_by_recipe_id: 'recipe-2',
      source_record_hash: 'source-2',
      recipe_hash: 'recipe-hash-2',
      origin_actor: 'user_self',
      origin_surface: 'client_rpc',
    });

    expect(
      annotationStore.latestAnnotationProvenance(
        'contact',
        'jane.doe@example.com',
        'preferred_channel',
      ),
    ).toEqual(cleanFacets);
  });
});

describe('computeOpenProjection integration', () => {
  it('classifies user-clean stored row roots as stored_user without pins', () => {
    const result = expectProjection(
      computeProjection({
        resolveStoredRowOrigin: () => cleanFacets,
      }),
    );
    const arg = result.projection.args[0]!;
    const root = arg.roots[0]!;

    expect(root).toEqual({ ref: AUTHORITY_REF, origin: 'stored_user' });
    expect(root).not.toHaveProperty('pinned');
    expect(arg).not.toHaveProperty('derived_pinned');
    expect(result.pinned_projection_hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('classifies engine-surface stored row roots as stored with root and derived pins', () => {
    const result = expectProjection(
      computeProjection({
        resolveStoredRowOrigin: () => engineSurfaceFacets,
      }),
    );
    const arg = result.projection.args[0]!;

    expect(arg.roots).toEqual([
      { ref: AUTHORITY_REF, origin: 'stored', pinned: AUTHORITY_VALUE },
    ]);
    expect(arg.derived_pinned).toBe(AUTHORITY_VALUE);
  });

  it('keeps data roots stored when the stored-row callback is absent', () => {
    const result = expectProjection(computeProjection());
    const arg = result.projection.args[0]!;

    expect(arg.roots).toEqual([
      { ref: AUTHORITY_REF, origin: 'stored', pinned: AUTHORITY_VALUE },
    ]);
    expect(arg.derived_pinned).toBe(AUTHORITY_VALUE);
  });

  it('keeps data roots stored when the stored-row callback throws', () => {
    const result = expectProjection(
      computeProjection({
        resolveStoredRowOrigin: () => {
          throw new Error('store unavailable');
        },
      }),
    );
    const arg = result.projection.args[0]!;

    expect(arg.roots).toEqual([
      { ref: AUTHORITY_REF, origin: 'stored', pinned: AUTHORITY_VALUE },
    ]);
    expect(arg.derived_pinned).toBe(AUTHORITY_VALUE);
  });

  it('computes different pinned_projection_hash values for clean and tainted stored variants', () => {
    const clean = expectProjection(
      computeProjection({
        resolveStoredRowOrigin: () => cleanFacets,
      }),
    );
    const tainted = expectProjection(
      computeProjection({
        resolveStoredRowOrigin: () => engineSurfaceFacets,
      }),
    );

    expect(clean.pinned_projection_hash).not.toBe(
      tainted.pinned_projection_hash,
    );
  });

  it('never calls the stored-row callback for shared roots', () => {
    for (const ref of ['shared.x', 'data.shared.x'] as const) {
      const resolveStoredRowOrigin = vi.fn(
        (_canonicalRef: string): StoredRowProvenance | undefined => cleanFacets,
      );
      const result = expectProjection(
        computeProjection({
          ref,
          valuesByRef: new Map([[ref, `${ref}:value`]]),
          resolveStoredRowOrigin,
        }),
      );

      expect(resolveStoredRowOrigin).not.toHaveBeenCalled();
      expect(result.projection.args[0]!.roots).toEqual([
        { ref, origin: 'stored', pinned: `${ref}:value` },
      ]);
      expect(result.projection.args[0]!.derived_pinned).toBe(`${ref}:value`);
    }
  });

  it('rejects a hand-shaped stored_user root that carries a pinned key', () => {
    expect(
      isWellFormedOpenProjection({
        version: 1,
        args: [
          {
            path: 'to',
            skeleton: AUTHORITY_TEMPLATE,
            roots: [
              {
                ref: AUTHORITY_REF,
                origin: 'stored_user',
                pinned: AUTHORITY_VALUE,
              },
            ],
          },
        ],
      }),
    ).toBe(false);
  });

  it('accepts the genuine clean-root projection', () => {
    const result = expectProjection(
      computeProjection({
        resolveStoredRowOrigin: () => cleanFacets,
      }),
    );

    expect(isWellFormedOpenProjection(result.projection)).toBe(true);
  });
});
