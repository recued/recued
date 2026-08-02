/** D-152 P5 - hostname lifecycle reconciliation jobs. */

import {
  isSingleLabelProDdnsHostname,
  type HostnameProjection,
  type HostnameStorageRow,
} from '@recued/contracts';

import type { HostnameRegistryStore } from '../storage/hostname-registry.js';
import type {
  BeginSoftHoldInput,
  MarkActiveInput,
  ProSubscriptionStateRow,
  ProSubscriptionStateStore,
} from './pro-subscription-state.js';

export const HOSTNAME_CERT_RENEWAL_MONITORING_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
export const HOSTNAME_RECONCILIATION_DAILY_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const HOSTNAME_RECONCILIATION_DAILY_RUNNER_NAME = 'hostname-reconciliation-daily';

export type HostnameReconciliationJob =
  | 'cancellation_lifecycle'
  | 'expired_handles'
  | 'stuck_soft_holds'
  | 'dns_records_mismatch'
  | 'cert_renewal_monitoring'
  | 'provider_capability_check';

export type HostnameReconciliationActionKind =
  | 'soft_hold_started'
  | 'handle_restored'
  | 'expired_handle_released'
  | 'expired_handle_release_blocked'
  | 'stuck_soft_hold_released'
  | 'dns_record_corrected'
  | 'dns_record_correction_blocked'
  | 'dns_record_ambiguous'
  | 'cert_renewal_requested'
  | 'cert_renewal_failed'
  | 'provider_capability_ok'
  | 'provider_capability_failed';

export interface HostnameDnsRecord {
  kind: 'A' | 'AAAA' | 'CNAME';
  value: string;
  ttl?: number;
}

export interface HostnameReconciliationAction {
  job: HostnameReconciliationJob;
  kind: HostnameReconciliationActionKind;
  hostname?: string;
  detail?: string;
  occurred_at: number;
}

export interface HostnameReconciliationAlert {
  job: HostnameReconciliationJob;
  hostname?: string;
  code: string;
  message: string;
  occurred_at: number;
}

export interface HostnameReconciliationAuditSink {
  emit(event: HostnameReconciliationAction): void | Promise<void>;
}

export interface HostnameReconciliationAlertSink {
  emit(alert: HostnameReconciliationAlert): void | Promise<void>;
}

export interface HostnameDnsReconciliationAdapter {
  expectedRecord(hostname: HostnameProjection): HostnameDnsRecord | null | Promise<HostnameDnsRecord | null>;
  getRecord(hostname: string): HostnameDnsRecord | null | Promise<HostnameDnsRecord | null>;
  setRecord(hostname: string, record: HostnameDnsRecord): void | Promise<void>;
}

export interface HostnameCertRenewalAdapter {
  renew(hostname: HostnameProjection): { ok: true } | { ok: false; error: string } | Promise<
    { ok: true } | { ok: false; error: string }
  >;
}

export interface HostnameProviderCapabilityAdapter {
  check(): { ok: true; detail?: string } | { ok: false; error: string } | Promise<
    { ok: true; detail?: string } | { ok: false; error: string }
  >;
}

export interface HostnameLifecycleDeps {
  hostnameRegistry: Pick<HostnameRegistryStore, 'get' | 'setEnabled'>;
  subscriptionState: Pick<ProSubscriptionStateStore, 'beginSoftHold' | 'markActive'>;
  audit?: HostnameReconciliationAuditSink;
  now?: () => number;
}

export interface HostnameReconciliationDeps {
  hostnameRegistry: Pick<HostnameRegistryStore, 'get' | 'list' | 'remove'>;
  subscriptionState: Pick<
    ProSubscriptionStateStore,
    'listExpiredSoftHolds' | 'markReleased'
  >;
  dns: HostnameDnsReconciliationAdapter;
  certs: HostnameCertRenewalAdapter;
  provider: HostnameProviderCapabilityAdapter;
  audit?: HostnameReconciliationAuditSink;
  alerts?: HostnameReconciliationAlertSink;
  safety?: HostnameReconciliationSafetyOptions;
  now?: () => number;
}

export interface HostnameReconciliationSafetyOptions {
  /** Default false. Removing an expired DDNS registry row releases a handle. */
  allowHandleRemoval?: boolean;
  /** Default false. DNS writes stay off until the provider write adapter is authoritative. */
  allowDnsCorrection?: boolean;
}

