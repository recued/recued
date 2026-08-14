/** D-237 P1 — the AI can see how current the sources it just read actually are.
 *
 *  WHY THIS EXISTS. D-236 gave RECIPES a freshness verdict on a collection read.
 *  The AI-facing siblings dropped it, and the drop was worse than an omission:
 *  `mail.search`'s own descriptor asserted the mirror was COMPLETE ("local
 *  warehouse — mail mirrors fully into it") and promised a degradation flag
 *  (`partial: true` + `partial_failures`) that the handler could not emit — it
 *  builds a plain aggregate and never constructs a `ScopeSearchResult`, which is
 *  the only shape `clampScopeSearchResult` sets those fields on. Measured at
 *  Session C of internal design notes
 *  (§10.5): `work-entity-read-tools.ts` referenced `source_freshness` 10 times
 *  while the mail / calendar / file handler bodies referenced freshness, stale,
 *  age_ms, health or degraded ZERO times.
 *
 *  🔑 THE ASYMMETRY WAS THE HAZARD, NOT THE ABSENCE. The neighbouring tools
 *  disclose — `work.search` rides `source_freshness`, `enrichment.search` rows
 *  carry `staleness_class`, and the CRM trio ships `crm_freshness` with copy
 *  telling the model to caveat "as of 5 days ago". A model calibrated by that
 *  catalog reads a bare empty `mail.search` as a VERIFIED absence, correctly, by
 *  the catalog's own convention.
 *
 *  ⛔ THE FAN-OUT IS THE PART A SINGLE-VERDICT TEST WOULD MISS. These tools read
 *  EVERY instance of a platform at once, so one mailbox synced a minute ago and
 *  another broken for a week are one result. A scalar verdict would have to pick
 *  one and would therefore lie about the other; the array is keyed by
 *  `collection_slug` so each match can be joined to the verdict for the instance
 *  it came from.
 *  ⇒ [[feedback_a_correct_looking_absence_is_usually_a_failure]]
 */

import { describe, expect, it } from 'vitest';
import type { CollectionHealth } from '@recued/contracts';
import { TIER1_TOOL_DESCRIPTORS } from '@recued/contracts';

import { buildChatTier1Handlers } from '../chat-tool-handlers.js';

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const HOUR = 60 * MIN;

const health = (over: Partial<CollectionHealth> = {}): CollectionHealth => ({
  platform: 'mail',
  slug: 'primary',
  last_indexed_at: NOW - 5 * MIN,
  pending_queue_size: 0,
  error_count_24h: 0,
  state: 'idle',
  ...over,
});

interface StubSpec {
  slug: string;
  platform?: string;
  health?: () => CollectionHealth;
  /** Rows the instance returns; default one, so an EMPTY result in a test is a
   *  deliberate input rather than an artefact of an empty fixture. */
  rows?: Array<Record<string, unknown>>;
}

const ROW = { record_id: 'r1', hot_fields: { subject: 'hello' }, received_at: NOW };

const mailStub = (spec: StubSpec) => ({
  platform: spec.platform ?? 'mail',
  slug: spec.slug,
  health: spec.health ?? (() => health({ slug: spec.slug })),
  list: () => spec.rows ?? [ROW],
  search: () => (spec.rows ?? [ROW]).map((r) => ({ ...r, rank: 1, snippet: 's' })),
  get: () => ROW,
});

const calendarStub = (spec: StubSpec) => ({
  platform: 'calendar',
  slug: spec.slug,
  health: spec.health ?? (() => health({ platform: 'calendar', slug: spec.slug })),
  // `isCalendarCollection` narrows on the presence of `table`.
  table: {
    search: () => (spec.rows ?? [ROW]).map((r) => ({ ...r, hot: {}, rank: 1, snippet: 's' })),
    listSnapshots: () => (spec.rows ?? [ROW]).map((r) => ({ ...r, hot: {} })),
    get: () => null,
  },
});

const handlers = (collections: Array<Record<string, unknown>>, fileCollection?: unknown) => {
  const deps = {
    now: () => NOW,
    getContactStore: () => undefined,
    getCollectionRegistry: () => ({
      list: () => collections,
      get: (platform: string, slug: string) =>
        platform === 'file' && slug === 'received' ? fileCollection : undefined,
    }),
    getChatStore: () => ({
      listMessages: async () => [{ attachments: [{ file_id: 'f1' }] }],
    }),
    getAuditLog: () => undefined,
    getEnrichmentStore: () => undefined,
    getRecipeStore: () => ({}),
    getExecutorConfig: () => ({}),
  } as unknown as Parameters<typeof buildChatTier1Handlers>[0];
  return buildChatTier1Handlers(deps);
};

