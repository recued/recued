import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ENRICHMENT_PINNED_AUTHOR_PREFIX,
  ENRICHMENT_REGISTRY,
  type EnrichmentTopic,
  type RegistryDescribeRpcOutput,
} from '@recued/contracts';
import { createManifestRegistry } from '../manifest-loader.js';
import { _testing as mcpTesting } from '../mcp-server.js';
import {
  collectRegisteredProducerTopics,
  handleRegistryDescribe,
  _testing as registryInternals,
} from '../mcp/registry-describe.js';
import { createRecipeStore } from '../recipe-store.js';
import {
  PER_RECORD_PRODUCERS,
  STANDALONE_TASKS,
} from '../housekeeping/registration.js';
import { clearDefaultHousekeepingRegistry } from '../housekeeping/registry.js';
import {
  createEnrichmentStore,
  type EnrichmentStore,
} from '../storage/enrichment-store.js';

const NOW = 1_750_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;

let dir: string;
let db: Database.Database;
let store: EnrichmentStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'm-enrich-catalog-filter-'));
  db = new Database(join(dir, 'test.db'));
  store = createEnrichmentStore(db, { now: () => NOW });
});

afterEach(() => {
  store.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const COMPANY = (
  override: Partial<{ company_name: string | null; computed_at: number }> = {},
) => ({
  domain: 'acme.com',
  company_name: 'Acme',
  source: 'domain_only' as const,
  domain_category: 'business' as const,
  reasoning: 'derived from domain',
  computed_at: NOW,
  ...override,
});

const CONTACT_TIMELINE_ROLLUP = () => ({
  name: 'Alice',
  entity: 'alice@example.com',
  interaction_count: 2,
  last_interaction: NOW,
  recent_subjects: ['Intro', 'Follow up'],
  cursor_at: NOW,
  window_ms: 30 * DAY_MS,
});

const CALENDAR_EVENT_ROLLUP = () => ({
  brief: 'Prep for design review.',
  attendees: ['alice@example.com'],
  related_thread_ids: ['thread-1'],
  generated_at: NOW,
  window_ms: 30 * DAY_MS,
});

const MEETING_RESCHEDULE_PATTERN = () => ({
  name: 'Alice',
  entity: 'alice@example.com',
  reschedule_count: 1,
  recent_at: [NOW - DAY_MS],
  cursor_at: NOW,
  reason: 'recent reschedule',
  window_ms: 90 * DAY_MS,
});

const insertCompany = (target: string, event_at: number, name: string) =>
  store.upsert({
    topic: 'company',
    scope: 'contact',
    target_id: target,
    value: COMPANY({ company_name: name, computed_at: event_at }),
    authored_by: 'system.housekeeping.company',
    event_at,
  });

const insertContactTimelineRollup = (target: string) =>
  store.upsert({
    topic: 'contact_timeline_rollup',
    scope: 'contact',
    target_id: target,
    value: CONTACT_TIMELINE_ROLLUP(),
    authored_by: 'system.reactive.contact_timeline_rollup',
    event_at: NOW,
  });

const insertCalendarEventRollup = (target: string) =>
  store.upsert({
    topic: 'calendar_event_rollup',
    scope: 'calendar',
    target_id: target,
    value: CALENDAR_EVENT_ROLLUP(),
    authored_by: 'system.reactive.calendar_event_rollup',
    event_at: NOW,
  });

const insertPinnedCompany = (target: string) =>
  store.upsert({
    topic: 'company',
    scope: 'contact',
    target_id: target,
    value: COMPANY({ company_name: 'Pinned Acme' }),
    authored_by: `${ENRICHMENT_PINNED_AUTHOR_PREFIX}.company_fix`,
    event_at: NOW,
    mode: 'pinned',
  });

const insertPinnedMeetingReschedulePattern = (target: string) =>
  store.upsert({
    topic: 'meeting_reschedule_pattern',
    scope: 'contact',
    target_id: target,
    value: MEETING_RESCHEDULE_PATTERN(),
    authored_by: `${ENRICHMENT_PINNED_AUTHOR_PREFIX}.meeting_fix`,
    event_at: NOW,
    mode: 'pinned',
  });

const topicNames = (out: RegistryDescribeRpcOutput): Set<string> =>
  new Set(out.topics.map((topic) => topic.topic));

const makeMcpDeps = () => ({
  recipeStore: createRecipeStore('/nonexistent'),
  executorConfig: { manifests: createManifestRegistry('/nonexistent') },
  baseVault: {},
  // D-228 slice 6 — this suite models the OWNER (no per-tool checklist);
  // absent now DENIES, so the principal is stated positively.
  ownerAdmitAll: true,
  enrichmentStore: store,
  db,
});

const parseToolResponse = <T>(res: unknown): T => {
  const r = res as { content?: Array<{ text?: string }>; isError?: boolean };
  if (r.isError === true) {
    throw new Error(`tool returned error: ${JSON.stringify(r)}`);
  }
  const text = r.content?.[0]?.text;
  expect(typeof text).toBe('string');
  return JSON.parse(text!) as T;
};

describe('collectRegisteredProducerTopics', () => {
  it('maps task.topic values from the registration roster and skips core tasks', () => {
    const coreTask = STANDALONE_TASKS.find((task) => task.topic === undefined);
    const standaloneProducerTask = STANDALONE_TASKS.find(
      (task) => task.topic === 'confidence_drift_signal',
    );
    const companyProducerEntry = PER_RECORD_PRODUCERS.find(
      (entry) => entry.producer.topic === 'company',
    );

    expect(coreTask).toBeDefined();
    expect(standaloneProducerTask).toBeDefined();
    expect(companyProducerEntry).toBeDefined();
    expect(ENRICHMENT_REGISTRY.company.producer_kind).toBe('housekeeping');
    expect(ENRICHMENT_REGISTRY.contact_timeline_rollup.producer_kind).toBe(
      'reactive',
    );

    const topics = collectRegisteredProducerTopics([
      { topic: coreTask!.topic },
      { topic: standaloneProducerTask!.topic },
      { topic: companyProducerEntry!.producer.topic },
      { topic: undefined },
    ]);

    expect([...topics].sort()).toEqual(['company', 'confidence_drift_signal']);
    expect(topics.has('contact_timeline_rollup')).toBe(false);
  });
});

describe('registry describe M-ENRICH internals', () => {
  it('isUnproducedEmptyTopic follows the opt-in truth table', () => {
    const producerTopics = new Set<EnrichmentTopic>(['company']);
    const deps = { enrichmentStore: store, db };

    expect(
      registryInternals.isUnproducedEmptyTopic(
        deps,
        'contact_timeline_rollup',
      ),
    ).toBe(false);
    expect(
      registryInternals.isUnproducedEmptyTopic(
        { ...deps, registeredProducerTopics: producerTopics, includePrivateTopics: true },
        'contact_timeline_rollup',
      ),
    ).toBe(false);
    expect(
      registryInternals.isUnproducedEmptyTopic(
        { ...deps, registeredProducerTopics: producerTopics },
        'company',
      ),
    ).toBe(false);
    expect(
      registryInternals.isUnproducedEmptyTopic(
        { ...deps, registeredProducerTopics: producerTopics },
        'contact_timeline_rollup',
      ),
    ).toBe(true);

    insertCalendarEventRollup('event-1');

    expect(
      registryInternals.isUnproducedEmptyTopic(
        { ...deps, registeredProducerTopics: producerTopics },
        'calendar_event_rollup',
      ),
    ).toBe(false);
  });

  it('countAgentReadableRowsForTopic excludes pinned correction rows', () => {
    insertPinnedMeetingReschedulePattern('alice@example.com');
    expect(
      registryInternals.countAgentReadableRowsForTopic(
        { enrichmentStore: store, db },
        'meeting_reschedule_pattern',
      ),
    ).toBe(0);

    insertCompany('bob@example.com', NOW, 'Acme');
    insertPinnedCompany('carol@example.com');

    expect(
      registryInternals.countAgentReadableRowsForTopic(
        { enrichmentStore: store, db },
        'company',
      ),
    ).toBe(1);
  });
});

describe('handleRegistryDescribe M-ENRICH catalog filter', () => {
  it('drops only no-producer topics with zero agent-readable rows', () => {
    const producerTopics = new Set<EnrichmentTopic>(['company']);
    insertCalendarEventRollup('event-1');
    insertPinnedMeetingReschedulePattern('alice@example.com');

    const filtered = handleRegistryDescribe(
      {
        enrichmentStore: store,
        db,
        registeredProducerTopics: producerTopics,
      },
      { now: () => NOW },
    );
    const filteredTopics = topicNames(filtered);

    expect(filteredTopics.has('contact_timeline_rollup')).toBe(false);
    const company = filtered.topics.find((topic) => topic.topic === 'company');
    expect(company).toBeDefined();
    expect(company!.coverage.row_count).toBe(0);
    expect(company!.coverage_quality).toBe('novel_query_likely_uncovered');
    expect(filteredTopics.has('calendar_event_rollup')).toBe(true);
    expect(filteredTopics.has('meeting_reschedule_pattern')).toBe(false);

    const settingsUi = handleRegistryDescribe(
      {
        enrichmentStore: store,
        db,
        registeredProducerTopics: producerTopics,
        includePrivateTopics: true,
      },
      { now: () => NOW },
    );
    expect(topicNames(settingsUi).has('contact_timeline_rollup')).toBe(true);

    const backCompat = handleRegistryDescribe(
      { enrichmentStore: store, db },
      { now: () => NOW },
    );
    expect(topicNames(backCompat).has('contact_timeline_rollup')).toBe(true);
    expect(filtered.total_rows_visible).toBe(backCompat.total_rows_visible);
    expect(filtered.total_rows_visible).toBe(1);
  });
});

describe('MCP tool dispatch M-ENRICH wiring', () => {
  it('fails open when the housekeeping registry roster is empty', async () => {
    clearDefaultHousekeepingRegistry();
    const deps = makeMcpDeps() as Parameters<typeof mcpTesting.handleToolCall>[1];

    const res = await mcpTesting.handleToolCall(
      { name: 'recued_registryDescribe', arguments: {} },
      deps,
    );
    const out = parseToolResponse<{ topics: Array<{ topic: string }> }>(res);

    expect(out.topics.length).toBeGreaterThan(20);
    expect(out.topics.some((topic) => topic.topic === 'contact_timeline_rollup')).toBe(
      true,
    );
    expect(out.topics.some((topic) => topic.topic === 'company')).toBe(true);
  });
});
