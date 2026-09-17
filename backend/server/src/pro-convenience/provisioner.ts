/** D-175 P8 — Pro convenience provisioner (status + gate engine).
 *
 *  The server-side decision core behind `pro_convenience.status`. It
 *  composes three inputs into the secret-free per-item status the
 *  webclient's Settings → Account "Pro convenience bundle" renders:
 *
 *    1. The account binding (D-175 P5) — bound vs unbound + the secret-
 *       free `account_id` / `publisher_handle` for display.
 *    2. The Pro entitlement resolved OFF the binding credential
 *       (`ProEntitlementSource` — the typed cloud seam; today a stub that
 *       fails closed to `pending`). This is the load-bearing gate.
 *    3. A reachability proof (D-175 `:636-637`).
 *
 *  Gate (all of Pro ∧ bound ∧ reachable required for an item to even be
 *  eligible to provision):
 *
 *    unbound                       → every item `awaiting-server`
 *    bound + entitlement pending   → every item `pending`   (the gap)
 *    bound + entitlement unavail.  → every item `error`     (fail closed)
 *    bound + not_entitled (Free)   → every item `inactive-free`
 *    bound + entitled + !reachable → every item `awaiting-reachability`
 *    bound + entitled + reachable  → per-item provisioned state
 *                                    (`active` / `error` / `pending`)
 *
 *  ACTUATION is deliberately NOT in this engine. Reserving the
 *  `<handle>.recued.cloud` handle (`HandleStateMachine.reserveInitial`)
 *  and issuing the ACME cert (`acme-domain-renewer.issueInitialDomain`)
 *  already have a production driver gated on the D-148
 *  `pro_subscription_token` (the cert-stack composition + the running
 *  DDNS-update poller). Adding a SECOND actuator off the binding
 *  entitlement would double-provision once the entitlement endpoint
 *  lands; the correct follow-on is to feed the binding entitlement into
 *  that EXISTING resolver (replacing `pro_subscription_token`), which
 *  needs the missing cloud primitive first. So this engine REPORTS the
 *  provisioned state (read from the live substrate via `readProvisioned`)
 *  rather than driving it — honest, non-conflicting, and it flips fully
 *  live when the entitlement source is swapped in.
 *
 *  Secret invariant. Every value this engine emits is secret-free — only
 *  states + `account_id` / `publisher_handle` / the public
 *  `<handle>.recued.cloud` hostname. The `server_scoped_credential` and
 *  the entitlement claim token are confined to the `ProEntitlementSource`
 *  and never reach this engine.
 */

import type {
  AccountBindingStatusResponse,
  ProConvenienceDetailCode,
  ProConvenienceItem,
  ProConvenienceItemState,
  ProConvenienceStatusResponse,
} from '@recued/contracts';
import { canonicalizeHandle, defaultDdnsZone, hostnameForHandle, zoneByLabel } from '@recued/contracts';

import type { ProEntitlementSource } from './entitlement-source.js';

/** Reachability proof read — `{ reachable }`. A `null` return (or an
 *  absent reader) means "no proof available" → the gate treats the
 *  server as not-yet-reachable (`awaiting-reachability`). */
export interface ProConvenienceReachability {
  reachable: boolean;
}

/** Live snapshot of the actually-provisioned conveniences, read from the
 *  handle state machine + cert store + DDNS IP-state store. Only consulted
 *  once the gate (entitled ∧ bound ∧ reachable) passes. Every field is
 *  secret-free. */
export interface ProvisionedConvenienceSnapshot {
  /** The `<handle>.recued.cloud` actually reserved, when known. Overrides
   *  the binding-derived hostname for display. */
  ddns_hostname?: string;
  /** The handle is reserved + its DDNS subscription is active/grace. */
  handle_reserved: boolean;
  /** Unix-ms of the last successful DDNS publish, when known. Presence +
   *  a reserved handle ⇒ the DDNS record is being kept fresh. */
  ddns_published_at?: number;
  /** Unix-ms expiry of the ACME cert for the handle domain, when a cert
   *  exists. */
  acme_cert_expires_at?: number;
}

/** Assemble the snapshot from values already read. Pure on purpose: the
 *  composition site does the three I/O reads, this decides what they MEAN, and
 *  only this half needs testing.
 *
 *  ⛔⛔ THE DEP THIS FEEDS WAS SUPPLIED ONLY IN TESTS. `readProvisioned` was never
 *  passed in production, so every item reported `pending / not_provisioned`
 *  forever and the Pro card showed "Not set up yet" whatever the substrate held.
 *  A seam that exists only in the harness reports the harness.
 *
 *  ⚠ NO HANDLE MEANS NOTHING IS PROVISIONED, and that is a real answer rather
 *  than a missing one: DDNS and the cert are both named after the handle, so
 *  without one there is nothing for them to point at. */
