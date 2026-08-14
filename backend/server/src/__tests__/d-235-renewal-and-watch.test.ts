/** D-235 P4 — renewal for every custom row, and the § 5.1 delegation watch.
 *
 *  § 5.1 is the section this file exists for: "Delete it and nothing breaks —
 *  until the cert expires ~60 days later, then everything does at once. This is
 *  the classic silent-until-outage shape and it MUST be monitored, not
 *  discovered."
 */

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';

import {
  CERT_RENEWAL_LEAD_TIME_MS,
  CERT_RENEWAL_USER_WARNING_LEAD_TIME_MS,
  CUSTOM_DOMAIN_DELEGATION_STATES,
  customDomainDelegationUrgency,
  delegationStateFromPreflight,
  evaluateCustomDomainPreflight,
  projectHostname,
  type CustomDomainPreflightResult,
  type HostnameProjection,
  type HostnameStorageRow,
} from '@recued/contracts';
import { createHostnameRegistryStore } from '../storage/hostname-registry.js';
import {
  composeCustomDomainEnrollment,
  selectDelegationWatchDue,
  selectRenewableCustomDomains,
  DELEGATION_WATCH_INTERVAL_MS,
} from '../composition/bin/wire-custom-domain-enrollment.js';

const CUSTOM = 'recued.their-domain.com';
const DDNS = 'alice.recued.net';
const DELEGATION_TARGET = '_acme-challenge.alice.recued.net';
const SERVER_ID = 'server-identity-1';
const DAY = 86_400_000;

const preflightFor = (
  hostname: string,
  delegation: 'ok' | 'missing' | 'unresolved',
): CustomDomainPreflightResult =>
  evaluateCustomDomainPreflight({
    hostname,
    handle: 'alice',
    observation: {
      host_cnames: [DDNS],
      host_addresses: [],
      ddns_addresses: [],
      delegation_cnames: delegation === 'ok' ? [DELEGATION_TARGET] : [],
      ...(delegation === 'unresolved' ? { delegation_resolver_error: true } : {}),
      caa_records: [],
    },
  });

// ── the urgency function ────────────────────────────────────────────────

describe('D-235 § 5.1 — urgency is keyed on remaining cert lifetime', () => {
  const NOW = 1_700_000_000_000;
  const urgency = (
    delegation_state: 'ok' | 'broken' | 'unknown' | undefined,
    daysLeft: number | undefined,
  ) =>
    customDomainDelegationUrgency({
      delegation_state,
      cert_expires_at: daysLeft === undefined ? undefined : NOW + daysLeft * DAY,
      now: NOW,
    });

  it('says nothing when the delegation resolves, or was never checked', () => {
    expect(urgency('ok', 3)).toBe('none');
    expect(urgency(undefined, 3)).toBe('none');
  });

  it('escalates a broken delegation as the certificate runs down', () => {
    // The same broken CNAME is a footnote three months out and an emergency
    // next Tuesday. A monitor that cannot tell those apart either cries wolf or
    // arrives too late.
    expect(urgency('broken', 60)).toBe('notice');
    expect(urgency('broken', 29)).toBe('warning');
    expect(urgency('broken', 3)).toBe('incident');
    expect(urgency('broken', -1)).toBe('incident');
  });

  it('puts the thresholds exactly on the D-148 constants', () => {
    const at = (ms: number) =>
      customDomainDelegationUrgency({
        delegation_state: 'broken',
        cert_expires_at: NOW + ms,
        now: NOW,
      });
    expect(at(CERT_RENEWAL_LEAD_TIME_MS + 1)).toBe('notice');
    expect(at(CERT_RENEWAL_LEAD_TIME_MS)).toBe('warning');
    expect(at(CERT_RENEWAL_USER_WARNING_LEAD_TIME_MS + 1)).toBe('warning');
    expect(at(CERT_RENEWAL_USER_WARNING_LEAD_TIME_MS)).toBe('incident');
  });

  it('⛔ `unknown` NEVER escalates, however close expiry is', () => {
    // A lookup that failed is a fact about OUR resolver, not the user's zone.
    // Paging someone to fix a record that is already correct is how a monitor
    // gets muted, and a muted monitor is worse than none.
    expect(urgency('unknown', 60)).toBe('notice');
    expect(urgency('unknown', 1)).toBe('notice');
    expect(urgency('unknown', -5)).toBe('notice');
  });

  it('a broken delegation with no certificate yet is only a notice', () => {
    expect(urgency('broken', undefined)).toBe('notice');
  });
});

