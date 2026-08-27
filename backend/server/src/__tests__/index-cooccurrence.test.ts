import { describe, expect, it } from 'vitest';

import { buildChatIndexContext, CHAT_INDEX_STORES } from '../chat-index-context.js';
import type { ChatDispatchResult } from '../chat-tool-handlers.js';

/** A fake warehouse: `store -> hitField -> the text of each record`. The probe
 *  below implements just enough FTS semantics to tell a CO-OCCURRENCE query
 *  (`"a"* "b"*`, implicit AND) from a single-term one. */
const FIELD = new Map(CHAT_INDEX_STORES.map(([s, f]) => [s, f]));
const AND_CAPABLE = new Map(CHAT_INDEX_STORES.map(([s, , a]) => [s, a]));

const makeProbe = (world: Record<string, string[]>) =>
  async (store: string, query: string): Promise<ChatDispatchResult> => {
    const docs = world[store] ?? [];
    // `"a"* "b"*` → every term must prefix-match the SAME record (implicit AND).
    const quoted = [...query.matchAll(/"([^"]+)"\*/g)].map((m) => m[1].toLowerCase());
    const terms = quoted.length > 0 ? quoted : [query.toLowerCase()];
    // ⛔ Model each store's REAL semantics. An AND-capable (FTS) store honours
    // every term; a substring store's loose rung is `some(...)` — ANY token —
    // so it answers a co-occurrence query as if it were an OR. The first
    // version of this double implemented ideal AND everywhere, which is why it
    // passed while the live run emitted a phrase entry naming a memory row that
    // held one of three terms.
    const match = AND_CAPABLE.get(store) === true
      ? (d: string) => terms.every((t) => d.toLowerCase().split(/\W+/).some((w) => w.startsWith(t)))
      : (d: string) => terms.some((t) => d.toLowerCase().split(/\W+/).some((w) => w.startsWith(t)));
    const rows = docs.filter(match);
    return {
      ok: true as const,
      result: { [FIELD.get(store) ?? 'matches']: rows.map((r) => ({ r })) },
    };
  };

const ctx = {} as never;

describe('co-occurrence collapse', () => {
  it('collapses to the phrase and DROPS the single-term entries for that store', async () => {
    // mail holds all three together; nothing else does.
    const line = await buildChatIndexContext(
      'sandhurst renewal notice',
      ctx,
      makeProbe({ 'mail.search': ['Sandhurst renewal notice period agreed'] }),
    );
    expect(line).toBe('sandhurst renewal notice: mail.search');
  });

  it('NEVER collapses a substring store, which cannot honour AND', async () => {
    // memory holds `sandhurst` only. Under a co-occurrence query its loose rung
    // matches ANY token, so it would report a hit — and the line would claim the
    // whole question lives there. It must appear as a single-term entry instead.
    const line = await buildChatIndexContext(
      'sandhurst renewal notice',
      ctx,
      makeProbe({
        'mail.search': ['Sandhurst renewal notice period agreed'],
        'memory.search': ['Sandhurst is managed by the northern team'],
      }),
    );
    expect(line).toBe('sandhurst renewal notice: mail.search; sandhurst: memory.search');
  });

  it('keeps single-term entries for stores where the terms do NOT co-occur', async () => {
    // mail has all three; memory only has `sandhurst`. memory must survive as a
    // single-term entry — collapsing it away would hide a real location.
    const line = await buildChatIndexContext(
      'sandhurst renewal notice',
      ctx,
      makeProbe({
        'mail.search': ['Sandhurst renewal notice period agreed'],
        'memory.search': ['Sandhurst is managed by the northern team'],
      }),
    );
    expect(line).toContain('sandhurst renewal notice: mail.search');
    expect(line).toContain('sandhurst: memory.search');
    // the collapsed store must not ALSO appear as a single-term entry
    expect(line).not.toMatch(/sandhurst: [^;]*mail\.search/);
  });

  it('falls back to single-term entries when nothing co-occurs', async () => {
    const line = await buildChatIndexContext(
      'sandhurst renewal notice',
      ctx,
      makeProbe({
        'mail.search': ['Sandhurst site badges'],
        'memory.search': ['renewal calendar for the northern team'],
      }),
    );
    expect(line).not.toContain('sandhurst renewal notice:');
    expect(line).toContain('sandhurst: mail.search');
    expect(line).toContain('renewal: memory.search');
  });

  it('reaches a morphological variant through the prefix form', async () => {
    // ⛔ The co-occurrence query is quoted-PREFIX (`"a"* "b"*`) precisely so it
    // stays strict (the relaxation rung skips FTS syntax) while still spanning
    // `Sandhursts`. A bare multi-word query would have been relaxed back into
    // the single-term answer and measured nothing.
    const line = await buildChatIndexContext(
      'sandhurst renewal',
      ctx,
      makeProbe({ 'mail.search': ['Sandhursts renewals were agreed'] }),
    );
    expect(line).toBe('sandhurst renewal: mail.search');
  });

  it('says nothing when no term is anywhere', async () => {
    expect(await buildChatIndexContext('sandhurst renewal', ctx, makeProbe({})))
      .toBeUndefined();
  });
});

