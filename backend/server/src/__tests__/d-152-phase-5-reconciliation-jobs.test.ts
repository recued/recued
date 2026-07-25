/** D-152 P5 - reconciliation jobs and DDNS soft-hold lifecycle. */

import { readFileSync } from 'node:fs';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createAuditLogStore,
  type ActivityEntry,
  type AuditEntry,
} from '@recued/storage';
import type {
  CollectionRecord,
  RecipeDefinition,
} from '@recued/contracts';

import { createCollectionTable } from '../collections/table.js';
import { createInMemoryDdnsIpStateStore } from '../ddns/ip-state-store.js';
import {
  createDdnsIpStateDnsReconciliationAdapter,
  createDnsProviderCapabilityAdapter,
} from '../hostname/reconciliation-adapters.js';
import {
  PRO_DDNS_SOFT_HOLD_MS,
  createProSubscriptionStateStore,
} from '../hostname/pro-subscription-state.js';
import {
  HOSTNAME_RECONCILIATION_DAILY_INTERVAL_MS,
  HOSTNAME_RECONCILIATION_DAILY_RUNNER_NAME,
  beginDdnsSoftHold,
  markDdnsActive,
  registerDailyHostnameReconciliationRunner,
  runExpiredHandlesJob,
  runHostnameReconciliationJobs,
  type HostnameDnsRecord,
  type HostnameReconciliationAction,
  type HostnameReconciliationAlert,
} from '../hostname/reconciliation-jobs.js';
import {
  ensureMemorySchema,
  getOrCreateRecipeInsight,
} from '../memory-schema.js';
import { createRecipeStore } from '../recipe-store.js';
import { createSQLiteCollection } from '../sqlite-collection.js';
import { createContactStore } from '../storage/contact-store.js';
import { createHostnameRegistryStore } from '../storage/hostname-registry.js';

const NOW = 1_700_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;

let db: Database.Database;
let now = NOW;
let nextHostnameId = 0;
let nextStateId = 0;

const makeHostnameStore = () =>
  createHostnameRegistryStore(db, {
    now: () => now,
    newId: () => `host-${++nextHostnameId}`,
  });

const makeSubscriptionStore = () =>
  createProSubscriptionStateStore(db, {
    now: () => now,
    newId: () => `state-${++nextStateId}`,
  });

const makeRecipe = (recipe_id: string): RecipeDefinition => ({
  recipe_id,
  version: 1,
  ttl: 60,
  metadata: {
    name: recipe_id,
    description: 'D-152 fixture recipe',
    author: 'recued-core',
    supported_platforms: [],
  },
  variables: {},
  prefetch_steps: [],
  steps: [{ id: 's', transform: 'template', template: 'ok' }],
  output: { sidebar: [] },
});

const makeCollectionRecord = (): CollectionRecord => ({
  record_id: 'mail-1',
  received_at: NOW - DAY_MS,
  modified_at: NOW - DAY_MS,
  hot_fields: {
    from: 'alice@example.com',
    subject: 'Budget approved',
    thread_id: 'thread-i5',
  },
  size_bytes: 15,
  source_id: '<mail-1@example.com>',
  body_inline: 'Budget approved',
});

const flushAsync = (): Promise<void> =>
  new Promise((resolve) => {
    setImmediate(resolve);
  });

beforeEach(() => {
  db = new Database(':memory:');
  now = NOW;
  nextHostnameId = 0;
  nextStateId = 0;
});

afterEach(() => {
  db.close();
});