describe('D-235 — reading delegation state out of a preflight', () => {
  it('maps pass / fail / unknown, and reads ONLY the delegation check', () => {
    expect(delegationStateFromPreflight(preflightFor(CUSTOM, 'ok'))).toBe('ok');
    expect(delegationStateFromPreflight(preflightFor(CUSTOM, 'missing'))).toBe('broken');
    expect(delegationStateFromPreflight(preflightFor(CUSTOM, 'unresolved'))).toBe('unknown');
  });

  it('a CAA problem is NOT a delegation problem', () => {
    // Folding them together would make "delegation broken" mean four things and
    // point the user at the wrong record.
    const preflight = evaluateCustomDomainPreflight({
      hostname: CUSTOM,
      handle: 'alice',
      observation: {
        host_cnames: [DDNS],
        host_addresses: [],
        ddns_addresses: [],
        delegation_cnames: [DELEGATION_TARGET],
        caa_records: [{ flags: 0, tag: 'issue', value: 'digicert.com' }],
      },
    });
    expect(delegationStateFromPreflight(preflight)).toBe('ok');
  });

  it('every state in the closed list is reachable from a preflight', () => {
    const reached = new Set([
      delegationStateFromPreflight(preflightFor(CUSTOM, 'ok')),
      delegationStateFromPreflight(preflightFor(CUSTOM, 'missing')),
      delegationStateFromPreflight(preflightFor(CUSTOM, 'unresolved')),
    ]);
    expect([...reached].sort()).toEqual([...CUSTOM_DOMAIN_DELEGATION_STATES].sort());
  });
});

// ── the projection ──────────────────────────────────────────────────────

describe('D-235 — the hostname projection carries the degraded state', () => {
  const NOW = 1_700_000_000_000;
  const row = (over: Partial<HostnameStorageRow> = {}): HostnameStorageRow => ({
    hostname_id: 'h1',
    server_identity_id: SERVER_ID,
    hostname_normalized: CUSTOM,
    cert_source: 'recued_acme_custom',
    ownership_status: 'verified',
    listener_ports: [443],
    ddns_managed: false,
    enabled: true,
    tls_topology: 'server_terminated',
    created_at: 1,
    updated_at: 1,
    ...over,
  });

  it('derives urgency at projection time rather than storing it', () => {
    // Urgency is a function of the clock, so a persisted copy would be wrong
    // the moment it was written.
    const p = projectHostname(
      row({ delegation_state: 'broken', cert_expires_at: NOW + 3 * DAY }),
      NOW,
    );
    expect(p.delegation_state).toBe('broken');
    expect(p.delegation_urgency).toBe('incident');
  });

  it('the SAME row reads as a notice months earlier', () => {
    const stored = row({ delegation_state: 'broken', cert_expires_at: NOW + 80 * DAY });
    expect(projectHostname(stored, NOW).delegation_urgency).toBe('notice');
  });

  it('omits urgency entirely when there is nothing to say', () => {
    // A row that has never been checked carries no field rather than a cheerful
    // 'none' it has not earned.
    expect(projectHostname(row(), NOW).delegation_urgency).toBeUndefined();
    expect(projectHostname(row({ delegation_state: 'ok' }), NOW).delegation_urgency)
      .toBeUndefined();
  });
});

// ── the store ───────────────────────────────────────────────────────────

const newStore = () => createHostnameRegistryStore(new Database(':memory:'));

const seedCustom = (
  store: ReturnType<typeof newStore>,
  hostname: string,
  over: { cert_fingerprint?: string; cert_expires_at?: number } = {},
) =>
  store.upsert({
    server_identity_id: SERVER_ID,
    hostname,
    cert_source: 'recued_acme_custom',
    ownership_status: 'verified',
    verification_method: 'dns_txt',
    enabled: true,
    ...over,
  });

