import { describe, expect, it } from 'vitest';
import type { PromptContribution, PromptPart, TurnContext } from '@recued/middleware';

import {
  contributePrefetch,
  createPromptCacheMiddleware,
  decomposeToTokens,
  extractPhoneRuns,
  extractEmailRuns,
  formatPrefetchContext,
  noopEntitySearch,
  prefetchEntities,
  selectWithPinned,
  PINNED_CANDIDATE_MAX,
  isCommonSingleTokenWord,
  shouldSeedEntityValue,
  type EntitySearchPort,
  type PrefetchCandidate,
} from '../index';

const CANDS: readonly PrefetchCandidate[] = [
  { ref: 'lucia@x.com', label: 'Lucía Castellanos', kind: 'contact', score: 9 },
  { ref: 'acme', label: 'Acme Corp', kind: 'company', score: 4 },
];

const fakeSearch = (out: readonly PrefetchCandidate[]): EntitySearchPort => () => out;

/** Render an entity part's payload through its own `render` — the egress
 *  gather's job (here un-aliased, exercising the format only). */
const renderPart = (part: PromptPart | undefined): string =>
  part !== undefined && part.role === 'entity' ? part.render(part.payload) : '';

const makeCtx = (userText: string): { ctx: TurnContext; parts: PromptPart[] } => {
  const parts: PromptPart[] = [];
  const ctx = {
    session_id: 's',
    surface: 'chat',
    turn_index: 0,
    turn_id: 't',
    history: userText ? [{ role: 'user', text: userText }] : [],
    prompt: {
      contribute: (p: PromptContribution) =>
        parts.push({ source: 'prompt-cache', ...p }),
      parts: () => parts,
    },
    interjections: [],
    capacity: {},
    out: {},
    state: new Map<string, unknown>(),
    resolve: () => {
      throw new Error('prefetch must never resolve the turn');
    },
  } as unknown as TurnContext;
  return { ctx, parts };
};

describe('prefetch — decompose', () => {
  it('unigrams, length >= 2, deduped, Unicode-aware', () => {
    expect(decomposeToTokens('is Lucía available on Sunday?')).toEqual([
      'is', 'Lucía', 'available', 'on', 'Sunday',
    ]);
  });
  it('drops all-1-char tokens', () => {
    expect(decomposeToTokens('a A b')).toEqual([]);
  });
  it('tokenizes mixed Latin + multibyte in one string', () => {
    expect(decomposeToTokens('email 田中 Café Q3')).toEqual(['email', '田中', 'Café', 'Q3']);
  });
  it('drops single-char tokens by CODE POINT — BMP and astral alike', () => {
    expect(decomposeToTokens('中')).toEqual([]); // single BMP CJK
    expect(decomposeToTokens('𠮷')).toEqual([]); // single astral char (was kept under UTF-16 length)
    expect(decomposeToTokens('田中太郎')).toEqual(['田中太郎']); // multi-char CJK survives (one token, no boundary)
  });
  it('keeps a bare contiguous number as a unigram (no phone-run channel)', () => {
    // A lone number stays a unigram (matched against full E.164 only); the
    // formatted-phone path is extractPhoneRuns, not decompose.
    expect(decomposeToTokens('the code is 4155550199')).toEqual(['the', 'code', 'is', '4155550199']);
  });
});

describe('prefetch — extractPhoneRuns', () => {
  it('reconstructs a formatted phone as its full digit run', () => {
    expect(extractPhoneRuns('Call (415) 555-0199')).toEqual(['4155550199']);
    expect(extractPhoneRuns('ring +1 415 555 0199')).toEqual(['14155550199']);
    expect(extractPhoneRuns('contact 020 7946 0958')).toEqual(['02079460958']);
  });
  it('backs off a trailing letter-glued group so phone + time stays clean', () => {
    expect(extractPhoneRuns('Call (415) 555-0199 2pm')).toEqual(['4155550199']);
  });
  it('emits only the WHOLE run — never a suffix subwindow (no tail false-match)', () => {
    expect(extractPhoneRuns('reach 415-555-0199')).toEqual(['4155550199']); // not 5550199
  });
  it('over-merges two space-adjacent phones → dropped, not guessed (safe residual)', () => {
    expect(extractPhoneRuns('415 555 0199 650 555 0100')).toEqual([]); // 20 digits → no resolve
  });
  it('ignores a lone bare number (no separators → not a formatted run)', () => {
    expect(extractPhoneRuns('the code is 4155550199')).toEqual([]);
  });
  it('drops a run that joins below 7 digits', () => {
    expect(extractPhoneRuns('call 12 34 now')).toEqual([]);
  });
});