export const buildProvisionedSnapshot = (input: {
  /** Canonical handle held locally; empty when none. */
  handle: string;
  /** The `<handle>.<suffix>` the conveniences target. */
  hostname: string;
  /** Cloud-CONFIRMED publish stamp — the only one that means the record landed. */
  lastPublishedAt?: number;
  certExpiresAt?: number;
}): ProvisionedConvenienceSnapshot => {
  if (input.handle.length === 0) return { handle_reserved: false };
  return {
    handle_reserved: true,
    ddns_hostname: input.hostname,
    ...(input.lastPublishedAt !== undefined ? { ddns_published_at: input.lastPublishedAt } : {}),
    ...(input.certExpiresAt !== undefined ? { acme_cert_expires_at: input.certExpiresAt } : {}),
  };
};

export interface ProConvenienceProvisionerDeps {
  /** Secret-free binding status (typically the account-binding manager's
   *  `status()`). May throw `not_ready` before identity boot — the engine
   *  treats a throw as "unbound" (no owner knowable yet). */
  readBinding: () => AccountBindingStatusResponse;
  /** The Pro entitlement seam (the typed cloud boundary). */
  entitlement: ProEntitlementSource;
  /** D-176 — the local handle-state's name + bound DDNS zone label, read fresh
   *  each `status()` (so a handle change / re-anchor reflects without a restart).
   *  Returns the handle the zone belongs to ALONGSIDE the zone so `status()` can
   *  confirm it matches the binding handle before applying the zone — a stale /
   *  rebound local row must NOT pair the binding handle with a zone that was
   *  never reserved for it. Optional / null / unmatched ⇒ the default zone
   *  (`.recued.net`). */
  readHandleState?: () => Promise<{ current_handle: string; ddns_zone?: string } | null>;
  /** Reachability proof read. Optional — absent ⇒ not-yet-reachable. */
  readReachability?: () => Promise<ProConvenienceReachability | null>;
  /** Live provisioned-state read. Optional — absent ⇒ not-yet-provisioned
   *  (every eligible item `pending` / `not_provisioned`). */
  readProvisioned?: () => Promise<ProvisionedConvenienceSnapshot | null>;
  /** Clock seam (tests). Defaults to `Date.now`. */
  now?: () => number;
}

export interface ProConvenienceProvisioner {
  /** Resolve the current secret-free Pro convenience status. */
  status(): Promise<ProConvenienceStatusResponse>;
}

const item = (
  state: ProConvenienceItemState,
  detail?: ProConvenienceDetailCode,
  expires_at?: number,
): ProConvenienceItem => ({
  state,
  ...(detail !== undefined ? { detail } : {}),
  ...(expires_at !== undefined ? { expires_at } : {}),
});

/** Build a uniform per-item triple (handle/ddns/acme share one state).
 *  Distinct objects per item so a downstream mutation can't alias. */
const uniform = (
  state: ProConvenienceItemState,
  detail?: ProConvenienceDetailCode,
): ProConvenienceStatusResponse['items'] => ({
  handle: item(state, detail),
  ddns: item(state, detail),
  acme: item(state, detail),
});

/** D-176 — the user's Pro DDNS hostname `<handle>.<zone.suffix>`, data-driven
 *  from the DDNS zone the handle is bound to (`HandleState.ddns_zone` label,
 *  resolved via `zoneByLabel`). Replaces the retired hardcoded `.recued.cloud`
 *  suffix; an absent/unknown zone falls back to `defaultDdnsZone()` (`.recued.net`),
 *  which is correct for every handle while one zone is enabled. */
const ddnsHostnameFromHandle = (
  handle: string | undefined,
  zoneLabel: string | undefined,
): string | undefined => {
  if (!handle || handle.length === 0) return undefined;
  const zone = (zoneLabel ? zoneByLabel(zoneLabel) : undefined) ?? defaultDdnsZone();
  return hostnameForHandle(handle, zone);
};