describe('D-152 P5 DDNS soft-hold timer', () => {
  it('starts a 30-day soft hold on cancellation and releases the handle at Day 30', async () => {
    const hostnameRegistry = makeHostnameStore();
    const subscriptionState = makeSubscriptionStore();
    const auditEvents: HostnameReconciliationAction[] = [];

    hostnameRegistry.upsert({
      server_identity_id: 'server-1',
      hostname: 'alice.recued.net',
      cert_source: 'recued_acme',
      cert_expires_at: NOW + 60 * DAY_MS,
      ddns_managed: true,
      enabled: true,
    });

    const state = await beginDdnsSoftHold(
      {
        hostnameRegistry,
        subscriptionState,
        audit: { emit: (event) => { auditEvents.push(event); } },
        now: () => now,
      },
      { publisher_id: 'publisher-alice', hostname: 'alice.recued.net' },
    );

    expect(state).toMatchObject({
      publisher_id: 'publisher-alice',
      hostname_normalized: 'alice.recued.net',
      status: 'soft_hold',
      soft_hold_until: NOW + PRO_DDNS_SOFT_HOLD_MS,
      canceled_at: NOW,
    });
    expect(hostnameRegistry.get('alice.recued.net')).toMatchObject({
      hostname_normalized: 'alice.recued.net',
      enabled: false,
    });
    expect(auditEvents.map((event) => event.kind)).toEqual(['soft_hold_started']);

    now = state.soft_hold_until! - 1;
    const early = await runExpiredHandlesJob({
      hostnameRegistry,
      subscriptionState,
      audit: { emit: (event) => { auditEvents.push(event); } },
      now: () => now,
    });
    expect(early.actions).toHaveLength(0);
    expect(hostnameRegistry.get('alice.recued.net')).not.toBeNull();

    now = state.soft_hold_until!;
    const released = await runExpiredHandlesJob({
      hostnameRegistry,
      subscriptionState,
      audit: { emit: (event) => { auditEvents.push(event); } },
      safety: { allowHandleRemoval: true },
      now: () => now,
    });

    expect(released.actions).toEqual([
      {
        job: 'expired_handles',
        kind: 'expired_handle_released',
        hostname: 'alice.recued.net',
        occurred_at: now,
      },
    ]);
    expect(hostnameRegistry.get('alice.recued.net')).toBeNull();
    expect(subscriptionState.get('alice.recued.net')).toMatchObject({
      status: 'released',
      released_at: now,
    });
  });

  it('restores a soft-held DDNS handle when the subscription is marked active again', async () => {
    const hostnameRegistry = makeHostnameStore();
    const subscriptionState = makeSubscriptionStore();
    const auditEvents: HostnameReconciliationAction[] = [];

    hostnameRegistry.upsert({
      server_identity_id: 'server-1',
      hostname: 'alice.recued.net',
      cert_source: 'recued_acme',
      cert_expires_at: NOW + 60 * DAY_MS,
      ddns_managed: true,
      enabled: true,
    });

    const hold = await beginDdnsSoftHold(
      {
        hostnameRegistry,
        subscriptionState,
        audit: { emit: (event) => { auditEvents.push(event); } },
        now: () => now,
      },
      { publisher_id: 'publisher-alice', hostname: 'alice.recued.net' },
    );
    expect(hold.status).toBe('soft_hold');
    expect(hostnameRegistry.get('alice.recued.net')).toMatchObject({
      enabled: false,
    });

    now = NOW + DAY_MS;
    const active = await markDdnsActive(
      {
        hostnameRegistry,
        subscriptionState,
        audit: { emit: (event) => { auditEvents.push(event); } },
        now: () => now,
      },
      { publisher_id: 'publisher-alice', hostname: 'alice.recued.net' },
    );

    expect(active).toMatchObject({
      state_id: hold.state_id,
      publisher_id: 'publisher-alice',
      hostname_normalized: 'alice.recued.net',
      status: 'active',
      updated_at: now,
    });
    expect(active.soft_hold_until).toBeUndefined();
    expect(active.canceled_at).toBeUndefined();
    expect(active.released_at).toBeUndefined();
    expect(hostnameRegistry.get('alice.recued.net')).toMatchObject({
      enabled: true,
      updated_at: now,
    });
    expect(subscriptionState.get('alice.recued.net')).toMatchObject({
      status: 'active',
      updated_at: now,
    });
    expect(auditEvents.map((event) => event.kind)).toEqual([
      'soft_hold_started',
      'handle_restored',
    ]);
  });
});