describe('prefetch — extractEmailRuns (B1)', () => {
  it('reconstructs a whole email the unigram split would shred', () => {
    expect(extractEmailRuns('loop in bob@globex.com on the thread')).toEqual(['bob@globex.com']);
  });
  it('strips a sentence-final period and other trailing punctuation', () => {
    expect(extractEmailRuns('mail bob@acme.com.')).toEqual(['bob@acme.com']);
    expect(extractEmailRuns('to bob@acme.com, then alice@x.io')).toEqual(['bob@acme.com', 'alice@x.io']);
    expect(extractEmailRuns('(bob@acme.com)')).toEqual(['bob@acme.com']);
  });
  it('keeps plus-tagging and subdomains; lower-cases; dedupes', () => {
    expect(extractEmailRuns('BOB+ml@Mail.Acme.CO.uk and BOB+ml@mail.acme.co.uk')).toEqual([
      'bob+ml@mail.acme.co.uk',
    ]);
  });
  it('requires a dotted domain — a bare host is not an email', () => {
    expect(extractEmailRuns('user@localhost is internal')).toEqual([]);
  });
  it('no email present → empty', () => {
    expect(extractEmailRuns('how is the deal tracking this quarter')).toEqual([]);
  });
});

describe('prefetch — selectWithPinned (B1)', () => {
  const c = (score: number, pinned?: boolean): PrefetchCandidate =>
    ({ ref: `r${score}${pinned ? 'p' : ''}`, label: 'x', kind: 'contact', score, ...(pinned ? { pinned: true } : {}) });
  it('with no pinned, behaves exactly like slice(0, limit)', () => {
    const sorted = [c(9), c(8), c(7), c(6)];
    expect(selectWithPinned(sorted, 3)).toEqual(sorted.slice(0, 3));
  });
  it('keeps a pinned match past the cap and fills the rest with top fuzzy', () => {
    // limit 1, but two pinned + several fuzzy: both pinned survive, no fuzzy room.
    const out = selectWithPinned([c(5, true), c(5, true), c(3), c(2)], 1);
    expect(out.filter((x) => x.pinned)).toHaveLength(2);
    expect(out).toHaveLength(2); // 2 pinned + max(0, 1-2)=0 fuzzy
  });
  it('fills remaining slots to limit with top fuzzy when room remains', () => {
    const out = selectWithPinned([c(5, true), c(4), c(3), c(2)], 3);
    expect(out.map((x) => x.ref)).toEqual(['r5p', 'r4', 'r3']); // 1 pinned + 2 fuzzy = limit 3
  });
  it('caps pinned at PINNED_CANDIDATE_MAX', () => {
    const many = Array.from({ length: PINNED_CANDIDATE_MAX + 5 }, (_, i) => c(5, true));
    expect(selectWithPinned(many, 3)).toHaveLength(PINNED_CANDIDATE_MAX);
  });
});

