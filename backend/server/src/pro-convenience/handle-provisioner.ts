/** D-175 — Pro-convenience handle provisioner (the server-half actuator).
 *
 *  The one production path that makes the server SEND
 *  `publisher_id = serverIdentity().public_key_fingerprint` to the cloud.
 *
 *  Why this exists. The DDNS update poller (`wire-ddns-update-poller.ts`)
 *  and the ACME renewer (`recued-acme-client-factory.ts` via
 *  `resolvePublisherId`) both source the `publisher_id` they send from
 *  the handle state machine's persisted `HandleState.publisher_id`. That
 *  field is only ever written by `HandleStateMachine.reserveInitial`, and
 *  until this slice NOTHING in production called it — so the handle was
 *  never reserved, `publisher_id` defaulted to `''`, and no request ever
 *  hit the bound server's `auth:<server_fingerprint>` authority row at the
 *  cloud gate (it would 404 the lookup). This actuator closes that gap by
 *  reserving the handle once, with the publisher_id derived from the LIVE
 *  server-identity fingerprint — never a caller-supplied value. After the
 *  reservation lands, the existing DDNS poller + ACME renewer take over
 *  and every request they make carries the fingerprint.
 *
 *  The identity contract (owner-ratified): `publisher_id == server_fingerprint`
 *  = `serverIdentity().public_key_fingerprint` = `sha256:<hex>` of the
 *  server-identity SPKI-DER. The cloud auth row is keyed by the
 *  fingerprint (created at bind time, pinning the server pubkey); the
 *  server signs reserve / DDNS / ACME requests with that same key, so the
 *  cloud verifies the signature against the pinned pubkey and then gates
 *  on `subscription_active`. Deriving the publisher_id here from the live
 *  identity (not from `binding.publisher_handle`'s sibling field, not from
 *  any arg) makes the contract structural — the actuator CANNOT send a
 *  wrong publisher_id.
 *
 *  The Pro gate. Reservation is gated on the binding-entitlement resolver
 *  (`ProEntitlementSource`) — the same seam that drives the ACME `proAuth`.
 *  A bound owner resolves `entitled` (ownership-only mint; see
 *  `entitlement-source.ts`); anything else (pending / unavailable /
 *  not_entitled) FAILS CLOSED — we do not attempt the reservation. The
 *  cloud's `subscription_active` flag remains the authoritative paid gate:
 *  an `entitled` but unsubscribed (Free) account still 402s at the cloud
 *  reserve handler, which surfaces as `reserve_failed` and retries on the
 *  next tick once the subscription activates. "Trust the flag" — the
 *  server just has to present the right publisher_id.
 *
 *  Idempotent. Once a handle is reserved (`HandleState.publisher_id`
 *  non-empty) this is a cheap no-op (`already_reserved`), so it is safe to
 *  drive from a periodic background tick that retries until the
 *  bind → subscribe → reserve chain completes without a restart.
 */

import { canonicalizeHandle } from '@recued/contracts';

import type {
  HandleStateMachine,
} from '../handle/index.js';
import type { StoredAccountBinding } from '../keys/index.js';
import type { ProEntitlementSource } from './entitlement-source.js';

/** Provenance client id stamped on the auto-provisioned reservation's
 *  audit row. Identifies the server-origin actuator (vs a user-driven
 *  handle rpc) for the forensic ledger. */
export const PRO_CONVENIENCE_PROVISIONER_CLIENT_ID =
  'server:pro-convenience-provisioner';

export type ProvisionSkipReason =
  | 'unbound'
  | 'no_publisher_handle'
  | 'fingerprint_mismatch'
  | 'no_active_handle'
  | 'entitlement_not_entitled'
  | 'entitlement_pending'
  | 'entitlement_unavailable'
  | 'entitlement_unbound'
  /** The cloud says this account no longer owns this server. Terminal — the
   *  provisioning loop reports it to the disconnect announcer rather than
   *  treating it as one more transient skip. */
  | 'entitlement_disowned';