describe('D-152 I-5 runtime invariant', () => {
  it('keeps data.*, recipes, and memory readable after DDNS cancellation', async () => {
    const hostnameRegistry = makeHostnameStore();
    const subscriptionState = makeSubscriptionStore();
    const contactStore = createContactStore(db);
    const mailTable = createCollectionTable({
      db,
      platform: 'mail',
      slug: 'work',
    });

    const auditEntries = createSQLiteCollection<AuditEntry>(db, 'audit_entries');
    const auditActivities = createSQLiteCollection<ActivityEntry>(db, 'audit_activities');
    ensureMemorySchema(db);
    const auditLog = createAuditLogStore(auditEntries, auditActivities);
    const recipeStore = createRecipeStore('/definitely-not-a-real-d152-community-dir', db);

    hostnameRegistry.upsert({
      server_identity_id: 'server-1',
      hostname: 'alice.recued.net',
      cert_source: 'recued_acme',
      cert_expires_at: NOW + 60 * DAY_MS,
      ddns_managed: true,
      enabled: true,
    });
    await markDdnsActive(
      {
        hostnameRegistry,
        subscriptionState,
        now: () => now,
      },
      { publisher_id: 'publisher-alice', hostname: 'alice.recued.net' },
    );

    contactStore.observe(
      {
        email: 'alice@example.com',
        name: 'Alice Example',
        source: 'email_from',
        event_at: NOW - DAY_MS,
      },
      NOW,
    );
    mailTable.upsert(makeCollectionRecord());
    const recipe = makeRecipe('d152-i5-preserve-recipe');
    recipeStore.save(recipe, 'publisher-alice', 'inline', NOW);
    const insightId = getOrCreateRecipeInsight(db, {
      hash: 'hash-d152-i5',
      slug: recipe.recipe_id,
      version: recipe.version,
      flattened: '{"steps":[]}',
      created_at: NOW,
    });
    await auditLog.append({
      run_id: 'run-d152-i5',
      recipe_id: recipe.recipe_id,
      recipe_hash: 'hash-d152-i5',
      started_at: NOW,
      finished_at: NOW + 25,
      duration_ms: 25,
      commit_status: 'succeeded',
      config_snapshot: {},
      errors: [],
      trigger_url: null,
      trigger_source: null,
      instance_id: null,
      output_string: 'memory-readable',
      recipe_insight_id: insightId,
    });
    db.prepare(
      `INSERT INTO links (memory_id, entity_id, recipe_insight_id, kind, ts)
         VALUES (?, ?, ?, ?, ?)`,
    ).run(
      'run-d152-i5',
      'data.mail.mail-1',
      insightId,
      'execution.action',
      NOW,
    );

    const state = await beginDdnsSoftHold(
      {
        hostnameRegistry,
        subscriptionState,
        now: () => now,
      },
      { publisher_id: 'publisher-alice', hostname: 'alice.recued.net' },
    );

    expect(state.status).toBe('soft_hold');
    expect(hostnameRegistry.get('alice.recued.net')).toMatchObject({
      enabled: false,
    });
    expect(contactStore.get('alice@example.com')).toMatchObject({
      email: 'alice@example.com',
      name: 'Alice Example',
    });
    expect(mailTable.get('mail-1')).toMatchObject({
      record_id: 'mail-1',
      body_inline: 'Budget approved',
    });
    expect(mailTable.list({
      platform: 'mail',
      slug: 'work',
      filters: { thread_id: 'thread-i5' },
    }).map((record) => record.record_id)).toEqual(['mail-1']);
    expect(recipeStore.get(recipe.recipe_id)).toMatchObject({
      recipe_id: recipe.recipe_id,
    });
    expect(recipeStore.listStored().map((row) => row.recipe_id)).toContain(
      recipe.recipe_id,
    );
    expect(await auditLog.get('run-d152-i5')).toMatchObject({
      output_string: 'memory-readable',
      recipe_insight_id: insightId,
    });
    expect(
      db.prepare(
        `SELECT entity_id FROM links WHERE memory_id = ? ORDER BY ts ASC`,
      ).all('run-d152-i5'),
    ).toEqual([{ entity_id: 'data.mail.mail-1' }]);
    expect(
      db.prepare(`SELECT slug FROM recipe_insights WHERE id = ?`).get(insightId),
    ).toEqual({ slug: recipe.recipe_id });
  });
});