describe('prefetch — shouldSeedEntityValue (B4 commonness filter)', () => {
  // The §6.1 measurement's single-token residual offenders + its `COMMON_*` seed
  // pools — every one MUST be withheld from the seed (else the bare word over-
  // aliases unrelated prose). This list is the filter's coverage contract.
  const COMMON = [
    'Will', 'Mark', 'Grace', 'Hope', 'Rose', 'June', 'May', 'Bill', 'Art', 'Joy',
    'Dawn', 'Faith', 'Summer', 'Sunday', 'Daisy', 'Bob', 'Pat',
    'Gap', 'Apple', 'Square', 'Box', 'Block', 'Mint', 'Sage', 'Oracle', 'Slack',
    'Discord', 'Amazon', 'Meta', 'Bond', 'Anchor', 'Bench', 'Notion', 'Stripe',
  ];
  // The measurement's `RARE_*` pools — distinctive single tokens that MUST still
  // seed (the design's "Datadog/Twilio/Okta stay aliased").
  const DISTINCTIVE = [
    'Xiomara', 'Thandiwe', 'Bjorn', 'Anouk', 'Olamide', 'Zhang', 'Keanu', 'Indira',
    'Datadog', 'Twilio', 'Cloudflare', 'Snowflake', 'Zendesk', 'Okta', 'Splunk',
  ];

  it('withholds every single-token common-word offender — in any case', () => {
    for (const v of COMMON) {
      expect(shouldSeedEntityValue(v), v).toBe(false);
      expect(shouldSeedEntityValue(v.toUpperCase()), v).toBe(false);
      expect(shouldSeedEntityValue(v.toLowerCase()), v).toBe(false);
      expect(isCommonSingleTokenWord(v), v).toBe(true);
    }
  });

  it('still seeds every distinctive single-token name/org (Datadog/Twilio class)', () => {
    for (const v of DISTINCTIVE) {
      expect(shouldSeedEntityValue(v), v).toBe(true);
      expect(isCommonSingleTokenWord(v), v).toBe(false);
    }
  });

  it('always seeds a MULTI-token value even when a component is common (D3 full-value)', () => {
    expect(shouldSeedEntityValue('Will Johnson')).toBe(true);
    expect(shouldSeedEntityValue('Acme Corp')).toBe(true);
    expect(shouldSeedEntityValue('Gap Inc')).toBe(true); // the user-side escape (design §5)
    // A multi-token value is never classed "common-single".
    expect(isCommonSingleTokenWord('Will Johnson')).toBe(false);
  });

  it('catches a common word wearing edge punctuation (gate can not be bypassed)', () => {
    expect(shouldSeedEntityValue('Gap.')).toBe(false);
    expect(shouldSeedEntityValue('(Gap)')).toBe(false);
    expect(shouldSeedEntityValue('Will,')).toBe(false);
  });

  it('never seeds a bare single character (would alias every occurrence in prose)', () => {
    expect(shouldSeedEntityValue('X')).toBe(false); // e.g. the company "X"
    expect(shouldSeedEntityValue('A')).toBe(false);
    expect(shouldSeedEntityValue('!')).toBe(false); // all-punctuation → empty key
  });

  it('withholds high-frequency two-letter function words', () => {
    for (const v of ['it', 'in', 'up', 'of', 'to', 'on']) {
      expect(shouldSeedEntityValue(v), v).toBe(false);
    }
  });

  it('does not seed empty/whitespace; keeps INTERNAL punctuation distinctive', () => {
    expect(shouldSeedEntityValue('')).toBe(false);
    expect(shouldSeedEntityValue('   ')).toBe(false);
    expect(shouldSeedEntityValue("O'Brien")).toBe(true);  // internal punct kept → distinctive
    expect(shouldSeedEntityValue('Coca-Cola')).toBe(true);
  });
});

describe('prefetch — prefetchEntities (floor + cap)', () => {
  it('applies the minScore floor and the limit', async () => {
    const out = await prefetchEntities('email Lucía Castellanos', {
      search: fakeSearch(CANDS), limit: 3, minScore: 5,
    });
    expect(out).toEqual([CANDS[0]]); // Acme (4) below floor 5
  });
  it('caps FUZZY at limit', async () => {
    const out = await prefetchEntities('email Lucía Acme', {
      search: fakeSearch(CANDS), limit: 1, minScore: 0,
    });
    expect(out).toHaveLength(1);
  });
  it('keeps a PINNED (exact-identifier) candidate past the limit (B1 privacy)', async () => {
    // Two pinned email/phone hits + one fuzzy, limit 1: both pinned survive so a
    // typed identifier is always seeded; the fuzzy is dropped.
    const pinnedCands: readonly PrefetchCandidate[] = [
      { ref: 'a@x.com', label: 'A', kind: 'contact', score: 5, pinned: true },
      { ref: 'b@x.com', label: 'B', kind: 'contact', score: 5, pinned: true },
      { ref: 'c', label: 'C', kind: 'contact', score: 1 },
    ];
    const out = await prefetchEntities('email a@x.com b@x.com c', {
      search: fakeSearch(pinnedCands), limit: 1, minScore: 0,
    });
    expect(out.map((o) => o.ref).sort()).toEqual(['a@x.com', 'b@x.com']);
  });
  it('no usable tokens → empty', async () => {
    expect(await prefetchEntities('a', { search: fakeSearch(CANDS) })).toEqual([]);
  });
  it('noop search → empty', async () => {
    expect(await prefetchEntities('email Lucía', { search: noopEntitySearch })).toEqual([]);
  });
});

