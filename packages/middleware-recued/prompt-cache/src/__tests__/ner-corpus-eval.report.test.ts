/** NER corpus eval — measures the deterministic `entity.name` extractor
 *  (and the date/time/email slots) against the recued-enrichment-benchmark
 *  use-case prompt corpus (`fixtures/use-case-inputs.jsonl`).
 *
 *  This is a *report* spec, not a pass/fail gate: it prints a table and
 *  writes machine-readable output + an FP-adjudication sample, asserting
 *  only that the fixture loaded and the harness ran. It skips cleanly when
 *  the sibling lab repo isn't checked out (CI-safe).
 *
 *  WHY THE METRIC IS REFRAMED (read before trusting the numbers):
 *   - The corpus `entities[]` is an LLM-extracted *salient-concept* set, NOT
 *     proper-name NER gold: ~40% start lowercase ("park cleanup"), ~19% are
 *     single tokens ("Sarah"). The regex `entity.name` targets ONLY 2+ -word
 *     capitalised runs, by design. So raw recall vs all `entities[]` is
 *     apples-to-oranges. We measure recall over the *addressable* subset
 *     (regex-matchable AND present in the prompt text) and precision as a
 *     FLOOR (labels are incomplete → unmatched emits go to a sample file for
 *     human adjudication, not auto-counted as wrong).
 *   - `date`/`time`/`email` are barely exercised (chat time is *relative* —
 *     "last night", not "2026-04-30"). We quantify that relative-time vector
 *     instead of pretending the absolute slots were tested.
 *
 *  Run:
 *    RECUED_BENCH_DIR=/abs/path/to/recued-enrichment-benchmark \
 *      npx vitest run prompt-cache/src/__tests__/ner-corpus-eval.report.test.ts
 *  (defaults to the sibling-repo relative path when the env var is unset.)
 */

import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { extract } from '../ner/index';

const HERE = dirname(fileURLToPath(import.meta.url));
const BENCH_DIR =
  process.env.RECUED_BENCH_DIR ??
  resolve(HERE, '../../../../../../recued-enrichment-benchmark');
const FIXTURE = resolve(BENCH_DIR, 'fixtures/use-case-inputs.jsonl');
const REPORT_DIR = resolve(HERE, '../../reports');

/** Mirror of `languages/en.ts` PROPER_NOUN_RUN_RE (non-global clone) — used
 *  ONLY to decide whether a gold entity is "regex-addressable in isolation",
 *  i.e. could the name slot ever match it. Non-circular: the recall numerator
 *  is what the NER emits *in context* (after its drop-rules), the denominator
 *  is what is matchable + present; the gap is drop-rule over-suppression. */
const PROPER_NOUN_RUN = /\b(?:[A-Z][a-z]+)(?:\s+[A-Z][a-z]+)+\b/;

/** Conservative relative-temporal-expression detector. A *lower bound* on
 *  chat temporal language: anchored multiword forms + the unambiguous
 *  day-deictics, deliberately excluding bare "now/soon/recently" to avoid
 *  inflation. The point is to size the vector the absolute date/time slots
 *  cannot reach (→ LLM per D-164 memory-recall), not to extract it. */
const REL_UNIT = '(?:second|minute|hour|day|week|weekend|month|quarter|year|spring|summer|fall|autumn|winter)';
const WEEKDAY = '(?:mon|tues|wednes|thurs|fri|satur|sun)day';
const RELATIVE_TIME = new RegExp(
  [
    '\\b(?:yesterday|today|tonight|tomorrow)\\b',
    `\\bthis (?:morning|afternoon|evening|past \\w+|${REL_UNIT}|${WEEKDAY})\\b`,
    `\\b(?:last|next|coming|past|previous) (?:${REL_UNIT}|${WEEKDAY}|night|few \\w+)\\b`,
    `\\b(?:a|an|one|two|three|four|five|\\d+|few|couple|several) ${REL_UNIT}s? (?:ago|from now|back|earlier|prior)\\b`,
    `\\bin (?:the )?(?:last|past|next|coming|previous) (?:\\d+|few|couple|several) ${REL_UNIT}s?\\b`,
    `\\bover the (?:last|past|next) ${REL_UNIT}s?\\b`,
    '\\bq[1-4]\\b',
    '\\b(?:the other day|these days|right now|just now|moments? ago|of late|so far this \\w+)\\b',
    `\\bsince (?:yesterday|this morning|last \\w+|the \\w+)\\b`,
  ].join('|'),
  'i',
);

