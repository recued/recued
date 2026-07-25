/** User subscription tier. Source-agnostic — can come from hosted backend or recued-server.
 *
 *  Pro is a binary friction-reduction bundle (D-148 § A.14: DDNS subdomain
 *  + ACME-DNS-01 cert + pair-blob relay + static OAuth callback page +
 *  marketplace handle reservation + reachability probe), not a feature-flag
 *  set. D-168 retired the per-feature `ProFeature` union (`cross_device_sync`,
 *  `background_scheduling`, `multi_instance`, `priority_support`) — every
 *  capability claim about Recued is true at both tiers; the user's server
 *  hosts the same way in both, Pro just bundles the public-internet
 *  reachability work into the subscription. */
export type Tier = 'free' | 'pro' | 'enterprise';

/** A user's current entitlement state. Loaded by an EntitlementProvider. */
export interface Entitlement {
  user_id: string | null;     // null for anonymous
  tier: Tier;
  expires_at?: string;        // ISO 8601, for paid subscriptions
}

/** Pluggable entitlement source. Real impls: hosted backend, recued-server, hardcoded for tests. */
export interface EntitlementProvider {
  current(): Promise<Entitlement>;
  refresh(): Promise<void>;
}

/** Pure helpers — no provider required. */
export const isPro = (e: Entitlement): boolean =>
  e.tier === 'pro' || e.tier === 'enterprise';

export const isAnonymous = (e: Entitlement): boolean =>
  e.user_id === null;

export const isExpired = (e: Entitlement): boolean =>
  e.expires_at != null && new Date(e.expires_at).getTime() < Date.now();