export interface HostnameReconciliationRunResult {
  actions: HostnameReconciliationAction[];
  alerts: HostnameReconciliationAlert[];
}

export interface HostnameDailyReconciliationIntervalSpec {
  name: string;
  intervalMs: number;
  tick: () => Promise<void> | void;
  fireImmediate?: boolean;
}

export interface HostnameDailyReconciliationBackgroundServices {
  registerInterval(
    spec: HostnameDailyReconciliationIntervalSpec,
  ): () => Promise<void> | void;
}

export interface HostnameDailyReconciliationRunnerOptions {
  backgroundServices: HostnameDailyReconciliationBackgroundServices;
  deps: HostnameReconciliationDeps;
  fireImmediate?: boolean;
  onError?: (error: unknown) => void;
}

const isManagedRecuedAcmeStorageRow = (
  row: HostnameStorageRow | null,
): row is HostnameStorageRow =>
  !!row
  && row.ddns_managed
  && row.cert_source === 'recued_acme'
  && isSingleLabelProDdnsHostname(row.hostname_normalized);

const isManagedRecuedAcmeProjection = (row: HostnameProjection): boolean =>
  row.ddns_managed
  && row.cert_source === 'recued_acme'
  && isSingleLabelProDdnsHostname(row.hostname);

const normalizeDnsRecordValue = (record: HostnameDnsRecord): string =>
  record.kind === 'CNAME'
    ? record.value.toLowerCase().replace(/\.$/, '')
    : record.value;

export const hostnameDnsRecordsEqual = (
  left: HostnameDnsRecord | null,
  right: HostnameDnsRecord | null,
): boolean =>
  left !== null
  && right !== null
  && left.kind === right.kind
  && normalizeDnsRecordValue(left) === normalizeDnsRecordValue(right);

const emitAction = async (
  result: HostnameReconciliationRunResult,
  audit: HostnameReconciliationAuditSink | undefined,
  action: HostnameReconciliationAction,
): Promise<void> => {
  result.actions.push(action);
  await audit?.emit(action);
};

const emitAlert = async (
  result: HostnameReconciliationRunResult,
  alerts: HostnameReconciliationAlertSink | undefined,
  alert: HostnameReconciliationAlert,
): Promise<void> => {
  result.alerts.push(alert);
  await alerts?.emit(alert);
};

const emptyRunResult = (): HostnameReconciliationRunResult => ({
  actions: [],
  alerts: [],
});

export const beginDdnsSoftHold = async (
  deps: HostnameLifecycleDeps,
  input: BeginSoftHoldInput,
): Promise<ProSubscriptionStateRow> => {
  const at = deps.now?.() ?? Date.now();
  const state = deps.subscriptionState.beginSoftHold({
    ...input,
    canceled_at: input.canceled_at ?? at,
  });
  const row = deps.hostnameRegistry.get(state.hostname_normalized);
  if (isManagedRecuedAcmeStorageRow(row)) {
    deps.hostnameRegistry.setEnabled(state.hostname_normalized, false);
  }
  await deps.audit?.emit({
    job: 'cancellation_lifecycle',
    kind: 'soft_hold_started',
    hostname: state.hostname_normalized,
    detail: `soft_hold_until=${state.soft_hold_until ?? ''}`,
    occurred_at: at,
  });
  return state;
};

export const markDdnsActive = async (
  deps: HostnameLifecycleDeps,
  input: MarkActiveInput,
): Promise<ProSubscriptionStateRow> => {
  const at = deps.now?.() ?? Date.now();
  const state = deps.subscriptionState.markActive({
    ...input,
    activated_at: input.activated_at ?? at,
  });
  const row = deps.hostnameRegistry.get(state.hostname_normalized);
  if (isManagedRecuedAcmeStorageRow(row)) {
    deps.hostnameRegistry.setEnabled(state.hostname_normalized, true);
    await deps.audit?.emit({
      job: 'cancellation_lifecycle',
      kind: 'handle_restored',
      hostname: state.hostname_normalized,
      occurred_at: at,
    });
  }
  return state;
};