describe('prefetch — format', () => {
  it('empty candidates → empty string', () => {
    expect(formatPrefetchContext([])).toBe('');
  });
  it('labels candidates with explicit speculative framing', () => {
    const s = formatPrefetchContext(CANDS);
    expect(s).toContain('speculative');
    expect(s).toContain('verify');
    expect(s).toContain('Lucía Castellanos (contact, ref: lucia@x.com)');
    expect(s).toContain('Acme Corp (company, ref: acme)');
    expect(s).not.toContain('Multiple stored contacts');
    expect(s).not.toContain('\n\n');
  });
  it('splits mixed confident and ambiguous candidates into separate blocks', () => {
    const s = formatPrefetchContext([
      { ref: 'bob@x.com', label: 'Bob Stone', kind: 'contact', score: 1 },
      { ref: 'sarah@x.com', label: 'Sarah Adams', kind: 'contact', score: 1, ambiguous: true },
    ]);
    const blocks = s.split('\n\n');
    expect(blocks).toHaveLength(2);
    const confidentBlock = blocks[0] ?? '';
    const ambiguousBlock = blocks[1] ?? '';
    expect(confidentBlock).toContain('speculative');
    expect(confidentBlock).toContain('verify');
    expect(confidentBlock).toContain('Bob Stone (contact, ref: bob@x.com)');
    expect(confidentBlock).not.toContain('Sarah Adams');
    expect(ambiguousBlock).toContain('Multiple stored contacts');
    expect(ambiguousBlock).toContain('Do NOT assume');
    expect(ambiguousBlock).toContain('ask the user to clarify');
    expect(ambiguousBlock).toContain('Sarah Adams (contact, ref: sarah@x.com)');
    expect(ambiguousBlock).not.toContain('Bob Stone');
  });
  it('renders only the ambiguous header when every candidate is ambiguous', () => {
    const s = formatPrefetchContext([
      { ref: 'sarah.adams@x.com', label: 'Sarah Adams', kind: 'contact', score: 1, ambiguous: true },
      { ref: 'sarah.chen@x.com', label: 'Sarah Chen', kind: 'contact', score: 1, ambiguous: true },
    ]);
    expect(s).toContain('Multiple stored contacts');
    expect(s).toContain('Do NOT assume');
    expect(s).toContain('ask the user to clarify');
    expect(s).not.toContain('speculative');
    expect(s).not.toContain('\n\n');
  });
  it('drops a label-less candidate line instead of rendering a nameless fragment', () => {
    // Codex fold: a single-token common-word NAME ("April") matches but the
    // B4 seed gate withholds its label — the line would render as
    // `-  (contact, ref: …)`, a fragment the model cannot connect to anything
    // (the bench measured this shape collapsing prefetch trust). The candidate
    // still seeds the ledger at the gather; only the unusable line drops.
    const s = formatPrefetchContext([
      { ref: 'april@x.com', label: '', kind: 'contact', score: 1 },
      { ref: 'pat@x.com', label: 'Pat Lee', kind: 'contact', score: 2 },
    ]);
    expect(s).toContain('Pat Lee (contact, ref: pat@x.com)');
    expect(s).not.toContain('april@x.com');
    expect(s).not.toContain('-  (');
  });
  it('renders nothing at all when every candidate is label-less', () => {
    const s = formatPrefetchContext([
      { ref: 'april@x.com', label: '', kind: 'contact', score: 1 },
      { ref: 'me@self.test', label: '  ', kind: 'contact', score: 1, ambiguous: true },
    ]);
    expect(s).toBe('');
  });
});

