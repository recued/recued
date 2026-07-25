/** D-137 P3 § A.12 — Compound ambiguity cascade analyzer.
 *
 *  When a query carries multiple ambiguity dimensions ("Peter from
 *  Acme" — multiple Peters AND multiple Acmes), the spec dictates a
 *  resolution order:
 *
 *    1. **Company first** (`Acme`) — usually fewer companies than
 *       people in a user's data; least ambiguous step. Pattern 2/3
 *       fires here if needed.
 *    2. **Email domain as filter** (`@acme.com`) — once company is
 *       fixed, domain becomes a hard deterministic filter. In B2B
 *       contexts domain → company is usually 1:1, collapsing the
 *       search space cleanly.
 *    3. **Person within domain** (`Peter`) — final layer, usually
 *       1-3 candidates. Standard Pattern 1/2/3 dispatch.
 *
 *  Matches how humans naturally disambiguate ("the Peter from
 *  Acme") — start with bigger context, narrow down. Cognitively
 *  aligned.
 *
 *  This module ships the **substrate** an agent-driven cascade is
 *  built on (no live caller wires it yet):
 *
 *    - A pure `detectCompoundAmbiguity(query)` heuristic that
 *      returns a structured plan when the query carries multiple
 *      named entities. The plan is designed for the agent loop to
 *      read and walk the cascade across multiple tool calls (one per
 *      layer); the compound-ambiguity acceptance test asserts the
 *      detector's plan ordering.
 *    - A pure `narrowByDomain(candidates, domain)` filter for
 *      Layer 2 (post-company resolution).
 *
 *  The actual sequencing is agent-driven (the agent reasons over the
 *  surfaced plan) — this substrate just exposes the deterministic
 *  cascade vocabulary so the agent's prose stays consistent across
 *  turns + the audit trail captures which layer each tool call
 *  attempted to resolve.
 *
 *  Pure: no I/O, no clock, no shared state. Same input → same plan. */

/** § A.12 — closed list of cascade layer kinds. The agent walks the
 *  plan in this order; each layer's tool call constrains the next. */
export type CompoundAmbiguityLayer = 'company' | 'email_domain' | 'person';

export const COMPOUND_AMBIGUITY_LAYERS: ReadonlyArray<CompoundAmbiguityLayer> = [
  'company',
  'email_domain',
  'person',
] as const;

/** § A.12 — per-layer entity hint. The agent reads `value` as the
 *  raw user-supplied token (e.g., "Acme" / "Peter") and uses it to
 *  shape the next tool call's `query` arg. `value` is preserved
 *  verbatim — no case-folding, no trimming — because the agent's
 *  prompt may want the original casing for prose. */
export interface CompoundAmbiguityEntity {
  layer: CompoundAmbiguityLayer;
  value: string;
}

/** § A.12 — full cascade plan. `entities` lists the per-layer hints
 *  in resolution order; the agent walks them sequentially. `plan_kind`
 *  collapses to `'single'` when there's no compound structure (one
 *  entity OR a free-text question); the agent skips the cascade and
 *  goes straight to Pattern 1-4 dispatch. */
export type CompoundAmbiguityPlan =
  | { plan_kind: 'single' }
  | { plan_kind: 'cascade'; entities: ReadonlyArray<CompoundAmbiguityEntity> };

/** Common B2B preposition tokens that indicate compound structure.
 *  Closed list — adding patterns is a substrate change so the audit
 *  trail captures every heuristic addition. Single-word queries don't
 *  trip the cascade (the substrate only fires when the query has a
 *  `<person> <preposition> <company>` shape). */
const COMPOUND_PREPOSITIONS: ReadonlySet<string> = new Set([
  'from',
  'at',
  'in',
]);

/** Words that almost-certainly aren't person-name first words (rough
 *  function-word filter). Conservative — the substrate prefers
 *  false-negatives (skip cascade, fall through to direct dispatch)
 *  over false-positives (invent a cascade structure the user didn't
 *  ask for). */
const STOPWORDS: ReadonlySet<string> = new Set([
  'the',
  'a',
  'an',
  'and',
  'or',
  'who',
  'what',
  'when',
  'where',
  'why',
  'how',
  'tell',
  'show',
  'find',
  'me',
  'about',
]);

