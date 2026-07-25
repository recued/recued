/** D-148 § A.17 — `DdnsAdapter` interface.
 *
 *  Every BYO DDNS provider plus the Recued cloud DDNS path implements
 *  this single interface. The substrate (cert-renewal task, handle-
 *  change flow, Reachability Doctor) calls into adapters via this
 *  shape and never sees the per-provider auth or URL template.
 */

/** Closed list of adapter kinds. Adding a new provider requires:
 *    1. Adding to `DDNS_ADAPTER_KINDS`.
 *    2. Implementing `createXAdapter` returning a `DdnsAdapter`.
 *    3. Documenting the setup path in internal design notes.
 *    4. Adding a round-trip test in `__tests__/<kind>.test.ts`. */
export const DDNS_ADAPTER_KINDS = [
  'recued-cloud',
  'duckdns',
  'cloudflare',
  'dynu',
  'generic-dns',
] as const;

export type DdnsAdapterKind = (typeof DDNS_ADAPTER_KINDS)[number];

/** Type predicate. */
export const isDdnsAdapterKind = (s: string): s is DdnsAdapterKind =>
  (DDNS_ADAPTER_KINDS as ReadonlyArray<string>).includes(s);

/** Adapter input — the substrate calls `update()` with the current
 *  detected public IP + handle. The adapter resolves the per-
 *  provider auth + endpoint internally. */
export interface DdnsUpdateInput {
  /** The handle/subdomain to update. For `recued-cloud` this is
   *  `<handle>.recued.cloud`; for BYO providers it's the user-
   *  configured DNS name. */
  handle: string;
  ip_v4: string;
  ip_v6?: string;
}

/** Adapter output — confirmation + observed TTL. The substrate uses
 *  TTL to predict when the new record propagates. */
export interface DdnsUpdateOutput {
  /** Wall-clock time the provider acknowledged the update. */
  updated_at: number;
  /** TTL the provider applied (seconds). Recued recommends 300s. */
  ttl: number;
  /** True when the provider reported the IP was already current.
   *  Substrate uses this to suppress redundant audit rows. */
  unchanged: boolean;
  /** Free-form provider message — surfaced to the doctor when
   *  diagnosing failures. */
  provider_message?: string;
}

/** D-148 § A.5 — common DDNS adapter interface. */
export interface DdnsAdapter {
  /** Stable identifier for the adapter kind. */
  kind: DdnsAdapterKind;
  /** Update the provider's DNS record. Resolves on success; rejects
   *  with a structured error on auth or transport failure. */
  update(input: DdnsUpdateInput): Promise<DdnsUpdateOutput>;
}
