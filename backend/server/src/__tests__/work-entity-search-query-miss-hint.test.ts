/** `work.search` guided empty for a QUERY MISS.
 *
 *  The scenario is transcribed from a live drive on 2026-09-05
 *  (internal benchmarks task 340, reports `12-10-28-149Z` / `13-18-10-353Z`):
 *  twelve notes titled `Kestrel ring 01..12`, and the model's opening call was
 *  `work.search { kind: 'note', query: 'Kestrel rings' }`. The plural is not a
 *  substring of any title, so the tool returned a bare `{ entities: [], total: 0 }`
 *  — indistinguishable from "you have no notes". Both runs went on to conclude the
 *  data lived outside the toolset.
 *
 *  The discriminating pair is the point of this suite: the SAME corpus must
 *  produce a hint for the phrase and none for a substring that hits, and an
 *  ACTUALLY empty collection must produce none either — a hint there would talk
 *  the model out of a correct "you have none". */

import type {
  ChatDispatchContext,
  ChatDispatchResult,
  IngredientManifest,
} from '@recued/contracts';
import { RECUED_BUILTIN_SOURCE_ID } from '@recued/contracts';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createWorkEntityStore,
  ensureWorkEntitySchema,
  type WorkEntityStore,
} from '../storage/work-entity-store.js';
import {
  runWorkEntitySearchTool,
  type WorkEntityReadToolsDeps,
  type WorkEntityToolItem,
} from '../work-entity-read-tools.js';
import { createWorkEntityResolver } from '../work-entity-resolver.js';
import type { KernelWorkEntitySourceDeclaration } from '../work-entity-source-boot.js';
import type { WorkEntityTargetedReadDeps } from '../work-entity-write-executor.js';

const NOW = 1_700_000_000_000;
const OWNER_CTX: ChatDispatchContext = { channel: 'internal_function_call' };
const NOTE_SOURCE = RECUED_BUILTIN_SOURCE_ID('note');

interface SearchResult {
  entities: WorkEntityToolItem[];
  total: number;
  hint?: string;
  scan_truncated?: boolean;
}

let db: Database.Database;
let store: WorkEntityStore;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  ensureWorkEntitySchema(db);
  store = createWorkEntityStore(db);
  store.registerSource({
    id: NOTE_SOURCE,
    top_tier_kind: 'note',
    source_kind: 'builtin',
    source_label: 'notes',
    write_capable: true,
    registered_at: NOW,
  });
});

afterEach(() => {
  db.close();
});

const deps = (): WorkEntityReadToolsDeps => ({
  isCollectionReadGranted: () => true,
  isVerbOpGranted: () => true,
  getResolver: () => createWorkEntityResolver(store, {}),
  getTargetedReadDeps: () => undefined,
  now: () => NOW,
});

const ok = (result: ChatDispatchResult): SearchResult => {
  if (!result.ok) throw new Error(`expected ok dispatch, got ${result.reason}`);
  return result.result as SearchResult;
};

const seedNote = (id: string, title: string, body: string): void => {
  store.writeNote({
    id,
    source_id: NOTE_SOURCE,
    title,
    body,
    created_at: NOW,
    updated_at: NOW,
    last_user_action_at: NOW,
  }, NOW);
};

/** The live corpus: `Kestrel ring 01` … `Kestrel ring 12`. */
const seedKestrelRings = (): void => {
  for (let n = 1; n <= 12; n += 1) {
    const nn = String(n).padStart(2, '0');
    seedNote(`ring-${nn}`, `Kestrel ring ${nn}`, `Ring ${nn}. Checkpoint cost: ${100 + n} units.`);
  }
};

const search = async (args: Record<string, unknown>): Promise<SearchResult> =>
  ok(await runWorkEntitySearchTool(deps(), { kind: 'note', limit: 20, ...args }, OWNER_CTX));