/** § A.12 — detection heuristic. Returns a cascade plan when the
 *  query shape matches `<person-token>+ <preposition> <company-token>+`.
 *  Tokens are case-preserved but compared case-insensitively against
 *  the closed preposition + stopword lists.
 *
 *  Examples:
 *
 *    - "Peter from Acme"         → cascade [company:'Acme', person:'Peter']
 *    - "John Smith at Globex"    → cascade [company:'Globex', person:'John Smith']
 *    - "Peter"                   → single
 *    - "tell me about Acme"      → single (no preposition between names)
 *    - "find Peter"              → single (verb stripped; only one entity)
 *
 *  The email-domain layer is meant to be synthesized by the agent
 *  from the resolved company entity (post-company-resolution, the
 *  agent would map `Acme` → `@acme.com` via the candidate's `email`
 *  field). The detector itself emits `[company, person]`; the agent
 *  would insert the domain layer between them. The acceptance test
 *  ("Compound ambiguity cascade") exercises the detector's output.
 *
 *  Pure; no clock, no I/O. */
export const detectCompoundAmbiguity = (query: string): CompoundAmbiguityPlan => {
  const trimmed = query.trim();
  if (trimmed.length === 0) return { plan_kind: 'single' };

  // Strip leading verbs / stopwords ("tell me about Peter from Acme"
  // → "Peter from Acme") so the detector keys on the structural shape
  // rather than imperative prefixes.
  const rawTokens = trimmed.split(/\s+/);
  const tokens: string[] = [];
  let stripping = true;
  for (const t of rawTokens) {
    const lower = t.toLowerCase();
    if (stripping && STOPWORDS.has(lower)) continue;
    stripping = false;
    tokens.push(t);
  }
  if (tokens.length < 3) return { plan_kind: 'single' };

  // Find the rightmost preposition that splits the remaining tokens
  // into a non-empty prefix + non-empty suffix. Rightmost wins so
  // "John from Acme in San Francisco" cleanly splits to
  // [person:'John', company:'Acme in San Francisco'] — the
  // disambiguation cascade treats the trailing chunk as the company
  // anchor.
  for (let i = tokens.length - 2; i >= 1; i--) {
    const lower = tokens[i]!.toLowerCase();
    if (!COMPOUND_PREPOSITIONS.has(lower)) continue;
    const personTokens = tokens.slice(0, i);
    const companyTokens = tokens.slice(i + 1);
    if (personTokens.length === 0 || companyTokens.length === 0) continue;
    // Drop trailing punctuation from the company chunk — "Acme?" →
    // "Acme". Conservative: only strip the closed set `? . , !`.
    const companyClean = companyTokens
      .map((t) =>
        t.endsWith('?') || t.endsWith('.') || t.endsWith(',') || t.endsWith('!')
          ? t.slice(0, -1)
          : t,
      )
      .filter((t) => t.length > 0)
      .join(' ');
    const personClean = personTokens.join(' ');
    if (companyClean.length === 0 || personClean.length === 0) continue;
    return {
      plan_kind: 'cascade',
      entities: [
        { layer: 'company', value: companyClean },
        { layer: 'person', value: personClean },
      ],
    };
  }
  return { plan_kind: 'single' };
};

/** § A.12 Layer 2 — pure helper. Filters a candidate list by email
 *  domain. Intended for the agent to use after Layer 1 (company
 *  resolution) to derive the deterministic domain filter the spec
 *  mentions
 *  ("In B2B contexts the domain → company mapping is usually 1:1,
 *  collapsing the search space cleanly").
 *
 *  Compares against the candidate's `email` field, lowercased, by
 *  suffix match (`@acme.com` matches `peter@acme.com` but not
 *  `peter@acmeholdings.com`). Candidates without an email pass
 *  through filtered out (the cascade narrows; entries that can't
 *  contribute domain evidence drop). Pure. */
export const narrowByDomain = <T extends { email?: string | null }>(
  candidates: ReadonlyArray<T>,
  domain: string,
): ReadonlyArray<T> => {
  const normalized = domain.toLowerCase().trim();
  if (normalized.length === 0) return candidates;
  const stripped = normalized.startsWith('@')
    ? normalized
    : `@${normalized}`;
  return candidates.filter((c) => {
    if (typeof c.email !== 'string' || c.email.length === 0) return false;
    return c.email.toLowerCase().endsWith(stripped);
  });
};