interface Question {
  prompt: string;
  action?: string;
  entities?: string[];
  paraphrases?: string[];
}
interface Row { questions?: Question[] }

const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim();
/** match relation between an emitted name and a gold label (both normed):
 *  exact, or either contains the other (handles "neptune apex" ⊆
 *  "neptune apex controller"). */
const related = (a: string, b: string): boolean =>
  a === b || a.includes(b) || b.includes(a);

const pct = (n: number, d: number): string =>
  d === 0 ? 'n/a' : `${((100 * n) / d).toFixed(1)}%`;

describe.skipIf(!existsSync(FIXTURE))('NER corpus eval (use-case-inputs.jsonl)', () => {
  it('measures entity.name P/R + slot exercise + relative-time vector', () => {
    const rows = readFileSync(FIXTURE, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Row);

    // --- accumulators -------------------------------------------------------
    let nQ = 0;
    let promptTexts = 0;        // canonical prompts scored for name P/R
    let allTexts = 0;          // prompts + paraphrases (slot-occurrence basis)

    // entity.name precision (over emits) / recall (over addressable gold)
    let emitTotal = 0, tpPrec = 0, fpCand = 0;
    let goldAddrPresent = 0, tpRecall = 0, fn = 0;
    let emptyEntityQ = 0, emptyEntityFires = 0;

    // other slots (prompt + paraphrase basis)
    let emailFires = 0, dateFires = 0, timeFires = 0;
    let textsWithRelTime = 0, promptsWithRelTime = 0;

    const fpFreq = new Map<string, number>();
    const fnFreq = new Map<string, number>();
    const relSamples: string[] = [];

    const slotKinds = (t: string) => {
      const r = extract(t);
      const names: string[] = [];
      if (r) {
        for (const s of r.slots) {
          if (s.kind === 'entity.name') names.push(norm(s.value));
          else if (s.kind === 'entity.email') emailFires++;
          else if (s.kind === 'date') dateFires++;
          else if (s.kind === 'time') timeFires++;
        }
      }
      return names;
    };

    for (const row of rows) {
      for (const q of row.questions ?? []) {
        nQ++;
        const gold = (q.entities ?? []).map((e) => ({ raw: e, n: norm(e) }));

        // ---- slot-occurrence + relative-time over prompt + paraphrases ----
        const texts = [q.prompt, ...(q.paraphrases ?? [])].filter(Boolean);
        for (const t of texts) {
          allTexts++;
          if (RELATIVE_TIME.test(t)) {
            textsWithRelTime++;
            if (relSamples.length < 30 && t === q.prompt) relSamples.push(t);
          }
        }
        if (q.prompt && RELATIVE_TIME.test(q.prompt)) promptsWithRelTime++;

        // ---- name P/R over the canonical prompt only ----------------------
        if (!q.prompt) continue;
        promptTexts++;
        const pn = norm(q.prompt);
        const emits = slotKinds(q.prompt); // also increments email/date/time

        // precision: each emit matched against ALL gold labels
        for (const e of emits) {
          emitTotal++;
          if (gold.some((g) => related(e, g.n))) tpPrec++;
          else {
            fpCand++;
            fpFreq.set(e, (fpFreq.get(e) ?? 0) + 1);
          }
        }

        // recall: addressable gold = regex-matchable AND present in prompt text
        const addressable = gold.filter(
          (g) => PROPER_NOUN_RUN.test(g.raw) && pn.includes(g.n),
        );
        for (const g of addressable) {
          goldAddrPresent++;
          if (emits.some((e) => related(e, g.n))) tpRecall++;
          else {
            fn++;
            fnFreq.set(g.raw, (fnFreq.get(g.raw) ?? 0) + 1);
          }
        }

        // empty-entities FP probe: labeler found no salient entity
        if (gold.length === 0 && emits.length > 0) {
          emptyEntityQ++;
          emptyEntityFires += emits.length;
        }
      }
    }

    const top = (m: Map<string, number>, k: number) =>
      [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, k);

    const report = {
      fixture: FIXTURE,
      questions: nQ,
      prompts_scored: promptTexts,
      texts_incl_paraphrase: allTexts,
      entity_name: {
        emit_total: emitTotal,
        precision_floor: pct(tpPrec, emitTotal),
        precision_floor_raw: emitTotal === 0 ? null : tpPrec / emitTotal,
        tp_emit: tpPrec,
        fp_candidates: fpCand,
        distinct_fp_candidates: fpFreq.size,
        addressable_gold_in_prompt: goldAddrPresent,
        recall_addressable: pct(tpRecall, goldAddrPresent),
        recall_addressable_raw: goldAddrPresent === 0 ? null : tpRecall / goldAddrPresent,
        false_negatives: fn,
      },
      empty_entity_probe: {
        questions_with_no_label_but_a_fire: emptyEntityQ,
        total_fires: emptyEntityFires,
      },
      absolute_slots_exercise: {
        email_fires: emailFires,
        date_fires: dateFires,
        time_fires: timeFires,
        note: 'prompt-scored for name P/R basis; email/date/time counted across all extract() calls',
      },
      relative_time_vector: {
        prompts_with_relative_time: promptsWithRelTime,
        prompts_total: promptTexts,
        prompts_pct: pct(promptsWithRelTime, promptTexts),
        texts_with_relative_time: textsWithRelTime,
        texts_total: allTexts,
        texts_pct: pct(textsWithRelTime, allTexts),
        comparison: `relative-time prompts (${promptsWithRelTime}) vs absolute date+time fires (${dateFires + timeFires})`,
      },
      top_fp_candidates: top(fpFreq, 25),
      top_false_negatives: top(fnFreq, 25),
      relative_time_samples: relSamples,
    };

    mkdirSync(REPORT_DIR, { recursive: true });
    writeFileSync(
      resolve(REPORT_DIR, 'ner-corpus-eval.json'),
      JSON.stringify(report, null, 2),
    );
    writeFileSync(
      resolve(REPORT_DIR, 'ner-fp-sample.txt'),
      top(fpFreq, 200).map(([s, c]) => `${String(c).padStart(4)}  ${s}`).join('\n') + '\n',
    );

    // --- console headline ---------------------------------------------------
    /* eslint-disable no-console */
    console.log('\n===== NER corpus eval =====');
    console.log(`fixture: ${FIXTURE}`);
    console.log(`questions: ${nQ} | prompts scored: ${promptTexts} | +paraphrase texts: ${allTexts}`);
    console.log('\n-- entity.name --');
    console.log(`emits: ${emitTotal} | precision FLOOR: ${report.entity_name.precision_floor} (TP ${tpPrec} / FP-cand ${fpCand}, ${fpFreq.size} distinct)`);
    console.log(`addressable gold in prompt: ${goldAddrPresent} | recall: ${report.entity_name.recall_addressable} (FN ${fn})`);
    console.log(`empty-label prompts that still fired: ${emptyEntityQ} (${emptyEntityFires} fires)`);
    console.log('\n-- absolute slots (barely exercised) --');
    console.log(`email: ${emailFires} | date: ${dateFires} | time: ${timeFires}`);
    console.log('\n-- relative-time vector --');
    console.log(`prompts w/ relative time: ${promptsWithRelTime}/${promptTexts} (${report.relative_time_vector.prompts_pct})`);
    console.log(`vs absolute date+time fires: ${dateFires + timeFires}`);
    console.log('\ntop FP candidates:', JSON.stringify(top(fpFreq, 12)));
    console.log('top false negatives:', JSON.stringify(top(fnFreq, 12)));
    console.log(`\nwrote ${resolve(REPORT_DIR, 'ner-corpus-eval.json')}`);
    console.log(`wrote ${resolve(REPORT_DIR, 'ner-fp-sample.txt')}\n`);
    /* eslint-enable no-console */

    // sanity guards only — this is a measurement, not a gate
    expect(nQ).toBeGreaterThan(1000);
    expect(emitTotal).toBeGreaterThan(0);
  });
});

