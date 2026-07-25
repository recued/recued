/** D-137 P3 § A.12 — compound-ambiguity cascade tests.
 *
 *  Covers `detectCompoundAmbiguity` heuristic edge cases +
 *  `narrowByDomain` Layer-2 filter. */

import { describe, expect, it } from 'vitest';
import {
  detectCompoundAmbiguity,
  narrowByDomain,
  COMPOUND_AMBIGUITY_LAYERS,
} from '../compound-ambiguity.js';

describe('D-137 P3 § A.12 — closed layer list', () => {
  it('exports the three cascade layers in resolution order', () => {
    expect(COMPOUND_AMBIGUITY_LAYERS).toEqual([
      'company',
      'email_domain',
      'person',
    ]);
  });
});

describe('D-137 P3 § A.12 — detectCompoundAmbiguity', () => {
  it('returns cascade plan for "Peter from Acme"', () => {
    const plan = detectCompoundAmbiguity('Peter from Acme');
    expect(plan.plan_kind).toBe('cascade');
    if (plan.plan_kind === 'cascade') {
      expect(plan.entities).toEqual([
        { layer: 'company', value: 'Acme' },
        { layer: 'person', value: 'Peter' },
      ]);
    }
  });

  it('strips leading verbs / stopwords before detection', () => {
    const plan = detectCompoundAmbiguity('tell me about Peter from Acme');
    expect(plan.plan_kind).toBe('cascade');
    if (plan.plan_kind === 'cascade') {
      expect(plan.entities[0]?.value).toBe('Acme');
      expect(plan.entities[1]?.value).toBe('Peter');
    }
  });

  it('handles multi-word person and company names', () => {
    const plan = detectCompoundAmbiguity('John Smith at Globex Corporation');
    expect(plan.plan_kind).toBe('cascade');
    if (plan.plan_kind === 'cascade') {
      expect(plan.entities[0]?.value).toBe('Globex Corporation');
      expect(plan.entities[1]?.value).toBe('John Smith');
    }
  });

  it('strips trailing punctuation from company chunk', () => {
    const plan = detectCompoundAmbiguity('Peter from Acme?');
    expect(plan.plan_kind).toBe('cascade');
    if (plan.plan_kind === 'cascade') {
      expect(plan.entities[0]?.value).toBe('Acme');
    }
  });

  it('returns single for one-token queries', () => {
    expect(detectCompoundAmbiguity('Peter').plan_kind).toBe('single');
    expect(detectCompoundAmbiguity('find Peter').plan_kind).toBe('single');
  });

  it('returns single when no preposition splits the tokens', () => {
    expect(detectCompoundAmbiguity('Peter Smith Acme').plan_kind).toBe('single');
  });

  it('returns single on empty query', () => {
    expect(detectCompoundAmbiguity('').plan_kind).toBe('single');
    expect(detectCompoundAmbiguity('   ').plan_kind).toBe('single');
  });

  it('returns single when query is all stopwords', () => {
    expect(detectCompoundAmbiguity('tell me about').plan_kind).toBe('single');
  });

  it('uses rightmost preposition as the split point', () => {
    // "John from Acme in Slack" → split on "in" → company chunk
    // "Slack" (rightmost preposition). Choice is principled per the
    // substrate doc (compound chunks generally hang to the right;
    // "from" / "at" / "in" routinely chain).
    const plan = detectCompoundAmbiguity('John from Acme in Slack');
    expect(plan.plan_kind).toBe('cascade');
    if (plan.plan_kind === 'cascade') {
      expect(plan.entities[0]?.value).toBe('Slack');
      expect(plan.entities[1]?.value).toBe('John from Acme');
    }
  });

  it('treats "at" + "in" as compound prepositions too', () => {
    expect(detectCompoundAmbiguity('Peter at Acme').plan_kind).toBe('cascade');
    expect(detectCompoundAmbiguity('Peter in Acme').plan_kind).toBe('cascade');
  });
});

describe('D-137 P3 § A.12 — narrowByDomain (Layer 2)', () => {
  type Row = { email?: string | null; id: string };
  const data: Row[] = [
    { id: 'a', email: 'peter@acme.com' },
    { id: 'b', email: 'peter@globex.com' },
    { id: 'c', email: 'PETER@Acme.com' },
    { id: 'd', email: null },
    { id: 'e' },
    { id: 'f', email: 'peter@acmeholdings.com' },
  ];

  it('filters to candidates whose email ends with @<domain>', () => {
    const out = narrowByDomain(data, 'acme.com');
    expect(out.map((r) => r.id)).toEqual(['a', 'c']);
  });

  it('accepts pre-prefixed @domain input verbatim', () => {
    const out = narrowByDomain(data, '@acme.com');
    expect(out.map((r) => r.id)).toEqual(['a', 'c']);
  });

  it('is case-insensitive on both candidate email + domain', () => {
    const out = narrowByDomain(data, 'ACME.com');
    expect(out.map((r) => r.id)).toEqual(['a', 'c']);
  });

  it('does NOT match domain prefix collisions ("acme.com" vs "acmeholdings.com")', () => {
    const out = narrowByDomain(data, 'acme.com');
    expect(out.find((r) => r.id === 'f')).toBeUndefined();
  });

  it('drops rows without an email (no domain evidence)', () => {
    const out = narrowByDomain(data, 'acme.com');
    for (const row of out) {
      expect(row.email).toBeDefined();
    }
  });

  it('returns input verbatim on empty / whitespace domain (no-op)', () => {
    expect(narrowByDomain(data, '').length).toBe(data.length);
    expect(narrowByDomain(data, '   ').length).toBe(data.length);
  });
});