describe('D-152 P5 A.11 hostname reconciliation jobs', () => {
  it('runs the v1.0 active reconciliation set over the hostname registry', async () => {
    const hostnameRegistry = makeHostnameStore();
    const subscriptionState = makeSubscriptionStore();
    const auditEvents: HostnameReconciliationAction[] = [];
    const alertEvents: HostnameReconciliationAlert[] = [];
    const dnsRecords = new Map<string, HostnameDnsRecord | null>([
      ['alice.recued.net', { kind: 'CNAME', value: 'relay.recued.net.' }],
      ['bob.recued.net', { kind: 'A', value: '203.0.113.4' }],
      ['ambiguous.recued.net', { kind: 'A', value: '203.0.113.5' }],
    ]);
    const renewed: string[] = [];

    hostnameRegistry.upsert({
      server_identity_id: 'server-1',
      hostname: 'alice.recued.net',
      cert_source: 'recued_acme',
      cert_expires_at: NOW + 7 * DAY_MS,
      ddns_managed: true,
      enabled: true,
    });
    hostnameRegistry.upsert({
      server_identity_id: 'server-1',
      hostname: 'bob.recued.net',
      cert_source: 'recued_acme',
      cert_expires_at: NOW + 45 * DAY_MS,
      ddns_managed: true,
      enabled: true,
    });
    hostnameRegistry.upsert({
      server_identity_id: 'server-1',
      hostname: 'ambiguous.recued.net',
      cert_source: 'recued_acme',
      cert_expires_at: NOW + 45 * DAY_MS,
      ddns_managed: true,
      enabled: true,
    });
    hostnameRegistry.upsert({
      server_identity_id: 'server-1',
      hostname: 'old.recued.net',
      cert_source: 'recued_acme',
      cert_expires_at: NOW + 3 * DAY_MS,
      ddns_managed: true,
      enabled: false,
    });
    hostnameRegistry.upsert({
      server_identity_id: 'server-1',
      hostname: 'app.example',
      cert_source: 'byo_uploaded',
      cert_expires_at: NOW + 2 * DAY_MS,
      enabled: true,
      ownership_status: 'verified',
    });
    subscriptionState.beginSoftHold({
      publisher_id: 'publisher-old',
      hostname: 'old.recued.net',
      canceled_at: NOW - PRO_DDNS_SOFT_HOLD_MS,
    });
    subscriptionState.beginSoftHold({
      publisher_id: 'publisher-missing',
      hostname: 'missing.recued.net',
      canceled_at: NOW - PRO_DDNS_SOFT_HOLD_MS,
    });

    const result = await runHostnameReconciliationJobs({
      hostnameRegistry,
      subscriptionState,
      dns: {
        expectedRecord(hostname) {
          if (hostname.hostname === 'ambiguous.recued.net') return null;
          return { kind: 'CNAME', value: 'relay.recued.net' };
        },
        getRecord(hostname) {
          return dnsRecords.get(hostname) ?? null;
        },
        setRecord(hostname, record) {
          dnsRecords.set(hostname, record);
        },
      },
      certs: {
        renew(hostname) {
          renewed.push(hostname.hostname);
          return { ok: true };
        },
      },
      provider: {
        check() {
          return { ok: false, error: 'cloudflare_dns_api_unavailable' };
        },
      },
      safety: {
        allowHandleRemoval: true,
        allowDnsCorrection: true,
      },
      audit: { emit: (event) => { auditEvents.push(event); } },
      alerts: { emit: (alert) => { alertEvents.push(alert); } },
      now: () => NOW,
    });

    expect(result.actions.map((action) => action.kind)).toEqual([
      'expired_handle_released',
      'stuck_soft_hold_released',
      'dns_record_ambiguous',
      'dns_record_corrected',
      'cert_renewal_requested',
      'provider_capability_failed',
    ]);
    expect(auditEvents.map((action) => action.kind)).toEqual(result.actions.map((action) => action.kind));
    expect(alertEvents.map((alert) => alert.code)).toEqual([
      'expected_dns_record_ambiguous',
      'provider_capability_failed',
    ]);
    expect(hostnameRegistry.get('old.recued.net')).toBeNull();
    expect(subscriptionState.get('old.recued.net')).toMatchObject({ status: 'released' });
    expect(subscriptionState.get('missing.recued.net')).toMatchObject({ status: 'released' });
    expect(dnsRecords.get('bob.recued.net')).toEqual({
      kind: 'CNAME',
      value: 'relay.recued.net',
    });
    expect(renewed).toEqual(['alice.recued.net']);
    expect(hostnameRegistry.get('app.example')).not.toBeNull();
  });

  it('keeps handle removal and DNS correction disabled by default', async () => {
    const hostnameRegistry = makeHostnameStore();
    const subscriptionState = makeSubscriptionStore();
    const auditEvents: HostnameReconciliationAction[] = [];
    const alertEvents: HostnameReconciliationAlert[] = [];
    const dnsRecords = new Map<string, HostnameDnsRecord | null>([
      ['old.recued.net', { kind: 'A', value: '203.0.113.20' }],
    ]);
    let dnsWrites = 0;

    hostnameRegistry.upsert({
      server_identity_id: 'server-1',
      hostname: 'old.recued.net',
      cert_source: 'recued_acme',
      cert_expires_at: NOW + 45 * DAY_MS,
      ddns_managed: true,
      enabled: true,
    });
    subscriptionState.beginSoftHold({
      publisher_id: 'publisher-old',
      hostname: 'old.recued.net',
      canceled_at: NOW - PRO_DDNS_SOFT_HOLD_MS,
    });

    const result = await runHostnameReconciliationJobs({
      hostnameRegistry,
      subscriptionState,
      dns: {
        expectedRecord() {
          return { kind: 'A', value: '203.0.113.99' };
        },
        getRecord(hostname) {
          return dnsRecords.get(hostname) ?? null;
        },
        setRecord() {
          dnsWrites++;
        },
      },
      certs: {
        renew() {
          return { ok: true };
        },
      },
      provider: {
        check() {
          return { ok: true };
        },
      },
      audit: { emit: (event) => { auditEvents.push(event); } },
      alerts: { emit: (alert) => { alertEvents.push(alert); } },
      now: () => NOW,
    });

    expect(result.actions.map((action) => action.kind)).toEqual([
      'expired_handle_release_blocked',
      'dns_record_correction_blocked',
      'provider_capability_ok',
    ]);
    expect(alertEvents.map((alert) => alert.code)).toEqual([
      'handle_removal_disabled',
      'dns_record_correction_disabled',
    ]);
    expect(auditEvents.map((action) => action.kind)).toEqual(result.actions.map((action) => action.kind));
    expect(hostnameRegistry.get('old.recued.net')).not.toBeNull();
    expect(subscriptionState.get('old.recued.net')).toMatchObject({ status: 'soft_hold' });
    expect(dnsWrites).toBe(0);
  });
});

