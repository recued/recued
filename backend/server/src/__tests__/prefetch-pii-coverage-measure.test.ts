/** D-167 Prefetch PII Coverage Expansion — Phase A MEASUREMENT harness.
 *
 *  NOT a CI gate (skips when slow / corpus-absent — see GUARD below). A
 *  reproducibility artifact in the spirit of `fts-prefetch-probe.mjs`: it
 *  reports the three numbers the build is gated on
 *  (`docs/d-167-prefetch-pii-coverage-design.md` §6):
 *
 *    M1. Warehouse PII cardinality model — row count + field-presence
 *        distribution (email/phone/name-token-count/company), the inputs that
 *        drive both the scan cost and the false-positive surface.
 *    M2. Prefetch scan latency — the REAL `createContactPrefetchSearch`
 *        adapter (current) at N = 500…50k, plus an UNCLAMPED broadened scan
 *        (company tokens + full-canonical-value build) to estimate the
 *        marginal cost of B1/B4 and the true linear cost if the store's
 *        `MAX_LIMIT=1000` list clamp is lifted.
 *    M3. Name/org false-positive rate — seed the FULL canonical value
 *        (design D3) for the targeted top-K matches of each real corpus
 *        message into a real ledger, run the REAL `scanContent` containment
 *        (design D4), and count common-word mis-aliases, broken down by
 *        multi-token vs single-token and by per-value corpus frequency.
 *
 *  Run it (captures the report to stdout):
 *    scripts/vitest.sh backend/server/src/__tests__/prefetch-pii-coverage-measure.test.ts
 *  Optional: point at a corpus other than the sibling enrichment bench:
 *    RECUED_PREFETCH_MEASURE=1 RECUED_BENCH_DIR=/abs/path scripts/vitest.sh <this>
 *
 *  GUARD: the latency + FP blocks are heavy + need the bench corpus, so they
 *  run only under `RECUED_PREFETCH_MEASURE=1`. Default `npm run ci` skips them
 *  (the file still type-checks + the cardinality block runs as a fast sanity).
 */

import Database from 'better-sqlite3';
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, appendFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

import { createContactStore, type ContactStore } from '../storage/contact-store.js';
import { createContactPrefetchSearch } from '../chat-prefetch-search.js';
import {
  decomposeToTokens,
  extractPhoneRuns,
  extractEmailRuns,
  shouldSeedEntityValue,
} from '@recued/middleware-prompt-cache';
import { createLedger } from '@recued/transforms';
// Deep import — `scanContent` / `getOrAllocate` are the substrate primitives
// (not in the package root export). The vitest alias maps `@recued/transforms`
// → `packages/transforms/src`, so the deep path resolves the source directly.
import { scanContent, getOrAllocate } from '@recued/transforms/pii-alias.js';

const RUN = process.env.RECUED_PREFETCH_MEASURE === '1';
const HERE = dirname(fileURLToPath(import.meta.url));
const BENCH =
  process.env.RECUED_BENCH_DIR ??
  resolve(HERE, '../../../../../recued-enrichment-benchmark');
const CORPUS = resolve(BENCH, 'fixtures/compound-prompt-inputs.jsonl');

// Vitest 4 intercepts console.log, so the report is also appended to a file
// for reliable capture. Path overridable via RECUED_PREFETCH_REPORT.
const REPORT = process.env.RECUED_PREFETCH_REPORT ?? '/tmp/prefetch-pii-measure.txt';
if (RUN) writeFileSync(REPORT, `prefetch PII coverage measurement\n`);
const log = (s = ''): void => {
  console.log(s);
  if (RUN) appendFileSync(REPORT, s + '\n');
};

// ── Deterministic PRNG (no Date.now / Math.random — reproducible) ──────────
const mulberry32 = (seed: number) => () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

