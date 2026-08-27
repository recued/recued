import { describe, expect, it } from 'vitest';

import {
  buildChatIndexContext,
  distinctiveTerms,
  CHAT_INDEX_STORES,
} from '../chat-index-context.js';
import type { ChatDispatchResult } from '../chat-tool-handlers.js';

/** A fake warehouse: `store -> hitField -> the text of each record`. The probe
 *  below implements just enough FTS semantics to tell a CO-OCCURRENCE query
 *  (`"a"* "b"*`, implicit AND) from a single-term one. */
const FIELD = new Map(CHAT_INDEX_STORES.map(([s, f]) => [s, f]));
const AND_MODE = new Map(CHAT_INDEX_STORES.map(([s, , m]) => [s, m]));

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
    // ⛔ Model each store's REAL semantics per its `ChatIndexAndMode`. `'fts'`
    // and `'terms'` both mean EVERY term must hit — they differ only in the
    // query DIALECT, which the caller has already applied. `'none'` degrades to
    // ANY term, which is the whole reason those stores are excluded from the
    // collapse.
    const mode = AND_MODE.get(store);
    const match = mode === 'fts' || mode === 'terms'
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

describe('non-English term extraction', () => {
  /** ⛔ The split was `[^a-z0-9'-]+`, so every non-ASCII character was a
   *  SEPARATOR. That did not merely skip non-English text — it CORRUPTED it,
   *  and a corrupted fragment can match an UNRELATED record, which is a false
   *  lead rather than a silent miss. Regression-guarded per language. */
  it('keeps accented Latin words whole', () => {
    expect(distinctiveTerms('Quel préavis pour le renouvellement Sandhurst ?'))
      .toContain('préavis');                       // was 'avis' — a different word
    expect(distinctiveTerms('Welche Kündigungsfrist haben wir vereinbart?'))
      .toContain('kündigungsfrist');               // was 'ndigungsfrist'
    expect(distinctiveTerms('¿Qué plazo para la renovación de Sandhurst?'))
      .toContain('renovación');                    // was 'renovaci'
  });

  it('extracts Cyrillic words', () => {
    const t = distinctiveTerms('Какой срок уведомления мы согласовали?');
    expect(t).toContain('уведомления');            // was dropped entirely
    expect(t.length).toBeGreaterThan(2);
  });

  it('does not shatter a hyphenated compound at its accent', () => {
    expect(distinctiveTerms('die Sandhurst-Verlängerung'))
      .toContain('sandhurst-verlängerung');        // was 'sandhurst-verl' + 'ngerung'
  });

  it('CJK reaches the QUERY side but only three stores can use it', () => {
    // ⚠ The limit moved rather than vanished, so the test states where it now
    // sits. Query side: solved, below. Stored side: FTS5's `unicode61` makes an
    // unspaced run ONE token, so `mail` / `calendar` / `memory` match a CJK term
    // only at the START of a run, while `recall` / `file` / `contact` match by
    // JS substring or SQL LIKE and work fully.
    //
    // ⛔ And the textbook FTS fix is a trap: the `trigram` tokenizer has a
    // THREE-CHARACTER floor — measured, `续约` and `通知` return 0 while `通知期`
    // returns 1 — and two characters is the most common Chinese word length, so
    // it misses precisely the words a corpus is made of.
    const t = distinctiveTerms('Sandhurst 续约的通知期我们商定了多久？');
    expect(t).toContain('sandhurst');
    expect(
      t.some((x) => x.length > 6 && /[一-鿿]/.test(x)),
      'no term may still be an unsegmented multi-word run',
    ).toBe(false);
  });
  it('SEGMENTS CJK instead of emitting one unmatchable run', () => {
    // Before: the whole clause came back as a single token that matches
    // nothing, so the index was inert for a CJK owner while shipped ON.
    // `Intl.Segmenter` is native (ICU) — no dependency, no corpus.
    expect(distinctiveTerms('续约的通知期我们商定了多久')).toContain('续约');
    expect(distinctiveTerms('续约的通知期我们商定了多久')).toContain('通知');
    expect(distinctiveTerms('更新通知期間は何日で合意しましたか')).toContain('期間');
    expect(distinctiveTerms('샌드허스트 갱신 통지 기간은')).toContain('갱신');
  });

  it('leaves the LATIN path byte-identical — the measured path must not move', () => {
    // ⛔ `Intl.Segmenter` is applied ONLY to terms that carry CJK. It breaks
    // Latin on its own rules (apostrophes, hyphens), and re-tokenising there
    // would silently invalidate every measurement the index was promoted on.
    expect(distinctiveTerms('what payment terms did we agree with thornfield'))
      .toEqual(['payment', 'terms', 'agree', 'thornfield']);
    // `通知期` segments to `通知` + `期`; the 1-char tail is below the CJK
    // floor, so the emitted pair is `续约` + `通知`.
    expect(distinctiveTerms('Sandhurst 续约通知期'))
      .toEqual(['sandhurst', '续约', '通知']);
  });

  it('KEEPS a pure-digit term — the number is often the whole question', () => {
    // ⛔ These were dropped, justified as "`2024` indexes nothing" — reasoning
    // from the weakest number to a rule over all of them. In both of these the
    // digits are the single most distinctive thing in the sentence, and the
    // index kept only the generic noun beside them. Commonness is handled
    // downstream by the too-common cap, on evidence rather than on shape.
    expect(distinctiveTerms('what did we agree on invoice 88421')).toContain('88421');
    expect(distinctiveTerms('chase order 4471193 with the supplier')).toContain('4471193');
  });
});
describe('which scripts the index answers for', () => {
  const probe = async () => ({ ok: true as const, result: { matches: [{}] } });
  const line = (m: string) => buildChatIndexContext(m, {} as never, probe as never);

  it('answers for UNSPACED scripts too, now the stored side is fixed', async () => {
    // ⛔ HISTORY, KEPT BECAUSE THE SET IS EASY TO GET WRONG. These were refused
    // for one day — not because they failed but because they were INCOMPLETE
    // under `unicode61`, which matches an unspaced term only where it begins a
    // run. `FTS_CONTENT_FORMAT` 2 segments the stored side per grapheme, so the
    // refusal was lifted rather than tuned.
    //
    // ⚠ The set itself was wrong in BOTH directions when it was spelled "CJK":
    // Hangul was in it and is space-separated (so it never needed either the
    // refusal or the fix), and Thai / Lao / Khmer were absent and had the
    // identical failure. Probing a real index is what settled it; the shape of
    // the script is not the test.
    for (const m of [
      '续约的通知期我们商定了多久',
      '更新通知期間は何日で合意しましたか',
      'ระยะเวลาแจ้งล่วงหน้าคือกี่วัน',
      'Sandhurst 续约通知期',
    ]) expect(await line(m), `must render: ${m}`).toBeDefined();
  });

  it('ANSWERS for spaced scripts, Korean included', async () => {
    // ⛔ Korean was suppressed and must not be. It IS space-separated, so
    // `unicode61` tokenizes it correctly — verified against a real index, a
    // mid-run `갱신` scores exact=1. Suppressing it bought nothing.
    for (const m of [
      '샌드허스트 갱신 통지 기간은 며칠로 합의했나요',  // Hangul
      'какой срок уведомления мы согласовали',      // Cyrillic
      'quel préavis avons-nous convenu',            // accented Latin
      'अनुबंध की सूचना अवधि कितने दिन है',              // Devanagari
      'ما هي مدة الإشعار في العقد',                    // Arabic
    ]) expect(await line(m), `must render: ${m}`).toBeDefined();
  });

  it('⛔ COMBINING MARKS ARE PART OF THE WORD — five scripts were INERT', async () => {
    // `\p{M}` was missing from the split, so every Thai tone mark, Indic matra,
    // Arabic harakat and Hebrew niqqud acted as a separator — the same bug the
    // ASCII-only class had, one layer down. The Indic and Semitic cases did not
    // degrade, they returned NOTHING: each fragment fell under the Latin
    // minimum length. Silently inert, while shipped ON.
    expect(distinctiveTerms('अनुबंध की सूचना अवधि कितने दिन है')).toContain('सूचना');
    expect(distinctiveTerms('চুক্তির নোটিশ সময়কাল কত দিন')).toContain('নোটিশ');
    expect(distinctiveTerms('ஒப்பந்த அறிவிப்பு காலம்')).toContain('அறிவிப்பு');
    expect(distinctiveTerms('מהו משך ההודעה בחוזה')).toContain('משך');
    // Thai shattered rather than vanished: `แจ้ง` came back as `แจ` + `ง`.
    expect(distinctiveTerms('ระยะเวลาแจ้งล่วงหน้า')).toContain('แจ้ง');
  });
});