describe('D-152 P5 A.10/A.11 daily hostname reconciliation runner', () => {
  it('registers a fixed daily cadence wrapper around the reconciliation jobs', async () => {
    const hostnameRegistry = makeHostnameStore();
    const subscriptionState = makeSubscriptionStore();
    const auditEvents: HostnameReconciliationAction[] = [];
    const providerChecks: number[] = [];
    const registrations: Array<{
      name: string;
      intervalMs: number;
      tick: () => void;
      fireImmediate?: boolean;
    }> = [];
    const stop = () => {};

    const stopHandle = registerDailyHostnameReconciliationRunner({
      backgroundServices: {
        registerInterval(spec) {
          registrations.push(spec);
          return stop;
        },
      },
      deps: {
        hostnameRegistry,
        subscriptionState,
        dns: {
          expectedRecord() {
            return null;
          },
          getRecord() {
            return null;
          },
          setRecord() {},
        },
        certs: {
          renew() {
            return { ok: true };
          },
        },
        provider: {
          check() {
            providerChecks.push(NOW);
            return { ok: true, detail: 'provider-ok' };
          },
        },
        audit: { emit: (event) => { auditEvents.push(event); } },
        now: () => NOW,
      },
    });

    expect(stopHandle).toBe(stop);
    expect(registrations).toHaveLength(1);
    expect(registrations[0]).toMatchObject({
      name: HOSTNAME_RECONCILIATION_DAILY_RUNNER_NAME,
      intervalMs: HOSTNAME_RECONCILIATION_DAILY_INTERVAL_MS,
      fireImmediate: true,
    });

    registrations[0].tick();
    await flushAsync();

    expect(providerChecks).toEqual([NOW]);
    expect(auditEvents).toEqual([
      {
        job: 'provider_capability_check',
        kind: 'provider_capability_ok',
        detail: 'provider-ok',
        occurred_at: NOW,
      },
    ]);
  });

  it('reports and swallows async tick failures', async () => {
    const hostnameRegistry = makeHostnameStore();
    const subscriptionState = makeSubscriptionStore();
    const registrations: Array<{
      name: string;
      intervalMs: number;
      tick: () => void;
      fireImmediate?: boolean;
    }> = [];
    const errors: unknown[] = [];
    const failure = new Error('provider unavailable');

    registerDailyHostnameReconciliationRunner({
      backgroundServices: {
        registerInterval(spec) {
          registrations.push(spec);
          return () => {};
        },
      },
      deps: {
        hostnameRegistry,
        subscriptionState,
        dns: {
          expectedRecord() {
            return null;
          },
          getRecord() {
            return null;
          },
          setRecord() {},
        },
        certs: {
          renew() {
            return { ok: true };
          },
        },
        provider: {
          check() {
            throw failure;
          },
        },
        now: () => NOW,
      },
      onError(error) {
        errors.push(error);
      },
    });

    expect(() => registrations[0].tick()).not.toThrow();
    await flushAsync();

    expect(errors).toEqual([failure]);
  });
});