// ── Representative name / company pools ────────────────────────────────────
// Multi-token "First Last" is the dominant real shape; single-token address-
// book entries + single-token orgs are the false-positive surface. The
// COMMON-word single tokens (a name that's an English word, an org named after
// one) are deliberately included — they are the residual the commonness filter
// targets (design §5).
const FIRST = [
  'Maria', 'James', 'Lucia', 'Wei', 'Aisha', 'Diego', 'Priya', 'Mateo', 'Sofia',
  'Omar', 'Hana', 'Liam', 'Yuki', 'Noah', 'Ananya', 'Ivan', 'Chloe', 'Kwame',
  'Elena', 'Hugo', 'Fatima', 'Sven', 'Ingrid', 'Tariq', 'Mei', 'Pablo', 'Zara',
];
const LAST = [
  'Johnson', 'Castellanos', 'Nguyen', 'Okafor', 'Schmidt', 'Rossi', 'Patel',
  'Garcia', 'Kowalski', 'Andersson', 'Tanaka', 'Ferreira', 'Haddad', 'Lindqvist',
  'Olsen', 'Mbeki', 'Dubois', 'Novak', 'Reyes', 'Volkov',
];
// Single-token names that ARE common English words (FP risk).
const COMMON_NAMES = [
  'Will', 'Mark', 'Grace', 'Hope', 'Rose', 'June', 'May', 'Bill', 'Art', 'Joy',
  'Dawn', 'Faith', 'Summer', 'Sunday', 'Daisy', 'Bob', 'Pat',
];
// Single-token names that are distinctive (inert even if single-token).
const RARE_NAMES = [
  'Xiomara', 'Thandiwe', 'Bjorn', 'Anouk', 'Olamide', 'Zhang', 'Keanu', 'Indira',
];
// Multi-token companies (the safe majority).
const MULTI_ORG = [
  'Acme Corp', 'Globex Industries', 'Initech LLC', 'Stark Industries',
  'Wayne Enterprises', 'Umbrella Corporation', 'Hooli Inc', 'Pied Piper',
  'Vandelay Industries', 'Wonka Industries', 'Massive Dynamic', 'Soylent Corp',
];
// Single-token orgs that ARE common English words (FP risk — the "Gap" class).
const COMMON_ORG = [
  'Gap', 'Apple', 'Square', 'Box', 'Block', 'Mint', 'Sage', 'Oracle', 'Slack',
  'Discord', 'Amazon', 'Meta', 'Bond', 'Anchor', 'Bench', 'Notion', 'Stripe',
];
// Single-token orgs that are distinctive (inert).
const RARE_ORG = [
  'Datadog', 'Twilio', 'Cloudflare', 'Snowflake', 'Zendesk', 'Okta', 'Splunk',
];

interface SeedContact {
  email?: string;
  name: string;
  phone?: string;
  company?: string;
  nameTokenCount: number;
  nameClass: 'multi' | 'common-single' | 'rare-single';
  orgClass?: 'multi' | 'common-single' | 'rare-single';
}

/** Build a deterministic representative warehouse of `n` contacts. The shape
 *  mix mirrors a personal warehouse derived from mail/calendar + manual entry:
 *  mostly First-Last with email, ~40% phone, ~55% company. */