export const runExpiredHandlesJob = async (
  deps: Pick<HostnameReconciliationDeps, 'hostnameRegistry' | 'subscriptionState' | 'audit' | 'alerts' | 'safety' | 'now'>,
): Promise<HostnameReconciliationRunResult> => {
  const result = emptyRunResult();
  const at = deps.now?.() ?? Date.now();
  for (const state of deps.subscriptionState.listExpiredSoftHolds(at)) {
    const row = deps.hostnameRegistry.get(state.hostname_normalized);
    if (!isManagedRecuedAcmeStorageRow(row)) continue;

    if (deps.safety?.allowHandleRemoval !== true) {
      await emitAlert(result, deps.alerts, {
        job: 'expired_handles',
        hostname: state.hostname_normalized,
        code: 'handle_removal_disabled',
        message: `handle removal is disabled for ${state.hostname_normalized}`,
        occurred_at: at,
      });
      await emitAction(result, deps.audit, {
        job: 'expired_handles',
        kind: 'expired_handle_release_blocked',
        hostname: state.hostname_normalized,
        detail: 'handle_removal_disabled',
        occurred_at: at,
      });
      continue;
    }

    deps.hostnameRegistry.remove(state.hostname_normalized);
    deps.subscriptionState.markReleased({
      hostname: state.hostname_normalized,
      released_at: at,
    });
    await emitAction(result, deps.audit, {
      job: 'expired_handles',
      kind: 'expired_handle_released',
      hostname: state.hostname_normalized,
      occurred_at: at,
    });
  }
  return result;
};

export const runStuckSoftHoldsJob = async (
  deps: Pick<HostnameReconciliationDeps, 'hostnameRegistry' | 'subscriptionState' | 'audit' | 'now'>,
): Promise<HostnameReconciliationRunResult> => {
  const result = emptyRunResult();
  const at = deps.now?.() ?? Date.now();
  for (const state of deps.subscriptionState.listExpiredSoftHolds(at)) {
    const row = deps.hostnameRegistry.get(state.hostname_normalized);
    if (isManagedRecuedAcmeStorageRow(row)) continue;

    deps.subscriptionState.markReleased({
      hostname: state.hostname_normalized,
      released_at: at,
    });
    await emitAction(result, deps.audit, {
      job: 'stuck_soft_holds',
      kind: 'stuck_soft_hold_released',
      hostname: state.hostname_normalized,
      occurred_at: at,
    });
  }
  return result;
};

export const runDnsRecordsMismatchJob = async (
  deps: Pick<HostnameReconciliationDeps, 'hostnameRegistry' | 'dns' | 'audit' | 'alerts' | 'safety' | 'now'>,
): Promise<HostnameReconciliationRunResult> => {
  const result = emptyRunResult();
  const at = deps.now?.() ?? Date.now();
  for (const row of deps.hostnameRegistry.list()) {
    if (!isManagedRecuedAcmeProjection(row) || !row.enabled) continue;

    const expected = await deps.dns.expectedRecord(row);
    if (expected === null) {
      const alert: HostnameReconciliationAlert = {
        job: 'dns_records_mismatch',
        hostname: row.hostname,
        code: 'expected_dns_record_ambiguous',
        message: `expected DNS record is ambiguous for ${row.hostname}`,
        occurred_at: at,
      };
      await emitAlert(result, deps.alerts, alert);
      await emitAction(result, deps.audit, {
        job: 'dns_records_mismatch',
        kind: 'dns_record_ambiguous',
        hostname: row.hostname,
        detail: alert.code,
        occurred_at: at,
      });
      continue;
    }

    const actual = await deps.dns.getRecord(row.hostname);
    if (hostnameDnsRecordsEqual(actual, expected)) continue;

    const correctionDetail = `${actual?.kind ?? 'missing'} -> ${expected.kind}`;
    if (deps.safety?.allowDnsCorrection !== true) {
      await emitAlert(result, deps.alerts, {
        job: 'dns_records_mismatch',
        hostname: row.hostname,
        code: 'dns_record_correction_disabled',
        message: `DNS correction is disabled for ${row.hostname}`,
        occurred_at: at,
      });
      await emitAction(result, deps.audit, {
        job: 'dns_records_mismatch',
        kind: 'dns_record_correction_blocked',
        hostname: row.hostname,
        detail: correctionDetail,
        occurred_at: at,
      });
      continue;
    }

    await deps.dns.setRecord(row.hostname, expected);
    await emitAction(result, deps.audit, {
      job: 'dns_records_mismatch',
      kind: 'dns_record_corrected',
      hostname: row.hostname,
      detail: correctionDetail,
      occurred_at: at,
    });
  }
  return result;
};