describe('the co-occurrence probe speaks each store\'s OWN dialect', () => {
  it('sends FTS5 syntax to an fts store and PLAIN TERMS to a terms store', async () => {
    // 🔑 THIS IS THE INDEX'S "TIER 2": one probe asking whether a single store
    // holds ALL the words, so the line can collapse to `a b c: mail.search`
    // instead of naming each word separately.
    //
    // ⛔ THE FLAG USED TO BE A BOOLEAN, WHICH HID THAT IT IS ABOUT SYNTAX TOO.
    // `mail` / `calendar` parse FTS5 and get implicit AND for free. `file.search`
    // now requires every term over name+path — it is genuinely AND-capable —
    // but reads a query as PLAIN TEXT, so the FTS form would have it hunting for
    // literal quotes and asterisks and matching nothing. The collapse would have
    // silently never fired for it and the flag would have looked like a no-op.
    const seen = new Map<string, string[]>();
    const probe = async (store: string, query: string) => {
      const qs = seen.get(store) ?? [];
      qs.push(query);
      seen.set(store, qs);
      return { ok: true as const, result: { [FIELD.get(store) ?? 'matches']: [{ hit: 1 }] } };
    };
    await buildChatIndexContext('thornfield payment terms', ctx, probe as never);

    const multi = (store: string): string[] =>
      (seen.get(store) ?? []).filter((q) => q.split(/\s+/).length > 1);

    const ftsQ = multi('mail.search');
    expect(ftsQ.length, 'an fts store must get a co-occurrence probe').toBeGreaterThan(0);
    expect(ftsQ[0], 'and it must be FTS5 quoted-prefix form').toMatch(/^"[^"]+"\*( "[^"]+"\*)+$/);

    const termsQ = multi('file.search');
    expect(termsQ.length, 'a terms store must get one too').toBeGreaterThan(0);
    expect(termsQ[0], 'but as PLAIN words — no quotes, no asterisks').not.toMatch(/["*]/);
    expect(termsQ[0]?.split(/\s+/).length).toBeGreaterThan(1);

    // ⛔ And a `'none'` store must never be asked the question at all — it would
    // answer OR and the index would claim it holds the whole sentence.
    expect(
      multi('memory.search'),
      'a store that degrades to OR must not receive a co-occurrence probe',
    ).toHaveLength(0);
    expect(multi('recall.search')).toHaveLength(0);
    expect(multi('contact.search')).toHaveLength(0);
  });
});