const buildContacts = (n: number, seed = 42): SeedContact[] => {
  const rnd = mulberry32(seed);
  const pick = <T>(a: readonly T[]): T => a[Math.floor(rnd() * a.length)]!;
  const out: SeedContact[] = [];
  for (let i = 0; i < n; i++) {
    const r = rnd();
    let name: string;
    let nameClass: SeedContact['nameClass'];
    if (r < 0.72) {
      name = `${pick(FIRST)} ${pick(LAST)}`;
      nameClass = 'multi';
    } else if (r < 0.9) {
      name = pick(COMMON_NAMES);
      nameClass = 'common-single';
    } else {
      name = pick(RARE_NAMES);
      nameClass = 'rare-single';
    }
    const nameTokenCount = name.split(/\s+/).length;
    const c: SeedContact = { name, nameTokenCount, nameClass };
    // Email on ~85% (unique local part keeps the PK distinct).
    if (rnd() < 0.85) {
      c.email = `${name.toLowerCase().replace(/[^a-z]+/g, '.')}.${i}@example${i % 7}.com`;
    } else {
      // email-less: still needs a synthetic PK for the store; mark via a
      // mention-only-shaped placeholder so it stays out of the email match.
      c.email = `mention-only-c${i}@_recued.invalid`;
    }
    // Phone on ~40% (E.164).
    if (rnd() < 0.4) {
      const sub = String(1000000 + Math.floor(rnd() * 8999999));
      c.phone = `+1415${sub.slice(0, 7)}`;
    }
    // Company on ~55%.
    if (rnd() < 0.55) {
      const cr = rnd();
      if (cr < 0.6) { c.company = pick(MULTI_ORG); c.orgClass = 'multi'; }
      else if (cr < 0.85) { c.company = pick(COMMON_ORG); c.orgClass = 'common-single'; }
      else { c.company = pick(RARE_ORG); c.orgClass = 'rare-single'; }
    }
    out.push(c);
  }
  return out;
};

/** Load the contacts into a real ContactStore (in-memory SQLite). Uses the
 *  manual upsert path so phone/company land in their real columns. A
 *  monotonic `last_interaction` makes the store's recency order deterministic
 *  (so the 1000-row list clamp keeps a stable page). */
const loadStore = (contacts: SeedContact[]): { store: ContactStore; db: Database.Database } => {
  const db = new Database(':memory:');
  let t = 1;
  const store = createContactStore(db, { now: () => t });
  const tx = db.transaction(() => {
    for (const c of contacts) {
      t += 1;
      store.upsertManual(
        {
          email: c.email!,
          name: c.name,
          last_interaction: t,
          ...(c.phone ? { phone: c.phone } : {}),
          ...(c.company ? { company: c.company } : {}),
        },
        t,
      );
    }
  });
  tx();
  return { store, db };
};

// ── Corpus loading ──────────────────────────────────────────────────────────
/** All distinct prose messages from the compound-prompt corpus: the compound
 *  prompt, each component prompt, and the paraphrases. None mention the
 *  synthetic warehouse, so any alias produced is a SPURIOUS match — exactly the
 *  false-positive surface. */
const loadCorpusMessages = (cap = 8000): string[] => {
  const lines = readFileSync(CORPUS, 'utf8').split('\n').filter(Boolean);
  const msgs: string[] = [];
  for (const line of lines) {
    let row: any;
    try { row = JSON.parse(line); } catch { continue; }
    if (typeof row.compound_prompt === 'string') msgs.push(row.compound_prompt);
    for (const comp of row.components ?? []) {
      if (typeof comp.prompt === 'string') msgs.push(comp.prompt);
    }
    for (const p of row.compound_paraphrases ?? []) {
      if (typeof p === 'string') msgs.push(p);
    }
    if (msgs.length >= cap) break;
  }
  return msgs.slice(0, cap);
};

// ── Helpers ──────────────────────────────────────────────────────────────────
const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
const pctile = (xs: number[], p: number): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!;
};
const fmt = (n: number) => n.toFixed(3);

const norm = (s: string): string => s.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
const wordSet = (s: string): Set<string> => new Set(norm(s).match(/[\p{L}\p{N}]+/gu) ?? []);