describe('term ranking by discriminativeness', () => {
  /** Probe whose match COUNT differs per term, so ranking has something to sort. */
  const countingProbe = (counts: Record<string, number>) =>
    async (store: string, query: string): Promise<ChatDispatchResult> => {
      if (store !== 'mail.search') {
        return { ok: true as const, result: { matches: [] } };
      }
      const quoted = [...query.matchAll(/"([^"]+)"\*/g)].map((m) => m[1].toLowerCase());
      if (quoted.length > 0) return { ok: true as const, result: { matches: [] } };
      const n = counts[query.toLowerCase()] ?? 0;
      return { ok: true as const, result: { matches: Array.from({ length: n }, (_, i) => ({ i })) } };
    };

  it('puts the RAREST term first, not the one that appeared first', async () => {
    const line = await buildChatIndexContext(
      'prepping sandhurst badges',
      ctx,
      countingProbe({ prepping: 40, sandhurst: 9, badges: 2 }),
    );
    // `badges` is last in the sentence and rarest — it must lead.
    expect(line?.startsWith('badges: ')).toBe(true);
    expect(line).toBe('badges: mail.search; sandhurst: mail.search; prepping: mail.search');
  });

  it('indexes terms from the END of a long multi-task request', async () => {
    // ⛔ THE REGRESSION THIS GUARDS. At a probe cap of 4 this request indexed
    // `prepping, sandhurst, renewal, review` — a junk verb plus the opening
    // clause — and never probed `notice`, `period`, `badges` or `safety`, which
    // are the terms for three of its four sub-questions.
    const line = await buildChatIndexContext(
      "I'm prepping for the Sandhurst renewal review on Thursday. Remind me what "
      + 'notice period we agreed, whether the site badges came through, and what '
      + 'I said about the safety review.',
      ctx,
      countingProbe({ badges: 1, safety: 2, notice: 3, sandhurst: 30, prepping: 45 }),
    );
    for (const t of ['badges', 'safety', 'notice']) {
      expect(line, `${t} should reach the line`).toContain(`${t}: mail.search`);
    }
    // ⚠ `prepping` still appears here ONLY because just five terms were given
    // hits at all, so nothing crowds it out. What ranking guarantees is ORDER:
    // the sub-question terms lead and the junk verb trails. Against a real
    // warehouse `prepping` matches nothing and is dropped outright — the test
    // below covers that. Asserting its absence here would encode the fixture,
    // not the behaviour.
    expect(line?.indexOf('badges:')).toBeLessThan(line!.indexOf('prepping:'));
    expect(line?.indexOf('safety:')).toBeLessThan(line!.indexOf('prepping:'));
    expect(line?.indexOf('notice:')).toBeLessThan(line!.indexOf('prepping:'));
  });

  it('drops a term that matches nothing, however early it appears', async () => {
    const line = await buildChatIndexContext(
      'prepping sandhurst',
      ctx,
      countingProbe({ prepping: 0, sandhurst: 4 }),
    );
    expect(line).toBe('sandhurst: mail.search');
  });
});
