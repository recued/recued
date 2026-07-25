/** (ii) — the native MCP enrichment rpcs honor the door's per-topic contract
 *  grant. D-187 AMENDMENT — a topic read is ONE `enrichment.<topic>` grant lookup
 *  via the read-grant checker. Slice 5/6 — a door fenced to a topic / collection
 *  subset is expressed DIRECTLY as grant rows (the listed topics / collections
 *  GRANTED, the rest REVOKED), replacing the retired `scope_restrictions`
 *  author-default. Drives `_testing.handleToolCall`: removing the read-grant gate in
 *  the `recued_enrichmentRead` / `recued_vectorSimilaritySearch` case (or the
 *  `registryDescribe` filter / `timeline` filter) fails these. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isReadableCollection, parseGrantEntry } from '@recued/contracts';
import { _testing } from '../mcp-server.js';
import { handleRegistryDescribe } from '../mcp/registry-describe.js';
import { handleTimelineRequest } from '../mcp/timeline.js';
import type { GrantEntryResolver } from '../contract-grant-resolve.js';
import { createReadGrantChecker } from '../read-grant-checker.js';
import {
  createEnrichmentStore,
  type EnrichmentStore,
} from '../storage/enrichment-store.js';

/** A door's slice-5 read fence as explicit grant rows: the listed topics /
 *  collections GRANTED, every other topic + every other GOVERNED collection REVOKED
 *  (a non-governed collection defers to its own gate). `allTopics` grants every topic
 *  (the `data.enrichment.*` wildcard analog). */
type FenceSpec = {
  collections?: readonly string[];
  topics?: readonly string[];
  allTopics?: boolean;
};

const fence = (spec: FenceSpec): GrantEntryResolver => {
  const cols = new Set(spec.collections ?? []);
  const topics = new Set(spec.topics ?? []);
  return {
    isGranted: (_c, entry, authorDefault) => {
      const parsed = parseGrantEntry(entry);
      if (parsed.kind === 'collection')
        return isReadableCollection(parsed.value) ? cols.has(parsed.value) : authorDefault;
      if (parsed.kind === 'topic') return spec.allTopics === true || topics.has(parsed.value);
      return authorDefault;
    },
  };
};

const checkerFor = (spec: FenceSpec) => createReadGrantChecker(fence(spec), undefined);

/** Seed one transcript enrichment row on a `file` entity (transcript's
 *  `valid_scopes` is `['file']`). The `value` matches `TranscriptValue`. */
const seedTranscript = (target: string, text: string): void => {
  store.upsert({
    topic: 'transcript',
    scope: 'file',
    target_id: target,
    value: { text },
    authored_by: 'system.housekeeping.transcript',
    event_at: NOW,
  });
};

type HandleToolCallDeps = Parameters<typeof _testing.handleToolCall>[1];

const NOW = 1_750_000_000_000;
let dir: string;
let db: Database.Database;
let store: EnrichmentStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd-177-enrich-dispatch-'));
  db = new Database(join(dir, 'test.db'));
  store = createEnrichmentStore(db, { now: () => NOW });
});

