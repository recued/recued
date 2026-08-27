/** Production-safe adapters for the daily hostname reconciliation runner. */

import { resolve4 as nodeResolve4, resolveSoa as nodeResolveSoa } from 'node:dns/promises';

import { enabledDdnsZones } from '@recued/contracts';

import type { DdnsIpStateStore } from '../ddns/ip-state-store.js';
import type {
  HostnameCertRenewalAdapter,
  HostnameDnsReconciliationAdapter,
  HostnameProviderCapabilityAdapter,
  HostnameReconciliationAlertSink,
} from './reconciliation-jobs.js';

export interface HostnameDnsResolver {
  resolve4(hostname: string): Promise<ReadonlyArray<string>>;
}

/** Narrow seam for the capability probe. Separate from `HostnameDnsResolver`
 *  because the probe asks a different QUESTION — not "what address does this
 *  name have" but "does this zone answer authoritatively". */
export interface HostnameZoneResolver {
  resolveSoa(zone: string): Promise<{ serial: number }>;
}

export interface HostnameDdnsIpStateDnsAdapterOptions {
  ipStateStore: Pick<DdnsIpStateStore, 'load'>;
  resolver?: HostnameDnsResolver;
  ttl?: number;
}

const DEFAULT_DDNS_RECORD_TTL_SECONDS = 300;

const isDnsNotFound = (err: unknown): boolean => {
  const code = typeof err === 'object' && err !== null
    ? (err as { code?: unknown }).code
    : undefined;
  return code === 'ENODATA' || code === 'ENOTFOUND' || code === 'ENODOMAIN';
};

const unique = (values: ReadonlyArray<string>): string[] =>
  [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))];

/** Read-only DNS reconciliation adapter.
 *
 *  Expected state comes from the DDNS update poller's last acknowledged
 *  publication. Actual state comes from public DNS. Writes are intentionally
 *  unsupported; production keeps `allowDnsCorrection` false until a provider
 *  write adapter can prove authoritative ownership for the target zone.
 */
export const createDdnsIpStateDnsReconciliationAdapter = (
  options: HostnameDdnsIpStateDnsAdapterOptions,
): HostnameDnsReconciliationAdapter => {
  const resolver = options.resolver ?? { resolve4: nodeResolve4 };
  const ttl = options.ttl ?? DEFAULT_DDNS_RECORD_TTL_SECONDS;

  return {
    expectedRecord() {
      const snapshot = options.ipStateStore.load();
      if (!snapshot) return null;
      return { kind: 'A', value: snapshot.ip_v4, ttl };
    },

    async getRecord(hostname) {
      let records: ReadonlyArray<string>;
      try {
        records = await resolver.resolve4(hostname);
      } catch (err) {
        if (isDnsNotFound(err)) return null;
        throw err;
      }
      const answers = unique(records);
      if (answers.length !== 1) return null;
      return { kind: 'A', value: answers[0]! };
    },

    async setRecord() {
      throw new Error('hostname DNS correction adapter is read-only');
    },
  };
};

export const createDisabledHostnameCertRenewalAdapter = (
  reason = 'hostname cert renewal adapter is not configured',
): HostnameCertRenewalAdapter => ({
  renew() {
    return { ok: false, error: reason };
  },
});

export interface DnsProviderCapabilityAdapterOptions {
  resolver?: HostnameZoneResolver;
  /** Override the zones probed. Defaults to the ENABLED fleet zones. */
  zones?: ReadonlyArray<string>;
}

/** Does the fleet DDNS zone answer authoritatively?
 *
 *  ⛔ ASK FOR SOA, NOT AN APEX A RECORD. This probed `resolve4('recued.cloud')`
 *  until 2026-08-26 and therefore could never pass: a DDNS zone apex has no A
 *  record by design — handles live at `<handle>.<zone>` — so every server
 *  reported `provider_capability_failed` daily against a healthy zone. The name
 *  was also the retired one; `.recued.net` has been the enabled zone for months.
 *
 *  ⛔ AND NOT `ns1.<zone>` EITHER, though it is tempting and it resolves. That
 *  A record is served by the delegation and cached, so it answers even when the
 *  authoritative servers are down — swapping an alert that can never pass for
 *  one that can never fail. SOA has to come from authoritative data, and its
 *  serial advances as records change.
 *
 *  🔑 THE ZONE COMES FROM `enabledDdnsZones()`, never a literal here. A second
 *  copy of the zone name is exactly what stranded `deriveProAcmeHandle` on the
 *  retired suffix while the source of truth had moved. */
export const createDnsProviderCapabilityAdapter = (
  options: DnsProviderCapabilityAdapterOptions = {},
): HostnameProviderCapabilityAdapter => {
  const resolver = options.resolver ?? { resolveSoa: nodeResolveSoa };
  const zones = options.zones
    ?? enabledDdnsZones().map((zone) => zone.suffix.replace(/^\./, ''));

  return {
    async check() {
      if (zones.length === 0) {
        return { ok: false, error: 'dns_probe_no_enabled_zone' };
      }
      const failures: string[] = [];
      for (const zone of zones) {
        try {
          const soa = await resolver.resolveSoa(zone);
          return { ok: true, detail: `dns_probe_ok:${zone}:soa=${soa.serial}` };
        } catch (err) {
          failures.push(`${zone}:${err instanceof Error ? err.message : String(err)}`);
        }
      }
      return { ok: false, error: `dns_probe_failed:${failures.join(',')}` };
    },
  };
};

export interface ConsoleHostnameReconciliationAlertSinkOptions {
  warn?: (message: string, detail?: unknown) => void;
}

export const createConsoleHostnameReconciliationAlertSink = (
  options: ConsoleHostnameReconciliationAlertSinkOptions = {},
): HostnameReconciliationAlertSink => {
  const warn = options.warn ?? console.warn;
  return {
    emit(alert) {
      warn(`[hostname-reconciliation] ${alert.code}: ${alert.message}`, alert);
    },
  };
};
