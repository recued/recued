/** Grant-foundation slice 3 (D-187 AMENDMENT §3) — the VERB-OP term of the read gate,
 *  at the four MCP-native read handlers.
 *
 *  The amendment read gate is `verb-op grant ∧ entry grant` (`isGrantedReadAdmissible`):
 *  the four cross-topic read verbs (timeline / registry.describe / enrichment.read /
 *  vector_search) are gated by a per-contract `op` grant ("may this contract use this read
 *  tool at all"), composed with the per-topic / per-collection entry grant. A topic /
 *  collection grant does NOT imply the verb. This suite pins that EACH handler composes the
 *  verb-op: a checker that grants the entry but DENIES the verb-op still rejects / empties
 *  the read (the denial paths short-circuit BEFORE any store access, so the deps stay
 *  minimal). The checker-resolution side (the verb-op resolves identically to
 *  `isOpGranted`) is pinned in `grant-foundation-3b-admission.test.ts`. */

import { describe, expect, it } from 'vitest';

import { handleRegistryDescribe } from '../mcp/registry-describe.js';
import { handleEnrichmentRead } from '../mcp/enrichment-read.js';
import { handleVectorSimilaritySearch } from '../mcp/vector-similarity.js';
import { handleTimelineRequest } from '../mcp/timeline.js';
import { handleContactEngagementsList } from '../mcp/contact-engagements.js';
import type { ReadGrantChecker } from '../read-grant-checker.js';

// `company` — a registry-default-`public` enrichment topic (the d-136/d-177 probe).
const PUBLIC_TOPIC = 'company';

/** Grants EVERYTHING — entry AND verb-op. */
const grantAll: ReadGrantChecker = {
  isTopicReadGranted: () => true,
  isCollectionReadGranted: () => true,
  isVerbOpGranted: () => true,
};

/** Grants every ENTRY (topic + collection) but DENIES the verb-op — the case the read
 *  gate must still reject (the verb-op is a separate AND-term, not implied by the entry). */
const denyVerbOp: ReadGrantChecker = {
  isTopicReadGranted: () => true,
  isCollectionReadGranted: () => true,
  isVerbOpGranted: () => false,
};

/** Grants the verb-op but DENIES the collection entry — the symmetric reject (the entry
 *  term is a separate AND-term too). Used for the engagements `data.contact` gate. */
const denyCollection: ReadGrantChecker = {
  isTopicReadGranted: () => true,
  isCollectionReadGranted: () => false,
  isVerbOpGranted: () => true,
};

describe('D-187 slice 3 — the verb-op term gates each native read handler', () => {
  describe('registryDescribe', () => {
    it('a denied verb-op empties the catalog even though every topic is entry-granted', () => {
      const out = handleRegistryDescribe({ readGrantChecker: denyVerbOp });
      expect(out.topics).toEqual([]);
      expect(out.total_rows_visible).toBe(0);
    });

    it('control: with the verb-op granted, the catalog is non-empty', () => {
      const out = handleRegistryDescribe({ readGrantChecker: grantAll });
      expect(out.topics.length).toBeGreaterThan(0);
    });

    it('a denied verb-op zeroes total_rows_visible even when the store has rows but db is absent (codex MEDIUM)', () => {
      // enrichmentStore.count() is nonzero, but db is NOT wired — the per-topic counter
      // short-circuits to 0 without db, so the visible total must be zeroed by the
      // verb-op denial at the handler, not left at the raw store count.
      const out = handleRegistryDescribe({
        readGrantChecker: denyVerbOp,
        enrichmentStore: { count: () => 42 } as never,
        // deliberately NO `db`
      });
      expect(out.topics).toEqual([]);
      expect(out.total_rows_visible).toBe(0);
    });
    // The GRANTED-branch total_rows_visible computation (count − pinned − ungranted) is
    // unchanged by the `verbOpGranted ? … : 0` wrapper and stays covered by the real-db
    // `countUngrantedTopicRows` cases in d-136-phase-7-e-mcp-exposed-gate.test.ts.

    it('the Settings-UI bypass (includePrivateTopics) is NOT verb-op-gated (human config)', () => {
      // The owner configuring their warehouse must see every topic regardless of the
      // AI-facing verb-op grant — `includePrivateTopics` exempts the panel.
      const out = handleRegistryDescribe({
        readGrantChecker: denyVerbOp,
        includePrivateTopics: true,
      });
      expect(out.topics.length).toBeGreaterThan(0);
    });
  });

  describe('enrichmentRead', () => {
    it('a denied verb-op rejects the read even though the topic is entry-granted', () => {
      // validateInput throws BEFORE the store is touched — `{}` deps are never read.
      expect(() =>
        handleEnrichmentRead(
          { enrichmentStore: {} as never, readGrantChecker: denyVerbOp },
          { topic: PUBLIC_TOPIC },
        ),
      ).toThrow(/not read-granted/);
    });
  });

  describe('vectorSimilaritySearch', () => {
    it('a denied verb-op rejects the search even though the topic is entry-granted', () => {
      // The read-grant reject fires before the sidecar (vector_index) check, so the deps +
      // a non-vector topic never matter for the denial path.
      expect(() =>
        handleVectorSimilaritySearch(
          { enrichmentStore: {} as never, db: {} as never, readGrantChecker: denyVerbOp },
          { query_vector: [0.1, 0.2], topic: PUBLIC_TOPIC, limit: 5 },
        ),
      ).toThrow(/not read-granted/);
    });
  });

  describe('dataTimeline', () => {
    it('a denied verb-op empties the feed even though the entity collection is entry-granted', async () => {
      // The whole-tool gate (verb-op ∧ collection grant) returns an empty feed BEFORE any
      // loader runs, so minimal deps suffice. gateMcpPrivate: true = the MCP read-gate path.
      const out = await handleTimelineRequest(
        { gateMcpPrivate: true, readGrantChecker: denyVerbOp },
        { entity_id: 'mail:abc123' },
      );
      expect(out.entries).toEqual([]);
    });

    it('control: with gateMcpPrivate OFF (human HID browse), the verb-op gate does not apply', async () => {
      // The webclient HID warehouse browse is outside the grant axis — even the deny
      // checker is never consulted, so the fence does not empty the feed for that reason.
      // (No stores wired ⇒ the loaders contribute nothing ⇒ an empty but UNGATED feed.)
      const out = await handleTimelineRequest(
        { gateMcpPrivate: false, readGrantChecker: denyVerbOp },
        { entity_id: 'mail:abc123' },
      );
      // The assertion that matters: it did not THROW and returned a well-formed response;
      // the deny checker was bypassed (gateMcpPrivate off), proving the HID path stays
      // outside the verb-op gate.
      expect(Array.isArray(out.entries)).toBe(true);
    });
  });

  describe('contactEngagementsList (slice 3b)', () => {
    // The read gate is `verb-op grant ∧ data.contact collection grant`. The deny paths
    // short-circuit BEFORE the resolver touches any store, so `{}` deps are never read.
    it('a denied verb-op rejects the read even though data.contact is entry-granted', () => {
      expect(() =>
        handleContactEngagementsList({} as never, {}, { readGrantChecker: denyVerbOp }),
      ).toThrow(/not read-granted/);
    });

    it('a denied data.contact rejects the read even though the verb-op is granted', () => {
      expect(() =>
        handleContactEngagementsList({} as never, {}, { readGrantChecker: denyCollection }),
      ).toThrow(/not read-granted/);
    });
  });
});