afterEach(() => {
  store.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Minimal deps reaching the enrichment cases: no `inboundTokenAuthorize`
 *  (skips the per-token gate), inert `contractOverlay.resolve` (dispatch proceeds), and
 *  D-187 AMENDMENT — `resolveReadGrantChecker` supplies the door's read-grant checker
 *  (built from `spec`). A real store + db satisfy the case guards; a not-read-granted
 *  topic is rejected BEFORE the store is read. `undefined` spec = no checker (owner /
 *  unbound → the handler's author-default checker admits all). */
const makeDeps = (spec: FenceSpec | undefined): HandleToolCallDeps =>
  ({
    enrichmentStore: store,
    db,
    contractOverlay: {
      shouldMeterUse: () => false,
      recordUse: () => {},
      isContractLive: () => false,
      ...(spec !== undefined ? { resolveReadGrantChecker: () => checkerFor(spec) } : {}),
    },
  }) as unknown as HandleToolCallDeps;

const textOf = (response: unknown): string =>
  (response as { content?: Array<{ text?: string }> }).content?.[0]?.text ?? '';

describe('(ii) recued_enrichmentRead / vectorSimilaritySearch honor the door per-topic grant', () => {
  it('enrichmentRead REJECTS a topic not read-granted to the door (before any store read)', async () => {
    const response = await _testing.handleToolCall(
      { name: 'recued_enrichmentRead', arguments: { topic: 'caption' } },
      makeDeps({ topics: ['transcript'] }),
    );
    // The per-topic content gate: a door granted `transcript` can't read `caption`.
    expect(textOf(response)).toContain('not read-granted');
  });

  it('enrichmentRead ADMITS the granted topic (reaches the handler past the gate)', async () => {
    const response = await _testing.handleToolCall(
      { name: 'recued_enrichmentRead', arguments: { topic: 'transcript' } },
      makeDeps({ topics: ['transcript'] }),
    );
    expect(textOf(response)).not.toContain('not read-granted');
  });

  it('an allTopics grant admits any topic (collection-subset doors keep reading)', async () => {
    const response = await _testing.handleToolCall(
      { name: 'recued_enrichmentRead', arguments: { topic: 'caption' } },
      makeDeps({ allTopics: true }),
    );
    expect(textOf(response)).not.toContain('not read-granted');
  });

  it('no checker (owner / unbound bearer) admits any topic', async () => {
    const response = await _testing.handleToolCall(
      { name: 'recued_enrichmentRead', arguments: { topic: 'caption' } },
      makeDeps(undefined),
    );
    expect(textOf(response)).not.toContain('not read-granted');
  });

  it('vectorSimilaritySearch REJECTS a topic not read-granted to the door', async () => {
    const response = await _testing.handleToolCall(
      {
        name: 'recued_vectorSimilaritySearch',
        arguments: { topic: 'caption', query_vector: [0.1], limit: 5 },
      },
      makeDeps({ topics: ['transcript'] }),
    );
    expect(textOf(response)).toContain('not read-granted');
  });
});

describe('(ii) registryDescribe filters the agent catalog by door grant', () => {
  it('a per-topic grant surfaces only the granted topic', () => {
    const out = handleRegistryDescribe({
      enrichmentStore: store,
      readGrantChecker: checkerFor({ topics: ['transcript'] }),
    });
    const topics = out.topics.map((t) => t.topic);
    expect(topics).toContain('transcript');
    expect(topics).not.toContain('caption');
  });

  it('no checker surfaces the full catalog (owner / Settings-UI proxy — author defaults)', () => {
    const out = handleRegistryDescribe({
      enrichmentStore: store,
    });
    const topics = out.topics.map((t) => t.topic);
    expect(topics).toContain('transcript');
    expect(topics).toContain('caption');
  });
});

// Codex review-of-fix FINDING 1 — the timeline is a THIRD native rpc that
// surfaces enrichment `value`; it must apply the SAME per-topic door-grant gate.
describe('(ii) recued_dataTimeline filters enrichment rows by the door per-topic grant', () => {
  const enrichmentEntries = (res: { entries: Array<{ source: string }> }) =>
    res.entries.filter((e) => e.source === 'enrichment');

  it("DROPS an enrichment row whose topic is not read-granted to the door (no value egress)", async () => {
    seedTranscript('file-1', 'TOP SECRET transcript text');
    const res = await handleTimelineRequest(
      {
        enrichmentStore: store,
        // file readable (entity not fenced) but transcript NOT granted
        readGrantChecker: checkerFor({ collections: ['file'], topics: ['caption'] }),
        gateMcpPrivate: true,
      },
      { entity_id: 'file:file-1' },
    );
    expect(enrichmentEntries(res)).toHaveLength(0);
    expect(JSON.stringify(res)).not.toContain('TOP SECRET transcript text');
  });

  it('SURFACES the enrichment row when the topic IS granted', async () => {
    seedTranscript('file-1', 'granted transcript text');
    const res = await handleTimelineRequest(
      {
        enrichmentStore: store,
        readGrantChecker: checkerFor({ collections: ['file'], topics: ['transcript'] }),
        gateMcpPrivate: true,
      },
      { entity_id: 'file:file-1' },
    );
    expect(enrichmentEntries(res)).toHaveLength(1);
  });

  it('no checker (owner) surfaces every enrichment row', async () => {
    seedTranscript('file-1', 'owner sees this');
    const res = await handleTimelineRequest(
      { enrichmentStore: store, gateMcpPrivate: true },
      { entity_id: 'file:file-1' },
    );
    expect(enrichmentEntries(res)).toHaveLength(1);
  });
});

// Codex review-of-fix FINDING 2 — registryDescribe.total_rows_visible must not
// count rows from topics the door isn't granted (metadata-count consistency).
describe('(ii) registryDescribe.total_rows_visible excludes un-granted topic rows', () => {
  it('a transcript-excluding grant does not count transcript rows in the visible total', () => {
    seedTranscript('file-1', 'a');
    seedTranscript('file-2', 'b');
    // 2 transcript rows exist. A door granted caption (not transcript) sees them
    // excluded from total_rows_visible (and from the catalog).
    const out = handleRegistryDescribe({
      enrichmentStore: store,
      db,
      readGrantChecker: checkerFor({ topics: ['caption'] }),
    });
    expect(out.total_rows_visible).toBe(0);
    // Sanity: with no grant fence, the 2 rows count.
    const ownerOut = handleRegistryDescribe({ enrichmentStore: store, db });
    expect(ownerOut.total_rows_visible).toBe(2);
  });
});