describe('D-235 — persisting a delegation observation', () => {
  it('records the state and when it was seen', () => {
    const store = newStore();
    seedCustom(store, CUSTOM);
    const p = store.setDelegationState({ hostname: CUSTOM, state: 'broken', checked_at: 999 });
    expect(p?.delegation_state).toBe('broken');
    expect(p?.delegation_checked_at).toBe(999);
  });

  it('⛔ an ordinary upsert does NOT erase it', () => {
    // A monitor must not be able to have its observations wiped by an unrelated
    // write — and `upsert` rewrites every column from its input, so a caller
    // that forgot one field would do exactly that.
    const store = newStore();
    seedCustom(store, CUSTOM);
    store.setDelegationState({ hostname: CUSTOM, state: 'broken', checked_at: 999 });
    seedCustom(store, CUSTOM, { cert_fingerprint: 'fp', cert_expires_at: 12345 });
    const row = store.get(CUSTOM);
    expect(row?.delegation_state).toBe('broken');
    expect(row?.delegation_checked_at).toBe(999);
    expect(row?.cert_fingerprint).toBe('fp');
  });

  it('⚠ but a source change DOES clear it', () => {
    // A past delegation reading is meaningless for a byo_uploaded row, and
    // would render as a delegation warning on a hostname that has no delegation.
    const store = newStore();
    seedCustom(store, CUSTOM);
    store.setDelegationState({ hostname: CUSTOM, state: 'broken', checked_at: 999 });
    store.upsert({
      server_identity_id: SERVER_ID,
      hostname: CUSTOM,
      cert_source: 'byo_uploaded',
    });
    const row = store.get(CUSTOM);
    expect(row?.delegation_state).toBeUndefined();
    expect(row?.delegation_checked_at).toBeUndefined();
  });

  it('survives the D-235 CHECK rebuild on a legacy database', () => {
    // ⛔ The rebuild copies an explicit column list. If the delegation columns
    //    were only added by the guarded ALTER and omitted from that list, the
    //    rebuild would DROP them and the next boot would re-add them EMPTY —
    //    losing every observation, once, invisibly.
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE hostname_registry (
        hostname_id TEXT PRIMARY KEY,
        server_identity_id TEXT NOT NULL,
        hostname_normalized TEXT NOT NULL UNIQUE,
        cert_source TEXT NOT NULL CHECK (cert_source IN ('recued_acme', 'byo_uploaded', 'byo_external')),
        cert_blob_id TEXT, cert_fingerprint TEXT, cert_expires_at INTEGER,
        cert_chain_metadata_json TEXT,
        ownership_status TEXT NOT NULL DEFAULT 'pending',
        verification_method TEXT, verification_token_hash TEXT, verified_at INTEGER,
        listener_ports_json TEXT NOT NULL,
        ddns_managed INTEGER NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 0,
        tls_topology TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
    `);
    db.prepare(
      `INSERT INTO hostname_registry (hostname_id, server_identity_id, hostname_normalized,
        cert_source, ownership_status, listener_ports_json, ddns_managed, enabled,
        tls_topology, created_at, updated_at)
       VALUES ('h1', @sid, @host, 'byo_uploaded', 'verified', '[443]', 0, 1,
        'server_terminated', 100, 200)`,
    ).run({ sid: SERVER_ID, host: 'legacy.example.com' });

    const store = createHostnameRegistryStore(db);
    seedCustom(store, CUSTOM);
    store.setDelegationState({ hostname: CUSTOM, state: 'broken', checked_at: 999 });
    // A second schema pass must not lose it either.
    createHostnameRegistryStore(db);
    expect(store.get(CUSTOM)?.delegation_state).toBe('broken');
    expect(store.get('legacy.example.com')?.created_at).toBe(100);
  });
});

// ── selection ───────────────────────────────────────────────────────────

const projection = (over: Partial<HostnameProjection>): HostnameProjection => ({
  hostname_id: 'h',
  hostname: CUSTOM,
  cert_source: 'recued_acme_custom',
  ownership_status: 'verified',
  listener_ports: [443],
  ddns_managed: false,
  enabled: true,
  tls_topology: 'server_terminated',
  ...over,
});

describe('D-235 P4 — selecting rows to renew and to watch', () => {
  const NOW = 1_700_000_000_000;

  it('renews only a custom row with a cert inside the lead window', () => {
    const rows = [
      projection({ hostname: 'due.x.com', cert_fingerprint: 'f', cert_expires_at: NOW + 5 * DAY }),
      projection({ hostname: 'fresh.x.com', cert_fingerprint: 'f', cert_expires_at: NOW + 80 * DAY }),
      projection({ hostname: 'nocert.x.com' }),
      projection({ hostname: DDNS, cert_source: 'recued_acme', cert_fingerprint: 'f', cert_expires_at: NOW }),
      projection({ hostname: 'byo.x.com', cert_source: 'byo_uploaded', cert_fingerprint: 'f', cert_expires_at: NOW }),
    ];
    expect(selectRenewableCustomDomains(rows, NOW).map((r) => r.hostname)).toEqual([
      'due.x.com',
    ]);
  });

  it('an already-expired certificate is still due, not skipped', () => {
    const rows = [
      projection({ cert_fingerprint: 'f', cert_expires_at: NOW - 10 * DAY }),
    ];
    expect(selectRenewableCustomDomains(rows, NOW)).toHaveLength(1);
  });

  it('a never-checked row is always due for the watch', () => {
    // Absent is not "recently confirmed".
    expect(selectDelegationWatchDue([projection({})], NOW)).toHaveLength(1);
  });

  it('a recently checked row is not re-checked', () => {
    const rows = [projection({ delegation_checked_at: NOW - 60_000 })];
    expect(selectDelegationWatchDue(rows, NOW)).toEqual([]);
    const stale = [
      projection({ delegation_checked_at: NOW - DELEGATION_WATCH_INTERVAL_MS - 1 }),
    ];
    expect(selectDelegationWatchDue(stale, NOW)).toHaveLength(1);
  });

  it('never watches a non-custom row', () => {
    const rows = [
      projection({ hostname: DDNS, cert_source: 'recued_acme' }),
      projection({ hostname: 'byo.x.com', cert_source: 'byo_uploaded' }),
    ];
    expect(selectDelegationWatchDue(rows, NOW)).toEqual([]);
  });
});

// ── the service ─────────────────────────────────────────────────────────

interface FakeInterval {
  name: string;
  tick: () => Promise<void>;
  fireImmediate?: boolean;
}

const drive = (opts: {
  seed: (store: ReturnType<typeof newStore>) => void;
  delegation?: 'ok' | 'missing' | 'unresolved';
  subscription_active?: boolean;
  now?: () => number;
}) => {
  const store = newStore();
  opts.seed(store);
  const intervals: FakeInterval[] = [];
  const issued: string[] = [];
  const renewedCalls: string[] = [];
  const preflights: string[] = [];
  composeCustomDomainEnrollment({
    registry: { registerInterval: (s: FakeInterval) => intervals.push(s) } as never,
    hostnameRegistry: store,
    getInitialAcmeIssuer: () => ({
      async issueInitialDomain({ domain }) {
        issued.push(domain);
        return {
          ok: true as const,
          new_fingerprint: `fp-${domain}`,
          cert_expires_at: (opts.now?.() ?? Date.now()) + 90 * DAY,
        };
      },
      async renewDomain({ domain }) {
        renewedCalls.push(domain);
        return {
          ok: true as const,
          new_fingerprint: `fp2-${domain}`,
          cert_expires_at: (opts.now?.() ?? Date.now()) + 90 * DAY,
        };
      },
    }),
    runPreflight: async (hostname) => {
      preflights.push(hostname);
      return preflightFor(hostname, opts.delegation ?? 'ok');
    },
    readProDdnsBinding: async () => ({
      subscription_active: opts.subscription_active !== false,
    }),
    serverIdentityId: () => SERVER_ID,
    ...(opts.now ? { now: opts.now } : {}),
  });
  return { store, issued, renewedCalls, preflights, tick: intervals[0]!.tick };
};

describe('D-235 P4 — the service renews and watches', () => {
  const NOW = 1_700_000_000_000;

  it('renews a custom domain inside the lead window', () => {
    const d = drive({
      now: () => NOW,
      seed: (s) => seedCustom(s, CUSTOM, { cert_fingerprint: 'old', cert_expires_at: NOW + 5 * DAY }),
    });
    return d.tick().then(() => {
      expect(d.renewedCalls).toEqual([CUSTOM]);
      const row = d.store.get(CUSTOM);
      expect(row?.cert_fingerprint).toBe(`fp2-${CUSTOM}`);
      // ⛔ The NEW expiry must land, or the row stays "due" and re-renews every
      //    tick until the daily ceiling stops it.
      expect(row?.cert_expires_at).toBe(NOW + 90 * DAY);
    });
  });

  it('does not renew a certificate that is nowhere near expiry', async () => {
    const d = drive({
      now: () => NOW,
      seed: (s) => seedCustom(s, CUSTOM, { cert_fingerprint: 'old', cert_expires_at: NOW + 80 * DAY }),
    });
    await d.tick();
    expect(d.renewedCalls).toEqual([]);
  });

  it('⛔ REFUSES to renew when the delegation stopped resolving', async () => {
    // Ordering against a dead delegation burns CA quota on a validation that
    // cannot pass — and CAs rate-limit failed validations.
    const d = drive({
      now: () => NOW,
      delegation: 'missing',
      seed: (s) => seedCustom(s, CUSTOM, { cert_fingerprint: 'old', cert_expires_at: NOW + 5 * DAY }),
    });
    await d.tick();
    expect(d.renewedCalls).toEqual([]);
    expect(d.store.get(CUSTOM)?.delegation_state).toBe('broken');
  });

  it('refuses to renew without an active subscription', async () => {
    const d = drive({
      now: () => NOW,
      subscription_active: false,
      seed: (s) => seedCustom(s, CUSTOM, { cert_fingerprint: 'old', cert_expires_at: NOW + 5 * DAY }),
    });
    await d.tick();
    expect(d.renewedCalls).toEqual([]);
  });

  it('⚠ renewal outranks enrolment within a tick', async () => {
    // A certificate about to expire is a live surface going down; a pending
    // enrolment is a feature not yet started.
    const d = drive({
      now: () => NOW,
      seed: (s) => {
        seedCustom(s, 'expiring.x.com', { cert_fingerprint: 'old', cert_expires_at: NOW + 2 * DAY });
        seedCustom(s, 'brand-new.x.com');
      },
    });
    await d.tick();
    expect(d.renewedCalls).toEqual(['expiring.x.com']);
    expect(d.issued).toEqual([]);
  });

  it('⛔ WATCHES A HEALTHY, PROVISIONED DOMAIN — the whole point of § 5.1', async () => {
    // Nothing is due. Nothing is failing. The certificate is valid for another
    // 80 days and the row says "ready". If the watch only ran at renewal, the
    // deleted CNAME below would be discovered in ~50 days, as an outage.
    const d = drive({
      now: () => NOW,
      delegation: 'missing',
      seed: (s) => seedCustom(s, CUSTOM, { cert_fingerprint: 'f', cert_expires_at: NOW + 80 * DAY }),
    });
    await d.tick();
    expect(d.renewedCalls).toEqual([]);
    expect(d.issued).toEqual([]);
    const row = d.store.get(CUSTOM);
    expect(row?.delegation_state).toBe('broken');
    expect(row?.delegation_checked_at).toBe(NOW);
    // …and the projection turns that into something the panel can render.
    expect(projectHostname(row!, NOW).delegation_urgency).toBe('notice');
  });

  it('records `unknown` for a failed lookup, never `broken`', async () => {
    const d = drive({
      now: () => NOW,
      delegation: 'unresolved',
      seed: (s) => seedCustom(s, CUSTOM, { cert_fingerprint: 'f', cert_expires_at: NOW + 80 * DAY }),
    });
    await d.tick();
    expect(d.store.get(CUSTOM)?.delegation_state).toBe('unknown');
  });

  it('⚠ stamps checked_at even when the state did not change', async () => {
    // Without the write, a permanently-unchecked row and a permanently-healthy
    // one are the same row.
    const d = drive({
      now: () => NOW,
      seed: (s) => seedCustom(s, CUSTOM, { cert_fingerprint: 'f', cert_expires_at: NOW + 80 * DAY }),
    });
    await d.tick();
    expect(d.store.get(CUSTOM)?.delegation_state).toBe('ok');
    expect(d.store.get(CUSTOM)?.delegation_checked_at).toBe(NOW);
  });

  it('does not re-resolve a domain it checked minutes ago', async () => {
    let clock = NOW;
    const d = drive({
      now: () => clock,
      seed: (s) => seedCustom(s, CUSTOM, { cert_fingerprint: 'f', cert_expires_at: NOW + 80 * DAY }),
    });
    await d.tick();
    expect(d.preflights).toEqual([CUSTOM]);
    clock = NOW + 60_000;
    await d.tick();
    expect(d.preflights).toEqual([CUSTOM]);
    clock = NOW + DELEGATION_WATCH_INTERVAL_MS + 1;
    await d.tick();
    expect(d.preflights).toEqual([CUSTOM, CUSTOM]);
  });

  it('watches even when the subscription lapsed', async () => {
    // "Your delegation is gone" is still true and still worth showing to
    // someone whose Pro subscription is in grace.
    const d = drive({
      now: () => NOW,
      delegation: 'missing',
      subscription_active: false,
      seed: (s) => seedCustom(s, CUSTOM, { cert_fingerprint: 'f', cert_expires_at: NOW + 80 * DAY }),
    });
    await d.tick();
    expect(d.store.get(CUSTOM)?.delegation_state).toBe('broken');
  });

  it('does nothing when no custom domains are enrolled', async () => {
    const d = drive({
      now: () => NOW,
      seed: (s) => {
        s.upsert({ server_identity_id: SERVER_ID, hostname: DDNS, cert_source: 'recued_acme' });
      },
    });
    await d.tick();
    expect(d.preflights).toEqual([]);
    expect(d.renewedCalls).toEqual([]);
  });
});