const ctx = { session_id: 'sess-1' } as never;

type Freshness = {
  collection_slug: string;
  age_ms: number | null;
  pending: number;
  degraded: boolean;
  stale: boolean;
  last_success_at: number | null;
};

const freshnessOf = (res: unknown): Freshness[] =>
  ((res as { result?: { source_freshness?: Freshness[] } }).result?.source_freshness ?? []);

// ────────────────────────────────────────────────────────────────
// 1. mail.search — the fan-out verdict
// ────────────────────────────────────────────────────────────────

describe('D-237 P1 — mail.search carries a per-mailbox verdict', () => {
  it('reports EVERY enrolled mailbox, keyed by the slug the matches carry', async () => {
    const res = await handlers([
      mailStub({ slug: 'primary' }),
      mailStub({ slug: 'work' }),
    ])['mail.search']({}, ctx);
    const f = freshnessOf(res);
    expect(f.map((x) => x.collection_slug).sort()).toEqual(['primary', 'work']);
  });

  it('⛔ a STALE mailbox beside a FRESH one is reported distinctly, not averaged', async () => {
    // The whole reason the verdict is an array. A scalar would have to pick one
    // and would be wrong about the other — and "wrong about the other" here
    // means telling the owner she has no such mail.
    const res = await handlers([
      mailStub({ slug: 'fresh' }),
      mailStub({
        slug: 'behind',
        health: () => health({ slug: 'behind', last_indexed_at: NOW - 48 * HOUR }),
      }),
    ])['mail.search']({}, ctx);
    const by = new Map(freshnessOf(res).map((x) => [x.collection_slug, x]));
    expect(by.get('fresh')?.stale).toBe(false);
    expect(by.get('behind')?.stale).toBe(true);
    expect(by.get('behind')?.age_ms).toBe(48 * HOUR);
  });

  it('an EMPTY result from a lagging mailbox is NOT reported as a clean absence', async () => {
    // The SO-1 case in one assertion: zero matches, and the verdict is the only
    // thing standing between that and "you have no such mail".
    const res = await handlers([
      mailStub({
        slug: 'primary',
        rows: [],
        health: () => health({ pending_queue_size: 12 }),
      }),
    ])['mail.search']({ query: 'invoice' }, ctx);
    const r = (res as { result: { matches: unknown[] } }).result;
    expect(r.matches).toEqual([]);
    expect(freshnessOf(res)[0]?.pending).toBe(12);
    expect(freshnessOf(res)[0]?.stale).toBe(true);
  });

  it('NO mailbox enrolled is a different fact from a stale one — both empties, stated separately', async () => {
    // ⛔ The three-way distinction the prompt-optimization log requires: an
    //    unenrolled source, a stale source and a genuinely empty fresh source
    //    must not read the same. `collections: []` carries the first.
    const res = await handlers([])['mail.search']({}, ctx);
    const r = (res as { result: { matches: unknown[]; collections: unknown[] } }).result;
    expect(r.collections).toEqual([]);
    expect(freshnessOf(res)).toEqual([]);
    expect(r.matches).toEqual([]);
  });

  it('a throwing health() degrades to STALE without failing the read', async () => {
    const res = await handlers([
      mailStub({
        slug: 'primary',
        health: () => { throw new Error('adapter exploded'); },
      }),
    ])['mail.search']({}, ctx);
    expect((res as { result: { matches: unknown[] } }).result.matches).toHaveLength(1);
    expect(freshnessOf(res)[0]?.stale).toBe(true);
    expect(freshnessOf(res)[0]?.last_success_at).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────
// 2. calendar.search — same verdict, derived off its own table path
// ────────────────────────────────────────────────────────────────

describe('D-237 P1 — calendar.search carries the verdict off its own read path', () => {
  it('derives per-calendar, including a degraded instance', async () => {
    const res = await handlers([
      calendarStub({ slug: 'personal' }),
      calendarStub({
        slug: 'broken',
        health: () => health({ platform: 'calendar', slug: 'broken', state: 'error' }),
      }),
    ])['calendar.search']({}, ctx);
    const by = new Map(freshnessOf(res).map((x) => [x.collection_slug, x]));
    expect(by.get('personal')?.degraded).toBe(false);
    expect(by.get('broken')?.degraded).toBe(true);
    expect(by.get('broken')?.stale).toBe(true);
  });

  it('"nothing scheduled" from a lagging calendar carries its lag', async () => {
    const res = await handlers([
      calendarStub({
        slug: 'personal',
        rows: [],
        health: () => health({ platform: 'calendar', last_indexed_at: NOW - 30 * HOUR }),
      }),
    ])['calendar.search']({ query: 'standup' }, ctx);
    expect((res as { result: { matches: unknown[] } }).result.matches).toEqual([]);
    expect(freshnessOf(res)[0]?.age_ms).toBe(30 * HOUR);
    expect(freshnessOf(res)[0]?.stale).toBe(true);
  });

  it('no calendar enrolled returns both empties', async () => {
    const res = await handlers([])['calendar.search']({}, ctx);
    expect((res as { result: { collections: unknown[] } }).result.collections).toEqual([]);
    expect(freshnessOf(res)).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────────
// 3. file.search — one instance, and the missing-health failure direction
// ────────────────────────────────────────────────────────────────

describe('D-237 P1 — file.search carries the file store verdict', () => {
  const fileCollection = (over: { health?: () => CollectionHealth } = {}) => ({
    get: () => ({
      record_id: 'f1',
      received_at: NOW,
      size_bytes: 10,
      hot_fields: { filename: 'a.pdf', media_class: 'document', size: 10 },
    }),
    list: () => [],
    ...(over.health ? { health: over.health } : {}),
  });

  it('rides the SESSION scope too — a lagging store silently shortens that list', async () => {
    // Session scope resolves attachments THROUGH the file collection, and a
    // referenced file whose record has not landed is skipped by design. So the
    // verdict qualifies the narrow scope as much as the wide one.
    const res = await handlers([], fileCollection({
      health: () => health({ platform: 'file', slug: 'received', pending_queue_size: 3 }),
    }))['file.search']({}, ctx);
    expect(freshnessOf(res)[0]?.collection_slug).toBe('received');
    expect(freshnessOf(res)[0]?.pending).toBe(3);
  });

  it('scope:"all" carries it as well', async () => {
    const res = await handlers([], fileCollection({
      health: () => health({ platform: 'file', slug: 'received' }),
    }))['file.search']({ scope: 'all' }, ctx);
    expect(freshnessOf(res)[0]?.stale).toBe(false);
  });

  it('⛔ a collection with NO health() reads STALE, never fresh', async () => {
    // The cast widens `health` in non-optional, deliberately: if the object
    // does not have it, the call throws INSIDE collectionSourceFreshnessOf's
    // try and yields never-synced. Fresh is the one answer this must never
    // invent, and this pins the direction rather than the mechanism.
    const res = await handlers([], fileCollection())['file.search']({}, ctx);
    expect(freshnessOf(res)[0]?.stale).toBe(true);
    expect(freshnessOf(res)[0]?.last_success_at).toBeNull();
  });

  it('no file store at all returns an EMPTY verdict list, not a fresh one', async () => {
    const res = await handlers([], undefined)['file.search']({}, ctx);
    expect(freshnessOf(res)).toEqual([]);
    expect((res as { result: { hint: string } }).result.hint).toContain('not available');
  });
});

// ────────────────────────────────────────────────────────────────
// 4. The descriptor — the false claim, ratcheted out
// ────────────────────────────────────────────────────────────────

describe('D-237 P1 — the catalog no longer asserts completeness it cannot deliver', () => {
  const descriptorFor = (name: 'mail.search' | 'calendar.search' | 'file.search'): string => {
    const d = TIER1_TOOL_DESCRIPTORS[name];
    expect(d, `descriptor for ${name}`).toBeDefined();
    return d.description;
  };

  it('⛔ mail.search no longer claims the mirror is COMPLETE', async () => {
    // The claim that made a bare empty result read as verified absence.
    expect(descriptorFor('mail.search')).not.toContain('mirrors fully into it');
  });

  it('⛔ neither mail nor calendar promises a `partial` flag its handler cannot emit', () => {
    // Measured: both handlers build a plain aggregate and never construct a
    // ScopeSearchResult, which is the only shape clampScopeSearchResult sets
    // `partial` / `partial_failures` on. Advertising an unreachable degradation
    // channel is worse than advertising none — the model waits for a signal
    // that cannot arrive.
    expect(descriptorFor('mail.search')).not.toContain('partial_failures');
    expect(descriptorFor('mail.search')).not.toContain('partial: true');
    expect(descriptorFor('calendar.search')).not.toContain('partial: true');
  });

  it('all three tell the model what to DO with the verdict, not just that it exists', () => {
    // ⚠ A field the model has not been told how to read is context it pays for
    //    and ignores — the prompt-optimization log's own standing invariant.
    for (const name of ['mail.search', 'calendar.search', 'file.search'] as const) {
      expect(descriptorFor(name), name).toContain('source_freshness');
    }
    expect(descriptorFor('mail.search')).toContain('NOT a verified absence');
    expect(descriptorFor('calendar.search')).toContain('NOT a verified absence');
    expect(descriptorFor('file.search')).toContain('may not have landed yet');
  });
});