export type ProvisionHandleOutcome =
  | { outcome: 'reserved'; handle: string; publisher_id: string }
  /** ⚠ `entitlement_confirmed` EXISTS BECAUSE THIS OUTCOME IS AMBIGUOUS ON ITS
   *  OWN. It is the steady-state fast path: it proves local state matches the
   *  binding and says NOTHING about the cloud, because it returns before the
   *  entitlement gate. Two callers needed "did the cloud confirm us this tick" —
   *  the disconnect re-arm and the DDNS stand-down — and both were reading this
   *  outcome as a yes. */
  | {
      outcome: 'already_reserved';
      handle: string;
      publisher_id: string;
      entitlement_confirmed: boolean;
    }
  /** A stale persisted handle state was self-healed. `via: 'change'` —
   *  a rebind (identity stable, handle drifted) corrected through the
   *  cloud change RPC; `via: 're_reserve'` — a `server_identity_key`
   *  rotation re-anchored under the live fingerprint via a fresh cloud
   *  reserve. `publisher_id` is the live fingerprint in both cases. */
  | { outcome: 'corrected'; via: 'change' | 're_reserve'; handle: string; publisher_id: string }
  | { outcome: 'skipped'; reason: ProvisionSkipReason }
  | { outcome: 'reserve_failed'; reason: string; message?: string };

export interface ProvisionHandleDeps {
  /** The LIVE server-identity public-key fingerprint (`sha256:<hex>`) —
   *  the publisher_id the server MUST present. Read per-call so an
   *  identity rotation is observed without re-wiring. */
  serverFingerprint: () => string;
  /** Reads the stored account binding (we use `account_id`,
   *  `publisher_handle`, `server_fingerprint` — never the credential). A
   *  throw (pre-boot) is treated as unbound. */
  loadBinding: () => StoredAccountBinding | null;
  /** The binding-entitlement resolver — the Pro gate. */
  entitlement: ProEntitlementSource;
  /** The cert-stack handle state machine. Reserving through THIS instance
   *  (not a fresh one) fires its `onStateChanged` listener, which updates
   *  the cert-stack `publisherIdSnapshot` so the ACME renewer's
   *  `resolvePublisherId` returns the fingerprint on its next cycle
   *  without a restart. */
  handle: Pick<
    HandleStateMachine,
    'current' | 'reserveInitial' | 'changeHandle' | 'reReserve'
  >;
  /** Audit provenance id for the reservation. Defaults to
   *  `PRO_CONVENIENCE_PROVISIONER_CLIENT_ID`. */
  changedByClientId?: string;
}

const ENTITLEMENT_SKIP_REASON: Record<
  Exclude<Awaited<ReturnType<ProEntitlementSource['resolve']>>['state'], 'entitled'>,
  ProvisionSkipReason
> = {
  not_entitled: 'entitlement_not_entitled',
  pending: 'entitlement_pending',
  unavailable: 'entitlement_unavailable',
  disowned: 'entitlement_disowned',
  unbound: 'entitlement_unbound',
};

/** Reserve the binding's handle with `publisher_id = serverFingerprint()`
 *  when bound, entitled, and not already reserved. Pure + idempotent. */