describe('D-152 P5 concrete hostname reconciliation adapters', () => {
  it('derives the expected DNS A record from the last acknowledged DDNS IP state', async () => {
    const ipStateStore = createInMemoryDdnsIpStateStore({
      ip_v4: '203.0.113.42',
      last_published_at: NOW,
    });
    const adapter = createDdnsIpStateDnsReconciliationAdapter({
      ipStateStore,
      resolver: { resolve4: async () => ['203.0.113.42'] },
      ttl: 60,
    });

    expect(adapter.expectedRecord({
      hostname_id: 'host-1',
      hostname: 'alice.recued.net',
      cert_source: 'recued_acme',
      ownership_status: 'verified',
      listener_ports: [443],
      ddns_managed: true,
      enabled: true,
      tls_topology: 'server_terminated',
    })).toEqual({ kind: 'A', value: '203.0.113.42', ttl: 60 });
    await expect(adapter.getRecord('alice.recued.net')).resolves.toEqual({
      kind: 'A',
      value: '203.0.113.42',
    });
  });

  it('treats missing local IP state and ambiguous DNS answers as non-authoritative', async () => {
    const adapter = createDdnsIpStateDnsReconciliationAdapter({
      ipStateStore: createInMemoryDdnsIpStateStore(),
      resolver: { resolve4: async () => ['203.0.113.1', '203.0.113.2'] },
    });

    expect(adapter.expectedRecord({
      hostname_id: 'host-1',
      hostname: 'alice.recued.net',
      cert_source: 'recued_acme',
      ownership_status: 'verified',
      listener_ports: [443],
      ddns_managed: true,
      enabled: true,
      tls_topology: 'server_terminated',
    })).toBeNull();
    await expect(adapter.getRecord('alice.recued.net')).resolves.toBeNull();
    await expect(adapter.setRecord('alice.recued.net', { kind: 'A', value: '203.0.113.42' }))
      .rejects.toThrow(/read-only/);
  });

  it('checks provider capability through DNS resolution without requiring write credentials', async () => {
    const provider = createDnsProviderCapabilityAdapter({
      probeHostname: 'recued.cloud',
      resolver: { resolve4: async () => ['203.0.113.10'] },
    });
    const failed = createDnsProviderCapabilityAdapter({
      probeHostname: 'recued.cloud',
      resolver: {
        async resolve4() {
          throw new Error('resolver down');
        },
      },
    });

    await expect(provider.check()).resolves.toEqual({
      ok: true,
      detail: 'dns_probe_ok:recued.cloud',
    });
    await expect(failed.check()).resolves.toEqual({
      ok: false,
      error: 'dns_probe_failed:recued.cloud:resolver down',
    });
  });
});

describe('D-152 I-5 structural guard', () => {
  it('keeps cancellation and reconciliation modules out of user-content stores', () => {
    const sources = [
      readFileSync(new URL('../hostname/pro-subscription-state.ts', import.meta.url), 'utf8'),
      readFileSync(new URL('../hostname/reconciliation-jobs.ts', import.meta.url), 'utf8'),
    ];

    for (const source of sources) {
      const imports = source
        .split('\n')
        .filter((line) => /^\s*import\b/.test(line))
        .join('\n');
      expect(imports).not.toMatch(/['"][^'"]*(?:\/data\/|\/data|recipe|memory|@recued\/recipes)[^'"]*['"]/);
      expect(source).not.toMatch(/\b(?:DELETE|UPDATE|INSERT INTO|FROM)\s+(?:data\.|recipes?\b|memory\b)/i);
    }
  });
});