export const runCertRenewalMonitoringJob = async (
  deps: Pick<HostnameReconciliationDeps, 'hostnameRegistry' | 'certs' | 'audit' | 'alerts' | 'now'>,
): Promise<HostnameReconciliationRunResult> => {
  const result = emptyRunResult();
  const at = deps.now?.() ?? Date.now();
  for (const row of deps.hostnameRegistry.list()) {
    if (
      !isManagedRecuedAcmeProjection(row)
      || row.cert_expires_at === undefined
      || row.cert_expires_at - at >= HOSTNAME_CERT_RENEWAL_MONITORING_WINDOW_MS
    ) {
      continue;
    }

    const renewal = await deps.certs.renew(row);
    if (renewal.ok) {
      await emitAction(result, deps.audit, {
        job: 'cert_renewal_monitoring',
        kind: 'cert_renewal_requested',
        hostname: row.hostname,
        occurred_at: at,
      });
      continue;
    }

    await emitAction(result, deps.audit, {
      job: 'cert_renewal_monitoring',
      kind: 'cert_renewal_failed',
      hostname: row.hostname,
      detail: renewal.error,
      occurred_at: at,
    });
    await emitAlert(result, deps.alerts, {
      job: 'cert_renewal_monitoring',
      hostname: row.hostname,
      code: 'cert_renewal_failed',
      message: renewal.error,
      occurred_at: at,
    });
  }
  return result;
};

export const runProviderCapabilityCheckJob = async (
  deps: Pick<HostnameReconciliationDeps, 'provider' | 'audit' | 'alerts' | 'now'>,
): Promise<HostnameReconciliationRunResult> => {
  const result = emptyRunResult();
  const at = deps.now?.() ?? Date.now();
  const capability = await deps.provider.check();
  if (capability.ok) {
    await emitAction(result, deps.audit, {
      job: 'provider_capability_check',
      kind: 'provider_capability_ok',
      detail: capability.detail,
      occurred_at: at,
    });
    return result;
  }

  await emitAction(result, deps.audit, {
    job: 'provider_capability_check',
    kind: 'provider_capability_failed',
    detail: capability.error,
    occurred_at: at,
  });
  await emitAlert(result, deps.alerts, {
    job: 'provider_capability_check',
    code: 'provider_capability_failed',
    message: capability.error,
    occurred_at: at,
  });
  return result;
};

const appendRun = (
  target: HostnameReconciliationRunResult,
  source: HostnameReconciliationRunResult,
): void => {
  target.actions.push(...source.actions);
  target.alerts.push(...source.alerts);
};

export const runHostnameReconciliationJobs = async (
  deps: HostnameReconciliationDeps,
): Promise<HostnameReconciliationRunResult> => {
  const result = emptyRunResult();
  appendRun(result, await runExpiredHandlesJob(deps));
  appendRun(result, await runStuckSoftHoldsJob(deps));
  appendRun(result, await runDnsRecordsMismatchJob(deps));
  appendRun(result, await runCertRenewalMonitoringJob(deps));
  appendRun(result, await runProviderCapabilityCheckJob(deps));
  return result;
};

export const registerDailyHostnameReconciliationRunner = (
  options: HostnameDailyReconciliationRunnerOptions,
): (() => Promise<void> | void) => {
  const tick = async (): Promise<void> => {
    try {
      await runHostnameReconciliationJobs(options.deps);
    } catch (error: unknown) {
      try {
        options.onError?.(error);
      } catch {
        // Best-effort runner: interval ticks must never throw.
      }
    }
  };

  return options.backgroundServices.registerInterval({
    name: HOSTNAME_RECONCILIATION_DAILY_RUNNER_NAME,
    intervalMs: HOSTNAME_RECONCILIATION_DAILY_INTERVAL_MS,
    tick,
    fireImmediate: options.fireImmediate ?? true,
  });
};
