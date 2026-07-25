/** D-164 — enrichment registry terse first-sentence ratchet.
 *
 *  The chat catalog facade projects warehouse-backed enrichment topics as
 *  `Pre-computed fact — <first sentence>`. Because that facade is backend-
 *  private, this contracts ratchet mirrors its sentence extractor and pins
 *  the source copy in `ENRICHMENT_REGISTRY` instead of importing across the
 *  public package boundary.
 *
 *  When this fires legitimately, rewrite the offending registry description
 *  so its first sentence is concise agent-facing meaning copy (<= 110 chars),
 *  the first period is a real sentence terminator, and the full MCP
 *  description still ends sentence-shaped.
 */

import { describe, expect, it } from 'vitest';

import { ENRICHMENT_REGISTRY } from '../enrichment-registry.js';

// Mirrors backend/server/src/chat-enrichment-topic-tools.ts firstSentence.
const firstSentence = (text: string): string => {
  const match = /^[^.]*\./.exec(text);
  return (match ? match[0] : text).trim();
};

describe('D-164 — enrichment registry terse first sentence', () => {
  it('keeps every enrichment topic chat-catalog sentence terse and cleanly terminated', () => {
    for (const [topic, entry] of Object.entries(ENRICHMENT_REGISTRY)) {
      const description = entry.description;

      expect(
        typeof description,
        `${topic} description must be a non-empty string; got ${String(description)}`,
      ).toBe('string');
      expect(
        description.trim().length,
        `${topic} description must be a non-empty string; got ${JSON.stringify(description)}`,
      ).toBeGreaterThan(0);

      const sentence = firstSentence(description);
      expect(
        sentence.length,
        `${topic} first sentence is ${sentence.length} chars; expected <= 110: ${JSON.stringify(sentence)}`,
      ).toBeLessThanOrEqual(110);

      const firstPeriod = description.indexOf('.');
      expect(
        firstPeriod,
        `${topic} description must contain a period terminator; got ${JSON.stringify(description)}`,
      ).toBeGreaterThanOrEqual(0);

      const afterFirstPeriod = description[firstPeriod + 1];
      expect(
        afterFirstPeriod === undefined || afterFirstPeriod === ' ',
        `${topic} first period must terminate cleanly; offending text: ${JSON.stringify(description)}`,
      ).toBe(true);

      expect(
        description.trim().endsWith('.'),
        `${topic} description must end with '.'; offending text: ${JSON.stringify(description)}`,
      ).toBe(true);
    }
  });
});