describe('work.search — query-miss guided empty', () => {
  it('🔑 the live failure no longer misses at all — the plural MATCHES now', async () => {
    seedKestrelRings();

    // This is the query that returned 0 on 2026-09-05 and sent a live model
    // looking for a data source it already had. Porter stemming answers it.
    const hit = await search({ query: 'Kestrel rings' });
    expect(hit.total).toBe(12);
    expect(hit.hint).toBeUndefined();
  });

  it('a genuine miss against a non-empty collection is still explained', async () => {
    seedKestrelRings();

    const missed = await search({ query: 'Peregrine' });
    expect(missed.total).toBe(0);
    expect(missed.hint).toBeDefined();
    // The load-bearing sentence — it must deny the reading the model actually took.
    expect(missed.hint).toContain('NOT an empty note collection');
    expect(missed.hint).toContain('12 note(s) exist');
    // And it must license the retry that fixes it, while barring the same query.
    expect(missed.hint).toMatch(/Do NOT re-send this query unchanged/);
  });

  it('the same corpus, a substring that hits: no hint, because nothing needs explaining', async () => {
    seedKestrelRings();

    const hit = await search({ query: 'Kestrel' });
    expect(hit.total).toBe(12);
    expect(hit.hint).toBeUndefined();
  });

  it('⛔ an ACTUALLY empty collection keeps its bare zero', async () => {
    // No seed. "You have no notes" is TRUE here, and a hint claiming the query
    // was at fault would push the model off a correct answer.
    const empty = await search({ query: 'Peregrine' });
    expect(empty.total).toBe(0);
    expect(empty.hint).toBeUndefined();
  });

  it('a miss against a pool of ONE still explains itself', async () => {
    seedNote('solo', 'Kestrel ring 04', 'Ring 04. Checkpoint cost: 193 units.');

    const missed = await search({ query: 'Peregrine' });
    expect(missed.total).toBe(0);
    expect(missed.hint).toContain('1 note(s) exist');
  });

  it('no query at all cannot be a query miss', async () => {
    // ⚠ This test does NOT establish that the `query !== undefined` clause is
    // load-bearing — it passes with that clause deleted (mutation M2). The
    // clause is unreachable-by-arithmetic today; see the comment at the
    // emission site. What this DOES pin is the listing path's bare zero.
    const listed = await search({});
    expect(listed.total).toBe(0);
    expect(listed.hint).toBeUndefined();
  });

  it('the hint echoes the query AS SENT, not lowercased', async () => {
    seedKestrelRings();

    const missed = await search({ query: 'Peregrine FALCON' });
    expect(missed.hint).toContain('"Peregrine FALCON"');
    // Showing a string the model did not write, beside a sentence saying the
    // match is case-insensitive, invites a retry on casing — the one edit that
    // cannot help.
    expect(missed.hint).not.toContain('"peregrine falcon"');
  });

  it('body text counts as a hit, so a body match takes no hint', async () => {
    seedKestrelRings();

    const viaBody = await search({ query: 'Checkpoint cost: 105' });
    expect(viaBody.total).toBe(1);
    expect(viaBody.hint).toBeUndefined();
  });

  it('the `done` narrowing is the caller\'s own, so it is not counted as a query miss', async () => {
    // `done` filters BEFORE the query, and its rows were never candidates for
    // this query — counting them would overstate the pool the query rejected.
    store.registerSource({
      id: RECUED_BUILTIN_SOURCE_ID('task'),
      top_tier_kind: 'task',
      source_kind: 'builtin',
      source_label: 'tasks',
      write_capable: true,
      registered_at: NOW,
    });
    store.writeTask({
      id: 't-done',
      source_id: RECUED_BUILTIN_SOURCE_ID('task'),
      title: 'Kestrel ring 01',
      done: true,
      state: 'LOCAL_DONE',
      created_at: NOW,
      updated_at: NOW,
    }, NOW);

    const openOnly = ok(await runWorkEntitySearchTool(
      deps(),
      { kind: 'task', query: 'Kestrel ring', done: false, limit: 20 },
      OWNER_CTX,
    ));
    expect(openOnly.total).toBe(0);
    // ⛔ SUPPRESSED, and this is the interesting case: the query DOES match that
    // task — `done: false` is what removed it. A hint here would say "1 task
    // exists and the query matched none", which is false. `done` has no SQL
    // filter, so the pool cannot be counted post-narrowing; the tool declines to
    // explain rather than explain wrongly.
    expect(openOnly.hint).toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────────
// Read-through: the pool's other half
// ────────────────────────────────────────────────────────────────

const RT_SOURCE = 'peer.acme.note';
const RT_CATALOG = 'peer-catalog';

/** A minimal live-Source declaration — read_through posture, one list op,
 *  title + body projection. Everything the prepare path checks, nothing else. */
const rtDeclaration = {
  kind: 'note',
  source_id_template: RT_SOURCE,
  source_label_template: 'Peer notes',
  source_kind: 'connection',
  remote: {
    entity: 'note',
    id: 'id',
    version: { kind: 'updated_at', field: 'updated_at' },
    hash_fields: ['title', 'body', 'updated_at'],
  },
  ops: { list: 'note.list' },
  sync: { posture: 'read_through', mode: 'read_only', depth: 'meta' },
  read_resolution: {
    default: 'source',
    wild_query: {
      remote_fanout: 'bounded_targeted',
      max_sources: 3,
      max_remote_records: 10,
      on_exceeds_cap: 'ask_to_narrow',
    },
  },
  projection: {
    canonical: { title: 'title' },
    preview: { body: { field: 'body', max_chars: 800 } },
    extension: { detail_fidelity: 'preview' },
  },
} as unknown as KernelWorkEntitySourceDeclaration;

const rtManifest = {
  slug: RT_CATALOG,
  name: 'Peer catalog',
  description: 'read-through note source',
  author: 'recued',
  kind: 'connection',
  category: 'data',
  risk_tier: 'read',
  input: {},
  output: {},
  operations: {
    'note.list': { operation_id: 'note.list', risk_tier: 'read', result_path: 'records' },
  },
} as unknown as IngredientManifest;

/** `records` the live Source returns. */
const rtTargeted = (records: Array<Record<string, unknown>>): WorkEntityTargetedReadDeps => ({
  fetchDeps: {
    profiles: { get: () => ({ allowed_operations: ['note.list'], catalog_slug: RT_CATALOG }) },
    executorConfig: { manifests: { get: () => rtManifest } },
  },
  resolveDeclaration: () => ({
    declaration: rtDeclaration,
    connection_name: 'acme',
    connection_config: {},
  }),
  // The scripted invoke — the request shape stays real, only the transport is faked.
  runOperation: async () => ({ ok: true, raw: { result: { records } } }),
} as unknown as WorkEntityTargetedReadDeps);

describe('work.search — query miss over a LIVE-SOURCE-only corpus', () => {
  const rtDeps = (records: Array<Record<string, unknown>>): WorkEntityReadToolsDeps => ({
    isCollectionReadGranted: () => true,
    isVerbOpGranted: () => true,
    getResolver: () => createWorkEntityResolver(store, {}),
    getTargetedReadDeps: () => rtTargeted(records),
    now: () => NOW,
  });

  beforeEach(() => {
    store.registerSource({
      id: RT_SOURCE,
      top_tier_kind: 'note',
      source_kind: 'connection',
      source_label: 'Peer notes',
      write_capable: false,
      registered_at: NOW,
      sync_posture: 'read_through',
    });
  });

  it('⛔ read-through items count toward the pool — nothing is materialized locally', async () => {
    // Zero local rows. If the pool counted only `rows`, this miss would look like
    // an empty note collection and the hint would (correctly, by its own gate)
    // stay silent — leaving the bare zero that started this whole investigation.
    const rt = [
      { id: 'r1', title: 'Kestrel ring 04', body: 'Checkpoint cost: 193 units.', updated_at: NOW },
      { id: 'r2', title: 'Kestrel ring 05', body: 'Checkpoint cost: 176 units.', updated_at: NOW },
    ];
    // 🔑 PARITY: the plural stems here exactly as it does locally, because this
    // half runs the SAME matcher over a throwaway index rather than a
    // hand-written approximation of it.
    const hit = ok(await runWorkEntitySearchTool(
      rtDeps(rt), { kind: 'note', query: 'Kestrel rings', limit: 20 }, OWNER_CTX,
    ));
    expect(hit.total).toBe(2);

    // And a genuine miss over a live-source-only corpus still explains itself.
    const missed = ok(await runWorkEntitySearchTool(
      rtDeps(rt), { kind: 'note', query: 'Peregrine', limit: 20 }, OWNER_CTX,
    ));
    expect(missed.total).toBe(0);
    expect(missed.hint).toContain('NOT an empty note collection');
  });

  it('a live Source that returns nothing keeps its bare zero', async () => {
    const empty = ok(await runWorkEntitySearchTool(
      rtDeps([]),
      { kind: 'note', query: 'Peregrine', limit: 20 },
      OWNER_CTX,
    ));
    expect(empty.total).toBe(0);
    expect(empty.hint).toBeUndefined();
  });
});

describe('work.search — the same words in another kind', () => {
  // Measured 2026-10-21 (D-325 bench, lookup off): "When does my passport
  // expire?" was searched as a NOTE, the bare zero came back, and the chat said
  // it was "not recorded anywhere". The passport was on file as an ASSET.
  const ASSET_SOURCE = RECUED_BUILTIN_SOURCE_ID('asset');
  const seedAsset = (id: string, name: string): void => {
    if (store.listSources('asset').length === 0) {
      store.registerSource({ id: ASSET_SOURCE, top_tier_kind: 'asset', source_kind: 'builtin', source_label: 'assets',
        write_capable: true, registered_at: NOW });
    }
    store.writeAsset({ id, source_id: ASSET_SOURCE, source: { kind: 'owner', ref: 'owner' }, name }, NOW);
  };
  const searchWith = async (override: Partial<WorkEntityReadToolsDeps>, args: Record<string, unknown>): Promise<SearchResult> =>
    ok(await runWorkEntitySearchTool({ ...deps(), ...override }, { kind: 'note', limit: 20, ...args }, OWNER_CTX));

  it('names the kind that holds the words when the searched kind has none', async () => {
    seedAsset('passport', 'Passport · Ana');
    const missed = await search({ query: 'passport' });
    expect(missed.total).toBe(0);
    expect(missed.hint).toBe('no note matched query "passport". The same words match 1 asset: '
      + 'search with kind "asset". Do not tell the user it is not on file.');
  });

  it('adds it to the query-miss hint when the searched kind has records of its own', async () => {
    seedKestrelRings();
    seedAsset('passport', 'Passport · Ana');
    const missed = await search({ query: 'passport' });
    expect(missed.hint).toContain('NOT an empty note collection');
    expect(missed.hint).toMatch(/The same words match 1 asset: search with kind "asset"\.[^]*not on file\.$/u);
  });

  it('keeps the bare zero when no other kind matches either', async () => {
    seedAsset('passport', 'Passport · Ana');
    expect((await search({ query: 'Peregrine' })).hint).toBeUndefined();
  });

  it('says nothing of a kind the caller may not read', async () => {
    seedAsset('passport', 'Passport · Ana');
    const missed = await searchWith({ isCollectionReadGranted: (kind) => kind !== 'asset' }, { query: 'passport' });
    expect(missed.hint).toBeUndefined();
  });

  it('tells a sphere-limited reader no counts, and does not search the other kinds at all', async () => {
    seedAsset('passport', 'Passport · Ana');
    const limited = { limited: true, allows: () => true, cleanWork: (row: unknown) => row };
    // A later line replaces a limited reader's hint anyway, so the output alone
    // cannot show whether other kinds were read; the searched kinds can.
    const resolver = createWorkEntityResolver(store, {}); const searched: string[] = [];
    const watched = { ...resolver, searchByText: (kind: Parameters<typeof resolver.searchByText>[0], query: string, limit: number) => {
      searched.push(kind); return resolver.searchByText(kind, query, limit);
    } };
    const missed = await searchWith({ getReadScope: () => limited as never, getResolver: () => watched }, { query: 'passport' });
    expect(missed.hint ?? '').not.toContain('same words');
    expect(searched).toEqual(['note']);
  });

  it('does not look elsewhere when the search was narrowed by done', async () => {
    seedAsset('passport', 'Passport · Ana');
    store.registerSource({ id: RECUED_BUILTIN_SOURCE_ID('task'), top_tier_kind: 'task', source_kind: 'builtin',
      source_label: 'tasks', write_capable: true, registered_at: NOW });
    const missed = await search({ kind: 'task', query: 'passport', done: false });
    expect(missed.hint).toBeUndefined();
  });

  it('does not look elsewhere when the search was narrowed to one source', async () => {
    seedAsset('passport', 'Passport · Ana');
    const missed = await search({ query: 'passport', source_id: NOTE_SOURCE });
    expect(missed.hint).toBeUndefined();
  });
});

describe('work.search — a misspelled private name', () => {
  // The spelling bench (2026-10-23) asks about a "Castelanos lease" the owner
  // filed as "Castellanos lease". A model cannot correct a private name; only
  // the index holds both spellings.
  const ASSET_SOURCE = RECUED_BUILTIN_SOURCE_ID('asset');
  const seedAsset = (id: string, name: string): void => {
    if (store.listSources('asset').length === 0) {
      store.registerSource({ id: ASSET_SOURCE, top_tier_kind: 'asset', source_kind: 'builtin', source_label: 'assets',
        write_capable: true, registered_at: NOW });
    }
    store.writeAsset({ id, source_id: ASSET_SOURCE, source: { kind: 'owner', ref: 'owner' }, name }, NOW);
  };
  const searchWith = async (override: Partial<WorkEntityReadToolsDeps>, args: Record<string, unknown>): Promise<SearchResult> =>
    ok(await runWorkEntitySearchTool({ ...deps(), ...override }, { kind: 'note', limit: 20, ...args }, OWNER_CTX));

  it('⛔ names the spelling on file, the kind holding it, and asks the model to say how it read the word', async () => {
    seedAsset('lease', 'Castellanos lease');
    const missed = await search({ kind: 'asset', query: 'Castelanos' });
    expect(missed.total).toBe(0);
    expect(missed.hint).toContain('NOT an empty asset collection');
    expect(missed.hint).toMatch(/No record holds "Castelanos", but "Castellanos" is in 1 asset\. If that is who or what the owner meant, search again for "Castellanos" with kind "asset", and begin your answer by telling the owner you read "Castelanos" as "Castellanos": it may be a different name\.$/u);
  });

  it('points at the kind that holds the word when the search looked in another', async () => {
    seedAsset('lease', 'Castellanos lease');
    const missed = await search({ query: 'Castelanos' });
    expect(missed.hint).toBe('no note matched query "Castelanos". No record holds "Castelanos", but '
      + '"Castellanos" is in 1 asset. If that is who or what the owner meant, search again for '
      + '"Castellanos" with kind "asset", and begin your answer by telling the owner you read '
      + '"Castelanos" as "Castellanos": it may be a different name.');
  });

  it('says nothing about spelling when every word is on file — that miss has another cause', async () => {
    seedAsset('lease', 'Castellanos lease');
    seedKestrelRings();
    const missed = await search({ query: 'Castellanos ring' });
    expect(missed.total).toBe(0);
    expect(missed.hint ?? '').not.toContain('No record holds');
  });

  it('⛔ withholds a spelling that only a kind the caller may not read holds', async () => {
    seedAsset('lease', 'Castellanos lease');
    const missed = await searchWith({ isCollectionReadGranted: (kind) => kind !== 'asset' }, { query: 'Castelanos' });
    expect(missed.hint ?? '').not.toContain('Castellanos');
  });

  it('⛔ does not even check spelling for a sphere-limited reader', async () => {
    seedAsset('lease', 'Castellanos lease');
    const limited = { limited: true, allows: () => true, cleanWork: (row: unknown) => row };
    const resolver = createWorkEntityResolver(store, {}); let checked = 0;
    const watched = { ...resolver, checkSpelling: (query: string) => { checked += 1; return resolver.checkSpelling(query); } };
    const missed = await searchWith({ getReadScope: () => limited as never, getResolver: () => watched }, { query: 'Castelanos' });
    expect(missed.hint ?? '').not.toContain('Castellanos');
    expect(checked).toBe(0);
  });

  it('stays out of a prefix search the model wrote on purpose', async () => {
    seedAsset('lease', 'Castellanos lease');
    const missed = await search({ kind: 'asset', query: 'Kastel*' });
    expect(missed.hint ?? '').not.toContain('No record holds');
  });
});