export const provisionHandleFromBinding = async (
  deps: ProvisionHandleDeps,
): Promise<ProvisionHandleOutcome> => {
  // 1. Binding. A throw (pre-boot `not_ready`) or a null record ⇒ nothing
  //    to provision against — no owner knowable yet.
  let binding: StoredAccountBinding | null;
  try {
    binding = deps.loadBinding();
  } catch {
    return { outcome: 'skipped', reason: 'unbound' };
  }
  if (!binding) return { outcome: 'skipped', reason: 'unbound' };

  // 2. Publisher handle. The handle NAME is the account's, never the server's
  //    to invent — so it comes from the cloud, and the question is only which
  //    cloud answer is FRESH.
  //
  //    ⛔⛔ THE BINDING'S COPY IS A SNAPSHOT TAKEN AT THE EXCHANGE AND NEVER
  //    REFRESHED. It has one production writer, and neither a credential
  //    rotation nor a dashboard rename touches it — so reading only it meant a
  //    renamed account compared the old name against the old name at step 4,
  //    reported `already_reserved`, and never moved the DNS record. Meanwhile
  //    the rename dialog told the owner it had.
  //
  //    🔑 THE ENTITLEMENT CLAIM IS THE FRESH ANSWER, and it is one the server may
  //    act on: `publisher_handle` rides INSIDE the signed payload, verified by
  //    `verifyClaimEnvelope` against the cloud's Ed25519 key before it reaches
  //    here. Taking a rename off unsigned response JSON would let anything able
  //    to shape a mint response re-point somebody's hostname.
  //
  //    ⚠ THE MINT ALSO MOVED UP THE FUNCTION, and that is a real cost paid
  //    deliberately: a steady-state tick now spends one mint where it used to
  //    short-circuit. It buys the only moment the drift is visible — the
  //    comparison at step 4 — and `resolve()` is already called on the
  //    corrective path and on every status render, at a 5-minute cadence.
  //
  //    ⚠ ABSENT IS NOT EMPTY. No claimed handle, a cloud older than the field,
  //    or an unavailable mint all mean "no fresher answer", so the snapshot
  //    stands. Only a present, verified, non-empty name overrides it.
  const entitlement = await deps.entitlement.resolve();
  // ⛔⛔⛔ DISOWNED SHORT-CIRCUITS HERE, BEFORE EVERY OTHER GATE — and it has to,
  // because the `already_reserved` fast path below returns without consulting
  // entitlement at all. That shortcut is right for what it was built for (a
  // steady-state no-op should not pay for a gate), and it meant the steady state
  // — bound, reserved, matching, i.e. exactly the shape that gets unbound — read
  // a disconnection and threw it away. The provisioning loop then saw
  // `already_reserved`, took it for a healthy tick, and RE-ARMED the disconnect
  // announcement on a server the cloud had just disowned.
  //
  // ⚠ AHEAD OF THE HANDLE CHECKS TOO, for the reason the cloud reports
  // retirement before its own handle gates: a disowned server's handle state is
  // beside the point, and `no_publisher_handle` would hide the real answer from
  // a server that never got as far as reserving one.
  //
  // 🔑 Nothing below this line can succeed for a disowned server anyway — every
  // cloud call it would make is signed by a credential the cloud has stopped
  // honouring.
  if (entitlement.state === 'disowned') {
    return { outcome: 'skipped', reason: 'entitlement_disowned' };
  }
  const freshHandle =
    entitlement.state === 'entitled' ? entitlement.publisher_handle : undefined;
  const handleName = freshHandle ?? binding.publisher_handle;
  if (!handleName || handleName.length === 0) {
    return { outcome: 'skipped', reason: 'no_publisher_handle' };
  }

  // 3. The publisher_id we will SEND — the live identity fingerprint, the
  //    one and only legitimate value. Cross-check the binding's anchor
  //    fingerprint: a mismatch means the binding was minted under an
  //    identity that has since rotated, so the cloud authority row is
  //    pinned to the rotated-away key — reserving under the new
  //    fingerprint would hit a non-existent `auth:<fingerprint>` row.
  //    Skip rather than burn a doomed cloud attempt.
  const fingerprint = deps.serverFingerprint();
  if (binding.server_fingerprint !== fingerprint) {
    return { outcome: 'skipped', reason: 'fingerprint_mismatch' };
  }

  // 4. Idempotency + corrective re-anchor. A persisted handle state is a
  //    true no-op ONLY when it matches the LIVE identity AND handle.
  //    Otherwise it is STALE: a rebind (identity stable, handle drifted)
  //    or a `server_identity_key` rotation (publisher_id drifted; step 3
  //    let it through because the binding was re-minted under the live
  //    fingerprint). Returning `already_reserved` would MASK the drift and
  //    leave the DDNS/ACME pollers presenting the stale handle/
  //    publisher_id; `reserveInitial` would just hit its
  //    refuse-on-existing-state guard. So drive the deliberate, audited
  //    corrective — gated on the SAME entitlement resolver as the initial
  //    reserve (fingerprint-match is already guaranteed by step 3) — so a
  //    rebound / rotated server self-heals on the next tick.
  const current = await deps.handle.current();
  if (current && current.publisher_id.length > 0) {
    // A terminal state — the server deliberately holds NO handle: it
    // transferred its handle out, or the lifecycle reached `released` after
    // a subscription lapse. The state machine keeps `publisher_id`
    // non-empty but empties `current_handle` by design. This is NOT stale
    // drift to self-heal: re-reserving would resurrect a handle the user
    // gave up, and a same-identity change would post an empty
    // `current_handle` the cloud rejects on every tick. Leave it — re-
    // acquisition is a deliberate user action, never a background fix.
    if (current.current_handle.length === 0) {
      return { outcome: 'skipped', reason: 'no_active_handle' };
    }
    const canonicalHandle = canonicalizeHandle(handleName);
    const identityMatches = current.publisher_id === fingerprint;
    const handleMatches = current.current_handle === canonicalHandle;
    if (identityMatches && handleMatches) {
      return {
        outcome: 'already_reserved',
        handle: current.current_handle,
        publisher_id: current.publisher_id,
        entitlement_confirmed: entitlement.state === 'entitled',
      };
    }
    // STALE → corrective. Pro gate first — fail CLOSED on anything but a
    // verified ownership claim, exactly like the initial reserve.
    // ⚠ Reuses the resolution from step 2 rather than minting a second time in
    // one tick: re-resolving here would double the cloud round-trips AND could
    // read a DIFFERENT handle than the one this tick decided to target.
    const ent = entitlement;
    if (ent.state !== 'entitled') {
      return { outcome: 'skipped', reason: ENTITLEMENT_SKIP_REASON[ent.state] };
    }
    const changedByClientId =
      deps.changedByClientId ?? PRO_CONVENIENCE_PROVISIONER_CLIENT_ID;
    if (identityMatches) {
      // Rebind — identity stable, handle drifted. The live fingerprint
      // already owns the OLD handle at the cloud, so release-and-reserve
      // through the change RPC. (A fresh reserve would trip the cloud's
      // one-handle-per-publisher guard → `handle_already_reserved`.)
      const result = await deps.handle.changeHandle({
        next_handle: handleName,
        changed_by_client_id: changedByClientId,
        reason: 'pro_convenience_rebind_correction',
      });
      if (result.ok) {
        return {
          outcome: 'corrected',
          via: 'change',
          handle: canonicalHandle,
          publisher_id: fingerprint,
        };
      }
      // Idempotent recovery for a crash BETWEEN a successful cloud change and
      // the local persist: the cloud already released the old handle and
      // moved the authority to the binding handle, but local still names the
      // old one, so the retry's change 409s `handle_transfer_handle_unowned`
      // / `handle_authority_handle_mismatch`. Fall back to reReserve — its
      // reserve is an idempotent re-claim when the live identity already owns
      // the binding handle cloud-side, which catches local state up (without
      // this, the background loop would `reserve_failed` forever after a
      // partial change). If the cloud genuinely lacks it, reReserve
      // re-acquires the handle or surfaces the real error.
      if (
        result.error === 'handle_transfer_handle_unowned' ||
        result.error === 'handle_authority_handle_mismatch'
      ) {
        const recovered = await deps.handle.reReserve({
          publisher_id: fingerprint,
          handle: handleName,
          changed_by_client_id: changedByClientId,
          reason: 'pro_convenience_rebind_recovery',
        });
        if (recovered.ok) {
          return {
            outcome: 'corrected',
            via: 're_reserve',
            handle: canonicalHandle,
            publisher_id: fingerprint,
          };
        }
        return {
          outcome: 'reserve_failed',
          reason: recovered.error,
          ...(recovered.message ? { message: recovered.message } : {}),
        };
      }
      return {
        outcome: 'reserve_failed',
        reason: result.error,
        ...(result.message ? { message: result.message } : {}),
      };
    }
    // Rotation — publisher_id drifted to the rotated-away identity.
    // Re-anchor to the live fingerprint via a fresh reserve (signed by the
    // live identity, verified against the `auth:<live fingerprint>` row the
    // auth-worker created at the post-rotation rebind). `publisher_id` is
    // the live fingerprint, never caller-supplied.
    //
    // The prior reservation under the rotated-away publisher_id is NOT
    // released here — the server no longer holds that identity's key, so it
    // cannot sign a release/change for it. It orphans cloud-side until the
    // rebind/grace flow migrates or lapses it (the auth-worker reservation-
    // migration gap reported with this slice; harmless — the rotated-away
    // `auth` row is deactivated on unbind, so it can't actuate). When the
    // handle ALSO drifted (rotation + rebind to a different handle), that
    // orphan keeps the OLD name while we self-heal onto the binding handle —
    // the only outcome that gets the live identity onto the correct handle;
    // refusing would strand the SERVER on a handle it can no longer serve.
    //
    // KNOWN BLOCKED CASE (auth-worker dependency): when the handle name is
    // UNCHANGED across the rotation, the old `handle:<name>` reservation is
    // still pinned to the rotated-away publisher_id, so the cloud reserve
    // 409s `handle_taken` until that auth-worker migration ships. This loops
    // as `reserve_failed` every tick — intentionally, mirroring the existing
    // unsubscribed-account retry: the LOCAL re-anchor can ONLY happen through
    // this reReserve (the cloud can't write local state), so the attempt is
    // required for the server to self-heal the moment the reservation frees.
    // Skipping instead would strand `publisher_id`/DDNS/ACME on the dead id
    // forever. This is the reservation-migration gap to escalate to codex-2.
    const result = await deps.handle.reReserve({
      publisher_id: fingerprint,
      handle: handleName,
      changed_by_client_id: changedByClientId,
      reason: 'pro_convenience_rotation_correction',
    });
    if (!result.ok) {
      return {
        outcome: 'reserve_failed',
        reason: result.error,
        ...(result.message ? { message: result.message } : {}),
      };
    }
    return {
      outcome: 'corrected',
      via: 're_reserve',
      handle: canonicalHandle,
      publisher_id: fingerprint,
    };
  }

  // 5. Pro gate (initial reserve path — no persisted state yet). Fail
  //    CLOSED on anything but a verified ownership claim.
  // ⚠ Same resolution as step 2, for the same two reasons: one mint per tick,
  // and the gate must judge the claim this tick actually took its handle from.
  if (entitlement.state !== 'entitled') {
    return { outcome: 'skipped', reason: ENTITLEMENT_SKIP_REASON[entitlement.state] };
  }

  // 6. Reserve. `publisher_id` is ALWAYS the live fingerprint — the
  //    handle state machine then persists it, and the DDNS poller + ACME
  //    renewer read it back and present it to the cloud gate.
  const result = await deps.handle.reserveInitial({
    publisher_id: fingerprint,
    handle: handleName,
    // The unified model has one identity per server; the publisher
    // identity fingerprint IS the server fingerprint.
    publisher_identity_fingerprint: fingerprint,
    changed_by_client_id:
      deps.changedByClientId ?? PRO_CONVENIENCE_PROVISIONER_CLIENT_ID,
    reason: 'pro_convenience_auto_provision',
  });

  if (!result.ok) {
    return {
      outcome: 'reserve_failed',
      reason: result.error,
      ...(result.message ? { message: result.message } : {}),
    };
  }
  return { outcome: 'reserved', handle: handleName, publisher_id: fingerprint };
};