export const createProConvenienceProvisioner = (
  deps: ProConvenienceProvisionerDeps,
): ProConvenienceProvisioner => {
  const now = deps.now ?? Date.now;

  return {
    async status(): Promise<ProConvenienceStatusResponse> {
      // 1. Binding. A throw (pre-boot `not_ready`) ⇒ no owner knowable ⇒
      //    awaiting-server (the binding is every convenience's prereq).
      let binding: AccountBindingStatusResponse;
      try {
        binding = deps.readBinding();
      } catch {
        return { entitlement: 'unbound', items: uniform('awaiting-server', 'no_binding') };
      }

      if (binding.status !== 'bound' || !binding.binding) {
        return { entitlement: 'unbound', items: uniform('awaiting-server', 'no_binding') };
      }

      const account_id = binding.binding.account_id;
      const publisher_handle = binding.binding.publisher_handle;
      // D-176 — apply the persisted zone ONLY when the local handle state names
      // the SAME handle as the binding; otherwise a stale / rebound local row
      // could pair the binding handle with a zone never reserved for it. An
      // absent / unmatched state falls back to the default zone.
      const handleState = deps.readHandleState ? await deps.readHandleState() : null;
      const ddnsZone =
        handleState &&
        publisher_handle !== undefined &&
        canonicalizeHandle(handleState.current_handle) === canonicalizeHandle(publisher_handle)
          ? handleState.ddns_zone
          : undefined;
      const ddnsFromBinding = ddnsHostnameFromHandle(publisher_handle, ddnsZone);

      // Secret-free display base carried on every bound response.
      const base = {
        account_id,
        ...(publisher_handle !== undefined ? { publisher_handle } : {}),
        ...(ddnsFromBinding !== undefined ? { ddns_hostname: ddnsFromBinding } : {}),
      };

      // 2. Entitlement gate (the typed seam).
      const ent = await deps.entitlement.resolve();

      switch (ent.state) {
        case 'pending':
          return {
            ...base,
            entitlement: 'pending',
            items: uniform('pending', 'entitlement_endpoint_pending'),
          };
        case 'unavailable':
          // Fail closed — a transient/expired/invalid claim is NOT a
          // fabricated success. Surface as `error` so the user can see the
          // convenience is degraded (vs the structural `pending`).
          return {
            ...base,
            entitlement: 'unavailable',
            items: uniform('error', 'entitlement_unavailable'),
          };
        case 'unbound':
          // The source disagrees with the binding read (a race / cleared
          // mid-resolve). Treat conservatively as awaiting-server.
          return { entitlement: 'unbound', items: uniform('awaiting-server', 'no_binding') };
        case 'not_entitled':
          // Bound to a Free account — Pro is friction-reduction only.
          return {
            ...base,
            entitlement: 'not_entitled',
            items: uniform('inactive-free', 'free_account'),
          };
        case 'disowned':
          // ⛔ `error`, NOT `awaiting-server`. The binding still exists locally —
          // the card would otherwise say "Connect your account first" to someone
          // who has, and whose server was then disowned. Something is wrong and
          // the owner has to act.
          return {
            ...base,
            entitlement: 'unavailable',
            items: uniform('error', 'server_disconnected'),
          };
        case 'entitled':
          break;
      }

      // 3. Anchor gate. The account's handle is held by ANOTHER of the owner's
      //    servers ⇒ all three conveniences are decided, because all three are
      //    named after that handle: the cloud refuses a DDNS publish from the
      //    wrong fingerprint, and the cert is issued for the name that publish
      //    would have created.
      //
      //    ⛔⛔ THIS RUNS BEFORE REACHABILITY, WHICH IS THE ONLY ORDERING THAT
      //    HELPS. The case that made this necessary is several servers on one
      //    LAN, and on one LAN exactly one of them can own the forwarded port —
      //    so the servers that are not the anchor are precisely the ones with no
      //    reachability proof. Gate reachability first and every one of them
      //    reports "Waiting until your server can be reached" forever, which
      //    names a symptom of the arrangement as if it were a fault in the setup.
      //
      //    The hint is unsigned, so this may only pick copy — see
      //    `ProHandleAnchor`. Note what it does NOT do: it never suppresses an
      //    actuation attempt. The cloud's `ddns_handle_mismatch` refusal stays
      //    the authority, and stays the thing the poller backs off on.
      if (ent.handle_anchor?.state === 'held_by_other') {
        return {
          ...base,
          entitlement: 'entitled',
          items: uniform('inactive-elsewhere', 'handle_on_another_server'),
        };
      }

      // 4. Reachability gate (`:636-637`).
      let reachable = false;
      if (deps.readReachability) {
        const r = await deps.readReachability();
        reachable = r?.reachable === true;
      }
      if (!reachable) {
        return {
          ...base,
          entitlement: 'entitled',
          items: uniform('awaiting-reachability', 'not_reachable'),
        };
      }

      // 5. Entitled ∧ bound ∧ reachable ∧ ours — report the live provisioned
      //    state per item.
      const snap = deps.readProvisioned ? await deps.readProvisioned() : null;
      const ddns_hostname = snap?.ddns_hostname ?? ddnsFromBinding;
      const handleReserved = snap?.handle_reserved === true;
      const certExpiry = snap?.acme_cert_expires_at;

      const handleItem = handleReserved
        ? item('active')
        : item('pending', 'not_provisioned');

      const ddnsItem =
        handleReserved && snap?.ddns_published_at !== undefined
          ? item('active')
          : item('pending', 'not_provisioned');

      let acmeItem: ProConvenienceItem;
      if (certExpiry === undefined) {
        acmeItem = item('pending', 'not_provisioned');
      } else if (certExpiry <= now()) {
        acmeItem = item('error', 'cert_expired', certExpiry);
      } else {
        acmeItem = item('active', undefined, certExpiry);
      }

      return {
        account_id,
        ...(publisher_handle !== undefined ? { publisher_handle } : {}),
        ...(ddns_hostname !== undefined ? { ddns_hostname } : {}),
        entitlement: 'entitled',
        items: { handle: handleItem, ddns: ddnsItem, acme: acmeItem },
      };
    },
  };
};