describe('prefetch — contributePrefetch', () => {
  it('contributes a STRUCTURED entity part when candidates resolve (D-167 N.10.1)', async () => {
    const { ctx, parts } = makeCtx('is Lucía available');
    const got = await contributePrefetch(ctx, { search: fakeSearch(CANDS), minScore: 0 });
    expect(got).toEqual(CANDS);
    expect(parts).toHaveLength(1);
    const part = parts[0];
    expect(part?.role).toBe('entity');
    if (part === undefined || part.role !== 'entity') throw new Error('expected entity part');
    // The kind the gather stamps as each record's privacy marker.
    expect(part.entity).toBe('contact');
    // Raw records carried structurally (NO pre-rendered text) so the resolver
    // can alias them — mapped onto the canonical-contact field names the
    // `contact` entity-privacy tag matches.
    expect(part.payload).toEqual([
      { email: 'lucia@x.com', name: 'Lucía Castellanos', target_id: 'lucia@x.com', kind: 'contact' },
      { email: 'acme', name: 'Acme Corp', target_id: 'acme', kind: 'company' },
    ]);
    // No inline `__entity` marker in the producer's payload — the gather stamps
    // it (the package stays free of the privacy-substrate constant).
    expect(part.payload.every((r) => !('__entity' in r))).toBe(true);
    // The render reproduces the speculative block from the (here un-aliased)
    // payload, reading email/name back as ref/label.
    expect(renderPart(part)).toContain('Lucía Castellanos (contact, ref: lucia@x.com)');
  });
  it('carries a resolved candidate phone on the payload (ledger-aliasing) but never renders it', async () => {
    const { ctx, parts } = makeCtx('who is +14155550199');
    const withPhone: readonly PrefetchCandidate[] = [
      { ref: 'rae@x.com', label: 'Rae Kim', kind: 'contact', score: 5, phone: '+14155550199' },
    ];
    await contributePrefetch(ctx, { search: fakeSearch(withPhone), minScore: 0 });
    const part = parts[0];
    if (part === undefined || part.role !== 'entity') throw new Error('expected entity part');
    // phone rides on the payload (the `contact` entity-privacy tag stamps it →
    // seeds the turn ledger so a user-typed known phone gets aliased) ...
    expect(part.payload).toEqual([
      { email: 'rae@x.com', name: 'Rae Kim', target_id: 'rae@x.com', kind: 'contact', phone: '+14155550199' },
    ]);
    // ... but the rendered block reads only email/name — the raw phone never
    // reaches the prompt text.
    expect(renderPart(part)).not.toContain('+14155550199');
    expect(renderPart(part)).toContain('Rae Kim (contact, ref: rae@x.com)');
  });
  it('omits phone from the payload when the candidate has none (behavior-preserving)', async () => {
    const { ctx, parts } = makeCtx('is Lucía available');
    await contributePrefetch(ctx, { search: fakeSearch(CANDS), minScore: 0 });
    const part = parts[0];
    if (part === undefined || part.role !== 'entity') throw new Error('expected entity part');
    expect(part.payload.every((r) => !('phone' in r))).toBe(true);
  });
  it('carries the ambiguity flag only on ambiguous payload records', async () => {
    const { ctx, parts } = makeCtx('which Sarah or Bob');
    await contributePrefetch(ctx, {
      search: fakeSearch([
        { ref: 'bob@x.com', label: 'Bob Stone', kind: 'contact', score: 1 },
        { ref: 'sarah@x.com', label: 'Sarah Adams', kind: 'contact', score: 1, ambiguous: true },
      ]),
      minScore: 0,
    });
    const part = parts[0];
    if (part === undefined || part.role !== 'entity') throw new Error('expected entity part');
    expect(part.payload).toEqual([
      { email: 'bob@x.com', name: 'Bob Stone', target_id: 'bob@x.com', kind: 'contact' },
      { email: 'sarah@x.com', name: 'Sarah Adams', target_id: 'sarah@x.com', kind: 'contact', ambiguous: true },
    ]);
    expect(part.payload[0]).not.toHaveProperty('ambiguous');
  });
  it('round-trips the ambiguity flag through the contributed entity part render', async () => {
    const { ctx, parts } = makeCtx('which Sarah or Bob');
    await contributePrefetch(ctx, {
      search: fakeSearch([
        { ref: 'bob@x.com', label: 'Bob Stone', kind: 'contact', score: 1 },
        { ref: 'sarah@x.com', label: 'Sarah Adams', kind: 'contact', score: 1, ambiguous: true },
      ]),
      minScore: 0,
    });
    const block = renderPart(parts[0]);
    const blocks = block.split('\n\n');
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toContain('speculative');
    expect(blocks[0]).toContain('Bob Stone (contact, ref: bob@x.com)');
    expect(blocks[0]).not.toContain('Sarah Adams');
    expect(blocks[1]).toContain('Do NOT assume');
    expect(blocks[1]).toContain('ask the user to clarify');
    expect(blocks[1]).toContain('Sarah Adams (contact, ref: sarah@x.com)');
    expect(blocks[1]).not.toContain('Bob Stone');
  });
  it('carries a resolved candidate company (B4 org seed) but never renders it', async () => {
    const { ctx, parts } = makeCtx('the Datadog renewal');
    const withCompany: readonly PrefetchCandidate[] = [
      { ref: 'rae@x.com', label: 'Rae Kim', kind: 'contact', score: 5, company: 'Datadog' },
    ];
    await contributePrefetch(ctx, { search: fakeSearch(withCompany), minScore: 0 });
    const part = parts[0];
    if (part === undefined || part.role !== 'entity') throw new Error('expected entity part');
    // company rides on the payload (tagged `org` → seeds the ledger) ...
    expect(part.payload).toEqual([
      { email: 'rae@x.com', name: 'Rae Kim', target_id: 'rae@x.com', kind: 'contact', company: 'Datadog' },
    ]);
    // ... but the rendered block reads only email/name — the raw company never
    // reaches the prompt text (mirrors phone).
    expect(renderPart(part)).not.toContain('Datadog');
    expect(renderPart(part)).toContain('Rae Kim (contact, ref: rae@x.com)');
  });
  it('WITHHOLDS a single-token common-word company from the seed (B4 filter)', async () => {
    const { ctx, parts } = makeCtx('mind the gap');
    const withGap: readonly PrefetchCandidate[] = [
      { ref: 'rae@x.com', label: 'Rae Kim', kind: 'contact', score: 5, company: 'Gap' },
    ];
    await contributePrefetch(ctx, { search: fakeSearch(withGap), minScore: 0 });
    const part = parts[0];
    if (part === undefined || part.role !== 'entity') throw new Error('expected entity part');
    // `company` omitted (never seeded → no "mind the gap" over-alias); the
    // multi-token name still rides.
    expect(part.payload[0]).not.toHaveProperty('company');
    expect(part.payload).toEqual([
      { email: 'rae@x.com', name: 'Rae Kim', target_id: 'rae@x.com', kind: 'contact' },
    ]);
  });
  it('WITHHOLDS a single-token common-word NAME from the seed (drops the label)', async () => {
    const { ctx, parts } = makeCtx('I will follow up later');
    const willContact: readonly PrefetchCandidate[] = [
      // resolved by email (pinned), but the whole name IS a common word.
      { ref: 'will@x.com', label: 'Will', kind: 'contact', score: 5, pinned: true },
    ];
    await contributePrefetch(ctx, { search: fakeSearch(willContact), minScore: 0 });
    const part = parts[0];
    if (part === undefined || part.role !== 'entity') throw new Error('expected entity part');
    // `name` omitted → never seeded → `scanContent` can't alias "will" in prose.
    // The email ref still surfaces (the accepted comfort trade, design §5).
    expect(part.payload[0]).not.toHaveProperty('name');
    expect(part.payload).toEqual([
      { email: 'will@x.com', target_id: 'will@x.com', kind: 'contact' },
    ]);
  });
  it('contributes nothing on empty search (zero-harm)', async () => {
    const { ctx, parts } = makeCtx('is Lucía available');
    expect(await contributePrefetch(ctx, { search: noopEntitySearch })).toEqual([]);
    expect(parts).toHaveLength(0);
  });
  it('no user text → nothing', async () => {
    const { ctx, parts } = makeCtx('');
    expect(await contributePrefetch(ctx, { search: fakeSearch(CANDS) })).toEqual([]);
    expect(parts).toHaveLength(0);
  });
});

describe('prefetch — middleware wiring', () => {
  it('the prompt hook contributes prefetch on gate pass-through', async () => {
    const mw = createPromptCacheMiddleware(undefined, {
      search: fakeSearch(CANDS), minScore: 0,
    });
    const { ctx, parts } = makeCtx('is Lucía available');
    await mw.prompt?.(ctx);
    expect(parts.filter((p) => renderPart(p).includes('Lucía Castellanos'))).toHaveLength(1);
  });
  it('the default middleware (noop search) contributes nothing — behavior-preserving', async () => {
    const mw = createPromptCacheMiddleware();
    const { ctx, parts } = makeCtx('is Lucía available');
    await mw.prompt?.(ctx);
    expect(parts).toHaveLength(0);
  });
});
