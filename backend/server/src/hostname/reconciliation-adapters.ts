/** Production-safe adapters for the daily hostname reconciliation runner. */

import { resolve4 as nodeResolve4 } from 'node:dns/promises';

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
  resolver?: HostnameDnsResolver;
  probeHostname?: string;
}

export const createDnsProviderCapabilityAdapter = (
  options: DnsProviderCapabilityAdapterOptions = {},
): HostnameProviderCapabilityAdapter => {
  const resolver = options.resolver ?? { resolve4: nodeResolve4 };
  const probeHostname = options.probeHostname ?? 'recued.cloud';

  return {
    async check() {
      try {
        const records = unique(await resolver.resolve4(probeHostname));
        if (records.length === 0) {
          return { ok: false, error: `dns_probe_empty:${probeHostname}` };
        }
        return { ok: true, detail: `dns_probe_ok:${probeHostname}` };
      } catch (err) {
        return {
          ok: false,
          error: `dns_probe_failed:${probeHostname}:${
            err instanceof Error ? err.message : String(err)
          }`,
        };
      }
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
