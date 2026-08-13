/* The depth-vs-breadth budget pilot, kept as a GUARD rather than prose.
 *
 * I proposed spending the 16 KB recall budget on DEPTH when `match` is precise
 * and BREADTH when it is `loose`, and pre-registered it as needing an A/B. Two
 * deterministic probes killed it before any model call, and both conclusions
 * are properties of the CURRENT code — so they belong in a test, where a change
 * that invalidates them says so, not in a document that quietly goes stale.
 *
 * ⛔ These were originally committed as standalone scripts under `tools/pilots/`
 * and correctly reddened the D-212 encryption chokepoint ratchets: they open
 * SQLite and build blob stores directly, which production source may not do.
 * The fix is to be a TEST — excluded from that walk by KIND — never to add a
 * `.pilot.ts` exemption, which would hand every future file with that suffix a
 * hole in an at-rest-encryption guard.
 *
 * ⚠ The corpus below is SYNTHETIC and I wrote both the questions and the
 * answers, which bounds its difficulty and flatters lexical search. The
 * conclusions rest on the SHAPE (entry length, vocabulary overlap), not on the
 * particular wording. Re-run against a real pool before trusting the ratios.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createUserMemoryStore, type UserMemoryRow } from '../user-memory-store.js';
import { createSQLiteCollection } from '../sqlite-collection.js';
import { createBlobStore } from '../storage/blob-store.js';
import { buildChatTier1Handlers } from '../chat-tool-handlers.js';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) {
    try { rmSync(dirs.pop()!, { recursive: true, force: true }); } catch { /* gone */ }
  }
});

const newPool = () => {
  const dir = mkdtempSync(join(tmpdir(), 'alloc-pilot-'));
  dirs.push(dir);
  const db = new Database(join(dir, 'w.db'));
  return createUserMemoryStore(
    createSQLiteCollection<UserMemoryRow>(db, 'user_memory'),
    createBlobStore(join(dir, 'memory_blobs')),
    { db },
  );
};

const search = async (store: ReturnType<typeof newPool>, query: string) => {
  const h = buildChatTier1Handlers({
    getAuditLog: () => ({ listRecent: vi.fn(), listByRecipe: vi.fn() }) as never,
    getUserMemoryStore: () => store,
    getOpAdmissionGate: () => ({ isOpGranted: () => true }) as never,
  } as never);
  return (await h['memory.search']!(
    { query },
    { channel: 'internal_function_call', execution_source: { actor: 'user_self' } } as never,
  )) as any;
};

/** Fill a pool with `count` entries of roughly `bodyBytes`, all matching one term. */
const poolOf = async (count: number, bodyBytes: number) => {
  const store = newPool();
  for (let i = 0; i < count; i++) {
    await store.create({
      kind: 'note',
      summary: `Entry ${i} pilotterm`,
      body: `pilotterm ${'x'.repeat(Math.max(0, bodyBytes - 20))}`,
    });
  }
  return store;
};

describe('memory.search allocation — why depth-vs-breadth is not a live question', () => {
  it('⛔ at ordinary Q&A sizes the budget NEVER BINDS — the two arms are identical', async () => {
    // The motivating corpus is short product Q&A. Every page entry gets its
    // body, so "spend the budget on breadth instead" is a byte-for-byte no-op
    // and an A/B over it would measure nothing.
    for (const bodyBytes of [200, 500]) {
      const res = await search(await poolOf(40, bodyBytes), 'pilotterm');
      const mem = res.result.memories as Array<{ body?: string }>;
      expect(mem.length, `${bodyBytes}B page`).toBe(20);
      expect(
        mem.filter((m) => m.body !== undefined).length,
        `${bodyBytes}B: every page entry should carry a body`,
      ).toBe(20);
      expect(res.result.budget.used_bytes).toBeLessThan(res.result.budget.limit_bytes);
    }
  });

  it('the budget only binds on KB-article-sized entries', async () => {
    // Where the arms differ at all: some entries get bodies, some previews.
    const res = await search(await poolOf(40, 4_000), 'pilotterm');
    const mem = res.result.memories as Array<{ body?: string }>;
    const withBody = mem.filter((m) => m.body !== undefined).length;
    expect(withBody).toBeGreaterThan(0);
    expect(withBody).toBeLessThan(mem.length);
  });

  it('⛔ the PAGE is fixed regardless of the budget — "breadth" cannot add rows', async () => {
    // This is why the treatment was mis-specified: the budget decides how many
    // of the 20 rows carry bodies, never how many rows there are. Breadth can
    // therefore only mean FEWER BODIES for the same rows — a strict subset of
    // depth, with no mechanism by which it helps.
    const small = await search(await poolOf(40, 200), 'pilotterm');
    const large = await search(await poolOf(40, 12_000), 'pilotterm');
    expect(small.result.memories.length).toBe(large.result.memories.length);
  });
});

