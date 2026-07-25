/** D-139 Phase 1b — Salesforce engagement substrate test suite.
 *
 *  Covers:
 *    - `describeSObjects()` capability probe round-trip (parent
 *      SObjects + relationship objects)
 *    - Pass-5 R5.11 dual-schema VoiceCall vs CallHistory pick
 *    - Pass-3 R3.5 EmailMessageRelation graceful fallback to single-
 *      recipient with coverage note
 *    - Per-SObject reconciler round-trip (Task, Event, EmailMessage,
 *      VoiceCall) with all Pass-4 evidence-quality fields populated
 *    - Per-entity `event_at` mapping per § A.3.1 (Task pending →
 *      completed flips event_at; Event past/future; EmailMessage
 *      MessageDate; VoiceCall CallStartDateTime)
 *    - TZ handling (vendor offset → tz_hint per § A.3.7)
 *    - Per-SObject authorship derivation including Automated Process
 *      User CreatedById → 'crm_automation'
 *    - Direction derivation (`Incoming` for EmailMessage; CallType
 *      for VoiceCall; subject-verb for Task)
 *    - vendor_modstamp from SystemModstamp drives stale-update drop
 *    - CometD `<channel>:<replayId>` idempotency-key ledger dedupe
 *    - Relationship-object reconcilers: TaskRelation / EventRelation
 *      / EmailMessageRelation produce N edges (not single-WhoId
 *      collapse); IsDeleted=true tombstones via tombstoneEdge
 *    - Body-state machine across the four SObjects
 *    - Edge-table emission with connection_id scoping
 *    - MCP body-content strip applies symmetrically (Salesforce side)
 *
 *  Spec: D-139 § P1b acceptance. */

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import {
  CONNECTION_VENDOR_ENTITIES,
  SALESFORCE_ENGAGEMENT_ENTITY_NAMES,
  SALESFORCE_ENGAGEMENT_PUSHTOPIC_NAMES,
  SALESFORCE_ENGAGEMENT_SOBJECT_NAMES,
  SALESFORCE_PUSHTOPIC_CHANNEL_PREFIX,
  SALESFORCE_RELATIONSHIP_ENTITY_NAMES,
  type ConnectionRecord,
} from '@recued/contracts';

import { createEngagementStore } from '../storage/engagement-store.js';

import {
  SalesforceTaskEngagementReconciler,
  buildTaskEngagementSoql,
  projectTaskEngagementRow,
} from '../data/salesforce/task-engagement-reconciler.js';
import {
  SalesforceEventEngagementReconciler,
  buildEventEngagementSoql,
  projectEventEngagementRow,
} from '../data/salesforce/event-engagement-reconciler.js';
import {
  SalesforceEmailMessageEngagementReconciler,
  buildEmailMessageEngagementSoql,
  projectEmailMessageEngagementRow,
} from '../data/salesforce/email-message-engagement-reconciler.js';
import {
  SalesforceCallEngagementReconciler,
  buildCallEngagementSoql,
  projectCallEngagementRow,
} from '../data/salesforce/call-engagement-reconciler.js';
import {
  SalesforceTaskRelationReconciler,
  SalesforceEventRelationReconciler,
  SalesforceEmailMessageRelationReconciler,
  buildTaskRelationSoql,
  buildEventRelationSoql,
  buildEmailMessageRelationSoql,
} from '../data/salesforce/relationship-reconcilers.js';
import {
  buildSalesforceEngagementWebhookProcessor,
} from '../data/salesforce/engagement-webhook-processor.js';
import { createInMemoryReplayIdTracker } from '../data/salesforce/webhook-processor.js';
import {
  probeSalesforceEngagementCapabilities,
  probeOutcomeToCapabilityFlags,
  type ProbeOutcome,
} from '../data/salesforce/describe-probe.js';
import {
  deriveSalesforceAuthorship,
  deriveSalesforceCallDirection,
  deriveSalesforceEmailDirection,
  deriveSalesforceEmailMessageLifecycleState,
  deriveSalesforceEventLifecycleState,
  deriveSalesforceTaskLifecycleState,
  extractIsoOffsetTzHint,
  parseEmailList,
  parseIsoMs,
} from '../data/salesforce/engagement-shared.js';
import { engagementPushTopicQueryFor } from '../data/salesforce/pushtopic-soap.js';
import { buildSalesforceAssociationFetcher } from '../data/salesforce/association-rescan-fetcher.js';
import type { RawSalesforceRecord } from '../data/salesforce/_salesforce-search.js';

// ────────────────────────────────────────────────────────────────
// Test harness
// ────────────────────────────────────────────────────────────────

const FIXED_NOW = 1_714_867_200_000; // 2026-05-04 ish
const ONE_HOUR = 60 * 60 * 1000;

const makeStore = () => {
  const db = new Database(':memory:');
  return { db, store: createEngagementStore(db) };
};

const makeConnection = (
  name: string = 'acme-salesforce',
  base_url: string = 'https://acme.my.salesforce.com',
): ConnectionRecord =>
  ({
    name,
    kind: 'api',
    config: {
      vendor: 'salesforce',
      base_url,
    },
    auth: {
      type: 'oauth2_refresh',
      current_access_token: 'AT_test',
      refresh_token: 'RT_test',
      token_endpoint: 'https://login.salesforce.com/services/oauth2/token',
      client_id: 'cid',
      client_secret: 'csec',
    },
  }) as unknown as ConnectionRecord;

const stubAuthRefresh = async (_c: ConnectionRecord) =>
  ({
    type: 'oauth2_refresh' as const,
    current_access_token: 'AT_refreshed',
    refresh_token: 'RT_test',
    token_endpoint: 'https://login.salesforce.com/services/oauth2/token',
    client_id: 'cid',
    client_secret: 'csec',
  }) as ConnectionRecord['auth'];

// ────────────────────────────────────────────────────────────────
// Contract registry — engagement entities are registered
// ────────────────────────────────────────────────────────────────

describe('D-139 P1b — contract registry', () => {
  it('registers all 5 engagement parent entities + 3 relationship entities (8 total)', () => {
    const sfEngagementEntities = CONNECTION_VENDOR_ENTITIES.filter(
      (e) => e.vendor === 'salesforce',
    );
    const expectedEntities = new Set([
      'opportunity',
      'contact',
      'account',
      ...SALESFORCE_ENGAGEMENT_ENTITY_NAMES,
    ]);
    for (const entity of expectedEntities) {
      expect(
        sfEngagementEntities.some((e) => e.entity === entity),
        `expected salesforce.${entity} in registry`,
      ).toBe(true);
    }
  });

  it('engagement entities OMIT crm_alias (Deal Identity Asymmetry Invariant)', () => {
    for (const entityName of SALESFORCE_ENGAGEMENT_ENTITY_NAMES) {
      const entity = CONNECTION_VENDOR_ENTITIES.find(
        (e) => e.vendor === 'salesforce' && e.entity === entityName,
      );
      expect(entity?.crm_alias).toBeUndefined();
    }
  });

  it('PushTopic names + SObject names cover all 8 entities', () => {
    const all = [
      ...SALESFORCE_ENGAGEMENT_ENTITY_NAMES,
      ...SALESFORCE_RELATIONSHIP_ENTITY_NAMES,
    ];
    for (const e of all) {
      expect(SALESFORCE_ENGAGEMENT_PUSHTOPIC_NAMES[e]).toBeTruthy();
      expect(SALESFORCE_ENGAGEMENT_SOBJECT_NAMES[e]).toBeTruthy();
    }
  });
});

// ────────────────────────────────────────────────────────────────
// Capability probe round-trip
// ────────────────────────────────────────────────────────────────

