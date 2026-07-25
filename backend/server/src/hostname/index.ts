export {
  applyHostnameOwnershipProof,
  type HostnameOwnershipProofFailureCode,
  type HostnameOwnershipProofInput,
  type HostnameOwnershipProofResult,
} from './ownership-proof.js';

export {
  createHostnameSniBindingLookup,
} from './sni-dispatch.js';

export {
  createConsoleHostnameReconciliationAlertSink,
  createDdnsIpStateDnsReconciliationAdapter,
  createDisabledHostnameCertRenewalAdapter,
  createDnsProviderCapabilityAdapter,
  type DnsProviderCapabilityAdapterOptions,
  type HostnameDdnsIpStateDnsAdapterOptions,
  type HostnameDnsResolver,
} from './reconciliation-adapters.js';

export {
  HOSTNAME_RECONCILIATION_DAILY_INTERVAL_MS,
  HOSTNAME_RECONCILIATION_DAILY_RUNNER_NAME,
  registerDailyHostnameReconciliationRunner,
  type HostnameReconciliationSafetyOptions,
} from './reconciliation-jobs.js';