/** A synthetic product KB with heavy vocabulary overlap, and questions whose
 *  correct answer is known. Enough to ask: does the ranker ever bury the right
 *  entry past the page? */
const KB: Array<{ q: string; a: string }> = [
  { q: 'How do I get a refund?', a: 'Request a refund from Billing settings within 30 days of the charge.' },
  { q: 'Can I cancel my subscription?', a: 'Cancel any time from Billing settings; the plan stays active until the period ends.' },
  { q: 'How much does the Pro plan cost?', a: 'Pro is 5.99 per month per seat, billed monthly.' },
  { q: 'What happens when a payment fails?', a: 'A failed payment triggers three retries over ten days, then a grace period.' },
  { q: 'How do I update my payment method?', a: 'Billing settings, Payment method, Replace card.' },
  { q: 'How do I reset my password?', a: 'Click Forgot password on the sign-in screen and follow the emailed link.' },
  { q: 'Can I delete my account?', a: 'Account settings, Delete account. Deletion is irreversible after a 14 day hold.' },
  { q: 'How do I export my data?', a: 'Use Export from the Data page. The archive round-trips back through Import.' },
  { q: 'What are the API rate limits?', a: 'The API allows 600 requests per minute per token.' },
  { q: 'How do I connect my CRM?', a: 'Connections page, Add connection, pick the vendor and paste your OAuth credentials.' },
  { q: 'Why is my calendar not syncing?', a: 'Check the connection has not expired, then run a manual sync from the Data page.' },
  { q: 'How do I contact support?', a: 'Email support from the address on your account.' },
];

const PROBES: Array<{ ask: string; answer: number }> = [
  { ask: 'How do I get my money back?', answer: 0 },
  { ask: 'I want to cancel my subscription', answer: 1 },
  { ask: 'How much is Pro?', answer: 2 },
  { ask: 'What happens if my card is declined?', answer: 3 },
  { ask: 'How do I change my credit card?', answer: 4 },
  { ask: 'I forgot my password', answer: 5 },
  { ask: 'How do I delete everything?', answer: 6 },
  { ask: 'How do I export my data?', answer: 7 },
  { ask: 'What are the rate limits on the API?', answer: 8 },
  { ask: 'How do I connect HubSpot?', answer: 9 },
  { ask: 'My calendar is not syncing', answer: 10 },
  { ask: 'How do I reach support?', answer: 11 },
];

describe('memory.search ranking — the page size is not the binding constraint', () => {
  it('⛔ the correct entry is never past the page, so a BIGGER PAGE recovers nothing', async () => {
    const store = newPool();
    const ids: string[] = [];
    for (const e of KB) ids.push((await store.create({ kind: 'faq', summary: e.q, body: e.a })).memory_id);
    // Vocabulary-overlapping filler so the target has real competition.
    for (const theme of ['billing', 'plan', 'account', 'data', 'connection', 'support']) {
      for (let i = 0; i < 11; i++) {
        await store.create({
          kind: 'faq',
          summary: `About ${theme} topic ${i}`,
          body: `Covers ${theme} handling and ${theme} settings for an account on a paid plan.`,
        });
      }
    }

    let pastPage = 0;
    let onPage = 0;
    for (const p of PROBES) {
      // Ask far past a page so the TRUE rank is visible rather than censored by
      // the page size under evaluation.
      const found = await store.search(p.ask, 500);
      const rank = found.hits.findIndex((h) => h.memory_id === ids[p.answer]) + 1;
      if (rank === 0) continue;            // unfound — helped by neither arm
      if (rank > 20) pastPage++; else onPage++;
    }
    expect(onPage).toBeGreaterThan(PROBES.length / 2); // the probes are answerable
    expect(pastPage, 'a correct entry beyond the page would justify breadth').toBe(0);
  });
});