describe('D-139 P1b — capability probe', () => {
  const buildFetcherStub = (
    responses: Map<string, { status: number; body: unknown }>,
  ): typeof fetch => {
    return (async (url: string | URL | Request): Promise<Response> => {
      const u = typeof url === 'string' ? url : url.toString();
      // Match by path + final SObject name OR by query soql substring.
      for (const [pattern, response] of responses) {
        if (u.includes(pattern)) {
          return new Response(JSON.stringify(response.body), {
            status: response.status,
            headers: { 'Content-Type': 'application/json' },
          });
        }
      }
      return new Response('not found', { status: 404 });
    }) as typeof fetch;
  };

  it('Service Cloud edition: VoiceCall available + CallHistory absent → winning_call_entity = voice_call', async () => {
    const responses = new Map<string, { status: number; body: unknown }>();
    // describe responses
    for (const sobject of [
      'Task',
      'Event',
      'EmailMessage',
      'VoiceCall',
      'TaskRelation',
      'EventRelation',
      'EmailMessageRelation',
    ]) {
      responses.set(`/sobjects/${sobject}/describe`, {
        status: 200,
        body: { queryable: true },
      });
    }
    responses.set(`/sobjects/CallHistory/describe`, { status: 404, body: {} });
    // EntityDefinition CDC probe — return false for all
    responses.set(`EntityDefinition`, {
      status: 200,
      body: { records: [{ IsChangeDataCaptureSelected: false }] },
    });
    // PushTopic LIMIT 0 dry-runs — return success for all queryable
    responses.set(`q=SELECT`, { status: 200, body: { records: [], done: true } });

    const result = await probeSalesforceEngagementCapabilities(
      makeConnection(),
      { fetcher: buildFetcherStub(responses), refreshAuth: stubAuthRefresh },
      FIXED_NOW,
    );
    expect(result.winning_call_entity).toBe('voice_call');
    const voice = result.outcomes.find((o) => o.entity === 'voice_call')!;
    expect(voice.available).toBe(true);
    const call = result.outcomes.find((o) => o.entity === 'call_history')!;
    expect(call.available).toBe(false);
  });

  it('legacy edition: only CallHistory available → winning_call_entity = call_history', async () => {
    const responses = new Map<string, { status: number; body: unknown }>();
    for (const sobject of [
      'Task',
      'Event',
      'EmailMessage',
      'CallHistory',
      'TaskRelation',
      'EventRelation',
      'EmailMessageRelation',
    ]) {
      responses.set(`/sobjects/${sobject}/describe`, {
        status: 200,
        body: { queryable: true },
      });
    }
    responses.set(`/sobjects/VoiceCall/describe`, { status: 404, body: {} });
    responses.set(`EntityDefinition`, {
      status: 200,
      body: { records: [{ IsChangeDataCaptureSelected: false }] },
    });
    responses.set(`q=SELECT`, { status: 200, body: { records: [], done: true } });
    const result = await probeSalesforceEngagementCapabilities(
      makeConnection(),
      { fetcher: buildFetcherStub(responses), refreshAuth: stubAuthRefresh },
      FIXED_NOW,
    );
    expect(result.winning_call_entity).toBe('call_history');
  });

  it('neither call entity available → winning_call_entity = null', async () => {
    const responses = new Map<string, { status: number; body: unknown }>();
    for (const sobject of ['Task', 'Event', 'EmailMessage', 'TaskRelation', 'EventRelation', 'EmailMessageRelation']) {
      responses.set(`/sobjects/${sobject}/describe`, {
        status: 200,
        body: { queryable: true },
      });
    }
    responses.set(`/sobjects/VoiceCall/describe`, { status: 404, body: {} });
    responses.set(`/sobjects/CallHistory/describe`, { status: 404, body: {} });
    responses.set(`EntityDefinition`, {
      status: 200,
      body: { records: [{ IsChangeDataCaptureSelected: false }] },
    });
    responses.set(`q=SELECT`, { status: 200, body: { records: [], done: true } });
    const result = await probeSalesforceEngagementCapabilities(
      makeConnection(),
      { fetcher: buildFetcherStub(responses), refreshAuth: stubAuthRefresh },
      FIXED_NOW,
    );
    expect(result.winning_call_entity).toBe(null);
  });

  it('EmailMessageRelation unavailable does not block parent registration', async () => {
    const responses = new Map<string, { status: number; body: unknown }>();
    for (const sobject of [
      'Task',
      'Event',
      'EmailMessage',
      'VoiceCall',
      'TaskRelation',
      'EventRelation',
    ]) {
      responses.set(`/sobjects/${sobject}/describe`, {
        status: 200,
        body: { queryable: true },
      });
    }
    responses.set(`/sobjects/EmailMessageRelation/describe`, {
      status: 404,
      body: {},
    });
    responses.set(`/sobjects/CallHistory/describe`, { status: 404, body: {} });
    responses.set(`EntityDefinition`, {
      status: 200,
      body: { records: [{ IsChangeDataCaptureSelected: false }] },
    });
    responses.set(`q=SELECT`, { status: 200, body: { records: [], done: true } });
    const result = await probeSalesforceEngagementCapabilities(
      makeConnection(),
      { fetcher: buildFetcherStub(responses), refreshAuth: stubAuthRefresh },
      FIXED_NOW,
    );
    const emRel = result.outcomes.find(
      (o) => o.entity === 'email_message_relation',
    )!;
    expect(emRel.available).toBe(false);
    const em = result.outcomes.find((o) => o.entity === 'email_message')!;
    expect(em.available).toBe(true);
  });

  it('CDC selected → cdc_supported = true', async () => {
    const responses = new Map<string, { status: number; body: unknown }>();
    for (const sobject of [
      'Task',
      'Event',
      'EmailMessage',
      'VoiceCall',
      'CallHistory',
      'TaskRelation',
      'EventRelation',
      'EmailMessageRelation',
    ]) {
      responses.set(`/sobjects/${sobject}/describe`, {
        status: 200,
        body: { queryable: true },
      });
    }
    responses.set(`EntityDefinition`, {
      status: 200,
      body: { records: [{ IsChangeDataCaptureSelected: true }] },
    });
    responses.set(`q=SELECT`, { status: 200, body: { records: [], done: true } });
    const result = await probeSalesforceEngagementCapabilities(
      makeConnection(),
      { fetcher: buildFetcherStub(responses), refreshAuth: stubAuthRefresh },
      FIXED_NOW,
    );
    expect(result.outcomes.find((o) => o.entity === 'task')!.cdc_supported).toBe(true);
  });
});