/** Lowercase-robustness probe. The corpus capitalises names; casual chat
 *  doesn't ("did maya chen reply?"). The `entity.name` regex hard-requires
 *  `[A-Z][a-z]+`, so a lowercased name is structurally invisible. This
 *  holds the addressable denominator FIXED (computed on the original
 *  capitalised prompt) and re-runs the NER over down-cased variants to
 *  size the recall cliff. email/date/time are case-insensitive (digit /
 *  lowercase-TLD shapes) → the cliff is a name-slot phenomenon only. */
describe.skipIf(!existsSync(FIXTURE))('NER lowercase robustness probe', () => {
  it('sizes the casual-chat recall cliff as name casing degrades', () => {
    const rows = readFileSync(FIXTURE, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Row);

    const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const hash = (s: string): number => {
      let h = 5381;
      for (let i = 0; i < s.length; i += 1) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
      return h;
    };

    interface Gold { raw: string; n: string }
    const addressableOf = (q: Question): Gold[] => {
      if (!q.prompt) return [];
      const pn = q.prompt.toLowerCase();
      return (q.entities ?? [])
        .map((e) => ({ raw: e, n: norm(e) }))
        .filter((g) => PROPER_NOUN_RUN.test(g.raw) && pn.includes(g.n));
    };

    const recallUnder = (
      transform: (prompt: string, gold: Gold[]) => string,
    ): { addr: number; tp: number; recall: number; nameEmits: number } => {
      let addr = 0;
      let tp = 0;
      let nameEmits = 0;
      for (const row of rows) {
        for (const q of row.questions ?? []) {
          const gold = addressableOf(q);
          if (gold.length === 0 || !q.prompt) continue;
          const r = extract(transform(q.prompt, gold));
          const emits = r
            ? r.slots.filter((s) => s.kind === 'entity.name').map((s) => norm(s.value))
            : [];
          nameEmits += emits.length;
          for (const g of gold) {
            addr += 1;
            if (emits.some((e) => related(e, g.n))) tp += 1;
          }
        }
      }
      return { addr, tp, recall: addr === 0 ? 0 : tp / addr, nameEmits };
    };

    // Down-case a deterministic `frac`% of a prompt's gold-name occurrences.
    const lowerNames = (p: string, gold: Gold[], frac: number, seed: string): string => {
      let t = p;
      for (const g of gold) {
        if (hash(seed + g.raw) % 100 < frac) {
          t = t.replace(new RegExp(escapeRe(g.raw), 'gi'), (m) => m.toLowerCase());
        }
      }
      return t;
    };

    const pct = (x: number): string => `${(100 * x).toFixed(1)}%`;
    const identity = recallUnder((p) => p);
    const allLower = recallUnder((p) => p.toLowerCase());
    const namesAll = recallUnder((p, g) => lowerNames(p, g, 100, 'all'));
    const sweep = [0, 25, 50, 75, 100].map((frac) => ({
      frac,
      ...recallUnder((p, g) => lowerNames(p, g, frac, 'cliff')),
    }));

    const report = {
      addressable_denominator: identity.addr,
      scenarios: {
        identity_capitalised: { recall: pct(identity.recall), name_emits: identity.nameEmits },
        all_lowercase_prompt: { recall: pct(allLower.recall), name_emits: allLower.nameEmits },
        names_only_lowercased: { recall: pct(namesAll.recall), name_emits: namesAll.nameEmits },
      },
      casing_noise_sweep: sweep.map((s) => ({
        pct_names_lowercased: s.frac,
        recall: pct(s.recall),
      })),
      note: 'email/date/time are case-insensitive → unaffected; the cliff is entirely the entity.name regex requiring [A-Z][a-z]+.',
    };
    mkdirSync(REPORT_DIR, { recursive: true });
    writeFileSync(
      resolve(REPORT_DIR, 'ner-lowercase-probe.json'),
      JSON.stringify(report, null, 2),
    );

    /* eslint-disable no-console */
    console.log('\n===== NER lowercase robustness =====');
    console.log(`addressable denominator: ${identity.addr}`);
    console.log(`identity (capitalised):   ${pct(identity.recall)}  (${identity.nameEmits} name emits)`);
    console.log(`all-lowercase prompt:     ${pct(allLower.recall)}  (${allLower.nameEmits} name emits)`);
    console.log(`names-only lowercased:    ${pct(namesAll.recall)}  (${namesAll.nameEmits} name emits)`);
    console.log('casing-noise sweep (% of names lowercased → recall):');
    for (const s of sweep) console.log(`  ${String(s.frac).padStart(3)}% → ${pct(s.recall)}`);
    /* eslint-enable no-console */

    expect(identity.recall).toBeGreaterThan(0.9); // reproduces the main report
    expect(allLower.recall).toBeLessThan(0.05); // the cliff is real
  });
});