describe('D-167 prefetch PII coverage — Phase A measurement', () => {
  it('M1: warehouse cardinality + field-presence model', () => {
    const N = 2000;
    const contacts = buildContacts(N);
    const withEmail = contacts.filter((c) => c.email && !c.email.endsWith('@_recued.invalid')).length;
    const withPhone = contacts.filter((c) => c.phone).length;
    const withCompany = contacts.filter((c) => c.company).length;
    const multiName = contacts.filter((c) => c.nameClass === 'multi').length;
    const commonSingle = contacts.filter((c) => c.nameClass === 'common-single').length;
    const rareSingle = contacts.filter((c) => c.nameClass === 'rare-single').length;
    const commonOrg = contacts.filter((c) => c.orgClass === 'common-single').length;

    log('\n=== M1: warehouse cardinality model (N=' + N + ') ===');
    log(`  email present:        ${withEmail} (${fmt((100 * withEmail) / N)}%)`);
    log(`  phone present:        ${withPhone} (${fmt((100 * withPhone) / N)}%)`);
    log(`  company present:      ${withCompany} (${fmt((100 * withCompany) / N)}%)`);
    log(`  name multi-token:     ${multiName} (${fmt((100 * multiName) / N)}%)`);
    log(`  name common-single:   ${commonSingle} (${fmt((100 * commonSingle) / N)}% — FP risk)`);
    log(`  name rare-single:     ${rareSingle} (${fmt((100 * rareSingle) / N)}%)`);
    log(`  org common-single:    ${commonOrg} (${fmt((100 * commonOrg) / N)}% — "Gap" class FP risk)`);
    log('  NOTE: store.list() clamps to MAX_LIMIT=1000, so the prefetch');
    log('        scans only the 1000 most-recent contacts today; beyond');
    log('        that, contacts are silently never prefetched and');
    log('        scanComplete=false disables ALL phone matching.');
    expect(contacts.length).toBe(N);
  });

  (RUN ? it : it.skip)('M2: prefetch scan latency (current adapter vs true full-scan)', () => {
    const sizes = [500, 1000, 2000, 5000, 10000, 50000];
    // Representative query token sets: a name mention, a generic question, a
    // phone, an email-ish mention. Drives the per-turn scan repeatedly.
    const queries = [
      'how is the Maria Johnson deal tracking this quarter',
      'can you summarize my unread email from this morning',
      'please call +1 415 555 0142 about the renewal',
      'what did James Patel say in the last thread',
      'remind me to follow up with the Acme Corp account next week',
      // B1 — an email-bearing query so the email-run extraction + the adapter's
      // canonicalise + per-row emailRunSet.has(rec.email) path is timed too.
      'forward the SOW to jordan@example3.com and loop in dana@example5.com',
    ];
    const queryTok = queries.map((q) => ({
      tokens: decomposeToTokens(q),
      phoneRuns: extractPhoneRuns(q),
      emailRuns: extractEmailRuns(q),
    }));

    // Broadened FULL-SCAN scorer: bypasses the store's MAX_LIMIT=1000 list
    // clamp (a raw SELECT over ALL rows) and does the per-row work B1/B4 add —
    // build a wordSet over name+company, exact email/phone match, build the
    // full canonical value. This is the TRUE O(contacts) cost the design's
    // "linear scan" worry is about; the current adapter can't be measured past
    // 1000 rows because the store hard-caps `list()` (so >1000 coverage needs
    // either paging or FTS — a separate finding).
    const fullScanBroadened = (
      db: Database.Database,
      q: { tokens: readonly string[]; phoneRuns: readonly string[]; emailRuns: readonly string[] },
    ): number => {
      const rows = db.prepare(`SELECT email, name, phone, company FROM contacts`).all() as Array<{
        email: string; name: string | null; phone: string | null; company: string | null;
      }>;
      const qTok = new Set(q.tokens.map(norm));
      // Exact-identifier sets (B1): emails are reconstructed whole by
      // `extractEmailRuns` (already lower-cased, the store's canonical form), so
      // membership is the true email match — NOT a shredded-token compare.
      const emailSet = new Set(q.emailRuns);
      const phoneRunSet = new Set(q.phoneRuns);
      const t0 = performance.now();
      const scored: Array<{ ref: string; score: number }> = [];
      for (const r of rows) {
        let s = 0;
        if (r.name) for (const w of wordSet(r.name)) if (qTok.has(w)) s++;
        if (r.company) for (const w of wordSet(r.company)) if (qTok.has(w)) s++;
        if (r.email && emailSet.has(r.email)) s += 5;
        if (r.phone) { const d = r.phone.replace(/\D+/g, ''); if (qTok.has(d) || phoneRunSet.has(d)) s += 5; }
        if (s > 0) {
          // build full canonical value (D3) — the extra per-hit work
          const _full = `${r.name ?? ''}`.trim();
          void _full;
          scored.push({ ref: r.email ?? '', score: s });
        }
      }
      scored.sort((a, b) => b.score - a.score).slice(0, 3);
      return performance.now() - t0;
    };

    log('\n=== M2: prefetch scan latency (per-turn ms) ===');
    log('  N      current-adapter(scan-capped@PREFETCH_SCAN_MAX=10000)  full-scan-broadened(true O(N))  scanComplete');
    for (const n of sizes) {
      const contacts = buildContacts(n);
      const { store, db } = loadStore(contacts);
      // D-167 follow-on (clamp lifted): the adapter now scans via
      // `listForPrefetchScan` (lean, capped at PREFETCH_SCAN_MAX=10000), NOT the
      // old list() MAX_LIMIT=1000 — so "current" tracks the broadened cost up to 10k.
      const current = createContactPrefetchSearch(() => store);

      const timeCurrent = (): number[] => {
        const samples: number[] = [];
        for (const q of queryTok) current({ ...q, limit: 3 }); // warm
        for (let rep = 0; rep < 20; rep++) {
          for (const q of queryTok) {
            const t0 = performance.now();
            current({ ...q, limit: 3 });
            samples.push(performance.now() - t0);
          }
        }
        return samples;
      };
      const timeFull = (): number[] => {
        const samples: number[] = [];
        for (const q of queryTok) fullScanBroadened(db, q); // warm
        for (let rep = 0; rep < 20; rep++) {
          for (const q of queryTok) samples.push(fullScanBroadened(db, q));
        }
        return samples;
      };

      const cur = timeCurrent();
      const full = timeFull();
      const scanComplete = n <= 10000; // listForPrefetchScan caps at PREFETCH_SCAN_MAX=10000
      log(
        `  ${String(n).padEnd(6)} ` +
          `med ${fmt(median(cur))} p95 ${fmt(pctile(cur, 95))}              ` +
          `med ${fmt(median(full))} p95 ${fmt(pctile(full, 95))}           ${scanComplete}`,
      );
      db.close();
    }
    log('  current-adapter now scans via listForPrefetchScan (lean, capped at');
    log('  PREFETCH_SCAN_MAX=10000) — coverage holds + scanComplete stays true through');
    log('  10k (the lifted clamp). Above 10k it degrades again (scanComplete=false,');
    log('  phone match suppressed) — the FTS path is the >10k follow-on.');
    expect(true).toBe(true);
  }, 180_000);

  (RUN && existsSync(CORPUS) ? it : it.skip)(
    'M3: name/org false-positive rate (full-value seed + real scanContent)',
    () => {
      const N = 2000;
      const contacts = buildContacts(N);
      const messages = loadCorpusMessages();

      // Corpus token document-frequency — the per-token FP probability for a
      // single-token seeded value (its corpus frequency IS its collision rate).
      const msgWordSets = messages.map((m) => wordSet(m));

      // Targeted top-K matcher (broadened B4 shape): a contact matches if any
      // of its name OR company tokens overlaps the message; score = overlap
      // count; keep top-K. Mirrors the adapter's scoring, extended to company.
      const K = 3;
      const enriched = contacts.map((c) => ({
        c,
        nameToks: wordSet(c.name),
        orgToks: c.company ? wordSet(c.company) : new Set<string>(),
      }));

      let msgWithAlias = 0;
      let totalReplacements = 0;
      let withheldSeeds = 0; // B4 — single-token common-word name/org never seeded
      const byNameClass: Record<string, number> = { multi: 0, 'common-single': 0, 'rare-single': 0 };
      const byOrgClass: Record<string, number> = { multi: 0, 'common-single': 0, 'rare-single': 0 };
      let multiTokenSpurious = 0; // multi-token name/org that got contained — the D3 thesis says ~0
      // value → { #messages it aliased, token count, kind, class }
      const offenders = new Map<
        string,
        { count: number; tokens: number; kind: string; klass: string }
      >();

      for (let mi = 0; mi < messages.length; mi++) {
        const ws = msgWordSets[mi]!;
        const msg = messages[mi]!;
        // score contacts by token overlap (name ∪ org)
        const scored: Array<{ idx: number; score: number }> = [];
        for (let i = 0; i < enriched.length; i++) {
          const e = enriched[i]!;
          let s = 0;
          for (const t of e.nameToks) if (ws.has(t)) s++;
          for (const t of e.orgToks) if (ws.has(t)) s++;
          if (s > 0) scored.push({ idx: i, score: s });
        }
        if (scored.length === 0) continue;
        scored.sort((a, b) => b.score - a.score);
        const top = scored.slice(0, K);

        // seed FULL canonical values (design D3) into a fresh ledger, GATED on
        // the B4 commonness filter exactly as the production seed
        // (`toPrefetchEntityRecord`) does: a single-token common-word name/org is
        // never seeded, so `scanContent` cannot over-alias the bare word in
        // unrelated prose. Multi-token (D3) + distinctive single tokens still
        // seed. This is what zeroes the single-token residual on a re-run.
        const ledger = createLedger(`measure:${mi}`);
        for (const { idx } of top) {
          const e = enriched[idx]!;
          if (shouldSeedEntityValue(e.c.name)) getOrAllocate(ledger, 'name', e.c.name);
          else withheldSeeds += 1;
          if (e.c.company) {
            if (shouldSeedEntityValue(e.c.company)) getOrAllocate(ledger, 'org', e.c.company);
            else withheldSeeds += 1;
          }
        }
        const { replacements } = scanContent(ledger, msg);
        if (replacements === 0) continue;

        msgWithAlias += 1;
        totalReplacements += replacements;
        // attribute each replaced value by re-scanning per-value (cheap; top is ≤3)
        for (const { idx } of top) {
          const e = enriched[idx]!;
          for (const [val, kind, klass] of [
            [e.c.name, 'name', e.c.nameClass] as const,
            ...(e.c.company ? [[e.c.company, 'org', e.c.orgClass!] as const] : []),
          ]) {
            // Mirror the seed gate — a withheld value is not seeded, so it cannot
            // be attributed a spurious replacement (keeps the per-class counts +
            // offender list consistent with the filtered seed above).
            if (!shouldSeedEntityValue(val)) continue;
            const l2 = createLedger('v');
            getOrAllocate(l2, kind, val);
            const r = scanContent(l2, msg).replacements;
            if (r > 0) {
              if (kind === 'name') byNameClass[klass] = (byNameClass[klass] ?? 0) + r;
              else byOrgClass[klass] = (byOrgClass[klass] ?? 0) + r;
              const tokenCount = val.split(/\s+/).length;
              if (tokenCount > 1) multiTokenSpurious += r;
              const prev = offenders.get(val);
              if (prev) prev.count += 1;
              else offenders.set(val, { count: 1, tokens: tokenCount, kind, klass });
            }
          }
        }
      }

      const sorted = [...offenders.entries()].sort((a, b) => b[1].count - a[1].count);
      const multiTokOff = sorted.filter(([, o]) => o.tokens > 1);
      const singleTokOff = sorted.filter(([, o]) => o.tokens === 1);
      // `offenders[v].count` IS the word-boundary doc-frequency (scanContent is
      // word-boundary), so count/total = that value's per-message FP rate.
      const fp = (c: number) => fmt((100 * c) / messages.length);

      // COMPUTED corpus-filler separation (P2b — not an after-the-fact claim).
      // A FICTIONAL multi-token value a real user holds in their warehouse would
      // appear ~0x in this corpus of UNRELATED business prompts. So a multi-token
      // value that nonetheless lands in several distinct messages is almost
      // certainly a phrase the synthetic corpus REUSES as filler ("Acme Corp",
      // stock person names) — contamination of the synthetic overlap, NOT a real
      // FP a user would hit. Threshold of >=3 messages flags filler; values under
      // it are "plausibly-distinctive", and THEIR count is the decontaminated
      // multi-token FP the gate actually rests on.
      const FILLER_MIN = 3;
      const multiFiller = multiTokOff.filter(([, o]) => o.count >= FILLER_MIN);
      const multiDistinct = multiTokOff.filter(([, o]) => o.count < FILLER_MIN);
      const distinctMultiMsgs = multiDistinct.reduce((s, [, o]) => s + o.count, 0);

      log('');
      log('=== M3: name/org false-positive rate ===');
      log('  (B4 commonness filter ACTIVE — single-token common-word name/org seeds withheld)');
      log(`  corpus messages:            ${messages.length}`);
      log(`  warehouse contacts:         ${N}`);
      log(`  B4 seeds withheld:          ${withheldSeeds} (single-token common-word name/org never seeded)`);
      log(`  messages with >=1 alias:    ${msgWithAlias} (${fp(msgWithAlias)}%)  [post-filter; single-token residual should be ~0]`);
      log(`  total spurious replacements: ${totalReplacements}`);
      log(`  MULTI-TOKEN replacements (RAW): ${multiTokenSpurious}`);
      log(`  by name class (replacements): ${JSON.stringify(byNameClass)}`);
      log(`  by org class  (replacements): ${JSON.stringify(byOrgClass)}`);
      log('');
      log(`  MULTI-TOKEN offenders: ${multiTokOff.length} distinct`);
      log(`    corpus-filler-suspect (>=${FILLER_MIN} msgs): ${multiFiller.length} distinct`);
      log(`    plausibly-distinctive  (<${FILLER_MIN} msgs):  ${multiDistinct.length} distinct, ${distinctMultiMsgs} msgs (${fp(distinctMultiMsgs)}%)`);
      log(`    => DECONTAMINATED distinctive-multi-token FP = ${distinctMultiMsgs} msgs (${fp(distinctMultiMsgs)}%)`);
      for (const [v, o] of multiTokOff) {
        const tag = o.count >= FILLER_MIN ? 'filler-suspect' : 'distinctive';
        log(`    ${v.padEnd(22)} ${String(o.count).padStart(4)} msgs (${fp(o.count)}%)  [${o.kind}/${o.klass}; ${tag}]`);
      }
      if (multiTokOff.length === 0) log('    (none — no multi-token value was spuriously contained at all)');
      log('  READ: the RAW multi-token count is dominated by corpus LLM-filler');
      log('  phrases (the synthetic warehouse overlaps the corpus fiction). The');
      log('  decontaminated number is the gate-relevant one; distinguishing a');
      log('  genuine mention from a spurious one needs ground truth the corpus lacks.');
      log('');
      log(`  SINGLE-TOKEN offenders (${singleTokOff.length} distinct values) — the commonness-filter target:`);
      for (const [v, o] of singleTokOff.slice(0, 25)) {
        log(`    ${v.padEnd(22)} ${String(o.count).padStart(4)} msgs (${fp(o.count)}%)  [${o.kind}/${o.klass}]`);
      }
      log('  INTERPRETATION: the residual is single-token common-word values');
      log('  (names like "Will"/"Mark", orgs like "Gap"/"Block"); each value\'s');
      log('  FP rate ≈ its corpus doc-frequency. This is the commonness-filter input.');
      expect(messages.length).toBeGreaterThan(0);
    },
    180_000,
  );
});