describe('D-139 P1b — probe outcome → capability flags', () => {
  it('cdc=false + push_topic=false → reconciler_only=true + association_rescan_required=true', () => {
    const outcome: ProbeOutcome = {
      entity: 'task',
      available: true,
      cdc_supported: false,
      push_topic_streamable: false,
    };
    const flags = probeOutcomeToCapabilityFlags({
      outcome,
      connection_id: 'acme',
      last_probed_at: FIXED_NOW,
    });
    expect(flags.reconciler_only).toBe(true);
    expect(flags.association_rescan_required).toBe(true);
  });

  it('Codex P1 #3 — cdc=true alone keeps reconciler_only=true (no CDC subscription path yet)', () => {
    // Until CDC subscription support ships in a follow-up sub-phase,
    // CDC-only entities (cdc_supported=true, push_topic_streamable=false)
    // keep reconciler_only=true + association_rescan_required=true.
    // PushTopic-supported is the only live streaming path at this
    // milestone.
    const outcome: ProbeOutcome = {
      entity: 'task',
      available: true,
      cdc_supported: true,
      push_topic_streamable: false,
    };
    const flags = probeOutcomeToCapabilityFlags({
      outcome,
      connection_id: 'acme',
      last_probed_at: FIXED_NOW,
    });
    expect(flags.reconciler_only).toBe(true);
    expect(flags.association_rescan_required).toBe(true);
    // The probe-result fact stays accurate so re-probe + UI surfaces
    // can show the org's CDC config truthfully.
    expect(flags.cdc_supported).toBe(true);
  });

  it('push_topic_streamable=true → reconciler_only=false (PushTopic is the active streaming path)', () => {
    const outcome: ProbeOutcome = {
      entity: 'task',
      available: true,
      cdc_supported: false,
      push_topic_streamable: true,
    };
    const flags = probeOutcomeToCapabilityFlags({
      outcome,
      connection_id: 'acme',
      last_probed_at: FIXED_NOW,
    });
    expect(flags.reconciler_only).toBe(false);
    expect(flags.association_rescan_required).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────
// SOQL composition
// ────────────────────────────────────────────────────────────────

describe('D-139 P1b — SOQL composition', () => {
  it('Task SOQL with cursor=0 omits WHERE', () => {
    const soql = buildTaskEngagementSoql(0, 100);
    expect(soql).not.toContain('WHERE');
    expect(soql).toContain('FROM Task');
    expect(soql).toContain('LIMIT 100');
  });

  it('Task SOQL with cursor>0 emits WHERE LastModifiedDate >=', () => {
    const soql = buildTaskEngagementSoql(FIXED_NOW, 100);
    expect(soql).toContain('WHERE LastModifiedDate >=');
    expect(soql).toContain('ORDER BY LastModifiedDate ASC');
  });

  it('Event SOQL same shape', () => {
    const soql = buildEventEngagementSoql(0, 50);
    expect(soql).toContain('FROM Event');
  });

  it('EmailMessage SOQL same shape', () => {
    const soql = buildEmailMessageEngagementSoql(0, 50);
    expect(soql).toContain('FROM EmailMessage');
  });

  it('Call SOQL dispatches on entity', () => {
    expect(buildCallEngagementSoql('voice_call', 0, 10)).toContain('FROM VoiceCall');
    expect(buildCallEngagementSoql('call_history', 0, 10)).toContain('FROM CallHistory');
  });

  it('TaskRelation/EventRelation SOQL targets junction objects', () => {
    expect(buildTaskRelationSoql(0, 10)).toContain('FROM TaskRelation');
    expect(buildEventRelationSoql(0, 10)).toContain('FROM EventRelation');
    expect(buildEmailMessageRelationSoql(0, 10)).toContain(
      'FROM EmailMessageRelation',
    );
  });

  it('EmailMessageRelation SOQL uses SystemModstamp cursor (not LastModifiedDate)', () => {
    const soql = buildEmailMessageRelationSoql(FIXED_NOW, 50);
    expect(soql).toContain('WHERE SystemModstamp >=');
    expect(soql).toContain('ORDER BY SystemModstamp ASC');
  });
});

// ────────────────────────────────────────────────────────────────
// PushTopic Query composition
// ────────────────────────────────────────────────────────────────

describe('D-139 P1b — engagement PushTopic Query composition', () => {
  it.each(['task', 'event', 'email_message', 'voice_call', 'call_history'] as const)(
    '%s PushTopic Query targets the right SObject',
    (entity) => {
      const query = engagementPushTopicQueryFor(entity);
      expect(query).toContain(`FROM ${SALESFORCE_ENGAGEMENT_SOBJECT_NAMES[entity]}`);
    },
  );

  it.each([
    'task_relation',
    'event_relation',
    'email_message_relation',
  ] as const)('%s PushTopic Query targets junction objects', (entity) => {
    const query = engagementPushTopicQueryFor(entity);
    expect(query).toContain(`FROM ${SALESFORCE_ENGAGEMENT_SOBJECT_NAMES[entity]}`);
  });
});

// ────────────────────────────────────────────────────────────────
// Pure helpers
// ────────────────────────────────────────────────────────────────

describe('D-139 P1b — pure helpers', () => {
  it('parseIsoMs round-trips Salesforce ISO 8601', () => {
    const ms = parseIsoMs('2026-05-04T14:32:18.000Z');
    expect(ms).not.toBeNull();
    expect(new Date(ms!).getUTCHours()).toBe(14);
  });

  it('extractIsoOffsetTzHint preserves offset', () => {
    expect(extractIsoOffsetTzHint('2026-05-04T10:32:18.000-04:00')).toBe(
      'Etc/GMT+4',
    );
    expect(extractIsoOffsetTzHint('2026-05-04T14:32:18.000Z')).toBe('UTC');
    expect(extractIsoOffsetTzHint('2026-05-04T14:32:18.000+00:00')).toBe('UTC');
    expect(extractIsoOffsetTzHint('2026-05-04')).toBeUndefined();
  });

  it('Codex P2 #9 — extractIsoOffsetTzHint preserves half/quarter-hour minutes verbatim', () => {
    // India = +05:30, Adelaide = +09:30, Nepal = +05:45,
    // Newfoundland = -03:30. Etc/GMT±N can't represent these.
    // Substrate surfaces the raw offset string as the tz hint;
    // resolveEngagementTzHint downstream may refine via calendar /
    // prefs.
    expect(extractIsoOffsetTzHint('2026-05-04T14:32:18.000+05:30')).toBe('+05:30');
    expect(extractIsoOffsetTzHint('2026-05-04T14:32:18.000+09:30')).toBe('+09:30');
    expect(extractIsoOffsetTzHint('2026-05-04T14:32:18.000+05:45')).toBe('+05:45');
    expect(extractIsoOffsetTzHint('2026-05-04T14:32:18.000-03:30')).toBe('-03:30');
    // Whole-hour offsets continue to use Etc/GMT±N (POSIX-flipped sign)
    expect(extractIsoOffsetTzHint('2026-05-04T14:32:18.000+02:00')).toBe('Etc/GMT-2');
    expect(extractIsoOffsetTzHint('2026-05-04T14:32:18.000-08:00')).toBe('Etc/GMT+8');
  });

  it('parseEmailList splits semicolon + comma', () => {
    const out = parseEmailList('Foo@bar.com; baz@qux.io , extra@example.org');
    expect(out).toEqual(['foo@bar.com', 'baz@qux.io', 'extra@example.org']);
  });
});

// ────────────────────────────────────────────────────────────────
// Authorship derivation
// ────────────────────────────────────────────────────────────────

describe('D-139 P1b — authorship derivation', () => {
  it('OwnerId matches connection user → user', () => {
    const a = deriveSalesforceAuthorship({
      ownerId: '0051234567890',
      createdById: '0051234567890',
      deps: { connectionUserOwnerId: '0051234567890' },
    });
    expect(a).toBe('user');
  });

  it('CreatedById matches Automated Process User → crm_automation', () => {
    const a = deriveSalesforceAuthorship({
      ownerId: '0050000000000', // different user
      createdById: '005AUTOPROC123',
      deps: {
        connectionUserOwnerId: '0051234567890',
        automatedProcessUserId: '005AUTOPROC123',
      },
    });
    expect(a).toBe('crm_automation');
  });

  it('OwnerId populated, no match → crm_user', () => {
    const a = deriveSalesforceAuthorship({
      ownerId: '0050000000000',
      createdById: '0050000000000',
      deps: { connectionUserOwnerId: '0051234567890' },
    });
    expect(a).toBe('crm_user');
  });

  it('all empty → unknown', () => {
    const a = deriveSalesforceAuthorship({
      ownerId: undefined,
      createdById: undefined,
      deps: {},
    });
    expect(a).toBe('unknown');
  });
});

// ────────────────────────────────────────────────────────────────
// Direction derivation
// ────────────────────────────────────────────────────────────────

describe('D-139 P1b — direction derivation', () => {
  it('EmailMessage Incoming=true → inbound', () => {
    expect(deriveSalesforceEmailDirection(true)).toBe('inbound');
    expect(deriveSalesforceEmailDirection(false)).toBe('outbound');
    expect(deriveSalesforceEmailDirection(null)).toBe('unknown');
  });

  it('VoiceCall CallType=INBOUND/OUTBOUND/INTERNAL', () => {
    expect(deriveSalesforceCallDirection('INBOUND')).toBe('inbound');
    expect(deriveSalesforceCallDirection('OUTBOUND')).toBe('outbound');
    expect(deriveSalesforceCallDirection('INTERNAL')).toBe('internal');
    expect(deriveSalesforceCallDirection('weird')).toBe('unknown');
  });
});

// ────────────────────────────────────────────────────────────────
// Lifecycle derivation
// ────────────────────────────────────────────────────────────────

describe('D-139 P1b — lifecycle derivation', () => {
  it('Task: Completed → completed; Deferred → cancelled; else → pending', () => {
    expect(deriveSalesforceTaskLifecycleState('Completed')).toBe('completed');
    expect(deriveSalesforceTaskLifecycleState('Deferred')).toBe('cancelled');
    expect(deriveSalesforceTaskLifecycleState('In Progress')).toBe('pending');
    expect(deriveSalesforceTaskLifecycleState(null)).toBe('pending');
  });

  it('Event: future StartDateTime → scheduled; past → completed', () => {
    expect(deriveSalesforceEventLifecycleState(FIXED_NOW + ONE_HOUR, FIXED_NOW)).toBe('scheduled');
    expect(deriveSalesforceEventLifecycleState(FIXED_NOW - ONE_HOUR, FIXED_NOW)).toBe('completed');
    expect(deriveSalesforceEventLifecycleState(null, FIXED_NOW)).toBe('scheduled');
  });

  it('EmailMessage: always point_in_time', () => {
    expect(deriveSalesforceEmailMessageLifecycleState()).toBe('point_in_time');
  });
});

// ────────────────────────────────────────────────────────────────
// Task projection
// ────────────────────────────────────────────────────────────────

describe('D-139 P1b — Task projection', () => {
  it('pending task: event_at = NULL, due_at populated, due_at_is_date_only', () => {
    const raw: RawSalesforceRecord = {
      Id: '00T1pending00',
      Subject: 'Follow up with prospect',
      Status: 'In Progress',
      Priority: 'Normal',
      ActivityDate: '2026-05-10', // date-only
      OwnerId: '005owner',
      CreatedById: '005owner',
      CreatedDate: '2026-05-01T00:00:00.000Z',
      LastModifiedDate: '2026-05-04T10:00:00.000Z',
      SystemModstamp: '2026-05-04T10:00:00.000Z',
      WhoId: '003contact',
      WhatId: '006opportunity',
    };
    const row = projectTaskEngagementRow('acme', raw, {
      now: FIXED_NOW,
      authorship: { connectionUserOwnerId: '005owner' },
    });
    expect(row.lifecycle_state).toBe('pending');
    expect(row.event_at).toBeNull();
    expect(row.due_at).toBeDefined();
    expect(row.due_at_is_date_only).toBe(true);
    expect(row.completed_at).toBeUndefined();
    expect(row.authorship).toBe('user');
    expect(row.direction).toBe('outbound'); // 'follow up' subject
  });

  it('completed task: event_at = CompletedDateTime, lifecycle = completed', () => {
    const raw: RawSalesforceRecord = {
      Id: '00T1complete0',
      Subject: 'Random subject',
      Status: 'Completed',
      ActivityDate: '2026-05-01',
      CompletedDateTime: '2026-05-04T10:00:00.000Z',
      OwnerId: '005owner',
      CreatedById: '005owner',
      CreatedDate: '2026-05-01T00:00:00.000Z',
      LastModifiedDate: '2026-05-04T10:00:00.000Z',
      SystemModstamp: '2026-05-04T10:00:00.000Z',
    };
    const row = projectTaskEngagementRow('acme', raw, {
      now: FIXED_NOW,
      authorship: { connectionUserOwnerId: '005owner' },
    });
    expect(row.lifecycle_state).toBe('completed');
    expect(row.event_at).toBe(parseIsoMs('2026-05-04T10:00:00.000Z'));
    expect(row.completed_at).toBe(row.event_at);
  });

  it('vendor_modstamp from SystemModstamp', () => {
    const raw: RawSalesforceRecord = {
      Id: '00T1modstamp0',
      Status: 'In Progress',
      OwnerId: '005owner',
      CreatedById: '005owner',
      CreatedDate: '2026-05-01T00:00:00.000Z',
      LastModifiedDate: '2026-05-01T00:00:00.000Z',
      SystemModstamp: '2026-05-04T15:00:00.000Z', // newer
    };
    const row = projectTaskEngagementRow('acme', raw, {
      now: FIXED_NOW,
      authorship: {},
    });
    expect(row.vendor_modstamp).toBe('2026-05-04T15:00:00.000Z');
  });

  it('TZ handling: ISO offset preserved as event_at_tz_hint when vendor offers it', () => {
    const raw: RawSalesforceRecord = {
      Id: '00T1tz000000',
      Status: 'Completed',
      CompletedDateTime: '2026-05-04T10:00:00.000-04:00',
      OwnerId: '005owner',
      CreatedById: '005owner',
      CreatedDate: '2026-05-01T00:00:00.000-04:00',
      LastModifiedDate: '2026-05-04T10:00:00.000-04:00',
      SystemModstamp: '2026-05-04T10:00:00.000-04:00',
    };
    const row = projectTaskEngagementRow('acme', raw, {
      now: FIXED_NOW,
      authorship: {},
    });
    expect(row.event_at_tz_hint).toBe('Etc/GMT+4');
    expect(row.event_at_tz_inferred).toBeUndefined();
  });

  it('falls through to UTC + tz_inferred when no offset', () => {
    const raw: RawSalesforceRecord = {
      Id: '00T1tzinf000',
      Status: 'Completed',
      CompletedDateTime: '2026-05-04T10:00:00.000', // no offset
      OwnerId: '005owner',
      CreatedById: '005owner',
      CreatedDate: '2026-05-01T00:00:00.000',
      LastModifiedDate: '2026-05-04T10:00:00.000',
      SystemModstamp: '2026-05-04T10:00:00.000',
    };
    const row = projectTaskEngagementRow('acme', raw, {
      now: FIXED_NOW,
      authorship: {},
    });
    expect(row.event_at_tz_hint).toBe('UTC');
    expect(row.event_at_tz_inferred).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────
// Event projection
// ────────────────────────────────────────────────────────────────

describe('D-139 P1b — Event projection', () => {
  it('future Event: scheduled, event_at NULL, scheduled_start_at populated', () => {
    const raw: RawSalesforceRecord = {
      Id: '00U1future000',
      Subject: 'Demo with prospect',
      StartDateTime: new Date(FIXED_NOW + ONE_HOUR).toISOString(),
      EndDateTime: new Date(FIXED_NOW + 2 * ONE_HOUR).toISOString(),
      DurationInMinutes: 60,
      Location: 'Zoom',
      OwnerId: '005owner',
      CreatedById: '005owner',
      CreatedDate: '2026-05-01T00:00:00.000Z',
      LastModifiedDate: '2026-05-04T10:00:00.000Z',
      SystemModstamp: '2026-05-04T10:00:00.000Z',
    };
    const row = projectEventEngagementRow('acme', raw, {
      now: FIXED_NOW,
      calendarTwinMatch: null,
      authorship: { connectionUserOwnerId: '005owner' },
    });
    expect(row.lifecycle_state).toBe('scheduled');
    expect(row.event_at).toBeNull();
    expect(row.scheduled_start_at).toBe(FIXED_NOW + ONE_HOUR);
  });

  it('past Event: completed, event_at = StartDateTime', () => {
    const raw: RawSalesforceRecord = {
      Id: '00U1past00000',
      Subject: 'Done',
      StartDateTime: new Date(FIXED_NOW - ONE_HOUR).toISOString(),
      OwnerId: '005owner',
      CreatedById: '005owner',
      CreatedDate: '2026-05-01T00:00:00.000Z',
      LastModifiedDate: '2026-05-04T10:00:00.000Z',
      SystemModstamp: '2026-05-04T10:00:00.000Z',
    };
    const row = projectEventEngagementRow('acme', raw, {
      now: FIXED_NOW,
      calendarTwinMatch: null,
      authorship: { connectionUserOwnerId: '005owner' },
    });
    expect(row.lifecycle_state).toBe('completed');
    expect(row.event_at).toBe(FIXED_NOW - ONE_HOUR);
  });

  it('calendar twin match flips body_state to calendar_link', () => {
    // No vendor-side ISO offset on StartDateTime so the calendar-
    // twin tz hint can flow through the § A.3.7 fallback chain
    // (vendor → calendar adapter → prefs → UTC). When the vendor
    // supplies a UTC offset (Z / +00:00), the resolver picks 'UTC'
    // first and the calendar-twin hint is preempted — that's the
    // documented behavior; this test exercises the calendar-twin-
    // wins case by using a no-offset timestamp.
    const raw: RawSalesforceRecord = {
      Id: '00U1cal0000',
      Subject: 'Meeting',
      Description: 'Some body content',
      // Wall-clock string with no offset — vendor hint absent.
      StartDateTime: '2026-05-04T08:00:00.000',
      OwnerId: '005owner',
      CreatedById: '005owner',
      CreatedDate: '2026-05-01T00:00:00.000',
      LastModifiedDate: '2026-05-04T10:00:00.000',
      SystemModstamp: '2026-05-04T10:00:00.000',
    };
    const row = projectEventEngagementRow('acme', raw, {
      now: FIXED_NOW,
      calendarTwinMatch: {
        calendar_id: 'cal:event42',
        match_key: 'start_time_match',
        tz_hint: 'America/New_York',
      },
      authorship: { connectionUserOwnerId: '005owner' },
    });
    expect(row.body_state).toBe('calendar_link');
    expect(row.event_at_tz_hint).toBe('America/New_York');
  });
});

// ────────────────────────────────────────────────────────────────
// EmailMessage projection
// ────────────────────────────────────────────────────────────────

describe('D-139 P1b — EmailMessage projection', () => {
  it('Incoming=true → direction=inbound, lifecycle=point_in_time, event_at=MessageDate', () => {
    const raw: RawSalesforceRecord = {
      Id: '02s1inbound00',
      Subject: 'RFP question',
      TextBody: 'Hi, just wanted to ask about pricing',
      FromAddress: 'Prospect@example.com',
      FromName: 'Prospect',
      ToAddress: 'sales@acme.com; cc-rep@acme.com',
      MessageDate: '2026-05-04T08:00:00.000Z',
      Status: 'Read',
      Incoming: true,
      MessageIdentifier: '<msg-id-123@example.com>',
      CreatedById: '005owner',
      CreatedDate: '2026-05-04T08:00:00.000Z',
      LastModifiedDate: '2026-05-04T08:00:00.000Z',
      SystemModstamp: '2026-05-04T08:00:00.000Z',
    };
    const row = projectEmailMessageEngagementRow('acme', raw, {
      now: FIXED_NOW,
      authorship: {},
    });
    expect(row.direction).toBe('inbound');
    expect(row.lifecycle_state).toBe('point_in_time');
    expect(row.event_at).toBe(parseIsoMs('2026-05-04T08:00:00.000Z'));
    expect(row.body_state).toBe('inline_body');
    expect(row.body_inline).toBe('Hi, just wanted to ask about pricing');
  });

  // D-184 Decision 2 — the former "mail-twin match → body_state=mail_link"
  // projection test is gone: exact RFC822 Message-ID twins now resolve LIVE
  // in the engagements resolver (which flips body_state → 'mail_link' +
  // sets mail_twin_id), not at ingest. dedupe_confidence stays 'none' at
  // projection. See the resolver mail-twin tests in d-139-phase-1a1.
});

// ────────────────────────────────────────────────────────────────
// VoiceCall + CallHistory projection
// ────────────────────────────────────────────────────────────────

describe('D-139 P1b — Call projection', () => {
  it('VoiceCall: direction from CallType, event_at = CallStartDateTime', () => {
    const raw: RawSalesforceRecord = {
      Id: '0LQ1call0000',
      CallType: 'OUTBOUND',
      CallSubject: 'Discovery call',
      CallDurationInSeconds: 1800,
      CallStartDateTime: '2026-05-04T08:00:00.000Z',
      CallEndDateTime: '2026-05-04T08:30:00.000Z',
      OwnerId: '005owner',
      CreatedById: '005owner',
      CreatedDate: '2026-05-04T08:00:00.000Z',
      LastModifiedDate: '2026-05-04T08:35:00.000Z',
      SystemModstamp: '2026-05-04T08:35:00.000Z',
      ContactId: '003contact',
      AccountId: '001account',
    };
    const row = projectCallEngagementRow('voice_call', 'acme', raw, {
      now: FIXED_NOW,
      authorship: { connectionUserOwnerId: '005owner' },
    });
    expect(row.entity).toBe('voice_call');
    expect(row.direction).toBe('outbound');
    expect(row.event_at).toBe(parseIsoMs('2026-05-04T08:00:00.000Z'));
    expect(row.lifecycle_state).toBe('point_in_time');
  });

  it('CallHistory: simpler shape', () => {
    const raw: RawSalesforceRecord = {
      Id: '09I1call0000',
      CallType: 'INBOUND',
      CallDurationInSeconds: 600,
      CallStartDateTime: '2026-05-04T08:00:00.000Z',
      OwnerId: '005owner',
      CreatedById: '005owner',
      CreatedDate: '2026-05-04T08:00:00.000Z',
      LastModifiedDate: '2026-05-04T08:10:00.000Z',
      SystemModstamp: '2026-05-04T08:10:00.000Z',
    };
    const row = projectCallEngagementRow('call_history', 'acme', raw, {
      now: FIXED_NOW,
      authorship: { connectionUserOwnerId: '005owner' },
    });
    expect(row.entity).toBe('call_history');
    expect(row.direction).toBe('inbound');
  });
});

// ────────────────────────────────────────────────────────────────
// Reconciler ingest round-trip with EngagementStore
// ────────────────────────────────────────────────────────────────

describe('D-139 P1b — Task reconciler round-trip', () => {
  it('ingests row + emits owner edge + WhoId/WhatId fallback edges', () => {
    const { store } = makeStore();
    const reconciler = new SalesforceTaskEngagementReconciler({
      search: {
        refreshAuth: stubAuthRefresh,
      },
      engagementStore: store,
      authorship: { connectionUserOwnerId: '005owner' },
      now: () => FIXED_NOW,
      taskRelationFallbackEdges: true,
    });
    const slim = {
      id: 'salesforce_task_00T1234',
      modified_at: FIXED_NOW,
      _raw: {
        Id: '00T1234',
        Subject: 'Call lead',
        Status: 'In Progress',
        ActivityDate: '2026-05-10',
        OwnerId: '005owner',
        CreatedById: '005owner',
        CreatedDate: '2026-05-01T00:00:00.000Z',
        LastModifiedDate: '2026-05-04T10:00:00.000Z',
        SystemModstamp: '2026-05-04T10:00:00.000Z',
        WhoId: '003contact',
        WhatId: '006opp',
      } as RawSalesforceRecord,
    };
    const result = reconciler.ingest('acme', slim);
    expect(result.row.target_id).toBe('salesforce_task_00T1234');
    expect(result.staleModstamp).toBe(false);
    // 3 edges: owner + contact (WhoId) + deal (WhatId starts 006)
    expect(result.emittedEdgeCount).toBeGreaterThanOrEqual(2);

    const edges = store.listEdges({
      connection_id: 'acme',
      engagement_target_id: 'salesforce_task_00T1234',
    });
    const types = edges.map((e) => e.edge_type).sort();
    expect(types).toEqual(['contact', 'deal', 'owner']);
  });

  it('connection_id-scoped: same target_id under different connection produces independent rows', () => {
    const { store } = makeStore();
    const recA = new SalesforceTaskEngagementReconciler({
      search: { refreshAuth: stubAuthRefresh },
      engagementStore: store,
      authorship: {},
      now: () => FIXED_NOW,
    });
    const recB = new SalesforceTaskEngagementReconciler({
      search: { refreshAuth: stubAuthRefresh },
      engagementStore: store,
      authorship: {},
      now: () => FIXED_NOW,
    });
    const baseRaw = (id: string) =>
      ({
        Id: id,
        Subject: 'X',
        Status: 'Completed',
        CompletedDateTime: '2026-05-04T10:00:00.000Z',
        OwnerId: '005owner',
        CreatedById: '005owner',
        CreatedDate: '2026-05-01T00:00:00.000Z',
        LastModifiedDate: '2026-05-04T10:00:00.000Z',
        SystemModstamp: '2026-05-04T10:00:00.000Z',
      }) as RawSalesforceRecord;
    const slimA = {
      id: 'salesforce_task_SAME',
      modified_at: FIXED_NOW,
      _raw: baseRaw('SAME'),
    };
    const slimB = {
      id: 'salesforce_task_SAME',
      modified_at: FIXED_NOW,
      _raw: baseRaw('SAME'),
    };
    recA.ingest('acme', slimA);
    recB.ingest('partner', slimB);
    const rowA = store.get('acme', 'salesforce_task_SAME');
    const rowB = store.get('partner', 'salesforce_task_SAME');
    expect(rowA).not.toBeNull();
    expect(rowB).not.toBeNull();
    expect(rowA!.connection_id).toBe('acme');
    expect(rowB!.connection_id).toBe('partner');
  });

  it('vendor_modstamp stale-update drop: incoming SystemModstamp <= stored ⇒ dropped', () => {
    const { store } = makeStore();
    const reconciler = new SalesforceTaskEngagementReconciler({
      search: { refreshAuth: stubAuthRefresh },
      engagementStore: store,
      authorship: {},
      now: () => FIXED_NOW,
    });
    const newRaw = {
      Id: '00Tstale',
      Subject: 'newer',
      Status: 'Completed',
      CompletedDateTime: '2026-05-04T10:00:00.000Z',
      OwnerId: '005owner',
      CreatedById: '005owner',
      CreatedDate: '2026-05-01T00:00:00.000Z',
      LastModifiedDate: '2026-05-04T10:00:00.000Z',
      SystemModstamp: '2026-05-04T10:00:00.000Z',
    } as RawSalesforceRecord;
    reconciler.ingest('acme', {
      id: 'salesforce_task_00Tstale',
      modified_at: FIXED_NOW,
      _raw: newRaw,
    });
    const olderRaw = {
      ...newRaw,
      Subject: 'older payload',
      SystemModstamp: '2026-05-03T10:00:00.000Z', // older
      LastModifiedDate: '2026-05-03T10:00:00.000Z',
    };
    const result = reconciler.ingest('acme', {
      id: 'salesforce_task_00Tstale',
      modified_at: FIXED_NOW - ONE_HOUR,
      _raw: olderRaw,
    });
    expect(result.staleModstamp).toBe(true);
    const persisted = store.get('acme', 'salesforce_task_00Tstale');
    expect(persisted!.meta.subject).toBe('newer');
  });
});

// ────────────────────────────────────────────────────────────────
// Relationship-object reconcilers
// ────────────────────────────────────────────────────────────────

describe('D-139 P1b — relationship reconcilers', () => {
  const seedTask = (
    store: ReturnType<typeof makeStore>['store'],
    connection_id: string,
    raw_id: string,
  ) => {
    const reconciler = new SalesforceTaskEngagementReconciler({
      search: { refreshAuth: stubAuthRefresh },
      engagementStore: store,
      authorship: {},
      now: () => FIXED_NOW,
      taskRelationFallbackEdges: false,
    });
    reconciler.ingest(connection_id, {
      id: `salesforce_task_${raw_id}`,
      modified_at: FIXED_NOW,
      _raw: {
        Id: raw_id,
        Subject: 'Parent',
        Status: 'In Progress',
        OwnerId: '005owner',
        CreatedById: '005owner',
        CreatedDate: '2026-05-01T00:00:00.000Z',
        LastModifiedDate: '2026-05-04T10:00:00.000Z',
        SystemModstamp: '2026-05-04T10:00:00.000Z',
      } as RawSalesforceRecord,
    });
  };

  it('TaskRelation many-to-many: 5 junction rows produce 5 edges (not single-WhoId collapse)', () => {
    const { store } = makeStore();
    seedTask(store, 'acme', '00Tparent');
    const rec = new SalesforceTaskRelationReconciler({
      search: { refreshAuth: stubAuthRefresh },
      engagementStore: store,
      now: () => FIXED_NOW,
    });
    // 3 contacts + 1 lead + 1 account
    const contacts = ['003c1', '003c2', '003c3'];
    const lead = '00Qlead1';
    const account = '001acc1';
    for (const cid of contacts) {
      rec.ingest('acme', {
        id: `tr-${cid}`,
        modified_at: FIXED_NOW,
        _raw: {
          Id: `tr-${cid}`,
          TaskId: '00Tparent',
          RelationId: cid,
          IsWhat: false,
          IsDeleted: false,
          CreatedDate: '2026-05-04T10:00:00.000Z',
          LastModifiedDate: '2026-05-04T10:00:00.000Z',
          SystemModstamp: '2026-05-04T10:00:00.000Z',
        } as RawSalesforceRecord,
      });
    }
    rec.ingest('acme', {
      id: `tr-${lead}`,
      modified_at: FIXED_NOW,
      _raw: {
        Id: `tr-${lead}`,
        TaskId: '00Tparent',
        RelationId: lead,
        IsWhat: false,
        IsDeleted: false,
        CreatedDate: '2026-05-04T10:00:00.000Z',
        LastModifiedDate: '2026-05-04T10:00:00.000Z',
        SystemModstamp: '2026-05-04T10:00:00.000Z',
      } as RawSalesforceRecord,
    });
    rec.ingest('acme', {
      id: `tr-${account}`,
      modified_at: FIXED_NOW,
      _raw: {
        Id: `tr-${account}`,
        TaskId: '00Tparent',
        RelationId: account,
        IsWhat: true,
        IsDeleted: false,
        CreatedDate: '2026-05-04T10:00:00.000Z',
        LastModifiedDate: '2026-05-04T10:00:00.000Z',
        SystemModstamp: '2026-05-04T10:00:00.000Z',
      } as RawSalesforceRecord,
    });
    // Filter out the owner edge emitted by the parent reconciler
    // when seeding — the spec's 5-row count covers junction-derived
    // edges only (3 contacts + 1 lead-as-contact + 1 account).
    const allEdges = store.listEdges({
      connection_id: 'acme',
      engagement_target_id: 'salesforce_task_00Tparent',
    });
    const junctionEdges = allEdges.filter((e) => e.edge_type !== 'owner');
    expect(junctionEdges.length).toBe(5);
    expect(junctionEdges.filter((e) => e.edge_type === 'contact').length).toBe(4);
    expect(junctionEdges.filter((e) => e.edge_type === 'account').length).toBe(1);
  });

  it('IsDeleted=true tombstones the edge', () => {
    const { store } = makeStore();
    seedTask(store, 'acme', '00Tparent2');
    const rec = new SalesforceTaskRelationReconciler({
      search: { refreshAuth: stubAuthRefresh },
      engagementStore: store,
      now: () => FIXED_NOW,
    });
    rec.ingest('acme', {
      id: `tr-active`,
      modified_at: FIXED_NOW,
      _raw: {
        Id: 'tr-active',
        TaskId: '00Tparent2',
        RelationId: '003contact',
        IsWhat: false,
        IsDeleted: false,
        CreatedDate: '2026-05-04T10:00:00.000Z',
        LastModifiedDate: '2026-05-04T10:00:00.000Z',
        SystemModstamp: '2026-05-04T10:00:00.000Z',
      } as RawSalesforceRecord,
    });
    const out = rec.ingest('acme', {
      id: `tr-active`,
      modified_at: FIXED_NOW + 1000,
      _raw: {
        Id: 'tr-active',
        TaskId: '00Tparent2',
        RelationId: '003contact',
        IsWhat: false,
        IsDeleted: true,
        CreatedDate: '2026-05-04T10:00:00.000Z',
        LastModifiedDate: '2026-05-04T11:00:00.000Z',
        SystemModstamp: '2026-05-04T11:00:00.000Z',
      } as RawSalesforceRecord,
    });
    expect(out.tombstoned).toBe(true);
    const edges = store.listEdges({
      connection_id: 'acme',
      engagement_target_id: 'salesforce_task_00Tparent2',
      include_deleted: true,
    });
    const edge = edges.find((e) => e.target_id === 'salesforce_who_003contact');
    expect(edge?.deleted_at).toBeDefined();
  });

  it('EmailMessageRelation produces N edges keyed on canonical RelationAddress', () => {
    const { store } = makeStore();
    // Seed parent EmailMessage row
    const emRec = new SalesforceEmailMessageEngagementReconciler({
      search: { refreshAuth: stubAuthRefresh },
      engagementStore: store,
      authorship: {},
      now: () => FIXED_NOW,
      emailMessageRelationFallbackEdges: false,
    });
    emRec.ingest('acme', {
      id: 'salesforce_email_message_02sParent',
      modified_at: FIXED_NOW,
      _raw: {
        Id: '02sParent',
        Subject: 'X',
        FromAddress: 'sender@acme.com',
        ToAddress: 'will-be-overridden@example.com',
        MessageDate: '2026-05-04T08:00:00.000Z',
        Incoming: false,
        CreatedById: '005owner',
        CreatedDate: '2026-05-04T08:00:00.000Z',
        LastModifiedDate: '2026-05-04T08:00:00.000Z',
        SystemModstamp: '2026-05-04T08:00:00.000Z',
      } as RawSalesforceRecord,
    });

    const rec = new SalesforceEmailMessageRelationReconciler({
      search: { refreshAuth: stubAuthRefresh },
      engagementStore: store,
      now: () => FIXED_NOW,
    });
    const recipients = ['Recipient1@External.com', 'recipient2@external.com'];
    for (const r of recipients) {
      rec.ingest('acme', {
        id: `emr-${r}`,
        modified_at: FIXED_NOW,
        _raw: {
          Id: `emr-${r}`,
          EmailMessageId: '02sParent',
          RelationType: 'ToAddress',
          RelationAddress: r,
          IsDeleted: false,
          CreatedDate: '2026-05-04T08:00:00.000Z',
          SystemModstamp: '2026-05-04T08:00:00.000Z',
        } as RawSalesforceRecord,
      });
    }
    const edges = store.listEdges({
      connection_id: 'acme',
      engagement_target_id: 'salesforce_email_message_02sParent',
      edge_type: 'contact',
    });
    expect(edges.length).toBeGreaterThanOrEqual(2);
    const ids = edges.map((e) => e.target_id);
    expect(ids).toContain('recipient1@external.com');
    expect(ids).toContain('recipient2@external.com');
  });
});

// ────────────────────────────────────────────────────────────────
// Webhook processor — idempotency-key ledger dedupe
// ────────────────────────────────────────────────────────────────

describe('D-139 P1b — engagement webhook processor', () => {
  it('Codex P1 #6 — atomic checkAndInsertInboundEvent: parseEvents writes the ledger row on novel arrival', () => {
    const { store } = makeStore();
    const tracker = createInMemoryReplayIdTracker();
    const processor = buildSalesforceEngagementWebhookProcessor({
      entity: 'task',
      replayIdTracker: tracker,
      engagementStore: store,
    });
    const channel = `${SALESFORCE_PUSHTOPIC_CHANNEL_PREFIX}RecuedTaskFeed`;
    const event = {
      channel,
      data: {
        event: { type: 'updated' as const, replayId: 42 },
        sobject: { Id: '00T1234', LastModifiedDate: '2026-05-04T10:00:00.000Z' },
      },
    };
    // First arrival — ledger empty, processor emits + writes ledger.
    const out1 = processor.parseEvents(event, {}, 'acme');
    expect(out1).toHaveLength(1);
    // Verify the ledger now actually has a row (the prior shape's
    // read-only `lookupInboundEvent` never wrote — Codex flagged this
    // as a dead substrate).
    const followup = store.lookupInboundEvent({
      connection_id: 'acme',
      vendor: 'salesforce',
      idempotency_key: `${channel}:42`,
    });
    expect(followup.exists).toBe(true);

    // Second arrival across a fresh process (new replayId tracker) —
    // the persisted ledger row catches it.
    const tracker2 = createInMemoryReplayIdTracker();
    const processor2 = buildSalesforceEngagementWebhookProcessor({
      entity: 'task',
      replayIdTracker: tracker2,
      engagementStore: store,
    });
    const out2 = processor2.parseEvents(event, {}, 'acme');
    expect(out2).toHaveLength(0);
  });

  it('replayId monotonicity rejects same-or-older replayIds', () => {
    const { store } = makeStore();
    const tracker = createInMemoryReplayIdTracker();
    const processor = buildSalesforceEngagementWebhookProcessor({
      entity: 'task',
      replayIdTracker: tracker,
      engagementStore: store,
    });
    const channel = `${SALESFORCE_PUSHTOPIC_CHANNEL_PREFIX}RecuedTaskFeed`;
    processor.parseEvents(
      {
        channel,
        data: {
          event: { type: 'updated' as const, replayId: 50 },
          sobject: { Id: '00T1', LastModifiedDate: '2026-05-04T10:00:00.000Z' },
        },
      },
      {},
      'acme',
    );
    // Same replayId
    const same = processor.parseEvents(
      {
        channel,
        data: {
          event: { type: 'updated' as const, replayId: 50 },
          sobject: { Id: '00T1', LastModifiedDate: '2026-05-04T10:00:00.000Z' },
        },
      },
      {},
      'acme',
    );
    expect(same).toHaveLength(0);
    // Older replayId
    const older = processor.parseEvents(
      {
        channel,
        data: {
          event: { type: 'updated' as const, replayId: 10 },
          sobject: { Id: '00T2', LastModifiedDate: '2026-05-04T10:00:00.000Z' },
        },
      },
      {},
      'acme',
    );
    expect(older).toHaveLength(0);
  });

  it('different channel filters out (channel discriminator works)', () => {
    const { store } = makeStore();
    const tracker = createInMemoryReplayIdTracker();
    const processor = buildSalesforceEngagementWebhookProcessor({
      entity: 'task',
      replayIdTracker: tracker,
      engagementStore: store,
    });
    const out = processor.parseEvents(
      {
        channel: `${SALESFORCE_PUSHTOPIC_CHANNEL_PREFIX}RecuedEventFeed`, // wrong channel
        data: {
          event: { type: 'updated' as const, replayId: 99 },
          sobject: { Id: '00U999', LastModifiedDate: '2026-05-04T10:00:00.000Z' },
        },
      },
      {},
      'acme',
    );
    expect(out).toHaveLength(0);
  });

  it('sobject id-prefix mismatch drops (defence-in-depth)', () => {
    const { store } = makeStore();
    const tracker = createInMemoryReplayIdTracker();
    const processor = buildSalesforceEngagementWebhookProcessor({
      entity: 'task',
      replayIdTracker: tracker,
      engagementStore: store,
    });
    const channel = `${SALESFORCE_PUSHTOPIC_CHANNEL_PREFIX}RecuedTaskFeed`;
    const out = processor.parseEvents(
      {
        channel,
        data: {
          event: { type: 'updated' as const, replayId: 1 },
          sobject: { Id: 'NOT_A_TASK', LastModifiedDate: '2026-05-04T10:00:00.000Z' },
        },
      },
      {},
      'acme',
    );
    expect(out).toHaveLength(0);
  });
});

// ────────────────────────────────────────────────────────────────
// Association rescan fetcher
// ────────────────────────────────────────────────────────────────

describe('D-139 P1b — association rescan fetcher', () => {
  it('Salesforce fetcher projects TaskRelation rows into EngagementEdgeProjection', async () => {
    const stubFetch: typeof fetch = async (url: string | URL | Request): Promise<Response> => {
      const u = typeof url === 'string' ? url : url.toString();
      // SOQL gets URL-encoded — match either form.
      if (u.includes('TaskRelation')) {
        return new Response(
          JSON.stringify({
            done: true,
            records: [
              {
                Id: 'tr1',
                TaskId: '00Tparent',
                RelationId: '003contact',
                IsWhat: false,
                IsDeleted: false,
              },
              {
                Id: 'tr2',
                TaskId: '00Tparent',
                RelationId: '006opp',
                IsWhat: true,
                IsDeleted: false,
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response('not found', { status: 404 });
    };
    const fetcher = buildSalesforceAssociationFetcher({
      search: {
        fetcher: stubFetch,
        refreshAuth: stubAuthRefresh,
      },
    });
    const result = await fetcher({
      connection: makeConnection(),
      connection_id: 'acme',
      vendor: 'salesforce',
      entity: 'task',
      target_id: 'salesforce_task_00Tparent',
    });
    expect(result.edges.length).toBe(2);
    const types = result.edges.map((e) => e.edge_type).sort();
    expect(types).toEqual(['contact', 'deal']);
  });

  it('VoiceCall has no relationship object — fetcher returns empty', async () => {
    const fetcher = buildSalesforceAssociationFetcher({
      search: {
        fetcher: (async () => new Response('', { status: 200 })) as typeof fetch,
        refreshAuth: stubAuthRefresh,
      },
    });
    const result = await fetcher({
      connection: makeConnection(),
      connection_id: 'acme',
      vendor: 'salesforce',
      entity: 'voice_call',
      target_id: 'salesforce_voice_call_0LQ123',
    });
    expect(result.edges.length).toBe(0);
  });
});

// ────────────────────────────────────────────────────────────────
// MCP body-content strip
// ────────────────────────────────────────────────────────────────

describe('D-139 P1b — MCP body-content strip', () => {
  it('EmailMessage row carries body_state + body_truncation_offset but body_inline strips by default', async () => {
    const { projectEngagementRowForMCP } = await import('@recued/contracts');
    const raw: RawSalesforceRecord = {
      Id: '02s1mcp0000',
      Subject: 'Long body',
      TextBody: 'a'.repeat(8000), // > 6KB inline cap → truncates
      FromAddress: 'a@b.com',
      ToAddress: 'c@d.com',
      MessageDate: '2026-05-04T08:00:00.000Z',
      Incoming: false,
      CreatedById: '005owner',
      CreatedDate: '2026-05-04T08:00:00.000Z',
      LastModifiedDate: '2026-05-04T08:00:00.000Z',
      SystemModstamp: '2026-05-04T08:00:00.000Z',
    };
    const row = projectEmailMessageEngagementRow('acme', raw, {
      now: FIXED_NOW,
      authorship: {},
    });
    expect(row.body_state).toBe('truncated_inline');
    expect(row.body_truncation_offset).toBeGreaterThan(0);
    expect(row.body_inline).toBeDefined();

    const mcp = projectEngagementRowForMCP(row);
    expect(mcp.body_state).toBe('truncated_inline');
    expect(mcp.body_truncation_offset).toBeGreaterThan(0);
    // body_inline + vendor_raw_timestamp STRIPPED
    expect(mcp.body_inline).toBeUndefined();
    expect(mcp.vendor_raw_timestamp).toBeUndefined();
  });

  it('with body_content_granted=true, MCP projection inlines body', async () => {
    const { projectEngagementRowForMCP } = await import('@recued/contracts');
    const raw: RawSalesforceRecord = {
      Id: '02s1grant000',
      TextBody: 'short',
      FromAddress: 'a@b.com',
      ToAddress: 'c@d.com',
      MessageDate: '2026-05-04T08:00:00.000Z',
      Incoming: false,
      CreatedById: '005owner',
      CreatedDate: '2026-05-04T08:00:00.000Z',
      LastModifiedDate: '2026-05-04T08:00:00.000Z',
      SystemModstamp: '2026-05-04T08:00:00.000Z',
    };
    const row = projectEmailMessageEngagementRow('acme', raw, {
      now: FIXED_NOW,
      authorship: {},
    });
    const mcp = projectEngagementRowForMCP(row, { body_content_granted: true });
    expect(mcp.body_inline).toBe('short');
    expect(mcp.vendor_raw_timestamp).toBeDefined();
  });
});

// ────────────────────────────────────────────────────────────────
// listUpdatedSince integration with searchSalesforceObjects
// ────────────────────────────────────────────────────────────────

describe('D-139 P1b — listUpdatedSince round-trip', () => {
  it('Task reconciler walks paginated SOQL results', async () => {
    const fetchedUrls: string[] = [];
    const stubFetch: typeof fetch = async (url: string | URL | Request): Promise<Response> => {
      const u = typeof url === 'string' ? url : url.toString();
      fetchedUrls.push(u);
      // Return one record then done
      return new Response(
        JSON.stringify({
          done: true,
          records: [
            {
              Id: '00Tabc',
              Subject: 'Sample',
              Status: 'Completed',
              CompletedDateTime: '2026-05-04T10:00:00.000Z',
              OwnerId: '005owner',
              CreatedById: '005owner',
              CreatedDate: '2026-05-01T00:00:00.000Z',
              LastModifiedDate: '2026-05-04T10:00:00.000Z',
              SystemModstamp: '2026-05-04T10:00:00.000Z',
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    };
    const { store } = makeStore();
    const reconciler = new SalesforceTaskEngagementReconciler({
      search: { fetcher: stubFetch, refreshAuth: stubAuthRefresh },
      engagementStore: store,
      authorship: { connectionUserOwnerId: '005owner' },
      now: () => FIXED_NOW,
    });
    const slimRecords: Array<{ id: string; modified_at: number }> = [];
    for await (const slim of reconciler.listUpdatedSince(makeConnection(), 0, 10)) {
      slimRecords.push({ id: slim.id, modified_at: slim.modified_at });
    }
    expect(slimRecords.length).toBe(1);
    expect(slimRecords[0].id).toBe('salesforce_task_00Tabc');
    expect(fetchedUrls.length).toBe(1);
    expect(fetchedUrls[0]).toContain('FROM%20Task');
  });
});
